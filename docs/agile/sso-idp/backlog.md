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
| DEBT-009 | run 05 tech-lead | `OAuthExceptionFilter` map mọi 401 → `invalid_client`, sai ngữ nghĩa cho request thiếu session/UI | Phân biệt lỗi OAuth endpoint vs UI/session (redirect login) | B2.5 |
| DEBT-010 | run 05 tech-lead | `UserSchema.passwordHash` chưa `select: false`; `UserTenant.status` chưa có `enum` | Thêm `select:false` (+ `.select('+passwordHash')` ở verify) và enum status | B2.4 |
| DEBT-011 | run 05 tech-lead | Tạo/huỷ session chưa sinh audit event (INV-25) | Thêm action `SESSION_CREATED/REVOKED` khi nối login/logout | B2.4 / B2.5 |
| DEBT-012 | run 05 senior 🟡#1 | `UserService.changeEmail` giữ `emailVerifiedAt` của email cũ → email mới chưa xác minh vẫn hiện "verified" (sai `email_verified`, rủi ro chiếm tài khoản ở RP/federation) | Trong `changeEmail`: `$set:{email}` + `$unset:{emailVerifiedAt:1}`; test đổi email → `emailVerifiedAt` undefined | B2.4 (trước khi có controller đổi email) |
| DEBT-013 | run 05 senior 🟡#2 | Session layout không chạy được trên Redis Cluster: Lua `sessionRevokeAll` truy cập key `sess:*` không khai báo trong KEYS; `MULTI` ở `create`/`revokeRef` trộn `sess:<ref>` + `user_sess:<userId>` khác slot → CROSSSLOT | Nếu Q5 chọn Cluster: bỏ atomic cross-key (DEL từng key, index chấp nhận stale + prune) hoặc thiết kế lại key; Sentinel thì giữ nguyên | B7.3 (theo Q5) |
| DEBT-014 | run 05 senior 🟡#3 | `UserService.updateStatus` chỉ `$set` giá trị tuyệt đối → đếm `failedLoginCount` kiểu đọc-rồi-ghi sẽ mất cập nhật khi login sai song song (lách lockout) | Thêm hàm atomic `recordFailedLogin(sub)` dùng `$inc` + đặt `lockedUntil` theo ngưỡng trong 1 update; `resetFailedLogins` dùng `$set:0,$unset:lockedUntil` | B2.4 |

## Đã đóng

| ID | Đóng ở run | Ghi chú |
|---|---|---|
| DEBT-002 | 05 | `validate` bỏ, chỉ còn `load: validateEnv` (1 lần, vẫn fail-fast) |
