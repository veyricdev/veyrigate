# Test Report — 2026-10-16 — run 28 (B6.3b: admin users, families, consents, audit)

## Kết quả: PASS (1120/1120 test: BE unit 243 + BE int 625 + FE 240 + E2E 12)

Phạm vi: diff chưa commit kể từ `6793113` trong `be/` (Task 1 users, Task 2 families + consents, Task 3 audit query, fix `setPassword` giữ admin lock). Task 4 (keys/tenants) KHÔNG thuộc run này (→ run 29, DEBT-146).

Tester chỉ thêm test (khối `QA — risk matrix`, 8 test) vào `be/test/admin-users.int-spec.ts`. Không sửa code sản phẩm.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` (trước + sau khi thêm test) | `tsc --noEmit` EXIT 0 |
| 2 | `pnpm -C be lint` (trước + sau) | `eslint src test` EXIT 0 |
| 3 | `pnpm -C be test` | `Test Suites: 23 passed, 23 total` · `Tests: 243 passed, 243 total` |
| 4 | `pnpm -C be test:int -- --testPathPatterns admin-users` (sau khi thêm QA) | `Tests: 40 passed, 40 total` (32 dev + 8 QA), chạy 2 lần, đều xanh |
| 5 | `pnpm -C be test:int` (toàn bộ, `vg-test-mongo@27117` + `vg-test-redis@6479`) | `Test Suites: 27 passed, 27 total` · `Tests: 625 passed, 625 total` (617 trước + 8 QA). Có log `Cannot log after tests are done … [ioredis] Unhandled error event` từ `redis-fail-fast.int-spec` — nhiễu có từ trước (lớp DEBT-054), không làm fail |
| 6 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)` · `Tests 240 passed (240)` |
| 7 | `pnpm -C e2e e2e` (1 lần) | `12 passed (43.8s)`. Trước khi chạy, :5173/:4000 trống (không phải kill gì). Listener :5174 (PID 25568) có sẵn, không đụng. Sau khi chạy, :5173/:4000 đã được Playwright giải phóng |

### Mutation (sao lưu ở scratchpad → sửa bằng sed → chạy → khôi phục bằng `cp` + đối chiếu sha256, đều RESTORED)

| Mutation | Kết quả |
|---|---|
| `UserTenantService.replaceRoles` bỏ điều kiện atomic `roles: {$ne: unlessRole}` | RED 2 test: dev `roles: tenant_admin … touching a super_admin => 403` + QA `escalation race` |
| `toAdminUser` spread toàn bộ `UserView` | RED 5 test (4 dev key-set + QA `mapper: secret-bearing DB fields`) |
| `decodeAuditCursor` bỏ kiểm `t < 0` | RED 1 test: QA `audit cursor: negative / oversized …` |

Lần thử mutation đầu tiên (xoá hẳn dòng filter) gây lỗi TS6133 (biến thừa) thay vì RED, nên tôi đổi sang biến thể vẫn compile được. Lần đầu, race test cũng không RED: thứ tự dispatch luôn đưa tenant_admin chạy trước. Đã sửa test để đảo thứ tự dispatch qua từng vòng lặp, sau đó mới RED.

## Test FAIL
Không có.

## Coverage acceptance criteria

### Task 1 — users
- [x] Cross-tenant / missing / malformed id ⇒ 404 byte-identical trên mọi route: dev `cross-tenant / missing / malformed id => byte-identical 404 on every route`
- [x] Lock ⇒ login bị chặn, AT cũ 401 (`/userinfo`, `/admin/me`), refresh `invalid_grant`, audit: dev `lock (tenant_admin on a plain member)…`, `lock (super_admin on a tenant_admin)…`
- [x] Unlock ⇒ login lại được: dev `lock (super_admin …); unlock => login works again`
- [x] Admin lock không bị gỡ qua forgot/reset (fix 🔴 senior lượt 1); lock tạm B2.4 vẫn bị reset gỡ: dev `admin lock survives forgot + reset`, `a brute-force (B2.4) temporary lock is still cleared by reset`
- [x] Lỗi revoke ⇒ 5xx, lock giữ nguyên, có failure audit, retry idempotent: dev `lock: revoke fault => 5xx…`
- [x] sessions/revoke ⇒ AT 401, refresh `invalid_grant`, audit `SESSION_REVOKED scope=all`: dev `sessions/revoke => …`; QA `request chain` (cookie session cũ không còn lấy được code; replay ⇒ 204, audit count `[1,0]`)
- [x] Leo thang role ⇒ 403, DB không đổi (tenant_admin cấp super_admin cho người khác/chính mình, chạm super_admin): dev `roles: tenant_admin granting super_admin…`; QA `escalation race`
- [x] tenant_admin lock/unlock/revoke admin ở tenant bất kỳ, hoặc user active ở tenant khác ⇒ 403: dev `tenant_admin: lock/unlock/revoke an admin of ANY tenant…`
- [x] Tự lock / tự đổi role ⇒ 403: dev `self: lock / roles on yourself => 403`
- [x] Giáng tenant_admin của B ⇒ token cũ 403: dev `demoting a tenant_admin of B…`
- [x] Response không có field cấm (assert tập key): dev key-set tests; QA `mapper` (gài `mfaSecret`/`lockTransitionNonce`/`failedLoginCount`/`tokenHash` thẳng vào DB)
- [x] Lọc email khớp chính xác, status, phân trang: dev 3 test list
- [x] Step-up / scope: dev `step-up and scope…`

