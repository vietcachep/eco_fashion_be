# PLAN-0022 — Đổi trả & hoàn tiền: đúng vai, đúng trách nhiệm

> Status: Done (2026-10-26) — đã thử trên backend cô lập (Docker, dữ liệu mẫu + migration) bằng smoke HTTP 42/42 và trình duyệt (khách · shop · CSKH · kế toán); `npm run verify` xanh (69 suite / 1906 test); `migration:check` trên DB trống: không lệch. Chờ push + CD. Chưa kiểm với PayOS thật (payout chưa bật).
> Owner: Agent / Developer
> Related Phase: marketplace completion (sau PLAN-0020/0021)
> Related Roadmap: `docs/04_ROADMAP.md`

> Luật ownership: dữ liệu khách lọc theo `user_id` từ JWT; dữ liệu của shop lọc theo `shop_id` lấy từ NGỮ CẢNH PHIÊN (không từ URL/body); nhân viên sàn theo mã `module.resource.action`; vendor theo `shop.*`.

---

## 1. Mục tiêu

Rà soát luồng đổi trả/hoàn tiền cũ cho thấy các lỗ hổng vận hành. Plan này sửa theo NGUYÊN TẮC: **mỗi bước có đúng MỘT bên chịu trách nhiệm, có hạn chót, hết hạn thì hệ thống chuyển bước — không ai âm thầm làm thay ai.**

| # | Lỗ hổng cũ | Cách sửa |
|---|---|---|
| 1 | Duyệt đổi trả = hoàn tiền + nhập kho NGAY, hàng chưa về | Thêm bước **"đã nhận lại hàng"**: chỉ khi shop xác nhận nhận đúng hàng mới nhập kho + yêu cầu hoàn tiền |
| 2 | Nhân viên SÀN duyệt/từ chối mọi yêu cầu, shop không được nói gì | **Shop** duyệt/từ chối/nhận hàng; sàn (CSKH) chỉ **phân xử** khi khiếu nại hoặc shop quá hạn |
| 3 | Hoàn PayOS: payout trả "00" (mới nhận lệnh) bị coi là xong | Refund chỉ `done` khi PayOS báo **thành công thật** (poll `getPayout`); báo lỗi ⇒ `failed` |
| 4 | Giao thất bại / thất lạc / COD bom: đơn kẹt `shipping` mãi | Lối thoát có chủ: shop báo **giao không thành công**; sàn có cảnh báo quá hạn + huỷ khi tranh chấp |
| 5 | Shop không có màn đổi trả, không có SLA, không thông báo | Cổng shop `/shop/returns`; SLA + job tự chuyển bước; thông báo đúng người ở mỗi bước |
| 6 | Dòng trừ kỳ chi trả không cho biết đơn nào | Dòng trừ có **mã đơn** |
| 7 | Hoàn COD không có tài khoản nhận; mã giao dịch tay trùng được; minh chứng nhận URL bất kỳ; không có lý do "chưa nhận hàng"; sửa số tiền hoàn không cần lý do | Xem §6 |

---

## 2. Ai làm gì (RACI)

| Bước | Khách | Shop (owner/staff có quyền) | CSKH sàn | Kế toán sàn | Admin | Hệ thống |
|---|---|---|---|---|---|---|
| Tạo yêu cầu (lý do + minh chứng + TK nhận hoàn nếu COD) | **R** | xem | xem | | xem | |
| Rút yêu cầu khi chưa gửi hàng | **R** | xem | | | | |
| Duyệt / từ chối (có lý do) | | **R** | | | | quá hạn ⇒ chuyển sàn |
| Gửi hàng trả + mã vận đơn | **R** | xem | | | | quá hạn ⇒ `expired` |
| Xác nhận ĐÃ NHẬN LẠI hàng (đúng / không khớp) | | **R** | | | | quá hạn ⇒ chuyển sàn |
| Khiếu nại lên sàn sau khi bị từ chối (trong hạn) | **R** | | | | | |
| Phân xử (hoàn tiền / từ chối lần cuối) | | | **R** | | A | |
| Nhập kho lại hàng đã nhận | | | | | | tự làm khi `received` |
| Chi tiền hoàn (PayOS / chuyển khoản tay, nhập mã GD) | | | | **R** | A | PayOS tự chi khi đủ điều kiện |
| Theo dõi chi hoàn thất bại, chạy lại | | | | **R** | A | tự khôi phục treo |
| Báo giao không thành công / thất lạc / COD bom | | **R** | | | | cảnh báo khi quá hạn |
| Huỷ đơn đang giao khi tranh chấp | | | **R** (cần lý do) | | A | |

