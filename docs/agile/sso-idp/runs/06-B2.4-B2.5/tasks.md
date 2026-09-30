# Phase B — Danh tính & phiên (M2) — run 06: B2.4–B2.5

Nguồn: `plan.md` §5.B2 (B2.4, B2.5), §2 D1 · spec §9.5 (atomic token), §9.6, §9.8 (logout/CSRF), §9.12 (enumeration), §10, §11, §15 (INV-17, 20, 25, 27).
spec.md/plan.md đã có → orchestrator sinh tasks (bỏ qua analyst). Trạng thái: `todo → in-progress → in-review → testing → done`.

**Backlog trong phạm vi**: DEBT-010 (passwordHash `select:false`, enum status), DEBT-011 (audit session), DEBT-012 (changeEmail bỏ verified), DEBT-014 (`$inc` failedLoginCount atomic) → B2.4; DEBT-009 (401 map sai cho UI/session) → B2.5.

**Giả định đã chốt (orchestrator)**:
- A1: Chưa có `/authorize` (B4.1) → sau login thành công redirect về `/` (trang "đã đăng nhập" tối giản). `returnTo` chỉ nhận **đường dẫn tương đối nội bộ** (bắt đầu `/`, không `//`, không scheme) — B4.1 sẽ thay bằng `request_id`.
- A2: Trang **consent** và **logout-confirm** ở B2.5 chỉ là template + route hiển thị; xử lý consent thật ở B4.2 (Q1 chưa chốt). `POST /logout` local (huỷ session hiện tại) làm ở run này; `scope=all`, RP-initiated, revoke refresh family → B4.7.
- A3: Lockout: 5 lần sai → khoá 15 phút (hằng số trong code, không thêm env). Login khi đang khoá trả **cùng thông điệp** với sai mật khẩu (INV-27).
- A4: Token verify email TTL 24h, reset password TTL 30'. Giá trị bí mật chỉ trong link email; DB lưu sha256.
- A5: Register email đã tồn tại → trả cùng response "đã gửi email xác minh" và (tuỳ chọn) gửi email thông báo cho chủ tài khoản; không tạo user mới. Login yêu cầu email đã verify; chưa verify → cùng thông điệp chung.
- A6 (**người dùng chốt**): Template `eta` + `@fastify/view`; CSS **Tailwind CSS** build sẵn bằng Tailwind CLI (script `build:css` → file tĩnh, quét `views/**`), phục vụ qua `@fastify/static`; không dùng CDN/runtime Tailwind. Không inline script/style; CSP `default-src 'self'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'`.
- A7: CSRF: synchronizer token gắn session/anonymous-cookie, HMAC bằng `CSRF_SECRET`; mọi POST form kiểm tra, sai → 403 trang lỗi.
- A8: Chống timing enumeration: login với email không tồn tại vẫn chạy argon2 verify với hash giả.

---

## B2.4 — Authentication `[BE]`
**Phụ thuộc**: B2.2, B2.3, B1.8, B1.10 · **Size**: L · **Trạng thái**: in-review
- [x] DEBT-010: `passwordHash` `select:false` (+ `select('+passwordHash')` chỗ verify); enum `UserTenant.status`
- [x] DEBT-014: `recordFailedLogin` atomic (`$inc` + đặt `lockedUntil` khi chạm ngưỡng trong 1 update); `resetFailedLogins`
- [x] DEBT-012: `changeEmail` `$unset emailVerifiedAt` + test
- [x] `AuthenticationService`: register (argon2, tạo membership `default-tenant`, gửi mail verify), verifyEmail, login (lockout A3, timing A8, gọi `SessionService.establish` → ID mới INV-17), forgotPassword, resetPassword (sau reset: huỷ mọi session của user)
- [x] Token verify/reset: hash sha256, **atomic single-use** `findOneAndUpdate({tokenHash, usedAt:null, expiresAt:{$gt:now}}, {$set:{usedAt:now}})`
- [x] Rate-limit đa chiều (B1.8) trên login/register/forgot/reset; áp **như nhau** dù email tồn tại hay không
- [x] Audit: `AUTH_LOGIN_SUCCESS/FAILED`, `AUTH_ACCOUNT_LOCKED`, + DEBT-011 `SESSION_CREATED/REVOKED`; không log password/token
**Nghiệm thu**: INV-27 · 2 request reset song song cùng token → đúng 1 thành công · 10 login sai song song → `failedLoginCount` = 10 và bị khoá · response register/login/forgot giống hệt nhau giữa email tồn tại/không tồn tại · session ID đổi sau login · email tới Mailpit chứa link hợp lệ.

## B2.5 — UI server-side `[BE]`
**Phụ thuộc**: B2.3, B2.4 · **Size**: L · **Trạng thái**: in-review
- [x] Trang: login, register, verify-result, forgot, reset, consent (shell, A2), logout-confirm, error; dùng layout chung, escape mặc định
- [x] CSRF (A7) cho mọi POST form; CSP chặt (A6), không inline script/style
- [x] `GET /logout` chỉ hiển thị xác nhận (không huỷ session); `POST /logout` + CSRF → huỷ session hiện tại, xoá cookie
- [x] DEBT-009: lỗi trên route UI/session trả trang HTML/redirect login, không bị ép thành `invalid_client`; endpoint OAuth giữ format chuẩn
- [x] Controller nối AuthenticationService; `returnTo` theo A1 (chống open redirect)
**Nghiệm thu**: §9.8 · `GET /logout` không phá session · POST thiếu/sai CSRF → 403 · header CSP đúng, HTML không chứa `<script>` inline/`style=` · `returnTo=https://evil` hoặc `//evil` bị bỏ qua · luồng register → verify (link Mailpit) → login → logout chạy end-to-end.
