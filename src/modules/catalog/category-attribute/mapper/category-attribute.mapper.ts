import { CategoryAttributeDetail, CategoryAttributeTemplate } from '../dto/category-attribute.responses';
import type { CategoryAttributeWithDetailsRow } from '../repository/category-attribute.repository';

export function toCategoryAttributeDetail(row: CategoryAttributeWithDetailsRow): CategoryAttributeDetail {
  return {
    id: row.id,
    attributeId: row.attributeId,
    attribute: {
      id: row.attribute.id,
      code: row.attribute.code,
      name: row.attribute.name,
      inputType: row.attribute.inputType,
      values: row.attribute.values.map((v) => ({
        id: v.id,
        value: v.value,
        extra: (v.extra as Record<string, unknown> | null) ?? null,
        sortOrder: v.sortOrder,
      })),
    },
    required: row.required,
    isVariantAxis: row.isVariantAxis,
    sortOrder: row.sortOrder,
  };
}

export function toCategoryAttributeTemplate(rows: CategoryAttributeWithDetailsRow[]): CategoryAttributeTemplate {
  return {
    attributes: rows.map(toCategoryAttributeDetail),
  };
}
