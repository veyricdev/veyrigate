# Run 76 — chống tự khoá client console fe-admin + gộp ADMIN_ROLES (M7, lane BE)

Nguồn: backlog DEBT-515 (run 75 tech-lead), DEBT-513 (run 74 tech-lead). Analyst bỏ qua (việc từ backlog). Quyết định sản phẩm: người dùng ủy quyền orchestrator chốt theo tiêu chí production (`plan.md` §12).

## Task 1 [BE] DEBT-515 — guard client console
- [x] Xong (backend-dev 2026-11-07, xem log.md)
- Bối cảnh: run 75 chặn PATCH resource `admin` bỏ `admin.read`/`admin.write`. Còn đường khác khoá fe-admin: PATCH client BFF console (client fe-admin dùng để đăng nhập) gỡ `admin.read`/`admin.write` khỏi `Client.scopes`, gỡ resource `admin` khỏi `allowedResources`, gỡ grant/redirect cần thiết, hoặc disable/xoá client đó.
- Tech-lead xác định: cách nhận diện client console (config/env hiện có? `ADMIN_*`/`FE_ADMIN_CLIENT_ID`?), các route ghi client (`admin-clients.controller.ts`, `ClientService.updateForTenant`, disable, delete, rotate secret?) và phạm vi chặn hợp lý (tối thiểu: scopes `admin.*`, resource `admin` trong allowedResources, disable/delete).
- Hành vi: thao tác làm client console mất khả năng đăng nhập fe-admin ⇒ 400 `invalid_request` (hoặc 409 nếu tech-lead thấy hợp hơn — chốt trong fold), thông điệp cố định, không ghi DB, không audit thay đổi.
- AC: int-test cho từng đường bị chặn + ca điều khiển (client khác vẫn sửa được; client console sửa trường vô hại vẫn được); mutation bỏ guard ⇒ RED.

## Task 2 [BE] DEBT-513 — gộp ADMIN_ROLES
- [x] Xong (backend-dev 2026-11-07, xem log.md)
- `tenant-context.ts:107` và `admin-users.controller.ts:63` dùng `identity/admin-roles.ts` (`ADMIN_ROLE_VALUES`). Không đổi hành vi; typecheck/unit/int xanh.

## Task 3 [docs]
- [x] Xong (backend-dev 2026-11-07, xem log.md)
- spec/security-matrix: ghi quy tắc chống tự khoá client console; backlog đóng DEBT-513/515.

## Gate
typecheck/lint, unit be, int full (`vg-int-*` không tăng), fe-admin test (nếu FE hiển thị lỗi mới thì thêm test), E2E 37, X3 42 — tuần tự.

## Fold tech-lead (2026-11-07) — BẮT BUỘC, thay các mục tương ứng ở Task 1–3

### F0. Hiện trạng đã kiểm (codegraph)
- BE KHÔNG có cấu hình "client console": `FE_ADMIN_CLIENT_ID = 'fe-admin'` chỉ nằm trong `be/src/database/seed.ts:43` (seed dev, cấm production). Client console = **client đã phát hành admin token của request**: `AdminActor.clientId` (`tenant-context.ts:222`, lấy từ `claims.client_id` ở `tenant-context.ts:206`). Đã có tiền lệ: `admin-clients.controller.ts:159-162` chặn tự disable ⇒ 409 `conflict` "cannot disable the client issuing this admin token" (test `be/test/admin-api.int-spec.ts:787`, chạy TRƯỚC 403 tenant_admin). **Không thêm env/config mới**: clientId của console ở production tuỳ deploy; so với token thì chính xác và không cần cấu hình.
- Đường ghi client: chỉ `PATCH /admin/clients/:clientId` (`admin-clients.controller.ts:137-271` → `ClientService.updateForTenant` `client.service.ts:286`), `POST /:clientId/secrets` (rotate, có grace ⇒ không khoá ngay), `DELETE /:clientId/secrets/:version`. **Không có route xoá client.** `POST /admin/clients` không đụng client có sẵn.
- Trường PATCH làm console mất đăng nhập/gọi API:
  - `scopes`: `/authorize` từ chối mọi scope xin mà client không có (`authorize.service.ts:532-546` ⇒ `invalid_scope`); BFF xin cố định `openid email offline_access admin.read admin.write` (`fe-admin/src/server/auth/bff.ts:40`); mất `admin.read`/`admin.write` thì guard trả 403 `insufficient_scope`.
  - `allowedResources` mất resource `admin`: liveness (`isAccessTokenLive`) giết token ngay ⇒ 401, và `/authorize resource=admin` ⇒ `invalid_target`.
  - `grantTypes` mất `authorization_code` (`token.controller.ts:167`) ⇒ không đăng nhập được; mất `refresh_token` (`token.controller.ts:429`, `token.service.ts:175`) ⇒ BFF không refresh được.
  - `disabled:true`: đã chặn (409).
  - `redirectUris`/`postLogoutRedirectUris`, `DELETE` secret version BFF đang dùng: CÓ thể khoá, nhưng BE không biết URI/version nào console dùng ⇒ **ngoài phạm vi run 76**, ghi DEBT-517 (F5).
  - `allowedCorsOrigins`, `frontchannelLogoutUri`: không ảnh hưởng (BFF gọi server-side).

