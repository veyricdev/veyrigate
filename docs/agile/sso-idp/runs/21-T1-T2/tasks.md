# Tasks — run 21 (`21-T1-T2`): T1 scaffold + T2 OIDC client viết tay

> Nguồn: `plan.md` §7 (Phase T, T1/T2), §9 ma trận INV (INV-6/-7/-9), `spec.md` §7 (RFC 8707 resource), §9.1–9.2 (state/nonce/PKCE/resource binding), §9.8 (logout 4 lớp / RP-initiated), §12 discovery. X1 (walking skeleton Playwright) **thuộc run 22** — chỉ ghi "cần sẵn cho X1" ở đây, không làm.
>
> Phạm vi run này: **chỉ T1 + T2** (+ 1 task [BE] nhỏ về điều kiện tiên quyết cho X1). Không làm T3–T7.

## Quyết định công cụ (đã chốt cho run này)

- **Test FE**: **Vitest + happy-dom** (nhanh; WebCrypto `crypto.subtle` có sẵn trong Node 22 → test PKCE S256 thật, không mock). Không dùng jsdom (WebCrypto yếu hơn). `jose` chạy được trên Node → test validate ID token dùng JWKS thật do test tự ký bằng key RSA tạm.
- **Router**: React Router **Data Mode** `createBrowserRouter` (SPA thuần, không SSR) — đúng plan §7/T1.
- **Tailwind**: **BỎ** (khuyến nghị plan). App test không cần hệ thống style; CSS tối thiểu thủ công. Nếu người dùng muốn, thêm sau, không chặn T1/T2.
- **Build/pkg manager**: ~~Vite 5~~ **Vite 8.3.4** + pnpm workspace (node 22). *(tech-lead fold F1)* Ghim exact: `react`/`react-dom` 19.3.0, `react-router` 8.4.0 (Data Mode `createBrowserRouter`; fallback 7.18.4 nếu vướng breaking v8 — ghi lý do vào log), `@vitejs/plugin-react` 6.1.2, `vitest` 5.0.4, `happy-dom` 21.0.1, `jose` 6.2.12, `zod` 4.6.5, `typescript` 5.7.3 + `eslint` 9.18.0 (khớp BE; KHÔNG TS 7.x — `typescript-eslint` 8.71.2 cần TS <6.1). Test crypto/jose dùng `// @vitest-environment node`; happy-dom chỉ cho test component/router. Thay thế `package.json` placeholder hiện có (giữ tên `@sso-idp/fe-sso-test`).

## Quyết định đã chốt bởi tech-lead *(tech-lead fold)*

> OPEN-1: **chấp nhận** (in-memory, reload ⇒ anonymous). OPEN-2: **không** làm silent `prompt=none`. OPEN-3: xử lý cả 2 nhánh — BE chỉ phát `refresh_token` khi client có grant `refresh_token` **và** scope có `offline_access`; scope mặc định `.env.example` ⇒ KHÔNG có refresh_token (đường mặc định). Task 4: phương án (i) rút gọn, KHÔNG làm `/demo/me`. Chi tiết: `review-techlead.md`.

## Quyết định MỞ ban đầu (giữ để tham chiếu)

- **OPEN-1 — Token chỉ trong bộ nhớ ⇒ mất khi reload/refresh trang.** Plan yêu cầu "không localStorage". Phương án an toàn đề xuất: **chấp nhận** mất phiên khi hard-reload cho app TEST (đây là lab kiểm chứng IdP, không phải app production); sau reload hiển thị trạng thái "chưa đăng nhập". KHÔNG dùng localStorage/sessionStorage cho access/ID/refresh token. (Nếu sau này cần giữ phiên qua reload → dùng silent `prompt=none` ở OPEN-2, KHÔNG dùng web storage.)
- **OPEN-2 — Silent login `prompt=none`.** Plan T5 (run sau) có kịch bản `prompt=none`. Trong T2 run này: **KHÔNG hiện thực silent/iframe login**; chỉ bảo đảm client gửi/không gửi `prompt` đúng khi được truyền. Ghi nợ cho T3/T5. Lý do: tránh phụ thuộc cookie topology (spec §9.6) chưa chốt.
- **OPEN-3 — Refresh token cho public client.** `/token` phát refresh token cho SPA public client hay không tuỳ cấu hình client ở BE. T2 phải xử lý **cả hai**: nếu không có `refresh_token` trong response → chỉ dùng access/ID token, không crash; nếu có → hỗ trợ refresh + rotation. Không giả định luôn có refresh token.

