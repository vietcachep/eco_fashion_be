import { Prisma } from '../../generated/prisma/client';

/* Nhận diện lỗi Prisma theo mã (P2002 trùng unique, P2025 không thấy bản ghi…) — dùng ở filter/service. */
export function isPrismaError(e: unknown, code: string): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
}

export function prismaErrorTarget(e: Prisma.PrismaClientKnownRequestError): string {
  const t = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}
