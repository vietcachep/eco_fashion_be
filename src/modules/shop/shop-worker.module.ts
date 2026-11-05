import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { escapeHtml } from '@common/mail/escape-html';
import { MailService } from '@common/mail/mail.service';
import { Prisma } from '@common/prisma/types';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { REVIEW_EVENT, REVIEW_MODULE } from '../review/enums/review-events';
import { ProductModule } from '../product/product.module';
import { ProductQueryApi } from '../product/queryapi/product.queryapi';
import { SystemModule } from '../system/system.module';
import { SHOP_EVENT, SHOP_MODULE } from './foundation/shop.constants';
import { ShopOutboxService } from './outbox/shop-outbox.service';
import { ShopQueryApi } from './queryapi/shop.queryapi';
import { ShopRepository } from './shop/repository/shop.repository';
import { ShopModule } from './shop.module';

/*
 * Relay outbox shop: mỗi 3s claim event PENDING/FAILED tới hạn và phát qua EventEmitter
 * `outbox.shop.<EVENT_TYPE>` (listener cùng process worker). Chỉ WorkerModule nạp — API không chạy job nền.
 * Listener của sự kiện shop: SHOP_BANK_CHANGED do SystemWorkerModule nghe (báo thành viên shop qua NotificationGateway);
 * SHOP_APPROVED/SUSPENDED/REJECTED phát ra nhưng chưa ai nghe — product/order thêm `@OnEvent` khi cần phản ứng theo trạng thái gian hàng.
 */
@Injectable()
export class ShopOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(ShopOutboxRelayJob.name);
  private relay!: OutboxRelay;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relay = new OutboxRelay(this.prisma, SHOP_MODULE, async (msg) => {
      await this.emitter.emitAsync(`outbox.${SHOP_MODULE}.${msg.eventType}`, msg);
    });
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return; // không chồng lần chạy khi batch trước chưa xong
    this.running = true;
    try {
      const n = await this.relay.poll();
      if (n > 0) this.logger.debug({ n }, 'Đã relay outbox shop');
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox shop lỗi');
    } finally {
      this.running = false;
    }
  }
}

/*
 * Listener: review tạo / đổi điểm → tính lại Shop.ratingAvg từ tất cả review approved của mọi sản phẩm thuộc shop
 * (PLAN-0014 bước 5b).
 * Idempotent theo bản chất: mỗi lần TÍNH LẠI TỪ ĐẦU rồi ghi đè (không cộng dồn) nên chạy lại bao nhiêu lần cũng ra cùng kết quả
 * — không cần processed_events. Vì vậy lỗi KHÔNG được nuốt: `suppressErrors: false` để relay đánh FAILED + retry có backoff
 * (nuốt lỗi thì relay đánh DONE và điểm shop sai vĩnh viễn cho tới review kế tiếp).
 * LƯU Ý ranh giới: câu SQL thô bên dưới JOIN xuyên schema review/product (né prisma-boundaries) — chưa có
 * ReviewQueryApi/ProductQueryApi trả điểm trung bình theo shop; thay bằng queryapi khi hai module đó có hàm tương ứng.
 */
@Injectable()
export class ShopEventListeners {
  private readonly logger = new Logger(ShopEventListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
  ) {}

  @OnEvent(`outbox.${REVIEW_MODULE}.${REVIEW_EVENT.CREATED}`, { suppressErrors: false })
  async onReviewCreated(msg: OutboxEventMessage): Promise<void> {
    const { productId } = msg.payload as { productId: string };
    const shopId = await this.products.getShopId(productId);
    if (!shopId) return;

    await this.updateShopRating(shopId);
  }

  @OnEvent(`outbox.${REVIEW_MODULE}.${REVIEW_EVENT.RATING_CHANGED}`, { suppressErrors: false })
  async onReviewRatingChanged(msg: OutboxEventMessage): Promise<void> {
    const { productId } = msg.payload as { productId: string };
    const shopId = await this.products.getShopId(productId);
    if (!shopId) return;

    await this.updateShopRating(shopId);
  }

