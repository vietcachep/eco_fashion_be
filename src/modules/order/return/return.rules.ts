import { BusinessException } from '@common/exception/business.exception';
import { vnd } from '@common/utils/money';
import { ORDER_ERR, RETURN_DEADLINE_KIND, RETURN_EVIDENCE_MAX, RETURN_REJECTED_BY, RETURN_STATUS } from '../foundation/order.constants';

/*
 * Luật THUẦN của đổi trả (PLAN-0022) — không đụng DB/mạng/giờ hệ thống (giờ truyền vào) để service, mapper và test dùng chung:
 * kiểm minh chứng, chuẩn hoá tài khoản nhận hoàn, tính số tiền hoàn theo tỉ lệ, hạn chót + cờ hành động của khách.
 * Tài khoản nhận hoàn PHẢI khớp (hoặc chặt hơn) bộ kiểm của payment (refund-payee.ts): sai định dạng bị chặn ngay lúc khách tạo yêu cầu,
 * không để tới lúc shop xác nhận nhận hàng mới vỡ trong transaction hoàn tiền.
 */

/* Kiểu `type` (không phải interface) để gán thẳng vào cột Json của Prisma mà không cần ép kiểu. */
export type MediaItem = {
  type: 'image' | 'video';
  url: string;
  name: string;
};

/* Thứ cần để biết URL nào thuộc kho upload của hệ thống (đọc từ env ở service). */
export interface EvidenceHostContext {
  /* EF_CLOUDINARY_CLOUD_NAME — rỗng = chưa cấu hình Cloudinary (ảnh lưu cục bộ). */
  cloudinaryCloudName: string;
  /* EF_API_PUBLIC_URL — origin của API, nơi phục vụ `/static/uploads/**` (kho cục bộ). */
  apiPublicUrl: string;
}

const LOCAL_UPLOAD_PATH = /^\/static\/uploads\/[A-Za-z0-9._\-/]+$/;

/*
 * URL minh chứng chỉ nhận từ KHO UPLOAD của hệ thống (POST /uploads/media trả về): Cloudinary của chính cloud đã cấu hình
 * (`https://res.cloudinary.com/<cloud>/…`), hoặc `/static/uploads/…` của API (đường dẫn tương đối khi lưu cục bộ, hoặc tuyệt đối https
 * cùng origin với EF_API_PUBLIC_URL). Chặn URL bất kỳ: ảnh tracking/độc hại, http thường, `javascript:`, host lạ, kèm user:pass.
 */
