# Summary — BUG-logout-action (M2) — ✅ PASS 158/158
- Phạm vi: thêm action `Sign out` cho authenticated home, giữ shared-message defaults.
- Kết quả: senior-reviewer PASS; tester PASS 48 unit + 110 integration.
- Commit: chưa commit (working tree hiện tại).
- Bug đã sửa: trang đã đăng nhập có link `/logout`; GET chỉ xác nhận, POST+CSRF mới revoke.
- Quyết định quan trọng: khóa replay cross-session, escaping/CSP, failure order và retry idempotent.
- Debt để lại: không có debt mới.