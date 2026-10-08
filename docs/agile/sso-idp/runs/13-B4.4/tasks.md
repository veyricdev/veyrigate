# Tasks — run 13 — B4.4 (`/token` grant `authorization_code`)

> Mốc **M3** (walking skeleton). Phạm vi: plan.md §B4.4 (bảng Phase B), spec §8 (token contract), §9.2/§9.3/§9.5 (flow + client auth + consume), §10 (schemas). Quyết định liên quan: **D3** (auth_time cho resource admin), **D7** (refresh chỉ khi grant `refresh_token` **VÀ** scope có `offline_access`), **Q4** (thêm `grantTypes[]` vào `Client`), **Q6** (TTL — đã chốt plan.md §12).
>
> **Ranh giới B4.4 ↔ B4.5 (chốt rõ)**: B4.4 **phát hành** access/id/refresh token và **lưu RefreshToken tối thiểu** (`tokenHash`, `familyId` mới, `parentId=null`, bind `clientId/scope/resource/userId`, `expiresAt`). B4.4 **KHÔNG** làm rotation, reuse-detection, atomic `findOneAndUpdate`, revoke family, `/revoke`, hay refresh **grant** (dùng refresh để lấy token mới) — tất cả là **B4.5**. `RefreshTokenSchema` (B4.5-ready) đã tồn tại; B4.4 chỉ insert.

---

### [x] Task 1 [BE]: Thêm `grantTypes[]` vào `Client` + đọc Q6 TTL từ config
- Mô tả: Thêm field `grantTypes: { type: [String], default: ['authorization_code'] }` vào `ClientSchema` và expose qua `ClientService.Client` type (D7/Q4). Xác nhận `TokenConfig.accessTokenTtl`/`refreshTokenTtl` đọc được qua `ConfigService.get('token')` (đã có — không thêm env mới).
- Acceptance:
  - Client mới mặc định `grantTypes === ['authorization_code']`; test đọc lại 1 client seed `['authorization_code','refresh_token']` trả đúng mảng.
  - `ClientService` trả `grantTypes` trong type `Client`; build TS sạch (`pnpm.cmd -C be build`).
  - `ConfigService.get('token').accessTokenTtl` = 900 và `.refreshTokenTtl` = 2592000 với env test; không có literal TTL hard-code trong code B4.4 (grep assert).
  - *(tech-lead fold)* `ClientService.findByClientId` dùng `.lean()` → **Mongoose default KHÔNG áp** cho doc cũ. Chuẩn hoá trong `ClientService` (vd. `grantTypes ?? ['authorization_code']`) để mọi caller nhận mảng; test: insert raw (`collection.insertOne`) 1 client **không có** field `grantTypes` → `findByClientId` trả `['authorization_code']`, `/token` không 500.
  - *(tech-lead fold)* Schema `grantTypes` có `enum: ['authorization_code','refresh_token']`; `CreateClientInput.grantTypes?` tùy chọn; giá trị lạ → reject khi ghi (1 test).
- Security invariants: Actor=client registration (admin, out of scope). Invariant: client **không có** grant `refresh_token` ⇒ B4.4 **tuyệt đối không** phát refresh token (fail-closed). N/A exposure (field cấu hình, không nhạy cảm). State: schema migration cộng field default — client cũ đọc ra `['authorization_code']`.
- Phụ thuộc: không.
- § liên quan: plan §12 Q4/Q6, D7; spec §9.3/§10.

