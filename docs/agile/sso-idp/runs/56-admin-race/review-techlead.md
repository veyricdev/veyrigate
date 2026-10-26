# Tech Lead Review — 2026-10-26 (run 56, HEAD `095a15c`)

## Kết luận: PASS (có fold ở cuối `tasks.md`)

tasks.md của orchestrator chỉ có 3 tiêu đề, chưa có thiết kế/AC; fold bổ sung đủ thiết kế, test race (barrier), mutation và cổng security nên không trả về analyst. Không tách run: 3 task, cùng lane BE, chạy theo thứ tự **3 → 2 → 1**.

Preflight: codegraph 1.6.2, `status` OK, `sync` OK (index do v1.5.0 build, chưa re-index). Code đọc qua codegraph/Git Bash: `admin-users.controller.ts` (lock/unlock/`assertMayTouchAccount`/`setRoles`), `user.service.ts` (`updateStatus`, `resetFailedLogins`, `recordFailedLogin`, `clearFailedLoginsIfUnlocked`, `setPassword`), `admin-clients.controller.ts` (`update`, `issueSecret`, `mustModify`), `client.service.ts` (`updateForTenant`, `assertMayModify`, `findByClientId`), `client-credential.service.ts` (`rotateSecret`, `revokeAll`, `revokeSecret`), `token.controller.ts` (gate trước ký, `recheckCodeGrant`, refresh recheck), `authorization-code.service.ts`, `access-token-liveness.ts`, `authorize.service.ts` (`issueCode*`, `trustedClient`), `authorize-request-context.service.ts`, `seed-dev.ts`.

## Kiến trúc đề xuất

Giữ monolith, không transaction Mongo, không index mới. Ba kỹ thuật, đều đã có tiền lệ trong repo:

1. **Điều kiện trong câu ghi** (single-doc atomic) cho lock/unlock: trường mới `users.adminLockLevel`, filter mức ở `findOneAndUpdate`, diff audit từ `returnDocument:'before'`.
2. **Ghi rồi đọc lại** (pattern DEBT-051/141) cho secret: insert → đọc lại client → tự revoke. Đúng vì phía grant đã là revoke → update → revoke.
3. **Epoch disable**: `clients.lastDisabledAt` ghi cùng câu stamp disable; code mang `issuedAt`; một hàm thuần `mintedBeforeDisable(client, t)` (biên an toàn 5 s) dùng ở gate `/token`, `recheckCodeGrant`, `isAccessTokenLive`, `trustedClient`.

## Xác minh từng debt

