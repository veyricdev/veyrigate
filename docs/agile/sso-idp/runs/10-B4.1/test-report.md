# Test Report — 2026-10-07 — Run 10 — B4.1 (`/authorize`)

## Kết quả: PASS (233/233 test)

## Môi trường
- `vg-test-mongo` (27117, rs0) + `vg-test-redis` (6479) — đã Up từ trước, không cần restart.
- PowerShell: gọi `& pnpm.cmd ...` (không `pnpm` trực tiếp, bị policy chặn `.ps1`).
- `pnpm.cmd test` (unit) và `pnpm.cmd test:int` (integration, dùng Mongo/Redis test container trên).

## Lệnh đã chạy + output thực tế

### 1. Unit — `pnpm.cmd test`
```
Test Suites: 12 passed, 12 total
Tests:       67 passed, 67 total
Time:        15.64 s
EXITCODE=0
```

### 2. Integration — `pnpm.cmd test:int` (trước khi thêm test)
```
PASS test/authorize.int-spec.ts (9.908 s)
PASS test/ui-auth.int-spec.ts
PASS test/clients.int-spec.ts
PASS test/authentication.int-spec.ts
PASS test/sessions.int-spec.ts
PASS test/indexes.int-spec.ts
PASS test/tenant-context.int-spec.ts
PASS test/identity.int-spec.ts
PASS test/ui.int-spec.ts
PASS test/mailer.int-spec.ts
PASS test/rate-limit.int-spec.ts

Test Suites: 11 passed, 11 total
Tests:       164 passed, 164 total
Time:        33.535 s
EXITCODE=0
```

### 3. Rà soát coverage → phát hiện 2 gap trong `authorize.int-spec.ts` (không phải lỗi code, chỉ
   thiếu test), tự viết thêm test HTTP-level (`app.inject`), theo đúng pattern test resume hiện có
   trong cùng file. KHÔNG sửa code production.

Test mới thêm (trong `describe('Authorize HTTP flow via AuthorizeController ...')`):
1. **`response_type != code => 302 redirect with error=unsupported_response_type (AC8)`** — AC8
   trước đó chỉ có test ở service-level (`rejects response_type other than code`, dùng
   `AuthorizeService.handle()` trực tiếp), chưa có test xác nhận hành vi HTTP thật (302 +
   `Location` kèm `error`/`state`/`iss`) qua `app.inject`.
2. **`prompt=none with no session => 302 redirect with error=login_required, state, iss (AC9)`** —
   tương tự, AC9 trước đó chỉ có test service-level (`returns login_required (OAuth error) when
   not signed in`), chưa có test HTTP-level xác nhận đúng redirect 302 (không phải JSON hay 200).
3. Bổ sung assertion `error_description` (RFC 9207 đầy đủ — `error`, `error_description`, `state`,
   `iss`) vào test PKCE-plain HTTP-level đã có sẵn (`PKCE plain => 302 redirect ...`) — trước đó
   test chỉ assert `error=invalid_request` + `state` + `iss`, thiếu `error_description` dù AC2 yêu
   cầu đủ 4 trường.

### 4. Integration — `pnpm.cmd test:int` (sau khi thêm test, full suite, để xác nhận không vỡ
   regression)
```
PASS test/authorize.int-spec.ts (16.828 s)
PASS test/ui-auth.int-spec.ts
PASS test/clients.int-spec.ts
PASS test/sessions.int-spec.ts
PASS test/authentication.int-spec.ts
PASS test/identity.int-spec.ts
PASS test/tenant-context.int-spec.ts
PASS test/indexes.int-spec.ts
PASS test/ui.int-spec.ts
PASS test/mailer.int-spec.ts
PASS test/rate-limit.int-spec.ts

Test Suites: 11 passed, 11 total
Tests:       166 passed, 166 total
Time:        48.523 s
EXITCODE=0
```

