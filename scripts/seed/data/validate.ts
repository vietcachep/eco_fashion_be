/*
 * Kiểm dữ liệu mẫu THUẦN (không đụng DB) — chạy bằng `npm run seed:validate`. Lỗi (errors) thì seeder từ chối ghi; cảnh báo (warnings)
 * chỉ để người viết dữ liệu chú ý. Quy tắc phản chiếu đúng luật của ProductService.resolveVariantsDynamic (PLAN-0016): trục biến thể của
 * sản phẩm phải KHỚP CHÍNH XÁC tập trục `isVariantAxis` của ngành lá — không thiếu, không thừa.
 */
import { BASE_ATTRIBUTES } from './attributes';
import { DEPARTMENTS } from './dept';
import { DEPT_SLUGS, SHOPS } from './shops';
import { THEMES, type DeptSeed, type SeedAttribute, type SeedAxisValue, type SeedShopDef } from './types';

/* Slug 7 ngành thời trang cũ (catalog.seed.ts) + shop — ngành mới không được trùng */
const LEGACY_FASHION_SLUGS = ['ao-thun', 'ao-so-mi', 'quan-jean', 'quan-short', 'vay', 'dam', 'ao-khoac'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_VARIANTS = 24;

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  stats: { departments: number; leaves: number; products: number; variants: number; images: number; shops: number };
}

export const axisValueName = (v: SeedAxisValue): string => (typeof v === 'string' ? v : v.v);

/* Hợp thuộc tính chung + riêng của từng ngành (cùng `code` thì gộp `values`). Dùng chung với seeder. */
export function mergeAttributes(depts: DeptSeed[]): Map<string, SeedAttribute> {
  const out = new Map<string, SeedAttribute>();
  const add = (a: SeedAttribute) => {
    const cur = out.get(a.code);
    if (!cur) {
      out.set(a.code, { ...a, values: [...(a.values ?? [])], hex: a.hex ? { ...a.hex } : undefined });
      return;
    }
    cur.values = [...new Set([...(cur.values ?? []), ...(a.values ?? [])])];
    if (a.hex) cur.hex = { ...(cur.hex ?? {}), ...a.hex };
  };
  for (const a of BASE_ATTRIBUTES) add(a);
  for (const d of depts) for (const a of d.attributes ?? []) add(a);
  return out;
}

