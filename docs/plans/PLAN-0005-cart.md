# PLAN-0005 — Cart: giỏ hàng theo tài khoản + wishlist

> Status: Done
> Owner: Agent
> Related Phase: Phase 3 — Mua hàng
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục cart / wishlist)

---

## 1. Mục tiêu

* Giỏ theo user (một `carts` / user, dòng theo **biến thể** màu×size, `selected` để FE tick từng dòng), tối đa
  `cart.max_qty_per_line` (tham số system) mỗi dòng và không vượt tồn khả dụng.
* Giá và ảnh lấy tươi từ `ProductQueryApi.variantSnapshots` mỗi lần đọc (không lưu giá trong giỏ); dòng hết hàng / sản phẩm
  ẩn được cảnh báo `isSellable=false` và bỏ khỏi tổng.
* Khách chưa đăng nhập giữ giỏ ở FE; đăng nhập → `POST /cart/merge` (cộng dồn, cắt theo tồn).
* Wishlist (theo sản phẩm), `CartGateway.removeLines` để order xoá dòng đã đặt trong cùng transaction.

## 3. Phạm vi

### Ngoài
Giá khuyến mãi (PLAN-0008 — tính ở checkout summary), giữ chỗ tồn (PLAN-0006 — chỉ khi đặt đơn).

## 5. Thiết kế DB — schema `cart`

`carts` (user_id unique) · `cart_items` (unique cart_id+variant_id, `selected`) · `wishlists` (unique user_id+product_id).
Không audit/outbox (dữ liệu tạm của khách). Migration `20260915110000_shop_modules_init`.

## 6. API

```text
GET /cart · POST /cart/items {variantId,quantity} · PATCH /cart/items/{variantId} {quantity} · PATCH /cart/items/{variantId}/select {selected} · DELETE /cart/items/{variantId}
DELETE /cart · POST /cart/merge {items[{variantId,quantity}]}
GET /wishlist · POST /wishlist/{productId} · POST /wishlist/{productId}/toggle · DELETE /wishlist/{productId}
```

## 7. Bước triển khai

* [x] B1 schema + migration · [x] B2 CartService/WishlistService + controllers · [x] B3 CartQueryApi.basketOf (order đọc) + CartGatewayImpl
* [x] B4 seed giỏ/wishlist demo (`order.seed.ts`) · [x] B5 smoke + docs

## 8. Kiểm thử

* [x] Smoke compose: thêm/sửa/xoá dòng, vượt tồn → 400, merge cộng dồn, giỏ trống sau khi đặt đơn (order gọi gateway trong tx).

## 9. Ghi chú
Giỏ KHÔNG giữ chỗ tồn kho — chỉ đơn mới giữ (tránh khoá tồn bởi giỏ bỏ quên).
