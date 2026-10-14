import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { SHOP_COD_GATEWAY, type ShopCodGateway } from '@common/gateway/shop-cod.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PaymentAuditLogService } from '../../audit/payment-audit-log.service';
import { WALLET_AUDIT, WALLET_ERR, WALLET_EVENT, WALLET_TX_TYPE } from '../../foundation/payment.constants';
import { PaymentOutboxService } from '../../outbox/payment-outbox.service';
import { ShopWalletRepository, type WalletRow } from '../repository/shop-wallet.repository';

type Dec = Prisma.Decimal;
type MoneyInput = Dec | string | number;

/*
 * Ví quỹ COD của shop (PLAN-0017): COD thu tiền ở shop nên sàn thu hoa hồng bằng cách TRỪ ví; ví ≤ 0 ⇒ tự khoá COD của shop,
 * nộp thêm quỹ (sàn duyệt) hoặc điều chỉnh làm ví > 0 ⇒ mở lại. Không có "vùng đệm âm" — ví về ≤ 0 là khoá ngay.
 * Mọi thay đổi số dư: transaction + khoá dòng ví (FOR UPDATE) + dòng sổ cái append-only + audit + (khi COD đổi trạng thái) outbox.
 * Hoa hồng COD idempotent theo (shopId, type, orderCode) nên sự kiện đơn "completed" lặp không trừ hai lần.
 */
@Injectable()
export class ShopWalletService {
  private readonly logger = new Logger(ShopWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ShopWalletRepository,
    private readonly audit: PaymentAuditLogService,
    private readonly outbox: PaymentOutboxService,
    @Inject(SHOP_COD_GATEWAY) private readonly codGateway: ShopCodGateway,
  ) {}

