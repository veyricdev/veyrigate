# Test Report — 2026-11-18 (run 96 T1, gate cuối Lot A + Lot C)

## Kết quả: PASS sau retry 1 (xem mục "Rerun sau retry 1" ở cuối). Lượt đầu FAIL (int 2502/2510), giữ nguyên bên dưới.

## Lượt 1: FAIL (int 2502/2510, 8 test đỏ xác định; mọi bước khác xanh)

Phạm vi: working tree chưa commit (Lot A + Lot C) trên `HEAD` = `8641174`. Tester không sửa code, không commit.

Thứ tự chạy tuần tự (theo "Thứ tự gate tester" trong tasks.md):
frozen-lockfile + audit → typecheck/lint/unit ×4 gói → build → int FULL → rerun 4 suite đỏ → SMTP → E2E → X3 → `mutate.mjs all` → SMTP → harness (timing on) → harness `--timing off` → SMTP → grep evidence → dọn.

Tổng kết:
- frozen-lockfile: exit 0, "Lockfile passes supply-chain policies (verified 14m ago)". Kết quả lấy từ cache của backend-dev, không phải xác minh lại từ đầu.
- audit high: exit 0. Có 1 mục ignored (picomatch).
- typecheck: be, fe-admin, fe-sso-test, e2e đều exit 0.
- lint: be, fe-admin, fe-sso-test đều exit 0, 0 lỗi. Gói e2e không có script lint.
- unit: be 1296/1296 (66 suite, 0 "failed to exit gracefully"), fe-admin 1658/1658, fe-sso-test 269/269.
- build: `be` và `fe-admin` exit 0. `styles.css` có cùng sha256 trước và sau build (`e43b8838…2a6d`).
- **int FULL: 2502/2510, 4 suite đỏ (FAIL).** Chạy lại riêng 4 suite này vẫn đỏ đúng 8 test ⇒ lỗi xác định, không phải flake.
- E2E: 53/53, có 3 dòng "Terminated the WebServer".
- X3: 42/42, có 4 dòng "Terminated the WebServer".
- mutation: 7/7 đỏ đúng. `be/dist` sha256 trước = sau.
- harness timing on: must 268/268, should 1/1, exit 0.
- harness `--timing off`: must 268/268, exit 0.
- grep evidence: 0 secret.
- SMTP trả 220 ở mọi điểm kiểm. Không restart container.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | `codegraph sync`; Mongo `listDatabases`; Redis `EXISTS vg:int-lock`; `redis-cli -n 7 dbsize`; SMTP; cổng | 08:30:38Z. Mongo: `admin config local sso-idp-e2e`, 0 `vg-int-*`. Lock `0`, db7 `0`, SMTP `220 d34120f10a43 Mailpit ESMTP`. Cổng 3000/4000/4100/5173/5273/5274/8443/4989/4990 trống. Có sẵn `be/dist/tsconfig.tsbuildinfo` từ build của backend-dev (15:26 +07), đã xoá sau build #4 |
| 0b | So `pnpm-lock.yaml` giữa HEAD và working tree cho ioredis, jose, mongoose, mongodb | Không đổi: ioredis 6.0.0, jose 5.10.0/6.2.12, mongoose 9.11.4, mongodb 7.7.0. Chỉ chuỗi peer của `@nestjs/mongoose` đổi theo common/core 12.3.2 ⇒ được phép bỏ qua vault/sentinel/drill |
| 1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high` | exit 0: `✓ Lockfile passes supply-chain policies (verified 14m ago)`, `Lockfile is up to date`. audit exit 0: `1 ignored: 1 high` |
| 2 | `pnpm -C {be,fe-admin,fe-sso-test,e2e} typecheck`; `pnpm -C {be,fe-admin,fe-sso-test} lint` | 4/4 exit 0; 3/3 exit 0, 0 dòng error/warning |
| 3 | `pnpm -C be test`; `pnpm -C fe-admin test`; `pnpm -C fe-sso-test test` | be: 08:33:04Z, `Test Suites: 66 passed`, `Tests: 1296 passed, 1296 total`, `Time: 37.371 s`, 0 "failed to exit gracefully". fe-admin: `Test Files 69 passed`, `Tests 1658 passed`. fe-sso-test: `Test Files 31 passed`, `Tests 269 passed` |
| 4 | `pnpm -C be build`; `pnpm -C fe-admin build`; `rm be/dist/tsconfig.tsbuildinfo` | exit 0 / exit 0 (`✓ built in 1.25s`). `git status` không đổi so với lúc bắt đầu |
| 5 | `timeout 40m pnpm -C be test:int` (khoá `vg:int-lock` lấy tự động) | 08:34:54→08:54:09Z. `Test Suites: 4 failed, 93 passed, 97 total`, `Tests: 8 failed, 2502 passed, 2510 total`, `Time: 1152.928 s`, **exit 1**. Sau khi chạy: 0 `vg-int-*`, lock 0, SMTP 220 |
| 5b | `pnpm -C be test:int -- test/log-capture… test/b74-tester… test/run81-tester… test/run90-backend…` | 08:55:14Z, `Test Suites: 4 failed, 4 total`, `Tests: 8 failed, 116 passed, 124 total`. Đúng 8 test như #5 |
| 6 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` (preflight SMTP 220, cổng trống) | 08:57:04→09:09:50Z, `53 passed (12.7m)`, exit 0. `Terminated the WebServer` = **3**. Playwright 1.64.1 không tải browser |
| 6a | Đếm dòng log BE trong output E2E | Chỉ có **22** dòng `"msg":"request completed"` cho cả suite, và cả 22 đều có `"url":"/"`. Không route nào khác (`/login`, `/authorize`, `/token`, `/admin/*`…) có dòng access log |
| 7 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 09:10:28→09:19:58Z, `42 passed (9.5m)`, exit 0. `Terminated the WebServer` = **4** |
| 8 | sha256 cây `be/dist` (bỏ `.map`); SMTP; `timeout 40m node be/scripts/pentest/mutate.mjs all`; sha256 lại | Trước: `f241b6f0…040a`. SMTP 220. 09:20:11Z, exit 0. Dòng cuối: `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. Sau: `f241b6f0…040a` (khớp) |
| 9 | SMTP; `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức) | SMTP 220. 09:23:44→09:27:03Z, exit 0. Log: `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free`, `summary must 268/268, should 1/1; namespace clean true; trap hits 0`. Evidence `runs/90-X6-pentest-signoff/evidence/pentest-20261118T092703Z.json`: `ok true`, `profile.timing "on"`, 269 check, 0 không pass, `cleanupErrors []`, `mailpitStale 0`, `mailpitDeleted 500`, `smtpAfter "220"`, `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports free}` |
| 9a | Các check chính | `HYG-MAIL` pass (500). `HYG-SMTP-AFTER` pass ("220"). `SESS-COOKIE-FLAGS` pass (6 cookie `__Host-`, 0 vi phạm). `INJ-TEMPLATE-reflect` pass (Eta 4.6 vẫn escape). 39 `SESS-HDR-*` pass (helmet 13.2). `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` pass. `HYG-BELOG` pass nhưng `lines: 148`, trong khi run 95 (`pentest-20261118T062133Z.json`) có `lines: 2577` với cùng kịch bản ⇒ xem FAIL bên dưới |
| 10 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g96/off` | 09:27:25→09:30:32Z, exit 0. `timing checks skipped (--timing off, D93.4)`, `summary must 268/268, should 1/1`. Evidence: `ok true`, `timing "off"`, 4 SHAPE / 0 TIME, 0 không pass, `HYG-MAIL`/`HYG-SMTP-AFTER` pass, `smtpAfter "220"`, `cleanupErrors []`. off 268 = on 268 − 4 TIME + 4 SHAPE ✓ |
| 11 | SMTP sau harness | `220 d34120f10a43 Mailpit ESMTP` |
| 12 | Grep evidence: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16>`, URI `scheme://user:pass@` | Quét 18 file: 16 file `*20261118T09*` (json + log) trong `evidence/` và 2 file `off`. **0 hit** (grep exit 1) |
| 13 | Dọn (09:31:23Z) | Mongo `admin config local sso-idp-e2e`: 0 `vg-int-*`, không có `vg-pentest`. `redis-cli -n 7 dbsize` = 0, `vg:int-lock` = 0. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990 trống. Không còn `be/.pentest-mutant-*`, không còn `~/.vg-drill.lock`, không có `tsconfig.tsbuildinfo` nào ngoài node_modules. SMTP 220. `git status` chỉ thêm 8 file evidence (dưới) |

