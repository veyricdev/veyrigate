# Test Report — 2026-10-22 — run 42 (A4 đăng nhập BFF fe-admin)

## Kết quả: PASS

- fe-admin unit/int: **237/237** (13 file; 206 cũ + **31 mới** trong `fe-admin/test/bff-risk.test.ts`).
- E2E full: **25/25 × 2 lần liên tiếp** (23 cũ + **2 mới** trong `e2e/tests/fe-admin-risk.spec.ts`).
- Root: be 401/401, fe-sso-test 269/269, fe-admin 237/237. Lint/typecheck/build/check:bundle xanh. Audit high: 0.
- Không có test FAIL. Không lỗi [FE]/[BE]/[E2E] chặn. 1 💭 mới: DEBT-289.

## Lệnh đã chạy + output thực tế

Hạ tầng: Docker đã chạy sẵn (`vg-test-redis`, `vg-test-mongo`, `aegate-mongo`, `aegate-redis`, `veyrigate-mailpit-1` đều Up). :3000/:4000/:5173 trống trước mỗi lần chạy (không phải dừng process nào của người khác).

| Lệnh | Kết quả |
|---|---|
| `pnpm -C fe-admin typecheck` | exit 0 |
| `pnpm -C fe-admin lint` | exit 0 |
| `pnpm -C fe-admin test` (trước khi thêm test) | `Test Files 12 passed (12)` / `Tests 206 passed (206)` |
| `pnpm -C fe-admin test` (sau khi thêm test) | `Test Files 13 passed (13)` / `Tests 237 passed (237)` |
| `pnpm -C fe-admin build` | exit 0 |
| `pnpm -C fe-admin check:bundle` | `check:bundle scanned 3 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| `pnpm lint` (root) | exit 0 |
| `pnpm -r run typecheck` | fe-sso-test / e2e / fe-admin / be: Done, exit 0 |
| `pnpm test` (root) | be `Tests: 401 passed, 401 total` (32 suites); fe-sso-test `Tests 269 passed (269)`; fe-admin `Tests 237 passed (237)`; exit 0 |
| `pnpm audit --audit-level high` | `2 vulnerabilities found — Severity: 1 low \| 1 moderate — 1 ignored: 1 high` (cái ignored có sẵn), exit 0 |
| `pnpm -C e2e exec playwright test tests/fe-admin-risk.spec.ts` (thử riêng) | `2 passed (1.1m)` |
| `pnpm -C e2e e2e` lần 1 | `25 passed (2.0m)`, exit 0 |
| `pnpm -C e2e e2e` lần 2 | `25 passed (2.0m)`, exit 0 |

4 test fe-admin trong E2E (cả 2 lần đều `ok`): `fe-admin.spec.ts` (login thật / no token / logout IdP; callback giả), `fe-admin-risk.spec.ts` (non-admin 403 + replay callback thật; step-up đổi user).

Grep rò rỉ trên log E2E (`e2e1.log`, `e2e2.log`, gồm stdout webServer BE/fe-admin): `eyJ`=0, `code=`=0, `state=`=0, chuỗi secret E2E (`E2E_FE_ADMIN_SECRET`, mật khẩu admin E2E, `SESSION_SECRET` E2E)=0, mật khẩu dev seed (đọc từ `e2e/.env`, không in)=0. `e2e/test-results` rỗng, không có `playwright-report` (reporter `list`).

### Smoke Redis chết (fe-admin dev thật, `SESSION_REDIS_URL=redis://127.0.0.1:6391/2` — cổng đóng; BE không chạy)

| Request | Kết quả thực tế |
|---|---|
| `GET /` không cookie | `307` → `/auth/login?returnTo=%2F` (đúng: không cookie ⇒ không gọi Redis) |
| `GET /` + `fea_sid=abc` | **`500`**, KHÔNG `location`, KHÔNG `set-cookie`; body chỉ có `Service unavailable (request id …)`; không `ECONNREFUSED`/`ioredis`/`6391`/`eyJ` |
| `GET /auth/login?stepup=1` + cookie | `503` "Service temporarily unavailable", không redirect, không lộ chi tiết |
| `POST /auth/logout` same-origin + cookie | `500` generic + `set-cookie: fea_sid=; … Max-Age=0` (discovery cũng chết vì BE tắt) |
| Log server | `[fe-admin] … failed, request id <uuid>: SessionUnavailableError: Session store unavailable (cause: …)` — không token/cookie |

