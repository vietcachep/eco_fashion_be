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
 * Nạp cọc qua PayOS (PLAN-0041): MỘT đường ghi có duy nhất là creditPayosTopup → post, idempotent theo ref_key UNIQUE; luồng nạp tay (duyệt/từ chối) giữ nguyên.
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
    const [rows, official, minBalance] = await Promise.all([db.shopCodWallet.findMany({ where: { shopId: { in: uniq } }, select: { shopId: true, balance: true } }), this.shops.findOfficialShopId(), this.minBalance()]);
    for (const r of rows) out.set(r.shopId, r.balance.gte(minBalance));
    if (official && out.has(official)) out.set(official, true);
    return out;
  }

  /* Mức ví tối thiểu để nhận COD (PLAN-0030): ≥ wallet.min_balance_for_cod; luôn dương (≥ 1) dù cấu hình thế nào. */
  private async minBalance(): Promise<Dec> {
    return D(Math.max(1, await this.system.settingNumber(SETTING_KEY.WALLET_MIN_BALANCE_FOR_COD)));
  }

  // ------------------------------------------------------------------ đọc

  async getWallet(shopId: string) {
    const [wallet, pending, minDeposit, instructions, official, minBalance] = await Promise.all([
      this.prisma.shopCodWallet.findUnique({ where: { shopId } }),
      this.prisma.shopCodDeposit.findFirst({ where: { shopId, status: DEPOSIT_STATUS.PENDING }, orderBy: { createdAt: 'desc' } }),
      this.system.settingNumber(SETTING_KEY.WALLET_MIN_DEPOSIT),
      this.system.setting<string>(SETTING_KEY.WALLET_DEPOSIT_INSTRUCTIONS),
      this.shops.findOfficialShopId(),
      this.minBalance(),
    ]);
    const balance = wallet?.balance ?? D(0);
    return { shopId, balance, codEnabled: official === shopId || balance.gte(minBalance), minBalanceForCod: Number(minBalance.toFixed(0)), exempt: official === shopId, pendingDeposit: pending, minDeposit, instructions: instructions ?? '' };
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
      const dupRef = await tx.shopCodDeposit.findFirst({ where: { transferRef: { equals: input.transferRef.trim(), mode: 'insensitive' }, status: { not: DEPOSIT_STATUS.REJECTED } }, select: { id: true } });
      if (dupRef) throw new BusinessException(WALLET_ERR.TRANSFER_REF_DUPLICATE, 'Mã giao dịch này đã được dùng cho một khoản nộp khác — kiểm tra lại mã chuyển khoản', HttpStatus.CONFLICT);
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
      if (!dep) {
        await this.assertNotPayosTopup(tx, depositId);
        throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy yêu cầu nộp cọc');
      }
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
        if (!cur) {
          await this.assertNotPayosTopup(tx, depositId);
          throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy yêu cầu nộp cọc');
        }
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

  /*
   * PLAN-0041 — ghi có ví từ khoản nạp cọc PayOS: ĐƯỜNG DUY NHẤT cộng tiền nạp qua PayOS (qua `post`, dưới khoá ví). Idempotent theo refKey (UNIQUE ở DB):
   * đã có dòng cùng refKey ⇒ không ghi gì. Cờ wallet.payos_deposit_enabled KHÔNG được đọc ở đây: tiền đã đi thì phải vào sổ (D10).
   * Gọi trong CÙNG transaction với khoản nạp (khoá KHOẢN NẠP → VÍ, PLAN-0041 §6.1).
   */
  async creditPayosTopup(tx: Tx, input: { shopId: string; topupId: string; refKey: string; amount: bigint; note: string; meta: Prisma.InputJsonObject }): Promise<{ credited: boolean; balanceAfter: bigint }> {
    if (input.amount <= 0n) throw new Error(`creditPayosTopup: số tiền phải dương (${input.amount.toString()})`);
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { refKey: input.refKey }, select: { id: true } });
    if (done) {
      const wallet = await tx.shopCodWallet.findUniqueOrThrow({ where: { shopId: input.shopId } });
      return { credited: false, balanceAfter: BigInt(wallet.balance.toFixed(0)) };
    }
    const { balanceAfter } = await this.post(tx, input.shopId, WALLET_TX_TYPE.TOPUP_PAYOS, D(input.amount.toString()), { topupId: input.topupId, refKey: input.refKey, note: input.note, meta: input.meta });
    return { credited: true, balanceAfter: BigInt(balanceAfter.toFixed(0)) };
  }

  // ------------------------------------------------------------------ tự động trừ (gọi từ payment trong CÙNG tx)

  /*
   * Đơn COD thu tiền thành công ⇒ ví ghi: −hoa hồng + phần voucher SÀN sàn chịu (PLAN-0030). Shop giữ tiền mặt `total` (khách đã trừ voucher sàn), sàn nợ shop phần voucher sàn
   * và shop nợ sàn hoa hồng; hoa hồng = gốc × tỉ lệ, gốc = tiền hàng sau voucher shop (KHÔNG phí ship). Delta có thể DƯƠNG (voucher sàn lớn hơn hoa hồng).
   * Idempotent theo (shop, cod_commission, mã đơn). meta lưu số liệu để hoàn tiền đảo đúng tỉ lệ.
   */
  async applyCodCommission(tx: Tx, input: { shopId: string; orderCode: string; total: bigint; commissionBase: bigint; platformCredit: bigint; commissionRate: string }): Promise<void> {
    const base = D(input.commissionBase.toString());
    const credit = D(input.platformCredit.toString());
    const commission = round0(base.mul(D(input.commissionRate)).div(100));
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: input.orderCode }, select: { id: true } });
    if (done) return;
    await this.post(tx, input.shopId, WALLET_TX_TYPE.COD_COMMISSION, credit.sub(commission), {
      orderCode: input.orderCode,
      note: `Hoa hồng đơn COD ${input.orderCode}${credit.gt(0) ? ' (đã cộng voucher sàn)' : ''}`,
      meta: { paid: D(input.total.toString()).toFixed(0), base: base.toFixed(0), commission: commission.toFixed(0), platformCredit: credit.toFixed(0), rate: input.commissionRate },
    });
  }

  /*
   * Hoàn tiền đơn COD đã thu: sàn trả khách nên trừ ví số hoàn; đảo theo TỈ LỆ số hoàn / số khách đã trả: cộng lại phần hoa hồng, trừ phần voucher sàn tương ứng (shop không còn
   * được sàn bù phần đó). Đơn ghi theo công thức cũ (meta.gross, trước PLAN-0030) giữ nguyên cách tính cũ. Idempotent theo mã hoàn tiền.
   */
  async applyCodRefund(tx: Tx, input: { shopId: string; orderCode: string; refundId: string; amount: bigint }): Promise<void> {
    const key = refundKey(input.refundId);
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_REFUND, orderCode: key }, select: { id: true } });
    if (done) return;
    const sale = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: input.orderCode }, select: { meta: true } });
    const meta = (sale?.meta ?? null) as { paid?: string; commission?: string; platformCredit?: string; gross?: string } | null;
    const amount = D(input.amount.toString());
    let commissionBack = D(0);
    let creditBack = D(0);
    if (meta?.paid !== undefined) {
      const paid = D(meta.paid);
      if (paid.gt(0)) {
        const ratio = amount.div(paid);
        commissionBack = round0(D(meta.commission ?? 0).mul(ratio));
        creditBack = round0(D(meta.platformCredit ?? 0).mul(ratio));
      }
    } else {
      // Dữ liệu cũ (trước PLAN-0030): meta.gross = total + voucher sàn, hoa hồng đã tính trên đó.
      const gross = D(meta?.gross ?? 0);
      commissionBack = gross.gt(0) ? round0(D(meta?.commission ?? 0).mul(amount).div(gross)) : D(0);
    }
    await this.post(tx, input.shopId, WALLET_TX_TYPE.COD_REFUND, commissionBack.sub(creditBack).sub(amount), {
      orderCode: key,
      note: `Hoàn tiền đơn COD ${input.orderCode}`,
      meta: { orderCode: input.orderCode, refundId: input.refundId, refunded: amount.toFixed(0), commissionBack: commissionBack.toFixed(0), platformCreditBack: creditBack.toFixed(0) },
    });
  }

  /*
   * PLAN-0040 Tầng 3.6 (COD-08b): ĐẢO ghi thu đơn COD khi khách báo CHƯA NHẬN hàng — khách chưa từng trả tiền mặt nên không có khoản hoàn (khác applyCodRefund). Ghi dòng `cod_reversal` có số tiền NGƯỢC DẤU
   * dòng `cod_commission` của đơn (trả lại hoa hồng đã trừ, thu lại phần voucher sàn đã bù) — đảo TOÀN BỘ vì not_received áp cả đơn và chỉ đến được khi đơn chưa có khoản hoàn nào.
   * Idempotent theo (shop, cod_reversal, mã đơn) dưới khoá ví; đơn chưa có dòng cod_commission (dữ liệu cũ / chưa ghi) ⇒ không có gì để đảo.
   */
  async reverseCodCommission(tx: Tx, input: { shopId: string; orderCode: string; reason?: string }): Promise<{ reversedAmount: bigint } | null> {
    await this.lockWallet(tx, input.shopId);
    const done = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_REVERSAL, orderCode: input.orderCode }, select: { id: true } });
    if (done) return null;
    const sale = await tx.shopCodWalletTransaction.findFirst({ where: { shopId: input.shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: input.orderCode }, select: { amount: true, meta: true } });
    if (!sale) return null;
    const delta = D(sale.amount.toString()).neg();
    const signed = delta.isZero() ? D(0) : delta; // decimal.js in "-0" cho số 0 âm — ghi 0 sạch
    await this.post(tx, input.shopId, WALLET_TX_TYPE.COD_REVERSAL, signed, {
      orderCode: input.orderCode,
      note: `Đảo ghi thu đơn COD ${input.orderCode} — khách chưa nhận hàng`.slice(0, 500),
      meta: { reversedCommissionRow: sale.amount.toFixed(0), ...(input.reason ? { reason: input.reason.slice(0, 255) } : {}), ...((sale.meta ?? {}) as Prisma.InputJsonObject) },
    });
    return { reversedAmount: BigInt(signed.toFixed(0)) };
  }

  // ------------------------------------------------------------------ nội bộ

  /* PLAN-0041 D16: id của KHOẢN NẠP PAYOS (bảng khác) bị duyệt/từ chối tay ⇒ 409 rõ ràng thay vì 404 — khoản đó đã tự ghi có khi PayOS xác nhận. Chỉ ĐỌC, không khoá. */
  private async assertNotPayosTopup(tx: Tx, depositId: string): Promise<void> {
    const topup = await tx.shopCodTopup.findUnique({ where: { id: depositId }, select: { id: true } });
    if (topup) throw new BusinessException(WALLET_ERR.DEPOSIT_PAYOS_NOT_MANUAL, 'Khoản nạp qua PayOS tự ghi có khi PayOS xác nhận — không duyệt/từ chối tay', HttpStatus.CONFLICT);
  }

  /* Tạo ví nếu chưa có rồi KHOÁ dòng (FOR UPDATE) — mọi biến động số dư đều đi qua đây trước khi `post`. */
  private async lockWallet(tx: Tx, shopId: string): Promise<void> {
    await tx.shopCodWallet.upsert({ where: { shopId }, create: { shopId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "payment"."shop_cod_wallets" WHERE shop_id = ${shopId}::uuid FOR UPDATE`;
  }

  /* Ghi một dòng sổ cái và cập nhật số dư. PHẢI gọi sau lockWallet trong cùng tx. */
  private async post(tx: Tx, shopId: string, type: WalletTxType, amount: Dec, extra: { orderCode?: string; depositId?: string; topupId?: string; refKey?: string; note?: string; meta?: Prisma.InputJsonObject; createdBy?: string }) {
    const wallet = await tx.shopCodWallet.findUniqueOrThrow({ where: { shopId } });
    const balanceAfter = wallet.balance.add(amount);
    await tx.shopCodWallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter.toFixed(0), version: { increment: 1 } } });
    await tx.shopCodWalletTransaction.create({
      data: { walletId: wallet.id, shopId, type, amount: amount.toFixed(0), balanceAfter: balanceAfter.toFixed(0), orderCode: extra.orderCode ?? null, depositId: extra.depositId ?? null, topupId: extra.topupId ?? null, refKey: extra.refKey ?? null, note: extra.note ?? null, meta: extra.meta, createdBy: extra.createdBy ?? null },
    });
    return { walletId: wallet.id, balanceAfter };
  }
}
