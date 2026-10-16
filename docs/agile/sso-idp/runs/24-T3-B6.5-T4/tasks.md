# Tasks — run 24 — T3 + B6.5 + T4 (retry 1 sau REJECT lượt 1)

> Run này hiện thực plan §7 (Phase T: **T3**, **T4**) + §5.5/§214 (Phase B: **B6.5** demo-resource) và INV-8 (plan §9, spec §7). Chỉ các task của run này.
>
> **Retry 1**: tech-lead REJECT lượt 1 (`review-techlead.md`) vì một **blocker ẩn ở BE** — ba chỗ so khớp resourceId (`Client.allowedResources`) với URI (`aud`/`RefreshToken.resource`) khiến token của `fe-sso-test` luôn bị từ chối. Đã thêm **Task 0 [BE]** (ưu tiên cao, **chặn mọi task khác**) + fold các quyết định Q-24.1/2/3 + điểm phụ của tech-lead vào T1/T2/T3. **E2E (T4) tách sang run 25 cùng T5** để giữ run ≤ 5 task (xem "Tách run 25" cuối file).
>
> Thứ tự + phân công: **Task 0 → Task 1** (backend-dev); **Task 2 song song** (frontend-dev); **Task 3** sau 0+1+2; E2E (run 25) sau cùng.

## Bối cảnh đã khảo sát (codebase thực tế)

### Blocker resourceId↔URI (tech-lead chỉ — đã verify lại bằng grep + CodeGraph)
- **Helper mapping đã có sẵn**: `ResourceService.resolveForClient(allowedResourceIds, resourceUri)` (`be/src/modules/resources/resource.service.ts:53`) làm đúng: `validateResourceFormat` → `findByIdentifier(uri)` → so `resource.resourceId ∈ allowedResourceIds`; trả `null` khi URI không phải Resource đã đăng ký hoặc resourceId không thuộc allowlist (**fail-closed**). `findByIdentifier(uri)` (`:39`) trả `Resource|null`. `authorize.service.ts:403` đã dùng helper này đúng (comment `:402` "Map identifier (URI) → resourceId → allowedResources (never compare the URI directly)").
- **Ba chỗ so SAI (URI vs resourceId)** — Task 0 phải sửa:
  1. `access-token-liveness.ts:74` — `!client || !client.allowedResources.includes(claims.aud)` (`claims.aud` = URI).
  2. `refresh-token.service.ts:118` (pre-check) và `:252` (atomic rotate filter) — `resource: { $in: client.allowedResources }` (`RefreshToken.resource` = URI; so với mảng resourceId).
  3. `introspect.controller.ts:157` — `caller.allowedResources.includes(claims.aud)` (authz resource-server gọi `/introspect`).
- **aud/resource lưu URI**: `authorize.service.ts resolveResource` trả `resource.identifier`; `token.service.ts audience: resource` → `aud` = URI; `RefreshToken.resource` = URI. `Client.allowedResources` lưu **resourceId** (spec §7 dòng 174; seed-dev `['demo']`).
- **Repro bằng dữ liệu thật trong DB `sso-idp-e2e`** (tech-lead đã đọc, CHỈ ĐỌC — không FLUSH/drop): client `allowedResources:['demo']`; resource `{resourceId:'demo', identifier:'http://localhost:4000/demo/'}`; refreshtoken `resource:'http://localhost:4000/demo/'`. Với code hiện tại: `'http://localhost:4000/demo/' ∈ ['demo']` = **false** ⇒ `/userinfo` 401, refresh `invalid_grant`, `/introspect` `active:false`, `/demo/me` (tái dùng liveness) 401. ⇒ nhánh 200 của T1/T3/T4 **không thể xanh** nếu không sửa Task 0.
- **Fixture int-test che lỗi** (grep toàn `be/test`): các spec đặt `allowedResources: [RESOURCE]` với `RESOURCE = 'https://api.example.com/'` (URI, KHÔNG phải resourceId) ⇒ `aud === URI === allowedResources[0]` nên test luôn xanh dù code so sai. File + dòng cần sửa:
  - `token.int-spec.ts:44` (`RESOURCE` URI) + `:740`.
  - `refresh-token.int-spec.ts:48` (`RESOURCE` URI), `:363/:372/:381`, `:606/:616`, `:1372`, `:1800`.
  - `userinfo.int-spec.ts:30/31` (`RESOURCE`/`OTHER_RESOURCE` URI), `:132/:139`.
  - `introspect.int-spec.ts:31` (`RESOURCE` URI), `:184/:193/:201/:335/:428/:447`.
  - `session-reflection.int-spec.ts:38` (`RESOURCE` URI), `:201`.
  - *Đã đúng (giữ)*: `authorize.int-spec.ts:130` dùng resourceId `'res-api'`; `clients.int-spec.ts:193` dùng `'res-game-a'`; `seed-dev.int-spec.ts:107` dùng `'demo'`.
