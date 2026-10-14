# docs/design — Use case & Database Workflow (PlantUML)

> **LƯU Ý (2026-10-03):** phần **SePay** trong bộ sơ đồ này (file `11`, `12`, `13`, `14`, `18`, `19`, `20`, `eco_fashion-sepay.dbml`, `erd/07-erd-payment-sepay.puml`) là thiết kế CŨ,
> **chưa từng có trong mã nguồn** (grep `sepay` trong `src/` `prisma/` `scripts/` không ra gì) và đã được thay bằng **PayOS** (PLAN-0015/0017: payment link + webhook thu tiền, "Lệnh chi" hoàn tiền/chi trả shop).
> Bộ sơ đồ cũng dừng ở mô hình **một cửa hàng** — chưa có module `shop`, đơn cha `OrderGroup`, ví quỹ COD, đối soát chi trả shop, ngành hàng thuộc tính động.
> Nguồn sự thật hiện hành: `docs/02_MODULE_MAP.md` (module, luồng, sự kiện), `docs/database/eco_fashion.dbml` (schema thật), `docs/plans/PLAN-0015-*.md` + `PLAN-0017-*.md` (thanh toán), `docs/06_FE_CONTRACT.md` (API).
> Các file ở đây giữ lại làm tài liệu tham khảo lịch sử, KHÔNG dùng để suy ra hành vi hệ thống.

Bộ sơ đồ thiết kế hệ thống FITLY (EcoFashion) dựng từ backend hiện có (`src/modules/**`), bổ sung
phần **thanh toán chuyển khoản qua SePay** và **hoàn tiền bằng mã QR** (kế toán quét, SePay báo tiền ra
→ DB tự cập nhật). Mọi sơ đồ là file `.puml` thuần, vẽ bằng PlantUML; mũi tên là đường thẳng
(`skinparam linetype polyline`, không dùng spline cong).

## Danh mục

