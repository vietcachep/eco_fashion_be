import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityApplicationApi } from '@modules/identity/applicationapi/identity.applicationapi';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { USER_STATUS } from '@modules/identity/user/enums/user-status';
import { ShopAuditLogService } from '../../audit/shop-audit-log.service';
import { Prisma } from '@common/prisma/types';
import { SHOP_ASSIGNABLE_PERMISSIONS, SHOP_AUDIT, SHOP_ERR, SHOP_EVENT, SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE, SHOP_MEMBER_MAX_ACTIVE, SHOP_MEMBER_STATUS, SHOP_OWNER_ROLE_CODE } from '../../foundation/shop.constants';
import { ShopOutboxService } from '../../outbox/shop-outbox.service';
import { AddShopMemberResponse, ShopMemberResponse } from '../dto/shop-member.responses';
import { toShopMemberResponse } from '../mapper/shop-member.mapper';
import { ShopMemberRepository } from '../repository/shop-member.repository';
import type { ShopMemberRow } from '../repository/shop-member.repository';

/*
 * Nghiệp vụ nhân viên gian hàng (PLAN-0014 bước 4) — chủ shop THÊM nhân viên (tạo tài khoản mới + gắn vào shop), đổi vai, gỡ nhân viên
 * CỦA CHÍNH shop mình; thành viên tự rời shop.
 * Thêm nhân viên (add): KHÔNG mời/không chờ chấp nhận — chủ shop nhập họ tên, email, mật khẩu ban đầu và vai; tài khoản là khách thường
 * (identity.IdentityApplicationApi) + một dòng ShopMember, trong CÙNG transaction (tạo tài khoản mà gắn shop lỗi thì không để lại tài khoản
 * mồ côi). Chỉ tạo tài khoản MỚI nên người được thêm không thể đang ở shop khác (luật "mỗi người một gian hàng active" vẫn có chốt DB
 * uq_shop_members_one_active_per_user) và không ai bị kéo vào shop khi chưa đồng ý; email đã có tài khoản ⇒ 409 IDENTITY_EMAIL_EXISTS.
 * `shopId` luôn đến từ @CurrentShop() (ShopContextGuard suy từ JWT), không nhận từ param/body ở tầng controller —
 * mọi repository ở đây lọc thêm theo shopId nên kể cả lỡ truyền sai vẫn không đụng được dữ liệu shop khác.
 * `roleCode` resolve qua identity.queryapi.findShopRoleByCode() — chặn gán vai platform (admin/manager…) vào
 * ShopMember và chặn roleId trần không thuộc catalog vai scope=shop.
 *
 * Bảo mật / đồng thời:
 *  - updateRole/remove/leave đều là "giảm số chủ" tiềm năng: transaction khoá FOR UPDATE các dòng chủ active của shop, ĐỌC LẠI thành
 *    viên, ĐẾM chủ rồi mới ghi — hai chủ hạ/gỡ nhau cùng lúc bị tuần tự hoá, shop không bao giờ về 0 chủ (409 SHOP_LAST_OWNER).
 *  - Audit trong cùng transaction với ghi; leave thêm outbox SHOP_MEMBER_LEFT. Không log email/tên người dùng.
 */
@Injectable()
export class ShopMemberService {
  private readonly logger = new Logger(ShopMemberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ShopMemberRepository,
    private readonly identity: IdentityQueryApi,
    private readonly accounts: IdentityApplicationApi,
    private readonly audit: ShopAuditLogService,
    private readonly outbox: ShopOutboxService,
  ) {}

  async list(actor: AuthenticatedActor, shopId: string, page: number, size: number): Promise<PageResponse<ShopMemberResponse>> {
    const { items, total } = await this.repo.listOfShop(shopId, (page - 1) * size, size);
    const roleIds = [...new Set(items.map((i) => i.roleId))];
    const [users, roles, roleCtx] = await Promise.all([this.identity.findUserBriefs(items.map((i) => i.userId)), this.identity.findRoleBriefs(roleIds), Promise.all(roleIds.map(async (id) => [id, (await this.identity.shopRoleContext(id))?.permissionCodes ?? []] as const))]);
    const presets = new Map(roleCtx);
    return PageResponse.of(
      items.map((i) => toShopMemberResponse(i, users.get(i.userId), roles.get(i.roleId), actor.userId, presets.get(i.roleId))),
      page,
      size,
      total,
    );
  }

