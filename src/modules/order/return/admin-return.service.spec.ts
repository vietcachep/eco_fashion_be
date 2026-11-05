import { Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { ORDER_AUDIT, ORDER_ERR, ORDER_STATUS, PAYMENT_STATUS } from '../foundation/order.constants';
import { AdminOrderController } from '../order/controller/order.controllers';
import { buildHarness, CS_STAFF, csUser, CUSTOMER, customer, D, mkOrderLike, mkReturn, OTHER_SHOP, SHOP, SHOP_STAFF, type Harness } from '../../../../test/helpers/return-harness';
import { AdminReturnController } from './controller/return.controllers';

/*
 * Sàn PHÂN XỬ đổi trả (PLAN-0022): chỉ yêu cầu `escalated`; hoàn tiền (nhập kho CHỈ khi shop đã nhận hàng, trần số tiền, đơn → returned) hoặc từ chối lần cuối
 * (khách không khiếu nại lại). `note` bắt buộc. Endpoint `process` kiểu cũ đã bị xoá.
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const STORED_ACCOUNT = { bankBin: '970422', bankName: 'MB Bank', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' };
const NOTE = 'Đã xem ảnh minh chứng: hàng lỗi sản xuất, hoàn tiền cho khách';
const item = (id: string, orderItemId: string, returnId = 'rr-1') => ({ id, returnId, orderItemId, variantId: `var-${orderItemId}`, name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1, imageUrl: null, unitPrice: D(100_000) });
/* Yêu cầu đã chuyển sàn: nguồn mặc định = shop quá hạn (shop CHƯA nhận hàng). */
const escalated = (over = {}) => mkReturn({ status: 'escalated', escalatedAt: new Date(), escalateSource: 'shop_timeout', escalateReason: 'Shop không phản hồi', shopRespondDueAt: null, ...over });

describe('AdminReturnService.resolve — hoàn tiền', () => {
  it('shop CHƯA nhận hàng (quá hạn duyệt): hoàn tiền, KHÔNG nhập kho; received + dấu phân xử + báo khách và shop', async () => {
    const h = buildHarness({ returns: [escalated({ refundAccount: STORED_ACCOUNT })] });
    const res = await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: ` ${NOTE} ` });
    expect(h.ret()).toMatchObject({ status: 'received', resolveDecision: 'refund', resolveNote: NOTE, resolvedBy: CS_STAFF, processedBy: CS_STAFF, adjustReason: null, escalateDueAt: null });
    expect(h.ret().resolvedAt).toBeInstanceOf(Date);
    expect(h.restocks).toHaveLength(0);
    expect(h.refundCalls).toEqual([{ orderCode: 'DH260001', shopId: SHOP, amount: 100_000n, reason: 'Đổi trả: Không vừa size (sàn phân xử)', returnRequestId: 'rr-1', actorUserId: CS_STAFF, payee: { bankBin: '970422', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' } }]);
    expect(res).toMatchObject({ status: 'received', resolveDecision: 'refund', resolveNote: NOTE, resolvedBy: CS_STAFF });
    expect(h.notesTo(CUSTOMER)[0]).toMatchObject({ title: 'Sàn đã phân xử yêu cầu đổi trả đơn DH260001' });
    expect(h.notesTo(CUSTOMER)[0].content).toContain('hoàn 100.000 ₫');
    expect(h.notesTo(SHOP_STAFF)[0]).toMatchObject({ title: 'Sàn đã phân xử đổi trả đơn DH260001' });
    expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_RESOLVED]);
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:received']);
  });

  it('hàng về nhưng shop báo KHÔNG KHỚP/hỏng: hoàn tiền nhưng KHÔNG nhập kho (không cộng tồn bán được)', async () => {
    const h = buildHarness({ returns: [escalated({ escalateSource: 'shop_not_matching', receivedAt: new Date(), receivedCondition: 'not_matching' })] });
    await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    expect(h.restocks).toHaveLength(0);
    expect(h.refundCalls).toHaveLength(1);
    expect(h.ret().status).toBe('received');
  });

  it('shop đã nhận hàng và hàng KHÔNG bị báo không khớp (receivedAt có, condition ok/trống) ⇒ nhập kho lại', async () => {
    for (const receivedCondition of ['ok', null]) {
      const h = buildHarness({ returns: [escalated({ escalateSource: 'shop_receive_timeout', receivedAt: new Date(), receivedCondition })] });
      await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
      expect(h.restocks).toEqual([{ lines: [{ variantId: 'var-1', quantity: 1 }], ref: { type: 'return', id: 'DH260001' } }]);
    }
  });

  it('lý do gửi payment ≤ 255 ký tự: cắt PHẦN LÝ DO, giữ nguyên tiền tố "Đổi trả: " và hậu tố " (sàn phân xử)"', async () => {
    const h = buildHarness({ returns: [escalated({ reason: 'x'.repeat(255) })] });
    await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    const reason = h.refundCalls[0].reason;
    expect(reason).toHaveLength(255);
    expect(reason.startsWith('Đổi trả: x')).toBe(true);
    expect(reason.endsWith(' (sàn phân xử)')).toBe(true);
  });

  it('yêu cầu không cần trả hàng (not_received) không bao giờ nhập kho dù có receivedAt', async () => {
    const h = buildHarness({ returns: [escalated({ requireReturn: false, reasonCode: 'not_received', receivedAt: new Date() })] });
    await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    expect(h.restocks).toHaveLength(0);
  });

  it('hoàn hết số lượng của đơn ⇒ đơn → returned (kể cả khi chưa nhập kho)', async () => {
    const h = buildHarness({ returns: [escalated({ items: [item('i1', 'oi-1'), item('i2', 'oi-2')], refundAmount: D(200_000) })] });
    await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    expect(h.order().status).toBe(ORDER_STATUS.RETURNED);
  });

  describe('trần số tiền: ≤ tổng đơn − đã hoàn ở các yêu cầu khác', () => {
    it('nâng số tiền lên trong trần ⇒ được, lưu lý do chỉnh = ghi chú phân xử', async () => {
      const h = buildHarness({ returns: [escalated({ refundAmount: D(80_000) })] });
      await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '120000' });
      expect(h.ret().refundAmount.toString()).toBe('120000');
      expect(h.ret().adjustReason).toBe(NOTE);
      expect(h.refundCalls[0].amount).toBe(120_000n);
    });

    it('vượt tổng đơn (200.000) hoặc vượt phần còn lại sau các lần hoàn khác ⇒ RETURN_REFUND_TOO_HIGH, không ghi gì', async () => {
      const over = buildHarness({ returns: [escalated()] });
      await expect(over.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '200001' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_TOO_HIGH });
      const other = mkReturn({ id: 'rr-0', status: 'refunded', refundAmount: D(150_000), items: [item('x', 'oi-2', 'rr-0')] });
      const partial = buildHarness({ returns: [other, escalated()] });
      await expect(partial.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '60000' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_TOO_HIGH });
      await partial.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '50000' }); // còn đúng 50.000
      expect(partial.ret().refundAmount.toString()).toBe('50000');
      for (const h of [over]) {
        expect(h.ret().status).toBe('escalated');
        expect(h.refundCalls).toHaveLength(0);
      }
    });

    it('số tiền ≤ 0 ⇒ RETURN_REFUND_TOO_HIGH', async () => {
      const h = buildHarness({ returns: [escalated()] });
      await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE, refundAmount: '0' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_TOO_HIGH });
    });
  });

  it('đơn chưa thu tiền (COD) hoặc không có khoản đã thu để hoàn ⇒ refunded luôn, không gọi payment', async () => {
    const unpaid = buildHarness({ returns: [escalated()], orders: [mkOrderLike({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID })] });
    await unpaid.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    expect(unpaid.ret().status).toBe('refunded');
    expect(unpaid.refundCalls).toHaveLength(0);
    const none = buildHarness({ returns: [escalated()] });
    none.control.refundId = null;
    await none.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    expect(none.ret().status).toBe('refunded');
  });

  it('payment từ chối ⇒ lỗi + hoàn tác (vẫn escalated, kho không đổi)', async () => {
    const h = buildHarness({ returns: [escalated({ receivedAt: new Date() })] });
    h.mocks.payment.requestRefund.mockRejectedValueOnce(new Error('REFUND_EXCEEDS'));
    await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE })).rejects.toThrow('REFUND_EXCEEDS');
    expect(h.ret().status).toBe('escalated');
    expect(h.restocks).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });
});

