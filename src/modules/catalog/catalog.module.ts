import { Module } from '@nestjs/common';
import { CATEGORY_STATS_GATEWAY } from '@common/gateway/category-stats.gateway';
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
import { CategoryStatsGatewayImpl } from './gateway/category-stats.gateway.impl';
import { CatalogOutboxService } from './outbox/catalog-outbox.service';
import { CatalogQueryApi } from './queryapi/catalog.queryapi';

/*
 * Module catalog (PLAN-0003): ngành hàng, bộ sưu tập, thuộc tính. Export cho module khác: CatalogQueryApi (đọc) và
 * CATEGORY_STATS_GATEWAY (product cập nhật product_count). Không export repository/service nội bộ.
 */
@Module({
  controllers: [CategoryController, AdminCategoryController, CollectionController, AdminCollectionController, AttributeController],
  providers: [
    CategoryRepository,
    CollectionRepository,
    AttributeRepository,
    CatalogAuditLogService,
    CatalogOutboxService,
    CategoryService,
    CollectionService,
    AttributeService,
    CatalogQueryApi,
    { provide: CATEGORY_STATS_GATEWAY, useClass: CategoryStatsGatewayImpl },
  ],
  exports: [CatalogQueryApi, CATEGORY_STATS_GATEWAY],
})
export class CatalogModule {}