### [x] Task 2 [BE]: `TokenService` — build claims access token + ID token (chưa HTTP)
- Mô tả: Service nhận `AuthorizationCodeData` (đã consume ở B4.3) + `Client` và dựng claims, ký qua `TokenSigner` hiện có. **Access token**: `aud = resource` (sentinel `""` → reject, access token phải có resource cụ thể; xem failure case), `scope` (space-delimited string), `client_id`, `jti` (TokenSigner tự set), `sub=userId`; **+ `auth_time`** CHỈ khi `resource === <admin resource identifier D6>` (D3). **ID token**: `aud = client_id`, `nonce` echo **nguyên vẹn** từ code data (không set nếu code không có nonce), `auth_time` (từ `authTime`, giây), `amr` (default `["pwd"]` cho login email/password), `acr` (default `"urn:idp:aal1"`), `sub=userId`. ID token TTL = `accessTokenTtl` (Q6).
- Acceptance:
  - Access token decode: `iss`=issuer, `aud`=resource, `sub`, `scope`, `client_id`, `jti` có mặt; `exp-iat === 900`. ID token: `aud`=client_id, `nonce` khớp input byte-for-byte, `auth_time` = floor(authTime/1000), `amr`=["pwd"], `acr`="urn:idp:aal1".
  - `auth_time` **có** trong access token khi `resource`=admin identifier; **vắng** khi resource khác (2 test).
  - Code data không có `nonce` ⇒ ID token **không** có claim `nonce` (không để `null`/rỗng).
  - Chữ ký verify được qua `TokenVerifier`/JWKS hiện có (header `kid`, alg RS256).
  - *(tech-lead fold — resource vắng)* Trong code thật `AuthorizationCodeData.resource` là **`undefined`** khi `/authorize` không có `resource` (sentinel `""` chỉ dùng trong `ConsentService.normalizeResource`). Check phải là `!data.resource` (bao cả `undefined` và `""`) → `invalid_target` (400); **không** ký token nào, **không** insert RefreshToken (schema `resource` required). Test với code tạo **không** có `resource`.
  - *(tech-lead fold — openid)* ID token **chỉ** phát khi scope đã bind chứa `openid` (OIDC Core §3.1.2.1); không có `openid` ⇒ response không có `id_token` (1 test).
  - *(tech-lead fold — auth_time)* `authTime` là optional trong `AuthorizationCodeData` (đơn vị **ms**, từ `SessionService`) → vắng thì **bỏ** claim `auth_time` ở cả ID và access token, **không** bịa bằng `now` (fail-closed cho step-up B6.2). 1 test.
  - *(tech-lead fold — admin resource D6)* Định danh admin resource **suy ra từ config**, không thêm env, không literal rải rác: `new URL('/admin/', issuer).href` (ISSUER=`http://localhost:4000` ⇒ `http://localhost:4000/admin/`), đặt ở **một** hàm/hằng export dùng lại được cho B6.1/B6.2.
  - *(tech-lead fold — amr/acr)* `amr=["pwd"]`, `acr="urn:idp:aal1"` khai báo ở **một** hằng có comment "chỉ đúng khi login duy nhất là password — B5 phải mang amr từ session/code" (xem DEBT-030). Không đọc amr từ request.
- Security invariants:
  - **Tài sản**: access token (cấp quyền gọi resource), id token (danh tính). **Actor**: client hợp lệ vs client khác/attacker giữ code.
  - **Invariant**: `aud` access token = resource đã **bind trong code** — không bao giờ lấy từ request `/token` body; `sub` = internal id bất biến, **không** dùng email làm `sub` (spec §8). `nonce` **chỉ** mang nguyên vẹn, B4.4 **không** validate nonce (trách nhiệm RP — spec §9.1).
  - **Failure**: resource = sentinel `""` (public client Document) ⇒ **không** phát access token cho resource rỗng (fail-closed, trả `invalid_target`/`invalid_request`); test assert reject.
  - **Exposure budget**: KHÔNG log plaintext token/code/nonce/code_verifier (INV-20); không đưa token vào audit/URL/redirect.
- Phụ thuộc: Task 1 (config TTL + grantTypes type).
- § liên quan: spec §8, §9.2; plan D3/D6/Q6.

### [x] Task 3 [BE]: Phát hành + lưu RefreshToken tối thiểu theo D7 (ranh giới B4.5)
- Mô tả: Trong `TokenService`, chỉ khi **`client.grantTypes` chứa `refresh_token`** VÀ **scope cấp có `offline_access`** ⇒ mint refresh token opaque (CSPRNG `generateToken()`), lưu document `RefreshToken` **tối thiểu**: `tokenHash=sha256(token)`, `familyId` MỚI (uuid), `parentId=null`, `userId`, `clientId`, `scope[]`, `resource`, `issuedAt=now`, `expiresAt=now+REFRESH_TOKEN_TTL`. Trả plaintext refresh token trong response 1 lần. **KHÔNG** rotation/reuse/revoke (B4.5).
- Acceptance:
  - grant có `refresh_token` + scope có `offline_access` ⇒ response có `refresh_token`; DB có đúng 1 doc, `tokenHash` = sha256(plaintext) (không lưu plaintext), `familyId` set, `parentId`=null, `expiresAt-issuedAt ≈ 2592000s`.
  - Thiếu grant `refresh_token` **hoặc** thiếu scope `offline_access` ⇒ **không** có `refresh_token` trong response, **không** có doc trong DB (2 test).
  - `scope`/`resource` lưu đúng bằng giá trị đã bind trong code (không mở rộng).
  - *(tech-lead fold)* `familyId = randomUUID()`; `scope[]` = split của chuỗi scope đã bind; `userId` cast ObjectId (code mang `user.sub` = `User._id`). Response `scope` = đúng chuỗi đã bind. Plaintext refresh **không** xuất hiện trong doc DB (assert duyệt mọi field).
  - *(tech-lead fold — audit INV-25)* Mỗi lần phát hành thành công ghi 1 `AuditAction.TOKEN_ISSUED` (`actorType:'user'`, `actorId=userId`, `clientId`, `metadata:{resource, scope, refresh:boolean}`) — **không** chứa token/refresh/code/verifier (test assert). Ghi audit **trước** khi trả response; audit lỗi → 500 `server_error`, không trả token (fail-closed, cùng pattern `SESSION_CREATED`). RefreshToken đã insert khi đó là mồ côi vô hại (plaintext không rời server, TTL index dọn).
