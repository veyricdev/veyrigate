# Test Report — 2026-11-19 (run 97 lô D, gate cuối cho lô A + B + C)

## Kết quả: PASS (mọi bước của D97.25 xanh, số khớp kỳ vọng)

Phạm vi: working tree chưa commit (lô A fe-admin Redis `rediss://` + ACL; lô B audit counter / admin denied / `AuditAlertWatch` + sửa DEBT-707/708; lô C trần toàn cục client auth + retry 1) trên `HEAD` = `59b6221`. Tester không sửa code sản phẩm, không commit, không restart container.

Tổng kết:
- frozen-lockfile exit 0, lockfile sha256 không đổi (`98552c27…862c0`); `pnpm audit --audit-level high` exit 0, "No known vulnerabilities found".
- typecheck be / fe-admin / fe-sso-test / e2e: 4/4 exit 0. lint be / fe-admin / fe-sso-test: 3/3 exit 0, 0 dòng error/warning.
- unit: be **1351/1351** (69 suite), fe-admin **1669/1669** (69 file), fe-sso-test **269/269** (31 file).
- build be + fe-admin exit 0; `git status` không đổi.
- int FULL: **99 suite / 2524 pass**, 0 đỏ (lần đầu, không phải chạy lại).
- E2E: **53 passed**, `Terminated the WebServer` = 3; **1246** dòng `request completed` trên **75** URL.
- X3: **42 passed**, `Terminated` = 4.
- `mutate.mjs all`: **7/7 đỏ đúng**, `be/dist` sha256 trước = sau.
- 5 mutation tay (D97.5, D97.11, DEBT-707, D97.17, retry 1 lô C): **5/5 đỏ đúng**, nguồn khôi phục, sha256 khớp.
- harness timing on: **must 269/269, should 1/1**, `HYG-ACCESSLOG` pass. `--timing off`: must 269/269.
- SMTP 220 ở mọi điểm kiểm (trước E2E, trước/sau mutation, trước/sau harness ×2, cuối).
- Grep evidence: 0 secret.

Chưa kiểm local (chạy ở CI): promtool (`alerts.test.yml` với 6 alert mới), `fe-admin-image` smoke (18 check, gồm 12b `redis://` ⇒ exit 1), vault.

## Lệnh đã chạy + output thực tế

