import { BusinessException } from '@common/exception/business.exception';
import type { RefundPayee } from '@common/gateway/payment.gateway';
import { GATEWAY_REF_PREFIX, GATEWAY_STATUS, METHOD, PAYEE_SOURCE, PAYMENT_ERR } from '../foundation/payment.constants';

/*
 * Tài khoản nhận tiền hoàn (PLAN-0022 §6.2): chuẩn hoá + kiểm định dạng, che số khi trả ra API, và chọn tài khoản để chi.
 * Hàm thuần (không đụng DB/mạng) để service và test dùng chung. KHÔNG bao giờ log số tài khoản đầy đủ — chỉ dùng `maskAccountNumber`.
 */

/* Tài khoản đã chọn để chi qua PayOS payout (`toBin` + `toAccountNumber`). */
export interface ResolvedPayee {
  source: typeof PAYEE_SOURCE.PAYER | typeof PAYEE_SOURCE.CUSTOMER;
  bankBin: string;
  accountNumber: string;
  accountName: string;
}

/*
 * Cột payee_* của refund (khách khai). `gatewayStatus` + `payeeSource` (tuỳ chọn): lệnh chi trước bị PayOS báo thất bại ⇒ `payeeSource` là tài khoản đã bị từ chối ⇒ lần chạy lại đổi sang tài khoản CÒN LẠI (nếu có).
 */
export interface PayeeColumns {
  payeeBankBin: string | null;
  payeeAccountNumber: string | null;
  payeeAccountName: string | null;
  gatewayStatus?: string | null;
  payeeSource?: string | null;
}

/* Cắt theo KÝ TỰ (code point — như VARCHAR của Postgres, không cắt đôi cặp surrogate); bị cắt thì thêm "…" ở cuối, tổng vẫn ≤ `max`. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/* Số tài khoản chỉ lộ 4 số cuối ra API (cùng kiểu với `bankAccountMasked` của kỳ đối soát). */
export const maskAccountNumber = (n: string): string => `****${n.slice(-4)}`;

/* Bỏ dấu tiếng Việt, in hoa, gộp khoảng trắng — tên chủ tài khoản theo chuẩn ngân hàng (khớp phía khách đã chuẩn hoá giúp). */
export function normalizeAccountName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const invalidPayee = (why: string): BusinessException => new BusinessException(PAYMENT_ERR.REFUND_PAYEE_INVALID, `Tài khoản nhận hoàn tiền không hợp lệ: ${why}`);