---

### [x] Task 1 — T1 [FE]: Scaffold `fe-sso-test` (Vite + React + TS + React Router Data Mode) + `env.ts` (zod)
- Mô tả: Thay `fe-sso-test/package.json` placeholder bằng app thật. Vite + React + TypeScript; `createBrowserRouter` với tối thiểu route `/` và `/callback` (stub, nội dung thật ở T3). `src/env.ts` đọc `import.meta.env.VITE_*` và validate bằng **zod** đúng các biến trong `.env.example` hiện có (`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_POST_LOGOUT_URI`, `VITE_OIDC_SCOPE`, `VITE_OIDC_RESOURCE`, `VITE_DEMO_API_URL`). Scripts: `dev` (Vite, port cố định 5173), `build`, `typecheck` (`tsc --noEmit`), `lint`, `test` (vitest). Thêm cấu hình Vitest + happy-dom. KHÔNG thêm Tailwind.
- Acceptance (đo được):
  - `pnpm --filter @sso-idp/fe-sso-test dev` phục vụ ở `http://localhost:5173` (port cố định trong `vite.config.ts`, `strictPort: true`).
  - Khi **thiếu/sai** 1 biến env bắt buộc (vd. xoá `VITE_OIDC_ISSUER`): `env.ts` **ném lỗi rõ ràng** nêu đúng tên biến thiếu + gợi ý `cp .env.example .env`; app dừng với thông báo đọc được (không phải `undefined` âm thầm). `VITE_OIDC_ISSUER`/`REDIRECT_URI`/`POST_LOGOUT_URI`/`RESOURCE`/`DEMO_API_URL` phải là URL hợp lệ (zod `.url()`); `RESOURCE` phải là absolute URI **không fragment** (spec §7).
  - `pnpm --filter @sso-idp/fe-sso-test typecheck` và `lint` chạy pass (0 lỗi).
  - `pnpm --filter @sso-idp/fe-sso-test test` chạy được (ít nhất 1 test env: thiếu biến → throw; đủ biến → trả object đã parse).
  - `pnpm install` ở root không hỏng workspace; node 22.
- Security invariants: **N/A trực tiếp** (scaffold). Lưu ý phòng ngừa: `env.ts` chỉ nhận biến `VITE_*` (client-exposed) — KHÔNG đọc/đóng gói secret nào; app là public client nên `.env` không chứa client secret (đúng `.env.example`). Không log giá trị env ra console ngoài tên biến thiếu.
- Phụ thuộc: không (R1 đã xong — workspace sẵn). Chặn T2.
- § trỏ: plan §7/T1; `.env.example` hiện có; spec §7 (resource absolute URI, no fragment).

### [x] Task 2 — T2 [FE]: OIDC discovery + bắt đầu login (PKCE S256, state, nonce, redirect `/authorize`)
- Mô tả: `src/oidc/` client mỏng viết tay. (a) **Discovery**: fetch `{VITE_OIDC_ISSUER}/.well-known/openid-configuration`, lấy `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `end_session_endpoint`, `userinfo_endpoint` (BE đã có các field này). (b) **PKCE S256** qua WebCrypto `crypto.subtle` (verifier ngẫu nhiên base64url 43–128 ký tự, challenge = base64url(SHA-256(verifier))). (c) Sinh `state`, `nonce` ngẫu nhiên (`crypto.getRandomValues`). (d) Lưu `{state, nonce, code_verifier}` tạm **chỉ cho phiên redirect** (sessionStorage CHỈ cho 3 giá trị transient này — KHÔNG lưu token; xoá ngay sau callback). (e) Dựng URL `/authorize` kèm `response_type=code`, `client_id`, `redirect_uri`, `scope` (từ env), `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, **`resource`** (RFC 8707, từ env), rồi điều hướng trình duyệt.
- Acceptance (đo được):
  - Unit test: PKCE `S256` — challenge đúng = base64url không padding của SHA-256(verifier); method luôn `S256` (không bao giờ `plain`).
  - Unit test: discovery parse đúng, thiếu endpoint bắt buộc → lỗi rõ.
  - Unit test: URL `/authorize` chứa đủ 9 tham số trên; `resource` đúng giá trị env; `code_challenge_method=S256`.
  - `state`/`nonce` ≥ 128-bit entropy, mỗi lần gọi khác nhau (test gọi 2 lần → khác).
  - *(tech-lead fold F5)* `discovery.issuer` phải **===** `VITE_OIDC_ISSUER`; khác ⇒ lỗi, không dựng URL. Test âm.
  - *(tech-lead fold F6)* Mọi `fetch` (discovery/token/JWKS) có `AbortSignal.timeout(10_000)`; transient lưu kèm `createdAt`. Test: discovery treo ⇒ lỗi timeout rõ ràng.
  - *(tech-lead fold OPEN-2)* `prompt` chỉ thêm khi được truyền vào; mặc định không có.
