# PLAN-0045 — Quyết định cuối cho FITLY Live bản demo

> Status: Implemented — đối chiếu bằng chứng và giới hạn tại PLAN-0045-livestream-implementation.md
> Ngày: 2026-11-06
> Thẩm quyền: chủ dự án giao Codex tự chốt khuyến nghị, bỏ yêu cầu giống Shopee hoàn toàn; sau đó đã yêu cầu triển khai code song song bằng agent.
> Đọc cùng [kế hoạch tổng](PLAN-0045-livestream-commerce-design.md) và [biên bản rà soát](PLAN-0045-livestream-review-2026-11-06.md). Nếu mô tả cũ còn là đề xuất/chờ chốt thì quyết định trong tài liệu này có ưu tiên.

## 1. Phạm vi đã chốt

Sản phẩm là **FITLY Live**, livestream bán hàng tích hợp sàn hiện tại. Shopee là nguồn tham khảo UX, không phải chuẩn pixel/nhãn/bố cục bắt buộc và không cần đăng nhập Shopee để mở cổng triển khai.

Phạm vi giao bản demo là **A+B** của ma trận L01–L33: phát/xem thật, phát thử riêng, khám phá/lịch/follow, chat/moderation/tim/share/report, giỏ live/ghim/biến thể, mua ngay tách giỏ, nguồn lượng hàng, voucher live, player thu nhỏ trong web khi phù hợp, quản trị dừng/hạn chế live và báo cáo theo đơn thật. A và B là hai mốc kỹ thuật của cùng phạm vi, không phải bỏ phần B khỏi bản hoàn chỉnh.

Gói C là backlog ngoài bản demo: ghi hình/replay, OBS, xu, game/đấu giá, affiliate/KOL, đồng dẫn. Combo/quà tặng và giá flash-deal riêng cũng không nằm trong bản demo. Không hiển thị nút rỗng; không phụ thuộc các plan C để hoàn tất A+B. Phân tích thiết kế sâu của C chỉ thực hiện khi có yêu cầu mới.

Chỉ chủ shop/nhân viên được cấp quyền phát hàng của chính shop; không cho KOL gắn hàng shop khác. Web/mobile browser là nền tảng mục tiêu, không cam kết capture khi khoá máy hoặc player hoạt động xuyên website PayOS.

## 2. Các giá trị vận hành mặc định

| Mục | Giá trị thiết kế đã chốt cho demo |
|---|---|
| Media | LiveKit Cloud, adapter riêng; không tự host media trên VPS bản đầu |
| Quy mô | 1 phiên public cùng lúc toàn demo, mỗi room1publisher, public tối đa10 kết nối viewer; không phải10 user mỗi user nhiều tab |
| Chất lượng | Mục tiêu720p/30fps; thích nghi xuống thấp khi SDK/mạng cho phép; không tự hứa độ trễ đạt trước khi đo |
| Phiên live | Tối đa60 phút, UI báo mốc kết thúc; thời gian tuyệt đối từ BE, reconnect không reset |
| Phát thử riêng | Tối đa10 phút, chỉ host+người thử được mời, tối đa2 viewer; không công khai/đặt đơn/voucher/replay |
| Mất media host | Grace90 giây; hết hạn thì kết thúc, không tự tạo phiên khác |
| Khởi động | Timeout60 giây chờ media; thất bại về nháp, dọn room/token dở |
| Intent mua | Hết hạn sau30 phút không hoạt động chỉ khi chưa submitting; không được expire/xoá attempt unknown để tạo lại, và không coi là giữ kho |
| Nhận voucher | Chỉ trong live, có admission hợp lệ và tài khoản; mỗi người1 claim/campaign |
| Hạn dùng voucher | redeemUntil=actualStartedAt+24 giờ, cố định theo campaign; nhận muộn/restore không kéo dài |
| Sản phẩm/phiên | Tối đa50 sản phẩm active của shop, phân trang15 dòng; số hàng cố định tách thứ tự |
| Chat | Tối đa300 ký tự/tin,3 tin/10 giây/actor/phiên; giới hạn do BE, client chỉ phản hồi UX |
| Snapshot chat |20 tin gần nhất, lịch sử cursor tối đa50 tin/lần; snapshot lọc tin đã xoá |
| Retention | Chat thô30 ngày; presence chỉ TTL60 giây và heartbeat20 giây; pointer admission chưa gắn giao dịch24 giờ |
| Chứng từ | Order/payment/usage/attempt thành công và chứng cứ moderation gắn vụ xử lý không bị job chat/presence xoá; theo retention chứng từ hiện hành |

