# 11 — Danh mục kịch bản vòng đời đơn (test + UAT)

> Nguồn luật: `docs/10_ORDER_LIFECYCLE.md`. Plan: `docs/plans/PLAN-0023-order-lifecycle-go-live.md`.
> Mỗi kịch bản có **mã cố định** — test tự động đặt tên theo mã (`it('[PAY-07] …')`, kịch bản smoke `scripts/smoke/scenarios/pay-07.mjs`), checklist UAT đánh dấu theo mã.
> **Mức:** U = jest (unit/integration, harness DB giả) · S = smoke HTTP trên backend cô lập (WP-00) · B = trình duyệt theo vai · M = UAT thủ công trên staging/production (tiền thật nhỏ) · R = review đọc code.
> **Hiện trạng:** ✅ đã đúng · 🔧 có nhưng sai/thiếu · 🆕 chưa có. Phiên làm WP cập nhật cột này.
> **Kết quả audit E2E (2026-10-27, backend cô lập + PayOS giả — xem `docs/13_E2E_TEST_REPORT.md`):** hậu tố ở cột HT — `E2E ✔` chạy thật và đạt · `E2E ✘` chạy thật và thấy lỗi/thiếu (chi tiết + mã phát hiện `AUD-xx` ở docs/13) · `E2E ℹ` chỉ có ghi chú quan sát. Không có hậu tố = chưa chạy trong đợt audit này (hoặc đã chạy ở PLAN-0022 smoke nhưng không lưu kết quả máy đọc). Bộ script ở `docs/plans/assets/e2e-audit/`.
> **Vai:** K khách · S chủ shop · NV nhân viên shop · CS CSKH · KT kế toán · QL quản lý · AD admin · HT hệ thống.
> **Kỳ vọng** luôn kiểm 4 mặt: trạng thái · tiền (payment/refund/ví/kỳ chi) · kho (stock/reserved) · thông báo (đúng người, đúng kênh, đúng 1 lần).

## CK — Đặt hàng

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| CK-01 | 1 shop, PayOS | K đặt | nhóm `DHN` + 1 đơn `pending`; giữ tồn; link PayOS; A+E khách, A shop | U S | — | ✅ · E2E ✔ |
| CK-02 | 3 shop, PayOS + voucher sàn % | K đặt | 3 đơn con, 3 link; voucher sàn chia theo tỉ lệ tạm tính, dư dồn đơn cuối; Σ giảm = báo giá | U S | — | ✅ · E2E ✔ |
| CK-03 | 2 shop, 1 shop không đủ ví cọc để COD | K chọn COD | 409 nêu đúng shop; không tạo gì | S | 06 | 🔧 · E2E ✔ |
| CK-04 | Bấm đặt 2 lần | cùng `Idempotency-Key` / không key | 1 nhóm duy nhất | U S | — | ✅ · E2E ✔ |
| CK-05 | Giá đổi giữa lúc xem và lúc đặt | gửi `expectedTotal` cũ | 409 `ORDER_PRICE_CHANGED` + giá mới; không tạo | U S B | 08 | 🆕 · E2E ✔ |
| CK-06 | Hai khách tranh món cuối | đặt đồng thời | 1 thành công, 1 nhận 409; `stock − reserved ≥ 0` | U S | — | ✅ · E2E ✔ |
| CK-07 | Sản phẩm bị chặn / shop bị khoá sau khi vào giỏ | K đặt | 409 rõ dòng nào | S | — | ✅ · E2E ✔ |
| CK-08 | Mua hàng của shop mình | chủ shop đặt | chặn | U | — | ✅ · E2E ✔ |
| CK-09 | Voucher sàn hết lượt đúng lúc đặt | 2 khách dùng lượt cuối | 1 thành công; người kia báo mã hết lượt, không tạo đơn | U | — | ✅ · E2E ✔ |
| CK-10 | Voucher shop + freeship sàn | K đặt | phân bổ đúng; `total = subtotal + ship − giảm` từng đơn con | U | — | ✅ |
| CK-11 | Địa chỉ nhập tay, tỉnh không có trong bảng | K đặt | phí mặc định; cảnh báo nhập phường/xã | U B | 08 | 🔧 |
| CK-12 | COD > `order.cod_max_amount` / đơn con | K chọn COD | chặn kèm số trần | U S | — | ✅ · E2E ✔ |
| CK-13 | Khách mới: COD > 2 triệu hoặc > 2 đơn COD đang mở | K chọn COD | chặn kèm lý do; PayOS vẫn được | U S | 08 | 🆕 · E2E ℹ |
| CK-14 | Khách bị khoá COD do bom | K chọn COD | ẩn COD + lý do + ngày mở lại | U S B | 08 | 🆕 |
| CK-15 | PayOS lỗi/timeout khi tạo link | giả lập PayOS 500 | đơn vẫn tạo `pending`, payment `link_failed`; K bấm "Thanh toán" tạo lại được | U S | 01 | 🔧 · E2E ✔ |
| CK-16 | Tải cao, PayOS chậm 5s | 50 checkout đồng thời | không lỗi timeout hàng loạt; không giữ khoá trong lúc gọi PayOS | S R | 01 | 🔧 · E2E ℹ |
| CK-17 | Số lượng > `cart.max_qty_per_line` lúc đặt | đổi setting sau khi thêm giỏ | chặn | U | 08 | 🔧 |
| CK-18 | Ghi chú/tên chứa HTML `<script>` | K đặt | email hiển thị dạng chữ (escape) | U R | 04 | 🔧 |
| CK-19 | Tài khoản bị khoá đặt hàng | — | 401/403 | U | — | ✅ |

