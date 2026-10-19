# Test Report — 2026-10-19 (run 31 admin-hardening, tester lượt 1)

## Kết quả: PASS (BE unit 271/271, BE int 730/730 — 34 suite, FE 240/240, E2E 12/12)

Phạm vi: thay đổi chưa commit kể từ `b3d5cab` trong `be/` (Task 1 invariant `aud=admin` 5 chốt, Task 3 PATCH `disabled:true` đi một mình + audit `admin_grant_aborted`, Task 2 seed `createIndexes` + `admin` `$setOnInsert`/từ chối re-point). Không có test FAIL; không lỗi gán [BE]. Không chạy seed trên DB dev, không đụng `be/.env`/`be/keys`, không compose up/FLUSH/drop `aegate-*`.

## Test mới (tester)

1. `be/test/admin-capable-matrix.int-spec.ts` (mới, 10 test): ma trận 9 shape client (đúng bảng unit `isAdminCapableClient`) × 4 chốt trên đường HTTP thật (`app.inject`): `/authorize resource=admin`, `/token` code exchange, `/token` refresh (2 lần), `GET /admin/me` (`AdminTokenGuard`, AT `aud=admin` cấp lúc còn capable). Client xác thực bằng đúng method của shape đang lưu, nên `{public, client_secret_basic}` và `{<thiếu type>, client_secret_basic}` QUA được client auth và phải bị invariant chặn (dev chỉ phủ `{public,none}`/`{confidential,none}` ở HTTP). Capable (`basic`/`post`): `/authorize` ⇒ `/login`, exchange 200 và AT nhận được qua HTTP dùng được ở `/admin/me` (200), refresh 200, guard 200. Không capable: `/authorize` 302 về RP `error=invalid_target` không `code`; exchange 400 `invalid_target` (auth OK) hoặc 401 `invalid_client` (method lạ/thiếu); refresh ×2 ⇒ 400 `invalid_grant`/401, RT không bị revoke, family không rotate (1 document), **0 audit `TOKEN_REUSE_DETECTED` mới**; guard 401 `invalid_token` + `WWW-Authenticate`.
   + test 10: reuse THẬT vẫn báo động sau khi client lệch — RT rotate lúc capable, client đổi `{public,none}`, replay parent đã rotate ⇒ 400 `invalid_grant`, `TOKEN_REUSE_DETECTED` +1, cả family (2 doc) bị revoke (bộ lọc admin ở pre-check không làm câm reuse detection; `classifyMiss` không lọc theo resource).
2. `be/test/seed-risk.int-spec.ts` thêm 1 test (DEBT-178): DB `autoIndex:false` rỗng ⇒ `seedBootstrap` ⇒ với MỌI model trong `MODELS`, MỌI `schema.indexes()` có trong `listIndexes()` (unique đúng `unique:true`; collection chưa tồn tại ⇒ coi như 0 index); nêu tên các unique mà upsert của seed dựa vào: `users.email`, `clients.clientId`, `tenants.id`, `resources.identifier`, `usertenants(userId,tenantId)`, `clientcredentials(clientId,version)`.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit` — không lỗi |
| 2 | `pnpm -C be lint` | `eslint src test` — không lỗi/cảnh báo |
| 3 | `pnpm -C be test` | `Test Suites: 24 passed, 24 total` / `Tests: 271 passed, 271 total` |
| 4 | `pnpm -C be test:int` (vg-test-mongo@27117, vg-test-redis@6479 đang chạy) | `Test Suites: 34 passed, 34 total` / `Tests: 730 passed, 730 total` (719 của dev + 10 matrix + 1 DEBT-178). Trong đó `DEBT-176: 0/10 rounds with a duplicated document` |
| 5 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)` / `Tests 240 passed (240)` |
| 6 | `pnpm -C e2e e2e` (1 lần; :5173/:4000/:3000 trống trước khi chạy, không phải dừng process nào) | `12 passed (44.1s)`; sau khi chạy không còn listener trên các cổng đó |
| 7 | `test:int -- admin-capable-matrix` (riêng, xanh) | `Tests: 10 passed, 10 total` |
| 8 | jest `--testPathPatterns seed-risk.int -t DEBT-178` (riêng, xanh) | `1 passed, 7 skipped` |
| 9 | Repro DEBT-178 bằng 2 tiến trình CLI thật — xem case 9 | bản thật 0/10 + 0/20 vòng nhân đôi; mutant 5/10 |

### Case 9 — race 2 tiến trình `db:seed` thật (DEBT-178)
- Build: `pnpm exec tsc -p tsconfig.build.json --outDir <scratchpad>/qa-dist` (KHÔNG đụng `be/dist`). Driver `<scratchpad>/qa-seed-race.cjs`: mỗi vòng `dropDatabase` DB `vg-int-seedcli-<ts>` trên vg-test-mongo (chưa từng sync index), spawn đồng thời 2 `node qa-dist/database/seed.js`, `cwd` = thư mục trống, env tường minh (NODE_ENV=test, MONGO_URI DB tạm, giá trị test giả; không nạp `be/.env`), stdout KHÔNG in (chỉ ghi có/không dòng secret), đếm document. DB tạm drop trong `finally` (đã kiểm: không còn `vg-int-seedcli-*`).
- Bản thật: `SUMMARY: 0/10 rounds with a duplicated document`, chạy thêm `SUMMARY: 0/20 …`; mỗi vòng `exit=[0,0]`, `usersEmailUnique=true`, counts `tenants 1, resources 3, users 1, usertenants 1, clients 2`, `clientcredentials 2` (cả 2 tiến trình in secret — DEBT-164, chấp nhận theo fold).
- Mutant (bản sao build, xoá `await m.createIndexes()` trong `seed.js`): `SUMMARY: 5/10` — vd. vòng 4 `resources 5, clients 4` (2 `admin`, 2 `fe-admin`), vòng 7 `usertenants 2`; `usersEmailUnique=false`. ⇒ tái hiện được lỗi cũ và xác nhận bản thật hết nhân đôi.

