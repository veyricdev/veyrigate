# Bugfix — guest routes respect authenticated session

Nguồn yêu cầu (nguyên văn): “Giữ thiết kế người dùng đã duyệt nhưng làm rõ semantics: Redis/session lookup error phải fail closed 5xx, không giả guest; phân biệt absent cookie vs stale/expired cookie; stale cookie clear đúng options rồi render/redirect không loop; ma trận GET /, /login, /register cho valid/absent/stale; không đổi verify/reset/forgot/consent/logout.”

Liên quan: spec §9.6; plan B2.5; `review-techlead.md`. Phạm vi chỉ `GET /`, `GET /login`, `GET /register`; không thêm guard/interceptor/abstraction và không đổi verify/reset/forgot/consent/logout.

## Semantics bắt buộc

- **Absent**: request không gửi `idp_session` (kể cả cookie đã hết hạn phía trình duyệt nên không được gửi); là guest, không gọi `sessions.get()` và không phát `Set-Cookie` xóa session.
- **Live**: request gửi cookie và `await sessions.get(id)` trả session; là authenticated, không clear cookie.
- **Stale**: request gửi cookie nhưng `await sessions.get(id)` trả `null` (revoked/idle-expired/absolute-expired); gọi `SessionCookie.clear()` đúng một lần, không gọi `revoke()`.
- **Lookup error**: `sessions.get()` throw (Redis down/corrupt state); lỗi phải propagate thành 5xx, không clear cookie, không render guest, không redirect. Đây là fail closed, không phải stale.
- Ba route phải `async` và chỉ quyết định render/redirect sau khi đã `await` lookup khi cookie hiện diện.

## Ma trận acceptance

| Route | Live | Absent | Stale |
|---|---|---|---|
| `GET /` | 200, body “Signed in”; không clear | 302 `Location: /login`; không `Set-Cookie` session | clear `idp_session`, 302 `Location: /login` |
| `GET /login` | 302 `Location: /`; không clear | 200 form đăng nhập; không `Set-Cookie` session | clear `idp_session`, 200 form đăng nhập |
| `GET /register` | 302 `Location: /`; không clear | 200 form đăng ký; không `Set-Cookie` session | clear `idp_session`, 200 form đăng ký |

Với mọi stale response, `Set-Cookie` phải xóa đúng `idp_session` bằng cùng options của `SessionCookie.clear()` (`Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` theo config, `Max-Age=0`/expired). Chuỗi `GET /` stale → 302 `/login` → follow redirect bằng cookie đã clear phải kết thúc ở 200 login, không lặp `/ ↔ /login`.

### [x] Task 1 [BE]: Thêm integration contract RED cho phân loại session
- Acceptance: test table bao phủ đủ 9 tổ hợp route × live/absent/stale theo ma trận; assert live không bị clear, absent không gọi `sessions.get()` và không clear, stale clear đúng cookie/options và không gọi `revoke()`.
- Verify: `pnpm --filter @sso-idp/be test:int -- --runTestsByPath test/ui.int-spec.ts` thất bại ở assertion hành vi mới, không phải compile/setup.
- Phụ thuộc: không; spec §9.6, plan B2.5.

### [x] Task 2 [BE]: Thêm acceptance fail-closed và chống redirect loop
- Acceptance: khi `sessions.get()` throw, mỗi route có cookie trả 5xx, không có `Location`, không clear `idp_session`, không render form/Signed in; test follow stale `GET /` tới `/login` kết thúc 200.
- Verify: test mục tiêu RED vì behavior assertion mới; case redirect ghi nhận chuỗi trạng thái `302 → 200`, không có redirect tiếp.
- Phụ thuộc: Task 1; `review-techlead.md` mục bắt buộc 1–2.

### [x] Task 3 [BE]: Áp dụng lookup bất đồng bộ bounded trong `UiController`
- Acceptance: `home`, `login`, `register` await cùng một helper private phân loại absent/live/stale; chỉ stale gọi `SessionCookie.clear()`; lookup error propagate; redirect/render đúng ma trận; không thêm guard/interceptor và không gọi `revoke()`.
- Verify: test mục tiêu ở Task 1–2 chuyển GREEN; kiểm diff chỉ chạm logic ba GET route, helper trực tiếp và test liên quan.
- Phụ thuộc: Task 1, Task 2; spec §9.6, plan B2.5.

### [x] Task 4 [BE]: Kiểm chứng bằng Redis thật
- Acceptance: integration với `SessionService`/Redis thật có ít nhất live session (`GET /` = 200; `/login`, `/register` = 302 `/`) và stale/expired session (clear đúng cookie; `/` = 302 `/login`; guest forms = 200).
- Verify: `pnpm --filter @sso-idp/be test:int -- --runTestsByPath test/ui-auth.int-spec.ts` PASS với Mongo/Redis test services sẵn sàng.
- Phụ thuộc: Task 3; spec §9.6.

### [x] Task 5 [BE]: Chạy regression gate và xác nhận ngoài phạm vi
- Acceptance: test hiện có chứng minh GET/POST verify/reset/forgot/consent/logout không đổi; toàn bộ unit + integration PASS.
- Verify: `pnpm --filter @sso-idp/be test` PASS và `pnpm --filter @sso-idp/be test:int` PASS; báo cáo phải ghi rõ RED ban đầu thất bại do assertion behavior mới và GREEN cuối.
- Phụ thuộc: Task 3, Task 4; plan B2.5.