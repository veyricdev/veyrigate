# Test Report — 2026-11-06 (run 69, tester)

## Kết quả: PASS (probe độc lập 10/10; int 1436/1436; unit be 630/630; fe-admin 1533/1533; E2E 36/36)

## Lệnh đã chạy + output thực tế

1. Preflight: `codegraph sync` ⇒ Done. Cổng :4000/:5173/:3000 trống (netstat) trước E2E. `vg-int-*` trước = 4 (4 DB `vg-int-vault-v7-*` cũ).
2. Probe tester (tạm, không giữ trong repo): `be/test/run69-tester.int-spec.ts` (bản lưu: `C:\Users\ADMIN\AppData\Local\Temp\claude\ff7ffefc063065c2\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\run69-tester.int-spec.ts`) — app THẬT (`bootFullApp` = `AppModule` + `configureApp`) `listen(0)` + `fetch` qua socket thật; admin AT lấy qua flow thật (session → `/authorize` → `/token`). DB `vg-int-r69t-<ts>` tự tạo, drop khi đóng.
   `pnpm test:int "run69-tester[.]"` ⇒ `Tests: 10 passed, 10 total` (41,9 s). Tally (số 200 mỗi vòng): `{"dd":[1×10],"ll":[1×10],"ld":[1×10],"c3":[2×10],"m3":[2×10]}`.
3. Mutation (backup ngay trước, restore bằng cp, so sha256 file/`git diff` = trước mutate):
   - M-touch: bỏ `updateMany $inc superAdminGuard` trong `SuperAdminGuard.assertSurvivors` ⇒ 5/5 test race **RED** (`Expected: >= 1, Received: 0` — còn 0 super_admin), 5 test khác xanh. Restore: sha256 `fd04606f…b40a` trước = sau.
   - M-214: nhánh `isCovered` sai trả `null` thay `'consent_revoked'` (`token.controller.ts`) + M-415: điều kiện `identifiersFor(...).includes` thay bằng luôn-đúng (`refresh-token.service.ts`) ⇒ 3/3 test 415/214 **RED**. Restore: sha256 `git diff` hai file trước = sau (`9258e21f…`, `5bcea18e…`). (Lần thử đầu dùng `false &&`/`true ||` không biên dịch được ⇒ 0 test chạy, đã restore và làm lại.)
4. `pnpm -C be test:int` (full, không có probe) ⇒ `Test Suites: 53 passed`, `Tests: 1436 passed, 1436 total` (500,5 s), exit 0. `vg-int-*` sau = 4 (**+0**).
5. `pnpm -C be test` ⇒ `Test Suites: 39 passed`, `Tests: 630 passed, 630 total`.
6. `pnpm -C fe-admin test` ⇒ `Test Files 66 passed`, `Tests 1533 passed (1533)`.
7. `pnpm -C be typecheck` / `lint`, `pnpm -C fe-admin typecheck` / `lint` ⇒ sạch (exit 0, không lỗi).
8. `pnpm -C e2e e2e` ⇒ `36 passed (4.0m)`, exit 0; cổng trống lại sau khi chạy.

## Test FAIL

Không có.

## Coverage acceptance criteria

- [x] DEBT-142 (Task 1) — probe: demote∥demote, lock∥lock, lock∥demote mỗi ca 10 vòng qua HTTP thật: đúng 1×200 + 1×409, body 409 = `{"error":"conflict","error_description":"at least one active super_admin must remain"}` (không id/tenant), còn đúng 1 super_admin active không khoá, số audit `last_super_admin` = số 409, `metadata` rỗng, không chứa AT; người thắng vẫn dùng được AT trên `/admin/me` (lock∥lock). 3 super_admin: 3 demote vòng tròn đồng thời ×10 ⇒ luôn 2 thắng/1 409, còn 1 = 3 − số thắng; lock/demote/lock trộn ×10 ⇒ còn ≥ 1 (=1). Cross-tenant: super_admin tenant X khoá user là super_admin duy nhất của tenant Y ⇒ 409, audit `tenantId`=X không chứa tên tenant Y; super_admin tenant khác PATCH roles ⇒ 404. GET user không lộ `superAdminGuard`.
- [x] DEBT-149 (Task 2) — target `['member','super_admin','viewer']` PATCH `['tenant_admin']` ⇒ response + DB `['member','viewer','tenant_admin']` (giữ thứ tự), audit `{addedRoles:'tenant_admin', removedRoles:'super_admin'}`; PATCH lặp cùng vai trò ⇒ không thêm audit; `['member']`, `['$roles']`, `[{$literal}]`, trùng lặp ⇒ 400, DB không đổi; membership không có field `roles` ⇒ `['tenant_admin']`.
- [x] DEBT-415 (Task 3) — family 2 thế hệ, gỡ `api` (giữ `admin`) ⇒ refresh 400 `invalid_grant`, body/`content-type`/`cache-control` **giống hệt** RT rác; cả 2 doc `revokedAt`+`familyRevokedAt`; 1 audit `resource_not_allowed` không chứa RT/hash; 0 `TOKEN_REUSE_DETECTED`. Thêm lại resource ⇒ RT hiện hành (×2) và thế hệ cũ đều `invalid_grant`, 0 doc active; flow mới vẫn refresh 200. 5 refresh đồng thời sau khi gỡ ⇒ tất cả `invalid_grant`, family chết, không reuse alert.
- [x] DEBT-214 (Task 4) — đổi env thật (`CONSENT_POLICY_VERSION=2`, restart app cùng DB) ⇒ refresh `invalid_grant` (body giống RT rác), family 0 doc active, 1 audit `consent_revoked`, retry ⇒ `invalid_grant` không reuse alert; `CONSENT_TERMS_VERSION=2` ⇒ tương tự cho family khác; quay về 1/1 ⇒ cả hai family vẫn chết (đã revoke, không chỉ từ chối); consent mới ở 2/2 ⇒ code grant + 2 refresh liên tiếp 200.
- [x] Regression — int 1436 (+0 DB), be 630, fe-admin 1533, typecheck/lint be + fe-admin, E2E 36.

## Coverage security invariants / risk matrix

- [x] Identity/Authorization: 2–3 super_admin cùng tenant; super_admin tenant khác (404 PATCH, 409 lock khi target là super_admin cuối ở tenant kia); tenant_admin (dev test). 
- [x] State/concurrency: race thật qua socket (2 và 3 request đồng thời), replay RT sau revoke, 5 refresh đồng thời, restart app với config mới.
- [x] Input: vai trò ngoài enum / payload toán tử Mongo ⇒ 400; membership thiếu `roles`.
- [x] Dependency: fail-closed khi lỗi DB trong guard — dev test (`fail-closed: a DB fault inside the guard`) xanh trong int full; nhánh fail-closed 415 đã có DEBT-489 (không chặn: không dẫn tới bypass — revoke lỗi ⇒ 5xx).
- [x] Exposure: body 409 cố định; audit không metadata đếm, không AT/RT/hash; `invalid_grant` của 415/214 không phân biệt được với RT rác (status, body, content-type, cache-control); `superAdminGuard` không ra response.
- Mutation chính của guard (bỏ touch) ⇒ race thua (còn 0 super_admin) — chứng minh test bắt được write skew.

## Ghi chú

- Cảnh báo mongoose `new` deprecated đến từ `refresh-token.service.ts:399` `{ new: false }` có từ trước run 69 (không thuộc diff), không ảnh hưởng kết quả.
- Không debt mới.
