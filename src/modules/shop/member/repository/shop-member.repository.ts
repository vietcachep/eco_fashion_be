import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';
import { SHOP_MEMBER_STATUS } from '../../foundation/shop.constants';

export const SHOP_MEMBER_SELECT = {
  id: true,
  shopId: true,
  userId: true,
  roleId: true,
  customPermissions: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ShopMemberSelect;

export type ShopMemberRow = Prisma.ShopMemberGetPayload<{ select: typeof SHOP_MEMBER_SELECT }>;

/*
 * Truy vấn bảng shop.shop_members — chỉ module shop. Mọi truy vấn TỰ động lọc theo `shopId` khi thao tác
 * trong phạm vi một gian hàng (Ownership Rule của PLAN-0014: shopId luôn suy từ ShopContextGuard, không
 * bao giờ tin shopId của URL/body khi không kèm kiểm tra thuộc gian hàng đang thao tác).
 */
@Injectable()
export class ShopMemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  /* Thành viên ACTIVE của user — dùng để suy `shopId` từ JWT (ShopContextGuard). Luật "mỗi người chỉ thuộc MỘT gian hàng active" có
     chốt DB `uq_shop_members_one_active_per_user` (unique một phần) nên tối đa một dòng; `orderBy createdAt` giữ lại cho dữ liệu cũ. */
  async findActiveByUserId(userId: string, tx?: Tx | null): Promise<ShopMemberRow | null> {
    return this.db(tx).shopMember.findFirst({ where: { userId, status: SHOP_MEMBER_STATUS.ACTIVE }, orderBy: { createdAt: 'asc' }, select: SHOP_MEMBER_SELECT });
  }

  /* Dòng thành viên (kể cả đã gỡ) của user trong shop — unique (shopId, userId) nên tối đa một dòng; dùng để KHÔI PHỤC nhân viên cũ khi chủ shop thêm lại. */
  async findAnyByShopAndUser(shopId: string, userId: string, tx?: Tx | null): Promise<ShopMemberRow | null> {
    return this.db(tx).shopMember.findUnique({ where: { shopId_userId: { shopId, userId } }, select: SHOP_MEMBER_SELECT });
  }

  /* Chỉ tìm trong ĐÚNG shop đang thao tác — controller/service PHẢI truyền shopId từ ShopContextGuard, không từ param. */
  async findByIdInShop(id: string, shopId: string, tx?: Tx | null): Promise<ShopMemberRow | null> {
    return this.db(tx).shopMember.findFirst({ where: { id, shopId }, select: SHOP_MEMBER_SELECT });
  }

  async listOfShop(shopId: string, skip: number, take: number, tx?: Tx | null): Promise<{ items: ShopMemberRow[]; total: number }> {
    const where: Prisma.ShopMemberWhereInput = { shopId };
    const [items, total] = await Promise.all([
      this.db(tx).shopMember.findMany({ where, select: SHOP_MEMBER_SELECT, orderBy: { createdAt: 'asc' }, skip, take }),
      this.db(tx).shopMember.count({ where }),
    ]);
    return { items, total };
  }

  /* Số thành viên ACTIVE của shop — chặn trần SHOP_MEMBER_MAX_ACTIVE; gọi SAU lockShopMembers để không bị vượt đồng thời. */
  async countActive(shopId: string, tx?: Tx | null): Promise<number> {
    return this.db(tx).shopMember.count({ where: { shopId, status: SHOP_MEMBER_STATUS.ACTIVE } });
  }

  /* Đếm thành viên active theo MỘT vai cụ thể — dùng chặn "gỡ/đổi vai/rời người chủ cuối cùng" (SHOP_ERR.LAST_OWNER).
     PHẢI gọi SAU lockActiveByRole trong cùng transaction thì số đếm mới đáng tin. */
  async countActiveByRole(shopId: string, roleId: string, tx?: Tx | null): Promise<number> {
    return this.db(tx).shopMember.count({ where: { shopId, roleId, status: SHOP_MEMBER_STATUS.ACTIVE } });
  }

  /*
   * Khoá (SELECT … FOR UPDATE) các dòng thành viên ACTIVE mang một vai của shop — bảng của chính schema shop. Mọi thao tác làm GIẢM
   * số chủ (đổi vai/gỡ/tự rời) gọi hàm này TRƯỚC khi đếm: hai chủ hạ nhau cùng lúc bị tuần tự hoá, người đến sau đếm lại thấy chỉ còn
   * một chủ → bị chặn, nên không bao giờ về 0 chủ. ORDER BY id để hai transaction khoá cùng thứ tự (tránh deadlock). Chỉ gọi trong transaction.
   */
  async lockActiveByRole(shopId: string, roleId: string, tx: Tx): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "shop"."shop_members" WHERE shop_id = ${shopId}::uuid AND role_id = ${roleId}::uuid AND status = ${SHOP_MEMBER_STATUS.ACTIVE} ORDER BY id FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  /*
   * Khoá tư vấn (pg_advisory_xact_lock, nhả khi commit) theo shop — tuần tự hoá các lần THÊM nhân viên của cùng một shop để trần
   * SHOP_MEMBER_MAX_ACTIVE không bị vượt khi hai request đến cùng lúc. Chỉ gọi trong transaction.
   */
  async lockShopMembers(shopId: string, tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop-member-add:${shopId}`}))`;
  }

  async create(data: Prisma.ShopMemberUncheckedCreateInput, tx?: Tx | null): Promise<ShopMemberRow> {
    return this.db(tx).shopMember.create({ data, select: SHOP_MEMBER_SELECT });
  }

  async update(id: string, data: Prisma.ShopMemberUncheckedUpdateInput, tx?: Tx | null): Promise<ShopMemberRow> {
    return this.db(tx).shopMember.update({ where: { id }, data, select: SHOP_MEMBER_SELECT });
  }
}
