/*
 * SEED sàn đa ngành hàng (PLAN-0017 Track D) — đọc DSL `scripts/seed/data/**` rồi ghi: thuộc tính động → ngành hàng (gốc + lá + mẫu thuộc tính)
 * → gian hàng + chủ/nhân viên (ShopMember) → sản phẩm (biến thể theo trục, ảnh, thuộc tính) → bộ sưu tập theo ngành → tồn kho
 * qua phiếu nhập `posted` có sổ kho (mỗi shop một phiếu, `shopId` gắn phiếu).
 * Idempotent: mọi thứ tìm theo slug/code/email; sản phẩm đã có thì chỉ ĐỒNG BỘ ẢNH (không đụng tồn/giá đã sửa tay).
 * Dữ liệu sai thì `validateSeedData` từ chối ghi — xem `npm run seed:validate`. Cần: identity (vai) + catalog + `npm run seed:gen-images`.
 */
import * as argon2 from 'argon2';
import { loadEnv } from '../../src/config/env';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { DEPARTMENTS } from './data/dept';
import { DEMO_VENDOR_PASSWORD, SHOPS } from './data/shops';
import type { DeptSeed, SeedProduct, SeedShopDef } from './data/types';
import { axisValueName, mergeAttributes, validateSeedData } from './data/validate';
import { SeedImages } from './lib/seed-images';

