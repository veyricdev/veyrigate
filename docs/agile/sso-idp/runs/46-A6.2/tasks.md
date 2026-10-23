# Tasks — run 46 — A6.2: Resources UI (M5, lane ADMIN) + DEBT-318/319

> Plan §6 A6.2: "Resources: bảng + form (`identifier` absolute URI, scopes)" — nghiệm thu "Validate `identifier` phía FE trùng quy tắc BE". BE có sẵn `be/src/modules/admin/admin-resources.controller.ts` (GET list, GET `:resourceId`, POST, PATCH — không DELETE); OpenAPI snapshot `fe-admin/openapi/admin.json` đã có `/admin/resources*`. Tái dùng khuôn A6.1 (`/clients`): cursor list, detail, form `@tanstack/react-form` + zod mirror BE, field bất biến read-only, PATCH chỉ field đổi so với mốc đóng băng, step-up nếu BE yêu cầu, error union / uncertain.
>
> Thứ tự: Task 1 → 2 → 3 → 4 (frontend-dev). KHÔNG sửa be/ trừ khi tech-lead chỉ ra thiếu schema OpenAPI (khi đó Task 0 [BE]). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: DEBT-318 + DEBT-319 (nợ run 45)
- DEBT-318: `useInvalidateClients` invalidate cả khi lỗi ném không phải `AdminRequestError`; đổi 2 test characterisation của tester thành "was re-read".
- DEBT-319: focus không rơi về `body` sau Disable/Enable thành công/uncertain; vùng `role="status"` luôn render để screen reader đọc.
- **Acceptance**: test RED trước fix (mutation), xanh sau.

### [x] Task 2 [FE]: Resources server fns + types
- `listResources` (cursor), `getResource`, `createResource`, `updateResource` qua admin API client server-only (endpoint cố định, zod allowlist response, error union, không log body).
- **Acceptance**: unit server fn (map lỗi 400/403/404/409/step_up, uncertain cho 2xx body sai), `gen:api` không diff.

### [x] Task 3 [FE]: Routes `/resources`, `/resources/new`, `/resources/$resourceId`
- Bảng cursor `?after=`; form: `identifier` absolute URI theo đúng quy tắc BE (đọc validator/DTO BE, mirror — scheme, fragment, wildcard…), scopes (định dạng token theo BE, trùng lặp), field bất biến (identifier sau tạo nếu BE cấm sửa) read-only; PATCH chỉ field đổi; refetch không ghi đè thay đổi chưa lưu (bài học run 44); remount theo `resourceId` (bài học DEBT-308); nav link trong layout.
- **Acceptance**: component test (validate mirror BE từng quy tắc, PATCH diff, step-up round-trip nếu áp dụng, a11y form lỗi), mutation RED.

### [x] Task 4 [E2E]: Resources
- E2E: tạo resource qua UI ⇒ thấy trong danh sách ⇒ sửa scopes ⇒ BE phản ánh (API) ⇒ identifier sai bị chặn ở FE; dọn dẹp (resource không xoá được — dùng identifier duy nhất theo run, ghi chú).
- **Acceptance**: full E2E xanh 2 lần liên tiếp.

## Câu hỏi cho tech-lead
- Q-46.1: Quy tắc BE chính xác cho `identifier` và scopes; field nào bất biến; PATCH có cần step-up không.
- Q-46.2: Resource không DELETE ⇒ E2E dọn dẹp thế nào (DB `sso-idp-e2e` reset giữa run?).
- Q-46.3: Phạm vi vừa 1 run không.

---

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

### Phạm vi và thứ tự (Q-46.3)
- **Vừa 1 run** nếu thêm **Task 0 [BE]**. Task 0 rất nhỏ: chỉ thêm decorator.
- Phân công: Task 0 → backend-dev; Task 1 → 4 → frontend-dev.
- Thứ tự: Task 0 ‖ Task 1 → Task 2 (cần snapshot từ Task 0) → Task 3 → Task 4.
- Ngoài phạm vi:
  - DEBT-320;
  - xoá hoặc archive resource (BE không có DELETE);
  - nhãn `adminCapable` trên trang resources.

