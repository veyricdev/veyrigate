# Test Report — 2026-10-06
## Kết quả: PASS (206/206 test: 67 unit + 139 int)

## Lệnh đã chạy + output thực tế

### Case 1 — typecheck
`pnpm typecheck` (be/)

```text
$ tsc --noEmit
(exit 0, không lỗi)
```

### Case 2 — unit test (đầy đủ, chạy lại độc lập, không chỉ tin log dev/senior)
`pnpm test` (be/)

```text
PASS src/common/crypto/pkce.util.spec.ts
PASS src/modules/ui/return-to.spec.ts
PASS src/modules/clients/redirect-uri.validator.spec.ts
PASS src/common/crypto/crypto.util.spec.ts
PASS src/config/validation.schema.spec.ts
PASS src/modules/ui/csrf.service.spec.ts
PASS src/common/logger/logger.module.spec.ts
PASS src/modules/security/audit/audit.service.spec.ts
PASS src/modules/sessions/session.cookie.spec.ts
PASS src/modules/authentication/authentication.service.spec.ts
PASS src/modules/keys/keys.spec.ts
PASS src/modules/mailer/mailer.spec.ts

Test Suites: 12 passed, 12 total
Tests:       67 passed, 67 total
Time:        14.327 s
```
Cảnh báo không chặn: ts-jest 30/29 version mismatch warning, Node VM Modules experimental, ERROR/WARN log trong
`audit.service.spec.ts` là dữ liệu test listener/alert cố ý — suite vẫn PASS.

### Case 3 — integration test trên Mongo/Redis thật (port 27117/6479), sau khi bổ sung 1 test concurrency
`pnpm test:int` (be/)

```text
PASS test/clients.int-spec.ts (15.81 s)   ← 30 test (29 gốc + 1 test mới DEBT-021)
PASS test/ui-auth.int-spec.ts
PASS test/sessions.int-spec.ts
PASS test/authentication.int-spec.ts
PASS test/tenant-context.int-spec.ts
PASS test/indexes.int-spec.ts
PASS test/identity.int-spec.ts
PASS test/ui.int-spec.ts
PASS test/mailer.int-spec.ts
PASS test/rate-limit.int-spec.ts

Test Suites: 10 passed, 10 total
Tests:       139 passed, 139 total
Time:        36.373 s
```

### Case 4 — chạy riêng `clients.int-spec.ts` để xác nhận test mới
`node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --testRegex "clients\.int-spec\.ts$"`

```text
PASS test/clients.int-spec.ts (12.848 s)
  B3.1 — Client creation + redirect_uri validation (7 test)
  B3.2 — Resources + allowedResources mapping (tech-lead C3) (5 test)
  B3.3 — Client authentication for /token (tech-lead C4/C6) (10 test, gồm test mới
    "two concurrent rotateSecret calls on the same client can both succeed with a duplicate
    version (DEBT-021, not a security bypass)")
  B3.4 — dynamic CORS origin resolution (D8, §9.7) (7 test)

Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
```
(Sau khi thêm test này vào file, tổng `clients.int-spec.ts` là 30 test — khớp số liệu Case 3.)

## Việc bổ sung của tester
Review toàn bộ acceptance criteria tasks.md + C1–C6 tech-lead + review-senior.md, đối chiếu với code thật
(`client.service.ts`, `client-credential.service.ts`, `client-authentication.service.ts`, `client-cors.service.ts`,
`resource.service.ts`, `redirect-uri.validator.ts`, `resource.validator.ts`, schema) và với
`test/clients.int-spec.ts` (29 test gốc) + `redirect-uri.validator.spec.ts` (16 test unit). Dev/senior đã cover rất
đầy đủ các case nghiệm thu B3.1–B3.4 (biến thể redirect_uri, mapping resource↔resourceId, sai method/timing
anti-enumeration, CORS per-client/union/exact-match). Gap duy nhất tìm được là **risk matrix State: concurrent**
cho `rotateSecret` (đã được senior ghi DEBT-021 nhưng chưa có test thực chạy để xác nhận hành vi quan sát được) —
đã bổ sung 1 test integration chạy `Promise.all` 2 lời gọi `rotateSecret` đồng thời trên cùng `clientId`, xác nhận:
- Không phải security bypass: cả 2 secret phát hành vẫn chỉ xác thực đúng `rotating-concurrent`, không rò sang
  client khác.
- Đúng như DEBT-021 đã nêu: cả 2 lời gọi đều thành công (race do thiếu unique index `(clientId, version)`), không
  có lời gọi nào bị reject — ghi rõ trong tên test để không bị hiểu nhầm là bug bảo mật, chỉ là debt dữ liệu.
Không sửa code sản phẩm nào; chỉ thêm test.

## Test FAIL
Không có.

## Coverage acceptance criteria (tasks.md)

### B3.1 — Clients + ClientCredential + validator redirect_uri
- [x] Slash cuối bị từ chối khi match → `redirect-uri.validator.spec.ts` "rejects a trailing slash variant"
  (`isRegisteredRedirectUri`).
- [x] Query lạ bị từ chối → cùng spec "rejects an extra query string".
- [x] Wildcard (subdomain + path) bị từ chối ở format-time → `redirect-uri.validator.spec.ts` "rejects a wildcard
  anywhere..." + `clients.int-spec.ts` "rejects redirect_uri variant: wildcard subdomain/path" (qua `ClientService.create`).
- [x] Subdomain variant bị từ chối ở match-time → spec "rejects a subdomain variant".
- [x] Fragment bị từ chối → spec "rejects a fragment" + int "rejects redirect_uri variant: fragment".
- [x] `http` non-localhost ở production bị từ chối (và cả ngoài production) → spec "rejects non-https schemes",
  "still rejects http on a non-localhost host"; int "http://localhost allowed outside production, rejected when
  NODE_ENV=production (tech-lead C1)" — xác nhận cả 2 chiều env.
