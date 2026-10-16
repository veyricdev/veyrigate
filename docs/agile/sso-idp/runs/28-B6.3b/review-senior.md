# Senior Review — 2026-10-16

## Kết luận: REJECT   (1 🔴 [BE])

Verify thật (vg-test-*): `pnpm -C be typecheck` ✓; `pnpm -C be test` 243/243; `test:int` admin-users + authentication + refresh-token + indexes 105/105.

## Tổng quan (ấn tượng chung + điểm tốt)
Diff gọn, bám sát fold tech-lead. Những điểm làm tốt:
- Mọi route `/admin/users/:id/**` đi qua `mustFind`: id hex → `findMember(ctx)` → id canonical lowercase. 404 đồng nhất cho id sai, không phải member hoặc tenant khác. Phép so sánh tự-thao-tác dùng id canonical nên viết hoa id không lách được.
- `setRoles` đưa điều kiện "target không giữ super_admin" vào filter `findOneAndUpdate` (`roles: {$ne}`), nên không có TOCTOU. Khi không khớp, code phân biệt 403 với 404 bằng `findMember` tenant-scoped, không mở oracle cross-tenant.
- Family và consent luôn lọc `clientId ∈ tenantClientIds(ctx, distinct của user)`, tenant nằm ngay trong query (INV-24). Revoke family dùng lại `revokeFamily` (stamp-first). Biến thể `RevokeFilter {userId,clientId,resource}` đi qua `revokeWhere`, có unit âm cho `clientId` rỗng.
- `revokeAllUserCredentials` tách đúng ngữ nghĩa DEBT-055: chạy đủ 3 bước, lỗi đầu thắng, failure-audit best-effort rồi throw. `resetPassword` không hồi quy (int authentication và refresh-token xanh).
- Audit query: các key filter cố định, mọi giá trị là string/enum đã validate (không object hay operator, không regex). `tenantId` được gán sau cùng. Cursor base64url được validate kiểu và độ dài. Index ghép đã có trong `indexes.int-spec` và runbook.
- Mapper allowlist (user, family, consent, audit) có test assert tập key; `UserView` vốn đã loại `passwordHash`/`mfaSecret`.

## 🔴 Blocker
- [ ] **[BE] Bảo mật: tự gỡ admin-lock qua quên mật khẩu.** Lỗi ở `be/src/modules/identity/user.service.ts:233-241` (`setPassword` có `$unset: {lockedUntil: 1}`) và `be/src/modules/authentication/authentication.service.ts:177-207` (`resetPassword`).
  - Vì sao: admin lock đặt sentinel `ADMIN_LOCKED_UNTIL` và theo fold có nghĩa là "khoá tới khi admin unlock". Security invariant ghi rõ: "Lock ⇒ `lockedUntil > now`". Nhưng `forgotPassword` không kiểm lock, còn `resetPassword` → `setPassword` gỡ `lockedUntil` vô điều kiện. Kết quả là người bị khoá, hoặc kẻ chiếm được hộp thư (đúng kịch bản account bị chiếm mà admin muốn chặn), chỉ cần gửi `/forgot` → `/reset` là login lại được ngay. Quyết định của admin bị luồng self-service vô hiệu hoá. Đây là bypass trust boundary admin ↔ user, và không có test nào bao phủ.
  - Đề xuất: `setPassword` chỉ gỡ lock tự động (brute-force B2.4), giữ nguyên sentinel. Ví dụ dùng update pipeline `lockedUntil: {$cond: [{$eq: ['$lockedUntil', ADMIN_LOCKED_UNTIL]}, '$lockedUntil', '$$REMOVE']}`, hoặc `$unset` có điều kiện `lockedUntil: {$ne: SENTINEL}`. Hằng sentinel nên chuyển sang `identity` để không phải import ngược từ admin. Reset vẫn đổi mật khẩu và revoke credential như cũ. Thêm int test: admin lock → forgot + reset → login đúng mật khẩu mới vẫn bị từ chối; admin unlock → login được. Kèm mutation RED (bỏ điều kiện thì test fail).

## Security invariants / trust boundaries đã kiểm
- **Identity/IDOR**: user, family và consent của tenant khác hoặc user khác ⇒ 404 byte-identical. Đã kiểm `mustFind`, `findFamilyClient(familyId,userId)` + `getForTenant`, `revokeById` với filter `{_id,userId,clientId∈C,revokedAt:null}`. OK.
- **Leo thang role**:
  - non-super cấp `super_admin` ⇒ 403 trước khi ghi.
  - target giữ super_admin ⇒ filter atomic chặn.
  - tự đổi vai trò, tự lock ⇒ 403.
  - giáng quyền có hiệu lực ở request kế tiếp nhờ guard đọc lại roles.
  - OK. Race giáng chéo đã có DEBT-142.