### Sự thật từ code (đối chiếu `7f92122`)
- **Quyền theo route** (`AdminResourcesController`):
  - `GET /admin/resources` và `GET /admin/resources/:resourceId`: cần `admin.read`. Mọi admin đều đọc được.
  - `POST` và `PATCH`: cần `admin.write` + `@RequireRecentAuth(5)`, rồi `assertSuperAdmin` **trong handler**.
- **Resource là global**, không có `tenantId`, nên không có kiểm tenant, IDOR hay owner. Ghi một resource ảnh hưởng mọi tenant, vì vậy chỉ super_admin được ghi.
- **Thứ tự guard**: `AdminTokenGuard` (controller) → `StepUpGuard` (method) → `assertSuperAdmin` (handler).
  - Hệ quả: tenant_admin có `auth_time` cũ bị đòi step-up **trước**, đăng nhập lại xong mới nhận 403 (DEBT-325).
- **Không có DELETE.** `resourceId` và `identifier` bất biến (Q-27.4). PATCH chỉ đổi `scopes`.
- **Danh sách**:
  - sort theo `identifier` tăng dần;
  - `after` = `identifier` của dòng cuối (`toPage(..., r => r.identifier)`);
  - `limit` 1..100, mặc định 20.
- **`CreateResourceDto`**:
  - `resourceId` bắt buộc, khớp `^[a-z0-9][a-z0-9._-]{0,63}$`;
  - `identifier` là string, ≤2048;
  - `scopes` tuỳ chọn: mảng ≤50 phần tử, mỗi phần tử ≤256 và khớp `^\S+$`.
- **`validateResourceFormat`** (chạy sau DTO) chỉ kiểm hai điều: `new URL(v)` không ném lỗi, và `parsed.hash === ""`.
  - BE **không** chặn scheme lạ: `urn:x`, `mailto:a@b`, kể cả `javascript:alert(1)` đều qua.
  - Không chặn wildcard, không trim.
  - `https://a/#` vẫn qua, vì fragment rỗng cho `hash === ""`.
- **`UpdateResourceDto`**:
  - `scopes` **bắt buộc**, thay nguyên mảng, cùng luật phần tử như khi tạo; `[]` hợp lệ;
  - field lạ (kể cả `identifier`/`resourceId`) ⇒ 400 (whitelist + forbidNonWhitelisted như clients);
  - BE **không** chặn scope trùng lặp.
- **Lỗi BE**:

  | Mã | Khi nào |
  |---|---|
  | 400 `invalid_request` | Thông điệp class-validator, hoặc `resource must be an absolute URI: <v>` / `resource must not contain a fragment: <v>` |
  | 409 `conflict` `"Resource already exists"` | Trùng `resourceId` (pre-check, chấp nhận race) hoặc trùng `identifier` (unique index) |
  | 403 `forbidden` | Không phải super_admin |
  | 404 `not_found` | Id không tồn tại |

- **`Resource.scopes` hiện KHÔNG được dùng khi cấp token**: `/authorize` `validateScope` chỉ so với `Client.scopes`.
  - Vì vậy sửa scopes của resource, kể cả resource `admin`, không thể khoá console. Coi đây là tài liệu (DEBT-321).
  - UI hiện một dòng mô tả trung tính: "Scopes this resource defines (informational: token scopes are bounded by each client's scopes)."
- **OpenAPI snapshot**: chỉ `GET /admin/resources` có schema response. `GET :resourceId`, `POST` (201) và `PATCH` (200) **chưa có**, nên cần Task 0.
- **fe-admin hiện có**:
  - server fn `listResources` (trang đầu, `limit=100`, kèm cờ `adminCapable`) và `useResources` (key `["admin","resources"]`), đang phục vụ ô chọn `allowedResources` của form client. Không được làm hỏng chúng;
  - viewer có `roles` (`features/auth/viewer-types.ts`, root route context).
- **E2E không reset DB**: webServer chạy `db:sync-indexes && db:seed-dev && seed:e2e-admin` trên `sso-idp-e2e`, không drop. Seed resource có identifier `http://localhost…`.

### Q-46.1 — Quy tắc chính xác (FE mirror)

