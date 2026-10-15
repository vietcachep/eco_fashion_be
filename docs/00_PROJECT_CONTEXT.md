# 00 — Bối cảnh dự án EcoFashion (FITLY)

## Đề tài

**Sàn thương mại điện tử đa gian hàng, đa ngành hàng** (kiểu Shopee/Lazada thu nhỏ). Nhiều gian hàng (shop) cùng bán trên một sàn, mỗi shop tự quản sản phẩm/đơn/khuyến mãi
của mình, sàn thu hoa hồng. Thời trang (quần áo) là ngành hàng ĐẦU TIÊN, không phải duy nhất — điện tử, gia dụng, mỹ phẩm, sách, thực phẩm… tự định nghĩa bộ thuộc tính riêng theo
ngành hàng (PLAN-0016). Hệ thống gồm:

1. **Web bán hàng** (khách, repo `fashion_frontend_user`): xem/tìm sản phẩm theo ngành hàng và gian hàng, lọc, giỏ hàng nhóm theo shop, đặt hàng nhiều shop trong một lần checkout
   (voucher sàn + voucher từng shop), thanh toán PayOS (QR/chuyển khoản tự động) hoặc COD, theo dõi đơn, đổi trả, đánh giá, trợ lý AI + tìm sản phẩm bằng ảnh.
2. **Web quản trị** (repo `fashion_frontend_admin`), hai cổng:
   - **Nhân viên sàn** (nhiều vai: admin · quản lý · bán hàng & CSKH · kho · kế toán · marketing): ngành hàng + thuộc tính, duyệt/khoá gian hàng, đơn/thanh toán/hoàn tiền và đối soát
     chi trả shop (tự động), khuyến mãi sàn, kiểm duyệt đánh giá, báo cáo, phân quyền.
   - **Vendor** (chủ/nhân viên gian hàng — vai `shop_owner`/`shop_staff`): sản phẩm, kho, đơn, voucher shop, đánh giá, báo cáo, đối soát của CHÍNH shop mình (route `/shop/**`).

Ngôn ngữ giao diện: **chỉ tiếng Việt**. Tiền tệ: **VND**.

## Mô hình tiền (tóm tắt)

- **Khách trả tiền cho SÀN, luôn luôn** (PLAN-0018): chỉ có 2 phương thức — `payos` (khách trả qua link PayOS vào tài khoản của sàn) và `cod` (đơn vị vận chuyển thu hộ tiền mặt rồi nộp về sàn; sàn ghi nhận đã thu khi đơn giao thành công). Không còn VNPay, chuyển khoản tay, ví quỹ COD.
- Một lần checkout = 1 đơn cha (`OrderGroup`) + N đơn con (mỗi shop một đơn, vòng đời + thanh toán riêng). Hoa hồng ghi trên đơn con (`commissionRateSnapshot`).
- Đơn **PayOS và COD đi cùng MỘT đường**: sàn giữ tiền → chờ hết hạn đổi trả (escrow) → **tự động** trừ hoa hồng, trừ hoàn tiền + nợ mang sang → **tự động** chi PayOS "Lệnh chi" về tài khoản ngân hàng của shop. Cron trong worker chạy mỗi ngày 02:00 (Asia/Ho_Chi_Minh) khi setting `payout.auto_enabled` = true và khoá PayOS chi đã cấu hình; kế toán vẫn có nút chạy kỳ tay để chạy bù. Đơn COD chỉ vào đối soát khi `Payment=paid` (sàn đã xác nhận thu).
- Khoá PayOS thu/chi do chủ dự án cung cấp sau; khi trống, method `payos` tự ẩn (chỉ còn COD) và chi trả không gọi mạng.
- Chặn shop vi phạm: dùng tạm khoá shop (`supplier.shop.suspend`) — không còn khoá COD theo ví.
- Voucher sàn do SÀN chịu (shop vẫn nhận đủ doanh thu); voucher shop do SHOP chịu.
- Chi tiết: `docs/02_MODULE_MAP.md` §6–7, `docs/plans/PLAN-0015-*.md`, `PLAN-0017-*.md`; luồng tiền hiện hành: `PLAN-0018-*.md`.

