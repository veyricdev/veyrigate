# Senior Review — 2026-09-30
## Kết luận: PASS

## Tổng quan

Thay đổi đúng phạm vi: authenticated home dùng action `/logout` / `Sign out`, còn bốn outcome dùng shared template vẫn giữ mặc định `/login` / `Return to sign in`. Controller chỉ truyền literal server-side; template tiếp tục dùng Eta escaped output và CSP không bị nới. Không có route, service, abstraction hay dependency mới.

Test độc lập xác nhận `ui.int-spec.ts` 57/57, `ui-auth.int-spec.ts` 3/3, unit 48/48; lint, typecheck và `git diff --check` đều exit 0. Warning hiện có chỉ là Jest 30/ts-jest compatibility và VM Modules experimental.

## 🔴 Blocker

- Không có.

## Security invariants / trust boundaries đã kiểm

- **Home/shared action semantics:** live session ở `GET /` chỉ render đúng một link `/logout` với label `Sign out`; shared message outcomes mặc định đúng một link `/login`, không nhận URL/label từ request.
- **Eta escaping/CSP:** `title` và `message` độc hại được encode thành text; không sinh thẻ `<img>`/`<script>`. Response authenticated home giữ `script-src 'self'`, `style-src 'self'`, `form-action 'self'`, không `unsafe-inline`, inline script hoặc style.
- **GET không mutation:** `GET /logout` chỉ render confirmation; không lookup/revoke/audit session, không clear cookie hoặc redirect.
- **POST CSRF:** thiếu/sai token và token session A replay với cookie session B đều 403 trước controller work; không lookup/revoke/audit, không clear cookie/Location, A và B giữ nguyên.
- **Success/order:** POST hợp lệ thực hiện `get → revoke → audit → clear → redirect`; audit dùng đúng user/session ref; response chỉ redirect cố định tới `/login?loggedOut=1`, và cookie cũ không còn xác thực ở request kế tiếp.
- **Failure/partial state:** lỗi get/revoke trả 5xx trước mutation tiếp theo; lỗi audit sau revoke giữ trạng thái `revoked+unaudited` nhưng không clear cookie, redirect hoặc báo thành công. Dependency errors không bị đổi thành guest/success.
- **Retry/idempotency:** retry tuần tự với cùng cookie+CSRF giữ session revoked, revoke lần hai là no-op theo contract, không ghi audit success lần hai, vẫn clear cookie và trả redirect cố định.
- **Redirect/exposure:** `returnTo` và `redirect_uri` độc hại trên POST logout không ảnh hưởng `Location`; response không lộ session ID, CSRF, cookie hoặc dependency detail ngoài contract.

## 🟡 Nên sửa

- Không có.

## 💭 Nit

- Không có.

## ✂️ Ponytail

Lean already. Ship.