# Tasks — run 48 — A6.4: Audit log (M5, lane ADMIN) + DEBT-339/340/341

> Plan §6 A6.4: "bảng lọc theo action/user/client/thời gian, phân trang server, làm nổi `TOKEN_REUSE_DETECTED`; xem chi tiết metadata (đã redact)" — nghiệm thu "Không hiển thị dữ liệu nhạy cảm; export CSV (tuỳ chọn)". BE: `be/src/modules/admin/admin-audit.controller.ts` (GET `admin/audit`, `AuditQueryDto`, `toPage`). Tái dùng khuôn A6.1–A6.3 (cursor, zod allowlist, helper `components/feedback/`, filter có PII như email/IP không vào URL — xem quy tắc `listUsers` POST run 47).
>
> Thứ tự: Task 0 [BE] (nếu snapshot thiếu response schema) ‖ Task 1 → 2 → 3 → 4 (frontend-dev). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 0 [BE]: OpenAPI response audit (`AdminAuditEventViewDto`/`AuditPageViewDto`) + `tenantId` cho `TOKEN_REUSE_DETECTED` (xem F0).

### [x] Task 1 [FE]: nợ run 47 — DEBT-339 (family revoke uncertain mất thông điệp ⇒ khuôn lock: đóng dialog + announce + focus heading), DEBT-340 (E2E cleanup lấy token mới trong `finally`), DEBT-341 (ponytail -8 dòng).

### [x] Task 2 [FE]: Audit server fn + schema — list có filter (action, userId, clientId, from/to theo `AuditQueryDto`), cursor; zod allowlist response; metadata hiển thị đã redact (không render HTML, không link), không lộ token/secret/hash nếu BE lỡ trả.

### [x] Task 3 [FE]: `/audit` — bảng + bộ lọc + phân trang server, làm nổi `TOKEN_REUSE_DETECTED` (và sự kiện bảo mật khác theo tech-lead), chi tiết metadata (dialog hoặc expand), thời gian ISO; link sang `/users/$id`, `/clients/$id` khi có id hợp lệ.

### [x] Task 4 [E2E]: thao tác admin sinh audit (vd. lock/unlock user E2E) ⇒ thấy bản ghi trong `/audit` theo filter; không lộ secret/email trong URL.

## Câu hỏi cho tech-lead
- Q-48.1: Filter nào chứa PII (userId? IP? email?) ⇒ có cần POST server fn như `listUsers` không; filter nào được phép vào search params.
- Q-48.2: Quy tắc redact metadata phía BE đã đủ chưa (INV-20); FE có cần allowlist key metadata hay chỉ render text an toàn.
- Q-48.3: Export CSV có làm không (tuỳ chọn) — đề xuất bỏ khỏi run này.
- Q-48.4: Tenant scope của audit (DEBT-140 audit OAuth chưa gắn tenant) ảnh hưởng gì cho tenant_admin.

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `2e171cc` (CodeGraph + đọc trực tiếp): BE `admin-audit.controller.ts`, `admin-audit.ts`, `admin.dto.ts` (`AuditQueryDto`, `toPage`), `admin.mappers.ts` (`toAdminAuditEvent`), `admin.views.ts`, `security/audit/{audit.service,audit.types,audit-action.enum}.ts`, `refresh-token.service.ts` (`issueForRefresh`/`rotate`/`classifyMiss`/`revokeFamily`), `token.controller.ts`, `authentication.service.ts`, `sessions/session.service.ts`, `common/logger/logger.module.ts`; `fe-admin/openapi/admin.json`; FE `server/admin-api/{client,schemas}.ts`, `features/admin-api/{inputs,keys,hooks,users}.ts`, `features/users/user-grants.tsx`, `components/feedback/confirm-action.tsx`, `routes/users/index.tsx`; E2E `e2e/tests/fe-admin-users.spec.ts`, `support/admin.ts`.

