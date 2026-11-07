# Tasks — run 73 — X3 ma trận cookie topology × trình duyệt (M7, lane QA/E2E)

> Nguồn: `plan.md` X3 (dòng bảng X3: domain dev, Chromium/Firefox/WebKit, interactive login, logout, POST, fetch; `prompt=none` qua iframe best-effort; kết quả: bảng (topology × trình duyệt) + quyết định cuối về `SameSite`), `spec.md` §9.6, Q8 đã chốt `plan.md` §12 (kiểm **topology** không kiểm tên: IdP + app cùng site khác subdomain, ≥ 1 app khác site; domain thật cắm qua env), `backlog.md` DEBT-008 (`__Host-` prefix cho cookie session khi `Secure`) và các DEBT gắn "X3".
>
> Tech-lead: thiết kế cách dựng topology mà KHÔNG sửa cấu hình hệ thống (không sửa `hosts`, không cài CA vào kho tin cậy của máy — đó là thay đổi bảo mật hệ thống, bị cấm): ví dụ `*.localhost` (trình duyệt tự phân giải về loopback), ánh xạ tên qua cờ trình duyệt (Chromium `--host-resolver-rules`, Firefox pref, WebKit?), HTTPS cục bộ bằng chứng chỉ tự ký sinh trong scratchpad/thư mục test + `ignoreHTTPSErrors` của Playwright. Kiểm Playwright browsers đã cài khớp version `@playwright/test` của repo (`%LOCALAPPDATA%\ms-playwright`); nếu thiếu Firefox/WebKit đúng bản thì DỪNG và báo orchestrator (tải trình duyệt cần người dùng duyệt). Xác định: biến env BE/FE cho domain/cookie (`COOKIE_DOMAIN`? `Secure` flag), DEBT-008 thay đổi gì ở BE (tên cookie khi `Secure`, migration session đang có?), suite X3 nằm ở đâu (project Playwright riêng, không làm chậm `pnpm -C e2e e2e` mặc định), bảng kết quả + quyết định `SameSite` ghi vào spec §9.6. Cách chứng minh: suite chạy xanh trên 3 trình duyệt (hoặc ghi rõ ca best-effort thất bại theo thiết kế), E2E mặc định 37 vẫn xanh, int/unit be nếu BE đổi.
>
> Ràng buộc: không sửa `hosts`/cấu hình mạng/kho chứng chỉ hệ thống; không tải trình duyệt/gói mới khi chưa được duyệt; KHÔNG compose up/FLUSH/drop `aegate-*` (E2E dùng `sso-idp-e2e` + redis `/2` như hiện có); không seed/sync DB dev `sso-idp`; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` người dùng (kiểm cổng trước E2E); không commit.

### [x] Task 1 [BE]: DEBT-008 — cookie session `__Host-` khi `Secure` (theo fold).
### [x] Task 2 [E2E]: suite X3 topology × Chromium/Firefox/WebKit (login, logout, POST, fetch; `prompt=none` iframe best-effort). — phần BE (seed `x3-alpha`/`x3-beta` khi `E2E_X3=1`) ✅ backend-dev; còn config/proxy/spec → frontend-dev.
### [x] Task 3 [docs]: bảng kết quả + quyết định `SameSite` vào spec §9.6 (+ runbook nếu có env mới).

## Fold tech-lead (2026-11-06) — REJECT, chặn tiên quyết — ✅ ĐÃ GIẢI QUYẾT (retry 1: người dùng duyệt, orchestrator cài firefox-1555 + webkit-2370; tech-lead tự kiểm lại khớp `browsers.json` 1.64.0). Fold có hiệu lực ở mục dưới.

- Kiểm revision: `@playwright/test` 1.64.0 cần chromium 1248 ✅, **firefox 1555 ❌ (có 1522)**, **webkit 2370 ❌ (có 2287)**. Chi tiết `review-techlead.md`.
- DỪNG theo ràng buộc "không tải trình duyệt khi chưa được duyệt". Không thiết kế/thử khả thi khi chưa có trình duyệt đúng bản. Không có thay đổi repo.
- Cần người dùng: duyệt `pnpm -C e2e exec playwright install firefox webkit`. Sau đó mở lại tech-lead run 73 (fold đầy đủ: topology, project Playwright riêng, DEBT-008 `__Host-`, bảng + `SameSite`).
- Task 1–3 giữ nguyên, CHƯA được phép triển khai.

## Fold tech-lead — retry 1 (2026-11-06) — PASS (bắt buộc)

### F0. Bằng chứng khả thi (probe trong scratchpad, không đụng hệ thống)
- Revision: chromium-1248 / firefox-1555 (157.0) / webkit-2370 (27.2) = đúng `playwright-core@1.64.0/browsers.json`.
- Probe `scratchpad/x3probe/probe.cjs` + `toss.cjs` (HTTPS tự ký bằng `openssl`, server Node chỉ bind `127.0.0.1`, `ignoreHTTPSErrors: true`):
  - `*.localhost` tự phân giải về loopback ở CẢ 3 trình duyệt, không cờ, không `hosts` ⇒ **không cần** `--host-resolver-rules`/pref Firefox/proxy. (Proxy forward Node qua `launch({ proxy })` cũng chạy cả 3 — chỉ là dự phòng nếu sau này cần tên dạng `*.test`; KHÔNG làm.)
  - PSL: `localhost` được coi như TLD ⇒ `idp.alpha.localhost` ↔ `app.alpha.localhost` **same-site**, ↔ `app.beta.localhost` **cross-site** (Chromium/Firefox: `Strict` gửi same-site, không gửi cross-site). `idp.localhost` ↔ `app.localhost` là cross-site ⇒ topology phải dùng 3 nhãn.
  - Cross-site (Chromium & Firefox): top-level GET gửi `Lax`, không `Strict`; form POST / fetch credentials / iframe KHÔNG gửi `Lax`; `None; Secure` gửi mọi nơi (profile Playwright không chặn 3P — DEBT-507). Firefox coi cookie không khai `SameSite` là `None` ⇒ BE luôn khai `SameSite` tường minh (đang có).
  - **WebKit Windows KHÔNG áp `SameSite`** (gửi `Lax`/`Strict` trên POST/fetch/iframe cross-site) ⇒ cột WebKit ≠ Safari (DEBT-506).
  - `Secure` trên `http://*.localhost`: Chromium/Firefox lưu + gửi; WebKit lưu nhưng KHÔNG gửi ⇒ X3 chạy HTTPS; dev/E2E mặc định http giữ `SESSION_COOKIE_SECURE=false`.
  - Cookie tossing từ `app.alpha.localhost` (`document.cookie`): `__Host-x; Domain=alpha.localhost` bị cả 3 từ chối; `legacy; Domain=alpha.localhost` và `__Secure-x; Domain=…` ĐẾN được IdP ⇒ chỉ `__Host-` chống được (lý do DEBT-008; DEBT-505 cho cookie federation).

