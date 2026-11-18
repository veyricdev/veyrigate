# Tech Lead Review — 2026-11-18

## Kết luận: PASS

Ba task đúng vấn đề, nhỏ, không cần analyst. Có điều chỉnh, ghi ở `tasks.md` § "Quyết định D95.x" (D95.1–D95.21). Dev làm theo D95.x khi mô tả task khác.

## Kiến trúc đề xuất (điều chỉnh)

**T1, `admin-recover` thu hồi phiên**
- Chỉ áp cho `--reset-mfa` (D95.2). Recover thường và `--unlock` không cần: khoá admin đã thu hồi phiên lúc khoá.
- Không dùng Nest standalone context. Dựng `ConfigService(buildConfig(env))` → `createRedisClient` → `RedisService` → `SessionService.revokeAllForUser`: đúng bước `sessions` của API, giữ timeout và Sentinel (D95.3).
- Sau Redis: quên thiết bị tin cậy, rồi sweep families lần hai, như API.
- Bước Redis chạy sau commit Mongo, bị chặn 10 s.
- Exit code `3` = Mongo đã commit, Redis/sweep chưa xong (D95.5).
- Audit `SESSION_REVOKED {via: 'admin_recover', count}`: `ADMIN_RECOVERED` nằm trong transaction nên không chứa được số phiên (D95.6).

**T2, trần hàng đợi mail**
- Hằng `MAX_PENDING_MAIL = 200`. Đếm in-flight tự quản bằng `pending`, `try/finally`.
- Metric: gauge `sso_mail_queue_depth` + counter `sso_mail_dropped_total{reason=queue_full|shutdown}`, alert `SsoMailDropped`.
- Mailer **không** gọi `observeBackgroundWriteFailure`: caller `issueToken` đã đếm `auth_mail`, gọi thêm là đếm đôi.

**T3, 303 sau POST form**
- Quy tắc: mọi redirect từ handler `@Post` (UI, consent, `/auth/link`, `/logout`) ⇒ 303; mọi `@Get` giữ 302.
- Liệt kê đủ file:line và các helper dùng chung cần tham số `status` (`backToLogin`, `handleError`) (D95.15).
- Danh sách test cần sửa ở D95.16.

## Điểm mạnh
- Task nêu rõ failure semantics mong muốn ở T1 (best-effort, exit code riêng) và hạn chế không đọc nội bộ nodemailer ở T2.
- Ràng buộc hạ tầng, secret, thứ tự harness/SMTP giữ đúng run 94.
- Mọi call site `mailer.send` đều fire-and-forget (đã kiểm). Reject khi đầy không lan ra request.

## Security design gate (T1 chạm trust boundary)
- **Tài sản**: phiên SSO Redis của user bị reset MFA. **Actor**: hai người vận hành, CLI chạy với env app.
- **Invariant**: sau exit 0, không còn `sess:*` của user và mọi `sid` cũ có tombstone `sess_end`; phiên user khác không bị đụng (test D95.7-2).
- **Abuse**: phiên cũ trên thiết bị bị mất tiếp tục SSO tới RP khác. Đóng bằng revoke + tombstone. Family tạo giữa commit và revoke bị sweep chặn.
- **Failure**: Redis không tới được ⇒ fail-open có kiểm soát: Mongo đã đổi, exit 3, dòng cố định, audit failure, runbook bắt buộc thu hồi qua API hoặc qua việc enroll MFA. Trong lúc Redis chết thì phiên cũ cũng không dùng được.
- **Exposure**: output không email, không chi tiết lỗi Redis (URI có thể chứa mật khẩu). Audit qua `sanitizeMetadata`.

## Vấn đề (đã sửa trong tasks.md, không REJECT)
- [x] AC T1 "SSO tới RP khác phải đăng nhập lại" không đo trực tiếp được trong int CLI ⇒ đổi thành `sessions.get === null` + tombstone + `user_sess` rỗng + phiên user khác còn sống (D95.7).
- [x] T2 "`observeBackgroundWriteFailure('auth_mail')` trong mailer" sẽ đếm đôi với `issueToken` ⇒ counter riêng `sso_mail_dropped_total` (D95.10/D95.11).
- [x] T3 "chỉ redirect có credential" để lại vùng mơ hồ (`/logout`, `/account/*` khi hết phiên) ⇒ quy tắc theo HTTP method (D95.15).
- [x] T1 câu "nếu Redis lỗi ⇒ bắt buộc gọi API revoke" không làm được khi không còn admin nào (đúng là lý do dùng CLI) ⇒ thêm đường enroll MFA (D95.8).

## Đề xuất (không bắt buộc)
- DEBT-691: `--revoke-sessions-only` nếu ops thực tế cần chạy lại riêng bước Redis.
- Danh sách int spec ở D95.16 là danh sách ứng viên. Danh sách chính xác lấy từ int FULL đỏ sau khi đổi BE.
