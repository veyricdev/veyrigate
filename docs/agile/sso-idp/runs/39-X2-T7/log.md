# Log — run 39 — X2 E2E đầy đủ + T7

## orchestrator — 2026-10-20
- M7 tiếp. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan X2, T7 (+ X5 truy vết). Hiện có E2E: login, api-test, lab (8 kịch bản + replay), federation (4). Cổng → tech-lead.

## tech-lead — 2026-10-20
- Preflight CodeGraph (sync OK). Đối chiếu: admin-clients.controller (clientId server sinh, POST/PATCH `RequireRecentAuth(5)`), StepUpGuard (refresh-grant token không `auth_time` ⇒ 403), seed.ts (`fe-admin` confidential, secret in 1 lần ra stdout), seed-dev, ui.controller logout (`scope=all`), session.service tombstone, fe-sso-test client/env (build-time client_id, không nút refresh), e2e config/support/spec.
- **PASS có fold** (`tasks.md` mục "Fold tech-lead"). Q-39.1: seed E2E `be/test/e2e/seed-e2e-admin.ts` (guard NODE_ENV=test + DB `sso-idp-e2e`, secret biết trước) + flow OAuth thật fe-admin, chặn redirect :3000. Q-39.2: spawn Vite fe-sso-test :5174 với client_id runtime, không sửa app. Q-39.3: Task 0 backend-dev; 1–3 frontend-dev; 4 tester.
- Consent dời sang client mới (tất định); refresh/reuse truy vết về `lab.spec.ts`; step-up qua refresh-grant token. Chống flaky: retries 0, không sleep, context mới mỗi test, xanh 2 lần + `--repeat-each=3`.
- Debt mới: DEBT-240…243. Không sửa code, không commit, không chạm DB.

## backend-dev (Task 0) — 2026-10-20
- Security: tài sản = credential `fe-admin` + super_admin trên `sso-idp-e2e`; guard fail-closed TRƯỚC kết nối (`NODE_ENV=test` + tên DB trong `MONGO_URI` đúng `sso-idp-e2e` + secret ≥32), lỗi không echo URI/secret; `seedE2eAdmin` tự chặn `NODE_ENV≠test` trước ghi; secret ngẫu nhiên của `seedBootstrap` bị bỏ, không in.
- Mới: `be/test/e2e/seed-e2e-admin.ts` (+ `.spec.ts` 16 unit), `be/test/seed-e2e-admin.int-spec.ts` (6: idempotent, secret lệch ⇒ revoke + version kế, admin khoá/đổi mật khẩu ⇒ reset, NODE_ENV dev ⇒ không ghi, output không chứa secret/password). Script `seed:e2e-admin`; webServer `db:seed-dev → seed:e2e-admin → start:e2e`; marker `seed-e2e-admin` trong `assert-dist-clean.mjs`; `env.ts` export `ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD/E2E_FE_ADMIN_SECRET`; `.gitleaks.toml` allowlist đúng giá trị placeholder (gitleaks không cài local ⇒ CI xác nhận).
- Bug tự bắt khi RED: `passwordHash` `select:false` ⇒ phải `select('+passwordHash')` (nếu không, reset mỗi lần); hash hỏng throw đồng bộ ⇒ try/catch.
- Âm (CLI, Mongo giả `127.0.0.1:1` để chứng minh chưa kết nối): `NODE_ENV=development` ⇒ exit 1 "refusing to run with NODE_ENV=development (only test)"; `MONGO_URI=.../sso-idp` ⇒ exit 1 "MONGO_URI must name the database sso-idp-e2e exactly"; secret ngắn ⇒ exit 1.
- Thật trên `sso-idp-e2e`: E2E chạy 1 ⇒ "credential replaced (v2)"; chạy lại seed cùng `beEnv()` ⇒ "credential unchanged", "admin user unchanged"; credential `fe-admin` [v1 revoked, v2 active] không đổi. grep log secret/password/`client_secret` = 0.
- Verify: `pnpm -C be typecheck`/`lint` sạch; `pnpm -C e2e typecheck` sạch; `build` + `assert-dist-clean` ⇒ "be/dist clean"; BE unit 382/382 (366+16); int 1199/1199 (1193+6); `pnpm -C e2e e2e` 16 passed (92s). Không debt mới. Không process còn chạy (4000/5173/5174 trống).