- **Mọi nơi khác so `allowedResources`** (grep đầy đủ, KHÔNG phải so sai): `authorize.service.ts:403` (dùng helper — đúng); `token.controller.ts:282` (chỉ truyền xuống refresh service — sẽ đúng sau Task 0); `client.service.ts:23/37/87` + `client.schema.ts:28` (định nghĩa field); `resource.service.ts`/`resource.validator.ts` (mapping/doc); `token-verifier.ts:82` (comment: caller tự enforce `aud ∈ allowedResources`). ⇒ **chỉ 3 call-site cần sửa** + fixture.

### FE / hạ tầng (giữ từ lượt 1)
- **fe-sso-test** (React Router *Data Mode*, `createBrowserRouter` trong `src/router.tsx`): hiện chỉ có route `/` (`routes/Home.tsx`) + `/callback` (`routes/Callback.tsx`). Client OIDC viết tay ở `src/oidc/*` (`client.ts` export `tokens`, `startLogin`, `finishLogin`, `refresh`, `logout`, `consumeLogout`). Token **chỉ in-memory** (`oidc/tokenStore.ts` — closure, không localStorage/cookie/URL). `env.app.ts` đã có `VITE_OIDC_RESOURCE`, cần thêm `VITE_DEMO_API_URL` (plan §80) + `VITE_OIDC_RESOURCE_OTHER` cho resource `other` (Q-24.1).
- **BE** đã có `TokenVerifier.verifyAccessToken` (`be/src/modules/keys/token-verifier.ts`): RS256, `iss`, header `typ=at+jwt`, bắt buộc `exp/iat/sub/jti/client_id/scope`, `aud` đơn — nhưng **KHÔNG pin `aud`** (caller phải tự chốt `aud`). Demo-resource phải tự kiểm `claims.aud === <demo identifier>`.
- **Liveness** dùng chung ở `access-token-liveness.ts` (`isAccessTokenLive`: `sid` tombstone + client còn tồn tại + liveness resource + `sub` tồn tại). `/userinfo` (`userinfo.controller.ts`) gọi nó sau `verifyAccessToken`. `bearerToken()` đang **private** trong `userinfo.controller.ts` (đề xuất tech-lead: tách helper chung).
- **CORS**: per-client động (`client-cors.helper.ts` + `ClientCorsService`), KHÔNG dùng `@fastify/cors`. `applyCors(reply, origin, allowed)` echo đúng `Origin` + `Vary: Origin`, KHÔNG `Allow-Credentials`. `isOriginAllowedForClient(client_id, origin)`. Preflight qua `registerCorsPreflight` + `CORS_PREFLIGHT_PATHS`.
- **Seed**: `be/src/database/seed-dev.ts` `buildSeedDevTargets(issuer)` trả `{client, resource}` (một resource) → upsert client `fe-sso-test` (public, `allowedResources:['demo']`, CORS `http://localhost:5173`) + resource `demo` (`identifier=${base}/demo/`). Idempotent, chặn production (`seedDev` refuse `NODE_ENV=production` trước mọi write).
- **config**: `app.nodeEnv` ở `configuration.ts` do zod default `development` khi `NODE_ENV` không set (⇒ allowlist phải đọc **raw env**, không dùng `!== 'production'` — xem Q-24.2 / DEBT-098).
- **E2E**: `e2e/tests/login.spec.ts` (1 kịch bản login → claims), Playwright 1.64, `webServer` dựng BE (build→seed-dev→start) + FE.

## Quyết định đã chốt (fold từ review tech-lead lượt 1)

- **Q-24.1 — resource `other`: ĐỒNG Ý.** Seed thêm `{resourceId:'other', identifier:'${issuer}/other/', scopes:[]}` + `fe-sso-test.allowedResources=['demo','other']`. **Không** dùng lại `admin`. Token cho `other` xin bằng **luồng authorize thứ 2** (BE bind 1 resource/grant; refresh không đổi resource — INV-12 / `refresh-token.service.ts:125`; không có token exchange). Scope luồng probe = **`openid` duy nhất** (không `offline_access` ⇒ không sinh refresh family mồ côi). ID token probe vẫn validate (nonce/iss/aud) rồi bỏ.
- **Q-24.2 — bật `/demo/me`: ĐỒNG Ý module riêng + allowlist.** Module `DemoModule` (controller `GET /demo/me`), nạp vào `AppModule` bằng `ConditionalModule.registerWhen(DemoModule, (env) => env.NODE_ENV === 'development' || env.NODE_ENV === 'test')` (`@nestjs/config` 12). Dùng **allowlist** đọc raw env (không `!== 'production'`): `NODE_ENV` không set ⇒ **tắt**; E2E/CI `NODE_ENV=test` ⇒ bật. Phòng thủ chiều sâu: controller đọc `app.nodeEnv`, nếu `production` ⇒ 404 (có test). CORS preflight: **không** hard-code `/demo/me` vào `CORS_PREFLIGHT_PATHS`; mở rộng `registerCorsPreflight(fastify, cors, extraPaths?: ReadonlySet<string>)`; `main.ts` chỉ truyền `/demo/me` khi demo bật (hàm chung `isDemoEnabled(env)` dùng cho cả module và main). Nhánh 200 ⇒ ACAO theo **client của token** (`isOriginAllowedForClient(claims.client_id, origin)`); nhánh lỗi ⇒ union.
- **Q-24.3 — `/tokens`: ĐỒNG Ý.** Chỉ hiển thị **metadata** (có/không access/ID/refresh, đếm ngược `accessTokenExpiresAt`) + claims ID token đã decode. **Không** render chuỗi token thô, **không** decode payload access token. `Session` không có `token_type` ⇒ bỏ hoặc hiển thị hằng `Bearer`; không thêm field vào `Session` chỉ để hiển thị.
- **Điểm phụ đã chốt**: scope ở `/demo/me` = **không** đòi (demo `scopes:[]`), không nhánh 403, nhưng claim `scope` vẫn bắt buộc (do verifier). Tombstone `sid`: logout (`sess_end:{ref}`) ⇒ cùng AT gọi `/demo/me` **401 ngay** (bắt buộc int test; AT pre-B4.7 không có `sid` sống tới `exp` — DEBT-048 chấp nhận). FE `/demo/me`: `fetch` header `Authorization: Bearer <AT in-memory>`, **`credentials:'omit'`**, `cache:'no-store'`, timeout `AbortController` 10s, lỗi mạng/CORS ⇒ panel "network error" không crash. `returnTo` validate chặt (xem Task 2). Luồng không mất phiên chính = **redirect chuỗi** (xem Task 3). Revoke refresh cũ trước khi chuyển trang (best-effort). `/demo/me` body 200 **không** chứa `sid` (DEBT-047).

