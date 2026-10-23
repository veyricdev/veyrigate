# Log — run 48 — A6.4 Audit log (+ DEBT-339/340/341)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đã đối chiếu code `2e171cc` qua CodeGraph. Fold được ghi vào `tasks.md` gồm:

- **Phạm vi**
  - Thêm Task 0 [BE]:
    - (a) view DTO audit + `@ApiOkResponse`, cập nhật snapshot + `gen:api`;
    - (b) gắn `tenantId` cho `TOKEN_REUSE_DETECTED` (một phần DEBT-140).
  - Cắt export CSV (DEBT-342).
  - Thứ tự: Task 0 ‖ 1 → 2 → 3 → 4.
- **Q-48.1**: không có filter PII ⇒ search params + server fn GET; `AuditIdSchema` không cho `@`.
- **Q-48.2**: BE redact đủ; FE lọc metadata (chỉ primitive, denylist key secret) ở server, render text.
- **Q-48.3**: bỏ CSV.
- **Q-48.4**: reuse hiện không ai thấy (thiếu tenant) ⇒ F0(b) + ghi chú UI.
- **Ràng buộc chính**
  - Làm nổi reuse và emergency rotation bằng chữ.
  - Link chỉ qua `<Link params>` khi id hợp lệ.
  - IP/UA chỉ hiện trong chi tiết.
  - Có test XSS/email/strip âm.
  - DEBT-339 theo khuôn lock.
  - DEBT-341: `query(params)` dùng chung cho users/audit.
- **Debt mới**: DEBT-342…344.
- Chuyển: **backend-dev** (Task 0) ‖ **frontend-dev** (Task 1), sau đó frontend-dev làm Task 2–4.

## 2026-10-23 — frontend-dev — Task 1 [FE] ✅ (DEBT-339/340/341)
- DEBT-339: `user-grants.tsx` revoke family uncertain/throw ⇒ `{ done: FAMILY_UNCERTAIN }` (đóng dialog, status, focus heading). `users-risk` characterisation ⇒ 2 test mới; `users-ui` "uncertain: stays" đổi theo. RED trước fix 3/67; mutation (bỏ nhánh) ⇒ 3 RED, khôi phục sha256 byte-identical.
- DEBT-340: `fe-admin-users.spec.ts` `finally` lấy token mới (context riêng) rồi unlock, `.catch` giữ.
- DEBT-341: `pageQuery` ⇒ `query(params)` (clients/resources/users/families/consents; audit dùng ở Task 2); inline `useInvalidateUsers`; trạng thái rỗng `/users` 2 nhánh ("No users.").
- Verify: fe-admin typecheck 0 lỗi, lint sạch, test 39 files / 1020 passed, build OK, check:bundle 0 hit; e2e typecheck OK; E2E riêng `fe-admin-users.spec.ts` 1 passed (1.2m, cổng trống trước khi chạy).
- Không đụng be/, openapi, schema.d.ts. Tiếp: senior-reviewer cho Task 1 hoặc gộp review cuối run; frontend-dev Task 2 sau Task 0a.

## backend-dev — Task 0 — 2026-10-23
- (a) `admin.views.ts` +`AdminAuditEventViewDto` (5 required, 8 string optional, `metadata` object `additionalProperties` oneOf string/number/boolean nullable, `action` enum inline) + `AuditPageViewDto`; `@ApiOkResponse` trên `GET /admin/audit`; không đổi runtime. `admin.spec.ts` +1 test (key mapper ↔ schema với mọi field, required, enum, metadata, `$ref`), RED đúng lý do; mutation bỏ `reason` ⇒ RED, sha khôi phục khớp.
- Snapshot: :4000 không chạy ⇒ dựng in-process (7 controller theo `AdminModule`, guard mock, spec tạm đã xoá). Diff chỉ thêm `content` cho `/admin/audit` 200 + 2 schema ⇒ `admin.json` +139/−1; `gen:api` ⇒ `schema.d.ts` +30/−1.
- (b) Trust boundary: tenant chỉ lấy từ `client` đã xác thực (`token.controller` → Pick `tenantId` → `issueForRefresh` gộp vào `AuditCtx` khi gọi `rotate` → `classifyMiss` → record trong `revokeFamily`). Event khác không đổi (có assert TOKEN_REFRESHED không tenant). Stamp-first/family revoke và fail-closed khi ghi audit lỗi giữ nguyên.
- Test int: `refresh-token` reuse ⇒ `tenantId:'tenant-A'`; `admin-users` reuse thật qua `/token` ⇒ admin tenant A thấy 1 event (`metadata.familyId`, không key `tenantId`), admin tenant B ⇒ `[]`. RED trước fix (2). Mutation bỏ `tenantId` khỏi record ⇒ 3 RED (2 test trên + drill); sha256 khôi phục khớp.
- `runbook-drill` §2 vốn khẳng định "admin audit EMPTY" (characterisation DEBT-140) ⇒ lật thành thấy 1 event + `tenantId = DEFAULT_TENANT_ID`; cập nhật cảnh báo §2 `runbook-ops.md`; backlog DEBT-140 ghi "run 48: chỉ `TOKEN_REUSE_DETECTED` đã gắn".
- Verify: be unit 32 suites/415; `test:int` 45 suites/1211 pass; be typecheck 0, lint 0, prettier OK; fe-admin typecheck 0. Không E2E. Tiếp: frontend-dev Task 2 (snapshot sẵn sàng) → senior-reviewer.

