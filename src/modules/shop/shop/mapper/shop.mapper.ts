import { DEFAULT_BANK_CHANGE_HOLD_HOURS, SHOP_STATUS_LABEL } from '../../foundation/shop.constants';
import type { ShopRow } from '../repository/shop.repository';
import { ShopResponse, AdminShopResponse, AdminShopSummaryResponse } from '../dto/shop.responses';

/* Chủ shop hiển thị cho nhân viên sàn (tra theo lô ở service); `undefined`/thiếu = không tra được ⇒ trường null. */
export interface ShopOwnerBrief {
  fullName: string;
  email: string;
}

/* Che giấu số tài khoản — chỉ hiển thị 4 chữ số cuối */
function maskBankAccountNumber(accountNumber: string | null | undefined): string | null {
  if (!accountNumber || accountNumber.length < 4) return null;
  const last4 = accountNumber.slice(-4);
  const masked = '•'.repeat(Math.max(0, accountNumber.length - 4)) + last4;
  return masked;
}

/*
 * Response vendor / web bán hàng: whitelist riêng, KHÔNG có tên/email chủ shop.
 * `bankChangeHoldHours` = setting `payout.bank_change_hold_hours` do service đọc MỘT lần cho cả response/trang (mapper thuần, không tự gọi system) — FE hiển thị đúng con số thật.
 */
export function toShopResponse(s: ShopRow, bankChangeHoldHours: number = DEFAULT_BANK_CHANGE_HOLD_HOURS): ShopResponse {
  return {
    id: s.id,
    shippingCarrierEnabled: s.shippingCarrierEnabled, shippingPickup: s.shippingPickup as unknown as import('../request/shop.requests').ShopShippingAddressRequest | null, shippingReturn: s.shippingReturn as unknown as import('../request/shop.requests').ShopShippingAddressRequest | null,
    code: s.code,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    bannerUrl: s.bannerUrl,
    description: s.description,
    status: s.status,
    statusLabel: SHOP_STATUS_LABEL[s.status] ?? s.status,
    commissionRate: s.commissionRate.toString(),
    bankCode: s.bankCode ?? null,
    bankAccountName: s.bankAccountName ?? null,
    bankAccountNumberMasked: maskBankAccountNumber(s.bankAccountNumber),
    bankStatus: s.bankStatus,
    bankVerifiedAt: s.bankVerifiedAt?.toISOString() ?? null,
    bankChangeHoldHours,
    ratingAvg: s.ratingAvg?.toString() ?? null,
    totalProducts: s.totalProducts,
    ownerUserId: s.ownerUserId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/* Response cho nhân viên sàn ở danh sách + thao tác: thêm chủ shop, số tài khoản vẫn che. */
export function toAdminShopSummaryResponse(s: ShopRow, owner?: ShopOwnerBrief | null, bankChangeHoldHours?: number): AdminShopSummaryResponse {
  return {
    ...toShopResponse(s, bankChangeHoldHours),
    ownerName: owner?.fullName ?? null,
    ownerEmail: owner?.email ?? null,
  };
}

/* Response chi tiết cho admin — trả full số tài khoản */
export function toAdminShopResponse(s: ShopRow, owner?: ShopOwnerBrief | null, bankChangeHoldHours?: number): AdminShopResponse {
  return {
    ...toAdminShopSummaryResponse(s, owner, bankChangeHoldHours),
    bankAccountNumber: s.bankAccountNumber ?? null,
  };
}
