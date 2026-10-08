# Test Report — 2026-10-08 — B4.4 (/token grant authorization_code)

## Kết quả: PASS (310/310 test)

- Unit (*.spec.ts, 13 suites): 80/80 — trong đó token.service.spec.ts 13/13 (Task 2/3).
- Integration (*.int-spec.ts, 14 suites): 230/230 — token.int-spec.ts 24/24 (Task 4 + QA +1), clients.int-spec.ts 33/33 (gồm B4.4 Task 1), authorization-code.int-spec.ts + authorize.int-spec.ts PASS.
- Hạ tầng int: vg-test-mongo@27117 (rs0, rs.status().ok=1) + vg-test-redis@6479 (docker Up).
- Build + typecheck + lint: sạch.
- QA bổ sung 1 int test (Task 1 fold end-to-end): token.int-spec.ts "legacy client without grantTypes field: /token exchange succeeds (no 500)". KHÔNG sửa code sản phẩm.

## Lệnh đã chạy + output thực tế

    # lint (src + test file đã sửa)
    $ pnpm exec eslint test/token.int-spec.ts src        -> exit 0, không lỗi
    # typecheck
    $ pnpm run typecheck  (tsc --noEmit)                 -> exit 0
    # build
    $ pnpm run build  (build:css + nest build)           -> exit 0
    # unit (jest.config testRegex .*\.spec\.ts$ => src/, 13 suites)
    $ jest --runInBand
      Test Suites: 13 passed, 13 total
      Tests:       80 passed, 80 total
    # integration (script test:int => --testRegex "\.int-spec\.ts$", 14 suites)
    $ jest --runInBand --testRegex "\.int-spec\.ts$"
      PASS test/token.int-spec.ts  (fail-closed tests log ERROR redis/mongo/signer "SECRET-detail" — chủ đích, đã assert KHÔNG rò ra response body)
      PASS test/clients.int-spec.ts / authorization-code.int-spec.ts / authorize.int-spec.ts ... (14 suites)
      Test Suites: 14 passed, 14 total
      Tests:       230 passed, 230 total

Lưu ý config: jest.config.js testRegex chỉ khớp src/**/*.spec.ts (13 suites); int-spec chạy qua script test:int với --testRegex "\.int-spec\.ts$". Full suite = test (80) + test:int (230) = 310.

## Test FAIL
Không có.

## Coverage acceptance criteria (tasks.md)

### Task 1 — grantTypes[] + Q6 TTL
- [x] Client mới mặc định ['authorization_code']; seed ['authorization_code','refresh_token'] đọc đúng — clients.int-spec B4.4 Task1 case 1–2.
- [x] ClientService trả grantTypes trong type; build TS sạch — build exit 0.
- [x] TTL từ config (access 900 / refresh 2592000), không literal hard-code trong code B4.4 — grep 900/2592000 chỉ trong spec, không trong src/modules/oauth/token|code; token.service.spec exp-iat===900 + refresh ≈2592000.
- [x] (fold) legacy doc (collection.insertOne không có grantTypes) → findByClientId trả ['authorization_code'] + /token KHÔNG 500 — clients.int-spec case 3 (normalise) + QA mới token.int-spec legacy /token 200.
- [x] (fold) enum grantTypes; giá trị lạ reject khi ghi — clients.int-spec case 4 (['password'] reject).

### Task 2 — claims access + ID token
- [x] Access decode iss/aud/sub/scope/client_id/jti, exp-iat===900; ID aud=client_id, nonce byte-for-byte, auth_time floor(ms/1000), amr/acr — token.service.spec case 1–2.
- [x] auth_time có khi resource=admin, vắng khi khác (D3) — token.service.spec "auth_time ... admin identifier".
- [x] code không nonce → ID token không claim nonce — token.service.spec "no nonce ...".
- [x] chữ ký verify qua TokenVerifier/JWKS (RS256/kid) — token.int-spec happy path verifier.verify(access_token).
- [x] (fold) resource vắng (undefined/"") → invalid_target, không ký, không insert refresh — token.service.spec "missing resource" + token.int-spec "code bound to no resource".
- [x] (fold) ID token chỉ khi scope có openid — token.service.spec + token.int-spec "no openid scope".
- [x] (fold) authTime vắng → bỏ claim, không bịa now — token.service.spec "authTime absent".
- [x] (fold) admin resource suy từ ISSUER /admin/ ở một hằng export — token.service.spec "adminResourceIdentifier derives /admin/".
- [x] (fold) amr=["pwd"], acr="urn:idp:aal1" hằng — token.service.spec case 2.

