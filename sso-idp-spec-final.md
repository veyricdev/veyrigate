# Spec: Hệ thống SSO — Identity Provider (IdP)

Bản spec đầy đủ, tự chứa toàn bộ nội dung — không cần đối chiếu với bất kỳ bản nào khác.

## 1. Mục tiêu

Xây dựng một hệ thống trung gian (Identity Provider) cho phép người dùng đăng nhập một lần (Single Sign-On) và dùng chung phiên đăng nhập đó cho nhiều ứng dụng khác nhau của bạn. Hệ thống được tự triển khai từ đầu (không dùng Keycloak/Authentik/Auth0) để hiểu rõ cơ chế OAuth 2.0/OpenID Connect, thiết kế theo **OAuth 2.0 Security BCP (RFC 9700)**, **OpenID Connect Core**, và **RFC 8707 (Resource Indicators)**.

Bản thân spec không tự chứng minh hệ thống "production-ready" — điều đó còn phụ thuộc vào việc implementation đúng đặc tả, security testing, dependency audit, hạ tầng, secrets management, monitoring, incident response, và DR/backup restore. Spec này cung cấp kiến trúc, data model, luồng nghiệp vụ, và một bộ **Security Invariants** để dùng làm checklist khi implement.

## 2. Thuật ngữ

- **Client / Relying Party (RP)**: một ứng dụng cụ thể đăng ký với IdP để xin đăng nhập thay người dùng (ví dụ: `game-web`, `game-mobile`, `game-admin`). Mỗi Client có `client_id` riêng.
- **Resource / Resource Server**: một API/backend mà access token được cấp để gọi vào (ví dụ: `game-api`). **Nhiều Client có thể cùng trỏ tới một Resource** — không phải quan hệ 1-1 với "ứng dụng".
- **IdP (Identity Provider)**: chính hệ thống đang xây, đóng vai trò Authorization Server + OpenID Provider, đồng thời là Identity Broker khi liên kết Google/GitHub.

## 3. Tech stack

| Thành phần | Lựa chọn |
|---|---|
| Backend framework | NestJS |
| HTTP adapter | Fastify (`@nestjs/platform-fastify`) |
| Database bền vững | MongoDB (Mongoose) |
| Cache / dữ liệu ngắn hạn | Redis (ioredis), khuyến nghị Sentinel hoặc Cluster cho production, dùng Lua script cho các thao tác cần atomic nhiều bước |
| Quản lý khóa ký | KMS / Vault / Secrets Manager (không lưu private key thô trong MongoDB) |
| Giao thức | OAuth 2.0 Authorization Code Flow + PKCE (S256 bắt buộc), OpenID Connect (OIDC), Resource Indicators (RFC 8707) |
| Chữ ký token | JWT **RS256** — chốt một thuật toán duy nhất cho MVP để tương thích rộng giữa nhiều resource server khác nhau |

## 4. Yêu cầu chức năng đã chốt

- Đăng nhập bằng email/password, kèm email verification, password reset, account lockout, và chống account enumeration
- Đăng nhập liên kết qua Google và GitHub theo mô hình Identity Broker; chỉ hỗ trợ provider cấu hình tĩnh trong code (không cho phép cấu hình OIDC/SAML tuỳ ý qua URL người dùng nhập, để tránh SSRF)
- Consent screen bắt buộc (không auto-approve), có versioning theo scope/policy
- Multi-tenancy: chuẩn bị sẵn qua model `User`/`Tenant`/`UserTenant`, chưa cần bật ngay nhưng tenant context luôn phải lấy từ phiên đã xác thực, không bao giờ tin giá trị client gửi lên
- Resource-scoped audience theo RFC 8707: mỗi app/API là một `Resource` riêng, access token chỉ hợp lệ với đúng resource dự định; MVP dùng quy tắc 1 authorization grant = 1 resource
- Admin control-plane (quản lý client/resource) yêu cầu step-up re-authentication cho thao tác nhạy cảm
- MFA-ready: chưa bật MFA, nhưng token/session đã có chỗ cho `amr`/`acr` để không phải đổi contract khi triển khai sau này

## 5. Cấu trúc dự án

```
src/
├── main.ts                          # bootstrap, dùng FastifyAdapter
├── app.module.ts
│
├── config/                          # ConfigModule + validation schema (Joi/Zod)
│   ├── configuration.ts
│   └── validation.schema.ts
│
├── common/
│   ├── guards/                      # ClientAuthGuard, SessionGuard, AdminAuthGuard
│   ├── interceptors/                # logging, timeout
│   ├── filters/                     # exception filter chuẩn OAuth error format
│   ├── decorators/
│   └── pipes/                       # validation pipe custom
│
├── database/
│   ├── mongo/                       # Mongoose connection module
│   └── redis/                       # ioredis connection module, Lua script loader
│
├── modules/
│   ├── identity/                    # User, FederatedIdentity, Tenant, UserTenant
│   │   ├── schemas/
│   │   └── identity.service.ts
│   │
│   ├── authentication/              # login/logout, password, lockout, verification
│   │   ├── password.service.ts
│   │   ├── login.controller.ts
│   │   └── email-verification.service.ts
│   │
│   ├── federation/                  # Google/GitHub — static provider config only
│   │   ├── strategies/google.strategy.ts
│   │   ├── strategies/github.strategy.ts
│   │   └── federation.controller.ts
│   │
│   ├── sessions/                    # session Redis-backed, cookie security
│   │   └── session.service.ts
│   │
│   ├── clients/                     # Client (RP), ClientCredential (secret rotation)
│   │   ├── schemas/client.schema.ts
│   │   ├── schemas/client-credential.schema.ts
│   │   └── clients.service.ts
│   │
│   ├── resources/                   # Resource (resource server), allowedResources registry
│   │   ├── schemas/resource.schema.ts
│   │   └── resources.service.ts
│   │
│   ├── keys/                        # KMS/Vault integration, JWKS, rotation (normal + emergency)
│   │   ├── key-rotation.service.ts
│   │   └── keys.controller.ts       # GET /jwks.json
│   │
│   ├── oauth/
│   │   ├── authorization/           # /authorize — nonce carry, PKCE, resource binding, iss trong response
│   │   │   └── authorize.controller.ts
│   │   ├── token/                   # /token — atomic bind+consume code, atomic refresh rotation
│   │   │   ├── token.controller.ts
│   │   │   ├── token.service.ts
│   │   │   └── pkce.util.ts
│   │   ├── userinfo/
│   │   │   └── userinfo.controller.ts
│   │   ├── consent/
│   │   │   ├── schemas/consent.schema.ts
│   │   │   └── consent.controller.ts
│   │   └── discovery.controller.ts  # /.well-known/openid-configuration
│   │
│   ├── security/
│   │   ├── rate-limit/              # đa chiều: IP + account + device
│   │   ├── audit/                   # AuditLog chuẩn hoá + alerting
│   │   └── risk/                    # (tương lai) risk-based auth
│   │
│   └── admin/                       # quản trị client/resource, step-up re-auth
│
└── health/                          # health check cho k8s/orchestrator
```

