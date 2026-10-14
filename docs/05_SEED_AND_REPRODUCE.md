# 05 — Seed & tái lập trên máy khác

Mục tiêu bất di bất dịch của chủ dự án: **máy khác clone về, gắn `.env`, chạy `docker compose up -d --build`
là có đúng hệ thống + dữ liệu mẫu như máy gốc.** Mọi thứ do code định nghĩa phải đi qua migrate/seed; không
có bước tay. Mọi khoá bên thứ ba để TRỐNG vẫn dựng được (tính năng tương ứng tự lùi) — xem `docs/07_KEYS_CHECKLIST.md`.

## Luồng compose

```text
db (pgvector) · redis · mailpit
   └─ migrate  : prisma migrate deploy  →  perms:sync (catalog quyền → identity.permissions + preset vai, gồm shop_owner/shop_staff)
        └─ seed : seed:admin (EF_ADMIN_EMAIL/PASSWORD)  →  seed (scripts/seed/index.ts: 15 bước theo thứ tự phụ thuộc)
             └─ api · worker
```

`migrate` và `seed` là service chạy MỘT LẦN rồi thoát (`restart: "no"`); `api`/`worker` chờ
`service_completed_successfully`. Vì thế **seed lỗi = api không lên** → seed phải idempotent và không được
chết vì thiếu key dịch vụ ngoài. `npm run seed` từ chối chạy khi `NODE_ENV=production` (mật khẩu demo nằm trong mã nguồn) trừ khi thêm `--force`.

## Danh sách seed (15 bước trong `scripts/seed/index.ts`, theo đúng thứ tự chạy)

Thêm module/bước = thêm một dòng vào `STEPS` (đúng thứ tự phụ thuộc) + một file `scripts/seed/<tên>.seed.ts` export `seed(prisma)`.

