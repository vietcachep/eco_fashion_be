# PLANS.md — Luật lập kế hoạch EcoFashion Backend

## Mục đích

File này quy định cách tạo và duy trì plan triển khai. Agent phải dùng plan cho việc lớn: module mới,
thiết kế schema, luồng nghiệp vụ, thanh toán, đổi auth/phân quyền, liên module, báo cáo, tích hợp, deploy.

EcoFashion là **một cửa hàng thời trang** với hai giao diện (web bán hàng, web quản trị nhiều vai
nhân viên), chỉ tiếng Việt, thanh toán thật tại Việt Nam. Kiến trúc Modular Monolith, microservice-ready.

## Khi nào phải có plan

- Tạo module mới / schema mới / thêm-đổi nhiều bảng
- Luồng nghiệp vụ (checkout, vòng đời đơn, hoàn tiền, nhập kho)
- Đổi authentication/authorization
- Thêm giao tiếp liên module (gateway, outbox)
- Tích hợp ngoài (PayOS, Cloudinary, OpenAI, email)
- Báo cáo/dashboard
- Refactor kiến trúc, deploy

Sửa bug nhỏ không cần plan trừ khi đụng ranh giới module, schema, auth, thanh toán.

## Vị trí và tên

```text
docs/plans/PLAN-0001-project-skeleton.md
docs/plans/PLAN-0002-identity.md
docs/plans/PLAN-0003-catalog.md
docs/plans/PLAN-0004-product-inventory.md
docs/plans/PLAN-0005-cart.md
docs/plans/PLAN-0006-order.md
docs/plans/PLAN-0007-payment-vnpay.md
docs/plans/PLAN-0008-promotion.md
docs/plans/PLAN-0009-review.md
docs/plans/PLAN-0010-system.md
docs/plans/PLAN-0011-reporting.md
docs/plans/PLAN-0012-ai-assistant.md
```

Template: `docs/plans/PLANS_TEMPLATE.md`. Một việc một plan; việc phát sinh trong module đã có plan thì
cập nhật plan đó (thêm mục `PLAN-000X.Y` nếu là đợt mới rõ ràng).

## Nội dung bắt buộc

1. Mục tiêu · 2. Bối cảnh · 3. Phạm vi (in/out) · 4. Module ảnh hưởng · 5. Thiết kế DB (schema, bảng,
migration, luật) · 6. API · 7. Bước triển khai (checklist) · 8. Kiểm thử · 9. Rủi ro/giả định/câu hỏi ·
10. Nhật ký tiến độ · 11. File đã đổi · 12. Việc tiếp theo · 13. Definition of Done.

## Quy trình

1. Đọc `AGENTS.md`, `README.md`, `docs/04_ROADMAP.md`, plan liên quan.
2. Viết/cập nhật plan. **Chưa có plan thì chưa sửa code production.**
3. Trước mỗi bước mới: giải thích luồng theo `explain.md` (trừ bước test).
4. Code đúng phạm vi plan; tick checklist; ghi nhật ký tiến độ + file đã đổi khi xong.
5. Cập nhật `README.md §Trạng thái`, `docs/02_MODULE_MAP.md`, `docs/database/eco_fashion.dbml` khi
   schema/API đổi.
