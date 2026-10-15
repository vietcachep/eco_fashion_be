# PLAN-0019 — Người bán tự đăng ký gian hàng (form đăng ký → chờ duyệt → sàn duyệt → thành chủ shop)

> Status: In progress (2026-10-15) — Wave 0–2 xong, review độc lập (BE + storefront) đã xử lý; đã chạy thật trên DB cô lập (57/57) + E2E trình duyệt — sẵn sàng commit/deploy (nhớ migration `20261015120000_shop_registrations` và tạo lại dump `npm run db:dump`).
> Owner: Agent (điều phối) + subagent song song (BE · storefront) — chủ dự án chốt hướng ngày 2026-10-15.
> Related Phase: Phase 5 — Marketplace pivot (nối tiếp PLAN-0014/0017)
> Quy trình bắt buộc: **plan → code → test → review**. Mỗi đợt agent xong đều chạy lại kiểm tra trên trạng thái GỘP — không tin báo cáo "0 lỗi" của từng agent.
> Plan phía FE: `fashion_frontend_user/docs/plans/PLAN-0009-seller-registration.md` · `fashion_frontend_admin/docs/plans/PLAN-0003-shop-registration-review.md`.

> Luật ownership: dữ liệu của khách lọc theo `user_id` từ JWT; dữ liệu thuộc gian hàng lọc thêm theo `shop_id` (vendor: chỉ từ ngữ cảnh phiên, không từ URL/body); nhân viên sàn phân quyền theo mã `supplier.*`, vendor theo `shop.*`.

---

## 1. Mục tiêu

Hiện KHÔNG có cách nào để người bán mới vào sàn: shop chỉ được tạo bằng seed (`scripts/seed/marketplace.seed.ts`), sàn chỉ duyệt/từ chối/khoá được shop đã có.
Làm luồng đăng ký tự phục vụ:

1. Khách (đã đăng nhập) vào storefront `/sell` → điền form **Đăng ký bán hàng** (tên shop, người đại diện, số điện thoại, ngành hàng chính, mô tả ngắn, đồng ý điều khoản).
2. Backend tạo **gian hàng ở trạng thái `pending`** + hồ sơ đăng ký đi kèm. Người đăng ký CHƯA là thành viên shop, chưa bán được gì.
3. Nhân viên sàn thấy shop chờ duyệt (màn Gian hàng sẵn có) kèm hồ sơ đăng ký, **duyệt** hoặc **từ chối kèm lý do**.
4. Khi duyệt: người đăng ký **trở thành chủ shop** (tạo `ShopMember` vai `shop_owner`, active) trong CÙNG transaction với việc đổi trạng thái; họ đăng nhập web quản trị (cổng vendor) bằng chính tài khoản đó.
5. Người đăng ký xem được trạng thái (chờ duyệt / đã duyệt / bị từ chối + lý do); bị từ chối thì được nộp lại.

## 2. Bối cảnh

- Đảo ngược quyết định #6 của PLAN-0017 ("Đăng ký shop vẫn do admin tạo — KHÔNG làm form tự đăng ký đợt này"): chủ dự án chọn làm luồng tự đăng ký (2026-10-15).
- `SHOP_TRANSITIONS` đã có `pending → approved|rejected`; `rejected` là trạng thái cuối ("đăng ký lại là luồng khác" — chính là luồng này: nộp lại = TẠO shop mới).
- `Shop.ownerUserId` đã có sẵn = người đứng tên đăng ký. Mỗi người một shop active — chốt DB `uq_shop_members_one_active_per_user`.
- Web quản trị đã cho tài khoản vai `customer` vào cổng vendor khi `GET /shop/session` trả shop (admin `features/identity/api/auth-api.ts login()`), nên chủ shop mới KHÔNG cần đổi vai nền tảng.
- Cổng `/shop/**` hiện đều dùng `ShopContextGuard` (phải là thành viên). Endpoint đăng ký dành cho người CHƯA là thành viên ⇒ controller mới KHÔNG dùng guard này.

## 3. Phạm vi