### Trả lời câu hỏi
- **Q-48.1 — Không filter nào chứa PII theo thiết kế BE ⇒ search params + server fn GET, KHÔNG cần POST.**
  - `AuditQueryDto` chỉ có: `action` (enum); `actorId`/`targetId`/`clientId` (chuỗi ≤128, so khớp exact); `targetType` (≤64); `result` (enum); `from`/`to` (ISO); `limit`; `after`. Không có filter email hay IP.
  - Rủi ro duy nhất: ô nhập tự do cho phép admin dán email vào `actorId`/`targetId` ⇒ email vào URL/`returnTo`. Chặn bằng `AuditIdSchema` `^[A-Za-z0-9._:-]{1,128}$` (không `@`, không khoảng trắng) ở cả `validateSearch` lẫn input server fn (F2/F3).
  - Mọi filter + `after` nằm trong search params (bookmark được, link được từ chi tiết user).
- **Q-48.2 — BE redact đủ cho secret (INV-20); FE vẫn lọc phòng thủ, và lọc ở phía server.**
  - BE: `AuditService.record` chạy `sanitizeMetadata` (bỏ key giống secret, bỏ giá trị không primitive); kiểu `AuditMetadata` cấm key nhạy cảm lúc compile; mapper `toAdminAuditEvent` là allowlist (không `_id`, không `tenantId`).
  - Metadata hiện có chỉ là đếm/id/tên (`count`, `familyId`, `version`, `provider`, `changedFields`, `scope`, `resource`, `identifier`, `mode`, `oldKid`…). URI chỉ ghi số lượng (`listDelta`). `targetId` loại `session` = `sha256(sessionId)`, không đổi ngược thành cookie được.
  - Nhưng dữ liệu cũ trong Mongo là `Mixed`, và `userAgent`/`reason`/metadata có thể do kẻ tấn công kiểm soát (UA ở `AUTH_LOGIN_FAILED`). FE phải: (1) dùng zod ở `schemas.ts` (server-only) bỏ entry metadata không primitive và key giống secret TRƯỚC khi trả về trình duyệt; (2) render mọi giá trị dạng text.
  - KHÔNG allowlist theo tên key (sẽ vỡ mỗi khi BE thêm key): dùng denylist mirror BE + chỉ nhận primitive.
- **Q-48.3 — Bỏ export CSV khỏi run 48** (plan ghi tuỳ chọn) ⇒ DEBT-342.
- **Q-48.4 — Ảnh hưởng lớn: hiện KHÔNG admin nào thấy được `TOKEN_REUSE_DETECTED`.**
  - `listForTenant` gán `tenantId` của token vào filter cuối cùng; event không có `tenantId` không bao giờ khớp.
  - Event CÓ tenant: mọi ghi admin (`adminAuditBase`), `OAUTH_AUTHORIZE` (`access_denied`), xoay key. Event KHÔNG có tenant: login/locked/reset, session, token issued/refreshed/revoked, consent, federation, và **reuse** (record trong `revokeFamily` không có `tenantId`).
  - super_admin cũng chỉ thấy tenant của token (DEBT-124/143).
  - Yêu cầu chính của A6.4 là làm nổi reuse ⇒ thêm **Task 0(b) [BE]**: gắn `tenantId = client.tenantId` cho `TOKEN_REUSE_DETECTED` (chỉ event này; phần còn lại vẫn thuộc DEBT-140). UI có ghi chú cố định để admin không hiểu nhầm là "không có lần đăng nhập sai nào" (F3).

### Sự thật từ code (đối chiếu `2e171cc`)
- `GET /admin/audit`: `AdminTokenGuard` + `admin.read` (tenant_admin và super_admin đều đọc được); guard đặt `no-store`.
  - Sort `timestamp desc, eventId desc`. Cursor = base64url(JSON `{t,e}`); cursor sai ⇒ 400 `invalid_request` ("invalid cursor"); `from >= to` ⇒ 400.
  - Các filter so khớp exact và kết hợp AND (không có OR giữa actor và target).
