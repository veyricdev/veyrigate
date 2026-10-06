# Backlog — sso-idp

Việc còn mở (🟡 từ review/test, debt, việc hoãn). **Nguồn duy nhất** cho việc tồn đọng.
Đóng mục: chuyển sang bảng "Đã đóng", ghi run xử lý. Không xoá.

## Mở

| ID | Nguồn | Mô tả | Gợi ý xử lý | Nên làm ở |
|---|---|---|---|---|
| DEBT-001 | run 03 senior 🟡#1 | `/ready` 503 bị `OAuthExceptionFilter` ép body `{error:"server_error"}` → mất chi tiết `mongo`/`redis` | Trả 503 trực tiếp qua reply hoặc filter riêng cho health | B1.6–B1.10 hoặc B7.2 |
| DEBT-003 | run 03 test | Chưa verify case Mongo down với `/ready` | Thêm case khi làm B7.1 | B7.1 |
| DEBT-004 | run 02 | Job CI `e2e` đang placeholder | Bật thật | B7.1 / X1 |
| DEBT-005 | run 04 tech-lead | Rate-limit (và mọi lệnh Redis) có thể treo khi Redis down do client chung `maxRetriesPerRequest: null` | Timeout/fail-fast cho lệnh trên đường request, đúng §6.2 | B7.3 |
| DEBT-006 | run 04 senior 🟡#2 | Rate-limit chiều IP dùng `req.ip`; Fastify chưa bật `trustProxy` → sau reverse proxy mọi request cùng IP | Bật `trustProxy` theo danh sách proxy tin cậy (env) khi có gateway | B7.x (deploy) |
| DEBT-007 | run 04 senior 🟡#3 | `LocalKeyProvider.rotate()` xoá PEM trước khi ghi `keys.json` → lỗi ghi giữa chừng làm hỏng state key (dev-only) | Ghi state trước (atomic rename) rồi mới xoá PEM; hoặc bỏ qua khi thay bằng KeyProvider thật | B7.3 |
| DEBT-008 | run 05 tech-lead | Cookie session chưa dùng prefix `__Host-` (chống ghi đè cookie từ subdomain) | `__Host-idp_session` khi `Secure=true`; kiểm cùng ma trận cookie | X3 |
| DEBT-013 | run 05 senior 🟡#2 | Session layout không chạy được trên Redis Cluster: Lua `sessionRevokeAll` truy cập key `sess:*` không khai báo trong KEYS; `MULTI` ở `create`/`revokeRef` trộn `sess:<ref>` + `user_sess:<userId>` khác slot → CROSSSLOT | Nếu Q5 chọn Cluster: bỏ atomic cross-key (DEL từng key, index chấp nhận stale + prune) hoặc thiết kế lại key; Sentinel thì giữ nguyên | B7.3 (theo Q5) |
| DEBT-015 | run 06 tech-lead | CSP `form-action 'self'` (A6) có thể chặn chuỗi redirect sau POST form sang `redirect_uri` của RP ở một số trình duyệt | Khi làm B4.1/B4.2: thêm origin RP đã đăng ký vào `form-action` của response đó, hoặc dùng redirect GET trung gian; test trên Chrome/Firefox/Safari | B4.1 / B4.2 |
| DEBT-016 | run 06 tech-lead | Lockout theo tài khoản (A3) cho phép kẻ tấn công cố ý khoá tài khoản nạn nhân (DoS) | Cân nhắc khoá theo (account+IP/device), CAPTCHA/step-up thay vì khoá cứng; mở khoá qua reset password | B7.x |
| DEBT-017 | run 06 tech-lead | Tài khoản local chưa verify email có thể do kẻ tấn công tạo trước (pre-account hijack) | B5.3: không link/merge federated identity vào tài khoản local chưa verify; cân nhắc xoá user chưa verify sau TTL | B5.3 |
| DEBT-019 | run 09 senior 🟡#1 | `@fastify/cors` thêm vào `be/package.json` (C5) nhưng chưa dùng ở bất kỳ đâu trong `src/` — B3.4 mới dừng ở primitive `ClientCorsService`, chưa wire HTTP | Khi làm B4: dùng `@fastify/cors` hoặc hook thủ công đúng mapping đã tả trong `client-cors.service.ts`; nếu chọn tự viết hook thì gỡ dependency thừa | B4 |
| DEBT-020 | run 09 senior 🟡#2 | `ClientSchema` chưa có index trên `allowedCorsOrigins` — `isOriginRegisteredForAnyClient` full-scan collection `Client` mỗi lần preflight/jwks/discovery | Thêm `ClientSchema.index({ allowedCorsOrigins: 1 })` khi B4 wire thật và có traffic để đo | B4 |
| DEBT-021 | run 09 senior 🟡#3 | `ClientCredentialService.rotateSecret` không atomic dưới concurrent rotate trên cùng `clientId` — `nextVersion` tính bằng `Math.max` sau khi load, hai lời gọi đồng thời có thể trùng version (index `{clientId,version}` không unique) | Ghi rõ giới hạn trong code; cân nhắc unique index `(clientId, version)` khi có admin API thật | B6.3 |

## Đã đóng

| ID | Đóng ở run | Ghi chú |
|---|---|---|
| DEBT-002 | 05 | `validate` bỏ, chỉ còn `load: validateEnv` (1 lần, vẫn fail-fast) |
| DEBT-009 | 06 | UI dùng `HtmlExceptionFilter`; OAuth filter global giữ nguyên. |
| DEBT-010 | 06 | `passwordHash` select false; auth chọn tường minh; membership status có enum. |
| DEBT-011 | 06 | Login/logout ghi `SESSION_CREATED`/`SESSION_REVOKED`. |
| DEBT-012 | 06 | Đổi email unset xác minh; integration test bao phủ. |
| DEBT-014 | 06 | Update pipeline atomic; integration test 10 cập nhật song song. |
| DEBT-018 | 06 | Xoá artifact test trùng; nguồn là dirty VS Code buffer save-back, không có task/watcher/config repo tạo file. |