---

### [x] Task 0 [BE]: Sửa so khớp resourceId (`allowedResources`) vs URI (`aud`/`RefreshToken.resource`) — fail-closed (ƯU TIÊN CAO, CHẶN MỌI TASK KHÁC)
- **Mô tả**: Ba call-site đang so URI trực tiếp với mảng resourceId (xem "Blocker" ở trên). Chuẩn hoá: `allowedResources` = **resourceId** (spec §7); mọi so với `aud`/`resource` (URI) phải **resolve qua `Resource`** (tra theo `identifier`). Tái dùng pattern `ResourceService` (đã có `resolveForClient`/`findByIdentifier`). KHÔNG chấp nhận cả hai dạng (mập mờ ⇒ confused deputy giữa id và URI).
  1. **Liveness** (`access-token-liveness.ts:74`): thêm tham số `ResourceLookup` (hoặc nhận `resourceIdOf(aud)`); live khi `resourceIdOf(claims.aud) ∈ client.allowedResources`. `aud` không map được Resource ⇒ **không live** (fail-closed).
  2. **Refresh** (`refresh-token.service.ts:118` pre-check + `:252` atomic rotate): thay `$in: client.allowedResources` bằng `$in:` **identifiers** của các resourceId được phép — 1 query `resources.find({ resourceId: { $in: client.allowedResources } })` → map sang `identifier[]` → dùng trong filter `resource`. Giữ tính nguyên tử của rotate filter (INV-14).
  3. **Introspect caller authz** (`introspect.controller.ts:157`): caller "được xem" token khi `claims.client_id === caller.clientId` (kiểm trước, không I/O) **hoặc** `claims.aud ∈ identifiersOf(caller.allowedResources)`. *(Tech-lead lượt 2)* Giữ bất biến anti-oracle DEBT-040 ("không I/O phụ thuộc nội dung token trước khi authz"): tra Resource theo **resourceId của caller** (`find({resourceId:{$in: caller.allowedResources}})`), KHÔNG `findByIdentifier(claims.aud)` trước khi caller được authz. Có thể dùng chung helper `identifiersFor(resourceIds)` với refresh (2).
  - **Wiring**: `ResourcesModule` đã được `OauthModule` import (`oauth.module.ts:30`) ⇒ inject `ResourceService` vào `UserinfoController`/`IntrospectController`/`RefreshTokenService`, không cần module mới. Cập nhật chữ ký `isAccessTokenLive` ở mọi caller, gồm call trực tiếp trong test `refresh-token.int-spec.ts:1374`.
  - **Fail-closed hạ tầng**: Mongo lỗi khi tra Resource ⇒ **propagate 5xx**, KHÔNG nuốt thành `false`/`true`. Resource không tồn tại hoặc bị đổi identifier ⇒ không live / `invalid_grant` / `active:false`.
  - **`resourceId` không unique (DEBT-077)**: mapping lấy **mọi** identifier khớp các resourceId được phép; không mở quyền ra ngoài tập resourceId trong `allowedResources`.
  - **Sửa fixture int-test** đang ghi URI vào `allowedResources` sang **resourceId + tạo `Resource` tương ứng** (`{resourceId, identifier}`): `token.int-spec.ts`, `refresh-token.int-spec.ts`, `userinfo.int-spec.ts`, `introspect.int-spec.ts`, `session-reflection.int-spec.ts` (dòng đã liệt kê ở "Blocker"). KHÔNG giữ chế độ chấp nhận cả hai dạng. (Giữ nguyên các spec đã đúng: `authorize.int-spec.ts:130`, `clients.int-spec.ts`, `seed-dev.int-spec.ts:107`.)
