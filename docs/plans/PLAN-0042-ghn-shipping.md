# PLAN-0042 (v2) — Hệ thống logistics của sàn theo mô hình Shopee / TikTok Shop, GHN là hãng đầu tiên
> **ĐÃ THAY BẰNG `PLAN-0043-ghn-shipping-final.md`** — file này chỉ còn là tài liệu khảo sát/lý do thiết kế; agent code làm theo PLAN-0043.

> Status: **Draft v2 — chờ chủ dự án duyệt** (2026-11-05). Thay bản v1 (chỉ "gọi GHN"). Chưa có code.
> Nguồn: tài liệu GHN `developer.ghn.vn` (đã đọc) + cách vận hành các sàn lớn (kiến thức công khai, **các con số chính sách chỉ là mặc định cấu hình được**, không phải trích nguyên văn).
> Repo: `eco_backend` (module mới `shipping` + order/payment/shop/product/promotion) · admin FE · storefront.

## 1. Nguyên tắc cốt lõi của các sàn lớn (rút ra để áp dụng)
1. **Sàn là người điều phối logistics, shop chỉ "chuẩn bị hàng".** Shop không tự khai trạng thái giao, không tự chọn hãng/mã vận đơn: bấm "Chuẩn bị hàng" → sàn tạo vận đơn với hãng → shop in phiếu (AWB) dán lên hàng → hãng đến lấy (hoặc shop mang ra bưu cục). Mọi trạng thái về sau do **hãng báo**.
2. **Hãng là cắm-rút (carrier abstraction):** sàn bật nhiều đơn vị vận chuyển; mỗi hãng một adapter; khách chọn hãng/tốc độ lúc thanh toán (hoặc sàn tự phân bổ). GHN là adapter đầu tiên; thêm GHTK/J&T/ViettelPost sau này không đụng nghiệp vụ.
3. **Phí vận chuyển có hai mặt tách bạch:** (a) *phí khách thấy* (báo giá lúc checkout, có thể được sàn/shop trợ giá, có voucher freeship) và (b) *phí hãng thực tính* với sàn. Chênh lệch (a)−(b) và các phụ phí (đo lại cân nặng, vùng xa, hoàn hàng) được **quyết toán vào tiền shop ở kỳ chi** — shop thấy từng dòng trong sao kê, không có khoản mờ.
4. **Tiền: người mua trả cho sàn, hãng thu COD nộp về sàn; sàn giữ rồi trả shop sau khi đơn hoàn tất** (hết thời hạn đổi trả/khiếu nại). Shop không bao giờ cầm tiền COD.
5. **Mọi thứ có hạn chót và tự động:** hạn shop chuẩn bị hàng (ship-by), hạn hãng lấy hàng, hạn giao; quá hạn ⇒ cảnh báo/tự huỷ/phạt điểm. Hệ thống sẵn có (SLA, điểm vi phạm) dùng lại.
6. **Ngoại lệ là chuyện thường ngày:** giao thất bại, hoàn hàng, thất lạc, hư hỏng, đo lại cân nặng đều có luồng + hàng đợi xử lý cho vận hành, không để "kẹt trạng thái".

