# Tech Lead Review — 2026-10-06 — Run 10 — B4.1 (`/authorize`)

## Kết luận: PASS

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc tổng thể. Giữ nguyên: NestJS module `oauth` (hiện là stub rỗng) chứa
`AuthorizeController` + `AuthorizeRequestContextService` (Redis), tái dùng `ClientsModule`,
`ResourcesModule`, `SessionsModule`, `UiModule`. Modular monolith hiện tại phù hợp quy mô —
không cần tách service riêng cho `/authorize`.

## Điểm mạnh

- Phạm vi tasks.md bám đúng plan §B4.1 + spec §9.1–9.2/§13 bước 6, cắt rõ ranh giới với
  B4.2 (consent)/B4.3 (code store)/B4.4 (token) — không có over-engineering, không phát
  code/token ở bước này.
- Các phụ thuộc hạ tầng đã tồn tại và đúng đường: `redirect-uri.validator.ts`
  (`isRegisteredRedirectUri`, exact-match, không normalise) và `ResourceService.resolveForClient`
  (map `identifier → resourceId` rồi so trong `allowedResourceIds`, không so URI trực tiếp) —
  cả hai đã viết sẵn đúng tinh thần INV-4/INV-14, B4.1 chỉ cần gọi lại, không viết lại.
  `SessionService.get()` trả `authTime` (ms epoch) đủ cho check `max_age`/D3.
  `RedisService` + `loadLuaScripts` (B1.4) tái dùng được cho single-use consume của
  `AuthorizeRequestContext` theo đúng pattern `session.service.ts`/`rate-limit.service.ts`.
- Chống open-redirect (INV-3) được tasks.md diễn đạt đúng: lỗi trước khi `client_id`+
  `redirect_uri` hợp lệ ⇒ trang lỗi (dùng lại `HtmlExceptionFilter`/`error.eta` đã có từ B2.5),
  không redirect; lỗi sau đó ⇒ redirect kèm `error`/`state`/`iss`.
- PKCE `plain` reject và `resource` map qua identifier được nêu rõ, đúng INV-14/INV-15 (một
  grant chỉ bind 1 resource — ngầm định do `resource` là chuỗi đơn trong `AuthorizeRequestContext`
  §9.1, tasks.md không nói sai).
- DEBT trong phạm vi (DEBT-015, DEBT-019, DEBT-020) được dẫn chiếu đúng, không bỏ qua.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có — PASS với điều kiện Cn dưới đây (dev phải thoả, không coi là REJECT).

## Điều kiện (Cn) — dev phải thoả khi triển khai

- **C1 (wiring module)**: `ClientsModule` và `ResourcesModule` hiện **chưa được import** vào
  `AppModule` (`be/src/app.module.ts`); `OauthModule` hiện là `@Module({})` rỗng. B4.1 phải:
  tạo `AuthorizeController`/`AuthorizeRequestContextService` trong `OauthModule`, import
  `ClientsModule`, `ResourcesModule`, `SessionsModule` (export cần có `SessionService`),
  `UiModule` hoặc phần dùng chung của nó (CSRF/`safeReturnTo`), rồi import `OauthModule` vào
  `AppModule`. Đây là điều kiện bắt buộc, không phải optional.
- **C2 (route `/authorize` không dùng `OAuthExceptionFilter` cho nhánh trang lỗi)**: `main.ts`
  đăng ký `OAuthExceptionFilter` là `APP_FILTER` toàn cục (trả JSON `{error, error_description}`).
  Nhánh "lỗi trước khi redirect_uri hợp lệ ⇒ trang lỗi HTML" của `/authorize` phải tự `@UseFilters
  (HtmlExceptionFilter)` ở controller (như `UiController`) hoặc tự render `error.eta`, nếu không
  sẽ trả JSON thay vì trang lỗi — vi phạm chính yêu cầu chống open-redirect của tasks.md.
- **C3 (TTL/single-use `AuthorizeRequestContext`)**: dùng Lua script atomic get-and-delete (một
  lệnh `GET`+`DEL` riêng rẽ có race giữa 2 request đồng thời dùng cùng `request_id`) — theo đúng
  pattern Lua đã có ở `session.service.ts`/`rate-limit.service.ts`, không tự chế cơ chế mới.
  TTL 5–10 phút set tại tạo; không gia hạn khi đọc (khác hẳn session idle-sliding).
- **C4 (prompt=none)**: khi `prompt=none` và chưa có session hợp lệ ⇒ trả lỗi `login_required`
  qua redirect (không redirect sang `/login`); tương tự thiếu consent + `prompt=none` ⇒
  `consent_required` (giao cho B4.2 xử lý chi tiết, B4.1 chỉ cần trả khung lỗi đúng mã).
- **C5 (CORS, DEBT-019/020)**: `/authorize` là redirect GET từ browser, không phải fetch có
  preflight CORS — xác nhận rõ trong code/test rằng DEBT-019/020 **không** thuộc phạm vi B4.1
  (giữ nguyên cho B4.4/B4.6 như tasks.md đã ghi), không cần wire `@fastify/cors` ở đây.
- **C6 (CSP `form-action`, DEBT-015)**: vì B4.1 dùng `302` redirect GET tới `redirect_uri`
  (không POST form sang RP), xác nhận và ghi chú rõ trong code/PR rằng `helmet` CSP
  `form-action 'self'` (main.ts) không chặn luồng này ⇒ DEBT-015 giữ nguyên, không cần sửa ở
  B4.1 — đúng như tasks.md đã dự đoán, nhưng cần dev xác nhận bằng test thực tế (curl theo
  redirect, không chỉ đọc code).
- **C7 (audit)**: ghi `AuditAction.OAUTH_AUTHORIZE` (đã có trong enum) khi tạo
  `AuthorizeRequestContext` thành công, không log `code_challenge`/giá trị nhạy cảm khác
  (INV-20).
- **C8 (test state/nonce opaque)**: test phải xác nhận IdP không dùng `state` của RP làm khoá
  tra cứu nội bộ (spec §9.1) — tức `request_id` sinh riêng, không derive/equal với `state`.

## Đề xuất (không bắt buộc)

- Xem xét thêm 1 test "2 request `/authorize` cùng `request_id`" (không áp dụng vì `request_id`
  chỉ sinh nội bộ ở B4.1 khi tạo context — nhưng nếu B4.1 đã hỗ trợ resume qua federation
  (B5.2 sau), nên để sẵn chỗ test contract cho round-trip single-use.
- `backlog.md`: không có mục mới cần thêm — các DEBT liên quan đã được tasks.md xử lý đúng
  (xác nhận applicable/not-applicable), không phát sinh nợ mới ở review này.