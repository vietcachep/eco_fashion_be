import { DynamicAttributeResponse } from '../dto/dynamic-attribute.responses';
import type { DynamicAttributeWithValuesRow } from '../repository/dynamic-attribute.repository';

export function toDynamicAttributeResponse(row: DynamicAttributeWithValuesRow): DynamicAttributeResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    inputType: row.inputType,
    values: row.values.map((v) => ({
      id: v.id,
      value: v.value,
      extra: (v.extra as Record<string, unknown> | null) ?? null,
      sortOrder: v.sortOrder,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