## 2. Điều đã xác minh từ tài liệu GHN
| Điều | Kết luận |
|---|---|
| Môi trường | Staging `dev-online-gateway.ghn.vn`, Production `online-gateway.ghn.vn`; token **riêng** (lấy ở `developer.ghn.dev` / `.vn` → Manage token, OTP SĐT); header `Token` + `ShopId` |
| Tạo đơn | `POST /shiip/public-api/v2/shipping-order/create`; bắt buộc người nhận, `weight`(g), `length/width/height`(cm); **`from_*` ghi đè địa chỉ lấy hàng theo đơn** ⇒ một tài khoản GHN của sàn phục vụ mọi shop; `client_order_code` làm retry an toàn; cờ `is_new_*_address` cho địa chỉ 2 cấp sau 01/07/2025 |
| Tính phí | `POST …/shipping-order/fee` (to_district_id, to_ward_code, weight, service_type_id 2/5, cod_value, insurance_value, coupon) trả tổng + từng phụ phí (COD, vùng xa, bảo hiểm…) ⚠ dùng `district_id`; **phải thử Staging với địa chỉ 2 cấp mới** |
| COD | ≤ **5.000.000đ/đơn** (khớp luật COD sàn); `updateCOD` |
| Webhook | GHN→sàn, **không chữ ký** (dùng header tuỳ chỉnh làm khoá), phải 2xx, retry backoff, **trùng ⇒ khử theo `OrderCode+Type+Time`**; loại `switch_status`, `cod` (đã chuyển tiền COD + ngày), `update_fee`, `update_weight`, `update_cod`, `update_partial_return`; payload có `Status`, `ReasonCode`, `ShipperName/Phone`, `PodURL` (ảnh giao hàng, nếu bật) |
| Trạng thái | ready_to_pick→picking→picked→storing/sorting/transporting→delivering→delivered; delivery_fail→waiting_to_return→returning→returned; cuối: cancel, lost, damage, exception, scrap |
| **API trả tiền về?** | **Không.** Chỉ có webhook `cod` *thông báo* đã chuyển; tiền thật về TK ngân hàng sàn theo chu kỳ GHN; Staging không chuyển tiền thật ⇒ đối soát COD tự dựng + **GHN giả** để thử |
| Giả lập trạng thái trên Staging | Tài liệu không nêu ⇒ hỏi GHN / thử; dự phòng GHN giả nội bộ |
| Chưa rõ | Cách trừ phí khi có COD; chu kỳ chuyển COD; bồi thường mất hàng ⇒ **Pha 0 + hợp đồng GHN** |

## 3. Kiến trúc
```
            ┌────────────────────────── module shipping (mới) ───────────────────────────┐
Checkout ──▶│ ShippingQuoteService: lấy báo giá MỌI hãng bật + hạn giao dự kiến (cache, khoá quoteId)│
Shop ──────▶│ ShipmentService: tạo/huỷ vận đơn, in AWB, hẹn lấy hàng (pickup) hoặc mang ra bưu cục   │
Hãng ──────▶│ Webhook adapter (GHN…) ─▶ khử trùng ─▶ ShipmentEvent ─▶ máy trạng thái vận đơn         │
            │ Job: dò track bù webhook · đo lại cân nặng · quá hạn lấy hàng · hàng đợi ngoại lệ   │
            │ CarrierGateway { quote, create, cancel, track, label } ◀─ GhnCarrier · FakeCarrier   │
            └───────────────────────────────┬────────────────────────────────────────────────────┘
                                             ▼ (sự kiện outbox)
               order: picked/shipping/delivered/delivery_failed/returned  ·  payment: COD thu/chuyển về  ·  promotion: freeship
```
- Quan hệ: 1 đơn con (đơn của một shop) = 1 vận đơn sống (có thể >1 kiện — pha sau); đơn giao lại = vận đơn mới, vận đơn cũ đóng.
- Cấu hình: `EF_GHN_*` (base URL, token, shop id, khoá webhook); setting: hãng nào bật, hãng mặc định, ca lấy hàng, ngưỡng, hạn chót (`shipping.*`).

## 4. Phí vận chuyển — theo cách sàn lớn làm
**Lúc checkout (khách thấy):**
1. Khách chọn/nhập địa chỉ (chuẩn hoá tỉnh/phường + **mã hãng** qua bảng đổi `shipping.address_codes`, kiểm "hãng có giao tới đó không", báo vùng xa).
2. Với mỗi shop: gom cân nặng/kích thước các dòng (sản phẩm bắt buộc có cân nặng + kích thước; thiếu thì dùng mặc định theo ngành, shop được nhắc bổ sung) ⇒ gọi hãng ⇒ danh sách lựa chọn **"Nhanh / Tiết kiệm"** (hãng + dịch vụ), mỗi cái có phí và ngày giao dự kiến.
3. **Hạ tầng trợ giá (chương trình freeship):** tách "phí gốc" − "giảm phí ship": (i) *trợ giá của sàn* (chương trình Freeship theo ngưỡng đơn/ngành, quỹ sàn), (ii) *voucher freeship của shop* (shop chịu), (iii) *voucher vận chuyển của sàn* (sàn chịu). Engine khuyến mãi hiện có đã có `platform_shipping_discount` / `shop_shipping_discount` — mở rộng để voucher tính trên **phí GHN thật**, không vượt phí.
4. Phí khoá bằng `quoteId` (hiệu lực ~10 phút) cùng `expectedTotal`; đổi giá lúc đặt ⇒ dùng lại hộp thoại 409 hiện có. GHN lỗi ⇒ dùng bảng phí theo tỉnh làm **dự phòng có gắn nhãn "phí ước tính"**.
5. Người mua **chỉ trả phần còn lại sau trợ giá**; không bao giờ thấy phí âm.

