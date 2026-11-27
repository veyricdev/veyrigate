# Test Report — 2026-11-21 (run 99 deps3, gate tester D99.6)

## Kết quả: FAIL (X3 36/42; mọi gate khác chạy local đều xanh)

Phạm vi: working tree chưa commit trên `develop` (`574f42a`) sau D99.1–D99.5 (PR #23 14 gói, PR #22 digest node, banner `styles.css`, ghi chú DEBT-712). Tester không sửa code sản phẩm, không sửa test, không commit, không restart container, không tạo container ngoài container của `fe-admin/scripts/docker-smoke.sh` (tự xoá theo tên).

**Lý do FAIL**: X3 đỏ 6/42, toàn bộ ở project `webkit`. Nguyên nhân là assert nội bộ của Playwright 1.65.0 trong driver WebKit (`_WKPage._onTargetCreated`, `assert(!this._provisionalPage)`), không phải test viết sai (D99.3 a) và không phải app gửi cookie/host/path sai (D99.3 b). Không có cách sửa test mà giữ nguyên ngữ nghĩa, và D99.3 cấm hạ Playwright. Cần tech-lead quyết định (xem "Test FAIL").

Tổng kết:
- frozen-lockfile exit 0 ("passes supply-chain policies"). sha256 `pnpm-lock.yaml` trước = sau = `f88966f2…1d84e`. `pnpm audit --audit-level high` exit 0, "No known vulnerabilities found".
- typecheck ×4 exit 0. lint ×3 exit 0, 0 dòng error/warning.
- unit: be **1361/1361** (69 suite), fe-admin **1669/1669** (69 file), fe-sso-test **269/269** (31 file). Số test không đổi.
- build be ⇒ `be/dist/main.js` (không có `dist/src`). fe-admin build + `check:bundle` 0 hit. fe-sso-test build. `gen:api` ⇒ `schema.d.ts` không đổi.
- int FULL **99 suite / 2524 pass** (gồm `b74-tester.int-spec.ts`, traversal static).
- E2E **53 passed**. Access log **1246** dòng trên **75** URL, 0 dòng có cookie.
- **X3 36 passed / 6 failed** (chromium 14/14, firefox 14/14, webkit 8/14).
- `mutate.mjs all` **7/7 đỏ đúng**. sha256 `be/dist` trước = sau.
- pentest timing on: **must 269/269, should 1/1**. `--timing off`: **must 269/269**.
- Image: build be (build-stage + runtime) và fe-admin với digest `5ec23b7c…d96d` exit 0. `node -v` = `v22.23.4` ở cả 2 image. Smoke fe-admin **18/18**.
- **Smoke be 14 check: chưa chạy local.** Script cần `mongo:7.0.43@sha256:1f995ad6…` và `redis:7.4.10-bookworm@sha256:e9b2e45e…`, hai image này không có sẵn local. Brief chỉ cho phép pull image node, nên tester không pull. Để CI job `be-image` chạy, hoặc orchestrator cho phép pull rồi chạy `bash be/scripts/docker-smoke.sh veyrigate-be:run99 veyrigate-be:run99-build` (2 image đã build sẵn local).

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g99/*.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Preflight (07:26:50Z): `codegraph sync`; `docker ps -a`; image digest; SMTP; cổng; `~/.vg-drill.lock` | Chỉ 3 container `veyrigate-*`. Image node `5ec23b7c…`, mongo `1f995ad6…`, redis `e9b2e45e…` **không có** local. Image vault `c2f66626…` có. SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990/18200 trống. Không có lock drill |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high` | exit 0: `✓ Lockfile passes supply-chain policies`, `Lockfile is up to date`. sha256 trước = sau `f88966f2b71f93a8…ea49c5d1d84e`. audit exit 0: `No known vulnerabilities found` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm -C {be,fe-admin,fe-sso-test} lint` | 4/4 exit 0. 3/3 exit 0, 0 dòng error/warning |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` (07:29:46Z) | be: `Test Suites: 69 passed, 69 total`, `Tests: 1361 passed, 1361 total`, `Time: 33.674 s`, 0 "failed to exit gracefully". fe-admin `Test Files 69 passed (69)`, `Tests 1669 passed (1669)`. fe-sso-test `Test Files 31 passed (31)`, `Tests 269 passed (269)` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `check:bundle`; `pnpm -C fe-sso-test build`; `pnpm -C fe-admin gen:api` | be exit 0, có `be/dist/main.js`, không có `be/dist/src`. `styles.css`: 1 dòng đổi (banner, đã có từ dev). fe-admin exit 0 (`✓ built in 8.12s`). check:bundle `scanned 23 client files … 0 Function/eval call(s)): 0 hit(s)`. fe-sso-test exit 0. gen:api exit 0, `git status fe-admin` chỉ có `Dockerfile` + `package.json` (schema.d.ts không đổi) |
| 5 | SMTP; `timeout 40m pnpm -C be test:int` | SMTP 220. 07:31:52→07:49:26Z, exit 0. `Test Suites: 99 passed, 99 total`, `Tests: 2524 passed, 2524 total`, `Time: 1052.186 s`. `jest --listTests` 99 file, có `b74-tester.int-spec.ts` |
| 6 | `pnpm -C e2e exec playwright install chromium firefox webkit` | exit 0. Version 1.65.0. Tải Firefox 159.0 (v1572), WebKit 27.2 (v2388). Chromium 1254 đã có. Xoá browser cũ chromium-1223, firefox-1522, webkit-2287 |
| 7 | SMTP; cổng; `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | SMTP 220, cổng trống. 07:50:03→08:02:23Z, `53 passed (12.3m)`, exit 0, `Terminated the WebServer` = **3** |
| 7a | Đếm access log BE trong output E2E | **1246** dòng `"msg":"request completed"` trên **75** URL khác nhau (giống run 96–98). Dòng chứa `set-cookie`/`idp_session`: **0** |
| 8 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 08:02:32→08:07:09Z, exit 1: **`6 failed`, `36 passed (4.6m)`**, `Terminated` = 4. Fail: webkit `same-site 2`, `cross-site 1/3/4/5/7`, cùng message `Error: Assertion error` (xem "Test FAIL") |
| 8a | Chẩn đoán: `PWDEBUGIMPL=1 … --project webkit -g "1 interactive login — cross"`; spec chẩn đoán tạm `e2e/x3/zz-tester-diag.spec.ts` (đã xoá ngay sau đó, không còn trong `git status`) | Tái hiện 100%. Stack: `at assert (coreBundle.js:927)` ⇐ `at _WKPage._onTargetCreated (coreBundle.js:48871)` = `assert(!this._provisionalPage)`. Biến thể: beta→click Sign in (đỏ), beta→chờ 3 s→click (đỏ), alpha→beta→click (đỏ), beta→`goto idp/login` (đỏ), alpha→click→idp (xanh, same-site)→beta→click (đỏ), **beta→`goto idp/__x3_echo` (xanh, response không có COOP)**, beta→`goto idp/login` (đỏ). Xem phân tích bên dưới |
| 9 | sha256 cây `be/dist` (bỏ `.map`); SMTP; db7; `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại | Trước `29a36576…98bc8`, SMTP 220, db7 0. 08:14:35→08:18:02Z, exit 0. m1 1/53, m2 58/63, m2b 2/154, m2c 3/154, m2d 1/23, m3 17/21, m4 1/23 (`CONTRACT-REQID-untrusted`), tất cả `expected red YES`. Dòng cuối `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. Sau `29a36576…98bc8` (khớp) |
| 10 | SMTP; db7; `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức, timing on) | SMTP 220, db7 0. 08:18:17→08:21:33Z, exit 0. `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261121T082133Z.json`: `ok true`, timing `on`, 270 check, 0 `pass:false`, `cleanupErrors []`, `smtpAfter "220"` |
| 10a | Các check chính (evidence #10) | `HYG-ACCESSLOG` pass: `accessLines 2433`, `responses 2422`, `logged 2422`, `POST /login 518/518`, `POST /token 38/38` (platform-fastify 12.4.0). `HYG-BELOG` pass: `lines 2571`, `violations []`. `HYG-SMTP-AFTER` pass. `SESS-COOKIE-FLAGS` pass (6 cookie `__Host-`, `violations []`). `INJ-TEMPLATE-reflect` pass |
| 11 | SMTP; `timeout 15m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g99/off` | SMTP 220. 08:21:33→08:24:33Z, exit 0. `timing checks skipped (--timing off, D93.4)`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence: `ok true`, timing `off`, 270 check, 0 `pass:false`, `HYG-ACCESSLOG` (`POST /login 90/90`, `POST /token 38/38`) / `HYG-BELOG` / `HYG-SMTP-AFTER` pass, `cleanupErrors []`. SMTP sau 220 |
| 12 | `docker build -f be/Dockerfile --target build -t veyrigate-be:run99-build .`; `docker build -f be/Dockerfile -t veyrigate-be:run99 .`; `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:run99 .` | 08:24:51→08:30:59Z, 3/3 exit 0. Base image pull theo digest `5ec23b7c622b…d96d` (4 dòng `FROM`) |
| 12a | `docker run --rm --entrypoint node <img> -v` | `veyrigate-be:run99` ⇒ `v22.23.4`. `veyrigate-fe-admin:run99` ⇒ `v22.23.4` |
| 13 | `timeout 10m bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:run99` | exit 0, **18/18** `ok` (1, 2, 3, 4, 5, 6, 7, 8, 8b, 9, 9b, 9c, 10, 11, 12, 12b, 13, 14). Sau đó `docker ps -a` chỉ còn 3 container `veyrigate-*` |
| 14 | Smoke be (`be/scripts/docker-smoke.sh`) | **Không chạy**: cần pull `mongo:7.0.43@…` + `redis:7.4.10-bookworm@…` (không có local, brief không cho phép pull). Để CI `be-image` |
| 15 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | 16 file `*20261121T08*` (json + log) trong `runs/90-X6-pentest-signoff/evidence/` + 2 file `off`: **0 hit** (grep exit 1) |
| 16 | Dọn (08:31Z) | `docker ps -a`: chỉ `veyrigate-redis/mongo/mailpit-1`. db7 0, `vg:int-lock` 0, không có `~/.vg-drill.lock`, không có `be/.pentest-mutant-*`. Cổng 3000/3300/4000/4100/4400/5173/5273/5274/8443/4989/4990 trống. sha256 `pnpm-lock.yaml` không đổi. SMTP 220. Image local tester để lại: `veyrigate-be:run99`, `veyrigate-be:run99-build`, `veyrigate-fe-admin:run99` (giữ cho smoke be nếu được phép; xoá bằng `docker rmi` đúng 3 tag này) |

## Test FAIL

6 test `[webkit] › x3\cookie-matrix.spec.ts`:
- `same-site › 2 SSO second RP` (login trên `app.beta` trước),
- `cross-site › 1 interactive login`, `3 RP-initiated logout + replay`, `4 POST from RP to IdP without _csrf`, `5 fetch: Bearer via CORS + credentialed fetch`, `7 prompt=none in iframe`.

Kỳ vọng: 42 passed (như run 98 với Playwright 1.64.1 / WebKit 2287). Thực tế: `Error: Assertion error` sau khoảng 2.6 s. Page snapshot vẫn ở trang RP `app.beta` (nút "Sign in"): trình duyệt chưa commit trang IdP thì driver đã ném lỗi.

Phân tích:
- Stack (`PWDEBUGIMPL=1`): `_WKPage._onTargetCreated` ⇒ `assert(!this._provisionalPage)` trong `playwright-core@1.65.0`. WebKit báo tạo **target provisional thứ hai** trong khi target provisional đầu (process swap khi điều hướng cross-site) chưa xong, và driver Playwright không chịu được trường hợp này.
- Điều kiện kích hoạt (spec chẩn đoán tạm, đã xoá): điều hướng **cross-site** (`*.beta.localhost` ⇒ `idp.alpha.localhost`) tới một trang IdP có header `Cross-Origin-Opener-Policy: same-origin` (helmet mặc định, run trước không đổi). Cùng điều hướng cross-site tới `idp…/__x3_echo` (do proxy X3 trả, không có COOP) thì **xanh**. Same-site `app.alpha` ⇒ IdP (có COOP) thì **xanh**. Kết luận: WebKit 27.2 swap process 2 lần (site isolation + COOP), driver 1.65.0 assert.
- Không phải lỗi app (D99.3 b): chromium 14/14 và firefox 14/14 xanh, kể cả các assert cookie RFC 6265 (host-only, path, `__Host-`, Lax không gửi cross-site). `SESS-COOKIE-FLAGS` pentest pass. Header COOP và code BE không đổi trong run này. Lỗi xảy ra trước khi có bất kỳ assert cookie nào chạy.
- Không phải test sai theo ngữ nghĩa mới (D99.3 a): bước lỗi là một `click`/`page.goto` bình thường. Thêm chờ (3 s) vẫn lỗi. Không có cách viết lại test cho xanh mà không đổi luồng được kiểm (bỏ COOP, hay đi qua trang không phải IdP).
- Thông tin cho tech-lead: `@playwright/test` **1.65.1** phát hành 2026-11-13T21:12Z. Bản này chưa đủ 14 ngày (đủ ngày 2026-11-27) và tester chưa kiểm nó có sửa lỗi này không. CI không chạy X3 (`playwright.x3.config.ts`: "X3 does not run in CI"), nên CI xanh không chứng minh được X3.

Các hướng xử lý (tester không tự quyết):
1. Giữ `@playwright/test` 1.64.1 trong run này (tách khỏi #23), chờ 1.65.1 đủ tuổi rồi kiểm X3. Hướng này đụng D99.3 ("cấm hạ Playwright").
2. Đóng run với ngoại lệ X3 webkit cross-site có ghi DEBT. Hướng này giảm phủ ma trận cookie WebKit.
3. Chờ 1.65.1 (2026-11-27) rồi chạy lại X3.

Phân loại theo D99.3: **(c) lỗi công cụ (Playwright/WebKit driver)**, không thuộc (a) hay (b). Chuyển **tech-lead**, không chuyển backend-dev/frontend-dev (không có lỗi app).

## File evidence mới chưa track (để orchestrator commit nếu run đóng)
- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261121T082133Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261121T081502Z.json`, `…081525Z`, `…081548Z`, `…081610Z`, `…081701Z`, `…081723Z`, `…081801Z` (cùng thư mục).
- Các file `.log` tương ứng bị `.gitignore`. Lượt `--timing off` nằm ở scratchpad tester.

## Coverage acceptance criteria (D99.6)

- [x] Lockfile sha256 trước = sau frozen-install, audit không có high/critical (#1)
- [x] typecheck ×4, lint ×3 (#2)
- [x] Unit be 1361 / fe-admin 1669 / fe-sso-test 269, số không đổi (#3)
- [x] Build be (`dist/main.js`), fe-admin + `check:bundle` 0 hit, fe-sso-test. `gen:api` không đổi (#4)
- [x] Int FULL 2524, gồm `b74-tester` traversal static (Nest 12.4 #18414 không ảnh hưởng `@fastify/static`) (#5)
- [x] E2E 53 với Playwright 1.65.0 + browser mới (#6, #7, #7a)
- [ ] **X3 42: 36/42, FAIL** (webkit 6, lỗi driver Playwright 1.65.0) (#8, #8a)
- [x] Pentest on/off must 269/269 (#10, #11)
- [x] Mutations 7/7 (#9)
- [x] Image build với digest mới, `node -v` = `v22.23.4` ×2 (#12, #12a)
- [x] Smoke fe-admin 18 check (#13)
- [ ] Smoke be 14 check: **chưa chạy local** (thiếu image phụ trợ, không được pull). Để CI `be-image` (#14)
- [ ] Sau push CI 9/9: orchestrator lo

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Request chain / cookie (Playwright 1.65 RFC 6265) | chromium + firefox X3 28/28 (host-only, path, `__Host-`, Lax không gửi cross-site, replay sau logout); E2E 53; `SESS-COOKIE-FLAGS` pass. **WebKit cross-site chưa có bằng chứng** (lỗi driver) | #7, #8, #10a |
| Input / static traversal (Nest 12.4 #18414) | int `b74-tester` trong 2524; smoke fe-admin check 7 | #5, #13 |
| Authorization / cross-tenant | `IDOR-ADMIN-XTENANT-*` pass; mutant m3 đỏ 17 | #9, #10 |
| CSRF | `SESS-CSRF-*` (m2/m2b/m2c đỏ) | #9 |
| Request id / access log (platform-fastify 12.4.0) | `HYG-ACCESSLOG` 518/518 + 38/38; m4 đỏ; E2E 1246 dòng, 0 cookie | #7a, #9, #10a |
| Injection / template | `INJ-TEMPLATE-reflect` pass; m2d đỏ | #9, #10a |
| Exposure: log / evidence | `HYG-BELOG` 0 vi phạm; grep evidence 0 hit | #10a, #15 |
| Supply chain / base image | frozen-lockfile qua chính sách, audit high 0; image build theo digest `5ec23b7c…`, Node 22.23.4; fe-admin image hygiene (check 13) | #1, #12, #13 |
| Config fail-closed (fe-admin) | smoke 11/12/12b/14: env sai ⇒ exit 1, không lộ URL/canary | #13 |
| Namespace / hạ tầng chung | db7 0, lock 0, cổng trống, không thư mục mutant, `be/dist` sha256 khớp, SMTP 220 mọi điểm, chỉ 3 container `veyrigate-*` | #9, #16 |

---

# Lần 2 — 2026-11-27 (retry 1, D99.7: Playwright 1.64.1)

## Kết quả: PASS (gate D99.6 sau D99.7)

Phạm vi: working tree `develop` (`574f42a`) sau retry 1 của backend-dev: `e2e/package.json` `@playwright/test` 1.64.1 (trùng HEAD), lockfile chỉ khác 3 gói playwright so với lần 1, `dependabot.yml` ignore `@playwright/test` `1.65.0`, DEBT-714. Tester không sửa code sản phẩm, không sửa test, không commit/stash/checkout, không tạo hay restart container.

**Không chạy lại** unit (be 1361 / fe-admin 1669 / fe-sso-test 269), int 2524, pentest on/off 269/269, mutations 7/7, build image + smoke fe-admin 18/18: code app không đổi so với lần 1, lockfile chỉ đổi 3 gói playwright (devDependency của `e2e/`, không vào build/image). Các kết quả đó lấy từ lần 1 (bảng #1–#16 ở trên). Smoke be 14 check vẫn để job CI `be-image` (D99.7).

Kết luận về D99.7: X3 webkit **14/14 xanh trên WebKit 27.2 rev 2370** (Playwright 1.64.1), gồm đúng 6 test đã đỏ ở lần 1. Giả thuyết D99.7 đúng: lỗi nằm ở bộ Playwright 1.65.0 (driver `_WKPage._onTargetCreated` và/hoặc build WebKit 2388 đi kèm), không phải ở app hay ở WebKit 27.2 nói chung. Lần này không tách được driver 1.65.0 với build WebKit 2388, vì Playwright chỉ chạy được với browser revision đi kèm nó. Điều kiện đóng DEBT-714 (X3 webkit 14/14 trên ≥ 1.65.1) vẫn còn hiệu lực.

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g99r/{e2e,x3}.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| R0 | Preflight (01:09:18Z): `codegraph sync`; `docker ps -a`; SMTP; cổng; tiến trình `playwright\|jest\|vite`; `~/.vg-drill.lock` | `codegraph sync` Done. Chỉ 3 container `veyrigate-redis/mongo/mailpit-1` (Up). SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/3300/4000/4100/4400/5173/5273/5274/8443/4987–4990/18200 trống, không có tiến trình E2E/X3/BE test cũ (không phải kill gì, kể cả tiptap :5173). Không có lock drill |
| R1 | `pnpm install --frozen-lockfile` | exit 0: `✓ Lockfile passes supply-chain policies`, `Lockfile is up to date, resolution step is skipped`, pnpm v12.6.0. sha256 `pnpm-lock.yaml` trước = sau `8a0206f7c442f46c…ddeef8979` (khớp số backend-dev ghi). `git diff HEAD -- pnpm-lock.yaml \| grep -c playwright` = **0** (3 gói playwright trùng HEAD) |
| R2 | `pnpm -C e2e typecheck` | `tsc --noEmit`, exit 0 |
| R3 | `pnpm -C e2e exec playwright --version` | **`Version 1.64.1`** |
| R3a | `browsers.json` của `playwright-core@1.64.1`; `ls ~/AppData/Local/ms-playwright` | chromium **1248** (156.0.8078.4), firefox **1555** (157.0), webkit **2370** (27.2; override 2251 chỉ cho mac14). Cả 3 thư mục `chromium-1248`, `firefox-1555`, `webkit-2370` đã cài (còn sót `chromium-1254`, `firefox-1572`, `webkit-2388` của 1.65.0, không dùng) |
| R4 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 01:10:11→01:24:21Z, **`53 passed (14.1m)`**, exit 0, không flaky/retry. `Terminated the WebServer` = 3. Access log **1246** dòng `"msg":"request completed"` (giống lần 1), dòng chứa `set-cookie`/`idp_session`: **0** |
| R5 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` (cổng 3000/4000/4100/5173/5273/5274/8443 trống trước khi chạy) | 01:24:32→01:34:21Z, **`42 passed (9.8m)`**, exit 0, 0 failed, 0 flaky/retry, 0 dòng `Assertion error`. `Terminated` = 4. Theo project: chromium **14/14**, firefox **14/14**, webkit **14/14** |
| R5a | 6 test webkit đỏ ở lần 1 | `same-site › 2 SSO second RP` ok; `cross-site › 1 interactive login` ok (17.1s), `2 SSO second RP` ok (32.7s), `3 RP-initiated logout + replay` ok (41.2s), `4 POST from RP to IdP without _csrf` ok (45.0s), `5 fetch: Bearer via CORS + credentialed fetch` ok (19.9s), `7 prompt=none in iframe` ok (18.3s) |
| R6 | Dọn (01:34:52Z): `docker rmi veyrigate-be:run99 veyrigate-be:run99-build veyrigate-fe-admin:run99` | 3 dòng `Untagged`, `docker images \| grep -c run99` = 0. `docker ps -a` chỉ 3 container `veyrigate-*`. Cổng trống. sha256 lockfile không đổi `8a0206f7…8979`. SMTP 220. `git status` không có file mới ngoài những file đã có trước khi chạy |

## Test FAIL
Không có.

## Coverage acceptance criteria (D99.6 sau D99.7)
- [x] frozen-lockfile qua chính sách, sha256 trước = sau; lockfile vs HEAD không có dòng playwright (R1)
- [x] typecheck e2e (R2)
- [x] Playwright 1.64.1 + browser của 1.64.1, ghi revision (R3, R3a)
- [x] E2E 53 (R4)
- [x] **X3 42/42, ba trình duyệt 14/14, webkit-2370** (R5, R5a)
- [x] Unit / int / pentest / mutations / image + smoke fe-admin: giữ kết quả lần 1, không chạy lại (lý do ở trên)
- [ ] Smoke be 14 check: CI `be-image` (D99.7)
- [ ] Sau push CI 9/9: orchestrator lo

## Coverage security invariants / risk matrix
| Chiều | Đã kiểm | Xem |
|---|---|---|
| Request chain / cookie (RFC 6265: host-only, path, `__Host-`, Lax không gửi cross-site, replay sau logout, cookie tossing từ sibling) | X3 42/42 trên cả 3 engine; **bằng chứng WebKit cross-site đã có lại** (thiếu ở lần 1) | R5, R5a |
| Identity / credential / flow end-to-end | E2E 53 | R4 |
| Exposure: access log | 1246 dòng, 0 dòng có cookie | R4 |
| Supply chain | frozen-lockfile qua chính sách; 3 gói playwright trùng integrity HEAD | R1 |
| Hạ tầng chung | không tạo/restart container, cổng trống trước và sau, SMTP 220, xoá đúng 3 image lần 1 | R0, R6 |
