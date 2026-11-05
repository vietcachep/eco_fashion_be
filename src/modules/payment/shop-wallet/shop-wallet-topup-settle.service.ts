import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { retryOnDeadlock } from '@common/prisma/errors';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { TOPUP_CLOSED_STATUSES, TOPUP_MAX_AMOUNT_COLUMN, TOPUP_OPEN_STATUSES, TOPUP_REF_PREFIX, TOPUP_STATUS, TOPUP_STATUS_VALUES, TOPUP_TIMING, WALLET_AUDIT, WALLET_ERR } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { ShopWalletService } from './shop-wallet.service';
import type { TopupReconcileOutcome, TopupRow, TopupStatus, TopupWebhookResult } from './shop-wallet-topup.types';

/* Quyền theo catalog (identity/permission/catalog.ts): chủ shop nhận báo ghi có (shop.wallet.read); kế toán + admin nhận báo bất thường (supplier.wallet.approve). */
const SHOP_WALLET_READ = 'shop.wallet.read';
const SUPPLIER_WALLET_APPROVE = 'supplier.wallet.approve';
/* Lý do ghi vào dòng khoản nạp mồ côi: PayOS không biết link sau 90 giây ⇒ không có link thật để thanh toán. */
const LINK_MISSING_ERROR = 'PayOS không có link';

type AlertReason = 'overpaid' | 'duplicate' | 'late' | 'partial_closed' | 'invalid_amount' | 'unkeyed';

/* Một sự kiện đưa tiền vào khoản: webhook (có mã giao dịch của từng khoản tiền) hoặc poll (luỹ kế PayOS báo về). */
type TopupEvent = { source: 'webhook'; reference: string; amount: bigint; raw: Record<string, unknown> } | { source: 'poll'; cumulative: bigint; gatewayStatus: string | null };

/* Kết quả một lần ghi nhận đã nằm trong transaction: dùng để tính thông báo SAU commit. */
interface Applied {
  topupId: string;
  shopId: string;
  payosOrderCode: string;
  amount: bigint;
  before: { status: TopupStatus; received: bigint };
  after: { status: TopupStatus; received: bigint };
  credited: bigint;
  balanceAfter: bigint | null;
}

interface CloseDecision {
  status: TopupStatus;
  linkError: string | null;
}

interface ReconcileResult {
  applied: Applied | null;
  closed: { partialClosed: boolean; topupId: string; shopId: string; payosOrderCode: string; amount: bigint; received: bigint } | null;
}

/*
 * Hàm thuần của PLAN-0041 §6.3 — export để test (WTX-01…05). Mọi đường ghi có dùng ĐÚNG các hàm này, không công thức riêng.
 */

/* Số tiền từ PayOS: số nguyên hữu hạn trong trần cột numeric(14,0). Thập phân, NaN, chữ, âm ⇒ null — không bao giờ ghi có từ một số sai. */
export function parseMoney(v: unknown, allowZero = false): bigint | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = Number(v.trim());
  else return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (n === 0 && !allowZero) return null;
  const big = BigInt(n);
  return big > TOPUP_MAX_AMOUNT_COLUMN ? null : big;
}

/* Khoá của MỘT khoản tiền trong webhook (biên nhận khử trùng theo khoản): `reference` của PayOS; thiếu thì ghép từ mã + giờ giao dịch + số tiền; không có gì ⇒ null. */
export function receiptRef(payosOrderCode: string, data: Record<string, unknown>): string | null {
  if (typeof data.reference === 'string' && data.reference.trim() !== '') return data.reference.trim().slice(0, 100);
  if (typeof data.transactionDateTime === 'string' && data.transactionDateTime.trim() !== '') {
    const amount = typeof data.amount === 'number' || typeof data.amount === 'string' ? data.amount : '';
    return `${payosOrderCode}:${data.transactionDateTime}:${amount}`.slice(0, 100);
  }
  return null;
}