- **Trạng thái global (user/session)**: tenant_admin bị 403 khi target có role admin ở bất kỳ tenant nào hoặc có membership active ở tenant khác. Check-then-act đã ghi DEBT-148. OK.
- **Revoke (DEBT-055/034)**:
  - lock: stamp lock trước rồi mới revoke; lỗi ⇒ giữ lock, 5xx, retry idempotent.
  - family: stamp-first qua `revokeWhere`.
  - consent → family `{user,client,resource}`: resource `''` của consent khớp với refresh vì code grant không có resource thì không mint được (`invalid_target`).
  - OK, trừ 🟡-1.
- **Failure behavior**: Mongo/Redis lỗi ⇒ 5xx, không biến thành success, không rollback lock. Riêng consent revoke lỗi giữa chừng thì xem 🟡-1.
- **Exposure**: response không có `passwordHash`/`mfaSecret`/`lockTransitionNonce`/`failedLoginCount`/`tokenHash`/`sessionRef`/`deviceId`/`_id`/`tenantId` (audit). Lỗi 5xx không lộ message (test `redis down`). OK.
- **Audit query**:
  - tenant cứng, event không có tenant không hiện.
  - không regex; `QueryFilter` chỉ nhận giá trị đã qua class-validator.
  - cursor: JSON parse trong try, kiểm `t` là safe int ≥0 và `e` là string ≤128; không dùng dữ liệu cursor làm key.
  - `from<to` ⇒ 400.
  - OK.
- **Enumeration**: `?email=` khớp chính xác; user tồn tại nhưng không phải member ⇒ `items:[]`, giống hệt user không tồn tại. OK.

## 🟡 Nên sửa
1. **[BE] Revoke consent không retry được sau lỗi giữa chừng** (`admin-users.controller.ts:381-398`).
   - Diễn biến: `revokeById` đã ghi `revokedAt`, sau đó `revokeForConsent` hoặc audit lỗi ⇒ 5xx. Admin gọi lại thì nhận 404, vì consent đã revoke trả 404.
   - Hậu quả: family `offline_access` của `user×client×resource` vẫn sống 30 ngày, endpoint không có đường tự sửa, và audit không có event nào (kể cả failure).
   - Cân nhắc: với consent đã revoke thuộc client tenant, vẫn chạy `revokeForConsent` (idempotent) rồi trả 204. Hoặc revoke family trước (idempotent) rồi consent, rồi sweep family lần nữa (giống 3 bước DEBT-055). Thêm failure-audit best-effort. → DEBT-151.
2. **[BE] Lock retry sau `revoke_failed` không ghi audit success** (`admin-users.controller.ts:162`).
   - Diễn biến: lần 1 đã đặt sentinel thì `t.user.lockedUntil === SENTINEL`, nên lần retry thành công bỏ qua `ADMIN_USER_LOCKED success`. Audit trail chỉ còn event `failure`, nên người đọc audit tưởng account vẫn chưa được revoke credential.
   - Cân nhắc: ghi success khi có thay đổi lock **hoặc** khi đây là lần revoke thành công (đơn giản nhất: luôn ghi success vì revoke chạy mỗi lần, giống `sessions/revoke`). → DEBT-152.
3. **[BE] tenant_admin gỡ được lock do super_admin đặt** (`unlock`, `assertMayTouchAccount`).
   - Diễn biến: lock không lưu nguồn gốc. super_admin khoá một member thường (có thể vì sự cố bảo mật nền tảng), sau đó tenant_admin của tenant đó unlock được ngay.
   - Cân nhắc: lưu `lockedBy`/`lockLevel`, hoặc chốt với tech-lead rằng đây là hành vi chấp nhận. → DEBT-153.

## 💭 Nit
- Phần `unlessRole` của `setRoles` chỉ xét membership ở tenant của token. Nếu target giữ `super_admin` ở tenant khác, tenant_admin vẫn đổi được `tenant_admin` của target tại tenant mình. Thay đổi chỉ trong phạm vi tenant mình nên không phải leo thang, nhưng câu "target đang giữ super_admin" trong fold đang hiểu theo nghĩa hẹp. Nên ghi rõ trong comment.
- `ADMIN_LOCKED_UNTIL` khai báo ở controller admin. Khi sửa 🔴, nên chuyển về `identity` (nơi định nghĩa ngữ nghĩa lock).