- Security invariants:
  - **Tài sản**: `code_verifier`, `state`, `nonce` (bí mật phiên redirect). **Actor**: anonymous (chưa login) khởi tạo; attacker có thể cố CSRF/phishing callback.
  - **Invariant**: `code_verifier` KHÔNG bao giờ gửi tới `/authorize` (chỉ challenge); verifier chỉ gửi `/token`. `state`/`nonce` mới mỗi lần bắt đầu login (không tái sử dụng). `code_challenge_method` cố định `S256`.
  - **Trust boundary**: giá trị transient qua sessionStorage → đọc lại ở callback (Task 3 trong file này). State trước→sau: `anonymous` → sinh PKCE/state/nonce + lưu transient → redirect ra IdP.
  - **Exposure budget**: `code_verifier` tuyệt đối KHÔNG xuất hiện trong URL `/authorize`, log, hay response; chỉ `code_challenge` ra ngoài.
- Phụ thuộc: Task 1. Chặn Task 3.
- § trỏ: plan §7/T2, INV-3/INV-9; spec §9.1 (state vs nonce), §9.2 (code flow + PKCE + resource), §7 (resource); discovery BE `discovery.controller.ts`.

### [x] Task 3 — T2 [FE]: Callback + đổi code + validate ID token + token trong bộ nhớ + refresh rotation + logout
- Mô tả: Hoàn tất T2. (a) **Callback `/callback`**: đọc `code`, `state`, `iss`, `error`/`error_description` từ query. Kiểm `state` khớp giá trị transient (sai → từ chối, hiển thị lỗi). Kiểm **`iss`** trong redirect khớp `VITE_OIDC_ISSUER` (INV-9, BE gửi `iss` ở redirect). (b) **Đổi code** tại `/token`: public client, `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier` — **KHÔNG gửi client_secret** (`token_endpoint_auth_method=none`). (c) **Validate ID token** bằng `jose`: chữ ký qua JWKS (`createRemoteJWKSet(jwks_uri)`), `iss`===issuer, `aud`===`client_id` (INV-7), `exp` chưa hết hạn, **`nonce`**===nonce transient (INV-6). Sai bất kỳ điều kiện → login thất bại, xoá state, hiển thị lỗi. (d) **Lưu token CHỈ trong bộ nhớ** (module/React state) — KHÔNG localStorage/sessionStorage (xoá transient state/nonce/verifier sau khi dùng). (e) **Refresh**: nếu có `refresh_token`, hàm refresh gọi `/token` `grant_type=refresh_token`, cập nhật token mới; **xử lý rotation** (luôn thay refresh token bằng cái mới trả về; vứt cái cũ). Nếu không có refresh_token → bỏ qua (OPEN-3). (f) **RP-initiated logout**: điều hướng tới `end_session_endpoint` kèm `id_token_hint`, `post_logout_redirect_uri` (từ env), và xoá token khỏi bộ nhớ.
- Acceptance (đo được):
  - Unit test validator ID token: token hợp lệ (tự ký bằng RSA key test, JWKS test) → pass; **đổi `nonce`** → fail; **đổi `aud`** → fail; **đổi `iss`** → fail; `exp` quá khứ → fail; chữ ký sai → fail. (Mỗi điều kiện 1 test.)
  - Unit test callback: `state` không khớp → từ chối, không gọi `/token`. `iss` redirect khác issuer → từ chối.
  - Unit test: **đổi 1 tham số (state HOẶC nonce HOẶC iss) ⇒ login thất bại đúng cách** (plan nghiệm thu gốc) — fail đóng (fail-closed), KHÔNG cấp phiên.
  - Unit test refresh rotation: response refresh mới có `refresh_token` khác → client lưu cái mới, cái cũ không còn tham chiếu.
  - Kiểm chứng "token trong bộ nhớ": test/giả lập reload → không còn token (không đọc được từ web storage). Lint/grep đảm bảo không có `localStorage.setItem`/`sessionStorage.setItem` cho token.
  - Logout: hàm dựng URL `end_session_endpoint` đúng với `id_token_hint` + `post_logout_redirect_uri`; sau logout bộ nhớ token rỗng.
  - *(tech-lead fold F2)* Callback **chỉ đổi code 1 lần** (StrictMode chạy effect 2 lần): đổi code trong route loader `/callback` hoặc single-flight theo `code`; xoá transient **trước** khi gọi `/token` (kể cả nhánh lỗi). Test: chạy handler callback 2 lần cùng URL ⇒ `fetch(token_endpoint)` đúng 1 lần. KHÔNG retry `/token` grant `authorization_code`. Transient quá 10 phút ⇒ từ chối.
  - *(tech-lead fold F5)* `iss` trong callback **bắt buộc có** (BE quảng bá `authorization_response_iss_parameter_supported: true`); thiếu ⇒ từ chối. `jwtVerify` ghim `algorithms: ['RS256']`, `issuer`, `audience`, `clockTolerance` ≤ 60s. Test: token `alg` khác RS256 ⇒ fail.
  - *(tech-lead fold F3)* Refresh **single-flight**: 2 lời gọi song song ⇒ 1 request `/token`, cùng kết quả. Refresh lỗi (`invalid_grant`/timeout) ⇒ xoá toàn bộ token, về anonymous, không retry tự động.
  - *(tech-lead fold F4)* ID token từ refresh **không có `nonce`** (BE): validator chế độ refresh yêu cầu `sub` === `sub` cũ, `iss`/`aud`/`exp`/sig như callback; có `nonce` thì phải bằng nonce gốc. Test âm: `sub` khác ⇒ từ chối + xoá phiên. Không có refresh_token ⇒ refresh no-op, không gọi mạng (test).
  - *(tech-lead fold F7)* Access token coi như **opaque** với RP (không dùng claims để quyết định); không `console.*` token/code/verifier (test grep `src/`).
