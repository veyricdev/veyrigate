# Test Report — 2026-10-16 (run 24 — T3 + B6.5 + T4, Task 0–4)

## Kết quả: PASS (BE unit 211/211, BE int 507/507, FE vitest 187/187; typecheck/lint/build sạch)

Không có test FAIL. Không có lỗi gán [BE]/[FE]. E2E (T4) không chạy ở run này (tách sang run 25 theo `tasks.md`).

Hạ tầng: `docker start vg-test-mongo vg-test-redis` (container test có sẵn, @27117/@6479). KHÔNG `compose up`, KHÔNG FLUSH/drop DB dev/E2E (`aegate-*` không bị chạm). KHÔNG commit.

## Lệnh đã chạy + output thực tế

### Baseline (trước khi thêm test QA)
| Lệnh | Kết quả |
|---|---|
| `pnpm -C be typecheck` | `tsc --noEmit` EXIT=0 |
| `pnpm -C be lint` | `eslint src test` EXIT=0 |
| `pnpm -C be test` | `Test Suites: 20 passed, 20 total` / `Tests: 205 passed, 205 total` EXIT=0 |
| `pnpm -C be test:int` | `Test Suites: 24 passed, 24 total` / `Tests: 502 passed, 502 total` EXIT=0 |
| `pnpm -C fe-sso-test typecheck` | `tsc -b --noEmit` EXIT=0 |
| `pnpm -C fe-sso-test lint` | `eslint .` EXIT=0 |
| `pnpm -C fe-sso-test test` | `Test Files 25 passed (25)` / `Tests 176 passed (176)` EXIT=0 |
| `pnpm -C fe-sso-test build` | `✓ built` EXIT=0 |

### Sau khi thêm test QA (chạy lại toàn bộ)
| Lệnh | Kết quả |
|---|---|
| `pnpm -C be typecheck` | EXIT=0 |
| `pnpm -C be lint` | EXIT=0 (sau `eslint --fix` chỉ trên 3 file test QA — lỗi prettier định dạng của chính code test mới) |
| `pnpm -C be test` | `Test Suites: 21 passed, 21 total` / `Tests: 211 passed, 211 total` EXIT=0 (+6) |
| `pnpm -C be test:int` | `Test Suites: 24 passed, 24 total` / `Tests: 507 passed, 507 total` EXIT=0 (+5) |
| `pnpm -C fe-sso-test typecheck` | EXIT=0 |
| `pnpm -C fe-sso-test lint` | EXIT=0 |
| `pnpm -C fe-sso-test test` | `Test Files 26 passed (26)` / `Tests 187 passed (187)` EXIT=0 (+11) |
| `pnpm -C fe-sso-test build` | `✓ built` EXIT=0 |

### Mutation (chứng minh test QA mới có răng; khôi phục byte-identical, sha256 khớp)
| Mutation | Test | Kết quả |
|---|---|---|
| `isDemoEnabled` → `env.NODE_ENV !== 'production'` (fail-open kiểu zod default) | `demo.gating.spec.ts` | 3 failed / 3 passed (unset, `staging`, `Development` RED) → khôi phục `d43d7e44…` |
| refresh: `identifiersFor(client.allowedResources)` → so thẳng `[...client.allowedResources]` | `seed-dev.int-spec` "QA (c)" | RED: `Expected: 400, Received: 200` (refresh nhận URI) → khôi phục identical |
| introspect: `identifiersFor(caller.allowedResources)` → so thẳng `[...caller.allowedResources]` | `seed-dev.int-spec` "QA (c)" | RED: `{active:false}` vs body active:true → khôi phục identical |
| FE `isAudProbePending` → `Boolean(...?.purpose)` | `probe-purpose.test.tsx` | 5 failed (login/unknown/case-variant/non-string purpose + callback purpose lạ) → khôi phục identical |

