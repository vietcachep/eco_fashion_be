/* eslint-disable @typescript-eslint/require-await -- FakeRepo giả lập repository bất đồng bộ: giữ chữ ký async của bản thật. */
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { Prisma } from '@common/prisma/types';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { makeSku } from '@common/utils/slug';
import type { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import type { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import type { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { PRODUCT_AUDIT, PRODUCT_ERR } from '../../foundation/product.constants';
import type { ProductOutboxService } from '../../outbox/product-outbox.service';
import type { ProductDetailRow, ProductRepository } from '../repository/product.repository';
import type { ProductQueryService } from './product-query.service';
import { ProductService, VariantSpec } from './product.service';

/*
 * Test lõi ghi sản phẩm (ProductService) trên một "DB" bộ nhớ có transaction THẬT SỰ (hoàn tác khi lỗi) và đúng index partial
 * uq_product_variants_shop_sku_active (shop_id, sku) WHERE is_deleted = false: trùng SKU trong cùng shop là Error như P2002 thật.
 * Nhờ vậy test C2 kiểm được điều quan trọng nhất — lưu biến thể hai lần liên tiếp phải GIỮ id + tồn kho + hàng đang giữ.
 */

interface FVariant {
  id: string;
  productId: string;
  shopId: string;
  sku: string;
  colorCode: string | null;
  colorName: string | null;
  colorHex: string | null;
  sizeCode: string | null;
  price: string | null;
  stock: number;
  reserved: number;
  isActive: boolean;
  isDeleted: boolean;
  options: Array<{ id: string; attributeId: string; attributeValueId: string; displayValue: string }>;
}
interface FProduct {
  id: string;
  shopId: string;
  slug: string;
  name: string;
  categoryId: string;
  categorySlug: string;
  gender: string;
  basePrice: string;
  listPrice: string | null;
  status: string;
  isNew: boolean;
  isFeatured: boolean;
  tags: string[];
  material: string | null;
  care: string[];
  shortDescription: string | null;
  description: string | null;
  publishedAt: string | null;
  isDeleted: boolean;
  version: number;
  attributes: Array<{ id: string; attributeId: string; attributeValueId: string | null; customValue: string | null }>;
  images: Array<{ id: string; url: string; publicId: string | null; colorCode: string | null; alt: string | null; sortOrder: number; isPrimary: boolean }>;
}
interface State {
  products: FProduct[];
  variants: FVariant[];
  draftRefs: Array<{ variantId: string; code: string }>;
  seq: number;
}

type UpdateData = Parameters<ProductRepository['update']>[1];
type CreateData = Parameters<ProductRepository['create']>[0];
type LegacySpec = Parameters<ProductRepository['upsertVariant']>[2];
type DynamicSpec = Parameters<ProductRepository['createVariantDynamic']>[2];

const str = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Prisma.Decimal ? v.toString() : String(v));

class FakeRepo {
  constructor(private readonly s: State) {}

  private id(prefix: string): string {
    return `${prefix}-${++this.s.seq}`;
  }

  private assertSkuFree(shopId: string, sku: string, exceptId?: string): void {
    if (this.s.variants.some((v) => !v.isDeleted && v.shopId === shopId && v.sku === sku && v.id !== exceptId)) {
      throw new Error(`P2002 unique violation uq_product_variants_shop_sku_active (${shopId}, ${sku})`);
    }
  }

  private row(p: FProduct): ProductDetailRow {
    return {
      ...p,
      basePrice: new Prisma.Decimal(p.basePrice),
      listPrice: p.listPrice ? new Prisma.Decimal(p.listPrice) : null,
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
      soldCount: 0,
      reviewCount: 0,
      avgRating: new Prisma.Decimal('0'),
      viewCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      attributeValues: p.attributes,
      variants: this.s.variants.filter((v) => v.productId === p.id && !v.isDeleted).map((v) => ({ ...v, price: v.price ? new Prisma.Decimal(v.price) : null })),
    };
  }

  async findDetailById(id: string): Promise<ProductDetailRow | null> {
    const p = this.s.products.find((x) => x.id === id && !x.isDeleted);
    return p ? this.row(p) : null;
  }

  async slugExists(slug: string, exceptId?: string): Promise<boolean> {
    return this.s.products.some((p) => !p.isDeleted && p.slug === slug && p.id !== exceptId);
  }

  async findExistingSlugs(slugs: string[]): Promise<string[]> {
    return this.s.products.filter((p) => !p.isDeleted && slugs.includes(p.slug)).map((p) => p.slug);
  }

  async create(data: CreateData): Promise<ProductDetailRow> {
    if (this.s.products.some((p) => !p.isDeleted && p.slug === data.slug)) throw new Error('P2002 slug');
    const p: FProduct = {
      id: this.id('prod'),
      shopId: data.shopId,
      slug: data.slug,
      name: data.name,
      categoryId: data.categoryId,
      categorySlug: data.categorySlug,
      gender: data.gender ?? 'unisex',
      basePrice: str(data.basePrice),
      listPrice: data.listPrice == null ? null : str(data.listPrice),
      status: data.status ?? 'draft',
      isNew: data.isNew ?? false,
      isFeatured: data.isFeatured ?? false,
      tags: (data.tags as string[] | undefined) ?? [],
      material: data.material ?? null,
      care: (data.care as string[] | undefined) ?? [],
      shortDescription: data.shortDescription ?? null,
      description: data.description ?? null,
      publishedAt: null,
      isDeleted: false,
      version: 0,
      attributes: [],
      images: [],
    };
    this.s.products.push(p);
    return this.row(p);
  }

  async update(id: string, data: UpdateData): Promise<ProductDetailRow> {
    const p = this.s.products.find((x) => x.id === id)!;
    const d = data as Record<string, unknown>;
    for (const k of ['name', 'slug', 'categoryId', 'categorySlug', 'gender', 'status', 'isNew', 'isFeatured', 'tags', 'material', 'care', 'shortDescription', 'description', 'isDeleted'] as const) {
      if (d[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = d[k];
    }
    if (d.basePrice !== undefined) p.basePrice = str(d.basePrice);
    if (d.listPrice !== undefined) p.listPrice = d.listPrice === null ? null : str(d.listPrice);
    if (d.publishedAt instanceof Date) p.publishedAt = d.publishedAt.toISOString();
    p.version++;
    return this.row(p);
  }

  async skuExists(shopId: string, sku: string, exceptId?: string): Promise<boolean> {
    return this.s.variants.some((v) => !v.isDeleted && v.shopId === shopId && v.sku === sku && v.id !== exceptId);
  }

  async findShopSkus(shopId: string, q: { exact?: string[]; prefix?: string }): Promise<Array<{ id: string; sku: string; productId: string }>> {
    return this.s.variants
      .filter((v) => !v.isDeleted && v.shopId === shopId && ((q.exact ?? []).includes(v.sku) || (q.prefix !== undefined && v.sku.startsWith(q.prefix))))
      .map((v) => ({ id: v.id, sku: v.sku, productId: v.productId }));
  }

  async lockProduct(): Promise<void> {
    /* no-op: bộ nhớ chạy tuần tự */
  }

  async lockVariants(ids: string[]): Promise<Array<{ id: string; sku: string; stock: number; reserved: number }>> {
    return this.s.variants.filter((v) => ids.includes(v.id) && !v.isDeleted).map((v) => ({ id: v.id, sku: v.sku, stock: v.stock, reserved: v.reserved }));
  }

  async findDraftReceiptRefs(ids: string[]): Promise<Array<{ variantId: string; receiptCode: string }>> {
    return this.s.draftRefs.filter((r) => ids.includes(r.variantId)).map((r) => ({ variantId: r.variantId, receiptCode: r.code }));
  }

  async upsertVariant(productId: string, shopId: string, v: LegacySpec): Promise<void> {
    const cur = this.s.variants.find((x) => x.productId === productId && x.colorCode === v.colorCode && x.sizeCode === v.sizeCode);
    this.assertSkuFree(shopId, v.sku, cur?.id);
    const price = v.price === null ? null : v.price.toString();
    if (cur) Object.assign(cur, { sku: v.sku, colorName: v.colorName, colorHex: v.colorHex, price, isActive: v.isActive, isDeleted: false });
    else this.s.variants.push({ id: this.id('var'), productId, shopId, sku: v.sku, colorCode: v.colorCode, colorName: v.colorName, colorHex: v.colorHex, sizeCode: v.sizeCode, price, stock: 0, reserved: 0, isActive: v.isActive, isDeleted: false, options: [] });
  }

  async createVariantDynamic(productId: string, shopId: string, v: DynamicSpec): Promise<void> {
    this.assertSkuFree(shopId, v.sku);
    this.s.variants.push({
      id: this.id('var'),
      productId,
      shopId,
      sku: v.sku,
      colorCode: null,
      colorName: null,
      colorHex: null,
      sizeCode: null,
      price: v.price === null ? null : v.price.toString(),
      stock: 0,
      reserved: 0,
      isActive: v.isActive,
      isDeleted: false,
      options: v.options.map((o) => ({ id: this.id('opt'), ...o })),
    });
  }

  async updateVariantDynamic(id: string, v: { sku: string; price: bigint | null; isActive: boolean }): Promise<void> {
    const cur = this.s.variants.find((x) => x.id === id)!;
    this.assertSkuFree(cur.shopId, v.sku, id);
    Object.assign(cur, { sku: v.sku, price: v.price === null ? null : v.price.toString(), isActive: v.isActive });
  }

  async softDeleteVariants(ids: string[]): Promise<number> {
    const hit = this.s.variants.filter((v) => ids.includes(v.id) && !v.isDeleted);
    for (const v of hit) Object.assign(v, { isDeleted: true, isActive: false });
    return hit.length;
  }

  async softDeleteVariantsNotIn(productId: string, keepIds: string[]): Promise<number> {
    const hit = this.s.variants.filter((v) => v.productId === productId && !v.isDeleted && !keepIds.includes(v.id));
    for (const v of hit) Object.assign(v, { isDeleted: true, isActive: false });
    return hit.length;
  }

  async replaceAttributeValues(productId: string, rows: Array<{ attributeId: string; attributeValueId: string | null; customValue: string | null }>): Promise<void> {
    const p = this.s.products.find((x) => x.id === productId)!;
    const ids = rows.map((r) => r.attributeId);
    if (new Set(ids).size !== ids.length) throw new Error('P2002 unique (product_id, attribute_id)');
    p.attributes = rows.map((r) => ({ id: this.id('pav'), ...r }));
  }

  async deleteAttributeValuesNotIn(productId: string, keep: string[]): Promise<number> {
    const p = this.s.products.find((x) => x.id === productId)!;
    const before = p.attributes.length;
    p.attributes = p.attributes.filter((a) => keep.includes(a.attributeId));
    return before - p.attributes.length;
  }
}

// ---------------------------------------------------------------- catalog giả

interface Cat {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  attributeMode: string;
}
interface TplItem {
  attributeId: string;
  required: boolean;
  isVariantAxis: boolean;
  inputType: 'select' | 'text' | 'number';
}
const CATS: Record<string, Cat> = {
  'cat-phone': { id: 'cat-phone', slug: 'dien-thoai', name: 'Điện thoại', isActive: true, attributeMode: 'dynamic' },
  'cat-phone2': { id: 'cat-phone2', slug: 'may-tinh-bang', name: 'Máy tính bảng', isActive: true, attributeMode: 'dynamic' },
  'cat-laptop': { id: 'cat-laptop', slug: 'laptop', name: 'Laptop', isActive: true, attributeMode: 'dynamic' },
  'cat-color': { id: 'cat-color', slug: 'phu-kien', name: 'Phụ kiện', isActive: true, attributeMode: 'dynamic' },
  'cat-single': { id: 'cat-single', slug: 'gia-dung', name: 'Gia dụng', isActive: true, attributeMode: 'dynamic' },
  'cat-fashion': { id: 'cat-fashion', slug: 'ao-thun', name: 'Áo thun', isActive: true, attributeMode: 'legacy_fashion' },
  'cat-fashion2': { id: 'cat-fashion2', slug: 'quan-jean', name: 'Quần jean', isActive: true, attributeMode: 'legacy_fashion' },
  'cat-off': { id: 'cat-off', slug: 'ngung-ban', name: 'Ngừng bán', isActive: false, attributeMode: 'dynamic' },
  'cat-parent': { id: 'cat-parent', slug: 'dien-tu', name: 'Điện tử', isActive: true, attributeMode: 'dynamic' },
};
const TEMPLATES: Record<string, TplItem[]> = {
  'cat-phone': [
    { attributeId: 'attr-storage', required: true, isVariantAxis: true, inputType: 'select' },
    { attributeId: 'attr-color', required: true, isVariantAxis: true, inputType: 'select' },
    { attributeId: 'attr-origin', required: true, isVariantAxis: false, inputType: 'select' },
    { attributeId: 'attr-warranty', required: false, isVariantAxis: false, inputType: 'number' },
    { attributeId: 'attr-note', required: false, isVariantAxis: false, inputType: 'text' },
  ],
  'cat-phone2': [
    { attributeId: 'attr-storage', required: true, isVariantAxis: true, inputType: 'select' },
    { attributeId: 'attr-color', required: true, isVariantAxis: true, inputType: 'select' },
    { attributeId: 'attr-note', required: false, isVariantAxis: false, inputType: 'text' },
  ],
  'cat-laptop': [{ attributeId: 'attr-ram', required: true, isVariantAxis: true, inputType: 'select' }],
  'cat-color': [{ attributeId: 'attr-color', required: true, isVariantAxis: true, inputType: 'select' }],
  'cat-single': [{ attributeId: 'attr-origin', required: true, isVariantAxis: false, inputType: 'select' }],
  'cat-off': [],
};
const ATTR_NAMES: Record<string, string> = {
  'attr-storage': 'Dung lượng',
  'attr-color': 'Màu sắc',
  'attr-origin': 'Xuất xứ',
  'attr-warranty': 'Bảo hành (tháng)',
  'attr-note': 'Ghi chú',
  'attr-ram': 'RAM',
};
const VALUES: Record<string, { attributeId: string; value: string }> = {
  'val-128': { attributeId: 'attr-storage', value: '128GB' },
  'val-256': { attributeId: 'attr-storage', value: '256GB' },
  'val-den': { attributeId: 'attr-color', value: 'Đen' },
  'val-trang': { attributeId: 'attr-color', value: 'Trắng' },
  'val-den2': { attributeId: 'attr-color', value: 'den' },
  'val-den3': { attributeId: 'attr-color', value: 'DEN' },
  'val-den4': { attributeId: 'attr-color', value: 'đen' },
  'val-den5': { attributeId: 'attr-color', value: 'Đen.' },
  'val-den6': { attributeId: 'attr-color', value: 'Đen!' },
  'val-vn': { attributeId: 'attr-origin', value: 'Việt Nam' },
  'val-cn': { attributeId: 'attr-origin', value: 'Trung Quốc' },
  'val-8gb': { attributeId: 'attr-ram', value: '8GB' },
};

// ---------------------------------------------------------------- dựng service

const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'vendor', permissionVersion: 1, tokenId: 't1' };
const SHOP_A = 'shop-a';
const SHOP_B = 'shop-b';

function build() {
  const state: State = { products: [], variants: [], draftRefs: [], seq: 0 };
  const repo = new FakeRepo(state);

  // Transaction thật sự: lỗi giữa chừng → trả state về trước transaction (như ROLLBACK).
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = JSON.stringify(state);
      try {
        return await fn({});
      } catch (e) {
        const restored = JSON.parse(snapshot) as State;
        state.products = restored.products;
        state.variants = restored.variants;
        state.draftRefs = restored.draftRefs;
        state.seq = restored.seq;
        throw e;
      }
    },
  };

  const catalog = {
    findCategoryById: jest.fn((id: string) => Promise.resolve(CATS[id] ?? null)),
    // 'cat-parent' là ngành cha (có ngành con) — chỉ ngành lá mới gán được sản phẩm
    categoryHasChildren: jest.fn((id: string) => Promise.resolve(id === 'cat-parent')),
    getCategoryAttributeTemplate: jest.fn((id: string) => Promise.resolve(TEMPLATES[id] ?? [])),
    findDynamicAttributeValuesByIds: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.filter((i) => VALUES[i]).map((i) => [i, { id: i, ...VALUES[i] }])))),
    findDynamicAttributeNamesByIds: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.filter((i) => ATTR_NAMES[i]).map((i) => [i, { id: i, code: i, name: ATTR_NAMES[i] }])))),
    colorMap: jest.fn(() =>
      Promise.resolve(
        new Map([
          ['den', { code: 'den', name: 'Đen', hex: '#000' }],
          ['trang', { code: 'trang', name: 'Trắng', hex: '#fff' }],
        ]),
      ),
    ),
    sizeMap: jest.fn(() =>
      Promise.resolve(
        new Map([
          ['S', { code: 'S', name: 'S', groupCode: null, sortOrder: 1 }],
          ['M', { code: 'M', name: 'M', groupCode: null, sortOrder: 2 }],
        ]),
      ),
    ),
  };
  const auditWrite = jest.fn((..._args: unknown[]) => Promise.resolve());
  const audit = { write: auditWrite };
  const outbox = { publish: jest.fn(() => Promise.resolve()) };
  const query = { invalidateAll: jest.fn(() => Promise.resolve()) };
  const shops = { findOfficialShopId: jest.fn(() => Promise.resolve('shop-official')) };
  const stats = { adjustProductCount: jest.fn(() => Promise.resolve()) };

  const service = new ProductService(
    prisma as unknown as PrismaService,
    repo as unknown as ProductRepository,
    query as unknown as ProductQueryService,
    catalog as unknown as CatalogQueryApi,
    audit as unknown as ProductAuditLogService,
    outbox as unknown as ProductOutboxService,
    shops as unknown as ShopQueryApi,
    stats,
  );
  return { service, state, repo, catalog, auditWrite, outbox, stats };
}

