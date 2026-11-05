# 10 — Vòng đời đơn hàng: luật vận hành (bản mục tiêu để go-live)

> Plan điều phối: `docs/plans/PLAN-0023-order-lifecycle-go-live.md`. Danh mục kịch bản test: `docs/11_SCENARIO_CATALOGUE.md`. Vận hành hằng ngày + sự cố: `docs/12_OPERATIONS_RUNBOOK.md`.
> Mỗi luật ghi hiện trạng (khảo sát code 2026-10-27): ✅ đã có · 🔧 có nhưng sai/thiếu · 🆕 chưa có — kèm WP sẽ làm. Phiên làm xong WP **đổi ký hiệu ở đây** trong cùng thay đổi.
> Giá trị mặc định là KHUYẾN NGHỊ đã được chủ dự án uỷ quyền ("làm theo khuyến nghị"); đều là setting `system` (đổi không cần deploy) trừ chỗ ghi "hằng số".
> **Phạm vi (chốt 2026-10-27):** FITLY là dự án demo — chỉ làm **luồng mua bán end-to-end**, test bằng **tiền thật** (PayOS thu tiền khách, PayOS chi tiền shop, hoàn tiền thật, COD + ví cọc). KHÔNG làm pháp lý / thuế / hoá đơn / quyền dữ liệu cá nhân theo luật (PLAN-0035, PLAN-0036: ngoài phạm vi).

---

## 1. Nguyên tắc

1. **Một bước — một bên chịu trách nhiệm — một hạn chót.** Quá hạn thì hệ thống tự chuyển bước (huỷ / chuyển sàn / hoàn tất); không có đơn nào treo vô hạn.
2. **Tiền khách trả online nằm ở sàn** (PayOS) cho tới khi hết thời gian giữ tiền (escrow). **COD: tiền mặt ở shop**, sàn thu hoa hồng qua **ví cọc COD**; ví và tiền chi trả **bù trừ hai chiều**.
3. **Mọi khoản tiền ra** (hoàn khách, chi shop) phải idempotent, có chứng từ (mã giao dịch duy nhất toàn hệ thống), và không bao giờ để người làm tay chi lại khi trạng thái cổng còn "không rõ".
4. **Bằng chứng trước, quyết định sau:** giao hàng cần hãng + mã vận đơn; đổi trả cần minh chứng; phân xử ghi căn cứ; chỉnh tiền ghi lý do + audit.
5. **Việc cần người làm phải tới được người đó:** thông báo trong app (cả web quản trị), email cho việc khẩn, và hàng đợi có số đếm trên dashboard của đúng vai.
6. **Sàn giám sát & phân xử, không làm thay shop** — nhưng có "phanh khẩn cấp": huỷ đơn chưa giao, giữ tiền chi trả, khoá COD của shop/khách.
7. **Hệ thống tự kiểm tiền mỗi ngày** (đối chiếu PayOS + bất biến sổ sách); lệch là việc của kế toán, có hàng đợi riêng.

---

## 2. Thực thể & mã

| Thực thể | Mã | Ghi chú |
|---|---|---|
| Nhóm đơn (đơn cha) | `DHN…` (seed cũ: `GR…`) | Không có trạng thái riêng — FE suy từ đơn con. Tổng tiền là số lúc đặt (🔧 WP-03: hiện thêm "đã huỷ/đã hoàn" theo đơn con). |
| Đơn con (mỗi shop) | `DH…` | Đơn vị xử lý, thanh toán, đối soát. |
| Thanh toán | 1 payment / đơn con | PayOS: 1 link / đơn con (✅) — 1 link cho cả nhóm là giai đoạn 2 (WP-14). |
| Hoàn tiền | `refunds.kind` | `order` · `duplicate_payment` ✅ · `mismatch` ✅ (PLAN-0040 Tầng 1). |
| Đổi trả | `return_requests` | 8 trạng thái — PLAN-0022. |
| Kỳ chi trả | `shop_payouts` + `shop_payout_lines` | SALE / REFUND / (🆕 WP-06) COD_WALLET_TOPUP. |
| Ví cọc COD | `shop_wallets` + giao dịch + yêu cầu nộp cọc | PLAN-0020. |

