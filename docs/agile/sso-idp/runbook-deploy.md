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

### 2c. Xác minh sau sync

```js
// mongosh <MONGO_URI>
db.consents.getIndexes();
// Kỳ vọng: _id_ + userId_1_clientId_1_resource_1 (unique: true); KHÔNG còn userId_1_clientId_1.
```

Bằng chứng tự động: `be/test/indexes.int-spec.ts` — mô phỏng DB cũ (tạo index cũ rồi sync),
assert index cũ nằm trong danh sách `dropped.Consent`, index còn lại đúng khoá mới unique, và
sync fail-closed (E11000, không xoá doc) khi dữ liệu cũ vi phạm khoá mới.

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
3. `pnpm --filter be build && pnpm --filter be db:sync-indexes` (1 + 2).
4. Xác minh index (2c).
5. Đặt `maxmemory-policy noeviction` (3) nếu chưa.
6. Rollout tiến trình ứng dụng.
