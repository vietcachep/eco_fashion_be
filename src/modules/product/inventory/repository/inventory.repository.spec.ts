import type { PrismaService } from '@common/prisma/prisma.service';
import type { Prisma, Tx } from '@common/prisma/types';
import { InventoryRepository } from './inventory.repository';

/* Biến thể giả cho bảng tồn: hai gian hàng xen kẽ nhau. */
interface FakeVariant {
  id: string;
  sku: string;
  stock: number;
  shopId: string;
  productName: string;
}

/* Phần của where/orderBy mà bản giả hiểu — đúng những khoá repository.listStock dùng. */
interface FakeWhere {
  shopId?: string;
  stock?: { lte: number };
  OR?: Array<{ sku?: { contains: string }; product?: { name: { contains: string } } }>;
}
interface FakeFindArgs {
  where: FakeWhere;
  skip?: number;
  take?: number;
}

function buildDataset(): FakeVariant[] {
  const rows: FakeVariant[] = [];
  // shop-A: 45 biến thể, shop-B: 30 biến thể — xen kẽ để lọc trong bộ nhớ sau khi cắt trang chắc chắn sai.
  for (let i = 0; i < 75; i++) {
    const shopId = i % 5 < 3 ? 'shop-A' : 'shop-B';
    rows.push({ id: `v-${String(i).padStart(3, '0')}`, sku: `${shopId === 'shop-A' ? 'A' : 'B'}-${String(i).padStart(4, '0')}`, stock: i % 7, shopId, productName: `Sản phẩm ${i}` });
  }
  return rows;
}

/* Prisma giả áp where/skip/take thật lên dataset → nếu repository KHÔNG đẩy shopId xuống where thì total/trang sai và test đỏ. */
function fakePrisma(dataset: FakeVariant[]) {
  const matches = (v: FakeVariant, where: FakeWhere): boolean => {
    if (where.shopId && v.shopId !== where.shopId) return false;
    if (where.stock && v.stock > where.stock.lte) return false;
    if (where.OR) {
      const q = (where.OR[0]?.sku?.contains ?? '').toLowerCase();
      if (!v.sku.toLowerCase().includes(q) && !v.productName.toLowerCase().includes(q)) return false;
    }
    return true;
  };
  const findMany = jest.fn((args: FakeFindArgs) => {
    const sorted = dataset.filter((v) => matches(v, args.where)).sort((a, b) => a.stock - b.stock || a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id));
    return Promise.resolve(sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length)));
  });
  const count = jest.fn((args: { where: FakeWhere }) => Promise.resolve(dataset.filter((v) => matches(v, args.where)).length));
  return { prisma: { productVariant: { findMany, count } } as unknown as PrismaService, findMany, count };
}