- Security invariants:
  - **Tài sản**: access/ID/refresh token, phiên người dùng. **Actor**: owner (người login), attacker (CSRF callback, replay refresh, forged ID token/mix-up).
  - **Invariant**: ID token KHÔNG được tin nếu sai chữ ký / `iss` / `aud` / `exp` / `nonce` (fail-closed). `state` mismatch ⇒ hủy (chống CSRF). `iss` trong redirect phải khớp (chống mix-up/IdP confusion, INV-9). Refresh token cũ KHÔNG tái sử dụng sau rotation. Token KHÔNG rời khỏi bộ nhớ (không web storage, không URL, không log).
  - **Trust boundary + state transition**: `anonymous+transient(state,nonce,verifier)` → callback kiểm state/iss → đổi code → validate ID token → `authenticated(in-memory tokens)`; refresh: `authenticated` → `/token` rotate → `authenticated(token mới)`; logout: `authenticated` → `end_session` → `anonymous`.
  - **Abuse/failure**: `error` từ IdP → hiển thị `error_description`, không crash; `/token` lỗi/timeout → fail-closed, không coi là đăng nhập; JWKS fetch fail → từ chối token; code đã dùng/hết hạn → IdP trả lỗi → hiển thị.
  - **Exposure budget**: token/`code_verifier`/`refresh_token` tuyệt đối KHÔNG vào localStorage/sessionStorage, URL, log console, hay `post_logout_redirect_uri`. Chỉ `id_token_hint` (ID token, chấp nhận theo chuẩn OIDC RP-logout) đi trong URL logout.