- View (`AdminAuditView = Omit<AuditEvent,'tenantId'>`):
  - luôn có: `eventId`, `timestamp`, `actorType` (`user|client|admin|system`), `action`, `result` (`success|failure`);
  - TUỲ CHỌN (bị bỏ khỏi JSON khi `undefined`): `actorId`, `targetType`, `targetId`, `clientId`, `ip`, `userAgent`, `requestId`, `reason`, `metadata`.
- `targetType` đang dùng: `user`, `client`, `resource`, `session`, `signing_key`.
- OpenAPI snapshot: `/admin/audit` chỉ có parameters, **không có response schema** ⇒ Task 0(a).
- Log BE cắt query string (`serializeRequest`: `url.split('?')`).
- `issueForRefresh` nhận `client` kiểu `Pick<Client, 'clientId'|'allowedResources'|'clientType'|'tokenEndpointAuthMethod'>`. Controller dựng object này tường minh (`token.controller.ts` ~L391) ⇒ phải thêm `tenantId` ở cả hai chỗ.

### Phạm vi, phân công, thứ tự
- Task 0(a)+(b) → **backend-dev**; Task 1–4 → **frontend-dev**.
- Thứ tự: Task 0 ‖ Task 1 → Task 2 (cần snapshot từ Task 0a) → Task 3 → Task 4. Reuse KHÔNG kiểm ở E2E.
- Ngoài phạm vi:
  - export CSV (DEBT-342);
  - filter "mọi event liên quan tới user" (OR actor/target) (DEBT-343);
  - gắn tenant cho các event OAuth/auth còn lại (DEBT-140);
  - super_admin xem xuyên tenant (DEBT-124/143);
  - retention và che IP (DEBT-344).

### F0 — Task 0 [BE] (backend-dev)
(a) **OpenAPI response** (chỉ metadata, không đổi runtime), theo khuôn run 47 F0:
- `admin.views.ts`: `AdminAuditEventViewDto implements AdminAuditView`:
  - `eventId`: String; `timestamp`: `DATE`;
  - `actorType`: enum `['user','client','admin','system']`; `action`: enum `AuditAction`; `result`: enum `['success','failure']`;
  - `required: false` cho `actorId`, `targetType`, `targetId`, `clientId`, `ip`, `userAgent`, `requestId`, `reason` (String);
  - `metadata`: optional, `type: 'object'`, `additionalProperties: { oneOf: string|number|boolean, nullable }`.
- `AuditPageViewDto {items, nextCursor: string|null}`.
- `admin-audit.controller.ts`: `@ApiOkResponse({ type: AuditPageViewDto })`.
- `admin.spec.ts`:
  - key của mapper ↔ property của schema (gọi `toAdminAuditEvent` với MỌI field có giá trị);
  - enum `actorType`/`result`/`action` khớp;
  - `AuditPageViewDto` = `['items','nextCursor']`.
  - Mutation: bỏ 1 property của view ⇒ RED.
- Cập nhật snapshot `fe-admin/openapi/admin.json` + chạy `pnpm -C fe-admin gen:api` (cùng cách run 47); commit cả hai file.

(b) **Gắn `tenantId` cho `TOKEN_REUSE_DETECTED`** (một phần DEBT-140):
- Chuỗi thay đổi:
  - `AuditCtx` thêm `tenantId?: string`;
  - `issueForRefresh`: Pick thêm `'tenantId'`;
  - `token.controller.ts` truyền `tenantId: client.tenantId` (client đã load và xác thực; KHÔNG lấy từ body/header/query);
  - giá trị đi qua `issueForRefresh` → `rotate` → `classifyMiss` → `revokeFamily(..., { reuse: true, audit })` ⇒ record thêm `tenantId: opts.audit?.tenantId`.
- KHÔNG đổi event khác (TOKEN_REFRESHED/REVOKED… vẫn thuộc DEBT-140). Các lần gọi `revokeFamily` từ admin/token controller không có `reuse` ⇒ không đổi.
- Test int:
  - `refresh-token.int-spec.ts` (case reuse hiện có): assert `tenantId === <tenant của client>`;
  - int (admin-users hoặc file audit hiện có): admin của tenant sở hữu client gọi `GET /admin/audit?action=TOKEN_REUSE_DETECTED` ⇒ thấy event có `metadata.familyId`; admin tenant khác ⇒ 0 item.
  - Mutation: bỏ `tenantId` trong record ⇒ RED.
