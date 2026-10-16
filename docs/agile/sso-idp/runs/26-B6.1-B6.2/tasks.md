# Tasks — run 26 — B6.1 + B6.2 (M5) + DEBT-098/105/106

> Hiện thực plan §B6 dòng 210–211 (B6.1 admin guard, B6.2 step-up) — spec §9.10 (tenant từ phiên/token, không tin input), §9.11 (control-plane, step-up), INV-24, INV-26, quyết định D3/Q4 (plan dòng 98, §12: `prompt=login`+`max_age`, access token resource `admin` mang `auth_time`, `403 step_up_required`). Kéo debt [BE]: DEBT-098, DEBT-105, DEBT-106 (backlog).
>
> Chưa có endpoint quản trị thật (B6.3 run sau) ⇒ guard/step-up được chứng minh bằng **một endpoint read-only tối thiểu** (vd. `GET /admin/me` trả `{sub, tenantId, roles}`) + controller test-only cho step-up. Seed resource `admin`/client `fe-admin` thuộc B6.4 — test dùng fixture.
>
> Thứ tự: Task 1 → Task 2 (backend-dev); Task 3, 4 độc lập. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop dữ liệu `aegate-*`; int-test dùng `vg-test-*`.

### [x] Task 1 [BE]: B6.1 — Admin guard (INV-24)
- Guard verify access token (JWKS/`TokenVerifier` hiện có, liveness `isAccessTokenLive` như `/userinfo`/`/demo/me`): `aud` = identifier của resource `admin` (tra `Resource`, không hard-code URI), scope `admin.*` theo thao tác, vai trò từ `UserTenant.roles[]` (tra DB, không tin claim/body), tenant suy ra từ token/phiên (`Client.tenantId` của client phát hành + `UserTenant`), **không** đọc `tenantId` từ request.
- Lỗi: thiếu/sai token ⇒ 401 `invalid_token` (+ `WWW-Authenticate`); token resource khác (vd. `demo`) ⇒ 401; thiếu scope/role ⇒ 403 `insufficient_scope`/`forbidden`; `tenant_admin` truy cập tenant khác ⇒ 403/404 không phân biệt tồn tại. Lỗi DB/Redis ⇒ 5xx fail-closed.
- Endpoint chứng minh: `GET /admin/me`.
- **Acceptance**: int-test: token `aud=demo` bị từ chối; user không có role ⇒ 403; `tenant_admin` tenant A không đụng tenant B; logout/tombstone ⇒ 401; mutation bỏ check aud/role/tenant ⇒ RED.

### [x] Task 2 [BE]: B6.2 — Step-up `@RequireRecentAuth(minutes)` (INV-26)
- Decorator + guard đọc `auth_time` trong access token resource `admin` (xác nhận `/token` đã phát `auth_time` cho resource admin theo D3; nếu chưa — bổ sung trong task này). Thiếu/quá hạn ⇒ `403` body `{error:"step_up_required"}` + gợi ý `prompt=login&max_age=0` (header `WWW-Authenticate` theo RFC 9470 nếu phù hợp).
- Kiểm `prompt=login`/`max_age` ở `/authorize` thực sự buộc re-auth và cập nhật `auth_time` (đã có từ B4.1? xác minh; thiếu thì bổ sung).
- **Acceptance**: unit + int: `auth_time` mới ⇒ 200; cũ hơn N phút ⇒ 403 `step_up_required`; thiếu `auth_time` ⇒ 403; đồng hồ lệch/`auth_time` tương lai ⇒ từ chối; re-auth `prompt=login&max_age=0` ⇒ token mới qua được; mutation ⇒ RED.

### [x] Task 3 [BE]: DEBT-098 — `NODE_ENV` không set ⇒ fail-open
- `validation.schema.ts:19` default `development` ⇒ bỏ default (bắt buộc) hoặc default `production`; cập nhật `.env.example`, README, scripts dev/test/E2E/CI để vẫn chạy được.
- **Acceptance**: unit config: thiếu `NODE_ENV` ⇒ (theo lựa chọn tech-lead) app không khởi động hoặc hành xử production (demo tắt); test/E2E/CI vẫn xanh.