## Test QA bổ sung (gap so với acceptance)
1. **`be/src/modules/demo/demo.gating.spec.ts`** (mới, unit, 6 case): ngữ nghĩa wiring thật `ConditionalModule.registerWhen(<module>, (env) => isDemoEnabled(env))` + biểu thức preflight của `main.ts`. `development`/`test` ⇒ route mount (200) + `OPTIONS` 204 + ACAO; **unset**/`production`/`staging`/`Development` ⇒ **404** và **không** preflight 204, không ACAO. (Trước đó chỉ có unit predicate + controller-404 prod; dev ghi chú route-level chưa phủ.) Dùng stub controller để không cần Mongo/Redis; controller thật phủ ở `demo.int-spec.ts`.
2. **`be/test/demo.int-spec.ts`** (+3): Redis lỗi ở tombstone `isEnded` ⇒ 5xx, body không lộ chi tiết/token; Mongo lỗi ở `identifiersFor` ⇒ 5xx opaque; token `aud` không phải Resource đã đăng ký ⇒ 401, token của client không có `demo` trong `allowedResources` (aud đúng) ⇒ 401 `invalid_token`.
3. **`be/test/seed-dev.int-spec.ts`** (+2, dữ liệu seed thật): **Task 0 (c)** `allowedResources` chứa URI ⇒ `/userinfo` 401 (body không nêu URI), refresh `invalid_grant` và doc refresh **không đổi** (`revokedAt` null); caller RS giữ URI (client token đúng) ⇒ `/introspect` `active:false`; khôi phục dạng resourceId ⇒ cùng refresh token rotate 200. **Replay** sau rotation có mapping ⇒ `invalid_grant` và successor bị thu hồi (INV-14).
4. **`fe-sso-test/test/probe-purpose.test.tsx`** (mới, 11 case): `isAudProbePending` THẬT đọc sessionStorage thật — chỉ đúng `"aud-probe"` + transient hợp lệ mới true (thiếu/`login`/lạ/khác hoa thường/không phải string/JSON hỏng/transient thiếu field ⇒ false). `/callback` với purpose thiếu/lạ ⇒ `finishLogin` chạy, `finishAudProbe`/silent-restore **không**, không `fetch` nào.

## Coverage acceptance criteria

### Task 0 [BE] — mapping resourceId↔URI
- [x] (a) dương seed thật: code→token→`/userinfo` 200→refresh 200 (aud demo)→RS introspect `active:true` — `seed-dev.int-spec` "code -> token -> /userinfo 200 …"
- [x] (b) âm: bỏ `demo` ⇒ 401 / `invalid_grant` / `active:false` — `seed-dev.int-spec` "(b) negative"; refresh doc không đổi — `refresh-token.int-spec` (:604 path) + QA (c)
- [x] (b2) caller không có claim trên aud ⇒ `active:false` + spy không `users.exists`/`isEnded` — `introspect.int-spec` "DEBT-040 … spy proof", "confused-deputy"
- [x] (c) dữ liệu sai (URI trong allowedResources) — liveness unit `access-token-liveness.spec` "confused deputy"; refresh + introspect + userinfo int: **QA (c)** (mới)
- [x] (d) mutation từng call-site — dev (liveness 2 RED, refresh 24 RED, introspect 8 RED) + tester tái lập refresh/introspect RED trên QA (c)
- [x] (e) fail-closed Mongo lỗi — `access-token-liveness.spec` (e); `userinfo.int-spec` (e) 5xx; `introspect.int-spec` (e) 500 `server_error`; `refresh-token.int-spec` (e) 5xx không rotate
- [x] `pnpm -C be test` + `test:int` xanh — xem bảng trên

### Task 1 [BE] — `GET /demo/me`, seed `other`
- [x] 200 + sub/aud, `no-store`, không `sid` — `demo.int-spec` "valid access token …"
- [x] aud=other ⇒ 401 `invalid_token` + WWW-Authenticate (INV-8) — `demo.int-spec`; + aud chưa đăng ký / client không có demo — QA (mới)
- [x] thiếu/malformed/expired/ID token/HS256 ⇒ 401 — `demo.int-spec` (5 test); token qua query bị bỏ qua
- [x] logout (tombstone) ⇒ 401 ngay — `demo.int-spec` "logout (sid tombstone)"
- [x] hạ tầng lỗi ⇒ 5xx opaque — `demo.int-spec` "user lookup throws" + QA Redis `isEnded` + QA Mongo `identifiersFor`
- [x] `NODE_ENV=test` bật; unset ⇒ 404; production ⇒ 404 — `demo.enabled.spec` + `demo.int-spec` controller-404 + **`demo.gating.spec`** route-level (mới)
- [x] preflight 204 + ACAO + Vary khi bật; origin lạ không ACAO; **tắt ⇒ không 204** — `demo.int-spec` + `demo.gating.spec` (mới)
- [x] seed 2 lần ⇒ đúng 2 resource, `allowedResources=['demo','other']` — `seed-dev.int-spec` "idempotent", "seeds exactly one public client + demo AND other"

