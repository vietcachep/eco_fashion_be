# PLAN-0045 — Rà soát lần2: mua trong live và xử lý lỗi

> Ngày: 2026-11-06 · Status: Design reviewed — chưa triển khai
> Chủ dự án yêu cầu rà soát, chỉ cập nhật tài liệu, không code.
> Bản tổng: [PLAN-0045](PLAN-0045-livestream-commerce-design.md); các đặc tả ở đây bổ sung cho bản tổng và hai plan FE.
> Cập nhật cuối: chủ dự án uỷ quyền chốt và bỏ replica1:1. [Quyết định FITLY cuối cùng](PLAN-0045-livestream-final-decisions.md) thay các mục policy/reference từng còn mở; biên bản này giữ phát hiện lịch sử, không giữ các cổng chờ cũ.

## 1. Kết luận và cách phân loại

Bản đầu có đủ khung xem/phát/ghim/mua nhưng chưa đủ để nghiệm thu mua hàng giống Shopee Live. Rủi ro lớn nhất là đồng nhất “tái sử dụng checkout” với “Mua ngay đã tách giỏ”, đồng nhất dòng SKU với nguồn mua, và chỉ nói retry mà chưa định nghĩa kết quả đặt đơn chưa rõ. Cần bổ sung nhãn/nguồn mua, voucher, hậu mãi và phục hồi nhiều kênh.

P0 = phải giải quyết trong thiết kế/implementation trước nghiệm thu mua; P1 = thiếu luồng quan trọng; P2 = khoảng trống phạm vi/đối chiếu. “Bổ sung” trong biên bản nghĩa là đã mô tả cách xử lý, chưa có mã hay test runtime.

## 2. Sổ phát hiện

| ID | Mức | Thiếu/sai ở bản đầu | Quyết định thiết kế bổ sung |
|---|---|---|---|
| R01 | P0 | Mua ngay hiện tại không tách giỏ như lời đặc tả | Checkout intent riêng, chung bộ tính/đặt đơn; không chỉnh hàng loạt selected giỏ |
| R02 | P0 | Một SKU gộp lượng cũ/mới hoặc nhiều live, cấp nhầm voucher | Provenance theo phần số lượng; BE quote/consume theo phần hợp lệ |
| R03 | P0 | Chỉ có idempotency trong component, reload/timeout dễ tạo lại | Checkout attempt bền vững, tra kết quả trước khi tạo lần khác |
| R04 | P0 | Nhận voucher bị hiểu thành mọi hàng đều được giảm; chưa rõ rollback/hoàn | Tách claim/eligible quantities/usage; policy có version, stacking và hoàn riêng |
| R05 | P1 | Thiếu địa chỉ mới/cũ, GHN không báo giá, COD không hợp lệ | Nhánh sửa địa chỉ/đổi method/quote lại; không tự giả phí hoặc đổi payment |
| R06 | P1 | Một nhóm đơn nhiều payment; link PayOS chưa tạo hoặc hết hạn | Trạng thái từng đơn con, retry payment cùng order, không đặt lại hàng |
| R07 | P1 | Điểm vào mua luôn đi qua danh sách, chưa có chi tiết/đánh giá/quay lại | Pin→biến thể trực tiếp; danh sách→chi tiết; giữ return context/player khi hỗ trợ |
| R08 | P1 | Preview camera chưa kiểm đường truyền đầu cuối | Phát thử riêng, quyền/TTL và ngăn dữ liệu thử đi vào bán hàng thật |
| R09 | P1 | Force-stop có thể báo thành công trong khi provider chưa ngắt | Control terminal + provider cleanup pending/confirmed/failed, retry và audit |
| R10 | P1 | Video/chat/API lỗi bị coi là cùng một kết nối | Ba trạng thái độc lập, phục hồi từng kênh và snapshot |
| R11 | P1 | Đổi thứ tự/bỏ hàng có thể đổi số sản phẩm host đã đọc | Số hiển thị cố định, position riêng; tombstone/resume selection |
| R12 | P1 | Video trễ/đứng nhưng ghim/giá mới đã tới | Nhãn nội dung trễ, dữ liệu mua hiện hành; không hứa sync tuyệt đối khi chưa đo |
| R13 | P1 | Lịch sửa/huỷ, follower đổi ý, notification trễ | Schedule version, dedupe, deep link phản ánh trạng thái cuối |
| R14 | P1 | Quota media hết, camera bị chiếm/OS gián đoạn | Admission báo lỗi rõ, thiết bị retry, không giữ spinner/khởi tạo phòng rác |
| R15 | P1 | Merge giỏ sau đăng nhập, đổi tài khoản/tab chưa rõ | Merge giữ lot/token hợp lệ; logout dọn player/attempt pointer; BE chặn user khác |
| R16 | P2 | Thiếu phân biệt nguồn đơn shop với affiliate KOL | Hai định nghĩa riêng; không tự áp quy tắc cookie KOL cho A/B shop-owned |
| R17 | P2 | “1:1” trong khi giới hạn một shop/phát web/không native | Giữ sai khác công khai; không nghiệm thu toàn bộ Shopee với A/B |
| R18 | P1 | Chưa rõ dọn replay/phòng thử và badge thông báo mua | TTL/retention; không bịa giao dịch; không công khai PII/địa chỉ/tiền thanh toán |

