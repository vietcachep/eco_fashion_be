import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { CategoryAttributeRepository } from '../../category-attribute/repository/category-attribute.repository';
import type { CategoryAttributeWithDetailsRow } from '../../category-attribute/repository/category-attribute.repository';
import { CategoryRepository } from '../../category/repository/category.repository';
import type { CategoryRow } from '../../category/repository/category.repository';
import { ATTRIBUTE_MODE, CATALOG_CACHE, CATALOG_ERR } from '../../foundation/catalog.constants';
import { ShopCategoryTemplateResponse, ShopLeafCategoryResponse, ShopTemplateAttributeResponse } from '../dto/shop-catalog.responses';

/* Số cấp tối đa khi đi ngược lên tìm tổ tiên — chặn vòng lặp nếu dữ liệu cây bị hỏng (cha trỏ ngược con). */
const MAX_DEPTH = 10;

/*
 * Đọc catalog cho VENDOR (gian hàng) — cổng chỉ ĐỌC, không ghi/audit/outbox: vendor cần biết (1) ngành lá nào được gán sản phẩm
 * và (2) ngành đó yêu cầu thuộc tính gì để dựng form. Controller gác bằng ShopContextGuard + shop.product.read (vendor không có
 * catalog.category.read / catalog.dynamic_attribute.read của khu quản trị sàn).
 * Cache: danh sách ngành lá dùng chung khoá 'shop-leaves' trong nhóm categories (10', xoá cùng cây ngành khi admin sửa ngành);
 * mẫu thuộc tính KHÔNG cache vì admin sửa mẫu/giá trị không xoá cache categories — đọc tươi (một truy vấn có join giá trị).
 */
@Injectable()
export class ShopCatalogService {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly categoryAttributes: CategoryAttributeRepository,
    private readonly cache: CacheService,
  ) {}

  /*
   * Ngành LÁ đang bật: đang bật, không còn ngành con đang bật, và mọi ngành tổ tiên cũng đang bật (ngành cha bị ẩn thì cả nhánh
   * không hiện trên web nên không cho vendor chọn). Kèm tên ngành cha + đường dẫn đầy đủ để phân biệt các ngành lá trùng tên.
   */
  async listLeaves(): Promise<ShopLeafCategoryResponse[]> {
    return this.cache.getOrSet(CATALOG_CACHE.categories, 'shop-leaves', async () => {
      const all = await this.categories.listAll();
      const byId = new Map(all.map((c) => [c.id, c]));
      const hasActiveChild = new Set(all.filter((c) => c.isActive && c.parentId).map((c) => c.parentId as string));
      const leaves: ShopLeafCategoryResponse[] = [];
      for (const c of all) {
        if (!c.isActive || hasActiveChild.has(c.id)) continue;
        const chain = this.ancestorsOf(c, byId); // gần → xa
        if (chain.some((a) => !a.isActive)) continue;
        leaves.push({
          id: c.id,
          slug: c.slug,
          name: c.name,
          parentName: chain[0]?.name ?? null,
          path: [...chain].reverse().map((a) => a.name).concat(c.name).join(' › '),
          attributeMode: c.attributeMode,
        });
      }
      return leaves.sort((a, b) => a.path.localeCompare(b.path, 'vi'));
    });
  }

  /* Mẫu thuộc tính của ngành theo slug. Ngành không có/đang ẩn → 404; ngành legacy_fashion → attributes rỗng (dùng form thời trang cũ). */
  async getTemplateBySlug(slug: string): Promise<ShopCategoryTemplateResponse> {
    const c = await this.categories.findBySlug(slug);
    if (!c || !c.isActive) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    const rows = c.attributeMode === ATTRIBUTE_MODE.DYNAMIC ? await this.categoryAttributes.getByCategoryId(c.id) : [];
    return { categoryId: c.id, slug: c.slug, name: c.name, attributeMode: c.attributeMode, attributes: rows.map((r) => this.toAttribute(r)) };
  }

  private ancestorsOf(c: CategoryRow, byId: ReadonlyMap<string, CategoryRow>): CategoryRow[] {
    const chain: CategoryRow[] = [];
    let cur = c.parentId ? byId.get(c.parentId) : undefined;
    while (cur && chain.length < MAX_DEPTH) {
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }

  private toAttribute(r: CategoryAttributeWithDetailsRow): ShopTemplateAttributeResponse {
    const isSelect = r.attribute.inputType === 'select';
    return {
      attributeId: r.attributeId,
      code: r.attribute.code,
      name: r.attribute.name,
      inputType: r.attribute.inputType,
      required: r.required,
      isVariantAxis: r.isVariantAxis,
      sortOrder: r.sortOrder,
      values: isSelect ? r.attribute.values.map((v) => ({ id: v.id, value: v.value, hex: hexOf(v.extra) })) : [],
    };
  }
}

/* extra là JSON tự do theo thuộc tính — chỉ lấy `hex` khi đúng là chuỗi. */
function hexOf(extra: unknown): string | null {
  if (extra && typeof extra === 'object' && 'hex' in extra) {
    return typeof extra.hex === 'string' ? extra.hex : null;
  }
  return null;
}
