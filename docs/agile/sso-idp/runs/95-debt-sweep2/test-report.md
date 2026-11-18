# Test Report — 2026-11-18 (run 95, gate D theo D95.20)

## Kết quả: PASS

Phạm vi: working tree chưa commit (lô A + retry 1, lô B, lô C), `head` = `d23666a`. Tester không sửa code, không commit.

Thứ tự chạy tuần tự, không song song (D95.20):
typecheck + lint → unit ×2 → int FULL → SMTP → E2E ×1 → X3 → build → SMTP → `mutate.mjs all` → SMTP → harness đầy đủ (timing on) → SMTP → harness `--timing off` → SMTP → grep evidence → drill `rotate --provider local` (codeFlow) → dọn.

Tổng kết:
- be typecheck, lint: exit 0
- be unit: 1296/1296, chạy 2 lần, **0** cảnh báo "worker process has failed to exit gracefully"
- int FULL: 97 suite, 2510/2510
- E2E: 53/53, 3 dòng `Terminated the WebServer`
- X3: 42/42, 4 dòng
- mutation m1–m4 + m2b–d: 7/7 đỏ đúng, `be/dist` sha256 không đổi
- harness đầy đủ (timing on): must 268/268, should 1/1, exit 0
- harness `--timing off`: must 268/268, exit 0
- drill `rotate-drill --provider local` (gọi `codeFlow` đã sửa): 23/23 check, `ok true`, exit 0