- [x] Rotation overlap/grace → int "rotation overlap: previous secret still authenticates during grace..." +
  "revoked secret can no longer authenticate even inside the grace window".

### B3.2 — Resources + allowedResources + validator resource
- [x] Resource ngoài allowedResources bị reject → int "rejects a resource URI whose resourceId is not in
  allowedResources".
- [x] Mapping identifier(URI)→resourceId đúng (không so URI trực tiếp) → int "resolves an allowed resource URI to
  its Resource (by resourceId, not raw URI)"; code `resource.service.ts.resolveForClient` tra `identifier` trước.
- [x] URI chưa đăng ký hoàn toàn → int "rejects an unregistered resource URI entirely".
- [x] Format sai (fragment/non-absolute) → int "rejects a resource with a fragment or non-absolute URI".

### B3.3 — Client authentication cho /token
- [x] Sai method so với `token_endpoint_auth_method` → `invalid_client` → int "method mismatch...", "public client
  cannot authenticate via client_secret_post...".
- [x] Secret so sánh an toàn (Argon2id verify, không `constantTimeEqual` tách riêng — đã ghi rõ trong code/docblock
  theo C6) → `client-credential.service.ts.verifySecret` dùng `verifyPassword`; int "confidential client with
  correct secret authenticates", "wrong secret → InvalidClientError".
- [x] Overlap version (nhiều credential còn hiệu lực) → int "rotation overlap..." (đã liệt ở B3.1).
- [x] Unknown client không rò timing → `verifySecret` luôn chạy Argon2 verify (dummy hash khi `active.length===0`),
  không short-circuit qua `Promise.all`; int "unknown client_id → InvalidClientError (does not throw/leak a
  different error)". **Giới hạn đã biết**: chưa có benchmark timing thực tế đo chênh lệch ms — đúng như senior
  review đã chấp nhận ở mức B3 (đo timing thuộc security test matrix §14, ngoài phạm vi B3; không phải việc của B3).
- [x] **(tester bổ sung)** Concurrent rotation trên cùng client (risk matrix State) → test mới, xem mục "Việc bổ
  sung của tester". Không phải security bypass; version có thể trùng (DEBT-021, đã ghi).

### B3.4 — CORS động (D8)
- [x] Origin lạ bị chặn (per-client) → int "rejects an unknown origin and an unknown client".
- [x] Per-client vs union allowlist → int "rejects an origin not registered for that client (even if another client
  has it)" (per-client) vs "union allowlist accepts an origin registered by any client" (union).
- [x] Exact match (không trailing slash, không port khác) → int "matches exact origin only — a trailing slash or
  different port is not a match".
- [x] Union allowlist reject origin không ai đăng ký → int "union allowlist rejects an origin registered by no
  client".
- [ ] Preflight HTTP thật (`OPTIONS` request/response header) — **chưa áp dụng ở B3.4**: tasks.md B3.4 chỉ yêu cầu
  primitive `ClientCorsService` (per-client/union lookup), chưa wire HTTP (`/token`/`/userinfo`/`/jwks.json` chưa
  tồn tại, là B4). Senior review đã xác nhận đúng scope, ghi DEBT-019 cho việc wire `@fastify/cors` ở B4. Không phải
  gap test — là gap tính năng đã biết, nằm ngoài B3.4.

## Coverage security invariants / risk matrix
- [x] INV-4/INV-21 (redirect_uri exact match, no wildcard/fragment) — bao phủ đầy đủ ở trên.
- [x] INV-14 (resource phải thuộc allowedResources qua resourceId) — bao phủ đầy đủ ở trên.
- [x] INV-18 (chỉ lưu secretHash, không log secret raw) — xác nhận bằng đọc code: `ClientCredential` chỉ có
  `secretHash`; `InvalidClientError` message cố định không echo secret/client_id (đọc `client-authentication.service.ts`).
- [x] Identity/Credential dimension — absent (unknown client_id), valid (đúng secret/version), malformed (secret
  sai), revoked (`revokeSecret`), đã test ở B3.3.
- [x] State dimension — fresh (secret mới), stale/already-rotated (grace), **concurrent (test mới của tester)**.
- [x] Authorization/cross-tenant — "secret of a different client never authenticates another client_id" (negative
  actor test, non-owner secret không cross sang client khác).
- [x] Exposure — đọc code xác nhận `InvalidClientError` message cố định, không log secret; `ClientCredential` schema
  chỉ lưu hash.
- DEBT đã biết (không chặn PASS, đã ghi rõ lý do bởi senior + xác nhận lại bởi tester bằng test thực chạy):
  - DEBT-019 (`@fastify/cors` chưa wire) — đúng scope B3.4, impact là B4 phải nhớ wire, không ảnh hưởng B3.
  - DEBT-020 (thiếu index `allowedCorsOrigins`) — vấn đề hiệu năng khi có traffic thật, không phải security bypass.
  - DEBT-021 (rotateSecret không atomic) — **tester đã viết test xác nhận hành vi thực tế**: không phải security
    bypass (secret vẫn phân biệt đúng theo hash, không rò sang client khác), chỉ là version có thể trùng dưới
    concurrent rotation hiếm gặp (admin action, không phải request-path công khai).

## Kết luận
Không có case nghiệm thu nào trong tasks.md B3.1–B3.4 thiếu bằng chứng test thật. 1 gap (concurrent rotation) được
tester tự viết bổ sung và PASS, xác nhận đúng mức độ rủi ro đã ghi trong backlog (DEBT-021), không phát sinh
blocker mới. PASS — bàn giao orchestrator đóng run.

