# Senior Review — 2026-11-07

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Diff nhỏ, khớp fold F0–F5 gần như từng dòng. `assertKeepsOwnAccess` là hàm thuần `(dto, tokenScopes, adminResourceIds thunk)`, đúng gợi ý của tech-lead: unit test không cần Nest, và lookup resource chỉ chạy khi body có `allowedResources`. Guard đặt sau khối 409 tự disable và trước `updateForTenant`, nên không ghi DB, không audit, không chạy pass revoke secret của nhánh grant `admin`, và đứng trước 403 tenant_admin, giống tiền lệ. Ba thông điệp là literal cố định, test so `toEqual` chính xác nên không thể echo input. Test int có assert mạnh: mỗi ca 409 re-read toàn bộ document BFF_A (`toEqual(snap)`) và đếm audit `ADMIN_CLIENT_UPDATED`, nên M6 (dời guard ra sau ghi) bắt được thật. `afterEach replaceOne(snap)` giữ suite cũ ổn định kể cả khi mutation lọt. DEBT-513 đúng một dòng mỗi file, không có import vòng (`identity/admin-roles.ts` không import gì).

Đã chạy lại: `pnpm test -- src/modules/admin/admin[.]spec[.]ts` 35/35; `pnpm test:int -- admin-api` 12 suite, 335/335 (gồm describe run 76 và ca tự disable `:787`).

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Identity / nguồn `actor.clientId`**: lấy từ `claims.client_id` của access token đã verify chữ ký, đúng `aud=admin`, có `sid`, qua liveness (`isAccessTokenLive` nạp chính client đó bằng `findByClientId(claims.client_id)`) và `isAdminCapableClient`. Token do client khác phát hành thì mang `client_id` khác, nên chỉ rơi vào nhánh "sửa từ client admin-capable khác". Spec ghi rõ đây là ngoài phạm vi có chủ ý, vẫn còn đường khôi phục, và chỉ super_admin ghi được client admin-capable.
- **Hoa/thường của clientId**: không có collation nào trong `be/src` (đã grep), nên lookup Mongo phân biệt hoa thường. `/admin/clients/FE-ADMIN` không trúng document `fe-admin` ⇒ 404, không ghi. Path param đã được Nest decode trước khi so, nên `%2D` không lách được. So sánh `===` chính xác là đủ.
- **Scope trong token rỗng hoặc khác format**: `scopes = claim.split(' ').filter(Boolean)`. Token rỗng scope không qua được guard route (`admin.write` bắt buộc ở `tenant-context.ts:196`). Phần tử rỗng do thừa khoảng trắng bị lọc. Scope so phân biệt hoa thường (đúng RFC 6749 §3.3): body `ADMIN.WRITE` không thay được `admin.write` ⇒ 409.
- **PATCH thiếu field hoặc `null`**: field vắng ⇒ `undefined` ⇒ bỏ qua nhánh tương ứng, và service cũng không `$set` field đó (`PATCHABLE_ARRAYS`, `!== undefined`), nên không có trạng thái nào lách được. `IfPresent` = `ValidateIf(v !== undefined)`, vì vậy `null` vẫn bị `@IsArray` chặn ở 400 trước khi tới handler. Không có đường `null.includes` gây 500, và cũng không có `$set: {scopes: null}`. Body rỗng ⇒ 400 `empty update` như cũ.
- **Thứ tự**: empty ⇒ 400; disable kèm field khác ⇒ 400; tự disable ⇒ 409; guard run 76 ⇒ 409; sau đó tới `updateForTenant` (403 tenant_admin, nhánh grant/revoke). Test t1 khoá thứ tự 409 trước 403.
- **State/race**: quy tắc chỉ phụ thuộc body (mảng thay nguyên khối), token của request và `resourceId` của resource `admin` (chỉ `scopes` của resource PATCH được). Mỗi PATCH được chấp nhận tự thoả bất biến, nên bản ghi cuối luôn thoả, không cần filter điều kiện. Ca race chỉ là kiểm hồi quy (guard thuần nên kết quả tất định), không phải bằng chứng về concurrency, và điều đó chấp nhận được.
- **Failure behaviour**: `adminResourceIds()` lỗi DB hoặc thiếu wiring ⇒ throw ⇒ 5xx, không ghi DB. `[]` ⇒ `Error` thường ⇒ `OAuthExceptionFilter` trả `server_error` với description chung, không lộ message nội bộ. Fail closed và hợp lý: trạng thái này không thể xảy ra khi một admin token vừa qua liveness, nên 5xx kèm error log là tín hiệu ops đúng. Nếu đổi thành 409 thì bất thường hạ tầng sẽ bị che thành lỗi nghiệp vụ.
- **Exposure**: 3 thông điệp cố định, không chứa clientId, scope hay resourceId. Không ghi audit cho ca bị từ chối, đồng nhất với 409 tự disable và 400 validate. `AdminActor.scopes` chỉ dùng trong handler, không vào response hay log.
- **Ngoài phạm vi đã ghi nợ**: redirect URI / post-logout URI, `DELETE` secret version đang dùng ⇒ DEBT-517 (💭, tech-lead), runbook-ops §7 có đường khôi phục.

## 🟡 Nên sửa

(không có)

## 💭 Nit

- 💭 `be/test/admin-api.int-spec.ts` (c2): chỉ assert `200`, không đọc lại `allowedResources`. Thêm `expect((await readA())?.allowedResources).toEqual(['admin', 'api'])` thì ca này tự chứng minh được là đã ghi thật (c1, c3, g3 đều có).
- 💭 `be/test/admin-api.int-spec.ts` (race): vì guard thuần nên ca này luôn tất định; tên "race" dễ khiến người đọc nghĩ có kiểm concurrency DB. Comment một dòng "regression: guard is body-only, so order cannot matter" sẽ rõ hơn.
- 💭 `runbook-ops.md` §7 Cách 2: snippet `$set` trực tiếp đi vòng qua `validateConfig` (định dạng redirect URI, scope token). Nên nhắc người vận hành chép đúng giá trị từ cấu hình BFF hoặc từ bản backup, không tự gõ.
- 💭 Guard dựa vào giả định "scope trong token = tập scope BFF xin". Giả định này đúng vì `/authorize` từ chối scope ngoài client (`invalid_scope`) và run 75 không bỏ bớt scope ngầm ở bước authorize. Nếu sau này có cơ chế consent từng phần hoặc thu hẹp ngầm, client console có thể bỏ một scope mà BFF vẫn xin. Khi đó cần xem lại quy tắc 6.

## ✂️ Ponytail

Lean already. Ship.

(Nhánh `ids.length === 0 ⇒ Error` có thể gộp vào `ids.some` ⇒ 409, nhưng fold F1.2 chốt 5xx fail-closed, và như đã phân tích ở trên đó là lựa chọn đúng nên giữ. Alias `ADMIN_ROLES: readonly string[]` cần cho kiểu `includes(string)`.)
