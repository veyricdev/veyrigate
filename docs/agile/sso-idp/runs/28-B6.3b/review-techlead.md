# Tech Lead Review — 2026-10-16

## Kết luận: PASS (có fold bắt buộc trong `tasks.md` mục "Fold tech-lead"; Task 4 tách sang run 29)

Không có blocker cần người quyết định. Các chỗ lệch so với code thật và các lỗ leo thang quyền đã fold thẳng vào `tasks.md` (fold ưu tiên hơn text cũ). Phạm vi cuối của run 28 là **Task 1–3**. **Task 4 (keys + tenants) chuyển sang run 29**, đi cùng một fix race bắt buộc (DEBT-145) và DEBT-125/132.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ modular monolith. Thêm `AdminUsersController` (users, families, consents) và `AdminAuditController` vào `AdminModule`, dùng lại `UserTenantService`/`UserService`/`SessionService`/`RefreshTokenService`/`ConsentService`/`AuditService` cùng nền run 27 (guard, step-up, mapper allowlist, `paginate`, `adminAuditBase`). Ngoài các thứ sau thì không thêm lớp trừu tượng nào:
- Một hàm `revokeAllUserCredentials(userId)`: tách 3 bước của `resetPassword` (revoke family → revoke session MARK → SWEEP, giữ ngữ nghĩa DEBT-055), để reset password, lock và revoke-sessions dùng chung.
- Một biến thể `RevokeFilter` `{userId, clientId, resource}` đi qua `revokeWhere` (vẫn stamp-first INV-11, vẫn là cửa duy nhất DEBT-034).
- Một index audit `{tenantId:1, timestamp:-1, eventId:-1}`.

Không cache. Không transaction.

### Trả lời câu hỏi
- **Q-28.1 (DEBT-124)**: **tiếp tục hoãn** việc super_admin thao tác xuyên tenant, tức là chọn tenant đích qua path param. Run 28: mọi route `/admin/users/**` và `/admin/audit` chỉ dùng tenant của token, áp cho cả super_admin. Từ run 27, `super_admin` đã là **vai trò cấp nền tảng**: ghi Resource global, gán resource `admin`. Run 28 chốt thêm: `super_admin` **chỉ được cấp hoặc thu bởi một super_admin**, nên chuỗi tin cậy được đóng ở API. Nếu ghim super_admin vào tenant hệ thống thì phải sửa fixture int của run 27 (super_admin đang ở `TENANT_A` ngẫu nhiên). Việc này để tới khi bật multi-tenant thật, ghi thành DEBT-143 (gộp với DEBT-124).
- **Q-28.2 (đổi vai trò)**:
  - `roles` ⊆ `{tenant_admin, super_admin}`, unique, thay nguyên mảng.
  - **Cấm tự đổi vai trò của chính mình** (403). Quy tắc này thay cho việc đếm "admin cuối cùng": actor luôn còn quyền nên tenant luôn còn ít nhất 1 admin; chỉ còn race giáng chéo đồng thời, ghi DEBT-142.
  - Thay đổi có chạm `super_admin` (cấp hoặc thu), hoặc target đang giữ `super_admin`, thì chỉ super_admin được làm.
  - tenant_admin được cấp hoặc thu `tenant_admin` cho người khác cùng tenant.
  - Hiệu lực ngay: guard đọc lại `activeRoles` ở mọi request.
- **Q-28.3 (rotate key Local)**: chuyển sang run 29. Đã kiểm code: `KeyRotationService` và `LocalKeyProvider.rotate` đã có (state `keys.json` ghi theo kiểu tmp+rename, DEBT-007). Verifier gọi `getPublicKeys()` ở mỗi lần verify (không cache), nên emergency có hiệu lực ngay trên một node. Local chỉ dành cho dev, một node; đa node phải chờ KMS (B7.3). **Lỗi thật phát hiện được**: `rotate` là read-modify-write không khoá. Nếu rotate normal chạy song song với emergency, normal có thể ghi lại key cũ (đã bị lộ) vào JWKS ở trạng thái `retiring`, khiến token kẻ tấn công ký bằng key cũ verify lại được. Run 29 bắt buộc thêm mutex trong process (DEBT-145).
- **Q-28.4 (phạm vi)**: Task 1 (vai trò, lock và revoke, quy tắc chéo tenant) cùng Task 2 (families, consents, revoke family theo consent) đã là khối lượng L. Rotate key là thao tác nguy hiểm nhất của control plane và cần review riêng. Vì vậy **tách Task 4 sang run 29**, cùng DEBT-145, DEBT-125 (disable client thì revoke family) và DEBT-132.

## Điểm mạnh
- Phần lớn thứ cần dùng đã có sẵn trong code:
  - Revoke family (`revokeFamily(familyId, clientId)` stamp-first).
  - Global revoke (`revokeAllForUser` + `sessionRevokeAll` ghi tombstone `sess_end`, nên AT mang `sid` chết ngay qua liveness).
  - Lockout B2.4 (`lockedUntil`; login khi đang khoá không tăng đếm).
  - Consent `revokedAt` (`isCovered` từ chối, `grant` xoá lại).
  - Audit có sanitize.
