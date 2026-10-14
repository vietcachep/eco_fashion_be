-- =====================================================================
-- shop_invitations (PLAN-0017 §12 — mời nhân viên có CHẤP NHẬN). Thay luồng "mời = thêm ngay" (chủ shop kéo được người lạ vào
-- shop và dò được email nào có tài khoản) bằng lời mời pending: người được mời tự chấp nhận/từ chối ở `/me/shop-invitations`.
--   1. Bảng shop.shop_invitations: email chữ thường (CHECK), status pending|accepted|declined|cancelled (CHECK). "Hết hạn" =
--      pending mà expires_at < now, tính lúc đọc (không có status riêng, không cần job).
--   2. uq_shop_invitations_pending_shop_email — UNIQUE (shop_id, email) WHERE status = 'pending': mỗi (shop, email) tối đa một lời
--      mời đang chờ (mời lại = gia hạn dòng cũ, không tạo trùng). Index một phần Prisma không mô hình hoá nên viết tay ở đây
--      (giống uq_product_variants_shop_sku_active) — `prisma migrate diff` bỏ qua index có WHERE nên không báo lệch.
--   3. uq_shop_members_one_active_per_user — UNIQUE (user_id) WHERE status = 'active' trên shop.shop_members: CHẶN GỐC luật
--      "mỗi người chỉ thuộc MỘT gian hàng active" (trước đây chỉ service + advisory lock giữ, ghi thẳng DB vẫn tạo được hai
--      membership active và ShopContextGuard chọn nhầm shop). Nếu DB còn user active ở ≥ 2 shop, migration DỪNG với thông báo rõ —
--      KHÔNG tự xoá/đổi dữ liệu của ai; xử lý tay (cho người đó rời bớt shop) rồi chạy lại.
-- =====================================================================

-- CreateTable
CREATE TABLE "shop"."shop_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "accepted_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "shop_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_shop_invitations_status" CHECK ("status" IN ('pending', 'accepted', 'declined', 'cancelled')),
    CONSTRAINT "ck_shop_invitations_email_lower" CHECK ("email" = lower("email"))
);

-- CreateIndex
CREATE INDEX "shop_invitations_email_status_idx" ON "shop"."shop_invitations"("email", "status");

-- CreateIndex
CREATE INDEX "shop_invitations_shop_id_status_idx" ON "shop"."shop_invitations"("shop_id", "status");

-- AddForeignKey
ALTER TABLE "shop"."shop_invitations" ADD CONSTRAINT "shop_invitations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"."shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Chốt cuối: một (shop, email) chỉ có MỘT lời mời đang chờ (đã chấp nhận/từ chối/thu hồi thì mời lại được).
CREATE UNIQUE INDEX "uq_shop_invitations_pending_shop_email"
  ON "shop"."shop_invitations" ("shop_id", "email")
  WHERE "status" = 'pending';

-- Báo lỗi RÕ (không im lặng sửa dữ liệu) nếu đang có người active ở nhiều gian hàng.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT "user_id" FROM "shop"."shop_members" WHERE "status" = 'active' GROUP BY "user_id" HAVING count(*) > 1
  ) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'Có % user đang active ở nhiều gian hàng — cho họ rời bớt (POST /shop/members/leave hoặc đặt status=removed) rồi chạy lại migration shop_invitations', n;
  END IF;
END $$;

-- Chốt cuối: mỗi người chỉ thuộc MỘT gian hàng active (người đã gỡ/rời không tính).
CREATE UNIQUE INDEX "uq_shop_members_one_active_per_user"
  ON "shop"."shop_members" ("user_id")
  WHERE "status" = 'active';
