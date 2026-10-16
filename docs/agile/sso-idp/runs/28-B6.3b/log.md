# Log — run 28 — B6.3b (admin API: users, refresh families, consents, audit log, keys, tenants)

## orchestrator — 2026-10-16
- Tiếp B6.3 sau run 27 (`b9370c1`). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B6 dòng 212 (phần b), spec §9.10–9.11, §10, B1.7 (audit), B1.9 (KeyProvider/JWKS), B4.5/B4.7 (families, logout global). Kéo DEBT-124 (super_admin xuyên tenant) để tech-lead quyết. Cổng → tech-lead.

## tech-lead — 2026-10-16
- Kết luận: **PASS** có fold (xem `review-techlead.md`, `tasks.md` mục "Fold tech-lead"). Phạm vi cuối là Task 1–3. **Task 4 → run 29** (DEBT-146), đi kèm DEBT-145 (mutex rotate, bắt buộc), DEBT-125, DEBT-132.
- Q-28.1: hoãn tiếp DEBT-124; super_admin là vai trò nền tảng, chỉ super_admin được cấp/thu. Q-28.2: cấm tự đổi vai trò; diff chạm super_admin thì chỉ super_admin làm. Q-28.3: LocalKeyProvider chỉ cho dev, một node; phát hiện race khi rotate (DEBT-145). Q-28.4: tách Task 4.
- Fold chính:
  - User/session là global ⇒ tenant_admin không được lock/revoke user giữ vai trò admin hoặc thuộc nhiều tenant.
  - Lock ⇒ revoke toàn bộ credential qua `revokeAllUserCredentials` (tách từ `resetPassword`).
  - Revoke consent ⇒ revoke family `{user,client,resource}` qua `revokeWhere`.
  - Families/consents lọc theo client của tenant.
  - Audit lọc theo `tenantId`, thêm index ghép và cursor `(timestamp,eventId)`.
  - Lọc email khớp chính xác.
- Debt mới: DEBT-140…146. Chuyển → **backend-dev** (Task 1 → 2 → 3).

## backend-dev — 2026-10-16
- Security gate: tài sản account/credential/consent/vai trò/audit; actor tenant_admin/super_admin; target chỉ qua `UserTenant` tenant token (404 đồng nhất, id canonical hex chống bypass tự-thao-tác bằng chữ hoa); User/lock/session global ⇒ tenant_admin 403 với admin bất kỳ tenant/active tenant khác; lock = sentinel rồi `revokeAllUserCredentials` (lỗi ⇒ giữ lock, audit failure, 5xx); family/consent lọc `clientId ∈` client tenant; fail-closed 5xx.
- Task 1: `AdminUsersController` list/get/lock/unlock/sessions-revoke/roles; `AuthenticationService.revokeAllUserCredentials` tách từ `resetPassword` (DEBT-055 giữ, test reset xanh); roles non-super có điều kiện `roles≠super_admin` trong filter atomic. Task 2: families (aggregate theo familyId) + revoke (stamp-first), consents + DELETE (404 khi đã revoke) → `RevokeFilter {userId,clientId,resource}` qua `revokeWhere`. Task 3: `GET /admin/audit` (`AdminAuditController`, cursor opaque `{t,e}` validate, `[from,to)`), index `{tenantId,timestamp:-1,eventId:-1}` + `indexes.int-spec` + runbook §1.
- Verify thật: typecheck ✓, lint ✓, unit 243/243, int 615/615 (27 suite; mới `admin-users.int-spec` 30 test), E2E 12/12.
- Mutation RED→khôi phục (sha256 OK): bỏ quy tắc target nhạy cảm, bỏ `unlessRole`, bỏ check tự đổi vai trò, bỏ chặn non-super cấp super_admin, lock revoke sai user, bỏ scope biến thể `revokeWhere` mới, `tenantClientIds` không lọc, revoke family bỏ check tenant client, audit bỏ `tenantId`, cursor `$lte`, bỏ sort eventId, bỏ index audit — tất cả RED.
- Ghi chú: `consent.service.ts` vốn có BOM + comment mojibake (không đụng). Debt mới 🟡 DEBT-147…150. Chuyển → **senior-reviewer**.

## senior-reviewer — 2026-10-16
- Kết luận: **REJECT** (1 🔴 [BE]). Chi tiết: `review-senior.md`. Đã verify: typecheck ✓, unit 243/243, int (admin-users, authentication, refresh-token, indexes) 105/105.
- 🔴 [BE] Admin lock bị gỡ qua self-service: `forgotPassword` → `resetPassword` → `setPassword` `$unset lockedUntil` vô điều kiện. User bị khoá (hoặc kẻ chiếm hộp thư) reset mật khẩu xong là login lại được, phá invariant "khoá tới khi admin unlock". Sửa: `setPassword` giữ sentinel `ADMIN_LOCKED_UNTIL`; thêm int test lock → reset → login vẫn bị từ chối, unlock → login được; kèm mutation RED.
- 🟡 → backlog DEBT-151 (consent revoke lỗi giữa chừng không retry được), DEBT-152 (lock retry không audit success), DEBT-153 (tenant_admin unlock được lock do super_admin đặt). Ponytail: -15 dòng (tokenCount thừa, alias ADMIN_ROLES, AdminFamilyView trùng).
- Đã kiểm, đạt: 404 đồng nhất cho user/family/consent; chống leo thang role bằng filter atomic; quy tắc target global; stamp-first/DEBT-055; audit query lọc tenant, không regex, cursor có validate; mapper không lộ secret; refactor resetPassword không hồi quy.
- Chuyển → **backend-dev** (retry 1: chỉ sửa 🔴).

