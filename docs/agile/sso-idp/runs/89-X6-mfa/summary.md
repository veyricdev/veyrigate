# Summary — run 89 X6 MFA (M8, lane BE + FE + QA) — ✅ PASS 7/7 task

- **Phạm vi**: T0 sửa 🟡 senior run 88 (DEBT-628…632). T1 lõi MFA: TOTP RFC 6238 (`node:crypto`), keyring AES-256-GCM `MFA_ENCRYPTION_KEYS` (AAD gắn userId), `User.mfa` `select:false`, mã khôi phục 80-bit dùng một lần, CAS `lastStep`. T2 `/account/mfa` (enroll, tắt/tạo lại mã cần mật khẩu + TOTP hoặc mã khôi phục, thư báo). T3 bước 2 `/login/mfa` (ticket `__Host-idp_mfa`, dùng chung login/federation/`/auth/link`) + cổng resource `admin` (`amr ∋ mfa`, `mfaAt ≥ enrolledAt` ở `/authorize`, `/token`, refresh; `ADMIN_MFA_REQUIRED` không tắt được ở production). T4 reset MFA: `POST /admin/users/:id/mfa/reset` (step-up, 204 idempotent) + `admin-recover --reset-mfa` + runbook-ops §11/§12, runbook-deploy §17. T5 fe-admin trạng thái + nút Reset MFA. T6 E2E qua TOTP thật + checklist.
- **Verify**: be 1188, int FULL 89/89 2393/2393 (`vg-int-*` 0→0), E2E 52/52 ×2 (+`totp.spec`, `mfa.spec`), X3 42, fe-admin 1653. Vault không chạy (không đổi code Vault).
- **Checklist**: 202 dòng = 155 ✅ / 29 ⚠ / 1 ❌ / 17 N/A; P0 ❌ = 0; ❌ còn D-14 (ký, run 90). C-6.3.3/C-6.4b/C-6.5 ✅.
- **Commit**: `<hash>`.
- **Vòng lặp**: tech-lead=1 (PASS, viết lại tasks), BE dev=4 lô (A+B, sửa int, C, D89.30), FE dev=1 (+follow-up), senior=4 lượt (A+B, C, T5, delta; đều PASS), tester=1 (PASS; phát hiện 🔴 DEBT-647 CSP `form-action` trên `/login/mfa` ⇒ D89.30).
- **Debt**: đóng DEBT-628…632, 637…647; mở DEBT-633…636, 648 (E2E 12,5–14,2 phút do chờ bước TOTP). DEBT-334 dời sau phát hành. Quyết định D89.1–D89.30 chép vào `plan.md` §12.
- **Sự cố**: 2 jest int treo >1 h (`pnpm test:int -- -t` thành path pattern, thiếu `--forceExit`) — người dùng tự dừng; từ nay chạy jest trực tiếp bọc `timeout`.
- **⚠ Deploy**: cần `MFA_ENCRYPTION_KEYS` (thiếu ⇒ app không boot); admin console bắt buộc MFA ⇒ admin enroll ở `/account/mfa` trước; mất yếu tố ⇒ runbook-ops §11 (`admin-recover --reset-mfa`); runbook-deploy §17.
