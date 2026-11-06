# PLAN-0043 — E2E đặt đơn → bàn giao GHN → giao hàng và đối soát (bản sửa cho đồ án)

> Status: Implemented — E2E fake verified (2026-11-05). GHN staging và ma trận fault/restart đầy đủ chưa nghiệm thu; xem cổng kiểm cuối file.
> Thay thế PLAN-0042 và nội dung PLAN-0043 trước lần sửa này. PLAN-0042 chỉ dùng khảo sát.
> Repo: eco_backend, fashion_frontend_user, fashion_frontend_admin. Đọc AGENTS.md từng repo; owner điều khiển git, không commit/push/tạo nhánh.
> Không đọc/in khoá thật; chỉ sửa .env.example. Tiếng Việt, VND nguyên; tính bằng bigint, lưu Decimal/numeric theo repo. Không FK/import repository xuyên schema.

### Hotfix staging 2026-11-06 — tra mã client chưa tồn tại

Bằng chứng vận hành: GET detail-by-client-code trả HTTP400, code400, data=null và message `Lỗi gọi API: corev2_tenant_order_detail_by_client_order_code - Đơn hàng không tồn tại`. Adapter chỉ nhận404 nên createClaimed không bao giờ gọi create ở lượt đầu. Sửa phạm vi hẹp: chỉ endpoint tra mã client, chỉ400/code400/data=null và thông báo không-tồn-tại xác định mới trả null. Lỗi xác thực/validation/5xx/timeout giữ nguyên lỗi để tránh tạo trùng. Giữ lease, clientOrderCode, transaction/audit/outbox; không migration, không tạo dữ liệu kiểm thử trên server.

- [x] Regression phản hồi staging thực tế và lỗi khác không bị nuốt: test trước sửa 2 fail/16 pass; sau sửa 3 suite shipping/48 test pass, gồm service + adapter tạo một lần/replay không HTTP.
- [x] Adapter hotfix: lint ba file sửa, build và check:boundaries đều exit0; 3 suite shipping/48 test đạt. Không sửa env/key, không tạo DB/container hay dữ liệu thử nghiệm trên VPS. Bản sửa mới nằm trong workspace, chưa commit/push/deploy.
- [ ] Chủ dự án deploy bản sửa; đối soát lại attempt cũ và xác minh callback create thật (chưa thực hiện).
> Ownership: khách theo JWT userId; vendor theo ShopContextGuard, không nhận shopId từ body/query; sàn theo mã quyền.

## 1. Mục tiêu và các mốc nghiệm thu

Hoàn thiện FE + BE liền mạch; mỗi bước có kết quả nhìn thấy và có cách phục hồi lỗi.

```text
Địa chỉ → báo phí + voucher → xác nhận tổng → OrderGroup + đơn con
→ COD hợp lệ hoặc PayOS đã trả → shop xác nhận → đóng gói
→ yêu cầu GHN lấy hàng → mã vận đơn + in nhãn (mốc A)
→ GHN xác nhận picked, ghi pickedUpAt (mốc B: bàn giao thực tế)
→ giao thành công / trả về / CSKH → xác nhận COD về sàn
→ hoàn tất + hết escrow → chi shop (mốc C).
```

- **A bắt buộc:** đặt nhiều shop, giá/ship/voucher đúng, tạo vận đơn không trùng, nhãn in được; khách/shop/sàn xem cùng dữ liệu. Hãng nhận yêu cầu KHÔNG đồng nghĩa đã lấy kiện.
- **B bắt buộc:** picked ghi mốc bàn giao; mất webhook có job phục hồi. Demo chủ động bằng FakeCarrier lưu DB; nghiệm thu staging thật riêng.
- **C bắt buộc trước khi toàn plan Done:** giao/hoàn/thu COD/chi shop đúng, không hồi quy self COD, ví cọc, PayOS.
- FE kiểm thử phải gọi BE thật trong môi trường cô lập. Có gateway hoặc mock UI chạy được chưa phải hoàn thành E2E.

## 2. Phạm vi và quyết định

- Một hãng GHN; CarrierGateway có adapter ghn/fake. Một kiện/đơn con, demo kiện <20kg trong giới hạn kích thước dịch vụ; vượt giới hạn chặn trước đặt, không chọn gói sai.
- Checkout snapshot `fulfilmentMode=carrier|self`, `collectionMode=platform_online|carrier_cod|shop_cod`, provider/environment. Shop không đổi tuyến sau đặt. Không suy tuyến từ việc có Shipment hay từ setting hiện tại.
- Đơn cũ giữ self; COD cũ là shop_cod, PayOS cũ là platform_online. Carrier COD không cần/trừ ví cọc; self COD giữ luồng cũ.
- Tắt hãng chỉ ngừng chọn carrier cho đơn MỚI; vận đơn/đơn carrier đã đặt tiếp tục được tạo, huỷ, theo dõi và ghi thu.
- Một checkout vẫn 1 OrderGroup + N đơn con, mỗi đơn con một payment. Một QR cả nhóm thuộc PLAN-0038.
- Sàn trả phí hãng; phí khách chốt lúc đặt; chênh phí thực tế/phí hoàn sàn chịu. Dùng engine voucher hiện có.
- Delivered COD = hãng đã thu hộ. Tiền thực về sàn là mốc riêng, kế toán xác nhận có mã tham chiếu; chưa xác nhận thì không chi shop/không tự hoàn bằng tiền giả định.
- Ngoài phạm vi: nhiều hãng/kiện, tự động đối soát sao kê COD, hãng lấy hàng đổi trả, khiếu nại đền bù hãng, thuế/pháp lý, thay PayOS nạp cọc.