### Task 3 — RefreshToken tối thiểu (D7)
- [x] grant refresh + offline_access → có refresh_token; 1 doc; tokenHash=sha256; familyId set; parentId null; expiresAt-issuedAt≈2592000 — token.service.spec "D7: refresh minted" + token.int-spec happy path (1 doc, hash match).
- [x] thiếu grant HOẶC thiếu offline_access → không refresh, không doc (2 test) — token.service.spec "no refresh grant" + "no offline_access"; token.int-spec "no offline_access".
- [x] scope/resource lưu đúng giá trị bind; plaintext không có trong doc — token.service.spec D7 (hash only).
- [x] familyId=randomUUID, userId cast ObjectId — token.service.spec D7.
- [x] (fold INV-25) audit TOKEN_ISSUED metadata không token/refresh/code/verifier; audit lỗi → fail-closed không trả token — token.service.spec "audit TOKEN_ISSUED ... no secret" + "audit failure => fail-closed"; token.int-spec "TOKEN_ISSUED audit written with safe metadata".

### Task 4 — /token controller + flow + lỗi OAuth
- [x] Happy path (public PKCE, offline_access): 200 access+id+refresh, expires_in=900, Cache-Control no-store — token.int-spec happy path.
- [x] grant_type khác → 400 unsupported_grant_type.
- [x] Client auth sai → 401 invalid_client (không lộ lý do) — "wrong client secret".
- [x] Code sai/hết hạn/đã dùng → 400 invalid_grant — "unknown/already-used code".
- [x] Bind sai client_id/redirect_uri → invalid_grant & code KHÔNG xóa (INV-13) — "wrong redirect_uri ... code intact" + "wrong client secret ... code NOT consumed then 200".
- [x] code_verifier sai/thiếu → 400 invalid_grant — "wrong code_verifier" + "malformed code_verifier ... never read from Redis".
- [x] Int trên vg-test-mongo@27117 rs0 + vg-test-redis@6479 — đã chạy thật.
- [x] (fold INV-13 Lua) consume bind thêm PKCE challenge (ARGV[3]) trước DEL — Lua data.codeChallenge ~= ARGV[3]; "wrong code_verifier ... code INTACT".
- [x] (fold) verifier thiếu/sai format → invalid_grant, không gọi Redis — "malformed code_verifier".
- [x] (fold thứ tự) client auth trước consume; grantTypes thiếu authorization_code → 400 unauthorized_client không consume — "client without authorization_code grant (code intact)".
- [x] (fold lỗi OAuth) TokenError render cục bộ {error,error_description}; 401 Basic kèm WWW-Authenticate — "wrong client secret ... WWW-Authenticate".
- [x] (fold parse body) content-type sai → invalid_request; tham số lạ KHÔNG 400 — "wrong content-type" + happy path.
- [x] (fold client auth method) client_id body khác Basic → invalid_client; Basic+client_secret body → invalid_request; thiếu client_id → invalid_client — 3 case.
- [x] (fold concurrency) 2 request song song cùng code → đúng 1×200, 1 refresh doc — "two concurrent exchanges".
- [x] (fold fail-closed) Redis consume lỗi / insert RefreshToken lỗi / signer lỗi → 500 server_error, không token, không rò code/verifier/SECRET-detail — 3 case fail-closed (544/574/605).
- [x] (fold Basic %ZZ) percent-encoding sai → 401 invalid_client + WWW-Authenticate — "malformed percent-encoding in Basic".
- [x] resource body != bound → invalid_target — "resource in body != bound resource".

## Coverage security invariants / risk matrix

| Chiều | Case thật |
|---|---|
| Identity / Credential | invalid_client (secret sai), unknown client, Basic %ZZ malformed, missing client_id, >1 method, client_id mismatch Basic |
| Authorization | client thiếu grant authorization_code → unauthorized_client; D7 negative (thiếu grant/scope → không refresh) |
| Input | content-type sai, repeated param, verifier malformed/thiếu, resource mismatch, grant_type lạ |
| State / replay | code single-use (DEL atomic INV-1/2), already-used → invalid_grant; INV-13 mismatch KHÔNG xóa code |
| Concurrency | 2 request song song cùng code → đúng 1 token, 1 refresh doc (race-safe Lua) |
| Dependency / fail | Redis/Mongo/Signer lỗi → 500 server_error fail-closed, không phát token một phần |
| Exposure | no-store mọi response (gồm lỗi); body/log không chứa code/verifier/secret/SECRET-detail; refresh lưu hash-only; audit metadata không token |
| PKCE bind | S256 challenge bind trong Lua trước DEL (INV-13) |

Không FAIL. Không DEBT mới (DEBT-029 rate-limit, DEBT-030 amr/acr đã ghi trước — ngoài phạm vi B4.4).
