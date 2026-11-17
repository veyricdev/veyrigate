# Test Report — 2026-11-17 (run 91 lô D, gate HEAD `c39b19a`)

## Kết quả: PASS

Chạy lại lô D từ đầu trên `c39b19a` (lượt trước dừng giữa int FULL theo yêu cầu người dùng, không có kết quả). Tuần tự, không song song: be typecheck/lint/unit → e2e typecheck → int FULL → Mailpit 220 → E2E #1 → 220 → E2E #2 → X3 → `pnpm -C be build` → harness đầy đủ → mutation. Tất cả xanh: unit 61 suite 1247/1247, int FULL 93 suite 2444/2444 (`vg-int-*` 0 → 0), E2E 52/52 ×2, X3 42/42, harness `pentest-20261117T021931Z` must 261/261 + should 1/1, exit 0, head `c39b19a`; mutation m1, m2, m2b, m2c, m2d, m3, m4 đều đỏ đúng.

fe-admin **không chạy**: run 91 không đụng `fe-admin/` (D91.1, lô A–C chỉ BE/ops/harness). `test:vault` không chạy (cần container Vault mới — cấm tạo container; không đổi code Vault). Alert: không có `promtool` ⇒ `be/src/common/metrics/ops-rules.spec.ts` (trong unit FULL) là cổng.

## Lệnh đã chạy + output thực tế

