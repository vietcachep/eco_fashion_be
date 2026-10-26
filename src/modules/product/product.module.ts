import { Module } from '@nestjs/common';
import { INVENTORY_GATEWAY } from '@common/gateway/inventory.gateway';
import { PRODUCT_STATS_GATEWAY } from '@common/gateway/product-stats.gateway';
import { CatalogModule } from '../catalog/catalog.module';
import { ShopModule } from '../shop/shop.module';
import { ProductAuditLogService } from './audit/product-audit-log.service';
import { CatalogUsageProviderImpl } from './gateway/catalog-usage.provider';
import { InventoryGatewayImpl } from './gateway/inventory.gateway.impl';
import { ProductStatsGatewayImpl } from './gateway/product-stats.gateway.impl';
import { ProductImageService } from './image/service/product-image.service';
import { AdminInventoryController } from './inventory/controller/admin-inventory.controller';
import { ShopInventoryController } from './inventory/controller/shop-inventory.controller';
import { InventoryRepository } from './inventory/repository/inventory.repository';
import { InventoryService } from './inventory/service/inventory.service';
import { ShopInventoryService } from './inventory/service/shop-inventory.service';
import { ProductOutboxService } from './outbox/product-outbox.service';
import { AdminProductController } from './product/controller/admin-product.controller';
import { ProductController } from './product/controller/product.controller';
import { ShopProductController } from './product/controller/shop-product.controller';
import { ShopProductImageController } from './product/controller/shop-product-image.controller';
import { ProductRepository } from './product/repository/product.repository';
import { ProductQueryService } from './product/service/product-query.service';
import { ProductService } from './product/service/product.service';
import { ShopProductImageService } from './product/service/shop-product-image.service';
import { ProductQueryApi } from './queryapi/product.queryapi';
import { ShopStorefrontController } from './storefront/controller/shop-storefront.controller';
import { ShopStorefrontService } from './storefront/service/shop-storefront.service';

/*
 * Module product (PLAN-0004): sản phẩm, biến thể, ảnh, tồn kho. Import CatalogModule để dùng CatalogQueryApi (kiểm ngành hàng,
 * màu/size) và CATEGORY_STATS_GATEWAY. Export cho module khác: ProductQueryApi, INVENTORY_GATEWAY, PRODUCT_STATS_GATEWAY.
 */
@Module({
  imports: [CatalogModule, ShopModule],
  controllers: [ProductController, ShopStorefrontController, AdminProductController, ShopProductController, ShopProductImageController, AdminInventoryController, ShopInventoryController],
  providers: [
    ProductRepository,
    InventoryRepository,
    ProductAuditLogService,
    ProductOutboxService,
    ProductQueryService,
    ProductService,
    ProductImageService,
    ShopProductImageService,
    InventoryService,
    ShopInventoryService,
    ShopStorefrontService,
    ProductQueryApi,
    // Đăng ký với CatalogUsageRegistry lúc khởi động (onModuleInit) để catalog hỏi được "ngành/giá trị thuộc tính còn được dùng không".
    CatalogUsageProviderImpl,
    { provide: INVENTORY_GATEWAY, useClass: InventoryGatewayImpl },
    { provide: PRODUCT_STATS_GATEWAY, useClass: ProductStatsGatewayImpl },
  ],
  // ProductService (listener đồng bộ slug ngành hàng) và ProductQueryService (listener xoá cache công khai khi shop đổi trạng thái)
  // export CHỈ cho ProductWorkerModule — module khác không được dùng (dependency-cruiser cấm import ruột).
  exports: [ProductQueryApi, INVENTORY_GATEWAY, PRODUCT_STATS_GATEWAY, ProductService, ProductQueryService],
})
export class ProductModule {}
