import { Prisma } from '@common/prisma/types';
import { toShopResponse, toAdminShopResponse } from './shop/mapper/shop.mapper';
import type { ShopRow } from './shop/repository/shop.repository';

/*
 * Tests cho tính năng tài khoản ngân hàng (PLAN-0017, WP B10):
 * - Che giấu số tài khoản trong vendor response (mapper chỉ lộ 4 chữ số cuối, phần đầu thay bằng '•')
 * - Admin thấy full số tài khoản
 * - Masking logic xử lý edge cases (null, < 4 ký tự)
 */

/* Dòng shop đủ trường theo ShopRow; từng test chỉ ghi đè phần liên quan tới ngân hàng. */
function makeShopRow(overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    shippingCarrierEnabled: false,
    shippingPickup: null,
    shippingReturn: null,
    id: 'shop-123',
    code: 'SHOP-001',
    slug: 'test-shop',
    name: 'Test Shop',
    logoUrl: null,
    bannerUrl: null,
    description: null,
    status: 'approved',
    commissionRate: new Prisma.Decimal('10.00'),
    bankCode: '970436',
    bankAccountNumber: '123456789012',
    bankAccountName: 'NGUYEN VAN A',
    bankStatus: 'verified',
    bankVerifiedAt: null,
    ratingAvg: null,
    totalProducts: 0,
    ownerUserId: 'user-123',
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('shop — tài khoản ngân hàng', () => {
  describe('— che giấu số tài khoản (masking) trong vendor response', () => {
    it('che giấu số tài khoản 12 chữ số để chỉ lộ 4 chữ số cuối (••••••••9012)', () => {
      const response = toShopResponse(makeShopRow({ bankAccountNumber: '123456789012' }));

      expect(response.bankCode).toBe('970436');
      expect(response.bankAccountName).toBe('NGUYEN VAN A');
      expect(response.bankAccountNumberMasked).toBe('••••••••9012');
      // ShopResponse vendor không có bankAccountNumber, chỉ có AdminShopResponse mới có
      expect(response).not.toHaveProperty('bankAccountNumber');
    });

    it('che giấu số tài khoản 6 chữ số (••3456)', () => {
      const response = toShopResponse(makeShopRow({ bankAccountNumber: '123456', bankAccountName: 'TRAN THI B' }));

      expect(response.bankAccountNumberMasked).toBe('••3456');
    });

    it('số tài khoản đúng 4 chữ số thì lộ nguyên 4 chữ số (không còn phần để che)', () => {
      const response = toShopResponse(makeShopRow({ bankAccountNumber: '1234' }));

      expect(response.bankAccountNumberMasked).toBe('1234');
    });

    it('trả null nếu số tài khoản null', () => {
      const response = toShopResponse(makeShopRow({ bankAccountNumber: null, bankAccountName: 'TRAN THI B' }));

      expect(response.bankAccountNumberMasked).toBeNull();
    });

    it('trả null nếu số tài khoản < 4 chữ số', () => {
      const response = toShopResponse(makeShopRow({ bankAccountNumber: '123', bankAccountName: 'TRAN THI B' }));

      expect(response.bankAccountNumberMasked).toBeNull();
    });
  });

  describe('— trạng thái xác minh TK + số giờ giữ chi trả (PLAN-0040 5.2/5.4)', () => {
    it('vendor response có bankStatus, bankVerifiedAt (ISO) và bankChangeHoldHours (mặc định 72, không phải 24)', () => {
      const verifiedAt = new Date('2026-10-22T09:30:00.000Z');

      const response = toShopResponse(makeShopRow({ bankStatus: 'pending_verification', bankVerifiedAt: verifiedAt }));

      expect(response).toMatchObject({ bankStatus: 'pending_verification', bankVerifiedAt: '2026-10-22T09:30:00.000Z', bankChangeHoldHours: 72 });
    });

    it('chưa xác minh tay ⇒ bankVerifiedAt null; số giờ giữ lấy từ tham số của service (setting)', () => {
      const response = toShopResponse(makeShopRow(), 48);

      expect(response).toMatchObject({ bankStatus: 'verified', bankVerifiedAt: null, bankChangeHoldHours: 48 });
    });

    it('admin response (tóm tắt + chi tiết) cũng mang các trường này để quản lý thấy TK đang chờ xác minh', () => {
      const detail = toAdminShopResponse(makeShopRow({ bankStatus: 'pending_verification' }), { fullName: 'Nguyễn Văn A', email: 'a@fitly.vn' }, 36);

      expect(detail).toMatchObject({ bankStatus: 'pending_verification', bankChangeHoldHours: 36, ownerName: 'Nguyễn Văn A', bankAccountNumber: '123456789012' });
    });
  });

  describe('— admin response trả full số tài khoản', () => {
    it('admin (supplier.shop.read) thấy full bankAccountNumber', () => {
      const response = toAdminShopResponse(makeShopRow({ bankAccountNumber: '123456789012' }));

      // Admin response kế thừa từ ShopResponse + thêm full number
      expect(response.bankCode).toBe('970436');
      expect(response.bankAccountName).toBe('NGUYEN VAN A');
      expect(response.bankAccountNumberMasked).toBe('••••••••9012'); // Vẫn có masked
      expect(response.bankAccountNumber).toBe('123456789012'); // Nhưng cũng có full number
    });

    it('admin response trả null nếu chưa khai bank info', () => {
      const response = toAdminShopResponse(makeShopRow({ bankCode: null, bankAccountNumber: null, bankAccountName: null }));

      expect(response.bankCode).toBeNull();
      expect(response.bankAccountNumber).toBeNull();
      expect(response.bankAccountName).toBeNull();
      expect(response.bankAccountNumberMasked).toBeNull();
    });
  });
});