## 6. Thiết kế kiến trúc

### 6.1 Phân chia dữ liệu MongoDB vs Redis

| Dữ liệu | Nơi lưu | Lý do |
|---|---|---|
| Client, ClientCredential, Resource, User, FederatedIdentity, Consent, Tenant, UserTenant, AuditLog | MongoDB | Bền vững, cần query/report/unique index |
| Authorization code (kèm client_id, redirect_uri, code_challenge, resource, nonce) | Redis, TTL 60s, atomic consume+bind | Ngắn hạn, dùng một lần |
| AuthorizeRequestContext (ngữ cảnh phiên `/authorize` đang xử lý dở) | Redis, TTL 5–10 phút, single-use | Giữ ngữ cảnh xuyên suốt login → consent → federation |
| Session đăng nhập | Redis, TTL theo idle/absolute timeout | Truy cập nhanh mỗi request, cần scale ngang |
| Refresh token (family, atomic rotation, tra cứu theo hash) | MongoDB, index theo `tokenHash`/`familyId` | Cần audit, revoke theo family khi phát hiện reuse |
| Password reset token / email verification token | MongoDB, `tokenHash`, atomic single-use | Cùng class bảo mật như authorization code |
| Rate limiting counter (IP + account + device) | Redis | Atomic increment tốc độ cao |
| Signing private key | KMS/Vault | Không lưu trong MongoDB, tránh lộ nếu DB bị compromise |
| Signing public key (JWKS) | Cache Redis, nguồn gốc từ KMS | Verify nhanh, không expose private key |

### 6.2 Redis HA & failure behavior

Production dùng Redis Sentinel hoặc Redis Cluster, không chạy single instance. Không được fallback session hay authorization code sang local memory khi Redis down — điều này sẽ phá khả năng scale ngang. Chấp nhận: khi Redis down, các request cần state tạm thời (login, `/authorize`) trả lỗi rõ ràng thay vì âm thầm dùng state không nhất quán.

### 6.3 Bảo mật tầng hạ tầng

- `@fastify/helmet` cho các header bảo mật cơ bản.
- Rate limiting đa chiều qua `@nestjs/throttler` + Redis storage: theo IP, theo account/email, và theo deviceId — không chỉ giới hạn theo IP vì attacker có thể xoay IP.
- `class-validator` + `class-transformer` cho mọi input, bật `whitelist: true` để chặn field lạ.
- Logging bằng Pino (mặc định của Fastify), redact tuyệt đối các field nhạy cảm: password, access_token, refresh_token, authorization_code, client_secret không bao giờ xuất hiện trong log.
- HTTPS bắt buộc ở production (redirect HTTP→HTTPS ở tầng gateway).

### 6.4 Quản lý khóa ký (Key Management)

Private signing key nằm trong KMS/Vault, ứng dụng chỉ decrypt vào memory khi cần ký, không bao giờ expose qua API. Mỗi key có `kid` riêng.

**Rotation thông thường**: phát hành key mới làm active key; JWKS vẫn giữ công bố key cũ (chỉ để verify, không dùng để ký mới) cho tới khi mọi token đã ký bằng key cũ hết hạn tự nhiên, sau đó mới gỡ khỏi JWKS.

**Rotation khẩn cấp** (khi nghi ngờ key bị lộ): publish key mới ngay lập tức, đồng thời **gỡ key cũ khỏi JWKS ngay** thay vì đợi token hết hạn tự nhiên — chấp nhận việc các access token đang lưu hành ký bằng key cũ sẽ fail verify sớm hơn dự kiến, đây là đánh đổi chủ động khi có compromise.

### 6.5 Khả năng mở rộng ngang

State (session, authorization code, rate limit counter) nằm ở Redis, không lưu local memory của từng instance → nhiều instance NestJS có thể chạy song song sau load balancer mà không cần sticky session.

## 7. Resource Indicators (RFC 8707)

Vì mục tiêu ban đầu là nhiều app dùng chung một IdP, access token phải chỉ hợp lệ với đúng resource server dự định — không dùng chung một `aud` cho tất cả app. Bốn quy tắc bắt buộc:

1. **`resource` phải là absolute URI, không có fragment.** Ví dụ hợp lệ: `https://api.game.example.com/`. Không chấp nhận `game-a` hay dạng định danh ngắn.
2. **Client không được tự khai `resource` tuỳ ý.** Mỗi `Client` có một danh sách `allowedResources[]` đã đăng ký sẵn; khi client xin một `resource` không nằm trong danh sách này, IdP reject ngay ở `/authorize`.
3. **MVP: một authorization grant chỉ bind với đúng một resource.** `AuthorizeRequestContext` và `AuthorizationCode` phải lưu `resource` đã chọn ngay từ bước `/authorize`; `/token` không được phép đổi sang resource khác với resource đã bind trong code.
4. **`RefreshToken` phải bind với `scope` và `resource` gốc của grant.** Khi refresh, token mới phát hành phải giữ nguyên `scope`/`resource` — không được dùng để leo thang phạm vi truy cập.

```
Resource {
  resourceId
  identifier       # absolute URI, ví dụ https://api.game-a.example.com/
  scopes[]         # ví dụ: game_a.read, game_a.write
}

Client {
  ...
  allowedResources[]   # danh sách resourceId được phép xin
}
```

## 8. Token contract

