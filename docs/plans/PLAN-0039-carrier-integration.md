# PLAN-0039 — WP-15: Tích hợp hãng vận chuyển (giai đoạn 2)

> Status: Draft · Đợt 5 (sau go-live) · P2 · Phụ thuộc: WP-07, WP-13 · Plan cha: PLAN-0023
> Lỗ hổng: G63 (phí ship), G69 · Kịch bản mới: nhóm `SHP-C*`

## 1. Vấn đề

Trạng thái giao do shop tự khai (WP-07 chỉ thêm bằng chứng thủ công); phí ship cố định theo tỉnh; COD tiền mặt nằm ở shop nên sàn phải dùng ví cọc để thu hoa hồng.

## 2. Hướng đề xuất (chốt khi bắt đầu — chọn 1–2 hãng: GHN và/hoặc GHTK)

- Module mới `shipping` (ranh giới module như các module khác): tài khoản hãng của **sàn** (shop dùng chung) hoặc của từng shop (khai API token — mã hoá khi lưu).
- Tạo vận đơn từ màn shop (`confirmed/packing` ⇒ gọi API hãng ⇒ nhận mã vận đơn ⇒ `shipping` tự động).
- Webhook hãng ⇒ cập nhật `delivered` / `delivery_failed` / `returned_to_sender` (bằng chứng thật, thay khai tay) — shop không còn tự bấm "đã giao" cho đơn tạo qua hãng.
- Phí ship: báo giá theo cân nặng/kích thước/quận huyện lúc checkout (sản phẩm cần trường cân nặng — PLAN product bổ sung).
- **COD do hãng thu hộ về TK sàn** (đổi mô hình PLAN-0020): đơn COD vào đối soát như PayOS; ví cọc chỉ còn cho shop tự giao. Cần đối soát tiền COD hãng chuyển về (WP-10 mở rộng).

## 3. Rủi ro

Phụ thuộc API/hợp đồng hãng; webhook mất ⇒ cần poll trạng thái; đổi mô hình COD ảnh hưởng đối soát, ví, báo cáo, thuế — cần review R1 riêng.

## 4. Bước

- [ ] Khảo sát hợp đồng/API hãng (chủ dự án) · [ ] Plan chi tiết + kịch bản `SHP-C*` · [ ] BE module `shipping` · [ ] FE shop/khách · [ ] Đối soát COD hãng · [ ] UAT.