describe('AdminReturnService.resolve — từ chối lần cuối', () => {
  it('escalated → rejected (bởi SÀN): đóng yêu cầu, không tiền/kho, báo khách + shop; khách không khiếu nại lại được', async () => {
    const h = buildHarness({ returns: [escalated({ rejectedBy: 'shop', rejectReason: 'Hàng đã dùng' })] });
    const res = await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'reject', note: 'Ảnh minh chứng không cho thấy lỗi, giữ quyết định của shop' });
    expect(h.ret()).toMatchObject({ status: 'rejected', rejectedBy: 'platform', resolveDecision: 'reject', resolvedBy: CS_STAFF, rejectReason: 'Hàng đã dùng' });
    expect(h.ret().closedAt).toBeInstanceOf(Date);
    expect(h.refundCalls).toHaveLength(0);
    expect(h.restocks).toHaveLength(0);
    expect(res).toMatchObject({ status: 'rejected', rejectedBy: 'platform', canEscalate: false, deadlineKind: null });
    expect(h.notesTo(CUSTOMER)[0].content).toContain('bị từ chối');
    expect(h.notesTo(SHOP_STAFF)).toHaveLength(1);
    await expect(h.customerSvc.escalate(customer, 'rr-1', 'Tôi vẫn không đồng ý')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
  });

  it('từ chối thì không có refundAmount', async () => {
    const h = buildHarness({ returns: [escalated()] });
    await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'reject', note: NOTE, refundAmount: '1000' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
  });
});

