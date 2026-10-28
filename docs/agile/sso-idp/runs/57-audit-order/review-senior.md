# Senior Review — 2026-10-26 (run 57 — thứ tự audit lock/unlock, DEBT-420 + DEBT-422)

## Kết luận: PASS

Không có 🔴. Còn 1 🟡 (có từ trước, không phải regression), ghi thành DEBT-427.

## Tổng quan (ấn tượng chung + điểm tốt)

Diff nhỏ, bám sát mục fold của tech-lead và sửa đúng gốc lỗi. Thứ tự trail giờ do thứ tự Mongo áp dụng câu ghi trên cùng document quyết định, không còn phụ thuộc thứ tự phản hồi về Node.

- `adminLock` gộp thành một `findOneAndUpdate` pipeline: bỏ vòng 2 lượt, bỏ bước đọc lại và bỏ `throw 'changed concurrently'`. Code ngắn hơn và nguyên tử thật.
- Cách đặt `AuditService.record(input, opts)` đúng chỗ: timestamp nằm ngoài `AuditEventInput`, nên không object nào spread từ request đặt được giờ audit.
- Test có giá trị: barrier tất định hai chiều (b)/(c) đối chiếu audit với mốc DB, (d) inject cùng `now`, có assert exposure (body, view, metadata, log pino), L6 đã bật lại. Mutation m1–m4 cùng hai mutation T2 đều RED.

Senior tự chạy lại (2026-10-26): `pnpm -C be typecheck` OK, `pnpm -C be lint` OK, `pnpm -C be test` 38 suite / 594 test xanh. `git diff --stat -- fe-admin/` rỗng. Int không chạy lại; dùng số liệu dev (1355, 0 skip; L5|L6|L7 10/10).

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Quy tắc mức DEBT-153 không yếu đi.** Mệnh đề `keepHigher` là `$eq(lockedUntil, sentinel) ∧ $ne(adminLockLevel, 'tenant_admin')`. Đây đúng là phủ định của filter cũ `tenantAdminMayChangeLock`, tức `lockedUntil ≠ sentinel ∨ level = 'tenant_admin'`:
  - Field `lockedUntil` vắng ⇒ `$eq` false. Khớp với `$ne` của query, vốn match cả field vắng.
  - Field level vắng (sentinel cũ) ⇒ `$ne` true ⇒ `$ifNull(…, '$$REMOVE')` giữ nguyên trạng thái vắng, nên vẫn được coi là mức super.
  - super_admin luôn đặt `'super_admin'`.

  Ngữ nghĩa tương đương run 56. Khác biệt duy nhất: path no-op giờ CÓ ghi (bump mốc và `updatedAt`), đúng yêu cầu. Bỏ vòng 2 lượt không mở lỗ nào: không còn bước đọc rồi quyết định nên không có TOCTOU. Các test L1 (kèm assert mốc tăng), L2, L7 đều xanh.
- **Unlock.** Filter mức vẫn nằm trong câu ghi (`tenantAdminMayChangeLock` cho tenant). Pipeline `$set {failedLoginCount:0, mark}` rồi `$unset`, kèm `returnDocument:'before'`. `PUBLIC_FIELDS` là projection loại trừ (`-passwordHash -mfaSecret`), nên pre-image có `adminLockMarkAt`. `findOneAndUpdate` nguyên tử nên pre-image chính là input của pipeline, và `nextAdminLockMark(before.mark, now)` đúng bằng giá trị đã ghi. Bằng chứng: (b) assert `UNLOCKED.timestamp === DB mark`; (d) assert mốc +1 ms ở mỗi bước. Path `forbidden`/null không ghi gì nên không có mốc.
- **Timestamp audit không đến từ HTTP.** Grep `record(…, {timestamp…})` chỉ ra 4 chỗ, đều trong `admin-users.controller.ts`, và giá trị đều do server tính (`lockMarkAt`, `afterMark()`, `unlockMarkAt`). `AuditEventInput` không có `timestamp`. Giá trị không phải `Date` hoặc `Invalid Date` ⇒ throw trước `create` (unit test có 3 case và assert `create` không được gọi). Giá trị được copy (`new Date(at.getTime())`), nên caller sửa object sau đó cũng không ảnh hưởng event.
- **Controller / fail-closed.**
  - `LOCKED success` dùng mốc làm timestamp; hai follow-up dùng `max(Date.now(), mark+1)`. Test DEBT-152 đẩy mốc lên trước 1 giờ rồi assert `SESSION_REVOKED > LOCKED success` (m4 RED nếu bỏ).
  - Promise audit success vẫn được tạo trước revoke, có `.catch` để tránh unhandled rejection, và được `await` sau revoke. Test (i) xanh.
  - Câu ghi user lỗi ⇒ throw trước mọi audit ⇒ 5xx. Mốc và trạng thái nằm cùng một câu ghi nên không có ghi dở dang.
