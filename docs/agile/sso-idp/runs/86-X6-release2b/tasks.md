# Run 86 — X6 release checklist đợt 2b (M8, lane BE + FE + QA)

Nguồn: `runs/85-X6-release2/tasks.md` mục "Run 86" + D85.3 / D85.7 / D85.10 (`plan.md` §12). Analyst bỏ qua (việc lấy từ backlog + quyết định đã chốt). Tech-lead fold lại trên code hiện tại (sau `545a3c6`).

Mục tiêu: checklist P0 ❌ = 0 (C-14.2.1), đóng DEBT-577/393/572/583/599.

## Task

- [x] **T1 [BE+UI] DEBT-577 (P0) — token một lần sang fragment** theo D85.3: link `…/reset#token=…`, `…/verify-email#token=…`; `/assets/token-fragment.js` (script ngoài, CSP không đổi) đọc `^#token=([A-Za-z0-9_-]{43})$`, điền ô ẩn, `history.replaceState`; `<noscript>` ô "Mã trong email"; thư in mã dưới link; GET bỏ qua `?token=`; POST tiêu token như hiện tại. RED: link không có `?token=`; GET `/reset?token=x` không render `x`; E2E mailpit → link fragment (Chromium) + ca không JS.
- [x] **T2 [BE] DEBT-393 pre-publish** theo D85.7 (env `KEY_PREPUBLISH_SEC` 0–86400 mặc định 3600, trạng thái suy ra theo thời gian, 409 `rotation_pending`, emergency gỡ cả pending, Vault `key_version`, Local `activatesAt`, Admin API `activatesAt`, OpenAPI + `schema.d.ts` sinh lại, runbook).
- [x] **T3 [FE] DEBT-393 fe-admin** theo D85.7 (zod `pending` + `activatesAt`, nhãn, thứ tự, dashboard, hộp xác nhận, 409 thông điệp cố định, mẫu `UNCERTAIN_*`). Sau T2.
- [x] **T4 [BE] DEBT-572 (P1)** — POST `/logout` không có `_csrf` nhưng có tham số RP ⇒ trang xác nhận như GET, không huỷ phiên; POST có `_csrf` giữ nguyên.
- [x] **T5 [BE] DEBT-583 (P2) + DEBT-599** — CSP `base-uri 'none'` (+ test byte-identity với helmet); `networkOf` dùng `ipaddr.js` (`process()` + /64), giữ bảng unit cũ làm regression, sửa ca `::ffff:1.2.3.4`.
- [x] **T6 [QA]** — checklist (C-14.2.1, B-L2d, C-3.4c, các dòng key rotation), security-matrix, tester spec; gate: lint/typecheck, be unit, int FULL, vault (orchestrator chạy container thử, người dùng đã cho phép), E2E, X3 42, fe-admin.

## Fold tech-lead (2026-11-11)

Kết luận: **PASS** (lý do ở `review-techlead.md`). Đã kiểm trên `develop` HEAD `e39b7b5` (codegraph + đọc file). Lô **vừa một run** (6 task, như D85.1). Thứ tự: **T5 → T1 → T4 → T2 → T3 → T6**.
- BE (backend-dev) làm T5, T1, T4, T2 tuần tự. T1 và T4 cùng sửa `ui.controller.ts`, nên không chạy song song.
- FE (frontend-dev) làm T3 ngay khi T2 xong bước 6 (DTO + OpenAPI + `schema.d.ts`).
- Chia lô nếu trễ: T1 (P0), T4 và T5 phải xong trong run 86. Nếu T2 hoặc T3 không kịp thì **dời cả hai sang run 87, cùng một commit**. Không bao giờ phát hành T2 mà thiếu T3: fe-admin cũ parse `status: "pending"` ra lỗi schema ⇒ trang keys và thẻ dashboard hỏng.

### Phát hiện khi kiểm code

