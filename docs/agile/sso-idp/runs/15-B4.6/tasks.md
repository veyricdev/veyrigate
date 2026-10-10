# Tasks — run 15 — B4.6 (`/userinfo` + discovery + `/introspect`)

> Nguồn: `plan.md` §5 bảng Phase B dòng **B4.6** (L195); spec `§11` (endpoints L444/445/453), `§12` discovery (L455–473), `§214` revocation strategy, `§343` CORS tách khỏi `redirect_uris`, INV-8/9/19. Phụ thuộc chung: B4.4 (`/token`), B4.5 (refresh family) — đều ✅ (run 13/14).
> Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (80) + `pnpm test:int` (262) = baseline **342**. Mọi task phải giữ suite xanh + thêm test mới.

---

## Quyết định đã chốt *(tech-lead fold — chi tiết lý do: `review-techlead.md`)*

- **OPEN-1 → CHỐT A**: access token = exp-only (không denylist `jti`, không tra family). `/introspect` access JWT `active:true` chỉ khi verify OK (`verifyAccessToken`, xem dưới) **và** client `client_id` tồn tại **và** `aud ∈ client.allowedResources` hiện tại **và** user `sub` tồn tại. Không phản ánh revoke family/logout (≤ 15'). Sửa câu §214 cho đúng giới hạn. `sid` → DEBT-037 (B4.7).
- **OPEN-2 → CHỐT**: `/userinfo` chấp nhận access token của **bất kỳ** resource (không ép 1 aud). Chống token confusion bằng header `typ: at+jwt` (RFC 9068) cho access token: thêm option `typ` vào `TokenSigner.sign` (mặc định `JWT` → ID token không đổi), `signAccessToken` truyền `at+jwt`. Thêm `TokenVerifier.verifyAccessToken(token)`: RS256, `iss`, `typ=at+jwt`, requiredClaims `exp,iat,sub,jti,client_id,scope`, `aud` là string; **giữ nguyên** `verify(token, audience)`.
- **DEBT-026/027 → ĐỒNG Ý DỜI**: mốc mới = run "consent-hardening" (DEBT-026/027/028) ngay sau B4.7, trước khi đóng M4.

## Quyết định mở (bản gốc analyst — đã chốt ở trên)

**OPEN-1 — Ngữ nghĩa `active:false` của `/introspect` cho ACCESS vs REFRESH token.**
Access token là **JWT self-contained, KHÔNG lưu DB** (xác nhận qua `TokenSigner`/`token.service.ts`: chỉ sign, không persist). Refresh token **có DB** (`RefreshTokenSchema`: `revokedAt`, `familyRevokedAt`). Spec §214 đã chốt: "**không** đồng bộ vô hiệu hoá access token đã phát hành; resource cần revoke tức thời thì tự gọi `/introspect`". Hệ quả: với **access token**, `/introspect` chỉ kiểm chứng được chữ ký (JWKS) + `exp`; **không** biết được "đã revoke" vì không có bản ghi DB.
- **Phương án an toàn đề xuất (fail-closed)**:
  1. `/introspect` nhận 1 `token` + `token_type_hint` tuỳ chọn.
  2. Thử **refresh token trước** (opaque, tra `tokenHash=sha256(token)` trong DB): `active:true` chỉ khi `revokedAt==null && familyRevokedAt==null && expiresAt>now`; ngược lại `active:false`.
  3. Nếu không phải refresh (không khớp hash) → thử **JWT access token** qua JWKS (RS256, `iss`, `exp`): hợp lệ & chưa hết hạn → `active:true` kèm `sub/aud/scope/client_id/exp/iat/jti/token_type="access_token"`; hết hạn/chữ ký sai → `active:false`.
  4. Access token **không** phản ánh revoke thủ công (ghi rõ giới hạn này trong JSDoc + spec; đúng §214, không coi là bug).
- Acceptance gốc B4.6 ("introspect trả `active:false` cho token hết hạn/đã revoke") **đo được** cho refresh token (revoke qua `/revoke` family). Với access token chỉ đảm bảo được vế **hết hạn**. **Cần tech-lead xác nhận** diễn giải này hoặc yêu cầu thêm denylist `jti` (ngoài phạm vi MVP → đề xuất debt riêng).

**OPEN-2 — Audience khi verify ở `/userinfo`.** `TokenVerifier.verify(token, audience)` **bắt buộc** 1 `aud`. Access token có `aud = resource đã bind` (không phải "userinfo"). Đề xuất: `/userinfo` chấp nhận token có `aud` là **resource của IdP tự thân** (hoặc `aud` bất kỳ resource đã đăng ký mà client được cấp) — cần chốt policy. Phương án an toàn tối thiểu: thêm overload verify theo JWKS + `iss` + `exp` **không ép aud cứng**, rồi tự kiểm `aud ∈ allowedResources` + `scope` chứa `openid`. Ghi rõ cho tech-lead.

---

### [x] Task 1 [BE]: Discovery `/.well-known/openid-configuration` khớp thực tế + DEBT-033
- Mô tả: Thêm `DiscoveryController` trả JSON theo spec §12, mọi URL **suy ra từ `config.app.issuer`** (không hardcode). Sửa cho khớp endpoint thật: `jwks_uri` = `{issuer}/jwks.json` (đúng `KeysController @Get('jwks.json')`), `authorization_endpoint`/`token_endpoint`/`userinfo_endpoint`/`end_session_endpoint`(`/logout`). `id_token_signing_alg_values_supported:["RS256"]`, `code_challenge_methods_supported:["S256"]`, `response_types_supported:["code"]`, `token_endpoint_auth_methods_supported:["client_secret_basic","none"]`, `subject_types_supported:["public"]`, `claims_supported` theo §12. **DEBT-033**: `grant_types_supported:["authorization_code","refresh_token"]` + thêm `revocation_endpoint:{issuer}/revoke` (và `introspection_endpoint:{issuer}/introspect` từ task 3). **D7 (Q4 CHỐT)**: `scopes_supported:["openid","profile","email","offline_access"]`.
- Acceptance:
  - `GET /.well-known/openid-configuration` → 200 JSON; mỗi `*_endpoint`/`jwks_uri` trỏ đúng route đang mount (assert integration: fetch `jwks_uri` → 200 có `keys[]`).
  - `scopes_supported` chứa `offline_access`; `grant_types_supported` chứa `refresh_token`; `code_challenge_methods_supported==["S256"]`; `id_token_signing_alg_values_supported==["RS256"]`; `revocation_endpoint` & `introspection_endpoint` hiện diện.
  - Snapshot test so khớp từng field; không rò field thừa (no `plain`, no alg khác RS256).
  - *(tech-lead fold)* `token_endpoint_auth_methods_supported == ["client_secret_basic","client_secret_post","none"]` (khớp `token.controller.ts` chấp nhận post). `introspection_endpoint_auth_methods_supported` & `revocation_endpoint_auth_methods_supported == ["client_secret_basic","client_secret_post"]`. `authorization_response_iss_parameter_supported: true` (đã set `iss` ở redirect).
  - *(tech-lead fold)* **KHÔNG** quảng bá `end_session_endpoint` ở run này (`GET /logout` hiện chỉ là form UI, chưa RP-initiated) → test assert vắng mặt; thêm ở B4.7 (DEBT-038). Ghi chú lệch §12 vào spec.
  - *(tech-lead fold)* `claims_supported` = claim token §12 **+** claim `/userinfo` thực trả (`email`,`email_verified`,`name`,`given_name`,`family_name`,`picture`,…) — đúng whitelist Task 2.
  - *(tech-lead fold)* URL ghép = `issuer` bỏ `/` cuối + `/path` (không dùng `new URL('/x', issuer)` vì nuốt path issuer). Unit test với issuer có path (`https://h/idp`) và có `/` cuối. Response có `Cache-Control: public, max-age=…` ngắn, CORS theo `isOriginRegisteredForAnyClient`.
- Security invariants: **Exposure budget** — discovery là public, tuyệt đối không chứa secret/khoá private/khoá nội bộ/URL hạ tầng; chỉ public metadata (INV-19 tinh thần). Actor: anonymous được đọc. Không state transition.
- Phụ thuộc: không (độc lập; có thể làm trước task 3, nhưng `introspection_endpoint` thêm khi task 3 xong).
- Trỏ: plan §5 B4.6; spec §12, §11; DEBT-033.

### [x] Task 2 [BE]: `GET /userinfo` (Bearer, verify JWKS, claims theo scope) + CORS wiring (DEBT-019/020)
- Mô tả: `UserinfoController @Get('userinfo')`. Lấy Bearer token từ `Authorization` header; verify qua JWKS (RS256, `iss`, `exp` — xem OPEN-2 cho `aud`). Yêu cầu `scope` chứa `openid`. Tải `User` theo `sub`; trả claims **đúng theo scope đã cấp**: luôn `sub`; `profile`→ field profile; `email`→ `email` + `email_verified` (từ `emailVerifiedAt`). **Không** trả `email`/`profile` nếu scope không có. **DEBT-019**: wire CORS thật cho `/userinfo` (và discovery/jwks) dùng `ClientCorsService` (`@fastify/cors` hoặc hook thủ công theo mapping `client-cors.service.ts`); nếu tự viết hook thì gỡ dependency `@fastify/cors` thừa. **DEBT-020**: thêm `ClientSchema.index({ allowedCorsOrigins: 1 })` để `isOriginRegisteredForAnyClient` không full-scan.
- Acceptance:
  - Token hợp lệ scope `openid email profile` → 200, body chứa `sub`,`email`,`email_verified`,profile fields; `email_verified` đúng `emailVerifiedAt != null`.
  - Token hợp lệ scope chỉ `openid` → 200 chỉ `{ sub }`, **không** có `email`/profile.
  - Không/ sai/ hết hạn Bearer → **401** với `WWW-Authenticate: Bearer`; token không có `openid` → 403.
  - Preflight `OPTIONS /userinfo` từ origin **đã đăng ký** `allowedCorsOrigins` → trả `Access-Control-Allow-Origin` đúng origin; origin **lạ** → không có header ACAO (fail-closed). Integration test cả 2 nhánh.
  - Index test: khẳng định index `{ allowedCorsOrigins: 1 }` tồn tại trên `ClientSchema` (DEBT-020).
  - *(tech-lead fold)* Verify qua `verifyAccessToken` (OPEN-2). **ID token hợp lệ** (cùng signer, `typ: JWT`) → **401** `invalid_token`. Token `alg` khác RS256 / `iss` khác / thiếu `exp` → 401.
  - *(tech-lead fold)* Sau verify: client `client_id` không tồn tại hoặc `aud ∉ client.allowedResources` → 401; `sub` không phải ObjectId hợp lệ hoặc user không tồn tại → 401 (không 500/CastError). Thiếu `openid` → **403** `WWW-Authenticate: Bearer error="insufficient_scope"`.
  - *(tech-lead fold)* Bearer **chỉ** từ header `Authorization: Bearer <t>` (scheme case-insensitive, đúng 1 header); `access_token` ở query → bị bỏ qua/401 (test). Mọi response `Cache-Control: no-store`.
  - *(tech-lead fold)* Claims `profile` = **whitelist** OIDC (`name, given_name, family_name, middle_name, nickname, preferred_username, picture, website, gender, birthdate, zoneinfo, locale, updated_at`) chỉ lấy key có mặt & kiểu string (updated_at = epoch từ `updatedAt`); key lạ trong `User.profile` (Mixed) **không** lọt ra (test seed key `internalNote` → vắng).
  - *(tech-lead fold)* CORS: hook thủ công 1 helper theo mapping `client-cors.service.ts` — `/userinfo` request thật: `isOriginAllowedForClient(token.client_id, Origin)`; preflight & `/jwks.json` & discovery: `isOriginRegisteredForAnyClient`; `/token`,`/revoke`: `isOriginAllowedForClient(client_id body/Basic)`. ACAO = đúng origin (không `*`), **không** `Access-Control-Allow-Credentials`, luôn `Vary: Origin`; preflight chỉ allow method/header cần (`GET,POST`, `Authorization, Content-Type`). **Không** CORS cho `/introspect`. Gỡ `@fastify/cors` khỏi `be/package.json` (DEBT-019 đóng). Test: origin đăng ký cho client A dùng token của client B → không ACAO.
- Security invariants:
  - **Tài sản**: PII của user (email, profile). **Actor**: anonymous (no token), owner (token của chính mình), attacker (token giả/hết hạn/sai chữ ký/sai alg), JS trên origin lạ.
  - **Invariant**: chỉ trả claims trong scope đã cấp; không bao giờ trả `passwordHash`/`mfaSecret`/`lockTransitionNonce` (các field `select:false` sẵn + whitelist claim tường minh, không spread cả document). Không chấp nhận `alg:none`/HS* (TokenVerifier đã ép RS256).
  - **Trust boundary**: header `Authorization` → verify JWKS → load User theo `sub`. **Failure**: token malformed/expired/revoked(xem §214)/sai `aud` → 401 fail-closed, không rò lý do chi tiết (chỉ `invalid_token`).
  - **Exposure budget**: không log Bearer token/giá trị token; không đưa email vào URL/redirect; không ACAO wildcard khi có credentials.
- Phụ thuộc: không (JWKS/verify đã có từ B4.4). CORS primitive có từ B3.4.
- Trỏ: plan §5 B4.6; spec §11 (L444), §343 (CORS); DEBT-019, DEBT-020; INV-8/9/19.

### [x] Task 3 [BE]: `POST /introspect` (RFC 7662) — chỉ client/resource được phép
- Mô tả: `IntrospectController @Post('introspect')` (form-encoded `token`, optional `token_type_hint`). **Caller auth bắt buộc** qua `ClientAuthenticationService` (client_secret_basic/post) **hoặc** resource credential đã đăng ký; caller không hợp lệ → **401** (không tiết lộ token hợp lệ hay không). Logic theo **OPEN-1** (refresh trước qua DB hash; fallback JWT access qua JWKS). Response RFC 7662: `{active:bool}` và khi `active:true` kèm `scope`,`client_id`,`sub`,`aud`,`exp`,`iat`,`token_type`. Token lạ/sai → `{active:false}` (200, không 4xx — chống enumeration theo RFC).
- Acceptance:
  - Caller **không auth** / sai credential → 401, **không** trả body introspection.
  - Caller hợp lệ + refresh token còn sống → `{active:true,...}`; refresh **đã revoke** (qua `/revoke` hoặc reuse → `revokedAt`/`familyRevokedAt`) → `{active:false}`; refresh **hết hạn** → `{active:false}`.
  - Caller hợp lệ + access JWT còn hạn → `{active:true, token_type:"access_token", sub, aud, scope, exp}`; access **hết hạn**/chữ ký sai → `{active:false}`.
  - Token rác → `{active:false}` (200).
  - Giới hạn §214 (access revoke thủ công không phản ánh) ghi trong JSDoc + bổ sung 1 dòng spec §11/§214; test khẳng định hành vi (access chưa hết hạn vẫn `active:true` dù session/family bị revoke) để làm rõ hợp đồng — **OPEN-1 đã chốt A** *(tech-lead fold)*; sửa câu §214 "RS cần revoke tức thời thì gọi `/introspect`" thành mô tả đúng giới hạn.
  - *(tech-lead fold)* **Caller auth**: chỉ **confidential client** (`client_secret_basic|post`, tái dùng parse của `/token` — trích helper dùng chung, không copy). `none`/public client, không credential, sai secret → **401** `invalid_client` (+ `WWW-Authenticate` khi Basic), body không chứa trường introspection. Không có "resource credential" (schema `Resource` không có secret) — RS đăng ký như confidential client.
  - *(tech-lead fold)* **Authz caller (chống confused deputy/IDOR)**: refresh → `active:true` chỉ khi `doc.clientId == caller.clientId`; access → chỉ khi `token.client_id == caller.clientId` **hoặc** `token.aud ∈ caller.allowedResources`. Ngược lại `{active:false}` cùng shape. Test: client B introspect refresh/access của client A (aud không thuộc B) → `{active:false}`; RS-client có `allowedResources=[aud]` → `active:true`.
  - *(tech-lead fold)* **Phân nhánh theo hình dạng**: JWT 3 phần → nhánh access (`verifyAccessToken` + liveness OPEN-1); còn lại → refresh hash. `token_type_hint` chấp nhận nhưng không tin (RFC 7662 §2.1). ID token → `{active:false}`. Refresh `active:true` trả `token_type:"refresh_token"`, `client_id`, `sub`, `scope` (join space), `aud`=resource, `exp`/`iat` epoch giây; **không** trả `familyId`/`_id`/hash.
  - *(tech-lead fold)* **Failure semantics**: lỗi verify JOSE/format → `{active:false}`; lỗi DB/KeyProvider (timeout, mất kết nối) → **500 `server_error`**, không bao giờ `active:true` (fail-closed) — test mock lỗi DB. Thiếu `token` / tham số lặp → 400 `invalid_request`. Mọi response `Cache-Control: no-store`. Discovery thêm `introspection_endpoint`.
- Security invariants:
  - **Tài sản**: metadata token (scope/sub/aud) — chỉ lộ cho caller đã xác thực & được phép. **Actor**: client đã đăng ký, resource server, attacker không có credential, client khác muốn soi token người khác.
  - **Invariant**: chưa auth caller → **không** trả bất kỳ thông tin token (tránh dùng introspect làm oracle). Chốt **fail-closed**: mọi lỗi verify/DB → `active:false` (không 500 lộ nội bộ) trừ lỗi hạ tầng thực sự.
  - **Abuse/failure**: replay token đã revoke (refresh) → `active:false`; enumeration token rác → luôn `{active:false}` cùng shape; không bắt buộc constant-time, ghi debt nếu lo timing oracle.
  - **Exposure budget**: không log giá trị `token`; không echo token trong response/log/audit; audit tuỳ chọn chỉ ghi `client_id` caller + kết quả `active`, không ghi `sub` của token nếu không cần.
- Phụ thuộc: Task 1 (để bổ sung `introspection_endpoint` vào discovery); dùng `RefreshTokenService`/schema (B4.5) + `TokenVerifier` (B4.4).
- Trỏ: plan §5 B4.6; spec §11 (L453), §214; RFC 7662; OPEN-1.

### [x] Task 4 [BE]: Dọn nợ test/docs tất định — DEBT-035 + DEBT-036
- Mô tả: **DEBT-035**: thêm **test race tất định** cho refresh rotation (gate ở `findOne` re-read hoặc giữa stamp↔revoke-pass để ép thứ tự: "rotate re-read TRƯỚC stamp → revoke-pass bắt hậu duệ" và biến thể `/revoke` bằng con đang active trong cửa sổ race), assert **mọi doc của family có `revokedAt`** (thay cho test ngẫu nhiên `CONCURRENT`). **DEBT-036**: sửa docs lệch — JSDoc `revokeFamily` (bỏ lập luận `reuseDetectedAt` là dấu rotate; gom comment mark-then-check lặp), bổ sung `familyRevokedAt` vào spec §data-model RefreshToken; guard `if (!parent || parent.familyRevokedAt)` fail-closed; helper `gateInsert()` nếu khử trùng setup.
- Acceptance:
  - Test race mới **tất định** (chạy lặp ≥20 lần không flaky trong CI local); assert toàn bộ family `revokedAt != null` sau reuse/`/revoke`.
  - Spec §10 RefreshToken liệt kê `familyRevokedAt`; JSDoc `revokeFamily` khớp hành vi hiện tại; không còn 2 test gate trùng setup.
  - `pnpm test:int` vẫn xanh; tổng test ≥ 342 (+ test mới).
- Security invariants: Củng cố **INV-11** (reuse → revoke cả family; đóng race). **Invariant**: không có doc nào của family escape revoke do thứ tự rotate/stamp. **Failure**: `parent` null → fail-closed (coi như đã revoke). N/A exposure (chỉ test/docs).
- Phụ thuộc: không (code B4.5 đã có; thuần test + docs).
- Trỏ: DEBT-035, DEBT-036; spec §9.5/§10; INV-11.

---

## DEBT dời tiếp (ghi rõ lý do — ngoài phạm vi B4.6)

- **DEBT-026 / DEBT-027** (consent `grant` atomicity / union scope race) — **DỜI** (không gắn B4.6 chức năng). Lý do: thuộc luồng **consent/`/token`**, không chạm `/userinfo`/discovery/`/introspect`; run 12/13 tech-lead đã xác định "ngoài phạm vi `/token`" và gắn tạm B4.6 chỉ như **mốc thời gian**, không vì liên quan chức năng. Gộp vào đây sẽ vượt 5 task và pha loãng trọng tâm endpoint. Đề nghị tech-lead gắn lại mốc: ưu tiên **trước khi mở consent cho prod**, hoặc cùng **B7** (DEBT-032 transaction rotation). Nếu tech-lead muốn giữ trong run này → tách **run 15b** riêng sau khi 3 task chức năng xanh.n