R = làm · A = chịu trách nhiệm cuối. Sàn KHÔNG duyệt thay shop trừ khi shop quá hạn / bị khiếu nại.

---

## 3. Máy trạng thái đổi trả (`order.return_requests.status`)

```text
                ┌─────────────── khách rút ──────────────► cancelled
requested ──shop duyệt──► approved ──khách gửi trả──┐
   │  │                     │ quá hạn gửi ⇒ expired │
   │  │ shop từ chối        └─(không cần trả hàng)──┼─► [hoàn tiền ngay, không nhập kho]
   │  ▼                                             ▼
   │ rejected ──khách khiếu nại (≤ N ngày)──► escalated ◄── shop báo "hàng không khớp"
   │                                            │  ▲ quá hạn shop duyệt / nhận hàng
   └── quá hạn shop duyệt ─────────────────────►┘
                                                │ CSKH phân xử
                       ┌─ hoàn tiền ────────────┴──── từ chối lần cuối ─► rejected (closedBy=platform)
                       ▼
approved ──shop nhận đúng hàng──► received (nhập kho + yêu cầu hoàn tiền) ──payment báo xong──► refunded
```

Trạng thái: `requested · approved · received · refunded · rejected · escalated · cancelled · expired`.
- **received** = hàng đã về kho shop VÀ khoản hoàn đã được tạo bên payment (đang chi / chờ chi). `refunded` khi payment báo xong (`markReturnRefunded`).
- Hoàn tiền KHÔNG cần trả hàng (`requireReturn=false`): lý do `not_received` (khách nói chưa nhận hàng) — shop duyệt ⇒ vào thẳng `received` (không nhập kho); đơn còn `shipping`/`delivered` trong hạn `return.not_received_days`.
- Dữ liệu cũ: `approved` (kiểu cũ: đã restock + đã yêu cầu hoàn) ⇒ migration chuyển thành `received`.
- Yêu cầu còn "mở" (chặn đối soát shop): `requested · approved · escalated · received`; kết thúc: `refunded · rejected · cancelled · expired`.

### Hạn chót (đều là setting, `group: 'order'`, `isPublic: false` trừ ghi chú)

| Key | Mặc định | Nghĩa |
|---|---|---|
| `return.window_days` (đã có) | 7 | khách được tạo yêu cầu trong N ngày sau khi giao (public) |
| `return.shop_respond_hours` | 72 | shop duyệt/từ chối; quá ⇒ `escalated` |
| `return.ship_back_days` | 7 | khách gửi trả kể từ khi shop duyệt; quá ⇒ `expired` |
| `return.shop_receive_days` | 5 | shop xác nhận nhận hàng kể từ khi khách báo đã gửi; quá ⇒ `escalated` |
| `return.escalate_days` | 3 | khách khiếu nại sau khi bị từ chối |
| `return.not_received_days` | 3 | "chưa nhận hàng" sau khi đơn báo `delivered` |
| `order.shipping_alert_days` | 10 | đơn `shipping` quá N ngày ⇒ cảnh báo shop + CSKH (1 lần) |

Các cột hạn: `shop_respond_due_at`, `ship_back_due_at`, `shop_receive_due_at`, `escalate_due_at` trên `return_requests` (job quét bằng chỉ mục, không tính lại). Cột `deadlineAt`/`deadlineKind` trong response = hạn của bước đang chờ.

---

## 4. Hợp đồng API (BE ↔ FE)

Mọi body bọc `ApiResponse`; tiền dạng `Money` như hiện tại.

### 4.1 Dữ liệu `ReturnRequestResponse` (bổ sung)

`reasonCode` (`defective|wrong_item|not_as_described|damaged_shipping|size_issue|changed_mind|not_received|other`) · `requireReturn: boolean` · `shopId`, `shopName` · `deadlineAt: string|null`, `deadlineKind: 'shop_respond'|'ship_back'|'shop_receive'|'escalate'|null` · `approvedAt` · `carrier`, `trackingCode`, `shippedBackAt` · `receivedAt`, `receivedCondition: 'ok'|'not_matching'|null`, `receivedNote` · `rejectedBy: 'shop'|'platform'|null`, `rejectReason` · `escalatedAt`, `escalateReason`, `escalateSource: 'customer'|'shop_timeout'|'shop_receive_timeout'|'shop_not_matching'|null` · `resolvedBy`, `resolveNote` · `adjustReason` · `returnAddress: {name, phone, address}|null` (địa chỉ shop để khách gửi trả; chỉ có khi `approved`) · `refundAccount: {bankBin, bankName?, accountNumberMasked, accountName}|null` · `refund: {status, amount}|null` (từ payment) · `canCancel`, `canShipBack`, `canEscalate` (khách) — FE không tự suy.