### Task 2 [FE] — route & guard
- [x] anonymous `/profile` ⇒ `/login` + returnTo; sau login về returnTo — `router.test.tsx` "anonymous visit …", "on success redirects to the validated returnTo"
- [x] `/profile` claims khớp — `Profile.test.tsx`
- [x] `/tokens` đếm ngược + không token thô — `Tokens.test.tsx` "countdown ticks", "never renders raw token strings …"
- [x] trang lỗi map code, không echo `error_description` — `ErrorPage.test.tsx`, `router.test.tsx` (DEBT-080)
- [x] bảng `returnTo` (ghi + đọc) — `returnTo.test.ts`, `returnToStore.test.ts`, `Login.test.tsx`

### Task 3 [FE] — `/api-test`
- [x] Nút A 200 PASS + sub; non-200 FAIL; network error không crash — `ApiTest.test.tsx`, `resourceCall.test.ts` (`credentials:'omit'`, `no-store`, timeout)
- [x] Nút B: revoke best-effort, probe chỉ lưu `{status,expected,aud}`, one-shot xoá, state/iss check, `prompt=none` ≤1 — `probe.test.ts`, `revoke.test.ts`, `router-probe.test.tsx`, `ApiTest.test.tsx`
- [x] **purpose lạ/thiếu ⇒ login thường, không gọi `/demo/me`** — **`probe-purpose.test.tsx`** (mới; trước đó router test mock `isAudProbePending`)
- [x] Nút C `/userinfo` 200 — `ApiTest.test.tsx` "Button C"
- [x] không token thô trong DOM — `ApiTest.test.tsx` "never renders the raw access token"
- [ ] Nút B end-to-end trên trình duyệt thật — **ngoài phạm vi run 24** (E2E → run 25; smoke live của frontend-dev bị chặn bởi DEBT-100, nay đã đóng)

### Task 4 [BE] — DEBT-100
- [x] repro 500 với index cũ / fix `syncAllIndexes` ⇒ 302 / INV-8 token `other` ⇒ `/demo/me` 401 — `seed-dev.int-spec` (3 test). Lưu ý DEBT-106 (phụ thuộc thứ tự, senior đã ghi) — vẫn xanh trong lần chạy này.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | anonymous (`/demo/me` không token 401; FE guard), valid user, client khác (rogue client không có `demo`) | `demo.int-spec`, QA INV-8, `router.test.tsx` |
| Credential | absent, malformed, expired, ID token (typ), HS256 (alg), revoked (sid tombstone), replayed refresh | `demo.int-spec`, QA replay `seed-dev.int-spec` |
| Authorization | aud resource khác (`other`), aud chưa đăng ký, client không allow demo, caller RS không claim (b2), URI-trong-allowlist (confused deputy id↔URI) | `demo.int-spec`, `introspect.int-spec`, QA (c) |
| Input | `returnTo` open-redirect table, `error_description` injection, purpose transient giả mạo/hỏng | `returnTo*.test.ts`, `ErrorPage.test.tsx`, `probe-purpose.test.tsx` |
| State | refresh rotation replay ⇒ family revoke; doc không đổi khi từ chối; probe one-shot | QA replay, QA (c), `probe.test.ts` |
| Dependency | Mongo lỗi (mapping, user lookup), Redis lỗi (`isEnded`) ⇒ 5xx, không 200/401/`active:false` | `userinfo`/`introspect`/`refresh-token` (e), `demo.int-spec` + QA |
| Request chain | logout → request kế tiếp cùng AT 401; rotate → replay token cũ → successor chết; probe → silent restore | `demo.int-spec`, QA replay, `router-probe.test.tsx` |
| Exposure | 401/5xx body không lộ URI/chi tiết lỗi/token; `/demo/me` không `sid`; FE không token thô trong DOM/sessionStorage | `demo.int-spec`, QA (c)/5xx, `Tokens`/`ApiTest`/`probe` tests |
| Config gating | NODE_ENV unset/production/staging/case-variant ⇒ demo tắt (route 404 + không preflight) | `demo.gating.spec.ts` |

## Ghi chú / quan sát (không chặn, không mở debt mới)
- `ConditionalModule` đánh giá `process.env` **sau** khi `@nestjs/config` trộn `be/.env` vào `process.env`; `main.ts` cũng `process.loadEnvFile('.env')` trước `isDemoEnabled` ⇒ hai nơi nhất quán. "NODE_ENV unset" nghĩa là không có trong cả env lẫn `.env` (repo `be/.env` đặt `development`).
- Boot `AppModule` đầy đủ với demo tắt chưa được test (stub module thay `DemoModule`); E2E run 25 sẽ phủ đường thật.
- 🟡 senior DEBT-101/102 [FE] vẫn mở — nên sửa trước E2E run 25.