**Quyết toán với shop (sao kê từng đơn — như "Thu nhập đơn hàng" của Shopee):**
```
Tiền hàng khách trả
 − hoa hồng sàn  − phí giao dịch (nếu có)
 − [phí vận chuyển thực tế hãng tính]  + [phí vận chuyển khách đã trả]
 − [phần voucher freeship do shop chịu]
 ± [điều chỉnh đo lại cân nặng / vùng xa]
 − [phí giao thất bại / hoàn hàng nếu lỗi thuộc shop]
= Tiền shop nhận
```
Nguyên tắc: **chênh lệch phí vận chuyển mặc định do sàn chịu trong giới hạn** (`shipping.absorb_max`), vượt giới hạn (do shop khai sai cân nặng) thì trừ shop — đây là cách sàn lớn chống khai thiếu cân nặng.

## 5. Quy trình của shop ("Chuẩn bị hàng", không cập nhật giao hàng)
`Chờ xác nhận → Đã xác nhận → **Chuẩn bị hàng** (chọn: hãng đến lấy / mang ra bưu cục, ca lấy) → Đã tạo vận đơn (in AWB, in phiếu đóng gói hàng loạt) → Chờ hãng lấy → Đang giao …`
- Hạn **ship-by** của shop (vd 2 ngày làm việc từ lúc xác nhận — cấu hình); quá hạn ⇒ điểm vi phạm/tự huỷ (cơ chế SLA hiện có).
- **Hãng không đến lấy** quá N giờ ⇒ cảnh báo shop + vận hành (không phạt shop) và tự đặt lại lịch.
- **Xử lý hàng loạt:** chọn nhiều đơn → tạo vận đơn + in AWB một lần (shop đông đơn cần).
- Shop **bỏ** nút Đang giao / Đã giao / Giao thất bại / Hàng về kho cho đơn đi hãng. Còn: huỷ (khi chưa lấy), in lại, báo hãng đổi địa chỉ lấy.

## 6. Trạng thái & ngoại lệ (map GHN → sàn)
| GHN | Đơn của sàn | Ghi chú |
|---|---|---|
| ready_to_pick, picking | Chờ lấy hàng | SLA lấy hàng |
| picked, storing, sorting, transporting | **Đang giao** | dòng thời gian cho khách |
| delivering | Đang giao (giao hôm nay) | |
| delivered | **Đã giao** | bắt đầu đếm thời hạn đổi trả/escrow; ảnh `PodURL` lưu làm bằng chứng |
| delivery_fail (+ReasonCode) | Giao thất bại lần n | sàn lớn: **tối đa ~3 lần giao**, nhắn khách; hết lần ⇒ hoàn hàng |
| waiting_to_return, returning, return_* | Đang hoàn về shop | |
| returned | **Hoàn về shop** | nhập lại kho; hoàn tiền khách nếu đã trả |
| cancel | Vận đơn bị huỷ | cho tạo lại hoặc huỷ đơn |
| lost / damage | **Hàng đợi ngoại lệ** (CSKH) | sàn **đền khách trước**, sau đó khiếu nại hãng; không treo tiền khách |
| exception, scrap | Hàng đợi ngoại lệ | xử lý tay |
- **Xác minh trước khi tin webhook:** webhook không có chữ ký ⇒ với `delivered`/`lost`/`returned` luôn gọi `track` đối chiếu rồi mới ghi (chống giả mạo), khử trùng theo `OrderCode+Type+Time`, bỏ qua sự kiện **đến muộn/ngược thứ tự** (máy trạng thái chỉ đi tới).
- **Người mua tự xác nhận "đã nhận"** (đã có) rút ngắn escrow; không xác nhận thì **tự hoàn tất sau N ngày** từ `delivered`.
- **Mất webhook:** job dò `track` các vận đơn lâu không có sự kiện.

