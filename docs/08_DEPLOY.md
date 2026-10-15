# 08 — Triển khai production (1 máy chủ Docker + 2 web trên Vercel)

> Kiến trúc: **backend + Postgres + Redis + Caddy (HTTPS)** chạy bằng Docker trên một máy chủ; **web bán hàng** và **web quản trị** (hai repo Next.js) chạy trên **Vercel**.
> Bộ file triển khai nằm ở `deploy/`: `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example`, `deploy.sh`, `server-setup.sh`.
> Đã thử trọn luồng này trên máy dev (build image → migrate → nạp dữ liệu mẫu → đổi mật khẩu → HTTPS qua Caddy → đăng nhập).

## 1. Chuẩn bị

| Cần | Ghi chú |
|---|---|
| Máy chủ Linux (Ubuntu/Debian), ≥ 2 GB RAM, cổng 22/80/443 mở | Postgres/Redis KHÔNG mở cổng ra ngoài |
| **Tên miền cho API**, A record → IP máy chủ (vd `api.fitly.vn`) | `NODE_ENV=production` BẮT BUỘC `EF_PUBLIC_URL` là https (PayOS gọi webhook về) và web Vercel (https) không gọi được API http (mixed content). Chưa có tên miền: dùng `api.<IP>.sslip.io` (vd `api.160.191.242.112.sslip.io`) — trỏ sẵn về IP, Caddy vẫn xin được chứng chỉ |
| Mã nguồn backend trên máy chủ | `git clone` repo backend (hoặc `scp`/`rsync` thư mục `eco_backend`) |

## 2. Trên máy chủ (làm bằng tài khoản của bạn)

```bash
# 1) một lần: cài Docker + git, mở cổng 22/80/443 (đọc script trước khi chạy)
sudo bash deploy/server-setup.sh

# 2) cấu hình
cd deploy
cp .env.production.example .env.production
nano .env.production        # điền SITE_ADDRESS, mật khẩu, EF_JWT_SECRET (openssl rand -hex 32), CORS, SMTP…

# 3) dựng và chạy (migration tự chạy)
./deploy.sh

# 4) (lần đầu, nếu muốn có dữ liệu mẫu như máy gốc) — XOÁ dữ liệu ứng dụng hiện có rồi nạp bản dump trong repo
./deploy.sh --with-demo-data
```

Kiểm tra: `curl -s https://<SITE_ADDRESS>/api/v1/health` → `"status":"UP"`.

- `--with-demo-data` chạy `npm run db:restore -- --yes` rồi `npm run db:secure` **trong container**: admin được đặt mật khẩu = `EF_ADMIN_PASSWORD`, nhân viên sàn mẫu (manager/sales/warehouse/accountant/marketing) được đặt `EF_STAFF_PASSWORD` hoặc bị **khoá** nếu để trống. Lý do: mật khẩu mẫu (`Admin123456!`, `NhanVien123!`…) công khai trong tài liệu — để nguyên trên server ra Internet là ai cũng vào được trang quản trị. Chủ shop mẫu (`techzone@…`/`Vendor123456!`) và khách mẫu giữ nguyên, chỉ thao tác được trong phạm vi shop/đơn của họ; xoá hoặc khoá bằng tay nếu không muốn công khai.
- Cập nhật phiên bản mới: `./deploy.sh --pull`. Xem log: `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api worker`.
- Sao lưu DB: `docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db pg_dump -U ecofashion -Fc ecofashion > backup-$(date +%F).dump` (đặt cron hằng ngày, chép ra ngoài máy chủ).

## 3. Web trên Vercel

| Repo | Biến môi trường (Vercel → Settings → Environment Variables) |
|---|---|
| Web bán hàng (`fashion_frontend_user`) | `NEXT_PUBLIC_API_URL=https://<SITE_ADDRESS>` · `NEXT_PUBLIC_GOOGLE_CLIENT_ID=<Client ID Google>` |
| Web quản trị (`fashion_frontend_admin`) | `BACKEND_URL=https://<SITE_ADDRESS>` (proxy `/api/*` phía server, không cần CORS) · `NEXT_PUBLIC_STOREFRONT_URL=https://<tên miền web bán hàng>` |

- Biến `NEXT_PUBLIC_*` được nhúng lúc **build** — đổi xong phải **Redeploy**.
- Hàm serverless của Vercel giới hạn ~4,5 MB mỗi request: nếu quản trị viên upload ảnh lớn qua proxy bị lỗi, đặt thêm `NEXT_PUBLIC_API_URL=https://<SITE_ADDRESS>` cho web quản trị (gọi thẳng API) và thêm origin quản trị vào `EF_CORS_ORIGINS`.
- Quay lại `deploy/.env.production`: `EF_CORS_ORIGINS` = origin của hai web (https, không dấu `/` cuối, cách nhau dấu phẩy), `EF_STOREFRONT_URL`/`EF_WEB_URL` = web bán hàng. Sửa xong chạy lại `./deploy.sh`.

