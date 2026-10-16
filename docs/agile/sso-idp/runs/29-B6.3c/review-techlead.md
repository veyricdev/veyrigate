# Tech Lead Review — 2026-10-16

## Kết luận: PASS (có fold bắt buộc trong `tasks.md`, mục "Fold tech-lead")

Không có blocker cần người quyết định. Đối chiếu code `be/` thật, tôi tìm ra 1 lỗ bảo mật cùng gốc với DEBT-145 mà `tasks.md` cũ bỏ sót, cùng vài chỗ lệch kỹ thuật. Tất cả đã fold vào `tasks.md`; nội dung fold ưu tiên hơn text cũ. Phạm vi run giữ nguyên Task 1–4.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ modular monolith và nền admin của run 26–28.

**Thêm mới:**
- `AdminKeysController` và `AdminTenantsController` trong `AdminModule`; `AdminModule` import `KeysModule`.
- `KeyProvider.listKeys()`, gọi qua `KeyRotationService.list()`. Không export `KEY_PROVIDER` ra ngoài module.
- `TenantService.list()`.
- `RevokeFilter` thêm nhánh `{clientId}`, kèm index `RefreshToken {clientId:1}`.
- `UserService.clearFailedLoginsIfUnlocked()`.

**Không thêm:** thư viện, cache, transaction.

**`LocalKeyProvider` vẫn chỉ dùng cho dev/1 node.** Mutex chỉ có hiệu lực trong một process. Đa node phải chờ KMS (B7.3, DEBT-159).

### Trả lời câu hỏi

**Q-29.1: chỉ `super_admin`, cho cả `GET /admin/keys` lẫn rotate.**
- Key là đối tượng cấp nền tảng; tenant_admin không có thao tác nào cần tới (least privilege).
- Resource global khác ở chỗ tenant_admin cần đọc nó để cấu hình `allowedResources`.
- Phần công khai của key (kid, n, e) đã có ở `/jwks.json`, nên chặn tenant_admin không làm mất chức năng nào.

**Q-29.2: emergency KHÔNG revoke session hay refresh.**
- Refresh token là giá trị ngẫu nhiên lưu dạng sha256. Session là id opaque trong Redis. Không cái nào được ký bằng signing key.
- Lộ private key chỉ cho phép giả AT và ID token. `TokenVerifier` gọi `getPublicKeys()` ở mỗi lần verify (`createLocalJWKSet`, không cache), nên gỡ key khỏi JWKS là chặn ngay trên node.
- Client hợp lệ chỉ cần refresh để lấy AT ký bằng kid mới.
- Revoke hàng loạt thuộc runbook "lộ DB/credential", là sự cố khác, không gộp vào đây.
- Giới hạn còn lại: RP bên ngoài cache JWKS (`/jwks.json` không có `Cache-Control`) có thể còn chấp nhận key cũ trong thời gian cache. Ghi DEBT-157.

**Q-29.3: luôn revoke khi disable, không có option riêng.**
- Option "disable không revoke" là một footgun: enable lại sẽ hồi sinh refresh 30 ngày.
- Revoke chạy ở MỌI `PATCH {disabled:true}` (idempotent) để có đường retry khi revoke lỗi.
- Kết hợp DEBT-132 (giữ `disabledAt` gốc), gọi lại lần 2 vừa an toàn vừa không mất mốc thời gian.

## Điểm mạnh
- Phần lớn nền đã có sẵn:
  - `KeyRotationService` + `LocalKeyProvider.rotate`, với state ghi atomic tmp+rename (DEBT-007), và emergency xoá mọi PEM.
  - `SIGNING_KEY_ROTATED` đã nằm trong `ALERT_ACTIONS`.
  - Verifier không cache, nên emergency có hiệu lực tức thì ở `/userinfo`, admin guard và `/demo/me`.
  - `revokeWhere` stamp-first là cửa revoke duy nhất.
  - `findByClientId` lọc `disabledAt:null`, nên client disabled bị chặn ở mọi grant.
  - Có `ADMIN_LOCKED_UNTIL` và hằng `GENERIC_LOGIN_ERROR`.
- Seam `protected atomicRename` có sẵn cho phép viết test race tất định.
- Tasks chia đúng lane [BE], phụ thuộc rõ (1 → 2), acceptance có mutation test.

## Vấn đề (đã fold — dev bắt buộc theo)

- [x] **`getPublicKeys()` ghi state ngoài mutex (lỗ cùng gốc DEBT-145, mức 🔴).**
  - Hàm này prune key retiring hết hạn rồi `writeState(live)` ở mỗi lần verify.
  - Kịch bản: nó đọc `[A active, R expired]` → rotate ghi state mới → nó ghi đè `[A active]`.
  - Hậu quả: key mới mất, A (PEM đã xoá, có thể đã lộ) quay lại làm `active`. Kết quả là `getSigningKey` ENOENT (DoS) và token ký bằng A verify lại được.
  - Chỉ mutex quanh `rotate` thì không đủ. Fold: `getPublicKeys`/`listKeys` chỉ đọc; prune chuyển vào `rotate` trong mutex; có test spy kèm mutation.
