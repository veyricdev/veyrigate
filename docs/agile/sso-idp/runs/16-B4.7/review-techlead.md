# Tech Lead Review — 2026-10-10 (run 16, B4.7)

## Kết luận: PASS (kèm chỉnh sửa — đã fold vào tasks.md, đánh dấu *(tech-lead fold)*)

Kiến trúc giữ nguyên **modular monolith** (module `ui` + `sessions` + `oauth/token`), không tách service. Plan đúng vấn đề spec §9.8, nhưng có 3 lỗi thiết kế mà dev phải làm theo bản fold, không theo bản gốc: (1) POST tin hidden field → open redirect, (2) OPEN-1 phương án "family theo userId+client" mâu thuẫn acceptance "thiết bị khác còn sống", (3) front-channel chọn RP sai (chỉ client của hint). Các lỗi đều sửa cục bộ, không cần analyst làm lại → PASS + fold.

## Quyết định chốt

### OPEN-1 → CHỐT: liên kết session↔family khi mint (`RefreshToken.sessionRef`), KHÔNG dùng phương án "userId+client suy được"
- Lý do bác phương án analyst: UI session không bind client (`SessionData` = userId/tenantId/authTime/…; xác nhận ở `session.service.ts` L12). Client chỉ suy được từ `id_token_hint`. Revoke `{userId, clientId}` sẽ giết refresh của **mọi thiết bị** của user tại client đó, trái với acceptance Task 3 "token của thiết bị khác còn sống". Không có hint thì local logout không revoke gì, vẫn sai spec §9.8.
- Phương án chốt (rẻ, khoảng 6 điểm sửa, **không** đụng access token/introspect nên KHÔNG kéo DEBT-037 vào):
  1. `SessionView` thêm `ref`; `authorize.controller.liveSession` trả `live.ref`.
  2. `AuthorizationCodeData` thêm `sessionRef?: string`; `issueCode`/`issueCodeFromContext` truyền `session.ref`.
  3. `TokenService.insertRefreshToken` nhận `sessionRef?`; luồng `authorization_code` truyền `data.sessionRef`.
  4. `RefreshTokenService.rotate` kế thừa `old.sessionRef` (giống `familyId`).
  5. `refresh-token.schema` thêm `sessionRef: String`. **Không cần index mới**: filter `{userId, sessionRef}` dùng prefix của index `{userId:1, clientId:1}` có sẵn.
  6. Local logout = `revokeWhere({ userId: session.userId, sessionRef: session.ref })`.
- `sessionRef` = sha256(cookie id): không đảo ngược được, đã dùng làm `targetId` audit → lưu Mongo an toàn. KHÔNG đưa vào token/response (việc đó thuộc DEBT-037).
- Giới hạn chấp nhận: token mint trước B4.7 (không có `sessionRef`) không bị local logout đụng. Chúng chỉ chết khi global logout, `/revoke` hoặc hết TTL 30d. Ghi chú trong summary, không mở debt.

### OPEN-2 → CHỐT: GET luôn chỉ render form xác nhận, kể cả khi `id_token_hint` hợp lệ
- Spec §9.8 + plan L196 yêu cầu "GET không huỷ session". OIDC RP-Initiated §2 cho phép (không bắt buộc) bỏ qua bước xác nhận. Chọn fail-closed.
- Bổ sung bắt buộc: **POST phải verify lại** hint và `post_logout_redirect_uri` (hidden field là input của client, không phải "đã validate"). Xem Vấn đề #1.

### Dời DEBT-037/040/041 → ĐỒNG Ý
- Gộp thành micro-run **`introspect-hardening` ngay sau B4.7, trước consent-hardening**. DEBT-037 nhẹ đi nhờ `RefreshToken.sessionRef` của run này: chỉ còn thêm claim `sid` vào access/ID token + introspect kiểm session còn sống. Đã cập nhật cột "Nên làm ở" trong backlog.

### Task 4 front-channel → **[BE], thuộc backend-dev**
- UI logout là server-rendered `be/src/views/logout.eta` (Eta, `ui.controller.ts`); `fe-admin` không đụng tới. Trang RP nhận front-channel (`fe-sso-test`) thuộc T2, KHÔNG làm ở run này. Run này **không có agent FE**.

## Điểm mạnh
- Đúng hướng DEBT-034: `revokeWhere` làm cửa duy nhất có stamp-first (INV-11) trước khi thêm đường revoke theo `userId`. `revokeFamily` hiện tại (L330–377) tách được sạch.
- `sessions.revokeAllForUser` (Lua) có sẵn. Audit enum đã có `TOKEN_REVOKED`/`SESSION_REVOKED`, không cần enum mới.
- Logger đã cắt query string (`logger.module.ts` L47) → `id_token_hint` trên URL không vào log request. Dev chỉ cần không tự log thêm.
- Back-channel để P2, DEBT phân loại hợp lý, mỗi task có security invariants.

