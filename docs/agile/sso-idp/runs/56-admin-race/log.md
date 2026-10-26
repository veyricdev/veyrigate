# Log — run 56

- orchestrator: mở run sweep race admin/disable client DEBT-147/148/153/156/166/209.
- tech-lead (2026-10-26): preflight codegraph 1.6.2 (status OK, sync OK; index v1.5.0). Đối chiếu HEAD `095a15c`: admin-users.controller (lock/unlock/assertMayTouchAccount/setRoles), user.service, admin-clients.controller (update/issueSecret), client.service (updateForTenant/assertMayModify/findByClientId), client-credential.service, token.controller (gate trước ký, recheckCodeGrant), authorization-code.service, access-token-liveness, authorize.service (trustedClient). Kết quả: DEBT-147 phần lock đã xong gián tiếp (DEBT-152), còn unlock; DEBT-148 chấp nhận + đóng; DEBT-153/166/209 còn đúng; DEBT-156 phần AT khi đang disabled đã xong gián tiếp, còn "sống lại sau enable". **PASS có fold** (cuối tasks.md): T3 DEBT-166 đọc lại sau insert + tự revoke + 403; T2 DEBT-147/153 `users.adminLockLevel`, filter mức trong câu ghi, diff từ `before`; T1 DEBT-209/156 `clients.lastDisabledAt` + code `issuedAt` + `mintedBeforeDisable` (biên 5 s) ở gate/recheck/liveness/trustedClient. Thứ tự 3 → 2 → 1, không tách run. Debt mới DEBT-416 (FE). Chuyển **backend-dev**.

## [2026-10-26 14:20] backend-dev
- Đã làm: T3 DEBT-166 `issueSecret` đọc lại client sau `rotateSecret` (admin-capable ⇒ revoke version + audit `admin_granted_concurrently` + 403; mất ⇒ 404; lỗi ⇒ 5xx; không plaintext; đọc lại cả với super_admin vì `assertMayModify` tự bỏ qua). T2 DEBT-147/153 `users.adminLockLevel`, `UserService.adminLock/adminUnlock` (filter mức trong câu ghi, unlock `returnDocument:'before'`, sentinel cũ ⇒ super, 403 `locked_by_super_admin`), audit lock thêm `metadata.level`. T1 DEBT-209/156 `clients.lastDisabledAt` cùng câu stamp, code `issuedAt`, `mintedBeforeDisable`+`CLIENT_DISABLE_MARGIN_MS=5000` ở gate trước ký, sau consume (refuse không ký), `recheckCodeGrant`, liveness AT (`iat`), `trustedClient`; `resume` kiểm `trustedClient` cho MỌI nhánh (trước chỉ nhánh reauth — nhánh thường đi `handle()` bỏ qua).
- Security: tài sản secret client admin / trạng thái khoá + trail / code-AT-context client disabled; abuse race grant∥issue, unlock khoá super, lock∥unlock, replay sau re-enable, authorize đang dở; failure fail-closed (5xx, không audit success, không plaintext); exposure: audit chỉ reason+version/level.
- Test: RED trước (T3 4/5 nhận 201; T2 lỗi biên dịch adminUnlock; T1 6 hành vi + biên dịch). Đổi kỳ vọng có chủ đích 3 test admin-api ghi hành vi debt (enable làm sống lại AT/code) + authorization-code.int-spec (payload thêm `issuedAt`). Mutation 13/13 RED (T3 2, T2 3, T1 8; m13/m14/m16 chạy lại bản không lỗi biên dịch), khôi phục sha256 byte-identical.
- Verify: be unit 589, int 1332/1332 (+26), lint/typecheck/build OK, root lint/typecheck OK, root test be 589 + fe-admin 1416 + fe-sso-test 269, E2E 35/35, audit high 0 (1 high ignored sẵn); grep `eyJ`/clientSecret/passwordHash trong log = 0. Không đổi response admin ⇒ không đụng OpenAPI snapshot. `vg-test-mongo/redis` tự Exited(255) đồng thời lúc root test (OOM worker jest) ⇒ chỉ `docker start`, chạy lại xanh.
- File đổi: be/src (admin-clients/admin-users controller, user.service + schema, client.service + schema, authorization-code.service, token.controller, access-token-liveness(+spec), authorize.service, seed-dev), be/test (admin-api, admin-users, token-code-recheck, introspect, userinfo, authorize, authorization-code, refresh-token), spec §9.11/§10, security-matrix, runbook-ops (NTP), backlog.
- Kết quả: DONE — đóng DEBT-147/153/156/166/209; mở DEBT-417 💭 (audit lock `level` = mức actor, không phải mức hiệu lực).
- Bàn giao: senior-reviewer — soát 3 thay đổi kỳ vọng test cũ, nhánh `resume` mới kiểm `trustedClient`, lỗi `adminLock` sau 2 vòng (5xx).