/* BIN 6 số (Napas) · số tài khoản 6–19 chữ số (bỏ khoảng trắng/gạch) · tên chủ tài khoản 2–60 ký tự A-Z0-9 . ' - sau khi chuẩn hoá. Sai ⇒ 400 PAYMENT_REFUND_PAYEE_INVALID. */
export function normalizePayee(input: RefundPayee): RefundPayee {
  const bankBin = String(input.bankBin ?? '').trim();
  if (!/^\d{6}$/.test(bankBin)) throw invalidPayee('mã ngân hàng (BIN) phải gồm đúng 6 chữ số');
  const accountNumber = String(input.accountNumber ?? '').replace(/[\s.-]/g, '');
  if (!/^\d{6,19}$/.test(accountNumber)) throw invalidPayee('số tài khoản phải gồm 6–19 chữ số');
  const accountName = normalizeAccountName(String(input.accountName ?? ''));
  if (!/^[A-Z0-9 .'-]{2,60}$/.test(accountName)) throw invalidPayee('tên chủ tài khoản phải từ 2 đến 60 ký tự (chữ không dấu, in hoa)');
  return { bankBin, accountNumber, accountName };
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/* Tài khoản ĐÃ TRẢ tiền: webhook PayOS mang `counterAccount*` (return-query thì không). Chỉ payment PayOS; thiếu BIN hoặc số tài khoản ⇒ null. */
export function payerAccountOf(payment: { methodCode: string; gatewayResponse: unknown }): ResolvedPayee | null {
  if (payment.methodCode !== METHOD.PAYOS) return null;
  const gr = (payment.gatewayResponse ?? {}) as Record<string, unknown>;
  const bankBin = text(gr.counterAccountBankId);
  const accountNumber = text(gr.counterAccountNumber);
  if (!bankBin || !accountNumber) return null;
  return { source: PAYEE_SOURCE.PAYER, bankBin, accountNumber, accountName: text(gr.counterAccountName) ?? '' };
}

/* Tài khoản do khách khai (cột payee_* của refund) — cần đủ BIN + số tài khoản. */
export function customerPayeeOf(r: PayeeColumns): ResolvedPayee | null {
  const bankBin = text(r.payeeBankBin);
  const accountNumber = text(r.payeeAccountNumber);
  if (!bankBin || !accountNumber) return null;
  return { source: PAYEE_SOURCE.CUSTOMER, bankBin, accountNumber, accountName: text(r.payeeAccountName) ?? '' };
}

/*
 * Thứ tự ưu tiên khi chi: tài khoản đã trả tiền → tài khoản khách khai → không có (kế toán chuyển tay).
 * Ngoại lệ: lệnh chi đã gửi/xong ⇒ tài khoản đã dùng (payee_source); lệnh chi trước (gateway_status = failed) bị PayOS từ chối/báo lỗi khi đang dùng tài khoản X ⇒ lần chạy lại thử tài khoản CÒN LẠI nếu có (tài khoản đã trả tiền có thể đã đóng / sai,
 * hoặc ngược lại); không còn tài khoản nào khác thì dùng lại tài khoản ưu tiên (lỗi có thể do nguyên nhân khác như thiếu số dư).
 */
export function resolvePayee(r: PayeeColumns, payment: { methodCode: string; gatewayResponse: unknown }): ResolvedPayee | null {
  const payer = payerAccountOf(payment);
  const customer = customerPayeeOf(r);
  // Lệnh chi đã gửi / đang xử lý / đã xong ⇒ đúng tài khoản ĐÃ dùng lúc gửi (payee_source) — để hiển thị khoản đã chuyển về đâu.
  const sent = r.gatewayStatus === GATEWAY_STATUS.SUBMITTED || r.gatewayStatus === GATEWAY_STATUS.PROCESSING || r.gatewayStatus === GATEWAY_STATUS.SUCCEEDED ? r.payeeSource : null;
  if (sent === PAYEE_SOURCE.PAYER && payer) return payer;
  if (sent === PAYEE_SOURCE.CUSTOMER && customer) return customer;
  const rejected = r.gatewayStatus === GATEWAY_STATUS.FAILED ? r.payeeSource : null;
  if (rejected === PAYEE_SOURCE.PAYER && customer) return customer;
  if (rejected === PAYEE_SOURCE.CUSTOMER && payer) return payer;
  return payer ?? customer;
}

/*
 * Mã giao dịch hoàn tay (providerRef): 4–120 ký tự chữ-số và `. _ : / # -`, bắt đầu bằng chữ/số; KHÔNG mở đầu bằng `payos-refund:` (tiền tố dành cho mã hệ thống sinh khi PayOS xác nhận).
 * Trả về chuỗi đã trim; sai ⇒ 400 COMMON_VALIDATION_ERROR.
 */
export function normalizeManualProviderRef(raw: string): string {
  const ref = raw.trim();
  if (ref.length < 4 || ref.length > 120) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Mã giao dịch hoàn tiền phải từ 4 đến 120 ký tự');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/.test(ref)) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Mã giao dịch hoàn tiền chỉ gồm chữ, số và các ký tự . _ : / # -');
  if (ref.toLowerCase().startsWith(GATEWAY_REF_PREFIX)) throw new BusinessException('COMMON_VALIDATION_ERROR', `Mã giao dịch nhập tay không được mở đầu bằng "${GATEWAY_REF_PREFIX}"`);
  return ref;
}