### Trong phạm vi
* BE: bảng `shop.shop_registrations`; `POST /shop/registrations`, `GET /shop/registrations/me`, `GET /admin/shops/{id}/registration`; mở rộng duyệt/từ chối (`changeStatus`) để tạo chủ shop + ghi quyết định vào hồ sơ; thông báo cho người đăng ký khi có quyết định (nếu gắn được vào hạ tầng thông báo hiện có bằng một listener nhỏ — không thì ghi vào §10).
* Storefront: trang `/sell` (giới thiệu + form + hiện trạng thái hồ sơ), link ở footer/menu tài khoản, chế độ mock khi chưa có backend.
* Admin: thẻ **Hồ sơ đăng ký** ở chi tiết gian hàng (người đại diện, SĐT, ngành hàng, ghi chú, người nộp, ngày nộp, lý do từ chối); hộp thoại duyệt/từ chối hiện thông tin người đăng ký.

### Ngoài phạm vi
* Tải giấy tờ pháp lý (GPKD, CCCD), xác minh KYC/mã số thuế, gửi email — chỉ ghi vào §10 "làm sau".
* Sàn tự tạo shop thay người bán (hướng 2 — chưa làm).
* Cho phép nhiều shop / một người, đổi chủ shop.
* Sửa hồ sơ sau khi nộp (đang chờ duyệt thì không sửa; muốn đổi thì liên hệ sàn).

## 4. Module ảnh hưởng

* **shop** (chính) · identity (chỉ ĐỌC qua `IdentityQueryApi`/`IdentityApplicationApi` — tra vai nền tảng, tìm vai `shop_owner`) · catalog (chỉ ĐỌC ngành hàng qua queryapi) · system (tuỳ chọn: 1 listener thông báo).
* Không đổi catalog quyền (`perms:sync` KHÔNG cần): đăng ký chỉ đòi đăng nhập; endpoint admin dùng lại `supplier.shop.read`.

## 5. Thiết kế DB

### Schema / bảng
`shop.shop_registrations` — hồ sơ đăng ký đi kèm MỘT shop (quan hệ 1–1). **Trạng thái duyệt vẫn là `Shop.status`** (nguồn sự thật duy nhất, không chép trạng thái thứ hai):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK `gen_random_uuid()` | |
| `shop_id` | uuid NOT NULL **UNIQUE** | id trần tới `shop.shops` (không khai `@relation` để KHÔNG phải sửa `shop.prisma` — xem §6) |
| `applicant_user_id` | uuid NOT NULL, index | id user (identity) — bằng `Shop.ownerUserId` lúc nộp |
| `representative_name` | varchar(120) NOT NULL | |
| `phone` | varchar(20) NOT NULL | chuẩn hoá số VN (`0xxxxxxxxx`) |
| `category_id` | uuid NULL | id ngành hàng (catalog) — id trần |
| `category_name` | varchar(200) NULL | snapshot tên ngành lúc nộp |
| `description` | varchar(1000) NULL | giới thiệu ngắn về shop/mặt hàng định bán |
| `terms_accepted_at` | timestamptz NOT NULL | thời điểm đồng ý điều khoản người bán |
| `decision_reason` | varchar(500) NULL | lý do từ chối/khoá (chép từ `reason` của `changeStatus`) |
| `decided_at` / `decided_by` | timestamptz / uuid NULL | lần duyệt/từ chối đầu tiên |
| `created_at`, `created_by`, `updated_at`, `updated_by`, `version`, `is_deleted` | chuẩn Base Columns | `docs/03_DATABASE_RULES.md` luật 4 |

Index: unique `shop_id`; `(applicant_user_id, created_at desc)`.

### Migration
`prisma/migrations/20261015120000_shop_registrations/migration.sql` — **viết tay CHỈ cho bảng này** (KHÔNG chạy `migrate dev`: phiên song song đang có thay đổi schema chưa có migration — `migrate dev` sẽ nuốt luôn phần của họ vào migration của mình).

### Luật
* Không FK xuyên module; FK trong cùng schema được phép nhưng bảng này **không** khai FK tới `shops` để `migration:check` (`migrate diff`) không lệch vì thiếu `@relation`; toàn vẹn do service (cùng transaction) + unique `shop_id`.
* Một người chỉ có **một hồ sơ đang chờ** tại một thời điểm: kiểm trong transaction sau `pg_advisory_xact_lock(hashtextextended('shop-registration:' || userId, 0))` (không thêm partial index lên `shops` vì không được sửa `shop.prisma`).