const ARGON2 = { type: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const OFFICIAL_CODE = 'SHOP-000001';

interface AttrRef { id: string; inputType: string; values: Map<string, string> }

/* Tên SKU gọn, duy nhất theo slug: chữ cái đầu mỗi từ (tối đa 6) + 3 ký tự băm. */
function skuBase(slug: string): string {
  const initials = slug.split('-').map((w) => w[0] ?? '').join('').slice(0, 6).toUpperCase();
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${initials}${h.toString(36).toUpperCase().padStart(3, '0').slice(-3)}`;
}

async function tryResolve(images: SeedImages, rel: string): Promise<{ url: string; publicId: string | null } | null> {
  return images.has(rel) ? images.resolve(rel) : null;
}

/* ---------------------------------------------------------------- thuộc tính */
async function seedAttributes(prisma: PrismaClient, depts: DeptSeed[]): Promise<Map<string, AttrRef>> {
  const refs = new Map<string, AttrRef>();
  for (const a of mergeAttributes(depts).values()) {
    const attr = await prisma.dynamicAttribute.upsert({ where: { code: a.code }, create: { code: a.code, name: a.name, inputType: a.inputType }, update: { name: a.name }, select: { id: true, inputType: true } });
    const existing = await prisma.dynamicAttributeValue.findMany({ where: { attributeId: attr.id }, select: { id: true, value: true, sortOrder: true } });
    const map = new Map(existing.map((v) => [v.value, v.id]));
    let order = existing.reduce((m, v) => Math.max(m, v.sortOrder), -1) + 1;
    for (const value of a.values ?? []) {
      if (map.has(value)) continue;
      const created = await prisma.dynamicAttributeValue.create({ data: { attributeId: attr.id, value, sortOrder: order, ...(a.hex?.[value] ? { extra: { hex: a.hex[value] } } : {}) }, select: { id: true } });
      map.set(value, created.id);
      order += 1;
    }
    refs.set(a.code, { id: attr.id, inputType: attr.inputType, values: map });
  }
  return refs;
}

/* ---------------------------------------------------------------- ngành hàng */
async function upsertCategory(prisma: PrismaClient, images: SeedImages, c: { slug: string; name: string; description: string; sortOrder: number; parentId: string | null }): Promise<string> {
  const img = await tryResolve(images, `catalog/categories/${c.slug}.jpg`);
  const found = await prisma.category.findFirst({ where: { slug: c.slug, isDeleted: false }, select: { id: true } });
  const data = { name: c.name, description: c.description, sortOrder: c.sortOrder, parentId: c.parentId, isActive: true, attributeMode: 'dynamic', ...(img ? { imageUrl: img.url, imagePublicId: img.publicId } : {}) };
  if (found) return (await prisma.category.update({ where: { id: found.id }, data, select: { id: true } })).id;
  return (await prisma.category.create({ data: { slug: c.slug, ...data }, select: { id: true } })).id;
}

async function seedCategories(prisma: PrismaClient, images: SeedImages, depts: DeptSeed[], attrs: Map<string, AttrRef>): Promise<Map<string, string>> {
  const leafIds = new Map<string, string>();
  for (const d of depts) {
    const rootId = await upsertCategory(prisma, images, { slug: d.slug, name: d.name, description: d.description, sortOrder: d.sortOrder, parentId: null });
    for (const c of d.categories) {
      const id = await upsertCategory(prisma, images, { slug: c.slug, name: c.name, description: c.description, sortOrder: c.sortOrder, parentId: rootId });
      leafIds.set(c.slug, id);
      let order = 0;
      for (const a of c.attrs) {
        const ref = attrs.get(a.code);
        if (!ref) throw new Error(`Thuộc tính '${a.code}' chưa có trong DB`);
        const data = { required: Boolean(a.required), isVariantAxis: Boolean(a.axis), sortOrder: order };
        const found = await prisma.categoryAttribute.findFirst({ where: { categoryId: id, attributeId: ref.id }, select: { id: true } });
        if (found) await prisma.categoryAttribute.update({ where: { id: found.id }, data });
        else await prisma.categoryAttribute.create({ data: { categoryId: id, attributeId: ref.id, ...data } });
        order += 1;
      }
    }
  }
  return leafIds;
}

/* ---------------------------------------------------------------- gian hàng */
async function seedShops(prisma: PrismaClient, images: SeedImages): Promise<Map<string, { id: string; code: string }>> {
  const roles = await prisma.role.findMany({ where: { isDeleted: false }, select: { id: true, code: true } });
  const roleId = (code: string): string => {
    const r = roles.find((x) => x.code === code);
    if (!r) throw new Error(`Thiếu vai '${code}' — chạy "npm run perms:sync" trước`);
    return r.id;
  };
  const hash = await argon2.hash(DEMO_VENDOR_PASSWORD, ARGON2);
  const ensureUser = async (u: { email: string; fullName: string; phone: string }): Promise<string> => {
    const found = await prisma.user.findFirst({ where: { email: { equals: u.email, mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
    if (found) return found.id;
    return (await prisma.user.create({ data: { email: u.email, fullName: u.fullName, phone: u.phone, passwordHash: hash, roleId: roleId('customer'), status: 'active', emailVerifiedAt: new Date() }, select: { id: true } })).id;
  };
  const ensureMember = async (shopId: string, userId: string, role: 'shop_owner' | 'shop_staff'): Promise<void> => {
    const found = await prisma.shopMember.findFirst({ where: { shopId, userId }, select: { id: true } });
    if (!found) await prisma.shopMember.create({ data: { shopId, userId, roleId: roleId(role), status: 'active' } });
  };

  const out = new Map<string, { id: string; code: string }>();
  let created = 0;
  for (const s of SHOPS as readonly SeedShopDef[]) {
    const logo = await tryResolve(images, `shop/${s.slug}/logo.jpg`);
    const banner = await tryResolve(images, `shop/${s.slug}/banner.jpg`);
    const imgData = { ...(logo ? { logoUrl: logo.url } : {}), ...(banner ? { bannerUrl: banner.url } : {}) };
    let shop = await prisma.shop.findFirst({ where: { OR: [{ slug: s.slug }, { code: s.code }], isDeleted: false }, select: { id: true, code: true, ownerUserId: true } });
    if (!shop) {
      const ownerId = await ensureUser(s.owner);
      shop = await prisma.shop.create({
        data: { code: s.code, slug: s.slug, name: s.name, description: s.description, status: s.status, commissionRate: s.commissionRate, ownerUserId: ownerId, createdBy: ownerId, ...imgData },
        select: { id: true, code: true, ownerUserId: true },
      });
      created += 1;
    } else if (Object.keys(imgData).length > 0) {
      await prisma.shop.update({ where: { id: shop.id }, data: imgData });
    }
    if (s.code === OFFICIAL_CODE) {
      const admin = await prisma.user.findFirst({ where: { email: { equals: s.owner.email, mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
      if (admin) await ensureMember(shop.id, admin.id, 'shop_owner');
    } else {
      await ensureMember(shop.id, await ensureUser(s.owner), 'shop_owner');
      for (const st of s.staff ?? []) await ensureMember(shop.id, await ensureUser(st), 'shop_staff');
    }
    out.set(s.slug, { id: shop.id, code: shop.code });
  }
  console.log(`   gian hàng: ${SHOPS.length} (tạo mới ${created}) — chủ/nhân viên đăng nhập bằng email trong data/shops.ts, mật khẩu ${DEMO_VENDOR_PASSWORD}`);
  return out;
}

/* ---------------------------------------------------------------- sản phẩm */
interface VariantPlan { sku: string; delta: number; options: Array<{ attributeId: string; attributeValueId: string; displayValue: string }> }

function planVariants(p: SeedProduct, attrs: Map<string, AttrRef>): VariantPlan[] {
  const base = skuBase(p.slug);
  const axes = p.axes ?? [];
  if (axes.length === 0) return [{ sku: `${base}-01`, delta: 0, options: [] }];
  let combos: Array<{ delta: number; options: VariantPlan['options'] }> = [{ delta: 0, options: [] }];
  for (const ax of axes) {
    const ref = attrs.get(ax.attr);
    if (!ref) throw new Error(`Thuộc tính trục '${ax.attr}' chưa có trong DB`);
    const next: typeof combos = [];
    for (const c of combos) {
      for (const v of ax.values) {
        const name = axisValueName(v);
        const valueId = ref.values.get(name);
        if (!valueId) throw new Error(`Giá trị '${name}' của '${ax.attr}' chưa có trong DB`);
        next.push({ delta: c.delta + (typeof v === 'string' ? 0 : (v.delta ?? 0)), options: [...c.options, { attributeId: ref.id, attributeValueId: valueId, displayValue: name }] });
      }
    }
    combos = next;
  }
  return combos.map((c, i) => ({ sku: `${base}-${String(i + 1).padStart(2, '0')}`, delta: c.delta, options: c.options }));
}

async function syncImages(prisma: PrismaClient, productId: string, imgs: Array<{ url: string; publicId: string | null }>, alt: string): Promise<void> {
  const existing = await prisma.productImage.findMany({ where: { productId }, select: { id: true, url: true, sortOrder: true } });
  const bySort = new Map(existing.map((e) => [e.sortOrder, e]));
  for (const [k, img] of imgs.entries()) {
    const cur = bySort.get(k);
    if (cur) {
      if (cur.url !== img.url) await prisma.productImage.update({ where: { id: cur.id }, data: { url: img.url, publicId: img.publicId } });
    } else {
      await prisma.productImage.create({ data: { productId, url: img.url, publicId: img.publicId, alt, sortOrder: k, isPrimary: k === 0 } });
    }
  }
}

async function seedProducts(prisma: PrismaClient, images: SeedImages, depts: DeptSeed[], attrs: Map<string, AttrRef>, leafIds: Map<string, string>, shops: Map<string, { id: string; code: string }>): Promise<void> {
  const receipts = new Map<string, Array<{ variantId: string; productId: string; sku: string; quantity: number; unitCost: number }>>();
  let created = 0;
  let synced = 0;
  let index = 0;
  const now = Date.now();

  for (const d of depts) {
    for (const p of d.products) {
      index += 1;
      const shop = shops.get(p.shop);
      const categoryId = leafIds.get(p.category);
      if (!shop || !categoryId) throw new Error(`Sản phẩm ${p.slug}: thiếu shop/ngành lá trong DB`);
      const imgs: Array<{ url: string; publicId: string | null }> = [await images.resolve(`product/${p.slug}/a.jpg`)];
      const second = await tryResolve(images, `product/${p.slug}/b.jpg`);
      if (second) imgs.push(second);

      const exists = await prisma.product.findFirst({ where: { slug: p.slug, isDeleted: false }, select: { id: true } });
      if (exists) {
        await syncImages(prisma, exists.id, imgs, p.name);
        synced += 1;
        continue;
      }

      const variants = planVariants(p, attrs);
      const tags = [...new Set([...(p.tags ?? []), ...(p.isNew ? ['new'] : []), ...(p.listPrice ? ['sale'] : [])])];
      const attributeValues = Object.entries(p.attrs ?? {}).map(([code, val]) => {
        const ref = attrs.get(code);
        if (!ref) throw new Error(`Thuộc tính '${code}' chưa có trong DB`);
        return ref.inputType === 'select' ? { attributeId: ref.id, attributeValueId: ref.values.get(val) ?? null, customValue: null } : { attributeId: ref.id, attributeValueId: null, customValue: val };
      });
      const product = await prisma.product.create({
        data: {
          slug: p.slug, shopId: shop.id, name: p.name, categoryId, categorySlug: p.category,
          shortDescription: p.short, description: p.desc ?? p.short,
          basePrice: String(p.price), listPrice: p.listPrice ? String(p.listPrice) : null,
          status: 'active', isNew: Boolean(p.isNew), isFeatured: Boolean(p.featured), tags,
          soldCount: p.sold ?? 0, reviewCount: 0, avgRating: '0',
          publishedAt: new Date(now - (index % 75) * 86_400_000 - (index % 24) * 3_600_000),
          images: { create: imgs.map((img, k) => ({ url: img.url, publicId: img.publicId, alt: p.name, sortOrder: k, isPrimary: k === 0 })) },
          attributeValues: { create: attributeValues },
          variants: {
            create: variants.map((v) => ({
              sku: v.sku, shopId: shop.id, isActive: true, stock: 0, reserved: 0,
              price: v.delta === 0 ? null : String(p.price + v.delta),
              options: { create: v.options },
            })),
          },
        },
        select: { id: true, variants: { select: { id: true, sku: true } } },
      });
      const list = receipts.get(p.shop) ?? [];
      for (const v of product.variants) list.push({ variantId: v.id, productId: product.id, sku: v.sku, quantity: p.stock ?? 30, unitCost: Math.round(p.price * 0.6) });
      receipts.set(p.shop, list);
      created += 1;
    }
  }
  console.log(`   sản phẩm: ${index} (tạo mới ${created}, đồng bộ ảnh ${synced})`);

  for (const [shopSlug, items] of receipts) {
    const shop = shops.get(shopSlug)!;
    const count = await prisma.stockReceipt.count({ where: { shopId: shop.id } });
    const code = `PN-${shop.code.replace('SHOP-', '')}-${String(count + 1).padStart(3, '0')}`;
    await prisma.$transaction(
      async (tx) => {
        await tx.stockReceipt.create({
          data: {
            code, shopId: shop.id, supplierName: 'Nhà cung cấp (seed)', note: 'Nhập kho ban đầu — dữ liệu mẫu', status: 'posted', postedAt: new Date(),
            totalCost: String(items.reduce((s, it) => s + it.quantity * it.unitCost, 0)),
            items: { create: items.map((it) => ({ variantId: it.variantId, sku: it.sku, quantity: it.quantity, unitCost: String(it.unitCost) })) },
          },
        });
        for (const it of items) {
          await tx.productVariant.update({ where: { id: it.variantId }, data: { stock: it.quantity } });
          await tx.stockMovement.create({ data: { productId: it.productId, variantId: it.variantId, type: 'RECEIPT', quantity: it.quantity, stockAfter: it.quantity, refType: 'stock_receipt', refId: code, note: 'seed' } });
        }
      },
      { timeout: 60_000 },
    );
  }
  if (receipts.size > 0) console.log(`   phiếu nhập kho: ${receipts.size} (mỗi shop một phiếu, đã duyệt, có sổ kho)`);
}

/* ---------------------------------------------------------------- bộ sưu tập + số đếm */
async function seedCollections(prisma: PrismaClient, images: SeedImages, depts: DeptSeed[]): Promise<void> {
  // Bộ sưu tập cũ theo ngành "điện thoại" dùng slug khác slug ngành gốc → ẩn đi, thay bằng bộ sưu tập theo slug ngành gốc
  await prisma.collection.updateMany({ where: { slug: 'dien-thoai-cong-nghe', isDeleted: false }, data: { isDeleted: true, isActive: false } });
  let order = 10;
  for (const d of depts) {
    order += 1;
    const first = d.categories[0];
    if (!first) continue;
    const img = await tryResolve(images, `catalog/collections/${d.slug}.jpg`);
    const data = { name: d.name, tagline: d.description.slice(0, 190), queryCategorySlug: first.slug, sortOrder: order, isActive: true, ...(img ? { imageUrl: img.url, imagePublicId: img.publicId } : {}) };
    const found = await prisma.collection.findFirst({ where: { slug: d.slug, isDeleted: false }, select: { id: true } });
    if (found) await prisma.collection.update({ where: { id: found.id }, data });
    else await prisma.collection.create({ data: { slug: d.slug, ...data } });
  }
}

async function recount(prisma: PrismaClient, leafIds: Map<string, string>, shops: Map<string, { id: string }>): Promise<void> {
  for (const [slug, id] of leafIds) {
    const n = await prisma.product.count({ where: { categoryId: id, isDeleted: false, status: 'active' } });
    await prisma.category.update({ where: { id }, data: { productCount: n } });
    void slug;
  }
  for (const { id } of shops.values()) {
    const n = await prisma.product.count({ where: { shopId: id, isDeleted: false } });
    await prisma.shop.update({ where: { id }, data: { totalProducts: n } });
  }
}

export async function seed(prisma: PrismaClient): Promise<void> {
  const result = validateSeedData(DEPARTMENTS);
  for (const w of result.warnings) console.log(`   ! ${w}`);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`   ✗ ${e}`);
    throw new Error(`Dữ liệu mẫu có ${result.errors.length} lỗi — chạy "npm run seed:validate" để xem`);
  }
  const images = new SeedImages(loadEnv());
  console.log(`   ảnh: ${images.mode}`);
  const attrs = await seedAttributes(prisma, DEPARTMENTS);
  console.log(`   thuộc tính động: ${attrs.size}`);
  const leafIds = await seedCategories(prisma, images, DEPARTMENTS, attrs);
  console.log(`   ngành gốc: ${DEPARTMENTS.length}, ngành lá: ${leafIds.size}`);
  const shops = await seedShops(prisma, images);
  await seedProducts(prisma, images, DEPARTMENTS, attrs, leafIds, shops);
  await seedCollections(prisma, images, DEPARTMENTS);
  await recount(prisma, leafIds, shops);
  images.saveManifest();
  console.log(`   ảnh: link đóng gói sẵn ${images.packagedCount}, tái dùng ${images.reusedCount}, upload mới ${images.uploadedCount}`);
}
