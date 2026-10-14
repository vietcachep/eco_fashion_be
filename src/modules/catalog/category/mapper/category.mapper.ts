import { CategoryAdminResponse, CategoryResponse } from '../dto/category.responses';
import type { CategoryRow } from '../repository/category.repository';

export function toCategory(c: CategoryRow): CategoryResponse {
  return { id: c.id, slug: c.slug, name: c.name, imageUrl: c.imageUrl, productCount: c.productCount, parentId: c.parentId, attributeMode: c.attributeMode };
}

export function toCategoryAdmin(c: CategoryRow): CategoryAdminResponse {
  return {
    ...toCategory(c),
    description: c.description,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