## 6. Quy tắc làm việc song song với phiên khác (BẮT BUỘC — đã có phiên khác đang sửa code)

Lúc lập plan, working tree có sẵn rất nhiều thay đổi chưa commit của phiên khác (PLAN-0018: bỏ VNPay/ví, đổi thanh toán). Quy tắc để KHÔNG xung đột:

1. **File mới là chính.** Mọi code mới nằm trong thư mục/file MỚI (`src/modules/shop/registration/**`, `prisma/schema/shop-registration.prisma`, `features/seller/**`…).
2. **Chỉ sửa file dùng chung bằng `Edit` chèn ngắn** (không `Write` đè, không format lại file), đọc lại file NGAY trước khi sửa. Danh sách file dùng chung ĐƯỢC phép sửa ở mỗi repo nằm trong brief từng agent; ngoài danh sách ⇒ không đụng.
3. **KHÔNG đụng** file mà `git status` đang báo `M`/`D`/`??` khi bắt đầu, trừ các ngoại lệ chèn ngắn đã liệt kê. Đặc biệt BE: `prisma/schema/shop.prisma`, `prisma/schema/payment.prisma`, `shop.responses.ts`, `shop.mapper.ts`, `shop.repository.ts`, `shop.queryapi.ts`, `modules/order/**`, `modules/payment/**`, `system/enums/setting-keys.ts`, `docs/0*.md`, `AGENTS.md`.
4. **Không chạy lệnh làm đổi trạng thái chung**: `git stash/checkout/reset/clean/commit/push`, `prisma migrate dev|reset|db push`, `npm run api:sync`/`api:gen` (Orval `clean: true` xoá cả thư mục sinh), `nest build`/`next build`/`next dev` trong thư mục repo đang có dev server của phiên kia (tranh `dist/` và `.next/`). Kiểm tra bằng `tsc --noEmit`, `eslint <file>`, `jest <file>`, `check:boundaries`.
5. Client Orval của FE cho endpoint mới: sinh **ra thư mục tạm** rồi chép CHỈ file mới (+ chèn dòng vào barrel) — do điều phối làm ở Wave 2, không phải agent FE.
6. Ghi lại danh sách chính xác file đã sửa/tạo để chủ dự án tách commit (git do chủ dự án điều khiển).

## 7. API

```text
POST /api/v1/shop/registrations         JWT (khách đã đăng nhập; KHÔNG cần là thành viên shop; KHÔNG dùng ShopContextGuard)
GET  /api/v1/shop/registrations/me      JWT — hồ sơ MỚI NHẤT của tôi; chưa từng đăng ký ⇒ data = null
GET  /api/v1/admin/shops/{id}/registration   supplier.shop.read — hồ sơ đăng ký của shop; shop không có hồ sơ (seed/admin tạo) ⇒ data = null
PATCH /api/v1/admin/shops/{id}/approve  (CÓ SẴN, đổi hành vi) — nếu shop có hồ sơ đăng ký ⇒ tạo ShopMember owner cho applicant
PATCH /api/v1/admin/shops/{id}/reject   (CÓ SẴN, đổi hành vi) — chép `reason` vào hồ sơ để người đăng ký đọc được
```

`POST /shop/registrations` — body `SubmitShopRegistrationRequest`:

| Trường | Luật |
|---|---|
| `shopName` | string, trim, 3–100 ký tự |
| `representativeName` | string, trim, 2–120 |
| `phone` | SĐT Việt Nam: `0[35789]xxxxxxxx` hoặc `+84…` (chuẩn hoá về `0…`) |
| `categoryId` | uuid ngành hàng đang hoạt động (kiểm qua catalog queryapi) |
| `description` | string ≤ 1000, tuỳ chọn |
| `acceptTerms` | boolean, **phải `true`** |

201 → `ShopRegistrationResponse`. Giới hạn `@RateLimit({ name: 'shop-registration-submit', limit: 5, windowSeconds: 86400, by: 'user' })`.