- **Invariant "DB cuối == success cuối".** Mốc tăng chặt theo thứ tự áp dụng và success dùng đúng mốc, nên invariant giữ với mọi thứ tự phản hồi. Follow-up (`failure`, `SESSION_REVOKED`) có thể trùng ms với một UNLOCKED chen giữa, nhưng chúng không phải success của lock/unlock nên không phá invariant. Thứ tự hiển thị trong trường hợp đó do `_id` quyết định (thuộc DEBT-426, mức 💭 là đúng).
- **Sort/cursor.**
  - `$or` dùng `$lt` ở cả hai vế. `tenantId` được gán sau cùng nên đè mọi giá trị trong filter.
  - `i` phải khớp `^[0-9a-f]{24}$` trước khi dựng `new Types.ObjectId`, nên operator, array, số, chữ hoa và độ dài sai đều trả 400 (T2c, body `invalid_request`/`invalid cursor` không đổi).
  - Cursor chứa `_id` của tenant B chỉ là một vị trí trong sort: không trả dữ liệu B và không lỗi (T2d).
  - Cursor cũ `{t,e}` ⇒ 400.
  - Mapper `toAdminAuditEvent` whitelist field nên `_id` không ra view.
- **Index.** `{tenantId:1, timestamp:-1, _id:-1}` có test sync và test drop index cũ. Runbook §1 đã ghi `db:sync-indexes` trước rollout, kèm hệ quả với cursor cũ.
- **Exposure.** `adminLockMarkAt` không có trong `toView`, `UserView` hay OpenAPI. (d) assert không thấy trong body lock/unlock/GET user, metadata audit và log pino. `fe-admin/` không đổi.
- **DEBT-426 💭**: mức đúng. Trùng ms giữa mốc retry và `failure` trước đó chỉ ảnh hưởng thứ tự hiển thị giữa hai event cùng nghĩa "đã khoá", không làm lệch trạng thái.

## 🟡 Nên sửa

- [ ] 🟡 **Cursor `t` vượt biên Date ⇒ 5xx thay vì 400** (có từ trước run 57, không phải regression) — `be/src/modules/admin/admin-audit.controller.ts:37`.
  - Vấn đề: check hiện tại là `Number.isSafeInteger(t) && t >= 0`. Mọi `t` trong khoảng (8.64e15, 2^53−1] đều qua check, nhưng `new Date(t)` ra `Invalid Date`. Mongoose cast ném `CastError` (đã kiểm bằng `Query.cast` với `t = 9e15`). `toAdminError` không map lỗi này nên request ra 500.
  - Vì sao: tasks T2c ghi "`t` âm hoặc quá lớn ⇒ 400", nhưng test chỉ thử `MAX_SAFE_INTEGER + 2`, giá trị đã bị chặn sẵn. Một admin đã xác thực gửi input rác sẽ nhận 5xx (nhiễu alert/SLO, sai contract 400). Không lộ dữ liệu, không bypass.
  - Đề xuất: thêm `|| t > 8.64e15` (hoặc `Number.isNaN(new Date(t).getTime())`) vào điều kiện reject, và thêm `forged({ t: 9e15, i: hex })` vào T2c.
  - Ghi thành **DEBT-427**.

## 💭 Nit

- 💭 Doc comment của `adminUnlock` (`be/src/modules/identity/user.service.ts`, khoảng L353–355) có một dòng dài hơn 100 ký tự ("…plus the mark written (the caller audits from that, not from an earlier read). A tenant_admin"). Prettier không tự ngắt comment; nên ngắt tay cho đồng bộ với phần còn lại.
- 💭 Test (c) đối chiếu `LOCKED.timestamp` với mốc DB. Đối chiếu `UNLOCKED.timestamp` với mốc DB nằm ở (b). Hai test gộp lại đã đủ yêu cầu T1.3. Có thể ghi chú chéo trong tên test để tester đọc nhanh.

## ✂️ Ponytail

Lean already. Ship.

- Có hai chỗ cùng diễn đạt một quy tắc: `nextAdminLockMark` và `adminLockMarkExpr`. Đây là thiết kế bắt buộc: unlock cần tính lại mốc từ pre-image, còn pipeline cần biểu thức Mongo. Hai chỗ nằm cạnh nhau và cùng doc comment, nên không cắt.
- `AuditRow`, `afterMark` và filter `_id_` mới trong `indexes.int-spec` đều tối thiểu và cần thiết.
