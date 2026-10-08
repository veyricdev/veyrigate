# Backlog — sso-idp

Việc còn mở (🟡 từ review/test, debt, việc hoãn). **Nguồn duy nhất** cho việc tồn đọng.
Đóng mục: chuyển sang bảng "Đã đóng", ghi run xử lý. Không xoá.

## Mở

| ID | Nguồn | Mô tả | Gợi ý xử lý | Nên làm ở |
|---|---|---|---|---|
| DEBT-026 | run 12 tech-lead (đề xuất) | Nhánh "consent đã covered" tạo `AuthorizeRequestContext` rồi consume ngay trong cùng GET (1 cặp write/consume Redis thừa); union scope trong `grant` có thể giữ scope đã bị gỡ khỏi `client.scopes` | B4.4: đường tắt issue-code không qua ctx cho covered; `grant` chỉ union trong scope hợp lệ hiện tại; fail-fast khi `policy/termsVersion` env rỗng | B4.6 (run 13 tech-lead: ngoài phạm vi `/token`) |
| DEBT-027 | run 12 senior 🟡 | `ConsentService.grant` đọc `grantedScopes` (`findOne`) rồi `$set` ở `findOneAndUpdate` riêng → không atomic; 2 grant đồng thời cùng key có thể mất 1 scope khỏi union (fail-closed: chỉ ép re-consent, không over-grant). Test concurrency chỉ assert `count==1`. | Gộp 1 update-pipeline atomic (`$setUnion`/`$setIntersection` lọc allowed) trong 1 round-trip; thêm test assert union scope sau 2 grant concurrent. | B4.6 (run 13 tech-lead: ngoài phạm vi `/token`) |
| DEBT-028 | run 12 senior 🟡 | Đổi unique index `Consent` sang `{userId,clientId,resource}` cần drop index cũ `{userId,clientId}` khi deploy. | Chạy `db:sync-indexes` trong runbook deploy M3→M4; ghi chú vận hành. | deploy M4 |
| DEBT-001 | run 03 senior 🟡#1 | `/ready` 503 bị `OAuthExceptionFilter` ép body `{error:"server_error"}` → mất chi tiết `mongo`/`redis` | Trả 503 trực tiếp qua reply hoặc filter riêng cho health | B1.6–B1.10 hoặc B7.2 |
| DEBT-003 | run 03 test | Chưa verify case Mongo down với `/ready` | Thêm case khi làm B7.1 | B7.1 |
| DEBT-004 | run 02 | Job CI `e2e` đang placeholder | Bật thật | B7.1 / X1 |
| DEBT-005 | run 04 tech-lead | Rate-limit (và mọi lệnh Redis) có thể treo khi Redis down do client chung `maxRetriesPerRequest: null` | Timeout/fail-fast cho lệnh trên đường request, đúng §6.2 | B7.3 |
| DEBT-006 | run 04 senior 🟡#2 | Rate-limit chiều IP dùng `req.ip`; Fastify chưa bật `trustProxy` → sau reverse proxy mọi request cùng IP | Bật `trustProxy` theo danh sách proxy tin cậy (env) khi có gateway | B7.x (deploy) |
| DEBT-007 | run 04 senior 🟡#3 | `LocalKeyProvider.rotate()` xoá PEM trước khi ghi `keys.json` → lỗi ghi giữa chừng làm hỏng state key (dev-only) | Ghi state trước (atomic rename) rồi mới xoá PEM; hoặc bỏ qua khi thay bằng KeyProvider thật | B7.3 |
| DEBT-008 | run 05 tech-lead | Cookie session chưa dùng prefix `__Host-` (chống ghi đè cookie từ subdomain) | `__Host-idp_session` khi `Secure=true`; kiểm cùng ma trận cookie | X3 |
| DEBT-013 | run 05 senior 🟡#2 | Session layout không chạy được trên Redis Cluster: Lua `sessionRevokeAll` truy cập key `sess:*` không khai báo trong KEYS; `MULTI` ở `create`/`revokeRef` trộn `sess:<ref>` + `user_sess:<userId>` khác slot → CROSSSLOT | Nếu Q5 chọn Cluster: bỏ atomic cross-key (DEL từng key, index chấp nhận stale + prune) hoặc thiết kế lại key; Sentinel thì giữ nguyên | B7.3 (theo Q5) |
| DEBT-016 | run 06 tech-lead | Lockout theo tài khoản (A3) cho phép kẻ tấn công cố ý khoá tài khoản nạn nhân (DoS) | Cân nhắc khoá theo (account+IP/device), CAPTCHA/step-up thay vì khoá cứng; mở khoá qua reset password | B7.x |
| DEBT-017 | run 06 tech-lead | Tài khoản local chưa verify email có thể do kẻ tấn công tạo trước (pre-account hijack) | B5.3: không link/merge federated identity vào tài khoản local chưa verify; cân nhắc xoá user chưa verify sau TTL | B5.3 |
| DEBT-019 | run 09 senior 🟡#1 | `@fastify/cors` thêm vào `be/package.json` (C5) nhưng chưa dùng ở bất kỳ đâu trong `src/` — B3.4 mới dừng ở primitive `ClientCorsService`, chưa wire HTTP | Khi làm B4: dùng `@fastify/cors` hoặc hook thủ công đúng mapping đã tả trong `client-cors.service.ts`; nếu chọn tự viết hook thì gỡ dependency thừa | B4.6 (run 13 tech-lead: không wire ở B4.4) |
| DEBT-020 | run 09 senior 🟡#2 | `ClientSchema` chưa có index trên `allowedCorsOrigins` — `isOriginRegisteredForAnyClient` full-scan collection `Client` mỗi lần preflight/jwks/discovery | Thêm `ClientSchema.index({ allowedCorsOrigins: 1 })` khi B4 wire thật và có traffic để đo | B4.6 (run 13 tech-lead: không wire ở B4.4) |
| DEBT-021 | run 09 senior 🟡#3 | `ClientCredentialService.rotateSecret` không atomic dưới concurrent rotate trên cùng `clientId` — `nextVersion` tính bằng `Math.max` sau khi load, hai lời gọi đồng thời có thể trùng version (index `{clientId,version}` không unique) | Ghi rõ giới hạn trong code; cân nhắc unique index `(clientId, version)` khi có admin API thật | B6.3 |
| DEBT-025 | run 11 senior ✂️ (ponytail) | `AuthCodeRedis` (`authorization-code.service.ts`) là bản sao gần như y hệt `AuthzRedis` (`authorize-request-context.service.ts`) — cùng pattern khai type 1 method cho lệnh ioredis tự định nghĩa qua `defineCommand`, lặp giữa 2 service | Gộp thành 1 type dùng chung hoặc 1 helper generic cho pattern "custom ioredis command" khi có service thứ 3 cần, tránh lệch khi 1 bên đổi | B4.4+ (khi thêm Lua script thứ 3, ví dụ refresh-token rotation B4.5) |
| DEBT-029 | run 13 tech-lead (đề xuất) | `/token` chưa rate-limit theo `client_id`+IP (brute-force secret/code) | Áp `RateLimitGuard` sẵn có cho `POST /token`, khoá theo client_id+IP; trả `429` | B7 |
| DEBT-030 | run 13 tech-lead | `amr`/`acr` trong ID token là hằng (`["pwd"]`, `urn:idp:aal1`) — sai khi có login federation (B5) hoặc MFA | Lưu `amr` vào session lúc xác thực → mang qua `AuthorizationCodeData` → ID token | B5 |

