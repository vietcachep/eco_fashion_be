import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateProductRequest, CreateShopProductRequest, ReorderImagesRequest, SaveAttributesRequest, SaveVariantsRequest, UpdateProductRequest, UpdateShopProductRequest } from './product.requests';

/* Như ValidationPipe của main.ts: whitelist = bỏ key không có decorator (không 400). */
const PIPE = { whitelist: true, forbidNonWhitelisted: false } as const;
const UUID_A = '3f2b8c1e-5d4a-4f6b-9a7c-1e2d3c4b5a69';
const UUID_B = '7a1c9e2d-8b3f-4c5d-a6e7-2f3a4b5c6d7e';

describe('request sản phẩm', () => {
  const platformFields = { isFeatured: true, isNew: true, tags: ['new'] };

  it('M6: request của vendor KHÔNG nhận isFeatured/isNew/tags — whitelist loại bỏ, không báo lỗi', () => {
    const create = plainToInstance(CreateShopProductRequest, { name: 'Áo thun basic', categoryId: UUID_A, basePrice: '159000', ...platformFields });
    expect(validateSync(create, PIPE)).toHaveLength(0);
    expect(create).not.toHaveProperty('isFeatured');
    expect(create).not.toHaveProperty('isNew');
    expect(create).not.toHaveProperty('tags');
    expect(create.name).toBe('Áo thun basic');

    const update = plainToInstance(UpdateShopProductRequest, { name: 'Tên mới', ...platformFields });
    expect(validateSync(update, PIPE)).toHaveLength(0);
    expect(update).not.toHaveProperty('isFeatured');
    expect(update).not.toHaveProperty('tags');
  });

  it('M6: request của admin vẫn nhận isFeatured/isNew/tags (và vẫn kiểm định dạng tag)', () => {
    const create = plainToInstance(CreateProductRequest, { name: 'Áo thun basic', categoryId: UUID_A, basePrice: '159000', ...platformFields });
    expect(validateSync(create, PIPE)).toHaveLength(0);
    expect(create).toMatchObject(platformFields);
    expect(validateSync(plainToInstance(UpdateProductRequest, { tags: ['Không Hợp Lệ'] }), PIPE).length).toBeGreaterThan(0);
  });

  it('request vendor vẫn giữ validator của các trường còn lại (tên ≥ 3 ký tự, giá là số, variants lồng nhau)', () => {
    expect(validateSync(plainToInstance(CreateShopProductRequest, { name: 'ab', categoryId: UUID_A, basePrice: '1000' }), PIPE).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(CreateShopProductRequest, { name: 'Áo thun', categoryId: UUID_A, basePrice: 'abc' }), PIPE).length).toBeGreaterThan(0);
    const badVariant = plainToInstance(CreateShopProductRequest, { name: 'Áo thun', categoryId: UUID_A, basePrice: '1000', variants: [{ price: 'abc' }] });
    expect(validateSync(badVariant, PIPE).length).toBeGreaterThan(0);
  });

  it('H3: SaveAttributesRequest kiểm từng dòng (attributeId phải là uuid; customValue ≤ 255)', () => {
    const ok = plainToInstance(SaveAttributesRequest, { attributeValues: [{ attributeId: UUID_A, attributeValueId: UUID_B }, { attributeId: UUID_B, customValue: '12' }] });
    expect(validateSync(ok, PIPE)).toHaveLength(0);
    expect(validateSync(plainToInstance(SaveAttributesRequest, { attributeValues: [{ attributeId: 'khong-phai-uuid' }] }), PIPE).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(SaveAttributesRequest, { attributeValues: [{ attributeId: UUID_A, customValue: 'x'.repeat(256) }] }), PIPE).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(SaveAttributesRequest, {}), PIPE).length).toBeGreaterThan(0);
  });

  it('LOW: reorder ảnh không chấp nhận id trùng', () => {
    expect(validateSync(plainToInstance(ReorderImagesRequest, { imageIds: [UUID_A, UUID_B] }), PIPE)).toHaveLength(0);
    expect(validateSync(plainToInstance(ReorderImagesRequest, { imageIds: [UUID_A, UUID_A] }), PIPE).length).toBeGreaterThan(0);
  });

  it('SaveVariantsRequest: tối đa 2 trục mỗi biến thể, SKU chỉ gồm A-Z 0-9 và gạch ngang', () => {
    const body = (variant: object) => plainToInstance(SaveVariantsRequest, { variants: [variant] });
    expect(validateSync(body({ sku: 'ip15-128-den', options: [{ attributeId: UUID_A, attributeValueId: UUID_B }] }), PIPE)).toHaveLength(0);
    expect(validateSync(body({ sku: 'có dấu cách' }), PIPE).length).toBeGreaterThan(0);
    const three = { attributeId: UUID_A, attributeValueId: UUID_B };
    expect(validateSync(body({ options: [three, three, three] }), PIPE).length).toBeGreaterThan(0);
  });
});
