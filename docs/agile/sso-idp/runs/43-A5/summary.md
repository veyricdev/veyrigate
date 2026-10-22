# Summary — run 43 A5 (M5, lane ADMIN) — ✅ PASS 4/4 task

- **Phạm vi**: T1 snapshot `fe-admin/openapi/admin.json` + `gen:api` (`openapi-typescript@7.13.0`), CI kiểm lệch types, E2E `admin-openapi.spec.ts` so BE thật. T2 client admin API phía server (AT không rời `src/server`, endpoint cố định, path param zod + encode, response qua zod allowlist, lỗi về client là union `{code,message,uncertain}` không chứa body BE/token, 401 ⇒ refresh 1 lần). T3 `@tanstack/react-query@5.104.1` (retry GET tạm thời ≤2, mutation không retry, `gcTime 0`), step-up intent `sessionStorage` dùng 1 lần gắn action/path/sub, không secret, người dùng tự gửi lại. T4 DEBT-282 (SSR 503 qua AsyncLocalStorage), DEBT-289 (lỗi mạng/5xx IdP ⇒ 503), `azp` aud đơn.
- **Lệch fold có lý do**: lỗi trả qua union value thay vì throw (ShallowErrorPlugin của Start chỉ giữ `message`).
- **Verify**: fe-admin 417 (+1 `it.fails` DEBT-299), be 401, fe-sso-test 269, E2E 27/27, audit high 0, `gen:api` không diff; mutation 23/24 killed.
- **Commit**: `3999ef3`.
- **Vòng lặp**: tech-lead=1, FE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-282/289 (+ phần azp của 288); mở DEBT-290–299 (290/294 cần sửa BE OpenAPI; 281/299 đích A6.1).
