# Log — run 27 — B6.3a (admin API: nền tảng + clients + secrets + resources)

## orchestrator — 2026-10-16
- B6.3 (size L) tách: **27 = B6.3a** (nền tảng admin + clients + secrets + resources), 28 = B6.3b (users, refresh families, consents, audit log, keys, tenants). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B6 dòng 212, spec §9.10–9.11, §10 (AuditLog actions), spec dòng 489. Cổng → tech-lead.

## tech-lead — 2026-10-16
- **PASS** (fold bắt buộc trong `tasks.md` mục "Fold tech-lead"). Q-27.1: `@nestjs/swagger@12.0.2`, JSON-only `/openapi/admin.json` ngoài production. Q-27.2: hoãn super_admin xuyên tenant (DEBT-124). Q-27.3: secret chỉ qua endpoint secrets. Q-27.4: không DELETE, `disabledAt`; resource identifier bất biến.
- Lệch code: Resource global (không `tenantId`) ⇒ Task 4 ghi chỉ super_admin; chặn tenant_admin gán resource `admin`; clientId server sinh (chống oracle); disable chặn ở `findByClientId` + CORS; `decideConsent` kiểm lại redirect_uri (lỗ redirect cũ); không có cache CORS; step-up mọi mutation.
- Debt mới: DEBT-124…129. Chuyển **backend-dev** Task 1→4.

## backend-dev — 2026-10-16
- **Task 1–4 [x]** (không tách 27b). `@nestjs/swagger@12.0.2` pin exact (`@scarf/scarf` build = false trong `pnpm-workspace.yaml`); `GET /openapi/admin.json` chỉ dev/test (allowlist NODE_ENV), lọc path `^/admin` + schema được tham chiếu (lệch fold `include:[AdminModule]`: bootstrap int không mount AdminModule — cùng helper cho main + int); repo `find{sort,limit,projection}` + `findOneAndUpdate` (before-doc); mapper allowlist; `AdminAuthError.notFound/conflict/invalidRequest`; `@CurrentAdmin()` (roles + clientId); `ADMIN_RESOURCE_*`; index `{tenantId,clientId}` (dev DB cần `db:sync-indexes`).
- Security gate: asset = client config/secret; actor tenant_admin/super_admin; boundary = tenant token ↔ `{clientId,tenantId}` trong filter (404 byte-identical); mọi mutation `admin.write` + step-up 5'; clientId server sinh (UUID); chỉ super_admin gán resource `admin`/ghi Resource; bất biến type/authMethod/id/tenant (400); disable = `disabledAt` chặn tại `findByClientId` + 2 query CORS; tự disable BFF ⇒ 409; secret plaintext chỉ trong POST `no-store`+`Pragma`, audit trước khi trả (audit lỗi ⇒ 500, không plaintext); fail-closed: Mongo/audit lỗi ⇒ 5xx, `ClientService` thiếu `ResourceService`/issuer ở admin write ⇒ throw.
- `decideConsent` (approve) kiểm lại client còn bật + redirect_uri còn đăng ký + resource còn allowed ⇒ sai trả `null` (trang 400, không 302, không mint). `ClientService.create` thêm ràng buộc `public⇔none` + `validateCorsOrigin` (đổi fixture `clients.int-spec` CORS sang config development).
- Verify thật: typecheck ✅, lint ✅, unit **241/241** (+21 `admin.spec.ts`), int **578/578** (26 suite, +24 `admin-api.int-spec.ts`). Boot `dist` NODE_ENV=test: `/openapi/admin.json` 200 (7 path `/admin*`, không `secretHash`), `/admin/clients` không token 401; prod boot local không chạy được (LocalKeyProvider dev-only) — gate prod phủ bằng unit.
- Mutation RED→khôi phục byte-identical (sha256): bỏ check redirect ở decideConsent, bỏ `disabledAt` ở `findByClientId`/2 query CORS, bỏ check super_admin (client + resource), bỏ 409 tự disable, bỏ `tenantId` trong repo scope, bỏ step-up PATCH/POST, bỏ `validateCorsOrigin`, bỏ projection `secretHash:0`, bỏ nhánh rotate, mapper spread ⇒ đều RED.
- E2E `pnpm -C e2e e2e`: **không chạy được** — `:5173` đang bị vite của project khác (`tiptap-editor/apps/playground`, PID 51816) chiếm; KHÔNG kill. BE webServer (build+sync-indexes+seed+start) lên OK trước khi Playwright dừng. Không còn process BE nào do tôi khởi động.
- Debt mới: DEBT-130 (deny/login_required vẫn 302 về URI đã gỡ), DEBT-131 (quy tắc `admin` theo "chứa"), DEBT-132 (re-disable ghi đè `disabledAt`). Chuyển **senior-reviewer**.

## senior-reviewer — 2026-10-16
- **REJECT** (1 🔴 [BE]). Chạy lại: typecheck ✅, unit 241/241 ✅, `test:int admin-api` 24/24 ✅.
- 🔴 Leo thang tenant_admin → super_admin: quy tắc resource `admin` chỉ chặn lúc **gán** `allowedResources`; trên client ĐÃ có `admin` (BFF), tenant_admin vẫn PATCH `redirectUris` + `POST .../secrets` (lấy plaintext) ⇒ phishing super_admin lấy AT `aud=admin`; hoặc PATCH `allowedResources: []`/gỡ redirect/`DELETE` secret ⇒ khóa admin API mọi admin. Fix: mọi mutation (PATCH, POST/DELETE secrets) trên client mà `allowedResources` hiện tại chứa `admin` ⇒ chỉ super_admin (PATCH: điều kiện `$nin` trong filter `findOneAndUpdate`), + int test + mutation RED.
- Đã kiểm OK: tenant trong filter/404 opaque, clientId UUID, bất biến, step-up 6/6 mutation, disable một cửa (grep mọi caller `findByClientId` + 2 query CORS), không lộ secretHash/plaintext, OpenAPI gate NODE_ENV, scarf tắt.
- 🟡 → DEBT-133 (race create/rotate secret), DEBT-134 (`updatedAt` cũ trong response PATCH), DEBT-135 (echo input trong error_description). Ponytail: `FindOptions.projection` thừa, luôn `rotateSecret`. Chuyển **backend-dev**.

