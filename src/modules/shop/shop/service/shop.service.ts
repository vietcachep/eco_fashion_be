import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { ShopAuditLogService } from '../../audit/shop-audit-log.service';
import { SHOP_AUDIT, SHOP_ERR, SHOP_EVENT, SHOP_STATUS, SHOP_STATUS_LABEL, SHOP_TRANSITIONS } from '../../foundation/shop.constants';
import { ShopOutboxService } from '../../outbox/shop-outbox.service';
import { ShopRegistrationService } from '../../registration/service/shop-registration.service';
import { ShopResponse, AdminShopResponse, AdminShopSummaryResponse } from '../dto/shop.responses';
import { ShopOwnerBrief, toShopResponse, toAdminShopResponse, toAdminShopSummaryResponse } from '../mapper/shop.mapper';
import { ShopListFilter, ShopRepository, ShopRow } from '../repository/shop.repository';
import { isKnownBankBin } from './vn-bank-bins';

export interface UpdateShopProfileInput {
  name?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  description?: string | null;
  bankCode?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
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
  ) {}

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
    const owners = await this.ownersOf(items);
    return PageResponse.of(items.map((s) => toAdminShopSummaryResponse(s, owners.get(s.ownerUserId))), page, size, total);
  }

  async getAdminDetail(id: string): Promise<AdminShopResponse> {
    const s = await this.repo.findById(id);
    if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    const owners = await this.ownersOf([s]);
    return toAdminShopResponse(s, owners.get(s.ownerUserId));
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
    const owners = await this.ownersOf([after]);
    return toAdminShopSummaryResponse(after, owners.get(after.ownerUserId));
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
    const owners = await this.ownersOf([after]);
    return toAdminShopSummaryResponse(after, owners.get(after.ownerUserId));
  }

  // ================================================================ vendor tự quản (ShopController)

  async getMe(shopId: string): Promise<ShopResponse> {
    const s = await this.repo.findById(shopId);
    if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    return toShopResponse(s);
  }

  /*
   * Vendor sửa hồ sơ + tài khoản ngân hàng nhận tiền (PATCH /shop/me).
   * Transaction: khoá dòng shop (FOR UPDATE) → kiểm quy tắc trên bản ghi MỚI NHẤT (không đọc ngoài tx rồi ghi đè mù)
   * → update → audit (PROFILE_UPDATED và/hoặc BANK_UPDATED — đổi cả hai trong một PATCH thì ghi CẢ HAI) → outbox
   * SHOP_BANK_CHANGED nếu ngân hàng đổi (system-worker báo cho mọi thành viên shop để kịp phát hiện đổi trái phép).
   * No-op: PATCH không làm đổi gì thì không tăng version, không audit, không phát sự kiện.
   * Audit/outbox chỉ chứa 4 số cuối của số tài khoản.
   */
  async updateMe(actor: AuthenticatedActor, shopId: string, patch: UpdateShopProfileInput): Promise<ShopResponse> {
    const after = await this.prisma.$transaction(async (tx) => {
      const before = await this.repo.findByIdForUpdate(shopId, tx);
      if (!before) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');

      const plan = ShopService.planUpdate(before, patch);
      const profileChanged = Object.keys(plan.profile).length > 0;
      const bankChanged = Object.keys(plan.bank).length > 0;
      if (!profileChanged && !bankChanged) return before;

      const updated = await this.repo.update(shopId, { ...plan.profile, ...plan.bank, updatedBy: actor.userId }, tx);

      if (profileChanged) {
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
          after: { ...ShopService.bankSummary(updated), ...(plan.unknownBin ? { unknownBin: true } : {}) },
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
          },
        });
      }

      return updated;
    });
    return toShopResponse(after);
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