- [x] **`getSigningKey` ENOENT khi rotate normal xoá PEM cũ đúng lúc đang ký** (`/token` trả 500 tức thời). Fold: đọc lại state 1 lần.
- [x] **Test race phải tất định.** Fold: dùng cổng trên `atomicRename` thay vì `Promise.all` dựa vào timing. Có thêm case "rotate lỗi không làm kẹt chain".
- [x] **Audit rotate thiếu ngữ cảnh admin.** `rotate(mode, actorId)` chưa có `tenantId`/`ip`/`requestId`. Fold: nhận `adminAuditBase`. `SIGNING_KEY_CREATED` không phát ở run này (DEBT-160).
- [x] **`revokeWhere({clientId})` không có index.** Index hiện có `{userId, clientId}` không bắt đầu bằng `clientId`, nên sẽ quét toàn collection. Fold: thêm `{clientId:1}`, cập nhật `indexes.int-spec`, dev/E2E chạy `db:sync-indexes` (báo người dùng, không drop dữ liệu).
- [x] **`buildRevokeScope` phải nhận diện nhánh `{clientId}` bằng việc không có `userId`**, và fail closed khi `clientId` rỗng. Nếu không, nó dễ nhầm với nhánh `{userId, clientId, resource}`.
- [x] **DEBT-132: hai cách "gọn" đều sai.**
  - `$min` sai vì schema mặc định `disabledAt:null` và BSON coi `null < Date`, nên disable không có tác dụng (fail-open).
  - Pipeline update có rủi ro giá trị bắt đầu bằng `$` bị hiểu là expression.
  - Fold: một `updateOne` có điều kiện `disabledAt:null` chạy sau update chính.
- [x] **DEBT-154: filter chỉ so sentinel vẫn để lọt brute-force lock đặt xen giữa.** Fold: filter `lockedUntil: {$not: {$gt: now}}` phủ cả hai loại lock, với invariant "không tạo session khi `lockedUntil > now` tại thời điểm ghi". Seam test: spy `findByEmailForAuthentication` trả snapshot cũ sau khi đã đặt lock trong DB.
- [x] **Emergency trong int test**: sau rotate, AT của chính super_admin cũng thành 401, nên test phải mint lại AT. Fold ghi rõ điều này, kèm case "refresh cũ vẫn 200" để chứng minh Q-29.2.

### Security design gate (đã đủ sau fold)

**Tài sản / actor / boundary**
- Tài sản: private signing key; tính toàn vẹn của JWKS (kid nào được verify); refresh family của client bị disable; trạng thái lock của account; danh sách tenant.
- Actor:
  - super_admin: keys read/rotate, tenants all.
  - tenant_admin: tenants của chính mình; disable client trong tenant mình.
  - Người dùng cuối: login.
- Boundary: tenant của token ↔ client (`getForTenant`) ↔ family theo `clientId` (duy nhất toàn cục). Keys là global, chỉ super_admin chạm được.

**Invariant / transition**
- Sau normal: JWKS = mọi key active và retiring chưa hết hạn, trong đó có key mới ký; key cũ retiring trong `ACCESS_TOKEN_TTL`.
- Sau emergency: JWKS = {key mới}; không còn PEM nào của key cũ.
- Mọi chuỗi rotate (song song hay không) đều cho cùng kết quả như khi chạy tuần tự.
- `getPublicKeys` không bao giờ ghi.
- Disable ⇒ `disabledAt` = mốc lần đầu, mọi family của client có `familyRevokedAt`. Enable không hồi sinh family nào.
- Login chỉ tạo session nếu tại thời điểm ghi reset `lockedUntil` không lớn hơn now.

**Abuse cases**
- Leo thang: tenant_admin đọc hoặc rotate key ⇒ 403; tenant_admin xem tenant khác ⇒ không thấy.
- IDOR: disable client của tenant khác ⇒ 404, family không bị đụng.
- Replay / stale step-up: `auth_time` cũ ⇒ 403 `step_up_required`.
- Stale credential: AT ký bằng key đã gỡ ⇒ 401 ở 3 resource; refresh cũ sau disable→enable ⇒ `invalid_grant`.
- Race:
  - Rotate song song, và rotate song song với prune ⇒ đóng bằng mutex + read-only.
  - Refresh rotate song song với disable ⇒ đóng bằng stamp-first.
  - Login song song với admin lock ⇒ đóng bằng atomic filter.
  - Còn lại: DEBT-141 (lock sau reset), DEBT-156 (code exchange đã qua client auth trước disable).
- Enumeration: login bị khoá xen giữa trả byte-identical với sai mật khẩu; cursor tenants bị validate.

**Failure semantics**
- Ghi `keys.json` lỗi ⇒ key cũ vẫn active, audit failure best-effort, 5xx.
- Audit lỗi sau rotate ⇒ 5xx, không rollback.
- `rm` PEM lỗi ⇒ ERROR log (emergency), rotate vẫn thành công.
- Revoke lỗi khi disable ⇒ client vẫn disabled (fail-closed), 5xx, retry idempotent.
- Mongo lỗi ở login ⇒ 5xx, không tạo session.

**Exposure**
- Keys response chỉ gồm `{kid, alg, status, createdAt, retireAt}`; không `n/e/d/p/q/dp/dq/qi`, PEM, đường dẫn.
- Tenants response chỉ gồm `{id, name}`.
- Log chỉ ghi kid.
- Audit metadata phẳng `{mode, oldKid}` / `{reason, count}`.
- Mọi response admin `no-store`.

## Đề xuất (không bắt buộc)
- Với DEBT-156: sau khi insert family ở code grant, kiểm lại `findByClientId`, giống cách đã kiểm lại session (DEBT-051). Diff nhỏ, nhưng để B7.1 làm.
- Đặt `Cache-Control: public, max-age=300` (ngắn) cho `/jwks.json` để giới hạn thời gian RP cache key cũ sau emergency (DEBT-157).
- Debt mới: DEBT-156…160 trong `backlog.md`.
