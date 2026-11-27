# Test Report — 2026-11-27 (run 101 tanstack-start, gate tester D101.11)

## Kết quả: PASS (mọi gate D101.11 chạy local đều xanh; CI sau push do orchestrator)

Phạm vi: working tree chưa commit trên `develop` (`3d9da40`) sau T1–T3 (Start 1.169.5 / Router 1.170.46, `.validator`, header qua `appendResponseHeader`/`setResponseHeader`, `protocol-relative-risk` viết lại, gỡ ignore Dependabot TanStack, bỏ override seroval, DEBT-715). Playwright giữ **1.64.1** (không cài browser). Tester không sửa code sản phẩm/test (mutation D101.6 tạm thời, khôi phục bằng bản sao, diff src/e2e trước = sau), không commit/stash/checkout, không restart container, chỉ tạo container của `fe-admin/scripts/docker-smoke.sh` (tự xoá) và image tạm `veyrigate-fe-admin:run101` (đã `docker rmi` theo tên). Không cần `vg-b73-vault` (vault không bắt buộc, BE không đổi).

Tổng kết:
- frozen-lockfile exit 0 (`✓ Lockfile passes supply-chain policies`), sha256 `pnpm-lock.yaml` trước = sau = `b7e4295c…4af5553b`. `pnpm audit --audit-level high` exit 0, `No known vulnerabilities found`.
- typecheck ×4 exit 0; `pnpm lint` (be, fe-admin, fe-sso-test) exit 0, 0 dòng error/warning; prettier be `All matched files use Prettier code style!`.
- unit: be **1361/1361** (69 suite), fe-admin **1669/1669** (69 file, 0 fail, 0 skip), fe-sso-test **269/269** (31 file). `protocol-relative-risk` 8/8.
- build be/fe-admin/fe-sso-test exit 0; `check:bundle` **0 hit**; image fe-admin build OK, `node v22.23.4`, smoke **18/18**.
- **int FULL 99 suite / 2526 pass**. DEBT-715: `run71-tester` **20/20** lần liên tiếp xanh (16/16 mỗi lần).
- **E2E 55 passed** (gồm 2 test D101.6 + assert `pragma` secrets). Mutation D101.6: bỏ `appendResponseHeader` ở `viewer.ts` ⇒ 2 đỏ (SSR, RPC); bỏ `setResponseHeader("pragma")` ⇒ secrets đỏ; khôi phục, `git diff` src/e2e sha256 trước = sau.
- **X3 42 passed** (chromium 14, firefox 14, webkit 14).
- `mutate.mjs all` **7/7 đỏ đúng**, `be/dist` sha256 trước = sau.
- pentest timing on: **must 269/269, should 1/1**; `--timing off`: **must 269/269, should 1/1**. `HYG-ACCESSLOG` 2430/2430 (lệch 1 dòng của run 100 không tái hiện).
- Bổ sung (runtime Start 1.169.5 thật): probe CSRF `/_serverFn` trên fe-admin của E2E ⇒ 403 cho cross-site/same-site/Origin lạ/không header (GET + POST); same-origin qua CSRF.

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g101/*.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Preflight (06:34Z): `codegraph sync`; `docker ps -a`; SMTP; cổng; `~/.vg-drill.lock`; mutant dir; sha256 lockfile; lưu `git diff -- fe-admin/src be/src e2e` | `codegraph sync` Done. Chỉ 3 container `veyrigate-redis/mongo/mailpit-1`. SMTP `220 d34120f10a43 Mailpit ESMTP Service ready`. Cổng 3000/3300/4000/4100/4400/5173/5273/5274/8443/4987–4990/18200 trống (không kill gì). Không lock drill, không `be/.pentest-mutant-*`. Lockfile `b7e4295c…`. diff src/e2e sha256 `8b8bf8bc…` |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high`; `pnpm -C e2e exec playwright --version` | install exit 0, `✓ Lockfile passes supply-chain policies`, `Lockfile is up to date, resolution step is skipped`. sha256 sau = `b7e4295c…` (không đổi). audit exit 0 `No known vulnerabilities found`. `Version 1.64.1` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm lint`; `pnpm -C be exec prettier --check "src/**/*.ts" "test/**/*.ts"` | 4/4 exit 0. lint exit 0 (be/fe-sso-test/fe-admin `Done`), 0 dòng error/warning. prettier `All matched files use Prettier code style!`. Manifest: `@tanstack/react-start 1.169.5`, `@tanstack/react-router 1.170.46`; `pnpm-workspace.yaml` 0 dòng `seroval`; `.github/dependabot.yml` 0 dòng `tanstack`; `fe-admin/src` 0 `getResponseHeaders`/`inputValidator` |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` (06:38Z); `vitest run test/protocol-relative-risk.test.ts` | be `Test Suites: 69 passed`, `Tests: 1361 passed, 1361 total`, 0 "failed to exit gracefully". fe-admin `Test Files 69 passed (69)`, `Tests 1669 passed (1669)`. fe-sso-test `Test Files 31 passed (31)`, `Tests 269 passed (269)`. protocol-relative `Tests 8 passed (8)` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `pnpm -C fe-admin check:bundle`; `pnpm -C fe-sso-test build` | 4/4 exit 0. Có `be/dist/main.js`, không có `be/dist/src`. `check:bundle scanned 23 client files for 8 server env names + 0 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)`. `git status --short` sau build = trước (không file sinh ra mới/đổi) |
| 5 | `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:run101 .`; `docker run --rm --entrypoint node <img> -v`; `timeout 10m bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:run101`; `docker rmi veyrigate-fe-admin:run101` | 06:40→06:43Z. build exit 0; `v22.23.4`. smoke exit 0, `docker-smoke: 18/18 passed` (1, 2, 3 CSP/nosniff/no-store, 4 `/` 307 login, 5, 6, 7 traversal, 8 `/auth/login` 503 no-store, 8b, 9 413, 9b `//a` 404 không Location, 9c, 10, 11, 12, 12b, 13, 14). Sau đó chỉ 3 container `veyrigate-*`; `Untagged: veyrigate-fe-admin:run101`, `docker images \| grep -c run101` = 0 |
| 6 | SMTP; `timeout 40m pnpm -C be test:int` | SMTP 220, db7 0. 06:43:37→07:00:15Z, exit 0: `Test Suites: 99 passed, 99 total`, `Tests: 2526 passed, 2526 total`, `Time: 996.563 s` |
| 7 | `for i in 1..20: pnpm -C be test:int run71-tester` (dừng ở lần đỏ đầu) | 07:00:25→07:09:40Z, **20/20** rc=0, mỗi lần `Tests: 16 passed, 16 total` |
| 8 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 07:09:51→07:22:52Z, exit 0, **`55 passed (13.0m)`**, 0 failed/flaky. `ok 18 … SSR with an unknown session cookie => 307 to login and the cookie cleared (D101.6)`, `ok 19 … RPC getViewer with an unknown session cookie clears it and goes to login (D101.6)`, `ok 22 … fe-admin secrets: issue once, rotate…` (assert `pragma`). Access log BE `request completed` 1268 dòng (53 test run 100: 1245; thêm 2 test), dòng chứa `set-cookie`/`idp_session`: **0** |
| 8b | Trong lúc #8 chạy: `curl` tới fe-admin E2E `http://localhost:3000/_serverFn/abc` | GET + POST (`--data '{}'`) với `sec-fetch-site: cross-site` / `same-site` / `origin: http://evil.example` / không header ⇒ **403** cả 8. Đối chứng `sec-fetch-site: same-origin` ⇒ 500 `Invalid server function ID: abc` (qua CSRF, id giả), `cache-control: no-store`, không stack. (POST không body ⇒ 411 từ body-limit trước CSRF, đã lặp lại có body) |
| 9a | Mutation D101.6 (a): sao lưu `viewer.ts`, thay dòng 13 (`if (setCookie) appendResponseHeader(...)`) bằng comment; `pnpm -C e2e e2e tests/fe-admin-risk.spec.ts -g "D101.6"`; chép lại bản sao | rc=1, **2 failed**: SSR `only the clearing Set-Cookie Expected 1 Received 0`; RPC `exactly one fea_sid Set-Cookie Expected 1 Received 0`. sha256 `viewer.ts` sau khôi phục = trước `0b131f18…` |
| 9b | Mutation D101.6 (b): sao lưu `instance.ts`, thay dòng 46 (`setResponseHeader("pragma", "no-cache")`) bằng comment; `pnpm -C e2e e2e tests/fe-admin-secrets.spec.ts`; chép lại | rc=1, **1 failed**: `issue answer has pragma: no-cache Expected true Received false`. sha256 `instance.ts` sau = trước `f5167f30…`. `git diff -- fe-admin/src be/src e2e` sha256 sau mutation = trước `8b8bf8bc…` (`cmp` identical) |
| 10 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 07:25:48→07:35:26Z, exit 0, **`42 passed (9.6m)`**. chromium **14**, firefox **14**, webkit **14** |
| 11 | sha256 cây `be/dist` (bỏ `.map`); `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại | Trước = sau `46085457e5308808`. 07:35:42→07:39:02Z, exit 0. m1 1/53 (`OAUTH-PKCE-plain`), m2 58/63, m2b 2/154, m2c 3/154, m2d 1/23 (`INJ-TEMPLATE-reflect`), m3 17/21 (IDOR cross-tenant), m4 1/23 (`CONTRACT-REQID-untrusted`), tất cả `expected red YES`. `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none` |
| 12 | SMTP; `timeout 25m node be/scripts/pentest/pentest.mjs` (timing on, lượt chính thức) | SMTP 220. exit 0, `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261127T074203Z.json`: `ok true`, 270 check, 0 `pass:false`, `cleanupErrors []`. `HYG-ACCESSLOG` pass `accessLines 2441, responses 2430, logged 2430`, `POST /login 518/518`, `POST /token 38/38`. `HYG-BELOG`, `HYG-SMTP-AFTER`, `SESS-COOKIE-FLAGS` pass |
| 13 | `timeout 15m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g101/off` | exit 0 (→07:45:03Z), `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. `ok true`, 270 check, 0 fail, `HYG-ACCESSLOG` `728/717/717` (`POST /login 90/90`, `POST /token 38/38`) |
| 14 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | 16 file `*20261127T07*` (pentest + 7 mutant json/log) + 2 file `off`: **0 hit** (grep exit 1) |
| 15 | Dọn (07:45Z) | `docker ps -a`: chỉ `veyrigate-redis/mongo/mailpit-1`. Image `run101` 0. Redis db7 0, `vg:int-lock` 0. Mongo `admin config local sso-idp-e2e vg-int-run57t-1795067857303` (giống run 100, không DB mới sót). Không `~/.vg-drill.lock`, không `be/.pentest-mutant-*`. Cổng trống. Lockfile `b7e4295c…` không đổi. diff src/e2e `8b8bf8bc…` không đổi. `git status` chỉ thêm 8 file evidence json (dưới) |

