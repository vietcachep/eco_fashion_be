import type { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';

/*
 * Tên thuộc tính + giá trị đã resolve cho thuộc tính cấp sản phẩm (ngành dynamic). ProductAttributeValue chỉ lưu id sang
 * schema catalog, nên mapper (hàm thuần, đồng bộ) không tự tra được — chỗ gọi resolve MỘT lần qua CatalogQueryApi rồi truyền vào.
 */
export interface AttributeLookup {
  /* attributeId → tên thuộc tính (vd "Xuất xứ"). */
  names: ReadonlyMap<string, string>;
  /* attributeValueId → giá trị đã chọn (vd "Việt Nam"). */
  values: ReadonlyMap<string, string>;
}

/* Batch resolve cho một sản phẩm: tối đa 2 truy vấn catalog (tên + giá trị), bỏ qua hẳn khi sản phẩm không có thuộc tính động. */
export async function resolveAttributeLookup(catalog: Pick<CatalogQueryApi, 'findDynamicAttributeNamesByIds' | 'findDynamicAttributeValuesByIds'>, product: { attributeValues?: Array<{ attributeId: string; attributeValueId: string | null }>; variants?: Array<{ options?: Array<{ attributeId: string }> }> }): Promise<AttributeLookup | undefined> {
  const rows = product.attributeValues ?? [];
  // Tên TRỤ biến thể (variants[].options[].attributeName) cũng tra ở đây — cùng một lượt batch với thuộc tính cấp sản phẩm.
  const axisIds = (product.variants ?? []).flatMap((v) => (v.options ?? []).map((o) => o.attributeId));
  if (rows.length === 0 && axisIds.length === 0) return undefined;
  const attrIds = [...new Set([...rows.map((r) => r.attributeId), ...axisIds])];
  const valueIds = [...new Set(rows.map((r) => r.attributeValueId).filter((id): id is string => Boolean(id)))];
  const [names, values] = await Promise.all([catalog.findDynamicAttributeNamesByIds(attrIds), valueIds.length > 0 ? catalog.findDynamicAttributeValuesByIds(valueIds) : Promise.resolve(new Map<string, { id: string; value: string; attributeId: string }>())]);
  return {
    names: new Map([...names].map(([id, a]) => [id, a.name])),
    values: new Map([...values].map(([id, v]) => [id, v.value])),
  };
}
