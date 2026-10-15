import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BusinessException, ConflictException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogQueryApi } from '@modules/catalog/queryapi/catalog.queryapi';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { USER_STATUS } from '@modules/identity/user/enums/user-status';
import { ShopAuditLogService } from '../../audit/shop-audit-log.service';
import { SHOP_AUDIT, SHOP_ERR, SHOP_EVENT, SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE, SHOP_MEMBER_STATUS, SHOP_OWNER_ROLE_CODE, SHOP_STATUS } from '../../foundation/shop.constants';
import { ShopMemberRepository, ShopMemberRow } from '../../member/repository/shop-member.repository';
import { ShopOutboxService } from '../../outbox/shop-outbox.service';
import { ShopRepository, ShopRow } from '../../shop/repository/shop.repository';
import { ShopRegistrationDetailResponse, ShopRegistrationResponse } from '../dto/shop-registration.responses';
import { toShopRegistrationDetailResponse, toShopRegistrationResponse } from '../mapper/shop-registration.mapper';
import { ShopRegistrationRepository, ShopRegistrationRow } from '../repository/shop-registration.repository';
import { baseShopSlug, fallbackShopSlug, nextShopCode, normalizeShopName, normalizeVnPhone, SHOP_SLUG_MAX_ATTEMPTS, shopSlugCandidate } from '../rules/shop-registration.rules';

/* Thông tin người bán khai khi nộp hồ sơ — đã qua validate của Request DTO; service chuẩn hoá lại phòng khi gọi không qua HTTP. */
export interface SubmitShopRegistrationInput {
  shopName: string;
  representativeName: string;
  phone: string;
  categoryId: string;
  description?: string | null;
}

/*
 * Người bán TỰ ĐĂNG KÝ gian hàng (PLAN-0019): nộp hồ sơ → shop `pending` + hồ sơ → sàn duyệt/từ chối (ShopService.changeStatus gọi
 * lại service này) → khi duyệt, người nộp thành chủ shop.
 *
 * Use case: submit (POST /shop/registrations) · getMine (GET /shop/registrations/me) · getForShop (GET /admin/shops/:id/registration) ·
 *   prepareStatusChange + recordDecision (móc vào ShopService.changeStatus, CÙNG transaction đã khoá FOR UPDATE dòng shop).
 * Trạng thái duyệt = Shop.status (nguồn sự thật duy nhất); hồ sơ chỉ giữ thông tin nộp + lý do/dấu mốc quyết định đầu tiên.
 * ShopMember owner được tạo LÚC DUYỆT (không lúc nộp): shop pending chưa có thành viên ⇒ người nộp chưa vào cổng vendor, và bị từ chối thì không
 * để lại membership nào chặn họ nộp lại / vào shop khác.
 *
 * submit — transaction duy nhất, thứ tự: khoá advisory theo NGƯỜI NỘP → kiểm điều kiện (chưa là thành viên active, chưa có shop pending) →
 *   khoá advisory TOÀN CỤC cấp mã → kiểm tên → sinh mã `SHOP-######` (max+1) + slug (bỏ dấu, hậu tố -2,-3…) → tạo Shop(pending, ownerUserId = người nộp)
 *   + hồ sơ → audit SHOP_REGISTRATION_SUBMITTED → outbox SHOP_REGISTRATION_SUBMITTED. Mọi lần nộp đều đi qua khoá toàn cục nên hai người nộp
 *   cùng lúc không nhận trùng mã/slug/tên; unique shops.code/slug của DB là chốt cuối (P2002 ⇒ 409, người dùng nộp lại). Các kiểm tra chỉ ĐỌC
 *   qua queryapi (vai/trạng thái tài khoản — identity; ngành hàng — catalog) chạy TRƯỚC transaction, không giữ khoá khi gọi module khác.
 * Ranh giới: ngành hàng lấy từ CatalogQueryApi qua ModuleRef LƯỜI (`strict:false`) thay vì tiêm ở constructor — CatalogModule đã import ShopModule
 *   (guard của /shop/catalog) nên ShopModule import ngược CatalogModule là vòng; cùng kiểu PaymentService lấy cổng ngược sang order. File-level chỉ
 *   import `catalog/queryapi` (được phép).
 * Bảo mật: người nộp luôn là actor (JWT); GET /me lọc theo applicantUserId = actor.userId; SĐT/email chỉ ra cho chính người nộp và nhân viên sàn
 *   (supplier.shop.read). KHÔNG log SĐT/email/tên người đại diện; audit/outbox không chứa SĐT/email.
 */
