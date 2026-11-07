# Senior Review — 2026-11-07

## Kết luận: PASS

Không còn 🔴. Có 1 🟡 (runbook q2) ghi vào `backlog.md` thành DEBT-516.

## Tổng quan (ấn tượng chung + điểm tốt)

Diff bám sát fold tech-lead và gọn. Quy tắc nằm ở một hàm thuần (`scope-policy.ts`, 15 dòng) và được dùng đúng 4 nơi. Test int dựng client/resource riêng cho từng ca và assert ở cả ba lớp (response, claim AT, doc RT trong DB), nên bắt được lỗi thật chứ không pass rỗng.

Reviewer tự chạy lại:
- Unit `scope-policy`: 4/4.
- Int `run75-resource-scopes` + `admin-api`: 73/73.

Các con số khác (unit 679, int full 1494, fe-admin 1567, E2E 37, X3 42, 9 mutation) lấy theo log của dev, reviewer không chạy lại.

Đối chiếu fold:
- **4 nơi dùng `grantableScopes`:**
  - `authorize.service.ts` `handle` (L250).
  - Chặn trên của `decideConsent` (L418).
  - `token.controller.ts` `recheckCodeGrant` (L405).
  - `refresh-token.service.ts` `issueForRefresh` (L199).
  - Discovery không đổi.
- **Thứ tự lỗi ở authorize:** `validateScope` (client) ⇒ `resolveResource` (`invalid_target`) ⇒ giao (`invalid_scope`). Lỗi đi qua `AuthorizeRedirectError` trước khi tạo context/code. Ca (a) kiểm số key Redis của ctx và code, cả đường chưa đăng nhập. `resume` đi qua `handle` (ca e).
- **`recheckCodeGrant`:** check nằm sau `resource_not_allowed` và trước `subjectFailure`, trả reason `scope_not_allowed` theo đường audit hiện có. `Resource` lấy từ `resolveForClient`, nên đúng doc thuộc allowlist.
- **Refresh:**
  - Thu hẹp chạy trong pre-check, TRƯỚC `signTokensForRefresh`.
  - `kept` đi qua tham số `successorScope` của `rotate`, được ghi vào `insertRefreshToken` và `RotationResult.scope`.
  - Recheck sau rotate nhận `kept`.
  - Các case từ chối (i)–(iii) nằm trong `unusableFamily`.
  - `refuseUngrantable`: revoke ⇒ audit ⇒ `RefreshRotationError`. Nếu revoke lỗi thì audit (best effort) rồi rethrow ⇒ 500.
  - Requested hợp lệ nhưng giao rỗng ⇒ `invalid_scope`, không rotate, không revoke (ca r6).
- **Guard resource `admin`:** đọc bằng `findByResourceId`, so `identifier` với `adminResourceIdentifier(issuer)`, trả 400 không ghi audit. `updateScopes` lọc theo `{resourceId, identifier}`.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Authorization / leo thang scope:** giao `client ∩ (OIDC ∪ resource)` không thể rộng hơn từng vế. Ca (d) kiểm cả hai chiều (resource có mà client không có, và ngược lại).
  - Refresh: `requested ⊆ original.scope` được kiểm TRƯỚC khi lấy giao với `narrowed`, nên body `scope=` không mở rộng được.
  - Successor lưu `kept`, nên thêm lại scope không làm quyền sống lại (r1 lần 2).
- **Confused deputy / cross-client:**
  - Pre-check refresh vẫn ràng buộc `clientId`, `revokedAt:null`, `expiresAt`, `resource ∈ allowedIdentifiers`. Vì vậy `refuseUngrantable` chỉ chạy được trên RT active của đúng client: client B không dùng RT của A để kích revoke family của A.
  - `findByIdentifier(original.resource)`: `identifier` có unique index và `original.resource` đã nằm trong allowlist, nên không lấy nhầm resource.