### 4.2 Khách (`/api/v1/...`, đăng nhập)

| Method | Path | Body | Ghi chú |
|---|---|---|---|
| POST | `/orders/:code/returns` | `reasonCode, reason, detail?, items[{orderItemId, quantity}], evidence[{type,url,name}], refundAccount?{bankBin,accountNumber,accountName}` | COD **bắt buộc** `refundAccount`; PayOS không bắt buộc (dùng TK đã trả). `not_received`: không cần `items` (mặc định cả đơn), `evidence` không bắt buộc. Minh chứng chỉ nhận URL https từ host upload của hệ thống |
| GET | `/returns`, `/returns/:id` | | của chính khách |
| POST | `/returns/:id/ship-back` | `carrier, trackingCode, note?` | chỉ khi `approved` & `requireReturn` |
| POST | `/returns/:id/cancel` | | chỉ khi `requested`/`approved` chưa gửi |
| POST | `/returns/:id/escalate` | `reason` | chỉ khi `rejected` bởi shop & trong `escalate_days` |

### 4.3 Shop (`/api/v1/shop/returns`, ngữ cảnh shop, quyền `shop.return.read` / `shop.return.process`)

| Method | Path | Body |
|---|---|---|
| GET | `/shop/returns?status=&page=&size=` · `/shop/returns/:id` | |
| POST | `/shop/returns/:id/approve` | `refundAmount?, adjustReason?` (khác số tính sẵn ⇒ bắt buộc `adjustReason`; chỉ được ≤ số tính sẵn) |
| POST | `/shop/returns/:id/reject` | `reason` (≥ 10 ký tự), `evidence?` |
| POST | `/shop/returns/:id/receive` | `condition: 'ok'|'not_matching', note, evidence?` — `ok` ⇒ `received`; `not_matching` ⇒ `escalated` |
| POST | `/shop/orders/:code/delivery-failed` | `reasonCode: 'refused'|'unreachable'|'lost'|'other', note, goodsReturned: boolean` — đơn `shipping` ⇒ `cancelled`; `goodsReturned` ⇒ nhập kho lại; đơn đã thu tiền online ⇒ yêu cầu hoàn đủ |

### 4.4 Sàn (`/api/v1/admin/returns`)

| Method | Path | Quyền |
|---|---|---|
| GET | `/admin/returns?status=&shopId=&page=&size=` · `/admin/returns/:id` | `order.return.read` |
| POST | `/admin/returns/:id/resolve` `{decision:'refund'|'reject', note (bắt buộc), refundAmount?}` | `order.return.process` — chỉ khi `escalated` |

`POST /admin/returns/:id/process` (kiểu cũ) **bị xoá**. `refundAmount` do sàn chỉ ≤ tổng đơn − đã hoàn, kèm `note`. Huỷ đơn đang `shipping` khi tranh chấp: `cancelByStaff` mở thêm trạng thái `shipping`, **bắt buộc lý do**.

### 4.5 Đơn hàng

`OrderDetail`/danh sách thêm `refund: {status, amount}|null` (từ `PaymentGateway.refundSummaries`) để hiện "đang hoàn tiền" thay vì "đã thanh toán" — phía khách, shop, sàn.

### 4.6 Thanh toán (kế toán)

Hoàn tiền response thêm: `payee: {bankBin, accountNumberMasked, accountName}|null`, `payeeSource: 'payer'|'customer'|'none'`, `gatewayStatus`, `needsManual: boolean`, `orderCode` (đã có), `returnRequestId`. Màn kế toán biết vì sao một khoản chờ tay. Nhập mã GD tay: `providerRef` duy nhất (409 `REFUND_PROVIDER_REF_DUPLICATE`).
Dòng trừ kỳ chi trả (`ShopPayoutLine`) thêm `orderCode`.

---

## 5. Quyền

