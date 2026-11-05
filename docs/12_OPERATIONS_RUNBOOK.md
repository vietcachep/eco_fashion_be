# 12 — Sổ tay vận hành (runbook) vòng đời đơn

> Luật: `docs/10_ORDER_LIFECYCLE.md`. Kịch bản: `docs/11_SCENARIO_CATALOGUE.md`. Deploy/CD: `docs/08_DEPLOY.md`, `docs/09_CD.md`.
> Mục ghi "(sau WP-xx)" chỉ làm được khi WP đó xong; trước đó dùng cách tạm ghi kèm.
> Điền các ô `<…>` trước go-live (WP-13).

## 1. Việc hằng ngày theo vai

| Vai | Mở màn nào | Việc | Hạn xử lý nội bộ |
|---|---|---|---|
| **CSKH** | `/order/returns?status=escalated` · hàng đợi "nghi thất lạc" (sau WP-07) · `/system/contacts` · chuông (sau WP-04) | Phân xử đổi trả; xử lý ca thất lạc (huỷ + hoàn); trả lời liên hệ; mở khoá COD cho khách khiếu nại hợp lệ (sau WP-08) | Phân xử ≤ 48 giờ; liên hệ ≤ 24 giờ |
| **Kế toán** | `/payment/refunds?needsManual=true` · `/payment/refunds?status=failed` · `/shop/payouts` (kỳ chờ duyệt / thất bại) · `/shop/wallets` (nộp cọc chờ duyệt) · hàng đợi "lệch đối chiếu" (sau WP-10) | Chuyển khoản tay + nhập mã giao dịch; duyệt kỳ chi lớn; đối chiếu sao kê PayOS mỗi sáng; duyệt nộp cọc | Hoàn tay ≤ 1 ngày làm việc; duyệt kỳ chi trước 12:00 ngày chi |
| **Quản lý** | Dashboard sàn · danh sách shop vi phạm (sau WP-03) | Xem shop ngâm đơn / điểm vi phạm; quyết định cảnh cáo / khoá; duyệt shop mới | Hằng ngày |
| **Admin / kỹ thuật** | `/health`, `/health/worker` (sau WP-05) · log `docker compose logs api worker` · màn outbox lỗi (sau WP-05) | Theo dõi cảnh báo; phát lại outbox lỗi; kiểm sao lưu đêm | Cảnh báo đỏ: phản hồi ≤ 30 phút giờ hành chính |
| **Shop** | `/vendor/orders` · `/vendor/returns` · `/vendor/wallet` · chuông | Xác nhận ≤ 24h, giao ≤ 48h (nhập hãng + mã vận đơn), xử lý đổi trả ≤ 72h, giữ ví cọc ≥ mức tối thiểu | Theo setting |

## 2. Lịch định kỳ

| Khi | Ai | Việc |
|---|---|---|
| Mỗi sáng | Kế toán | Đối chiếu giao dịch PayOS hôm qua với `/payment/payments` (tự động sau WP-10 — chỉ xử lý dòng lệch) |
| Thứ Hai | Hệ thống 02:00 → Kế toán | Kỳ chi tuần được tạo; KT duyệt kỳ > `payout.auto_max_amount`; xem kỳ `failed`/`unknown`/`held` |
| Thứ Hai | Quản lý | Xem top shop vi phạm SLA, tỉ lệ huỷ, tỉ lệ giao thất bại COD |
| Ngày 1 hằng tháng | Kế toán | Xuất báo cáo hoa hồng + CSV đối chiếu tháng (sau WP-10) |
| Hằng tháng | Kỹ thuật | Diễn tập khôi phục sao lưu (OPS-05); xoá ảnh/upload rác theo chính sách |
| Hằng quý | Admin | Xoay vòng khoá PayOS/SMTP/JWT nếu nghi lộ; rà quyền nhân viên |

## 3. Xử lý sự cố (playbook)

### 3.1 Khách báo "đã chuyển tiền nhưng đơn bị huỷ / vẫn chờ thanh toán"
1. Tìm đơn theo mã/SĐT (sau WP-05: tìm toàn sàn; trước đó chọn đúng shop).
2. Xem payment: `paid` ⇒ hướng dẫn khách tải lại. `pending`/`cancelled` ⇒ tra giao dịch trên trang quản trị PayOS theo mã đơn.
3. PayOS có tiền: sau WP-01 bấm "Đối chiếu lại với PayOS" trên đơn; trước đó chạy `node scripts/dev/simulate-payos-webhook.mjs` KHÔNG dùng trên production — báo kỹ thuật ghi nhận bằng tay qua audit.
4. Đơn đã huỷ mà tiền về ⇒ hệ thống tạo hoàn (PAY-06). Báo khách thời gian hoàn.