`ShopRegistrationResponse`: `{ id, shopId, shopCode, shopName, status: 'pending'|'approved'|'rejected'|'suspended', representativeName, phone, category: { id, name } | null, description: string | null, submittedAt, decidedAt: string | null, rejectReason: string | null, canReapply: boolean }` — `canReapply = status === 'rejected'` (và không có hồ sơ chờ khác — đã đảm bảo bởi luật một-hồ-sơ-chờ).

`ShopRegistrationDetailResponse` (admin) = các trường trên + `applicant: { userId, fullName, email } | null`. Admin xem được SĐT/email (cổng nhân viên sàn có `supplier.shop.read`).

Lỗi (mã ổn định — thêm vào `SHOP_ERR`):

| HTTP | Mã | Khi nào |
|---|---|---|
| 409 | `SHOP_REGISTRATION_PENDING` | đã có hồ sơ chờ duyệt |
| 409 | `SHOP_REGISTRATION_ALREADY_MEMBER` | đã là thành viên active của một gian hàng |
| 403 | `SHOP_REGISTRATION_NOT_ELIGIBLE` | tài khoản nhân viên sàn (vai ≠ `customer`) hoặc tài khoản không active |
| 400 | `SHOP_REGISTRATION_CATEGORY_INVALID` | ngành hàng không tồn tại/không hoạt động |
| 409 | `SHOP_NAME_TAKEN` | trùng tên (không phân biệt hoa/thường) với shop `pending`/`approved`/`suspended` khác |
| 409 | `SHOP_OWNER_UNAVAILABLE` | (khi DUYỆT) người đăng ký nay đã thuộc shop khác / tài khoản bị khoá — sàn không duyệt được, nên từ chối |
| 429 | `COMMON_RATE_LIMITED` | quá giới hạn nộp |

Quy tắc duyệt (mở rộng `ShopService.changeStatus`, cùng transaction đã khoá `FOR UPDATE` shop):
* `target = approved` và shop **có** hồ sơ đăng ký và **chưa có** thành viên owner active ⇒ kiểm applicant (user active, vai nền tảng `customer`, chưa là thành viên active shop khác) → tạo `ShopMember{shopId, userId: ownerUserId, roleId: shop_owner, active}` + audit `SHOP_MEMBER_ADDED` (via `registration_approved`) + `outbox SHOP_MEMBER_JOINED`. Không đạt ⇒ 409 `SHOP_OWNER_UNAVAILABLE`, KHÔNG đổi trạng thái.
* `suspended → approved` (mở khoá) và shop seed (đã có owner member) ⇒ KHÔNG tạo thêm.
* `approved|rejected|suspended` đầu tiên ⇒ ghi `decision_reason/decided_at/decided_by` vào hồ sơ (nếu có) — lần đầu thôi.

## 8. Bước triển khai

### Wave 0 — plan
* [x] Plan BE này + plan FE (storefront PLAN-0009, admin PLAN-0003).

### Wave 1 — code song song (BE ‖ storefront)
* [x] BE-1: `prisma/schema/shop-registration.prisma` (model + comment) + migration tay + `prisma generate` + kiểm khớp (`migrate diff` giữa hai thư mục schema, không cần DB).
* [x] BE-2: `src/modules/shop/registration/**` (request/dto/mapper/repository/service/controllers/rules) + hằng số lỗi/audit/event + đăng ký vào `shop.module.ts` (chèn ngắn).
* [x] BE-3: mở rộng `ShopService.changeStatus` (tạo owner khi duyệt, ghi quyết định vào hồ sơ) — logic nằm ở `ShopRegistrationService.prepareStatusChange/recordDecision`, ShopService chỉ gọi hai hàm này.
* [x] BE-4: spec đơn vị (luật thuần: chuẩn hoá SĐT, slug, kiểm điều kiện, luồng duyệt) + `check:boundaries` + `tsc --noEmit` + eslint file mới.
* [ ] BE-5 (tuỳ chọn, CHƯA làm): thông báo cho người đăng ký khi có quyết định — xem §10.
* [x] FE-user-1: `features/seller/**` (schema Zod, api + mock, hooks, màn hình), route `/sell`, link footer/menu (chèn ngắn), plan PLAN-0009, lint + typecheck.