### 2.1 Bằng chứng trong FITLY hiện tại

- [use-add-to-cart.ts](../../../fashion_frontend_user/src/features/cart/hooks/use-add-to-cart.ts): `muaNgay` gọi thêm giỏ rồi điều hướng checkout; không tạo basket chỉ món vừa chọn.
- CheckoutSummaryQuery/CreateOrderRequest hiện dùng giỏ đã selected, chưa có checkoutIntentId; [order.requests.ts](../../src/modules/order/order/request/order.requests.ts).
- Giỏ dùng một dòng mỗi cart+variant; tăng số lượng cộng vào dòng; [cart.prisma](../../prisma/schema/cart.prisma), [cart.service.ts](../../src/modules/cart/cart.service.ts). Chỉ thêm sourceSessionId ở dòng này không giải quyết phần lượng mua trước live.
- FE [use-checkout.ts](../../../fashion_frontend_user/src/features/order/hooks/use-checkout.ts) giữ khoá mutation bằng useRef; đây không phải cơ chế khôi phục kết quả qua reload. Không kết luận checkout đang có lỗi runtime; yêu cầu mới cần thiết kế thêm.
- Nguồn FE chuẩn: [use-add-to-cart.ts](../../../fashion_frontend_user/src/features/cart/hooks/use-add-to-cart.ts), [order-api.ts](../../../fashion_frontend_user/src/features/order/api/order-api.ts). Không sửa các file này trong đợt rà soát.

## 3. Checkout intent và kết quả chưa rõ — thiết kế FITLY đã chốt

### 3.1 Mua ngay

1. Bấm Mua ở món ghim mở đúng biến thể. Xem điều kiện giao dự kiến nếu có; phí cuối chỉ có sau địa chỉ/quote, không hiện0 khi chưa biết.
2. BE nhận SKU, quantity, bằng chứng nguồn hợp lệ; tạo intent thuộc user, version, dòng hàng và ngữ cảnh nguồn. Intent được tạo idempotent cho cùng thao tác, không đụng giỏ hiện có. Khách vãng lai đăng nhập rồi xác nhận lại, BE kiểm hàng/nguồn một lần nữa.
3. Checkout dùng intent để dựng danh sách, quote địa chỉ/payment/voucher; chung pricing/reservation/order pipeline với checkout hiện tại, không viết nhánh tính tiền riêng của livestream.
4. Intent hết hạn sau30 phút không hoạt động khi chưa submitting, expiresAt do BE trả; đây không phải thời gian giữ kho. Không expire/xoá attempt đang unknown để cho tạo lại. Tạo đơn mới giữ kho như hiện tại. Hết intent thì cho dựng lại từ món đã chọn sau khi kiểm giá/nguồn, không tự bấm đặt thay khách.
5. Đặt thành công đánh dấu intent consumed, ghi group/order result; nhấn lại/mở tab khác nhận cùng kết quả. Không xoá dòng SKU trong giỏ thường vì mua ngay không mua từ giỏ đó.
6. Intent từ giỏ nhiều món cần snapshot dòng/lot/version và phạm vi mua; lúc tạo đơn kiểm cartVersion hoặc tương đương. Chỉ trừ đúng lượng snapshot đã mua; phần tăng thêm ở tab khác và lượng không mua phải được giữ. Không dùng thao tác xoá toàn dòng theo variantId khi chỉ một phần được mua.

