# Tech Lead Review — 2026-09-30
## Kết luận: PASS

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ modular monolith và UI server-rendered hiện có. Bug chỉ cần action tùy chọn trong `message.eta`, với default server-side `/login` / `Return to sign in`, và `UiController.home()` truyền literal `/logout` / `Sign out`; không thêm route, service, abstraction, parser DOM hay dependency.

## Điểm mạnh

- Blocker replay đã được đóng bằng case token hợp lệ của session A gửi với cookie session B: 403 trước controller, A/B giữ nguyên, không lookup/revoke/audit, không clear cookie hoặc redirect. Acceptance khớp binding HMAC theo identity trong `CsrfGuard`.
- Failure semantics bám đúng thứ tự code hiện tại `sessions.get → sessions.revoke → audit.record → clear → redirect`: lỗi get/revoke không mutation tiếp; lỗi audit giữ partial state revoked nhưng trả 5xx, không giả success, không clear/redirect.
- Retry tuần tự được giới hạn và đo được: cùng cookie+CSRF trả lại 302; revoke no-op lần hai theo contract `SessionService.revoke`; audit success không lặp vì `get` trả `null`. Plan chủ động bỏ claim concurrency ngoài phạm vi.
- Không thêm DOM parser/dependency: escaping và semantic link dùng assertion chuỗi/regex hiện hữu; action constants không nhận dữ liệu request.
- Scope bounded trong `UiController.home()`, `message.eta` và `ui.int-spec.ts`; không thêm route, service hay abstraction. Kiến trúc modular monolith hiện tại là đủ.
- Các bước có RED riêng, GREEN đích, integration thật và regression; acceptance bao phủ GET không mutation, CSP, open-redirect probes và request kế tiếp sau logout.

## Vấn đề (bắt buộc sửa nếu REJECT)

- Không có.

## Đề xuất (không bắt buộc)

- Gộp các failure cases trong một `it.each` nhỏ nếu setup giống nhau; không nhân chéo dependency × payload × session state.