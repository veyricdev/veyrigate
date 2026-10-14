# Tasks ? run 22 ? X1 walking skeleton (M3) + DEBT-076/078/079/080 (+ DEBT-081/004 n?u r?)

> ? tr?: spec `docs/agile/sso-idp/spec.md`; plan `docs/agile/sso-idp/plan.md` ?8 (X1 d?ng 269), ?6 M3, ?4 (R4/DEBT-004 CI), ?9 (invariants cookie/token).
> M?c ti?u X1 (plan ?8 X1): email/password ? `/authorize` ? login (UI BE `GET/POST /login`) ? `/token` ? `fe-sso-test` **hi?n th? claims**; demo ???c; ch?y t? ??ng b?ng **Playwright 1 k?ch b?n**.

## H? t?ng dev/E2E ? NG??I D?NG CH? ??NH (kh?ng `docker compose up` th?m service)
- `aegate-mongo` (mongo:7, `--replSet rs0`, 27017) ? `MONGO_URI=mongodb://localhost:27017/sso-idp`. **DB d?ng chung t?n `aegate`** ? ch? ??ng DB `sso-idp`; TUY?T ??I kh?ng drop/ghi DB kh?c, kh?ng `dropDatabase`.
- `aegate-redis` (redis:7-alpine, 6379) ? `REDIS_URL=redis://localhost:6379`. **D?ng chung** ? c?m `FLUSHALL`/`FLUSHDB` to?n c?c; n?u c?n d?n: xo? theo prefix app, ho?c d?ng DB index ri?ng (?? xu?t `redis://localhost:6379/1`) ? **quy?t ??nh m? Q-X1-c**.
- `veyrigate-mailpit-1` (SMTP 1025, UI/API 8025) ? `SMTP_URL=smtp://localhost:1025`.
- C?c gi? tr? kh?p `be/.env.example`; `be/.env` ?? t?n t?i (d?ng nguy?n, kh?ng in secret).
- BE int-test v?n d?ng container test ri?ng `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (kh?ng ??i).
- Ghi nh?n: BE kh?ng d?ng `withTransaction`/`startSession` (grep 0 k?t qu?) ? lu?ng X1 **kh?ng** b?t bu?c replica set; `aegate-mongo` v?n l? rs0 n?n v? h?i.

## Quy?t ??nh ch?a ch?t (?? xu?t ph??ng ?n an to?n ? tech-lead ch?t)
- **Q-X1-a (Playwright ??t ??u)**: ?? XU?T **package `e2e/` ri?ng** trong pnpm workspace (th?m `e2e` v?o `pnpm-workspace.yaml`). L? do: (1) E2E l? li?n-module (d?ng c? BE :4000 + FE :5173), kh?ng thu?c ri?ng FE; (2) t?ch devDeps n?ng (`@playwright/test`, browsers) kh?i `fe-sso-test` ?? `pnpm -C fe-sso-test test` (Vitest 67) v?n nh?/nhanh; (3) kh?p quy ??c prefix `X` = li?n module/E2E (plan ?1). Ph??ng ?n thay th? (trong `fe-sso-test/`) r? h?n ch?t nh?ng tr?n 2 lo?i test ? lo?i.
- **Q-X1-b (seed user dev)**: ?? XU?T m? r?ng `db:seed-dev` t?o **1 user dev ?? verify email**, email/m?t kh?u ??c t? **env** (t?i d?ng `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` ?? c? trong `validation.schema.ts`, ho?c th?m `DEV_SEED_EMAIL`/`DEV_SEED_PASSWORD` n?u mu?n t?ch admin?user ? tech-lead ch?t). KH?NG hard-code secret trong repo; dev-only (ch?n `NODE_ENV=production` tr??c m?i ghi, nh? `seedDev` hi?n t?i).
- **Q-X1-c (d?n Redis/Mongo trong E2E)**: ?? XU?T E2E KH?NG flush g?; seed idempotent + d? li?u test c? l?p theo DB `sso-idp` / Redis DB `/1`. N?u c?n reset gi?a l?n ch?y: ch? xo? theo prefix/`SCAN MATCH`, kh?ng `FLUSHALL`.
- **Q-X1-d (CI, DEBT-004)**: ?? XU?T CI t? d?ng Mongo **c? `--replSet rs0`** + init rs (service `mongo:7` hi?n CH?A c? `--replSet`) + Redis service, c?i Playwright browsers (`--with-deps`), seed, r?i ch?y `e2e`. Kh?c local: CI d?ng service container GH Actions, kh?ng ph?i `aegate-*`.

---

## Chốt tech-lead *(tech-lead fold — ưu tiên hơn mô tả task bên dưới nếu mâu thuẫn)*

**Agent**: T1 → **backend-dev**; T2, T3, T4, T5 → **frontend-dev** (T5 phần CI env BE: tham chiếu `be/src/config/validation.schema.ts`). Thứ tự: T1 ∥ T2 → T3 → T4 → T5 (DEBT-081 trong T5 làm song song được).

**Q-X1-a** ✅ package `e2e/` riêng (thêm vào `pnpm-workspace.yaml`), `@playwright/test` pin exact, cập nhật `pnpm-lock.yaml`.
- **CẤM** đặt script tên `test` trong `e2e/package.json` (root `pnpm test` = `pnpm -r run test` trong job `quality` sẽ kéo Playwright + webServer). Dùng `"e2e": "playwright test"`; root thêm `"e2e": "pnpm -C e2e e2e"`. Có `typecheck` (+ `lint` nếu cấu hình) để job `quality` vẫn xanh.
- Browser local: `pnpm -C e2e exec playwright install chromium` (ghi README); CI: `--with-deps chromium`.

**Q-X1-b** ✅ **KHÔNG tái dùng `ADMIN_SEED_*`** — plan D6/B6.4 dành cho admin (`UserTenant.roles` `super_admin`/`tenant_admin`); trộn user demo với admin sẽ cấp nhầm quyền khi B6.4 tới. Dùng `DEV_SEED_EMAIL` / `DEV_SEED_PASSWORD`:
- Chỉ đọc trong `seed-dev.ts` (zod riêng của script), **KHÔNG** thêm vào `envSchema` của app (không làm boot/int-test đòi biến mới). Thiếu biến → lỗi nêu tên biến, exit 1, trước khi connect.
- Validate: email hợp lệ; password 8–128 (cùng luật `validatePassword`); `normalizeEmail(DEV_SEED_EMAIL) !== normalizeEmail(ADMIN_SEED_EMAIL)` → nếu trùng: throw (không seed user dev trùng admin).
- Ghi: `users.updateOne({email: normalized}, {$set:{passwordHash, failedLoginCount:0}, $min:{emailVerifiedAt: now} (set nếu thiếu, giữ mốc cũ nếu đã có), $unset:{lockedUntil:1}}, {upsert:true})` rồi upsert **`UserTenant {userId, tenantId: DEFAULT_TENANT_ID}` với `roles: []`, `status:'active'`** (như `register()` — thiếu membership thì `TenantGuard` 403). **Không** gán role nào. Log: `seed-dev: upserted user <sub>` (sub + email OK, không password/hash).
- Ghi chú: nếu email đã tồn tại (đăng ký tay), seed **ghi đè password** — chấp nhận vì dev-only, ghi rõ trong comment/README.
- Thêm `DEV_SEED_EMAIL=dev@example.com`, `DEV_SEED_PASSWORD=` (để trống) vào `be/.env.example`.

**Q-X1-c** ✅ cô lập theo **namespace riêng**, không flush gì cả:
- BE hỗ trợ DB index qua URL: `new IORedis(database.redisUrl, …)` (`redis.module.ts:45`) → ioredis parse `/N`. Lua dùng `defineCommand`/EVALSHA (script cache theo server, không theo DB — OK); không có pub/sub, `duplicate()`, `SELECT`, keyspace notification (grep 0) → đổi DB index an toàn. Key prefix không cần.
- **Dev**: `REDIS_URL=redis://localhost:6379/1` (db0 của `aegate-redis` đang có 13 key của project khác), `MONGO_URI=…/sso-idp?directConnection=true`.
- **E2E**: `REDIS_URL=redis://localhost:6379/2`, `MONGO_URI=mongodb://localhost:27017/sso-idp-e2e?directConnection=true` — DB riêng để E2E không đè user/consent/session của dev. Truyền qua `webServer.env` + env của bước seed (process env thắng `be/.env`: `main.ts` dùng `process.loadEnvFile` không-ghi-đè, `node --env-file-if-exists` cũng không ghi đè biến đã set).
- **CẤM** `FLUSHALL`/`FLUSHDB`/`dropDatabase` ở mọi script E2E (kể cả DB riêng — tránh cấu hình nhầm đánh vào db0). Idempotent nhờ seed; rate-limit không thành vấn đề: 1 login/run ≪ `RATE_LIMIT_MAX=100`/60s, client public không qua client-auth secret, `failedLoginCount` được seed reset mỗi run.
- `reuseExistingServer: false` mặc định (cổng 4000/5173 bận → fail rõ, tránh vô tình chạy E2E trên BE dev đang trỏ DB dev). Cho phép reuse chỉ khi `E2E_REUSE=1` (ghi README: khi đó env là của server đang chạy).