- Helmet nằm trong `be/src/bootstrap.ts:29-39` (`configureApp`, dùng chung cho `main.ts` và E2E), không nằm trong `main.ts`. `csp.ts:21` là `base-uri 'self'`. Byte-identity được kiểm ở `be/test/security-headers.int-spec.ts:244` và `be/test/b74-tester.int-spec.ts:229` (`=== buildCsp()`). Không trang nào dùng `<base>`.
- Static: `@fastify/static` root `dist/public`, prefix `/assets/` (`bootstrap.ts:45-49`); `nest-cli.json` đã copy `public/**/*`. Tiền lệ: `src/public/logout-redirect.js` + `logout-frontchannel.eta`.
- `issueToken` (`authentication.service.ts:439-462`): `link.searchParams.set('token', token)`. Token là `generateToken()` = 32 byte base64url = **43 ký tự** ⇒ regex D85.3 đúng. `templates.ts:34-48` chỉ in link.
- `GET /verify-email` và `GET /reset` (`ui.controller.ts:221-234`) đọc `@Query('token')` và render vào `<input type="hidden" name="token" value="…">` (`verify.eta`, `reset.eta`).
- **Ngoài dự kiến (T1)**: D85.3 viết "ô ẩn + `<noscript>` ô mã". Làm đúng chữ đó thì khi tắt JS sẽ có **hai** field `token`: body thành mảng, `TokenDto @IsString()` ⇒ 400. Phải dùng một field duy nhất (D86.1).
- **Ngoài dự kiến (T4)**: `POST /logout` có `@UseGuards(CsrfGuard)` (`ui.controller.ts:403-404`). Identity CSRF là cookie phiên, nếu không có thì cookie ẩn danh (`csrf.service.ts:60-69`). RP khác site POST lên ⇒ cookie phiên `SameSite=Lax` không được gửi ⇒ trang xác nhận ký `_csrf` theo cookie ẩn danh. Lúc người dùng bấm "Sign out" (POST cùng site, có gửi cookie phiên), guard so với cookie phiên ⇒ **403**. Vì vậy làm đúng chữ DEBT-572 vẫn hỏng ở topology cross-site (D86.6).
- **Ngoài dự kiến (T4)**: ValidationPipe đặt `forbidNonWhitelisted: true` (`bootstrap.ts:81`). RP gửi `logout_hint`/`ui_locales` (RP-Initiated Logout 1.0 §2) bằng POST ⇒ 400. GET không bị vì đọc từng `@Query` (D86.7).
- **Ngoài dự kiến (T2/T3)**: BFF fe-admin chỉ map `409 conflict` (`fe-admin/src/server/admin-api/client.ts:178`). `409 {"error":"rotation_pending"}` như D85.7 sẽ rơi vào `throw new Error(...)` ⇒ UI báo "kết quả không rõ" thay vì thông điệp cố định (D86.8).
- **Ngoài dự kiến (T3)**: `uncertainText` ở `fe-admin/src/routes/keys/index.tsx` bảo admin "nếu kid active đã khác thì rotate đã chạy". Có pre-publish thì rotate normal **không đổi** kid active trong `KEY_PREPUBLISH_SEC` ⇒ admin sẽ rotate lại (D86.13).
- Local (`local-key-provider.ts`): `status` được lưu trong file. Rotate normal xoá PEM key cũ ngay (`:177-179`). Có pre-publish thì key cũ còn ký tới `activatesAt` ⇒ phải giữ PEM. Cách hiện tại sẽ ký bằng file đã mất ⇒ `ENOENT` (D86.9).
- Vault (`vault-transit-key-provider.ts`): đã gửi `key_version` (`signWith`, hiện bằng `set.latest`). `signOnce` retry khi `fresh.latest !== set.latest`, phải đổi thành so version **active**. `live()` tính `retireAt = next.createdAt + ttl + KEY_CACHE_TTL_MS`. Rotate normal không đặt `min_encryption_version` ⇒ Vault cho ký bằng version cũ hơn latest.
- Admin: `AdminKeysController.list` map tường minh `{kid, alg, status, createdAt, retireAt}` ⇒ phải thêm `activatesAt` ở đó. `AdminKeyViewDto` có `@ApiProperty({ enum: ['active','retiring'] })` (`admin.views.ts:310`). Script sinh `schema.d.ts`: `pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api`.
- `networkOf` (`login-throttle.service.ts:50-76`). `ipaddr.js` 2.5.0 đã là dependency trực tiếp của `be` (`be/package.json:41`) ⇒ không thêm gói.
- Test đọc token từ link: 9 chỗ `new URL(link).searchParams.get('token')` ở 8 file int (`admin-users`, `authentication`, `log-capture`, `run85-anti-lockout`, `run85-password-change`, `run85-password-policy`, `run85-tester`, `ui-auth`). Ngoài ra `authentication.int-spec.ts:189` expect `verify-email?token=`, và `ui.int-spec.ts:500/591/611-619` dùng `?token=x`. `federation.int-spec.ts:2077` dùng regex `token=([A-Za-z0-9_-]+)`, vẫn chạy. E2E `password-change.spec.ts:39` lấy link `/verify-email\S*` rồi `goto` ⇒ vẫn chạy (có JS), nên thành ca fragment miễn phí.
- Test rotate: 25 lời gọi `rotate('normal'…)` (keys.spec, vault spec, metrics/admin-keys/run80 int, b73/run55 vault). `new LocalKeyProvider(dir)` ở 27 file ⇒ tham số mới phải là optional (D86.9). E2E `fe-admin-keys.spec.ts` kỳ vọng K2 active ngay, và giữ key trong `e2e/.keys` giữa các lần chạy ⇒ nếu dùng 3600 thì lần chạy sau trong vòng 1 h sẽ ăn 409 (D86.12).
- X3 ô 4 (`e2e/x3/cookie-matrix.spec.ts:280-307`) kỳ vọng `403`. Int `ui.int-spec.ts:690` "POST logout without CSRF fails closed before session work" cũng kỳ vọng 403 ⇒ cả hai đổi theo T4.

### Quyết định D86.x (người dùng ủy quyền, tiêu chí production) — orchestrator chép vào `plan.md` §12 khi đóng run

- **D86.1 (T1, sửa chữ D85.3) Một field mã duy nhất**: `reset.eta`/`verify.eta` có đúng **một** `<input name="token" id="token">`, mặc định hiện ra:
  - Bọc trong `<label id="token-manual">Code from the email …</label>`.
  - Thuộc tính: `required`, `maxlength="43"`, `pattern="[A-Za-z0-9_-]{43}"`, `autocomplete="one-time-code"`, `spellcheck="false"`, `value=""`.
  - Script điền giá trị rồi đặt `hidden` cho label (field trong phần tử `hidden` vẫn được submit).
  - Không dùng `<noscript>`, vì nó gây trùng field (xem phát hiện).
  - Fragment sai hoặc thiếu ⇒ field vẫn hiện để nhập tay.
  - Thẻ `<script src="/assets/token-fragment.js"></script>` đặt cuối form, không `async`/`defer`, CSP không đổi.
  - `TokenDto.token`: thêm trim (`@Transform`) cho mã dán tay. Không thêm `@Matches`: sai mã ⇒ vẫn đi đường lỗi hiện có, không lộ thêm oracle.