| # | Bước | File | Dữ liệu | Bắt buộc? |
|---|---|---|---|---|
| 0 | (trước seed) identity | `scripts/sync-permissions.ts` (service `migrate`) + `scripts/seed/create-admin.ts` (`seed:admin`) | catalog 83 mã quyền + 9 vai (7 nền tảng + `shop_owner`/`shop_staff`) + preset (chỉ THÊM, không gỡ mã admin thêm tay); admin từ `EF_ADMIN_*` (không đặt lại mật khẩu nếu đã có) | **bắt buộc**, chạy cả production |
| 1 | `identity` | `identity.seed.ts` | nhân viên sàn mỗi vai (5), khách `khach1..5` + 1 địa chỉ mặc định/khách | demo |
| 2 | `system` | `system.seed.ts` | 12 tham số vận hành (giữ giá trị đã sửa), 63 tỉnh/thành + phí ship theo vùng, 3 banner kèm ảnh, 6 FAQ, 5 trang chính sách, 6 tin nhắn liên hệ | tham số/tỉnh **bắt buộc** |
| 3 | `catalog` | `catalog.seed.ts` | 7 ngành hàng thời trang (mode `legacy_fashion`) + 4 bộ sưu tập **kèm ảnh**, thuộc tính màu (10, hex) / size (15) / chất liệu (11) | demo (thuộc tính bắt buộc cho biến thể thời trang) |
| 4 | `marketplace` | `marketplace.seed.ts` + DSL `data/` (`data/dept/*.ts`, `data/shops.ts`, `data/types.ts`, `data/validate.ts`) | thuộc tính động dùng chung → **12 ngành gốc đa ngành hàng** (mode `dynamic`, 48 ngành lá có mẫu thuộc tính, ≤ 2 trục biến thể) → **18 gian hàng** (chủ + nhân viên ở vài shop, ví COD cho shop đã duyệt; 1 shop `pending` `cuahangmoi`, 1 shop `suspended` `hangnhai`, shop duyệt `timelab` tắt COD chủ ý) → **343 sản phẩm** có biến thể theo trục + ảnh + thuộc tính → bộ sưu tập theo ngành gốc → tồn kho qua phiếu nhập `posted` (mỗi shop một phiếu, có sổ kho). Mọi số liệu do DSL quyết định: `npm run seed:validate` in số ngành/sản phẩm/biến thể/ảnh/shop mà không cần DB | demo |
| 5 | `payment` | `payment.seed.ts` | 4 phương thức (cod · bank_transfer · vnpay · payos — `payos` tự tắt khi chưa có khoá) | **bắt buộc** |
| 6 | `promotion` | `promotion.seed.ts` | 5 mã sàn cũ: FREESHIP, GIAM10, DAM100K (ngành đầm), CHAOBAN, HETHAN | demo |
| 7 | `promotion-marketplace` | `promotion-marketplace.seed.ts` | voucher SÀN (`scope=platform`: freeship, %, số tiền, theo ngành, mã nội bộ, 1 mã hết hạn, 1 mã sắp hết lượt) + voucher từng SHOP (`scope=shop`, 2–3 mã/shop đã duyệt; shop bị khoá có 1 mã cũ; shop chờ duyệt không có mã) | demo |
| 8 | `product` | `product.seed.ts` | 24 sản phẩm quần áo (shop FITLY Official): 220 biến thể màu×size, 92 ảnh theo màu (`assets/product/<slug>/`), phiếu nhập `PN-SEED-0001` đã duyệt + sổ kho | demo |
| 9 | `order` | `order.seed.ts` | giỏ/wishlist khách 1–2; 14 đơn `DHDEMO0001..14` đủ trạng thái (COD/CK/VNPay, huỷ, đổi trả đã hoàn) + payments/giao dịch/đối soát/hoàn + lịch sử trạng thái + sổ kho (RESERVE/SALE/RETURN) + soldCount + promotion_usages | demo |
| 10 | `activity` | `activity.seed.ts` | thêm 40 khách (`khach6..45`, mỗi người một địa chỉ ở nhiều tỉnh) + ~320 đơn con LỊCH SỬ trải 110 ngày, gói trong ~270 `OrderGroup` (≈12% giỏ nhiều shop); mã đơn `DHSEED00001..`, nhóm `GRSEED00001..`; đủ payment/giao dịch (COD/CK/VNPay/PayOS), sổ kho, voucher sàn + shop (có lượt dùng), đổi trả + hoàn tiền (Refund có `shopId`), hoa hồng COD vào ví shop | demo |
| 11 | `settlement` | `settlement.seed.ts` | tài khoản ngân hàng shop, **ví quỹ COD** (sổ cái append-only + yêu cầu nộp quỹ pending/approved/rejected; đúng một shop approved có ví ≤ 0 ⇒ COD bị khoá để demo màn nộp quỹ), **kỳ đối soát lịch sử** (ShopPayout + dòng sale/refund + audit). Chỉ ĐỌC đơn `DHSEED*` của bước 10, chạy sau nó; công thức sao chép từ service thật | demo |
| 12 | `review` | `review.seed.ts` | đánh giá gắn dòng đơn đã giao `DHDEMO*` (unique user+order_item), trả lời shop, 1 đánh giá ẩn + nhãn kiểm duyệt; cập nhật avg_rating/review_count | demo |
| 13 | `review-marketplace` | `review-marketplace.seed.ts` | hàng trăm đánh giá theo ngành hàng gắn dòng đơn `DHSEED*` đã giao/hoàn tất (nội dung theo ngành lá), ~35% có shop trả lời, ~2% bị ẩn kiểm duyệt; tính lại `Product.avgRating/reviewCount` + `Shop.ratingAvg` | demo |
| 14 | `content-marketplace` | `content-marketplace.seed.ts` | banner theo từng ngành gốc + banner khuyến mãi chung, FAQ về sàn đa gian hàng, trang chính sách người bán/hoa hồng/đổi trả theo ngành, kho tri thức chatbot cho từng ngành gốc (cắt đoạn sẵn, không vector) | demo |
| 15 | `ai` | `ai.seed.ts` | 7 tài liệu kho tri thức (chính sách/FAQ/size/bảo quản/đặt hàng) đã cắt đoạn (không vector — worker nhúng lúc khởi động khi có `EF_OPENAI_API_KEY`), 1 phiên chat mẫu + yêu cầu hỗ trợ mở, lượt xem sản phẩm | demo |