**Q-X1-d** ✅ CI **giữ Mongo single-node, KHÔNG `--replSet`** (grep `startSession`/`withTransaction` = 0; YAGNI). Mở lại khi có transaction. URI CI: `mongodb://localhost:27017/sso-idp-e2e`, Redis `redis://localhost:6379/2` (đồng nhất local).

**Khởi động BE trong E2E/CI** (thay `start:dev --watch`):
- Chuỗi: `pnpm -C be build` → `pnpm -C be db:sync-indexes` → `pnpm -C be db:seed-dev` → `pnpm -C be start` (dist, không watch). Seed/sync chạy trong `globalSetup` hoặc bước trước webServer; `db:*` cần `dist/` (hiện chưa build).
- Readiness: `webServer.url = http://127.0.0.1:4000/ready` (200 chỉ khi Mongo+Redis OK; BE listen `0.0.0.0` IPv4 → dùng 127.0.0.1 cho probe, tránh `localhost`→`::1`). FE: `http://localhost:5173/` (Vite bind `localhost`). `timeout` 120s mỗi server.
- BE env E2E bắt buộc: `SESSION_COOKIE_SECURE=false` (http), `ISSUER=http://localhost:4000`, `KEY_LOCAL_DIR=./keys` (key tự sinh khi boot — `keys.module.ts:32`), SMTP trỏ Mailpit (không gửi mail trong X1; nodemailer không verify khi boot).
- FE env: `fe-sso-test/.env` **không tồn tại** → `webServer.env` set đủ `VITE_OIDC_*`/`VITE_DEMO_API_URL` (giá trị như `.env.example`, không secret).
- Luôn dùng host `localhost` cho trình duyệt (redirect_uri/CORS/cookie host-only khớp chính xác); `:5173`↔`:4000` same-site → cookie `SameSite=Lax` của BE hợp lệ; `/token` là fetch CORS (không cần cookie).