- Guard run 26 đọc vai trò ở mỗi request, nên giáng quyền hoặc khoá admin có hiệu lực ngay, không cần cơ chế thu hồi riêng.
- Nền pagination/mapper/404 đồng nhất của run 27 áp thẳng được.

## Vấn đề (đã fold — dev bắt buộc theo)
- [x] **User là global** (`User` không có `tenantId`; `lockedUntil` và session áp cho mọi tenant). Nếu để tenant_admin khoá hoặc revoke session của một user, tác động sẽ lan sang tenant khác hoặc vào chính super_admin. Fold: tenant_admin chỉ được lock, unlock, revoke sessions trên target **không giữ vai trò admin ở bất kỳ tenant nào** và **không có membership `active` ở tenant khác**; ngược lại trả 403. super_admin không bị giới hạn này.
- [x] **Lock mà không revoke thì vô nghĩa**: refresh 30 ngày và session vẫn sống. Fold: lock = đặt `lockedUntil` sentinel rồi chạy `revokeAllUserCredentials`. Race login đang chạy dở ghi DEBT-141.
- [x] **Không tự thao tác lên chính mình**: tự lock hoặc tự đổi vai trò trả 403.
- [x] **Revoke consent mà không revoke refresh** thì client `offline_access` vẫn dùng tiếp 30 ngày. Fold: revoke consent kéo theo revoke family `{userId, clientId, resource}`. Code đã mint trước đó (≤60 giây) ghi DEBT-144.
- [x] **Families/consents cross-tenant**: RefreshToken và Consent không có `tenantId`. Fold: target phải là member của tenant token (nếu không thì 404), và mọi family/consent lọc theo `clientId ∈` các client của tenant. Các client này được resolve bằng truy vấn `Client.find({tenantId, clientId:{$in: distinct}})`, chỉ trên dữ liệu của user đó.
- [x] **RefreshToken không có `lastUsed`**: thay bằng aggregate theo `familyId` (min/max `issuedAt`, `active`, `familyRevokedAt`).
- [x] **Audit**: chỉ event admin (và 1 event authorize) có `tenantId`. Lọc chặt theo `tenantId`; event OAuth/auth chưa gắn tenant thì ghi DEBT-140. Index hiện có không có tiền tố `tenantId`, nên thêm index ghép. Cursor `(timestamp, eventId)` opaque và được validate.
- [x] **Lọc email**: `User` là global, `$regex` lấy từ input là bề mặt ReDoS/enumeration. Fold: email chỉ khớp chính xác sau normalize.
- [x] **Audit action mới** và đưa vào `ALERT_ACTIONS`: `ADMIN_USER_LOCKED`, `ADMIN_USER_UNLOCKED`, `ADMIN_USER_ROLES_CHANGED`, `OAUTH_CONSENT_REVOKED`. Revoke session/family dùng `SESSION_REVOKED`/`TOKEN_REVOKED` có sẵn với `actorType:'admin'`.

### Security design gate (đã đủ sau fold)
- **Tài sản/actor/boundary**:
  - Tài sản: account (lock), credential (session, family), consent, vai trò admin, audit trail.
  - Actor: tenant_admin, super_admin.
  - Boundary: tenant token ↔ membership target ↔ tenant của client sở hữu family/consent. Target ngoài tenant trả 404 byte-identical.
- **Invariant/transition**:
  - Lock ⇒ `lockedUntil > now`, mọi session có tombstone, mọi family `familyRevokedAt` và `revokedAt` được set.
  - Đổi vai trò ⇒ request admin kế tiếp của target dùng vai trò mới.
  - Consent revoke ⇒ `isCovered=false`, family `{user, client, resource}` bị revoke.
  - Actor không bao giờ tự mất quyền.
- **Abuse**:
  - IDOR (user, family, consent của tenant khác: 404).
  - Leo thang (tenant_admin cấp super_admin, sửa super_admin, lock super_admin hay user đa tenant: 403).
  - Stale credential (AT cũ 401 qua tombstone; refresh `invalid_grant`).
  - Enumeration (email chỉ khớp chính xác, 404 đồng nhất).
  - Race: stamp-first giữ cho rotate song song; các race còn lại ghi DEBT-141/142/144.
- **Failure**:
  - Mongo/Redis lỗi ⇒ 5xx, fail-closed.
  - Lock đã ghi nhưng revoke lỗi ⇒ vẫn chạy đủ 3 bước, giữ lỗi đầu, audit `failure` best-effort, trả 5xx, không gỡ lock. Gọi lại là idempotent.
  - Audit lỗi sau mutation ⇒ 5xx, không rollback.
- **Exposure**:
  - Mapper allowlist, không `passwordHash`/`mfaSecret`/`lockTransitionNonce`/`tokenHash`/`sessionRef`/`deviceId`.
  - Audit response không có `_id`; metadata đã sanitize.
  - Mọi response `no-store` (có sẵn từ guard).

## Đề xuất (không bắt buộc)
- `ui.controller` logout `scope=all` có thể gọi `revokeAllUserCredentials`. Chỉ làm nếu diff nhỏ và test logout giữ xanh, nếu không thì để nguyên.
- Mutation đổi trạng thái chỉ ghi audit khi có thay đổi thật (giống DEBT-132); revoke vẫn chạy mỗi lần (idempotent).
- Debt mới: DEBT-140…146 trong `backlog.md`.
