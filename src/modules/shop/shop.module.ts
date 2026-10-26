import { Module } from '@nestjs/common';
import { ShopAuditLogService } from './audit/shop-audit-log.service';
import { ShopOutboxService } from './outbox/shop-outbox.service';
import { AdminShopController } from './shop/controller/admin-shop.controller';
import { ShopDirectoryController } from './shop/controller/shop-directory.controller';
import { ShopController } from './shop/controller/shop.controller';
import { ShopRepository } from './shop/repository/shop.repository';
import { ShopService } from './shop/service/shop.service';
import { ShopMemberController } from './member/controller/shop-member.controller';
import { ShopMemberRepository } from './member/repository/shop-member.repository';
import { ShopMemberService } from './member/service/shop-member.service';
import { AdminShopRegistrationController } from './registration/controller/admin-shop-registration.controller';
import { ShopRegistrationController } from './registration/controller/shop-registration.controller';
import { ShopRegistrationRepository } from './registration/repository/shop-registration.repository';
import { ShopRegistrationService } from './registration/service/shop-registration.service';
import { ShopQueryApi } from './queryapi/shop.queryapi';
import { ShopContextGuard } from './security/shop-context.guard';

/*
 * Module shop (PLAN-0014 bước 1-4): gian hàng (Shop) + nhân viên gian hàng (ShopMember) + RBAC 2 tầng.
 * `AdminShopController` (sàn, quyền `supplier.shop.*`) và `ShopController`/`ShopMemberController` (vendor tự
 * quản, quyền `shop.*` qua ShopContextGuard) cùng sống trong module này vì chia sẻ ShopService/ShopRepository.
 * Export ShopQueryApi cho module khác (product/order/promotion/review ở bước 5+) đọc "shop tồn tại/approved?"
 * — KHÔNG export repository/service nội bộ (dependency-cruiser gác).
 * Export CẢ ShopContextGuard (bước 5+): module khác tự viết controller `/shop/**` riêng (vd
 * `product/.../shop-product.controller.ts`) và dùng LẠI guard này qua `@UseGuards(ShopContextGuard)`. Đã tự
 * kiểm bằng cách boot app thật (KHÔNG chỉ build/lint — build không bắt được lỗi resolve DI runtime): export
 * riêng ShopContextGuard KHÔNG đủ — `@UseGuards(GuardClass)` khiến Nest tự dựng guard trong CONTEXT của
 * module đang dùng nó (ProductModule/ReviewModule), nên các dependency CỦA guard (ShopMemberRepository,
 * ShopRepository) cũng phải export theo, không tự "ở lại" ShopModule như suy đoán ban đầu. Import trực tiếp
 * 2 repository này ở module khác vẫn bị dependency-cruiser chặn (không nằm trong allowlist) — chỉ Nest DI
 * runtime nhìn thấy chúng để tự dựng guard, code người viết không tự ý gọi thẳng được.
 * IdentityModule là @Global nên IdentityQueryApi có sẵn không cần import.
 * Thêm nhân viên: chủ shop tạo tài khoản mới (`POST /shop/members`) qua IdentityApplicationApi (identity là @Global) — không có luồng mời.
 * Tự đăng ký gian hàng (PLAN-0019, `registration/`): `ShopRegistrationController` (`POST /shop/registrations`, `GET /shop/registrations/me`) KHÔNG dùng
 * ShopContextGuard (người nộp chưa là thành viên); `AdminShopRegistrationController` (`GET /admin/shops/:id/registration`, `supplier.shop.read`).
 * ShopService gọi ShopRegistrationService khi duyệt/từ chối (tạo chủ shop + ghi quyết định). Ngành hàng đọc từ CatalogQueryApi qua ModuleRef lười
 * (CatalogModule đã import ShopModule — import ngược là vòng).
 */
@Module({
  controllers: [AdminShopController, ShopDirectoryController, AdminShopRegistrationController, ShopController, ShopMemberController, ShopRegistrationController],
  providers: [
    ShopRepository,
    ShopMemberRepository,
    ShopAuditLogService,
    ShopOutboxService,
    ShopService,
    ShopMemberService,
    ShopRegistrationRepository,
    ShopRegistrationService,
    ShopQueryApi,
    ShopContextGuard,
  ],
  exports: [ShopQueryApi, ShopContextGuard, ShopRepository, ShopMemberRepository],
})
export class ShopModule {}