- Phụ thuộc: Task 2. (Để chạy login **thật** với BE cần Task 4 + B6.4 — xem ghi chú X1.)
- § trỏ: plan §7/T2, INV-6/-7/-9/-10/-11; spec §9.2 (đổi code), §9.8 (logout RP-initiated / end_session), §12 (discovery jwks/end_session); run 14 (refresh rotation), run 16 (`at+jwt`), run 17 (`end_session_endpoint`).

### [x] Task 4 — [BE] *(owner: backend-dev, làm SAU Task 1–3 của frontend-dev)* Điều kiện tiên quyết cho X1: seed public client `fe-sso-test` + demo resource + CORS `:5173`
- Mô tả: **Kiểm tra code BE** (đã làm trong run này): BE CÓ sẵn — discovery (`/.well-known/openid-configuration` với `end_session_endpoint`, `jwks_uri`, `token_endpoint_auth_methods_supported: [..., 'none']`), CORS **động theo client** (`Client.allowedCorsOrigins`, `client-cors.service.ts`), `ClientService.create` nhận `clientType:'public'` + `redirect_uris` + `allowedCorsOrigins` + `allowedResources`. BE **THIẾU**: chưa có seed/provisioning tự động cho client `fe-sso-test` (public, redirect `http://localhost:5173/callback`, CORS origin `http://localhost:5173`, post-logout `http://localhost:5173/`), resource `demo`, và endpoint `GET /demo/me`. Theo plan, việc này là **B6.4 (seed idempotent)** + **B6.5/B4.6 (demo-resource)** — **chưa tới** (đang M4, B6 chưa làm).
  - **Chốt tech-lead** *(tech-lead fold F8)*: chọn **(i) rút gọn** — CLI dev-only `be/src/database/seed-dev.ts` (mẫu `sync-indexes.ts`) + script `db:seed-dev` trong `be/package.json`; **KHÔNG** chạy lúc boot, **KHÔNG** tự chạy trong int-test. **`GET /demo/me` KHÔNG làm** (B6.5 — chặn T4, không chặn X1). Cấu hình đích (upsert `$set` theo khoá, bắt E11000 như `TenantService.seedDefault`):
    - Resource: `resourceId='demo'`, `identifier` = `${ISSUER bỏ '/' cuối}/demo/` (exact = `VITE_OIDC_RESOURCE` = `http://localhost:4000/demo/`), qua `validateResourceFormat`.
    - Client `fe-sso-test`: `clientType:'public'`, `tokenEndpointAuthMethod:'none'`, `grantTypes:['authorization_code','refresh_token']`, `scopes:['openid','profile','email','offline_access']`, `redirectUris:['http://localhost:5173/callback']`, `postLogoutRedirectUris:['http://localhost:5173/']`, `allowedCorsOrigins:['http://localhost:5173']`, `allowedResources:['demo']`, `tenantId: DEFAULT_TENANT_ID`; URI qua `validateRedirectUriList`. **Không** tạo `ClientCredential`.
    - `NODE_ENV=production` ⇒ thoát mã ≠0 **trước khi kết nối DB**. Log chỉ "upserted client/resource <id>".
  - (Nguyên văn analyst) Trong run này: cung cấp **một cách provision tối thiểu, lặp lại được** để X1 (run 22) chạy được, KHÔNG viết lại B6.4 đầy đủ. Lựa chọn (tech-lead chốt): (i) thêm seed dev nhỏ idempotent tạo riêng client `fe-sso-test` + resource `demo` khi `NODE_ENV!=production`; HOẶC (ii) script/README dùng Admin API (B6.3) để tạo thủ công; HOẶC (iii) **chỉ ghi nợ** và để run 22 phụ thuộc B6.4/B6.5.
  - Nếu không thêm code BE trong run này → **đánh dấu task là ghi nợ + điều kiện chặn cho run 22** (không để X1 bị bất ngờ).
