# Test Report — 2026-09-30
## Kết quả: PASS (144/144 test: unit 48/48 + integration 96/96)

## Lệnh đã chạy + output thực tế

### Case 1 — CodeGraph preflight
- `codegraph --version` → exit 0, `1.5.0`.
- `codegraph status` → exit 0, index 143 files / 2,004 nodes / 5,089 edges, `Index is up to date`.
- `codegraph sync` → exit 0, `Already up to date`.

### Case 2 — Focused UI acceptance contract
- Lệnh: `pnpm --filter @sso-idp/be test:int -- --runTestsByPath test/ui.int-spec.ts`
- Output cuối sau khi bổ sung regression test-only: exit 0; `PASS test/ui.int-spec.ts`; **1/1 suite, 43/43 tests**, 0 snapshots, 10.204 s.
- Bao phủ đủ 9 case `/`, `/login`, `/register` × live/absent/stale; 3 lookup-error; stale clear options/no revoke; redirect `302 → 200`; stale login/register form dùng anonymous CSRF và POST kế tiếp thành công; verify/reset/forgot/consent/logout không đi qua session classification mới.

### Case 3 — Redis/Mongo thật
- Lệnh: `pnpm --filter @sso-idp/be test:int -- --runTestsByPath test/ui-auth.int-spec.ts`
- Output: exit 0; `PASS test/ui-auth.int-spec.ts`; **1/1 suite, 3/3 tests**, 0 snapshots, 10.711 s.
- Case `classifies live and stale sessions through real Redis on guest-facing routes` PASS; luồng register/verify/login/logout thật PASS.

### Case 4 — Lint
- Lệnh: `pnpm --filter @sso-idp/be lint`
- Output: exit 0; `$ eslint src`; không có lỗi.

### Case 5 — Typecheck
- Lệnh cuối: `pnpm --filter @sso-idp/be typecheck`
- Output: exit 0; `$ tsc --noEmit`; không có lỗi.

### Case 6 — Build
- Lệnh: `pnpm --filter @sso-idp/be build`
- Output: exit 0; `tailwindcss v4.1.14`, `Done in 96ms`; `nest build` hoàn tất không lỗi.

### Case 7 — Toàn bộ unit
- Lệnh: `pnpm --filter @sso-idp/be test`
- Output: exit 0; **11/11 suites, 48/48 tests**, 0 snapshots, 15.603 s.

### Case 8 — Toàn bộ integration (lần cuối sau thay đổi test)
- Lệnh: `pnpm --filter @sso-idp/be test:int`
- Output: exit 0; **9/9 suites, 96/96 tests**, 0 snapshots, 24.707 s.
- PASS: `ui`, `ui-auth`, `sessions`, `authentication`, `indexes`, `identity`, `tenant-context`, `mailer`, `rate-limit`.
- Cảnh báo không-fatal quan sát được: `ts-jest` chưa công bố hỗ trợ Jest 30.0.5 và Node báo VM Modules experimental; không có test fail.

## Test FAIL

- Không có.

## Coverage acceptance criteria

- [x] AC1 — Case 2: đủ ma trận 9 tổ hợp; status/body/location đúng; live không clear, absent không lookup/clear, stale clear và không revoke.
- [x] AC2 — Case 2: cả ba lookup error trả 5xx, không location/clear/render; stale `/` follow tới login kết thúc `302 → 200`.
- [x] AC3 — Case 2 + review code: ba GET route await helper; lỗi lookup propagate; stale duy nhất clear cookie và xóa identity stale khỏi request; không guard/interceptor/revoke mới.
- [x] AC4 — Case 3: live và stale được xác minh qua `SessionService`/Redis thật trên cả ba route.
- [x] AC5 — Case 2, 7, 8: verify/reset/forgot/consent/logout regression PASS; unit và full integration PASS.
- [x] Cookie contract — Case 2: `idp_session`, `Max-Age=0`, `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure=false` theo test config; stale không revoke.
- [x] Stale form CSRF — Case 2: `/login` và `/register` stale phát anonymous cookie/token, browser bỏ session cookie, POST kế tiếp trả lần lượt 302 và 201.

## Thay đổi của tester

- Chỉ sửa test `be/test/ui.int-spec.ts`: thêm 5 characterization cases cho GET forgot/verify/reset/consent/logout với stale cookie. Không sửa production.