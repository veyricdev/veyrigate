# Tasks — run 28 — B6.3b: users, refresh families, consents, audit log, keys, tenants (M5)

> Plan §B6 dòng 212 (B6.3 phần b), D6, spec §9.10 (tenant từ token, query có tenant tường minh), §9.11 (step-up + audit: **đổi vai trò admin khác**, rotate key), §10 (AuditLog, RefreshToken `familyId/familyRevokedAt`, Consent `user×client×resource`), B1.7, B1.9 (KeyProvider + JWKS, rotate thường/khẩn cấp), B4.5 (revoke family), B4.7 (revoke mọi session/family). Tái dùng nền tảng run 27: `AdminTokenGuard`, `@AdminScope`, `@RequireRecentAuth(5)`, `@CurrentAdmin`, mapper allowlist, phân trang `{items,nextCursor}`, 404 đồng nhất, `adminAuditBase`, OpenAPI.
>
> Thứ tự: Task 1 → 2 → 3 → 4 (backend-dev). Mọi mutation: `admin.write` + step-up + audit. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop dữ liệu `aegate-*`.

### [x] Task 1 [BE]: Users — list/get/lock/unlock/revoke sessions/đổi vai trò
- `GET /admin/users` (member của tenant qua `UserTenant`; lọc email/status, phân trang), `GET /admin/users/:id`.
- `POST .../lock` / `unlock` (`lockedUntil`/`failedLoginCount` B2.4), `POST .../sessions/revoke` (huỷ mọi session + revoke mọi refresh family của user — tái dùng đường logout global B4.7), `PATCH .../roles` (UserTenant.roles; spec §9.11 step-up; tenant_admin không cấp/thu `super_admin`, không tự hạ quyền cuối cùng — tech-lead chốt).
- Response không chứa `passwordHash`, token, MFA secret.
- **Acceptance**: int: cross-tenant 404 đồng nhất; lock ⇒ login bị chặn; revoke ⇒ access token cũ 401 (tombstone/liveness), refresh ⇒ `invalid_grant`; leo thang role bị 403; audit đúng action.

### [x] Task 2 [BE]: Refresh-token families + consents
- `GET /admin/users/:id/families` (metadata: familyId, clientId, resource, issuedAt, lastUsed, revoked — không `tokenHash`), `POST .../families/:familyId/revoke` (đóng dấu `familyRevokedAt` như B4.5 để race-safe), audit `TOKEN_REVOKED`.
- `GET /admin/users/:id/consents`, `DELETE .../consents/:consentId` (revoke consent; lần authorize sau phải hỏi lại), audit.
- **Acceptance**: int: revoke family ⇒ refresh cũ/mới `invalid_grant`; revoke consent ⇒ `/authorize` hiện lại consent; cross-tenant (family/consent của client tenant khác) 404.

### [x] Task 3 [BE]: Audit log query
- `GET /admin/audit` lọc `action`, `actorId`, `targetType/targetId`, `clientId`, `result`, khoảng thời gian; phân trang server-side (cursor theo `timestamp,eventId`), sort giảm dần; index phù hợp (`{tenantId, timestamp}`…).
- Chỉ tenant của token; không trường bí mật (đã sanitize B1.7).
- **Acceptance**: int: lọc + phân trang ổn định khi có ghi mới; cross-tenant không thấy; limit trần; index tồn tại (`indexes.int-spec`).

### [ ] Task 4 [BE]: Keys + tenants (read-only)
- `GET /admin/keys` (metadata JWKS: kid, alg, status, createdAt — không private key), `POST /admin/keys/rotate` (thường: key mới active, key cũ vẫn trong JWKS tới khi hết TTL token) và `?emergency=true` (key cũ loại khỏi JWKS ngay ⇒ token cũ invalid); chỉ `super_admin`, step-up, audit `SIGNING_KEY_CREATED/ROTATED` (alert).
- `GET /admin/tenants` (read-only; tenant_admin chỉ thấy tenant mình).
- **Acceptance**: int: rotate thường ⇒ token cũ vẫn verify, token mới ký `kid` mới; emergency ⇒ token cũ 401; tenant_admin rotate ⇒ 403; JWKS endpoint phản ánh đúng.