## 7. Dòng tiền (mọi tiền về sàn trước)
- **Online (PayOS):** như hiện nay. **COD:** hãng thu tiền mặt ⇒ **chuyển về TK sàn** (webhook `cod` + đối chiếu sao kê). Shop không giữ tiền ⇒ **bỏ mô hình ví cọc COD cho đơn đi hãng** (PLAN-0020 chỉ còn cho shop tự giao, nếu giữ).
- Trạng thái tiền COD của đơn: `chờ thu` → `hãng đã thu` (delivered) → **`hãng đã chuyển về sàn`** (webhook `cod` + khớp sao kê) → đủ điều kiện chi cho shop (sau hạn đổi trả, như PayOS). Chưa về ⇒ **không chi**; quá hạn không về (N ngày) ⇒ hàng đợi kế toán "COD chưa về" kèm danh sách theo hãng.
- **Đối soát hãng ↔ sàn theo lô:** mỗi lần hãng chuyển một khoản gộp nhiều đơn; sàn nhập sao kê/khớp theo mã vận đơn, báo **lệch** (thiếu/thừa/phí). Đây là phiên bản của "bảng đối soát COD" mà sàn lớn có.
- **Hoàn tiền đơn COD đã giao** (khách trả hàng): tiền đang ở sàn ⇒ sàn hoàn như PayOS — **xoá được lỗ hổng "COD không tự chi hoàn"** hiện tại.
- **Giao thất bại / từ chối nhận (COD):** hãng không thu ⇒ không phát sinh tiền hàng; chỉ có **phí hoàn** (xem §8 chính sách).
- Sổ riêng "tiền vận chuyển": phí báo giá, phí hãng thực tính, chênh lệch, đo lại, theo hãng & theo kỳ ⇒ kế toán thấy sàn đang lãi/lỗ vận chuyển bao nhiêu.

## 8. Chính sách cần chốt (mặc định giống sàn lớn, **cấu hình được**)
| Tình huống | Ai chịu phí (mặc định đề xuất) |
|---|---|
| Khách từ chối nhận / không nghe máy sau n lần giao | **Khách/sàn** (sàn chịu phí hoàn trong chương trình "bảo vệ shop"; khách bị tính điểm tín nhiệm COD, vi phạm nhiều ⇒ khoá COD) |
| Shop gửi sai hàng/khai sai cân nặng/địa chỉ lấy sai | **Shop** (trừ ở kỳ chi) |
| Hãng làm mất/hư | **Sàn đền khách, khiếu nại hãng** |
| Shop huỷ sau khi đã gọi hãng | **Shop** (phí huỷ nếu có) |
| Đổi trả vì lỗi shop / vì khách đổi ý | theo luật đổi trả hiện có; hãng lấy hàng trả do **sàn đặt**, phí theo bên chịu lỗi (pha 3) |
- **Rủi ro COD khách** (kiểu Shopee): hạn mức COD theo lịch sử khách, khoá COD với khách có tỉ lệ giao thất bại cao, giới hạn 5.000.000đ do GHN.
- **Đo lại cân nặng:** hãng báo `update_weight` ⇒ phí đổi ⇒ ghi điều chỉnh vào kỳ chi của shop + thông báo shop; shop thấy cân nặng "đã khai" vs "hãng đo" để tự sửa dữ liệu sản phẩm.

## 9. Dữ liệu (chỉ THÊM)
`shipping.carriers` (hãng bật, cấu hình, mức ưu tiên) · `shipping.shipments` (đơn ↔ vận đơn, quote_fee, actual_fee, cod_amount, trạng thái thô + đã map, lần giao, POD, ca lấy hàng) · `shipping.shipment_events` (khử trùng UNIQUE(carrier_order_code,type,event_time)) · `shipping.address_codes` · `shipping.cod_remittances` (+ dòng theo mã vận đơn: lô chuyển tiền, ngày, số tiền, trạng thái khớp sao kê) · `shipping.exceptions` (hàng đợi ngoại lệ) · sản phẩm/biến thể: cân nặng + kích thước · shop: địa chỉ kho có cấu trúc + mã hãng · đơn: `quote_id`, `shipping_fee_quoted`, `shipping_discount_*`.