### Wave 2 — nối
* [x] Điều phối: lấy OpenAPI từ BE đã sửa (không chạy `api:sync`), sinh client Orval ra thư mục tạm, chép file mới vào `fashion_frontend_admin/src/lib/api/generated` (+ barrel) và vào storefront nếu storefront dùng kiểu sinh. **Đã làm:** sinh OpenAPI CHỈ cho 3 route từ controller thật bằng Nest testing module (không cần DB), Orval ra thư mục tạm, chép `generated/{shop-registrations,admin-shop-registrations}` + 7 model + 4 dòng barrel. Tag riêng (`shop-registrations`, `admin-shop-registrations`) để không đụng file sinh đang bị phiên khác sửa. Lần `api:sync` đầy đủ sau này tự sinh lại y hệt.
* [x] Admin-1: hook `useAdminShopRegistration` bọc hàm sinh, thẻ **Hồ sơ đăng ký** + thông tin trong hộp thoại duyệt/từ chối, plan PLAN-0003. (thẻ nằm ở tab Hồ sơ của chi tiết shop; hộp thoại Duyệt nhắc người đăng ký thành chủ shop).
* [x] Tài liệu: `docs/06_FE_CONTRACT.md` (mục "đăng ký gian hàng"), `docs/02_MODULE_MAP.md`, `docs/03_DATABASE_RULES.md` (bảng mới), `AGENTS.md` bảng module shop — chèn ngắn khi phiên kia xong hoặc ngay nếu chèn không đè. (06_FE_CONTRACT mục "đăng ký gian hàng", 02_MODULE_MAP, 03_DATABASE_RULES, AGENTS.md, PLAN-0017 #6).

### Wave 3 — test
* [x] `npm test` (jest) toàn BE + `check:boundaries` + `tsc --noEmit` — phân biệt lỗi của mình với lỗi dở dang của phiên khác. **Kết quả:** `npm test -- src/modules/shop` 8 suite / 173 test xanh; eslint `src/modules/shop` sạch; `check:boundaries` sạch; `tsc --noEmit` chỉ còn 1 lỗi của phiên khác (`system-worker.module.spec.ts`).
* [ ] Chạy thật trên DB **cô lập** (container Postgres/Redis riêng, KHÔNG dùng DB dev của phiên kia): `migrate deploy` + nạp dump mẫu + chạy API: đăng ký → xem trạng thái → admin duyệt → chủ shop đăng nhập `/shop/session`; từ chối → nộp lại; các lỗi 409/400/403/429.
* [x] FE: lint + typecheck (+ build khi không còn dev server của phiên kia chạm cùng thư mục); thử `/sell` ở chế độ mock trên cổng riêng. **Kết quả:** storefront và admin lint + typecheck sạch; `/sell` đã thử ở chế độ mock trong bản sao tạm (cổng 3199). `next build` CHƯA chạy (tránh tranh `.next/` với phiên kia).

### Wave 4 — review
* [x] Review độc lập (agent không bị neo bởi kết quả của mình): bảo mật (không lộ SĐT/email người khác, race 2 hồ sơ, 2 admin duyệt cùng lúc, applicant đã vào shop khác giữa chừng), ranh giới module, tuân thủ Rule 0–4, xung đột với phiên song song. **Đã làm** (2 reviewer độc lập: BE và storefront, không thấy lỗi nghiêm trọng; các mục trung bình/nhẹ đã sửa — §9.12–9.16).
* [x] Sửa lỗi review → chạy lại Wave 3 → ghi §9/§10. (chạy lại jest `src/modules/shop` 173/173 xanh, eslint + tsc sạch; phần DB thật còn chờ — §10).

## 9. Nhật ký quyết định

1. Trạng thái duyệt = `Shop.status`; hồ sơ chỉ giữ thông tin nộp + lý do quyết định. Tránh hai nguồn sự thật.
2. `ShopMember` owner tạo **lúc duyệt**, không lúc nộp: shop `pending` chưa có thành viên ⇒ người nộp không vào được cổng vendor sớm, không phá chốt "mỗi người một shop active" khi bị từ chối.
3. Nộp lại sau khi bị từ chối = TẠO shop + hồ sơ mới (shop `rejected` là trạng thái cuối theo `SHOP_TRANSITIONS`; giữ lịch sử).
4. Bảng hồ sơ nằm trong file schema riêng `shop-registration.prisma` (cùng schema `shop`) để không sửa `shop.prisma` đang bị phiên song song sửa; có thể gộp vào `shop.prisma` sau (không bắt buộc, `prisma-boundaries.spec.ts` vẫn gác đúng schema).
5. Không thêm cột/quyền mới vào `Shop`/catalog quyền; hoa hồng mặc định 10% của DB, sàn đổi bằng `PATCH /admin/shops/{id}/commission` sau khi duyệt.
6. Ngành hàng đọc từ `CatalogQueryApi` qua `ModuleRef` LƯỜI (`strict:false`), không tiêm ở constructor: `CatalogModule` đã import `ShopModule` (guard của `/shop/catalog`) nên `ShopModule` import ngược `CatalogModule` là vòng ở cả `check:boundaries` lẫn DI. Cùng kiểu `PaymentService` lấy cổng ngược sang order. File-level chỉ import `catalog/queryapi` (được phép).
7. Khoá advisory dùng `$executeRaw` (không phải `$queryRaw` như §5): `pg_advisory_xact_lock` trả `void`, Prisma không đọc được cột void. Hai khoá: theo người nộp (`shop-registration:<userId>`, dùng chung bởi nộp hồ sơ VÀ duyệt) và toàn cục `shop-code` (mọi lần nộp đi qua ⇒ mã/slug/tên được cấp nguyên tử; unique `shops.code/slug` là chốt cuối, P2002 ⇒ 409 `SHOP_CODE_EXISTS`).
8. Kiểm trùng tên bằng SQL `lower(name) = lower($1)` (không dùng Prisma `equals` + insensitive: đó là ILIKE nên `_`/`%` trong tên bị hiểu là ký tự đại diện). Mã `SHOP-######` lấy `max(...)+1` từ mã khớp `^SHOP-[0-9]{6}$` (kể cả shop xoá mềm), không bao giờ nhỏ hơn số của FITLY Official (`SHOP-000001`).
9. `GET /admin/shops/{id}/registration`: shop KHÔNG tồn tại ⇒ 404 `SHOP_NOT_FOUND`; shop có nhưng không có hồ sơ (seed/admin tạo) ⇒ `data = null`. Hồ sơ trả `rejectReason` CHỈ khi shop đang `rejected` (lý do khoá về sau không chép sang hồ sơ).
10. Outbox `SHOP_APPROVED/SUSPENDED/REJECTED` thêm hai trường vào payload (cộng thêm, không đổi trường cũ): `ownerUserId`, `viaRegistration` — để listener thông báo người đăng ký (§10) không phải đọc lại DB.
11. `RateLimitGuard` là guard TOÀN CỤC chạy TRƯỚC ValidationPipe nên MỌI lần gọi `POST /shop/registrations` (kể cả bị 400/409) đều tính vào hạn mức 5 lần/ngày/người.

12. **Review BE (độc lập) — sửa:** `ShopRepository.listNonApprovedIds` chỉ lấy shop không-approved ĐÃ TỪNG có thành viên (`members.some`). Lý do: hồ sơ tự đăng ký chưa duyệt/bị từ chối chưa bao giờ có thành viên nên không có sản phẩm; để lọt vào danh sách thì mỗi lượt đăng ký thêm một id vào `shopId NOT IN (...)` của MỌI truy vấn sản phẩm công khai (phình dần, có thể vượt giới hạn tham số). Có test `shop-non-approved-ids.spec.ts`.
13. **Hạn mức nộp 5 → 15 lần/ngày/người** (tính cả lần lỗi): với 5, người thử 5 tên trùng liên tiếp bị khoá 24h dù chưa có hồ sơ nào. Chốt chống spam thật là luật một-hồ-sơ-chờ.
14. `normalizeShopName` chuẩn hoá **NFC** (chữ tiếng Việt tổ hợp/dựng sẵn ra cùng chuỗi, không lách được kiểm trùng tên). Bổ sung test thứ tự khoá khi DUYỆT (FOR UPDATE shop → advisory người nộp → kiểm → tạo chủ).
15. Tag Swagger tách riêng (`shop-registrations`, `admin-shop-registrations`) để Orval sinh file mới thay vì ghi đè `shops`/`admin-shops` (file sinh đang bị phiên khác sửa).
16. **Review storefront — sửa:** form không bị gỡ khi refetch nền ngành hàng lỗi; regex SĐT nhận `0084…`; lỗi không phải API không lộ chuỗi kỹ thuật; chống double-submit; mock/comment `suspended` khớp BE (không trả lý do); mock 429 ở lần 16.

## 10. Giới hạn đã biết / làm sau

* Thông báo cho người đăng ký khi sàn duyệt/từ chối: CHƯA làm. Hạ tầng thông báo cho thành viên shop nằm ở `system/system-worker.module.ts` (`ShopNotificationListeners`) — phiên PLAN-0018 đang sửa file đó. Khi gắn: thêm `@OnEvent('outbox.shop.SHOP_APPROVED' | 'SHOP_REJECTED')` ở đó, chỉ gửi khi `payload.viaRegistration === true` tới `payload.ownerUserId` (reason có sẵn trong payload) qua `NotificationGateway.notify` (dedupe theo `payload.eventId` như các listener hiện có); không cần sửa `setting-keys.ts`.
* Mã lỗi phụ ngoài bảng §7: `SHOP_REGISTRATION_PHONE_INVALID` (400) — lưới phòng thủ khi service được gọi không qua HTTP (Request DTO đã chặn SĐT sai bằng `COMMON_VALIDATION_ERROR`).
* Chưa có tải giấy tờ pháp lý, KYC, mã số thuế, email thông báo.
* Người bán bị từ chối phải nộp lại từ đầu (không sửa hồ sơ cũ).
* Mã quyền `shop.staff.invite` vẫn là tên cũ (xem PLAN-0017 §3b).
* **Đã chạy trên Postgres/Redis thật (2026-10-15, môi trường cô lập):** migration áp dụng trên DB đã có dữ liệu mẫu, `migrate diff` không lệch; bộ kiểm tra HTTP 57/57 đạt (nộp, mọi mã lỗi, duyệt → chủ shop vào `/shop/session`, từ chối + nộp lại, đua nộp cùng người/cùng tên/4 người cùng lúc, duyệt đồng thời, duyệt khi người nộp đã vào shop khác ⇒ 409, shop seed không sinh thêm thành viên, rate limit 15/ngày, audit không chứa SĐT/email); `lower('ĐỒ')` ra đúng với locale `en_US.utf8`; E2E trình duyệt thật (storefront `/sell` ↔ admin duyệt/từ chối ↔ cổng vendor) PASS. Lưu ý: lỗi chuyển trạng thái sai (duyệt shop đã duyệt/đã từ chối) trả HTTP **400** `SHOP_INVALID_TRANSITION` (hành vi có sẵn của `assertTransition`), không phải 409.
* `GET /shop/registrations/me` và `GET /admin/shops/{id}/registration` trả `data: null` nhưng Swagger khai kiểu không-null ⇒ FE ép kiểu ở hook (đã làm ở admin `use-admin-shop-registration.ts`).
* `emailVerified` không bắt buộc khi nộp; chưa có endpoint rút hồ sơ đang chờ (liên hệ sàn); chưa có job dọn hồ sơ chờ lâu ngày.
* `slugExists` bỏ qua `is_deleted` trong khi unique `shops.slug` tính cả dòng xoá mềm (hiện chưa có đường xoá mềm shop); mã > `SHOP-999999` không khớp mẫu `^SHOP-[0-9]{6}$` (lý thuyết).
* Open-redirect có sẵn ở trang đăng nhập storefront (`?next=/\evil.com`) do reviewer phát hiện — NGOÀI phạm vi, đã tách thành việc riêng.