Log đầy đủ ở scratchpad tester (`…/scratchpad/g97/*.txt`), không commit.

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Preflight (06:25:54Z): `codegraph sync`; Mongo `listDatabases`; `EXISTS vg:int-lock`; `redis-cli -n 7 dbsize`; SMTP; cổng | `codegraph` Done. Mongo: `admin config local sso-idp-e2e vg-int-run57t-1795067857303` ⇒ **1 DB `vg-int-*` có sẵn**, tạo lúc 05:57:37Z (trước khi tester bắt đầu, từ một lượt int bị ngắt của agent trước; 12 collection, có dữ liệu). Không phải của tester ⇒ không drop, xem "Ghi chú". Lock 0, db7 0, SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990 trống. Có sẵn `be/dist/tsconfig.tsbuildinfo` (đã xoá sau build #4) |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high` | install exit 0: `✓ Lockfile passes supply-chain policies (verified 22h ago)`, `Lockfile is up to date`. sha256 `pnpm-lock.yaml` trước = sau = `98552c27…862c0`. audit exit 0: `No known vulnerabilities found` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm -C {be,fe-admin,fe-sso-test} lint` | 4/4 exit 0; 3/3 exit 0, 0 dòng error/warning |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` (06:27:59Z) | be: `Test Suites: 69 passed, 69 total`, `Tests: 1351 passed, 1351 total`, `Time: 33.663 s`, 0 "failed to exit gracefully". fe-admin: `Test Files 69 passed (69)`, `Tests 1669 passed (1669)`. fe-sso-test: `Test Files 31 passed (31)`, `Tests 269 passed (269)` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `rm be/dist/tsconfig.tsbuildinfo` | exit 0 / exit 0 (`✓ built in 1.49s`). `git status --short` trước = sau |
| 5 | `timeout 40m pnpm -C be test:int` | 06:30:01→06:50:32Z, exit 0. `Test Suites: 99 passed, 99 total`, `Tests: 2524 passed, 2524 total`, `Time: 1229.147 s`. Sau khi chạy: không thêm DB `vg-int-*` nào (chỉ còn DB có sẵn ở #0), lock 0, SMTP 220 |
| 6 | SMTP; `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | SMTP 220. 06:50:55→07:04:21Z, `53 passed (13.3m)`, exit 0, `Terminated the WebServer` = **3** |
| 6a | Đếm access log BE trong output E2E | **1246** dòng `"msg":"request completed"` trên **75** URL khác nhau (giống run 96 R6). Nhiều nhất `/assets/styles.css` 239, `/login` 148, `/authorize` 146, `/login/mfa` 82, `/token` 77, `/admin/audit` 52. Dòng access chứa `set-cookie`/`idp_session`: **0** |
| 7 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 07:04:33→07:14:30Z, `42 passed (9.9m)`, exit 0, `Terminated` = **4** |
| 8 | sha256 cây `be/dist` (bỏ `.map`); SMTP; `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại; SMTP | Trước `3f7f941d…4890`, SMTP 220. 07:14:43→07:18:01Z, exit 0. m1 1/53 `OAUTH-PKCE-plain`; m2 58/63 (mọi `SESS-CSRF-*` sau CsrfGuard); m2b 2/154; m2c 3/154; m2d 1/23 `INJ-TEMPLATE-reflect`; m3 17/21 `IDOR-ADMIN-XTENANT-*`; m4 1/23 `CONTRACT-REQID-untrusted`; tất cả `expected red YES`. Dòng cuối `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. Sau `3f7f941d…4890` (khớp). SMTP 220 |
| 9 | 5 mutation tay (07:18:19→07:20:15Z): sao lưu 3 file nguồn vào scratchpad (`orig/` + `sha.txt`), mutant dựng sẵn trong scratchpad (`mut/`), `cp` mutant ⇒ chạy test ⇒ `cp` bản gốc về (có `trap EXIT`) | Xem bảng "Mutation tay" dưới. Sau cùng `sha256sum -c`: `audit.service.ts: OK`, `tenant-context.ts: OK`, `rate-limit.service.ts: OK` |
| 10 | SMTP; `redis-cli -n 7 dbsize`; `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức) | SMTP 220, db7 0. 07:20:30→07:23:33Z, exit 0. `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261119T072333Z.json`: `ok true`, `profile.timing "on"`, 270 check (269 must + 1 should), 0 `pass:false`, `cleanupErrors []`, `mailpitStale 0`, `mailpitDeleted 500`, `smtpAfter "220"`, `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports 4989/4990 free}` |
| 10a | Các check chính (evidence #10) | `HYG-ACCESSLOG` pass: `accessLines 2453`, `responses 2442`, `logged 2442`, `POST /login 518/518`, `POST /token 38/38`. `HYG-BELOG` pass: `lines 2590`, `scannedValues 106`, `violations []`. `HYG-MAIL` 500. `HYG-SMTP-AFTER` "220". `SESS-COOKIE-FLAGS` pass. `INJ-TEMPLATE-reflect` pass. `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` median diff −0.1 / −0.2 / 0.9 / 1.0 ms (giới hạn 10 ms) |
| 11 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g97/off` | SMTP trước 220. 07:23:56→07:27:03Z, exit 0. `timing checks skipped (--timing off, D93.4)`; `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence: `ok true`, `timing "off"`, 270 check, 0 `pass:false`, 4 `ENUM-SHAPE` / 0 `ENUM-TIME`, `HYG-ACCESSLOG`/`HYG-MAIL`/`HYG-SMTP-AFTER` pass, `smtpAfter "220"`, `cleanupErrors []` |
| 12 | SMTP sau harness | `220 d34120f10a43 Mailpit ESMTP` |
| 13 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | 18 file: 16 file `*20261119T07*` (json + log) trong `evidence/` + 2 file `off`. **0 hit** (grep exit 1) |
| 14 | Dọn (07:27:19Z) | Mongo `admin config local sso-idp-e2e vg-int-run57t-1795067857303` (DB có sẵn từ #0, tester không tạo thêm), không có `vg-pentest`. Lock 0, db7 0. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990 trống. Không còn `be/.pentest-mutant-*`, `~/.vg-drill.lock`, `tsconfig.tsbuildinfo` ngoài node_modules. SMTP 220. `pnpm-lock.yaml` sha256 không đổi. `git status` chỉ thêm 8 file evidence (dưới) |

### Mutation tay (bước 5 của D97.25)

| Mutation | Thay đổi (bản sao trong scratchpad) | Test | Kết quả |
|---|---|---|---|
| D97.5 (T3) | `audit.service.ts`: khối `try { observeAuditEvent(event) } catch` chuyển xuống sau try/catch `auditModel.create` | unit `audit.service.spec` | exit 1, **1 đỏ** / 10: "write fails: record rejects, the event and the write failure are both counted…" |
| D97.11 (T2) | `tenant-context.ts`: `if (first !== 'OK') return;` ⇒ `void first;` | unit `admin-guards.spec`; int `run97-admin-denied` | unit exit 1, **1 đỏ** / 24 ("not live (logged out) … a second refusal of the same sub is deduped"). int exit 1, **3 đỏ** / 5: (b), (c), (d) — khớp log dev |
| DEBT-707 | `tenant-context.ts`: `if (tenantId === undefined && reason === 'not_live')` ⇒ `if (false && …)` | int `run97-admin-denied` | exit 1, **1 đỏ** / 5: (b) "exactly 1 not_live document with the tenant (DEBT-707, visible on GET /admin/audit)" |
| D97.17 (T1) | `rate-limit.service.ts` `RESERVE_GLOBAL_SCRIPT`: `if redis.call('EXISTS', KEYS[2]) == 1 then` ⇒ `if false and redis.call(…)` | int `client-auth-rate-limit` | exit 1, **2 đỏ** / 23: (b) Expected 400 / Received 429, và (b') Expected 400 / Received 429. Dev ghi 1/22 trước retry 1; (b') thêm ở retry 1 dùng nguồn miễn trừ thành công làm tiền đề nên cũng đỏ ⇒ đúng kỳ vọng |
| Retry 1 lô C | `CLIENT_OK_SCRIPT`: `if ARGV[2] == '1' then` ⇒ `if true then` | int `client-auth-rate-limit` | exit 1, **1 đỏ** / 23: (b') Expected 429 / Received 401 — khớp log dev/senior |

Bản thật của cả 5 test này xanh trong int FULL (#5) và unit (#3).

## Test FAIL
Không có.

## File evidence mới chưa track (để orchestrator commit)
- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261119T072333Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261119T071510Z.json`, `…071532Z`, `…071555Z`, `…071617Z`, `…071701Z`, `…071722Z`, `…071801Z`.
- Các file `.log` tương ứng bị `.gitignore`. Lượt `off` ở scratchpad tester.

## Ghi chú
- DB `vg-int-run57t-1795067857303` (tạo 05:57:37Z, trước lô D) còn trong `veyrigate-mongo`. Tên do `test/run57-tester.int-spec.ts` sinh ⇒ dư từ một lượt int bị ngắt của agent trước (int FULL của tester không để lại DB nào). Theo ràng buộc, tester không drop DB không phải của mình ⇒ orchestrator/người dùng xoá bằng `db.getSiblingDB('vg-int-run57t-1795067857303').dropDatabase()` nếu đồng ý. Không phải lỗi sản phẩm, không mở DEBT.
- `pnpm audit` lần này "No known vulnerabilities found" (run 96: `1 ignored: 1 high`): advisory picomatch đã ignore không còn được báo; exit 0 cả hai.

## Coverage acceptance criteria

- [x] Bước 1: typecheck/lint/unit be 1351, fe-admin 1669 (+ typecheck/lint), fe-sso-test 269; audit high exit 0; frozen-lockfile không đổi lockfile (#1–#3)
- [x] Bước 2: be build; int FULL 99 / 2524 (#4, #5)
- [x] Bước 3: SMTP 220 ⇒ E2E 53, access log 1246 dòng / 75 URL (#6, #6a)
- [x] Bước 4: X3 42 (#7)
- [x] Bước 5: `mutate.mjs all` 7/7 đỏ đúng, `be/dist` sha256 trước = sau; 5 mutation tay đỏ đúng, sha256 nguồn khớp (#8, #9)
- [x] Bước 6: SMTP 220 ⇒ harness timing on must 269/269, `HYG-ACCESSLOG` pass, không có check mới; `--timing off` must 269/269 (#10, #10a, #11)
- [x] Bước 7: SMTP 220 sau harness, `HYG-SMTP-AFTER` pass ở cả hai lượt (#10a, #11, #12)
- [ ] promtool (6 alert mới + case), `fe-admin-image` smoke 18 check, vault: **chưa kiểm local**, để CI (D97.25)
- [x] T4 (DEBT-280) env `rediss://` + ACL: `env-matrix` +12 case trong fe-admin 1669 (#3); smoke Docker để CI
- [x] T3 (DEBT-218) đếm trước ghi: unit + mutation D97.5 (#3, #9)
- [x] T2 (DEBT-126) admin denied metric + audit có dedupe: int `run97-admin-denied` 5/5, unit `admin-guards` 24 + mutation D97.11 / DEBT-707 (#5, #9)
- [x] T5 (DEBT-618) `AuditAlertWatch`: int `run97-audit-alert-watch` trong 2524 (#5); PromQL alert để CI promtool
- [x] T1 (DEBT-072) trần toàn cục + miễn trừ + retry 1: int `client-auth-rate-limit` 23 trong 2524 + mutation D97.17 / retry 1 (#5, #9)

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Identity / Credential (T2): garbage bearer, token đã logout, sai audience, thiếu scope, step-up cũ | int `run97-admin-denied` (a)–(e) xanh; bỏ dedupe ⇒ (b)(c)(d) đỏ | #5, #9 |
| Authorization / tenant (DEBT-707): document `not_live` có `tenantId`, admin khác cùng tenant thấy qua `GET /admin/audit` | int (b) xanh; tắt tra client ⇒ (b) đỏ; `IDOR-ADMIN-XTENANT-*` 17 bắt bởi m3 | #5, #8, #9 |
| State: replay/dedupe từ chối admin, trần `admin-deny-audit` | unit `admin-guards` (refusal thứ 2 bị dedupe), mutation D97.11 | #3, #9 |
| State / concurrency (T1): trần toàn cục, nguồn miễn trừ không hoàn bucket, race N=50 | int `client-auth-rate-limit` (a)–(f), (b'), (k), (l) xanh; mutation D97.17 + retry 1 đỏ | #5, #9 |
| Dependency (T3): Mongo ghi audit lỗi ⇒ vẫn đếm + fail-closed | unit `audit.service.spec` case reject; mutation D97.5 đỏ | #3, #9 |
| Dependency (T1): Redis lỗi ở reserve ⇒ 500, không Argon2 | int `client-auth-rate-limit` (n) trong 2524 | #5 |
| Input / config (T4): `redis://`, user rỗng/`default`/`%64efault` ở production ⇒ boot fail, không echo URL | fe-admin `env-matrix` trong 1669; smoke 12b để CI | #3 |
| Exposure: log/evidence/access log | `HYG-BELOG` 0 vi phạm; access log E2E 0 cookie; grep evidence 0 hit; key Redis không chứa client_id thô (int (d)) | #5, #6a, #10a, #13 |
| Request chain / access log | E2E 1246 dòng / 75 URL; `HYG-ACCESSLOG` login 518/518, token 38/38 | #6a, #10a |
| CSRF, cross-tenant, Eta escape, request id không tin cậy | `mutate.mjs` 7/7 đỏ đúng | #8 |
| Timing enumeration | `AUTHN-ENUM-TIME-*` diff ≤ 1.0 ms | #10a |
| Namespace / hạ tầng chung | db7 0, lock 0, cổng trống, không thư mục mutant, `be/dist` + 3 file nguồn sha256 khớp, SMTP 220 mọi điểm | #8, #9, #14 |
