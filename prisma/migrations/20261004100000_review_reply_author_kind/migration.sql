-- =====================================================================
-- review_reply_author_kind (PLAN-0017 §12) — phản hồi đánh giá hiện CÔNG KHAI nhưng cột staff_name của các phản hồi do NHÂN VIÊN SÀN viết
-- (POST /admin/reviews/:id/reply) lưu HỌ TÊN thật nhân viên ⇒ lộ tên nhân viên trên trang sản phẩm.
--   Thêm review_replies.author_kind ('shop' | 'platform'): API công khai không còn đọc staff_name mà TÍNH tên hiển thị từ author_kind
--   (shop ⇒ tên gian hàng, platform ⇒ tên sàn). KHÔNG sửa/xoá staff_name cũ (dữ liệu lịch sử giữ nguyên, chỉ không bao giờ ra API).
--   Backfill một lần: phản hồi là của SHOP khi người viết (staff_user_id) từng là thành viên của chính shop sở hữu đánh giá, HOẶC staff_name
--   trùng tên shop đó (vendor luôn ghi tên shop); còn lại là 'platform'. Nhân viên sàn không thể là thành viên shop (chỉ vai customer vào
--   được shop) nên hai tập không giao nhau; nhầm lẫn nếu có chỉ rơi về phía 'platform' (tên sàn, trung tính) — không bao giờ lộ họ tên.
--   Đọc chéo schema `shop` CHỈ trong câu backfill một lần này (không FK, không ràng buộc xuyên schema).
-- =====================================================================
ALTER TABLE "review"."review_replies" ADD COLUMN "author_kind" VARCHAR(20) NOT NULL DEFAULT 'platform';

ALTER TABLE "review"."review_replies" ADD CONSTRAINT "ck_review_replies_author_kind" CHECK ("author_kind" IN ('shop', 'platform'));

UPDATE "review"."review_replies" AS rp
   SET "author_kind" = 'shop'
  FROM "review"."reviews" AS r
 WHERE r."id" = rp."review_id"
   AND (
         EXISTS (SELECT 1 FROM "shop"."shop_members" AS m WHERE m."shop_id" = r."shop_id" AND m."user_id" = rp."staff_user_id")
      OR EXISTS (SELECT 1 FROM "shop"."shops" AS s WHERE s."id" = r."shop_id" AND s."name" = rp."staff_name")
       );
