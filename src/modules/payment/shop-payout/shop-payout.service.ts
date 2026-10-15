import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
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
/* Sau khi shop ĐỔI tài khoản ngân hàng, tạm giữ chi trả (chi tự động/gửi lại) trong 24 giờ — kẻ chiếm phiên không chuyển được tiền kỳ gần nhất sang TK của mình; chủ shop có thời gian nhận thông báo và báo sàn. */
const BANK_CHANGE_HOLD_MS = 24 * 3_600_000;
const bankJustChanged = (b: { changedAt: Date | null } | null) => !!b?.changedAt && Date.now() - b.changedAt.getTime() < BANK_CHANGE_HOLD_MS;

/* Kỳ `processing` quá lâu không có kết quả ⇒ coi là treo, cho phép gửi lại (an toàn nhờ idempotency-key). */
const STUCK_PROCESSING_MS = 10 * 60_000;
const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/*
 * Đối soát chi trả shop (PLAN-0017/0018): mỗi kỳ gom đơn ĐÃ THU TIỀN VỀ SÀN — cả PayOS lẫn COD (sàn thu hộ qua đơn vị vận chuyển) — đã qua hạn đổi trả (escrow, tính từ ngày giao) chưa nằm trong kỳ nào,
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
  ) {}

  /* ============================== Chạy kỳ ============================== */

  async run(input: ShopPayoutRunInput, actor: AuthenticatedActor | null) {
    const { periodStart, periodEnd } = input;
    if (!(periodStart.getTime() < periodEnd.getTime())) throw new BusinessException(PAYOUT_ERR.INVALID_PERIOD, 'Ngày bắt đầu kỳ phải trước ngày kết thúc');
    if (periodEnd.getTime() > Date.now()) throw new BusinessException(PAYOUT_ERR.INVALID_PERIOD, 'Kỳ đối soát chưa kết thúc — chọn ngày kết thúc không muộn hơn hiện tại');

    // Kỳ mới không được chồng lên kỳ đã chạy (chuỗi nợ mang sang tính theo thứ tự thời gian) — trừ chạy lại ĐÚNG kỳ cũ (idempotent).
    const overlap = await this.prisma.shopPayout.findFirst({
      where: { periodEnd: { gt: periodStart }, OR: [{ periodStart: { not: periodStart } }, { periodEnd: { not: periodEnd } }] },
      select: { code: true },
    });
    if (overlap) throw new BusinessException(PAYOUT_ERR.PERIOD_OVERLAP, `Kỳ chồng lên kỳ đã chạy (${overlap.code}) — chọn kỳ bắt đầu sau ngày kết thúc kỳ trước`, HttpStatus.CONFLICT);

    const drafts = await this.collect(periodEnd);
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

  /* ============================== Retry / mark-paid ============================== */

  /* Gửi lại lệnh chi: kỳ `failed`; `pending` khi giờ đã có khoá payout (vd shop vừa bổ sung TK ngân hàng); `processing` bị TREO quá
     hạn (tiến trình chết giữa lúc gọi PayOS) — idempotency-key = mã kỳ nên gửi lại không chi đôi. */
  async retry(payoutId: string, actor: AuthenticatedActor) {
    const payout = await this.mustFind(payoutId);
    const stuck = payout.status === PAYOUT_STATUS.PROCESSING && Date.now() - payout.updatedAt.getTime() > STUCK_PROCESSING_MS;
    if (payout.status !== PAYOUT_STATUS.FAILED && payout.status !== PAYOUT_STATUS.PENDING && !stuck) {
      throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Chỉ chạy lại được kỳ failed/pending hoặc processing treo > ${STUCK_PROCESSING_MS / 60_000} phút, hiện là ${payout.status}`);
    }
    if (!this.payos.isPayoutConfigured) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'PayOS payout chưa cấu hình — dùng đánh dấu đã trả tay');
    if (!D(payout.netPayout).gt(0)) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ không có khoản cần chi');

    // Luôn đọc TK hiện tại để áp giữ chi trả — kỳ bị giữ lúc chạy kỳ vẫn mang snapshot TK MỚI, nếu bỏ qua kiểm tra khi đã có snapshot thì "chạy lại" ngay sẽ vô hiệu 24 giờ giữ.
    const current = await this.shops.bankAccountOf(payout.shopId);
    if (bankJustChanged(current)) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Tài khoản ngân hàng vừa thay đổi — tạm giữ chi trả 24 giờ, thử lại sau');
    let bank = payout.bankSnapshot as unknown as BankSnapshot | null;
    if (!bank) {
      if (!current) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Shop chưa khai báo tài khoản ngân hàng');
      bank = current;
    }

    const moved = await this.prisma.$transaction(async (tx) => {
      const r = await tx.shopPayout.updateMany({
        // version đã đọc nằm trong điều kiện ⇒ hai người cùng bấm "chạy lại" trên một kỳ chỉ một người giành được (kể cả kỳ processing treo).
        where: { id: payoutId, status: payout.status, version: payout.version },
        data: { status: PAYOUT_STATUS.PROCESSING, failReason: null, bankSnapshot: bank as unknown as Prisma.InputJsonObject, version: { increment: 1 } },
      });
      if (r.count === 0) return false;
      await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.RETRIED, entityType: 'ShopPayout', entityId: payoutId, entityCode: payout.code, before: { status: payout.status, failReason: payout.failReason }, after: { status: PAYOUT_STATUS.PROCESSING } });
      return true;
    });
    if (!moved) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ vừa được xử lý bởi người khác — tải lại', HttpStatus.CONFLICT);

    await this.dispatch(payoutId, payout.code, payout.shopId, D(payout.netPayout), bank, actor);
    return this.mustFind(payoutId);
  }

  /* Kế toán xác nhận đã chuyển khoản tay (hoặc đối chiếu `processing` trên bảng điều khiển PayOS — chưa có webhook payout).
     `pending` chỉ cho phép khi CHƯA cấu hình payout tự động (có cấu hình thì đi đường PayOS + retry). */
  async markPaid(payoutId: string, input: { providerRef: string; note?: string }, actor: AuthenticatedActor) {
    const payout = await this.mustFind(payoutId);
    const allowed: string[] = [PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.FAILED, ...(this.payos.isPayoutConfigured ? [] : [PAYOUT_STATUS.PENDING])];
    if (!allowed.includes(payout.status)) {
      const hint = payout.status === PAYOUT_STATUS.PENDING ? ' — đã cấu hình PayOS payout nên dùng "chạy lại"' : '';
      throw new BusinessException(PAYOUT_ERR.INVALID_STATE, `Không thể đánh dấu đã trả từ trạng thái ${payout.status}${hint}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const r = await tx.shopPayout.updateMany({
        where: { id: payoutId, status: payout.status },
        data: { status: PAYOUT_STATUS.PAID, providerRef: input.providerRef, failReason: null, paidAt: new Date(), version: { increment: 1 } },
      });
      if (r.count === 0) throw new BusinessException(PAYOUT_ERR.INVALID_STATE, 'Kỳ vừa được xử lý bởi người khác — tải lại', HttpStatus.CONFLICT);
      await this.audit.write(tx, actor, { action: PAYOUT_AUDIT.MARKED_PAID, entityType: 'ShopPayout', entityId: payoutId, entityCode: payout.code, before: { status: payout.status }, after: { status: PAYOUT_STATUS.PAID, providerRef: input.providerRef, note: input.note ?? null } });
      await this.outbox.publish(tx, { eventType: PAYMENT_EVENT.PAYOUT_PAID, aggregateType: 'ShopPayout', aggregateId: payoutId, payload: this.eventPayload(payout, PAYOUT_STATUS.PAID) });
      return tx.shopPayout.findUniqueOrThrow({ where: { id: payoutId } });
    });
  }

  /* ============================== Truy vấn ============================== */

  /* Tên gian hàng cho danh sách/chi tiết kỳ đối soát phía sàn — MỘT truy vấn cho cả trang. */
  async shopNames(shopIds: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(shopIds)];
    if (uniq.length === 0) return new Map();
    const briefs = await this.shops.findManyBrief(uniq);
    return new Map([...briefs].map(([id, b]) => [id, b.name]));
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
      const gross = round0(D(o.total).add(D(o.platformDiscount)));
      const commission = commissionOf(gross, D(o.commissionRateSnapshot));
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
        push(r.shopId, { key, kind: PAYOUT_LINE_KIND.REFUND, gross, commission });
      }
    }
    return byShop;
  }

  /* Một shop một transaction: tạo kỳ + dòng + audit + outbox; chi PayOS (nếu đủ điều kiện) SAU commit. */
  private async settleShop(shopId: string, lines: DraftLine[], periodStart: Date, periodEnd: Date, actor: AuthenticatedActor | null) {
    const bank = await this.shops.bankAccountOf(shopId);
    const held = bankJustChanged(bank);
    const auto = this.payos.isPayoutConfigured && bank !== null && !held;
    const code = `PAY-${dateKey(periodStart)}-${dateKey(periodEnd)}-${shopId.replace(/-/g, '').slice(0, 8)}`.toUpperCase();

    const sum = (kind: string, pick: (l: DraftLine) => Dec) => lines.filter((l) => l.kind === kind).reduce((a, l) => a.add(pick(l)), ZERO);
    const grossRevenue = sum(PAYOUT_LINE_KIND.SALE, (l) => l.gross);
    const refundAmount = sum(PAYOUT_LINE_KIND.REFUND, (l) => l.gross);
    // Hoa hồng ròng = hoa hồng các đơn bán − hoa hồng hoàn lại trên phần đã hoàn.
    const commission = sum(PAYOUT_LINE_KIND.SALE, (l) => l.commission).sub(sum(PAYOUT_LINE_KIND.REFUND, (l) => l.commission));

    const created = await this.prisma.$transaction(async (tx: Tx) => {
      if (await tx.shopPayout.findUnique({ where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } }, select: { id: true } })) return null;

      // Nợ mang sang = phần âm còn lại của kỳ GẦN NHẤT (kỳ gần nhất đã gộp nợ các kỳ trước vào net của nó).
      const last = await tx.shopPayout.findFirst({ where: { shopId }, orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }], select: { netPayout: true } });
      const carriedDebt = last && D(last.netPayout).lt(0) ? D(last.netPayout).neg() : ZERO;
      const net = grossRevenue.sub(commission).sub(refundAmount).sub(carriedDebt);

      let status: string = PAYOUT_STATUS.PENDING;
      let failReason: string | null = null;
      if (net.lt(0)) status = PAYOUT_STATUS.CARRIED;
      else if (net.eq(0)) status = PAYOUT_STATUS.SETTLED;
      else if (auto) status = PAYOUT_STATUS.PROCESSING;
      else if (bank === null) failReason = 'Shop chưa khai báo tài khoản ngân hàng';
      else if (held) failReason = 'Tài khoản ngân hàng vừa được thay đổi — tạm giữ chi trả 24 giờ để bảo vệ gian hàng';

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
          bankSnapshot: bank ? ({ bankCode: bank.bankCode, accountNumber: bank.accountNumber, accountName: bank.accountName } satisfies BankSnapshot) : undefined,
          createdBy: actor?.userId ?? null,
        },
      });
      await tx.shopPayoutLine.createMany({ data: lines.map((l) => ({ payoutId: payout.id, orderCode: l.key, kind: l.kind, gross: l.gross, commission: l.commission })) });
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

    if (created.status === PAYOUT_STATUS.PROCESSING && bank) await this.dispatch(created.id, created.code, shopId, D(created.netPayout), bank, actor);
    return this.mustFind(created.id);
  }

  /* Gọi PayOS chi tiền cho kỳ đang `processing` rồi ghi kết quả. Idempotency-key = mã kỳ ⇒ gọi lại không chi đôi. */
  private async dispatch(payoutId: string, code: string, shopId: string, net: Dec, bank: BankSnapshot, actor: AuthenticatedActor | null): Promise<void> {
    const res = await this.payos.payout({
      referenceId: code,
      amount: BigInt(net.toFixed(0)),
      toBin: bank.bankCode,
      toAccountNumber: bank.accountNumber,
      description: `FITLY ${code}`.slice(0, 50),
      idempotencyKey: code,
    });

    const ok = res.ok;
    const status = ok ? PAYOUT_STATUS.PROCESSING : PAYOUT_STATUS.FAILED;
    const failReason = ok ? null : `${res.code}: ${res.message}`.slice(0, 500);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.shopPayout.updateMany({
        where: { id: payoutId, status: PAYOUT_STATUS.PROCESSING },
        data: { status, failReason, providerRef: res.transactionId ?? null, version: { increment: 1 } },
      });
      if (r.count === 0) return; // đã bị mark-paid giữa chừng
      await this.audit.write(tx, actor, { action: ok ? PAYOUT_AUDIT.SENT : PAYOUT_AUDIT.FAILED, entityType: 'ShopPayout', entityId: payoutId, entityCode: code, after: { status, providerRef: res.transactionId ?? null, failReason } });
      await this.outbox.publish(tx, { eventType: ok ? PAYMENT_EVENT.PAYOUT_PROCESSING : PAYMENT_EVENT.PAYOUT_FAILED, aggregateType: 'ShopPayout', aggregateId: payoutId, payload: { payoutId, payoutCode: code, shopId, netPayout: net.toFixed(0), status, ...(ok ? {} : { failReason }) } });
    });
    if (!ok) this.logger.warn(`Chi PayOS kỳ ${code} thất bại: ${failReason}`);
  }
}
