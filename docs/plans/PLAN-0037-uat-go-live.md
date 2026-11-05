# PLAN-0037 — WP-13: Test end-to-end bằng tiền thật (thu – chi) trên bản demo

> Status: Ready khi mọi WP P0 + review R1–R4 xong · Đợt 4 · P0 · Plan cha: PLAN-0023
> Phạm vi (chốt 2026-10-27): FITLY là **dự án demo**, không buôn bán thật ⇒ KHÔNG làm pháp lý/thuế/hoá đơn; mục tiêu duy nhất là **luồng mua bán end-to-end chạy đúng với tiền thật** (PayOS thu tiền khách, PayOS chi tiền shop, hoàn tiền thật cho khách, COD + ví cọc).
> Lỗ hổng: G33 (lệnh chi PayOS thật), G71 (an toàn tài khoản khi dùng tiền thật) · Kịch bản: nhóm **E2E** + mọi mã mức **M** trong `docs/11` + DATA-04, OPS-05, OPS-06, NTF-05, PAY-14

## 1. Mục tiêu

Chạy trọn vòng đời đơn bằng tiền thật, số tiền nhỏ, trên máy chủ demo; mỗi hành trình có điểm kiểm tra về trạng thái – tiền – kho – thông báo; kết thúc bằng đối chiếu tiền ra 0 vấn đề mở.

## 2. Môi trường & dữ liệu

| Môi trường | Dùng cho |
|---|---|
| Cô lập (máy dev, `npm run smoke:env:up`) | Toàn bộ kịch bản S + B trước khi đụng tiền thật (PayOS giả) |
| **Máy chủ demo hiện tại** (dữ liệu mẫu giữ nguyên — demo cần shop/sản phẩm mẫu) | Hành trình E2E tiền thật §4 + UAT theo vai §5 |

## 3. Chuẩn bị trước khi dùng tiền thật (bắt buộc)

- [ ] **An toàn tài khoản (G71, DATA-04):** mật khẩu mẫu đang công khai trong README ⇒ trước khi bật chi tiền thật: đổi mật khẩu riêng cho **admin, kế toán, CSKH** và cho **shop dùng để test** (gọi là shop T) + nhân viên của shop T; TK ngân hàng nhận chi trả của shop T = TK của chính người test. Các shop mẫu khác: để trống TK ngân hàng (không có TK ⇒ không thể nhận chi trả thật).
- [ ] `.env.production` có đủ `EF_PAYOS_PAYOUT_CLIENT_ID/API_KEY/CHECKSUM_KEY`; webhook PayOS (kênh thu) trỏ `https://<api>/api/v1/payments/payos/webhook`. Đã xoay khoá PayOS từng dán trong chat.
- [ ] Setting cho đợt test (ghi giá trị cũ để trả lại ở §6): `payout.auto_enabled=false`; `refund.auto_max_amount=20000`; `payout.auto_max_amount=5000` (để kỳ chi phải qua bước duyệt); `payout.min_amount=1000`; **tạm** `return.window_days=0` chỉ trong lúc chạy E2E-01 (để kỳ chi chạy được ngay), trả lại 7 ngay sau đó.
- [ ] Cảnh báo kỹ thuật (WP-05) gửi tới người trực; sao lưu DB ngay trước đợt test.
- [ ] Quy ước: đơn test dùng ghi chú `E2E-<mã hành trình>`; mỗi lần chuyển ≤ 10.000đ; tổng dự kiến < 200.000đ; mọi khoản thu/hoàn/chi ghi vào bảng §7.
- [ ] Ngoài đợt test, nếu trang demo mở cho người ngoài: tắt PayOS ở `/payment/methods` (chỉ còn COD) để người lạ không chuyển tiền thật.

## 4. Hành trình E2E tiền thật (mã nhóm `E2E` trong `docs/11`)

Mỗi hành trình: người thực hiện theo vai, ảnh chụp mỗi bước, kiểm 4 mặt (trạng thái · tiền · kho · thông báo).

