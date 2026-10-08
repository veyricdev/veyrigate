# Tasks — run 12 — B4.2 (Consent)

> Nguồn: `plan.md` §B4 (B4.2), `plan.md` §12 Q1 (ĐÃ CHỐT: `Consent` = `user × client × resource`), `plan.md` §2 D1 (UI do BE render), `spec.md` §9.4 (Consent screen + `prompt`), §9.1 (request_id/resume), §9.2 (authz code flow + `iss` RFC 9207), §10 (Consent schema), §4 mục 9. Mốc **M4**.
> Phụ thuộc đã xong: **B4.1** (`/authorize` + `AuthorizeRequestContext`, nhánh `ready` còn `TODO(B4.2)`), **B4.3** (`AuthorizationCodeService.create/consume`), B2.5 (UI render + `HtmlExceptionFilter`), B2.3 (session), `CsrfService/CsrfGuard` (module `ui`). KHÔNG phụ thuộc Q6. `/token` là **B4.4** (run sau).
> Phạm vi: **chỉ B4.2 Consent**. KHÔNG làm `/token`, refresh token, userinfo, discovery, logout.

## Quyết định tích hợp (chốt trong run này)

- **Consent key** = `user × client × resource` (Q1). Unique index `{userId, clientId, resource}`. Khi request không có `resource` (public client document-only) → lưu sentinel `resource = ""` để giữ 1 index duy nhất, không null-collision.
- **Issue code tại B4.2**: vì `/token` ở run sau, sau khi consent **được chấp nhận** (hoặc đã có consent đủ scope+version) thì B4.2 phát hành authorization code qua `AuthorizationCodeService.create` (B4.3) rồi **redirect 302** về `redirect_uri` kèm `code` + `state` (echo nguyên vẹn) + `iss` (RFC 9207). Đây là điểm nối walking skeleton; B4.4 thêm `/token` để đổi code.
- `authTime` đưa vào `AuthorizationCodeData` lấy từ `session.authTime` (đã có sẵn, không bịa).

## Tasks

### [x] B4.2a [BE]: Consent store (schema `user × client × resource` + service)
- Sửa `consent.schema.ts`: thêm trường `resource: { type: String, default: '' }`; đổi unique index thành `{ userId: 1, clientId: 1, resource: 1 }` (bỏ index cũ `{userId,clientId}`). Giữ `grantedScopes[]`, `policyVersion`, `termsVersion`, `grantedAt/updatedAt/revokedAt`.
- `ConsentService`:
  - `find(userId, clientId, resource)` → bản ghi active (`revokedAt == null`).
  - `isCovered(consent, requestedScopes, policyVersion, termsVersion)` → true **chỉ khi** consent bao phủ **đủ** scope đang xin **và** khớp `policyVersion`/`termsVersion` hiện hành.
  - `grant(userId, clientId, resource, scopes, policyVersion, termsVersion)` → upsert atomic (`findOneAndUpdate ... upsert:true`, set `grantedScopes` = union đã xin, cập nhật version + `updatedAt`, clear `revokedAt`).
  - Version hiện hành (`policyVersion`/`termsVersion`) đọc từ config (env), không hardcode rải rác.
- Acceptance (đo được):
  - Có consent đủ scope + đúng version → `isCovered` = true; thiếu 1 scope → false; version lệch → false (dù đủ scope).
  - `grant` gọi 2 lần đồng thời cùng `{userId,clientId,resource}` → chỉ 1 bản ghi (unique index, không nhân đôi).
  - Hai resource khác nhau của cùng `user×client` → **hai** bản ghi độc lập; revoke 1 không ảnh hưởng cái kia.
- Security invariants:
  - Actor/tài sản: consent là ủy quyền của **owner (userId trong session)** cho 1 client+resource. Actor khác (user khác, client khác, tenant khác) không được đọc/ghi consent của owner.
  - Invariant: consent luôn tra theo `userId` lấy **từ session đã xác thực** (không bao giờ từ input client); `tenantId` suy ra từ `client` (1 client ⇒ 1 tenant), không nhận từ request.
  - State: `(none)` → grant → active; coverage sai/version đổi ⇒ coi như chưa có, ép hỏi lại (không auto-approve).
  - Exposure budget: không log `grantedScopes` ở mức nhạy cảm vượt nhu cầu; không trả consent của user khác.
- Phụ thuộc: không (độc lập, làm trước B4.2b).

### [x] B4.2b [BE]: Wire consent vào `/authorize` + trang consent BE-render + POST approve/deny → issue code
- Trong `authorize.service.ts` nhánh signed-in (`TODO(B4.2)`): sau khi validate, tra `ConsentService`:
  - **Đã covered** và không `prompt=consent` → bỏ qua màn hình, **issue code ngay** (xem dưới).
  - **Chưa covered** (hoặc có `prompt=consent`):
    - `prompt=none` → OAuth error `consent_required` (redirect về `redirect_uri` kèm `error`/`state`/`iss`, KHÔNG render UI) — đối xứng với `login_required` đã có.
    - còn lại → outcome mới `kind: 'consent_required'` mang `requestId` + danh sách scope/claim app đang xin (để render).
