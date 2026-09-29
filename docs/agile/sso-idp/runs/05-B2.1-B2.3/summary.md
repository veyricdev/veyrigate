# Summary — B2.1–B2.3 (M2) — ✅ PASS 80/80
- Phạm vi: B2.3 Sessions Redis + cookie `idp_session` (fixation, idle/absolute, revoke theo thiết bị); B2.1 TenantGuard + repository tenant-scoped (INV-24); B2.2 Identity services + seed `default-tenant`.
- Test: unit 35/35, int 45/45; tsc, eslint, build xanh; prod boot từ chối `SESSION_COOKIE_SECURE=false`.
- Commit: (chưa commit)
- Quyết định quan trọng: Q6 chốt tạm idle 8h / absolute 30 ngày (env); Redis chỉ lưu sha256(sessionId); tenant chỉ lấy từ session + membership active; DuplicateError là lỗi domain (chống enumeration).
- Debt đóng: DEBT-002.
- Debt để lại: DEBT-008..014 (DEBT-010, 011, 014 nên làm ở run 06 / B2.4).
