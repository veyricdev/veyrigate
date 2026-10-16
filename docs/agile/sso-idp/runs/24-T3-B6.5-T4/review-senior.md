# Senior Review — 2026-10-16

Phạm vi: Task 0–4 run 24 (working tree chưa commit trong `be/` + `fe-sso-test/`, gồm file untracked). Bỏ qua `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.

Verify độc lập (lượt này): BE unit **205/205** (20 suites), FE vitest **176/176** (25 files), `tsc --noEmit` BE + `tsc -b` FE sạch. BE int (502) KHÔNG chạy lại: container `vg-test-mongo`/`vg-test-redis` đang tắt và run cấm compose up — dựa trên báo cáo backend-dev (502 pass, mutation RED từng call-site). Đã đọc diff + code mới qua CodeGraph/git diff.

## Kết luận: PASS

Không có 🔴. Các security invariant đặt ra cho run (INV-8, mapping resourceId↔URI fail-closed, anti-oracle DEBT-040, không lộ token ở FE, `returnTo` chống open-redirect, demo chỉ dev/test) đều được triển khai đúng và có test. Còn 6 mục 🟡 (2 BE, 4 FE) → ghi backlog DEBT-101…DEBT-106. Chuyển **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)

- **Task 0 [BE]** sửa đúng gốc: một helper `ResourceService.identifiersFor(resourceIds)` dùng ở cả 3 call-site (liveness, refresh pre-check + atomic rotate, introspect caller authz); không có chế độ "chấp nhận cả hai dạng". Lỗi Mongo propagate (không nuốt thành `false`/`true`). Fixture int-test được sửa sang resourceId + `Resource` thật nên không còn che lỗi.
- Introspect giữ đúng anti-oracle DEBT-040: short-circuit `client_id === caller` (không I/O) trước, rồi lookup chỉ phụ thuộc `caller.allowedResources`, nội dung token chỉ dùng trong `includes()` in-memory.
- **Task 1 [BE]** `DemoController`: token chỉ từ header (helper `bearerToken` dùng chung với `/userinfo`), verifier đầy đủ, pin `aud === ${issuer}/demo/`, liveness dùng chung (tombstone `sid` ⇒ 401 ngay), body 200 không có `sid`, `no-store`, 401 opaque + `WWW-Authenticate`. Allowlist đọc **raw** `NODE_ENV` qua một hàm `isDemoEnabled` dùng cho cả `ConditionalModule` và preflight trong `main.ts` — không thể lệch nhau. CORS nhánh 200 theo client của token, nhánh lỗi theo union.
- **Task 2/3 [FE]**: `returnTo` validate khi ghi và khi đọc, chặt (leading `/`, chặn `//`, `/\`, `\`, control char, `%2f/%5c` ở path, kiểm origin). ErrorPage không echo `error_description`. Probe: token `other` không bao giờ vào token store/storage; `oidc:probe_result` chỉ `{status, expected, aud}`, đọc một lần. Giới hạn đúng ≤ 1 `prompt=none` mỗi probe. `callResource` dùng `credentials:'omit'`, `no-store`, timeout 10s, lỗi mạng/CORS thành `ResourceNetworkError`.
- **Task 4 [BE]** repro DEBT-100 ở mức controller (index cũ ⇒ 500, sync ⇒ 302, chuỗi INV-8 ⇒ 401) — đúng cách: chứng minh nguyên nhân gốc thay vì vá code.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| `aud` (URI) chỉ được so với identifier của các resourceId trong `allowedResources`, không bao giờ so trực tiếp với resourceId | OK | `access-token-liveness.ts:98-101`, `refresh-token.service.ts:118,255`, `introspect.controller.ts:165-169`; dữ liệu sai (URI trong `allowedResources`) ⇒ không live (AC c) |
| Fail-closed khi Mongo/Redis lỗi (không thành guest/inactive/invalid_grant) | OK | `identifiersFor` không try/catch; spec (e) ở `access-token-liveness.spec.ts`; introspect 500 `server_error`; refresh 5xx trước rotate nên không đốt token |
| Atomic rotate refresh (INV-14) vẫn một `findOneAndUpdate` | OK | Mapping tính trước, filter vẫn nguyên tử. TOCTOU giữa lookup và rotate chỉ là đổi cấu hình resource đồng thời — chấp nhận được |
| Anti-oracle `/introspect` (DEBT-040) | OK | Lookup chỉ phụ thuộc caller đã xác thực; test (b2) spy `users.exists`/`sessions.isEnded` không bị gọi |
| INV-8 ở `/demo/me`: token `aud=other` ⇒ 401 | OK | `demo.controller.ts:87`; int test chuỗi consent `other` → `/token` → `/demo/me` 401 (`seed-dev.int-spec.ts:1062`) |
| Revoke/logout: cùng AT ⇒ 401 ngay | OK | Tombstone `sid` qua liveness dùng chung; int test demo logout |
| Demo không có ở production / `NODE_ENV` unset | OK | `isDemoEnabled` allowlist raw env (unit test unset/`''`/`staging`/`production`); controller 404 khi `app.nodeEnv==='production'`; preflight chỉ đăng ký khi bật |
| Exposure: 200 không `sid`, không token thô; 401 không phân biệt lý do | OK | `demo.controller.ts:112-120`, `unauthorized()` |
| FE: token không rời bộ nhớ (DOM/storage/URL) | OK | `Tokens.tsx` chỉ metadata; probe chỉ lưu status; test "no raw token" + mutation RED |
| FE: `returnTo` open-redirect | OK | `returnTo.ts` + bảng test (`https://evil`, `//evil`, `/\evil`, `javascript:`, `/%2F%2Fevil`, control char) |
| FE: CSRF/mix-up ở callback probe | OK | `probe.ts:119-133` kiểm `purpose`, `state`, `iss`, stale; ID token validate nonce/iss/aud |
| FE: `error_description` không render | OK | `oauthError.ts`, `ErrorPage.tsx` |

