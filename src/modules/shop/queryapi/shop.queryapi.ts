import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { effectiveShopPermissions, FITLY_OFFICIAL_SHOP_CODE, SHOP_AUDIT, SHOP_BANK_STATUS, SHOP_STATUS, SHOP_MEMBER_STATUS } from '../foundation/shop.constants';
import { ShopRepository } from '../shop/repository/shop.repository';

/* QueryAPI của shop — cổng ĐỌC cho module khác (product/order/promotion/review ở PLAN-0014 bước 5+). */
export interface ShopBrief {
  id: string;
  code: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  ratingAvg: number | null;
  status: string;
  commissionRate: string;
  shippingCarrierEnabled?: boolean;
  shippingPickup?: unknown;
  shippingReturn?: unknown;
}

/* Hồ sơ CÔNG KHAI của gian hàng đã duyệt (web bán hàng: trang shop). Không chứa hoa hồng/ngân hàng/chủ sở hữu. */
export interface ShopPublicProfile {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  ratingAvg: number | null;
}

export interface BankAccount {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /*
   * Mốc BẮT ĐẦU đếm thời gian tạm giữ chi trả sau đổi TK: lần ĐỔI gần nhất (nhật ký SHOP_BANK_UPDATED) — hoặc, nếu quản lý sàn đã xác minh TK sau lần đổi đó, mốc XÁC MINH (PLAN-0040 5.2);
   * null = chưa từng đổi sau khi khai. Payout dùng để tạm giữ chi trả sau khi đổi TK.
   */
  changedAt: Date | null;
  /* true = tên chủ TK lệch tên chủ shop và quản lý sàn CHƯA xác minh ⇒ payout KHÔNG chi (kỳ `held`), bất kể đã qua thời gian giữ. */
  pendingVerification: boolean;
}

@Injectable()
export class ShopQueryApi {
  constructor(
    private readonly shops: ShopRepository,
    private readonly prisma: PrismaService,
    private readonly identity: IdentityQueryApi,
  ) {}

  async findBrief(shopId: string): Promise<ShopBrief | null> {
    const s = await this.shops.findById(shopId);
    return s ? ShopQueryApi.toBrief(s) : null;
  }

  /* Hồ sơ công khai theo slug — CHỈ shop đã duyệt (còn lại trả null ⇒ 404 ở web bán hàng). */
  async findPublicBySlug(slug: string): Promise<ShopPublicProfile | null> {
    const s = await this.shops.findApprovedBySlug(slug);
    return s ? ShopQueryApi.toPublic(s) : null;
  }

  async listPublic(q: string | undefined, skip: number, take: number): Promise<{ items: ShopPublicProfile[]; total: number }> {
    const { items, total } = await this.shops.listApproved(q, skip, take);
    return { items: items.map((s) => ShopQueryApi.toPublic(s)), total };
  }

  /* Id các shop không được bán công khai — hàng của các shop này bị ẩn khỏi danh sách/chi tiết sản phẩm. */
  async nonApprovedShopIds(): Promise<string[]> {
    return this.shops.listNonApprovedIds();
  }
  /* Chỉ mục ảnh phải chốt quyền bán bằng allowlist, không phụ thuộc shop còn thành viên hay không. */
  approvedShopIds(): Promise<string[]> { return this.shops.listApprovedIds(); }

  async searchLiveShopIds(q: string, approvedOnly = true): Promise<string[]> {
    const rows = await this.prisma.shop.findMany({ where: { isDeleted: false, ...(approvedOnly ? { status: SHOP_STATUS.APPROVED } : {}), name: { contains: q, mode: 'insensitive' } }, select: { id: true } });
    return rows.map(row => row.id);
  }

  /* Tra nhiều shopId một lần (thẻ sản phẩm/giỏ hàng liệt kê hàng loạt) — tránh N+1 query. */
  async findManyBrief(shopIds: string[]): Promise<Map<string, ShopBrief>> {
    const uniq = [...new Set(shopIds)];
    if (uniq.length === 0) return new Map();
    const rows = await this.shops.findByIds(uniq);
    return new Map(rows.map((s) => [s.id, ShopQueryApi.toBrief(s)]));
  }

  /* Gian hàng CHÍNH CHỦ của sàn (không phải vendor) — module khác dùng làm shopId mặc định khi NHÂN VIÊN SÀN
     tự tạo dữ liệu qua /admin/** (vd tạo sản phẩm không qua /shop/products của vendor). Module khác KHÔNG
     được tự suy "shop approved đầu tiên" (dễ trỏ nhầm sang vendor thật được duyệt trước) — luôn gọi hàm này. */
  async findOfficialShopId(): Promise<string | null> {
    const s = await this.shops.findByCode(FITLY_OFFICIAL_SHOP_CODE);
    return s?.id ?? null;
  }

