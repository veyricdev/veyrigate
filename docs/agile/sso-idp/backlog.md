# Backlog — sso-idp

Việc còn mở (🟡 từ review/test, debt, việc hoãn). **Nguồn duy nhất** cho việc tồn đọng.
Đóng mục: chuyển sang bảng "Đã đóng", ghi run xử lý. Không xoá.

## Mở

| ID | Nguồn | Mô tả | Gợi ý xử lý | Nên làm ở |
|---|---|---|---|---|
| DEBT-001 | run 03 senior 🟡#1 | `/ready` 503 bị `OAuthExceptionFilter` ép body `{error:"server_error"}` → mất chi tiết `mongo`/`redis` | Trả 503 trực tiếp qua reply hoặc filter riêng cho health | B1.6–B1.10 hoặc B7.2 |
| DEBT-002 | run 03 senior 🟡#2 | `config.module.ts` gọi `validateEnv` 2 lần lúc boot | Gộp `validate` + `load` | lần chạm config kế tiếp |
| DEBT-003 | run 03 test | Chưa verify case Mongo down với `/ready` | Thêm case khi làm B7.1 | B7.1 |
| DEBT-004 | run 02 | Job CI `e2e` đang placeholder | Bật thật | B7.1 / X1 |
| DEBT-005 | run 04 tech-lead | Rate-limit (và mọi lệnh Redis) có thể treo khi Redis down do client chung `maxRetriesPerRequest: null` | Timeout/fail-fast cho lệnh trên đường request, đúng §6.2 | B7.3 |
| DEBT-006 | run 04 senior 🟡#2 | Rate-limit chiều IP dùng `req.ip`; Fastify chưa bật `trustProxy` → sau reverse proxy mọi request cùng IP | Bật `trustProxy` theo danh sách proxy tin cậy (env) khi có gateway | B7.x (deploy) |
| DEBT-007 | run 04 senior 🟡#3 | `LocalKeyProvider.rotate()` xoá PEM trước khi ghi `keys.json` → lỗi ghi giữa chừng làm hỏng state key (dev-only) | Ghi state trước (atomic rename) rồi mới xoá PEM; hoặc bỏ qua khi thay bằng KeyProvider thật | B7.3 |

## Đã đóng

| ID | Đóng ở run | Ghi chú |
|---|---|---|
