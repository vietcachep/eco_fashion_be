import { ALL_PERMISSION_CODES, PERMISSION_CATALOG, ROLE_PRESETS } from './catalog';

/*
 * Quyền đổi trả theo đúng vai (PLAN-0022 §5): shop duyệt / từ chối / nhận hàng (shop.return.*); sàn CHỈ phân xử (order.return.process = admin + CSKH);
 * quản lý + kế toán chỉ XEM; kế toán chi hoàn (payment.refund.process). Migration 20261026100200 gỡ order.return.process khỏi vai manager đang chạy.
 */
describe('quyền đổi trả (PLAN-0022 §5)', () => {
  const has = (role: keyof typeof ROLE_PRESETS, code: string) => ROLE_PRESETS[role].codes.includes(code);

  it('catalog có đủ mã: shop.return.read / shop.return.process / order.return.read / order.return.process', () => {
    for (const code of ['shop.return.read', 'shop.return.process', 'order.return.read', 'order.return.process']) expect(ALL_PERMISSION_CODES).toContain(code);
    expect(PERMISSION_CATALOG.find((d) => d.code === 'order.return.process')?.description).toMatch(/Phân xử/);
  });

  it('order.return.read: admin · quản lý · CSKH · kế toán; order.return.process (phân xử): CHỈ admin + CSKH', () => {
    for (const role of ['admin', 'manager', 'sales', 'accountant'] as const) expect(has(role, 'order.return.read')).toBe(true);
    for (const role of ['admin', 'sales'] as const) expect(has(role, 'order.return.process')).toBe(true);
    for (const role of ['manager', 'accountant', 'marketing', 'customer'] as const) expect(has(role, 'order.return.process')).toBe(false);
  });

  it('kế toán chi hoàn (payment.refund.process) — CSKH/quản lý không chi tiền', () => {
    expect(has('accountant', 'payment.refund.process')).toBe(true);
    expect(has('admin', 'payment.refund.process')).toBe(true);
    for (const role of ['manager', 'sales', 'marketing'] as const) expect(has(role, 'payment.refund.process')).toBe(false);
  });

  it('shop: chủ có cả đọc + xử lý; nhân viên mặc định chỉ ĐỌC (xử lý khi chủ cấp)', () => {
    expect(has('shop_owner', 'shop.return.read')).toBe(true);
    expect(has('shop_owner', 'shop.return.process')).toBe(true);
    expect(has('shop_staff', 'shop.return.read')).toBe(true);
    expect(has('shop_staff', 'shop.return.process')).toBe(false);
  });
});
