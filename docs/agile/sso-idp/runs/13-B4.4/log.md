# Log — run 13 — B4.4 (/token authorization_code)



## [2026-10-08 13:45] analyst
- Đã làm: chốt **Q6** (token/session TTL → production) trong plan.md §12 (đọc từ config/env đã có, không hard-code); viết `tasks.md` 4 task B4.4 (atomic, acceptance đo được, security invariants), chốt rõ ranh giới B4.4↔B4.5.
- File đổi: `plan.md` (§12 Q6), `runs/13-B4.4/tasks.md`, `STATUS.md`.
- Kết quả: DONE — spec/plan không viết lại (chỉ Q6). Preflight CodeGraph OK (index up to date, v1.6.2).
- Bàn giao: **tech-lead** — review tasks.md + kiến trúc `/token`/`TokenService`.

## [2026-10-08 14:30] tech-lead
- Đã làm: Preflight CodeGraph OK (v1.6.2, sync). Review tasks.md B4.4 + Q6, đối chiếu code (`AuthorizationCodeService` Lua, `ClientAuthenticationService`, `TokenSigner`, `OAuthExceptionFilter`, `ValidationPipe`, `ClientSchema`/`RefreshTokenSchema`, `OauthModule`/`KeysModule`). Q6 giữ nguyên. Fold acceptance vào tasks.md: INV-13 bind cả PKCE challenge trong Lua (ARGV[3]); resource vắng = `undefined` → `invalid_target`; lỗi OAuth domain (`invalid_grant`/`unsupported_grant_type`/`invalid_target`/`unauthorized_client`) + `no-store` cả trên lỗi; parse body riêng (bỏ qua `forbidNonWhitelisted`); quy tắc nhận diện phương thức client auth; `grantTypes` chuẩn hoá khi đọc lean + enum; ID token chỉ khi có `openid`; `authTime` optional; admin resource suy từ ISSUER; failure semantics fail-closed + concurrency; audit `TOKEN_ISSUED`. CORS chốt dời sang B4.6.
- File đổi: `runs/13-B4.4/review-techlead.md`, `runs/13-B4.4/tasks.md`, `backlog.md` (DEBT-029/030 mới; DEBT-019/020/026/027 → B4.6), `STATUS.md`.
- Kết quả: **PASS**.
- Bàn giao: **backend-dev** — làm Task 1→4 theo tasks.md (đọc các dòng *(tech-lead fold)*).

## [2026-10-08 14:45] backend-dev
- Đã làm: Task 1→4 B4.4 `/token` authorization_code (+ mọi fold). `grantTypes[]` vào ClientSchema (enum) + chuẩn hoá lean trong ClientService; `TokenService` (claims access/id, D3 auth_time admin, openid-gated id_token, amr/acr hằng, D7 refresh hash-only, audit TOKEN_ISSUED fail-closed); `AuthorizationCodeService.consume` bind thêm PKCE challenge trong Lua (ARGV[3], INV-13); `TokenController` (form parse riêng, client auth basic/post/none, lỗi OAuth domain + no-store/WWW-Authenticate, invalid_target/invalid_grant/unauthorized_client/unsupported_grant_type); wire OauthModule + KeysModule.
- File đổi: oauth/token/{token.service,token.controller,token.errors,token.service.spec}.ts, oauth/code/authorization-code.service.ts, oauth/oauth.module.ts, clients/{client.service,schemas/client.schema}.ts, test/{token.int-spec,clients.int-spec,authorization-code.int-spec,authorize.int-spec}.ts.
- Kết quả: DONE — build+typecheck+lint sạch; unit 80/80 (13 mới), int: token 19/19, authorization-code 12/12, authorize 39/39, clients 33/33 (hạ tầng vg-test-mongo@27117 + vg-test-redis@6479).
- Bàn giao: **senior-reviewer** — review 4 task + fold, chú ý INV-13 Lua challenge, fail-closed failure semantics.

