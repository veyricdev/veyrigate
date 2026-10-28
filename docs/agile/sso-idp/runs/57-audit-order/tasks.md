# Tasks — run 57 — thứ tự audit lock/unlock (DEBT-420 + DEBT-422) (M7, lane BE)

> Quyết định người dùng (2026-10-26, kết run 56): gộp DEBT-420 (lock∥unlock không barrier — trail đôi khi kết thúc lệch trạng thái DB vì thứ tự phản hồi khác thứ tự Mongo áp dụng; test L6 trong `be/test/run56-tester.int-spec.ts` đang `it.skip`) với DEBT-422 (`listForTenant` sort `{timestamp:-1, eventId:-1}`, `eventId` = `randomUUID()` ⇒ trùng ms hiển thị thứ tự ngẫu nhiên ở fe-admin). Hướng đã chọn: mỗi câu ghi lock/unlock đặt một mốc thời gian chỉ tăng theo user (vd. pipeline `adminLockAt = max($$NOW, prev + 1ms)` trong cùng câu update), audit dùng đúng mốc đó làm `timestamp`; tie-break đơn điệu cho `listForTenant`. Nguồn: `runs/56-admin-race/{test-report.md,review-senior.md,log.md}`, `backlog.md` DEBT-420/422, spec §9.11/§10, `security-matrix.md`.
>
> Hạ tầng: KHÔNG compose up/FLUSH/drop; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop tác vụ của chính agent).

### [x] Task 1 [BE]: mốc thời gian đơn điệu theo user trong câu ghi `adminLock`/`adminUnlock`; `AuditService.record` nhận timestamp tuỳ chọn; lock/unlock audit dùng mốc đó; bật lại L6 (`it.skip` ⇒ `it`) và chạy lặp ≥10 lần xanh.
### [x] Task 2 [BE]: tie-break đơn điệu cho sort audit (`listForTenant` + cursor) — không còn phụ thuộc `randomUUID`; tương thích cursor/dữ liệu cũ; fe-admin không cần đổi (kiểm snapshot OpenAPI).

## Fold tech-lead (2026-10-26) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Lý do chi tiết: `review-techlead.md`. Giữ nguyên hướng người dùng đã chọn, mục này chỉ chốt chi tiết. Lưu ý: dùng `now` do Node chụp làm literal, **không** dùng `$$NOW`.

### Task 1 [BE] — mốc đơn điệu + audit dùng mốc + bật lại L6

1. **Field `users.adminLockMarkAt`** (Date, đơn vị ms). Thêm vào `user.schema.ts` và `UserDoc`. KHÔNG đưa vào `UserView`/`AdminUserView`/OpenAPI, không ghi log.
   - Helper thuần `nextAdminLockMark(prev: Date | undefined, now: Date)` = `new Date(max(now, (prev ?? epoch) + 1))`.
   - Biểu thức pipeline: `{$max: [now, {$add: [{$ifNull: ['$adminLockMarkAt', new Date(0)]}, 1]}]}`.
   - `now` là Date do Node chụp ngay trước câu ghi, truyền vào làm literal. Tham số `now = new Date()` để test inject được.
   - Chỉ `adminLock`/`adminUnlock` bump mốc. Brute-force, login và `setPassword` không đụng tới (xem DEBT-424).
   - verify: unit `nextAdminLockMark` với 3 trường hợp: prev undefined; prev < now; prev ≥ now ⇒ kết quả prev+1.
2. **`adminLock(sub, level, now = new Date())`** gồm MỘT `findOneAndUpdate({_id: sub}, [pipeline], {returnDocument:'after', updatePipeline:true})`.
   - Bỏ vòng lặp 2 lượt, bỏ bước đọc lại, bỏ `throw 'changed concurrently'`.
   - Pipeline:
     - `lockedUntil` = sentinel.
     - `adminLockLevel`: level super ⇒ `'super_admin'`. Level tenant ⇒ `$cond`: nếu đang có sentinel VÀ level hiện tại ≠ `'tenant_admin'` (gồm cả sentinel cũ không có level) thì giữ nguyên (`$ifNull: ['$adminLockLevel', '$$REMOVE']`); ngược lại đặt `'tenant_admin'`.
     - `adminLockMarkAt` theo công thức ở mục 1.
   - Trả về `{ user: UserView; lockMarkAt: Date } | null`.
   - verify: L1 (tenant khoá lại user đang bị super khoá ⇒ level giữ `super_admin`), L2 (sentinel cũ vẫn không có level, tenant unlock ⇒ 403), L7 xanh. Thêm assert: lần lock no-op của tenant vẫn làm tăng `adminLockMarkAt`.