**T2 bổ sung**: ID token hiện chỉ có `sub, aud, iss, exp, iat, amr, acr, nonce` (`token.service.ts` `signIdToken`) — **không có `email`**; không gọi thêm `/userinfo` trong X1. Claim render: `claim-sub`, `claim-iss`, `claim-aud`, `claim-exp`.

**T4 bổ sung (đo được, không cần đọc DB)**:
- Bắt response `/token` bằng `page.waitForResponse` → lấy `access_token`, `refresh_token`, `id_token`; assert `claim-sub` == `sub` decode từ `id_token` và khớp `/^[a-f0-9]{24}$/`; assert 3 chuỗi token **không** có trong `page.content()`, `page.url()`, `localStorage`/`sessionStorage` (qua `page.evaluate`).
- Consent: CI (DB sạch) luôn gặp `/authorize/consent` → bấm `Allow`; local lần 2+ có thể không có → chờ `Promise.race` giữa URL consent và `:5173/` rồi rẽ nhánh xác định (không `waitForTimeout`).
- Locator theo label `Email`/`Password`, button `Sign in` (`login.eta`).
- Trace/video: `trace: process.env.CI ? 'retain-on-failure' : 'off'` (trace ghi giá trị `fill` → chỉ bật ở CI với credential giả). Không `console.log` password.

**T5 bổ sung**: job `e2e` cần đầy đủ env BE của `envSchema` (GOOGLE_/GITHUB_/CSRF_SECRET/ADMIN_SEED_* = giá trị giả không-secret, viết thẳng trong `env:` job — KHÔNG dùng GitHub secrets); `DEV_SEED_*` giả; `NODE_ENV=test` hoặc `development` (≠ production); `actions/upload-artifact` `e2e/playwright-report` khi `failure()`; `retries: 0`; `needs: quality` không bắt buộc.

---

