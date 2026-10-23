# Summary — run 45 A6.1b (M5, lane ADMIN) — ✅ PASS 4/4 task

- **Phạm vi**: T1 [FE] DEBT-308 (`ClientForm` remount theo `clientId`). T2 [FE] server fn `listSecrets`/`issueSecret` (no-store)/`revokeSecret` (DELETE, 204) + bảng version (không hash). T3 [FE] dialog secret một lần (plaintext chỉ trong `useState`, không vào cache/storage/URL/log; copy + cảnh báo; đóng/pagehide/đổi client xoá), rotate/revoke có xác nhận + step-up, disable (PATCH một mình, 409 tự khoá) / enable; `Dialog`/`AlertDialog` a11y. T4 [E2E] `fe-admin-secrets.spec.ts`: secret dùng được qua `/revoke` Basic ⇒ revoke version ⇒ 401, disable ⇒ chặn.
- **Bug đã sửa**: (tester FAIL 1, DEBT-313 🔴) Disable trả `uncertain` rồi refetch ⇒ cùng instance `ConfirmAction` đổi thành "Enable" ⇒ một click bật lại client ⇒ `key` riêng + đóng dialog, thông điệp uncertain ra `notice`. Cùng retry: DEBT-314/316 (refetch lỗi làm mất dialog secret), DEBT-315 (lỗi ném ⇒ text uncertain cho mọi lệnh ghi).
- **Verify**: fe-admin 682/682, be 405, fe-sso-test 269, E2E 29/29 (×2 lượt 1 + dev retry + tester lượt 2), audit high 0, `gen:api` không diff, check:bundle 0; mutation RED; grep secret 0.
- **Commit**: `15cba2d`.
- **Vòng lặp**: tech-lead=1, FE dev=2 (impl, retry 1), senior=2 (PASS, PASS), tester=2 (FAIL → PASS).
- **Debt**: đóng DEBT-308/313–316; mở DEBT-309–312, 317, 320 (💭), **DEBT-318/319 🟡** (invalidate khi lỗi ném; focus/status sau disable/enable — nên gộp vào run 46).
- **Run 46**: A6.2 Resources (+ DEBT-318/319).
