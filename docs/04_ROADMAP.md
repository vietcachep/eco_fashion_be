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
| PLAN-0007 | payment | COD, chuyển khoản VietQR (`paymentIntent`) + đối soát, **VNPay** (thẻ ATM/Visa/Master/QR — thay cho form thẻ mô phỏng của FE), IPN idempotent, hoàn tiền | ✅ Done (VNPay + VietQR đối soát tay đã bị PLAN-0018 gỡ; chỉ còn COD + PayOS) |
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
| PLAN-0015 | payment | PayOS thu tiền (khoá trống ⇒ tự ẩn) + chi (Lệnh chi), ví quỹ COD (đã bỏ ở PLAN-0018), đối soát chi trả shop (escrow theo hạn đổi trả, hoa hồng, nợ mang sang) — bản thiết kế; triển khai thực tế ghi ở PLAN-0017 | BE ✅ (làm khác thiết kế ở một số điểm — xem plan) |
| PLAN-0016 | catalog + product | Ngành hàng có bộ thuộc tính riêng (`attributeMode` legacy_fashion \| dynamic, ≤ 2 trục biến thể), thuộc tính động, mẫu thuộc tính theo ngành lá, khoá đổi mode khi ngành đã có sản phẩm | BE ✅; FE còn việc (xem plan) |
| PLAN-0017 | tất cả | Hoàn thiện sàn: vendor tự vận hành (đơn · kho · ảnh · voucher · báo cáo · ví · đối soát · đánh giá), PayOS + đối soát (ví COD sau đó bị PLAN-0018 gỡ), trang gian hàng công khai, AI tìm bằng ảnh, hardening (cách ly chéo shop, chống mua chéo, DTO vendor), seed dày (18 shop · 12 ngành gốc đa ngành hàng + nhóm thời trang · 48 ngành lá · 343 sản phẩm mới · ~930 ảnh minh hoạ · đơn/đánh giá/voucher/đối soát mẫu) | In progress — BE xong, FE/QA/review còn lại; giới hạn đã biết ở plan §12 |
| PLAN-0018 | payment · order · shop · identity · seed · FE | Sàn thu MỌI khoản tiền (PayOS + COD) → tự động trừ hoa hồng + chi trả shop (cron 02:00, `payout.auto_enabled`); bỏ VNPay, chuyển khoản tay, ví quỹ COD, `Shop.codEnabled`, 4 mã quyền ví (83 → 79); khoá PayOS thu/chi do chủ dự án cung cấp sau | In progress (2026-10-15) |
| PLAN-0019 | shop · identity · FE | Người bán tự đăng ký gian hàng, sàn duyệt hồ sơ | ✅ |
| PLAN-0020 | payment · order · shop | Ví đặt cọc COD (shop cầm tiền mặt, sàn trừ hoa hồng vào ví) | ✅ |
| PLAN-0021 | identity · product · order · shop · system · payment | Tách việc sàn / chủ shop: bỏ route ghi sản phẩm/kho/đơn/đánh giá của sàn, chủ shop tự phân quyền nhân viên, siết quyền sàn (ví cọc: kế toán duyệt, admin chỉnh; hoa hồng chỉ admin), liên hệ khách gửi shop/sàn, danh bạ shop, lọc theo shop ở màn sàn, bỏ vai Kho, CSKH | ✅ code + test, chờ deploy |
| PLAN-0022 | order · payment · identity · FE | Đổi trả & hoàn tiền đúng vai (shop duyệt/nhận, CSKH phân xử, kế toán chi, SLA tự chuyển bước) | ✅ code + test, chờ deploy |

## Phase 6 — Luồng mua bán end-to-end chạy với tiền thật (bản demo) — PLAN-0023

Điều phối: `docs/plans/PLAN-0023-order-lifecycle-go-live.md` · luật: `docs/10_ORDER_LIFECYCLE.md` · kịch bản: `docs/11_SCENARIO_CATALOGUE.md` · runbook: `docs/12_OPERATIONS_RUNBOOK.md` · **báo cáo audit E2E 2026-10-27: `docs/13_E2E_TEST_REPORT.md`** (sau đợt sửa P0: 290 ✔ · 18 ✘ · 33 ℹ trên 341 mã; 3 lỗi P0 AUD-01 deadlock webhook↔huỷ, AUD-02 mã kỳ chi trùng, AUD-03 đổi TK không cần mật khẩu **đã sửa và kiểm chứng trên Postgres thật** — docs/13 §11; còn P1 chặn tiền thật: AUD-04/05/06, AUD-10).