⇒ Không redirect login, không xoá cookie khi đọc phiên lỗi, không lộ lỗi: **đạt**. Status SSR 500 thay vì 503 = DEBT-282 (đã biết). Logout khi IdP không tới được ⇒ 500 thay vì 503 ⇒ **DEBT-289 💭** (an toàn vẫn đúng: cookie bị xoá). Process dev đã dừng (PID vite do tester khởi động), :3000 trống.

### Mutation kiểm chứng test mới (cp + sha256, khôi phục bằng cp, `sha256sum -c` OK; không git checkout)

| Đột biến | Kết quả |
|---|---|
| `store.takeTx`: `GETDEL` → `GET` (tx không single-use) | RED 2 test (callback song song; thiếu code ⇒ tx đã tiêu) |
| callback: bỏ `sanitizeReturnTo` khi đọc `tx.returnTo` | RED 1 test (returnTo bị sửa trong Redis) |
| refresh: bỏ qua kết quả `update` XX (hồi sinh phiên) | RED 1 test (logout thật xen giữa refresh) |

## Test FAIL

Không có.

## Test mới

`fe-admin/test/bff-risk.test.ts` (31 test, fake IdP + Redis thật `vg-test-redis@6479`, chỉ DEL key của mình):
1. 5 callback **song song** cùng `state`+cookie ⇒ đúng 1 phiên, 1 lần đổi code, 4 cái 400 không `fea_sid`.
2. Hai tab: `fea_tx` bị login thứ 2 ghi đè ⇒ callback tab 1 bị từ chối (0 lần `/token`), tab 2 thành công.
3. `state` rỗng + `fea_tx` rỗng ⇒ từ chối.
4. Thiếu `code` với `state` hợp lệ ⇒ từ chối và tx đã tiêu (lần 2 cũng từ chối, 0 `/token`).
5. `returnTo` bị sửa trực tiếp trong tx Redis (`//evil.com`) ⇒ callback vẫn về `/`.
6. returnTo biến thể (15): `/%5Cevil.com`, `/%5cevil.com`, `/\tevil.com`, `/\u0000x`, `/\u0085x`, `\\evil.com`, `http:/evil.com`, `javascript:alert(1)`, `""`, `/%2e%2e/auth/logout`, `/./auth/login`, `/auth%2Flogout`, `/auth?x=1` ⇒ `/`; biên 512 ký tự được giữ; `/users?next=//evil.com` giữ nguyên nhưng resolve cùng origin. + `returnTo` lặp: chỉ lấy cái đầu và vẫn validate.
7. Cookie phiên hợp lệ sửa 1 ký tự ⇒ null + xoá cookie, phiên thật **không bị đụng**.
8. Cookie đoán/dị dạng (`0`, 43×`a`, 4096 ký tự, `%00`, SQL-ish, `fea:sess:*`) ⇒ null, không ném, không ghi Redis.
9. Cookie từ triển khai khác `SESSION_SECRET` (HMAC sai) ⇒ không truy cập được phiên.
10. Ciphertext chép từ phiên B sang key A ⇒ không giải mã (AAD), key A bị xoá.
11. Idle: Redis hết TTL ⇒ viewer null + xoá cookie, không refresh.
12. Absolute: còn 1' trước 8h vẫn sống (TTL ≤ 60s), quá 8h ⇒ null, key xoá, không gọi refresh.
13. **POST /auth/logout thật** trong khi refresh đang bay ⇒ 303 có hint, key không hồi sinh, revoke 2 lần (RT cũ do logout, RT mới do refresh XX trượt), cookie cũ quay lại vẫn null.
14. Logout lặp cùng cookie ⇒ 303 end_session không hint, không revoke lần 2.
15. Step-up khi phiên cũ đã bị logout ở tab khác ⇒ phiên mới cùng user, về `returnTo`.
16. Step-up tx dùng không kèm cookie phiên nạn nhân, đăng nhập user khác ⇒ 403 "ended for security reasons", phiên nạn nhân bị huỷ, không tạo phiên mới.

