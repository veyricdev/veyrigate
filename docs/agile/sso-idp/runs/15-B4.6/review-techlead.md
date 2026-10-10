# Tech Lead Review — 2026-10-10
## Kết luận: PASS (kèm fold bắt buộc)

Plan đúng phạm vi B4.6 (plan §5 L195), 4 task [BE] atomic, khả thi trên code hiện có. Có 4 điểm sai/thiếu khi đối chiếu code (xem "Vấn đề") — **đã fold trực tiếp vào `tasks.md`** (*(tech-lead fold)*), không cần quay lại analyst. Dev làm theo `tasks.md` bản đã fold.

## Kiến trúc đề xuất (chốt)

Giữ modular monolith. Không thêm module mới ngoài controller mỏng trong `oauth/` (userinfo, introspect) và `keys/` hoặc `oauth/` (discovery). Logic verify access token tập trung ở **một** method `TokenVerifier.verifyAccessToken()` dùng chung cho `/userinfo` và `/introspect`.

### OPEN-1 — CHỐT: phương án A (exp-only cho access token) + kiểm "liveness", sửa câu §214
- Access token **không** denylist `jti`, **không** tra family ở run này. Với TTL 15' (Q6) đây là chuẩn RFC 9068; denylist cần store + đường revoke access token chưa tồn tại (`/revoke` chỉ xử lý refresh) → over-engineering.
- `/introspect` với access JWT trả `active:true` chỉ khi: chữ ký RS256 + `iss` + `exp` + `typ=at+jwt` hợp lệ **và** client `client_id` còn tồn tại **và** `aud ∈ client.allowedResources` hiện tại **và** user `sub` còn tồn tại. (Rẻ: 2 lookup có index; cho RS tín hiệu thật khi client/user bị gỡ.)
- Không phản ánh revoke refresh family / logout (độ trễ ≤ access TTL). **Sửa spec §214**: câu "RS cần revoke tức thời thì gọi `/introspect`" hiện hứa sai → ghi rõ giới hạn trên. Test hợp đồng khẳng định hành vi này.
- Lối nâng cấp: gắn claim `sid` (session) vào access token để introspect phản ánh logout → **DEBT-037, mốc B4.7** (B4.7 front-channel logout cần `sid` anyway).

### OPEN-2 — CHỐT: `/userinfo` chấp nhận access token của **bất kỳ** resource, không ép 1 aud
- Lý do: INV-15 (1 grant = 1 resource) → ép aud "userinfo" buộc client xin grant thứ hai chỉ để đọc profile. OIDC Core §5.3: userinfo nhận access token có scope `openid`.
- Chống **token confusion** (ID token và access token hiện cùng signer, cùng `typ: JWT`, ID token có `exp` = access TTL): access token đổi header `typ` → **`at+jwt`** (RFC 9068 §2.1; thêm option `typ` vào `TokenSigner.sign`, mặc định giữ `JWT`). `verifyAccessToken` ép `typ=at+jwt`, RS256, `iss`, requiredClaims `exp,iat,sub,jti,client_id,scope`, `aud` là string. ID token nộp vào `/userinfo`/`/introspect` → 401 / `active:false`.
- Sau verify: client `client_id` tồn tại và `aud ∈ client.allowedResources`; `scope` chứa `openid` (thiếu → 403 `insufficient_scope`); `sub` là ObjectId hợp lệ & user tồn tại (không → 401, tránh CastError 500).
- `TokenVerifier.verify(token, audience)` hiện có **giữ nguyên** (test cũ & B6.5 dùng).

### DEBT-026/027 — ĐỒNG Ý dời khỏi B4.6
- Không liên quan endpoint B4.6; cả hai fail-closed (DEBT-027 chỉ ép re-consent; DEBT-026 scope đã gỡ không thể xin lại vì `/authorize` lọc theo `client.scopes` — `authorize.service.ts` L367). Không over-grant → không chặn release endpoint.
- Mốc mới: **run riêng "consent-hardening" (DEBT-026/027/028) ngay sau B4.7, trước khi đóng M4**. Không đẩy sang B7 (là nợ chức năng consent của M4).