### 3.2 Attempt và idempotency

Intent có chu kỳ: active→submitting→consumed, hoặc expired/cancelled; request outcome unknown là trạng thái giao tiếp của client, không phải bằng chứng DB đã commit. Mỗi attempt có idempotency key/hash, actor, intent version, trạng thái processing/succeeded/failed_known và mã nhóm đơn nếu có. Chỉ server quyết kết quả cuối.

- Tạo/ghi attempt trước khi gửi lệnh đặt; client lưu tham chiếu không nhạy cảm gắn tài khoản để reload tra lại. Không lưu token, địa chỉ hay toàn payload thanh toán vào URL/localStorage.
- Mạng mất/5xx/in-progress: khoá tạo attempt mới, tra kết quả cũ có backoff hữu hạn; hết thời gian chờ hiện hướng dẫn mở đơn/tiếp tục kiểm tra, không tự kết luận thất bại rồi cho tạo lại.
- Replay cùng attempt chỉ có một group. Đổi giá/địa chỉ/method/quantity sau lỗi đã xác định phải thành version mới sau khách xác nhận; không đổi payload dưới key cũ đang xử lý.
- Request fingerprint phải bao gồm intent/snapshot version và phạm vi dòng hàng/nguồn đã resolve, không chỉ địa chỉ+method+note+voucher. Một khoá không được tái dùng cho hai basket khác nhau. Quy tắc expectedTotal/price-changed phải thống nhất FE/BE và không mở attempt mới khi chưa biết lệnh trước đã commit hay chưa.
- Hủy chờ ở UI chỉ dừng chờ, không huỷ giao dịch server. Nếu muốn huỷ đơn đã có thì gọi đúng use case huỷ đơn và điều kiện của order.
- Chưa có API intent/status-by-attempt hiện hành: đây là bổ sung contract cần thiết trước khi code, không dùng endpoint tưởng tượng như đã tồn tại.

## 4. Giỏ từ live, nhãn và số lượng đủ điều kiện

Shopee có hướng dẫn gắn nhãn hàng từ live và điều kiện nguồn khi dùng voucher. FITLY cần mô tả thêm cách bảo toàn lượng, không suy đoán schema nội bộ Shopee.

