# Test Report — 2026-10-14 (run `21-T1-T2`)

## Kết quả: PASS (FE 67/67 + BE unit 175/175 + BE int 452/452 = 694/694)

Tester chạy lại toàn bộ gate FE + BE với Mongo `:27117` (rs0, PRIMARY) + Redis `:6479` thật.
Container bị **Exited** giữa lần int-test đầu (ECONNREFUSED hàng loạt — hạ tầng, không phải bug
sản phẩm); `docker start vg-test-mongo vg-test-redis`, xác nhận `rs.status().myState==1`, chạy lại
→ xanh toàn bộ. Thêm **2 FE test** củng cố acceptance "token không vào Web Storage / reload →
anonymous" (runtime proof, không chỉ grep tĩnh). KHÔNG sửa code sản phẩm.

## Lệnh đã chạy + output thực tế

| Lệnh | Kết quả |
|---|---|
| `pnpm -C fe-sso-test typecheck` | `tsc -b --noEmit` — exit 0, 0 lỗi |
| `pnpm -C fe-sso-test lint` | `eslint .` — exit 0, 0 lỗi |
| `pnpm -C fe-sso-test test` | `Test Files 11 passed (11)` / `Tests 67 passed (67)` (1.47s) |
| `pnpm -C fe-sso-test build` | `tsc -b && vite build` — ✓ built in 253ms, 251 modules |
| `pnpm -C fe-sso-test dev` (smoke) | VITE v8.3.4 ready :5173; `curl -I http://localhost:5173/` ⇒ `HTTP/1.1 200 OK` text/html; dừng (port free) |
| `pnpm -C be typecheck` | `tsc --noEmit` — exit 0 |
| `pnpm -C be lint` | `eslint src test` — exit 0 |
| `pnpm -C be test` (unit) | `Test Suites: 17 passed, 17 total` / `Tests: 175 passed, 175 total` |
| `pnpm -C be test:int --forceExit` (lần 1) | EXIT=1 — `19 failed/4 passed`, `ECONNREFUSED ::1:27117` (container Exited giữa chừng → hạ tầng) |
| `docker start vg-test-mongo vg-test-redis` + `rs.status().myState` | `1` (PRIMARY) |
| `pnpm -C be test:int --forceExit` (lần 2) | `Test Suites: 23 passed, 23 total` / `Tests: 452 passed, 452 total`; `PASS test/seed-dev.int-spec.ts (9.939 s)` |

> Lần int-test đầu fail **đồng loạt ~30s/suite** với `MongooseServerSelectionError: connect
> ECONNREFUSED ...:27117` ⇒ chẩn đoán hạ tầng (container dừng), không phải lỗi code. Sau khi khởi
> động lại + xác nhận rs PRIMARY, chạy lại sạch 23/23. seed-dev int (Task 4 / F9) nằm trong đó.

## Test FAIL (sau khi hạ tầng đã sẵn)

Không có. 0 FAIL ở mọi gate FE/BE sau khi Mongo/Redis chạy.

## Test tester bổ sung (củng cố acceptance, không sửa code sản phẩm)

`fe-sso-test/test/invariants.test.ts` (+2 test, tổng FE 65→67):
- "a full callback + refresh keeps access/refresh/id tokens out of local/sessionStorage" — stub
  `localStorage`/`sessionStorage` toàn cục ghi lại mọi `setItem`; chạy callback happy-path + 1 lần
  refresh rotation; assert không giá trị token nào (access/refresh/id cũ lẫn rotated) từng được ghi
  vào Web Storage. (Bổ sung runtime cho grep tĩnh sẵn có.)
- "reload (a fresh in-memory store) drops the session -> anonymous" — mô phỏng reload bằng store
  mới ⇒ `get()===null`.

## Coverage acceptance criteria

### Task 1 — T1 scaffold + env.ts
- [x] Dev :5173 strictPort — smoke `HTTP 200` + `vite.config.ts { port:5173, strictPort:true }`
- [x] Thiếu/sai env → lỗi rõ nêu tên biến + hint `cp .env.example .env` — `env.test.ts` (throw naming var; non-URL issuer; resource có fragment; scope thiếu openid)
- [x] typecheck + lint pass — exit 0
- [x] test env (thiếu → throw; đủ → object) — `env.test.ts: returns a parsed object`
- [x] `pnpm install` không hỏng workspace, node 22 — install/build/test đều chạy

### Task 2 — OIDC discovery + beginLogin (PKCE/state/nonce)
- [x] PKCE S256 = base64url(SHA-256(verifier)) không padding; luôn S256 không `plain` — `pkce.test.ts` (3)
- [x] discovery parse đúng; thiếu endpoint → lỗi rõ — `discovery.test.ts`
- [x] `/authorize` đủ 9 tham số; `resource` === env; `code_challenge_method=S256` — `authorize.test.ts` (assert `resource`=`http://localhost:4000/demo/`)
- [x] state/nonce ≥128-bit, khác mỗi lần (2 lần → khác) — `authorize.test.ts: fresh high-entropy`
- [x] F5 `discovery.issuer` === `VITE_OIDC_ISSUER`; khác → lỗi — `discovery.test.ts: rejects issuer mismatch`
- [x] F6 mọi fetch có `AbortSignal.timeout(10s)`; discovery treo → timeout rõ — `discovery.test.ts: aborted fetch → timeout error`, `passes an AbortSignal`
- [x] OPEN-2 `prompt` chỉ khi truyền — `authorize.test.ts: omits prompt by default`
- [x] INV exposure: `code_verifier` không vào URL `/authorize` — `authorize.test.ts: never puts the code_verifier`

