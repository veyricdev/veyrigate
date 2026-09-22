# Run Plan — SSO IdP qua pipeline AI team

Kế hoạch chia `sso-idp-spec-final.md` thành các **lần chạy orchestrator** độc lập, có thứ tự
phụ thuộc. Mỗi lần chạy = 1 module đủ nhỏ để pipeline (analyst → tech-lead → dev → senior →
tester) hoàn thành gọn trong giới hạn retry.

## Cách dùng

- Chạy **tuần tự theo số thứ tự** — module sau phụ thuộc module trước.
- Với mỗi module: gõ vào chat lệnh trong cột "Lệnh chạy".
- Spec đã hoàn chỉnh nên **có thể bỏ qua analyst**: xem mục "Biến thể nhanh" ở cuối.
- Slug dùng chung: `sso-idp`. Các file handoff nằm ở `docs/agile/sso-idp/`.

## Điều kiện tiên quyết (bạn tự chuẩn bị, agent KHÔNG dựng được)

- [ ] MongoDB chạy được (local/docker) cho integration test
- [ ] Redis chạy được (single instance đủ cho dev; Sentinel/Cluster là việc hạ tầng)
- [ ] Cơ chế KMS/Vault hoặc **stub** ký RS256 cho môi trường dev (spec §6.4)
- [ ] Quyết các mục còn treo ở spec §17 (ít nhất: consent scope, token TTL, resource identifier)

---

## Thứ tự chạy (P0 trước)

| # | Module | Spec ref | Phụ thuộc | Nhãn |
|---|--------|----------|-----------|------|
| 0 | Bootstrap project | §5, §13.1 | — | [BE] |
| 1 | Data model + index | §10 | 0 | [BE] |
| 2 | Config + kết nối Mongo/Redis | §3, §6.1 | 0 | [BE] |
| 3 | Key management + `/jwks.json` (RS256) | §6.4, §13.3 | 1,2 | [BE] |
| 4 | Clients + Resources CRUD (admin-only) | §7, §9.3, §13.4 | 1 | [BE] |
| 5 | Authentication (register/login/argon2/lockout/enumeration) | §9.12, §13.5 | 1,2 | [BE] |
| 6 | Email verification + password reset (atomic single-use) | §9.5, §13.5 | 5 | [BE] |
| 7 | Sessions (cookie bảo mật, fixation, timeout) | §9.6, §13.7 | 2,5 | [BE] |
| 8 | `/authorize` + AuthorizeRequestContext + resource binding | §9.1, §9.2 | 4,7 | [BE] |
| 9 | Consent screen + versioning + `prompt` | §9.4 | 8 | [BE]+[FE] |
| 10 | `/token` — atomic consume+bind + PKCE + phát token | §9.5, §8 | 3,8 | [BE] |
| 11 | Refresh token — atomic rotation + reuse detection | §9.5 | 10 | [BE] |
| 12 | `/userinfo` + discovery + `/introspect` | §11, §12 | 10 | [BE] |
| 13 | Federation Google/GitHub (broker, re-auth linking) | §9.9 | 8 | [BE] |
| 14 | Logout local/global + CSRF boundary | §9.8 | 7,11 | [BE] |
| 15 | Admin control-plane + step-up re-auth | §9.11 | 4 | [BE] |
| 16 | Rate limit đa chiều + helmet + CORS tách redirect_uri | §6.3, §9.7 | 5,8 | [BE] |
| 17 | Multi-tenancy enforcement (tenant từ session) | §9.10 | 4,8 | [BE] |
| 18 | Audit log + alerting sự kiện nhạy cảm | §10, §13.16 | nhiều | [BE] |

> P1/P2 (§16): emergency key rotation, front/back-channel logout, DPoP, admin UI, risk-based
> auth — chạy sau khi P0 (module 0–12) ổn định.

---

## Lệnh chạy từng module

Mỗi lệnh giữ slug `sso-idp` để dùng chung thư mục handoff. Chạy tuần tự theo số.