- **D86.2 (T1) Script** `be/src/public/token-fragment.js`: IIFE ES5, không phụ thuộc gì.
  - `var m = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash)`. Khớp ⇒ `field.value = m[1]` (chỉ dùng `.value`, không `innerHTML`) và `label.hidden = true`.
  - Khi `location.hash` bắt đầu bằng `#token=` (kể cả sai dạng) ⇒ luôn gọi `history.replaceState(null, '', location.pathname)`.
- **D86.3 (T1) Thư và link**:
  - `link.hash = 'token=' + token`, không còn `searchParams`.
  - `verifyEmailMessage`/`resetPasswordMessage` nhận thêm `code`. Text thêm dòng `If the link does not open the form, enter this code on the page: <code>`, HTML thêm `<p>…<code>${escapeHtml(code)}</code></p>`.
  - GET bỏ hẳn `@Query('token')`: không đọc, không render, không redirect. Redirect để xoá query vô ích vì query đã vào log proxy.
  - Link `?token=` gửi trước khi deploy ⇒ trang hiện field trống ⇒ người dùng xin link mới (TTL ngắn; chưa phát hành).
- **D86.4 (T4) POST `/logout` không có khoá `_csrf`** trong body (dù có tham số RP hay không):
  - Render **đúng trang xác nhận của GET**: 200, `Cache-Control: no-store`, cùng nới `form-action` theo origin đã kiểm, cùng quy tắc chỉ phản chiếu `post_logout_redirect_uri` khi hợp lệ.
  - Không `sessions.get`, không revoke, không xoá cookie, không audit.
  - Có khoá `_csrf` (kể cả chuỗi rỗng) ⇒ kiểm như hiện tại; sai ⇒ 403, không đổi state.
  - Tách helper `renderLogoutConfirm(req, reply, params)` dùng chung cho GET và POST.
- **D86.5 (T4) Bỏ `@UseGuards(CsrfGuard)` trên `POST /logout`**, kiểm trong handler (hoặc một `LogoutCsrfGuard` riêng) **trước** mọi thao tác session.
- **D86.6 (T4) CSRF hai identity, chỉ cho `POST /logout`**: `_csrf` hợp lệ khi bằng HMAC của cookie phiên đã gửi, **hoặc** HMAC của cookie CSRF ẩn danh (`csrfCookieName(secure)`) đã gửi và không rỗng.
  - Lý do: trang xác nhận render từ POST cross-site không thấy cookie phiên `Lax`.
  - Kẻ tấn công không đọc được cookie nào trong hai cookie đó (httpOnly, `__Host-` ở chế độ secure), và cũng không có secret HMAC ⇒ không giả được.
  - Rủi ro còn lại chỉ ở chế độ không secure (cookie tossing từ subdomain anh em, giống mọi form ẩn danh hiện có) và hậu quả chỉ là bị đăng xuất.
  - Các form khác giữ `CsrfGuard` một identity.
- **D86.7 (T4) `LogoutDto`** thêm `logout_hint` (`@IsOptional @IsString @Length(0, 4096)`) và `ui_locales` (`@Length(0, 256)`). Cả hai được chấp nhận rồi **bỏ qua**: không phản chiếu, không log.
- **D86.8 (T2, sửa chữ D85.7) Hình 409**: `409 {"error":"conflict","error_description":"A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation."}` (câu cố định, không thời gian, không kid; dùng `AdminAuthError.conflict` sẵn có).
  - Audit `SIGNING_KEY_ROTATED` `result:'failure'` `reason:'rotation_pending'` `metadata:{mode:'normal', pendingKid}`, ghi best-effort: audit lỗi vẫn trả 409.
  - Lý do: cả Admin API chỉ dùng một mã 409 (`conflict`) và BFF đã map sẵn ⇒ không thêm `AdminApiErrorCode`, không đổi BFF.
  - Mã nghiệp vụ `rotation_pending` nằm ở audit và OpenAPI description.
- **D86.9 (T2) Local `keys.json`**:
  - Mỗi phần tử có `{kid, publicJwk, createdAt, activatesAt?, retireAt?}`.
  - Rotate normal ghi `fresh.activatesAt = now + prepublishSec`, và ghi cho active trước đó `retireAt = fresh.activatesAt + retainSec`.
  - Emergency/init ghi `activatesAt = createdAt`.
  - **Không ghi `status` nữa; đọc thì bỏ qua `status`.**
  - Suy ra theo thứ tự mảng (thứ tự tạo): **active** = phần tử cuối có `activatesAt ≤ now`, không có thì phần tử đầu; sau active là **pending**; trước active là **retiring** khi `retireAt > now`, thiếu `retireAt` thì coi như đã rời JWKS.
  - Phần tử cũ không có `activatesAt` ⇒ `activatesAt = createdAt`; `retireAt` cũ được giữ.
  - PEM: rotate normal **không** xoá PEM của active hiện tại (nó còn ký tới `fresh.activatesAt`). Mỗi rotate xoá best-effort PEM của mọi phần tử đang là retiring, rồi prune phần tử hết hạn như hiện tại. Emergency xoá mọi PEM cũ như hiện tại.
  - `init` chỉ tạo key khi không còn phần tử live (không dựa vào `status`).
  - Constructor `new LocalKeyProvider(dir, opts?: { prepublishSec?: number; now?: () => number })`, mặc định `prepublishSec: 0`, `now: Date.now`. `KeysModule` luôn truyền giá trị config.
  - 409 kiểm **trong mutex** ⇒ hai rotate normal đồng thời cho đúng một 200 và một 409.