## backend-dev (retry 1) — 2026-10-16
- Security gate: asset = client admin-capable (`allowedResources` hiện tại chứa resourceId của resource `identifier=adminResourceIdentifier(issuer)`); actor tenant_admin ⇒ MỌI mutation (PATCH mọi field kể cả `disabled`, POST/DELETE secrets) ⇒ 403 `forbidden`; super_admin ⇒ được. Fail-closed: thiếu `ResourceService`/issuer ⇒ throw 5xx; resource admin chưa đăng ký ⇒ không client nào admin-capable.
- PATCH nguyên tử: non-super ⇒ filter `findOneAndUpdate` thêm `allowedResources:{$nin:adminIds}`; không khớp ⇒ `getForTenant` cùng tenant: có ⇒ 403, không ⇒ 404 (cross-tenant vẫn 404 opaque). Secrets: `ClientService.assertMayModify` trên doc `mustFind` (controller `mustModify`) trước rotate/revoke — TOCTOU còn lại chỉ khi super_admin đồng thời gán `admin` (chấp nhận). 409 tự-disable vẫn chạy trước.
- DEBT-133 đóng: POST secrets luôn `rotateSecret`; `hasActive` chỉ chọn action audit. **DEBT-131 đóng** (superseded): "admin-capable ⇒ chỉ super_admin" giờ là quy tắc chủ đích cho mọi field, không còn là tác dụng phụ của kiểm `allowedResources`.
- Int mới: tenant_admin trên client có `admin`: PATCH redirectUris / allowedResources:[] / giữ nguyên / disabled / scopes ⇒ 403 + snapshot client+credentials không đổi; POST secrets 403 không plaintext; DELETE 403, secret cũ vẫn auth; id lạ ⇒ 404; super_admin 200/201/204; client thường tenant_admin 200/201/204. Concurrency 2 POST đầu ⇒ đúng 1 version không expiry.
- RED trước fix: 2/2 test mới đỏ đúng lý do. Mutation (bỏ `$nin` / bỏ kiểm secrets / re-read trả 404) ⇒ mỗi cái 1 đỏ; khôi phục byte-identical (sha256 OK).
- Verify thật: typecheck ✅, lint ✅, unit **241/241**, int **580/580** (26 suite, +2). E2E không chạy (`:5173` bị project khác giữ). Chuyển **senior-reviewer** lượt 2.

## senior-reviewer (lượt 2) — 2026-10-16
- **PASS**. Chạy lại: typecheck ✅, unit 241/241 ✅, int 580/580 (26 suite) ✅.
- 🔴 lượt 1 đã đóng: tenant_admin trên client admin-capable ⇒ PATCH (redirectUris, allowedResources [], giữ nguyên, disabled, scopes) / POST / DELETE secrets đều 403, DB và credentials không đổi. PATCH nguyên tử nhờ `$nin` trong filter. Cross-tenant vẫn 404 theo cấu trúc (re-read scoped). Resource `admin` chưa đăng ký ⇒ an toàn vì không mint được `aud=admin` và resourceId phải tồn tại.
- TOCTOU secrets: chấp nhận, vì không cho thêm quyền nào so với trước lúc gán `admin`. Rủi ro thật là việc nâng cấp client do tenant_admin cấu hình ⇒ DEBT-137.
- 🟡 → DEBT-136 (int cross-tenant cho client admin-capable), DEBT-137 (nâng cấp kế thừa cấu hình tenant_admin), DEBT-138 (ponytail: `projection` thừa, kiểm wiring lặp). Chuyển **tester**.

## tester — 2026-10-16
- **PASS**. Xem `test-report.md`. Typecheck ✅, lint ✅, BE unit **241/241**, BE int **585/585** (26 suite, +5 tester), FE **240/240**, E2E **12/12** (`:5173` trống; webServer Playwright tự dừng, không còn process).
- Test mới (`admin-api.int-spec.ts` › "tester run 27 — gaps"): DEBT-136 (client admin-capable tenant khác ⇒ 404 byte-identical cho tenant_admin + super_admin, 7 thao tác, DB không đổi), disable client admin-capable ⇒ AT admin của nó 401 (liveness) rồi enable lại 200, disable chặn `client_secret_post` tại `/token`, grace `expiresAt = now + TTL`, OpenAPI production/unset ⇒ 404 trên Fastify thật.
- Mutation: re-read không scope trong `updateForTenant` ⇒ test DEBT-136 RED (403); khôi phục byte-identical (sha256).
- Đóng **DEBT-136**; mở **DEBT-139** (cảnh báo Mongoose `new` ở `refresh-token.service.ts`, ngoài diff). Không lỗi [BE] chặn. Chuyển **orchestrator** đóng run.

## orchestrator — 2026-10-16 (đóng run)
- Mọi cổng PASS. Commit `b9370c1`. summary.md + Tiến độ STATUS.md; 🟡 đã ở backlog.
