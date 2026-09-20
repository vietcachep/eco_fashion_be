import type { Prisma } from '../../generated/prisma/client';

/*
 * Kiểu "client trong transaction" dùng chung cho service/repository: hàm nhận `tx` để chạy trong transaction
 * của caller (audit + outbox + nghiệp vụ cùng sống cùng chết). Ngoài transaction thì truyền PrismaService.
 */
export type Tx = Prisma.TransactionClient;
export type DbClient = Tx | import('../../generated/prisma/client').PrismaClient;

/* Re-export namespace Prisma (Prisma.sql, Prisma.Decimal, Prisma.empty…) để module không import value từ generated. */
export { Prisma } from '../../generated/prisma/client';