## 3. Nguồn GHN và WP-0 xác minh adapter

Đối chiếu tài liệu công khai ngày 2026-11-05; chưa phải bằng chứng đã chạy staging:

| Việc | Hợp đồng adapter | Nguồn |
|---|---|---|
| Báo phí | POST /shiip/public-api/v2/shipping-order/fee; truyền cả điểm lấy và giao | [Tính phí](https://developer.ghn.vn/vi/docs/order/calculate-fee) |
| Tạo | POST .../shipping-order/create; mã client theo từng attempt, payment_type_id=1 (người gửi trả phí) | [Tạo đơn](https://developer.ghn.vn/vi/docs/order/create) |
| Tra cứu | GET .../shipping-order/detail; GET .../shipping-order/detail-by-client-code | [Theo mã hãng](https://developer.ghn.vn/vi/docs/order/info), [Theo mã client](https://developer.ghn.vn/vi/docs/order/info-by-client-code) |
| Huỷ/nhãn | Kiểm cả kết quả từng mã, không chỉ HTTP status | [Huỷ](https://developer.ghn.vn/vi/docs/order/cancel), [In](https://developer.ghn.vn/vi/docs/order/print) |
| Callback | Header riêng cấu hình được; lưu bền trước phản hồi | [Webhook](https://developer.ghn.vn/vi/docs/webhook/callback-order-status) |

Env: GHN_BASE_URL, GHN_TOKEN, GHN_SHOP_ID, GHN_WEBHOOK_SECRET, SHIPPING_CARRIER=fake|ghn (mặc định fake). Snapshot provider/environment/account scope trên vận đơn; không dò vận đơn cũ bằng tài khoản/môi trường mới. Giữ adapter/config cần thiết tới khi vận đơn cũ kết thúc.

**WP-0:** fixture/contract test phải xác minh request/response, header, quyền tài khoản sàn lấy tại nhiều pickup, phí COD/người gửi trả phí, detail/huỷ/nhãn và master-data. Có credential staging được cho phép thì thử fee→create→detail-by-client-code→label→cancel. Thiếu credential ghi CHƯA kiểm staging, vẫn làm trọn fake E2E; harness không gọi tiền/email thật.

**Địa chỉ:** tài liệu create có hệ hai cấp; fee hiện mô tả district/ward. Không khẳng định GHN chỉ hỗ trợ ba cấp. Demo chốt bộ ba cấp nhất quán fee/create, `addressSystem=legacy_3level`; không trộn mã mới/cũ hoặc suy mã từ tên. Địa chỉ hai cấp chưa có ánh xạ đã kiểm phải yêu cầu chọn lại theo bộ demo trước checkout. Hỗ trợ hai cấp đầy đủ làm sau nếu WP-0 chưa chứng minh cả fee và create.

## 4. Ranh giới module và giao dịch

| Module | Trách nhiệm / điểm móc phải đọc trước code |
|---|---|
| order | order/order/service/{order.service,shop-order.service,order-fulfilment.service,order-sla.service}.ts; foundation/commission.ts; queryapi/order.queryapi.ts. Điều phối đặt/ship/huỷ, kho, lịch sử |
| shipping mới | Quote, adapter, các lần tạo vận đơn, inbox, job dò, simulator; sở hữu schema shipping |
| payment | payment/payment.service.ts, shop-wallet/shop-wallet.service.ts, shop-payout/shop-payout.service.ts. Collection mode, remittance, phân bổ phí/hoàn/chi |
| identity/shop/product | Mã địa chỉ, pickup/return, cân nặng/kích thước; đọc snapshot qua Query API |
| promotion/system/reporting | Voucher cũ, setting, chênh phí và danh sách cần xử lý |

- ShippingQueryApi chỉ đọc: locations/quote lookup/shipment snapshots. ShippingApplicationApi nhận command prepare/claim/create/cancel/reconcile; không đặt lệnh ghi trong Query API.
- Order có thể import ShippingModule. Shipping không import OrderModule/PaymentModule; worker shipping gọi OrderShippingGateway ở common do order cài để khoá đơn và áp dụng sự kiện. Gateway nhận tx, actor nguồn hãng; tái dùng logic kho/tiền/audit, không mở transaction lồng hay import service/repo chéo.
- Thứ tự khoá khi cùng cần: **ĐƠN → SHIPMENT → PAYMENT → VÍ**. Nạp cọc riêng vẫn KHOẢN NẠP → VÍ, không chạm đơn/shipment. Không khoá shipment rồi quay lại khoá đơn; claim inbox/lease commit trước transaction nghiệp vụ.
- Mọi HTTP hãng/PayOS ngoài transaction. Event processed cùng transaction ngắn với shipment/đơn/payment/history/audit/outbox; thông báo qua outbox sau commit.
- Thêm command chuyển trạng thái nguồn carrier với actor hệ thống hợp lệ; không giả admin, không mở quyền vendor sửa tay trạng thái hãng.

## 5. Dữ liệu và migration

Migration chỉ thêm, tên ngày/số chưa bị chiếm, không sửa migration đã áp. Prisma + DBML + SQL index/check phải khớp; FK chỉ trong shipping. Model có cột chuẩn audit/version/soft delete theo repo, giữ kiểu tiền cũ.

| Model | Trường/ràng buộc bắt buộc |
|---|---|
| ShippingQuote | userId/shopId, provider scope, fingerprint, input snapshot, shippingFee, feeSource=ghn/fake/fallback, expiresAt (300s mặc định); lưu bền |
| Shipment | orderId tham chiếu logic KHÔNG unique riêng; shopId, attemptNo, UNIQUE(orderId,attemptNo); clientOrderCode unique theo provider/environment/account; carrierOrderCode unique tương tự khi khác NULL |
| Shipment điều khiển | createStatus=creating/created/unknown/failed; cancelStatus=none/requested/unknown/confirmed/rejected; leaseToken/leaseUntil, retryAt/lastError, active. Partial UNIQUE(orderId) WHERE active=true; unknown vẫn active |
| Shipment giao nhận | status nullable trước hãng nhận, sau đó awaiting_pickup/picked/in_transit/delivering/delivery_failed/returning/returned/delivered/cancelled/lost; rawStatus, lastEventAt, pickedUpAt, deliveredAt, deliveryAttempts, ETA |
| Shipment snapshot | Pickup/receiver/return mã+tên+SĐT, kiện, provider scope, quotedFee, actualFee nullable, codAmount. Phí lúc create chưa mặc nhiên là phí cuối |
| ShipmentEvent | dedupKey NOT NULL UNIQUE, shipmentId nullable, provider scope/codes/type/status/time, payload giới hạn, source=webhook/poll/simulator; status=pending/processing/processed/failed/pending_verify, retryAt/count/error/lease/processedAt |
| FakeCarrierState | Trạng thái phía hãng giả tách khỏi Shipment đã áp dụng; client/carrier code, revision, lần giao, fault injection. DB dùng chung API/worker, không RAM |
| Address/Shop | addressSystem, mã+tên province/district/ward; shop pickup/return name/phone/street. Ward code là chuỗi; kiểm mã con thuộc cha |
| ProductVariant | weightGram/lengthCm/widthCm/heightCm nullable, nguyên dương có min/max; default 500g, 20×15×10cm qua settings |
| Order | fulfilmentMode/collectionMode/provider scope; quote id/fingerprint, pickup/destination/parcel snapshot, phí/phân bổ hàng/ship/voucher/commission |
| Payment | collectionMode, codCollectedAt, codRemittedAt/By, codRemittanceRef unique theo nguồn nhận, amount remitted. Không dùng boolean Shipment thay sổ tiền |

- Nhiều attempt/đơn, chỉ một active. Client code ổn định từng attempt như DH...-S1/-S2 (≤50 ký tự); retry giữ mã, không sinh attempt khác khi kết quả chưa rõ.
- Backfill mode cũ an toàn DEFAULT/NULL + mapper, không tạo Shipment cho đơn cũ. Seed idempotent, pickup đủ cho ít nhất hai shop khác nhau.
- Snapshot không phụ thuộc user còn giữ địa chỉ. Đổi địa chỉ đơn trước packing vẫn cùng tỉnh theo luật cũ; district/ward thay đổi phải báo phí lại. Nếu tổng đổi trả 409 + summary và xác nhận trước khi ghi; không giữ quote/mã GHN của địa chỉ cũ.

## 6. Checkout, báo giá và idempotency

1. Shop chọn carrier phải có pickup hợp lệ. Thiếu cấu hình báo chưa sẵn sàng trước đặt, không tự chuyển self để né cọc.
2. CheckoutSummary nhận addressId của chính khách hoặc structured address, paymentMethodCode, voucherCodes. Mỗi shop một quote; kiện deterministic: tổng weight×qty, max length/width, tổng height×qty; kiểm giới hạn trước gọi hãng.
3. Quote có đúng origin/destination/kiện. Tránh vòng lặp COD↔phí↔voucher: dùng codValue ước tính trước voucher (subtotal + phí fallback, không cam kết là trần COD), lưu trong quote; phí khách cố định, chênh phí thu hộ sàn chịu. Chưa xác minh được cách quote COD thì fallback có nhãn, không lặp HTTP vô hạn.
4. HTTP quote ngoài transaction, timeout 8s, tối đa một retry đọc/quote. Lỗi tạm thời fallback bảng phí tỉnh, nhãn Phí vận chuyển ước tính. Địa chỉ sai/ngoài vùng/kiện quá giới hạn không được fallback nhận đơn không giao được.
5. Quote bền ràng buộc user/shop/mode/provider, đầy đủ pickup/receiver (đường, SĐT), kiện, config version và giỏ. Cache theo fingerprint đầy đủ; không nhận phí do FE tính.
6. shopGroups thêm shippingQuoteId/expiresAt/shippingFeeSource/fulfilmentMode. POST orders gửi quoteIds + expectedTotal; voucher tính sau phí, vẫn ≤1 sàn + ≤1/shop.
7. Tra replay Idempotency-Key trước quote/HTTP hãng: giỏ đã xoá, quote hết hạn vẫn trả nhóm đơn cũ. Hash command giữ trường nghiệp vụ ổn định, không thêm quoteId/expectedTotal (khách phải được xác nhận giá mới cùng key); mode/address thay thật vẫn conflict theo command.
8. Quote hết hạn lấy lại ngoài transaction. Trong transaction kiểm giỏ/giá/stock/voucher/phiên bản địa chỉ/pickup/kiện và fingerprint quote. Lệch ⇒ rollback, chuẩn bị summary mới ngoài transaction, trả 409 ORDER_PRICE_CHANGED hoặc lỗi giỏ đúng nghĩa. Không gọi quote từ price() đang chạy trong transaction.
9. Lệch tổng 1đ phải xác nhận lại, không tiêu key/stock/voucher. Tổng bằng nhưng tuyến/kiện/địa chỉ đổi vẫn phải có quote khớp; không tạo vận đơn trong checkout transaction.

## 7. Tạo vận đơn, bàn giao, huỷ và SLA

### 7.1 Tạo / phục hồi

- Điều kiện dưới khoá đơn: carrier, packing, shop approved, PayOS paid nếu online, không cancel request pending, địa chỉ/kiện/pickup đủ.
- T1 khoá ĐƠN → SHIPMENT, trả attempt active nếu có; nếu chưa có tạo attempt và claim lease bằng CAS rồi commit. Đơn vẫn packing khi creating. Chỉ chủ lease gọi hãng, request khác trả snapshot đang xử lý.
- HTTP create giữ client code attempt; online codAmount=0, carrier COD codAmount=total đã chốt. Sàn trả phí hãng, không thu ship thêm ngoài tổng.
- T2 khoá lại đơn→shipment, kiểm token/attempt, lưu mã và chuyển packing→shipping cùng transaction; ghi GHN đã nhận yêu cầu lấy hàng, audit/outbox. Shipping chưa chắc picked; không trừ kho lần hai.
- Timeout/crash sau hãng nhận: unknown giữ active; retry/job claim rồi detail-by-client-code ngoài tx. Tìm được finalize T2; chưa chắc không tồn tại giữ unknown. Chỉ retry cùng mã sau not-found đáng tin; không đổi mã để né lỗi.
- T2 rollback/lease hết hạn: đối soát trước create lại, token cũ không ghi đè attempt mới. Nếu hãng đã nhận mà đơn không còn được giao, tạo việc huỷ bù có retry/cảnh báo, không bỏ rơi kiện.
- Nhãn hãng lỗi có phiếu HTML nội bộ với mã đúng và ghi Phiếu nội bộ; không giả nhãn GHN chính thức. Mốc A phải có mã đã xác minh và cách in dùng được.

### 7.2 Huỷ / hãng tự huỷ / SLA

- Chưa attempt giữ luật huỷ cũ. Creating/unknown/cancel pending: 409 SHIPMENT_OPERATION_PENDING hoặc 202 cho command đã xếp hàng, chưa hoàn/nhập kho.
- Chưa picked: shop/sàn có quyền gửi huỷ; khách giữ ma trận quyền cũ. Claim cancel dưới khoá, gọi hãng ngoài tx, xác nhận cancelled mới huỷ đơn/hoàn/nhả kho đúng một lần. Kiểm kết quả từng mã; timeout phải tra lại.
- Đã picked chặn huỷ trực tiếp/nhập kho; CSKH theo ngoại lệ/tranh chấp, chờ returned xác minh cho hàng giao thất bại. Mọi đường admin/shop/SLA/khoá shop đều phải qua barrier carrier, không đi tắt bằng hàm huỷ cũ.
- Hãng tự cancel trước picked: đóng attempt, command carrier đưa shipping→packing có lịch sử riêng, cấp hạn ship hợp lý một lần, không phạt do hãng; shop tạo attempt mới. Không thêm bước lùi này vào quyền chuyển trạng thái chung.
- Cancel bất thường sau picked ⇒ CSKH, không tự restock/packing. Event attempt cũ chỉ lịch sử, không đè attempt mới.
- Creating/unknown quá hạn: reconcile/cảnh báo, không SLA tự hoàn/kho. Awaiting_pickup dừng hạn shop giao, có hạn hãng lấy mặc định 24h + nhắc một lần. Chỉ pickedUpAt mới chứng minh bàn giao; quá hạn hãng không phạt shop.

## 8. Inbox, worker, poll và trạng thái

- Webhook dùng secret header cấu hình, so khớp hằng thời gian, che log. Chỉ dùng secret URL dự phòng nếu cần và phải che URL; không tự nhận HMAC nếu hãng không cung cấp chữ ký.
- Inbox commit trước 200; DB lỗi trả 5xx. DedupKey canonical provider scope+codes+type/status+timestamp chuẩn. Thiếu time/identity lưu pending_verify và hỏi track; không đếm lần giao bằng hash payload không ổn định.
- Webhook đến trước T2: giữ event chưa gắn, retry liên kết client code. Mã ngoài hệ thống cách ly/log; không bỏ event thuộc attempt đang tạo. Payload che PII/retention, không trả khách.
- Worker claim/commit lease, gọi track ngoài tx, rồi áp dụng với khoá ĐƠN→SHIPMENT→PAYMENT. processed cùng transaction side-effect. Crash/replay không xử lý đôi; DB inbox là nguồn phục hồi, queue chỉ đánh thức.
- Verify track cho picked/delivered/returned/cancelled và bất thường. Lỗi đọc/độ trễ giữ pending_verify, retry/backoff; không lấy timestamp webhook chưa kiểm để mở escrow sớm.
- Ma trận có nhánh, không rank tuyến tính: cho bỏ qua trung gian khi track xác minh; delivered không lùi vì picked muộn; delivery_failed được quay delivering ở lần mới. Đếm lần theo lần giao xác minh/revision fake, không theo số webhook.
- Ba lần thất bại là ngưỡng cảnh báo/yêu cầu xử lý hoàn, không chứng minh hàng đã về. Chỉ returned xác minh mới restock. Lost/damage/exception có công việc sàn, không tự đền tiền.
- Job mỗi 5 phút phân trang active shipments/unknown/inbox retry, giới hạn concurrency; nút Làm mới dùng cùng reconcile có rate-limit. Restart vẫn phục hồi DB.

| Hãng xác minh | Shipment / đơn | Tác dụng |
|---|---|---|
| ready_to_pick, picking | awaiting_pickup / shipping | Chờ lấy, chưa bàn giao |
| picked hoặc mốc sau lấy | picked/in_transit / shipping | pickedUpAt một lần; thiếu picked webhook vẫn suy từ mốc sau đã xác minh |
| delivering, delivery_fail | delivering/delivery_failed / shipping | Lần giao đúng, không restock |
| waiting_to_return, return/return_transporting/return_sorting/returning | returning / shipping | Chờ hàng về; return_fail chỉ cảnh báo |
| returned | returned / cancelled | Restock một lần, hoàn online; COD chưa thu đóng pending, không hoàn giả |
| delivered | delivered / delivered | Ghi thu theo mode. Có not_received mở giữ bằng chứng + việc CSKH, chặn complete/chi; giải quyết xong có reconcile tiếp |
| cancel trước picked | cancelled / packing hoặc cancelled | Theo nguồn huỷ §7.2 |
| lost/damage/exception | Cần xử lý / shipping | Hàng đợi sàn, không tự xoá tiền/kho |

## 9. Tiền, hoàn và đối soát

### 9.1 Phân bổ carrier online và COD

Không tái dùng nguyên payout cũ `total + platformDiscount` vì bao gồm ship. Giữ luật cũ cho self, carrier lưu phân bổ lúc đặt:

```text
S=subtotal; Ds=shopDiscount; Hs=shopShippingDiscount; Dp=platformDiscount
F=shippingFee trước voucher; C=khách trả=S+F−Ds−Dp
B=commissionBase hiện hành=S−Ds+Hs
G=doanh thu shop trước hoa hồng=B−Hs=S−Ds
K=hoa hồng trên B theo rate snapshot/quy tắc làm tròn cũ
Chi shop=G−K (âm đi cơ chế nợ, không clamp làm mất nghĩa vụ)
Bất biến: C+Dp=(G−K)+K+F
Biên thuần sàn sau phí hãng A: K+F−Dp−A
```

Ví dụ S=500.000, F=30.000, rate=5%, không voucher ⇒ khách 530.000, shop 475.000, hoa hồng 25.000, ngân sách ship 30.000; không chi shop 505.000. Phí hãng 35.000 sàn chịu chênh 5.000. Shop freeship Hs=30.000 ⇒ khách 500.000, shop 445.000, hoa hồng 25.000. Voucher sàn 20.000 giảm khách 20.000, không trừ thêm shop.

- payment_type_id=1; online codAmount=0, carrier COD codAmount=C. Quote/create/detail cùng snapshot pickup/receiver/kiện; không sửa tổng khách sau đặt khi phí hãng đổi.

### 9.2 Thu COD và kỳ chi

- Delivered xác minh ghi codCollectedAt (hãng thu); không wallet.applyCodCommission, chưa coi tiền sàn nhận. Payment pending tới remittance; response/UI có carrierCodStatus=collected_pending_remittance, không đòi khách trả lại.
- Confirm-cod-received: kế toán, Idempotency-Key, khoá ĐƠN→SHIPMENT→PAYMENT; amount đúng C/ref không trùng, audit. Set codRemittedAt + paid qua gateway; lặp cùng command trả cũ, khác ref/số conflict. Thiếu/thừa tạo việc đối chiếu, không tự chi.
- settlementOrders đổi từ loại mọi COD thành nhận platform_online paid hoặc carrier_cod remitted/paid; self shop_cod vẫn loại. Vẫn cần completed + hết return window + không return/tranh chấp mở + không hold.
- Tách markCodCollected/đảo thu theo collectionMode; không gọi updateStatus delivered rồi hy vọng nó bỏ ví cọc. Mode bất biến phải áp ở BE, không chỉ UI.

### 9.3 Huỷ, hoàn và trả hàng

- Online carrier huỷ/returned dùng refund hiện có. Carrier COD chưa collected: đóng payment pending thành cancelled, không tạo hoàn. Sửa/test cả ca cũ not_received duyệt xong order returned nhưng payment COD pending.
- Carrier COD đã collected chưa remitted mà cần hoàn: tạo việc kế toán/hold, không auto-refund/đảo ví. Sau xác minh nguồn tiền mới cho hoàn, actor/audit rõ; không tự đoán hãng đã trả khách.
- Refund carrier sau payout dùng snapshot G/K/ship mới, không sale.gross bao gồm ship và không applyCodRefund vào ví. Hoàn phần dùng tỷ lệ LUỸ KẾ theo khách trả để khớp làm tròn; hoàn đủ C đảo đủ G/K, sàn chịu phí hãng không thu hồi.
- kind=mismatch/duplicate_payment không trừ doanh thu như hoàn hàng. Tranh chấp mở giữ escrow dù hãng delivered. Không viết lại return state machine ngoài các điểm collectionMode/phân bổ và ca pending nêu trên.

## 10. API và giao diện

Prefix /api/v1, envelope/DTO/Swagger đầy đủ; cập nhật docs/06 trước nối FE, đơn self cũ giữ compatibility.

| API dự kiến | Quyền/hành vi |
|---|---|
| GET /shipping/locations/provinces, /districts?provinceId=, /wards?districtId= | Master-data đúng addressSystem; cache 24h, fake fixture hai shop khác pickup |
| GET /checkout/summary, POST /orders | Structured address/method/quoteIds, expectedTotal/idempotency hiện có, response §6 |
| Address/shop/product API hiện có | Thêm pickup/return, parcel, mã+tên, giữ ownership/permission |
| POST /shop/orders/:code/ship | shop.order.update; 200 xong hoặc 202 đang xử lý, trả snapshot, không báo thành công giả |
| GET /shop/orders/:code/shipments, /label | shop.order.read; lịch sử attempt, nhãn, che PII/khoá |
| POST /shop/orders/:code/shipping/reconcile | shop.order.update; rate-limit, cùng đường worker |
| Cancel API shop/sàn hiện có | Barrier §7.2; cancel pending trả rõ, FE chưa vẽ đã huỷ |
| GET /admin/shipping/shipments, /:id | order.order.read; phân trang/lọc cần xử lý, shop tuỳ chọn |
| POST /admin/shipments/:id/confirm-cod-received | Mã mới payment.cod.confirm chỉ admin/accountant, catalog/preset + perms:sync; amount/ref/note, Idempotency-Key |
| POST /webhooks/ghn | Public secret header, inbox commit trước 200 |
| POST /admin/shipping/simulate | Mã mới shipping.simulator.use, chỉ admin demo; shipmentId/event/revision/fault |

- OrderResponse thêm mode, shipment hiện hành/history, create/cancel status, pickedUpAt, ETA/tracking, carrierCodStatus; cờ canShip/canReconcile/canPrintLabel/canCancel do BE tính.
- Storefront: chọn địa chỉ cha/con, phí theo shop, báo giá hết hạn/409, COD availability theo mode. Timeline tách Chờ hãng lấy/Hãng đã lấy/Đang giao; COD đã collected không hiện Thanh toán lại.
- Vendor: pickup/return và parcel, packing bấm Yêu cầu GHN lấy hàng; creating/unknown có kiểm tra lại; có mã mới in. Chặn sửa tay giao/thu/restock carrier cả BE và FE.
- Sàn: /shipping/shipments lọc creating/unknown/quá hạn lấy/inbox lỗi/thất lạc; COD chờ remittance cho kế toán; hiển thị quoted/actual fee. Không đợi dashboard mới có đường xử lý ngoại lệ.
- Feature shipping mới theo feature-first; không import internals chéo feature. Storefront Vineta/Bootstrap, admin Tailwind/shadcn; Orval → wrapper hook → component, 3 lớp quyền.
- Không polling vô hạn: focus/nút Làm mới; chỉ màn creating/unknown được poll 3s tối đa 120s, dừng final/403/404/unmount, sau đó nút kiểm tra. Khi code cập nhật ngoại lệ này vào AGENTS.md FE.

## 11. FakeCarrier và demo

- FakeCarrierState là nguồn track riêng, lưu DB. Simulator cập nhật trạng thái hãng giả rồi tạo inbox; cùng verify/worker/transaction như hãng thật, restart không mất.
- Không bơm trạng thái giả vào vận đơn GHN staging rồi bỏ verify thật. Demo diễn tiến dùng đơn provider=fake từ checkout; staging riêng cho fee/create/detail/cancel/label, không đổi provider sau đặt.
- Seed hai shop/pickup, khách, owner/staff, CSKH/kế toán, voucher ship/hàng, self legacy. Hết escrow demo bằng seed/clock/job runner CHỈ DB audit; không return.window_days=0 trên DB dùng chung.
- Fake chỉ DB demo/audit, có dấu giả lập; production chặn fake/simulator. Đơn/giao dịch giả không được phát lệnh PayOS thật; có test hàng rào cấu hình.
- Demo 1: hai shop COD → đặt → packing → mã/nhãn A → picked B → delivered → kế toán xác nhận → complete+escrow → kỳ chi giả C.
- Demo 2: online → create timeout sau hãng nhận → reconcile đúng mã → giao thất bại → returned → kho/refund một lần.
- Demo 3: hãng huỷ trước lấy → packing → attempt mới → webhook attempt cũ không ảnh hưởng.

## 12. Gói triển khai và cổng kiểm

Thực hiện tuần tự; không tự giao nhiều agent chỉ vì có WP. Trước mỗi bước code giải thích theo explain.md, tick checklist theo bằng chứng.

| WP | Bàn giao | Cổng kiểm |
|---|---|---|
| 0 | Contract fixture/capabilities, địa chỉ/điểm lấy, ví dụ tiền, danh sách source dự kiến | Code thật + docs/10/11/12/13; staging chưa kiểm ghi rõ |
| 1 | Migration/schema/index/DBML/seed, mode snapshot, common gateway/interface | migration:check, boundaries, legacy không đổi nghĩa |
| 2 | shipping/fake DB/adapter/locations/pickup/parcel | Contract/unit, không vòng import |
| 3 | Quote/checkout/expectedTotal/idempotency + FE địa chỉ/checkout | Đặt hai shop COD/online, không HTTP trong tx |
| 4 | Claim/create/unknown/recovery/label/cancel barrier/SLA + FE vendor | Race/restart Postgres, mốc A |
| 5 | Inbox/worker/poll/trạng thái/simulator + FE timeline | Lặp/mất/đảo webhook/restart, mốc B |
| 6 | COD remittance/split ship/refund/payout + FE kế toán | Bất biến tiền/escrow/hold/self, mốc C |
| 7 | UI desktop/390px/quyền/Orval/docs/demo/staging report | Verify ba repo, harness sạch, browser bằng chứng |

FE đi cùng WP-3/4/5, không dồn tới cuối. Mỗi WP kiểm liên quan; cuối đợt verify toàn bộ. BE dùng build/verify đúng package.json, không gọi npm run typecheck vì chưa có script đó.

## 13. Kiểm thử và bằng chứng

Unit/contract: mapping nhánh, quote fingerprint/expiry/ownership, tiền/voucher, địa chỉ, lease, quyền và config demo. Harness Postgres+Redis+FakeCarrier DB+PayOS giả cô lập; thêm t12-shipping.mjs vào run-all khi xanh. Không chạm DB dev/prod/tiền/email thật.

| Mã | Kịch bản bắt buộc |
|---|---|
| SHP-D01 | Hai shop pickup khác, COD không cọc → quote riêng → Group+hai đơn, đúng mode/stock/voucher/tổng |
| SHP-D02 | Online chưa paid không ship; paid giả → codAmount=0; carrier COD codAmount=C, không thu ship thêm |
| SHP-D03 | Quote lỗi tạm fallback có nhãn; địa chỉ/kiện sai không fallback; giá đổi 409 không tiêu stock/voucher/key |
| SHP-D04 | Replay checkout khi quote hết hạn/giỏ xoá → đơn cũ không gọi hãng; quote user khác bị chặn |
| SHP-D05 | Ship đồng thời 10 lần → một active attempt/một create phía hãng, 200/202 nhất quán |
| SHP-D06 | Mất response sau hãng nhận, lease hết/restart → tra client code đúng mã, không trùng kiện |
| SHP-D07 | T2 rollback → phục hồi; create đua cancel/SLA/khoá shop không hoàn/restock khi chưa rõ |
| SHP-D08 | Cancel trước picked/timeout/partial failure → chờ xác minh; sau picked chặn huỷ trực tiếp |
| SHP-D09 | Hãng huỷ → packing/hạn mới không phạt → attempt mới; event cũ không đổi đơn |
| SHP-D10 | Nhãn/phiếu nội bộ in được; có mã chưa picked chỉ chờ lấy, picked mới bàn giao |
| SHP-D11 | Event lặp/đảo/đến trước T2; worker chết sau inbox commit → phục hồi không mất/lùi/đôi |
| SHP-D12 | DB inbox lỗi trả 5xx; track lỗi retry; sai secret không side-effect |
| SHP-D13 | Failure lặp không tăng lần; giao lại; ba lỗi chưa restock, returned mới một lần |
| SHP-D14 | Mất picked/delivered webhook → poll; API/worker restart giữ FakeCarrierState |
| SHP-D15 | Delivered có not_received mở giữ tranh chấp/escrow; xử lý xong reconcile tiếp được |
| SHP-D16 | Carrier COD collected chưa remitted không cọc/chi/auto-refund; confirm mới paid |
| SHP-D17 | Confirm đồng thời/lặp/ref trùng/sai số không thu hai lần; COD chưa thu huỷ đóng pending |
| SHP-D18 | Completed+escrow mới chi, remittance/return/bank hold vẫn chặn, self COD vẫn loại |
| SHP-D19 | Hàng/ship/voucher sàn/shop/freeship/số lẻ khớp §9.1; shop không nhận phí hãng |
| SHP-D20 | Hoàn phần/nhiều lần/đủ trước/sau payout đúng luỹ kế, không ví carrier/kho/hoàn đôi |
| SHP-D21 | Self COD/PayOS cũ giữ luật; tắt carrier sau đặt không đổi mode đơn |
| SHP-D22 | Shop khác 404; staff thiếu quyền/khách/CSKH không confirm COD/simulate; không lộ PII/secret |
| SHP-D23 | Địa chỉ/pickup/parcel đổi sau quote, đổi địa chỉ đơn trước packing → snapshot/quote mới hoặc 409 |
| SHP-D24 | Fake simulate→track→inbox cùng handler; production chặn giả lập/chi thật đơn giả |
| SHP-D25 | Quá hạn lấy/lost/exception có công việc sàn, cảnh báo một lần, không bỏ rơi |

- Chạy lại t01–t11. Baseline mới nhất docs/13 §14: 444 ✔ / 0 ✘ / 37 ℹ, 481 mã, 2026-11-03; không lấy lỗi audit cũ làm hiện trạng. Giữ fixture self cho assertion legacy, thêm carrier, không nới test che lỗi.
- Browser khách→shop→hãng giả→kế toán, desktop/390px, owner/staff có/không quyền, ảnh+mã đơn; đủ A/B/C. Báo staging riêng, không dùng ảnh mock thay BE.
- Docs/13 mục mới ghi command/exit code, case count, drift/baseline, response che PII và ảnh/hạn chế; không Done chỉ vì unit xanh.

## 14. Rủi ro, tài liệu, nhật ký và Definition of Done

Rủi ro cần WP-0 xác minh: quyền nhiều pickup dưới tài khoản sàn, phí COD/phí chốt, master-data staging, nhãn. Không âm thầm biến marketplace thành một kho. Staging thiếu khả năng/credential phải ghi rõ, fake E2E vẫn hoàn thiện độc lập.

Khi code cập nhật docs/06_FE_CONTRACT, docs/10_ORDER_LIFECYCLE, docs/11_SCENARIO_CATALOGUE (SHP-D*), docs/12_OPERATIONS_RUNBOOK (unknown/retry/remittance/demo), docs/13_E2E_TEST_REPORT; AGENTS + docs/02_MODULE_MAP (shipping), docs/07_KEYS_CHECKLIST + .env.example, DBML/README, FE plan và polling rule. Lần chỉ sửa kế hoạch này không đánh dấu các tài liệu đó thành đã triển khai.

| Ngày | Tiến độ | Bằng chứng |
|---|---|---|
| 2026-11-05 | Sửa theo yêu cầu: E2E A/B/C, mode, quote ngoài tx, attempt/recovery/inbox, phí/COD và fake DB | Chỉ sửa plan này, chưa code/migrate/E2E/giao dịch thật |

File đã đổi trong lần này: docs/plans/PLAN-0043-ghn-shipping-final.md. §4–5/10 là source dự kiến; ghi file thực tế sau mỗi WP.

- [x] WP-0 contract/capabilities + nguồn/fixture/ví dụ tiền (offline; staging chưa kiểm)
- [x] WP-1 migration/schema/mode tương thích; 48 migrations áp DB cô lập, drift = 0 (DBML cập nhật trong đợt)
- [x] WP-2 shipping/fake DB/adapter/locations/pickup/parcel
- [x] WP-3 checkout FE+BE/quote/idempotency/giá đổi
- [x] WP-4 ship/cancel/recovery/label/SLA — mốc A
- [x] WP-5 inbox/worker/poll/timeline/simulator — mốc B
- [x] WP-6 remittance/phân bổ/refund/payout FE+BE — mốc C
- [x] WP-7 UI desktop/390px/quyền/Orval/demo report
- [ ] npm run verify cả ba repo + migration:check trên DB cô lập xanh
- [ ] SHP-D01…D25 và t01…t11 không hồi quy, có browser evidence
- [x] Staging report ghi đã kiểm thật hoặc chưa kiểm/lý do; không đánh đồng fake/GHN thật
- [x] Docs/API/settings/env/DBML đúng hiện trạng, ranh giới module hợp lệ
- [x] Dọn dịch vụ kiểm thử trong phạm vi đã tạo, giữ DB/file người dùng

Các WP code và demo fake đã thực hiện; còn cổng kiểm baseline và các nhánh fault/restart đầy đủ trong ma trận. Toàn plan Done chỉ khi A/B/C và cổng kiểm đạt; thiếu staging ghi E2E fake đạt, staging chưa kiểm, không tuyên bố GHN thật đã nghiệm thu.

### Điều chỉnh khi triển khai 2026-11-05

- Mã giả lập chốt shipping.simulator.use theo invariant module.resource.action (thay tên hai phần trong bản thiết kế).
- Đổi địa chỉ carrier triển khai chọn địa chỉ lưu cùng tỉnh/phí; thay phí yêu cầu huỷ/đặt lại để giữ chứng từ tổng tiền/voucher/PayOS nhất quán.
- Phát hiện seed cũ có hai description setting >255 ký tự làm DB mới seed lỗi: rút gọn mô tả, giữ policy/value.
- Người dùng yêu cầu dọn sạch: chỉ dọn container/DB/browser/profile/file tạm của đợt kiểm; không xoá dữ liệu có sẵn.

### Cổng kiểm đã chạy — hoàn tất demo fake

- 48 migration áp DB fitly_ghn_audit cô lập, migration:check không drift.
- Backend verify: 98 suite / 2.515 test đạt; sau rà soát cuối bổ sung 14 regression, chạy tập trung 2 suite / 52 test đạt. TypeScript toàn bộ bao gồm test fixture đạt.
- Browser thật: admin danh sách vận đơn, vendor chi tiết đơn và bấm yêu cầu lấy hàng; khách 390px xem trạng thái và tiền. Không lỗi JS/tràn ngang. Ảnh trong assets/e2e-audit/ghn-evidence.
- t12 mở rộng 46/46 đạt, exit0; baseline t01–t11 không được chạy nguyên trạng vì hardcode API4030/DB55442/container fitly-audit-* và có bài dừng DB. Đợt này kiểm hồi quy bằng toàn bộ unit + t12 cô lập; không đánh dấu driver baseline cũ đã đạt.
- Nguồn fake/demo bị chặn thu/chi/hoàn/ghi sổ vào endpoint tiền thật; loopback PayOS mock ngoài production vẫn cho phép E2E.

- Production build storefront: 34 trang, admin: 72 trang đạt; cả hai typecheck/lint đạt (storefront có 2 cảnh báo img sẵn có).
- Mốc C fake đã kiểm remittance và dòng SALE sau escrow, chưa thực hiện khoản chi outbound/refund done thật.

- Dọn xong: container fitly-ghn-audit-db/redis cùng anonymous volume đã xoá; các cổng4031/3403/3404/4021/9227/55443/56390 không còn listener. Profile .ghn-browser-audit và ba file log/results tạm đã xoá. Giữ source/harness/ảnh bằng chứng, không thay DB người dùng.
- Hai sửa cuối đã lint + build backend lại thành công; không thay schema/API shape, nên không cần sinh client lại.
