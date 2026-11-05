# PLAN-0030 — WP-06: Hoa hồng & ví cọc COD đúng

> Status: **BE một phần đã làm (2026-10-27)** — §2.1–2.2 (công thức), 2.3 (ngưỡng + `transferRef`); CHƯA làm cảnh báo/nợ quá hạn, bù trừ ví↔kỳ chi, rút cọc/đóng shop, sao kê, script thiếu hụt, FE · Đợt 2 · P0 · Phụ thuộc: WP-02 (cùng file `shop-payout.service.ts`) · Plan cha: PLAN-0023
> Lỗ hổng: G22 (phần ví), G23–G29 · Kịch bản: COD-02, 03, 04 · STL-01, 16, 19 · WAL-01…08 · SHOP-03 · CK-03

## 1. Mục tiêu

Shop nhận đúng tiền ở cả PayOS lẫn COD: hoa hồng tính trên tiền hàng (không trên phí ship), voucher sàn do sàn chịu trọn vẹn; ví cọc COD và tiền chi trả PayOS bù trừ hai chiều; có hạn mức, cảnh báo, rút cọc, tất toán khi đóng shop.

## 2. Thiết kế (đã chốt — `docs/10` §6, §10)

### 2.1 Tách số liệu giảm giá trên đơn
- Cột mới `orders`: `shop_item_discount`, `shop_shipping_discount`, `platform_item_discount`, `platform_shipping_discount` (đều `numeric(14,0) default 0`), điền lúc `price()` tính phân bổ (vùng WP-08/WP-01 — khoá vùng, chỉ thêm gán cột). Migration backfill đơn cũ: voucher loại freeship ⇒ phần ship; còn lại ⇒ phần hàng (đọc từ dữ liệu promotion đã chụp trên đơn nếu có; không đủ dữ liệu ⇒ coi toàn bộ là phần hàng — ghi rõ trong migration).

### 2.2 Công thức
- `commissionBase = subtotal − (shopDiscount − shopShippingDiscount)` = tiền hàng sau voucher của SHOP, **không** gồm phí ship và **không** cộng/trừ voucher sàn (voucher sàn do sàn chịu: cộng riêng vào gross/`walletDelta` bên dưới). Khớp `order/foundation/commission.ts` (đã kiểm E2E 2026-10-27).
- `commission = round(commissionBase × commissionRateSnapshot / 100)`.
- **PayOS (dòng SALE):** `gross = total + platform_item_discount + platform_shipping_discount`; `net = gross − commission`.
- **COD (ghi ví lúc thu):** `walletDelta = −commission + platform_item_discount + platform_shipping_discount` (có thể dương — sàn nợ shop phần trợ giá).
- **Hoàn tiền:** đảo tỉ lệ theo số hoàn / `total` cho cả hoa hồng và trợ giá (PayOS: dòng REFUND; COD: giao dịch ví) — giữ cơ chế luỹ kế hiện có, chỉ đổi gốc.
- Không hồi tố kỳ đã chi. Script một lần `scripts/ops/cod-voucher-shortfall.ts` xuất CSV khoản shop đã bị thiếu (đơn COD có voucher sàn trước khi sửa) để kế toán bù bằng chỉnh ví tay có lý do.

### 2.3 Ví cọc: ngưỡng, cảnh báo, nợ
- Nhận COD khi `balance ≥ wallet.min_balance_for_cod` (gian hàng chính chủ miễn). Khi số dư cắt ngưỡng xuống: tắt COD đơn mới + thông báo shop (sự kiện `WALLET_COD_DISABLED`); lên lại: `WALLET_COD_ENABLED`.
- `balance < wallet.low_balance_alert` ⇒ thông báo shop ≤ 1 lần/ngày.
- Nợ: kỳ `carried` âm hoặc ví âm kéo dài > 30 ngày ⇒ cờ "nợ quá hạn": tắt COD, hàng đợi kế toán (số đếm dashboard), thông báo shop.
- `transferRef` nộp cọc duy nhất (unique một phần), 409 `WALLET_TRANSFER_REF_DUPLICATE`.