### [x] Task 1 [BE]: `db:seed-dev` t?o th?m user dev ?? verify email (DEBT-076)
- M? t?: M? r?ng `be/src/database/seed-dev.ts` upsert th?m **1 user** v?i `email`/`password` t? env, `emailVerifiedAt` ?? set (?? qua gate `authentication.service.ts:114` `!user.emailVerifiedAt`), `failedLoginCount=0`, kh?ng `lockedUntil`. `passwordHash` = `hashPassword` (argon2, nh? `user.service`). Idempotent: upsert keyed by email chu?n ho? (`normalizeEmail`). KH?NG log m?t kh?u.
- Acceptance (?o ???c):
  - Ch?y `pnpm -C be db:seed-dev` 2 l?n ? ??ng **1** user dev (email == `normalizeEmail(env)`), `emailVerifiedAt != null`, `failedLoginCount==0`, t?n t?i `passwordHash` (argon2 `$argon2`), 0 b?n ghi tr?ng.
  - `authService.login(email, password)` v?i c?p env ? th?nh c?ng (kh?ng `login_required`/kho?) ? ch?ng minh b?ng int-test ho?c k?ch b?n E2E Task 4.
  - `NODE_ENV=production` ? `seedDev` throw TR??C m?i ghi user (gi? `assertNotProduction`); c? test.
  - Grep source + stdout seed: m?t kh?u **kh?ng** xu?t hi?n (ch? log email/thao t?c).
  - Kh?ng hard-code secret trong repo: gi? tr? ch? t? `process.env` (zod schema); thi?u env ? l?i r? t?n bi?n.
- Security invariants:
  - T?i s?n: credential user dev (password ? hash). Actor: dev (???c), production/attacker (b? ch?n).
  - Invariant: dev tool KH?NG BAO GI? ghi DB production (fail-closed `NODE_ENV=production` tr??c connect + tr??c write); password kh?ng bao gi? ? d?ng r? trong DB/log/stdout.
  - Trust boundary: env ? seed ? Mongo DB `sso-idp`. State: (kh?ng c? user) ? upsert ? (user verified). Ch? ??ng DB `sso-idp`, kh?ng `dropDatabase`.
  - Abuse/failure: ch?y l?p (idempotent, kh?ng nh?n b?n); env thi?u ? throw r?; E11000 race ? coi l? success (nh? upsert hi?n t?i).
  - Exposure budget: password tuy?t ??i kh?ng v?o log/stdout/response/commit.
- Ph? thu?c: kh?ng (n?n cho Task 4).

### [x] Task 2 [FE]: Trang hi?n th? claims + s?a DEBT-078/079/080 (fe-sso-test)
- M? t?:
  - **Claims UI (X1 "hi?n th? claims")**: m? r?ng `routes/Home.tsx` (ho?c t?ch component) ?? khi ?? ??ng nh?p, render c?c claim an to?n t? `session.claims` (vd. `sub`, `email`/`email_verified` n?u c?, `iss`, `aud`, `exp`) ? ph?n t? c? **selector ?n ??nh** cho Playwright (vd. `data-testid="claims"` + `data-testid="claim-sub"`). Kh?ng render access/refresh token.
  - **DEBT-078**: trong `oidc/refresh.ts` nh?nh `catch`, ??i `deps.tokens.clear()` v? ?i?u ki?n ? `if (deps.tokens.get() === current) deps.tokens.clear();` (kh?ng xo? phi?n m?i sau logout?login l?i trong l?c refresh c? ?ang bay).
  - **DEBT-079**: g?i `consumeLogoutState` ? landing post-logout (Home khi URL c? `?state=`/tr? v? t? IdP), r?i xo? query kh?i URL; fail-closed n?u kh?ng kh?p. B? key `oidc:logout_state` c?n s?t.
  - **DEBT-080**: trong `oidc/token-exchange.ts` b? n?i nguy?n v?n `error_description`; ch? gi? `error` code (sanitize gi?ng `callback.ts`), ??nh d?u l? l?i IdP.
- Acceptance (?o ???c):
  - Sau ??ng nh?p, DOM c? `data-testid="claims"` li?t k? `sub` (== `session.claims.sub`) + ?1 claim kh?c; access/refresh token **kh?ng** xu?t hi?n trong DOM (assert kh?ng c? chu?i token).
  - DEBT-078: test ? refresh c? fail SAU khi store ?? ???c set phi?n M?I (`get() !== current`) ? phi?n m?i **c?n nguy?n** (store kh?ng b? clear); khi `get()===current` ? clear (fail-closed c? gi? nguy?n).
  - DEBT-079: test ? landing v?i `state` kh?p ? `consumeLogoutState===true`, key b? xo?, query r?i URL; `state` sai/thi?u ? `false` (fail-closed), key v?n b? xo? (one-shot).
  - DEBT-080: test ? `/token` tr? `{error, error_description:"<lure>"}` ? message hi?n th? KH?NG ch?a chu?i `error_description`; ch? ch?a code ?? sanitize.
  - `pnpm -C fe-sso-test typecheck|lint|test|build` xanh; kh?ng h?i quy 67 test (?67).
