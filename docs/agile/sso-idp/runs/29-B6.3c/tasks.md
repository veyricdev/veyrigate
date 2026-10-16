# Tasks — run 29 — B6.3c: keys + tenants + DEBT-145/125/132/154 (M5)

> Plan §B6 dòng 212 (B6.3 phần cuối), B1.9 (KeyProvider/JWKS, rotate thường/khẩn cấp), spec §9.11 (rotate key ⇒ step-up + audit), §10 (`SIGNING_KEY_CREATED/ROTATED` alert). Ghi chú gốc: `runs/28-B6.3b/tasks.md` mục "Task 4 — CHUYỂN run 29" + `review-techlead.md` run 28 Q-28.3. Debt: DEBT-145 (🔴 bắt buộc), DEBT-125, DEBT-132, DEBT-154 (backlog). Tái dùng nền tảng admin run 26–28.
>
> Thứ tự: Task 1 → 2 (backend-dev); Task 3, 4 độc lập. Mọi mutation: `admin.write` + step-up + audit. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop dữ liệu `aegate-*`.

### [x] Task 1 [BE]: DEBT-145 — serialise `LocalKeyProvider.rotate`
- Promise-chain mutex trong process cho mọi rotate (normal/emergency). `LocalKeyProvider` chỉ dev/1 node (đa node chờ KMS B7.3 — ghi rõ trong code/README).
- **Acceptance**: test normal ∥ emergency ⇒ kid cũ KHÔNG còn trong JWKS; 2 normal song song ⇒ không mất key mới đã ký; mutation bỏ mutex ⇒ RED.

### [x] Task 2 [BE]: Keys + tenants admin API
- `KeyProvider.listKeys()` metadata (kid, alg, status, createdAt, retireAt) — không private key.
- `GET /admin/keys` (super_admin? hoặc mọi admin đọc — tech-lead chốt), `POST /admin/keys/rotate` body `{mode:'normal'|'emergency'}` — chỉ `super_admin`, step-up, audit `SIGNING_KEY_CREATED/ROTATED` (`metadata.mode`).
- `GET /admin/tenants`: tenant_admin chỉ thấy tenant mình; super_admin thấy tất cả (read-only).
- **Acceptance**: int: rotate normal ⇒ token cũ vẫn verify, token mới ký `kid` mới; emergency ⇒ token cũ 401 ở `/userinfo`, `/admin/me`, `/demo/me`; tenant_admin rotate ⇒ 403; response không chứa key material (assert tập key); JWKS endpoint phản ánh đúng.

### [x] Task 3 [BE]: DEBT-125 + DEBT-132 — disable client
- DEBT-125: disable client ⇒ revoke mọi refresh family của client (stamp-first, `revokeWhere({clientId})`), enable lại không hồi sinh refresh cũ.
- DEBT-132: disable lại client đã disable không ghi đè `disabledAt` gốc; audit chỉ khi trạng thái đổi.
- **Acceptance**: int: disable → enable ⇒ refresh cũ `invalid_grant`; `disabledAt` giữ mốc đầu; mutation ⇒ RED.

### [x] Task 4 [BE]: DEBT-154 — login không xoá admin lock
- `resetFailedLogins` ở đường login chỉ reset khi `lockedUntil` ≠ `ADMIN_LOCKED_UNTIL` (atomic filter); không khớp ⇒ từ chối login bằng thông điệp chung, không tạo session.
- **Acceptance**: int (inject hook giữa verify và reset) mô phỏng admin lock xen giữa ⇒ login thất bại chung, lock còn nguyên, không session; login thường không hồi quy; mutation ⇒ RED.

## Câu hỏi cho tech-lead
- Q-29.1: `GET /admin/keys` cho mọi admin hay chỉ super_admin.
- Q-29.2: Emergency rotate có cần revoke session/refresh hiện hành không (token đã ký bằng key lộ).
- Q-29.3: DEBT-125 — luôn revoke khi disable hay option riêng.

---

## Fold tech-lead — 2026-10-16 (ưu tiên hơn text phía trên)

Trả lời câu hỏi (lý do chi tiết trong `review-techlead.md`):
- **Q-29.1**: chỉ `super_admin`, cho cả đọc lẫn rotate.
- **Q-29.2**: emergency KHÔNG revoke session hay refresh.
- **Q-29.3**: luôn revoke khi disable, không có option riêng.

Thứ tự giữ nguyên: Task 1 → 2; Task 3 và 4 độc lập.

### Task 1 (DEBT-145) — fold