```
# 0 — Bootstrap project
@orchestrator Bootstrap NestJS + FastifyAdapter + ConfigModule theo sso-idp-spec-final.md §5,§13.1. Slug: sso-idp.

# 1 — Data model + index
@orchestrator Định nghĩa toàn bộ Mongoose schemas + index (User, FederatedIdentity, Client, ClientCredential, Resource, RefreshToken, PasswordResetToken, EmailVerificationToken, Consent, Tenant, UserTenant, AuditLog) theo §10. Slug: sso-idp.

# 2 — Config + kết nối Mongo/Redis
@orchestrator Config validation (Joi/Zod) + module kết nối MongoDB (Mongoose) & Redis (ioredis, Lua script loader) theo §3,§6.1. Slug: sso-idp.

# 3 — Key management + /jwks.json
@orchestrator Key management qua KMS/Vault (hoặc stub dev ký RS256) + endpoint GET /jwks.json, mỗi key có kid, thiết kế sẵn quy trình rotation thường + emergency theo §6.4,§13.3. Slug: sso-idp.

# 4 — Clients + Resources CRUD (admin-only)
@orchestrator Module clients + resources CRUD admin-only: clientType public/confidential, token_endpoint_auth_method, redirect_uris exact match, allowedCorsOrigins, allowedResources registry, ClientCredential rotation có version theo §7,§9.3,§13.4. Slug: sso-idp.

# 5 — Authentication
@orchestrator Authentication: register/login hash argon2, account lockout (failedLoginCount/lockedUntil), chống account enumeration (response đồng nhất), rate limit đa chiều theo §9.12,§13.5. Slug: sso-idp.

# 6 — Email verification + password reset
@orchestrator Email verification + password reset dùng tokenHash atomic single-use (findOneAndUpdate check usedAt+expiresAt) theo §9.5,§13.5. Slug: sso-idp.

# 7 — Sessions
@orchestrator Module sessions: cookie idp_session opaque HttpOnly Secure SameSite=Lax, Redis-backed, session fixation protection (cấp ID mới sau login), idle + absolute timeout theo §9.6,§13.7. Slug: sso-idp.

# 8 — /authorize + AuthorizeRequestContext + resource binding
@orchestrator Endpoint GET /authorize: validate tham số (redirect_uri exact match, code_challenge_method=S256, resource ∈ allowedResources), tạo AuthorizeRequestContext (Redis TTL 5-10p single-use), phân biệt state/nonce/request_id, iss trong redirect response (RFC 9207) theo §9.1,§9.2. Slug: sso-idp.

# 9 — Consent screen + versioning + prompt
@orchestrator Module consent: kiểm tra Consent đã bao phủ scope + đúng policyVersion/termsVersion, trang consent [FE], xử lý prompt=none/login/consent, allow/deny theo §9.4. Slug: sso-idp.

# 10 — /token atomic consume+bind + PKCE
@orchestrator Endpoint POST /token: Lua script atomic consume authorization code kèm binding validation (client_id+redirect_uri) TRƯỚC khi xoá, verify PKCE code_verifier S256, xác thực client theo auth method, phát access token (aud=resource đã bind) + id_token (nonce) + refresh_token theo §9.5,§8. Slug: sso-idp.

# 11 — Refresh token rotation + reuse detection
@orchestrator Refresh token: atomic rotation tra cứu bằng SHA-256 hash (findOneAndUpdate revokedAt:null), strict rotation — reuse detected → revoke toàn bộ family; token mới giữ nguyên scope/resource gốc theo §9.5. Slug: sso-idp.

# 12 — /userinfo + discovery + /introspect
@orchestrator Endpoint GET /userinfo (verify access token qua JWKS, trả claims theo scope), GET /.well-known/openid-configuration (§12), POST /introspect (RFC 7662) theo §11,§12. Slug: sso-idp.

# 13 — Federation Google/GitHub
@orchestrator Module federation (Identity Broker): Google/GitHub static provider config, state riêng của IdP cho leg này + gắn request_id, FederatedIdentity collection riêng, KHÔNG auto-link theo email trùng — yêu cầu re-auth, ràng buộc SSRF (chỉ endpoint cứng) theo §9.9. Slug: sso-idp.

# 14 — Logout local/global + CSRF boundary
@orchestrator Logout: GET /logout chỉ hiển thị xác nhận (không side-effect), POST /logout destructive (CSRF-protected) huỷ session + revoke refresh family; POST /logout?scope=all global logout mọi thiết bị; RP-initiated + front-channel theo §9.8. Slug: sso-idp.

# 15 — Admin control-plane + step-up re-auth
@orchestrator Module admin: đổi redirect_uris / rotate client secret / đổi allowedResources / đổi vai trò admin bắt buộc step-up re-authentication + audit log đầy đủ theo §9.11. Slug: sso-idp.

# 16 — Rate limit + helmet + CORS
@orchestrator Hardening: @fastify/helmet, rate limit đa chiều (IP+account+device) qua @nestjs/throttler + Redis, CORS dùng allowedCorsOrigins tách khỏi redirect_uris, HTTPS enforce theo §6.3,§9.7. Slug: sso-idp.

# 17 — Multi-tenancy enforcement
@orchestrator Multi-tenancy: tenant context luôn suy ra từ phiên đã xác thực (KHÔNG tin tenantId client gửi), mọi query nhạy cảm có ràng buộc tenant tường minh, cách ly cross-tenant theo §9.10. Slug: sso-idp.

# 18 — Audit log + alerting
@orchestrator Audit log chuẩn hoá (không log secret/token), alert riêng cho TOKEN_REUSE_DETECTED, SIGNING_KEY_ROTATED (emergency), và mọi thao tác admin control-plane theo §10,§13.16. Slug: sso-idp.
```

