# PLAN-0014 — Pivot sang sàn thương mại điện tử đa gian hàng (Shop/Vendor domain + RBAC 2 tầng + tách đơn theo shop)

> Status: In progress — phần backend (bước 1–10) ĐÃ XONG theo mã nguồn (rà soát tài liệu 2026-10-03, cập nhật lại 2026-10-04; bước 7–10 làm tiếp trong PLAN-0017). Tài liệu (bước 11) đã cập nhật xong trừ `PLANS.md` ở thư mục gốc (ngoài phạm vi lượt rà soát tài liệu — còn ghi "một cửa hàng thời trang"). Còn lại: bước 5b-2 (`Shop.ratingAvg` không tính lại khi ẩn/sửa/xoá đánh giá), chạy lại `npm run verify` + `migration:check` + boot app, và các giới hạn đã biết ở **mục 14**.
> Owner: Agent
> Related Phase: Phase 5 — Marketplace pivot (mới, sau Phase 4 AI)
> Related Roadmap: `docs/04_ROADMAP.md` (đã có Phase 5 — PLAN-0014…0017)
> Plan liên quan: **PLAN-0015** (payment PayOS + ví/payout — làm SAU plan này, phụ thuộc `Shop`/`ShopCommissionSnapshot`).
> Plan phía FE: `fashion_frontend_admin/docs/plans/PLAN-0002-vendor-portal.md`,
> `fashion_frontend_user/docs/plans/PLAN-0008-marketplace-storefront-payos.md`.

> Luật ownership MỚI (thay thế luật cũ "một cửa hàng"): dữ liệu khách lọc theo `user_id` từ JWT như cũ;
> dữ liệu SẢN PHẨM/ĐƠN/KHUYẾN MÃI/ĐÁNH GIÁ lọc thêm theo `shop_id`; nhân viên SÀN phân quyền theo mã quyền
> `supplier.*` (thao tác/xem TRÊN BẤT KỲ shop nào); nhân viên/chủ SHOP phân quyền theo mã quyền `shop.*`
> (thao tác CHỈ TRÊN shop của chính họ, `shop_id` luôn suy từ JWT/membership — KHÔNG BAO GIỜ từ param URL).

---

## 1. Mục tiêu

* Biến FITLY từ **một cửa hàng thời trang** thành **một sàn TMĐT đa gian hàng** (mô hình Shopee): nhiều
  shop độc lập cùng bán trên một nền tảng, sàn thu hoa hồng, khách có thể mua sản phẩm của nhiều shop
  trong một lần checkout.
* Thêm domain `Shop` (gian hàng) + `ShopMember` (nhân viên/chủ của một shop) + RBAC 2 tầng (`supplier.*`
  cho nhân viên sàn thao tác trên mọi shop, `shop.*` cho nhân viên/chủ shop thao tác trên CHÍNH shop mình).
* Gắn `shop_id` vào product/inventory/cart/order/promotion/review — tách 1 giỏ hàng nhiều shop thành
  nhiều đơn con (mỗi shop một đơn, một vòng đời riêng), dùng chung 1 lần thanh toán.
* Giữ tối đa code hiện có: `Order` hiện tại (đã có đầy đủ vòng đời, STAFF_TRANSITIONS, outbox, idempotency,
  inventory reserve/commit) được TÁI SỬ DỤNG làm "đơn theo từng shop" — chỉ thêm cột `shopId`/`orderGroupId`,
  không viết lại máy trạng thái.
* Không tự làm PayOS/ví/payout trong plan này — xem PLAN-0015.

---

## 2. Bối cảnh

FITLY hiện là MỘT cửa hàng (AGENTS.md, PLANS.md): không `shop_id` ở đâu cả, `Order` không tách theo
người bán, RBAC (`identity/permission/catalog.ts`) toàn cục (không có scope theo shop), `manager` là vai
"quản lý cửa hàng" nhưng áp dụng toàn hệ thống.

Quyết định chốt sau khi khảo sát 2 dự án tham khảo:

| Quyết định | Lý do |
|---|---|
| **KHÔNG đổi stack** (giữ NestJS 12 + Prisma 7 + PostgreSQL schema-per-module). `D:\Fullstack\eco_books\eco_backend` (FastAPI/SQLAlchemy) chỉ tham khảo Ý TƯỞNG mô hình hoá, không copy code. | Đổi stack là viết lại từ đầu, không cần thiết — mô hình đơn cha/đơn con, RBAC 2 namespace, ví/payout đều portable sang Prisma. |
| **Đơn cha/đơn con TÁI DÙNG bảng `Order` hiện có làm "đơn con"**, thêm bảng mới `OrderGroup` làm "đơn cha" (chỉ chứa: mã đơn cha, user, địa chỉ giao, `paymentStatus` tổng, tổng tiền, 1 lần thanh toán). | Học từ eco_books (đơn cha không có trạng thái vòng đời, đơn con có) nhưng RẺ HƠN nhiều: không viết lại `OrderService.updateStatus`/`STAFF_TRANSITIONS`/inventory reserve-commit/outbox — chỉ thêm `shopId` + `orderGroupId` vào `Order`/`OrderItem` đã có. |
| **RBAC 2 namespace `supplier.*` (sàn) / `shop.*` (vendor)**, học nguyên si từ eco_books — kể cả bài học bảo mật của họ (KHÔNG dùng chung 1 mã quyền cho "xem ví BẤT KỲ shop" và "xem ví CỦA MÌNH"). | Đã có tiền lệ lỗ hổng thật ở dự án tham khảo — áp dụng ngay từ đầu tránh lặp lại. |
| **1 shop có NHIỀU nhân viên** (`ShopMember`), không giới hạn 1 user = 1 shop như eco_books. | eco_books tự nhận đây là hạn chế của họ; FE admin (fashion_frontend_admin) đã có sẵn RBAC user-level tốt (UserPermission deny-wins) — tận dụng luôn cho shop. |
| **Category vẫn là danh mục GLOBAL do sàn quản lý** (không cho từng shop tự tạo danh mục riêng). | Giữ trải nghiệm duyệt hàng thống nhất kiểu Shopee; shop chỉ được gắn sản phẩm vào category có sẵn, không tạo category. |
| **"Là shop hợp lệ" đọc thẳng `Shop.status === 'approved'`**, không tin cached role — học bài học "Authorization Source-of-Truth" của eco_books (`app/modules/supplier/deps.py`). | Tránh lệch pha khi sàn khoá shop mà quên thu hồi permission. |
| **Không phá vỡ 11 module hiện có** — thêm module MỚI `shop`, sửa TỐI THIỂU vào catalog/product/cart/order/promotion/review (chỉ thêm cột + đọc qua queryapi, không đổi luồng đã có). | Rule 2 (Sửa đâu đụng đó) và giữ 13 plan cũ "Done" không bị vô hiệu hoá. |

Tài liệu tham chiếu: `AGENTS.md`, `README.md`, `docs/04_ROADMAP.md`, `docs/03_DATABASE_RULES.md`,
`docs/06_FE_CONTRACT.md` (cần cập nhật sau khi duyệt plan — xem mục 12).

---

## 3. Phạm vi

### Trong phạm vi

* Module mới `shop`: entity `Shop`, `ShopMember`, `ShopRole`/`ShopRolePermission` (hoặc tái dùng bảng
  `Role`/`RolePermission` hiện có + cột `scope`), audit/outbox/queryapi theo đúng pattern module khác.
* Permission catalog: thêm namespace `supplier.*` (12 module) và `shop.*` (vendor tự quản), cập nhật
  `ROLE_CODES`/preset, thêm role `shop_owner`/`shop_staff` (scope='shop').
* Cột `shopId` (+ snapshot `shopName`/`shopSlug` nơi cần chứng từ) thêm vào: `product.Product`,
  `cart.CartItem`, `order.Order`, `order.OrderItem`, `promotion.Promotion` (+ cột `scope`), `review.Review`.