- **Repro (dữ liệu thật, trước khi sửa)**: với DB `sso-idp-e2e` (refreshtoken `resource='http://localhost:4000/demo/'`, client `allowedResources=['demo']`): refresh ⇒ `invalid_grant`; `/userinfo` ⇒ 401; `/introspect` ⇒ `active:false`. Nguyên nhân: `'http://localhost:4000/demo/' ∈ ['demo']` = false.
- **Acceptance (đo được)**:
  - (a) **Dương, client seed-dev thật**: client + resource tạo **từ `buildSeedDevTargets(issuer)`** (không viết tay fixture — để test đi đúng dữ liệu seed), int test end-to-end code→token→`/userinfo` **200** → refresh **200** (successor có `resource=${issuer}/demo/`) → `/introspect` **`active:true`**, aud/resource = `${issuer}/demo/`. *(Lượt 2)* `fe-sso-test` là **public** ⇒ không gọi được `/introspect` (`invalid_client`); caller introspect = một client **confidential** "resource server" `allowedResources:['demo']`, `clientId` ≠ `fe-sso-test` ⇒ đi đúng nhánh mapping (3), không đi tắt bằng `client_id === caller`.
  - (b) **Âm**: xoá `'demo'` khỏi `allowedResources` của `fe-sso-test` ⇒ `/userinfo` **401**, refresh **`invalid_grant`** (doc KHÔNG đổi, family KHÔNG revoke — giữ hành vi `refresh-token.int-spec.ts:604`), `/introspect` (caller RS) **`active:false`**. *(Lượt 2)* (b2) caller RS confidential có `allowedResources:['other']` (không `demo`) introspect AT `aud=/demo/` ⇒ **`active:false`** và **không** gọi `users.exists`/`sessions.isEnded` (spy, giữ DEBT-040).
  - (c) **Dữ liệu sai**: `allowedResources` chứa **URI** (`'http://localhost:4000/demo/'`) ⇒ **không live** (không fail-open) vì URI không là resourceId của Resource nào; refresh ⇒ `invalid_grant`; caller RS có URI trong `allowedResources` ⇒ `active:false`.
  - (d) **Mutation**: hoàn tác mapping ở **từng** call-site (liveness / refresh pre-check+rotate / introspect authz) ⇒ ít nhất một test (a)/(b2) chuyển **RED** cho mỗi call-site. Ghi kết quả mutation vào báo cáo dev.
  - (e) *(Lượt 2)* **Fail-closed khi Mongo lỗi** (đo được): unit test với `ResourceLookup`/`ResourceService` ném lỗi ⇒ `isAccessTokenLive` **reject** (không trả `false`/`true`); `/userinfo` ⇒ **5xx**, `/introspect` ⇒ **500 `{error:'server_error'}`** (không `active:false`), refresh ⇒ **5xx** (không `invalid_grant`, không rotate: doc `revokedAt` vẫn `null`). Body không lộ chi tiết lỗi.
  - Grep xác nhận không còn `allowedResources.includes(<URI>)` / `$in: ...allowedResources` so trực tiếp với URI ngoài 3 chỗ đã sửa.
  - `pnpm -C be test` + `test:int` xanh (int cần `vg-test-mongo@27117`/`vg-test-redis@6479`; KHÔNG drop/FLUSH).
- **Security invariants**:
  - *Tài sản*: ranh giới resource server (INV-8/INV-14). *Actor*: client giữ resourceId X; attacker trình token `aud` = identifier của resource Y (Y ∉ allowedResources).
  - *Invariant*: token chỉ được chấp nhận ở resource mà `resourceIdOf(aud) ∈ allowedResources`. `resourceId` ≠ URI — KHÔNG so URI trực tiếp (chống confused deputy).
  - *Trust boundary / state*: input = `aud` (URI) từ token đã verify sig → tra `Resource` (Mongo) → so resourceId. Refresh: filter rotate nguyên tử, mapping resourceId→identifier trước khi query.
  - *Abuse/failure*: `aud` = URI của resource khác (IDOR cross-resource) ⇒ từ chối; Resource bị xoá/đổi identifier ⇒ fail-closed; Mongo down ⇒ 5xx (không nuốt thành true/false); duplicate resourceId (DEBT-077) ⇒ không leo quyền.
  - *Exposure budget*: KHÔNG log URI/resourceId của token ở mức lộ PII; lỗi vẫn opaque (401/`invalid_grant`/`active:false` không nêu "sai aud").
- **Phụ thuộc**: KHÔNG (chạy đầu tiên). **Chặn**: Task 1, Task 3, E2E (run 25).
- **§ trỏ**: plan §9 (INV-8/INV-14), §288; spec §7 (resourceId↔identifier); `resource.service.ts`.

