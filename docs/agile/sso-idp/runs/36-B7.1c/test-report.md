# Test Report — 2026-10-20

> Run 36 (B7.1c). Phạm vi: diff chưa commit từ `1e8573c` trong `be/` (refuseGrant/failClosed, `subjectFailure` G1, `resource_not_allowed` ở code grant, `recheckAfterRotate` refresh, re-check sau `establish` ở login/federation, DEBT-211). Đọc code qua CodeGraph (`TokenController`, `RefreshTokenService`, `UserService.recordFailedLogin`), đối chiếu `tasks.md` + Fold G0–G8.

## Kết quả: PASS

BE unit 317/317 · BE int 38 suite **964/964** (953 của dev + 11 test tester mới) · fe-sso-test 240/240 · E2E 16/16 · typecheck + lint sạch. Không có lỗi [BE]. Có 1 lỗi [test] do chính tester viết sai kỳ vọng, đã sửa (xem case 2).

## Lệnh đã chạy + output thực tế

1. `pnpm -C be typecheck`: sạch. `pnpm -C be lint`: lần đầu có 2 lỗi prettier ở test tester mới. Chạy `npx prettier --write` cho 2 file test, sau đó sạch.
2. `pnpm -C be test:int -- token-code-recheck federation.int` (lần 1): `Tests: 2 failed, 126 passed, 128 total`. Hai case `tester DEBT-215 pin` FAIL vì kỳ vọng `toEqual({ error: 'invalid_grant' })`, trong khi body thật còn có `error_description` chuẩn. Đây là lỗi [test] (không phải sản phẩm): body này giống hệt mọi `invalid_grant` khác. Đã sửa assert thành `.error === 'invalid_grant'` và không có `access_token`/`refresh_token`. Chạy lại `-- token-code-recheck`: `Tests: 36 passed, 36 total`.
3. Mutation tester (sao lưu `token.controller.ts` vào scratchpad, cp + sha256 `ac5a2d35…82b3fdc` khớp trước và sau khi khôi phục, không dùng git checkout). Thay `subjectFailure` thành "khoá admin **hoặc** `lockedUntil > now`" thì `Tests: 3 failed, 33 passed`. RED đúng 3 test G1: `G1: a brute-force (temporary) lock does NOT refuse…`, `G1 control: … right after rotate => 200`, `tester G1: a brute-force lock reached through real failed logins (>=5) keeps refresh alive`. (Lần mutation đầu xoá import `ADMIN_LOCKED_UNTIL` khiến suite không biên dịch được (0 test). Lần đó không tính, đã thay bằng biến thể giữ import.)
4. `pnpm -C be test`: `Test Suites: 26 passed` · `Tests: 317 passed, 317 total`.
5. `pnpm -C fe-sso-test test`: `Test Files 31 passed (31)` · `Tests 240 passed (240)`.
6. `pnpm -C be test:int` (FULL, `vg-test-mongo@27117` + `vg-test-redis@6479` đang chạy, khoá `vg:int-lock` do preflight tự quản): `Test Suites: 38 passed, 38 total` · `Tests: 964 passed, 964 total` · `Time: 265.73 s`.
7. `pnpm -C e2e e2e` (một lần; :5173/:4000 trống trước khi chạy, không phải kill process nào): `16 passed (1.3m)`, exit 0. Sau khi chạy không còn listener nào trên :5173/:4000.
8. Kiểm ma trận bằng grep: có 169 tham chiếu `` `be/test/… › …` `` trong `security-matrix.md`, đối chiếu từng tên test với file. Có 3 tham chiếu không khớp literal, nhưng cả 3 đều hợp lệ: 2 là tên `it.each` đã mở rộng `%s` (`race: admin lock + credential sweep right after establish …` trong `ui-auth`/`federation`), 1 bị cắt bằng `…` (`race: client disabled (state write only) right after rotate => …`, tiền tố có thật). Không có tham chiếu chết.

## Test FAIL (nếu có)

Không có test FAIL ở lần chạy cuối. Case 2 là lỗi [test] của tester, đã sửa.

## Coverage acceptance criteria

