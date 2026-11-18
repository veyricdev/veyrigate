# Test Report — 2026-11-18 (run 94, gate D theo D94.13)

## Kết quả: PASS

Phạm vi: working tree chưa commit (lô A + retry 1/2, lô B + retry 1, lô C, sửa nhỏ orchestrator), `head` = `242c01f`. Tester không sửa code, không commit.

Thứ tự chạy tuần tự, không song song:
unit → e2e typecheck → fe-admin → build → int FULL → SMTP → E2E ×1 → X3 → build → SMTP → `mutate.mjs all` → SMTP → harness đầy đủ (timing on) → SMTP → harness `--timing off` → SMTP → grep evidence → dọn.

Theo D94.13, mutation chạy **trước** harness đầy đủ. Yêu cầu gate thì liệt kê mutation sau harness. Hai thứ tự đều giữ ràng buộc "harness sau E2E". Sau mỗi lượt harness/mutation đều kiểm 220.

Tổng kết:
- be unit: 1289/1289
- fe-admin: 1658/1658
- int FULL: 2475/2475
- E2E: 53/53, 3 dòng `Terminated the WebServer`
- X3: 42/42, 4 dòng
- mutation m1–m4: 7/7 đỏ đúng, `be/dist` sha256 không đổi
- harness đầy đủ: must 268/268, exit 0
- harness `off`: must 268/268, exit 0

**SMTP (DEBT-664, tiêu chí D94.9-5): trả 220 ở mọi điểm kiểm**:
- trước E2E
- trước và sau mutation
- trước và sau harness đầy đủ (`HYG-SMTP-AFTER` = "220")
- sau harness `off`
- lần cuối lúc 03:20:48Z