- **DEBT-147** — lock: **đã xong gián tiếp** từ DEBT-152 (run 28 retry), vì `lock` luôn audit success mỗi lần (`admin-users.controller.ts:175-182`). Unlock **vẫn còn lỗi**: `:202` dùng `t.user` đọc trước. Hậu quả có thật cho audit trail: (i) K unlock song song sinh K event; (ii) unlock đọc "chưa khoá", lock ghi rồi audit LOCKED, sau đó unlock xoá khoá. Kết quả là user đã mở khoá mà trail kết thúc ở LOCKED, nên điều tra sự cố sẽ sai. Người khai thác là admin hợp lệ, hoặc xảy ra tình cờ khi hai admin cùng thao tác. Đưa vào Task 2.
- **DEBT-153** — vẫn còn. Phạm vi thật hẹp vì `assertMayTouchAccount` đã cấm tenant_admin đụng tài khoản đặc quyền hoặc đa tenant. Lỗ còn lại: super_admin khoá một user thường (ví dụ khi ứng phó sự cố), tenant_admin của tenant đó mở lại. Đây là leo thang quyết định, không phải leo thang quyền. Rẻ để sửa nên đưa vào Task 2. Sentinel cũ không có mức được coi là mức super_admin (fail-closed).
- **DEBT-148** — vẫn còn, **chấp nhận và đóng**. Muốn khai thác cần hai admin thao tác trong cửa sổ cỡ ms: một bên cấp vai trò admin hoặc kích hoạt membership tenant khác, một bên lock/unlock/revoke. Hậu quả chỉ là lock hoặc revoke (về tính sẵn sàng, super_admin đảo ngược được, đã có audit), hoặc unlock một user mà actor vừa được phép unlock ngay trước đó. Không leo thang quyền. Muốn làm nguyên tử thật thì cần transaction trên hai collection (`users` + `user_tenants`) hoặc hoàn tác lock sau khi đã revoke (không đảo ngược được). Chi phí không xứng với rủi ro. Khoá do super_admin đặt thì từ Task 2 đã nằm trong filter ghi.
- **DEBT-156** — race insert family đã đóng ở run 35, race refresh ở run 36. AT của client đang disabled đã không còn live ở `/introspect`/`/userinfo`/`AdminTokenGuard` (`findByClientId` lọc `disabledAt:null`), tức **đã xong gián tiếp**. Còn hai phần: (i) AT phát trước disable **sống lại** sau khi enable, xử lý ở Task 1; (ii) resource server tự verify JWT vẫn tin AT tối đa 15 phút. Phần (ii) là bản chất của JWT stateless, chấp nhận và ghi vào spec. Đóng sau Task 1.
- **DEBT-166** — vẫn còn (`assertMayModify` chỉ đọc, `rotateSecret` không kiểm lại). Rủi ro thấp: cần step-up và phải canh đúng lúc super_admin cấp `admin`, cửa sổ cỡ ms. Hậu quả: tenant_admin biết secret của client admin-capable, làm nền cho social engineering lấy AT `aud=admin` của super_admin (DEBT-137). Sửa rẻ và đúng bằng thứ tự ghi rồi đọc. Đưa vào Task 3.
- **DEBT-209** — vẫn còn. Code không mang thời điểm mint. Hậu quả: code (≤60 s), AT (≤15 phút, qua introspect) và context authorize (≤10 phút) tạo trước disable vẫn dùng được nếu client được enable lại nhanh, đúng kịch bản "disable khẩn rồi bật lại". Đưa vào Task 1.

## Điểm mạnh

- Nhóm debt đúng chủ đề, chung bề mặt (admin users/clients, disable lifecycle), vừa một run.
- Tận dụng được các cơ chế sẵn có: `refuseGrant`/`failClosed`, `trustedClient` (DEBT-130), helper liveness dùng chung 4 nơi (DEBT-177), filter `allowedResources:$nin` (DEBT-137).

## Vấn đề (đã xử lý bằng fold, không bắt buộc analyst sửa)

- [x] tasks.md chưa có thiết kế/AC/test race/mutation → fold.
- [x] Task 3 gốc gộp DEBT-148 → tách ra: chấp nhận DEBT-148 kèm lý do; Task 3 chỉ còn DEBT-166.
- [x] Task 1 gốc lặp lại phần DEBT-156 đã đóng → thu hẹp còn "sống lại sau enable" + ghi spec phần JWT cục bộ.
- [x] Ràng buộc run 54/55: vị từ mới chỉ thêm vào gate thuần (không I/O) và recheck sau insert. Lua/peek/consume/rotate không đổi. Consent binding giữ nguyên, `trustedClient` chỉ thêm điều kiện.
- [x] Tương thích dữ liệu cũ: `adminLockLevel` thiếu với sentinel ⇒ super (fail-closed); `lastDisabledAt` thiếu ⇒ hành vi cũ; code thiếu `issuedAt` ⇒ 0 (fail-closed nếu đã từng disable). Không migration, không index.

## Đề xuất (không bắt buộc)

- `runbook-ops`: yêu cầu NTP giữa các instance (biên 5 s). Đã ghi vào Task 1.
- DEBT-416 (mới, FE): fe-admin hiển thị thông điệp riêng khi unlock bị 403 vì khoá do super_admin đặt (hiện chỉ có `forbidden` chung). Gộp với DEBT-336 (`lockKind`).