## 10. Lộ trình
| Pha | Nội dung | Kiểm thử |
|---|---|---|
| 0 | Khảo sát Staging thật (token/ShopId của bạn): fee/create/cancel/track/in nhãn, **địa chỉ 2 cấp mới**, cách trừ phí COD, hỏi GHN giả lập trạng thái | script probe, không commit khoá |
| 1 | `shipping` + `CarrierGateway` + `FakeCarrier`; cân nặng/kích thước; địa chỉ kho shop + bảng mã địa chỉ; **báo giá ở checkout** (nhiều lựa chọn, voucher freeship, dự phòng) | jest + harness Postgres thật |
| 2 | "Chuẩn bị hàng" + tạo vận đơn + AWB + webhook/xác minh/dò track + máy trạng thái + bỏ nút giao hàng của shop + SLA lấy hàng | harness: mọi trạng thái, trùng/mất/ngược thứ tự webhook, đồng thời |
| 3 | **Tiền:** COD về sàn, đối soát lô, sao kê đơn (phí/chênh lệch/đo lại), chi trả, hoàn đơn COD, bỏ ví cọc cho đơn đi hãng | harness tiền + bất biến (Σ sàn giữ = Σ phải chi + hoa hồng + phí) |
| 4 | Ngoại lệ & vận hành: hàng đợi, đền khách/khiếu nại hãng, điểm tín nhiệm COD, báo cáo hiệu quả hãng | |
| 5 | UI đủ 3 phía (checkout chọn hãng, shop in AWB hàng loạt, sàn đối soát/ngoại lệ, khách theo dõi) + chạy Staging thật end-to-end | trình duyệt đủ vai |
| 6 | Đổi trả có hãng lấy hàng · nhiều hãng (GHTK/J&T) · nhiều kiện/đơn · giao nhận tại điểm (locker) | |
- **Cờ `shipping.enabled` (theo shop hoặc toàn sàn)**: tắt ⇒ luồng cũ nguyên vẹn; bật dần từng shop thử nghiệm.

## 11. Câu hỏi cần bạn quyết
1. Mô hình **chênh lệch phí ship**: sàn chịu trong ngưỡng (đề xuất) hay shop chịu hết?
2. **Chương trình freeship** của sàn: có không, ngưỡng đơn bao nhiêu, quỹ sàn chịu tối đa bao nhiêu/đơn?
3. Khách có **chọn hãng/tốc độ** ngay từ đầu, hay pha 1 chỉ GHN một lựa chọn rồi mở rộng sau?
4. **Giao thất bại do khách**: sàn chịu phí hoàn (đề xuất, kèm điểm tín nhiệm COD) hay trừ shop?
5. **Số lần giao tối đa** và thời gian chờ lấy hàng/giao (mặc định gợi ý: shop chuẩn bị ≤ 2 ngày; giao tối đa 3 lần).
6. Bỏ hẳn **ví cọc COD** cho đơn đi hãng? Có còn cho shop **tự giao** không?
7. Cần **Token + ShopId Staging** để làm Pha 0 và hỏi GHN về giả lập trạng thái / chu kỳ chuyển COD / cách trừ phí.

## 12. Quyết định đã chốt (2026-11-05) — theo đề xuất
1) Chênh lệch phí ship do sàn chịu trong ngưỡng `shipping.absorb_max`, vượt (shop khai sai cân nặng) trừ shop · 2) có chương trình freeship của sàn theo ngưỡng đơn, trần quỹ sàn mỗi đơn cấu hình · 3) pha 1 chỉ GHN (một lựa chọn), kiến trúc sẵn cho nhiều hãng · 4) giao thất bại do khách: sàn chịu phí hoàn + điểm tín nhiệm COD · 5) shop chuẩn bị ≤ 2 ngày, giao tối đa 3 lần · 6) bỏ ví cọc COD cho đơn đi hãng, shop tự giao giữ luồng cũ theo cờ · 7) Token/ShopId Staging chủ dự án cung cấp cho Pha 0.