**SMTP**: trả 220 ở mọi điểm kiểm: preflight, trước E2E, trước và sau mutation, trước và sau harness đầy đủ (`HYG-SMTP-AFTER` = "220"), sau `off`, lúc dọn (06:26:01Z). Không restart container.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Mongo `listDatabases` ; Redis `EXISTS vg:int-lock` ; `redis-cli -n 7 dbsize` ; SMTP ; cổng | 05:29:00Z · `admin config local sso-idp-e2e` (0 `vg-int-*`) ; `0` ; `0` ; `220 d34120f10a43 Mailpit ESMTP` ; cổng 3000/4000/4100/5173/5273/5274/8443/4989/4990 trống. Có sẵn `be/dist/tsconfig.tsbuildinfo` (12:23 +07, từ build của lô C) ⇒ xoá sau build ở #6 |
| 1 | `pnpm -C be typecheck` ; `pnpm -C be lint` | `tsc --noEmit` exit 0 ; `eslint src test` exit 0 |
| 2 | `timeout 15m pnpm -C be test` (lần 1) | 05:29:47Z · `Test Suites: 66 passed, 66 total` · `Tests: 1296 passed, 1296 total` · `Time: 37.137 s` · exit 0 · không có dòng "failed to exit gracefully" |
| 2b | như trên (lần 2) | 05:30:26Z · `66 passed` · `1296 passed` · `Time: 35.763 s` · exit 0 · không có dòng "failed to exit gracefully" |
| 3 | `timeout 40m pnpm -C be test:int` (khoá `vg:int-lock` do `int-preflight.mjs` tự lấy) | 05:31:18→05:50:52Z · `Test Suites: 97 passed, 97 total` · `Tests: 2510 passed, 2510 total` · `Time: 1171.207 s` · exit 0. Sau: `admin config local sso-idp-e2e` (0 `vg-int-*`), lock `0` |
| 4 | SMTP ; cổng | `220 … Mailpit ESMTP` ; mọi cổng trống |
| 5 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 05:51:09→06:03:52Z · `53 passed (12.7m)` · exit 0 · `grep -c "Terminated the WebServer"` = **3** |
| 5b | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 06:03:59→06:13:54Z · `42 passed (9.9m)` · exit 0 · `Terminated the WebServer` = **4** |
| 6 | `pnpm -C be build` ; `rm be/dist/tsconfig.tsbuildinfo` ; sha256 cây `be/dist` (bỏ `.map`) ; SMTP ; lock ; playwright | exit 0 ; `4722450…7083e` ; `220` ; `0` ; 0 process playwright |
| 7 | `timeout 40m node be/scripts/pentest/mutate.mjs all` | 06:14:33→06:18:02Z · exit 0. Bảng dưới. Dòng cuối: `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`. sha256 tự tính sau = `4722450…7083e` (khớp #6) |
| 8 | SMTP sau mutation | `220 d34120f10a43 Mailpit ESMTP` |
| 9 | `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức, evidence mặc định) | 06:18:14→06:21:33Z · exit 0. Log: `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free` · `summary must 268/268, should 1/1; namespace clean true; trap hits 0`. Evidence `runs/90-X6-pentest-signoff/evidence/pentest-20261118T062133Z.json`: `ok true` · `profile.timing "on"`, `SESSION_COOKIE_SECURE "true"`, `ADMIN_MFA_REQUIRED "true"` · `cleanupErrors []` · `mailpitStale 0` · `mailpitDeleted 500` · `smtpAfter "220"` · `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports free}` · `e2eUnchanged true` · `devUnchanged true` · 269 check, 0 không pass |
| 9a | Check chính trong evidence | `AUTHN-RESET-TICKET` pass `{exchange 303, location "/reset", ticketA true, replay 400, unknown 400, replaySameAsUnknown true, ticketB false, passwordFormA true, oldShape 400, oldPasswordLogin 303, freshTokenExchange 303}` (`oldPasswordLogin` 302 ở run 94 ⇒ 303 sau POST `/login`, đúng D95.15) · `HYG-MAIL` pass (500) · `HYG-SMTP-AFTER` pass ("220") · `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` pass (diff 0.8/1.0/2.8/0.7 ms, limit 10) · `SESS-COOKIE-FLAGS` pass · 7 check có `expected` nêu 303 |
| 10 | SMTP sau harness đầy đủ | `220 d34120f10a43 Mailpit ESMTP` (06:22:03Z) |
| 11 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g95/off` | 06:22:03→06:25:03Z · exit 0. Log: `timing checks skipped (--timing off, D93.4)` · `summary must 268/268, should 1/1; namespace clean true; trap hits 0`. Evidence: `ok true`, `profile.timing "off"`, `AUTHN-ENUM-SHAPE-*` = 4, `AUTHN-ENUM-TIME-*` = 0, `AUTHN-RESET-TICKET`/`HYG-MAIL`/`HYG-SMTP-AFTER` pass, `smtpAfter "220"`, e2e/dev unchanged true, `cleanupErrors []` |
| 12 | So số `must` | off 268 = đầy đủ 268 − 4 TIME + 4 SHAPE ✓ |
| 13 | SMTP sau harness `off` | `220 d34120f10a43 Mailpit ESMTP` (06:25:04Z) |
| 14 | Grep evidence | Mẫu: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16 ký tự>`, URI `scheme://user:pass@`. Phạm vi: 16 file `*20261118T06*` trong `runs/90-X6-pentest-signoff/evidence/` (8 json + 8 log, log bị `.gitignore`) + 2 file `off` + 2 file drill (#15). Kết quả **0 hit** (grep exit 1) |
| 15 | Drill: `node be/scripts/drills/rotate-drill.mjs --provider local --dry-run` rồi không `--dry-run` | dry-run: `namespace ok: vg-drill-rotate-local absent; redis db 7 empty; ports 4987 free`, exit 0. Thật: 06:25:31→06:25:44Z · exit 0 · evidence `runs/87-X6-drills/evidence/rotate-local-20261118T062544Z.json`: `ok true`, 23/23 check pass, `cleanupErrors []`, `postCheck {drillDbsLeft:[], redisDbSizes{7:0}, e2eUnchanged true}`. `codeFlow` chạy 2 lần (`login()` trước và sau rotate), mỗi lần qua `POST /login` ⇒ **303** `/authorize` rồi `GET /authorize` ⇒ **302** có `code` (check `AT_old: /userinfo 200`, `refresh after emergency => 200` phụ thuộc vào nó) |
| 16 | Dọn (06:26:01Z) | Mongo `admin config local sso-idp-e2e`: 0 `vg-int-*`, `vg-pentest`/`vg-drill-*` vắng · `redis-cli -n 7 dbsize` = 0 · `vg:int-lock` = 0 · cổng 3000/4000/4100/5173/5273/5274/8443/4987/4988/4989/4990 trống · không còn `be/.pentest-mutant-*` · không còn `~/.vg-drill.lock` · không có `tsconfig.tsbuildinfo` nào ngoài node_modules · SMTP 220 · `git status` so với lúc bắt đầu: chỉ thêm 9 file evidence (dưới) |