describe('InventoryRepository.listStock — phân trang theo shop ở DB (H4)', () => {
  const base = { threshold: 3 };

  it('trang 1/2/3 của shop-A đầy đủ, total = 45 và không lẫn biến thể shop-B', async () => {
    const { prisma } = fakePrisma(buildDataset());
    const repo = new InventoryRepository(prisma);

    const p1 = await repo.listStock({ ...base, skip: 0, take: 20, shopId: 'shop-A' });
    const p2 = await repo.listStock({ ...base, skip: 20, take: 20, shopId: 'shop-A' });
    const p3 = await repo.listStock({ ...base, skip: 40, take: 20, shopId: 'shop-A' });

    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([20, 20, 5]);
    expect([p1.total, p2.total, p3.total]).toEqual([45, 45, 45]);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((v) => v.id);
    expect(new Set(ids).size).toBe(45); // không trùng/thiếu giữa các trang
    expect([...p1.items, ...p2.items, ...p3.items].every((v) => (v as unknown as FakeVariant).shopId === 'shop-A')).toBe(true);
  });

  it('shop-B có tập riêng (30), không phụ thuộc shop-A; không shopId (nhân viên sàn) thấy cả 75', async () => {
    const { prisma } = fakePrisma(buildDataset());
    const repo = new InventoryRepository(prisma);

    const b = await repo.listStock({ ...base, skip: 20, take: 20, shopId: 'shop-B' });
    const all = await repo.listStock({ ...base, skip: 0, take: 100 });

    expect(b.items).toHaveLength(10);
    expect(b.total).toBe(30);
    expect(all.total).toBe(75);
  });

  it('tìm kiếm + lowStockOnly cũng áp trong phạm vi shop (count khớp)', async () => {
    const { prisma, findMany, count } = fakePrisma(buildDataset());
    const repo = new InventoryRepository(prisma);

    const low = await repo.listStock({ ...base, skip: 0, take: 100, shopId: 'shop-A', lowStockOnly: true });
    const search = await repo.listStock({ ...base, skip: 0, take: 100, shopId: 'shop-B', q: 'B-0003' });

    expect(low.items.every((v) => v.stock <= 3)).toBe(true);
    expect(low.total).toBe(low.items.length);
    expect(search.items.map((v) => v.sku)).toEqual(['B-0003']);
    expect(search.total).toBe(1);
    // findMany và count dùng CÙNG where (có shopId) — nguồn gốc total đúng.
    const [findArgs] = findMany.mock.calls[findMany.mock.calls.length - 1];
    const [countArgs] = count.mock.calls[count.mock.calls.length - 1];
    expect(countArgs.where).toEqual(findArgs.where);
    expect(findArgs.where.shopId).toBe('shop-B');
  });
});

describe('InventoryRepository.nextReceiptCode — cấp mã dưới khoá (M3)', () => {
  it('khoá advisory theo transaction TRƯỚC khi đọc số lớn nhất; mã = MAX + 1, đệm 5 chữ số', async () => {
    const executeRaw = jest.fn<Promise<number>, [TemplateStringsArray, ...unknown[]]>().mockResolvedValue(1);
    const queryRaw = jest.fn<Promise<Array<{ n: bigint }>>, [TemplateStringsArray, ...unknown[]]>().mockResolvedValue([{ n: 41n }]);
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw } as unknown as Tx;
    const repo = new InventoryRepository({} as PrismaService);

    const code = await repo.nextReceiptCode(tx);

    const d = new Date();
    expect(code).toBe(`PN${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}00042`);
    expect(executeRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0]);
  });

  it('chưa có phiếu nào đúng mẫu (MAX = 0) → bắt đầu từ 00001', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn().mockResolvedValue([{ n: 0n }]) } as unknown as Tx;

    const code = await new InventoryRepository({} as PrismaService).nextReceiptCode(tx);

    expect(code.endsWith('00001')).toBe(true);
  });
});

describe('InventoryRepository.lockVariants — khoá cả biến thể xoá mềm khi cần (H1)', () => {
  /* Chữ SQL thực tế gắn vào truy vấn khoá: Prisma.empty.sql = '' (không lọc), Prisma.sql`AND is_deleted = false`.sql = điều kiện lọc. */
  async function filterSql(opts?: { includeDeleted?: boolean }): Promise<string> {
    const queryRaw = jest.fn<Promise<unknown[]>, [TemplateStringsArray, ...unknown[]]>().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw } as unknown as Tx;

    await new InventoryRepository({} as PrismaService).lockVariants(['v1'], tx, opts);

    const [, , fragment] = queryRaw.mock.calls[0];
    return (fragment as Prisma.Sql).sql;
  }

  it('mặc định bỏ biến thể xoá mềm (nhập kho, điều chỉnh, giữ hàng)', async () => {
    expect(await filterSql()).toContain('is_deleted = false');
  });

  it('includeDeleted → không lọc is_deleted (nhả/hoàn/trừ kho cho đơn cũ)', async () => {
    expect(await filterSql({ includeDeleted: true })).toBe('');
  });

  it('không có id → không truy vấn', async () => {
    const queryRaw = jest.fn();
    const tx = { $queryRaw: queryRaw } as unknown as Tx;

    expect(await new InventoryRepository({} as PrismaService).lockVariants([], tx)).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
