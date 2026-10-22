# Tech Lead Review — 2026-10-22 — run 44 (A6.1 Clients UI + debt)

## Kết luận: PASS (có điều chỉnh phạm vi; fold bắt buộc nằm ở mục "Fold tech-lead" trong `tasks.md`)

Plan đúng hướng A6.1 và gom đúng các debt đích (DEBT-281/290/294/296/297/299). Có ba chỗ lệch so với code thật, cả ba đều chốt được mà không cần analyst sửa spec:

1. API clients không có sort/filter.
2. Lỗi 400 không có field có cấu trúc.
3. Mọi thao tác ghi đều cần step-up, không riêng `redirectUris`.

Thêm vào đó, phạm vi L được tách ra. Vì vậy không có blocker và không phải trả về analyst.

## Kiến trúc đề xuất

- Giữ nguyên fe-admin là BFF khối, khuôn A5: mỗi server fn bọc một endpoint cố định, input là zod, response là zod allowlist. Chỉ mở rộng `Method` thêm `"POST"` (run 45 thêm `"DELETE"`).
- **Q-44.1:** dùng decorator tay (`@ApiOkResponse({ type })` cùng các class view chỉ phục vụ schema, `implements` interface của mapper). **Không** bật swagger CLI plugin, vì:
  - plugin chỉ đọc class `*.dto.ts`/`*.entity.ts`;
  - plugin chỉ chạy qua `nest build`, nên document sẽ khác nhau giữa build và int/E2E.

  Chống lệch bằng hai test: một unit test BE so key của mapper với `properties` của schema, và một kiểm type-level ở fe-admin giữa zod và type sinh ra. Snapshot `fe-admin/openapi/admin.json` được cập nhật qua `fetch:api && gen:api`; spec `admin-openapi.spec.ts` sẽ bắt nếu quên.
- **Q-44.2 (phiên bản, tra registry chỉ-đọc ngày 2026-10-22):**
  - `@tanstack/react-form` **1.33.5** exact, phát hành 2026-08-11 (72 ngày). Phụ thuộc: `form-core` 1.33.5 exact; `react-store`/`store` 0.11.2 (2026-09-29, đã có trong lock); `devtools-event-client` 0.4.4 (2026-06-19). Không cần override. Không dùng 2.0.0-alpha. Zod 4 đi qua Standard Schema nên không cần adapter.
  - `@tanstack/react-table`: **không cài ở run này**. API không có sort/filter, mỗi trang ≤100 dòng, nên `<table>` ngữ nghĩa là đủ (DEBT-303). Nếu cần sau này: dòng 9.x mới ra (9.0.0 phát hành 2026-08-04). Bản mới nhất 9.3.1 (2026-10-12) chưa đủ 14 ngày; bản đủ tuổi là **9.2.6** (2026-10-04), nhưng phải tra lại registry lúc cài.
- **Q-44.3:** tách phạm vi.
  - **Run 44** = Task 1 (BE, gồm schema cho secrets), Task 2 (debt FE), Task 3 (list/detail/form tạo-sửa), Task 3E (E2E step-up, DEBT-281).
  - **Run 45 (A6.1b)** = dialog secret một lần, rotate/revoke, disable/enable, E2E secret. Ràng buộc bảo mật cho phần này đã ghi sẵn trong `tasks.md`.
- **Phân công:** backend-dev làm Task 1; frontend-dev làm Task 2, 3, 3E.

## Điểm mạnh

- Bám đúng hợp đồng BE đã cứng hoá ở run 27/30/31: `clientId` do server sinh, field bất biến, rule admin-capable, disable phải gửi một mình.
- Dùng lại hạ tầng step-up intent và error union của A5 thay vì làm mới.
- Gom đúng các debt phải xong trước khi có form thật: DEBT-297 trước create, DEBT-299 trước restore draft.

## Vấn đề (đã fold, bắt buộc theo `tasks.md`)

