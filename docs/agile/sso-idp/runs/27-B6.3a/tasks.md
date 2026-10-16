# Tasks — run 27 — B6.3a: admin API nền tảng + clients + secrets + resources (M5)

> Plan §B6 dòng 212 (B6.3, tách phần a), D6 (plan dòng 101: resource `admin`, `admin.read`/`admin.write`, roles `super_admin`/`tenant_admin`), spec §9.10 (tenant từ token/phiên, query có ràng buộc tenant tường minh), §9.11 (step-up + audit cho: đổi `redirect_uris`, tạo/rotate secret, đổi `allowedResources`), §10 AuditLog actions (`ADMIN_CLIENT_CREATED/UPDATED`, `REDIRECT_URI_CHANGED`, `CLIENT_SECRET_CREATED/ROTATED/REVOKED`), spec dòng 489. Dùng guard run 26: `AdminTokenGuard`, `@AdminScope`, `@AdminRoles`, `@RequireRecentAuth(5)`. Validator sẵn có B3.1/B3.2 (redirect_uri, resource), secret hash/grace B3.1 (`CLIENT_SECRET_GRACE_TTL`).
>
> Phần b (run 28): users, refresh families, consents, audit log, keys, tenants. Thứ tự: Task 1 → 2 → 3 → 4 (backend-dev). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop dữ liệu `aegate-*`.

### [x] Task 1 [BE]: Nền tảng admin API
- OpenAPI cho `/admin/*` (chọn lib nhẹ, ưu tiên `@nestjs/swagger` nếu tương thích Fastify adapter; endpoint spec JSON chỉ bật ngoài production hoặc cần token admin — tech-lead chốt).
- Quy ước chung: validation DTO (zod/class-validator theo codebase), lỗi `{error, error_description?}` an toàn, phân trang server-side (cursor/limit có trần), response projection loại `secretHash`/`tokenHash`/trường nội bộ (type-level nếu khả thi).
- Chính sách tenant: `tenant_admin` chỉ tenant của token; `super_admin` xuyên tenant (chốt cách chỉ định tenant đích an toàn — vd. path param chỉ được chấp nhận với `super_admin`, vẫn audit). Mọi query repository có `tenantId` tường minh (repo base B2.1).
- Audit helper cho thao tác admin (actor = sub, tenantId, requestId, result), không trường bí mật.
- **Acceptance**: unit/int cho projection (không lộ hash), phân trang trần, `tenant_admin` không chỉ định được tenant khác, OpenAPI sinh được.

### [x] Task 2 [BE]: Clients — list/get/create/update/disable
- `GET /admin/clients`, `GET /admin/clients/:clientId` (`admin.read`); `POST`, `PATCH`, disable (`admin.write`).
- Đổi `redirect_uris` / `allowedResources` / `allowedCorsOrigins`(?) ⇒ step-up + audit (`REDIRECT_URI_CHANGED`, `ADMIN_CLIENT_UPDATED` với diff không bí mật). Validator B3.1/B3.2 tái dùng (exact, absolute, không fragment, resource tồn tại cùng tenant).
- Tạo client confidential trả secret **đúng 1 lần** (hoặc tách sang Task 3 — tech-lead chốt).
- **Acceptance**: int-test CRUD, cross-tenant 404/403 không oracle, thay đổi nhạy cảm thiếu step-up ⇒ 403 `step_up_required`, audit ghi đúng action, cache/CORS client (ClientCorsService) được làm mới sau update.

### [x] Task 3 [BE]: Client secrets — create/rotate/revoke
- `POST /admin/clients/:id/secrets` (create/rotate: secret cũ còn hiệu lực trong grace `CLIENT_SECRET_GRACE_TTL`), `DELETE .../secrets/:version` (revoke ngay). Tất cả step-up + audit `CLIENT_SECRET_CREATED/ROTATED/REVOKED`.
- Plaintext secret chỉ trả trong response tạo (`no-store`), không log, không đọc lại được.
- **Acceptance**: int: secret mới auth `/token` được; cũ hoạt động trong grace rồi hết; revoke ⇒ cũ bị từ chối ngay; list secrets chỉ metadata; log không chứa secret (grep test).

### [x] Task 4 [BE]: Resources — list/get/create/update
- `GET/POST/PATCH /admin/resources` theo tenant; identifier absolute URI không fragment (validator B3.2), unique; đổi identifier của resource đang dùng — chặn hoặc step-up (tech-lead chốt).
- **Acceptance**: int CRUD + cross-tenant + validation âm; audit.

## Câu hỏi cho tech-lead
- Q-27.1: Thư viện OpenAPI + expose ở đâu.
- Q-27.2: Cách `super_admin` chỉ định tenant đích.
- Q-27.3: Secret khi tạo client: trong Task 2 hay luôn qua endpoint secrets.
- Q-27.4: Disable vs delete client; đổi identifier resource.