| Mã | Ai | Việc |
|---|---|---|
| `shop.return.read` | shop_owner, shop_staff (preset) | xem đổi trả của shop mình |
| `shop.return.process` | shop_owner; staff chỉ khi chủ cấp (thêm vào `SHOP_ASSIGNABLE_PERMISSIONS`) | duyệt / từ chối / xác nhận nhận hàng / báo giao thất bại |
| `order.return.read` | sàn: admin, manager, sales(CSKH), accountant | xem |
| `order.return.process` | admin, **sales (CSKH)** | CHỈ phân xử `escalated` |
| `payment.refund.process` | admin, accountant | chi hoàn |

Migration quyền theo mẫu `20261024100000_tighten_platform_permissions` (chạy `perms:sync` khi deploy).

---

## 6. Sửa nhỏ

1. **Minh chứng**: URL phải `https` và thuộc host upload (Cloudinary/`/static` của hệ thống); loại `image|video`; tối đa 8 tệp.
2. **Tài khoản nhận hoàn**: khách khai `bankBin` (6 số, Napas) + số TK (6–19 số) + tên chủ TK (không dấu, in hoa — chuẩn hoá giúp); lưu trên `return_requests` (cột `refund_account` JSON) và `refunds` (`payee_*`); response chỉ lộ 4 số cuối.
3. **Số tiền hoàn sửa tay** phải có `adjustReason` (shop: chỉ giảm; sàn: ≤ tổng đơn − đã hoàn, có `note`); ghi audit.
4. **Mã giao dịch hoàn tay (`providerRef`)** không trùng (unique một phần trên `payment.refunds(provider_ref)` khi khác NULL).
5. **Lý do "chưa nhận hàng"** (`not_received`) — xem §3.
6. **Trang chính sách** của web bán hàng nêu đúng: thời hạn, ai duyệt, hàng phải về trước khi hoàn, hạn từng bước, cách khiếu nại.

---

## 7. Thông báo (cổng `NOTIFICATION_GATEWAY`, người nhận lấy bằng `ShopQueryApi.activeMemberUserIds` / `USER_DIRECTORY_GATEWAY.staffUserIdsWithPermission`)

| Sự kiện | Gửi cho |
|---|---|
| Khách tạo yêu cầu | **shop** (quyền `shop.return.process`); KHÔNG gửi CSKH nữa |
| Còn 24h hết hạn shop duyệt (1 lần) | shop |
| Shop duyệt (kèm địa chỉ gửi trả) / từ chối | khách |
| Khách báo đã gửi trả | shop |
| Shop nhận hàng đúng | khách ("đang hoàn tiền") |
| Chuyển sàn (khiếu nại / quá hạn / không khớp) | CSKH + shop + khách |
| Sàn phân xử | khách + shop |
| Hết hạn gửi trả (`expired`) | khách + shop |
| Hoàn tiền xong / thất bại | khách (xong) · **kế toán** (thất bại / cần nhập tay) · shop (xong) |
| Đơn `shipping` quá hạn | shop + CSKH |
| Giao không thành công | khách + CSKH |

---

## 8. Phân công kỹ thuật (tránh đụng file)

| Agent | Sở hữu | Không được đụng |
|---|---|---|
| **BE-Order** | `src/modules/order/**`, `prisma/schema/order.prisma` + migration order, `identity/permission/catalog.ts` + migration quyền, `system` (setting keys + defaults), `modules/shop` chỉ phần địa chỉ trả hàng/`SHOP_ASSIGNABLE_PERMISSIONS`, `scripts/seed/**` nếu cần, `docs/06_FE_CONTRACT.md` mục đổi trả | `src/modules/payment/**` |
| **BE-Payment** | `src/modules/payment/**`, `prisma/schema/payment.prisma` + migration payment, `src/common/gateway/payment.gateway.ts` (đã có `payee`, `refundSummaries` — chỉ thêm khi cần thiết và báo) | `src/modules/order/**` |

Hợp đồng chung đã có: `PaymentGateway.requestRefund({..., payee})`, `PaymentGateway.refundSummaries(orderCodes)`, `OrderPaymentGateway.markReturnRefunded(returnRequestId, tx)` (order chỉ đổi `received → refunded`).

**Migration** (viết tay, thêm cột có DEFAULT/NULL — an toàn deploy): `20261026100000_return_roles_order`, `20261026100100_return_roles_payment`, `20261026100200_return_roles_permissions`.

## 9. Kiểm thử