- Security invariants:
  - **Tài sản**: refresh token (đổi lấy token mới, sống lâu). **Actor**: owner vs attacker.
  - **Invariant**: refresh **chỉ** phát khi D7 thỏa (fail-closed); refresh lưu **hash**, không bao giờ plaintext (INV-10); `scope`/`resource` **không** mở rộng so với code đã bind.
  - **Failure/replay**: B4.4 không chống reuse (đó là B4.5) — ghi rõ debt/ranh giới, không giả vờ đã làm.
  - **Exposure**: plaintext refresh token **chỉ** nằm trong response body JSON (Cache-Control: no-store, Task 4), không vào log/audit/URL.
- Phụ thuộc: Task 2.
- § liên quan: plan D7/Q6; spec §10 (RefreshToken); DEBT-025 (gộp type ioredis — chỉ lưu ý, B4.5 mới cần Lua thứ 3).

### [x] Task 4 [BE]: `/token` controller + wiring flow + lỗi OAuth chuẩn
- Mô tả: Endpoint `POST /token` (form-urlencoded). Pipeline: parse `grant_type` (chỉ `authorization_code` ở B4.4; khác → `unsupported_grant_type`) → **client auth** qua `ClientAuthenticationService` (B3.3) chọn method theo header/body → **consume+bind** code qua `AuthorizationCodeService.consume(code, clientId, redirectUri)` (B4.3) → **verify PKCE**: `deriveS256Challenge(code_verifier) === code.codeChallenge` → gọi `TokenService` (Task 2/3) → trả JSON `{access_token, token_type:"Bearer", expires_in, id_token, refresh_token?, scope}` với header `Cache-Control: no-store`, `Pragma: no-cache`. Wire `TokenService`/controller vào `OauthModule` (imports `ClientsModule` đã có; thêm Mongoose `RefreshToken` model + `KeysModule`/`TokenSigner` provider).
- Acceptance:
  - Happy path (public client PKCE, `offline_access`): 200, body có `access_token`+`id_token`+`refresh_token`, `expires_in`=900, header `Cache-Control: no-store`.
  - `grant_type` khác `authorization_code` → 400 `unsupported_grant_type`.
  - Client auth sai (secret sai / method sai / unknown) → 401 `invalid_client` (shape OAuth, không lộ lý do cụ thể).
  - Code sai/hết hạn/đã dùng → 400 `invalid_grant`; code bind sai `client_id`/`redirect_uri` → `invalid_grant` **và** code gốc **không bị xóa** (INV-13, verify bằng consume lần 2 hợp lệ vẫn dùng được trong cùng test setup).
  - `code_verifier` sai/thiếu → 400 `invalid_grant` (PKCE fail).
  - Integration test chạy trên `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`.
  - *(tech-lead fold — INV-13 PKCE trong cùng bước atomic)* INV-13 yêu cầu bind `client_id` + `redirect_uri` + **PKCE challenge** **trước khi xoá**. Lua B4.3 hiện chỉ so `clientId`/`redirectUri`. Mở rộng: `consume(code, clientId, redirectUri, codeChallenge)` với `codeChallenge = deriveS256Challenge(code_verifier)`, Lua so thêm `data.codeChallenge ~= ARGV[3]` → `nil` **không DEL**. Cập nhật test B4.3 (`authorization-code.int-spec.ts`, `authorize.int-spec.ts`) theo chữ ký mới. Test: verifier sai → `invalid_grant` **và** sau đó gọi lại với verifier đúng → 200.
  - *(tech-lead fold)* `code_verifier` thiếu hoặc sai format RFC 7636 (`^[A-Za-z0-9\-._~]{43,128}$`) → 400 `invalid_grant`, **không** gọi Redis.
  - *(tech-lead fold — thứ tự)* client auth **trước** consume (client auth sai không được làm mất code — test: secret sai → 401, rồi request đúng → 200). Kiểm `client.grantTypes` chứa `authorization_code`, thiếu → 400 `unauthorized_client` (không consume).
  - *(tech-lead fold — lỗi OAuth)* `OAuthExceptionFilter` global map theo status nên **không** sinh được `invalid_grant`/`unsupported_grant_type`/`invalid_target`/`unauthorized_client` → dùng lỗi domain riêng (vd. `TokenError(code, status)`) + render ở controller/filter cục bộ đúng `{error, error_description}`. 401 `invalid_client` khi client dùng Basic → kèm `WWW-Authenticate: Basic` (RFC 6749 §5.2). Header `Cache-Control: no-store` + `Pragma: no-cache` cả trên response **lỗi**.
  - *(tech-lead fold — parse body)* Content-Type phải `application/x-www-form-urlencoded` (khác → 400 `invalid_request`); parser urlencoded đã có sẵn trong `FastifyAdapter` (không cần `@fastify/formbody`). Global `ValidationPipe` có `forbidNonWhitelisted` → `/token` **không** được 400 vì tham số lạ (RFC 6749 §3.1 "MUST ignore unrecognized") — dùng pipe/parse riêng. Tham số lặp (Fastify trả mảng) → 400 `invalid_request` (1 test). `resource` nếu có trong body phải **bằng** resource đã bind, khác → `invalid_target` (RFC 8707 §2.2); không bao giờ dùng để đổi `aud`.
  - *(tech-lead fold — client auth method)* Basic header → `client_secret_basic` (decode base64 rồi form-urldecode `id:secret`, RFC 6749 §2.3.1); `client_secret` trong body → `client_secret_post`; chỉ `client_id` → `none`. Dùng **>1** phương thức (Basic + `client_secret` body) → `invalid_request`; `client_id` body khác `client_id` trong Basic → `invalid_client`. Thiếu hoàn toàn `client_id` → `invalid_client`.
  - *(tech-lead fold — concurrency)* 2 request `/token` song song cùng code hợp lệ → đúng **1** response 200, còn lại `invalid_grant`; DB đúng **1** RefreshToken.
  - *(tech-lead fold — failure semantics, fail-closed)* Redis lỗi khi consume → 500 `server_error`, không token. Thứ tự: ký access/id → insert RefreshToken → trả response; insert RefreshToken lỗi (mock throw) → 500 `server_error`, body **không** chứa `access_token`/`id_token` (không phát hành một phần). KeyProvider lỗi → 500. Message lỗi không chứa code/verifier/secret.