- **D86.10 (T2) Vault**:
  - `VaultProviderDeps` thêm `prepublishSec` (mặc định 0; `KeysModule` truyền config).
  - `activatesAt(v) = v === floor ? createdAt : createdAt + prepublishSec*1000`.
  - Active = version lớn nhất ≥ floor có `activatesAt ≤ now()`, tính ở **mỗi** lần ký từ key set đã cache. Cache 30 s không làm trễ kích hoạt, vì version pending đã nằm trong cache từ lâu trước đó.
  - `signWith` dùng `key_version = active.version`. `signOnce` retry khi active version đổi (không còn so `latest`).
  - `live()`: version > active ⇒ pending (`retireAt null`); version < active và ≥ floor ⇒ retiring tới `activatesAt(v+1) + ttl + KEY_CACHE_TTL_MS`.
  - Rotate normal: `refresh(true)`, có pending ⇒ ném `RotationPendingError`, không gọi Vault.
  - Hai instance rotate cùng lúc có thể tạo hai version pending (Vault tuần tự hoá `rotate`, không tuần tự hoá phần kiểm của ta). Cả hai đều nằm trong JWKS, không gây hại ⇒ chấp nhận, ghi runbook (DEBT-603).
- **D86.11 (T2) Hợp đồng chung**:
  - `KeyMetadata` thêm `activatesAt: string` và `status: 'pending'|'active'|'retiring'`; `retireAt` của pending/active là `null`.
  - `RotationResult` thêm `activatesAt`; emergency thì bằng `createdAt`.
  - `RotationPendingError {pendingKid, activatesAt}` đặt ở `key-provider.ts`.
  - Config: `KEY_PREPUBLISH_SEC` nằm trong `KeysConfig.prepublishSec`, validation số nguyên `0..86400`, mặc định `3600`, mọi môi trường. Không ép mức tối thiểu ở production; runbook bắt buộc ≥ 600.
- **D86.12 (T2) Env test**:
  - `be/test/full-app.ts` đặt `KEY_PREPUBLISH_SEC: '0'` (giữ hợp đồng của các int cũ, có comment).
  - Spec mới `run86-key-prepublish.int-spec.ts` dùng 3600 và đồng hồ điều khiển được.
  - `e2e/config/env.ts` đặt `KEY_PREPUBLISH_SEC: "20"`. Spec E2E keys chờ không còn pending lúc bắt đầu (poll ≤ 40 s, vì lần chạy trước có thể bị ngắt), rồi rotate, thấy hàng Pending, thử rotate lần hai ⇒ thông điệp 409, poll tới khi K2 Active (≤ 40 s), rồi context B đăng nhập như hiện tại (vẫn kiểm refetch JWKS của DEBT-349).
- **D86.13 (T3) fe-admin**:
  - Zod: `status` thêm `pending`, `activatesAt: z.string()` bắt buộc ở cả item lẫn kết quả rotate.
  - Nhãn: `pending: "Pending — published, signs from <activatesAt>"`.
  - Thứ tự: active → pending (theo `activatesAt` tăng) → retiring (theo `retireAt` tăng).
  - Nút "Rotate key" (normal) bị **disabled** khi có pending, kèm câu giải thích. 409 vẫn được xử lý cho trường hợp race: `BY_CODE.conflict` = câu cố định, không retry.
  - Text sau rotate normal: `Rotated. New key <newKid> is published and signs from <activatesAt>. <oldKid> keeps signing until then, then is verification only.`
  - `uncertainText` cho normal dựa vào **tập kid** trước lúc xác nhận: "if the list now has a key that was not there before (pending or active), the rotation was applied — do not rotate again". Emergency giữ câu so kid active.
  - Hộp xác nhận normal: "The new key is published at once and starts signing after the pre-publish delay (KEY_PREPUBLISH_SEC, default 1 hour). Until then the current key keeps signing."
  - Dashboard: thêm dòng "Pending keys".
- **D86.14 (T5) `networkOf`**:
  - Giữ cổng `isIP(raw)` của Node trước: `ipaddr.parse` nhận cả dạng `127.1`, hex hay octal mà `req.ip` không bao giờ có.
  - Bỏ `%zone`, rồi `ipaddr.process(raw)`. IPv4 ⇒ `toString()`. IPv6 ⇒ `toFixedLengthString().split(':').slice(0,4).join(':')`.
  - Lý do giữ đúng định dạng 4 nhóm đệm 0 như hiện nay: key bucket Redis giữ nguyên byte, deploy không reset đếm.
  - Không dùng `toNormalizedString()` như backlog gợi ý, vì nó bỏ đệm 0 ⇒ key đổi.
- **D86.15 (T5) CSP**: `baseUri: ["'none'"]` trong helmet (`bootstrap.ts`) **và** `['base-uri', "'none'"]` trong `csp.ts`. Vị trí directive giữ nguyên (thứ tự mặc định helmet), test byte-identity sẽ chứng minh.

