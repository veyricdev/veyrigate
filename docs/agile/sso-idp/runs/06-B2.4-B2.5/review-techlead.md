# Tech Lead Review — 2026-09-29
## Kết luận: PASS (có điều kiện C1–C14 — backend-dev bắt buộc tuân, senior-reviewer kiểm)

Phạm vi đúng plan §5.B2 (B2.4, B2.5) + DEBT-009/010/011/012/014. A1–A8 giữ nguyên (A6 do người dùng chốt: `eta` + `@fastify/view`, Tailwind CLI build tĩnh). Không cần quay lại analyst: các điểm dưới là ràng buộc triển khai, không đổi phạm vi.

## Kiến trúc đề xuất
Giữ modular monolith hiện tại. `AuthenticationModule` (service, không phụ thuộc HTTP) ← `UiModule`/controller HTML (B2.5). CSRF + filter HTML là thành phần dùng chung của controller UI, không đặt global.

## Điểm mạnh
- Token verify/reset atomic single-use theo đúng §9.5; `SessionService.establish` đã có sẵn cho INV-17.
- Giả định chống enumeration (A3, A5, A8) và open-redirect (A1) đã nêu rõ, có tiêu chí nghiệm thu đo được.
- Đã kéo đúng các DEBT liên quan vào run.

## Điều kiện bắt buộc (dev tuân, senior/tester kiểm)
- [ ] **C1 — Token lọt log (INV-20)**: `pino-http` mặc định log `req.url` kèm query (`LoggerModule` chưa có serializer). Link `?token=` sẽ lọt vào log. Thêm serializer `req` bỏ query string (ít nhất với route verify/reset) + test log không chứa token. Không được hạ `Referrer-Policy` của helmet (mặc định `no-referrer`).
- [ ] **C2 — GET không tiêu token**: bộ quét link email/prefetch gọi GET. `GET /verify-email?token=` và `GET /reset?token=` chỉ render form (token nằm trong hidden field); consume ở **POST** (khớp spec §11: POST). Với reset: validate mật khẩu mới **trước** rồi mới consume token + set hash.
- [ ] **C3 — Chiếm tài khoản trước (pre-account hijack)**: reset password thành công ⇒ đặt `emailVerifiedAt` (chứng minh sở hữu hộp thư), `resetFailedLogins`, `revokeAllForUser` + audit. Như vậy chủ thật lấy lại được email mà kẻ tấn công đã đăng ký trước bằng email đó (A5 không tạo user mới).
- [ ] **C4 — Link email dựng từ `ISSUER`** (config), tuyệt đối không từ `Host`/`X-Forwarded-Host` (chống host-header poisoning). Test: request với `Host: evil` → link vẫn trỏ về ISSUER.
- [ ] **C5 — Không lộ qua timing (INV-27)**: register/forgot thực hiện cùng lượng việc nặng ở 2 nhánh (register email trùng vẫn chạy argon2 hash giả). Gửi mail **không await** trên đường request (fire-and-forget, `.catch` → log không chứa link/token) ở mọi nhánh.
- [ ] **C6 — Lockout atomic, ngữ nghĩa rõ**: một lệnh `findOneAndUpdate` dạng update pipeline: nếu `lockedUntil` đã hết hạn thì `failedLoginCount = 1`, ngược lại `+1`; nếu đạt ≥5 và chưa khoá thì đặt `lockedUntil = now+15'` (chỉ audit `AUTH_ACCOUNT_LOCKED` lần chuyển sang khoá). Đang khoá: vẫn chạy argon2 (A8), cùng thông điệp. Test song song 10 request phải cấu hình rate-limit đủ rộng để 10 request tới được service.
- [ ] **C7 — CSRF (A7)**: token = HMAC(`CSRF_SECRET`, id phiên *hoặc* cookie anonymous), so sánh `constantTimeEqual`. Cookie anonymous: `HttpOnly; SameSite=Lax; Path=/`, `Secure` theo `SESSION_COOKIE_SECURE`, giá trị `generateToken()`. **Form login cũng phải có CSRF** (login-CSRF). Sau login, token tính lại theo session mới. Trường `_csrf` phải nằm trong DTO (vì `forbidNonWhitelisted`).
- [ ] **C8 — Phụ thuộc còn thiếu**: cần `@fastify/formbody` (form `application/x-www-form-urlencoded`), `@fastify/view`, `eta`, `@fastify/static`, devDep `tailwindcss` (+ CLI). Pin version chính xác như các dep hiện tại. `nest-cli.json` phải copy `views/**` sang `dist` (assets), và script `build` chạy `build:css` trước.
- [ ] **C9 — CSP**: helmet mặc định có `style-src ... 'unsafe-inline' https:` → phải **ghi đè đúng** directive của A6 (không merge lỏng hơn). Test header cụ thể + HTML render không có `<script>` inline hay `style=`. Chỉ dùng `<%= %>` (autoEscape) cho dữ liệu người dùng; cấm `<%~` với dữ liệu người dùng.
- [ ] **C10 — `returnTo` (A1)**: chấp nhận khi `new URL(v, ISSUER).origin === origin(ISSUER)` **và** `v` bắt đầu bằng `/`, không bắt đầu `//` hoặc `/\`, không chứa `\`, CR/LF. Test thêm `/\evil.com`, `/%0d%0a`, `javascript:`.
- [ ] **C11 — DEBT-009**: dùng `HtmlExceptionFilter` ở cấp controller UI (`@UseFilters`, ưu tiên hơn filter global). Trang lỗi không phản chiếu message nội bộ; lỗi validation → render lại form với thông điệp chung; 429 → trang HTML và giữ `Retry-After`. `OAuthExceptionFilter` giữ nguyên cho endpoint OAuth + test hồi quy cho cả hai loại.
- [ ] **C12 — Chính sách mật khẩu**: DTO độ dài tối thiểu (≥ 8) và **tối đa** (≤ 128) để chống DoS bằng argon2; email bắt buộc `IsEmail` + normalize (`normalizeEmail`).
- [ ] **C13 — Audit (INV-25, DEBT-011)**: thêm `SESSION_CREATED`, `SESSION_REVOKED` (+ action cho verify/reset nếu dùng) vào `AuditAction`; metadata không chứa email thô, mật khẩu, token, cookie. `AUTH_LOGIN_FAILED` với email không tồn tại: không ghi `targetId`.
- [ ] **C14 — `POST /logout`**: CSRF → `revoke` + `clear` cookie + audit → 302 về trang đã logout; không có session cũng trả cùng 302 (idempotent). `GET /logout` không gọi bất kỳ hàm revoke nào (có test).

## Đề xuất (không bắt buộc)
- Gom 2 schema one-time-token vào một service nhỏ `OneTimeTokenService.issue/consume(kind)` — tránh nhân đôi code, không cần hơn.
- Rủi ro chuyển sang backlog: DEBT-015 (CSP `form-action` vs redirect về RP), DEBT-016 (lockout bị dùng để DoS tài khoản), DEBT-017 (B5.3 không link vào tài khoản local chưa verify).