- Security invariants:
  - T?i s?n: access/refresh token (in-memory), logout state (CSRF). Actor: user, attacker craft URL.
  - Invariant: token KH?NG v?o DOM/URL/Web Storage/console (gi? invariant run 21); `error_description` do IdP/attacker ki?m so?t KH?NG render nguy?n v?n (ch?ng content-spoofing); phi?n m?i kh?ng b? refresh c? xo?.
  - Trust boundary: redirect/query t? IdP ? FE. State: logged-out + `state` ? verify ? xo? state. Fail-closed khi `state` sai.
  - Abuse/failure: `/callback?error=&error_description=<lure>`; refresh race (logout?login); `state` sai/thi?u/l?p.
  - Exposure budget: token kh?ng ? DOM/URL/log; n?i dung do attacker ki?m so?t kh?ng echo nguy?n v?n.
- Ph? thu?c: kh?ng (??c l?p BE).

### [x] Task 3 [E2E]: D?ng package `e2e/` + Playwright (webServer BE :4000 + FE :5173)
- M? t?: T?o package `e2e/` (th?m v?o `pnpm-workspace.yaml`): `@playwright/test`, `playwright.config.ts` v?i **2 `webServer`** (BE `pnpm -C be start:dev` c?ng 4000 ch? `/.well-known/openid-configuration` 200; FE `pnpm -C fe-sso-test dev` c?ng 5173 `strictPort`), `baseURL=http://localhost:5173`, `reuseExistingServer` local. Ch? **Chromium** cho X1 (?a tr?nh duy?t ?? X3). Script `e2e:seed` ch?y `pnpm -C be db:seed-dev` **tr??c** test (globalSetup ho?c webServer command). `.env`/env ??c t? `be/.env` (kh?ng ch?p secret v?o repo). Th?m `e2e/.env.example` (gi? tr? non-secret: URL, email dev; password ?? tr?ng/placeholder).
- Acceptance (?o ???c):
  - `pnpm -C e2e exec playwright --version` ch?y; `playwright.config.ts` typecheck/lint s?ch (n?u b?t lint package).
  - `pnpm -C e2e test` (ch?a c?n k?ch b?n) **kh?i ??ng ???c** c? BE :4000 (GET `/.well-known/openid-configuration` ? 200) v? FE :5173 (GET `/` ? 200), r?i teardown; kh?ng chi?m c?ng sau khi xong.
  - `db:seed-dev` ch?y ??ng 1 l?n tr??c suite; kh?ng `FLUSHALL`/`dropDatabase`.
  - `pnpm install` kh?ng h?ng workspace; `fe-sso-test`/`be` test c? kh?ng b? k?o devDeps Playwright.
- Security invariants:
  - T?i s?n: `be/.env` secret (SMTP/keys), DB/Redis d?ng chung. Actor: dev/CI.
  - Invariant: kh?ng ch?p secret v?o `e2e/` hay commit; kh?ng ??ng DB ngo?i `sso-idp`; kh?ng flush Redis d?ng chung.
  - Trust boundary: config ??c env l?c ch?y, kh?ng hard-code. Failure: c?ng b?n ? fail r? (strictPort); BE kh?ng healthy trong timeout ? fail, kh?ng treo.
  - Exposure budget: password/secret kh?ng v?o `playwright.config.ts`, report, hay log CI.
- Ph? thu?c: Task 1 (seed user) ?? k?ch b?n Task 4 ??ng nh?p ???c.

