# PLAN-0023 — Vòng đời đơn hàng sẵn sàng vận hành thật (plan điều phối)

> Status: Approved for execution (2026-10-27) — chủ dự án uỷ quyền "làm theo khuyến nghị"; dự án **demo**: phạm vi chỉ là luồng mua bán end-to-end, test bằng tiền thật thu – chi; pháp lý/thuế/hoá đơn/quyền dữ liệu cá nhân **ngoài phạm vi** (chốt 2026-10-27).
> Owner: phiên điều phối + các phiên thực hiện (mỗi WP một phiên)
> Related Phase: Phase 6 — Vận hành thật (go-live) — `docs/04_ROADMAP.md`
> Tài liệu chuẩn: `docs/10_ORDER_LIFECYCLE.md` (luật + giá trị mặc định) · `docs/11_SCENARIO_CATALOGUE.md` (kịch bản có mã) · `docs/12_OPERATIONS_RUNBOOK.md` (vận hành)

---

## 1. Mục tiêu

Cho toàn bộ vòng đời đơn — đặt hàng → thanh toán → xử lý → giao → hoàn tất → đổi trả/hoàn tiền → đối soát/chi trả — **chạy end-to-end đúng với tiền thật** (PayOS thu, PayOS chi, hoàn thật, COD + ví cọc) trên bản demo: mọi tình huống có người chịu trách nhiệm, có hạn chót, có thông báo, có công cụ, có kiểm tiền hằng ngày, có test theo kịch bản và review độc lập.

**Không** viết lại hệ thống: sửa lỗ hổng trên nền đã có (PLAN-0014…0022).

## 2. Hiện trạng (khảo sát code 2026-10-27, 4 khảo sát độc lập)

Đã vững: checkout giữ tồn chống oversell, idempotency; webhook PayOS (chữ ký, idempotent, trả trùng/muộn); máy trạng thái đổi trả + hoàn tiền theo vai (PLAN-0022, đã test thật); escrow đối soát; phân quyền 2 tầng.

72 lỗ hổng (gộp trùng) — bảng truy vết §9. Nặng nhất:

1. **Đơn treo vô hạn:** không SLA cho shop xác nhận/giao; đơn `packing` không ai huỷ được; shop bị khoá làm đơn đóng băng nhưng tiền vẫn chi.
2. **Tiền ra có thể sai/trùng:** đánh dấu chi tay sau timeout PayOS ⇒ chi trùng; đổi TK ngân hàng chiếm tiền; ví COD trừ hoa hồng mà không cộng voucher sàn (shop lỗ); né hoa hồng COD bằng "giao thất bại"; không đối chiếu PayOS hằng ngày; tiền lệch bị bỏ quên.
3. **Giao hàng không bằng chứng:** shop tự báo "đã giao" để nhận tiền; khách chỉ có 3 ngày báo chưa nhận.
4. **Người cần làm không biết việc:** web quản trị không có chuông, không email cho shop/sàn; CSKH không tìm đơn toàn sàn; không cảnh báo khi worker/PayOS lỗi.
5. **Thanh toán vào:** gọi PayOS trong transaction giữ khoá (nghẽn khi tải cao); mất webhook ⇒ đơn đã trả bị huỷ.

## 3. Quyết định đã chốt (theo khuyến nghị)

Toàn bộ ở `docs/10_ORDER_LIFECYCLE.md` §3–§13. Tóm tắt: shop xác nhận ≤ 24h, giao (có hãng + mã vận đơn) ≤ 48h, quá hạn tự huỷ + hoàn + điểm vi phạm · khách huỷ tức thì tới `confirmed`, `packing` thì yêu cầu (24h tự chấp nhận) · khách có "Đã nhận hàng" và báo chưa nhận tới hết 7 ngày · hoa hồng không tính trên phí ship; voucher sàn do sàn chịu cả với COD · ví cọc tối thiểu 200k, kỳ chi trích bù ví âm · chi trả theo tuần, tối thiểu 50k, > 20 triệu cần duyệt, mặc định TẮT tự động tới khi chi tay 2 kỳ OK · đổi TK ngân hàng: mật khẩu + email + giữ 72h + khớp tên · hoàn PayOS ≤ 2 triệu tự chi · khoá COD khách bom 2 lần/90 ngày · đối chiếu PayOS hằng ngày · giữ chứng từ không purge · không làm pháp lý/thuế/hoá đơn (dự án demo).

