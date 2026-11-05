import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { ShopAuditLogService } from '../../audit/shop-audit-log.service';
import { DEFAULT_BANK_CHANGE_HOLD_HOURS, SHOP_AUDIT, SHOP_BANK_STATUS, SHOP_ERR, SHOP_EVENT, SHOP_STATUS, SHOP_STATUS_LABEL, SHOP_TRANSITIONS } from '../../foundation/shop.constants';
import { ShopOutboxService } from '../../outbox/shop-outbox.service';
import { ShopRegistrationService } from '../../registration/service/shop-registration.service';
import { ShopResponse, AdminShopResponse, AdminShopSummaryResponse } from '../dto/shop.responses';
import { ShopOwnerBrief, toShopResponse, toAdminShopResponse, toAdminShopSummaryResponse } from '../mapper/shop.mapper';
import { ShopListFilter, ShopRepository, ShopRow } from '../repository/shop.repository';
import { accountNameMatchesOwner } from './bank-name';
import { isKnownBankBin } from './vn-bank-bins';

export interface UpdateShopProfileInput {
  shippingCarrierEnabled?: boolean;
  shippingPickup?: import('@common/gateway/order-shipping.gateway').ShippingAddress;
  shippingReturn?: import('@common/gateway/order-shipping.gateway').ShippingAddress;
  name?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  description?: string | null;
  bankCode?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  /* Mật khẩu hiện tại của người thao tác — bắt buộc khi bank thực sự đổi (không bao giờ lưu/ghi log). */
  currentPassword?: string;
}

/* Trường hồ sơ / ngân hàng THỰC SỰ đổi so với bản ghi hiện có (đã bỏ trường không gửi và trường gửi lại giá trị cũ). */
type ProfileChanges = Partial<Pick<UpdateShopProfileInput, 'name' | 'logoUrl' | 'bannerUrl' | 'description'>>;
type BankChanges = Partial<Pick<UpdateShopProfileInput, 'bankCode' | 'bankAccountNumber' | 'bankAccountName'>>;

export interface ShopUpdatePlan {
  profile: ProfileChanges;
  bank: BankChanges;
  /* BIN mới không nằm trong danh sách ngân hàng VN phổ biến — chỉ khuyến cáo (ghi audit), không chặn. */
  unknownBin: boolean;
}

/*
 * Nghiệp vụ gian hàng (PLAN-0014 bước 3-4): vòng đời duyệt/khoá/từ chối do SÀN thao tác (AdminShopController,
 * quyền `supplier.shop.*`) + tự quản hồ sơ do VENDOR thao tác (ShopController, quyền `shop.profile.*`,
 * shopId luôn do ShopContextGuard suy từ JWT — service KHÔNG BAO GIỜ nhận shopId ngoài luồng đó làm input
 * để đọc/ghi hộ; tham số `shopId` của getMe/updateMe đến từ @CurrentShop(), không phải param URL).
 */
@Injectable()
export class ShopService {
  private readonly logger = new Logger(ShopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ShopRepository,
    private readonly audit: ShopAuditLogService,
    private readonly outbox: ShopOutboxService,
    private readonly identity: IdentityQueryApi,
    private readonly registrations: ShopRegistrationService,
    /* SystemQueryApi lấy LƯỜI qua ModuleRef (strict:false) — SystemModule đã import ShopModule, import ngược là vòng (cùng cách ShopRegistrationService lấy CatalogQueryApi). */
    private readonly moduleRef: ModuleRef,
  ) {}

  /*
   * Số giờ giữ chi trả sau đổi TK (setting `payout.bank_change_hold_hours`, mặc định 72) — FE hiển thị đúng con số này thay vì ghi cứng. Chỉ là thông tin hiển thị nên KHÔNG được làm hỏng phiên/hồ sơ:
   * đọc lỗi ⇒ log + dùng mặc định. (Việc giữ chi trả thật nằm ở module payment, đọc cùng setting.)
   */
  private async bankChangeHoldHours(): Promise<number> {
    try {
      const hours = await this.moduleRef.get(SystemQueryApi, { strict: false }).settingNumber(SETTING_KEY.PAYOUT_BANK_CHANGE_HOLD_HOURS);
      if (Number.isFinite(hours) && hours > 0) return hours;
    } catch (err) {
      this.logger.warn({ err }, 'Không đọc được payout.bank_change_hold_hours — dùng mặc định');
    }
    return DEFAULT_BANK_CHANGE_HOLD_HOURS;
  }