## PAY — Thanh toán vào (PayOS)

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| PAY-01 | Trả đúng | webhook hợp lệ | payment `paid`, đơn vẫn `pending` chờ shop; A shop; A+E khách | U S M | — | ✅ · E2E ✔ |
| PAY-02 | Webhook đến 2 lần | gửi lại | không đổi gì lần 2 | U S | — | ✅ · E2E ✔ |
| PAY-03 | Webhook sai chữ ký | — | từ chối, không ghi gì | U S | — | ✅ · E2E ✔ |
| PAY-04 | Mất webhook, khách không quay lại trang return | khách trả, chặn webhook | job hỏi PayOS trước khi huỷ ⇒ `paid`, không huỷ | U S | 01 | ✅ U (S chờ harness WP-00) · E2E ✔ |
| PAY-05 | Trả trong ân hạn (sau hạn, trước `payment_grace_minutes`) | — | ghi nhận `paid` | U | 01 | ✅ U (ân hạn trong truy vấn huỷ; trả trong ân hạn được ghi nhận qua hỏi PayOS) · E2E ✔ |
| PAY-06 | Trả sau khi đơn đã huỷ | webhook muộn | hoàn đủ, tự chi nếu ≤ `refund.auto_max_amount`; A+E khách; KT thấy trên D | U S | 01 | 🔧 · E2E ✔ |
| PAY-07 | Trả thiếu | amount < total | không `paid`; hết hạn ⇒ huỷ + hoàn đúng số đã nhận (`kind=mismatch`); A+E KT | U S | 01 | 🆕 · E2E ✔ |
| PAY-08 | Trả thừa | amount > total | `paid` + hoàn phần thừa (`mismatch`) | U S | 01 | 🆕 · E2E ✔ |
| PAY-09 | Quét QR trả 2 lần | 2 webhook khác mã | khoản 2 hoàn `duplicate_payment`, đơn không đổi | U S | — | ✅ · E2E ✔ |
| PAY-10 | Thanh toán lại sau khi link hết hạn | K bấm "Thanh toán" | link mới; `paymentExpiresAt` gia hạn bằng hạn link | U S B | 01 | 🔧 · E2E ✔ |
| PAY-11 | Thanh toán lại đơn đã huỷ | — | chặn | U | — | ✅ · E2E ✔ |
| PAY-12 | Webhook đến đúng lúc job huỷ quá hạn | đồng thời | không deadlock; kết quả nhất quán (paid ⇒ không huỷ, hoặc huỷ ⇒ hoàn) | U R | 01 | 🔧 |
| PAY-13 | PayOS sập 30 phút | — | đặt PayOS báo lỗi thân thiện; COD vẫn đặt; sau đó đối soát bắt đơn đã trả | S M | 01 | 🔧 phần hỏi-PayOS-lỗi ⇒ `unknown` ✅ U; phần đối chiếu ngày (WP-10) + smoke 🆕 · E2E ✔ |
| PAY-14 | Mô tả chuyển khoản | TK PayOS chưa liên kết | mô tả ≤ giới hạn PayOS, giao dịch tạo được | M | 01 | 🔧 |
| PAY-15 | Nhóm 3 đơn, khách trả 2/3 | — | đơn thứ 3 huỷ khi hết hạn; 2 đơn kia tiếp tục; voucher sàn chỉ nhả khi đơn cuối huỷ | U S | — | ✅ |
| PAY-16 | Đối chiếu ngày: PayOS có giao dịch mà DB không có | — | vào hàng đợi "lệch" của KT | U S | 10 | 🆕 |

## COD — Thu hộ tiền mặt

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| COD-01 | Đặt COD hợp lệ | — | `pending`, không link; A+E shop | U S | — | ✅ · E2E ✔ |
| COD-02 | Ví shop < `wallet.min_balance_for_cod` | K đặt COD | chặn/ẩn COD cho shop đó | U S | 06 | ✅ U · E2E ✔ |
| COD-03 | Shop báo đã giao (có mã vận đơn) | S | payment `paid`; ví: −hoa hồng (trên tiền hàng) + voucher sàn chịu | U S | 06 07 | ✅ U (số liệu ví) · mã vận đơn bắt buộc 🆕 WP-07 · E2E ✔ |
| COD-04 | COD + voucher sàn 50k, hoa hồng 10% trên 500k hàng + 30k ship | — | ví = −50.000 + 50.000 = 0 | U | 06 | ✅ U · E2E ✔ |
| COD-05 | Khách từ chối nhận | S báo giao thất bại `refused` + mã vận đơn | huỷ; không trừ ví; K +1 bom; nhập kho khi hàng về | U S | 07 08 | 🆕 · E2E ✔ |
| COD-06 | Bom lần 2 trong 90 ngày | — | khoá COD khách 90 ngày; A+E khách | U S | 08 | 🆕 |
| COD-07 | CSKH mở khoá COD cho khách (khiếu nại hợp lệ) | CS | mở, audit có lý do | U B | 08 | 🆕 |
| COD-08 | Shop báo giao, khách báo "chưa nhận" | K `not_received` | **đảo ghi thu** (payment chưa thu, ví được trả lại), KHÔNG chuyển tiền cho khách; shop không báo giao lại được khi yêu cầu mở | U S | 07 | 🆕 · E2E ✔ |
| COD-09 | Tỉ lệ giao thất bại COD của shop > 15%/30 ngày | — | CS nhận việc kiểm tra shop | U | 07 | 🆕 |
| COD-10 | COD `pending` shop không xác nhận 24h | — | tự huỷ, nhả tồn + voucher; A+E khách | U S | 03 | 🆕 |

## FUL — Shop xử lý đơn & hạn chót

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| FUL-01 | Xác nhận đơn PayOS đã trả | S | `confirmed`, trừ kho thật | U S | — | ✅ · E2E ✔ |
| FUL-02 | Xác nhận đơn PayOS chưa trả | S | chặn | U | — | ✅ · E2E ✔ |
| FUL-03 | Còn 6h chưa xác nhận | HT | nhắc shop A+E đúng 1 lần | U S | 03 | 🆕 |
| FUL-04 | Quá `shop_confirm_hours` | HT | huỷ `shop_confirm_timeout`; hoàn nếu đã trả; +1 điểm vi phạm; A+E khách & shop | U S | 03 | 🆕 · E2E ✔ |
| FUL-05 | Đóng gói | S | `packing` | U | — | ✅ · E2E ✔ |
| FUL-06 | Quá `shop_ship_hours` từ lúc xác nhận | HT | huỷ `shop_ship_timeout`; nhập kho; hoàn; +1 điểm | U S | 03 | 🆕 |
| FUL-07 | Gia hạn giao 1 lần +48h có lý do | S | hạn mới; lần 2 bị chặn | U B | 03 | 🆕 |
| FUL-08 | Giao không có mã vận đơn / có | S | thiếu ⇒ 400; đủ ⇒ `shipping`, link theo hãng | U S B | 07 | 🔧 · E2E ✔ |
| FUL-09 | NV có / không có `shop.order.update` | NV | làm được / 403 | U | — | ✅ |
| FUL-10 | Shop bị khoá khi có đơn đang mở | QL khoá | pending/confirmed tự huỷ + hoàn + báo; packing/shipping vào hàng đợi CS; kỳ chi bị giữ | U S | 03 02 | 🆕 · E2E ✔ |
| FUL-11 | Sàn chặn bán sản phẩm khi có đơn đang xử lý | QL | đơn vẫn xử lý được; CS thấy cảnh báo | U | 03 | 🆕 |
| FUL-12 | Điểm vi phạm vượt ngưỡng | HT | QL nhận việc xem xét khoá (A+D) | U | 03 | 🆕 |
| FUL-13 | In phiếu giao hàng | S | đúng người nhận, mã đơn, COD phải thu | B | — | ✅ |
| FUL-14 | Bật SLA lần đầu trên dữ liệu có sẵn | deploy | hạn của đơn cũ tính từ lúc deploy, KHÔNG huỷ hàng loạt | U S | 03 | 🆕 |