**ID Token** — dành cho Client/RP, không dùng để gọi API, `aud` = `client_id`:
```json
{
  "iss": "https://id.example.com",
  "sub": "usr_01J...",
  "aud": "client_web_123",
  "exp": 1790000000,
  "iat": 1789999100,
  "auth_time": 1789998990,
  "nonce": "xyz",
  "amr": ["pwd"],
  "acr": "urn:idp:aal1"
}
```

**Access Token** — dành cho Resource Server, `aud` = định danh của resource:
```json
{
  "iss": "https://id.example.com",
  "sub": "usr_01J...",
  "aud": "https://api.game.example.com/",
  "exp": 1790000900,
  "iat": 1790000000,
  "jti": "tok_xxx",
  "scope": "game.read",
  "client_id": "client_web_123"
}
```

**Quy tắc bắt buộc:**
- `sub` là internal identifier bất biến, không dùng email làm `sub`.
- Resource server bắt buộc validate `iss`, `aud`, `exp`, và chữ ký trước khi tin bất kỳ claim nào khác.
- Access token sống ngắn hạn (khuyến nghị 15 phút).

**Quyết định về revocation strategy** (chốt rõ ràng, không để mở): MVP dùng self-contained JWT access token, ngắn hạn. Logout hoặc revoke tác động ngay tới session và refresh-token family, **nhưng không đồng bộ vô hiệu hoá các access token đã phát hành trước đó** — độ trễ tối đa chấp nhận được bằng đúng thời gian sống của access token (15 phút). Resource server nào thực sự cần revoke tức thời thì gọi endpoint `/introspect` thay vì tự verify JWT.

## 9. Các luồng chính

### 9.1 `state`, `nonce`, `request_id` — ba khái niệm khác nhau, không được lẫn lộn

- **`state`**: do **Client (RP) sinh ra**, gửi trong request `/authorize` để RP tự chống CSRF phía họ. IdP chỉ có trách nhiệm **giữ nguyên và echo lại y hệt** trong redirect về `redirect_uri` — IdP không tạo, không sửa, không dùng `state` của RP làm khoá tra cứu nội bộ.
- **`nonce`**: do RP sinh ra, gửi trong request `/authorize`, dùng để bind authentication request với ID Token. **IdP chỉ có trách nhiệm mang giá trị này vào ID Token không đổi.** Việc validate `nonce` trong ID Token nhận được có khớp với giá trị đã gửi ban đầu hay không là **trách nhiệm của RP**, thực hiện khi RP nhận và kiểm tra ID Token — không phải IdP tự validate nonce của chính token nó vừa tạo.
- **`request_id`** (nội bộ IdP): định danh dùng để lưu và khôi phục ngữ cảnh của một phiên `/authorize` đang xử lý dở (login → consent → có thể phải qua federation Google/GitHub) — hoàn toàn không liên quan đến `state`/`nonce` của RP. Khi cần đi qua Google/GitHub, IdP tự sinh **một `state` riêng của chính nó** cho leg đó (khác với state của RP) và gắn `request_id` vào đó để nối lại ngữ cảnh sau khi Google/GitHub callback về.

**AuthorizeRequestContext** (Redis, TTL 5–10 phút, single-use, xoá ngay sau khi resume):
```
authz_ctx:{request_id}
{
  clientId, redirectUri, codeChallenge, scope, resource,
  originalState,     # state của RP — chỉ giữ để echo lại đúng lúc redirect cuối cùng
  nonce,
  createdAt, expiresAt
}
```

### 9.2 Authorization Code Flow + PKCE + Resource binding

```
/authorize?
  response_type=code
  client_id=xxx
  redirect_uri=xxx
  resource=https://api.game.example.com/
  scope=game.read
  state=xxx
  nonce=xxx
  code_challenge=xxx
  code_challenge_method=S256
```

1. Validate toàn bộ tham số: `redirect_uri` phải khớp chính xác tuyệt đối với URI đã đăng ký (không trailing slash khác, không query lạ, không wildcard); `code_challenge_method` phải là `S256` — reject nếu client gửi `plain`; `resource` phải nằm trong `allowedResources[]` của client.
2. Tạo `AuthorizeRequestContext` (9.1). Nếu chưa có session hợp lệ, redirect sang trang đăng nhập.
3. Sau khi đăng nhập (email/password hoặc qua Google/GitHub — xem 9.9) và qua bước consent (9.4), sinh `AuthorizationCode`, lưu vào Redis kèm toàn bộ ngữ cảnh (client_id, redirect_uri, code_challenge, resource, scope, nonce, user_id), TTL 60 giây, single-use, atomic (xem 9.5).
4. Redirect về `redirect_uri` kèm `code`, `state` gốc của RP (echo nguyên vẹn), và **`iss=https://id.example.com`** (theo RFC 9207 — giúp RP phát hiện mix-up attack khi RP tích hợp với nhiều authorization server khác nhau; chi phí thêm gần như bằng 0 nên luôn nên có).
5. Client gọi `/token` (server-to-server), xác thực theo `token_endpoint_auth_method` của client (9.3), atomic consume code kèm binding validation (9.5), đổi code lấy `access_token` (aud = resource đã bind), `id_token` (chứa nonce khớp request gốc), và `refresh_token`.

### 9.3 Client authentication & secret rotation

```
Client {
  clientType: "public" | "confidential"
  token_endpoint_auth_method: "none" | "client_secret_basic" | "client_secret_post"
  redirectUris[]              # exact match, không wildcard
  allowedCorsOrigins[]        # tách riêng khỏi redirectUris — xem 9.7
  allowedResources[]          # xem mục 7
}

ClientCredential {            # hỗ trợ secret rotation có overlap
  id, clientId, secretHash, version
  createdAt, expiresAt, revokedAt
}
```

- **Confidential client** (backend web app): có `client_secret`, dùng `client_secret_basic`.
- **Public client** (SPA/mobile/desktop): không có secret thật sự bảo mật được → `token_endpoint_auth_method = none`, bắt buộc PKCE S256.
- **Rotation secret có overlap**: khi rotate, phát hành `ClientCredential` mới với `version` tăng, giữ credential cũ còn hiệu lực trong một khoảng grace period đã định trước (ví dụ vài ngày) để không phải ép mọi backend client đổi secret cùng một lúc, sau đó mới revoke bản cũ.

