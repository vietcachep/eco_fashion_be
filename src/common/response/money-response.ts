import { ApiProperty } from '@nestjs/swagger';
import { formatVnd, Vnd, vnd } from '../utils/money';

/*
 * Một khoản tiền như API trả cho FE (Money Rule của FE bán hàng: FE CHỈ format, không tính lại).
 * `amount` là chuỗi số nguyên VND ("159000"), `display` đã định dạng ("159.000 ₫"). Web chỉ VND nhưng giữ
 * currency/symbol để hợp đồng ổn định nếu sau này cần.
 */
export class MoneyResponse {
  @ApiProperty({ example: '159000' }) amount: string;
  @ApiProperty({ example: '159.000 ₫' }) display: string;
  @ApiProperty({ example: 'VND' }) currency: string;
  @ApiProperty({ example: '₫' }) symbol: string;
}

export function money(value: Vnd | string | number | null | undefined): MoneyResponse {
  const n = vnd(value);
  return { amount: n.toString(), display: formatVnd(n), currency: 'VND', symbol: '₫' };
}

export function moneyOrNull(value: Vnd | string | number | null | undefined): MoneyResponse | null {
  return value === null || value === undefined ? null : money(value);
}