### 2.4 Bù trừ ví ↔ chi trả (G25)
- Khi tạo kỳ PayOS cho shop có `wallet.auto_topup_from_payout = true` và `balance < min_balance_for_cod`: thêm dòng `COD_WALLET_TOPUP` = `min(net, min_balance_for_cod − balance)`; tạo giao dịch ví cộng tương ứng (cùng tx, idempotent theo mã kỳ). `net` trừ đi.
- Kỳ PayOS âm (nợ) KHÔNG lấy từ ví (ví là cọc bảo đảm COD); nợ mang sang như cũ. Ví âm ⇒ được bù từ kỳ dương như trên.

### 2.5 Rút cọc & đóng shop (G29)
- `POST /shop/wallet/withdrawals {amount, note}` (chủ shop): chỉ khi không còn đơn COD mở (chưa `completed`/`cancelled`/`returned` quá hạn đổi trả) và không nợ; số rút ≤ balance (nếu shop vẫn bán COD: ≤ balance − min). Kế toán duyệt ⇒ chi qua PayOS (dùng luồng lệnh chi của WP-02, `referenceId = WD-…`) hoặc tay + mã giao dịch duy nhất.
- Đóng shop = khoá + rút hết cọc + tất toán kỳ (trình tự trong runbook).

### 2.6 Sao kê kỳ chi (STL-19 — chuyển từ PLAN-0035)
- `GET /shop/payouts/:id/statement.csv` (chủ shop) và `GET /admin/payouts/:id/statement.csv` (`supplier.payout.read`) + trang in ở `/vendor/payouts/[id]` và `/shop/payouts/[id]`.
- Cột: mã đơn, ngày giao, tiền hàng, phí ship, giảm của shop, trợ giá sàn, hoa hồng, hoàn, ví COD (`COD_WALLET_TOPUP`), thực nhận; dòng tổng khớp kỳ; UTF-8 BOM, chặn CSV injection (dùng khung xuất WP-05).

## 3. Phạm vi file

Sở hữu: `src/modules/payment/shop-wallet/**`, `shop-payout.service.ts` **phần công thức kỳ** (gross/commission/dòng mới) — sau khi WP-02 xong, `payment.service.ts` vùng `markCodCollected` + ghi ví khi hoàn (khoá vùng), `prisma/schema/payment.prisma` + `order.prisma` (cột giảm giá) + migration, `order.service.ts` vùng gán cột giảm giá trong `price()`/tạo đơn (khoá vùng), `scripts/ops/cod-voucher-shortfall.ts`.
Admin FE: chi tiết kỳ (dòng `COD_WALLET_TOPUP`, cột "trợ giá sàn"), `/shop/wallets` (cờ nợ quá hạn, rút cọc chờ duyệt), `/vendor/wallet` (ngưỡng, cảnh báo, yêu cầu rút), `/vendor/payouts` (dòng mới).

## 4. Migration / setting

- Cột giảm giá trên `orders` + backfill; `shop_payout_lines.kind` thêm `COD_WALLET_TOPUP`; bảng `shop_wallet_withdrawals`; unique `transfer_ref`; cờ nợ (`shop_wallets.overdue_debt_since`).
- Setting: `wallet.min_balance_for_cod` (200.000), `wallet.low_balance_alert` (300.000), `wallet.auto_topup_from_payout` (true), `wallet.debt_overdue_days` (30).

## 5. Bước

