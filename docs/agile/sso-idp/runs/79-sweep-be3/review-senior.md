# Senior Review — 2026-11-09 (run 79, sweep 🟡 BE đợt 3)

## Kết luận: PASS

Không có 🔴. Code T1–T6 đúng theo fold; 2 🟡 (1 lỗ test cho AC T2, 1 ponytail) ⇒ backlog DEBT-528/529. ⇒ **tester**.

## Tổng quan

- Diff gọn, đúng module, đúng fold; tái dùng `isAdminCapableClient`, `scrubUriCredentials`, mẫu `SuperAdminGuard.runGuarded`, `onFailure` của `revokeAllUserCredentials` — không logic song song. Không thay đổi ngoài phạm vi (bỏ qua `.vscode/mcp.json`, `.mcp.json`).
- Kiểm lại: unit `mongo.service` + `keys.spec` 57/57; int `federation` + `ui` + `admin-api` + `seed-risk*` + `seed-dev` 320/320 (6 suite). `grep deleteById` trong `be/src` + `be/test` = 0.
- Lệch fold của dev — đánh giá:
  - T1 sửa mock `revokeAllUserCredentials` trong `ui.int-spec` để chuyển tiếp `onFailure`: **chấp nhận và cần thiết** (không thì fix không quan sát được). Ca (3) xanh cả trước fix = chốt bảo vệ, đúng như AC.
  - T5 test ở `admin-api.int-spec` thay vì `admin-capable-matrix`: **chấp nhận** — chỉ ở đây có controller PATCH + audit + credential thật để kiểm "không revoke, không audit success".
  - T2 race khác email 0/10 đỏ trên code cũ: **chấp nhận** — cùng email mới là ca DEBT-188 (`/auth/link`), 10/10 đỏ; ca khác email là chốt chống thoái lui.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **T2 provisioning federated** (`federation.service.ts:376-413`):
  - Cả 3 insert đi qua đúng `session` (`user.service.ts` `create([doc], { session })`, `user-tenant.service.ts` `addMembership(..., session)`, `federated-identity.service.ts` `link(..., session)`); không truyền ⇒ `session: undefined` ⇒ hành vi cũ cho mọi caller khác (register, admin, seed).
  - Retry của `withTransaction`: callback chỉ có 3 insert qua session, không audit/cookie/log/Redis ⇒ chạy lại sau `TransientTransactionError` không ghi đôi (lần trước đã abort) và không lặp side effect. `UnknownTransactionCommitResult` chỉ retry commit (không chạy lại callback). `emailVerifiedAt: new Date()` mỗi lần thử — vô hại. Mongoose 9 ⇒ driver ≥ 6, `withTransaction` trả giá trị callback (`sub`).
  - Race: hai transaction chèn cùng khoá unique khi bên kia chưa commit ⇒ WriteConflict (transient) ⇒ driver chạy lại; sau khi bên thắng commit ⇒ E11000 ⇒ `mapDuplicate` ⇒ `DuplicateError` (không phải `MongoError`, không nhãn) ⇒ abort + ném ⇒ `afterLostRace` đọc FI đã commit cùng User ⇒ `loginExisting` (vẫn kiểm user tồn tại + lock) ⇒ 302 session bên thắng. Không có nhánh mới lộ tồn tại tài khoản: race với `register` cùng email vẫn `retry` 503 như cũ, lần thử lại đi nhánh `local` ⇒ `link: true` (INV-22 không đổi, nhánh `local` chạy trước transaction, không link theo email).
  - Failure: lỗi không phải trùng ⇒ abort, 0 document, ném ⇒ 5xx; `endSession` trong `finally`. Mongo standalone ⇒ `withTransaction` lỗi `IllegalOperation` ⇒ 5xx fail-closed (production bị T3 chặn từ lúc boot).
  - Bù trừ `deleteById` + log `compensation failed` đã xoá sạch; không còn chỗ nào cần bù trừ (transaction thay thế toàn bộ). `deleteMembership` còn lại chỉ để test dùng (xem ✂️).