## ✂️ Ponytail
- be/src/modules/authentication/authentication.service.ts:L230: yagni: `tokenCount` được cộng dồn và trả về nhưng không caller nào dùng. Có thể trả `{ sessionCount }`, hoặc chỉ trả `number`.
- be/src/modules/admin/admin-users.controller.ts:L50: shrink: alias `ADMIN_ROLES` chỉ để ép kiểu. Có thể dùng `(ADMIN_ROLE_VALUES as readonly string[]).includes(r)` ngay tại chỗ.
- be/src/modules/admin/admin.mappers.ts:L668: shrink: `AdminFamilyView` lặp y hệt `FamilySummary`. Có thể dùng `type AdminFamilyView = FamilySummary` (giữ hàm map allowlist).
net: -15 lines possible.

---

# Lượt 2 — 2026-10-16

## Kết luận: PASS   (🔴 lượt 1 đã sửa đúng; không có 🔴 mới; 1 🟡 mới → DEBT-154)

Verify thật (vg-test-*): `pnpm -C be typecheck` ✓; `pnpm -C be test` 243/243; `test:int` admin-users + authentication + refresh-token + indexes + identity 115/115 (5 suite).

## Tổng quan
Fix gọn, đúng chỗ. `setPassword` giờ là một update pipeline atomic. Vì đọc và ghi `lockedUntil` nằm trong cùng một lệnh, không có TOCTOU giữa reset và admin lock: lock đến trước thì sentinel được giữ, đến sau thì ghi đè lên. Hằng `ADMIN_LOCKED_UNTIL` đã chuyển về `identity`, đúng nit lượt 1. Int test có cả hai chiều (admin lock còn sau reset, lock B2.4 bị reset gỡ), và mutation `$cond` cả hai nhánh đều cho RED. DEBT-152 đóng đúng.

## 🔴 Blocker lượt 1 — đã kiểm
- [x] `be/src/modules/identity/user.service.ts:240-263`. Đã chạy lại kịch bản lượt 1: admin lock → `/forgot` → `/reset` → login bằng mật khẩu mới ⇒ bị từ chối, sentinel còn nguyên. Admin unlock ⇒ login được (test `admin lock survives forgot + reset`).
- [x] Biến thể lock tạm B2.4 (`lockedUntil = now+15'`, count 5): reset ⇒ `$$REMOVE`, login được. Không hồi quy B2.4.
- [x] `$literal` với hash argon2: PHC string luôn có dạng `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`. Nếu không bọc, pipeline sẽ hiểu chuỗi này là field path ⇒ ghi `null` hoặc missing ⇒ không login được. `$literal` giữ nguyên mọi chuỗi, kể cả `$argon2i`/`$argon2d`, tham số khác, hay `$$…`. Bằng chứng end-to-end: sau unlock, login bằng `NEW_PASSWORD` thành công, chứng tỏ hash lưu đúng byte. Ngoài `setPassword` không còn pipeline nào ghi chuỗi do người dùng cung cấp.
- [x] Login khi đang bị admin lock (`authentication.service.ts:116-141`): trả `GENERIC_LOGIN_ERROR` giống sai mật khẩu, audit `invalid_credentials`, không tăng counter. `/forgot` vẫn trả thông điệp chung và vẫn gửi mail. Không có oracle về trạng thái lock (§9.12).
- [x] Rà mọi đường ghi `lockedUntil` (grep `src`):
  - `recordFailedLogin` không ghi đè lock `> now`.
  - `updateStatus` chỉ admin lock dùng.
  - `seed-dev` chỉ chạy ở dev.
  - `resetFailedLogins` có hai caller: admin unlock (đúng) và **login thành công**, xem 🟡 bên dưới.

## Security invariants / trust boundaries đã kiểm (lượt 2)
- **"Admin lock chỉ admin unlock gỡ"**:
  - Đường self-service reset: OK, atomic.
  - Đường login đồng thời: còn cửa sổ race, ghi vào DEBT-154 (🟡, cùng lớp với DEBT-141 mà tech-lead đã chấp nhận hoãn sang B7.1).
- **Thứ tự reset**: `setPassword` vẫn chạy trước `revokeAllUserCredentials` (INV-11/28). Reset trên user bị admin lock vẫn đổi mật khẩu và revoke credential, đúng mong muốn: mật khẩu có thể đã lộ.
- **Không hồi quy lượt 1**: chỉ đổi `user.service.ts`, `admin-users.controller.ts` (audit lock), int spec. `update()` bỏ tham số `unset` thừa, không còn caller nào dùng tham số này (typecheck xanh).
- **Pipeline và timestamps**: Mongoose 9 tự thêm stage `$set updatedAt` cho update dạng mảng, nên không ảnh hưởng gì. Bỏ `runValidators` ở `setPassword` cũng không sao, vì mọi field đều do server sinh.