## 4. Work package (mỗi WP = một plan = một phiên thực hiện)

Ưu tiên: **P0** = bắt buộc trước khi mở bán thật · **P1** = trong 1 tháng sau go-live · **P2** = giai đoạn 2.

| WP | Plan | Tên | Ưu tiên | Repo | Phụ thuộc | Đợt | Cỡ |
|---|---|---|---|---|---|---|---|
| 00 | [PLAN-0024](PLAN-0024-test-harness.md) | Nền tảng kiểm thử: môi trường cô lập + smoke theo mã kịch bản + sửa tài liệu lệch | P0 | BE | — | 0 | M |
| 01 | [PLAN-0025](PLAN-0025-payment-in-safety.md) | Thanh toán vào an toàn (PayOS ngoài tx, đối chiếu chủ động, tiền lệch, tự chi hoàn nhỏ) | P0 | BE · user · admin | 00 | 1 | L |
| 02 | [PLAN-0026](PLAN-0026-payout-safety.md) | Chi trả shop an toàn (không chi trùng, duyệt/hạn mức, giữ tiền, đổi TK, chạy theo shop) | P0 | BE · admin | 00 | 1 | L |
| 03 | [PLAN-0027](PLAN-0027-fulfilment-sla-cancel.md) | Xử lý đơn có hạn chót & lối thoát (SLA shop, ma trận huỷ, đổi địa chỉ, "đã nhận hàng", khoá shop) | P0 | BE · admin · user | 00 | 1 | L |
| 04 | [PLAN-0028](PLAN-0028-notifications-email.md) | Thông báo & email đủ người (chuông web quản trị, email shop/kế toán, ma trận sự kiện) | P0 | BE · admin · user | 00 | 1 | M |
| 05 | [PLAN-0029](PLAN-0029-ops-tooling-observability.md) | Công cụ vận hành & quan sát (tìm đơn toàn sàn, dòng thời gian, audit, outbox, heartbeat/cảnh báo, dashboard, CSV, sao lưu) | P0 | BE · admin · deploy | 00 | 1 | L |
| 06 | [PLAN-0030](PLAN-0030-commission-cod-wallet.md) | Hoa hồng & ví cọc COD đúng (gốc hoa hồng, voucher sàn, bù trừ ví ↔ chi trả, nợ, rút cọc) | P0 | BE · admin | 02 | 2 | L |
| 07 | [PLAN-0031](PLAN-0031-delivery-proof-antifraud.md) | Giao hàng có bằng chứng & chống gian lận giao (hãng + mã vận đơn, đảo thu COD, thất lạc) | P0 | BE · admin · user | 03 | 2 | L |
| 08 | [PLAN-0032](PLAN-0032-checkout-cod-risk.md) | Checkout chặt & rủi ro COD phía khách (giá đổi, giới hạn COD, bom hàng) | P1 | BE · user · admin | 01 | 2 | M |
| 09 | [PLAN-0033](PLAN-0033-returns-phase2.md) | Đổi trả đợt 2 (thiếu hàng, TK bổ sung, phí ship theo lỗi, xem trước, công khai hạn) | P1 | BE · user · admin | 07 | 3 | M |
| 10 | [PLAN-0034](PLAN-0034-reconciliation-accounting.md) | Đối chiếu tiền hằng ngày & báo cáo kế toán | P0 | BE · admin | 01 02 06 | 3 | M |
| 11 | [PLAN-0035](PLAN-0035-tax-invoice-legal.md) | ~~Thuế, hoá đơn & pháp lý~~ — **ngoài phạm vi** (dự án demo); sao kê kỳ chi chuyển sang WP-06 | — | — | — | — | — |
| 12 | [PLAN-0036](PLAN-0036-privacy-retention.md) | ~~Dữ liệu cá nhân & lưu trữ~~ — **ngoài phạm vi** (dự án demo) | — | — | — | — | — |
| 13 | [PLAN-0037](PLAN-0037-uat-go-live.md) | **Test end-to-end bằng tiền thật** (thu – chi, 10 hành trình E2E) + UAT theo vai | P0 | tất cả | mọi P0 | 4 | M |
| 14 | [PLAN-0038](PLAN-0038-group-payment.md) | Một QR thanh toán cho cả nhóm đơn | P2 | BE · user | 13 | 5 | L |
| 15 | [PLAN-0039](PLAN-0039-carrier-integration.md) | Tích hợp hãng vận chuyển (trạng thái tự động, phí theo cân nặng, COD hãng thu hộ) | P2 | BE · admin · user | 13 | 5 | XL |

