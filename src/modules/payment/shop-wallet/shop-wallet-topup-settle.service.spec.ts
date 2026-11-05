import { HttpStatus, Logger } from '@nestjs/common';
import { sanitizeSummary } from '@common/audit/audit';
import { isPrismaError } from '@common/prisma/errors';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { TOPUP_STATUS, WALLET_ERR } from '../foundation/payment.constants';
import { ACCOUNTANT_ID, advanceClock, bizError, buildTopupFixture, deadlockError, NOW, nextReference, nextTopupCode, OWNER_A, OWNER_A_ID, p2002, SHOP_A, SHOP_B, SHOP_OFFICIAL, setClock, stopFixture, webhookData } from './shop-wallet-topup.fixture';
import type { Row, TopupFixture } from './shop-wallet-topup.fixture';
import { nextStatusAfterMoney, parseMoney, receiptRef, targetCumulative } from './shop-wallet-topup-settle.service';
import type { TopupStatus } from './shop-wallet-topup.types';

/*
 * ShopWalletTopupSettleService (PLAN-0041 §6.4 B–G, WP-3) trên DB giả có khoá/rollback/unique thật (fixture).
 * Mỗi test dựng DB mới; PayOS là PayosService thật với 3 hàm mạng bị spy; thông báo ghi lại có truyền `tx` hay không.
 */

const TOPUP_AMOUNT = 600_000;
const CREDIT_REFERENCE_PREFIX = 'payos-topup:';

