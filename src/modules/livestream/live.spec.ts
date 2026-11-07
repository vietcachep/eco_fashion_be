import { createHash } from 'node:crypto';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import type { Env } from '@config/env';
import type { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import type { ShopFollowApplicationApi } from '@modules/shop/applicationapi/shop-follow.applicationapi';
import type { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import type { UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import type { Tx } from '@common/prisma/types';
import { LiveKitProvider } from './media/livekit.provider';
import { LiveMediaService } from './media/live-media.service';
import { LiveService } from './live.service';
import { LiveRepository, type LiveSession } from './live.repository';

function firstArg(mock: jest.Mock): unknown {
  const calls: unknown = mock.mock.calls;
  if (!Array.isArray(calls)) return undefined;
  const first: unknown = calls[0];
  return Array.isArray(first) ? first[0] : undefined;
}
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const SHOP = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const env = {
  EF_LIVEKIT_URL: 'wss://audit.livekit.invalid',
  EF_LIVEKIT_API_KEY: 'audit-key',
  EF_LIVEKIT_API_SECRET: 'audit-only-secret-not-used-for-real-service',
  EF_LIVE_MAX_VIEWERS: 10,
  EF_LIVE_DURATION_MINUTES: 60,
} as Env;
const session = (patch: Partial<LiveSession> = {}) =>
  ({
    id: SESSION,
    shopId: SHOP,
    state: 'live',
    mode: 'public',
    startedAt: new Date('2026-11-06T00:00:00Z'),
    version: 1,
    createdAt: new Date('2026-11-05T00:00:00Z'),
    ...patch,
  }) as LiveSession;

describe('LiveKit token và webhook thật (không gọi mạng)', () => {
  const provider = new LiveKitProvider(env);
  it('viewer chỉ subscribe, không được publish camera/data, bound đúng room và TTL ngắn', async () => {
    const grant = await provider.token('fitly-room', 'viewer-one', false);
    const claims = await new TokenVerifier(env.EF_LIVEKIT_API_KEY, env.EF_LIVEKIT_API_SECRET).verify(
      grant.token,
    );
    expect(claims.sub).toBe('viewer-one');
    expect(claims.video).toMatchObject({
      room: 'fitly-room',
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
    });
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(120);
  });
  it('host chỉ được camera/micro của đúng room; không cấp admin hoặc raw data channel', async () => {
    const grant = await provider.token('fitly-one', 'host-one', true);
    const claims = await new TokenVerifier(env.EF_LIVEKIT_API_KEY, env.EF_LIVEKIT_API_SECRET).verify(
      grant.token,
    );
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canPublishSources).toEqual(['camera', 'microphone']);
    expect(claims.video?.roomAdmin).not.toBe(true);
    expect(claims.video?.canPublishData).toBe(false);
  });
  it('không cấu hình thì fail rõ, không cấp token giả', async () => {
    await expect(
      new LiveKitProvider({ ...env, EF_LIVEKIT_API_SECRET: '' }).token('room', 'viewer', false),
    ).rejects.toMatchObject({ errorCode: 'LIVE_MEDIA_UNAVAILABLE' });
  });
  it('webhook kiểm hash bytes, reject payload đã bị sửa dù token vẫn đúng chữ ký', async () => {
    const body = JSON.stringify({
      id: 'event-one',
      event: 'track_published',
      room: { name: 'fitly-one' },
      participant: { identity: `host-${SESSION}` },
      track: { type: 'VIDEO' },
    });
    const auth = new AccessToken(env.EF_LIVEKIT_API_KEY, env.EF_LIVEKIT_API_SECRET, { ttl: 60 });
    auth.sha256 = createHash('sha256').update(body).digest('base64');
    const token = await auth.toJwt();
    expect((await provider.verifyWebhook(body, token)).id).toBe('event-one');
    await expect(provider.verifyWebhook(body.replace('fitly-one', 'fitly-two'), token)).rejects.toThrow();
    await expect(provider.verifyWebhook(body)).rejects.toThrow();
  });
});

describe('Live source và phòng riêng', () => {
  function fixture(patch: Partial<LiveSession> = {}) {
    const row = session(patch);
    const db = {
      liveSourceGrant: { findFirst: jest.fn() },
      liveAdmission: { findFirst: jest.fn() },
      liveRestriction: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const sessionRead = jest.fn().mockResolvedValue(row);
    const rowLock = jest.fn().mockResolvedValue(undefined);
    const repo = { db, session: sessionRead, rowLock } as unknown as LiveRepository;
    const approved = jest.fn().mockResolvedValue(true);
    const shops = {
      existsApproved: approved,
      memberUserIdsWithPermission: jest.fn().mockResolvedValue([]),
    } as unknown as ShopQueryApi;
    const service = new LiveService(
      repo,
      new LiveKitProvider(env),
      {} as ProductQueryApi,
      shops,
      {} as ShopFollowApplicationApi,
      {} as IdentityQueryApi,
      env,
      {} as UserDirectoryGateway,
    );
    return { service, db, approved, rowLock, sessionRead };
  }
  it('private rehearsal không được dùng để tạo campaign/nguồn mua public', async () => {
    const f = fixture({ mode: 'rehearsal' });
    expect(await f.service.session(SESSION)).toBeNull();
    expect(await f.service.canClaim(USER, SESSION)).toBe(false);
    await expect(f.service.canRead(session({ mode: 'rehearsal' }))).rejects.toMatchObject({
      errorCode: 'LIVE_NOT_FOUND',
    });
  });
  it('không nhận voucher sau ended hoặc khi không có admission đang hoạt động', async () => {
    const f = fixture({ state: 'ended' });
    expect(await f.service.canClaim(USER, SESSION)).toBe(false);
    const g = fixture();
    g.db.liveAdmission.findFirst.mockResolvedValue(null);
    expect(await g.service.canClaim(USER, SESSION)).toBe(false);
  });
  it('claim chờ khoá session rồi đọc trạng thái mới: stop đã thắng thì không cấp voucher', async () => {
    const f = fixture();
    const tx = f.db as unknown as Tx;
    f.rowLock.mockImplementation(() => {
      f.sessionRead.mockResolvedValue(session({ state: 'ended' }));
      return Promise.resolve();
    });
    expect(await f.service.canClaim(USER, SESSION, tx)).toBe(false);
    expect(f.rowLock).toHaveBeenCalledWith(tx, SESSION);
    expect(f.db.liveAdmission.findFirst).not.toHaveBeenCalled();
  });
  it('shop bị khoá hoặc hạn chế live không cấp claim dù admission còn', async () => {
    const f = fixture();
    f.approved.mockResolvedValue(false);
    expect(await f.service.canClaim(USER, SESSION)).toBe(false);
    const g = fixture();
    g.db.liveRestriction.findUnique.mockResolvedValue({ restricted: true });
    expect(await g.service.canClaim(USER, SESSION)).toBe(false);
  });
  it('nguồn đã cấp vẫn dùng sau live; phải có owner/product/quantity/expiry đúng và shop được bán', async () => {
    const f = fixture({ state: 'ended' });
    const eligibleUntil = new Date(Date.now() + 60_000);
    f.db.liveSourceGrant.findFirst.mockResolvedValue({
      id: 'grant',
      sessionId: SESSION,
      shopId: SHOP,
      productId: PRODUCT,
      eligibleUntil,
    });
    expect(await f.service.verifySource(USER, 'grant', PRODUCT, 2)).toMatchObject({
      sourceGrantId: 'grant',
      sessionId: SESSION,
      eligibleUntil,
    });
    const query = firstArg(f.db.liveSourceGrant.findFirst) as {
      where: {
        id: string;
        userId: string;
        productId: string;
        quantity: { gte: number };
        eligibleUntil: { gt: Date };
      };
    };
    expect(query.where).toMatchObject({
      id: 'grant',
      userId: USER,
      productId: PRODUCT,
      quantity: { gte: 2 },
    });
    expect(query.where.eligibleUntil.gt).toBeInstanceOf(Date);
    f.db.liveSourceGrant.findFirst.mockResolvedValue(null);
    await expect(f.service.verifySource(USER, 'grant', PRODUCT, 2)).rejects.toMatchObject({
      errorCode: 'LIVE_SOURCE_INVALID',
    });
  });
});

describe('Webhook terminal không hồi sinh', () => {
  it('event track_published tới sau terminate chỉ đóng inbox, không đổi lại live', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      liveMediaInbox: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt',
          roomId: 'room',
          event: 'track_published',
          processedAt: null,
          payload: { participant: { identity: `host-${SESSION}` }, track: { type: 'VIDEO' } },
        }),
        update: jest.fn(),
      },
      liveSession: {
        findUnique: jest.fn().mockResolvedValue(session({ state: 'terminated' })),
        update: jest.fn(),
      },
    };
    const repo = {
      transaction: jest.fn((fn: (value: unknown) => Promise<unknown>) => fn(tx)),
      rowLock: jest.fn(),
      event: jest.fn(),
    } as unknown as LiveRepository;
    const live = {
      required: jest.fn().mockResolvedValue(session({ state: 'terminated' })),
    } as unknown as LiveService;
    await new LiveMediaService(live, repo).process('evt');
    expect(tx.liveSession.update).not.toHaveBeenCalled();
    const update = firstArg(tx.liveMediaInbox.update) as {
      where: { id: string };
      data: { processedAt: Date };
    };
    expect(update.where.id).toBe('evt');
    expect(update.data.processedAt).toBeInstanceOf(Date);
  });
});