## [2026-10-08 14:55] senior-reviewer
- Đã làm: Preflight CodeGraph OK (v1.6.2, sync). Review diff B4.4 (`token.{controller,service,errors}.ts`, Lua consume ARGV[3], `grantTypes`, wiring) + test, đối chiếu tasks.md/review-techlead.md. Đã kiểm: INV-13 (PKCE bind trong Lua trước DEL), INV-1/2 race, client auth trước consume, D7 hash-only, no-store trên cả response lỗi, mô tả lỗi tĩnh, không log secret.
- File đổi: `runs/13-B4.4/review-senior.md`, `STATUS.md`.
- Kết quả: **REJECT** — 🔴 thiếu int test failure semantics fail-closed (Redis consume lỗi / insert RefreshToken lỗi / signer lỗi → 500 `server_error`, không token, không rò input) mà Task 4 fold đã yêu cầu. 🟡 `decodeURIComponent` trên Basic sai định dạng → 500 thay vì 401 (token.controller.ts:193-194). Ponytail net -8.
- Bàn giao: **backend-dev** — sửa 🔴 + 🟡 theo review-senior.md.

## [2026-10-08 15:20] backend-dev (retry 1/2)
- Đã làm: sửa đủ theo review-senior.md. 🔴 thêm 3 int test fail-closed (jest.spyOn consume/refreshModel.create/TokenSigner.sign reject → 500 `server_error`, no-store, body không có access/id/refresh_token, `JSON.stringify(body)` không chứa code/verifier/SECRET-detail; restore trong finally). 🟡 bọc 2 `decodeURIComponent` của Basic trong try/catch → `TokenError('invalid_client',401)` + test `%ZZ:x`. Nit/ponytail: so media type chính xác (`split(';')[0].trim().toLowerCase()`), bỏ try/catch quanh `Buffer.from`, gộp header-reading vào `basicHeader(req)` dùng chung (renderError + resolveClientAuth), bỏ tham số `description` không dùng ở TokenError, gộp import `@nestjs/common`.
- File đổi: oauth/token/{token.controller,token.errors}.ts, test/token.int-spec.ts.
- Kết quả: DONE — build+typecheck+lint(src+int-spec) sạch; unit 80/80; int: token 23/23 (+4), authorization-code 12/12, authorize 39/39, clients 33/33 (vg-test-mongo@27117 + vg-test-redis@6479).
- Bàn giao: **senior-reviewer** — review lại 🔴 fail-closed + 🟡 Basic decode + nit/ponytail.

## [2026-10-08 15:22] senior-reviewer (vòng 2)
- Đã làm: Preflight CodeGraph OK (v1.6.2, sync). Re-review delta: 3 int test fail-closed (consume/refresh create/signer reject → 500 `server_error`, no-store, không token, không rò code/verifier/chi tiết lỗi); `parseBasic` try/catch decode → 401 `invalid_client` + WWW-Authenticate (test `%ZZ`); nit/ponytail đã áp (media type chính xác, `basicHeader` dùng chung, bỏ `description?`, gộp import). Đã kiểm hồi quy WWW-Authenticate/content-type/log.
- File đổi: `runs/13-B4.4/review-senior.md` (mục Vòng 2), `STATUS.md`.
- Kết quả: **PASS** — tsc + eslint sạch; unit 80/80; int 229/229 (token 23/23). Không có DEBT mới.
- Bàn giao: **tester**.
## [2026-10-08 15:40] tester
- Đã làm: Preflight CodeGraph OK (v1.6.2, sync up-to-date). Đối chiếu 4 task B4.4 + mọi fold với test hiện có (token.service.spec 13, token.int-spec, clients/authorization-code/authorize int-spec). Thêm 1 int test Task1-fold end-to-end: legacy client không có grantTypes → /token 200 (không 500), refresh vắng. Chạy thật trên vg-test-mongo@27117 rs0 + vg-test-redis@6479.
- File đổi: be/test/token.int-spec.ts (+1 QA test), runs/13-B4.4/test-report.md, STATUS.md, log.md.
- Kết quả: PASS — build+typecheck+lint sạch; unit 80/80; int 230/230 (token 24/24). Mọi acceptance + security invariant có ≥1 test thật. Không FAIL, không DEBT mới.
- Bàn giao: orchestrator — đóng run 13-B4.4.
