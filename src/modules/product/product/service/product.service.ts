import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { CATEGORY_STATS_GATEWAY, CategoryStatsGateway } from '@common/gateway/category-stats.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { makeSku, slugify } from '@common/utils/slug';
import { CatalogQueryApi, CategoryAttributeTemplateItem, CategoryBrief } from '../../../catalog/queryapi/catalog.queryapi';
import { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { PRODUCT_AUDIT, PRODUCT_ERR, PRODUCT_EVENT, PRODUCT_STATUS, ProductSort } from '../../foundation/product.constants';
import { ProductOutboxService } from '../../outbox/product-outbox.service';
import { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { ProductAdminResponse, ProductCardResponse } from '../dto/product.responses';
import { toProductAdmin, toProductCard } from '../mapper/product.mapper';
import { resolveAttributeLookup } from '../../queryapi/attribute-lookup';
import { ProductDetailRow, ProductRepository } from '../repository/product.repository';
import { ProductQueryService } from './product-query.service';

export interface VariantOptionInput {
  attributeId: string;
  attributeValueId: string;
}

export interface VariantSpec {
  colorCode?: string;
  sizeCode?: string;
  sku?: string;
  price?: string | null;
  isActive?: boolean;
  options?: VariantOptionInput[];
}

export interface AttributeValueInput {
  attributeId: string;
  attributeValueId?: string;
  customValue?: string;
}

export interface ProductWriteInput {
  name?: string;
  slug?: string;
  categoryId?: string;
  gender?: string;
  basePrice?: string;
  listPrice?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  material?: string | null;
  care?: string[];
  tags?: string[];
  isNew?: boolean;
  isFeatured?: boolean;
  attributeValues?: AttributeValueInput[];
}

const LEGACY_MODE = 'legacy_fashion';
/* numeric(14,0): vượt ngưỡng này là tràn cột → 500; chặn sớm bằng lỗi nghiệp vụ. */
const MAX_VND = 99_999_999_999_999n;
/* Khớp VarChar(160) của products.slug và VarChar(64) của product_variants.sku. */
const SLUG_MAX = 160;
const SKU_MAX = 64;
/* Lưu biến thể = nhiều câu lệnh trong MỘT transaction (tối đa 200 biến thể) — mặc định 5s của Prisma không đủ. */
const VARIANT_TX = { timeout: 20_000, maxWait: 5_000 } as const;

/* customValue lưu VarChar(255). Số nhập tay: ≤ 15 chữ số phần nguyên, ≤ 6 phần thập phân, dấu chấm (vd 0.5, 12, 6.7) — không NaN/Infinity/số mũ/dấu phẩy. */
const CUSTOM_VALUE_MAX = 255;
const NUMBER_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;
type ExistingVariant = ProductDetailRow['variants'][number];
type VariantOptionSnapshot = { attributeId: string; attributeValueId: string; displayValue: string };
type AttributeRow = { attributeId: string; attributeValueId: string | null; customValue: string | null };

/* Kế hoạch ghi biến thể dynamic: cập nhật tại chỗ (giữ id/tồn kho) · tạo mới (tổ hợp chưa có) · gỡ (không còn trong danh sách). */
interface DynamicVariantPlan {
  updates: Array<{ id: string; sku: string; price: bigint | null; isActive: boolean }>;
  creates: Array<{ sku: string; price: bigint | null; isActive: boolean; options: VariantOptionSnapshot[] }>;
  removed: ExistingVariant[];
}

/*
 * Ghi sản phẩm (khu quản trị + gian hàng): tạo/sửa/đăng bán/ẩn/xoá mềm + thay bộ biến thể + thuộc tính. Mọi hàm: transaction + audit;
 * đăng/ẩn/đổi ngành → CategoryStatsGateway (product_count) cùng transaction + outbox PRODUCT_* (ai nhúng lại, module khác).
 * Mỗi nghiệp vụ có MỘT lõi dùng chung; bản `/admin/products` và `/shop/products` chỉ khác ở việc có ép shopId hay không.
 *
 * Biến thể (thay TOÀN BỘ danh sách, PUT variants) — khớp biến thể HIỆN CÓ rồi cập nhật tại chỗ, không xoá-tạo-lại:
 * - ngành thời trang (legacy_fashion): khớp theo (màu, size); mã màu/size phải có trong catalog, chép tên/hex vào biến thể (snapshot);
 * - ngành dynamic: khớp theo tổ hợp (attributeId, attributeValueId) của các trục; displayValue chép snapshot.
 * Biến thể khớp giữ nguyên id, tồn kho, hàng đang giữ (đơn chưa hoàn tất, phiếu nhập nháp còn trỏ tới đúng id). Tổ hợp mới → biến thể mới
 * (tồn 0). Biến thể không còn trong danh sách → xoá mềm, trừ khi đang giữ hàng/nằm trong phiếu nhập nháp (409 PRODUCT_VARIANT_IN_USE).
 * SKU unique THEO GIAN HÀNG (index partial uq_product_variants_shop_sku_active) — hai shop được trùng SKU; vendor nhập SKU thì dùng
 * SKU đó (in hoa), bỏ trống thì biến thể cũ giữ SKU cũ, biến thể mới sinh `<tiền tố slug>-<giá trị các trục>` (+ hậu tố -2, -3… khi trùng).
 */
@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ProductRepository,
    private readonly query: ProductQueryService,
    private readonly catalog: CatalogQueryApi,
    private readonly audit: ProductAuditLogService,
    private readonly outbox: ProductOutboxService,
    private readonly shops: ShopQueryApi,
    @Inject(CATEGORY_STATS_GATEWAY) private readonly categoryStats: CategoryStatsGateway,
  ) {}

  // ---------------------------------------------------------------- /admin/products (nhân viên sàn)

  async listAdmin(p: { page: number; size: number; q?: string; category?: string; gender?: string; status?: string; sort?: string }): Promise<PageResponse<ProductCardResponse & { status: string }>> {
    const { items, total } = await this.repo.list({ publicOnly: false, q: p.q, categorySlug: p.category, gender: p.gender, status: p.status, sort: p.sort as ProductSort | undefined }, (p.page - 1) * p.size, p.size);
    // Quản trị cần biết sản phẩm thuộc gian hàng nào — resolve MỘT lần cho cả trang.
    const briefs = await this.shops.findManyBrief(items.map((r) => r.shopId));
    return PageResponse.of(
      items.map((r) => ({ ...toProductCard(r, briefs.get(r.shopId)), status: r.status })),
      p.page,
      p.size,
      total,
    );
  }

  async getAdmin(id: string): Promise<ProductAdminResponse> {
    return this.view(await this.loadOwned(id));
  }

  async create(actor: AuthenticatedActor | null, input: ProductWriteInput & { name: string; categoryId: string; basePrice: string }, variants: VariantSpec[] = []): Promise<ProductAdminResponse> {
    // Nhân viên sàn tạo sản phẩm qua /admin/products → luôn thuộc gian hàng chính chủ FITLY Official
    // (KHÔNG suy theo "shop approved đầu tiên" — dễ trỏ nhầm sang vendor thật được duyệt trước khi seed lại DB).
    const shopId = await this.shops.findOfficialShopId();
    if (!shopId) throw new BusinessException(PRODUCT_ERR.SHOP_NOT_CONFIGURED, 'Chưa khởi tạo gian hàng chính chủ FITLY Official — chạy seed shop trước');
    return this.createCore(actor, shopId, input, variants);
  }

  async update(actor: AuthenticatedActor, id: string, patch: ProductWriteInput): Promise<ProductAdminResponse> {
    return this.updateCore(actor, id, patch);
  }

  async saveVariants(actor: AuthenticatedActor | null, id: string, variants: VariantSpec[]): Promise<ProductAdminResponse> {
    return this.saveVariantsCore(actor, id, variants);
  }

  async saveAttributes(actor: AuthenticatedActor, id: string, values: AttributeValueInput[]): Promise<ProductAdminResponse> {
    return this.saveAttributesCore(actor, id, values);
  }

  async publish(actor: AuthenticatedActor | null, id: string): Promise<ProductAdminResponse> {
    return this.publishCore(actor, id);
  }

  async hide(actor: AuthenticatedActor, id: string): Promise<ProductAdminResponse> {
    return this.hideCore(actor, id);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    return this.removeCore(actor, id);
  }

  /* Worker gọi khi catalog đổi slug ngành hàng: cập nhật snapshot trên mọi sản phẩm của ngành. */
  async syncCategorySlug(categoryId: string, slug: string): Promise<number> {
    const n = await this.repo.updateCategorySlug(categoryId, slug);
    if (n > 0) await this.query.invalidateAll();
    return n;
  }

  // ---------------------------------------------------------------- /shop/products (vendor — PLAN-0014 bước 5)

  async listShop(p: { shopId: string; page: number; size: number; q?: string; category?: string; gender?: string; status?: string; sort?: string }): Promise<PageResponse<ProductCardResponse & { status: string }>> {
    const { items, total } = await this.repo.list({ publicOnly: false, q: p.q, categorySlug: p.category, gender: p.gender, status: p.status, sort: p.sort as ProductSort | undefined, shopId: p.shopId }, (p.page - 1) * p.size, p.size);
    return PageResponse.of(
      items.map((r) => ({ ...toProductCard(r), status: r.status })),
      p.page,
      p.size,
      total,
    );
  }

  async getShop(shopId: string, id: string): Promise<ProductAdminResponse> {
    return this.view(await this.loadOwned(id, shopId));
  }

  async createShop(actor: AuthenticatedActor | null, shopId: string, input: ProductWriteInput & { name: string; categoryId: string; basePrice: string }, variants: VariantSpec[] = []): Promise<ProductAdminResponse> {
    return this.createCore(actor, shopId, this.withoutPlatformFields(input), variants);
  }

  async updateShop(actor: AuthenticatedActor, shopId: string, id: string, patch: ProductWriteInput): Promise<ProductAdminResponse> {
    return this.updateCore(actor, id, this.withoutPlatformFields(patch), shopId);
  }

  async saveVariantsShop(actor: AuthenticatedActor | null, shopId: string, id: string, variants: VariantSpec[]): Promise<ProductAdminResponse> {
    return this.saveVariantsCore(actor, id, variants, shopId);
  }

  async saveAttributesShop(actor: AuthenticatedActor, shopId: string, id: string, values: AttributeValueInput[]): Promise<ProductAdminResponse> {
    return this.saveAttributesCore(actor, id, values, shopId);
  }

  async publishShop(actor: AuthenticatedActor | null, shopId: string, id: string): Promise<ProductAdminResponse> {
    return this.publishCore(actor, id, shopId);
  }

  async hideShop(actor: AuthenticatedActor, shopId: string, id: string): Promise<ProductAdminResponse> {
    return this.hideCore(actor, id, shopId);
  }

  async removeShop(actor: AuthenticatedActor, shopId: string, id: string): Promise<void> {
    return this.removeCore(actor, id, shopId);
  }

  // ---------------------------------------------------------------- lõi dùng chung

  /* Nhãn/ưu tiên hiển thị (nổi bật, "Mới", tag bộ sưu tập) là quyền của sàn — vendor không tự đặt dù body có gửi. */
  private withoutPlatformFields<T extends ProductWriteInput>(input: T): T {
    return { ...input, tags: undefined, isNew: undefined, isFeatured: undefined };
  }

  /* Đọc sản phẩm; `shopId` truyền vào (vendor) thì sản phẩm của shop khác = 404 (không lộ tồn tại). */
  private async loadOwned(id: string, shopId?: string): Promise<ProductDetailRow> {
    const p = await this.repo.findDetailById(id);
    if (!p || (shopId !== undefined && p.shopId !== shopId)) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    return p;
  }

  private async createCore(actor: AuthenticatedActor | null, shopId: string, input: ProductWriteInput & { name: string; categoryId: string; basePrice: string }, variants: VariantSpec[]): Promise<ProductAdminResponse> {
    const category = await this.resolveAssignableCategory(input.categoryId);

    // PLAN-0016: validate required fields theo category.attributeMode
    if (category.attributeMode === LEGACY_MODE) this.assertLegacyFields(input);
    this.assertPrices(input.basePrice, input.listPrice);
    this.assertVariantPrices(variants);

    // Thuộc tính cấp sản phẩm kiểm TRƯỚC khi mở transaction (đọc catalog, không ghi). Sản phẩm luôn tạo ở trạng thái nháp nên
    // thuộc tính bắt buộc (required) chỉ chặn lúc đăng bán, không chặn lúc tạo.
    const attributeRows = await this.prepareAttributes(category, input.attributeValues ?? []);
    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name));

    const created = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.create(
        {
          shopId,
          name: input.name.trim(),
          slug,
          categoryId: category.id,
          categorySlug: category.slug,
          gender: input.gender,
          basePrice: input.basePrice,
          listPrice: input.listPrice ?? null,
          shortDescription: input.shortDescription ?? null,
          description: input.description ?? null,
          material: input.material ?? null,
          care: input.care ?? [],
          tags: input.tags ?? [],
          isNew: input.isNew ?? false,
          isFeatured: input.isFeatured ?? false,
          status: PRODUCT_STATUS.DRAFT,
          createdBy: actor?.userId ?? null,
          updatedBy: actor?.userId ?? null,
        },
        tx,
      );

      // PLAN-0016: branch theo category.attributeMode
      if (variants.length > 0) {
        if (category.attributeMode === LEGACY_MODE) await this.applyLegacyVariants({ actor, shopId, productId: p.id, slug, existing: [], variants, tx });
        else await this.applyDynamicVariants({ actor, shopId, productId: p.id, slug, categoryId: category.id, existing: [], variants, tx });
      }
      if (attributeRows.length > 0) await this.repo.replaceAttributeValues(p.id, attributeRows, tx);

      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.CREATED, entityType: 'product', entityId: p.id, entityCode: p.slug, after: { name: p.name, category: category.slug, basePrice: input.basePrice, variants: variants.length, attributes: attributeRows.length, shopId } });
      return (await this.repo.findDetailById(p.id, tx))!;
    }, VARIANT_TX);
    await this.query.invalidateAll();
    return this.view(created);
  }

  private async updateCore(actor: AuthenticatedActor, id: string, patch: ProductWriteInput, ownerShopId?: string): Promise<ProductAdminResponse> {
    const before = await this.loadOwned(id, ownerShopId);
    // Slug nhập tay trùng → 409 mà KHÔNG nêu sản phẩm/shop nào đang giữ slug đó.
    if (patch.slug && patch.slug !== before.slug && (await this.repo.slugExists(patch.slug, id))) throw new ConflictException(PRODUCT_ERR.SLUG_EXISTS, 'Slug đã được sử dụng, hãy chọn slug khác');
    this.assertPrices(patch.basePrice ?? before.basePrice.toString(), patch.listPrice === undefined ? (before.listPrice?.toString() ?? null) : patch.listPrice);

    let category: CategoryBrief | null = null;
    let keepAttributeIds: string[] | null = null;
    if (patch.categoryId && patch.categoryId !== before.categoryId) {
      category = await this.resolveAssignableCategory(patch.categoryId);
      keepAttributeIds = await this.assertCategorySwitch(before, category, patch);
    }

    const data = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(category ? { categoryId: category.id, categorySlug: category.slug } : {}),
      ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
      ...(patch.basePrice !== undefined ? { basePrice: patch.basePrice } : {}),
      ...(patch.listPrice !== undefined ? { listPrice: patch.listPrice } : {}),
      ...(patch.shortDescription !== undefined ? { shortDescription: patch.shortDescription } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.material !== undefined ? { material: patch.material } : {}),
      ...(patch.care !== undefined ? { care: patch.care } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.isNew !== undefined ? { isNew: patch.isNew } : {}),
      ...(patch.isFeatured !== undefined ? { isFeatured: patch.isFeatured } : {}),
    };
    if (Object.keys(data).length === 0) return this.view(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { ...data, updatedBy: actor.userId }, tx);
      if (category) {
        // Đổi ngành (chưa có biến thể, hoặc cùng bộ trục): gỡ thuộc tính cấp sản phẩm không còn thuộc mẫu ngành mới.
        if (keepAttributeIds) await this.repo.deleteAttributeValuesNotIn(id, keepAttributeIds, tx);
        if (before.status === PRODUCT_STATUS.ACTIVE) {
          await this.categoryStats.adjustProductCount(before.categoryId, -1, tx);
          await this.categoryStats.adjustProductCount(category.id, +1, tx);
        }
      }
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.UPDATED, entityType: 'product', entityId: id, entityCode: p.slug, before: this.summary(before), after: this.summary(p) });
      if (p.status === PRODUCT_STATUS.ACTIVE) await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.UPDATED, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return this.view(after);
  }

  private async saveVariantsCore(actor: AuthenticatedActor | null, id: string, variants: VariantSpec[], ownerShopId?: string): Promise<ProductAdminResponse> {
    const pre = await this.loadOwned(id, ownerShopId);
    if (variants.length === 0) throw new BusinessException(PRODUCT_ERR.VARIANT_REQUIRED, 'Cần ít nhất một biến thể');
    this.assertVariantPrices(variants);

    // Fetch category để xác định mode
    const category = await this.catalog.findCategoryById(pre.categoryId);
    if (!category) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng không tồn tại');

    const after = await this.prisma.$transaction(async (tx) => {
      // Khoá sản phẩm rồi ĐỌC LẠI biến thể hiện có: kế hoạch khớp cũ↔mới dựng từ trạng thái đã khoá, hai lần lưu đồng thời
      // không ghi chồng (một bên đợi bên kia commit rồi thấy đúng biến thể vừa tạo).
      await this.repo.lockProduct(id, tx);
      const before = await this.repo.findDetailById(id, tx);
      if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');

      const ctx = { actor, shopId: before.shopId, productId: id, slug: before.slug, existing: before.variants, variants, tx };
      const r = category.attributeMode === LEGACY_MODE ? await this.applyLegacyVariants(ctx) : await this.applyDynamicVariants({ ...ctx, categoryId: category.id });
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.VARIANTS_SAVED, entityType: 'product', entityId: id, entityCode: before.slug, after: { variants: r.skus, created: r.created, updated: r.updated, removed: r.removed } });
      return (await this.repo.findDetailById(id, tx))!;
    }, VARIANT_TX);
    await this.query.invalidateAll();
    return this.view(after);
  }

  /* PUT …/attributes — thay toàn bộ thuộc tính cấp sản phẩm của ngành dynamic (trước đây chỉ ghi được lúc tạo). */
  private async saveAttributesCore(actor: AuthenticatedActor, id: string, values: AttributeValueInput[], ownerShopId?: string): Promise<ProductAdminResponse> {
    const pre = await this.loadOwned(id, ownerShopId);
    const category = await this.catalog.findCategoryById(pre.categoryId);
    if (!category) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng không tồn tại');
    if (category.attributeMode === LEGACY_MODE) throw new BusinessException(PRODUCT_ERR.ATTRIBUTE_INVALID, 'Ngành hàng thời trang không dùng thuộc tính động (dùng giới tính/chất liệu/bảo quản)');

    const template = await this.catalog.getCategoryAttributeTemplate(category.id);
    const rows = await this.validateAttributeValues(template, values);
    // Đang bán thì không được làm mất thuộc tính bắt buộc (đăng bán đã đòi đủ).
    if (pre.status === PRODUCT_STATUS.ACTIVE) {
      const missing = await this.missingRequiredNames(template, rows.map((r) => r.attributeId));
      if (missing.length > 0) throw new BusinessException(PRODUCT_ERR.ATTRIBUTE_REQUIRED, `Sản phẩm đang bán, không được bỏ thuộc tính bắt buộc: ${missing.join(', ')}`, HttpStatus.BAD_REQUEST, { missingAttributes: missing.join(', ') });
    }

    const after = await this.prisma.$transaction(async (tx) => {
      await this.repo.lockProduct(id, tx);
      await this.repo.replaceAttributeValues(id, rows, tx);
      const p = await this.repo.update(id, { updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.ATTRIBUTES_SAVED, entityType: 'product', entityId: id, entityCode: p.slug, before: { attributes: pre.attributeValues.map((a) => ({ attributeId: a.attributeId, attributeValueId: a.attributeValueId, customValue: a.customValue })) }, after: { attributes: rows } });
      if (p.status === PRODUCT_STATUS.ACTIVE) await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.UPDATED, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return (await this.repo.findDetailById(id, tx))!;
    });
    await this.query.invalidateAll();
    return this.view(after);
  }

  private async publishCore(actor: AuthenticatedActor | null, id: string, ownerShopId?: string): Promise<ProductAdminResponse> {
    const before = await this.loadOwned(id, ownerShopId);
    if (before.status === PRODUCT_STATUS.ACTIVE) return this.view(before);
    const problems: string[] = [];
    let missingAttributes: string[] = [];
    if (before.variants.filter((v) => v.isActive).length === 0) problems.push('chưa có biến thể');
    if (before.images.length === 0) problems.push('chưa có ảnh');
    // Ngành dynamic: các thuộc tính cấp sản phẩm bắt buộc (required) của mẫu ngành phải đủ.
    const category = await this.catalog.findCategoryById(before.categoryId);
    if (category && category.attributeMode !== LEGACY_MODE) {
      const template = await this.catalog.getCategoryAttributeTemplate(category.id);
      missingAttributes = await this.missingRequiredNames(template, before.attributeValues.map((a) => a.attributeId));
      if (missingAttributes.length > 0) problems.push(`thiếu thuộc tính bắt buộc: ${missingAttributes.join(', ')}`);
    }
    if (problems.length > 0) {
      throw new BusinessException(PRODUCT_ERR.NOT_PUBLISHABLE, `Chưa đăng bán được: ${problems.join(', ')}`, HttpStatus.BAD_REQUEST, missingAttributes.length > 0 ? { missingAttributes: missingAttributes.join(', ') } : {});
    }
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { status: PRODUCT_STATUS.ACTIVE, publishedAt: before.publishedAt ?? new Date(), updatedBy: actor?.userId ?? null }, tx);
      await this.categoryStats.adjustProductCount(p.categoryId, +1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.PUBLISHED, entityType: 'product', entityId: id, entityCode: p.slug, before: { status: before.status }, after: { status: p.status } });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.PUBLISHED, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return this.view(after);
  }

  private async hideCore(actor: AuthenticatedActor, id: string, ownerShopId?: string): Promise<ProductAdminResponse> {
    const before = await this.loadOwned(id, ownerShopId);
    if (before.status !== PRODUCT_STATUS.ACTIVE) return this.view(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { status: PRODUCT_STATUS.HIDDEN, updatedBy: actor.userId }, tx);
      await this.categoryStats.adjustProductCount(p.categoryId, -1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.HIDDEN, entityType: 'product', entityId: id, entityCode: p.slug, before: { status: before.status }, after: { status: p.status } });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.HIDDEN, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return this.view(after);
  }

  private async removeCore(actor: AuthenticatedActor, id: string, ownerShopId?: string): Promise<void> {
    const before = await this.loadOwned(id, ownerShopId);
    await this.prisma.$transaction(async (tx) => {
      await this.repo.update(id, { isDeleted: true, status: PRODUCT_STATUS.HIDDEN, updatedBy: actor.userId }, tx);
      // Xoá mềm cả biến thể để SKU được dùng lại (unique partial trên biến thể sống)
      await this.repo.softDeleteVariantsNotIn(id, [], actor.userId, tx);
      if (before.status === PRODUCT_STATUS.ACTIVE) await this.categoryStats.adjustProductCount(before.categoryId, -1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.DELETED, entityType: 'product', entityId: id, entityCode: before.slug, before: this.summary(before) });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.HIDDEN, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: before.slug, deleted: true } });
    });
    await this.query.invalidateAll();
    this.logger.log({ id, slug: before.slug, shopId: before.shopId, by: actor.userId }, 'Đã xoá mềm sản phẩm');
  }

  // ---------------------------------------------------------------- ngành hàng

  /* Chỉ gán ngành TỒN TẠI, ĐANG BẬT và là ngành LÁ (ngành cha chỉ là nhóm hiển thị, không có mẫu thuộc tính riêng). */
  private async resolveAssignableCategory(categoryId: string): Promise<CategoryBrief> {
    const category = await this.catalog.findCategoryById(categoryId);
    if (!category) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng không tồn tại');
    if (!category.isActive) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng đang tắt, không thể gán sản phẩm');
    if (await this.catalog.categoryHasChildren(category.id)) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Chỉ gán sản phẩm vào ngành hàng cấp cuối — hãy chọn ngành con');
    return category;
  }

  /* Response quản trị kèm tên thuộc tính/giá trị (ProductAttributeValue chỉ lưu id sang catalog) — resolve một lần ở đây rồi map thuần. */
  private async view(row: ProductDetailRow): Promise<ProductAdminResponse> {
    return toProductAdmin(row, await resolveAttributeLookup(this.catalog, row));
  }

  /*
   * Đổi ngành: sản phẩm đã có biến thể thì CHỈ đổi sang ngành cùng kiểu thuộc tính (legacy↔legacy; dynamic↔dynamic cùng bộ trục biến thể) —
   * khác đi thì biến thể (màu/size hay options) và thuộc tính cũ mồ côi → 409 PRODUCT_CATEGORY_LOCKED. Chưa có biến thể thì đổi
   * tự do. Trả danh sách attributeId được GIỮ (null = không phải dọn thuộc tính).
   */
  private async assertCategorySwitch(before: ProductDetailRow, target: CategoryBrief, patch: ProductWriteInput): Promise<string[]> {
    const current = await this.catalog.findCategoryById(before.categoryId);
    const targetTemplate: CategoryAttributeTemplateItem[] = target.attributeMode === LEGACY_MODE ? [] : await this.catalog.getCategoryAttributeTemplate(target.id);

    if (before.variants.length > 0) {
      if (current && current.attributeMode !== target.attributeMode) {
        throw new ConflictException(PRODUCT_ERR.CATEGORY_LOCKED, 'Sản phẩm đã có biến thể — không đổi sang ngành hàng dùng kiểu thuộc tính khác (thời trang ↔ ngành mới). Hãy tạo sản phẩm mới ở ngành đó');
      }
      if (target.attributeMode !== LEGACY_MODE) {
        const currentTemplate = await this.catalog.getCategoryAttributeTemplate(before.categoryId);
        const axisSig = (t: CategoryAttributeTemplateItem[]) => t.filter((x) => x.isVariantAxis).map((x) => x.attributeId).sort().join('|');
        if (axisSig(currentTemplate) !== axisSig(targetTemplate)) {
          throw new ConflictException(PRODUCT_ERR.CATEGORY_LOCKED, 'Sản phẩm đã có biến thể — chỉ đổi được sang ngành hàng có cùng bộ trục biến thể');
        }
      }
    }
    if (target.attributeMode === LEGACY_MODE) {
      // Sang ngành thời trang: giới tính/chất liệu/bảo quản phải đầy đủ sau khi gộp patch.
      this.assertLegacyFields({ gender: patch.gender ?? before.gender, material: patch.material === undefined ? before.material : patch.material, care: patch.care ?? before.care });
    }
    return targetTemplate.filter((t) => !t.isVariantAxis).map((t) => t.attributeId);
  }

  /* Ngành thời trang: giới tính + chất liệu + bảo quản bắt buộc. */
  private assertLegacyFields(f: { gender?: string | null; material?: string | null; care?: unknown }): void {
    if (!f.gender) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngành hàng thời trang: giới tính bắt buộc');
    if (!f.material) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngành hàng thời trang: chất liệu bắt buộc');
    if (!Array.isArray(f.care) || f.care.length === 0) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngành hàng thời trang: hướng dẫn bảo quản bắt buộc');
  }

  // ---------------------------------------------------------------- giá · slug

  private assertPrices(basePrice: string, listPrice: string | null | undefined): void {
    const base = vnd(basePrice);
    if (base <= 0n) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá bán phải lớn hơn 0');
    if (base > MAX_VND) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá bán vượt giới hạn cho phép');
    if (listPrice && vnd(listPrice) <= base) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá gốc phải lớn hơn giá bán (hoặc bỏ trống)');
    if (listPrice && vnd(listPrice) > MAX_VND) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá gốc vượt giới hạn cho phép');
  }

  /* Giá riêng của biến thể (nếu có) phải > 0 — bỏ trống/null = theo giá sản phẩm. Áp cho cả legacy lẫn dynamic. */
  private assertVariantPrices(variants: VariantSpec[]): void {
    for (const v of variants) {
      if (v.price === undefined || v.price === null || v.price === '') continue;
      const price = vnd(v.price);
      if (price <= 0n) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá riêng của biến thể phải lớn hơn 0 (bỏ trống để dùng giá sản phẩm)');
      if (price > MAX_VND) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá riêng của biến thể vượt giới hạn cho phép');
    }
  }

  /* Slug duy nhất toàn sàn: trùng thì thêm -2, -3… (tên chung như "Áo thun basic" rất hay trùng giữa các shop); cắt ≤ 160 ký tự.
     Dò theo lô 20 ứng viên/1 query để không hỏi DB từng slug. */
  private async uniqueSlug(wanted: string): Promise<string> {
    const base = (wanted || 'san-pham').slice(0, SLUG_MAX).replace(/-+$/, '') || 'san-pham';
    const candidate = (n: number): string => {
      if (n === 1) return base;
      const suffix = `-${n}`;
      return base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix;
    };
    for (let from = 1; ; from += 20) {
      const candidates = Array.from({ length: 20 }, (_, i) => candidate(from + i));
      const taken = new Set(await this.repo.findExistingSlugs(candidates));
      const free = candidates.find((c) => !taken.has(c));
      if (free) return free;
    }
  }

  // ---------------------------------------------------------------- biến thể

  /*
   * Gỡ biến thể khỏi sản phẩm (xoá mềm): khoá dòng rồi kiểm số liệu MỚI NHẤT — đang giữ hàng cho đơn (reserved > 0) hoặc nằm trong phiếu
   * nhập nháp thì 409 PRODUCT_VARIANT_IN_USE (xoá thì đơn/phiếu mồ côi). Trả SKU đã gỡ.
   */
  private async releaseVariants(tx: Tx, removed: ExistingVariant[], actorId: string | null): Promise<string[]> {
    if (removed.length === 0) return [];
    const ids = removed.map((v) => v.id);
    const locked = await this.repo.lockVariants(ids, tx);
    const reserved = locked.find((v) => v.reserved > 0);
    if (reserved) throw new ConflictException(PRODUCT_ERR.VARIANT_IN_USE, `Biến thể SKU '${reserved.sku}' đang giữ hàng cho đơn chưa hoàn tất, chưa thể gỡ khỏi danh sách`, { sku: reserved.sku });
    const refs = await this.repo.findDraftReceiptRefs(ids, tx);
    if (refs.length > 0) {
      const sku = removed.find((v) => v.id === refs[0].variantId)?.sku ?? '';
      throw new ConflictException(PRODUCT_ERR.VARIANT_IN_USE, `Biến thể SKU '${sku}' đang nằm trong phiếu nhập kho nháp ${refs[0].receiptCode} — hãy duyệt hoặc huỷ phiếu trước khi gỡ`, { sku, receiptCode: refs[0].receiptCode });
    }
    await this.repo.softDeleteVariants(ids, actorId, tx);
    return removed.map((v) => v.sku);
  }

  /* Nhánh legacy (category.attributeMode="legacy_fashion"): khớp theo (màu, size) → upsert giữ id/tồn kho; gỡ biến thể không còn. */
  private async applyLegacyVariants(a: { actor: AuthenticatedActor | null; shopId: string; productId: string; slug: string; existing: ExistingVariant[]; variants: VariantSpec[]; tx: Tx }): Promise<{ skus: string[]; created: number; updated: number; removed: string[] }> {
    const keyOf = (colorCode: string | null, sizeCode: string | null) => `${colorCode}|${sizeCode}`;
    const existingByKey = new Map(a.existing.map((e) => [keyOf(e.colorCode, e.sizeCode), e]));
    const specs = await this.resolveVariantsLegacy(a.slug, a.variants, existingByKey);
    const keptKeys = new Set(specs.map((s) => keyOf(s.colorCode, s.sizeCode)));
    const actorId = a.actor?.userId ?? null;

    // Gỡ trước → SKU của biến thể bị gỡ dùng lại được ngay trong cùng lượt lưu.
    const removed = await this.releaseVariants(a.tx, a.existing.filter((e) => !keptKeys.has(keyOf(e.colorCode, e.sizeCode))), actorId);

    const seen = new Set<string>();
    let updated = 0;
    for (const v of specs) {
      if (seen.has(v.sku)) throw new ConflictException(PRODUCT_ERR.SKU_EXISTS, `Mã SKU '${v.sku}' bị lặp trong danh sách biến thể`);
      seen.add(v.sku);
      const existing = existingByKey.get(keyOf(v.colorCode, v.sizeCode));
      // SKU unique theo GIAN HÀNG (hai shop được trùng) — thông báo không nêu shop/sản phẩm khác.
      if (await this.repo.skuExists(a.shopId, v.sku, existing?.id, a.tx)) throw new ConflictException(PRODUCT_ERR.SKU_EXISTS, `Mã SKU '${v.sku}' đã tồn tại trong gian hàng của bạn`);
      await this.repo.upsertVariant(a.productId, a.shopId, v, actorId, a.tx);
      if (existing) updated++;
    }
    return { skus: specs.map((s) => s.sku), created: specs.length - updated, updated, removed };
  }

  /* PLAN-0016: Nhánh dynamic (category.attributeMode="dynamic") — khớp theo tổ hợp trục, cập nhật tại chỗ, chỉ tạo tổ hợp mới. */
  private async applyDynamicVariants(a: { actor: AuthenticatedActor | null; shopId: string; productId: string; slug: string; categoryId: string; existing: ExistingVariant[]; variants: VariantSpec[]; tx: Tx }): Promise<{ skus: string[]; created: number; updated: number; removed: string[] }> {
    const plan = await this.planDynamicVariants({ shopId: a.shopId, slug: a.slug, categoryId: a.categoryId, variants: a.variants, existing: a.existing, tx: a.tx });
    const actorId = a.actor?.userId ?? null;
    const removed = await this.releaseVariants(a.tx, plan.removed, actorId);
    for (const u of plan.updates) await this.repo.updateVariantDynamic(u.id, u, actorId, a.tx);
    for (const c of plan.creates) await this.repo.createVariantDynamic(a.productId, a.shopId, c, actorId, a.tx);
    return { skus: [...plan.updates.map((u) => u.sku), ...plan.creates.map((c) => c.sku)], created: plan.creates.length, updated: plan.updates.length, removed };
  }

  /* PLAN-0016: Nhánh legacy — mã màu/size phải có trong catalog; SKU: vendor nhập thì dùng (in hoa), bỏ trống thì giữ SKU biến thể cũ, chưa có thì makeSku. */
  private async resolveVariantsLegacy(slug: string, variants: VariantSpec[], existingByKey: Map<string, ExistingVariant>): Promise<Array<{ sku: string; colorCode: string; colorName: string; colorHex: string | null; sizeCode: string; price: bigint | null; isActive: boolean }>> {
    const [colors, sizes] = await Promise.all([this.catalog.colorMap(), this.catalog.sizeMap()]);
    const seen = new Set<string>();
    const out = [];
    for (const v of variants) {
      const colorCode = v.colorCode;
      const sizeCode = v.sizeCode;
      if (!colorCode || !sizeCode) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngành hàng thời trang: mỗi biến thể cần colorCode và sizeCode');
      const color = colors.get(colorCode);
      if (!color) throw new BusinessException(PRODUCT_ERR.COLOR_INVALID, `Mã màu '${colorCode}' không có trong catalog`);
      if (!sizes.has(sizeCode)) throw new BusinessException(PRODUCT_ERR.SIZE_INVALID, `Size '${sizeCode}' không có trong catalog`);
      const key = `${colorCode}|${sizeCode}`;
      if (seen.has(key)) throw new BusinessException('COMMON_VALIDATION_ERROR', `Biến thể ${color.name} / ${sizeCode} bị lặp`);
      seen.add(key);
      const sku = (v.sku ?? existingByKey.get(key)?.sku ?? makeSku(slug, colorCode, sizeCode)).toUpperCase();
      out.push({ sku, colorCode, colorName: color.name, colorHex: color.hex, sizeCode, price: v.price ? vnd(v.price) : null, isActive: v.isActive ?? true });
    }
    return out;
  }

  /*
   * Dựng kế hoạch ghi biến thể dynamic (CHƯA ghi gì):
   * 1) kiểm bộ trục đúng mẫu ngành (không thiếu/thừa/lặp), giá trị thuộc đúng thuộc tính, tổ hợp không lặp;
   * 2) khớp biến thể HIỆN CÓ theo tổ hợp (attributeId, attributeValueId) → cập nhật tại chỗ; tổ hợp mới → tạo; còn lại → gỡ;
   * 3) SKU: vendor nhập → dùng (in hoa); bỏ trống → biến thể cũ giữ SKU cũ, biến thể mới sinh deterministic. Trùng trong lượt lưu
   *    hoặc trùng biến thể sống khác CỦA CÙNG gian hàng → 409; SKU của biến thể sắp gỡ coi như đã trống.
   * Ngành không có trục biến thể (axes rỗng): đúng MỘT biến thể không options.
   */
  private async planDynamicVariants(a: { shopId: string; slug: string; categoryId: string; variants: VariantSpec[]; existing: ExistingVariant[]; tx: Tx }): Promise<DynamicVariantPlan> {
    // Mẫu thuộc tính của category — validate options đúng bộ isVariantAxis=true, không thiếu không thừa.
    const template = await this.catalog.getCategoryAttributeTemplate(a.categoryId);
    const axes = template.filter((t) => t.isVariantAxis);
    const axisIds = new Set(axes.map((t) => t.attributeId));
    const axisOrder = new Map(axes.map((t, i) => [t.attributeId, i]));

    // Gom toàn bộ attributeValueId để tra displayValue một lần (tránh N+1).
    const allValueIds = a.variants.flatMap((v) => (v.options ?? []).map((o) => o.attributeValueId));
    const valueMap = await this.catalog.findDynamicAttributeValuesByIds(allValueIds);

    const optionKey = (opts: Array<{ attributeId: string; attributeValueId: string }>) => opts.map((o) => `${o.attributeId}:${o.attributeValueId}`).sort().join('|');
    const seenKeys = new Set<string>();
    const resolved: Array<{ key: string; options: VariantOptionSnapshot[]; price: bigint | null; isActive: boolean; sku: string | null }> = [];

    for (const v of a.variants) {
      const opts = v.options ?? [];
      if (axisIds.size === 0) {
        if (opts.length > 0) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngành hàng này không có trục biến thể — bỏ options');
      } else {
        if (opts.length === 0) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Biến thể phải có ít nhất một trục (options)');
        if (opts.length > 2) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Biến thể tối đa 2 trục');
        // Validate options đúng bộ trục isVariantAxis=true của category (không thiếu, không thừa, không lặp trục).
        const submittedIds = new Set(opts.map((o) => o.attributeId));
        if (submittedIds.size !== opts.length) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Một biến thể không được khai cùng một trục hai lần');
        if (submittedIds.size !== axisIds.size || ![...submittedIds].every((id) => axisIds.has(id))) {
          throw new BusinessException('COMMON_VALIDATION_ERROR', 'Trục biến thể không khớp mẫu thuộc tính của ngành hàng');
        }
      }

      // Key duy nhất từ options để kiểm lặp + khớp biến thể cũ
      const key = optionKey(opts);
      if (seenKeys.has(key)) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Biến thể bị lặp');
      seenKeys.add(key);

      // Snapshot displayValue — chép tên hiển thị lúc tạo biến thể, không tham chiếu sống. Sắp theo thứ tự trục của mẫu (SKU ổn định).
      const options = opts
        .map((o) => {
          const val = valueMap.get(o.attributeValueId);
          if (!val || val.attributeId !== o.attributeId) throw new BusinessException('COMMON_VALIDATION_ERROR', `Giá trị thuộc tính không hợp lệ: ${o.attributeValueId}`);
          return { attributeId: o.attributeId, attributeValueId: o.attributeValueId, displayValue: val.value };
        })
        .sort((x, y) => (axisOrder.get(x.attributeId) ?? 0) - (axisOrder.get(y.attributeId) ?? 0));

      resolved.push({ key, options, price: v.price ? vnd(v.price) : null, isActive: v.isActive ?? true, sku: v.sku ? v.sku.toUpperCase() : null });
    }

    // Khớp biến thể hiện có theo tổ hợp trục.
    const existingByKey = new Map<string, ExistingVariant>();
    for (const e of a.existing) {
      const k = optionKey(e.options);
      if (!existingByKey.has(k)) existingByKey.set(k, e);
    }
    const matched = resolved.map((r) => existingByKey.get(r.key) ?? null);
    const matchedIds = new Set(matched.filter((m): m is ExistingVariant => m !== null).map((m) => m.id));
    const removed = a.existing.filter((e) => !matchedIds.has(e.id));
    const removedIds = new Set(removed.map((e) => e.id));

    // SKU "chốt": vendor nhập, hoặc biến thể cũ giữ nguyên SKU.
    const fixed = resolved.map((r, i) => r.sku ?? matched[i]?.sku ?? null);
    const used = new Set<string>();
    for (const sku of fixed) {
      if (sku === null) continue;
      if (used.has(sku)) throw new ConflictException(PRODUCT_ERR.SKU_EXISTS, `Mã SKU '${sku}' bị lặp trong danh sách biến thể`);
      used.add(sku);
    }
    const prefix = this.skuPrefix(a.slug);
    // MỘT query: SKU sống của shop trùng các SKU chốt + mọi SKU cùng tiền tố (để dò chỗ trống khi sinh).
    const holders = await this.repo.findShopSkus(a.shopId, { exact: [...used], prefix: `${prefix}-` }, a.tx);
    fixed.forEach((sku, i) => {
      if (sku === null) return;
      const holder = holders.find((h) => h.sku === sku);
      if (holder && holder.id !== matched[i]?.id && !removedIds.has(holder.id)) throw new ConflictException(PRODUCT_ERR.SKU_EXISTS, `Mã SKU '${sku}' đã tồn tại trong gian hàng của bạn`);
    });

    // `taken` = mọi SKU không được phát sinh: đang sống ở shop (trừ biến thể sắp gỡ) + SKU chốt của lượt lưu này.
    const taken = new Set<string>([...holders.filter((h) => !removedIds.has(h.id)).map((h) => h.sku), ...used]);
    const plan: DynamicVariantPlan = { updates: [], creates: [], removed };
    resolved.forEach((r, i) => {
      const sku = fixed[i] ?? this.generateSku(prefix, r.options.map((o) => o.displayValue), i, taken);
      const m = matched[i];
      if (m) plan.updates.push({ id: m.id, sku, price: r.price, isActive: r.isActive });
      else plan.creates.push({ sku, price: r.price, isActive: r.isActive, options: r.options });
    });
    return plan;
  }

  /* Tiền tố SKU từ slug sản phẩm: chữ-số in hoa, tối đa 12 ký tự (vd "iphone-15-pro" → IPHONE15PRO). */
  private skuPrefix(slug: string): string {
    return slug.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'SP';
  }

  /*
   * Sinh SKU deterministic `<tiền tố>-<giá trị các trục>` (vd IPHONE15PRO-128GB-DEN). Trùng với `taken` (DB + lượt lưu hiện tại)
   * thì thêm -2, -3… cho đến khi trống — không giới hạn số lần thử mù; thêm vào `taken` để biến thể kế tiếp không đụng.
   */
  private generateSku(prefix: string, labels: string[], index: number, taken: Set<string>): string {
    const parts = labels.map((l) => slugify(l).toUpperCase()).filter(Boolean);
    const base = [prefix, ...(parts.length > 0 ? parts : [`V${index + 1}`])].join('-');
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? '' : `-${n}`;
      const sku = base.slice(0, SKU_MAX - suffix.length).replace(/-+$/, '') + suffix;
      if (!taken.has(sku)) {
        taken.add(sku);
        return sku;
      }
    }
  }

  // ---------------------------------------------------------------- thuộc tính cấp sản phẩm (PLAN-0016)

  /* Chuẩn bị thuộc tính lúc TẠO: ngành thời trang không dùng thuộc tính động; ngành dynamic kiểm theo mẫu. */
  private async prepareAttributes(category: CategoryBrief, values: AttributeValueInput[]): Promise<AttributeRow[]> {
    if (category.attributeMode === LEGACY_MODE) {
      if (values.length > 0) throw new BusinessException(PRODUCT_ERR.ATTRIBUTE_INVALID, 'Ngành hàng thời trang không dùng thuộc tính động (dùng giới tính/chất liệu/bảo quản)');
      return [];
    }
    if (values.length === 0) return [];
    return this.validateAttributeValues(await this.catalog.getCategoryAttributeTemplate(category.id), values);
  }

  /*
   * Kiểm thuộc tính cấp sản phẩm theo mẫu của ngành LÁ: attributeId thuộc mẫu (và không phải trục biến thể — trục khai ở biến thể),
   * không lặp; mỗi dòng đúng MỘT trong attributeValueId / customValue, và hợp với `inputType` của thuộc tính (CatalogQueryApi):
   * - select ⇒ BẮT BUỘC attributeValueId thuộc đúng thuộc tính, KHÔNG nhận customValue;
   * - number ⇒ BẮT BUỘC customValue là số hợp lệ (xem NUMBER_PATTERN), KHÔNG nhận attributeValueId;
   * - text ⇒ BẮT BUỘC customValue không rỗng (≤ 255 ký tự), KHÔNG nhận attributeValueId.
   * Mọi lỗi PRODUCT_ATTRIBUTE_INVALID đều nêu TÊN thuộc tính để vendor đọc được.
   */
  private async validateAttributeValues(template: CategoryAttributeTemplateItem[], values: AttributeValueInput[]): Promise<AttributeRow[]> {
    if (values.length === 0) return [];
    const byId = new Map(template.map((t) => [t.attributeId, t]));
    const valueIds = values.map((v) => v.attributeValueId).filter((x): x is string => !!x);
    const [valueMap, names] = await Promise.all([
      valueIds.length > 0 ? this.catalog.findDynamicAttributeValuesByIds(valueIds) : Promise.resolve(new Map<string, { id: string; value: string; attributeId: string }>()),
      this.catalog.findDynamicAttributeNamesByIds(values.map((v) => v.attributeId)),
    ]);
    const label = (id: string) => names.get(id)?.name ?? id;
    const invalid = (msg: string) => new BusinessException(PRODUCT_ERR.ATTRIBUTE_INVALID, msg);

    const seen = new Set<string>();
    const rows: AttributeRow[] = [];
    for (const v of values) {
      const name = label(v.attributeId);
      if (seen.has(v.attributeId)) throw invalid(`Thuộc tính '${name}' bị lặp trong danh sách`);
      seen.add(v.attributeId);
      const t = byId.get(v.attributeId);
      if (!t) throw invalid(`Thuộc tính '${name}' không thuộc mẫu thuộc tính của ngành hàng`);
      if (t.isVariantAxis) throw invalid(`'${name}' là trục biến thể — khai ở biến thể, không khai ở cấp sản phẩm`);

      const custom = v.customValue?.trim() ?? '';
      const hasValue = !!v.attributeValueId;
      const hasCustom = custom.length > 0;
      if (hasValue && hasCustom) throw invalid(`'${name}': chỉ nhập MỘT trong hai — giá trị có sẵn hoặc giá trị tự nhập`);
      if (!hasValue && !hasCustom) throw invalid(`'${name}': thiếu giá trị`);

      if (t.inputType === 'select') {
        if (hasCustom) throw invalid(`'${name}' phải chọn một giá trị có sẵn, không nhập tay`);
        const val = valueMap.get(v.attributeValueId!);
        if (!val || val.attributeId !== v.attributeId) throw invalid(`Giá trị đã chọn không thuộc thuộc tính '${name}'`);
        rows.push({ attributeId: v.attributeId, attributeValueId: v.attributeValueId!, customValue: null });
        continue;
      }

      // text | number: nhập tay.
      if (hasValue) throw invalid(`'${name}' là thuộc tính nhập tay (${t.inputType}), không chọn giá trị có sẵn`);
      if (t.inputType === 'number' && (!NUMBER_PATTERN.test(custom) || !Number.isFinite(Number(custom)))) {
        throw invalid(`'${name}' phải là một số hợp lệ (chữ số, dùng dấu chấm cho phần thập phân, tối đa 6 chữ số thập phân)`);
      }
      if (custom.length > CUSTOM_VALUE_MAX) throw invalid(`'${name}': giá trị quá dài (tối đa ${CUSTOM_VALUE_MAX} ký tự)`);
      rows.push({ attributeId: v.attributeId, attributeValueId: null, customValue: custom });
    }
    return rows;
  }

  /* Tên các thuộc tính bắt buộc (required, không phải trục biến thể — trục đã đòi ở từng biến thể) mà sản phẩm chưa có. */
  private async missingRequiredNames(template: CategoryAttributeTemplateItem[], presentAttributeIds: string[]): Promise<string[]> {
    const present = new Set(presentAttributeIds);
    const missing = template.filter((t) => t.required && !t.isVariantAxis && !present.has(t.attributeId)).map((t) => t.attributeId);
    if (missing.length === 0) return [];
    const names = await this.catalog.findDynamicAttributeNamesByIds(missing);
    return missing.map((id) => names.get(id)?.name ?? id);
  }

  private summary(p: ProductDetailRow) {
    return { name: p.name, slug: p.slug, category: p.categorySlug, gender: p.gender, basePrice: p.basePrice.toString(), listPrice: p.listPrice?.toString() ?? null, status: p.status, isNew: p.isNew, isFeatured: p.isFeatured };
  }
}