- “Giỏ sản phẩm live” là hàng host gắn vào phiên; “Giỏ mua sắm của tôi” là món khách đã thêm. UI dùng nhãn/biểu tượng và badge khác nhau để không hiểu chúng là một giỏ.
- BE lưu các phần số lượng (lot) có nguồn, issueTime/eligibleUntil/campaign context do server cấp. UI vẫn có thể gộp theo SKU nhưng phải chỉ rõ lượng đủ điều kiện live khi bị trộn. Giá giảm trả theo allocation từ BE.
- Ví dụ: có2 chiếc từ trang thường, thêm1 chiếc từ live A → tổng3; chỉ1 chiếc có nguồn A. Không cấp voucher A cho cả3. Thêm từ live B không viết đè nguồn A.
- Quyết định FITLY: tăng quantity bằng +/- trong giỏ là lượng thường, không nâng lượng đủ điều kiện; muốn thêm lượng live thì quay live thêm bằng command có source hợp lệ. Giảm quantity trừ lot mới nhất trước (LIFO), được BE xác nhận, không chọn thuật toán khác giữa quote và consume. UI phải thấy lượng đủ điều kiện giảm nếu bị trừ vào lot live.
- Xoá rồi thêm lại qua trang thường không hồi sinh nguồn live cũ. Merge sau login kiểm bằng chứng khách vãng lai do server cấp, gắn vào actor sau khi merge; không nhận arbitrary nguồn từ payload local.
- Mỗi lot live gắn quyền/attribution riêng; eligibleUntil=min(campaign.redeemUntil, thời hạn nguồn tương ứng). A/B dùng nguồn ưu đãi theo campaign, redeemUntil=actualStartedAt+24 giờ, không ngầm thêm quy tắc7 ngày affiliate. Hết nguồn không xoá hàng khỏi giỏ: bỏ eligibility, báo lại giá, yêu cầu khách xác nhận. Recovery entitlement sau restore là nguồn server cấp riêng, đúng SKU/quantity gốc theo quyết định cuối §3.4.
- Order snapshot lưu allocation theo lot; attribution thống kê và giảm giá là hai khái niệm riêng. Policy mới không sửa ngược nguồn/giảm giá trên đơn đã tạo.

## 5. Voucher: nhận, dùng, phối hợp và thất bại

- Điều kiện cần đồng thời: claim đúng user/campaign còn hiệu lực, SKU/shop/quantity có nguồn hợp lệ, order đáp ứng min/max/usage và method theo campaign. Xem live hoặc có claim đơn lẻ không đủ.
- Nhãn voucher ở card live/giỏ/phần checkout do BE xác nhận. Đã nhận khác với đủ điều kiện áp; hiển thị lý do không áp cụ thể: sai món, thiếu giá trị, hết lượt, hết hạn, thu hồi, khác shop, không đúng nguồn.
- Slot hiện tại tối đa1 mã sàn+1 mã shop/shop vẫn giữ. Voucher live thuộc slot tương ứng, không tự thêm slot live miễn phí. Freeship theo cùng rule hiện tại, không mặc định cộng mọi mã. Khách xem đổi mã làm tổng mới ra sao trước khi đặt.
- Nhận bị timeout tra claim/retry cùng key; không tăng claim nhiều lần. Order failed_known trước commit không mất lượt; consume và tạo order phải atomic theo gateway hiện tại. Đã consumed mà thanh toán pending thì claim không hiện là chưa dùng.
- Voucher mất hiệu lực giữa quote và đặt: BE reject/quote lại, UI giữ món/địa chỉ, tô mã lỗi và cho gỡ/chọn mã khác; KHÔNG tự bỏ mã rồi tạo đơn đắt hơn. Hết hàng/giá đổi cũng phải được xác nhận lại.
- Live kết thúc bình thường không xoá claim còn redeemUntil. Force-stop media không tự thu hồi mọi campaign; lệnh thu hồi ưu đãi là quyết định có quyền/audit riêng. Shop bị khoá thì order theo guard thương mại, không chỉ kiểm live.

## 6. Huỷ/hoàn tiền và voucher — FITLY_LIVE_V1 đã chốt

Tài liệu Shopee chỉ tham khảo. Theo uỷ quyền mới của chủ dự án, policy FITLY_LIVE_V1 được chốt tại quyết định cuối §3: toàn bộ covered quantities đã huỷ/hoàn và nghĩa vụ tiền hoàn hoàn tất thì restore nếu còn hạn/chưa thu hồi; hoàn một phần không restore cả mã, cộng dồn đủ toàn bộ thì xét một lần. Không thay chính sách voucher thường hiện tại.

