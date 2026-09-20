# PLAN-XXXX — Tên việc

> Status: Draft / In Progress / Blocked / Done
> Owner: Agent / Developer
> Related Phase: Phase X — Tên
> Related Roadmap: `docs/04_ROADMAP.md`

> Luật ownership: một cửa hàng — dữ liệu của khách lọc theo `user_id` từ JWT; nhân viên phân quyền theo mã quyền.

---

## 1. Mục tiêu

* ...

---

## 2. Bối cảnh

EcoFashion: một cửa hàng thời trang, hai giao diện (web bán hàng + web quản trị nhiều vai nhân viên),
chỉ tiếng Việt, thanh toán thật tại Việt Nam. Modular Monolith, schema-per-module, không FK xuyên module.

Tài liệu tham chiếu: `AGENTS.md`, `README.md`, `docs/04_ROADMAP.md`, `docs/03_DATABASE_RULES.md`.

---

## 3. Phạm vi

### Trong phạm vi
* ...

### Ngoài phạm vi
* ...

---

## 4. Module ảnh hưởng

* common · identity · catalog · product · cart · order · payment · promotion · review · system · reporting · ai

---

## 5. Thiết kế DB

### Schema
* ...

### Bảng
* ...

### Migration
* `src/modules/<m>/migration/V<yyyymmdd><nnnnn>_<mo_ta>.ts`

### Luật
* Không FK xuyên module; FK chỉ trong cùng schema.
* Tham chiếu chéo bằng id + code + snapshot / source_*.
* Soft delete cho master data và chứng từ quan trọng.
* Tiền `numeric(14,0)` VND.

---

## 6. API

```text
GET    /api/v1/...
POST   /api/v1/...
```

* Request DTO có validator; Response DTO; không expose entity; Swagger cập nhật.

---

## 7. Bước triển khai

* [ ] Bước 1: ...
* [ ] Bước 2: ...

---

## 8. Kiểm thử

* [ ] `npm run build` xanh
* [ ] `npm run lint` + `npm run check:boundaries` xanh
* [ ] `npm test` xanh (service/controller/repository liên quan)
* [ ] `npm run migration:check` xanh (DB trống → migration → entity khớp)
* [ ] Swagger hiện API; thử tay bằng Swagger/REST client
* [ ] Không FK xuyên module; không import repository/entity module khác

---

## 9. Rủi ro / Ghi chú

* Rủi ro:
* Giả định:
* Câu hỏi mở:
* Chặn:

---

## 10. Nhật ký tiến độ

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| YYYY-MM-DD | Tạo plan | |

---

## 11. File đã đổi

```text
src/...
docs/...
```

---

## 12. Việc tiếp theo

* [ ] ...

---

## 13. Definition of Done

* [ ] Build/lint/boundaries/test xanh
* [ ] Migration thêm nếu đổi schema; DBML cập nhật
* [ ] Không FK xuyên module; không import chéo repository/entity
* [ ] Audit log cho API ghi; outbox nếu cần
* [ ] Swagger cập nhật
* [ ] Plan checklist + nhật ký + file đã đổi cập nhật
* [ ] README §Trạng thái + `02_MODULE_MAP` cập nhật
