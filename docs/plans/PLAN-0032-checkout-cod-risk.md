# PLAN-0032 — WP-08: Checkout chặt & rủi ro COD phía khách

> Status: Ready · Đợt 2 · P1 · Phụ thuộc: WP-01 (vùng `placeOrder`) · Plan cha: PLAN-0023
> Lỗ hổng: G59–G63 · Kịch bản: CK-05, 11, 13, 14, 17 · COD-05 (đếm bom), COD-06, COD-07

## 1. Mục tiêu

Khách không bị tính giá khác điều họ đã thấy; COD có giới hạn hợp lý cho khách mới và khách hay "bom"; dữ liệu đặt hàng được đọc nhất quán trong transaction.

## 2. Thiết kế (đã chốt — `docs/10` §3, §6)

### 2.1 Giá đổi (G60)
- `CreateOrderRequest.expectedTotal?: string` (Σ `total` các đơn con khách đã thấy ở `GET /checkout/summary`). Có và khác số server tính lúc đặt ⇒ 409 `ORDER_PRICE_CHANGED` kèm summary mới (không tạo gì). Thiếu ⇒ chấp nhận (tương thích cũ) — storefront luôn gửi.

### 2.2 Hồ sơ rủi ro COD của khách (G59)
- Bảng `order.customer_cod_profiles (user_id pk, completed_orders int, bom_events jsonb[] hoặc bảng con, blocked_until, blocked_reason, unblocked_by, unblocked_at, updated_at)`.
- Cập nhật từ sự kiện: `ORDER_COMPLETED` (+1 hoàn tất), `ORDER_DELIVERY_FAILED` với `reasonCode ∈ {refused, unreachable}` và COD (+1 bom, WP-07 phát). `≥ cod.bom_limit` trong `cod.bom_window_days` ⇒ `blocked_until = now + cod.bom_block_days` + thông báo/email khách.
- Lúc đặt COD: khách bị khoá ⇒ 409 `ORDER_COD_BLOCKED` (kèm ngày mở); khách mới (0 đơn hoàn tất) ⇒ trần `cod.new_customer_max_amount`/đơn con và tối đa `cod.new_customer_max_open` đơn COD đang mở ⇒ 409 `ORDER_COD_LIMIT`.
- `GET /checkout/summary` trả `codAvailability {allowed, reason, until}` để storefront ẩn COD có giải thích.
- CSKH mở khoá: `POST /admin/customers/:userId/cod-unblock {reason ≥ 10}` (mã quyền mới `order.cod.manage`: CSKH + admin), audit. Xem hồ sơ COD ở chi tiết đơn của sàn.

### 2.3 Đọc nhất quán (G62) & giới hạn số lượng
- Đọc giỏ, trạng thái shop, giá trong transaction đặt hàng (sau WP-01 transaction không còn gọi HTTP nên rẻ).
- Kiểm lại `cart.max_qty_per_line` lúc đặt (CK-17).

### 2.4 Địa chỉ (G63 — phần kiểm)
- Địa chỉ nhập tay bắt buộc phường/xã + quận/huyện; tỉnh khớp **chỉ tỉnh đang bật**; không khớp ⇒ 400 rõ (thay vì lặng lẽ tính phí mặc định). Phí ship theo cân nặng/hãng: giai đoạn 2 (WP-15).

### 2.5 Voucher (G61) — quyết định
- Không tính lại giảm giá sàn khi một đơn con bị huỷ (sàn chịu) — ghi nhận rủi ro; báo cáo "voucher sàn theo SĐT/địa chỉ" để marketing phát hiện farm (giai đoạn 2 nếu cần chặn cứng).

## 3. Phạm vi file

Sở hữu: `order.service.ts` vùng `price()`/`placeOrder` kiểm tra (khoá vùng, sau WP-01), `order/order/request/order.requests.ts`, `order/order/dto` (summary), bảng hồ sơ COD + listener trong order-worker (khối riêng), route admin khách COD, `identity/permission/catalog.ts` khối `order.cod.manage`, migration.
Storefront: checkout gửi `expectedTotal`, xử lý 409 giá đổi (hiện giá mới, xác nhận lại), hiển thị lý do COD không khả dụng, form địa chỉ bắt buộc phường/xã.
Admin FE: panel "Khách hàng" trong chi tiết đơn (sàn) hiện hồ sơ COD + mở khoá.

## 4. Migration / setting / quyền

- Bảng `customer_cod_profiles` (+ bảng sự kiện bom nếu tách); backfill `completed_orders` từ đơn `completed` hiện có.
- Setting: `cod.new_customer_max_amount` (2.000.000), `cod.new_customer_max_open` (2), `cod.bom_limit` (2), `cod.bom_window_days` (90), `cod.bom_block_days` (90).
- Quyền: `order.cod.manage`.

## 5. Bước

- [ ] 2.1 + CK-05 · 2.2 + CK-13, CK-14, COD-05 (đếm), COD-06, COD-07 · 2.3 + CK-17 · 2.4 + CK-11.
- [ ] FE (sau đồng bộ API) + trình duyệt: khách mới bị giới hạn COD; giá đổi giữa chừng.

## 6. Test

U: các mã trên + backfill hồ sơ. S: `--tag CK`, `--tag COD`.

## 7. Review — trọng tâm riêng

- Khách có thể né khoá COD (đặt bằng tài khoản khác cùng SĐT)? — ghi nhận là rủi ro chấp nhận ở giai đoạn này, nhưng đảm bảo không có lỗi logic khác.
- Sự kiện bom có thể đếm hai lần (outbox phát lại)?
- 409 giá đổi có rò thông tin giá nội bộ (giá vốn, hoa hồng)?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_
