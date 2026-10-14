# 04 — Lộ trình triển khai

Thứ tự theo phụ thuộc dữ liệu; xong nền tảng module này mới sang module kế (AGENTS.md — Module Completion
Before Switching Rule). Tính năng lấy theo `D:\Fullstack\eco_books\eco_backend` (EcoShop) thu nhỏ; Phase 1–4 (PLAN-0001…0013) làm cho MỘT
cửa hàng quần áo, rồi Phase 5 (PLAN-0014…0017) pivot thành sàn đa gian hàng, đa ngành hàng. API phải khớp màn hình FE `D:\Fullstack\eco_fashion\fashion_frontend_user` (`docs/06_FE_CONTRACT.md`) và web quản trị `fashion_frontend_admin`.

| Plan | Module | Nội dung | Trạng thái |
|---|---|---|---|
| PLAN-0001 | skeleton + common | Dự án NestJS, common (response, lỗi, requestId, security context, guard quyền, gateway, audit/outbox/idempotency), Prisma 7, Docker, CI, gác ranh giới | ✅ Done |
| PLAN-0002 | identity | User/role/permission catalog/override, auth JWT + refresh rotation, quên mật khẩu OTP, địa chỉ, lịch sử đăng nhập, audit, outbox, seed admin + demo | ✅ Done |
| PLAN-0002b | identity đợt 2 | Đăng nhập Google (id_token), alias route theo FE (`PUT /users/me`, `POST /users/me/change-password`), địa chỉ nhập tay 3 cấp (mã tỉnh tuỳ chọn) | ✅ Done |
| PLAN-0003 | catalog | Ngành hàng (7 nhóm quần áo, ảnh), bộ sưu tập (= bộ lọc có sẵn), thuộc tính size/màu (hex)/chất liệu, cache Redis, **seed kèm ảnh public (Pexels → Cloudinary)** | ✅ Done |
| PLAN-0004 | product | Sản phẩm + biến thể màu×size, ảnh theo màu (Cloudinary), giá/giá gốc, badge, tồn kho + phiếu nhập/điều chỉnh, tìm kiếm + lọc (q/category/gender/size/color/giá/sale/sort), `InventoryGateway`, `ProductStatsGateway`, **seed 24 sản phẩm kèm ảnh đúng tên** | ✅ Done |
| PLAN-0005 | cart | Giỏ theo user (biến thể, tick từng dòng), wishlist, merge khi đăng nhập, `CartGateway` | ✅ Done |
| PLAN-0006 | order | Checkout idempotent (địa chỉ có sẵn hoặc nhập tay), mã đơn, phí ship theo tỉnh/freeship, vòng đời trạng thái, huỷ + nhả kho, đổi trả có minh chứng ảnh/video, job huỷ quá hạn / auto-complete | ✅ Done |
| PLAN-0007 | payment | COD, chuyển khoản VietQR (`paymentIntent`) + đối soát, **VNPay** (thẻ ATM/Visa/Master/QR — thay cho form thẻ mô phỏng của FE), IPN idempotent, hoàn tiền | ✅ Done (VNPay sandbox cần `EF_VNPAY_*` của chủ dự án) |
| PLAN-0008 | promotion | Mã %, số tiền, freeship; điều kiện đơn tối thiểu; `PromotionOfferResponse` (giảm thật cho giỏ hiện tại); `PromotionGateway.quote/consume/release` | ✅ Done |
| PLAN-0009 | review | Đánh giá đã mua (ảnh/video qua `/uploads/media`), trả lời shop, kiểm duyệt, "đánh giá của tôi", ghi điểm qua gateway, outbox cho AI | ✅ Done |
| PLAN-0010 | system | Tham số vận hành, banner trang chủ, thông báo, tỉnh/thành + phí ship, liên hệ (`POST /contact`), FAQ, trang chính sách, upload ảnh dùng chung | ✅ Done |
| PLAN-0011 | reporting | Dashboard (việc đang chờ), doanh thu theo ngày/tháng (`daily_sales` worker tính), bán chạy, tồn kho sắp hết / giá trị tồn | ✅ Done |
| PLAN-0012 | ai | Embedding pgvector + chatbot agent tool-calling (đọc đơn, thêm giỏ/huỷ đơn có xác nhận, chuyển nhân viên) + gợi ý (for-you/similar/mua cùng/giỏ/bộ sưu tập) + so sánh + FAQ tự sinh + tín hiệu & phễu + bot bí + hỏi số liệu + công cụ nhân viên + tóm tắt/kiểm duyệt đánh giá + kho tri thức + cổng chi phí; đường lùi rule khi không key (đủ eco_books trừ dịch) | ✅ Done |
| PLAN-0013 | ai đợt 2 (FE riêng) | **Thử đồ 2D** (Replicate IDM-VTON: ảnh người + ảnh sản phẩm → ảnh kết quả, job nền + poll) và **phân tích ảnh người → gợi ý sản phẩm** (OpenAI vision: dáng người, màu hợp, phong cách → lọc catalog) | ✅ Done (smoke thật) |