**Lỗ thứ hai cùng gốc (bắt buộc).** `getPublicKeys()` cũng là read-modify-write: nó prune các key retiring đã hết hạn rồi `writeState(live)`. Hàm này chạy ở MỌI lần verify (`TokenVerifier`, `/jwks.json`).
- Kịch bản: nó đọc `[A active, R expired]` → một rotate (normal hoặc emergency) ghi state mới → nó ghi đè `[A active]`.
- Hậu quả: key mới biến mất. A (PEM đã xoá, có thể đã lộ) quay lại làm `active`, nên `getSigningKey` gặp ENOENT (DoS) và token ký bằng A lại verify được.
- Fix:
  - `getPublicKeys()` và `listKeys()` **chỉ đọc**: lọc trong bộ nhớ, không ghi file.
  - Việc prune retiring hết hạn chuyển vào `rotate`, chạy trong mutex.
  - Sau fix chỉ còn `init` và `rotate` gọi `writeState`.

**Mutex.**
- Promise chain trên instance: `this.chain = run.catch(() => undefined)`. Một rotate lỗi không được chặn các rotate sau.
- Không thêm thư viện.
- `KEY_PROVIDER` là singleton DI, nên mỗi process có đúng 1 instance.

**`getSigningKey`.** Nếu `readFile(pem)` trả ENOENT (rotate normal vừa xoá PEM cũ sau khi ghi state) thì đọc lại state **1 lần** rồi thử lại. Lần hai vẫn lỗi thì ném lỗi như cũ.

**Ghi chú dev-only / 1 node.** Ghi vào docblock `LocalKeyProvider` và `be/README.md`: mutex chỉ có hiệu lực trong một process. Hai process dùng chung `KEY_LOCAL_DIR` vẫn race (DEBT-159, chờ KMS ở B7.3).

**Acceptance** (unit `keys.spec`, tất định, không dựa vào timing): dùng seam `protected atomicRename` có sẵn, viết subclass có cổng chặn lần rename đầu tiên.
- Normal bị chặn ở rename, emergency gọi song song, rồi nhả cổng. Kỳ vọng: `getPublicKeys()` chỉ còn kid của emergency, kid cũ A không còn, PEM của A không còn.
- Hai normal song song (lần 1 bị chặn). Kỳ vọng: state = `A retiring, F1 retiring, F2 active`, và token ký bằng F1 vẫn verify.
- Rotate đầu ném lỗi. Kỳ vọng: rotate sau vẫn chạy (chain không kẹt).
- State có một retiring đã hết hạn. Kỳ vọng: `getPublicKeys()` không trả key đó và không ghi file (spy `atomicRename`: không được gọi ngoài rotate).
- Mutation:
  - Gỡ mutex ⇒ 2 test song song RED.
  - Khôi phục việc ghi trong `getPublicKeys` ⇒ test spy RED.

### Task 2 (keys + tenants) — fold

**Đặt module.**
- `AdminKeysController` (`/admin/keys`) và `AdminTenantsController` (`/admin/tenants`) nằm trong `AdminModule`; `AdminModule` import `KeysModule`.
- Thêm `KeyProvider.listKeys(): Promise<KeyMetadata[]>`, với `KeyMetadata = {kid, alg, status, createdAt, retireAt|null}`. Hàm chỉ đọc, dùng cùng bộ lọc với `getPublicKeys`.
- `KeyRotationService.list()` uỷ quyền cho `listKeys()`. KHÔNG export `KEY_PROVIDER` ra ngoài `KeysModule`.

**Quyền (Q-29.1).**
- Cả GET lẫn POST chỉ cho `super_admin`, dùng lại `assertSuperAdmin` của `admin-resources.controller`. Người khác nhận 403 `forbidden`.
- `GET /admin/keys`: `admin.read`.
- `POST /admin/keys/rotate`: `admin.write` + `@RequireRecentAuth(5)`.
- Lý do: key là đối tượng cấp nền tảng, tenant_admin không có thao tác nào cần đến nó. Resource global thì khác, vì tenant_admin cần nó để cấu hình client.

**Rotate.**
- DTO `{mode}` với `@IsIn(['normal','emergency'])`, bắt buộc, `whitelist+forbidNonWhitelisted`. Query `?emergency=` bị bỏ qua.
- Đổi chữ ký thành `KeyRotationService.rotate(mode, audit)`, với `audit` lấy từ `adminAuditBase` thay cho `actorId` trần, để audit có đủ `tenantId`, `ip`, `requestId`, `actorType:'admin'`.
- Audit `SIGNING_KEY_ROTATED` (đã có trong `ALERT_ACTIONS`): `targetType:'signing_key'`, `targetId:newKid`, metadata `{mode, oldKid}`.
- KHÔNG phát `SIGNING_KEY_CREATED` trong run này. Rotate là một thao tác duy nhất; key đầu tiên do `init` sinh lúc boot (DEBT-160).
- Response: `200 {newKid, oldKid, mode}`.