## 4. Cho MỌI NGƯỜI đăng ký được (phía Google)

Có hai đường đăng ký, mỗi đường một chỗ cấu hình:

### 4.1 Đăng nhập bằng Google (Google Identity Services)

Vào [Google Cloud Console](https://console.cloud.google.com) → chọn đúng project chứa OAuth Client của bạn:

1. **Google Auth Platform → Audience** (trước đây: *APIs & Services → OAuth consent screen*): User type **External**; **Publishing status** hiện là *Testing* ⇒ chỉ tối đa 100 "test user" đã khai báo mới đăng nhập được. Bấm **Publish app** → **In production**. Chỉ xin quyền cơ bản `openid`, `email`, `profile` (đúng như app đang dùng) nên **không cần Google xét duyệt** — đăng nhập mở cho mọi tài khoản Google ngay. Điền đủ tên ứng dụng, email hỗ trợ, email liên hệ nhà phát triển.
2. **Clients → OAuth 2.0 Client ID (Web application) → Authorized JavaScript origins**: thêm **đúng origin** của web bán hàng, vd `https://fitly-shop.vercel.app` (https, không dấu `/` cuối, không đường dẫn) và giữ `http://localhost:3100` cho dev. **Không** dùng ký tự đại diện — mỗi bản preview của Vercel (`xxx-git-branch.vercel.app`) là một origin khác nên Google đăng nhập sẽ không hoạt động trên preview; dùng domain production cố định (tốt nhất gắn tên miền riêng vào Vercel). *Authorized redirect URIs* **không cần** (app dùng luồng id_token qua popup/One Tap).
3. Chờ vài phút (đôi khi tới vài giờ) để Google áp dụng thay đổi.
4. Dùng cùng một Client ID ở hai nơi: Vercel `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (rồi Redeploy) và backend `EF_GOOGLE_CLIENT_ID` trong `deploy/.env.production` (rồi `./deploy.sh`). Backend kiểm chữ ký id_token + audience = `EF_GOOGLE_CLIENT_ID`; lệch Client ID là lỗi đăng nhập.

Lưu ý: Google **không cho** thêm `vercel.app` vào mục *Authorized domains* của màn hình consent (tên miền dùng chung). Chỉ cần khi bạn điền đường dẫn trang chủ/chính sách quyền riêng tư/logo — khi đó dùng tên miền riêng của bạn (logo hoặc link tên miền có thể phải qua bước xác minh thương hiệu của Google, mất vài ngày; để trống thì bỏ qua được).

### 4.2 Đăng ký bằng email + mã OTP (gửi qua Gmail SMTP)

OTP đăng ký, quên mật khẩu và email đơn hàng đi qua SMTP (`EF_MAIL_*`):

1. Tài khoản Gmail dùng để gửi phải bật **Xác minh 2 bước**, rồi tạo **Mật khẩu ứng dụng** (Google Account → Security → 2-Step Verification → App passwords). Dùng mật khẩu ứng dụng 16 ký tự đó cho `EF_MAIL_PASSWORD` (không dùng mật khẩu Gmail).
2. `EF_MAIL_HOST=smtp.gmail.com`, `EF_MAIL_PORT=465`, `EF_MAIL_SECURE=true`, `EF_MAIL_USER=<gmail>`, `EF_MAIL_FROM=FITLY <gmail>` (From phải là chính địa chỉ Gmail).
3. Giới hạn: Gmail cá nhân gửi tối đa ~500 thư/ngày (Workspace ~2.000) — đủ cho demo; nếu nhiều người đăng ký cùng lúc sẽ bị chặn. Khi cần ổn định dùng dịch vụ gửi thư (Brevo, Resend, Amazon SES, Mailgun) với tên miền của bạn + SPF/DKIM, chỉ đổi 5 biến `EF_MAIL_*`.

## 5. Bảo mật tối thiểu (làm ngay)

- **Đổi mật khẩu root nếu đã từng gửi/dán ở nơi khác**, tạo user thường + SSH key, rồi tắt đăng nhập root bằng mật khẩu (`PermitRootLogin no`, `PasswordAuthentication no` trong `/etc/ssh/sshd_config`).
- `deploy/.env.production` chứa mật khẩu/khoá thật: không commit (đã gitignore), `chmod 600`.
- Đã tắt Swagger (`EF_SWAGGER_ENABLED=false`) trên production; bật lại tạm thời chỉ khi cần chạy `api:sync` ở máy dev.