| Tình huống | Luật thiết kế cần bảo đảm |
|---|---|
| Đơn chưa commit, lỗi kho/quote/consume | Không mất voucher/giữ kho do retry; transaction rollback |
| Đơn đã có, PayOS chưa trả/link hết hạn | Không tạo đơn mới; retry payment nếu order cho phép hoặc huỷ theo quy tắc order |
| Huỷ trước giao, payment pending chưa thu tiền | Huỷ đã commit thì release đúng một lần; restore claim nếu còn hạn/chưa thu hồi |
| Huỷ sau đã trả | Refund qua payment hiện tại; không mark tiền đã hoàn chỉ vì gửi yêu cầu |
| Hoàn toàn bộ / hoàn một phần | Tiền theo snapshot net/allocation; toàn bộ và refund done thì xét restore, một phần không restore cả mã |
| Đơn nhiều shop, chỉ huỷ một shop | Xét covered quantities của voucher; huỷ món không được mã áp dụng không restore, hoàn toàn bộ phạm vi được áp có thể restore dù món thường shop khác còn giao |
| Voucher đã hết hạn/thu hồi/cạn nguồn | Không hiện mã dùng lại chỉ vì số lượt được release; policy restoration phải kiểm điều kiện hiện tại |
| Webhook refund/cancel phát lại | Một refund/restore đúng một lần, audit; không cộng đôi lượt/tiền |

Policy đã chốt thống nhất shop/platform và mọi nguồn huỷ; giữ expiry gốc, không tự phát bù/gia hạn/tiền mặt. Restore không giữ quota/kho, có recovery entitlement giới hạn SKU/quantity gốc. Bảng chi tiết, accounting và7 ví dụ bắt buộc ở quyết định cuối §3/5 thay cổng duyệt policy trước đây.

## 7. Bảng lỗi mua hàng và phục hồi

| Lỗi/điểm ngắt | Khách thấy | Hành động hợp lệ |
|---|---|---|
| Chưa login/hết phiên | Đăng nhập, giữ room/panel và ý định mua | Login rồi lấy quote/quyền mới; không tự submit |
| Đổi sang tài khoản khác | Ngữ cảnh cũ không thuộc tài khoản này | Xoá pointer client, dựng intent mới sau xác nhận; BE403/404 dữ liệu cũ |
| Cart đang merge/ghi | Đang đồng bộ giỏ | Chờ nguồn ổn định rồi quote, không dùng snapshot cũ |
| Thiếu địa chỉ hoặc địa chỉ cũ thiếu mã GHN | Yêu cầu chọn/cập nhật tỉnh-quận-phường | Giữ món, sửa địa chỉ, báo giá lại |
| Không phục vụ tuyến/quote GHN timeout | Chưa xác định phí/giao được | Retry quote hoặc chọn địa chỉ khác; không giả0đ/không tự fallback hãng |
| COD bị chặn hoặc method bị tắt | Lý do và phương thức khác nếu có | Khách chọn lại rồi quote; không âm thầm chuyển PayOS/COD |
| SKU hết hoặc quantity vượt giới hạn | Chỉ rõ món/số lượng khả dụng | Khách chỉnh/loại dòng rồi quote, không tự đổi biến thể |
| Giá/ship/voucher đổi | Bảng trước/sau/lý do | Khách chấp nhận quote mới; giữ khoá khi kết quả cũ còn unknown |
| Đặt hàng timeout/5xx | Đang xác minh kết quả | Tra attempt cũ, không tạo key mới/không clear giỏ |
| Order thành công, link PayOS chưa có | Đơn chờ thanh toán, đang tạo link/thử lại | Mở thanh toán của order đó, không đặt hàng lần nữa |
| Người dùng đóng PayOS/query URL báo cancel | Chưa kết luận đã huỷ/đã trả | Hỏi server, mở đơn và trả lại nếu còn được phép |
| Nhiều đơn con chỉ trả một đơn | Bảng từng shop: đã trả/chưa trả/lỗi | Tiếp tục đúng payment của đơn chưa trả; đơn cha không giả paid |
| Live đã kết thúc/bị dừng | Banner live riêng; order đang có vẫn hiển thị | Tiếp tục checkout nếu hàng/campaign hợp lệ; không auto-cancel tài chính |
| Video mất, chat/API còn | Video lỗi; hàng/chat còn dùng theo quyền | Retry video; không chặn đơn chỉ vì media lỗi |
| Chat/socket mất, video còn | Chat mất kết nối, trạng thái hàng chưa đồng bộ | REST snapshot sản phẩm/quyền trước mua; khoá chat, không spinner cả phòng |
| API commerce lỗi, video còn | Tạm không lấy được giá/đặt hàng | Giữ video, khoá submit, retry có kiểm kết quả cũ |

