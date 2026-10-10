# Test Report — run 15 — B4.6 (`/userinfo` + discovery + `/introspect`) — 2026-10-10

## Kết quả: **PASS** (405/405 test: unit 94 + int 311)

Tester xác nhận code thỏa toàn bộ acceptance trong `tasks.md` (gồm *(tech-lead fold)*) và các security
invariant/risk-matrix áp dụng. Không sửa code sản phẩm. Bổ sung **7 test integration** lấp các khe fold
chưa phủ (chi tiết §"Test bổ sung"). Full suite xanh.

Baseline bàn giao từ dev/senior: unit 94 + int 304 = 398. Sau bổ sung: unit 94 + int **311** = **405**.

---

## Lệnh đã chạy + output thực tế

Hạ tầng: containers `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (đang Up). Terminal = Git Bash.

### 1. Typecheck — `pnpm --filter be run typecheck` (tsc --noEmit)
```
$ tsc --noEmit
(exit 0 — không lỗi)
```

### 2. Lint — `pnpm --filter be run lint` (eslint src)
```
$ eslint src
(exit 0 — không lỗi)
```

### 3. Unit — `pnpm --filter be test`
```
Test Suites: 13 passed, 13 total
Tests:       94 passed, 94 total
Snapshots:   0 total
Time:        14.731 s
Ran all test suites.
(exit 0)
```

### 4. Integration — `pnpm --filter be test:int`  (jest --runInBand --testRegex "\.int-spec\.ts$")
```
Test Suites: 18 passed, 18 total
Tests:       311 passed, 311 total
Snapshots:   0 total
Time:        53.65 s, estimated 65 s
Ran all test suites.
(exit 0)
```
(trước khi bổ sung: 304; +7 test mới → 311.)

### 5. Rerun cô lập 2 file sửa (userinfo + introspect int) — verbose
```
Test Suites: 2 passed, 2 total
Tests:       42 passed, 42 total   (userinfo 19 + introspect 23)
```

---

## Test FAIL
Không có. Toàn bộ 405 test PASS.

---

## Test bổ sung (tester viết — lấp khe *(tech-lead fold)* chưa phủ)

`be/test/userinfo.int-spec.ts` (+4):
- **HS256-signed token (alg confusion) → 401**: forge access token hợp lệ mọi mặt trừ `alg=HS256`
  (ký bằng secret tự chọn). `verifyAccessToken` pin `algorithms:['RS256']` → phải 401 (chặn
  alg-confusion/downgrade). Trước đó chỉ có case ID-token `typ:JWT`, chưa có alg confusion thật ở `/userinfo`.
- **Wrong `iss` (ký bằng KEY THẬT + `at+jwt`) → 401**: ký bằng private key thật của IdP (chữ ký
  verify được với JWKS) nhưng `iss` lạ → fail ở `iss`, chứng minh "chỉ đúng chữ ký là chưa đủ".
- **Thiếu `exp` (key thật + `at+jwt`) → 401**: token không `exp` phải bị từ chối (requiredClaims),
  không bị coi là token vĩnh viễn.
- **scope `openid profile` (không email) → 200 claim profile, KHÔNG `email`/`email_verified`**:
  bổ sung nhánh scope profile-không-email (trước chỉ có openid-only và openid+email+profile).

`be/test/introspect.int-spec.ts` (+3):
- **Caller auth qua `client_secret_post` (credential trong body, không Basic) → active:true**:
  acceptance/fold nêu caller auth `client_secret_basic|post`; test cũ chỉ dùng Basic.
- **`client_secret_post` sai secret → 401 invalid_client, không có body introspection**: nhánh âm của post.
- **`token_type_hint` được chấp nhận nhưng KHÔNG tin (branch theo SHAPE)**: refresh token sống kèm hint
  LỪA `access_token` vẫn resolve là refresh; access token sống kèm hint LỪA `refresh_token` vẫn verify
  là access (RFC 7662 §2.1).

---

## Coverage acceptance criteria

### Task 1 — Discovery `/.well-known/openid-configuration` (`discovery.int-spec.ts`)
- [x] 200 JSON; mỗi `*_endpoint`/`jwks_uri` suy từ issuer + trỏ route thật; fetch `jwks_uri` → 200 có `keys[]` — "200 JSON; every endpoint URL..."
- [x] `scopes_supported` có `offline_access`; `grant_types_supported` có `refresh_token`; `code_challenge_methods==["S256"]`; `alg==["RS256"]`; `revocation_endpoint`+`introspection_endpoint` hiện diện — snapshot test
- [x] Snapshot khớp từng field; không rò field thừa — "metadata matches the agreed contract (snapshot)"
- [x] *(fold)* `token_endpoint_auth_methods == [basic,post,none]`; `introspection/revocation_endpoint_auth_methods==[basic,post]`; `authorization_response_iss_parameter_supported:true` — snapshot
- [x] *(fold)* KHÔNG quảng bá `end_session_endpoint` — "does NOT advertise end_session_endpoint"
- [x] *(fold)* `claims_supported` = claim token + claim `/userinfo` whitelist — snapshot (khớp PROFILE_STRING_CLAIMS)
- [x] *(fold)* URL ghép giữ path issuer / không double-slash — unit "issuer with a path..." + "trailing slash..."
- [x] CORS theo `isOriginRegisteredForAnyClient`, `Vary: Origin` luôn có — "real GET echoes a registered Origin..."

### Task 2 — `GET /userinfo` (`userinfo.int-spec.ts`)
- [x] Token scope `openid email profile` → 200 sub/email/email_verified/profile; no-store — "valid token..."
- [x] `email_verified` đúng `emailVerifiedAt != null` — "email_verified reflects..." + happy path
- [x] Token scope chỉ `openid` → 200 `{sub}` — "scope only openid..."
- [x] Token scope `openid profile` (không email) → không email — **(tester bổ sung)**
- [x] Không/sai/hết hạn token → 401 `WWW-Authenticate: Bearer` — "missing / malformed / absent token..."
- [x] *(fold)* ID token (`typ:JWT`) → 401 — "an ID token presented as access token..."
- [x] *(fold)* alg != RS256 → 401 — **(tester bổ sung HS256)**
- [x] *(fold)* `iss` khác → 401 — **(tester bổ sung wrong iss)**
- [x] *(fold)* thiếu `exp` → 401 — **(tester bổ sung missing exp)**
- [x] *(fold)* client không tồn tại / `aud ∉ allowedResources` → 401 — "unknown client_id", "aud not in..."
- [x] *(fold)* `sub` sai ObjectId / user không tồn tại → 401 (không 500) — "sub not an ObjectId / user not found..."
- [x] Thiếu `openid` → 403 insufficient_scope — "token missing openid scope..."
- [x] *(fold)* token từ header `Authorization` only; query `access_token` bị bỏ qua → 401 — "access_token in query is ignored"
- [x] *(fold)* profile = whitelist; key lạ (`internalNote`) không lọt — happy path assert `not.toHaveProperty('internalNote')`
- [x] Preflight OPTIONS origin đăng ký → ACAO; origin lạ → không ACAO — "preflight OPTIONS..."
- [x] *(fold)* CORS real request theo client của token; cross-client → không ACAO; không Allow-Credentials — "real request: Origin registered for the token client..."
- [x] Index `{allowedCorsOrigins:1}` tồn tại (DEBT-020) — `indexes.int-spec.ts` (`key:{allowedCorsOrigins:1}`)
- [x] `@fastify/cors` đã gỡ (DEBT-019) — xác nhận không còn trong `be/package.json` dependencies

### Task 3 — `POST /introspect` RFC 7662 (`introspect.int-spec.ts`)
- [x] Caller không auth / sai cred → 401, không body introspection — "no caller auth...", "bad secret..."
- [x] *(fold)* public/`none` client → 401 invalid_client — "public (none) client..."
- [x] *(fold)* caller auth `client_secret_post` (body) + sai secret → 401 — **(tester bổ sung 2 case)**
- [x] Refresh còn sống (owning client) → active:true — "live refresh token, owning client..."
- [x] Refresh revoke/family-revoke/hết hạn → active:false — "revoked / family-revoked / expired refresh..."
- [x] Access còn hạn → active:true + token_type access_token + sub/aud/scope/exp — "RS holding the aud..."
- [x] Access hết hạn/chữ ký sai → active:false — "expired access token..."; ID token → active:false
- [x] Token rác → active:false (200) — "garbage / unknown token..."
- [x] *(fold IDOR)* client B introspect refresh của A → active:false — "IDOR: client B introspects client A refresh..."
- [x] *(fold IDOR)* confidential client không giữ aud (confused-deputy) → active:false — "confused-deputy..."
- [x] *(fold liveness §214)* access vẫn active:true dù family/session revoke — "access token stays active:true... (§214 limit)"
- [x] *(fold liveness)* client bị xoá / aud bị gỡ / user không tồn tại / sub sai → active:false — 4 test "liveness: ..."
- [x] *(fold)* `token_type_hint` chấp nhận nhưng không tin (branch theo shape) — **(tester bổ sung)**
- [x] *(fold)* thiếu `token` / lặp param → 400 invalid_request — "missing token => 400..."
- [x] *(fold fail-closed)* lỗi DB (refresh findOne) → 500 server_error, không active:true — "fail-closed: a DB error => 500..."
- [x] *(fold fail-closed)* lỗi DB khi liveness access → 500 — "fail-closed: a DB error during access-token liveness..."
- [x] Mọi response `Cache-Control: no-store` — assert ở happy paths
- [x] KHÔNG CORS cho `/introspect` — controller không gọi applyCors; xác nhận qua đọc code

### Task 4 — Dọn nợ tất định DEBT-035 + DEBT-036 (`refresh-token.int-spec.ts`)
- [x] Race test tất định (thay test ngẫu nhiên CONCURRENT): "DETERMINISTIC race (INV-11): descendant minted during reuse revoke cannot survive" + "...during /revoke cannot survive"; cả hai assert `all.every(d => d.revokedAt)`
- [x] Spec §10 RefreshToken liệt kê `familyRevokedAt`; JSDoc `revokeFamily` khớp — xác nhận qua đọc spec/JSDoc (phạm vi docs)
- [x] `pnpm test:int` xanh; tổng ≥ 342 — 311 int (+94 unit = 405 ≫ 342)

---

## Coverage security invariants / risk matrix

- [x] **INV-19 (exposure)** discovery public không rò private key / alg lạ / `plain` — "leaks no private key material..."
- [x] **INV-8/9 token confusion** `/userinfo` + `/introspect` từ chối ID token (`typ:JWT`), HS256, iss sai, thiếu exp — các test fold + bổ sung
- [x] **Authorization (IDOR / confused-deputy)** `/introspect`: negative actor (client B soi token A; confidential client không giữ aud) → active:false; `/userinfo`: token client B từ origin của A → không ACAO
- [x] **Credential** absent / malformed / expired / wrong-secret (basic & post) đều phủ cho `/introspect` caller auth và `/userinfo` bearer
- [x] **Input** valid / boundary (scope filter) / malformed (sub sai ObjectId → không CastError 500) / repeated param (dup token → 400) / injection shape (token rác → active:false)
- [x] **State** fresh vs stale (refresh revoke/family-revoke/expired → active:false); access self-contained không phản ánh revoke (§214, ghi rõ hợp đồng — không FAIL)
- [x] **Dependency / failure injection (fail-closed)** lỗi DB ở refresh lookup và liveness user lookup → 500 server_error, KHÔNG bị nuốt thành active:true hay active:false (lỗi hạ tầng không che thành not-found/success)
- [x] **Request chain / hint không tin** `token_type_hint` lừa không đổi nhánh theo shape
- [x] **Exposure budget** `/introspect` không trả `familyId`/`_id`/hash; `/userinfo` whitelist profile, không spread document (`passwordHash`/`mfaSecret` `select:false`); CORS không `*`, không Allow-Credentials, luôn `Vary: Origin`

### Replay / concurrency (invariant phụ thuộc atomic)
- [x] Replay refresh đã revoke → active:false (introspect) và → invalid_grant + revoke cả family (refresh flow)
- [x] Concurrency INV-11: 2 test race tất định (reuse + /revoke) ép interleaving thua, assert mọi doc family revoked — DEBT-035 đóng tất định (không còn test ngẫu nhiên)

---

## Nợ còn mở (không chặn PASS — đã nêu rõ tác động)
- DEBT-040 (đảo authz trước liveness ở `/introspect` — chỉ timing oracle, blast radius thấp; senior ghi), DEBT-041 (test aud chưa cô lập hoàn toàn), DEBT-042 (Keys→Clients cấu trúc), DEBT-037/038 → B4.7, DEBT-026/027 → consent-hardening. Không có invariant bảo mật nào thiếu bằng chứng → không chuyển debt để PASS.

## Kết luận
**PASS** — bàn giao orchestrator đóng run 15. Chuyển B4.7 tiếp theo. Code chưa commit (tester không commit).
