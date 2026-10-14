# Log — run 22 — X1 walking skeleton (+ DEBT-076/078/079/080)


## analyst (2026-10-14)
- Preflight CodeGraph: v1.6.2, index up-to-date (200 files, 3207 nodes), `codegraph sync` ? already up to date. (C?nh b?o re-index v1.5.0?1.6 kh?ng ch?n.)
- ??c: STATUS.md, run21 summary + test-report (FE 67 / BE unit 175 / int 452 = 694), plan.md ?8 (X1 d?ng 269), backlog DEBT-076/078/079/080/081/004.
- Kh?o s?t codebase (CodeGraph CLI/grep):
  - FE `fe-sso-test/src/routes`: `Home.tsx` (ch? hi?n th? `session.claims.sub`, sign in/out), `Callback.tsx` + `errorElement`. **Ch?a** c? trang hi?n th? claims ??y ?? ? Task 2.
  - `refresh.ts`: commit-path ?? c? guard `get()===current`, nh?ng nh?nh `catch` v?n `tokens.clear()` v? ?i?u ki?n ? DEBT-078 c?n h? (Task 2).
  - `logout.ts`: `consumeLogoutState` ?? ??nh ngh?a, **ch?a route n?o g?i** ? DEBT-079 (Task 2). `token-exchange.ts:38` n?i nguy?n v?n `error_description` ? DEBT-080 (Task 2).
  - BE: login UI c? s?n `GET/POST /login` (`login.eta`), post-logout landing `/login?loggedOut=1`. Login gate `!user.emailVerifiedAt` (`authentication.service.ts:114`). `db:seed-dev` hi?n ch? seed client+resource (kh?ng user) ? DEBT-076 (Task 1). `ADMIN_SEED_EMAIL/PASSWORD` ?? c? trong `validation.schema.ts`/env.
  - Grep `withTransaction`/`startSession` = 0 ? lu?ng X1 kh?ng b?t bu?c replica set (ghi ch?).
  - CI `.github/workflows/ci.yml`: job `e2e` placeholder, service `mongo:7` (CH?A `--replSet`) + `redis:7` ? DEBT-004 (Task 5).
  - Playwright ch?a c?i; ch?a c? `e2e/`. Workspace: be, fe-admin, fe-sso-test.
- Vi?t `tasks.md` (5 task): T1[BE] seed user dev verified, T2[FE] claims UI + DEBT-078/079/080, T3[E2E] package e2e + Playwright webServer, T4[E2E] k?ch b?n 1 login?token?claims, T5[E2E] CI e2e th?t (DEBT-004) + ponytail DEBT-081.
- Quy?t ??nh M? (?? xu?t an to?n, tech-lead ch?t): Q-X1-a Playwright ? package `e2e/` ri?ng; Q-X1-b seed user t? env (t?i d?ng ADMIN_SEED_* ho?c th?m DEV_SEED_*); Q-X1-c E2E kh?ng flush Redis/Mongo d?ng chung (?? xu?t Redis DB `/1`); Q-X1-d CI Mongo c?n `--replSet rs0` + init.
- H? t?ng dev = 3 container ch? ??nh: `aegate-mongo`(27017, DB `sso-idp`), `aegate-redis`(6379, d?ng chung ? kh?ng FLUSH), `veyrigate-mailpit-1`(1025). BE int-test gi? `vg-test-mongo@27117`/`vg-test-redis@6479`.
- C?ng ? tech-lead.

