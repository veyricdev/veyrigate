# Summary — run 42 A4 (M5, lane ADMIN) — ✅ PASS 4/4 task

- **Phạm vi**: T1 session Redis opaque (`fea:sess:` HMAC key, AES-256-GCM, `SET XX KEEPTTL`, idle 30'/absolute 8h, Redis lỗi fail-closed), cookie `fea_sid` / `__Host-` theo giao thức `APP_URL`; DEBT-274 (https theo build mode), DEBT-275 (lỗi qua SSR/serverFn chỉ là thông điệp chung + request id). T2 `/auth/login`, `/auth/callback`: tx dùng 1 lần (GETDEL) gắn cookie, kiểm `iss`, `client_secret_basic`, verify ID token phía RP (RS256, iss, aud, azp, exp, nonce — INV-6), discovery chỉ tin endpoint cùng origin issuer, `returnTo` allowlist. T3 refresh server single-flight không retry, guard theo vai trò qua `/admin/me`, step-up đổi `sub`/tenant ⇒ huỷ cả hai phiên (DEBT-117). T4 logout POST same-origin ⇒ `end_session` + `id_token_hint`; E2E đăng nhập fe-admin thật.
- **Bug đã sửa**: (senior REJECT 1) thiếu test âm discovery + azp; DEBT-286 (dọn cookie / revoke RT khi callback lỗi giữa chừng), DEBT-287 (phiên chưa có tenant bị đăng xuất nhầm).
- **Verify**: fe-admin 237/237, be 401, fe-sso-test 269, E2E 25/25 ×2 (0 rò rỉ `eyJ`/`code=`/secret), audit high 0; mutation RED.
- **Commit**: `9d2de22`.
- **Vòng lặp**: tech-lead=1, FE dev=2, senior=2 (REJECT → PASS), tester=1.
- **Debt**: đóng DEBT-117/265/274/275/277/286/287; mở DEBT-278–285, 288, 289.
