# Test Report — 2026-10-23 — run 47 (A6.3 Users & sessions + DEBT-326/328 + Task 0 BE)

## Kết quả: PASS [FE + BE]

- fe-admin: **1019/1019** test xanh, 39 file. Trong đó 998 test có sẵn và **21 test rủi ro mới** trong `fe-admin/test/users-risk.test.tsx`.
- Root `pnpm test`: fe-sso-test 269, fe-admin 1019, be 414.
  - Lần 1 đỏ 1 test, do flake đã biết (DEBT-333): `check-bundle.test.ts` timeout 5000ms khi 3 package chạy song song, nằm ngoài diff.
  - Lần 2 xanh toàn bộ.
- E2E: **31/31 ×2 liên tiếp** (3.5m mỗi lần).
- Mutation: **3/3 bị giết**, mã nguồn khôi phục byte-identical (sha256 OK).
- DEBT-339: đã xác nhận bằng characterisation, **giữ 🟡**. Không đảo ngược ý định, không lộ PII, không leo thang quyền.
- Không có debt mới.

## Lệnh đã chạy + output thực tế

Tất cả chạy foreground, cwd `E:\projects\self\veyrigate`.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` (trước khi thêm test) | `tsc --noEmit`, exit 0 |
| 2 | `pnpm -C fe-admin lint` (trước khi thêm test) | exit 0 |
| 3 | `pnpm -C fe-admin test` (trước khi thêm test) | `Test Files 38 passed (38)`, `Tests 998 passed (998)` |
| 4 | `pnpm exec vitest run test/users-risk.test.tsx` | Lần đầu: 2 test fail do setup test (viewer có `email` canary trùng text trang; viewer không có vai trò admin bị guard chặn), không phải lỗi sản phẩm; đã sửa setup. Sau đó `Tests 21 passed (21)` |
| 5 | `pnpm -C fe-admin gen:api` + `sha256sum -c` của `schema.d.ts` | exit 0, `schema.d.ts: OK` (không diff so với bản dev commit vào working tree) |
| 6 | `pnpm -C fe-admin typecheck` (sau khi thêm test) | Lần 1 exit 2: 3 import thừa trong file test của tester. Đã xoá, chạy lại exit 0 |
| 7 | `pnpm -C fe-admin lint` (sau khi thêm test) | Lần 1 exit 1 (4 lỗi no-unused-vars, cùng nguyên nhân với #6). Chạy lại exit 0 |
| 8 | `pnpm -C fe-admin test` | `Test Files 39 passed (39)`, `Tests 1019 passed (1019)` |
| 9 | `pnpm -C fe-admin build` | exit 0, `✓ built in 1.06s` |
| 10 | `pnpm -C fe-admin check:bundle` | `check:bundle scanned 20 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| 11 | `pnpm lint` (root) | exit 0 (fe-sso-test, fe-admin, be: Done) |
| 12 | `pnpm -r run typecheck` | exit 0 (fe-sso-test, e2e, be, fe-admin: Done) |
| 13 | `pnpm test` (root) lần 1 | exit 1. fe-sso-test 269/269; fe-admin `1 failed \| 1018 passed`, cụ thể `check-bundle.test.ts > passes a clean client bundle…` `Test timed out in 5000ms`; be `414 passed` |
| 14 | `pnpm test` (root) lần 2 | exit 0. fe-sso-test `269 passed`, fe-admin `1019 passed`, be `Tests: 414 passed, 414 total` |
| 15 | `pnpm audit --audit-level high` | exit 0. `2 vulnerabilities found, Severity: 2 low, 1 ignored: 1 high` (giống run trước) |
| 16 | `netstat` :4000/:5173/:3000 | Cả 3 cổng trống trước mỗi lần chạy E2E |
| 17 | `pnpm -C e2e e2e` lần 1 | exit 0, `31 passed (3.5m)`. Spec `fe-admin-users.spec.ts` ok (7.4s) |
| 18 | `pnpm -C e2e e2e` lần 2 | exit 0, `31 passed (3.5m)`. Spec `fe-admin-users.spec.ts` ok (7.4s) |
| 19 | Grep secret/email trong output E2E (×2) | Xem bảng dưới |
| 20 | Grep secret trong `git diff` và file mới (trừ `.claude/`, `.mcp.json`) | 0 hit cho JWT, private key, `sk_live`, AKIA, `client_secret` literal |

Kết quả grep output E2E (lần 1 / lần 2):

| Mẫu | Số hit |
|---|---|
| `eyJ…` (JWT) | 0 / 0 |
| `e2e-user` | 0 / 0 |
| `%40` | 0 / 0 |
| `email=` | 0 / 0 |
| `e2e-admin-password` / `e2e-user-password` | 0 / 0 |
| `@example.com` | 2 (lần 1) |

