# Tasks — run 51 — A7: Hardening FE (M7, lane ADMIN) + DEBT-360/359

> Plan §6 A7: "CSP nghiêm, security headers, cookie `HttpOnly/Secure/SameSite`, CSRF cho server functions có side-effect, không log token/secret, chặn clickjacking, kiểm tra lộ biến server vào client bundle" — nghiệm thu "INV-20 áp cho FE; scan bundle không chứa secret". Debt liên quan: **DEBT-269** (Start chèn inline `<script>` hydration ⇒ cần CSP nonce; cookie `theme`/`sidebar_state` không `Secure`) và các debt A7 khác trong backlog (tech-lead gom). `check:bundle` đã có (A4/A5).
>
> Thứ tự: Task 1 trước (test đỏ chặn mọi gate), rồi Task 2 → 3 → 4 (frontend-dev). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [TEST]: DEBT-360 — root `pnpm test` song song gần như luôn đỏ (timeout `check-bundle.test.ts`, `users-ui`, fe-sso-test `router-lab`). Sửa gốc (timeout hợp lý cho test nặng/IO, hoặc `--workspace-concurrency`), chứng minh xanh ≥3 lần liên tiếp. Kèm DEBT-359 (ponytail).

### [x] Task 2 [FE]: Security headers + CSP nghiêm có nonce cho mọi script Start/router (DEBT-269), `frame-ancestors 'none'`/X-Frame-Options, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, HSTS khi https; không `unsafe-inline` cho script.

### [x] Task 3 [FE]: Cookie: mọi cookie (`fea_sid`, `theme`, `sidebar_state`, step-up…) đúng `HttpOnly`/`Secure`/`SameSite` theo vai trò; CSRF cho server functions có side-effect (xác minh cơ chế hiện tại — Origin/`Sec-Fetch-Site`/token — và test âm cross-site).

### [x] Task 4 [E2E]: header/CSP thật trên trang SSR, không vi phạm CSP trong console khi đi qua các trang chính, request server fn cross-origin bị từ chối.

## Câu hỏi cho tech-lead
- Q-51.1: TanStack Start 1.168.60 hỗ trợ nonce thế nào (đường đi nonce tới script hydration/router); nếu không đủ ⇒ phương án (hash, strict-dynamic).
- Q-51.2: CSRF hiện có chưa (server fn POST + SameSite cookie); cần thêm gì.
- Q-51.3: DEBT-360 sửa gốc ra sao; có cần tách run riêng.

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `b9e6cb8` (CodeGraph + đọc trực tiếp):
- fe-admin: `src/{server.ts,start.ts,router.tsx}`, `routes/__root.tsx`, `routes/auth/{login,logout,callback}.ts`, `server/{unavailable,errors}.ts`, `server/session/cookies.ts`, `server/auth/bff.ts` (`sameOrigin`, `logout`, `clearSid/clearTx`), `features/theme/{theme,ui-prefs}.ts`, `components/ui/sidebar.tsx`, `features/auth/sign-out-button.tsx`, `scripts/check-bundle.mjs`, `vitest.config.ts`, `test/{check-bundle,ssr-unavailable,users-ui}.test.*`.
- Thư viện, đọc source dist thật: `start-server-core/createStartHandler.js`, `start-client-core/{createCsrfMiddleware,getGlobalStartContext}.js`, `router-core/ssr/{hydrationScripts,ssr-server}.js`, `router-core/load-client.js`, `react-router/{Scripts,HeadContent,headContentUtils,ScriptOnce}.js`, `react-router/ssr/renderRouterToStream.js`.
- Khác: root `package.json`, `fe-sso-test/{vite.config.ts,test/router-lab.test.tsx}`, `e2e/playwright.config.ts`, `e2e/tests/admin-api-risk.spec.ts`.

### Sự thật từ code (sửa text ở trên)