## Test FAIL

Không có.

## Quan sát (không chặn)

- **D101.7 nói smoke fe-admin "gồm 403 cross-site `/_serverFn`"**: `docker-smoke.sh` không có check này (chỉ check 9 POST 413 vào `/_serverFn/x`). CSRF server fn được khoá bởi unit `fe-admin/test/csrf-wiring.test.ts` (middleware thật của `start.ts` trên Start 1.169.5, chuỗi middleware dựng lại) và tester đã probe runtime thật ở #8b (403 cả 8 tổ hợp). Không mở DEBT (đã có bằng chứng runtime); orchestrator cân nhắc thêm check smoke nếu muốn khoá trên image prod.
- **Mutation 9b** làm test secrets đỏ giữa chừng ⇒ có thể để lại 1 client test trong DB `sso-idp-e2e` (DB riêng của E2E, test tự tạo dữ liệu tên ngẫu nhiên); X3 + pentest sau đó vẫn xanh.
- `HYG-ACCESSLOG` lần này responses = logged (2430/2430, 717/717): lệch 2451/2450 của run 100 không tái hiện.

## File evidence mới chưa track (để orchestrator commit nếu run đóng)

- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261127T074203Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261127T073614Z.json`, `…073637Z`, `…073702Z`, `…073724Z`, `…073801Z`, `…073823Z`, `…073901Z` (cùng thư mục).
- `.log` tương ứng bị `.gitignore`. Lượt `--timing off` ở scratchpad tester.

## Coverage acceptance criteria (D101.11)

- [x] Lockfile sha256 trước = sau frozen; audit high exit 0 (#1)
- [x] typecheck ×4, lint, prettier --check be (#2)
- [x] Unit be 1361, fe-admin 1669 (0 fail), fe-sso-test 269; protocol-relative 8/8 không giảm (#3)
- [x] Build be/fe-admin/fe-sso-test, `check:bundle` 0 hit (#4)
- [x] Image fe-admin + smoke 18/18 (CSP/no-store, `//a` 404 không Location, traversal, fail-closed config), image tạm xoá theo tên (#5)
- [x] Int FULL 2526, Mailpit 220 trước khi chạy (#6)
- [x] DEBT-715: `run71-tester` 20/20 liên tiếp (#7)
- [x] E2E 55 (53 + 2 D101.6) + assert `pragma` secrets (#8)
- [x] Mutation D101.6: viewer append ⇒ 2 đỏ, pragma ⇒ 1 đỏ, hoàn tác y nguyên (#9a, #9b)
- [x] X3 42 (14/14/14) Playwright 1.64.1 (#10)
- [x] Mutations 7/7 (#11); pentest on/off must 269/269 + `HYG-ACCESSLOG` (#12, #13)
- [ ] CI 9/9 sau push: orchestrator

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Bằng chứng |
|---|---|---|
| Credential: cookie phiên `fea_sid` không hợp lệ (SSR + RPC) | Xoá đúng 1 `Set-Cookie` (Max-Age=0/HttpOnly/SameSite/Path=/), 307 login, no-store; RPC xoá cookie + về login; mutation bỏ append ⇒ đỏ | #8, #9a |
| Exposure/cache: answer secret issue/rotate | `cache-control: no-store` + `pragma: no-cache` (tín hiệu riêng `setNoStore`); mutation ⇒ đỏ; secret chỉ hiện 1 lần | #8, #9b |
| Request chain / CSRF server fn (Start 1.169.5 thật) | 403 cross-site/same-site/Origin lạ/không header, GET + POST; same-origin qua (đối chứng); X3 cookie-matrix 3 browser; pentest SESS-CSRF-* + mutant m2/m2b/m2c đỏ đúng | #8b, #10, #11, #12 |
| Input: URL `//`, `%5C`, traversal | `protocol-relative-risk` 8/8 với `getNormalizedURL` thật router-core 1.171.39; smoke 9b/9c `//a`, `/%5C…` 404 không Location; smoke 7 traversal | #3, #5 |
| Authorization cross-tenant | pentest IDOR-ADMIN-XTENANT pass; mutant m3 đỏ 17/21 | #11, #12 |
| Exposure: log/evidence/bundle | access log E2E 0 dòng cookie; `HYG-BELOG` pass; grep evidence 0 hit; `check:bundle` 0 env server trong client; DEBT-715 corpus bí mật Teredo trên body đã khử UUID 20/20 | #4, #7, #8, #12, #14 |
| Dependency / fail-closed config | smoke 11/12/12b/14 (env sai ⇒ exit 1, không lộ URL/canary); 8 `/auth/login` 503 không chi tiết khi IdP không tới được | #5 |
| Supply chain | frozen pass policies (≥ 14 ngày), lockfile không đổi, audit 0, Playwright 1.64.1, override seroval bỏ (lock vẫn 1.6.12) | #1, #2 |
| Namespace / hạ tầng chung | container smoke tự xoá, image tạm xoá theo tên, db7 0, lock 0, cổng trống, `be/dist` sha256 khớp, Mongo không DB mới, src diff không đổi sau mutation | #5, #9, #11, #15 |