| File | Loại | Nội dung |
|---|---|---|
| `usecase/FITLY-usecase.drawio` | Use case (**bản chính thức**) | 10 trang draw.io theo mẫu "một actor – một lược đồ": trang *Xác thực & kế thừa actor* (chỉ quan hệ IS-A: 6 vai → Nhân viên → Người dùng ← Khách hàng → Khách vãng lai; Người dùng → đăng nhập / quên mật khẩu / đổi mật khẩu / đăng xuất) rồi mỗi actor một trang: Khách vãng lai · Khách hàng (đặt hàng «include» thanh toán → COD / VietQR → SePay) · Nhân viên · Bán hàng & CSKH · Nhân viên kho · Kế toán (đối soát SePay, hoàn tiền QR) · Marketing · Quản lý cửa hàng (use case riêng + association thẳng tới use case của 4 vai theo preset `manager`) · Quản trị viên (use case riêng + note toàn quyền). Xem nhanh: `usecase/preview/*.png`. Sinh bởi `usecase/gen_usecase_drawio.py` (sửa `PAGES` rồi chạy lại) |
| `screenflow/FITLY-screenflow.drawio` | Screen Flow (**bản chính thức**) | 2 trang draw.io sơ đồ luồng màn hình: Trang 1 *Storefront Screen Flow* (`fashion_frontend_user`), Trang 2 *Admin Portal Screen Flow* (`fashion_frontend_admin`). Node gốc màu vàng, nhóm Admin màu xanh lá, modal màu tím, external gateway màu hồng, đường nối vuông góc có mũi tên chuẩn xác. Xem nhanh: `screenflow/preview/*.png`. Sinh bởi `screenflow/gen_screenflow_drawio.py`. |
| `10-dbwf-schema-lifecycle.puml` | DB Workflow 1 | Vòng đời cấu trúc DB: sửa `.prisma` → `migration:create` → sửa SQL tay → `migration:check` → CI → compose `migrate` (deploy + sync-permissions) → `seed` → `_prisma_migrations`; luật migration bất biến, không `db push` |
| `11-dbwf-checkout-sepay-payment.puml` | DB Workflow 2 | Đặt hàng: idempotency key → khoá tồn → `order_sequences` → orders/items/histories → gateway giữ kho, dùng mã, tạo payment + QR → outbox → COMMIT → SePay webhook → paid |
| `12-dbwf-sepay-webhook.puml` | DB Workflow 3 | Xử lý webhook SePay idempotent: `sepay_transactions` PK = id SePay; tiền VÀO khớp `DH…` → payments paid; tiền RA khớp `HT…` → refunds done; lệch/không khớp → `SEPAY_UNMATCHED` |
| `13-dbwf-cancel-refund-qr.puml` | DB Workflow 4 | Huỷ đơn đã thanh toán → `refunds` requested (mã `HT…`) → kế toán bổ sung TK, hệ thống dựng `qr_url` VietQR → quét chuyển → SePay báo tiền ra → done; fallback hoàn tay |
| `14-dbwf-return-refund.puml` | DB Workflow 5 | Đổi trả: yêu cầu + ảnh + TK nhận hoàn → duyệt/từ chối → nhập lại kho → `refunds` → QR/SePay → `return_requests.refunded` |
| `15-dbwf-fulfillment-cod-stock.puml` | DB Workflow 6 | Chuyển trạng thái đơn theo `STAFF_TRANSITIONS`: confirmed (yêu cầu paid, trừ kho `SALE`) → packing → shipping → delivered (thu COD) → completed (`sold_count`); job huỷ đơn quá hạn 60 s |
| `16-dbwf-inventory-receipt.puml` | DB Workflow 7 | Phiếu nhập nháp → ghi sổ với `Idempotency-Key` (sống cùng transaction) → `stock += qty` + `stock_movements`; điều chỉnh tồn; sổ kho append-only |
| `17-dbwf-consistency-outbox-idempotency.puml` | DB Workflow 8 | Cơ chế nhất quán: TX + `FOR UPDATE` + audit + outbox ghi cùng TX → relay (`SKIP LOCKED`, backoff mũ, 8 lần) → listener idempotent (`processed_events`); gateway cùng `tx`; ranh giới schema; cache Redis |
| `18-dbwf-jobs-retention.puml` | DB Workflow 9 | Worker theo lịch: cancelExpired 60 s, autoComplete 02:30 UTC, daily_sales 5'/17:05 UTC, purge idempotency/refresh token/login history/AI theo `EF_*_RETENTION_DAYS`, embed bù mỗi giờ |
| `19-dbwf-state-machines.puml` | DB Workflow 10 | Máy trạng thái: `orders.status`, `payments.status` (↔ `orders.payment_status`), `refunds.status`, `sepay_transactions.match_status`, `return_requests.status`, tồn kho stock/reserved |
| `20-seq-sepay-payment-refund.puml` | Sequence | Tuần tự tích hợp SePay: (A) thanh toán VietQR khi đặt hàng, (B) hoàn tiền QR do kế toán quét + webhook tiền ra |
| `eco_fashion-sepay.dbml` | DBML | Toàn bộ 83 bảng (11 schema) + delta SePay đánh dấu `[SEPAY]`, TableGroup theo schema, Ref logic xuyên schema — dán nguyên file vào https://dbdiagram.io (đã kiểm bằng `@dbml/core`) |
| `erd/03…09-erd-*.puml` | ERD (bổ trợ) | Bảng/cột theo schema-per-module, có delta SePay (`sepay_transactions`, `refund_sequences`, cột mới) — để tra cứu tên bảng khi đọc workflow |

Đánh số: `usecase/` use case (draw.io) · `1x` database workflow · `20` sequence · `erd/` bổ trợ.

## Quy ước vẽ (áp dụng cho mọi file)

