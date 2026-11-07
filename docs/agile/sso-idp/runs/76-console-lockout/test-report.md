# Test Report — 2026-11-07 (run 76, DEBT-515/513)

## Kết quả: PASS

| Gate | Kết quả |
|---|---|
| `pnpm -C be typecheck` | sạch (exit 0) |
| `pnpm -C be lint` | sạch (sau `prettier --write` 1 dòng test tester thêm) |
| `pnpm -C be test` | 41 suites, **684/684** |
| `pnpm -C be test:int` FULL | 57 suites, **1516/1516** (1511 + 5 ca tester), 534 s; `mailer.int-spec` xanh lần này |
| DB `vg-int-*` trên `vg-test-mongo` | trước **4**, sau **4** |
| `pnpm -C fe-admin test` | 67 files, **1567/1567** |
| `pnpm -C e2e e2e` | **37/37** (4.2 m) |
| `pnpm -C e2e e2e:x3` | **42/42** (9.3 m) |
| Port :4000/:5173/:3000/:8443/:5273 | không LISTENING trước E2E, giữa E2E/X3 và sau X3 |

Môi trường: `vg-test-mongo` :27117, `vg-test-redis` :6479, `veyrigate-mailpit-1` :1025/:8025, `aegate-*` Up (không đụng). Không compose, không seed, không chạm DB `sso-idp`.

## Lệnh đã chạy + output thực tế

Chạy tuần tự từ `E:\projects\self\veyrigate`, Git Bash:

1. `pnpm -C be typecheck` ⇒ exit 0. `pnpm -C be lint` lần 1 ⇒ 1 lỗi prettier ở `admin-api.int-spec.ts:2306` (ca x3 tester vừa thêm) ⇒ `npx prettier --write test/admin-api.int-spec.ts` ⇒ lint exit 0, typecheck exit 0. `git diff --stat` file test: chỉ có insertion (+213), không đổi EOL.
2. `pnpm -C be test` ⇒ `Test Suites: 41 passed`, `Tests: 684 passed, 684 total`.
3. Chạy riêng `pnpm test:int -- admin-api` (12 suite khớp pattern) ⇒ `Tests: 340 passed, 340 total` (335 senior + 5 ca mới).
4. Mutation thêm của tester (backup `admin-clients.controller.ts` ra scratchpad, restore bằng `cp`; `git diff | sha256sum` trước = sau = `4985c35d…a999`):
   - M7: so scope không phân biệt hoa thường (`dto.scopes.map(toLowerCase)`) ⇒ `pnpm test:int -- admin-api.int-spec`: `1 failed, 76 passed`; ca đỏ: **(x3)**.
   - M8: bỏ qua quy tắc scopes khi body có `allowedResources` (đảo thứ tự) ⇒ `1 failed, 76 passed`; ca đỏ: **(x5)**.
5. `pnpm -C be test:int` FULL ⇒ `Test Suites: 57 passed, 57 total`, `Tests: 1516 passed, 1516 total`, `Time: 534.243 s`, exit 0. Đếm `vg-int-*` bằng `docker exec vg-test-mongo mongosh` trước/sau: 4 / 4.
6. `pnpm -C fe-admin test` ⇒ `Test Files 67 passed (67)`, `Tests 1567 passed (1567)`.
7. `pnpm -C e2e e2e` ⇒ `37 passed (4.2m)`, exit 0.
8. `pnpm -C e2e e2e:x3` ⇒ `42 passed (9.3m)`, exit 0.

## Test FAIL

Không có.

### Ghi chú flake `mailer.int-spec`
- Lần chạy của backend-dev (run 76) có 1 fail `Greeting never received`, chạy lại xanh; lần FULL này xanh. Trong runs 70–76 chỉ ghi nhận **1 lần** ⇒ chưa đủ ngưỡng ≥2 ⇒ **không** mở debt test-infra.
- Quan sát hỗ trợ điều tra nếu lặp lại: ngoài Docker (`com.docker.backend`, `0.0.0.0:1025`/`[::]:1025`), `wslrelay.exe` cũng LISTENING `127.0.0.1:1025` và `[::1]:1025` (bind cụ thể thắng wildcard). Test dùng `smtp://localhost:1025`, nên kết nối có thể đi qua relay WSL thay vì thẳng tới Mailpit — ứng viên cho "Greeting never received" không ổn định. Chưa kiểm chứng.