## Điểm mạnh
- Xác định đúng thực tế code: `jwks_uri={issuer}/jwks.json`, access token không persist, refresh lookup `tokenHash`, `ClientCorsService` mapping.
- Security invariants có tài sản/actor/exposure; chống enumeration ở introspect đúng RFC 7662.
- Gom DEBT-019/020/033/035/036 hợp lý, giữ ≤ 5 task.

## Vấn đề (đã fold vào tasks.md — dev bắt buộc làm)
- [x] **Task 3 — "resource credential đã đăng ký" không tồn tại** (`ResourceSchema` chỉ có `resourceId/identifier/scopes`). Chốt: caller = **confidential client** qua `client_secret_basic|post`; `none`/public → 401. RS cần introspect đăng ký như confidential client.
- [x] **Task 3 — thiếu authz caller (confused deputy / IDOR)**: client đã auth vẫn soi được token người khác. Chốt: refresh → `active:true` chỉ khi `doc.clientId == caller`; access → chỉ khi `token.client_id == caller` **hoặc** `token.aud ∈ caller.allowedResources`; còn lại `{active:false}` cùng shape.
- [x] **Task 3 — failure semantics mâu thuẫn**: lỗi verify JOSE → `active:false`; lỗi DB/KeyProvider → **500 `server_error` no-store**, không bao giờ `active:true`. Thiếu `token` / tham số lặp → 400 `invalid_request`. Phân nhánh theo **hình dạng** (JWT 3 phần → access; còn lại → refresh hash); `token_type_hint` được phép bỏ qua (RFC 7662 §2.1).
- [x] **Task 2 — token confusion + Bearer exposure**: `typ=at+jwt` (trên); Bearer **chỉ** từ header `Authorization` (từ chối `access_token` ở query/body); `Cache-Control: no-store`; profile claims **whitelist** chuẩn OIDC (`profile` là `Mixed`); CORS request thật kiểm `isOriginAllowedForClient(token.client_id)`, không `Allow-Credentials`, luôn `Vary: Origin`.
- [x] **Task 1 — khớp thực tế**: `token_endpoint_auth_methods_supported` phải gồm `client_secret_post` (`token.controller.ts` L271 chấp nhận); **bỏ `end_session_endpoint`** đến B4.7 (`GET /logout` hiện chỉ là form UI, chưa xử lý `id_token_hint`/`post_logout_redirect_uri` → quảng bá là sai thực tế; DEBT-038); thêm `authorization_response_iss_parameter_supported:true` (đã set `iss` ở `authorize.controller.ts` L199/214), `introspection_endpoint_auth_methods_supported`/`revocation_endpoint_auth_methods_supported:["client_secret_basic","client_secret_post"]`; `claims_supported` thêm claim userinfo trả thực tế. URL ghép bằng `issuer` bỏ `/` cuối + path (không `new URL('/x', issuer)` vì nuốt path của issuer).

## Đề xuất (không bắt buộc / đã ghi backlog)
- DEBT-037: claim `sid` trong access token để `/introspect` phản ánh logout/family revoke — B4.7.
- DEBT-038: thêm `end_session_endpoint` vào discovery khi B4.7 xong RP-initiated logout — B4.7.
- DEBT-039: rate-limit `/introspect` theo `client_id`+IP (mỗi call chạy Argon2 → vector DoS CPU); gộp cùng DEBT-029 — B7.1.
- CORS: viết hook thủ công nhỏ (1 helper) theo mapping `client-cors.service.ts` thay vì `@fastify/cors` (cần ngữ cảnh client theo route) → gỡ dependency. Wire cho `/userinfo`, `/jwks.json`, discovery, `/token`, `/revoke` (SPA public client của T2 cần `/token`); **không** CORS cho `/introspect` (server-to-server).