### 5. `authorize.int-spec.ts` riêng, `--verbose` (liệt kê đủ tên test, 27/27 PASS — 25 cũ + 2 mới)
```
Authorize (/authorize) on real Mongo + Redis (B4.1, spec §9.1-9.2)
  open-redirect boundary (INV-3)
    √ throws AuthorizeErrorPage (no redirect) for an unknown client_id
    √ throws AuthorizeErrorPage (no redirect) for a redirect_uri not registered
    √ rejects a redirect_uri that only differs by a trailing slash (exact match)
  post-redirect OAuth errors (redirect_uri already trusted)
    √ rejects PKCE plain with invalid_request (not an error page)
    √ rejects a missing code_challenge_method (S256 mandatory)
    √ rejects response_type other than code
    √ rejects an unknown resource with invalid_target
    √ rejects a scope not registered for the client
    √ rejects a malformed max_age
  prompt=none
    √ returns login_required (OAuth error) when not signed in
    √ is rejected when combined with other prompt values
  happy path + AuthorizeRequestContext
    √ not signed in => login_required with a resumable request_id, context persisted
    √ signed in + valid => ready; context echoes state/nonce; request_id != state (C8)
    √ resolves resource via identifier->resourceId, never the URI directly
    √ writes an OAUTH_AUTHORIZE audit event without sensitive values
  AuthorizeRequestContext single-use + TTL
    √ consume is single-use: a second consume returns null
    √ two concurrent consumes of the same request_id: exactly one wins
    √ context expires after its TTL
    √ request_id is opaque and unrelated to the RP state
Authorize HTTP flow via AuthorizeController (B4.1, senior blocker)
  √ no session => 302 to /login with a resumable request_id in returnTo
  √ login then resume via request_id => 200 ready page (context not lost)
  √ resume with an unknown request_id => 400 error page (never a redirect)
  √ unknown client_id (no session) => 400 error page, no redirect (open-redirect safe)
  √ PKCE plain => 302 redirect to redirect_uri with error=invalid_request + iss
  √ response_type != code => 302 redirect with error=unsupported_response_type (AC8)      [MỚI]
  √ prompt=none with no session => 302 redirect with error=login_required, state, iss (AC9) [MỚI]
  √ resume whose Phase 2 fails (scope narrowed after context creation) => 302 redirect ...

Test Suites: 1 passed, 1 total
Tests:       27 passed, 27 total
```

## Số liệu tổng
- Unit: 67/67 PASS.
- Integration: 166/166 PASS (164 trước + 2 test mới), 11 suite, không suite nào skip.
- `authorize.int-spec.ts` riêng: 27/27 PASS (25 có từ dev/senior + 2 tester thêm).
- Không có test FAIL.

## Coverage acceptance criteria (spec §9.2, INV-3/4/14/15, tasks.md)

| # | AC | Test | Kết quả |
|---|---|---|---|
| 1 | Open-redirect (INV-3): `client_id` lạ / `redirect_uri` sai exact-match → trang lỗi, KHÔNG redirect | Service: `throws AuthorizeErrorPage ... unknown client_id`, `... redirect_uri not registered`, `... trailing slash`. HTTP: `unknown client_id (no session) => 400 error page, no redirect` (assert `headers['location']` undefined) | PASS |
| 2 | Sau khi redirect_uri trusted → lỗi OAuth qua redirect kèm `error`,`error_description`,`state`,`iss` | HTTP: `PKCE plain => 302 redirect ...` (đã bổ sung assert `error_description` ở vòng này), `response_type != code => 302 ... (AC8)` [mới], `prompt=none ... (AC9)` [mới], `resume whose Phase 2 fails ... never a 500` (đủ cả 4 field) | PASS |
| 3 | PKCE `plain` (hoặc thiếu `code_challenge_method`) → bị từ chối | Service: `rejects PKCE plain ...`, `rejects a missing code_challenge_method ...`. HTTP: `PKCE plain => 302 redirect ...` | PASS |
| 4 | `resource` lạ (không ∈ `allowedResources`) bị từ chối; map identifier→resourceId, không so URI trực tiếp | Service: `rejects an unknown resource with invalid_target`, `resolves resource via identifier->resourceId, never the URI directly` | PASS |
| 5 | `state`/`nonce` echo nguyên vẹn | Service: `signed in + valid => ready; context echoes state/nonce ...`, `request_id is opaque and unrelated to the RP state`. HTTP: mọi test redirect đều assert `state=rp-state` | PASS |
| 6 | Context single-use + hết hạn: replay/expired `request_id` → trang lỗi, không redirect | Service: `consume is single-use ...`, `two concurrent consumes ... exactly one wins`, `context expires after its TTL`. HTTP: `resume with an unknown request_id => 400 error page (never a redirect)` | PASS |
| 7 | Nhánh resume (login→resume) Phase 2 fail → 302 redirect error, KHÔNG 500 (blocker đã fix) | HTTP: `resume whose Phase 2 fails (scope narrowed after context creation) => 302 redirect with error/state/iss, never a 500` — xác nhận lại bằng test thật, PASS | PASS |
| 8 | `response_type != code` → `unsupported_response_type` qua redirect | Service: `rejects response_type other than code`. HTTP: `response_type != code => 302 redirect with error=unsupported_response_type (AC8)` **[test tester thêm — gap trước đó chỉ có service-level]** | PASS |
| 9 | `prompt=none` khi cần tương tác → `login_required` qua redirect | Service: `returns login_required (OAuth error) when not signed in`. HTTP: `prompt=none with no session => 302 redirect with error=login_required, state, iss (AC9)` **[test tester thêm — gap trước đó chỉ có service-level]** | PASS |

