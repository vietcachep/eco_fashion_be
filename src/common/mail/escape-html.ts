/*
 * Escape HTML dùng chung cho MỌI email ghép chuỗi do người dùng/shop/nhân viên nhập (lý do huỷ, tên, ghi chú, phản hồi liên hệ…)
 * vào thân thư HTML — PLAN-0028 §2.4 (AUD-11c). Thư HTML không có CSP: một `<script>`/`<img onerror=…>` lọt vào là XSS trên
 * máy đọc thư hoặc lừa đảo (chèn link giả) mạo danh sàn. MỌI giá trị không phải hằng của mã nguồn phải đi qua `escapeHtml`
 * trước khi nối vào template; không tự viết regex thay thế ở nơi khác.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/* Giá trị nguyên thuỷ có thể nối vào HTML. Cố ý KHÔNG nhận object (String(obj) = "[object Object]" là lỗi ngầm) — truyền đúng trường chuỗi cần hiển thị. */
export type HtmlText = string | number | bigint | boolean | null | undefined;

/* Thoát `& < > " ' \`` — dùng được cả cho nội dung văn bản lẫn giá trị thuộc tính (`href="…"`). null/undefined → chuỗi rỗng. */
export function escapeHtml(value: HtmlText): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/* Văn bản nhiều dòng → HTML: escape TRƯỚC rồi mới đổi xuống dòng thành <br> (thứ tự ngược lại sẽ làm hỏng thẻ <br>). */
export function escapeHtmlMultiline(value: HtmlText): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}
