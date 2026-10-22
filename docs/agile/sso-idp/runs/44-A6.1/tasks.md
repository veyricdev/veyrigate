# Tasks — run 44 — A6.1: Clients UI (M5, lane ADMIN) + debt đích A6.1

> Plan §6 A6.1 (size L): bảng clients (TanStack Table, phân trang/sort/lọc phía server), form tạo/sửa (TanStack Form + zod; editor `redirect_uris`, `postLogoutRedirectUris`, `allowedCorsOrigins` kiểm exact/absolute URL, cảnh báo wildcard), chọn `allowedResources`, `clientType`/auth method; dialog hiện `client_secret` **một lần** + rotate (step-up) + revoke — nghiệm thu "Không hiện lại secret sau khi đóng; sửa `redirect_uris` đi qua step-up; lỗi validate hiển thị theo field". Admin API clients/secrets (run 27, 30, 31: client id server sinh, field bất biến, admin-capable chỉ super_admin, disable phải đi một mình, rule admin chỉ confidential, rotate/revoke step-up). Debt: DEBT-281 (E2E step-up round-trip), DEBT-290 + DEBT-294 (OpenAPI BE thiếu schema response / `frontchannelLogoutUri` sai kiểu), DEBT-296 (race forced refresh), DEBT-297 (2xx body lỗi ⇒ uncertain), DEBT-299 (`saveIntent` xoá intent cũ), nit StrictMode `takeIntent` trong `useState` initializer.
>
> Thứ tự: Task 1 (backend-dev, OpenAPI) ‖ Task 2 (frontend-dev nền) → Task 3 → 4. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [BE]: DEBT-290 + DEBT-294 — OpenAPI response schemas
- Thêm DTO/schema response cho admin API (`@ApiOkResponse`… hoặc bật swagger plugin — tech-lead chốt cách gọn), sửa `frontchannelLogoutUri` `type: String`. Không đổi hành vi runtime.
- **Acceptance**: `/openapi/admin.json` có schema response cho endpoint clients/secrets (ít nhất phần A6 dùng); test BE OpenAPI xanh; fe-admin cập nhật snapshot + `gen:api`, bỏ `Omit` workaround.

### [x] Task 2 [FE]: Debt nền A5 (DEBT-296, 297, 299, nit StrictMode)
- DEBT-296 vòng `while (inflight)` so token cũ; DEBT-297 mutation 2xx body không parse được ⇒ `uncertain`; DEBT-299 `saveIntent` clear trước (đổi `it.fails` ⇒ `it`); `takeIntent` trong initializer `useState`.
- **Acceptance**: test tương ứng + mutation RED.

### [x] Task 3 [FE]: Clients list + detail + form sửa/tạo
- Bảng: phân trang cursor phía server (API run 27: `limit`, `after`), lọc/sort theo những gì API hỗ trợ (không bịa sort phía server nếu API không có — tech-lead chốt), TanStack Table (pin ≥14 ngày).
- Form TanStack Form + zod: URL editor (absolute, không fragment, cảnh báo wildcard/http trên non-localhost), `allowedResources` chọn từ `GET /admin/resources`, `clientType`/method theo cặp hợp lệ, field bất biến khoá khi sửa, lỗi validate theo field (cả lỗi 400 BE map về field nếu khả thi).
- Sửa `redirectUris`/`allowedResources`… ⇒ step-up round-trip (intent run 43) không mất dữ liệu form.
- **Acceptance**: component test; a11y form (label, aria-invalid, mô tả lỗi).

### [ ] Task 4 [FE/E2E]: Secrets dialog + disable + E2E
- Tạo/rotate secret ⇒ dialog hiện plaintext **một lần** (copy, cảnh báo), đóng là mất (không vào cache Query, không vào intent, không log); revoke version; disable/enable (gửi riêng).
- E2E (DEBT-281): fe-admin thật — tạo client, sửa `redirectUris` ⇒ step-up ⇒ quay lại ⇒ xác nhận ⇒ thành công; rotate secret ⇒ dialog một lần ⇒ reload không thấy lại; HTML/storage không chứa secret. Dọn client E2E (disable).
- **Acceptance**: E2E xanh 2 lần liên tiếp.