- **State / concurrency:**
  - Nhánh refuse không rotate, nên doc revoke có `replacedBy:null`. Replay chỉ ra `invalid_grant` thường, không bắn reuse giả (r3 và r7 assert 0 `TOKEN_REUSE_DETECTED`).
  - Hai refresh đồng thời: một bên rotate, bên kia refuse ⇒ family bị revoke toàn bộ. Kết quả fail closed, chấp nhận được.
  - Race "admin thu hẹp giữa pre-check và rotate" giới hạn bởi TTL AT 15', đúng như đã chấp nhận và ghi ở spec §7.
- **Guard admin, thử các đường bypass:**
  - Không có route PUT hay DELETE cho resource, và POST bị chặn trùng `identifier` bằng unique index.
  - `resourceId` trên route so khớp chính xác. Sai hoa/thường ⇒ 404 hoặc trúng doc khác. Doc khác cùng `resourceId` (DEBT-077) được ghi đúng doc đã kiểm nhờ lọc thêm `identifier`, nên không ghi xuyên sang doc `admin`.
  - Scope có khoảng trắng (`" admin.read"`) không khớp `includes` ⇒ bị từ chối, an toàn.
  - Guard kiểm GIÁ TRỊ MỚI và `$set` thay toàn bộ, nên hai PATCH đồng thời không vượt guard.
  - So `identifier` với `new URL('/admin/', issuer).href`, cùng hàm mà `TokenService.adminResource` dùng.
- **Failure behavior:**
  - Revoke lỗi ⇒ 500 có audit, không phát token (r7).
  - Đọc `findByIdentifier` lỗi ⇒ exception ⇒ 500, không rotate (fail closed).
  - Resource null (đã bị xoá) ⇒ không thu hẹp, để rotate/classify xử lý như trước (filter `allowedIdentifiers`).
- **Exposure:**
  - Body OAuth opaque. r7 assert chuỗi lỗi nội bộ không lọt ra body.
  - Audit refuse chỉ chứa `{resource, familyId}`. Test assert RT không có trong audit.
  - `error_description` ở authorize liệt kê scope bị từ chối cho chính RP đã xin. Đây là mẫu sẵn có (`Scope not allowed for this client`), không tạo enumeration oracle mới đáng kể.
- **Fixture:** không có check nào bị nới.
  - Resource `admin` được thêm `admin.read/write`, khớp seed thật.
  - Client fixture được thêm `scopes`. Trước đây code grant không so `Client.scopes`; giờ có, nên fixture phải khai đúng.
  - Demo resource thêm `admin.read` chỉ để giữ vai control (ca rủi ro vẫn trả `invalid_target` trước bước kiểm scope).

## 🟡 Nên sửa

- [ ] `runbook-deploy.md` §12 q2: tính `$setUnion` scope của MỌI `allowedResources` rồi mới `$setDifference`, nên báo thiếu.
  - Ví dụ: client có `allowedResources [A, B]` và scope `x` chỉ nằm ở A. q2 coi `x` hợp lệ, nhưng `/authorize?resource=B&scope=x` sau deploy sẽ ra `invalid_scope`.
  - Vì sao: runbook là cổng "kiểm trước deploy"; báo thiếu thì RP bất ngờ gãy.
  - Đề xuất: `$unwind: '$res'` rồi `$setDifference` theo từng cặp (client, resource). Với client không có resource nào, giữ một dòng `res: null` (`preserveNullAndEmptyArrays`).
  - Lưu ý: chỉ RP xin đúng tổ hợp đó mới bị ảnh hưởng, nên nên sửa trước deploy production, không chặn run. ⇒ DEBT-516.

## 💭 Nit

- `admin-resources.controller.ts:128` tự tính `adminResourceIdentifier(config issuer)` mỗi request, trong khi `TokenService.adminResource` đã có sẵn. Log giải thích lý do: mocker của `admin.spec.ts` không có `getOrThrow`. Chấp nhận được; có thể inject `TokenService` sau.
- Int run75 in stack trace `mongo down secret-detail` từ logger trong ca r7. Đây là log chủ đích, không phải lỗi. Lần chạy có cảnh báo "Jest did not exit" do `--runInBand` cùng `admin-api`; reviewer không xác minh đây là hồi quy của run này.

## ✂️ Ponytail

Lean already. Ship.
