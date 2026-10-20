# Log — run 35 — B7.1b lỗi sản phẩm (DEBT-116/204/205/128/141/144/156)

## orchestrator — 2026-10-20
- Theo review-techlead run 34: nhóm debt sản phẩm cần chốt chính sách (DEBT-116 membership tenant ở luồng OAuth) ⇒ gọi analyst lập tasks.md. Cổng → analyst.

## analyst — 2026-10-20
- Preflight CodeGraph: index có sẵn, `codegraph sync` OK. Đọc code qua CodeGraph: `AuthorizeController/Service`, `authorize.errors`, `TokenController.handleAuthorizationCodeGrant`, `RefreshTokenService.issueForRefresh`, `UserTenantService`, `AuthenticationService.login`, `FederationService.loginExisting`, admin lock/disable/revoke-consent.
- Lập `tasks.md` gồm 5 task [BE]: T1 tham số lặp `/authorize` (DEBT-204/205), T2 membership ở `/authorize` + consent POST (DEBT-116, MT1/MT2/INV-24b), T3 một hàm kiểm lại sau insert family ở code grant (DEBT-116/128/144/156/141), T4 refresh + login kiểm lại sau ghi (DEBT-141/116, race disable), T5 ma trận + backlog + toàn suite.
- Nguyên tắc chốt: tenant chỉ lấy từ client document; không tự cấp membership; phía huỷ ghi trạng thái trước rồi quét, phía cấp insert trước rồi đọc lại; `/token` trả `invalid_grant` giống nhau từng byte, lý do chỉ ghi ở audit.
- Quyết định mở có mặc định an toàn: Q35.1–Q35.6 (cuối `tasks.md`). Đáng chú ý Q35.2: admin API chưa có endpoint thêm member, nên client ở tenant ≠ default chỉ dùng được qua seed/DB ⇒ đề xuất mở DEBT mới.
- Lưu ý cho dev: int-spec có khoảng 55 chỗ dùng client `tenant-A/B/1/b`, cần helper membership chung (T2).
- Không sửa spec.md/plan.md/code, không commit. Cổng → **tech-lead**.

## tech-lead — 2026-10-20
- Preflight CodeGraph OK (`codegraph sync`). Đối chiếu code thật: AuthorizeController/Service (handle/resume/decideConsent), TokenController code grant, TokenService, RefreshTokenService.rotate, AuthenticationService.login/revokeAllUserCredentials, FederationService.loginExisting/completeLink, UserTenantService, ConsentService, OauthModule/IdentityModule, fixture int-spec.
- **PASS kèm fold** (`review-techlead.md`, `tasks.md` § Fold tech-lead F0–F9). Phạm vi thu hẹp: run 35 = T1, T2, T3, T5. **T4 tách sang run 36** (DEBT-207) vì fixture: T3 làm đỏ mọi test mint code với userId ngẫu nhiên (token 33 lần mint code, refresh 13 lần, cùng các spec khác), cộng ~55 chỗ của T2.
- Fold chính: helper `be/test/oauth-fixtures.ts` `seedOAuthUser`. `OauthModule` import `IdentityModule`. Không thêm class provider (kiểm lại là method private của `TokenController`). Audit `not_member` dùng `result:'failure'`. Thêm mẫu DEBT-067 cho nhánh fail của T3.
- Chấp nhận Q35.1/2/4/5/6, Q35.3 áp dụng ở run 36. Không mục nào cần người dùng quyết định. Báo người dùng hệ quả Q35.2.
- Backlog mở DEBT-207 (T4 → run 36), 208 (admin API member), 209 (residual Q35.6), 210 (resource ở code grant). Không sửa code, không commit. Cổng → **backend-dev** (T1 → T2 → T3 → T5).

