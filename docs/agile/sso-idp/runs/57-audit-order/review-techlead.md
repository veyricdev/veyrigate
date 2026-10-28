# Tech Lead Review — 2026-10-26 (run 57 — thứ tự audit lock/unlock, DEBT-420 + DEBT-422)

## Kết luận: PASS

Hướng do người dùng chọn (mốc đơn điệu theo user ghi trong cùng câu update, audit dùng mốc đó, tie-break đơn điệu cho list) giải đúng gốc lỗi và khả thi với code hiện tại (HEAD `9cf2766`). Review này giữ nguyên hướng, chỉ chốt chi tiết. Phần thiết kế bắt buộc đã fold vào cuối `tasks.md`, mục "Fold tech-lead (2026-10-26)". Khi mâu thuẫn với text ở trên thì mục fold được ưu tiên.

## Kiến trúc đề xuất (chốt chi tiết, không đổi hướng)

Giữ modular monolith. Không thêm collection, không thêm transaction, không thêm counter.

### 1. Mốc trên user: `adminLockMarkAt` (BSON Date, đơn vị ms)

- Thêm field vào `user.schema.ts` và `UserDoc`. Không đưa vào `UserView`/`AdminUserView`/OpenAPI.
- Mọi câu ghi `adminLock`/`adminUnlock` đặt `adminLockMarkAt = max(now, prev + 1ms)`, viết bằng pipeline update (`updatePipeline: true`, cùng cách `recordFailedLogin`/`setPassword` đang làm). Trong đó `prev = $ifNull('$adminLockMarkAt', Date(0))`, biểu thức Mongo là `{$max: [now, {$add: [prev, 1]}]}`.
- **`now` là Date do Node chụp ngay trước câu ghi (literal), không dùng `$$NOW`.** Lý do:
  1. Tính đơn điệu theo user đến từ vế `prev + 1`, Mongo áp dụng tuần tự trên cùng document. Vì vậy thứ tự đúng bất kể đồng hồ của instance nào, kể cả khi nhiều instance lệch NTP. `$$NOW` không làm thứ tự đúng hơn.
  2. Unlock cần pre-image (`returnDocument:'before'`) để quyết định có audit hay không (DEBT-147). Với `$$NOW` thì Node không biết mốc đã ghi. Với literal `now`, mốc tính lại được và đúng tuyệt đối: `mark = max(now, before.adminLockMarkAt + 1)`. `findOneAndUpdate` nguyên tử nên pre-image chính là input của pipeline.
  3. Các event audit khác vẫn dùng đồng hồ Node. Dùng cùng nguồn giờ thì `from/to` và thứ tự giữa các loại event nhất quán hơn.
  4. Cho phép inject `now` trong test (giống `recordFailedLogin(sub, now)`), nhờ đó test được "trùng ms" một cách tất định.
- Một helper thuần dùng chung, ví dụ `nextAdminLockMark(prev: Date | undefined, now: Date): Date`. Biểu thức pipeline dựng từ cùng hằng số. Unit test khẳng định giá trị DB bằng giá trị helper tính.
- **Phạm vi**: chỉ admin lock/unlock bump mốc. `recordFailedLogin` (brute-force), `clearFailedLoginsIfUnlocked`, `setPassword` không đụng tới mốc; xem DEBT-424.

### 2. `adminLock`: một pipeline nguyên tử, bỏ vòng lặp 2 lượt

Trước đây, khi tenant_admin khoá lại một user đang bị super_admin khoá, code KHÔNG ghi gì (miss filter → đọc lại → trả `current`), nhưng vẫn audit `LOCKED success`. Nếu path no-op này không bump mốc thì nó vẫn đua với unlock (đúng lỗi DEBT-420). Vì vậy:

- Filter `{_id}`. Một stage `$set`:
  - `lockedUntil: ADMIN_LOCKED_UNTIL`.
  - `adminLockLevel`: nếu `level === 'super_admin'` thì đặt `'super_admin'`. Ngược lại dùng `$cond`: nếu document đang có sentinel VÀ level hiện tại khác `'tenant_admin'` (gồm cả sentinel cũ không có level) thì giữ nguyên (`$ifNull: ['$adminLockLevel', '$$REMOVE']`), còn lại đặt `'tenant_admin'`.
  - `adminLockMarkAt`: theo công thức ở mục 1.