**Nonce trong router/Start (phiên bản thực: start-client-core 1.170.34, router-core 1.171.34, react-router 1.170.41)**
- Nguồn nonce duy nhất là `router.options.ssr.nonce`. Giá trị này được dùng ở các chỗ sau:
  - `createHydrationScripts(router.options.ssr?.nonce)`: script `$_TSR` ban đầu và các chunk stream sau đó.
  - `Scripts`/`getSsrBodyScriptParts`: script entry và script của manifest.
  - `HeadContent`/`buildTagsFromMatches`: script/style ở head, kèm `<meta property="csp-nonce">`.
  - `ScriptOnce`.
  - `renderToReadableStream({ nonce })` của React: inline script Suspense `$RC…`.
- Client: `load-client.js` đọc lại nonce từ `meta[property="csp-nonce"]` khi hydrate.
- Start **không** tự sinh nonce, cũng **không** đặt header CSP.
- `src/router.tsx` hiện không truyền `ssr` ⇒ mọi inline script đều thiếu nonce (DEBT-269).
- `getRouter()` được gọi lười trong `executeRouter`, nằm trong `handler.fetch`. Vì vậy một `AsyncLocalStorage` bọc ở `src/server.ts` (giống `withUnavailableStatus`) có hiệu lực tại thời điểm tạo router.
- Không dùng `getGlobalStartContext()` để lấy nonce: hàm này throw khi chạy ngoài `runWithStartContext`. `getRouter` cũng được gọi từ `handleRedirectResponse`, mà hàm này nằm ngoài context đó (redirect của server fn).

**CSRF server fn (Q-51.2)**: ĐÃ CÓ.
- `start.ts` cài `createCsrfMiddleware({ filter: handlerType === "serverFn" })`, áp cho mọi `/_serverFn` (GET lẫn POST).
- Logic thư viện, theo thứ tự ưu tiên:
  1. Có `Sec-Fetch-Site` ⇒ chỉ chấp nhận `same-origin`.
  2. Nếu không có, xét `Origin` ⇒ phải bằng origin của `request.url`.
  3. Nếu không có `Origin`, xét `Referer` (đã chống look-alike).
  4. Không có cả ba ⇒ **403** (`allowRequestsWithoutOriginCheck` mặc định false). Tức là fail-closed.
- E2E `admin-api-risk.spec.ts` (run 43) đã replay 7 biến thể đều trả 403, có đối chứng 200.
- `/auth/logout` là server route (handlerType `router`, nằm ngoài filter). Route này tự kiểm `sameOrigin` (POST-only, `Sec-Fetch-Site`, nếu không có thì `Origin === APP_URL`).
- `/auth/login` và `/auth/callback` là GET; login CSRF bị chặn nhờ state gắn với cookie `fea_tx`.
- **Không đổi cơ chế.** Không truyền `origin: APP_URL` vào `createCsrfMiddleware`: `start.ts` cũng nằm trong bundle client, closure đọc `serverEnv` sẽ kéo env vào client.

**Cookie**
- `fea_sid`/`fea_tx` đã đúng: `HttpOnly; SameSite=Lax; Path=/`, host-only; khi `APP_URL` là https thì thêm `Secure` + `__Host-`. Cookie xoá dùng cùng serializer.
- `theme` (`theme.ts:18`, có `SameSite=Lax`) và `sidebar_state` (`sidebar.tsx:85`, **không có SameSite**) do JS ghi, cả hai **không có Secure**.
- Step-up không dùng cookie mà dùng `sessionStorage` `fea:stepup` (DEBT-292).

**DEBT-360**
- Máy dev có 28 core. Root `pnpm test` chạy 3 package **song song**: vitest fe-admin, vitest fe-sso-test và jest be, mỗi bên mặc định khoảng số core worker ⇒ quá tải CPU khoảng 3×.
- Hệ quả: `spawnSync node` trong `check-bundle.test.ts` vượt 5s; `findByRole` mặc định 1s trong `users-ui` hết hạn; `router-lab` assert pathname ngay mà không chờ.
- Kết luận: gốc là tranh chấp tài nguyên, không phải logic sai.