### [x] Task 1 [BE]: demo-resource `GET /demo/me` (chỉ dev/test), seed resource `other`
- **Mô tả**: Module riêng **`DemoModule`** (`be/src/modules/demo/`, controller `GET /demo/me`) — plan §214 B6.5, D5. `GET /demo/me`:
  1) lấy access token **chỉ** từ `Authorization: Bearer` (không query/body) — dùng helper `bearerToken()` tách chung (đề xuất tech-lead: tách khỏi private trong `userinfo.controller.ts` để tránh 2 regex lệch);
  2) `verifyAccessToken` (RS256, `iss`, `typ=at+jwt`, required claims gồm `scope`) → lỗi: 401 `invalid_token` (opaque);
  3) **kiểm `aud` đầy đủ**: `claims.aud === '${issuer}/demo/'` (demo identifier) — khác: 401 `invalid_token`;
  4) **KHÔNG đòi scope riêng** (demo `scopes:[]`) ⇒ không có nhánh 403 `insufficient_scope`; claim `scope` vẫn bắt buộc (verifier lo). (Bỏ bước "nếu chốt cần quyền" ở lượt 1.)
  5) `isAccessTokenLive` (tái dùng, đã sửa Task 0: `sid` tombstone + client còn + `resourceIdOf(aud) ∈ allowedResources` + `sub` tồn tại) → `false` ⇒ 401; lỗi hạ tầng ⇒ **5xx** (fail-closed);
  6) 200 trả claims an toàn (`sub`, `aud`, `scope`, `client_id`, `exp`, `iat`, `jti`) — **KHÔNG** `sid` (DEBT-047), KHÔNG token thô; header `Cache-Control: no-store`; lỗi kèm `WWW-Authenticate: Bearer error="invalid_token"`.
  - **Wiring (Q-24.2)**: nạp `DemoModule` qua `ConditionalModule.registerWhen(DemoModule, (env) => env.NODE_ENV==='development' || env.NODE_ENV==='test')` trong `AppModule` (allowlist đọc **raw env**; `NODE_ENV` không set ⇒ tắt). Hàm chung `isDemoEnabled(env)` dùng cho cả module và `main.ts`. Phòng thủ chiều sâu: controller đọc `app.nodeEnv`, nếu `production` ⇒ 404.
  - **CORS (Q-24.2)**: mở rộng `registerCorsPreflight(fastify, cors, extraPaths?: ReadonlySet<string>)`; `main.ts` chỉ truyền `/demo/me` khi `isDemoEnabled(env)`. **Không** hard-code `/demo/me` vào `CORS_PREFLIGHT_PATHS`. Nhánh 200 ⇒ ACAO theo `isOriginAllowedForClient(claims.client_id, origin)`; nhánh lỗi ⇒ union allowlist.
  - **Seed (Q-24.1)**: mở rộng `buildSeedDevTargets(issuer)` để thêm resource `other` (`resourceId:'other', identifier:${base}/other/, scopes:[]`) + `allowedResources=['demo','other']`. `seedDev` upsert idempotent cả 2 resource.
- **Acceptance (đo được)**:
  - `NODE_ENV=development` (demo bật): token hợp lệ `aud=${issuer}/demo/` → **200** + `sub` khớp người đăng nhập, `aud='${issuer}/demo/'`; header `Cache-Control: no-store`; body KHÔNG chứa `sid`.
  - Token `aud=${issuer}/other/` (hoặc aud ≠ demo) → **401 `invalid_token`** + `WWW-Authenticate` (INV-8).
  - Thiếu / malformed / expired / `typ=JWT` (ID token) / `alg!=RS256` → **401 `invalid_token`**, không lộ lý do.
  - **Logout rồi dùng lại cùng AT**: sau `sess_end:{ref}` (tombstone `sid`) ⇒ `/demo/me` **401 ngay**, không đợi `exp` (int test bắt buộc).
  - **Hạ tầng lỗi** (Mongo/Redis) ⇒ **5xx**, body KHÔNG lộ chi tiết.
  - **`NODE_ENV=test`** ⇒ demo **bật** (E2E/CI); **`NODE_ENV` không set** ⇒ `GET /demo/me` **404** (allowlist, không fail-open); `NODE_ENV=production` ⇒ **404**.
  - Preflight: demo bật ⇒ `OPTIONS /demo/me` từ `Origin: http://localhost:5173` → **204** + ACAO=origin + `Vary: Origin`; origin khác ⇒ không ACAO. **Demo tắt ⇒ không có preflight 204** cho `/demo/me`.
  - `db:seed-dev` chạy **2 lần**: đúng **2** resource (`demo`+`other`), `fe-sso-test.allowedResources=['demo','other']` (không trùng). Cập nhật `seed-dev.int-spec.ts:107`.
  - Unit/int test cho từng nhánh; `pnpm -C be test` + `test:int` xanh.
- **Security invariants**:
  - *Tài sản*: claims người dùng (PII qua `sub`), biên giới resource server. *Actor*: owner (token đúng aud), attacker (token sai aud / token resource khác / ID token / token revoked / anonymous).
  - *Invariant*: **INV-8** — access token chỉ được chấp nhận ở resource khớp `aud`; token cho `other` KHÔNG được dùng ở `/demo/me`. Demo-resource verify đầy đủ `iss/aud/exp/sig` (không tin token tự khai).
  - *Trust boundary / state*: input = `Authorization` header → verify JWS (JWKS hiện hành) → chốt `aud` → liveness (Redis tombstone + Mongo client/user) → 200. `exp` hết hạn ⇒ 401 (không phục vụ sau hết hạn).
  - *Abuse/failure*: expired/revoked/replay (sid tombstone), token resource khác (IDOR qua aud), ID token confusion (`typ`), `alg=none/HS*`; hạ tầng down ⇒ **fail-closed 5xx** (không 200). Chặn production ⇒ không mở bề mặt tấn công ở prod.
  - *Exposure budget*: KHÔNG log/echo token thô, không PII trong header/log; 401 opaque (không "sai aud" vs "hết hạn").
