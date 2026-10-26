import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { DEPOSIT_STATUS, WALLET_AUDIT, WALLET_ERR, WALLET_TX_TYPE } from '../foundation/payment.constants';

type Dec = Prisma.Decimal;
type WalletTxType = (typeof WALLET_TX_TYPE)[keyof typeof WALLET_TX_TYPE];

const D = (v: string | number | Dec): Dec => new Prisma.Decimal(v);
const round0 = (d: Dec): Dec => d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
/* Dòng hoàn tiền định danh bằng id hoàn tiền (VarChar(30)): "RF-" + 26 ký tự hex đầu của uuid — cùng quy ước với dòng hoàn của đối soát. */
const refundKey = (refundId: string) => `RF-${refundId.replace(/-/g, '').slice(0, 26)}`;

/*
 * Ví đặt cọc COD của gian hàng (PLAN-0020).
 *  - Shop CHỈ bán được COD khi ví `balance > 0` (riêng gian hàng chính chủ của sàn được miễn). Về 0 hoặc âm ⇒ COD đóng cho đơn MỚI; đơn đang giao không bị huỷ.
 *  - Nạp cọc: shop chuyển khoản cho sàn rồi gửi yêu cầu (số tiền + mã giao dịch); kế toán sàn đối chiếu → duyệt (cộng ví) hoặc từ chối. Mỗi shop một yêu cầu chờ duyệt.
 *  - Đơn COD giao thành công (sàn xác nhận đã thu): tự trừ hoa hồng của đơn khỏi ví — có thể làm ví ÂM; khoản nộp thêm sau đó cộng đại số nên bù luôn số âm
 *    (nạp vừa đủ trả nợ mà không dư thì COD vẫn khoá).
 *  - Hoàn tiền đơn COD đã thu: trừ ví đúng số hoàn khách rồi cộng lại phần hoa hồng tương ứng.
 * Mọi biến động ghi sổ cái chỉ-thêm trong CÙNG transaction, dưới KHOÁ dòng ví; (shop, loại, mã đơn) UNIQUE nên một đơn không bị trừ hai lần.
 */