`reporting.daily_sales` không seed — worker tính lại 35 ngày gần nhất lúc khởi động (và `POST /admin/reports/recompute` khi cần). Báo cáo của từng shop (`/shop/reports`) đọc thẳng đơn nên có số ngay.

### Idempotent — chạy lại sạch

- **Chạy lần 2, lần 3 không tạo trùng, không lỗi.** Mỗi bước tìm theo khoá tự nhiên (slug/code/email/mã đơn/mã voucher/cặp unique) rồi bỏ qua nếu đã có; **không ghi đè** phần đã sửa tay (giá/tồn đã đổi, mật khẩu đã đổi, voucher đã dùng). Sản phẩm đã có thì bước 4 chỉ đồng bộ ảnh.
- Đơn lịch sử (bước 9–10) tất định: mọi ngẫu nhiên đi từ PRNG cố định (mulberry32), nên cấu trúc đơn/đánh giá giống nhau ở mọi máy; chỉ MỐC THỜI GIAN tính từ lúc chạy lần đầu (`now − N ngày`).
- Muốn dựng lại từ đầu: `docker compose down -v` (xoá volume Postgres + Redis) rồi `docker compose up -d --build`. Không dùng `migrate reset`/`db push` trên DB dùng chung.
- Seed ghi thẳng DB, không qua API nên **cache Redis (danh mục/sản phẩm/bộ sưu tập, TTL 1–10 phút) có thể cũ sau khi seed** — hết TTL tự đúng, hoặc xoá khoá `ef:*` (Redis cổng 6381) để thấy ngay.
- Dữ liệu sai cấu trúc (slug trùng, sai trục biến thể, shop không bán ngành đó…) bị `validateSeedData` từ chối trước khi ghi — kiểm sớm bằng `npm run seed:validate`.

## Ảnh trong seed

`scripts/seed/lib/seed-images.ts` — toàn bộ ảnh nằm trong repo (`scripts/seed/assets`, **~930 file, commit cùng repo, không bị gitignore**), máy khác seed KHÔNG cần mạng ngoài Cloudinary:

| Nhóm | Số ảnh | Nguồn |
|---|---|---|
| 24 sản phẩm thời trang gốc (`assets/product/<slug>/{main,hover,mau-*}.jpg`) + 7 ngành thời trang + 4 bộ sưu tập cũ (khoảng 120 file) | ảnh Pexels chọn tay | Pexels License, nguồn trong `assets/NGUON-ANH.md` |
| 343 sản phẩm các ngành khác (`assets/product/<slug>/{a,b}.jpg`), logo/banner shop (`assets/shop/`), bìa ngành gốc/lá + bộ sưu tập (`assets/catalog/`), banner (`assets/banners/`) (khoảng 810 file) | ảnh minh hoạ **TỰ SINH** (nền gradient + biểu tượng đúng loại hàng), không tải gì từ bên ngoài | `npm run seed:gen-images` (cần Python + Pillow; chỉ chạy khi thêm sản phẩm/ngành/shop mới — ảnh đã có thì bỏ qua, thêm `--force` để vẽ lại) |

- Có `EF_CLOUDINARY_*` → upload với `public_id` cố định `ecofashion/seed/<đường dẫn không đuôi>`. Hàng trăm ảnh mà gọi Admin API từng ảnh sẽ chạm hạn mức 500 lệnh/giờ nên có **manifest cache** `assets/.cloudinary-manifest.json` (đường dẫn → url + sha1 nội dung): file không đổi thì không gọi mạng; chưa có trong manifest thì HEAD URL CDN (không tính hạn mức), có rồi dùng luôn, chưa có mới upload — chạy lại không tạo bản trùng.
- Không có Cloudinary → URL tĩnh `${EF_API_PUBLIC_URL}/static/seed/...` do API phục vụ (`main.ts` mount thư mục assets).
- Đổi tài khoản Cloudinary hoặc muốn nạp lại ảnh vào DB đã seed: `npm run seed:images` (đồng bộ URL ảnh ngành/bộ sưu tập/banner/sản phẩm theo `public_id` cố định).
- Muốn ảnh thật thay ảnh tự sinh: đặt `EF_PEXELS_API_KEY` rồi (chưa có script thay ảnh — lệnh `seed:images:pexels` đã gỡ khỏi package.json vì file `fetch-pexels.ts` không tồn tại; xem PLAN-0017 §12) — **lưu ý: lệnh này trỏ tới `scripts/seed/tools/fetch-pexels.ts`, file đó hiện KHÔNG có trong repo nên lệnh sẽ lỗi cho tới khi bổ sung** (ảnh minh hoạ tự sinh vẫn dùng bình thường).
- Module có ảnh phải dùng lớp `SeedImages` này (không tự gọi Cloudinary).