* Jest: máy trạng thái (mọi chuyển hợp lệ + từ chối chuyển sai), SLA job (từng hạn), hoàn tiền một phần/nhiều lần, chặn vượt số lượng, COD bắt buộc TK, `not_received`, delivery-failed (đã/chưa thu tiền, có/không nhập kho), PayOS payout poll (processing → done/failed), providerRef trùng, `settlementOrders` loại đơn có đổi trả mở.
* HTTP smoke trên DB cô lập (Docker) + E2E trình duyệt (khách → shop → CSKH → kế toán).
* Đối soát với PayOS thật chỉ làm khi người dùng bật lại chi tự động.

## 10. Checklist

- [x] Hợp đồng gateway dùng chung (`payee`, `refundSummaries`)
- [x] BE-Order: máy trạng thái + endpoint + SLA + thông báo + quyền + migration
  - [x] Migration viết tay `20261026100000_return_roles_order` (cột `return_requests` + `orders.shipping_alerted_at`, chỉ mục hạn, `shop_id` backfill, dữ liệu cũ `approved` ⇒ `received`) · `20261026100200_return_roles_permissions` (gỡ `order.return.process` khỏi vai manager) · `prisma generate` đã chạy · đối chiếu bằng `prisma migrate diff` schema→schema
  - [x] Máy trạng thái 8 trạng thái + bảng `RETURN_TRANSITIONS` (mọi chuyển đi qua `ReturnCoreService.move`, compare-and-set + khoá `FOR UPDATE`); service theo vai: `ReturnService` (khách) · `ShopReturnService` · `AdminReturnService` (resolve) · `ReturnSlaService` (job 10 phút trong `OrderJobs`); endpoint `process` cũ đã xoá
  - [x] Khách: tạo (lý do chuẩn, TK nhận hoàn bắt buộc với COD đã thu, minh chứng chỉ từ kho upload ≤ 8, `not_received`), get, ship-back, cancel, escalate; response đủ §4.1 (`canCancel/canShipBack/canEscalate`, `deadlineAt/Kind`, `returnAddress`, `refundAccount` che số, `refund`)
  - [x] Shop `/shop/returns` list/get/approve/reject/receive (quyền `shop.return.read/process`, shopId từ phiên) + `POST /shop/orders/{code}/delivery-failed`; sàn `/admin/returns` list/get + `resolve`; `cancelByStaff` mở thêm `shipping`
  - [x] SLA: shop quá hạn duyệt · khách không gửi hàng · shop quá hạn nhận hàng · nhắc shop 24h (1 lần) · cảnh báo đơn `shipping` quá hạn (1 lần); `settlementOrders` loại đơn có đổi trả mở (requested/approved/escalated/received); `OrderResponse`/`OrderSummary` thêm `refund` (một lần `refundSummaries` cho cả trang)
  - [x] Thông báo đúng người §7 (`ShopQueryApi.memberUserIdsWithPermission` + `staffUserIdsWithPermission(order.return.process)`); setting §3 + mặc định; quyền §5 (preset + `SHOP_ASSIGNABLE_PERMISSIONS`); `docs/06_FE_CONTRACT.md` mục "đổi trả & hoàn tiền"
  - [x] Mở rộng so với plan (cộng thêm, không phá): `approve` nhận `returnAddress` (shop chưa có địa chỉ nào trong hệ thống ⇒ bắt buộc lần đầu, sau lấy lại địa chỉ gần nhất; `GET /shop/returns/{id}` trả `suggestedReturnAddress`); `ReturnRequestResponse.calculatedRefundAmount`; `OrderResponse.canReportNotReceived`; `reasonCode` bắt buộc, `reason` tuỳ chọn
  - [x] Test: `return.rules` · `return.service` · `shop-return.service` · `admin-return.service` · `return-sla.service` · `return.requests` · `return.controllers` · `order-lifecycle` (huỷ đơn đang giao, delivery-failed, refund theo lô) · `shop-order.service` · `order.queryapi` · `shop.queryapi` · quyền · setting (harness `test/helpers/return-harness.ts`)
