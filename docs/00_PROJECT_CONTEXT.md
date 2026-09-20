# 00 — Bối cảnh dự án EcoFashion

## Đề tài

Hệ thống bán hàng thời trang online cho **một cửa hàng**, gồm:

1. **Web bán hàng** (khách): danh mục quần áo/phụ kiện theo ngành hàng, lọc theo size/màu/giá, giỏ hàng,
   đặt hàng, thanh toán thẻ/QR/chuyển khoản thật tại Việt Nam hoặc COD, theo dõi đơn, đổi trả, đánh giá,
   trợ lý AI gợi ý + chatbot.
2. **Web quản trị** (nhân viên cửa hàng, nhiều vai): chủ shop/admin, quản lý cửa hàng, nhân viên bán hàng
   & CSKH, nhân viên kho, kế toán, marketing. Mỗi vai một bộ quyền; admin cấp/chặn quyền riêng cho từng người.

Ngôn ngữ giao diện: **chỉ tiếng Việt**. Tiền tệ: **VND**.

## Không làm

- Marketplace nhiều gian hàng, hoa hồng, ví nhà bán.
- Đa ngôn ngữ, bảng dịch, AI dịch.
- Lưu số thẻ / CVV (PCI-DSS) — thanh toán thẻ đi qua trang VNPay.
- OCR, tìm bằng hình ảnh.

## Vai nhân viên (preset quyền)

| Vai (code) | Phạm vi |
|---|---|
| `admin` | Toàn quyền, quản lý nhân viên & phân quyền, tham số vận hành |
| `manager` | Ngành hàng, sản phẩm, tồn kho, đơn, khuyến mãi, báo cáo, kiểm duyệt đánh giá |
| `sales` | Đơn hàng (xác nhận/đóng gói/giao), trả lời đánh giá, yêu cầu hỗ trợ từ chatbot, khách hàng |
| `warehouse` | Tồn kho, phiếu nhập/điều chỉnh, đóng gói/giao đơn |
| `accountant` | Thanh toán, đối soát chuyển khoản, hoàn tiền, báo cáo doanh thu |
| `marketing` | Banner, khuyến mãi, bộ sưu tập, AI soạn mô tả, kho tri thức chatbot |
| `customer` | Khách — không có mã quyền quản trị |

Quyền hiệu lực = quyền của vai ∪ cấp riêng − chặn riêng (deny thắng).

## Tham chiếu

- Format code/tài liệu bám theo `D:\project_ago_fruit\ago_erp\ago_backend` (AGENTS + PLANS + explain + docs).
- Nghiệp vụ và AI tham khảo `D:\Fullstack\eco_books\eco_backend` (bản sàn đa gian hàng, Python) — chỉ
  giữ phần phù hợp một cửa hàng.
