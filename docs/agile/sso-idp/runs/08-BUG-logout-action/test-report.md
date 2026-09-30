# Test Report — 2026-09-30
## Kết quả: PASS (173/173 test; focused 15/15, unit 48/48, integration 110/110)

> Tester evidence độc lập. RED evidence của backend-dev đã được thay thế theo giao thức ghi đè; lịch sử RED còn trong `log.md` mục backend-dev.

## Lệnh đã chạy + output thực tế

### 1. Preflight CodeGraph
`codegraph --version && codegraph status && codegraph sync`
```text
1.5.0
Project: E:\projects\self\veyrigate
Files: 143; Nodes: 2,005; Edges: 5,099; DB Size: 7.83 MB
✓ Index is up to date
Syncing CodeGraph — Already up to date — Done
Exit: 0
```

### 2. Focused acceptance/security matrix
`pnpm --filter @sso-idp/be test:int --runTestsByPath "$PWD/be/test/ui.int-spec.ts" -t "authenticated home exposes logout action|shared message outcomes retain login action|message template escapes dynamic content|authenticated GET logout|POST logout|cross-session CSRF replay"`
```text
PASS test/ui.int-spec.ts
Tests: 42 skipped, 15 passed, 57 total
Test Suites: 1 passed, 1 total
Time: 7.461 s
Exit: 0
```
15 case PASS: authenticated home; 4 shared outcomes; escaping; GET read-only; CSRF absent/malformed/cross-session; success ordering; get/revoke/audit failures; sequential retry.

### 3. Lint
`pnpm lint`
```text
Scope: 3 of 4 workspace projects
be lint$ eslint src — Done in 5.2s
fe-sso-test lint$ echo "[fe-sso-test] TODO: lint at T1"
fe-admin lint$ echo "[fe-admin] TODO: lint at A1"
Exit: 0
```

### 4. Typecheck
`pnpm typecheck`
```text
Scope: 3 of 4 workspace projects
be typecheck$ tsc --noEmit — Done in 3.6s
fe-sso-test typecheck$ echo "[fe-sso-test] TODO: typecheck at T1"
fe-admin typecheck$ echo "[fe-admin] TODO: typecheck at A1"
Exit: 0
```

### 5. Build
`pnpm --filter @sso-idp/be build`
```text
$ pnpm build:css && nest build
$ tailwindcss -i src/styles.css -o src/public/styles.css --minify
≈ tailwindcss v4.1.14 — Done in 105ms
Exit: 0
```

### 6. Unit
`pnpm --filter @sso-idp/be test --runInBand`
```text
PASS: mailer, keys, authentication, audit, session.cookie, logger,
csrf, validation.schema, crypto, return-to, pkce
Test Suites: 11 passed, 11 total
Tests: 48 passed, 48 total
Time: 17.643 s
Exit: 0
```

### 7. Full integration
`pnpm --filter @sso-idp/be test:int --runInBand`
```text
PASS: ui-auth, ui, sessions, authentication, indexes, identity,
tenant-context, mailer, rate-limit
Test Suites: 9 passed, 9 total
Tests: 110 passed, 110 total
Time: 25.652 s
Exit: 0
```

### 8. Diff hygiene
`git diff --check`
```text
Exit: 0
Warnings only: existing CRLF→LF notices for STATUS.md and run-05 summary.md.
```
Jest emitted only known non-failing Jest 30/ts-jest compatibility and VM Modules experimental warnings.

## Test FAIL
- Không có.

## Coverage acceptance criteria
- [x] AC1 — `authenticated home exposes logout action`: exactly one `/logout` link labeled `Sign out`, no `/login`; live session unchanged.
- [x] AC2 — `shared message outcomes retain login action for POST %s`: register/forgot/verify/reset each retain exactly one `/login` action labeled `Return to sign in`, no logout action.
- [x] AC3 — escaping case plus AC1 CSP assertions: malicious title/message escaped; no executable tags, inline script/style, or `unsafe-inline`; required self directives remain.
- [x] AC4 — GET logout and negative POST cases: semantic POST confirmation without mutation; absent, malformed, and A-under-B CSRF fail 403 before session/audit work.
- [x] AC5 — success/failure/retry: `get → revoke → audit`, cookie clear/fixed redirect/next request; all dependency failures and partial-state contract; sequential idempotent retry.
- [x] Regression — full UI 57/57, real UI-auth 3/3, all integration 110/110, unit 48/48.

## Coverage security invariants / risk matrix
| Chiều | Tổ hợp rủi ro đã kiểm | Bằng chứng |
|---|---|---|
| Identity | anonymous, authenticated owner, other session | shared outcomes; home/logout; cross-session replay |
| Credential | absent, valid, malformed, replayed | missing/invalid/cross-session CSRF and success |
| Authorization | owner vs non-owner identity binding | token A with cookie B returns 403 before lookup/mutation |
| Input | valid, malicious HTML, attacker redirect query | escaping; `returnTo=https://evil.example`, `redirect_uri=//evil.example` |
| State | live, revoked, retry, `revoked+unaudited` | success, failure matrix, retry |
| Dependency | healthy, get/revoke/audit failure | success and parameterized dependency-failure cases |
| Request chain | GET→POST, success→next GET, repeated POST | read-only GET, next login redirect, idempotent retry |
| Exposure | body, CSP/header, cookie header, Location | escaping/CSP; failures lack clear-cookie/Location/success; fixed local redirect |

- [x] GET is read-only: no revoke, audit, cookie clear, or redirect.
- [x] CSRF failures preserve both sessions and fail closed before lookup/mutation/audit.
- [x] Dependency failures are not masked as guest/not-found/success; audit failure preserves documented `revoked+unaudited` state without clear-cookie/redirect.
- [x] No session ID, CSRF/cookie value, dependency detail, or attacker URL is reflected into the tested response/redirect contract.
- [x] Concurrency not claimed: run contract explicitly scopes atomicity evidence to sequential retry; no blocking invariant is deferred.