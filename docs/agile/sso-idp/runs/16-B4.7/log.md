# Log — run 16 — B4.7 (logout local/global + RP-initiated + front-channel)

## 2026-10-10 — analyst

- Preflight CodeGraph: v1.6.2; `codegraph sync` OK (2 file đổi, 68 node). Index cũ (v1.5.0) — cảnh báo re-index, không chặn đọc.
- Đọc đầu vào: STATUS.md; plan.md L196 (B4.7) + L99 (D4 postLogoutRedirectUris); spec §9.8 (L345–356); backlog DEBT-034/037/038/040/041; summary runs 07/08 (hiện trạng logout M2).
- Khám phá code (CodeGraph + grep): `ui.controller.ts` (GET /logout = form, POST /logout = revoke session + audit, chưa revoke family); `session.service.revokeAllForUser` SẴN SÀNG; `refresh-token.service.revokeFamily` keyed `familyId+clientId`, **chưa** revoke theo userId → cần DEBT-034; `refresh-token.schema` có `userId` + index; `discovery.controller` chưa quảng bá `end_session_endpoint`; `client.schema` có `postLogoutRedirectUris[]`.
- Sinh `tasks.md`: 5 task (T1 DEBT-034 revokeWhere/revokeAllForUser; T2 GET RP-initiated + DEBT-038; T3 POST local family + global scope=all; T4 front-channel iframe; T5 audit + int e2e).
- Phân loại DEBT: **034 & 038 TRONG PHẠM VI**; **037, 040, 041 DỜI** sang micro-run introspect-hardening sau B4.7 (lý do: cross-cutting/trực giao với logout, tránh scope creep + regress 311 int-test introspect).
- 2 quyết định mở cho tech-lead: OPEN-1 (ngữ nghĩa "family gắn phiên này" cho local logout khi token chưa mang sid) + OPEN-2 (GET có hint hợp lệ vẫn cần xác nhận POST — chọn fail-closed). Cả hai kèm phương án an toàn đề xuất.
- spec.md/plan.md KHÔNG sửa (đã tồn tại). Cổng → **tech-lead**.

## [2026-10-10 15:40] tech-lead
- Đã làm: Preflight CodeGraph (sync OK). Đối chiếu tasks.md với code thật: `refresh-token.service` (revokeFamily L330, rotate swap/self-revoke), `token.service.insertRefreshToken`, `session.service` (SessionData không bind client), `ui.controller` GET/POST /logout, `TokenVerifier`, CSP helmet `main.ts`, `logout.eta`.
- Chốt: OPEN-1 → `RefreshToken.sessionRef` (mint qua code → token → rotate), local logout = `revokeWhere({userId, sessionRef})`. OPEN-2 → GET chỉ render form; POST validate lại. DEBT-037/040/041 dời micro-run introspect-hardening. Task 4 = [BE].
- Fold 10 điểm vào tasks.md: open redirect qua hidden field, verify hint (exp lỏng, cấm at+jwt), RP set `sess_rp:{ref}`, CSP riêng cho trang front-channel, guard filter rỗng, thứ tự/audit POST.
- File đổi: runs/16-B4.7/review-techlead.md, runs/16-B4.7/tasks.md, backlog.md (DEBT-037/040/041 dời; +DEBT-043/044), STATUS.md
- Kết quả: PASS — đã fold chỉnh sửa, không cần analyst làm lại.
- Bàn giao: backend-dev — làm Task 1→2→3→4→5 theo bản fold (không có FE).

