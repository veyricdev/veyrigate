# Tech Lead Review — 2026-10-13

## Kết luận: PASS (kèm fold bắt buộc vào `tasks.md`, đánh dấu *(tech-lead fold)*)

Plan đúng vấn đề (T1+T2, X1 để run 22), đúng kiến trúc (SPA public client mỏng trong monorepo, không thêm service). Các lỗ hổng tìm được đều cụ thể, sửa được trong phạm vi task → fold thay vì REJECT. Thứ tự: **frontend-dev Task 1 → 2 → 3**, sau đó **backend-dev Task 4**.

## Kiến trúc đề xuất (điều chỉnh)

- Giữ nguyên: Vite SPA + React Router Data Mode + client OIDC viết tay trong `src/oidc/` (thuần TS, không phụ thuộc React) + `jose`. Không BFF, không thư viện OIDC (T6 mới so sánh `oidc-client-ts`).
- `src/oidc/` là hàm thuần, inject `fetch`/JWKS/storage/clock → test không cần mạng.
- Task 4: **CLI dev-only** `be/src/database/seed-dev.ts` (cùng mẫu `sync-indexes.ts`, script `db:seed-dev`), KHÔNG hook boot — tránh làm bẩn DB int-test (`clients.int-spec.ts` dùng origin `http://localhost:5173` để kiểm CORS) và không có side-effect ngầm ở production.

## Chốt quyết định mở

| Mục | Quyết định |
|---|---|
| OPEN-1 | **Chấp nhận**: token chỉ trong bộ nhớ, reload ⇒ anonymous. Cấm localStorage/sessionStorage cho access/ID/refresh token. sessionStorage chỉ cho `{state, nonce, code_verifier, createdAt}` transient, xoá ngay khi vào callback (cả nhánh lỗi). |
| OPEN-2 | **Không** làm silent `prompt=none`/iframe run này. `prompt` chỉ truyền khi được cung cấp. Silent login → T5. |
| OPEN-3 | **Xử lý cả 2 nhánh**. BE chỉ phát `refresh_token` khi `client.grantTypes` chứa `refresh_token` **VÀ** scope chứa `offline_access` (`token.service.ts` `issueForAuthorizationCode`). Scope mặc định `.env.example` (`openid profile email`) ⇒ **không có** refresh_token — đó là đường mặc định; nhánh refresh test bằng fetch giả. |
| Công cụ | Vitest + happy-dom, **bỏ Tailwind**. Test crypto/jose chạy `// @vitest-environment node` (tránh lệch realm `Uint8Array` giữa DOM giả và WebCrypto Node); happy-dom chỉ cho test component/router. |
| Task 4 | **Làm ngay run này**, phương án (i) rút gọn: seed dev tối thiểu (client `fe-sso-test` + resource `demo`), idempotent, không secret, CLI opt-in. **`GET /demo/me` KHÔNG làm** — X1 chỉ cần hiển thị claims ID token; `/token` chỉ cần bản ghi `Resource` để mint access token (`invalid_target` nếu thiếu resource). `/demo/me` = B6.5, chặn T4, không chặn X1. |

## Phiên bản thư viện (registry ngày 2026-10-13, ghim exact theo quy ước repo)

- `react-router` **8.4.0** — bản mới nhất là v8 (không phải v7); `createBrowserRouter` vẫn export; engine `node >=22.22.0` (repo pin 22.23.2, máy dev 22.22.3 ✔). Gặp breaking v8 chưa rõ → fallback `7.18.4`, ghi lý do vào log.
- `react`/`react-dom` 19.3.0 (peer RR8 ≥19.2.7 ✔); `vite` **8.3.4** (tasks.md ghi Vite 5 — sai); `@vitejs/plugin-react` 6.1.2 (peer vite ^8); `vitest` 5.0.4 (peer vite ^8, node ^22.12); `happy-dom` 21.0.1; `jose` 6.2.12 (BE dùng 5.10 — gói tách biệt, chấp nhận); `zod` 4.6.5 (khớp BE).
- `typescript` **5.7.3** + `eslint` **9.18.0** khớp BE. KHÔNG dùng TS 7.x: `typescript-eslint` 8.71.2 yêu cầu `typescript <6.1.0`.

## Điểm mạnh

- Bám sát INV-6/7/9, có test âm từng điều kiện (nonce/aud/iss/exp/sig/state), fail-closed.
- Khảo sát BE đúng: discovery có `end_session_endpoint`, `authorization_response_iss_parameter_supported: true`, auth method `none`; CORS động theo client (`ClientCorsService`, preflight cho `/token`, `/jwks.json`, discovery).
- Nhận diện sớm phụ thuộc X1 thay vì để run 22 bất ngờ.

## Vấn đề (đã fold vào tasks.md — dev bắt buộc làm)

