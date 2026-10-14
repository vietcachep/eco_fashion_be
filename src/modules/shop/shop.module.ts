import { Module } from '@nestjs/common';
import { SHOP_COD_GATEWAY } from '@common/gateway/shop-cod.gateway';
import { ShopAuditLogService } from './audit/shop-audit-log.service';
import { ShopOutboxService } from './outbox/shop-outbox.service';
import { AdminShopController } from './shop/controller/admin-shop.controller';
import { ShopController } from './shop/controller/shop.controller';
import { ShopRepository } from './shop/repository/shop.repository';
import { ShopService } from './shop/service/shop.service';
import { ShopMemberController } from './member/controller/shop-member.controller';
import { ShopMemberRepository } from './member/repository/shop-member.repository';
import { ShopMemberService } from './member/service/shop-member.service';
import { ShopQueryApi } from './queryapi/shop.queryapi';
import { ShopContextGuard } from './security/shop-context.guard';
import { ShopCodGatewayImpl } from './gateway/shop-cod.gateway.impl';

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
 */
@Module({
  controllers: [AdminShopController, ShopController, ShopMemberController],
  providers: [
    ShopRepository,
    ShopMemberRepository,
    ShopAuditLogService,
    ShopOutboxService,
    ShopService,
    ShopMemberService,
    ShopQueryApi,
    ShopContextGuard,
    ShopCodGatewayImpl,
    { provide: SHOP_COD_GATEWAY, useExisting: ShopCodGatewayImpl },
  ],
  exports: [ShopQueryApi, ShopContextGuard, ShopRepository, ShopMemberRepository, SHOP_COD_GATEWAY],
})
export class ShopModule {}