### 9.4 Consent Screen

```
Consent {
  userId, clientId
  grantedScopes[]
  policyVersion, termsVersion
  grantedAt, updatedAt, revokedAt
}
```

- Sau khi có session hợp lệ, kiểm tra đã tồn tại `Consent` khớp `clientId` + đã bao phủ đủ `scope` đang xin (và đúng `policyVersion`/`termsVersion` hiện hành) chưa. Nếu có → bỏ qua màn hình, cấp code luôn. Nếu chưa → hiển thị trang consent liệt kê các quyền app đang xin.
- User bấm "Cho phép" → lưu `Consent` → tiếp tục cấp code. Bấm "Từ chối" → redirect về `redirect_uri` kèm `error=access_denied`.
- Hỗ trợ tham số `prompt`: `prompt=none` (nếu chưa login/consent, trả lỗi `login_required`/`consent_required` thay vì tự ý redirect UI), `prompt=login` (ép đăng nhập lại), `prompt=consent` (ép hiển thị lại màn hình consent dù đã từng đồng ý).
- **Câu hỏi cần chốt trước khi code**: với multi-tenancy và multi-resource, `Consent` nên scope theo `user × client` (đơn giản) hay `user × tenant × client × resource` (chi tiết hơn, đúng hơn về mặt boundary nhưng phức tạp hơn khi triển khai)? Cần quyết định trước khi viết migration schema chính thức.

### 9.5 Atomicity bắt buộc — chống race condition

Đây là nhóm yêu cầu dễ bị bỏ sót nhất khi tự viết IdP: kiểm tra rồi mới cập nhật ("check-then-act") luôn có race window dưới traffic đồng thời.

**Authorization code — atomic consume kèm binding validation.** Không được xoá code trước rồi mới validate `client_id`/`redirect_uri` sau — vì một request `/token` với thông tin sai (client_id sai, redirect_uri sai, code_verifier sai) vẫn có thể vô tình "tiêu" mất code hợp lệ trước khi request thật sự hợp lệ kịp dùng (authorization-code premature consumption / DoS). Toàn bộ điều kiện định danh phải nằm trong cùng một atomic step, ví dụ bằng Redis Lua script:

```lua
-- consume-with-binding: chỉ xoá nếu client_id và redirect_uri khớp đúng
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
if data.clientId ~= ARGV[1] or data.redirectUri ~= ARGV[2] then
  return nil                       -- KHÔNG xoá — sai định danh, để request hợp lệ khác vẫn dùng được
end
redis.call('DEL', KEYS[1])
return cjson.encode(data)          -- trả về code_challenge, resource, nonce... để verify tiếp
```
Sau khi có `data` trả về, mới verify `code_verifier` (PKCE), xác thực client, rồi phát hành token với đúng `resource` đã bind trong code.

**Refresh token — atomic rotation, tra cứu bằng hash** (client giữ giá trị bí mật ngẫu nhiên, DB chỉ lưu `SHA-256(refreshTokenValue)`, không bao giờ lưu plaintext, và không tra cứu bằng `_id` có thể đoán được):
```
tokenHash = SHA256(refreshTokenValue)
result = RefreshToken.findOneAndUpdate(
  { tokenHash, revokedAt: null },
  { $set: { revokedAt: now, replacedBy: newTokenHash } }
)
// result === null → token đã bị dùng/revoke trước đó → reuse detected → revoke toàn bộ family, buộc đăng nhập lại
// result !== null → rotation thành công, duy nhất
```
Refresh token mới phát hành phải giữ nguyên `scope`/`resource` của token gốc trong family.

**Email verification / password reset token** — cùng một class race condition, xử lý atomic tương tự:
```
findOneAndUpdate(
  { tokenHash, usedAt: null, expiresAt: { $gt: now } },
  { $set: { usedAt: now } }
)
```

**Quyết định UX cho refresh-token race** (ví dụ: client gửi request refresh, gặp network timeout, không biết đã thành công hay chưa, gửi lại request cũ với refresh token đã dùng): MVP chọn **strict rotation** — reuse bị phát hiện sẽ revoke toàn bộ family ngay lập tức, không có cơ chế grace-period cho phép dùng lại. Đây là lựa chọn an toàn hơn, đánh đổi bằng việc client thỉnh thoảng phải xử lý đăng nhập lại trong trường hợp hiếm gặp — cần ghi rõ trong test matrix để không bị hiểu nhầm là bug khi test.

### 9.6 Session security & cookie topology

- Cookie: `Set-Cookie: idp_session=<opaque random>; HttpOnly; Secure; SameSite=Lax` — không dùng JWT làm session cookie, không chứa userId/email dạng plaintext trong giá trị cookie.
- **Session fixation protection**: cấp session ID hoàn toàn mới ngay sau khi đăng nhập thành công, không tái sử dụng session ID đã có từ trước khi login (kể cả session ID của trạng thái anonymous).
- Idle timeout (ví dụ 8 giờ) và absolute timeout (ví dụ 30 ngày) — điều chỉnh theo yêu cầu sản phẩm thực tế.
- **`SameSite` không đồng nghĩa với "same-origin".** Vì IdP dùng chung cho nhiều domain con khác nhau (`app-a.example.com`, `game-b.example.com` → `id.example.com`), và trình duyệt hiện đại (Safari ITP, Chrome dần hạn chế third-party cookie) khiến silent SSO qua iframe (`prompt=none`) không đáng tin cậy trên mọi trình duyệt, cần lập **cookie topology test matrix** trước khi launch, bao gồm: interactive login (top-level redirect — phải hoạt động ổn định trên mọi domain topology), `prompt=none` qua iframe (test riêng, coi là "best-effort" chứ không phải cơ chế chính), logout, request qua fetch/XHR, và test trên cả Safari/Firefox/Chrome vì hành vi cookie khác nhau đáng kể giữa các trình duyệt. Khuyến nghị ưu tiên top-level redirect flow làm cơ chế chính, không thiết kế phụ thuộc vào iframe silent-auth.

### 9.7 CORS tách khỏi `redirect_uris`