async function catchBusiness(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessException);
    return e as BusinessException;
  }
  throw new Error('Mong đợi BusinessException nhưng promise resolve');
}

const opt = (attributeId: string, attributeValueId: string) => ({ attributeId, attributeValueId });
const phoneV = (storage: string, color: string, extra: Partial<VariantSpec> = {}): VariantSpec => ({ options: [opt('attr-storage', storage), opt('attr-color', color)], ...extra });
const live = (s: State, productId?: string) => s.variants.filter((v) => !v.isDeleted && (productId === undefined || v.productId === productId));

const PHONE = { name: 'iPhone 15 Pro', categoryId: 'cat-phone', basePrice: '25000000' };
const FASHION = { name: 'Áo thun basic', categoryId: 'cat-fashion', basePrice: '159000', gender: 'nam', material: '100% cotton', care: ['Giặt máy'] };

describe('ProductService (ghi sản phẩm)', () => {
  // ------------------------------------------------------------ C2 — lưu biến thể dynamic không mất dữ liệu
  describe('C2 — saveVariants dynamic: cập nhật tại chỗ, không xoá-tạo-lại', () => {
    it('tạo sản phẩm kèm 2 biến thể: SKU sinh deterministic <tiền tố slug>-<giá trị trục>, tồn đầu 0', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);
      expect(p.slug).toBe('iphone-15-pro');
      expect(live(state).map((v) => [v.sku, v.stock, v.reserved])).toEqual([
        ['IPHONE15PRO-128GB-DEN', 0, 0],
        ['IPHONE15PRO-256GB-DEN', 0, 0],
      ]);
      expect(live(state)[0].options.map((o) => o.displayValue)).toEqual(['128GB', 'Đen']);
    });

    it('lưu LẠI hai lần liên tiếp: giữ nguyên id, SKU, tồn kho và hàng đang giữ; không tạo thêm dòng nào', async () => {
      const { service, state } = build();
      const list = [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')];
      const p = await service.createShop(actor, SHOP_A, PHONE, list);
      // Giả lập đã nhập kho + có đơn đang giữ hàng
      live(state)[0].stock = 7;
      live(state)[0].reserved = 2;
      live(state)[1].stock = 30;
      const before = live(state).map((v) => ({ id: v.id, sku: v.sku, stock: v.stock, reserved: v.reserved }));

      await service.saveVariantsShop(actor, SHOP_A, p.id, list);
      await service.saveVariantsShop(actor, SHOP_A, p.id, list);

      expect(state.variants).toHaveLength(2); // không có biến thể mới, không có bản xoá mềm
      expect(live(state).map((v) => ({ id: v.id, sku: v.sku, stock: v.stock, reserved: v.reserved }))).toEqual(before);
    });

    it('lưu lại sản phẩm đã có SKU kiểu cũ (P-000, P-001), vendor không nhập sku: giữ nguyên SKU cũ, KHÔNG 409 trùng P-002', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);
      live(state)[0].sku = 'IPHONE1-000';
      live(state)[1].sku = 'IPHONE1-001';
      const ids = live(state).map((v) => v.id);

      await service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);

      expect(live(state).map((v) => [v.id, v.sku])).toEqual([
        [ids[0], 'IPHONE1-000'],
        [ids[1], 'IPHONE1-001'],
      ]);
    });

    it('thứ tự options trong body không ảnh hưởng việc khớp biến thể cũ', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
      const id = live(state)[0].id;
      await service.saveVariantsShop(actor, SHOP_A, p.id, [{ options: [opt('attr-color', 'val-den'), opt('attr-storage', 'val-128')] }]);
      expect(live(state).map((v) => v.id)).toEqual([id]);
    });

    it('đổi danh sách: tổ hợp còn lại giữ id; tổ hợp mới được tạo; tổ hợp bỏ đi bị xoá mềm (dòng còn, tồn kho còn)', async () => {
      const { service, state, auditWrite } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);
      const [v128, v256] = live(state).map((v) => v.id);
      state.variants[0].stock = 9;
      state.variants[1].stock = 4;

      await service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-256', 'val-den', { price: '26000000' }), phoneV('val-256', 'val-trang')]);

      const kept = state.variants.find((v) => v.id === v256)!;
      expect(kept.isDeleted).toBe(false);
      expect(kept.stock).toBe(4);
      expect(kept.price).toBe('26000000');
      const removed = state.variants.find((v) => v.id === v128)!;
      expect(removed.isDeleted).toBe(true);
      expect(removed.stock).toBe(9); // không mất số liệu của biến thể đã gỡ
      const created = live(state).find((v) => v.id !== v256)!;
      expect(created.sku).toBe('IPHONE15PRO-256GB-TRANG');
      expect(created.stock).toBe(0);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        actor,
        expect.objectContaining({ action: PRODUCT_AUDIT.VARIANTS_SAVED, after: expect.objectContaining({ created: 1, updated: 1, removed: ['IPHONE15PRO-128GB-DEN'] }) as unknown }),
      );
    });

    it('gỡ biến thể đang giữ hàng cho đơn (reserved > 0): 409 PRODUCT_VARIANT_IN_USE kèm SKU, KHÔNG thay đổi gì', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);
      state.variants[0].stock = 5;
      state.variants[0].reserved = 1;
      const snapshot = JSON.stringify(state.variants);

      const e = await catchBusiness(service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-256', 'val-den'), phoneV('val-256', 'val-trang')]));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.errorCode).toBe(PRODUCT_ERR.VARIANT_IN_USE);
      expect(e.message).toContain('IPHONE15PRO-128GB-DEN');
      expect(e.details.sku).toBe('IPHONE15PRO-128GB-DEN');
      expect(JSON.stringify(state.variants)).toBe(snapshot);
    });

    it('gỡ biến thể đang nằm trong phiếu nhập NHÁP: 409 PRODUCT_VARIANT_IN_USE kèm mã phiếu', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')]);
      state.draftRefs.push({ variantId: state.variants[0].id, code: 'PN-0001' });

      const e = await catchBusiness(service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-256', 'val-den')]));

      expect(e.errorCode).toBe(PRODUCT_ERR.VARIANT_IN_USE);
      expect(e.details.receiptCode).toBe('PN-0001');
      expect(live(state)).toHaveLength(2);
    });

    it('SKU của biến thể vừa gỡ dùng lại được ngay trong cùng lượt lưu', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den', { sku: 'SKU-X' })]);
      await service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-256', 'val-den', { sku: 'sku-x' })]);
      expect(live(state).map((v) => v.sku)).toEqual(['SKU-X']);
    });

    it('ngành không có trục biến thể: đúng MỘT biến thể không options, lưu lại giữ id', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, { name: 'Nồi chiên', categoryId: 'cat-single', basePrice: '900000' }, [{}]);
      expect(live(state).map((v) => v.sku)).toEqual(['NOICHIEN-V1']);
      const id = live(state)[0].id;
      await service.saveVariantsShop(actor, SHOP_A, p.id, [{ price: '950000' }]);
      expect(live(state).map((v) => [v.id, v.price])).toEqual([[id, '950000']]);
      await expect(service.saveVariantsShop(actor, SHOP_A, p.id, [{}, {}])).rejects.toThrow(BusinessException);
    });

    it('trục sai bộ / lặp trục / giá trị không thuộc thuộc tính / tổ hợp lặp → lỗi nghiệp vụ, không ghi', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
      const bad: VariantSpec[][] = [
        [{ options: [opt('attr-storage', 'val-128')] }], // thiếu trục màu
        [{ options: [opt('attr-storage', 'val-128'), opt('attr-storage', 'val-256')] }], // lặp trục
        [{ options: [opt('attr-storage', 'val-den'), opt('attr-color', 'val-den')] }], // val-den không thuộc attr-storage
        [phoneV('val-128', 'val-den'), phoneV('val-128', 'val-den')], // tổ hợp lặp
        [{}], // thiếu options
      ];
      for (const list of bad) await expect(service.saveVariantsShop(actor, SHOP_A, p.id, list)).rejects.toBeInstanceOf(BusinessException);
      expect(live(state)).toHaveLength(1);
    });

    it('vendor shop khác không lưu được biến thể (404)', async () => {
      const { service } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
      await expect(service.saveVariantsShop(actor, SHOP_B, p.id, [phoneV('val-256', 'val-den')])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ------------------------------------------------------------ C2 — sinh SKU
  describe('C2 — SKU: ưu tiên vendor nhập, sinh deterministic, chống trùng trong lượt lưu lẫn DB', () => {
    it('SKU vendor nhập được dùng (chuẩn hoá in hoa) cho cả ngành dynamic', async () => {
      const { service, state } = build();
      await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den', { sku: 'ip15-128-den' })]);
      expect(live(state).map((v) => v.sku)).toEqual(['IP15-128-DEN']);
    });

    it('SKU vendor nhập trùng nhau trong CÙNG lượt lưu (kể cả khác hoa/thường) → 409 PRODUCT_SKU_EXISTS', async () => {
      const { service } = build();
      const e = await catchBusiness(service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den', { sku: 'x1' }), phoneV('val-256', 'val-den', { sku: 'X1' })]));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.errorCode).toBe(PRODUCT_ERR.SKU_EXISTS);
    });

    it('SKU trùng sản phẩm khác CỦA CÙNG shop → 409 "trong gian hàng của bạn", không lộ tên sản phẩm; shop khác được trùng', async () => {
      const { service } = build();
      await service.createShop(actor, SHOP_A, { ...PHONE, name: 'Sản phẩm bí mật' }, [phoneV('val-128', 'val-den', { sku: 'DUNG-CHUNG' })]);
      const e = await catchBusiness(service.createShop(actor, SHOP_A, { ...PHONE, name: 'Cái khác' }, [phoneV('val-128', 'val-den', { sku: 'dung-chung' })]));
      expect(e.errorCode).toBe(PRODUCT_ERR.SKU_EXISTS);
      expect(e.message).toBe("Mã SKU 'DUNG-CHUNG' đã tồn tại trong gian hàng của bạn");
      expect(e.message).not.toContain('bí mật');
      // H9: shop B dùng cùng SKU thoải mái
      await expect(service.createShop(actor, SHOP_B, { ...PHONE, name: 'Của shop B' }, [phoneV('val-128', 'val-den', { sku: 'DUNG-CHUNG' })])).resolves.toBeDefined();
    });

    it('từ 6 biến thể trở lên, nhãn trục slug hoá giống nhau: SKU sinh vẫn duy nhất (-2, -3…), không bị cắt ở 5 lần thử', async () => {
      const { service, state } = build();
      const colors = ['val-den', 'val-den2', 'val-den3', 'val-den4', 'val-den5', 'val-den6'];
      await service.createShop(actor, SHOP_A, { name: 'Ốp lưng', categoryId: 'cat-color', basePrice: '99000' }, colors.map((c) => ({ options: [opt('attr-color', c)] })));
      const skus = live(state).map((v) => v.sku);
      expect(new Set(skus).size).toBe(6);
      expect(skus).toEqual(['OPLUNG-DEN', 'OPLUNG-DEN-2', 'OPLUNG-DEN-3', 'OPLUNG-DEN-4', 'OPLUNG-DEN-5', 'OPLUNG-DEN-6']);
    });

    it('prefix slug trùng sản phẩm khác (iphone-15-pro vs iphone-15-pro-max): cả hai tạo được, SKU không đụng nhau', async () => {
      const { service, state } = build();
      const list = [phoneV('val-128', 'val-den'), phoneV('val-256', 'val-den')];
      await service.createShop(actor, SHOP_A, PHONE, list);
      await service.createShop(actor, SHOP_A, { ...PHONE, name: 'iPhone 15 Pro Max' }, list);
      const skus = live(state).map((v) => v.sku);
      expect(new Set(skus).size).toBe(4);
    });

    it('SKU sinh đụng SKU đang sống của sản phẩm khác trong shop → tự thêm hậu tố, KHÔNG 409', async () => {
      const { service, state } = build();
      await service.createShop(actor, SHOP_A, { ...PHONE, slug: 'ip-a' }, [phoneV('val-128', 'val-den', { sku: 'IPHONE15PRO-128GB-DEN' })]);
      await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
      expect(live(state).map((v) => v.sku)).toEqual(['IPHONE15PRO-128GB-DEN', 'IPHONE15PRO-128GB-DEN-2']);
    });
  });

  describe('C2 — nhánh legacy (thời trang) cũng giữ id/tồn kho và kiểm SKU theo shop', () => {
    const legacy = (color: string, size: string, extra: Partial<VariantSpec> = {}): VariantSpec => ({ colorCode: color, sizeCode: size, ...extra });

    it('lưu lại giữ id + tồn kho + SKU; gỡ biến thể còn hàng giữ → 409; bỏ trống sku → giữ SKU cũ dù slug đổi', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, FASHION, [legacy('den', 'M'), legacy('den', 'S')]);
      expect(live(state)[0].sku).toBe(makeSku('ao-thun-basic', 'den', 'M'));
      state.variants[0].stock = 11;
      const ids = live(state).map((v) => v.id);

      // slug đổi → makeSku sẽ cho giá trị khác; biến thể cũ vẫn phải giữ SKU hiện có
      state.products[0].slug = 'ao-thun-basic-moi';
      await service.saveVariantsShop(actor, SHOP_A, p.id, [legacy('den', 'M'), legacy('den', 'S')]);
      expect(live(state).map((v) => v.id)).toEqual(ids);
      expect(live(state)[0].sku).toBe(makeSku('ao-thun-basic', 'den', 'M'));
      expect(live(state)[0].stock).toBe(11);

      state.variants[1].reserved = 3;
      const e = await catchBusiness(service.saveVariantsShop(actor, SHOP_A, p.id, [legacy('den', 'M')]));
      expect(e.errorCode).toBe(PRODUCT_ERR.VARIANT_IN_USE);
      await service.saveVariantsShop(actor, SHOP_A, p.id, [legacy('den', 'M'), legacy('den', 'S'), legacy('trang', 'M')]);
      expect(live(state)).toHaveLength(3);
    });

    it('SKU nhập tay trùng sản phẩm khác cùng shop → 409; shop khác được trùng; tạo mới cũng được kiểm (trước đây không)', async () => {
      const { service } = build();
      await service.createShop(actor, SHOP_A, FASHION, [legacy('den', 'M', { sku: 'AT-DEN-M' })]);
      const e = await catchBusiness(service.createShop(actor, SHOP_A, { ...FASHION, name: 'Áo thun khác' }, [legacy('den', 'M', { sku: 'at-den-m' })]));
      expect(e.errorCode).toBe(PRODUCT_ERR.SKU_EXISTS);
      expect(e.message).toContain('trong gian hàng của bạn');
      await expect(service.createShop(actor, SHOP_B, FASHION, [legacy('den', 'M', { sku: 'AT-DEN-M' })])).resolves.toBeDefined();
    });

    it('thiếu colorCode/sizeCode → lỗi rõ ràng thay vì "Mã màu undefined"; SKU trùng trong lượt lưu → 409', async () => {
      const { service } = build();
      const e = await catchBusiness(service.createShop(actor, SHOP_A, FASHION, [{ options: [opt('attr-color', 'val-den')] }]));
      expect(e.message).toContain('colorCode và sizeCode');
      const dup = await catchBusiness(service.createShop(actor, SHOP_A, { ...FASHION, name: 'Áo B' }, [legacy('den', 'M', { sku: 'Z1' }), legacy('den', 'S', { sku: 'z1' })]));
      expect(dup.errorCode).toBe(PRODUCT_ERR.SKU_EXISTS);
    });

    it('admin /admin/products lưu biến thể cũng kiểm SKU theo shop của sản phẩm (không còn kiểm toàn sàn)', async () => {
      const { service, state } = build();
      await service.createShop(actor, SHOP_B, FASHION, [legacy('den', 'M', { sku: 'CUA-SHOP-B' })]);
      const p = await service.create(actor, { ...FASHION, name: 'Áo của sàn' }, []);
      await service.saveVariants(actor, p.id, [legacy('den', 'M', { sku: 'CUA-SHOP-B' })]);
      expect(live(state).map((v) => [v.shopId, v.sku])).toEqual([
        [SHOP_B, 'CUA-SHOP-B'],
        ['shop-official', 'CUA-SHOP-B'],
      ]);
    });
  });

  // ------------------------------------------------------------ M5
  describe('M5 — giá riêng của biến thể phải > 0', () => {
    it.each(['0', '-5', '0.4'])('dynamic: price "%s" bị từ chối khi tạo và khi lưu biến thể', async (price) => {
      const { service, state } = build();
      await expect(service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den', { price })])).rejects.toThrow('Giá riêng của biến thể phải lớn hơn 0');
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
      await expect(service.saveVariantsShop(actor, SHOP_A, p.id, [phoneV('val-128', 'val-den', { price })])).rejects.toThrow('Giá riêng của biến thể phải lớn hơn 0');
      expect(live(state)[0].price).toBeNull();
    });

    it('legacy: price 0 bị từ chối; bỏ trống/null = theo giá sản phẩm; số quá lớn bị chặn', async () => {
      const { service, state } = build();
      await expect(service.createShop(actor, SHOP_A, FASHION, [{ colorCode: 'den', sizeCode: 'M', price: '0' }])).rejects.toThrow('lớn hơn 0');
      await service.createShop(actor, SHOP_A, FASHION, [{ colorCode: 'den', sizeCode: 'M', price: null }, { colorCode: 'den', sizeCode: 'S', price: '' }]);
      expect(live(state).map((v) => v.price)).toEqual([null, null]);
      await expect(service.createShop(actor, SHOP_A, { ...FASHION, name: 'Áo C' }, [{ colorCode: 'den', sizeCode: 'M', price: '1000000000000000' }])).rejects.toThrow('vượt giới hạn');
    });
  });

  // ------------------------------------------------------------ M6
  describe('M6 — vendor không tự đặt isFeatured / isNew / tags', () => {
    it('createShop bỏ qua các trường này dù được truyền vào; admin create vẫn nhận', async () => {
      const { service, state } = build();
      await service.createShop(actor, SHOP_A, { ...PHONE, isFeatured: true, isNew: true, tags: ['new'] });
      expect(state.products[0]).toMatchObject({ isFeatured: false, isNew: false, tags: [] });
      await service.create(actor, { ...PHONE, name: 'Hàng của sàn', isFeatured: true, isNew: true, tags: ['new'] });
      expect(state.products[1]).toMatchObject({ isFeatured: true, isNew: true, tags: ['new'] });
    });

    it('updateShop không đổi được các trường này; patch chỉ gồm chúng = không ghi gì', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE);
      const version = state.products[0].version;
      await service.updateShop(actor, SHOP_A, p.id, { isFeatured: true, isNew: true, tags: ['x'] });
      expect(state.products[0]).toMatchObject({ isFeatured: false, isNew: false, tags: [], version });
      await service.updateShop(actor, SHOP_A, p.id, { name: 'Tên mới', isFeatured: true });
      expect(state.products[0]).toMatchObject({ name: 'Tên mới', isFeatured: false });
    });
  });

  // ------------------------------------------------------------ M7
  describe('M7 — chỉ gán ngành tồn tại, đang bật và là ngành lá', () => {
    it('ngành cha (có ngành con) không gán được cho sản phẩm — cả khi tạo lẫn khi đổi ngành', async () => {
      const { service } = build();
      const create = await catchBusiness(service.createShop(actor, SHOP_A, { ...PHONE, categoryId: 'cat-parent' }));
      expect(create.errorCode).toBe(PRODUCT_ERR.CATEGORY_INVALID);
      expect(create.message).toContain('cấp cuối');
      const p = await service.createShop(actor, SHOP_A, PHONE);
      const update = await catchBusiness(service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-parent' }));
      expect(update.errorCode).toBe(PRODUCT_ERR.CATEGORY_INVALID);
    });

    it('create: ngành không tồn tại / đang tắt → PRODUCT_CATEGORY_INVALID', async () => {
      const { service } = build();
      expect((await catchBusiness(service.createShop(actor, SHOP_A, { ...PHONE, categoryId: 'khong-co' }))).errorCode).toBe(PRODUCT_ERR.CATEGORY_INVALID);
      const off = await catchBusiness(service.createShop(actor, SHOP_A, { ...PHONE, categoryId: 'cat-off' }));
      expect(off.errorCode).toBe(PRODUCT_ERR.CATEGORY_INVALID);
      expect(off.message).toContain('đang tắt');
    });

    it('update: đổi sang ngành đang tắt bị từ chối; không đổi ngành thì không kiểm lại', async () => {
      const { service } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE);
      const e = await catchBusiness(service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-off' }));
      expect(e.errorCode).toBe(PRODUCT_ERR.CATEGORY_INVALID);
      await expect(service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-phone', name: 'Tên khác' })).resolves.toBeDefined();
    });
  });

  // ------------------------------------------------------------ H3
  describe('H3 — thuộc tính cấp sản phẩm (ngành dynamic)', () => {
    const create = (attributeValues: Array<{ attributeId: string; attributeValueId?: string; customValue?: string }>) => {
      const ctx = build();
      return { ...ctx, run: () => ctx.service.createShop(actor, SHOP_A, { ...PHONE, attributeValues }) };
    };

    it('hợp lệ: select + number + text được ghi, customValue trim', async () => {
      const { run, state } = create([
        { attributeId: 'attr-origin', attributeValueId: 'val-vn' },
        { attributeId: 'attr-warranty', customValue: ' 12 ' },
        { attributeId: 'attr-note', customValue: 'Hàng chính hãng' },
      ]);
      await run();
      expect(state.products[0].attributes.map((a) => [a.attributeId, a.attributeValueId, a.customValue])).toEqual([
        ['attr-origin', 'val-vn', null],
        ['attr-warranty', null, '12'],
        ['attr-note', null, 'Hàng chính hãng'],
      ]);
    });

    it.each([
      ['attributeId ngoài mẫu của ngành', [{ attributeId: 'attr-ram', attributeValueId: 'val-8gb' }], 'không thuộc mẫu thuộc tính'],
      ['attributeId trùng', [{ attributeId: 'attr-note', customValue: 'a' }, { attributeId: 'attr-note', customValue: 'b' }], 'bị lặp'],
      ['trục biến thể khai ở cấp sản phẩm', [{ attributeId: 'attr-color', attributeValueId: 'val-den' }], 'trục biến thể'],
      ['attributeValueId không thuộc thuộc tính', [{ attributeId: 'attr-origin', attributeValueId: 'val-128' }], 'không thuộc thuộc tính'],
      ['attributeValueId không tồn tại', [{ attributeId: 'attr-origin', attributeValueId: 'ma-la' }], 'không thuộc thuộc tính'],
      ['cả valueId lẫn customValue rỗng', [{ attributeId: 'attr-note' }], 'thiếu giá trị'],
      ['customValue toàn khoảng trắng', [{ attributeId: 'attr-note', customValue: '   ' }], 'thiếu giá trị'],
      ['có cả valueId lẫn customValue', [{ attributeId: 'attr-origin', attributeValueId: 'val-vn', customValue: 'x' }], 'MỘT trong hai'],
      ['number nhưng không phải số', [{ attributeId: 'attr-warranty', customValue: '12 tháng' }], 'số hợp lệ'],
      ['select nhưng nhập tay', [{ attributeId: 'attr-origin', customValue: 'Việt Nam' }], 'chọn một giá trị có sẵn'],
      ['text/number mà chọn giá trị có sẵn', [{ attributeId: 'attr-note', attributeValueId: 'val-vn' }], 'nhập tay'],
      ['number mà chọn giá trị có sẵn', [{ attributeId: 'attr-warranty', attributeValueId: 'val-vn' }], 'nhập tay'],
      ['text dài quá 255 ký tự', [{ attributeId: 'attr-note', customValue: 'a'.repeat(256) }], 'quá dài'],
    ])('tạo sản phẩm: %s → PRODUCT_ATTRIBUTE_INVALID, không tạo gì', async (_label, values, msg) => {
      const { run, state } = create(values);
      const e = await catchBusiness(run());
      expect(e.errorCode).toBe(PRODUCT_ERR.ATTRIBUTE_INVALID);
      expect(e.message).toContain(msg);
      expect(state.products).toHaveLength(0);
    });

    it('lỗi nêu TÊN thuộc tính (không phải uuid) để vendor đọc được', async () => {
      const { run } = create([{ attributeId: 'attr-warranty', customValue: 'abc' }]);
      expect((await catchBusiness(run())).message).toContain('Bảo hành (tháng)');
    });

    it('mọi nhánh kiểm theo inputType đều nêu tên thuộc tính', async () => {
      const cases: Array<[string, Array<{ attributeId: string; attributeValueId?: string; customValue?: string }>]> = [
        ['Xuất xứ', [{ attributeId: 'attr-origin', customValue: 'Việt Nam' }]], // select + nhập tay
        ['Xuất xứ', [{ attributeId: 'attr-origin', attributeValueId: 'val-128' }]], // select + giá trị của thuộc tính khác
        ['Bảo hành (tháng)', [{ attributeId: 'attr-warranty', attributeValueId: 'val-vn' }]], // number + chọn sẵn
        ['Bảo hành (tháng)', [{ attributeId: 'attr-warranty', customValue: 'NaN' }]], // number sai
        ['Ghi chú', [{ attributeId: 'attr-note', attributeValueId: 'val-vn' }]], // text + chọn sẵn
        ['Ghi chú', [{ attributeId: 'attr-note', customValue: 'a'.repeat(256) }]], // text quá dài
      ];
      for (const [name, values] of cases) {
        const e = await catchBusiness(create(values).run());
        expect(e.errorCode).toBe(PRODUCT_ERR.ATTRIBUTE_INVALID);
        expect(e.message).toContain(name);
      }
    });

    describe('number: số hợp lệ, chấp nhận số thập phân nhỏ', () => {
      it.each(['0', '12', '-3', '0.5', '12.5', '6.123456', ' 24 ', '999999999999999'])('nhận %j', async (customValue) => {
        const { run, state } = create([{ attributeId: 'attr-warranty', customValue }]);
        await run();
        expect(state.products[0].attributes[0]).toMatchObject({ attributeId: 'attr-warranty', attributeValueId: null, customValue: customValue.trim() });
      });

      it.each(['NaN', 'Infinity', '-Infinity', '1e5', '0x10', '1,5', '1.', '.5', '--1', '1.1234567', '1234567890123456', '9'.repeat(400), '12 tháng', '٣'])('từ chối %j', async (customValue) => {
        const { run, state } = create([{ attributeId: 'attr-warranty', customValue }]);
        const e = await catchBusiness(run());
        expect(e.errorCode).toBe(PRODUCT_ERR.ATTRIBUTE_INVALID);
        expect(e.message).toContain('số hợp lệ');
        expect(state.products).toHaveLength(0);
      });
    });

    it('text: nhận đúng 255 ký tự (khớp VarChar(255)), trim hai đầu', async () => {
      const { run, state } = create([{ attributeId: 'attr-note', customValue: `  ${'a'.repeat(255)}  ` }]);
      await run();
      expect(state.products[0].attributes[0].customValue).toHaveLength(255);
    });

    it('PUT attributes cũng kiểm theo inputType (không chỉ lúc tạo)', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE);
      await expect(service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-warranty', customValue: 'Infinity' }])).rejects.toMatchObject({ errorCode: PRODUCT_ERR.ATTRIBUTE_INVALID });
      await expect(service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-note', attributeValueId: 'val-vn' }])).rejects.toMatchObject({ errorCode: PRODUCT_ERR.ATTRIBUTE_INVALID });
      await expect(service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-origin', customValue: 'Việt Nam' }])).rejects.toMatchObject({ errorCode: PRODUCT_ERR.ATTRIBUTE_INVALID });
      expect(state.products[0].attributes).toHaveLength(0);
    });

    it('ngành thời trang không nhận thuộc tính động', async () => {
      const { service } = build();
      const e = await catchBusiness(service.createShop(actor, SHOP_A, { ...FASHION, attributeValues: [{ attributeId: 'attr-note', customValue: 'x' }] }));
      expect(e.errorCode).toBe(PRODUCT_ERR.ATTRIBUTE_INVALID);
    });

    it('PUT attributes: thay toàn bộ giá trị, audit, shop khác 404', async () => {
      const { service, state, auditWrite } = build();
      const p = await service.createShop(actor, SHOP_A, { ...PHONE, attributeValues: [{ attributeId: 'attr-origin', attributeValueId: 'val-vn' }] });
      await service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-origin', attributeValueId: 'val-cn' }, { attributeId: 'attr-warranty', customValue: '24' }]);
      expect(state.products[0].attributes.map((a) => [a.attributeId, a.attributeValueId, a.customValue])).toEqual([
        ['attr-origin', 'val-cn', null],
        ['attr-warranty', null, '24'],
      ]);
      expect(auditWrite).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({ action: PRODUCT_AUDIT.ATTRIBUTES_SAVED }));
      await expect(service.saveAttributesShop(actor, SHOP_B, p.id, [])).rejects.toBeInstanceOf(NotFoundException);
      // sai mẫu thì không ghi
      await expect(service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-ram', attributeValueId: 'val-8gb' }])).rejects.toBeInstanceOf(BusinessException);
      expect(state.products[0].attributes).toHaveLength(2);
    });

    it('PUT attributes trên ngành thời trang → lỗi; admin saveAttributes dùng chung lõi', async () => {
      const { service, state } = build();
      const f = await service.createShop(actor, SHOP_A, FASHION);
      await expect(service.saveAttributesShop(actor, SHOP_A, f.id, [])).rejects.toBeInstanceOf(BusinessException);
      const p = await service.create(actor, PHONE);
      await service.saveAttributes(actor, p.id, [{ attributeId: 'attr-note', customValue: 'ghi chú' }]);
      expect(state.products.find((x) => x.id === p.id)!.attributes).toHaveLength(1);
    });

    describe('publish đòi thuộc tính bắt buộc', () => {
      async function ready() {
        const ctx = build();
        const p = await ctx.service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
        ctx.state.products[0].images.push({ id: 'img1', url: 'u', publicId: null, colorCode: null, alt: null, sortOrder: 0, isPrimary: true });
        return { ...ctx, p };
      }

      it('thiếu thuộc tính required → PRODUCT_NOT_PUBLISHABLE nêu tên thuộc tính; đủ rồi → đăng được', async () => {
        const { service, state, stats, p } = await ready();
        const e = await catchBusiness(service.publishShop(actor, SHOP_A, p.id));
        expect(e.errorCode).toBe(PRODUCT_ERR.NOT_PUBLISHABLE);
        expect(e.message).toContain('Xuất xứ');
        expect(e.details.missingAttributes).toBe('Xuất xứ');
        expect(state.products[0].status).toBe('draft');

        await service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-origin', attributeValueId: 'val-vn' }]);
        await service.publishShop(actor, SHOP_A, p.id);
        expect(state.products[0].status).toBe('active');
        expect(stats.adjustProductCount).toHaveBeenCalledWith('cat-phone', 1, expect.anything());
      });

      it('sản phẩm ĐANG BÁN không được bỏ thuộc tính bắt buộc qua PUT attributes', async () => {
        const { service, p } = await ready();
        await service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-origin', attributeValueId: 'val-vn' }]);
        await service.publishShop(actor, SHOP_A, p.id);
        const e = await catchBusiness(service.saveAttributesShop(actor, SHOP_A, p.id, [{ attributeId: 'attr-note', customValue: 'x' }]));
        expect(e.errorCode).toBe(PRODUCT_ERR.ATTRIBUTE_REQUIRED);
      });
    });

    describe('đổi ngành', () => {
      it('đã có biến thể: đổi sang ngành khác bộ trục / khác kiểu (legacy) → 409 PRODUCT_CATEGORY_LOCKED', async () => {
        const { service, state } = build();
        const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den')]);
        for (const categoryId of ['cat-laptop', 'cat-fashion', 'cat-single']) {
          const e = await catchBusiness(service.updateShop(actor, SHOP_A, p.id, { categoryId }));
          expect(e).toBeInstanceOf(ConflictException);
          expect(e.errorCode).toBe(PRODUCT_ERR.CATEGORY_LOCKED);
        }
        expect(state.products[0].categoryId).toBe('cat-phone');
      });

      it('đã có biến thể: đổi sang ngành CÙNG bộ trục được, thuộc tính không còn trong mẫu mới bị dọn', async () => {
        const { service, state } = build();
        const p = await service.createShop(actor, SHOP_A, { ...PHONE, attributeValues: [{ attributeId: 'attr-origin', attributeValueId: 'val-vn' }, { attributeId: 'attr-note', customValue: 'giữ' }] }, [phoneV('val-128', 'val-den')]);
        await service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-phone2' });
        expect(state.products[0].categoryId).toBe('cat-phone2');
        expect(state.products[0].attributes.map((a) => a.attributeId)).toEqual(['attr-note']);
      });

      it('chưa có biến thể: đổi tự do, thuộc tính cũ bị dọn; sang thời trang thì đòi đủ giới tính/chất liệu/bảo quản', async () => {
        const { service, state } = build();
        const p = await service.createShop(actor, SHOP_A, { ...PHONE, attributeValues: [{ attributeId: 'attr-origin', attributeValueId: 'val-vn' }] });
        await service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-single' });
        expect(state.products[0].attributes.map((a) => a.attributeId)).toEqual(['attr-origin']); // vẫn thuộc mẫu cat-single
        await service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-laptop' });
        expect(state.products[0].attributes).toHaveLength(0);
        const e = await catchBusiness(service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-fashion' }));
        expect(e.message).toContain('chất liệu bắt buộc');
        await service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-fashion', gender: 'nu', material: 'Cotton', care: ['Giặt tay'] });
        expect(state.products[0].categoryId).toBe('cat-fashion');
      });

      it('thời trang → thời trang luôn được kể cả đã có biến thể; sản phẩm đang bán thì chỉnh product_count 2 ngành', async () => {
        const { service, state, stats } = build();
        const p = await service.createShop(actor, SHOP_A, FASHION, [{ colorCode: 'den', sizeCode: 'M' }]);
        state.products[0].status = 'active';
        await service.updateShop(actor, SHOP_A, p.id, { categoryId: 'cat-fashion2' });
        expect(state.products[0].categoryId).toBe('cat-fashion2');
        expect(stats.adjustProductCount).toHaveBeenNthCalledWith(1, 'cat-fashion', -1, expect.anything());
        expect(stats.adjustProductCount).toHaveBeenNthCalledWith(2, 'cat-fashion2', 1, expect.anything());
      });
    });
  });

  // ------------------------------------------------------------ slug
  describe('slug sản phẩm', () => {
    it('trùng tên chung giữa các shop → tự thêm -2, -3 thay vì 409', async () => {
      const { service } = build();
      const a = await service.createShop(actor, SHOP_A, { ...PHONE, name: 'Áo thun basic' });
      const b = await service.createShop(actor, SHOP_B, { ...PHONE, name: 'Áo thun basic' });
      const c = await service.createShop(actor, SHOP_A, { ...PHONE, name: 'ÁO THUN BASIC' });
      expect([a.slug, b.slug, c.slug]).toEqual(['ao-thun-basic', 'ao-thun-basic-2', 'ao-thun-basic-3']);
    });

    it('slug nhập tay trùng lúc tạo cũng được thêm hậu tố; slug 160 ký tự + hậu tố vẫn ≤ 160; tên toàn ký tự lạ có slug mặc định', async () => {
      const { service } = build();
      const long = 'a'.repeat(160);
      const a = await service.createShop(actor, SHOP_A, { ...PHONE, slug: long });
      const b = await service.createShop(actor, SHOP_A, { ...PHONE, slug: long });
      expect(a.slug).toBe(long);
      expect(b.slug).toHaveLength(160);
      expect(b.slug.endsWith('-2')).toBe(true);
      const c = await service.createShop(actor, SHOP_A, { ...PHONE, name: '日本語の名前' });
      expect(c.slug).toBe('san-pham');
    });

    it('tên dài ≥ 200 ký tự: slug sinh từ tên không vượt giới hạn', async () => {
      const { service } = build();
      const p = await service.createShop(actor, SHOP_A, { ...PHONE, name: 'tên rất dài '.repeat(17).slice(0, 200) });
      expect(p.slug.length).toBeLessThanOrEqual(160);
    });

    it('sửa slug thành slug đã dùng → 409 KHÔNG nêu sản phẩm/shop đang giữ slug', async () => {
      const { service } = build();
      await service.createShop(actor, SHOP_B, { ...PHONE, name: 'Hàng bí mật của B' });
      const mine = await service.createShop(actor, SHOP_A, { ...PHONE, name: 'Hàng của A' });
      const e = await catchBusiness(service.updateShop(actor, SHOP_A, mine.id, { slug: 'hang-bi-mat-cua-b' }));
      expect(e.errorCode).toBe(PRODUCT_ERR.SLUG_EXISTS);
      expect(e.message).not.toContain('hang-bi-mat');
      expect(e.message).not.toContain('bí mật');
    });
  });

  // ------------------------------------------------------------ ownership / xoá
  describe('quyền sở hữu theo shop', () => {
    it('vendor shop khác không đọc/sửa/đăng/ẩn/xoá được (404)', async () => {
      const { service } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE);
      await expect(service.getShop(SHOP_B, p.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateShop(actor, SHOP_B, p.id, { name: 'x y z' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.publishShop(actor, SHOP_B, p.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.hideShop(actor, SHOP_B, p.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.removeShop(actor, SHOP_B, p.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('xoá sản phẩm xoá mềm cả biến thể (SKU dùng lại được)', async () => {
      const { service, state } = build();
      const p = await service.createShop(actor, SHOP_A, PHONE, [phoneV('val-128', 'val-den', { sku: 'DUNG-LAI' })]);
      await service.removeShop(actor, SHOP_A, p.id);
      expect(live(state)).toHaveLength(0);
      await expect(service.createShop(actor, SHOP_A, { ...PHONE, name: 'Mới' }, [phoneV('val-128', 'val-den', { sku: 'DUNG-LAI' })])).resolves.toBeDefined();
    });
  });
});