| Plan | WP | Nội dung | Ưu tiên | Đợt | Trạng thái |
|---|---|---|---|---|---|
| PLAN-0024 | 00 | Môi trường cô lập + smoke theo mã kịch bản | P0 | 0 | ⏳ |
| PLAN-0025 | 01 | Thanh toán vào an toàn (PayOS) | P0 | 1 | 🔧 một phần (hỏi PayOS trước khi huỷ đơn quá hạn); còn lại ⏳ |
| PLAN-0026 | 02 | Chi trả shop an toàn | P0 | 1 | 🔧 BE phần lớn (unknown/duyệt/giữ/đối chiếu/UNIQUE providerRef; còn đổi TK, giữ tay, lịch tuần, FE) |
| PLAN-0027 | 03 | Xử lý đơn có hạn chót & lối thoát | P0 | 1 | ⏳ |
| PLAN-0028 | 04 | Thông báo & email đủ người | P0 | 1 | ⏳ |
| PLAN-0029 | 05 | Công cụ vận hành & quan sát | P0 | 1 | ⏳ |
| PLAN-0030 | 06 | Hoa hồng & ví cọc COD đúng | P0 | 2 | 🔧 BE một phần (công thức hoa hồng/ví, ngưỡng, `transferRef`; còn bù trừ, nợ, rút cọc, sao kê) |
| PLAN-0031 | 07 | Giao hàng có bằng chứng & chống gian lận | P0 | 2 | ⏳ |
| PLAN-0032 | 08 | Checkout chặt & rủi ro COD khách | P1 | 2 | ⏳ |
| PLAN-0033 | 09 | Đổi trả đợt 2 | P1 | 3 | ⏳ |
| PLAN-0034 | 10 | Đối chiếu tiền hằng ngày & báo cáo kế toán | P0 | 3 | ⏳ |
| PLAN-0035 | 11 | Thuế, hoá đơn & pháp lý | — | — | Ngoài phạm vi (dự án demo) |
| PLAN-0036 | 12 | Dữ liệu cá nhân & lưu trữ | — | — | Ngoài phạm vi (dự án demo) |
| PLAN-0037 | 13 | Test end-to-end bằng tiền thật (thu – chi) + UAT theo vai | P0 | 4 | ⏳ |
| PLAN-0038 | 14 | Một QR cho cả nhóm đơn | P2 | 5 | Draft |
| PLAN-0039 | 15 | Tích hợp hãng vận chuyển | P2 | 5 | Draft |
| **PLAN-0040** | — | **Plan bàn giao một phiên: hoàn tất phần còn lại sau audit E2E** (thu tiền vào · chi trả · xử lý đơn · thông báo · AUD-03 còn lại · API sync + FE · triển khai) | P0 | 1–4 | Ready |

Sau mỗi plan: seed idempotent (kèm ảnh nếu module có ảnh) + docker compose dựng được trên máy trống + docs/DBML cập nhật.

## Ảnh trong seed (quy ước)

- 24 sản phẩm thời trang gốc: ảnh **Pexels** (Pexels License — dùng tự do) chọn tay đúng tên sản phẩm, lưu bản sao ở `scripts/seed/assets/<module>/` kèm `NGUON-ANH.md`
  (tác giả, giấy phép, link). Sản phẩm các ngành hàng khác + shop + bìa ngành + banner (PLAN-0017): ảnh minh hoạ TỰ SINH (nền gradient + biểu tượng đúng loại hàng,
  `npm run seed:gen-images`), nằm sẵn trong `scripts/seed/assets` (~930 ảnh, không bị gitignore — phải commit cùng repo) — máy khác seed KHÔNG cần mạng ngoài; xem `docs/05_SEED_AND_REPRODUCE.md`.
- Seed upload lên Cloudinary với `public_id` cố định (`ecofashion/seed/<module>/<slug>`) → chạy lại không tạo
  bản trùng; chưa cấu hình Cloudinary → dùng đường dẫn tĩnh `/static/seed/...` do API phục vụ.

PLAN-0044 (2026-11-06): nâng tìm ảnh từ keywords-only sang SigLIP2 ảnh↔ảnh + OCR + vision rerank, chọn vùng/món trên FE, worker index và deploy sidecar. Cổng kiểm trong plan và services/visual-encoder/README.md; không công bố accuracy khi chưa có benchmark gán nhãn.
