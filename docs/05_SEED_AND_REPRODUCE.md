# 05 — Seed & tái lập trên máy khác

Mục tiêu bất di bất dịch của chủ dự án: **máy khác clone về, gắn `.env`, chạy `docker compose up -d --build`
là có đúng hệ thống + dữ liệu mẫu như máy gốc.** Mọi thứ do code định nghĩa phải đi qua migrate/seed; không
có bước tay.

## Luồng compose

```text
db (pgvector) · redis · mailpit
   └─ migrate  : prisma migrate deploy  →  perms:sync (catalog quyền → identity.permissions + preset vai)
        └─ seed : seed:admin (EF_ADMIN_EMAIL/PASSWORD)  →  seed (scripts/seed/index.ts: từng module theo thứ tự)
             └─ api · worker
```

`migrate` và `seed` là service chạy MỘT LẦN rồi thoát (`restart: "no"`); `api`/`worker` chờ
`service_completed_successfully`. Vì thế **seed lỗi = api không lên** → seed phải idempotent và không được
chết vì thiếu key dịch vụ ngoài.

## Danh sách seed (cập nhật khi thêm module)

| # | Module | File | Dữ liệu | Bắt buộc? |
|---|---|---|---|---|
| 0 | identity | `scripts/sync-permissions.ts` (service `migrate`) + `scripts/seed/create-admin.ts` (`seed:admin`) | 52 mã quyền + 7 vai + preset (chỉ THÊM, không gỡ mã admin thêm tay); admin từ `EF_ADMIN_*` (không đặt lại mật khẩu nếu đã có) | **bắt buộc**, chạy cả production |
| 1 | identity | `identity.seed.ts` ✅ | nhân viên mỗi vai (5), khách demo (5) + 1 địa chỉ mặc định/khách | demo |
| 2 | catalog | `catalog.seed.ts` ✅ | 7 ngành hàng + 4 bộ sưu tập **kèm ảnh** (`assets/catalog`), thuộc tính màu (10, hex) / size (15) / chất liệu (11) | demo (thuộc tính bắt buộc cho biến thể) |
| 3 | product | `product.seed.ts` ✅ | 24 sản phẩm quần áo đúng mock FE: 220 biến thể màu×size, 92 ảnh theo màu (`assets/product/<slug>/`), phiếu nhập `PN-SEED-0001` đã duyệt + sổ kho, tồn 2.824 | demo |
| 4 | system | `system.seed.ts` ✅ | 12 tham số vận hành (giữ giá trị đã sửa), 63 tỉnh/thành + phí ship theo vùng, 3 banner kèm ảnh, 6 FAQ, 5 trang chính sách | tham số/tỉnh bắt buộc |
| 5 | payment | `payment.seed.ts` ✅ | 3 phương thức (cod · bank_transfer · vnpay) | bắt buộc |
| 6 | promotion | `promotion.seed.ts` ✅ | 5 mã: FREESHIP, GIAM10, DAM100K (ngành đầm), CHAOBAN, HETHAN | demo |
| 7 | cart + order + payment | `order.seed.ts` ✅ | giỏ/wishlist khách 1–2; 14 đơn `DHDEMO0001..14` đủ trạng thái (COD/CK/VNPay, huỷ, đổi trả đã hoàn) + payments/giao dịch/đối soát/hoàn + lịch sử trạng thái + sổ kho (RESERVE/SALE/RETURN) + soldCount + promotion_usages | demo |
| 8 | review | `review.seed.ts` ✅ | đánh giá gắn dòng đơn đã giao (unique user+order_item), trả lời shop, 1 đánh giá ẩn + nhãn kiểm duyệt; cập nhật avg_rating/review_count | demo |
| 9 | ai | `ai.seed.ts` ✅ | 7 tài liệu kho tri thức (chính sách/FAQ/size/bảo quản/đặt hàng) đã cắt đoạn (không vector — worker nhúng lúc khởi động khi có `EF_OPENAI_API_KEY`), 1 phiên chat mẫu + yêu cầu hỗ trợ mở, lượt xem sản phẩm | demo |

`reporting.daily_sales` không seed — worker tính lại 7 ngày gần nhất lúc khởi động (và `POST /admin/reports/recompute` khi cần).

## Ảnh trong seed

`scripts/seed/lib/seed-images.ts` — ảnh nằm trong repo (`scripts/seed/assets`, nguồn Pexels, `NGUON-ANH.md`), máy khác seed KHÔNG cần mạng
ngoài Cloudinary. Có `EF_CLOUDINARY_*` → upload với `public_id` cố định `ecofashion/seed/<đường dẫn>` (đã có thì lấy URL sẵn — chạy lại
không tạo bản trùng). Không có → URL tĩnh `${EF_API_PUBLIC_URL}/static/seed/...` do API phục vụ. Module có ảnh phải dùng lớp này.

## Tài khoản demo

| Vai | Đăng nhập | Mật khẩu |
|---|---|---|
| Admin | `EF_ADMIN_EMAIL` (mặc định `admin@ecofashion.vn`) | `EF_ADMIN_PASSWORD` (mặc định `Admin123456!`) |
| Nhân viên | `manager@ecofashion.vn` · `sales@ecofashion.vn` · `warehouse@ecofashion.vn` · `accountant@ecofashion.vn` · `marketing@ecofashion.vn` | `NhanVien123!` |
| Khách | `khach1@ecofashion.vn` … `khach5@ecofashion.vn` | `Khach123456!` |

Domain phải là domain thật (`.vn`): validator email từ chối `.local/.test`.

## Cách kiểm "giống máy gốc" (làm sau mỗi plan)

```powershell
# clone mới vào thư mục tạm, copy .env, chạy project compose RIÊNG với cổng +10000 để không đụng stack đang dùng
git clone <repo> ef_fresh && cd ef_fresh && Copy-Item ..\eco_backend\.env .env
docker compose -p effresh -f docker-compose.yml -f docker-compose.fresh.yml up -d --build
```

`docker-compose.fresh.yml` đổi `container_name` + `ports: !override` (14000/15434/16381). So sánh số dòng
các bảng với DB gốc; khác nhau chỉ được ở dữ liệu thao tác tay. Xong thì `down -v --rmi local` + xoá thư mục.

## Không nằm trong seed (có chủ đích)

Lịch sử sử dụng thật (đơn khách đặt thử ngoài `DHDEMO*`, `ai.usage_logs`, refresh token, log đăng nhập, job thử đồ, ảnh người) — máy
khác không cần và không nên có. Cần y hệt thì dùng dump/restore, không nhét vào seed. Embedding vector cũng không seed (phụ thuộc key) —
worker tự nhúng; không key thì chatbot chạy rule + tìm từ khoá trên chunk.
