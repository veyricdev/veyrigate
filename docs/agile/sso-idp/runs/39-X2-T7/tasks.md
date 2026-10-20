# Tasks — run 39 — X2 E2E đầy đủ + T7 (M7)

> Plan X2: "E2E đầy đủ: consent, refresh rotation, reuse-detect, logout local/global, admin tạo client mới → fe-sso-test dùng client đó đăng nhập, step-up, đổi `redirect_uris` làm test app hỏng đúng cách" — nghiệm thu "Chạy CI ổn định (không flaky)". Plan T7: "unit cho PKCE/validator; e2e Playwright (login, consent, refresh, logout, kịch bản lab) — chạy trong CI cùng BE". X5 (gom suite + chặn merge) phần lớn đã có ở run 34/38 (CI job int/e2e, ma trận) — chỉ bổ sung truy vết E2E vào `security-matrix.md`. E2E hiện có: `login`, `api-test`, `lab`, `federation` (entry E2E `be/test/e2e/e2e-main.ts`, mock Google).
>
> Thứ tự: Task 1 → 2 → 3 → 4. Hạ tầng: DB E2E `sso-idp-e2e`/Redis `/2` — KHÔNG drop/FLUSH, dữ liệu tạo trong test phải sinh ngẫu nhiên để chạy lặp; KHÔNG compose up.

### [x] Task 1 [E2E]: consent + refresh rotation + reuse-detect + logout local/global
- Consent: client/resource chưa consent ⇒ màn consent hiện ⇒ Allow ⇒ claims; Deny ⇒ fe-sso-test hiện `access_denied`; lần sau không hỏi lại.
- Refresh rotation qua fe-sso-test (nút refresh nếu có, hoặc trang tokens) ⇒ token mới, cũ không dùng được; reuse-detect qua lab đã có (liên kết, không lặp).
- Logout local (một context) không ảnh hưởng context thứ 2 cùng user; logout global ⇒ cả hai mất phiên, AT cũ 401 ở `/userinfo`.
- **Acceptance**: spec mới chạy xanh 2 lần liên tiếp; không lộ token trong output.

### [x] Task 2 [E2E]: admin tạo client → fe-sso-test dùng; step-up; đổi redirect_uris
- Admin (super_admin seed qua `db:seed` trên DB E2E? — tech-lead chốt cách có admin token trong E2E mà không có fe-admin: gọi admin API bằng token lấy qua `/authorize` client `fe-admin` confidential seed + secret in 1 lần, hoặc helper Node trong e2e) tạo client public mới (redirect về fe-sso-test), fe-sso-test đăng nhập bằng client đó (cấu hình `client_id` runtime cho fe-sso-test? — tech-lead chốt).
- Step-up: thao tác nhạy cảm với `auth_time` cũ ⇒ 403 `step_up_required` ⇒ `prompt=login&max_age=0` ⇒ thành công.
- Đổi `redirect_uris` bỏ URI của fe-sso-test ⇒ `/authorize` hiện trang lỗi IdP (không redirect) — "hỏng đúng cách".
- **Acceptance**: xanh 2 lần liên tiếp; dữ liệu client tạo ngẫu nhiên, dọn/vô hiệu sau test (không drop DB).

### [x] Task 3 [FE]: T7 unit còn thiếu
- Rà unit FE cho PKCE (S256, độ dài verifier, base64url), validator (returnTo, state/nonce, callback) — bổ sung chỗ thiếu.
- **Acceptance**: `pnpm -C fe-sso-test test` xanh; mutation mẫu ⇒ RED.

### [x] Task 4 [test]: X5 truy vết + CI
- `security-matrix.md`: thêm cột/ghi chú E2E cho các dòng có E2E; đảm bảo job CI e2e chạy toàn bộ spec mới; tổng thời gian E2E hợp lý.
- **Acceptance**: ma trận grep hợp lệ; CI YAML parse.

## Câu hỏi cho tech-lead
- Q-39.1: Cách có admin token trong E2E (không có fe-admin UI).
- Q-39.2: fe-sso-test dùng client_id khác lúc runtime thế nào (không phá chế độ mặc định).
- Q-39.3: Phân công (frontend-dev E2E + FE; backend-dev nếu cần hook BE/seed E2E).

---

## Fold tech-lead — 2026-10-20 (ƯU TIÊN hơn text cũ ở trên)