**`identifier`**
- Đặt trong `features/resources/resource-form-schema.ts`, hàm thuần `identifierProblem(v): string | null`.
- Lỗi chặn, kiểm theo thứ tự:
  1. rỗng;
  2. dài quá 2048;
  3. `v !== v.trim()` ⇒ "Remove leading/trailing spaces". Luật này **chặt hơn BE** và là ngoại lệ duy nhất được duyệt: `new URL` bỏ khoảng trắng nhưng BE lưu nguyên chuỗi, khi đó `aud` không bao giờ khớp (DEBT-324);
  4. `new URL(v)` ném lỗi ⇒ "Must be an absolute URI";
  5. `new URL(v).hash !== ""` ⇒ "Must not contain a fragment".
- Không thêm luật nào khác: không chặn scheme, `*` hay `http:`.
- Test dạng bảng dùng chung, phải có cả hai nhóm:
  - **qua**: `https://api.example.com/`, `urn:example:api`, `https://a/#` (giống BE), `http://localhost:4100/`;
  - **chặn**: `""`, `" https://a/"`, `"https://a/ "`, `api.example.com`, `/relative`, `https://a/#x`, chuỗi 2049 ký tự.

**`resourceId`** (chỉ khi tạo)
- Khớp `^[a-z0-9][a-z0-9._-]{0,63}$`, đúng regex BE.
- Hằng số đặt cạnh schema, có comment trỏ `be/src/modules/admin/admin.dto.ts`.

**`scopes`**
- Textarea, tách bằng `/\s+/` (khoảng trắng hoặc xuống dòng), nên mỗi token tự động khớp `^\S+$`.
- Giới hạn **≤50** token, mỗi token **≤256**. Đây là luật của resource, **khác** client (20/2048): **không** dùng lại `scopeTokens` của client với hằng số cũ. Tham số hoá hoặc viết riêng.
- Trùng lặp ⇒ lỗi chặn (`"x" is listed twice`). Chặt hơn BE nhưng vô hại: scopes mang ngữ nghĩa tập hợp, và khớp form client.
- Danh sách rỗng hợp lệ, cả khi tạo lẫn khi sửa.

**Field bất biến**
- Sau khi tạo, `resourceId` và `identifier` chỉ hiển thị dạng **text** (không `<input>`), không nằm trong state form, không bao giờ có trong body PATCH.
- `UpdateResourceInput = z.object({ resourceId: ResourcePathIdSchema, patch: z.object({ scopes: z.array(z.string().max(256)).max(50) }).strict() })`.
- Test: body PATCH chỉ có key `scopes`.

**Step-up**
- **Có**, cho cả POST và PATCH (`RequireRecentAuth(5)`). AT lấy bằng refresh grant không có `auth_time`, nên sau khi BFF refresh, mọi thao tác ghi đều cần step-up.
- Dùng lại `startStepUp`/`useStepUpDraft`:
  - `resource.create`: path `/resources/new`, payload `{resourceId, identifier, scopes}` dạng text đã qua draft schema;
  - `resource.update`: path `/resources/$resourceId`, payload `{scopes}`.
- Khi quay lại: khôi phục draft, hiện banner, **không tự gửi**. Với update, diff tính lại so với dữ liệu server lúc mount.

**Quyền trên UI**
- Chỉ khi `viewer.roles.includes("super_admin")` mới render:
  - nút "New resource";
  - nội dung `/resources/new` (người khác thấy "Only a super_admin can create resources." và không có lời gọi BE);
  - form sửa scopes (người khác thấy scopes dạng text).
- Đây chỉ là UX, BE vẫn là nơi thực thi. Mục đích: tránh bắt step-up vô ích rồi nhận 403 (DEBT-325).
- Nếu BE vẫn trả 403 ⇒ hiện thông điệp `forbidden` cố định.

### [x] F0 — Task 0 [BE] (backend-dev): schema response OpenAPI cho resources
- Sửa `be/src/modules/admin/admin-resources.controller.ts`:
  - `@ApiOkResponse({ type: AdminResourceViewDto })` cho `get` và `update`;
  - `@ApiCreatedResponse({ type: AdminResourceViewDto })` cho `create`.

  `AdminResourceViewDto` đã có trong `admin.views.ts`. Không đổi hành vi runtime, không đổi DTO request.