Các giá trị là cấu hình server có validation, không hardcode rải trong FE. Redis presence không phải nguồn quyền voucher. Admission đã gắn claim/order giữ tham chiếu tối thiểu phục vụ chứng từ; không giữ nguyên dữ liệu presence thô vô hạn. Scheduled session không tự mở camera;60 phút tính từ actualStartedAt.

Toàn hệ thống chỉ chạy1 phiên public và1 phiên thử tổng cộng tại một thời điểm cho demo;1 phiên thử có thể đồng thời với public nếu khác shop. Một shop không được đồng thời thử và public. Chuyển thử→public phải thu hồi/dọn thử và claim public slot. Đạt quota thì báo giới hạn, không tự mua thêm dịch vụ hay tăng gói.

## 3. Chính sách voucher FITLY_LIVE_V1

### 3.1 Điều kiện và quyền lợi chung

Áp dụng thống nhất cho voucher live do shop hoặc sàn phát hành trong A+B; khác nhau ở nguồn chịu chi phí và slot, không khác luật restore. Không sửa voucher thường ngoài live.

- Claim thuộc user/campaign, campaign thuộc session và host shop. Voucher sàn live trong bản demo cũng chỉ giảm cho lượng hàng đủ điều kiện của phiên/shop đó, dù checkout có shop khác.
- Mỗi user1 claim/campaign; claim tối đa1 usage đang có hiệu lực tại một thời điểm. Restore mở lại chính claim đó, không phát claim mới và không cho nhiều lần dùng song song.
- Khoảng nhận từ live đến khi kết thúc hoặc campaign hết lượt nhận/thu hồi; đã nhận vẫn dùng đến redeemUntil khi live kết thúc bình thường. Không gia hạn tự động vì host mất mạng/kết thúc sớm.
- Quote/consume cần cả claim còn hạn và phần số lượng có nguồn phù hợp, đúng sản phẩm/shop và min/max. Giá trị tối thiểu tính trên phần hàng eligible của campaign trước giảm voucher, không cộng ship hay hàng thường/shop khác để đạt ngưỡng.
- Voucher live chiếm1 slot sàn hoặc1 slot shop tương ứng. Phối hợp mã theo pipeline hiện tại, tổng giảm không vượt giá hàng; BE lưu allocation cuối theo SKU/quantity/lot và funding source. FE không tự chia/tính giảm.
- Campaign chưa public được sửa trong nháp; sau khi bắt đầu chỉ có đóng nhận hoặc thu hồi theo quyền. Không sửa giảm quyền lợi/hạn dùng/policy của claim đã cấp. Nới ưu đãi phải tạo campaign mới, không viết đè snapshot cũ.
- Thu hồi campaign làm claim chưa dùng không thể redeem, có lý do trên UI; không tự thu thêm tiền/huỷ quyền lợi của đơn đã commit. Dừng video không đồng nghĩa thu hồi campaign; khoá shop vẫn áp guard đặt đơn hiện tại.

### 3.2 Định nghĩa phạm vi để quyết định restore

Mỗi usage lưu **covered quantities**: toàn bộ lượng đủ điều kiện đã dùng khi tính ngưỡng/giảm của voucher đó trong đơn, kèm phân bổ tiền cuối. Không chỉ lưu mỗi các dòng được làm tròn giảm lớn hơn0đ.