- **Phụ thuộc**: **Task 0** (liveness/mapping đã sửa — tái dùng `isAccessTokenLive`), B4.4/B4.6 + `verifyAccessToken` (đã có). **Chặn bởi Task 0.** backend-dev làm Task 0 → Task 1.
- **§ trỏ**: plan §214 (B6.5), §100 (D5), §288 (INV-8); spec §7, §11.

### [x] Task 2 [FE]: Route & guard mới (`/login`, `/profile`, `/tokens`, `/api-test`, `/logout`, error page)
- **Mô tả** (plan §257 T3): bổ sung vào `createBrowserRouter`:
  - `/` — trạng thái đăng nhập (giữ Home hiện có, thêm link điều hướng).
  - `/login` — gọi `startLogin()`, giữ **trang đích ban đầu** qua `returnTo` **đi qua transient** (sessionStorage), **không qua `state`**.
  - `/callback` — hiện `redirect("/")` cứng ⇒ đổi sang redirect tới `returnTo` **đã validate** (mặc định `/`).
  - `/profile` — hiển thị **claims ID token đã decode** (`sub/iss/aud/exp/nonce/…`), `data-testid`.
  - `/tokens` — **chỉ metadata**: có/không access/ID/refresh, **đếm ngược** đến `accessTokenExpiresAt`; `token_type` **bỏ hoặc hằng `Bearer`** (`Session` không có field này — KHÔNG thêm field). KHÔNG render chuỗi token thô, KHÔNG decode payload access token (Q-24.3).
  - **`returnTo` chống open-redirect (chốt)**: chỉ nhận chuỗi bắt đầu `/`, **không** `//` / `/\`, không chứa `\`, ký tự điều khiển hay scheme; và `new URL(v, location.origin).origin === location.origin`. Validate **cả khi ghi lẫn khi đọc** (transient là input không tin cậy). Sai ⇒ `/`.
  - `/api-test` — khung cho T4 (nút gọi API, chỗ hiển thị kết quả).
  - `/logout` — gọi `logout()` → redirect IdP end-session.
  - **Trang lỗi** hiển thị `error`/`error_description` từ IdP **nhưng KHÔNG echo nguyên văn** (DEBT-080 đã đóng ở run 22): map `error` sang thông điệp an toàn, chỉ hiện `error` code + mô tả rút gọn/được kiểm soát.
  - **Route guard**: trang cần đăng nhập (`/profile`, `/tokens`, `/api-test`) khi `tokens.get() === null` → redirect `/login?returnTo=<path>`.
- **Acceptance (đo được)**:
  - Chưa đăng nhập, mở `/profile` → điều hướng `/login` (giữ `returnTo=/profile` qua transient); sau login quay lại `/profile`.
  - `/profile` hiển thị đúng `sub/iss/aud/exp` của phiên (so khớp `session.claims`).
  - `/tokens`: hiển thị đếm ngược giảm dần; **không** có chuỗi token thô trong DOM (test: `document.body.innerHTML` không chứa `session.accessToken`/`refreshToken`/`idToken`).
  - Trang lỗi: với `?error=access_denied` hiển thị mã `access_denied` + mô tả kiểm soát; **không** render nguyên văn `error_description` tùy ý từ query.
  - **Unit test bảng `returnTo`** (validate khi ghi + khi đọc): `https://evil`, `//evil`, `/\evil`, `javascript:…`, `/%2F%2Fevil`, chuỗi có ký tự điều khiển ⇒ `/`; `/profile?x=1` ⇒ giữ nguyên.
  - `pnpm -C fe-sso-test test` xanh (guard + token-metadata + không-lộ-token + `returnTo`).
- **Security invariants**:
  - *Tài sản*: token in-memory, PII claims. *Actor*: anonymous (truy cập trang bảo vệ), attacker (nhồi `error_description` XSS/open-redirect qua query/`returnTo`).
  - *Invariant*: token KHÔNG rời in-memory (không DOM/localStorage/URL — Q-24.3); guard chặn anonymous vào trang bảo vệ (fail-closed → redirect login).
  - *Trust boundary*: `error`/`error_description`/`returnTo` là **input không tin cậy** từ URL → KHÔNG echo thô (chống reflected XSS/DEBT-080); `returnTo` chỉ nhận **path nội bộ** (bắt đầu `/`, không `//`, không scheme) để chống open-redirect.
  - *Abuse/failure*: `error_description` chứa HTML/script → render dạng text đã map; `returnTo=https://evil` → bỏ qua, về `/`.
  - *Exposure budget*: token thô, `code`, `state` không xuất hiện trong DOM/URL/console.
- **Phụ thuộc**: client OIDC `src/oidc/*` (đã có). **KHÔNG** chặn bởi Task 0/1 ⇒ **frontend-dev làm song song** với backend-dev.
- **§ trỏ**: plan §257 (T3), §9.6/§80; spec §11; DEBT-080 (run 22 summary).

