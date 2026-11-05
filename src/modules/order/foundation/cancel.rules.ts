import { BusinessException } from '@common/exception/business.exception';
import {
  CANCEL_REASON_LABEL,
  CANCEL_SOURCE,
  CUSTOMER_CANCEL_REASONS,
  PLATFORM_CANCEL_REASONS,
  SHOP_CANCEL_REASONS,
  VIOLATION_KIND,
  type CancelSource,
  type ViolationKind,
} from './order.constants';

/* Hàm thuần của luật huỷ đơn (PLAN-0027) — tách khỏi service để test không cần dựng cả OrderService. */

const REASON_CODES_BY_SOURCE: Record<'customer' | 'shop' | 'platform', readonly string[]> = {
  customer: CUSTOMER_CANCEL_REASONS,
  shop: SHOP_CANCEL_REASONS,
  platform: PLATFORM_CANCEL_REASONS,
};

/* Lý do huỷ lưu ở `orders.cancel_reason` (VARCHAR 255) và đi vào lý do hoàn tiền (cắt ở payment). */
export const CANCEL_REASON_MAX = 255;

export interface CancelReasonInput {
  /* Văn bản tự do (API cũ gửi `reason`). */
  reason?: string | null;
  /* Mã lý do theo bên huỷ (docs/10 §7). Thiếu ⇒ `other`. */
  reasonCode?: string | null;
  note?: string | null;
}

/*
 * Chuẩn hoá lý do huỷ từ request: mã (thiếu ⇒ `other`, sai bên ⇒ 400) + văn bản hiển thị. Có `reason` ⇒ dùng nguyên văn; không có ⇒ ghép "<nhãn mã>: <ghi chú>".
 * Văn bản rỗng ⇒ 400 — huỷ đơn luôn phải có lý do đọc được (khách/shop/CSKH đều thấy).
 */
export function resolveCancelReason(side: 'customer' | 'shop' | 'platform', input: CancelReasonInput): { reasonCode: string; text: string } {
  const rawCode = (input.reasonCode ?? '').trim();
  const free = (input.reason ?? '').trim();
  // Phải có ÍT NHẤT một: mã lý do hoặc văn bản — huỷ không lý do làm khách/shop/CSKH không hiểu chuyện gì đã xảy ra.
  if (!rawCode && !free) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Vui lòng chọn hoặc nhập lý do huỷ đơn');
  const code = rawCode || 'other';
  if (!REASON_CODES_BY_SOURCE[side].includes(code)) throw new BusinessException('COMMON_VALIDATION_ERROR', `Mã lý do huỷ "${code}" không hợp lệ`);
  const note = (input.note ?? '').trim();
  const text = (free || [CANCEL_REASON_LABEL[code], note].filter(Boolean).join(': ')).slice(0, CANCEL_REASON_MAX);
  return { reasonCode: code, text };
}

/*
 * Mức vi phạm khi SHOP chủ động huỷ đơn — một đơn tối đa MỘT điểm (ưu tiên: hết hàng / sai giá > từ chối yêu cầu huỷ rồi tự huỷ > huỷ đơn đã đóng gói).
 * Huỷ theo yêu cầu của khách (`customer_request`) hoặc không liên lạc được khách ở `pending/confirmed` không bị tính.
 */
export function shopCancelViolation(input: { reasonCode: string | null; fromStatus: string; hadRejectedRequest: boolean }): ViolationKind | null {
  if (input.reasonCode === 'out_of_stock') return VIOLATION_KIND.CANCEL_OUT_OF_STOCK;
  if (input.reasonCode === 'price_error') return VIOLATION_KIND.CANCEL_PRICE_ERROR;
  if (input.hadRejectedRequest) return VIOLATION_KIND.REJECT_THEN_CANCEL;
  if (input.fromStatus === 'packing' && input.reasonCode !== 'customer_request') return VIOLATION_KIND.CANCEL_PACKING;
  return null;
}

/* Nguồn huỷ mặc định khi caller không nêu: không người thao tác = hệ thống; chính chủ đơn = khách; còn lại = shop (đường báo giao thất bại). */
export function inferCancelSource(actorUserId: string | null, orderUserId: string): CancelSource {
  if (actorUserId === null) return CANCEL_SOURCE.SYSTEM;
  return actorUserId === orderUserId ? CANCEL_SOURCE.CUSTOMER : CANCEL_SOURCE.SHOP;
}

/* So sánh tên tỉnh/thành bỏ dấu + tiền tố ("TP.", "Thành phố", "Tỉnh") để "TP. Hồ Chí Minh" = "Hồ Chí Minh" = "ho chi minh". */
export function normalizeProvince(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\b(thanh pho|tp|tinh)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