> **Phần còn lại sau audit E2E 2026-10-27 được gộp thành một plan bàn giao cho MỘT phiên: [PLAN-0040](PLAN-0040-go-live-remaining-handoff.md)** (tầng 0→8: thu tiền vào · chi trả · xử lý đơn/giao · thông báo/vận hành · AUD-03 còn lại · đồng bộ API + giao diện · rà soát/triển khai/dọn). Thiết kế chi tiết vẫn ở các plan WP bên trên; PLAN-0040 quy định thứ tự, tiêu chí xong và bài học vận hành.

```text
Đợt 0:  WP-00
Đợt 1:  WP-01 ∥ WP-02 ∥ WP-03 ∥ WP-04 ∥ WP-05     ── mỗi đợt: BE trước → đồng bộ API (điều phối) → FE
Đợt 2:  WP-06 ∥ WP-07 ∥ WP-08
Đợt 3:  WP-09 ∥ WP-10
Đợt 4:  R1–R5 (review chéo) → WP-13 (test end-to-end tiền thật + UAT)
Đợt 5:  WP-14 ∥ WP-15 (sau go-live)
```

## 5. Luật cho mọi phiên thực hiện

1. **Đọc trước:** `AGENTS.md` của mọi repo sẽ sửa (FE: Next.js bản mới — đọc `node_modules/next/dist/docs/` trước khi viết code Next), `docs/10`, các mã kịch bản của WP trong `docs/11`, plan của WP, mục này.
2. **Không chạy lệnh git** ghi (commit/push/branch/stash/checkout/reset); chủ dự án điều khiển git. Lệnh đọc (`git status`, `git diff`) được phép.
3. **Không đọc/in bí mật** (`.env*`, khoá PayOS). Không gọi PayOS/ngân hàng/email thật — mọi thứ mock hoặc môi trường cô lập (WP-00) với env trung tính.
4. **Khoá file nóng** (§6): ghi dòng vào bảng trước khi sửa, xoá khi xong. Sửa bằng `Edit` theo vùng hàm, không ghi đè cả file của người khác.
5. **Migration:** viết tay, chỉ thêm cột NULL/DEFAULT hoặc bảng mới, có chuyển dữ liệu cũ an toàn; tên `YYYYMMDDHHMMSS_<mo_ta>` lấy giờ thật lúc tạo; trước khi kết thúc phiên kiểm migration của mình là mới nhất (`ls prisma/migrations | tail`) — nếu không, đổi tên lên giờ hiện tại (chưa deploy nên đổi được). Bắt buộc chạy `migration:check` trên DB trống + áp lên dump thật (WP-00 `smoke:env:up`).
6. **Setting mới:** khai ở `system/enums/setting-keys.ts` + `system/foundation/system.constants.ts` kèm `min/max`, trong khối có comment `// PLAN-00yy`. **Mã quyền mới:** `identity/permission/catalog.ts` khối riêng + migration quyền nếu đổi preset.
7. **BE trước, FE sau:** trong một đợt, mọi phiên làm phần BE; xong cả đợt thì phiên điều phối dựng backend cô lập, chạy `api:sync` + `perms:sync` (admin, storefront) một lần; rồi các phiên làm phần FE. Không phiên nào tự chạy `api:sync` khi các phiên khác còn đang sửa BE.
8. **Test theo mã:** mọi kịch bản U của WP có test `it('[MÃ] …')`; mọi kịch bản S có file smoke `scripts/smoke/scenarios/<mã>.mjs` (WP-00 cung cấp khung); kịch bản B đi bằng trình duyệt tích hợp trên bản sao FE (không dùng chung tab với phiên khác).
9. **Cập nhật tài liệu cùng thay đổi:** `docs/06_FE_CONTRACT.md` (API), ký hiệu ✅ ở `docs/10` + `docs/11`, `docs/12` nếu đổi thao tác vận hành, checklist plan.
10. **Quyết định ngoài plan:** ghi vào mục "Quyết định phát sinh" của plan + nêu trong báo cáo; không âm thầm đổi luật ở `docs/10`.
11. **Done Definition (mỗi WP):** BE `npm run verify` xanh · admin `npm run verify` xanh · storefront `lint` + `typecheck` + `build` xanh · `migration:check` xanh · smoke các mã S của WP xanh · trình duyệt các mã B (ảnh chụp cho từng vai) · review độc lập (§7) đã xử lý · báo cáo theo mẫu §8.