### F1. Task 1 — thay mục "Hành vi"
Chỉ áp khi `clientId === actor.clientId` (so khớp chính xác chuỗi). Chỉ kiểm body + token + id resource `admin` (bất biến) ⇒ không đọc trạng thái client hiện tại:
1. `dto.scopes !== undefined` và thiếu bất kỳ scope nào trong `scope` của admin token đang dùng ⇒ 409 `conflict`, `error_description` cố định: `The client issuing this admin token must keep every scope of this token.`
2. `dto.allowedResources !== undefined` và thiếu `resourceId` của resource `admin` ⇒ 409 `conflict`: `The client issuing this admin token must keep the admin resource.` Lấy id bằng `ClientService.adminResourceIds()` (đổi `private` → public, `client.service.ts:405`); chỉ gọi khi có `dto.allowedResources` và đúng client của actor. Kết quả `[]` (không thể xảy ra khi token đã qua guard) ⇒ ném `Error` (5xx, fail-closed), không ghi. Lỗi DB khi tra ⇒ 5xx, không ghi.
3. `dto.grantTypes !== undefined` và (thiếu `authorization_code`, hoặc thiếu `refresh_token` trong khi scope token có `offline_access`) ⇒ 409 `conflict`: `The client issuing this admin token must keep the grant types it signs in with.`
- Thứ tự kiểm cố định 1 → 2 → 3, lỗi đầu tiên thắng. Thông điệp KHÔNG chứa giá trị nào từ input/token.
- **Mã lỗi: 409 `conflict`** (không phải 400): đồng nhất với guard tự disable cùng handler và tài liệu `AdminAuthError.conflict` ("self-lock", `admin-auth.errors.ts:49-50`). Guard resource `admin` run 75 giữ 400 (ràng buộc trên chính resource, không phải self-lock theo token), không đổi.
- Vị trí: `admin-clients.controller.ts` ngay sau khối `:159-162` (trước `const base` `:163`), gom thành 1 hàm private `assertKeepsOwnAccess(clientId, dto, actor)`; giữ nguyên văn khối disable 409 hiện có. Như tiền lệ disable, guard chạy TRƯỚC `updateForTenant` ⇒ trước 403 tenant_admin, trước nhánh grant `admin` (không revoke secret pass 1), không ghi DB.
- **Audit: không** (đồng nhất 409 tự disable và 400 validate; không có thay đổi nào).
- `AdminActor` thêm `scopes: readonly string[]`: `AdminPrincipal` (`tenant-context.ts:55`) thêm `scopes`, gán `Object.freeze(claims.scope.split(' ').filter(Boolean))` ở `:203-207`, trả trong `CurrentAdmin` (`:231`). `ClientWriteActor` (`client.service.ts:88`) KHÔNG đổi.
- **Race**: quy tắc chỉ phụ thuộc body (PATCH thay mảng nguyên khối), token của chính request và id resource `admin` (bất biến) ⇒ với hai PATCH đồng thời lên client console, mỗi PATCH được chấp nhận đều tự thoả bất biến, nên bản ghi cuối luôn thoả. Không cần filter điều kiện hay transaction.
- Ngoài phạm vi có chủ ý: admin dùng client admin-capable B sửa client console A ⇒ được phép. Đây không phải tự khoá, vẫn còn đường khôi phục qua B, và chỉ super_admin ghi được client admin-capable.

