import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { ATTRIBUTE_MODE, CATALOG_AUDIT, CATALOG_ERR } from '../../foundation/catalog.constants';
import { CategoryRepository } from '../../category/repository/category.repository';
import { DynamicAttributeRepository } from '../../dynamic-attribute/repository/dynamic-attribute.repository';
import { CatalogUsageRegistry } from '../../queryapi/catalog-usage.registry';
import { CategoryAttributeTemplate } from '../dto/category-attribute.responses';
import { toCategoryAttributeTemplate } from '../mapper/category-attribute.mapper';
import { CategoryAttributeRepository } from '../repository/category-attribute.repository';
import type { SetCategoryAttributeTemplateItemRequest } from '../request/category-attribute.requests';

/* Số trục biến thể tối đa của một ngành (khớp quyết định "tối đa 2 trục" và ProductVariantOption). */
const MAX_VARIANT_AXIS = 2;

/*
 * Mẫu thuộc tính theo category (ngành hàng, PLAN-0016): set danh sách thuộc tính bắt buộc hay không,
 * có dùng làm trục biến thể không. Thao tác set là XÓA HẲN CategoryAttribute cũ rồi tạo lại (replace toàn bộ) trong MỘT
 * transaction + audit. VALIDATE (mỗi lỗi một mã MODULE_LY_DO rõ ràng):
 *  - ngành tồn tại (404) và đang ở chế độ 'dynamic' (409) — ngành legacy_fashion không dùng mẫu này;
 *  - attributeId không trùng nhau (400) và đều tồn tại (404);
 *  - tối đa 2 trục biến thể (400); mẫu có thuộc tính thì PHẢI có ≥ 1 trục (nếu không ngành không tạo nổi biến thể nào, 400);
 *  - trục biến thể phải là thuộc tính 'select' (400) — text/number không có tập giá trị cố định để tạo biến thể;
 *  - mẫu rỗng (xoá sạch) chỉ cho khi ngành chưa có sản phẩm (409), tránh làm sản phẩm hiện có mất mẫu.
 * Không ghi outbox (không module nào cần phản ứng); cache category không bị ảnh hưởng.
 */
@Injectable()
export class CategoryAttributeService {
  private readonly logger = new Logger(CategoryAttributeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CategoryAttributeRepository,
    private readonly categories: CategoryRepository,
    private readonly attributes: DynamicAttributeRepository,
    private readonly audit: CatalogAuditLogService,
    private readonly usage: CatalogUsageRegistry,
  ) {}

  async getTemplate(categoryId: string): Promise<CategoryAttributeTemplate> {
    if (!(await this.categories.findById(categoryId))) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    const rows = await this.repo.getByCategoryId(categoryId);
    return toCategoryAttributeTemplate(rows);
  }

  async setTemplate(actor: AuthenticatedActor, categoryId: string, items: SetCategoryAttributeTemplateItemRequest[]): Promise<CategoryAttributeTemplate> {
    const category = await this.categories.findById(categoryId);
    if (!category) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    if (category.attributeMode !== ATTRIBUTE_MODE.DYNAMIC) {
      throw new ConflictException(CATALOG_ERR.CATEGORY_NOT_DYNAMIC, `Ngành hàng đang ở chế độ '${category.attributeMode}' — chỉ ngành 'dynamic' mới có mẫu thuộc tính`);
    }

    const ids = items.map((i) => i.attributeId);
    const duplicated = [...new Set(ids.filter((id, idx) => ids.indexOf(id) !== idx))];
    if (duplicated.length > 0) throw new BusinessException(CATALOG_ERR.TEMPLATE_ATTRIBUTE_DUPLICATED, `Thuộc tính bị khai báo trùng: ${duplicated.join(', ')}`);

    const axisItems = items.filter((i) => i.isVariantAxis);
    const variantAxisCount = axisItems.length;
    if (variantAxisCount > MAX_VARIANT_AXIS) throw new BusinessException(CATALOG_ERR.TOO_MANY_VARIANT_AXIS, `Tối đa ${MAX_VARIANT_AXIS} thuộc tính làm trục biến thể cho một ngành hàng`);
    if (items.length > 0 && variantAxisCount === 0) {
      throw new BusinessException(CATALOG_ERR.VARIANT_AXIS_REQUIRED, 'Ngành hàng cần ít nhất 1 thuộc tính làm trục biến thể (vd Dung lượng, Màu) — nếu không sản phẩm không tạo được biến thể nào');
    }
    if (items.length === 0) {
      const products = Math.max(category.productCount, await this.usage.countProductsInCategory(categoryId));
      if (products > 0) throw new ConflictException(CATALOG_ERR.CATEGORY_HAS_PRODUCTS, `Ngành hàng đã có ${products} sản phẩm — không thể xoá sạch mẫu thuộc tính`);
    }

    // Một lượt tra mọi thuộc tính (không N+1): vừa kiểm tồn tại vừa lấy inputType để kiểm trục biến thể.
    const found = new Map((await this.attributes.findByIdsWithType(ids)).map((a) => [a.id, a]));
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length > 0) throw new NotFoundException(CATALOG_ERR.DYNAMIC_ATTRIBUTE_NOT_FOUND, `Thuộc tính không tồn tại: ${unknown.join(', ')}`);
    const badAxis = axisItems.map((i) => found.get(i.attributeId)!).filter((a) => a.inputType !== 'select');
    if (badAxis.length > 0) {
      throw new BusinessException(CATALOG_ERR.VARIANT_AXIS_NOT_SELECT, `Trục biến thể phải là thuộc tính kiểu 'select' (chọn từ danh sách) — không hợp lệ: ${badAxis.map((a) => `${a.code} (${a.inputType})`).join(', ')}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Xóa hết CategoryAttribute cũ của category rồi tạo lại từ mảng mới
      await this.repo.deleteAllByCategory(categoryId, tx);
      for (const item of items) {
        await this.repo.create(
          {
            categoryId,
            attributeId: item.attributeId,
            required: item.required ?? false,
            isVariantAxis: item.isVariantAxis ?? false,
            sortOrder: item.sortOrder ?? 0,
          },
          tx,
        );
      }

      await this.audit.write(tx, actor, {
        action: CATALOG_AUDIT.CATEGORY_ATTRIBUTE_TEMPLATE_SET,
        entityType: 'categoryAttribute',
        entityId: categoryId,
        entityCode: category.slug,
        after: { attributeCount: items.length, variantAxisCount },
      });

      return this.repo.getByCategoryId(categoryId, tx);
    });

    this.logger.log({ categoryId, attributeCount: items.length, variantAxisCount, by: actor.userId }, 'Đã cập nhật mẫu thuộc tính ngành hàng');
    return toCategoryAttributeTemplate(updated);
  }
}
