import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { assertLiveAuditDatabase } from './live-fixtures';

/* Chỉ dữ liệu giả trong DB audit riêng; không đọc .env hay gọi dịch vụ thanh toán thật. */
async function main() {
  const url = process.env.EF_DATABASE_URL ?? '';
  assertLiveAuditDatabase(url);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const f = JSON.parse(await readFile(join(tmpdir(), 'fitly-live-fixtures.json'), 'utf8')) as {
    tokens: Record<string, string>;
    users: Record<string, { id: string; email: string; password: string }>;
    shopId: string;
    variantId: string;
    productId: string;
    sessionId: string;
  };
  type Data = {
    id: string;
    version: number;
    state: string;
    code: string;
    sourceGrantId: string;
    groupCode: string;
    errorCode: string;
    itemCount: number;
    eligibleQuantity: number;
    redeemUntil: string;
    shippingQuoteId?: string;
    amount: string;
    summary: { total: Data; discount: Data; shopGroups: Data[] };
    group: { orders: Data[] };
    lines: Data[];
    content: Data[];
    data?: Data;
  };
  const call = async (
    who: string,
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
    expected = 200,
  ): Promise<Data> => {
    const r = await fetch('http://localhost:4006/api/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + f.tokens[who],
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json()) as Data;
    assert.ok(
      r.status === expected || (expected === 200 && r.status === 201),
      `${method} ${path}: ${r.status} ${JSON.stringify(j)}`,
    );
    return j.data ?? j;
  };
  try {
    // Tách khách mỗi lượt để không sửa giỏ/context browser của agent và không đụng quota lượt trước.
    for (const who of ['viewer', 'viewerTwo']) {
      const seed = await db.user.findUniqueOrThrow({where:{id:f.users[who].id},select:{passwordHash:true,roleId:true}});
      const user = await db.user.create({data:{email:`live-commerce-${randomUUID()}@example.test`,fullName:'Khách audit commerce',passwordHash:seed.passwordHash,roleId:seed.roleId,emailVerifiedAt:new Date()}});
      f.users[who] = {id:user.id,email:user.email,password:f.users[who].password};
    }
    for (const who of ['owner', 'viewer', 'viewerTwo']) {
      const login = await fetch('http://localhost:4006/api/v1/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.users[who].email,password:f.users[who].password})});
      const result = await login.json() as {data?:{accessToken?:string}};
      assert.ok(login.ok && result.data?.accessToken, 'Audit fixture login failed');
      f.tokens[who] = result.data.accessToken;
    }
    await db.paymentMethod.upsert({
      where: { code: 'cod' },
      create: { code: 'cod', name: 'COD audit', kind: 'cod' },
      update: { isActive: true },
    });
    await db.shopCodWallet.upsert({
      where: { shopId: f.shopId },
      create: { shopId: f.shopId, balance: '1000000' },
      update: { balance: '1000000' },
    });
    const addressIds: Record<string, string> = {};
    for (const who of ['viewer', 'viewerTwo']) {
      const a =
        (await db.address.findFirst({
          where: { userId: f.users[who].id, isDefault: true, isDeleted: false },
        })) ??
        (await db.address.create({
          data: {
            userId: f.users[who].id,
            recipientName: 'Người nhận audit',
            phone: '0900000000',
            provinceName: 'Đồng Nai',
            districtName: 'Nhơn Trạch',
            wardName: 'Phước Thiền',
            street: 'Địa chỉ audit không giao thật',
            ghnProvinceId: 204,
            ghnDistrictId: 1542,
            ghnWardCode: '480102',
            isDefault: true,
          },
        }));
      addressIds[who] = a.id;
    }
    const intent = async (who: string, mode: string, quantity = 1) =>
      call(
        who,
        '/checkout/intents',
        'POST',
        { mode, ...(mode === 'buy_now' ? { lines: [{ variantId: f.variantId, quantity }] } : {}) },
        randomUUID(),
      );
    const quote = async (who: string, i: Data, codes: string[] = []) =>
      call(who, `/checkout/intents/${i.id}/quote`, 'POST', {
        intentVersion: i.version,
        addressId: addressIds[who],
        paymentMethodCode: 'cod',
        voucherCodes: codes,
      });
    const submit = async (who: string, i: Data, q: Data, codes: string[] = [], key = randomUUID()) => {
      const body = {
        intentVersion: i.version,
        addressId: addressIds[who],
        paymentMethodCode: 'cod',
        voucherCodes: codes,
        expectedTotal: q.summary.total.amount,
        quoteIds: q.summary.shopGroups.flatMap((g: Data) => (g.shippingQuoteId ? [g.shippingQuoteId] : [])),
      };
      return { attempt: await call(who, `/checkout/intents/${i.id}/attempts`, 'POST', body, key), body, key };
    };
    await call('viewer', '/cart', 'DELETE');
    await call('viewer', '/cart/items', 'POST', { variantId: f.variantId, quantity: 2 });
    const direct = await intent('viewer', 'buy_now');
    const dq = await quote('viewer', direct);
    const placed = await submit('viewer', direct, dq);
    assert.equal(placed.attempt.state, 'succeeded');
    assert.equal((await call('viewer', '/cart')).itemCount, 2, 'buy_now preserves cart');
    const replay = await call(
      'viewer',
      `/checkout/intents/${direct.id}/attempts`,
      'POST',
      placed.body,
      placed.key,
    );
    assert.equal(replay.groupCode, placed.attempt.groupCode);
    await call('viewerTwo', `/checkout/intents/${direct.id}`, 'GET', undefined, undefined, 404);
    const fenced = await intent('viewer', 'buy_now');
    const fk = randomUUID();
    assert.equal(
      (await call('viewer', `/checkout/intents/${fenced.id}/attempts/${fk}`)).errorCode,
      'CHECKOUT_REQUEST_NOT_RECEIVED',
    );
    const fq = await quote('viewer', fenced);
    await call(
      'viewer',
      `/checkout/intents/${fenced.id}/attempts`,
      'POST',
      {
        intentVersion: fenced.version,
        addressId: addressIds.viewer,
        paymentMethodCode: 'cod',
        expectedTotal: fq.summary.total.amount,
      },
      fk,
      409,
    );
    const selected = await intent('viewer', 'cart_selection');
    await call('viewer', '/cart/items', 'POST', { variantId: f.variantId, quantity: 1 });
    assert.equal(
      (await submit('viewer', selected, await quote('viewer', selected))).attempt.state,
      'succeeded',
    );
    assert.equal((await call('viewer', '/cart')).itemCount, 1, 'cart snapshot preserves later increments');
    console.log(
      'PASS buy_now isolation, order replay, ownership, missing-attempt fencing, cart quantity snapshot',
    );
    assert.ok(f.sessionId, 'Run genuine media audit first');
    await call('viewerTwo', `/livestreams/${f.sessionId}/viewer-session`, 'POST');
    const campaign = await call('owner', `/shop/livestreams/${f.sessionId}/campaigns`, 'POST', {
      code: 'AUDIT' + randomUUID().slice(0, 8),
      name: 'Giảm50% chỉ lượng live',
      type: 'percentage',
      value: 50,
    });
    const claim = await call(
      'viewerTwo',
      `/livestreams/${f.sessionId}/campaigns/${campaign.id}/claims`,
      'POST',
    );
    await call('viewerTwo', '/cart', 'DELETE');
    await call('viewerTwo', '/cart/items', 'POST', { variantId: f.variantId, quantity: 2 });
    const grant = await call('viewerTwo', `/livestreams/${f.sessionId}/source-grants`, 'POST', {
      productId: f.productId,
      quantity: 1,
    });
    const add = {
      variantId: f.variantId,
      quantity: 1,
      sourceGrantId: grant.sourceGrantId,
      requestId: randomUUID(),
    };
    await call('viewerTwo', '/cart/items', 'POST', add);
    await call('viewerTwo', '/cart/items', 'POST', add);
    const cart = await call('viewerTwo', '/cart');
    assert.equal(cart.itemCount, 3);
    assert.equal(cart.lines[0].eligibleQuantity, 1);
    const live = await intent('viewerTwo', 'cart_selection');
    const lq = await quote('viewerTwo', live, [campaign.code]);
    assert.equal(lq.summary.discount.amount, '50000');
    const bought = await submit('viewerTwo', live, lq, [campaign.code]);
    assert.equal(bought.attempt.state, 'succeeded');
    assert.equal((await call('viewerTwo', '/cart')).itemCount, 0);
    const child = bought.attempt.group.orders[0];
    await call('viewerTwo', `/orders/${child.code}/cancel`, 'POST', { reason: 'Đổi ý - kiểm thử audit' });
    const wallet = await call('viewerTwo', '/promotions/me/claims');
    const restored = wallet.content.find((c: Data) => c.id === claim.id);
    assert.ok(restored, 'Claim must remain in wallet after cancellation');
    assert.equal(restored.state, 'restored');
    assert.equal(restored.redeemUntil, campaign.redeemUntil);
    const recovered = await call('viewerTwo', `/promotions/me/claims/${claim.id}/recovery-intents`, 'POST');
    assert.equal(recovered.itemCount, 1);
    assert.equal(recovered.lines[0].eligibleQuantity, 1);
    assert.equal((await quote('viewerTwo', recovered, [campaign.code])).summary.discount.amount, '50000');
    console.log(
      'PASS real-live source quantity, add replay, coupon50k/eligible1of3, COD cancellation restoration, original expiry, recovery quantity1',
    );
  } finally {
    await db.$disconnect();
  }
}
void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
