import type { AttributeRepository } from '../attribute/repository/attribute.repository';
import type { AttributeService } from '../attribute/service/attribute.service';
import type { CategoryAttributeRepository, CategoryAttributeWithDetailsRow } from '../category-attribute/repository/category-attribute.repository';
import type { CategoryRepository } from '../category/repository/category.repository';
import type { DynamicAttributeRepository } from '../dynamic-attribute/repository/dynamic-attribute.repository';
import { CatalogQueryApi } from './catalog.queryapi';

/*
 * CatalogQueryApi.getCategoryAttributeTemplate phải trả `inputType` (select | text | number) để product kiểm giá trị thuộc tính cấp sản phẩm
 * đúng kiểu — trước đây thiếu nên product chỉ kiểm "nếu có". Repository thay bằng bản giả (đọc thuần, không DB).
 */

function row(attributeId: string, inputType: string, over: { required?: boolean; isVariantAxis?: boolean } = {}): CategoryAttributeWithDetailsRow {
  return {
    id: `ca-${attributeId}`,
    categoryId: 'cat-1',
    attributeId,
    required: over.required ?? false,
    isVariantAxis: over.isVariantAxis ?? false,
    sortOrder: 0,
    attribute: { id: attributeId, code: attributeId, name: attributeId, inputType, values: [] },
  };
}

function build(rows: CategoryAttributeWithDetailsRow[]) {
  const getByCategoryId = jest.fn((_categoryId: string) => Promise.resolve(rows));
  const api = new CatalogQueryApi({} as CategoryRepository, {} as AttributeRepository, {} as AttributeService, {} as DynamicAttributeRepository, { getByCategoryId } as unknown as CategoryAttributeRepository);
  return { api, getByCategoryId };
}

describe('CatalogQueryApi.getCategoryAttributeTemplate', () => {
  it('trả inputType của từng thuộc tính (select | text | number) cùng required/isVariantAxis', async () => {
    const { api, getByCategoryId } = build([row('a-storage', 'select', { required: true, isVariantAxis: true }), row('a-warranty', 'number'), row('a-note', 'text', { required: true })]);

    const tpl = await api.getCategoryAttributeTemplate('cat-1');

    expect(getByCategoryId).toHaveBeenCalledWith('cat-1');
    expect(tpl).toEqual([
      { attributeId: 'a-storage', required: true, isVariantAxis: true, inputType: 'select' },
      { attributeId: 'a-warranty', required: false, isVariantAxis: false, inputType: 'number' },
      { attributeId: 'a-note', required: true, isVariantAxis: false, inputType: 'text' },
    ]);
  });

  it('inputType lạ (dữ liệu bẩn ngoài select|text|number) lùi về "select" — kiểu nghiêm nhất, không lọt giá trị nhập tay', async () => {
    const { api } = build([row('a-x', 'checkbox'), row('a-y', ''), row('a-z', 'SELECT')]);

    const tpl = await api.getCategoryAttributeTemplate('cat-1');

    expect(tpl.map((t) => t.inputType)).toEqual(['select', 'select', 'select']);
  });

  it('ngành chưa có mẫu ⇒ mảng rỗng', async () => {
    const { api } = build([]);

    await expect(api.getCategoryAttributeTemplate('cat-1')).resolves.toEqual([]);
  });
});
