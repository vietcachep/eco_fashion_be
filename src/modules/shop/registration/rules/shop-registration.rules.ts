import { slugify } from '@common/utils/slug';
import { FITLY_OFFICIAL_SHOP_CODE, SHOP_STATUS } from '../../foundation/shop.constants';

/*
 * Luật THUẦN của luồng tự đăng ký gian hàng (PLAN-0019) — không DB, không Nest — để test thẳng (shop-registration.spec.ts) và để
 * Request DTO + service dùng CHUNG một cách chuẩn hoá (DTO chuẩn hoá trước khi validate, service chuẩn hoá lại phòng khi gọi từ nơi khác;
 * mọi hàm ở đây idempotent nên chuẩn hoá hai lần ra cùng kết quả).
 */

/* SĐT di động Việt Nam dạng chuẩn hoá `0xxxxxxxxx`: đầu số 03x/05x/07x/08x/09x + 8 chữ số (không nhận số bàn 02x). */
export const VN_MOBILE_PHONE_REGEX = /^0[35789]\d{8}$/;

/*
 * Chuẩn hoá SĐT di động VN về `0xxxxxxxxx`. Nhận: có khoảng trắng/dấu chấm/gạch ngang/ngoặc, tiền tố `+84`, `0084` hoặc `84`
 * (chỉ khi đủ 11 chữ số — tránh nuốt nhầm số bắt đầu bằng 84 không phải mã quốc gia). Không hợp lệ ⇒ null.
 */
export function normalizeVnPhone(raw: string): string | null {
  const s = raw.replace(/[\s.\-()]/g, '');
  let national: string;
  if (s.startsWith('+84')) national = `0${s.slice(3)}`;
  else if (s.startsWith('0084')) national = `0${s.slice(4)}`;
  else if (s.startsWith('84') && s.length === 11) national = `0${s.slice(2)}`;
  else national = s;
  return VN_MOBILE_PHONE_REGEX.test(national) ? national : null;
}

/*
 * Cắt đầu/cuối và gộp mọi dãy khoảng trắng liên tiếp thành MỘT dấu cách (tên shop/người đại diện: "  Shop   A " → "Shop A").
 * Chuẩn hoá NFC để cùng một chữ tiếng Việt gõ ở dạng tổ hợp/dựng sẵn không lọt qua kiểm trùng tên.
 */
export function normalizeShopName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/* Trạng thái shop còn "giữ" tên: pending/approved/suspended. Shop `rejected` (đăng ký bị từ chối) nhả tên để người khác/chính họ dùng lại. */
export const SHOP_NAME_RESERVING_STATUSES: readonly string[] = [SHOP_STATUS.PENDING, SHOP_STATUS.APPROVED, SHOP_STATUS.SUSPENDED];

/* Số lần thử hậu tố slug (`-2`, `-3`…) trước khi lùi về slug gắn mã shop (luôn duy nhất). */
export const SHOP_SLUG_MAX_ATTEMPTS = 50;

/* Slug gốc từ tên shop: bỏ dấu tiếng Việt, đ→d, chỉ a-z0-9 nối bằng '-'. Tên toàn ký tự đặc biệt ⇒ 'shop'. */
export function baseShopSlug(name: string): string {
  const slug = slugify(name).replace(/-+$/, '');
  return slug || 'shop';
}

/* Ứng viên slug lần thử thứ `attempt` (1 = slug gốc, 2 ⇒ `<gốc>-2`, 3 ⇒ `<gốc>-3`…). */
export function shopSlugCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/* Slug lùi khi 50 hậu tố đầu đều bị chiếm: gắn mã shop (đã duy nhất) — `<gốc>-shop-000123`. */
export function fallbackShopSlug(base: string, code: string): string {
  return `${base}-${code.toLowerCase()}`;
}

/* Mã shop tuần tự `SHOP-######` (seed dùng SHOP-000001…; SHOP-000001 là FITLY Official — mã hằng của sàn). */
export const SHOP_CODE_PATTERN = /^SHOP-\d{6}$/;

export function shopCodeNumber(code: string): number | null {
  return SHOP_CODE_PATTERN.test(code) ? Number(code.slice(5)) : null;
}

export function formatShopCode(n: number): string {
  return `SHOP-${String(n).padStart(6, '0')}`;
}

/*
 * Mã tiếp theo = max(số lớn nhất đang có, số của FITLY Official) + 1. Chặn sàn dùng lại SHOP-000001 dù DB chưa có dòng nào khớp
 * (DB trống/đã xoá cứng) — mã chính chủ của sàn là hằng cố định, không bao giờ cấp cho vendor.
 */
export function nextShopCode(maxExistingNumber: number): string {
  const official = shopCodeNumber(FITLY_OFFICIAL_SHOP_CODE) ?? 0;
  return formatShopCode(Math.max(maxExistingNumber, official) + 1);
}
