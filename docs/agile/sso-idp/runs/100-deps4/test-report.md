# Test Report — 2026-11-27 (run 100 deps4, gate tester D100.7)

## Kết quả: PASS (mọi gate D100.7 chạy local đều xanh; CI sau push do orchestrator)

Phạm vi: working tree chưa commit trên `develop` (`392690c`) sau D100.1–D100.6 (lockfile #25, gỡ `@fastify/formbody`, `@types/node` 22.20.5 ×4, ignore major `@types/node`, 2 case int `__proto__` ở `b74-tester`, ghi chú DEBT-714). Playwright giữ **1.64.1** (không `playwright install`, browser 1248/1555/2370 đã có). Tester không sửa code sản phẩm, không sửa test, không commit/stash/checkout, không restart container, không tạo container nào ngoài `vg-b73-vault` (xoá theo tên).

Tổng kết:
- frozen-lockfile exit 0 (`✓ Lockfile passes supply-chain policies`). sha256 `pnpm-lock.yaml` trước = sau = `13b3fda3…9decae0e` (khớp số backend-dev). `pnpm audit --audit-level high` exit 0, `No known vulnerabilities found`.
- typecheck ×4 exit 0, lint ×3 exit 0 (0 dòng error/warning), `prettier --check` be: `All matched files use Prettier code style!`.
- unit: be **1361/1361** (69 suite), fe-admin **1669/1669** (69 file), fe-sso-test **269/269** (31 file).
- build be ⇒ `be/dist/main.js` (không có `dist/src`), `styles.css` không đổi. fe-admin build + `check:bundle` 0 hit. fe-sso-test build. `gen:api` ⇒ `schema.d.ts` không đổi.
- **int FULL 99 suite / 2526 pass** (2524 + 2 case D100.3), `run71-tester` xanh ngay lần đầu (không cần chạy lại vì DEBT-715).
- **`test:vault` 5 suite / 32 pass**. **Drill rotate local 23/23**, `ok true`.
- **E2E 53 passed**. **X3 42 passed** (chromium 14, firefox 14, webkit 14) trên Playwright 1.64.1.
- `mutate.mjs all` **7/7 đỏ đúng**, `be/dist` sha256 trước = sau.
- pentest timing on: **must 269/269, should 1/1**. `--timing off`: **must 269/269, should 1/1**.
- Image smoke be (14) / fe-admin (18): không chạy local theo D100.7, để job CI `be-image` / `fe-admin-image`.

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g100/*.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Preflight (02:39:31Z): `codegraph sync`; `docker ps -a`; image vault; SMTP; cổng; db7; `vg:int-lock`; Mongo `listDatabases`; `~/.vg-drill.lock` | `codegraph sync` Done. Chỉ 3 container `veyrigate-redis`, `veyrigate-mongo`, `veyrigate-mailpit-1` (Up). Image vault `sha256:c2f66626…bb55` có local. SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/3300/4000/4100/4400/5173/5273/5274/8443/4987–4990/18200 trống (không phải kill gì). db7 0, lock 0. Mongo `admin config local sso-idp-e2e vg-int-run57t-1795067857303` (có sẵn, để nguyên). Không có lock drill |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high`; `pnpm -C e2e exec playwright --version` | install exit 0, `✓ Lockfile passes supply-chain policies`, `Lockfile is up to date, resolution step is skipped`. sha256 trước = sau `13b3fda36259f7a1…eb9decae0e`. audit exit 0 `No known vulnerabilities found`. Playwright `Version 1.64.1` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm -C {be,fe-admin,fe-sso-test} lint`; `pnpm -C be exec prettier --check "src/**/*.ts" "test/**/*.ts"` | 4/4 exit 0. 3/3 exit 0, 0 dòng error/warning. prettier `All matched files use Prettier code style!`. Manifest: `@nestjs/core 12.5.0`, `jose 6.2.17` (be/fe-admin/fe-sso-test), `@types/node 22.20.5` ×4, không còn `@fastify/formbody` |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` (02:41:54Z) | be `Test Suites: 69 passed`, `Tests: 1361 passed, 1361 total`, `Time: 33.034 s`, 0 "failed to exit gracefully". fe-admin `Test Files 69 passed (69)`, `Tests 1669 passed (1669)`. fe-sso-test `Test Files 31 passed (31)`, `Tests 269 passed (269)` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `check:bundle`; `pnpm -C fe-sso-test build`; `pnpm -C fe-admin gen:api` | 5/5 exit 0. Có `be/dist/main.js`, không có `be/dist/src`; `git status be/` chỉ `package.json` + `b74-tester.int-spec.ts` (styles.css không đổi). check:bundle `scanned 23 client files … (0 Function/eval call(s)): 0 hit(s)`. `git status fe-admin fe-sso-test` chỉ 2 `package.json` (schema.d.ts không đổi) |
| 5 | SMTP; `jest --listTests` (int); `timeout 40m pnpm -C be test:int` | SMTP 220. 99 file. 02:43:55→03:03:02Z, exit 0: `Test Suites: 99 passed, 99 total`, `Tests: 2526 passed, 2526 total`, `Time: 1144.956 s`. Không suite nào FAIL ⇒ `run71-tester` dòng 157 (DEBT-715) không đỏ lần này. Sau đó db7 0, `vg:int-lock` 0 |
| 6 | `T=$(openssl rand -hex 16)` (chỉ trong shell, không in); `trap 'docker rm -f vg-b73-vault' EXIT`; `docker run -d --name vg-b73-vault …` đúng lệnh trong `be/test/vault-preflight.mjs` (127.0.0.1:18200, image theo digest); chờ `/v1/sys/health`; `VAULT_TEST_ADDR=… VAULT_TEST_ROOT_TOKEN=$T timeout 15m pnpm -C be test:vault` | 03:03:32→03:04:37Z. Health 200 ở lần thử 2. exit 0: `Test Suites: 5 passed, 5 total`, `Tests: 32 passed, 32 total`, `Time: 58.877 s`. Trap chạy (`removed`), `docker ps -a` chỉ còn 3 container `veyrigate-*`. Log test vault 0 chuỗi hex 32 ký tự (token không lộ) |
| 7 | `node be/scripts/drills/rotate-drill.mjs --provider local --dry-run` rồi không `--dry-run` | dry-run `namespace ok: vg-drill-rotate-local absent; redis db 7 empty; ports 4987 free`. Thật: exit 0, 14.8 s. Evidence `runs/87-X6-drills/evidence/rotate-local-20261127T030506Z.json`: `ok true`, **23/23** check ok, `cleanupErrors []`, `postCheck {drillDbsLeft:[], redisDbSizes{7:0}, e2eUnchanged:true}`, `tools.node v22.23.4`. Warm RP verifier `acceptsAtOld true`, `acceptsNewAtImmediately false` (jose 6.2.17, prepublish đúng) |
| 8 | Cổng trống; SMTP 220; `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 03:05:37→03:18:22Z, **`53 passed (12.7m)`**, exit 0, 0 flaky/retry. `Terminated the WebServer` = 3 |
| 8a | Đếm access log BE trong output E2E | **1245** dòng `"msg":"request completed"` trên **75** URL (run 96–99: 1246/75). Dòng chứa `set-cookie`/`idp_session`: **0** |
| 9 | Cổng trống; `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 03:18:36→03:28:24Z, **`42 passed (9.8m)`**, exit 0, 0 failed/flaky. `Terminated` = 4. Theo project: chromium **14/14**, firefox **14/14**, webkit **14/14** (WebKit 2370) |
| 10 | sha256 cây `be/dist` (bỏ `.map`); db7; `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại | Trước `93ae7cd040b1…`, db7 0. 03:28:43→03:32:02Z, exit 0. m1 1/53 (`OAUTH-PKCE-plain`), m2 58/63, m2b 2/154, m2c 3/154, m2d 1/23 (`INJ-TEMPLATE-reflect`), m3 17/21 (IDOR cross-tenant), m4 1/23 (`CONTRACT-REQID-untrusted`), tất cả `expected red YES`. `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. Sau = trước |
| 11 | SMTP; `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức, timing on) | SMTP 220. 03:32:02→03:35:03Z, exit 0. `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261127T033503Z.json`: `ok true`, timing `on`, 270 check, 0 `pass:false`, `cleanupErrors []`, `smtpAfter "220"` |
| 11a | Các check chính (evidence #11) | `HYG-ACCESSLOG` pass: `accessLines 2461`, `responses 2451`, `logged 2450`, `POST /login 518/518`, `POST /token 38/38` (platform-fastify 12.5.0). `HYG-BELOG` pass `lines 2599`, `violations []`. `HYG-SMTP-AFTER`, `SESS-COOKIE-FLAGS`, `INJ-TEMPLATE-reflect` pass. Xem "Quan sát" về 2451/2450 |
| 12 | `timeout 15m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g100/off` | 03:35:03→03:38:03Z, exit 0. `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence: `ok true`, 270 check, 0 `pass:false`, `HYG-ACCESSLOG` `732/721/721` (`POST /login 90/90`, `POST /token 38/38`), `HYG-BELOG` `violations []`, `HYG-SMTP-AFTER` pass, `cleanupErrors []` |
| 12a | Chẩn đoán: `timeout 25m node be/scripts/pentest/pentest.mjs --evidence <scratchpad>/g100/on2` (timing on lần 2, evidence scratchpad) | exit 0, `must 269/269, should 1/1`. `HYG-ACCESSLOG` `2435/2424/2424` (`POST /login 518/518`, `POST /token 38/38`): **không tái hiện** lệch 1 dòng của #11 |
| 13 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | 18 file `*20261127T03*` (pentest + mutant json/log, drill json/log) + 2 file `off` + 2 file `on2`: **0 hit** (grep exit 1) |
| 14 | Dọn (03:42:21Z) | `docker ps -a`: chỉ `veyrigate-redis/mongo/mailpit-1` (không còn `vg-b73-vault`). Mongo giống #0 (không DB `vg-int-*`/`vg-pentest`/`vg-drill-*` mới nào sót). db7 0, `vg:int-lock` 0, không `~/.vg-drill.lock`, không `be/.pentest-mutant-*`. Cổng 3000/3300/4000/4100/4400/5173/5273/5274/8443/4987–4990/18200 trống. sha256 lockfile `13b3fda3…` không đổi. SMTP 220. `git status` so với #0 chỉ thêm 9 file evidence (dưới) |

## Test FAIL

Không có.

## Quan sát (không chặn)

- **#11a `HYG-ACCESSLOG` responses 2451 / logged 2450**: lần đầu tiên một response của harness không khớp dòng `request completed` (run 97–99 luôn bằng nhau: 2435/2435, 2442/2442, 2425/2425, 2422/2422). Phần `must` của check (mọi `POST /login` + `POST /token` có dòng access khớp req.id/method/path/status) vẫn pass, nên check pass. Lượt timing on thứ 2 (#12a) cho 2424/2424 và lượt off 721/721, nên không tái hiện được. Evidence không lưu danh sách `served` nên không xác định được request nào (thiếu header `x-request-id` hay dòng log chưa flush lúc HYG đọc). Nghi ngờ: tạm thời (đọc log BE trước khi flush dòng cuối, hoặc request timing bị huỷ). Nest 12.5 có đổi `onResponseClose` (review-techlead) nên không loại trừ hoàn toàn. Đề xuất orchestrator theo dõi ở run sau; nếu lặp lại thì cho harness ghi các `served` không khớp vào evidence. Không mở DEBT vì không có bằng chứng lỗi app và invariant có route cụ thể vẫn đạt.
- **#8a access log E2E 1245** (trước 1246): chênh 1 dòng trong E2E có tải thời gian thực, không phải gate; 0 dòng cookie.

## File evidence mới chưa track (để orchestrator commit nếu run đóng)

- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261127T033503Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261127T032912Z.json`, `…032934Z`, `…032956Z`, `…033018Z`, `…033101Z`, `…033122Z`, `…033201Z` (cùng thư mục).
- `docs/agile/sso-idp/runs/87-X6-drills/evidence/rotate-local-20261127T030506Z.json`: drill rotate local 23/23.
- Các file `.log` tương ứng bị `.gitignore`. Lượt `--timing off` và lượt chẩn đoán `on2` ở scratchpad tester.

## Coverage acceptance criteria (D100.7)

- [x] Lockfile sha256 trước = sau frozen; audit high exit 0 (#1)
- [x] typecheck ×4, lint, prettier --check be (#2)
- [x] Unit be 1361, fe-admin 1669, fe-sso-test 269 (#3)
- [x] Build be (`dist/main.js`, `styles.css` không đổi), fe-admin + `check:bundle` 0 hit, fe-sso-test; `gen:api` không đổi `schema.d.ts` (#4)
- [x] Int FULL 2526, gồm 2 case D100.3 (`b74-tester` "run 100" `/login` + `/token`), traversal, token/admin-keys/run86-key-prepublish/runbook-drill/federation/b73c (jose 6.2.17 + Nest 12.5), Mailpit 220 trước khi chạy (nodemailer 10.5) (#5)
- [x] `test:vault` 32/32, chỉ `vg-b73-vault`, xoá theo tên (#6)
- [x] Drill rotate local 23/23, namespace sạch, khoá `~/.vg-drill.lock` không sót (#7, #14)
- [x] E2E 53, X3 42 (14/14/14) trên Playwright 1.64.1, không cài browser mới (#1, #8, #9)
- [x] Pentest on/off must 269/269 (`HYG-ACCESSLOG`, header/CSRF/traversal trên middleware matching Nest 12.5); mutations 7/7 (#10–#12)
- [ ] Image smoke be 14 / fe-admin 18: để CI `be-image` / `fe-admin-image` theo D100.7 (không chạy local)
- [ ] CI 9/9 sau push: orchestrator

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Bằng chứng |
|---|---|---|
| Input (prototype pollution qua form, Nest 12.5) | `__proto__` ⇒ 400 `invalid_request` + `no-store`, không 5xx, ở `/token` và `/login` (đối chứng 401 không `__proto__`); traversal static; injection template (mutant m2d đỏ đúng) | #5, #10, #11 |
| Credential (jose 6.2.17): ký/kiểm token, kid, JWKS, prepublish | int FULL (token, admin-keys, run86-key-prepublish, federation, b73c), vault 32 (Vault Transit), drill rotate (AT cũ vẫn kiểm được, key mới chưa dùng ngay) | #5, #6, #7 |
| Authorization (cross-tenant) | pentest IDOR-ADMIN-XTENANT pass; mutant m3 đỏ 17/21 đúng | #10, #11 |
| Request chain / CSRF / cookie | pentest SESS-CSRF-* + `SESS-COOKIE-FLAGS` pass; mutant m2/m2b/m2c đỏ đúng; X3 cookie-matrix same-site/cross-site 3 browser | #9, #10, #11 |
| State: rotation, single-use, logout replay | drill 23/23; X3 "RP-initiated logout + replay" 3 browser; int | #5, #7, #9 |
| Dependency (SMTP/Mongo/Redis) | Mailpit 220 trước/sau mọi bước; int đường MongoService lỗi topology (fail-closed) pass | #5, #11, #14 |
| Exposure: response/log/evidence | `/login` `__proto__` không echo password/stack, không `idp_session`; `HYG-BELOG` 0 vi phạm; access log E2E 0 cookie; grep evidence 0 hit; vault token không in | #5, #8a, #11a, #13 |
| Supply chain | frozen pass policies (≥ 14 ngày), sha256 lockfile không đổi, audit 0, Playwright giữ 1.64.1 | #1 |
| Namespace / hạ tầng chung | `vg-b73-vault` xoá, db7 0, lock 0, cổng trống, không thư mục mutant, `be/dist` sha256 khớp, Mongo không DB mới | #6, #10, #14 |
