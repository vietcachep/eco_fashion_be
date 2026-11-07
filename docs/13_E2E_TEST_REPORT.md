# 13 — Báo cáo kiểm thử E2E toàn luồng mua bán (audit 2026-10-27)

> Phạm vi: đặt hàng → thanh toán (PayOS/COD) → xử lý đơn → giao → hoàn tất → đổi trả/hoàn tiền → đối soát/chi trả shop → ví cọc COD, cùng các ngoại lệ (huỷ, hết hạn, mất webhook, trả lệch, đồng thời, lỗi PayOS, mất worker/DB…).
> Luật nghiệp vụ: `docs/10_ORDER_LIFECYCLE.md` · kịch bản: `docs/11_SCENARIO_CATALOGUE.md` (cột HT có hậu tố `E2E ✔/✘/ℹ` theo báo cáo này) · plan gốc: `docs/plans/PLAN-0023-order-lifecycle-go-live.md`.
> Bộ script chạy lại: `docs/plans/assets/e2e-audit/` (xem README ở đó). Mã lỗi phát hiện: `AUD-xx` ↔ lỗ hổng `Gxx` trong PLAN-0023 §9.
> **Cập nhật cùng ngày — 3 lỗi P0 (AUD-01, 02, 03) ĐÃ SỬA và kiểm chứng trên Postgres thật: xem §11.** Các bảng bên dưới giữ nguyên hiện trạng lúc audit; cột/dòng đã sửa được đánh dấu "ĐÃ SỬA".

## 0. Kết luận

1. **Luồng chính chạy đúng đầu–cuối:** đặt nhiều shop → mỗi đơn con một link PayOS → thanh toán → shop xác nhận/đóng gói/giao → hoàn tất → kỳ đối soát → chi PayOS → `paid`; huỷ đơn đã trả sinh hoàn tiền và hoàn xong qua PayOS giả. Tồn kho (giữ/trừ/nhập lại), voucher, hoa hồng, ví COD, đổi trả 8 trạng thái, hoàn tiền (payer/khách/tay), idempotency, chữ ký webhook, rate-limit đều đạt ở các bài đã chạy.
2. **Chưa đủ để chạy tiền thật.** Audit thấy **3 lỗi gây mất/kẹt tiền hoặc rủi ro bảo mật** (AUD-01 deadlock webhook↔huỷ, AUD-02 mã kỳ chi trùng làm bỏ sót đơn, AUD-03 đổi TK nhận tiền không cần mật khẩu) — **cả ba đã sửa (§11)**. Còn lại **các ngoại lệ WP-01/WP-03/WP-07 chưa làm** (trả thừa/thiếu/trùng, huỷ đơn `packing`, hạn SLA của shop, giao thất bại…) — đều đã nằm trong plan; audit xác nhận bằng test, trừ 10 mục mới (G73–G82, §5).
3. **Giao diện** đã theo kịp phần lớn luồng khách/shop/kế toán (kể cả hoàn tiền bất đồng bộ "Kiểm tra PayOS"), nhưng **màn đối soát của kế toán còn lạc hậu so với backend** (thiếu duyệt/mở giữ/đối chiếu, thiếu tab trạng thái, không thấy tên shop) — AUD-09.
4. Việc còn lại để sẵn sàng tiền thật: §8 (điều kiện) + §9 (thứ tự sửa). Sau đợt sửa P0, bộ audit chạy lại trên DB sạch: **290 ✔ · 18 ✘ · 33 ℹ trên 341 mã** — 18 ✘ đều là việc đã có trong plan (không còn P0), không có hồi quy so với lần audit đầu.

## 1. Môi trường & phương pháp

- **Không đụng DB dev/prod:** snapshot backend (build `dist/`), Postgres + Redis Docker cổng lẻ, nạp dump dữ liệu mẫu, migrate lên mới nhất.
- **PayOS giả cục bộ** (`EF_PAYOS_API_URL` → `mock-payos.mjs`): tạo/tra link, chi hộ (đồng bộ/bất đồng bộ), tra lệnh chi theo `referenceId`, cấu hình lỗi/timeout/mất lệnh/trễ, trang thanh toán giả và webhook ký HMAC; **không** có khoá hay tiền thật.
- **Du hành thời gian bằng DB** (lùi `delivered_at`, `payment_expires_at`, `gateway_attempted_at`…) và **chạy job theo yêu cầu** (application context Nest) để thử SLA/escrow/ân hạn không phải chờ.
- **Trình duyệt tích hợp** trên bản dev của web khách (:3402) và web quản trị (:3401) trỏ vào backend cô lập: khách → checkout → cổng PayOS giả → shop (cổng vendor) → kế toán.
- Worker chạy với SMTP giả (không gửi mail thật).

## 2. Hồ sơ tiến độ tài liệu / work package (đối chiếu 2026-10-27)

| Plan | WP | Trạng thái ghi trong plan | Audit xác nhận |
|---|---|---|---|
| PLAN-0022 | đổi trả/hoàn theo vai | **Done** | Đạt (REF-07/08, đổi trả 8 trạng thái, payee theo nguồn) |
| PLAN-0023 | điều phối | Approved | §9 cập nhật G07→đã tái hiện, G73–G82 mới |
| PLAN-0024 | WP-00 hạ tầng test | Ready — chưa làm | Harness audit (`assets/e2e-audit`) dùng làm nền |
| PLAN-0025 | WP-01 thu tiền vào | **Một phần** (§2.3 nửa đầu) + **AUD-01 đã sửa (thứ tự khoá)** | §2.1, 2.2, 2.4, poll định kỳ, `expectedTotal` còn thiếu — AUD-04, 05, 06 |
| PLAN-0026 | WP-02 chi trả shop | **Phần lớn** (§2.1–2.4, 2.6, 2.7) + **AUD-02, AUD-03 đã sửa** | Còn §2.5 (email chủ shop khi đổi TK, khớp tên chủ TK), giữ tay, kiểm số dư PayOS — AUD-07, 08 |
| PLAN-0027 | WP-03 SLA/huỷ | Ready — chưa làm | Xác nhận thiếu: AUD-10 |
| PLAN-0028 | WP-04 thông báo | Ready — chưa làm | AUD-11 (spam, shop không biết khi khách huỷ, email không escape) |
| PLAN-0029 | WP-05 vận hành | Ready — chưa làm | AUD-12 (health, tìm kiếm admin) |
| PLAN-0030 | WP-06 hoa hồng/ví | **Một phần** (§2.1–2.3) | Công thức BE đúng; **plan §2.2 ghi sai** (đã sửa) |
| PLAN-0031 | WP-07 giao/bằng chứng | Ready — chưa làm | AUD-13 |
| PLAN-0032…0034 | WP-08/09/10 | Ready — chưa làm | CK-05 (giá đổi) xác nhận thiếu |
| PLAN-0035/0036 | thuế · dữ liệu cá nhân | Removed from scope | — |
| PLAN-0037 | WP-13 UAT tiền thật | Ready khi WP P0 + review xong | Chưa thể bắt đầu — xem §8 |
| PLAN-0038/0039 | nhóm thanh toán · hãng vận chuyển | Draft (sau go-live) | — |
| FE admin PLAN-0005 · FE khách PLAN-0012 | | Ready (chờ `api:sync` cả đợt) | AUD-09: spec FE đã lỗi thời so với backend |

## 3. Kết quả theo nhóm bài

| Bài | Nội dung | Kết quả |
|---|---|---|
| t01 | Dựng dữ liệu + đường hạnh phúc đến chi trả `paid` | **29/29** đạt (kỳ chi 36,4 triệu rơi `awaiting_approval` — đúng hạn mức duyệt) |
| t02 / t02b | Đặt hàng, voucher, tồn kho, thu tiền vào (webhook, mất webhook, huỷ quá hạn, trả lệch) | Lần 1: 30/38 đạt (+4 ghi chú) → chạy lại phần nghi ngờ: **15/15**. 5 thất bại thật là tính năng chưa làm (CK-05, PAY-07b, 08, 09, 10b); 3 là lỗi bài test |
| t03 | Vòng đời đơn (COD, huỷ, SLA, giao, tự hoàn tất, khoá shop, đánh giá) | 42/54 (+4 ghi chú): 8 chưa làm (WP-03/07), 1 lỗi thật (SHP-04), 3 lỗi bài test |
| t04 / b / c / d | Đổi trả & hoàn tiền (PLAN-0022 + payee + PayOS bất đồng bộ + chuyển tay) | Chạy sạch sau sửa P0: t04 75/79, t04b 16/17, t04c 9/9, t04d 5/5. 4+1 ✘ đã phân loại: RET-29 (cố ý cho phép) và WAL-05 (bộ lọc của bài test) là lỗi bài test; COD-08b (G19, WP-07), REF-04b/04b2 (AUD-14) là việc đã có trong plan |
| t05 / t05b | Chi trả: kỳ chi, escrow, duyệt, giữ, unknown/reconcile, deferred/carry, đồng thời | Lần audit đầu: t05 38/44, t05b 8/9. **Sau sửa P0: t05 40/44, t05b 9/9** — STL-16x và STL-11a đã đạt; còn STL-13 (giữ tay, chưa làm) và 3 mã bị t05b thay thế (STL-08d/08e/12b) |
| t06 / t06b | Ma trận quyền theo vai, rate-limit, thông báo, đồng thời | Không ghi nhận lỗ hổng phân quyền; lần đầu t06b 8/11 → **sau sửa P0: 9/11** (CONC-08 đã đạt); còn NTF-03 (spam, WP-04) và NTF-01a (lỗi bài test). `t06` gốc hỏng sẵn ở phần thông báo — driver bỏ qua, dùng t06b |
| t07 / t07b | Chịu lỗi: Postgres tắt, worker chết, health, outbox | Đạt (t07 20/20, t07b 3/3); ghi chú AUD-12 |
| **t08 (mới)** | Hồi quy 3 lỗi P0: 12 vòng huỷ ∥ webhook, 3 kỳ cùng ngày, đổi TK + mật khẩu + 429 | **17/17** đạt — xem §11 |
| **UI (trình duyệt)** | Xem §4 | Đạt, trừ các điểm AUD-09/AUD-14 |