### Mẫu lời giao việc (dán vào phiên mới)

```text
Bạn là phiên thực hiện WP-<xx> của PLAN-0023 (dự án FITLY: eco_backend + fashion_frontend_admin + fashion_frontend_user ở D:\Fullstack\eco_fashion).
Đọc theo thứ tự: eco_backend/docs/plans/PLAN-0023-order-lifecycle-go-live.md (§5–§8), eco_backend/docs/plans/<plan của WP>.md,
eco_backend/docs/10_ORDER_LIFECYCLE.md, các mã kịch bản của WP trong eco_backend/docs/11_SCENARIO_CATALOGUE.md, AGENTS.md của repo sẽ sửa.
Làm đúng phạm vi + file sở hữu trong plan; khoá file nóng ở PLAN-0023 §6 trước khi sửa. Không chạy git ghi, không đọc .env.
Kết thúc: Done Definition §5.11, cập nhật ký hiệu ở docs/10 và docs/11, tick checklist plan, báo cáo theo mẫu §8.
```

## 6. Khoá file nóng

File nhiều WP cùng sửa. Ghi khoá (WP, vùng hàm, giờ bắt đầu) trước khi sửa; xoá dòng khi xong. Thấy khoá của phiên khác trên cùng vùng ⇒ chờ hoặc làm phần khác.

| File | Vùng chia sẵn |
|---|---|
| `src/modules/order/order/service/order.service.ts` | WP-01: `placeOrder`, `cancelExpired`, `onPaid`, `onPaymentFailed` · WP-03: `updateStatus`, `cancel*`, `doCancel`, `autoComplete`, hàm mới SLA/địa chỉ/đã nhận · WP-07: nhánh `shipping`/`delivered` trong `updateStatus`, `deliveryFailed` · WP-08: kiểm tra trong `price`/`placeOrder` (sau WP-01) |
| `src/modules/order/order/service/shop-order.service.ts` | WP-03 (huỷ, gia hạn, yêu cầu huỷ) · WP-07 (giao, mã vận đơn) |
| `src/modules/order/order/controller/*.ts` | WP-03 (route khách/shop mới) · WP-05 (tìm kiếm admin) · WP-07 |
| `src/modules/order/order-worker.module.ts` | WP-03 sở hữu; WP-07 thêm job leo thang trong khối riêng |
| `src/modules/payment/payment/payment.service.ts` | WP-01 (initiate, settle, refund tự chi) · WP-06 (ghi ví khi thu COD/hoàn) · WP-10 (đối chiếu — file mới ưu tiên) |
| `src/modules/payment/shop-payout/shop-payout.service.ts` | WP-02 (thực thi chi: submit/retry/mark-paid/hold/run theo shop) · WP-06 (công thức kỳ: gross/hoa hồng/dòng ví) — WP-06 chạy SAU WP-02 |
| `src/modules/payment/shop-wallet/*` | WP-06 |
| `src/modules/identity/permission/catalog.ts` · `system/enums/setting-keys.ts` · `system/foundation/system.constants.ts` | mọi WP — chỉ thêm khối `// PLAN-00yy` |
| `docs/06_FE_CONTRACT.md` | mọi WP — chỉ sửa mục của mình |
| admin `src/lib/constants.ts`, `src/lib/labels.ts`, `src/components/layout/*` | mọi WP (FE) — thêm khối; header/sidebar: WP-04 sở hữu chuông |

**Khoá đang giữ:**

| File / vùng | WP | Từ lúc |
|---|---|---|
| _(trống)_ | | |

## 7. Review

### 7.1 Review độc lập từng WP (phiên riêng, chỉ đọc)

