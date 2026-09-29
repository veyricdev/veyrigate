# Senior Review — 2026-09-29 (B1.6–B1.10) — vòng 2

## Kết luận: **PASS** (B1.6 · B1.7 · B1.8 · B1.9 · B1.10)

Vòng 1 **REJECT** vì 🔴 #1 (dưới); backend-dev đã sửa, vòng 2 xác nhận lại → PASS. Đã đọc thật toàn bộ diff (`git status`/`git diff`: 9 file sửa trong `be/` + 22 file mới), đối chiếu spec §6.3/§6.4/§8/§10/§15 (INV-19/20/25), `tasks.md` A1–A6, lưu ý tech-lead. Phạm vi đúng, không lấn B2+ (không service identity/session, không endpoint admin rotate).

## 🔴 Blocker (vòng 1 — ĐÃ SỬA)

- [x] 🔴 **#1 — `TokenVerifier` chấp nhận JWT không có `exp`.** `jose.jwtVerify` chỉ kiểm `exp` *khi có mặt* (`jwt_claims_set.js:87 if (payload.exp !== undefined)`). Token ký bằng key hợp lệ nhưng thiếu `exp` → verify vĩnh viễn, trái spec §8 ("bắt buộc validate `exp`") và nghiệm thu B1.9 ("kiểm iss/aud/exp"). Hiện chỉ `TokenSigner` phát hành nên chưa khai thác được, nhưng verifier là cổng tin cậy duy nhất cho B3/B4 → phải chặt.
  **Fix**: `requiredClaims: ['exp']` trong `token-verifier.ts`. Vòng 2: `tsc`/`eslint` EXIT=0; tester phải có case "token không `exp` → FAIL".

## Theo task (vòng 2)

- **B1.6 PASS** — 11 schema + AuditLog khớp field §10; index khớp bảng §10 (A1, A2 đã ghi); TTL `expireAfterSeconds:0` trên `expiresAt` của RefreshToken + 2 one-time token; `models.ts` là registry duy nhất cho `forFeature` và `sync-indexes.ts` (mongoose thuần, `validateEnv`, không boot Nest); `autoIndex: nodeEnv !== 'production'`.
- **B1.7 PASS** — `AuditMetadata` cấm key bí mật ở type-level (`never`) + primitive-only (không lồng); `sanitizeMetadata` lọc runtime theo pattern normalize (bắt cả biến thể `client_secret`, `Authorization`…) và bỏ giá trị non-primitive; `record()` await insert, ném khi ghi lỗi (INV-25); listener alert lỗi được nuốt + log. `ALERT_ACTIONS` gồm reuse, key rotation, control-plane §9.11.
- **B1.8 PASS** — Lua `INCR`+`PEXPIRE`+`PTTL` atomic nhiều key/1 round-trip; key `rl:<name>:<dim>:<sha256>` (không PII thô); account chuẩn hoá `trim().toLowerCase()`; vượt BẤT KỲ chiều → 429 + `Retry-After` (filter OAuth giữ status 429 → `temporarily_unavailable`, header đã set trước khi throw). Lệch §6.3 (custom thay `@nestjs/throttler`) đã được tech-lead chấp nhận.
- **B1.9 PASS** (sau fix #1) — `LocalKeyProvider` dev-only (factory từ chối `production` và `aws-kms/vault` với thông điệp "B7.3"); PEM PKCS8 0600, state `keys.json` chỉ chứa public JWK dựng tay từ `n,e` → JWKS không thể có `d/p/q/dp/dq/qi` (INV-19); private key không vào Mongo/audit/log. Signer: RS256, `kid`, `iss`, `aud`, `exp`, `jti`. Verifier: `algorithms:['RS256']`, iss/aud, JWKS đọc lại mỗi lần → emergency rotate có hiệu lực ngay. Rotation normal giữ key cũ `ACCESS_TOKEN_TTL` giây (A5), emergency gỡ ngay; audit `SIGNING_KEY_ROTATED` (alert) với `metadata {mode, oldKid}`. `be/keys/` đã ignore (`git ls-files be/keys` = 0).
- **B1.10 PASS** — `SmtpMailer` có `connectionTimeout/greetingTimeout/socketTimeout`; template chỉ có link (escape HTML trong `href` và text) + thời hạn, không email/tên/token rời; `from = no-reply@<host ISSUER>` (A4).

## 🟡 Nên sửa (không chặn PASS → backlog)

- 🟡 **#2 — Rate-limit guard dựa `req.ip`**: Fastify chưa bật `trustProxy`, sau reverse proxy mọi request có cùng IP (của proxy) → chiều IP vô nghĩa/chặn nhầm. Chưa có proxy ở dev; xử lý khi triển khai gateway → **DEBT-006** (B7.x).
- 🟡 **#3 — `LocalKeyProvider.rotate()` xoá PEM trước `writeState()`**: nếu ghi `keys.json` lỗi giữa chừng, state còn trỏ active tới PEM đã xoá → không ký được tới khi rotate lại. Chỉ dev, rủi ro thấp; KeyProvider thật ở B7.3 → gộp vào **DEBT-007**.

## 💭 Nit (không yêu cầu sửa)

- `.vscode/settings.json` + `.github/agents/senior-reviewer.agent.md` có thay đổi ngoài phạm vi run (auto-approve lệnh terminal, đổi model) — **không commit** chung với run 04 trừ khi người dùng muốn.
- `getPublicKeys()` ghi file khi prune → verifier gọi mỗi request sẽ đụng đĩa; chấp nhận vì dev-only (JWKS cache Redis là việc của KeyProvider thật, spec §6.1).
- `sanitizeMetadata` loại cả key vô hại như `tokenCount` (pattern `token`) — chủ ý an toàn, chấp nhận.

## Lưu ý cho tester

1. Case verify: token thiếu `exp` → **FAIL** (fix #1); `alg` khác RS256 / `iss` sai / `aud` sai / hết hạn → FAIL.
2. Audit: `@ts-expect-error` cho key cấm + runtime strip (kể cả qua cast `any`), ghi lỗi → `record()` reject.
3. Rate-limit thật trên Redis (6479): đổi IP liên tục, cùng email (khác hoa/thường) → 429 + `Retry-After` ≥ 1.
4. Index sau `syncIndexes()` đọc `collection.indexes()` thật (Mongo 27117) + E11000 + TTL.
5. Mailer: gửi thật tới Mailpit và đọc API `:8025`; nếu cổng Mailpit bị chiếm, dùng container riêng.