### 3.2 PayOS sập / webhook không về
- Dấu hiệu: nhiều đơn PayOS `pending` quá hạn, trang PayOS lỗi.
- Tạm thời: setting tắt phương thức PayOS (`/payment/methods`) để khách dùng COD; đăng thông báo banner.
- Sau khi PayOS trở lại: job đối chiếu (sau WP-01) tự ghi nhận đơn đã trả; kiểm hàng đợi lệch (sau WP-10).

### 3.3 Lệnh chi / hoàn tiền PayOS "không rõ kết quả"
- KHÔNG chuyển tay ngay. Mở trang quản trị PayOS, tìm theo `referenceId` (mã kỳ hoặc `refundId`).
- PayOS đã chi ⇒ nhập mã giao dịch PayOS để ghi sổ (hệ thống ghi sổ, không chi lại).
- PayOS chưa chi/huỷ ⇒ bấm "Chạy lại" (khoá mới). Chỉ chuyển tay khi lệnh PayOS đã ở trạng thái thất bại/huỷ.
- **Kỳ chi trả (PLAN-0026, đã có trong code):** kỳ ở trạng thái `unknown` hoặc `processing` ⇒ bấm **"Kiểm tra với PayOS"** (`POST /admin/payouts/:id/reconcile`; job 5 phút cũng tự làm). Kết quả: `paid` (PayOS đã chi) · `failed` (PayOS từ chối chắc chắn ⇒ "Chạy lại" dùng khoá MỚI `<mã kỳ>-<n>`) · `failed/not_received` (PayOS chưa nhận lệnh, đã chờ ≥ 10 phút ⇒ "Chạy lại" dùng CÙNG khoá, an toàn) · vẫn `processing` ⇒ chờ.
- **Đánh dấu tay** (`mark-paid`) từ `processing`/`unknown` bị chặn (409 `PAYOUT_GATEWAY_NOT_CONFIRMED`) trừ khi kế toán tick "đã tra bảng điều khiển PayOS: lệnh KHÔNG được thực hiện" (`confirmGatewayNotExecuted`). Mã giao dịch nhập vào phải duy nhất (409 nếu đã dùng cho kỳ khác).
- Kỳ `awaiting_approval` (vượt `payout.auto_max_amount`) ⇒ kế toán/admin bấm **Duyệt** (`supplier.payout.approve`). Kỳ `held` (shop bị khoá / vừa đổi TK) tự mở khi hết lý do; có thể bấm **Mở giữ**. Kỳ `deferred` (dưới `payout.min_amount`) không cần làm gì — dồn sang kỳ sau.
- Trước khi deploy migration `20261027100000_payout_safety` kiểm mã chi trùng: `SELECT provider_ref, count(*) FROM payment.shop_payouts WHERE provider_ref IS NOT NULL GROUP BY 1 HAVING count(*) > 1;` (phải rỗng, nếu không tạo UNIQUE sẽ lỗi).

### 3.4 Hoàn tiền thất bại / cần chuyển tay
- `needsManual` + "chưa có tài khoản nhận hoàn" ⇒ gọi khách theo SĐT trong đơn, xin TK (sau WP-09 khách tự bổ sung trên web), chuyển khoản, nhập mã giao dịch (duy nhất).
- Bấm "Xem số TK" chỉ khi chuẩn bị chuyển (mỗi lần xem đều ghi audit).

### 3.5 Worker / job không chạy
- Giám sát bên ngoài: `GET /api/v1/health` (503 khi DB hoặc Redis chết) và `GET /api/v1/health/worker` (503 khi worker không đánh nhịp tim > 60 giây).
- Dấu hiệu: đơn PayOS quá hạn không bị huỷ, email không đi, `/health/worker` đỏ (sau WP-05).
- `docker compose --env-file .env.production -f docker-compose.prod.yml ps worker` → `logs --tail 200 worker` → `up -d worker`.
- Sau khi chạy lại: job tự bắt kịp (đều quét theo hạn, idempotent). Kiểm outbox lỗi.

### 3.6 Email không gửi / outbox lỗi
- Kiểm hạn mức nhà cung cấp email (Gmail cá nhân ~500 thư/ngày — phải thay bằng dịch vụ email giao dịch trước go-live, WP-04).
- Sau WP-05: màn outbox lỗi → phát lại sau khi sửa nguyên nhân.

