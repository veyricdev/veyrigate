# Senior Review — 2026-10-19 — run 33 (B5.3 + DEBT-189 + X4)

## Kết luận: PASS

Không có 🔴. Chuyển → **tester**. Các 🟡 vào `backlog.md` (DEBT-197…200).

## Tổng quan (ấn tượng chung + điểm tốt)

Diff bám sát fold F1–F22 và gọn so với độ phức tạp của trust boundary.
- **INV-22**: nhánh email trùng chỉ tạo pending link (Redis `fed_link:{sha256}`, `SET NX PX` 10', token chỉ ở cookie `idp_link` HttpOnly, Path `/auth/`). Không có FI, không có session. `POST /auth/link` làm theo thứ tự: CsrfGuard → rate-limit (`federation` + `login` theo email pending) → **consume trước (GET+DEL Lua)** → binding `idp_fed` (constant-time) → `auth.login(pending.email)` (tái dùng nguyên `/login`: lỗi generic, `DUMMY_HASH`, đếm sai/lock, chặn chưa verify, kiểm lock atomic DEBT-154) → `userId` phải khớp → `identities.link` → audit `ACCOUNT_LINKED` (metadata chỉ `provider`). Email không bao giờ lấy từ form, vì `forbidNonWhitelisted` từ chối field thừa.
- Thứ tự `email_unverified` vẫn đứng trước `findByEmail`, nên email chưa verify không dò được tài khoản. Callback và trang link không đọc trạng thái lock/password/verify, nên F11 đúng theo thiết kế, và int test byte-identical kiểm điều đó.
- **DEBT-189**: `reauthAfter` tính cả khi không có session. Google nhận `max_age` = số giây kể từ mốc và bị kiểm `auth_time`; GitHub bị từ chối. `authTime` của session lấy từ `auth_time` thật, kẹp `[reauthAfter, now]`, nên không còn bịa `now` cho SSO cũ. Session absolute/idle tính từ `createdAt`/`lastSeenAt` chứ không từ `authTime` (đã kiểm), nên `auth_time` cũ không làm session hết hạn sớm.
- **INV-23**: entry E2E nằm ngoài `src/` và `tsconfig.build.json` loại `test`. Entry từ chối `NODE_ENV=production`. Mock chạy trên `127.0.0.1:0` trong cùng tiến trình, URL chỉ có trong bộ nhớ. Guard `assert-dist-clean.mjs` chạy trước khi khởi động server.
- `configureApp` là bản chuyển nguyên văn từ `main.ts` (helmet CSP, cookie, static, view, CORS preflight, OpenAPI, ValidationPipe, shutdown hooks). Hành vi không đổi. `main.ts` vẫn giữ loadEnv, trustProxy assert và listen.
- Bằng chứng tự chạy: `typecheck` và `lint` sạch; unit 303/303. `test:int` chạy đủ 2 lần: mỗi lần 810/811, cùng một test đỏ là `client-auth-rate-limit.int-spec.ts › no TRUST_PROXY => … share one counter`. Diff không chạm file này, và chạy riêng file 2 lần đều 16/16 (xem DEBT-199). Không chạy E2E (theo quy tắc).

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| Không auto-link (INV-22): FI chỉ tạo sau khi đăng nhập password đúng user đích | OK | `federation.service.ts:171-183` (callback không ghi FI hay session), `:263-307`; int (a)(b)(j) |
| Pending single-use / replay / race | OK | `consumeLink` dùng Lua GET+DEL trước mọi kiểm tra; int (f)(m) |
| Binding/CSRF/fixation | OK | GET và POST đều so `sha256(idp_fed)` constant-time; CsrfGuard với `formCsrfIdentity` (cùng identity GET/POST); int (g)(h) |
| Đúng user đích | OK | `established.session.userId !== pending.userId` ⇒ `not_linked` (session được giữ vì `establish` đã rotate session cũ, đúng F8); int (j) |
| Enumeration | OK | `auth.login` ném duy nhất `UnauthorizedException` cho mọi nhánh (không user/sai/chưa verify/lock), có `DUMMY_HASH`; trang link/lỗi giống nhau; int F11 byte-identical cho 4 loại tài khoản |
| Exposure | OK | Log chỉ có mã cố định (`federation link failed: <code>`); token chỉ trong cookie; HTML chỉ hiện email đã được provider verify (chấp nhận theo F7/F11); Eta `autoEscape`; int F12 |
| max_age / prompt=login (federation + local) | OK | `authorize.service.ts:213,498-502`; resume vẫn kiểm `authTime < reauthAfter`; Google `max_age` + `auth_time`, GitHub từ chối; link bằng password ⇒ `authTime=now` thoả (l); int DEBT-189 ×6 + authorize F1 |
| auth_time không bịa | OK (giới hạn đã biết) | Kẹp dưới tối đa bằng skew 60s đã chấp nhận (F3); Google không có `auth_time` và GitHub dùng `now` (DEBT-192) |
| Failure behavior | OK | Redis lỗi khi tạo pending ⇒ 500, không cookie; lỗi ngoài `Unauthorized`/`Duplicate` được ném lại (không biến thành success); body provider > 64 KB ⇒ cancel và 502; JWKS lỗi mạng ⇒ 502 |
| Open redirect / CSP | OK | Mọi `location` dựng phía server (`resumeUrl`/`loginUrlFor`, có encode); `form-action` chỉ thêm origin RP qua `safeCspOrigin(ctx.redirectUri)` (redirect_uri đã khớp); peek lỗi ⇒ chỉ `'self'` |
| INV-23 | OK | Entry/mock nằm ngoài `src/`, build loại `test`, guard dist, chặn production |
| Bootstrap không đổi hành vi | OK | So diff dòng-dòng: chỉ chuyển code, thứ tự giữ nguyên |

## 🟡 Nên sửa

- [ ] **[BE] DEBT-197 — JWKS trả non-200 hoặc JSON hỏng bị phân loại là `invalid_identity` (400) thay vì 502**
  `be/src/modules/federation/federation.client.ts:116`: điều kiện `!(err instanceof errors.JOSEError) || code === 'ERR_JWKS_TIMEOUT'`.
  Vì sao: trong jose 5.10, `fetch_jwks.js:32,42` ném `JOSEError` (code `ERR_JOSE_GENERIC`) khi JWKS trả 5xx hoặc JSON lỗi. Hệ quả là Google JWKS sập (5xx) hiện "The sign-in could not be verified" (400), không phải "provider unavailable" (502). Ngược lại, mọi lỗi lập trình không phải JOSE (TypeError…) lại hiện thành 502 "provider". Vẫn fail-closed, không bypass, nhưng sai lệch so với hợp đồng F16 và gây nhiễu khi vận hành/giám sát.
  Đề xuất: cân nhắc coi `err.code === 'ERR_JOSE_GENERIC'` (lỗi tầng fetch của remote JWKS) là `provider_unavailable`, hoặc gọi `jwks()` riêng để phân loại trước `jwtVerify`. Thêm int: JWKS 503 ⇒ 502.

- [ ] **[BE] DEBT-198 — Cookie binding `idp_fed` có thể hết hạn trước pending link**
  `federation.controller.ts:109-115`: `idp_fed` có `maxAge = FED_STATE_TTL_MS` (10') tính từ **start**. Pending link sống 10' tính từ **callback** (`:249-256`).
  Vì sao: người dùng mất ~10' tổng (ở provider + đọc trang link) thì GET/POST `/auth/link` thất bại vì thiếu binding, và POST đã đốt pending. Không có rủi ro bảo mật, nhưng là lỗi UX khó hiểu.
  Đề xuất: khi trả `link_required`, set lại `idp_fed` (cùng giá trị) với `maxAge = FED_LINK_TTL_MS`.

- [ ] **[test] DEBT-199 — `test/client-auth-rate-limit.int-spec.ts` › "no TRUST_PROXY => two different X-Forwarded-For share one counter" chập chờn khi chạy full `test:int`**
  Đỏ ở cả 2 lần full `test:int` trong lượt review. Chạy riêng file 2 lần đều xanh. Run 33 không chạm file hay module này.
  Vì sao: cùng loại với DEBT-195. Test chập chờn làm báo cáo "811/811" của dev không tái lập được và che hồi quy thật.
  Đề xuất: bắt log lần đỏ (nghi cửa sổ thời gian của bucket hoặc key Redis dùng chung giữa các suite); dùng key/ip duy nhất cho mỗi test hoặc đồng hồ giả.

- [ ] **[BE/E2E] DEBT-200 — Ponytail run 33** (xem mục ✂️; tổng khoảng −8 dòng).

## 💭 Nit

- `be/test/e2e/e2e-main.ts:17` có docstring "`be/.env` is not loaded". Thực tế `NestConfigModule.forRoot` mặc định vẫn đọc `.env` theo cwd `be/`, và không ghi đè biến có sẵn (đúng như comment trong `playwright.config.ts:20-21`). Nên sửa câu thành "env của harness thắng; `be/.env` chỉ lấp chỗ trống".
- JWKS remote (jose) không có trần body như `providerFetchJson`. URL là hằng số của Google nên rủi ro thấp; chỉ ghi lại để biết.
- `federation.controller.ts:41` khai `PROVIDER_LABELS` riêng. Nếu trang login đã có nhãn provider thì nên dùng chung (không bắt buộc).

## ✂️ Ponytail

- be/src/modules/federation/federation-state.store.ts:L44: yagni: `FederationLinkRecord.createdAt` không ai đọc (Redis TTL lo hết hạn). Xoá field và nhận `record` thẳng trong `createLink` như `create()`.
- be/src/modules/federation/provider-http.ts:L4: shrink: `export` của `PROVIDER_MAX_BODY_BYTES` không có ai import. Bỏ `export`.
- be/test/e2e/mock-google.ts:L11: delete: `export const E2E_MOCK_MARKER` không ai import (guard chỉ grep chuỗi). Giữ chuỗi literal trong một comment hoặc const không export.
- be/src/modules/federation/federation.controller.ts:L232: shrink: `linkFailedPage` chỉ dùng 1 lần với 2 nhánh gần giống nhau. Inline thành một `reply.status(400).view('error.eta', {...})` chọn `message/actionUrl/actionLabel` theo `outcome.kind`.

net: -8 lines possible.