## 2026-10-23 — frontend-dev — Task 2 → 3 → 4 [FE/E2E] ✅
- T2: `inputs.ts` `AUDIT_ACTIONS`/`AUDIT_TARGET_TYPES`/`AUDIT_RESULTS`, `AuditIdSchema` (không `@`), `AuditCursorSchema`, `AuditListInput` `.partial().strict()` + refine `from<to` (không `tenantId`); `listAudit` GET (`features/admin-api/audit.ts`), `client.ts` `query(params)`; `schemas.ts` `AuditEventSchema` (action/actorType string) + `safeMetadata` (primitive, denylist BE + `hash`; dùng `z.unknown().optional()` thay `z.record` để shape lạ ⇒ `null`, không vỡ trang). Type test 2 chiều action/result + key filter/view.
- T3: `routes/audit/index.tsx` (validateSearch catch từng field, `to` ngược bị bỏ; chỉ lấy key đã đặt tên — router giữ key lạ như `tenantId`), form lọc chặn id/khoảng thời gian trước navigate, nhãn chữ reuse/emergency/"Failure", Details `aria-expanded`/`controls` (IP/UA chỉ ở đây), link `<Link params>` khi id hợp lệ, ghi chú DEBT-140; sidebar "Audit log"; `/users/$userId` link audit.
- T4: `e2e/tests/fe-admin-audit.spec.ts` lock+unlock qua API ⇒ lọc action/targetId/from ⇒ hàng + link user + Details `count`; URL/text không email, không `eyJ`; `finally` token mới + unlock.
- Verify: fe-admin typecheck 0, lint sạch, test 41 files/1070 passed, build OK, check:bundle 0 hit, gen:api không diff thêm (vẫn +30/−1 của Task 0); root `pnpm lint` sạch; e2e typecheck OK; E2E 2 lần liên tiếp 32/32 (cổng trống trước mỗi lần; lần đầu đỏ do selector "Filter" trùng "Clear filters" ⇒ `exact`). Log E2E: 0 `eyJ`, 0 email/secret query.
- Mutation (sha256 khôi phục byte-identical): bỏ `safeMetadata` 5 RED; `@` trong `AuditIdSchema` 6 RED; bỏ nhãn reuse 1 RED; link target/client id không hợp lệ 1+1 RED; chuyển key lạ của search 1 RED; bớt/thêm action ⇒ typecheck 2/3 lỗi.
- Debt mới: DEBT-345 (link client từ target/actor). Không đụng be/. Tiếp: senior-reviewer.

## senior-reviewer — 2026-10-23
- **PASS** (0 🔴). Chạy lại: fe-admin typecheck 0; vitest audit-fn/audit-ui/users-risk/users-ui/admin-schema-types 121 passed; BE unit admin.spec + oauth/token 64 passed. Không chạy int/E2E.
- BE: `tenantId` chỉ từ `client` đã xác thực (`client.schema` required); `classifyMiss` lọc `{tokenHash, clientId}` ⇒ không gắn nhầm tenant; stamp-first/family revoke/fail-closed giữ nguyên; event khác không đổi. Đổi kỳ vọng runbook-drill §2 + runbook-ops §2 đúng (characterisation DEBT-140, hành vi đổi có chủ đích). View DTO/OpenAPI chỉ metadata.
- FE: `safeMetadata` server-side, `z.unknown()` thay `z.record` hợp lý (shape lạ không làm fail trang); `AuditIdSchema` ở validateSearch + form + input `.strict()`; đọc search key có tên; render text; link chỉ `<Link params>` khi id hợp lệ; IP/UA chỉ trong Details; DEBT-339/340/341 đúng fold.
- 🟡 ⇒ backlog: DEBT-346 (tên nút Details không phân biệt, a11y), DEBT-347 (ponytail -3: `audit.all`, prop `nextPage`). 💭 3 nit trong `review-senior.md`.
- Tiếp: **tester**.

## tester — 2026-10-23
- **PASS (FE + BE)**: fe-admin 43 files/1120 (+50 tester: `audit-fn-risk` 37, `audit-ui-risk` 11, `users-risk` +2), BE int 45/1215 (+4 tester "QA run 48" trong `admin-users.int-spec.ts`), BE unit 415, E2E 32/32 (:4000/:5173/:3000 trống trước khi chạy). fe-admin typecheck/lint/build/check:bundle (0 hit)/gen:api (sha `schema.d.ts` không đổi) xanh; root lint (sau khi prettier file test tester)/typecheck/test/audit (2 low, 1 high ignored) xanh.
- BE risk: tenant hint ở query/body/header bị bỏ qua (event `tenantId` = tenant client); client tenant B replay value của A ⇒ 0 event, family A còn sống; 4 replay đồng thời ⇒ mọi event tenant A, B thấy 0; audit reuse lỗi ⇒ ≥500 no-store, family vẫn revoked.
- FE risk: `__proto__`/`constructor`/`tenant_id` (input + URL), email mã hoá/homoglyph, key secret biến thể, metadata lồng, action/actorType lạ, actor `system` không link, Details không đổi URL; DEBT-339 nhánh throw + lỗi xác định.
- Mutation 6/6 RED (tenant từ body, bỏ tenantId, nuốt lỗi audit, bỏ `hash` denylist, bỏ nhánh throw DEBT-339, link mọi actor không phải client); sha256 khôi phục byte-identical.
- Grep log: 0 JWT, 0 secret query, email chỉ dòng seed cố định đã có từ trước.
- DEBT-346 xác nhận (giữ 🟡). Debt mới: DEBT-348 (💭 nhãn metadata trùng nhãn cố định trong Details). Chi tiết: `test-report.md`. Tiếp: orchestrator đóng run.