### F1. Task 1 [BE] — DEBT-008 (một cờ duy nhất `SESSION_COOKIE_SECURE`, không env mới)
- `SessionCookie` (`be/src/modules/sessions/session.cookie.ts`): tên `__Host-idp_session` khi `cookieSecure=true`, `idp_session` khi false; expose `readonly name`. Options giữ `HttpOnly; SameSite=Lax; Path=/`, **không bao giờ** `domain`. `read/set/clear` dùng `this.name`. Giữ export `SESSION_COOKIE='idp_session'` (int-test chạy `cookieSecure:false` — không sửa ~28 file).
- `ui.controller.ts:468` `delete req.cookies?.[SESSION_COOKIE]` → dùng `this.sessionCookie.name`.
- `idp_csrf` (`csrf.service.ts`; identity CSRF form login khi chưa có session — tossing được ⇒ login-CSRF): cùng quy tắc ⇒ `__Host-idp_csrf` khi Secure (đã `Path=/`). `formCsrfIdentity` đã nhận `secure`; `CsrfGuard` lấy tên từ cùng nguồn (vd. hàm thuần `csrfCookieName(secure)` hoặc `SessionCookie` expose `secure`).
- `idp_fed`/`idp_link` (`Path=/auth/`) **NGOÀI phạm vi** → DEBT-505.
- Chuyển tiếp session cũ: **cắt cứng** — KHÔNG đọc fallback tên cũ (giữ nguyên lỗ tossing trong cửa sổ chuyển tiếp), KHÔNG chủ động xoá cookie cũ (bị bỏ qua, hết hạn theo Max-Age). Session Redis cũ hết theo idle TTL, không tombstone (như §8 giới hạn 1). Hệ quả: mỗi người dùng đăng nhập lại 1 lần khi deploy — chấp nhận (chưa launch); ghi `runbook-deploy.md`.
- Verify (unit `session.cookie.spec.ts` + spec csrf): Secure ⇒ header `^__Host-idp_session=…` có `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, **không** `Domain=`; non-Secure ⇒ `idp_session` không `Secure`; Secure + request chỉ có `idp_session=<id hợp lệ>` ⇒ `read()` undefined (âm); `clear` đúng tên; tương tự `idp_csrf`. Int: 1 ca login `cookieSecure:true` thấy `__Host-idp_session`; cookie legacy hợp lệ ⇒ trang login (anonymous), không 5xx. `pnpm -C be test` + `test:int` xanh.

### F2. Task 2 [E2E] — suite X3
- Vị trí: `e2e/x3/*.spec.ts` + `e2e/playwright.x3.config.ts`; script `"e2e:x3": "playwright test -c playwright.x3.config.ts"`. Config mặc định KHÔNG đổi ⇒ `pnpm -C e2e e2e` vẫn 37, không chậm.
- Topology (3 nhãn, 1 cổng TLS): IdP `https://idp.alpha.localhost:8443`; RP same-site `https://app.alpha.localhost:8443`; RP cross-site `https://app.beta.localhost:8443`.
- TLS: `e2e/x3/tls-proxy.mjs` (node:https + node:http, KHÔNG dependency mới), bind **chỉ `127.0.0.1`**, định tuyến theo `Host`: idp → BE `127.0.0.1:4100`, app.alpha → Vite 5273, app.beta → Vite 5274 (upstream `localhost` hoặc Vite `--host 127.0.0.1`); chuyển tiếp `upgrade` (HMR) hoặc chấp nhận lỗi HMR console. Cert tự ký sinh lúc chạy bằng `openssl` (SAN `*.alpha.localhost,*.beta.localhost`, hạn 2 ngày) vào `e2e/.x3-tls/` (thêm `e2e/.gitignore`; KHÔNG commit key; thiếu `openssl` ⇒ fail-fast rõ). Không cài CA; browser `ignoreHTTPSErrors: true`. Node-side (seed/health) gọi cổng http nội bộ, KHÔNG tắt `NODE_TLS_REJECT_UNAUTHORIZED`.
- webServer X3: BE cùng chuỗi build/seed như config mặc định, env `{...beEnv(), PORT:'4100', ISSUER:'https://idp.alpha.localhost:8443', SESSION_COOKIE_SECURE:'true', E2E_X3:'1'}` (vẫn `sso-idp-e2e` + redis `/2`, không FLUSH); 2 RP = fe-sso-test (`startRp` mở rộng nhận `publicOrigin` tách khỏi cổng nội bộ; Vite 8 mặc định cho phép `*.localhost`); TLS proxy. Cổng 4100/5273/5274/8443 (đã kiểm trống; tránh 4071). Kiểm cổng trước khi chạy; **không chạy song song** với `e2e` mặc định (chung DB/seed) — ghi README.
- Client RP: 2 public client `x3-alpha`/`x3-beta` (redirect/post-logout/CORS = origin https tương ứng) upsert trong seed E2E-only `seed:e2e-admin` (giữ guard `NODE_ENV=test` + DB `sso-idp-e2e`) khi `E2E_X3=1`. Không dùng `adminToken` (chặn hop ở tầng mạng Chromium — không chạy Firefox/WebKit). `assert-dist-clean` vẫn xanh.
- Projects `chromium`/`firefox`/`webkit` (Desktop devices), `ignoreHTTPSErrors: true`, `trace: off` (trace ghi giá trị), workers 1.
- Ca (mỗi trình duyệt × {same-site alpha, cross-site beta}); "cookie có gửi không" đo bằng `page.on('request')` + `request.allHeaders()` CHỈ lấy **tên** cookie:
  1. **Interactive login** (top-level → form → consent → callback): RP hiện đăng nhập. Assert mọi ô.
  2. **SSO lần 2**: đã login ở alpha, mở beta ⇒ không hiện form login (Lax theo top-level GET cross-site). Assert mọi ô (ra form ⇒ `SameSite` sai).
  3. **Logout** RP-initiated: sau đó `/authorize` ⇒ form; `context.cookies()` không còn `__Host-idp_session`; chép cookie cũ vào context mới ⇒ vẫn form (replay âm).
  4. **POST**: trang RP tự submit form POST tới endpoint đổi trạng thái IdP (`/logout` hoặc consent) không `_csrf` ⇒ 403/không đổi trạng thái, session sống (ca 2 vẫn silent). Chromium/Firefox cross-site: assert session cookie KHÔNG gửi; WebKit-Win: chỉ ghi nhận (DEBT-506), vẫn assert session sống.
  5. **fetch**: RP gọi `/userinfo` (+ `/demo/me`) bằng Bearer qua CORS ⇒ 200 ở cả 2 origin; `fetch(..., {credentials:'include'})` cross-site: Chromium/Firefox assert không mang session cookie.
  6. **Cookie tossing (DEBT-008, âm)** từ trang `app.alpha`: `__Host-idp_session=x; Domain=alpha.localhost; Path=/; Secure` ⇒ không lưu; `idp_session=<sid hợp lệ của user khác>; Domain=alpha.localhost; Path=/; Secure` ⇒ IdP bỏ qua (danh tính không đổi). Assert cả 3. Thuộc tính qua `context.cookies()`: `secure`, `httpOnly`, `sameSite:'Lax'`, `path:'/'`, domain host-only `idp.alpha.localhost`.
  7. **`prompt=none` iframe (best-effort)**: ghi `code` | `login_required` | `blocked` vào `test.info().annotations`; **không fail** theo kết quả, chỉ fail lỗi harness. Kỳ vọng: same-site có thể `code`; cross-site `login_required`; CSP `frame-ancestors 'none'`/XFO có thể chặn — ghi đúng như đo.
- Kết quả: `e2e/test-results/x3-matrix.json` (git-ignored), CHỈ ca/trình duyệt/topology/kết quả/tên cookie — không giá trị, không URL có `code`/token.
- Verify: `pnpm -C e2e e2e:x3` xanh 3 project (ca 7 chỉ annotation); `pnpm -C e2e e2e` 37 xanh; `pnpm -C e2e typecheck`.

### F3. Task 3 [docs]
- `spec.md` §9.6: dòng cookie ⇒ `__Host-idp_session` khi `Secure` (dev http: `idp_session`); bảng (ca × topology × Chromium/Firefox/WebKit-Win) từ `x3-matrix.json`, kèm phiên bản trình duyệt + ngày; ghi WebKit-Win ≠ Safari (DEBT-506), iframe lạc quan (DEBT-507).
- **Quyết định `SameSite`: giữ `Lax`** (nếu suite đo ngược lại ⇒ dừng, báo tech-lead). Lý do đo được: `Strict` hỏng SSO top-level cross-site (ca 2); `None` mở CSRF cross-site cho POST/fetch và không cứu silent SSO trên Safari/Firefox TCP; top-level redirect là cơ chế chính. Không thêm env `SameSite` (YAGNI).
- `security-matrix.md` CK1 trỏ suite X3; `runbook-deploy.md`: đổi tên cookie ⇒ đăng nhập lại 1 lần, dev http phải `SESSION_COOKIE_SECURE=false`; `e2e/README.md`: `e2e:x3`, cổng, cần `openssl`, không chạy song song.

### F4. Ràng buộc nhắc lại
Không `hosts`/mạng/kho cert; không tải gói/trình duyệt mới; proxy chỉ loopback; không kill PID ngoài child do chính test spawn (`startRp` đã có); không FLUSH/drop; không commit.