## 🟡 Nên sửa (mới)
1. **[BE] Login đồng thời xoá admin lock** (`authentication.service.ts:112-143` + `user.service.ts:218-230`) → **DEBT-154**.
   - Diễn biến: login đọc user khi chưa bị khoá, chạy argon2 verify (khoảng chục đến vài chục ms). Trong lúc đó admin `lock` đặt sentinel và revoke. Sau đó login chạy `resetFailedLogins`, vốn `$unset lockedUntil` vô điều kiện, rồi tạo session.
   - Vì sao: DEBT-141 mới chỉ ghi nhận việc session sống sót. Ở đây admin lock **mất hẳn**: admin thấy `locked:false`, còn audit vẫn ghi `ADMIN_USER_LOCKED success`. Nó còn vô hiệu hoá luôn cách sửa đã đề xuất cho DEBT-141 (kiểm lại `lockedUntil` sau khi tạo session sẽ không còn thấy lock).
   - Không chặn run này vì cửa sổ race hẹp, attacker không điều khiển được thời điểm admin bấm lock, và cùng lớp race mà tech-lead đã chấp nhận hoãn.
   - Đề xuất: login dùng biến thể có điều kiện, filter `lockedUntil: {$ne: ADMIN_LOCKED_UNTIL}` hoặc `$cond` như `setPassword`. Nếu không khớp thì từ chối bằng thông điệp chung. Làm cùng hoặc trước DEBT-141.

## Chốt DEBT-151 (hợp đồng DELETE consent)
Chọn **204 idempotent**: consent thuộc user này và thuộc client của tenant token thì DELETE luôn trả 204, kể cả khi consent đã revoke. Mỗi lần gọi đều chạy `revokeForConsent` (idempotent) và ghi audit, kèm metadata `alreadyRevoked`. Ngoài phạm vi (user khác, tenant khác, id sai) vẫn 404 byte-identical.

Lý do không chọn family → consent → sweep mà giữ 404: bước sweep vẫn có thể lỗi sau khi consent đã stamp, và khi đó vẫn không có đường retry. Ngược lại, 204 idempotent tự sửa được bằng cách gọi lại, đúng ngữ nghĩa DELETE, và không mở oracle mới, vì phân biệt "đã revoke" với "chưa revoke" chỉ diễn ra trong phạm vi admin đã có quyền đọc (GET consents).

Không chặn run này: lỗi chỉ xảy ra khi hạ tầng hỏng giữa chừng, và admin vẫn còn `sessions/revoke` để quét family. Đã ghi hợp đồng vào backlog DEBT-151.

## Đánh giá: alert lặp khi khoá lại (hệ quả DEBT-152)
`ADMIN_USER_LOCKED` nằm trong `ALERT_ACTIONS`, nên mỗi lần gọi lock thành công (kể cả khi user đã bị khoá sẵn) đều phát một alert. **Chấp nhận được**, vì:
- Mỗi lần gọi là một thao tác control-plane thật, cần `admin.write` và step-up 5', và lần nào cũng revoke lại toàn bộ credential. Alert trên từng hành động admin đúng tinh thần §10.
- Hành vi này nhất quán với `sessions/revoke`.
- Muốn alert lặp thì phải có admin hợp lệ gọi lặp, và đó chính là điều đáng được alert.

💭 Có thể thêm `metadata.alreadyLocked: true` (dựa vào `t.user.lockedUntil` đã đọc sẵn) để downstream gộp hoặc giảm mức alert. Không cần debt riêng.

## 💭 Nit
- `user.service.ts:237`: comment nên ghi thêm rằng `resetFailedLogins` (login, unlock) *không* có bảo vệ tương tự (xem DEBT-154), để người sửa sau khỏi nhầm là mọi đường đều đã an toàn.

## ✂️ Ponytail (lượt 2, chỉ phần diff retry)
- be/src/modules/identity/user.service.ts:L275: shrink: bỏ tham số `unset` thừa của `update()`, đã làm. Tốt.
- Các mục lượt 1 (`tokenCount`, alias `ADMIN_ROLES`, `AdminFamilyView`) vẫn còn, không bắt buộc.
Lean already. Ship.
