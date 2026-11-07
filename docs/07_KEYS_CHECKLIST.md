# 07 — Danh sách khoá / cấu hình để bạn tự điền

Mọi khoá bên thứ ba đang **để TRỐNG**. Hệ thống tự lùi về đường không-khoá nên chạy được ngay ở máy dev; điền khoá nào thì tính năng đó bật lên.

> **Thanh toán (PLAN-0018)**: chỉ còn **PayOS thu** + **PayOS chi** (không còn VNPay, không còn chuyển khoản VietQR tay). **Chủ dự án sẽ cung cấp hai cặp khoá PayOS này SAU.** Cho tới lúc đó hệ thống vẫn chạy bình thường và tự lùi: khách chỉ thấy phương thức `cod`; kỳ đối soát vẫn được tạo nhưng chi trả KHÔNG gọi mạng (để `pending` cho kế toán chuyển tay + "Đánh dấu đã chi"); cron chi trả tự động bỏ qua khi chưa có khoá chi.
Điền vào `eco_backend/.env` (mẫu: `.env.example`), khởi động lại API + worker. Không commit `.env`.

| Khoá (`.env` backend) | Lấy ở đâu | Bật tính năng | Khi để trống |
|---|---|---|---|
| `EF_PAYOS_CLIENT_ID` · `EF_PAYOS_API_KEY` · `EF_PAYOS_CHECKSUM_KEY` | my.payos.vn → Kênh thanh toán | Thanh toán QR/chuyển khoản tự động (PayOS) ở checkout | Method `payos` **tự ẩn** khỏi web bán hàng (chỉ còn COD); webhook trả 401 |
| `EF_PAYOS_PAYOUT_CLIENT_ID` · `EF_PAYOS_PAYOUT_API_KEY` · `EF_PAYOS_PAYOUT_CHECKSUM_KEY` | my.payos.vn → Lệnh chi (cặp khoá RIÊNG, nạp tiền vào tài khoản chi trước) | Chi trả shop tự động (cron hằng ngày + chạy tay) + hoàn tiền khách tự động | Cron/chạy kỳ vẫn lập kỳ đối soát nhưng không gọi PayOS: kỳ để `pending`, kế toán chuyển tay rồi bấm "Đánh dấu đã chi" |
| `EF_PAYOS_API_URL` | mặc định `https://api-merchant.payos.vn` | — | giữ nguyên |
| `EF_OPENAI_API_KEY` (+ `EF_OPENAI_*_MODEL`) | platform.openai.com | Chatbot, FAQ, tóm tắt đánh giá, **AI tìm sản phẩm bằng ảnh**, insight | Mọi AI lùi về luật không-AI; tìm bằng ảnh trả `available:false` |
| `EF_REPLICATE_API_TOKEN` | replicate.com | Thử đồ 2D (tính năng cũ, đã ẩn khỏi menu) | tắt |
| `EF_CLOUDINARY_CLOUD_NAME` · `_API_KEY` · `_API_SECRET` | cloudinary.com | Lưu ảnh upload + ảnh dữ liệu mẫu | ảnh seed dùng link Cloudinary đã đóng gói sẵn (không cần khoá); ảnh upload mới cần khoá |
| `EF_GOOGLE_CLIENT_ID` (+ `NEXT_PUBLIC_GOOGLE_CLIENT_ID` ở web bán hàng) | console.cloud.google.com | Đăng nhập Google | nút Google ẩn/lỗi nhẹ |
| `EF_MAIL_HOST/PORT/USER/PASSWORD/FROM` | SMTP thật (dev dùng mailpit) | OTP, email đơn hàng | dev dùng mailpit |
| `EF_STOREFRONT_URL` | URL công khai của web bán hàng (không phải khoá) | hiện chưa module nào dùng (biến chỉ được khai ở `src/config/env.ts`; dành cho link trong email sau này — email lời mời nhân viên gian hàng, nơi từng dùng nó, đã bỏ ngày 2026-10-13) | mặc định `http://localhost:3000` — khi sau này có email chứa link thì production PHẢI đặt đúng, nếu không link trỏ về localhost |
| `EF_ADMIN_URL` | URL công khai của web quản trị (không phải khoá; `https://…`, không dấu `/` cuối) | Nạp cọc COD qua PayOS (PLAN-0041): PayOS trả chủ shop về `${EF_ADMIN_URL}/vendor/wallet/payos-return` | mặc định `http://localhost:3001`; production PHẢI đặt `https://…` — nếu sai, tạo link nạp qua PayOS trả 503 `WALLET_TOPUP_UNAVAILABLE` (app vẫn chạy; luồng nạp chuyển khoản tay không bị ảnh hưởng) |
| `EF_PEXELS_API_KEY` (**chỉ seed**) | pexels.com/api | (chưa có script thay ảnh — lệnh `seed:images:pexels` đã gỡ khỏi package.json vì file `fetch-pexels.ts` không tồn tại; xem PLAN-0017 §12) thay ảnh minh hoạ tự sinh bằng ảnh thật theo ngành (**script `scripts/seed/tools/fetch-pexels.ts` hiện chưa có trong repo** — xem `docs/05_SEED_AND_REPRODUCE.md`) | giữ ảnh tự sinh |