- `returnDocument:'after'`. Trả `{ user: UserView, lockMarkAt: Date }`. null nghĩa là không có user.
- Bỏ `tenantAdminMayChangeLock` khỏi lock (unlock vẫn dùng), bỏ đọc lại `findById` và bỏ `throw 'changed concurrently'`. Kết quả là ít code hơn và nguyên tử thật.

### 3. `adminUnlock`

- Giữ filter mức như hiện tại. Đổi update sang pipeline gồm `$set {failedLoginCount: 0, adminLockMarkAt: <công thức>}` và `$unset ['lockedUntil','adminLockLevel']`. Giữ `returnDocument:'before'`; projection phải có `adminLockMarkAt`.
- Trả `{ before: UserView, unlockMarkAt: nextAdminLockMark(before.adminLockMarkAt, now) }`, hoặc `'forbidden'`, hoặc `null`. Path `'forbidden'` không ghi DB nên không có mốc.
- Unlock không có tác dụng (h) vẫn bump mốc nhưng không audit. Chấp nhận: không lộ thông tin, không đổi trail.

### 4. `AuditService.record(input, opts?: { timestamp?: Date })`

- Tham số thứ 2 tách riêng. **Không** thêm `timestamp` vào `AuditEventInput`, để không object nào spread từ request/DTO có thể đặt giờ audit.
- `opts.timestamp` phải là `Date` hợp lệ. `isNaN(getTime())` thì throw (fail-closed) và không ghi.
- `eventId` giữ nguyên `randomUUID()` (id công khai trong API, không đổi định dạng).

### 5. Controller

- `lock`: `LOCKED success` có `timestamp = lockMarkAt`. Hai event đi sau của cùng request (`LOCKED failure revoke_failed`, `SESSION_REVOKED via:'lock'`) dùng `timestamp = max(new Date(), lockMarkAt + 1ms)`. Lý do: mốc có thể vượt đồng hồ Node khi có hơn 1 thao tác/ms trên một user, hoặc khi instance trước chạy nhanh hơn. Khi đó event đi sau không được sort trước `LOCKED success`, và DEBT-152 phải luôn ra success, failure, success.
- `unlock`: `UNLOCKED success` có `timestamp = unlockMarkAt`. `UNLOCKED failure locked_by_super_admin` vẫn dùng giờ Node (không có câu ghi).
- Sửa comment `admin-users.controller.ts:165-170` (senior run 56 đã nêu): thứ tự trail giờ đến từ mốc trong câu ghi, không còn từ việc "audit trước revoke". Vẫn giữ audit trước revoke để fail-closed (i).

### 6. Sort + cursor admin audit (DEBT-422): tie-break bằng `_id`

- Sort `{timestamp:-1, _id:-1}`. Cursor `$or: [{timestamp < t}, {timestamp: t, _id < i}]`.
- Vì sao chọn `_id` ObjectId: mọi document cũ đều có `_id` nên không cần migrate; không thêm ghi phụ; mongoose sinh `_id` phía client lúc `create` theo thứ tự gọi `record`. Đánh giá:
  - **Trong 1 process**: ObjectId = giây (4 byte) + random theo process (5 byte) + counter (3 byte, tăng dần). Event tạo sau có `_id` lớn hơn, trừ khi counter tràn (hơn 16M lần/giây, bỏ qua). Như vậy hai event cùng ms trong cùng instance ra đúng thứ tự gọi `record`.
  - **Xuyên process**: phần random theo process làm thứ tự cùng ms giữa các instance trở thành tuỳ ý. Thứ tự đó vẫn **ổn định, là thứ tự toàn phần**, nên cursor không trùng và không sót. Lock/unlock của cùng user không bao giờ trùng `timestamp` (mốc tăng chặt), nên trail lock/unlock không phụ thuộc tie-break. Ghi vào spec và runbook (DEBT-425).
  - Đã cân nhắc và loại bỏ: `seq` (cần collection counter và 1 ghi thêm cho mỗi audit, over-engineering); UUIDv7 (Node không có sẵn; v4 cũ và v7 mới trộn lẫn thì thứ tự vô nghĩa; đổi định dạng id công khai).
