# Test Report — 2026-09-30
## Kết quả: PASS (123/123 test)

## Lệnh đã chạy + output thực tế

### Case 1 — CodeGraph preflight/sync
`codegraph --version && codegraph status && codegraph sync`

```text
1.5.0
Project: E:\projects\self\veyrigate
Files: 145; Nodes: 2,033; Edges: 5,161
✓ Index is up to date
● Already up to date
└ Done
```

### Case 2 — lint, typecheck, build
`pnpm lint && pnpm typecheck && pnpm --filter @sso-idp/be build`

```text
be lint$ eslint src
└─ Done in 4.9s
fe-admin/fe-sso-test: placeholder lint scripts completed.
be typecheck$ tsc --noEmit
└─ Done in 9.7s
fe-admin/fe-sso-test: placeholder typecheck scripts completed.
$ tailwindcss -i src/styles.css -o src/public/styles.css --minify
≈ tailwindcss v4.1.14
Done in 89ms
$ nest build
Exit code: 0
```

### Case 3 — invocation sai, không tính gate
`pnpm --filter @sso-idp/be test -- --runInBand`

```text
No tests found, exiting with code 1
Pattern: --runInBand - 0 matches
```

Nguyên nhân: dấu `--` bị truyền thành pattern literal cho Jest. Đã chạy lại đúng ở Case 4.

### Case 4 — unit
`pnpm --filter @sso-idp/be test --runInBand`

```text
PASS src/modules/authentication/authentication.service.spec.ts
PASS src/modules/mailer/mailer.spec.ts
PASS src/modules/ui/csrf.service.spec.ts
PASS src/modules/keys/keys.spec.ts
PASS src/modules/sessions/session.cookie.spec.ts
PASS src/modules/security/audit/audit.service.spec.ts
PASS src/common/logger/logger.module.spec.ts
PASS src/config/validation.schema.spec.ts
PASS src/common/crypto/crypto.util.spec.ts
PASS src/modules/ui/return-to.spec.ts
PASS src/common/crypto/pkce.util.spec.ts
Test Suites: 11 passed, 11 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        17.899 s
Ran all test suites.
```

Cảnh báo không chặn: Jest 30 chưa nằm trong dải version được `ts-jest` 29 kiểm chứng; Node báo VM Modules experimental. Log ERROR/WARN trong `audit.service.spec.ts` là dữ liệu test listener/alert và suite vẫn PASS.

### Case 5 — integration
`pnpm --filter @sso-idp/be test:int`

```text
PASS test/ui-auth.int-spec.ts (8.822 s)
PASS test/sessions.int-spec.ts
PASS test/authentication.int-spec.ts
PASS test/indexes.int-spec.ts
PASS test/identity.int-spec.ts
PASS test/tenant-context.int-spec.ts
PASS test/ui.int-spec.ts
PASS test/mailer.int-spec.ts
PASS test/rate-limit.int-spec.ts
Test Suites: 9 passed, 9 total
Tests:       75 passed, 75 total
Snapshots:   0 total
Time:        24.779 s
Ran all test suites.
```

### Case 6 — whitespace
`git diff --check`

```text
Exit code: 0
warning: STATUS.md and run 05 summary CRLF will be replaced by LF when Git next touches them.
```

## Test FAIL
- Không có lỗi sản phẩm. Case 3 là lỗi cú pháp gọi lệnh và đã được thay bằng Case 4 PASS.

## Coverage acceptance criteria
- [x] B2.4 / INV-27 — unit generic login; integration register race, reset token 2 request/1 success, 10 login sai đồng thời và lock audit một lần.
- [x] B2.4 HTTP/rate limit — `ui-auth.int-spec.ts` gửi 10 POST `/login` đồng thời qua controller + `RateLimitService` thật; 10×401, counter = 10.
- [x] B2.4 token/mail — GET không consume, atomic reset, link từ `ISSUER`, hash/single-use và pre-account recovery/revoke-all.
- [x] B2.4 session/audit — session mới sau login; `SESSION_CREATED`/`SESSION_REVOKED`; audit metadata secret filtering.
- [x] B2.5 CSRF — bảng 6 POST xác nhận cả missing và wrong token đều 403 HTML trước side effect.
- [x] B2.5 logout — GET giữ Redis session; POST CSRF revoke session, clear cookie, redirect và ghi audit; no-session idempotent contract.
- [x] B2.5 full flow — HTTP register → mail link → GET verify không consume → POST verify → login → Redis session → GET logout no-op → POST logout revoke.
- [x] C1 — logger serializer bỏ query/token; Referrer-Policy `no-referrer`.
- [x] C2 — verify/reset GET chỉ render escaped hidden token; consume ở POST; password validate trước consume.
- [x] C3 — reset xác minh email, reset failures, revoke all sessions.
- [x] C4 — mail link dùng `ISSUER`, không dùng host request.
- [x] C5 — generic register/forgot behavior và expensive-work paths được unit/integration kiểm; mail chạy async.
- [x] C6 — update atomic, 10 request service + HTTP concurrency, một lock audit.
- [x] C7 — CSRF HMAC binding/constant-time behavior; anonymous/session cookie; mọi POST gồm login.
- [x] C8 — dependencies/assets và CSS build + Nest build PASS.
- [x] C9 — CSP cụ thể, không `unsafe-inline`, HTML không inline script/style, escaping token.
- [x] C10 — chặn `https://evil`, `//evil`, `/\\evil`, CRLF và `javascript:`; internal return path hoạt động.
- [x] C11 — UI lỗi là HTML; OAuth route vẫn JSON OAuth; validation không lộ field.
- [x] C12 — DTO email/password validation được HTTP test kiểm.
- [x] C13 — audit login/session/lock; secret metadata bị loại; missing-user login không cần target.
- [x] C14 — GET logout không revoke; POST revoke/clear/audit/302; không session vẫn 302.

## Ghi chú artifact
- `be/test/ui-auth.e2e-int-spec.ts` dư/stale đã bị edit đồng thời tạo lại sau hai lần tester xoá, nên DEBT-018 vẫn mở. File này không khớp regex và không được tính coverage. Coverage request flow chỉ tính từ `be/test/ui-auth.int-spec.ts`, được Jest integration thu thập và PASS ở Case 5.