### [x] Task 3 [FE]: T4 — gọi resource thật + sai `aud` + userinfo, hiển thị pass/fail + INV-8
- **Mô tả** (plan §258 T4) trên `/api-test`:
  - **Nút A — gọi `/demo/me`**: `fetch(VITE_DEMO_API_URL + '/demo/me', { Authorization: Bearer <access token hiện tại, aud=demo> })` → kỳ vọng **200**, hiện claims trả về.
  - Nút A dùng `fetch(..., { credentials:'omit', cache:'no-store', signal: AbortController 10s })`; lỗi mạng/CORS/timeout ⇒ panel "network error", không crash.
  - **Nút B — sai `aud` (luồng redirect chuỗi, KHÔNG mất phiên chính)** (Q-24.1 + câu hỏi phụ):
    1. Trước khi chuyển trang: gọi `/revoke` cho refresh token hiện tại (**best-effort**; lỗi vẫn tiếp tục) để không bỏ lại family mồ côi.
    2. Tạo transient `{purpose:'aud-probe', returnTo:'/api-test', …}` (validate `returnTo`) rồi `/authorize?resource=${issuer}/other/&scope=openid` (**chỉ `openid`**). Cookie IdP còn ⇒ không login lại; lần đầu có consent `other`.
    3. `/callback` thấy `purpose='aud-probe'`: đổi code, validate ID token (nonce/iss/aud), gọi `/demo/me` bằng AT `other`, ghi **chỉ** `{status, expected:401, aud}` vào `sessionStorage` key `oidc:probe_result` (KHÔNG token); bỏ token probe khỏi bộ nhớ.
    4. Ngay sau đó `startLogin({prompt:'none', returnTo:'/api-test'})` resource `demo` + scope gốc để **dựng lại phiên chính**. `login_required`/`consent_required`/`interaction_required` ⇒ login tương tác (fail-closed, **tối đa 1 lần `prompt=none` mỗi probe**, không vòng lặp).
    5. `/api-test` đọc rồi **xoá** `oidc:probe_result` (một lần) để hiển thị **PASS 401**.
  - **Nút C — `userinfo`**: `GET /userinfo` bằng AT (scope `openid`) → **200** claims (cũng là chốt hồi quy Task 0).
  - Mỗi nút hiển thị **pass/fail** (theo **status code kỳ vọng**, không tin "giải thích" server) + ô giải thích ngắn **INV-8**.
- **Acceptance (đo được)**:
  - Nút A: HTTP **200**, panel "PASS", `sub` khớp `/profile`.
  - Nút B: sau khi hoàn tất vẫn **ở `/api-test`**, **vẫn đăng nhập cùng `sub`** như trước; panel B "**PASS 401**"; `sessionStorage` KHÔNG chứa token và `oidc:probe_result` **đã bị xoá** sau khi hiển thị. Callback với `purpose` lạ/thiếu ⇒ xử lý như login thường, **không** gọi `/demo/me`.
  - Nút C: HTTP **200**, hiện ít nhất `sub` (chốt hồi quy Task 0).
  - Response/claims hiển thị là **metadata/claims đã decode**, không chuỗi token thô.
  - `pnpm -C fe-sso-test test` xanh (mock fetch + transient/`prompt=none` cho 3 nhánh).
- **Security invariants**:
  - *Tài sản*: access token in-memory; biên giới cross-origin (FE :5173 → BE :4000). *Actor*: owner (demo thật), và **minh hoạ attacker** (token sai aud).
  - *Invariant*: **INV-8** quan sát được từ phía RP — token `aud=other` KHÔNG mở được `/demo/me`. Token truyền qua header `Authorization`, không qua URL/body/log.
  - *Trust boundary*: FE đọc status code + body JSON (an toàn) từ BE; không tin "giải thích" do server trả — pass/fail tính bằng **status code kỳ vọng**.
  - *Abuse/failure*: nếu CORS chặn (origin sai) → hiện lỗi mạng, không crash; token `other` phải thực sự được IdP cấp (nếu IdP từ chối cấp `resource=other` thì ghi nhận là blocker, báo tech-lead — fail-closed).
  - *Exposure budget*: không in token thô ra DOM/console; chỉ status + claims decode.
- **Phụ thuộc**: **Task 0** (userinfo/demo-me xanh) + **Task 1** (demo-resource + resource `other`) + **Task 2** (route `/api-test` + `returnTo`). CHẶN bởi cả ba. frontend-dev làm sau khi 0+1+2 xong.
- **§ trỏ**: plan §258 (T4), §288 (INV-8), §100 (D5); spec §7.