## Phase 5 — Sàn đa gian hàng, đa ngành hàng (pivot từ "một cửa hàng")

| Plan | Module | Nội dung | Trạng thái |
|---|---|---|---|
| PLAN-0014 | shop + (product · cart · order · promotion · review · reporting · system) | Module `shop` (gian hàng + thành viên + `ShopContextGuard`, RBAC 2 tầng `supplier.*`/`shop.*`), `shopId` trên sản phẩm/giỏ/đơn/voucher/đánh giá, đơn cha `OrderGroup` + đơn con theo shop, voucher sàn + shop, `Shop.ratingAvg`, ràng buộc ≥ 1 chủ shop, SKU duy nhất trong shop, thông báo + báo cáo theo shop | BE ✅ (xem checklist + "Việc còn lại" trong plan) |
| PLAN-0015 | payment | PayOS thu tiền (khoá trống ⇒ tự ẩn) + chi (Lệnh chi), ví quỹ COD (khoá COD khi ví ≤ 0, nộp quỹ), đối soát chi trả shop (escrow theo hạn đổi trả, hoa hồng, nợ mang sang) — bản thiết kế; triển khai thực tế ghi ở PLAN-0017 | BE ✅ (làm khác thiết kế ở một số điểm — xem plan) |
| PLAN-0016 | catalog + product | Ngành hàng có bộ thuộc tính riêng (`attributeMode` legacy_fashion \| dynamic, ≤ 2 trục biến thể), thuộc tính động, mẫu thuộc tính theo ngành lá, khoá đổi mode khi ngành đã có sản phẩm | BE ✅; FE còn việc (xem plan) |
| PLAN-0017 | tất cả | Hoàn thiện sàn: vendor tự vận hành (đơn · kho · ảnh · voucher · báo cáo · ví · đối soát · đánh giá), PayOS + ví + đối soát, trang gian hàng công khai, AI tìm bằng ảnh, hardening (cách ly chéo shop, chống mua chéo, DTO vendor), seed dày (18 shop · 12 ngành gốc đa ngành hàng + nhóm thời trang · 48 ngành lá · 343 sản phẩm mới · ~930 ảnh minh hoạ · đơn/đánh giá/voucher/đối soát/ví mẫu) | In progress — BE xong, FE/QA/review còn lại; giới hạn đã biết ở plan §12 |

Sau mỗi plan: seed idempotent (kèm ảnh nếu module có ảnh) + docker compose dựng được trên máy trống + docs/DBML cập nhật.

## Ảnh trong seed (quy ước)

- 24 sản phẩm thời trang gốc: ảnh **Pexels** (Pexels License — dùng tự do) chọn tay đúng tên sản phẩm, lưu bản sao ở `scripts/seed/assets/<module>/` kèm `NGUON-ANH.md`
  (tác giả, giấy phép, link). Sản phẩm các ngành hàng khác + shop + bìa ngành + banner (PLAN-0017): ảnh minh hoạ TỰ SINH (nền gradient + biểu tượng đúng loại hàng,
  `npm run seed:gen-images`), nằm sẵn trong `scripts/seed/assets` (~930 ảnh, không bị gitignore — phải commit cùng repo) — máy khác seed KHÔNG cần mạng ngoài; xem `docs/05_SEED_AND_REPRODUCE.md`.
- Seed upload lên Cloudinary với `public_id` cố định (`ecofashion/seed/<module>/<slug>`) → chạy lại không tạo
  bản trùng; chưa cấu hình Cloudinary → dùng đường dẫn tĩnh `/static/seed/...` do API phục vụ.