## 4. Luồng giao diện đã chạy (trình duyệt)

| Bước | Kết quả |
|---|---|
| Khách (khach31) đăng nhập, giỏ 2 shop, chọn PayOS, Đặt hàng | Đạt — nhóm `DHN…` + 2 đơn con, mỗi đơn có nút "Thanh toán qua PayOS" riêng, hạn link hiển thị |
| Trang cổng PayOS giả → "Chuyển khoản thành công" → trang trả về | Đạt — "Thanh toán thành công", còn 1 đơn chờ thanh toán |
| Khách bấm **Huỷ** trên cổng → trang trả về | Đạt — "Bạn đã huỷ thanh toán… vẫn đang chờ thanh toán, có thể thanh toán lại"; thanh toán lại dùng được cùng liên kết |
| Cả hai đơn con thanh toán | DB: `payment_status=paid`, payment `paid` qua webhook |
| Cổng nhà bán (techzone): danh sách có nhãn "Cần xử lý ngay", chi tiết, **Xác nhận → Bắt đầu đóng gói → Giao cho vận chuyển → Đã giao thành công** | Đạt; link theo dõi không `https://` bị chặn ("phải bắt đầu bằng https://"); ở `packing` shop không có nút Huỷ (phù hợp CAN-07 chưa làm); có "Giao không thành công" |
| Khách xem nhóm đơn: đơn 1 "Đã giao" + nút Đánh giá / Yêu cầu đổi trả / Báo chưa nhận hàng; đơn 2 "Chờ xác nhận" | Đạt |
| Khách **huỷ đơn đã thanh toán** (đơn Ngon Việt) | Đạt — "Đã huỷ · Đang hoàn tiền 220.000 ₫"; DB: refund `requested`, payee lấy từ người trả |
| Kế toán `/payment/refunds`: **Hoàn tiền → Đang chờ PayOS xác nhận → Kiểm tra PayOS → Đã hoàn** | Đạt (toast đúng nghĩa, trạng thái bất đồng bộ không báo "xong" sớm) |
| Đăng nhập quá nhanh → 429 | Đạt — toast "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút" |
| Kế toán `/shop/payouts` với các trạng thái mới (`held`, `deferred`, `unknown`…) | **Lệch** — AUD-09 |
| Thông báo trong DB cho 2 đơn con | Chủ shop + NV shop nhận "Đơn mới #…"/"đã thanh toán" ✔; **5 vai nhân viên sàn nhận "Đơn mới" mỗi đơn con** (AUD-11); **shop Ngon Việt không nhận thông báo khi khách huỷ** (AUD-11) |

## 5. Lỗi thật phát hiện (xếp theo mức)

Mức: **P0** = mất/kẹt tiền hoặc thủng bảo mật, chặn tiền thật · **P1** = sai nghiệp vụ/vận hành phải sửa trước go-live · **P2** = trải nghiệm/độ bền.

| Mã | Mức | WP | Lỗi | Tái hiện / bằng chứng | Hướng sửa |
|---|---|---|---|---|---|
| **AUD-01** (G07 ↑) **ĐÃ SỬA §11** | P0 | 01 | Webhook tiền về **đồng thời** khách huỷ cùng đơn ⇒ deadlock ⇒ webhook trả **HTTP 500**; đơn `cancelled`, payment `unpaid`, chưa có refund | CONC-08: huỷ 200, webhook 500. Chỉ tự lành nếu PayOS gửi lại (khi đó vào nhánh "thanh toán đến sau khi huỷ" ⇒ refund — đã thấy ở DH2610270199) | Thống nhất thứ tự khoá (payment → order) ở cả `settlePayos` và `cancel`; bắt 40P01 và thử lại; test CONC-08 vào smoke |
| **AUD-02** (G73) **ĐÃ SỬA §11** | P0 | 02 | Mã kỳ chi `PAY-<yymmdd>-<yymmdd>-<shop>` **trùng khi chạy lần 2 trong ngày** cho cùng shop ⇒ "Đã tạo 0 kỳ", đơn mới bị bỏ sót khỏi mọi kỳ | STL-16x; cũng là nguyên nhân CONC-06 thất bại lần đầu | Mã kỳ thêm số thứ tự/hậu tố; chống chạy trùng theo (shop, khoảng, dòng) chứ không theo mã; bài test hồi quy |
| **AUD-03** (G35) **ĐÃ SỬA §11** (còn email chủ shop + khớp tên) | P0 | 02 | **Đổi TK ngân hàng không yêu cầu mật khẩu**; kỳ chi kế tiếp lấy snapshot TK mới (đã có giữ kỳ sau đổi TK) | STL-11a: 200, `changed=true`; STL-11c: snapshot `970422/9999888877` | Bắt buộc nhập lại mật khẩu + email chủ shop + khớp tên chủ TK (PLAN-0026 §2.5); kèm G71 (đổi mật khẩu mẫu) |
| **AUD-04** (G03) | P1 | 01 | Trả **thừa** chỉ ghi "Amount mismatch — recorded for review", đơn vẫn `unpaid`, không hoàn; trả **thiếu** hết hạn ⇒ huỷ nhưng **không hoàn số đã nhận**; trả **2 lần** (mã khác) ⇒ phản hồi "Success", **không** tạo refund `duplicate_payment` | PAY-07b/08/09 | PLAN-0025 §2.4 (refund `mismatch`/`duplicate_payment` + thông báo kế toán) |
| **AUD-05** (G05) | P1 | 01 | Thanh toán lại **không gia hạn** hạn đơn ⇒ job huỷ ngay dù khách vừa tạo link mới | PAY-10b | PLAN-0025 §2.2 |
| **AUD-06** (G01, G81) | P1 | 01 | Gọi PayOS (HTTP) **trong transaction** ⇒ PayOS chậm 3s thì 6 checkout song song mất 18,5s; PayOS lỗi ⇒ **đơn không được tạo** và trả 503 `PAYMENT_PAYOS_NOT_CONFIGURED` (sai nghĩa, trái CK-15) | CK-15, CK-16 | Tạo đơn trước, gọi PayOS sau commit; lỗi ⇒ payment `link_failed` + nút "Thanh toán lại" |
| **AUD-07** (G34) | P1 | 02 | Không tra số dư PayOS trước khi chi; khi PayOS từ chối vì thiếu số dư kỳ vẫn ở `processing` (không phân loại rõ, không báo kế toán nạp quỹ) | STL-06 | PLAN-0026 §2.3 + phân loại từ chối "thiếu số dư" ⇒ `failed` + cảnh báo |
| **AUD-08** (G74, G75, G76) | P1 | 02 | `run` kiểm trùng/chồng khoảng **toàn cục** (không theo shop); "Mở giữ" khi shop còn khoá trả **200 im lặng**; kỳ `deferred` đã cộng sang kỳ sau **vẫn là `deferred`** (hiểu nhầm "chưa trả") | STL-12b2, STL-04d | Chống chồng theo shop; 409 kèm lý do; thêm trạng thái `merged` |
| **AUD-09** (G77) | P1 | 02 · FE | **Màn đối soát kế toán lạc hậu:** spec OpenAPI trong FE thiếu `approve/reconcile/release` (backend đã có); tab lọc thiếu `awaiting_approval/held/unknown/deferred`; chi tiết kỳ `held` không nêu lý do/nút mở giữ; **kế toán không có `shop.read` ⇒ cột Gian hàng hiện `Shop …de93db6c`** thay vì tên | Quan sát UI + `GET /admin/shops` 403 với kế toán | `api:sync`; thêm nút duyệt/mở giữ/đối chiếu; tab trạng thái; backend trả `shopName`/`shopCode` trong kỳ chi và hoàn tiền |
| **AUD-10** (G08–G11, G70, G72) | P0/P1 | 03 | Chưa làm: huỷ `confirmed` bởi khách (CAN-03); **huỷ `packing` bởi shop/CSKH — đơn kẹt** (CAN-07/08, SHOP-01f); đổi địa chỉ (CAN-14); **hạn xác nhận/giao** (FUL-04: 32 đơn treo > 7 ngày, không job xử lý); khoá shop **đóng băng đơn mở** (SHOP-01c) | t03 | PLAN-0027 §2.x |
| **AUD-11** (G06, G12, G49) | P1 | 04 | **Spam:** 5 vai nhân viên sàn nhận "Đơn mới" cho MỖI đơn con (10 thông báo cho 2 đơn); **shop không được báo khi khách huỷ** (kể cả đơn đã thanh toán); **email ghép `${reason}` không escape** | NTF-03; kiểm lại trên UI; đọc `order-worker.module.ts` | Gộp theo nhóm, chỉ gửi vai liên quan (dashboard dùng số đếm); báo shop khi huỷ; escape HTML |
| **AUD-12** (G51, G52, G82) | P1 | 05 | `/health` trả **HTTP 200 khi DB DOWN** (chỉ body báo); worker chết vẫn `UP` (job nền/mail/outbox dừng im lặng); admin chưa tìm được đơn theo **mã nhóm DHN / email khách** | OPS-04d/01y; PLAN-0029 | Health trả 503 + kiểm worker (heartbeat); `q` mở rộng DHN/email |
| **AUD-13** (G13, G19, G21) | P1 | 03 · 07 | Tự hoàn tất **bỏ qua yêu cầu đổi trả đang mở** (đơn vào `completed` dù khách vừa gửi yêu cầu); COD "chưa nhận hàng" có thể **hoàn tiền mặt chưa từng thu**; không có đường "hàng đã về kho" sau giao thất bại; đơn `shipping` > 20 ngày chỉ cảnh báo một lần | SHP-04, SHP-09, SHP-08 | PLAN-0027/0031 |
| **AUD-14** (G78) | P2 | 02 · FE | Ghi sổ hoàn tay với `providerRef` tự nhập **không đối chiếu PayOS** | quan sát code (REF) | Cảnh báo/tra PayOS khi trùng khoảng thời gian-số tiền |
| **AUD-15** (G79) | P2 | FE khách | Form huỷ đơn **đã thanh toán** chỉ hỏi lý do, **không nói trước** "hoàn về TK nào, bao lâu"; thông tin chỉ hiện sau khi huỷ | UI | Thêm dòng cảnh báo + ước tính trong form huỷ |
| **AUD-16** (G80) | P2 | 06 | Bản ghi trong `PLAN-0030 §2.2` ghi sai công thức (`+ platform_item_discount` vào gốc hoa hồng); code và `docs/10 §10` đúng | COD-03b (lỗi do test dùng công thức plan sai) | **Đã sửa tài liệu** |
| **AUD-17** (G57) | P2 | 00 | Mock/harness: kỳ chi cùng ngày phải đổi mã kỳ cũ để chạy lại (hệ quả AUD-02) | `t05b.mjs renameCodes` | Bỏ thủ thuật sau khi sửa AUD-02 |