export function isTrustedEvidenceUrl(raw: string, ctx: EvidenceHostContext): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return false;
  if (raw.startsWith('/')) return LOCAL_UPLOAD_PATH.test(raw) && !raw.includes('..');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443')) return false;
  if (u.pathname.includes('..')) return false;
  // Chỉ kiểu giao `upload` của ảnh/video MÌNH tải lên (POST /uploads/media) — chặn `fetch` (Cloudinary tự kéo URL ngoài), `private`, `authenticated`, `raw`… của cùng cloud.
  if (ctx.cloudinaryCloudName && u.hostname === 'res.cloudinary.com') return u.pathname.startsWith(`/${ctx.cloudinaryCloudName}/image/upload/`) || u.pathname.startsWith(`/${ctx.cloudinaryCloudName}/video/upload/`);
  try {
    const api = new URL(ctx.apiPublicUrl);
    return api.protocol === 'https:' && u.origin === api.origin && LOCAL_UPLOAD_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/*
 * Kiểm + chuẩn hoá danh sách minh chứng: tối đa RETURN_EVIDENCE_MAX tệp, loại `image|video`, URL thuộc kho upload. `required` = cần ≥ 1 tệp
 * (EVIDENCE_REQUIRED khi thiếu). Trả mảng mới đã cắt khoảng trắng (không giữ field lạ).
 */
export function normalizeEvidence(input: ReadonlyArray<{ type?: unknown; url?: unknown; name?: unknown }> | undefined, ctx: EvidenceHostContext, opts: { required: boolean }): MediaItem[] {
  const list = input ?? [];
  if (opts.required && list.length === 0) throw new BusinessException(ORDER_ERR.EVIDENCE_REQUIRED, 'Cần ít nhất một ảnh/video minh chứng');
  if (list.length > RETURN_EVIDENCE_MAX) throw new BusinessException(ORDER_ERR.RETURN_EVIDENCE_INVALID, `Tối đa ${RETURN_EVIDENCE_MAX} ảnh/video minh chứng`);
  return list.map((m) => {
    if (m.type !== 'image' && m.type !== 'video') throw new BusinessException(ORDER_ERR.RETURN_EVIDENCE_INVALID, 'Minh chứng chỉ nhận ảnh hoặc video');
    const url = typeof m.url === 'string' ? m.url.trim() : '';
    if (!isTrustedEvidenceUrl(url, ctx)) throw new BusinessException(ORDER_ERR.RETURN_EVIDENCE_INVALID, 'Minh chứng phải là tệp đã tải lên hệ thống (POST /uploads/media) — không nhận đường dẫn bên ngoài');
    const name = (typeof m.name === 'string' ? m.name.trim() : '').slice(0, 200) || 'minh-chung';
    return { type: m.type, url, name };
  });
}

// ---------------------------------------------------------------------- tài khoản nhận hoàn

/* Tài khoản nhận tiền hoàn do khách khai — lưu trong `return_requests.refund_account`. Số đầy đủ CHỈ để chuyển cho payment, response luôn che. */
export type RefundAccount = {
  bankBin: string;
  bankName?: string;
  accountNumber: string;
  accountName: string;
};

/* Số tài khoản chỉ lộ 4 số cuối (cùng dạng `****1234` với payment/refund-payee). */
export const maskAccountNumber = (n: string): string => `****${n.slice(-4)}`;

/* Bỏ dấu tiếng Việt, in hoa, gộp khoảng trắng — tên chủ tài khoản theo chuẩn ngân hàng (chuẩn hoá giúp khách). */
export function normalizeAccountName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const invalidAccount = (why: string): BusinessException => new BusinessException(ORDER_ERR.RETURN_REFUND_ACCOUNT_INVALID, `Tài khoản nhận hoàn tiền không hợp lệ: ${why}`);

/* BIN 6 số (Napas) · số tài khoản 6–19 chữ số (bỏ khoảng trắng/gạch/chấm) · tên chủ tài khoản 2–60 ký tự A-Z0-9 . ' - sau chuẩn hoá. Sai ⇒ 400 ORDER_RETURN_REFUND_ACCOUNT_INVALID. */
export function normalizeRefundAccount(input: { bankBin?: unknown; bankName?: unknown; accountNumber?: unknown; accountName?: unknown }): RefundAccount {
  const bankBin = str(input.bankBin).trim();
  if (!/^\d{6}$/.test(bankBin)) throw invalidAccount('mã ngân hàng (BIN) phải gồm đúng 6 chữ số');
  const accountNumber = str(input.accountNumber).replace(/[\s.-]/g, '');
  if (!/^\d{6,19}$/.test(accountNumber)) throw invalidAccount('số tài khoản phải gồm 6–19 chữ số');
  const accountName = normalizeAccountName(str(input.accountName));
  if (!/^[A-Z0-9 .'-]{2,60}$/.test(accountName)) throw invalidAccount('tên chủ tài khoản phải từ 2 đến 60 ký tự (chữ không dấu, in hoa)');
  const bankName = typeof input.bankName === 'string' && input.bankName.trim() !== '' ? input.bankName.trim().slice(0, 100) : undefined;
  return { bankBin, ...(bankName ? { bankName } : {}), accountNumber, accountName };
}

/* Đọc lại tài khoản đã lưu (JSON) — null khi thiếu/sai dạng (dữ liệu cũ chưa có). */
export function readRefundAccount(raw: unknown): RefundAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.bankBin !== 'string' || typeof o.accountNumber !== 'string' || typeof o.accountName !== 'string') return null;
  return { bankBin: o.bankBin, ...(typeof o.bankName === 'string' ? { bankName: o.bankName } : {}), accountNumber: o.accountNumber, accountName: o.accountName };
}

// ---------------------------------------------------------------------- địa chỉ trả hàng

export type ReturnAddress = {
  name: string;
  phone: string;
  address: string;
};

export function readReturnAddress(raw: unknown): ReturnAddress | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.phone !== 'string' || typeof o.address !== 'string') return null;
  return { name: o.name, phone: o.phone, address: o.address };
}

// ---------------------------------------------------------------------- số tiền

/* Lý do gửi sang payment (cột VARCHAR(255) bên đó): cắt PHẦN LÝ DO để tiền tố/hậu tố cố định luôn còn nguyên, tổng không quá 255 ký tự. */
export function refundReason(prefix: string, text: string, suffix = ''): string {
  return `${prefix}${text.slice(0, Math.max(0, 255 - prefix.length - suffix.length))}${suffix}`;
}

/*
 * Giá trị setting hạn chót đọc từ DB có thể sai (NaN, âm, 0, quá lớn) — kẹp vào khoảng hợp lý để KHÔNG BAO GIỜ tạo Invalid Date hay chuyển bước ngay lập tức:
 * giờ ∈ [1, 8760], ngày ∈ [1, 365]; không phải số hữu hạn ⇒ dùng mặc định. (Ghi qua API cũng bị chặn cùng khoảng ở SettingService.)
 */