  /* Lưới SHOP_TRANSITIONS — tách static để test thuần không cần DB (shop.spec.ts). */
  static assertTransition(current: string, target: string): void {
    if (!(SHOP_TRANSITIONS[current] ?? []).includes(target)) {
      throw new BusinessException(SHOP_ERR.INVALID_TRANSITION, `Không thể chuyển gian hàng từ "${SHOP_STATUS_LABEL[current] ?? current}" sang "${SHOP_STATUS_LABEL[target] ?? target}"`);
    }
  }

  // ================================================================ sàn (AdminShopController)

  /*
   * Chủ shop (tên + email) cho nhân viên sàn — MỘT lần tra theo lô qua IdentityQueryApi cho cả trang (không N+1, không gọi
   * `GET /admin/users/:id` từng dòng; kế toán không có quyền đó). Chủ không còn tra được (user bị xoá hẳn) ⇒ không có trong Map ⇒ null.
   * Không che email: cổng này chỉ dành nhân viên sàn có `supplier.shop.read`.
   */
  private async ownersOf(rows: Array<{ ownerUserId: string }>): Promise<Map<string, ShopOwnerBrief>> {
    if (rows.length === 0) return new Map();
    const users = await this.identity.findUserBriefs(rows.map((r) => r.ownerUserId));
    return new Map([...users].map(([id, u]) => [id, { fullName: u.fullName, email: u.email }]));
  }

  async listAdmin(filter: ShopListFilter, page: number, size: number): Promise<PageResponse<AdminShopSummaryResponse>> {
    const { items, total } = await this.repo.list(filter, (page - 1) * size, size);
    const [owners, holdHours] = await Promise.all([this.ownersOf(items), this.bankChangeHoldHours()]);
    return PageResponse.of(items.map((s) => toAdminShopSummaryResponse(s, owners.get(s.ownerUserId), holdHours)), page, size, total);
  }

  async getAdminDetail(id: string): Promise<AdminShopResponse> {
    const s = await this.repo.findById(id);
    if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    const [owners, holdHours] = await Promise.all([this.ownersOf([s]), this.bankChangeHoldHours()]);
    return toAdminShopResponse(s, owners.get(s.ownerUserId), holdHours);
  }

  /*
   * Chuyển trạng thái theo SHOP_TRANSITIONS (approve/suspend/reject dùng chung hàm này, chỉ khác `target`).
   * Khoá dòng (FOR UPDATE) trước khi kiểm — 2 nhân viên sàn duyệt/khoá cùng lúc không race nhau.
   * Shop do người bán TỰ ĐĂNG KÝ (có hồ sơ — PLAN-0019): duyệt lần đầu (pending → approved) tạo luôn ShopMember chủ shop cho người đăng ký, trong CÙNG
   * transaction (không tạo được ⇒ 409 SHOP_OWNER_UNAVAILABLE, trạng thái giữ nguyên); quyết định đầu tiên (duyệt/từ chối) được ghi vào hồ sơ để người
   * đăng ký đọc lý do. Shop không có hồ sơ (seed/admin tạo) và mở khoá suspended → approved giữ hành vi cũ — xem ShopRegistrationService.
   */
  async changeStatus(actor: AuthenticatedActor, id: string, target: string, reason: string | null): Promise<AdminShopSummaryResponse> {
    const after = await this.prisma.$transaction(async (tx) => {
      const s = await this.repo.findByIdForUpdate(id, tx);
      if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
      ShopService.assertTransition(s.status, target);
      const registration = await this.registrations.prepareStatusChange(tx, actor, s, target);
      const updated = await this.repo.update(s.id, { status: target, updatedBy: actor.userId }, tx);
      if (registration) await this.registrations.recordDecision(tx, actor, registration, reason);
      const auditAction = target === SHOP_STATUS.APPROVED ? SHOP_AUDIT.APPROVED : target === SHOP_STATUS.SUSPENDED ? SHOP_AUDIT.SUSPENDED : SHOP_AUDIT.REJECTED;
      await this.audit.write(tx, actor, { action: auditAction, entityType: 'shop', entityId: s.id, entityCode: s.code, before: { status: s.status }, after: { status: target, reason } });
      const eventType = target === SHOP_STATUS.APPROVED ? SHOP_EVENT.APPROVED : target === SHOP_STATUS.SUSPENDED ? SHOP_EVENT.SUSPENDED : SHOP_EVENT.REJECTED;
      await this.outbox.publish(tx, { eventType, aggregateType: 'shop', aggregateId: s.id, payload: { shopId: s.id, code: s.code, name: s.name, status: target, reason, ownerUserId: s.ownerUserId, viaRegistration: registration !== null } });
      return updated;
    });
    this.logger.log({ shopId: id, status: after.status, by: actor.userId }, 'Đã đổi trạng thái gian hàng');
    // Tra chủ shop SAU commit (đọc thuần, ngoài transaction) để thao tác trả cùng DTO với danh sách.
    const [owners, holdHours] = await Promise.all([this.ownersOf([after]), this.bankChangeHoldHours()]);
    return toAdminShopSummaryResponse(after, owners.get(after.ownerUserId), holdHours);
  }