## [2026-10-10 15:55] backend-dev
- Da lam: Task 1->5 theo ban fold. `revokeWhere` (guard union dong, stamp-first INV-11) la cua revoke RefreshToken duy nhat; them `revokeAllForUser`/`revokeForSession`; `RefreshToken.sessionRef` lan qua SessionView.ref -> AuthzCodeData -> insertRefreshToken/rotate ke thua. `verifyIdTokenHint` (RS256, iss, chap nhan exp qua han, cam at+jwt, aud don). GET /logout chi render form + hidden tho; POST re-validate qua `LogoutService.resolvePostLogoutRedirect`, thu tu token->session->audit->clear->redirect, local vs `scope=all` (global doc `sess_rp` truoc khi revoke). Front-channel: `frontchannelLogoutUri` (client schema/service), Redis `sess_rp:{ref}` (SADD luc mint code; xoa o revokeRef + Lua revokeAll), trang trung gian `logout-frontchannel.eta` + script tinh `public/logout-redirect.js`, CSP frame-src chi override trang nay. Discovery `end_session_endpoint`.
- File doi: oauth/token/refresh-token.service.ts(+schema), oauth/token/token.service.ts, oauth/authorize/authorize.service.ts + authorize.controller.ts, oauth/code/authorization-code.service.ts, sessions/session.service.ts, keys/token-verifier.ts, clients/client.service.ts(+schema), oauth/discovery/discovery.controller.ts, ui/ui.controller.ts + ui.module.ts, oauth/oauth.module.ts, common/http/http.types.ts, views/logout.eta; NEW oauth/logout/logout.service.ts(+spec), views/logout-frontchannel.eta, public/logout-redirect.js; eslint.config.mjs (ignore src/public); tests: keys.spec, refresh-token/ui/ui-auth/authorize/discovery int-spec.
- Bug/fix: (1) front-channel view tra 201 (POST mac dinh) -> reply.status(200). (2) ui-auth/authorize int-spec thieu provider DI moi -> them stub/SessionService (config token ns). (3) CRLF + no-undef tren asset JS -> LF + ignore src/public.
- Ket qua: DONE - typecheck OK, lint OK, pnpm test 114/114, pnpm test:int 325/325 (tong 439; baseline 405 + 34). Test race INV-11 cua B4.5 van xanh.
- Ban giao: senior-reviewer - review 5 task (INV-11 qua revokeWhere, open-redirect guard POST, CSP trang front-channel, sessionRef pre-B4.7 khong bi local logout).

## [2026-10-10 16:28] senior-reviewer
- Đã làm: Preflight CodeGraph (sync OK). Review diff + file mới (refresh-token.service, token-verifier, logout.service, ui.controller, session.service, authorize.service, client.service, views/public, tests). Chạy lại: tsc OK, unit 114/114, int 325/325.
- Kết quả: **REJECT**. Code lõi đúng: `revokeWhere` stamp-first + guard + cast, interleaving rotate↔global/local đóng, `verifyIdTokenHint`, POST tính lại redirect exact-match, CSRF, CSP chỉ ở trang front-channel. 🔴 chủ yếu là thiếu bằng chứng: (1) int race INV-11 cho `{userId}`/`{userId,sessionRef}`, (2) unit âm guard filter rỗng, (3) test inject lỗi thứ tự fail-closed của POST, (4) chuỗi `sessionRef` authorize→code + e2e logout→refresh `invalid_grant`/cookie cũ, (5) int `sess_rp` cleanup + validate `frontchannelLogoutUri`, (6) GET /logout thiếu `Cache-Control: no-store`.
- 🟡: `@Length(512) state` → 400 chặn logout; GET phản chiếu URI chưa validate; bước sau revoke chưa fail-open; CSP viết tay mất base-uri/form-action/object-src + host chứa `;` lọt vào origin; audit global thiếu count session; DEBT-043 cũng áp dụng cho local. Ponytail -6 dòng.
- File đổi: runs/16-B4.7/review-senior.md, runs/16-B4.7/log.md, STATUS.md
- Bàn giao: backend-dev — sửa 6 🔴 (chủ yếu thêm test + 1 header), nên xử lý luôn các 🟡 rẻ (state length, fail-open, CSP).