---

## Fold tech-lead (2026-10-16) — ƯU TIÊN HƠN text cũ ở trên

> Đối chiếu code thật: `Client` schema KHÔNG có trường disable; `Resource` KHÔNG có `tenantId` (spec §10: global; `resourceId` không unique); `ClientCredential` không có `tenantId` (sở hữu qua `clientId`); `ClientCorsService` KHÔNG có cache (đọc Mongo mỗi request) và chưa có validator origin; `@nestjs/swagger` chưa cài (12.0.2: peer khớp Nest 12 + `@fastify/static` 8 + class-validator/transformer đã có); validation codebase = class-validator + `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` global ở `main.ts`; `AuditMetadata` chỉ nhận primitive phẳng và `sanitizeMetadata` lặng lẽ xoá key khớp `/password|secret|token|.../` (vd. key `tokenEndpointAuthMethod` bị xoá).

### Trả lời câu hỏi
- **Q-27.1 (OpenAPI)**: `@nestjs/swagger@12.0.2` (pin exact), **không mount Swagger UI**. `SwaggerModule.createDocument(app, cfg, { include: [AdminModule] })`, phục vụ JSON tại `GET /openapi/admin.json` **chỉ khi `NODE_ENV !== 'production'`** (gate cùng kiểu `isDemoEnabled`; KHÔNG đặt dưới prefix `/admin` để khỏi lẫn với route guarded). Production: không đăng ký route (404). Không dùng Nest CLI swagger plugin; DTO khai `@ApiProperty` tường minh. Đăng ký qua 1 helper dùng chung cho `main.ts` và bootstrap int-test (cùng cách `registerCorsPreflight`).
- **Q-27.2 (super_admin xuyên tenant)**: **HOÃN** (DEBT-124). Run 27: cả `super_admin` và `tenant_admin` chỉ thao tác tenant của token (như run 26). Không path/query/body nào nhận `tenantId` (`forbidNonWhitelisted` ⇒ 400). Khác biệt vai trò duy nhất run 27: (a) ghi Resource (global) chỉ `super_admin`; (b) gán resource `admin` vào `allowedResources` chỉ `super_admin`.
- **Q-27.3 (secret khi tạo client)**: tạo client **không bao giờ** tạo/trả secret. Confidential client mới chưa có credential (không auth `/token` được) cho tới khi gọi `POST /admin/clients/:clientId/secrets`. Chỉ một đường trả plaintext.
- **Q-27.4**: **không có DELETE client** (RefreshToken/Consent/AuditLog tham chiếu). Disable = trường `disabledAt: Date|null` (PATCH `{disabled: true|false}`, đảo được). Resource: `resourceId` + `identifier` **bất biến** (đổi identifier vô hiệu hoá ngay mọi AT `aud` cũ qua liveness `identifiersFor`; với resource `admin` thì khoá luôn admin API) — chỉ PATCH `scopes`; cần identifier mới ⇒ tạo resource mới.

### Quyết định chung (áp mọi task)
- **D-27.a Step-up cho MỌI mutation** run 27 (`POST`/`PATCH`/`DELETE`): `@AdminScope('admin.write')` + `@RequireRecentAuth(5)`. Không có logic "chỉ field nhạy cảm mới step-up" (tránh bypass theo field). GET = `admin.read`, không step-up.
- **D-27.b clientId do server sinh** (`generateToken()`/UUID, không nhận từ body) ⇒ không có oracle E11000 "clientId đã tồn tại ở tenant khác". Seed/test vẫn gọi `ClientService.create` với id cố định.
- **D-27.c Cross-tenant = không tồn tại** ⇒ cùng `404 {error:"not_found"}` (body byte-identical). Query luôn `{clientId, tenantId: ctx.tenantId}` trong chính filter (repo B2.1), không find-then-check.
- **D-27.d Lỗi admin**: thêm static vào `AdminAuthError` (`notFound()` 404, `conflict(desc)` 409, `invalidRequest(desc)` 400 `{error:"invalid_request", error_description}`), render bởi `AdminAuthErrorFilter` (đã `no-store`). Lỗi `ValidationPipe` đi qua global `OAuthExceptionFilter` ⇒ `{error:"invalid_request", error_description}` — chấp nhận. `InvalidRedirectUriError`/`InvalidResourceError`/`DuplicateError` map sang `invalidRequest`/`conflict` tại controller; mọi lỗi khác (Mongo) ⇒ 5xx `server_error` (fail-closed).
- **D-27.e Thứ tự ghi**: mutation → `audit.record` (ghi audit lỗi ⇒ throw ⇒ 5xx; không rollback, cùng pattern DEBT-050). Secrets: audit lỗi ⇒ 5xx, plaintext KHÔNG trả về (DEBT-129).