### Trả lời câu hỏi
- **Q-51.1**: dùng nonce, KHÔNG dùng hash, KHÔNG `strict-dynamic`.
  - Hash không khả thi vì payload `$_TSR` thay đổi theo từng request.
  - `strict-dynamic` vô hiệu `'self'`, dễ chặn nhầm script/HMR của Vite dev, trong khi chưa cần.
  - Đường đi: `server.ts` sinh nonce theo response ⇒ ALS ⇒ `getRouter()` đặt `ssr: { nonce }` ⇒ thư viện gắn nonce vào mọi script SSR/stream ⇒ client đọc meta. Chi tiết ở F2.
- **Q-51.2**: đã có và fail-closed (xem trên). Run này chỉ thêm test wiring ở mức unit cùng một case E2E `Sec-Fetch-Site: none` (F3).
- **Q-51.3**: sửa gốc bằng cách cho root `test` chạy tuần tự từng package. Thêm chờ theo điều kiện ở 1 chỗ và timeout riêng cho file spawn process. **Không tách run.** Cả run vừa 1 run, size M.

### Phạm vi, phân công, thứ tự
- Task 1 (frontend-dev, gồm DEBT-360/333/355/331 + DEBT-359) ⇒ Task 2 ⇒ Task 3 ⇒ Task 4. Tất cả giao **frontend-dev**; không có [BE].
- Đóng khi xong:
  - Task 1: DEBT-360/333/355/331/359.
  - Task 2: DEBT-269/266/298/292. DEBT-292 đóng vì CSP là lớp chặn chính đã có.
- Ngoài phạm vi:
  - DEBT-264 (adapter production): header cho asset tĩnh ở production thuộc DEBT-362.
  - DEBT-279/285/288/301/305/311/349.
  - Trusted Types/report-to (DEBT-363).
  - Siết `style-src` (DEBT-361).

### F1 — Task 1 [TEST/FE]: DEBT-360 (+333/355/331) và DEBT-359
- Root `package.json`: `"test": "pnpm -r --workspace-concurrency=1 --no-bail run --if-present test"`. Đây là sửa gốc; giữ `--no-bail`.
- `fe-sso-test/test/router-lab.test.tsx`: các assert pathname sau điều hướng async (case "purpose:lab…" dòng ~101 và "armed tamper…" dòng ~116) đổi thành `await waitFor(() => expect(router.state.location.pathname).toBe("/lab"))`.
- `fe-admin/test/check-bundle.test.ts`: chỉ đặt timeout 20 000 ms cho `describe` của file này. KHÔNG nâng `testTimeout` toàn cục.
- CẤM thêm `retry` của vitest/jest và CẤM tăng timeout toàn cục: những cách đó che lỗi chứ không sửa.
- `users-ui` không sửa (đã dùng `findByRole`); gốc của nó là CPU.
- DEBT-359 (`routes/index.tsx`): xem nội dung chi tiết trong backlog.
  - `CountCard` dùng `query.data.nextCursor === null`.
  - Tách `auditListQuery(params)` (`queryOptions`) dùng chung cho `useAuditEvents` và `useQueries` của `SecurityEvents`.
  - Test dashboard hiện có phải xanh **mà không sửa test**.
- Verify:
  - Root `pnpm test` xanh **3 lần liên tiếp**; ghi thời gian từng lần và số test mỗi package.
  - Chạy lệnh song song cũ 2 lần, chỉ để ghi nhận, không phải cổng.

### F2 — Task 2 [FE]: security headers + CSP nonce (DEBT-269/266/298)

**File mới `src/server/security-headers.ts`**
- Import `@tanstack/react-start/server-only` và dùng một `AsyncLocalStorage<{ nonce: string }>` riêng.
- `currentCspNonce(): string | undefined`: KHÔNG throw; trả `undefined` khi ở ngoài request.
- `withSecurityHeaders(handle, { appUrl?: string, issuer?: string })`:
  1. Sinh nonce bằng `randomBytes(16).toString("base64")`, mới cho **mỗi** response.
  2. Chạy `handle` trong ALS.
  3. Trả `new Response(res.body, { status, statusText, headers })`, trong đó `headers = new Headers(res.headers)` rồi `set` các header bảo mật bên dưới.