- [x] **F1 (Task 1)** Sửa phiên bản: Vite 5 → 8.3.4 cùng bộ version ở trên.
- [x] **F2 (Task 3) Đổi code 2 lần** — React StrictMode chạy effect 2 lần ở dev ⇒ gửi code lần 2 ⇒ BE `consume` trả null ⇒ `invalid_grant` (code dùng 1 lần, `authorization-code.service.ts`) ⇒ UI báo lỗi/ghi đè phiên vừa tạo (race). Bắt buộc: đổi code trong route **loader** `/callback` hoặc single-flight theo `code`; xoá transient trước khi gọi `/token`; test: chạy handler 2 lần cùng URL ⇒ `fetch(token_endpoint)` đúng 1 lần.
- [x] **F3 (Task 3) Refresh đồng thời** — 2 refresh song song với rotation ⇒ BE phát hiện reuse ⇒ thu hồi cả family. Bắt buộc single-flight; test: 2 lời gọi song song ⇒ 1 request. Refresh lỗi ⇒ xoá token, về anonymous, không retry tự động.
- [x] **F4 (Task 3) ID token khi refresh** — ID token do refresh cấp **không có `nonce`** (`token.service.ts`). Validator chế độ refresh: `sub` === `sub` cũ, `iss`/`aud`/`exp`/sig như callback; có `nonce` thì phải bằng nonce gốc. Test âm: `sub` khác ⇒ từ chối, xoá phiên.
- [x] **F5 (Task 2/3) Mix-up/issuer** — `discovery.issuer` **===** `VITE_OIDC_ISSUER`; `iss` callback **bắt buộc có mặt** và bằng issuer (RFC 9207 đã quảng bá); `jwtVerify` ghim `algorithms: ['RS256']`, `clockTolerance` ≤ 60s.
- [x] **F6 (Task 2/3) Timeout** — mọi `fetch` (discovery/token/JWKS) dùng `AbortSignal.timeout(10_000)`; KHÔNG retry `/token` grant `authorization_code`; transient quá 10 phút ⇒ từ chối callback.
- [x] **F7 (Task 3)** Access token opaque với RP (không dùng claims để quyết định); không `console.*` token/code/verifier.
- [x] **F8 (Task 4) Cấu hình đúng code BE thật**:
  - `scopes` client = `openid profile email offline_access` (thiếu ⇒ `/authorize` trả `invalid_scope` — `validateScope`).
  - `grantTypes: ['authorization_code','refresh_token']`.
  - Resource `resourceId='demo'`, `identifier` = chuỗi exact `${ISSUER bỏ / cuối}/demo/` (= `http://localhost:4000/demo/` = `VITE_OIDC_RESOURCE`); `resolveForClient` so khớp exact.
  - `redirectUris=['http://localhost:5173/callback']`, `postLogoutRedirectUris=['http://localhost:5173/']`, `allowedCorsOrigins=['http://localhost:5173']` — exact, không wildcard, qua `validateRedirectUriList`/`validateResourceFormat`.
  - `clientType:'public'`, `tokenEndpointAuthMethod:'none'`, `tenantId: DEFAULT_TENANT_ID`, **không** tạo `ClientCredential`.
  - Idempotent: upsert `$set` theo `clientId`/`identifier`, bắt E11000 như `TenantService.seedDefault`.
  - Fail-closed: `NODE_ENV=production` ⇒ thoát ≠0 **trước khi kết nối DB**; chỉ chạy khi gọi tường minh.
- [x] **F9 (Task 4) Test**: seed 2 lần ⇒ 1 client + 1 resource đúng exact; production ⇒ throw, 0 ghi; `/authorize` với `fe-sso-test` + resource demo + PKCE ⇒ không `invalid_scope`/`invalid_target`; preflight `OPTIONS /token` Origin `:5173` có ACAO, `:5174` không. Không test `/demo/me` (B6.5).

## Cổng security design

- Tài sản/actor/trust boundary: đủ (Task 2/3/4). Cross-client: `aud`=client_id (INV-7), CORS theo client; owner/non-owner N/A (RP một người dùng).
- Invariant & state transition: có; bổ sung F2 (callback 1 lần), F3/F4 (refresh).
- Abuse: CSRF (state), replay code (F2), refresh reuse (F3), mix-up (F5), forged token (sig/alg), stale transient (F6).
- Failure: timeout/lỗi mạng fail-closed (F6); JWKS lỗi ⇒ từ chối.
- Exposure: token không vào storage/URL/log; chỉ `id_token_hint` trong URL logout; seed không có secret.

## Đề xuất (không bắt buộc / backlog)

- DEBT-076: X1 cần **user đã verify email** (login từ chối khi `!emailVerifiedAt`, `authentication.service.ts`). Run 22 chọn: Playwright đăng ký + đọc mail dev, hoặc seed user dev từ env (không hardcode mật khẩu).
- DEBT-077: `seed-dev` là bản tạm; gộp vào B6.4 (seed đầy đủ) và xoá bản trùng.
- `/demo/me` (B6.5) phải xong trước T4 — đã có trong plan.