### [x] Task 4 [E2E]: K?ch b?n Playwright 1 ? login ? /authorize ? /token ? claims
- M? t?: 1 spec: m? FE `/` ? b?m "Sign in" (`startLogin` ? BE `/authorize`) ? b? chuy?n t?i UI BE `GET /login` ? ?i?n email/password dev (env) ? submit (`POST /login`) ? (consent n?u hi?n) ? callback `/callback` ??i code t?i `/token` ? v? `/` ? **th?y claims** (`data-testid="claims"`, `claim-sub` == `sub` ?? bi?t). Assert fail-closed: token kh?ng l? ? DOM/URL. D?ng credential dev t? env (Playwright ??c `process.env`), kh?ng hard-code.
- Acceptance (?o ???c):
  - `pnpm -C e2e test` ? **1 k?ch b?n PASS**: k?t th?c ? `/` v?i `data-testid="claim-sub"` hi?n th? `sub` kh?p user dev; URL `/` kh?ng c?n `code`/`state`.
  - Trong su?t flow: kh?ng c? access/refresh token trong DOM hay URL (assert `page.content()`/`page.url()` kh?ng ch?a token); kh?ng l?i console nghi?m tr?ng v? token.
  - Demo ???c: `README`/log ghi l?nh ch?y tay (`db:seed-dev` + `pnpm -C e2e test` ho?c `pnpm dev:all` + m? `:5173`).
  - Kh?ng flaky trong 3 l?n ch?y li?n ti?p local (ghi k?t qu?).
- Security invariants:
  - T?i s?n: phi?n user dev, token. Actor: user h?p l? (dev). Invariant: ch? user ??-verify ??ng nh?p ???c (gate `emailVerifiedAt`); code ??i ??ng 1 l?n; token kh?ng l? URL/DOM.
  - Trust boundary: FE ? BE qua `/authorize`/`/token`; state: anonymous ? login ? authenticated (session cookie BE + token in-memory FE). Failure: sai m?t kh?u ? kh?ng c?p phi?n (c? th? th?m negative-check n?u r?, kh?ng b?t bu?c X1).
  - Exposure budget: m?t kh?u dev kh?ng v?o report/trace Playwright (t?t `trace` ch?a input nh?y c?m ho?c mask); kh?ng in password.
- Ph? thu?c: Task 1, 2, 3.

### [x] Task 5 [E2E]: B?t job CI `e2e` th?t (DEBT-004) + ponytail DEBT-081 (n?u r?)
- M? t?:
  - **DEBT-004**: s?a `.github/workflows/ci.yml` job `e2e` t? placeholder ? th?t: Mongo `mongo:7` **th?m `--replSet rs0`** + b??c init `rs.initiate()` (ho?c gi? single-node n?u x?c nh?n kh?ng c?n tx ? ?? grep 0 `startSession`; tech-lead ch?t), Redis `redis:7`; `MONGO_URI=.../sso-idp`, `REDIS_URL`; c?i Playwright (`pnpm -C e2e exec playwright install --with-deps chromium`); `db:seed-dev`; ch?y `pnpm -C e2e test`; upload report khi fail. Gi? job KH?NG ?? n?u lu?ng ?n.
  - **DEBT-081 (ponytail, n?u r?)**: xo? `KNOWN_ERROR_CODES` th?a trong `callback.ts:32` (gi? sanitize ?? ??) + b? option `alg` ch?t trong `test/helpers/jwt.ts` (hardcode RS256). Ch? l?m v? run 22 ?? ch?m `fe-sso-test`.
- Acceptance (?o ???c):
  - CI job `e2e` ch?y th?t tr?n PR m?u: install ? seed ? Playwright 1 k?ch b?n PASS; job xanh; th?i gian trong ng??ng h?p l? (ghi s?).
  - Mongo CI kh?i t?o xong (health check/ping OK) tr??c seed; kh?ng d?ng `aegate-*` (?? l? local).
  - DEBT-081: `KNOWN_ERROR_CODES` kh?ng c?n; `pnpm -C fe-sso-test test` v?n ?67 xanh; grep x?c nh?n option `alg` ch?t ?? b?.
- Security invariants:
  - T?i s?n: kh?ng c? secret th?t trong CI (d?ng DB/Redis ephemeral). Actor: CI runner.
  - Invariant: CI kh?ng d?ng secret production; `NODE_ENV` != production khi seed; kh?ng r? secret ra log/report.
  - Failure: Mongo/Redis service ch?a healthy ? job fail r? (kh?ng false-green); e2e flaky ? ?i?u tra, kh?ng retry m?.
  - Exposure budget: report/trace Playwright kh?ng ch?a credential (d?ng gi? tr? test CI).
- Ph? thu?c: Task 3, 4. (DEBT-081 ??c l?p ? c? th? l?m song song.)


