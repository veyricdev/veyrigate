# Test Report — 2026-11-17 (run 93, gate E theo D93.10)

## Kết quả: PASS

Phạm vi: working tree chưa commit (lô A–D + 2 sửa nhỏ của orchestrator, gồm `PENTEST_BUDGET_MIN`), `head` = `924cbd2`. Tester không sửa code, không commit.

Chạy tuần tự, không song song: unit → fe-admin → e2e typecheck → build → int FULL → SMTP → E2E ×1 → X3 → build → harness `off` → SMTP → harness đầy đủ → mutation → dọn.

Tổng kết:
- be unit 1285/1285
- fe-admin 1658/1658
- int FULL 2458/2458
- E2E 53/53 (3 dòng `Terminated the WebServer`)
- X3 42/42 (4 dòng)
- Harness `--timing off`: must 261/261
- Harness đầy đủ: must 261/261
- Mutation m1–m4: 7/7 đỏ đúng, `be/dist` sha256 không đổi

**SMTP sau harness (DEBT-664):**
- Sau lượt `off`: còn trả 220.
- Sau lượt đầy đủ: **không trả 220** (`timeout 6` exit 124), tái hiện DEBT-664.
- Không restart container. Người dùng restart `veyrigate-mailpit-1` trước việc cần thư.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output thực tế |
|---|---|---|
| 0 | `docker exec veyrigate-mongo mongosh … listDatabases` | trước: `admin config local sso-idp-e2e` (0 `vg-int-*`) |
| 1 | `pnpm -C be typecheck` ; `pnpm -C be lint` | `tsc --noEmit` exit 0 ; `eslint src test` exit 0 |
| 2 | `timeout 15m pnpm -C be test` | `Test Suites: 65 passed, 65 total` · `Tests: 1285 passed, 1285 total` · `Time: 37.316 s` · exit 0 |
| 3 | `pnpm -C fe-admin typecheck/lint/test/build` | 4 lệnh exit 0 · `Test Files 69 passed (69)` · `Tests 1658 passed (1658)` · vite `✓ built in 1.35s` |
| 4 | `pnpm -C e2e typecheck` | exit 0 |
| 5 | `pnpm -C be build` | exit 0 |
| 6 | `timeout 35m pnpm -C be test:int` | 08:07:54→08:26:55Z · `Test Suites: 94 passed, 94 total` · `Tests: 2458 passed, 2458 total` · `Time: 1138.194 s` · exit 0. Sau: `admin config local sso-idp-e2e` (0 `vg-int-*`) |
| 7 | `rm be/dist/tsconfig.tsbuildinfo` ; `timeout 6 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1025; head -c 30 <&3'` | đã xoá ; `220 … Mailpit ESMTP` |
| 8 | `DEBUG=pw:webserver timeout 40m pnpm -C e2e e2e` | 08:27:09→08:40:00Z · `53 passed (12.8m)` · exit 0 · `grep -c "Terminated the WebServer"` = **3** |
| 9 | `DEBUG=pw:webserver timeout 30m pnpm -C e2e e2e:x3` | 08:40:10→08:49:56Z · `42 passed (9.7m)` · exit 0 · `Terminated the WebServer` = **4** |
| 10 | `pnpm -C be build` | exit 0 |
| 11 | `timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence <scratchpad>/pentest-off` | 08:50:26Z, khoảng 184 s, exit 0. Log: `timing checks skipped (--timing off, D93.4)` · `summary must 261/261, should 1/1; namespace clean true; trap hits 0`. Evidence JSON: `profile.timing = "off"`, `summary.must {pass 261, fail 0}`, `AUTHN-ENUM-SHAPE-*` = 4, `AUTHN-ENUM-TIME-*` = 0, 262 check, `ok true`. Evidence nằm ở scratchpad của tester, không commit |
| 12 | kiểm SMTP | `220 … Mailpit ESMTP` (exit 0) ⇒ chạy lượt đầy đủ |
| 13 | `timeout 25m node be/scripts/pentest/pentest.mjs` | 08:53:47→08:57:02Z, exit 0. Log: `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free` · `summary must 261/261, should 1/1; namespace clean true; trap hits 0`. Evidence chính thức `runs/90-X6-pentest-signoff/evidence/pentest-20261117T085701Z.json` (giữ lại): `profile.timing "on"`, `AUTHN-ENUM-TIME-{login,forgot,register,register-unverified}` = 4, SHAPE 0, `ok true`, `namespace.after` = `{dbsLeft [], redis db7 0, 4989/4990 free}` |
| 14 | So số `must` | off 261 = đầy đủ 261 − 4 TIME + 4 SHAPE ✓ |
| 15 | kiểm SMTP sau lượt đầy đủ | **không có banner, `timeout` exit 124** (DEBT-664). Không restart |
| 16 | `timeout 40m node be/scripts/pentest/mutate.mjs all` | 08:57:21→09:00:31Z · exit 0. Kết quả bên dưới bảng |
| 17 | Grep evidence | Mẫu: JWT `eyJ….eyJ`, `$argon2`, `otpauth://`, `BEGIN … PRIVATE`, `Bearer <token>`, URI `scheme://user:pass@`. Phạm vi: 2 file `off`, 2 file đầy đủ, 14 file mutant (json + log). Kết quả: **0 hit mọi file** |
| 18 | Dọn | Mongo `admin config local sso-idp-e2e`: 0 `vg-int-*`, `vg-pentest` vắng · `redis-cli -n 7 dbsize` = 0 · cổng 3000/4000/4100/5173/8443/4989/4990 trống · không còn `be/.pentest-mutant-*` · không còn `be/dist/tsconfig.tsbuildinfo` · `git status`: thêm `runs/90…/evidence/pentest-20261117T085701Z.json` + 7 `pentest-mutant-*.json` (evidence chính thức) và `runs/93…/` |