## Coverage security invariants / risk matrix

| Chiều | Trường hợp kiểm | Test | Kết quả |
|---|---|---|---|
| Identity | anonymous (chưa login) vs user đã login | `no session => 302 to /login`, `login then resume ... => 200 ready page` | PASS |
| Credential | session cookie hợp lệ vs thiếu | HTTP resume có cookie `SESSION_COOKIE` vs không | PASS |
| Authorization (client trust boundary) | `client_id` lạ (không-owner/không-registered) → không được redirect tới `redirect_uri` tùy ý | `unknown client_id (no session) => 400, no redirect` + service-level unknown client/unregistered redirect_uri | PASS |
| Input | valid, boundary (`redirect_uri` lệch `/` cuối), malformed (`max_age=-5`, `code_challenge` thiếu/malformed), encoded (resource identifier URI vs resourceId) | `trailing slash (exact match)`, `rejects a malformed max_age`, `rejects a missing code_challenge_method`, `resolves resource via identifier->resourceId` | PASS |
| State | fresh context, stale/expired, already-consumed (single-use), concurrent consume | `consume is single-use`, `two concurrent consumes ... exactly one wins`, `context expires after its TTL`, `resume with an unknown request_id => 400` | PASS |
| Request chain | initial `/authorize` → redirect `/login` → callback resume `/authorize?request_id=...` → next request sau khi context đã consumed | `login then resume via request_id => 200`, `resume with an unknown request_id => 400`, `resume whose Phase 2 fails ... 302, never 500` | PASS |
| Exposure | `code_challenge`/`nonce` không lọt vào audit log; `request_id` không chứa `state` của RP (tránh thoát qua URL/log) | `writes an OAUTH_AUTHORIZE audit event without sensitive values` (assert log không chứa `VALID_CHALLENGE`/`rp-nonce`), `request_id is opaque and unrelated to the RP state` | PASS |

## Ghi chú
- Không phát hiện FAIL thật nào trong code sản phẩm; 2 gap tìm thấy là **thiếu test HTTP-level**
  cho AC8/AC9 (logic đã đúng ở service-level, senior review đã verify PKCE-plain/open-redirect
  bằng `curl` tay nhưng chưa có test tự động HTTP cho AC8/AC9) — tester bổ sung test, không sửa
  `authorize.service.ts`/`authorize.controller.ts`.
- Không phát sinh 🟡 debt mới — đây là gap coverage test, không phải hành vi sai của code.
- Vệ sinh: không tạo `be/body.json`/`be/cookies.txt`; mọi output tạm (`$env:TEMP\...`) đã xoá sau
  khi đọc; `git status` không có artifact ngoài file test/code đang review của run này.