3. **`adminUnlock(sub, actorIsSuperAdmin, now = new Date())`**.
   - Giữ filter mức. Update đổi sang pipeline: `$set {failedLoginCount:0, adminLockMarkAt:<công thức>}` rồi `$unset ['lockedUntil','adminLockLevel']`.
   - Giữ `returnDocument:'before'`; projection phải có `adminLockMarkAt`.
   - Trả về `{ before: UserView; unlockMarkAt: nextAdminLockMark(before.adminLockMarkAt, now) } | 'forbidden' | null`.
   - verify (int): sau unlock, `adminLockMarkAt` trong DB === `timestamp` của audit `UNLOCKED success`.
4. **`AuditService.record(input, opts?: { timestamp?: Date })`**.
   - KHÔNG thêm `timestamp` vào `AuditEventInput`.
   - `opts.timestamp` không hợp lệ (`isNaN`) ⇒ throw, không ghi gì.
   - Không truyền `opts.timestamp` ⇒ dùng `new Date()` như cũ. `eventId` vẫn là `randomUUID()`.
   - verify (unit `audit.service.spec`): truyền timestamp ⇒ event dùng đúng giá trị đó; Date không hợp lệ ⇒ reject và không gọi model.
5. **Controller**.
   - `lock`: `LOCKED success` ghi `{timestamp: lockMarkAt}`. `LOCKED failure revoke_failed` và `SESSION_REVOKED via:'lock'` ghi `{timestamp: max(new Date(), lockMarkAt + 1ms)}`.
   - `unlock`: `UNLOCKED success` ghi `{timestamp: unlockMarkAt}`. `failure locked_by_super_admin` giữ giờ Node.
   - Giữ thứ tự fail-closed: audit success bắt đầu trước revoke và được `await` sau revoke (test (i)).
   - Sửa comment `admin-users.controller.ts:165-170` cho đúng cơ chế mới.
6. **Test bắt buộc** (BE int, ghi số liệu vào log).
   - (a) Bật lại L6: `it.skip` ⇒ `it`, bỏ comment quarantine. Chạy `pnpm -C be test:int --testPathPatterns run56-tester -t "L5|L6|L7"` **≥ 10 lượt liên tiếp, tất cả xanh** (ghi số lượt và kết quả), rồi chạy full `test:int`.
   - (b) **Barrier tất định, chiều 1**: spy `UserService.adminLock` cho câu ghi thật chạy xong rồi giữ TRƯỚC khi controller audit. Trong lúc giữ, chạy xong một unlock super (ghi DB + audit). Thả ra. Kỳ vọng: DB ở trạng thái unlocked, trail sắp theo `(timestamp,_id)` kết thúc bằng `UNLOCKED success`.
   - (c) **Chiều 2**: spy `adminUnlock` (câu ghi thật xong, giữ trước audit). Trong lúc giữ, chạy xong một lock super (có audit lock). Thả ra. Kỳ vọng: DB locked, trail kết thúc bằng `LOCKED success`.
   - (d) Trùng ms: lần lượt `adminLock`, `adminUnlock`, `adminLock` với cùng `now` inject. Kỳ vọng mốc tăng đúng +1ms ở mỗi bước, và timestamp của 3 audit tăng chặt.
   - (e) DEBT-152 (`lock: revoke fault … retry`) vẫn ra `['success','failure','success']`. Thêm assert: trong cùng request, `SESSION_REVOKED.timestamp` > `LOCKED success.timestamp`.
   - (f) Test (g) đổi sort `{_id:1}` ⇒ `{timestamp:1, _id:1}`. (h), (i), L1–L8 phải xanh.
   - **Mutation** (ghi kết quả RED vào log rồi hoàn tác):
     - m1: audit lock/unlock dùng `new Date()` thay vì mốc ⇒ (b) hoặc (c) RED.
     - m2: bỏ vế `+1` (chỉ còn `now`) ⇒ (d) RED.
     - m3: lần lock no-op của tenant không bump mốc ⇒ assert ở mục 2 RED.
     - m4: follow-up dùng `new Date()` trần ⇒ (e) RED; nếu không dựng được case này thì ghi lý do.

### Task 2 [BE] — tie-break `_id` cho admin audit list + cursor

1. **`listForTenant`**:
   - Sort `{timestamp:-1, _id:-1}`.
   - Cursor: `$or: [{timestamp:{$lt:t}}, {timestamp:t, _id:{$lt:i}}]`. `tenantId` vẫn merge sau cùng.
   - `AuditCursor = {timestamp: Date; id: Types.ObjectId}`.
2. **Mã hoá cursor**:
   - `encodeAuditCursor` = base64url của JSON `{t, i: _id.toHexString()}`. `toPage` lấy `_id` từ row lean; mapper không lộ `_id` ra view.
   - `decodeAuditCursor`: `i` phải là string khớp `^[0-9a-f]{24}$`; `t` kiểm như cũ. Mọi dạng khác ⇒ null ⇒ 400 `invalid_request`, **kể cả cursor cũ `{t, e}`**. fe-admin đã có sẵn nút "First page" cho trường hợp này.
