import type { UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopMemberRow } from '../repository/shop-member.repository';
import { ShopMemberResponse } from '../dto/shop-member.responses';

/*
 * Whitelist trường trả ra: KHÔNG có userId (xem ShopMemberResponse). `selfUserId` = userId của người gọi API, chỉ dùng để tính `isSelf`
 * rồi bỏ — userId của thành viên không bao giờ đi ra response.
 */
export function toShopMemberResponse(m: ShopMemberRow, user: UserBrief | undefined, role: { code: string; name: string } | undefined, selfUserId: string): ShopMemberResponse {
  return {
    id: m.id,
    email: user?.email ?? '',
    fullName: user?.fullName ?? '',
    roleId: m.roleId,
    roleCode: role?.code ?? '',
    roleName: role?.name ?? '',
    status: m.status,
    isSelf: m.userId === selfUserId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