## CAN — Huỷ đơn

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| CAN-01 | Khách huỷ `pending` COD | K, mã lý do | huỷ; nhả tồn + voucher; **A+E shop** | U S | 03 | 🔧 · E2E ✔ |
| CAN-02 | Khách huỷ `pending` PayOS đã trả | K | hoàn đủ (tự chi ≤ ngưỡng) | U S | 03 01 | 🔧 · E2E ✔ |
| CAN-03 | Khách huỷ `confirmed` | K | tức thì; nhập lại kho; hoàn | U S B | 03 | 🆕 · E2E ✔ |
| CAN-04 | Khách yêu cầu huỷ `packing` | K → S chấp nhận / từ chối / im lặng 24h | chấp nhận hoặc tự chấp nhận ⇒ huỷ + nhập kho + hoàn; từ chối (lý do) ⇒ tiếp tục, báo khách | U S B | 03 | 🆕 |
| CAN-05 | Khách huỷ `shipping` | K | không cho; hướng dẫn từ chối nhận | U | — | ✅ · E2E ✔ |
| CAN-06 | Shop huỷ `confirmed` lý do `out_of_stock` | S | huỷ + điểm vi phạm + A+E khách | U S | 03 | 🔧 · E2E ✔ |
| CAN-07 | Shop huỷ `packing` | S | huỷ + nhập kho + hoàn + điểm | U S | 03 | 🆕 · E2E ✔ |
| CAN-08 | Sàn huỷ `packing` (tranh chấp) | CS | huỷ + nhập kho + hoàn; A+E khách & shop | U S | 03 | 🆕 · E2E ✔ |
| CAN-09 | Sàn huỷ `shipping` khi có đổi trả mở | CS | 409 `ORDER_HAS_OPEN_RETURN` | U | — | ✅ · E2E ✔ |
| CAN-10 | Huỷ 1 đơn con trong nhóm 3 | — | 2 đơn kia không đổi; nhóm hiển thị "1 đã huỷ"; voucher sàn giữ | U S B | 03 | 🔧 · E2E ✔ |
| CAN-11 | Huỷ đơn cuối của nhóm | — | nhả lượt voucher sàn | U | — | ✅ · E2E ✔ |
| CAN-12 | Shop huỷ đúng lúc chuyển `shipping` | đồng thời | một bên thắng, không vừa huỷ vừa giao | U | 03 | 🔧 |
| CAN-13 | Huỷ đơn `partially_refunded` | — | hoàn phần còn lại (hỏi payment số đã hoàn) | U | 03 | 🔧 |
| CAN-14 | Đổi địa chỉ khi `pending`/`confirmed`; khi `packing` | K | cập nhật + báo shop / chặn | U S B | 03 | 🆕 · E2E ✔ |
| CAN-15 | NV shop không có `shop.order.cancel` | NV | 403 | U | 03 | 🆕 |

## SHP — Giao & nhận hàng

| Mã | Kịch bản | Bước / điều kiện | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|---|
| SHP-01 | Shop báo đã giao | S (có mã vận đơn) | `delivered`; A+E khách kèm nút "Đã nhận hàng" / "Chưa nhận được" | U S B | 07 | 🔧 · E2E ✔ |
| SHP-02 | Khách bấm "Đã nhận hàng" | K | `completed` ngay; escrow vẫn từ `deliveredAt + return.window_days` | U S B | 03 | 🆕 |
| SHP-03 | Khách không làm gì 7 ngày | HT 02:30 giờ VN | `completed` | U | 03 | 🔧 · E2E ✔ |
| SHP-04 | Tới hạn tự hoàn tất nhưng có đổi trả mở | HT | không `completed` | U | 03 | 🔧 · E2E ✔ |
| SHP-05 | Ngày 6 sau giao, khách báo chưa nhận | K | tạo được (`not_received_days`=7) | U S | 07 | 🔧 |
| SHP-06 | Shop báo đã giao khi có "chưa nhận" đang mở | S | 409 | U | 07 | 🆕 |
| SHP-07 | `shipping` 10 ngày | HT | báo S + CS đúng 1 lần | U | — | ✅ · E2E ✔ |
| SHP-08 | `shipping` 20 ngày | HT | ca "nghi thất lạc" ở hàng đợi CS; CS huỷ + hoàn | U S B | 07 | 🆕 · E2E ℹ |
| SHP-09 | Giao thất bại `goodsReturned=false`, 5 ngày sau hàng về | S "hàng đã về" | nhập kho đúng số | U S | 07 | 🆕 · E2E ✔ |
| SHP-10 | Giao thất bại đơn PayOS đã trả | S | hoàn đủ | U S | — | ✅ |
| SHP-11 | Giao thiếu 1 món | K `missing_item` + video mở hộp | không cần gửi trả; S duyệt ⇒ hoàn phần món thiếu | U S B | 09 | 🆕 |
| SHP-12 | Giao sai 1 món | K `wrong_item` | luồng gửi trả món sai (PLAN-0022) | U S | — | ✅ |
| SHP-13 | Một mã vận đơn dùng cho nhiều đơn | S | cảnh báo CS (nghi gian lận) | U | 07 | 🆕 |