Một lần Đặt hàng phải hiển thị rõ phạm vi dòng/shop khách xác nhận. Nếu một dòng/shop không đủ điều kiện trước commit, không tự bỏ dòng đó rồi đặt phần còn lại; yêu cầu sửa lựa chọn và báo giá lại. Việc tạo group/order phải theo tính nguyên tử pipeline hiện tại; lỗi khởi tạo link thanh toán sau khi order đã tạo là lỗi payment cần phục hồi, không được gọi lại tạo group để chữa.

## 8. Phần thiếu ngoài checkout đã bổ sung thiết kế

**Phát thử:** phòng access-controlled chỉ host/người thử được mời, không discovery/follower/public link. Tối đa10 phút đã chốt, tự đóng và dọn tài nguyên; không ghi replay, không tạo voucher/đơn/doanh thu thật; dữ liệu test gắn nhãn riêng. Chuyển live thật cấp room/session mới, ngắt publisher phòng thử; provider vẫn có thể tính phút thử theo gói. Luật FITLY này không suy ra quyền mua trong chế độ thử của Shopee.

**Force-stop:** persisted state có thể terminal ngay để ngăn token/quyền mới, nhưng trường mediaStopStatus phải pending/confirmed/failed. Admin chỉ thấy ngắt hoàn tất khi provider xác nhận; worker retry/backoff và reconcile. Nếu người xem giữ token cũ, phải disconnect/revoke/update permission theo năng lực provider; TTL ngắn đơn thuần không đủ cắt kết nối đang có. Không auto-refund/cancel các đơn từ phiên.

**Thiết bị/quota:** phân biệt permission-denied, not-found, in-use, track-ended, network, provider-quota. Host tắt micro/camera có chủ ý không đồng nghĩa rớt kết nối; UI thể hiện mute/camera-off và chính sách tiếp tục phát. OS khóa màn hình/cuộc gọi/mobile nền có thể cắt capture: phục hồi hoặc hết grace period, không hứa native behavior. Quota hết ngăn nhận mới có thông báo, không tạo vòng lặp room; tuỳ năng lực provider có wait/retry, không đuổi người đang xem bằng đếm local.

**Thứ tự hàng/độ trễ:** displayNumber không tái sử dụng; position có thể đổi. Ghim bị xoá thì unpin theo version, panel người mua hiện món không còn trong live thay vì tự đổi món. Video đóng băng/trễ phải có trạng thái; giá/stock dùng snapshot mới và BE kiểm cuối. Không dựa serverTime đơn lẻ để hứa frame-perfect pin-video; phải đo pipeline và chỉ có điều khiển bắt kịp live khi SDK hỗ trợ.

**Điều hướng:** có điểm Xem chi tiết/đánh giá/shop và Quay lại live. Giữ return room/product/variant hợp lệ, panel/focus, muted state; một document chỉ một player đang phát tiếng. Chuyển live khác/đóng mini-player/logout phải release media/presence/listener; không đưa token vào link chia sẻ. Gói A tạm rời phòng vẫn có nút quay lại và reconnect; gói B mới là player bền qua route, đây là mức tương thích cần công khai.

