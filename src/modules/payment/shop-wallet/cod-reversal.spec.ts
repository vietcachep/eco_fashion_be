import { BusinessException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import type { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { METHOD, PAY_STATUS, PAYMENT_AUDIT, PAYMENT_ERR, TX_TYPE, WALLET_TX_TYPE } from '../foundation/payment.constants';
import { PaymentService } from '../payment/payment.service';
import { ShopWalletService } from './shop-wallet.service';

/*
 * COD-08b (PLAN-0031 §2.3 / PLAN-0040 Tầng 3.6): ĐẢO ghi thu COD. Khách báo chưa nhận hàng với đơn COD shop đã báo giao ⇒ payment `paid` → `cancelled` (+ reversed_at), giao dịch `cod_reverse`,
 * ví shop ghi dòng `cod_reversal` NGƯỢC DẤU dòng `cod_commission` của đơn. PaymentService chạy THẬT (chỉ hàm reverseCodCollection) + ShopWalletService THẬT trên DB giả trong bộ nhớ.
 * Jest dùng DB giả nên KHÔNG bắt được UNIQUE thật: ràng buộc (shop, type, order_code) của sổ cái và (type, provider_ref) của payment_transactions được giả lập ở đây để kiểm tính idempotent.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface Wallet { id: string; shopId: string; balance: Prisma.Decimal; version: number }
interface Entry { id: string; walletId: string; shopId: string; type: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; orderCode: string | null; note: string | null; meta: Record<string, unknown> | null }
interface PayRow { id: string; orderCode: string; methodCode: string; status: string; amount: Prisma.Decimal; shopId: string | null; reversedAt: Date | null; paidAt: Date | null; updatedBy: string | null; version: number }
interface PayTx { paymentId: string; type: string; status: string; providerRef: string | null; amount: Prisma.Decimal | null }

function build() {
  const wallets: Wallet[] = [{ id: 'w1', shopId: SHOP, balance: D(1_000_000), version: 0 }];
  const entries: Entry[] = [];
  const payments: PayRow[] = [];
  const payTxs: PayTx[] = [];
  const audits: Array<{ action: string; entityCode: string | null; before: unknown; after: Record<string, unknown> | null }> = [];
  let seq = 0;
  const matchRow = (row: object, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  const db = {
    shopCodWallet: {
      upsert: jest.fn(() => Promise.resolve(wallets[0])),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(wallets[0])),
      update: jest.fn(({ data }: { where: { id: string }; data: { balance: string } }) => {
        wallets[0].balance = D(data.balance);
        wallets[0].version += 1;
        return Promise.resolve(wallets[0]);
      }),
    },
    shopCodWalletTransaction: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => Promise.resolve(entries.find((e) => matchRow(e, where)) ?? null)),
      create: jest.fn(({ data }: { data: Omit<Entry, 'id' | 'amount' | 'balanceAfter'> & { amount: string; balanceAfter: string } }) => {
        // UNIQUE (shop_id, type, order_code) như DB thật
        if (entries.some((e) => e.shopId === data.shopId && e.type === data.type && e.orderCode === data.orderCode && data.orderCode !== null)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        const e: Entry = { ...data, id: `t${++seq}`, amount: D(data.amount), balanceAfter: D(data.balanceAfter) };
        entries.push(e);
        return Promise.resolve(e);
      }),
    },
    payment: {
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(payments.find((p) => p.id === where.id)!)),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<PayRow> & { version?: { increment: number } } }) => {
        const p = payments.find((x) => x.id === where.id)!;
        const { version, ...rest } = data;
        Object.assign(p, rest);
        if (version) p.version += version.increment;
        return Promise.resolve(p);
      }),
    },
    paymentTransaction: {
      create: jest.fn(({ data }: { data: PayTx }) => {
        // UNIQUE (type, provider_ref) WHERE provider_ref IS NOT NULL
        if (data.providerRef && payTxs.some((t) => t.type === data.type && t.providerRef === data.providerRef)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        payTxs.push({ ...data, amount: data.amount ?? null });
        return Promise.resolve(data);
      }),
    },
    paymentAuditLog: {
      create: jest.fn(({ data }: { data: { action: string; entityCode: string | null; beforeSummary?: unknown; afterSummary?: Record<string, unknown> } }) => {
        audits.push({ action: data.action, entityCode: data.entityCode, before: data.beforeSummary, after: data.afterSummary ?? null });
        return Promise.resolve(data);
      }),
    },
    /* SELECT id, status FROM payments WHERE order_code = $1 AND method_code = 'cod' AND status IN (...) FOR UPDATE */
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('"payment"."payments"')) {
        const rows = payments.filter((p) => p.orderCode === values[0] && p.methodCode === METHOD.COD && ['paid', 'partially_refunded', 'refunded'].includes(p.status));
        return Promise.resolve(rows.map((p) => ({ id: p.id, status: p.status })));
      }
      return Promise.resolve([]);
    }),
  };
  const shops = { findOfficialShopId: jest.fn(() => Promise.resolve(null)) };
  const system = { settingNumber: jest.fn(() => Promise.resolve(200_000)) };
  const wallet = new ShopWalletService(db as unknown as PrismaService, shops as unknown as ShopQueryApi, system as unknown as SystemQueryApi, { write: jest.fn() } as unknown as PaymentAuditLogService);
  // Chỉ cần `wallet` (+ audit nội bộ qua tx) cho reverseCodCollection ⇒ không phụ thuộc chữ ký constructor của PaymentService (agent khác đang sửa).
  const payment = Object.create(PaymentService.prototype) as PaymentService;
  Object.assign(payment, { wallet });
  const tx = db as unknown as Tx;
  const seedPayment = (over: Partial<PayRow> = {}): PayRow => {
    const p: PayRow = { id: `pay-${++seq}`, orderCode: 'DH260001', methodCode: METHOD.COD, status: PAY_STATUS.PAID, amount: D(1_000_000), shopId: SHOP, reversedAt: null, paidAt: new Date(), updatedBy: null, version: 0, ...over };
    payments.push(p);
    return p;
  };
  /* Ghi thu như markCodCollected: ví −hoa hồng (+ voucher sàn). */
  const collect = (orderCode = 'DH260001', over: Partial<Parameters<ShopWalletService['applyCodCommission']>[1]> = {}) =>
    wallet.applyCodCommission(tx, { shopId: SHOP, orderCode, total: 1_000_000n, commissionBase: 1_000_000n, platformCredit: 0n, commissionRate: '10.00', ...over });
  const reverse = (orderCode = 'DH260001') => payment.reverseCodCollection({ orderCode, shopId: SHOP, reason: 'Khách chưa nhận hàng: Chưa nhận được hàng', actorUserId: ACTOR }, tx);
  return { payment, wallet, tx, wallets, entries, payments, payTxs, audits, seedPayment, collect, reverse, db };
}