`e2e/tests/fe-admin-risk.spec.ts` (2 test, IdP + fe-admin thật):
1. User dev seed (`DEV_SEED_EMAIL`, không vai trò admin) vào `/users?tab=1` ⇒ đăng nhập IdP + consent ⇒ về đúng `/users?tab=1` ⇒ trang **"Access denied"** (403) + email + nút Sign out trong main, không có Dashboard; SSR `/` cũng là 403, không `eyJ`; `fea_sid` httpOnly. **Replay URL callback thật** (code+state) trong cùng browser ⇒ 400 "Sign-in failed", không Set-Cookie `fea_sid`, phiên hiện tại giữ nguyên. Đăng xuất từ trang 403 ⇒ xác nhận IdP ⇒ form login IdP, cookie mất.
2. Admin đăng nhập ⇒ `/auth/login?stepup=1` ⇒ IdP hiện form login (prompt=login) ⇒ đăng nhập bằng **user dev khác** ⇒ trang lỗi "ended for security reasons", `fea_sid` bị xoá; cookie admin cũ gửi lại ⇒ guard 3xx `/auth/login`, HTML không chứa email admin (log BE: `/admin/me` 403 + 2 lần `/revoke`).

## Coverage acceptance criteria

- [x] Task 1 — session tạo/đọc/giả mạo/sửa ciphertext/idle/absolute/`update` sau `destroy`/key không chứa cookie/không `eyJ` trong Redis: `session-store.test.ts` (15) + bff-risk #7–#12; DEBT-274: `env*.test.ts`; DEBT-275 canary: `error-boundary.test.tsx` (9) + smoke Redis chết (không lộ chi tiết).
- [x] Task 2 — state sai/thiếu cookie/replay/iss sai-thiếu/nonce/aud/khoá lạ/none/HS256/hết hạn/sub≠/azp: `bff.test.ts`; replay **song song** + hai tab + tx bị sửa: bff-risk #1–#5; replay thật: E2E risk 1; returnTo: `bff.test.ts` + bff-risk #6; fixation: `bff.test.ts`.
- [x] Task 3 — refresh song song 1 lần `/token`, `invalid_grant`, 5xx giữ phiên, logout xen giữa: `bff.test.ts` + bff-risk #13; non-admin ⇒ 403: `auth-ui.test.tsx` + **E2E risk 1 (UI thật)**; step-up đổi user ⇒ cả hai phiên mất: `bff.test.ts` + bff-risk #16 + **E2E risk 2 (UI IdP thật)**.
- [x] Task 4 — logout chỉ POST, cross-site 403, 303 end_session + hint, post_logout từ env, Redis lỗi: `bff.test.ts` + bff-risk #14; E2E login/logout/no-token: `fe-admin.spec.ts`; E2E xanh 2 lần liên tiếp: 25/25 × 2; `admin-client.spec.ts` xanh khi fe-admin chạy :3000.
- [x] typecheck/lint/test/build/check:bundle fe-admin xanh.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | anonymous, admin, **user không vai trò (dev seed)**, user khác qua step-up | E2E fe-admin, E2E risk 1–2, bff-risk #16 |
| Credential (cookie phiên) | absent, valid, giả, **1 ký tự sai**, đoán/dị dạng/4KB, HMAC secret khác, ciphertext chép chéo, hết idle, hết absolute, sau logout (replayed) | bff-risk #7–#14, session-store |
| Authorization | non-admin ⇒ 403 UI; step-up khác sub/tenant ⇒ huỷ cả hai | E2E risk 1–2, bff.test |
| Input | returnTo 15 biến thể + lặp tham số; state rỗng; thiếu code | bff-risk #3–#6 |
| State | callback replay tuần tự + **song song (5)** + replay thật E2E; tx bị sửa; logout lặp | bff-risk #1, #4, #5, #14, E2E risk 1 |
| Concurrency | refresh song song (bff.test), **logout thật xen giữa refresh** | bff-risk #13 |
| Dependency | Redis chết (unit + smoke dev thật), IdP/discovery chết (smoke), `/admin/me` 5xx, `/userinfo` lỗi | bff.test, smoke ⇒ fail-closed, không redirect login, không lộ lỗi |
| Request chain | Set-Cookie clear sau step-up ⇒ request kế tiếp với cookie cũ ⇒ redirect login; logout ⇒ vào lại phải login IdP | E2E risk 2, E2E fe-admin |
| Exposure | HTML SSR / DOM / Web Storage / `/_serverFn` / log E2E / body lỗi: không `eyJ`/`code=`/`state=`/secret | E2E fe-admin, E2E risk 1, grep log, smoke |

## Debt

- Mới: **DEBT-289** 💭 [FE] — IdP/discovery không tới được ⇒ 500 thay vì 503 (an toàn vẫn đúng).
- Xác nhận còn mở: DEBT-282 (SSR 500 thay vì 503 khi Redis chết — tái hiện trong smoke), DEBT-283, DEBT-288.