- Với mã shop: phạm vi chỉ những lượng eligible ở đơn con shop đó.
- Với mã sàn live: vẫn là lượng eligible của campaign trong nhóm đơn. Các món thường/shop khác không thuộc phạm vi sẽ không ngăn hoặc tự kích hoạt restore.
- “Toàn bộ đã huỷ/hoàn” nghĩa là tất cả covered quantities đã bị huỷ hợp lệ, hoặc hoàn trả đã hoàn tất và nghĩa vụ trả tiền liên quan đã xử lý xong. Không quyết định bằng trạng thái một đơn bất kỳ trong group.
- Covered quantities, discount/net-paid/funding allocation và policyVersion được snapshot lúc tạo đơn. Đổi giá hàng hiện tại hoặc rule campaign về sau không thay số tiền hoàn cho đơn cũ.

### 3.3 Bảng quyết định đã chốt

| Tình huống | Claim/quota | Khôi phục voucher? |
|---|---|---|
| Lỗi trước commit, gồm quote/kho/consume rollback | Không được mất usage; không coi là đã dùng | Không cần restore vì chưa dùng |
| Kết quả đặt hàng chưa rõ, payment pending hoặc refund pending | Giữ usage như đang xử lý, không cho dùng song song | Chưa restore; tra kết quả/hoàn tất nghiệp vụ trước |
| Khách/shop/hệ thống huỷ toàn bộ phạm vi, chưa có tiền phải hoàn | Release usage/quota đúng1 lần khi huỷ đã commit | Có, nếu chưa hết hạn và chưa thu hồi |
| Huỷ toàn bộ phạm vi sau khi đã trả tiền | Giữ đến khi refund liên quan hoàn tất | Có sau refund hoàn tất, nếu còn hạn/chưa thu hồi |
| Trả hàng/hoàn tiền toàn bộ phạm vi | Chờ hồ sơ hoàn đạt terminal và refund hoàn tất; COD chưa thu không tạo refund giả | Có nếu còn hạn/chưa thu hồi |
| Chỉ huỷ/hoàn một phần covered quantities | Không release usage để cấp lại cả mã; ghi allocation đã hoàn | Không restore mã, không phát voucher bù phần lẻ |
| Các lần hoàn một phần cộng dồn cuối cùng phủ toàn bộ phạm vi | Kiểm lượng/tiền terminal cộng dồn, unique theo usage | Restore một lần tại mốc toàn bộ nếu còn hạn/chưa thu hồi |
| Huỷ/hoàn chỉ món không thuộc phạm vi voucher | Giữ nguyên usage/claim | Không ảnh hưởng voucher này |
| Hết hạn trước lúc đủ điều kiện restore | Ghi đã release/closed theo sổ, không reset thời hạn | Không restore thành mã dùng được; không bồi hoàn tiền mặt/đổi mã mới |
| Campaign đã bị thu hồi | Ghi lý do và xử lý chứng từ/release một lần | Không restore thành mã dùng được |
| Webhook/job replay hoặc processing đồng thời | Unique restore theo usage, khoá claim/quota trong transaction | Không cộng đôi lượt hoặc mở hai quyền dùng |

Lý do huỷ khách/shop/hệ thống không làm đổi bảng V1; điều kiện thời điểm/độ phủ/refund mới quyết định. Nếu cần CSKH hỗ trợ ngoài policy thì là case thủ công có audit, không tự phát bù trong tính năng live.

### 3.4 Dùng lại sau khi khôi phục

