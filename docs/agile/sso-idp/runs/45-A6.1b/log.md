# Log — run 45 — A6.1b secrets dialog / rotate / revoke / disable (+ DEBT-308)

## orchestrator — 2026-10-22
- Tiếp A6.1 sau run 44 (`a581963`). Tự sinh `tasks.md` từ `runs/44-A6.1/tasks.md` mục "Run 45 (A6.1b)" + DEBT-308 (bắt buộc). Cổng → tech-lead.

## tech-lead — 2026-10-22
- **PASS (có fold)**. Đối chiếu code `a581963` qua CodeGraph. Fold F1–F4 vào `tasks.md`: F1 `key={clientId}` cho toàn bộ thân detail (DEBT-308 + reset plaintext); F2 `client.ts` thêm DELETE/204, zod allowlist secrets, `no-store` trên response server fn issue, test không lộ secret; F3 issue KHÔNG qua `useMutation` (MutationCache giữ data khi còn observer), dialog Radix (`radix-ui` có sẵn), step-up KHÔNG intent (vì `takeIntent` của form xoá key bất kể action) — nút "Confirm identity", cảnh báo revoke version cuối, 409 disable thông điệp riêng; F4 E2E bằng `/revoke` Basic (200 vs 401), không step-up E2E.
- Q-45.1 `/revoke` + Basic; Q-45.2 stub clipboard ở unit, E2E đọc DOM; Q-45.3 vừa 1 run sau khi cắt.
- Mở DEBT-309…311. → **frontend-dev** (Task 1 → 2 → 3 → 4).

## frontend-dev — 2026-10-23 (tiếp phiên bị ngắt)
- Không có sao lưu mutation dở của run 45 trong scratchpad ⇒ không file nào cần khôi phục. Rà `git diff` theo fold: Task 1–3 đã code xong (F1 `Fragment key={clientId}`, F2 DELETE/204 + `setNoStore`, F3 issue không `useMutation`, step-up `reauthenticate`, 409/404/uncertain); thiếu Task 4 và `client-secrets.test.tsx` treo vô hạn.
- Nguyên nhân treo: root route vẽ `<html>/<body>` (singleton = `document.body`) nhưng test mount vào `<div>` trong body ⇒ event trong Radix portal làm React lặp body → div → body. Sửa test: `render(..., { container: document })`; sửa race `release` ở "double click on Revoke". Case DEBT-308 dialog: nạp app-2 trước (cache) để kiểm đúng nhánh không remount. Ghi DEBT-312 💭.
- Mutation (sao lưu + sha256, khôi phục khớp): bỏ `key` ⇒ RED (risk + dialog); bỏ `setNoStore` ⇒ 5 RED; bỏ `onInteractOutside` ⇒ RED (sau khi đổi test click ngoài sang overlay — bản cũ bấm body không bắt được); tắt cảnh báo version cuối ⇒ RED.
- Task 4: `e2e/tests/fe-admin-secrets.spec.ts` (issue S1 no-store → /revoke 200 → close/reload không thấy → rotate S2 → revoke v1 ⇒ S1 401/S2 200 → disable 401 → enable 200 → finally disable); `signInAsAdmin` chuyển sang `tests/support/fe-admin.ts`.
- Verify: fe-admin typecheck/lint 0, test 650/650, build 0, check:bundle 0 hit, gen:api không diff; root lint 0, `-r typecheck` 0, `pnpm test` (be 405, fe-sso-test 269, fe-admin 650) xanh; audit exit 0 (2 low, 1 high ignored); E2E full 29/29 ×2 (3.9 m, 3.3 m; test secrets 5.1 s/5.2 s), grep `clientSecret|S3CR3T` = 0. → **senior-reviewer**.

## senior-reviewer — 2026-10-23
- **PASS**. Review diff fe-admin/e2e kể từ `95af60a` qua CodeGraph + đọc trực tiếp; verify độc lập fe-admin typecheck 0, lint 0, test 650/650 (không chạy E2E).
- Invariant đã kiểm: plaintext chỉ ở `useState` của body dialog (không useMutation/cache/storage/URL/toast/log/SSR), `no-store` đặt trước `adminCall` (mọi nhánh), đóng/Escape/pagehide/đổi `clientId` xoá; double-submit chặn bằng ref + pending; revoke 404/uncertain, disable gửi một mình + 409 riêng; step-up không intent; E2E `/revoke` Basic 200/401 không nội suy secret.
- 🟡 mở DEBT-313 (dialog Disable `uncertain` lật thành Enable cùng instance), DEBT-314 (gate `isSuccess` làm dialog secret unmount khi refetch lỗi), DEBT-315 (lỗi throw khi issue ⇒ "try again" thay vì uncertain). 💭 focus sau revoke, filter `waitForResponse`, live region. → **tester**.

