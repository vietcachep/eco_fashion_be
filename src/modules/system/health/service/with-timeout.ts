/*
 * Giới hạn thời gian cho một lời gọi kiểm tra hạ tầng: healthcheck bị load balancer/compose gọi mỗi 15 giây nên KHÔNG được treo
 * chờ DB/Redis phản hồi (timeout kết nối mặc định của driver có thể vài chục giây). Hết hạn ⇒ ném lỗi, người gọi coi như DOWN.
 * Lời gọi gốc vẫn chạy tiếp ở nền (không huỷ được) — chấp nhận được vì chỉ là `SELECT 1` / `PING` / `GET`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'health-check'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} quá ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
