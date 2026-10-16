# Runbook — Deploy (sso-idp backend)

> File bền (không nằm trong thư mục run). Ghi các bước vận hành bắt buộc khi deploy,
> đặc biệt khi schema/index thay đổi. Mọi bước **fail-closed**: nếu một bước lỗi, **dừng
> deploy** và xử lý thủ công theo đúng mục dưới — KHÔNG tự xoá dữ liệu người dùng.

## 1. Đồng bộ index Mongo (`db:sync-indexes`)

`syncIndexes()` **build** index còn thiếu và **drop** index không còn khai báo trong schema.
Lệnh:

```bash
pnpm --filter be build          # cần dist/ để chạy CLI (CJS)
pnpm --filter be db:sync-indexes
```

CLI đọc `MONGO_URI` từ env (`--env-file-if-exists=.env`), chạy `syncAllIndexes` cho mọi model
trong `be/src/database/mongo/models.ts`, in ra index đã drop theo từng model, rồi thoát.
Lỗi bất kỳ ⇒ exit code 1 (deploy dừng).

**Run 28 (B6.3b) — index audit mới.** `AuditLog` thêm index ghép
`{tenantId: 1, timestamp: -1, eventId: -1}` (`tenantId_1_timestamp_-1_eventId_-1`) cho
`GET /admin/audit`. Không unique ⇒ không cần dọn dữ liệu trước; chỉ cần chạy
`db:sync-indexes` như trên (build index trên collection lớn có thể mất thời gian — chạy trước
rollout). Xác minh: `db.auditlogs.getIndexes()` có đúng key trên.

## 2. Di trú index `Consent` M3→M4 (DEBT-028)

**Bối cảnh.** Q1 đổi khoá consent từ `{userId, clientId}` sang
`{userId, clientId, resource}` (unique). Môi trường đã deploy trước đó mang index cũ
`{userId, clientId}`; schema hiện tại khai `{userId, clientId, resource}` unique
(`be/src/modules/oauth/consent/schemas/consent.schema.ts`). `db:sync-indexes` sẽ:

- **drop** `userId_1_clientId_1` (index cũ, không còn khai báo), và
- **build** `userId_1_clientId_1_resource_1` unique (index mới).

### 2a. Backfill `resource` TRƯỚC khi sync (bắt buộc)

Doc consent cũ **không có field `resource`**. Unique index coi `resource` thiếu là `null`,
khác với sentinel `''` mà service dùng (`ConsentService.normalizeResource` map `undefined → ''`).
Nếu không backfill, lookup `find()`/`isCovered()` theo `resource:''` sẽ KHÔNG thấy doc cũ ⇒
ép re-consent (fail-closed nhưng gây UX xấu). Chạy backfill trước khi sync:

```js
// mongosh <MONGO_URI>
db.consents.updateMany({ resource: { $exists: false } }, { $set: { resource: '' } });
```

### 2b. Kiểm duplicate theo khoá mới TRƯỚC khi build unique index (bắt buộc)

Dữ liệu cũ có thể có >1 doc trùng `{userId, clientId, resource}` (sau backfill) ⇒ build unique
index sẽ **FAIL (E11000)**. `syncAllIndexes` fail-closed: ném lỗi, **không** xoá doc nào.
Kiểm trước:

```js
// mongosh <MONGO_URI> — liệt kê nhóm vi phạm (count > 1) theo khoá mới
db.consents.aggregate([
  { $group: {
      _id: { userId: '$userId', clientId: '$clientId', resource: { $ifNull: ['$resource', ''] } },
      count: { $sum: 1 },
      ids: { $push: '$_id' },
  } },
  { $match: { count: { $gt: 1 } } },
]);
```

- Kết quả rỗng ⇒ an toàn, chạy `db:sync-indexes`.
- Có nhóm `count > 1` ⇒ **DỪNG**. Hợp nhất thủ công (giữ doc có `grantedScopes` hợp nhất /
  `updatedAt` mới nhất, revoke/xoá doc dư) theo chính sách sản phẩm. **KHÔNG** để script tự xoá.
  Sau khi dọn, chạy lại 2b rồi mới sync.

#### Nếu `db:sync-indexes` đã chạy và FAIL E11000 (phục hồi)

`syncIndexes()` (mongoose 9) **drop index cũ TRƯỚC** khi build index mới. Khi build lỗi:

- `consents` **không còn unique index nào** (`userId_1_clientId_1` đã drop, `userId_1_clientId_1_resource_1` chưa có) — kiểm bằng `db.consents.getIndexes()` (chỉ còn `_id_`).
- Các model đứng SAU `Consent` trong `be/src/database/mongo/models.ts` **chưa được sync**.
- Không doc nào bị xoá.

Phục hồi (theo thứ tự, không bỏ bước):
1. **Không rollout** tiến trình ứng dụng mới; nếu bản cũ đang chạy, giữ nhưng coi khoảng này là có thể phát sinh duplicate mới.
2. Chạy lại truy vấn 2b, hợp nhất thủ công các nhóm `count > 1` (như trên).
3. Chạy lại 2b ⇒ phải rỗng (nếu không, lặp bước 2 — app cũ có thể vừa ghi thêm).
4. `pnpm --filter be db:sync-indexes` ⇒ exit 0.
5. Xác minh 2c. Chỉ khi 2c đúng mới sang bước 5–6 của §4.