### [x] Task 4 [BE]: DEBT-105 + DEBT-106
- DEBT-105: `refresh-token.service.ts` tính `identifiersFor` một lần/refresh, truyền vào rotate.
- DEBT-106: test "fix" trong `seed-dev.int-spec.ts` tự tạo index cũ trước khi kiểm (không phụ thuộc thứ tự).
- **Acceptance**: int refresh xanh, đếm số lần gọi `identifiersFor` = 1 (spy); test DEBT-106 chạy riêng (`-t`) vẫn xanh.

## Câu hỏi cho tech-lead
- Q-26.1: Bộ vai trò (`super_admin`/`tenant_admin`/...) và mapping scope `admin.*` — lấy từ spec/plan ở đâu; chốt tối thiểu cho run này.
- Q-26.2: Ngưỡng step-up mặc định (phút) — env mới hay hằng số theo decorator.
- Q-26.3: DEBT-098 — bắt buộc `NODE_ENV` hay default `production`.

## Fold tech-lead (2026-10-16) — ƯU TIÊN HƠN text cũ ở trên

### Trả lời câu hỏi
- **Q-26.1 (vai trò/scope)**: nguồn = plan D6 (dòng 101). Chốt run này: vai trò admin = `super_admin`, `tenant_admin` trong `UserTenant.roles[]` của **tenant của client phát hành token** (membership `status:'active'`). Scope: `admin.read` cho GET, `admin.write` cho mutation (khai báo theo route bằng decorator, vd. `@AdminScope('admin.read')`). Run này **không** phân biệt quyền `super_admin` vs `tenant_admin` (cả hai chỉ thấy tenant của chính token); quyền xuyên tenant của `super_admin` để B6.3 thiết kế khi có endpoint tenants — KHÔNG làm bây giờ. Không thêm vai trò khác.
- **Q-26.2 (ngưỡng step-up)**: hằng số theo decorator `@RequireRecentAuth(minutes)`, giá trị dùng chung `5` (D3). **Không** thêm env.
- **Q-26.3 (DEBT-098)**: `NODE_ENV` **bắt buộc**, bỏ `.default(...)` (thiếu ⇒ zod fail-fast, app không khởi động, message nêu `NODE_ENV`). Không chọn default `production` (lỗi im lặng khó chẩn đoán ở dev: cookie Secure, chặn http localhost...).

