import { CategoryAdminResponse, CategoryResponse } from '../dto/category.responses';
import type { CategoryRow } from '../repository/category.repository';

export function toCategory(c: CategoryRow): CategoryResponse {
  return { id: c.id, slug: c.slug, name: c.name, imageUrl: c.imageUrl, productCount: c.productCount };
}

export function toCategoryAdmin(c: CategoryRow): CategoryAdminResponse {
  return {
    ...toCategory(c),
    description: c.description,
    parentId: c.parentId,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