- Restore là mở lại quyền dùng một lần, không giữ riêng quota chung và không giữ kho. Lượt nhận không tăng; usage được release chỉ một lần. Khi redeem lại phải kiểm quota chung còn, sản phẩm/shop còn bán, điều kiện ngưỡng và phương thức hiện tại.
- Claim khôi phục giữ redeemUntil gốc và policyVersion; campaign hết lượt/thu hồi sau đó vẫn có thể khiến chưa dùng được. UI phải ghi đúng tình trạng, không hứa “chắc chắn áp dụng”.
- Vì lượng đã mua từng rời giỏ, BE cấp recovery entitlement gắn usage cũ: đúng user, session, SKU và tối đa quantity gốc đã được restore. Nút “Mua lại với voucher” trong kho voucher/chi tiết đơn dựng intent từ quyền này, không cần live đang phát để nhận một nguồn mới.
- Recovery entitlement không được gắn cho hàng thường sẵn trong giỏ hoặc hàng khác. Giá hiện tại/địa chỉ/ship/minOrder đều quote lại; giảm quantity được phép, tăng vượt quyền gốc là lượng thường. Xoá/thêm từ trang thường không tự hồi sinh entitlement; chỉ command mua lại có kiểm server sử dụng nó.
- Khi claim dùng lại thành công, recovery entitlement lần trước bị consumed cùng transaction; không dùng receipt cũ thêm vô hạn lượng eligible. Nếu lần dùng mới đủ điều kiện hoàn toàn bộ thì tạo vòng restore mới theo usage mới, vẫn cùng expiry gốc và cùng giới hạn1 usage active.

### 3.5 Tiền hoàn và trạng thái giao diện

Hoàn tiền theo phần net thực trả đã phân bổ trên covered/other quantities của đơn, không hoàn bằng mệnh giá voucher và không tính lại theo giá hôm nay. Hoàn một phần không thu hồi thêm ưu đãi đã cấp cho hàng khách giữ lại chỉ vì tụt minOrder; không yêu cầu khách nộp thêm tiền do chính thao tác hoàn. Phí ship/return/remittance theo flow order/payment/shipping hiện hành, không tự tăng thêm quyền hoàn ship bằng live.

Tiền tài trợ shop/sàn được đảo theo allocation thực hoàn trong ledger/settlement thích hợp, không ghi doanh thu hoặc khoản đã hoàn khi payment mới nhận yêu cầu. Các khoản COD chưa thu được phân biệt tiền đã thu, không tạo chứng từ trả tiền giả. Không sửa flow tài chính bằng event client.

UI phân biệt: Đã nhận / Đang dùng cho đơn… / Chờ hoàn tất hoàn tiền / Đã khôi phục / Không khôi phục do hoàn một phần / Hết hạn / Đã thu hồi. Nút xem điều kiện và hạn dùng luôn có. Không hiện promise “đã hoàn tiền” từ việc đơn cancelled.

### 3.6 Tương thích promotion hiện hành

`PromotionService.release` hiện giảm usedCount và đánh releasedAt. Đây là **release accounting**, không đủ để quyết định restored claim/expiry/recovery entitlement. Khi code phải bổ sung logic live policy tại boundary promotion/order phù hợp; không buộc mọi voucher thường đi qua luật mới và không dựa riêng vào usedCount để bật nút dùng lại.

Restore khi refund hoàn tất đi qua event/outbox đã xác thực, idempotent và có audit. Cùng một usage chỉ release quota một lần dù cancel và refund cùng phát; không cho worker và HTTP tự tính hai kết quả khác nhau. Policy V1 phải thành snapshot bất biến, không đọc default cấu hình mới để xét ngược đơn cũ.

## 4. Chuẩn UX và nghiệm thu đã chốt

Không còn cổng phải có tài khoản/màn Shopee hoặc phải được xác nhận pixel-perfect. Dùng ma trận L01–L33 và LIVE-01–36 làm checklist hành vi FITLY; L16/L21–25 và phần C được đánh dấu ngoài phạm vi demo, không tính là thất bại A+B.

- Giữ FITLY brand, font và stack: Vineta/Bootstrap phía khách, shadcn/Tailwind phía shop/sàn; không thay shell toàn app.
- Điểm mua: món ghim→biến thể trực tiếp; danh sách live→món; có chi tiết/đánh giá/quay lại. Giỏ cá nhân khác danh sách hàng host.
- Desktop video+panel, mobile390px video+sheet; Back đóng đúng lớp, bàn phím không che chat/nút mua, không hai player phát tiếng.
- Player thu nhỏ chỉ trong document/layout được hỗ trợ; sang PayOS bên ngoài sẽ reconnect khi về. Đơn hàng không bị huỷ vì đóng player/hết live.
- Mua ngay tách giỏ; tag nguồn và eligible quantity đúng; timeout xác minh attempt cũ; địa chỉ/GHN/method/voucher lỗi có hành động sửa rõ.
- Lỗi media/chat/API tách biệt; force-stop có pending/confirmed/failed; không fake viewer, giao dịch, giá sau giảm hay trạng thái tiền.
- Phát thử phải chứng minh đường truyền tới thiết bị khác, không chỉ thấy webcam của chính host.