## Không làm (ngoài phạm vi hiện tại)

- Form tự đăng ký gian hàng (shop do admin/seed tạo, sàn duyệt/khoá qua `/admin/shops`); không có API tạo shop.
- Phí vận chuyển riêng từng shop (dùng chung bảng phí tỉnh/thành của sàn).
- Shop tự xử lý đổi trả (sàn xử lý tập trung `order.return.process`).
- Đa ngôn ngữ, bảng dịch, AI dịch.
- Lưu số thẻ / CVV (PCI-DSS) — thanh toán QR/chuyển khoản đi qua trang PayOS.
- OCR.

## Vai và phân quyền (hai tầng)

Quyền hiệu lực = quyền của vai ∪ cấp riêng − chặn riêng (deny thắng). Có hai namespace mã quyền (xem `src/modules/identity/permission/catalog.ts`, 79 mã sau PLAN-0018 — đã bỏ `shop.wallet.read`, `shop.wallet.deposit_request`, `supplier.wallet.read`, `supplier.wallet.adjust`):

- `supplier.*` + các module `catalog/product/order/payment/promotion/review/system/reporting/ai/identity`: **nhân viên sàn**, kiểm bằng `PermissionGuard` + `@RequirePermission`.
- `shop.*`: **chủ/nhân viên gian hàng**, chỉ có hiệu lực TRONG shop của họ; kiểm bằng `ShopContextGuard` + `@RequireShopPermission` (shopId suy từ phiên thành viên, không bao giờ từ URL/body).

| Vai (code) | Phạm vi | Namespace |
|---|---|---|
| `admin` | Toàn quyền, quản lý nhân viên & phân quyền, tham số vận hành | nền tảng |
| `manager` | Ngành hàng, sản phẩm, tồn kho, đơn, khuyến mãi, báo cáo, kiểm duyệt đánh giá, duyệt/khoá gian hàng + xem đối soát | nền tảng |
| `sales` | Đơn hàng (xác nhận/đóng gói/giao), đổi trả, trả lời đánh giá, yêu cầu hỗ trợ từ chatbot | nền tảng |
| `warehouse` | Tồn kho, phiếu nhập/điều chỉnh, đóng gói/giao đơn | nền tảng |
| `accountant` | Thanh toán, hoàn tiền, doanh thu, đối soát (chạy bù kỳ chi trả shop; kỳ tự chạy bằng cron) | nền tảng |
| `marketing` | Banner, khuyến mãi sàn, bộ sưu tập, AI soạn mô tả, kho tri thức chatbot | nền tảng |
| `customer` | Khách — không có mã quyền quản trị (chủ/nhân viên shop cũng là `customer` + một dòng `ShopMember`) | nền tảng |
| `shop_owner` | Toàn quyền `shop.*` trên gian hàng của mình: hồ sơ + TK ngân hàng, nhân viên, sản phẩm, đơn, kho, voucher, đánh giá, báo cáo, đối soát | gian hàng |
| `shop_staff` | Vận hành hằng ngày: xem hồ sơ/nhân viên, sản phẩm, xử lý đơn, xem kho, trả lời đánh giá — không đụng nhân sự, voucher, đối soát | gian hàng |

## Tham chiếu

- Format code/tài liệu bám theo `D:\project_ago_fruit\ago_erp\ago_backend` (AGENTS + PLANS + explain + docs).
- Ý tưởng mô hình sàn (đơn cha/đơn con, RBAC 2 namespace, payout; phần ví COD đã bỏ ở PLAN-0018) tham khảo `D:\Fullstack\eco_books\eco_backend` (EcoShop, Python) — chỉ lấy ý tưởng, không copy code.
- Khoá bên thứ ba (PayOS thu/chi — chủ dự án cung cấp sau —, OpenAI, Cloudinary…) đều để TRỐNG, tính năng tương ứng tự lùi về đường không-khoá: `docs/07_KEYS_CHECKLIST.md`.