## [2026-10-10 17:10] backend-dev (retry1)
- Da lam 6 BLOCKER: (1) 2 int race INV-11 tat dinh cho revokeAllForUser va revokeForSession (gateInsert nhan minter; scope {userId}/{userId,sessionRef}); (2) unit spec am refresh-token.service.spec.ts (guard filter rong/userId non-hex/familyId+clientId thieu -> reject + updateMany khong goi); (3) 3 test fail-closed ordering POST /logout (revokeForSession/sessions.revoke reject-once -> 5xx, session song, no clear/audit, retry 302) + 1 fail-open sau revoke; (4) authorize.int-spec assert issueCode stamp session.ref + e2e that trong refresh-token.int-spec (session that -> code -> /token -> rotate -> revokeForSession giet family, device khac song, cookie het session); (5) sessions.int-spec sess_rp (SADD idempotent/TTL, xoa o revoke+Lua revokeAll, clientsForUser union) + clients.int-spec tu choi frontchannelLogoutUri (non-https/wildcard/fragment/relative/host co ';'); (6) GET /logout Cache-Control:no-store + test.
- ?? fix: bo @Length(512) state (service tu cat) -> 4096; GET chi phan chieu post_logout_redirect_uri khi resolve != default; fail-open sau revoke (try/catch -> default redirect); CSP front-channel giu base-uri/object-src/script-src-attr/form-action/upgrade-insecure-requests + loc origin co ;/,/ws (them ca o redirect-uri.validator); audit global SESSION_REVOKED them count. Ponytail: bo formaction trung action o logout.eta.
- Bug/fix: cfg refresh-token.int-spec thieu sessionIdleTtl/absoluteTtl cho SessionService -> them vao token ns. Bo BOM 4 file (logout.service.ts/.spec.ts, logout-frontchannel.eta, logout-redirect.js). Xoa file rac '=30'/'=196'.
- File doi: ui.controller.ts, logout.service.ts, redirect-uri.validator.ts, views/logout.eta; NEW refresh-token.service.spec.ts; tests: refresh-token/ui/sessions/clients/authorize int-spec. KHONG dung .vscode/mcp.json, .mcp.json, .github.
- Ket qua: DONE - typecheck OK, lint OK, pnpm test 119/119 (unit, +5 guard), pnpm test:int 343/343 (18 suites). Race INV-11 chay 3 lan deu xanh (4/4 moi lan). DEBT-043 de senior ghi.
- Ban giao: senior-reviewer (luot 2) - review 6 blocker da co bang chung + ??.

## [2026-10-12 08:40] senior-reviewer (lượt 2)
- Đã làm: Preflight CodeGraph (sync OK). Chạy lại tsc/lint OK, unit 119/119, int 343/343. Mutation test 7 lần (khôi phục byte-identical): M1 guard, M3 re-read, M4 sessionRef kế thừa, M5 thứ tự controller, M6 issueCode → test fail đúng; M2 (đảo stamp `familyRevokedAt` xuống sau `revokedAt`) → **mọi test vẫn xanh**.
- Kiểm thêm: `redirect-uri.validator` regex chỉ trên `parsed.host` → không phá redirect_uris hợp lệ (IPv6/IDN/userinfo qua; `%20` URL throw; `%3B`→`;` bị chặn). Fail-open sau revoke → hằng `/login?loggedOut=1`, không open-redirect.
- Kết quả: **REJECT** — 5/6 🔴 đóng; 🔴#1 còn: chưa có test tất định giữ thứ tự stamp-first INV-11 (`gateInsert` park sau insert S nên không phân biệt thứ tự; lỗ hổng có từ B4.5).
- File đổi: runs/16-B4.7/review-senior.md, runs/16-B4.7/log.md, STATUS.md
- Bàn giao: backend-dev — thêm race test park A trước insert + park B sau stamp đầu (kỹ thuật trong review), đổi tên test L912; 🟡: case `;`/`,` ở validator spec, fail-open nhánh no-session.
## [2026-10-12 09:05] backend-dev (retry2)
- Da lam 1 BLOCKER con lai: helper gateInsertBeforeAndFirstUpdate (park A TRUOC insert S qua spy insertRefreshToken; park B SAU updateMany dau tien qua spy refreshModel.updateMany mockOnce + wrap exec) + 2 int test tat dinh "ordering (INV-11)" cho scope {userId} (revokeAllForUser) va {userId,sessionRef} (revokeForSession): A=400 invalid_grant, moi doc family revokedAt, parent co familyRevokedAt. Doi ten test L912 -> "sets both ... stamps" + sua comment (khong con "ordering proven").
- ?? validator: them 3 case am (;, ',', %3B) + 1 case duong (IPv6 [2001:db8::1], IDN punycode) vao redirect-uri.validator.spec.ts. ?? logout: nhanh no-session POST /logout boc try/catch -> defaultRedirect (fail-open, cookie da clear) + 1 test (xoa happy-path trung voi test co san L1032).
- Mutation (tu chung minh, da khoi phuc byte-identical): (A) dao revokeWhere ghi familyRevokedAt xuong SAU revokedAt -> 2 ordering test FAIL (A nhan 200, S song). (B) bo try/catch nhanh no-session -> test fail-open no-session FAIL (500). Khoi phuc -> xanh; git diff service file khong co gi ngoai thay doi prior-run (thu tu stamp giu nguyen familyRevokedAt->reuseDetectedAt->revokedAt).
- File doi: be/test/refresh-token.int-spec.ts (helper + 2 test + doi ten), be/test/ui.int-spec.ts (1 test fail-open no-session), be/src/modules/clients/redirect-uri.validator.spec.ts (4 case), be/src/modules/ui/ui.controller.ts (try/catch no-session). Xoa file rac "=1". KHONG dung .vscode/mcp.json, .mcp.json, .github.
- Ket qua: DONE - tsc OK, pnpm lint (eslint src) OK, pnpm test 123/123 (unit +4 validator), pnpm test:int 346/346 (18 suites, +3). Race+ordering chay 3 lan deu 6/6 (0 fail). CHUA commit.
- Ban giao: senior-reviewer (luot 3) - xac nhan ordering test bat duoc regression (mutation da chung minh), 2 ?? da xu ly.

