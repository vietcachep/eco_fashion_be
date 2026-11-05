import { Logger } from '@nestjs/common';
import { ORDER_AUDIT, ORDER_ERR, ORDER_STATUS, PAYMENT_STATUS } from '../foundation/order.constants';
import { buildHarness, customer, CS_STAFF, csUser, CUSTOMER, D, DAY, mkOrderLike, mkReturn, OK_EVIDENCE, REFUND_ACCOUNT, SHOP, SHOP_STAFF, shopUser, type Harness } from '../../../../test/helpers/return-harness';

/*
 * COD-08 / COD-08b (PLAN-0031 §2.3, PLAN-0040 Tầng 3.6): khách báo "CHƯA NHẬN HÀNG" với đơn COD mà shop đã báo giao (payment COD `paid`, ví shop đã bị trừ hoa hồng).
 * Khách chưa từng trả tiền mặt ⇒ KHÔNG được tạo hoàn tiền cho khách; phải ĐẢO ghi thu (payment về chưa thu, ví shop được trả lại) — cả đường shop duyệt lẫn đường CSKH phân xử.
 * Hoàn tiền cho đổi trả COD HỢP LỆ (khách đã nhận hàng, trả hàng lỗi, shop nhận lại) giữ nguyên. Chạy service THẬT trên kho trong bộ nhớ (test/helpers/return-harness.ts).
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const item = (id: string, orderItemId: string, returnId = 'rr-1') => ({ id, returnId, orderItemId, variantId: `var-${orderItemId}`, name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1, imageUrl: null, unitPrice: D(100_000) });
const NOTE = 'Đối chiếu với hãng vận chuyển: đơn chưa được giao tới khách';

/* Đơn COD shop đã báo giao hôm qua: payment COD paid, ví shop đã bị trừ hoa hồng — nhưng khách khẳng định chưa nhận. */
const codDelivered = (over: Parameters<typeof mkOrderLike>[0] = {}) => mkOrderLike({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.PAID, status: ORDER_STATUS.DELIVERED, ...over });
const notReceived = (over = {}) => mkReturn({ reasonCode: 'not_received', requireReturn: false, reason: 'Chưa nhận được hàng', refundAmount: D(200_000), calculatedRefundAmount: D(200_000), items: [item('i1', 'oi-1'), item('i2', 'oi-2')], ...over });
const escalatedNotReceived = (over = {}) => notReceived({ status: 'escalated', escalatedAt: new Date(), escalateSource: 'customer', escalateReason: 'Shop từ chối nhưng tôi chưa nhận hàng', shopRespondDueAt: null, rejectedBy: 'shop', ...over });

describe('[COD-08b] shop duyệt "chưa nhận hàng" trên đơn COD đã ghi thu ⇒ ĐẢO ghi thu, KHÔNG hoàn tiền', () => {
  it('[COD-08b] payment đảo thu qua cổng reverseCodCollection (khoá đơn trước), KHÔNG gọi requestRefund; yêu cầu → refunded (refundAmount = 0); đơn → returned + paymentStatus unpaid; không nhập kho', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [codDelivered()] });
    const res = await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
    expect(h.refundCalls).toHaveLength(0); // khách chưa từng trả tiền ⇒ không có khoản hoàn
    expect(h.reverseCalls).toHaveLength(1);
    expect(h.reverseCalls[0]).toMatchObject({ orderCode: 'DH260001', shopId: SHOP, actorUserId: SHOP_STAFF });
    expect(h.reverseCalls[0].reason).toContain('Khách chưa nhận hàng');
    expect(h.ret()).toMatchObject({ status: 'refunded', approvedBy: SHOP_STAFF });
    expect(h.ret().refundAmount.toString()).toBe('0');
    expect(h.ret().refundedAt).toBeInstanceOf(Date);
    expect(h.order()).toMatchObject({ status: ORDER_STATUS.RETURNED, paymentStatus: PAYMENT_STATUS.UNPAID });
    expect(h.restocks).toHaveLength(0);
    expect(res).toMatchObject({ status: 'refunded', codReversed: true, refundAmount: { amount: '0' } });
  });

  it('[COD-08b] lịch sử đơn ghi "đảo ghi thu COD, không hoàn tiền"; audit COD_REVERSED + RETURN_APPROVED (refundAmount 0, codReversed); outbox đổi trạng thái; báo khách đúng nội dung (không nhắc hoàn tiền)', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [codDelivered()] });
    await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
    expect(h.histories.map((x) => [x.from, x.to, x.note])).toEqual([[ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED, 'Khách chưa nhận hàng (COD) — shop đồng ý — đảo ghi thu COD, không hoàn tiền']]);
    expect(h.auditActions()).toEqual([ORDER_AUDIT.COD_REVERSED, ORDER_AUDIT.RETURN_APPROVED]);
    expect(h.audits[0]).toMatchObject({ entityCode: 'DH260001', before: { paymentStatus: PAYMENT_STATUS.PAID }, after: expect.objectContaining({ paymentStatus: PAYMENT_STATUS.UNPAID, paymentReversed: true, shopId: SHOP }) as unknown });
    expect(h.audits[1].after).toMatchObject({ refundAmount: '0', codReversed: true });
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:refunded']);
    const note = h.notesTo(CUSTOMER)[0];
    expect(note.title).toBe('Shop đồng ý yêu cầu chưa nhận hàng đơn DH260001');
    expect(note.content).toContain('chưa phải trả');
    expect(note.content).not.toMatch(/đang được hoàn về/);
  });

  it('[COD-08b] shop nhập số tiền hoàn khác (giảm) cũng bị bỏ qua: không có khoản hoàn nào, refundAmount vẫn 0', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [codDelivered()] });
    await h.shopSvc.approve(shopUser, SHOP, 'rr-1', { refundAmount: '150000', adjustReason: 'Trừ phí vận chuyển đã phát sinh' });
    expect(h.refundCalls).toHaveLength(0);
    expect(h.ret().refundAmount.toString()).toBe('0');
    expect(h.ret().adjustReason).toContain('đảo ghi thu');
  });

  it('[COD-08b] KHÔNG đảo hai lần: duyệt lại / CSKH phân xử lại yêu cầu đã refunded ⇒ 409, payment không bị đảo thêm', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [codDelivered()] });
    await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
    await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    expect(h.reverseCalls).toHaveLength(1);
    expect(h.core.isCodReversal(notReceived(), h.order())).toBe(false); // đơn đã unpaid ⇒ không còn điều kiện đảo
  });

  it('[COD-08b] payment từ chối đảo (vd COD đã có hoàn tiền ⇒ 409) ⇒ HOÀN TÁC toàn bộ: vẫn requested, đơn không đổi', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [codDelivered()] });
    h.mocks.payment.reverseCodCollection.mockRejectedValueOnce(new Error('PAYMENT_INVALID_STATE'));
    await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', {})).rejects.toThrow('PAYMENT_INVALID_STATE');
    expect(h.ret().status).toBe('requested');
    expect(h.order()).toMatchObject({ status: ORDER_STATUS.DELIVERED, paymentStatus: PAYMENT_STATUS.PAID });
    expect(h.notes).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