## backend-dev — 2026-10-20
- Preflight CodeGraph OK (`codegraph sync`). Security: tài sản = redirect_uri/state/nonce (T1), code/consent tenant B (T2), family/AT (T3); actor = attacker soạn URL, user tenant khác, admin disable/lock/revoke đồng thời; tenant chỉ từ client doc, không tự cấp membership; fail-closed 500 khi DB lỗi; lý do chỉ ở audit (body `invalid_grant` giống hệt).
- T1 ✅ `repeatedParam` (12 khoá): `request_id` lặp ⇒ trang 400 ở controller; `client_id`/`redirect_uri` ⇒ trang 400 trước `findByClientId`; còn lại ⇒ 302 `invalid_request` đầu Phase 2; catch chỉ gắn `state` string. T2 ✅ `assertMember` ở `handle` (trước consent/prompt=none) + `decideConsent` (sau re-resolve, trước grant) ⇒ 302 `access_denied`, audit `OAUTH_AUTHORIZE failure reason:not_member` (`recordAuthorize(..., result)`). T3 ✅ `TokenController.recheckCodeGrant` sau khối session (client → redirect_uri → user lock → member → consent `isCovered`), fail ⇒ revoke family + 1 `TOKEN_ISSUED failure` (mẫu DEBT-067), lỗi ⇒ `recheck_failed` + 500. `OauthModule` import `IdentityModule`.
- Fixture: `be/test/oauth-fixtures.ts` (`seedOAuthUser`, `seedConsent`, `seedCodeGrant` upsert user/member/consent cho code mint trực tiếp). Sửa 13 int-spec (providers + cfg `consent` + seed). Đổi đáng chú ý: `federation.int-spec` client RP chuyển `default-tenant` (user provision chỉ ở default, Q35.2; cross-tenant phủ ở spec mới); `admin.int-spec` 2 test suspended/outsider dùng token ký tay (không còn mint được qua /authorize); `admin-users` fixture vào B rồi rời B; `admin-keys` endUser là member TENANT_A.
- Test mới: unit `authorize.service.spec` (14), int `authorize-params` (15), `oauth-tenant-isolation` (8), `token-code-recheck` (16). Mutation (cp+sha256 khôi phục, khớp): T1 phase2 ⇒ 9 RED, phase1 ⇒ 1 RED, state ⇒ 1 RED, request_id ⇒ 1 RED; T2 handle ⇒ 6 RED, decideConsent ⇒ MT2 RED, tenant=default ⇒ 3 RED (gồm đối chứng); T3 (1) client ⇒ 3 RED, (2) redirect ⇒ 2, (3) lock ⇒ 3, (4) member ⇒ 4, (5) consent ⇒ 4, bỏ lời gọi ⇒ 13 RED.
- Verify thật: typecheck OK, lint OK, `pnpm -C be test` 317/317 (303→317), `pnpm -C be test:int` 866/866 38 suites (827→866), `pnpm -C fe-sso-test test` 240/240, `pnpm -C e2e e2e` 16 passed. Ma trận: MT1/MT2/24b ⇒ `có` (75/77), tên test đã grep tồn tại. Backlog: đóng DEBT-128/144/204/205; DEBT-116/141/156 đóng một phần (phần còn ⇒ DEBT-207/209). Không 🟡 mới. Không commit. Cổng → **senior-reviewer**.

## senior-reviewer — 2026-10-20
- Preflight CodeGraph OK (`codegraph sync`). Đọc qua CodeGraph: AuthorizeController/Service (handle/resume/decideConsent/assertMember), `repeatedParam`, TokenController code grant + `recheckCodeGrant`, ConsentService, UserTenantService, AdminTokenGuard/`isAccessTokenLive`; fixture `oauth-fixtures.ts` + diff 13 int-spec + 3 int-spec mới.
- Verify thật: typecheck OK, `pnpm -C be test` 317/317, `pnpm -C be test:int` lọc 8 suite 279/279.
- **PASS** (`review-senior.md`). Không 🔴: không còn đường cấp code/token cross-tenant (fresh, covered, prompt=none, resume, consent POST, code grant); tenant chỉ từ client doc; stamp-first đúng; fail-closed; `invalid_grant` đồng nhất; fixture không che lỗi (token ký tay hợp lệ, có đối chứng 200; federation RP đổi tenant không mất phủ cross-tenant).
- 🟡 → backlog: DEBT-211 (not_member `access_denied` có `error_description`, deny thật thì không ⇒ khác byte), DEBT-212 (thiếu test MT1 trên đường resume), DEBT-213 (lặp khối từ chối grant ở `/token`). Cổng → **tester**.

## tester — 2026-10-20
- Preflight CodeGraph OK (`codegraph sync`). Đối chiếu acceptance T1/T2/T3/T5 + fold F0–F9 với code (CodeGraph: `handle/resume/decideConsent/assertMember/repeatedParam`).
- Thêm 69 int-test: `authorize-params` ma trận 12 khoá × {`k=&k=`, hợp lệ+rỗng, rỗng+hợp lệ} + `k[]`/`k[0]` bị bỏ qua (+61); `oauth-tenant-isolation` resume sau login non-member (DEBT-212, ×2), đối chứng resume member, `prompt=none`+consent covered non-member và đối chứng (+5); `federation` cross-tenant với form mật khẩu thật và Google federated user mới ⇒ resume ⇒ `access_denied`, đối chứng member tenant-B ⇒ code (+3).
- Mutation (cp + sha256 khớp): chỉ bỏ kiểm trên đường resume ⇒ đúng 4 test mới RED (suite cũ xanh ⇒ lỗ DEBT-212 có thật); tắt Phase 2 ⇒ 33 RED; tắt Phase 1 ⇒ 7 RED (test cũ `redirect_uri repeated` không bắt được, case mới bắt nhờ spy lookup).
- Chạy thật: typecheck/lint OK; `pnpm -C be test` 317/317; `pnpm -C be test:int` 935/935 (38 suites, 866→935); `pnpm -C fe-sso-test test` 240/240; `pnpm -C e2e e2e` 16 passed (cổng trống, không dừng process nào). Ma trận đếm lại 75/77 `có`, 248 tham chiếu test đều tồn tại; MT1 thêm 4 test mới.
- **PASS** (`test-report.md`). Đóng DEBT-212. Không 🟡 mới (DEBT-211 giữ mở). Không commit. Cổng → **orchestrator** đóng run.