**Failure semantics của rotate.**
- Ghi state lỗi: rotate reject, key cũ vẫn active (DEBT-007). Audit `failure` best-effort với `reason:'rotate_failed'`, trả 5xx.
- Rotate xong nhưng audit lỗi: trả 5xx, KHÔNG rollback (rotation đã có hiệu lực), log ERROR chỉ ghi `newKid`.
- Rotate không idempotent: gọi lại là rotate thêm một lần (DEBT-158).

**`GET /admin/keys`.**
- Trả `{items:[{kid, alg, status, createdAt, retireAt}], nextCursor:null}`, không phân trang (số key luôn nhỏ).
- Test assert **đúng tập key** của mỗi item. Response KHÔNG có `n`, `e`, `d`, `p`, `q`, `dp`, `dq`, `qi`, PEM, đường dẫn file.

**`GET /admin/tenants`.**
- `admin.read`. Mapper allowlist chỉ `{id, name}`, không `_id`/`__v`.
- tenant_admin: chỉ `{id: ctx.tenantId}`; tenant không có document thì `items:[]`.
- super_admin: mọi tenant, `paginate` theo `id` tăng dần.
  - `after` là id: ≤128 ký tự, khớp `^[A-Za-z0-9._-]+$`; sai thì 400.
  - `limit` 1..100.
- Thêm `TenantService.list(after, limit)`, dùng index `{id:1}` có sẵn.
- Không làm `GET /admin/tenants/:id` (YAGNI).

**Q-29.2 — emergency.** Chỉ thay key và gỡ key cũ khỏi JWKS, không revoke gì thêm.
- Refresh token là giá trị ngẫu nhiên lưu dạng sha256; session là id opaque trong Redis. Không cái nào được ký bằng signing key.
- Lộ key chỉ cho phép giả AT và ID token. Gỡ khỏi JWKS chặn chúng ngay, vì verifier đọc JWKS ở mỗi lần verify, không cache.
- Client hợp lệ refresh để nhận AT ký bằng kid mới.

**Acceptance** (int: `admin-keys.int-spec` hoặc thêm vào `admin-api`; `KEY_LOCAL_DIR` = `mkdtemp` riêng).
- **Normal**:
  - AT cũ vẫn 200 ở `/userinfo`, `/admin/me`, `/demo/me`.
  - AT mới có header `kid` = `newKid`.
  - `/jwks.json` có cả 2 kid.
  - `GET /admin/keys` cho `oldKid` ở trạng thái `retiring`, `retireAt` ≈ now + `ACCESS_TOKEN_TTL`.
- **Emergency**:
  - AT cũ ⇒ 401 ở cả 3 endpoint trên.
  - `/jwks.json` chỉ còn `newKid`.
  - Refresh bằng refresh token cũ ⇒ 200, AT mới ký bằng `newKid` (chứng minh không revoke).
  - AT của chính super_admin cũng thành 401, nên test phải mint AT mới trước khi gọi tiếp.
- **Quyền**:
  - tenant_admin GET/POST ⇒ 403, state không đổi (so `/jwks.json` trước và sau).
  - `auth_time` cũ ⇒ 403 `step_up_required`.
  - `mode` sai, thiếu, hoặc có field lạ ⇒ 400.
- **Exposure**:
  - Response rotate và list khớp đúng tập key.
  - Audit `SIGNING_KEY_ROTATED` có `metadata.mode`, `tenantId`, `actorType:'admin'`.
- **Tenants**:
  - Seed tenant B. tenant_admin A chỉ thấy A; super_admin thấy cả A và B.
  - Cursor sai ⇒ 400.

### Task 3 (DEBT-125 + DEBT-132) — fold

**Revoke khi disable (Q-29.3).**
- Mọi `PATCH {disabled:true}` đều gọi `RefreshTokenService.revokeForClient(clientId, now)`, kể cả khi client đã disable sẵn, để có đường retry.
- `revokeForClient` là biến thể `RevokeFilter` `{clientId}` đi qua `revokeWhere`: stamp-first (INV-11), vẫn là cửa revoke duy nhất (DEBT-034).
- `buildRevokeScope` nhận ra nhánh này khi **không có `userId`** và `clientId` không rỗng; trường hợp khác thì ném lỗi (fail closed).
- Không rò chéo tenant: `clientId` là duy nhất toàn cục (unique index), và bước update đã kiểm tenant của client.

**Index.**
- Thêm `RefreshTokenSchema.index({clientId:1})`. Index hiện có `{userId, clientId}` không bắt đầu bằng `clientId`, nên `updateMany` theo `clientId` sẽ quét toàn collection.
- Cập nhật `indexes.int-spec`.
- Dev/E2E cần chạy `db:sync-indexes` (chỉ thêm index): báo người dùng chạy, KHÔNG FLUSH/drop.