## [2026-10-26] senior-reviewer
- Preflight codegraph 1.6.2 (status/sync OK). Đọc diff be/src + test int mới/đổi + docs. Chạy lại: be typecheck OK, eslint OK, unit 589/589 (không chạy int/E2E).
- Security invariants I1-I4 đạt; run 54 (refusal sau consume chỉ kích hoạt khi gate đã từ chối ⇒ không token đã ký bị bỏ/trả, code bị đốt, 1 audit failure) và run 55 (consent binding) giữ nguyên; `resume` kiểm `trustedClient` mọi nhánh đúng (lấp lỗ context trước disable resume sau enable), không phá login/step-up; `adminLock` 5xx sau 2 vòng chấp nhận (không ghi gì, retry an toàn); 3 kỳ vọng admin-api cũ đúng là ghim hành vi debt.
- Kết quả: **PASS**, 0 🔴; 🟡 DEBT-418 (xoá `resetFailedLogins` chết prod, lệch mức khoá), DEBT-419 (runbook NTP sai chiều lệch đồng hồ); 💭 3; ponytail net -13.
- Bàn giao: **tester**.

## [2026-10-26 15:10] backend-dev (retry 🟡 senior)
- Đã làm: DEBT-418 xoá `UserService.resetFailedLogins`, 3 caller test → `adminUnlock(sub, true)` (identity: kiểm `before.failedLoginCount=10` rồi `findById` 0/không khoá). DEBT-419 runbook-ops NTP: sống lại chỉ khi đồng hồ instance mint nhanh hơn instance ghi disable > 5 s; mint chậm ⇒ fail-closed.
- File đổi: be/src/modules/identity/user.service.ts, be/test/identity.int-spec.ts, be/test/ui-auth.int-spec.ts, runbook-ops.md, backlog.md.
- Verify: tsc 0, lint 0, prettier OK, be unit 589/589, int 1332/1332 (vg-test-* đang chạy, không cần start).
- Kết quả: DONE — đóng DEBT-418/419. Bàn giao: tester.

## [2026-10-26 16:40] tester
- Preflight codegraph 1.6.2 (status/sync OK). Đọc tasks (fold + cổng security), review-techlead/senior, log. Spec mới `be/test/run56-tester.int-spec.ts` (14 case, app thật qua HTTP): R1–R4 secret ∥ grant (ROTATE, barrier hai chiều + barrier kép, 10 vòng không barrier), L1–L7 lock/unlock (mức, sentinel cũ, brute-force, 8 unlock song song ×5, lock ∥ unlock, super lock ∥ tenant unlock), D1–D2 disable→enable (code/AT/RT/consent ctx/login ctx + client đối chứng, sau margin), X1 exposure.
- Chạy: be typecheck/lint/build OK, unit 589/589; int full 1344/1346 (fail chỉ run56-tester L5/L6; 1332 của dev xanh); root lint/typecheck OK; root test ×2 xanh (be 589, fe-admin 1416, fe-sso-test 269); audit high 0 (1 ignored); E2E 35/35; grep JWT/clientSecret/passwordHash = 0. Mutation spec mới 3/3 RED, khôi phục sha256 byte-identical.
- Kết quả: **FAIL** — DEBT-147: lock ∥ unlock ⇒ DB mở khoá nhưng trail kết thúc `ADMIN_USER_LOCKED` (L5 barrier, L6 8/10 vòng đồng thời thật). Mở DEBT-420 🔴. I1/I2/I4 + run 54/55 đạt. Xem `test-report.md`.
- Bàn giao: **backend-dev** (Task 2 retry), rồi senior/tester lại.