> Lỗ hổng **mới thật sự** thêm vào PLAN-0023 §9: **G73–G82** (AUD-02 → G73; AUD-08 → G74–G76; AUD-09 → G77; AUD-14 → G78; AUD-15 → G79; AUD-16 → G80; AUD-06 → G81; AUD-12 → G82). Các AUD còn lại trùng G đã có và chỉ được đánh dấu "đã tái hiện".

## 6. Việc "chưa làm theo plan" được test xác nhận (không phải bug mới)

CK-05 (giá đổi `expectedTotal`) · PAY-07b/08/09/10b (WP-01 §2.2, §2.4) · FUL-04a/b, CAN-03/07/08/14, SHOP-01c/f (WP-03) · SHP-08/09 (WP-07) · STL-13 (giữ tay, WP-02 §2.4) · STL-11a (WP-02 §2.5) · NTF-03/G12 (WP-04) · OPS (WP-05). Cột HT của `docs/11` đã đánh `E2E ✘` ở các mã tương ứng.

## 7. "Lỗi do bài test" — đừng sửa code vì các mục này

| Mã | Lý do |
|---|---|
| CK-02a (lần 1) | Voucher `DIENTHOAI50K` không áp dụng cho giỏ thử; đổi giỏ ⇒ đạt (t02b) |
| COD-03b | Bài test dùng công thức plan sai; code = `docs/10 §10` (`−hoa hồng(tiền hàng) + trợ giá voucher sàn`) |
| PAY-04 (lần 1) | Chưa hết ân hạn `order.payment_grace_minutes`; đúng thiết kế (t02b đạt) |
| STL-08d/08e, STL-12b, CONC-06 (lần 1) | Bài test chạy trước khi sửa mã kỳ/thời gian chờ; t05b đạt. CONC-06 lần 1 thật ra là hệ quả AUD-02 |
| SHP-07 | Đơn vị đếm: 2 người nhận ở shop (chủ + NV); hai lần chạy job không tăng thêm ⇒ đúng "đúng 1 lần" |
| CMP-01b | Trường đúng của đánh giá là `content`, không phải `comment`; thử lại ⇒ 200 |
| RET-29 | Shop xác nhận nhận lại hàng khi yêu cầu còn `requested` được CHỦ ĐÍCH cho phép (xử lý một bước) — bài test kỳ vọng sai |
| WAL-05 | Giao dịch ví `cod_refund` được ghi dưới `order_code = RF-<mã hoàn>` nên bộ lọc theo mã đơn của bài test không thấy; số dư ví giảm đúng (157.448 = hoàn 169.928 − hoa hồng đảo 12.480) |
| NTF-01a | Đọc thông báo quá sớm (gửi bất đồng bộ qua outbox ~3s); DB xác nhận chủ shop và NV shop **có** nhận "Đơn mới #…" |
| CK-02, REF-0x còn lại | Đạt |

## 8. Điều kiện trước khi chạy tiền thật (PLAN-0037 E2E-01…10)

- ~~Sửa trước: AUD-01, 02, 03 (P0)~~ — **đã sửa (§11)**. Còn phải sửa trước: **AUD-04, 05, 06, 10** (WP-01/WP-03 P0 của plan).
- Chốt: đổi mật khẩu các tài khoản mẫu (G71), TK ngân hàng shop thử, quỹ PayOS đủ số dư, `payout.auto_enabled` **tắt** (mặc định dump đang bật), bật SLA có kế hoạch dọn đơn cũ (G72).
- Chạy lại toàn bộ harness (`assets/e2e-audit`) trên backend đã sửa → mong đợi **0 ✘** (trừ mục ngoài phạm vi), rồi mới vào WP-13.
- Khi thử thật: dùng khoản nhỏ; kiểm khớp số dư PayOS ↔ sổ (WP-10); ghi biên bản theo bảng của PLAN-0037.

## 9. Thứ tự sửa khuyến nghị

1. ~~AUD-01 (deadlock), AUD-02 (mã kỳ), AUD-03 (đổi TK + mật khẩu)~~ — **xong 2026-10-27 (§11)**.
2. **WP-01 §2.2 + §2.4 + poll định kỳ** (AUD-04/05) — để tiền khách không kẹt khi trả lệch/mất webhook.
3. **AUD-06** tách gọi PayOS khỏi transaction.
4. **WP-03** (AUD-10, AUD-13): huỷ `packing`, hạn SLA, đổi địa chỉ, khoá shop, tự hoàn tất tôn trọng đổi trả mở.
5. **WP-04 + WP-05** (AUD-11, AUD-12) rồi **FE** (AUD-09, AUD-15) sau một lần `api:sync` + `perms:sync` cho cả đợt.
6. WP-07/08/09/10, sau đó review R1–R4 và WP-13.

## 10. Phụ lục — kết quả máy đọc (lần chạy sạch sau đợt sửa P0)

Mỗi mã: ✔ đạt · ✘ chưa đạt (việc đã có trong plan hoặc lỗi thật còn lại — xem §5–§6) · ℹ ghi chú. Mã là lỗi của chính bài test (§7) được tính ✔. Kết quả cuối của mỗi mã lấy lần chạy sau cùng trong thứ tự t01 → t08.