### [x] Task 6 [BE]: DEBT-084 — CSP `form-action` theo từng response cho form dẫn tới redirect RP *(tech-lead fold — DEBT-084)*
- **Agent**: backend-dev. **Thứ tự mới**: T6 → T4 (frontend-dev chạy lại) → T5. T4/T5 phụ thuộc T6.
- **Phương án chốt: (a) CSP theo từng response**, origin lấy từ URI **đã exact-match với client** phía server. Loại (b) trang trung gian: `code` nằm trong HTML (bfcache/back/cache), thêm 1 hop + phụ thuộc JS/click, đổi semantics 302 mà nhiều int-test đang khoá. Loại (c) bỏ `form-action`: mất lớp chống exfil form khi có HTML injection — không có lý do đủ mạnh.
- **Căn cứ**: Chromium áp `form-action` của *tài liệu chứa form* cho mọi bước redirect của navigation do form khởi tạo ⇒ header CSP của **response GET render form** quyết định; header của response POST/302 không liên quan. Override header per-response đã có tiền lệ (`renderFrontchannel`, `ui.controller.ts:338`; test `ui.int-spec.ts:1022`).

**Thiết kế**
1. `be/src/common/http/csp.ts` (mới): `buildCsp({ formAction?: string[]; frameSrc?: string[] }): string` — tập directive **y hệt** CSP global helmet đang phát (`main.ts` + default của helmet), chỉ nối thêm origin vào `form-action`/`frame-src`. `renderFrontchannel` chuyển sang `buildCsp({ frameSrc })` (một nguồn duy nhất; trang này giữ `form-action 'self'`). `safeCspOrigin(uri): string | null` = `new URL(uri).origin`; trả null nếu parse lỗi, origin `'null'`, scheme ≠ `https:`/`http:`, hoặc không khớp `^https?://[A-Za-z0-9.-]+(:\d{1,5})?$` (lớp 2 ngoài validator đăng ký — dữ liệu legacy/sửa tay ⇒ bỏ origin, fail-closed). Chỉ origin, không path/query; dedupe.
2. `AuthorizeRequestContextService.peek(requestId)` (mới): `GET` thuần — **không** DEL, **không** đổi TTL; `requestId` rỗng ⇒ null.
3. Route bị ảnh hưởng (set `Content-Security-Policy` qua `buildCsp` + `Cache-Control: no-store` trên response GET render form):

   | Route render form | Form → chuỗi redirect | Origin thêm vào `form-action` | Nguồn đã validate |
   |---|---|---|---|
   | `GET /login` (`ui.controller.ts:96`) | `POST /login` → 302 `/authorize?request_id` → 302 RP (code hoặc `AuthorizeRedirectError`) | origin(`ctx.redirectUri`) | `safeReturnTo(returnTo)` có `pathname === '/authorize'` và query **chỉ** có `request_id` → `peek()`; ctx tồn tại ⇒ `redirectUri` đã exact-match lúc tạo (`authorize.service.ts:148`) |
   | `GET /authorize` → `consent.eta` (`authorize.controller.ts:147`) | `POST /authorize/consent` → 302 RP (approve/deny/redirect-error) | origin(`redirectUri`) | thêm field `redirectUri` vào outcome `consent_required` (chỉ dùng cho header, KHÔNG truyền vào template) |
   | `GET /logout` (`ui.controller.ts:128`) | `POST /logout` → 302 `post_logout_redirect_uri` (hoặc trang frontchannel) | origin(`resolved`) chỉ khi `resolved !== defaultRedirect` | `resolvePostLogoutRedirect` (hint ký hợp lệ + client tồn tại + exact-match `postLogoutRedirectUris`) |

   - Không đổi: `/register`, `/forgot`, `/reset`, `/verify-email`, `/`, `error.eta`, `message.eta`, trang frontchannel (điều hướng bằng script, không phải form) — giữ CSP global `form-action 'self'`.
   - Không có context hợp lệ (thiếu/hết hạn/đã dùng/returnTo khác dạng) ⇒ chỉ `'self'` (login thường vẫn chạy; resume hỏng đằng nào cũng ra trang lỗi first-party).
4. Sửa comment DEBT-015 sai ở `authorize.controller.ts:45-48` (redirect sau POST **có** bị `form-action` chặn trên Chromium).

**Failure semantics**
- `peek()` lỗi/timeout Redis ở `GET /login` ⇒ **fail-closed cho CSP** (chỉ `'self'`), vẫn render 200 trang login; log `warn` không chứa `request_id`/returnTo; không retry.
- `GET /logout`: lỗi trong `resolvePostLogoutRedirect` giữ hành vi hiện tại — không nới CSP.
- `safeCspOrigin` null ⇒ bỏ origin (flow tới RP có dữ liệu hỏng bị browser chặn — chấp nhận, không nới CSP).