  /*
   * Chủ shop thêm nhân viên: tạo tài khoản + ShopMember active trong một transaction. Khoá theo shop → đếm thành viên (trần
   * SHOP_MEMBER_MAX_ACTIVE) → tạo tài khoản → tạo ShopMember → audit → outbox. Băm mật khẩu làm NGOÀI transaction. Không log email/mật khẩu;
   * audit chỉ ghi vai (email nằm ở audit của identity).
   *
   * KHÔI PHỤC nhân viên cũ: email đã có tài khoản mà tài khoản đó TỪNG là thành viên của CHÍNH shop này (đã bị gỡ) → kích hoạt lại dòng
   * ShopMember với vai mới (`restored: true`), KHÔNG đổi mật khẩu/hồ sơ (đó là tài khoản cá nhân của họ, chủ shop không được đặt lại mật khẩu).
   * Chủ shop vốn đã biết người này nên không lộ gì thêm. Mọi email khác đã có tài khoản (kể cả người đang ở shop khác) rơi xuống
   * createCustomerAccount ⇒ cùng một 409 IDENTITY_EMAIL_EXISTS — không dò được tài khoản. Khôi phục không được (tài khoản khoá/đang ở shop khác,
   * hoặc đua với shop khác ở chốt unique của DB) ⇒ 409 SHOP_MEMBER_UNAVAILABLE, thông điệp trung tính.
   */
  async add(actor: AuthenticatedActor, shopId: string, input: { email: string; fullName: string; password: string; roleCode: string }): Promise<AddShopMemberResponse> {
    const role = await this.identity.findShopRoleByCode(input.roleCode);
    if (!role) throw new BusinessException(SHOP_ERR.ROLE_INVALID, `Vai '${input.roleCode}' không hợp lệ`);
    const passwordHash = await this.accounts.hashPassword(input.password);
    const previous = await this.identity.findUserBriefByEmail(input.email);

    let result: { member: ShopMemberRow; userId: string; restored: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await this.repo.lockShopMembers(shopId, tx);
        if ((await this.repo.countActive(shopId, tx)) >= SHOP_MEMBER_MAX_ACTIVE) {
          throw new ConflictException(SHOP_ERR.MEMBER_LIMIT_REACHED, `Gian hàng đã có ${SHOP_MEMBER_MAX_ACTIVE} thành viên (tối đa). Hãy gỡ bớt người không còn làm việc rồi thêm lại`);
        }
        const prior = previous ? await this.repo.findAnyByShopAndUser(shopId, previous.id, tx) : null;
        if (previous && prior?.status === SHOP_MEMBER_STATUS.REMOVED) {
          if (previous.status !== USER_STATUS.ACTIVE || previous.roleCode !== SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE || (await this.repo.findActiveByUserId(previous.id, tx))) {
            throw new ConflictException(SHOP_ERR.MEMBER_UNAVAILABLE, 'Không thêm lại được tài khoản này — hãy dùng email khác cho nhân viên');
          }
          const restored = await this.repo.update(prior.id, { status: SHOP_MEMBER_STATUS.ACTIVE, roleId: role.id, updatedBy: actor.userId }, tx);
          await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_ADDED, entityType: 'shop_member', entityId: restored.id, before: { status: prior.status, roleId: prior.roleId }, after: { status: restored.status, roleCode: role.code, restored: true } });
          await this.outbox.publish(tx, { eventType: SHOP_EVENT.MEMBER_JOINED, aggregateType: 'shop', aggregateId: shopId, payload: { shopId, memberId: restored.id, roleId: role.id } });
          return { member: restored, userId: previous.id, restored: true };
        }
        const account = await this.accounts.createCustomerAccount(actor, { email: input.email, fullName: input.fullName, passwordHash }, tx);
        const created = await this.repo.create({ shopId, userId: account.userId, roleId: role.id, status: SHOP_MEMBER_STATUS.ACTIVE, createdBy: actor.userId, updatedBy: actor.userId }, tx);
        await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_ADDED, entityType: 'shop_member', entityId: created.id, after: { roleCode: role.code, restored: false } });
        await this.outbox.publish(tx, { eventType: SHOP_EVENT.MEMBER_JOINED, aggregateType: 'shop', aggregateId: shopId, payload: { shopId, memberId: created.id, roleId: role.id } });
        return { member: created, userId: account.userId, restored: false };
      });
    } catch (e) {
      // Chốt DB uq_shop_members_one_active_per_user: người vừa được shop khác kích hoạt lại giữa chừng ⇒ cùng 409 trung tính.
      if (ShopMemberService.isUniqueViolation(e)) throw new ConflictException(SHOP_ERR.MEMBER_UNAVAILABLE, 'Không thêm lại được tài khoản này — hãy dùng email khác cho nhân viên');
      throw e;
    }
    this.logger.log({ shopId, memberId: result.member.id, by: actor.userId, restored: result.restored }, 'Chủ shop thêm nhân viên');
    const user = await this.identity.findUserBrief(result.userId);
    return { ...toShopMemberResponse(result.member, user ?? undefined, { code: role.code, name: role.name }, actor.userId), restored: result.restored };
  }

  async updateRole(actor: AuthenticatedActor, shopId: string, memberId: string, roleCode: string): Promise<ShopMemberResponse> {
    const newRole = await this.identity.findShopRoleByCode(roleCode);
    if (!newRole) throw new BusinessException(SHOP_ERR.ROLE_INVALID, `Vai '${roleCode}' không hợp lệ`);
    const ownerRoleId = await this.ownerRoleId();

    const updated = await this.prisma.$transaction(async (tx) => {
      const member = await this.lockOwnersThenLoad(shopId, memberId, ownerRoleId, tx);
      await this.assertNotLastOwner(shopId, member, ownerRoleId, newRole.id, 'Gian hàng phải luôn có ít nhất một chủ đang hoạt động', tx);
      const m = await this.repo.update(member.id, { roleId: newRole.id, customPermissions: Prisma.DbNull, updatedBy: actor.userId }, tx); // đổi vai ⇒ bỏ quyền riêng cũ
      await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_UPDATED, entityType: 'shop_member', entityId: m.id, before: { roleId: member.roleId }, after: { roleId: newRole.id, roleCode: newRole.code } });
      return m;
    });
    const user = await this.identity.findUserBrief(updated.userId);
    return toShopMemberResponse(updated, user ?? undefined, { code: newRole.code, name: newRole.name }, actor.userId, (await this.identity.shopRoleContext(newRole.id))?.permissionCodes);
  }

  /*
   * Chủ shop tự đặt quyền cho một nhân viên CỦA CHÍNH shop mình (PUT /shop/members/:id/permissions). `permissionCodes` null = quay về preset của vai.
   * Chỉ mã trong SHOP_ASSIGNABLE_PERMISSIONS; không đặt được cho chủ (chủ luôn đủ quyền chủ). Sàn không có đường nào sửa việc này.
   */
  async updatePermissions(actor: AuthenticatedActor, shopId: string, memberId: string, codes: string[] | null): Promise<ShopMemberResponse> {
    const unique = codes ? [...new Set(codes)] : null;
    const bad = unique?.filter((c) => !SHOP_ASSIGNABLE_PERMISSIONS.includes(c));
    if (bad && bad.length > 0) throw new BusinessException(SHOP_ERR.FORBIDDEN, `Không giao được các quyền: ${bad.join(', ')}`);
    const ownerRoleId = await this.ownerRoleId();
    const updated = await this.prisma.$transaction(async (tx) => {
      const member = await this.repo.findByIdInShop(memberId, shopId, tx);
      if (!member || member.status !== SHOP_MEMBER_STATUS.ACTIVE) throw new NotFoundException(SHOP_ERR.MEMBER_NOT_FOUND, 'Không tìm thấy nhân viên trong gian hàng');
      if (member.roleId === ownerRoleId) throw new BusinessException(SHOP_ERR.FORBIDDEN, 'Chủ gian hàng luôn có đủ quyền chủ — không đặt quyền riêng được');
      const m = await this.repo.update(member.id, { customPermissions: unique ?? Prisma.DbNull, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_UPDATED, entityType: 'shop_member', entityId: m.id, before: { customPermissions: member.customPermissions }, after: { customPermissions: unique } });
      return m;
    });
    const [user, roles, ctx] = await Promise.all([this.identity.findUserBrief(updated.userId), this.identity.findRoleBriefs([updated.roleId]), this.identity.shopRoleContext(updated.roleId)]);
    return toShopMemberResponse(updated, user ?? undefined, roles.get(updated.roleId), actor.userId, ctx?.permissionCodes);
  }

  async remove(actor: AuthenticatedActor, shopId: string, memberId: string): Promise<void> {
    const ownerRoleId = await this.ownerRoleId();
    await this.prisma.$transaction(async (tx) => {
      const member = await this.lockOwnersThenLoad(shopId, memberId, ownerRoleId, tx);
      await this.assertNotLastOwner(shopId, member, ownerRoleId, null, 'Gian hàng phải luôn có ít nhất một chủ đang hoạt động', tx);
      await this.repo.update(member.id, { status: SHOP_MEMBER_STATUS.REMOVED, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_REMOVED, entityType: 'shop_member', entityId: member.id });
    });
  }

  /*
   * Thành viên TỰ RỜI gian hàng (POST /shop/members/leave) — lối thoát cho người bị kéo vào shop không mong muốn. Chỉ cần là thành viên
   * active (không đòi quyền shop.staff.*); `memberId` là thành viên mà ShopContextGuard suy từ JWT của chính actor — service vẫn kiểm
   * `member.userId === actor.userId` để không bao giờ rời hộ người khác. Chủ cuối cùng không được rời (409 SHOP_LAST_OWNER).
   * Transaction: khoá chủ → đọc lại → kiểm → status=removed + audit SHOP_MEMBER_LEFT + outbox SHOP_MEMBER_LEFT.
   */
  async leave(actor: AuthenticatedActor, shopId: string, memberId: string): Promise<void> {
    const ownerRoleId = await this.ownerRoleId();
    await this.prisma.$transaction(async (tx) => {
      const member = await this.lockOwnersThenLoad(shopId, memberId, ownerRoleId, tx);
      if (member.userId !== actor.userId) throw new NotFoundException(SHOP_ERR.MEMBER_NOT_FOUND, 'Không tìm thấy nhân viên trong gian hàng');
      await this.assertNotLastOwner(shopId, member, ownerRoleId, null, 'Bạn là chủ duy nhất của gian hàng — hãy thêm chủ khác trước khi rời', tx);
      await this.repo.update(member.id, { status: SHOP_MEMBER_STATUS.REMOVED, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_LEFT, entityType: 'shop_member', entityId: member.id, before: { roleId: member.roleId, status: member.status }, after: { status: SHOP_MEMBER_STATUS.REMOVED } });
      await this.outbox.publish(tx, { eventType: SHOP_EVENT.MEMBER_LEFT, aggregateType: 'shop', aggregateId: shopId, payload: { shopId, memberId: member.id, roleId: member.roleId, wasOwner: member.roleId === ownerRoleId } });
    });
    this.logger.log({ shopId, memberId, userId: actor.userId }, 'Thành viên tự rời gian hàng');
  }

  // ------------------------------------------------------------ helpers

  /* Prisma P2002 = vi phạm unique (kể cả index một phần mà Prisma không mô hình hoá). */
  private static isUniqueViolation(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
  }

  /* roleId của vai chủ shop (null nếu catalog chưa có vai — khi đó bỏ qua kiểm chủ cuối cùng như trước). */
  private async ownerRoleId(): Promise<string | null> {
    const role = await this.identity.findShopRoleByCode(SHOP_OWNER_ROLE_CODE);
    return role?.id ?? null;
  }

  /*
   * Bước đầu của mọi thao tác có thể giảm số chủ: khoá các dòng chủ active của shop (FOR UPDATE) RỒI mới đọc thành viên đích — đọc sau
   * khoá để thấy vai/trạng thái mới nhất nếu một thao tác song song vừa commit. Thành viên phải thuộc ĐÚNG shop và đang active, nếu
   * không trả 404 (id shop khác không bị lộ).
   */
  private async lockOwnersThenLoad(shopId: string, memberId: string, ownerRoleId: string | null, tx: Tx): Promise<ShopMemberRow> {
    if (ownerRoleId) await this.repo.lockActiveByRole(shopId, ownerRoleId, tx);
    const member = await this.repo.findByIdInShop(memberId, shopId, tx);
    if (!member || member.status !== SHOP_MEMBER_STATUS.ACTIVE) throw new NotFoundException(SHOP_ERR.MEMBER_NOT_FOUND, 'Không tìm thấy nhân viên trong gian hàng');
    return member;
  }

  /*
   * Chặn hạ vai/gỡ/rời NGƯỜI CHỦ CUỐI CÙNG (đích `targetRoleId` null = rời/gỡ hẳn, khác owner = đổi vai). Chỉ chạy được khi đã gọi
   * lockOwnersThenLoad trong cùng transaction — số chủ đếm ở đây mới chính xác. Không chặn nếu thành viên không phải chủ hoặc vẫn
   * giữ vai chủ.
   */
  private async assertNotLastOwner(shopId: string, member: ShopMemberRow, ownerRoleId: string | null, targetRoleId: string | null, message: string, tx: Tx): Promise<void> {
    if (!ownerRoleId || member.roleId !== ownerRoleId || targetRoleId === ownerRoleId) return;
    const owners = await this.repo.countActiveByRole(shopId, ownerRoleId, tx);
    if (owners <= 1) throw new ConflictException(SHOP_ERR.LAST_OWNER, message);
  }
}