## tester — 2026-10-23
- **FAIL [FE]** — DEBT-313 xác nhận bằng test thật ⇒ nâng 🔴: Disable `uncertain` (BE đã disable) ⇒ refetch ⇒ chính dialog đang mở thành "Enable this client?" giữ lỗi "…before trying again" ⇒ MỘT click confirm (cùng chỗ) gửi `PATCH { disabled: false }` bật lại client. Sửa: `key` theo `disabled` cho mỗi `ConfirmAction` + đưa thông điệp uncertain ra `notice`; đổi `it.fails` ⇒ `it`, xoá characterisation.
- Thêm `fe-admin/test/client-secrets-risk.test.tsx` (24 case: canary sau Close/Escape/pagehide/điều hướng/unmount/pending+điều hướng/pending+pagehide + refetch + mở lại; issue throw/uncertain/403/404; Cancel/Escape khi pending; revoke grace cuối; double-click Disable; 409 enable; a11y Tab loop/Escape/focus Cancel; characterisation DEBT-313/314/316 + 3 `it.fails` DEBT-313/314/315).
- Mutation (sao lưu + sha256, khôi phục OK): áp fix đề xuất DEBT-313/314/315 ⇒ 6 RED đúng chỗ; bỏ `busy` ref ⇒ vẫn xanh (pending đủ, 💭).
- Verify: fe-admin typecheck/lint 0, test 671 + 3 expected fail, build 0, check:bundle 0 hit, gen:api không diff; root lint 0, `-r typecheck` 0, `pnpm test` (be 405, fe-sso-test 269, fe-admin) xanh; audit exit 0 (2 low, 1 high ignored); cổng :4000/:5173/:3000 trống ⇒ E2E 29/29 ×2 (3.3 m, 3.1 m), grep secret 0.
- Xác nhận DEBT-314/315 (🟡 giữ), mở DEBT-316 🟡 (refetch detail lỗi ⇒ dialog secret mất), DEBT-317 💭 (pagehide khi pending). → **frontend-dev** (retry 1, DEBT-313).

## frontend-dev retry 1 — 2026-10-23
- Đóng **DEBT-313** 🔴: `client-status.tsx` `key="enable"`/`key="disable"` + `uncertain`/lỗi ném ⇒ đóng dialog, `UNCERTAIN_STATUS` ở `notice` ngoài dialog (không còn nút confirm sau uncertain). Đóng **DEBT-314** (`secrets.data !== undefined`), **DEBT-315** (`outcomeOf`: lỗi không phải `AdminRequestError` ⇒ text uncertain của caller), **DEBT-316** (`ClientPage`: alert lỗi phía trên, giữ thân khi còn data).
- Test risk: 3 `it.fails` ⇒ `it`; bỏ characterisation 313/314, thay 316 bằng desired; +2 case 313 (uncertain không qua ⇒ Disable lại; đổi trạng thái khi dialog mở ⇒ dialog bị thay, 0 PATCH).
- Mutation (sao lưu + sha256 khôi phục khớp): revert fix 313 ⇒ 3 RED (chỉ key ⇒ 1, chỉ đóng-khi-uncertain ⇒ 2); revert 314 ⇒ 1 RED; 315 ⇒ 2 RED; 316 ⇒ 1 RED.
- Verify: fe-admin typecheck 0, lint 0, test 674/674 (0 `it.fails`), build 0, check:bundle 0 hit; root lint 0. Cổng :4000/:5173/:3000 trống ⇒ E2E 29/29 (3.3 m); sau đó cổng trống lại.
- Còn mở DEBT-317 💭. → **senior-reviewer**.

## senior-reviewer lượt 2 — 2026-10-23
- **PASS**. Review retry 1 (DEBT-313/314/315/316) bằng đọc trực tiếp + CodeGraph sync. Verify độc lập fe-admin: typecheck 0, lint 0, test 674/674. Không chạy E2E.
- Test nháp tạm (đã xoá, `git status test/` không đổi) đo được hai điều:
  - focus sau Disable thành công = `BODY`;
  - throw ở disable/revoke ⇒ không đọc lại detail/list.
- DEBT-313 đóng thật: `key` + uncertain/throw ⇒ đóng dialog, `notice` ở cha. Muốn Enable sau đó phải bấm trigger rồi confirm có chủ đích.
- DEBT-315 mở rộng sang revoke/disable: đúng, vì throw có thể xảy ra sau khi ghi, và lặp lại thì idempotent hoặc trả 404. Rút đề xuất vòng 1.
- DEBT-314/316: plaintext vẫn chỉ nằm trong state của body dialog. Chấp nhận trade-off `not_found` + data cũ, vì BE trả 404 ⇒ fail-closed.
- Mở debt:
  - DEBT-318 🟡: throw không invalidate, nhưng text nói "reloaded".
  - DEBT-319 🟡: focus về body sau khi đổi trạng thái (do `key`); live region.
  - DEBT-320 💭: khi `not_found` thì ẩn nút ghi.
- Ponytail: lean. → **tester** (lượt 2).

## tester lượt 2 — 2026-10-23
- **PASS [FE]**. DEBT-313/314/315/316 đóng thật: `client-secrets-risk.test.tsx` 0 `it.fails`, mọi case xanh.
- +8 case risk (32/32): sau uncertain Disable chỉ còn trigger Enable ⇒ cần trigger + confirm có chủ đích (instance mới, không alert cũ, focus Cancel), 1 PATCH; disable/enable/revoke throw ⇒ text uncertain, không canary; revoke uncertain ⇒ list đọc lại, lặp ⇒ 404; refetch detail/list throw ⇒ dialog secret giữ, Close/mở lại sạch mọi sink.
- DEBT-318 🟡 xác nhận bằng 2 characterisation (không refetch sau throw; trigger cũ cùng hành động ⇒ không đảo ngược, không lộ secret).
- Mutation (sao lưu + sha256, khôi phục khớp): fix DEBT-318 ⇒ 2 RED; bỏ `key` ⇒ lượt 2 xanh (case dev bắt); `outcomeOf` throw ⇒ "try again" ⇒ 1 RED.
- Verify: fe-admin typecheck/lint 0, test 682/682, build 0, check:bundle 0 hit, gen:api không diff; root lint 0, `-r typecheck` 0, `pnpm test` (be 405, fe-sso-test 269, fe-admin 682); audit exit 0 (2 low, 1 high ignored); cổng trống ⇒ E2E 29/29 (3.3 m); grep secret 0. Không debt mới. → **orchestrator** đóng run.