### T1 [BE+UI] DEBT-577 (P0) — token trong fragment (D86.1–D86.3)

- **Tài sản, actor, ranh giới**: token reset (30', chiếm được tài khoản) và token verify. Actor: người dùng, bên đọc log proxy/CDN/WAF, lịch sử/đồng bộ trình duyệt, scanner link trong thư. Ranh giới: URL rời khỏi trình duyệt (request line, Referer).
- **AC**:
  1. Link trong thư có dạng `${issuer}/reset#token=<43>` và `${issuer}/verify-email#token=<43>`: không có `?`, pathname đúng.
  2. Text và HTML của thư có dòng mã (D86.3); HTML escape.
  3. `GET /reset?token=S` và `GET /verify-email?token=S` (S = chuỗi đánh dấu) ⇒ 200, body **không chứa S**, field `token` có `value=""`, có `<script src="/assets/token-fragment.js">`, `Cache-Control: no-store`, CSP `=== buildCsp()`.
  4. `GET /assets/token-fragment.js` ⇒ 200, `content-type` JavaScript, không có `Set-Cookie`.
  5. POST tiêu token qua body như cũ (một lần, TTL); mã dán tay có khoảng trắng đầu/cuối vẫn được nhận (trim).
  6. E2E Chromium (bật JS): forgot ⇒ Mailpit ⇒ `goto(link)` ⇒ `page.url()` không còn `#` ⇒ field bị ẩn và có giá trị ⇒ đặt mật khẩu ⇒ login bằng mật khẩu mới thành công. Request `GET /reset` mà Playwright quan sát được không có `token` trong URL.
  7. E2E tắt JS (`javaScriptEnabled: false`): `goto(link)` ⇒ thấy label "Code from the email" ⇒ điền mã đọc từ thư ⇒ reset thành công.
  8. E2E verify trong `password-change.spec.ts` chạy qua link fragment (đã có sẵn) và vẫn xanh.
- **RED trước**:
  - `authentication.int-spec.ts:189` đổi thành `toContain('https://issuer.example/verify-email#token=')` + `not.toMatch(/\?token=/)`.
  - Unit `templates` (mới, hoặc spec mailer sẵn có): có dòng mã.
  - Int `ui.int-spec.ts`: ca "GET /reset?token=S không phản chiếu S" (thay ca `<x>` escape ở `:611-612`) và ca asset.
  - E2E `token-fragment.spec.ts` (mới) gồm 2 ca 6/7.
- **Mutation phải làm test đỏ**:
  - (a) Trả lại `searchParams.set` ⇒ AC1.
  - (b) Thêm lại `@Query('token')` render ⇒ AC3.
  - (c) Bỏ `replaceState` ⇒ AC6 (`#` còn).
  - (d) Bỏ dòng `hidden` ⇒ AC6 (field hiện).
  - (e) Bỏ dòng mã trong thư ⇒ unit AC2 và AC7.
  - (f) Bỏ trim ⇒ ca AC5 có khoảng trắng.
  - (g) Bỏ `^`/`$` của regex ⇒ ca `#token=<43>&x=1` phải không điền (tester, T6).
- **File**: `be/src/modules/authentication/authentication.service.ts`, `be/src/modules/mailer/templates.ts`, `be/src/modules/ui/ui.controller.ts` (`TokenDto`, `verifyForm`, `resetForm`), `be/src/views/{reset,verify}.eta`, `be/src/public/token-fragment.js` (mới), test helper `be/test/helpers/mail-token.ts` (mới: `tokenFromMailLink(text)` đọc `#token=`, assert không có `?`) thay cho 9 chỗ `searchParams.get('token')`, `e2e/tests/token-fragment.spec.ts` (mới).
- **Abuse case**:
  - Fragment mang payload HTML/JS ⇒ regex chặn, chỉ dùng `.value`.
  - `?token=` cũ ⇒ bị bỏ qua.
  - Link do kẻ tấn công tạo với token của kẻ đó (đặt mật khẩu/xác minh tài khoản của kẻ đó) ⇒ không đổi so với hiện tại.
  - Replay ⇒ `consume` một lần (không đổi).
  - Scanner hoặc bộ bọc link làm mất fragment ⇒ người dùng nhập mã tay.
- **Failure**: mailer lỗi ⇒ như hiện tại (log, không lộ token). Asset 404 (build thiếu `public`) ⇒ field hiện ra, nhập tay vẫn chạy (fail-safe).
- **Exposure**: token không còn trong request line, access log hay Referer. Token chỉ nằm trong thư (2 lần) và trong DOM của trang. Logger cắt query vẫn giữ.
- **Rủi ro**:
  - 9 chỗ int đọc `searchParams` ⇒ đỏ hàng loạt nếu quên helper.
  - `ui-auth.int-spec.ts:247` GET `?token=` rồi lấy `page.csrf`: vẫn chạy vì query bị bỏ qua, nhưng nên đổi sang `/verify-email`.
  - Trình duyệt có thể đã ghi URL có fragment vào lịch sử trước `replaceState` (rủi ro còn lại; token một lần, TTL ngắn; ghi ⚠ phụ trong checklist).
  - Deploy: link phát trước deploy không tự điền ⇒ xin link mới (ghi trong summary).

### T2 [BE] DEBT-393 — pre-publish (D85.7 + D86.8–D86.12)

- **Tài sản, actor, ranh giới**: khoá ký (private ở Vault/PEM), JWKS công khai, Admin API (super_admin + step-up 5'). Actor: super_admin, RP cache JWKS, các instance IdP (cache 30 s).
- **Invariant**:
  - INV-K1: mọi token ký ra có `kid` đã nằm trong JWKS ít nhất `KEY_PREPUBLISH_SEC`, trừ token ký bằng key sàn (sau emergency hoặc init).
  - INV-K2: không bao giờ ký bằng version pending.
  - INV-K3: key cũ còn trong JWKS ít nhất `ACCESS_TOKEN_TTL` sau thời điểm nó ngừng ký.
  - INV-K4: emergency ⇒ JWKS chỉ còn 1 kid (gỡ cả pending).
- **AC**:
  1. Config: `KEY_PREPUBLISH_SEC` vắng ⇒ 3600; `0`/`86400` ⇒ khởi động; `-1`/`86401`/`1.5`/`abc` ⇒ validation lỗi, không khởi động.
  2. Local, prepublish 3600, đồng hồ cố định: rotate normal ⇒ `200 {newKid, oldKid, mode, activatesAt = now+3600s}`; JWKS có 2 kid; token mới ký có `kid = oldKid`; `GET /admin/keys` ⇒ old `active` + new `pending` (`activatesAt` đúng, `retireAt null`).
  3. Tới `now = activatesAt` (biên `≤`) ⇒ ký bằng `newKid`; old `retiring` với `retireAt = activatesAt + ACCESS_TOKEN_TTL`; sau `retireAt` ⇒ old rời JWKS và token old bị TokenVerifier từ chối.
  4. Rotate normal khi có pending ⇒ 409 đúng body D86.8, `keys.json` giữ nguyên byte, audit failure `rotation_pending`. Audit ghi lỗi ⇒ vẫn 409.
  5. Hai rotate normal đồng thời (Local) ⇒ đúng một 200 và một 409.
  6. Emergency khi có pending ⇒ JWKS và `GET /admin/keys` chỉ còn 1 kid `active` với `activatesAt = createdAt`; PEM cũ (kể cả của pending) bị xoá.
  7. `keys.json` cũ (fixture `[{status:'retiring' A, retireAt tương lai}, {status:'active' B}]`, không có `activatesAt`) ⇒ B active, A retiring tới `retireAt` cũ; fixture 1 phần tử ⇒ active; không ghi file khi đọc.
  8. PEM của key active cũ còn trên đĩa tới khi nó đã retiring và có lần rotate kế tiếp. Ký trong khoảng chờ pending **không** gặp `ENOENT`.
  9. Vault (vault-spec, container thật, `now` tiêm): rotate normal ⇒ JWKS 2 kid, `signJwt` dùng `key_version` cũ (kiểm `kid` header + chữ ký verify). Qua `activatesAt` ⇒ version mới. 409 khi pending. Emergency khi pending ⇒ 1 version. Ca retry khi instance khác làm emergency vẫn xanh.
  10. `prepublishSec 0` ⇒ hành vi cũ (mọi spec cũ xanh với `full-app.ts` `0`).
  11. `GET /admin/keys` không bao giờ có `n/e/d/p/q/dp/dq/qi`/PEM/path (ca hiện có giữ nguyên). OpenAPI có `status` enum 3 giá trị, `activatesAt`, response 409. `schema.d.ts` được sinh lại, không sửa tay.
- **RED trước**: `keys.spec.ts` (AC2/3/4/5/6/7/8, `now` tiêm), `vault-transit-key-provider.spec.ts` (fetch giả: `key_version` = active, live/pending/retiring, 409, retry theo active), `be/test/run86-key-prepublish.int-spec.ts` (Admin API + JWKS + audit, AC2–4/6/11), `validation.schema.spec.ts` (AC1), unit `keys.module` (factory truyền `prepublishSec` từ config cho cả hai provider), vault-spec (AC9).
- **Mutation phải làm test đỏ**:
  - (a) Ký bằng `latest` thay vì active ⇒ AC2/AC9.
  - (b) `<` thay `≤` ở biên kích hoạt ⇒ AC3 biên.
  - (c) Bỏ kiểm pending ⇒ AC4.
  - (d) Kiểm pending ngoài mutex ⇒ AC5.
  - (e) Emergency giữ pending ⇒ AC6.
  - (f) Xoá PEM active cũ lúc rotate normal ⇒ AC8.
  - (g) `retireAt` tính từ `createdAt` của key mới thay vì `activatesAt` ⇒ AC3.
  - (h) Đọc `status` legacy thay vì suy ra ⇒ AC7 (thêm fixture có `status` trái với thời gian).
  - (i) Factory không truyền `prepublishSec` ⇒ unit module.
  - (j) Vault floor tính `+prepublish` ⇒ AC6/AC9 sau emergency.
- **File**: `be/src/modules/keys/{key-provider,local-key-provider,vault-transit-key-provider,key-rotation.service,keys.module}.ts`, `be/src/config/{configuration,validation.schema}.ts` (+ spec), `be/.env.example`, `be/src/modules/admin/{admin-keys.controller,admin.views}.ts` (+ OpenAPI 409, cập nhật description của rotate), `be/test/full-app.ts`, `e2e/config/env.ts`, `fe-admin/openapi/admin.json` + `fe-admin/src/server/admin-api/schema.d.ts` (sinh), `docs/agile/sso-idp/runbook-ops.md` §1, `runbook-deploy.md` (env).
- **Thứ tự bước**: 1 config → 2 hợp đồng `key-provider.ts` → 3 Local → 4 Vault → 5 service/409/audit → 6 Admin DTO + OpenAPI + `schema.d.ts` (**mốc bàn giao cho T3**) → 7 int/vault-spec → 8 runbook.
- **Runbook**:
  - §1 rotate normal: bước kiểm `pending`/`activatesAt`.
  - "Không rotate normal lần hai khi còn pending (409)".
  - Kết quả không rõ ⇒ so tập kid.
  - Emergency dở (Vault `config` lỗi) giờ hiện `active` cũ + `pending` ⇒ gọi lại emergency.
  - `KEY_PREPUBLISH_SEC ≥ 600` (RP cache ≤ 10').
  - Đổi env sẽ dịch `activatesAt` ở Vault (suy ra lúc đọc), còn Local thì không (đã ghi file).
- **Failure**: Vault lỗi lúc đọc trước khi rotate ⇒ 503 như hiện tại, audit `rotate_failed`. Lệch đồng hồ giữa các instance chỉ khiến thời điểm đổi key ký lệch nhau đúng bằng độ lệch đó; cả hai key đều trong JWKS ⇒ vô hại.
- **Rủi ro**:
  - 25 lời gọi rotate trong test giữ được nhờ mặc định 0.
  - Vault deploy: version được rotate normal trong vòng `KEY_PREPUBLISH_SEC` trước deploy sẽ thành pending trở lại ⇒ quay về ký bằng version trước (vẫn còn trong Vault và JWKS) ⇒ vô hại. Ghi chú: tránh deploy trong 1 h sau một lần rotate normal.
  - Local rollback về bản cũ ⇒ file không có `status` ⇒ bản cũ tạo key mới (chỉ dev; xoá thư mục keys).
  - JWKS `no-cache` (D84.2) ⇒ RP thấy pending ngay.

### T3 [FE] DEBT-393 fe-admin (D86.13) — sau T2 bước 6

- **AC**:
  1. Schema parse được item `pending` với `activatesAt`; item thiếu `activatesAt` ⇒ lỗi schema (GET ⇒ lỗi trang như hiện tại).
  2. Bảng: nhãn pending đúng chữ, thứ tự active → pending → retiring.
  3. Có pending ⇒ nút normal bị disabled + câu giải thích; emergency vẫn mở được.
  4. 409 `conflict` ⇒ thông điệp cố định, không gửi lại (đếm 1 request), có re-read danh sách.
  5. Rotate thành công ⇒ text D86.13 có `activatesAt`.
  6. 5xx/timeout ⇒ `uncertainText` theo tập kid, không gửi lại.
  7. Dashboard có "Pending keys" đúng số.
  8. Trang và notice không có `eyJ`/`"d":`/`BEGIN`.
  9. E2E `fe-admin-keys.spec.ts` theo D86.12.
- **RED trước**: test route keys (pending label, order, disabled, 409, uncertain theo tập kid), schema test, dashboard test; E2E sửa theo D86.12.
- **Mutation phải làm test đỏ**: (a) quên `pending` trong enum; (b) 409 đi đường uncertain; (c) uncertain so kid active cho normal; (d) nút không disabled khi có pending; (e) sắp sai thứ tự.
- **File**: `fe-admin/src/server/admin-api/schemas.ts`, `fe-admin/src/routes/keys/index.tsx`, `fe-admin/src/routes/index.tsx` (`SigningKeysCard`), test liên quan, `e2e/tests/fe-admin-keys.spec.ts`.
- **Rủi ro**: deploy BE và fe-admin cùng một bản (ghi trong summary). Regex E2E `New active key (\S+); (\S+) is now…` đổi theo text mới.

### T4 [BE] DEBT-572 (P1) — POST `/logout` từ RP (D86.4–D86.7)

- **Tài sản, actor, ranh giới**: phiên IdP và refresh family. Actor: người dùng, RP (cùng site hoặc khác site), trang của kẻ tấn công. Ranh giới: POST cross-site (cookie `Lax` không được gửi).
- **Invariant**: chỉ POST có `_csrf` hợp lệ mới làm thay đổi state; trang xác nhận không bao giờ phản chiếu URI chưa kiểm.
- **AC**:
  1. POST không có `_csrf`, kèm `id_token_hint`/`post_logout_redirect_uri`/`state`/`client_id` ⇒ 200 HTML giống GET: hidden field, CSP nới đúng origin đã kiểm, `no-store`. `sessions.get`/`revoke`/`audit` không được gọi, không có `Set-Cookie` xoá phiên.
  2. POST không có `_csrf` và không có tham số nào ⇒ 200 trang xác nhận.
  3. URI không hợp lệ ⇒ không phản chiếu, CSP `=== buildCsp()`.
  4. `_csrf` sai hoặc chuỗi rỗng ⇒ 403 như cũ. `_csrf` dạng mảng ⇒ 400.
  5. Trang xác nhận render **không** có cookie phiên (mô phỏng cross-site) ⇒ token gắn cookie ẩn danh. POST kế tiếp mang cookie phiên + cookie ẩn danh + token đó ⇒ 302, phiên bị revoke, audit như POST thường.
  6. Token gắn cookie ẩn danh **của trình duyệt khác** ⇒ 403.
  7. `logout_hint`/`ui_locales` ⇒ không 400, không xuất hiện trong body.
  8. X3 ô 4 (mọi topology): `HTTP 200`, thấy nút "Sign out", phiên còn (1 cookie, SSO im lặng). Riêng cross-site: sau đó bấm "Sign out" trên trang xác nhận ⇒ phiên bị huỷ. Vẫn **42** ô.
- **RED trước**: sửa `ui.int-spec.ts:690` thành "POST logout without `_csrf` renders the confirmation without session work", thêm các ca AC2–AC7 (cùng file hoặc `run86-logout-post.int-spec.ts`), sửa X3 ô 4 (`e2e/x3/cookie-matrix.spec.ts:280-307`).
- **Mutation phải làm test đỏ**:
  - (a) Thiếu `_csrf` ⇒ revoke ⇒ AC1.
  - (b) Coi `_csrf=""` như thiếu ⇒ AC4.
  - (c) Chỉ chấp nhận identity phiên ⇒ AC5.
  - (d) Chấp nhận mọi token khi có cookie ẩn danh ⇒ AC6.
  - (e) Phản chiếu URI thô ⇒ AC3.
  - (f) Bỏ `logout_hint` khỏi DTO ⇒ AC7.
- **File**: `be/src/modules/ui/ui.controller.ts` (`LogoutDto`, `logoutForm`, `logout`, helper), `be/src/modules/ui/csrf.service.ts` (nếu tách `LogoutCsrfGuard`), `be/test/ui.int-spec.ts`, `e2e/x3/cookie-matrix.spec.ts`.
- **Failure**: `resolvePostLogoutRedirect` lỗi lúc render xác nhận từ POST ⇒ cùng hành vi với GET (5xx HTML, không đổi state).
- **Rủi ro**: ô X3 4 và `ui.int-spec:690` đổi kỳ vọng ⇒ ghi lý do trong test. Clickjacking: `frame-ancestors 'none'` vẫn giữ.

### T5 [BE] DEBT-583 (P2) + DEBT-599 (D86.14–D86.15)

- **AC**:
  1. Header CSP thật có `base-uri 'none'` và `=== buildCsp()` (các test byte-identity sẵn có). `csp.spec.ts` cập nhật chuỗi.
  2. Bảng unit `networkOf` cũ xanh nguyên vẹn (cùng output byte).
  3. Thêm ca: `0:0:0:0:0:ffff:1.2.3.4` ⇒ `1.2.3.4`; `::ffff:cb00:7107` ⇒ `203.0.113.7`; `fe80::1%eth0` ⇒ `fe80:0000:0000:0000`; `127.1`, `0x7f.0.0.1`, `''`, `undefined`, `'garbage'` ⇒ `unknown`; IPv6 nén hay không nén cùng /64 ⇒ cùng giá trị.
  4. Không còn code tự mở rộng IPv6.
- **RED trước**: ca `0:0:0:0:0:ffff:1.2.3.4` (đang đỏ: ra `0000:0000:0000:0000`); chuỗi `base-uri 'none'` trong `csp.spec.ts` và int header.
- **Mutation phải làm test đỏ**: (a) đổi chỉ `csp.ts` hoặc chỉ helmet ⇒ byte-identity; (b) `toNormalizedString()` ⇒ bảng cũ; (c) bỏ cổng `isIP` ⇒ ca `127.1`.
- **File**: `be/src/common/http/csp.ts` (+ spec, comment đầu file), `be/src/bootstrap.ts`, `be/src/modules/authentication/login-throttle.service.ts` (+ spec).
- **Rủi ro**: không có. Key bucket giữ nguyên, nên deploy không reset bộ đếm.

### T6 [QA] — tester

- Checklist:
  - C-14.2.1 ⇒ ✅ (bằng chứng `grep -F` test T1 + ⚠ phụ về lịch sử trình duyệt trong ghi chú).
  - B-L2d ⇒ ✅.
  - C-3.4c ⇒ ✅.
  - B-10.1.1 (rotate + `kid`) ⇒ cập nhật bằng chứng pre-publish, xét ✅.
  - Bảng tổng: P0 ❌ = 0.
  - `security-matrix.md`: SE4 (tên test mới + ca hai identity), thêm dòng pre-publish và dòng token fragment.
- Spec tester (không trùng T1–T5):
  - Fragment `#token=<43>&x=1`, `#TOKEN=`, `#token=<42>`, `#token=%41…` ⇒ không điền, vẫn `replaceState`.
  - `GET /reset?token=…#…` ⇒ không phản chiếu.
  - POST `/logout` `content-type: application/json` không `_csrf` ⇒ trang xác nhận hoặc 4xx, không 500, không đổi state.
  - Rotate normal ∥ emergency (Local) ⇒ trạng thái cuối 1 kid.
  - `KEY_PREPUBLISH_SEC` biên 0/86400.
  - Vault: hai version pending (race D86.10) ⇒ active là version mới nhất đã tới `activatesAt`, version sau nó vẫn pending, JWKS đủ kid; rotate normal ⇒ 409.
- Gate (tuần tự): typecheck/lint (be, fe-admin, e2e) ⇒ be unit (≥ 931) ⇒ int FULL (≥ 2143, `vg-int-*` không tăng) ⇒ vault spec (≥ 31, orchestrator chạy container) ⇒ fe-admin test (≥ 1613) ⇒ E2E (≥ 40: 39 + spec fragment) ⇒ X3 42.