### Task 1 [BE] — chỉnh
- `TenantScopedRepository`: thêm option `{ sort, limit, projection }` cho `find`, và `findOneAndUpdate(ctx, filter, update)` trả **document trước** (`returnDocument:'before'`, lean) để tính diff nguyên tử. Giữ `scope()`/`withoutTenantId`.
- Phân trang: `?limit` (int 1..100, mặc định 20) + `?after=<khoá sort>`; clients sort `clientId` (unique), resources sort `identifier` (unique); response `{ items, nextCursor|null }`. Thêm index `ClientSchema.index({ tenantId: 1, clientId: 1 })`, khẳng định trong `indexes.int-spec.ts` (nhắc chạy `db:sync-indexes` DB dev/E2E).
- Projection: mapper **allowlist** tường minh `toAdminClient`, `toAdminResource`, `toAdminCredential` (không spread doc; không `_id`/`__v`/`secretHash`); query credentials có projection `{ secretHash: 0 }` ở DB.
- Audit helper ⇒ `{actorType:'admin', actorId: ctx.userId, tenantId: ctx.tenantId, requestId: req.id, ip: req.ip, userAgent}`; metadata phẳng, tên key không chứa `token|secret|password|...` (vd. `changedFields: "redirectUris,allowedResources"`, `redirectUrisAdded: n`, `redirectUrisRemoved: n`, `disabled: true`, `version: n`). Thêm `ADMIN_RESOURCE_CREATED`, `ADMIN_RESOURCE_UPDATED` vào `AuditAction` + `ALERT_ACTIONS`.
- Admin principal mang thêm `clientId` (= `claims.client_id`) để Task 2 chặn tự-khoá.
- **Acceptance (bổ sung/thay)**: unit mapper (key set chính xác); int `limit=101`/`limit=0`/`after` sai kiểu ⇒ 400; `?tenantId=` hoặc body `tenantId` ⇒ 400; `GET /openapi/admin.json` (test env) trả `openapi: 3.x` có path `/admin/clients` và toàn doc không chứa `secretHash`; unit gate production ⇒ route không đăng ký.

### Task 2 [BE] — chỉnh
- Endpoints: `GET /admin/clients`, `GET /admin/clients/:clientId`, `POST /admin/clients`, `PATCH /admin/clients/:clientId` (gồm `disabled`). Không DELETE.
- DTO create: `clientType`, `tokenEndpointAuthMethod` (ràng buộc `public` ⇔ `none`; `confidential` ⇔ `client_secret_basic|client_secret_post`; sai ⇒ 400), `grantTypes`, `redirectUris`, `postLogoutRedirectUris`, `frontchannelLogoutUri?`, `allowedCorsOrigins`, `allowedResources`, `scopes`. Mảng `@ArrayMaxSize(20)`, chuỗi `@MaxLength(2048)`. PATCH: các field mảng/optional trên + `disabled`; **bất biến** `clientId`, `clientType`, `tokenEndpointAuthMethod`, `tenantId` (gửi ⇒ 400); PATCH rỗng ⇒ 400; mảng thay thế toàn bộ.
- Validation đặt trong `ClientService` (dùng chung create+update, không lặp ở controller): redirect/post-logout/frontchannel qua `validateRedirectUriList`/`validateRedirectUriFormat`; **thêm** `validateCorsOrigin`: `new URL(o).origin === o` (không path/query/fragment/`*`), https hoặc `http://localhost` ngoài production; `allowedResources`: mỗi `resourceId` phải tồn tại (global); chứa resourceId của resource `admin` (identifier `adminResourceIdentifier(issuer)`) mà actor không có `super_admin` ⇒ 403 `forbidden` (chặn tenant_admin dựng client xin token `aud=admin` của admin khác).
- Disable: `ClientSchema` thêm `disabledAt: { type: Date, default: null }`. **Một cửa chặn**: `ClientService.findByClientId` lọc `{clientId, disabledAt: null}` (khớp cả doc cũ thiếu field) ⇒ `/authorize` (unknown_client), `/token` + `/introspect` (invalid_client), liveness AT (inactive ngay), logout. `ClientCorsService` cả 2 query thêm `disabledAt: null`. Admin reads dùng repo tenant, KHÔNG lọc disabled. Disable chính client đã phát hành admin token đang gọi (`principal.clientId`) ⇒ 409.
- **Đóng lỗ redirect cũ**: `AuthorizeService.decideConsent` sau khi re-resolve client phải kiểm `isRegisteredRedirectUri(client.redirectUris, ctx.redirectUri)` và resource của ctx (nếu có) còn trong `allowedResources`; sai ⇒ trả `null` (trang lỗi first-party, KHÔNG redirect tới URI đã gỡ, không mint code). Client disabled/biến mất ở bước này cũng ⇒ `null` thay vì redirect `access_denied`.
- Audit: create ⇒ `ADMIN_CLIENT_CREATED`; PATCH ⇒ `ADMIN_CLIENT_UPDATED` (`changedFields`, counts) + thêm `REDIRECT_URI_CHANGED` khi `redirectUris`/`postLogoutRedirectUris`/`frontchannelLogoutUri` đổi thật (so before-doc).
- Không có cache client/CORS để "làm mới" (đọc DB mỗi request) — acceptance đổi sang hành vi.
- **Acceptance (thay)**: int CRUD; tenant B GET/PATCH client tenant A ⇒ 404 body y hệt id ngẫu nhiên không tồn tại; `auth_time` > 5' ở POST/PATCH ⇒ 403 `step_up_required` và DB không đổi; token chỉ `admin.read` gọi POST ⇒ 403 `insufficient_scope`; redirect wildcard/fragment/http-nonlocal, CORS origin có path/`*`, resource không tồn tại ⇒ 400; tenant_admin gán resource `admin` ⇒ 403; sau PATCH `allowedCorsOrigins` CORS `/token` nhận origin mới, từ chối origin cũ; disable ⇒ `/token` client đó `invalid_client`, AT đã cấp ⇒ `/introspect` `active:false`, `/authorize` trang lỗi, enable lại ⇒ hoạt động; disable client của chính token ⇒ 409; pending consent context + gỡ redirect_uri rồi POST approve ⇒ không 302 tới URI cũ, không mint code (mutation bỏ check ⇒ RED); audit đúng action, metadata không key bí mật.