### 3.7 Shop ngâm đơn / mất liên lạc
- Trước WP-03: CSKH gọi shop; nếu không xử lý — huỷ đơn `pending`/`confirmed` bằng quyền sàn (đơn `packing` CHƯA huỷ được trước WP-03: báo kỹ thuật).
- Sau WP-03: khi `order.sla_enabled` = true hệ thống tự huỷ theo hạn (quá hạn xác nhận / giao, yêu cầu huỷ im lặng quá `order.cancel_request_hours` ⇒ tự chấp nhận); QL xem điểm vi phạm (`/shop/violations`, tab Vi phạm ở chi tiết shop), cân nhắc khoá shop: hộp thoại khoá hiện số đơn mở — đơn `pending`/`confirmed` tự huỷ + hoàn tiền, đơn `packing`/`shipping` giữ nguyên và CSKH nhận MỘT thông báo để huỷ tay từng đơn; tiền chi trả bị giữ.

### 3.8 Nghi gian lận phía shop
| Dấu hiệu | Hành động |
|---|---|
| Báo "đã giao" nhưng nhiều khách báo chưa nhận | Giữ chi trả shop (sau WP-02), yêu cầu shop cung cấp bằng chứng hãng vận chuyển, phân xử từng ca |
| Tỉ lệ giao thất bại COD cao (né hoa hồng) | Kiểm mã vận đơn với hãng; trừ hoa hồng bằng chỉnh ví tay (admin, có lý do) nếu chứng minh khách đã nhận |
| Đổi TK ngân hàng bất thường | Liên hệ chủ shop qua SĐT/email đã đăng ký trước khi hết thời gian giữ; giữ tay kỳ chi |
| Một mã vận đơn cho nhiều đơn | Cảnh báo (sau WP-07) → kiểm từng đơn |

### 3.9 Nghi gian lận phía khách
- Bom COD nhiều lần ⇒ hệ thống tự khoá COD (sau WP-08); CSKH mở khoá khi khách khiếu nại có căn cứ.
- Nhiều tài khoản dùng voucher sàn từ cùng SĐT/địa chỉ ⇒ báo marketing giảm lượt/tắt mã; (giai đoạn 2: giới hạn theo SĐT).
- Đổi trả lặp bất thường ⇒ CSKH xem lịch sử đổi trả của khách trước khi phân xử.

### 3.10 Lộ khoá / bí mật
1. Đổi khoá ở nhà cung cấp (PayOS: tạo khoá mới cả kênh thu và kênh chi; SMTP; Google; Cloudinary).
2. Sửa `deploy/.env.production` trên máy chủ → `docker compose … up -d`.
3. Đổi `EF_JWT_SECRET` ⇒ mọi phiên đăng nhập mất (báo người dùng).
4. Kiểm audit/log trong khoảng nghi lộ.

### 3.11 Deploy lỗi / cần lùi
- Theo `docs/09_CD.md` §4: lỗi code ⇒ `IMAGE=<tag cũ> ./deploy-remote.sh`; lỗi dữ liệu do migration ⇒ restore bản `/root/backups/fitly-pre-*.dump` (mất dữ liệu sau thời điểm sao lưu — chỉ khi thật cần).

### 3.12 Mất dữ liệu
- Sao lưu đêm tự động + chép ra ngoài máy chủ (sau WP-05). Khôi phục theo `docs/08_DEPLOY.md`; ghi biên bản (thời điểm, dữ liệu mất, ai duyệt).