- **Activity/swimlane** (`|Tên lane|`): lane = nơi dữ liệu được xử lý (Khách · API module · PostgreSQL ·
  Gateway cùng transaction · Worker · SePay/Ngân hàng · Nhân viên). Ô có nền `#EEF6FF` = ranh giới
  transaction (`BEGIN`/`COMMIT`), nền `#FFE5E5` = nhánh lỗi/`ROLLBACK`. Tên bảng in đậm
  `**schema.table**` ở lần xuất hiện đầu tiên.
- **Mọi thay đổi dữ liệu nghiệp vụ** luôn đi kèm 3 dòng kỹ thuật trong cùng TX: `audit_logs`,
  `outbox_events`, (nếu có) `order_status_histories`; gọi module khác chỉ qua Gateway với cùng `tx`.
- **Use case** (draw.io): mỗi actor một trang — actor bên trái, quạt đường thẳng tới use case xếp 2 cột so le
  trong ranh giới hệ thống; «extend»/«include»/use case con ở cột kế bên nối bằng đường thẳng (đứt nét có nhãn);
  actor ngoài bên phải nối vuông góc. Generalization chỉ dùng cho quan hệ IS-A thật (vai → Nhân viên → Người dùng),
  vẽ ở trang *Xác thực*; quyền "làm được việc của vai khác" biểu diễn bằng association thẳng tới use case đó
  (không đa kế thừa actor).
- **State**: một khối `state` cho mỗi cột trạng thái; nhãn cạnh = ai/điều gì kích hoạt + tác động DB.
- Không đường cong: `skinparam linetype polyline` (use case, ERD, state); activity/sequence mặc định
  đã là đường thẳng.

## Kết xuất PNG/SVG

Cần Java ≥ 11 (máy đã có Java 21) và `plantuml.jar` (activity/sequence không cần Graphviz; use case,
state, ERD dùng layout Smetana nếu không cài Graphviz — thêm `!pragma layout smetana` dưới `@startuml`
hoặc truyền `-Playout=smetana`).

```bash
java -jar plantuml.jar -tsvg -Playout=smetana -charset UTF-8 -o out docs/design/*.puml docs/design/erd/*.puml
```

Hoặc Docker (không cần cài gì):

```bash
docker run --rm -v "%cd%/docs/design:/data" plantuml/plantuml -tpng -charset UTF-8 -o /data/out "/data/*.puml" "/data/erd/*.puml"
```

VS Code: extension **PlantUML (jebbs)** → mở file → `Alt+D` xem trước, `Ctrl+Shift+P → PlantUML: Export
Current Diagram`. Ảnh kết xuất để trong `docs/design/out/` (gitignore nếu không muốn commit).

## Delta thiết kế cho SePay (chưa có trong code — cần migration + endpoint)

### Bảng / cột mới (schema `payment`, `order`)

| Bảng | Thay đổi |
|---|---|
| `payment.sepay_transactions` (mới) | `id bigint PK` (= id SePay, chốt idempotent) · `gateway` · `account_number` · `sub_account` · `transfer_type in\|out` · `transfer_amount` · `accumulated` · `content` · `code` · `reference_code` · `transaction_date` · `match_status matched\|unmatched\|amount_mismatch\|ignored` · `matched_type payment\|refund` · `matched_id` · `matched_by` · `raw jsonb` · `received_at` · `processed_at` · `error` |
| `payment.refund_sequences` (mới) | `(day) PK`, `last_no` — cấp mã `HTyymmddNNNN` (FOR UPDATE), cùng khuôn `order.order_sequences` |
| `payment.refunds` | + `code` (unique, `HT…`) · `method = qr_transfer` · `bank_code` · `bank_account_no` · `bank_account_name` · `qr_url` · `sepay_transaction_id` · `transferred_at` |
| `payment.payments` | + `qr_url` · `transfer_content` (`DH…`) · `sepay_transaction_id`; `payment_transactions.type` thêm `sepay_in`, `sepay_out` |
| `order.return_requests` | + `refund_bank_code` · `refund_account_no` · `refund_account_name` (khách nhập khi gửi yêu cầu) |
| `order.orders` | Huỷ bởi khách khi đã thanh toán: body nhận `refundBankCode/AccountNo/AccountName` → chép sang `refunds.bank_*` |
| `payment.payment_methods` | `bank_transfer` bật (SePay), `vnpay` `is_active = false` (giữ code cũ, không dùng) |