## Câu hỏi cho tech-lead
- Q-28.1: DEBT-124 — `super_admin` xuyên tenant: làm trong run này (users/tenants cần) hay hoãn tiếp; nếu làm, cơ chế chỉ định tenant đích.
- Q-28.2: Quy tắc đổi vai trò (ai cấp `super_admin`, chặn tự hạ quyền admin cuối cùng).
- Q-28.3: Rotate key với `LocalKeyProvider` (dev) — lưu trạng thái key ở đâu, đa node.
- Q-28.4: Phạm vi có vừa 1 run không; nếu không, tách Task 4 sang run 29.

---

## Fold tech-lead — 2026-10-16 (ưu tiên hơn text phía trên)

Trả lời: xem `review-techlead.md` (Q-28.1 hoãn DEBT-124; Q-28.2 quy tắc vai trò dưới đây; Q-28.3/Q-28.4 Task 4 sang run 29).

**Phạm vi cuối run 28 = Task 1 → 2 → 3.** Task 4 (keys + tenants) **CHUYỂN run 29** (DEBT-146), làm cùng DEBT-145 (mutex rotate, bắt buộc), DEBT-125, DEBT-132. Run 28 KHÔNG đụng `modules/keys`.

### Chung (Task 1–3)
- Mọi route dưới `/admin/users/:id/**`: target phải có `UserTenant` (status bất kỳ) ở **tenant của token** (`UserTenantService.findMember(ctx, id)`). ObjectId sai, không phải member hoặc thuộc tenant khác ⇒ **404 byte-identical** (`AdminAuthError.notFound`). Áp cho cả super_admin (DEBT-124 vẫn hoãn, xem Q-28.1).
- GET dùng `admin.read`. Mọi mutation dùng `admin.write` + `@RequireRecentAuth(5)` + audit (`adminAuditBase`). Body/query qua DTO `whitelist+forbidNonWhitelisted` (có `tenantId` ⇒ 400). Phân trang `paginate` `{items,nextCursor}`, `limit` 1..100.
- Audit action mới (thêm vào enum và `ALERT_ACTIONS`): `ADMIN_USER_LOCKED`, `ADMIN_USER_UNLOCKED`, `ADMIN_USER_ROLES_CHANGED`, `OAUTH_CONSENT_REVOKED`. Revoke session/family dùng `SESSION_REVOKED`/`TOKEN_REVOKED` sẵn có, `actorType:'admin'`. Metadata phẳng, key không chứa `token|secret|...` (vd. `familyId`, `count`, `addedRoles`, `removedRoles` dạng chuỗi nối bằng `,`).
- Mapper allowlist cho user: `id` (sub), `email`, `emailVerified`, `locked` (`lockedUntil>now`), `lockedUntil`, `membershipStatus`, `roles`, `createdAt`. CẤM `passwordHash`, `mfaSecret`, `lockTransitionNonce`, `failedLoginCount`, `tokenHash`, `sessionRef`, `deviceId`, `ip`.

### Task 1 (users) — fold
- `GET /admin/users`:
  - Phân trang theo `UserTenant._id` trong tenant; join `User` bằng `$in` trên các userId của trang (2 query).
  - Lọc `status` = membership status (enum).
  - Lọc `email` = **khớp chính xác** sau `normalizeEmail` (KHÔNG regex, không prefix): resolve user theo email rồi kiểm membership; không thấy ⇒ `items:[]`.
