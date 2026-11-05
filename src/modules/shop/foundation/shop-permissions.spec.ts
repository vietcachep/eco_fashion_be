import { effectiveShopPermissions, SHOP_ASSIGNABLE_PERMISSIONS, SHOP_OWNER_ONLY_PERMISSIONS } from './shop.constants';

describe('quyền đổi trả của shop (PLAN-0022)', () => {
  it('chủ shop giao được shop.return.read / shop.return.process cho nhân viên — không nằm trong quyền chỉ của chủ', () => {
    expect(SHOP_ASSIGNABLE_PERMISSIONS).toEqual(expect.arrayContaining(['shop.return.read', 'shop.return.process']));
    for (const c of ['shop.return.read', 'shop.return.process']) expect(SHOP_OWNER_ONLY_PERMISSIONS).not.toContain(c);
  });

  it('nhân viên chỉ xử lý (duyệt/từ chối/nhận hàng) khi chủ cấp shop.return.process; preset chỉ có quyền đọc', () => {
    const preset = ['shop.order.read', 'shop.return.read'];
    expect(effectiveShopPermissions('shop_staff', preset, null)).not.toContain('shop.return.process');
    expect(effectiveShopPermissions('shop_staff', preset, ['shop.return.read', 'shop.return.process'])).toEqual(['shop.return.read', 'shop.return.process']);
    expect(effectiveShopPermissions('shop_owner', [...preset, 'shop.return.process'], null)).toContain('shop.return.process');
  });
});

describe('effectiveShopPermissions — chủ shop tự đặt quyền nhân viên (PLAN-0021)', () => {
  const preset = ['shop.product.read', 'shop.order.read'];

  it('chủ luôn đủ quyền của vai, bỏ qua quyền riêng', () => {
    expect(effectiveShopPermissions('shop_owner', ['shop.staff.update', 'shop.wallet.read'], ['shop.order.read'])).toEqual(['shop.staff.update', 'shop.wallet.read']);
  });

  it('nhân viên chưa có quyền riêng ⇒ theo preset của vai', () => {
    expect(effectiveShopPermissions('shop_staff', preset, null)).toEqual(preset);
  });

  it('nhân viên có quyền riêng ⇒ đúng danh sách chủ đặt, kể cả quyền preset không có', () => {
    expect(effectiveShopPermissions('shop_staff', preset, ['shop.inventory.manage', 'shop.promotion.manage'])).toEqual(['shop.inventory.manage', 'shop.promotion.manage']);
  });

  it('quyền riêng rỗng ⇒ nhân viên không có quyền nào', () => {
    expect(effectiveShopPermissions('shop_staff', preset, [])).toEqual([]);
  });

  it('không bao giờ lọt quyền của chủ (nhân sự, đối soát, ví, hồ sơ) hay mã lạ qua quyền riêng', () => {
    const r = effectiveShopPermissions('shop_staff', preset, [...SHOP_OWNER_ONLY_PERMISSIONS, 'supplier.shop.approve', 42, 'shop.order.update']);
    expect(r).toEqual(['shop.order.update']);
    for (const c of SHOP_OWNER_ONLY_PERMISSIONS) expect(SHOP_ASSIGNABLE_PERMISSIONS).not.toContain(c);
  });
});
