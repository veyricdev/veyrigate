# Tech Lead Review — 2026-11-06

## Kết luận: PASS

Plan (= `tasks.md` + § Fold tech-lead) đủ để triển khai. Bốn quyết định ở `plan.md` §12 "Chốt bổ sung 2026-11-06" đúng về kỹ thuật/bảo mật, không mở lại. Điểm sửa, hợp đồng lỗi, audit, CI/docs, cách chứng minh và mutation từng nhánh nằm ở § Fold của `tasks.md` (bắt buộc).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ modular monolith. Một thay đổi hạ tầng có chủ đích: guard super_admin (DEBT-142) dùng **Mongo transaction + câu touch chung** ⇒ replica set thành yêu cầu (prod, `aegate-mongo`, `vg-test-mongo` đã là RS; CI job `int` phải đổi sang RS). Chọn transaction thay cho lease/khoá mềm vì lease có giả định thời gian (holder chậm quá hạn ⇒ hai bên cùng ghi), còn bộ đếm trên doc tenant thì lệch được khi seed/script ghi thẳng. `plan.md` §5 dòng 72 phải sửa theo.

## Điểm mạnh

- Gốc 4 debt xác minh bằng code thật: `replaceRoles` `$set` không điều kiện cho actor super + `adminLock` không xét super_admin (142); `$set: { roles }` xoá vai trò không-admin (149); `classifyMiss` chỉ revoke khi reuse (415, test `refresh-token.int-spec.ts:678` đang khẳng định hành vi cũ); callback refresh không có consent (214) trong khi `recheckCodeGrant` có.
- Probe thật trên `vg-test-mongo` (DB tự tạo/tự drop): transaction + đếm "còn lại" vẫn **write skew** (5/5 lượt hai bên cùng thắng, còn 0 super_admin); thêm `updateMany $inc` chung ⇒ 5/5 lượt đúng 1 thắng. Ca này là cơ sở cho race test và mutation M1.
- DEBT-214 không cần field/migration: `policyVersion`/`termsVersion`, `currentVersions()`, `isCovered()` đã có; dùng cùng predicate/reason với code grant.
- DEBT-415 tái dùng nhánh revoke/audit của race DEBT-216 (`resource_not_allowed`), không đổi hành vi DEBT-172/174.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Đã fold (dev phải làm đúng):
- [x] DEBT-142: transaction (snapshot, majority) + `updateMany $inc superAdminGuard` trên mọi membership super_admin active của tenant liên quan; field PHẢI khai trong schema (bẫy `strict`); index `{tenantId, roles}`; phủ cả `PATCH roles` lẫn `POST lock` (khoá = vô hiệu); "active" loại user admin-lock; 409 `conflict` mô tả cố định + audit failure `last_super_admin`; standalone/lỗi DB ⇒ 5xx fail-closed không ghi.
- [x] DEBT-149: pipeline nguyên tử `nonAdmin(roles) ++ dto.roles`; diff audit chỉ trên vai trò admin; response trả mảng sau ghi; regen `fe-admin/openapi/admin.json` + `schema.d.ts`.
- [x] DEBT-415: nhánh mới trong `classifyMiss` (doc active, chưa hết hạn, resource ∉ `identifiersFor(allowedResources)` chưa lọc admin) ⇒ revoke family + audit + `invalid_grant`; đảo test :678.
- [x] DEBT-214: callback refresh nhận `scope` của family, kiểm `isCovered` sau `subjectFailure`; fixture thiếu consent sửa fixture, không nới check.
- [x] CI `int` sang replica set; `plan.md` §5 + `spec.md` cập nhật.

## Security design gate

- **Tài sản/actor/trust boundary**: quyền super_admin (toàn hệ thống); actor = admin token có step-up 5'; target trong tenant của token (cross-tenant ⇒ 404 như cũ); refresh token của client (chỉ client sở hữu chạm được family của mình — nhánh revoke mới vẫn bind `clientId`, giá trị rác không revoke gì).
- **Invariant/state**: sau mọi commit, mỗi tenant có super_admin trước thao tác còn ≥ 1 super_admin active không admin-lock; refresh chỉ thành công khi client còn resource, user/membership hợp lệ, consent hiện hành phủ scope family.
- **Abuse/race**: giáng/khoá chéo đồng thời (r1–r3, ≥ 10 vòng); khoá cross-tenant super_admin duy nhất (s1); RT cũ sau khi thêm lại resource (không hồi sinh); RT sau bump version/thu hồi consent không qua sweep; retry RT bị từ chối không thành reuse alert.
- **Failure semantics**: transaction lỗi/standalone/hết retry ⇒ abort, 5xx, không ghi; revoke lỗi ở nhánh 415 ⇒ audit best-effort + 5xx; lỗi DB khi kiểm consent ⇒ `recheck_failed` sẵn có.
- **Exposure**: 409 mô tả cố định không id/số đếm; `superAdminGuard` không ra response (`toAdminUser` map tường minh); `invalid_grant` mờ cho mọi nhánh refresh (reason chỉ trong audit, không token/hash).

## Đề xuất (không bắt buộc)

- DEBT-482: tách reason `consent_outdated` cho nhánh lệch version.
- DEBT-483: kiểm replica set lúc boot/readiness.
- DEBT-484: chốt có revoke family `aud=admin` trên client không admin-capable hay không.
- DEBT-485: mọi đường tương lai làm mất super_admin phải đi qua guard.
