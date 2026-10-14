import { BusinessException } from '@common/exception/business.exception';
import { SHOP_MEMBER_ROLE_CODES, SHOP_STATUS, SHOP_TRANSITIONS } from './foundation/shop.constants';
import { ShopService } from './shop/service/shop.service';

/*
 * Test quy tắc THUẦN của shop (không DB): lưới chuyển trạng thái gian hàng (PLAN-0014 bước 3 —
 * AdminShopController.approve/suspend/reject dùng chung ShopService.assertTransition). Luồng có
 * DB/transaction (khoá dòng, audit, outbox) kiểm bằng smoke trên compose như các module khác (AGENTS.md).
 */
describe('shop', () => {
  describe('— lưới chuyển trạng thái gian hàng', () => {
  it('pending → approved / rejected hợp lệ', () => {
    expect(() => ShopService.assertTransition(SHOP_STATUS.PENDING, SHOP_STATUS.APPROVED)).not.toThrow();
    expect(() => ShopService.assertTransition(SHOP_STATUS.PENDING, SHOP_STATUS.REJECTED)).not.toThrow();
  });

  it('approved → suspended hợp lệ; suspended → approved (mở khoá lại) hợp lệ', () => {
    expect(() => ShopService.assertTransition(SHOP_STATUS.APPROVED, SHOP_STATUS.SUSPENDED)).not.toThrow();
    expect(() => ShopService.assertTransition(SHOP_STATUS.SUSPENDED, SHOP_STATUS.APPROVED)).not.toThrow();
  });

  it('chuyển KHÔNG hợp lệ ném BusinessException mã SHOP_INVALID_TRANSITION', () => {
    // Duyệt thẳng pending → suspended (bỏ qua approved) không hợp lệ.
    expect(() => ShopService.assertTransition(SHOP_STATUS.PENDING, SHOP_STATUS.SUSPENDED)).toThrow(BusinessException);
    // rejected là trạng thái cuối — không quay lại pending/approved được.
    expect(() => ShopService.assertTransition(SHOP_STATUS.REJECTED, SHOP_STATUS.PENDING)).toThrow(BusinessException);
    expect(() => ShopService.assertTransition(SHOP_STATUS.REJECTED, SHOP_STATUS.APPROVED)).toThrow(BusinessException);
    // approved không tự "duyệt lại" hay "từ chối" được nữa.
    expect(() => ShopService.assertTransition(SHOP_STATUS.APPROVED, SHOP_STATUS.REJECTED)).toThrow(BusinessException);

    let caught: unknown;
    try {
      ShopService.assertTransition(SHOP_STATUS.PENDING, SHOP_STATUS.SUSPENDED);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BusinessException);
    expect((caught as BusinessException).errorCode).toBe('SHOP_INVALID_TRANSITION');
  });

  it('lưới chuyển trạng thái chỉ dùng 4 trạng thái đã khai báo, không có cạnh mồ côi', () => {
    const known = new Set(Object.values(SHOP_STATUS));
    for (const [from, tos] of Object.entries(SHOP_TRANSITIONS)) {
      expect(known.has(from as (typeof SHOP_STATUS)[keyof typeof SHOP_STATUS])).toBe(true);
      for (const to of tos) expect(known.has(to as (typeof SHOP_STATUS)[keyof typeof SHOP_STATUS])).toBe(true);
    }
  });

    it('SHOP_MEMBER_ROLE_CODES chỉ có đúng 2 vai scope=shop (shop_owner, shop_staff)', () => {
      expect(SHOP_MEMBER_ROLE_CODES).toEqual(['shop_owner', 'shop_staff']);
    });
  });
});
