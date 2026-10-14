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
    id: 'shop-123',
    code: 'SHOP-001',
    slug: 'test-shop',
    name: 'Test Shop',
    logoUrl: null,
    bannerUrl: null,
    description: null,
    status: 'approved',
    commissionRate: new Prisma.Decimal('10.00'),
    codEnabled: true,
    bankCode: '970436',
    bankAccountNumber: '123456789012',
    bankAccountName: 'NGUYEN VAN A',
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