- Ràng buộc khi tạo response:
  - Không đọc body/stream.
  - Không mutate `res.headers`: `Response.redirect` có headers immutable.
  - Giữ **mọi** `Set-Cookie`.
- Header đặt cho mọi response đi qua server entry (HTML, `/_serverFn`, server route, trang lỗi, 503, 500 env lỗi):
  - `Content-Security-Policy`, chính xác các directive sau:
    `default-src 'self'; script-src 'self' 'nonce-<n>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <origin của OIDC_ISSUER>; frame-ancestors 'none'`
  - Giải thích các directive:
    - `form-action` phải có issuer: logout POST trả 303 tới `end_session_endpoint` (đã ép cùng origin issuer ở `discovery.ts`), và Chrome áp `form-action` cho cả redirect sau submit. Khi env lỗi (không có issuer) thì chỉ để `'self'`.
    - `style-src 'unsafe-inline'` là chấp nhận có chủ đích (Radix/sonner dùng inline style) ⇒ DEBT-361.
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: same-origin`. **Không dùng `no-referrer`**: với `no-referrer`, form POST cùng origin gửi `Origin: null`, làm hỏng nhánh fallback `Origin` của logout và CSRF.
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Strict-Transport-Security: max-age=31536000`: **chỉ khi** `appUrl` là https. Không thêm `includeSubDomains`/`preload`.
  - `Cache-Control: no-store`: **chỉ khi response chưa có** `cache-control` (DEBT-298). HTML chứa nonce không được phép cache.
- Nonce không bao giờ được log hay đưa vào thông điệp lỗi.

**`src/server.ts`**
- `withSecurityHeaders` bọc **ngoài cùng**, bọc cả nhánh 500 khi env lỗi, rồi mới tới `withUnavailableStatus(() => handler.fetch(request, opts))`.
- `appUrl` và `issuer` đọc từ `serverEnv()` khi env hợp lệ; khi env lỗi thì để `undefined` (không HSTS, `form-action 'self'`).

**`src/router.tsx`**
- `createRouter({ …, ssr: { nonce: cspNonce() } })`, với `cspNonce = createIsomorphicFn().server(() => currentCspNonce()).client(() => undefined)`.
- Phía client: `load-client` tự đọc meta.
- Xoá comment "No scrollRestoration… until A7" và thay bằng câu nói rằng nonce đến từ server entry. KHÔNG bật `scrollRestoration` trong run này.
- Nếu `vite build` báo lỗi `server-only` lọt vào client ⇒ DỪNG và báo lại. KHÔNG được né bằng cách bỏ marker `server-only`.

**Dev = prod cho `script-src`**
- Không có nhánh nới lỏng cho dev: cấm `'unsafe-inline'` và `'unsafe-eval'` ở mọi môi trường.
- Nếu Vite dev phát sinh vi phạm không gắn được nonce ⇒ DỪNG và báo tech-lead, KHÔNG tự nới.

**Test bắt buộc** (vitest, `// @vitest-environment node`)
- `test/security-headers.test.ts`:
  - (a) Parse CSP thành map và so **khớp đúng** tập directive ở trên. `script-src` không chứa `unsafe-inline`, `unsafe-eval`, `strict-dynamic` hay `*`.
  - (b) Nonce base64 decode ra ≥ 16 byte; hai lần gọi cho hai giá trị khác nhau; nonce trong header bằng `currentCspNonce()` đọc được bên trong `handle`; `currentCspNonce()` ở ngoài trả `undefined` và không throw.
  - (c) Response 303 có 2 `Set-Cookie` ⇒ `getSetCookie()` vẫn đủ 2 giá trị, đúng thứ tự.
  - (d) Bọc được `Response.redirect(...)` (headers immutable) mà không throw.
  - (e) Có sẵn `cache-control: private, max-age=60` ⇒ giữ nguyên; không có ⇒ `no-store`.
  - (f) HSTS chỉ xuất hiện khi https; http hoặc `undefined` ⇒ không có HSTS.
  - (g) Body stream đi qua nguyên vẹn: một ReadableStream gồm 2 chunk đọc ra đúng.
  - (h) 503 sinh từ `withUnavailableStatus` vẫn có đủ header; 500 khi env lỗi cũng vậy (test hàm, không cần chạy server entry).
  - (i) `form-action` có origin issuer khi được truyền, và là `'self'` khi không có.