/* Mục tiêu luỹ kế = max(Σ biên nhận, luỹ kế PayOS đã hỏi, đã ghi có). Hai nguồn đầu là CẬN DƯỚI của tổng tiền thật (PLAN-0041 D2); không bao giờ thấp hơn đã ghi có. */
export function targetCumulative(sumReceipts: bigint, polled: bigint, alreadyReceived: bigint): bigint {
  let target = sumReceipts;
  if (polled > target) target = polled;
  if (alreadyReceived > target) target = alreadyReceived;
  return target;
}

/* Bảng chuyển trạng thái theo tiền (PLAN-0041 §4.2): đủ tiền ⇒ paid (kể cả đã đóng); có tiền nhưng chưa đủ và còn mở ⇒ partial; còn lại giữ nguyên. */
export function nextStatusAfterMoney(status: TopupStatus, received: bigint, amount: bigint): TopupStatus {
  if (received >= amount) return TOPUP_STATUS.PAID;
  if (received > 0n && isOpenStatus(status)) return TOPUP_STATUS.PARTIAL;
  return status;
}

function isOpenStatus(s: string): boolean {
  return TOPUP_OPEN_STATUSES.includes(s);
}

function isClosedStatus(s: string): boolean {
  return TOPUP_CLOSED_STATUSES.includes(s);
}

function isTopupStatus(s: string): s is TopupStatus {
  return TOPUP_STATUS_VALUES.includes(s);
}

function statusOf(s: string): TopupStatus {
  if (!isTopupStatus(s)) throw new Error(`Trạng thái khoản nạp không hợp lệ: ${s}`);
  return s;
}

/* Cột numeric(14,0) đọc qua Prisma là Decimal ⇒ đổi sang bigint nguyên đồng để cộng trừ không float. */
const dv = (d: Prisma.Decimal): bigint => vnd(d.toFixed(0));

