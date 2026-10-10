# Log — run 15 — B4.6 (/userinfo + discovery + /introspect)

## analyst (2026-10-10)
- Preflight CodeGraph: v1.6.2, `status` OK (169 files / 2649 nodes), `sync` cập nhật 1 file (47 nodes). Index engine v1.5.0 → chỉ cảnh báo, không chặn.
- Đọc qua CodeGraph/Git Bash: `token-signer.ts`, `token-verifier.ts`, `token.service.ts` (signAccessToken), `keys.controller.ts` (`@Get('jwks.json')`), `refresh-token` schema, `user.schema.ts`, `client.schema.ts` (`allowedResources`/`allowedCorsOrigins`), `client-authentication.service.ts`, `resources/*`, spec §12/§214/§343, plan §5/D7/Q4.
- Phát hiện chính: (1) access token là JWT **không lưu DB** → introspect revoke chỉ đảm bảo cho **refresh** (DB) + **exp** cho access (OPEN-1, khớp §214). (2) `TokenVerifier.verify` ép 1 `aud` → `/userinfo` cần policy aud (OPEN-2). (3) `jwks_uri` thực tế = `{issuer}/jwks.json` → discovery phải khớp. (4) D7 (Q4) đã CHỐT → `offline_access` vào `scopes_supported`.
- Viết `tasks.md`: 4 task [BE] (discovery+DEBT-033 / userinfo+DEBT-019+020 / introspect / dọn nợ DEBT-035+036). 2 quyết định mở (OPEN-1, OPEN-2) kèm phương án fail-closed đề xuất.
- DEBT **DỜI**: DEBT-026/027 (consent atomicity) — ngoài phạm vi endpoint B4.6, gắn B4.6 chỉ là mốc thời gian; đề nghị tech-lead gắn lại mốc (trước consent prod / B7) hoặc tách run 15b.
- spec.md / plan.md **không** chỉnh (đã có; sẽ bổ sung §10/§11/§214 ở bước dev theo task 3/4).
- Cổng → **tech-lead** (cần chốt OPEN-1, OPEN-2 + xác nhận DEBT dời).

## [2026-10-10 12:30] tech-lead
- Đã làm: Preflight CodeGraph (v1.6.2, sync OK); đối chiếu TokenVerifier/Signer, token.service, refresh schema, client auth, CORS, routes. Chốt OPEN-1 (access exp-only + liveness client/aud/user), OPEN-2 (userinfo nhận mọi aud, `typ=at+jwt` + `verifyAccessToken`), đồng ý dời DEBT-026/027 → run consent-hardening sau B4.7.
- Fold vào tasks.md: introspect chỉ confidential client + authz caller (IDOR) + failure 500 fail-closed; userinfo chống ID-token confusion, Bearer chỉ header, whitelist profile, CORS hook thủ công; discovery thêm `client_secret_post`, bỏ `end_session_endpoint` đến B4.7.
- File đổi: runs/15-B4.6/review-techlead.md, runs/15-B4.6/tasks.md, backlog.md (DEBT-037/038/039; mốc DEBT-026/027), STATUS.md
- Kết quả: PASS — kèm fold bắt buộc (*(tech-lead fold)*)
- Bàn giao: backend-dev — làm Task 1→2→3→4 theo tasks.md đã fold
## [2026-10-10 12:40] backend-dev
- Đã làm: Task 1 discovery (`DiscoveryController`, URL ghép từ issuer, bỏ `end_session_endpoint`); Task 2 `GET /userinfo` (`verifyAccessToken` + `typ=at+jwt`, whitelist profile, Bearer header, CORS); Task 3 `POST /introspect` (chỉ confidential client, IDOR/aud authz, fail-closed 500); Task 4 bỏ test CONCURRENT ngẫu nhiên + helper `gateInsert()`, guard `!parent` fail-closed, spec §10 `familyRevokedAt` + sửa §214.
- Preflight CodeGraph OK (v1.6.2, sync up-to-date); đọc code qua Git Bash; CORS = hook thủ công, gỡ `@fastify/cors` (lockfile đã cập nhật qua pnpm).
- File đổi: token-signer/verifier, token.service, token.controller, oauth.module, keys.controller/module/spec, client.schema, main.ts; mới: client-auth-request, client-cors.helper, discovery/userinfo/introspect controllers + 3 int-spec; token/refresh/indexes int-spec; spec.md; be/package.json + pnpm-lock.yaml.
- Kết quả: DONE — typecheck/lint sạch; `pnpm test` 80/80; `pnpm test:int` 295/295 (tổng 375, +33 so 342); race tất định 20/20 không flaky.
- Bàn giao: senior-reviewer — review Task 1→4 (chú ý CORS hook main.ts không test trực tiếp qua AppModule; đã test lại hook trong userinfo.int-spec).
## [2026-10-10 12:48] senior-reviewer
- Đã làm: Preflight CodeGraph (v1.6.2, up to date); review diff be/ (Task 1→4) đối chiếu tasks.md + review-techlead.md; lượt security invariant + ponytail. Xác nhận `typ: at+jwt` không làm hỏng consumer (`verify()` không pin typ; ID token vẫn `JWT`; FE không đọc header).
- Kết quả: **REJECT** — 2 🔴: (1) `/introspect` nhánh access thiếu liveness OPEN-1 (client tồn tại, `aud ∈ allowedResources` của token client, user tồn tại) trong khi JSDoc + spec §214 khẳng định có; test không seed user mà vẫn assert `active:true`. (2) Thiếu test: `/token` phát access `typ: at+jwt`/ID `typ: JWT`; `verifyAccessToken` với alg/iss/exp/claim thiếu/`aud` mảng. 6 🟡 (CORS hook main.ts không test, `Vary` khi không Origin, ACAO cho 401 `/userinfo`, kiểm kiểu claim, trùng parse form, Keys→Clients dependency), 4 💭, ponytail net -60.
- Bàn giao: backend-dev — sửa 2 🔴 (khuyến nghị kèm các 🟡 rẻ); xem `review-senior.md`.

