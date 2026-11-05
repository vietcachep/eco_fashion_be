import { BusinessException } from '@common/exception/business.exception';
import { PAYMENT_ERR } from '../foundation/payment.constants';
import { clipText, customerPayeeOf, maskAccountNumber, normalizeAccountName, normalizeManualProviderRef, normalizePayee, payerAccountOf, resolvePayee } from './refund-payee';

/* Hàm thuần của tài khoản nhận hoàn / mã giao dịch hoàn tay (PLAN-0022 §6.2, §6.4) — không DB, không mạng. */

const NO_CUSTOMER = { payeeBankBin: null, payeeAccountNumber: null, payeeAccountName: null };
const CUSTOMER = { payeeBankBin: '970415', payeeAccountNumber: '1122334455', payeeAccountName: 'TRAN THI BE' };
const PAYER_RESPONSE = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
const payos = (gatewayResponse: unknown) => ({ methodCode: 'payos', gatewayResponse });

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('maskAccountNumber', () => {
  it('chỉ lộ 4 số cuối', () => {
    expect(maskAccountNumber('0011223344')).toBe('****3344');
    expect(maskAccountNumber('123456')).toBe('****3456');
  });
});

describe('normalizeAccountName', () => {
  it('bỏ dấu tiếng Việt (kể cả đ/Đ), in hoa, gộp khoảng trắng', () => {
    expect(normalizeAccountName('  Trần  Thị   Bé ')).toBe('TRAN THI BE');
    expect(normalizeAccountName('đặng Đình Đức')).toBe('DANG DINH DUC');
  });
});

describe('normalizePayee', () => {
  const ok = { bankBin: '970415', accountNumber: '1122334455', accountName: 'Trần Thị Bé' };

  it('chuẩn hoá: số tài khoản bỏ khoảng trắng/chấm/gạch, tên bỏ dấu + in hoa', () => {
    expect(normalizePayee({ ...ok, accountNumber: ' 1122 3344.55-' })).toEqual({ bankBin: '970415', accountNumber: '1122334455', accountName: 'TRAN THI BE' });
  });

  it.each([
    ['BIN thiếu số', { ...ok, bankBin: '97041' }],
    ['BIN dư số', { ...ok, bankBin: '9704155' }],
    ['BIN có chữ', { ...ok, bankBin: '97041a' }],
    ['số tài khoản 5 chữ số', { ...ok, accountNumber: '12345' }],
    ['số tài khoản 20 chữ số', { ...ok, accountNumber: '9'.repeat(20) }],
    ['số tài khoản có chữ', { ...ok, accountNumber: '12ab56' }],
    ['tên rỗng', { ...ok, accountName: '' }],
    ['tên 1 ký tự', { ...ok, accountName: 'A' }],
    ['tên 61 ký tự', { ...ok, accountName: 'A'.repeat(61) }],
    ['tên có ký tự đặc biệt', { ...ok, accountName: 'NGUYEN <VAN>' }],
  ])('%s ⇒ 400 PAYMENT_REFUND_PAYEE_INVALID', (_label, payee) => {
    const err = errorOf(() => normalizePayee(payee));
    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_PAYEE_INVALID, httpStatus: 400 });
  });

  it('thông báo lỗi không lặp lại số tài khoản khách gửi lên', () => {
    const err = errorOf(() => normalizePayee({ ...ok, accountNumber: '9988776655443322110099' })) as BusinessException;
    expect(err.message).not.toContain('9988776655');
  });
});

describe('payerAccountOf / customerPayeeOf / resolvePayee', () => {
  it('payment PayOS có counterAccount* ⇒ tài khoản ĐÃ TRẢ tiền (nguồn payer)', () => {
    expect(payerAccountOf(payos(PAYER_RESPONSE))).toEqual({ source: 'payer', bankBin: '970436', accountNumber: '0011223344', accountName: 'NGUYEN VAN A' });
  });

  it.each([
    ['thiếu số tài khoản', { counterAccountBankId: '970436' }],
    ['thiếu BIN', { counterAccountNumber: '0011223344' }],
    ['số tài khoản rỗng', { counterAccountBankId: '970436', counterAccountNumber: '  ' }],
    ['số tài khoản không phải chuỗi', { counterAccountBankId: '970436', counterAccountNumber: 11223344 }],
    ['BIN không phải chuỗi', { counterAccountBankId: 970436, counterAccountNumber: '0011223344' }],
    ['gatewayResponse rỗng', {}],
    ['gatewayResponse null', null],
  ])('payer: %s ⇒ null', (_label, gr) => {
    expect(payerAccountOf(payos(gr))).toBeNull();
  });

  it('payment KHÔNG phải PayOS (cod / lịch sử) không bao giờ có tài khoản "đã trả" dù dữ liệu có counterAccount*', () => {
    expect(payerAccountOf({ methodCode: 'cod', gatewayResponse: PAYER_RESPONSE })).toBeNull();
    expect(payerAccountOf({ methodCode: 'vnpay', gatewayResponse: PAYER_RESPONSE })).toBeNull();
  });

  it('tên chủ tài khoản đối ứng thiếu ⇒ chuỗi rỗng (không null)', () => {
    expect(payerAccountOf(payos({ counterAccountBankId: '970436', counterAccountNumber: '0011223344' }))?.accountName).toBe('');
  });

  it('khách khai: cần đủ BIN + số tài khoản', () => {
    expect(customerPayeeOf(CUSTOMER)).toEqual({ source: 'customer', bankBin: '970415', accountNumber: '1122334455', accountName: 'TRAN THI BE' });
    expect(customerPayeeOf({ ...CUSTOMER, payeeAccountNumber: null })).toBeNull();
    expect(customerPayeeOf({ ...CUSTOMER, payeeBankBin: null })).toBeNull();
    expect(customerPayeeOf(NO_CUSTOMER)).toBeNull();
  });

  it('thứ tự ưu tiên: tài khoản đã trả → tài khoản khách khai → null (chuyển tay)', () => {
    expect(resolvePayee(CUSTOMER, payos(PAYER_RESPONSE))?.source).toBe('payer');
    expect(resolvePayee(CUSTOMER, payos(null))?.source).toBe('customer');
    expect(resolvePayee(CUSTOMER, { methodCode: 'cod', gatewayResponse: null })?.source).toBe('customer');
    expect(resolvePayee(NO_CUSTOMER, payos(PAYER_RESPONSE))?.source).toBe('payer');
    expect(resolvePayee(NO_CUSTOMER, payos(null))).toBeNull();
    expect(resolvePayee(NO_CUSTOMER, { methodCode: 'cod', gatewayResponse: null })).toBeNull();
  });
});