## frontend-dev (Task 1–3) — 2026-10-20
- Task 1 `e2e/tests/logout.spec.ts` (2 test, context A/B cùng user dev): local ⇒ AT A `/userinfo` 401, AT B 200, B Sign in lại về claims không qua `/login`; global ("Sign out everywhere") ⇒ AT A, B 401, RT A `refresh_token` 400 `invalid_grant`, A Sign in thấy form login. Assert chỉ status/boolean.
- Task 2 `e2e/tests/admin-client.spec.ts` (`describe.serial`, 3 test) + `support/admin.ts` (flow OAuth thật `fe-admin`, PKCE S256, `client_secret_basic`) + `support/rp-server.ts` (Vite thứ hai, cổng trống động + `--strictPort`, `taskkill /T /F` trên Windows). Lệch fold: `route` không thấy redirect hop ⇒ đọc `code` từ `Location` của 302 về `localhost:3000` (điều hướng lỗi kết nối là chủ đích); đã kiểm `state`/`iss`. Step-up: refresh-grant ⇒ 403 `step_up_required`/`max_age:0`, số client của redirect không đổi; `prompt=login&max_age=0` (cùng context còn phiên ⇒ form login hiện) ⇒ 201. Consent Deny ⇒ `/error` `access_denied`, 0 `POST /token`, lần sau hỏi lại; Allow ⇒ `aud`=clientId, lần sau 0 `/authorize` 200. PATCH redirect ⇒ `/authorize` 400 "Invalid request", 0 request `/callback`. `afterAll` disable (BE log: 3×POST 403, 3×POST 201, 6×PATCH 200 ở repeat).
- Task 3 FE unit +29 (240→269): vector RFC 7636 Phụ lục B, charset/độ dài verifier, base64url `0xfb/0xff`⇒`-_8` + round-trip 0–8 byte, 14 biến thể returnTo + 6 tampered transient, callback thiếu `state`/`iss` rỗng/`iss` thừa `/`/không transient/id_token không nonce. Mutation tay (cp + sha256 khớp khi khôi phục): M1 S256→plain ⇒ 3 RED; M2 bỏ check `iss` ⇒ 5 RED; M3 bỏ chặn `%2f/%5c` ⇒ 6 RED. Bỏ riêng chặn `//` ⇒ 0 RED (đột biến tương đương do lớp origin, DEBT-245).
- Verify: `pnpm -C fe-sso-test` typecheck/lint sạch, test 269/269, build OK; `pnpm -C e2e typecheck` sạch; `pnpm -C e2e e2e` FULL 21 passed ×2 liên tiếp (1.9m mỗi lần, wall 114s/113s); `--repeat-each=3` 2 spec mới 15 passed (2.0m). grep `code=|state=|eyJ|secret/password placeholder` trên 3 log = 0.
- Không sửa `be/src`, `fe-sso-test/src`; không drop/FLUSH/compose; không commit. Không còn process nào tôi khởi động (4000/5173 trống, không vite fe-sso-test). Debt mới: DEBT-244 🟡 (TOCTOU cổng + cache Vite chung), DEBT-245 💭.

## senior-reviewer (Task 0–3) — 2026-10-20
- Kết luận: **PASS**, 0 🔴. Chi tiết: `review-senior.md`.
- Tự chạy lại: BE unit 382/382 (gồm `seed-e2e-admin.spec.ts` 16), `be typecheck` sạch, FE 269/269, `e2e tsc --noEmit` sạch. Không chạy E2E/int/compose.
- Invariant đã kiểm: guard seed chạy trước kết nối (tên DB chính xác, `NODE_ENV=test`, không echo URI/secret), không vào `dist`, không in secret; allowlist gitleaks là một literal chính xác; logout local/global không tautology (sid riêng theo context); step-up có side-effect 0; consent và redirect_uris kiểm cả hai phía.
- 🟡 vào backlog: DEBT-246 (`String(undefined)` làm assert RT pass rỗng ⇒ `invalid_grant` global có thể vacuous), DEBT-247 (browser vẫn mang `code` tới :3000, nên `route` abort), DEBT-248 (pin tiền đề không có `auth_time` bằng decode payload). Ponytail: net -4 dòng.
- Cổng → **tester** Task 4 + nghiệm thu.

## tester (Task 4 + nghiệm thu) — 2026-10-20
- Preflight CodeGraph (`codegraph sync` OK). Kết luận: **PASS**. Chi tiết + output: `test-report.md`.
- Debt chất lượng test (chỉ `e2e/tests/**`, sao lưu + sha256): DEBT-246 `typeof … === "string"` cho AT/RT (`logout.spec.ts`, `support/admin.ts`); DEBT-248 decode payload JWT ⇒ boolean `auth_time` có ở token tương tác/`forceLogin`, không có ở token refresh grant. DEBT-247: `context.route(":3000", abort)` **đo được không hiệu lực** (listener tạm :3000 nhận 5 hit, route không thấy redirect hop); `page.route` + `maxRedirects:0` cũng lọt; chốt CDP `Fetch.failRequest` cho `http://localhost:3000/*` ⇒ 0 hit, vẫn đọc `code` từ `Location`. Đóng DEBT-246/247/248.
- Task 4: `security-matrix.md` thêm tham chiếu E2E ở SE5/SE6/SE7/AD1, INV-4/10/11/26/28 + mục "Run 39" (gồm consent). Vòng grep run 34: trước `ok=259 bad=17`, sau `ok=276 bad=17` (17 BAD có sẵn là describe lồng/ô rút gọn, test tồn tại ⇒ DEBT-250); mục mới `ok=7 bad=0`. CI: `ci.yml`/`codeql.yml` parse OK; job `e2e` = `playwright test` toàn `./tests`, không dùng `secrets.`, `E2E_FE_ADMIN_SECRET` từ `env.ts`, RP cổng động (không xung đột).
- Nghiệm thu: BE typecheck/lint sạch; unit 382/382; int FULL 1199/1199 (301 s); FE 269/269; E2E FULL 21 passed ×2 liên tiếp (1.8m, wall 110 s mỗi lần, seed `unchanged` cả hai); `--repeat-each=3` 2 spec mới 15 passed (1.9m). Grep log E2E: `code=`/`state=`/`eyJ`/`client_secret`/giá trị secret = 0.
- Debt mới: DEBT-249 💭 (CDP ⇒ helper admin chỉ Chromium), DEBT-250 💭 (vòng grep ma trận không xử lý describe lồng). Không sửa `be/src`/`fe-sso-test/src`, không drop/FLUSH/compose, không commit. Không còn tiến trình tester khởi động.

## orchestrator — 2026-10-20 (đóng run)
- Mọi cổng PASS. Commit `d8da71c`.