```text
Bạn là reviewer ĐỘC LẬP (chỉ đọc, không sửa, không chạy migrate/server) cho WP-<xx> (plan: eco_backend/docs/plans/<plan>.md) của dự án FITLY.
Xem thay đổi bằng `git diff` / `git status` (chỉ lệnh đọc). Đối chiếu với luật ở eco_backend/docs/10_ORDER_LIFECYCLE.md và các mã kịch bản của WP ở docs/11.
Tìm LỖI THẬT, ưu tiên: (1) tiền: hoàn/chi trùng, vượt trần, làm tròn, trạng thái "không rõ" cho phép làm tay; (2) đồng thời: thiếu khoá, job chạy chồng, race giữa người và job;
(3) quyền & cô lập shop: IDOR, shopId từ URL/body, vai làm việc không thuộc vai; (4) migration chạy trên dữ liệu thật; (5) thông báo sai người/thiếu/spam;
(6) FE: luật AGENTS.md (hook bọc Orval, 3 lớp quyền, không import chéo feature), trạng thái lỗi/rỗng/đang tải; (7) kịch bản trong docs/11 của WP chưa có test.
Mỗi phát hiện: file:dòng · 1 câu · kịch bản cụ thể → kết quả sai · mức (critical/high/medium/low) · độ chắc (đã lần đường đi / nghi ngờ). Không bịa; hạng mục không thấy lỗi ghi "không thấy". Tối đa 15 mục, xếp hạng.
```

Phiên thực hiện sửa mọi critical/high; medium/low sửa hoặc ghi "Còn mở" trong plan có lý do.

### 7.2 Review chéo (Đợt 4, trước UAT)

| Mã | Review | Trọng tâm | Khi |
|---|---|---|---|
| R1 | Dòng tiền | Lần mọi đường tiền vào/ra (thu PayOS, COD, hoàn, chi shop, ví, nợ, thuế); kiểm bất biến `docs/10` §10; idempotency mọi lệnh tiền; chạy lại job không đổi kết quả | sau WP-01/02/06/10 |
| R2 | Bảo mật & quyền | Ma trận `docs/10` §12 so với code (catalog + guard + FE gate); IDOR; bí mật; PII trong log/email; rate limit; webhook | sau Đợt 2 |
| R3 | Đồng thời & job | Mọi `@Cron/@Interval`: chồng lần, nhiều worker, khoá DB, thứ tự khoá, timeout HTTP trong tx; người vs job cùng lúc (CONC-*) | sau Đợt 2 |
| R4 | Trải nghiệm theo vai | Trình duyệt: mỗi vai đi trọn việc hằng ngày của mình (runbook §1) trên desktop + 390px; mọi trạng thái có chữ giải thích + hạn | trước WP-13 |
| R5 | Sẵn sàng vận hành | Diễn tập runbook §3 (ít nhất 3.1, 3.3, 3.5, 3.11, 3.12); cảnh báo tới đúng người; sao lưu/khôi phục | trong WP-13 |

## 8. Mẫu báo cáo cuối phiên

```text
WP-<xx> — <tên> — <Done | Còn mở>
1. File tạo/sửa/xoá (theo repo)
2. API mới/đổi (method path quyền body response) + mã lỗi mới
3. Migration + setting + mã quyền mới
4. Test: verify (số suite/test), smoke (mã PASS/FAIL), trình duyệt (vai × màn, ảnh)
5. Kịch bản docs/11 đã chuyển ✅ / còn 🔧🆕 và lý do
6. Quyết định phát sinh / lệch plan
7. Review độc lập: số phát hiện, đã sửa, còn mở
8. Việc cho phiên khác / chủ dự án
```

## 9. Truy vết lỗ hổng → WP

