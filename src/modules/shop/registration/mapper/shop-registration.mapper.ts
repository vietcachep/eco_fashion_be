import type { UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import { SHOP_STATUS } from '../../foundation/shop.constants';
import type { ShopRegistrationDetailResponse, ShopRegistrationResponse } from '../dto/shop-registration.responses';
import type { ShopRegistrationRow } from '../repository/shop-registration.repository';

/* Phần của Shop mà hồ sơ cần hiển thị — trạng thái lấy từ ĐÂY (Shop.status), không từ hồ sơ. */
export interface ShopRegistrationShopView {
  id: string;
  code: string;
  name: string;
  status: string;
}

/*
 * Whitelist trường trả ra. `rejectReason` chỉ có khi shop THỰC SỰ đang `rejected` (lý do của quyết định đầu tiên; shop bị khoá sau này không
 * đẩy lý do khoá sang đây). `canReapply` = bị từ chối — người nộp được tạo hồ sơ mới (không có hồ sơ chờ khác vì luật một-hồ-sơ-chờ).
 */
export function toShopRegistrationResponse(reg: ShopRegistrationRow, shop: ShopRegistrationShopView): ShopRegistrationResponse {
  const rejected = shop.status === SHOP_STATUS.REJECTED;
  return {
    id: reg.id,
    shopId: shop.id,
    shopCode: shop.code,
    shopName: shop.name,
    status: shop.status,
    representativeName: reg.representativeName,
    phone: reg.phone,
    category: reg.categoryId && reg.categoryName ? { id: reg.categoryId, name: reg.categoryName } : null,
    description: reg.description ?? null,
    submittedAt: reg.createdAt.toISOString(),
    decidedAt: reg.decidedAt ? reg.decidedAt.toISOString() : null,
    rejectReason: rejected ? (reg.decisionReason ?? null) : null,
    canReapply: rejected,
  };
}

/* Bản cho nhân viên sàn: kèm người nộp (tên + email, tra theo lô qua IdentityQueryApi); tài khoản không còn tra được ⇒ null. */
export function toShopRegistrationDetailResponse(reg: ShopRegistrationRow, shop: ShopRegistrationShopView, applicant: UserBrief | null | undefined): ShopRegistrationDetailResponse {
  return {
    ...toShopRegistrationResponse(reg, shop),
    applicant: applicant ? { userId: applicant.id, fullName: applicant.fullName, email: applicant.email } : null,
  };
}