- 2 hit `@example.com` là các dòng seed có sẵn từ trước run 47: `seed-dev: upserted user <dev@example.com>` và `seed: ensured super_admin <admin@example.com>`. Đây là fixture, không thuộc diff này.
- User E2E chỉ được log theo id hoặc "unchanged".
- Request `/admin/users` trong log BE không có query: 3 lần `"url":"/admin/users"` (log BE cắt query string).
- Seed hội tụ trên stack thật: cả 2 lần đều có `seed-e2e-admin: admin user unchanged` và `seed-e2e-admin: E2E user unchanged`. Run trước kết thúc bằng unlock nên không có gì để reset.

Không chạy `be test:int`:
- seed đã được xác minh bằng log seed thật ×2 (hội tụ, không đụng admin);
- dev đã chạy 45 suite / 1210 test, gồm 7 case int cho seed (reset lock/suspended/tenant_admin/password, roles-only drift, trùng admin ⇒ throw + DB byte-identical), và mutation của dev bị bắt;
- vì vậy không cần lấy `vg:int-lock`.

## Test FAIL

Không có test sản phẩm nào fail. Flake root `pnpm test` (#13) là DEBT-333 đã ghi từ run 46, nằm ngoài diff: chạy fe-admin riêng thì xanh, root lần 2 cũng xanh.

## Mutation (tester)

Mỗi mutation: backup bằng `cp` + `sha256sum`, khôi phục xong thì `sha256sum -c` cho `OK`.

| # | Mutation | Test bắt |
|---|---|---|
| M1 | Bỏ `key="lock"`/`key="unlock"` (`user-account.tsx`) | "an open Lock dialog never turns into Unlock when a re-read flips the state" ĐỎ |
| M4 | `useUserWrite` chỉ invalidate khi thành công (`onSuccess`), không invalidate khi lỗi/uncertain (`hooks.ts`) | 5 test ĐỎ: lock/unlock uncertain-applied, lock ⇒ Revoke all còn đó, self revoke-all ⇒ 401 ⇒ signInAgain, DEBT-339 characterisation |
| M6 | Bỏ gate `!self` cho Lock | "self (case-insensitive): no Lock…" ĐỎ |

## Coverage acceptance criteria

Nghiệm thu plan A6.3:
- [x] **"Hành động phá huỷ có xác nhận"**: Lock, Unlock, Revoke all, Revoke family, Revoke consent đều đi qua `ConfirmAction`. Cancel/Escape ⇒ không gửi gì (`users-ui` "Cancel / Escape"). Double click ⇒ chỉ gửi 1 lần (`users-ui` lock, families). Sau uncertain, nút ngược chiều vẫn phải xác nhận lại (`users-risk` lock/unlock uncertain-applied). E2E: lock, unlock, revoke family, revoke all qua dialog.
- [x] **"Hiển thị `lockedUntil`"**: sentinel 9999 / ngày gần / quá khứ / null (`users-ui` lockStatus + detail). Thêm `9999-01-01`, `2099-12-31`, near-date dạng ISO nguyên văn (`users-risk` "locked until …"). E2E: "Not locked" ⇒ "Locked by an administrator (until unlocked)" ⇒ "Not locked".

Theo task:
- [x] **Task 0 [BE]**: be unit 414, gồm `admin.spec.ts` (DTO ↔ mapper, 7 `$ref`, 3 op 204 không `content`). `gen:api` không diff. Seed E2E hội tụ trên stack thật ×2.
- [x] **Task 1 (DEBT-326/328)**: 998 test cũ xanh, typecheck/lint 0.
- [x] **Task 2**: `users-fn.test.ts` 51 test. Gồm POST cho `listUsers`, error code, uncertain chỉ áp dụng cho ghi, GET 5xx không uncertain, strip, email không bị log, id không hợp lệ không gọi `fetch`.
- [x] **Task 3**: `users-ui` (list/detail/gate/lock/unlock) và `users-risk`.
- [x] **Task 4**: `users-ui` (families/consents/revoke-all) và `users-risk` (self, paging).
- [x] **Task 5 E2E**: `fe-admin-users.spec.ts` xanh ×2 trong full suite 31/31 ×2.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | self (sub đổi hoa/thường) | `users-ui` "self (case-insensitive)" |
| Identity | tenant_admin tự xem tài khoản admin của mình ⇒ không có Lock/Unlock/Revoke all; family của mình vẫn revoke được và có cảnh báo | `users-risk` |
| Identity | super_admin xem super_admin ⇒ có nút ghi | `users-risk` |
| Authorization | tenant_admin xem tenant_admin/super_admin ⇒ ẩn ghi | `users-ui` |
| Authorization | viewer `["tenant_admin","SUPER_ADMIN"]` (sai hoa/thường) ⇒ ẩn ghi | `users-risk` |
| Authorization | 403 `forbidden` ⇒ thông điệp cố định, không đọc lại | `users-ui` |
| Authorization | BE là điểm thực thi duy nhất; cross-tenant ⇒ 404 | int-test BE run 28, không viết lại |
| Credential / step-up | `step_up_required` ở cả 5 lệnh ghi ⇒ `StepUpAlert`, `fea:stepup` không lưu | `users-ui` |
| Credential / step-up | Mở chi tiết từ list đã lọc email rồi step-up ⇒ `returnTo=/users/<id>`; `sessionStorage` rỗng | `users-risk` |
| Input | id không phải 24 hex, `../x`, 25 hex; familyId `a/b`, `a%2Fb`, 129 ký tự; consentId không hex ⇒ không gọi `fetch`; route id sai ⇒ không gọi `getUser` | `users-fn`, `users-ui` |
| Input | Email 321 ký tự, key lạ, status lạ ⇒ bị từ chối | `users-fn` |
| State: uncertain lock/unlock | Đóng dialog, thông điệp ở ngoài, gửi đúng 1 lần (3 click). Nếu đã áp dụng, đọc lại sẽ đổi nút, và nút ngược chiều mở dialog mới cần xác nhận, không gửi gì | `users-risk` |
| State: dialog mở khi state đổi | Lock đang mở mà đọc lại thấy locked ⇒ dialog Lock biến mất, không biến thành Unlock (M1 bắt) | `users-risk` |
| State: throw (network) | Lock ⇒ uncertain, gửi 1 lần; consent ⇒ DEBT-151 | `users-risk`, `users-ui` |
| State: revoke-all / family uncertain | Giữ dialog (idempotent). Mỗi click gửi đúng 1 lần, không tự gửi lại | `users-ui` |
| State: consent uncertain | Đóng dialog, thông điệp DEBT-151, gửi 1 lần | `users-ui` |
| State: lock uncertain | Nút "Revoke all sessions" vẫn còn để hoàn tất | `users-risk` |
| Request chain: self revoke-all thành công | `signInAgain()`, `returnTo=/users/<id>` | `users-ui` |
| Request chain: self revoke-all uncertain-đã-áp-dụng | Invalidate ⇒ đọc lại nhận `unauthenticated` ⇒ `QueryCache.onError` ⇒ `location.assign(/auth/login?returnTo=/users/<id>)`; không chứa email; gửi 1 lần (M4 bắt) | `users-risk` |
| Dependency | GET 5xx ⇒ `unavailable`, không uncertain. POST/DELETE timeout/5xx/sai schema/2xx khác 204 ⇒ uncertain | `users-fn` |
| Dependency | List lỗi 5xx sau khi lọc ⇒ alert và URL không chứa email | `users-risk` |
| Exposure: email filter | Không vào URL/search/history (`users-ui`) | `users-ui` |
| Exposure: email filter | Không vào `returnTo` khi 401 (`returnTo=/users?status=active`), không vào `sessionStorage`/`localStorage`/cookie | `users-risk` |
| Exposure: email filter | Reload (mount mới cùng URL) ⇒ không còn filter, BE không nhận email | `users-risk` |
| Exposure: email filter | Mở chi tiết ⇒ URL chỉ có id | `users-risk` |
| Exposure: email filter | Log BFF không chứa email (timeout/network/5xx/4xx/sai schema) | `users-fn` |
| Exposure: email filter | Log BE cắt query; E2E grep 0 hit | E2E |
| Exposure: zod strip | `passwordHash`/`failedLoginCount`/`tokenHash`/`sessionRef` bị loại ở list/get/families/consents/lock | `users-fn` "allowlist" |
| Exposure: render | email/clientId/resource là text; không có `a[href^=http\|javascript]` | `users-ui` |
| not_found | Đọc lại sau ghi ⇒ ẩn mọi nút ghi | `users-ui` |
| not_found | Lần tải đầu ⇒ không có nút ghi, families/consents không được đọc | `users-risk` |
| Paging | Families: next/empty "No more families." + First page | `users-ui`, `users-risk` |
| Paging | Consents: next qua state cục bộ, URL không đổi, First page ⇒ về trang đầu | `users-risk` |
| Seed E2E | Idempotent (2 lần "E2E user unchanged" trên stack thật), không đụng admin ("admin user unchanged"), email trùng admin ⇒ throw trước khi ghi | Log E2E + int của dev |

### DEBT-339 — characterisation (`users-risk` "family uncertain but applied")

Đã tái hiện: revoke family trả `uncertain` nhưng thực ra đã áp dụng. Khi đó:
- dialog và hàng bị unmount;
- vùng `role="status"` của section rỗng, thông điệp uncertain mất;
- bảng hiện "Revoked …";
- revoke family được gọi đúng 1 lần, không còn nút Revoke cho family đó.

Đánh giá: không đảo ngược ý định (family đã revoke, không có đường un-revoke), không lộ PII, không leo thang quyền. Vì vậy giữ **🟡** (a11y/thông điệp), không nâng 🔴. Test đang khoá hành vi hiện tại. Khi sửa DEBT-339 thì đổi assertion `status` sang thông điệp mới.

## Ghi chú

- File test mới: `fe-admin/test/users-risk.test.tsx` (ASCII, không BOM). Không sửa code sản phẩm, không cài package, không commit.
- Không đụng `aegate-*` (E2E dùng DB `sso-idp-e2e` qua seed có guard). Không seed dev DB. Không động tới `pnpm dev` (3 cổng đều trống).