@Injectable()
export class ShopWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shops: ShopQueryApi,
    private readonly system: SystemQueryApi,
    private readonly audit: PaymentAuditLogService,
  ) {}

  // ------------------------------------------------------------------ cổng cho order (checkout)

  /* Shop nào được bán COD: gian hàng chính chủ của sàn, hoặc ví còn dương. Trả Map shopId → true/false cho đúng các shop truyền vào. */
  async codAvailability(shopIds: string[], tx?: Tx): Promise<Map<string, boolean>> {
    const uniq = [...new Set(shopIds)];
    const out = new Map<string, boolean>(uniq.map((id) => [id, false]));
    if (uniq.length === 0) return out;
    const db = tx ?? this.prisma;
    const [rows, official] = await Promise.all([db.shopCodWallet.findMany({ where: { shopId: { in: uniq } }, select: { shopId: true, balance: true } }), this.shops.findOfficialShopId()]);
    for (const r of rows) out.set(r.shopId, r.balance.gt(0));
    if (official && out.has(official)) out.set(official, true);
    return out;
  }

  // ------------------------------------------------------------------ đọc

  async getWallet(shopId: string) {
    const [wallet, pending, minDeposit, instructions, official] = await Promise.all([
      this.prisma.shopCodWallet.findUnique({ where: { shopId } }),
      this.prisma.shopCodDeposit.findFirst({ where: { shopId, status: DEPOSIT_STATUS.PENDING }, orderBy: { createdAt: 'desc' } }),
      this.system.settingNumber(SETTING_KEY.WALLET_MIN_DEPOSIT),
      this.system.setting<string>(SETTING_KEY.WALLET_DEPOSIT_INSTRUCTIONS),
      this.shops.findOfficialShopId(),
    ]);
    const balance = wallet?.balance ?? D(0);
    return { shopId, balance, codEnabled: official === shopId || balance.gt(0), exempt: official === shopId, pendingDeposit: pending, minDeposit, instructions: instructions ?? '' };
  }

  async listTransactions(shopId: string, skip: number, take: number) {
    const where = { shopId };
    const [items, total] = await Promise.all([this.prisma.shopCodWalletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.shopCodWalletTransaction.count({ where })]);
    return { items, total };
  }

  async listDeposits(filter: { shopId?: string; status?: string }, skip: number, take: number) {
    const where: Prisma.ShopCodDepositWhereInput = { ...(filter.shopId ? { shopId: filter.shopId } : {}), ...(filter.status ? { status: filter.status } : {}) };
    const [items, total] = await Promise.all([this.prisma.shopCodDeposit.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.shopCodDeposit.count({ where })]);
    return { items, total };
  }

  /* Danh sách ví phía sàn. `lowOnly` = chỉ ví ≤ 0 (COD đang đóng). */
  async listWallets(filter: { lowOnly?: boolean }, skip: number, take: number) {
    const where: Prisma.ShopCodWalletWhereInput = filter.lowOnly ? { balance: { lte: 0 } } : {};
    const [items, total] = await Promise.all([this.prisma.shopCodWallet.findMany({ where, orderBy: [{ balance: 'asc' }, { shopId: 'asc' }], skip, take }), this.prisma.shopCodWallet.count({ where })]);
    return { items, total };
  }

  async shopNames(shopIds: string[]): Promise<Map<string, string>> {
    const briefs = await this.shops.findManyBrief(shopIds);
    return new Map([...briefs].map(([id, b]) => [id, b.name]));
  }

  // ------------------------------------------------------------------ nộp cọc

  async requestDeposit(actor: AuthenticatedActor, shopId: string, input: { amount: bigint; transferRef: string; note?: string }) {
    const min = await this.system.settingNumber(SETTING_KEY.WALLET_MIN_DEPOSIT);
    if (input.amount < BigInt(min)) throw new BusinessException(WALLET_ERR.DEPOSIT_TOO_SMALL, `Số tiền nộp tối thiểu ${min.toLocaleString('vi-VN')}đ`);
    return this.prisma.$transaction(async (tx) => {
      await this.lockWallet(tx, shopId); // tuần tự hoá hai yêu cầu đồng thời của cùng shop
      const exists = await tx.shopCodDeposit.findFirst({ where: { shopId, status: DEPOSIT_STATUS.PENDING }, select: { id: true } });
      if (exists) throw new BusinessException(WALLET_ERR.DEPOSIT_PENDING_EXISTS, 'Đang có một yêu cầu nộp cọc chờ sàn duyệt — chờ xử lý xong rồi gửi tiếp', HttpStatus.CONFLICT);
      const row = await tx.shopCodDeposit.create({ data: { shopId, amount: input.amount.toString(), transferRef: input.transferRef.trim(), note: input.note?.trim() || null, requestedBy: actor.userId } });
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_REQUESTED, entityType: 'shop_cod_deposit', entityId: row.id, after: { shopId, amount: input.amount.toString(), transferRef: row.transferRef } });
      return row;
    });
  }

  /* Duyệt: cộng đại số vào ví (nợ âm được bù trước). Compare-and-set pending → approved dưới khoá ví ⇒ bấm đúp chỉ cộng một lần. */
  async approveDeposit(actor: AuthenticatedActor, depositId: string) {
    return this.prisma.$transaction(async (tx) => {
      const dep = await tx.shopCodDeposit.findUnique({ where: { id: depositId } });
      if (!dep) throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy yêu cầu nộp cọc');
      await this.lockWallet(tx, dep.shopId);
      const won = await tx.shopCodDeposit.updateMany({ where: { id: depositId, status: DEPOSIT_STATUS.PENDING }, data: { status: DEPOSIT_STATUS.APPROVED, reviewedBy: actor.userId, reviewedAt: new Date() } });
      if (won.count === 0) throw new BusinessException(WALLET_ERR.INVALID_STATE, 'Yêu cầu đã được xử lý — tải lại', HttpStatus.CONFLICT);
      const { balanceAfter } = await this.post(tx, dep.shopId, WALLET_TX_TYPE.DEPOSIT, D(dep.amount), { depositId, note: `Nộp cọc ${dep.transferRef}`, createdBy: actor.userId });
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_APPROVED, entityType: 'shop_cod_deposit', entityId: depositId, after: { shopId: dep.shopId, amount: dep.amount.toString(), balanceAfter: balanceAfter.toString() } });
      return tx.shopCodDeposit.findUniqueOrThrow({ where: { id: depositId } });
    });
  }

  async rejectDeposit(actor: AuthenticatedActor, depositId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const won = await tx.shopCodDeposit.updateMany({ where: { id: depositId, status: DEPOSIT_STATUS.PENDING }, data: { status: DEPOSIT_STATUS.REJECTED, rejectReason: reason.trim(), reviewedBy: actor.userId, reviewedAt: new Date() } });
      if (won.count === 0) {
        const cur = await tx.shopCodDeposit.findUnique({ where: { id: depositId }, select: { id: true } });
        if (!cur) throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy yêu cầu nộp cọc');
        throw new BusinessException(WALLET_ERR.INVALID_STATE, 'Yêu cầu đã được xử lý — tải lại', HttpStatus.CONFLICT);
      }
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_REJECTED, entityType: 'shop_cod_deposit', entityId: depositId, after: { reason } });
      return tx.shopCodDeposit.findUniqueOrThrow({ where: { id: depositId } });
    });
  }

  /* Sàn chỉnh ví tay (cộng/trừ) — bắt buộc lý do. */
  async adjust(actor: AuthenticatedActor, shopId: string, amount: bigint, note: string) {
    if (!(await this.shops.findBrief(shopId))) throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy gian hàng');
    return this.prisma.$transaction(async (tx) => {
      await this.lockWallet(tx, shopId);
      const r = await this.post(tx, shopId, WALLET_TX_TYPE.ADJUST, D(amount.toString()), { note: note.trim(), createdBy: actor.userId });
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.ADJUSTED, entityType: 'shop_cod_wallet', entityId: r.walletId, after: { shopId, amount: amount.toString(), balanceAfter: r.balanceAfter.toString(), note } });
      return r;
    });
  }

  // ------------------------------------------------------------------ tự động trừ (gọi từ payment trong CÙNG tx)

  /* Đơn COD thu tiền thành công ⇒ trừ hoa hồng của đơn. Idempotent theo (shop, cod_commission, mã đơn). Hoa hồng có thể ÂM (voucher sàn chịu lớn) ⇒ cộng lại ví. */
  async applyCodCommission(tx: Tx, input: { shopId: string; orderCode: string; gross: bigint; commissionRate: string }): Promise<void> {
    const gross = D(input.gross.toString());
    const commission = round0(gross.mul(D(input.commissionRate)).div(100));
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: input.orderCode }, select: { id: true } });
    if (done) return;
    await this.post(tx, input.shopId, WALLET_TX_TYPE.COD_COMMISSION, commission.neg(), {
      orderCode: input.orderCode,
      note: `Hoa hồng đơn COD ${input.orderCode}`,
      meta: { gross: gross.toFixed(0), commission: commission.toFixed(0), rate: input.commissionRate },
    });
  }

  /* Hoàn tiền đơn COD đã thu: sàn trả khách nên trừ ví số hoàn, cộng lại phần hoa hồng tương ứng (theo tỉ lệ số hoàn / doanh thu của đơn). Idempotent theo mã hoàn tiền. */
  async applyCodRefund(tx: Tx, input: { shopId: string; orderCode: string; refundId: string; amount: bigint }): Promise<void> {
    const key = refundKey(input.refundId);
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_REFUND, orderCode: key }, select: { id: true } });
    if (done) return;
    const sale = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: input.orderCode }, select: { meta: true } });
    const meta = (sale?.meta ?? null) as { gross?: string; commission?: string } | null;
    const amount = D(input.amount.toString());
    const gross = D(meta?.gross ?? 0);
    const commissionBack = gross.gt(0) ? round0(D(meta?.commission ?? 0).mul(amount).div(gross)) : D(0);
    await this.post(tx, input.shopId, WALLET_TX_TYPE.COD_REFUND, commissionBack.sub(amount), {
      orderCode: key,
      note: `Hoàn tiền đơn COD ${input.orderCode}`,
      meta: { orderCode: input.orderCode, refundId: input.refundId, refunded: amount.toFixed(0), commissionBack: commissionBack.toFixed(0) },
    });
  }

  // ------------------------------------------------------------------ nội bộ

  /* Tạo ví nếu chưa có rồi KHOÁ dòng (FOR UPDATE) — mọi biến động số dư đều đi qua đây trước khi `post`. */
  private async lockWallet(tx: Tx, shopId: string): Promise<void> {
    await tx.shopCodWallet.upsert({ where: { shopId }, create: { shopId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "payment"."shop_cod_wallets" WHERE shop_id = ${shopId}::uuid FOR UPDATE`;
  }

  /* Ghi một dòng sổ cái và cập nhật số dư. PHẢI gọi sau lockWallet trong cùng tx. */
  private async post(tx: Tx, shopId: string, type: WalletTxType, amount: Dec, extra: { orderCode?: string; depositId?: string; note?: string; meta?: Prisma.InputJsonObject; createdBy?: string }) {
    const wallet = await tx.shopCodWallet.findUniqueOrThrow({ where: { shopId } });
    const balanceAfter = wallet.balance.add(amount);
    await tx.shopCodWallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter.toFixed(0), version: { increment: 1 } } });
    await tx.shopCodWalletTransaction.create({
      data: { walletId: wallet.id, shopId, type, amount: amount.toFixed(0), balanceAfter: balanceAfter.toFixed(0), orderCode: extra.orderCode ?? null, depositId: extra.depositId ?? null, note: extra.note ?? null, meta: extra.meta, createdBy: extra.createdBy ?? null },
    });
    return { walletId: wallet.id, balanceAfter };
  }
}