## [2026-10-12 09:05] senior-reviewer (lượt 3)
- Preflight CodeGraph v1.6.2, sync OK. Đã đọc: STATUS, review-senior lượt 2, log, `revokeWhere`, helper `gateInsertBeforeAndFirstUpdate`, 2 test ordering, nhánh no-session của ui.controller, validator spec.
- Tự chạy mutation: chuyển stamp `familyRevokedAt` xuống sau `revokedAt` → refresh-token.int-spec 344 pass / **2 FAIL** (đúng 2 test `ordering (INV-11)`: Expected 400, Received 200). Đã khôi phục: sha256 khớp (8d04c36e…1bd4), byte-identical.
- Chạy lại: tsc OK, `pnpm lint` OK, unit 123/123, int 346/346. `eslint src test` báo 2 lỗi prettier trong test/ (script lint không phủ thư mục này) → DEBT-045.
- Kết luận: **PASS**. 🟡 → backlog: DEBT-043 mở rộng cho local logout, DEBT-045 (lint chưa phủ test/), DEBT-046 (gộp ponytail/nit).
- Không sửa code. Không đụng file ngoài phạm vi (`.vscode/mcp.json`, `.mcp.json`, `.github/agents/*`).
- Bàn giao: **tester**.
## [2026-10-12 09:10] tester (lượt 1)
- Preflight CodeGraph v1.6.2 (status OK: 154 files / 2.524 nodes). Đọc STATUS, tasks.md (gồm *(tech-lead fold)* 5 task), review-senior lượt 3, log, mã `logout.service.ts` + `ui.controller.ts` (GET/POST logout), các spec hiện có.
- Đối chiếu acceptance (B4.7 Task1–5 + fold) với suite: GET-không-huỷ, CSRF bắt buộc, local-theo-sessionRef (thiết bị khác sống), global theo userId (user khác không đụng), open-redirect âm + re-validate ở POST, hint hết-hạn-chấp-nhận / access-token-từ-chối / aud-sub-lệch, discovery `end_session_endpoint`, front-channel iframe + CSP, fail-closed/fail-open — đều đã có ≥1 test.
- Bổ sung **4 test unit QA** vào `logout.service.spec.ts` (lỗ hổng coverage, không trùng dev): `verifyHint` direct (happy), **fail-closed null khi client bị xoá**, null khi verify throw; **`frameSrcOrigins` injection-safe sink** (Task 4 CSP invariant). Sửa 1 lỗi prettier phát sinh → lint `src` sạch.
- Chạy full suite thật (Mongo vg-test-mongo@27117 rs0 + Redis vg-test-redis@6479 Up): `pnpm typecheck` OK, `pnpm lint` (eslint src) OK, `pnpm test` **127/127** (baseline 123 +4 QA), `pnpm test:int` **346/346** (18 suites). Tổng **473** (> 469 baseline, > 405 yêu cầu). KHÔNG FAIL.
- File đổi: `be/src/modules/oauth/logout/logout.service.spec.ts` (+4 test), `runs/16-B4.7/test-report.md`, `runs/16-B4.7/log.md`, `STATUS.md`. Dọn temp helper QA. KHÔNG sửa code sản phẩm; KHÔNG đụng `.vscode/mcp.json`/`.mcp.json`/`.github/agents/*`.
- Ghi chú không chặn: stray file rỗng `=1` ở gốc repo tồn tại từ trước phiên (0-byte, untracked) — dev dọn trước commit; DEBT-045 (lint chưa phủ `test/`) đã trong backlog.
- Kết quả: **PASS** (cổng tester). Bàn giao: **orchestrator** đóng run. Code CHƯA commit.
## [2026-10-12] orchestrator
- Đã làm: commit code B4.7 `8613b4f`; viết `summary.md`; cập nhật `STATUS.md` (đóng run 16, thêm dòng Tiến độ).
- Kết quả: DONE — run 16 đóng.