### [x] Task 4 [BE]: DEBT-100 — consent 500 cho resource phụ (`other`) do index `consents` cũ còn sót
- **Mô tả**: FE smoke live phát hiện `POST /authorize/consent` cho `other` ⇒ **500**. Nguyên nhân gốc (đã xác minh đọc index DB dev, CHỈ ĐỌC): DB dev `sso-idp` deploy TRƯỚC DEBT-028 nên còn **index unique cũ** `userId_1_clientId_1` trên `consents` (chưa chạy `db:sync-indexes`). User đã consent `demo` rồi consent `other` (cùng user×client) ⇒ vi phạm key cũ ⇒ E11000 dai dẳng (retry-once của `grant` không giải được vì không phải composite key) ⇒ `decideConsent` ném non-`AuthorizeRedirectError` ⇒ controller 500. Code + schema đã đúng; `syncAllIndexes()`/`db:sync-indexes` DROP index cũ (đã cover index-layer ở `indexes.int-spec.ts`). Khắc phục DB dev: chạy `pnpm -C be db:sync-indexes`. Int-test cũ che lỗi vì luôn `syncAllIndexes` trên DB sạch.
- **Acceptance (đo được)**:
  - Int-test tái hiện ĐÚNG controller-level: tạo index cũ `userId_1_clientId_1` → consent `demo` rồi `other` ⇒ **500** (RED repro).
  - Sau `syncAllIndexes` (= `db:sync-indexes`): index cũ bị DROP, consent `other` ⇒ **302** có `code` (GREEN).
  - Chuỗi INV-8: `/token` đổi code `other` ⇒ access token `aud=${issuer}/other/`; `GET /demo/me` bằng token đó ⇒ **401 `invalid_token`**.
  - typecheck/lint PASS; `pnpm -C be test` 205, `test:int` 502 (499 + 3) — không regress. Mutation (`syncIndexes`→`ensureIndexes`) ⇒ test "fix" RED; khôi phục byte-identical (sha256 khớp).
- **Security invariants**: *Tài sản*: bản ghi consent (user×client×resource), biên giới resource-server. *Invariant*: INV-8 — token `aud=other` KHÔNG mở `/demo/me`. *Failure*: hạ tầng/E11000 KHÔNG âm thầm thành success — propagate (fail-closed, 500 quan sát được, không lộ secret). *Resource thứ N*: index cũ làm hỏng MỌI resource ≥2 cùng user×client; seed chỉ 2 resource (`demo`,`other`) nên không resource nào khác bị cùng lớp lỗi.
- **File**: `be/test/seed-dev.int-spec.ts` (+3 test, +import `DemoController`/`SESSION_COOKIE`). KHÔNG sửa source (code đã đúng).
- **§ trỏ**: DEBT-100/DEBT-028; plan §288 (INV-8), §214 (B6.5); spec §7.

---

## Tách run 25 (đề xuất — giữ run 24 ≤ 5 task)

Run 24 giờ có **4 task** (0,1,2,3). **E2E (T4) + T5 tách sang run 25** vì: (a) E2E chỉ chạy được **sau khi** Task 0–3 PASS (browser thật phụ thuộc toàn bộ luồng); (b) gộp vào run 24 sẽ >5 task và trộn tầng FE/E2E; (c) E2E mở rộng khá lớn (chặn mọi response `/token` gồm probe + khôi phục).

**Run 25 (T4 E2E + T5)** — orchestrator mở sau khi run 24 PASS:
- **[E2E]** Thêm spec `e2e/tests/demo-resource.spec.ts` (hoặc nối `login.spec.ts`): login → `/profile` (claims đúng) → `/api-test`: Nút A ⇒ `/demo/me` **200**; Nút B (redirect chuỗi) ⇒ panel "PASS 401"; **Nút C** ⇒ `/userinfo` **200** (chặn hồi quy Task 0). Dùng `webServer` + seed-dev hiện có (đã có resource `other`).
  - Lấy secrets bằng cách **chặn MỌI response `/token`** (gồm luồng probe + luồng khôi phục `prompt=none`), không chỉ response đầu. Xử lý consent `other` **có thể có hoặc không** (lần chạy thứ 2 đã có consent).
  - Assert sau Nút B: `sub` ở `/profile` **trùng** trước đó (phiên chính dựng lại). Không chuỗi access/refresh token trong `page.content()`/`localStorage`/`sessionStorage`. Log E2E không chứa `code`/`state`/cookie/token (giữ run 23). KHÔNG drop/FLUSH (`aegate-mongo` DB `sso-idp-e2e`, `aegate-redis` `/2`).
  - Không flaky 2 lần chạy liên tiếp. Nếu Playwright không bắt được nhánh B ⇒ hạ smoke (A+C) và ghi DEBT, báo tester.
- **T5**: theo plan §7 (orchestrator xác định phạm vi khi mở run 25).

## Nợ kỹ thuật ghi nhận (tech-lead, đưa vào backlog)
- **DEBT-098**: `NODE_ENV` không set ⇒ zod default `development` (fail-open toàn hệ thống) — Task 1 chống cục bộ bằng allowlist raw env; cần fix gốc.
- **DEBT-099**: popup/BroadcastChannel cho token resource phụ mà không phải dựng lại phiên (thay cho redirect chuỗi) — hoãn.
- Đề xuất không bắt buộc (tech-lead): tách `bearerToken()` khỏi private `userinfo.controller.ts` thành helper chung cho `/userinfo` + `/demo/me` — đã fold vào Task 1.
- Xác nhận cách thêm `/demo/me` vào CORS: dùng `CORS_PREFLIGHT_PATHS` hiện có (mở rộng set) hay hook preflight riêng cho demo-resource (giữ demo tách khỏi path OAuth production).