- Security invariants:
  - **Trust boundary**: `/token` nhận input client qua HTTP (server-to-server/public). **Actor**: client hợp lệ, client khác, attacker chặn code.
  - **State transition**: code `tồn tại→consumed(DEL)` **atomic** (B4.3 Lua) — một code chỉ đổi token **một lần** (INV-1/2); request kế tiếp cùng code → `invalid_grant`.
  - **Invariant**: PKCE bắt buộc cho **mọi** client (public bắt buộc; confidential cũng verify nếu có `code_challenge` — spec §9.2 chỉ S256); `redirect_uri` ở `/token` phải khớp code đã bind (do `consume` enforce). Client auth equalise-timing đã có ở B3.3.
  - **Abuse/failure**: malformed body → `invalid_request`; mismatch client/redirect **không** xóa code (chống DoS INV-13, fail-closed); không enumeration (invalid_client đồng nhất).
  - **Exposure budget**: response **không** cache (no-store); **không** log token/code/secret/code_verifier (INV-20); lỗi **không** lộ secret hay có/không tồn tại code.
  - CORS: *(tech-lead CHỐT)* B4.4 **không** wire CORS. DEBT-019/020 giữ mở, dời sang **B4.6** (`/userinfo` + `/token` cho SPA cùng lúc, trước T2). Không thêm header CORS ad-hoc.
  - *(tech-lead fold — wiring)* `RefreshToken` model đã đăng ký global qua `MongoModule` (`@Global` + `forFeature(MODELS)`) → chỉ `@InjectModel('RefreshToken')`, **không** `forFeature` lại. `OauthModule` import `KeysModule` (export `TokenSigner`). PKCE: `/authorize` đã bắt buộc S256 cho **mọi** client ⇒ code luôn có `codeChallenge` ⇒ `/token` **luôn** verify (bỏ nhánh "nếu có").
- Phụ thuộc: Task 1, 2, 3.
- § liên quan: spec §9.2/§9.3/§9.5, §8; INV-5/7/8/9/13; DEBT-019/020 (CORS), DEBT-025 (type ioredis).

---

## DEBT kéo vào (từ backlog.md)
- **DEBT-019 / DEBT-020** (run 09): `@fastify/cors` đã thêm nhưng chưa wire; `Client.allowedCorsOrigins` chưa có index → full-scan mỗi preflight. *(tech-lead CHỐT)* **Không** wire ở B4.4 → dời sang B4.6 (backlog đã cập nhật).
- **DEBT-025** (run 11): `AuthCodeRedis`/`AuthzRedis` lặp type custom ioredis command. B4.4 **không** thêm Lua mới (refresh rotation Lua là B4.5) → debt vẫn mở, chỉ lưu ý khi B4.5 thêm script thứ 3.
- **DEBT-026 / DEBT-027** (run 12): đường tắt issue-code & atomicity `ConsentService.grant` — thuộc `/authorize`/consent, **không** chạm trong B4.4 (`/token` chỉ consume code đã có). Giữ nguyên, không đóng ở run này.