## 13. Bug / trường hợp biên DỰ KIẾN (mỗi dòng ⇒ một kịch bản `SHP-C*` trong harness; chưa phải bug đã xảy ra)
**A. Webhook & trạng thái**
| # | Tình huống | Hậu quả nếu bỏ sót | Cách chặn |
|---|---|---|---|
| A1 | Webhook về TRƯỚC khi ta lưu được mã vận đơn (create vừa trả về) | sự kiện mồ côi, đơn kẹt | lưu `client_order_code` trước khi gọi hãng; webhook tra theo `ClientOrderCode`; không thấy ⇒ xếp hàng chờ ngắn rồi xử lý lại |
| A2 | Trùng / ngược thứ tự / đến muộn (delivered rồi mới picked) | lùi trạng thái, tính hoa hồng hai lần | UNIQUE sự kiện; máy trạng thái chỉ tiến; sự kiện cũ chỉ ghi nhận |
| A3 | Hai webhook ∥ khách huỷ ∥ job SLA cùng đơn | deadlock, đơn vừa huỷ vừa giao | mở rộng thứ tự khoá ĐƠN → VẬN ĐƠN → PAYMENT → ví; `retryOnDeadlock`; đo deadlock ở harness |
| A4 | Webhook GIẢ (không có chữ ký) báo delivered | shop nhận tiền cho đơn chưa giao | header bí mật + gọi `track` đối chiếu trước khi ghi delivered/returned/lost |
| A5 | Mất webhook | đơn "đang giao" vĩnh viễn, escrow không chạy | job dò `track` theo tuổi sự kiện; cảnh báo vượt hạn giao |
| A6 | Hãng sửa trạng thái (delivered → returned / delivery_fail sau delivered) | tiền đã tính cho shop | cho phép chuyển ngược có kiểm soát + hàng đợi ngoại lệ; chưa chi thì giữ lại |
| A7 | Cấu hình webhook trễ ~15 phút, hoặc endpoint sập quá lịch retry | thiếu sự kiện | job dò + màn "đồng bộ lại vận đơn" cho CSKH |
**B. Tạo / huỷ vận đơn**
| B1 | GHN timeout nhưng ĐÃ tạo đơn; shop bấm lại | 2 vận đơn, 2 lần thu COD | `client_order_code` = mã đơn (GHN trả lại đơn cũ); nút khoá khi đang tạo; UNIQUE 1 vận đơn sống/đơn |
| B2 | Tạo xong nhưng ghi DB lỗi | vận đơn mồ côi ở GHN | ghi `creating` trước; job đối chiếu dọn mồ côi |
| B3 | Địa chỉ không ánh xạ được mã GHN / hãng không phục vụ / vùng xa | không tạo được đơn đã bán | kiểm lúc checkout; chặn đặt nếu không giao được; báo CSKH nếu địa chỉ sửa sau đó |
| B4 | Cân nặng 0 / >50kg / kích thước >200cm / nhiều kiện | GHN từ chối | giá trị mặc định + chặn đặt vượt giới hạn; tách kiện ở pha 6 |
| B5 | COD > 5.000.000đ (kể cả sau đổi voucher/địa chỉ) | GHN từ chối | chặn COD ở checkout theo tổng cuối; `updateCOD` khi tổng đổi |
| B6 | Khách đổi địa chỉ / huỷ khi hãng đã đi lấy | hàng đi sai chỗ, huỷ API thất bại | chỉ cho đổi/huỷ khi `ready_to_pick`; sau đó ⇒ yêu cầu hoàn hàng; xử lý race huỷ ∥ picked bằng khoá |
| B7 | Hãng không đến lấy | đơn kẹt, shop bị phạt oan | SLA lấy hàng tách khỏi SLA shop; tự đặt lại lịch; không phạt shop |
**C. Phí**
| C1 | Phí GHN thực ≠ báo giá (đo lại cân, vùng xa, đổi dịch vụ) | sàn lỗ dần | sổ chênh lệch theo hãng/kỳ; ngưỡng `absorb_max`; điều chỉnh vào kỳ chi |
| C2 | Báo giá hết hạn / GHN down lúc checkout | chặn bán hoặc giá sai | bảng phí tỉnh dự phòng nhãn "ước tính"; tạo vận đơn sau vẫn theo GHN ⇒ chênh lệch vào C1 |
| C3 | Voucher freeship > phí thật / phí âm / làm tròn | số liệu âm, hai bên lệch 1đ | giảm ≤ phí; tiền VND nguyên; test biên |
| C4 | Điều chỉnh phí âm SAU khi kỳ chi đã chi | shop nợ, đòi lại khó | nợ mang sang kỳ sau (cơ chế sẵn có); không chi trước hạn điều chỉnh |
| C5 | Hãng chọn lúc checkout hết ca → hãng khác, phí khác | khách thấy A trả B | khoá phí A với khách, chênh vào C1 |
**D. Tiền COD**
| D1 | GHN chuyển gộp nhiều đơn, lệch số / trễ / mất webhook `cod` | đối soát lệch, chi nhầm | khớp theo mã vận đơn từng đơn; lô lệch ⇒ hàng đợi kế toán; không chi khi chưa khớp |
| D2 | COD thu rồi khách trả hàng ngay | hoàn tiền khi tiền chưa về | chỉ hoàn sau khi COD về hoặc ghi công nợ; chính sách chờ |
| D3 | Phí GHN trừ vào COD ⇒ số về < kỳ vọng | báo lệch giả | mô hình số kỳ vọng = COD − phí (xác nhận ở Pha 0) |
| D4 | Hãng chậm chuyển/ngừng hoạt động | tiền shop treo, sàn mất vốn | hạn N ngày + cảnh báo + theo dõi dư nợ theo hãng; điều khoản hợp đồng |
| D5 | Delivered nhưng khách khai "chưa nhận" | tranh chấp | dùng `PodURL`, tên shipper, tài xế; đưa CSKH, không tự hoàn |
| D6 | Giao thất bại nhiều lần rồi khách đòi giao lại | vòng đời kéo dài | vận đơn mới, đóng vận đơn cũ, số lần giao cộng dồn theo đơn |
**E. Chính sách / gian lận**
| E1 | Khách bị phạt điểm COD oan do lỗi shipper | mất khách | kháng cáo + xem lý do `ReasonCode`; chỉ phạt lý do thuộc khách |
| E2 | Shop khai nhẹ cân để trả phí thấp | chênh lệch lặp lại | so sánh khai vs hãng đo; tự điều chỉnh cân nặng gợi ý; phạt vượt ngưỡng |
| E3 | Hãng từ chối bồi thường mất/hư sau khi sàn đã đền khách | sàn lỗ | sổ khiếu nại hãng, theo dõi tỉ lệ thua |
| E4 | Hàng hoàn về hư/thiếu; shop từ chối nhận | tồn kho nhập sai | shop xác nhận tình trạng hàng hoàn, tranh chấp qua CSKH, chỉ nhập kho khi xác nhận |
**F. Chuyển đổi & tích hợp hệ thống cũ**
| F1 | Đơn đang chạy luồng cũ khi bật cờ | trộn hai luồng | cờ theo ĐƠN lúc tạo, không đổi giữa chừng |
| F2 | Shop tự giao song song: bấm GHN lẫn tự đánh dấu giao | hai nguồn sự thật | khoá: đơn đã có vận đơn thì ẩn nút tự giao; ngược lại ẩn "Giao cho GHN" |
| F3 | SLA/điểm vi phạm/auto-complete/escrow đang dựa `shipped_at/delivered_at` do shop khai | sai mốc | map từ sự kiện hãng; test lại SLA, auto-complete, hoa hồng, đổi trả |
| F4 | Ví cọc COD của shop đang âm/dư khi chuyển sang mô hình mới | số dư mồ côi | không động ví; chỉ đơn mới theo mô hình mới; quyết xử lý số dư sau |
| F5 | Dữ liệu cũ thiếu cân nặng/địa chỉ kho | không gọi được GHN | chặn "Chuẩn bị hàng" đến khi đủ, nhắc theo lô |
| F6 | Mã tỉnh/phường GHN thay đổi (sáp nhập 2025 và sau này) | phí/đơn sai | bảng đổi có hạn dùng, đồng bộ định kỳ, test địa chỉ hai cấp |