### Task 3 [BE] — chỉnh
- `GET /admin/clients/:clientId/secrets` (metadata `version, createdAt, expiresAt, revokedAt, status` = active|grace|expired|revoked); `POST .../secrets` (không còn credential hiệu lực ⇒ `createSecret` + `CLIENT_SECRET_CREATED`; còn ⇒ `rotateSecret` + `CLIENT_SECRET_ROTATED`); `DELETE .../secrets/:version` (`revokeSecret`; version không phải int dương ⇒ 400; không khớp/đã revoke ⇒ 404; `CLIENT_SECRET_REVOKED`). Tái dùng `ClientCredentialService` nguyên trạng (+ `listMetadata`/`hasActive` nếu cần, projection không `secretHash`).
- Tenant: lookup client qua repo `{clientId, tenantId}` trước (404) rồi mới chạm credentials. Client `public` ⇒ 400. Client disabled vẫn rotate/revoke được (phục hồi sự cố).
- Response POST: `{clientId, version, clientSecret}` + `Cache-Control: no-store` + `Pragma: no-cache`; plaintext không vào audit/log/exception message.
- Revoke secret không thu hồi token đã cấp (chỉ chặn auth mới) — ghi rõ trong mô tả OpenAPI.
- **Acceptance (bổ sung)**: như cũ + cross-tenant 404; grace không sleep (env test `CLIENT_SECRET_GRACE_TTL` nhỏ hoặc chỉnh `expiresAt` trực tiếp); GET secrets không chứa `$argon2`; log toàn suite không chứa plaintext đã cấp.

### Task 4 [BE] — chỉnh
- Resources **global** (spec §10): `GET /admin/resources`, `GET /admin/resources/:resourceId` (`admin.read`, mọi vai trò admin — để chọn `allowedResources`); `POST`, `PATCH` (chỉ `scopes`) yêu cầu `super_admin` (khác ⇒ 403 `forbidden`) + step-up. Bỏ "theo tenant"/"cross-tenant" khỏi task này.
- Create: `validateResourceFormat(identifier)`; `identifier` trùng ⇒ 409 (unique index); `resourceId` trùng ⇒ 409 bằng pre-check (không unique index — DEBT-127; race chấp nhận vì chỉ super_admin). `resourceId` pattern `^[a-z0-9][a-z0-9._-]{0,63}$`; scope item không khoảng trắng, `@ArrayMaxSize(50)`.
- Audit `ADMIN_RESOURCE_CREATED/UPDATED`.
- **Acceptance (thay)**: int CRUD; tenant_admin POST/PATCH ⇒ 403, DB không đổi; identifier fragment/relative ⇒ 400; trùng ⇒ 409; PATCH `identifier`/`resourceId` ⇒ 400; audit đúng.

### Phạm vi
Vừa 1 run sau khi cắt (không super_admin xuyên tenant, không secret-on-create, không DELETE, identifier bất biến, step-up đồng loạt). Nếu Task 2 trượt: tách "disable + decideConsent" sang run 27b, KHÔNG cắt validation/step-up.
