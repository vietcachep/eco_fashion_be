import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { money } from '@common/response/money-response';
import { makeSku, slugify } from '@common/utils/slug';
import { Prisma } from '@common/prisma/types';
import { sortSizes, toProductCard } from './product/mapper/product.mapper';
import type { ProductCardRow } from './product/repository/product.repository';
import { ProductListQuery } from './product/request/product.requests';

/* Test quy tắc THUẦN của product: nhãn thẻ, ảnh theo màu, sắp size, SKU, tiền, query. Luồng DB/kho kiểm bằng smoke trên compose. */
function row(over: Partial<ProductCardRow> = {}): ProductCardRow {
  return {
    id: 'p1',
    slug: 'ao-thun-cotton-nam-basic',
    name: 'Áo thun cotton nam basic',
    categoryId: 'c1',
    categorySlug: 'ao-thun',
    gender: 'nam',
    basePrice: new Prisma.Decimal('159000'),
    listPrice: new Prisma.Decimal('199000'),
    status: 'active',
    isNew: true,
    isFeatured: false,
    tags: ['new'],
    soldCount: 940,
    reviewCount: 10,
    avgRating: new Prisma.Decimal('4.70'),
    publishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    variants: [
      { id: 'v1', sku: 'A-TRANG-M', colorCode: 'trang', colorName: 'Trắng', colorHex: '#fff', sizeCode: 'M', price: null, stock: 5, reserved: 5, isActive: true },
      { id: 'v2', sku: 'A-TRANG-S', colorCode: 'trang', colorName: 'Trắng', colorHex: '#fff', sizeCode: 'S', price: null, stock: 0, reserved: 0, isActive: true },
      { id: 'v3', sku: 'A-DEN-XL', colorCode: 'den', colorName: 'Đen', colorHex: '#000', sizeCode: 'XL', price: null, stock: 3, reserved: 0, isActive: true },
      { id: 'v4', sku: 'A-XAM-M', colorCode: 'xam', colorName: 'Xám', colorHex: '#999', sizeCode: 'M', price: null, stock: 9, reserved: 0, isActive: false },
    ],
    images: [
      { id: 'i1', url: 'u-main', publicId: null, colorCode: 'trang', alt: null, sortOrder: 0, isPrimary: true },
      { id: 'i2', url: 'u-hover', publicId: null, colorCode: 'trang', alt: null, sortOrder: 1, isPrimary: false },
      { id: 'i3', url: 'u-den', publicId: null, colorCode: 'den', alt: null, sortOrder: 2, isPrimary: false },
    ],
    ...over,
  };
}

describe('product — thẻ sản phẩm', () => {
  it('giảm giá thắng "Mới": badge -20%, listPrice có, ảnh chính/hover cùng màu, ảnh theo màu, size theo thứ tự, bỏ biến thể tắt', () => {
    const card = toProductCard(row());
    expect(card.badge).toBe('-20%');
    expect(card.price.display).toBe('159.000 ₫');
    expect(card.listPrice?.amount).toBe('199000');
    expect(card.imageUrl).toBe('u-main');
    expect(card.hoverImageUrl).toBe('u-hover');
    expect(card.colors.map((c) => [c.code, c.imageUrl])).toEqual([
      ['trang', 'u-main'],
      ['den', 'u-den'],
    ]);
    expect(card.sizes).toEqual(['S', 'M', 'XL']);
    expect(card.inStock).toBe(true); // v3 còn 3; v1 hết (5 giữ) ; v2 = 0
  });

  it('không giảm giá → "Mới"; hết mới → "Bán chạy" theo ngưỡng; listPrice ≤ giá bán bị bỏ', () => {
    expect(toProductCard(row({ listPrice: null })).badge).toBe('Mới');
    expect(toProductCard(row({ listPrice: null, isNew: false })).badge).toBe('Bán chạy');
    expect(toProductCard(row({ listPrice: null, isNew: false, soldCount: 10 })).badge).toBeNull();
    expect(toProductCard(row({ listPrice: new Prisma.Decimal('100000') })).listPrice).toBeNull();
  });

  it('inStock = false khi mọi biến thể hết hoặc bị giữ hết', () => {
    const r = row();
    r.variants = r.variants.map((v) => ({ ...v, reserved: v.stock }));
    expect(toProductCard(r).inStock).toBe(false);
  });
});

describe('product — tiện ích', () => {
  it('sortSizes: chữ trước số, size lạ cuối', () => {
    expect(sortSizes(['30', 'L', '28', 'S', 'FREE', 'XL'])).toEqual(['S', 'L', 'XL', '28', '30', 'FREE']);
  });

  it('makeSku: hai slug cùng 8 ký tự đầu vẫn khác nhau; màu xanh ≠ xanhla', () => {
    const a = makeSku('ao-so-mi-nu-tay-phong', 'trang', 'M');
    const b = makeSku('ao-so-mi-nu-form-rong', 'trang', 'M');
    expect(a).not.toBe(b);
    expect(makeSku('ao-thun-polo-nam', 'xanh', 'L')).not.toBe(makeSku('ao-thun-polo-nam', 'xanhla', 'L'));
    expect(a).toMatch(/^AOSOMINU[0-9A-F]{4}-TRANG-M$/);
  });

  it('slugify tiếng Việt và money VND', () => {
    expect(slugify('Áo thun Đen  Basic!')).toBe('ao-thun-den-basic');
    expect(money('1234567')).toEqual({ amount: '1234567', display: '1.234.567 ₫', currency: 'VND', symbol: '₫' });
  });

  it('ProductListQuery: size là size quần áo, pageSize là cỡ trang (≤ 48), sale nhận chuỗi', () => {
    const q = plainToInstance(ProductListQuery, { size: 'M', pageSize: '12', page: '2', sale: 'true', sort: 'priceAsc', minPrice: '100000' });
    expect(validateSync(q)).toHaveLength(0);
    expect(q.size).toBe('M');
    expect(q.pageSize).toBe(12);
    expect(q.sale).toBe(true);
    expect(validateSync(plainToInstance(ProductListQuery, { pageSize: '100' })).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(ProductListQuery, { sort: 'random' })).length).toBeGreaterThan(0);
  });
});