## 5. Ví dụ nghiệm thu policy

1. Khách nhận mã10:00, redeemUntil10:00 hôm sau; huỷ toàn bộ11:00 chưa trả tiền → khôi phục với hạn cũ, không sang11:00 hôm sau.
2. Khách có2 món đủ điều kiện dùng mã; hoàn1 món → hoàn đúng net món đó, không trả lại cả mã và không thu thêm tiền món còn giữ.
3. Sau đó hoàn nốt món còn lại, cả hai refund done trước expiry → claim được restore1 lần; replay không tăng quota nữa.
4. Mã sàn live chỉ giảm lượng shop A, group còn shop B thường. A đã hoàn toàn bộ và refund done → xét restore theo A; việc B còn giao không tự chặn, huỷ riêng B cũng không tự restore mã của A.
5. Refund done sau expiry hoặc campaign đã thu hồi → tiền hoàn vẫn xử lý đúng, mã không được gia hạn/phát bù tự động.
6. Live kết thúc, mã vừa restore còn hạn → Mua lại với voucher dựng intent giới hạn SKU/quantity gốc; không tô tag cả giỏ cũ. Giá/ship mới phải khách xác nhận.
7. Retry lệnh đặt khi unknown không làm release claim để dùng ở đơn thứ hai. Nếu server đã tạo order thì chỉ phục hồi order/payment cũ.

## 6. Các gói công việc và điều kiện hoàn tất

| WP | Nội dung | Điều kiện qua cổng |
|---|---|---|
| WP1 | Schema/DBML, DTO/API/permission, adapter media, cấu hình giới hạn | Không vòng module; migration/drift và contract typed; không public secret |
| WP2 | Room/host/viewer token, phát thử, lifecycle/reconnect/stop pending | Hai thiết bị phát/xem, role khác nhau, duplicate/timeout/force-stop/quota |
| WP3 | Studio/danh sách, chat/moderation, hàng/ghim/số cố định | Trạng thái đúng giữa hai client, reconnect không lặp hoặc mất quyền |
| WP4 | Intent/attempt, provenance lot, checkout dùng chung | LIVE-17–21/25–28/33/36; không mất giỏ/đơn trùng/giảm sai lượng |
| WP5 | Voucher V1, claim/consume/restore/allocation, recovery intent | Bảy ví dụ §5 + LIVE-22–24, refund/cancel replay, ordinary voucher hồi quy |
| WP6 | Discovery/follow/lịch/notify, mini-player, admin/report | LIVE-31–35; thông báo/version và quyền/PII; doanh thu theo đơn thật |
| WP7 | E2E/visual/load/config/runbook/cleanup | LIVE-01–36 theo phạm vi A+B;1host+10viewer15–30 phút, mobile390px, COD/PayOS/GHN sandbox có bằng chứng |

Mọi ca tài chính được thử ở DB/payment/carrier audit phù hợp trước live service thật. Không dùng mock để công bố đã nghiệm thu video thật, OpenAPI endpoint hay webhook GHN. Tách kiểm tích hợp thật và test lỗi giả lập, ghi giới hạn công khai. Ghi hình/C không là phụ thuộc chặn demo.

## 7. Trạng thái cuối của kế hoạch

