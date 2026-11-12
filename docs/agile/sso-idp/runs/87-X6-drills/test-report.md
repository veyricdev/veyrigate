# Test Report — 2026-11-12 (run 87, tester, retry 1 T6)

## Kết quả: PASS (mọi gate + 3 diễn tập)

Lượt đầu FAIL (T1 treo: DEBT-620 + DEBT-621, trả backend-dev). Retry 1: backend-dev sửa cả hai; lượt chính thức T1
exit 0, 36/36 check. Chỉ `be/src/common/ops/backup-scripts.spec.ts` mới dưới `be/src` kể từ lượt int FULL/E2E/X3
(`find be/src be/test e2e/tests fe-admin/src -newer <log lượt đầu>` ⇒ đúng file đó; harness/script ops nằm ngoài các
suite này) ⇒ không chạy lại int FULL/E2E/X3; chạy lại be lint/typecheck/unit.

| Gate | Lệnh | Kết quả |
|---|---|---|
| Lint | `pnpm lint` (lượt đầu) + `pnpm -C be lint` (retry) | ✅ exit 0 / ✅ exit 0 |
| Typecheck | `pnpm typecheck` (lượt đầu, gồm e2e) + `pnpm -C be typecheck` (retry) | ✅ exit 0 / ✅ exit 0 |
| BE unit | `pnpm -C be test` (retry) | ✅ 50 suites, **1018/1018** (lượt đầu 1013) |
| Spec mới DEBT-620 | `pnpm -C be test -- backup-scripts` | ✅ 5/5 |
| BE int FULL | `pnpm -C be test:int` (lượt đầu) | ✅ 78 suites, **2275/2275**, 837 s |
| Vault | `pnpm -C be test:vault` (orchestrator, lệnh Vault D87.16) | ✅ 32/32 |
| fe-admin | `pnpm -C fe-admin test` (lượt đầu) | ✅ 68 files, **1626/1626** |
| E2E lượt 1 | `pnpm -C e2e e2e` | ✅ **42 passed** (5.5m) |
| E2E lượt 2 | `pnpm -C e2e e2e` | ✅ **42 passed** (5.1m); T5 AC4, spec không còn `100 pages` |
| X3 | `pnpm -C e2e e2e:x3` | ✅ **42 passed** (9.8m) |
| T1 backup/restore | `node be/scripts/drills/backup-restore-drill.mjs --recover-cli <scratch>/be87/deploy/dist/database/admin-recover.js` | ✅ exit 0, **36/36**, 55,8 s |
| T3 rotate Local | `node be/scripts/drills/rotate-drill.mjs --provider local` | ✅ exit 0, **23/23** |
| T3 rotate Vault | `… --provider vault` (orchestrator) | ✅ exit 0, **30/30** |
| T3 lượt tay runbook-ops §1 | `scratchpad/t87/manual-rotate.sh` (curl) | ✅ mọi bước đúng, 1,98 s |

## Lệnh đã chạy + output thực tế

- T1 (07:12:51–07:13:48 UTC):
  ```
  [0.3s] namespace ok: vg-drill-src, vg-drill-restore absent; redis db 7 empty; port 4987 free
  [7.1s] seeded vg-drill-src: {"users":2000,"legacy":200,"expiredLocks":50,"consents":500,"refreshTokens":2000,"audits":5000}
  [13.0s] source app stopped (RT_pre kept in memory)
  [30.0s] negative cases: {"credentialUriRefused":true,"dumpFailure":true,"existingDstRefused":true,"sameDb":true,"dropOption":true,"tamperedSha":true,"rogueSigner":true,"countMismatch":true}
  [55.8s] evidence: …\runs\87-X6-drills\evidence\backup-restore-20261112T071348Z.json
  exit=0
  ```
  Evidence: `ok:true`, 36 check 0 lỗi; thời gian và từng bước ở `drill-report.md` §T1.
- `pnpm -C be test`: `Test Suites: 50 passed, 50 total` / `Tests: 1018 passed, 1018 total`.
- `pnpm -C be test -- backup-scripts`: `PASS src/common/ops/backup-scripts.spec.ts`, 5 ca (`backup counts documents per
  collection: database-tools 100.20 (namespace in backticks)`, `…: older form (no backticks)`, `counts only the dumped db …
  => exit 1`, `restore checks the real summary line: matching manifest`, `…: manifest says one more document`).
