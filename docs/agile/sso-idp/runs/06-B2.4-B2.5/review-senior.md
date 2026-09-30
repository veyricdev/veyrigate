# Senior Review — 2026-09-30
## Kết luận: PASS

## Tổng quan
Vòng sửa ngoại lệ đã đóng đủ hai blocker cuối. DTO cho phép `_csrf` thiếu đi tới `CsrfGuard`, nên cả thiếu và sai token đều thành trang HTML 403 trên toàn bộ sáu POST. Test concurrency mới gửi 10 request HTTP thật qua `UiController` và `RateLimitService` thật với limit 20. Luồng request register → mail link → GET không consume → POST verify → login tạo Redis session thật → GET logout không revoke → POST logout revoke và ghi Mongo audit cũng đã chạy với Mongo/Redis/session/audit thật; mailer fixture là dependency phù hợp để bắt link xác định. Toàn bộ acceptance B2.4–B2.5 và C1–C14 không còn blocker.

## 🔴 Blocker
- Không có.

## 🟡 Nên sửa
- [ ] **Test dư không được test runner chạy**
  `be/test/ui-auth.e2e-int-spec.ts:95-127` — file này lặp lại `ui-auth.int-spec.ts` nhưng tên không khớp regex `\.int-spec\.ts$`, nên không nằm trong 75 integration tests; đồng thời còn kỳ vọng POST register/verify trả 200 trong khi request thật trả 201.
  Vì sao: một bản test E2E không chạy và đã lệch contract dễ tạo cảm giác bao phủ giả, nhất là khi file chạy thật đã chứng minh đúng flow.
  Đề xuất: xoá file dư và giữ `ui-auth.int-spec.ts` làm nguồn kiểm thử duy nhất (DEBT-018).

## 💭 Nit
- Không có.

## Kiểm tra hai blocker vòng 2
- **CSRF 403**: PASS — `_csrf` optional ở DTO nhưng bắt buộc trong `CsrfGuard`; bảng test request kiểm thiếu và sai token trên `/register`, `/login`, `/forgot`, `/verify-email`, `/reset`, `/logout`, đều HTML 403 và không gọi action.
- **HTTP login concurrency**: PASS — 10 POST `/login` đồng thời đi qua controller, CSRF và `RateLimitService` thật; cấu hình limit 20; cả 10 trả 401 và Mongo lưu `failedLoginCount = 10`.
- **Request E2E**: PASS — Mongo/Redis/User/Auth/Session/RateLimit/Audit thật; mailer fixture chỉ bắt outbound message. GET verify không consume; POST verify thành công; login tạo session thật; GET logout giữ session; POST logout xoá session và có `SESSION_REVOKED` audit.

## Đối chiếu acceptance và C1–C14
- **B2.4**: PASS — token hash + atomic single-use, register race đồng nhất, lockout atomic/audit một lần, enumeration/timing path, session rotation, reset revoke-all và audit đều có code/test.
- **B2.5**: PASS — SSR templates, CSP/escape, CSRF mọi POST, safe `returnTo`, HTML/OAuth error split và GET/POST logout đúng semantics.
- **C1–C5**: PASS — URL serializer bỏ query; GET không consume; reset verify + revoke; link từ `ISSUER`; nhánh tồn tại/không tồn tại giữ expensive work và mail async.
- **C6–C10**: PASS — concurrency qua HTTP/rate-limit thật; CSRF/session rotation; dependencies/assets; CSP; open-redirect cases.
- **C11–C14**: PASS — filter HTML/OAuth + 429 code path; DTO bounds/normalize; audit không chứa secret; logout thật revoke + audit và idempotent khi không session.

## ✂️ Ponytail
- `be/test/ui-auth.e2e-int-spec.ts:L1-127`: delete: bản sao E2E không được Jest integration regex thu thập và có assertion status cũ. Giữ `ui-auth.int-spec.ts` đang chạy trong suite.
net: -127 lines possible.

## Kiểm tra đã chạy
- CodeGraph 1.5.0: sync thành công, 3 file thay đổi được cập nhật chỉ mục.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS.
- Unit: PASS — 11 suites, 48 tests.
- Integration: PASS — 9 suites, 75 tests; gồm hai test blocker mới.
- `git diff --check`: PASS; chỉ có cảnh báo chuyển CRLF→LF ở hai file docs, không có whitespace error.

## Bàn giao
**tester** — chạy test gate độc lập cho B2.4–B2.5; lưu ý DEBT-018 không chặn.