describe('[COD-08b] đường CSKH phân xử (escalated) cũng đi qua luật đảo ghi thu', () => {
  it('[COD-08b] CSKH phân xử "hoàn": đảo ghi thu, KHÔNG refund, bỏ qua refundAmount CSKH nhập; yêu cầu refunded, đơn returned; báo khách + shop; audit RETURN_RESOLVED codReversed', async () => {
    const h = buildHarness({ returns: [escalatedNotReceived()], orders: [codDelivered()] });
    const res = await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '50000' });
    expect(h.refundCalls).toHaveLength(0);
    expect(h.reverseCalls).toHaveLength(1);
    expect(h.reverseCalls[0]).toMatchObject({ orderCode: 'DH260001', shopId: SHOP, actorUserId: CS_STAFF });
    expect(h.reverseCalls[0].reason.endsWith('(sàn phân xử)')).toBe(true);
    expect(h.ret()).toMatchObject({ status: 'refunded', resolveDecision: 'refund', resolveNote: NOTE, resolvedBy: CS_STAFF });
    expect(h.ret().refundAmount.toString()).toBe('0');
    expect(h.order()).toMatchObject({ status: ORDER_STATUS.RETURNED, paymentStatus: PAYMENT_STATUS.UNPAID });
    expect(h.restocks).toHaveLength(0);
    expect(res).toMatchObject({ status: 'refunded', codReversed: true });
    expect(h.notesTo(CUSTOMER)[0].content).toContain('không có khoản hoàn tiền');
    expect(h.notesTo(SHOP_STAFF)[0].content).toContain('hoa hồng đã trừ được trả lại');
    expect(h.auditActions()).toEqual([ORDER_AUDIT.COD_REVERSED, ORDER_AUDIT.RETURN_RESOLVED]);
    expect(h.audits[1].after).toMatchObject({ decision: 'refund', refundAmount: '0', codReversed: true, ignoredRefundAmount: '50000' });
  });

  it('[COD-08b] CSKH phân xử lại sau khi đã đảo ⇒ 409; CSKH TỪ CHỐI lần cuối thì KHÔNG đảo gì (đơn COD vẫn đã ghi thu)', async () => {
    const reject = buildHarness({ returns: [escalatedNotReceived()], orders: [codDelivered()] });
    await reject.adminSvc.resolve(csUser, 'rr-1', { decision: 'reject', note: NOTE });
    expect(reject.ret().status).toBe('rejected');
    expect(reject.reverseCalls).toHaveLength(0);
    expect(reject.order()).toMatchObject({ status: ORDER_STATUS.DELIVERED, paymentStatus: PAYMENT_STATUS.PAID });
    const done = buildHarness({ returns: [escalatedNotReceived()], orders: [codDelivered()] });
    await done.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    await expect(done.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    expect(done.reverseCalls).toHaveLength(1);
  });
});