  /* Gian hàng tồn tại VÀ đang approved — module khác dùng để chặn ghi vào shop chưa duyệt/đã khoá. */
  async existsApproved(shopId: string): Promise<boolean> {
    const s = await this.shops.findById(shopId);
    return !!s && s.status === SHOP_STATUS.APPROVED;
  }

  /* Danh sách userId của mọi thành viên ACTIVE của một gian hàng — dùng để gửi thông báo (WP: B5). */
  async activeMemberUserIds(shopId: string): Promise<string[]> {
    const members = await this.prisma.shopMember.findMany({
      where: { shopId, status: SHOP_MEMBER_STATUS.ACTIVE },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /*
   * userId của thành viên ACTIVE có mã quyền `shop.*` này (PLAN-0022: báo đúng người xử lý đổi trả — chỉ ai có `shop.return.process` mới nhận việc duyệt/nhận hàng).
   * Quyền hiệu lực tính ĐÚNG như ShopContextGuard (effectiveShopPermissions: chủ = đủ quyền của vai, nhân viên = quyền chủ đã giao hoặc preset vai); vai đọc theo lô
   * (tối đa 2 vai shop) nên không N+1 theo thành viên. Chỉ ĐỌC.
   */
  async memberUserIdsWithPermission(shopId: string, permissionCode: string): Promise<string[]> {
    const members = await this.prisma.shopMember.findMany({
      where: { shopId, status: SHOP_MEMBER_STATUS.ACTIVE },
      select: { userId: true, roleId: true, customPermissions: true },
    });
    if (members.length === 0) return [];
    const roles = new Map<string, { code: string; permissionCodes: string[] } | null>();
    for (const roleId of new Set(members.map((m) => m.roleId))) roles.set(roleId, await this.identity.shopRoleContext(roleId));
    return members
      .filter((m) => {
        const role = roles.get(m.roleId);
        return !!role && effectiveShopPermissions(role.code, role.permissionCodes, m.customPermissions).includes(permissionCode);
      })
      .map((m) => m.userId);
  }

  /* Tài khoản ngân hàng của gian hàng — module payment/payout (WP B8) dùng để đối soát tiền.
     Trả null nếu thiếu bất kỳ trường nào. */
  async bankAccountOf(shopId: string): Promise<BankAccount | null> {
    const s = await this.shops.findById(shopId);
    if (!s || !s.bankCode || !s.bankAccountNumber || !s.bankAccountName) return null;
    // Không thêm cột: đọc mốc từ nhật ký của CHÍNH module shop (mỗi lần đổi TK đều ghi SHOP_BANK_UPDATED).
    const last = await this.prisma.shopAuditLog.findFirst({ where: { entityType: 'shop', entityId: shopId, action: SHOP_AUDIT.BANK_UPDATED }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return {
      bankCode: s.bankCode,
      accountNumber: s.bankAccountNumber,
      accountName: s.bankAccountName,
      // `bankVerifiedAt` bị xoá mỗi lần đổi TK nên nếu còn giá trị thì chắc chắn SAU lần đổi gần nhất.
      changedAt: s.bankVerifiedAt ?? last?.createdAt ?? null,
      pendingVerification: s.bankStatus === SHOP_BANK_STATUS.PENDING,
    };
  }

  private static toPublic(s: { id: string; slug: string; name: string; logoUrl: string | null; bannerUrl: string | null; description: string | null; ratingAvg: unknown }): ShopPublicProfile {
    return { id: s.id, slug: s.slug, name: s.name, logoUrl: s.logoUrl, bannerUrl: s.bannerUrl, description: s.description, ratingAvg: s.ratingAvg == null ? null : Number(s.ratingAvg) };
  }

  private static toBrief(s: { id: string; code: string; slug: string; name: string; logoUrl: string | null; ratingAvg: unknown; status: string; commissionRate: unknown; shippingCarrierEnabled?: boolean; shippingPickup?: unknown; shippingReturn?: unknown }): ShopBrief {
    return { shippingCarrierEnabled:s.shippingCarrierEnabled, shippingPickup:s.shippingPickup, shippingReturn:s.shippingReturn, id: s.id, code: s.code, slug: s.slug, name: s.name, logoUrl: s.logoUrl, ratingAvg: s.ratingAvg == null ? null : Number(s.ratingAvg), status: s.status, commissionRate: String(s.commissionRate) };
  }
}