- **T3 boot check** (`mongo.service.ts:58-77`): production + không replica set/mongos ⇒ ném thông điệp cố định ⇒ `void bootstrap()` reject ⇒ Node 22 thoát mã ≠ 0 (không khởi động nửa vời). `hello` lỗi ở production ⇒ log error đã `scrubUriCredentials` + ném thông điệp cố định KHÔNG `cause` ⇒ Nest không in URI/credential (unit kiểm `s3cret` vắng ở cả error lẫn message). dev/test ⇒ đúng 1 WARN, vẫn chạy. `hello` chỉ đọc topology, không input người dùng. Treo: `hello` chạy sau khi Mongoose đã kết nối, server trả ngay; không có `maxTimeMS` nhưng rủi ro thấp (💭).
- **T1 logout `scope=all`** (`ui.controller.ts:357-375`): audit failure chỉ `scope` + `failedStep` (enum `pre_revoke|sessions|sweep`), `targetId = session.ref` như audit success — không message lỗi/token/session id thô. Audit tự ném ⇒ `revokeAllUserCredentials` nuốt (`.catch(() => undefined)`) rồi ném lỗi GỐC ⇒ vẫn 5xx, không audit success, không clear cookie, không redirect; body không chứa `boom`/`audit down` (test kiểm). Actor = chính user sau CsrfGuard.
- **T5 admin-capable** (`client.service.ts:251, 315`): điểm ghi giờ dùng cùng `isAdminCapableClient` với mọi chốt runtime; kiểm `current` TRƯỚC `revokeAllSecrets` ⇒ bản ghi lệch `{confidential, none}` ⇒ 400, không revoke, không ghi (test kiểm bản ghi byte-for-byte, 1 credential còn sống, 0 audit success). `AdminClientPatch` không cho đổi `clientType`/`tokenEndpointAuthMethod` ⇒ kiểm `current` là đủ. Create: `tokenEndpointAuthMethod` là bắt buộc trong `CreateClientInput` ⇒ không thoái lui cho client confidential hợp lệ. Không vòng import mới (`token.service` đã được import ở đây).
- **T4 seed** (`seed.ts:124-143`): `cause` chỉ gắn cho lỗi KHÔNG phải trùng (E11000 — chứa PII — vẫn không gắn); CLI in qua `cliErrorText` chỉ đọc `message` + scrub ⇒ `cause` không ra stdout. Vẫn ném trước mọi ghi (test đếm 0 document).
- **T6** seam `listDir`: không đổi hành vi; WARN không chứa path.

## 🟡 Nên sửa

- [ ] **Test T2 chưa chứng minh "0 UserTenant"** — `be/test/federation.int-spec.ts` (ca `DEBT-182: %s failing`, ~:2005-2006): đếm UT bằng `userId $in users.map(_id)` ngay sau khi đã khẳng định `userModel.countDocuments({ email }) === 0` ⇒ `users` luôn rỗng ⇒ `$in: []` ⇒ luôn 0 (assert chết).
  Vì sao: mutation "bỏ `session` ở `addMembership`" (fold yêu cầu "bỏ session ở 1 trong 3 insert ⇒ đỏ") sẽ để lại một UserTenant mồ côi (commit ngoài transaction, User bị abort) mà ca `link` vẫn XANH; dev chỉ ghi mutation cho User và cho "bỏ transaction". Code hiện tại đúng (đã đọc cả 3 chỗ), nhưng thiếu chốt chống thoái lui cho AC (1) "0 UserTenant". Blast radius thấp (UT trỏ user không tồn tại, không cấp quyền) ⇒ 🟡.
  Đề xuất: lấy `sub` thật — `jest.spyOn(UserService.prototype, 'create')` (không mock, chỉ đọc `mock.results[0].value`) rồi `utModel.countDocuments({ userId: sub })`, hoặc đếm `utModel.countDocuments({ tenantId: DEFAULT_TENANT_ID })` trước/sau. Ghi mutation "bỏ session ở addMembership ⇒ ca `link` đỏ". ⇒ DEBT-528.

## 💭 Nit

- `mongo.service.ts:62` — `hello` không có giới hạn thời gian riêng; có thể đọc topology đã có sẵn (`this.connection.getClient()` topology description) thay vì gọi mạng, hoặc chấp nhận như hiện tại (server đã kết nối, `hello` trả ngay). Không cần debt.
- Dev Mongo standalone (nếu có) ⇒ từ run này provisioning federated ở dev trả 5xx (trước đây chạy nhờ bù trừ); WARN lúc boot đã nói "some admin writes will fail" — có thể thêm "federated sign-up" vào câu WARN cho dễ chẩn đoán.
- `ui.int-spec.ts` — `audit.record.mockRejectedValueOnce` rò sang ca kế khi fix bị gỡ (dev đã ghi): nếu `beforeEach` dùng `mockReset` thay vì `mockClear` thì không rò. Chỉ ảnh hưởng khi chạy mutation.

## ✂️ Ponytail

- be/src/modules/identity/user-tenant.service.ts:L46: yagni: `deleteMembership` (code sản phẩm) giờ chỉ còn `be/test/admin-users.int-spec.ts:899` gọi. Xoá hàm, test dùng thẳng `utModel.deleteOne({ userId, tenantId })`. ⇒ DEBT-529
- be/test/federation.int-spec.ts:L2005: delete: dòng `users` + đếm UT `$in` là assert chết (xem 🟡). Thay bằng đếm theo `sub` thật.
- be/src/database/seed.ts:L172: shrink: hai `throw new Error(...)` gần như trùng tiền tố; có thể dựng một `advice` rồi một `throw` — lợi ích nhỏ, giữ được.

net: -8 lines possible.