## [2026-10-26 16:30] backend-dev (retry 1 — DEBT-420 🔴)
- Đã làm: `AdminUsersController.lock` ghi audit `LOCKED success` ngay sau `adminLock` (trước `revokeAllUserCredentials`); `AuditService.record` lấy timestamp đồng bộ khi gọi, không I/O giữa câu ghi và lúc đó ⇒ unlock ghi DB sau lock luôn audit sau (một process). Promise audit khởi động trước revoke, await sau ⇒ audit lỗi vẫn revoke rồi 5xx. Metadata success còn `{level}` (bỏ `count`: chưa biết trước revoke). DEBT-152 giữ: trail lỗi + retry = success, failure, success.
- File đổi: be/src/modules/admin/admin-users.controller.ts; be/test/admin-users.int-spec.ts (kỳ vọng metadata `{level}`, trail retry, test mới (i) audit lỗi ⇒ vẫn revoke). Không sửa test tester.
- Verify: tsc 0, lint 0, be unit 589, int 1347/1347 (51 suites, gồm run56-tester 14/14); L5/L6/L7 chạy riêng 3 lần đều 3/3; mutation trả thứ tự cũ ⇒ L5+L6 RED, khôi phục sha256 byte-identical; `eyJ` trong log int = 0.
- Rủi ro còn lại: nhiều instance BE ⇒ thứ tự trail theo đồng hồ từng node (NTP, runbook-ops).
- Kết quả: DONE — đóng DEBT-420, DEBT-147 trỏ DEBT-420. Bàn giao: tester (chạy lại run56-tester + full).

## [2026-10-26] senior-reviewer (vòng 2 — retry 1 DEBT-420)
- Preflight codegraph: sync OK. Đã đọc test-report (L5/L6), log retry 1, review vòng 1, cùng diff của `AdminUsersController.lock`, `AuditService.record`, `revokeAllUserCredentials`, `listForTenant`. Chạy lại: tsc 0, eslint 0, be unit 589/589. Không chạy int/E2E.
- Thứ tự audit nay đã đúng:
  - Timestamp được lấy đồng bộ ngay sau câu ghi khoá.
  - Audit lỗi: vẫn revoke, rồi trả 5xx.
  - Revoke lỗi: ghi success, sau đó failure. DEBT-152 vẫn giữ.
  - Trường hợp ngược chiều (DB khoá nhưng trail ghi UNLOCKED) chỉ xảy ra khi phản hồi về đảo thứ tự hoặc trùng ms. Về bảo mật thì an toàn.
- Kết quả: **REJECT**.
  - 🔴 `e2e/tests/fe-admin-audit.spec.ts:55-56` assert term `count` và giá trị số trong Details của `ADMIN_USER_LOCKED`. Metadata giờ là `{level}` nên test sẽ đỏ.
  - 🟡 DEBT-421: mất `count`, nghĩa của success đã đổi nhưng spec chưa ghi.
  - 🟡 DEBT-422: tie-break bằng `eventId` ngẫu nhiên, nên khi trùng ms thì thứ tự trên admin API bị đảo. Test sort theo `_id` nên không phát hiện.
  - 💭 2. Ponytail: lean.
- Bàn giao: **backend-dev** retry 2. Hai hướng: sửa E2E, hoặc ghi `SESSION_REVOKED {count, via:'lock'}` sau revoke. Chạy E2E fe-admin-audit trước khi bàn giao, sau đó tới senior rồi tester.