## tech-lead (2026-10-14)
- Preflight CodeGraph: `codegraph sync` OK. Đối chiếu: `seed-dev.ts`, `validation.schema.ts`, `redis.module.ts`, `lua-loader.ts`, `authentication.service.ts` (register/login), `tenant-context.ts`, `user-tenant.schema.ts`, `token.service.ts#signIdToken`, `session.cookie.ts`, `health.controller.ts`, `main.ts`, `ci.yml`, root `package.json`, `vite.config.ts`.
- Đã làm: chốt Q-X1-a (`e2e/`, script `e2e` không phải `test`), Q-X1-b (`DEV_SEED_*`, không tái dùng admin; + membership `roles: []`), Q-X1-c (dev Redis `/1`; E2E Mongo `sso-idp-e2e` + Redis `/2`; cấm flush), Q-X1-d (CI single-node). Fold "Chốt tech-lead" vào `tasks.md`: chuỗi build→sync-indexes→seed→start, `/ready`, `SESSION_COOKIE_SECURE=false`, `VITE_*` qua webServer.env, ID token không có `email`, assert token qua response `/token`, consent rẽ nhánh, trace chỉ CI.
- File đổi: `runs/22-X1/review-techlead.md`, `runs/22-X1/tasks.md`, `backlog.md` (+DEBT-082/083), `STATUS.md`.
- Kết quả: PASS — plan khả thi; lỗ hổng (thiếu membership, tái dùng admin seed, `dist` chưa build, claim `email` không tồn tại, reuse server dev) đã fold.
- Bàn giao: backend-dev — T1; frontend-dev — T2 (song song), sau đó T3→T4→T5.

## frontend-dev (T2) (2026-10-14)
- Preflight CodeGraph: v1.6.2, index up-to-date (200 files). Đọc tasks.md/review-techlead + code fe-sso-test qua Git Bash.
- Claims UI (`Home.tsx`): `data-testid="claims"` + `claim-sub/iss/aud/exp` (không email theo fold; không render access/refresh/id token). `aud` mảng → join; `exp` → ISO.
- DEBT-078 `refresh.ts`: catch nay `if (tokens.get()===current) tokens.clear()` — không clobber phiên mới khi logout→login lúc refresh cũ đang bay.
- DEBT-079: thêm `handleLogoutLanding` (`logout.ts`) + `consumeLogout` (`client.ts`); Home consume one-shot/fail-closed, strip `state` khỏi URL, notice trung tính.
- DEBT-080 `token-exchange.ts`: bỏ echo `error_description`; chỉ giữ `error` code sanitize (whitelist + `[a-z0-9_-]`) như `callback.ts`.
- Tests: +16 (Home 7, refresh 2, token-exchange 2, logout 5) → 83 pass. Mutation: revert mỗi fix làm test đỏ, restore byte-identical (hash khớp: refresh 6ccdb22, token-exchange f8f8f30, logout 7d0a2c0, Home d6f1a33).
- Verify: `pnpm -C fe-sso-test typecheck` ✓, `lint` ✓, `test` ✓ 83/83, `build` ✓. Không hồi quy 67. KHÔNG commit. Đề nghị chuyển senior-reviewer.

## [2026-10-14 09:55] backend-dev (T1)
- Da lam: mo rong db:seed-dev tao user dev da verify email (DEBT-076) — seedDevUser + readDevSeedUserConfig (zod rieng, KHONG vao envSchema), membership roles:[], reset failedLoginCount/lockedUntil moi lan, giu emailVerifiedAt cu ($min), idempotent, fail-closed production, chan trung ADMIN_SEED_EMAIL, khong log password.
- File doi: be/src/database/seed-dev.ts, be/test/seed-dev.int-spec.ts (+7 test), be/.env.example, be/README.md.
- Ket qua: DONE — typecheck/lint OK; unit 175/175; int 459/459 (seed-dev 17/17, +7 moi); smoke db:seed-dev tren dev sso-idp x2 idempotent, khong in password.
- Ban giao: senior-reviewer — review T1.