Không restart container.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | Mongo `listDatabases` ; Redis `EXISTS vg:int-lock` (db0) ; SMTP | `admin config local sso-idp-e2e` (0 `vg-int-*`) ; `0` (không ai giữ lock) ; `220 d34120f10a43 Mailpit ESMTP` |
| 1 | `pnpm -C be typecheck` ; `pnpm -C be lint` | `tsc --noEmit` exit 0 ; `eslint src test` exit 0 |
| 2 | `timeout 15m pnpm -C be test` | 02:17→02:18Z · `Test Suites: 66 passed, 66 total` · `Tests: 1289 passed, 1289 total` · `Time: 35.19 s` · exit 0 |
| 3 | `pnpm -C e2e typecheck` | exit 0 |
| 4 | `git status --porcelain fe-admin` ; `pnpm -C fe-admin test` | 0 dòng (fe-admin không đổi) ; `Test Files 69 passed (69)` · `Tests 1658 passed (1658)` · exit 0 |
| 5 | `pnpm -C be build` | exit 0 |
| 6 | `timeout 35m pnpm -C be test:int` | 02:19:55→02:46:15Z · `Test Suites: 95 passed, 95 total` · `Tests: 2475 passed, 2475 total` · `Time: 1577.65 s` · exit 0. Sau: `admin config local sso-idp-e2e` (0 `vg-int-*`) |
| 7 | `rm be/dist/tsconfig.tsbuildinfo` ; SMTP ; cổng 3000/4000/4100/5173/5273/5274/8443/4989/4990 | không có file ; `220 … Mailpit ESMTP` ; mọi cổng trống |
| 8 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 02:46:34→02:59:21Z · `53 passed (12.7m)` · exit 0 · `grep -c "Terminated the WebServer"` = **3** · log có 3 request `POST /reset/code` (token-fragment.spec) |
| 9 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 02:59:33→03:09:21Z · `42 passed (9.8m)` · exit 0 · `Terminated the WebServer` = **4** · X3 không có test reset: chỉ có dòng `Mapped {/reset/code, POST}` lúc khởi động, không có request `/reset*` |
| 10 | `pnpm -C be build` ; xoá tsbuildinfo ; SMTP ; lock ; playwright | exit 0 (dist `ui.controller.js` 10:09:51 +07, có `reset/code`) ; `220` ; lock `0` ; 0 process playwright |
| 11 | `timeout 40m node be/scripts/pentest/mutate.mjs all` | 03:10:04→03:13:31Z · exit 0. Kết quả ở bảng dưới. Dòng cuối: `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none` |
| 12 | SMTP sau mutation | `220 d34120f10a43 Mailpit ESMTP` (exit 0) |
| 13 | `timeout 25m node be/scripts/pentest/pentest.mjs` (lượt chính thức, evidence mặc định) | 03:13:55→03:17:03Z · exit 0. Log: `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free` · `summary must 268/268, should 1/1; namespace clean true; trap hits 0`. Evidence `runs/90-X6-pentest-signoff/evidence/pentest-20261118T031703Z.json`: `ok true` · `profile.timing "on"` · `cleanupErrors []` · `mailpitStale 0` · `mailpitDeleted 500` · `smtpAfter "220"` · `namespace.after {dbsLeft:[], redisDbSizes{7:0}, ports free}` · `e2eUnchanged true` · `devUnchanged true` (DEBT-688 không làm exit 1 dù chạy sau E2E/X3) |
| 13a | Check chính trong evidence | `AUTHN-RESET-TICKET` pass: `{exchange 303, location "/reset", ticketA true, replay 400, unknown 400, replaySameAsUnknown true, ticketB false, passwordFormA true, oldShape 400, oldPasswordLogin 302, freshTokenExchange 303}` · `HYG-MAIL` pass (500) · `HYG-SMTP-AFTER` pass ("220") · `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` pass (diff 1.3/2.0/1.8/0.9 ms, limit 10) · `SESS-COOKIE-FLAGS` pass |
| 14 | SMTP sau harness đầy đủ | `220 d34120f10a43 Mailpit ESMTP` (exit 0) ⇒ **đạt D94.9-5** |
| 15 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/g94/off` | 03:17:26→03:20:33Z · exit 0. Log: `timing checks skipped (--timing off, D93.4)` · `summary must 268/268, should 1/1; namespace clean true; trap hits 0`. Evidence: `profile.timing "off"`, `AUTHN-ENUM-SHAPE-*` = 4, `AUTHN-ENUM-TIME-*` = 0, `AUTHN-RESET-TICKET`/`HYG-MAIL`/`HYG-SMTP-AFTER` pass, `smtpAfter "220"`, `ok true`, e2e/dev unchanged true |
| 16 | So số `must` | off 268 = đầy đủ 268 − 4 TIME + 4 SHAPE ✓ |
| 17 | SMTP cuối cùng (03:20:48Z) | `220 d34120f10a43 Mailpit ESMTP` (exit 0) |
| 18 | Grep evidence | Mẫu: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <≥16 ký tự>`, URI `scheme://user:pass@`. Phạm vi: 15 file evidence chưa track (json) + 16 file `*20261118T03*` (json + log, gồm log bị `.gitignore`) + 2 file `off`. Kết quả **0 hit** (grep exit 1) |
| 19 | Dọn | Mongo `admin config local sso-idp-e2e`: 0 `vg-int-*`, `vg-pentest` vắng · `redis-cli -n 7 dbsize` = 0 · `vg:int-lock` = 0 · cổng 3000/4000/4100/5173/5273/5274/8443/4989/4990 trống · không còn `be/.pentest-mutant-*` · không còn `be/dist/tsconfig.tsbuildinfo` |

Kết quả mutation (bước 11), mỗi dòng `exit 1; expected red YES`:

| Mutation | Đỏ | Check đỏ |
|---|---|---|
| m1 | 1/53 | `OAUTH-PKCE-plain` |
| m2 | 58/63 | mọi `SESS-CSRF-*` sau CsrfGuard, **gồm route mới** `SESS-CSRF-reset-code-{missing,wrong,other}` và `SESS-CSRF-reset-{missing,wrong,other}` (run 93: 55/60) |
| m2b | 2/154 | `SESS-CSRF-logout-wrong`, `SESS-CSRF-logout-other` |
| m2c | 3/154 | `SESS-CSRF-login-mfa-missing`, `-wrong`, `-other` |
| m2d | 1/23 | `INJ-TEMPLATE-reflect` |
| m3 | 17/21 | `IDOR-ADMIN-XTENANT-*` |
| m4 | 1/23 | `CONTRACT-REQID-untrusted` |

## File evidence mới chưa track (để orchestrator commit)