| # | Lỗ hổng | Mức | WP |
|---|---|---|---|
| G01 | Gọi PayOS (HTTP 8s) trong transaction đặt hàng đang giữ khoá sequence/voucher | Cao | 01 |
| G02 | Không đối chiếu chủ động PayOS; job huỷ đơn quá hạn không hỏi PayOS | Cao | 01 ✅ một phần (2026-10-27: hỏi PayOS trước khi huỷ; còn job poll định kỳ) |
| G03 | Trả thiếu/thừa chỉ ghi audit, không hoàn, không báo | Cao | 01 |
| G04 | Hoàn PayOS cần kế toán bấm, không thông báo, không tự chi | TB-Cao | 01 |
| G05 | Hạn link PayOS hằng số ≠ hạn đơn; thanh toán lại không gia hạn | TB | 01 |
| G06 | Email ghép nội dung người dùng không escape | Thấp | 04 |
| G07 | Mô tả chuyển khoản dài hơn giới hạn PayOS; **deadlock webhook ↔ khách huỷ đã tái hiện (E2E 2026-10-27, CONC-08: webhook HTTP 500, đơn `cancelled`/`unpaid`)** | **Cao** (đã xác nhận) → **ĐÃ SỬA 2026-10-27** (thứ tự khoá đơn → payment + thử lại deadlock; docs/13 §11) | 01 ✅ |
| G08 | Không SLA shop xác nhận/đóng gói/giao; đơn COD `pending` không hạn | Cao | 03 |
| G09 | Đơn `packing` không ai huỷ được | Cao | 03 |
| G10 | Shop bị khoá: đơn đóng băng (403 mọi `/shop/**`) | Cao | 03 |
| G11 | Khách không huỷ được sau `confirmed`; không đổi được địa chỉ | TB | 03 |
| G12 | Shop không được báo khi đơn bị huỷ (khách/hết hạn/sàn) | TB | 03 04 |
| G13 | Tự hoàn tất bỏ qua đổi trả mở; cron không múi giờ; khách không có "đã nhận hàng" | TB | 03 |
| G14 | Huỷ đơn `partially_refunded` không hoàn phần còn lại | Thấp | 03 |
| G15 | Shop huỷ kiểm trạng thái khi chưa khoá dòng (race với `shipping`) | Thấp | 03 |
| G16 | Nhóm đơn hiển thị tổng lúc đặt, không phản ánh đơn con đã huỷ | Thấp | 03 |
| G17 | NV shop không báo được giao thất bại nhưng nhận cảnh báo giao quá hạn | Thấp-TB | 03 |
| G18 | "Đã giao" không bằng chứng; khách chỉ 3 ngày báo chưa nhận ⇒ tiền chi cho shop | Cao | 07 |
| G19 | COD báo giao khi chưa thu; "chưa nhận hàng" tạo hoàn tiền mặt khách chưa từng trả | TB-Cao | 07 |
| G20 | Shop báo giao được khi khách đang báo chưa nhận | TB | 07 |
| G21 | Thất lạc/giao thất bại: không sửa được `goodsReturned`; cảnh báo không leo thang, > 90 ngày không báo | TB | 07 |
| G22 | Né hoa hồng COD: báo giao thất bại sau khi đã thu / để `shipping` mãi | Cao | 07 06 |
| G23 | Ví COD trừ hoa hồng trên (total + voucher sàn) nhưng không cộng voucher sàn ⇒ shop lỗ | Cao | 06 ✅ (2026-10-27) |
| G24 | Hoa hồng tính cả phí ship | TB | 06 ✅ (2026-10-27) |
| G25 | Không hạn mức dư nợ COD; ví âm không bù trừ vào chi trả PayOS | Cao | 06 |
| G26 | Sàn ứng tiền hoàn đơn COD, ví âm sâu không cảnh báo | TB | 06 |
| G27 | `transferRef` nộp cọc không duy nhất | TB | 06 ✅ (2026-10-27) |
| G28 | Nộp/duyệt cọc, ví thấp, COD tắt — không thông báo | TB | 06 04 |
| G29 | Không có rút cọc / đóng shop tất toán | TB | 06 |
| G30 | Lệnh chi timeout bị ghi `failed` ⇒ kế toán đánh dấu tay ⇒ chi trùng | Cao | 02 ✅ (2026-10-27) |
| G31 | Kỳ `processing` không có providerRef treo mãi | TB | 02 ✅ (2026-10-27: job đối chiếu cả `unknown` không mã lệnh) |
| G32 | Chạy lại sau thất bại dùng cùng idempotency-key | TB | 02 ✅ (2026-10-27) |
| G33 | Chữ ký lệnh chi chưa kiểm với PayOS thật; env production thiếu khoá chi; cron im lặng | Cao | 02 13 🔧 (chữ ký lệnh chi theo tài liệu — chưa kiểm PayOS thật; cron không khoá chi chưa báo kế toán) |
| G34 | Chi tự động không duyệt/hạn mức/kiểm số dư; mặc định bật | TB-Cao | 02 ✅ (2026-10-27: mặc định tắt cho DB mới, hạn mức duyệt; còn kiểm số dư PayOS) |
| G35 | Đổi TK ngân hàng không xác thực lại, không khớp tên, chỉ báo trong app, giữ 24h | Cao | 02 ✅ một phần (2026-10-27: bắt buộc nhập lại mật khẩu + chống dò 429; còn email chủ shop + khớp tên) |
| G36 | Shop bị khoá vẫn được chi | TB | 02 ✅ (2026-10-27) |
| G37 | `providerRef` kỳ chi không duy nhất | TB | 02 ✅ (2026-10-27) |
| G38 | Đối soát tải toàn bộ lịch sử mỗi đêm | TB | 02 |
| G39 | Kỳ bị giữ do đổi TK không tự gửi lại; chạy lại dùng TK cũ trong snapshot | Thấp-TB | 02 |
| G40 | `carriedDebt` đọc không khoá | Thấp | 02 ✅ (2026-10-27) |
| G41 | Chưa chạy đối soát được cho một shop | TB | 02 ✅ một phần (2026-10-27: API `shopId`; FE chưa) |
| G42 | Không đối chiếu cuối ngày với PayOS/sao kê | Cao | 10 |
| G43 | Báo cáo lệch (hoàn đủ trừ đôi), không có báo cáo hoa hồng, chỉ tính lại 14 ngày | TB | 10 |
| G44 | Không xuất CSV cho kế toán (đơn, hoàn, chi, ví) | TB | 05 10 |
| G45 | Thuế / hoá đơn | — | ngoài phạm vi (demo) |
| G46 | Thông tin doanh nghiệp / pháp lý trên web | — | ngoài phạm vi (demo) |
| G47 | Web quản trị không có chuông/hộp thư | Cao | 04 |
| G48 | Không email cho shop và nhân viên sàn | Cao | 04 |
| G49 | Thông báo thiếu người (hoàn mới, tiền lệch, chi lỗi, cọc…), gửi theo quyền đã bỏ, spam mỗi đơn con | TB | 04 |
| G50 | Email qua Gmail cá nhân (~500 thư/ngày) | TB | 04 |
| G51 | CSKH không tìm đơn toàn sàn (phải chọn shop; không tìm theo nhóm/email) | Cao | 05 |
| G52 | Không cảnh báo khi hệ thống lỗi; worker không healthcheck; outbox `FAILED` không màn | Cao | 05 |
| G53 | Không xem được audit của order/payment | TB | 05 |
| G54 | Dashboard thiếu số đếm hàng đợi (hoàn lỗi, chi lỗi, cọc chờ, đổi trả shop) | TB | 05 |
| G55 | Sao lưu hằng ngày chỉ là hướng dẫn tay | TB | 05 |
| G56 | Nhiều worker ⇒ job chạy trùng (nghi ngờ) | TB | 05 |
| G57 | Không smoke/e2e/test FE | TB | 00 |
| G58 | Tài liệu lệch code (COD do ai thu, route admin đổi trạng thái, đối chiếu payout) | Thấp | 00 |
| G59 | Không chống bom COD / giới hạn khách mới | TB | 08 |
| G60 | Giá đổi giữa lúc xem và lúc đặt không cảnh báo | TB | 08 |
| G61 | Lách đơn tối thiểu voucher sàn bằng huỷ một đơn con; farm voucher nhiều tài khoản | TB-Thấp | 08 |
| G62 | Đọc giỏ/trạng thái shop ngoài transaction | Thấp | 08 |
| G63 | Địa chỉ không kiểm phường/xã; phí ship theo tỉnh | TB | 08 15 |
| G64 | Giao thiếu/sai một phần không có lý do phù hợp | TB | 09 |
| G65 | PLAN-0022 còn mở: TK bổ sung, công khai hạn, xem trước, phí ship đổi trả, `customerName`, job chữa | TB | 09 |
| G66 | `sold_count` không trừ khi trả; đánh giá không có hạn | Thấp | 09 |
| G67 | Xoá / ẩn danh dữ liệu cá nhân; audit chống sửa | — | ngoài phạm vi (demo) |
| G68 | Mỗi đơn con một QR | TB | 14 |
| G69 | Không tích hợp hãng vận chuyển | TB | 15 |
| G70 | Sàn chặn bán sản phẩm khi đơn đang xử lý không cảnh báo | Thấp | 03 |
| G71 | Mật khẩu tài khoản mẫu công khai — nguy hiểm khi bật chi tiền thật (ai cũng đăng nhập shop và đổi TK nhận tiền) | Cao | 13 |
| G72 | Bật SLA lần đầu có thể huỷ hàng loạt đơn cũ | Cao | 03 |
| G73 | Mã kỳ chi `PAY-<yymmdd>-<yymmdd>-<shop>` trùng khi chạy lần 2 trong ngày cho cùng shop ⇒ "Đã tạo 0 kỳ", đơn mới bị bỏ sót (E2E STL-16x, AUD-02) | Cao | 02 ✅ (2026-10-27: hậu tố chữ `-B`, `-C`…) |
| G74 | `run` kiểm trùng/chồng khoảng toàn cục, không theo shop (AUD-08) | TB | 02 |
| G75 | "Mở giữ" khi shop còn khoá trả 200 im lặng, không 409 kèm lý do (STL-12b2) | Thấp | 02 |
| G76 | Kỳ `deferred` đã cộng sang kỳ sau vẫn mang trạng thái `deferred` — dễ hiểu nhầm "chưa trả"; cần `merged` (STL-04d) | Thấp | 02 |
| G77 | Màn đối soát kế toán lạc hậu: spec FE thiếu `approve/reconcile/release`; thiếu tab `awaiting_approval/held/unknown/deferred`; kỳ `held` không nêu lý do; kế toán không có `shop.read` ⇒ cột shop hiện mã rút gọn (backend nên trả `shopName`/`shopCode`) (AUD-09) | TB-Cao | 02 FE |
| G78 | Ghi sổ hoàn tay với `providerRef` tự nhập không đối chiếu PayOS (AUD-14) | Thấp-TB | 01 02 |
| G79 | Form huỷ đơn đã thanh toán không nói trước tiền hoàn về đâu/bao lâu (AUD-15) | Thấp | FE khách |
| G80 | PLAN-0030 §2.2 từng ghi sai công thức gốc hoa hồng (`+ platform_item_discount`); code và docs/10 đúng — **đã sửa** (AUD-16) | Thấp | 06 ✅ |
| G81 | PayOS lỗi/timeout khi tạo link ⇒ đơn KHÔNG được tạo và trả 503 `PAYMENT_PAYOS_NOT_CONFIGURED` (sai nghĩa; trái CK-15) (E2E CK-15) | TB | 01 |
| G82 | `/health` trả HTTP 200 khi DB DOWN; worker chết vẫn `UP` (OPS-04d/01y) | TB | 05 |

