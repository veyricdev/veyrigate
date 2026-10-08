# Summary — B4.2 (M4 Consent) — ✅ PASS 4/4 cổng

- **Quyết định (user ủy quyền analyst/tech-lead, mục tiêu production)**: **Q1** consent key = `user × client × resource` (sentinel `resource=""`; tenant suy từ `Client.tenantId`). **Q4** chốt D3 (`max_age`+`auth_time` step-up) + D7 (refresh khi grant `refresh_token` + scope `offline_access`; `Client.grantTypes[]` thêm ở B4.4). Ghi ở plan §12.
- **Phạm vi**: `ConsentService` (find/isCovered/grant, version policy/terms qua env fail-fast); wire `/authorize`: covered → issue code (B4.3 store) + redirect `code/state/iss`; chưa covered → trang consent BE-render; `POST /authorize/consent` (CsrfGuard) approve/deny; `prompt=none` fail-closed `consent_required`; `prompt=consent` ép hỏi lại.
- **Security**: tham số issue code lấy từ ctx single-use (chống tamper/replay), owner = session (chống IDOR), Eta autoEscape, không log code/nonce/state.
- **Verify**: typecheck/lint PASS; unit 67/67; int 202/202 → **269/269**.
- **Commit**: `b89ca9e`.
- **Vòng lặp**: analyst=1, tech-lead=1, dev=1, senior=1, tester=1 (không REJECT).
- **Debt**: đóng DEBT-015, DEBT-022. Mở DEBT-026 (tối ưu nhánh covered/B4.4), DEBT-027 (grant union scope không atomic — fail-closed), DEBT-028 (drop index cũ khi deploy).