## Câu hỏi cho tech-lead
- Q-44.1: Cách gọn nhất cho DEBT-290 (swagger plugin vs decorator tay) và ảnh hưởng snapshot.
- Q-44.2: Phiên bản TanStack Form/Table (5.104 query đã có) pin ≥14 ngày.
- Q-44.3: Phạm vi L — tách Task 4 (secrets + E2E) sang run 45 nếu cần.

---

## Fold tech-lead (2026-10-22) — ƯU TIÊN HƠN text cũ ở trên

### Phạm vi chốt (Q-44.3)
- **Run 44 = Task 1 + Task 2 + Task 3 + Task 3E (E2E step-up, DEBT-281).** Task 4 (dialog secret rotate/revoke + disable/enable + E2E secret) **dời sang run 45 (A6.1b)**. Lý do: thật sự size L (thêm 5 endpoint vào client fe-admin, 2 luồng step-up, 2 E2E). Tách theo đúng 2 nghiệm thu của plan: run 44 lo "sửa redirect_uris đi qua step-up; lỗi validate theo field", run 45 lo "không hiện lại secret sau khi đóng".
- Task 1 vẫn làm schema response cho **cả secrets**: BE xong trong một lượt, run 45 không phải đụng `be/`.
- Phân công: Task 1 → backend-dev; Task 2, 3, 3E → frontend-dev. Task 1 ‖ Task 2; Task 3 cần Task 1 (snapshot) và Task 2; Task 3E sau Task 3.

### Sự thật từ code (đối chiếu `3999ef3`)
- `GET /admin/clients` chỉ nhận `limit` (1..100) và `after` (cursor = `clientId`). Sort cố định theo `clientId` tăng dần, **không có filter, không có sort** (`ClientService.listForTenant`). Vì vậy UI **không** làm sort/filter cột, và không lọc phía client trên một trang (dễ gây hiểu nhầm). Thiếu filter phía server ⇒ DEBT-300.
- Lỗi 400 có dạng `{error:"invalid_request", error_description:"<chuỗi>"}`. Lỗi domain trông như `redirect_uri must not contain a wildcard: <uri>`; lỗi DTO là các thông điệp class-validator nối bằng `; `. **Không có field có cấu trúc** ⇒ DEBT-301. fe-admin đã cắt description còn ≤200 ký tự.
- Mọi thao tác ghi (`POST /admin/clients`, mọi `PATCH`, `POST/DELETE …/secrets`) đều có `@RequireRecentAuth(5)`, nên **thao tác ghi nào** cũng có thể trả `403 step_up_required`, không riêng `redirectUris`. AT lấy bằng refresh grant **không có `auth_time`**, nên sau khi BFF refresh thì ghi luôn cần step-up.
- Wildcard trong redirect/post-logout/frontchannel/CORS **luôn bị BE từ chối**, ở mọi môi trường. `http://localhost` (hostname đúng là `localhost`) chỉ được chấp nhận ngoài production. CORS phải thoả `new URL(v).origin === v`.
- Field bất biến khi PATCH: `clientId`, `clientType`, `tokenEndpointAuthMethod`, `tenantId`; gửi lên ⇒ 400. `disabled: true` phải gửi một mình. Tự disable client đang phát token admin ⇒ 409.
- Client admin-capable: `allowedResources` chứa resource có `identifier === new URL('/admin/', issuer).href`. Hệ quả:
  - chỉ super_admin được cấp (403);
  - client phải là confidential (400);
  - **cấp quyền admin sẽ revoke mọi secret** (DEBT-137);
  - `assertMayModify`: tenant_admin không sửa/rotate/revoke được client admin-capable (403).
- `GET /admin/resources`: scope `admin.read`, phân trang `limit/after`, mọi admin đọc được.
- `client.ts` của fe-admin hiện chỉ có `listClients/getClient/updateClient`, `Method = "GET" | "PATCH"`.

