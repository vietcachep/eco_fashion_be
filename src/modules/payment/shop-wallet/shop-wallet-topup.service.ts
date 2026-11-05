import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException, ConflictException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import { isPrismaError } from '@common/prisma/errors';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { TOPUP_OPEN_STATUSES, TOPUP_STATUS, TOPUP_TIMING, WALLET_ERR } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { ShopWalletTopupSettleService } from './shop-wallet-topup-settle.service';
import type { TopupReceiptRow, TopupRow, TopupShopContext, TopupSummary } from './shop-wallet-topup.types';

/* Số lần thử khi ghi dòng `creating` gặp P2002 vì trùng mã PayOS (rất hiếm: dải mã ~1e15 × 1000) — quá số lần ⇒ TOPUP_LINK_FAILED. */
const MAX_CODE_ATTEMPTS = 5;

/* Khoản mở đã "cũ": `creating` quá 60 giây (request tạo link đã chết giữa chừng), hoặc pending/partial đã quá hạn expiresAt. */
const isStaleOpen = (t: TopupRow, now: number): boolean =>
  t.status === TOPUP_STATUS.CREATING ? now - t.createdAt.getTime() > TOPUP_TIMING.STALE_CREATING_MS : t.expiresAt.getTime() <= now;

/* Mô tả đối soát trên link PayOS: chỉ chữ/số ASCII, tối đa 25 ký tự (giới hạn description của PayOS). Hàm thuần — export để test. */
export function topupDescription(shopCode: string): string {
  return `NAPCOC ${shopCode}`.toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 25);
}

/*
 * PLAN-0041 — nạp cọc COD qua PayOS, PHẦN ĐỌC/TẠO/HUỶ LINK cho chủ shop (vendor) và sàn (xem-only).
 * Use case: summaryFor (GET /shop/wallet · payosTopup) · create (POST /shop/wallet/topups — tạo link, MỘT khoản mở/shop) · listMine/getMine/getMineByOrderCode (trang quay lại)
 * · cancelMine (huỷ link) · listAll/getForAdmin/shopNames (sàn xem-only, GET /admin/wallet-topups*).
 * Transaction: create ghi dòng `creating` TRƯỚC, gọi PayOS NGOÀI transaction, rồi markLinkCreated/markLinkFailed (PLAN-0041 D5). Đường tạo KHÔNG khoá ví (D7).
 * Mọi truy vấn vendor lọc theo `shopId` lấy từ phiên (ShopContextGuard); khoản của shop khác ⇒ 404 (không lộ tồn tại). `checkoutUrl`/`qrCode` chỉ trả cho vendor và khi còn mở.
 * Không log số tài khoản/khoá PayOS. Tiền luôn là chuỗi số nguyên VND ở biên API (mapper), không float.
 * Controller duy nhất ShopWalletTopupController (vendor + sàn) gọi các method này; DTO ra API dựng ở controller/topup.mapper.ts (không trả model Prisma thô).
 */
