# Test Report — 2026-10-16 — run 26 (B6.1 + B6.2 + DEBT-098/105/106)

## Kết quả: PASS

BE unit 220/220 · BE int 554/554 (25 suites, +12 test tester) · fe-sso-test 240/240 · E2E 12/12 (sau khi sửa race trong test, xem case 7) · typecheck/lint sạch · app không khởi động khi thiếu `NODE_ENV`.

Không có lỗi [BE]. Có 1 lỗi ở **test E2E** (race điều kiện chờ trong `e2e/tests/lab.spec.ts`, có từ run 25), tester đã sửa trong test, không đụng code sản phẩm.

## Lệnh đã chạy + output thực tế

Hạ tầng: `vg-test-mongo`@27117, `vg-test-redis`@6479 đang chạy sẵn. Không `compose up`, không FLUSH/drop `aegate-*`. Cổng 4000/5173 trống trước mỗi lần E2E và sau khi xong.

| # | Lệnh | Output thực tế |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit`, exit 0 (chạy cả trước và sau khi thêm test) |
| 2 | `pnpm -C be lint` | `eslint src test`, exit 0 (trước và sau khi thêm test) |
| 3 | `pnpm -C be test` | `Test Suites: 22 passed` · `Tests: 220 passed, 220 total` |
| 4 | `pnpm -C be test:int` (lần 1, code dev) | `Test Suites: 25 passed` · `Tests: 542 passed, 542 total` |
| 5 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)` · `Tests 240 passed (240)` |
| 6 | `pnpm -C be test:int -- admin.int-spec` (sau khi thêm test) | `Tests: 42 passed, 42 total` (30 của dev + 12 của tester) |
| 7 | `pnpm -C e2e e2e` lần 1 và lần 2 | `1 failed, 11 passed`: `lab.spec.ts:10` "redirect_uri mismatch ⇒ IdP 400" `Expected: "4000" Received: "5173"`. Xem mục Test FAIL |
| 8 | `pnpm -C e2e e2e` (sau khi sửa test) ×2 | `12 passed (43.7s)` và `12 passed (44.3s)`. `pnpm -C e2e typecheck` exit 0 |
| 9 | jest `--testRegex seed-dev.int-spec -t "fix: syncAllIndexes"` (DEBT-106 chạy riêng) | `Tests: 24 skipped, 1 passed, 25 total` |
| 10 | jest `--testRegex refresh-token.int-spec -t "DEBT-105"` | `Tests: 52 skipped, 2 passed, 54 total` |
| 11 | `pnpm -C be test:int` (lần 2, full, có test tester) | `Test Suites: 25 passed` · `Tests: 554 passed, 554 total` |
| 12 | `pnpm -C be build`, rồi chạy `node be/dist/main.js` từ thư mục trống (không có `.env`), nạp env từ `be/.env` nhưng `unset NODE_ENV`, `PORT=4999` | `EXIT=1`, log `Error: Invalid environment variables: - NODE_ENV: Invalid option: expected one of "development"\|"test"\|"production"`. Không có process nghe ở :4999 |
| 13 | Như case 12 nhưng `NODE_ENV=` (rỗng) | `EXIT=1`, cùng message nêu `NODE_ENV` |

Ghi chú: `pnpm <script> -- -t ...` không truyền `-t` vào jest (pnpm chuyển `--` nguyên văn), nên case 9/10 gọi jest trực tiếp với cùng cờ như script `test:int`. File log tạm của case 12/13 đã xoá. Không in token hay password.

## Test FAIL (nếu có)

- **Case 7, `e2e/tests/lab.spec.ts:10`** (test có từ run 25, không phải [BE]).
  - Kỳ vọng: sau 400 của `/authorize`, URL trang nằm ở cổng 4000.
  - Thực tế: `page.url()` vẫn là `5173`. Snapshot lúc fail đã hiện trang lỗi IdP ("Invalid request"), tức BE trả 400 đúng và không redirect về RP.
  - Nguyên nhân: race trong test. `waitForResponse` resolve khi có header phản hồi, trước khi document 400 được commit. Còn `waitForLoadState("load")` thỏa ngay vì trang `/lab` cũ đã load xong. Lỗi tái hiện 2/2 lần.
  - Sửa (chỉ trong test, theo nguyên tắc chờ theo điều kiện): `await expect(page).toHaveURL(u => u.port === BE_PORT && u.pathname === "/authorize")` cộng với assert heading `Invalid request` visible. Sau khi sửa: 12/12 qua 2 lần full run.

## Coverage acceptance criteria

Task 1 — B6.1 admin guard (INV-24), `be/test/admin.int-spec.ts`:
- [x] Luồng thật `/authorize`→`/token` ⇒ 200 `{sub, tenantId:A, roles}`, không `sid`, `no-store`, không CORS ("real /authorize -> /token flow")
- [x] Token `aud=demo` ⇒ 401; ID token ⇒ 401; thiếu `sid` ⇒ 401; client bỏ `admin` khỏi allowedResources ⇒ 401
- [x] Thiếu `admin.read` ⇒ 403 `insufficient_scope` + `WWW-Authenticate scope`
- [x] Member không vai trò ⇒ 403 `forbidden`; membership `suspended` ⇒ 403; tenant_admin B qua client A ⇒ 403; non-member không phân biệt được với member không vai trò
- [x] `?tenantId=B`, header `X-Tenant-Id`, body `tenantId` bị bỏ qua (vẫn trả A)
- [x] Logout (tombstone) ⇒ cùng token 401
- [x] Mongo/Redis lỗi ⇒ 5xx (3 test fail-closed)
- [x] Mutation ⇒ RED: dev và senior đã chạy (log.md). Tester không lặp lại, chỉ thêm negative test độc lập ở mục dưới

Task 2 — B6.2 step-up (INV-26):
- [x] Unit `admin-guards.spec.ts` (6 test): biên 5' / 5'+1s, thiếu/chuỗi/số lẻ/NaN, tương lai +30s qua / +31s chặn, clock inject, lỗi B6.1 ưu tiên
- [x] Int: `auth_time` mới ⇒ 200; biên; thiếu/không nguyên; tương lai; token từ refresh ⇒ 403 `step_up_required`
- [x] (a) full chain: phiên cũ ⇒ 403 ⇒ `prompt=login&max_age=0` ⇒ `GET /login` 200 form ⇒ `POST /login` (session rotate) ⇒ resume ⇒ code ⇒ `auth_time` mới ⇒ 201
- [x] (b) gọi thẳng `/authorize?request_id` ⇒ `login_required`, không code, single-use; không phiên ⇒ `login_required`
- [x] (c) context không có `reauthAfter` ⇒ `GET /login` vẫn 302 `/`; Redis lỗi khi peek ⇒ 302 `/`
- [x] (d) refresh grant ⇒ 403
- [x] Bypass qua `POST /authorize/consent` (🔴 senior lượt 1) ⇒ `login_required`, không consent, không code; `authorize.int-spec.ts` cover kind sai cửa ở cả 2 phía
- [x] `max_age` > 0 quá hạn ⇒ form login

Task 3 — DEBT-098:
- [x] Unit `validation.schema.spec.ts`: thiếu / rỗng / không hợp lệ ⇒ throw nêu `NODE_ENV`
- [x] Boot thật `dist/main.js` thiếu/rỗng `NODE_ENV` ⇒ exit 1, message nêu `NODE_ENV` (case 12, 13)
- [x] `seed-dev.int-spec.ts` "DEBT-098: NODE_ENV unset / empty / unknown is refused" (không ghi DB)
- [x] Jest/int/E2E vẫn xanh (`e2e/config/env.ts` set `NODE_ENV: "test"` tường minh)

Task 4 — DEBT-105/106:
- [x] DEBT-105: spy `identifiersFor` = 1 lần/refresh; `rotate()` gọi trực tiếp vẫn tự tính (case 10)
- [x] DEBT-106: test "fix: syncAllIndexes" chạy riêng bằng `-t` xanh (case 9)

Hồi quy: `authorize.int-spec.ts`, `ui.int-spec.ts`, `refresh-token.int-spec.ts` xanh trong full int. E2E login/consent/lab 12/12.

## Coverage security invariants / risk matrix

Tester thêm 12 test vào `be/test/admin.int-spec.ts`, describe `tester risk matrix (run 26)`. Tất cả PASS lần đầu (case 6).

| Chiều | Trường hợp | Test |
|---|---|---|
| Credential | expired | "credential: expired admin token => 401" |
| Credential | malformed/tampered (đổi `sub`, giữ chữ ký) | "payload tampered" ⇒ 401 |
| Credential | khoá lạ (cùng iss/aud/typ) | "token signed by a foreign key" ⇒ 401 |
| Credential | token ở query string / scheme `Basic` | "token only in query string / non-Bearer" ⇒ 401 |
| Identity | user bị xoá sau khi phát token | "user deleted after issuance" ⇒ 401 |
| Authorization | wrong scope: chỉ `admin.write` trên GET ⇒ 403 `scope="admin.read"`; chỉ `admin.read` trên route write (kể cả `auth_time` mới) ⇒ 403 trước step-up | 2 test "scope:" |
| Authorization | scope lookalike `admin.readx` / `admin` / `xadmin.read` | ⇒ 403 `insufficient_scope` |
| Authorization (cross-tenant) | positive control: tenant_admin B qua client B ⇒ 200 tenant B (cùng user bị 403 qua client A) | "tenant positive control" |
| Exposure | body 401/403 không chứa tenant, sub hay roles | "exposure: 401/403 bodies never echo" |
| State/concurrency | sau re-login, 5 resume song song cùng `request_id` ⇒ đúng 1 code, 4 lần 400 | "concurrency: ... exactly one code" |
| Request chain | cookie phiên cũ sau re-login (đã rotate) ⇒ `/authorize` kế tiếp không có code | "request chain: old cookie ..." |
| Dependency | Mongo/Redis lỗi ⇒ 5xx; peek Redis lỗi ⇒ 302 `/` | test của dev (đã đọc và chạy) |
| Replay | context single-use (resume/consent lần 2 ⇒ 400) | test của dev |

INV-24 (tenant từ client phát hành + `UserTenant`, không từ request), INV-26 (re-auth thật qua cả 2 cửa, `auth_time` gate): có bằng chứng ở trên, không có invariant nào thiếu bằng chứng.

Rủi ro không chặn, đã có debt: DEBT-117 (sau step-up không so `sub`, nên re-login bằng user khác vẫn cấp code cho user mới), DEBT-121/123 (context gắn phiên). Không mở debt mới.

## File tester thay đổi

- `be/test/admin.int-spec.ts`: thêm describe `tester risk matrix (run 26)` (12 test).
- `e2e/tests/lab.spec.ts`: sửa race điều kiện chờ (case 7).