  async updateCommission(actor: AuthenticatedActor, id: string, commissionRate: number): Promise<AdminShopSummaryResponse> {
    const after = await this.prisma.$transaction(async (tx) => {
      const s = await this.repo.findByIdForUpdate(id, tx);
      if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
      const updated = await this.repo.update(s.id, { commissionRate: commissionRate.toFixed(2), updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, {
        action: SHOP_AUDIT.COMMISSION_UPDATED,
        entityType: 'shop',
        entityId: s.id,
        entityCode: s.code,
        before: { commissionRate: s.commissionRate.toString() },
        after: { commissionRate: updated.commissionRate.toString() },
      });
      return updated;
    });
    const [owners, holdHours] = await Promise.all([this.ownersOf([after]), this.bankChangeHoldHours()]);
    return toAdminShopSummaryResponse(after, owners.get(after.ownerUserId), holdHours);
  }

  /*
   * Quản lý sàn XÁC MINH tài khoản ngân hàng đang chờ (PLAN-0026 §2.5 / PLAN-0040 5.2): tên chủ TK lệch tên chủ shop nên kỳ chi của shop bị `held`; sau khi xác minh, `bankVerifiedAt` = bây giờ và
   * từ mốc này mới đếm `payout.bank_change_hold_hours` (job mở giữ ở payment tự mở kỳ khi hết giờ). Khoá dòng shop (FOR UPDATE) nên không race với chủ shop đang đổi TK.
   * `expectedBankAccountNumber` (số TK quản lý đang xem): chủ shop đổi sang TK khác ngay trước khi bấm ⇒ 409 `SHOP_BANK_CHANGED_SINCE` (không xác minh nhầm TK mới); bỏ trống = không kiểm.
   */
  async verifyBank(actor: AuthenticatedActor, id: string, expectedBankAccountNumber?: string): Promise<AdminShopResponse> {
    const holdHours = await this.bankChangeHoldHours();
    const after = await this.prisma.$transaction(async (tx) => {
      const s = await this.repo.findByIdForUpdate(id, tx);
      if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
      if (s.bankStatus !== SHOP_BANK_STATUS.PENDING || !s.bankCode || !s.bankAccountNumber || !s.bankAccountName) {
        throw new ConflictException(SHOP_ERR.BANK_NOT_PENDING, 'Tài khoản ngân hàng của gian hàng không ở trạng thái chờ xác minh');
      }
      if (expectedBankAccountNumber !== undefined && expectedBankAccountNumber !== s.bankAccountNumber) {
        throw new ConflictException(SHOP_ERR.BANK_CHANGED_SINCE, 'Chủ gian hàng vừa đổi sang tài khoản ngân hàng khác — tải lại và kiểm tra tài khoản mới trước khi xác minh');
      }
      const verifiedAt = new Date();
      const updated = await this.repo.update(s.id, { bankStatus: SHOP_BANK_STATUS.VERIFIED, bankVerifiedAt: verifiedAt, updatedBy: actor.userId }, tx);
      const last4 = s.bankAccountNumber.slice(-4);
      await this.audit.write(tx, actor, {
        action: SHOP_AUDIT.BANK_VERIFIED,
        entityType: 'shop',
        entityId: s.id,
        entityCode: s.code,
        before: { bankStatus: s.bankStatus },
        after: { bankStatus: SHOP_BANK_STATUS.VERIFIED, bankCode: s.bankCode, bankAccountNumber: ShopService.maskBankAccountNumber(s.bankAccountNumber), bankAccountName: s.bankAccountName, verifiedAt: verifiedAt.toISOString() },
      });
      await this.outbox.publish(tx, {
        eventType: SHOP_EVENT.BANK_VERIFIED,
        aggregateType: 'shop',
        aggregateId: s.id,
        payload: { shopId: s.id, code: s.code, name: s.name, bankAccountLast4: last4, verifiedByUserId: actor.userId, verifiedAt: verifiedAt.toISOString(), holdHours },
      });
      return updated;
    });
    this.logger.log({ shopId: id, by: actor.userId }, 'Đã xác minh tài khoản ngân hàng của gian hàng');
    const owners = await this.ownersOf([after]);
    return toAdminShopResponse(after, owners.get(after.ownerUserId), holdHours);
  }

  // ================================================================ vendor tự quản (ShopController)

  async getMe(shopId: string): Promise<ShopResponse> {
    const s = await this.repo.findById(shopId);
    if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    return toShopResponse(s, await this.bankChangeHoldHours());
  }

  /*
   * Vendor sửa hồ sơ + tài khoản ngân hàng nhận tiền (PATCH /shop/me).
   * Transaction: khoá dòng shop (FOR UPDATE) → kiểm quy tắc trên bản ghi MỚI NHẤT (không đọc ngoài tx rồi ghi đè mù)
   * → update → audit (PROFILE_UPDATED và/hoặc BANK_UPDATED — đổi cả hai trong một PATCH thì ghi CẢ HAI) → outbox
   * SHOP_BANK_CHANGED nếu ngân hàng đổi (system-worker báo cho mọi thành viên shop để kịp phát hiện đổi trái phép).
   * No-op: PATCH không làm đổi gì thì không tăng version, không audit, không phát sự kiện.
   * Audit/outbox chỉ chứa 4 số cuối của số tài khoản.
   * Khi bank đổi: so tên chủ TK mới với tên chủ shop (PLAN-0040 5.2) — lệch ⇒ `bankStatus=pending_verification` (kỳ chi `held` tới khi quản lý sàn xác minh), khớp ⇒ `verified`.
   */
  async updateMe(actor: AuthenticatedActor, shopId: string, patch: UpdateShopProfileInput): Promise<ShopResponse> {
    // AUD-03: ĐỔI nơi nhận tiền phải nhập lại mật khẩu của người đang thao tác — kẻ chiếm được phiên/token không đổi được TK ngân hàng sang TK của mình. Chỉ đòi khi bank THỰC SỰ đổi (gửi lại giá trị cũ/sửa
    // hồ sơ thì không); kiểm TRƯỚC transaction (argon2 chậm — không giữ khoá dòng shop trong lúc băm). Trong transaction vẫn kiểm lại: bản ghi mới nhất có thể vừa bị người khác đổi bank (race) ⇒ thiếu xác thực thì từ chối.
    const current = await this.repo.findById(shopId);
    if (!current) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    let reauthenticated = false;
    let ownerName: string | null = null;
    if (Object.keys(ShopService.planUpdate(current, patch).bank).length > 0) {
      if (!patch.currentPassword) throw new BusinessException(SHOP_ERR.BANK_PASSWORD_REQUIRED, 'Đổi tài khoản ngân hàng cần nhập lại mật khẩu đăng nhập của bạn');
      if (!(await this.identity.verifyPassword(actor.userId, patch.currentPassword))) throw await this.wrongPasswordError(actor.userId);
      reauthenticated = true;
      // PLAN-0040 5.2: tên chủ shop (fullName của chủ đăng ký) để so với tên chủ TK mới — tra NGOÀI transaction như bước mật khẩu. Không tra được (tài khoản chủ bị xoá) ⇒ null ⇒ coi là lệch (chờ xác minh).
      ownerName = (await this.identity.findUserBriefs([current.ownerUserId])).get(current.ownerUserId)?.fullName ?? null;
    }
    const holdHours = await this.bankChangeHoldHours();

    const after = await this.prisma.$transaction(async (tx) => {
      const before = await this.repo.findByIdForUpdate(shopId, tx);
      if (!before) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');

      const plan = ShopService.planUpdate(before, patch);
      const shippingPatch = { ...(patch.shippingCarrierEnabled !== undefined ? {shippingCarrierEnabled:patch.shippingCarrierEnabled}:{}), ...(patch.shippingPickup ? {shippingPickup: JSON.parse(JSON.stringify(patch.shippingPickup)) as import('@common/prisma/types').Prisma.InputJsonValue}:{}), ...(patch.shippingReturn ? {shippingReturn:JSON.parse(JSON.stringify(patch.shippingReturn)) as import('@common/prisma/types').Prisma.InputJsonValue}:{}) };
      if ((patch.shippingCarrierEnabled ?? before.shippingCarrierEnabled) && !(patch.shippingPickup ?? before.shippingPickup)) throw new BusinessException('SHIPMENT_PICKUP_REQUIRED','Vui lòng cấu hình địa chỉ lấy hàng trước khi bật GHN');
      const shippingChanged = Object.keys(shippingPatch).some((k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(shippingPatch[k as keyof typeof shippingPatch]));
      const profileChanged = Object.keys(plan.profile).length > 0;
      const bankChanged = Object.keys(plan.bank).length > 0;
      if (!profileChanged && !bankChanged && !shippingChanged) return before;
      if (bankChanged && !reauthenticated) throw new BusinessException(SHOP_ERR.BANK_PASSWORD_REQUIRED, 'Đổi tài khoản ngân hàng cần nhập lại mật khẩu đăng nhập của bạn');

      // Tên chủ TK SAU đổi (trường không gửi giữ giá trị cũ) so với tên chủ shop: khớp ⇒ `verified` (giữ chi trả theo setting như trước); lệch ⇒ `pending_verification` — kỳ chi `held` cho tới khi
      // quản lý sàn xác minh (khi đó mới đếm giờ giữ). Mỗi lần đổi TK tính lại và xoá mốc xác minh cũ (xác minh của TK trước không áp cho TK mới).
      const nameMatchesOwner = bankChanged ? accountNameMatchesOwner(plan.bank.bankAccountName ?? before.bankAccountName, ownerName) : true;
      const bankStatus = nameMatchesOwner ? SHOP_BANK_STATUS.VERIFIED : SHOP_BANK_STATUS.PENDING;
      const updated = await this.repo.update(shopId, { ...plan.profile, ...plan.bank, ...shippingPatch, ...(bankChanged ? { bankStatus, bankVerifiedAt: null } : {}), updatedBy: actor.userId }, tx);

      if (profileChanged || shippingChanged) {
        await this.audit.write(tx, actor, {
          action: SHOP_AUDIT.PROFILE_UPDATED,
          entityType: 'shop',
          entityId: shopId,
          entityCode: before.code,
          before: ShopService.profileSummary(before),
          after: ShopService.profileSummary(updated),
        });
      }

      if (bankChanged) {
        await this.audit.write(tx, actor, {
          action: SHOP_AUDIT.BANK_UPDATED,
          entityType: 'shop',
          entityId: shopId,
          entityCode: before.code,
          before: ShopService.bankSummary(before),
          after: { ...ShopService.bankSummary(updated), reauthenticated: true, bankStatus, nameMatchesOwner, ...(plan.unknownBin ? { unknownBin: true } : {}) },
        });
        await this.outbox.publish(tx, {
          eventType: SHOP_EVENT.BANK_CHANGED,
          aggregateType: 'shop',
          aggregateId: shopId,
          payload: {
            shopId,
            code: before.code,
            name: before.name,
            bankCode: updated.bankCode,
            bankAccountName: updated.bankAccountName,
            bankAccountNumberMasked: ShopService.maskBankAccountNumber(updated.bankAccountNumber),
            bankAccountLast4: updated.bankAccountNumber ? updated.bankAccountNumber.slice(-4) : null,
            changedFields: Object.keys(plan.bank),
            changedByUserId: actor.userId,
            changedByEmail: actor.email,
            // PLAN-0040 5.1/5.2: listener gửi email cho CHỦ shop (ownerUserId) + báo quản lý khi TK chờ xác minh; không chứa số TK đầy đủ / tên chủ shop.
            ownerUserId: before.ownerUserId,
            changedAt: new Date().toISOString(),
            bankPendingVerification: !nameMatchesOwner,
            holdHours,
          },
        });
      }

      return updated;
    });
    return toShopResponse(after, holdHours);
  }

  /*
   * Mật khẩu xác thực lại SAI ⇒ 400 `SHOP_BANK_PASSWORD_INVALID`. Tài khoản tạo/liên kết bằng Google có mật khẩu NGẪU NHIÊN không ai biết (auth.service loginWithGoogle) ⇒ không bao giờ nhập đúng được:
   * giữ nguyên mã lỗi nhưng kèm `details.googleLinked='true'` + hướng dẫn "đặt mật khẩu bằng Quên mật khẩu" (không migration, không đổi luồng). Tra cờ Google lỗi ⇒ trả lỗi mật khẩu thường.
   */
  private async wrongPasswordError(userId: string): Promise<BusinessException> {
    const googleLinked = await this.identity.isGoogleLinked(userId).catch(() => false);
    return googleLinked
      ? new BusinessException(SHOP_ERR.BANK_PASSWORD_INVALID, 'Mật khẩu không đúng. Tài khoản đăng nhập bằng Google: hãy đặt mật khẩu bằng chức năng Quên mật khẩu rồi thử lại', HttpStatus.BAD_REQUEST, { googleLinked: 'true' })
      : new BusinessException(SHOP_ERR.BANK_PASSWORD_INVALID, 'Mật khẩu không đúng');
  }

  /*
   * Quy tắc thuần của PATCH /shop/me (không DB — test trong shop-update.spec.ts), trả đúng phần THỰC SỰ đổi:
   * - Tài khoản ngân hàng chưa khai đủ → lần đầu phải gửi đủ cả 3 (BIN + số TK + tên chủ TK).
   * - Đã khai đủ: đổi số tài khoản HOẶC BIN thì bắt buộc gửi lại tên chủ TK (chỉ cần có mặt, không so khớp với tên cũ).
   *   Chỉ sửa tên chủ TK thì được gửi riêng.
   * - Gửi lại đúng giá trị cũ = không đổi (không audit, không báo thành viên).
   * - BIN lạ (ngoài danh sách ngân hàng VN phổ biến) vẫn nhận — chỉ đánh dấu `unknownBin` để ghi audit.
   */
  static planUpdate(before: ShopRow, patch: UpdateShopProfileInput): ShopUpdatePlan {
    const bankAccountName = patch.bankAccountName?.trim();
    if (patch.bankAccountName !== undefined && (bankAccountName?.length ?? 0) < 2) {
      throw new BusinessException(SHOP_ERR.BANK_FIELD_INCOMPLETE, 'Tên chủ tài khoản không được để trống');
    }

    const bankPatch: BankChanges = { bankCode: patch.bankCode, bankAccountNumber: patch.bankAccountNumber, bankAccountName };
    const providedBank = Object.values(bankPatch).filter((v) => v !== undefined).length;
    if (providedBank > 0) {
      const storedComplete = before.bankCode !== null && before.bankAccountNumber !== null && before.bankAccountName !== null;
      if (!storedComplete && providedBank !== 3) {
        throw new BusinessException(SHOP_ERR.BANK_FIELD_INCOMPLETE, 'Phải cung cấp mã ngân hàng, số tài khoản và tên chủ tài khoản cùng lúc');
      }
      const accountChanged = (bankPatch.bankAccountNumber !== undefined && bankPatch.bankAccountNumber !== before.bankAccountNumber) || (bankPatch.bankCode !== undefined && bankPatch.bankCode !== before.bankCode);
      if (accountChanged && bankPatch.bankAccountName === undefined) {
        throw new BusinessException(SHOP_ERR.BANK_FIELD_INCOMPLETE, 'Khi đổi số tài khoản hoặc mã ngân hàng phải gửi lại tên chủ tài khoản mới');
      }
    }

    const profile = ShopService.onlyChanged<ProfileChanges>({ name: patch.name, logoUrl: patch.logoUrl, bannerUrl: patch.bannerUrl, description: patch.description }, before);
    const bank = ShopService.onlyChanged<BankChanges>(bankPatch, before);
    return { profile, bank, unknownBin: bank.bankCode !== undefined && !isKnownBankBin(bank.bankCode) };
  }

  /* Giữ lại các trường có gửi (≠ undefined) VÀ khác giá trị hiện có. */
  private static onlyChanged<T extends object>(patch: T, current: object): T {
    const cur = current as Record<string, unknown>;
    return Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && v !== cur[k])) as T;
  }

  private static profileSummary(s: { name: string; logoUrl: string | null; bannerUrl: string | null; description: string | null }) {
    return { name: s.name, logoUrl: s.logoUrl, bannerUrl: s.bannerUrl, description: s.description };
  }

  private static bankSummary(s: { bankCode: string | null; bankAccountNumber: string | null; bankAccountName: string | null }) {
    return {
      bankCode: s.bankCode,
      bankAccountNumber: ShopService.maskBankAccountNumber(s.bankAccountNumber),
      bankAccountName: s.bankAccountName,
    };
  }

  private static maskBankAccountNumber(accountNumber: string | null | undefined): string | null {
    if (!accountNumber || accountNumber.length < 4) return null;
    const last4 = accountNumber.slice(-4);
    const masked = '•'.repeat(Math.max(0, accountNumber.length - 4)) + last4;
    return masked;
  }
}