- Ghi chú vào DEBT-140: "run 48: chỉ `TOKEN_REUSE_DETECTED` đã gắn".

### F1 — Task 1 [FE]: DEBT-339/340/341 (thay text cũ)
- **DEBT-339** (`features/users/user-grants.tsx`, `revokeFamily`):
  - Khi kết quả không chắc chắn (lỗi không phải `AdminRequestError`, hoặc `err.uncertain`) ⇒ `return { done: FAMILY_UNCERTAIN }`: đóng dialog, `announce` vào `role="status"`, focus heading "Refresh token families".
  - `step_up_required` và lỗi xác định giữ nguyên `outcomeOf`. List vẫn được đọc lại (`useInvalidateOn`).
  - Test:
    1. uncertain + lần đọc lại trả family đã revoke ⇒ status = `FAMILY_UNCERTAIN`, `document.activeElement` là heading;
    2. uncertain + family vẫn active ⇒ status có thông điệp, dialog đóng, nút Revoke còn.
  - Lật test characterisation DEBT-339 của tester run 47 (`test/users-risk.test.tsx`).
  - Mutation: trả lại `outcomeOf(err, FAMILY_UNCERTAIN)` ⇒ RED.
- **DEBT-340** (`e2e/tests/fe-admin-users.spec.ts`): trong `finally`, lấy token MỚI (`adminToken(...)`) rồi mới unlock. Giữ `.catch`, sửa comment cho đúng (seed vẫn là cơ chế dọn chính).
- **DEBT-341** (ponytail):
  - inline `useInvalidateUsers`;
  - thay `pageQuery` bằng `query(params)`: nhận object phẳng, `set` mọi key có giá trị `!== undefined` (số ⇒ `String`), trả `""` khi rỗng. Dùng chung cho các list hiện có, `listUsers` và `listAudit` (F2);
  - gộp ternary trạng thái rỗng ở `routes/users/index.tsx`.
  - Không đổi hành vi: test cũ xanh, không sửa test cũ (trừ DEBT-339).

### F2 — Task 2 [FE]: audit server fn + schema (thay text cũ)
- `features/admin-api/inputs.ts`:
  - `AUDIT_ACTIONS` (mirror enum BE) và `AUDIT_TARGET_TYPES = ['user','client','resource','session','signing_key']`;
  - `test/admin-schema-types.test.ts` kiểm hai chiều `AUDIT_ACTIONS` ↔ kiểu `action` trong `paths["/admin/audit"]["get"]["parameters"]["query"]` (lệch ⇒ `typecheck` đỏ);
  - `AuditIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)`; `AuditCursorSchema` = `/^[A-Za-z0-9_-]{1,512}$/`;
  - `AuditListInput = z.object({ limit, after: AuditCursorSchema, action: enum, actorId/targetId/clientId: AuditIdSchema, targetType: enum, result: enum, from/to: z.iso.datetime({ offset: true }) }).partial().strict()` + refine `from < to`. KHÔNG có `tenantId`.
- `server/admin-api/client.ts`: `listAudit(ctx, params)` ⇒ `GET /admin/audit${query(params)}`, `route: "/admin/audit"`, `schema: AuditPageSchema`.
- `server/admin-api/schemas.ts` (server-only), `AuditEventSchema`:
  - `eventId`, `timestamp`: `z.string()`;
  - `action`, `actorType`: `z.string()`, KHÔNG dùng enum (một action mới từ BE không được làm hỏng cả trang; lệch được bắt bằng type test);
  - `result`: `z.enum(['success','failure'])`;
  - `actorId`, `targetType`, `targetId`, `clientId`, `ip`, `userAgent`, `requestId`, `reason`: `z.string().nullish()`;
  - `metadata: z.record(z.string(), z.unknown()).nullish().transform(safeMetadata)`:
    - chỉ giữ entry có giá trị `string|number|boolean|null` VÀ có key không khớp denylist;
    - denylist chuẩn hoá key như `isSecretKey` của BE (lowercase, bỏ ký tự ngoài a-z): exact `code`, `authorizationcode`; chứa `password|secret|token|privatekey|cookie|authorization|verifier|hash`;
    - trả `null` khi không còn entry nào;
    - metadata có shape lạ KHÔNG được làm fail trang.
  - `AuditPageSchema {items, nextCursor}`.