Hạ tầng: chỉ `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1`; không tạo/restart container, không FLUSH ngoài `FLUSHDB 7` của harness. Preflight `codegraph sync` xong. Log thô ở scratchpad tester (không commit).

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be typecheck` / `pnpm -C be lint` | exit 0 / exit 0 |
| 2 | `timeout 15m pnpm -C be test` | `Test Suites: 61 passed, 61 total` · `Tests: 1247 passed, 1247 total` (48,9 s) |
| 3 | `pnpm -C e2e typecheck` | exit 0 |
| 4 | `cd be && timeout 25m node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.int.config.js --runInBand --testTimeout=60000 --forceExit` | trước: DB = `admin,config,local,sso-idp-e2e` (0 `vg-int-*`) · `Test Suites: 93 passed, 93 total` · `Tests: 2444 passed, 2444 total` (1053,7 s) · exit 0 · sau: cùng danh sách (0 `vg-int-*`) |
| 5 | `exec 3<>/dev/tcp/127.0.0.1/1025; head -1` | `220 … Mailpit ESMTP Service ready`; cổng 3000/4000/5173/4100/8443/4989/4990 trống |
| 6 | `timeout 40m pnpm -C e2e e2e` #1 | **52 passed (13.6m)**, exit 0; `totp allocator: 46 codes, waited 403 s` |
| 7 | kiểm SMTP | `220 … Mailpit ESMTP Service ready` |
| 8 | `timeout 40m pnpm -C e2e e2e` #2 | **52 passed (12.8m)**, exit 0 |
| 9 | `timeout 30m pnpm -C e2e e2e:x3` | **42 passed (9.9m)**, exit 0 |
| 10 | `pnpm -C be build` | exit 0; `git status` không đổi |
| 11 | kiểm SMTP rồi `timeout 25m node be/scripts/pentest/pentest.mjs` | SMTP 220; `namespace ok: vg-pentest absent; redis db 7 empty; ports 4989/4990 free` · `summary must 261/261, should 1/1; namespace clean true; trap hits 0` · evidence `runs/90-X6-pentest-signoff/evidence/pentest-20261117T021931Z.json`, `head` `c39b19a`, `ok` true · exit 0 (181 s) |
| 12 | kiểm SMTP sau #11 | không greeting trong 6 s (DEBT-664 tái diễn như dự kiến; không còn bước cần thư; không restart container) |
| 13 | `timeout 40m node be/scripts/pentest/mutate.mjs all` | xem bảng mutation; `be/dist sha256 before = after: true; mutant dirs left: 0; git status new entries (besides mutant evidence): none`; exit 0 |
| 14 | Dọn dẹp | Mongo `admin,config,local,sso-idp-e2e` (`vg-pentest` vắng), `redis-cli -n 7 dbsize` = 0, 4989/4990 trống, không còn `be/.pentest-mutant-*`; evidence `namespace.after` `dbsLeft []`, db7 0, `e2eUnchanged`/`devUnchanged` true, `cleanupErrors []` |
| 15 | grep evidence `eyJ…{10,}`, `$argon2`, `otpauth:`, `BEGIN … PRIVATE`, `Bearer <x>`, URI Mongo có credential trên `pentest-20261117T021931Z.{json,log}` + 7 `pentest-mutant-20261117T0221..-0223..` | 0 hit / 0 file |
| 16 | Đếm checklist (script trên cột Trạng thái A–D; mỗi `` `đường-dẫn › tên` `` grep đúng 1 dòng) | trước sửa: 203 = 157/28/1/17, **1 lỗi** (B-16c trỏ tên test cũ `two concurrent exchanges … exactly one 200` — lô B đổi theo hợp đồng D91.6); sau sửa: `total {"n":203,"✅":157,"⚠":28,"❌":1,"N/A":17}` · ❌ `D-14` · `refs 334 errors 0` |

### Harness — check mới của run 91 (evidence `021931Z`)

| Check | Tier | Thực tế |
|---|---|---|
| `OAUTH-CODE-REPLAY-REVOKE` | must ✅ | `rtAfter 400`, `atActiveAfter false` |
| `OAUTH-CODE-REPLAY-XCLIENT` | must ✅ | first 200, replay `400 invalid_grant`, AT vẫn active, RT 200 |
| `AUTHN-PREHIJACK-VERIFY` | must ✅ | register 201, user tạo; verify (sai mật khẩu) 400, `verified false`, `tokenKept true` |
| `AUTHN-ENUM-TIME-register-unverified` | must ✅ | n 200, median 31,5 / 31,6 ms, diff 0,1 ms (< 10), cùng phản hồi |
| `AUTHN-ENUM-TIME-login` / `-forgot` / `-register` | must ✅ | diff 0,1 / 1,8 / 0,6 ms (< 10) — đủ 3 ca dưới ngưỡng trong lượt đầy đủ ⇒ không chạy thêm `--only AUTHN` |
| `OAUTH-RESPMODE-form_post` / `-fragment` | must ✅ | 302, `error=invalid_request`, không code |
| `DISCO-RESPMODES` | must ✅ | `["query"]` |
| `CONTRACT-REQID-untrusted` | must ✅ | 3/3 id hợp lệ của client không dùng, echo id an toàn mới; 8 KB 3/3 |
| `SESS-HDR-*` | must ✅ 39/39 | `noStore: true` ở mọi route có cờ (gồm `root`, `authorize-error`, `login-mfa`, `account-*`, `admin-*`; route miễn tĩnh cũng trả no-store) |
| `HYG-BELOG` / `HYG-GITGREP` / `SESS-ROUTELIST` | must ✅ | 0 vi phạm / 3 438 dòng; allow-list khớp; route list khớp |
| `SHOULD-PERF-ARGON` | should ✅ | burst 242 ms, health max 22 ms |

`SHOULD-CODE-REPLAY-REVOKE` (đỏ ở run 90) nay là must `OAUTH-CODE-REPLAY-REVOKE` ⇒ should còn 1/1.

### Mutation (`mutate.mjs all`, mỗi bản trên bản sao dist)

| Mutation | Nhóm | Đỏ | Kỳ vọng |
|---|---|---|---|
| m1 PKCE `plain` | OAUTH | 1/53 `OAUTH-PKCE-plain` | YES |
| m2 `CsrfGuard` → true | SESSION | 55/60 (mọi `SESS-CSRF-*` sau CsrfGuard) | YES |
| m2b `LogoutCsrfGuard` → true | SESSION | 2/151 `SESS-CSRF-logout-wrong/-other` | YES |
| m2c `/login/mfa` bỏ CSRF | SESSION | 3/151 `SESS-CSRF-login-mfa-*` | YES |
| m2d Eta `autoEscape:false` | INJ | 1/22 `INJ-TEMPLATE-reflect` | YES |
| m3 bỏ lọc tenant | IDOR | 17/21 `IDOR-ADMIN-XTENANT-*` | YES |
| **m4** bỏ `fromTrustedProxy` (mới) | INJ | 1/22 `CONTRACT-REQID-untrusted` | YES |

## Test FAIL (nếu có)

Không có. Ghi nhận: B-16c của checklist trỏ tên test đã đổi ở lô B (lỗi tài liệu, không phải sản phẩm) — tester sửa bằng chứng. Mailpit SMTP kẹt sau harness (DEBT-664, môi trường test) — trước bước mail tiếp theo cần restart `veyrigate-mailpit-1` (orchestrator/người dùng).

## Coverage acceptance criteria (lô D, `tasks.md`)

- [x] be typecheck + lint + unit FULL — #1, #2 (gồm `ops-rules.spec.ts` thay `promtool`).
- [x] int FULL một lượt, `vg-int-*` 0 → 0 — #4.
- [x] E2E ×2 sau kiểm SMTP 220 — #5–#8.
- [x] X3 42 — #9.
- [x] fe-admin không chạy, có lý do — phần Kết quả.
- [x] Harness sau E2E: toàn bộ must (254 cũ + check mới T3/T4/T5) xanh, exit 0, evidence ghi HEAD `c39b19a` — #11 + bảng check mới.
- [x] Mutation m1–m4 (m4 mới) đỏ đúng — bảng mutation.
- [x] Dọn dẹp: `vg-pentest` vắng, db7 0, 4989/4990 trống, evidence không secret — #14, #15.
- [x] `release-checklist.md`: đoạn "Run 91" đầu file; C-16.4a `CONTRACT-REQID-echo` ⇒ `CONTRACT-REQID-untrusted`; cập nhật A-4.3, B-16c, C-6.3.4, C-10.4a, C-10.6, C-14.3, D-12, D-17 (DEBT-651/662/663/665/666/671); đếm lại 203 = 157/28/1/17, 334 bằng chứng 0 lỗi; mục F không sửa chữ ký, thêm "Ghi chú Run 91": điều kiện go-live (2) đáp ứng mức repo, DEBT-670 chờ môi trường thật.
- [x] Đóng DEBT-651/662/663/665/671 trong `backlog.md` (DEBT-666/667/672 đã đóng ở lô A–C).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm (bằng chứng) |
|---|---|
| Identity | anonymous / user / user khác tenant / admin MFA — harness IDOR + SESSION; m3 đỏ đúng |
| Credential | code dùng lại cùng client ⇒ RT + AT chết (`OAUTH-CODE-REPLAY-REVOKE`, int `code-replay` 9); client khác lặp ⇒ không đụng (`-XCLIENT`); mật khẩu kẻ tấn công không xác minh được tài khoản (`AUTHN-PREHIJACK-VERIFY`) |
| Authorization | cross-tenant 21 check IDOR; non-owner client replay không thu hồi token của client gốc |
| Input | `response_mode` form_post/fragment/lạ/rỗng/lặp ⇒ `invalid_request` (harness + int `run91-lotc`); `x-request-id` hợp lệ/8 KB/CRLF |
| State | replay + đua consume/phát (int `code-replay` race), token xác minh ≤ 5 lượt, giữ token sau lượt sai |
| Dependency | Redis lỗi khi ghi dấu / xử lý replay ⇒ 500 fail-closed (int); lỗi ghi nền ⇒ counter + alert (int `run91-background-writes`, `ops-rules.spec`) |
| Request chain | `/authorize` → 302 code/error/`/login` đều `no-store`; X3 cookie matrix 42; E2E luồng đầy đủ ×2 |
| Exposure | thời gian `/register` chưa xác minh không lộ tồn tại (0,1 ms); request id client không vào log/audit khi peer không tin cậy (m4); `HYG-BELOG` 0; evidence grep 0 |
