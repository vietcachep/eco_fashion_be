import { Module } from '@nestjs/common';
import { CATEGORY_STATS_GATEWAY } from '@common/gateway/category-stats.gateway';
import { ShopModule } from '../shop/shop.module';
import { AdminCategoryAttributeController } from './category-attribute/controller/category-attribute.controller';
import { CategoryAttributeRepository } from './category-attribute/repository/category-attribute.repository';
import { CategoryAttributeService } from './category-attribute/service/category-attribute.service';
import { AttributeController } from './attribute/controller/admin-attribute.controller';
import { AttributeRepository } from './attribute/repository/attribute.repository';
import { AttributeService } from './attribute/service/attribute.service';
import { CatalogAuditLogService } from './audit/catalog-audit-log.service';
import { AdminCategoryController } from './category/controller/admin-category.controller';
import { CategoryController } from './category/controller/category.controller';
import { CategoryRepository } from './category/repository/category.repository';
import { CategoryService } from './category/service/category.service';
import { AdminCollectionController } from './collection/controller/admin-collection.controller';
import { CollectionController } from './collection/controller/collection.controller';
import { CollectionRepository } from './collection/repository/collection.repository';
import { CollectionService } from './collection/service/collection.service';
import { AdminDynamicAttributeController } from './dynamic-attribute/controller/admin-dynamic-attribute.controller';
import { DynamicAttributeRepository } from './dynamic-attribute/repository/dynamic-attribute.repository';
import { DynamicAttributeService } from './dynamic-attribute/service/dynamic-attribute.service';
import { CategoryStatsGatewayImpl } from './gateway/category-stats.gateway.impl';
import { CatalogOutboxService } from './outbox/catalog-outbox.service';
import { CatalogQueryApi } from './queryapi/catalog.queryapi';
import { CatalogUsageRegistry } from './queryapi/catalog-usage.registry';
import { ShopCatalogController } from './shop-catalog/controller/shop-catalog.controller';
import { ShopCatalogService } from './shop-catalog/service/shop-catalog.service';

/*
 * Module catalog (PLAN-0003 + PLAN-0016): ngành hàng, bộ sưu tập, thuộc tính cũ (thời trang), thuộc tính
 * động (ngành hàng khác). Export cho module khác: CatalogQueryApi (đọc) và CATEGORY_STATS_GATEWAY (product
 * cập nhật product_count) + CatalogUsageRegistry (product đăng ký "ngành/giá trị thuộc tính này đang được dùng không",
 * catalog hỏi để chặn đổi mode ngành / xoá giá trị đang dùng). Không export repository/service nội bộ.
 * Import ShopModule để ShopCatalogController (/shop/catalog — vendor đọc ngành + mẫu thuộc tính) dùng ShopContextGuard
 * (guard cần ShopMemberRepository/ShopRepository do ShopModule export — xem ghi chú ở shop.module.ts). ShopModule không
 * import catalog/product nên không tạo vòng.
 */
@Module({
  imports: [ShopModule],
  controllers: [
    CategoryController,
    AdminCategoryController,
    AdminCategoryAttributeController,
    CollectionController,
    AdminCollectionController,
    AttributeController,
    AdminDynamicAttributeController,
    ShopCatalogController,
  ],
  providers: [
    CategoryRepository,
    CollectionRepository,
    AttributeRepository,
    CategoryAttributeRepository,
    DynamicAttributeRepository,
    CatalogAuditLogService,
    CatalogOutboxService,
    CategoryService,
    CollectionService,
    AttributeService,
    CategoryAttributeService,
    DynamicAttributeService,
    ShopCatalogService,
    CatalogQueryApi,
    CatalogUsageRegistry,
    { provide: CATEGORY_STATS_GATEWAY, useClass: CategoryStatsGatewayImpl },
  ],
  exports: [CatalogQueryApi, CatalogUsageRegistry, CATEGORY_STATS_GATEWAY],
})
export class CatalogModule {}