**Thứ tự: update (đặt `disabledAt`) → revoke → audit.**
- Revoke lỗi: client vẫn disabled. Đây là fail-closed, vì `findByClientId` đã chặn mọi grant của client disabled. Audit `ADMIN_CLIENT_UPDATED failure reason:'revoke_failed'` best-effort, trả 5xx. Gọi lại PATCH là idempotent.
- Audit `TOKEN_REVOKED` (`actorType:'admin'`, `clientId`, metadata `{reason:'client_disabled', count}`) chỉ ghi khi `count>0`.

**DEBT-132 — giữ mốc `disabledAt` gốc.**
- KHÔNG dùng `$min`: schema mặc định `disabledAt: null`, và BSON coi `null < Date`, nên disable sẽ âm thầm không có tác dụng (fail-open).
- KHÔNG dùng pipeline update: giá trị người dùng bắt đầu bằng `$` sẽ bị hiểu là expression.
- Cách chốt:
  - Với `disabled:true`, KHÔNG đưa `disabledAt` vào `$set` của update chính.
  - Sau `findOneAndUpdate` chính, nếu `before.disabledAt == null` thì chạy thêm `updateOne({tenantId, clientId, disabledAt:null, <cùng filter admin-capable>}, {$set:{disabledAt: now}})`.
  - `after.disabledAt = before.disabledAt ?? now`.
  - `disabled:false` giữ nguyên `$set disabledAt:null`.
- `metadata.disabled` chỉ xuất hiện khi trạng thái đổi (như hiện nay). `ADMIN_CLIENT_UPDATED` vẫn ghi cho mọi PATCH hợp lệ (hành vi run 27).

**Acceptance (int).**
- Disable rồi enable: refresh cũ ⇒ `invalid_grant`, cả family có `familyRevokedAt`. Refresh của client khác cùng user vẫn sống.
- Disable 2 lần:
  - `disabledAt` (đọc từ DB) giữ mốc lần đầu.
  - Lần 2 vẫn chạy revoke. Kiểm bằng cách insert trực tiếp một refresh "lọt" sau lần 1, lần 2 phải revoke nó.
- tenant_admin disable client của tenant khác ⇒ 404, refresh của client đó vẫn sống.
- Mutation:
  - Bỏ revoke ⇒ RED.
  - Khôi phục `$set disabledAt: new Date()` ⇒ RED.

### Task 4 (DEBT-154) — fold

**Hàm mới cho đường login:** `UserService.clearFailedLoginsIfUnlocked(sub, now)`, gồm một lệnh `findOneAndUpdate({_id: sub, lockedUntil: {$not: {$gt: now}}}, {$set:{failedLoginCount:0}, $unset:{lockedUntil:1}})`.
- Filter khớp khi `lockedUntil` thiếu, null hoặc ≤ now.
- Filter này phủ cả admin lock (sentinel) lẫn brute-force lock đặt xen giữa. Invariant: không bao giờ tạo session khi `lockedUntil > now` tại thời điểm ghi. Cách này đơn giản hơn so sánh với sentinel, và đúng B2.4.

**Khi kết quả `null`** (không khớp, hoặc user đã bị xoá):
- Ghi audit `AUTH_LOGIN_FAILED reason:'invalid_credentials'`, giống nhánh locked.
- KHÔNG tăng bộ đếm, KHÔNG `establish`.
- Ném `UnauthorizedException(GENERIC_LOGIN_ERROR)`: thông điệp và status giống hệt (byte-identical) trường hợp sai mật khẩu.

**Ngoài phạm vi.**
- Admin unlock giữ nguyên `resetFailedLogins`.
- DEBT-141 (lock đặt SAU bước reset nhưng TRƯỚC `establish`) vẫn mở; không mở rộng phạm vi run này.

**Acceptance** (int, trong `authentication` hoặc `admin-users`).
- Seam: spy `UserService.findByEmailForAuthentication` sao cho nó gọi bản gốc (lấy snapshot chưa khoá), **đặt admin lock trong DB** (`lockedUntil = ADMIN_LOCKED_UNTIL`), rồi trả snapshot cũ.
- Kỳ vọng khi login đúng mật khẩu:
  - Trả 401 với thông điệp chung.
  - DB vẫn giữ sentinel.
  - Redis không có session nào của user, response không có cookie session.
- Lặp lại với brute-force lock (`now+15'`) ⇒ cùng kết quả.
- Login thường vẫn reset bộ đếm.
- Mutation: quay lại `resetFailedLogins` ⇒ RED.

### Chung
- Mọi response admin mới đều `no-store` (guard đã có sẵn).
- Lỗi đi qua `AdminAuthErrorFilter`.
- Cập nhật OpenAPI (`admin.openapi`).
- Debt mới: DEBT-156…160 (`backlog.md`).