  /* Tạo ví cho shop nếu chưa có (shop vừa được duyệt) và áp quy tắc COD theo số dư: ví 0 ⇒ COD tắt cho tới khi nộp quỹ (đúng luật "ví ≤ 0 ⇒ khoá COD" — không có vùng đệm). */
  async ensureWallet(shopId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const wallet = await this.repo.lockWallet(tx, shopId);
      await this.syncCod(tx, wallet, wallet.balance);
    });
  }

  /* Đơn COD này đã có dòng hoa hồng trong sổ cái chưa (listener hoàn tiền chỉ đảo hoa hồng khi nó đã được trừ). */
  async hasCodCommission(shopId: string, orderCode: string): Promise<boolean> {
    return (await this.prisma.shopWalletTransaction.count({ where: { shopId, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode } })) > 0;
  }

  /* Trong danh sách mã đơn, những đơn ĐÃ có dòng hoa hồng COD — job đối soát bù chỉ xử lý phần còn thiếu. */
  async chargedOrderCodes(orderCodes: string[]): Promise<Set<string>> {
    if (orderCodes.length === 0) return new Set();
    const rows = await this.prisma.shopWalletTransaction.findMany({ where: { type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: { in: orderCodes } }, select: { orderCode: true } });
    return new Set(rows.map((r) => r.orderCode).filter((c): c is string => !!c));
  }

  /* Tổng tiền đã hoàn xong của một đơn (mọi khoản hoàn `done`) — hoa hồng COD khi hoàn tất chỉ tính trên phần còn lại. */
  async refundedTotalOfOrder(orderCode: string): Promise<Dec> {
    const r = await this.prisma.refund.aggregate({ _sum: { amount: true }, where: { orderCode, status: 'done' } });
    return new Prisma.Decimal((r._sum.amount ?? 0).toString());
  }

  /*
   * Hoàn tiền đơn COD đã hoàn tất: sàn chuyển tiền cho khách nhưng shop đang giữ tiền mặt đã thu ⇒ ví shop bị ghi NỢ số hoàn; sàn hoàn lại phần hoa hồng ròng
   * tương ứng (`commissionReversal`, âm = sàn đòi thêm). Ghi một dòng `cod_refund` với khoá `refundKey` (RF-…) ⇒ sự kiện lặp không ghi hai lần.
   */
  async recordCodRefund(input: { shopId: string; orderCode: string; refundKey: string; amount: MoneyInput; commissionReversal: MoneyInput }): Promise<boolean> {
    const debit = new Prisma.Decimal(input.amount).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const credit = new Prisma.Decimal(input.commissionReversal).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const delta = credit.sub(debit);
    if (delta.isZero()) return false;
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.repo.lockWallet(tx, input.shopId);
      const after = wallet.balance.add(delta);
      const fresh = await this.repo.appendLedger(tx, { walletId: wallet.id, shopId: input.shopId, type: WALLET_TX_TYPE.COD_REFUND, amount: delta, balanceAfter: after, orderCode: input.refundKey, note: `Hoàn tiền đơn COD ${input.orderCode}: shop hoàn lại tiền mặt đã thu, sàn hoàn hoa hồng` });
      if (!fresh) return false;
      await this.repo.setBalance(tx, wallet.id, after);
      await this.audit.write(tx, null, { action: WALLET_AUDIT.COD_REFUND, entityType: 'ShopWallet', entityId: wallet.id, entityCode: input.orderCode, before: { balance: wallet.balance.toFixed(0) }, after: { balance: after.toFixed(0), refund: debit.toFixed(0), commissionReversal: credit.toFixed(0), shopId: input.shopId } });
      await this.syncCod(tx, wallet, after);
      return true;
    });
  }

  /* Ghi hoa hồng COD ròng của đơn đã hoàn tất: dương = trừ ví, âm = cộng ví (sàn hoàn voucher sàn lớn hơn hoa hồng). Trả false nếu
     đơn này đã được ghi trước đó (idempotent) hoặc khoản ròng bằng 0. */
  async chargeCodCommission(input: { shopId: string; orderCode: string; amount: MoneyInput }): Promise<boolean> {
    // Sổ cái là VND nguyên (Decimal(14,0)) — làm tròn nửa lên NGAY từ đầu để balanceAfter không giữ phần lẻ lệch với số dư lưu.
    const amount = new Prisma.Decimal(input.amount).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    if (amount.isZero()) return false;
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.repo.lockWallet(tx, input.shopId);
      const after = wallet.balance.sub(amount);
      const fresh = await this.repo.appendLedger(tx, {
        walletId: wallet.id,
        shopId: input.shopId,
        type: WALLET_TX_TYPE.COD_COMMISSION,
        amount: amount.neg(),
        balanceAfter: after,
        orderCode: input.orderCode,
        note: `Hoa hồng COD đơn ${input.orderCode}`,
      });
      if (!fresh) return false;
      await this.repo.setBalance(tx, wallet.id, after);
      await this.audit.write(tx, null, { action: WALLET_AUDIT.COD_COMMISSION, entityType: 'ShopWallet', entityId: wallet.id, entityCode: input.orderCode, before: { balance: wallet.balance.toFixed(0) }, after: { balance: after.toFixed(0), commission: amount.toFixed(0), shopId: input.shopId } });
      await this.syncCod(tx, wallet, after);
      return true;
    });
  }

  /* Shop xin nộp thêm quỹ (một yêu cầu chờ duyệt mỗi lúc). */
  async createDepositRequest(shopId: string, amount: MoneyInput, actor: AuthenticatedActor, proofUrl?: string, note?: string): Promise<{ id: string }> {
    const value = new Prisma.Decimal(amount);
    if (value.lte(0) || !value.isInteger()) throw new BusinessException(WALLET_ERR.INVALID_AMOUNT, 'Số tiền nộp phải là số nguyên dương (VND)');
    // Khoá dòng ví rồi mới kiểm "đã có yêu cầu chờ" ⇒ bấm đúp/hai request song song không tạo được hai yêu cầu pending
    // (hai yêu cầu cùng được duyệt sẽ cộng ví hai lần cho một lần chuyển khoản).
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockWallet(tx, shopId);
      if (await this.repo.pendingDeposit(shopId, tx)) throw new BusinessException(WALLET_ERR.DEPOSIT_PENDING_EXISTS, 'Đang có một yêu cầu nộp quỹ chờ duyệt', HttpStatus.CONFLICT);
      const created = await this.repo.createDeposit(tx, { shopId, amount: value, proofUrl, note, createdBy: actor.userId });
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_REQUESTED, entityType: 'ShopWalletDepositRequest', entityId: created.id, after: { shopId, amount: value.toFixed(0) } });
      return created;
    });
  }

  /* Sàn duyệt nộp quỹ: cộng ví, mở lại COD khi ví > 0. */
  async approveDeposit(id: string, actor: AuthenticatedActor, note?: string): Promise<void> {
    const deposit = await this.mustFindDeposit(id);
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.repo.decideDeposit(tx, id, 'approved', actor.userId, note))) throw this.alreadyDecided();
      const wallet = await this.repo.lockWallet(tx, deposit.shopId);
      const after = wallet.balance.add(deposit.amount);
      await this.repo.appendLedger(tx, { walletId: wallet.id, shopId: deposit.shopId, type: WALLET_TX_TYPE.DEPOSIT, amount: deposit.amount, balanceAfter: after, note: note || 'Nộp quỹ được phê duyệt', createdBy: actor.userId });
      await this.repo.setBalance(tx, wallet.id, after);
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_APPROVED, entityType: 'ShopWalletDepositRequest', entityId: id, before: { status: 'pending' }, after: { status: 'approved', amount: deposit.amount.toFixed(0), balance: after.toFixed(0) } });
      await this.outbox.publish(tx, { eventType: WALLET_EVENT.DEPOSIT_APPROVED, aggregateType: 'ShopWallet', aggregateId: wallet.id, payload: { shopId: deposit.shopId, depositId: id, amount: deposit.amount.toFixed(0), balance: after.toFixed(0) } });
      await this.syncCod(tx, wallet, after);
    });
    this.logger.log({ id, shopId: deposit.shopId, amount: deposit.amount.toFixed(0) }, 'Đã duyệt nộp quỹ');
  }

  async rejectDeposit(id: string, actor: AuthenticatedActor, note?: string): Promise<void> {
    const deposit = await this.mustFindDeposit(id);
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.repo.decideDeposit(tx, id, 'rejected', actor.userId, note))) throw this.alreadyDecided();
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.DEPOSIT_REJECTED, entityType: 'ShopWalletDepositRequest', entityId: id, before: { status: 'pending' }, after: { status: 'rejected', note: note ?? null } });
      await this.outbox.publish(tx, { eventType: WALLET_EVENT.DEPOSIT_REJECTED, aggregateType: 'ShopWalletDepositRequest', aggregateId: id, payload: { shopId: deposit.shopId, depositId: id, amount: deposit.amount.toFixed(0), note: note ?? null } });
    });
  }

  /* Sàn điều chỉnh ví (dương = cộng, âm = trừ) — bắt buộc ghi chú; áp lại quy tắc COD theo số dư mới. */
  async adjust(shopId: string, amount: MoneyInput, note: string, actor: AuthenticatedActor): Promise<void> {
    const delta = new Prisma.Decimal(amount);
    if (delta.isZero() || !delta.isInteger()) throw new BusinessException(WALLET_ERR.INVALID_AMOUNT, 'Số tiền điều chỉnh phải là số nguyên khác 0 (VND)');
    if (!note || note.trim().length < 5) throw new BusinessException(WALLET_ERR.NOTE_REQUIRED, 'Ghi chú điều chỉnh tối thiểu 5 ký tự');
    await this.prisma.$transaction(async (tx) => {
      const wallet = await this.repo.lockWallet(tx, shopId);
      const after = wallet.balance.add(delta);
      await this.repo.appendLedger(tx, { walletId: wallet.id, shopId, type: WALLET_TX_TYPE.ADJUST, amount: delta, balanceAfter: after, note: note.trim(), createdBy: actor.userId });
      await this.repo.setBalance(tx, wallet.id, after);
      await this.audit.write(tx, actor, { action: WALLET_AUDIT.ADJUSTED, entityType: 'ShopWallet', entityId: wallet.id, entityCode: shopId, before: { balance: wallet.balance.toFixed(0) }, after: { balance: after.toFixed(0), delta: delta.toFixed(0), note: note.trim() } });
      await this.syncCod(tx, wallet, after);
    });
  }

  /* Số dư + yêu cầu nộp quỹ đang chờ (ví chưa tạo = số dư 0). */
  async getWalletSummary(shopId: string) {
    const [wallet, pending] = await Promise.all([this.repo.findByShopId(shopId), this.repo.pendingDeposit(shopId)]);
    return { balance: wallet?.balance ?? new Prisma.Decimal(0), pendingDeposit: pending ? { id: pending.id, amount: pending.amount } : null };
  }

  /* shopId có giá trị = vendor xem lịch sử của chính mình; không có = sàn xem toàn bộ. */
  listDepositRequests(filter: { status?: string; shopId?: string }, skip: number, take: number) {
    return this.repo.listDeposits(filter, skip, take);
  }

  listWallets(lowOnly: boolean, skip: number, take: number) {
    return this.repo.listWallets(lowOnly, skip, take);
  }

  listTransactions(shopId: string, skip: number, take: number) {
    return this.repo.listTransactions(shopId, skip, take);
  }

  /* ---------------- nội bộ ---------------- */

  private async mustFindDeposit(id: string) {
    const deposit = await this.repo.findDeposit(id);
    if (!deposit) throw new NotFoundException(WALLET_ERR.DEPOSIT_NOT_FOUND, 'Không tìm thấy yêu cầu nộp quỹ');
    return deposit;
  }

  private alreadyDecided() {
    return new BusinessException(WALLET_ERR.DEPOSIT_DECIDED, 'Yêu cầu nộp quỹ đã được xử lý', HttpStatus.CONFLICT);
  }

  /* Quy tắc COD theo số dư mới: ≤ 0 ⇒ khoá, > 0 ⇒ mở. Chỉ phát sự kiện khi trạng thái COD thực sự đổi. */
  private async syncCod(tx: Tx, wallet: WalletRow, balanceAfter: Dec): Promise<void> {
    const enable = balanceAfter.gt(0);
    const changed = await this.codGateway.setCodEnabled(wallet.shopId, enable, tx);
    if (!changed) return;
    await this.outbox.publish(tx, {
      eventType: enable ? WALLET_EVENT.COD_ENABLED : WALLET_EVENT.COD_DISABLED,
      aggregateType: 'ShopWallet',
      aggregateId: wallet.id,
      payload: { shopId: wallet.shopId, balance: balanceAfter.toFixed(0) },
    });
  }
}