`redirect_uris` chỉ dùng để validate OAuth redirect (điều hướng top-level của trình duyệt), **không** được dùng làm allowlist CORS cho các API mà JavaScript trên trình duyệt gọi trực tiếp (ví dụ `/userinfo` gọi bằng `fetch`). Dùng field riêng `allowedCorsOrigins[]` trên `Client`, chỉ áp dụng CORS cho những endpoint thực sự cần gọi từ browser.

### 9.8 Logout — tách "session logout" khỏi "token revocation", và CSRF boundary

```
Local logout (mặc định, POST /logout):
  - huỷ session hiện tại của thiết bị/trình duyệt đang gọi
  - revoke refresh-token family đang active gắn với phiên này

Global logout (POST /logout?scope=all):
  - huỷ toàn bộ session của user trên mọi thiết bị
  - revoke toàn bộ refresh-token family của user
  - kích hoạt RP logout (front-channel ngay, back-channel nếu có triển khai)
```

- `GET /logout`: chỉ hiển thị màn hình xác nhận hoặc bắt đầu luồng RP-initiated logout theo chuẩn OIDC, **không** tự huỷ session ngay lập tức — tránh trường hợp CSRF-triggered logout thông qua một thẻ `<img>` hay link ẩn trỏ tới `/logout`.
- `POST /logout` (được bảo vệ bằng CSRF token hoặc same-site cookie enforcement): mới thực sự thực hiện hành động huỷ — đây là destructive action.
- 4 lớp logout đầy đủ: (1) local session logout tại IdP, (2) RP-initiated logout (`/logout` nhận `id_token_hint`, redirect về client sau khi huỷ session), (3) front-channel logout (thông báo các RP khác qua iframe), (4) back-channel logout (server-to-server notify RP để RP tự huỷ session cục bộ — có thể triển khai sau, xếp P1).

### 9.9 Identity Broker (Google/GitHub) & account linking an toàn

Auth Server không tự xác thực Google/GitHub thay app con, mà đóng vai trò **broker**: nhận kết quả xác thực từ Google/GitHub rồi tự phát hành token chuẩn hoá (JWT riêng) cho các app con — app con không cần biết user đăng nhập bằng phương thức nào.

1. Trang login hiển thị: form email/password hoặc nút "Đăng nhập với Google/GitHub".
2. Trước khi redirect ra ngoài, IdP đã có `AuthorizeRequestContext` (9.1) lưu ngữ cảnh gốc. Khi chọn Google/GitHub, IdP tự sinh **`state` riêng của chính nó** cho leg này, gắn `request_id` vào đó, rồi redirect sang Google/GitHub.
3. Google/GitHub callback về `/auth/google/callback` (hoặc `/auth/github/callback`) → IdP dùng `request_id` lấy lại `AuthorizeRequestContext` gốc.
4. Tìm hoặc tạo `User` local, liên kết qua bản ghi `FederatedIdentity { userId, provider, providerId, email, emailVerified, createdAt, lastLoginAt }` — collection riêng, không nhúng mảng trong `User` để tiện đặt unique index.
5. **Không tự động link chỉ vì email trùng.** Nếu email trả về từ Google/GitHub trùng với một tài khoản local đã tồn tại, yêu cầu user đăng nhập lại bằng tài khoản local đó để xác nhận quyền sở hữu, rồi mới ghi nhận liên kết vào `FederatedIdentity` — tránh account takeover khi email chưa chắc đã được xác minh đúng chủ.
6. Tiếp tục luồng như đăng nhập thường: qua bước consent (9.4) rồi cấp `authorization code`.

**Ràng buộc SSRF cho MVP**: chỉ hỗ trợ Google/GitHub với endpoint cấu hình cứng trong code, không có tính năng "thêm OIDC/SAML provider tuỳ ý qua URL do người dùng hoặc tenant nhập" — tránh SSRF vào metadata endpoint nội bộ (`169.254.169.254`, `localhost`, các service nội bộ khác). Nếu tương lai cần hỗ trợ custom provider theo yêu cầu tenant, phải thiết kế allowlist domain nghiêm ngặt riêng cho tính năng đó, không mở tự do.

### 9.10 Multi-tenancy & cách ly cross-tenant

```
Tenant { id, name, ... }
UserTenant { userId, tenantId, status, roles[], createdAt }
Client { ..., tenantId }
```

- `User` không gắn cứng `tenantId` trực tiếp vì một user có thể thuộc nhiều tenant (giống mô hình workspace) — dùng `UserTenant` làm bảng trung gian.
- `/authorize` và `/token` tự resolve tenant từ `client_id` đang xử lý — không cần đưa tenant vào URL.
- Ban đầu dùng chung một bộ JWKS cho mọi tenant; chỉ tách key riêng theo tenant nếu sau này cần cách ly bảo mật giữa các tổ chức.
- **Ràng buộc bắt buộc**: tenant context luôn phải suy ra từ phiên đã xác thực và đã authorize — **không bao giờ tin `tenantId` do client tự gửi lên** (ví dụ không tin `req.body.tenantId`). Mọi query nhạy cảm bắt buộc có ràng buộc tenant tường minh, ví dụ `findClient({ clientId, tenantId })` chứ không phải `findClient({ clientId })` rồi mới kiểm tra sau.
- User thuộc Tenant A không được cấp quyền cho Client thuộc Tenant B dưới bất kỳ hình thức nào: authorization, consent, cấp token, hay truy cập admin.

### 9.11 Admin control-plane security

Phần quản trị client/resource là hạ tầng điều khiển của toàn bộ hệ thống định danh — nếu bị chiếm quyền, toàn bộ OAuth security có thể bị vô hiệu hoá hoàn toàn (ví dụ attacker đổi `redirect_uris` của một client thành domain của chính họ để cướp authorization code). Các thao tác sau bắt buộc yêu cầu **step-up re-authentication** (và MFA khi tính năng này được bật) trước khi thực hiện, cộng với audit log đầy đủ, và nên cân nhắc dual-approval ở môi trường production thực sự nhạy cảm:

- Thay đổi `redirect_uris`
- Rotate hoặc tạo mới client secret
- Thay đổi `allowedResources` / quyền truy cập resource
- Thay đổi vai trò của một admin khác