### Task 3 — Callback + đổi code + validate ID token + refresh + logout
- [x] Validator: hợp lệ pass; đổi `nonce`/`aud`/`iss` fail; `exp` quá hạn fail — `idToken.test.ts` (callback mode: nonce/aud/iss/exp + bad signature)
- [x] Callback: `state` không khớp → từ chối, không gọi `/token`; `iss` khác → từ chối — `callback.test.ts` (state mismatch, iss mismatch, iss absent)
- [x] Đổi 1 tham số (state/nonce/iss/aud/exp/alg) ⇒ login thất bại fail-closed, không cấp phiên — `callback.test.ts` + `idToken.test.ts` (alg: PS256/HS256/none bị từ chối)
- [x] Refresh rotation: `refresh_token` mới lưu, cũ bị drop — `refresh.test.ts: rotates`
- [x] Token trong bộ nhớ + reload → không còn token; grep không `setItem`/`console` token — `invariants.test.ts` (grep tĩnh + 2 runtime test tester thêm); `tokenStore.test.ts`
- [x] Logout URL `end_session` có `id_token_hint` + `post_logout_redirect_uri`; sau logout bộ nhớ rỗng — `logout.test.ts`
- [x] F2 đổi code đúng 1 lần (StrictMode) + xoá transient trước exchange — `callback.test.ts: deletes transient before exchange ... once`
- [x] F5 `iss` bắt buộc; `algorithms:['RS256']` ghim — `callback.test.ts` + `idToken.test.ts` (algorithm pinning)
- [x] F3 refresh single-flight (2 song song ⇒ 1 request); lỗi/timeout ⇒ xoá token, anonymous — `refresh.test.ts: single-flight`, `clears fail-closed on invalid_grant`
- [x] F4 ID token refresh không `nonce`; `sub` khớp cũ; có nonce → từ chối — `idToken.test.ts (refresh mode)`
- [x] Thiếu `refresh_token` ⇒ throw, không gọi `/token` — `refresh.test.ts: throws when there is no refresh_token`
- [x] F7 access token opaque; không `console.*` token/code/verifier — `invariants.test.ts`

### Task 4 — [BE] seed-dev
- [x] F9 seed 2 lần ⇒ đúng 1 client + 1 resource, trường đúng exact — `seed-dev.int-spec.ts` (idempotent; re-seed sau đổi ISSUER update in-place)
- [x] client `fe-sso-test` public, `token_endpoint_auth_method=none`, không secret (0 ClientCredential) — `seed-dev.int-spec.ts: no ClientCredential`
- [x] redirect/post-logout/CORS khớp tuyệt đối `:5173`; `identifier`=`VITE_OIDC_RESOURCE` — `seed-dev.int-spec.ts` (match config + RESOURCE_URI = .env.example)
- [x] `NODE_ENV=production` ⇒ từ chối trước khi ghi DB (fail-closed); `assertNotProduction` — `seed-dev.int-spec.ts` (production refused, writes NOTHING)
- [x] Client seed chạy thật qua `/authorize` + CORS preflight — `seed-dev.int-spec.ts (F9 real flow)` (NO error / invalid_scope / invalid_target; OPTIONS :5173 ⇒ 204+ACAO, :5174 ⇒ no ACAO)
- [x] `pnpm db:seed-dev` script tồn tại — `be/package.json`

## Coverage security invariants / risk matrix

- [x] Input — malformed/encoded: resource với `#` fragment bị từ chối (`env.test.ts`); `/token` success-shape (`token-exchange.test.ts`)
- [x] Authorization/mix-up (INV-9, F5): discovery issuer mismatch + callback `iss` mismatch/absent → fail-closed (`discovery`/`callback`)
- [x] Credential/forgery (INV-6/-7): chữ ký sai, alg `none`/HS256/PS256 downgrade, aud/iss/exp/nonce sai → từ chối (`idToken`/`callback`)
- [x] State — fresh/consumed/concurrent: transient xoá trước exchange + single-flight code (F2); refresh single-flight + no-resurrect (F3); state mismatch = CSRF reject
- [x] Replay: nonce replay (callback), stale transient (F6), refresh-mode nonce bất ngờ bị từ chối (F4)
- [x] Exposure: access/refresh/id/verifier KHÔNG vào Web Storage/URL/log — grep tĩnh + runtime stub (`invariants`), logout URL chỉ `id_token_hint` (`logout`)
- [x] Control-plane (INV-4/-8): seed public client không secret, redirect/CORS exact, production fail-closed (`seed-dev.int`)
- [x] Request chain: logout state round-trip + one-shot consume (`logout.test.ts`); CORS preflight theo origin seeded (`seed-dev.int`)

## Ghi chú debt (không chặn — senior PASS lượt 2, tracked)

- DEBT-078 (refresh.ts `tokens.clear()` nhánh lỗi vô điều kiện), DEBT-079 (`consumeLogoutState`
  chưa route gọi), DEBT-080 (`/token` `error_description` nối message), DEBT-081 (ponytail) là **code
  sản phẩm** — ngoài phạm vi tester, để nguyên. Acceptance tương ứng (refresh fail-closed, logout
  round-trip, callback không echo `error_description`) đều có test xanh; các debt là góc cạnh/nit đã
  ghi backlog, không dẫn tới bypass/cross-tenant/replay/mất dữ liệu/rò secret chưa chứng minh.
- Không mở DEBT mới: mọi acceptance đều verify được.