Kết luận: **PASS có fold**. Đối chiếu code thật: `clientId` do server sinh khi `POST /admin/clients` (không tự đặt được); `POST`/`PATCH /admin/clients` đều `@RequireRecentAuth(5)`; `StepUpGuard` coi token **từ refresh grant (không `auth_time`)** là luôn `step_up_required`; `fe-admin` là confidential `client_secret_basic`, redirect `http://localhost:3000/auth/callback`, secret chỉ cấp 1 lần (`db:seed` in ra stdout, lần sau không cấp lại); `fe-sso-test` đọc `client_id` lúc dev-server khởi động (`import.meta.env`), không có nút refresh; IdP có sẵn logout local/global (`POST /logout` và `?scope=all`, nút "Sign out everywhere"), tombstone làm AT mang `sid` cũ trả 401 ở `/userinfo`. Deny consent KHÔNG lưu consent.

### Trả lời câu hỏi
- **Q-39.1 (admin token)**: lấy qua **flow OAuth thật**, KHÔNG thêm gì vào `be/src/`. (a) Seed riêng cho E2E `be/test/e2e/seed-e2e-admin.ts` (ts-node, ngoài `dist`) đảm bảo super_admin + `fe-admin` + **một credential có secret biết trước** `E2E_FE_ADMIN_SECRET` (placeholder trong `e2e/config/env.ts`, giống `CSRF_SECRET`). (b) Test lái browser (context riêng cho admin) qua `/authorize` client `fe-admin` + PKCE S256 + `resource=${ISSUER}/admin/` + scope `openid offline_access admin.read admin.write`; `context.route("http://localhost:3000/**")` chặn redirect, lấy `code` (không log URL), đổi ở `/token` bằng `client_secret_basic` từ Node (`request` context). Không mint JWT, không ghi Redis/Mongo trực tiếp để lấy token.
- **Q-39.2 (client_id runtime)**: KHÔNG sửa `fe-sso-test`. Helper `e2e/tests/support/rp-server.ts` spawn **Vite dev server thứ hai** của fe-sso-test ngay trong test (`node <fe-sso-test>/node_modules/vite/bin/vite.js --port 5174 --strictPort`, cwd fe-sso-test) với `VITE_OIDC_CLIENT_ID=<clientId vừa tạo>`, redirect `http://localhost:5174/callback`, post-logout `http://localhost:5174/`; chờ `GET /` 200 (≤30s, poll, không sleep cố định); `stop()` ở `afterAll` (kill trực tiếp tiến trình node, không qua pnpm, để kill được trên Windows). Cổng bận ⇒ fail ngay (strictPort), không đổi cổng ngẫu nhiên.
- **Q-39.3 (phân công)**: Task 0 **backend-dev**; Task 1, 2, 3 **frontend-dev**; Task 4 **tester** (sau khi 0–3 xanh). Thứ tự: 0 → 2; 1 và 3 độc lập; 4 cuối.

### [x] Task 0 [BE] (mới, backend-dev): seed admin cho E2E, chỉ là test infra
- `be/test/e2e/seed-e2e-admin.ts` + script `pnpm -C be seed:e2e-admin` (ts-node). Chèn vào `webServer.command` sau `db:seed-dev`, trước `start:e2e`.
- **Guard fail-closed TRƯỚC khi kết nối**: `NODE_ENV === "test"` (chặt hơn `assertNotProduction`) **và** tên DB trong `MONGO_URI` đúng bằng `sso-idp-e2e`; sai ⇒ exit ≠0, thông báo không chứa URI đầy đủ/credential. `E2E_FE_ADMIN_SECRET` thiếu hoặc < 32 ký tự ⇒ exit ≠0.
- Gọi `seedBootstrap` in-process (KHÔNG chạy CLI `db:seed` vì nó in secret ra stdout của webServer); **bỏ** `feAdminSecret` trả về, không in.
- Credential: nếu `verifySecret("fe-admin", E2E_FE_ADMIN_SECRET)` hợp lệ ⇒ không làm gì; ngược lại revoke mọi credential còn hiệu lực của `fe-admin` rồi chèn version kế tiếp với `hashPassword(E2E_FE_ADMIN_SECRET)`. Idempotent khi chạy lặp.
- Admin user (`ADMIN_SEED_EMAIL`): đặt lại `passwordHash` theo `ADMIN_SEED_PASSWORD`, `failedLoginCount=0`, `lockedUntil=null` (chỉ trên DB E2E, nhờ guard) ⇒ lần chạy hỏng trước không khoá admin cho lần sau.
- `assert-dist-clean.mjs`: thêm marker `seed-e2e-admin`. `e2e/config/env.ts`: thêm `E2E_FE_ADMIN_SECRET` vào `beEnv()`, export `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD`/`E2E_FE_ADMIN_SECRET` cho test. Nếu gitleaks bắt placeholder ⇒ allowlist đúng path `e2e/config/env.ts` trong `.gitleaks.toml` (không nới rule chung).
- **Acceptance**: (1) chạy 2 lần liên tiếp trên `sso-idp-e2e` ⇒ exit 0, lần 2 không tạo credential mới (số credential của `fe-admin` không đổi); (2) `MONGO_URI=.../sso-idp` hoặc `NODE_ENV=development` ⇒ exit ≠0 trước khi kết nối (ghi lệnh + output vào log); (3) stdout/stderr của seed không chứa secret (grep); (4) `pnpm -C be build && node be/test/e2e/assert-dist-clean.mjs` xanh; BE unit/int không đổi.

