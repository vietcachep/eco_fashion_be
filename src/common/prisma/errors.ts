import { Prisma } from '../../generated/prisma/client';

/* Nhận diện lỗi Prisma theo mã (P2002 trùng unique, P2025 không thấy bản ghi…) — dùng ở filter/service. */
export function isPrismaError(e: unknown, code: string): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
}

/*
 * Postgres huỷ MỘT trong hai transaction khoá chéo nhau (40P01 deadlock_detected) hoặc Prisma báo xung đột ghi (P2034). Lỗi tạm thời: thử lại cả transaction là đúng.
 * Nhận diện theo nhiều dạng vì Prisma + driver adapter pg có thể bọc lỗi gốc ở `cause`/`meta`/message tuỳ đường (query model hay `$queryRaw`).
 */
export function isDeadlockError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth += 1) {
    const err = cur as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown }; cause?: unknown };
    if (err.code === 'P2034' || err.code === '40P01' || err.meta?.code === '40P01') return true;
    const text = `${typeof err.message === 'string' ? err.message : ''} ${typeof err.meta?.message === 'string' ? err.meta.message : ''}`;
    if (/deadlock detected|40P01/i.test(text)) return true;
    cur = err.cause;
  }
  return false;
}

/* Chạy `fn` (thường là cả một `$transaction`), gặp deadlock thì chờ ngắn rồi thử lại — tối đa `attempts` lần; lỗi khác hoặc hết lượt thì ném lại nguyên vẹn. */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isDeadlockError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt + Math.floor(Math.random() * 50)));
    }
  }
}

export function prismaErrorTarget(e: Prisma.PrismaClientKnownRequestError): string {
  const t = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}
