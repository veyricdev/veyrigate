# Test Report — 2026-11-09 (run 77, sweep FE/E2E đợt 1 + fix senior DEBT-518/519/520)

## Kết quả: PASS

fe-admin 1570/1570; E2E 38/38; X3 42/42 (`x3-matrix.json` 42 ô, 42 cặp unique); kiểm tự lành DEBT-519 trên DB `sso-idp-e2e`: lần 1 FAIL ồn đúng chỗ, lần 2 PASS; `be/` không đổi.

Tester không sửa test/code sản phẩm: test của dev đã phủ đủ AC (đối chiếu bên dưới), không cần bổ sung. Không có mutation nào của tester (M1–M6 do dev chạy, M3 senior chạy lại; xem `log.md`). Phiên tester bị ngắt một lần giữa lúc chạy full E2E; khi tiếp tục đã kiểm: không còn spec tạm/mutation, `git diff --stat` khớp diff hợp lệ run 77, DB E2E sạch, port trống — rồi chạy lại từ full E2E.

## Lệnh đã chạy + output thực tế (tuần tự)

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` | `tsc --noEmit`, exit 0 |
| 2 | `pnpm -C fe-admin lint` | `eslint .`, exit 0 |
| 3 | `pnpm -C fe-admin test` | `Test Files 67 passed (67)`, `Tests 1570 passed (1570)`, exit 0 |
| 4 | `pnpm -C e2e typecheck` | `tsc --noEmit`, exit 0 |
| 5 | `netstat -ano` LISTENING :4000/:5173/:3000/:4100/:8443/:5273/:5274 | 0 dòng (trống) |
| 6 | read-only `mongosh` trên `aegate-mongo`, DB `sso-idp-e2e` (`users.findOne` + `usertenants.find`) | `dev@example.com [{"roles":[],...}]`, `e2e-user@example.com [{"roles":[],...}]` |
| 7 | spec tạm `e2e/tests/zz-q77-dirty.tmp.spec.ts` (`pnpm e2e <file>`): token super_admin qua flow fe-admin thật, `PATCH /admin/users/{dev}/roles {roles:["tenant_admin"]}` trên stack E2E | `q77 dirty roles now: ["tenant_admin"]`, `1 passed (1.0m)`; spec tạm xoá ngay sau |
| 8 | read-only (như 6) | dev `["tenant_admin"]`, e2e-user `[]` |
| 9 | `pnpm e2e tests/fe-admin-roles.spec.ts` (DB bẩn) | test 1 ok; test 2 **x** `Error: dev user seeded without admin role` — Expected `[]`, Received `["tenant_admin"]` tại `fe-admin-roles.spec.ts:106`; `1 failed, 1 passed (1.2m)`, exit 1 |
| 10 | read-only (như 6) | dev `[]`, e2e-user `[]` (finally đã dọn) |
| 11 | `pnpm e2e tests/fe-admin-roles.spec.ts` (chạy lại) | `ok 1`, `ok 2 … (7.0s)`, `2 passed (1.3m)`, exit 0 |
| 12 | read-only (như 6) | dev `[]`, e2e-user `[]` |
| 13 | port check (như 5) | trống |
| 14 | `pnpm -C e2e e2e` | `38 passed (6.5m)`, exit 0 |
| 15 | port check | trống |
| 16 | `pnpm -C e2e e2e:x3` | `42 passed (9.5m)`, exit 0 |
| 17 | parse `e2e/test-results/x3-matrix.json` | chromium 14, firefox 14, webkit 14; total 42, unique `(project, case, topology)` 42; status `{"passed":42}` |
| 18 | port check sau cùng | trống |
| 19 | `git diff --stat be` | rỗng |
| 20 | read-only cuối (như 6) | dev `[]`, e2e-user `[]`; file script tạm trong container đã xoá |

Không compose up, không seed/sync-indexes DB dev `sso-idp` (stack E2E tự seed `sso-idp-e2e` qua `webServer`), không đụng `aegate-*` ngoài 1 lệnh đọc, không kill process.

## Exposure trong log Playwright

Đếm (không in giá trị) trên 4 log của tester (`q77-e2e.log`, `q77-x3.log`, `q77-roles-dirty.log`, `q77-roles-heal.log`, gồm cả stdout `[WebServer]`): `eyJ` = 0; `ADMIN_SEED_PASSWORD` = 0; `E2E_USER_PASSWORD` = 0; `E2E_FE_ADMIN_SECRET` = 0; `DEV_SEED_PASSWORD` (giá trị từ `e2e/.env`) = 0 ở cả 4 log.

## Test FAIL

Không (lần FAIL ở bước 9 là kỳ vọng của kịch bản DB bẩn).

## Coverage acceptance criteria

- [x] Task 1 / DEBT-490 — `fe-admin/test/users-ui.test.tsx` "lock conflict (last super admin)…": user super_admin, `lock` ⇒ `fail("conflict")`, alert trong dialog **bằng đúng** chuỗi cố định, body không chứa `msg conflict`, `lock` 1 lần, không re-read. Mutation M1 (dev) RED.
- [x] Task 2 / DEBT-492 ca A — `users-roles-ui.test.tsx` "not_found then the re-read is not_found too…": mở form trước, sau đó `getUser`/`setRoles` ⇒ `not_found`; `noDialog`, 0 checkbox, không nút Save, status = `USER_GONE`, `getUser` gọi lại (> số lần trước). M2 RED.
- [x] Task 2 ca B — "a throw that is not an AdminRequestError…": `noDialog` (bắt đúng mất nhánh `instanceof`), status `ROLES_UNCERTAIN`, `setRoles` 1 lần sau 30 ms, body không chứa `boom-xyz`. M3 RED (dev + senior).
- [x] Task 3 / DEBT-493 — không đổi hành vi: toàn bộ 1570 test xanh, typecheck/lint 0. DEBT-518: `const ADMIN_ROLES` chỉ còn ở `inputs.ts` (`bff.ts` -1 dòng).
- [x] Task 4 / DEBT-491 — `resetRoles` dùng ở cả 2 test; warn cố định chỉ có status, `catch {}` không bind lỗi. M4 (dev): warn `answered 400`, test xanh. Log tester: không dòng warn (dọn thành công).
- [x] Task 6 / DEBT-494 — test 2 `fe-admin-roles.spec.ts` xanh trong full E2E và chạy riêng (bước 11, 14): gate self/super_admin/account, 1 checkbox Tenant admin, request BFF bị sửa ⇒ alert 403 bằng đúng, `tampered === 1`, roles dev qua API `[]`. M5 (dev) RED.
- [x] DEBT-519 tự lành — bước 6→12: DB bẩn (dev `tenant_admin`, đặt qua admin API stack E2E) ⇒ test FAIL ồn ở assert baseline (không pass giả), `finally` trả dev về `[]`; chạy lại PASS; DB cuối sạch.
- [x] Task 5 / DEBT-509 — X3 42/42, JSON 42 ô unique, 3 × 14. M6 (dev): fix ⇒ 42 ô (1 failed), code cũ ⇒ 29 ô.
- [x] Gate: fe-admin ≥ 1567+3 (1570), E2E 38/38, X3 42, `be/` không đổi.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Bằng chứng |
|---|---|---|
| Identity / Authorization | viewer tenant_admin thật (không super_admin): self, target super_admin, target thường; negative actor ghi `super_admin` qua BFF ⇒ BE 403, roles dev không đổi | E2E test 2 (bước 11, 14) |
| Request chain | request BFF `/_serverFn` bị sửa trong trình duyệt (confused deputy) ⇒ BFF chỉ chuyển token của viewer | E2E test 2, `tampered === 1` |
| State | DB E2E bẩn từ lần chạy bị cắt ⇒ fail ồn + tự lành; dọn `finally` idempotent | bước 7–12 |
| Dependency / failure | 409 lock, throw không phải `AdminRequestError` (BFF/network) ⇒ thông điệp cố định, đóng dialog, gửi 1 lần | unit ca lock conflict, ca B |
| Exposure | DOM không chứa description BE (`msg conflict`, `boom-xyz`); log Playwright 0 `eyJ`, 0 mật khẩu/secret E2E/dev | unit + đếm log |
| Matrix integrity | worker restart không mất ô X3 | X3 42 ô unique + M6 (dev) |

Không có PENDING ⇒ không thêm DEBT.