describe('[COD-08] phạm vi của luật đảo ghi thu: chỉ COD đã ghi thu + not_received', () => {
  it('[COD-08] đơn PayOS "chưa nhận hàng" vẫn HOÀN TIỀN cho khách như cũ — không đảo gì', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null })] });
    await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
    expect(h.reverseCalls).toHaveLength(0);
    expect(h.refundCalls).toHaveLength(1);
    expect(h.refundCalls[0]).toMatchObject({ amount: 200_000n, returnRequestId: 'rr-1' });
    expect(h.ret().status).toBe('received');
    expect(h.ret().refundAmount.toString()).toBe('200000');
  });

  it('[COD-08] đơn COD còn ĐANG GIAO (chưa ghi thu): không có gì để đảo hay hoàn — refunded luôn, không gọi payment', async () => {
    const h = buildHarness({ returns: [notReceived()], orders: [mkOrderLike({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID, status: ORDER_STATUS.SHIPPING, deliveredAt: null })] });
    await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
    expect(h.reverseCalls).toHaveLength(0);
    expect(h.refundCalls).toHaveLength(0);
    expect(h.ret().status).toBe('refunded');
  });

  it('[COD-08] đổi trả COD HỢP LỆ (khách đã nhận hàng, trả hàng lỗi, shop xác nhận nhận lại) VẪN hoàn tiền cho khách bằng tài khoản khách khai và nhập kho — không đảo ghi thu', async () => {
    const account = { ...REFUND_ACCOUNT, accountName: 'NGUYEN VAN A' };
    const approved = mkReturn({ reasonCode: 'defective', status: 'approved', approvedAt: new Date(), refundAccount: account, shopRespondDueAt: null, shipBackDueAt: new Date(Date.now() + DAY), shippedBackAt: new Date() });
    const h = buildHarness({ returns: [approved], orders: [codDelivered()] });
    await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
    expect(h.reverseCalls).toHaveLength(0);
    expect(h.refundCalls).toHaveLength(1);
    expect(h.refundCalls[0]).toMatchObject({ amount: 100_000n, payee: { bankBin: '970422', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' } });
    expect(h.restocks).toHaveLength(1);
    expect(h.order().paymentStatus).toBe(PAYMENT_STATUS.PAID); // đơn COD đã thu thật: ví shop đảo theo tỉ lệ khi khoản hoàn xong (WAL-05), không phải ở đây
  });

  it('[COD-08] mọi lý do KHÁC not_received trên đơn COD đã ghi thu không bao giờ vào nhánh đảo (isCodReversal)', () => {
    const h = buildHarness();
    for (const reasonCode of ['defective', 'wrong_item', 'not_as_described', 'damaged_shipping', 'size_issue', 'changed_mind', 'other']) expect(h.core.isCodReversal({ reasonCode }, codDelivered() as never)).toBe(false);
    expect(h.core.isCodReversal({ reasonCode: 'not_received' }, codDelivered() as never)).toBe(true);
    expect(h.core.isCodReversal({ reasonCode: 'not_received' }, mkOrderLike() as never)).toBe(false); // PayOS
    expect(h.core.isCodReversal({ reasonCode: 'not_received' }, codDelivered({ paymentStatus: PAYMENT_STATUS.PARTIALLY_REFUNDED }) as never)).toBe(false);
  });
});

describe('[COD-08] khách tạo yêu cầu "chưa nhận hàng" cho đơn COD đã báo giao', () => {
  const ask = (h: Harness, over = {}) => h.customerSvc.create(customer, 'DH260001', { reasonCode: 'not_received', reason: undefined, items: undefined, evidence: undefined, ...over });

  it('[COD-08] KHÔNG phải khai tài khoản nhận hoàn (khách chưa trả tiền nên không có khoản hoàn) — trước đây 400 RETURN_REFUND_ACCOUNT_REQUIRED', async () => {
    const h = buildHarness({ orders: [codDelivered()] });
    await expect(ask(h)).resolves.toMatchObject({ requireReturn: false, reasonCode: 'not_received', status: 'requested' });
  });

  it('[COD-08] khách vẫn gửi kèm tài khoản thì KHÔNG lưu (không có gì để chuyển) — response không có refundAccount', async () => {
    const h = buildHarness({ orders: [codDelivered()] });
    const res = await ask(h, { refundAccount: REFUND_ACCOUNT });
    expect(res.refundAccount).toBeNull();
    expect([...h.returns.values()][0].refundAccount).toBeNull();
  });

  it('[COD-08] lý do khác (hàng lỗi…) trên đơn COD đã thu vẫn BẮT BUỘC tài khoản nhận hoàn', async () => {
    const h = buildHarness({ orders: [codDelivered()] });
    await expect(h.customerSvc.create(customer, 'DH260001', { reasonCode: 'defective', reason: 'Hàng lỗi', items: [{ orderItemId: 'oi-1', quantity: 1 }], evidence: OK_EVIDENCE })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_ACCOUNT_REQUIRED });
  });
});