| Mã | Hành trình | Điểm kiểm tra chính |
|---|---|---|
| E2E-01 | Khách đặt đơn shop T (PayOS 10.000đ) → trả bằng app ngân hàng → shop xác nhận → đóng gói → giao (hãng + mã vận đơn) → đã giao → khách "Đã nhận hàng" → kế toán chạy kỳ chi **cho shop T** → duyệt → PayOS chi thật → `paid` | Webhook ghi nhận ≤ 1 phút; kho trừ lúc xác nhận; kỳ chi: gross / hoa hồng (không tính phí ship) / thực nhận đúng; tiền vào TK người test; chữ ký lệnh chi PayOS hợp lệ (G33) |
| E2E-02 | Khách đặt PayOS → trả → khách huỷ (đơn `confirmed`) → **hoàn tự động** qua PayOS | Refund tự chi (≤ ngưỡng); `processing` → `done` chỉ sau khi PayOS xác nhận; tiền về TK đã trả; kho nhập lại |
| E2E-03 | Đổi trả: đơn đã giao → khách yêu cầu (lỗi sản phẩm) → shop duyệt → khách báo gửi trả → shop nhận đúng → hoàn PayOS thật | Hoàn đúng số (gồm phí ship theo lỗi người bán); kho nhập lại; kỳ chi sau có dòng REFUND nếu đơn đã chi |
| E2E-04 | Quét QR trả **hai lần** cùng một đơn | Khoản thứ hai ⇒ hoàn `duplicate_payment` tự động; đơn không đổi |
| E2E-05 | **Mất webhook:** tạm gỡ webhook URL trên trang PayOS → khách trả → gắn lại | Job đối chiếu (WP-01) ghi nhận `paid` trước khi hạn huỷ; đơn không bị huỷ oan |
| E2E-06 | **Trả thiếu** (nếu app ngân hàng cho sửa số tiền QR; không được thì bỏ qua, ghi chú) | Không `paid`; hết hạn ⇒ huỷ + hoàn đúng số đã nhận (`mismatch`); kế toán được báo |
| E2E-07 | **Hoàn thất bại thật:** khách khai TK sai cho yêu cầu đổi trả đơn COD → PayOS từ chối → kế toán chuyển tay + nhập mã giao dịch | `failed` + `gatewayStatus=failed`; ghi sổ tay KHÔNG gọi PayOS lần nữa; mã giao dịch trùng bị chặn |
| E2E-08 | **COD + ví cọc:** shop T nộp cọc thật (chuyển khoản vào TK sàn) → kế toán duyệt → khách đặt COD → giao → ví trừ hoa hồng + cộng trợ giá voucher sàn; một đơn COD khác khách từ chối nhận | Ví đúng số; đơn từ chối không trừ ví, khách +1 lần "bom" |
| E2E-09 | **Kỳ chi vượt ngưỡng duyệt + giữ tiền:** kế toán giữ shop T → kỳ `held` → mở giữ → duyệt → chi | Không có lệnh chi nào khi đang giữ; chỉ gửi PayOS sau khi duyệt |
| E2E-10 | **Đối chiếu cuối đợt** (WP-10): chạy đối chiếu ngày + nhập sao kê PayOS các ngày test | 0 vấn đề mở; Σ thu = Σ hoàn + Σ chi shop + Σ hoa hồng + Σ đang giữ |

## 5. UAT theo vai (không cần tiền thật — chạy trên máy chủ demo hoặc môi trường cô lập)

| Nhóm | Vai thực hiện | Mã kịch bản |
|---|---|---|
| Đặt & trả tiền | Khách (desktop + điện thoại) | CK-01, CK-02, CK-05, CK-13, CK-15, PAY-10, PAY-14 |
| Xử lý đơn | Chủ shop + nhân viên shop | FUL-01, FUL-03, FUL-04, FUL-06, FUL-07, FUL-08, FUL-13, CAN-04, CAN-06, CAN-15 |
| Giao & nhận | Shop + khách | SHP-01, SHP-02, SHP-05, SHP-06, SHP-09, COD-05, COD-08 |
| Đổi trả | Khách + shop + CSKH | RET-01, RET-02, RET-03, RET-09, RET-10, RET-11, SHP-11 |
| Hoàn tiền & chi trả | Kế toán + chủ shop | REF-02, REF-06, REF-08, STL-05, STL-08 (giả timeout — chỉ ở môi trường cô lập), STL-11, STL-12, STL-14, STL-19 |
| Ví cọc | Chủ shop + kế toán | WAL-01, WAL-03, WAL-04, WAL-08 |
| Vận hành | Admin/kỹ thuật + CSKH | OPS-01 (dừng worker 10'), OPS-02, OPS-05 (diễn tập khôi phục), OPS-06, OPS-08, OPS-09, OPS-10, NTF-02, NTF-05 (email thật tới hộp thư nội bộ) |
| Quyền | Mỗi vai thử 2 việc KHÔNG được làm | SEC-01, SEC-03, SEC-04, SEC-06 |

## 6. Sau đợt test

- [ ] Trả lại setting đã đổi ở §3 (đặc biệt `return.window_days=7`, các ngưỡng chi/hoàn).
- [ ] `payout.auto_enabled` chỉ bật khi 2 kỳ chi tay liên tiếp khớp hoàn toàn (ghi quyết định vào §7).
- [ ] Tắt PayOS nếu trang demo mở cho người ngoài (§3).
- [ ] Cập nhật ký hiệu ✅ cho các mã đã chạy trong `docs/11`; lỗi phát hiện ⇒ mở mục ở plan WP tương ứng.

## 7. Biên bản tiền thật

| Ngày | Hành trình | Đơn / kỳ / refund | Thu | Hoàn | Chi shop | Mã giao dịch | Người làm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