## frontend-dev (T3–T5) (2026-10-14)
- Preflight CodeGraph: v1.6.2, index up-to-date (200 files). Đọc fold tech-lead (Q-X1-a/b/c/d + build→sync→seed→start chain), backend-dev T1 log, login.eta/consent.eta, health.controller (`/ready`), discovery/CORS, envSchema.
- T3 ✅ `e2e/` package (thêm `pnpm-workspace.yaml` + root script `e2e`; `@playwright/test` 1.64.0 pin exact, lock cập nhật). `playwright.config.ts`: 2 webServer — BE `build && db:sync-indexes && db:seed-dev && start` (dist, cwd=repoRoot) đợi `http://127.0.0.1:4000/ready`; FE `fe-sso-test dev` :5173 đợi `/`; env hermetic qua `webServer.env` (`config/env.ts`: Mongo `sso-idp-e2e`, Redis `/2`, SMTP Mailpit, `SESSION_COOKIE_SECURE=false`, NODE_ENV=test, không đọc `be/.env`); `reuseExistingServer` chỉ khi `E2E_REUSE=1`; trace `retain-on-failure` chỉ CI; KHÔNG flush/drop. `playwright install chromium` xong. README + `.env.example` (non-secret). Verify thật: chuỗi chạy — build OK, 16 index synced, seed `client fe-sso-test`/`resource demo`/`user <sub>`, BE boot + `/ready` 200, FE :5173 lên, teardown sạch.
- T4 ✅ viết (`tests/login.spec.ts`): FE Sign in → `/authorize` → `/login` (fill dev email/pw từ env) → consent rẽ nhánh (không sleep) → `/callback` → claims; bắt response `/token`, assert `claim-sub==sub` (`/^[a-f0-9]{24}$/`), token KHÔNG trong DOM/URL/localStorage/sessionStorage.
- **CHẶN (DEBT-084)**: flow KHÔNG hoàn tất trong browser thật. BE helmet CSP `formAction:["'self'"]` (`main.ts:52`) chặn chuỗi redirect form OAuth sang RP khác origin: `POST /login`→302 `/authorize`→302 `http://localhost:5173/callback` bị Chromium block (`net::ERR_ABORTED` + "violates form-action 'self'") ⇒ FE `/callback` không load ⇒ `/token` không chạy. Bằng chứng: BE log 302 tới `/callback?code=...` + browser console block. Cùng chặn path consent (`POST /authorize/consent`→callback). Fix thuộc `be/src/main.ts` — NGOÀI phạm vi frontend-dev → DỪNG & BÁO theo protocol.
- T4/T5 để `[ ]` (chặn bởi DEBT-084); T5 CI chưa sửa vì cần T4 xanh. DEBT-081 (ponytail) hoãn: `KNOWN_ERROR_CODES` đang được dùng + đổi sẽ ảnh hưởng test DEBT-080 vừa thêm; làm riêng để giữ surgical.
- Verify: `pnpm -C e2e typecheck` ✓; FE `typecheck/lint/test(83)/build` ✓ không hồi quy; root `pnpm test` chạy BE 175 + FE 83, KHÔNG kéo Playwright/webServer (script e2e tên `e2e`). KHÔNG commit, KHÔNG đụng be/src.
- Bàn giao: **cần BE fix DEBT-084** (backend-dev/tech-lead) rồi mới chạy được T4/T5; sau đó senior-reviewer.

## [2026-10-14 10:40] tech-lead (DEBT-084)
- Đã làm: Preflight CodeGraph (sync OK); đối chiếu `main.ts:52`, `ui.controller.ts` (`/login`, `/logout`, `renderFrontchannel`), `authorize.controller.ts`/`.service.ts`, `AuthorizeRequestContextService`, `redirect-uri.validator.ts`, `resolvePostLogoutRedirect`. Chốt (a) CSP `form-action` theo từng response (origin từ URI đã exact-match: ctx qua `peek()` cho `/login`, outcome consent, `resolvePostLogoutRedirect` cho `/logout`); loại (b) (code lộ trong HTML trung gian, phá semantics 302) và (c).
- File đổi: `runs/22-X1/tasks.md` (+Task 6 [BE]), `runs/22-X1/review-techlead.md` (mục "Bổ sung DEBT-084"), `backlog.md` (DEBT-084 → T6, +DEBT-085), `STATUS.md`.
- Kết quả: PASS — fold T6 (INV-084-1..3, failure Redis fail-closed `'self'`, 10 acceptance gồm test CSP theo route + E2E X1 xanh).
- Bàn giao: backend-dev — làm T6; sau đó frontend-dev chạy lại T4 (×3) → T5 → senior-reviewer.