export function boundedSetting(value: number, unit: 'hours' | 'days', fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const max = unit === 'hours' ? 24 * 365 : 365;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/*
 * Hoàn theo TỈ LỆ hàng trả trên tổng tiền khách ĐÃ TRẢ (gồm phí ship, đã trừ mọi voucher): hoàn đủ ⇒ đúng bằng `total`. Cách trừ discount/subtotal hoàn thiếu khi
 * có voucher freeship (discount gồm cả phần ship nhưng chia cho subtotal không gồm ship) và lệch với đối soát (đảo doanh thu theo tỉ lệ trên total).
 * Làm tròn XUỐNG đồng; không bao giờ vượt `total`.
 */
export function proportionalRefund(lines: ReadonlyArray<{ unitPrice: bigint; quantity: number }>, subtotal: bigint, total: bigint): bigint {
  let refund = lines.reduce((s, l) => s + l.unitPrice * BigInt(l.quantity), 0n);
  if (subtotal > 0n) refund = (refund * total) / subtotal;
  return refund > total ? total : refund;
}

/* Tổng hợp tiền: shop chỉ được GIẢM số tiền tính sẵn (và phải nêu lý do); trả về số tiền cuối + lý do cần lưu (null khi không đổi). */
export function resolveShopRefundAmount(calculated: bigint, requested: string | undefined, adjustReason: string | undefined): { amount: bigint; adjustReason: string | null } {
  if (requested === undefined) return { amount: calculated, adjustReason: null };
  const amount = vnd(requested);
  if (amount <= 0n) throw new BusinessException(ORDER_ERR.RETURN_REFUND_TOO_HIGH, 'Số tiền hoàn phải lớn hơn 0 — muốn không hoàn thì hãy từ chối yêu cầu');
  if (amount > calculated) throw new BusinessException(ORDER_ERR.RETURN_REFUND_TOO_HIGH, 'Shop chỉ được giảm số tiền hoàn, không được tăng so với số hệ thống đã tính');
  if (amount === calculated) return { amount, adjustReason: null };
  const reason = adjustReason?.trim() ?? '';
  if (reason.length < 5) throw new BusinessException(ORDER_ERR.RETURN_ADJUST_REASON_REQUIRED, 'Giảm số tiền hoàn phải kèm lý do (adjustReason)');
  return { amount, adjustReason: reason };
}

// ---------------------------------------------------------------------- hạn chót + cờ hành động của khách

/* Phần của dòng yêu cầu mà hạn/cờ cần (không phụ thuộc kiểu Prisma để test dựng nhanh). */
export interface ReturnStateView {
  status: string;
  requireReturn: boolean;
  rejectedBy: string | null;
  shippedBackAt: Date | null;
  shopRespondDueAt: Date | null;
  shipBackDueAt: Date | null;
  shopReceiveDueAt: Date | null;
  escalateDueAt: Date | null;
}

export type ReturnDeadlineKind = (typeof RETURN_DEADLINE_KIND)[keyof typeof RETURN_DEADLINE_KIND];

/* Hạn của bước ĐANG CHỜ: chờ shop duyệt → khách gửi hàng trả → shop xác nhận nhận hàng; bị shop từ chối → hạn khiếu nại. Không còn bước chờ ⇒ cả hai null. */
export function deadlineOf(r: ReturnStateView): { at: Date | null; kind: ReturnDeadlineKind | null } {
  const pick = (at: Date | null, kind: ReturnDeadlineKind) => (at ? { at, kind } : { at: null, kind: null });
  if (r.status === RETURN_STATUS.REQUESTED) return pick(r.shopRespondDueAt, RETURN_DEADLINE_KIND.SHOP_RESPOND);
  if (r.status === RETURN_STATUS.APPROVED && r.requireReturn) return r.shippedBackAt ? pick(r.shopReceiveDueAt, RETURN_DEADLINE_KIND.SHOP_RECEIVE) : pick(r.shipBackDueAt, RETURN_DEADLINE_KIND.SHIP_BACK);
  if (r.status === RETURN_STATUS.REJECTED && r.rejectedBy === RETURN_REJECTED_BY.SHOP) return pick(r.escalateDueAt, RETURN_DEADLINE_KIND.ESCALATE);
  return { at: null, kind: null };
}

/* Khách rút được khi chưa gửi hàng: đang chờ shop duyệt, hoặc đã duyệt nhưng chưa báo gửi. */
export function canCancel(r: ReturnStateView): boolean {
  return r.status === RETURN_STATUS.REQUESTED || (r.status === RETURN_STATUS.APPROVED && !r.shippedBackAt);
}

/* Khách báo đã gửi hàng trả: đã duyệt + cần trả hàng + chưa báo + còn trong hạn gửi. */
export function canShipBack(r: ReturnStateView, now: Date): boolean {
  return r.status === RETURN_STATUS.APPROVED && r.requireReturn && !r.shippedBackAt && (!r.shipBackDueAt || now.getTime() <= r.shipBackDueAt.getTime());
}

/* Khách khiếu nại lên sàn: chỉ khi SHOP từ chối (sàn từ chối là quyết định cuối) và còn trong hạn khiếu nại. */
export function canEscalate(r: ReturnStateView, now: Date): boolean {
  return r.status === RETURN_STATUS.REJECTED && r.rejectedBy === RETURN_REJECTED_BY.SHOP && !!r.escalateDueAt && now.getTime() <= r.escalateDueAt.getTime();
}
