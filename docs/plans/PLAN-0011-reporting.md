# PLAN-0011 — Reporting: dashboard, doanh thu, bán chạy, tồn kho

> Status: Done
> Owner: Agent
> Related Phase: Phase 4 — Vận hành
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

* Bảng tổng hợp theo ngày `reporting.daily_sales` do **worker** tính (`recomputeDay`: đơn tạo trong ngày giờ VN; doanh thu = đơn đã thanh toán
  và không huỷ; khách mới; hoàn tiền đã xử lý) — mỗi 5 phút cho hôm nay, 00:05 chốt hôm qua, lúc khởi động bù 7 ngày.
* Dashboard: hôm nay / tháng này / 7 ngày / top 5 / trạng thái đơn / phương thức thanh toán + **việc đang chờ** (chờ xác nhận, chờ thanh toán,
  đóng gói, đang giao, đổi trả, chuyển khoản chờ đối soát, hoàn tiền, liên hệ mới, hỗ trợ chatbot, sắp hết hàng).
* Doanh thu theo ngày/tháng (kỳ trống vẫn hiện 0), sản phẩm bán chạy trong kỳ, biến thể sắp hết, tổng quan tồn kho (giá trị tồn).
* SELECT xuyên schema **chỉ đọc** (ngoại lệ có chủ đích, docs/03) — không bao giờ ghi vào bảng module khác. Cache Redis 60–300s.

## 5. Thiết kế DB — schema `reporting`

`daily_sales` (day pk yyyy-mm-dd). Migration `20260915110000_shop_modules_init`.

## 6. API (quyền `reporting.*`)

```text
GET /admin/reports/dashboard · GET /admin/reports/revenue?from&to&granularity=day|month · GET /admin/reports/top-products?from&to&limit
GET /admin/reports/low-stock?threshold&limit · GET /admin/reports/inventory · POST /admin/reports/recompute {from,to}
```

## 7–8. Triển khai & kiểm thử

* [x] ReportingService + controller + ReportingWorkerModule (`DailySalesJob`) · test thuần (periods, vnDay) · smoke: dashboard/revenue/top/low-stock/inventory; khách → 403.