Kết quả mutation (#7), mỗi dòng `exit 1; expected red YES`:

| Mutation | Đỏ | Check đỏ |
|---|---|---|
| m1 | 1/53 | `OAUTH-PKCE-plain` |
| m2 | 58/63 | mọi `SESS-CSRF-*` sau CsrfGuard (gồm `reset-code`, `reset`, `auth-link`, `authorize-consent`, `account-*`, `logout`) + `SESSION-HARNESS` (giống run 94) |
| m2b | 2/154 | `SESS-CSRF-logout-wrong`, `SESS-CSRF-logout-other` |
| m2c | 3/154 | `SESS-CSRF-login-mfa-missing`, `-wrong`, `-other` |
| m2d | 1/23 | `INJ-TEMPLATE-reflect` |
| m3 | 17/21 | `IDOR-ADMIN-XTENANT-*` |
| m4 | 1/23 | `CONTRACT-REQID-untrusted` |

## File evidence mới chưa track (để orchestrator commit)

- `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/`:
  - `pentest-20261118T062133Z.json` (lượt chính thức, timing on)
  - 7 file `pentest-mutant-20261118T061501Z.json`, `…061524Z`, `…061548Z`, `…061611Z`, `…061701Z`, `…061724Z`, `…061801Z`
  - các `.log` tương ứng bị `.gitignore`
- `docs/agile/sso-idp/runs/87-X6-drills/evidence/rotate-local-20261118T062544Z.json` (+ `.log` bị ignore)
- Lượt `off` ở scratchpad, không vào repo.

## Test FAIL
Không có.

## Ghi chú
- Cảnh báo "worker process has failed to exit gracefully" (lô B thấy 1/3 lần): 0/2 lần ở gate này. Không tái hiện ⇒ không mở debt.
- `codeFlow` (lệch D95.16): nhánh chính `POST /login` 303 ⇒ `GET /authorize` 302 đã chạy thật qua `rotate-drill --provider local` (#15). Hai nhánh phụ chưa chạy thật: MFA (`totp`, 303 `/login/mfa`) và consent (`codeStatus = 303`). Lý do: không drill nào truyền `totp`, và client `fe-admin` của drill là first-party nên không qua consent. Hai nhánh này không có caller nên không chặn gate. Senior đã đối chiếu chúng với D95.15. `backup-restore-drill` không chạy vì cần thêm DB `vg-drill-src`/`vg-drill-restore` + gpg/docker exec, tốn hơn; rotate local là drill rẻ nhất và không tạo container.
- `b73c-tester.vault-spec.ts` không chạy local (cần container Vault, D95.16): CI job vault là gate.
- promtool (`alerts.test.yml`, `SsoMailDropped`): không có local, CI là gate. `ops-rules.spec` nằm trong unit 1296.

## Coverage acceptance criteria
- [x] Thứ tự và ràng buộc D95.19/D95.20:
  - int không chạy song song với E2E;
  - harness chạy sau E2E/X3;
  - SMTP được kiểm trước mọi bước cần thư;
  - không restart container (#0, #4, #6, #8, #10, #13, #16).
- [x] T1 DEBT-634 (D95.1–D95.8): int `run95-admin-recover-sessions` (8) và `run87-admin-recover` nằm trong 2510 (#3). Unit `admin-recover.spec` nằm trong 1296 (#2).
- [x] T2 DEBT-683 + DEBT-689 (D95.9–D95.14):
  - unit `mailer.spec`, metrics, `ops-rules.spec` trong 1296 (#2); int `mailer` trong 2510 (#3);
  - `HYG-MAIL` 500 thư và `HYG-SMTP-AFTER` "220" pass ở cả hai lượt harness (#9a, #11);
  - Mailpit vẫn 220 sau mọi lượt.
- [x] T3 DEBT-570 (D95.15–D95.18):
  - int `run95-post-303` (27) và 25 spec đã sửa status nằm trong 2510 (#3);
  - E2E `mfa.spec`/`fe-admin` trong 53 (#5); X3 42 không đổi (#5b);
  - harness kiểm đúng 303 ở `signedIn`/`uiLogin`/`enroll`/`oldPasswordLogin`, must 268/268 (#9);
  - drill `codeFlow` đã chạy thật (#15).
- [x] Tương thích GET 302: `GET /authorize` ⇒ 302 trong drill (#15); 3 đối chứng GET trong `run95-post-303` (#3).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Request chain (POST ⇒ 303 ⇒ GET, cookie jar) | harness login/MFA/reset theo chuỗi 303; drill `codeFlow` jar qua `/login` 303 ⇒ `/authorize` 302 ⇒ `/token` | #9, #9a, #15 |
| Credential/CSRF (missing/wrong/other) trên mọi route POST đổi sang 303 | m2/m2b/m2c đỏ đúng; bản thật xanh | #7, #9 |
| Authorization (cross-tenant) | m3 đỏ 17 `IDOR-ADMIN-XTENANT-*`, bản thật xanh | #7, #9 |
| State (phiên sau `--reset-mfa`, replay vé reset) | int run95-admin-recover-sessions; `AUTHN-RESET-TICKET` replay 400 giống token lạ | #3, #9a |
| Dependency (Redis lỗi ⇒ exit 3; SMTP) | int case Redis :1 trong 2510; SMTP 220 preflight/sau mỗi lượt, 500 thư/lượt | #3, #8–#13 |
| Enumeration | TIME (on) diff ≤ 2.8 ms; SHAPE (off) pass | #9a, #11 |
| Exposure | evidence/log harness + drill: 0 JWT/argon2/otpauth/PEM private/Bearer/URI có credential | #14 |
| Namespace/state | `vg-pentest`/`vg-drill-*`/`vg-int-*` vắng, db7 0, cổng trống, `be/dist` sha256 không đổi, e2e/dev unchanged | #7, #9, #15, #16 |