@Injectable()
export class ShopWalletTopupService {
  private readonly logger = new Logger(ShopWalletTopupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payos: PayosService,
    private readonly settle: ShopWalletTopupSettleService,
    private readonly system: SystemQueryApi,
    private readonly shops: ShopQueryApi,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /*
   * Cờ bật + mức tiền + khoản đang chờ thanh toán còn hạn (pending|partial) cho GET /shop/wallet (PLAN-0041 §5.3).
   * `enabled` = cờ wallet.payos_deposit_enabled VÀ PayOS đã cấu hình VÀ EF_ADMIN_URL dùng được — tức là shop thật sự tạo được link lúc này.
   */
  async summaryFor(shopId: string): Promise<TopupSummary> {
    const [flag, minAmount, maxAmount, active] = await Promise.all([
      this.system.settingBool(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED),
      this.system.settingNumber(SETTING_KEY.WALLET_MIN_DEPOSIT),
      this.system.settingNumber(SETTING_KEY.WALLET_MAX_TOPUP_AMOUNT),
      this.prisma.shopCodTopup.findFirst({
        where: { shopId, status: { in: [TOPUP_STATUS.PENDING, TOPUP_STATUS.PARTIAL] }, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { enabled: flag && this.payos.isConfigured && this.adminUrlUsable(), minAmount, maxAmount, active };
  }

  /*
   * Tạo link nạp (PLAN-0041 §6.4 A). Thứ tự: kiểm cờ/cấu hình/mức tiền ⇒ dùng lại khoản mở còn hạn nếu có ⇒ ghi dòng `creating` (MỘT câu INSERT, autocommit)
   * ⇒ gọi PayOS NGOÀI transaction ⇒ chốt `pending` kèm link. KHÔNG khoá ví (D7): đường này không đụng số dư; chỉ mục UNIQUE "một khoản mở/shop" là chốt chống trùng.
   * Không bắt P2002 trong transaction — ở đây không có transaction nên bắt lỗi trùng rồi đọc lại là an toàn.
   */
  async create(actor: AuthenticatedActor, shop: TopupShopContext, amount: bigint): Promise<{ topup: TopupRow; reused: boolean }> {
    if (!(await this.system.settingBool(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED))) {
      throw new ConflictException(WALLET_ERR.TOPUP_DISABLED, 'Nạp qua PayOS đang tạm tắt — dùng chuyển khoản');
    }
    if (!this.payos.isConfigured || !this.adminUrlUsable()) {
      throw new ServiceUnavailableException(WALLET_ERR.TOPUP_UNAVAILABLE, 'Nạp qua PayOS chưa sẵn sàng — dùng chuyển khoản');
    }
    const [min, max, ttlMinutes] = await Promise.all([
      this.system.settingNumber(SETTING_KEY.WALLET_MIN_DEPOSIT),
      this.system.settingNumber(SETTING_KEY.WALLET_MAX_TOPUP_AMOUNT),
      this.system.settingNumber(SETTING_KEY.WALLET_PAYOS_TOPUP_EXPIRE_MINUTES),
    ]);
    if (amount < BigInt(min)) throw new BusinessException(WALLET_ERR.DEPOSIT_TOO_SMALL, `Số tiền nạp tối thiểu ${min.toLocaleString('vi-VN')}đ`);
    if (amount > BigInt(max)) throw new BusinessException(WALLET_ERR.TOPUP_TOO_LARGE, `Số tiền nạp tối đa ${max.toLocaleString('vi-VN')}đ mỗi lần`);

    const existing = await this.reuseOpenIfAny(shop.shopId);
    if (existing) return existing;

    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    let row: TopupRow | null = null;
    for (let attempt = 0; row === null && attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      try {
        row = await this.prisma.shopCodTopup.create({
          data: { shopId: shop.shopId, amount: amount.toString(), payosOrderCode: String(PayosService.generateTopupOrderCode()), status: TOPUP_STATUS.CREATING, expiresAt, requestedBy: actor.userId },
        });
      } catch (err) {
        if (!isPrismaError(err, 'P2002')) throw err;
        // P2002: request khác vừa mở khoản cho shop (chốt một-khoản-mở) ⇒ trả khoản đó; nếu không có thì trùng mã PayOS ⇒ sinh lại mã ở vòng sau.
        const winner = await this.reuseOpenIfAny(shop.shopId);
        if (winner) return winner;
      }
    }
    if (row === null) throw new ServiceUnavailableException(WALLET_ERR.TOPUP_LINK_FAILED, 'Không tạo được link nạp cọc — thử lại sau');
    return this.attachPayosLink(row, shop, amount, actor);
  }

  /*
   * Gọi PayOS tạo link (PLAN-0041 §6.4 A bước 3) NGOÀI transaction. Lỗi hoặc không có checkoutUrl ⇒ dòng thành `failed` rồi 503 — không để link mồ côi
   * thành "đang chờ". Thành công ⇒ markLinkCreated chốt `pending` (không ghi đè nếu tiền đã về trước đó).
   */
  private async attachPayosLink(row: TopupRow, shop: TopupShopContext, amount: bigint, actor: AuthenticatedActor): Promise<{ topup: TopupRow; reused: boolean }> {
    const back = `${this.adminUrl()}/vendor/wallet/payos-return`;
    let link: { checkoutUrl: string | null; qrCode: string | null; paymentLinkId: string | null } = { checkoutUrl: null, qrCode: null, paymentLinkId: null };
    try {
      link = await this.payos.createPaymentLink({
        orderCode: Number(row.payosOrderCode),
        amount,
        description: topupDescription(shop.shopCode),
        returnUrl: back,
        cancelUrl: back,
        expiresAt: row.expiresAt,
      });
    } catch (err) {
      this.logger.warn({ topupId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Gọi PayOS tạo link nạp cọc lỗi');
    }
    if (!link.checkoutUrl) {
      await this.settle.markLinkFailed(row.id, 'PayOS không tạo được link');
      throw new ServiceUnavailableException(WALLET_ERR.TOPUP_LINK_FAILED, 'Không tạo được link nạp cọc qua PayOS — thử lại sau');
    }
    const topup = await this.settle.markLinkCreated(row.id, { checkoutUrl: link.checkoutUrl, qrCode: link.qrCode, paymentLinkId: link.paymentLinkId }, actor);
    return { topup, reused: false };
  }

  /*
   * Khoản mở của shop: còn hạn ⇒ trả lại (reused) hoặc chặn nếu đang `creating` (request khác đang gọi PayOS); quá hạn/mồ côi ⇒ đóng bằng
   * reconcileOne(forceClose) rồi coi như không còn khoản mở. Trả null khi không còn khoản mở hợp lệ — caller mới tạo khoản mới.
   */
  private async reuseOpenIfAny(shopId: string): Promise<{ topup: TopupRow; reused: boolean } | null> {
    const open = await this.findOpen(shopId);
    if (!open) return null;
    if (!isStaleOpen(open, Date.now())) return this.reuseOrBlock(open);
    await this.settle.reconcileOne(open.id, { forceClose: true });
    const again = await this.findOpen(shopId);
    if (!again || isStaleOpen(again, Date.now())) return null;
    return this.reuseOrBlock(again);
  }

  /* Khoản còn hạn: `creating` ⇒ 409 TOPUP_IN_PROGRESS (chưa có link để trả); pending/partial ⇒ trả lại link cũ (reused: true), kể cả số tiền khác. */
  private reuseOrBlock(open: TopupRow): { topup: TopupRow; reused: boolean } {
    if (open.status === TOPUP_STATUS.CREATING) {
      throw new ConflictException(WALLET_ERR.TOPUP_IN_PROGRESS, 'Đang tạo link nạp cọc — thử lại sau vài giây');
    }
    return { topup: open, reused: true };
  }

  /* Khoản mở (creating|pending|partial) mới nhất của shop — đúng tập chỉ mục "một khoản mở/shop". Không khoá. */
  private findOpen(shopId: string): Promise<TopupRow | null> {
    return this.prisma.shopCodTopup.findFirst({ where: { shopId, status: { in: [...TOPUP_OPEN_STATUSES] } }, orderBy: { createdAt: 'desc' } });
  }

  /* EF_ADMIN_URL bỏ dấu "/" cuối; trang quay lại của chủ shop nằm dưới URL này (PLAN-0041 D11). */
  private adminUrl(): string {
    return this.env.EF_ADMIN_URL.replace(/\/$/, '');
  }

  /*
   * Production: URL quay lại PHẢI là https — chủ shop trở về từ PayOS qua URL này, http ở production là cấu hình sai. Sai ⇒ tính năng nạp trả 503,
   * app vẫn khởi động được (PLAN-0041 D11).
   */
  private adminUrlUsable(): boolean {
    return this.env.NODE_ENV !== 'production' || this.env.EF_ADMIN_URL.startsWith('https://');
  }

  /* Danh sách khoản của CHÍNH shop (mới nhất trước); `filter.status` tuỳ chọn. shopId luôn lấy từ phiên — không có tham số nào để vượt. */
  listMine(shopId: string, filter: { status?: string }, skip: number, take: number): Promise<{ items: TopupRow[]; total: number }> {
    return this.listWhere({ shopId, ...(filter.status ? { status: filter.status } : {}) }, skip, take);
  }

  /* Danh sách toàn sàn (xem-only): lọc tuỳ chọn theo gian hàng và trạng thái; mới nhất trước. */
  listAll(filter: { shopId?: string; status?: string }, skip: number, take: number): Promise<{ items: TopupRow[]; total: number }> {
    return this.listWhere({ ...(filter.shopId ? { shopId: filter.shopId } : {}), ...(filter.status ? { status: filter.status } : {}) }, skip, take);
  }

  private async listWhere(where: Prisma.ShopCodTopupWhereInput, skip: number, take: number): Promise<{ items: TopupRow[]; total: number }> {
    const [items, total] = await Promise.all([
      this.prisma.shopCodTopup.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.shopCodTopup.count({ where }),
    ]);
    return { items, total };
  }

  /*
   * Chi tiết một khoản của CHÍNH shop. Lọc `shopId` ngay trong truy vấn: khoản của shop khác ⇒ 404 (không lộ tồn tại, không chạm PayOS).
   * Còn mở ⇒ làm mới từ PayOS trước khi trả (PLAN-0041 §6.4 H).
   */
  async getMine(shopId: string, id: string): Promise<TopupRow> {
    const row = await this.prisma.shopCodTopup.findFirst({ where: { id, shopId } });
    if (!row) throw new NotFoundException(WALLET_ERR.TOPUP_NOT_FOUND, 'Không tìm thấy khoản nạp');
    return this.refreshIfOpen(row, shopId);
  }

  /*
   * Tra theo mã PayOS (trang quay lại từ PayOS, PLAN-0041 D11). Mã sai định dạng ⇒ 404 ngay, không chạm DB; còn mở ⇒ làm mới từ PayOS.
   */
  async getMineByOrderCode(shopId: string, payosOrderCode: string): Promise<TopupRow> {
    if (!/^\d{1,16}$/.test(payosOrderCode)) throw new NotFoundException(WALLET_ERR.TOPUP_NOT_FOUND, 'Không tìm thấy khoản nạp');
    const row = await this.prisma.shopCodTopup.findFirst({ where: { payosOrderCode, shopId } });
    if (!row) throw new NotFoundException(WALLET_ERR.TOPUP_NOT_FOUND, 'Không tìm thấy khoản nạp');
    return this.refreshIfOpen(row, shopId);
  }

  /*
   * Huỷ khoản của chính shop: trạng thái chuyển `cancelled` trong settle.cancel (có khoá, dưới 409 nếu không cho huỷ). Sau commit mới gọi PayOS huỷ link —
   * best-effort, không trong transaction. Tiền chuyển muộn vào link đã huỷ vẫn được ghi có (PLAN-0041 D3).
   */
  async cancelMine(actor: AuthenticatedActor, shopId: string, id: string): Promise<TopupRow> {
    const row = await this.settle.cancel(actor, shopId, id);
    void this.payos
      .cancelPaymentLink(row.payosOrderCode)
      .then((ok) => {
        if (!ok) this.logger.warn({ topupId: row.id }, 'Huỷ link PayOS chưa xác nhận được — link có thể còn mở phía PayOS');
      })
      .catch((err: unknown) => this.logger.warn({ topupId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Huỷ link PayOS lỗi'));
    return row;
  }

  /* Còn mở ⇒ hỏi PayOS qua settle.reconcileOne (CAS 8 giây: nhiều tab không hỏi dồn) rồi đọc lại. Lỗi làm mới chỉ log — vẫn trả trạng thái đang có. */
  private async refreshIfOpen(row: TopupRow, shopId: string): Promise<TopupRow> {
    if (!TOPUP_OPEN_STATUSES.includes(row.status)) return row;
    try {
      await this.settle.reconcileOne(row.id, { minIntervalMs: TOPUP_TIMING.ONDEMAND_RECHECK_MS });
    } catch (err) {
      this.logger.warn({ topupId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Làm mới khoản nạp từ PayOS lỗi — trả trạng thái hiện có');
    }
    return (await this.prisma.shopCodTopup.findFirst({ where: { id: row.id, shopId } })) ?? row;
  }

  /*
   * Chi tiết cho sàn (xem-only) kèm biên nhận webhook để đối chiếu PayOS. KHÔNG gọi PayOS — sàn chỉ đọc sổ đã ghi. Không có ⇒ 404.
   */
  async getForAdmin(id: string): Promise<{ topup: TopupRow; receipts: TopupReceiptRow[] }> {
    const topup = await this.prisma.shopCodTopup.findUnique({ where: { id } });
    if (!topup) throw new NotFoundException(WALLET_ERR.TOPUP_NOT_FOUND, 'Không tìm thấy khoản nạp');
    const receipts = await this.prisma.shopCodTopupReceipt.findMany({ where: { topupId: id }, orderBy: { createdAt: 'asc' } });
    return { topup, receipts };
  }

  /* Tên gian hàng cho danh sách sàn — một truy vấn qua ShopQueryApi (không N+1). */
  async shopNames(shopIds: string[]): Promise<Map<string, string>> {
    const briefs = await this.shops.findManyBrief(shopIds);
    return new Map([...briefs].map(([id, b]) => [id, b.name]));
  }
}
