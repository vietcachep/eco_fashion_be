import { accountNameMatchesOwner, normalizeAccountHolderName } from './bank-name';

/*
 * PLAN-0040 5.2 — chuẩn hoá + so khớp tên chủ tài khoản ngân hàng với tên chủ shop. Chuẩn hoá phải GIỐNG `normalizeBankAccountName` của web quản trị
 * (NFD, bỏ dấu, đ→d, IN HOA, gộp khoảng trắng) để tên vendor gõ ở form và tên chủ shop có dấu ở hồ sơ cho cùng kết quả.
 */
describe('normalizeAccountHolderName', () => {
  it.each([
    ['Nguyễn Văn A', 'NGUYEN VAN A'],
    ['nguyễn văn a', 'NGUYEN VAN A'],
    ['  Trần   Thị  Bích  ', 'TRAN THI BICH'],
    ['Đặng Văn Đức', 'DANG VAN DUC'], // Đ hoa + đ thường đều → D
    ['đỗ thị đào', 'DO THI DAO'],
    ['Lê Thị Hồng-Ánh', 'LE THI HONG ANH'], // dấu gạch nối coi như khoảng trắng
    ['Phạm Văn B.', 'PHAM VAN B'], // dấu chấm cuối bị bỏ
    ['NGUYEN VAN A', 'NGUYEN VAN A'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeAccountHolderName(raw)).toBe(expected);
  });

  it('tên viết ở dạng tổ hợp (NFD) hay dựng sẵn (NFC) đều ra cùng kết quả', () => {
    const nfc = 'Nguyễn Văn A'.normalize('NFC');
    const nfd = 'Nguyễn Văn A'.normalize('NFD');

    expect(normalizeAccountHolderName(nfc)).toBe(normalizeAccountHolderName(nfd));
  });
});

describe('accountNameMatchesOwner', () => {
  it('khớp khi bằng nhau sau chuẩn hoá (khác dấu / hoa-thường / khoảng trắng)', () => {
    expect(accountNameMatchesOwner('NGUYEN VAN A', 'Nguyễn Văn A')).toBe(true);
    expect(accountNameMatchesOwner('nguyen  van a', 'NGUYỄN VĂN A')).toBe(true);
    expect(accountNameMatchesOwner('DANG VAN DUC', 'Đặng Văn Đức')).toBe(true);
  });

  it('KHÔNG khớp khi khác người, khác thứ tự, thiếu/thừa từ (so nghiêm ngặt — ca đặc biệt để quản lý xác minh tay)', () => {
    expect(accountNameMatchesOwner('KE GIAN LAN', 'Nguyễn Văn A')).toBe(false);
    expect(accountNameMatchesOwner('VAN A NGUYEN', 'Nguyễn Văn A')).toBe(false);
    expect(accountNameMatchesOwner('NGUYEN VAN', 'Nguyễn Văn A')).toBe(false);
    expect(accountNameMatchesOwner('NGUYEN VAN A B', 'Nguyễn Văn A')).toBe(false);
  });

  it('thiếu một trong hai tên (hoặc chỉ toàn ký tự đặc biệt) ⇒ KHÔNG khớp — không đủ căn cứ coi là chính chủ', () => {
    expect(accountNameMatchesOwner('NGUYEN VAN A', null)).toBe(false);
    expect(accountNameMatchesOwner(null, 'Nguyễn Văn A')).toBe(false);
    expect(accountNameMatchesOwner('', '')).toBe(false);
    expect(accountNameMatchesOwner('---', '...')).toBe(false);
  });
});
