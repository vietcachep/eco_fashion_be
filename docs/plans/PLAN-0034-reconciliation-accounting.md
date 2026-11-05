# PLAN-0034 — WP-10: Đối chiếu tiền hằng ngày & báo cáo kế toán

> Status: Ready · Đợt 3 · P0 · Phụ thuộc: WP-01, WP-02, WP-06 · Plan cha: PLAN-0023
> Lỗ hổng: G42, G43, G44 (phần kế toán) · Kịch bản: PAY-16 · OPS-07 · OPS-10 (commission) · nền cho review R1

## 1. Mục tiêu

Mỗi sáng hệ thống tự trả lời: "tiền PayOS ghi nhận có khớp sổ không, có khoản nào lệch, chi trả có khớp lệnh không, sổ sách có cân không" — mọi chỗ lệch thành **việc** của kế toán, có người xử lý và ghi chú. Báo cáo doanh thu/hoa hồng/hoàn đúng và xuất được.

## 2. Thiết kế (đã chốt)

### 2.1 Đối chiếu thanh toán vào
- Job `reconcile-daily` 06:00 giờ VN (khoá advisory) cho ngày D−1:
  1. Mọi payment PayOS có hoạt động trong ngày (tạo/đổi trạng thái/có webhook) ⇒ hỏi PayOS ⇒ so trạng thái + số tiền.
  2. **Nhập sao kê** (bổ sung vì API PayOS không liệt kê toàn bộ giao dịch): `POST /admin/reconciliation/statements` (CSV xuất từ PayOS/ngân hàng: thời gian, số tiền, nội dung, mã tham chiếu) ⇒ khớp theo mã đơn/mã PayOS trong nội dung + số tiền; dòng sao kê không khớp payment nào ⇒ vấn đề `UNMATCHED_INFLOW` (PAY-16).
- Kết quả ⇒ bảng `payment.reconciliation_issues (id, day, kind, ref_type, ref_id, expected, actual, status open|resolved|ignored, note, resolved_by, resolved_at)`; kind: `STATUS_MISMATCH`, `AMOUNT_MISMATCH`, `MISSING_IN_DB`, `UNMATCHED_INFLOW`, `PAYOUT_MISMATCH`, `REFUND_MISMATCH`, `INVARIANT_BROKEN`.

### 2.2 Đối chiếu tiền ra
- Mọi kỳ chi `processing|paid|unknown` và refund gateway `processing|done` có hoạt động D−1 ⇒ `getPayout` ⇒ so trạng thái/số tiền/TK nhận.

### 2.3 Bất biến sổ sách (đơn đã chốt)
- Với mỗi đơn có hoạt động tiền D−1: `Σ thu (paid, trừ mismatch/duplicate) − Σ hoàn order = doanh thu ròng`; dòng SALE/REFUND trong kỳ khớp công thức WP-06; ví COD: `Σ giao dịch ví = balance`. Vi phạm ⇒ `INVARIANT_BROKEN` (kèm chi tiết để debug).

### 2.4 Màn kế toán
- `/payment/reconciliation`: danh sách vấn đề (lọc ngày/loại/trạng thái), chi tiết + liên kết đơn/payment/kỳ, ghi chú, "Đã xử lý"/"Bỏ qua (lý do)"; số đếm dashboard `reconciliationOpen` (khối WP-05); thông báo kế toán khi có vấn đề mới (kênh WP-04).
- Quyền mới `payment.reconciliation.manage` (kế toán, admin).

### 2.5 Báo cáo (G43)
- `daily_sales`: thêm `commission_amount`, `platform_subsidy`, `refund_amount_order` (tách khỏi duplicate/mismatch); doanh thu ròng = doanh thu − hoàn **không trừ đôi** (đơn hoàn đủ vẫn tính doanh thu ngày đặt, hoàn tính ngày hoàn — ghi rõ định nghĩa trong màn).
- `reporting.recompute_days` (45) thay hằng số 14.
- Báo cáo mới `/reporting/commission`: hoa hồng theo ngày/shop, trợ giá sàn, thực chi shop; xuất CSV `commission`, `reconciliation` (khung WP-05).

## 3. Phạm vi file

Sở hữu: `src/modules/payment/reconciliation/**` (mới), `src/modules/reporting/**` (daily_sales, commission report), migration payment + reporting, admin FE `features/payment/components/reconciliation/**`, `features/reporting/**` (commission).
Chạm nhẹ: `payos.service.ts` (hàm hỏi trạng thái nếu thiếu — khoá vùng).

## 4. Migration / setting / quyền

- Bảng `reconciliation_issues`, `reconciliation_statements` (file đã nhập + dòng); cột mới `daily_sales`.
- Setting: `reporting.recompute_days` (45; 7–120). Quyền: `payment.reconciliation.manage`.

## 5. Bước

- [ ] 2.1 (hỏi PayOS + nhập sao kê) + PAY-16 · 2.2 · 2.3 + test bất biến trên dữ liệu mẫu (phải 0 vấn đề sau khi WP-06 xong; nếu có ⇒ là lỗi thật — báo cáo).
- [ ] 2.4 màn + thông báo · 2.5 báo cáo + CSV.
- [ ] Chạy đối chiếu trên dump thật trong môi trường cô lập, đính kèm kết quả vào báo cáo.

## 6. Test

U: từng loại vấn đề (dữ liệu dựng tay), khớp sao kê (trùng số tiền khác ngày, nội dung có/không mã), idempotent khi chạy lại ngày. S: OPS-07, PAY-16. B: kế toán xử lý vấn đề, xuất CSV.

## 7. Review — trọng tâm riêng (cùng R1)

- Định nghĩa doanh thu/hoàn trong báo cáo có khớp `docs/10` §10 và với số kỳ chi?
- Nhập sao kê: file độc (CSV injection, file khổng lồ, mã hoá lạ) có làm hỏng gì không?
- Chạy lại cùng ngày tạo vấn đề trùng?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_