- [x] BE-Payment: payout xong mới `done` + payee + providerRef duy nhất + dòng trừ có mã đơn + thông báo kế toán
  - [x] Migration viết tay `20261026100100_return_roles_payment` (cột `refunds.payee_*`/`gateway_*`/`needs_manual`, unique một phần `uq_refunds_provider_ref` sau khi gỡ trùng, `shop_payout_lines.source_order_code` + backfill) · `prisma generate` đã chạy
  - [x] PayOS payout "00" = đã NHẬN lệnh ⇒ refund giữ `processing` (`gatewayStatus=submitted`); job `reconcileGatewayRefunds` (1 phút) poll `getPayout`: succeeded ⇒ ghi `providerRef=payos-refund:<payoutId>` + ghi sổ `done` · failed ⇒ `failed` (chạy lại ⇒ lệnh MỚI `<id>-<lần>`) · chưa rõ ⇒ giữ; treo > 30 phút ⇒ `needsManual` + báo kế toán 1 lần; đã gửi lệnh thì KHÔNG gửi lại
  - [x] Payee: `requestRefund` chuẩn hoá + lưu (sai định dạng ⇒ 400 `PAYMENT_REFUND_PAYEE_INVALID`); THIẾU payee (COD…) KHÔNG ném lỗi — vẫn tạo refund `payee_source=none`, `needs_manual`, COD ⇒ `manual_transfer`, báo kế toán liên hệ khách; chi theo thứ tự tài khoản đã trả → khách khai (PayOS từ chối tài khoản nào thì lần chạy lại đổi sang tài khoản còn lại) → chuyển tay; COD + payee đi payout PayOS như PayOS
  - [x] PayOS từ chối ngay: chắc chắn (4xx/mã nghiệp vụ) ⇒ `gatewayStatus=failed`, nhập providerRef ghi sổ tay được, chạy lại = lệnh mới; không rõ kết quả (timeout/5xx) ⇒ `needsReconcile`, chạy lại cùng khoá; `reason` cắt ≤ 255; job đối soát xoay vòng theo `updated_at`; migration `20261026100300_refund_indexes`
  - [x] `providerRef` tay duy nhất (409 `REFUND_PROVIDER_REF_DUPLICATE`, pre-check + P2002) + kiểm định dạng; response hoàn tiền thêm `payee`(che số) · `payeeSource` · `gatewayStatus` · `needsManual` · `returnRequestId`; danh sách lọc `needsManual`
  - [x] Dòng trừ kỳ chi trả: `orderCode` = mã đơn thật (+ `lineKey` = khoá kỹ thuật `RF-…`); `refundSummaries` hoàn thiện + test
  - [x] Thông báo: kế toán (thất bại · cần chuyển tay · PayOS treo), shop (hoàn xong); khách do `order.onRefunded` lo, payment chỉ báo khách khi hoàn khoản trả trùng
  - [x] `GET /admin/refunds/:id/payee` (quyền `payment.refund.process`, `Cache-Control: no-store`): số tài khoản đầy đủ cho kế toán chuyển tay, chỉ khi refund còn mở (đã `done` ⇒ 409), mỗi lần xem ghi audit `REFUND_PAYEE_VIEWED` (không ghi số TK) — đóng-khi-lỗi
- [x] `api:sync` admin + storefront (client sinh từ backend đã sửa)
- [x] Storefront (PLAN-0011) · Admin (PLAN-0004)
- [x] Test: jest (1906) · smoke HTTP trên DB cô lập (PayOS tay, COD khiếu nại → phân xử, chưa nhận hàng, giao thất bại, SLA quá hạn) · trình duyệt (khách → shop duyệt giảm tiền → khách gửi hàng → shop nhận → kế toán ghi sổ; trùng mã giao dịch; CSKH phân xử; mobile 390px)
- [x] Review độc lập (đọc code) → đã sửa: PayOS từ chối ngay vẫn ghi sổ tay được · thiếu TK nhận hoàn không còn kẹt 400 · cắt `reason` ≤ 255 · `not_received` luôn cả đơn · không nhập kho hàng "không khớp" · escrow giữ đơn có yêu cầu bị shop từ chối còn hạn khiếu nại · allowlist Cloudinary chặt · giới hạn setting · chỉ mục `refunds`
- [ ] Còn mở — đã lên kế hoạch ở PLAN-0033 (WP-09) và PLAN-0038/0039 (giai đoạn 2): khách tự bổ sung TK nhận hoàn sau khi tạo yêu cầu (hiện kế toán liên hệ khách) · công khai các hạn `return.*` để trang chính sách đọc từ server · route xem trước số tiền hoàn · `customerName` + `maxRefundAmount` trong `ReturnRequestResponse` · job chữa yêu cầu `received` có refund `done` (cửa sổ rolling deploy) · phí ship khi trả hàng · đổi hàng (không chỉ hoàn tiền) · bật chi tự động chỉ sau khi đối chiếu PayOS thật