describe('[COD-08b] PaymentService.reverseCodCollection — đảo ghi thu COD', () => {
  it('[COD-08b] payment COD `paid` → `cancelled` + reversed_at; giao dịch cod_reverse; ví shop được TRẢ LẠI hoa hồng (dòng cod_reversal ngược dấu cod_commission); audit', async () => {
    const s = build();
    const p = s.seedPayment();
    await s.collect(); // hoa hồng 10% của 1.000.000 = 100.000 ⇒ ví 900.000
    expect(s.wallets[0].balance.toString()).toBe('900000');
    const res = await s.reverse();
    expect(res).toEqual({ reversed: true });
    expect(p).toMatchObject({ status: PAY_STATUS.CANCELLED, updatedBy: ACTOR, version: 1 });
    expect(p.reversedAt).toBeInstanceOf(Date);
    expect(s.payTxs).toEqual([{ paymentId: p.id, type: TX_TYPE.COD_REVERSE, status: 'ok', providerRef: 'cod-reverse:DH260001', amount: p.amount, rawRequest: { reason: 'Khách chưa nhận hàng: Chưa nhận được hàng' } }]);
    expect(s.wallets[0].balance.toString()).toBe('1000000'); // hoa hồng đã trả lại
    expect(s.entries.map((e) => [e.type, e.amount.toString(), e.orderCode])).toEqual([
      [WALLET_TX_TYPE.COD_COMMISSION, '-100000', 'DH260001'],
      [WALLET_TX_TYPE.COD_REVERSAL, '100000', 'DH260001'],
    ]);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({ action: PAYMENT_AUDIT.COD_REVERSED, entityCode: 'DH260001', after: expect.objectContaining({ status: PAY_STATUS.CANCELLED, walletReversed: '100000' }) as unknown });
  });

  it('[COD-08b] đơn có voucher SÀN (sàn bù cho shop): ví đảo đúng delta ngược dấu — shop trả lại phần sàn đã bù, nhận lại hoa hồng', async () => {
    const s = build();
    s.seedPayment();
    await s.collect('DH260001', { total: 950_000n, commissionBase: 300_000n, platformCredit: 50_000n }); // hoa hồng 30.000, bù 50.000 ⇒ ví +20.000
    expect(s.wallets[0].balance.toString()).toBe('1020000');
    await s.reverse();
    expect(s.wallets[0].balance.toString()).toBe('1000000');
    expect(s.entries.find((e) => e.type === WALLET_TX_TYPE.COD_REVERSAL)?.amount.toString()).toBe('-20000');
  });

  it('[COD-08b] KHÔNG đảo hai lần: gọi lại ⇒ { reversed:false }, ví/giao dịch/audit không đổi thêm', async () => {
    const s = build();
    const p = s.seedPayment();
    await s.collect();
    expect(await s.reverse()).toEqual({ reversed: true });
    const snapshot = JSON.stringify({ w: s.wallets, e: s.entries, t: s.payTxs, a: s.audits.length });
    expect(await s.reverse()).toEqual({ reversed: false });
    expect(JSON.stringify({ w: s.wallets, e: s.entries, t: s.payTxs, a: s.audits.length })).toBe(snapshot);
    expect(p.status).toBe(PAY_STATUS.CANCELLED);
  });

  it('[COD-08b] ví cũng tự bảo vệ: payment bị đưa về `paid` nhầm rồi đảo lại ⇒ dòng cod_reversal đã có thì không ghi thêm (UNIQUE shop+type+đơn)', async () => {
    const s = build();
    s.seedPayment();
    await s.collect();
    await s.reverse();
    s.payments[0].status = PAY_STATUS.PAID; // giả lập dữ liệu hỏng
    await expect(s.reverse()).rejects.toMatchObject({ code: 'P2002' }); // giao dịch cod_reverse trùng provider_ref ⇒ DB từ chối, hoàn tác cả tx
    expect(s.entries.filter((e) => e.type === WALLET_TX_TYPE.COD_REVERSAL)).toHaveLength(1);
    expect(s.wallets[0].balance.toString()).toBe('1000000');
  });

  it('[COD-08b] payment COD đã có hoàn tiền (partially_refunded / refunded) ⇒ 409 PAYMENT_INVALID_STATE, không đảo chồng lên sổ hoàn', async () => {
    for (const status of [PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED]) {
      const s = build();
      s.seedPayment({ status });
      await s.collect();
      await expect(s.reverse()).rejects.toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, httpStatus: 409 });
      expect(s.payments[0].status).toBe(status);
      expect(s.entries.filter((e) => e.type === WALLET_TX_TYPE.COD_REVERSAL)).toHaveLength(0);
      expect(s.wallets[0].balance.toString()).toBe('900000');
    }
  });

  it('[COD-08b] đơn PayOS / payment COD chưa thu (`pending`) ⇒ { reversed:false }, không đụng gì', async () => {
    const payos = build();
    payos.seedPayment({ methodCode: METHOD.PAYOS });
    expect(await payos.reverse()).toEqual({ reversed: false });
    expect(payos.payments[0].status).toBe(PAY_STATUS.PAID);
    const pending = build();
    pending.seedPayment({ status: PAY_STATUS.PENDING });
    expect(await pending.reverse()).toEqual({ reversed: false });
    expect(pending.payments[0].status).toBe(PAY_STATUS.PENDING);
    expect(pending.entries).toHaveLength(0);
    expect(pending.audits).toHaveLength(0);
  });

  it('[COD-08b] đơn chưa có dòng cod_commission (dữ liệu cũ) ⇒ vẫn đảo payment nhưng ví không đổi', async () => {
    const s = build();
    s.seedPayment();
    expect(await s.reverse()).toEqual({ reversed: true });
    expect(s.entries).toHaveLength(0);
    expect(s.wallets[0].balance.toString()).toBe('1000000');
    expect(s.audits[0].after).toMatchObject({ walletReversed: null });
  });

  it('[COD-08b] lỗi giữa chừng (ví lỗi) ⇒ ném lỗi để transaction của caller hoàn tác (không nuốt lỗi)', async () => {
    const s = build();
    s.seedPayment();
    await s.collect();
    s.db.shopCodWallet.update.mockRejectedValueOnce(new BusinessException('X', 'ví lỗi'));
    await expect(s.reverse()).rejects.toThrow('ví lỗi');
  });
});