## CMP — Hoàn tất & sau hoàn tất

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| CMP-01 | Đánh giá sau `delivered`/`completed`; trước đó | được / chặn | U | — | ✅ · E2E ✔ |
| CMP-02 | Đánh giá quá `review.window_days` (30) | chặn | U | 09 | 🆕 · E2E ✔ |
| CMP-03 | Trả hàng xong | `sold_count` giảm đúng số | U | 09 | 🆕 · E2E ℹ |
| CMP-04 | Shop nhận A khi có đánh giá mới; khách nhận A khi shop trả lời | A đúng người | U | 04 | 🆕 · E2E ✔ |

## RET — Đổi trả (PLAN-0022 + đợt 2)

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| RET-01 | PayOS: tạo → duyệt → gửi trả → nhận → hoàn | `refunded`, nhập kho, refund `done` | U S B | — | ✅ · E2E ✔ |
| RET-02 | COD thiếu TK ⇒ 400; có TK ⇒ tạo, TK che số | | U S B | — | ✅ · E2E ✔ |
| RET-03 | Shop từ chối → khách khiếu nại → CS hoàn | `received` → `refunded` | U S | — | ✅ · E2E ✔ |
| RET-04 | Shop quá hạn duyệt | `escalated (shop_timeout)` | U S | — | ✅ · E2E ✔ |
| RET-05 | Khách quá hạn gửi trả | `expired` | U S | — | ✅ · E2E ✔ |
| RET-06 | Shop quá hạn nhận | `escalated (shop_receive_timeout)` | U S | — | ✅ · E2E ✔ |
| RET-07 | Hàng về không khớp, CS hoàn | không nhập kho | U | — | ✅ |
| RET-08 | Chưa nhận hàng (cả đơn) | hoàn ngay, không nhập kho | U S | — | ✅ · E2E ✔ |
| RET-09 | Shop giảm tiền hoàn có lý do / không lý do | được / 400 | U B | — | ✅ |
| RET-10 | Khách bổ sung/sửa TK nhận hoàn khi yêu cầu còn mở | refund đang mở nhận payee mới | U S B | 09 | 🆕 |
| RET-11 | Phí ship theo lỗi: `changed_mind` vs `defective` | không hoàn ship gốc / hoàn ship gốc + phí gửi trả ≤ 50k | U S | 09 | 🆕 |
| RET-12 | Xem trước số tiền hoàn trước khi gửi | số trên form = số BE tính | U B | 09 | 🆕 |
| RET-13 | Hai yêu cầu một phần trên cùng đơn | Σ hoàn ≤ tổng đơn | U | — | ✅ · E2E ✔ |
| RET-14 | Đổi trả sau khi đơn đã đối soát & chi | dòng REFUND kỳ sau / nợ mang sang | U S | — | ✅ |
| RET-15 | `received` mà refund đã `done` (kẹt do deploy) | job chữa sang `refunded` | U | 09 | 🆕 |
| RET-16 | Trang chính sách hiển thị hạn lấy từ server | khớp setting | B | 09 | 🆕 |

## REF — Hoàn tiền

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| REF-01 | PayOS ≤ ngưỡng, có TK người trả | job tự gửi → `processing` → poll → `done` | U S M | 01 | 🔧 · E2E ✔ |
| REF-02 | > ngưỡng | chờ KT duyệt; A+E+D KT | U S | 01 | 🆕 |
| REF-03 | PayOS từ chối ngay | `failed` + `gatewayStatus=failed`; KT chuyển tay + mã ⇒ `done`, không gọi PayOS lại | U | — | ✅ · E2E ✔ |
| REF-04 | PayOS timeout | `needsReconcile`; chạy lại cùng khoá | U | — | ✅ · E2E ✔ |
| REF-05 | PayOS treo > 30 phút | `needsManual`, báo KT 1 lần | U | — | ✅ · E2E ✔ |
| REF-06 | Mã giao dịch hoàn trùng | 409 | U S B | — | ✅ · E2E ✔ |
| REF-07 | COD không có TK | thủ công, KT liên hệ khách | U S | — | ✅ · E2E ✔ |
| REF-08 | Xem số TK đầy đủ | KT được + audit; CS 403 | U S | — | ✅ · E2E ✔ |
| REF-09 | Payout PayOS chưa cấu hình | thủ công | U | — | ✅ |
| REF-10 | Hoàn vượt số đã thu | chặn | U | — | ✅ |
| REF-11 | Hai KT / job + KT cùng xử lý | một lần | U | — | ✅ |
| REF-12 | Hoàn `mismatch` | không đổi trạng thái đơn, không đảo hoa hồng | U | 01 | 🆕 |

