# Senior Review — 2026-11-06

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Diff bám sát § Fold tech-lead, nhỏ và đúng chỗ. Bốn quyết định ở `plan.md` §12 đã được thực thi đúng ngữ nghĩa:

- **DEBT-142**: `SuperAdminGuard.runGuarded` dùng `session.withTransaction` với snapshot/majority và `maxCommitTimeMS 5000`, `endSession` đặt trong `finally`. Driver tự retry khi gặp `TransientTransactionError`/`UnknownTransactionCommitResult`; `LastSuperAdminError` không thuộc loại transient nên bị abort và ném lại. Câu touch `updateMany $inc superAdminGuard` chạy trên mọi membership super_admin active của các tenant liên quan, nằm cùng transaction và chạy trước khi đếm. Field được khai trong schema (tránh bẫy `strict`). Survivors loại target, loại user bị admin-lock (`$ne ADMIN_LOCKED_UNTIL`, cùng predicate `subjectFailure`) và loại user không còn tồn tại. Mọi write/read trong `fn` đều nhận `session`: `replaceRoles` → repo `{ session }`, `membershipsOf(.., s)`, `adminLock(.., s)`, 3 câu trong `assertSurvivors`. Audit/revoke chỉ chạy sau commit nên không có side effect lặp khi retry. Phạm vi tenant: PATCH roles dùng `[ctx.tenantId]`, lock dùng đúng các tenant mà target đang là super_admin active (đọc trong snapshot). Truy vấn không mở ra tenant nào khác, và super_admin của tenant khác không được tính là survivor (s1 chứng minh). Thứ tự 404 → self 403 → non-super 403 → 409 được giữ.
- **409/audit**: mô tả cố định, không chứa id hay số đếm, `metadata` rỗng (test có kiểm). Actor là super_admin và target đã nằm trong tenant của actor, nên câu trả lời 409 "target là super_admin cuối của một tenant khác" không cung cấp thêm gì cho một actor đã có quyền toàn hệ thống. Standalone hoặc lỗi DB ⇒ lỗi được propagate thành 5xx; transaction abort nên không ghi gì (test fail-closed có kiểm roles và audit).
- **DEBT-149**: pipeline `$filter` (giữ vai trò không-admin) `++ $literal(dto.roles)`. Không có field-path injection: input bọc `$literal` và đã qua `IsIn` + `ArrayUnique`. Diff audit và response được tính đúng (prev chỉ lấy vai trò admin; response là `kept ++ dto.roles` = DB sau ghi). Tenant filter vẫn do `scope(ctx)` ép vào query, nên không bị phá.
- **DEBT-415**: nhánh mới chỉ chạy khi doc thuộc đúng `clientId` đã xác thực, còn active, chưa hết hạn và có `resource ∉ identifiersFor(...)` (danh sách chưa lọc admin, nên DEBT-172/174 giữ nguyên). Không có oracle: response vẫn là một `invalid_grant` mờ; giá trị rác, RT của client khác hoặc RT đã hết hạn không revoke gì (có control test). Chỉ client sở hữu RT mới tới được nhánh này, và câu query thêm chỉ chạy khi doc của chính nó tồn tại. Revoke lỗi ⇒ audit best-effort rồi rethrow (fail-closed).
- **DEBT-214**: callback nhận `result.scope` (scope của family, rộng hơn hoặc bằng scope request) nên nghiêng về phía an toàn (c5 chứng minh request thu hẹp không lách được). Predicate dùng chung với code grant: `consents.find` (`revokedAt:null`) + `isCovered` so `!==` với `currentVersions()` từ config, không lấy version từ doc. Family luôn có `resource` (code grant bắt buộc `!!p.resource`), consent cũng được ghi theo đúng resource đó, nên hai khoá khớp nhau.
- **Test bị đổi**: tôi đã đọc từng chỗ và không thấy chỗ nào bị nới. admin-users (b)/(e)/T58-4 trước đây khẳng định chính lỗ DEBT-214 (refresh 200 dù consent đã bị thu hồi); nay khẳng định `invalid_grant`, còn các assert gốc (404 không đổi gì, `familyActive` trước refresh) vẫn giữ. Fixture chèn tay (matrix, public-client, admin-api) được bổ sung consent hợp lệ thay vì nới check. seed-dev QA (c) đảo theo quyết định fail-closed và kiểm chặt hơn (`revokedAt` + `familyRevokedAt`). run56 (b) dời barrier sang sau commit `runGuarded`, đúng thời điểm "đã ghi". `refresh-token.int-spec.ts:678` được đảo theo fold, có thêm control test.
- **Hai điểm orchestrator chốt ngoài fold**: (a) CI `e2e` chuyển sang RS là đúng, vì URI E2E đã có `directConnection=true`, `rs.initiate` dùng host `localhost:27017` và cả hai job đều chờ `isWritablePrimary` có giới hạn 60 s. (b) seed-dev (c): code và test khớp với quyết định fail-closed, rủi ro đã ghi ở DEBT-486.
- **OpenAPI**: chỉ đổi `description` của PATCH roles. `admin.json` và `schema.d.ts` khớp nguyên văn với `ApiOperation`.