- [x] 2.1 cột + backfill · 2.2 công thức PayOS/COD/hoàn + COD-03/04, STL-01, WAL-05 — **chỉ thêm 2 cột** `shop_shipping_discount`, `platform_shipping_discount` (phần giảm item = giảm tổng − phần ship); gốc hoa hồng = `subtotal − (shopDiscount − shopShippingDiscount)` (`order/foundation/commission.ts`, một nguồn cho đối soát + ví). **Chưa chạy `migration:check` trên DB thật / dump.**
- [~] 2.3 — `wallet.min_balance_for_cod` (200.000) + `transferRef` UNIQUE (COD-02, WAL-02, WAL-04 phần tắt COD) ✅. **Còn:** cảnh báo ví thấp/COD tắt/nộp-duyệt (WP-04), `low_balance_alert`, nợ > 30 ngày (WAL-07), CK-03 (FE báo shop nào).
- [ ] 2.4 bù trừ + STL-16 · 2.5 rút cọc/đóng shop + WAL-08, SHOP-03 · 2.6 sao kê + STL-19.
- [ ] Script thiếu hụt lịch sử + chạy trên dữ liệu mẫu, gửi kết quả cho chủ dự án.
- [ ] FE (sau đồng bộ API) + trình duyệt kế toán / chủ shop.

## 6. Test

U: bảng ví dụ số học (có voucher shop, voucher sàn %, freeship sàn, freeship shop, hoàn một phần, hoàn đủ) cho cả PayOS và COD — tổng tiền sàn giữ = 0 sau khi chi hết. S: `--tag WAL`, STL-01, STL-16.

## 7. Review — trọng tâm riêng (cùng R1)

- Bất biến: với mỗi đơn đã chốt, `khách trả + trợ giá sàn = shop thực nhận + hoa hồng + hoàn` (sai số làm tròn ≤ 1đ/dòng).
- Đổi gốc hoa hồng có làm lệch dòng REFUND của đơn đã có SALE theo công thức cũ không (đơn chi trước khi deploy, hoàn sau khi deploy)?
- Trích bù ví có thể chạy hai lần cho một kỳ (chạy lại kỳ, kỳ một shop + toàn sàn)?

## 8. Quyết định phát sinh

* **Lệch plan §2.2:** công thức ghi `commissionBase = subtotal − shop_item_discount + platform_item_discount`; theo ngữ nghĩa `docs/10` §10 ("tiền hàng sau giảm của shop + trợ giá sàn trên tiền hàng" = khách trả + sàn bù) thì **không cộng `platform_item_discount` vào subtotal đã trừ giảm shop**: gốc = `subtotal − shopItemDiscount`. Đã làm theo ngữ nghĩa đó. (Voucher sàn trên hàng vẫn thuộc doanh thu shop — sàn bù — nên không trừ vào gốc.)
* **Chỉ 2 cột mới thay vì 4:** phần giảm trên hàng suy ra = tổng giảm − phần ship, tránh dư thừa dữ liệu.
* **Ví COD ghi `meta`** `{paid, base, commission, platformCredit, rate}` để hoàn tiền đảo theo tỉ lệ `số hoàn / paid`; ví ghi theo công thức cũ (`meta.gross`) vẫn hoàn theo cách cũ.
* **Chưa làm** script `scripts/ops/cod-voucher-shortfall.ts` (khoản shop COD đã thiếu trước khi sửa) — kế toán chưa có số liệu lịch sử để bù.
* **Backfill đơn cũ** (migration): voucher `type='free_shipping'` ⇒ phần giảm là phí ship; không đủ dữ liệu ⇒ coi là giảm trên hàng.

## Phát hiện từ audit E2E (2026-10-27)

- [x] **AUD-16 (G80)** — §2.2 từng ghi sai `commissionBase = subtotal − shop_item_discount + platform_item_discount`. **Code đúng** (`order/foundation/commission.ts`): `subtotal − (shopDiscount − shopShippingDiscount)` — voucher sàn **không** nằm trong gốc hoa hồng mà được cộng riêng vào gross (PayOS) / `walletDelta` (COD). Đã sửa dòng công thức ở §2.2.
- Kiểm bằng E2E: ví COD sau giao (COD-03a/c, WAL-01…03) đạt; ví dụ `subtotal 299.000, voucher sàn 50.000, hoa hồng 6%` ⇒ `walletDelta = −17.940 + 50.000 = +32.060`.
- Chưa làm (đã xác nhận): bù trừ ví ↔ kỳ chi (STL-16 — cần AUD-02 xong trước), rút cọc/đóng shop, sao kê.