describe('ShopWalletTopupSettleService — ghi có ví từ khoản nạp PayOS', () => {
  let fx: TopupFixture;
  beforeEach(() => {
    fx = buildTopupFixture();
  });
  afterEach(() => stopFixture());

  /* Khoản đang chờ thanh toán của SHOP_A (mặc định 600.000, còn hạn). */
  const open = (o: Parameters<TopupFixture['seedTopup']>[0] = {}) => fx.seedTopup({ shopId: SHOP_A, amount: TOPUP_AMOUNT, status: 'pending', ...o });
  const codeOf = (t: Row) => String(t.payosOrderCode);
  const webhook = (code: string, amount: number, reference: string | null = nextReference(), paidOk = true) => fx.settle.settleWebhookIfTopup(code, webhookData(code, amount, reference), paidOk);
  const statusOf = (id: string) => String(fx.topupOf(id)?.status);
  const toOwner = () => fx.notifications.filter((n) => n.cmd.userId === OWNER_A_ID);
  const toAccountant = () => fx.notifications.filter((n) => n.cmd.userId === ACCOUNTANT_ID);
  const alertReasons = () => toAccountant().map((n) => (n.cmd.payload as { reason?: string } | null)?.reason);

  it('[WTS-01] đủ tiền ⇒ paid, paid_at, ví +X, 1 biên nhận, 1 dòng sổ topup_payos có topup_id+ref_key, audit WALLET_TOPUP_CREDITED, thông báo chủ shop; KHÔNG báo kế toán (WTP-01)', async () => {
    const t = open();
    const r = await webhook(codeOf(t), TOPUP_AMOUNT, 'REF-1');
    expect(r).toEqual({ outcome: 'credited', message: 'Success' });
    const row = fx.topupOf(t.id)!;
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(String(row.receivedAmount)).toBe(String(TOPUP_AMOUNT));
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));
    expect(fx.receiptsOf(t.id)).toHaveLength(1);
    const [entry] = fx.ledgerOf(SHOP_A, 'topup_payos');
    expect(entry.topupId).toBe(t.id);
    expect(entry.refKey).toBe(`${CREDIT_REFERENCE_PREFIX}${t.id}:${TOPUP_AMOUNT}`);
    expect(String(entry.amount)).toBe(String(TOPUP_AMOUNT));
    expect(fx.auditOf('WALLET_TOPUP_CREDITED')).toHaveLength(1);
    expect(toOwner()).toHaveLength(1);
    expect(toAccountant()).toHaveLength(0);
  });

  it('[WTS-02] thiếu ⇒ partial, ví +a; không báo kế toán (WTP-02)', async () => {
    const t = open();
    await expect(webhook(codeOf(t), 200_000, 'REF-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(t.id)).toBe('partial');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('200000');
    expect(toAccountant()).toHaveLength(0);
  });

  it('[WTS-03] thiếu rồi nốt (2 reference) ⇒ paid, 2 dòng sổ, Σ = tổng; ref_key hai dòng khác nhau (WTP-03)', async () => {
    const t = open();
    await webhook(codeOf(t), 300_000, 'REF-1');
    await expect(webhook(codeOf(t), 300_000, 'REF-2')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(t.id)).toBe('paid');
    const ledger = fx.ledgerOf(SHOP_A, 'topup_payos');
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((l) => String(l.refKey))).size).toBe(2);
    expect(ledger.reduce((s, l) => s + Number(String(l.amount)), 0)).toBe(TOPUP_AMOUNT);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));
  });

  it('[WTS-04] thừa ⇒ ví +TOÀN BỘ thực nhận, paid, báo kế toán "overpaid", không hoàn (WTP-04)', async () => {
    const t = open();
    await expect(webhook(codeOf(t), 700_000, 'REF-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(t.id)).toBe('paid');
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('700000');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('700000');
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(alertReasons()).toEqual(['overpaid']);
  });

  it('[WTS-05] replay cùng reference ⇒ không thêm biên nhận/dòng sổ/ví; kết quả replay (WTP-05)', async () => {
    const t = open();
    await expect(webhook(codeOf(t), 200_000, 'REF-1')).resolves.toMatchObject({ outcome: 'credited' });
    await expect(webhook(codeOf(t), 200_000, 'REF-1')).resolves.toEqual({ outcome: 'replay', message: 'Success' });
    expect(fx.receiptsOf(t.id)).toHaveLength(1);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('200000');
  });

  it('[WTS-06] 3 webhook CÙNG reference đồng thời (khoá dòng FIFO, xen kẽ ép buộc) ⇒ đúng 1 biên nhận + 1 dòng sổ; 0 deadlock (WTP-06)', async () => {
    const t = open();
    fx.engine.gateTransactions(3);
    const results = await Promise.allSettled([webhook(codeOf(t), 200_000, 'SAME'), webhook(codeOf(t), 200_000, 'SAME'), webhook(codeOf(t), 200_000, 'SAME')]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value?.outcome : 'error')).sort();
    expect(outcomes).toEqual(['credited', 'replay', 'replay']);
    expect(fx.receiptsOf(t.id)).toHaveLength(1);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('200000');
    expect(fx.engine.deadlocks).toBe(0);
  });

  it('[WTS-07] đã paid, webhook khác reference ⇒ cộng thêm đúng số, vẫn paid, báo kế toán "duplicate" (WTP-07)', async () => {
    const t = open();
    await webhook(codeOf(t), TOPUP_AMOUNT, 'REF-1');
    await expect(webhook(codeOf(t), 100_000, 'REF-2')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(t.id)).toBe('paid');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('700000');
    expect(alertReasons()).toEqual(['duplicate']);
  });

  it('[WTS-08] 2 webhook khác reference đồng thời ⇒ cả hai được cộng, Σ đúng, 0 deadlock; FOR UPDATE topups TRƯỚC wallet; không lệnh khoá đơn/payment (WTP-08)', async () => {
    const t = open();
    fx.engine.gateTransactions(2);
    const results = await Promise.allSettled([webhook(codeOf(t), 200_000, 'R-A'), webhook(codeOf(t), 300_000, 'R-B')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('500000');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('500000');
    expect(fx.engine.deadlocks).toBe(0);
    const txIds = [...new Set(fx.engine.calls.filter((c) => c.label.startsWith('LOCK')).map((c) => c.tx))];
    expect(txIds).toHaveLength(2);
    for (const id of txIds) {
      const locks = fx.engine.calls.filter((c) => c.tx === id && c.label.startsWith('LOCK')).map((c) => c.label);
      expect(locks).toEqual(['LOCK shop_cod_topups', 'LOCK shop_cod_wallets']);
    }
    expect(fx.engine.calls.every((c) => !/order|payment_transactions|payments/.test(c.label))).toBe(true);
  });

  it('[WTS-09] webhook thiếu reference nhưng có transactionDateTime ⇒ khoá ghép <mã>:<giờ>:<số tiền>; thiếu CẢ HAI ⇒ outcome unkeyed, không ghi có, báo kế toán, không ném (WTP-13/D13)', async () => {
    const t = open();
    const code = codeOf(t);
    await expect(fx.settle.settleWebhookIfTopup(code, webhookData(code, TOPUP_AMOUNT, null), true)).resolves.toMatchObject({ outcome: 'credited' });
    expect(fx.receiptsOf(t.id)[0].reference).toBe(`${code}:2026-11-03 10:05:00:${TOPUP_AMOUNT}`);

    const u = open({ shopId: SHOP_B, amount: TOPUP_AMOUNT });
    const data = webhookData(codeOf(u), TOPUP_AMOUNT, null);
    delete data.transactionDateTime;
    await expect(fx.settle.settleWebhookIfTopup(codeOf(u), data, true)).resolves.toMatchObject({ outcome: 'unkeyed' });
    expect(fx.receiptsOf(u.id)).toHaveLength(0);
    expect(fx.ledgerOf(SHOP_B)).toHaveLength(0);
    expect(alertReasons()).toEqual(['unkeyed']);
  });

  it('[WTS-10] amount không hợp lệ (chữ, 0, âm, thập phân, > trần cột) ⇒ outcome ignored, không ghi có, báo kế toán, logger.error', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = open();
    for (const [i, bad] of ['abc', 0, -5, 1.5, 100_000_000_000_000].entries()) {
      const data = { orderCode: Number(codeOf(t)), amount: bad, reference: `BAD-${i}`, transactionDateTime: '2026-11-03 10:05:00', code: '00', desc: 'success' };
      await expect(fx.settle.settleWebhookIfTopup(codeOf(t), data, true)).resolves.toEqual({ outcome: 'ignored', message: 'Ignored: invalid amount' });
    }
    expect(fx.receiptsOf(t.id)).toHaveLength(0);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(0);
    expect(alertReasons().every((r) => r === 'invalid_amount')).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('[WTS-11] paidOk=false ⇒ ignored, không ghi gì', async () => {
    const t = open();
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'REF-1', false)).resolves.toEqual({ outcome: 'ignored', message: 'Ignored: not a success event' });
    expect(fx.receiptsOf(t.id)).toHaveLength(0);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(0);
    expect(statusOf(t.id)).toBe('pending');
  });

  it('[WTS-12] mã không thuộc khoản nạp nào ⇒ null; mã không phải số / 17 chữ số ⇒ null và KHÔNG chạm DB (WTP-26)', async () => {
    await expect(fx.settle.settleWebhookIfTopup('5000000000000999', webhookData('5000000000000999', 1000), true)).resolves.toBeNull();
    const before = fx.engine.calls.length;
    await expect(fx.settle.settleWebhookIfTopup('abc', webhookData('abc', 1000), true)).resolves.toBeNull();
    await expect(fx.settle.settleWebhookIfTopup('12345678901234567', webhookData('12345678901234567', 1000), true)).resolves.toBeNull();
    expect(fx.engine.calls.length).toBe(before);
  });

  it('[WTS-13] poll: amountPaid > đã ghi có ⇒ ghi có phần chênh, ref_key theo luỹ kế; chạy lại cùng số ⇒ không ghi thêm (WTP-09)', async () => {
    const t = open();
    fx.pay(codeOf(t), 300_000, 'PAY-1');
    await expect(fx.settle.reconcileOne(t.id)).resolves.toBe('credited');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('300000');
    expect(fx.ledgerOf(SHOP_A)[0].refKey).toBe(`${CREDIT_REFERENCE_PREFIX}${t.id}:300000`);
    expect(statusOf(t.id)).toBe('partial');
    await expect(fx.settle.reconcileOne(t.id)).resolves.toBe('unchanged');
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('300000');
  });

  it('[WTS-14] webhook rồi poll, poll rồi webhook, và poll gồm 2 khoản rồi 2 webhook đến sau ⇒ không cộng đôi/dư (WTP-10, WTP-11)', async () => {
    // (a) webhook trước, poll sau cùng khoản
    const a = open();
    fx.pay(codeOf(a), 300_000, 'R1');
    await webhook(codeOf(a), 300_000, 'R1');
    await expect(fx.settle.reconcileOne(a.id)).resolves.toBe('unchanged');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('300000');

    // (b) poll trước, webhook sau cùng khoản: biên nhận vẫn được ghi, không cộng đôi
    const b = open({ shopId: SHOP_B });
    fx.pay(codeOf(b), 300_000, 'R1');
    await expect(fx.settle.reconcileOne(b.id)).resolves.toBe('credited');
    await expect(webhook(codeOf(b), 300_000, 'R1')).resolves.toMatchObject({ outcome: 'noop' });
    expect(fx.receiptsOf(b.id)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_B)?.balance)).toBe('300000');

    // (c) poll thấy 2 khoản (400.000) trước, rồi 2 webhook đến sau ⇒ không cộng dư (SHOP_OFFICIAL để tránh trùng khoản mở của SHOP_A)
    const c = open({ shopId: SHOP_OFFICIAL, payosOrderCode: nextTopupCode() });
    fx.pay(codeOf(c), 200_000, 'C1');
    fx.pay(codeOf(c), 200_000, 'C2');
    await expect(fx.settle.reconcileOne(c.id)).resolves.toBe('credited');
    expect(String(fx.walletOf(SHOP_OFFICIAL)?.balance)).toBe('400000');
    await expect(webhook(codeOf(c), 200_000, 'C1')).resolves.toMatchObject({ outcome: 'noop' });
    await expect(webhook(codeOf(c), 200_000, 'C2')).resolves.toMatchObject({ outcome: 'noop' });
    expect(String(fx.walletOf(SHOP_OFFICIAL)?.balance)).toBe('400000');
    expect(fx.receiptsOf(c.id)).toHaveLength(2);
  });

  it('[WTS-15] poll luỹ kế THẤP hơn đã ghi có ⇒ ví và received không đổi, không ném (WTP-12)', async () => {
    const t = open();
    await webhook(codeOf(t), 300_000, 'R1');
    fx.statusOverride.set(codeOf(t), { status: 'UNDERPAID', amountPaid: 100_000 });
    await expect(fx.settle.reconcileOne(t.id)).resolves.not.toBe('credited');
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('300000');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('300000');
  });

  it('[WTS-16] PayOS không trả lời (unknown) ⇒ khoản mở KHÔNG bị đóng, không ghi gì; creating mồ côi > 90 s ⇒ failed', async () => {
    const pending = open();
    fx.getLink.mockResolvedValueOnce({});
    await expect(fx.settle.reconcileOne(pending.id)).resolves.toBe('unknown');
    expect(statusOf(pending.id)).toBe('pending');

    const orphan = open({ shopId: SHOP_B, status: 'creating', checkoutUrl: null, createdAt: new Date(NOW - 100_000), expiresAt: new Date(NOW + 3_600_000) });
    fx.getLink.mockResolvedValueOnce({});
    await expect(fx.settle.reconcileOne(orphan.id)).resolves.toBe('closed');
    expect(statusOf(orphan.id)).toBe('failed');
    expect(String(fx.topupOf(orphan.id)?.linkError)).toBe('PayOS không có link');
    expect(fx.walletOf(SHOP_B)).toBeUndefined();
  });

  it('[WTS-17] PayOS báo EXPIRED/CANCELLED: received 0 ⇒ đóng sạch; có partial ⇒ giữ received và báo kế toán partial_closed đúng MỘT lần (WTP-13, WTP-15)', async () => {
    const clean = open();
    fx.statusOverride.set(codeOf(clean), { status: 'EXPIRED', amountPaid: 0 });
    await expect(fx.settle.reconcileOne(clean.id)).resolves.toBe('closed');
    expect(statusOf(clean.id)).toBe('expired');
    expect(fx.topupOf(clean.id)?.closedAt).toBeInstanceOf(Date);
    expect(toAccountant()).toHaveLength(0);

    const cancelled = open({ shopId: SHOP_B });
    fx.statusOverride.set(codeOf(cancelled), { status: 'CANCELLED', amountPaid: 0 });
    await expect(fx.settle.reconcileOne(cancelled.id)).resolves.toBe('closed');
    expect(statusOf(cancelled.id)).toBe('cancelled');

    const partial = open({ shopId: SHOP_A, payosOrderCode: nextTopupCode() });
    await webhook(codeOf(partial), 300_000, 'P1');
    fx.statusOverride.set(codeOf(partial), { status: 'EXPIRED', amountPaid: 300_000 });
    await expect(fx.settle.reconcileOne(partial.id)).resolves.toBe('closed');
    expect(statusOf(partial.id)).toBe('expired');
    expect(String(fx.topupOf(partial.id)?.receivedAmount)).toBe('300000');
    expect(alertReasons().filter((r) => r === 'partial_closed')).toHaveLength(1);
  });

  it('[WTS-18] quá expires_at + 2 phút ⇒ hỏi PayOS TRƯỚC (có tiền thì ghi có) rồi mới expired; chưa quá 2 phút ⇒ chưa đóng (WTP-13)', async () => {
    const t = open({ expiresAt: new Date(NOW) });
    setClock(NOW + 60_000);
    await expect(fx.settle.reconcileOne(t.id)).resolves.toBe('unchanged');
    expect(statusOf(t.id)).toBe('pending');

    fx.pay(codeOf(t), 100_000, 'LATE-1');
    setClock(NOW + 3 * 60_000);
    await expect(fx.settle.reconcileOne(t.id)).resolves.toBe('credited');
    expect(statusOf(t.id)).toBe('expired');
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('100000');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('100000');
  });

  it('[WTS-19] webhook trên expired ⇒ ghi có; ≥ amount ⇒ paid, < amount ⇒ giữ expired; báo kế toán "late" (WTP-14)', async () => {
    const full = open({ status: 'expired', closedAt: new Date(NOW - 3_600_000) });
    await expect(webhook(codeOf(full), TOPUP_AMOUNT, 'L-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(full.id)).toBe('paid');
    expect(alertReasons()).toEqual(['late']);

    const short = open({ status: 'expired', closedAt: new Date(NOW - 3_600_000), shopId: SHOP_B });
    await expect(webhook(codeOf(short), 100_000, 'L-2')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(short.id)).toBe('expired');
    expect(String(fx.topupOf(short.id)?.receivedAmount)).toBe('100000');
    expect(alertReasons().filter((r) => r === 'late')).toHaveLength(2);
  });

  it('[WTS-20] webhook trên cancelled / failed ⇒ ghi có như trên (cancelled giữ nguyên nếu thiếu; failed đủ ⇒ paid) (WTP-14, WTP-25)', async () => {
    const cancelled = open({ status: 'cancelled', closedAt: new Date(NOW - 60_000) });
    await expect(webhook(codeOf(cancelled), 200_000, 'C-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(cancelled.id)).toBe('cancelled');
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('200000');

    const failed = open({ status: 'failed', shopId: SHOP_B, closedAt: new Date(NOW - 60_000), linkError: 'PayOS không tạo được link' });
    await expect(webhook(codeOf(failed), TOPUP_AMOUNT, 'F-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(statusOf(failed.id)).toBe('paid');
  });

  it('[WTS-21] webhook trên creating ⇒ ghi có; markLinkCreated KHÔNG đổi partial/paid về pending nhưng lưu checkoutUrl/qrCode/paymentLinkId (WTP-16)', async () => {
    const paid = open({ status: 'creating', checkoutUrl: null, qrCode: null, paymentLinkId: null });
    await expect(webhook(codeOf(paid), TOPUP_AMOUNT, 'CR-1')).resolves.toMatchObject({ outcome: 'credited' });
    const linked = await fx.settle.markLinkCreated(paid.id, { checkoutUrl: 'https://pay.payos.test/web/x', qrCode: 'QR-X', paymentLinkId: 'plink-x' }, OWNER_A);
    expect(linked.status).toBe('paid');
    expect(linked.checkoutUrl).toBe('https://pay.payos.test/web/x');

    const partial = open({ status: 'creating', checkoutUrl: null, shopId: SHOP_B, payosOrderCode: nextTopupCode() });
    await webhook(codeOf(partial), 100_000, 'CR-2');
    const linkedPartial = await fx.settle.markLinkCreated(partial.id, { checkoutUrl: 'https://pay.payos.test/web/y', qrCode: null, paymentLinkId: null }, OWNER_A);
    expect(linkedPartial.status).toBe('partial');
    expect(linkedPartial.checkoutUrl).toBe('https://pay.payos.test/web/y');
  });

  it('[WTS-22] markLinkFailed: creating ⇒ failed (+linkError cắt 250, closedAt); nếu đã partial (tiền về trước) ⇒ không đổi', async () => {
    const creating = open({ status: 'creating', checkoutUrl: null });
    await fx.settle.markLinkFailed(creating.id, 'x'.repeat(300));
    expect(statusOf(creating.id)).toBe('failed');
    expect(String(fx.topupOf(creating.id)?.linkError)).toHaveLength(250);
    expect(fx.topupOf(creating.id)?.closedAt).toBeInstanceOf(Date);

    const partial = open({ status: 'partial', receivedAmount: 100_000, shopId: SHOP_B });
    await fx.settle.markLinkFailed(partial.id, 'PayOS không tạo được link');
    expect(statusOf(partial.id)).toBe('partial');
  });

  it('[WTS-23] cancel: pending/partial ⇒ cancelled (+cancelledBy, closedAt); creating/paid/expired/cancelled/failed ⇒ 409; khoản shop khác ⇒ 404', async () => {
    const pending = open();
    const row = await fx.settle.cancel(OWNER_A, SHOP_A, pending.id);
    expect(row.status).toBe('cancelled');
    expect(String(row.cancelledBy)).toBe(OWNER_A_ID);
    expect(row.closedAt).toBeInstanceOf(Date);

    const partial = open({ status: 'partial', receivedAmount: 100_000, shopId: SHOP_B });
    await expect(fx.settle.cancel(OWNER_A, SHOP_B, partial.id)).resolves.toMatchObject({ status: 'cancelled' });

    for (const status of ['creating', 'paid', 'expired', 'cancelled', 'failed']) {
      const t = open({ status, shopId: SHOP_A, payosOrderCode: nextTopupCode(), receivedAmount: status === 'paid' ? TOPUP_AMOUNT : 0 });
      const err = await bizError(fx.settle.cancel(OWNER_A, SHOP_A, t.id));
      expect(err.errorCode).toBe(WALLET_ERR.TOPUP_INVALID_STATE);
      expect(err.httpStatus).toBe(HttpStatus.CONFLICT);
    }

    const other = open({ shopId: SHOP_B, payosOrderCode: nextTopupCode() });
    const notFound = await bizError(fx.settle.cancel(OWNER_A, SHOP_A, other.id));
    expect(notFound.errorCode).toBe(WALLET_ERR.TOPUP_NOT_FOUND);
    expect(notFound.httpStatus).toBe(HttpStatus.NOT_FOUND);
  });

  describe('nextStatusAfterMoney — bảng §4.2 (WTS-24)', () => {
    const X = 600_000n;
    const rows: Array<[TopupStatus, string, bigint, TopupStatus]> = [
      [TOPUP_STATUS.CREATING, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.CREATING, 'thiếu', 300_000n, TOPUP_STATUS.PARTIAL],
      [TOPUP_STATUS.CREATING, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PENDING, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PENDING, 'thiếu', 300_000n, TOPUP_STATUS.PARTIAL],
      [TOPUP_STATUS.PENDING, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PARTIAL, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PARTIAL, 'thiếu', 300_000n, TOPUP_STATUS.PARTIAL],
      [TOPUP_STATUS.PARTIAL, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PAID, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PAID, 'thiếu', 300_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PAID, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.EXPIRED, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.EXPIRED, 'thiếu', 300_000n, TOPUP_STATUS.EXPIRED],
      [TOPUP_STATUS.EXPIRED, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.CANCELLED, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.CANCELLED, 'thiếu', 300_000n, TOPUP_STATUS.CANCELLED],
      [TOPUP_STATUS.CANCELLED, 'thừa', 700_000n, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.FAILED, 'đủ', X, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.FAILED, 'thiếu', 300_000n, TOPUP_STATUS.FAILED],
      [TOPUP_STATUS.FAILED, 'thừa', 700_000n, TOPUP_STATUS.PAID],
    ];
    it.each(rows)('[WTS-24] %s · tiền %s ⇒ kế tiếp theo §4.2', (status, _money, received, expected) => {
      expect(nextStatusAfterMoney(status, received, X)).toBe(expected);
    });
  });

  it('[WTS-25] deadlock 40P01 lần đầu ⇒ thử lại CẢ transaction, ghi có đúng MỘT lần; lỗi khác không thử lại ⇒ ném', async () => {
    const t = open();
    fx.engine.failOn(/^shop_cod_topups\.update$/, deadlockError(), 1);
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'DL-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(fx.receiptsOf(t.id)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));

    const u = open({ shopId: SHOP_B, payosOrderCode: nextTopupCode() });
    fx.engine.failOn(/^shop_cod_topups\.update$/, new Error('DB chết'), 1);
    await expect(webhook(codeOf(u), TOPUP_AMOUNT, 'DL-2')).rejects.toThrow('DB chết');
    expect(fx.ledgerOf(SHOP_B)).toHaveLength(0);
  });

  it('[WTS-26] lỗi ở câu update dòng nạp (SAU biên nhận + sổ + ví) ⇒ rollback sạch; gửi lại cùng webhook ⇒ ghi có đúng 1 lần (WTP-30)', async () => {
    const t = open();
    fx.engine.failOn(/^shop_cod_topups\.update$/, new Error('DB chết giữa chừng'), 1);
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'RB-1')).rejects.toThrow('DB chết giữa chừng');
    expect(fx.receiptsOf(t.id)).toHaveLength(0);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(0);
    expect(fx.walletOf(SHOP_A)).toBeUndefined();
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('0');
    expect(statusOf(t.id)).toBe('pending');

    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'RB-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));
  });

  it('[WTS-27] DB giả ném P2002 ở ref_key (bỏ qua kiểm trước) ⇒ transaction rollback, lỗi nổi lên — không ghi nửa chừng', async () => {
    const t = open();
    fx.engine.failOn(/^shop_cod_wallet_transactions\.create$/, p2002(['ref_key']), 1);
    const err = await webhook(codeOf(t), TOPUP_AMOUNT, 'RK-1').catch((e: unknown) => e);
    expect(isPrismaError(err, 'P2002')).toBe(true);
    expect(fx.receiptsOf(t.id)).toHaveLength(0);
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(0);
    expect(String(fx.topupOf(t.id)?.receivedAmount)).toBe('0');
  });

  it('[WTS-28] thông báo: chủ shop (shop.wallet.read) nhận khi ghi có; gọi SAU commit (không tx, 0 giao dịch đang mở); notifier/directory lỗi ⇒ vẫn credited', async () => {
    const t = open();
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'N-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(fx.shops.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP_A, 'shop.wallet.read');
    expect(toOwner()).toHaveLength(1);
    expect((toOwner()[0].cmd.payload as { topupId: string }).topupId).toBe(t.id);
    expect(fx.notifications.every((n) => !n.txGiven && n.openTx === 0)).toBe(true);

    const u = open({ shopId: SHOP_B, payosOrderCode: nextTopupCode() });
    fx.notifyManyFn.mockRejectedValueOnce(new Error('thông báo lỗi'));
    await expect(webhook(codeOf(u), TOPUP_AMOUNT, 'N-2')).resolves.toMatchObject({ outcome: 'credited' });
    expect(String(fx.walletOf(SHOP_B)?.balance)).toBe(String(TOPUP_AMOUNT));

    const v = open({ shopId: SHOP_A, payosOrderCode: nextTopupCode() });
    fx.users.staffUserIdsWithPermission.mockRejectedValueOnce(new Error('danh bạ lỗi'));
    await expect(webhook(codeOf(v), 700_000, 'N-3')).resolves.toMatchObject({ outcome: 'credited' });
    expect(String(fx.topupOf(v.id)?.receivedAmount)).toBe('700000');
  });

  it('[WTS-29] reconcilePending: đúng tập (mở + đuôi 72 giờ expired|cancelled, không failed, không quá 72 giờ), CAS không hỏi trùng, limit, lỗi một dòng không dừng lô, PayOS thiếu cấu hình ⇒ {0,0,0}', async () => {
    const openA = open({ createdAt: new Date(NOW - 3_600_000), payosOrderCode: nextTopupCode() });
    const openB = open({ shopId: SHOP_B, status: 'partial', receivedAmount: 100_000, createdAt: new Date(NOW - 1_800_000), payosOrderCode: nextTopupCode() });
    const tailExpired = open({ status: 'expired', closedAt: new Date(NOW - 3_600_000), payosOrderCode: nextTopupCode() });
    const tailCancelled = open({ status: 'cancelled', shopId: SHOP_B, closedAt: new Date(NOW - 7_200_000), payosOrderCode: nextTopupCode() });
    const tooOld = open({ status: 'expired', shopId: SHOP_B, closedAt: new Date(NOW - 80 * 3_600_000), payosOrderCode: nextTopupCode() });
    const failed = open({ status: 'failed', shopId: SHOP_B, closedAt: new Date(NOW - 3_600_000), payosOrderCode: nextTopupCode() });
    const queried = (): string[] => fx.getLink.mock.calls.map((c) => String(c[0])).sort();
    const expected = [openA, openB, tailExpired, tailCancelled].map((t) => codeOf(t)).sort();

    // Lô đầu: một lần hỏi PayOS lỗi nhưng các dòng khác vẫn được xử lý.
    fx.getLink.mockRejectedValueOnce(new Error('mạng chập chờn'));
    const first = await fx.settle.reconcilePending();
    // checked = số lượt đã thật sự hỏi PayOS và có kết quả: openA lỗi nên không tính; 3 khoản còn lại được tính.
    expect(first.checked).toBe(3);
    expect(queried()).toEqual(expected);
    expect(queried()).not.toContain(codeOf(failed));
    expect(queried()).not.toContain(codeOf(tooOld));

    // Chạy lại ngay: CAS (last_checked_at) chặn hỏi trùng.
    await fx.settle.reconcilePending();
    expect(fx.getLink).toHaveBeenCalledTimes(4);

    // Sau 61 giây: chỉ các khoản còn mở được hỏi lại; đuôi (6 giờ) vẫn bị chặn.
    advanceClock(61_000);
    await fx.settle.reconcilePending();
    expect(fx.getLink).toHaveBeenCalledTimes(6);

    // limit = 1 ⇒ chỉ khoản mở cũ nhất (openA).
    advanceClock(61_000);
    fx.getLink.mockClear();
    await fx.settle.reconcilePending(1);
    expect(queried()).toEqual([codeOf(openA)]);

    // PayOS thiếu cấu hình ⇒ không làm gì.
    const off = buildTopupFixture({ payosConfigured: false });
    off.seedTopup({ shopId: SHOP_A, status: 'pending' });
    await expect(off.settle.reconcilePending()).resolves.toEqual({ checked: 0, credited: 0, closed: 0 });
    expect(off.getLink).not.toHaveBeenCalled();
  });

  it('[WTS-30] shop bị khoá (không còn approved) ⇒ VẪN ghi có (settle không gọi existsApproved) (WTP-19)', async () => {
    const t = open();
    fx.approved.delete(SHOP_A);
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'K-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));
    expect(fx.shops.existsApproved).not.toHaveBeenCalled();
  });

  it('[WTS-31] cờ wallet.payos_deposit_enabled = false KHÔNG ngăn ghi có từ webhook (settle không đọc cờ) (WTP-18)', async () => {
    fx.setting(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED, false);
    const t = open();
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'FLAG-1')).resolves.toMatchObject({ outcome: 'credited' });
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe(String(TOPUP_AMOUNT));
    expect(fx.system.settingBool).not.toHaveBeenCalledWith(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED);
  });

  it('[WTS-32] khoá audit không chứa từ nhạy cảm (kiểm bằng sanitizeSummary trên đúng entry gửi vào audit); audit after giữ received, delta, balanceAfter', async () => {
    const spy = jest.spyOn(fx.audit, 'write');
    const t = open();
    await webhook(codeOf(t), 200_000, 'AU-1');
    const entry = spy.mock.calls.map((c) => c[2]).find((e) => e.action === 'WALLET_TOPUP_CREDITED');
    expect(entry).toBeDefined();
    const after = entry!.after ?? {};
    expect(Object.keys(after)).toEqual(expect.arrayContaining(['received', 'delta', 'balanceAfter']));
    expect(sanitizeSummary(after)).toEqual(after);
    expect(after.delta).toBe('200000');
    expect(after.received).toBe('200000');
    expect(after.balanceAfter).toBe('200000');
  });

  // ---- bổ sung ngoài §9.1 (theo quyết định điều phối viên) ----

  it('[WTS-33] dữ liệu lệch: creditPayosTopup trả credited=false khi received còn thấp hơn mục tiêu ⇒ ném, không ghi lệch', async () => {
    const t = open();
    const wallet = fx.wallet as unknown as { creditPayosTopup: (tx: unknown, input: unknown) => Promise<unknown> };
    const spy = jest.spyOn(wallet, 'creditPayosTopup').mockResolvedValue({ credited: false, balanceAfter: 0n });
    await expect(webhook(codeOf(t), TOPUP_AMOUNT, 'SKEW-1')).rejects.toThrow('dừng để không ghi lệch');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fx.receiptsOf(t.id)).toHaveLength(0);
    expect(statusOf(t.id)).toBe('pending');
  });

  it('[WTS-34] khoản mở vừa ghi có vừa đóng quá hạn ⇒ reconcileOne chỉ báo credited (một outcome), status expired', async () => {
    const t = open({ expiresAt: new Date(NOW - 3 * 60_000) });
    fx.pay(codeOf(t), 100_000, 'BOTH-1');
    await expect(fx.settle.reconcileOne(t.id)).resolves.toBe('credited');
    expect(statusOf(t.id)).toBe('expired');
  });

  it('[WTS-35] parseMoney/receiptRef/targetCumulative được đưa vào đường ghi có (kiểm tích hợp ngắn: số không hợp lệ không tạo khoản)', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(receiptRef(nextTopupCode(), { amount: 1 })).toBeNull();
    expect(targetCumulative(0n, 0n, 0n)).toBe(0n);
  });
});