- Acceptance (đo được):
  - Tài liệu/ghi chú trong `log.md` + `tasks.md`: nêu rõ BE đã sẵn gì / thiếu gì cho X1 (đã xong ở trên). ✅ bắt buộc.
  - NẾU chọn (i): sau khi khởi động BE dev, tồn tại client `fe-sso-test` (public, redirect `http://localhost:5173/callback`, `allowedCorsOrigins` chứa `http://localhost:5173`, `allowedResources` chứa `demo`) và resource `demo`; chạy seed 2 lần không nhân đôi (idempotent); có test tích hợp xác nhận. `GET /demo/me` trả 401 khi thiếu/`aud` sai, 200 khi access token `aud=demo` hợp lệ (INV-8) — hoặc hoãn demo endpoint sang B6.5 nếu phạm vi quá lớn, ghi rõ.
  - NẾU chọn (ii)/(iii): README/`log.md` ghi lệnh/bước chính xác và liệt kê B6.4/B6.5 là phụ thuộc chặn của run 22.
  - *(tech-lead fold F9 — acceptance áp dụng)* Int-test gọi hàm seed (export, nhận connection) 2 lần ⇒ đúng 1 client + 1 resource, mọi trường đúng exact; `NODE_ENV=production` ⇒ throw, 0 ghi DB; sau seed, `GET /authorize` `client_id=fe-sso-test` + `scope=openid profile email` + `resource=http://localhost:4000/demo/` + PKCE S256 ⇒ KHÔNG `invalid_scope`/`invalid_target`/lỗi client; preflight `OPTIONS /token` Origin `http://localhost:5173` ⇒ ACAO đúng origin, Origin `http://localhost:5174` ⇒ không ACAO. `be` lint/typecheck/test/test:int xanh. README `be/` thêm 1 dòng lệnh seed.
- Security invariants:
  - **Tài sản**: cấu hình client/resource (control-plane). **Actor**: dev (seed), attacker (lợi dụng client dư thừa).
  - **Invariant**: client `fe-sso-test` là **public** ⇒ `token_endpoint_auth_method=none`, **không có secret**; `redirect_uris` khớp **tuyệt đối** `http://localhost:5173/callback` (INV-4); `allowedCorsOrigins` chỉ chứa origin dev `http://localhost:5173` (không wildcard). Seed dev **không** chạy ở `production` (fail-closed theo env).
  - **Trust boundary**: seed ghi vào DB control-plane — chỉ từ code server tin cậy; không nhận input ngoài.
  - **Exposure budget**: không log secret (public client không có secret). Không nới CORS global.
- Phụ thuộc: độc lập về code với Task 1–3 (nhưng cùng mục tiêu X1). Chặn **run 22 / X1**.
- § trỏ: plan §7/T2 (phụ thuộc B4.1–B4.4), §8/X1, B6.4 (seed), B6.5/B4.6 (demo-resource), INV-4/INV-8; BE `client.service.ts`, `client-cors.service.ts`, `discovery.controller.ts`.

---

## Ghi chú "cần sẵn cho X1" (run 22 — Playwright walking skeleton)

1. **Client seed**: `fe-sso-test` public client phải tồn tại trong BE (redirect `http://localhost:5173/callback`, post-logout `http://localhost:5173/`, CORS origin `http://localhost:5173`, allowedResources chứa `demo`). → Task 4 / B6.4.
2. *(tech-lead fold)* Resource `demo` do Task 4 seed; `GET /demo/me` hoãn B6.5 (chặn T4, không chặn X1). X1 còn cần **user đã verify email** — DEBT-076.
   (gốc) **Resource `demo` + `GET /demo/me`**: cần cho T4 và để X1 chứng minh access token dùng được; nếu chưa có ở run 21 → B6.5/B4.6 là phụ thuộc chặn của X2 (X1 tối thiểu chỉ cần hiển thị claims ID token, không bắt buộc gọi resource).
3. **CORS origin `:5173`**: cơ chế động đã có (DB-driven); chỉ cần origin nằm trong `allowedCorsOrigins` của client qua seed (mục 1). Không cần sửa code CORS.
4. **Discovery/end_session/JWKS**: đã sẵn ở BE (kiểm trong run 21). Không cần việc thêm.
5. **Token lifetime**: access 15' (Q6 đã chốt) — X1/T3 countdown dựa trên `exp`.
n