- Controller `authorize.controller.ts`: outcome `consent_required` → render trang consent BE (`consent.eta` mới, cùng engine `message/error.eta`), hiển thị tên/scope client đang xin + nút Cho phép/Từ chối; form POST kèm `_csrf` (dùng `CsrfService.token(identity)` như login) và `request_id` ẩn.
- `POST /authorize/consent` (controller mới hoặc route trong authorize controller), bảo vệ bằng `CsrfGuard`:
  - **Approve**: xác thực lại session + consume `AuthorizeRequestContext` theo `request_id` → `ConsentService.grant(...)` → `AuthorizationCodeService.create({clientId, redirectUri, codeChallenge, resource, scope, nonce, userId, authTime: session.authTime})` → **redirect 302** về `redirect_uri` kèm `code` + `state` (echo) + `iss`.
  - **Deny**: redirect 302 về `redirect_uri` kèm `error=access_denied` + `state` + `iss` (KHÔNG issue code, KHÔNG ghi consent).
- Cũng cập nhật nhánh "đã covered" (không cần UI) để issue code theo đúng đường trên (consume context → create code → redirect). Thay thế holding page `message.eta` của B4.1 bằng redirect-with-code.
- DEBT-022: trước khi sửa controller, tách type Fastify request/reply dùng chung (`common/http/`) cho `AuthorizeRequest/Reply` và `UiRequest/Reply` (đóng DEBT-022). DEBT-015 (`form-action` CSP): trang consent POST về chính IdP (`/authorize/consent`, same-origin) rồi redirect GET về RP → `form-action 'self'` không chặn; ghi chú và chứng minh bằng test redirect.
- Acceptance (đo được):
  - Signed-in + chưa consent → GET `/authorize` trả trang consent (200, có `_csrf`, liệt kê đúng scope đang xin), KHÔNG issue code.
  - Approve hợp lệ → 302 về `redirect_uri` có `code`, `state` echo nguyên vẹn, `iss` = issuer; code consume được qua `AuthorizationCodeService.consume` với đúng `client_id`/`redirect_uri`.
  - Deny → 302 có `error=access_denied` + `state` + `iss`, không có `code`, không tạo `Consent`.
  - Đã có consent đủ scope+version → GET `/authorize` bỏ qua trang consent, 302 trả `code` ngay.
  - `prompt=consent` dù đã có consent → vẫn render trang consent.
  - `prompt=none` + chưa consent → 302 `error=consent_required` (không render UI).
  - **`prompt=none` + đã covered (đủ scope+version)** → 302 trả `code` ngay (success case OIDC Core, KHÔNG error) — đối xứng với nhánh signed-in + covered.
  - **Resource sentinel mapping**: request `resource` vắng mặt ở `/authorize` là `undefined`; khi tra/ghi `ConsentService` phải chuẩn hóa `undefined → ""` (sentinel của B4.2a) tại đúng 1 điểm, không để `undefined` lọt vào key. Test: public-client không gửi `resource` → covered/grant hoạt động đúng trên bản ghi `resource=""`.
- Security invariants:
  - Actor: anonymous (chưa login) không tới được bước consent (B4.1 đã ép login); owner mới approve được; attacker cố giả mạo client khác.
  - Trust boundary: input qua GET `/authorize` (params/`request_id`) và POST `/authorize/consent` (`_csrf`, `request_id`). `redirect_uri`/`state`/`scope`/`resource`/`client_id` khi issue code **phải lấy từ `AuthorizeRequestContext` đã lưu**, KHÔNG từ body POST (đối xứng B4.1 resume) → chống tráo tham số.
  - State transition: `ready(validated ctx)` → render consent → POST approve → consume ctx (single-use) → create code → 302. POST lần 2 cùng `request_id` (replay) → ctx đã consume = null → không issue code lần 2 (trả trang "request expired" / lỗi, KHÔNG redirect vì ctx mất).
  - Abuse/failure:
    - **CSRF trên POST consent**: thiếu/sai `_csrf` → `CsrfGuard` chặn 403.
    - **Replay `request_id`**: `AuthorizeRequestContext.consume` single-use → request thứ 2 fail-closed.
    - **IDOR/cross-tenant**: approve ghi consent cho `userId` của session, không cho userId trong input; không issue code cho client/resource khác với ctx đã lưu.
    - **`prompt=none`**: fail-closed → trả error, tuyệt đối không auto-approve, không render UI.
    - Session hết hạn giữa chừng (GET render → POST): POST kiểm tra lại session; mất session → về `/login` (resumable) hoặc lỗi, KHÔNG issue code.
  - Exposure budget: `code`, `_csrf`, `code_challenge`, `nonce` KHÔNG xuất hiện trong log (INV-20 redact); không nhét scope/claim nhạy cảm vào URL ngoài contract redirect (`code`/`state`/`iss` hoặc `error`/`state`/`iss`).
- Phụ thuộc: B4.2a; B4.1 (đã xong); B4.3 (đã xong).

## Ghi chú

- PKCE verify `code_verifier`, cấp access/ID/refresh token = **B4.4** (sau khi consume code). B4.2 chỉ phát hành code + redirect.
- `grantTypes[]` trên `Client` (cho D7/Q4) là việc của B4.4, KHÔNG làm ở đây.
- DEBT-025 (gộp type ioredis) chỉ cần khi thêm Lua script thứ 3 (B4.5) — ngoài phạm vi.
