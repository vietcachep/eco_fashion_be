# FITLY Live: cấu hình và kiểm thử

Phạm vi hiện tại là demo A+B PLAN-0045: một phiên công khai và một rehearsal của shop khác, camera/micro720p, danh sách sản phẩm tối đa50, hiển thị15mỗi trang. Guest xem được public; cần đăng nhập trước chat, nhận voucher hoặc mua hàng. Dữ liệu media, số người xem, chat, mã ưu đãi và đơn hàng đều phát sinh từ thao tác thực.

## Khởi động

1. Chạy migration và sync permissions. Cấp các quyền `shop.livestream.*` phù hợp cho thành viên; moderator còn phải được chủ shop chỉ định vào từng phiên. Seed chỉ thêm một bản nháp FITLY Official, không thêm phiên đang live.
2. Điền ba biến EF_LIVEKIT_* ở API/worker. Với self-host sử dụng `deploy/livekit.example.yaml`, bắt buộc `room.auto_create:false`, HTTPS/WSS và cấu hình mạng WebRTC/TURN theo môi trường. File chỉ là mẫu cấu hình, chưa tự triển khai LiveKit trong compose production.
3. Đăng ký webhook `/api/v1/livestreams/media/webhook` tại provider với API key ký đúng. Đảm bảo proxy giữ nguyên raw body và Authorization.
4. Chạy API và worker; thêm hai origin FE vào EF_CORS_ORIGINS. Socket.IO dùng namespace `/live`, handshake kiểm JWT + session/admission. Chat chỉ đi qua BE; media token không cho phép gửi data trực tiếp.

## Luồng kiểm thử

Chủ shop tạo nháp, chọn sản phẩm của chính shop, chỉ định moderator, rehearsal rồi kết thúc rehearsal. Bản công khai vẫn còn nháp/lịch. Khi phát công khai, state `starting` chỉ chuyển `live` sau webhook track camera thật hoặc worker đối soát track thật; chưa phát hình không mở nhận voucher.

Người xem vào `/live`, xin viewer-session, gửi heartbeat20giây; admission hết hạn60giây. Chủ shop ghim sản phẩm/tin nhắn; moderator nhắn, trả lời, xoá và mute theo quyền. Kiểm tra người dùng khác shop không quản lý được phiên. Sản phẩm ngoài trang hiện tại vẫn hiển thị đầy đủ tại pinnedProduct.

Đăng nhập để xin source-grant cho sản phẩm/số lượng rồi thêm giỏ hoặc mua ngay. Nguồn mua được BE ràng buộc owner/product/quantity và hạn24giờ từ startedAt. Nhận voucher chỉ khi phiên live và admission còn hiệu lực; preview/order phải tính lại điều kiện. Các quy tắc voucher huỷ/trả hàng nằm trong PLAN-0045 final-decisions và module promotion/order.

Thử mất kết nối host, khôi phục trong90giây, hết grace, kết thúc, force-stop và provider lỗi. UI phải phân biệt trạng thái nghiệp vụ đã kết thúc với mediaStopStatus pending/failed/confirmed. Worker retry stop; webhook terminal không hồi sinh phiên. Với self-host, thử dùng lại token sau xoá phòng: phải bị từ chối do `room.auto_create:false`.

## Bộ audit local cách ly

`scripts/audit/live-fixtures.ts` chỉ chấp nhận DB `fitly_live_audit` localhost55446, tạo tài khoản/catalog cần thiết và ghi JWT vào file TEMP riêng. `live-media-browser.cjs` dùng hai browser context Chrome riêng để phát canvas/WebAudio qua LiveKit thật và xác nhận viewer decode frame/audio; không chứng minh camera phần cứng hay tải production. `live-commerce-audit.ts` kiểm nguồn mua, idempotency, giỏ, voucher và phục hồi sau huỷ COD qua HTTP thật.

Không chạy các helper này vào DB ứng dụng. Sau audit phải dừng API/worker/FE/browser riêng, xoá file token TEMP, profile Chrome audit và ba container `fitly-live-db-audit`, `fitly-live-redis-audit`, `fitly-live-media-audit` cùng volume audit. Không prune Docker hoặc dừng process không thuộc audit.

`scripts/audit/start-live-audit.ps1 -Target api|worker` cung cấp toàn bộ biến audit riêng (DOTENV_CONFIG_PATH=NUL, DB55446/Redis56392/API4006); không dùng để triển khai. `live-realtime-audit.cjs` kiểm socket owner/cross-shop và pin qua worker/Redis. Đặt `FITLY_AUDIT_TERMINAL_REPLAY=true` khi chạy media harness để kiểm admin force-stop và từ chối host token cũ sau xoá phòng.

## Bằng chứng local ngày2026-11-06

Đã kiểm migration50bước, drift `No difference detected`, seed livestream hai lần chỉ còn một nháp. Bộ unit core10/10 gồm JWT grants thật, chữ ký/hash webhook, rehearsal isolation, nguồn mua và claim-v-stop sau khoá session. Media audit trên LiveKit self-host1.13.11 đã nhận hình/audio giữa hai browser context (640×360 và320×180, ít nhất4frame decoded); terminal replay từ host token chưa hết hạn bị từ chối với `room.auto_create:false`, mediaStopStatus confirmed. Socket cross-shop bị từ chối và outbox ghim đã đi qua worker/Redis tới room có quyền. SMTP audit không có Mailpit1025 nên email đơn retry, không gửi ra ngoài.

Đây là kiểm chức năng local với canvas/audio tổng hợp qua WebRTC thật, chưa phải benchmark số người xem, mạng Internet/TURN, thiết bị camera thực hay nghiệm thu LiveKit Cloud.

Audit bổ sung đã kiểm admission10 và request thứ11 trả409,30heartbeat từ cùngIP không bị429, lấy admission bằng guest key khác trả403, guest không được mời vào rehearsal trả404. Đây là kiểm quota/xác thực qua HTTP, không phải10luồng media đồng thời. `live-discovery-audit.cjs` tạo17phiên lịch cách ly:16khớp leafcategory trả pages15+1/total16, không trùng; category không tồn tại trả0; q tìm được tên shop dù title không chứa từ tìm kiếm. Tất cả phiên lịch audit được huỷ sau kiểm.
