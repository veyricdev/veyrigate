# Log — run 57

- orchestrator: mở run theo quyết định người dùng (2026-10-26) gộp DEBT-420/422.

## [2026-10-26] tech-lead
- Preflight codegraph 1.6.2: status up to date, sync OK. Đối chiếu code thật: `UserService.adminLock/adminUnlock`, `AdminUsersController.lock/unlock`, `AuditService.record/listForTenant`, `audit-log.schema.ts`, encode/decode cursor, fe-admin audit (`AuditCursorSchema`, nút "First page" khi gặp `invalid_request`), test L1–L8, (g), (i), DEBT-152, audit cursor QA.
- Kết quả: **PASS**. Fold vào `tasks.md` (mục "Fold tech-lead (2026-10-26)"):
  - Mốc `users.adminLockMarkAt = max(now, prev+1ms)`, `now` là literal do Node chụp. Không dùng `$$NOW`: tính đơn điệu đến từ `prev+1`, và unlock cần pre-image để tính mốc.
  - `adminLock` gộp thành một pipeline, path no-op của tenant cũng bump mốc.
  - `record(input, {timestamp})`.
  - Follow-up của lock dùng `max(now, mark+1)`.
  - Sort/cursor đổi sang `(timestamp, _id)`, cursor `{t,i}`, cursor cũ trả 400. Index `{tenantId, timestamp:-1, _id:-1}` + `db:sync-indexes`.
  - Test: L6 ≥10 lượt, barrier hai chiều, trùng ms, phân trang qua ranh giới, mutation m1–m4. Có cổng security.
- Mở DEBT-424 (brute-force ∥ unlock), DEBT-425 (thứ tự xuyên loại event/instance, runbook). Bàn giao: backend-dev (Task 1 → Task 2).

## [2026-10-26] backend-dev
- Preflight codegraph 1.6.2 (status/sync OK). Security: tài sản = trạng thái khoá user + trail admin; mốc `adminLockMarkAt = max(now, prev+1)` nằm cùng câu ghi (không partial); `record(input,{timestamp})` chỉ gọi ở `admin-users.controller.ts` (grep), timestamp sai ⇒ throw trước khi ghi; mốc không ra view/metadata/log (assert (d)); cursor chỉ `{t,i}`, `$or` + `tenantId` merge sau cùng.
- T1: `adminLock` = 1 pipeline (`$cond` giữ mức), trả `{user, lockMarkAt}`; `adminUnlock` pipeline + `returnDocument:'before'` trả `{before, unlockMarkAt}`; controller dùng mốc, follow-up `max(now, mark+1)`, sửa comment. L6 bật lại: `-t "L5|L6|L7"` 10/10 lượt xanh. Test mới (b)/(c)/(d), L1 bump, DEBT-152 `SESSION_REVOKED > LOCKED`, (g) sort `(timestamp,_id)`.
- T2: sort/cursor `(timestamp,_id)`, cursor `{t,i}` (cũ `{t,e}` ⇒ 400), index `{tenantId,timestamp:-1,_id:-1}` (+ test drop index cũ). T2a/b/c/d xanh; runbook-deploy §1, spec §9.11/§10, security-matrix.
- Mutation (backup sha256, khôi phục byte-identical): m1 ⇒ (b)+(c) RED; m2 ⇒ (d) RED; m3 ⇒ L1 RED; m4 ⇒ DEBT-152 RED; tie-break eventId ⇒ T2a RED; `$lte` ⇒ T2b RED.
- Verify: be unit 594, typecheck/lint/build OK; int full 818 + 537 = 1355 (0 skip); root lint OK, `pnpm -r typecheck` OK, root test 594 + 1416 + 269, audit high exit 0; E2E 35/35 (harness tự `db:sync-indexes` trên `sso-idp-e2e`); `fe-admin/` diff rỗng.
- Người dùng: chạy `pnpm -C be db:sync-indexes` trên DB dev `sso-idp` (đổi index audit; agent không chạy). Đóng DEBT-420/422; mở DEBT-426 💭. ⇒ senior-reviewer.

## [2026-10-26] senior-reviewer
- Preflight codegraph 1.6.2 (status/sync OK). Tự chạy: be typecheck OK, lint OK, unit 38 suite/594 xanh; `fe-admin/` diff rỗng; int không chạy lại (dùng số liệu dev).
- Kết quả: **PASS**, không có 🔴.
  - `keepHigher` là phủ định chính xác của `tenantAdminMayChangeLock` (field vắng xử lý đúng) ⇒ DEBT-153 không yếu đi. Bỏ vòng 2 lượt nên không còn TOCTOU.
  - Pre-image unlock có `adminLockMarkAt` (PUBLIC_FIELDS là projection loại trừ) ⇒ mốc tính lại trùng DB, có test (b)/(d).
  - `record(…, {timestamp})` chỉ được gọi ở 4 chỗ trong `admin-users.controller.ts`, giá trị đều do server tính.
  - Cursor `{t,i}` có regex hex; `tenantId` gán sau cùng; mốc không lộ ra ngoài (test (d)).
- Mở DEBT-427 🟡: cursor `t` trong khoảng (8.64e15, 2^53−1] ⇒ `Invalid Date` ⇒ CastError ⇒ 500 thay vì 400 (lỗi có từ trước, không phải regression).
- Ponytail: Lean already. Ship.
- Bàn giao: ⇒ tester.

## [2026-10-26] backend-dev (DEBT-427)
- `decodeAuditCursor`: thêm cận `t > 8.64e15` (giới hạn Date JS) ⇒ null ⇒ 400 `invalid cursor` (trước đây `Invalid Date` ⇒ CastError 500). T2c thêm `t` = 8.64e15+1, 9e15, MAX_SAFE_INTEGER ⇒ 400 (cùng body); biên 8.64e15 ⇒ 200. RED trước khi sửa (3 case 500).
- Mutation bỏ cận trên ⇒ T2c RED; khôi phục byte-identical (sha256).
- Verify: be unit 594, typecheck/lint OK; admin-users 57/57; int full 818 + 537 = 1355. Đóng DEBT-427 ⇒ tester.

## [2026-10-28] tester
- Preflight codegraph sync OK. Resume sau khi Docker tắt: sản phẩm không mutant (diff be/src 7 file +181/−79 khớp), `vg:int-lock` trống, chỉ `docker start vg-test-*`.
- Thêm `be/test/run57-tester.int-spec.ts` (11: M1 2 super + 2 tenant song song replay == DB, M2 trùng ms, V1–V3 mức/legacy, O1 DEBT-152 mốc vượt giờ, P1–P4 phân trang/cursor giả/khác tenant, X1 exposure) + `e2e/tests/fe-admin-audit-paging.spec.ts`. Mutation A–E đều RED, khôi phục sha256 OK.
- Số liệu: L5|L6|L7 25/25 lượt; be unit 594; int 1366 (0 skip); typecheck/lint/build OK; root lint, `-r typecheck` OK; root test 594 + 1416 + 269; audit high exit 0; E2E 36/36; `fe-admin/` diff rỗng; grep secret 0.
- Kết quả: **PASS**, không debt mới. Xem test-report.md.
- Bàn giao: orchestrator đóng run 57 (người dùng vẫn cần `db:sync-indexes` trên `sso-idp`).
