# Log — run 31 — admin-hardening (DEBT-173/174/175/176/167/170)

## orchestrator — 2026-10-19
- Sau run 30, dọn nhóm debt bảo mật admin còn mở trước khi sang M6 (B5). Tự sinh `tasks.md` từ backlog (DEBT-173, 174, 175, 176, 167, 170). Cổng → tech-lead.

## tech-lead — 2026-10-19
- PASS kèm fold (tasks.md "Fold tech-lead"). Q-31.1: chặn ở `AdminTokenGuard` dùng `seen.client` sẵn có (0 query thêm). Q-31.2: seed `createIndexes()` mọi model trước ghi, không `syncAllIndexes`.
- Task 1: predicate allowlist (confidential + basic|post), 5 chốt, guard 401. Task 2: seed không re-point `admin` (`$setOnInsert`, bỏ ngoại lệ fe-admin) ⇒ đóng DEBT-173(1)(2) bằng cấu trúc. Task 3: 400 khi `disabled:true` kèm field khác (DEBT-167); lỗi mang `secretsRevoked` + audit `admin_grant_aborted` (DEBT-170).
- Mở DEBT-177 (introspect/userinfo). Cổng → backend-dev.

## backend-dev — 2026-10-19
- Security gate: tài sản = token `aud=admin`; invariant "chỉ client confidential + secret method giữ/dùng aud=admin" kiểm ở 4 điểm phát hành + guard theo DB hiện tại (fail-closed khi thiếu field); abuse = AT cũ sau khi client lệch, race seed∥API, PATCH 409 sau ghi; lỗi DB sau revoke ⇒ secret đã thu hồi + audit best-effort rồi 404/5xx; audit chỉ count/reason; lỗi index seed không echo giá trị trùng (PII).
- Task 1 ✅ `isAdminCapableClient` (allowlist) + `adminTargetForbidden(client,…)` ở /authorize, consent, /token, refresh, `AdminTokenGuard` (401, `seen.client: Client`); `adminAud` 1 lần. Fixture sửa: guard unit spec, `refresh-token.int-spec` (thêm type/method). Int `admin-public-client` × `{public,none}`/`{confidential,none}` + test guard AT cũ (control basic/post 200). Mutation 6/6 RED (5 chốt + predicate chỉ clientType).
- Task 3 ✅ 400 `disable must be sent alone` (controller); `AdminGrantAbortedError{secretsRevoked,cause?}`, `AdminGrantSecretRevokeError.secretsRevoked`; controller audit `CLIENT_SECRET_REVOKED{admin_grant_aborted|admin_granted,count}` + `ADMIN_CLIENT_UPDATED failure` + `.catch`, 404 opaque/5xx gốc. Bỏ `concurrent_update`. Mutation 4/4 RED.
- Task 2 ✅ seed `createIndexes()` mọi MODELS trước ghi; `admin` `$setOnInsert`; identifier khác ⇒ throw (không ngoại lệ fe-admin), bỏ `isAdminIdentifierShape`. Sửa test ISSUER change (seed.int + seed-risk) ⇒ refused. Mutation: bỏ guard ⇒ 6 RED; `$set` ⇒ RED (scopes reset); bỏ `createIndexes` ⇒ RED tất định ở test email trùng, race 0/10 vòng (yếu ⇒ DEBT-178). README cập nhật.
- Verify cuối: typecheck ✓, lint ✓, unit 271/271, int 719/719 (33 suites), E2E 12/12. Khôi phục mutation bằng cp + sha256 OK. Không chạy seed trên DB dev.
- Đóng DEBT-167/170/173/174/175/176; mở DEBT-178. Cổng → senior-reviewer.

## senior-reviewer — 2026-10-19
- **PASS**, không 🔴. Tự chạy: typecheck ✓, unit 271/271, int 8 suite liên quan 176/176 (admin-public-client, admin-api, seed*, refresh-token, admin-target-risk).
- Đã kiểm: 5 chốt `aud=admin` (chỉ có grant code + refresh), refresh lọc admin trước tra token ⇒ `invalid_grant` không burn/không reuse; guard 401 cùng mã (không oracle); seed `$setOnInsert` + guard + post-check (không re-point), lỗi `createIndexes` không echo giá trị trùng; audit abort chỉ count/reason, trả lỗi gốc; `disabled:true` đi một mình trước mọi ghi.
- 🟡 mở DEBT-179 (điểm ghi `assertAdminCapableType` chỉ kiểm `clientType` — định nghĩa thứ hai), DEBT-180 (thông điệp lỗi `createIndexes` dẫn sai với lỗi không phải trùng). DEBT-178: đề xuất assert `listIndexes` sau seed (RED tất định) thay vì race. Cổng → tester.

## tester — 2026-10-19
- **PASS**. BE typecheck ✓, lint ✓, unit 271/271, int 730/730 (34 suite), FE 240/240, E2E 12/12 (1 lần, cổng trống, không phải dừng process nào). Xem `test-report.md`.
- Test mới: `be/test/admin-capable-matrix.int-spec.ts` (10 test — 9 shape × `/authorize`/code/refresh/guard qua HTTP, refresh lệch không sinh `TOKEN_REUSE_DETECTED`, reuse thật vẫn báo động sau drift); `seed-risk` +1 test DEBT-178 (`listIndexes` sau seed trên DB `autoIndex:false`).
- Repro DEBT-178 bằng 2 tiến trình `seed.js` build ra scratchpad (cwd trống, env tường minh, DB `vg-int-seedcli-*` tự drop): bản thật 0/30 vòng nhân đôi, mutant bỏ `createIndexes` 5/10. Mutation M1 (bỏ `createIndexes`) RED 3/3; M2/M3/M4 (predicate chỉ type / chỉ method / bỏ nhánh guard) RED 3/2/7. Khôi phục `cp` + `sha256sum -c` OK.
- Đóng DEBT-178; mở DEBT-181. Cổng → orchestrator đóng run.

## orchestrator — 2026-10-19 (đóng run)
- Mọi cổng PASS. Commit `a299314`.