### Task 1 [BE] — Q-44.1: viết decorator tay, KHÔNG bật swagger plugin
- Không dùng plugin, vì hai lý do:
  - plugin chỉ đọc class trong `*.dto.ts`/`*.entity.ts`, trong khi view hiện là `interface`;
  - plugin chỉ chạy qua `nest build`, còn int-test và E2E của BE chạy đường build khác ⇒ hai cách build sinh ra hai document khác nhau.
- Thêm class view chỉ phục vụ schema (ví dụ file `admin.views.ts`): `AdminClientViewDto implements AdminClientView`, `ClientPageViewDto {items, nextCursor: string|null}`, `AdminCredentialViewDto`, `CredentialListViewDto {items}`, `IssuedSecretViewDto {clientId, version, clientSecret}`, `AdminResourceViewDto` kèm page. Date ⇒ `type: String, format: 'date-time'`; field nullable ghi rõ `nullable: true` kèm `type`. Mapper giữ nguyên, không đổi hành vi runtime.
- Gắn `@ApiOkResponse`/`@ApiCreatedResponse({ type })` cho: clients list/get/create/update, secrets list/issue (thêm `@ApiNoContentResponse` cho revoke), resources list. Phần còn lại của admin API không bắt buộc.
- DEBT-294: `frontchannelLogoutUri` ⇒ `@ApiPropertyOptional({ type: String, nullable: true, maxLength })`.
- **Chống lệch**: unit test BE so tập key của `toAdminClient(sample)`/`toAdminCredential(sample)` với `properties` của schema tương ứng trong document (`adminOnly(SwaggerModule.createDocument(...))`). Thêm field vào mapper mà quên schema ⇒ RED.
- Verify:
  - test BE OpenAPI và unit xanh;
  - chạy `pnpm -C fe-admin fetch:api && gen:api`;
  - spec E2E `admin-openapi.spec.ts` xanh;
  - `ClientPatch` bỏ được `Omit`.
- Phía fe-admin: zod response **vẫn là allowlist**. Thêm kiểm compile-time rằng `z.infer<typeof AdminClientSchema>` khớp `components["schemas"]["AdminClientViewDto"]` (type-level equality, chỉ trên các field zod giữ lại), để lệch lộ ra ngay ở `typecheck`.

### Task 2 [FE] — giữ nguyên, bổ sung các điểm sau
- DEBT-297: ở nhánh 2xx của `read`, đặt `uncertain = op.method !== "GET"` cho **cả hai** trường hợp body không phải JSON **và** body sai schema. Hiện tại sai schema ném `Error` thường ⇒ 500, không có `uncertain`. Thông điệp và log chỉ chứa method + route, **không bao giờ** chứa body (ở run 45 body có thể chứa `clientSecret`). Test: POST/PATCH trả 2xx body rác ⇒ `uncertain`, và log không chứa chuỗi body.
- DEBT-296: test interleave một refresh thường đang chạy khi forced refresh vào ⇒ không trả AT cũ, không `dropSession`.
- DEBT-299: `saveIntent` gọi `clearIntent()` trước khi validate/ghi; đổi `it.fails` thành `it`.
- StrictMode: không đặt `takeIntent` (hàm đọc một lần) trong initializer của `useState`, vì StrictMode gọi initializer 2 lần nên lần 2 nhận `null`. Cách được duyệt: ghi nhớ kết quả ngoài render (`useRef` + đọc một lần trong `useEffect`), hoặc đọc trong `beforeLoad`/loader phía client. Test render trong `<StrictMode>` vẫn khôi phục được draft.

### Task 3 [FE] — Danh sách + chi tiết client + form tạo/sửa
**Bảng và phụ thuộc**
- **Không cài `@tanstack/react-table` ở run này**, vì API không có sort/filter và một trang chỉ ≤100 dòng. Dùng `<table>` ngữ nghĩa (`<caption>`, `<th scope="col">`). Ghi DEBT-303.
- Phân trang: "Trang sau" là `?after=<nextCursor>` trong search params (validate bằng zod như `ListClientsInput`), có nút "Về đầu", không bịa tổng số. Tuỳ chọn rẻ: ô "Mở theo client ID" điều hướng tới `/clients/$clientId` (dùng `ClientIdSchema`).
- **`@tanstack/react-form` = `1.33.5` (exact)**, phát hành 2026-08-11 (72 ngày):
  - `@tanstack/form-core` 1.33.5 (exact);
  - `@tanstack/react-store`/`store` ^0.11 ⇒ 0.11.2 (2026-09-29, đã có trong lock);
  - `@tanstack/devtools-event-client` ^0.4.1 ⇒ 0.4.4 (2026-06-19).

  Không dùng 2.0.0-alpha. Zod 4 dùng trực tiếp qua Standard Schema, **không** cài `@tanstack/zod-form-adapter`. Không cần override mới.

