# Phase B — Backend foundation (M1) — run 04: B1.6–B1.10

Nguồn: `plan.md` §5.B1 (dòng B1.6–B1.10) · spec §5 (cấu trúc), §6.1 (Mongo vs Redis), §6.3 (rate-limit), §6.4 (key management), §10 (data model + index), §15 (INV-19/20/25).
spec.md/plan.md đã có → orchestrator sinh tasks (bỏ qua analyst). Trạng thái: `todo → in-progress → in-review → testing → done`.

**Backlog trong phạm vi**: không kéo DEBT nào. DEBT-001 (`/ready` body) → để B7.2; DEBT-002 (config) chỉ xử lý nếu phải sửa `config.module.ts` (run này KHÔNG cần: dùng env sẵn có `KEY_*`, `SMTP_URL`, `RATE_LIMIT_*`).

**Giả định đã chốt (orchestrator)** — không cần người dùng quyết:
- A1: Chỉ index cơ bản §10; nhánh "multi-tenant kích hoạt" (`unique(tenantId,email)`, `unique(tenantId,clientId)`) để B2.1.
- A2: `AuditLog` không có field `userId` → index(userId) của §10 hiện thực bằng index(`actorId`).
- A3: `deviceId` cho rate-limit lấy từ header `x-device-id` (chưa có cookie plugin; B2.3 có thể đổi nguồn).
- A4: Người gửi email = `no-reply@<hostname của ISSUER>` (không thêm env mới).
- A5: Rotation thường giữ key cũ trong JWKS thêm `ACCESS_TOKEN_TTL` giây (TTL dài nhất của JWT ký bằng key). Chưa có endpoint admin để rotate (thuộc B6.3).
- A6: `jose` pin 5.x (có build CJS; `be/` là CommonJS + ts-jest).

---

## B1.6 — Schema §10 + index/TTL + sync index tường minh `[BE]`
**Phụ thuộc**: B1.4 · **Size**: M · **Trạng thái**: done
- [x] Schema Mongoose cho: User, FederatedIdentity, Client, ClientCredential, Resource, RefreshToken, PasswordResetToken, EmailVerificationToken, Consent, Tenant, UserTenant (vị trí theo spec §5 `modules/<x>/schemas/`)
- [x] Index đúng §10; **TTL** (`expireAfterSeconds: 0`) trên `expiresAt` của RefreshToken, PasswordResetToken, EmailVerificationToken
- [x] Registry tập trung các model + script `db:sync-indexes` (gọi `syncIndexes()`); `autoIndex` tắt khi `NODE_ENV=production`
**Nghiệm thu**: unique/TTL index tồn tại đúng §10 (đọc `collection.indexes()` sau sync) · insert trùng unique bị từ chối (E11000).

## B1.7 — Module Audit `[BE]`
**Phụ thuộc**: B1.6 · **Size**: M · **Trạng thái**: done
- [x] Schema AuditLog đủ field §10 + index(timestamp, actorId, clientId, action)
- [x] Enum action (danh sách tham khảo §10)
- [x] `AuditService.record()` — type-level cấm key bí mật trong `metadata` (`password/token/secret/...`) + lọc runtime (defense in depth)
- [x] Hook alert cho `TOKEN_REUSE_DETECTED`, `SIGNING_KEY_ROTATED` (+ action admin control-plane theo §10)
**Nghiệm thu**: INV-25 · payload chứa `password/token/secret` không compile (`@ts-expect-error`) VÀ bị loại lúc runtime · event alert kích hoạt hook.

## B1.8 — Rate-limit đa chiều trên Redis `[BE]`
**Phụ thuộc**: B1.4 · **Size**: M · **Trạng thái**: done
- [x] Service đếm atomic trên Redis theo chiều IP / account(email, chuẩn hoá lowercase) / deviceId; key không chứa PII thô (hash)
- [x] Decorator `@RateLimit(...)` + guard; vượt ngưỡng ở BẤT KỲ chiều nào → 429 + `Retry-After`; mặc định lấy `RATE_LIMIT_MAX/WINDOW`
**Nghiệm thu**: §6.3 · brute-force đổi IP liên tục vẫn bị chặn theo account.

## B1.9 — KeyProvider + LocalKeyProvider + /jwks.json + TokenSigner/Verifier + rotation `[BE]`
**Phụ thuộc**: B1.6 · **Size**: L · **Trạng thái**: done
- [x] Interface `KeyProvider`; `LocalKeyProvider` (RSA-2048, file PKCS8 trong `KEY_LOCAL_DIR`, **chỉ dev** — từ chối khi `production`; `aws-kms/vault` → lỗi rõ "B7.3")
- [x] `GET /jwks.json` chỉ public (`kty,n,e,kid,alg=RS256,use=sig`) — không bao giờ có `d/p/q/dp/dq/qi`
- [x] `TokenSigner` (jose, `iss`=ISSUER, header `kid`) / `TokenVerifier` (kiểm iss/aud/exp/alg RS256, chọn key theo `kid`)
- [x] Rotation **thường** (key cũ verify-only tới hết hạn, A5) & **khẩn cấp** (gỡ key cũ ngay); ghi audit `SIGNING_KEY_ROTATED`
- [x] `be/keys/` vào `.gitignore`
**Nghiệm thu**: INV-19 (private key không lộ qua API/log) · sau rotate thường token cũ vẫn verify, JWKS còn key cũ · sau rotate khẩn cấp token cũ FAIL, JWKS mất key cũ.

## B1.10 — Mailer + SMTP (Mailpit) + template verify/reset `[BE]`
**Phụ thuộc**: B1.2 · **Size**: S · **Trạng thái**: done
- [x] Interface `Mailer` + adapter SMTP (nodemailer, `SMTP_URL`, có timeout)
- [x] Template verify-email / reset-password: chỉ chứa link (escape HTML), không email/tên/token rời
**Nghiệm thu**: email tới Mailpit (đọc API `:8025`) · template không chứa dữ liệu thừa.