- `features/admin-api/audit.ts`: `listAudit = createServerFn({ method: "GET" })`, kèm comment: input chỉ gồm id opaque + enum + ISO, `AuditIdSchema` chặn email ⇒ được phép vào URL. `keys.ts`: `audit: { all, list(params) }`; `hooks.ts`: `useAuditEvents(params)`.
- Test (fake BE như run 47):
  - response có `tenantId`, `_id`, `secretHash` ở top-level, và metadata `{clientSecret, refresh_token, codeVerifier, tokenHash, nested:{a:1}, list:[1], familyId:'f', count:2}` ⇒ kết quả server fn chỉ còn `familyId`, `count` cùng các field trong allowlist;
  - input `actorId: "a@b.c"`, id có khoảng trắng, `from >= to`, key lạ ⇒ bị từ chối, 0 request tới BE;
  - query string đúng thứ tự và được encode.
  - Mutation: bỏ `safeMetadata` ⇒ RED; nới `AuditIdSchema` cho phép `@` ⇒ RED.

### F3 — Task 3 [FE]: `/audit` (bổ sung)
- Tạo `routes/audit/index.tsx` và thêm mục "Audit log" vào `components/layout/app-sidebar.tsx`.
- `validateSearch`: mỗi filter và `after` dùng `.optional().catch(undefined)` riêng (giá trị rác bị bỏ, không lỗi trang, không gửi BE).
- Form lọc:
  - select action ("Any" + `AUDIT_ACTIONS`), select result, select target type;
  - ô text actor id / target id / client id, validate bằng `AuditIdSchema` khi submit ⇒ sai thì báo lỗi ở field, KHÔNG navigate, KHÔNG gửi request;
  - `datetime-local` from/to ⇒ `new Date(v).toISOString()`; kiểm `from < to` trước khi navigate;
  - Submit ⇒ navigate với search mới (bỏ `after`); "Clear filters" ⇒ search rỗng.
- Ghi chú cố định dưới form: sự kiện đăng nhập/token/session chưa gắn tenant nên chưa hiện ở đây, trừ token reuse (DEBT-140).
- Bảng: Time (ISO nguyên văn, font mono), Action, Result, Actor (`actorType` + id), Target (`targetType` + id), Client. Phân trang Next/First giữ filter (khuôn `/users`).
- **Làm nổi** (bằng chữ, không chỉ bằng màu):
  - `TOKEN_REUSE_DETECTED` ⇒ nhãn "Security alert: token reuse";
  - `SIGNING_KEY_ROTATED` với `metadata.mode === "emergency"` ⇒ "Security alert: emergency key rotation";
  - `result === "failure"` ⇒ chữ "Failure";
  - không đánh dấu các action khác.
- Chi tiết: nút "Details" (`aria-expanded`, `aria-controls`) mở `<dl>` gồm eventId, requestId, ip, userAgent, reason và từng cặp metadata. IP/UA chỉ hiện trong chi tiết, không vào bảng hay URL.
- **Render**:
  - mọi giá trị là text React;
  - cấm `dangerouslySetInnerHTML`, cấm tự biến giá trị thành link (kể cả khi trông như URL), cấm `href` dựng từ dữ liệu;
  - link chỉ qua `<Link to params>`:
    - `/users/$userId` khi (`targetType==='user'` && `targetId` là 24 hex) hoặc (`actorType ∈ {user,admin}` && `actorId` là 24 hex);
    - `/clients/$clientId` khi `clientId` qua `ClientIdSchema`;
  - trang đích tự trả 404 opaque nếu id ngoài tenant.