## [2026-10-14 11:05] backend-dev (T6)
- Da lam: DEBT-084 CSP `form-action` theo tung response. Moi `be/src/common/http/csp.ts` (`buildCsp` byte-identical global helmet 8 + `safeCspOrigin` lop 2, fail-closed null); `renderFrontchannel` dung chung `buildCsp({frameSrc})`; `peek()` khong DEL/khong doi TTL (INV-084-3); `/login` (origin ctx.redirectUri qua peek, returnTo chi `/authorize?request_id=`), consent (them `redirectUri` vao outcome, chi header), `/logout` (origin resolved khi != defaultRedirect); sua comment DEBT-015.
- File doi: csp.ts/csp.spec.ts (moi), authorize-request-context.service.ts, authorize.controller.ts, authorize.service.ts, ui.controller.ts, return-to.ts/.spec.ts, test: ui.int-spec(+17), ui-auth.int-spec(+DI fix), authorize.int-spec(+peek/consent CSP).
- Mutation: (A) bo guard `safeCspOrigin` -> csp.spec RED; (B) origin tu returnTo tho -> ui.int-spec "extra redirect_uri" RED; khoi phuc byte-identical (md5 khop).
- Ket qua: DONE — typecheck/lint OK; unit 191/191; int 478/478 (23 suite); E2E `pnpm -C e2e e2e` 1 passed (53.6s), console KHONG con "violates form-action". 10/10 acceptance dat.
- Ban giao: frontend-dev — chay lai T4 (x3) roi T5; sau do senior-reviewer.

## frontend-dev (T4–T5 hoàn tất) (2026-10-14)
- Preflight CodeGraph: index up-to-date. Đọc `backend-dev (T6)` (DEBT-084 fixed: CSP `form-action` theo từng response). 3 container chỉ định đang chạy.
- T4 ✅ `pnpm -C e2e e2e` **3 lần liên tiếp** trên `aegate-mongo` DB `sso-idp-e2e` + `aegate-redis` `/2` + Mailpit: **1 passed** cả 3 (28.7s / 27.7s / 28.8s), không flaky. Mỗi lần: `/token` POST → 200, claims hiển thị, assert token KHÔNG trong DOM/URL/local+sessionStorage + `claim-sub==sub` (24-hex) đều xanh. Console KHÔNG còn "violates form-action".
- Nhánh consent: 3 lần local đi **nhánh KHÔNG consent** (consent đã ghi ở DB `sso-idp-e2e` từ lần chạy T6 của backend-dev; KHÔNG được FLUSH/drop để ép lại). Spec xử lý CẢ 2 nhánh (`if (consentForm.isVisible()) Allow`); nhánh consent đã xác minh ở phiên T4 trước (log run cũ: `GET /authorize`→200 consent page→`POST /authorize/consent`→302 `/callback`). **CI với DB sạch sẽ đi nhánh consent** (ghi rõ trong README/log).
- T5 ✅ `.github/workflows/ci.yml` job `e2e` thật (DEBT-004): Mongo single-node `mongo:7` (KHÔNG `--replSet` — DEBT-083) + Redis `redis:7` service (health-check); job `env:` DEV_SEED_* giả (KHÔNG GitHub secrets); BE/FE env giả do `e2e/config/env.ts` qua webServer.env; `playwright install --with-deps chromium`; `pnpm -C e2e e2e`; `retries: 0` (trong config); upload `e2e/playwright-report` khi `failure()`. YAML parse OK (PyYAML): 2 service, 9 step, upload có `if: failure()`.
- DEBT-081 (ponytail) hoãn: `KNOWN_ERROR_CODES` đang dùng + đổi ảnh hưởng test DEBT-080; làm riêng.
- Verify: FE `typecheck`/`lint`/`test` **83/83**/`build` ✓ không hồi quy; root `pnpm test` KHÔNG kéo Playwright (script `e2e`). KHÔNG commit, KHÔNG đụng `be/src`. Đã dọn `test-results`/`playwright-report`/temp.
- Bàn giao: **senior-reviewer** — review X1 (T1–T5 xong; DEBT-084 đóng bởi T6).