export function validateSeedData(depts: DeptSeed[] = DEPARTMENTS): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);

  // ---- thuộc tính: kiểm xung đột kiểu giữa các nơi khai cùng mã ----
  const typeByCode = new Map<string, string>();
  for (const a of [...BASE_ATTRIBUTES, ...depts.flatMap((d) => d.attributes ?? [])]) {
    const t = typeByCode.get(a.code);
    if (t && t !== a.inputType) err(`Thuộc tính '${a.code}' khai hai kiểu khác nhau (${t} vs ${a.inputType})`);
    typeByCode.set(a.code, a.inputType);
  }
  const attrs = mergeAttributes(depts);

  const shopBySlug = new Map<string, SeedShopDef>((SHOPS as readonly SeedShopDef[]).map((s) => [s.slug, s]));
  const shopCodes = new Set<string>();
  for (const s of SHOPS) {
    if (shopCodes.has(s.code)) err(`Trùng mã shop ${s.code}`);
    shopCodes.add(s.code);
    for (const d of s.depts) if (!(DEPT_SLUGS as readonly string[]).includes(d)) err(`Shop '${s.slug}' bán ngành không tồn tại '${d}'`);
  }

  const deptSlugs = new Set<string>();
  const leafSlugs = new Set<string>();
  const productSlugs = new Set<string>();
  const skuNames = new Set<string>();
  let leaves = 0;
  let products = 0;
  let variants = 0;
  let images = 0;

  for (const d of depts) {
    const dp = `[${d.slug}]`;
    if (!(DEPT_SLUGS as readonly string[]).includes(d.slug)) err(`${dp} slug ngành gốc không nằm trong DEPT_SLUGS`);
    if (deptSlugs.has(d.slug)) err(`${dp} trùng ngành gốc`);
    deptSlugs.add(d.slug);
    if (!SLUG_RE.test(d.slug)) err(`${dp} slug sai định dạng`);
    if (!(d.theme in THEMES)) err(`${dp} theme '${d.theme}' không hợp lệ`);
    if (!d.icon) err(`${dp} thiếu icon`);

    const leafBySlug = new Map(d.categories.map((c) => [c.slug, c]));
    for (const c of d.categories) {
      leaves += 1;
      const cp = `${dp}/${c.slug}`;
      if (!SLUG_RE.test(c.slug)) err(`${cp} slug ngành lá sai định dạng`);
      if (leafSlugs.has(c.slug) || deptSlugs.has(c.slug) || LEGACY_FASHION_SLUGS.includes(c.slug)) err(`${cp} slug ngành lá trùng ngành khác`);
      leafSlugs.add(c.slug);
      if (!(c.theme in THEMES)) err(`${cp} theme '${c.theme}' không hợp lệ`);
      if (!c.icon) err(`${cp} thiếu icon`);
      const axisCount = c.attrs.filter((a) => a.axis).length;
      if (axisCount > 2) err(`${cp} có ${axisCount} trục biến thể (tối đa 2)`);
      const seen = new Set<string>();
      for (const a of c.attrs) {
        if (seen.has(a.code)) err(`${cp} khai trùng thuộc tính '${a.code}'`);
        seen.add(a.code);
        const def = attrs.get(a.code);
        if (!def) err(`${cp} dùng thuộc tính chưa khai '${a.code}'`);
        else if (a.axis && def.inputType !== 'select') err(`${cp} trục '${a.code}' phải là thuộc tính select`);
      }
    }

    for (const p of d.products) {
      products += 1;
      const pp = `${dp}/${p.slug}`;
      if (!SLUG_RE.test(p.slug) || p.slug.length > 120) err(`${pp} slug sai định dạng / quá dài`);
      if (productSlugs.has(p.slug)) err(`${pp} trùng slug sản phẩm`);
      productSlugs.add(p.slug);
      if (p.name.trim().length < 5 || p.name.length > 200) err(`${pp} tên 5–200 ký tự`);
      if (!Number.isInteger(p.price) || p.price <= 0) err(`${pp} price phải là số nguyên > 0`);
      else if (p.price % 1000 !== 0 && p.price % 100 !== 0) warn(`${pp} giá ${p.price} nên tròn trăm/nghìn`);
      if (p.listPrice !== undefined && !(p.listPrice > p.price)) err(`${pp} listPrice phải > price (hoặc bỏ)`);
      if (p.short.length < 10 || p.short.length > 200) err(`${pp} short 10–200 ký tự`);
      if ((p.desc ?? '').length > 3000) err(`${pp} desc quá dài`);
      if (p.stock !== undefined && (!Number.isInteger(p.stock) || p.stock < 0 || p.stock > 9999)) err(`${pp} stock 0–9999`);
      if (p.sold !== undefined && (!Number.isInteger(p.sold) || p.sold < 0)) err(`${pp} sold phải là số nguyên ≥ 0`);
      if (!p.img?.emoji) err(`${pp} thiếu img.emoji`);
      if (!(p.img?.theme in THEMES)) err(`${pp} img.theme không hợp lệ`);
      images += 2;

      const shop = shopBySlug.get(p.shop);
      if (!shop) err(`${pp} shop '${p.shop}' không tồn tại`);
      else {
        if (!shop.depts.includes(d.slug)) err(`${pp} shop '${p.shop}' không bán ngành '${d.slug}' (xem shops.ts)`);
        if (shop.status === 'pending' || shop.status === 'rejected') err(`${pp} shop '${p.shop}' chưa/không được duyệt — không có sản phẩm`);
      }

      const leaf = leafBySlug.get(p.category);
      if (!leaf) {
        err(`${pp} category '${p.category}' không phải ngành lá của '${d.slug}'`);
        continue;
      }
      const tmpl = new Map(leaf.attrs.map((a) => [a.code, a]));
      const axisCodes = leaf.attrs.filter((a) => a.axis).map((a) => a.code);

      // thuộc tính không-trục
      for (const [code, val] of Object.entries(p.attrs ?? {})) {
        const t = tmpl.get(code);
        const def = attrs.get(code);
        if (!t) err(`${pp} attrs.${code} không có trong mẫu của ngành lá '${leaf.slug}'`);
        else if (t.axis) err(`${pp} attrs.${code} là TRỤ biến thể — khai ở axes, không khai ở attrs`);
        if (def?.inputType === 'select' && !(def.values ?? []).includes(val)) err(`${pp} attrs.${code}='${val}' không có trong danh sách giá trị`);
        if (def?.inputType === 'number' && Number.isNaN(Number(val))) err(`${pp} attrs.${code}='${val}' không phải số`);
        if (!val.trim()) err(`${pp} attrs.${code} rỗng`);
      }
      for (const a of leaf.attrs) if (a.required && !a.axis && !(p.attrs ?? {})[a.code]) err(`${pp} thiếu thuộc tính bắt buộc '${a.code}'`);

      // trục biến thể: khớp chính xác tập trục của ngành lá
      const axes = p.axes ?? [];
      if (axes.length > 2) err(`${pp} tối đa 2 trục`);
      const gotAxes = axes.map((a) => a.attr).sort().join(',');
      const wantAxes = [...axisCodes].sort().join(',');
      if (gotAxes !== wantAxes) err(`${pp} trục [${gotAxes}] không khớp mẫu ngành lá [${wantAxes}]`);
      let count = 1;
      for (const ax of axes) {
        const def = attrs.get(ax.attr);
        if (ax.values.length === 0) err(`${pp} trục '${ax.attr}' không có giá trị`);
        const names = ax.values.map(axisValueName);
        if (new Set(names).size !== names.length) err(`${pp} trục '${ax.attr}' trùng giá trị`);
        for (const n of names) if (def && !(def.values ?? []).includes(n)) err(`${pp} trục ${ax.attr}='${n}' không có trong danh sách giá trị`);
        count *= Math.max(ax.values.length, 1);
      }
      if (count > MAX_VARIANTS) err(`${pp} ${count} biến thể (> ${MAX_VARIANTS})`);
      variants += axes.length === 0 ? 1 : count;
    }
    if (d.products.length === 0) warn(`${dp} chưa có sản phẩm`);
    if (d.categories.length === 0) warn(`${dp} chưa có ngành lá`);
  }

  for (const slug of DEPT_SLUGS) if (!deptSlugs.has(slug)) err(`Thiếu file dữ liệu cho ngành gốc '${slug}'`);
  void skuNames;

  return { errors, warnings, stats: { departments: depts.length, leaves, products, variants, images, shops: SHOPS.length } };
}