### 3.13 Nạp cọc PayOS bất thường (kế toán)
- Khoản nạp cọc qua PayOS **tự ghi có vào ví**, không cần duyệt tay (màn `/shop/wallets`, tab "Nạp qua PayOS"; duyệt hoặc từ chối nhầm id khoản PayOS ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL`).
- Thừa, trả trùng, về muộn sau khi link đã đóng, hoặc kết thúc thiếu: tiền ĐÃ vào ví đúng số thực nhận, **KHÔNG hoàn tự động**. Hệ thống gửi thông báo cho kế toán (người có `supplier.wallet.approve`); khi kết thúc thiếu thì báo đúng một lần lúc đóng link.
- Đối chiếu sao kê PayOS bằng `payosOrderCode` (mã dải `5…`) và danh sách `receipts` (`reference`, `amount`) của khoản nạp (`GET /admin/wallet-topups/{id}`).
- Shop đòi lại tiền đã nạp (chuyển nhầm), PayOS đảo hoặc hoàn một giao dịch đã báo thành công, hoặc nghi tiền bẩn ⇒ xử lý TAY: hoàn qua bảng điều khiển PayOS, rồi admin chỉnh ví `adjust` âm có lý do (`POST /admin/shops/{shopId}/wallet/adjust`). Hệ thống KHÔNG tự trừ ví, kể cả khi PayOS báo thấp hơn lúc dò (có thể do PayOS trễ).
- Khoản kẹt `creating` quá 90 giây mà PayOS không có link: job (mỗi 2 phút) tự đóng thành `failed`, không cần làm gì.
- Dừng tạo link nạp mới: tắt cờ `wallet.payos_deposit_enabled` (link đang chờ vẫn ghi có khi tiền về).

## 4. Trước khi test tiền thật end-to-end (tóm tắt — chi tiết PLAN-0037 §3)

- [ ] Toàn bộ WP mức P0 xong và review đạt; kịch bản S xanh; UAT M ký đủ vai.
- [ ] Tài khoản tham gia test tiền thật (admin, kế toán, CSKH, shop T) đã đổi mật khẩu riêng; shop mẫu khác không có TK ngân hàng (giữ dữ liệu demo).
- [ ] Khoá PayOS thật (thu + chi), webhook URL đăng ký, giao dịch thật nhỏ: thu → hoàn → chi shop đều thành công.
- [ ] Email: Gmail đủ cho demo (~500 thư/ngày); vượt mức thì đổi nhà cung cấp (chỉ đổi biến `EF_MAIL_*`).
- [ ] Cảnh báo kỹ thuật, sao lưu đêm, diễn tập khôi phục.
- [ ] `payout.auto_enabled` chỉ bật sau 2 kỳ chi tay thành công.
- [ ] `refund.auto_max_amount` (mặc định 2.000.000đ): hoàn nhỏ của đơn PayOS tự chi qua PayOS. **Đặt 0 (tắt) cho tới khi một lệnh hoàn thật đã thành công qua PayOS thật**; hoàn của đơn COD KHÔNG BAO GIỜ tự chi (kế toán duyệt tay).
- [ ] `order.sla_enabled` (mặc định TẮT): hạn xác nhận 24h / giao 48h luôn được ghi nhưng job chỉ tự huỷ khi bật. Chốt ngày bật với chủ dự án; lần đầu bật hệ thống tự dời các hạn đã trễ sang "bây giờ + số giờ" (không huỷ hàng loạt).
- [ ] Người trực trong đợt test tiền thật theo §5; ngoài đợt test tắt PayOS nếu trang mở cho người ngoài.

## 5. Liên hệ & leo thang

| Việc | Người phụ trách | Liên hệ |
|---|---|---|
| Kỹ thuật (API/worker/DB) | `<tên>` | `<SĐT / Telegram>` |
| PayOS (tài khoản doanh nghiệp) | `<tên>` | hỗ trợ PayOS: `<…>` |
| Kế toán trưởng | `<tên>` | `<…>` |
| CSKH trưởng | `<tên>` | `<…>` |
| Quyết định khoá shop / pháp lý | `<tên>` | `<…>` |

## PLAN-0043 — vận hành vận chuyển

- Creating/unknown: dùng Kiểm tra lại hoặc chờ worker; không tạo mã mới khi chưa rõ kết quả. Cùng attempt dùng client code cũ để tìm vận đơn hãng đã nhận.
- Hãng huỷ trước lấy: shop tạo yêu cầu mới sau khi attempt cũ đóng. Đã picked không huỷ/nhập kho trực tiếp; trả hàng chỉ restock khi returned xác minh.
- COD đã thu/chưa tiền về: kế toán đối chiếu chứng từ rồi xác nhận đúng tổng/mã nhận; không nhập mã tuỳ ý để đẩy payout. Khoản hoàn carrier COD chưa remitted không được chi.
- Theo dõi danh sách /shipping/shipments cho quá hạn lấy, chưa rõ kết quả, exception/lost và lỗi inbox. Không xoá inbox để làm mất lỗi; reconcile chạy cùng đường xử lý.
- Demo dùng FakeCarrierState DB riêng + simulator non-production; staging GHN là lượt kiểm riêng. Dữ liệu/tiến trình E2E phải cô lập và dọn sau kiểm. Không giả lập trạng thái của vận đơn GHN thật.