Kiểm chứng tự chạy: `pnpm -C be typecheck` sạch; unit be 630/630; int `admin-users` + `refresh-token` + `seed-dev` 163/163 (3 suite). Không chạy lại int full/E2E: dev đã có số (1436/36) và tôi không có nghi ngờ nào cần chạy lại.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Authorization / invariant ≥ 1 super_admin**: race r1/r2/r3 qua HTTP, 10 vòng mỗi ca, kết quả đúng 1×200 + 1×409, còn đúng 1 survivor và 1 audit; ca cross-tenant s1/s2; control s3. Đã soát mọi đường làm mất super_admin hiện có: `removeMember` và `status` membership không có controller nào gọi; `users.deleteById` chỉ là rollback của federation (user vừa tạo). Như vậy hai đường đã phủ là hai đường duy nhất (khớp DEBT-485).
- **State/concurrency**: touch tạo write conflict, bên thua được retry trên snapshot mới và thấy 0 survivor ⇒ 409. Ghi grant không chạy trong transaction có thể xen vào, nhưng chỉ làm tăng số survivor (nghiêng về phía an toàn).
- **Failure behavior**: standalone, lỗi DB hoặc hết retry ⇒ 5xx, không ghi. Audit 409 lỗi ⇒ 5xx (không thành success). Revoke lỗi ở nhánh 415 ⇒ 5xx. Lỗi DB khi kiểm consent đi vào nhánh `recheck_failed` có sẵn.
- **Exposure**: `superAdminGuard` không ra response (`toAdminUser` map tường minh); 409 dùng chuỗi cố định; `invalid_grant` mờ; audit 415 chỉ có `{resource, familyId}`, không có token/hash.
- **Tenant boundary**: `findOneAndUpdate` qua `scope(ctx)`; guard chỉ query các tenant suy ra server-side.

## 🟡 Nên sửa

🟡 **Bảo mật (defense-in-depth): pipeline trong `TenantScopedRepository` chưa thật sự khoá `tenantId`**
`be/src/modules/identity/tenant-context/tenant-scoped.repository.ts:57,69` — comment nói "every stage loses `tenantId`", nhưng `withoutTenantId` chỉ lọc key `tenantId` bên trong toán tử dạng object. Ba trường hợp lọt qua: stage `{ $unset: 'tenantId' }` (giá trị là string), `{ $replaceWith: {...} }` hoặc `{ $replaceRoot: { newRoot } }` (doc mới không có `tenantId` ⇒ membership mất tenant), và `{ $project: { roles: 1 } }`.
Vì sao: repository này là lớp bảo đảm INV-24. Caller hiện tại chỉ dùng `$set` dựng server-side nên chưa khai thác được, nhưng caller tương lai sẽ tin vào comment.
Đề xuất: chỉ nhận stage `$set`/`$addFields` (ném lỗi với stage khác), hoặc nối thêm stage cuối `{ $set: { tenantId: ctx.tenantId } }`, rồi sửa comment cho khớp. → DEBT-487.

🟡 **Kiến trúc: module identity import từ DTO của admin**
`be/src/modules/identity/user-tenant.service.ts:4` — `import { ADMIN_ROLE_VALUES } from '../admin/admin.dto'`.
Vì sao: module tầng dưới (identity) phụ thuộc vào file DTO của module tầng trên (admin), và kéo theo `class-validator`/`swagger`/audit enum. Đây là mầm của import vòng khi admin.dto import ngược identity.
Đề xuất: chuyển `ADMIN_ROLE_VALUES`/`AdminRole` sang identity (vd. `identity/admin-roles.ts`), để `admin.dto.ts` re-export. → DEBT-488.

🟡 **Test: nhánh fail-closed của DEBT-415 chưa có bằng chứng**
`be/src/modules/oauth/token/refresh-token.service.ts:511-515` — khi `revokeFamily` lỗi thì audit best-effort rồi rethrow (5xx). Chưa có int test nào spy `revokeFamily` reject để kiểm 5xx + audit `resource_not_allowed` + không lộ chuỗi lỗi, và cũng chưa có mutation nào bỏ `throw err`.
Vì sao: đây là đường có thể biến lỗi DB thành `invalid_grant` thường mà family vẫn sống nếu ai đó lỡ nuốt lỗi.
Đề xuất: thêm một ca theo mẫu `(Task 0 e)`. → DEBT-489.

## 💭 Nit

- `refresh-token.service.ts:462-466` — docstring `classifyMiss` vẫn ghi "for a resource the client lost … is invalid, NOT reuse", trong khi nay nhánh đó revoke family. Nên viết lại một câu cho khớp.
- `.github/workflows/ci.yml:125,216` — vòng `until … ping` không có giới hạn: nếu container chết thì job chỉ dừng khi hết `timeout-minutes`. Nên dùng `for i in $(seq 1 60)` giống vòng chờ PRIMARY.
- `admin-users.controller.ts:345,358` — hai lần `filter` trên cùng `before.roles` (admin/không-admin); có thể gộp thành một lần partition, nhưng không đáng tách thành việc riêng.

## ✂️ Ponytail

- .github/workflows/ci.yml:L122-L131,L213-L222: shrink: hai step "Start Mongo replica set (rs0)" giống hệt nhau, chỉ khác cổng. Gom thành `be/scripts/ci-mongo-rs.sh <port>` (hoặc YAML anchor), mỗi job gọi 1 dòng.
- be/src/modules/admin/admin-users.controller.ts:L345,L358: shrink: hai `filter` ngược nhau trên `before.roles`. Dùng một vòng lặp đẩy vào `prev`/`kept`.

net: -12 lines possible.