- Test BE (`admin.spec.ts`, cạnh test `keys('AdminResourceViewDto')`): ba operation `AdminResourcesController_get/_create/_update` có `$ref` `AdminResourceViewDto` ở response 200/201/200.
- Verify:
  - unit BE + lint + typecheck BE xanh;
  - `pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api`. Lệnh này cần BE dev đang chạy và **không** được dừng process có sẵn. Nếu không có BE dev: ghi log, frontend-dev chạy ở Task 2;
  - `git diff fe-admin/openapi/admin.json` chỉ thêm 3 response schema.
- Phía fe-admin (Task 2): `test/admin-schema-types.test.ts` thêm kiểm type-level cho response của 3 operation (`operations["AdminResourcesController_get"]["responses"][200]…` khớp `AdminResource`).

### F1 — Task 1 [FE]: DEBT-318 + DEBT-319 (bổ sung)

**DEBT-318**
- Tách helper `useInvalidateOn(queryKey)` trong `features/admin-api/hooks.ts`, điều kiện `!error || !(error instanceof AdminRequestError) || error.uncertain`. Dùng cho clients (đã có) **và** resources (Task 2).
- Trong `test/client-secrets-risk.test.tsx`, đổi 2 characterisation ("DEBT-318 characterisation…", "revoke throws…") thành khẳng định detail/list/secrets **đã được đọc lại**.
- Mutation RED: đổi điều kiện về như cũ ⇒ 2 test đỏ.

**DEBT-319** (`features/clients/client-status.tsx` + panel Secrets sau Revoke)
- `<p role="status">` **luôn render**, rỗng khi chưa có notice. Bỏ render có điều kiện.
- Sau `onDone`: focus `h2` của section (`tabIndex={-1}`, `ref`), làm trong `requestAnimationFrame`/`useEffect` theo notice. Không `autoFocus` trigger mới.
- Test:
  - sau Disable thành công và sau uncertain, `document.activeElement` là heading "Status" (không phải `body`);
  - vùng `role="status"` tồn tại **trước** khi bấm, và chứa notice sau khi bấm;
  - Revoke secret: kiểm tương tự.
- Mutation RED: bỏ lệnh focus ⇒ đỏ; đổi lại thành render có điều kiện ⇒ đỏ.
- Áp cùng khuôn (status luôn có + focus heading) cho thông báo kết quả trên trang resource.

### F2 — Task 2 [FE]: server fns + types (thay text cũ)

**Giữ hành vi cũ, đổi key**
- **Giữ** `listResources`/`useResources` (options của form client), chỉ đổi key sang `adminKeys.resources.options`.
- Key mới:

  ```
  resources: { all: ["admin","resources"], options: ["admin","resources","options"],
               list: (p) => ["admin","resources","list",p], detail: (id) => ["admin","resources","detail",id] }
  ```

- Mọi lần ghi resource (thành công, uncertain, hoặc throw lạ) ⇒ invalidate `resources.all`. Nhờ đó ô chọn của form client cũng được làm mới.

**`client.ts`: thêm 4 method**
- `listResourcePage(ctx, {limit?, after?})`: GET, dựng query bằng `URLSearchParams`, schema `ResourcePageSchema`. Method cũ `listResources(ctx)` bỏ đi, hoặc giữ và gọi `listResourcePage(ctx, {limit:100})`.
- `getResource(ctx, id)`.
- `createResource(ctx, body)`: POST.
- `updateResource(ctx, id, patch)`: PATCH.
- Route trong log: `/admin/resources`, `/admin/resources/:resourceId`. Path: `/admin/resources/${encodeURIComponent(id)}`.

**Server fn và hook**
- Server fn mới đặt trong `features/admin-api/resources.ts`:
  - `listResourcePage`: input `ListClientsInput`, đổi tên chung thành `PageInput` và giữ alias;
  - `getResource`, `createResource`;
  - `updateResource`: server fn POST, gọi BE PATCH.
- Hook đặt trong `hooks.ts`: `useResourcePage`, `useResource`, `useCreateResource`, `useUpdateResource`.

