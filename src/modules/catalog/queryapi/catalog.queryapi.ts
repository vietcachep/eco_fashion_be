import { Injectable } from '@nestjs/common';
import { AttributeRepository } from '../attribute/repository/attribute.repository';
import { AttributeService } from '../attribute/service/attribute.service';
import { CategoryAttributeRepository } from '../category-attribute/repository/category-attribute.repository';
import { CategoryRepository } from '../category/repository/category.repository';
import { DynamicAttributeRepository } from '../dynamic-attribute/repository/dynamic-attribute.repository';
import { ATTRIBUTE_CODE, DYNAMIC_INPUT_TYPES, type DynamicInputType } from '../foundation/catalog.constants';

export type { DynamicInputType };

export interface CategoryBrief {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  /* PLAN-0016 — "legacy_fashion": product dùng gender/material/care/colorCode/sizeCode NHƯ CŨ. "dynamic":
     product dùng ProductAttributeValue/ProductVariantOption + mẫu CategoryAttribute của category này. */
  attributeMode: string;
}

/* PLAN-0016 — 1 dòng mẫu thuộc tính của category (đủ để product module validate options lúc tạo biến thể và giá trị cấp sản phẩm). */
export interface CategoryAttributeTemplateItem {
  attributeId: string;
  required: boolean;
  isVariantAxis: boolean;
  /* select = chọn một giá trị có sẵn (attributeValueId); text | number = nhập tay (customValue). Trục biến thể luôn là select. */
  inputType: DynamicInputType;
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
    private readonly dynamicAttributes: DynamicAttributeRepository,
    private readonly categoryAttributes: CategoryAttributeRepository,
  ) {}

  async findCategoryById(id: string): Promise<CategoryBrief | null> {
    const c = await this.categories.findById(id);
    return c ? { id: c.id, slug: c.slug, name: c.name, isActive: c.isActive, attributeMode: c.attributeMode } : null;
  }

  /* Product chỉ gán sản phẩm vào ngành LÁ (ngành cha chỉ là nhóm hiển thị) — hỏi qua đây để không tự đọc bảng categories. */
  async categoryHasChildren(id: string): Promise<boolean> {
    return this.categories.hasChildren(id);
  }

  async findCategoryBySlug(slug: string): Promise<CategoryBrief | null> {
    const c = await this.categories.findBySlug(slug);
    return c ? { id: c.id, slug: c.slug, name: c.name, isActive: c.isActive, attributeMode: c.attributeMode } : null;
  }

  async listActiveCategories(): Promise<CategoryBrief[]> {
    return (await this.categories.listActive()).map((c) => ({ id: c.id, slug: c.slug, name: c.name, isActive: c.isActive, attributeMode: c.attributeMode }));
  }

  /* PLAN-0016 — mẫu thuộc tính của category (dynamic) — product module dùng để validate options lúc tạo
     biến thể (đúng bộ isVariantAxis=true, không thiếu không thừa) mà KHÔNG tự đọc bảng CategoryAttribute. */
  async getCategoryAttributeTemplate(categoryId: string): Promise<CategoryAttributeTemplateItem[]> {
    const rows = await this.categoryAttributes.getByCategoryId(categoryId);
    return rows.map((r) => ({ attributeId: r.attributeId, required: r.required, isVariantAxis: r.isVariantAxis, inputType: CatalogQueryApi.toInputType(r.attribute.inputType) }));
  }

  /* Cột `input_type` là VarChar(20) (DTO tạo thuộc tính đã chặn ngoài select|text|number); giá trị lạ (dữ liệu bẩn) lùi về mặc định DB
     'select' — kiểu nghiêm nhất: vendor buộc chọn giá trị có sẵn thay vì lọt giá trị nhập tay không kiểm được. */
  private static toInputType(raw: string): DynamicInputType {
    return (DYNAMIC_INPUT_TYPES as readonly string[]).includes(raw) ? (raw as DynamicInputType) : 'select';
  }

  /* PLAN-0016 — snapshot tên hiển thị (displayValue) của các AttributeValue đã chọn, để product module ghi
     vào ProductVariantOption lúc tạo biến thể mà KHÔNG tự đọc bảng DynamicAttributeValue. */
  async findDynamicAttributeValuesByIds(ids: string[]): Promise<Map<string, { id: string; value: string; attributeId: string }>> {
    const rows = await this.dynamicAttributes.findValuesByIds(ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  /* PLAN-0016 — TÊN thuộc tính động (vd "Màu sắc") để module khác (ai) dựng ngữ cảnh dễ đọc, KHÔNG tự đọc
     bảng DynamicAttribute. */
  async findDynamicAttributeNamesByIds(ids: string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
    const rows = await this.dynamicAttributes.findAttributesByIds(ids);
    return new Map(rows.map((r) => [r.id, r]));
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
