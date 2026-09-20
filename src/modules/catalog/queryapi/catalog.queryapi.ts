import { Injectable } from '@nestjs/common';
import { AttributeRepository } from '../attribute/repository/attribute.repository';
import { AttributeService } from '../attribute/service/attribute.service';
import { CategoryRepository } from '../category/repository/category.repository';
import { ATTRIBUTE_CODE } from '../foundation/catalog.constants';

export interface CategoryBrief {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
}

export interface ColorDef {
  code: string;
  name: string;
  hex: string | null;
}

export interface SizeDef {
  code: string;
  name: string;
  groupCode: string | null;
  sortOrder: number;
}

/*
 * QueryAPI của catalog — cổng ĐỌC cho module khác (product, ai, reporting). Thứ DUY NHẤT được import từ catalog.
 * Màu/size trả dạng map để product kiểm mã biến thể và chép snapshot (tên, hex) vào biến thể.
 */
@Injectable()
export class CatalogQueryApi {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly attributes: AttributeRepository,
    private readonly attributeService: AttributeService,
  ) {}

  async findCategoryById(id: string): Promise<CategoryBrief | null> {
    const c = await this.categories.findById(id);
    return c ? { id: c.id, slug: c.slug, name: c.name, isActive: c.isActive } : null;
  }

  async findCategoryBySlug(slug: string): Promise<CategoryBrief | null> {
    const c = await this.categories.findBySlug(slug);
    return c ? { id: c.id, slug: c.slug, name: c.name, isActive: c.isActive } : null;
  }

  async listActiveCategories(): Promise<CategoryBrief[]> {
    return (await this.categories.listActive()).map((c) => ({ id: c.id, slug: c.slug, name: c.name, isActive: c.isActive }));
  }

  /* Đọc qua cache của AttributeService (10') — product list/filters gọi nhiều. */
  async colorMap(): Promise<Map<string, ColorDef>> {
    const all = await this.attributeService.listAll();
    const color = all.find((a) => a.code === ATTRIBUTE_CODE.COLOR);
    return new Map((color?.values ?? []).map((v) => [v.code, { code: v.code, name: v.name, hex: v.hex }]));
  }

  async sizeMap(): Promise<Map<string, SizeDef>> {
    const all = await this.attributeService.listAll();
    const size = all.find((a) => a.code === ATTRIBUTE_CODE.SIZE);
    return new Map((size?.values ?? []).map((v) => [v.code, { code: v.code, name: v.name, groupCode: v.groupCode, sortOrder: v.sortOrder }]));
  }

  /* Không cache — seed/scripts cần dữ liệu tươi. */
  async colorMapFresh(): Promise<Map<string, ColorDef>> {
    const a = await this.attributes.findByCode(ATTRIBUTE_CODE.COLOR);
    return new Map((a?.values ?? []).map((v) => [v.code, { code: v.code, name: v.name, hex: v.hex }]));
  }
}
