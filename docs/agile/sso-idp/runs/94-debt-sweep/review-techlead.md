# Tech Lead Review — 2026-11-17

## Kết luận: PASS

Task list đúng vấn đề và đủ nhỏ cho một run. Có một điều chỉnh thiết kế bắt buộc ở T1: **không** đổi token ngay khi trang tải. Đổi khi người dùng bấm. Quyết định chi tiết ở `tasks.md` § "Quyết định D94.x" (D94.1–D94.14). Agent làm theo các D94.x đó, không theo câu "Khi trang tải, JS POST" trong mục T1.

## Kiến trúc đề xuất (điều chỉnh)

**T1, vé đặt lại mật khẩu**
- Mail link giữ nguyên `/reset#token=…`.
- Trang đầu có field mã: script điền từ fragment, hoặc người dùng nhập tay. Người dùng bấm **Continue** ⇒ `POST /reset/code`.
- Server đổi token lấy vé trên **cùng document Mongo** (`ticketHash`, TTL 15'). Token gốc chết từ lúc này. Server đặt cookie `__Host-idp_reset` (httpOnly, Lax) và trả `303 /reset`.
- Trang thứ hai là form mật khẩu. `POST /reset` chỉ nhận vé, không nhận token.
- Không dùng Redis, không thêm env, không thêm script.
- `/verify-email` giữ nguyên, chấp nhận có ghi chú (D94.1).

**T2**
- BE dùng nodemailer pool có giới hạn (5 kết nối). Đây là sửa lỗi production, căn cứ đọc code.
- Điều tra bằng SMTP sink trong scratchpad để phân loại lỗi.
- Harness thêm preflight 220, `HYG-MAIL` và `HYG-SMTP-AFTER`.

**T3**: tạo file mới `docs/integration-rp-rs.md`, có link từ `README.md` và spec §8.

**T4**: step trong job `pentest`. Danh sách file đổi lấy bằng `git diff` (PR: `HEAD^1..HEAD`; push: `github.event.before`, fail-safe ⇒ chạy). Không thêm action mới.

## Điểm mạnh
- Ràng buộc hạ tầng và secret rõ ràng, khớp quy ước run 92–93.
- T2 có chẩn đoán sẵn (Recv-Q 845, HTTP vẫn sống) và mục tiêu đo được (220 sau harness).
- T4 đã nghĩ tới việc không thêm action mới.
- Thứ tự lô đúng: harness đầy đủ chạy sau E2E.

## Vấn đề (đã fold thành D94.x, không REJECT)

- [x] **T1: đổi token khi trang tải là lỗi production.** Trình quét link trong mail có chạy JS (sandbox kiểu Safe Links) sẽ tiêu thụ token trước người dùng. Link đặt lại khi đó chết với mọi người dùng doanh nghiệp đứng sau bộ quét này. Chỉ thao tác của người dùng mới phân biệt được người với bộ quét ⇒ D94.2.
- [x] **T1: chưa chốt store, cookie, TTL, tương thích, chuỗi request** ⇒ D94.3–D94.7.
  - Store: Mongo cùng document, không Redis, không thêm failure mode.
  - Cookie riêng, không gắn với cookie CSRF ẩn danh: vé tự nó đã là bearer httpOnly, gắn thêm không tăng an toàn.
  - TTL vé 15'.
  - Tab form cũ đang mở lúc deploy ⇒ 400, token còn nguyên.
- [x] **T1: chưa có failure semantics và test âm cụ thể** ⇒ D94.3, D94.8.
  - Năm trường hợp token sai phải trả cùng một thân lỗi: không tồn tại, hết hạn, đã dùng, đã đổi, sai dạng.
  - Đổi token đua song song: đúng một lần thắng.
  - Mongo lỗi ⇒ 5xx, không set cookie.
  - Body hình cũ (`token` + `password`) bị chặn.
- [x] **T1: `/verify-email` có cần vé không.** Không cần: D91.14 khiến token một mình vô dụng nếu không có mật khẩu ⇒ D94.1.
- [x] **T2: thiếu tiêu chí phân biệt lỗi production với tải test, và tiêu chí xong** ⇒ D94.9.
  - Code hiện tại: `void this.mailer.send` × transport không pool ⇒ mỗi thư một kết nối, đồng thời không giới hạn. Đây là rủi ro production, không riêng gì test: MTA thật giới hạn số kết nối mỗi client.
- [x] **T4: path filter chỉ gồm harness.** Sửa file nguồn mà mutant vá (`csrf.service.ts`, …) có thể làm neo `from` lệch mà không ai biết ⇒ thêm 6 file nguồn và `ci.yml` (D94.11).
- [x] **T4: job `pentest` timeout 15' không đủ** chỗ cho mutation ⇒ D94.11.
- [x] **Thiếu runbook deploy cho T1** (index mới, tab cũ, link cũ) ⇒ D94.7.

## Đề xuất (không bắt buộc)
- DEBT-683 (P3): hàng đợi pool nodemailer không giới hạn trong bộ nhớ. Cần cap + metric độ sâu hàng đợi. Hiện tại được chặn gián tiếp bởi throttle `/forgot`/`/register`.
- DEBT-684 (P3), chỉ mở nếu D94.9 rơi vào nhánh (c), tức Mailpit vẫn kẹt khi client đã giới hạn: nâng pin Mailpit (CI v1.21 và container local). Cần người dùng, vì phải tải image.
- Danh sách path T4 trùng với `MUTATIONS[].file`. Ghi comment "giữ đồng bộ" ở cả hai nơi; không tự sinh (YAGNI).