### [x] Task 1 [E2E] (frontend-dev): logout local/global, file `e2e/tests/logout.spec.ts`
- **Bỏ** phần consent khỏi Task 1 (chuyển sang Task 2): user dev đã consent `fe-sso-test` từ các run trước trên DB không drop ⇒ màn consent không tất định.
- **Refresh rotation + reuse-detect: KHÔNG viết spec mới.** Đã phủ bởi `lab.spec.ts › lab refresh replay` (bước 1 rotate, 2 replay ⇒ `invalid_grant`, 3 descendant ⇒ `invalid_grant`). Task 4 ghi truy vết. Không thêm nút refresh vào fe-sso-test (DEBT-241).
- Test "local": 2 browser context A, B cùng user dev đăng nhập fe-sso-test (bắt AT/RT bằng `captureTokenSecrets`, giữ trong biến, không in). A "Sign out" ⇒ trang IdP ⇒ nút **Sign out** ⇒ về FE `signed-out`. Kỳ vọng: AT của A ⇒ `/userinfo` 401; AT của B ⇒ 200; B về `/` (reload) → "Sign in" ⇒ về claims **không** qua form login (phiên IdP của B còn).
- Test "global": A, B đăng nhập mới. B "Sign out" ⇒ **Sign out everywhere**. Kỳ vọng: AT của A và B ⇒ `/userinfo` 401; RT của A ⇒ `POST /token grant_type=refresh_token` 400 `invalid_grant`; A bấm Sign in ⇒ thấy form login IdP (phiên A mất).
- Gọi `/userinfo`, `/token` bằng `playwright.request.newContext()` (không cookie), Bearer trong header, assert **chỉ status/error code** (boolean, không echo token).
- `expectNoSecretsExposed` chỉ áp trên origin FE (trang logout của IdP có `id_token_hint` hidden theo thiết kế).

