# Test Report — 2026-11-17 (run 92 lô D, gate local trên working tree chưa commit: lô A CI + lô B `.gitleaksignore` + lô C CodeQL)

## Kết quả: PASS

Tuần tự, không song song (E2E build lại `be/dist`): be typecheck/lint/unit → fe-admin typecheck/lint/test/build → e2e typecheck → `pnpm -C be build` → int FULL (cấu hình mới) → Mailpit 220 → E2E ×1 → X3. Tất cả xanh: unit 65 suite 1285/1285, fe-admin 69 file 1654/1654, int FULL 94 suite **2458/2458** (= 2444 + 14 `run92-codeql.int-spec.ts`; `vg-int-*` 0 → 0), E2E **53/53**, X3 42/42.

Không chạy: gitleaks (không có binary cục bộ, không tải — CI kiểm), smoke Docker be-image/fe-admin-image (cấm tạo container — CI kiểm, DEBT-675), CodeQL (CI), `test:vault` (cần container Vault mới, không đổi code Vault).

## Lệnh đã chạy + output thực tế

Hạ tầng: chỉ `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1` (đều Up); không tạo/restart container, không FLUSH. Log thô ở scratchpad tester (không commit).

| # | Lệnh | Kết quả |
|---|---|---|
| 0 | `docker exec veyrigate-mongo mongosh … listDatabases` | trước: `admin config local sso-idp-e2e` (0 `vg-int-*`) |
| 1 | `pnpm -C be typecheck` / `pnpm -C be lint` | exit 0 / exit 0 (04:15→04:16Z) |
| 2 | `timeout 15m pnpm -C be test` | `Test Suites: 65 passed, 65 total` · `Tests: 1285 passed, 1285 total` (36,1 s), exit 0 — `backup-scripts.spec` không timeout lượt này |
| 3 | `pnpm -C fe-admin typecheck` / `lint` | exit 0 / exit 0 |
| 4 | `pnpm -C fe-admin test` (Redis :6479) | `Test Files 69 passed (69)` · `Tests 1654 passed (1654)` (23,7 s), exit 0 — `bff.test.ts` flaky không tái diễn |
| 5 | `pnpm -C fe-admin build` | exit 0 (`✓ built in 1.39s`) |
| 6 | `pnpm -C e2e typecheck` | exit 0 |
| 7 | `pnpm -C be build` | exit 0 (04:18:44Z) |
| 8 | `timeout 30m pnpm -C be test:int` (config mới: `maxWorkers: 1` + `workerIdleMemoryLimit: '1GB'`, không `--runInBand`) | 04:18:48→04:46:03Z · `Test Suites: 94 passed, 94 total` · `Tests: 2458 passed, 2458 total` · `Time: 1632.452 s` · exit 0. Giữa chừng có đúng 1 DB `vg-int-admin-users-…` (tuần tự); sau: `admin config local sso-idp-e2e` (0 `vg-int-*`) |
| 9 | `ls be/dist/tsconfig.tsbuildinfo` | có sau bước 1 (artefact `tsc --noEmit`), **không còn** sau bước 7 (`nest build` dọn dist) ⇒ không cần xoá |
| 10 | `timeout 6 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1025; head -c 30 <&3'` | `220 … Mailpit ESMTP` |
| 11 | `timeout 40m pnpm -C e2e e2e` ×1 | 04:46:18→04:58:58Z · **53 passed (12.6m)**, 0 fail/flaky, exit 0; `totp allocator (worker …): 47 codes, waited 416 s`. Log `server function failed` ×4 / `federation failed: invalid_state` là ca âm có chủ đích (`Invalid client id`, `unrecognized_keys tenantId`), không phải lỗi |
| 12 | `timeout 30m pnpm -C e2e e2e:x3` | 04:59:11→05:08:56Z · **42 passed (9.7m)**, exit 0 |
| 13 | Dọn | Mongo `admin config local sso-idp-e2e` (0 `vg-int-*`); cổng 3000/4000/4100/5173/8443/4989/4990 trống; `git status --short` 34 dòng = như đầu phiên (không file mới) |

Ghi chú thời lượng int: 1632 s (lượt đo lô A cùng cấu hình: 1076 s; lượt run 91 `--runInBand`: 1054 s) — vẫn dưới `timeout 30m` local và `int.timeout-minutes: 45` CI, nhưng chậm hơn ~50 % so với lượt đo lô A; không đo heap lượt này (không `--logHeapUsage`, theo lệnh gate). Theo dõi trên CI.

## Test FAIL

Không có.

## Coverage acceptance criteria (D92.10)

- [x] be unit — #2
- [x] int FULL ≥ 2444 + test mới, có `pnpm -C be build` trước — #7, #8 (2458 = 2444 + 14)
- [x] fe-admin test + build (Redis :6479) — #4, #5 (gồm `serve-mjs-risk.test.ts` của T3)
- [x] typecheck + lint (be, fe-admin, e2e) — #1, #3, #6
- [x] E2E ×1 (đổi `playwright.config.ts`, `totp.ts`, `logout-redirect.js`) — #11 (53 = 52 + ca mới `totp.spec.ts`)
- [x] X3 (không bắt buộc; `serve.mjs` đổi) — #12
- [ ] CI GitHub (gitleaks 11 fingerprint, be-image/fe-admin-image smoke, CodeQL) — chỉ kiểm được sau push (orchestrator), DEBT-675/678

## Coverage security invariants / risk matrix

Lô C (trust boundary) đã có test riêng do backend-dev viết và senior kiểm; gate này chạy lại toàn bộ trong unit/int FULL:

- [x] Input oversized/malformed — `bearer.spec.ts` (16 KiB dấu cách, tuyến tính) trong #2
- [x] Input non-string / injection vào filter Mongo (#7/#8) — `client.service.spec.ts`, `resource.service.spec.ts` (#2), `run92-codeql.int-spec.ts` (#8)
- [x] Request chain logout: `state` lặp ⇒ vắng, POST `/logout` không `_csrf` ⇒ trang xác nhận, phiên sống — `run92-codeql.int-spec.ts` (#8); redirect chỉ `http:`/`https:` — `logout-redirect-script.spec.ts` (#2) + E2E logout (#11)
- [x] Exposure: lỗi text cố định, không phản chiếu input — `run92-codeql.int-spec.ts` (#8); `nextCode` throw không lộ mã/secret — `totp.spec.ts` (#11)
- [x] State/concurrency khoá drill `wx` — `drills-lock.spec.ts` (#2)