- Lỗi: hiện `AdminRequestError.message` + "Try again"; `invalid_request` khi đang có `after` ⇒ thêm link "First page".
- `/users/$userId`: thêm link "Audit events for this account" ⇒ `/audit?targetType=user&targetId=<id>`.
- Test (RTL):
  - filter ⇒ search params;
  - email trong ô id ⇒ không navigate, URL/`returnTo` không có `@`, 0 lần gọi server fn;
  - search rác bị bỏ;
  - nhãn reuse và emergency; failure có chữ;
  - metadata `<img src=x onerror=…>` và UA `<script>` hiện dạng text (không có `img`/`script` mới trong DOM);
  - giá trị `javascript:alert(1)` không thành link;
  - link user/client chỉ có khi id hợp lệ;
  - Next giữ filter;
  - `from >= to` bị chặn.
  - Mutation: bỏ nhãn reuse ⇒ RED; tạo link khi id không hợp lệ ⇒ RED.

### F4 — Task 4 [E2E] (thay text cũ)
- `e2e/tests/fe-admin-audit.spec.ts`:
  - lấy token admin qua API (khuôn `fe-admin-users.spec.ts`), tìm id user E2E bằng `adminApi` (không qua trình duyệt);
  - `start` = now − 1 phút; lock rồi unlock user E2E bằng API;
  - đăng nhập fe-admin ⇒ `/audit` ⇒ điền form: action `ADMIN_USER_LOCKED`, target id = userId, from = `start` ⇒ có ≥1 hàng, có link tới `/users/<id>`; mở Details ⇒ thấy `count`;
  - đổi action sang `ADMIN_USER_UNLOCKED` ⇒ có ≥1 hàng.
- Kiểm âm: `page.url()` không chứa `@` hay email E2E; text trang không chứa email E2E hay `eyJ`. Trong `finally`: lấy token MỚI rồi unlock (như DEBT-340).
- KHÔNG kiểm reuse ở E2E (int test của F0b đã phủ). Không FLUSH/drop: dữ liệu cũ tích luỹ được loại bằng `from` + `targetId`.

### Cổng security (đã kiểm)
- **Tài sản, actor, boundary**:
  - tài sản: bản ghi audit (id, IP, UA, metadata) và access token admin nằm ở BFF;
  - tenant_admin và super_admin đều chỉ đọc được tenant của token; non-admin bị guard chặn;
  - boundary: trình duyệt ↔ BFF (server fn, zod) ↔ BE (guard + `filter.tenantId` gán cuối).
- **Invariant**: chỉ đọc, không có state transition; FE không bao giờ gửi `tenantId` (input `.strict()`).
- **Abuse case**:
  - IDOR qua `targetId`/`clientId` của tenant khác ⇒ BE trả rỗng giống như không tồn tại (không có oracle);
  - cursor giả ⇒ 400, có xử lý;
  - XSS qua UA/`reason`/metadata (kẻ tấn công kiểm soát UA khi login sai) ⇒ chỉ render text;
  - open redirect/`javascript:` ⇒ không có link dựng từ dữ liệu;
  - email lọt vào URL ⇒ chặn bằng `AuditIdSchema`;
  - reuse gắn sai tenant ⇒ tenant chỉ lấy từ `client` đã xác thực.
- **Failure**: BE timeout/5xx/schema mismatch ⇒ trạng thái lỗi + nút thử lại; không có thao tác ghi nên không có trạng thái uncertain. Ghi audit reuse lỗi ⇒ giữ hành vi cũ (fail-closed 5xx).
- **Exposure**: trình duyệt không nhận `tenantId`, `_id`, metadata giống secret hay metadata lồng nhau; URL chỉ chứa enum, id opaque và ISO; IP/UA chỉ hiện trong chi tiết. Test âm: F2 (strip), F3 (XSS, email, link), F4 (URL/text).
