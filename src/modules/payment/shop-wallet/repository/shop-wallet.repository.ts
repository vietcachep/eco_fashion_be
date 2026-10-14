import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';

export interface WalletRow {
  id: string;
  shopId: string;
  balance: Prisma.Decimal;
}

export interface DepositRow {
  id: string;
  shopId: string;
  amount: Prisma.Decimal;
  status: string;
  proofUrl: string | null;
  note: string | null;
  createdAt: Date;
}

const DEPOSIT_SELECT = { id: true, shopId: true, amount: true, status: true, proofUrl: true, note: true, createdAt: true } as const;

/* Truy cập bảng ví quỹ COD. Mọi thay đổi số dư phải đi qua `lockWallet` (khoá dòng) rồi `applyDelta`. */
@Injectable()
export class ShopWalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  /*
   * Tạo ví nếu chưa có (INSERT … ON CONFLICT DO NOTHING — không làm hỏng transaction khi hai tiến trình cùng tạo) rồi KHOÁ dòng ví
   * (SELECT … FOR UPDATE): mọi thay đổi số dư của cùng shop chạy tuần tự ⇒ không mất cập nhật khi nhiều đơn COD hoàn tất / duyệt nộp quỹ cùng lúc.
   * Chỉ gọi trong transaction; khoá nhả khi commit.
   */
  async lockWallet(tx: Tx, shopId: string): Promise<WalletRow> {
    await tx.$executeRaw`INSERT INTO "payment"."shop_wallets" (id, shop_id, balance, version, created_at, updated_at) VALUES (gen_random_uuid(), ${shopId}::uuid, 0, 0, now(), now()) ON CONFLICT (shop_id) DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ id: string; shop_id: string; balance: Prisma.Decimal | string }>>`SELECT id, shop_id, balance FROM "payment"."shop_wallets" WHERE shop_id = ${shopId}::uuid FOR UPDATE`;
    const r = rows[0];
    return { id: r.id, shopId: r.shop_id, balance: new Prisma.Decimal(r.balance.toString()) };
  }

  /* Đọc ví (không khoá) — màn hình xem số dư. */
  findByShopId(shopId: string): Promise<WalletRow | null> {
    return this.prisma.shopWallet.findUnique({ where: { shopId }, select: { id: true, shopId: true, balance: true } });
  }

  /*
   * Ghi MỘT dòng sổ cái (append-only). Trả false nếu (shopId, type, orderCode) đã tồn tại — `skipDuplicates` = ON CONFLICT DO NOTHING
   * nên KHÔNG làm hỏng transaction của caller (khác bắt P2002) ⇒ sự kiện lặp không trừ hoa hồng hai lần.
   */
  async appendLedger(tx: Tx, e: { walletId: string; shopId: string; type: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; orderCode?: string; note?: string; createdBy?: string }): Promise<boolean> {
    const r = await tx.shopWalletTransaction.createMany({
      data: [{ walletId: e.walletId, shopId: e.shopId, type: e.type, orderCode: e.orderCode ?? null, amount: e.amount, balanceAfter: e.balanceAfter, note: e.note ?? null, createdBy: e.createdBy ?? null }],
      skipDuplicates: true,
    });
    return r.count === 1;
  }

  async setBalance(tx: Tx, walletId: string, balance: Prisma.Decimal): Promise<void> {
    await tx.shopWallet.update({ where: { id: walletId }, data: { balance, version: { increment: 1 } } });
  }

  async listTransactions(shopId: string, skip: number, take: number) {
    const [data, total] = await Promise.all([
      this.prisma.shopWalletTransaction.findMany({ where: { shopId }, select: { id: true, type: true, amount: true, balanceAfter: true, note: true, orderCode: true, createdAt: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.shopWalletTransaction.count({ where: { shopId } }),
    ]);
    return { data, total };
  }

  /* Danh sách ví cho màn sàn (lowOnly = ví ≤ 0 tức COD đang bị khoá), ví thấp nhất trước. */
  async listWallets(lowOnly: boolean, skip: number, take: number) {
    const where = lowOnly ? { balance: { lte: 0 } } : {};
    const [data, total] = await Promise.all([
      this.prisma.shopWallet.findMany({ where, select: { shopId: true, balance: true, updatedAt: true }, orderBy: [{ balance: 'asc' }, { shopId: 'asc' }], skip, take }),
      this.prisma.shopWallet.count({ where }),
    ]);
    return { data, total };
  }

  pendingDeposit(shopId: string, tx?: Tx): Promise<DepositRow | null> {
    return (tx ?? this.prisma).shopWalletDepositRequest.findFirst({ where: { shopId, status: 'pending' }, select: DEPOSIT_SELECT });
  }

  createDeposit(tx: Tx, d: { shopId: string; amount: Prisma.Decimal; proofUrl?: string; note?: string; createdBy: string }): Promise<{ id: string }> {
    return tx.shopWalletDepositRequest.create({ data: { shopId: d.shopId, amount: d.amount, proofUrl: d.proofUrl ?? null, note: d.note ?? null, createdBy: d.createdBy }, select: { id: true } });
  }

  findDeposit(id: string): Promise<DepositRow | null> {
    return this.prisma.shopWalletDepositRequest.findUnique({ where: { id }, select: DEPOSIT_SELECT });
  }

  /* Quyết định yêu cầu nộp quỹ — chỉ khi còn `pending` (updateMany có điều kiện ⇒ hai người duyệt cùng lúc chỉ một người thắng). */
  async decideDeposit(tx: Tx, id: string, status: 'approved' | 'rejected', decidedBy: string, note?: string): Promise<boolean> {
    const r = await tx.shopWalletDepositRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status, decidedBy, decideNote: note ?? null, decidedAt: new Date(), version: { increment: 1 } },
    });
    return r.count === 1;
  }

  async listDeposits(filter: { status?: string; shopId?: string }, skip: number, take: number): Promise<{ data: DepositRow[]; total: number }> {
    const where = { ...(filter.status ? { status: filter.status } : {}), ...(filter.shopId ? { shopId: filter.shopId } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.shopWalletDepositRequest.findMany({ where, select: DEPOSIT_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.shopWalletDepositRequest.count({ where }),
    ]);
    return { data, total };
  }
}
