import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { SHOP_NAME_RESERVING_STATUSES } from '../rules/shop-registration.rules';

export const SHOP_REGISTRATION_SELECT = {
  id: true,
  shopId: true,
  applicantUserId: true,
  representativeName: true,
  phone: true,
  categoryId: true,
  categoryName: true,
  description: true,
  termsAcceptedAt: true,
  decisionReason: true,
  decidedAt: true,
  decidedBy: true,
  createdAt: true,
} satisfies Prisma.ShopRegistrationSelect;

export type ShopRegistrationRow = Prisma.ShopRegistrationGetPayload<{ select: typeof SHOP_REGISTRATION_SELECT }>;

/*
 * Truy vấn bảng shop.shop_registrations — chỉ module shop. Ngoài hồ sơ, repository này còn giữ vài truy vấn/khoá CHỈ phục vụ đăng ký mà
 * đụng bảng shop.shops (cùng schema shop): khoá advisory theo người nộp + khoá cấp mã, số mã lớn nhất, kiểm trùng tên không phân biệt
 * hoa/thường. Đặt ở đây (không phải ShopRepository) vì là luật riêng của luồng đăng ký, không dùng cho vendor/admin khác.
 */
@Injectable()
export class ShopRegistrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  /* Hồ sơ của shop (1–1). Shop seed/admin tạo không có hồ sơ ⇒ null. */
  async findByShopId(shopId: string, tx?: Tx | null): Promise<ShopRegistrationRow | null> {
    return this.db(tx).shopRegistration.findFirst({ where: { shopId, isDeleted: false }, select: SHOP_REGISTRATION_SELECT });
  }

  /* Hồ sơ MỚI NHẤT của một người nộp — luôn lọc theo applicantUserId lấy từ JWT, không bao giờ từ input. */
  async findLatestByApplicant(applicantUserId: string, tx?: Tx | null): Promise<ShopRegistrationRow | null> {
    return this.db(tx).shopRegistration.findFirst({ where: { applicantUserId, isDeleted: false }, orderBy: { createdAt: 'desc' }, select: SHOP_REGISTRATION_SELECT });
  }

  async create(data: Prisma.ShopRegistrationUncheckedCreateInput, tx?: Tx | null): Promise<ShopRegistrationRow> {
    return this.db(tx).shopRegistration.create({ data, select: SHOP_REGISTRATION_SELECT });
  }

  async update(id: string, data: Prisma.ShopRegistrationUncheckedUpdateInput, tx?: Tx | null): Promise<ShopRegistrationRow> {
    return this.db(tx).shopRegistration.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: SHOP_REGISTRATION_SELECT });
  }

  /*
   * Khoá tư vấn (pg_advisory_xact_lock, nhả khi commit) theo NGƯỜI NỘP: tuần tự hoá "nộp hồ sơ" và "duyệt hồ sơ" của cùng một người, để luật
   * một-hồ-sơ-chờ / một-người-một-shop-active không bị vượt khi hai request đến cùng lúc. Dùng `$executeRaw` (không phải `$queryRaw`):
   * hàm trả `void`, Prisma không đọc được cột kiểu void. Chỉ gọi trong transaction.
   */
  async lockApplicant(applicantUserId: string, tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-registration:${applicantUserId}`}, 0))`;
  }

  /*
   * Khoá tư vấn TOÀN CỤC khi cấp mã/slug/tên: mọi lần nộp hồ sơ đi qua đây nên "số lớn nhất + 1", "slug trống" và "tên chưa bị chiếm" được
   * đọc và ghi như MỘT bước nguyên tử (hai người nộp cùng lúc không nhận trùng mã/slug/tên). Unique của DB (shops.code/slug) vẫn là chốt cuối.
   */
  async lockShopCode(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('shop-code', 0))`;
  }

  /*
   * Số lớn nhất trong các mã dạng `SHOP-######` (0 khi chưa có). KHÔNG lọc is_deleted — shop xoá mềm vẫn giữ mã (shops.code unique tính cả
   * dòng đã xoá). CASE bảo vệ phép ép kiểu khỏi mã không đúng khuôn (vd mã tay `SHOP-OFFICIAL`). Đọc thuần, chạy sau khoá toàn cục.
   */
  async maxShopCodeNumber(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ max: number | null }>>`SELECT max(CASE WHEN code ~ '^SHOP-[0-9]{6}$' THEN substring(code from 6)::int END) AS max FROM "shop"."shops"`;
    return rows[0]?.max ?? 0;
  }

  /*
   * Tên đã bị shop pending/approved/suspended CHIẾM chưa — so sánh `lower()` chính xác (Prisma `equals` + insensitive là ILIKE nên `_`/`%`
   * trong tên bị hiểu thành ký tự đại diện). Shop `rejected` và shop xoá mềm không giữ tên.
   */
  async shopNameTaken(name: string, tx: Tx): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM "shop"."shops" WHERE lower(name) = lower(${name}) AND status IN (${Prisma.join(SHOP_NAME_RESERVING_STATUSES)}) AND is_deleted = false LIMIT 1`;
    return rows.length > 0;
  }
}
