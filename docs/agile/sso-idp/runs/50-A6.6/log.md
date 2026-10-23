# Log — run 50 — A6.6 Dashboard (+ DEBT-352)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đã đối chiếu code `e484913` qua CodeGraph. Fold được ghi vào `tasks.md`, review ở `review-techlead.md`.

- **Phạm vi**: không Task 0 [BE]. Task 1 → 2 → 3 giao frontend-dev.
- **Sự thật**
  - BE không có count; list `limit` ≤ 100 + `nextCursor`.
  - Resources là toàn cục; clients/users/audit theo tenant của token.
  - `/ready` công khai, body enum, `no-store`.
  - Audit nhận một `action` mỗi request. `AUTH_ACCOUNT_LOCKED` không có tenant (DEBT-140).
- **Quyết định**
  - Đếm: một trang 100, hiện `n` hoặc `100+`.
  - Health: BFF `readiness` (kiểm session, timeout 3s, không bearer) ⇒ `up|down|unknown`.
  - Sự kiện: 3 action × `limit: 10`, gộp ở trình duyệt, fail-closed.
- **Debt mới**: DEBT-356 (BE chưa có endpoint đếm).

## frontend-dev — 2026-10-23 — Task 1 → 2 → 3 xong, đề nghị senior-reviewer
- T1 DEBT-352 đóng: `useSigningKeys()` không tham số, gate bằng mount. T2: `readiness(ctx)` (session trước, 0 fetch ẩn danh, không bearer, 3 s, không retry, chỉ `up|down|unknown`, log route) + `getBackendHealth`; `/` 4 khối độc lập (đếm `n`/`100+` "More than 100", keys chỉ super_admin, health text, 3 `listAudit` gộp fail-closed); `alertLabel` chuyển `features/audit/alert-label.ts` (hành vi `/audit` giữ nguyên). 3 test shell render `/` thêm `Wrap: IdleQueries` (query không chạy).
- Test mới: `health-fn` 16, `dashboard-ui` 24. Mutation (sha256 khôi phục OK): countText 1 RED, bỏ gate 3 RED, list khi lỗi 3 RED, `authorization` /ready 1 RED, bỏ kiểm session 1 RED.
- Verify: fe-admin typecheck/lint OK, test 1246/1246 (49 file), build OK, check:bundle 0 hit, gen:api không diff; root lint OK; e2e typecheck OK; E2E `fe-admin-dashboard.spec.ts` + suite 34/34 hai lần liên tiếp (:4000/:5173/:3000 trống, không E2E_REUSE). Output: không `eyJ`, chỉ email seed placeholder có sẵn.
- Debt mới: DEBT-357 (refetch khi focus mặc định của dashboard).

## senior-reviewer — 2026-10-23 — PASS
- Kết quả: 0 🔴, 2 🟡 (DEBT-358 test "no retry" health vacuous do `setQueryDefaults(["admin"], {retry:false})`; DEBT-359 ponytail `CountCard`/`useQueries`), 3 💭. Chi tiết ở `review-senior.md`.
- Security đã kiểm:
  - `readiness`: kiểm session trước, 0 fetch khi ẩn danh. Không bearer, không retry, timeout 3 s, redirect manual, URL cố định (không SSRF). Trình duyệt chỉ nhận enum; log không có body.
  - "Check again" chỉ dành cho admin, 1 request/lần, disabled khi đang chạy ⇒ không khuếch đại.
  - Gate keys bằng mount. Sự kiện fail-closed. Render dạng text.
- Verify độc lập: fe-admin `tsc --noEmit` OK, `vitest run` 1246/1246 (49 file). E2E không chạy lại.
- → **tester**.

## tester — 2026-10-23 — PASS
- Thêm `fe-admin/test/dashboard-ui-risk.test.tsx` (22) + `health-fn-risk.test.ts` (16), không sửa code sản phẩm. DEBT-358 phủ bằng `createQueryClient()` thật (không override retry) ⇒ đóng.
- Mutation 9/9 RED (backup sha256, khôi phục OK): bỏ `retry:false` health, "Check again" không disabled, Try again refetch tất cả, pending che lỗi, bỏ tie-break, bỏ cắt 10, 3xx ok ⇒ up, forward cookie tới `/ready`, nuốt lỗi session store.
- Verify: fe-admin typecheck/lint OK, test 1284/1284 (51 file), build OK, check:bundle 0 hit, gen:api không diff; root lint OK, `pnpm -r typecheck` OK, audit high: 0 (1 high ignored sẵn), E2E 34/34 + dashboard lại 1/1 (cổng trống, không E2E_REUSE). Output: 0 `eyJ`, chỉ email placeholder seed.
- Root `pnpm test` song song đỏ 4/4 (check-bundle timeout, users-ui, ngoài diff; vẫn đỏ khi tạm bỏ file test mới) ⇒ DEBT-360; tuần tự `--workspace-concurrency=1` xanh (be 416, fe-admin 1284, fe-sso-test 269).
- Chi tiết: `test-report.md`. → orchestrator đóng run.
