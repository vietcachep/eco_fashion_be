import { SHOP_STATUS_LABEL } from '../../foundation/shop.constants';
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

/* Response vendor / web bán hàng: whitelist riêng, KHÔNG có tên/email chủ shop. */
export function toShopResponse(s: ShopRow): ShopResponse {
  return {
    id: s.id,
    code: s.code,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    bannerUrl: s.bannerUrl,
    description: s.description,
    status: s.status,
    statusLabel: SHOP_STATUS_LABEL[s.status] ?? s.status,
    commissionRate: s.commissionRate.toString(),
    codEnabled: s.codEnabled,
    bankCode: s.bankCode ?? null,
    bankAccountName: s.bankAccountName ?? null,
    bankAccountNumberMasked: maskBankAccountNumber(s.bankAccountNumber),
    ratingAvg: s.ratingAvg?.toString() ?? null,
    totalProducts: s.totalProducts,
    ownerUserId: s.ownerUserId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/* Response cho nhân viên sàn ở danh sách + thao tác: thêm chủ shop, số tài khoản vẫn che. */
export function toAdminShopSummaryResponse(s: ShopRow, owner?: ShopOwnerBrief | null): AdminShopSummaryResponse {
  return {
    ...toShopResponse(s),
    ownerName: owner?.fullName ?? null,
    ownerEmail: owner?.email ?? null,
  };
}

/* Response chi tiết cho admin — trả full số tài khoản */
export function toAdminShopResponse(s: ShopRow, owner?: ShopOwnerBrief | null): AdminShopResponse {
  return {
    ...toAdminShopSummaryResponse(s, owner),
    bankAccountNumber: s.bankAccountNumber ?? null,
  };
}
