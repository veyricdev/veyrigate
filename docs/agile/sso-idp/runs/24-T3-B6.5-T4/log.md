# Log — run 24 — T3 + B6.5 + T4 (trang & route fe-sso-test, /demo/me, gọi resource thật)

## analyst — 2026-10-14

- Preflight CodeGraph: v1.6.2, index up to date (sync: already up to date; index built bởi v1.5.0, chỉ cảnh báo, không chặn).
- Khảo sát codebase (CodeGraph CLI/grep): `fe-sso-test/src/router.tsx` (route `/`,`/callback`), `oidc/client.ts` + `tokenStore.ts` (token in-memory), `token-verifier.ts` (`verifyAccessToken` không pin aud), `access-token-liveness.ts`, `client-cors.helper.ts`/`ClientCorsService` (CORS per-client), `seed-dev.ts` (client `fe-sso-test` + resource `demo`=`${issuer}/demo/`, ISSUER=:4000), `userinfo.controller.ts`, `e2e/tests/login.spec.ts`.
- Viết `runs/24-T3-B6.5-T4/tasks.md`: 4 task — T1 [BE] demo-resource `GET /demo/me` + seed resource `other`; T2 [FE] route/guard (`/login,/profile,/tokens,/api-test,/logout`, error page, không lộ token thô); T3 [FE] T4 gọi `/demo/me`/sai-aud/`userinfo` + INV-8; T4 [E2E] mở rộng Playwright.
- Quyết định mở (cần tech-lead): Q-24.1 (resource `other` cho luồng sai-aud), Q-24.2 (bật/tắt demo-resource theo NODE_ENV + điểm wiring), Q-24.3 (chốt: /tokens chỉ metadata + claims decode, không token thô).
- Không ghi đè spec.md/plan.md. Cổng → tech-lead.

## tech-lead — 2026-10-14 — REJECT

- Preflight CodeGraph v1.6.2 (status + sync OK). Đọc code qua CodeGraph CLI, đối chiếu dữ liệu `sso-idp-e2e` (chỉ đọc).
- **Blocker**: `allowedResources` = resourceId (`'demo'`), còn `aud`/`RefreshToken.resource` = URI ⇒ `isAccessTokenLive` (:74), refresh (:118/:252), introspect authz (:157) so sai kiểu ⇒ `/userinfo`, refresh, `/demo/me` của `fe-sso-test` không thể 200. Fixture int test dùng URI nên che lỗi. ⇒ yêu cầu Task 0 [BE].
- Chốt Q-24.1: resource `other` (không dùng `admin`), token xin bằng authorize thứ 2 (scope `openid`) + khôi phục phiên `prompt=none`. Q-24.2: `DemoModule` + `ConditionalModule`, allowlist `development|test`, preflight path truyền thêm khi bật, CORS 200 theo `client_id` của token. Q-24.3: đồng ý, chỉ metadata + claims ID token.
- Phụ: không đòi scope; tombstone `sid` ⇒ 401 ngay; `returnTo` validate khi ghi và khi đọc.
- Backlog: DEBT-098, DEBT-099. Review: `review-techlead.md`. Cổng → analyst.
## analyst — 2026-10-14 — retry 1 (fold REJECT lượt 1)
- Đọc 
eview-techlead.md; verify lại blocker bằng grep + CodeGraph: 
esolveForClient/indByIdentifier đã có; chỉ **3 call-site** so sai (liveness :74, refresh :118/:252, introspect :157); fixture int-test dùng URI (	oken/refresh-token/userinfo/introspect/session-reflection) che lỗi — đã liệt kê dòng.
- Sửa 	asks.md: thêm **Task 0 [BE]** (chặn mọi task) — map URI→resourceId qua Resource, fail-closed, sửa fixture (không chấp nhận 2 dạng), acceptance a/b/c + mutation, repro DB sso-idp-e2e. Fold Q-24.1/2/3 + điểm phụ vào T1/T2/T3.
- Phân công: backend-dev T0→T1; frontend-dev T2 song song; T3 sau 0+1+2. **E2E (T4) tách sang run 25 cùng T5** (giữ run ≤5 task). DEBT-098/099 ghi nhận.
- Không ghi đè spec.md/plan.md. Kết quả: DONE — cổng → tech-lead lượt 2 (chỉ kiểm phần fold).

