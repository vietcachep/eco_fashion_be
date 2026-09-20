import { Module } from '@nestjs/common';
import { INVENTORY_GATEWAY } from '@common/gateway/inventory.gateway';
import { PRODUCT_STATS_GATEWAY } from '@common/gateway/product-stats.gateway';
import { CatalogModule } from '../catalog/catalog.module';
import { ProductAuditLogService } from './audit/product-audit-log.service';
import { InventoryGatewayImpl } from './gateway/inventory.gateway.impl';
import { ProductStatsGatewayImpl } from './gateway/product-stats.gateway.impl';
import { AdminProductImageController } from './image/controller/admin-product-image.controller';
import { ProductImageService } from './image/service/product-image.service';
import { AdminInventoryController } from './inventory/controller/admin-inventory.controller';
import { InventoryRepository } from './inventory/repository/inventory.repository';
import { InventoryService } from './inventory/service/inventory.service';
import { ProductOutboxService } from './outbox/product-outbox.service';
import { AdminProductController } from './product/controller/admin-product.controller';
import { ProductController } from './product/controller/product.controller';
import { ProductRepository } from './product/repository/product.repository';
import { ProductQueryService } from './product/service/product-query.service';
import { ProductService } from './product/service/product.service';
import { ProductQueryApi } from './queryapi/product.queryapi';

/*
 * Module product (PLAN-0004): sản phẩm, biến thể, ảnh, tồn kho. Import CatalogModule để dùng CatalogQueryApi (kiểm ngành hàng,
 * màu/size) và CATEGORY_STATS_GATEWAY. Export cho module khác: ProductQueryApi, INVENTORY_GATEWAY, PRODUCT_STATS_GATEWAY.
 */
@Module({
  imports: [CatalogModule],
  controllers: [ProductController, AdminProductController, AdminProductImageController, AdminInventoryController],
  providers: [
    ProductRepository,
    InventoryRepository,
    ProductAuditLogService,
    ProductOutboxService,
    ProductQueryService,
    ProductService,
    ProductImageService,
    InventoryService,
    ProductQueryApi,
    { provide: INVENTORY_GATEWAY, useClass: InventoryGatewayImpl },
    { provide: PRODUCT_STATS_GATEWAY, useClass: ProductStatsGatewayImpl },
  ],
  // ProductService export CHỈ cho ProductWorkerModule (listener đồng bộ slug ngành hàng) — module khác không được dùng.
  exports: [ProductQueryApi, INVENTORY_GATEWAY, PRODUCT_STATS_GATEWAY, ProductService],
})
export class ProductModule {}