Kết quả mutation (bước 16), mỗi dòng `exit 1; expected red YES`:

| Mutation | Đỏ | Check đỏ |
|---|---|---|
| m1 | 1/53 | `OAUTH-PKCE-plain` |
| m2 | 55/60 | mọi `SESS-CSRF-*` sau CsrfGuard + `SESSION-HARNESS` |
| m2b | 2/151 | `SESS-CSRF-logout-wrong`, `SESS-CSRF-logout-other` |
| m2c | 3/151 | `SESS-CSRF-login-mfa-missing`, `-wrong`, `-other` |
| m2d | 1/22 | `INJ-TEMPLATE-reflect` |
| m3 | 17/21 | `IDOR-ADMIN-XTENANT-*` |
| m4 | 1/22 | `CONTRACT-REQID-untrusted` |

Dòng cuối: `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Ràng buộc chạy test và D93.10:
  - thứ tự cố định;
  - harness chỉ chạy sau E2E/X3;
  - SMTP kiểm trước lượt đầy đủ;
  - không restart container. Xem #7, #12, #15.
- [x] T1 DEBT-679: fe-admin 1658/1658, gồm `serve-mjs-risk.test.ts`. Xem #3.
- [x] T2 DEBT-681: X3 42 + 4 dòng `Terminated the WebServer`. Xem #9.
- [x] E2E (`playwright.config.ts` run 92): 53 + 3 dòng `Terminated`. Xem #8.
- [x] T4 DEBT-650 / D93.4:
  - `--timing off` chỉ có `AUTHN-ENUM-SHAPE-*`, `profile.timing off`, `--evidence` theo đường dẫn, must 0 fail (#11);
  - mặc định `on` (#13);
  - so số khớp (#14);
  - CI xác nhận ở D93.11 (orchestrator).
- [x] T5 DEBT-676 (khoá drill ở homedir): mutate/pentest chạy bình thường, `drills-lock.spec.ts` nằm trong 1285 unit. Xem #2, #16.
- [x] T5 DEBT-677: logout int (2458) và unit xanh. Xem #2, #6.
- [x] T3 DEBT-258: chỉ docs, không có test chạy được (senior đã duyệt).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Xem |
|---|---|---|
| Authorization (cross-tenant) | m3 làm đỏ 17 check `IDOR-ADMIN-XTENANT-*`; bản thật xanh | #13, #16 |
| Credential/CSRF (missing/wrong/other) | m2/m2b/m2c đỏ đúng | #16 |
| Input injection | m2d | #16 |
| Request chain (`x-request-id` từ peer không tin cậy) | m4 | #16 |
| Enumeration | SHAPE (off) và TIME (on) đều pass | #11, #13 |
| Exposure | Evidence không có JWT/argon2/otpauth/PEM private/Bearer/URI có credential | #17 |
| State/namespace | `vg-pentest` vắng, db7 0, cổng trống, `be/dist` không đổi | #13, #16, #18 |
| Dependency | SMTP Mailpit kẹt sau lượt đầy đủ (DEBT-664, đã biết, không chặn); lượt `off` không làm kẹt SMTP | #12, #15 |