## Test FAIL

Cùng một nguyên nhân gây ra 8 test đỏ: **access log `request completed` của pino-http không còn được ghi cho mọi route khác `/`**.

| Test | Kỳ vọng | Thực tế |
|---|---|---|
| `log-capture.int-spec.ts:282` "capture is live: access lines carry req.id + statusCode…" | ≥ 10 dòng `request completed` | 0 |
| `b74-tester.int-spec.ts:400` "runs the federation + admin failure paths…" | có dòng access `/auth/google/callback` với `"statusCode":500` | không có |
| `run81-tester.int-spec.ts:384` "C7 exposure: the binding value…" | `pino.slice(from).length > 0` | 0 |
| `run90-backend.int-spec.ts:97` "C1 request id (DEBT-095)" ×5 (valid, 8 KB, CR LF, 65 ký tự, bad chars) | có `accessLine(id)` cho request đó | `undefined`. Audit `requestId` vẫn đúng; chỉ thiếu dòng access log |

Bằng chứng runtime, không chỉ ở `inject()`:
- E2E dùng server HTTP thật: chỉ có 22 dòng access log, tất cả đều `url "/"` (#6a).
- Harness (`be/dist/main.js` qua HTTP thật): log BE còn 148 dòng, so với 2577 dòng ở run 95 (#9a).
- Vì vậy production sẽ **mất access log** của mọi route (`/login`, `/token`, `/authorize`, `/admin/*`…), mất luôn tương quan `req.id` ↔ audit (DEBT-095, run 90) và mọi phân tích sự cố dựa trên access log.

Nghi ngờ nguyên nhân:
- Trong các gói logging, Lot A chỉ đổi `nestjs-pino` 5.2.1 → 5.3.1. `pino-http` 11.0.0 và `pino` 10.3.1 giữ nguyên.
- Ở 5.3.1, `DEFAULT_ROUTES` là `[{ path: '{/*splat}', method: ALL }]`, có thêm `defaultRoutes()` (cộng các path exclude của global prefix) và một hook `onSend` mới (`exposeFastifyResponseHeaders`), xem `node_modules/.pnpm/nestjs-pino@5.3.1_*/…/dist/cjs/LoggerModule.js:38,113-163`.
- `be/src/common/logger/logger.module.ts:95` dùng `forRootAsync` và không truyền `forRoutes`, nên đi theo route mặc định. Với `@nestjs/platform-fastify` 12.3.2, pattern này có vẻ chỉ khớp `/`.
- Không loại trừ khả năng phần khớp middleware của `@nestjs/core`/`platform-fastify` 12.3.2 góp phần. Cả hai đều bump trong Lot A.
- Hướng sửa thuộc backend-dev (tester không sửa code), có hai lựa chọn:
  - (a) giữ `nestjs-pino@5.2.1`, tức áp 35/38 gói #17, kèm `ignore` và DEBT;
  - (b) truyền `forRoutes` tường minh mà Nest 12.3 khớp mọi path, rồi kiểm rằng hook `onSend` mới không đưa header nhạy cảm (`set-cookie`) vào serializer `res`.
- Cả hai cách đều phải làm 4 suite trên xanh lại, và số dòng log trong E2E/harness trở về mức run 95.

⇒ **Trả lại backend-dev**: Lot A, gói `nestjs-pino`.

## File evidence của lượt 1

Đã **xoá** ở rerun vì là evidence của build lỗi. Gồm 16 file untracked, chưa từng được track:
- `pentest-20261118T092703Z.{json,log}`;
- 7 cặp `pentest-mutant-20261118T0920…0923*.{json,log}`.

Evidence còn giữ: xem mục Rerun.

## Coverage acceptance criteria (T1)
- [x] be/fe-admin/e2e (+ fe-sso-test) typecheck + lint + unit xanh (#2, #3)
- [ ] **int FULL xanh: FAIL 2502/2510** (#5, #5b)
- [x] E2E 53, X3 42 (#6, #7)
- [x] `pnpm audit --audit-level high` exit 0; supply-chain policy OK (#1, kết quả từ cache)
- [ ] image build (CI): chưa push, chưa chạy. Chặn bởi FAIL ở trên.

## Coverage security invariants / risk matrix

| Chiều / gói rủi ro (tasks.md) | Đã kiểm | Xem |
|---|---|---|
| nodemailer 10.3.1: fake-SMTP, trần 200, Mailpit thật | int mailer trong 2502 pass; `HYG-MAIL` 500 thư ở cả hai lượt; SMTP 220 sau mọi lượt | #5, #9a, #10, #11 |
| @fastify/helmet 13.2.0: header bảo mật | 39 `SESS-HDR-*` pass; X3 42 | #7, #9a |
| @fastify/cookie 11.1.5: `__Host-`, ma trận cookie | `SESS-COOKIE-FLAGS` pass; X3 42 | #7, #9a |
| @nestjs/* 12.3.2: 303/302, `no-store`, request id | harness must 268 (gồm các chuỗi 303); m4 `CONTRACT-REQID-untrusted` đỏ đúng; **access log req.id hỏng (FAIL)** | #8, #9, FAIL |
| eta 4.6: auto-escape | `INJ-TEMPLATE-reflect` pass; m2d đỏ đúng | #8, #9a |
| nestjs-pino 5.3: redaction + access log | redaction: `HYG-BELOG` 0 vi phạm, grep evidence 0 hit; **access log mất ⇒ FAIL** | #9a, #12, FAIL |
| CSRF (missing/wrong/other) | m2/m2b/m2c đỏ đúng, bản thật xanh | #8 |
| Authorization cross-tenant | m3 đỏ 17 `IDOR-ADMIN-XTENANT-*`, bản thật xanh | #8 |
| Exposure | evidence/log 0 JWT/argon2/otpauth/PEM/Bearer/URI có credential | #12 |
| Namespace/state | `vg-pentest`/`vg-int-*` vắng, db7 0, cổng trống, `be/dist` sha256 không đổi | #8, #13 |
| Vault/sentinel/drill | bỏ qua theo tasks.md; ioredis/jose/mongoose/mongodb không đổi phiên bản | #0b |

## Ghi chú (lượt 1)
- Lỗ hổng phát hiện: E2E, X3 và harness đều xanh dù access log đã mất. Lý do là `HYG-BELOG` chỉ yêu cầu `lines > 1`, còn E2E không kiểm log. Hiện chỉ int bắt được lỗi này ⇒ DEBT-700 (log.md).

---

# Rerun sau retry 1 — 2026-11-18/19 (PASS)

## Kết quả: PASS

Phạm vi: working tree chưa commit, gồm Lot A + Lot C + retry 1. Retry 1 gồm:
- `forRoutes: '/{*splat}'` trong `buildLoggerParams`;
- `full-app.ts` dùng tham số production;
- spec mới `logger.routes.spec.ts`;
- check harness `HYG-ACCESSLOG`.

HEAD = `8641174`. Tester không sửa code, không commit. Thứ tự chạy giống lượt 1.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output thực tế |
|---|---|---|
| R0 | Preflight (09:59:35Z) | 0 `vg-int-*`; lock 0; db7 0; SMTP 220; cổng trống; `codegraph sync` OK. Có sẵn `be/dist/tsconfig.tsbuildinfo` từ build của backend-dev, đã xoá sau R4 |
| R1 | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level high` | install exit 0: `✓ Lockfile passes supply-chain policies (verified 1h ago)`. Kết quả lấy từ cache; retry 1 không đổi lockfile. audit exit 0: `1 ignored: 1 high` |
| R2 | typecheck ×4, lint ×3 | Tất cả exit 0 |
| R3 | unit | be: `67 passed`, `Tests: 1302 passed, 1302 total` (34.9 s), 0 "failed to exit gracefully". fe-admin: 69 file / 1658 test. fe-sso-test: 31 file / 269 test. Tất cả exit 0 |
| R4 | `pnpm -C be build`; `pnpm -C fe-admin build` | exit 0 / exit 0. `styles.css` sha256 không đổi. `be/dist/common/logger/logger.module.js` có `forRoutes`. `git status` không đổi |
| R5 | `timeout 40m pnpm -C be test:int` | 10:03:49→10:21:17Z. `Test Suites: 97 passed, 97 total`, `Tests: 2510 passed, 2510 total` (1045.7 s), exit 0. Bốn suite đỏ ở lượt 1 nay xanh, gồm `log-capture` (assert ≥ 10 dòng `request completed` có `req.id` + `statusCode`). Không có spec int mới: spec của retry 1 là unit. Sau khi chạy: 0 `vg-int-*`, lock 0, SMTP 220 |
| R6a | E2E lần 1 (10:21:45Z) | **Bị ngắt từ bên ngoài** lúc 10:30:54Z (phiên/máy bị dừng), wrapper không ghi được dòng exit. Test 1–19 đã `ok`; toàn bộ test còn lại bị đánh `x` 0 ms cùng một thời điểm ⇒ không phải lỗi sản phẩm. Sau đó: cổng trống, SMTP 220 ⇒ chạy lại. Ngay trong phần đã chạy, log BE đã có dòng `request completed` cho `/authorize`, `/login`, `/login/mfa`, `/assets/styles.css`… |
| R6 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` (chạy lại) | 03:51:37→04:05:52Z (19/11). `53 passed (14.2m)`, exit 0, `Terminated the WebServer` = **3**. Log BE có **1246** dòng `request completed` trên **75** URL khác nhau (lượt 1: 22 dòng, toàn `/`). Nhiều nhất: `/assets/styles.css` 239, `/login` 148, `/authorize` 146, `/login/mfa` 82, `/token` 77, `/admin/audit` 52. Dòng access chứa `set-cookie`/`idp_session`: **0** |
| R7 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 04:06:18→04:16:06Z. `42 passed (9.8m)`, exit 0, `Terminated` = **4** |
| R8 | SMTP; sha256 `be/dist`; `timeout 40m node be/scripts/pentest/mutate.mjs all` | SMTP 220. sha256 trước: `738eb839…2c51`. 04:16:19→04:19:31Z, exit 0. Đỏ: m1 1/53, m2 58/63, m2b 2/154, m2c 3/154, m2d 1/23, m3 17/21, m4 1/23, tất cả `expected red YES`. `be/dist sha256 before = after: true; mutant dirs left: 0`. sha256 sau: `738eb839…2c51` (khớp). SMTP 220 |
| R9 | `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức) | 04:19:43→04:23:03Z, exit 0. `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free`. `summary must 269/269, should 1/1; namespace clean true; trap hits 0`. Evidence `pentest-20261119T042303Z.json`: `ok true`, `timing "on"`, 270 check, 0 không pass, `cleanupErrors []`, `mailpitStale 0`, `mailpitDeleted 500`, `smtpAfter "220"`, `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports free}` |
| R9a | Các check chính | `HYG-ACCESSLOG` pass: `accessLines 2446`, `responses 2435`, `logged 2435`, `POST /login 518/518`, `POST /token 38/38`. `HYG-BELOG` pass: `lines 2583` (run 95: 2577; lượt 1 hỏng: 148), 0 vi phạm. `HYG-MAIL` 500. `HYG-SMTP-AFTER` "220". `SESS-COOKIE-FLAGS` pass. `INJ-TEMPLATE-reflect` pass. `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` diff 1.2 / 0.4 / 1.7 / 1.3 ms (giới hạn 10) |
| R10 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g96r/off` | 04:23:20→04:26:33Z, exit 0. `timing checks skipped`; `summary must 269/269, should 1/1`. Evidence: `ok true`, `timing "off"`, 4 SHAPE / 0 TIME, 0 không pass, `HYG-MAIL`/`HYG-SMTP-AFTER`/`HYG-ACCESSLOG` pass, `smtpAfter "220"`, `cleanupErrors []`. off 269 = on 269 − 4 TIME + 4 SHAPE ✓. SMTP sau: 220 |
| R11 | Xoá evidence lượt 1; grep evidence | Xoá 16 file (8 json + 8 log): `pentest-20261118T092703Z.*` và 7 mutant `20261118T0920…0923*`. Không file nào từng được track (`git ls-files` = 0). Grep cùng mẫu với #12 lượt 1, trên 18 file (16 `*20261119T04*` + 2 `off`): **0 hit** (grep exit 1) |
| R12 | Dọn (04:27:24Z) | Mongo `admin config local sso-idp-e2e`: 0 `vg-int-*`, không có `vg-pentest`. db7 0, lock 0. Cổng 3000/4000/4100/5173/5273/5274/8443/4987–4990 trống. Không còn thư mục mutant, `~/.vg-drill.lock`, `tsbuildinfo`. SMTP `220 d34120f10a43 Mailpit ESMTP`. Không restart container |

## Test FAIL
Không có. E2E lần 1 bị ngắt từ bên ngoài (R6a); lượt chạy lại xanh.

## File evidence mới chưa track (để orchestrator commit)
- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/pentest-20261119T042303Z.json`: lượt chính thức, timing on, must 269/269.
- 7 file `pentest-mutant-20261119T041648Z.json`, `…041711Z`, `…041734Z`, `…041756Z`, `…041831Z`, `…041853Z`, `…041931Z`.
- Các file `.log` tương ứng bị `.gitignore`. Lượt `off` nằm ở scratchpad.

## Coverage acceptance criteria (T1, sau retry 1)
- [x] typecheck + lint + unit: be 1302, fe-admin 1658, fe-sso-test 269 (R2, R3)
- [x] int FULL 2510/2510 (R5)
- [x] E2E 53, X3 42 (R6, R7)
- [x] audit exit 0; supply-chain policy OK (R1, kết quả cache)
- [ ] image build (CI): chưa push. CI là gate (D96.12)

## Coverage security invariants / risk matrix (bổ sung so với lượt 1)

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Access log + tương quan `req.id` (DEBT-095), runtime thật | int `log-capture`/`run90-backend` C1 xanh; E2E 1246 dòng / 75 URL; `HYG-ACCESSLOG` login 518/518, token 38/38 | R5, R6, R9a |
| Exposure qua hook `onSend` mới của nestjs-pino | 0 dòng access chứa `set-cookie`/`idp_session` (E2E); `HYG-BELOG` 0 vi phạm; grep evidence 0 hit | R6, R9a, R11 |
| Check mới bắt được hồi quy (DEBT-700) | `HYG-ACCESSLOG` là `must`, pass trên bản sửa. Trên dist lỗi nó đỏ: bằng chứng của backend-dev, senior đã xác nhận bằng mutation tay | R9a, log.md retry 1 |
| CSRF, cross-tenant, Eta escape, request id không tin cậy | mutation 7/7 đỏ đúng | R8 |
| Header/cookie (helmet 13.2, cookie 11.1.5) | X3 42; `SESS-COOKIE-FLAGS` và `SESS-HDR-*` nằm trong must 269 | R7, R9 |
| Mail (nodemailer 10.3.1) | `HYG-MAIL` 500 ở cả hai lượt; SMTP 220 ở mọi điểm kiểm | R9a, R10 |
