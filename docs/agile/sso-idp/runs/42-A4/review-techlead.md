# Tech Lead Review — 2026-10-22 — run 42 (A4 đăng nhập OIDC kiểu BFF cho fe-admin)

## Kết luận: PASS (có fold bắt buộc trong `tasks.md` mục "Fold tech-lead")

Plan đúng vấn đề (A4 + D2/Q3 BFF + INV-6 + DEBT-117/265/274/275). Phần còn thiếu ở cổng security (nơi lưu session, failure semantics, CSRF logout, single-flight, step-up) đã được chốt cụ thể và fold thẳng vào `tasks.md`, nên không cần trả về analyst. BE không cần sửa.

## Kiến trúc đề xuất

- Giữ fe-admin là BFF một khối (Start server route + server function). Không thêm service.
- **Session: Redis + ID opaque (Q-42.1, đóng DEBT-265).** Lý do quyết định nằm trong code BE: `RefreshTokenService.rotate` không có grace window, `classifyMiss` coi việc trình lại RT đã xoay là reuse và revoke cả family. Nếu RT nằm trong cookie stateless, hai request song song (hai tab, prefetch) mang cùng cookie sẽ làm admin bị đăng xuất. Ngoài ra AT+RT+id_token sau mã hoá đã sát 4KB và cookie stateless không thu hồi được. Dùng `aegate-redis` sẵn có, prefix `fea:`. Khoá Redis là HMAC(SESSION_SECRET, cookie). Khối token mã hoá AES-GCM.
- **RP lib (Q-42.2): tự viết mỏng + `jose@6.2.12`, thêm `ioredis@6.0.0`.** Cả hai đều đã có trong lockfile (jose ở fe-sso-test, ioredis ở be). Tra registry: jose 6.2.12 phát hành 2026-09-05, ioredis 6.0.0 phát hành 2026-07-31, cả hai ≥14 ngày. Không thêm `openid-client` (6.8.8): BFF chỉ cần khoảng 5 lời gọi, và logic callback/refresh/nonce/iss của fe-sso-test đã có test âm, chỉ cần port sang.
- **Phạm vi (Q-42.3):** giữ 4 task. Không chuyển helper E2E admin (DEBT-242/249 vẫn mở), không làm step-up round-trip (A5), CSP (A7) hay front-channel. Nếu E2E kẹt hạ tầng thì tách riêng phần E2E sang run 43.

## Điểm mạnh

- Bám D2/INV-6: RP tự validate nonce/iss/aud/exp/chữ ký. Có `iss` trong redirect (RFC 9207). PKCE S256. `client_secret_basic`.
- Đưa các debt bắt buộc vào (274/275) và nhận ra DEBT-117 trước khi A5 làm step-up.
- Hạ tầng BE đã sẵn: client `fe-admin` seed đúng redirect/post-logout và có `refresh_token` + `offline_access`; E2E đã có `E2E_FE_ADMIN_SECRET`.

## Vấn đề (đã fold vào tasks.md, frontend-dev phải làm; không phải lý do REJECT)

- [x] Plan ghi "cookie mã hoá stateless" sẽ hỏng vì refresh không có grace. Đã chốt Redis, ghi `SET XX KEEPTTL` (không hồi sinh phiên đã logout) và single-flight trong process, có đọc lại bản ghi trước khi refresh.
- [x] Refresh tuyệt đối không retry, vì retry tức là reuse và family bị revoke. Phân loại lỗi: `invalid_grant` thì xoá phiên; 5xx/timeout thì trả 503 và giữ phiên.
- [x] Redis lỗi thì fail-closed bằng 503, không redirect login, để tránh vòng login tạo phiên IdP hàng loạt.
- [x] Session fixation: luôn cấp ID mới ở callback; phiên cũ chỉ bị huỷ sau khi phiên mới đã được set.
- [x] CSRF callback: giao dịch Redis single-use (`GETDEL`) gắn với cookie `fea_tx` === `state`. Cookie bị xoá ở mọi nhánh.
- [x] CSRF logout: chỉ nhận POST, kiểm same-origin; GET trả 405. `post_logout_redirect_uri` chỉ lấy từ env.
- [x] Open redirect `returnTo`: dùng allowlist đường dẫn tương đối, lưu server-side, không đặt trong `state`.
- [x] Scope plan thiếu `email`: ID token BE không có email, `/admin/me` không có tên. Đã fold scope `email` và gọi `/userinfo` (kiểm `sub` khớp). Nghiệm thu E2E đổi thành "thấy email".
- [x] Step-up (DEBT-117): bắt buộc có `auth_time` mới (max_age=0); `sub` và `tenantId` phải khớp phiên cũ, nếu không thì huỷ cả hai phiên.
- [x] Cookie `__Host-` trên http://localhost: tên và thuộc tính `Secure` theo giao thức của `APP_URL` (https dùng `__Host-fea_sid`, http dùng `fea_sid`). Tên `fea_*` để không đụng `idp_session`/`idp_csrf` (cookie không tách theo port).
- [x] Token lộ qua SSR/serverFn (DEBT-275): wrapper lỗi ở biên + client chỉ nhận view allowlist + test canary/`eyJ`.
- [x] Logout: IdP `GET /logout` chỉ hiển thị form xác nhận, nên E2E phải bấm xác nhận. Hint hết hạn vẫn được BE chấp nhận. Gọi `/revoke` RT best-effort; IdP POST logout cũng revoke family theo `sessionRef`.

## Cổng security design

- **Tài sản:** AT/RT/id_token admin, `client_secret`, cookie phiên. **Actor:** admin, user không phải admin, kẻ tấn công cross-site, người đọc được Redis. **Trust boundary:** trình duyệt ↔ BFF ↔ IdP/Admin API, BFF ↔ Redis dùng chung.
- **Invariant:** token không bao giờ rời server; một callback chỉ tạo đúng một phiên mới; RT chỉ được trình đúng một lần; step-up không đổi danh tính.
- **Abuse case:** replay callback, state/iss/nonce sai, alg confusion, open redirect, logout CSRF, step-up đổi user, refresh song song, logout chen giữa lúc refresh, dump Redis. Mỗi case đã có test âm trong fold.
- **Failure semantics:** Redis, IdP `/token`, `/admin/me`, `/userinfo`, `/revoke`, discovery đều có timeout. Mỗi lỗi đã ghi rõ fail-open hay fail-closed.

## Đề xuất (không bắt buộc; đưa vào backlog)

- DEBT-278: chạy nhiều instance fe-admin cần lock refresh liên process (Redis `SET NX`).
- DEBT-279: fe-admin chưa có front/back-channel logout.
- DEBT-280: Redis production cho fe-admin cần TLS/ACL và tách khỏi Redis của IdP.
- DEBT-281: E2E step-up round-trip qua fe-admin (A5).

## Phân công

- frontend-dev: Task 1 → 2 → 3 → 4.
- backend-dev: không có việc.