### Task 1 (B6.1) — chỉnh
- **aud admin**: dùng `adminResourceIdentifier(issuer)` (đã có ở `token.service.ts:28`, nguồn duy nhất `/token` dùng để quyết định phát `auth_time`) — KHÔNG tự ghép chuỗi, KHÔNG hard-code. Việc "tra `Resource`" đã do `isAccessTokenLive` làm (client còn `allowedResources` chứa resource có identifier = `aud`); không thêm lookup riêng.
- **Thứ tự guard (fail-closed, lý do mờ)**: (1) `bearerToken(req)` chỉ từ header; (2) `verifier.verifyAccessToken` (RS256, `iss`, `typ=at+jwt`, claim bắt buộc); (3) `aud === adminResourceIdentifier(issuer)`; (4) **bắt buộc có `sid`** (token admin luôn sinh sau B4.7 — thiếu `sid` ⇒ 401, để logout luôn thu hồi được); (5) `isAccessTokenLive(...)` như `/demo/me`. Bước 1–5 sai ⇒ **401** `{error:"invalid_token"}` + `WWW-Authenticate: Bearer error="invalid_token"`. (6) scope route ∈ `claims.scope.split(' ')` else **403** `{error:"insufficient_scope"}` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scope>"`. (7) `tenantId = client.tenantId` của `claims.client_id` (lookup server-side); membership `UserTenant {userId: sub, tenantId, status:'active'}` có ≥1 vai trò ∈ {`super_admin`,`tenant_admin`} else **403** `{error:"forbidden"}` (KHÔNG phân biệt "không là member" vs "không có vai trò"). Lỗi Mongo/Redis ở bất kỳ bước nào ⇒ propagate 5xx (không nuốt thành 401/403).
- **TenantContext**: brand hiện chỉ mint được trong `tenant-context.ts` (`TenantGuard`, từ cookie phiên). Thêm guard token-based **trong cùng file** (vd. `AdminTokenGuard`) để mint `TenantContext { tenantId, userId: sub, sessionRef: sid }` + gắn `roles` (private symbol). KHÔNG export hàm mint/brand. Không dùng cookie phiên cho admin API (bearer, D2).
- Không CORS cho `/admin/*` (fe-admin là BFF, gọi server-to-server). Response `Cache-Control: no-store`.
- `GET /admin/me` → `{sub, tenantId, roles}` (không `sid`, không token). Mount cả ở production (read-only, có guard).
- **Acceptance bổ sung (int-test, `vg-test-*`; fixture: tenant A/B, resource `admin` identifier = `adminResourceIdentifier(ISSUER)`, client confidential tenant A + client tenant B cùng allow `admin`, scope `admin.read`)**:
  - ≥1 happy path đi **luồng thật** `/authorize`→`/token` (không chỉ ký tay) ⇒ 200 `{sub,tenantId:A,roles}`.
  - Token `aud=demo` hợp lệ ⇒ 401; ID token (typ JWT) ⇒ 401; thiếu `sid` (ký tay bằng signer test) ⇒ 401; client bỏ `admin` khỏi `allowedResources` ⇒ 401.
  - Thiếu `admin.read` ⇒ 403 `insufficient_scope`; member A không vai trò ⇒ 403 `forbidden`; membership `suspended` ⇒ 403; user là `tenant_admin` của **B** nhưng token qua client tenant **A** ⇒ 403; gửi `?tenantId=B`, body `tenantId`, header `X-Tenant-Id: B` ⇒ bị bỏ qua (vẫn trả A).
  - Logout phiên phát hành (tombstone) ⇒ cùng token 401.
  - Mongo/Redis lỗi (stub ném) ⇒ 5xx, không 200/401/403.
  - Mutation: bỏ check aud / sid / role / membership tenant / scope ⇒ ≥1 test RED mỗi cái.

### Task 2 (B6.2) — chỉnh (có lỗ hổng thật, PHẢI sửa)
- **Đã có**: `/token` phát `auth_time` (giây) cho resource admin khi code mang `authTime` (`token.service.ts:241`); refresh **không** mang `auth_time` ⇒ token admin từ refresh luôn bị step-up từ chối (fail-closed, đúng D3 — giữ nguyên). `/authorize` đã parse `prompt=login`/`max_age` và trả `login_required`.
- **LỖI phát hiện khi review (bắt buộc sửa trong Task 2)**: khi user **đã có phiên**, `prompt=login`/`max_age` quá hạn ⇒ redirect `/login?returnTo=/authorize?request_id=…` nhưng `GET /login` (`ui.controller.ts:106`) thấy phiên sống ⇒ `redirect('/')` ⇒ luồng step-up **chết** (mất context). Ngoài ra `resume()` (`authorize.service.ts:118`) dựng lại params **không** có `prompt`/`max_age` ⇒ gọi thẳng `/authorize?request_id=X` không đăng nhập lại vẫn được code với `auth_time` cũ (step-up vẫn chặn nhờ `auth_time` cũ, nhưng `max_age` của RP bị vi phạm — OIDC Core §3.1.2.1). Sửa tối thiểu:
  1. `AuthorizeRequestContext` thêm `reauthAfter?: number` (ms epoch = thời điểm tạo context) — chỉ set khi `login_required` do `reauthRequired` (prompt=login hoặc max_age quá hạn).
  2. `GET /login`: phiên sống **và** `returnTo` đúng dạng `/authorize?request_id=<id>` (dùng lại `requestIdFromReturnTo`) **và** `peek(id).reauthAfter` có ⇒ render form đăng nhập (không redirect `/`). Peek lỗi Redis ⇒ giữ hành vi cũ (redirect `/`), không log request_id.
  3. `POST /login` giữ nguyên (`establish` đã rotate phiên ⇒ `authTime` mới).
  4. `resume()`: nếu `ctx.reauthAfter` có và (`session === null` hoặc `session.authTime < ctx.reauthAfter`) ⇒ `AuthorizeRedirectError('login_required')` về RP (context đã consume, single-use, không vòng lặp). Không cấp code.
  5. `max_age=0` ⇒ luôn reauth (`maxAge === 0 || ageSec > maxAge`).