- [x] Bỏ cổng replica Shopee1:1, chốt chuẩn FITLY và phạm vi A+B.
- [x] Chốt policy voucher FITLY_LIVE_V1, nguồn/quantity và dùng lại.
- [x] Chốt default, retention/cleanup và các WP/acceptance.
- [x] Đồng bộ bản tổng, biên bản và hai plan FE.
- [x] Implementation A+B và kiểm runtime cục bộ đã thực hiện theo yêu cầu triển khai sau đó.
- [ ] Deploy/LiveKit Cloud, UAT thiết bị/mạng thật, PayOS/GHN sandbox và tải15–30phút: chưa thực hiện; xem biên bản triển khai để phân biệt bằng chứng.

Không còn quyết định nghiệp vụ treo cần hỏi lại cho A+B. Credentials LiveKit, hạ tầng và cấu hình sandbox là đầu vào khi triển khai, không phải lý do giữ bản thiết kế Draft. Code/schema/dependency, migration, seed và dữ liệu audit cô lập đã được triển khai theo yêu cầu mới. Chưa tạo tài khoản Cloud hay chạy deploy; dữ liệu audit được dọn khi nghiệm thu cục bộ xong.

## 8. Các bổ sung contract cần thực hiện trong WP1/WP4/WP5

Các API dưới đây đã được triển khai với prefix /api/v1 và DTO/Swagger/Orval theo framework; hợp đồng thực tế xem `assets/live-api-contract.md`. Owner lấy từ JWT/ShopContextGuard, không nhận userId/shopId tuỳ ý để ghi.

| API thiết kế | Ý nghĩa và dữ liệu chính |
|---|---|
| POST /checkout/intents | mode=buy_now hoặc cart_selection, SKU/quantity hoặc cart selection version, sourceGrant/recoveryEntitlementId nếu có; server trả intentId/version/lines/expiresAt |
| GET /checkout/intents/:id | Snapshot chỉ owner; consumed trả result group để reload không mất đơn |
| POST /checkout/intents/:id/quote | version,addressId,paymentMethodCode,voucherCodes; server trả money/allocations/quoteIds/warnings, không giữ kho |
| POST /checkout/intents/:id/attempts | intentVersion và checkout inputs đã quote; Idempotency-Key; lệnh đặt chung pipeline order, trả attempt và group hoặc trạng thái processing |
| GET /checkout/intents/:id/attempts/:attemptId | succeeded/processing/failed_known với group result khi có; không đoán failed từ timeout client |
| GET /promotions/me/claims | Phân trang claims của actor, trạng thái/expiry/usage/restore eligibility và recovery entitlement; dùng cho U12 /account/vouchers |
| POST /livestreams/:id/campaigns/:campaignId/claims | Kiểm admission/user/phiên rồi gọi gateway promotion; idempotent, không cấp lại claim sau expiry |
| POST /promotions/me/claims/:claimId/recovery-intents | Owner xác nhận mua lại, BE kiểm entitlement SKU/quantity/expiry rồi dựng intent qua boundary order phù hợp |

Các tuyến claim đặt trong live chỉ là transport: promotion sở hữu claim/policy/ledger; order sở hữu intent/attempt và group; gateway đăng ký tại composition root để tránh import vòng. Body không được tự khai allocation/discount/restored=true. Cart add/merge/select API hiện có cần mở rộng provenance/version và chống ghi lặp bằng requestId trước khi gắn nguồn live; không để số lượng tăng đôi khi request add bị retry.

Đặt intent/attempt thêm unique owner+idempotency, intent consumed result và usage restore key; thứ tự khoá thống nhất pipeline order/promotion hiện hành, IDs nhiều dòng được chuẩn hoá thứ tự. IO media/GHN/PayOS ở ngoài transaction dài theo mô hình claim/reconcile hiện tại; không giữ khoá DB trong lúc chờ network. Test concurrent phải kiểm lost update, hai attempt cùng intent, double restore và cart increment song song.

Không còn phương án bỏ tick rồi tick lại giỏ hoặc gọi hook muaNgay cũ để thay intent. Checkout giỏ cũ vẫn được hỗ trợ và có regression riêng; feature live mới không được làm thay đổi hành vi tiền của khách không dùng live.