## [2026-10-26 16:10] backend-dev (retry 2 — senior vòng 2 REJECT, phương án (a))
- Đã làm: `lock` ghi thêm `SESSION_REVOKED success {scope:'all', count, via:'lock'}` sau revoke thành công; `LOCKED success {level}` giữ vị trí (trước revoke). E2E `fe-admin-audit.spec.ts` assert term `level` trên LOCKED + `count` trên SESSION_REVOKED. Spec §9.11 + security-matrix ghi nghĩa mới (DEBT-421).
- File đổi: be/src/modules/admin/admin-users.controller.ts, be/test/admin-users.int-spec.ts, e2e/tests/fe-admin-audit.spec.ts, spec.md, security-matrix.md, backlog.md.
- Verify: root lint 0, `pnpm -r run typecheck` 0, be unit 589; int full chia `--shard` 1/2 = 815/815 (3m33s) + 2/2 = 532/532 (5m13s) ⇒ 1347/1347; lần chạy full trước bị chính `timeout 900` của tôi cắt (exit 124, máy chậm: run56-tester/seed-dev timeout 20–30 s) — chạy cô lập 3 suite: seed-dev PASS, admin-users PASS ⇒ timeout không tái hiện. Lock `vg:int-lock` của jest bị cắt tự hết TTL (không xoá). Mutation bỏ SESSION_REVOKED ⇒ 2 test RED, khôi phục sha256 byte-identical. E2E fe-admin-audit + fe-admin-users 2/2, full 35/35; `eyJ` trong log = 0.
- ⚠ L6 (tester) FLAKY: 4 lần chạy riêng L5+L6 ⇒ 2 FAIL (1–2/10 vòng lệch cả hai chiều), 2 PASS; L5 luôn PASS. Gốc: phản hồi Mongo trên 2 connection về đảo thứ tự ⇒ timestamp audit không theo thứ tự áp dụng. DEBT-420 MỞ LẠI (cần quyết định hướng: stamp đơn điệu trong câu ghi làm timestamp audit, hoặc transaction).
- Kết quả: DONE phần (a)/DEBT-421 (đóng, int xanh); DEBT-420 chưa đạt ổn định. Bàn giao: orchestrator/tech-lead quyết định DEBT-420.

## [2026-10-26] senior-reviewer (vòng 3 — retry 2, DEBT-421)
- Preflight codegraph sync OK. Đọc review vòng 1/2, log retry 2, diff controller/int-spec/E2E/spec/security-matrix, `revokeAllUserCredentials`. Verify: be tsc 0, eslint 0, be unit 589/589, e2e tsc 0. Không chạy int/E2E.
- Theo quyết định người dùng: L6/DEBT-420 không xét trong run 56 (gộp DEBT-422 → run 57).
- Kết luận: `SESSION_REVOKED {scope:'all', count, via:'lock'}` chỉ ghi sau khi revoke thành công. Revoke lỗi thì không ghi (rethrow). Retry DEBT-152 có đúng 1 event (int assert). Metadata không nhạy cảm. Spec §9.11 và matrix mô tả đúng.
- Kết quả: **PASS**. 🟡 DEBT-423 (E2E bước SESSION_REVOKED chưa assert targetId/`via:lock`). 💭 2. Ponytail: lean.
- Bàn giao: **tester** (hoặc orchestrator đóng run 56 theo quyết định người dùng).

## [2026-10-26] tester (lượt 2 — sau retry 2 + senior vòng 3)
- Preflight codegraph sync OK; `vg:int-lock` trống. Theo quyết định người dùng: L6 → `it.skip` (DEBT-420 → run 57 cùng DEBT-422). Sửa DEBT-423 trong E2E `fe-admin-audit` (targetId URL + `via`/`lock` trong Details đúng dòng) + int L8 (lock 2 lần ⇒ 2 `SESSION_REVOKED via:lock`).
- Kết quả: be unit 589/589; int full 1347 pass + 1 skip (L6); root lint/typecheck sạch; root test be 589, fe-admin 1416, fe-sso-test 269; audit 0 high; E2E 35/35. Grep secret E2E 0.
- Kết quả: **PASS**. Đóng DEBT-423. Bàn giao: orchestrator đóng run 56. Xem test-report "Lượt 2".