### F2. Task 1 — thay mục "AC"
Int trong `be/test/admin-api.int-spec.ts`, token `tok(superA, { client: BFF_A, scope: ... })`; BFF_A có `admin` trong `allowedResources` và đủ scope/grant như fixture hiện có (bổ sung fixture nếu thiếu).
- (s1) scope token `openid offline_access admin.read admin.write`; PATCH BFF_A `scopes` bỏ `admin.write` ⇒ 409 + thông điệp 1; (s2) bỏ `openid` ⇒ 409 (scope OIDC cũng được giữ); (s3) bỏ `offline_access` ⇒ 409.
- (r1) PATCH BFF_A `allowedResources: ['api']` ⇒ 409 + thông điệp 2, assert credential của BFF_A không bị revoke; (r2) `allowedResources: []` ⇒ 409.
- (g1) `grantTypes: ['refresh_token']` ⇒ 409 + thông điệp 3; (g2) token có `offline_access`, `grantTypes: ['authorization_code']` ⇒ 409; (g3) token KHÔNG có `offline_access`, `grantTypes: ['authorization_code']` ⇒ 200.
- Mỗi ca 409: re-read DB client BFF_A bằng model, mọi trường không đổi; không có audit `ADMIN_CLIENT_UPDATED` mới cho BFF_A; body đúng `{ error: 'conflict', error_description: <cố định> }`.
- Ca điều khiển: (c1) BFF_A thêm scope mới / bỏ một scope không có trong token (vd `profile`) ⇒ 200; (c2) BFF_A `allowedResources: [<admin>, 'api']` ⇒ 200; (c3) BFF_A sửa `redirectUris`/`allowedCorsOrigins` ⇒ 200; (c4) super_admin token từ BFF_A PATCH một client admin-capable khác (BFF_B cùng tenant hoặc client tạo mới có `admin`) bỏ `admin.*`, resource `admin`, `authorization_code` ⇒ 200.
- (t1) tenant_admin token từ BFF_A gửi body khoá ⇒ 409 (thứ tự như tiền lệ disable); body vô hại ⇒ 403 như cũ.
- (race) `Promise.all` hai PATCH lên BFF_A: một hợp lệ (thêm scope), một khoá (bỏ `admin.write`) ⇒ 200 + 409, DB cuối chứa đủ scope của token.
- Test tự disable hiện có (`admin-api.int-spec.ts:787`) giữ xanh.
- Unit (spec controller/admin hiện có): hàm guard với 3 nhánh + nhánh `adminResourceIds()` trả `[]` ⇒ throw.
- Mutation (ghi kết quả vào log.md, revert): M1 bỏ check scopes ⇒ (s1)–(s3) RED; M2 bỏ check allowedResources ⇒ (r1)(r2) RED; M3 bỏ check grantTypes ⇒ (g1)(g2) RED; M4 đổi `clientId === actor.clientId` thành `true` ⇒ (c4) RED; M5 bỏ điều kiện `offline_access` ⇒ (g3) RED; M6 dời guard sau `updateForTenant` ⇒ assert "DB không đổi" RED.

### F3. Task 2 — thay nội dung
- `tenant-context.ts:107`: `const ADMIN_ROLES: readonly string[] = ADMIN_ROLE_VALUES;` với `import { ADMIN_ROLE_VALUES } from '../admin-roles';` (bỏ literal). Thứ tự hằng không ảnh hưởng (`includes` lọc theo thứ tự roles của membership).
- `admin-users.controller.ts:46/63`: import `ADMIN_ROLE_VALUES` trực tiếp từ `../identity/admin-roles` (không qua re-export `admin.dto.ts:220`); giữ alias `ADMIN_ROLES` ở `:63`. Không đổi hành vi; typecheck, unit, int xanh. `identity/admin-roles.ts` không import gì nên không sinh import vòng.

### F4. Task 3 — docs cụ thể
- `spec.md` §7 (sau quy tắc 5, dòng 164): quy tắc 6 "Chống tự khoá client console". Client phát hành admin token của request không được (a) disable (409, có từ B6.3a), (b) bỏ scope nào của token, (c) bỏ resource `admin`, (d) bỏ `authorization_code`, hoặc bỏ `refresh_token` khi token có `offline_access`. Vi phạm ⇒ 409 `conflict`, thông điệp cố định, DB không đổi, không audit. Sửa từ client admin-capable khác thì được. Redirect URI và secret version không được chặn (DEBT-517).
- `security-matrix.md`: thêm dòng mới (hoặc bổ sung cột test cạnh guard admin của run 75), liệt kê tên các it (s1–s3, r1–r2, g1–g3, c1–c4, t1, race) và "mutation M1–M6 ⇒ RED (log run 76)".
- `runbook-ops.md`: mục ngắn "khôi phục console bị khoá": dùng client admin-capable khác, hoặc sửa trực tiếp collection `clients` có kiểm soát (chỉ cần khi gặp ca DEBT-517).
- `backlog.md`: đóng DEBT-513/515.

### F5. Gate (bổ sung)
- Không có Task FE: fe-admin đã map `409 conflict` sang `AdminApiError("conflict", description)` (`fe-admin/src/server/admin-api/client.ts:178`) và hiển thị `error.message`, giống 409 tự disable. Không đổi DTO/response ⇒ không đổi OpenAPI snapshot. fe-admin test chỉ chạy để xác nhận không vỡ.
- E2E/X3 không PATCH client `fe-admin` (đã grep `e2e/`) ⇒ kỳ vọng 37/42 giữ nguyên.
- Debt mới: DEBT-517 (redirect URI / secret version của console chưa được guard).