### 2c. Xác minh sau sync

```js
// mongosh <MONGO_URI>
db.consents.getIndexes();
// Kỳ vọng: _id_ + userId_1_clientId_1_resource_1 (unique: true); KHÔNG còn userId_1_clientId_1.
```

Bằng chứng tự động: `be/test/indexes.int-spec.ts` — mô phỏng DB cũ (tạo index cũ rồi sync),
assert index cũ nằm trong danh sách `dropped.Consent`, index còn lại đúng khoá mới unique, và
sync fail-closed (E11000, không xoá doc) khi dữ liệu cũ vi phạm khoá mới.

## 2d. Index unique `ClientCredential {clientId, version}` (DEBT-021)

Run 20 đổi `{clientId:1, version:1}` thành **unique**. `syncIndexes` sẽ drop index non-unique cùng tên rồi build unique.
Kiểm duplicate TRƯỚC khi sync:

```js
db.clientcredentials.aggregate([
  { $group: { _id: { clientId: '$clientId', version: '$version' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 } } },
]);
```

- Rỗng ⇒ sync. Có nhóm ⇒ DỪNG: với mỗi nhóm, đánh số lại version cho doc tạo sau (`version = max + 1`) hoặc revoke doc dư nếu là secret không ai dùng. KHÔNG xoá credential đang hợp lệ khi chưa xác nhận với chủ client.
- Nếu sync đã FAIL: `clientcredentials` mất index `{clientId, version}` (chỉ ảnh hưởng hiệu năng `verifySecret` + cho phép trùng tạm) ⇒ dọn rồi sync lại như mục phục hồi ở 2b. Lưu ý `ClientCredential` đứng TRƯỚC `Consent` trong `models.ts` ⇒ lỗi ở đây làm `Consent` và các model sau chưa được sync.

(Collection mặc định của model `ClientCredential` là `clientcredentials`; dev xác minh bằng `db.getCollectionNames()`.)

## 3. Redis — `maxmemory-policy noeviction` (DEBT-049)

Session, authorize-context, tombstone, one-time code sống trong Redis với TTL. Nếu Redis evict
key dưới áp lực bộ nhớ, phiên/tombstone/code có thể biến mất sớm ⇒ hành vi bảo mật lệch
(ví dụ tombstone mất ⇒ AT đã logout lại "sống"). Đặt chính sách **không evict** để key chỉ mất
theo TTL, không theo áp lực RAM:

```bash
redis-cli CONFIG GET maxmemory-policy        # kiểm hiện trạng
redis-cli CONFIG SET maxmemory-policy noeviction
# và ghi cố định trong redis.conf: maxmemory-policy noeviction
```

Giám sát `used_memory` vs `maxmemory`; với `noeviction`, Redis sẽ trả lỗi ghi khi đầy — hệ
fail-closed (thao tác ghi phiên/code lỗi rõ ràng) thay vì âm thầm mất dữ liệu bảo mật.

## 4. Thứ tự deploy đề xuất

1. Backfill `resource` (2a).
2. Kiểm duplicate (2b) — rỗng mới tiếp.
2'. Kiểm duplicate ClientCredential (2d) — rỗng mới tiếp.
3. `pnpm --filter be build && pnpm --filter be db:sync-indexes` (1 + 2).
4. Xác minh index (2c).
5. Đặt `maxmemory-policy noeviction` (3) nếu chưa.
6. Rollout tiến trình ứng dụng.

## 5. `TRUST_PROXY` khi chạy sau reverse proxy (DEBT-006)

`req.ip` là cơ sở của rate limit client auth theo IP (§6.3) và audit. Sau reverse proxy, nếu không
cấu hình, mọi client xuất hiện với IP của proxy ⇒ bucket theo IP thành **giới hạn toàn cục** (ai
cũng khoá được `/token`) và khoá `client_id|ip` trở thành khoá theo `client_id` trần ⇒ attacker
khoá được client hợp lệ.

- Đặt `TRUST_PROXY` = **đúng IP/CIDR của reverse proxy** (vd. `10.0.0.0/8`; danh sách phân tách
  bằng dấu phẩy). **Chỉ nhận IP/CIDR.**
- **Không dùng số hop.** Fastify 5 (`getTrustProxyFn`) âm thầm bỏ qua `trustProxy` dạng số
  (fail-closed, không xác thực được peer liền kề) ⇒ `req.ip` rơi về IP socket của proxy, bucket IP
  thành giới hạn toàn cục mà **không có cảnh báo**. Vì vậy app **từ chối khởi động** nếu `TRUST_PROXY`
  là một số — thông báo lỗi hướng dẫn đặt IP/CIDR của proxy.
- Thiếu/rỗng/`false` ⇒ mặc định TẮT (dùng IP socket). Chỉ dùng khi KHÔNG có proxy trước app.
- **TUYỆT ĐỐI không** `TRUST_PROXY=true` — tin mọi `X-Forwarded-For` ⇒ client spoof IP vượt
  bucket. App **từ chối khởi động** nếu gặp `true`, một số, hoặc IP/CIDR sai (`parseTrustProxy`).