**`inputs.ts`**
- `ResourcePathIdSchema`: cùng luật với `ClientIdSchema` (1..128 ký tự, không `/` `\`, không phải `.`/`..`). **Không** dùng regex tạo mới cho path, để resource cũ/seed ngoài regex vẫn mở được.
- `CreateResourceInput = z.object({ resourceId: z.string().regex(RESOURCE_ID), identifier: z.string().min(1).max(2048), scopes: z.array(z.string().min(1).max(256).regex(/^\S+$/)).max(50) }).strict()`.
- `UpdateResourceInput`: như Q-46.1.

**Acceptance (unit, đo được)**
- 400 / 403 `forbidden` / 403 `step_up_required` / 404 / 409 ⇒ trả đúng code.
- POST/PATCH gặp 2xx sai schema, timeout hoặc 5xx ⇒ `uncertain`. GET 5xx ⇒ không `uncertain`.
- Path `../x`, `a/b`, `""` ⇒ input validator từ chối, `fetch` không được gọi.
- Body PATCH đúng `{scopes:[…]}`. Có `identifier`/`resourceId` trong patch ⇒ input từ chối (strict).
- `after` được encode trong query.
- `gen:api` không diff (sau Task 0).

### F3 — Task 3 [FE]: routes và form (bổ sung)

**Route và điều hướng**
- `routes/resources/index.tsx`, `new.tsx`, `$resourceId.tsx`.
- Thêm `{ to: "/resources", label: "Resources" }` vào `components/layout/app-sidebar.tsx`.

**Bảng**
- `<table>` ngữ nghĩa: `<caption>`, `<th scope="col">` cho Resource ID, Identifier, Scopes.
- "Trang sau" = `?after=<nextCursor>` (search params validate bằng zod như clients); có "Về đầu"; không bịa tổng số.
- `identifier` luôn là **text** (`<code>`/`<span>`), **không bao giờ** là `<a href>`, vì BE nhận cả `javascript:`. Link tới detail đi theo `resourceId`.

**Detail**
- Toàn bộ thân trang (facts + form) bọc `<Fragment key={resourceId}>` (bài học DEBT-308).
- Form đóng băng `base` lúc mount: refetch không ghi đè thay đổi chưa lưu (bài học run 44).
- `not_found` ⇒ "This resource does not exist."

**Gửi form**
- Submit disabled khi đang pending.
- Chỉ PATCH khi scopes **khác** base. So mảng theo thứ tự (`JSON.stringify` của danh sách token). Không đổi gì ⇒ hiện "No changes to save.", không gửi request.
- `uncertain`:
  - create: "It may have been created — check the list before trying again (a retry that answers 'already exists' means it was)." Không tự retry;
  - update: invalidate, rồi báo người dùng kiểm tra.
- 400/409 ⇒ thông điệp cấp form (`role="alert"`, text đã cắt từ BE). Không parse chuỗi lỗi để đoán field (DEBT-301).
- Tạo thành công ⇒ điều hướng tới `/resources/$resourceId`.

**A11y**
- Có label; `aria-invalid` + `aria-describedby` trỏ tới dòng lỗi; khi submit thì focus field lỗi đầu tiên.
- Kết quả hiện qua vùng `role="status"`/`alert` luôn render (F1).

**Acceptance (component)**
- Bảng: trang sau, về đầu, rỗng, lỗi.
- Identifier `javascript:alert(1)` hiển thị dạng text; DOM **không có** `a[href^="javascript"]`.
- Bảng luật identifier/resourceId/scopes (Q-46.1), gồm biên 50/51 token và 256/257 ký tự.
- Field bất biến không vào body; không đổi gì ⇒ không có request.
- 400/403/409/`uncertain`.
- Step-up create và update: save/restore, không tự gửi, chạy trong `<StrictMode>`.
- Viewer tenant_admin không thấy nút New hay form sửa; `/resources/new` không gọi `createResource`.
- Remount khi đổi `resourceId`: draft của A không sang B.

**Mutation RED** (sao lưu + khôi phục như run 45). Mỗi thay đổi dưới đây phải làm test đỏ:
- bỏ check fragment;
- bỏ check trim;
- để `identifier` lọt vào patch;
- render identifier bằng `<a href>`;
- đổi max scopes 50 → 20.

### F4 — Task 4 [E2E] (Q-46.2, thay text cũ)

**Dữ liệu test**
- DB E2E **không** reset, cấm drop/FLUSH. Resource không xoá được, nên mỗi lần chạy tạo **một** resource mới, duy nhất:
  - `resourceId = e2e-r<inv>`;
  - `identifier = https://e2e-r<inv>.resources.test/api`;
  - `inv = String(9_999_999_999_999 - Date.now()).padStart(13, "0")`.
- Lần chạy mới nhất có identifier nhỏ nhất trong nhóm `https://e2e-r…`, nên luôn ở trang 1. Seed `http://…` rất ít và luôn sort trước `https://`.
- Không dọn được: chấp nhận tích luỹ 1 resource mỗi lần chạy (DEBT-322). Ghi chú điều này ở comment đầu spec.

**Cách chạy**
- File `e2e/tests/fe-admin-resources.spec.ts`, đăng nhập bằng `signInAsAdmin` (`tests/support/fe-admin.ts`). Một test, `test.setTimeout` ≤ 120 s.
- Mọi thao tác ghi phải xong trong khoảng ≤50 s sau đăng nhập: `ACCESS_TOKEN_TTL=120` khiến BFF refresh sau khoảng 60 s, khi đó cần step-up. **Không** E2E step-up (run 44 đã có).

**Các bước**
1. Ở `/resources/new`, nhập identifier `https://e2e-r<inv>.resources.test/api#frag`, bấm lưu ⇒ thấy lỗi field.
   - Không có request tới server fn create: đếm `page.on("request")` theo URL `_serverFn` có tên fn, hoặc dùng `waitForRequest` với timeout ngắn và kỳ vọng hết hạn.
   - Admin API `GET /admin/resources/e2e-r<inv>` ⇒ 404.
2. Sửa thành identifier hợp lệ, scopes `e2e.read e2e.write`, lưu ⇒ chuyển tới trang detail.
3. Ở `/resources`, thấy dòng có `resourceId` đó ngay trang 1.
4. Sửa scopes thành `e2e.read e2e.admin`, lưu. Kiểm qua admin API (`adminToken` trong `support/admin.ts`): `GET /admin/resources/e2e-r<inv>` có `scopes` = `["e2e.read","e2e.admin"]`, `identifier` không đổi.

**Acceptance**
- Full E2E xanh **2 lần liên tiếp**, spec mới xanh cả hai lần.
- Lần chạy thứ 2 tạo resource khác, chứng minh tên duy nhất.

### Cổng security (đã kiểm)
- **Tài sản và trust boundary**:
  - tài sản: collection `resources` global (`identifier` = `aud` của access token);
  - actor: super_admin ghi, tenant_admin đọc, người ẩn danh không có quyền;
  - boundary: trình duyệt → server fn (input zod) → BFF → admin API. Admin API là nơi thực thi scope, step-up và super_admin.
- **Invariant**:
  - `resourceId`/`identifier` không bao giờ đổi qua UI (input strict + test);
  - PATCH chỉ chứa `scopes`;
  - chỉ ghi khi admin bấm, không auto-submit sau step-up.
- **Abuse case**:
  - path traversal ở `resourceId`: chặn bằng input validator;
  - XSS qua `identifier` có scheme lạ: chỉ render text, có test;
  - confused deputy từ tenant_admin: BE trả 403, UI ẩn;
  - double submit: disabled khi pending;
  - replay create: 409; `uncertain` không tự retry;
  - lost update giữa 2 super_admin: last-write-wins, chấp nhận (DEBT-323);
  - IDOR/cross-tenant: không áp dụng (global; mọi admin đọc được là chủ đích).
- **Failure semantics**:
  - POST/PATCH timeout, 5xx hoặc 2xx sai schema ⇒ `uncertain` + invalidate, không gửi lại;
  - GET lỗi ⇒ nút "Try again";
  - BE down ⇒ `unavailable`; không fail-open.
- **Exposure**: không log body; cursor `?after=` là identifier, không nhạy cảm; thông điệp lỗi BE cắt còn ≤200 ký tự và render dạng text.