**Lịch/thông báo:** sửa hoặc huỷ lịch tăng version, job cũ bỏ qua, dedupe theo user+session+event. Deep link lịch cũ mở trạng thái đã đổi/huỷ và lựa chọn theo dõi lịch mới; không mở phòng terminal. Unfollow/tắt nhắc không tiếp tục nhận thông báo mới; thông báo trễ không phục hồi trạng thái live.

**Đơn và quyền riêng tư:** thông báo “vừa mua” nếu triển khai phải lấy event đơn thật và được phép công khai, dùng tên hiển thị đã che; không lộ SKU nhạy cảm/địa chỉ/payment hoặc lấy thử nghiệm làm giao dịch thật. Online unique và concurrent connection là hai số khác nhau khi một user mở nhiều tab. Viewer history/chat/replay phải có retention được duyệt và cleanup job, không chỉ xoá ở FE.

## 9. Bổ sung tiêu chí nghiệm thu

| Mã | Ca | Điều kiện đạt |
|---|---|---|
| LIVE-17 | Giỏ có hàng khác, mua ngay1 món, cùng SKU đã có quantity khác | Intent chỉ đúng lượng mới; giỏ/selected cũ không đổi |
| LIVE-18 |2 lượng thường+1 live A+1 live B, quote với voucher A | Chỉ phần A đủ điều kiện, BE allocation khớp tiền/nguồn |
| LIVE-19 | Tăng/giảm/xoá/thêm lại/merge sau login | Provenance tuân rule, không nâng nguồn trái phép |
| LIVE-20 | Reload/tab khác sau timeout submit | Một attempt tạo tối đa một group; tra được kết quả và giữ giỏ đúng |
| LIVE-21 | Huỷ chờ UI khi server đã commit | Không báo huỷ đơn giả; lần mở sau thấy order cũ |
| LIVE-22 | Nhận mã timeout/replay, claim có nhưng SKU không từ live | Một claim; không giảm sai hàng |
| LIVE-23 | Mã live tranh slot sàn/shop, expire/revoke đúng lúc đặt | Quote/consume không lệch; không tự tăng tiền rồi đặt |
| LIVE-24 | Huỷ/hoàn toàn bộ/một phần, webhook lặp | Policy versioned, allocation/restore/refund đúng một lần |
| LIVE-25 | Địa chỉ legacy/thiếu/ngoài tuyến/GHN timeout | Sửa/retry, không tạo phí0 hay đơn không giao được |
| LIVE-26 | COD mất eligibility; method đổi giữa quote và đặt | Khách xác nhận method và quote mới |
| LIVE-27 | Order có nhưng link PayOS lỗi/hết hạn, hoặc2 shop trả1 | Retry đúng payment, không tạo lại order/không báo paid cả nhóm |
| LIVE-28 | Video/chat/API lỗi độc lập | Chỉ chức năng phụ thuộc bị khoá, khôi phục đúng snapshot |
| LIVE-29 | Provider không trả lời force-stop | Quyền mới bị chặn; admin thấy pending/failed, retry không hồi sinh phiên |
| LIVE-30 | Phát thử, hết TTL, chuyển public | Không lộ phòng/đơn/thông báo thật; không bỏ tài nguyên test |
| LIVE-31 | Đổi thứ tự/bỏ hàng ghim/thêm lại; video trễ | Số hàng không bị tái gán, lựa chọn khách không tự đổi |
| LIVE-32 | Từ live→chi tiết/đánh giá→Back; đóng mini-player/đổi live | Về đúng context, chỉ một player có tiếng, release khi đóng |
| LIVE-33 | Đổi tài khoản/login hết hạn trong lúc mua | Không thấy order/intent/claim user trước, xác thực lại trước ghi |
| LIVE-34 | Camera bị chiếm/mic mất/OS cắt track/provider hết quota | Thông báo cụ thể, retry/grace đúng, không spinner/phòng rác |
| LIVE-35 | Sửa/huỷ lịch, job cũ chạy, unfollow | Dedupe và version đúng, deep link không giả đang live |
| LIVE-36 | Cart tăng lượng ở tab khác trong lúc checkout | Trừ đúng lot snapshot; lượng mới và món khác còn nguyên |

