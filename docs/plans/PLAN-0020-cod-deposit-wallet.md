# PLAN-0020 — Ví đặt cọc COD (thay luật COD của PLAN-0018)

Trạng thái: đã code (2026-10-23). Chủ dự án đổi lại luật COD: **shop chỉ bán được COD khi đã nộp cọc cho sàn**.

## Luật
* Mỗi shop có một ví đặt cọc (`payment.shop_cod_wallets`). **COD chỉ mở khi `balance > 0`**; gian hàng chính chủ của sàn (FITLY Official) được miễn.
* Nộp cọc: shop chuyển khoản cho sàn → gửi yêu cầu (`POST /shop/wallet/deposit-requests`: số tiền + mã giao dịch) → kế toán sàn đối chiếu → `POST /admin/wallet-deposits/:id/approve|reject`. Mỗi shop một yêu cầu chờ duyệt; tối thiểu `wallet.min_deposit` (mặc định 500.000đ).
* Đơn COD giao thành công (`markCodCollected`, cùng transaction): sàn **tự trừ hoa hồng của đơn** (`(total + platformDiscount) × commissionRateSnapshot`) khỏi ví — ghi sổ cái `cod_commission`, unique `(shop, loại, mã đơn)` nên không trừ hai lần.
* Ví về 0 hoặc **âm** ⇒ COD đóng cho đơn MỚI (đơn đang giao không bị huỷ). Số âm là nợ sàn: nộp cọc kế tiếp **cộng đại số** nên bù nợ trước; nạp vừa đúng số nợ (ví = 0) thì COD vẫn đóng.
* Hoàn tiền đơn COD đã thu: ví bị trừ số hoàn khách, cộng lại phần hoa hồng tương ứng (`cod_refund`, khoá theo mã hoàn tiền).
* Sàn chỉnh ví tay có lý do: `POST /admin/shops/:id/wallet/adjust` (`adjust`).

## Hệ quả với PLAN-0018
* **Đơn COD không vào đối soát chi trả**: shop tự cầm tiền mặt từ đơn vị vận chuyển; `OrderQueryApi.settlementOrders` lọc `paymentMethodCode != 'cod'`. Dòng hoàn tiền COD không có dòng bán nên tự bị bỏ qua. PayOS giữ nguyên (sàn thu → đối soát → chi trả).
* Checkout: `OrderService.placeOrder` đọc `codAvailability` trong transaction, shop đóng COD ⇒ 409 `ORDER_COD_NOT_AVAILABLE`. `GET /orders/checkout-summary` trả thêm `shopGroups[].codAvailable` để web khoá lựa chọn COD.
* `PaymentGateway.markCodCollected(orderCode, actor, tx, sale)` nhận thêm số liệu doanh thu; thêm `codAvailability(shopIds, tx?)`.

## Dữ liệu / quyền
* Migration `20261023090000_shop_cod_deposit_wallet`: 3 bảng (`shop_cod_wallets`, `shop_cod_wallet_transactions`, `shop_cod_deposits`), ví cho shop hiện có (số dư 0 ⇒ COD đóng), bật lại 4 mã quyền ví.
* Quyền (83 mã): `shop.wallet.read`, `shop.wallet.deposit_request` (chủ shop), `supplier.wallet.read` (quản lý, kế toán), `supplier.wallet.adjust` (kế toán, admin).
* Setting: `wallet.min_deposit`, `wallet.deposit_instructions` (mặc định có sẵn trong code, không cần seed).

## Giao diện
* Admin (sàn): `/shop/wallets` — khoản nộp cọc chờ duyệt + danh sách ví (lọc ví ≤ 0, chỉnh ví).
* Admin (vendor): `/vendor/wallet` — số dư, COD mở/đóng, lịch sử ví, nộp cọc.
* Web bán hàng: màn đặt hàng khoá COD + giải thích khi có shop chưa đặt cọc.

## Còn mở
* Chưa có thông báo (chuông/mail) cho shop khi ví về ≤ 0 hoặc khi khoản nộp được duyệt/từ chối.
* Chưa có job cảnh báo ví sắp hết; sàn xem ví ≤ 0 qua bộ lọc "COD đang đóng".
