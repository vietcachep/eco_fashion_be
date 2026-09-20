/*
 * Slug tiếng Việt cho URL: bỏ dấu (NFD), đ→d, còn lại a-z0-9 nối bằng '-'.
 * Không dùng thư viện: chỉ cần tiếng Việt + ASCII (dự án đơn ngữ).
 */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/*
 * Mã SKU ổn định từ slug + mã màu + size: `<8 ký tự đầu của slug không gạch><4 hex băm slug>-<MÀU>-<SIZE>`.
 * Băm để hai slug cùng 8 ký tự đầu (ao-so-mi-nu-tay-phong / ao-so-mi-nu-form-rong) không đụng nhau; mã màu (không phải tên)
 * để 'xanh' và 'xanhla' khác nhau. Dùng chung cho ProductService và seed.
 */
export function makeSku(slug: string, colorCode: string, sizeCode: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const abbr = unaccent(slug).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return `${abbr}${h.toString(16).toUpperCase().padStart(8, '0').slice(-4)}-${colorCode.toUpperCase()}-${sizeCode.toUpperCase()}`;
}

/* Bỏ dấu để so khớp/tìm kiếm (giữ chữ hoa/thường như đầu vào). */
export function unaccent(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