- `test/csp-nonce-ssr.test.tsx`:
  - (a) `getRouter()` thật của `src/router.tsx`, gọi bên trong `withSecurityHeaders`, có `options.ssr.nonce` bằng nonce của header; gọi bên ngoài thì `undefined`.
  - (b) Router tối thiểu có loader trả promise `defer`/stream, render bằng `renderRouterToStream` với `ssr.nonce = N` ⇒ đọc toàn bộ HTML; **mọi** `<script` đều có `nonce="N"`, đếm ≥ 2 script, có `meta property="csp-nonce"`.
- Mutation bắt buộc (ghi lại kết quả RED, rồi khôi phục và kiểm sha256):
  1. Bỏ `ssr` khỏi `router.tsx`.
  2. Thêm `'unsafe-inline'` vào `script-src`.
  3. Dùng `headers.set("set-cookie", …)`, làm rơi cookie.
  4. Đặt HSTS khi http.
  5. Ghi đè `cache-control` đã có.
  6. Dùng một nonce cố định ở cấp module.
- Việc gỡ `withSecurityHeaders` khỏi `server.ts` chỉ E2E (F4) bắt được; phải ghi rõ điều này.

### F3 — Task 3 [FE]: cookie + CSRF + INV-20 log

**Cookie UI**
- Trong `features/theme/theme.ts`, tạo một helper `writePrefCookie(name, value, maxAgeSec)`:
  - Ghi `Path=/; Max-Age=…; SameSite=Lax`, thêm `; Secure` khi `location.protocol === "https:"`.
  - `persistTheme` và `sidebar.tsx:85` đều dùng helper này. Sửa trực tiếp file shadcn đã vendored là được phép.
- Không đặt HttpOnly: cookie do JS ghi, không chứa bí mật, và server đã whitelist giá trị (`parseTheme`, `!== "false"`). Đây là chấp nhận có chủ đích.
- Test happy-dom spy setter `document.cookie`:
  - http ⇒ không có `Secure`; https (đổi URL môi trường) ⇒ có `Secure`.
  - Cả hai cookie có `SameSite=Lax`.
  - Mutation bỏ nhánh Secure ⇒ RED.

**`fea_sid`/`fea_tx`**
- Không đổi. `SameSite=Lax` là bắt buộc: callback là điều hướng top-level đến từ IdP (`fea_tx`), và sau đó là chuỗi redirect cross-site. Nếu dùng `Strict`, cookie sẽ không được gửi ở lần tải đầu.
- Nếu chưa có test ma trận thì bổ sung: http/https × (login set tx, callback set sid và xoá tx, logout xoá sid, `viewer` xoá sid). Mọi `Set-Cookie` phải có `HttpOnly`, `SameSite=Lax`, `Path=/`, không có `Domain`; với https thì có thêm `Secure` và tên `__Host-`.

**CSRF**
- Không đổi code.
- Test unit wiring: lấy `requestMiddleware` từ `startInstance.getOptions()` (`start.ts`), gọi `options.server` với ctx giả `{ request, handlerType, next }`:
  - `handlerType: "serverFn"`, method GET và POST, các trường hợp: `Sec-Fetch-Site` `cross-site` / `same-site` / `none`; không có SFS nhưng `Origin` là `http://evil.example` hoặc `null`; không có header nào. Tất cả ⇒ 403 và `next` **không** được gọi.
  - `Sec-Fetch-Site: same-origin`, hoặc chỉ có `Origin` cùng origin ⇒ `next` được gọi.
  - `handlerType: "router"` ⇒ `next` được gọi.
  - Mutation: bỏ `csrfMiddleware` khỏi `requestMiddleware` ⇒ RED.
  - Nếu `createStart` không gọi được trong vitest ⇒ ghi lý do và chỉ dựa vào E2E (F4).