describe('normalizeManualProviderRef', () => {
  it.each([
    ['FT26102600001', 'FT26102600001'],
    ['  FT26102600001  ', 'FT26102600001'],
    ['2026/10/26-0001', '2026/10/26-0001'],
    ['MBVCB.123456_7:89#1', 'MBVCB.123456_7:89#1'],
    ['abcd', 'abcd'],
    ['x'.repeat(120), 'x'.repeat(120)],
  ])('hợp lệ (%s)', (input, expected) => {
    expect(normalizeManualProviderRef(input)).toBe(expected);
  });

  it.each(['', '   ', 'abc', 'FT 123 456', 'FT123?', '-FT123', '.FT123', 'x'.repeat(121), 'payos-refund:TX-1', 'PayOS-Refund:abc', 'Mã-giao-dịch'])('không hợp lệ (%s) ⇒ 400 COMMON_VALIDATION_ERROR', (input) => {
    const err = errorOf(() => normalizeManualProviderRef(input));
    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR', httpStatus: 400 });
  });
});

describe('resolvePayee — đổi tài khoản sau khi lệnh chi bị từ chối / hiển thị tài khoản đã dùng', () => {
  const both = { payer: payos(PAYER_RESPONSE), customer: CUSTOMER };

  it('lệnh chi TRƯỚC bị từ chối khi dùng payer ⇒ lần sau thử tài khoản khách khai; ngược lại khi customer bị từ chối', () => {
    expect(resolvePayee({ ...CUSTOMER, gatewayStatus: 'failed', payeeSource: 'payer' }, both.payer)?.source).toBe('customer');
    expect(resolvePayee({ ...CUSTOMER, gatewayStatus: 'failed', payeeSource: 'customer' }, both.payer)?.source).toBe('payer');
  });

  it('không có tài khoản còn lại để đổi ⇒ dùng lại tài khoản ưu tiên (lỗi có thể do nguyên nhân khác, vd thiếu số dư)', () => {
    expect(resolvePayee({ ...NO_CUSTOMER, gatewayStatus: 'failed', payeeSource: 'payer' }, both.payer)?.source).toBe('payer');
    expect(resolvePayee({ ...CUSTOMER, gatewayStatus: 'failed', payeeSource: 'customer' }, payos(null))?.source).toBe('customer');
  });

  it('lệnh đã gửi / đang xử lý / đã xong ⇒ đúng tài khoản ĐÃ dùng lúc gửi (payee_source), kể cả khi tài khoản ưu tiên khác', () => {
    for (const gatewayStatus of ['submitted', 'processing', 'succeeded']) {
      expect(resolvePayee({ ...CUSTOMER, gatewayStatus, payeeSource: 'customer' }, both.payer)?.source).toBe('customer');
      expect(resolvePayee({ ...CUSTOMER, gatewayStatus, payeeSource: 'payer' }, both.payer)?.source).toBe('payer');
    }
  });

  it('chưa gửi lệnh nào (gateway_status null) ⇒ ưu tiên mặc định payer → customer dù payee_source là "customer" lúc tạo', () => {
    expect(resolvePayee({ ...CUSTOMER, gatewayStatus: null, payeeSource: 'customer' }, both.payer)?.source).toBe('payer');
  });
});

describe('clipText', () => {
  it('≤ max ký tự ⇒ giữ nguyên; vượt ⇒ cắt còn đúng max ký tự (max − 1 ký tự + "…")', () => {
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('abcd', 3)).toBe('ab…');
    expect(Array.from(clipText('x'.repeat(1000), 255))).toHaveLength(255);
  });

  it('đếm theo ký tự (code point), không cắt đôi emoji; tiếng Việt có dấu tính 1 ký tự', () => {
    expect(clipText('😀😀😀', 3)).toBe('😀😀😀');
    expect(clipText('😀😀😀😀', 3)).toBe('😀😀…');
    expect(clipText('Đổi trả', 7)).toBe('Đổi trả');
  });
});