* Bảng mới `order.OrderGroup` (đơn cha) + cột `order.Order.orderGroupId`.
* Viết lại `OrderService.placeOrder()`: group giỏ theo `shopId` → **kiểm tra lại `Shop.status` của TỪNG
  shop trong giỏ NGAY TRONG transaction đặt hàng** (không tin trạng thái đã hiển thị lúc khách duyệt/thêm
  giỏ — sàn có thể vừa khoá shop giữa lúc khách bấm đặt hàng); `status !== 'approved'` → loại dòng hàng
  của shop đó khỏi đơn (không chặn toàn bộ checkout nếu giỏ còn shop khác hợp lệ, đúng tinh thần "xử lý
  độc lập theo từng shop" đã chốt ở §9) → validate COD khả dụng theo từng shop → tạo 1 `OrderGroup` + N
  `Order` (N = số shop hợp lệ trong giỏ), mỗi `Order` giữ nguyên toàn bộ logic cũ (mã đơn, snapshot giá,
  giữ kho, audit, outbox `ORDER_CREATED`) → 1 lần gọi `payment.initiate()` cho TỔNG tiền của `OrderGroup`.
* **Ẩn sản phẩm của shop không `approved` khỏi mọi API công khai** (storefront: danh sách/tìm kiếm/chi
  tiết sản phẩm) — sửa truy vấn danh sách sản phẩm public thêm điều kiện lọc theo trạng thái shop (qua
  `shop.queryapi`, hoặc denormalize 1 cột `Product.shopApproved` cập nhật qua outbox khi `Shop.status`
  đổi, để khỏi query chéo module mỗi lần liệt kê — chọn cách nào lúc code, không đổi hành vi). Trang quản
  trị NỘI BỘ (`/admin/products`, `/shop/products` của chính chủ shop) vẫn thấy sản phẩm của shop bị khoá
  để họ biết tình trạng, chỉ ẩn với KHÁCH.
* Cột `commissionRateSnapshot` trên `Order` (đóng băng `Shop.commissionRate` lúc đặt hàng — dùng cho
  PLAN-0015 tính payout, nhưng migration cột phải nằm trong plan NÀY vì cùng bảng `Order`).
* API mới: `AdminShopController` (`/admin/shops` — duyệt/khoá/xem shop, quyền `supplier.*`) và
  `ShopController` (`/shop/**` — vendor tự quản shop của mình, quyền `shop.*`, `shopId` suy từ
  `ShopMember` của JWT user, KHÔNG nhận qua param).
* **`Shop.ratingAvg` tính tự động** — cột đã có trong entity nhưng chưa có gì cập nhật; thêm listener
  outbox `review.REVIEW_MODERATED`/`review.REVIEW_CREATED` (đã bắn sẵn từ module `review`) → tính lại
  trung bình rating các review `status=approved` của TẤT CẢ sản phẩm thuộc shop đó, ghi vào
  `Shop.ratingAvg` (đúng pattern outbox liên module đã có, không polling).
* **Ràng buộc "shop luôn còn ít nhất 1 owner"** — `ShopMemberService.remove()`/`update()` (đổi role) chặn
  nếu thao tác khiến shop KHÔNG CÒN `ShopMember` nào giữ role `shop_owner` (trả lỗi rõ ràng, không cho
  xoá/hạ quyền owner cuối cùng — tránh shop mồ côi không ai quản lý được).
* **SKU sản phẩm: unique THEO SHOP, không phải toàn sàn** — kiểm tra constraint hiện có trên
  `ProductVariant.sku` (nếu đang unique toàn bảng thì đổi sang `@@unique([shopId, sku])` qua migration
  cùng bước 5); 2 shop khác nhau được phép có SKU trùng nhau (đúng bản chất mỗi shop là 1 người bán độc
  lập, không san sẻ mã hàng).
* **Báo cáo riêng theo shop** — `reporting` module thêm endpoint đọc theo `shopId` (doanh thu, đơn hàng,
  sản phẩm bán chạy CỦA RIÊNG 1 shop) cho FE vendor dashboard (`fashion_frontend_admin` PLAN-0002 đã dựng
  UI mock chờ đúng endpoint này — không thêm bảng mới, chỉ thêm điều kiện lọc `shopId` vào truy vấn
  `daily_sales`/order hiện có, quyền `shop.report.read`).
* **Thông báo tự động cho shop** — outbox listener trong `system.notification` (module đã có cơ chế gửi
  thông báo trong app) bắn thêm 2 loại: "có đơn mới" (khi `order.ORDER_CREATED` của 1 Order có `shopId`)
  và "sắp hết hàng" (khi `product.inventory` chạm `isLow=true`) — gửi cho MỌI `ShopMember` active của
  shop đó, tái dùng bảng/API thông báo hiện có, không tạo cơ chế mới.
* Migration Prisma cho toàn bộ thay đổi trên; cập nhật `docs/database/eco_fashion.dbml`,
  `docs/03_DATABASE_RULES.md`, `docs/06_FE_CONTRACT.md`, `AGENTS.md`/`PLANS.md`/`README.md §Trạng thái`
  (bỏ câu "MỘT cửa hàng, KHÔNG phải sàn").

### Ngoài phạm vi (việc khác/plan khác) — đã hỏi lại chủ dự án 2026-09-28, xác nhận giữ nguyên

* PayOS, ví quỹ COD (`ShopWallet`), payout định kỳ (`ShopPayout`) — **PLAN-0015**.
* Đăng ký shop mới (onboarding form cho người bán tương lai) — **xác nhận giữ tay**, admin tạo qua
  API/seed, không làm form tự đăng ký đợt này. Có thể là PLAN-0016 sau nếu cần.
* Phí vận chuyển theo từng shop tự cấu hình — **xác nhận dùng chung** bảng phí sàn hiện có
  (`system.shippingFeeFor`), không cho shop tự set phí ship riêng đợt này.
* Shop tự xử lý yêu cầu đổi trả của đơn mình — **xác nhận giữ tập trung**, nhân viên sàn vẫn duyệt mọi
  yêu cầu đổi trả qua `order.return.process` như hiện có, không thêm `shop.return.process`.
* FE admin (vendor portal UI) — `fashion_frontend_admin/docs/plans/PLAN-0002-vendor-portal.md`.
* FE storefront (hiển thị shop, tách giỏ theo shop) — `fashion_frontend_user/docs/plans/PLAN-0008-*.md`.
* AI module (gợi ý, chatbot...) — không đổi trong plan này; nếu sau này cần AI biết "shop nào" thì làm
  plan riêng.

---

## 4. Module ảnh hưởng

* **Mới**: `shop`
* **Sửa cột/queryapi, KHÔNG đổi luồng chính**: `identity` (permission catalog + Role.scope), `product`
  (Product.shopId, SKU unique theo shop), `cart` (CartItem.shopId), `promotion` (Promotion.scope/shopId)
* **Sửa luồng chính**: `order` (OrderGroup mới, placeOrder viết lại phần gom nhóm)
* **Sửa nhỏ**: `review` (Review.shopId snapshot + quyền `shop.review.reply` + bắn outbox cho rating),
  `reporting` (thêm lọc `shopId`), `system` (thêm 2 loại thông báo tự động cho shop)
* Không đụng: `ai`

---

## 5. Thiết kế DB

### Schema mới: `prisma/schema/shop.prisma` (Postgres schema `shop`)

```
model Shop {
  id               String   @id @default(uuid())
  code             String   @unique          // mã hiển thị, kiểu SHOP-000123
  slug             String   @unique
  name             String
  logoUrl          String?
  bannerUrl        String?
  description      String?
  status           ShopStatus @default(pending)  // pending|approved|suspended|rejected
  commissionRate   Decimal  @default(10.00) @db.Decimal(5,2)
  codEnabled       Boolean  @default(true)
  ratingAvg        Decimal? @db.Decimal(3,2)
  totalProducts    Int      @default(0)       // denormalized, cập nhật qua outbox listener từ product
  ownerUserId      String                     // id User (identity schema) tạo shop — chỉ tham chiếu, không FK
  createdAt/updatedAt/deletedAt (soft delete)
  // audit/outbox/processed theo đúng pattern các module khác
}
enum ShopStatus { pending approved suspended rejected }

model ShopMember {
  id        String @id @default(uuid())
  shopId    String
  userId    String                     // id User (identity), không FK xuyên schema
  roleId    String                     // trỏ Role (identity schema, scope='shop'), không FK xuyên schema
  status    ShopMemberStatus @default(active)  // active|removed
  createdAt/updatedAt
  @@unique([shopId, userId])
}
enum ShopMemberStatus { active removed }
```

Lý do không có FK vật lý `userId`/`roleId` sang schema `identity`: đúng luật hiện hành "không FK xuyên
schema, tham chiếu bằng id + snapshot" (`docs/03_DATABASE_RULES.md`). `queryapi` của `identity` cung cấp
hàm kiểm tra user tồn tại/role hợp lệ khi tạo `ShopMember`.

### Đổi bảng hiện có

* `identity.Role` — thêm cột `scope RoleScope @default(platform)` (`platform|shop`). Role hiện có
  (`admin, manager, sales, warehouse, accountant, marketing, customer`) giữ `scope=platform`; thêm 2 role
  mới `shop_owner`, `shop_staff` với `scope=shop`.
* `identity/permission/catalog.ts` — thêm khối permission mới:
  * `supplier.shop.read/approve/suspend/reject/update-commission` — nhân viên sàn (role `admin`/`manager`
    hiện có) thao tác trên MỌI shop.
  * `shop.profile.read/update`, `shop.product.*`, `shop.inventory.*`, `shop.order.read/update-status`,
    `shop.promotion.*`, `shop.review.read/reply`, `shop.staff.read/invite/update/remove`,
    `shop.report.read` (báo cáo doanh thu/đơn/sản phẩm bán chạy CỦA MÌNH, bước 9b) — vendor tự quản
    CHÍNH shop mình. `shop.staff.*` là điểm KHÁC eco_books (họ không có, 1 user/1 shop) — chủ shop thêm/gỡ
    nhân viên của chính mình (thêm = tạo tài khoản cho nhân viên, PLAN-0017 mục 20), tương tự `identity.user.*` nhưng scope hẹp theo shop.
  * (PLAN-0015 sẽ thêm `supplier.wallet.*`, `supplier.payout.*`, `shop.wallet.read`, `shop.payout.read`.)
* `product.Product` — thêm cột `shopId String` (bắt buộc, không nullable sau migration backfill).
* `cart.CartItem` — thêm cột `shopId String` (denormalize từ Product tại thời điểm thêm giỏ, để tách giỏ
  theo shop không cần join cross-schema lúc checkout).
* `promotion.Promotion` — thêm `scope PromotionScope @default(platform)` (`platform|shop`) và
  `shopId String?` (bắt buộc khi `scope=shop`).
* `review.Review` — thêm cột `shopId String` (snapshot từ Product tại thời điểm review, phục vụ
  `shop.review.read/reply`).
* `order.Order` — thêm cột `shopId String`, `orderGroupId String`, `commissionRateSnapshot Decimal(5,2)`.
* `order.OrderItem` — thêm cột `shopId String` (snapshot, dù đã suy được từ `Order.shopId`, giữ để nhất
  quán với các cột snapshot khác của bảng này).

### Bảng mới: `order.OrderGroup`

```
model OrderGroup {
  id             String   @id @default(uuid())
  code           String   @unique          // mã đơn cha hiển thị cho khách, vd ORD-GRP-000456
  userId         String
  addressSnapshot Json                     // địa chỉ giao tại thời điểm đặt (đóng băng)
  paymentStatus  OrderGroupPaymentStatus @default(pending)  // pending|paid|failed|refunded
  totalAmount    BigInt                   // tổng tiền TẤT CẢ đơn con, VND
  createdAt/updatedAt
}
enum OrderGroupPaymentStatus { pending paid failed refunded }
```

`Order` KHÔNG mất trạng thái vòng đời của nó (`pending→confirmed→packing→shipping→delivered→completed`,
`STAFF_TRANSITIONS` giữ nguyên) — mỗi `Order` (nay = "đơn theo shop") vẫn tự chạy máy trạng thái độc lập,
y hệt trước khi có `OrderGroup`; chỉ khác là nhiều `Order` có thể share 1 `OrderGroup.id` + 1 lần thanh
toán. `payment.Payment` đổi tham chiếu từ `orderId` sang `orderGroupId` (xem PLAN-0015) — hoặc, nếu muốn
đổi ít hơn nữa, `Payment` vẫn giữ `orderId` nhưng trỏ tới `Order` "đại diện" đầu tiên của group kèm cột
`orderGroupId` — QUYẾT ĐỊNH CUỐI để ở PLAN-0015 vì đụng trực tiếp bảng `payment.Payment`.

### Migration

* `src/modules/shop/migration/V<yyyymmdd><nnnnn>_shop_init.ts` — tạo schema `shop`, bảng `Shop`,
  `ShopMember` + audit/outbox/processed.
* `src/modules/identity/migration/V<...>_role_scope_and_shop_permissions.ts` — cột `Role.scope`, seed
  role `shop_owner`/`shop_staff`, chạy `perms:sync` để nạp permission catalog mới.
* `src/modules/product/migration/V<...>_product_shop_id.ts` — cột `shopId` (nullable trước, backfill
  bằng 1 shop mặc định "FITLY Official" tạo sẵn trong migration, rồi `NOT NULL` ở migration sau — 2 bước
  để không khoá bảng lớn ở môi trường có dữ liệu).
* `src/modules/cart/migration/V<...>_cart_item_shop_id.ts`
* `src/modules/promotion/migration/V<...>_promotion_scope.ts`
* `src/modules/review/migration/V<...>_review_shop_id.ts`
* `src/modules/order/migration/V<...>_order_group_and_shop_id.ts` — tạo `OrderGroup`, cột
  `Order.shopId/orderGroupId/commissionRateSnapshot`, `OrderItem.shopId`, backfill đơn cũ: mỗi `Order` cũ
  tự sinh 1 `OrderGroup` 1-1 (script backfill, không phải Prisma migration thuần).

### Luật

* Không FK xuyên schema (giữ nguyên luật cũ) — mọi tham chiếu `shopId` là id trần, xác thực tồn tại qua
  `shop.queryapi`.
* `shopId` trên các bảng nghiệp vụ (Product/Order/...) LUÔN lấy từ context server (JWT → `ShopMember` →
  `shopId`) khi vendor thao tác, KHÔNG BAO GIỜ nhận trực tiếp từ body/param của request `/shop/**`
  (nguyên tắc học từ eco_books, chống 1 vendor sửa param xem/sửa shop khác).
* Soft delete cho `Shop` (không xoá cứng — còn đơn hàng/lịch sử tham chiếu).
* Tiền vẫn `numeric(14,0)` VND; `commissionRate` là `Decimal(5,2)` (%).

---

## 6. API

```text
# Sàn quản lý shop (quyền supplier.*)
GET    /api/v1/admin/shops                    # danh sách, filter status
GET    /api/v1/admin/shops/:id
PATCH  /api/v1/admin/shops/:id/approve
PATCH  /api/v1/admin/shops/:id/suspend
PATCH  /api/v1/admin/shops/:id/reject
PATCH  /api/v1/admin/shops/:id/commission     # sửa commissionRate (không hồi tố đơn cũ)

# Vendor tự quản (quyền shop.*, shopId suy từ JWT)
GET    /api/v1/shop/me                        # thông tin shop của mình (qua ShopMember)
PATCH  /api/v1/shop/me
GET    /api/v1/shop/members
POST   /api/v1/shop/members                   # thêm nhân viên (chủ shop tạo tài khoản {email, fullName, password, roleCode}, quyền shop.staff.invite — tên cũ giữ nguyên; PLAN-0017 mục 20)
PATCH  /api/v1/shop/members/:id
DELETE /api/v1/shop/members/:id

# Đơn hàng: đơn cha lộ ra cho khách, đơn con lộ ra cho vendor + sàn
GET    /api/v1/orders                         # khách: trả OrderGroup + danh sách Order con bên trong
GET    /api/v1/orders/:groupCode
GET    /api/v1/shop/orders                    # vendor: đơn CỦA SHOP MÌNH (Order.shopId từ JWT)
PATCH  /api/v1/shop/orders/:code/status        # vendor cập nhật trạng thái đơn của mình (STAFF_TRANSITIONS)
```

* Request DTO validator, Response DTO không lộ entity Prisma; Swagger cập nhật đầy đủ (kể cả 2 tag mới
  `Shop (Admin)` và `Shop (Vendor)`).
* `POST /orders` (checkout) đổi response: trả `{ orderGroupCode, orders: [{ code, shopId, shopName }],
  paymentUrl/qrCode }` thay vì 1 `orderCode` — **BREAKING CHANGE** cho FE user, ghi rõ trong
  `docs/06_FE_CONTRACT.md`.
* **Làm khác so với thiết kế trên (xác minh theo mã nguồn 2026-10-03):**
  * `POST /orders` trả `OrderGroupResponse` = `{ code, recipientName, recipientPhone, shippingAddress, subtotal, shippingFee, discount, total, orders: OrderResponse[], createdAt }`
    (`order/order/dto/order.responses.ts`) — KHÔNG có `paymentUrl/qrCode` cấp nhóm: mỗi đơn con có `Payment` riêng (PLAN-0017 §3 quyết định 1), FE thanh toán lần lượt từng đơn con.
  * Mã đơn cha thật là `DHN<yymmdd><4 số>` (bảng `order.order_group_sequences`), không phải `ORD-GRP-…`. Route khách: `GET /orders/groups` và `GET /orders/groups/:code`;
    `GET /orders` vẫn trả danh sách đơn CON (tóm tắt, hoặc `full=true`) — không đổi sang trả nhóm.
  * Vendor đổi trạng thái đơn bằng `PUT /shop/orders/:code/status` (không phải PATCH); thêm `GET /shop/orders`, `/shop/orders/summary`, `/shop/orders/:code`, `POST /shop/orders/:code/cancel`.
  * `/shop/members` thêm `POST /shop/members/leave` (tự rời shop) và `GET /shop/session` (shop + vai + mã quyền `shop.*`); tên quyền thật: `supplier.shop.read/approve/suspend/reject/commission`,
    `shop.order.read/update`, `shop.inventory.read/manage`, `shop.promotion.read/manage`, `shop.product.read/manage` (xem `identity/permission/catalog.ts`).
  * Chưa có `POST /admin/shops` (tạo shop) — shop do seed (`scripts/seed/data/shops.ts`) hoặc tạo tay.

---

## 7. Bước triển khai

* [x] Bước 1: Module `shop` — entity `Shop`/`ShopMember`, migration, audit/outbox/queryapi theo khung
      chuẩn (copy cấu trúc từ `identity` hoặc `promotion` làm mẫu, module nhỏ nhất).
      (xác minh: `prisma/schema/shop.prisma`, `prisma/migrations/20260928014536_shop_init`, `src/modules/shop/**`)
* [x] Bước 2: `identity` — cột `Role.scope`, seed `shop_owner`/`shop_staff`, mở rộng
      `permission/catalog.ts` (namespace `supplier.*` + `shop.*` trừ wallet/payout), chạy `perms:sync`.
      (xác minh: `src/modules/identity/permission/catalog.ts`. **Làm khác ở tên quyền:** `supplier.shop.commission` (không phải `update-commission`),
      `shop.order.read/update`, `shop.inventory.read/manage`, `shop.promotion.read/manage`, `shop.product.read/manage`, `shop.report.read`; quyền ví/đối soát đã thêm ở PLAN-0017.)
* [x] Bước 3: `AdminShopController` (duyệt/khoá/sửa hoa hồng) — quyền `supplier.shop.*`.
      (xác minh: `src/modules/shop/shop/controller/admin-shop.controller.ts` — `GET /admin/shops[/:id]`, `PATCH :id/{approve,suspend,reject,commission}`;
      chưa có API tạo shop — xem mục 14.)
* [x] Bước 4: `ShopController` (self-service: profile, members) — quyền `shop.*`, guard đọc `shopId` từ
      `ShopMember` của JWT (viết `ShopContextGuard` dùng chung cho mọi route `/shop/**`, tương tự
      `require_approved_supplier` của eco_books — chặn nếu `Shop.status !== 'approved'`).
      **Đã làm khác một điểm so với thiết kế ban đầu** (ghi rõ ở mục 9/10): quyền `shop.*` KHÔNG kiểm qua
      `PermissionGuard`/`RequirePermission` toàn cục (vai scope=shop không gán vào `User.roleId` nên
      guard đó luôn thấy "thiếu quyền") — `ShopContextGuard` tự đọc mã quyền từ `ShopMember.roleId` qua
      `identity.queryapi.shopRoleContext()` và route dùng decorator riêng `@RequireShopPermission(...)`
      (metadata key khác `PERMISSIONS_KEY`). Bước 5+ khi thêm `shop.product.*`/`shop.order.*`… tiếp tục
      theo đúng cơ chế này.
      (xác minh 2026-10-03: `shop/security/shop-context.guard.ts` + `shop-context.guard.spec.ts`; `@AllowAnyShopStatus()` chỉ dùng cho `GET /shop/session` và `POST /shop/members/leave` —
      mọi route `/shop/**` khác trả 403 khi shop chưa duyệt/bị khoá. Nhân viên vào shop: lúc đầu **làm khác thiết kế** (thêm thẳng `active` một khách đã có tài khoản — xem mục 14), nay (2026-10-13) chủ shop TẠO TÀI KHOẢN cho nhân viên + thêm thẳng `active`, KHÔNG có luồng mời/chấp nhận — xem PLAN-0017 mục 20.)
* [x] Bước 5: `product.Product.shopId` — migration backfill vào shop mặc định, API tạo/sửa sản phẩm nhận
      `shopId` từ context (`/shop/products`) thay vì global (`/admin/products` chỉ còn cho sàn xem/kiểm
      duyệt tất cả, không sửa hộ). **Kèm luôn**: đổi constraint `ProductVariant.sku` sang
      `@@unique([shopId, sku])` (kiểm tra constraint hiện tại trước, nếu đang unique toàn bảng thì phải
      migration có bước kiểm tra dữ liệu cũ không bị đụng — dự án hiện chỉ 1 shop mặc định nên chắc chắn
      không trùng, an toàn đổi).
      **Đã làm khác một điểm quan trọng khi giao code cho vendor tạo/sửa sản phẩm (ghi cho lượt code)**:
      route `/shop/products/**` PHẢI dùng `ShopContextGuard` (bước 4) để tự gán `shopId`, cấm nhận
      `shopId` từ body — đúng nguyên tắc đã lặp lại nhiều lần trong plan này.
      (xác minh 2026-10-03: `prisma/migrations/20260929084707_product_shop_id`, `product/product/controller/shop-product.controller.ts` (+ `shop-product-image.controller.ts`),
      `product.service.ts` — vendor và admin dùng chung lõi `createCore/updateCore/saveVariantsCore/publishCore`, `shopId` vendor lấy từ `@CurrentShop()`.
      **Làm khác:** (1) `/admin/products` KHÔNG chỉ còn xem/kiểm duyệt — vẫn đủ tạo/sửa/đăng/ẩn/xoá; sản phẩm tạo ở đó luôn gắn shop chính chủ FITLY Official
      (`ShopQueryApi.findOfficialShopId()`, mã `SHOP-000001`); (2) SKU: bỏ `@@unique([shopId, sku])` khỏi `product.prisma`, thay bằng unique index PARTIAL
      `uq_product_variants_shop_sku_active (shop_id, sku) WHERE is_deleted = false` (migration `20261003140000_product_variant_sku_per_shop`, thay luôn `unique(sku)` toàn sàn còn sót
      từ `catalog_product_init`) — SKU của biến thể đã xoá mềm dùng lại được; (3) backfill `NOT NULL` làm trong MỘT migration nhiều bước (nullable → backfill → NOT NULL), không tách 2 migration.)
* [x] Bước 5b: **`Shop.ratingAvg` tự động** — outbox listener trong module `shop` lắng
      `review.REVIEW_MODERATED`/`REVIEW_CREATED`, tính lại trung bình review `approved` của mọi sản phẩm
      thuộc shop, ghi `Shop.ratingAvg` (đọc `product.shopId` qua `product.queryapi` để biết review nào
      thuộc shop nào, review module tự nó không biết shop).
      (xác minh: `src/modules/shop/shop-worker.module.ts` `ShopEventListeners`. **Làm khác:** listener nghe `REVIEW_CREATED` + `REVIEW_RATING_CHANGED` (không có sự kiện `REVIEW_MODERATED`),
      tính lại bằng SQL thô (ngoại lệ ranh giới — mục 14).)
* [ ] Bước 5b-2 (phần còn thiếu của 5b): tính lại `Shop.ratingAvg` khi đánh giá bị ẩn/duyệt/sửa điểm/xoá — `REVIEW_RATING_CHANGED` mới chỉ được khai báo + có listener, CHƯA có nơi nào phát
      (`review.service.ts` chỉ phát `REVIEW_CREATED`; `moderate`/`updateMine`/`deleteMine` chỉ gọi `syncStats` cho `Product.avgRating`). Xem mục 14.
* [x] Bước 5c: **Ràng buộc còn ít nhất 1 owner** — `ShopMemberService.remove()`/đổi role: đếm
      `ShopMember` còn active với role `shop_owner` của shop đó SAU khi thao tác, `=0` thì chặn (lỗi rõ
      ràng "Shop phải có ít nhất 1 chủ sở hữu").
      (xác minh: `shop/member/service/shop-member.service.ts` — `lockOwnersThenLoad` (FOR UPDATE) + `assertNotLastOwner` → 409 `SHOP_LAST_OWNER`, áp cho đổi vai/gỡ/tự rời; test `shop-member.spec.ts`,
      gồm cả trường hợp hai chủ hạ/gỡ nhau đồng thời.)
* [x] Bước 6: `cart.CartItem.shopId` — set khi thêm giỏ (đọc `Product.shopId` qua `product.queryapi`).
      (xác minh: `cart/cart.service.ts` (`products.getShopId`), migration `20260929084708_cart_item_shop_id`.)
* [x] Bước 7: `order` — `OrderGroup`, cột mới trên `Order`/`OrderItem`, viết lại `placeOrder()` (group
      theo shop, validate COD từng shop, tạo N Order + 1 OrderGroup, 1 lần `payment.initiate` cho tổng
      tiền group), backfill đơn cũ (script, không phải migration).
      (xác minh: `order/order/service/order.service.ts#placeOrder`, `order/repository/order.repository.ts` (`createGroup`, `nextGroupCode`), migration `20260929100000_order_group_shop_split`.
      **Làm khác thiết kế (đã tính vào code, KHÔNG phải thiếu sót):**
      (1) `payment.initiate` gọi MỖI đơn con (không phải 1 lần cho tổng nhóm); `Payment` giữ gắn đơn con — PLAN-0017 §3 quyết định 1;
      (2) `OrderGroup` KHÔNG có `paymentStatus`/`addressSnapshot`/`totalAmount` — thật là `recipient_name/recipient_phone/shipping_address/subtotal/shipping_fee/discount/total`; mã `DHN<yymmdd><4 số>`;
      (3) shop không `approved` (hoặc thành viên shop mua hàng của chính shop mình) ⇒ ném 409 `ORDER_SHOP_NOT_AVAILABLE`, COD mà shop tắt COD ⇒ 409 `ORDER_SHOP_COD_DISABLED` — chặn CẢ checkout,
      KHÔNG loại dòng của shop bị khoá rồi tạo đơn cho shop còn lại như §3/§8 thiết kế (`order.service.ts` ~dòng 320–336); `price()` cũng 409 `ORDER_CART_CHANGED` nếu có cảnh báo hết hàng/ngừng bán;
      (4) backfill đơn cũ nằm TRONG migration SQL (mỗi đơn cũ → 1 `OrderGroup`, mã `DHN` + phần sau `DH` của mã đơn), không có script riêng chạy lại;
      (5) `commissionRateSnapshot` ghi theo `Shop.commissionRate` đọc trong transaction; `ORDER_CREATED` phát theo TỪNG đơn con kèm `orderGroupCode`/`shopId`.)
* [x] Bước 8: `promotion.scope/shopId` — voucher sàn (`platform`, quyền cũ) vs voucher shop
      (`shop`, quyền `shop.promotion.*`). **Luật cộng dồn (chốt với chủ dự án):** mỗi `OrderGroup` được
      áp TỐI ĐA 1 voucher `platform` (giảm trên TỔNG tiền `OrderGroup`, trước khi tách phân bổ về từng
      `Order` con theo tỷ trọng) + MỖI `Order` con được áp thêm TỐI ĐA 1 voucher `scope=shop` của ĐÚNG
      shop đó (giảm riêng trên dòng hàng của shop mình, không ảnh hưởng đơn con khác). Không giới hạn nào
      khác ngoài 2 mức này — 1 voucher sàn + N voucher shop (N = số shop trong đơn, mỗi shop 1 cái) là
      trần cộng dồn tối đa cho 1 lần checkout. `PromotionGateway.quote()` nhận thêm tham số
      `orderGroupTotal` để tính phần trăm/tối đa giảm của voucher sàn đúng trên tổng, rồi phân bổ ngược
      về từng `Order` con theo tỷ trọng subtotal (để `Order.total` từng đơn con cộng lại đúng bằng
      `OrderGroup.totalAmount`).
      (xác minh: migration `20261003100000_marketplace_completion` (cột `scope`/`shop_id` + CHECK `chk_promotions_scope`), `promotion/shop-promotion.controller.ts` (`/shop/promotions`, quyền
      `shop.promotion.read/manage`), `order.service.ts` `price()` (luật 1 sàn + 1 shop/shop) và `applyVouchers()`, test `promotion/promotion-scope.spec.ts` + `order/order/service/order-voucher.spec.ts`.
      **Làm khác:** `PromotionGateway` thêm `scopeOf(code)`, `quote/consume` nhận `basket.shopId` — KHÔNG có tham số `orderGroupTotal`; voucher sàn được quote trên giỏ CẢ ĐƠN rồi phân bổ về đơn con
      theo tỉ lệ subtotal (freeship: theo phí ship từng gói), phần dư làm tròn dồn vào gói cuối có trọng số; mỗi đơn con không giảm quá `subtotal + ship`, voucher shop được ưu tiên.
      Thêm cột `order.orders.shop_discount/platform_discount/shop_promotion_code/_name` (migration `20261003120000_order_voucher_split`) — SÀN chịu voucher sàn, SHOP chịu voucher shop (PLAN-0017 §3b).)
* [x] Bước 9: `review.Review.shopId` snapshot + quyền `shop.review.reply` (vendor trả lời đánh giá sản
      phẩm của MÌNH — hiện tại chỉ nhân viên sàn `review.reply` trả lời được).
      (xác minh: migration `20260929084709_review_shop_id`, `review/review.service.ts` (`create` ghi `shopId`; `listShop`/`replyShop`), `review/shop-review.controller.ts` — `GET /shop/reviews`,
      `POST /shop/reviews/:id/reply`; chỉ đánh giá `approved` của chính shop, DTO vendor whitelist không lộ `userId`/email — test `review/review.spec.ts`.)
* [x] Bước 9b: **Báo cáo riêng theo shop** — `reporting` module thêm `shopId` optional vào query hiện có
      (doanh thu/đơn/sản phẩm bán chạy); route vendor mới `/shop/reports/*` (hoặc thêm param vào route
      hiện có, ép `shopId` từ context — quyết định lúc code) trả về đúng số liệu CỦA SHOP ĐÓ, quyền
      `shop.report.read`. Đây là phần BE mà FE admin PLAN-0002 đang chờ (UI vendor dashboard đã dựng
      trên mock, cần API thật để nối).
      (xác minh: `reporting/shop-reporting.controller.ts` + `shop-reporting.service.ts` — `GET /shop/reports/{dashboard,revenue,top-products,low-stock}`; chọn phương án route riêng, SQL lọc `shop_id`,
      KHÔNG đọc `daily_sales` (bảng toàn sàn); test `shop-reporting.spec.ts`, `shop-reporting-isolation.spec.ts`. `/admin/reports/**` KHÔNG nhận `shopId`.)
* [x] Bước 9c: **Thông báo tự động cho shop** — outbox listener trong `system.notification`: nhận
      `order.ORDER_CREATED` (đơn có `shopId`) → tạo thông báo "Đơn mới #<code>" cho mọi `ShopMember`
      active của shop; nhận sự kiện `product.inventory` khi 1 variant chuyển `isLow=true` → thông báo
      "Sắp hết hàng: <tên biến thể>". Tái dùng bảng/API thông báo hiện có của `system`, không tạo cơ chế
      mới; quyền đọc thông báo của vendor dùng permission thông báo hiện có (không cần mã mới).
      (xác minh: `system/system-worker.module.ts` `ShopNotificationListeners` — nghe `ORDER_CREATED`, `PRODUCT_STOCK_LOW` (phát từ `product/inventory/service/inventory.service.ts`), và làm thêm `ORDER_PAID`
      (đơn online) + `SHOP_BANK_CHANGED`; dedupe theo `payload.eventId`; test `system/system-worker.module.spec.ts`. Nằm ở worker module của `system`, không phải một service notification riêng.)
* [x] Bước 10: Seed script (`prisma/seed` hoặc script riêng) tạo 3-5 shop mẫu + gán `ShopMember` cho vài
      user test, để FE có dữ liệu thật thay mock.
      (xác minh: `scripts/seed/data/shops.ts` + `scripts/seed/marketplace.seed.ts` (bước `marketplace` trong `scripts/seed/index.ts`) — 18 gian hàng, đủ chủ/nhân viên, trong đó 1 `pending` (`cua-hang-moi`)
      và 1 `suspended` (`hang-nhai-24h`) để thử luồng duyệt/khoá. Kết quả chạy `npm run seed` không xác minh được trong lượt cập nhật tài liệu.)
* [~] Bước 11: Cập nhật `docs/06_FE_CONTRACT.md`, `docs/database/eco_fashion.dbml`,
      `docs/03_DATABASE_RULES.md`, `AGENTS.md`/`PLANS.md`/`README.md §Trạng thái` (bỏ "MỘT cửa hàng",
      thêm Phase 5 vào `docs/04_ROADMAP.md`). **Tiến độ theo từng file (kiểm lại 2026-10-04):**
  * [x] `docs/database/eco_fashion.dbml` — có đủ `shop.*`, `order_groups`, `dynamic_attributes`…, ví/đối soát; đã đối chiếu CỘT-THEO-CỘT với `prisma/schema/*.prisma`: 98/98 bảng khớp (phản ánh tới migration `20261003160000_wallet_cod_refund_type`).
  * [x] `docs/06_FE_CONTRACT.md` — mục "marketplace" (`POST /orders` trả `OrderGroupResponse`, voucher sàn+shop, PayOS, trang `/shops`), mục "vendor — cổng gian hàng `/shop/*`" và "sàn — route quản trị marketplace `/admin/*`" (route + mã quyền khớp controller). Không gắn nhãn "BREAKING" cho đổi response `POST /orders`.
  * [x] `AGENTS.md`, `docs/02_MODULE_MAP.md` — mô tả sàn đa gian hàng + module `shop` (+ queryapi/gateway/sự kiện outbox).
  * [x] `docs/03_DATABASE_RULES.md` — có schema `shop`, `order_groups`, ví/đối soát, `dynamic_attributes`, luật `shop_id`, SKU theo shop, CHECK enum-string, danh sách migration tới `20261003160000`.
  * [x] `README.md` (§1/§4/§8 + tài khoản demo + link `docs/07_KEYS_CHECKLIST.md`), `docs/04_ROADMAP.md` (Phase 5), `docs/00_PROJECT_CONTEXT.md`, `docs/01_ARCHITECTURE.md`, `docs/05_SEED_AND_REPRODUCE.md`.
  * [ ] `PLANS.md` (thư mục gốc, dòng 8 vẫn ghi "một cửa hàng thời trang") — chưa sửa (ngoài phạm vi lượt cập nhật tài liệu 2026-10-04).

---

## 8. Kiểm thử

> Rà soát 2026-10-03: các mục cần CHẠY lệnh/boot app/click tay (build, lint, boundaries, `npm test` chạy thật, migration:check, Swagger, thử tay) KHÔNG xác minh được trong lượt cập nhật tài liệu — để `[ ]`,
> chạy lại trước khi phát hành. Test được xác nhận bằng cách ĐỌC file `*.spec.ts` (tồn tại, nội dung khớp), không phải bằng kết quả chạy.

* [ ] `npm run build` xanh — không xác minh được trong lượt cập nhật tài liệu — chạy lại trước khi phát hành.
* [ ] `npm run lint` + `npm run check:boundaries` xanh (module `shop` không import repository/entity
      module khác; module khác chỉ đọc `shop` qua `shop.queryapi`) — không xác minh được (cần chạy lệnh). Ngoại lệ ranh giới đã biết: `shop-worker.module.ts` dùng SQL thô JOIN schema review/product (mục 14).
* [ ] `npm test` xanh — không chạy được trong lượt này. Test mới theo plan (tồn tại theo file spec):
  * [x] `ShopContextGuard` cách ly shop: `shop/security/shop-context.guard.spec.ts` ("mỗi vendor CHỈ resolve ra shopId của chính mình…", 401, không thuộc shop nào → 403, thiếu quyền → 403).
        **Làm khác:** vendor A truy cập sản phẩm của shop B nhận **404** (không lộ tồn tại), không phải 403 — test ở `product/product/service/product.service.spec.ts` ("vendor shop khác không đọc/sửa/đăng/ẩn/xoá được (404)").
  * [x] `placeOrder()` giỏ nhiều shop → 1 `OrderGroup` + N `Order`, tổng nhóm = Σ đơn con: `order/order/service/order-voucher.spec.ts` (describe "OrderService.placeOrder — consume voucher & ghi đơn", giỏ 3 shop A/B/C).
        Chưa có assert riêng cho `commissionRateSnapshot` trên đơn con trong test placeOrder (chỉ `shop-order.service.spec.ts`/payment spec dùng giá trị này).
  * [ ] COD bị chặn nếu 1 shop trong giỏ có `codEnabled=false` — code CÓ (`order.service.ts` ~dòng 334, 409 `ORDER_SHOP_COD_DISABLED`, fail cả checkout) nhưng KHÔNG thấy test placeOrder cho nhánh này
        (grep `SHOP_COD_DISABLED` trong `*.spec.ts` rỗng). Phần "ví COD ≤ 0 ⇒ tắt `codEnabled`" có test ở `payment/shop-wallet/shop-wallet.spec.ts` (PLAN-0015/0017).
  * [x] `Shop.status=suspended` → mọi API `/shop/**` trả 403 dù `ShopMember` vẫn active: `shop-context.guard.spec.ts` ("gian hàng bị khoá (suspended) → 403 dù ShopMember vẫn active").
  * [x] `Shop.status=suspended` → sản phẩm KHÔNG xuất hiện ở danh sách/chi tiết/gợi ý/by-ids public: `product/product/service/product-query.service.spec.ts`; `/admin/products` không lọc theo shop nên vẫn thấy.
        **Làm khác:** chính chủ shop KHÔNG xem được `/shop/products` khi shop bị khoá (guard trả 403 — chỉ `GET /shop/session`, `POST /shop/members/leave` cho phép mọi trạng thái).
  * [ ] Race: shop bị khoá NGAY TRƯỚC `placeOrder()` → thiết kế là loại dòng của shop đó, tạo đơn cho shop còn lại. **Làm khác:** code ném 409 `ORDER_SHOP_NOT_AVAILABLE` cho CẢ checkout
        (`order.service.ts` ~dòng 331–336) và KHÔNG có test cho nhánh "shop không approved" (test `SHOP_NOT_AVAILABLE` hiện có chỉ phủ nhánh chống mua chéo). Quyết định cần chủ dự án xác nhận — mục 14.
* [ ] `npm run migration:check` xanh (DB trống → migration → entity khớp), kể cả script backfill chạy
      idempotent (chạy 2 lần không tạo trùng `OrderGroup`) — không xác minh được. Ghi chú: backfill `OrderGroup` nằm trong migration `20260929100000_order_group_shop_split` (chạy một lần theo
      `WHERE order_group_id IS NULL`), không có script backfill riêng để chạy lại.
* [ ] Swagger hiện đủ 2 tag mới; thử tay luồng: tạo shop → duyệt shop → vendor đăng nhập → tạo sản phẩm →
      khách mua sản phẩm 2 shop 1 lần → xem 1 OrderGroup 2 Order. — code có `@ApiTags('admin-shops')`/`('shops')`; thử tay không xác minh được (cần boot app).
* [x] Không FK xuyên schema: đã quét `prisma/migrations/*/migration.sql` — mọi `REFERENCES` cùng schema với bảng chứa nó.
* [ ] Không import repository/entity module khác — cần `npm run check:boundaries` + `src/prisma-boundaries.spec.ts` (không chạy được); ngoại lệ đã biết ở mục 14.

---

## 9. Rủi ro / Ghi chú

* **Rủi ro**: `placeOrder()` là hàm lõi nhất hệ thống, sửa sai ảnh hưởng toàn bộ luồng bán hàng — viết
  test bao phủ trước khi refactor, chạy song song bản cũ (feature flag `MARKETPLACE_ENABLED`?) nếu cần
  triển khai từng bước trên môi trường có dữ liệu thật. Dự án hiện là môi trường phát triển/học tập
  (chưa có khách thật theo AGENTS.md), nên **giả định KHÔNG cần giữ tương thích ngược với dữ liệu sản
  xuất** — backfill 1 lần, không cần dual-write.
* **Rủi ro**: Category global có thể không đủ linh hoạt nếu sau này cần category riêng theo ngành hàng
  của từng shop — chấp nhận đánh đổi, có thể thêm `ShopCategoryOverride` sau nếu cần, không làm ngay.
* **Giả định**: 1 lần thanh toán cho toàn bộ `OrderGroup` (không tách thanh toán riêng từng shop) — đúng
  trải nghiệm Shopee-like phổ biến nhất; PLAN-0015 sẽ mô tả cách chia tiền `paid` về từng shop qua ví.
  * → **Làm khác (chốt ở PLAN-0017 §3 quyết định 1):** `Payment` vẫn gắn từng đơn CON, mỗi đơn con thanh toán riêng (PayOS = 1 link/đơn con); chưa có "1 link cho cả nhóm".
* **Giả định**: Vendor có thể có nhiều shop? — KHÔNG, 1 `ShopMember` = 1 user gắn 1 shop cụ thể, nhưng 1
  user CÓ THỂ là member của nhiều shop (bảng nhiều-nhiều) nếu sau này cần — không giới hạn ở schema.
* **Câu hỏi mở**: Đơn hàng có sản phẩm hết hàng ở 1 shop nhưng shop khác vẫn còn — cho phép đặt phần còn
  lại (tách đơn theo shop tự nhiên xử lý được việc này) hay huỷ toàn bộ? → Quyết định: xử lý ĐỘC LẬP theo
  từng `Order` con (đúng tinh thần tách đơn) — thiếu hàng ở shop A không chặn đơn của shop B.
  * → Đã thống nhất và ghi ngay trong plan (không còn để mở), coi là quyết định chính thức của bước 7.
* **Đã đổi so với thiết kế ban đầu (bước 1-4, chốt sau khi code)**: `shop.*` không kiểm bằng
  `PermissionGuard`/`@RequirePermission` toàn cục — vai scope=shop (shop_owner/shop_staff) CHỦ Ý không
  bao giờ gán vào `User.roleId` (tránh phải có gateway ghi chéo sang `identity.users` chỉ để đổi vai lúc
  mời nhân viên gian hàng). Thay vào đó: `ShopContextGuard` tự đọc mã quyền hiệu lực từ `ShopMember.roleId`
  qua `identity.queryapi.shopRoleContext(roleId)` (mới thêm), và route dùng decorator riêng
  `@RequireShopPermission(...)` (metadata key `ef:shop-permissions`, khác `PERMISSIONS_KEY` của guard toàn
  cục) — nhờ vậy `PermissionGuard` toàn cục bỏ qua các route `/shop/**` (không thấy metadata quen thuộc)
  thay vì luôn 403. `supplier.shop.*` (AdminShopController) vẫn dùng `PermissionGuard`/`@RequirePermission`
  bình thường vì nhân viên sàn là vai platform thật.
* **Rủi ro/việc dang dở cho bước 5+**: Bước 1-4 CHƯA có API tạo `Shop` (đúng phạm vi plan — "chỉ cần seed
  vài shop mẫu qua script/admin API" ở bước 10) nên hiện DB không có gian hàng thật nào; người làm bước 5+
  cần tự tạo Shop (script tạm hoặc `prisma.shop.create` tay) + ShopMember để test tay qua Swagger trước khi
  có seed chính thức. `ShopMemberService.invite()` yêu cầu người được mời ĐÃ có tài khoản (đăng ký như
  khách) — chưa có luồng "mời người chưa có tài khoản qua email" (ngoài phạm vi bước 1-4).
  * → **Cập nhật 2026-10-03:** (1) đã có seed 18 gian hàng (`scripts/seed/data/shops.ts`); (2) vẫn CHƯA có API tạo `Shop` (`/admin/shops` chỉ có đọc/duyệt/khoá/từ chối/hoa hồng);
    (3) `invite()` thêm THẲNG thành `active`, không có bước chấp nhận — xem mục 14. (→ Đổi tiếp 2026-10-13: `invite()` đã thay bằng `ShopMemberService.add()` — chủ shop tạo tài khoản nhân viên rồi thêm `active`; xem PLAN-0017 mục 20.)
* **Rủi ro**: `ShopContextGuard.findActiveByUserId()` lấy ShopMember active CŨ NHẤT khi 1 user có nhiều
  membership (thiết kế cho phép 1 user nhiều shop) — chưa có cơ chế cho vendor CHỌN đang thao tác shop nào;
  đủ dùng khi mỗi user chỉ thuộc 1 shop (giả định thực tế của bước 1-4), cần làm thêm nếu bước sau cho phép
  đa gian hàng thật sự.
  * → **Cập nhật 2026-10-03:** còn đúng (`shop/member/repository/shop-member.repository.ts` `findActiveByUserId`, `orderBy createdAt asc`). Giảm thiểu bằng luật "mỗi người chỉ thuộc MỘT gian hàng active"
    (lúc 2026-10-03: kiểm trong `ShopMemberService.invite` + advisory lock, KHÔNG có ràng buộc DB; từ 2026-10-04 đã có chốt DB `uq_shop_members_one_active_per_user`, và thêm nhân viên nay đi qua `ShopMemberService.add` — PLAN-0017 mục 20) và lối thoát `POST /shop/members/leave` — xem mục 14.
* **Đã đổi so với thiết kế ban đầu (bước 5–10, chốt theo mã nguồn khi rà soát 2026-10-03)**: xem ghi chú "Làm khác" ở từng bước mục 7 và mục 6. Tóm tắt: `placeOrder` chặn 409 thay vì loại dòng của shop bị khoá;
  `Payment` giữ gắn đơn con (không gộp theo nhóm); `OrderGroup` ít cột hơn thiết kế; `/admin/products` vẫn CRUD đủ (gắn shop chính chủ); SKU duy nhất bằng unique index partial; vendor của shop bị khoá không vào được
  `/shop/products` (chỉ `/shop/session`); `Shop.ratingAvg` nghe `REVIEW_CREATED`/`REVIEW_RATING_CHANGED` thay vì `REVIEW_MODERATED`.
* **Chặn**: Không.

---

## 10. Nhật ký tiến độ

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-28 | Tạo plan | Sau khảo sát song song eco_backend + 2 dự án tham khảo eco_books |
| 2026-09-28 | Bước 1-4 xong | Module `shop` (Shop/ShopMember + audit/outbox/queryapi/worker), `identity.Role.scope` + preset `shop_owner`/`shop_staff` + namespace `supplier.shop.*`/`shop.profile.*`/`shop.staff.*`, `AdminShopController`, `ShopController` + `ShopMemberController` + `ShopContextGuard`. `npm run verify`-tương đương xanh (build/lint/boundaries/test 52/52/migration:check) trên DB thật (docker `db`+`redis`, không chạy `api`/`migrate`/`seed` service — migration áp bằng `migration:deploy` tay). Đã boot thử `dist/src/main.js` (cổng phụ 4055, tránh đụng service đang chạy sẵn ở 4000) — Nest lên sạch, health `UP`, 12 route `/admin/shops/**` + `/shop/**` hiện đúng trong `/docs/openapi.json` với 2 tag mới `admin-shops`/`shops`. Tiện thể fix 1 lỗi test có sẵn không liên quan (`identity.spec.ts` thiếu field `otp` bắt buộc của `RegisterRequest` — lỗi từ trước, không phải do PLAN-0014). |
| 2026-09-28 | Rà soát toàn diện bài toán nghiệp vụ sàn (theo yêu cầu chủ dự án "khảo sát hết 1 lần rồi mới code") | Phát hiện + xử lý: (1) khoá shop giữa lúc checkout (race) + ẩn sản phẩm shop bị khoá khỏi trang khách — thêm vào §3/§8; (2) voucher sàn + voucher shop cộng dồn theo quy tắc rõ ràng — thêm bước 8; (3) rating shop tự tính từ review — thêm bước 5b; (4) ràng buộc còn ít nhất 1 owner — thêm bước 5c; (5) SKU unique theo shop thay vì toàn sàn — thêm vào bước 5; (6) báo cáo + thông báo riêng cho shop (BE còn thiếu dù FE đã dựng UI mock) — thêm bước 9b/9c. Đã hỏi lại và XÁC NHẬN GIỮ NGUYÊN (không đổi việc): đăng ký shop vẫn admin tạo tay, phí ship vẫn dùng chung, đổi trả vẫn sàn xử lý tập trung. |
| 2026-10-03 | Rà soát tài liệu theo mã nguồn (không chạy lệnh nào) | Đối chiếu từng bước/test/DoD với controller · service · repository · migration · `*.spec.ts`. Tick bước 5, 5b, 5c, 6, 7, 8, 9, 9b, 9c, 10 (bước 7–10 do PLAN-0017 làm); ghi rõ các điểm LÀM KHÁC thiết kế (placeOrder chặn 409 thay vì loại dòng, Payment theo đơn con, cột `OrderGroup`, SKU partial index, `/admin/products` vẫn CRUD…). Bước 11 (docs) làm dở: dbml/FE contract/AGENTS/MODULE_MAP xong, còn `03_DATABASE_RULES`/README/PLANS/ROADMAP. Phát hiện & ghi vào mục 14: `REVIEW_RATING_CHANGED` không ai phát (Shop.ratingAvg không tính lại khi ẩn/sửa/xoá đánh giá), mời nhân viên không có luồng chấp nhận, không có unique index một phần cho `shop_members`, cache công khai trễ khi khoá shop, test thiếu cho placeOrder nhánh shop khoá/COD tắt. Chưa xác minh được: build/lint/boundaries/test/migration:check/boot app/thử tay. |
| 2026-10-04 | Hoàn tất bước 11 (docs) + lập mục 14 | Đối chiếu dbml ↔ Prisma (98/98 bảng khớp), `03_DATABASE_RULES`, `02_MODULE_MAP`, `06_FE_CONTRACT` (route/quyền khớp controller), README, `05_SEED_AND_REPRODUCE`. Viết mục 14 "Việc còn lại / giới hạn đã biết" (các tham chiếu "xem mục 14" ở trên trước đó trỏ vào mục chưa tồn tại). Vẫn KHÔNG chạy lệnh nào. |

---

## 11. File đã đổi

```text
# Module mới `shop` (bước 1, 3, 4)
prisma/schema/shop.prisma                                              (mới)
prisma/schema/base.prisma                                              (+ "shop" vào datasource.schemas)
prisma/migrations/20260928014536_shop_init/migration.sql               (mới — Shop/ShopMember/audit/outbox/processed + CHECK)
src/modules/shop/shop.module.ts
src/modules/shop/shop-worker.module.ts
src/modules/shop/shop.spec.ts                                          (test: SHOP_TRANSITIONS hợp lệ/không hợp lệ)
src/modules/shop/foundation/shop.constants.ts
src/modules/shop/audit/shop-audit-log.service.ts
src/modules/shop/outbox/shop-outbox.service.ts
src/modules/shop/queryapi/shop.queryapi.ts                             (existsApproved/findBrief cho product/order… bước 5+)
src/modules/shop/security/shop-permission.decorator.ts                 (RequireShopPermission, CurrentShop, ShopContext)
src/modules/shop/security/shop-context.guard.ts
src/modules/shop/security/shop-context.guard.spec.ts                   (test: cách ly shop A/B, 401/403, thiếu quyền)
src/modules/shop/shop/repository/shop.repository.ts
src/modules/shop/shop/service/shop.service.ts                          (assertTransition + approve/suspend/reject/commission + getMe/updateMe)
src/modules/shop/shop/dto/shop.responses.ts
src/modules/shop/shop/request/shop.requests.ts
src/modules/shop/shop/mapper/shop.mapper.ts
src/modules/shop/shop/controller/admin-shop.controller.ts              (/admin/shops — quyền supplier.shop.*)
src/modules/shop/shop/controller/shop.controller.ts                    (/shop/me — quyền shop.profile.*)
src/modules/shop/member/repository/shop-member.repository.ts
src/modules/shop/member/service/shop-member.service.ts                 (add/updateRole/remove/leave + chặn gỡ/hạ chủ cuối cùng; `add` thay `invite` từ 2026-10-13)
src/modules/shop/member/dto/shop-member.responses.ts
src/modules/shop/member/request/shop-member.requests.ts
src/modules/shop/member/mapper/shop-member.mapper.ts
src/modules/shop/member/controller/shop-member.controller.ts           (/shop/members — quyền shop.staff.*)
src/app.module.ts                                                       (+ ShopModule)
src/worker.module.ts                                                    (+ ShopWorkerModule)

# identity (bước 2) — Role.scope + catalog quyền mới + hàm đọc cho ShopContextGuard
prisma/schema/identity.prisma                                           (+ Role.scope)
prisma/migrations/20260928014603_identity_role_scope_and_shop_permissions/migration.sql (mới)
scripts/sync-permissions.ts                                             (ghi Role.scope theo preset)
src/modules/identity/permission/catalog.ts                              (+ RoleScope, SHOP_ROLE_CODES, namespace supplier.*/shop.*, preset shop_owner/shop_staff, manager +supplier.shop.*)
src/modules/identity/permission/repository/permission.repository.ts    (+ scope trong RoleRow, findRoleById, findRolesByIds)
src/modules/identity/queryapi/identity.queryapi.ts                      (+ findUserBriefByEmail, findShopRoleByCode, shopRoleContext, findRoleBriefs)
src/modules/identity/user/repository/user.repository.ts                (+ findByEmail)
src/modules/identity/identity.spec.ts                                   (+ test scope/preset shop; fix có sẵn: RegisterRequest cần `otp`)

# Plan
docs/plans/PLAN-0014-marketplace-shop-vendor.md                        (tick bước 1-4, nhật ký, file đã đổi, rủi ro)
```

---

## 12. Việc tiếp theo

* [x] PLAN-0015 — PayOS + `ShopWallet` + `ShopPayout`: đã làm (thiết kế ở PLAN-0015, triển khai thực tế + điểm làm khác ở PLAN-0017).
* [ ] Đăng ký shop mới (self-service onboarding, hiện chỉ seed/tạo tay — chưa có API tạo shop) — plan riêng nếu cần.
* [x] Báo cáo doanh thu theo shop — đã làm ở bước 9b (`/shop/reports/*`, SQL lọc `shop_id`). Báo cáo `/admin/reports/*` vẫn toàn sàn, chưa có bộ lọc theo shop cho nhân viên sàn — plan riêng nếu FE sàn cần.
* [ ] Bước 5b-2 và các mục ở mục 14.

---

## 13. Definition of Done

* [ ] Build/lint/boundaries/test xanh — chưa chạy lại (xem mục 8)
* [x] Migration thêm đủ (`shop_init` → `…product_shop_id` → `…cart_item_shop_id` → `…review_shop_id` → `…order_group_shop_split`, + các migration của PLAN-0016/0017); `docs/database/eco_fashion.dbml` cập nhật và khớp Prisma
* [x] Không FK xuyên module (đã quét migration); import chéo qua queryapi/gateway/security — ngoại lệ có chủ đích: SQL thô của `ShopEventListeners` (mục 14). `npm run check:boundaries` chưa chạy lại.
* [x] Audit log cho API ghi (module shop/product/order/promotion/payment…); outbox `ORDER_CREATED` bắn theo từng đơn con kèm `orderGroupCode`/`shopId`
* [~] Swagger cập nhật; `docs/06_FE_CONTRACT.md` mô tả đổi response `POST /orders` (`OrderGroupResponse`) nhưng KHÔNG gắn nhãn "breaking change"
* [x] Plan checklist + nhật ký + file đã đổi cập nhật
* [~] README §Trạng thái + `docs/02_MODULE_MAP.md` + `AGENTS.md` cập nhật (bỏ "một cửa hàng"); `PLANS.md` ở thư mục gốc chưa sửa

---

## 14. Việc còn lại / giới hạn đã biết (rà soát mã nguồn 2026-10-04)

Các bước/ghi chú ở trên trỏ về mục này. Giới hạn của phần tiền/PayOS/seed xem `PLAN-0017` §12.

* **Không có API tạo gian hàng** (`/admin/shops` chỉ đọc/duyệt/khoá/từ chối/hoa hồng; không có form tự đăng ký) — chủ ý (đã xác nhận 2026-09-28): shop tạo bằng seed (`scripts/seed/data/shops.ts`) hoặc `prisma.shop.create` tay + một dòng `ShopMember` `shop_owner`.
* **Nhân viên vào shop KHÔNG qua luồng mời/chấp nhận** (làm khác thiết kế; lịch sử): ban đầu `ShopMemberService.invite()` thêm thẳng thành `active` một khách ĐÃ có tài khoản và chưa thuộc shop nào; 2026-10-04 từng thay bằng luồng lời mời có chấp nhận (`shop/invitation/**`, bảng `shop_invitations`) — **luồng lời mời ĐÃ BỎ HẲN 2026-10-13**, nay chủ shop THÊM TRỰC TIẾP: `ShopMemberService.add()` (`POST /shop/members` `{email, fullName, password, roleCode}`) TẠO TÀI KHOẢN khách mới + ShopMember `active` trong một transaction, khôi phục được nhân viên cũ của chính shop — xem PLAN-0017 mục 20; `invite()`, mã `SHOP_MEMBER_NOT_ADDABLE` và toàn bộ `SHOP_INVITATION_*` đã gỡ.
  Giảm thiểu: chỉ tạo tài khoản MỚI hoặc khôi phục nhân viên cũ của CHÍNH shop (không ai bị kéo vào shop khi chưa đồng ý; email đã có tài khoản ⇒ cùng một lỗi 409 `IDENTITY_EMAIL_EXISTS`, không dò được tài khoản), `@RateLimit` 30 lần/giờ, trần 50 thành viên active/shop, người dùng có `POST /shop/members/leave`.
* **(ĐÃ XỬ LÝ 2026-10-04 — migration `20261004090000_shop_invitations` thêm `uq_shop_members_one_active_per_user`; còn hiệu lực sau khi bảng lời mời bỏ ở `20261013090000`)** Không có unique index một phần `shop_members (user_id) WHERE status = 'active'`: luật "mỗi người một shop active" chỉ do service (advisory lock theo `userId` + kiểm lại trong transaction) giữ; ghi thẳng DB vẫn tạo được hai membership active. Khi một user có nhiều membership,
  `ShopContextGuard.findActiveByUserId()` lấy dòng active CŨ NHẤT và chưa có cơ chế để vendor chọn shop đang thao tác.
* **`Shop.ratingAvg` không tính lại khi đánh giá bị ẩn/duyệt lại/sửa điểm/xoá** (bước 5b-2): `REVIEW_RATING_CHANGED` khai báo ở `review/enums` và `ShopEventListeners` đã nghe, nhưng KHÔNG nơi nào phát — `review.service.ts` chỉ phát `REVIEW_CREATED`
  (`moderate`/`updateMine`/`deleteMine` chỉ gọi `syncStats` cho `Product.avgRating`). Sửa: phát `REVIEW_RATING_CHANGED` (payload `productId`) trong các thao tác đó, cùng transaction.
* **Ngoại lệ ranh giới có chủ đích**: `ShopEventListeners.updateShopRating` (`shop-worker.module.ts`) dùng SQL thô JOIN `review.reviews` × `product.products` để tính trung bình — thay bằng hàm của `ReviewQueryApi`/`ProductQueryApi` khi hai module đó có.
* **`placeOrder` khi một shop trong giỏ không còn `approved`** (hoặc người mua là thành viên shop đó, hoặc shop tắt COD) ném 409 (`ORDER_SHOP_NOT_AVAILABLE` / `ORDER_SHOP_COD_DISABLED`) cho CẢ checkout, thay vì loại riêng dòng của shop đó rồi tạo đơn cho shop còn lại như thiết kế §3/§8;
  hai nhánh "shop không approved" và "COD tắt" chưa có test (chỉ có nhánh chống mua chéo). Cần chủ dự án xác nhận hành vi mong muốn.
* **Cache công khai trễ khi sàn khoá/duyệt shop**: sản phẩm của shop vừa bị khoá còn hiện ở danh sách (cache 60s), chi tiết (2 phút), liên quan (5 phút), bộ lọc (10 phút); BE không xoá cache khi đổi trạng thái shop.
* **`/admin/*` chưa có chiều "gian hàng"**: `GET /admin/orders` không lọc theo shop và `OrderSummaryResponse` không có `shopId`/`shopName` (chi tiết đơn thì có); `GET /admin/products` bỏ qua tham số `shop`, `shop` trong thẻ luôn `null`; `/admin/inventory` không có thông tin/lọc theo shop;
  `/admin/reports/*` toàn sàn. `POST /admin/products` luôn tạo cho gian hàng chính chủ FITLY Official.
* **Backfill `OrderGroup` nằm trong migration SQL** (`20260929100000_order_group_shop_split`, chạy một lần theo `WHERE order_group_id IS NULL`) — không có script riêng chạy lại.
* **Đã chốt khác thiết kế (không phải thiếu sót)**: `Payment` gắn từng đơn CON, không gắn `OrderGroup` (PLAN-0017 §3 quyết định 1); `OrderGroup` không có `paymentStatus`/`addressSnapshot`/`totalAmount`; trả lời đánh giá của vendor hiển thị TÊN SHOP.
* **Chưa xác minh bằng chạy lệnh** (mục 8): build, lint, boundaries, `npm test`, `migration:check`, Swagger, thử tay luồng tạo shop → duyệt → vendor đăng nhập → khách mua 2 shop.