### P1/P2 (chạy sau khi module 0–18 ổn định)

```
# P1 — emergency key rotation
@orchestrator Emergency key rotation: publish key mới + gỡ key cũ khỏi JWKS ngay theo §6.4. Slug: sso-idp.

# P1 — back-channel logout
@orchestrator Back-channel logout: server-to-server notify RP theo §9.8(4). Slug: sso-idp.

# P2 — DPoP sender-constrained token
@orchestrator DPoP (RFC 9449) sender-constrained access token theo §9.13. Slug: sso-idp.

# P2 — admin UI
@orchestrator Admin UI [FE] cho quản lý client/resource (thay vì chỉ API) theo §16 P2. Slug: sso-idp.

# P2 — risk-based authentication
@orchestrator Risk-based authentication module theo §5(security/risk). Slug: sso-idp.
```

---

## Biến thể nhanh (bỏ qua analyst khi spec đã đủ)

Spec này đã hoàn chỉnh, có acceptance criteria (§14,§15). Với mỗi module có thể chạy thẳng:

```
@tech-lead Review tính khả thi module "<tên>" theo sso-idp-spec-final.md <ref>. Slug: sso-idp. Trả PASS/REJECT.
# nếu PASS:
@backend-dev Implement module "<tên>" theo <ref> và review-techlead.md. Slug: sso-idp.
@senior-reviewer Review code module "<tên>". Slug: sso-idp.
@tester Viết+chạy test theo acceptance criteria §14/§15 cho module "<tên>". Slug: sso-idp.
```

---

## Lưu ý giới hạn

- **Retry cap = 2** mỗi cổng. Module phức tạp (10,11,13) dễ REJECT/FAIL nhiều lần → nếu kẹt,
  chia nhỏ hơn nữa (vd tách "PKCE verify" khỏi "phát token").
- Agent **không dựng hạ tầng thật** (KMS, Redis HA, k8s). Chuẩn bị sẵn hoặc dùng stub dev.
- Module 9 có phần [FE] (trang consent + trang login) → frontend-dev tham gia; phần còn lại
  gần như thuần [BE].