## Tài khoản demo

| Vai | Đăng nhập | Mật khẩu |
|---|---|---|
| Admin (+ chủ shop FITLY Official) | `EF_ADMIN_EMAIL` (mặc định `admin@ecofashion.vn`) | `EF_ADMIN_PASSWORD` (mặc định `Admin123456!`) |
| Nhân viên sàn | `manager@ecofashion.vn` · `sales@ecofashion.vn` · `warehouse@ecofashion.vn` · `accountant@ecofashion.vn` · `marketing@ecofashion.vn` | `NhanVien123!` |
| Chủ gian hàng (vai `shop_owner`) | `techzone@` · `mobilehub@` · `giadung@` · `nhaxinh@` · `beautybox@` · `healthy@` · `sneaker@` · `bagco@` · `timelab@` · `sportplanet@` · `babyland@` · `bookcafe@` · `ngonviet@` · `petworld@` · `automoto@` (đều `…@ecofashion.vn`) | `Vendor123456!` |
| Nhân viên gian hàng (vai `shop_staff`) | `nv.techzone@` · `nv.giadung@` · `nv.beautybox@ecofashion.vn` | `Vendor123456!` |
| Shop để thử luồng sàn | `cuahangmoi@ecofashion.vn` (gian hàng CHỜ DUYỆT) · `hangnhai@ecofashion.vn` (gian hàng BỊ KHOÁ) | `Vendor123456!` |
| Khách | `khach1@ecofashion.vn` … `khach45@ecofashion.vn` | `Khach123456!` |

Danh sách shop (slug, mã `SHOP-0000NN`, hoa hồng, trạng thái, COD) ở `scripts/seed/data/shops.ts` — nguồn sự thật cho bảng trên. Chủ/nhân viên shop dùng CHUNG web quản trị với nhân viên sàn nhưng vào cổng vendor (`/shop/**`).
Domain phải là domain thật (`.vn`): validator email từ chối `.local/.test`.

## Cách kiểm "giống máy gốc" (làm sau mỗi plan)

```powershell
# clone mới vào thư mục tạm, copy .env, chạy project compose RIÊNG với cổng +10000 để không đụng stack đang dùng
git clone <repo> ef_fresh && cd ef_fresh && Copy-Item ..\eco_backend\.env .env
docker compose -p effresh -f docker-compose.yml -f docker-compose.fresh.yml up -d --build
```

`docker-compose.fresh.yml` **không có trong repo** — tự tạo tạm khi cần chạy song song một stack thứ hai: đổi `container_name` của từng service và `ports: !override` (vd API 14000, Postgres 15434, Redis 16381)
vì `docker-compose.yml` cố định tên container + cổng. So sánh số dòng các bảng với DB gốc; khác nhau chỉ được ở dữ liệu thao tác tay. Xong thì `down -v --rmi local` + xoá thư mục.

## Không nằm trong seed (có chủ đích)

Lịch sử sử dụng thật (đơn khách đặt thử ngoài `DHDEMO*`/`DHSEED*`, `ai.usage_logs`, refresh token, log đăng nhập, job thử đồ, ảnh người) — máy
khác không cần và không nên có. Cần y hệt thì dùng dump/restore, không nhét vào seed. Embedding vector cũng không seed (phụ thuộc key) —
worker tự nhúng; không key thì chatbot chạy rule + tìm từ khoá trên chunk. Seed cũng không tạo thông báo/outbox cho đơn lịch sử và không gọi PayOS/VNPay thật
(giao dịch PayOS/VNPay trong dữ liệu mẫu chỉ là bản ghi để các màn có gì để vẽ).