Trong `docs/agile/sso-idp/runs/90-X6-pentest-signoff/evidence/`:
- Lượt chính thức của gate này:
  - `pentest-20261118T031703Z.json`
  - 7 file `pentest-mutant-20261118T031031Z.json`, `…031053Z`, `…031117Z`, `…031139Z`, `…031231Z`, `…031253Z`, `…031331Z`
- Các file `.log` tương ứng bị `.gitignore` (`*.log`), như run 93.
- Còn 7 file `pentest-mutant-20261118T0154…0157Z.json` từ lượt `mutate.mjs all` của lô B (2026-11-18 01:54Z, log.md). Orchestrator quyết giữ hay bỏ: lượt gate ở trên đã thay thế chúng.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Ràng buộc chạy test và thứ tự D94.13:
  - int không chạy song song với E2E;
  - harness chỉ chạy sau E2E/X3;
  - SMTP kiểm trước mọi việc cần thư;
  - không restart container. Xem #0, #7, #10, #12, #14, #17.
- [x] T1 DEBT-661 (vé reset):
  - int `run94-reset-ticket` và 14 spec dùng helper nằm trong 2475 (#6);
  - E2E `token-fragment.spec.ts` trong 53, có `POST /reset/code` (#8);
  - harness `AUTHN-RESET-TICKET` chạy ở chế độ `SESSION_COOKIE_SECURE=true` (`__Host-idp_reset`): đổi một lần, replay từ jar khác giống token lạ (400), body cũ `{token,password}` bị từ chối và không đổi mật khẩu (#13a);
  - CSRF trên `/reset/code` và `/reset` bị m2 làm đỏ (#11).
- [x] Cookie `__Host-idp_reset` ở chế độ Secure: X3 không có test reset (#9) ⇒ được phủ ở harness (`SESS-COOKIE-FLAGS`, `AUTHN-RESET-TICKET` regex `^(__Host-)?idp_reset$` trong profile Secure).
- [x] T2 DEBT-664:
  - pool 5 có unit `mailer.spec` (#2);
  - preflight 220 đạt; `HYG-MAIL` 500 thư và `HYG-SMTP-AFTER` "220" pass ở cả hai lượt;
  - SMTP còn 220 sau mutation, sau harness đầy đủ và sau lượt `off` ⇒ D94.9-5 đạt cục bộ (#12–#17). Đóng hẳn khi CI xanh.
- [x] DEBT-688: harness đầy đủ chạy ngay sau E2E/X3 với `e2eUnchanged true`, `devUnchanged true`, exit 0 (#13); `drills-namespace.spec` trong unit (#2).
- [x] T4 DEBT-682: `mutate.mjs all` cục bộ xanh (#11). Step CI sẽ do orchestrator xác nhận trên CI.
- [x] T3 DEBT-669: chỉ docs, không có test chạy được (senior đã duyệt).
- [x] fe-admin không đổi: 1658/1658 (#4).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Credential (token reset): valid, replay, unknown | đổi 303 + cookie; replay từ jar khác 400, giống hệt token lạ; jar B không có cookie | #13a |
| State (single-use, đã tiêu thụ) | token đã đổi không đổi lại được; token mới chưa đổi vẫn 303 sau khi body cũ bị từ chối | #13a, int #6 |
| Input (body cũ `{token,password}`, NoSQL) | `oldShape` 400, login mật khẩu cũ vẫn 302; `INJ-*` pass | #13, #13a |
| Credential/CSRF (missing/wrong/other) trên `/reset/code`, `/reset` | m2 đỏ đúng 6 check mới | #11 |
| Authorization (cross-tenant) | m3 đỏ 17 `IDOR-ADMIN-XTENANT-*`; bản thật xanh | #11, #13 |
| Request chain (cookie vé → POST `/reset`) | `passwordFormA` true sau 303; E2E token-fragment 3 request `/reset/code` | #8, #13a |
| Enumeration | TIME (on) diff ≤ 2 ms; SHAPE (off) pass | #13a, #15 |
| Dependency (SMTP) | preflight 220; 500 thư/lượt; Mailpit vẫn 220 sau mọi lượt | #12–#17 |
| Exposure | evidence/log không có JWT/argon2/otpauth/PEM private/Bearer/URI có credential | #18 |
| Namespace/state | `vg-pentest` vắng, db7 0, cổng trống, `be/dist` sha256 không đổi, e2e/dev unchanged | #13, #11, #19 |