3. **Index** (`audit-log.schema.ts`):
   - Thay `{tenantId:1, timestamp:-1, eventId:-1}` bằng `{tenantId:1, timestamp:-1, _id:-1}`.
   - Ghi runbook: lúc deploy chạy `pnpm -C be db:sync-indexes` (prod để `autoIndex:false`; `syncIndexes` sẽ drop index cũ). Chạy lệnh này trên DB `sso-idp` và `sso-idp-e2e` trước E2E (không drop, không FLUSH).
   - verify: index mới tồn tại sau sync-indexes.
4. **Test bắt buộc**.
   - (a) Sort ổn định khi trùng ms: chèn trực tiếp 5 event cùng tenant, cùng `timestamp`, `_id` tăng dần, còn `eventId` sắp NGƯỢC thứ tự `_id`. `GET /admin/audit` phải trả thứ tự `_id` giảm dần.
   - (b) Cursor qua ranh giới trùng timestamp: dùng dữ liệu ở (a), thêm 2 event có timestamp ±1ms. Phân trang `limit=2` đến hết ⇒ đủ 7 event, không trùng, không sót, đúng thứ tự.
   - (c) Cursor sai ⇒ 400: `{t,e}` cũ; `i` dài 23 hoặc 25 ký tự; `i` hex chữ hoa; `i` không phải hex; `i` là số, object hoặc `{"$gt":""}`; thiếu `i`; `t` âm hoặc quá lớn. Cập nhật test `audit cursor: … => 400`: `{t:0,e:'x'}` ⇒ 400; `{t:0,i:'0'.repeat(24)}` ⇒ 200 với trang rỗng.
   - (d) Cross-tenant: cursor chứa `_id` của event tenant B, gọi bằng token tenant A ⇒ chỉ trả event tenant A, không lỗi.
   - **Mutation**:
     - Tie-break bằng `eventId` (code cũ) ⇒ (a) RED.
     - Cursor so `$lte` ⇒ (b) RED (trùng dòng).
5. **fe-admin/OpenAPI**: không đổi `admin.views.ts`/`admin.dto.ts` (kể cả description). `git --no-pager diff --stat -- fe-admin/` phải rỗng.
6. **Docs**:
   - spec §9.11: thay câu "Cùng mili-giây … chưa xác định (DEBT-422)" bằng nghĩa mới: mốc `adminLockMarkAt` tăng chặt theo user; `timestamp` của LOCKED/UNLOCKED success = mốc; sort `(timestamp desc, _id desc)`; event cùng ms nhưng khác instance có thứ tự ổn định nhưng tuỳ ý.
   - spec §10: thêm `adminLockMarkAt` vào User; ghi thứ tự sắp cho AuditLog.
   - `security-matrix` dòng DEBT-420/421: thêm các test mới.
   - Đóng DEBT-420/422.

### Cổng security (BẮT BUỘC, senior/tester kiểm)

- **Tài sản, actor, boundary**:
  - Tài sản: trạng thái khoá của user và audit trail admin. Actor: super_admin, tenant_admin qua Admin API (`admin.write` + recent auth).
  - Quy tắc mức DEBT-153 KHÔNG được yếu đi. L1, L2, L7 và assert ở mục T1.2 phải xanh.
- **Invariant**:
  - Mỗi câu ghi lock/unlock làm mốc tăng chặt.
  - timestamp của success = mốc của chính câu ghi đó.
  - Trạng thái DB cuối == event success cuối của trail theo `(timestamp,_id)`, với mọi thứ tự phản hồi.
  - Follow-up của lock có timestamp > `LOCKED success` của cùng request.
- **Abuse**:
  - Cursor giả (operator, `_id` của tenant khác, định dạng cũ) ⇒ 400, hoặc chỉ trả dữ liệu trong tenant.
  - Không có đường HTTP nào đặt được timestamp audit. Grep `record(` có tham số thứ 2: chỉ được xuất hiện ở `admin-users.controller.ts`.
  - Race: L4, L6, (b), (c) xanh.
- **Failure semantics**:
  - Câu ghi user lỗi ⇒ 5xx, không có audit success.
  - Audit lỗi ⇒ revoke vẫn chạy, 5xx, khoá giữ nguyên ((i)).
  - Mốc và trạng thái nằm cùng một câu ghi nên không có ghi dở dang (partial).
  - timestamp không hợp lệ ⇒ throw.
- **Exposure**:
  - `adminLockMarkAt` không xuất hiện trong response user, log hay metadata audit (có assert).
  - Cursor chỉ chứa `t` và hex `_id`.
  - Body 400 không đổi.

### Ngoài phạm vi (backlog)

- DEBT-424: `AUTH_ACCOUNT_LOCKED` (brute-force) chạy song song với admin unlock.
- DEBT-425: thứ tự giữa các loại event khác nhau và giữa các instance vẫn theo đồng hồ Node; cần ghi vào runbook.
