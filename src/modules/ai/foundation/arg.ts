/* Ép tham số tool (unknown) về chuỗi an toàn — model có thể gửi số/null/object. */
export function argStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}