## Vấn đề (đã fold vào tasks.md — dev làm theo bản fold)
- [x] **#1 Open redirect qua hidden field (Task 2/3, nghiêm trọng)**: bản gốc ghi "lưu tham số đã validate vào hidden field để POST dùng lại". Attacker tự POST (CSRF token anon lấy hợp lệ được) với `post_logout_redirect_uri` tuỳ ý → open redirect. Fold: hidden field chỉ mang giá trị **thô**; POST chạy lại **cùng** hàm `resolvePostLogoutRedirect()` mà GET dùng. Thêm acceptance âm: POST có `post_logout_redirect_uri` lạ hoặc hint giả → fallback `/login?loggedOut=1`.
- [x] **#2 OPEN-1 mâu thuẫn acceptance**: thay bằng `sessionRef` (xem trên).
- [x] **#3 Front-channel chọn RP sai**: front-channel phải báo **mọi RP** đã nhận code trong phiên, không chỉ client của hint. Fold: Redis set `sess_rp:{ref}` (SADD `clientId` khi mint code, PEXPIRE = absolute TTL). Logout đọc set trước khi revoke; global lấy union qua `listByUser`. Lua `revokeAll`/`revokeRef` xoá thêm set (cùng ràng buộc Cluster DEBT-013, không xấu hơn).
- [x] **#4 Verify `id_token_hint` chưa đặc tả đủ**: `TokenVerifier.verify` bắt buộc `exp` còn hạn, không dùng lại được. Fold: thêm `verifyIdTokenHint`. Yêu cầu: RS256, `iss`, chữ ký theo JWKS hiện tại; chấp nhận `exp` đã qua; **từ chối `typ: at+jwt`** (token confusion); `aud` là chuỗi hoặc mảng 1 phần tử = clientId tồn tại và active. Nếu có `client_id` query mà khác `aud` → bỏ hint. Có session live mà `sub` ≠ `session.userId` → bỏ redirect (vẫn chỉ logout session hiện tại).
- [x] **#5 `revokeWhere` filter rỗng**: kiểu filter là union đóng `{familyId, clientId} | {userId} | {userId, sessionRef}`. Runtime assert: thiếu khoá → throw, KHÔNG BAO GIỜ chạy `updateMany({})`. Cast `userId` sang `ObjectId`.
- [x] **#6 Acceptance "không còn ghi revokedAt trực tiếp" sai sự thật**: `rotate` có swap `findOneAndUpdate` (L237) và self-revoke successor `updateOne` (L280). Đây là ghi trên một token, không phải revoke family, nên miễn trừ rõ trong acceptance.
- [x] **#7 Thứ tự + audit POST**: token trước → session sau → audit → clear cookie → redirect. Local logout ghi `TOKEN_REVOKED` (`scope:'session'`, `count`) khi `count>0`. Nếu audit lỗi sau khi đã revoke → trả 5xx; thao tác retry idempotent; không rollback.
- [x] **#8 `state`**: chỉ echo khi redirect về URI đã validate; giới hạn ≤ 512 ký tự (vượt → bỏ `state`); encode bằng `URL`/`searchParams`, không nối chuỗi.
- [x] **#9 UI chọn scope**: `logout.eta` thêm nút "Sign out everywhere" (`formaction="/logout?scope=all"`). `scope` khác `all` → coi như local (không 400). Trang logout + trang trung gian đặt `Cache-Control: no-store`.
- [x] **#10 CSP trang front-channel**: helmet đặt CSP global `default-src 'self'`, `script-src 'self'` → iframe ngoài và inline script bị chặn. Fold: override header CSP **chỉ cho response này**, `frame-src` = origin của các URI front-channel đã đăng ký (tính phía server). Auto-redirect bằng script tĩnh `/assets/…` (không inline), timeout 3s, kèm `<noscript>` link. Giữ `frame-ancestors 'none'`.

## Đề xuất (không bắt buộc)
- Redirect 302 ra origin RP sau POST: theo đúng cách đã chứng minh ở consent (DEBT-015, `form-action 'self'`). Integration test assert `Location`.
- Discovery: thêm `frontchannel_logout_supported: true`, `frontchannel_logout_session_supported: false` (chưa có `sid`, xem DEBT-044).
- Backlog mới: **DEBT-043** (code mint trước global logout vẫn đổi được thành family mới trong ≤60s), **DEBT-044** (front-channel `sid` + `frontchannel_logout_session_required`, phụ thuộc DEBT-037).