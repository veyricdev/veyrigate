# Summary — run 91 X6 điều kiện go-live + hardening sau pentest (M8, lane BE + ops) — ✅ PASS

- **Phạm vi**: A DEBT-666 counter `sso_background_write_failures_total{what}` + alert `SsoBackgroundWriteFailed`/`SsoAuthMailFailed` + runbook-ops §13 (điều kiện go-live (2) mức repo); DEBT-665/671/672 `/register` tài khoản chưa xác minh ⇒ thư "hoàn tất đăng ký" bằng token đặt lại, `/verify-email` đòi mật khẩu (≤ 5 lần/token), chống chiếm tài khoản trước; DEBT-667 hạ tầng ghi tách rời. B DEBT-651 code dùng lại cùng client ⇒ thu hồi refresh family + denylist `at_revoked:{jti}`. C DEBT-662 `response_mode` ≠ query ⇒ `invalid_request`, DEBT-663 `no-store`, DEBT-667d `x-request-id` chỉ từ `TRUST_PROXY`. D gate.
- **Verify**: gate HEAD `c39b19a`: be 1247, int FULL 2444/2444 (`vg-int-*` 0→0), E2E 52/52 ×2, X3 42; harness `pentest-20261117T021931Z` must 261/261 + should 1/1, exit 0; timing login/forgot/register/register-unverified 0,1/1,8/0,6/0,1 ms; mutation m1–m4 (+m2b–d) đỏ đúng. fe-admin không đụng.
- **Checklist**: 203 = 157 ✅ / 28 ⚠ / 1 ❌ (D-14) / 17 N/A không đổi, 334 bằng chứng 0 lỗi; C-16.4a ⇒ `CONTRACT-REQID-untrusted`; mục F giữ chữ ký, thêm ghi chú Run 91.
- **Commit**: `c39b19a` (lô A–C).
- **Vòng lặp**: tech-lead fold 1 (sửa D91.4 sau 🔴 pre-hijack); BE dev lô A + retry 1, B, C + retry 1; senior A REJECT → PASS, B PASS, C REJECT (3 🔴 harness) → PASS; tester D (dừng theo yêu cầu người dùng, chạy lại từ đầu) PASS.
- **Debt**: đóng DEBT-651/662/663/665/666/667/671/672; mở DEBT-669 (RS verify JWT cục bộ không thấy denylist), DEBT-670 (nạp alert vào Prometheus/Alertmanager thật). Quyết định D91.1–D91.14 chép vào `plan.md` §12.
- **Sự cố**: SMTP Mailpit kẹt sau harness (DEBT-664) ⇒ harness chạy sau E2E, người dùng restart container.
- **Còn lại cho go-live**: (1) smoke môi trường thật + Safari; (2) DEBT-670 nạp alert; (3) URI Mongo qua file 0600 (DEBT-258); (4) Dependabot/CodeQL/gitleaks sau push; người dùng ký mục F (D-14).