## [2026-10-10 13:20] backend-dev (retry 1)
- 🔴1 liveness `/introspect`: tách hàm chung `isAccessTokenLive` (`oauth/access-token-liveness.ts`, dùng cho cả `/userinfo` + `/introspect`, không copy) — kiểm `sub` ObjectId hợp lệ, client còn tồn tại + `aud ∈ allowedResources`, user tồn tại; inject `User` model + `ClientService` vào introspect; sửa test seed user thật; thêm 5 test: client bị xoá, aud bị gỡ, user không tồn tại, sub sai định dạng → `active:false`, và DB-fault khi liveness → 500 (fail-closed, không nuốt thành active:false).
- 🔴2 test: thêm `/token` int-spec decode header response thật (access `typ:at+jwt` + RS256, id `typ:JWT`); thêm `describe(verifyAccessToken)` ở keys.spec: từ chối HS256, iss sai, thiếu exp, thiếu sub/jti/client_id/scope, aud mảng, ID token (typ JWT); +kiểm `typeof` string cho sub/client_id/scope/jti trong `verifyAccessToken` (→401, không 500).
- 🟡 làm luôn: `registerCorsPreflight` dùng chung main.ts + userinfo.int-spec (bỏ bản copy; thêm case preflight `/token`); `Vary: Origin` luôn gửi trên discovery/JWKS; ACAO union-allowlist trên 401/403 `/userinfo` (2 test mới: registered→ACAO, evil→không); gộp parse form `/token`+`/introspect` vào `common/http/form.ts` (`FormParseError` trung lập, mỗi controller map error riêng); gộp 2 import `@nestjs/common` ở keys.controller.
- KeysModule→ClientsModule: **để debt** (di chuyển route JWKS sang oauth/ là thay đổi cấu trúc + sửa keys.spec, không "đơn giản"); senior ghi DEBT nếu cần.
- Verify (Git Bash, containers vg-test-mongo@27117 / vg-test-redis@6479): typecheck sạch, lint (src+test) sạch; `pnpm test` **94/94**; `pnpm test:int` **304/304** (18 suites, 0 fail). Tổng 398 (+23 so 375). KHÔNG commit.
- Bàn giao: **senior-reviewer** (lượt 2).

## [2026-10-10 14:55] senior-reviewer (lượt 2)
- Đã làm: Preflight CodeGraph (sync); xác minh 2 🔴 lượt 1 + 5 🟡 dev sửa; tự chạy typecheck/lint sạch, unit 94/94, int introspect/userinfo/token/discovery 67/67.
- Kết quả: **PASS** — 🔴#1 liveness `/introspect` qua `isAccessTokenLive` chung (4 case âm + DB fault 500); 🔴#2 test header `at+jwt`/`JWT` từ `/token` thật + unit `verifyAccessToken` đủ case. Thứ tự liveness→authz không tạo oracle qua body (chỉ timing, blast radius thấp); refactor form giữ nguyên hành vi `/token`.
- Debt: DEBT-040 (đảo authz trước liveness), DEBT-041 (test aud chưa cô lập), DEBT-042 (Keys→Clients). 5 💭, ponytail net -15.
- Bàn giao: **tester**.

## [2026-10-10 15:10] tester
- Đã làm: Preflight CodeGraph (v1.6.2, index up-to-date); đọc STATUS/tasks (gồm *(tech-lead fold)*)/review-senior/review-techlead; đọc 3 controller + 3 int-spec qua CodeGraph/CLI. Đối chiếu acceptance→test: dev/senior đã phủ rất đầy đủ. Xác định 7 khe fold chưa phủ và **tự viết bổ sung 7 test int** (KHÔNG sửa code sản phẩm): `/userinfo` HS256 alg-confusion / wrong-iss (key thật) / thiếu-exp / scope profile-không-email; `/introspect` caller auth `client_secret_post` (đúng+sai secret) / `token_type_hint` không tin (branch theo shape). Xác minh DEBT-019 (`@fastify/cors` đã gỡ, 0 match) + DEBT-020 (index `{allowedCorsOrigins:1}` trong indexes.int-spec) + `/introspect` không CORS + DEBT-035 (2 race tất định).
- Kết quả: **PASS** — chạy thật (Git Bash, containers vg-test-mongo@27117 rs0 / vg-test-redis@6479): typecheck sạch, lint sạch, `pnpm test` **94/94**, `pnpm test:int` **311/311** (18 suites, +7 so 304). Tổng **405**. Không FAIL. Mọi acceptance + security invariant/risk-matrix có ≥1 test; fail-closed (DB fault→500, không nuốt thành active) và negative actor (IDOR/confused-deputy) đã phủ.
- test-report.md: `runs/15-B4.6/test-report.md` (bảng acceptance→test→PASS, lệnh + output thực tế).
- Bàn giao: **orchestrator** — đóng run 15 (cổng tester PASS). Code chưa commit.