- [x] T1 DEBT-213: không đổi số audit. Oracle là toàn bộ `token-code-recheck` + `token.int-spec` xanh. Tester thêm `tester DEBT-067: revokeFamily throws on a refusal …` cho nhánh revoke ném ở refresh.
- [x] T1 DEBT-210: `DEBT-210: resource removed …`, `DEBT-210 race …` và body byte-identical (`every refusal body is byte-identical …`).
- [x] T2 DEBT-207a: các race lock/suspend/disable (+sweep) sau `rotate`, control, fail-closed 500. `admin-users` cross-tenant xanh.
- [x] T3 DEBT-207b: `ui-auth`/`federation` `race: %s right after establish` (khoá admin + khoá tạm), fail-closed, link `(c2)`. Tester thêm `(c3)`: khoá tạm xen giữa trong luồng link ⇒ trang lỗi chung, không link, session chết, không có cookie session.
- [x] T4 DEBT-211: `DEBT-211: not_member (GET /authorize and POST approve) Location is byte-identical to a real user deny`.
- [x] G7: `pnpm -C be test`, `test:int` FULL, `fe-sso-test`, E2E 16/16.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Identity: loại khoá | khoá admin ⇒ code grant/refresh/login chết; khoá tạm ⇒ grant sống, login chặn | dev: `DEBT-141 …`, `race: admin lock …`, `G1 …`; ui-auth/federation `race: %s …`. Tester: `tester G1: a brute-force lock reached through real failed logins (>=5) keeps refresh alive` (khoá tạm đi qua `recordFailedLogin` thật, không ghi DB tay) |
| Identity: kẻ kích brute-force | brute-force sau khoá admin không hạ được thành khoá tạm | `tester G1: brute-force after an ADMIN lock cannot downgrade it => code grant still refused`, `… => refresh still refused, family dead` (7 lần `recordFailedLogin`, `lockedUntil` vẫn bằng `ADMIN_LOCKED_UNTIL`) |
| Identity: user mất | user bị xoá ngay sau `rotate` | `tester: user vanished right after rotate => … user_locked, family dead` |
| Authorization: cross-tenant | user rời tenant của client nhưng vẫn active ở tenant khác | `tester cross-tenant: membership of the client tenant removed (user still active elsewhere) => not_member` |
| Exposure | refresh bị từ chối (reason hoặc 500) ⇒ không ký token, body không có token | `tester exposure: a refused refresh (reason or recheck_failed) never signs a token` (spy `signTokensForRefresh` không được gọi); dev: body byte-identical, audit không chứa RT |
| Dependency | `revokeFamily` ném khi từ chối ⇒ 500, không token, vẫn giữ audit từ chối; successor (chưa từng giao) bị quét khi replay | `tester DEBT-067: revokeFamily throws on a refusal …` |
| Dependency | lỗi DB khi recheck ⇒ 500, family chết | dev `fail-closed …` (code + refresh + login + federation) |
| State: replay | replay token cũ sau 500 `recheck_failed` và sau 400 `user_locked` | `tester DEBT-215 pin: replay after %s …` (2 case) |
| Concurrency | 5 refresh song song cùng 1 RT khi đang khoá admin | `tester concurrency: 5 parallel refreshes … => no 200, whole family dead` |
| Request chain (link + khoá) | khoá admin / khoá tạm xen giữa `establish` trong link | `(c2)` (dev), `(c3) tester run 36: BRUTE-FORCE lock …` |

### DEBT-215: đã xác nhận bằng test thật, đánh giá rủi ro

Test pin xác nhận hành vi hiện tại. Sau khi refresh bị từ chối sau `rotate` (500 `recheck_failed` hoặc 400 `user_locked`), replay token cũ ⇒ 400 `invalid_grant`, không có token, family vẫn chết. Đồng thời có đúng **1** `TOKEN_REUSE_DETECTED` với `count: 0` (cảnh báo giả), audit không chứa RT.

Không có bypass, không lộ token, không mất dữ liệu ngoài ý muốn (family vốn đã bị revoke có chủ đích). Tác động chỉ là nhiễu cảnh báo SOC, cùng lớp với DEBT-032. Vì vậy không chặn và giữ 🟡 DEBT-215. Khi DEBT-215 được sửa, test pin phải đổi sang `toHaveLength(0)`, và việc đổi này là có chủ đích.

DEBT-216 (refresh không kiểm lại resource) nằm ngoài acceptance run 36 và đã nằm trong backlog, nên tester không viết test.

## Thay đổi file test (tester)

- `be/test/token-code-recheck.int-spec.ts`: thêm 10 test (8 `it` + 1 `it.each` ×2) vào khối `refresh grant re-check after rotate (run 36 Task 2)`.
- `be/test/federation.int-spec.ts`: thêm `(c3)`.
- `docs/agile/sso-idp/security-matrix.md`: thêm dòng "Tester run 36 (risk matrix bổ sung)" vào bảng Run 36.
