# Log — run 36 — B7.1c (DEBT-207 refresh + login re-check, DEBT-210/211/213)

## orchestrator — 2026-10-20
- Tiếp B7.1 sau run 35 (`29c1a45`). Tự sinh `tasks.md` từ thiết kế Task 4 run 35 (`runs/35-B7.1b/tasks.md` §Task 4 + fold F0) + backlog DEBT-207/210/211/213. Cổng → tech-lead.

## tech-lead — 2026-10-20
- Đối chiếu `29c1a45` qua CodeGraph (TokenController code/refresh, RefreshTokenService.issueForRefresh/rotate, AuthenticationService.login, FederationService.callback/completeLink, SessionService.establish/revoke, AuthorizeService.assertMember, AuthorizeController.buildErrorRedirect).
- **PASS kèm fold G0–G8** (`tasks.md` §Fold tech-lead, `review-techlead.md`). Q-36.1: kiểm lại trong service sau `establish` (login + federation callback; link phủ qua `login`). Q-36.2: vừa 1 run.
- Abuse case mới (G1): lockout brute-force do kẻ tấn công kích ⇒ refresh revoke family nạn nhân. Grant chỉ coi khoá admin (`ADMIN_LOCKED_UNTIL`) là `user_locked`; đổi luôn code grant run 35 (helper `lockOnly` trong test). Login giữ mọi khoá.
- Refresh: callback bắt buộc `recheck` trong `issueForRefresh` (không DI mới), audit `TOKEN_REFRESHED failure reason`. Mở DEBT-214 (refresh không kiểm consent khi bump version). Cổng → backend-dev.

## backend-dev — 2026-10-20
- Security: tài sản refresh family + session IdP; actor admin lock/disable/suspend xen giữa, kẻ kích lockout (G1). Invariant: ghi trạng thái trước, quét sau ⇒ grant/login đọc lại SAU khi ghi (rotate/establish) ⇒ không interleaving nào sống. Lỗi DB ⇒ revoke best-effort + 500 (không cookie/token). Exposure: audit chỉ reason/resource/familyId; RP chỉ thấy `invalid_grant`/`access_denied` không mô tả.
- T1: `refuseGrant`/`failClosed` (DEBT-213), `subjectFailure` (G1: chỉ khoá admin/user mất), `resource_not_allowed` (DEBT-210, inject `ResourceService`); `lockOnly` ⇒ `ADMIN_LOCKED_UNTIL`; fixture `token.int-spec` client giữ `res-api` (code mint thẳng Redis).
- T2: `issueForRefresh(…, recheck, audit)` bắt buộc ⇒ `recheckAfterRotate` (revoke family + `TOKEN_REFRESHED failure reason`, `recheck_failed` ⇒ 500). Test race spy `rotate` (gọi gốc trước) trong `token-code-recheck.int-spec`. `refresh-token.int-spec` đã dùng `seedCodeGrant` (không cần đổi fixture). `admin-users`: cross-tenant ⇒ `invalid_grant` + family revoked (CÓ CHỦ ĐÍCH); 3 test khác đổi sang kiểm doc family B không bị admin A đụng.
- T3: `login`/`callback` đọc lại user sau `establish`; khoá ⇒ `sessions.revoke(id)` + `recordFailed` + 401 chung / `account_locked`; DB lỗi ⇒ revoke best-effort + 500. Unit spec thêm mock `findById`; ui-auth khối DEBT-154 reset `rl:*` mỗi test (vượt bucket 20/phút).
- T4: `errorDescription?` + `assertMember` không mô tả (DEBT-211). Ma trận MT1/MT2/24b + §Run 36; backlog đóng 116/141/187/207/210/211/213, 156 phần refresh.
- Mutation (sao lưu + cp + sha256 khớp): M1 resource ⇒ 3 RED; M2 refresh client_disabled ⇒ 2; M3 refresh subject ⇒ 3; M4 user_locked ⇒ 4; M5 not_member ⇒ 5; M6 login post-check ⇒ 2 (ui-auth) + 1 (link c2); M7 federation ⇒ 2; M8 `> now` thay admin-lock ⇒ 2 (G1); M9 DEBT-211 ⇒ 1; M10 revoke ở refresh ⇒ 3; M11 revoke ở refuseGrant ⇒ 10.
- Verify thật: typecheck/lint sạch; `pnpm -C be test` 317/317; `test:int` 38 suite 953/953; `fe-sso-test` 240/240; E2E 16/16. Không debt mới. Cổng → senior-reviewer.

## senior-reviewer — 2026-10-20
- Review diff chưa commit từ `1e8573c` (be/ + docs) qua CodeGraph + git diff; tự chạy typecheck sạch, unit 317/317, int 5 suite chạm 185/185.
- **PASS** (`review-senior.md`), không 🔴. G1 đúng (chỉ khoá admin/user mất ⇒ `user_locked`; brute-force không hạ được khoá admin); refresh recheck trước sign, family revoke, body byte-identical, 500 fail-closed; login/federation post-check trước audit success, không cookie, không tăng counter; federation `account_locked` không phải oracle mới (đã có ở `loginExisting`, cần xác thực upstream). Refactor `refuseGrant`/`failClosed` giữ số audit. Thay đổi test (admin-users `familyUntouched`, ui-auth reset `rl:*`, token.int-spec `res-api`) không che lỗi.
- Mở 🟡 DEBT-215 (replay sau từ chối sau rotate ⇒ `TOKEN_REUSE_DETECTED` giả), DEBT-216 (refresh không kiểm lại resource theo client đọc lại, đối xứng DEBT-210), DEBT-217 (ponytail: khối post-check lặp login/federation). Cổng → tester.

## tester — 2026-10-20
- Đối chiếu acceptance T1–T4 + fold G0–G8 qua CodeGraph. Bổ sung 11 test: `token-code-recheck` 10 test (brute-force không hạ được khoá admin ở code grant và refresh; khoá tạm qua `recordFailedLogin` thật ⇒ refresh sống; refresh bị từ chối/500 ⇒ `signTokensForRefresh` không được gọi; `revokeFamily` ném ⇒ 500 + audit giữ; user mất; cross-tenant còn active nơi khác ⇒ not_member; 5 refresh song song khi khoá admin; pin DEBT-215 ×2), `federation` (c3) khoá tạm xen giữa trong luồng link.
- DEBT-215 đã xác nhận bằng test thật: replay sau từ chối ⇒ 1 `TOKEN_REUSE_DETECTED` count 0. Không có bypass hay token, nên chỉ là nhiễu SOC, giữ 🟡 (không FAIL).
- Mutation `subjectFailure` coi khoá tạm là khoá ⇒ 3 RED (gồm 1 test tester). Khôi phục bằng cp, sha256 khớp.
- Chạy thật: typecheck/lint sạch; BE unit 317/317; int 38 suite 964/964; fe-sso-test 240/240; E2E 16/16. Grep ma trận: 169 tham chiếu, không có tham chiếu chết. **PASS** (`test-report.md`). Không có debt mới. Cổng → orchestrator đóng run.
