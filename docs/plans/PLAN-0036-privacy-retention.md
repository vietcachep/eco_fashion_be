# PLAN-0036 — WP-12: Dữ liệu cá nhân & lưu trữ — NGOÀI PHẠM VI

> Status: **Removed from scope** (chủ dự án, 2026-10-27) · Plan cha: PLAN-0023

Không thuộc luồng mua bán end-to-end của dự án demo nên không làm: yêu cầu xoá tài khoản, ẩn danh hoá, thời hạn lưu trữ theo luật, trigger chống sửa audit.

Giữ lại (đã có hoặc nằm trong review): log/thông báo/email không lộ số tài khoản đầy đủ, mật khẩu, token — đã áp dụng ở PLAN-0022 và được kiểm trong review chéo **R2** (`PLAN-0023` §7.2, kịch bản SEC-08). Chứng từ tiền không có job purge (giữ như hiện tại).