@Injectable()
export class ShopRegistrationService {
  private readonly logger = new Logger(ShopRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly regs: ShopRegistrationRepository,
    private readonly shops: ShopRepository,
    private readonly members: ShopMemberRepository,
    private readonly audit: ShopAuditLogService,
    private readonly outbox: ShopOutboxService,
    private readonly identity: IdentityQueryApi,
    private readonly moduleRef: ModuleRef,
  ) {}

  /* Lấy lười lúc gọi — xem ghi chú "Ranh giới" ở đầu class. */
  private get catalog(): CatalogQueryApi {
    return this.moduleRef.get(CatalogQueryApi, { strict: false });
  }

  // ================================================================ người bán (ShopRegistrationController)

  async submit(actor: AuthenticatedActor, input: SubmitShopRegistrationInput): Promise<ShopRegistrationResponse> {
    const shopName = normalizeShopName(input.shopName);
    const representativeName = normalizeShopName(input.representativeName);
    const phone = normalizeVnPhone(input.phone);
    if (!phone) throw new BusinessException(SHOP_ERR.REGISTRATION_PHONE_INVALID, 'Số điện thoại không hợp lệ — nhập số di động Việt Nam, vd 0912345678');
    const description = input.description?.trim() ? input.description.trim() : null;

    // Chỉ đọc, NGOÀI transaction: tài khoản phải là khách thường đang hoạt động (nhân viên sàn không mở gian hàng) và ngành hàng còn hoạt động.
    const user = await this.identity.findUserBrief(actor.userId);
    if (!user || user.status !== USER_STATUS.ACTIVE || user.roleCode !== SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE) {
      throw new ForbiddenException(SHOP_ERR.REGISTRATION_NOT_ELIGIBLE, 'Tài khoản này không thể đăng ký bán hàng — chỉ tài khoản khách hàng đang hoạt động mới đăng ký được');
    }
    const category = await this.catalog.findCategoryById(input.categoryId);
    if (!category || !category.isActive) {
      throw new BusinessException(SHOP_ERR.REGISTRATION_CATEGORY_INVALID, 'Ngành hàng không tồn tại hoặc đã ngừng hoạt động');
    }

    let created: { shop: ShopRow; registration: ShopRegistrationRow };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await this.regs.lockApplicant(actor.userId, tx);
        if (await this.members.findActiveByUserId(actor.userId, tx)) {
          throw new ConflictException(SHOP_ERR.REGISTRATION_ALREADY_MEMBER, 'Bạn đã là thành viên của một gian hàng — mỗi tài khoản chỉ thuộc một gian hàng');
        }
        const owned = await this.shops.findByOwnerUserId(actor.userId, tx);
        if (owned.some((s) => s.status === SHOP_STATUS.PENDING)) {
          throw new ConflictException(SHOP_ERR.REGISTRATION_PENDING, 'Bạn đã có một hồ sơ đăng ký đang chờ duyệt');
        }

        await this.regs.lockShopCode(tx);
        if (await this.regs.shopNameTaken(shopName, tx)) {
          throw new ConflictException(SHOP_ERR.NAME_TAKEN, 'Tên gian hàng đã được sử dụng — hãy chọn tên khác');
        }
        const code = nextShopCode(await this.regs.maxShopCodeNumber(tx));
        const slug = await this.uniqueSlug(shopName, code, tx);

        const shop = await this.shops.create({ code, slug, name: shopName, description, status: SHOP_STATUS.PENDING, ownerUserId: actor.userId, createdBy: actor.userId, updatedBy: actor.userId }, tx);
        const registration = await this.regs.create(
          {
            shopId: shop.id,
            applicantUserId: actor.userId,
            representativeName,
            phone,
            categoryId: category.id,
            categoryName: category.name.slice(0, 200),
            description,
            termsAcceptedAt: new Date(),
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
          tx,
        );
        await this.audit.write(tx, actor, { action: SHOP_AUDIT.REGISTRATION_SUBMITTED, entityType: 'shop', entityId: shop.id, entityCode: shop.code, after: { status: SHOP_STATUS.PENDING, categoryId: category.id } });
        await this.outbox.publish(tx, { eventType: SHOP_EVENT.REGISTRATION_SUBMITTED, aggregateType: 'shop', aggregateId: shop.id, payload: { shopId: shop.id, code: shop.code, name: shop.name, applicantUserId: actor.userId } });
        return { shop, registration };
      });
    } catch (e) {
      // Chốt DB shops.code/slug unique: có shop khác được tạo NGOÀI luồng đăng ký (seed/công cụ) đúng lúc này ⇒ 409, người dùng bấm gửi lại.
      if (ShopRegistrationService.isUniqueViolation(e)) throw new ConflictException(SHOP_ERR.CODE_EXISTS, 'Mã hoặc đường dẫn gian hàng vừa bị trùng do có người đăng ký cùng lúc — vui lòng thử lại');
      throw e;
    }
    this.logger.log({ shopId: created.shop.id, code: created.shop.code, userId: actor.userId }, 'Người bán nộp hồ sơ đăng ký gian hàng');
    return toShopRegistrationResponse(created.registration, created.shop);
  }

  /* Hồ sơ MỚI NHẤT của chính người gọi (kể cả đã duyệt/bị từ chối); chưa từng đăng ký ⇒ null. Lọc theo applicantUserId từ JWT. */
  async getMine(actor: AuthenticatedActor): Promise<ShopRegistrationResponse | null> {
    const registration = await this.regs.findLatestByApplicant(actor.userId);
    if (!registration) return null;
    const shop = await this.shops.findById(registration.shopId);
    return shop ? toShopRegistrationResponse(registration, shop) : null;
  }

  // ================================================================ nhân viên sàn (AdminShopRegistrationController)

  /* Hồ sơ đăng ký của shop kèm người nộp. Shop không tồn tại ⇒ 404; shop không có hồ sơ (seed/admin tạo) ⇒ null. */
  async getForShop(shopId: string): Promise<ShopRegistrationDetailResponse | null> {
    const shop = await this.shops.findById(shopId);
    if (!shop) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    const registration = await this.regs.findByShopId(shop.id);
    if (!registration) return null;
    const applicant = await this.identity.findUserBrief(registration.applicantUserId);
    return toShopRegistrationDetailResponse(registration, shop, applicant);
  }

  // ================================================================ móc vào ShopService.changeStatus

  /*
   * Gọi TRONG transaction của ShopService.changeStatus, SAU khi đã khoá FOR UPDATE dòng shop và kiểm lưới chuyển trạng thái, TRƯỚC khi đổi
   * trạng thái. Trả hồ sơ của shop (null = shop không có hồ sơ: seed/admin tạo ⇒ hành vi cũ, không làm gì thêm).
   * DUYỆT LẦN ĐẦU (pending → approved) shop có hồ sơ: biến người nộp thành chủ shop (xem grantOwner) — không được thì ném 409
   * SHOP_OWNER_UNAVAILABLE và ShopService KHÔNG đổi trạng thái (cả transaction rollback). Mở khoá (suspended → approved) và từ chối không tạo thành viên.
   */
  async prepareStatusChange(tx: Tx, actor: AuthenticatedActor, shop: ShopRow, target: string): Promise<ShopRegistrationRow | null> {
    const registration = await this.regs.findByShopId(shop.id, tx);
    if (!registration) return null;
    if (target === SHOP_STATUS.APPROVED && shop.status === SHOP_STATUS.PENDING) await this.grantOwner(tx, actor, shop);
    return registration;
  }

  /* Ghi lý do/thời điểm/người ra quyết định vào hồ sơ — CHỈ lần quyết định đầu tiên (duyệt hoặc từ chối); khoá/mở khoá về sau không ghi đè. */
  async recordDecision(tx: Tx, actor: AuthenticatedActor, registration: ShopRegistrationRow, reason: string | null): Promise<void> {
    if (registration.decidedAt) return;
    await this.regs.update(registration.id, { decisionReason: reason, decidedAt: new Date(), decidedBy: actor.userId, updatedBy: actor.userId }, tx);
  }

  /*
   * Biến người nộp thành CHỦ shop: ShopMember{shopId, userId = Shop.ownerUserId, vai shop_owner, active} + audit SHOP_MEMBER_ADDED (via registration_approved)
   * + outbox SHOP_MEMBER_JOINED. Điều kiện (không đạt ⇒ 409 SHOP_OWNER_UNAVAILABLE): vai shop_owner có trong catalog; người nộp còn tồn tại, active, vai nền
   * tảng `customer`, và CHƯA là thành viên active của shop nào. Shop đã có chủ active (dữ liệu dựng tay) thì không tạo thêm.
   * Đồng thời: khoá advisory theo người nộp — chung khoá với submit — nên duyệt hai shop của cùng một người, hay duyệt đúng lúc họ nộp hồ sơ mới, bị
   * tuần tự hoá; chốt cuối là unique `uq_shop_members_one_active_per_user` (đua với đường KHÔI PHỤC nhân viên của shop khác ⇒ P2002 ⇒ cũng 409).
   */
  private async grantOwner(tx: Tx, actor: AuthenticatedActor, shop: ShopRow): Promise<void> {
    const ownerRole = await this.identity.findShopRoleByCode(SHOP_OWNER_ROLE_CODE);
    if (!ownerRole) throw ShopRegistrationService.ownerUnavailable('Hệ thống chưa có vai chủ gian hàng (shop_owner) — liên hệ kỹ thuật');

    await this.regs.lockApplicant(shop.ownerUserId, tx);
    if ((await this.members.countActiveByRole(shop.id, ownerRole.id, tx)) > 0) return;

    const applicant = await this.identity.findUserBrief(shop.ownerUserId);
    if (!applicant || applicant.status !== USER_STATUS.ACTIVE || applicant.roleCode !== SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE) {
      throw ShopRegistrationService.ownerUnavailable('Tài khoản người đăng ký không còn hợp lệ (đã bị khoá hoặc không phải tài khoản khách hàng) — hãy từ chối hồ sơ này');
    }
    if (await this.members.findActiveByUserId(applicant.id, tx)) {
      throw ShopRegistrationService.ownerUnavailable('Người đăng ký đã thuộc một gian hàng khác — hãy từ chối hồ sơ này');
    }

    let member: ShopMemberRow;
    try {
      member = await this.members.create({ shopId: shop.id, userId: applicant.id, roleId: ownerRole.id, status: SHOP_MEMBER_STATUS.ACTIVE, createdBy: actor.userId, updatedBy: actor.userId }, tx);
    } catch (e) {
      if (ShopRegistrationService.isUniqueViolation(e)) throw ShopRegistrationService.ownerUnavailable('Người đăng ký vừa được thêm vào một gian hàng khác — hãy từ chối hồ sơ này');
      throw e;
    }
    await this.audit.write(tx, actor, { action: SHOP_AUDIT.MEMBER_ADDED, entityType: 'shop_member', entityId: member.id, after: { roleCode: ownerRole.code, restored: false, via: 'registration_approved' } });
    await this.outbox.publish(tx, { eventType: SHOP_EVENT.MEMBER_JOINED, aggregateType: 'shop', aggregateId: shop.id, payload: { shopId: shop.id, memberId: member.id, roleId: ownerRole.id } });
  }

  // ------------------------------------------------------------ helpers

  /* Slug duy nhất: slug gốc, rồi `-2`, `-3`… tới SHOP_SLUG_MAX_ATTEMPTS lần; hết lượt thì lùi về slug gắn mã shop (luôn duy nhất). Gọi sau khoá toàn cục. */
  private async uniqueSlug(name: string, code: string, tx: Tx): Promise<string> {
    const base = baseShopSlug(name);
    for (let attempt = 1; attempt <= SHOP_SLUG_MAX_ATTEMPTS; attempt++) {
      const candidate = shopSlugCandidate(base, attempt);
      if (!(await this.shops.slugExists(candidate, tx))) return candidate;
    }
    return fallbackShopSlug(base, code);
  }

  private static ownerUnavailable(message: string): ConflictException {
    return new ConflictException(SHOP_ERR.OWNER_UNAVAILABLE, message);
  }

  /* Prisma P2002 = vi phạm unique (kể cả index một phần mà Prisma không mô hình hoá). */
  private static isUniqueViolation(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
  }
}