**INV-20 FE (log)**
- Thêm ESLint `no-console: "error"` cho `fe-admin/src/**`, override cho riêng `src/server/errors.ts`, nơi duy nhất ghi log.
- Test spy `console.error` qua các nhánh lỗi:
  - Đổi token ở callback, IdP trả 400 với body chứa canary `RT-CANARY`/`eyJ…`.
  - Refresh thất bại.
  - Admin API trả 500 với body JSON chứa canary.
  - Kỳ vọng: không dòng log nào chứa canary, `eyJ`, `Bearer ` hay giá trị cookie.
- Nếu `bff-risk`/`admin-api-risk` đã phủ các nhánh này thì chỉ ghi lại tên test, không viết lặp.

### F4 — Task 4 [E2E]: `e2e/tests/fe-admin-hardening.spec.ts` + một case CSRF

**Thu vi phạm CSP**
- `context.addInitScript` lắng nghe `securitypolicyviolation`, đẩy `violatedDirective + blockedURI` vào `window.__csp`.
- Cộng thêm `page.on("console")` cho các dòng chứa `Content Security Policy` hoặc `Refused to`.

**Kịch bản**
- Đăng nhập admin seed rồi đi lần lượt:
  - `/`, `/clients`, chi tiết một client, `/clients/new`, `/resources`, `/users`, chi tiết user.
  - `/audit`: mở Details.
  - `/keys` (super_admin).
  - Đổi theme, bật/tắt sidebar, reload.
- Cuối cùng logout bằng form, redirect tới IdP: đây là cách kiểm `form-action`.
- Kỳ vọng: **0 vi phạm** trên toàn kịch bản; mỗi trang đều kiểm cả listener lẫn console.

