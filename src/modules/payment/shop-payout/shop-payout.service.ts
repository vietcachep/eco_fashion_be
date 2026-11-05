import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderQueryApi } from '@modules/order/queryapi/order.queryapi';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { PAYMENT_EVENT, PAYOUT_AUDIT, PAYOUT_ERR, PAYOUT_LINE_KIND, PAYOUT_STATUS } from '../foundation/payment.constants';
import { PaymentOutboxService } from '../outbox/payment-outbox.service';
import { PayosService } from '../payos/payos.service';

type Dec = Prisma.Decimal;

export interface ShopPayoutRunInput {
  periodStart: Date;
  periodEnd: Date;
  /* PLAN-0026 §2.6: chỉ chạy cho MỘT shop (xử lý sự cố / chạy bù) — bỏ trống = mọi shop. */
  shopId?: string;
}

/* Snapshot tài khoản nhận lúc chạy kỳ — đổi hồ sơ shop sau đó không làm lệch chứng từ. */
interface BankSnapshot {
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

interface DraftLine {
  key: string;
  kind: string;
  gross: Dec;
  commission: Dec;
  /* Mã đơn thật của dòng hoàn tiền (key của dòng refund là "RF-…", không phải mã đơn) — lưu để shop/kế toán biết khoản trừ thuộc đơn nào. Dòng bán: bỏ trống (key đã là mã đơn). */
  orderCode?: string;
}

const D = (v: string | number | Dec): Dec => new Prisma.Decimal(v);
const ZERO = D(0);
const round0 = (d: Dec): Dec => d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
/* rate là PHẦN TRĂM (Decimal(5,2): 10.00 = 10%). */
const commissionOf = (amount: Dec, ratePercent: Dec): Dec => round0(amount.mul(ratePercent).div(100));
const dateKey = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, '');
/* Dòng hoàn tiền định danh bằng id hoàn tiền (VarChar(30)): "RF-" + 26 ký tự hex đầu của uuid. */
const refundLineKey = (refundId: string) => `RF-${refundId.replace(/-/g, '').slice(0, 26)}`;
const chunk = <T>(arr: T[], n = 5000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
/* Sau khi shop ĐỔI tài khoản ngân hàng, tạm giữ chi trả (chi tự động/gửi lại) trong `holdHours` = setting `payout.bank_change_hold_hours` (mặc định 72 giờ; FE đọc cùng giá trị qua `bankChangeHoldHours` của /shop/me) — kẻ chiếm phiên không chuyển được tiền kỳ gần nhất sang TK của mình; chủ shop có thời gian nhận thông báo và báo sàn. TK ở trạng thái chờ xác minh (tên chủ TK lệch tên chủ shop) còn bị giữ ĐẾN KHI quản lý xác minh (`pendingVerification`) và `changedAt` khi đó là mốc xác minh. */
const bankJustChanged = (b: { changedAt: Date | null } | null, holdHours: number) => !!b?.changedAt && Date.now() - b.changedAt.getTime() < holdHours * 3_600_000;
/* PLAN-0040 5.2: lý do giữ khi TK ngân hàng đang chờ quản lý sàn xác minh (tên chủ TK lệch tên chủ shop). */
const BANK_UNVERIFIED_REASON = 'Tài khoản ngân hàng đang chờ sàn xác minh (tên chủ tài khoản không khớp tên chủ gian hàng) — tạm giữ chi trả cho tới khi quản lý xác minh';
/* Khoá idempotency + referenceId gửi PayOS: lần 1 = mã kỳ; sau khi PayOS TỪ CHỐI chắc chắn thì tăng lần => `<mã kỳ>-<n>` (khoá mới). Sau `unknown` giữ NGUYÊN khoá. */
const gatewayKey = (code: string, attempt: number) => (attempt > 1 ? `${code}-${attempt}` : code);

/*
 * Mã kỳ chỉ có NGÀY (`PAY-yymmdd-yymmdd-<shop>`) nên kỳ thứ hai của cùng shop trong CÙNG MỘT NGÀY (kế toán chạy lại sau khi có đơn mới) trùng mã ⇒ trước đây P2002 bị coi là "chạy song song — bỏ qua":
 * 0 kỳ được tạo, đơn mới bị bỏ sót (AUD-02). Trùng mã ⇒ thêm hậu tố CHỮ `-B`, `-C`… (KHÔNG dùng hậu tố số: `gatewayKey` đã dùng `-<lần thử>` làm khoá chi lại, `<mã>-2` sẽ đè khoá của kỳ khác).
 * Mã VarChar(30): mã gốc 26 ký tự + `-B` = 28. Chạy trong transaction đã khoá dòng kỳ gần nhất của shop nên hai lượt chạy chồng không chọn cùng hậu tố; trùng thật vẫn bị UNIQUE chặn.
 */
const PAYOUT_CODE_SUFFIXES = 'BCDEFGHIJKLMNOPQRSTUVWXYZ';
export async function uniquePayoutCode(tx: Pick<Tx, 'shopPayout'>, baseCode: string): Promise<string> {
  for (let i = -1; i < PAYOUT_CODE_SUFFIXES.length; i += 1) {
    const candidate = i < 0 ? baseCode : `${baseCode}-${PAYOUT_CODE_SUFFIXES[i]}`;
    if (!(await tx.shopPayout.findUnique({ where: { code: candidate }, select: { id: true } }))) return candidate;
  }
  throw new BusinessException(PAYOUT_ERR.PERIOD_OVERLAP, `Đã có ${PAYOUT_CODE_SUFFIXES.length + 1} kỳ đối soát của shop trong cùng ngày — chạy tiếp vào ngày mai`, HttpStatus.CONFLICT);
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/*
 * Đối soát chi trả shop (PLAN-0017/0018/0020): mỗi kỳ gom đơn ĐÃ THU TIỀN VỀ SÀN qua PayOS (đơn COD không vào đây — shop giữ tiền mặt, sàn trừ hoa hồng từ ví cọc) — đã qua hạn đổi trả (escrow, tính từ ngày giao) chưa nằm trong kỳ nào,
 * trừ hoa hồng sàn (theo snapshot trên đơn) và hoàn tiền đã chi cho khách, trừ nợ mang sang (carriedDebt).
 *   net > 0  → chi PayOS tự động nếu đã có khoá payout + shop có TK ngân hàng; ngược lại để `pending` cho kế toán chuyển tay + mark-paid.
 *   net = 0  → `settled` (không có gì để chi) · net < 0 → `carried` (KHÔNG gọi PayOS, mang sang kỳ sau).
 * Chạy lại không trùng nhờ UNIQUE(shopId, kỳ) và UNIQUE(orderCode, kind) của dòng đối soát. Mã kỳ tất định + idempotency-key
 * = mã kỳ nên retry chi PayOS không bao giờ chi đôi. Mỗi shop một transaction riêng (lỗi một shop không kéo cả kỳ).
 * `actor` null = HỆ THỐNG (cron chi trả tự động `AutoPayoutJob`): audit ghi actor null, `created_by` NULL.
 * Gọi PayOS NGOÀI transaction (ghi `processing` trước, gọi sau, ghi kết quả sau) — treo giữa chừng vẫn truy ra được qua mã kỳ.
 */
@Injectable()
export class ShopPayoutService {
  private readonly logger = new Logger(ShopPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderQueryApi,
    private readonly shops: ShopQueryApi,
    private readonly system: SystemQueryApi,
    private readonly payos: PayosService,
    private readonly audit: PaymentAuditLogService,
    private readonly outbox: PaymentOutboxService,
    @Inject(NOTIFICATION_GATEWAY) private readonly notifier: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  /* ============================== Chạy kỳ ============================== */

  async run(input: ShopPayoutRunInput, actor: AuthenticatedActor | null) {
    const { periodStart, periodEnd } = input;
    if (!(periodStart.getTime() < periodEnd.getTime())) throw new BusinessException(PAYOUT_ERR.INVALID_PERIOD, 'Ngày bắt đầu kỳ phải trước ngày kết thúc');
    if (periodEnd.getTime() > Date.now()) throw new BusinessException(PAYOUT_ERR.INVALID_PERIOD, 'Kỳ đối soát chưa kết thúc — chọn ngày kết thúc không muộn hơn hiện tại');

    // Kỳ mới không được chồng lên kỳ đã chạy (chuỗi nợ mang sang tính theo thứ tự thời gian) — trừ chạy lại ĐÚNG kỳ cũ (idempotent).
    // Kiểm theo TỪNG SHOP: chạy kỳ cho shop A không bị chặn vì kỳ của shop B (AUD-08); chạy toàn sàn thì kiểm mọi shop.
    const overlap = await this.prisma.shopPayout.findFirst({
      where: { ...(input.shopId ? { shopId: input.shopId } : {}), periodEnd: { gt: periodStart }, OR: [{ periodStart: { not: periodStart } }, { periodEnd: { not: periodEnd } }] },
      select: { code: true },
    });
    if (overlap) throw new BusinessException(PAYOUT_ERR.PERIOD_OVERLAP, `Kỳ chồng lên kỳ đã chạy (${overlap.code}) — chọn kỳ bắt đầu sau ngày kết thúc kỳ trước`, HttpStatus.CONFLICT);

    const all = await this.collect(periodEnd);
    const drafts = input.shopId ? new Map([...all].filter(([id]) => id === input.shopId)) : all;
    const created = [];
    for (const [shopId, lines] of drafts) {
      try {
        const payout = await this.settleShop(shopId, lines, periodStart, periodEnd, actor);
        if (payout) created.push(payout);
      } catch (err) {
        if (isUniqueViolation(err)) {
          this.logger.warn(`Kỳ ${shopId} ${dateKey(periodStart)}-${dateKey(periodEnd)} bị chạy song song — bỏ qua`);
          continue;
        }
        // Lỗi một shop không chặn các shop khác; chạy lại kỳ là an toàn (idempotent).
        this.logger.error(`Đối soát shop ${shopId} lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return created;
  }

  /* ============================== Retry / mark-paid / approve / reconcile ============================== */

  private async holdHours(): Promise<number> {
    return this.system.settingNumber(SETTING_KEY.PAYOUT_BANK_CHANGE_HOLD_HOURS);
  }

  /*
   * Gửi lại lệnh chi — CHỈ khi chắc chắn PayOS chưa chuyển tiền:
   *  - `failed` do PayOS TỪ CHỐI chắc chắn (gatewayStatus=failed) ⇒ khoá MỚI `<mã kỳ>-<n+1>`;
   *  - `failed` do tra cứu xác nhận PayOS chưa nhận lệnh (gatewayStatus=not_received) ⇒ giữ nguyên khoá (idempotent);
   *  - `pending` khi giờ đã có khoá payout (vd shop vừa bổ sung TK) ⇒ khoá hiện tại.
   * `processing` / `unknown` KHÔNG gửi lại ở đây — phải qua `reconcile` (hỏi PayOS) để biết lệnh đã đi hay chưa.
   */
  async retry(payoutId: string, actor: AuthenticatedActor) {
    const payout = await this.mustFind(payoutId);
    await this.assertPayoutFinanceSafety(payout);
    if (payout.status !== PAYOUT_STATUS.FAILED && payout.status !== PAYOUT_STATUS.PENDING) {
      const hint = payout.status === PAYOUT_STATUS.UNKNOWN || payout.status === PAYOUT_STATUS.PROCESSING ? ' — dùng "Kiểm tra với PayOS" (reconcile) để biết lệnh đã đi chưa' : '';
      throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Chỉ chạy lại được kỳ failed/pending, hiện là ${payout.status}${hint}`);
    }
    if (!this.payos.isPayoutConfigured) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'PayOS payout chưa cấu hình — dùng đánh dấu đã trả tay');
    if (!D(payout.netPayout).gt(0)) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ không có khoản cần chi');
    await this.assertShopPayable(payout.shopId);

    // Luôn đọc TK hiện tại để áp giữ chi trả — kỳ bị giữ lúc chạy kỳ vẫn mang snapshot TK MỚI, nếu bỏ qua kiểm tra khi đã có snapshot thì "chạy lại" ngay sẽ vô hiệu thời gian giữ.
    const hold = await this.holdHours();
    const current = await this.shops.bankAccountOf(payout.shopId);
    if (current?.pendingVerification) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, BANK_UNVERIFIED_REASON);
    if (bankJustChanged(current, hold)) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Tài khoản ngân hàng vừa thay đổi — tạm giữ chi trả ${hold} giờ, thử lại sau`);
    let bank = payout.bankSnapshot as unknown as BankSnapshot | null;
    if (!bank) {
      if (!current) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Shop chưa khai báo tài khoản ngân hàng');
      bank = current;
    }
    const definiteFailure = payout.status === PAYOUT_STATUS.FAILED && payout.gatewayStatus === 'failed';
    const attempt = definiteFailure ? payout.gatewayAttempt + 1 : payout.gatewayAttempt;

    const moved = await this.prisma.$transaction(async (tx) => {
      const r = await tx.shopPayout.updateMany({
        // version đã đọc nằm trong điều kiện ⇒ hai người cùng bấm "chạy lại" trên một kỳ chỉ một người giành được.
        where: { id: payoutId, status: payout.status, version: payout.version },
        data: { status: PAYOUT_STATUS.PROCESSING, failReason: null, gatewayAttempt: attempt, bankSnapshot: bank as unknown as Prisma.InputJsonObject, version: { increment: 1 } },
      });
      if (r.count === 0) return false;
      await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.RETRIED, entityType: 'ShopPayout', entityId: payoutId, entityCode: payout.code, before: { status: payout.status, failReason: payout.failReason, gatewayStatus: payout.gatewayStatus }, after: { status: PAYOUT_STATUS.PROCESSING, attempt, key: gatewayKey(payout.code, attempt) } });
      return true;
    });
    if (!moved) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ vừa được xử lý bởi người khác — tải lại', HttpStatus.CONFLICT);

    await this.dispatch(payoutId, payout.code, payout.shopId, D(payout.netPayout), bank, attempt, actor);
    return this.mustFind(payoutId);
  }

  /*
   * Kế toán xác nhận đã chuyển khoản TAY. Không bao giờ cho đánh dấu khi PayOS có thể vẫn đang/đã chi (rủi ro chi trùng):
   *  - `failed` (PayOS từ chối chắc chắn / chưa nhận) và `pending` (chưa cấu hình PayOS chi) ⇒ được.
   *  - `processing` / `unknown` ⇒ CHỈ khi body `confirmGatewayNotExecuted: true` (kế toán đã tra bảng điều khiển PayOS và xác nhận lệnh KHÔNG được thực hiện).
   * `providerRef` (mã giao dịch) duy nhất toàn hệ thống — một chứng từ không làm "đã chi" hai kỳ (409 PAYOUT_PROVIDER_REF_DUPLICATE).
   */
  async markPaid(payoutId: string, input: { providerRef: string; note?: string; confirmGatewayNotExecuted?: boolean }, actor: AuthenticatedActor) {
    const payout = await this.mustFind(payoutId);
    await this.assertPayoutFinanceSafety(payout);
    const risky = payout.status === PAYOUT_STATUS.PROCESSING || payout.status === PAYOUT_STATUS.UNKNOWN;
    const allowed: string[] = [PAYOUT_STATUS.FAILED, PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.UNKNOWN, ...(this.payos.isPayoutConfigured ? [] : [PAYOUT_STATUS.PENDING])];
    if (!allowed.includes(payout.status)) {
      const hint = payout.status === PAYOUT_STATUS.PENDING ? ' — đã cấu hình PayOS payout nên dùng "chạy lại"' : '';
      throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Không thể đánh dấu đã trả từ trạng thái ${payout.status}${hint}`);
    }
    if (risky && input.confirmGatewayNotExecuted !== true) {
      throw new BusinessException(PAYOUT_ERR.GATEWAY_NOT_CONFIRMED, 'Lệnh chi PayOS có thể đã/đang được thực hiện — bấm "Kiểm tra với PayOS" trước; chỉ đánh dấu tay khi đã tra bảng điều khiển PayOS và xác nhận lệnh KHÔNG được thực hiện (confirmGatewayNotExecuted)', HttpStatus.CONFLICT);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const r = await tx.shopPayout.updateMany({
          where: { id: payoutId, status: payout.status },
          data: { status: PAYOUT_STATUS.PAID, providerRef: input.providerRef, failReason: null, paidAt: new Date(), version: { increment: 1 } },
        });
        if (r.count === 0) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ vừa được xử lý bởi người khác — tải lại', HttpStatus.CONFLICT);
        await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.MARKED_PAID, entityType: 'ShopPayout', entityId: payoutId, entityCode: payout.code, before: { status: payout.status, gatewayStatus: payout.gatewayStatus }, after: { status: PAYOUT_STATUS.PAID, providerRef: input.providerRef, note: input.note ?? null, confirmGatewayNotExecuted: input.confirmGatewayNotExecuted ?? null } });
        await this.outbox.publish(tx, { eventType: PAYMENT_EVENT.PAYOUT_PAID, aggregateType: 'ShopPayout', aggregateId: payoutId, payload: this.eventPayload(payout, PAYOUT_STATUS.PAID) });
        return tx.shopPayout.findUniqueOrThrow({ where: { id: payoutId } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessException(PAYOUT_ERR.PROVIDER_REF_DUPLICATE, 'Mã giao dịch này đã được dùng cho một kỳ chi khác', HttpStatus.CONFLICT);
      throw err;
    }
  }

  /* Duyệt kỳ vượt hạn mức tự chi (`awaiting_approval`) ⇒ gửi PayOS. Compare-and-set theo trạng thái + version; shop bị khoá / đang giữ ⇒ chặn. */
  async approve(payoutId: string, actor: AuthenticatedActor) {
    const payout = await this.mustFind(payoutId);
    await this.assertPayoutFinanceSafety(payout);
    if (payout.status !== PAYOUT_STATUS.AWAITING_APPROVAL) throw new BusinessException(PAYOUT_ERR.NOT_APPROVABLE, `Chỉ duyệt được kỳ chờ duyệt, hiện là ${payout.status}`);
    if (!this.payos.isPayoutConfigured) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'PayOS payout chưa cấu hình — không gửi được lệnh chi');
    await this.assertShopPayable(payout.shopId);
    const current = await this.shops.bankAccountOf(payout.shopId);
    const bank = (payout.bankSnapshot as unknown as BankSnapshot | null) ?? current;
    if (!bank) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Shop chưa khai báo tài khoản ngân hàng');
    const hold = await this.holdHours();
    if (current?.pendingVerification) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, BANK_UNVERIFIED_REASON);
    if (bankJustChanged(current, hold)) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Tài khoản ngân hàng vừa thay đổi — tạm giữ chi trả ${hold} giờ`);

    const moved = await this.prisma.$transaction(async (tx) => {
      const r = await tx.shopPayout.updateMany({ where: { id: payoutId, status: PAYOUT_STATUS.AWAITING_APPROVAL, version: payout.version }, data: { status: PAYOUT_STATUS.PROCESSING, approvedBy: actor.userId, approvedAt: new Date(), version: { increment: 1 } } });
      if (r.count === 0) return false;
      await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.APPROVED, entityType: 'ShopPayout', entityId: payoutId, entityCode: payout.code, after: { netPayout: D(payout.netPayout).toFixed(0) } });
      return true;
    });
    if (!moved) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ vừa được xử lý bởi người khác — tải lại', HttpStatus.CONFLICT);
    await this.dispatch(payoutId, payout.code, payout.shopId, D(payout.netPayout), bank, payout.gatewayAttempt, actor);
    return this.mustFind(payoutId);
  }

  /*
   * Mở giữ các kỳ `held` khi lý do giữ đã hết (shop được mở khoá, hết thời gian giữ sau đổi TK): kỳ về `pending` với TK HIỆN TẠI; nếu tự động chi đang bật + PayOS chi đã cấu hình
   * thì gửi luôn. Kỳ vượt hạn mức tự chi vẫn phải qua duyệt. Nút "Mở giữ" (kế toán) gọi cùng hàm cho một kỳ.
   */
  async releaseHeld(onlyId?: string, actor: AuthenticatedActor | null = null): Promise<number> {
    const rows = await this.prisma.shopPayout.findMany({ where: { status: PAYOUT_STATUS.HELD, ...(onlyId ? { id: onlyId } : {}) }, take: 100, orderBy: { updatedAt: 'asc' } });
    const [hold, autoMax, autoEnabled] = await Promise.all([this.holdHours(), this.system.settingNumber(SETTING_KEY.PAYOUT_AUTO_MAX_AMOUNT), this.system.settingBool(SETTING_KEY.PAYOUT_AUTO_ENABLED)]);
    let released = 0;
    for (const p of rows) {
      const block = await this.holdBlock(p.shopId, hold);
      if (block.reason !== null) continue;
      const bank = block.bank as BankSnapshot;
      const net = D(p.netPayout);
      const next = net.gt(autoMax) ? PAYOUT_STATUS.AWAITING_APPROVAL : autoEnabled && this.payos.isPayoutConfigured ? PAYOUT_STATUS.PROCESSING : PAYOUT_STATUS.PENDING;
      const ok = await this.prisma.$transaction(async (tx) => {
        const u = await tx.shopPayout.updateMany({ where: { id: p.id, status: PAYOUT_STATUS.HELD }, data: { status: next, holdReason: null, bankSnapshot: { bankCode: bank.bankCode, accountNumber: bank.accountNumber, accountName: bank.accountName }, version: { increment: 1 } } });
        if (u.count === 0) return false;
        await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.RETRIED, entityType: 'ShopPayout', entityId: p.id, entityCode: p.code, before: { status: PAYOUT_STATUS.HELD, holdReason: p.holdReason }, after: { status: next, released: true } });
        return true;
      });
      if (!ok) continue;
      released += 1;
      if (next === PAYOUT_STATUS.PROCESSING) await this.dispatch(p.id, p.code, p.shopId, net, bank, p.gatewayAttempt, actor);
    }
    return released;
  }

  /*
   * Lý do shop CÒN bị giữ chi trả (null = hết giữ, kèm TK hiện tại để chi): shop bị khoá / không hoạt động · lệnh giữ tay còn hiệu lực · TK ngân hàng vừa đổi (đang trong thời gian giữ) · chưa có TK.
   */
  private async holdBlock(shopId: string, holdHours: number): Promise<{ reason: string | null; bank: BankSnapshot | null }> {
    const brief = await this.shops.findBrief(shopId);
    if (!brief || brief.status !== 'approved') return { reason: 'Gian hàng đang bị khoá / không hoạt động', bank: null };
    const manual = await this.prisma.shopPayoutHold.findFirst({ where: { shopId, releasedAt: null }, select: { reason: true } });
    if (manual) return { reason: `Sàn đang giữ tiền chi trả của gian hàng: ${manual.reason}`, bank: null };
    const bank = await this.shops.bankAccountOf(shopId);
    if (!bank) return { reason: 'Gian hàng chưa khai báo tài khoản ngân hàng', bank: null };
    if (bank.pendingVerification) return { reason: BANK_UNVERIFIED_REASON, bank: null };
    if (bankJustChanged(bank, holdHours)) return { reason: `Tài khoản ngân hàng vừa thay đổi — còn trong thời gian tạm giữ ${holdHours} giờ`, bank: null };
    return { reason: null, bank };
  }

  /* "Mở giữ" một kỳ (kế toán bấm): còn lý do giữ ⇒ 409 KÈM LÝ DO (không trả 200 im lặng — AUD-08); hết lý do ⇒ kỳ về pending / đi tiếp. */
  async releaseOne(payoutId: string, actor: AuthenticatedActor | null) {
    const p = await this.mustFind(payoutId);
    if (p.status !== PAYOUT_STATUS.HELD) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Chỉ mở giữ được kỳ đang giữ (held), hiện là ${p.status}`);
    const block = await this.holdBlock(p.shopId, await this.holdHours());
    if (block.reason !== null) throw new BusinessException(PAYOUT_ERR.STILL_HELD, `Chưa mở giữ được: ${block.reason}`, HttpStatus.CONFLICT);
    await this.releaseHeld(payoutId, actor);
    return this.mustFind(payoutId);
  }

  // ------------------------------------------------------------ giữ tay (PLAN-0026 §2.4)

  /*
   * Giữ tay tiền chi trả của MỘT shop (có lý do): kỳ MỚI của shop vào `held`; kỳ đang `pending`/`awaiting_approval` chuyển `held` ngay (chưa gửi lệnh nên chặn được); kỳ đang `processing` (PayOS đã nhận) không thu hồi được.
   * Mỗi shop tối đa MỘT lệnh giữ đang hiệu lực (unique một phần ⇒ trùng ⇒ 409).
   */
  async createHold(shopId: string, reason: string, actor: AuthenticatedActor) {
    const text = reason.trim();
    if (text.length < 5) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Cần nêu lý do giữ (≥ 5 ký tự)');
    const brief = await this.shops.findBrief(shopId);
    if (!brief) throw new NotFoundException(PAYOUT_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const hold = await tx.shopPayoutHold.create({ data: { shopId, reason: text.slice(0, 255), createdBy: actor.userId } });
        const open = await tx.shopPayout.findMany({ where: { shopId, status: { in: [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.AWAITING_APPROVAL] } }, select: { id: true, code: true, status: true } });
        for (const o of open) {
          await tx.shopPayout.updateMany({ where: { id: o.id, status: o.status }, data: { status: PAYOUT_STATUS.HELD, holdReason: `Sàn đang giữ tiền chi trả của gian hàng: ${text}`.slice(0, 255), version: { increment: 1 } } });
        }
        await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.HOLD_CREATED, entityType: 'ShopPayoutHold', entityId: hold.id, entityCode: brief.code, after: { shopId, reason: text, heldPayouts: open.map((o) => o.code) } });
        return hold;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessException(PAYOUT_ERR.HOLD_EXISTS, 'Gian hàng này đã có lệnh giữ đang hiệu lực — mở giữ lệnh cũ trước', HttpStatus.CONFLICT);
      throw err;
    }
  }

  /* Mở lệnh giữ tay: đóng lệnh rồi mở giữ các kỳ `held` của shop mà không còn lý do giữ nào khác (khoá shop / đổi TK). Trả số kỳ được mở. */
  async releaseHold(holdId: string, actor: AuthenticatedActor): Promise<{ hold: { id: string; shopId: string }; released: number }> {
    const hold = await this.prisma.shopPayoutHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new NotFoundException(PAYOUT_ERR.HOLD_NOT_FOUND, 'Không tìm thấy lệnh giữ');
    const closed = await this.prisma.shopPayoutHold.updateMany({ where: { id: holdId, releasedAt: null }, data: { releasedAt: new Date(), releasedBy: actor.userId } });
    if (closed.count === 0) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Lệnh giữ đã được mở trước đó', HttpStatus.CONFLICT);
    await this.prisma.$transaction((tx) => this.audit.write(tx, actor, { action: PAYOUT_AUDIT.HOLD_RELEASED, entityType: 'ShopPayoutHold', entityId: holdId, entityCode: holdId, after: { shopId: hold.shopId } }));
    const held = await this.prisma.shopPayout.findMany({ where: { shopId: hold.shopId, status: PAYOUT_STATUS.HELD }, select: { id: true } });
    let released = 0;
    for (const h of held) released += await this.releaseHeld(h.id, actor);
    return { hold: { id: hold.id, shopId: hold.shopId }, released };
  }

  async listHolds(shopId?: string) {
    return this.prisma.shopPayoutHold.findMany({ where: shopId ? { shopId } : { releasedAt: null }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /* Shop không còn bán (bị khoá / từ chối / chờ duyệt) thì không chi — tiền giữ lại cho tới khi sàn mở khoá hoặc xử lý. */
  private async assertShopPayable(shopId: string): Promise<void> {
    const brief = await this.shops.findBrief(shopId);
    if (!brief || brief.status !== 'approved') throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Gian hàng đang bị khoá / không hoạt động — giữ chi trả');
  }

  /*
   * Đối chiếu một kỳ đang `processing` / `unknown` với PayOS (PayOS nhận lệnh là "00" nhưng tiền đi bất đồng bộ, chưa có webhook payout):
   *  - có mã lệnh (providerRef) ⇒ GET /v1/payouts/{id}; không có ⇒ tìm theo referenceId (khoá gửi đi).
   *  - succeeded ⇒ `paid` · failed ⇒ `failed` (gatewayStatus=failed: gửi lại bằng khoá MỚI) · processing ⇒ `processing` (ghi mã lệnh nếu tìm thấy).
   *  - PayOS xác nhận KHÔNG có lệnh nào (not_found) và đã chờ ≥ 10 phút ⇒ `failed` gatewayStatus=not_received (gửi lại bằng CÙNG khoá — an toàn nhờ idempotency).
   *  - tra cứu lỗi ⇒ giữ nguyên.
   * Compare-and-set theo trạng thái hiện tại nên chạy chồng (job + nút bấm) hoặc kế toán đánh dấu tay cùng lúc vẫn an toàn.
   */
  async reconcileOne(payoutId: string, actor: AuthenticatedActor | null): Promise<{ outcome: 'paid' | 'failed' | 'not_received' | 'processing' | 'unchanged'; detail: string }> {
    const p = await this.mustFind(payoutId);
    await this.assertPayoutFinanceSafety(p);
    if (p.status !== PAYOUT_STATUS.PROCESSING && p.status !== PAYOUT_STATUS.UNKNOWN) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Chỉ đối chiếu kỳ processing/unknown, hiện là ${p.status}`);
    if (!this.payos.isPayoutConfigured) return { outcome: 'unchanged', detail: 'PayOS payout chưa được cấu hình' };

    type Result = { state: 'succeeded' | 'failed' | 'processing'; detail: string };
    let found: { id?: string; result: Result } | 'not_found' | null = null;
    if (p.providerRef) {
      const r = await this.payos.getPayout(p.providerRef);
      found = r.state === 'unknown' ? null : { id: p.providerRef, result: { state: r.state, detail: r.detail } };
    } else {
      const r = await this.payos.findPayoutByReference(gatewayKey(p.code, p.gatewayAttempt));
      if (r.state === 'not_found') found = 'not_found';
      else if (r.state === 'found' && r.result) found = { id: r.id, result: r.result };
    }
    if (found === null) return { outcome: 'unchanged', detail: 'Chưa tra được PayOS — thử lại sau' };

    let next: string;
    let gatewayStatus: string;
    let failReason: string | null = null;
    let outcome: 'paid' | 'failed' | 'not_received' | 'processing';
    if (found === 'not_found') {
      if (!p.gatewayAttemptedAt || Date.now() - p.gatewayAttemptedAt.getTime() < 10 * 60_000) return { outcome: 'unchanged', detail: 'PayOS chưa thấy lệnh — chờ thêm trước khi kết luận' };
      next = PAYOUT_STATUS.FAILED;
      gatewayStatus = 'not_received';
      failReason = 'PayOS chưa nhận lệnh chi (đã tra theo referenceId) — có thể chạy lại';
      outcome = 'not_received';
    } else if (found.result.state === 'succeeded') {
      next = PAYOUT_STATUS.PAID;
      gatewayStatus = 'succeeded';
      outcome = 'paid';
    } else if (found.result.state === 'failed') {
      next = PAYOUT_STATUS.FAILED;
      gatewayStatus = 'failed';
      failReason = `PayOS: ${found.result.detail}`.slice(0, 500);
      outcome = 'failed';
    } else {
      next = PAYOUT_STATUS.PROCESSING;
      gatewayStatus = 'submitted';
      outcome = 'processing';
    }
    const detail = found === 'not_found' ? 'not_found' : found.result.detail;
    const lenhId = found === 'not_found' ? undefined : found.id;

    try {
      await this.prisma.$transaction(async (tx) => {
        const u = await tx.shopPayout.updateMany({
          where: { id: p.id, status: p.status },
          data: { status: next, gatewayStatus, failReason, ...(lenhId ? { providerRef: lenhId } : {}), ...(next === PAYOUT_STATUS.PAID ? { paidAt: new Date() } : {}), version: { increment: 1 } },
        });
        if (u.count === 0) return;
        await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.RECONCILED, entityType: 'ShopPayout', entityId: p.id, entityCode: p.code, before: { status: p.status }, after: { status: next, gatewayStatus, detail } });
        if (next === PAYOUT_STATUS.PAID) await this.outbox.publish(tx, { eventType: PAYMENT_EVENT.PAYOUT_PAID, aggregateType: 'ShopPayout', aggregateId: p.id, payload: this.eventPayload(p, next) });
        if (next === PAYOUT_STATUS.FAILED) await this.outbox.publish(tx, { eventType: PAYMENT_EVENT.PAYOUT_FAILED, aggregateType: 'ShopPayout', aggregateId: p.id, payload: { ...this.eventPayload(p, next), failReason } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessException(PAYOUT_ERR.PROVIDER_REF_DUPLICATE, 'Mã lệnh chi PayOS này đã gắn với một kỳ khác — cần kiểm tra thủ công', HttpStatus.CONFLICT);
      throw err;
    }
    return { outcome, detail };
  }

  /* Job 5 phút: đối chiếu mọi kỳ processing/unknown đã chờ ≥ 1 phút (cũ nhất trước). */
  async reconcileProcessing(limit = 50): Promise<{ checked: number; paid: number; failed: number }> {
    if (!this.payos.isPayoutConfigured) return { checked: 0, paid: 0, failed: 0 };
    const rows = await this.prisma.shopPayout.findMany({
      where: { status: { in: [PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.UNKNOWN] }, updatedAt: { lt: new Date(Date.now() - 60_000) } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let paid = 0;
    let failed = 0;
    for (const { id } of rows) {
      try {
        const r = await this.reconcileOne(id, null);
        if (r.outcome === 'paid') paid += 1;
        else if (r.outcome === 'failed' || r.outcome === 'not_received') failed += 1;
      } catch (err) {
        this.logger.warn(`Đối chiếu kỳ ${id} lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { checked: rows.length, paid, failed };
  }

  /* ============================== Truy vấn ============================== */

  /* Tên gian hàng cho danh sách/chi tiết kỳ đối soát phía sàn — MỘT truy vấn cho cả trang. */
  async shopNames(shopIds: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(shopIds)];
    if (uniq.length === 0) return new Map();
    const briefs = await this.shops.findManyBrief(uniq);
    return new Map([...briefs].map(([id, b]) => [id, b.name]));
  }

  /* Tên + mã gian hàng (AUD-09): kế toán không có quyền đọc shop nên phía sàn trả kèm trong kỳ/giữ tay/hoàn tiền — MỘT truy vấn cho cả trang. */
  async shopLabels(shopIds: string[]): Promise<Map<string, { name: string; code: string }>> {
    const uniq = [...new Set(shopIds)];
    if (uniq.length === 0) return new Map();
    const briefs = await this.shops.findManyBrief(uniq);
    return new Map([...briefs].map(([id, b]) => [id, { name: b.name, code: b.code }]));
  }

  /* shopId có giá trị = vendor xem kỳ của chính mình (kỳ shop khác → 404, không lộ sự tồn tại). */
  async getDetail(payoutId: string, shopId?: string) {
    const payout = await this.prisma.shopPayout.findFirst({ where: { id: payoutId, ...(shopId ? { shopId } : {}) }, include: { lines: { orderBy: { orderCode: 'asc' } } } });
    if (!payout) throw new NotFoundException(PAYOUT_ERR.NOT_FOUND, 'Không tìm thấy kỳ đối soát');
    return { payout, lines: payout.lines };
  }

  async list(filters: { status?: string; shopId?: string }, skip: number, take: number) {
    const where: Prisma.ShopPayoutWhereInput = { ...(filters.status ? { status: filters.status } : {}), ...(filters.shopId ? { shopId: filters.shopId } : {}) };
    const [items, total] = await Promise.all([this.prisma.shopPayout.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.shopPayout.count({ where })]);
    return { items, total };
  }

  /* Mốc kết thúc kỳ muộn nhất đã chạy (mọi shop) — cron tự động nối kỳ mới ngay sau mốc này; null = chưa chạy kỳ nào. */
  async latestPeriodEnd(): Promise<Date | null> {
    const last = await this.prisma.shopPayout.findFirst({ orderBy: { periodEnd: 'desc' }, select: { periodEnd: true } });
    return last?.periodEnd ?? null;
  }

  /* PayOS chi đã cấu hình khoá chưa (cron tự động chỉ chạy khi có). */
  get payoutConfigured(): boolean {
    return this.payos.isPayoutConfigured;
  }

  /* Số dư tài khoản chi PayOS (chỉ đọc). */
  async payosBalance(): Promise<{ configured: boolean; balance: string | null }> {
    if (!this.payos.isPayoutConfigured) return { configured: false, balance: null };
    const r = await this.payos.payoutBalance();
    return { configured: true, balance: r.balance === null ? null : r.balance.toString() };
  }

  /* ============================== Nội bộ ============================== */

  private async mustFind(payoutId: string) {
    const payout = await this.prisma.shopPayout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException(PAYOUT_ERR.NOT_FOUND, 'Không tìm thấy kỳ đối soát');
    return payout;
  }
  /* Gồm cả nguồn các kỳ trước để số dư demo dồn sang kỳ mới không thoát hàng rào. Bảo thủ: shop demo dùng DB riêng. */
  private async hasUnsafeSimulation(shopId: string, periodEnd: Date, currentCodes: string[] = []): Promise<boolean> {
    if (this.payos.isMockEndpoint) return false;
    const prior = await this.prisma.shopPayout.findMany({ where: { shopId, periodEnd: { lte: periodEnd } }, select: { id: true } });
    const lines = prior.length ? await this.prisma.shopPayoutLine.findMany({ where: { payoutId: { in: prior.map((p) => p.id) } }, select: { orderCode: true, sourceOrderCode: true } }) : [];
    const codes = [...new Set([...currentCodes, ...lines.map((l) => l.sourceOrderCode ?? l.orderCode)])];
    return codes.length > 0 && (await this.orders.simulatedOrderCodes(codes)).size > 0;
  }
  private async assertPayoutFinanceSafety(p: { shopId: string; periodEnd: Date }): Promise<void> {
    if (await this.hasUnsafeSimulation(p.shopId, p.periodEnd)) throw new BusinessException('PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED', 'Kỳ có nguồn đơn giả lập chỉ được xử lý trên PayOS mock cục bộ, không được chi tiền thật', 409);
  }

  private eventPayload(p: { id: string; code: string; shopId: string; netPayout: Dec }, status: string): Record<string, unknown> {
    return { payoutId: p.id, payoutCode: p.code, shopId: p.shopId, netPayout: D(p.netPayout).toFixed(0), status };
  }

  /* Gom dòng đối soát CHƯA từng được tính, theo shop: bán (đơn qua hạn đổi trả) + hoàn tiền của đơn đã được tính bán. */
  private async collect(periodEnd: Date): Promise<Map<string, DraftLine[]>> {
    const windowDays = await this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS);
    const eligible = await this.orders.settlementOrders(windowDays, periodEnd);

    const alreadySold = new Set<string>();
    for (const part of chunk(eligible.map((o) => o.orderCode))) {
      const rows = await this.prisma.shopPayoutLine.findMany({ where: { kind: PAYOUT_LINE_KIND.SALE, orderCode: { in: part } }, select: { orderCode: true } });
      for (const r of rows) alreadySold.add(r.orderCode);
    }

    const byShop = new Map<string, DraftLine[]>();
    const push = (shopId: string, line: DraftLine) => {
      const arr = byShop.get(shopId);
      if (arr) arr.push(line);
      else byShop.set(shopId, [line]);
    };
    // Hoa hồng hiệu dụng theo đơn (commission/gross của dòng bán) — để tính hoa hồng hoàn lại cho dòng hoàn tiền.
    const saleOfOrder = new Map<string, { gross: Dec; commission: Dec }>();

    for (const o of eligible) {
      if (alreadySold.has(o.orderCode)) continue;
      // Doanh thu của shop = khách trả + phần voucher SÀN chịu (sàn hoàn lại cho shop); hoa hồng tính trên doanh thu đó.
      // Doanh thu shop = khách trả + voucher sàn (sàn hoàn cho shop); hoa hồng tính trên TIỀN HÀNG sau voucher shop, KHÔNG phí ship (PLAN-0030).
      const gross = round0(o.shopRevenue !== undefined ? D(o.shopRevenue) : D(o.total).add(D(o.platformDiscount)));
      const commission = commissionOf(D(o.commissionBase ?? gross), D(o.commissionRateSnapshot));
      push(o.shopId, { key: o.orderCode, kind: PAYOUT_LINE_KIND.SALE, gross, commission });
      saleOfOrder.set(o.orderCode, { gross, commission });
    }

    // Hoàn tiền đã chi xong (tới hết kỳ), theo thứ tự thời gian. Dòng đã nằm trong kỳ trước nhận diện bằng khoá RF-…
    const refunds = await this.prisma.refund.findMany({ where: { status: 'done', shopId: { not: null }, processedAt: { lte: periodEnd } }, orderBy: [{ processedAt: 'asc' }, { id: 'asc' }], select: { id: true, orderCode: true, amount: true, shopId: true } });
    const included = new Set<string>();
    for (const part of chunk(refunds.map((r) => refundLineKey(r.id)))) {
      const rows = await this.prisma.shopPayoutLine.findMany({ where: { kind: PAYOUT_LINE_KIND.REFUND, orderCode: { in: part } }, select: { orderCode: true } });
      for (const r of rows) included.add(r.orderCode);
    }
    const refundsByOrder = new Map<string, typeof refunds>();
    for (const r of refunds) refundsByOrder.set(r.orderCode, [...(refundsByOrder.get(r.orderCode) ?? []), r]);
    const ordersWithNew = [...refundsByOrder].filter(([, list]) => list.some((r) => !included.has(refundLineKey(r.id)))).map(([code]) => code);

    // Chỉ trừ hoàn tiền của đơn ĐÃ được tính bán (kỳ này hoặc kỳ trước) — đơn hoàn toàn bộ trước khi qua escrow thì chưa từng được cộng.
    const unknownOrderCodes = ordersWithNew.filter((c) => !saleOfOrder.has(c));
    for (const part of chunk(unknownOrderCodes)) {
      const rows = await this.prisma.shopPayoutLine.findMany({ where: { kind: PAYOUT_LINE_KIND.SALE, orderCode: { in: part } }, select: { orderCode: true, gross: true, commission: true } });
      for (const r of rows) saleOfOrder.set(r.orderCode, { gross: D(r.gross), commission: D(r.commission) });
    }
    const totals = await this.orders.orderTotalsOf(ordersWithNew.filter((c) => saleOfOrder.has(c)));

    // Hoàn tiền chia theo TỈ LỆ LUỸ KẾ trên khách đã trả T: doanh thu bị hoàn = round(G × Σhoàn / T) (G = doanh thu đã tính cho shop = T + voucher sàn),
    // hoa hồng hoàn lại = round(C × Σhoàn / T). Mỗi dòng = chênh luỹ kế sau − trước ⇒ tổng các lần hoàn khớp tuyệt đối (hoàn đủ T ⇒ hoàn đúng G và C,
    // không lệch làm tròn) và voucher sàn được hoàn theo tỉ lệ khi đơn bị hoàn.
    for (const code of ordersWithNew) {
      const sale = saleOfOrder.get(code);
      const paid = totals.get(code);
      if (!sale || !paid) continue;
      const customerPaid = D(paid.total);
      if (customerPaid.lte(0)) continue;
      let cum = ZERO;
      for (const r of refundsByOrder.get(code) ?? []) {
        const before = cum;
        cum = cum.add(D(r.amount));
        const key = refundLineKey(r.id);
        if (included.has(key) || !r.shopId) continue;
        const gross = round0(sale.gross.mul(cum).div(customerPaid)).sub(round0(sale.gross.mul(before).div(customerPaid)));
        const commission = round0(sale.commission.mul(cum).div(customerPaid)).sub(round0(sale.commission.mul(before).div(customerPaid)));
        push(r.shopId, { key, kind: PAYOUT_LINE_KIND.REFUND, gross, commission, orderCode: r.orderCode });
      }
    }
    return byShop;
  }

  /* Một shop một transaction: tạo kỳ + dòng + audit + outbox; chi PayOS (nếu đủ điều kiện) SAU commit. */
  private async settleShop(shopId: string, lines: DraftLine[], periodStart: Date, periodEnd: Date, actor: AuthenticatedActor | null) {
    const unsafeDemo = await this.hasUnsafeSimulation(shopId, periodEnd, lines.map((l) => l.orderCode ?? l.key));
    const bank = await this.shops.bankAccountOf(shopId);
    const hold = await this.holdHours();
    const bankHeld = bankJustChanged(bank, hold);
    const bankUnverified = bank?.pendingVerification === true; // PLAN-0040 5.2: tên chủ TK lệch tên chủ shop, quản lý chưa xác minh
    const brief = await this.shops.findBrief(shopId);
    const shopSuspended = !brief || brief.status !== 'approved';
    const manualHold = await this.prisma.shopPayoutHold.findFirst({ where: { shopId, releasedAt: null }, select: { reason: true } });
    const [minAmount, autoMax] = await Promise.all([this.system.settingNumber(SETTING_KEY.PAYOUT_MIN_AMOUNT), this.system.settingNumber(SETTING_KEY.PAYOUT_AUTO_MAX_AMOUNT)]);
    const auto = !unsafeDemo && this.payos.isPayoutConfigured && bank !== null && !bankHeld && !bankUnverified && !shopSuspended && !manualHold;
    const baseCode = `PAY-${dateKey(periodStart)}-${dateKey(periodEnd)}-${shopId.replace(/-/g, '').slice(0, 8)}`.toUpperCase();

    const sum = (kind: string, pick: (l: DraftLine) => Dec) => lines.filter((l) => l.kind === kind).reduce((a, l) => a.add(pick(l)), ZERO);
    const grossRevenue = sum(PAYOUT_LINE_KIND.SALE, (l) => l.gross);
    const refundAmount = sum(PAYOUT_LINE_KIND.REFUND, (l) => l.gross);
    // Hoa hồng ròng = hoa hồng các đơn bán − hoa hồng hoàn lại trên phần đã hoàn.
    const commission = sum(PAYOUT_LINE_KIND.SALE, (l) => l.commission).sub(sum(PAYOUT_LINE_KIND.REFUND, (l) => l.commission));

    const created = await this.prisma.$transaction(async (tx: Tx) => {
      if (await tx.shopPayout.findUnique({ where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } }, select: { id: true } })) return null;
      const code = await uniquePayoutCode(tx, baseCode);

      // Mang sang từ kỳ GẦN NHẤT (đã gộp các kỳ trước vào net của nó): net âm = NỢ trừ vào kỳ này; kỳ `deferred` (dương nhưng dưới mức chi tối thiểu) = CÓ, cộng vào kỳ này
      // (lưu thành carriedDebt ÂM để công thức net = gross − hoa hồng − hoàn − carriedDebt giữ nguyên). Đọc dưới khoá dòng kỳ gần nhất (FOR UPDATE) chống hai lượt chạy chồng.
      const lastRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."shop_payouts" WHERE shop_id = ${shopId}::uuid ORDER BY period_end DESC, created_at DESC LIMIT 1 FOR UPDATE`;
      const last = lastRows[0] ? await tx.shopPayout.findUnique({ where: { id: lastRows[0].id }, select: { id: true, netPayout: true, status: true } }) : null;
      const carriedDebt = last && D(last.netPayout).lt(0) ? D(last.netPayout).neg() : last && last.status === PAYOUT_STATUS.DEFERRED ? D(last.netPayout).neg() : ZERO;
      const net = grossRevenue.sub(commission).sub(refundAmount).sub(carriedDebt);

      let status: string = PAYOUT_STATUS.PENDING;
      let failReason: string | null = null;
      let holdReason: string | null = null;
      if (net.lt(0)) status = PAYOUT_STATUS.CARRIED;
      else if (net.eq(0)) status = PAYOUT_STATUS.SETTLED;
      else if (net.lt(minAmount)) {
        status = PAYOUT_STATUS.DEFERRED; // dưới mức chi tối thiểu ⇒ dồn sang kỳ sau (số dương mang sang)
        failReason = `Thực nhận dưới mức chi tối thiểu (${minAmount.toLocaleString('vi-VN')}đ) — dồn sang kỳ sau`;
      } else if (shopSuspended) {
        status = PAYOUT_STATUS.HELD;
        holdReason = 'Gian hàng đang bị khoá / không hoạt động — giữ tiền chi trả';
      } else if (manualHold) {
        status = PAYOUT_STATUS.HELD;
        holdReason = `Sàn đang giữ tiền chi trả của gian hàng: ${manualHold.reason}`.slice(0, 255);
      } else if (bankUnverified) {
        status = PAYOUT_STATUS.HELD;
        holdReason = BANK_UNVERIFIED_REASON;
      } else if (bankHeld) {
        status = PAYOUT_STATUS.HELD;
        holdReason = `Tài khoản ngân hàng vừa được thay đổi — tạm giữ chi trả ${hold} giờ để bảo vệ gian hàng`;
      } else if (unsafeDemo) {
        status = PAYOUT_STATUS.PENDING;
        failReason = 'Nguồn đơn giả lập: chỉ chi qua PayOS mock cục bộ, không chuyển tiền thật';
      } else if (net.gt(autoMax)) {
        status = PAYOUT_STATUS.AWAITING_APPROVAL; // vượt hạn mức tự chi ⇒ kế toán duyệt trước khi gửi PayOS
      } else if (auto) status = PAYOUT_STATUS.PROCESSING;
      else if (bank === null) failReason = 'Shop chưa khai báo tài khoản ngân hàng';

      const payout = await tx.shopPayout.create({
        data: {
          code,
          shopId,
          periodStart,
          periodEnd,
          grossRevenue,
          commission,
          refundAmount,
          carriedDebt,
          netPayout: net,
          status,
          failReason,
          holdReason,
          bankSnapshot: bank ? ({ bankCode: bank.bankCode, accountNumber: bank.accountNumber, accountName: bank.accountName } satisfies BankSnapshot) : undefined,
          createdBy: actor?.userId ?? null,
        },
      });
      // Kỳ `deferred` trước đó đã được CỘNG vào kỳ này (carriedDebt âm) ⇒ không còn là khoản chờ chi riêng: `merged`.
      if (last && last.status === PAYOUT_STATUS.DEFERRED) await tx.shopPayout.updateMany({ where: { id: last.id, status: PAYOUT_STATUS.DEFERRED }, data: { status: PAYOUT_STATUS.MERGED, version: { increment: 1 } } });
      await tx.shopPayoutLine.createMany({ data: lines.map((l) => ({ payoutId: payout.id, orderCode: l.key, kind: l.kind, gross: l.gross, commission: l.commission, ...(l.orderCode ? { sourceOrderCode: l.orderCode } : {}) })) });
      await this.audit.write(tx, actor, {
        action: PAYOUT_AUDIT.CREATED,
        entityType: 'ShopPayout',
        entityId: payout.id,
        entityCode: code,
        after: { shopId, periodStart, periodEnd, grossRevenue: grossRevenue.toFixed(0), commission: commission.toFixed(0), refundAmount: refundAmount.toFixed(0), carriedDebt: carriedDebt.toFixed(0), netPayout: net.toFixed(0), status, lines: lines.length },
      });
      await this.outbox.publish(tx, { eventType: PAYMENT_EVENT.PAYOUT_CREATED, aggregateType: 'ShopPayout', aggregateId: payout.id, payload: this.eventPayload(payout, status) });
      return payout;
    });
    if (!created) return null;

    if (created.status === PAYOUT_STATUS.PROCESSING && bank) await this.dispatch(created.id, created.code, shopId, D(created.netPayout), bank, created.gatewayAttempt, actor);
    return this.mustFind(created.id);
  }

  /*
   * Gọi PayOS chi tiền cho kỳ đang `processing` rồi ghi kết quả (NGOÀI transaction). Phân loại:
   *  - PayOS nhận lệnh ("00") ⇒ processing + gatewayStatus=submitted + mã lệnh (providerRef).
   *  - PayOS TỪ CHỐI chắc chắn (4xx / mã nghiệp vụ lỗi) ⇒ failed + gatewayStatus=failed (gửi lại bằng khoá mới).
   *  - KHÔNG RÕ (timeout / 5xx / mất kết nối / không đọc được phản hồi) ⇒ `unknown` + gatewayAttemptedAt: tiền CÓ THỂ đã đi — không chi lại, không đánh dấu tay;
   *    job đối chiếu / nút "Kiểm tra với PayOS" quyết định.
   */
  private async dispatch(payoutId: string, code: string, shopId: string, net: Dec, bank: BankSnapshot, attempt: number, actor: AuthenticatedActor | null): Promise<void> {
    await this.assertPayoutFinanceSafety(await this.mustFind(payoutId));
    const key = gatewayKey(code, attempt);
    // AUD-07: tra số dư tài khoản chi TRƯỚC khi gửi — không đủ ⇒ KHÔNG gửi (không để PayOS từ chối / không để kỳ treo `processing`): về `pending` kèm lý do + báo kế toán nạp quỹ rồi bấm Gửi lại.
    const bal = await this.payos.payoutBalance().catch(() => ({ balance: null as bigint | null }));
    if (bal.balance !== null && bal.balance < BigInt(net.toFixed(0))) {
      const reason = `Số dư tài khoản chi PayOS không đủ (còn ${bal.balance.toString()}đ, cần ${net.toFixed(0)}đ) — nạp thêm quỹ rồi bấm Gửi lại`;
      const back = await this.prisma.shopPayout.updateMany({ where: { id: payoutId, status: PAYOUT_STATUS.PROCESSING }, data: { status: PAYOUT_STATUS.PENDING, failReason: reason, version: { increment: 1 } } });
      if (back.count > 0) {
        await this.prisma.$transaction((tx) => this.audit.write(tx, actor, { action: PAYOUT_AUDIT.FAILED, entityType: 'ShopPayout', entityId: payoutId, entityCode: code, after: { status: PAYOUT_STATUS.PENDING, reason: 'insufficient_balance', balance: bal.balance?.toString() ?? null, need: net.toFixed(0) } }));
        await this.notifyAccountants(`Cần nạp quỹ chi trả — kỳ ${code}`, reason, { payoutId, payoutCode: code, reason: 'insufficient_balance' });
        this.logger.warn(`Kỳ ${code} chưa gửi PayOS: ${reason}`);
      }
      return;
    }
    const res = await this.payos.payout({
      referenceId: key,
      amount: BigInt(net.toFixed(0)),
      toBin: bank.bankCode,
      toAccountNumber: bank.accountNumber,
      description: `FITLY ${code}`.slice(0, 50),
      idempotencyKey: key,
    });

    const outcome: 'submitted' | 'failed' | 'unknown' = res.ok ? 'submitted' : res.definite ? 'failed' : 'unknown';
    const status = outcome === 'submitted' ? PAYOUT_STATUS.PROCESSING : outcome === 'failed' ? PAYOUT_STATUS.FAILED : PAYOUT_STATUS.UNKNOWN;
    const failReason = outcome === 'submitted' ? null : `${res.code}: ${res.message}`.slice(0, 500);
    try {
      await this.prisma.$transaction(async (tx) => {
        const r = await tx.shopPayout.updateMany({
          where: { id: payoutId, status: PAYOUT_STATUS.PROCESSING },
          data: { status, failReason, gatewayStatus: outcome, gatewayAttemptedAt: new Date(), providerRef: res.transactionId ?? null, version: { increment: 1 } },
        });
        if (r.count === 0) return; // đã bị xử lý giữa chừng (đối chiếu / đánh dấu tay)
        await this.audit.write(tx, actor, { action: outcome === 'submitted' ? PAYOUT_AUDIT.SENT : outcome === 'failed' ? PAYOUT_AUDIT.FAILED : PAYOUT_AUDIT.UNKNOWN, entityType: 'ShopPayout', entityId: payoutId, entityCode: code, after: { status, gatewayStatus: outcome, providerRef: res.transactionId ?? null, failReason, key } });
        await this.outbox.publish(tx, { eventType: outcome === 'submitted' ? PAYMENT_EVENT.PAYOUT_PROCESSING : PAYMENT_EVENT.PAYOUT_FAILED, aggregateType: 'ShopPayout', aggregateId: payoutId, payload: { payoutId, payoutCode: code, shopId, netPayout: net.toFixed(0), status, ...(outcome === 'submitted' ? {} : { failReason }) } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // PayOS trả mã lệnh đã gắn với kỳ khác: KHÔNG ghi đè — để kỳ ở `unknown` cho người kiểm tra.
        await this.prisma.shopPayout.updateMany({ where: { id: payoutId, status: PAYOUT_STATUS.PROCESSING }, data: { status: PAYOUT_STATUS.UNKNOWN, gatewayStatus: 'unknown', gatewayAttemptedAt: new Date(), failReason: 'Mã lệnh chi PayOS trùng với kỳ khác — kiểm tra thủ công' } });
        this.logger.error(`Mã lệnh PayOS của kỳ ${code} trùng kỳ khác`);
        return;
      }
      throw err;
    }
    if (outcome !== 'submitted') {
      this.logger.warn(`Chi PayOS kỳ ${code} ${outcome === 'failed' ? 'bị từ chối' : 'KHÔNG RÕ kết quả'}: ${failReason}`);
      await this.notifyAccountants(outcome === 'failed' ? `Chi trả kỳ ${code} bị PayOS từ chối` : `Chi trả kỳ ${code} KHÔNG RÕ kết quả`, `${failReason ?? ''}. ${/số dư|balance/i.test(failReason ?? '') ? 'Nạp thêm quỹ chi rồi bấm Gửi lại.' : outcome === 'failed' ? 'Kiểm tra lý do rồi bấm Gửi lại.' : 'Bấm "Kiểm tra với PayOS" — KHÔNG chuyển tay khi chưa tra.'}`, { payoutId, payoutCode: code, outcome });
    }
  }

  /* Báo kế toán (người có quyền xử lý chi trả). Lỗi tra cứu/gửi không được làm hỏng luồng tiền ⇒ nuốt + log. */
  private async notifyAccountants(title: string, content: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const ids = await this.users.staffUserIdsWithPermission('supplier.payout.process');
      if (ids.length === 0) return;
      await this.notifier.notifyMany(ids.map((userId) => ({ userId, type: 'payment', title, content: content.slice(0, 500), link: '/payment/payouts', payload })));
    } catch (err) {
      this.logger.warn({ err }, 'Không gửi được thông báo cho kế toán');
    }
  }
}