### Mutation (sao lưu `cp` vào scratchpad, khôi phục `cp` + `sha256sum -c` ⇒ `OK` cả 3 file; không git checkout/restore)
| Mutation | Test | Kết quả |
|---|---|---|
| M1 `seed.ts`: bỏ `await m.createIndexes()` | DEBT-178 `listIndexes` | RED 3/3 lần chạy (26 index thiếu, liệt kê theo model) |
| M2 `isAdminCapableClient` chỉ kiểm `clientType` | matrix | RED 3/10 (`{conf,none}`, `{conf}`, `{conf,private_key_jwt}`) |
| M3 `isAdminCapableClient` chỉ kiểm method (bỏ `clientType`) | matrix | RED 2/10 (`{public,basic}`, `{<no type>,basic}`) — mutation này dev KHÔNG có test HTTP bắt |
| M4 `AdminTokenGuard`: bỏ nhánh `isAdminCapableClient(seen.client)` | matrix | RED 7/10 (mọi shape không capable) |

## Test FAIL
(không có)

## Coverage acceptance criteria (fold tech-lead)
- [x] T1(a) client `{confidential,none}` + admin: `/authorize` ⇒ `invalid_target`; code ⇒ 400 `invalid_target`; refresh ⇒ 400 `invalid_grant`, không burn — `admin-public-client` (dev, cả `{public,none}`) + matrix (tester, 9 shape).
- [x] T1(b) AT `aud=admin` cũ, client đổi DB ⇒ `/admin/me` 401 `invalid_token` — `admin-public-client` "AdminTokenGuard…" + matrix chốt 4 (7 shape không capable).
- [x] T1(c) control `client_secret_basic`/`client_secret_post` không hồi quy — matrix hàng 1–2 (end-to-end exchange ⇒ `/admin/me` 200), `admin.int-spec`.
- [x] T1 mutation từng chốt / predicate — dev 6/6 + tester M2/M3/M4.
- [x] T2(a) 2 seed song song DB chưa index — `seed-risk` race 10 vòng (smoke) + case 9 CLI thật 0/30 (mutant 5/10) + DEBT-178 `listIndexes` (tất định).
- [x] T2(b) dữ liệu trùng email ⇒ throw trước ghi, không echo email — `seed-risk` "data already duplicated".
- [x] T2(c) `admin` identifier khác / ISSUER cũ, chỉ fe-admin tham chiếu ⇒ refused, identifier không đổi — `seed.int-spec` (309, 322, 329), `seed-risk` ISSUER change.
- [x] T2(d) chạy lại cùng ISSUER idempotent, scopes không reset — `seed.int-spec` 347.
- [x] T3(a) `{disabled:true, …}` ⇒ 400, DB không đổi, 0 audit — `admin-api` DEBT-167.
- [x] T3(b) 409 disable∥enable ⇒ không field nào đổi, audit đúng — `admin-api` DEBT-161 (15 vòng).
- [x] T3(c)(d)(e) abort sau revoke lượt 1 (404 / throw) + lượt 2 throw ⇒ audit `CLIENT_SECRET_REVOKED{admin_grant_aborted,count}` + `ADMIN_CLIENT_UPDATED failure` — `admin-api` DEBT-170 ×3 + "2nd revoke fails".

## Coverage security invariants / risk matrix
- [x] **Identity/Credential**: client capable vs 7 shape không capable; credential: basic, post, none(PKCE), method lạ/thiếu ⇒ `invalid_client` — matrix.
- [x] **Authorization (wrong audience)**: `aud=admin` bị từ chối ở cả 4 điểm phát hành + điểm dùng theo DB HIỆN TẠI; client qua được client auth (`{public,basic}`) vẫn bị chặn — matrix.
- [x] **State/retry**: refresh admin lặp 2 lần cho client lệch ⇒ không rotate, không burn, không `TOKEN_REUSE_DETECTED` giả; replay thật vẫn báo động + revoke family — matrix.
- [x] **State/concurrent**: 2 tiến trình `db:seed` thật trên DB chưa sync ⇒ 0 nhân đôi /30 vòng; disable∥enable 409 không kèm ghi (dev).
- [x] **Dependency/failure**: lỗi DB sau revoke lượt 1 ⇒ 5xx + audit best-effort (dev); `createIndexes` lỗi ⇒ throw trước ghi (dev).
- [x] **Exposure**: guard trả cùng 401 `invalid_token` cho mọi shape (không oracle); lỗi seed không echo email (dev); repro CLI không in secret ra log/report.

## Ghi chú / debt
- Đóng **DEBT-178** (test tất định `listIndexes` + repro CLI).
- Mở **DEBT-181** 🟡 [BE][test]: thứ tự "index TRƯỚC mọi ghi" chỉ được repro CLI (scratch) bảo vệ; mutation dời `createIndexes` xuống cuối seed sẽ không bị suite tự động bắt.
- Quan sát (không mở debt): DB `vg-int-demo-*` còn sót trên vg-test-mongo sau `test:int` (có từ trước run này, không phải DB của tester).
