# Summary — consent-session-hardening (DEBT-050/051/052/026/027/028) — ✅ PASS 5/5 task

- **Phạm vi**: `resetPassword` thu hồi mọi refresh family (setPassword → revoke family → xoá phiên → sweep revoke family → audit; lỗi revoke ⇒ 5xx, không rollback mật khẩu) — DEBT-050 (security, ưu tiên cao). `/token` code grant re-check phiên sau insert cho MỌI grant, phiên chết ⇒ chỉ revoke đúng family vừa tạo + audit `TOKEN_REVOKED session_ended` + `invalid_grant`; sweep revoke family sau xoá phiên ở logout local/global + reset — DEBT-051. `revokeRef(…, tombstone=false)` cho re-login + quá absolute (re-login không giết token cũ, giữ `offline_access`) — DEBT-052. Consent grant 1 update-pipeline atomic (`$literal` chống injection) — DEBT-027; DEBT-026 đóng bằng test hồi quy; `runbook-deploy.md` + test drop index cũ — DEBT-028. spec §8/§9.8/§14/§15 cập nhật.
- **Quyết định**: re-check đặt ở controller (tránh vòng DI, giữ `revokeWhere` là cửa duy nhất); DEBT-052 Phương án A.
- **Bug đã sửa (senior REJECT 1)**: thiếu audit `session_ended`; re-check bỏ qua grant không refresh; test không canh family idle-expire và `$literal`; dev chưa áp spec.md.
- **Verify**: typecheck/lint PASS; unit 131/131; int 400/400 → **531/531**. Mutation (senior + tester) đều bị bắt.
- **Commit**: `46da89a`.
- **Vòng lặp**: analyst=1, tech-lead=1, dev=2, senior=2 (REJECT→PASS), tester=1.
- **Debt**: đóng DEBT-026/027/028/050/051/052/056/057/058 (+ dọn bảng: 034/037/038/040/041/043/045/046 đã xong ở run 16–17); mở DEBT-055, 059 (`TOKEN_ISSUED` audit trước re-check), 060, 061, 062.