/* Bản lưu biên nhận (kế toán đối chiếu tài khoản đối ứng, PLAN-0041 R5): chỉ giá trị nguyên thuỷ, bỏ khoá rỗng, chuỗi cắt 500 ký tự. Không đưa vào log/audit/thông báo. */
function compactRaw(data: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {
      if (v.trim() !== '') out[k] = v.slice(0, 500);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/*
 * Quyết định ĐÓNG một khoản đang mở (PLAN-0041 §4.2, D20). Chỉ đóng theo HẠN khi PayOS đã trả lời (WTS-16: PayOS lỗi ⇒ khoản mở không bị đóng);
 * dòng `creating` mồ côi quá 90 giây (PayOS không biết link) ⇒ failed. `forceClose` (chủ shop tạo link mới khi link cũ đã quá hạn) đóng ngay khi quá hạn.
 */
function closeDecisionOf(t: TopupRow, gw: { status: string | null; known: boolean }, nowMs: number, forceClose: boolean): CloseDecision | null {
  if (!isOpenStatus(t.status)) return null;
  if (gw.status === 'CANCELLED') return { status: TOPUP_STATUS.CANCELLED, linkError: null };
  if (gw.status === 'EXPIRED') return { status: TOPUP_STATUS.EXPIRED, linkError: null };
  const creating = t.status === TOPUP_STATUS.CREATING;
  if (creating && !gw.known && nowMs - t.createdAt.getTime() > TOPUP_TIMING.ORPHAN_MS) return { status: TOPUP_STATUS.FAILED, linkError: LINK_MISSING_ERROR };
  if (forceClose && creating) return gw.known ? { status: TOPUP_STATUS.EXPIRED, linkError: null } : { status: TOPUP_STATUS.FAILED, linkError: LINK_MISSING_ERROR };
  if (forceClose && t.expiresAt.getTime() <= nowMs) return { status: TOPUP_STATUS.EXPIRED, linkError: null };
  if (gw.known && t.expiresAt.getTime() + TOPUP_TIMING.EXPIRE_GRACE_MS < nowMs) return { status: TOPUP_STATUS.EXPIRED, linkError: null };
  return null;
}

function closeAuditAction(status: TopupStatus): string {
  if (status === TOPUP_STATUS.EXPIRED) return WALLET_AUDIT.TOPUP_EXPIRED;
  if (status === TOPUP_STATUS.CANCELLED) return WALLET_AUDIT.TOPUP_CANCELLED;
  return WALLET_AUDIT.TOPUP_LINK_FAILED;
}

/* Lý do báo kế toán khi một lần ghi có là BẤT THƯỜNG (PLAN-0041 §4.3): trùng > thừa > muộn (ưu tiên theo thứ tự). Ghi có bình thường ⇒ null. */
function creditAlertReason(a: Applied): 'duplicate' | 'overpaid' | 'late' | null {
  if (a.credited <= 0n) return null;
  if (a.before.received >= a.amount) return 'duplicate';
  if (a.after.received > a.amount) return 'overpaid';
  if (isClosedStatus(a.before.status)) return 'late';
  return null;
}

function alertText(a: { payosOrderCode: string; reason: AlertReason; requested?: bigint; received?: bigint }, shopName: string): { title: string; content: string } {
  const code = a.payosOrderCode;
  const requested = a.requested !== undefined ? money(a.requested).display : '';
  const received = a.received !== undefined ? money(a.received).display : '';
  switch (a.reason) {
    case 'overpaid':
      return { title: `Nạp cọc PayOS: ${shopName} trả thừa`, content: `Mã PayOS ${code}: yêu cầu ${requested}, đã nhận ${received}. Đã ghi có vào ví, không hoàn.` };
    case 'duplicate':
      return { title: `Nạp cọc PayOS: ${shopName} chuyển thêm lần nữa`, content: `Mã PayOS ${code}: yêu cầu ${requested}, đã nhận ${received}. Đã ghi có vào ví, không hoàn.` };
    case 'late':
      return { title: `Nạp cọc PayOS: ${shopName} tiền về muộn sau khi link đã đóng`, content: `Mã PayOS ${code}: yêu cầu ${requested}, đã nhận ${received}. Đã ghi có vào ví, không hoàn.` };
    case 'partial_closed':
      return { title: `Nạp cọc PayOS: ${shopName} kết thúc thiếu`, content: `Mã PayOS ${code}: yêu cầu ${requested}, shop đã nạp ${received}. Ví giữ phần đã nhận.` };
    case 'invalid_amount':
      return { title: `Nạp cọc PayOS: webhook bất thường — mã ${code}`, content: 'Số tiền trong webhook không hợp lệ — chưa ghi có. Cần kiểm tra thủ công trên PayOS.' };
    case 'unkeyed':
      return { title: `Nạp cọc PayOS: webhook bất thường — mã ${code}`, content: 'Webhook thiếu mã giao dịch — chưa ghi có. Hệ thống sẽ dò lại PayOS.' };
  }
}

/*
 * PLAN-0041 — GHI CÓ VÍ từ khoản nạp cọc PayOS: đường duy nhất đưa tiền nạp vào sổ cái (mọi nguồn: webhook, job dò, làm mới khi khách quay lại, huỷ/đóng link).
 * Use case: settleWebhookIfTopup (webhook không phải đơn hàng) · reconcileOne/reconcilePending (dò với PayOS) · markLinkCreated/markLinkFailed (chốt sau khi tạo link) · cancel (huỷ link).
 * Khoá theo thứ tự toàn cục KHOẢN NẠP → VÍ (PLAN-0041 §6.1): không khoá ví rồi mới khoá khoản nạp; không đụng đơn hàng/payment.
 * Ghi có đi qua ShopWalletService (không gọi shopCodWallet* trực tiếp), idempotent theo ref_key UNIQUE. Không gọi PayOS trong transaction. Thông báo gửi SAU commit, best-effort.
 * Controller KHÔNG gọi class này trực tiếp: webhook (PaymentService) và job (worker) gọi settleWebhookIfTopup/reconcilePending; service vendor gọi markLinkCreated/markLinkFailed/cancel.
 * Mọi đường ghi có/đóng/huỷ đều khoá dòng khoản nạp TRƯỚC khi đụng ví; thông báo gửi sau commit và nuốt lỗi (không làm rollback tiền).
 */
@Injectable()
export class ShopWalletTopupSettleService {
  private readonly logger = new Logger(ShopWalletTopupSettleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payos: PayosService,
    private readonly wallet: ShopWalletService,
    private readonly audit: PaymentAuditLogService,
    private readonly shops: ShopQueryApi,
    @Inject(NOTIFICATION_GATEWAY) private readonly notifier: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  /*
   * Webhook PayOS đã xác minh chữ ký mà mã KHÔNG thuộc đơn hàng (PaymentService.handlePayos): ghi biên nhận + ghi có theo D2. Trả null khi mã không phải khoản nạp
   * (để PaymentService coi là mã lạ). Mã sai định dạng không chạm DB. Không đọc cờ wallet.payos_deposit_enabled ở đây (D10): tiền đã đi thì phải vào sổ.
   */
  async settleWebhookIfTopup(payosOrderCode: string, data: Record<string, unknown>, paidOk: boolean): Promise<TopupWebhookResult | null> {
    if (!/^\d{1,16}$/.test(payosOrderCode)) return null;
    const topup = await this.prisma.shopCodTopup.findUnique({ where: { payosOrderCode } });
    if (!topup) return null;
    if (!paidOk) return { outcome: 'ignored', message: 'Ignored: not a success event' };
    const amount = parseMoney(data.amount);
    if (amount === null) {
      this.logger.error({ payosOrderCode }, 'Webhook nạp cọc PayOS có số tiền không hợp lệ — chưa ghi có, cần kiểm tra thủ công');
      await this.alertAccountants({ topupId: topup.id, payosOrderCode, shopId: topup.shopId, reason: 'invalid_amount' });
      return { outcome: 'ignored', message: 'Ignored: invalid amount' };
    }
    const reference = receiptRef(payosOrderCode, data);
    if (reference === null) {
      // Không phân biệt được "gửi lại" với "chuyển thêm" ⇒ không ghi có; job/endpoint dò PayOS sẽ ghi có theo luỹ kế (D13).
      this.logger.warn({ payosOrderCode }, 'Webhook nạp cọc PayOS thiếu mã giao dịch và giờ giao dịch — chưa ghi có, hệ thống sẽ dò lại PayOS');
      await this.alertAccountants({ topupId: topup.id, payosOrderCode, shopId: topup.shopId, reason: 'unkeyed' });
      return { outcome: 'unkeyed', message: 'Ignored: no transaction reference — will reconcile with PayOS' };
    }
    const applied = await retryOnDeadlock(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockTopup(tx, topup.id);
        const t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topup.id } });
        return this.applyInTx(tx, t, { source: 'webhook', reference, amount, raw: data });
      }),
    );
    if (applied === null) return { outcome: 'replay', message: 'Success' };
    await this.afterCredit(applied);
    return { outcome: applied.credited > 0n ? 'credited' : 'noop', message: 'Success' };
  }

  /*
   * Hỏi PayOS (getPaymentLink) cho MỘT khoản NGOÀI transaction, rồi ghi nhận luỹ kế và đóng nếu đến hạn. Dùng cho job, GET làm mới và lúc tạo link mới.
   * `minIntervalMs`: chiếm lượt bằng CAS trên last_checked_at (nhiều tab/worker không hỏi trùng). `forceClose`: đóng khoản quá hạn/mồ côi dù PayOS không trả lời.
   */
  async reconcileOne(topupId: string, opts: { minIntervalMs?: number; forceClose?: boolean } = {}): Promise<TopupReconcileOutcome> {
    if (!this.payos.isConfigured) return 'unknown';
    const row = await this.prisma.shopCodTopup.findUnique({ where: { id: topupId } });
    if (!row) return 'not_found';
    const nowMs = Date.now();
    if (opts.minIntervalMs !== undefined) {
      const claimed = await this.prisma.shopCodTopup.updateMany({
        where: { id: topupId, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(nowMs - opts.minIntervalMs) } }] },
        data: { lastCheckedAt: new Date(nowMs) },
      });
      if (claimed.count === 0) return 'skipped';
    }
    const info = await this.payos.getPaymentLink(row.payosOrderCode);
    const cumulative = parseMoney(info.amountPaid, true);
    const gatewayStatus = typeof info.status === 'string' && info.status !== '' ? info.status : null;
    const known = gatewayStatus !== null || cumulative !== null;
    const res = await retryOnDeadlock(() =>
      this.prisma.$transaction(async (tx): Promise<ReconcileResult> => {
        await this.lockTopup(tx, topupId);
        let t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topupId } });
        let applied: Applied | null = null;
        if (cumulative !== null) {
          applied = await this.applyInTx(tx, t, { source: 'poll', cumulative, gatewayStatus });
          t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topupId } });
        }
        const close = closeDecisionOf(t, { status: gatewayStatus, known }, nowMs, opts.forceClose === true);
        if (close === null) return { applied, closed: null };
        await tx.shopCodTopup.update({
          where: { id: topupId },
          data: { status: close.status, closedAt: new Date(nowMs), version: { increment: 1 }, ...(close.linkError !== null ? { linkError: close.linkError } : {}) },
        });
        const received = dv(t.receivedAmount);
        const amount = dv(t.amount);
        await this.audit.write(tx, null, {
          action: closeAuditAction(close.status),
          entityType: 'shop_cod_topup',
          entityId: topupId,
          entityCode: t.payosOrderCode,
          after: { shopId: t.shopId, status: close.status, received: received.toString(), amount: amount.toString() },
        });
        // Đóng khi đã nhận một phần ⇒ kế toán biết MỘT lần (WTS-17); tiền về sau vẫn được ghi có (D3).
        const partialClosed = (close.status === TOPUP_STATUS.EXPIRED || close.status === TOPUP_STATUS.CANCELLED) && received > 0n && received < amount;
        return { applied, closed: { partialClosed, topupId, shopId: t.shopId, payosOrderCode: t.payosOrderCode, amount, received } };
      }),
    );
    if (res.applied !== null) await this.afterCredit(res.applied);
    if (res.closed !== null && res.closed.partialClosed) {
      await this.alertAccountants({ topupId, payosOrderCode: res.closed.payosOrderCode, shopId: res.closed.shopId, reason: 'partial_closed', requested: res.closed.amount, received: res.closed.received });
    }
    if (res.applied !== null && res.applied.credited > 0n) return 'credited';
    if (res.closed !== null) return 'closed';
    return known ? 'unchanged' : 'unknown';
  }

  /*
   * Job dò định kỳ (mỗi 2 phút): các khoản còn mở (hỏi lại sau 60 giây) + đuôi 72 giờ của khoản đã hết hạn/huỷ (hỏi lại sau 6 giờ) — bắt tiền về
   * khi MẤT webhook. Một dòng lỗi không dừng cả lô. `checked` = số khoản đã thật sự hỏi PayOS (không tính lượt bị CAS bỏ qua).
   */
  async reconcilePending(limit = 30): Promise<{ checked: number; credited: number; closed: number }> {
    const out = { checked: 0, credited: 0, closed: 0 };
    if (!this.payos.isConfigured) return out;
    const nowMs = Date.now();
    const open = await this.prisma.shopCodTopup.findMany({
      where: { status: { in: [...TOPUP_OPEN_STATUSES] }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(nowMs - TOPUP_TIMING.OPEN_RECHECK_MS) } }] },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const tail = await this.prisma.shopCodTopup.findMany({
      where: {
        status: { in: [TOPUP_STATUS.EXPIRED, TOPUP_STATUS.CANCELLED] },
        closedAt: { gte: new Date(nowMs - TOPUP_TIMING.TAIL_MS) },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(nowMs - TOPUP_TIMING.TAIL_RECHECK_MS) } }],
      },
      orderBy: { closedAt: 'desc' },
      take: 10,
      select: { id: true },
    });
    const batches = [
      { rows: open, minIntervalMs: TOPUP_TIMING.OPEN_RECHECK_MS },
      { rows: tail, minIntervalMs: TOPUP_TIMING.TAIL_RECHECK_MS },
    ];
    for (const batch of batches) {
      for (const row of batch.rows) {
        try {
          const outcome = await this.reconcileOne(row.id, { minIntervalMs: batch.minIntervalMs });
          if (outcome === 'skipped' || outcome === 'not_found') continue;
          out.checked += 1;
          if (outcome === 'credited') out.credited += 1;
          if (outcome === 'closed') out.closed += 1;
        } catch (err) {
          this.logger.warn({ err, topupId: row.id }, 'Dò PayOS cho khoản nạp lỗi — bỏ qua, lần sau dò lại');
        }
      }
    }
    return out;
  }

  /*
   * Sau khi PayOS đã tạo link thành công: chốt `creating` → `pending` kèm link. KHÔNG ghi đè trạng thái đã sang partial/paid (tiền về trước khi chốt — D5);
   * URL vẫn được lưu để khách mở được link. Khoá khoản nạp; không chạm ví.
   */
  async markLinkCreated(topupId: string, link: { checkoutUrl: string; qrCode: string | null; paymentLinkId: string | null }, actor: Pick<AuthenticatedActor, 'userId' | 'email'>): Promise<TopupRow> {
    return retryOnDeadlock(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockTopup(tx, topupId);
        const t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topupId } });
        const row = await tx.shopCodTopup.update({
          where: { id: topupId },
          data: {
            checkoutUrl: link.checkoutUrl,
            qrCode: link.qrCode,
            paymentLinkId: link.paymentLinkId,
            linkError: null,
            ...(t.status === TOPUP_STATUS.CREATING ? { status: TOPUP_STATUS.PENDING } : {}),
            version: { increment: 1 },
          },
        });
        // Audit KHÔNG chứa checkoutUrl/qrCode (đường dẫn thanh toán không vào log).
        await this.audit.write(tx, actor, { action: WALLET_AUDIT.TOPUP_CREATED, entityType: 'shop_cod_topup', entityId: topupId, entityCode: t.payosOrderCode, after: { shopId: t.shopId, amount: t.amount.toFixed(0), status: row.status } });
        return row;
      }),
    );
  }

  /*
   * PayOS lỗi/timeout khi tạo link: `creating` → `failed` để không còn khoản mở giả. Nếu tiền đã về (đã sang khác `creating`) thì không làm gì.
   */
  async markLinkFailed(topupId: string, message: string): Promise<void> {
    await retryOnDeadlock(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockTopup(tx, topupId);
        const t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topupId } });
        if (t.status !== TOPUP_STATUS.CREATING) return;
        await tx.shopCodTopup.update({
          where: { id: topupId },
          data: { status: TOPUP_STATUS.FAILED, linkError: message.slice(0, 250), closedAt: new Date(), version: { increment: 1 } },
        });
        await this.audit.write(tx, null, { action: WALLET_AUDIT.TOPUP_LINK_FAILED, entityType: 'shop_cod_topup', entityId: topupId, entityCode: t.payosOrderCode, after: { shopId: t.shopId, status: TOPUP_STATUS.FAILED } });
      }),
    );
  }

  /*
   * Chủ shop huỷ link đang `pending|partial` → `cancelled`. Khoản không thuộc shop ⇒ 404 (không lộ tồn tại); trạng thái khác ⇒ 409.
   * Tiền chuyển muộn vào link đã huỷ VẪN được ghi có (D3). Huỷ link ở PayOS do ShopWalletTopupService làm SAU commit.
   */
  async cancel(actor: AuthenticatedActor, shopId: string, topupId: string): Promise<TopupRow> {
    const owned = await this.prisma.shopCodTopup.findUnique({ where: { id: topupId }, select: { shopId: true } });
    if (!owned || owned.shopId !== shopId) throw new NotFoundException(WALLET_ERR.TOPUP_NOT_FOUND, 'Không tìm thấy khoản nạp');
    const row = await retryOnDeadlock(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockTopup(tx, topupId);
        const t = await tx.shopCodTopup.findUniqueOrThrow({ where: { id: topupId } });
        if (t.status !== TOPUP_STATUS.PENDING && t.status !== TOPUP_STATUS.PARTIAL) {
          throw new BusinessException(WALLET_ERR.TOPUP_INVALID_STATE, 'Chỉ huỷ được link đang chờ thanh toán hoặc đã nhận một phần', HttpStatus.CONFLICT);
        }
        const updated = await tx.shopCodTopup.update({
          where: { id: topupId },
          data: { status: TOPUP_STATUS.CANCELLED, closedAt: new Date(), cancelledBy: actor.userId, version: { increment: 1 } },
        });
        await this.audit.write(tx, actor, { action: WALLET_AUDIT.TOPUP_CANCELLED, entityType: 'shop_cod_topup', entityId: topupId, entityCode: t.payosOrderCode, before: { status: t.status }, after: { shopId, status: TOPUP_STATUS.CANCELLED } });
        return updated;
      }),
    );
    const received = dv(row.receivedAmount);
    const amount = dv(row.amount);
    if (received > 0n && received < amount) {
      await this.alertAccountants({ topupId, payosOrderCode: row.payosOrderCode, shopId, reason: 'partial_closed', requested: amount, received });
    }
    return row;
  }

  // ------------------------------------------------------------------ nội bộ

  /* KHOẢN NẠP → VÍ (PLAN-0041 §6.1): mọi đường ghi có/đóng/huỷ khoá dòng khoản nạp TRƯỚC khi đụng ví. Không khoá đơn hàng/payment. */
  private async lockTopup(tx: Tx, topupId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "payment"."shop_cod_topups" WHERE id = ${topupId}::uuid FOR UPDATE`;
  }

  /*
   * Lõi ghi nhận (PHẢI gọi trong transaction đã khoá dòng khoản nạp; `t` đọc LẠI dưới khoá). Trả null khi là replay (biên nhận đã có ⇒ không làm gì thêm).
   * Thứ tự: biên nhận (webhook) → tính mục tiêu luỹ kế → ghi có phần chênh dương qua ví → CẬP NHẬT dòng khoản nạp (câu ghi cuối) → audit.
   */
  private async applyInTx(tx: Tx, t: TopupRow, ev: TopupEvent): Promise<Applied | null> {
    const received = dv(t.receivedAmount);
    const amount = dv(t.amount);
    const status = statusOf(t.status);
    if (ev.source === 'webhook') {
      const dup = await tx.shopCodTopupReceipt.findFirst({ where: { topupId: t.id, reference: ev.reference }, select: { id: true } });
      if (dup) return null;
      await tx.shopCodTopupReceipt.create({ data: { topupId: t.id, reference: ev.reference, amount: ev.amount.toString(), raw: compactRaw(ev.raw) } });
    }
    const agg = await tx.shopCodTopupReceipt.aggregate({ where: { topupId: t.id }, _sum: { amount: true } });
    const sumReceipts = agg._sum.amount ? dv(agg._sum.amount) : 0n;
    const storedPolled = dv(t.polledAmount);
    const polled = ev.source === 'poll' && ev.cumulative > storedPolled ? ev.cumulative : storedPolled;
    const target = targetCumulative(sumReceipts, polled, received);
    const delta = target - received;
    let balanceAfter: bigint | null = null;
    if (delta > 0n) {
      // Khoá ghi sổ theo luỹ kế: mỗi bước tăng có một refKey riêng ⇒ cùng một bước không bao giờ ghi có hai lần (UNIQUE ở DB).
      const r = await this.wallet.creditPayosTopup(tx, {
        shopId: t.shopId,
        topupId: t.id,
        refKey: `${TOPUP_REF_PREFIX}${t.id}:${target.toString()}`,
        amount: delta,
        note: `Nạp cọc qua PayOS (mã ${t.payosOrderCode})`,
        meta: {
          topupId: t.id,
          payosOrderCode: t.payosOrderCode,
          source: ev.source,
          reference: ev.source === 'webhook' ? ev.reference : null,
          cumulative: target.toString(),
          delta: delta.toString(),
        },
      });
      // Mục tiêu tăng ngặt nên khoá đã có ⇒ received đã ≥ mục tiêu; tới đây mà credited=false là dữ liệu lệch ⇒ dừng, không ghi lệch.
      if (!r.credited) throw new Error(`Khoản nạp ${t.id}: khoá ghi sổ đã có nhưng số đã ghi có thấp hơn mục tiêu — dừng để không ghi lệch`);
      balanceAfter = r.balanceAfter;
    }
    const next = nextStatusAfterMoney(status, target, amount);
    const gw = ev.source === 'poll' && ev.gatewayStatus !== null ? ev.gatewayStatus.slice(0, 30) : null;
    const changed = target !== received || polled !== storedPolled || next !== status || (gw !== null && gw !== t.lastGatewayStatus);
    if (changed) {
      await tx.shopCodTopup.update({
        where: { id: t.id },
        data: {
          receivedAmount: target.toString(),
          polledAmount: polled.toString(),
          status: next,
          ...(next === TOPUP_STATUS.PAID && t.paidAt === null ? { paidAt: new Date() } : {}),
          ...(gw !== null ? { lastGatewayStatus: gw } : {}),
          version: { increment: 1 },
        },
      });
    }
    if (delta > 0n) {
      await this.audit.write(tx, null, {
        action: WALLET_AUDIT.TOPUP_CREDITED,
        entityType: 'shop_cod_topup',
        entityId: t.id,
        entityCode: t.payosOrderCode,
        after: {
          shopId: t.shopId,
          delta: delta.toString(),
          received: target.toString(),
          amount: amount.toString(),
          balanceAfter: balanceAfter?.toString() ?? null,
          source: ev.source,
          reference: ev.source === 'webhook' ? ev.reference : null,
          statusFrom: status,
          statusTo: next,
        },
      });
    }
    return { topupId: t.id, shopId: t.shopId, payosOrderCode: t.payosOrderCode, amount, before: { status, received }, after: { status: next, received: target }, credited: delta, balanceAfter };
  }

  /* Sau commit: chủ shop được báo mỗi lần ghi có; kế toán chỉ được báo khi BẤT THƯỜNG (trùng / thừa / muộn). Best-effort. */
  private async afterCredit(a: Applied): Promise<void> {
    if (a.credited <= 0n) return;
    if (a.balanceAfter !== null) await this.notifyShopCredited(a.shopId, a.topupId, a.credited, a.balanceAfter);
    const reason = creditAlertReason(a);
    if (reason !== null) await this.alertAccountants({ topupId: a.topupId, payosOrderCode: a.payosOrderCode, shopId: a.shopId, reason, requested: a.amount, received: a.after.received });
  }

  /* Thông báo chủ shop (thành viên có shop.wallet.read). Lỗi thông báo bị nuốt + log: không ảnh hưởng tiền đã ghi. */
  private async notifyShopCredited(shopId: string, topupId: string, delta: bigint, balanceAfter: bigint): Promise<void> {
    try {
      const userIds = await this.shops.memberUserIdsWithPermission(shopId, SHOP_WALLET_READ);
      if (userIds.length === 0) return;
      const credited = money(delta).display;
      await this.notifier.notifyMany(
        userIds.map((userId) => ({
          userId,
          type: 'payment',
          title: `Nạp cọc qua PayOS thành công: +${credited}`,
          content: `Ví đặt cọc COD đã được cộng ${credited}. Số dư hiện tại ${money(balanceAfter).display}.`,
          link: '/vendor/wallet',
          payload: { topupId },
        })),
      );
    } catch (err) {
      this.logger.warn({ err, topupId }, 'Không gửi được thông báo nạp cọc PayOS cho chủ shop — bỏ qua');
    }
  }

  /* Thông báo kế toán (người có supplier.wallet.approve). Lỗi tra cứu ⇒ nuốt + log, coi như không có người nhận. */
  private async alertAccountants(a: { topupId: string; payosOrderCode: string; shopId: string | null; reason: AlertReason; requested?: bigint; received?: bigint }): Promise<void> {
    try {
      const userIds = await this.users.staffUserIdsWithPermission(SUPPLIER_WALLET_APPROVE);
      if (userIds.length === 0) return;
      const brief = a.shopId !== null ? await this.shops.findBrief(a.shopId).catch(() => null) : null;
      const { title, content } = alertText(a, brief?.name ?? 'Gian hàng');
      await this.notifier.notifyMany(userIds.map((userId) => ({ userId, type: 'payment', title, content, link: '/shop/wallets', payload: { topupId: a.topupId, reason: a.reason } })));
    } catch (err) {
      this.logger.warn({ err, topupId: a.topupId, reason: a.reason }, 'Không gửi được thông báo nạp cọc PayOS cho kế toán — bỏ qua');
    }
  }
}
