import { BusinessException } from '@common/exception/business.exception';
import { CARRIERS, CARRIER_CODES, ORDER_ERR, TRACKING_CODE_PATTERN, type CarrierCode } from './order.constants';

/*
 * Luật THUẦN của "giao hàng có bằng chứng" (PLAN-0031 §2.1) — không đụng DB/mạng để service và test dùng chung:
 * chuyển `shipping` BẮT BUỘC hãng + mã vận đơn; link tra cứu tự sinh theo mẫu của hãng, chỉ hãng không có mẫu (`other`, ahamove) mới nhận link https do shop nhập.
 */

export interface ShippingProof {
  carrier: CarrierCode;
  trackingCode: string;
  /* null = không có link tra cứu (hãng không có mẫu và shop không nhập). */
  trackingUrl: string | null;
}

/* Link https hợp lệ (không user:pass, không cổng lạ) — DTO đã IsUrl(https) nhưng service được gọi từ nhiều đường nên kiểm lại. */
function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url.length === 0 || url.length > 500) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443')) return null;
    return url;
  } catch {
    return null;
  }
}

export function isCarrierCode(v: unknown): v is CarrierCode {
  return typeof v === 'string' && (CARRIER_CODES as string[]).includes(v);
}

/*
 * Kiểm + chuẩn hoá bằng chứng giao hàng. Thiếu/sai ⇒ 400 ORDER_TRACKING_REQUIRED (thông điệp nói rõ thiếu gì). `trackingUrl` shop gửi lên bị BỎ QUA với hãng có mẫu (link do hệ thống sinh,
 * không thể chèn link độc qua hãng thật); với hãng không có mẫu thì dùng link https shop nhập (sai định dạng ⇒ 400 thay vì lưu im lặng).
 */
export function resolveShippingProof(input: { carrier?: string | null; trackingCode?: string | null; trackingUrl?: string | null }): ShippingProof {
  if (!isCarrierCode(input.carrier)) throw new BusinessException(ORDER_ERR.TRACKING_REQUIRED, 'Chọn hãng vận chuyển khi chuyển đơn sang "Đang giao"');
  const trackingCode = (input.trackingCode ?? '').trim();
  if (!TRACKING_CODE_PATTERN.test(trackingCode)) throw new BusinessException(ORDER_ERR.TRACKING_REQUIRED, 'Nhập mã vận đơn (4–40 ký tự gồm chữ, số, dấu gạch ngang) khi chuyển đơn sang "Đang giao"');
  const template = CARRIERS[input.carrier].trackUrl;
  if (template) return { carrier: input.carrier, trackingCode, trackingUrl: template.replace('{code}', encodeURIComponent(trackingCode)) };
  const given = input.trackingUrl?.trim();
  if (given) {
    const url = safeHttpsUrl(given);
    if (!url) throw new BusinessException(ORDER_ERR.TRACKING_REQUIRED, 'Link tra cứu vận đơn phải là địa chỉ https hợp lệ');
    return { carrier: input.carrier, trackingCode, trackingUrl: url };
  }
  return { carrier: input.carrier, trackingCode, trackingUrl: null };
}

/* Tên hãng hiển thị (mã lạ/NULL của đơn cũ ⇒ null). */
export function carrierName(code: string | null | undefined): string | null {
  return isCarrierCode(code) ? CARRIERS[code].name : null;
}