- [x] Sort/filter phía server không tồn tại (`listForTenant`: `clientId` tăng dần, chỉ có `limit/after`). UI không làm sort/filter, không lọc client-side; DEBT-300.
- [x] Lỗi 400 chỉ có `error_description` dạng chuỗi. Lỗi theo field lấy từ zod phía client (mirror luật BE); lỗi BE hiện ở cấp form, không parse chuỗi; DEBT-301.
- [x] Wildcard bị BE từ chối ở mọi môi trường, nên FE phải coi là **lỗi**, không phải cảnh báo. Chặn scheme khác http(s) (`javascript:`, `data:`…). `http:` chỉ chấp nhận với hostname `localhost`, và chỉ ở mức cảnh báo vì BE quyết định theo môi trường. CORS phải là exact origin. URI đã lưu chỉ render dạng text, không bao giờ là `<a href>`.
- [x] `@RequireRecentAuth(5)` có trên **mọi** thao tác ghi, và AT từ refresh grant không có `auth_time`. Vì vậy step-up round-trip áp dụng cho cả create lẫn mọi update. Draft chỉ khôi phục, không tự gửi; diff tính lại so với dữ liệu server vừa tải.
- [x] PATCH chỉ gửi field đã đổi; field bất biến không nằm trong state form; form sửa không bao giờ gửi `disabled`.
- [x] Rule admin-capable chỉ để hiển thị: cờ `adminCapable` tính trong server fn từ `OIDC_ISSUER`, nhãn cảnh báo "chỉ super_admin / confidential / thu hồi mọi secret". BE là chốt chặn (403/400).
- [x] DEBT-297 mở rộng: 2xx với body sai schema cũng phải là `uncertain` với mutation, và log không bao giờ chứa body (chuẩn bị cho `clientSecret` ở run 45).
- [x] Nit StrictMode: hàm đọc một lần không được nằm trong initializer của `useState`.
- [x] E2E DEBT-281 cần một cách gây `step_up_required` mà không thêm nhánh test vào code production. Đã chốt: `ACCESS_TOKEN_TTL` nhỏ cho E2E, chỉ khi cả suite xanh 2 lần; nếu không thì dùng test chờ hơn 5 phút.

### Cổng security design

- **Tài sản và actor:**
  - tài sản: cấu hình client (redirect/CORS, quyền resource) và secret (run 45);
  - actor: tenant_admin, super_admin, user không có role admin;
  - trust boundary: browser ↔ serverFn (BFF) ↔ admin API.

  BE kiểm tenant/role/step-up. FE không quyết định quyền.
- **Invariant:** draft step-up dùng một lần, gắn `action`+`path`+`sub`, TTL 10 phút, không tự gửi. Field bất biến không bao giờ có trong body.
- **Abuse case:**
  - XSS hoặc open redirect qua URI đã lưu ⇒ render dạng text;
  - double submit một create không idempotent ⇒ disable nút khi pending và xử lý `uncertain`;
  - lost update giữa hai admin ⇒ chỉ gửi field đổi, phần còn lại ghi DEBT-302;
  - leo quyền qua admin resource ⇒ BE 403; FE chỉ cảnh báo.
- **Failure:** timeout/5xx của mutation ⇒ `uncertain` + invalidate, không retry. 2xx với body sai ⇒ `uncertain`.
- **Exposure:** run 44 không xử lý secret. Ràng buộc cho run 45 (no-store, chỉ nằm trong state của dialog, không vào cache/intent/URL/storage/log/SSR) đã ghi trong `tasks.md`.

## Đề xuất (không bắt buộc) → backlog

- DEBT-300: filter phía server cho `GET /admin/clients` (`clientType`, `disabled`, tiền tố `clientId`).
- DEBT-301: lỗi 400 của admin có field có cấu trúc.
- DEBT-302: optimistic concurrency (`If-Match`/`updatedAt`) cho PATCH client.
- DEBT-303: TanStack Table hoãn tới khi có sort/filter phía server.
