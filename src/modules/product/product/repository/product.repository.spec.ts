import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '@common/prisma/prisma.service';
import { ProductRepository } from './product.repository';

const SHOP = '3f2b8c1e-5d4a-4f6b-9a7c-1e2d3c4b5a69';

/* Gom mọi giá trị ràng buộc (kể cả trong các mảnh Prisma.sql lồng nhau) và mọi mảnh chuỗi SQL của một lần gọi $queryRaw. */
function collect(args: unknown[]): { values: unknown[]; text: string } {
  const values: unknown[] = [];
  const text: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'object' && v !== null && 'values' in v && 'strings' in v && Array.isArray((v as { values: unknown[] }).values)) {
      text.push(...(v as unknown as { strings: string[] }).strings);
      for (const x of (v as { values: unknown[] }).values) walk(x);
    } else if (Array.isArray(v)) {
      text.push(...v.filter((x): x is string => typeof x === 'string'));
    } else values.push(v);
  };
  args.forEach(walk);
  return { values, text: text.join(' ') };
}

describe('ProductRepository.searchIds / list — M15: phạm vi shop nằm TRONG câu SQL tìm kiếm', () => {
  const queryRaw = jest.fn<Promise<Array<{ id: string }>>, unknown[]>();
  let repo: ProductRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    queryRaw.mockResolvedValue([]);
    repo = new ProductRepository({ $queryRaw: queryRaw } as unknown as PrismaService);
  });

  it('listShop gửi shopId/status/ngành vào SQL tìm kiếm (không lọc SAU khi đã cắt 500 id toàn sàn)', async () => {
    const r = await repo.list({ publicOnly: false, q: 'áo', shopId: SHOP, status: 'active', categorySlug: 'ao-thun' }, 0, 10);

    expect(r).toEqual({ items: [], total: 0 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { values, text } = collect(queryRaw.mock.calls[0]);
    expect(values).toEqual(expect.arrayContaining([SHOP, 'active', 'ao-thun']));
    expect(text).toContain('shop_id');
    expect(text).toContain('LIMIT 500');
  });

  it('tìm kiếm không phạm vi (admin/công khai) không thêm điều kiện shop; công khai chỉ active, bỏ qua status do client gửi', async () => {
    await repo.searchIds('áo', false);
    let c = collect(queryRaw.mock.calls[0]);
    expect(c.text).not.toContain('shop_id');
    expect(c.values).not.toContain(SHOP);

    queryRaw.mockClear();
    await repo.searchIds('áo', true, { status: 'draft' });
    c = collect(queryRaw.mock.calls[0]);
    expect(c.text).toContain("status = 'active'");
    expect(c.values).not.toContain('draft');
  });
});

describe('H9 — SKU unique theo gian hàng (schema + migration)', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', '..');
  const productSchema = readFileSync(join(ROOT, 'prisma', 'schema', 'product.prisma'), 'utf8');

  it('product.prisma KHÔNG khai @@unique([shopId, sku]) (nó tính cả bản xoá mềm và sẽ làm migrate sinh lại unique không partial)', () => {
    // Bỏ comment trước khi so khớp — chính chú thích trong schema nhắc tới @@unique([shopId, sku]) để giải thích vì sao KHÔNG khai.
    const variant = (/model ProductVariant \{[\s\S]*?\n\}/.exec(productSchema)?.[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(variant).not.toBe('');
    expect(variant).not.toMatch(/@@unique\(\[\s*shopId\s*,\s*sku\s*\]\)/);
    expect(variant).toMatch(/@@unique\(\[productId, colorCode, sizeCode\]\)/);
  });

  it('migration mới nhất của SKU: gỡ unique(sku) toàn sàn + unique(shop_id, sku) cũ, tạo unique partial (shop_id, sku) WHERE is_deleted = false', () => {
    const dir = readdirSync(join(ROOT, 'prisma', 'migrations')).find((d) => d.endsWith('_product_variant_sku_per_shop'));
    expect(dir).toBeDefined();
    const sql = readFileSync(join(ROOT, 'prisma', 'migrations', dir ?? '', 'migration.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/DROP INDEX IF EXISTS "product"\."uq_product_variants_sku_active"/);
    expect(sql).toMatch(/UNIQUE \(shop_id, sku\)/); // gỡ constraint theo định nghĩa, không đoán tên
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_product_variants_shop_sku_active"\s+ON "product"\."product_variants" \("shop_id", "sku"\)\s+WHERE "is_deleted" = false/);
  });
});