## Webhook PayOS (khi đã có khoá)
1. Đặt `EF_PUBLIC_URL` = URL công khai của API (production phải `https`).
2. Trong dashboard PayOS khai báo webhook: `{EF_PUBLIC_URL}/api/v1/payments/payos/webhook` (PayOS gửi mẫu `orderCode=123` — hệ thống trả 200).
3. Web bán hàng có trang kết quả `/checkout/payos-return` gọi `GET /api/v1/payments/payos/return?orderCode=…` (hỏi lại PayOS rồi ghi nhận — an toàn dù webhook đến trước/sau).
4. **Lệnh chi (payout)**: chữ ký `x-signature` của API chi chưa được xác nhận với tài liệu PayOS (xem ghi chú trong `src/modules/payment/payos/payos.service.ts` hàm `payout`) —
   thử trên sandbox/khoá thật một kỳ nhỏ trước khi bật chi tự động hàng loạt (cron chi trả mặc định bật qua setting `payout.auto_enabled`; tắt ở màn tham số nếu muốn chạy tay). Tài khoản chi PayOS phải đủ số dư trước 02:00 mỗi ngày (xem `GET /admin/payouts/payos-balance`). Chưa có webhook payout nên kỳ `processing` do kế toán xác nhận bằng "Đánh dấu đã chi".

## Nạp cọc qua PayOS (PLAN-0041)
1. Dùng CHUNG webhook ở trên (`{EF_PUBLIC_URL}/api/v1/payments/payos/webhook`), không khai thêm URL. Link nạp cọc có mã riêng dải `5…` nên hệ thống tự phân biệt với mã đơn hàng.
2. Cờ `wallet.payos_deposit_enabled` **mặc định BẬT** (PayOS là đường nạp cọc duy nhất của chủ shop; vẫn cần khoá PayOS thu tiền đã cấu hình — thiếu thì tính năng trả 503). Nên thử MỘT khoản nhỏ qua PayOS thật trước khi mở cho chủ shop; cần dừng thì tắt cờ. Cờ chỉ chặn việc tạo link nạp mới; tắt khi đang có link chờ thì tiền về vẫn được ghi có.
3. Trước khi bật cờ: thử MỘT khoản nhỏ bằng PayOS thật (trả đủ; nếu PayOS cho phép thì thử thêm trả thiếu), ghi kết quả vào `docs/plans/PLAN-0041-cod-deposit-payos.md` §14, rồi mới bật cờ ở màn tham số hệ thống.
4. Setting kèm theo: `wallet.max_topup_amount` (50.000.000 ₫ mỗi lần), `wallet.payos_topup_expire_minutes` (60 phút, khoảng 5–1440).
5. `EF_ADMIN_URL` (bảng trên) phải đúng web quản trị trước khi bật cờ; sai thì trang quay lại của chủ shop sai, còn tiền vẫn được ghi có qua webhook/job.

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

## GHN — PLAN-0043

GHN_BASE_URL, GHN_TOKEN, GHN_SHOP_ID, GHN_WEBHOOK_SECRET; SHIPPING_CARRIER=fake|ghn, mặc định fake cho demo, production chặn fake. Cấu hình riêng staging/production, header webhook x-ghn-secret và che log. Credential trống không chứng minh staging đã chạy; không ghi khoá thật vào source/bằng chứng.

## PLAN-0044 — encoder ảnh
EF_VISUAL_ENCODER_URL/TOKEN/MODEL_VERSION, EF_VISUAL_IMAGE_ORIGINS, EF_VISUAL_CATALOG_BASE_URL, EF_VISUAL_MIN_SIMILARITY, EF_VISUAL_RERANK. Token encoder riêng, không đưa lên FE; profile COMPOSE_PROFILES=visual-search và VISUAL_ENCODER_IMAGE do CD ghi. Giữ OpenAI vision key nếu dùng detect/OCR/rerank; không key vẫn có vector. Xem services/visual-encoder/README.md.

## FITLY Live — PLAN-0045

`EF_LIVEKIT_URL` là URL signaling công khai `wss://...`; `EF_LIVEKIT_API_KEY` và `EF_LIVEKIT_API_SECRET` chỉ đặt ở API/worker, không đưa vào biến NEXT_PUBLIC. Thiếu một trong ba biến: endpoint phát/cấp media token trả503 `LIVE_MEDIA_UNAVAILABLE`, không dựng video giả. `EF_LIVE_MAX_VIEWERS=10`, `EF_LIVE_DURATION_MINUTES=60` là giới hạn demo; rehearsal cố định10phút/2người xem.

LiveKit gửi webhook có chữ ký tới `https://<backend>/api/v1/livestreams/media/webhook`, content-type `application/webhook+json`; webhook dùng cùng cặp API key/secret và xác minh hash raw body. Không dùng GHN_WEBHOOK_SECRET cho media. API/worker cần truy cập được RoomService HTTP(S); browser cần truy cập signaling WebSocket và các cổng WebRTC/TURN của LiveKit.

Self-host: dùng [mẫu cấu hình](../../deploy/livekit.example.yaml), đặt `room.auto_create: false` để token còn hạn không tự tạo lại phòng đã bị force-stop. BE luôn tạo phòng qua RoomService. [LiveKit quy định token revocation chỉ có trên Cloud](https://docs.livekit.io/frontends/reference/tokens-grants/); SDK removeParticipant gửi cutoff rõ ràng cho Cloud, self-host dựa vào xoá phòng + tắt tự tạo + token ngắn120giây. Không tái sử dụng tên phòng của phiên đã kết thúc. Không dùng `devkey/secret` bên ngoài kiểm thử local.

Chạy cả API và worker: worker xử lý presence TTL, reconnect90giây, timeout phát, retry stop, outbox/realtime, thông báo follower và nhắc lịch theo scheduleVersion. Chỉ API không đủ để vận hành live. Xem [runbook kiểm thử](./08_LIVE_RUNBOOK.md).
