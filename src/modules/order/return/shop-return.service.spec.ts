import { Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { ORDER_AUDIT, ORDER_ERR, ORDER_STATUS, PAYMENT_STATUS } from '../foundation/order.constants';
import { buildHarness, CS_STAFF, CUSTOMER, D, DAY, mkOrderLike, mkReturn, OK_EVIDENCE, OTHER_SHOP, REFUND_ACCOUNT, SHOP, SHOP_STAFF, shopUser } from '../../../../test/helpers/return-harness';

/*
 * Đổi trả phía SHOP (PLAN-0022): duyệt (cần trả hàng / `not_received` hoàn ngay), từ chối, xác nhận ĐÃ NHẬN LẠI hàng (ok ⇒ nhập kho + hoàn tiền cùng tx; không khớp ⇒ chuyển sàn),
 * cô lập theo shop (shopId từ ngữ cảnh), response không lộ tài khoản ngân hàng của khách.
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const near = (d: Date | null | undefined, ms: number) => d instanceof Date && Math.abs(d.getTime() - (Date.now() + ms)) < 5_000;
/* Tài khoản khách đã khai, đúng như service lưu (tên đã chuẩn hoá không dấu in hoa). */
const STORED_ACCOUNT = { ...REFUND_ACCOUNT, accountName: 'NGUYEN VAN A' };
const ADDRESS = { name: 'Kho Shop An Nhiên', phone: '0901234567', address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh' };
const item = (id: string, orderItemId: string, quantity = 1, returnId = 'rr-1') => ({ id, returnId, orderItemId, variantId: `var-${orderItemId}`, name: 'Áo thun', color: 'Đen', size: 'M', quantity, imageUrl: null, unitPrice: D(100_000) });

describe('ShopReturnService.approve', () => {
  describe('yêu cầu CẦN trả hàng', () => {
    it('requested → approved: lưu địa chỉ trả hàng + hạn khách gửi (7 ngày), tắt hạn shop duyệt; chưa nhập kho, chưa hoàn tiền', async () => {
      const h = buildHarness({ returns: [mkReturn()] });
      const res = await h.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS });
      const row = h.ret();
      expect(row).toMatchObject({ status: 'approved', approvedBy: SHOP_STAFF, processedBy: SHOP_STAFF, shopRespondDueAt: null, adjustReason: null, returnAddress: ADDRESS });
      expect(row.approvedAt).toBeInstanceOf(Date);
      expect(near(row.shipBackDueAt, 7 * DAY)).toBe(true);
      expect(row.refundAmount.toString()).toBe('100000');
      expect(h.restocks).toHaveLength(0);
      expect(h.refundCalls).toHaveLength(0);
      expect(res).toMatchObject({ status: 'approved', returnAddress: ADDRESS, deadlineKind: 'ship_back', canShipBack: true, refundAccount: null });
      expect(res.suggestedReturnAddress).toEqual(ADDRESS);
    });

    it('báo KHÁCH kèm địa chỉ gửi trả; audit RETURN_APPROVED; outbox đổi trạng thái; không báo CSKH', async () => {
      const h = buildHarness({ returns: [mkReturn()] });
      await h.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS });
      const note = h.notesTo(CUSTOMER)[0];
      expect(note.title).toBe('Shop đã duyệt yêu cầu đổi trả đơn DH260001');
      expect(note.content).toContain(ADDRESS.address);
      expect(note.content).toContain('trong 7 ngày');
      expect(h.notesTo(CS_STAFF)).toHaveLength(0);
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_APPROVED]);
      expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:approved']);
    });

    it('thiếu địa chỉ và shop chưa từng khai ⇒ RETURN_ADDRESS_REQUIRED; lần sau lấy lại địa chỉ gần nhất', async () => {
      const none = buildHarness({ returns: [mkReturn()] });
      await expect(none.shopSvc.approve(shopUser, SHOP, 'rr-1', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_ADDRESS_REQUIRED });
      expect(none.ret().status).toBe('requested');

      const old = mkReturn({ id: 'rr-old', status: 'received', requireReturn: true, approvedAt: new Date(Date.now() - 5 * DAY), returnAddress: ADDRESS });
      const again = buildHarness({ returns: [old, mkReturn({ id: 'rr-2' })] });
      await again.shopSvc.approve(shopUser, SHOP, 'rr-2', {});
      expect(again.ret('rr-2').returnAddress).toEqual(ADDRESS);
    });

    it('số tiền hoàn chỉ được GIẢM và phải kèm lý do; bằng số tính sẵn thì không cần lý do', async () => {
      const lower = buildHarness({ returns: [mkReturn()] });
      const res = await lower.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS, refundAmount: '80000', adjustReason: 'Hàng đã mở hộp, trừ 20%' });
      expect(lower.ret()).toMatchObject({ adjustReason: 'Hàng đã mở hộp, trừ 20%' });
      expect(lower.ret().refundAmount.toString()).toBe('80000');
      expect(res.refundAmount.amount).toBe('80000');
      expect(res.calculatedRefundAmount.amount).toBe('100000'); // số hệ thống tính vẫn giữ để đối chiếu

      const noReason = buildHarness({ returns: [mkReturn()] });
      await expect(noReason.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS, refundAmount: '80000' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_ADJUST_REASON_REQUIRED });
      const higher = buildHarness({ returns: [mkReturn()] });
      await expect(higher.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS, refundAmount: '100001', adjustReason: 'tăng thêm một đồng' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_TOO_HIGH });
      const same = buildHarness({ returns: [mkReturn()] });
      await same.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS, refundAmount: '100000' });
      expect(same.ret().adjustReason).toBeNull();
      for (const h of [noReason, higher]) expect(h.ret().status).toBe('requested'); // lỗi ⇒ không đổi gì
    });
  });

  describe('lý do "chưa nhận hàng" (không cần trả hàng)', () => {
    const notReceived = (over = {}) => mkReturn({ reasonCode: 'not_received', requireReturn: false, refundAmount: D(200_000), calculatedRefundAmount: D(200_000), items: [item('i1', 'oi-1'), item('i2', 'oi-2')], ...over });
    const shipping = (over: Parameters<typeof mkOrderLike>[0] = {}) => mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null, ...over });

    it('duyệt ⇒ vào THẲNG received: yêu cầu hoàn tiền ngay (kèm tài khoản khách khai), KHÔNG nhập kho; hoàn hết ⇒ đơn → returned', async () => {
      const h = buildHarness({ returns: [notReceived({ refundAccount: STORED_ACCOUNT })], orders: [shipping()] });
      const res = await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
      expect(h.ret()).toMatchObject({ status: 'received', approvedBy: SHOP_STAFF, shopRespondDueAt: null, receivedAt: null });
      expect(h.restocks).toHaveLength(0);
      expect(h.refundCalls).toEqual([{ orderCode: 'DH260001', shopId: SHOP, amount: 200_000n, reason: 'Đổi trả: Không vừa size', returnRequestId: 'rr-1', actorUserId: SHOP_STAFF, payee: { bankBin: '970422', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' } }]);
      expect(h.order().status).toBe(ORDER_STATUS.RETURNED);
      expect(h.histories.map((x) => x.to)).toEqual([ORDER_STATUS.RETURNED]);
      expect(res.status).toBe('received');
      expect(h.notesTo(CUSTOMER)[0].title).toBe('Shop đồng ý hoàn tiền đơn DH260001');
      expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:received']);
    });

    it('đơn chưa thu tiền (COD đang giao) ⇒ không có gì để hoàn: sang refunded luôn, không gọi payment', async () => {
      const h = buildHarness({ returns: [notReceived()], orders: [shipping({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID })] });
      await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
      expect(h.ret().status).toBe('refunded');
      expect(h.ret().refundedAt).toBeInstanceOf(Date);
      expect(h.refundCalls).toHaveLength(0);
    });

    it('payment báo không có khoản đã thu để hoàn (refundId = null) ⇒ refunded', async () => {
      const h = buildHarness({ returns: [notReceived()], orders: [shipping()] });
      h.control.refundId = null;
      await h.shopSvc.approve(shopUser, SHOP, 'rr-1', {});
      expect(h.ret().status).toBe('refunded');
      expect(h.refundCalls).toHaveLength(1);
    });

    it('shop giảm số tiền (có lý do) ⇒ hoàn đúng số đã giảm; đơn vẫn chỉ → returned khi đã hoàn hết SỐ LƯỢNG', async () => {
      const h = buildHarness({ returns: [notReceived()], orders: [shipping()] });
      await h.shopSvc.approve(shopUser, SHOP, 'rr-1', { refundAmount: '150000', adjustReason: 'Trừ phí vận chuyển đã phát sinh' });
      expect(h.refundCalls[0].amount).toBe(150_000n);
      expect(h.order().status).toBe(ORDER_STATUS.RETURNED);
    });

    it('không cần địa chỉ trả hàng', async () => {
      const h = buildHarness({ returns: [notReceived()], orders: [shipping()] });
      await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', {})).resolves.toMatchObject({ requireReturn: false, returnAddress: null });
    });

    it('payment từ chối hoàn (vượt phần còn lại) ⇒ lỗi và HOÀN TÁC toàn bộ (vẫn requested, đơn không đổi)', async () => {
      const h = buildHarness({ returns: [notReceived()], orders: [shipping()] });
      h.mocks.payment.requestRefund.mockRejectedValueOnce(new Error('REFUND_EXCEEDS'));
      await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', {})).rejects.toThrow('REFUND_EXCEEDS');
      expect(h.ret().status).toBe('requested');
      expect(h.order().status).toBe(ORDER_STATUS.SHIPPING);
      expect(h.notes).toHaveLength(0);
    });
  });

  it('chỉ duyệt được yêu cầu requested của CHÍNH shop (shop khác ⇒ 404 không lộ tồn tại)', async () => {
    for (const status of ['approved', 'rejected', 'escalated', 'received', 'refunded', 'cancelled', 'expired']) {
      const h = buildHarness({ returns: [mkReturn({ status })] });
      await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    }
    const h = buildHarness({ returns: [mkReturn()] });
    await expect(h.shopSvc.approve(shopUser, OTHER_SHOP, 'rr-1', { returnAddress: ADDRESS })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.ret().status).toBe('requested');
  });

  it('có người xử lý trước giữa lúc đọc và ghi (compare-and-set thất bại) ⇒ 409, hoàn tác', async () => {
    const h = buildHarness({ returns: [mkReturn()] });
    h.mocks.returnRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE, httpStatus: 409 });
    expect(h.notes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});

describe('ShopReturnService — hạn chót đọc từ setting được kẹp & lý do gửi payment ≤ 255', () => {
  it('approve: return.ship_back_days = 0 ⇒ 1 ngày; quá lớn ⇒ 365 ngày', async () => {
    const zero = buildHarness({ returns: [mkReturn()], settings: { 'return.ship_back_days': 0 } });
    await zero.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS });
    expect(near(zero.ret().shipBackDueAt, DAY)).toBe(true);
    const huge = buildHarness({ returns: [mkReturn()], settings: { 'return.ship_back_days': 1e9 } });
    await huge.shopSvc.approve(shopUser, SHOP, 'rr-1', { returnAddress: ADDRESS });
    expect(near(huge.ret().shipBackDueAt, 365 * DAY)).toBe(true);
  });

  it('reject: return.escalate_days = -1/NaN ⇒ kẹp (1 ngày / mặc định 3 ngày), không bao giờ Invalid Date', async () => {
    const neg = buildHarness({ returns: [mkReturn()], settings: { 'return.escalate_days': -1 } });
    await neg.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: 'Không đúng điều kiện đổi trả' });
    expect(near(neg.ret().escalateDueAt, DAY)).toBe(true);
    const nan = buildHarness({ returns: [mkReturn()], settings: { 'return.escalate_days': Number.NaN } });
    await nan.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: 'Không đúng điều kiện đổi trả' });
    expect(near(nan.ret().escalateDueAt, 3 * DAY)).toBe(true);
  });

  it('lý do khách dài 255 ký tự ⇒ lý do gửi payment vẫn ≤ 255 và giữ tiền tố "Đổi trả: "', async () => {
    const h = buildHarness({ returns: [approved({ reason: 'y'.repeat(255) })] });
    await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
    expect(h.refundCalls[0].reason).toHaveLength(255);
    expect(h.refundCalls[0].reason.startsWith('Đổi trả: y')).toBe(true);
  });

  const approved = (over = {}) => mkReturn({ status: 'approved', approvedAt: new Date(), shopRespondDueAt: null, shipBackDueAt: new Date(Date.now() + DAY), returnAddress: ADDRESS, ...over });
});