## Đã đóng

| ID | Đóng ở run | Ghi chú |
|---|---|---|
| DEBT-002 | 05 | `validate` bỏ, chỉ còn `load: validateEnv` (1 lần, vẫn fail-fast) |
| DEBT-009 | 06 | UI dùng `HtmlExceptionFilter`; OAuth filter global giữ nguyên. |
| DEBT-010 | 06 | `passwordHash` select false; auth chọn tường minh; membership status có enum. |
| DEBT-011 | 06 | Login/logout ghi `SESSION_CREATED`/`SESSION_REVOKED`. |
| DEBT-012 | 06 | Đổi email unset xác minh; integration test bao phủ. |
| DEBT-014 | 06 | Update pipeline atomic; integration test 10 cập nhật song song. |
| DEBT-018 | 06 | Xoá artifact test trùng; nguồn là dirty VS Code buffer save-back, không có task/watcher/config repo tạo file. |
| DEBT-023 | 10 | Bỏ `UiModule` khỏi `imports` của `OauthModule`; `HtmlExceptionFilter` provide cục bộ, `safeReturnTo` import hàm trực tiếp. |
| DEBT-024 | 10 | `AuthorizeRedirectError` nay tự mang `redirectUri`/`state` (gắn trong `handle()` Phase 2, nơi redirect_uri đã trusted); controller redirect từ error, không còn đọc `params` → resume Phase-2-fail trả 302 đúng hợp đồng, không còn 500. |
| DEBT-015 | 12 | Consent POST về chính IdP (`/authorize/consent`, same-origin) rồi redirect GET về RP (`code`/`error`+`state`+`iss`) → `form-action 'self'` không chặn; chứng minh bằng test approve/deny/covered redirect.
| DEBT-022 | 12 | Gộp type Fastify request/reply dùng chung `common/http/http.types.ts` (`HttpRequest`/`HttpReply`); cả `authorize.controller.ts` và `ui.controller.ts` import lại, bỏ interface lặp.