**Server fn mới** (cùng khuôn A5: mỗi fn một endpoint cố định, input zod, mở rộng `Method` thêm `"POST"`)
- `createClient` (POST `/admin/clients`): body zod `.strict()` theo `CreateClientDto`, gồm `clientType`, `tokenEndpointAuthMethod`, các mảng và `frontchannelLogoutUri`.
- `listResources` (GET `/admin/resources`, `limit`=100): response zod allowlist `{resourceId, identifier, scopes}`, cộng cờ `adminCapable` **tính trong server fn** từ `OIDC_ISSUER`. Không trả issuer ra client.
- Hook `useCreateClient` invalidate `clients.all` khi thành công hoặc khi `uncertain`.

**URL editor** (zod mirror luật BE, không chặt hơn BE)
- Lỗi chặn, báo theo từng dòng:
  - giá trị rỗng;
  - có `*`;
  - `new URL` lỗi (không phải absolute);
  - có fragment;
  - host chứa `;`, `,` hoặc khoảng trắng;
  - scheme khác `https:`/`http:` (chặn `javascript:`, `data:`, `vbscript:`, `file:`…);
  - `http:` với hostname khác `localhost` (kể cả `127.0.0.1`);
  - trùng lặp trong cùng danh sách;
  - quá 20 mục, hoặc quá 2048 ký tự.
- Cảnh báo, không chặn: `http://localhost` ("chỉ được chấp nhận ngoài production — BE quyết định").
- CORS: thêm luật `new URL(v).origin === v` (không path, không slash cuối). `frontchannelLogoutUri` dùng luật redirect.
- Wildcard là **lỗi**, không chỉ là cảnh báo, vì BE luôn từ chối.
- URI đã lưu (ở list/detail) **chỉ hiển thị dạng text**, không bao giờ là `<a href>`: dữ liệu cũ có thể chứa scheme lạ.

**Field và body**
- `clientType`/method: khi tạo mới chỉ cho chọn cặp hợp lệ (`public` ⇒ `none`; `confidential` ⇒ `client_secret_basic` | `client_secret_post`). Đổi type thì reset method.
- Khi sửa: `clientId`, `clientType`, `tokenEndpointAuthMethod` hiển thị dạng **text read-only**, không nằm trong state form và không bao giờ có trong body PATCH. `ClientPatchSchema.strict()` đã chặn; thêm test cho việc này.
- PATCH chỉ gửi **field đã đổi** so với dữ liệu server mới nhất (mảng so nguyên khối); không đổi gì thì không gửi. **Form sửa không bao giờ gửi `disabled`**: disable/enable là thao tác riêng, làm ở run 45.
- `allowedResources`: chọn từ `listResources`. Resource `adminCapable` gắn nhãn "Cấp quyền admin API — chỉ super_admin; client phải confidential; lưu sẽ thu hồi mọi secret hiện có". Nhãn chỉ để hiển thị: viewer không phải super_admin thì thấy cảnh báo, không ẩn lựa chọn. BE là nguồn sự thật; gặp 403 thì hiện thông điệp `forbidden` cố định.

**Lỗi và step-up**
- Lỗi theo field lấy từ zod phía client: `aria-invalid`, `aria-describedby` trỏ đúng dòng lỗi, khi submit thì focus vào field lỗi đầu tiên.
- Lỗi BE 400/409 hiện thành **thông báo cấp form** (`role="alert"`): description đã cắt, render dạng text. Không parse chuỗi của BE để đoán field (DEBT-301).
- **Step-up**: create/update gặp `step_up_required` ⇒ gọi `startStepUp`:
  - action `client.create` (path `/clients/new`) hoặc `client.update` (path `/clients/$clientId`);
  - payload = giá trị form đã qua schema form (allowlist);
  - khi quay lại: khôi phục draft, hiện banner "Kiểm tra rồi gửi lại", **không tự gửi**;
  - với update: tính lại diff so với dữ liệu server vừa tải.