describe('ShopReturnService.reject', () => {
  it('requested → rejected (bởi shop): lý do + minh chứng, mở hạn khiếu nại 3 ngày, báo khách; khách khiếu nại được', async () => {
    const h = buildHarness({ returns: [mkReturn()] });
    const res = await h.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: ' Hàng đã qua sử dụng, không đúng điều kiện ', evidence: OK_EVIDENCE });
    expect(h.ret()).toMatchObject({ status: 'rejected', rejectedBy: 'shop', rejectReason: 'Hàng đã qua sử dụng, không đúng điều kiện', processedBy: SHOP_STAFF, shopRespondDueAt: null });
    expect(h.ret().rejectEvidence).toEqual(OK_EVIDENCE.map((e) => ({ ...e })));
    expect(near(h.ret().escalateDueAt, 3 * DAY)).toBe(true);
    expect(res).toMatchObject({ status: 'rejected', rejectedBy: 'shop', canEscalate: true, canCancel: false, deadlineKind: 'escalate', rejectReason: 'Hàng đã qua sử dụng, không đúng điều kiện' });
    expect(h.notesTo(CUSTOMER)[0].title).toBe('Yêu cầu đổi trả đơn DH260001 bị shop từ chối');
    expect(h.notesTo(CUSTOMER)[0].content).toContain('khiếu nại lên sàn trong 3 ngày');
    expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_REJECTED]);
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:rejected']);
  });

  it('lý do < 10 ký tự ⇒ lỗi xác thực; minh chứng ngoài kho upload ⇒ RETURN_EVIDENCE_INVALID; không ghi gì', async () => {
    const h = buildHarness({ returns: [mkReturn()] });
    await expect(h.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: 'ngắn quá' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    await expect(h.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: 'Không đúng điều kiện đổi trả', evidence: [{ type: 'image', url: 'https://evil.example.com/a.jpg', name: 'a.jpg' }] })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_EVIDENCE_INVALID });
    expect(h.ret().status).toBe('requested');
    expect(h.mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('chỉ từ chối requested của chính shop', async () => {
    const h = buildHarness({ returns: [mkReturn({ status: 'approved' })] });
    await expect(h.shopSvc.reject(shopUser, SHOP, 'rr-1', { reason: 'Không đúng điều kiện đổi trả' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    await expect(buildHarness({ returns: [mkReturn()] }).shopSvc.reject(shopUser, OTHER_SHOP, 'rr-1', { reason: 'Không đúng điều kiện đổi trả' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ShopReturnService.receive', () => {
  const approved = (over = {}) => mkReturn({ status: 'approved', approvedAt: new Date(), shopRespondDueAt: null, shipBackDueAt: new Date(Date.now() + DAY), returnAddress: ADDRESS, ...over });
  const shipped = (over = {}) => approved({ shippedBackAt: new Date(), carrier: 'GHN', trackingCode: 'GHN1', shipBackDueAt: null, shopReceiveDueAt: new Date(Date.now() + 3 * DAY), ...over });

  describe('hàng nhận về ĐÚNG (ok)', () => {
    it('nhập kho + yêu cầu hoàn tiền (kèm tài khoản COD) + received, CÙNG transaction; trả một phần ⇒ đơn chưa returned', async () => {
      const h = buildHarness({ returns: [shipped({ refundAccount: STORED_ACCOUNT })], orders: [mkOrderLike({ paymentMethodCode: 'cod' })] });
      const res = await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok', note: ' hàng đủ ', evidence: OK_EVIDENCE });
      expect(h.ret()).toMatchObject({ status: 'received', receivedBy: SHOP_STAFF, receivedCondition: 'ok', receivedNote: 'hàng đủ', shopReceiveDueAt: null, shipBackDueAt: null });
      expect(h.ret().receivedAt).toBeInstanceOf(Date);
      expect(h.restocks).toEqual([{ lines: [{ variantId: 'var-1', quantity: 1 }], ref: { type: 'return', id: 'DH260001' } }]);
      expect(h.refundCalls).toEqual([{ orderCode: 'DH260001', shopId: SHOP, amount: 100_000n, reason: 'Đổi trả: Không vừa size', returnRequestId: 'rr-1', actorUserId: SHOP_STAFF, payee: { bankBin: '970422', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' } }]);
      expect(h.order().status).toBe(ORDER_STATUS.DELIVERED); // mới trả 1/2 món
      expect(h.histories[0].note).toBe('Shop đã nhận lại hàng đổi trả một phần — hoàn 100.000 ₫');
      expect(res).toMatchObject({ status: 'received', receivedCondition: 'ok', refundAccount: null });
      expect(h.notesTo(CUSTOMER)[0]).toMatchObject({ title: 'Shop đã nhận lại hàng đơn DH260001', content: 'Khoản 100.000 ₫ đang được hoàn về bạn.' });
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_RECEIVED]);
      expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:received']);
    });

    it('trả HẾT số lượng của đơn ⇒ đơn → returned (cộng cả các lần trả trước)', async () => {
      const earlier = mkReturn({ id: 'rr-0', status: 'refunded', refundedAt: new Date(), items: [item('x', 'oi-2', 1, 'rr-0')] });
      const h = buildHarness({ returns: [earlier, shipped()] });
      await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
      expect(h.order().status).toBe(ORDER_STATUS.RETURNED);
      expect(h.histories[0]).toMatchObject({ from: ORDER_STATUS.DELIVERED, to: ORDER_STATUS.RETURNED });
    });

    it('chưa báo gửi hàng mà hàng đã về vẫn xác nhận được (shop thấy hàng thật)', async () => {
      const h = buildHarness({ returns: [approved()] });
      await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
      expect(h.ret().status).toBe('received');
    });

    it('đơn chưa thu tiền ⇒ vẫn nhập kho nhưng không gọi payment, sang refunded; refundId = null ⇒ refunded', async () => {
      const unpaid = buildHarness({ returns: [shipped()], orders: [mkOrderLike({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID })] });
      await unpaid.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
      expect(unpaid.ret().status).toBe('refunded');
      expect(unpaid.restocks).toHaveLength(1);
      expect(unpaid.refundCalls).toHaveLength(0);
      const none = buildHarness({ returns: [shipped()] });
      none.control.refundId = null;
      await none.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
      expect(none.ret().status).toBe('refunded');
    });

    it('lỗi khi yêu cầu hoàn tiền ⇒ HOÀN TÁC cả nhập kho (vẫn approved, không ghi kho, không thông báo)', async () => {
      const h = buildHarness({ returns: [shipped()] });
      h.mocks.payment.requestRefund.mockRejectedValueOnce(new Error('REFUND_EXCEEDS'));
      await expect(h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' })).rejects.toThrow('REFUND_EXCEEDS');
      expect(h.ret().status).toBe('approved');
      expect(h.restocks).toHaveLength(0);
      expect(h.notes).toHaveLength(0);
      expect(h.order().status).toBe(ORDER_STATUS.DELIVERED);
    });

    it('số tiền hoàn = số shop đã duyệt (đã giảm), không phải số tính sẵn', async () => {
      const h = buildHarness({ returns: [shipped({ refundAmount: D(80_000), adjustReason: 'Trừ 20%' })] });
      await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' });
      expect(h.refundCalls[0].amount).toBe(80_000n);
    });
  });

  describe('hàng KHÔNG KHỚP', () => {
    it('chuyển sàn phân xử (escalated, shop_not_matching): ghi nhận đã nhận nhưng KHÔNG nhập kho, KHÔNG hoàn; báo CSKH + shop + khách', async () => {
      const h = buildHarness({ returns: [shipped()] });
      const res = await h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'not_matching', note: 'Hàng nhận về là áo khác, không phải mã đã bán', evidence: OK_EVIDENCE });
      expect(h.ret()).toMatchObject({ status: 'escalated', escalateSource: 'shop_not_matching', receivedCondition: 'not_matching', receivedBy: SHOP_STAFF, shopReceiveDueAt: null });
      expect(h.ret().receivedAt).toBeInstanceOf(Date);
      expect(h.ret().escalateReason).toBe('Hàng nhận về là áo khác, không phải mã đã bán');
      expect(h.restocks).toHaveLength(0);
      expect(h.refundCalls).toHaveLength(0);
      expect(res).toMatchObject({ status: 'escalated', escalateSource: 'shop_not_matching', receivedCondition: 'not_matching' });
      expect(h.notesTo(CS_STAFF)).toHaveLength(1);
      expect(h.notesTo(SHOP_STAFF)).toHaveLength(1);
      expect(h.notesTo(CUSTOMER)).toHaveLength(1);
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_RECEIVED, ORDER_AUDIT.RETURN_ESCALATED]);
    });

    it('bắt buộc mô tả ≥ 10 ký tự', async () => {
      const h = buildHarness({ returns: [shipped()] });
      await expect(h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'not_matching', note: 'sai' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
      await expect(h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'not_matching' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
      expect(h.ret().status).toBe('approved');
    });
  });

  it('chỉ khi approved + cần trả hàng; minh chứng ngoài kho ⇒ RETURN_EVIDENCE_INVALID; shop khác ⇒ 404', async () => {
    for (const over of [{ status: 'requested' }, { status: 'escalated' }, { status: 'received' }, { requireReturn: false }]) {
      const h = buildHarness({ returns: [shipped(over)] });
      await expect(h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    }
    const h = buildHarness({ returns: [shipped()] });
    await expect(h.shopSvc.receive(shopUser, SHOP, 'rr-1', { condition: 'ok', evidence: [{ type: 'image', url: 'http://x.test/a.jpg', name: 'a' }] })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_EVIDENCE_INVALID });
    await expect(h.shopSvc.receive(shopUser, OTHER_SHOP, 'rr-1', { condition: 'ok' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.restocks).toHaveLength(0);
  });
});

describe('ShopReturnService.list / get — cô lập theo shop, vendor DTO', () => {
  const rows = [
    mkReturn({ id: 'a', status: 'requested' }),
    mkReturn({ id: 'b', status: 'approved', refundAccount: STORED_ACCOUNT, resolvedBy: 'staff-9', returnAddress: ADDRESS }),
    mkReturn({ id: 'c', shopId: OTHER_SHOP, status: 'requested' }),
  ];

  it('danh sách chỉ của shop mình, lọc theo trạng thái, phân trang server', async () => {
    const h = buildHarness({ returns: rows });
    const all = await h.shopSvc.list(SHOP, undefined, 1, 20);
    expect(all.content.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(all.totalElements).toBe(2);
    expect((await h.shopSvc.list(SHOP, 'approved', 1, 20)).content.map((r) => r.id)).toEqual(['b']);
    expect((await h.shopSvc.list(SHOP, undefined, 2, 1)).content).toHaveLength(1);
    expect((await h.shopSvc.list(OTHER_SHOP, undefined, 1, 20)).content.map((r) => r.id)).toEqual(['c']);
  });

  it('KHÔNG lộ tài khoản ngân hàng của khách và id nhân viên sàn; get shop khác ⇒ 404', async () => {
    const h = buildHarness({ returns: rows });
    const detail = await h.shopSvc.get(SHOP, 'b');
    expect(detail.refundAccount).toBeNull();
    expect(detail.resolvedBy).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('0123456789');
    const list = await h.shopSvc.list(SHOP, 'approved', 1, 20);
    expect(list.content[0].refundAccount).toBeNull();
    await expect(h.shopSvc.get(OTHER_SHOP, 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('một lần tra tên shop + một lần refundSummaries cho cả trang (không N+1)', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'r1', status: 'received' }), mkReturn({ id: 'r2', orderCode: 'DH260002', status: 'refunded' }), mkReturn({ id: 'r3' })] });
    h.refundSummaryMap.set('DH260002', { status: 'done', amount: 100_000n });
    const page = await h.shopSvc.list(SHOP, undefined, 1, 20);
    expect(h.mocks.shops.findManyBrief).toHaveBeenCalledTimes(1);
    expect(h.mocks.payment.refundSummaries).toHaveBeenCalledTimes(1);
    expect(page.content.find((r) => r.id === 'r2')?.refund).toMatchObject({ status: 'done' });
    expect(page.content.find((r) => r.id === 'r3')?.refund).toBeNull();
  });
});