## backend-dev (retry 1) — 2026-10-16
- Security gate: admin lock (sentinel) chỉ admin unlock gỡ; self-service forgot/reset vẫn đổi mật khẩu + revoke credential nhưng KHÔNG gỡ admin lock; thông điệp forgot/reset/login vẫn chung (không lộ trạng thái lock, §9.12). Rà đường ghi `lockedUntil`: login thành công (`resetFailedLogins`) chỉ chạy khi không bị khoá; `recordFailedLogin` không ghi đè lock `> now`; `verifyEmail` không đụng; `seed-dev` chỉ dev ⇒ chỉ `setPassword` có lỗ.
- 🔴 fix: `UserService.setPassword` thành update pipeline atomic: `lockedUntil` giữ nếu `== ADMIN_LOCKED_UNTIL`, ngược lại `$$REMOVE` (lock B2.4 vẫn được reset gỡ); `passwordHash` bọc `$literal` (hash bắt đầu bằng `$`). Hằng `ADMIN_LOCKED_UNTIL` chuyển về `identity/user.service.ts`; bỏ tham số `unset` thừa của `update`.
- DEBT-152 đóng: lock luôn audit success sau revoke thành công. DEBT-151 để mở: sửa đúng cần đổi hợp đồng "consent đã revoke ⇒ 404" (đã chốt, có test) — cần tech-lead/senior chọn 204-idempotent hay family→consent→sweep.
- Int mới: admin lock → forgot + reset → login mật khẩu mới bị từ chối, unlock → login được; lock tạm B2.4 → reset → gỡ, login được. RED trước sửa đúng nguyên nhân (lock `undefined` sau reset; thiếu audit success).
- Verify thật: typecheck ✓, lint ✓, unit 243/243, int 617/617 (27 suite, admin-users 32).
- Mutation (sao lưu + cp + sha256 OK): `$cond` luôn REMOVE ⇒ RED test admin-lock; luôn giữ ⇒ RED test B2.4; khôi phục audit có điều kiện ⇒ RED 2 test lock. Chuyển → **senior-reviewer** (lượt 2).

## senior-reviewer (lượt 2) — 2026-10-16
- Kết luận: **PASS**. Chi tiết: `review-senior.md` mục "Lượt 2". Verify: typecheck ✓, unit 243/243, int (admin-users, authentication, refresh-token, indexes, identity) 115/115.
- 🔴 lượt 1 đã đóng: `setPassword` dùng pipeline atomic giữ sentinel. Kịch bản lock → forgot → reset → login vẫn bị từ chối, unlock → login được. Lock B2.4 vẫn bị reset gỡ. `$literal` an toàn với mọi PHC argon2 (login bằng mật khẩu mới chứng minh hash lưu đúng). Login khi bị khoá trả thông điệp chung.
- 🟡 mới **DEBT-154**: login đồng thời (đọc user trước khi lock) gọi `resetFailedLogins` ⇒ `$unset lockedUntil` xoá luôn admin lock và làm hỏng hướng sửa DEBT-141. Không chặn run này (race hẹp, cùng lớp DEBT-141 đã hoãn). Làm trước hoặc cùng DEBT-141.
- **DEBT-151 chốt hợp đồng**: DELETE consent idempotent ⇒ 204 trong phạm vi tenant/user (luôn `revokeForConsent` + audit `alreadyRevoked`); ngoài phạm vi vẫn 404. Không chặn run này.
- Alert lặp khi khoá lại (DEBT-152): chấp nhận, vì mỗi lần là một thao tác admin có step-up và revoke thật. Gợi ý 💭 thêm `metadata.alreadyLocked`.
- Chuyển → **tester**.

## tester — 2026-10-16
- Kết luận: **PASS** (1120/1120). Chi tiết: `test-report.md`.
  - typecheck ✓, lint ✓
  - BE unit 243/243
  - BE int 625/625 (27 suite; `admin-users` 40 = 32 dev + 8 QA)
  - FE 240/240
  - E2E 12/12: :5173 trống, không kill process nào; :5174 có sẵn, không đụng
- Thêm khối `QA — risk matrix` (8 test) vào `be/test/admin-users.int-spec.ts`:
  - identity: anon/rác ⇒ 401, member thường ⇒ 403
  - query: injection toán tử/mảng/limit âm ⇒ 400
  - audit cursor: giá trị âm/quá dài/không phải object ⇒ 400
  - cross-tenant: 404 byte-identical (body + content-type) cho families/consents
  - mapper: gài field bí mật vào DB, response không lộ
  - request chain: sessions/revoke ⇒ cookie cũ không lấy được code; replay ⇒ 204, audit count `[1,0]`
  - race: escalation khi PATCH roles song song
  - fault injection: lỗi phụ thuộc ⇒ 5xx fail-closed
- Mutation (sao lưu + cp + sha256 OK):
  - bỏ filter atomic `unlessRole` ⇒ RED 2
  - mapper spread ⇒ RED 5
  - bỏ kiểm `t<0` của cursor ⇒ RED 1
- Không sửa code sản phẩm. 🟡 mới DEBT-155 (cursor families không validate). Chuyển → **orchestrator** đóng run.

## orchestrator — 2026-10-16 (đóng run)
- Mọi cổng PASS. Commit `c9791aa`. summary.md + Tiến độ STATUS.md; 🟡 đã ở backlog.