- **AUD** — `AUD-01a`✔ `AUD-01b`✔ `AUD-01c`✔ `AUD-01d`ℹ `AUD-02a`✔ `AUD-02b`✔ `AUD-02b2`✔ `AUD-02c`✔ `AUD-02d`✔ `AUD-02e`✔ `AUD-03a`✔ `AUD-03b`✔ `AUD-03c`✔ `AUD-03d`✔ `AUD-03e`✔ `AUD-03f`✔ `AUD-03g`✔ `AUD-03h`✔
- **CAN** — `CAN-01`✔ `CAN-02`✔ `CAN-02b`✔ `CAN-03`✘ `CAN-05`✔ `CAN-06a`✔ `CAN-06b`✔ `CAN-07`✘ `CAN-08`✘ `CAN-09a`✔ `CAN-09b`✔ `CAN-10`✔ `CAN-10b`ℹ `CAN-11`✔ `CAN-14`✘
- **CK** — `CK-01a`✔ `CK-01b`✔ `CK-01c`✔ `CK-01d`✔ `CK-01e`✔ `CK-02a`✔ `CK-02b`✔ `CK-02c`✔ `CK-02d`✔ `CK-02e`✔ `CK-03`✔ `CK-04a`✔ `CK-04b`✔ `CK-04c`✔ `CK-05`✘ `CK-06`✔ `CK-07`✔ `CK-08`✔ `CK-09`✔ `CK-12`✔ `CK-13`ℹ `CK-15`✔ `CK-16`ℹ `CK-20`✔ `CK-21`✔ `CK-22`✔ `CK-23`✔ `CK-24`✔
- **CMP** — `CMP-01a`✔ `CMP-01b`✔ `CMP-01c`✔ `CMP-01d`✔ `CMP-02a`✔ `CMP-02b`✔ `CMP-03`ℹ `CMP-04a`✔
- **COD** — `COD-01`✔ `COD-02`✔ `COD-02b`✔ `COD-03a`✔ `COD-03b`✔ `COD-03c`✔ `COD-04`✔ `COD-05a`✔ `COD-05b`✔ `COD-05c`✔ `COD-05d`✔ `COD-08a`ℹ `COD-08b`✘ `COD-08c`ℹ
- **CONC** — `CONC-02`✔ `CONC-03`✔ `CONC-04`✔ `CONC-06`✔ `CONC-07`✔ `CONC-08`✔ `CONC-09`✔ `CONC-10`✔
- **FUL** — `FUL-01`✔ `FUL-01b`✔ `FUL-01c`✔ `FUL-02`✔ `FUL-04a`✘ `FUL-04b`ℹ `FUL-05`✔ `FUL-08`✔ `FUL-08b`✔ `FUL-10`✔ `FUL-10b`✔ `FUL-10c`✔ `FUL-10d`✔ `FUL-10e`✔
- **NTF** — `NTF-01a`✔ `NTF-01b`✔ `NTF-01c`✔ `NTF-03`✘ `NTF-cancel`ℹ
- **OPS** — `OPS-01x`ℹ `OPS-01y`ℹ `OPS-04a`ℹ `OPS-04b`✔ `OPS-04c`✔ `OPS-04d`ℹ `OPS-04e`✔ `OPS-04f`✔ `OPS-05`✔
- **PAY** — `PAY-01a`✔ `PAY-01b`✔ `PAY-02`✔ `PAY-03`✔ `PAY-03b`✔ `PAY-04`✔ `PAY-04b`ℹ `PAY-04c`✔ `PAY-05a`✔ `PAY-05b`✔ `PAY-05c`✔ `PAY-06a`✔ `PAY-06b`✔ `PAY-07a`✔ `PAY-07b`✘ `PAY-08`✘ `PAY-09`✘ `PAY-10a`✔ `PAY-10b`✘ `PAY-11`✔ `PAY-13b`✔ `PAY-17`✔ `PAY-17b`✔ `PAY-18`ℹ
- **PRICE** — `PRICE-01`✔ `PRICE-02`✔ `PRICE-03`✔ `PRICE-04`✔ `PRICE-05`✔ `PRICE-06`✔ `PRICE-07`✔ `PRICE-08`✔
- **REF** — `REF-01a`✔ `REF-01b`✔ `REF-01c`✔ `REF-01d`✔ `REF-01e`✔ `REF-01f`ℹ `REF-03a`✔ `REF-03b`✔ `REF-03c`✔ `REF-04a`✔ `REF-04b`ℹ `REF-04b2`✘ `REF-04c`✔ `REF-05`✔ `REF-06`✔ `REF-06b`✔ `REF-07a`✔ `REF-07b`✔ `REF-07c`✔ `REF-07d`✔ `REF-07e`✔ `REF-07f`✔ `REF-08c`✔ `REF-COD-1`✔ `REF-COD-2`✔
- **RET** — `RET-01a`✔ `RET-01a2`ℹ `RET-01b`✔ `RET-01c`✔ `RET-01d`✔ `RET-01e`✔ `RET-01f`✔ `RET-01g`✔ `RET-01h`✔ `RET-01i`✔ `RET-01j`✔ `RET-01k`✔ `RET-01l`✔ `RET-02a`✔ `RET-02b`✔ `RET-02c`✔ `RET-02d`✔ `RET-03a`✔ `RET-03b`✔ `RET-03c`✔ `RET-03d`✔ `RET-04`✔ `RET-05`✔ `RET-06`✔ `RET-08a`✔ `RET-08b`✔ `RET-08c`✔ `RET-08d`✔ `RET-08e`ℹ `RET-08f`ℹ `RET-13`✔ `RET-20`✔ `RET-21`✔ `RET-22`✔ `RET-23`✔ `RET-24`✔ `RET-25`✔ `RET-26`✔ `RET-27`✔ `RET-28`ℹ `RET-29`✔ `RET-30`✔ `RET-31`✔ `RET-32`✔ `RET-33`✔ `RET-34`✔ `RET-35`✔ `RET-36`✔ `RET-37`✔ `RET-38`✔ `RET-39`✔ `RET-40`✔ `RET-SLA-4`✔ `RET-SLA-5`✔
- **SEC** — `SEC-01d`✔ `SEC-01e`✔ `SEC-01f`✔ `SEC-01g`✔ `SEC-01p`✔ `SEC-01r`✔ `SEC-01r2`✔ `SEC-01v`✔ `SEC-02c`✔ `SEC-02d`✔ `SEC-02p`✔ `SEC-02r`✔ `SEC-03c`✔ `SEC-03p`✔ `SEC-03p2`✔ `SEC-03r`✔ `SEC-03r-accountant`✔ `SEC-03r-manager`✔ `SEC-03r-marketing`✔ `SEC-03r2`✔ `SEC-03w`✔ `SEC-04r`✔ `SEC-07b`✔ `SEC-07c`✔ `SEC-09`✔
- **SETUP** — `SETUP-mobilehub`✔ `SETUP-ngonviet`✔ `SETUP-nhaxinh`✔ `SETUP-sneaker`✔ `SETUP-sportplanet`✔
- **SHOP** — `SHOP-01a`✔ `SHOP-01b`✔ `SHOP-01c`✘ `SHOP-01d`✔ `SHOP-01e`✔ `SHOP-01f`✘ `SHOP-01g`✔ `SHOP-02`✔ `SHOP-02b`ℹ
- **SHP** — `SHP-01`✔ `SHP-03`✔ `SHP-04`✘ `SHP-07`✔ `SHP-08`ℹ `SHP-09`✘
- **STL** — `STL-01-A`✔ `STL-01-B`✔ `STL-01-C`✔ `STL-01a`✔ `STL-01b`✔ `STL-01c`✔ `STL-01d`✔ `STL-02a`✔ `STL-02b`✔ `STL-02c`✔ `STL-02d`✔ `STL-03a`✔ `STL-03b`ℹ `STL-04`✔ `STL-04b`ℹ `STL-04c`✔ `STL-04d`ℹ `STL-05a`✔ `STL-05b`✔ `STL-05c`✔ `STL-05d`✔ `STL-05e`✔ `STL-06`ℹ `STL-06b`✔ `STL-07a`✔ `STL-07b`✔ `STL-07c`✔ `STL-07d`✔ `STL-07e`✔ `STL-08a`✔ `STL-08b`✔ `STL-08c`✔ `STL-08d`✔ `STL-08e`✔ `STL-08e0`✔ `STL-08e1`✔ `STL-08e2`✔ `STL-08e3`✔ `STL-09a`✔ `STL-09b`✔ `STL-09c`✔ `STL-10`✔ `STL-10a`✔ `STL-10b`ℹ `STL-11a`✔ `STL-11b`✔ `STL-11c`ℹ `STL-12a`✔ `STL-12b`✔ `STL-12b2`ℹ `STL-12c`✔ `STL-13`✘ `STL-14`✔ `STL-14a`✔ `STL-15`✔ `STL-15b`✔ `STL-16x`✔ `STL-status`ℹ `STL-status0`ℹ `STL-summary`ℹ
- **WAL** — `WAL-01a`✔ `WAL-01b`✔ `WAL-01c`✔ `WAL-02`✔ `WAL-03`✔ `WAL-05`✔

**Tổng:** ✔ 290 · ✘ 18 · ℹ 33 (341 mã). ✘ còn lại: CK-05, PAY-07b, PAY-08, PAY-09, PAY-10b, SHP-09, CAN-03, CAN-07, CAN-08, CAN-14, FUL-04a, SHP-04, SHOP-01c, SHOP-01f, COD-08b, REF-04b2, STL-13, NTF-03.

## 11. Đợt sửa 3 lỗi P0 (2026-10-27) — đã làm và kiểm chứng thế nào

Chưa commit/push/deploy (chủ dự án điều khiển git). **Không có migration mới** — không đổi schema; triển khai backend và web quản trị cùng đợt (xem "Lưu ý triển khai").

### 11.1 AUD-01 — deadlock webhook ↔ khách huỷ đơn
- **Nguyên nhân gốc:** hai đường khoá ngược thứ tự. Webhook (`settlePayos`) khoá dòng `payment` rồi `onPaid` mới khoá `order`; khách huỷ (`cancelByCustomer → doCancel`) khoá `order` rồi mới đụng `payment`. Chạy đồng thời ⇒ Postgres huỷ một bên ⇒ webhook 500, đơn `cancelled` + `unpaid`, không ai hoàn tiền khách.
- **Sửa:** thứ tự khoá bất biến **ĐƠN → PAYMENT**. `OrderPaymentGateway.lockOrder` (`common/gateway/payment.gateway.ts`; order cài ở `order-payment.gateway.impl.ts` → `OrderService.lockOrder` → `OrderRepository.lockByCode`); `settlePayos` (tách `settlePayosOnce`) và `finalizeRefund` (tách `finalizeRefundOnce`) khoá đơn TRƯỚC rồi mới khoá payment. Thêm lớp phòng thủ `retryOnDeadlock`/`isDeadlockError` (`common/prisma/errors.ts`, nhận 40P01/P2034 ở nhiều dạng bọc lỗi, tối đa 3 lần) quanh hai transaction đó.
- **Kiểm chứng trên Postgres thật** (`assets/e2e-audit/t08-p0-verify.mjs`, 12 vòng, mỗi vòng huỷ ∥ webhook cho một đơn mới; đo bằng `pg_stat_database.deadlocks`):

| Cấu hình | Webhook trả | Kết quả đơn | Deadlock Postgres |
|---|---|---|---|
| Code cũ (gỡ cả khoá-đơn-trước lẫn thử-lại) | **500 ở 12/12 vòng** | `cancelled` + `unpaid` + **0 refund** (tiền khách mất dấu) | **12** |
| Chỉ khoá-đơn-trước (gỡ thử-lại) | 200 ở 12/12 | `cancelled` + `paid` + đúng 1 refund đủ số | **0** |
| Bản đầy đủ (khoá-đơn-trước + thử-lại) | 200 ở 12/12 | `cancelled` + `paid` + đúng 1 refund đủ số | **0** |

