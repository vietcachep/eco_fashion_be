/*
 * So khớp TÊN CHỦ TÀI KHOẢN NGÂN HÀNG với TÊN CHỦ SHOP (PLAN-0026 §2.5 / PLAN-0040 5.2): ngân hàng in tên IN HOA không dấu ("NGUYEN VAN A") còn hồ sơ tài khoản chủ shop lưu tên có dấu ("Nguyễn Văn A").
 * Chuẩn hoá giống `normalizeBankAccountName` của web quản trị (NFD → bỏ dấu → đ→d → IN HOA → gộp khoảng trắng) + coi dấu câu (`.`, `-`, `,`…) là khoảng trắng để "Nguyễn Thị Hồng-Ánh"
 * khớp "NGUYEN THI HONG ANH". So khớp NGHIÊM NGẶT (bằng nhau sau chuẩn hoá, không đoán thứ tự/viết tắt): ca đặc biệt (tài khoản công ty, tên đệm khác) để quản lý sàn xác minh tay thay vì tự nới lỏng.
 */

/* Bỏ dấu tiếng Việt + IN HOA + chỉ giữ chữ/số (ký tự khác → khoảng trắng) + gộp khoảng trắng + cắt đầu/đuôi. */
export function normalizeAccountHolderName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/* Tên chủ TK khớp tên chủ shop? Thiếu một trong hai (chủ shop không còn tra được, tên rỗng) ⇒ KHÔNG khớp — không đủ căn cứ để tự coi là chính chủ. */
export function accountNameMatchesOwner(bankAccountName: string | null | undefined, ownerFullName: string | null | undefined): boolean {
  if (!bankAccountName || !ownerFullName) return false;
  const a = normalizeAccountHolderName(bankAccountName);
  const b = normalizeAccountHolderName(ownerFullName);
  return a.length > 0 && a === b;
}