**Điều tôi chưa biết (rủi ro thật cao nhất, phải thử Pha 0):** cách GHN trừ phí khi có COD, chu kỳ và định dạng chuyển COD, API tính phí với địa chỉ hai cấp mới, có công cụ giả lập trạng thái hay không, chính sách bồi thường. Sai một điều trong số này sẽ làm lệch cả mô hình tiền ở §7.

## 14. PHẠM VI ĐỒ ÁN HỌC TẬP (thay thế lộ trình §10 — làm theo mục này)
Mục tiêu: **chạy được trọn luồng end-to-end trên GHN Staging + demo được**, giữ đúng tư duy của sàn lớn nhưng cắt phần chỉ cần khi có tiền thật/quy mô lớn.
**LÀM:** (1) báo giá phí GHN ở checkout + voucher freeship (một hãng GHN, một lựa chọn) · (2) shop bấm "Giao cho GHN" tạo vận đơn + in nhãn (API in nhãn GHN) + huỷ vận đơn · (3) webhook GHN + job dò `track` → tự cập nhật trạng thái; shop không còn nút giao hàng · (4) giao thất bại / hoàn hàng / hàng về → map trạng thái đã có · (5) tiền COD: **đơn giản hoá** (xem dưới) · (6) **Bảng điều khiển giả lập (demo)** để đổi trạng thái đơn khi Staging không có công cụ · (7) kịch bản test + tài liệu thiết kế/slide.
**KHÔNG LÀM (ghi vào báo cáo là "hướng phát triển"):** nhiều hãng/khách chọn hãng · đối soát COD theo lô + sao kê ngân hàng · điểm tín nhiệm/khoá COD · khiếu nại & đền bù hãng · đo lại cân nặng/điều chỉnh kỳ chi · nhiều kiện/đơn · đổi trả có hãng lấy hàng · tối ưu vùng xa · in hàng loạt.
**Đơn giản hoá tiền COD:** GHN `delivered` ⇒ COD tính là "tiền sàn giữ" (coi như hãng đã nộp; ghi chú rõ đây là mô phỏng vì Staging không chuyển tiền thật) ⇒ vào kỳ chi trả như PayOS sau hạn đổi trả. Thêm **một nút kế toán "Xác nhận đã nhận tiền COD từ hãng"** (tuỳ chọn, giữ ý tưởng đối soát) thay cho đối soát lô. Đơn đi GHN bỏ ví cọc; đơn shop tự giao giữ luồng cũ (cờ).
**Chênh lệch phí:** sàn chịu toàn bộ, chỉ ghi `quoted_fee`/`actual_fee` để báo cáo (không quyết toán vào shop).
**Giao thất bại:** tối đa 3 lần (theo GHN), hết ⇒ hoàn hàng; **sàn chịu phí hoàn** (không tính vào shop).
**Địa chỉ:** chọn MỘT mô hình (đề xuất 3 cấp cũ qua API master-data GHN, đủ cho Staging) và nói rõ trong báo cáo hạn chế với địa chỉ hai cấp mới.
**Giả lập:** `FakeCarrier` + trang quản trị "GHN giả lập" (chọn vận đơn → đẩy các trạng thái ready_to_pick … delivered / delivery_fail / returned / lost → gọi đúng đường webhook thật) để demo mọi nhánh trước hội đồng mà không phụ thuộc GHN.
**Giữ lại (rẻ mà đáng giá):** `client_order_code` chống tạo trùng · khử trùng webhook + máy trạng thái chỉ tiến · gọi `track` xác minh trước `delivered` · dự phòng bảng phí tỉnh khi GHN lỗi · cờ bật/tắt · harness kiểm các ca A1–A5, B1, B5, C3.
**Lộ trình rút gọn:** P0 thử Staging 1–2 buổi → P1 module + báo giá + dữ liệu (cân nặng/địa chỉ kho) → P2 vận đơn + webhook + UI shop + giả lập → P3 tiền COD đơn giản + màn kế toán + tài liệu. (~¼ khối lượng bản đầy đủ.)