## 🟡 Nên sửa

- [ ] **[FE] `fe-sso-test/src/routes/Home.tsx:78-79` (+ các link `Home` ở `Profile.tsx:81`, `Tokens.tsx:88`, `ApiTest.tsx:145`) — dùng `<a href>` thay vì `<Link>` của React Router.**
  Vì sao: Data Router không chặn `<a>` thường ⇒ mỗi click là **tải lại toàn trang** ⇒ session in-memory mất. Hệ quả: (1) từ Home bấm "Profile" ⇒ guard đẩy về `/login` ⇒ một vòng `/authorize` mới; (2) từ `/profile` bấm "Home" ⇒ Home hiện "chưa đăng nhập" dù vừa đăng nhập; (3) mỗi vòng login lại với scope `offline_access` sinh **một refresh family mới** và bỏ family cũ không revoke (đi ngược tinh thần "không bỏ lại family mồ côi" của Task 3). Không phải bypass (token mồ côi không ai giữ), nên không chặn.
  Đề xuất: đổi các link nội bộ sang `<Link to="/profile">` (import từ `react-router`). Một dòng mỗi chỗ; thêm test "điều hướng Home → Profile giữ session".

- [ ] **[FE] `fe-sso-test/src/router.tsx:307-312` — nhánh `?error=` mới của `/callback` redirect sang `/error` mà KHÔNG `clearTransient`.**
  Vì sao: trước đây `handleCallback` (`callback.ts:85`) xoá transient ở nhánh lỗi (OPEN-1: `{state, nonce, code_verifier}` không được nằm lại). Router giờ chặn `error` trước khi vào `handleCallback` nên transient tồn tại tới lần login sau — hồi quy nhỏ về vệ sinh bí mật PKCE. Rủi ro thấp (sessionStorage cùng origin), nhưng là invariant đã chốt.
  Đề xuất: gọi `clearTransient(window.sessionStorage)` (qua một hàm export trong `client.ts`) trước `redirect('/error...')`; thêm assert vào `router` test.

- [ ] **[FE] `fe-sso-test/src/oidc/probe.ts:111-156` lặp lại toàn bộ chuỗi kiểm callback của `callback.ts:113-160` (state, iss, stale, `postToken`, `validateIdToken`).**
  Vì sao: hai bản sao của các kiểm tra bảo mật CSRF/mix-up sẽ trôi lệch khi sửa một bên (ví dụ thêm kiểm `azp`/`at_hash`). Probe cũng không có single-flight theo `code` như login.
  Đề xuất: tách `exchange()` trong `callback.ts` thành hàm trả `{ token, claims }` (không ghi store), để `handleCallback` và `handleAudProbeCallback` cùng gọi; probe chỉ thêm bước `callResource` + `saveProbeResult`.