### 9.12 Account enumeration prevention

Các endpoint `/login`, `/register`, `/password/reset`, `/password/verify-email` không được trả response khác biệt giữa "tài khoản không tồn tại" và các trường hợp khác (ví dụ "sai mật khẩu"). Cụ thể, `/password/reset` luôn trả cùng một thông điệp ("nếu email tồn tại, một email đã được gửi") bất kể email đó có tồn tại trong hệ thống hay không, và luôn áp dụng rate limit đa chiều (IP + email + device) như nhau cho cả hai trường hợp.

### 9.13 DPoP — ghi nhận cho tương lai, không bắt buộc ở MVP

Hiện tại access token dùng dạng bearer thông thường (`Authorization: Bearer <JWT>`), phù hợp vì hệ thống chủ yếu là web browser + backend API. RFC 9700 khuyến nghị cân nhắc sender-constrained access token (DPoP theo RFC 9449, hoặc mTLS) để giảm thiệt hại khi token bị đánh cắp — nhưng chỉ thực sự cần thiết khi có thêm mobile app, desktop app, hoặc public SPA/game client trong tương lai. Xếp mục này ở mức P2, cân nhắc nâng lên P1 khi hệ sinh thái client mở rộng.

## 10. Data model chính

- **User**: `email`, hashed password (argon2), `profile`, `mfaSecret` (placeholder, chưa bật), `emailVerifiedAt`, `failedLoginCount`, `lockedUntil`
- **FederatedIdentity** (collection riêng): `userId`, `provider`, `providerId`, `email`, `emailVerified`, `createdAt`, `lastLoginAt`
- **Client**: `client_id`, `clientType` (`public`/`confidential`), `token_endpoint_auth_method`, `redirect_uris[]`, `allowedCorsOrigins[]`, `allowedResources[]`, `scopes[]`, `tenantId`
- **ClientCredential**: `clientId`, `secretHash`, `version`, `createdAt`, `expiresAt`, `revokedAt`
- **Resource**: `resourceId`, `identifier` (absolute URI, unique), `scopes[]`
- **AuthorizationCode** (Redis, atomic consume+bind — mục 9.5): `clientId`, `redirectUri`, `codeChallenge`, `resource`, `scope`, `nonce`, `userId`, TTL 60s, single-use
- **AuthorizeRequestContext** (Redis, TTL 5–10 phút, single-use): `clientId`, `redirectUri`, `codeChallenge`, `scope`, `resource`, `originalState`, `nonce`
- **RefreshToken**: `tokenHash` (không lưu plaintext), `familyId`, `parentId`, `userId`, `clientId`, `scope[]`, `resource`, `issuedAt`, `expiresAt`, `revokedAt`, `replacedBy`, `reuseDetectedAt`, `deviceId`, `ip`, `userAgent`
- **PasswordResetToken / EmailVerificationToken**: `tokenHash`, `userId`, `expiresAt`, `usedAt`
- **Consent**: `userId`, `clientId`, `grantedScopes[]`, `policyVersion`, `termsVersion`, `grantedAt`, `updatedAt`, `revokedAt`
- **Tenant**: `id`, `name`
- **UserTenant**: `userId`, `tenantId`, `status`, `roles[]`, `createdAt`
- **AuditLog**: `eventId`, `timestamp`, `actorType`, `actorId`, `tenantId`, `action`, `targetType`, `targetId`, `clientId`, `ip`, `userAgent`, `requestId`, `result`, `reason`, `metadata` — không bao giờ log password/token/secret. Các event quan trọng cần alert riêng: `TOKEN_REUSE_DETECTED`, `SIGNING_KEY_ROTATED` (đặc biệt khi là emergency rotation), và mọi thao tác admin control-plane (9.11). Danh sách action tham khảo: `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILED`, `AUTH_ACCOUNT_LOCKED`, `OAUTH_AUTHORIZE`, `OAUTH_CONSENT_GRANTED`, `OAUTH_CONSENT_DENIED`, `TOKEN_ISSUED`, `TOKEN_REFRESHED`, `TOKEN_REUSE_DETECTED`, `TOKEN_REVOKED`, `CLIENT_SECRET_CREATED`, `CLIENT_SECRET_ROTATED`, `CLIENT_SECRET_REVOKED`, `REDIRECT_URI_CHANGED`, `SIGNING_KEY_CREATED`, `SIGNING_KEY_ROTATED`, `ACCOUNT_LINKED`, `ACCOUNT_UNLINKED`, `ADMIN_CLIENT_CREATED`, `ADMIN_CLIENT_UPDATED`.

### MongoDB index

```
User:                    unique(email)
FederatedIdentity:        unique(provider, providerId)
Client:                   unique(clientId)
ClientCredential:         index(clientId, version)
Resource:                 unique(identifier)
Consent:                  unique(userId, clientId)
RefreshToken:             unique(tokenHash), index(userId, clientId), index(familyId), index(expiresAt)
PasswordResetToken:       unique(tokenHash)
EmailVerificationToken:   unique(tokenHash)
AuditLog:                 index(timestamp), index(userId), index(clientId), index(action)
```
Nếu multi-tenant kích hoạt: thêm `unique(tenantId, email)`, `unique(tenantId, clientId)`.

## 11. Danh sách endpoint

| Endpoint | Method | Ghi chú |
|---|---|---|
| `/authorize` | GET | nonce carry, PKCE S256, redirect_uri exact match, resource binding, tạo AuthorizeRequestContext, `iss` trong redirect response |
| `/token` | POST | atomic consume+bind cho authorization code; atomic rotation (hash-based) cho refresh token |
| `/userinfo` | GET | trả claims theo scope, verify access token qua JWKS |
| `/.well-known/openid-configuration` | GET | discovery, xem mục 12 |
| `/jwks.json` | GET | public key, nguồn từ KMS |
| `/consent` | GET/POST | hiển thị & xử lý quyết định consent, hỗ trợ `prompt` |
| `/auth/google`, `/auth/github` (+ `/callback`) | GET | identity broker, static provider, state riêng cho leg này |
| `/login`, `/register` | POST | rate limit đa chiều, chống account enumeration |
| `/password/reset`, `/password/verify-email` | POST | atomic single-use token, response đồng nhất bất kể tài khoản tồn tại hay không |
| `/revoke` | POST | thu hồi refresh token/family theo thiết bị |
| `/logout` | GET/POST | GET = xác nhận/khởi tạo RP logout, POST = destructive (local); `POST /logout?scope=all` = global logout |
| `/introspect` | POST | kiểm tra token hợp lệ real-time (RFC 7662) cho resource server cần |