### [x] Task 2 [E2E] (frontend-dev, sau Task 0): admin → client mới → consent → step-up → đổi redirect_uris, file `e2e/tests/admin-client.spec.ts` (`test.describe.serial`)
- Helper `e2e/tests/support/admin.ts`: `adminToken(browser, { forceLogin })` (flow Q-39.1; `forceLogin` ⇒ `prompt=login&max_age=0`), `adminRefresh(rt)`, gọi admin API. Mỗi bước cần step-up tự lấy token `forceLogin` ngay trước đó (không dựa vào khoảng 5').
- (a) **Step-up**: token admin → refresh grant ⇒ token mới (không `auth_time`) ⇒ `POST /admin/clients` ⇒ **403** `error=step_up_required`, `max_age=0`, và không có client nào được tạo (so danh sách client có redirect `:5174` trước/sau). Rồi `adminToken({forceLogin:true})` (form login IdP hiện lại dù còn phiên) ⇒ `POST` ⇒ 201.
- (b) Tạo client public: `clientType:"public"`, `tokenEndpointAuthMethod:"none"`, `redirectUris:["http://localhost:5174/callback"]`, `postLogoutRedirectUris:["http://localhost:5174/"]`, `allowedCorsOrigins:["http://localhost:5174"]`, `allowedResources:["demo"]`, `scopes:["openid","profile","email","offline_access"]`, grant `authorization_code`+`refresh_token`. Lấy `clientId` từ response; `startRp(clientId)`.
- (c) **Consent** (context mới, user dev): Sign in trên :5174 ⇒ login ⇒ màn consent **phải** xuất hiện ⇒ **Deny** ⇒ FE hiện `access_denied` (`error-code`) và không có `POST /token`; Sign in lại ⇒ consent **hiện lại** (deny không lưu) ⇒ **Allow** ⇒ claims, `aud` = clientId mới; reload + Sign in lại ⇒ về claims mà **không** có điều hướng `/authorize` trả 200 (consent không hỏi lại).
- (d) **Đổi redirect_uris**: token `forceLogin` ⇒ `PATCH` `redirectUris:["http://localhost:5174/elsewhere"]` ⇒ 200; context mới Sign in trên :5174 ⇒ điều hướng `/authorize` **400**, trang IdP "Invalid request", URL ở port 4000, **không** có request nào tới `localhost:5174/callback`.
- (e) `afterAll`: `stopRp()`; token `forceLogin` ⇒ `PATCH {disabled:true}` (best-effort, lỗi chỉ ghi `clientId` + status). Không xoá DB.

### [x] Task 3 [FE] (frontend-dev): T7 unit, liệt kê cụ thể
- `pkce.test.ts`: vector RFC 7636 Phụ lục B (verifier → challenge cố định); verifier 43–128 ký tự, chỉ `[A-Za-z0-9-._~]`.
- `base64url`: không `=`, không `+`/`/`, round-trip byte 0xfb/0xff.
- `returnTo`/`returnToStore`: `//evil`, `/\evil`, `%2F%2Fevil`, `javascript:`, URL tuyệt đối khác origin ⇒ về `/`.
- `callback`: thiếu `state`, `state` lệch, `iss` thiếu/lệch, nonce lệch ⇒ reject, không gọi `/token` (chỉ bổ sung case chưa có).
- **Acceptance**: `pnpm -C fe-sso-test test` xanh; ghi vào log **3 mutation tay** (vd. S256→plain, bỏ check `iss`, bỏ chặn `//`), mỗi cái ⇒ ≥1 test RED, rồi revert (không commit mutation).

### [x] Task 4 [test] (tester): X5 truy vết
- `security-matrix.md`: thêm tham chiếu E2E (đúng quy ước «đường-dẫn › tên test», grep ra đúng 1 dòng) cho: refresh rotation/reuse (lab), logout local/global, consent deny/allow, step-up admin (INV-26 / #26), redirect_uri không khớp (INV-4). Cập nhật bảng tổng hợp nếu trạng thái đổi.
- CI: job `e2e` đã chạy toàn bộ `playwright test` ⇒ chỉ xác nhận cổng 5174 không xung đột và `E2E_FE_ADMIN_SECRET` đến từ `env.ts` (không cần GitHub secret). YAML parse nếu có sửa.
- **Acceptance**: vòng grep matrix hợp lệ; tổng thời gian `pnpm -C e2e e2e` ghi vào log (mục tiêu < 5').

### Chống flaky + chạy lặp trên DB E2E không drop (áp cho Task 1, 2)
- Giữ `workers:1`, `retries:0` (flaky phải lộ ra, không che bằng retry). Không `waitForTimeout`/sleep cố định; chờ bằng predicate URL (pathname/port, không regex full URL), locator, hoặc `waitForResponse`.
- Mỗi test dùng context mới (không chia cookie); không phụ thuộc thứ tự file; global logout chỉ ảnh hưởng phiên user dev **trong chính test đó**.
- Dữ liệu tạo trong test: client do server sinh id ⇒ mỗi lần chạy là client mới ⇒ consent/family mới, tất định. Không đếm toàn cục; chỉ so trên đối tượng mình tạo.
- Seed (Task 0) đặt lại mật khẩu/khoá admin ⇒ lần chạy hỏng trước không làm hỏng lần sau.
- Không token/secret/`code` trong output (grep log chạy).
- **Nghiệm thu chung**: `pnpm -C e2e e2e` toàn bộ xanh **2 lần liên tiếp** trên `sso-idp-e2e` không drop, rồi `pnpm -C e2e exec playwright test logout.spec.ts admin-client.spec.ts --repeat-each=3` xanh; dán tóm tắt (số test, thời gian) vào log. Không `compose up`/FLUSH/drop.