- `rotate-drill --provider local`: exit 0, `evidence/rotate-local-20261112T062325Z.json` (rotate 94 ms, JWKS 99 ms).
- `pnpm -C be test:int`: `Test Suites: 78 passed` / `Tests: 2275 passed, 2275 total`.
- `pnpm -C fe-admin test`: `Test Files 68 passed (68)` / `Tests 1626 passed (1626)`.
- E2E/X3: `42 passed` ×3 lượt, exit 0.

## Test FAIL

Không còn. Lịch sử (lượt đầu, đã sửa ở retry 1 của backend-dev):
- T1 bước backup — kỳ vọng exit 0 vs thực tế exit 1 `mongodump reported no collection` — regex không nhận backtick của
  mongodump 100.20.1 (DEBT-620, ops).
- T1 dọn sau lỗi — kỳ vọng `finally` dọn + exit 1 vs thực tế treo vĩnh viễn — `startBe().stop()` coi exit SIGTERM là chưa
  thoát (DEBT-621, harness). Tester dọn tay sau 3 lượt treo.

## Coverage acceptance criteria

- T1 AC tài liệu (runbook-ops §4, §4c gọi file mongosh, alert) — ✅ (+ R2-1/R2-2/R2-3 của tester).
- T1 AC script 1–5 — ✅ `negativeCases` 8/8 (+ khoá ký không pin DEBT-617, URI credential, dump lỗi).
- T1 AC diễn tập 1–12 — ✅ `evidence/backup-restore-20261112T071348Z.json`; phần kỹ thuật 12,8 s ≤ 10 phút.
- T2 AC1–AC13 — int FULL (`run87-admin-recover`, `runbook-drill §3`) + chạy thật trên DB restore từ bố cục deploy
  (`--dry-run` + `--unlock`, audit `ADMIN_RECOVERED` qua `GET /admin/audit`) ✅.
- T3 AC1–AC11 — evidence Local/Vault + lượt tay ✅; runbook-ops §0/§1 sửa.
- T4 AC1–AC4 — int FULL ✅; AC5 (§15 trên DB restore: 200/50 → 0/0, chạy lại 0) ✅.
- T5 AC1–AC4 — `image-pins.spec.ts`, `seed-e2e-admin.int-spec.ts`, E2E 2 lượt ✅.
- T6 — checklist D-4/D-5/D-6 ✅, E-252/E-253 ✅, D-16 ❌ P1, D-3 ghi chú; đếm lại 202/149/29/5/19, P0 ❌ 0, 286 bằng chứng
  0 lỗi; security-matrix §Run 87 (CLI recovery + backup guard + rotate).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Credential: key ký bị lộ | AT cũ 401/`active:false`/admin 401; instance B ≤ 32 s | rotate evidence Local + Vault |
| Credential: RP cache nóng | vẫn nhận AT cũ, từ chối AT mới ≤ 30 s (runbook §1 5(ii)) | `warmVerifier` |
| State: RT sống lại sau restore | §4c ⇒ `active RT 0`; `RT_pre` ⇒ 400 `invalid_grant`; RT mới 200 | backup-restore evidence |
| State: restore vào DB có sẵn / `dst==src` / `--drop` | từ chối, DB đích không đổi | `negativeCases` |
| Input: archive bị sửa 1 byte, số document lệch | từ chối trước kết nối / exit 1 | `negativeCases` |
| Identity: archive do khoá ký giả tạo | từ chối trước mongorestore | `negativeCases.rogueSigner` |
| Dependency: mongodump lỗi | exit ≠ 0, không file, metric không đổi | `negativeCases.dumpFailure` |
| Authorization: CLI recovery (tự duyệt, còn super_admin, khoá) | int FULL + drill: `usable super_admins: 0`, `locked: yes` ⇒ `--unlock` | `run87-admin-recover.int-spec.ts`, evidence `adminRecover` |
| Exposure: URI/email/token | `MONGO_URI` có credential không echo; CLI output không email; evidence: grep `eyJ|argon2|password|secret|mongodb://…@` chỉ khớp tên check/collection | evidence + `assertClean` |

## Hạ tầng (D87.11 / T6)

- Không tạo container; `docker ps -a`: `veyrigate-redis`, `veyrigate-mongo`, `veyrigate-mailpit-1`.
- `vg-int-*`/`vg-drill-*`: trước int FULL 0, sau 0; sau drill T1 0 (`listDatabases` = `admin config local sso-idp-e2e`).
- Redis db 7 = 0, db 8 = 0. `%TEMP%` không còn `vg-drill-*`/lock; không còn gpg-agent/scdaemon.
- `sso-idp-e2e`: drill không đổi (`e2eUnchanged:true`), chỉ E2E thay đổi.
- Cổng E2E trống trước khi chạy, không dừng tiến trình nào.