Retention: `sepay_transactions`, `refunds`, `payments`, `stock_movements`, `audit_logs` **không bao giờ xoá**.

### Endpoint mới / thay đổi

| Method & path | Quyền | Việc với DB |
|---|---|---|
| `POST /api/v1/payments/sepay/webhook` | `@Public` + header `Authorization: Apikey <EF_SEPAY_API_KEY>` | Workflow 3 — INSERT `sepay_transactions` ON CONFLICT DO NOTHING → khớp `DH…`/`HT…` → TX cập nhật payments/refunds/orders/return_requests + outbox |
| `POST /orders/{code}/cancel` | khách (chủ đơn) | Thêm `refundBankCode/AccountNo/AccountName` bắt buộc khi `payment_status = paid` |
| `POST /orders/{code}/returns` | khách | Thêm 3 trường TK nhận hoàn |
| `PATCH /admin/refunds/{id}/bank-account` | `payment.refund.process` | UPDATE `refunds.bank_*` + audit (khi khách chưa cung cấp / huỷ bởi nhân viên) |
| `GET /admin/refunds/{id}` | `payment.payment.read` | Dựng và lưu `qr_url` = VietQR(`bank_code`, `bank_account_no`, `amount`, addInfo = `HT…`) — màn quản trị hiện QR |
| `POST /admin/refunds/{id}/mark-transferred` | `payment.refund.process` | UPDATE `refunds.status = processing`, `transferred_at`, `processed_by` (tuỳ chọn, trước khi SePay báo) |
| `POST /admin/refunds/{id}/process` (có sẵn) | `payment.refund.process` | Giữ làm **fallback hoàn tay** khi mất webhook: cùng cập nhật như nhánh khớp, `matched_by` = kế toán |
| `GET /admin/sepay/events` · `POST /admin/sepay/events/{id}/match` | `payment.transfer.confirm` | Màn đối soát: danh sách `sepay_transactions` unmatched/amount_mismatch; khớp tay vào payment/refund |

Quy tắc khớp: regex `DH\d{10}` (tiền vào → payment) / `HT\d{10}` (tiền ra → refund) trên `content`;
so `transfer_amount` bằng đúng số tiền; webhook luôn trả 200 sau khi đã ghi `sepay_transactions`
(SePay retry theo id, DB không xử lý hai lần).

### Biến môi trường

```
EF_SEPAY_API_KEY=...                 # so với header Authorization: Apikey ...
EF_BANK_TRANSFER_BANK_CODE=...       # ngân hàng TK shop (VietQR bank id)
EF_BANK_TRANSFER_ACCOUNT_NO=...      # số TK shop — webhook có accountNumber khác → ignored
EF_BANK_TRANSFER_ACCOUNT_NAME=...
EF_PAYMENT_EXPIRE_MINUTES=30         # payment_expires_at cho chuyển khoản (job cancelExpired)
```

## Nguồn đối chiếu trong code

`src/modules/order/foundation/order.constants.ts` (ORDER_STATUS, PAYMENT_STATUS, RETURN_STATUS,
STAFF_TRANSITIONS) · `src/modules/payment/foundation/payment.constants.ts` (PAY_STATUS, REFUND_STATUS,
TX_TYPE) · `src/modules/product/inventory/service/inventory.service.ts` (reserve/release/commit/restock)
· `src/common/outbox/outbox-relay.ts` · `src/common/idempotency/idempotency.service.ts` ·
`src/modules/*/*-worker.module.ts` (lịch job) · `docs/03_DATABASE_RULES.md`.