- **Cursor**: payload mới là `{t: ms, i: <24 hex lowercase>}`. Decode: `i` khớp `^[0-9a-f]{24}$` rồi `new Types.ObjectId(i)`; `t` giữ kiểm tra cũ. **Cursor cũ `{t, e}` sẽ nhận 400 `invalid_request`**, không dịch sang định dạng mới. Lý do:
  - Dịch `(t, eventId)` sang vị trí trong sort mới cần thêm 1 lookup, hoặc phải chấp nhận sót các dòng cùng ms. Sót audit thì không chấp nhận được.
  - Cursor có hạn dùng ngắn (lấy từ trang trước).
  - fe-admin đã xử lý `invalid_request` khi có `after` bằng nút "First page" (`fe-admin/src/routes/audit/index.tsx:85`).
  - Cửa sổ ảnh hưởng chỉ bằng một lần deploy. Không 5xx, không sai dữ liệu.
- Cursor vẫn là base64url JSON, chuỗi khớp `^[A-Za-z0-9_-]{1,512}$`, nên `AuditCursorSchema` của fe-admin không đổi.
- **Index**: thay `{tenantId:1, timestamp:-1, eventId:-1}` bằng `{tenantId:1, timestamp:-1, _id:-1}` trong `audit-log.schema.ts`. `syncIndexes()` sẽ dựng index mới và drop index cũ. Prod dùng `autoIndex:false`, nên deploy phải chạy `pnpm -C be db:sync-indexes` (ghi runbook). DB dev/E2E (`sso-idp`, `sso-idp-e2e`): tester hoặc dev chạy `db:sync-indexes` trước E2E. Thiếu index thì vẫn chạy đúng (sort trong bộ nhớ trên tập đã lọc tenant), chỉ chậm hơn.
- **OpenAPI/fe-admin**: `AdminAuditEventView` (`eventId`, `timestamp`) và `nextCursor: string` không đổi. Không sửa description trong `admin.views.ts`/`admin.dto.ts`, để snapshot `fe-admin/openapi/admin.json` và `schema.d.ts` giữ nguyên. Verify bằng `git --no-pager diff --stat -- fe-admin/` (phải rỗng). Riêng doc comment của `encodeAuditCursor` trong BE thì sửa.

## Điểm mạnh

- Hướng sửa đúng gốc lỗi: thứ tự được quyết định bởi thứ tự Mongo áp dụng câu ghi trên cùng document, không còn phụ thuộc thứ tự phản hồi về Node hay đồng hồ instance.
- Không thêm transaction hay collection. Diff nhỏ: 2 method service, 1 tham số audit, 1 sort, 1 index.
- Có sẵn bộ test để bám: L1–L8 (`run56-tester`), (g)/(h)/(i), DEBT-152, cursor QA.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có điểm chặn. Các điểm dưới là thiết kế bắt buộc, đã fold vào `tasks.md`:

- [x] Path tenant_admin khoá lại user đang bị super khoá (no-op) cũng phải bump mốc, nếu không DEBT-420 vẫn còn ở path này. Đã chốt: dùng một pipeline (mục 2).
- [x] Unlock không biết `$$NOW`. Đã chốt: dùng literal `now` và tính lại từ pre-image (mục 1, 3).
- [x] Các event đi sau trong request lock phải có `timestamp >= lockMarkAt + 1ms` (mục 5).
- [x] Test (g) đang sort chỉ theo `_id`. Đổi sang thứ tự chuẩn `(timestamp, _id)`, giống `lockTrail`/DEBT-152, để test đúng cái fe-admin hiển thị.

## Đề xuất (không bắt buộc)

- Brute-force `AUTH_ACCOUNT_LOCKED` cũng có thể đua với admin unlock (DEBT-424, 💭).
- Ghi rõ trong runbook: thứ tự giữa các loại event khác nhau, hoặc giữa các instance, vẫn theo đồng hồ Node và NTP; cùng ms khác instance thì thứ tự ổn định nhưng tuỳ ý (DEBT-425).