- Nút submit disabled khi đang pending (create không idempotent — DEBT-293).
- `uncertain` ở create ⇒ báo "Có thể đã tạo — kiểm tra danh sách", không tự retry. `uncertain` ở update ⇒ invalidate và tải lại detail.

**Acceptance**
- Component test bảng: trang sau, về đầu, trạng thái rỗng, trạng thái lỗi.
- Component test form:
  - mọi case URL ở trên, viết dạng bảng test dùng chung;
  - cặp type/method;
  - field bất biến không vào body; chỉ gửi field đã đổi;
  - 400/403/409/`uncertain`;
  - step-up save/restore không tự gửi;
  - chạy dưới StrictMode.
- A11y: label, `aria-invalid`, mô tả lỗi.
- Mutation RED: bỏ check wildcard, bỏ check `javascript:`, hoặc để field bất biến lọt vào body ⇒ test đỏ.

### [x] Task 3E [FE/E2E] — DEBT-281 (thay phần E2E step-up của Task 4)
- Luồng trên fe-admin thật:
  1. đăng nhập, tạo client bằng form;
  2. sửa `redirectUris` ⇒ gặp `403 step_up_required` ⇒ IdP `prompt=login&max_age=0`;
  3. quay lại đúng trang: draft được khôi phục, chưa gửi;
  4. bấm lưu ⇒ thành công, detail hiện URI mới.

  Dọn dẹp: disable client E2E qua admin API (helper `e2e/tests/support/admin.ts`).
- Kích `step_up_required` **không thêm nhánh test nào vào code production**. Cách được duyệt:
  - đặt `ACCESS_TOKEN_TTL` của E2E nhỏ (ví dụ 120 ⇒ BFF refresh sau khoảng 60 s do `REFRESH_SKEW_MS`; AT từ refresh grant không có `auth_time` ⇒ cần step-up), **chỉ khi** toàn bộ E2E xanh 2 lần liên tiếp với giá trị đó;
  - nếu không đạt, viết test riêng chờ hơn 5 phút (`test.slow()`).

  Ghi lựa chọn vào log.
- Kiểm âm: sau khi quay lại, `sessionStorage` không còn `fea:stepup`; Web Storage không có token.
- **Acceptance**: E2E xanh 2 lần liên tiếp; toàn bộ suite không đỏ.

### Run 45 (A6.1b) — ghi trước cho analyst, KHÔNG làm ở run 44
- Secrets: `listSecrets`; `issueSecret` (POST, đặt `cache-control: no-store` trên response của serverFn này); `revokeSecret` (DELETE, version khớp `^[1-9][0-9]{0,8}$`). Chỉ áp dụng cho client confidential.
- Plaintext chỉ nằm trong `useState` của dialog:
  - **không** để `useMutation` giữ `data` (hoặc dùng `gcTime: 0` + `reset()` ngay);
  - không vào Query cache/devtools, intent, URL, Web Storage, toast, `console`, log server hay HTML SSR;
  - hiển thị dạng text, không qua thuộc tính `value`;
  - đóng dialog hoặc unmount ⇒ xoá state.
- Step-up cho rotate/revoke/disable: intent chỉ có action, không có payload; quay lại phải bấm lại.
- `uncertain` ở rotate ⇒ báo "Có thể đã tạo version mới mà không hiển thị được secret — xem danh sách version, revoke version lạ rồi rotate lại". Bản cũ còn trong hạn grace nên không gián đoạn.
- Disable: PATCH `{disabled:true}` gửi một mình, dialog xác nhận nói rõ "thu hồi mọi refresh token của client". 409 do tự khoá ⇒ thông điệp riêng.
- E2E: rotate ⇒ dialog hiện một lần ⇒ đóng hoặc reload thì không thấy lại; HTML và storage không chứa secret.
