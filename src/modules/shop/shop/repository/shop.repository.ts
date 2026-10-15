import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const SHOP_SELECT = {
  id: true,
  code: true,
  slug: true,
  name: true,
  logoUrl: true,
  bannerUrl: true,
  description: true,
  status: true,
  commissionRate: true,
  bankCode: true,
  bankAccountNumber: true,
  bankAccountName: true,
  ratingAvg: true,
  totalProducts: true,
  ownerUserId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ShopSelect;

export type ShopRow = Prisma.ShopGetPayload<{ select: typeof SHOP_SELECT }>;

export interface ShopListFilter {
  status?: string;
  q?: string;
}

/* Truy vấn bảng shop.shops — chỉ module shop (Cross-Module Read/Write Rule). */
@Injectable()
export class ShopRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async findById(id: string, tx?: Tx | null): Promise<ShopRow | null> {
    return this.db(tx).shop.findFirst({ where: { id, isDeleted: false }, select: SHOP_SELECT });
  }

  async findByCode(code: string, tx?: Tx | null): Promise<ShopRow | null> {
    return this.db(tx).shop.findFirst({ where: { code, isDeleted: false }, select: SHOP_SELECT });
  }

  /* Trang gian hàng công khai: chỉ shop ĐÃ DUYỆT (pending/suspended/rejected không lộ ra web bán hàng). */
  async findApprovedBySlug(slug: string): Promise<ShopRow | null> {
    return this.prisma.shop.findFirst({ where: { slug, status: 'approved', isDeleted: false }, select: SHOP_SELECT });
  }

  async listApproved(q: string | undefined, skip: number, take: number): Promise<{ items: ShopRow[]; total: number }> {
    const where: Prisma.ShopWhereInput = { status: 'approved', isDeleted: false, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.shop.findMany({ where, orderBy: [{ ratingAvg: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }], skip, take, select: SHOP_SELECT }),
      this.prisma.shop.count({ where }),
    ]);
    return { items, total };
  }

  /*
   * Shop KHÔNG được bán công khai (chờ duyệt / bị khoá / từ chối) — product dùng để ẩn hàng khỏi danh sách và chi tiết (`shopId NOT IN (...)`).
   * Chỉ tính shop ĐÃ TỪNG có thành viên (`members.some`): hồ sơ tự đăng ký (PLAN-0019) chưa duyệt/đã bị từ chối chưa bao giờ có thành viên nên
   * không thể có sản phẩm; nếu để lọt vào đây thì mỗi lượt đăng ký thêm một id vào MỌI truy vấn sản phẩm công khai (phình `NOT IN`, chậm dần).
   */
  async listNonApprovedIds(): Promise<string[]> {
    const rows = await this.prisma.shop.findMany({ where: { isDeleted: false, status: { not: 'approved' }, members: { some: {} } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async findByIds(ids: string[]): Promise<ShopRow[]> {
    return this.prisma.shop.findMany({ where: { id: { in: ids }, isDeleted: false }, select: SHOP_SELECT });
  }

  /* Khoá dòng (FOR UPDATE) trước khi kiểm/chuyển trạng thái — tránh 2 admin duyệt/khoá cùng lúc race nhau. */
  async findByIdForUpdate(id: string, tx: Tx): Promise<ShopRow | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "shop"."shops" WHERE id = ${id} AND is_deleted = false FOR UPDATE`;
    return rows[0] ? tx.shop.findUnique({ where: { id: rows[0].id }, select: SHOP_SELECT }) : null;
  }

  async findByOwnerUserId(ownerUserId: string, tx?: Tx | null): Promise<ShopRow[]> {
    return this.db(tx).shop.findMany({ where: { ownerUserId, isDeleted: false }, select: SHOP_SELECT, orderBy: { createdAt: 'desc' } });
  }

  async codeExists(code: string, tx?: Tx | null): Promise<boolean> {
    const n = await this.db(tx).shop.count({ where: { code: { equals: code, mode: 'insensitive' }, isDeleted: false } });
    return n > 0;
  }

  async slugExists(slug: string, tx?: Tx | null): Promise<boolean> {
    const n = await this.db(tx).shop.count({ where: { slug: { equals: slug, mode: 'insensitive' }, isDeleted: false } });
    return n > 0;
  }

  async list(filter: ShopListFilter, skip: number, take: number): Promise<{ items: ShopRow[]; total: number }> {
    const where: Prisma.ShopWhereInput = {
      isDeleted: false,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q ? { OR: [{ code: { contains: filter.q, mode: 'insensitive' } }, { name: { contains: filter.q, mode: 'insensitive' } }, { slug: { contains: filter.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.shop.findMany({ where, select: SHOP_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.shop.count({ where }),
    ]);
    return { items, total };
  }

  async create(data: Prisma.ShopUncheckedCreateInput, tx?: Tx | null): Promise<ShopRow> {
    return this.db(tx).shop.create({ data, select: SHOP_SELECT });
  }

  async update(id: string, data: Prisma.ShopUncheckedUpdateInput, tx?: Tx | null): Promise<ShopRow> {
    return this.db(tx).shop.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: SHOP_SELECT });
  }
}
