import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval } from '@nestjs/schedule';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { CATALOG_EVENT, CATALOG_MODULE } from '../catalog/enums/catalog-events';
import { CatalogModule } from '../catalog/catalog.module';
import { SHOP_EVENT, SHOP_MODULE } from '../shop/enums/shop-events';
import { PRODUCT_MODULE } from './foundation/product.constants';
import { ProductModule } from './product.module';
import { ProductQueryService } from './product/service/product-query.service';
import { ProductService } from './product/service/product.service';

/* Relay outbox của catalog VÀ product (hai schema, hai instance) — phát `outbox.<module>.<EVENT>`. */
@Injectable()
export class CatalogProductOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(CatalogProductOutboxRelayJob.name);
  private relays: OutboxRelay[] = [];
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relays = [CATALOG_MODULE, PRODUCT_MODULE].map((m) => new OutboxRelay(this.prisma, m, async (msg) => { await this.emitter.emitAsync(`outbox.${m}.${msg.eventType}`, msg); }));
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const r of this.relays) await r.poll();
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox catalog/product lỗi');
    } finally {
      this.running = false;
    }
  }
}

/* Listener: catalog đổi slug ngành hàng → cập nhật snapshot category_slug trên sản phẩm (idempotent: cập nhật tuyệt đối). */
@Injectable()
export class ProductEventListeners {
  private readonly logger = new Logger(ProductEventListeners.name);

  constructor(private readonly products: ProductService) {}

  @OnEvent(`outbox.${CATALOG_MODULE}.${CATALOG_EVENT.CATEGORY_CHANGED}`)
  async onCategoryChanged(msg: OutboxEventMessage): Promise<void> {
    const { categoryId, slug } = msg.payload as { categoryId: string; slug: string };
    const n = await this.products.syncCategorySlug(categoryId, slug);
    this.logger.log({ categoryId, slug, updated: n }, 'Đồng bộ slug ngành hàng sang sản phẩm');
  }
}

/*
 * Listener: sàn duyệt / khoá / từ chối gian hàng (outbox SHOP_APPROVED | SHOP_SUSPENDED | SHOP_REJECTED) → xoá NGAY cache công khai của sản phẩm
 * (list 60s · chi tiết 120s · liên quan 300s · bộ lọc 600s). Không xoá thì hàng của shop vừa bị khoá còn hiện tới hết TTL, và ngược lại sản phẩm
 * của shop vừa được duyệt lại vẫn bị 404 vì chi tiết cache cả kết quả "không có". Độ trễ = chu kỳ relay outbox (3s) thay vì TTL.
 * Idempotent theo bản chất (chỉ xoá key, chạy bao nhiêu lần cũng cùng kết quả) nên không cần processed_events. Lỗi KHÔNG được nuốt:
 * `suppressErrors: false` để relay đánh FAILED + retry có backoff. Không phụ thuộc ngược shop — chỉ dùng tên sự kiện công khai ở shop/enums.
 */
@Injectable()
export class ProductShopStatusListeners {
  private readonly logger = new Logger(ProductShopStatusListeners.name);

  constructor(private readonly query: ProductQueryService) {}

  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.APPROVED}`, { suppressErrors: false })
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.SUSPENDED}`, { suppressErrors: false })
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.REJECTED}`, { suppressErrors: false })
  async onShopStatusChanged(msg: OutboxEventMessage): Promise<void> {
    await this.query.invalidateAll();
    this.logger.log({ shopId: (msg.payload as { shopId?: string }).shopId, eventType: msg.eventType }, 'Đã xoá cache công khai sản phẩm do gian hàng đổi trạng thái');
  }
}

/* Dọn idempotency key hết hạn (bảng product.idempotency_keys) — 03:30 mỗi ngày. */
@Injectable()
export class ProductHousekeepingJob {
  private readonly logger = new Logger(ProductHousekeepingJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 30 3 * * *')
  async purge(): Promise<void> {
    const r = await this.prisma.productIdempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    this.logger.log({ deleted: r.count }, 'Đã dọn idempotency key hết hạn (product)');
  }
}

@Module({
  imports: [CatalogModule, ProductModule],
  providers: [CatalogProductOutboxRelayJob, ProductEventListeners, ProductShopStatusListeners, ProductHousekeepingJob],
})
export class ProductWorkerModule {}
