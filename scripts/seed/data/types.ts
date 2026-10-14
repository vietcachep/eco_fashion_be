/*
 * DSL dữ liệu mẫu sàn đa ngành hàng (PLAN-0017, Track D). Mỗi NGÀNH HÀNG GỐC một file `dept/<slug>.ts` export `DeptSeed`:
 * chỉ là DỮ LIỆU THUẦN (không đụng DB) — seeder tổng quát `marketplace.seed.ts` đọc và ghi, `validate.ts` kiểm trước khi ghi.
 * Mọi ngành ở đây là mode `dynamic` (thuộc tính động — PLAN-0016); 7 ngành thời trang cũ giữ ở catalog.seed.ts/product.seed.ts.
 */
import type { ShopSlug } from './shops';

/* Bảng màu nền của ảnh minh hoạ tự sinh (tools/gen_images.py đọc [màu trên, màu dưới] từ manifest). */
export const THEMES = {
  indigo: ['#6366f1', '#1e1b4b'],
  coral: ['#ff8a7a', '#d64433'],
  amber: ['#fbbf78', '#b45309'],
  emerald: ['#34d399', '#065f46'],
  rose: ['#f4a3c1', '#9d174d'],
  sky: ['#7dd3fc', '#0369a1'],
  slate: ['#94a3b8', '#1e293b'],
  violet: ['#c4b5fd', '#5b21b6'],
  teal: ['#5eead4', '#115e59'],
  lime: ['#bef264', '#4d7c0f'],
  orange: ['#fdba74', '#c2410c'],
  fuchsia: ['#f0abfc', '#a21caf'],
  brown: ['#d6b08c', '#5c3a21'],
  navy: ['#60a5fa', '#172554'],
  mint: ['#a7f3d0', '#047857'],
  sand: ['#f5e6c8', '#a16207'],
} as const satisfies Record<string, readonly [string, string]>;
export type ThemeName = keyof typeof THEMES;

export type AttrInputType = 'select' | 'text' | 'number';

/* Thuộc tính động dùng chung. `select`: liệt kê `values` (thêm giá trị mới = chỉ cần thêm vào đây, seeder tự bổ sung vào DB).
   Hai thuộc tính cùng `code` ở nhiều file được GỘP (hợp các `values`). */
export interface SeedAttribute {
  code: string;
  name: string;
  inputType: AttrInputType;
  values?: string[];
  /* Màu hiển thị theo giá trị (chỉ thuộc tính màu): { 'Đỏ': '#ff0000' } */
  hex?: Record<string, string>;
}

export interface SeedCategoryAttr {
  code: string;
  required?: boolean;
  /* Trục tạo biến thể — TỐI ĐA 2 trục / ngành lá (đã chốt PLAN-0016) */
  axis?: boolean;
}

/* Ngành LÁ (con của ngành gốc = DeptSeed). Sản phẩm chỉ được gán vào ngành lá. */
export interface SeedCategory {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  icon: string;
  theme: ThemeName;
  attrs: SeedCategoryAttr[];
}

/* Giá trị một trục biến thể: chuỗi (không đổi giá) hoặc { v, delta } — cộng thêm `delta` VND vào giá bán của biến thể. */
export type SeedAxisValue = string | { v: string; delta?: number };
export interface SeedAxis {
  /* mã thuộc tính (phải là `axis` trong mẫu ngành lá của sản phẩm) */
  attr: string;
  values: SeedAxisValue[];
}

export interface SeedProduct {
  slug: string;
  name: string;
  /* gian hàng bán — phải là shop có bán ngành gốc này (xem `shops.ts`) */
  shop: ShopSlug;
  /* slug ngành LÁ */
  category: string;
  /* giá bán VND (số nguyên, > 0); listPrice > price thì hiện giảm giá */
  price: number;
  listPrice?: number;
  short: string;
  desc?: string;
  tags?: string[];
  /* Thuộc tính KHÔNG tạo biến thể: mã → giá trị (select: phải có trong `values`; text/number: tự do) */
  attrs?: Record<string, string>;
  /* Tối đa 2 trục; biến thể = tích Descartes. Bỏ trống = sản phẩm 1 biến thể. */
  axes?: SeedAxis[];
  /* tồn mỗi biến thể (mặc định 30) */
  stock?: number;
  /* số đã bán (hiển thị + xếp hạng bán chạy; mặc định 0) */
  sold?: number;
  isNew?: boolean;
  featured?: boolean;
  /* Ảnh minh hoạ tự sinh: emoji đúng loại hàng + bảng màu. `emoji2` = biểu tượng phụ ở ảnh thứ hai. `query` = từ khoá
     tiếng Anh cho `seed:images:pexels` (ảnh thật) — nên điền cụ thể ("running shoes", "air fryer"). */
  img: { emoji: string; theme: ThemeName; emoji2?: string; query?: string };
}

/* Một NGÀNH HÀNG GỐC (department). Seeder tạo category gốc từ meta này + các ngành lá trong `categories`. */
export interface DeptSeed {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  icon: string;
  theme: ThemeName;
  /* thuộc tính riêng của ngành (bổ sung/gộp vào bộ thuộc tính chung) */
  attributes?: SeedAttribute[];
  categories: SeedCategory[];
  products: SeedProduct[];
}

export interface SeedShopOwner {
  email: string;
  fullName: string;
  phone: string;
}

export interface SeedShopDef {
  slug: string;
  /* SHOP-0000NN — FITLY Official giữ SHOP-000001 */
  code: string;
  name: string;
  description: string;
  status: 'approved' | 'pending' | 'suspended' | 'rejected';
  commissionRate: number;
  codEnabled: boolean;
  owner: SeedShopOwner;
  /* nhân viên (vai shop_staff) — tuỳ chọn */
  staff?: readonly SeedShopOwner[];
  /* slug các ngành GỐC gian hàng này bán (dùng để kiểm sản phẩm gán đúng shop) */
  depts: readonly string[];
  emoji: string;
  theme: ThemeName;
}
