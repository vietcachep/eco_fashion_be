import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@common/prisma/types';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { REVIEW_EVENT, REVIEW_MODULE } from '../review/enums/review-events';
import { ProductModule } from '../product/product.module';
import { ProductQueryApi } from '../product/queryapi/product.queryapi';
import { SHOP_MODULE } from './foundation/shop.constants';
import { ShopOutboxService } from './outbox/shop-outbox.service';
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

/* Phần worker của shop: relay outbox + listener đánh giá. Chỉ WorkerModule import. */
@Module({
  imports: [ProductModule, ShopModule],
  providers: [ShopOutboxService, ShopOutboxRelayJob, ShopEventListeners],
})
export class ShopWorkerModule {}