  private async updateShopRating(shopId: string): Promise<void> {
    const result = await this.prisma.$queryRaw<Array<{ avg_rating: number | null; count: bigint | number }>>`
      SELECT
        AVG(CAST(r.rating AS DECIMAL)) as avg_rating,
        COUNT(r.id) as count
      FROM "review"."reviews" r
      INNER JOIN "product"."products" p ON r.product_id = p.id
      WHERE p.shop_id = ${shopId}
        AND r.status = 'approved'
        AND r.is_deleted = false
    `;

    const row = result[0];
    const avgRating = row?.avg_rating ? parseFloat(row.avg_rating.toString()) : null;

    await this.prisma.shop.update({
      where: { id: shopId },
      data: { ratingAvg: avgRating ? new Prisma.Decimal(avgRating.toFixed(2)) : null },
    });

    // COUNT(...) của Postgres trả bigint — đổi sang number trước khi đưa vào log JSON.
    this.logger.log({ shopId, avgRating, reviewCount: Number(row?.count ?? 0) }, 'Đã cập nhật Shop.ratingAvg');
  }
}

/* Giờ Việt Nam cố định UTC+7 (không có giờ mùa hè) — thời điểm trong email hiển thị theo giờ VN, không theo TZ máy chủ. */
const VN_UTC_OFFSET_MS = 7 * 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
export function formatVnDateTime(iso: string | Date): string {
  const d = new Date(new Date(iso).getTime() + VN_UTC_OFFSET_MS);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

interface BankChangedPayload {
  shopId?: string;
  code?: string;
  name?: string;
  bankAccountName?: string | null;
  bankAccountLast4?: string | null;
  bankAccountNumberMasked?: string | null;
  changedByEmail?: string;
  ownerUserId?: string;
  changedAt?: string;
  bankPendingVerification?: boolean;
  holdHours?: number;
}

/*
 * Phản ứng với việc đổi / xác minh TÀI KHOẢN NGÂN HÀNG nhận tiền của shop (PLAN-0040 Tầng 5.1/5.2), ngoài thông báo trong app cho mọi thành viên (do SystemWorkerModule lo):
 *  - SHOP_BANK_CHANGED → EMAIL riêng cho CHỦ shop (chỉ 4 số cuối + người đổi + thời điểm + hướng dẫn "không phải bạn"). Kênh đáng tin hơn thông báo trong app: kẻ chiếm phiên đổi TK xong có thể
 *    không để chủ shop thấy chuông. Mọi giá trị chèn vào HTML đều qua `escapeHtml`. Tách khỏi listener thông báo trong app (class riêng, handler riêng) nên mail lỗi KHÔNG làm mất thông báo trong app và ngược lại.
 *  - SHOP_BANK_CHANGED mà TK chờ xác minh (tên chủ TK lệch tên chủ shop) → báo nhân viên sàn có quyền `supplier.shop.approve` để vào xác minh.
 *  - SHOP_BANK_VERIFIED → báo mọi thành viên shop: sàn đã xác minh, chi trả mở lại sau thời gian giữ.
 * Idempotent qua shop.processed_events (event_id + handler) GHI CÙNG transaction với việc xếp mail/ghi thông báo: xếp hàng đợi lỗi ⇒ rollback, lỗi nổi lên (`suppressErrors:false`) ⇒ relay retry
 * (không mất thư bảo mật); relay phát lại event đã xử lý ⇒ bỏ qua (không gửi trùng).
 */
@Injectable()
export class ShopBankListeners {
  private readonly logger = new Logger(ShopBankListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: ShopOutboxService,
    private readonly mail: MailService,
    private readonly identity: IdentityQueryApi,
    private readonly shops: ShopRepository,
    private readonly shopQuery: ShopQueryApi,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* Email cho chủ shop. Không tìm được chủ / chủ không có email ⇒ cảnh báo rồi bỏ qua (retry không chữa được) — thông báo trong app vẫn đi đường riêng. */
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.BANK_CHANGED}`, { suppressErrors: false })
  async onBankChangedMailOwner(msg: OutboxEventMessage): Promise<void> {
    const p = msg.payload as BankChangedPayload;
    if (!p.shopId) {
      this.logger.warn({ eventId: msg.id }, 'SHOP_BANK_CHANGED thiếu shopId — bỏ qua email chủ shop');
      return;
    }
    // Sự kiện phát trước khi payload có ownerUserId (còn trong hàng đợi lúc nâng cấp) ⇒ tra chủ shop từ bảng shop.
    const ownerUserId = p.ownerUserId ?? (await this.shops.findById(p.shopId))?.ownerUserId;
    const owner = ownerUserId ? await this.identity.findUserBrief(ownerUserId) : null;
    if (!owner?.email) {
      this.logger.warn({ eventId: msg.id, shopId: p.shopId }, 'SHOP_BANK_CHANGED: không tìm thấy email chủ shop — bỏ qua email');
      return;
    }
    const last4 = p.bankAccountLast4 ?? p.bankAccountNumberMasked?.slice(-4) ?? null;
    const when = formatVnDateTime(p.changedAt ?? msg.createdAt);
    const app = this.env.EF_APP_NAME;
    const policy = p.bankPendingVerification
      ? `<p>Tên chủ tài khoản <b>không khớp</b> tên chủ gian hàng nên tài khoản đang <b>chờ sàn xác minh</b>: chi trả của gian hàng được giữ cho tới khi quản lý sàn xác minh${p.holdHours ? `, sau đó tiếp tục giữ thêm ${escapeHtml(p.holdHours)} giờ` : ''}. Bạn có thể liên hệ sàn để được xác minh nhanh.</p>`
      : `<p>Để bảo vệ gian hàng, sàn tạm giữ chi trả${p.holdHours ? ` <b>${escapeHtml(p.holdHours)} giờ</b>` : ''} kể từ lúc đổi tài khoản.</p>`;
    const html =
      `<p>Xin chào <b>${escapeHtml(owner.fullName)}</b>,</p>` +
      `<p>Tài khoản ngân hàng nhận tiền chi trả của gian hàng <b>${escapeHtml(p.name ?? '')}</b>${p.code ? ` (${escapeHtml(p.code)})` : ''} vừa được thay đổi:</p>` +
      `<ul>${last4 ? `<li>Số tài khoản: ••••${escapeHtml(last4)}</li>` : ''}${p.bankAccountName ? `<li>Tên chủ tài khoản: ${escapeHtml(p.bankAccountName)}</li>` : ''}` +
      `<li>Người thực hiện: ${escapeHtml(p.changedByEmail ?? 'một thành viên của gian hàng')}</li><li>Thời điểm: ${escapeHtml(when)} (giờ Việt Nam)</li></ul>` +
      policy +
      `<p><b>Nếu KHÔNG phải bạn hoặc người trong gian hàng thực hiện:</b> hãy đổi mật khẩu ngay (chức năng Quên mật khẩu), gỡ thành viên lạ khỏi gian hàng và liên hệ sàn để khoá chi trả.</p>` +
      `<p>— ${escapeHtml(app)}</p>`;

    const sent = await this.prisma.$transaction(async (tx) => {
      if (!(await this.outbox.markProcessed(tx, msg.id, msg.eventType, 'bank-changed-owner-mail'))) return false;
      await this.mail.enqueue({ to: owner.email, subject: `${app} — Tài khoản ngân hàng nhận tiền của gian hàng đã thay đổi`, html });
      return true;
    });
    if (sent) this.logger.log({ shopId: p.shopId, eventId: msg.id }, 'Đã xếp hàng email đổi tài khoản ngân hàng cho chủ shop');
  }

  /* TK mới lệch tên chủ shop ⇒ báo nhân viên sàn có quyền duyệt gian hàng để vào xác minh (kỳ chi của shop đang bị giữ). */
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.BANK_CHANGED}`, { suppressErrors: false })
  async onBankChangedNotifyManagers(msg: OutboxEventMessage): Promise<void> {
    const p = msg.payload as BankChangedPayload;
    if (!p.shopId || p.bankPendingVerification !== true) return;
    const staffIds = await this.users.staffUserIdsWithPermission('supplier.shop.approve');
    if (staffIds.length === 0) return;
    const last4 = p.bankAccountLast4 ?? p.bankAccountNumberMasked?.slice(-4) ?? null;
    const sent = await this.prisma.$transaction(async (tx) => {
      if (!(await this.outbox.markProcessed(tx, msg.id, msg.eventType, 'bank-changed-notify-managers'))) return false;
      await this.notify.notifyMany(
        staffIds.map((userId) => ({
          userId,
          type: 'system',
          title: `Cần xác minh tài khoản ngân hàng — ${p.name ?? p.code ?? 'gian hàng'}`,
          content: `Gian hàng ${p.name ?? ''}${p.code ? ` (${p.code})` : ''} đổi tài khoản ngân hàng nhận tiền${last4 ? ` (••••${last4})` : ''} sang tên chủ tài khoản không khớp tên chủ gian hàng. Chi trả của shop bị giữ cho tới khi bạn xác minh.`.slice(0, 500),
          link: `/shop/shops/${p.shopId}`,
          payload: { shopId: p.shopId, eventId: msg.id },
        })),
        tx,
      );
      return true;
    });
    if (sent) this.logger.log({ shopId: p.shopId, recipients: staffIds.length }, 'Đã báo nhân viên sàn xác minh tài khoản ngân hàng');
  }

  /* Quản lý sàn đã xác minh TK ⇒ báo mọi thành viên active của shop. */
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.BANK_VERIFIED}`, { suppressErrors: false })
  async onBankVerified(msg: OutboxEventMessage): Promise<void> {
    const p = msg.payload as { shopId?: string; name?: string; bankAccountLast4?: string | null; holdHours?: number };
    if (!p.shopId) {
      this.logger.warn({ eventId: msg.id }, 'SHOP_BANK_VERIFIED thiếu shopId — bỏ qua thông báo');
      return;
    }
    const userIds = await this.shopQuery.activeMemberUserIds(p.shopId);
    if (userIds.length === 0) return;
    const sent = await this.prisma.$transaction(async (tx) => {
      if (!(await this.outbox.markProcessed(tx, msg.id, msg.eventType, 'bank-verified-notify-members'))) return false;
      await this.notify.notifyMany(
        userIds.map((userId) => ({
          userId,
          type: 'payment',
          title: 'Sàn đã xác minh tài khoản ngân hàng nhận tiền',
          content: `Tài khoản ngân hàng${p.bankAccountLast4 ? ` (••••${p.bankAccountLast4})` : ''} của gian hàng${p.name ? ` ${p.name}` : ''} đã được sàn xác minh.${p.holdHours ? ` Chi trả sẽ tiếp tục sau ${p.holdHours} giờ giữ kể từ lúc xác minh.` : ''}`,
          link: '/vendor/shop',
          payload: { shopId: p.shopId, eventId: msg.id },
        })),
        tx,
      );
      return true;
    });
    if (sent) this.logger.log({ shopId: p.shopId, recipients: userIds.length }, 'Đã báo thành viên shop: tài khoản ngân hàng được xác minh');
  }
}

/* Phần worker của shop: relay outbox + listener đánh giá + listener tài khoản ngân hàng. Chỉ WorkerModule import. SystemModule cho NOTIFICATION_GATEWAY (thông báo trong app). */
@Module({
  imports: [ProductModule, ShopModule, SystemModule],
  providers: [ShopOutboxService, ShopOutboxRelayJob, ShopEventListeners, ShopBankListeners],
})
export class ShopWorkerModule {}