## 12. Discovery endpoint

```json
{
  "issuer": "https://id.example.com",
  "authorization_endpoint": "https://id.example.com/authorize",
  "token_endpoint": "https://id.example.com/token",
  "userinfo_endpoint": "https://id.example.com/userinfo",
  "jwks_uri": "https://id.example.com/jwks.json",
  "end_session_endpoint": "https://id.example.com/logout",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid", "profile", "email"],
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "acr", "amr"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"]
}
```

## 13. Quy trình xây dựng A-Z

1. Khởi tạo project (NestJS + FastifyAdapter), ConfigModule (Joi/Zod), kết nối MongoDB (Mongoose) + Redis (ioredis)
2. Data model & index đầy đủ — bao gồm `Resource`, `ClientCredential`, `RefreshToken.tokenHash`, `PasswordResetToken`/`EmailVerificationToken`
3. Key management qua KMS/Vault, endpoint `/jwks.json` (RS256), thiết kế sẵn quy trình rotation thông thường và emergency
4. Module `clients` + `resources` — CRUD (admin-only), `clientType`, `token_endpoint_auth_method`, `redirect_uris` exact match, `allowedCorsOrigins`, `allowedResources` registry
5. Module `authentication` — đăng ký/đăng nhập, hash password (argon2), email verification & password reset với atomic single-use token, account lockout, chống enumeration, rate limit đa chiều
6. Endpoint `/authorize` — validate đầy đủ tham số, tạo `AuthorizeRequestContext`, resource binding, `iss` trong redirect response
7. Module `sessions` — cookie bảo mật, session fixation protection, idle/absolute timeout
8. Endpoint `/token` — Lua script atomic consume+bind cho authorization code; atomic rotation hash-based cho refresh token; access token có `aud` = resource đã bind
9. Module `consent` — chốt semantic scope trước khi code (9.4), versioning, xử lý `prompt`
10. Module `federation` — Google/GitHub (static provider), account linking yêu cầu re-auth
11. `/userinfo`, discovery đầy đủ, `/introspect`
12. `/logout` — local vs global, GET/POST semantics, RP-initiated + front-channel (back-channel có thể làm sau)
13. Module `admin` — step-up re-authentication cho thao tác nhạy cảm
14. Rate limiting & hardening hạ tầng (helmet, CORS theo `allowedCorsOrigins`, HTTPS bắt buộc)
15. Testing — security test matrix đầy đủ (mục 14)
16. Observability — Pino structured log (redact), Prometheus metrics, AuditLog mở rộng + alerting cho sự kiện nhạy cảm
17. CI/CD & triển khai — lint → test → build Docker image → deploy; secrets qua Vault/Secrets Manager; Redis Sentinel/Cluster; health check readiness/liveness
18. Vận hành sau launch — lịch rotate key/secret định kỳ, backup MongoDB + test restore, alert khi tỷ lệ lỗi `/token` bất thường, cookie topology test theo domain thực tế trước mỗi lần thêm app mới

## 14. Security test matrix

```
Authorization code:
  code reuse (kể cả 2 request đến cùng lúc) · expired code ·
  request /token với client_id/redirect_uri SAI không được làm mất hiệu lực
    code hợp lệ cho request đúng sau đó (premature consumption test) ·
  wrong code_verifier · PKCE "plain" bị reject · resource ngoài grant gốc bị reject

Refresh token:
  rotation atomic dưới concurrent request (không sinh ra 2 token hợp lệ từ 1 token gốc) ·
  reuse detected qua tra cứu hash → revoke cả family ·
  refresh không thể đổi sang scope/resource khác với grant gốc ·
  expired token bị reject

Resource:
  client xin resource ngoài allowedResources[] → reject ·
  token phát hành cho Resource A bị Resource B reject (audience mismatch)

Mix-up & issuer:
  RP nhận iss trong redirect response và so khớp đúng issuer đã cấu hình ·
  iss trong token khớp cấu hình

state/nonce:
  state được echo nguyên vẹn, không bị IdP dùng sai mục đích ·
  ID Token luôn chứa đúng nonce đã gửi trong request

Session:
  fixation (session ID đổi sau login) · expired session ·
  GET /logout không có side-effect huỷ session ·
  CSRF trên POST /logout bị chặn ·
  local logout không ảnh hưởng session của thiết bị khác; global logout revoke toàn bộ

Account & enumeration:
  duplicate email · social account linking yêu cầu re-auth · unverified email ·
  brute force đa chiều (IP/account/device) ·
  /login, /register, /password/reset trả response đồng nhất dù tài khoản tồn tại hay không ·
  password reset/email verification token atomic single-use dưới concurrent request

Multi-tenant:
  cross-tenant token issuance · cross-tenant consent ·
  cross-tenant client access · cross-tenant admin access

Admin control-plane:
  đổi redirect_uri/secret/resource permission yêu cầu step-up re-auth,
  thất bại nếu không có xác thực gần đây

Cookie & bảo mật chung:
  hành vi cookie thực tế theo từng cặp domain (app subdomain vs domain riêng),
  test trên Safari/Firefox/Chrome ·
  CSRF · XSS · open redirect · SSRF (federation provider tĩnh, không cho tuỳ ý cấu hình URL)
```

## 15. Security Invariants