- **Guard step-up** `@RequireRecentAuth(5)` chạy SAU admin guard (401/403 của Task 1 ưu tiên): `auth_time` thiếu / không phải số nguyên / `auth_time > nowSec + 30` (tương lai, lệch đồng hồ) / `nowSec - auth_time > minutes*60` ⇒ **403** `{error:"step_up_required", max_age:0}` + `Cache-Control: no-store`. **Không** gắn `WWW-Authenticate` RFC 9470 (9470 dùng 401 `insufficient_user_authentication`; D3 đã chốt 403 — không trộn). Đồng hồ inject được để test biên (đúng N phút = qua, N phút + 1s = chặn).
- Endpoint chứng minh step-up: controller **chỉ trong int-spec** (như `MembersController` ở `tenant-context.int-spec.ts`), không mount ở `src/`.
- **Acceptance bổ sung**: (a) int luồng thật: phiên có `authTime` cũ (clock inject) ⇒ token admin ⇒ 403 `step_up_required`; `/authorize?...&prompt=login&max_age=0` với cookie phiên sống ⇒ 302 `/login?returnTo=…` ⇒ `GET /login` **200 form** (không 302 `/`) ⇒ `POST /login` ⇒ resume ⇒ code ⇒ token có `auth_time` mới ⇒ 200; (b) gọi thẳng `/authorize?request_id=X` (bỏ qua login) ⇒ redirect `error=login_required`, không code; (c) `GET /login?returnTo=/authorize?request_id=X` với phiên sống mà context KHÔNG có `reauthAfter` ⇒ vẫn 302 `/`; (d) token admin từ refresh grant ⇒ 403 `step_up_required`; (e) mutation: bỏ check `reauthAfter` trong resume / bỏ nhánh `GET /login` / bỏ check tương lai ⇒ RED. Test cũ `authorize.int-spec.ts`, `ui*.int-spec.ts` xanh.

### Task 3 (DEBT-098) — chỉnh
- `NODE_ENV` bắt buộc (bỏ default). Cập nhật: README BE, `e2e` `beEnv()` set `NODE_ENV` tường minh (kiểm lại; E2E chạy hermetic không đọc `be/.env`), workflow CI nếu có job BE. Jest tự đặt `NODE_ENV=test` — xác minh unit/int vẫn xanh.
- `seed-dev`: `assertNotProduction(undefined)` hiện **cho qua** khi thiếu biến ⇒ đổi sang allowlist (`development`|`test`, fail-closed khi unset), cùng tinh thần `isDemoEnabled`.
- Acceptance: unit `envSchema` thiếu `NODE_ENV` ⇒ lỗi nêu `NODE_ENV`; seed-dev unset ⇒ từ chối; int xanh; E2E (`pnpm -C e2e e2e`, hạ tầng hiện có, không compose up) xanh.

### Task 4 (DEBT-105/106) — chỉnh
- DEBT-105: `rotate(value, client, audit, allowedIdentifiers?)` — `refresh()` truyền identifiers đã tính; `rotate` chỉ tự tính khi không được truyền (giữ hợp đồng public). Filter atomic giữ nguyên.
- DEBT-106: test "fix" tự `createIndex({userId:1,clientId:1},{unique:true,name:OLD_CONSENT_INDEX})` (idempotent) trước khi assert; chạy riêng `-t "fix: syncAllIndexes"` xanh.
