import { Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_STATUS } from '../foundation/order.constants';
import { buildHarness, customer, CS_STAFF, CUSTOMER, D, DAY, HOUR, mkOrderLike, mkReturn, OK_EVIDENCE, REFUND_ACCOUNT, SHOP, SHOP_STAFF, type Harness, type OrderLike } from '../../../../test/helpers/return-harness';
import type { CreateReturnInput } from './return.service';

/*
 * Đổi trả phía KHÁCH (PLAN-0022): tạo yêu cầu (lý do, minh chứng, tài khoản nhận hoàn, not_received), công thức hoàn theo tỉ lệ, chặn vượt số lượng,
 * rút / báo gửi hàng / khiếu nại, hook payment (received → refunded). Chạy service THẬT trên kho trong bộ nhớ (test/helpers/return-harness.ts).
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const near = (d: Date | null | undefined, ms: number) => d instanceof Date && Math.abs(d.getTime() - (Date.now() + ms)) < 5_000;

const ask = (h: Harness, over: Partial<CreateReturnInput> = {}, code = 'DH260001') =>
  h.customerSvc.create(customer, code, { reasonCode: 'size_issue', reason: 'Không vừa size', items: [{ orderItemId: 'oi-1', quantity: 1 }], evidence: OK_EVIDENCE, ...over });

describe('ReturnService.create — số tiền hoàn theo tỉ lệ trên total', () => {
  interface RItem {
    id: string;
    qty: number;
    unit: number;
  }
  const orderWith = (subtotal: number, total: number, items: RItem[]): OrderLike =>
    mkOrderLike({ subtotal: D(subtotal), total: D(total), itemCount: items.reduce((n, i) => n + i.qty, 0), items: items.map((i) => ({ id: i.id, variantId: `var-${i.id}`, name: `SP ${i.id}`, color: 'Đen', size: 'M', quantity: i.qty, imageUrl: null, unitPrice: D(i.unit) })) });
  const refundOf = async (order: OrderLike, items: Array<{ orderItemId: string; quantity: number }>) => {
    const h = buildHarness({ orders: [order] });
    const res = await ask(h, { items });
    expect(h.ret(res.id).refundAmount.toString()).toBe(res.refundAmount.amount); // DB lưu đúng số trả về
    expect(res.calculatedRefundAmount.amount).toBe(res.refundAmount.amount);
    return res.refundAmount.amount;
  };

  it('voucher FREESHIP: subtotal 100.000, ship 30.000, giảm 30.000 ⇒ total 100.000 ⇒ trả hết hoàn đúng 100.000', async () => {
    const o = orderWith(100_000, 100_000, [{ id: 'i1', qty: 2, unit: 50_000 }]);
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 2 }])).toBe('100000');
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 1 }])).toBe('50000');
  });

  it('voucher %: subtotal 200.000, giảm 20.000 ⇒ total 180.000: trả nửa hàng hoàn 90.000, trả hết 180.000', async () => {
    const o = orderWith(200_000, 180_000, [{ id: 'i1', qty: 1, unit: 100_000 }, { id: 'i2', qty: 1, unit: 100_000 }]);
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 1 }])).toBe('90000');
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 1 }, { orderItemId: 'i2', quantity: 1 }])).toBe('180000');
  });

  it('không voucher nhưng có phí ship: hoàn theo tỉ lệ, trả hết = total', async () => {
    const o = orderWith(100_000, 130_000, [{ id: 'i1', qty: 2, unit: 50_000 }]);
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 2 }])).toBe('130000');
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 1 }])).toBe('65000');
  });

  it('nhiều dòng, làm tròn XUỐNG, tổng các lần trả lẻ không vượt total; Σ dòng > subtotal vẫn ≤ total', async () => {
    const o = orderWith(350_000, 300_000, [{ id: 'i1', qty: 2, unit: 100_000 }, { id: 'i2', qty: 3, unit: 50_000 }]);
    expect(await refundOf(o, [{ orderItemId: 'i1', quantity: 1 }, { orderItemId: 'i2', quantity: 2 }])).toBe('171428');
    const thirds = orderWith(99_999, 80_000, [{ id: 'i1', qty: 1, unit: 33_333 }, { id: 'i2', qty: 1, unit: 33_333 }, { id: 'i3', qty: 1, unit: 33_333 }]);
    const parts = [await refundOf(thirds, [{ orderItemId: 'i1', quantity: 1 }]), await refundOf(thirds, [{ orderItemId: 'i2', quantity: 1 }]), await refundOf(thirds, [{ orderItemId: 'i3', quantity: 1 }])];
    expect(parts).toEqual(['26666', '26666', '26666']);
    expect(await refundOf(orderWith(100_000, 80_000, [{ id: 'i1', qty: 1, unit: 120_000 }]), [{ orderItemId: 'i1', quantity: 1 }])).toBe('80000');
  });
});

describe('ReturnService.create — tạo yêu cầu', () => {
  it('ghi yêu cầu `requested`: shopId từ ĐƠN, lý do chuẩn, cần trả hàng, hạn shop duyệt = 72 giờ, minh chứng đã chuẩn hoá', async () => {
    const h = buildHarness();
    const res = await ask(h, { reasonCode: 'defective', reason: ' Áo bị rách ', detail: ' chi tiết ' });
    const row = h.ret(res.id);
    expect(row).toMatchObject({ orderCode: 'DH260001', userId: CUSTOMER, shopId: SHOP, status: 'requested', reasonCode: 'defective', requireReturn: true, reason: 'Áo bị rách', detail: 'chi tiết', refundAccount: null });
    expect(near(row.shopRespondDueAt, 72 * HOUR)).toBe(true);
    expect(row.evidence).toEqual(OK_EVIDENCE.map((e) => ({ ...e })));
    expect(res).toMatchObject({ status: 'requested', shopId: SHOP, shopName: `Shop ${SHOP}`, deadlineKind: 'shop_respond', canCancel: true, canShipBack: false, canEscalate: false, returnAddress: null, refund: null, refundAccount: null, rejectedBy: null, resolvedBy: null });
    expect(res.deadlineAt).toBe(row.shopRespondDueAt?.toISOString());
  });

  it('thông báo đúng người: SHOP (thành viên có shop.return.process) — KHÔNG báo CSKH; kèm audit + outbox RETURN_REQUESTED', async () => {
    const h = buildHarness();
    const res = await ask(h);
    expect(h.mocks.shops.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.return.process');
    expect(h.notesTo(SHOP_STAFF)).toEqual([expect.objectContaining({ type: 'order', title: 'Yêu cầu đổi trả đơn DH260001', link: `/vendor/returns/${res.id}` })]);
    expect(h.notesTo(CS_STAFF)).toHaveLength(0);
    expect(h.mocks.users.staffUserIdsWithPermission).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({ action: ORDER_AUDIT.RETURN_REQUESTED, entityCode: 'DH260001', after: expect.objectContaining({ reasonCode: 'size_issue', refund: '100000', requireReturn: true, evidence: 1 }) as unknown });
    expect(h.events).toEqual([{ eventType: ORDER_EVENT.RETURN_REQUESTED, payload: expect.objectContaining({ orderCode: 'DH260001', shopId: SHOP, returnId: res.id }) as unknown }]);
  });

  it('bỏ trống `reason` ⇒ lấy nhãn của reasonCode; `other` bắt buộc nêu lý do', async () => {
    const h = buildHarness();
    expect((await ask(h, { reasonCode: 'wrong_item', reason: undefined })).reason).toBe('Giao sai hàng');
    await expect(ask(h, { reasonCode: 'other', reason: undefined })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
  });

  describe('minh chứng (kiểm TRƯỚC khi mở transaction)', () => {
    it('thiếu minh chứng ⇒ EVIDENCE_REQUIRED', async () => {
      const h = buildHarness();
      await expect(ask(h, { evidence: [] })).rejects.toMatchObject({ errorCode: ORDER_ERR.EVIDENCE_REQUIRED });
      expect(h.mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['URL ngoài kho upload', [{ type: 'image', url: 'https://evil.example.com/a.jpg', name: 'a.jpg' }]],
      ['http thường', [{ type: 'image', url: 'http://res.cloudinary.com/demo/a.jpg', name: 'a.jpg' }]],
      ['quá 8 tệp', Array.from({ length: 9 }, (_, i) => ({ type: 'image', url: `/static/uploads/user-media/ab/${i}.jpg`, name: `${i}.jpg` }))],
      ['sai loại', [{ type: 'pdf', url: '/static/uploads/user-media/ab/1.pdf', name: '1.pdf' }]],
    ])('%s ⇒ RETURN_EVIDENCE_INVALID', async (_l, evidence) => {
      const h = buildHarness();
      await expect(ask(h, { evidence })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_EVIDENCE_INVALID });
      expect(h.mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('đúng 8 tệp từ Cloudinary của hệ thống / kho cục bộ ⇒ qua', async () => {
      const h = buildHarness();
      const evidence = Array.from({ length: 8 }, (_, i) => ({ type: i % 2 ? 'video' : 'image', url: i % 2 ? `https://res.cloudinary.com/demo/video/upload/v1/${i}.mp4` : `/static/uploads/user-media/ab/${i}.jpg`, name: `${i}` }));
      expect((await ask(h, { evidence })).evidence).toHaveLength(8);
    });
  });

  describe('tài khoản nhận hoàn', () => {
    const cod = (over: Partial<OrderLike> = {}) => mkOrderLike({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.PAID, ...over });

    it('đơn COD ĐÃ THU tiền mà không khai tài khoản ⇒ RETURN_REFUND_ACCOUNT_REQUIRED, không ghi gì', async () => {
      const h = buildHarness({ orders: [cod()] });
      await expect(ask(h)).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_ACCOUNT_REQUIRED });
      expect(h.returns.size).toBe(0);
    });

    it('COD có tài khoản: lưu ĐẦY ĐỦ (để chi), response chỉ lộ 4 số cuối + tên chuẩn hoá không dấu in hoa', async () => {
      const h = buildHarness({ orders: [cod()] });
      const res = await ask(h, { refundAccount: REFUND_ACCOUNT });
      expect(h.ret(res.id).refundAccount).toEqual({ bankBin: '970422', bankName: 'MB Bank', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' });
      expect(res.refundAccount).toEqual({ bankBin: '970422', bankName: 'MB Bank', accountNumberMasked: '****6789', accountName: 'NGUYEN VAN A' });
      expect(JSON.stringify(res)).not.toContain('0123456789');
    });

    it('PayOS không bắt buộc (dùng tài khoản đã trả); có khai thì lưu dự phòng', async () => {
      const h = buildHarness();
      expect((await ask(h)).refundAccount).toBeNull();
      expect((await ask(h, { items: [{ orderItemId: 'oi-2', quantity: 1 }], refundAccount: REFUND_ACCOUNT })).refundAccount?.accountNumberMasked).toBe('****6789');
    });

    it('COD CHƯA thu tiền (đang giao) báo chưa nhận hàng: không cần tài khoản (không có tiền để hoàn)', async () => {
      const h = buildHarness({ orders: [cod({ status: ORDER_STATUS.SHIPPING, paymentStatus: PAYMENT_STATUS.UNPAID, deliveredAt: null })] });
      await expect(ask(h, { reasonCode: 'not_received', items: undefined, evidence: undefined })).resolves.toMatchObject({ requireReturn: false, status: 'requested' });
    });

    it('tài khoản sai định dạng ⇒ RETURN_REFUND_ACCOUNT_INVALID (kiểm trước transaction)', async () => {
      const h = buildHarness({ orders: [cod()] });
      await expect(ask(h, { refundAccount: { ...REFUND_ACCOUNT, bankBin: '12' } })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_ACCOUNT_INVALID });
      await expect(ask(h, { refundAccount: { ...REFUND_ACCOUNT, accountNumber: 'abc' } })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_REFUND_ACCOUNT_INVALID });
      expect(h.mocks.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('điều kiện theo đơn', () => {
    it('đơn của người khác / không tồn tại ⇒ NotFound', async () => {
      await expect(ask(buildHarness({ orders: [mkOrderLike({ userId: 'someone-else' })] }))).rejects.toBeInstanceOf(NotFoundException);
      await expect(ask(buildHarness(), {}, 'DH-NOPE')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lý do thường: chỉ đơn delivered/completed; đang giao / chờ xử lý ⇒ RETURN_NOT_ALLOWED', async () => {
      for (const status of [ORDER_STATUS.SHIPPING, ORDER_STATUS.PENDING, ORDER_STATUS.CANCELLED]) await expect(ask(buildHarness({ orders: [mkOrderLike({ status })] }))).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
      await expect(ask(buildHarness({ orders: [mkOrderLike({ status: ORDER_STATUS.COMPLETED })] }))).resolves.toMatchObject({ status: 'requested' });
    });

    it('quá hạn đổi trả (return.window_days = 7) ⇒ RETURN_WINDOW_CLOSED', async () => {
      await expect(ask(buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 10 * DAY) })] }))).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_WINDOW_CLOSED });
      await expect(ask(buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 10 * DAY) })], settings: { 'return.window_days': 14 } }))).resolves.toMatchObject({ status: 'requested' });
    });

    it('không có dòng nào ⇒ lỗi xác thực; dòng không thuộc đơn ⇒ NotFound', async () => {
      const h = buildHarness();
      await expect(ask(h, { items: [] })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
      await expect(ask(h, { items: undefined })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
      await expect(ask(h, { items: [{ orderItemId: 'khong-co', quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('chặn vượt số lượng còn trả được', () => {
    it('trừ yêu cầu đang mở / đã hoàn; dòng trùng được gộp trước khi so', async () => {
      const h = buildHarness({ orders: [mkOrderLike({ items: [{ id: 'oi-1', variantId: 'var-1', name: 'Áo thun', color: 'Đen', size: 'M', quantity: 3, imageUrl: null, unitPrice: D(100_000) }], itemCount: 3, subtotal: D(300_000), total: D(300_000) })], returns: [mkReturn({ id: 'rr-open', status: 'requested', items: [{ id: 'x', returnId: 'rr-open', orderItemId: 'oi-1', variantId: 'var-1', name: 'Áo thun', color: 'Đen', size: 'M', quantity: 2, imageUrl: null, unitPrice: D(100_000) }] })] });
      await expect(ask(h, { items: [{ orderItemId: 'oi-1', quantity: 2 }] })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED, message: 'Áo thun: chỉ còn 1 có thể trả' });
      await expect(ask(h, { items: [{ orderItemId: 'oi-1', quantity: 1 }, { orderItemId: 'oi-1', quantity: 1 }] })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
      await expect(ask(h, { items: [{ orderItemId: 'oi-1', quantity: 1 }] })).resolves.toMatchObject({ status: 'requested' });
    });

    const reservedBy = (over: Partial<ReturnType<typeof mkReturn>>) =>
      buildHarness({ orders: [mkOrderLike({ items: [{ id: 'oi-1', variantId: 'var-1', name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1, imageUrl: null, unitPrice: D(100_000) }], itemCount: 1, subtotal: D(100_000), total: D(100_000) })], returns: [mkReturn({ id: 'rr-old', ...over })] });
    const again = (h: Harness) => ask(h, { items: [{ orderItemId: 'oi-1', quantity: 1 }] });

    it.each([
      ['approved', {}],
      ['escalated', {}],
      ['received', {}],
      ['refunded', {}],
      ['rejected (bởi SHOP, còn hạn khiếu nại) — nếu không khách tạo yêu cầu thứ hai rồi khiếu nại yêu cầu cũ ⇒ hoàn hai lần', { rejectedBy: 'shop', escalateDueAt: new Date(Date.now() + DAY) }],
    ])('%s giữ chỗ số lượng', async (status, extra) => {
      const h = reservedBy({ status: status.split(' ')[0], ...extra });
      await expect(again(h)).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
    });

    it.each([
      ['cancelled', {}],
      ['expired', {}],
      ['rejected', { rejectedBy: 'platform', escalateDueAt: null }],
      ['rejected', { rejectedBy: 'shop', escalateDueAt: new Date(Date.now() - HOUR) }],
    ])('%s nhả lại số lượng', async (status, extra) => {
      await expect(again(reservedBy({ status, ...extra }))).resolves.toMatchObject({ status: 'requested' });
    });
  });

  describe('lý do "chưa nhận hàng" (not_received)', () => {
    const shipping = () => buildHarness({ orders: [mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null })] });
    const notReceived = (h: Harness, over: Partial<CreateReturnInput> = {}) => ask(h, { reasonCode: 'not_received', reason: undefined, items: undefined, evidence: undefined, ...over });

    it('không cần items (mặc định CẢ ĐƠN) và minh chứng; không cần trả hàng; hoàn đủ total', async () => {
      const h = shipping();
      const res = await notReceived(h);
      expect(res).toMatchObject({ requireReturn: false, reason: 'Chưa nhận được hàng', reasonCode: 'not_received', refundAmount: { amount: '200000' }, evidence: [] });
      expect(res.items.map((i) => [i.orderItemId, i.quantity])).toEqual([['oi-1', 1], ['oi-2', 1]]);
    });

    it('[SHP-05] đơn vừa báo đã giao (≤ return.not_received_days = 7) ⇒ được (kể cả ngày thứ 6); quá hạn ⇒ RETURN_WINDOW_CLOSED', async () => {
      const recent = buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 2 * DAY) })] });
      await expect(notReceived(recent)).resolves.toMatchObject({ requireReturn: false });
      const day6 = buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 6 * DAY) })] });
      await expect(notReceived(day6)).resolves.toMatchObject({ requireReturn: false });
      const old = buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 8 * DAY) })] });
      await expect(notReceived(old)).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_WINDOW_CLOSED });
    });

    it('đơn chưa gửi (pending/confirmed) hoặc đã hoàn tất ⇒ RETURN_NOT_ALLOWED', async () => {
      for (const status of [ORDER_STATUS.PENDING, ORDER_STATUS.PACKING, ORDER_STATUS.COMPLETED]) await expect(notReceived(buildHarness({ orders: [mkOrderLike({ status })] }))).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
    });

    it('đã có yêu cầu mở giữ hàng của đơn ⇒ không báo lần hai (không hoàn hai lần)', async () => {
      const h = shipping();
      await notReceived(h);
      await expect(notReceived(h)).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
      expect(h.returns.size).toBe(1);
    });

    it('LUÔN áp CẢ ĐƠN: bỏ qua `items` khách gửi (không báo một phần — phần còn lại của đơn shipping sẽ không được hoàn khi huỷ)', async () => {
      const h = shipping();
      const res = await notReceived(h, { items: [{ orderItemId: 'oi-1', quantity: 1 }] });
      expect(res.items.map((i) => [i.orderItemId, i.quantity])).toEqual([['oi-1', 1], ['oi-2', 1]]);
      expect(res.refundAmount.amount).toBe('200000');
      // dòng không tồn tại trong `items` cũng bị bỏ qua (không 404)
      const other = shipping();
      await expect(notReceived(other, { items: [{ orderItemId: 'khong-co', quantity: 9 }] })).resolves.toMatchObject({ refundAmount: { amount: '200000' } });
    });

    it('một phần của đơn đã bị yêu cầu khác giữ chỗ ⇒ báo lỗi RÕ (phải áp cả đơn), không tạo yêu cầu', async () => {
      const partial = mkReturn({ id: 'rr-old', status: 'requested', items: [{ id: 'x', returnId: 'rr-old', orderItemId: 'oi-2', variantId: 'var-2', name: 'Quần jean', color: 'Xanh', size: '30', quantity: 1, imageUrl: null, unitPrice: D(100_000) }] });
      const h = buildHarness({ orders: [mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null })], returns: [partial] });
      const err = await notReceived(h).then(
        () => null,
        (e: unknown) => e as { errorCode: string; message: string },
      );
      expect(err).toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
      expect(err?.message).toContain('Quần jean');
      expect(err?.message).toContain('CẢ ĐƠN');
      expect(h.returns.size).toBe(1);
    });
  });
});

describe('ReturnService — hạn chót đọc từ setting được kẹp (không Invalid Date, không chuyển bước ngay)', () => {
  const dueAfterCreate = async (settings: Record<string, number>) => {
    const h = buildHarness({ settings });
    const res = await ask(h);
    return h.ret(res.id).shopRespondDueAt;
  };

  it('return.shop_respond_hours: 0/âm ⇒ 1 giờ; quá lớn ⇒ 8760 giờ (1 năm); NaN ⇒ mặc định 72 giờ; giá trị hợp lệ giữ nguyên', async () => {
    expect(near(await dueAfterCreate({ 'return.shop_respond_hours': 0 }), HOUR)).toBe(true);
    expect(near(await dueAfterCreate({ 'return.shop_respond_hours': -5 }), HOUR)).toBe(true);
    expect(near(await dueAfterCreate({ 'return.shop_respond_hours': 1e12 }), 8760 * HOUR)).toBe(true);
    expect(near(await dueAfterCreate({ 'return.shop_respond_hours': Number.NaN }), 72 * HOUR)).toBe(true);
    expect(near(await dueAfterCreate({ 'return.shop_respond_hours': 24 }), 24 * HOUR)).toBe(true);
    const due = await dueAfterCreate({ 'return.shop_respond_hours': Number.POSITIVE_INFINITY });
    expect(Number.isNaN((due as Date).getTime())).toBe(false);
  });

  it('return.shop_receive_days (ship-back): 0 ⇒ 1 ngày; quá lớn ⇒ 365 ngày', async () => {
    const approved = () => mkReturn({ id: 'rr-a', status: 'approved', approvedAt: new Date(), shopRespondDueAt: null, shipBackDueAt: new Date(Date.now() + 7 * DAY) });
    const zero = buildHarness({ returns: [approved()], settings: { 'return.shop_receive_days': 0 } });
    await zero.customerSvc.shipBack(customer, 'rr-a', { carrier: 'GHN', trackingCode: 'X1' });
    expect(near(zero.ret('rr-a').shopReceiveDueAt, DAY)).toBe(true);
    const huge = buildHarness({ returns: [approved()], settings: { 'return.shop_receive_days': 1e9 } });
    await huge.customerSvc.shipBack(customer, 'rr-a', { carrier: 'GHN', trackingCode: 'X1' });
    expect(near(huge.ret('rr-a').shopReceiveDueAt, 365 * DAY)).toBe(true);
  });

  it('return.not_received_days = 0 ⇒ kẹp về 1 ngày (đơn vừa giao hôm qua vẫn báo được, không bị đóng ngay)', async () => {
    const h = buildHarness({ orders: [mkOrderLike({ deliveredAt: new Date(Date.now() - 12 * HOUR) })], settings: { 'return.not_received_days': 0 } });
    await expect(ask(h, { reasonCode: 'not_received', reason: undefined, items: undefined, evidence: undefined })).resolves.toMatchObject({ requireReturn: false });
  });
});

describe('ReturnService — xem + rút + gửi hàng + khiếu nại', () => {
  const approved = (over = {}) => mkReturn({ id: 'rr-a', status: 'approved', approvedAt: new Date(), shopRespondDueAt: null, shipBackDueAt: new Date(Date.now() + 7 * DAY), returnAddress: { name: 'Kho A', phone: '0901234567', address: '12 Nguyễn Huệ' }, ...over });

  it('getMine/mine: chỉ của chính khách (người khác ⇒ 404), trả đủ cờ + địa chỉ trả hàng khi approved', async () => {
    const h = buildHarness({ returns: [approved(), mkReturn({ id: 'rr-x', userId: 'someone-else' })] });
    const res = await h.customerSvc.getMine(customer, 'rr-a');
    expect(res).toMatchObject({ status: 'approved', canShipBack: true, canCancel: true, deadlineKind: 'ship_back', returnAddress: { name: 'Kho A', phone: '0901234567', address: '12 Nguyễn Huệ' } });
    await expect(h.customerSvc.getMine(customer, 'rr-x')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_FOUND });
    const page = await h.customerSvc.mine(customer, 1, 20);
    expect(page.content.map((r) => r.id)).toEqual(['rr-a']);
    expect(page.totalElements).toBe(1);
  });

  it('hiện khoản hoàn của payment CHỈ khi received/refunded; sau đó returnAddress biến mất', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'rr-r', status: 'received', receivedAt: new Date() }), mkReturn({ id: 'rr-q' })] });
    h.refundSummaryMap.set('DH260001', { status: 'processing', amount: 100_000n });
    expect((await h.customerSvc.getMine(customer, 'rr-r')).refund).toEqual({ status: 'processing', amount: expect.objectContaining({ amount: '100000' }) as unknown });
    expect((await h.customerSvc.getMine(customer, 'rr-q')).refund).toBeNull();
    expect(h.mocks.payment.refundSummaries).toHaveBeenCalledWith(['DH260001']);
  });

  describe('shipBack', () => {
    it('báo đã gửi: lưu vận đơn, bắt đầu hạn shop xác nhận (5 ngày), xoá hạn gửi, báo shop', async () => {
      const h = buildHarness({ returns: [approved()] });
      const res = await h.customerSvc.shipBack(customer, 'rr-a', { carrier: ' GHN ', trackingCode: ' GHN123 ', note: 'đã gửi' });
      const row = h.ret('rr-a');
      expect(row).toMatchObject({ status: 'approved', carrier: 'GHN', trackingCode: 'GHN123', shipBackNote: 'đã gửi', shipBackDueAt: null });
      expect(row.shippedBackAt).toBeInstanceOf(Date);
      expect(near(row.shopReceiveDueAt, 5 * DAY)).toBe(true);
      expect(res).toMatchObject({ canShipBack: false, canCancel: false, deadlineKind: 'shop_receive', carrier: 'GHN', trackingCode: 'GHN123' });
      expect(h.notesTo(SHOP_STAFF)[0]).toMatchObject({ title: 'Khách đã gửi hàng trả đơn DH260001', link: '/vendor/returns/rr-a' });
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_SHIPPED_BACK]);
    });

    it('chỉ khi approved + cần trả hàng + chưa báo gửi; người khác ⇒ 404', async () => {
      for (const over of [{ status: 'requested' }, { status: 'received' }, { shippedBackAt: new Date() }, { requireReturn: false }]) {
        const h = buildHarness({ returns: [approved(over)] });
        await expect(h.customerSvc.shipBack(customer, 'rr-a', { carrier: 'GHN', trackingCode: 'X1' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
      }
      await expect(buildHarness({ returns: [approved({ userId: 'someone-else' })] }).customerSvc.shipBack(customer, 'rr-a', { carrier: 'GHN', trackingCode: 'X1' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('quá hạn gửi hàng ⇒ RETURN_DEADLINE_PASSED, không ghi gì', async () => {
      const h = buildHarness({ returns: [approved({ shipBackDueAt: new Date(Date.now() - HOUR) })] });
      await expect(h.customerSvc.shipBack(customer, 'rr-a', { carrier: 'GHN', trackingCode: 'X1' })).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_DEADLINE_PASSED });
      expect(h.ret('rr-a').shippedBackAt).toBeNull();
    });
  });

  describe('cancel', () => {
    it('rút khi chờ shop duyệt ⇒ cancelled: closedAt, xoá hạn, báo shop, audit + outbox đổi trạng thái', async () => {
      const h = buildHarness({ returns: [mkReturn()] });
      const res = await h.customerSvc.cancel(customer, 'rr-1');
      expect(h.ret()).toMatchObject({ status: 'cancelled', shopRespondDueAt: null });
      expect(h.ret().closedAt).toBeInstanceOf(Date);
      expect(res).toMatchObject({ status: 'cancelled', canCancel: false, deadlineAt: null, deadlineKind: null });
      expect(h.notesTo(SHOP_STAFF)[0]).toMatchObject({ title: 'Khách đã rút yêu cầu đổi trả đơn DH260001' });
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_CANCELLED]);
      expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:cancelled']);
    });

    it('rút khi đã duyệt nhưng CHƯA gửi hàng ⇒ được; đã báo gửi hàng ⇒ INVALID_STATE', async () => {
      const ok = buildHarness({ returns: [approved()] });
      await ok.customerSvc.cancel(customer, 'rr-a');
      expect(ok.ret('rr-a')).toMatchObject({ status: 'cancelled', shipBackDueAt: null });
      const shipped = buildHarness({ returns: [approved({ shippedBackAt: new Date() })] });
      await expect(shipped.customerSvc.cancel(customer, 'rr-a')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
      expect(shipped.ret('rr-a').status).toBe('approved');
    });

    it.each(['rejected', 'escalated', 'received', 'refunded', 'cancelled', 'expired'])('không rút được khi %s', async (status) => {
      const h = buildHarness({ returns: [mkReturn({ status })] });
      await expect(h.customerSvc.cancel(customer, 'rr-1')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
    });

    it('người khác ⇒ 404', async () => {
      await expect(buildHarness({ returns: [mkReturn({ userId: 'someone-else' })] }).customerSvc.cancel(customer, 'rr-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('escalate (khiếu nại)', () => {
    const rejected = (over = {}) => mkReturn({ status: 'rejected', rejectedBy: 'shop', rejectReason: 'Hàng đã qua sử dụng', shopRespondDueAt: null, escalateDueAt: new Date(Date.now() + 2 * DAY), ...over });

    it('shop từ chối + còn hạn ⇒ escalated (nguồn customer): báo CSKH + shop + khách; hạn khiếu nại đóng', async () => {
      const h = buildHarness({ returns: [rejected()] });
      const res = await h.customerSvc.escalate(customer, 'rr-1', ' Hàng thật sự bị lỗi như ảnh ');
      expect(h.ret()).toMatchObject({ status: 'escalated', escalateSource: 'customer', escalateReason: 'Hàng thật sự bị lỗi như ảnh', escalateDueAt: null });
      expect(res).toMatchObject({ status: 'escalated', canEscalate: false, escalateSource: 'customer', deadlineKind: null });
      expect(h.notesTo(CS_STAFF)[0]).toMatchObject({ title: 'Đổi trả đơn DH260001 cần phân xử', link: '/order/returns/rr-1' });
      expect(h.notesTo(SHOP_STAFF)[0]).toMatchObject({ title: 'Đổi trả đơn DH260001 đã chuyển sàn phân xử' });
      expect(h.notesTo(CUSTOMER)[0]).toMatchObject({ title: 'Yêu cầu đổi trả đơn DH260001 đã chuyển cho sàn xem xét' });
      expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_ESCALATED]);
      expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:escalated']);
    });

    it('quá hạn khiếu nại ⇒ RETURN_DEADLINE_PASSED', async () => {
      const h = buildHarness({ returns: [rejected({ escalateDueAt: new Date(Date.now() - HOUR) })] });
      await expect(h.customerSvc.escalate(customer, 'rr-1', 'Hàng thật sự bị lỗi')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_DEADLINE_PASSED });
      expect(h.ret().status).toBe('rejected');
    });

    it('sàn đã từ chối (quyết định cuối) hoặc chưa bị từ chối ⇒ INVALID_STATE', async () => {
      for (const over of [{ rejectedBy: 'platform' }, { status: 'requested', rejectedBy: null }, { status: 'approved', rejectedBy: null }, { status: 'escalated' }]) {
        const h = buildHarness({ returns: [rejected(over)] });
        await expect(h.customerSvc.escalate(customer, 'rr-1', 'Hàng thật sự bị lỗi')).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_INVALID_STATE });
      }
    });

    it('người khác ⇒ 404', async () => {
      await expect(buildHarness({ returns: [rejected({ userId: 'someone-else' })] }).customerSvc.escalate(customer, 'rr-1', 'Hàng thật sự bị lỗi')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('ReturnService.markRefunded — hook của payment (cổng ngược)', () => {
  it('received → refunded: refundedAt + audit + outbox (thông báo "đã hoàn" do onRefunded/payment lo, không báo trùng); idempotent khi gọi lại', async () => {
    const h = buildHarness({ returns: [mkReturn({ status: 'received', receivedAt: new Date() })] });
    await h.customerSvc.markRefunded('rr-1', h.tx);
    expect(h.ret()).toMatchObject({ status: 'refunded' });
    expect(h.ret().refundedAt).toBeInstanceOf(Date);
    expect(h.notes).toHaveLength(0);
    expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_REFUNDED]);
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:refunded']);
    await h.customerSvc.markRefunded('rr-1', h.tx);
    expect(h.audits).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  it('chỉ đổi received → refunded: approved/escalated/rejected/không tồn tại giữ nguyên, không thông báo', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'a', status: 'approved' }), mkReturn({ id: 'e', status: 'escalated' }), mkReturn({ id: 'r', status: 'rejected' })] });
    for (const id of ['a', 'e', 'r', 'khong-co']) await h.customerSvc.markRefunded(id, h.tx);
    expect([h.ret('a').status, h.ret('e').status, h.ret('r').status]).toEqual(['approved', 'escalated', 'rejected']);
    expect(h.notes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});