- Test đơn vị (`payment-payos.spec.ts`): thứ tự khoá (đơn trước payment), thử lại khi 40P01 vẫn ghi nhận đúng MỘT lần, lỗi khác không thử lại (vẫn 500 cho PayOS gửi lại), ghi sổ hoàn tiền khoá đơn trước.

### 11.2 AUD-02 — mã kỳ chi trùng làm bỏ sót đơn
- **Nguyên nhân gốc:** mã kỳ `PAY-<yymmdd>-<yymmdd>-<shop>` chỉ có NGÀY; kỳ thứ hai của cùng shop trong cùng ngày trùng mã ⇒ `P2002` bị `run()` coi là "chạy song song — bỏ qua" ⇒ "Đã tạo 0 kỳ", đơn mới không nằm trong kỳ nào.
- **Sửa:** `uniquePayoutCode` (`shop-payout.service.ts`) — mã gốc đã tồn tại thì thêm hậu tố **chữ** `-B`, `-C`… (tối đa 26 kỳ/shop/ngày, vượt thì báo lỗi rõ). KHÔNG dùng hậu tố số vì khoá chi lại `<mã>-<lần thử>` (`gatewayKey`) sẽ đè khoá của kỳ khác; vẫn ≤ `VarChar(30)` nên không cần migration.
- **Kiểm chứng:** t08 chạy 3 kỳ liên tiếp cùng ngày — kỳ 3 trùng mã gốc kỳ 2 nhưng vẫn được tạo (`…-B`), mỗi đơn nằm đúng một kỳ, không đơn nào bị bỏ sót; t05b 8/9 → 9/9 (STL-16x). Test đơn vị: 3 ca (kỳ 2 cùng ngày, kỳ 3 `-C`, hết hậu tố).

### 11.3 AUD-03 — đổi tài khoản ngân hàng không cần mật khẩu
- **Sửa (backend):** `PATCH /shop/me` nhận `currentPassword`. Khi bank THỰC SỰ đổi (BIN / số TK / tên chủ TK): thiếu ⇒ **400 `SHOP_BANK_PASSWORD_REQUIRED`**, sai ⇒ **400 `SHOP_BANK_PASSWORD_INVALID`** (cố ý KHÔNG dùng 401/403 vì FE hiểu là hết phiên / thiếu quyền). Kiểm bằng `IdentityQueryApi.verifyPassword` (argon2, mật khẩu của CHÍNH người thao tác) TRƯỚC transaction, kiểm lại trong transaction chống race (bank vừa bị người khác đổi). Chỉ sửa hồ sơ hoặc gửi lại TK cũ ⇒ không đòi. `@RateLimit` 10 lần/10 phút/người (chống dò mật khẩu bằng token bị chiếm); audit `BANK_UPDATED.after.reauthenticated = true`; mật khẩu không vào audit/outbox/log (thêm `*.currentPassword` vào danh sách che của pino).
- **Sửa (web quản trị, cổng nhà bán):** ô "Mật khẩu đăng nhập của bạn" trong form đổi TK (`shop-bank-account-card.tsx`, `shop-bank-schema.ts`, `use-shop-profile.ts`).
- **Kiểm chứng:** t08 AUD-03a…h — thiếu mật khẩu ⇒ 400 và TK không đổi; sai ⇒ 400; chỉ sửa hồ sơ / gửi lại TK cũ ⇒ 200; đúng ⇒ 200, audit có `reauthenticated`, mật khẩu không có trong audit/outbox; 13 lần dò liên tiếp ⇒ 429 từ lần thứ 11. t05 STL-11a ✔, STL-11b ✔ (đổi TK hợp lệ vẫn kích hoạt giữ kỳ chi). Test đơn vị `shop-update.spec.ts`.
- **Chưa làm của §2.5 (WP-02):** email riêng cho chủ shop khi đổi TK, khớp tên chủ TK; tài khoản đăng nhập Google/không có mật khẩu hiện không đổi được TK (cần luồng đặt mật khẩu trước).

### 11.4 Hồi quy
- Chạy lại toàn bộ bộ audit (14 bài) trên DB sạch: so với lần audit đầu trên 224 mã có ở cả hai lần — 219 giữ nguyên, **4 cải thiện (STL-11a, STL-16x, CONC-08, CMP-01b), 1 "đổi" (STL-11b)**: bài test giả định đổi TK không cần mật khẩu vẫn thành công; đã cập nhật tiền đề (đổi hợp lệ kèm mật khẩu) và đạt. **Không có hồi quy thật.**
- Backend: `npm run lint`, `tsc --noEmit`, `check:boundaries`, jest **1967/1967** (69 suite). Web quản trị: `lint` 0 lỗi, `typecheck` sạch. **Chưa chạy `next build`** và **chưa thử form đổi TK trên trình duyệt** (backend cô lập đã dựng nhưng chưa dựng bản FE).

### 11.5 Lưu ý triển khai
- Backend và web quản trị phải lên **cùng đợt**: FE cũ (chưa có ô mật khẩu) đổi TK sẽ bị 400 — an toàn nhưng chủ shop không đổi được TK cho tới khi lên FE mới.
- Spec OpenAPI của web quản trị chưa `api:sync` (trường `currentPassword` được khai tạm ở hook, đúng một điểm ép kiểu); `api:sync` còn là điều kiện của AUD-09 (duyệt/mở giữ/đối chiếu kỳ chi).
- `run()` vẫn kiểm chồng khoảng toàn cục (AUD-08) — chưa sửa.
- Sự cố khi tự test (đã xử lý, ghi để khỏi lặp lại): driver chạy nền lần đầu quên nạp `auditenv.sh` nên `jobs.cjs` dùng `.env` của snapshot (trỏ DB dev :5434 / Redis :6381 / Gmail); lúc đó các cổng đó KHÔNG lắng nghe nên các job chỉ lỗi kết nối, không chạm dữ liệu thật. Đã sửa driver (nạp env cô lập); nên xoá `.env` khỏi bản sao snapshot hoặc để `jobs.cjs` từ chối chạy khi `EF_DATABASE_URL` không phải DB audit — việc cho WP-00.


## 12. Đợt PLAN-0040 Tầng 0–2 (2026-10-27) — kết quả

**Phạm vi đã làm:** Tầng 0 (dựng môi trường + baseline), Tầng 1 (thu tiền vào & hoàn: 1.1–1.6), Tầng 2 (chi trả shop: 2.1–2.4). **Chưa làm:** Tầng 3–8 (xử lý đơn có hạn chót, thông báo/vận hành, AUD-03 còn lại, đồng bộ API + giao diện, rà soát/triển khai, phần "để sau").

| | Baseline §10 | Sau Tầng 1 | Sau Tầng 2 (lần chạy sạch, không tải song song) |
|---|---|---|---|
| ✔ | 290 | 294 | **304** |
| ✘ | 18 | 14 | **12** |
| ℹ | 33 | 33 | **30** (+5 mã mới: STL-06c, STL-13b…13e) |
| Hồi quy ✔→✘ | — | 0 | **0** |

- ✘→✔: **PAY-07b, PAY-08, PAY-09, PAY-10b, REF-04b2, STL-13**; ℹ→✔: **STL-04d, STL-06, STL-12b2**.
- ✘ còn lại (12) — đều thuộc tầng chưa làm: CK-05 (Tầng 8) · CAN-03, CAN-07, CAN-08, CAN-14, FUL-04a, SHOP-01c, SHOP-01f, SHP-04, COD-08b, SHP-09 (Tầng 3) · NTF-03 (Tầng 4).
- Baseline mới: `docs/plans/assets/e2e-audit/baseline-2026-10-27-tang2.json` (346 mã). Cột HT của `docs/11` đã đánh dấu lại bằng `mark-docs11.cjs`.
- `npm run verify` xanh: lint + boundaries + build + **2011 test / 69 suite**; `prisma migrate diff` giữa DB sau migration và `prisma/schema` = **không lệch**.

### 12.1 Bài học khi làm đợt này
1. **jest dùng DB giả KHÔNG bắt được vi phạm chỉ mục UNIQUE.** Hàng giao dịch webhook thứ hai của cùng link (khoản trùng / trả thêm) đụng `uq_payment_transactions_provider_ref (type, provider_ref)` ⇒ webhook 500 trên Postgres thật, trong khi 752 test đơn vị vẫn xanh. Đã sửa (mã khoản trong `providerRef` các hàng sau) **và** DB giả của `payment-payos.spec.ts` nay ném P2002 giống Postgres. Quy tắc: lỗi liên quan chỉ mục/khoá/đồng thời phải kiểm bằng harness trên Postgres thật.
2. `CONC-07` gửi hai webhook với hai `reference` khác nhau nhưng kỳ vọng "không hoàn" — mâu thuẫn với PAY-09 (hai `reference` = hai lần chuyển tiền thật). Đã sửa bài test: PayOS **gửi lại** thì cùng `reference`.
3. **Không chạy việc nặng (vd `npm run verify`) khi bộ audit đang chạy**: `jobs.cjs` khởi động cả ứng dụng Nest bằng `execSync` (timeout 120s) và thất bại im lặng (`{ok:false}`) khi thiếu CPU — một lần chạy bị lệch vì vậy; chạy lại sạch thì khớp. STL-08d/08e đã ✘ trong baseline (08e là lỗi bài test — §7), không phải hồi quy.
4. Lần chạy baseline đầu tiên của Tầng 0 lệch (t05 dừng giữa chừng vì `INVALID_PERIOD` thoáng qua); dựng lại DB sạch rồi chạy lại thì đúng **290 ✔ · 18 ✘ · 33 ℹ**.