---

## 3. Hạn chót & tham số (setting)

| Key | Mặc định khuyến nghị | Ý nghĩa | Hiện trạng |
|---|---|---|---|
| `order.vnpay_timeout_minutes` | 30 | Hạn trả tiền PayOS của đơn; **hạn link PayOS = cùng giá trị**; thanh toán lại ⇒ gia hạn cả đơn lẫn link | 🔧 WP-01 (link hằng số 30', retry không gia hạn) |
| `order.payment_grace_minutes` | 10 | Trước khi huỷ đơn quá hạn, hỏi PayOS; khách trả trong ân hạn vẫn được ghi nhận | ✅ WP-01 (setting + job huỷ cộng ân hạn và hỏi PayOS) |
| `order.shop_confirm_hours` 🆕 | 24 | Shop xác nhận đơn (COD hoặc PayOS đã trả). Nhắc khi còn 6h. Quá ⇒ **tự huỷ** "shop không xác nhận" + hoàn tiền + 1 điểm vi phạm | 🆕 WP-03 |
| `order.shop_ship_hours` 🆕 | 48 | Từ `confirmed` tới `shipping` (có mã vận đơn). Nhắc khi còn 12h. Quá ⇒ tự huỷ + hoàn + nhả kho + 1 điểm vi phạm. Shop **gia hạn 1 lần** +48h kèm lý do (hàng đặt trước) | 🆕 WP-03 |
| `order.cancel_request_hours` 🆕 | 24 | Khách yêu cầu huỷ đơn `packing` ⇒ shop chấp nhận/từ chối; quá ⇒ **tự chấp nhận** | 🆕 WP-03 |
| `order.shipping_alert_days` | 10 | Đơn `shipping` quá N ngày ⇒ báo shop + CSKH | ✅ (1 lần, chỉ 90 ngày) |
| `order.shipping_escalate_days` 🆕 | 20 | Quá N ngày vẫn `shipping` ⇒ tạo **ca "nghi thất lạc"** trong hàng đợi CSKH | 🆕 WP-07 |
| `order.auto_complete_days` | 7 | Sau `delivered` N ngày ⇒ `completed` (bỏ qua đơn có đổi trả mở; cron theo giờ VN) | 🔧 WP-03 |
| `return.window_days` | 7 | Hạn tạo đổi trả sau khi giao | ✅ |
| `return.not_received_days` | **7** (nay 3) | Khách báo "chưa nhận hàng" tới khi đơn tự hoàn tất | 🔧 WP-07 |
| `return.shop_respond_hours` / `ship_back_days` / `shop_receive_days` / `escalate_days` | 72 / 7 / 5 / 3 | PLAN-0022 | ✅ |
| `order.cod_max_amount` | 5.000.000 | Trần COD / đơn con | ✅ |
| `cod.new_customer_max_amount` 🆕 | 2.000.000 | Trần COD cho khách chưa có đơn hoàn tất nào | 🆕 WP-08 |
| `cod.new_customer_max_open` 🆕 | 2 | Số đơn COD đang mở tối đa của khách mới | 🆕 WP-08 |
| `cod.bom_limit` / `cod.bom_window_days` / `cod.bom_block_days` 🆕 | 2 / 90 / 90 | Khách bị "từ chối nhận / không liên lạc được" ≥ 2 lần trong 90 ngày ⇒ khoá COD 90 ngày | 🆕 WP-08 |
| `wallet.min_balance_for_cod` | 200.000 | Ví cọc phải ≥ mức này shop mới nhận COD (luôn dương dù cấu hình thế nào; gian hàng chính chủ miễn) | ✅ WP-06 |
| `wallet.low_balance_alert` 🆕 | 300.000 | Báo shop khi ví xuống dưới mức này | 🆕 WP-06 |
| `wallet.auto_topup_from_payout` 🆕 | true | Kỳ chi trả tự trích bù ví về `min_balance_for_cod` trước khi chi | 🆕 WP-06 |
| `payout.auto_enabled` | **false** | Bật sau khi đối chiếu PayOS thật (WP-13). Mặc định `false` cho DB MỚI; DB đang chạy giữ giá trị hiện có — **kiểm tra và tắt tay nếu chưa muốn tự chi** | ✅ WP-02 |
| `payout.schedule` 🆕 | `weekly` (Thứ Hai 02:00) | `daily` \| `weekly` — tuần trong 3 tháng đầu | 🆕 WP-02 |
| `payout.min_amount` | 50.000 | Dưới mức này ⇒ `deferred`, dồn kỳ sau (số dương mang sang cộng vào kỳ kế) | ✅ WP-02 |
| `payout.auto_max_amount` | 20.000.000 | Kỳ lớn hơn ⇒ `awaiting_approval`, chờ kế toán duyệt (`supplier.payout.approve`) trước khi gửi PayOS | ✅ WP-02 |
| `payout.bank_change_hold_hours` | 72 | Giữ chi sau khi shop đổi TK ngân hàng (setting 24–720; kỳ bị giữ ⇒ `held`, tự mở khi hết giữ) | ✅ setting + giữ · 🆕 xác thực mật khẩu/email/khớp tên (WP-02 §2.5) |
| `refund.auto_max_amount` 🆕 | 2.000.000 | Hoàn qua PayOS ≤ mức này ⇒ job tự chi; lớn hơn ⇒ kế toán bấm | ✅ |
| `shop.violation_suspend_points` 🆕 | 10 / 30 ngày | Điểm vi phạm SLA vượt ngưỡng ⇒ quản lý được nhắc xem xét khoá | 🆕 WP-03 |
| `reporting.recompute_days` 🆕 | 45 (nay 14 hằng số) | Số ngày tính lại `daily_sales` mỗi đêm | 🆕 WP-10 |

Mọi setting số đều có `min/max` (cơ chế đã có từ PLAN-0022) — key mới bắt buộc khai `min/max`.

---

## 4. Máy trạng thái đơn con (mục tiêu)

```text
pending ──shop xác nhận──► confirmed ──shop đóng gói──► packing ──shop giao (hãng + mã vận đơn)──► shipping ──shop báo đã giao──► delivered ──khách "Đã nhận hàng" / hết N ngày──► completed
   │ khách huỷ · shop huỷ · sàn huỷ          │ khách huỷ (tức thì)       │ khách YÊU CẦU huỷ (shop duyệt/24h tự chấp nhận)   │ giao thất bại (shop) · sàn huỷ (tranh chấp)
   │ hết hạn trả tiền · quá hạn xác nhận      │ shop/sàn huỷ · quá hạn giao│ shop/sàn huỷ · quá hạn giao                        │ "nghi thất lạc" ⇒ CSKH
   ▼                                         ▼                           ▼                                                    ▼
cancelled ◄────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
delivered/completed/shipping ──đổi trả hết số lượng──► returned (PLAN-0022)
```

| Chuyển | Ai | Điều kiện | Tác dụng | Hiện trạng |
|---|---|---|---|---|
| tạo → pending | Khách | giá/tồn/voucher/shop approved/COD hợp lệ | giữ tồn, chốt voucher, tạo payment (+ link PayOS **sau khi commit**) | 🔧 WP-01 (link trong tx) |
| pending → confirmed | Shop | PayOS phải `paid`; trong `shop_confirm_hours` | trừ kho thật (commit) | ✅ (thiếu hạn — WP-03) |
| confirmed → packing | Shop | — | `packedAt` | ✅ |
| confirmed/packing → shipping | Shop | **bắt buộc `carrier` + `trackingCode`**; trong `shop_ship_hours` | `shippedAt`, báo khách | 🔧 WP-07 (nay tracking tuỳ chọn) |
| shipping → delivered | Shop | có mã vận đơn; **không có** yêu cầu "chưa nhận hàng" đang mở; ảnh bằng chứng tuỳ chọn | COD ⇒ ghi đã thu + ghi sổ ví; báo khách "xác nhận đã nhận" | 🔧 WP-07 |
| delivered → completed | **Khách** ("Đã nhận hàng") hoặc job | không có đổi trả mở | `sold_count`; escrow vẫn tính từ `deliveredAt + return.window_days` | 🔧 WP-03 (nay chỉ job, không kiểm đổi trả mở) |
| pending → cancelled | Khách · Shop (lý do mã) · Sàn · Hệ thống (hết hạn trả / quá hạn xác nhận / shop bị khoá) | — | nhả tồn, nhả voucher, hoàn tiền nếu đã trả, **báo shop** | 🔧 WP-03 (shop không được báo; thiếu SLA) |
| confirmed → cancelled | Khách (tức thì) · Shop · Sàn · Hệ thống (quá hạn giao, shop bị khoá) | — | nhập lại kho, nhả voucher, hoàn tiền | 🔧 WP-03 (khách chưa huỷ được) |
| packing → cancelled | Shop (lý do mã) · Sàn · Khách (qua yêu cầu huỷ) · Hệ thống (quá hạn giao) | — | nhập lại kho, hoàn tiền | 🆕 WP-03 (nay KHÔNG ai huỷ được) |
| shipping → cancelled | Shop ("giao thất bại", có mã vận đơn) · Sàn (tranh chấp, lý do ≥ 10) | không có đổi trả mở | nhập kho nếu hàng đã về (có thể xác nhận SAU), hoàn tiền nếu đã trả; COD ⇒ đếm "bom" cho khách nếu lý do refused/unreachable | 🔧 WP-07/08 |
| * → returned | Hệ thống (đổi trả hết số lượng) | PLAN-0022 | — | ✅ |
| đổi địa chỉ / SĐT nhận | Khách | `pending` hoặc `confirmed` | ghi lịch sử, báo shop | 🆕 WP-03 |

Các cờ trên đơn (🆕 WP-03): `confirmDueAt`, `shipDueAt`, `shipExtendedAt` + lý do, `cancelRequest {requestedAt, reasonCode, note, dueAt, status}`, `cancelReasonCode`, `cancelledBy (customer|shop|platform|system)`.

---

## 5. Thanh toán vào (PayOS)

| Luật | Hiện trạng |
|---|---|
| Tạo link PayOS **sau khi** transaction đặt hàng commit (không gọi HTTP khi đang giữ khoá); lỗi tạo link ⇒ đơn vẫn `pending`, payment `pending` + `last_link_error`, `linkRetryable=true`, khách bấm "Thanh toán lại" | ✅ (`createCheckoutLinks` sau commit, timeout 8s, song song ≤ 3) |
| Webhook xác thực chữ ký, idempotent, khoá payment | ✅ |
| **Đối chiếu chủ động:** job hỏi PayOS cho payment `pending` sắp/quá hạn TRƯỚC khi huỷ đơn; job hằng ngày đối chiếu mọi giao dịch trong ngày | ✅ hỏi PayOS trước khi huỷ đơn quá hạn (`confirmPaymentStatus`, ngoài tx; PayOS lỗi ⇒ để lần sau, huỷ khi quá hạn + ân hạn + 60') · ✅ job poll `payos-reconcile-pending` mỗi 2 phút (link pending sắp hết hạn / > 10 phút; ghi `last_checked_at`, `last_gateway_status`) · 🆕 đối chiếu ngày (WP-10) |
| Trả **thiếu** ⇒ không ghi `paid`; đơn huỷ khi hết hạn và **tự tạo hoàn đúng số đã nhận** (`kind=mismatch`) + báo kế toán | ✅ (cộng dồn `received_amount` theo từng khoản/`reference`; đủ sau cộng dồn ⇒ `paid`) |
| Trả **thừa** ⇒ ghi `paid` + tự tạo hoàn phần thừa (`kind=mismatch`) | ✅ |
| Trả **trùng** ⇒ hoàn khoản trùng (`duplicate_payment`) — kể cả khách trả HAI LẦN trên cùng link (hai `reference`); PayOS gửi lại đúng khoản cũ ⇒ không hoàn | ✅ |
| Trả **muộn sau khi huỷ** ⇒ hoàn đủ | ✅ (thêm tự chi — WP-01) |
| Hoàn qua PayOS ≤ `refund.auto_max_amount` có TK nhận ⇒ **job tự chi**; còn lại ⇒ kế toán (có thông báo một lần lúc tạo yêu cầu) | ✅ (job 5 phút, tác nhân hệ thống) |
| Mô tả chuyển khoản ≤ giới hạn ký tự của PayOS (9 ký tự nếu TK chưa liên kết) | 🔧 WP-01 (kiểm với PayOS) |
| Thứ tự khoá webhook ↔ huỷ quá hạn thống nhất (order → payment) chống deadlock | ✅ (AUD-01) + hạn link = hạn đơn, thanh toán lại gia hạn cả hai (AUD-05) |

## 6. COD

| Luật | Hiện trạng |
|---|---|
| Shop nhận COD khi ví cọc ≥ `wallet.min_balance_for_cod` (gian hàng chính chủ miễn) | ✅ WP-06 |
| Trần COD: `order.cod_max_amount`; khách mới: `cod.new_customer_*`; khách "bom" ≥ ngưỡng ⇒ khoá COD | 🔧/🆕 WP-08 |
| Coi là đã thu khi shop báo `delivered` (có mã vận đơn) ⇒ ví ghi **−hoa hồng + phần voucher sàn chịu** | ✅ WP-06 (hoa hồng trên tiền hàng, cộng voucher sàn) · 🆕 bắt buộc mã vận đơn (WP-07) |
| Khách báo "chưa nhận hàng" với đơn COD đã báo giao ⇒ **đảo ghi thu** (payment về chưa thu, ví được trả lại hoa hồng/voucher), **không chuyển tiền cho khách** | 🆕 WP-07 |
| Giao thất bại COD bắt buộc mã vận đơn + mã lý do; tỉ lệ giao thất bại của shop được đo, vượt ngưỡng ⇒ CSKH kiểm tra (chống né hoa hồng) | 🆕 WP-07 |
| Ví âm/thiếu ⇒ kỳ chi trả PayOS trích bù trước khi chi (`wallet.auto_topup_from_payout`) | 🆕 WP-06 |
| Báo shop khi ví < `wallet.low_balance_alert`, khi COD bị tắt, khi nộp cọc được duyệt/từ chối; báo kế toán khi có yêu cầu nộp cọc | 🆕 WP-04/06 |
| Mã giao dịch nộp cọc (`transferRef`) duy nhất (không phân biệt hoa thường; khoản bị từ chối không chiếm mã) | ✅ WP-06 |

## 7. Ma trận huỷ đơn

| Trạng thái | Khách | Shop | Sàn (CSKH/Admin) | Hệ thống |
|---|---|---|---|---|
| pending | ✅ tức thì | ✅ mã lý do | ✅ | hết hạn trả tiền ✅ · quá `shop_confirm_hours` 🆕 · shop bị khoá 🆕 |
| confirmed | 🆕 tức thì | ✅ mã lý do | ✅ | quá `shop_ship_hours` 🆕 · shop bị khoá 🆕 |
| packing | 🆕 **yêu cầu** (shop duyệt / tự chấp nhận sau 24h) | 🆕 mã lý do (có vi phạm) | 🆕 | quá `shop_ship_hours` 🆕 |
| shipping | ✗ (từ chối nhận ⇒ shop báo giao thất bại) | ✅ "giao thất bại" | ✅ tranh chấp | — (quá `shipping_escalate_days` ⇒ ca CSKH) |
| delivered / completed | ✗ ⇒ đổi trả | ✗ | ✗ ⇒ phân xử đổi trả | — |

Mã lý do huỷ (🆕 WP-03): khách — `changed_mind`, `wrong_address`, `found_cheaper`, `slow_confirm`, `other`; shop — `out_of_stock`, `price_error`, `cannot_contact`, `customer_request`, `other` (out_of_stock/price_error ⇒ điểm vi phạm); hệ thống — `payment_expired`, `shop_confirm_timeout`, `shop_ship_timeout`, `shop_suspended`; sàn — `dispute`, `fraud`, `other`.

## 8. Giao hàng

| Luật | Hiện trạng |
|---|---|
| Hãng vận chuyển chọn từ danh sách (GHN, GHTK, Viettel Post, J&T, SPX, Ahamove, Ninja Van, VNPost, Khác) + mã vận đơn bắt buộc; `trackingUrl` tự sinh theo hãng nếu biết mẫu | 🆕 WP-07 |
| Khách có nút **"Đã nhận hàng"** (⇒ completed sớm) và **"Chưa nhận được hàng"** tới hết `auto_complete_days` | 🆕 WP-03 / 🔧 WP-07 |
| Shop không được báo `delivered` khi có yêu cầu "chưa nhận hàng" đang mở | 🆕 WP-07 |
| Giao thất bại `goodsReturned=false` ⇒ sau đó shop vẫn "xác nhận hàng đã về" để nhập kho | 🆕 WP-07 |
| Thất lạc: quá `shipping_escalate_days` ⇒ ca CSKH: huỷ + hoàn cho khách, ghi nhận shop chịu (khiếu nại hãng là việc của shop) | 🆕 WP-07 |
| Giao thiếu / sai một phần: lý do `missing_item` (không cần gửi trả, bắt buộc minh chứng video mở hộp/ảnh) | 🆕 WP-09 |
| Tích hợp API hãng vận chuyển (tự cập nhật trạng thái, phí ship theo cân nặng) | giai đoạn 2 — WP-15 |

## 9. Đổi trả & hoàn tiền

Theo PLAN-0022 (đã có): shop duyệt / khách gửi trả / shop nhận / sàn phân xử / kế toán chi; SLA tự chuyển bước. Đợt 2 (WP-09): `missing_item`; khách bổ sung/sửa TK nhận hoàn khi còn mở; công khai các hạn `return.*`; xem trước số tiền hoàn; **phí ship**: lỗi người bán (`defective`, `wrong_item`, `not_as_described`, `damaged_shipping`, `missing_item`) ⇒ hoàn cả phí ship gốc + hoàn phí gửi trả (khách khai, trần 50.000 ⇒ shop chịu); lỗi người mua (`changed_mind`, `size_issue`) ⇒ **không hoàn phí ship gốc**, khách tự trả phí gửi trả; `customerName` + `maxRefundAmount` trong response; job chữa yêu cầu `received` mà khoản hoàn đã `done`; trừ `sold_count` khi trả hàng. Đổi hàng (đổi size) = giai đoạn 2.

## 10. Tiền: hoa hồng, voucher, phí ship, giữ tiền, chi trả, nợ

| Luật | Hiện trạng |
|---|---|
| **Gốc tính hoa hồng** = tiền hàng sau voucher của SHOP (= `subtotal − (shopDiscount − shopShippingDiscount)`); voucher sàn không trừ vào gốc; **không tính trên phí ship** | ✅ WP-06 (đơn cũ backfill: voucher `free_shipping` ⇒ phần giảm là phí ship; kỳ đã chi không hồi tố) |
| Voucher shop: shop chịu. Voucher sàn: sàn chịu — shop nhận đủ như khách không dùng voucher sàn (PayOS: cộng vào gross; COD: cộng vào ví) | ✅ WP-06 (hoàn tiền đảo hoa hồng VÀ phần sàn bù theo tỉ lệ) |
| Tỉ lệ hoa hồng chụp lúc đặt đơn | ✅ |
| Escrow: chỉ chi đơn `completed`, đã qua `deliveredAt + return.window_days`, không có đổi trả mở / bị shop từ chối còn hạn khiếu nại | ✅ |
| Lịch chi: `payout.schedule`; tối thiểu `payout.min_amount`; kỳ > `payout.auto_max_amount` cần kế toán duyệt; kiểm số dư PayOS trước khi gửi | ✅ min_amount + duyệt hạn mức · 🆕 lịch tuần (`payout.schedule`) và kiểm số dư PayOS trước khi gửi lô (WP-02 §2.3) |
| Không bao giờ chi khi trạng thái lệnh chi "không rõ"; timeout ⇒ `unknown` ⇒ hỏi `getPayout`/tìm theo `referenceId` trước khi cho đánh dấu tay (`confirmGatewayNotExecuted`); chạy lại sau thất bại chắc chắn ⇒ khoá mới `<mã kỳ>-<lần>` | ✅ WP-02 (job đối chiếu 5 phút + nút `POST /admin/payouts/:id/reconcile`) |
| `providerRef` của kỳ chi duy nhất (UNIQUE một phần, 409 `PAYOUT_PROVIDER_REF_DUPLICATE`) | ✅ WP-02 |
| Giữ tiền chi trả: shop bị khoá, đang đổi TK (`bank_change_hold_hours`), cờ giữ tay của sàn (có lý do) | ✅ shop bị khoá + đổi TK (kỳ `held`, tự mở khi hết lý do, `POST /admin/payouts/:id/release`) · ✅ cờ giữ tay có lý do (`shop_payout_holds`, `POST /admin/payouts/holds`; mở giữ khi còn lý do ⇒ 409 `PAYOUT_STILL_HELD`) · kỳ `deferred` đã cộng sang kỳ sau ⇒ `merged` · kiểm số dư tài khoản chi PayOS TRƯỚC khi gửi (thiếu ⇒ kỳ `pending` + báo kế toán nạp quỹ) |
| Đổi TK ngân hàng: xác thực lại mật khẩu + email cho chủ shop + giữ 72h + kiểm tên chủ TK khớp tên đăng ký (không dấu) | 🔧 WP-02 |
| Nợ (kỳ âm / ví âm): trừ vào kỳ sau; nợ > 0 quá 30 ngày ⇒ tắt COD + báo shop + hàng đợi kế toán; shop đóng cửa phải tất toán | 🔧 WP-06 |
| Sao kê kỳ chi trả cho shop (CSV + trang in: đơn, gross, hoa hồng, hoàn, ví, thực nhận) | 🆕 WP-06 |
| Đối chiếu hằng ngày + bất biến: Σ đã thu PayOS = Σ hoàn + Σ chi shop + Σ hoa hồng + Σ đang giữ (theo ngày chốt) | 🆕 WP-10 |

## 11. Thông báo (sự kiện × người nhận × kênh) — mục tiêu

Kênh: **A** = trong app (web khách: chuông có sẵn; web quản trị: 🆕 hộp thư WP-04) · **E** = email · **D** = số đếm hàng đợi trên dashboard.

| Sự kiện | Khách | Shop | CSKH | Kế toán | Quản lý | Hiện trạng |
|---|---|---|---|---|---|---|
| Đơn mới (COD / PayOS đã trả) | A+E | A+E (gộp theo nhóm) | — (chỉ D) | — | — | 🔧 (staff bị spam mỗi đơn con) |
| Nhắc xác nhận / giao sắp quá hạn | — | A+E | — | — | — | 🆕 |
| Huỷ (mọi nguồn) | A+E | A+E | — | — | — | 🔧 (shop không được báo) |
| Yêu cầu huỷ (packing) | A | A+E | — | — | — | 🆕 |
| Đổi địa chỉ | — | A+E | — | — | — | 🆕 |
| Đổi trạng thái / đã giao | A+E | — | — | — | — | ✅ |
| Đơn giao quá hạn / nghi thất lạc | A | A | A+D | — | — | 🔧 |
| Đổi trả (mọi bước) | A+E | A+E | A+D (khi chuyển sàn) | — | — | 🔧 (thiếu E) |
| Hoàn tiền xong / thất bại / cần tay | A+E (xong) | A (xong) | — | A+E+D (lỗi, cần tay, vượt ngưỡng) | — | 🔧 |
| Tiền lệch / đối chiếu lệch | — | — | — | A+E+D | — | 🆕 |
| Chi trả: tạo kỳ / chờ duyệt / đã chi / thất bại / giữ | — | A+E | — | A+E+D (chờ duyệt, thất bại) | — | 🔧 |
| Đổi TK ngân hàng | — | A+**E** | — | A | — | 🔧 |
| Ví cọc: nộp / duyệt / từ chối / thấp / COD tắt | — | A+E | — | A+D (yêu cầu nộp) | — | 🆕 |
| Điểm vi phạm vượt ngưỡng | — | A+E | — | — | A+D | 🆕 |
| Job / PayOS / outbox lỗi | — | — | — | — | — (kỹ thuật: E/Telegram) | 🆕 WP-05 |

## 12. Quyền theo vai (tóm tắt — chi tiết ở `identity/permission/catalog.ts`)

| Việc | Khách | Chủ shop | NV shop | CSKH | Kế toán | Quản lý | Admin |
|---|---|---|---|---|---|---|---|
| Đặt / huỷ / yêu cầu huỷ / đổi địa chỉ / "đã nhận hàng" | ✅ | | | | | | |
| Xác nhận / đóng gói / giao / đã giao | | ✅ | ✅ (`shop.order.update`) | | | | |
| Huỷ đơn (shop) / giao thất bại / duyệt yêu cầu huỷ | | ✅ | theo cấp (`shop.order.cancel` 🆕) | | | | |
| Đổi trả của shop | | ✅ | đọc; xử lý theo cấp | | | | |
| Tìm đơn toàn sàn, xem dòng thời gian | | | | ✅ | ✅ | ✅ | ✅ |
| Huỷ đơn khi tranh chấp, phân xử, ca thất lạc | | | | ✅ | | | ✅ |
| Hoàn tiền, đối chiếu, xem TK nhận | | | | | ✅ | | ✅ |
| Chi trả: chạy, duyệt, giữ/mở giữ | | | | | ✅ | xem | ✅ |
| Khoá shop / khoá COD shop / khoá COD khách | | | | khoá COD khách | | ✅ | ✅ |
| Setting / hoa hồng / chỉnh ví tay | | | | | | | ✅ |

## 13. Dữ liệu & lưu trữ

- Chứng từ tiền (đơn, thanh toán, hoàn, chi trả, ví, audit tiền): không có job purge — giữ như hiện tại.
- Log / thông báo / email không chứa số TK đầy đủ, mật khẩu, token (đã áp dụng ở PLAN-0022 — kiểm lại ở review chéo R2).

## 14. Ngoài phạm vi go-live (giai đoạn 2)

Huỷ từng dòng hàng · đổi hàng (size/màu) · một QR cho cả nhóm (WP-14) · tích hợp hãng vận chuyển + COD do hãng thu hộ (WP-15) · trả góp · thẻ quà tặng · đa kho · bảo hành · 2FA cho nhân viên sàn · **pháp lý / thuế / hoá đơn / xoá tài khoản theo luật** (dự án demo — PLAN-0035, PLAN-0036).

## PLAN-0043 — bổ sung tuyến hãng, 2026-11-05

Đơn snapshot fulfilmentMode/collectionMode và provider. Carrier: packing → tạo yêu cầu (vẫn packing khi creating/unknown) → có mã thành shipping/chờ lấy → picked bàn giao → delivered. Hãng huỷ trước lấy đưa về packing cho attempt mới; event attempt cũ không thay đơn mới. Đơn cũ/self giữ nguyên luật.

COD hãng thu: delivered chỉ ghi collected; kế toán xác nhận đúng số/mã nhận mới paid. Đối soát vẫn cần completed + hết hạn trả + không tranh chấp/hold. Shop nhận tiền hàng sau voucher shop trừ hoa hồng; phí ship giữ ở sàn để trả hãng. Self COD vẫn trừ ví cọc và không đưa vào payout.

Carrier đổi địa chỉ trước packing bằng địa chỉ lưu có mã: giữ cùng tỉnh và phí; phí thay đổi yêu cầu huỷ/đặt lại. Tạo/huỷ hãng không gọi HTTP trong tx. Mọi đường huỷ/SLA phải tôn trọng barrier attempt chưa rõ; không nhập kho/hoàn tiền trước hãng xác nhận. Chi tiết snapshot/tiền/cổng E2E trong PLAN-0043.