## 10. Theo dõi

- [x] **Audit E2E toàn luồng (2026-10-27)** — đã chạy trên backend cô lập + PayOS giả + trình duyệt — **báo cáo `docs/13_E2E_TEST_REPORT.md`**, kết quả từng mã ở cột HT của `docs/11`, harness ở `plans/assets/e2e-audit/`. Mở thêm G73–G82.
- [x] **3 lỗi P0 của audit đã sửa + kiểm chứng trên Postgres thật (2026-10-27)** — AUD-01 deadlock webhook↔huỷ (code cũ 12/12 deadlock → 0), AUD-02 mã kỳ chi trùng, AUD-03 đổi TK phải nhập lại mật khẩu (có cả form web quản trị, đã thử trên trình duyệt). Chạy lại toàn bộ bộ audit trên DB sạch: **290 ✔ · 18 ✘ · 33 ℹ / 341 mã**, 18 ✘ đều là việc đã có trong plan, không hồi quy; jest 1967/1967, lint/tsc/boundaries xanh, `next build` xanh (docs/13 §11). **Chưa commit/deploy.** Còn P1 chặn tiền thật: AUD-04/05/06 (WP-01), AUD-10 (WP-03).
- [ ] Đợt 0: WP-00 — **chưa làm** (chưa có `scripts/test-env`, smoke, PayOS giả trong repo; test đang là jest thuần; có harness audit `assets/e2e-audit` làm nền)
- [ ] Đợt 1 BE: WP-01 **một phần** (§2.3: hỏi PayOS trước khi huỷ đơn quá hạn) · WP-02 **phần lớn** (xem PLAN-0026 §4: còn đổi TK, giữ tay, lịch tuần, số dư PayOS) · WP-03 · WP-04 · WP-05 **chưa làm** → đồng bộ API → Đợt 1 FE (mới có nhãn trạng thái kỳ chi)
- [ ] Đợt 2 BE: WP-06 **một phần** (công thức hoa hồng/ví, ngưỡng, `transferRef`; còn bù trừ ví↔kỳ chi, nợ quá hạn, rút cọc, sao kê) · WP-07 · WP-08 **chưa làm** → đồng bộ API → Đợt 2 FE
- [ ] Đợt 3 BE: WP-09 · WP-10 → đồng bộ API → Đợt 3 FE
- [ ] Đợt 4: R1 · R2 · R3 · R4 → WP-13 (gồm R5) → **test end-to-end bằng tiền thật**
- [ ] Đợt 5: WP-14 · WP-15