describe('AdminReturnService — điều kiện chung', () => {
  it('chỉ phân xử yêu cầu ĐÃ CHUYỂN SÀN: requested/approved/rejected/received/... ⇒ INVALID_STATE (sàn không duyệt/từ chối thay shop)', async () => {
    for (const status of ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled', 'expired']) {
      const h = buildHarness({ returns: [mkReturn({ status })] });
      for (const decision of ['refund', 'reject']) await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision, note: NOTE })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
      expect(h.ret().status).toBe(status);
    }
  });

  it('yêu cầu không tồn tại ⇒ 404; ghi chú phân xử bắt buộc (≥ 5 ký tự)', async () => {
    const h = buildHarness({ returns: [escalated()] });
    await expect(h.adminSvc.resolve(csUser, 'khong-co', { decision: 'refund', note: NOTE })).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: '   ' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(h.ret().status).toBe('escalated');
  });

  it('phân xử hai lần: lần hai thấy đã xử lý (không hoàn hai lần)', async () => {
    const h = buildHarness({ returns: [escalated()] });
    await h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE });
    await expect(h.adminSvc.resolve(csUser, 'rr-1', { decision: 'refund', note: NOTE })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    expect(h.refundCalls).toHaveLength(1);
  });

  describe('list / get', () => {
    const rows = (): Harness => buildHarness({ returns: [escalated({ id: 'a', refundAccount: STORED_ACCOUNT, resolvedBy: CS_STAFF }), mkReturn({ id: 'b' }), mkReturn({ id: 'c', shopId: OTHER_SHOP, status: 'escalated' })] });

    it('lọc theo status và shopId, phân trang; response của sàn có tài khoản đã che + id người phân xử', async () => {
      const h = rows();
      expect((await h.adminSvc.list(1, 20)).content).toHaveLength(3);
      expect((await h.adminSvc.list(1, 20, 'escalated')).content.map((r) => r.id).sort()).toEqual(['a', 'c']);
      expect((await h.adminSvc.list(1, 20, 'escalated', OTHER_SHOP)).content.map((r) => r.id)).toEqual(['c']);
      expect((await h.adminSvc.list(1, 20, undefined, SHOP)).totalElements).toBe(2);
      const a = await h.adminSvc.get('a');
      expect(a.refundAccount).toEqual({ bankBin: '970422', bankName: 'MB Bank', accountNumberMasked: '****6789', accountName: 'NGUYEN VAN A' });
      expect(a.resolvedBy).toBe(CS_STAFF);
      expect(JSON.stringify(a)).not.toContain('0123456789');
      await expect(h.adminSvc.get('khong-co')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('route sàn', () => {
  it('endpoint `process` kiểu cũ đã bị XOÁ; có resolve + list + get', () => {
    expect(Object.getOwnPropertyNames(AdminOrderController.prototype)).not.toEqual(expect.arrayContaining(['returnProcess', 'returnsList', 'returnGet']));
    expect(Object.getOwnPropertyNames(AdminReturnController.prototype)).toEqual(expect.arrayContaining(['list', 'get', 'resolve']));
    expect(Object.getOwnPropertyNames(AdminReturnController.prototype)).not.toContain('process');
  });

  it('quyền: xem = order.return.read; phân xử = order.return.process', () => {
    const perms = (name: string) => Reflect.getMetadata('ef:permissions', Object.getOwnPropertyDescriptor(AdminReturnController.prototype, name)?.value as object) as string[] | undefined;
    expect(perms('list')).toEqual(['order.return.read']);
    expect(perms('get')).toEqual(['order.return.read']);
    expect(perms('resolve')).toEqual(['order.return.process']);
  });

});
