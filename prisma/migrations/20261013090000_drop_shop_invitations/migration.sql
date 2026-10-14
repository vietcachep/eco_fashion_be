-- =====================================================================
-- drop_shop_invitations — chủ dự án chọn luồng THÊM NHÂN VIÊN TRỰC TIẾP (chủ shop tạo tài khoản cho nhân viên, không mời/không chờ chấp nhận)
-- thay cho lời mời có chấp nhận (migration 20261004090000_shop_invitations) ⇒ bỏ bảng shop.shop_invitations (kèm index/CHECK/FK của nó).
-- GIỮ NGUYÊN `uq_shop_members_one_active_per_user` (chốt DB "mỗi người chỉ thuộc MỘT gian hàng active") — luật đó vẫn đúng.
-- Dữ liệu lời mời cũ (nếu có) mất theo bảng; dòng audit SHOP_INVITATION_* trong shop.audit_logs vẫn được giữ làm lịch sử.
-- =====================================================================
DROP TABLE IF EXISTS "shop"."shop_invitations";