## Thay đổi của tester
- `be/test/admin-api.int-spec.ts` (describe run 76):
  - (c2) đọc lại DB: `allowedResources` = `['api', 'admin']` (đổi thứ tự để chứng minh ghi thật, vẫn giữ `admin`) — nit senior.
  - (race) thêm comment: hồi quy, không phải bằng chứng concurrency DB; guard chỉ đọc body + token nên tất định — nit senior.
  - Ca mới: (x1) token do BFF_B (tenant B, tenant_admin B) PATCH BFF_A với 3 body khoá (`scopes`, `allowedResources: []`, `disabled`) ⇒ 404 `{error:'not_found'}`, BFF_A không đổi; (x2) giữ đúng tập scope của token (đảo thứ tự) + `allowedResources: ['admin']` + 2 grant (đảo thứ tự) ⇒ 200 và DB khớp; (x3) `ADMIN.WRITE` không thay được `admin.write` ⇒ 409; (x4) body trộn trường vô hại (`allowedCorsOrigins`) + trường khoá ⇒ 409, không ghi phần vô hại, không audit; (x5) nhiều vi phạm cùng lúc ⇒ quy tắc scopes thắng, rồi resources thắng grants.
- `docs/agile/sso-idp/runbook-ops.md` §7 Cách 2: thêm 3 dòng — lệnh `$set` đi vòng qua `validateConfig`, phải chép nguyên giá trị từ cấu hình BFF đang chạy hoặc document trong backup gần nhất (§4), không gõ tay, người thứ hai đối chiếu (nit senior). Sửa bằng Python `newline=''` + `str.replace`, số dòng 379 → 382.

## Coverage acceptance criteria (tasks.md F2)
- [x] (s1)(s2)(s3) bỏ `admin.write` / `openid` / `offline_access` ⇒ 409 + thông điệp 1, DB và audit không đổi — các it `(s1)`–`(s3)`
- [x] (r1) `allowedResources: ['api']` ⇒ 409, không revoke credential; (r2) `[]` ⇒ 409 — `(r1)`, `(r2)`
- [x] (g1)(g2) ⇒ 409; (g3) không `offline_access` + chỉ `authorization_code` ⇒ 200 — `(g1)`–`(g3)`
- [x] Mỗi ca 409: body `{error:'conflict', error_description:<cố định>}` (`toEqual`), re-read document `toEqual(snap)`, số audit `ADMIN_CLIENT_UPDATED` không đổi — helper `expectLocked`
- [x] (c1)–(c4) ca điều khiển 200; c2 nay đọc lại DB — `(c1)`–`(c4)`
- [x] (t1) tenant_admin: body khoá ⇒ 409 trước 403; body vô hại ⇒ 403 — `(t1)`
- [x] (race) 200 + 409, scope token còn đủ — `(race)`
- [x] Tự disable 409 giữ xanh — `disabling the client that issued the admin token => 409, nothing changes`
- [x] Unit guard 3 nhánh + `adminResourceIds()` trả `[]` ⇒ throw — `be/src/modules/admin/admin.spec.ts` (trong 684/684)
- [x] Mutation M1–M6 ⇒ RED (backend-dev, log.md); tester thêm M7/M8 ⇒ RED (bước 4)
- [x] DEBT-513: `ADMIN_ROLE_VALUES` dùng ở `tenant-context.ts` + `admin-users.controller.ts`; không đổi hành vi — typecheck + unit + int full xanh
- [x] Task 3 docs: spec §7 quy tắc 6, security-matrix, runbook-ops §7, backlog đóng DEBT-513/515 (đã đọc diff)
- [x] F5: fe-admin 1567, E2E 37, X3 42 giữ nguyên

## Coverage security invariants / risk matrix
| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | super_admin, tenant_admin cùng tenant, tenant_admin tenant khác | (s*), (t1), (x1) |
| Credential | token do chính client console phát hành / do client admin-capable khác phát hành | (s*)…, (c4), (x1) |
| Authorization | own client vs client khác cùng tenant vs cross-tenant (404 như id ngẫu nhiên, không lộ guard) | (c4), (x1), DEBT-136 test cũ |
| Input | thiếu từng scope, hoa/thường, đảo thứ tự, mảng rỗng, trộn trường vô hại + trường khoá, nhiều vi phạm | (s*), (x2)–(x5), (r2) |
| State | 2 PATCH đồng thời (guard thuần ⇒ tất định) | (race) |
| Dependency | `adminResourceIds()` rỗng ⇒ throw (5xx fail-closed) | unit `admin.spec.ts` |
| Exposure | thông điệp cố định so `toEqual`, không audit khi từ chối, không ghi DB | `expectLocked` |

Không chiều nào là security invariant còn PENDING. Ngoài phạm vi đã ghi nợ: redirect URI / secret version của console (DEBT-517, tech-lead).