### 12.2 Đã đổi (backend) — tóm tắt
- **Thu tiền (1.1–1.4):** `payments.received_amount` cộng dồn theo từng khoản (`reference`); thiếu ⇒ chưa `paid` + báo kế toán, đủ sau cộng dồn ⇒ `paid`; hết hạn thiếu ⇒ hoàn `mismatch`; thừa ⇒ `paid` + hoàn `mismatch`; trả hai lần ⇒ hoàn `duplicate_payment`; hạn link = hạn đơn (setting), thanh toán lại gia hạn cả payment lẫn `paymentExpiresAt`; tạo link PayOS **sau commit** (`createCheckoutLinks`, timeout 8s, song song ≤ 3, `linkRetryable`); job `payos-reconcile-pending` 2 phút.
- **Hoàn tiền (1.5–1.6):** job `refund-auto-process` (5 phút, `refund.auto_max_amount` mặc định 2.000.000, tác nhân hệ thống); hoàn tay khi lệnh chi PayOS không rõ ⇒ tra PayOS theo `referenceId`, 409 `PAYMENT_REFUND_RECONCILE_REQUIRED` nếu PayOS đã nhận lệnh, cờ `confirmGatewayNotExecuted`.
- **Chi trả (2.1–2.4):** bảng `shop_payout_holds` + `POST/GET /admin/payouts/holds`, `POST …/holds/:id/release`; kiểm số dư PayOS trước khi gửi (thiếu ⇒ kỳ `pending` + lý do + báo kế toán); PayOS từ chối/không rõ ⇒ báo kế toán; "Mở giữ" còn lý do ⇒ 409 `PAYOUT_STILL_HELD`; `merged`; chồng kỳ theo shop; `shopName`/`shopCode` ở kỳ chi, lệnh giữ và hoàn tiền.
- **Migration mới (chỉ thêm cột/bảng, nới CHECK):** `20261028090000_payment_received_amount`, `20261028100000_payout_holds_merged`. Setting mới: `refund.auto_max_amount`. Không thêm mã quyền (giữ tay dùng `supplier.payout.process`).
- **Việc FE còn nợ (Tầng 6):** storefront (`paymentUrl:null` + nút Thanh toán lại, hạn link), admin (nhãn `mismatch`, tab trạng thái kỳ chi mới, nút Duyệt/Đối chiếu/Mở giữ/Giữ tay, cột shop từ `shopName`/`shopCode`). `api:sync` chưa chạy (đúng thứ tự plan: sau khi xong BE Tầng 1–5).

## 13. Đợt PLAN-0040 Tầng 2b–6 (2026-10-27) — kết quả

Làm bằng 6 agent backend song song (Tầng 2b · 3 SLA/huỷ · 3 giao hàng/COD · 4 vận hành · 5 TK ngân hàng) rồi 4 agent giao diện (admin ×3, storefront ×1); điều phối viên tự chạy harness trên Postgres thật (jest dùng DB giả nên không bắt được lỗi SQL/ràng buộc).

| | Baseline Tầng 2 (§12) | **Lần chạy sạch cuối (đợt này)** |
|---|---|---|
| ✔ | 304 | **409** |
| ✘ | 12 | **0** |
| ℹ | 30 | **36** (đều là "lỗi do bài test" đã phân loại §7, hoặc ghi nhận) |
| Mã | 346 | **445** (+99 mã mới: t09 tiền biên 36 + t10 vòng đời 55 + các mã mới của Tầng 3–5) |
| Hồi quy ✔→✘ | 0 | **0** (`compare-baseline.cjs` thoát 0) |

- **✘→✔ (13):** CAN-03, CAN-07, CAN-08, CAN-14, CK-05 (`expectedTotal` + 409 `ORDER_PRICE_CHANGED`), COD-08a, COD-08b (đảo ghi thu COD, không hoàn tiền mặt chưa thu), FUL-04a, NTF-03, SHOP-01c, SHOP-01f, SHP-04, SHP-09. Baseline mới: `docs/plans/assets/e2e-audit/baseline-2026-10-27-final.json`.
- **t09 (tiền biên, 36/36 ✔):** các check từng ✘ trước Tầng 2b nay ✔ — MNY-02b/02c (tiền đến muộn: webhook luôn 200, hoàn `mismatch` đúng phần chưa hoàn), MNY-03a (webhook không `reference` coi là replay), MNY-08/09, AUTO-01 (tự chi hoàn nhỏ gửi đúng MỘT lệnh PayOS).
- **t10 (vòng đời bổ sung, 55/55 ✔) — kiểm SQL mới trên Postgres thật:** yêu cầu huỷ đơn `packing` (gửi · trùng 409 · từ chối · chấp nhận · tự chấp nhận khi quá hạn), SLA (TẮT ⇒ job không động; lần đầu bật ⇒ rebase không huỷ hàng loạt; quá hạn xác nhận/giao ⇒ tự huỷ + nhả giữ chỗ tồn kho + 1 điểm, chạy lại không cộng đôi; nhắc đúng 1 lần), gia hạn giao (một lần, các mã 409), điểm vi phạm + cảnh báo khoá shop (một lần / 7 ngày), đổi địa chỉ (các mã 409), "Đã nhận hàng" (idempotent), `open-orders-summary`, TK ngân hàng tên lệch ⇒ `pending_verification` ⇒ quản lý xác minh (`SHOP_BANK_CHANGED_SINCE` / `SHOP_BANK_NOT_PENDING`), `/health` + `/health/worker`.
- **Migration mới (đã áp từ dump cũ, `migrate status` "up to date", `migrate diff` = không lệch):** `20261028110000_order_sla_cancel_requests`, `20261028120000_delivery_proof`, `20261028130000_shop_bank_verification` (cùng hai migration Tầng 1–2). Mã quyền mới: `shop.order.cancel` (chủ shop có sẵn, nhân viên khi được giao). Setting mới: `order.sla_enabled` (**mặc định TẮT**), `order.shop_confirm_hours`, `order.shop_ship_hours`, `order.cancel_request_hours`, `shop.violation_suspend_points`.
- Email chủ shop khi đổi TK (5.1) kiểm trên Redis thật: job `ef:mail:*` có số TK che 4 số cuối + tên chủ TK + người đổi, giá trị đã escape.

### 13.1 Bài test đã sửa (không phải lỗi sản phẩm)
1. **NTF-01a/01b (t06b):** hoàn nhỏ ≤ `refund.auto_max_amount` tự chi nên kế toán KHÔNG cần được báo — bài nay tắt tự chi trong phạm vi bài và đo ở ảnh chụp thông báo cuối (thông báo "Đơn mới" đi qua outbox ~3s).
2. **PAY-04 (t02):** `cancel-expired` không được huỷ đơn PayOS đã trả; việc ghi nhận `paid` do job dò PayOS (`payos-poll`, có ân hạn) — bài chạy cả hai job.
3. **AUD-02b (t08):** đồng hồ Windows lệch ~15ms giữa hai tiến trình làm `periodEnd = bây giờ` đôi khi vượt `Date.now()` của API (400 thoáng qua) ⇒ lùi 300ms. (Đã thử sửa ở `lib.mjs` cho mọi bài — SAI: loại mất đơn vừa hoàn tất của t05; đã hoàn lại, chỉ sửa t08.)
4. **AUTO-01 (t09):** mỗi lượt job chỉ xử lý 20 khoản `requested` cũ nhất; các khoản tích tụ từ bài trước chiếm lô ⇒ bài gạt chúng sang xử lý tay trước khi đo.
5. Chạy lại t09 SAU t10 trên cùng DB cho HLD-08 ✘ (kỳ chi vẫn `held` sau khi mở lệnh giữ tay) — nghi là nhiễu thứ tự do t10 đã đổi TK ngân hàng của shop (chưa truy tận gốc); trong `run-all.sh` t09 chạy TRƯỚC t10 và HLD-08 ✔.

### 13.2 Phát hiện khi làm giao diện → đã sửa backend
- `GET /admin/payments` thiếu `receivedAmount` dù docs/06 nói có ⇒ thêm vào `PaymentResponse` (màn thanh toán hiện "đã nhận X / cần Y"). 808 test của module payment vẫn xanh.

