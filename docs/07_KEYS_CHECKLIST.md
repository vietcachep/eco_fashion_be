# 07 — Danh sách khoá / cấu hình để bạn tự điền

Mọi khoá bên thứ ba đang **để TRỐNG**. Hệ thống tự lùi về đường không-khoá nên chạy được ngay ở máy dev; điền khoá nào thì tính năng đó bật lên.
Điền vào `eco_backend/.env` (mẫu: `.env.example`), khởi động lại API + worker. Không commit `.env`.

| Khoá (`.env` backend) | Lấy ở đâu | Bật tính năng | Khi để trống |
|---|---|---|---|
| `EF_PAYOS_CLIENT_ID` · `EF_PAYOS_API_KEY` · `EF_PAYOS_CHECKSUM_KEY` | my.payos.vn → Kênh thanh toán | Thanh toán QR/chuyển khoản tự động (PayOS) ở checkout | Method `payos` **tự ẩn** khỏi web bán hàng; webhook trả 401 |
| `EF_PAYOS_PAYOUT_CLIENT_ID` · `EF_PAYOS_PAYOUT_API_KEY` · `EF_PAYOS_PAYOUT_CHECKSUM_KEY` | my.payos.vn → Lệnh chi (cặp khoá RIÊNG, nạp tiền vào tài khoản chi trước) | Chi trả shop tự động + hoàn tiền khách tự động | Kỳ đối soát để `pending`; kế toán chuyển tay rồi bấm "Đánh dấu đã chi" |
| `EF_PAYOS_API_URL` | mặc định `https://api-merchant.payos.vn` | — | giữ nguyên |
| `EF_VNPAY_TMN_CODE` · `EF_VNPAY_HASH_SECRET` | sandbox.vnpayment.vn (merchant test) | Thẻ ATM / Visa-Master / QR VNPay | VNPay tắt |
| `EF_BANK_TRANSFER_BANK_CODE` · `_ACCOUNT_NO` · `_ACCOUNT_NAME` | tài khoản nhận chuyển khoản của sàn | Mã VietQR ở trang thanh toán chuyển khoản | method `bank_transfer` tắt nếu thiếu số TK |
| `EF_OPENAI_API_KEY` (+ `EF_OPENAI_*_MODEL`) | platform.openai.com | Chatbot, FAQ, tóm tắt đánh giá, **AI tìm sản phẩm bằng ảnh**, insight | Mọi AI lùi về luật không-AI; tìm bằng ảnh trả `available:false` |
| `EF_REPLICATE_API_TOKEN` | replicate.com | Thử đồ 2D (tính năng cũ, đã ẩn khỏi menu) | tắt |
| `EF_CLOUDINARY_CLOUD_NAME` · `_API_KEY` · `_API_SECRET` | cloudinary.com | Lưu ảnh upload + ảnh dữ liệu mẫu | dùng `/static/seed` cục bộ |
| `EF_GOOGLE_CLIENT_ID` (+ `NEXT_PUBLIC_GOOGLE_CLIENT_ID` ở web bán hàng) | console.cloud.google.com | Đăng nhập Google | nút Google ẩn/lỗi nhẹ |
| `EF_MAIL_HOST/PORT/USER/PASSWORD/FROM` | SMTP thật (dev dùng mailpit) | OTP, email đơn hàng | dev dùng mailpit |
| `EF_STOREFRONT_URL` | URL công khai của web bán hàng (không phải khoá) | hiện chưa module nào dùng (biến chỉ được khai ở `src/config/env.ts`; dành cho link trong email sau này — email lời mời nhân viên gian hàng, nơi từng dùng nó, đã bỏ ngày 2026-10-13) | mặc định `http://localhost:3000` — khi sau này có email chứa link thì production PHẢI đặt đúng, nếu không link trỏ về localhost |
| `EF_PEXELS_API_KEY` (**chỉ seed**) | pexels.com/api | (chưa có script thay ảnh — lệnh `seed:images:pexels` đã gỡ khỏi package.json vì file `fetch-pexels.ts` không tồn tại; xem PLAN-0017 §12) thay ảnh minh hoạ tự sinh bằng ảnh thật theo ngành (**script `scripts/seed/tools/fetch-pexels.ts` hiện chưa có trong repo** — xem `docs/05_SEED_AND_REPRODUCE.md`) | giữ ảnh tự sinh |

## Webhook PayOS (khi đã có khoá)
1. Đặt `EF_PUBLIC_URL` = URL công khai của API (production phải `https`).
2. Trong dashboard PayOS khai báo webhook: `{EF_PUBLIC_URL}/api/v1/payments/payos/webhook` (PayOS gửi mẫu `orderCode=123` — hệ thống trả 200).
3. Web bán hàng có trang kết quả `/checkout/payos-return` gọi `GET /api/v1/payments/payos/return?orderCode=…` (hỏi lại PayOS rồi ghi nhận — an toàn dù webhook đến trước/sau).
4. **Lệnh chi (payout)**: chữ ký `x-signature` của API chi chưa được xác nhận với tài liệu PayOS (xem ghi chú trong `src/modules/payment/payos/payos.service.ts` hàm `payout`) —
   thử trên sandbox/khoá thật một kỳ nhỏ trước khi bật chi tự động hàng loạt. Chưa có webhook payout nên kỳ `processing` do kế toán xác nhận bằng "Đánh dấu đã chi".

## Frontend
| Biến | Repo | Ghi chú |
|---|---|---|
| `BACKEND_URL` | `fashion_frontend_admin` / `fashion_frontend_user` | URL API mà proxy `/api/*` chuyển tiếp tới (mặc định `http://localhost:4000`) |
| `NEXT_PUBLIC_API_URL` | cả hai | trống = gọi same-origin qua proxy (khuyến nghị) |
| `NEXT_PUBLIC_STOREFRONT_URL` | admin | URL web bán hàng (nút "Xem trên web") |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | user | đăng nhập Google |

## Tài khoản demo (sau `npm run seed`)
| Vai | Email | Mật khẩu |
|---|---|---|
| Quản trị sàn | `admin@ecofashion.vn` | `Admin123456!` |
| Nhân viên sàn (quản lý/bán hàng/kho/kế toán/marketing) | xem `scripts/seed/identity.seed.ts` | xem file đó |
| Chủ shop / nhân viên shop (18 shop) | email trong `scripts/seed/data/shops.ts` (vd `techzone@ecofashion.vn`, `nv.techzone@ecofashion.vn`) | `Vendor123456!` |
| Khách hàng | `khach1@ecofashion.vn` … `khach45@ecofashion.vn` | mật khẩu demo khách trong `identity.seed.ts` |

Đổi mật khẩu mặc định trước khi đưa lên môi trường thật. Seed từ chối chạy khi `NODE_ENV=production` trừ khi thêm `--force`.