## STL — Đối soát & chi trả cho shop

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| STL-01 | Kỳ tuần, đơn đã qua escrow | SALE: gross = hàng + voucher sàn; hoa hồng KHÔNG gồm ship | U S | 06 | ✅ U (S chờ harness) · E2E ✔ |
| STL-02 | Đơn có đổi trả mở / bị từ chối còn hạn khiếu nại | không vào kỳ | U | — | ✅ · E2E ✔ |
| STL-03 | Hoàn sau khi đã chi | dòng REFUND kỳ sau; âm ⇒ `carried` | U S | — | ✅ · E2E ✔ |
| STL-04 | Kỳ < `payout.min_amount` | dồn kỳ sau | U | 02 | ✅ U · E2E ✔ |
| STL-05 | Kỳ > `payout.auto_max_amount` | `awaiting_approval`; KT duyệt ⇒ gửi PayOS | U S B | 02 | ✅ U (B: màn FE chưa có nút Duyệt) · E2E ✔ |
| STL-06 | Số dư PayOS không đủ | giữ, báo KT | U | 02 | 🆕 · E2E ✔ |
| STL-07 | PayOS nhận lệnh | `processing` → poll → `paid` | U M | — | ✅ · E2E ✔ |
| STL-08 | PayOS timeout | `unknown`; KT KHÔNG đánh dấu tay được tới khi `getPayout` trả kết quả | U | 02 | ✅ U · E2E ✔ |
| STL-09 | PayOS từ chối chắc chắn | `failed`; chạy lại khoá mới `<kỳ>-<n>` | U | 02 | ✅ U · E2E ✔ |
| STL-10 | Đánh dấu tay với `providerRef` trùng | 409 | U | 02 | ✅ U · E2E ✔ |
| STL-11 | Shop đổi TK ngân hàng | cần mật khẩu; email chủ shop; giữ 72h; tên chủ TK lệch ⇒ chặn | U S B | 02 | 🔧 · E2E ✔ |
| STL-12 | Shop bị khoá / mở khoá | kỳ `held` / đi tiếp | U S | 02 | ✅ U (cờ giữ tay STL-13 🆕) · E2E ✔ |
| STL-13 | Sàn giữ tay một shop có lý do | `held` + audit; mở giữ | U B | 02 | 🆕 · E2E ✔ |
| STL-14 | Chạy đối soát cho MỘT shop | chỉ shop đó; không trùng kỳ toàn sàn | U S B | 02 | 🔧 API `shopId` ✅ U; khoá advisory CONC-06 + FE 🆕 · E2E ✔ |
| STL-15 | Chạy lại cùng kỳ | không tạo trùng | U | — | ✅ · E2E ✔ |
| STL-16 | Ví COD −300k, kỳ PayOS 1 triệu | trích bù ví về mức tối thiểu rồi chi phần còn lại; dòng `COD_WALLET` | U S | 06 | 🆕 |
| STL-17 | 100k đơn lịch sử | kỳ chạy < 60s (chỉ đọc đơn chưa có SALE, phân trang) | S | 02 | 🔧 |
| STL-18 | Hai kỳ song song cùng shop | không trừ nợ hai lần | U | 02 | 🔧 |
| STL-19 | Sao kê kỳ cho shop | CSV + trang in khớp dòng kỳ (SALE, REFUND, ví, thực nhận) | U B | 06 | 🆕 |

## WAL — Ví cọc COD

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| WAL-01 | Shop gửi nộp cọc → KT duyệt/từ chối | KT A+D; shop A+E kết quả | U S B | 06 04 | 🔧 · E2E ✔ |
| WAL-02 | `transferRef` trùng | 409 | U | 06 | ✅ U · E2E ✔ |
| WAL-03 | Ví < `low_balance_alert` | báo shop ≤ 1 lần/ngày | U | 06 | 🆕 · E2E ✔ |
| WAL-04 | Ví < `min_balance_for_cod` | COD tắt cho đơn mới; báo shop | U S | 06 | ✅ U (thông báo shop 🆕 WP-04) |
| WAL-05 | Hoàn đơn COD | ví trừ đúng (hoàn − hoa hồng trả lại − voucher sàn trả lại) | U | 06 | ✅ U · E2E ✔ |
| WAL-06 | Admin chỉnh ví tay | lý do bắt buộc, audit | U | — | ✅ |
| WAL-07 | Nợ > 0 quá 30 ngày | tắt COD + hàng đợi KT | U | 06 | 🆕 |
| WAL-08 | Shop nghỉ bán, rút cọc dư | KT duyệt chi trả cọc sau khi hết đơn mở & nợ | U B | 06 | 🆕 |

## SHOP — Sự kiện của gian hàng

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| SHOP-01 | Khoá shop | FUL-10 + STL-12 + sản phẩm ẩn | U S | 03 02 | 🆕 · E2E ✔ |
| SHOP-02 | Mở khoá | bán lại, kỳ chi đi tiếp | U S | 03 02 | 🆕 · E2E ✔ |
| SHOP-03 | Đóng shop hẳn | chỉ khi hết đơn mở, nợ = 0; hoàn cọc dư (WAL-08) | U B | 06 | 🆕 |
| SHOP-04 | Đổi % hoa hồng | không hồi tố | U | — | ✅ |
| SHOP-05 | Gỡ thành viên | mất quyền ngay | U | — | ✅ |

## NTF — Thông báo

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| NTF-01 | Ma trận `docs/10` §11 | mỗi sự kiện tới đúng người, kênh, 1 lần | U S | 04 | 🔧 · E2E ✔ |
| NTF-02 | Chuông web quản trị (shop + nhân viên sàn) | hiện, đánh dấu đã đọc, link mở đúng route | B | 04 | 🆕 |
| NTF-03 | Chống spam | đơn mới gộp theo nhóm; nhắc hạn đúng 1 lần | U | 04 | 🔧 · E2E ✔ |
| NTF-04 | Email chứa nội dung người dùng | escape | U R | 04 | 🔧 |
| NTF-05 | Email cho shop/kế toán | gửi qua nhà cung cấp email giao dịch, có huỷ đăng ký với loại không bắt buộc | M | 04 | 🆕 |

## OPS — Vận hành & sự cố

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| OPS-01 | Worker chết | `/health/worker` đỏ; cảnh báo kỹ thuật ≤ 5 phút | S M | 05 | 🆕 · E2E ℹ |
| OPS-02 | Outbox `FAILED` | màn xem + phát lại | U B | 05 | 🆕 |
| OPS-03 | PayOS sập | = PAY-13 | S M | 01 | 🔧 |
| OPS-04 | Redis sập 5 phút | API báo lỗi rõ; không mất dữ liệu; job hồi phục | M | 05 | 🔧 · E2E ✔ |
| OPS-05 | Khôi phục DB từ bản sao lưu ngày | ≤ 1 giờ, có biên bản diễn tập | M | 05 13 | 🆕 · E2E ✔ |
| OPS-06 | Deploy có migration giờ cao điểm | không lỗi đơn | M | 13 | ✅ (quy ước) |
| OPS-07 | Đối chiếu ngày lệch | hàng đợi KT | U S | 10 | 🆕 |
| OPS-08 | CS tìm đơn toàn sàn theo mã đơn/nhóm/SĐT/email | ra kết quả không cần chọn shop | U B | 05 | 🆕 |
| OPS-09 | Dòng thời gian đầy đủ 1 đơn | lịch sử + audit + payment + refund + đổi trả + thông báo | B | 05 | 🆕 |
| OPS-10 | Xuất CSV đơn/hoàn/chi/ví/hoa hồng | đúng cột, đúng khoảng ngày, mở được bằng Excel (UTF-8 BOM) | U B | 05 10 | 🆕 |
| OPS-11 | Mọi cron theo giờ VN | đúng giờ dù máy chủ UTC | U | 03 05 | 🔧 |
| OPS-12 | Chạy 2 worker | job không chạy trùng (advisory lock) | U S | 05 | 🔧 |

