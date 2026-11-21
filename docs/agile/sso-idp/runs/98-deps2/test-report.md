# Test Report — 2026-11-21 (run 98 deps2, gate tester cuối theo D98.13)

## Kết quả: PASS (mọi bước D98.13 chạy được ở local đều xanh, số khớp kỳ vọng)

Phạm vi: working tree chưa commit trên `HEAD` = `5613da6` (T1 PR #18 9 gói + router 1.170.42, #19 jose 6.2.15, #20 `@fastify/view` 12.0.1, #21 TypeScript 6.0.3; T2 xoá `minimumReleaseAgeExclude`; T3 warn `TRUST_PROXY`; DEBT-713 bỏ 2 case unit). Tester không sửa code sản phẩm, không commit, không restart container, không tạo container nào ngoài `vg-b73-vault`.

Tổng kết:
- frozen-lockfile exit 0 ("passes supply-chain policies"); sha256 `pnpm-lock.yaml` trước = sau = `540fc9cd…19671`. `pnpm audit --audit-level high` exit 0, "No known vulnerabilities found".
- typecheck be / fe-admin / fe-sso-test / e2e 4/4 exit 0; lint be / fe-admin / fe-sso-test 3/3 exit 0, 0 dòng error/warning.
- unit: be **1361/1361** (69 suite), fe-admin **1669/1669** (69 file), fe-sso-test **269/269** (31 file).
- build be ⇒ `be/dist/main.js` (không có `dist/src/`); fe-admin build + `check:bundle` 0 hit.
- int FULL **99 suite / 2524 pass**. `test:vault` **5 suite / 32 pass**. Drill rotate local **23/23**, `ok true`.
- E2E **53 passed**; access log **1246** dòng `request completed` trên **75** URL, 0 dòng có cookie. X3 **42 passed**.
- `mutate.mjs all` **7/7 đỏ đúng**, `be/dist` sha256 trước = sau.
- Harness timing on: **must 269/269, should 1/1**, `HYG-ACCESSLOG` pass. `--timing off`: must 269/269. SMTP 220 ở mọi điểm kiểm, `HYG-SMTP-AFTER` pass cả hai lượt.
- Grep evidence: 0 secret.

**Chưa kiểm local** (để CI, theo D98.13 bước 9): Docker smoke be (check 14 mới: dòng warn `TRUST_PROXY` = 1 trong image production) và fe-admin, promtool, sbom. Logic warn T3 đã phủ bằng unit (xem #3).

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g98/*.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Preflight (04:04:25Z): `docker ps -a`; `docker images --digests hashicorp/vault`; Mongo `listDatabases`; `redis-cli -n 7 dbsize`; `EXISTS vg:int-lock`; `~/.vg-drill.lock`; SMTP; cổng | Chỉ 3 container `veyrigate-*`. Image vault `sha256:c2f66626…bb55` có sẵn local (không pull). Mongo: `admin config local sso-idp-e2e vg-int-run57t-1795067857303` (DB có sẵn, để nguyên). db7 0, lock 0, không có lock drill. SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990/18200 trống |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high` | exit 0: `✓ Lockfile passes supply-chain policies`, `Lockfile is up to date`. sha256 trước = sau `540fc9cd8505a790…e7b19671`. audit exit 0: `No known vulnerabilities found` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm -C {be,fe-admin,fe-sso-test} lint` | 4/4 exit 0; 3/3 exit 0, 0 dòng error/warning |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` (04:06:22Z) | be: `Test Suites: 69 passed, 69 total`, `Tests: 1361 passed, 1361 total`, `Time: 31.972 s`, 0 "failed to exit gracefully". fe-admin `Test Files 69 passed (69)`, `Tests 1669 passed (1669)`. fe-sso-test `Test Files 31 passed (31)`, `Tests 269 passed (269)` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `pnpm -C fe-admin check:bundle` | be exit 0, `be/dist/main.js` có, `be/dist/src` không có; tsbuildinfo duy nhất ngoài node_modules là `be/dist/tsconfig.build.tsbuildinfo` (đúng lệch được senior chấp nhận). fe-admin exit 0 (`✓ built in 2.05s`). check:bundle `scanned 23 client files … 0 Function/eval call(s)): 0 hit(s)`. `git status` không đổi |
| 5 | SMTP; `timeout 40m pnpm -C be test:int` | SMTP 220. 04:08:09→04:26:04Z, exit 0. `Test Suites: 99 passed, 99 total`, `Tests: 2524 passed, 2524 total`, `Time: 1073.498 s`. Sau đó: không thêm DB `vg-int-*`, lock 0 |
| 6 | `T=$(openssl rand -hex 16)` (chỉ trong shell, không in); `trap 'docker rm -f vg-b73-vault' EXIT`; `docker run -d --name vg-b73-vault …` đúng lệnh trong `be/test/vault-preflight.mjs` (127.0.0.1:18200, image theo digest); chờ `/v1/sys/health` 200; `VAULT_TEST_ADDR=… VAULT_TEST_ROOT_TOKEN=$T timeout 15m pnpm -C be test:vault` | 04:26:18→04:27:23Z. Health 200 sau 3 lần thử. exit 0: `Test Suites: 5 passed, 5 total`, `Tests: 32 passed, 32 total`, `Time: 59.04 s`. Trap chạy (`removed`); `docker ps -a` sau đó chỉ còn 3 container `veyrigate-*`. Log vault 0 dòng chứa chuỗi hex 32 ký tự (token không lộ) |
| 7 | `node be/scripts/drills/rotate-drill.mjs --provider local --dry-run` rồi không `--dry-run` | dry-run: `namespace ok: vg-drill-rotate-local absent; redis db 7 empty; ports 4987 free`. Thật: 04:27:35Z, 13.0 s, exit 0. Evidence `runs/87-X6-drills/evidence/rotate-local-20261121T042749Z.json`: `ok true`, **23/23** check `ok:true`, `cleanupErrors []`, `postCheck {drillDbsLeft:[], redisDbSizes{7:0}, e2eUnchanged true}`, `tools.node v22.23.4`. Warm RP verifier `acceptsAtOld true`, `acceptsNewAtImmediately false` (đúng prepublish). Drill đi qua `require('jose')` 6.2.15 (require(esm)) |
| 8 | SMTP; cổng; `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | SMTP 220, cổng trống. 04:28:04→04:40:53Z, `53 passed (12.7m)`, exit 0, `Terminated the WebServer` = **3** |
| 8a | Đếm access log BE trong output E2E | **1246** dòng `"msg":"request completed"` trên **75** URL khác nhau (giống run 96/97). Dòng access chứa `set-cookie`/`idp_session`: **0** |
| 9 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 04:41:03→04:50:59Z, `42 passed (9.9m)`, exit 0, `Terminated` = **4** |
| 10 | sha256 cây `be/dist` (bỏ `.map`); SMTP; `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại; SMTP | Trước `2dedcf15…57db9`, SMTP 220. 04:51:10→04:54:31Z, exit 0. m1 1/53 `OAUTH-PKCE-plain`; m2 58/63 (mọi `SESS-CSRF-*` + `SESSION-HARNESS`); m2b 2/154; m2c 3/154; m2d 1/23 `INJ-TEMPLATE-reflect` (view 12 + Eta); m3 17/21 `IDOR-ADMIN-XTENANT-*`; m4 1/23 `CONTRACT-REQID-untrusted`; tất cả `expected red YES`. Dòng cuối `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. Sau `2dedcf15…57db9` (khớp). SMTP 220 |
| 11 | SMTP; `redis-cli -n 7 dbsize`; `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức, timing on) | SMTP 220, db7 0. 04:54:46→04:58:03Z, exit 0. `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261121T045803Z.json`: `ok true`, `profile.timing "on"`, 270 check, 0 `pass:false`, `cleanupErrors []`, `mailpitStale 0`, `mailpitDeleted 500`, `smtpAfter "220"`, `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports 4989/4990 free}` |
| 11a | Các check chính (evidence #11) | `HYG-ACCESSLOG` pass: `accessLines 2436`, `responses 2425`, `logged 2425`, `POST /login 518/518`, `POST /token 38/38` (platform-fastify 12.3.3). `HYG-BELOG` pass: `lines 2574`, `scannedValues 106`, `violations []`. `HYG-SMTP-AFTER` pass. `SESS-COOKIE-FLAGS` pass. `INJ-TEMPLATE-reflect` pass (view 12). `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` median diff 0.9 / 2.5 / −1.3 / 0.6 ms (giới hạn 10 ms) |
| 12 | SMTP; `timeout 15m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g98/off` | SMTP trước 220. 04:58:03→05:01:03Z, exit 0. `timing checks skipped (--timing off, D93.4)`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence: `ok true`, `timing "off"`, 270 check, 0 `pass:false`, 4 `ENUM-SHAPE` / 0 `ENUM-TIME`, `HYG-ACCESSLOG`/`HYG-BELOG`/`HYG-SMTP-AFTER` pass, `smtpAfter "220"`, `cleanupErrors []`. SMTP sau 220 |
| 13 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | 20 file: 16 file `*20261121T04*` trong `runs/90-X6-pentest-signoff/evidence/` (json + log) + 2 file `off` + 2 file drill. **0 hit** (grep exit 1) |
| 14 | Dọn (05:01:34Z) | `docker ps -a`: chỉ `veyrigate-redis/mongo/mailpit-1` (không còn `vg-b73-vault`). Mongo `admin config local sso-idp-e2e vg-int-run57t-1795067857303` (DB có sẵn từ #0; tester không tạo `vg-int-*`, `vg-pentest`, `vg-drill-*` nào còn sót). db7 0, `vg:int-lock` 0, không còn `~/.vg-drill.lock`. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990/18200 trống. Không còn `be/.pentest-mutant-*`. `pnpm-lock.yaml` sha256 không đổi. SMTP 220. `git status` so với #0 chỉ thêm 9 file evidence (dưới) |

## Test FAIL
Không có.

## File evidence mới chưa track (để orchestrator commit)
- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261121T045803Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261121T045139Z.json`, `…045203Z`, `…045227Z`, `…045250Z`, `…045331Z`, `…045354Z`, `…045431Z` (cùng thư mục).
- `docs/agile/sso-idp/runs/87-X6-drills/evidence/rotate-local-20261121T042749Z.json`: drill rotate local 23/23.
- Các file `.log` tương ứng bị `.gitignore` (`*.log`). Lượt `--timing off` nằm ở scratchpad tester.

## Ghi chú
- DB `vg-int-run57t-1795067857303` vẫn còn từ trước run 97 (xem test-report run 97). Tester không drop.
- Vault: container tạo và xoá theo đúng tên `vg-b73-vault`, image đã có sẵn theo digest nên không có download. Root token chỉ nằm trong biến shell, không in, không ghi file.

## Coverage acceptance criteria

- [x] D98.13-1 / D98.9: frozen-lockfile qua chính sách (sau khi T2 xoá hết exclude), lockfile không đổi; audit high exit 0; typecheck ×4, lint ×3; unit be 1361 / fe-admin 1669 / fe-sso-test 269; be build ra `dist/main.js`; fe-admin build + check:bundle (#1–#4)
- [x] D98.13-2: Mailpit 220 ở :1025 (#0, #5, #8, #10, #11, #12, #14)
- [x] D98.13-3: int FULL 99 / 2524, gồm token / admin-keys / run86-key-prepublish / runbook-drill / federation F16 JWKS (jose 6, `generateKeyPair` extractable) / userinfo alg confusion / b73c; mongoose 9.12 trên Mongo 7 rs0 (#5)
- [x] D98.13-4: `test:vault` 32/32, container `vg-b73-vault` tạo/xoá đúng tên (#6)
- [x] D98.13-5: drill rotate local 23/23, `ok true`, namespace sạch (#7)
- [x] D98.13-6: E2E 53 (mock-google qua ts-node + jose 6 + TS 6), access log 1246 / 75 URL (#8, #8a)
- [x] D98.13-7: X3 42 (#9)
- [x] D98.13-8: harness on/off must 269/269, `HYG-ACCESSLOG` pass (platform-fastify 12.3.3), `INJ-TEMPLATE-reflect` + mutant m2d (view 12) (#10–#12)
- [x] `mutate.mjs all` 7/7 đỏ đúng, `be/dist` sha256 trước = sau (#10)
- [x] T3 (DEBT-711, D98.11/D98.12): unit `trustProxyBootWarning` (production + unset/''/'  ' ⇒ message cố định chứa `TRUST_PROXY` và `runbook-deploy §5`; `false`/`FALSE`/` False `/CIDR ⇒ null; development/test/unset ⇒ null) trong be 1361 (#3)
- [ ] D98.13-9: Docker smoke be (check 14 warn = 1) / fe-admin, promtool, sbom — **chưa kiểm local**, để CI

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Credential (jose 6): ký/kiểm token, kid/thumbprint không đổi, JWKS remote, alg confusion | int FULL (token, admin-keys, federation F16, userinfo), vault 32 (Vault Transit kid/token), drill rotate (AT cũ vẫn kiểm được, key mới chưa dùng ngay) | #5, #6, #7 |
| State / rotation: emergency rotate, prepublish, refresh sau rotate | drill 23/23, int run86-key-prepublish | #5, #7 |
| Dependency: JWKS lỗi mạng ⇒ 502 (jose 6 `TypeError`) | int federation trong 2524 | #5 |
| Input / injection (view 12): escape template | `INJ-TEMPLATE-reflect` pass; mutant m2d đỏ | #10, #11a |
| Authorization / cross-tenant | `IDOR-ADMIN-XTENANT-*` pass; mutant m3 17 đỏ | #10, #11 |
| Request chain / CSRF / cookie | `SESS-CSRF-*` (m2/m2b/m2c đỏ), `SESS-COOKIE-FLAGS` pass, X3 42 | #9–#11 |
| Request id / access log (platform-fastify 12.3.3) | `HYG-ACCESSLOG` 518/518 + 38/38; `CONTRACT-REQID-untrusted` (m4 đỏ); E2E 1246 dòng | #8a, #10, #11a |
| Config / deploy (T3): fail-open có chủ đích, message không chèn env | unit (message cố định); smoke Docker để CI | #3 |
| Timing enumeration | `AUTHN-ENUM-TIME-*` diff ≤ 2.5 ms | #11a |
| Exposure: log / evidence | `HYG-BELOG` 0 vi phạm; access log E2E 0 cookie; grep evidence 0 hit; vault token không in | #6, #8a, #11a, #13 |
| Supply chain | frozen-lockfile qua chính sách không exclude; audit high 0 | #1 |
| Namespace / hạ tầng chung | `vg-b73-vault` đã xoá, db7 0, lock 0, cổng trống, không thư mục mutant, `be/dist` sha256 khớp, SMTP 220 mọi điểm | #6, #10, #14 |
