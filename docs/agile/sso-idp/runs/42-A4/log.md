# Log — run 42 — A4 đăng nhập OIDC kiểu BFF (+ DEBT-265/274/275)

## orchestrator — 2026-10-22
- Tiếp lane ADMIN sau run 41 (`9851442`). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §6 A4 + DEBT-265/274/275 (bắt buộc), DEBT-117 (step-up phải so `sub`). Cổng → tech-lead.

## tech-lead — 2026-10-22
- PASS (fold bắt buộc trong `tasks.md` mục "Fold tech-lead"). Đã đối chiếu code: BE không cần sửa (`GET /logout` chỉ hiện form xác nhận; hint hết hạn vẫn được chấp nhận; refresh không có grace ⇒ reuse revoke family; ID token không có email; `/admin/me` 403 `forbidden` cho user không phải admin).
- Q-42.1: Redis + ID opaque (prefix `fea:`, khoá HMAC, token mã hoá AES-GCM, `SET XX KEEPTTL`, idle 30' / absolute 8h), đóng quyết định DEBT-265. Q-42.2: tự viết mỏng + `jose@6.2.12` + `ioredis@6.0.0` (đã có trong lockfile, ≥14 ngày), không thêm openid-client. Q-42.3: giữ 4 task; DEBT-242/249, step-up E2E, CSP, front-channel ngoài phạm vi.
- Fold: scope thêm `email` + `/userinfo`; cookie `fea_sid`/`__Host-fea_sid` theo giao thức `APP_URL`; logout chỉ POST + same-origin; refresh không retry; Redis lỗi ⇒ 503.
- Debt mới: DEBT-278…281. Phân công: frontend-dev Task 1→4; backend-dev không có việc.

## frontend-dev — 2026-10-22
- Task 1–4 xong (BE không sửa, không lệch hợp đồng). `jose@6.2.12` + `ioredis@6.0.0` exact (lockfile +6 dòng, 0 package mới). Env `SESSION_REDIS_URL`; DEBT-274 (`import.meta.env.PROD`); DEBT-275 (function middleware `src/start.ts` + `safely()` loader/beforeLoad + `withErrorPage()` /auth/*); session Redis `fea:sess:<HMAC>` AES-256-GCM, `SET XX KEEPTTL`, idle 30'/abs 8h; BFF thuần `src/server/auth/bff.ts` (login/callback 11 bước/refresh single-flight/step-up so sub+tenantId/logout POST same-origin 303 end_session).
- Verify thật: fe-admin typecheck/lint OK, test **187/187** (11 file; mới: session-store 15 int @vg-test-redis, bff 58 fake IdP + Redis, error-boundary 9 canary, auth-ui 4), build OK, check:bundle 8 tên/0 hit (+ grep client không có `fea:sess`/ioredis/jose remote). Root lint + `-r typecheck` OK; `pnpm test` be 401 + fe-sso-test 269 + fe-admin 187; audit `--audit-level high`: 0 high (1 low, 1 moderate, 1 high ignored sẵn).
- Mutation (cp + sha256, khôi phục OK): bỏ ràng buộc state↔cookie, bỏ nonce, bỏ iss, bỏ so sub `/admin/me`, bỏ so sub step-up, bỏ so sub refresh ⇒ mỗi đột biến đỏ ≥1 test.
- E2E: thêm webServer fe-admin (:3000, Redis `/2`, `feAdminEnv()`) + `fe-admin.spec.ts` (login thật ⇒ email ⇒ cookie httpOnly/Lax, storage/DOM/HTML/`/_serverFn` không `eyJ` ⇒ logout + xác nhận IdP ⇒ vào lại phải đăng nhập; callback giả ⇒ 400 không `fea_sid`). Full **23/23 ×2 liên tiếp**; `admin-client.spec.ts` vẫn xanh khi fe-admin chạy :3000.
- Smoke dev Redis chết (cổng 1): trang lỗi chung, không Set-Cookie, không redirect, log có request id; nhưng status SSR = 500 (router chỉ 200/404/500) ⇒ DEBT-282. Lệch nhỏ (guard ở root, logout có cookie mà mất phiên ⇒ end_session không hint) ⇒ DEBT-283. Mở DEBT-282…285; đóng DEBT-265/274/275/277. DEBT-242/249 vẫn mở (helper admin chưa đổi, đúng fold). Cổng → senior-reviewer.

## senior-reviewer — 2026-10-22
- **REJECT** (1 nhóm 🔴 [FE], chỉ thiếu bằng chứng, code đúng): (a) `createDiscovery` không có test âm cho issuer lệch / endpoint khác origin ⇒ nới check sẽ gửi `client_secret` (Basic) sang origin lạ mà không test nào đỏ; (b) `azp` khi `aud` nhiều giá trị không có test. Cần ~4 test, không đổi code.
- Chạy lại: fe-admin typecheck/lint/test **187/187**/build/check:bundle (0 hit) xanh. Không chạy E2E.
- Đã kiểm INV-6 + callback CSRF/replay, session crypto (HKDF/HMAC/GCM+AAD), cookie theo giao thức, fixation, single-flight/no-retry, step-up sub+tenant (DEBT-117), logout POST same-origin, returnTo, không rò token, Redis fail-closed: đạt. Chấp nhận lệch DEBT-282/283.
- 🟡 mới: DEBT-286 (nhánh exception callback/logout không xoá `fea_tx`/`fea_sid`, `store.create` lỗi không revoke RT), DEBT-287 (refresh so tenantId khi phiên chưa có tenant + nit). Ponytail: lean (-5). Chuyển lại **frontend-dev** sửa 🔴, rồi senior xác nhận nhanh.

## frontend-dev retry 1 — 2026-10-22
- 🔴 (a) discovery: `bff.test` thêm 9 case (issuer khác / chỉ khác `/` cuối; token_endpoint khác origin / khác port; jwks/revocation/end_session/userinfo/authorization khác origin) ⇒ login ném, callback với tx hợp lệ ⇒ 500 + xoá `fea_tx`, `/token`=0, revoke=0, mọi URL đã gọi chỉ là discovery của issuer. Fake IdP: `discoveryDoc`, `discovery`, `calls.urls` có thể ghi đè. (b) `azp`: 2 dòng âm trong `it.each` (thiếu `azp` / `azp` khác, RT bị revoke) + 1 case dương. Code discovery/id-token không đổi.
- Gộp DEBT-286: `callback` bọc `handleCallback` ⇒ mọi exception xoá `fea_tx`, đã đổi code ⇒ revoke RT mới; logout discovery lỗi ⇒ 503 vẫn xoá `fea_sid`; `errors.ts` tách `unexpectedErrorPage`. DEBT-287: tenant chỉ so khi cả hai có giá trị, phiên `""` nhận tenant; `viewer.ts` append set-cookie (`test/viewer-fn.test.ts`). +4/+2/+1 test.
- Mutation (cp + sha256 khôi phục OK, không git checkout): bỏ issuer / bỏ vòng origin / chỉ bỏ token_endpoint / bỏ azp / azp chỉ kiểm thiếu / bỏ clearTx / bỏ revoke pending / bỏ clearSid / tenant cũ / bỏ tenant / bỏ nhận tenant / bỏ gán pending / `.set` thay append ⇒ 13/13 đột biến RED (1–12 test đỏ mỗi cái).
- Verify thật: fe-admin typecheck OK, lint OK, test **206/206** (12 file, +19), build OK, check:bundle 0 hit; E2E `pnpm -C e2e e2e` **23/23** (fe-admin.spec 2/2). Không còn process nào mở (:3000/:5173 trống).
- Đóng DEBT-286/287; mở DEBT-288 (💭 azp aud đơn, jwksCache, logout discovery lỗi không revoke được RT, tenant `""` từ /admin/me). Cổng → **senior-reviewer lượt 2**.

## senior-reviewer lượt 2 — 2026-10-22
- **PASS**. 🔴 lượt 1 đóng: discovery 9 case (mọi URL đã gọi chỉ là discovery của issuer, `/token`=0) + `azp` 2 âm/1 dương. Code mới không mở lỗ: `pending.rt` chỉ là RT của lần đổi code hiện tại và xoá sau `store.create` (không revoke nhầm RT của phiên), catch luôn ra trang 500/503 (không nuốt thành 302/200), `fea_tx`/`fea_sid` được xoá; `getResponseHeaders()` của Start trả headers sống nên append có hiệu lực thật.
- Chạy lại: fe-admin typecheck/lint/test **206/206**/build/check:bundle 0 hit. Không chạy E2E.
- Không 🟡 mới (không mở DEBT-289); 1 💭 (step-up mismatch + Redis ném ⇒ không xoá `fea_sid`, không hồi quy). Cổng → **tester**.

## tester — 2026-10-22
- **PASS**. fe-admin **237/237** (+31 `test/bff-risk.test.ts`), typecheck/lint/build/check:bundle (0 hit) xanh; root lint + `-r typecheck` OK; `pnpm test` be 401 + fe-sso-test 269 + fe-admin 237; audit high 0 (1 high ignored sẵn). E2E full **25/25 × 2 liên tiếp** (+2 `e2e/tests/fe-admin-risk.spec.ts`). Log E2E: `eyJ`/`code=`/`state=`/secret E2E/mật khẩu dev = 0.
- Ma trận rủi ro bổ sung: callback song song 5× cùng state (1 phiên, 1 `/token`), hai tab ghi đè `fea_tx`, tx bị sửa trong Redis (returnTo re-validate), 15 biến thể returnTo; cookie sửa 1 ký tự / đoán / HMAC secret khác / ciphertext chéo; idle + absolute qua BFF; **POST logout thật xen giữa refresh** (không hồi sinh, revoke RT cũ + mới); logout lặp; step-up khi phiên cũ đã mất / không kèm cookie nạn nhân. E2E thật: user dev seed không vai trò ⇒ trang 403 + replay URL callback thật ⇒ 400; step-up đăng nhập user khác qua UI IdP ⇒ phiên bị huỷ, cookie cũ ⇒ redirect login.
- Mutation (cp + sha256, khôi phục OK): GETDEL→GET, bỏ re-sanitize returnTo, bỏ kiểm XX khi refresh ⇒ RED.
- Smoke Redis chết (fe-admin dev thật, Redis cổng đóng): có cookie ⇒ 500 generic + request id, không redirect, không xoá cookie, không lộ lỗi (DEBT-282 tái hiện); logout khi IdP chết ⇒ 500 (không phải 503) nhưng vẫn xoá cookie ⇒ mở **DEBT-289** 💭. Process tự khởi động đã dừng, :3000/:4000/:5173 trống.
- Không sửa code sản phẩm. Cổng → orchestrator đóng run.

## orchestrator — 2026-10-22 (đóng run)
- Mọi cổng PASS. Commit `9d2de22`.