### Task 2 — families + consents
- [x] Revoke family ⇒ refresh cũ/mới `invalid_grant`, family khác sống, audit `TOKEN_REVOKED`: dev `revoke family => old AND rotated…`
- [x] Revoke consent ⇒ `/authorize` hỏi lại consent; refresh của đúng `user×client×resource` `invalid_grant`, resource khác sống: dev `revoke consent => /authorize shows the consent screen again…`
- [x] Family/consent của client tenant B, user khác, id sai ⇒ 404, DB không đổi: dev `revoke family of a tenant-B client…`, `revoke consent of a tenant-B client…`, `cross-tenant user…`; QA `cross-tenant 404 is byte-identical (body + content-type)`
- [x] Families không có `tokenHash` (tập key), phân trang cursor: dev `GET families…`
- [x] Mutation biến thể `revokeWhere`: dev đã chứng minh RED (log backend-dev); không chạy lại

### Task 3 — audit query
- [x] Lọc + phân trang ổn định khi có ghi mới, tie theo `eventId`: dev `newest first, stable cursor pages…`
- [x] Cross-tenant và event không có tenant không hiện: dev `tenant isolation…`
- [x] Limit trần, `?tenantId=` ⇒ 400, cursor/range/enum/độ dài: dev `bad query => 400…`; QA `audit cursor…`, `input: operator / array / encoded…`
- [x] Index tồn tại: `indexes.int-spec` (xanh trong lần int toàn bộ)
- [x] Allowlist key, không `_id`/`tenantId`: dev `response: allowlisted keys only…`

## Coverage security invariants / risk matrix (khối QA mới)

| Chiều | Trường hợp | Test |
|---|---|---|
| Identity | anonymous, token rác ⇒ 401; member thường cầm token aud=admin ⇒ 403 `{"error":"forbidden"}` trên users/:id/audit; lock bởi member thường ⇒ 403, DB không đổi | QA `identity` |
| Authorization | cross-tenant (user chỉ ở B), id không tồn tại, id sai format ⇒ cùng một bộ `status + content-type + body` cho GET families/consents, revoke family, DELETE consent; family/consent của B không bị đóng dấu | QA `cross-tenant 404 is byte-identical` |
| Authorization / State (concurrent) | tenant_admin PATCH `['tenant_admin']` chạy song song super_admin PATCH `['super_admin']`, 8 vòng, đảo thứ tự dispatch ⇒ cuối cùng luôn `['super_admin']` (không mất super_admin do TOCTOU) | QA `escalation race` (RED khi bỏ filter atomic) |
| Input | `email[$ne]`, `email` lặp (mảng), `actorId[$gt]`, `actorId` lặp, `tenantId[$ne]`, `limit` = -1 / 1.5 / abc / -5 / 0 / 101 ⇒ 400; `tenantId` trên families/consents ⇒ 400; consents `after=zzz` ⇒ 400; families `after='{"$gt":""}'` ⇒ 200, không lỗi (so sánh như chuỗi) | QA `input` |
| Input (cursor audit) | `t` âm, `e` rỗng, `e` dài 129, `e` là số, mảng, `null`, số, `t` vượt safe-int ⇒ 400; cursor quá khứ hợp lệ ⇒ 200 trang rỗng | QA `audit cursor` |
| Request chain / State (replay) | sessions/revoke ⇒ cookie session cũ tại `/authorize` không trả `code`, không redirect về RP; revoke lần 2 ⇒ 204, audit `count` `[1,0]` | QA `request chain` |
| Dependency | lỗi tiêm vào `AuditService.listForTenant`, `UserTenantService.listMembersPage` / `findMember`, `RefreshTokenService.listFamilies`, `ClientService.tenantClientIds` ⇒ 5xx (fail-closed). Không trả trang rỗng 200, không lộ message lỗi | QA `dependency failure` |
| Exposure | response user (GET một / list) không chứa giá trị hay tên field `mfaSecret`, `lockTransitionNonce`, `failedLoginCount`, `tokenHash`, `passwordHash`, `$argon2`; tập key đúng allowlist | QA `mapper` (RED khi mapper spread) |

## Ghi chú / debt
- 🟡 **DEBT-155** [BE]: cursor `after` của `GET /admin/users/:id/families` không được validate. Mọi chuỗi ≤ MAX_LEN đều được nhận (so sánh `$gt` dạng chuỗi, đã kiểm là vô hại). Trong khi đó cursor users/consents/audit sai ⇒ 400. Không chặn run này: không có injection, không lộ dữ liệu. Chỉ là thiếu nhất quán với hợp đồng phân trang.
- Race test chỉ điều khiển thứ tự dispatch, không ép được interleaving bên trong Mongo. Bằng chứng atomic chính vẫn là filter `roles:{$ne}` trong cùng một `findOneAndUpdate`, cộng với mutation RED.
- Các 🟡 đã mở trước đó vẫn giữ nguyên, không chặn: DEBT-141/154 (race lock khi login), DEBT-151 (hợp đồng DELETE consent 204), DEBT-153.
