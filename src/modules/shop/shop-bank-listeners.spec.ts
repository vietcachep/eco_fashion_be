import { Logger } from '@nestjs/common';
import type { Env } from '@config/env';
import type { NotificationGateway, NotifyCommand } from '@common/gateway/notification.gateway';
import type { UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import type { MailMessage, MailService } from '@common/mail/mail.service';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { IdentityQueryApi, UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopOutboxService } from './outbox/shop-outbox.service';
import type { ShopQueryApi } from './queryapi/shop.queryapi';
import type { ShopRepository } from './shop/repository/shop.repository';
import { formatVnDateTime, ShopBankListeners } from './shop-worker.module';

/*
 * PLAN-0040 Tầng 5.1/5.2 — listener TÀI KHOẢN NGÂN HÀNG ở worker của shop:
 *  - EMAIL cho CHỦ shop khi SHOP_BANK_CHANGED (4 số cuối, người đổi, thời điểm, hướng dẫn; mọi giá trị chèn HTML đã escape; idempotent theo eventId; lỗi xếp mail nổi lên để relay retry);
 *  - báo nhân viên sàn (`supplier.shop.approve`) khi TK chờ xác minh;
 *  - báo thành viên shop khi quản lý xác minh.
 */

const OWNER: UserBrief = { id: 'owner-1', email: 'chu.shop@fitly.vn', fullName: 'Nguyễn Văn A', phone: null, roleCode: 'customer', status: 'active', emailVerified: true };
const CREATED_AT = '2026-10-27T05:30:00.000Z'; // 12:30 giờ VN

function event(eventType: string, payload: Record<string, unknown>, id = 'evt-bank-1'): OutboxEventMessage {
  return { id, module: 'shop', eventType, eventVersion: 'v1', aggregateType: 'shop', aggregateId: 'shop-1', payload, requestId: null, createdAt: CREATED_AT };
}

const changedPayload = {
  shopId: 'shop-1',
  code: 'SHOP-000007',
  name: 'Xưởng May Mộc',
  bankCode: '970422',
  bankAccountName: 'NGUYEN VAN A',
  bankAccountNumberMasked: '••••••••9012',
  bankAccountLast4: '9012',
  changedByUserId: 'user-9',
  changedByEmail: 'nhanvien@shop.vn',
  ownerUserId: 'owner-1',
  changedAt: '2026-10-27T03:07:00.000Z', // 10:07 giờ VN
  bankPendingVerification: false,
  holdHours: 72,
};

describe('ShopBankListeners', () => {
  const markProcessed = jest.fn<Promise<boolean>, [unknown, string, string, string]>();
  const enqueue = jest.fn<Promise<void>, [MailMessage]>();
  const findUserBrief = jest.fn<Promise<UserBrief | null>, [string]>();
  const findShopById = jest.fn<Promise<{ ownerUserId: string } | null>, [string]>();
  const activeMemberUserIds = jest.fn<Promise<string[]>, [string]>();
  const notifyMany = jest.fn<Promise<void>, [NotifyCommand[], unknown?]>();
  const staffUserIdsWithPermission = jest.fn<Promise<string[]>, [string]>();
  const tx = { marker: 'tx' };
  let listeners: ShopBankListeners;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    jest.resetAllMocks();
    markProcessed.mockResolvedValue(true);
    enqueue.mockResolvedValue(undefined);
    findUserBrief.mockResolvedValue(OWNER);
    findShopById.mockResolvedValue({ ownerUserId: 'owner-1' });
    activeMemberUserIds.mockResolvedValue(['owner-1', 'staff-1']);
    notifyMany.mockResolvedValue(undefined);
    staffUserIdsWithPermission.mockResolvedValue(['mgr-1', 'admin-1']);

    const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    listeners = new ShopBankListeners(
      prisma,
      { markProcessed } as unknown as ShopOutboxService,
      { enqueue } as unknown as MailService,
      { findUserBrief } as unknown as IdentityQueryApi,
      { findById: findShopById } as unknown as ShopRepository,
      { activeMemberUserIds } as unknown as ShopQueryApi,
      { notifyMany } as unknown as NotificationGateway,
      { staffUserIdsWithPermission } as unknown as UserDirectoryGateway,
      { EF_APP_NAME: 'FITLY' } as unknown as Env,
    );
  });

  describe('cấu hình listener', () => {
    it.each(['onBankChangedMailOwner', 'onBankChangedNotifyManagers', 'onBankVerified'] as const)('%s đăng ký với suppressErrors=false (lỗi nổi lên để relay retry, không mất thư bảo mật)', (name) => {
      const handler = Object.getOwnPropertyDescriptor(ShopBankListeners.prototype, name)?.value as object;
      const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as Array<{ event: string; options?: { suppressErrors?: boolean } }> | undefined;

      expect(meta).toHaveLength(1);
      expect(meta?.[0].options?.suppressErrors).toBe(false);
    });

    it('đăng ký đúng tên sự kiện outbox', () => {
      const eventOf = (name: 'onBankChangedMailOwner' | 'onBankChangedNotifyManagers' | 'onBankVerified') => {
        const handler = Object.getOwnPropertyDescriptor(ShopBankListeners.prototype, name)?.value as object;
        return (Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as Array<{ event: string }>)[0].event;
      };

      expect(eventOf('onBankChangedMailOwner')).toBe('outbox.shop.SHOP_BANK_CHANGED');
      expect(eventOf('onBankChangedNotifyManagers')).toBe('outbox.shop.SHOP_BANK_CHANGED');
      expect(eventOf('onBankVerified')).toBe('outbox.shop.SHOP_BANK_VERIFIED');
    });
  });

  describe('[STL-11g] email cho CHỦ shop khi đổi tài khoản ngân hàng', () => {
    it('gửi tới email chủ shop: 4 số cuối, người đổi, thời điểm giờ VN, số giờ giữ, hướng dẫn "không phải bạn"; KHÔNG có số TK đầy đủ', async () => {
      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const mail = enqueue.mock.calls[0][0];
      expect(mail.to).toBe('chu.shop@fitly.vn');
      expect(mail.subject).toContain('FITLY');
      expect(mail.subject).toContain('Tài khoản ngân hàng');
      expect(mail.html).toContain('Nguyễn Văn A');
      expect(mail.html).toContain('Xưởng May Mộc');
      expect(mail.html).toContain('SHOP-000007');
      expect(mail.html).toContain('••••9012');
      expect(mail.html).toContain('nhanvien@shop.vn');
      expect(mail.html).toContain('27/10/2026 10:07'); // changedAt 03:07Z = 10:07 VN
      expect(mail.html).toContain('72 giờ');
      expect(mail.html).toContain('KHÔNG phải bạn');
      expect(mail.html).toContain('Quên mật khẩu');
      expect(mail.html).not.toContain('123456789012');
    });

    it('tìm chủ shop theo ownerUserId trong payload (không cần đọc bảng shop)', async () => {
      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload));

      expect(findUserBrief).toHaveBeenCalledWith('owner-1');
      expect(findShopById).not.toHaveBeenCalled();
    });

    it('sự kiện cũ chưa có ownerUserId ⇒ tra chủ shop từ bảng shop (relay có thể còn sự kiện phát trước khi nâng cấp)', async () => {
      const { ownerUserId: _o, ...legacy } = changedPayload;

      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', legacy));

      expect(findShopById).toHaveBeenCalledWith('shop-1');
      expect(findUserBrief).toHaveBeenCalledWith('owner-1');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('thiếu changedAt ⇒ dùng thời điểm tạo sự kiện (12:30 VN)', async () => {
      const { changedAt: _c, ...noTime } = changedPayload;

      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', noTime));

      expect(enqueue.mock.calls[0][0].html).toContain('27/10/2026 12:30');
    });

    it('MỌI giá trị chèn vào HTML đều được escape (tên shop / tên chủ shop / email người đổi / tên chủ TK chứa thẻ HTML)', async () => {
      findUserBrief.mockResolvedValue({ ...OWNER, fullName: '<img src=x onerror=alert(1)>Chủ' });

      await listeners.onBankChangedMailOwner(
        event('SHOP_BANK_CHANGED', { ...changedPayload, name: '<script>alert("xss")</script>', code: '"><b>x</b>', changedByEmail: 'a@b.vn<script>1</script>', bankAccountName: "O'Hara <i>X</i>", bankAccountLast4: '<9>' }),
      );

      const html = enqueue.mock.calls[0][0].html;
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<i>X</i>');
      expect(html).not.toContain('<b>x</b>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('O&#39;Hara');
    });

    it('TK chờ xác minh (tên lệch) ⇒ email nói rõ đang chờ sàn xác minh thay vì chỉ "giữ N giờ"', async () => {
      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', { ...changedPayload, bankPendingVerification: true }));

      const html = enqueue.mock.calls[0][0].html;
      expect(html).toContain('chờ sàn xác minh');
      expect(html).toContain('không khớp');
    });

    it('idempotent: relay phát lại event đã xử lý ⇒ KHÔNG gửi thêm email', async () => {
      markProcessed.mockResolvedValue(false);

      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload));

      expect(markProcessed).toHaveBeenCalledWith(tx, 'evt-bank-1', 'SHOP_BANK_CHANGED', 'bank-changed-owner-mail');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('đánh dấu đã xử lý CÙNG transaction với việc xếp mail (tx được truyền cho markProcessed)', async () => {
      await listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload));

      expect(markProcessed.mock.calls[0][0]).toBe(tx);
      expect(markProcessed.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
    });

    it('xếp hàng đợi mail LỖI ⇒ lỗi nổi lên để relay retry (thư bảo mật không được mất); thông báo trong app là listener khác nên không bị ảnh hưởng', async () => {
      enqueue.mockRejectedValue(new Error('redis down'));

      await expect(listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload))).rejects.toThrow('redis down');
      expect(notifyMany).not.toHaveBeenCalled(); // listener email không đụng thông báo trong app
    });

    it('không tìm thấy chủ shop / chủ không có email ⇒ cảnh báo rồi bỏ qua, không ném, không đánh dấu đã xử lý', async () => {
      findUserBrief.mockResolvedValue(null);

      await expect(listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload))).resolves.toBeUndefined();

      expect(enqueue).not.toHaveBeenCalled();
      expect(markProcessed).not.toHaveBeenCalled();
    });

    it('thiếu shopId ⇒ bỏ qua, không ném', async () => {
      await expect(listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', {}))).resolves.toBeUndefined();

      expect(enqueue).not.toHaveBeenCalled();
    });

    it('lỗi tra chủ shop (hạ tầng) ⇒ ném lên để relay retry', async () => {
      findUserBrief.mockRejectedValue(new Error('db down'));

      await expect(listeners.onBankChangedMailOwner(event('SHOP_BANK_CHANGED', changedPayload))).rejects.toThrow('db down');
    });
  });

  describe('báo nhân viên sàn khi TK chờ xác minh', () => {
    const pending = { ...changedPayload, bankPendingVerification: true };

    it('[STL-11d] TK chờ xác minh ⇒ báo mọi nhân viên có quyền supplier.shop.approve, link tới chi tiết shop, ghi cùng tx', async () => {
      await listeners.onBankChangedNotifyManagers(event('SHOP_BANK_CHANGED', pending));

      expect(staffUserIdsWithPermission).toHaveBeenCalledWith('supplier.shop.approve');
      const [cmds, usedTx] = notifyMany.mock.calls[0];
      expect(usedTx).toBe(tx);
      expect(cmds.map((c) => c.userId)).toEqual(['mgr-1', 'admin-1']);
      expect(cmds[0]).toMatchObject({ type: 'system', link: '/shop/shops/shop-1', payload: { shopId: 'shop-1', eventId: 'evt-bank-1' } });
      expect(cmds[0].title).toContain('Xưởng May Mộc');
      expect(cmds[0].content).toContain('••••9012');
      expect(JSON.stringify(cmds)).not.toContain('123456789012');
    });

    it('TK tên khớp (không chờ xác minh) ⇒ KHÔNG báo quản lý, không tra nhân viên', async () => {
      await listeners.onBankChangedNotifyManagers(event('SHOP_BANK_CHANGED', changedPayload));

      expect(staffUserIdsWithPermission).not.toHaveBeenCalled();
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('idempotent: event đã xử lý ⇒ không báo lại', async () => {
      markProcessed.mockResolvedValue(false);

      await listeners.onBankChangedNotifyManagers(event('SHOP_BANK_CHANGED', pending));

      expect(markProcessed).toHaveBeenCalledWith(tx, 'evt-bank-1', 'SHOP_BANK_CHANGED', 'bank-changed-notify-managers');
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('không có nhân viên nào có quyền ⇒ không ghi gì, không ném', async () => {
      staffUserIdsWithPermission.mockResolvedValue([]);

      await expect(listeners.onBankChangedNotifyManagers(event('SHOP_BANK_CHANGED', pending))).resolves.toBeUndefined();
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('ghi thông báo lỗi ⇒ ném lên để relay retry', async () => {
      notifyMany.mockRejectedValue(new Error('db down'));

      await expect(listeners.onBankChangedNotifyManagers(event('SHOP_BANK_CHANGED', pending))).rejects.toThrow('db down');
    });
  });

  describe('[STL-11e] báo thành viên shop khi quản lý sàn xác minh TK', () => {
    const verified = { shopId: 'shop-1', code: 'SHOP-000007', name: 'Xưởng May Mộc', bankAccountLast4: '9012', verifiedByUserId: 'mgr-1', verifiedAt: CREATED_AT, holdHours: 72 };

    it('báo mọi thành viên active của shop: đã xác minh + số giờ giữ kể từ lúc xác minh', async () => {
      await listeners.onBankVerified(event('SHOP_BANK_VERIFIED', verified, 'evt-ver-1'));

      expect(activeMemberUserIds).toHaveBeenCalledWith('shop-1');
      const [cmds, usedTx] = notifyMany.mock.calls[0];
      expect(usedTx).toBe(tx);
      expect(cmds.map((c) => c.userId)).toEqual(['owner-1', 'staff-1']);
      expect(cmds[0]).toMatchObject({ type: 'payment', link: '/vendor/shop', payload: { shopId: 'shop-1', eventId: 'evt-ver-1' } });
      expect(cmds[0].content).toContain('••••9012');
      expect(cmds[0].content).toContain('72 giờ');
    });

    it('idempotent: event đã xử lý ⇒ không báo lại', async () => {
      markProcessed.mockResolvedValue(false);

      await listeners.onBankVerified(event('SHOP_BANK_VERIFIED', verified, 'evt-ver-1'));

      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('thiếu shopId ⇒ bỏ qua; shop không còn thành viên ⇒ không ghi gì', async () => {
      await expect(listeners.onBankVerified(event('SHOP_BANK_VERIFIED', {}))).resolves.toBeUndefined();
      activeMemberUserIds.mockResolvedValue([]);
      await expect(listeners.onBankVerified(event('SHOP_BANK_VERIFIED', verified))).resolves.toBeUndefined();

      expect(notifyMany).not.toHaveBeenCalled();
    });
  });
});

describe('formatVnDateTime', () => {
  it('đổi sang giờ Việt Nam (UTC+7), định dạng dd/MM/yyyy HH:mm, qua nửa đêm đúng ngày', () => {
    expect(formatVnDateTime('2026-10-27T03:07:00.000Z')).toBe('27/10/2026 10:07');
    expect(formatVnDateTime('2026-10-27T18:30:00.000Z')).toBe('28/10/2026 01:30');
    expect(formatVnDateTime(new Date('2026-12-31T17:00:00.000Z'))).toBe('01/01/2027 00:00');
  });
});
