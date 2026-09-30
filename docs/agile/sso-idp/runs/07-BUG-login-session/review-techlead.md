# Tech Lead Review — 2026-09-30
## Kết luận: PASS

Kế hoạch đã xử lý đầy đủ các blocker của vòng trước và khớp contract hiện tại của `SessionService.get()`/`SessionCookie.clear()`. Phạm vi thay đổi được giữ trong modular monolith hiện tại và chỉ tác động ba GET route được yêu cầu.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ phương án trong task: một helper private bất đồng bộ, bounded trong `UiController`, phân loại absent/live/stale cho `GET /`, `/login`, `/register`. Không thêm guard, interceptor, service hay abstraction mới. Lỗi lookup được propagate qua error handling hiện có thay vì chuyển thành guest.

## Điểm mạnh

- Khóa rõ fail-closed: Redis/session lookup throw → 5xx, không render, redirect hoặc clear cookie.
- Ma trận 9 tổ hợp absent/live/stale đầy đủ; absent không lookup, stale không revoke, live không clear.
- Cookie stale được kiểm chứng theo đúng contract `SessionCookie.clear()`: tên, path, HttpOnly, SameSite, Secure theo config và Max-Age/expiry.
- Có acceptance chống vòng lặp bằng chuỗi stale `/` → 302 `/login` → 200 sau khi cookie đã clear.
- Route được yêu cầu chuyển sang async và chỉ quyết định response sau `await`; không ảnh hưởng verify/reset/forgot/consent/logout.
- Trình tự RED trước implementation, GREEN test mục tiêu, Redis thật và full regression đều có lệnh cùng kết quả quan sát được.

## Vấn đề (bắt buộc sửa nếu REJECT)

- Không có.

## Đề xuất (không bắt buộc)

- Khi ghi `test-report.md`, trỏ từng gate RED/GREEN tới đúng case thay vì chép toàn bộ output; không mở rộng run để xử lý timeout Redis tổng quát thuộc `DEBT-005`.