- [ ] **[FE] `fe-sso-test/src/oidc/oauthError.ts:11-28` trùng danh sách mã lỗi với `KNOWN_ERROR_CODES` ở `callback.ts:32-49`.**
  Vì sao: hai whitelist mã lỗi OAuth cho cùng mục đích (không echo `error_description`) — dễ lệch.
  Đề xuất: `callback.ts` dùng `describeOAuthError(error).code` thay cho `KNOWN_ERROR_CODES` + `describeIdpError`.

- [ ] **[BE] `be/src/modules/oauth/token/refresh-token.service.ts:118` và `:255` — `identifiersFor(client.allowedResources)` chạy 2 lần cho mỗi refresh.**
  Vì sao: thêm một round-trip Mongo trên đường nóng `/token` refresh; hai lần đọc còn có thể thấy hai tập identifier khác nhau nếu cấu hình resource đổi giữa chừng (vô hại vì fail-closed, nhưng khó suy luận).
  Đề xuất: tính một lần ở đầu `refresh()` rồi truyền `allowedIdentifiers` vào bước rotate.

- [ ] **[BE] `be/test/seed-dev.int-spec.ts:1016-1060` — test "fix" phụ thuộc trạng thái do test "repro" để lại (index cũ).**
  Vì sao: chạy riêng `-t "fix"` hoặc đổi thứ tự sẽ fail ở `expect(before...).toBe(true)` — test phụ thuộc thứ tự.
  Đề xuất: test "fix" tự `createIndex({userId:1, clientId:1}, {unique:true})` (idempotent) trước khi kiểm.

## 💭 Nit

- `fe-sso-test/src/oidc/client.ts:184` `userinfoUrl()` tự dựng từ issuer trong khi discovery đã có `userinfo_endpoint` — nên lấy từ discovery (một nguồn sự thật).
- `fe-sso-test/src/routes/ApiTest.tsx:60` đọc + xoá `oidc:probe_result` trong initializer `useState` (side effect trong render). Hoạt động được (React dùng kết quả lần gọi đầu khi StrictMode gọi 2 lần), nhưng đọc trong `loader` của route `/api-test` sẽ thuần hơn.
- `fe-sso-test/src/router.tsx:292-296`: nếu `finishAudProbe` ném (exchange lỗi), refresh chính đã bị revoke và người dùng rơi vào `CallbackError` ở trạng thái đã đăng xuất. Có thể bắt lỗi, ghi `status:0` rồi vẫn `restoreSessionSilently()`.
- `be/src/common/http/bearer.ts:21` đổi từ `exec(raw.trim())` sang `exec(raw)` — header có khoảng trắng đầu nay bị từ chối. Fastify đã trim giá trị header nên không ảnh hưởng thực tế; chỉ lưu ý hành vi đã đổi.
- `fe-sso-test/src/router.tsx` thiếu newline cuối file.

## ✂️ Ponytail

- fe-sso-test/src/oidc/probe.ts:L111: shrink: chuỗi state/iss/stale/postToken/validateIdToken chép lại từ `callback.ts`. Gọi chung một `exchangeAndValidate()` tách từ `callback.ts`.
- fe-sso-test/src/oidc/callback.ts:L32: delete: `KNOWN_ERROR_CODES` + `describeIdpError`. Dùng `describeOAuthError` ở `oauthError.ts`.
- fe-sso-test/src/routes/Tokens.tsx:L16: delete: `formatEpoch`/`formatAud` trùng y hệt `Profile.tsx:L4-12`. Export một bản từ một file `format.ts` (hoặc từ `Profile.tsx`).
- fe-sso-test/src/oidc/client.ts:L179: shrink: `demoApiUrl()`/`userinfoUrl()` là wrapper một dòng quanh env. Dùng `env.VITE_DEMO_API_URL` và `discovery.userinfo_endpoint` trực tiếp.
- be/src/modules/oauth/token/refresh-token.service.ts:L255: delete: lần gọi `identifiersFor` thứ hai. Truyền giá trị đã tính ở L118.

net: -55 lines possible.