1. Authorization code chỉ dùng một lần.
2. Authorization code hết hạn trong 60 giây.
3. PKCE S256 bắt buộc với mọi client dùng authorization code flow; không hỗ trợ `plain`.
4. `redirect_uri` phải khớp chính xác tuyệt đối với URI đã đăng ký — cấm wildcard dưới mọi hình thức.
5. ID Token phải chứa `nonce` do RP gửi trong request `/authorize`; IdP mang giá trị này vào token không đổi.
6. RP (client) chịu trách nhiệm validate `nonce` trong ID Token nhận được khớp với giá trị đã gửi ban đầu — đây không phải trách nhiệm của IdP.
7. `aud` của ID Token phải bằng `client_id`.
8. `aud` của Access Token phải bằng định danh của resource server dự định.
9. `iss` phải bằng issuer đã cấu hình; RP nên validate `iss` cả trong redirect response lẫn trong token để chống mix-up attack.
10. Refresh token được rotate ở mỗi lần dùng thành công; rotation phải atomic, tra cứu bằng hash của giá trị bí mật — không phải bằng ID có thể đoán được.
11. Refresh token đã revoke bị dùng lại là dấu hiệu reuse — phải revoke toàn bộ token family và buộc đăng nhập lại (strict rotation, không có grace-period retry).
12. Refresh token chỉ được cấp lại đúng `scope`/`resource` của grant gốc trong cùng family — không được mở rộng phạm vi khi refresh.
13. Authorization-code consumption phải atomic **và** phải bind/validate `client_id` + `redirect_uri` + PKCE challenge trong cùng một bước trước khi xoá khỏi store — một request `/token` không hợp lệ không được phép làm mất hiệu lực một code hợp lệ khác.
14. `resource` phải là absolute URI, không có fragment, và phải nằm trong `allowedResources[]` đã đăng ký cho client đó.
15. Một authorization grant chỉ bind với đúng một resource (quy tắc MVP).
16. Session ID là opaque, ngẫu nhiên, gắn cờ `HttpOnly` và `Secure`.
17. Session ID được cấp mới ngay sau khi xác thực thành công, không tái sử dụng session ID trước đó (chống session fixation).
18. Client secret không bao giờ lưu dạng plaintext; hỗ trợ rotation có overlap version.
19. Signing private key không bao giờ expose qua API; lưu trữ trong KMS/Vault, không lưu trong MongoDB.
20. Token OAuth/OIDC, mật khẩu, và client secret không bao giờ ghi vào log ứng dụng.
21. Public client bắt buộc dùng PKCE, vì không có `client_secret` nào thực sự bảo mật được ở phía client.
22. Account linking với danh tính liên kết (Google/GitHub) yêu cầu hành động xác thực rõ ràng của user đối với tài khoản local đã tồn tại — không tự động liên kết chỉ vì email trùng.
23. Federation provider chỉ được cấu hình tĩnh trong code ở giai đoạn MVP — không cho phép discovery URL do người dùng hoặc tenant tự nhập, để tránh SSRF.
24. Tenant context bắt buộc suy ra từ phiên đã xác thực và authorize — không bao giờ tin `tenantId` do client tự gửi lên; mọi query nhạy cảm phải có ràng buộc tenant tường minh ngay trong câu truy vấn.
25. Mọi thao tác nhạy cảm về bảo mật (đăng nhập, revoke, đổi cấu hình client, rotate key...) đều phải sinh audit event, không log giá trị bí mật trong event đó.
26. Thao tác quản trị nhạy cảm (đổi `redirect_uris`, rotate client secret, đổi quyền truy cập resource) bắt buộc step-up re-authentication trước khi thực hiện, ngoài audit thông thường.
27. `/login`, `/register`, `/password/reset`, `/password/verify-email` không được trả response khác biệt giữa "tài khoản không tồn tại" và các trường hợp khác, nhằm chống account enumeration.

## 16. Ưu tiên triển khai

**P0 — bắt buộc trước khi implementation**: nonce (đúng trách nhiệm RP/IdP) · PKCE S256 bắt buộc · redirect_uri exact match · atomic authorization-code consume kèm binding validation · atomic refresh-token rotation (tra cứu bằng hash) + reuse detection · refresh token bind `scope`/`resource` gốc · resource-scoped audience theo registry `allowedResources[]` (1 grant = 1 resource) · tách claim ID Token/Access Token · validate `iss`/`aud` · session cookie bảo mật + fixation protection · phân biệt client public/confidential + auth method · quản lý khóa ký qua KMS/Vault · account linking an toàn (yêu cầu re-auth) · tenant context luôn từ session đã xác thực · admin control-plane có step-up re-authentication.

**P1**: `iss` trong authorization response (chống mix-up attack) · password reset/email verification atomic single-use · chống account enumeration · phân biệt local logout và global logout · emergency key rotation · client secret rotation có overlap version · CORS tách riêng khỏi redirect_uri · audit log mở rộng kèm alerting cho sự kiện nhạy cảm · Redis HA (Sentinel/Cluster) · discovery endpoint đầy đủ · hỗ trợ `prompt=none/login/consent` · cross-tenant test matrix · cookie topology test theo domain thực tế.

**P2**: DPoP (sender-constrained token) · mở rộng `/introspect` · back-channel logout · admin UI (thay vì chỉ API) · risk-based authentication · dynamic client registration · dual-approval cho thao tác admin đặc biệt nhạy cảm.

## 17. Việc cần quyết định tiếp theo

- [ ] Consent scope: `user × client` hay `user × tenant × client × resource`?
- [ ] Grace period cụ thể khi rotate client secret (ví dụ 24 giờ hay 7 ngày?)
- [ ] Thời hạn cụ thể: access token (đề xuất 15 phút), refresh token (đề xuất 30 ngày sliding + rotation), idle session (đề xuất 8 giờ), absolute session (đề xuất 30 ngày)
- [ ] Quy ước đặt `identifier` cho từng Resource — dùng domain thật hay URN nội bộ?
- [ ] Danh sách domain thực tế của các app để lập cookie topology test matrix trước launch
- [ ] Redis: Sentinel hay Cluster, hạ tầng self-host hay managed
- [ ] KMS/Vault: dùng dịch vụ cloud-managed (AWS KMS, GCP KMS) hay self-host Vault
- [ ] Có cần dual-approval cho thao tác admin nhạy cảm ở production hay chỉ step-up re-auth là đủ?
- [ ] Thời điểm nâng DPoP từ P2 lên P1 (khi nào hệ thống có thêm mobile app hoặc public SPA/game client?)
- [ ] Ai sẽ là admin quản lý client/resource — cần admin UI hay chỉ dùng API/Postman ở giai đoạn đầu?