## SEC — Quyền & cô lập

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| SEC-01 | Shop A thao tác đơn/đổi trả shop B | 404 | U S | — | ✅ · E2E ✔ |
| SEC-02 | Khách xem đơn người khác | 404 | U S | — | ✅ · E2E ✔ |
| SEC-03 | CS chi tiền / KT phân xử / QL phân xử | 403 | U S | — | ✅ · E2E ✔ |
| SEC-04 | NV shop huỷ đơn không có quyền | 403 | U | 03 | 🆕 · E2E ✔ |
| SEC-05 | Webhook giả mạo | từ chối | U | — | ✅ |
| SEC-06 | Đổi TK ngân hàng không xác thực lại | 401 | U | 02 | 🆕 |
| SEC-07 | Rate limit đăng nhập / đặt hàng / xem payee | 429 | U S | — | ✅ · E2E ✔ |
| SEC-08 | Dữ liệu nhạy cảm trong log/audit/email/thông báo | không lộ số TK đầy đủ, mật khẩu, token (kiểm ở review chéo R2) | R | — | 🔧 |

## CONC — Đồng thời

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| CONC-01 | Hai khách mua món cuối | = CK-06 | U S | — | ✅ |
| CONC-02 | Webhook vs huỷ quá hạn | = PAY-12 | U | 01 | 🔧 · E2E ✔ |
| CONC-03 | Khách huỷ vs shop xác nhận cùng lúc | một bên thắng | U | 03 | 🔧 · E2E ✔ |
| CONC-04 | Hai KT ghi sổ cùng khoản hoàn | một lần | U | — | ✅ · E2E ✔ |
| CONC-05 | Job tự huỷ (quá hạn giao) vs shop bấm giao | một bên thắng, không vừa huỷ vừa `shipping` | U | 03 | 🆕 |
| CONC-06 | Chạy kỳ toàn sàn và một shop cùng lúc | không trùng | U | 02 | 🆕 · E2E ✔ |

## DATA — Dữ liệu & chuyển đổi

| Mã | Kịch bản | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| DATA-01 | Mọi migration mới: DB trống (`migration:check`) + dump thật | không lệch, dữ liệu cũ chuyển đúng | S | mọi WP | ✅ (quy ước) |
| DATA-02 | = FUL-14 (bật SLA trên dữ liệu cũ) | | U S | 03 | 🆕 |
| DATA-03 | = RET-15 | | U | 09 | 🆕 |
| DATA-04 | Trước khi dùng tiền thật trên máy chủ demo | tài khoản tham gia test (admin, kế toán, CSKH, shop T) đã đổi mật khẩu riêng; shop mẫu khác không có TK ngân hàng ⇒ không ai dùng mật khẩu mẫu công khai để nhận tiền thật | M | 13 | 🆕 |

## E2E — Hành trình end-to-end bằng tiền thật (máy chủ demo — chi tiết `docs/plans/PLAN-0037-uat-go-live.md` §4)

| Mã | Hành trình | Kỳ vọng | Mức | WP | HT |
|---|---|---|---|---|---|
| E2E-01 | Đặt PayOS 10.000đ → trả thật → xác nhận → đóng gói → giao (mã vận đơn) → đã giao → "Đã nhận hàng" → kỳ chi cho shop T → duyệt → PayOS chi thật | đơn `completed`; kỳ `paid`; gross/hoa hồng/thực nhận đúng; tiền vào TK người test | M | 13 | 🆕 |
| E2E-02 | Trả PayOS → khách huỷ đơn `confirmed` → hoàn tự động | refund `done` chỉ sau khi PayOS xác nhận; tiền về TK đã trả; kho nhập lại | M | 13 | 🆕 |
| E2E-03 | Đổi trả lỗi sản phẩm → duyệt → gửi trả → nhận → hoàn PayOS thật | hoàn đúng số; kho nhập lại; dòng REFUND kỳ sau nếu đã chi | M | 13 | 🆕 |
| E2E-04 | Quét QR trả hai lần | khoản 2 hoàn `duplicate_payment`, đơn không đổi | M | 13 | 🆕 |
| E2E-05 | Gỡ webhook tạm thời → trả → gắn lại | job đối chiếu ghi nhận `paid`, không huỷ oan | M | 13 | 🆕 |
| E2E-06 | Trả thiếu (nếu app ngân hàng cho sửa số tiền) | không `paid`; hết hạn ⇒ huỷ + hoàn số đã nhận | M | 13 | 🆕 |
| E2E-07 | Hoàn thất bại thật (TK sai) → kế toán chuyển tay + mã | ghi sổ tay không gọi PayOS lại; mã trùng bị chặn | M | 13 | 🆕 |
| E2E-08 | Nộp cọc thật → duyệt → COD giao xong; COD bị từ chối nhận | ví trừ hoa hồng + cộng trợ giá; đơn từ chối không trừ ví, khách +1 bom | M | 13 | 🆕 |
| E2E-09 | Giữ tiền shop T → kỳ `held` → mở giữ → duyệt kỳ vượt ngưỡng → chi | không lệnh chi khi đang giữ; chỉ chi sau duyệt | M | 13 | 🆕 |
| E2E-10 | Đối chiếu cuối đợt + nhập sao kê PayOS | 0 vấn đề mở; Σ thu = Σ hoàn + Σ chi + Σ hoa hồng + Σ đang giữ | M | 13 | 🆕 |

---

## Cách chạy

- **U:** `npm test` (backend). Test mới đặt tên `[MÃ] …` để tra ngược.
- **S:** sau WP-00: `npm run smoke:env:up` (Docker cô lập + dump + migration) → `npm run smoke -- --tag PAY` hoặc `--id PAY-07` → `npm run smoke:env:down`. Mỗi kịch bản tự chuẩn bị dữ liệu và in PASS/FAIL theo mã.
- **B:** phiên kiểm thử dùng trình duyệt tích hợp trên bản sao FE trỏ vào backend cô lập (cách làm: `docs/plans/PLAN-0024-test-harness.md` §2.5).
- **M:** checklist ở `docs/plans/PLAN-0037-uat-go-live.md`, ghi kết quả + người ký theo vai.