- Hàm dùng chung `revokeAllUserCredentials(userId)`: chính là 3 bước của `resetPassword` (refresh `revokeAllForUser` → `sessions.revokeAllForUser` → SWEEP refresh). Chạy đủ 3 bước, giữ lỗi đầu rồi ném lại (ngữ nghĩa DEBT-055). `resetPassword` chuyển sang gọi hàm này; test reset hiện có phải giữ xanh.
- **Quy tắc target nhạy cảm** (lock, unlock, sessions-revoke): actor KHÔNG phải `super_admin` mà target (a) giữ `super_admin`/`tenant_admin` ở BẤT KỲ tenant nào, hoặc (b) có membership `active` ở tenant khác tenant của token ⇒ **403 `forbidden`**, không đổi gì. Lý do: `User`, `lockedUntil` và session đều là global.
- **Không tự thao tác**: target = `ctx.userId` khi lock hoặc PATCH roles ⇒ 403.
- `POST .../lock`: đặt `lockedUntil` = sentinel `9999-12-31T23:59:59.999Z` (khoá tới khi unlock; theo B2.4, login khi đang khoá không tăng đếm) **rồi** gọi `revokeAllUserCredentials`. Revoke lỗi ⇒ giữ lock, audit `failure reason:'revoke_failed'` best-effort, trả 5xx; gọi lại là idempotent.
- `POST .../unlock`: `$set failedLoginCount:0`, `$unset lockedUntil` (dùng lại `resetFailedLogins`); không revoke gì.
- `POST .../sessions/revoke`: gọi `revokeAllUserCredentials`; audit `SESSION_REVOKED` metadata `{scope:'all', count}`.
- `PATCH .../roles`:
  - Body `{roles: ('tenant_admin'|'super_admin')[]}`: unique, ≤2 phần tử, thay nguyên mảng.
  - Quy tắc Q-28.2: tự đổi vai trò của mình ⇒ 403. Diff chạm `super_admin`, HOẶC target đang giữ `super_admin` ⇒ chỉ super_admin được làm (người khác ⇒ 403). tenant_admin chỉ cấp/thu `tenant_admin` cho người khác.
  - Ghi bằng `findOneAndUpdate` tenant-scoped; before-doc dùng để tính diff cho audit. Không có thay đổi ⇒ không audit.
- **Acceptance bổ sung (int, test âm đo được)**:
  - tenant_admin cấp `super_admin` cho người khác hoặc cho chính mình ⇒ 403, DB không đổi.
  - tenant_admin sửa vai trò hoặc lock một super_admin ⇒ 403.
  - tenant_admin lock user có membership active ở tenant B ⇒ 403, `lockedUntil` không đổi.
  - Tự lock hoặc tự đổi vai trò ⇒ 403.
  - Giáng `tenant_admin` của B ⇒ request admin kế tiếp của B bằng token cũ ⇒ 403 `forbidden`.
  - Lock ⇒ login đúng mật khẩu bị từ chối; AT cũ của user 401 ở `/userinfo` và admin; refresh ⇒ `invalid_grant`.
  - Unlock ⇒ login lại được.
  - Response không chứa các field cấm (assert tập key).
  - Audit đúng action, actorType `admin`, tenantId.

### Task 2 (families + consents) — fold
- Mọi truy vấn lọc theo `userId` của target và `clientId ∈ C`, với `C` = `Client.find({tenantId: ctx.tenantId, clientId: {$in: <distinct clientId của user>}})` (tenant tường minh ngay trong query, INV-24).
- `GET .../families`:
  - Aggregate `RefreshToken` theo `familyId` (dùng index `{userId,clientId}`).
  - Trả `familyId`, `clientId`, `resource`, `scope`, `createdAt` = min `issuedAt`, `lastRotatedAt` = max `issuedAt`, `expiresAt` = max, `active` (còn member có `revokedAt:null` và `expiresAt>now`), `revokedAt` = `familyRevokedAt`.
  - Cursor = `familyId` (sort asc).
  - Không trả `tokenHash`, `parentId`, `replacedBy`, `sessionRef`, `deviceId`, `ip`, `userAgent`.
