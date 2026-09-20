import { CollectionAdminResponse, CollectionResponse } from '../dto/collection.responses';
import type { CollectionRow } from '../repository/collection.repository';

export function toCollection(c: CollectionRow): CollectionResponse {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    tagline: c.tagline,
    imageUrl: c.imageUrl,
    query: {
      ...(c.queryCategorySlug ? { category: c.queryCategorySlug } : {}),
      ...(c.queryGender ? { gender: c.queryGender } : {}),
      ...(c.queryTag ? { tag: c.queryTag } : {}),
    },
  };
}

export function toCollectionAdmin(c: CollectionRow): CollectionAdminResponse {
  return { ...toCollection(c), sortOrder: c.sortOrder, isActive: c.isActive, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
}