## tech-lead — 2026-10-14 — lượt 2
- Preflight CodeGraph 1.6.2 + sync. Đối chiếu code: 3 call-site đúng như tasks; không còn chỗ so sai khác; `ResourcesModule` đã import trong `OauthModule`; `ConditionalModule` có sẵn.
- Fold 3 chỉnh nhỏ vào Task 0: introspect tra Resource theo resourceId của caller, giữ anti-oracle DEBT-040 + test (b2); test (a) dùng caller RS confidential và `buildSeedDevTargets`; acceptance (e) fail-closed khi Mongo lỗi; mutation áp cho từng call-site.
- Spec không đổi (§7/§577 đã đúng). Ghi chú: refresh/userinfo/introspect hỏng với client đúng spec từ trước, fail-closed nên không lộ quyền.
- Kết quả: **PASS** → backend-dev (T0→T1) ‖ frontend-dev (T2) → frontend-dev (T3).
## frontend-dev (Task 2) — 2026-10-14
- Preflight CodeGraph 1.6.2 (status OK, 207 files). Đọc code qua CodeGraph/CLI; terminal Git Bash; ghi UTF-8 không BOM. KHÔNG đụng be/, .vscode/mcp.json, .mcp.json, e2e/.
- Thêm routes `/login` `/logout` `/profile` `/tokens` `/api-test` (khung T4) `/error` + guard fail-closed (anonymous→`/login?returnTo=<path>`). `router.tsx` export `routes` (một nguồn) + `router`.
- `returnTo` validate CHẶT khi ghi (`saveReturnTo`) và khi đọc (`takeReturnTo`): chỉ path cùng origin, chặn `//`,`/\`,backslash,scheme,ký tự điều khiển,`%2f/%5c`→`/`. Truyền qua transient sessionStorage, KHÔNG qua `state`. `/callback` redirect tới `returnTo` đã validate (`?error`→`/error`).
- `/tokens` chỉ metadata + đếm ngược + claims ID token decode (KHÔNG token thô, KHÔNG decode access). Trang lỗi map `error`→thông điệp an toàn, KHÔNG echo `error_description` (DEBT-080). Giữ bất biến run 21–23: token in-memory, không lộ DOM, `data-testid` cũ (`claims`/`claim-sub`) nguyên vẹn → E2E X1 chạy được.
- Verify thật: typecheck PASS; lint PASS; `vitest run` 144 pass (20 files, +61 so với 83 baseline); build PASS.
- Mutation: (1) bỏ leading-slash + bypass origin-check trong `returnTo.ts` → 4 test RED; (2) render `session.accessToken` trong `Tokens.tsx` → test "no raw token" RED. Khôi phục byte-identical (sha256 khớp 3 file: returnTo/Tokens/Profile). KHÔNG commit.
- Đề nghị: chuyển senior-reviewer. (Task 3 chờ orchestrator báo Task 0+1 xong.)

## backend-dev (Task 0, 1) — 2026-10-14
- Preflight CodeGraph (status/sync OK, 207 files). Git Bash; UTF-8 no BOM. KHÔNG đụng fe-sso-test/, e2e/, mcp/agents.
- **Task 0**: thêm `ResourceService.identifiersFor(resourceIds)`; `isAccessTokenLive` nhận `ResourceLookup` thứ 5, so `aud` với identifiers của allowedResources (KHÔNG so URI↔resourceId); refresh pre-check+rotate (`$in: identifiers`); introspect authz tra identifiers theo resourceId của **caller** (giữ anti-oracle DEBT-040, `client_id===caller` trước). Fail-closed: lỗi Resource lookup propagate (userinfo 5xx, introspect 500 `server_error`, refresh 5xx không rotate). Sửa 5 fixture (token/refresh/userinfo/introspect/session-reflection): resourceId + tạo Resource, không nhận 2 dạng.
- **Task 1**: `DemoModule`+`DemoController GET /demo/me` nạp qua `ConditionalModule.registerWhen(DemoModule, isDemoEnabled)` (allowlist RAW NODE_ENV `development|test`; unset/production ⇒ không nạp). Tách `bearerToken()` → `common/http/bearer.ts` (userinfo dùng chung). Pin `aud===${issuer}/demo/` (INV-8), không đòi scope, tombstone⇒401 ngay, fail-closed 5xx, controller 404 khi production. `registerCorsPreflight(...,extraPaths)` + `main.ts` truyền `/demo/me` khi demo bật. Seed thêm resource `other` + `allowedResources=['demo','other']` (buildSeedDevTargets→`resources[]`, upsert idempotent).
- Mutation (d) RED từng call-site rồi khôi phục: liveness (unit 2 RED), refresh (int 24 RED), introspect (int 8 RED). Test mới: liveness.spec (5, gồm (e)), demo.enabled.spec (2), demo.int (12: 200/sai-aud/logout/idtoken/HS256/expired/5xx/CORS/404-prod), seed-dev (a) end-to-end `buildSeedDevTargets`+RS confidential + (b) âm.
- Verify thật: typecheck PASS; lint PASS; unit 205 pass (20 suites); int 499 pass (24 suites); `build`+`db:seed-dev` ×2 trên dev `sso-idp`/Redis`/1` OK idempotent (client+resource demo+other). Grep: không còn so URI↔allowedResources. KHÔNG commit. Lưu ý: 404 ở mức route khi demo tắt chứng minh thêm bằng E2E run 25 (unit `isDemoEnabled` + controller-404 đã phủ). Đề nghị: senior-reviewer.

## frontend-dev (Task 3) — 2026-10-15
- Preflight CodeGraph 1.6.2 (CLI OK). Đọc code qua CodeGraph/CLI; Git Bash; UTF-8 no BOM. KHÔNG đụng be/, e2e/, .vscode/mcp.json, .mcp.json, .github/agents/*. KHÔNG compose/flush/drop.
- `/api-test` (`ApiTest.tsx`): nút A `/demo/me` + nút C `/userinfo` dùng `callResource` (Authorization Bearer, `credentials:'omit'`, `cache:'no-store'`, timeout 10s; network/CORS/timeout⇒"network error"); nút B luồng sai-aud redirect-chuỗi. Pass/fail theo **status kỳ vọng** + ô INV-8; KHÔNG render token thô (dùng claims decode/`sub`).
- Module mới: `resourceCall.ts` (gọi resource fail-closed), `revoke.ts` (best-effort RFC 7009, token chỉ trong body), `probe.ts` (`oidc:probe_result` CHỈ `{status,expected:401,aud}`, một-lần; exchange `other`→gọi `/demo/me`→bỏ token). `client.ts`: `startAudProbe` (revoke→authorize `other` scope `openid`, purpose), `finishAudProbe`, `restoreSessionSilently` (`prompt=none`, cờ `oidc:probe_relogin` ≤1), `consumeSilentRestoreFlag`, `demoApiUrl/userinfoUrl`. `transient.ts`+`authorize.ts`: thêm `purpose`. `router.tsx`: `/callback` nhánh aud-probe + silent-restore (lỗi silent⇒1 login tương tác, không `/error`). `discovery.ts`: thêm `revocation_endpoint?`.
- Verify thật: typecheck PASS; lint PASS; `vitest run` **176 pass** (25 files, +32 so 144 baseline); build PASS.
- Mutation (RED→khôi phục byte-identical, sha256 khớp probe.ts/router.tsx): (1) ghi token vào probe_result⇒probe.test RED; (2) `takeProbeResult` không xoá⇒one-shot RED; (3) silent-restore lỗi lặp `prompt=none`⇒router-probe RED.
- Smoke thật (BE dev `sso-idp`/Redis`/1`/Mailpit + FE :5173; user `dev@example.com`, KHÔNG in password): A `/demo/me`→**200** (sub 6aceed…48fb); C `/userinfo`→**200** (cùng sub, hồi quy Task 0 xanh). **BLOCKER**: consent cho resource `other` trả **500** (POST `/authorize/consent` ⇒ `decideConsent(other)` throw unexpected, trang "Request failed"); `demo` consent OK, re-auth `demo` skip-consent OK ⇒ lỗi riêng `other`. ⇒ nút B chưa smoke được end-to-end live (FE đúng + test đầy đủ). Báo tech-lead (fail-closed). Đã dừng FE/BE theo PID, xoá file tạm (gồm file pw). KHÔNG commit. Đề nghị: senior-reviewer + tech-lead xử BE consent `other`.

## backend-dev (Task 4 — DEBT-100) — 2026-10-15
- Preflight CodeGraph 1.6.2 (sync up-to-date); đọc code qua CodeGraph; Git Bash; UTF-8 no BOM. KHÔNG đụng fe-sso-test/, e2e/, mcp/agents. KHÔNG compose/flush/drop; chỉ ĐỌC index DB dev.
- Nguyên nhân gốc: DB dev `sso-idp` còn **index unique CŨ** `userId_1_clientId_1` trên `consents` (deploy trước DEBT-028, chưa chạy `db:sync-indexes`). Consent `demo` rồi `other` (cùng user×client) ⇒ vi phạm key cũ ⇒ E11000 dai dẳng (retry-once của `grant` không giải) ⇒ `decideConsent` ném non-`AuthorizeRedirectError` ⇒ controller 500. KHÔNG phải lỗi `grant`/seed/`scopes`/mapping; code+schema đã ĐÚNG.
- Fix: chạy `pnpm -C be db:sync-indexes` trên DB dev (DROP index cũ — runbook DEBT-028). KHÔNG sửa source. Int-test cũ che lỗi vì `syncAllIndexes` luôn chạy trên DB sạch ⇒ thêm repro controller-level.
- File đổi: `be/test/seed-dev.int-spec.ts` (+3 test: repro 500 với index cũ; fix sync⇒302; INV-8 token `other`→`/demo/me` 401; +import `DemoController`/`SESSION_COOKIE`). Resource thứ N: seed chỉ 2 resource ⇒ không resource khác dính cùng lớp lỗi.
- Verify thật: typecheck PASS; lint PASS; `pnpm -C be test` **205 pass**; `test:int` **502 pass** (499+3, 24 suites) — không regress. Mutation: `syncIndexes`→`ensureIndexes` ⇒ test "fix" RED; khôi phục byte-identical (sha256 `a187825…`). KHÔNG commit.
- Kết quả: **DONE** — Bàn giao: **senior-reviewer**. Ops: DB dev/E2E cần `db:sync-indexes` trước khi E2E nút B (run 25).

## senior-reviewer — 2026-10-16 — PASS
- Preflight CodeGraph (version/status/sync: up to date). Đọc diff qua git diff + CodeGraph; Git Bash; ghi UTF-8 không BOM. KHÔNG compose/flush/drop, KHÔNG commit.
- Verify độc lập: BE unit 205/205, FE vitest 176/176, tsc BE+FE sạch. BE int (502) không chạy lại vì container test đang tắt (cấm compose up) — dựa báo cáo backend-dev.
- Security invariants đã kiểm: mapping resourceId↔URI fail-closed ở 3 call-site, rotate refresh vẫn nguyên tử, anti-oracle introspect (DEBT-040), INV-8 `/demo/me`, tombstone ⇒ 401, demo allowlist raw env + 404 prod, FE không lộ token, `returnTo` chống open-redirect, probe kiểm state/iss/nonce. Không có 🔴.
- 🟡 → backlog DEBT-101…106: [FE] link `<a href>` làm mất session in-memory (101), `/callback?error` không xoá transient (102), probe chép chuỗi kiểm callback (103), hai whitelist mã lỗi (104); [BE] `identifiersFor` gọi 2 lần mỗi refresh (105), int test DEBT-100 phụ thuộc thứ tự (106). Ponytail: net -55 dòng.
- Kết quả: **PASS** — review: `review-senior.md`. Bàn giao: **tester**. Gợi ý: sửa DEBT-101/102 trước E2E run 25.

## tester — 2026-10-16 — PASS
- Preflight CodeGraph (version/status/sync: up to date). Đọc code qua CodeGraph/CLI; Git Bash; ghi UTF-8 không BOM. `docker start vg-test-mongo vg-test-redis` (container test có sẵn). KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`, KHÔNG E2E (run 25), KHÔNG commit, KHÔNG sửa code sản phẩm.
- Baseline chạy thật: BE typecheck/lint PASS, unit 205, int 502; FE typecheck/lint/build PASS, vitest 176.
- Test QA bổ sung (gap theo AC): `be/src/modules/demo/demo.gating.spec.ts` (mới, 6: route-level `ConditionalModule`+preflight — unset/production/staging/case-variant ⇒ 404, không 204); `demo.int-spec.ts` +3 (Redis `isEnded` lỗi ⇒ 5xx opaque, Mongo `identifiersFor` lỗi ⇒ 5xx, aud chưa đăng ký / client không có `demo` ⇒ 401); `seed-dev.int-spec.ts` +2 (Task 0 (c) URI trong allowedResources ⇒ userinfo 401 / refresh `invalid_grant` doc không đổi / RS introspect `active:false`, rồi khôi phục ⇒ 200; replay refresh ⇒ family revoke); `fe-sso-test/test/probe-purpose.test.tsx` (mới, 11: `isAudProbePending` thật + `/callback` purpose lạ/thiếu ⇒ login thường, không probe/fetch).
- Sau bổ sung: BE unit **211/211**, int **507/507**, FE vitest **187/187**; typecheck/lint/build sạch.
- Mutation RED rồi khôi phục byte-identical: `isDemoEnabled` fail-open (3 RED), refresh mapping (RED 200≠400), introspect mapping (RED active:true), FE `isAudProbePending` lỏng (5 RED).
- Kết quả: **PASS** — báo cáo `test-report.md`. Không debt mới. Bàn giao: **orchestrator** đóng run 24 (E2E T4 + T5 → run 25; nên sửa DEBT-101/102 trước).