## [2026-10-14 12:30] senior-reviewer
- Đã làm: Preflight CodeGraph; review T1–T6 theo tasks/review-techlead; đo `buildCsp()` == helmet live; mutation T6 M1–M8 (7 RED; M1a reset-TTL + M8 log-leak sống → lỗ test); chạy unit 191, int 478, FE 83, E2E 1 passed (26.2s); khôi phục, md5 khớp baseline.
- File đổi: runs/22-X1/review-senior.md, backlog.md (+DEBT-086…092), STATUS.md, log.md.
- Kết quả: PASS — 0 🔴; 6 🟡 (test INV-084-3/log/byte-identity, access log lộ `code` trong location, e2e/.env không nạp, keyset dùng chung) + ponytail -28 dòng.
- Bàn giao: tester — kiểm X1 theo acceptance T1–T6 (nhánh consent xác nhận trên CI DB sạch).

## [2026-10-14 12:55] tester
- Đã làm: Preflight CodeGraph; đối chiếu acceptance T1–T6; **+4 int-test** + siết 2 test có sẵn đóng DEBT-086/087/088 (mỗi cái verified RED bằng mutation `be/src` → khôi phục byte-identical). Chạy thật: BE typecheck/lint sạch, unit **191**, int **482** (478→482); FE typecheck/lint/test **83**/build ✓; E2E `pnpm -C e2e e2e` **1 passed (37.3s)** (sso-idp-e2e/Redis /2, no flush).
- Nhánh consent: chạy trên **DB tạm mới** `sso-idp-e2e-consent-20261014125425` + Redis `/3` (DBSIZE=0 trước) qua config Playwright tạm (spread beEnv/feEnv sản phẩm, chỉ đổi URI) — **1 passed (28.7s)**; probe sau run thấy consent mới ghi ⇒ nhánh consent thực thi. Config sản phẩm E2E KHÔNG cho override env URI → KHÔNG sửa; để lại DB tạm (không drop).
- File đổi: `be/test/authorize.int-spec.ts`, `be/test/ui.int-spec.ts`; test-report.md, log.md, STATUS.md, backlog.md (DEBT-086/087/088 → đã đóng).
- Kết quả: **PASS** — 0 FAIL; DEBT-086/087/088 đóng. KHÔNG đụng `be/src` (đã khôi phục), KHÔNG flush/drop/dừng container.
- Bàn giao: **orchestrator** — đóng run 22-X1; DEBT-089/090/091/092 (cần sửa code/config sản phẩm) còn mở.

## [2026-10-14] orchestrator
- Đã làm: theo chỉ định người dùng dùng `aegate-mongo`/`aegate-redis`/`veyrigate-mailpit-1` cho dev/E2E; cập nhật `be/.env` local (`REDIS_URL` /1, `DEV_SEED_*` — không commit); tạo lại `vg-test-mongo`/`vg-test-redis` sau khi backend-dev gỡ nhầm; commit `c2cf053`; viết `summary.md`; cập nhật `STATUS.md`.
- Kết quả: DONE — run 22 đóng, M3 walking skeleton hoàn tất.
