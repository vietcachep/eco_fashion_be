/* Chỉ cho dữ liệu mô phỏng đi qua PayOS mock loopback; hostname gần giống localhost không được chấp nhận. */
export function isLoopbackFinanceEndpoint(endpoint: string, nodeEnv: string): boolean {
  if (nodeEnv === 'production') return false;
  try { const url = new URL(endpoint); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password; } catch { return false; }
}