**Security invariants**
- Tài sản: lớp chống exfil form (password ở `/login`, CSRF token), `code`. Actor: user; attacker tạo link `/login?returnTo=…` / `/logout?…`. Trust boundary: query string ↔ server state (ctx Redis, Client DB, chữ ký `id_token_hint`).
- **INV-084-1**: origin thêm vào `form-action` **chỉ** là `new URL(u).origin` với `u` ∈ `client.redirectUris` / `client.postLogoutRedirectUris` đã exact-match cho **chính request đó**; không bao giờ đọc từ `redirect_uri`/`returnTo`/`post_logout_redirect_uri` thô. Không wildcard, không scheme-source (`https:`), không `*`, tối đa 1 origin ngoài `'self'` mỗi response.
- **INV-084-2**: mọi directive khác giống hệt CSP global (không làm yếu `script-src`/`frame-ancestors`/`base-uri`/`object-src`…).
- **INV-084-3**: `peek` không tiêu thụ/gia hạn context (single-use của resume/consent giữ nguyên, C3).
- Abuse đã cân: link `/login?returnTo=/authorize?request_id=<ctx của attacker>` ⇒ chỉ thêm origin một redirect URI đã đăng ký — không mở đích mới so với redirect hiện có; dò `request_id` vô nghĩa (256-bit CSPRNG, TTL 10'); header chỉ lộ origin (không path/query/state). Header injection chặn 2 lớp (validator `/[;,\s]/` lúc đăng ký + regex `safeCspOrigin`).

**Acceptance (đo được)** — int-test (`test/ui.int-spec.ts` / `test/authorize.int-spec.ts`) + unit `csp.spec.ts`:
1. **Test CSP theo route** (parse header thành map directive): `GET /login?returnTo=/authorize?request_id=<hợp lệ>` ⇒ `form-action` == `'self' <origin redirect_uri của client>`; mọi directive khác == CSP của `GET /register`; header không chứa path/query của redirect_uri.
2. `GET /login` khi: không returnTo / `returnTo=/` / request_id không tồn tại / đã consume / `returnTo=/authorize?request_id=X&redirect_uri=https://evil.example` / `returnTo=/authorize/consent?request_id=X` / `?redirect_uri=https://evil.example` ⇒ `form-action 'self'` nguyên văn.
3. `peek` không consume & không gia hạn: sau `GET /login`, `PTTL` không tăng và `GET /authorize?request_id` vẫn resume thành công; resume lần 2 ⇒ trang expired.
4. Redis lỗi khi peek (stub throw) ⇒ 200, `form-action 'self'`, log không chứa request_id.
5. Trang consent ⇒ `form-action 'self' <origin>`; approve/deny vẫn 302 như cũ (test hiện có xanh).
6. `GET /logout` hint hợp lệ + URI đã đăng ký ⇒ thêm origin; URI chưa đăng ký / hint sai / `client_id` lệch `aud` ⇒ `'self'`.
7. Client có redirect URI legacy chèn tay vào DB (host chứa `;`/space hoặc scheme lạ) ⇒ không thêm origin, header không bị tách directive.
8. Hồi quy: `/register`, `/forgot`, `/reset`, `/verify-email`, `/`, trang lỗi, trang frontchannel ⇒ CSP không đổi (frontchannel: `frame-src` như cũ, `form-action 'self'`); `buildCsp()` không tham số == header global đo từ app.
9. **E2E X1 xanh**: `pnpm e2e` (spec T4) PASS trên Chromium, không còn "violates form-action" trong console — backend-dev chạy 1 lần làm bằng chứng; frontend-dev chạy lại T4 (3 lần liên tiếp) rồi T5.
10. `pnpm -C be typecheck` + `lint`, unit + int toàn bộ xanh (không giảm số test).
- Phụ thuộc: không. Đóng DEBT-084. Ngoài phạm vi: federation B5 → DEBT-085.

---
## Ghi ch?
- SMTP (Mailpit :1025) kh?ng b?t bu?c cho X1 (user dev ?? verify s?n qua seed) ? ?? d?nh cho k?ch b?n ??ng k?/verify ? X2.
- N?u tech-lead lo?i b? user-seed trong `db:seed-dev` (t?ch script ri?ng), Task 1 ??i ph?m vi nh?ng acceptance gi? nguy?n.