## SHP-D — GHN và hãng giả lập (PLAN-0043, cập nhật 2026-11-05)

> Phạm vi bằng chứng: module shipping, ghép order/payment, adapter GHN và FakeCarrier lưu DB. Nguồn thiết kế: [PLAN-0043](plans/PLAN-0043-ghn-shipping-final.md). Không thay thế các kết quả audit lịch sử phía trên.
> **Kết quả đã có:** `t12-shipping.mjs` chạy HTTP + PostgreSQL audit riêng, FakeCarrier và PayOS mock, **46 kiểm tra đạt**. Đây là 46 assertion trong một số nhánh, **không phải toàn bộ 25 kịch bản SHP-D đã được E2E đầy đủ**. Tạo vận đơn đồng thời mới thử **3 request/đơn**, chưa phải 10.
> Quy ước riêng bảng này: **S đạt phần đã ghi** = thực sự chạy t12; **U đạt phần đã ghi** = unit/contract, kể cả repository giả; **R** = mới đối chiếu code. Mục chưa chạy ghi rõ; không suy từ U/R thành S, B hay M. GHN staging thật, tiền thật và restart/fault injection toàn hệ thống chưa được nghiệm thu trong đợt này.

| Mã | Mục tiêu | Đã kiểm và mức bằng chứng | Phần còn phải kiểm để phủ đầy đủ |
|---|---|---|---|
| SHP-D01 | Checkout hai shop carrier COD | **S đạt phần:** hai pickup khác nhau → phí khác nhau, một nhóm hai đơn `carrier_cod`, tổng nhóm bằng tổng đơn con | Bất biến stock/reserved/voucher đầy đủ riêng tuyến carrier và các ma trận voucher nhiều shop |
| SHP-D02 | PayOS và COD đúng khoản hãng thu | **S đạt phần:** link PayOS mock, webhook ghi paid, vận đơn online `codAmount=0`; **U:** chặn ship khi online chưa paid | Thử chặn unpaid trên HTTP và kiểm carrier COD thu đúng tổng kể cả voucher/freeship trên hãng thật |
| SHP-D03 | Lỗi báo phí và giá đổi | **S đạt phần:** sửa `expectedTotal` lệch 1đ trả 409, không tạo đơn; sửa lại tổng dùng cùng key đặt được; **U:** mã địa chỉ không đúng quan hệ bị chặn trước báo phí | Fault injection quote timeout/5xx → fallback và nhãn; chứng minh rollback stock/voucher/key khi giá đổi bằng đối chiếu DB |
| SHP-D04 | Replay checkout và ownership quote | **S đạt phần:** replay sau giỏ đã xoá giữ cùng nhóm; **U:** lookup quote theo user, sai shop/hash/hết hạn không tái dùng | Replay đồng thời khi quote hết hạn, thử quote của người khác trực tiếp trên HTTP |
| SHP-D05 | Ship đồng thời không trùng kiện | **S đạt phần:** 3 request đồng thời mỗi đơn cùng trả một shipment id; **U:** bấm lại sau thành công không create/callback lần hai | 10 request đồng thời, nhiều worker, đếm cả lần gọi upstream và ràng buộc DB trong trường hợp tranh lease |
| SHP-D06 | Phục hồi create chưa rõ kết quả | **S đạt phần:** chủ động đặt attempt về unknown/mất mã trong DB audit, reconcile nhận lại đúng mã cũ và vẫn một FakeCarrierState; **U:** mất phản hồi sau hãng nhận | Lỗi mạng thật tại ranh giới create, lease hết hạn và restart API/worker trong lúc request đang chạy |
| SHP-D07 | Rollback finalize và race với huỷ/SLA | **U đạt phần:** T2 rollback rồi nhận lại mã cũ, không create kiện thứ hai; kiểm tranh chấp mở giữa preflight và callback huỷ | Rollback bằng DB fault/trigger và create đua cancel/SLA/khoá shop trên PostgreSQL nhiều tiến trình |
| SHP-D08 | Huỷ trước/sau hãng lấy | **S đạt phần:** huỷ trước picked chốt đơn cancelled; sau picked bị 409; **U:** adapter không coi HTTP 200 có result=false là huỷ xong, lý do sai/tranh chấp chặn trước gọi hãng | Cancel timeout/unknown, lỗi từng mã trên GHN staging và race picked ↔ cancel thật |
| SHP-D09 | Hãng tự cancel, tạo attempt mới | **U/R một phần:** mapping cancel và đường callback riêng đã có; không coi huỷ chủ động của t12 là bằng chứng hãng tự huỷ | Toàn chuỗi hãng tự cancel → packing → hạn mới → attempt mới; webhook attempt cũ tới muộn; kiểm không phạt shop |
| SHP-D10 | Mã/nhãn và mốc bàn giao | **S đạt phần:** có mã nhưng vẫn awaiting_pickup/chưa pickedUpAt; phiếu HTML nội bộ chứa đúng mã; picked ghi mốc bàn giao | Nhãn chính thức GHN, lỗi dịch vụ nhãn và bằng chứng staging picked thực tế |
| SHP-D11 | Inbox lặp, đảo thứ tự, tới sớm | **U đạt phần:** ma trận không lùi sau delivered, cho bỏ qua mốc bị mất; có test giữ event returned để xử lý tiếp | Callback lặp/đảo/tới trước T2 trên HTTP+DB, worker chết sau inbox commit, xác minh không mất event/không side-effect đôi |
| SHP-D12 | DB inbox lỗi, secret và track lỗi | **U đạt phần:** adapter phân biệt 503/404 khi tra mã client; **R:** secret header và inbox-retry có trong code | Gọi webhook sai secret, làm DB inbox lỗi kiểm 5xx, track lỗi rồi tự phục hồi trên HTTP; chưa có E2E lỗi hạ tầng cho tuyến mới |
| SHP-D13 | Giao thất bại và hàng trả về | **S đạt phần:** online picked → một delivery_fail → returning → returned, đơn cancelled; **U:** nhánh trạng thái giao lại/hoàn hàng | Ba lần giao thất bại, callback lặp không tăng attempts, chứng minh chỉ restock một lần sau returned bằng DB |
| SHP-D14 | Mất webhook và restart | **R/U một phần:** dữ liệu fake nằm trong DB; các đường phục hồi được kiểm ở SHP-D06 | Tắt/restart API và worker thật, làm mất picked/delivered webhook, chờ poll tự khôi phục; chưa thực hiện restart E2E |
| SHP-D15 | Delivered/returned khi not_received còn mở | **U đạt phần:** huỷ khi tranh chấp bị chặn; returned giữ attempt/event để tiếp tục sau xử lý thay vì bỏ rơi đơn | Trọn HTTP khách báo chưa nhận → hãng trả hàng → shop/CSKH giải quyết → hoàn tất trạng thái/kho/tiền, kiểm escrow trong lúc tranh chấp |
| SHP-D16 | COD hãng giữ và tiền thực về sàn | **S đạt phần:** delivered hiện collected_pending_remittance/chưa paid, không có bút toán ví cọc; xác nhận COD rồi đơn paid/completed | Chủ động chạy kỳ/hoàn trước remittance để kiểm bị chặn trên HTTP; nhận thiếu/thừa tiền và luồng đối chiếu thực tế |
| SHP-D17 | Idempotency chứng từ COD | **S đạt phần:** xác nhận lặp cùng ref giữ số đã ghi, đổi ref sau xác nhận trả 409; COD chưa thu huỷ đóng payment | Confirm đồng thời nhiều kế toán, trùng ref giữa hai đơn, sai amount; kiểm số bút toán thực tế không tăng đôi |
| SHP-D18 | Điều kiện escrow/kỳ chi | **S đạt phần:** đơn carrier COD remitted/completed, lùi deliveredAt quá hạn trong DB audit rồi có dòng SALE | Kỳ trước remittance/trước completed/trước escrow phải loại; carrier có return mở/bank hold phải giữ; chưa chi tiền ngân hàng thật |
| SHP-D19 | Tách phí ship khỏi doanh thu shop | **S đạt phần:** gross của dòng SALE bằng subtotal − shopDiscount, không cộng shippingFee ở hai đơn COD | Ma trận freeship shop/sàn, voucher tiền hàng, số lẻ, chênh phí thực và bất biến tổng tiền toàn chuỗi carrier |
| SHP-D20 | Refund theo collection mode | **S đạt phần:** online returned tạo đúng một yêu cầu hoàn đủ; **U:** hàng rào chi hoàn fake/real và phục hồi chứng từ | Hoàn đến trạng thái done trên carrier, hoàn một phần/nhiều lần trước/sau payout, COD chưa remitted chờ đúng, không đảo ví hoặc restock đôi |
| SHP-D21 | Tương thích self và cờ hãng | **S đạt phần:** tắt carrier ở shop, self COD có ví 0 vẫn bị chặn; **U:** self fallback và không chuyển tuyến ngầm trong prepared pricing | Chạy lại toàn bộ t01–t11 trên dataset legacy riêng; đổi cờ sau khi đơn carrier đã đặt và kiểm nguyên tuyến đến cuối |
| SHP-D22 | Quyền và cô lập shop | **S đạt phần:** shop khác xem shipment trả 404, vendor gọi simulator trả 403; **U:** ownership và guard cấu hình fake | Staff có/không từng quyền, CSKH/kế toán xác nhận COD sai vai, đọc DTO/log không lộ dữ liệu; trình duyệt từng vai/390px cần bằng chứng riêng |
| SHP-D23 | Quote cũ và snapshot thay đổi | **S đạt phần:** quote bị cho hết hạn trong DB được báo lại, đơn không lưu quote id cũ; **U:** địa chỉ/pickup/parcel/return/provider/account/method đổi bị 409 trong prepared, không HTTP trong tx | Đổi địa chỉ đơn đã đặt trên HTTP, cập nhật pickup/parcel đồng thời checkout, xác nhận lại phí đổi và kiểm snapshot lịch sử |
| SHP-D24 | Simulator và ranh giới tiền thật | **S đạt phần:** simulator đi qua FakeCarrierState/inbox để cập nhật picked/delivered/returned; **U:** production chặn fake/simulator, nguồn fake không thu/chi/hoàn/phục hồi qua endpoint tiền thật, chỉ cho mock loopback | Kiểm cấu hình production với server cô lập; restart với nguồn fake cũ và endpoint đổi; không gọi dịch vụ ngân hàng thật để chứng minh guard |
| SHP-D25 | Quá hạn lấy, thất lạc, ngoại lệ | **R:** có inbox system dedup, cảnh báo pickup_overdue/carrier_exception, danh sách vận đơn cần kiểm tra | Lùi thời gian/chạy job thực để kiểm cảnh báo đúng người/đúng một lần, lost/exception/return_fail và thao tác CSKH, không bỏ rơi đơn |

