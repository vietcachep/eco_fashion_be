-- =====================================================================
-- shop_registrations (PLAN-0019 — người bán tự đăng ký gian hàng). Bảng hồ sơ đăng ký đi kèm MỘT shop (quan hệ 1–1):
--   - shop_id UNIQUE: mỗi shop tối đa một hồ sơ. KHÔNG khai FK tới shop.shops — toàn vẹn do service (tạo shop + hồ sơ cùng transaction),
--     và để `migrate diff` không lệch vì Prisma model không khai @relation (xem prisma/schema/shop-registration.prisma).
--   - Trạng thái duyệt vẫn là shop.shops.status (nguồn sự thật duy nhất); hồ sơ chỉ giữ thông tin nộp + lý do/dấu mốc quyết định đầu tiên.
--   - Luật "một người chỉ có MỘT hồ sơ đang chờ" KHÔNG có chốt DB ở đây (partial index cần cột status của shops — bảng này không có);
--     service giữ bằng pg_advisory_xact_lock theo user + kiểm shop pending của user trong cùng transaction.
-- Viết tay CHỈ cho bảng mới (không động tới bảng khác); SQL khớp `prisma migrate diff` giữa schema trước/sau khi thêm model.
-- =====================================================================

-- CreateTable
CREATE TABLE "shop"."shop_registrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "applicant_user_id" UUID NOT NULL,
    "representative_name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "category_id" UUID,
    "category_name" VARCHAR(200),
    "description" VARCHAR(1000),
    "terms_accepted_at" TIMESTAMPTZ NOT NULL,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ,
    "decided_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shop_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_registrations_shop_id_key" ON "shop"."shop_registrations"("shop_id");

-- CreateIndex
CREATE INDEX "shop_registrations_applicant_user_id_created_at_idx" ON "shop"."shop_registrations"("applicant_user_id", "created_at" DESC);