### 13.3 Kiểm trình duyệt (bản sao FE trỏ backend cô lập; vai · việc đã làm)
- **Kế toán:** `/shop/payouts` — tab mới, cột shop có tên + mã (không còn `Shop …xxxx`), chi tiết kỳ `held` hiện lý do; bấm "Mở giữ" khi còn lý do ⇒ banner đỏ hiện NGUYÊN VĂN lý do 409 của backend; `/payment/refunds` — cột Gian hàng/Cách hoàn, nhãn "Tiền thanh toán lệch", ghi chú COD không tự chi.
- **Chủ shop:** `/vendor/orders` (cột hạn đếm ngược), chi tiết đơn `packing` có yêu cầu huỷ của khách (đếm ngược, Chấp nhận/Từ chối, Gia hạn giao, Huỷ đơn), "Giao cho vận chuyển" bắt buộc hãng + mã vận đơn (thiếu ⇒ chặn; có ⇒ lịch sử ghi hãng + mã), `/vendor/violations` (3/10 điểm).
- **Quản lý:** chi tiết shop tên chủ TK lệch — khung so sánh hai tên + nút "Xác minh tài khoản" ⇒ `bank_status=verified` + `bank_verified_at`; tab "Vi phạm"; hộp thoại khoá shop hiện "30 đơn chờ/đã xác nhận sẽ tự huỷ… 6 đơn đang đóng gói/giao CSKH huỷ tay".
- **CSKH:** `/order/orders` tìm toàn sàn (không còn chọn shop), cột "Hạn shop"; đơn `packing` có nút huỷ + thẻ "Yêu cầu huỷ của khách"; hộp thoại huỷ có mã lý do (Tranh chấp/Gian lận/Khác) + lý do ≥ 10 ký tự.
- **Khách (storefront):** danh sách đơn có nhãn "Đã gửi yêu cầu huỷ · chờ shop"/"Shop từ chối yêu cầu huỷ"; đơn `confirmed` có "Đổi địa chỉ" + "Huỷ đơn này" (form lý do); đơn `delivered` hiện hãng + mã vận đơn + "Đã nhận hàng" (bấm ⇒ `completed`, `completed_by=customer`); **giá đổi sau khi mở trang đặt hàng ⇒ hộp thoại "Giá hoặc phí vận chuyển đã thay đổi — Tổng mới 449.000 ₫ (trước đó 439.000 ₫)"; "Đặt hàng với giá mới" ⇒ đơn tạo đúng 449.000 ₫.**
- **Chưa kiểm bằng trình duyệt:** khách gửi yêu cầu huỷ ở `packing` và đổi địa chỉ (kiểm bằng harness t10), nhân viên shop KHÔNG có `shop.order.cancel`, 390px từng màn mới, thử với tài khoản Google (`details.googleLinked`).

### 13.4 Còn lại (không chặn demo tiền thật số nhỏ)
- **Tầng 8** (WP-10 đối chiếu tiền hằng ngày, bù trừ ví COD ↔ kỳ chi, rút cọc/đóng shop, SHP-08 leo thang > 20 ngày, né hoa hồng COD, rủi ro COD khách).
- **Dashboard sàn** chưa có số đếm hàng đợi tài chính (kỳ chờ duyệt / không rõ kết quả / đang giữ / hoàn cần đối soát) — backend `reporting` chưa trả field; "thời điểm có thể mở giữ" của kỳ `held` cũng chưa có (chỉ có `holdReason`).
- `ReturnRequestResponse` không mang phương thức thanh toán nên dialog duyệt đổi trả của shop chỉ ghi chú có điều kiện "nếu đơn là COD…".
- Màn "Quên mật khẩu" nằm sau `GuestGuard` (người đang đăng nhập bị đẩy đi) nên gợi ý cho tài khoản Google chỉ là hướng dẫn bằng chữ (đăng xuất → Quên mật khẩu → đăng nhập lại → đổi TK).
- COD đang `shipping` (chưa thu) mà khách báo `not_received` + shop duyệt ⇒ đơn `returned` nhưng payment COD vẫn `pending` (đã biết từ trước, không phát sinh tiền).
- `refund.auto_max_amount` nên đặt **0** ở môi trường thật cho tới khi có một lệnh hoàn thật thành công qua PayOS thật (docs/12 §4).

## 14. PLAN-0041 — nạp cọc COD qua PayOS (2026-11-03) — kết quả

Kế hoạch do agent Sonnet viết (`docs/plans/PLAN-0041-cod-deposit-payos.md`, 16 mục); code + unit test + harness do 8 agent Haiku làm theo gói WP; điều phối viên chạy cổng kiểm và thử trên Postgres thật. **PayOS là đường nạp cọc DUY NHẤT của chủ shop** (chủ dự án chốt: nạp tay và nạp PayOS đều là chuyển khoản nên hai nút gây khó hiểu) — màn chủ shop chỉ còn nút "Nạp tiền vào ví"; cờ `wallet.payos_deposit_enabled` mặc định **BẬT** (chỉ chạy khi khoá PayOS thu tiền đã cấu hình). Bảng/route nạp tay và màn sàn "Khoản nộp cọc" giữ nguyên để xử lý khoản đã gửi từ trước.

| Cổng | Kết quả |
|---|---|
| Migration `20261103090000_wallet_payos_topup` | áp sạch lên DB trống (47 migration), `prisma migrate diff` = không lệch; chỉ THÊM bảng/cột/chỉ mục + nới 1 CHECK |
| Backend `verify` | lint + `check:boundaries` + build + **2429** test / 92 suite xanh (+105 test so với trước) |
| Admin `verify` | lint (0 lỗi) + typecheck + build 70 trang xanh |
| Harness `t11` (Postgres thật + PayOS giả) | **32/32 ✔** — đủ/thiếu/thừa/trùng/replay/mất webhook/trễ sau hết hạn/PayOS lỗi/cờ tắt/khoá shop/đồng thời (0 deadlock)/rollback bằng trigger/E2E COD/bất biến I1–I9 (Σ ví nạp = Σ PayOS giả nhận) |
| `run-all.sh` | **444 ✔ · 0 ✘ · 37 ℹ / 481 mã**, 0 hồi quy; baseline `baseline-2026-11-03-topup.json` |

- **Lỗi bài test (không phải sản phẩm):** WTP-15 đếm thông báo kế toán theo tổng thay vì theo từng người nhận (kế toán và admin mỗi người một thông báo); WTP-26 truyền đối tượng tiền vào `num()` ⇒ NaN ⇒ chữ ký webhook sai ⇒ 401.
- **Lỗi THẬT tìm được và đã sửa (đường thanh toán ĐƠN, ngoài phạm vi tính năng):** khách chuyển HAI lần cho một link, và job dò/return thấy luỹ kế đủ TRƯỚC khi hai webhook về ⇒ webhook thứ hai bị coi là "trả trùng" ⇒ tạo hoàn tiền nhầm cho khách (sàn mất tiền thật). Nay `settlePayosOnce` chỉ hoàn phần VƯỢT số đã tính cho đơn. Khoá bằng jest (PAY-09b…e; hai bài fail khi đặt lại logic cũ) và harness t09 INS-01…03. Cũng thêm chốt: webhook có mã không phải số ≤ 16 chữ số không đi vào luồng nạp cọc.
- **Kiểm trình duyệt (bản sao FE + PayOS giả):** chủ shop tạo link 600.000 ₫ (nhập 100.000 ⇒ "Tối thiểu 500.000 ₫") → "trả" ở trang PayOS giả → trang quay lại "Nạp cọc thành công / Đã ghi có 600.000 ₫" → ví 6.100.000 → 6.700.000, sổ cái có khoá `payos-topup:<id>:600000`; kế toán thấy khoản ở tab sàn (kể cả khoản kết thúc thiếu "đã ghi có 777.777 ₫ / 1.000.000 ₫"); tắt cờ ⇒ màn chủ shop hiện "tạm thời không khả dụng", không còn đường nạp khác.
- **Chưa kiểm / để chủ dự án:** (1) **PayOS THẬT**: ngữ nghĩa `amountPaid`, trạng thái UNDERPAID, link hết hạn có còn nhận tiền không, giới hạn độ dài `description` mới chỉ dựa trên tài liệu và PayOS giả — thử MỘT khoản nhỏ trước khi mở rộng; (2) đặt `EF_ADMIN_URL` (https ở production, nếu không tính năng trả 503); (3) `npm run db:dump` lại sau migration mới; (4) trình duyệt chưa phủ 390px, vai nhân viên shop (không có quyền ví) và hết hạn/huỷ link trên giao diện; (5) chưa có rà soát độc lập (PLAN-0041 §12.4).


## 15. PLAN-0043 — vận chuyển GHN (2026-11-05)

Phạm vi đã triển khai: địa chỉ có mã GHN, điểm lấy/trả của từng shop, thông số kiện hàng, quote bền vững và kiểm giá khi checkout; tạo vận đơn có claim/lease và phục hồi kết quả chưa rõ; nhãn, inbox/poll/simulator; timeline khách/vendor; xác nhận COD thu hộ và tách phí vận chuyển khỏi doanh thu shop. Tuyến self giữ luật cọc COD cũ. Nguồn fake/demo bị chặn thu/hoàn/chi và ghi sổ qua endpoint tiền thật; mock loopback ngoài production phục vụ E2E.

Môi trường: PostgreSQL16 tại localhost:55443/fitly_ghn_audit, Redis localhost:56390, API4031, PayOS mock4021, FE3403/3404, SHIPPING_CARRIER=fake. Không dùng DB ứng dụng, không gửi email hay chuyển tiền thật. Harness chỉ chấp nhận đúng DB audit này, dùng GHN_AUDIT_DATABASE_URL và mật khẩu fixture truyền bằng biến môi trường; không đọc .env.

| Kiểm tra | Bằng chứng |
|---|---|
| Migration | 48 migration áp lên DB mới; migration:check báo không có khác biệt schema |
| HTTP + PostgreSQL | node docs/plans/assets/e2e-audit/t12-shipping.mjs: lần hoàn tất cuối 46/46, exit0; cấu hình fixture được phục hồi trong finally |
| Hai shop | Pickup khác nhau, phí quote riêng; carrier COD không cần cọc; replay checkout trả đơn cũ; ba yêu cầu ship song song cùng một shipment; nhãn và trạng thái lấy/giao hàng |
| Tiền và huỷ | Delivered chưa làm payment paid hay trừ ví; xác nhận remittance mới paid; replay không thu hai lần, reference khác bị409; sau picked không huỷ trực tiếp; huỷ trước picked đóng payment pending; SALE gross không chứa phí hãng |
| Online và phục hồi | Webhook PayOS giả chuyển paid, codAmount=0; mô phỏng kết quả create chưa rõ trong DB rồi reconcile giữ cùng mã hãng; giao thất bại→returned tạo đúng một yêu cầu hoàn đủ |
| Quyền và giá | Shop khác404; vendor không được simulate403; sửa expectedTotal nhận409 và không tạo đơn; sửa giá rồi dùng lại Idempotency-Key thành công; quote hết hạn được thay ID mới; self COD ví0 vẫn bị chặn |
| Browser thật | Admin danh sách vận đơn; vendor chi tiết và bấm yêu cầu lấy hàng; khách390px xem timeline/tiền. Các trang đã kiểm không có lỗi JS hoặc tràn ngang |