**Header của document `/` và `/clients`** (lấy từ `page.goto` response, và raw HTML qua `context.request.get` có cookie)
- CSP có `'nonce-X'` trong `script-src`, không có `unsafe-inline` trong `script-src`; có `frame-ancestors 'none'`.
- `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `cache-control` có `no-store`.
- Mọi `<script` trong raw HTML đều có `nonce="X"` trùng với header.
- Hai lần tải cho hai nonce khác nhau.
- Một response `/_serverFn` cũng có CSP, `nosniff` và `no-store`.

**Cookie** (`context.cookies()`)
- `fea_sid`: `httpOnly: true`, `sameSite: "Lax"`.
- `theme`/`sidebar_state`: `sameSite: "Lax"`. E2E chạy http nên không kiểm `Secure`.

**CSRF**
- Trong `admin-api-risk.spec.ts`, thêm replay `{ "sec-fetch-site": "none" }` ⇒ 403.

**Verify**
- Cả suite E2E xanh **2 lần liên tiếp**. Cổng :4000/:5173/:3000 trống; không dùng `E2E_REUSE`.
- `pnpm -C fe-admin build` rồi `check:bundle`, với `BUNDLE_CANARIES` là giá trị `OIDC_CLIENT_SECRET`/`SESSION_SECRET` dùng cho build ⇒ 0 hit. Không in giá trị canary ra log.

### Cổng security (senior-reviewer/tester đối chiếu)
- **Tài sản**:
  - Phiên admin (`fea_sid`) và các thao tác admin qua `/_serverFn`.
  - Toàn vẹn của trang admin trước script chèn vào (XSS) và trước clickjacking.
- **Actor**:
  - Site cross-origin (CSRF, framing).
  - Markup/script do kẻ tấn công chèn (XSS phản xạ/lưu trữ qua dữ liệu admin).
  - Proxy/cache dùng chung.
- **Invariant**:
  - Mọi response qua server entry đều có CSP nonce mới (≥128 bit) và không có `unsafe-inline` ở `script-src`.
  - Mọi `<script>` SSR/stream đều mang đúng nonce đó.
  - Response động là `no-store` (nonce không bị tái dùng qua cache).
  - Không `Set-Cookie` nào bị rơi.
- **Abuse cases** và chặn tương ứng:
  - CSRF server fn: 403 (unit + E2E).
  - Logout CSRF: đã có.
  - Clickjacking: `frame-ancestors`/XFO.
  - Inline script không nonce: bị chặn.
  - Nonce cố định hoặc bị cache: mutation 6 và `no-store`.
  - Rò Referer ra cross-origin: `same-origin`.
- **Ngữ nghĩa khi lỗi**:
  - Env lỗi ⇒ 500 vẫn có header.
  - Nonce không có (ngoài request) ⇒ script không có nonce ⇒ trình duyệt chặn (fail-closed, không âm thầm nới lỏng).
  - Dependency down ⇒ 503 vẫn có header.
- **Exposure**: không log nonce, token, cookie hay body upstream (INV-20 FE).

## Fold tech-lead — audit (2026-10-24)

Tech-lead đã tự xác minh lại qua `pnpm audit --json` và `npm view <pkg> time --json`:
- Lockfile `zod@4.6.5` là bản duy nhất. Có ở `be`, `fe-admin`, `fe-sso-test` (pin trực tiếp) và transitive qua `@tanstack/*` (`^4.5.4`), `@t3-oss/env-core` (`^3.24.0 || ^4.0.0`), `eslint-plugin-react-hooks` / `zod-validation-error` (`^3.25.0 || ^4.0.0`). Mọi range đều nhận 4.6.6.
- zod 4.6.6: phát hành 2026-10-11T16:18Z (13 ngày), 0 dependency. happy-dom 21.0.4: phát hành 2026-10-20T18:05Z (4 ngày). Danh sách dependency giống hệt 21.0.1, và mọi dependency đều đã có trong lockfile.

### Khả năng khai thác (đã kiểm code)
- **be**: `zod` chỉ dùng trong `src/config/validation.schema.ts` (env) và `src/database/seed*.ts`. Request input đi qua class-validator ⇒ advisory **không** khai thác được qua mạng ở BE.
- **fe-admin (BFF, runtime)**: `src/features/admin-api/inputs.ts` validate input của `/_serverFn` bằng các collection có ràng buộc (`z.array(...).max(20)`, `resourceScopes ... .max(RESOURCE_SCOPES_MAX)`). Đây đúng là dạng "oversized constrained collections". Trong `src/server*` không có giới hạn body nào. Cổng CSRF dựa vào header (`Sec-Fetch-Site`/`Origin`) mà client ngoài trình duyệt giả được. ⇒ Coi như **khai thác được, có thể trước auth** (DoS bộ nhớ trên tiến trình BFF). Chưa dựng PoC; không cần PoC để quyết định.
- **happy-dom**: chỉ devDependency (vitest ở fe-admin và fe-sso-test). Test chỉ render component của chúng ta, không nạp HTML/script hay import alias không tin cậy ⇒ khai thác được chỉ khi chính repo đã bị chèn code test, mà lúc đó kẻ tấn công vốn đã chạy được code trên máy dev/CI.

### Quyết định
1. **zod ⇒ BUMP 4.6.6 ngay (ngoại lệ có ghi nhận cho quy tắc ≥ 14 ngày).** Lý do:
   - Đây là bản sửa bảo mật cho lỗ hổng runtime khai thác được.
   - Chỉ thiếu < 1 ngày (đủ 14 ngày lúc 2026-10-25T16:18Z).
   - Là patch 0 dependency nên không kéo transitive mới.
   - Chọn 4.6.6 chứ không chọn 4.6.7 (2026-10-12) vì 4.6.6 cũ hơn và là bản sửa tối thiểu.
2. **happy-dom ⇒ `ignoreGhsas` tạm, KHÔNG bump trong run này.** Lý do:
   - Chỉ dùng cho dev, không có đầu vào không tin cậy.
   - Bản 21.0.4 mới 4 ngày. Rủi ro supply-chain của một bản 4 ngày tuổi chạy trên máy dev/CI lớn hơn rủi ro của advisory.
   - Re-review/bump vào **2026-11-04**, khi 21.0.4 đủ 14 ngày (DEBT-369).
3. Không giảm thiểu kiểu khác (giới hạn body/collection ở BFF) trong run này. Ghi thành DEBT-370 (defense-in-depth).

### Thay đổi file chính xác (backend-dev làm `be`, frontend-dev làm phần còn lại; một người chạy `pnpm install` một lần)
- `be/package.json`, `fe-admin/package.json`, `fe-sso-test/package.json`: `"zod": "4.6.5"` ⇒ `"zod": "4.6.6"`.
- `pnpm-workspace.yaml`, cuối block `overrides:`, thêm vào:
  ```yaml
    # Run 51 (tech-lead): GHSA-mrhx-c7xc-m3w5 (zod <4.6.6, high, memory DoS on oversized constrained
    # collections; fe-admin BFF validates /_serverFn input with it). Forces transitive copies
    # (@tanstack/*, @t3-oss/env-core, eslint-plugin-react-hooks) onto the fix. Security exception to the
    # 14-day rule: 4.6.6 released 2026-10-11, 0 deps. Drop on the next zod bump (DEBT-369).
    zod: 4.6.6
  ```
- `pnpm-workspace.yaml`, trong `auditConfig.ignoreGhsas`, thêm sau entry braces:
  ```yaml
      # happy-dom >=17 <=21.0.3 (high, import-alias host code execution) - dev-only (vitest env in
      # fe-admin/fe-sso-test), tests render only our own components, no untrusted HTML/scripts. Fix
      # 21.0.4 is 4 days old (2026-10-20). Bump to 21.0.4 and drop this entry on/after 2026-11-04
      # (DEBT-369).
      - GHSA-834v-8h66-3h79
  ```
- Chạy `pnpm install` (KHÔNG `pnpm up`, KHÔNG `pnpm add`).

### Verify (bắt buộc, dán output vào log)
- `git diff --stat` chỉ thêm 3 `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` vào các file run 51 đã đổi trước đó.
- Diff lockfile chỉ đổi zod:
  - Các dòng `+`/`-` trong `git diff pnpm-lock.yaml` chỉ được chứa:
    - dòng `zod: 4.6.6` trong `overrides:`;
    - specifier/version `4.6.5→4.6.6` ở 3 importer;
    - key `zod@4.6.5:` ⇒ `zod@4.6.6:` (packages và snapshots);
    - `integrity` ⇒ `sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==`;
    - các tham chiếu `zod: 4.6.6` và `zod-validation-error: 4.0.2(zod@4.6.6)`.
  - Không có package nào khác, `happy-dom` không đổi.
  - Nếu thấy bất kỳ dòng khác ⇒ dừng, `git checkout pnpm-lock.yaml`, báo lại.
- `grep -c "zod@4.6.5" pnpm-lock.yaml` ⇒ `0`. `pnpm -r why zod` ⇒ chỉ 4.6.6.
- Tuổi transitive mới: không có transitive mới (zod 4.6.6 có 0 dependency). Xác nhận rằng không có key package mới nào ngoài `zod@4.6.6` trong diff lockfile.
- `pnpm audit --audit-level high` ⇒ exit 0 (2 ignored: braces, happy-dom).
- `pnpm -C be typecheck && pnpm -C be test`.
- `pnpm -C fe-admin typecheck && pnpm -C fe-admin lint && pnpm -C fe-admin test && pnpm -C fe-admin build && pnpm -C fe-admin check:bundle`: zod jitless/eval probe phải vẫn 0.
- `pnpm -C fe-sso-test typecheck && pnpm -C fe-sso-test test`.
- Tester chạy lại: cổng audit, cùng smoke prod CSP (0 vi phạm). Không phải chạy lại toàn bộ E2E trừ khi bước trên đỏ.
