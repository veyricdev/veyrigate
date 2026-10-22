# Summary — run 41 A1–A3 (M5, lane ADMIN) — ✅ PASS 3/3 task

- **Phạm vi**: T1 fe-admin TanStack Start dựng tay (không CLI), pin exact theo bảng tech-lead (Start 1.168.60, Router 1.170.41, React 19.3.0, Tailwind 4.3.3, shadcn 4.21.3 qua dlx…), overrides `seroval`/`prettier` cho phụ thuộc quá mới, cổng :3000, CI bước build + `check:bundle`. T2 `src/server/env.ts` (server-only, 7 biến plan §1.4, https khi production, lỗi chỉ nêu tên biến, env sai ⇒ mọi request 500 trơn) + `scripts/check-bundle.mjs`. T3 layout sidebar + header, theme lưu cookie (whitelist, không inline script), trang 404/lỗi (không lộ message)/loading, skip-link, `aria-current`.
- **Quyết định người dùng**: Q3 = fe-admin BFF/confidential; Q5 = Vault Transit + Redis Sentinel (plan §12).
- **Verify**: fe-admin 96/96 (21 dev + 75 tester), root test (be 401, fe-sso-test 269), typecheck/lint/build, `check:bundle` 0 hit kể cả canary, audit high exit 0; lockfile không đổi importer be/fe-sso-test/e2e; mutation RED.
- **Commit**: `9851442`.
- **Vòng lặp**: tech-lead=1, FE dev=1, senior=1, tester=1 (1 lần ngắt phiên) — không REJECT.
- **Debt**: mở DEBT-264–277; **DEBT-274 (https chỉ theo NODE_ENV runtime) và DEBT-275 (message lỗi vào HTML SSR/serverFn) bắt buộc sửa ở A4 (run 42)**.
