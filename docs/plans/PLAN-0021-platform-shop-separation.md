# PLAN-0021 — Tách việc của SÀN và việc của CHỦ SHOP

Trạng thái: đã code (2026-10-23). Nguyên tắc: **sàn giám sát và điều tiết, shop tự vận hành; sàn không làm thay và không phân quyền trong shop.**

## Sàn làm được
* Nhân viên sàn + vai/quyền của sàn (identity); ngành hàng, thuộc tính, bộ sưu tập.
* Duyệt / khoá / từ chối gian hàng, đặt hoa hồng; đối soát chi trả PayOS; ví đặt cọc COD (duyệt nộp cọc, chỉnh ví) — PLAN-0020.
* Sản phẩm: **chỉ xem + chặn bán / mở bán lại** (`product.product.read`, `product.product.publish`).
* Đơn: xem, huỷ khi tranh chấp; đổi trả (duyệt/từ chối), thanh toán, hoàn tiền, phương thức thanh toán.
* Đánh giá: kiểm duyệt (ẩn). Khuyến mãi: mã của SÀN. Banner, thông báo, tham số, báo cáo, AI.

## Sàn KHÔNG làm (việc của chủ shop)
Tạo/sửa/xoá sản phẩm, biến thể, ảnh; nhập kho / điều chỉnh tồn; xác nhận / đóng gói / giao đơn; trả lời đánh giá.
7 mã quyền chuyển `deprecated` (is_active=false) và gỡ khỏi mọi vai: `product.product.create|update|delete`, `product.inventory.receive|adjust`, `order.order.status.update`, `review.review.reply`.
Admin = mọi mã còn hiệu lực (không gồm mã deprecated).

## Chủ shop tự phân quyền nhân viên
* `shop.shop_members.custom_permissions` (JSONB, NULL = theo preset vai). `PUT /shop/members/:id/permissions` (quyền `shop.staff.update`) — chỉ mã trong `SHOP_ASSIGNABLE_PERMISSIONS`; không đặt được cho chủ; đổi vai xoá quyền riêng.
* Giữ riêng cho chủ: nhân sự, sửa hồ sơ/ngân hàng, đối soát, ví đặt cọc.
* `ShopContextGuard` dùng `effectiveShopPermissions` (một nguồn duy nhất).
* Sàn không sửa được preset vai `shop_owner`/`shop_staff` (`PUT /admin/roles/:code/permissions` → 403 ROLE_SYSTEM_LOCKED); màn Vai & quyền của sàn ẩn hai vai này.

## Còn mở
* Danh sách Thanh toán / Hoàn tiền / Đổi trả của sàn chưa chia theo shop (backend chưa có bộ lọc shop).
* Route `/admin/products|inventory` còn tồn tại nhưng không ai có mã quyền ghi — nên gỡ hẳn ở lần dọn tiếp theo.
* Cần `npm run migration:deploy` + `perms:sync`; seed/ docs cũ còn nhắc quyền đã bỏ.

## Siết quyền của sàn (2026-10-24)
* **Ví cọc COD:** kế toán chỉ `supplier.wallet.approve` (duyệt / từ chối khoản nộp); **chỉnh ví tay `supplier.wallet.adjust` chỉ Admin**.
* **Hoa hồng:** `supplier.shop.commission` chỉ Admin (gỡ khỏi Quản lý).
* **Khuyến mãi:** sàn chỉ sửa / xoá mã `scope=platform`; mã của shop → 403 `PROMOTION_SHOP_OWNED` (sàn chỉ xem).
* **Liên hệ khách:** `system.contact.read|reply` (CSKH trả lời; Quản lý chỉ xem) thay cho việc dùng chung `system.notification.send`.
* Migration `20261024100000_tighten_platform_permissions` gỡ quyền cũ khỏi vai đã gán; chạy `perms:sync` để gán mã mới.
* Mã deprecated (PLAN-0021) vẫn nằm trong catalog nhưng `is_active=false`, không vai nào giữ — chỉ để tương thích dữ liệu cũ.