### Bằng chứng và cách đọc kết quả SHP-D

- HTTP/DB: [t12-shipping.mjs](plans/assets/e2e-audit/t12-shipping.mjs), kết quả đợt chạy ghi ở [báo cáo E2E](13_E2E_TEST_REPORT.md). Script dùng hàng rào DB audit localhost:55443/fitly_ghn_audit; không chạy vào DB dev/prod.
- Unit/contract: `src/modules/shipping/{foundation,carrier,shipment}/*.spec.ts`; `src/modules/order/shipping/order-{carrier-integration,shipping-pricing}.spec.ts`; các test hàng rào finance trong module payment. U không chứng minh được unique/deadlock thật hoặc restart tiến trình.
- Chưa có nghiệm thu GHN staging thật, tiền thật, nhãn GHN chính thức hoặc toàn bộ nhóm fault injection/restart mới. Không đánh dấu toàn bộ SHP-D01…25 E2E ✔ chỉ dựa vào 46 assertion của t12.
- Driver t01–t11 cũ hardcode API/DB/mock và tên container khác môi trường t12; có bài stop/start dịch vụ và DROP/CREATE DB khôi phục. Muốn tái chạy phải cấu hình bản harness/dataset legacy cô lập riêng và so baseline, không chạy nguyên driver vào môi trường hiện hành hoặc xem exit 0 là đủ.