## 10. Các sai khác đã chấp nhận và phạm vi backlog

- Nguồn hướng dẫn KOL đề cập attribution theo nhiều bước/thời gian và nguồn affiliate. Không tự kết luận đây là policy mọi người bán; A/B của FITLY chỉ shop-owned. KOL hàng nhiều shop/affiliate vẫn C và cần thiết kế tách quyền lợi.
- Không yêu cầu pixel/shortcut/back của app Shopee trùng hoàn toàn. UX FITLY và giới hạn web theo quyết định cuối là chuẩn nghiệm thu; việc chưa kiểm màn Shopee có đăng nhập không chặn kế hoạch.
- Xu/đấu giá/replay/đồng dẫn thuộc backlog C, không nằm trong bản demo A+B. Không yêu cầu hoàn tất C để đóng kế hoạch demo.
- Flash deal theo thời gian/số lượng, quà tặng kèm/combo, filter làm đẹp và overlay hình ảnh chưa được xác minh đầy đủ như tính năng chung cho mọi tài khoản Shopee Live. Nếu đưa vào phạm vi replica thì cần reference riêng và plan con. Không đồng nhất voucher với giá flash-sale, hoặc coi chương trình Mega Live riêng là luật mặc định mọi shop. Giá “sau ưu đãi” hiển thị chỉ khi BE có đủ điều kiện tính, nếu chưa thì ghi giá bán và điều kiện, không trình bày giá tốt nhất như giá ai cũng được mua.
- Policy hoàn/khôi phục live voucher đã chốt FITLY_LIVE_V1; không còn cổng hỏi chủ dự án về luật này. Chưa có code hoặc kiểm chứng runtime.

## 11. Nguồn và giới hạn suy luận

- [Shopee: voucher live](https://help.shopee.vn/portal/4/article/101231-%5BShopee-Live%5D-H%C6%B0%E1%BB%9Bng-d%E1%BA%ABn-s%E1%BB%AD-d%E1%BB%A5ng-Voucher-Shopee-Live): xác nhận nhãn và nguồn mua; có giới hạn phục hồi khi mã không còn hiệu lực/lượt. Không cung cấp thuật toán lot nội bộ.
- [Shopee: FAQ livestream/KOL](https://help.shopee.vn/portal/10/article/164061): có cách ghi nhận theo nguồn và cửa sổ mua trong bối cảnh KOL; báo cáo đơn và đối soát không phải một số. Không dùng như cam kết tăng doanh thu hoặc policy FITLY.
- [Shopee: phát thử](https://help.shopee.vn/portal/10/article/151627): xác nhận có thử nghiệm riêng không xuất hiện công khai/lưu video; quyền/TTL/ngăn order trong tài liệu này là đề xuất FITLY.
- [Shopee: trả hàng/hoàn mã](https://help.shopee.vn/portal/4/article/188931): tham chiếu sự khác biệt theo loại voucher và hoàn toàn bộ/một phần; không nhập toàn bộ chính sách hậu mãi Shopee vào FITLY.

## 12. Thực hiện đợt rà soát

Đã đọc lại ba plan, khảo sát thêm nguồn chính thức, kiểm luồng FE/DTO/cart hiện hành và bổ sung R01–R18, L26–L33, LIVE-17–36. Chỉ chỉnh/thêm tài liệu docs/plans trong ba repo; không sửa code, không migration/package/runtime/test-data/deploy. Các testcase là tiêu chí tương lai, chưa chạy như test sản phẩm.

Quyết định cuối cùng ngày2026-11-06: R04/R17 và các điểm chờ policy/reference đã được giải quyết ở mức thiết kế theo uỷ quyền mới, không coi là lỗi runtime đã sửa. Dùng bộ LIVE-01–36 cho phạm vi A+B cộng7 ví dụ policy, không tiếp tục yêu cầu đối chiếu Shopee1:1.