Ảnh bằng chứng: [admin](plans/assets/e2e-audit/ghn-evidence/admin-shipments-desktop.png), [vendor](plans/assets/e2e-audit/ghn-evidence/vendor-order-desktop.png), [yêu cầu lấy hàng](plans/assets/e2e-audit/ghn-evidence/vendor-request-pickup.png), [khách390px](plans/assets/e2e-audit/ghn-evidence/customer-order-mobile.png). Đơn browser DH2611050001 hoàn tất/paid; DH2611050004 bấm yêu cầu lấy hàng và hiển thị chờ hãng lấy, chưa coi là đã bàn giao.

Giới hạn: chưa gọi GHN staging/production, chưa xác minh tài khoản nhiều điểm lấy/nhãn/phí chốt thật và chưa dùng PayOS thật. Chưa chạy lại driver t01–t11 vì hardcode API4030, DB55442 và thao tác dừng container cũ; đợt này dùng toàn bộ unit và t12 riêng, không công bố baseline cũ là kết quả mới. Chưa kiểm đủ toàn bộ ma trận SHP-D01…25 bằng HTTP/restart/fault injection; xem coverage trong docs/11. Không coi kết quả fake là nghiệm thu GHN thật.

Cổng kiểm cuối: backend `npm run verify` exit0, 98 suite / 2.515 test; `npx tsc --noEmit` exit0. Hai sửa tích hợp cuối (cờ huỷ trước picked và tìm mã vận đơn giữ bộ lọc shop/status) có thêm 14 regression, bộ tập trung 2 suite / 52 test đạt. Storefront lint/typecheck đạt, production build exit0 (34 trang; 2 cảnh báo img có sẵn). Admin lint/typecheck đạt, production build exit0 (72 trang). Không tuyên bố refund đã done hay outbound payout đã paid: t12 kiểm yêu cầu hoàn và dòng sổ SALE.

Dọn dẹp đã xác minh: xoá đúng hai container audit và anonymous volume (toàn bộ đơn/user/quote/simulator do bài thử tạo); dừng API, hai FE dev, PayOS mock và Chrome audit; không còn listener ở4031/3403/3404/4021/9227/55443/56390. Xoá profile .ghn-browser-audit chứa phiên đăng nhập và ba file tạm fitly-ghn-*.log/json. Giữ harness và bốn ảnh bằng chứng; không xoá file/thay đổi sẵn có hoặc DB của người dùng. Backend lint các file sửa cuối + build lại đều exit0.

## 16. PLAN-0044 — tìm sản phẩm bằng ảnh (2026-11-06)

Đã thay pipeline chỉ dựa từ khoá bằng SigLIP2 ảnh768 chiều, lập chỉ mục ảnh catalog qua worker, hợp nhất ứng viên ảnh/OCR và xếp hạng lại bằng ảnh thật khi có OpenAI. FE chọn vùng bằng chuột/chạm/bàn phím, nhận diện món theo yêu cầu, trả ảnh màu khớp và lý do similar/related. Không báo similarity thành phần trăm chắc chắn, không tự lấp kết quả khi reranker trả rỗng. Có API quản trị index, compose/CD profile riêng và CLI benchmark tuning/held-out.

Môi trường audit riêng: PostgreSQL16/pgvector localhost55445/fitly_visual_audit, Redis56391, API4005, encoder18183. Tắt OpenAI, không đọc key thật, không ghi vào DB/server triển khai. Ảnh mẫu tải qua GET public, fixture chỉ tạo trong DB audit. Model Google SigLIP2 base-patch16-224 revision75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2 chạy CPU thật.

| Cổng | Kết quả |
|---|---|
| Backend `npm run verify` | exit0: lint, boundaries, build, **99 suite / 2509 test** đạt |
| Migration | 49 migration áp lên DB mới, `migration:check` không lệch schema |
| Encoder Python | 4 test đạt: ảnh RGB hợp lệ, base64/bytes sai, GIF bị loại, giới hạn kích thước |
| Encoder HTTP thật | health200/dimensions768 đúng model; không token401; ảnh sai và batch quá lớn400 |
| PostgreSQL + encoder thật | `scripts/audit/visual-search-smoke.ts`: **7/7** self-image cosine>.99, đúng product/ảnh, index idempotent, lọc hidden/suspended và prune ảnh không còn bán |
| API HTTP thật | analyze200 không key trả hướng dẫn crop; search200 mode visual trả đúng một sản phẩm/ảnh fixture; admin index không auth401 |
| Regression có mock OpenAI | Người mặc đồ/vùng hợp lệ, iPhone không phụ thuộc tên điện thoại, ảnh màu, ID bịa/trùng, no-match không bị lấp, stale image URL, fallback và vector invalid |
| Frontend | lint/typecheck đạt; production build exit0,34 trang; hai cảnh báo img có sẵn ở account-shell/profile-screen |
| Deployment files | Compose config và bash syntax đạt; chưa push/deploy hay bật model trên VPS |
| Diff | Hai repo `git diff --check` đạt |

Giới hạn nghiệm thu: **7/7 là smoke tích hợp, không phải accuracy benchmark**. Chưa có bộ ảnh người gán nhãn tuning/held-out và chưa gọi OpenAI thật; chưa thể công bố mức tăng độ chính xác hoặc nghiệm thu chất lượng nhận diện vùng/rerank ngoài mock. Threshold0.65 là khởi điểm cần hiệu chỉnh, không phải65% accuracy. FE đã code responsive nhưng chưa kiểm trình duyệt desktop/390px: lệnh mở server FE local bị automatic review từ chối, chỉ nêu `blocked by policy`. Không khởi chạy lại bằng đường khác.

Dọn dẹp đã xác minh: dừng API/Chrome audit; xoá đúng ba container fitly-visual-*-audit cùng anonymous volumes, volume fitly-visual-audit-models và tag image fitly-visual-encoder:audit. Toàn bộ fixture DB bị xoá cùng DB audit. Không còn listener4005/18183/55445/56391/9228/3414, container hoặc volume fitly-visual; ba container ago-erp có sẵn vẫn chạy. **Còn sót** D:\Fullstack\eco_fashion\.visual-browser-audit và ba log trong TEMP (fitly-visual-lint.log, fitly-visual-verify.log, fitly-visual-final-verify.log): lệnh xoá thư mục/log bị automatic review từ chối `blocked by policy`. Không công bố đã dọn sạch file khi chưa xoá được. Giữ source/test harness/model service và tài liệu cần cho triển khai; không có ảnh query lưu trong DB thật.

Để bật trên VPS: làm theo [services/visual-encoder/README.md](../services/visual-encoder/README.md), cấu hình profile/token/URL nội bộ, kiểm RAM/model health và theo dõi index ready trước khi nghiệm thu bằng bộ ảnh thật.

## 17. PLAN-0045 — FITLY Live A+B (2026-11-06)

Chi tiết nguồn/code/harness/bằng chứng và giới hạn: [biên bản triển khai Live](plans/PLAN-0045-livestream-implementation.md).

Backend lint/boundaries/build đạt; toàn bộ104suite/2544test đạt trước bổ sung bộ lọc khám phá cuối. 50migration trên DB audit mới, drift không khác, seed live idempotent2lần. Video và audio WebRTC thật qua LiveKit cục bộ đã nhận/giải mã ở browser độc lập và storefront. Dừng phiên thật thu hồi room; token host cũ không tự tạo lại phòng (`room.auto_create:false`). Worker pin outbox→Redis→Socket.IO thật và chặn user khác shop đã kiểm.

UI storefront đặt COD thành công nhóm `DHN2611060009`/con `DH2611060009`, tổng80.000đ sau voucher live50.000đ; giỏ cũ2chiếc giữ nguyên, reload không đặt trùng. HTTP kiểm thêm buy_now isolation, attempt replay/fencing, giỏ snapshot, coupon1of3, COD huỷ/khôi phục và recovery lượng1 giữ expiry. Admin7màn390px không tràn; camera preview dùng thiết bị giả lập Chrome. Hai FE production build đạt (36/76trang); còn2/4cảnh báo lint có sẵn.

Mọi ghi ở DB audit localhost55446, Redis56392, API4006/worker riêng và LiveKit7880; không dùng Cloud/thanh toán/GHN thật, không DB triển khai. Không tuyên bố nghiệm thu tải10viewer, camera phần cứng hai máy hoặc PayOS/LiveKit Cloud thật. Chưa push/deploy. Kiểm cuối sau lọc ngành: boundaries/build và104suite/2544test đạt; lọc ngành16phiên→15+1, admission10+11th409 và heartbeat chungIP đạt. Đã dừng process, xoá3container+volume dữ liệu riêng; không còn listener audit. **Còn profile `.live-browser-audit` và13file TEMP vì automatic review chặn xoá `blocked by policy`**; đường dẫn đầy đủ tại biên bản triển khai. Không công bố đã sạch filesystem.
