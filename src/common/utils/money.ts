/*
 * Tiền VND: DB numeric(14,0) → driver pg trả CHUỖI. Mọi phép cộng trừ dùng bigint, không float.
 * DTO trả tiền dạng chuỗi số nguyên ("159000") + `display` ("159.000 ₫") để FE khỏi tự format sai.
 */
export type Vnd = bigint;

export function vnd(value: string | number | bigint | null | undefined): Vnd {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  const s = String(value).trim();
  const dot = s.indexOf('.');
  return BigInt(dot >= 0 ? s.slice(0, dot) : s);
}

export function vndToString(value: Vnd): string {
  return value.toString();
}

export function formatVnd(value: Vnd | string | number): string {
  const n = vnd(value);
  const sign = n < 0n ? '-' : '';
  const digits = (n < 0n ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${digits} ₫`;
}

/* Phần trăm của số tiền, làm tròn xuống đơn vị đồng (không bao giờ giảm quá số tiền gốc). */
export function percentOf(amount: Vnd, percent: number): Vnd {
  const p = BigInt(Math.round(percent * 100));
  return (amount * p) / 10000n;
}

export function minVnd(a: Vnd, b: Vnd): Vnd {
  return a < b ? a : b;
}