- `POST .../families/:familyId/revoke`:
  - Tìm 1 doc `{familyId, userId}`; `clientId` phải thuộc `C`, không thì 404.
  - Gọi `refreshTokens.revokeFamily(familyId, clientId, now)` (stamp-first sẵn có).
  - Audit `TOKEN_REVOKED` khi `count>0`. Family đã revoke ⇒ trả thành công, không audit.
- `GET .../consents`: mặc định chỉ `revokedAt:null`, cursor `_id`. Trả `id`, `clientId`, `resource`, `grantedScopes`, `policyVersion`, `termsVersion`, `grantedAt`, `updatedAt`.
- `DELETE .../consents/:consentId`:
  - `findOneAndUpdate({_id, userId, clientId:{$in:C}, revokedAt:null}, {$set:{revokedAt:now}})`. ObjectId sai hoặc không khớp ⇒ 404. Consent đã revoke ⇒ 404 hoặc 204 (chọn một, có test giữ).
  - **Sau đó** revoke family bằng biến thể mới `RevokeFilter {userId, clientId, resource}` qua `revokeWhere` (KHÔNG viết updateMany riêng, DEBT-034).
  - Audit `OAUTH_CONSENT_REVOKED` metadata `{clientId, resource, count}`.
- **Acceptance bổ sung**:
  - Revoke consent ⇒ refresh của `user×client×resource` đó trả `invalid_grant`; family của resource khác cùng client vẫn sống.
  - Family/consent thuộc client tenant B (kể cả khi user là member tenant A) ⇒ không xuất hiện trong list; revoke ⇒ 404, DB không đổi.
  - Response families không có `tokenHash` (assert tập key).
  - Mutation bỏ biến thể mới trong `revokeWhere` ⇒ test RED.

### Task 3 (audit query) — fold
- Filter cứng `tenantId: ctx.tenantId` (ghép cuối, đè input). Event không có `tenantId` (các event OAuth/auth hiện nay) KHÔNG hiện. Chấp nhận, ghi DEBT-140.
- Query:
  - `action` ∈ `AuditAction`; `result` ∈ `success|failure`.
  - `actorId`/`targetId`/`clientId` dài ≤128; `targetType` dài ≤64.
  - `from`/`to` ISO 8601, phải có `from<to`, không thì 400.
  - Mọi lọc là khớp chính xác, không regex.
- Sort `{timestamp:-1, eventId:-1}`. Cursor opaque base64url `{t,e}` có validate (sai ⇒ 400 `invalid_request`). Điều kiện trang sau: `timestamp<t OR (timestamp=t AND eventId<e)`.
- Index mới `AuditLogSchema.index({tenantId:1, timestamp:-1, eventId:-1})`; `indexes.int-spec` khẳng định; ghi vào `runbook-deploy.md` bước chạy `db:sync-indexes`.
- Mapper: `eventId, timestamp, actorType, actorId, action, targetType, targetId, clientId, ip, userAgent, requestId, result, reason, metadata`; không trả `_id`.
- **Acceptance bổ sung**:
  - Chèn event mới giữa lúc lấy trang 1 và trang 2 ⇒ trang 2 không lặp, không sót.
  - ≥2 event cùng `timestamp` ⇒ phân trang đúng theo `eventId`.
  - Event của tenant B và event không có tenantId không xuất hiện.
  - `?tenantId=` ⇒ 400; `limit=101` ⇒ 400.

### Task 4 — CHUYỂN run 29 (ghi lại để không mất ý)
- Thêm `listKeys()` (metadata kid/alg/status/createdAt/retireAt) vào `KeyProvider`.
- `POST /admin/keys/rotate` nhận body `{mode:'normal'|'emergency'}` (không dùng query). Chỉ `super_admin`, có step-up. `KeyRotationService.rotate` nhận `adminAuditBase`.
- **Bắt buộc DEBT-145**: serialise `LocalKeyProvider.rotate` bằng promise-chain mutex; test normal ∥ emergency ⇒ kid cũ KHÔNG còn trong JWKS.
- `GET /admin/tenants`: tenant_admin chỉ thấy tenant mình; super_admin thấy tất cả.
