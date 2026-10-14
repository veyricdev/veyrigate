# Senior Review — Lượt 2 — 2026-10-14

## Kết luận: PASS

Cả 4 🔴 lượt 1 đã đóng, có bằng chứng mutation (bên dưới). Không có 🔴 mới. Còn 4 🟡 + ponytail → `backlog.md` (DEBT-078…081). Chuyển **tester**.

## Tổng quan

- FE: `callback.ts` đọc transient rồi `clearTransient` ngay (L118–120) và xoá ở cả 2 nhánh sớm (IdP error, thiếu code/state). Test callback giờ kiểm cả `tokens.get()===null` sau từng lần reject. `idToken.ts` bỏ header-check trùng, chỉ dựa `algorithms:["RS256"]`; có test PS256/HS256/`none`. Đã thêm `azp`, zod cho `/token`, guard chống "hồi sinh" phiên trong refresh, logout `state`, không còn echo `error_description` của URL callback.
- BE: `seedDev(conn, issuer, nodeEnv)` gọi `assertNotProduction` trước mọi truy cập DB (L84); test gọi thật `seedDev(...,'production')` rồi mới đếm. Resource upsert theo `resourceId`. Có test `/authorize` và preflight CORS thật.
- Tự chạy lại FE: typecheck ✅, lint ✅, vitest **65/65** ✅, build ✅. Hash sau review: `callback.ts` c6e2145…, `idToken.ts` 2ffc684…, `seed-dev.ts` 9dc7daa9… (khớp baseline).

### Mutation lượt 2 (Python: lưu bytes → đột biến → chạy test → ghi lại bytes → so sha256; tất cả `restored=ok`)

| # | Đột biến | Kết quả |
|---|---|---|
| 🔴1 | callback bỏ `validateIdToken`, decode payload không verify | ✅ 2 fail (nonce lệch, key lạ) |
| 🔴2 | `algorithms` → `RS256+PS256+HS256` | ✅ 1 fail (PS256) |
| 🔴2 | bỏ hẳn `algorithms` | ✅ 1 fail (PS256) |
| 🔴3 | bỏ `clearTransient` ngay sau `readTransient` | ✅ 3 fail (state, iss, F2) |
| 🔴3 | bỏ `clearTransient` ở nhánh IdP error | ✅ 1 fail |
| 🔴4 | `seedDev` bỏ `assertNotProduction` (thay bằng `void nodeEnv`) | ✅ bị bắt — xem ghi chú |
| 🟡 | refresh commit vô điều kiện (`if (true)`) | ✅ 1 fail |
| 🟡 | `consumeLogoutState` chấp nhận mọi state / không one-shot | ✅ 3 fail / ✅ 1 fail |

**Ghi chú 🔴4:** shell của reviewer không kết nối được Mongo test (`ECONNREFUSED :27117`, Docker engine pipe không thấy từ shell này; theo lệnh, KHÔNG `compose up`). Nên không chạy được `test:int -- seed-dev`. Thay vào đó đã chạy probe `ts-node` với connection giả (Proxy đếm mọi truy cập): bản gốc → `REJECTED touched=0`; bản đột biến → `RESOLVED touched=6` (ghi xuống `updateOne`). Đọc test `seed-dev.int-spec.ts:134–147`: gọi thật `seedDev(...,'production')`, `rejects`, rồi `countDocuments` client/resource = 0. Cách này khoá đúng invariant. **Tester bắt buộc chạy lại** `test:int` seed-dev (10/10) khi Mongo test sẵn sàng. Cũng lưu ý: `pnpm test:int -- seed-dev --forceExit` truyền `--` cho jest nên `--forceExit` thành pattern và jest treo. Hãy dùng `--forceExit` trước `--`.

## 🔴 Blocker

Không còn. 4 🔴 lượt 1 đã đóng:
- [x] 🔴1 test callback khoá validate ID token (nonce lệch / key lạ ⇒ reject + `tokens.get()===null`).
- [x] 🔴2 test PS256/HS256/`none`; pin chỉ ở `algorithms:["RS256"]`.
- [x] 🔴3 transient xoá ngay sau đọc và ở mọi nhánh lỗi.
- [x] 🔴4 guard production nằm trong `seedDev`, test đếm sau khi gọi.

## Security invariants / trust boundaries đã kiểm

- **Chữ ký/alg (INV-6)**: probe `jose` với **cùng key RSA** ký PS256: JWK không `alg` + `algorithms:["RS256"]` → `ERR_JOSE_ALG_NOT_ALLOWED`; JWK `alg:RS256` → cũng reject. Chỉ khi nới thành `RS256+PS256` *và* JWK không có `alg` thì mới ACCEPT. Vậy pin là thứ chặn thật, không phụ thuộc vào key-matching. HS256/`none` reject (test dùng JWKS bỏ `alg` để không bị lọc trước).
- **Nonce/replay (INV-7)**: callback dùng `transient.nonce`, refresh bắt buộc không có nonce + `sub` không đổi.
- **State/CSRF + mix-up**: `state` so khớp, `iss` bắt buộc và bằng issuer. Transient chỉ dùng 1 lần (xoá trước mọi nhánh), single-flight theo `code`.
- **Chuỗi request – refresh vs logout**: `tokens.get() === current` (refresh.ts:84) so tham chiếu đúng. Logout trong lúc refresh đang chạy → không ghi lại; phiên mới thay thế → không bị đè. Test ở refresh.test.ts:93. Nhánh **lỗi** thì chưa có guard tương tự → 🟡 DEBT-078.
- **Logout `state`**: 256 bit, `consumeLogoutState` đọc + xoá rồi so sánh (one-shot, fail-closed khi thiếu). Nhưng **chưa có route nào gọi** → 🟡 DEBT-079.
- **Schema `/token`**: `token_type` regex `/^bearer$/i` (bearer/BEARER OK, DPoP reject); trường thừa bị strip, không reject. Thiếu/sai kiểu `access_token`/`expires_in` → reject. Không quá chặt.
- **Exposure**: lỗi IdP ở URL callback chỉ hiện mã đã whitelist/sanitize, render bằng React text. Token chỉ ở memory; URL logout chỉ có `id_token_hint`.
- **Seed production**: fail-closed trước mọi truy cập DB (probe touched=0).

## 🟡 Nên sửa

🟡 **Refresh lỗi xoá phiên mới hơn**
fe-sso-test/src/oidc/refresh.ts:94 — `catch` gọi `deps.tokens.clear()` vô điều kiện.
Vì sao: nhánh thành công đã được guard bằng `get() === current`, nhưng nếu refresh cũ **fail** sau khi user đã logout → login lại, nó sẽ xoá phiên mới (logout ngoài ý muốn). Hai nhánh xử lý không nhất quán.
Đề xuất: `if (deps.tokens.get() === current) deps.tokens.clear();` + 1 test. → DEBT-078

🟡 **`consumeLogoutState` chưa được gọi**
fe-sso-test/src/oidc/logout.ts:55,67 — `logout()` lưu `oidc:logout_state` nhưng không route nào (Home ở `VITE_OIDC_POST_LOGOUT_URI=/`) gọi `consumeLogoutState`.
Vì sao: state nằm lại trong sessionStorage và không ai xác minh. Tính năng mới chỉ có một nửa.
Đề xuất: gọi ở landing post-logout (Home khi URL có `state`) rồi xoá query. Nếu không cần thì bỏ cả cặp (yagni). → DEBT-079

🟡 **`error_description` từ `/token` vẫn nối nguyên văn**
fe-sso-test/src/oidc/token-exchange.ts:38 — chuỗi này được hiển thị qua `Callback.tsx`/`Home.tsx`.
Vì sao: rủi ro thấp (đến từ IdP qua fetch, không phải từ URL), nhưng không khớp chính sách "không hiện nguyên văn" vừa áp cho callback.
Đề xuất: chỉ giữ `error` code, hoặc cắt độ dài + đánh dấu là của IdP. → DEBT-080

🟡 **Ponytail** (xem dưới) → DEBT-081

## 💭 Nit

- idToken.test.ts:72 — test PS256 dùng key PS256 riêng. Ký PS256 bằng **chính key RSA** của `makeKeys` (JWK không `alg`) sẽ mô tả đúng hơn kịch bản "cùng key, đổi alg". Mutation hiện tại vẫn bắt được.
- `pnpm test:int -- <pattern> --forceExit` làm jest treo (xem ghi chú 🔴4). Nên ghi đúng cú pháp vào README/log.

## ✂️ Ponytail

- fe-sso-test/src/oidc/callback.ts:L32: shrink: `KNOWN_ERROR_CODES` (18 dòng) không đổi được output, vì mã hợp lệ đã qua được sanitizer `[a-z0-9_-]`. Giữ một dòng sanitize + slice.
- fe-sso-test/test/helpers/jwt.ts:L25: delete: option `alg` và comment "PS256 reuses the RSA key" (L39–48) không còn caller nào. Hardcode `RS256`.
- fe-sso-test/src/oidc/logout.ts:L67: yagni: `consumeLogoutState` + persist state (L53–56) nếu không nối vào route (DEBT-079). Nối vào, hoặc xoá.
net: -25 lines possible.

---

# Senior Review — Lượt 1 — 2026-10-13

## Kết luận: REJECT

Còn 4 🔴: **3 thuộc FE** (frontend-dev), **1 thuộc BE** (backend-dev). Code chạy đúng; các 🔴 chủ yếu là **test không khóa được invariant** (chứng minh bằng mutation) và **1 acceptance chưa đạt** (xoá transient ở nhánh lỗi). Sửa nhỏ, không cần đổi thiết kế.

## Tổng quan (ấn tượng chung + điểm tốt)

- `src/oidc/` gọn, hàm thuần, inject fetch/JWKS/storage/clock nên test không cần mạng. Đúng hướng tech-lead.
- PKCE: verifier 32 byte `getRandomValues` → 43 ký tự base64url (256 bit), challenge = base64url(SHA-256) không padding, method luôn `S256`. state/nonce cũng 256 bit, sinh mới mỗi lần. Verifier không lọt vào URL `/authorize`.
- Discovery: zod + `issuer === VITE_OIDC_ISSUER` (F5). Callback bắt buộc có `iss`, so khớp chính xác. `jwtVerify` ghim `RS256`, `issuer`, `audience`, `requiredClaims`, `clockTolerance` = 5s. JWKS lấy từ `discovery.jwks_uri` (`createRemoteJWKSet`, timeout mặc định 5s ≤ 10s).
- Token chỉ ở closure in-memory. sessionStorage chỉ giữ transient. Không `console.*`. Redirect sau login cố định `/`, không có `returnTo` nên không có open-redirect. Lỗi hiển thị qua React text/`textContent`, không phải `innerHTML` với input.
- Single-flight theo `code` (F2) và theo store (F3) đều đúng. Refresh kiểm `sub` (F4), lỗi ⇒ `tokens.clear()`, không retry. Mọi fetch có `AbortSignal.timeout(10_000)`. `/token` grant `authorization_code` không retry.
- Seed BE: upsert `$set` theo khoá unique (`clientId`/`identifier`), không tạo `ClientCredential`, URI qua validator, guard production đặt trước `createConnection`. Cấu hình khớp F8.
- Phiên bản ghim exact, khớp F1. typecheck/lint/45 vitest xanh (tự chạy lại). BE `seed-dev.int-spec` 7/7 (tự chạy lại).

### Mutation đã chạy (khôi phục byte-identical, kiểm bằng sha256 — tất cả `restored-ok`)

| Đột biến | Kết quả |
|---|---|
| bỏ kiểm `state` (callback) | ✅ test fail |
| bỏ kiểm `iss` / cho phép thiếu `iss` | ✅ fail / ✅ fail |
| bỏ so `nonce` trong `validateIdToken` | ✅ fail |
| **callback bỏ hẳn `validateIdToken` (decode payload không verify)** | ❌ **45/45 vẫn xanh** |
| **nới `algorithms` thành RS256+PS256+HS256 và check alg chỉ chặn `none`** | ❌ **45/45 vẫn xanh** |
| bỏ issuer-check ở discovery | ✅ fail |
| bỏ kiểm `sub` khi refresh | ✅ fail |
| bỏ `clearTransient` trước `/token` | ✅ fail |
| bỏ single-flight callback / refresh | ✅ fail / ✅ fail |
| bỏ `tokens.clear()` khi refresh lỗi | ✅ fail |
| bỏ kiểm transient stale | ✅ fail |
| clockTolerance 86400s | ✅ fail |
| giữ refresh token cũ (bỏ rotation) | ✅ fail |
| bỏ `AbortSignal.timeout` | ✅ fail |
| challenge = verifier (plain) | ✅ fail |
| bỏ `id_token_hint` | ✅ fail |
| **BE: bỏ `assertNotProduction(...)` trong `main()`** | ❌ **7/7 vẫn xanh** |

## 🔴 Blocker

- [ ] **[FE] Callback không chứng minh được rằng ID token có được validate** — `fe-sso-test/src/oidc/callback.ts:126` + `test/callback.test.ts`.
  Vì sao: thay `validateIdToken(...)` bằng một lệnh decode không verify thì toàn bộ 45 test vẫn xanh. Như vậy một refactor làm mất bước verify chữ ký/`nonce`/`aud` sẽ lọt qua CI, và RP sẽ chấp nhận ID token giả mạo hoặc bị replay (INV-6/INV-7). Acceptance "đổi 1 tham số (state HOẶC **nonce** HOẶC iss) ⇒ login thất bại" mới chỉ có ở mức callback cho state và iss. nonce thì chỉ có test ở unit validator.
  Đề xuất: trong `callback.test.ts` thêm ít nhất (a) id_token có `nonce` khác transient ⇒ reject; (b) id_token ký bằng key lạ ⇒ reject. Cả hai đều assert `d.tokens.get() === null` (không cấp phiên). Nên thêm assert `tokens.get() === null` cho các test state/iss hiện có.

- [ ] **[FE] Thiếu test `alg ≠ RS256` (F5 bắt buộc)** — `test/idToken.test.ts`.
  Vì sao: tasks.md F5 ghi rõ "Test: token `alg` khác RS256 ⇒ fail". Mutation nới `algorithms` vẫn xanh nên hàng rào chống downgrade thuật toán chưa được khóa. Helper `signIdToken` đã có option `alg` nhưng chưa test nào dùng.
  Đề xuất: ký bằng key RSA cùng JWKS với `alg: "PS256"` (JWK đã khai báo `alg: RS256` thì đổi JWK test sang không `alg`, hoặc dùng `createLocalJWKSet` riêng) ⇒ expect reject. Thêm 1 case HS256 (khóa đối xứng) ⇒ reject.

- [ ] **[FE] Transient không bị xoá ở các nhánh lỗi** — `fe-sso-test/src/oidc/callback.ts:48-52` (IdP `error`), `:57-59` (thiếu code/state), `:89-96` (state/iss mismatch).
  Vì sao: review-techlead OPEN-1 yêu cầu "xoá ngay khi vào callback (**cả nhánh lỗi**)". Hiện tại chỉ nhánh stale và nhánh trước `/token` có xoá, nên `{state, nonce, code_verifier}` còn nằm trong sessionStorage sau `access_denied` hoặc mismatch, tới khi login lần sau ghi đè. Blast radius thấp (cùng tab, có TTL 10'), nhưng đây là acceptance đã chốt và là exposure budget của verifier.
  Đề xuất: trong `exchange()` gọi `clearTransient` ngay sau `readTransient` (trước mọi kiểm). Ở nhánh `error`/thiếu tham số của `handleCallback` cũng gọi `clearTransient`. Single-flight theo `code` vẫn đúng vì lần gọi thứ 2 join promise. Test: mỗi nhánh lỗi ⇒ `store.getItem("oidc:transient") === null`.

- [ ] **[BE] Guard production của CLI không được test khóa** — `be/src/database/seed-dev.ts:113-116`, `be/test/seed-dev.int-spec.ts` (case "NODE_ENV=production is refused").
  Vì sao: test chỉ gọi trực tiếp `assertNotProduction`, rồi đếm collection *khi chưa hề chạy seed*, nên phần "0 ghi DB" luôn đúng (tautology). Xoá lời gọi guard trong `main()` thì 7/7 vẫn xanh. F9 yêu cầu "production ⇒ throw, 0 ghi DB". Nếu guard này hồi quy, một client public với redirect/CORS `http://localhost` sẽ được ghi vào control-plane production.
  Đề xuất (chọn 1):
  - (a) Đưa guard vào chính `seedDev(connection, issuer, nodeEnv)`, gọi trước mọi ghi. Test: `seedDev(conn, ISSUER, 'production')` rejects và `countDocuments` = 0.
  - (b) Export `runSeedDev(env, connect)` với `connect` inject được. Test: production ⇒ throw và `connect` chưa từng được gọi.
  
  (a) đơn giản hơn và cho defense-in-depth.

## Security invariants / trust boundaries đã kiểm

- **CSRF/state**: so khớp exact, mismatch ⇒ không gọi `/token` (mutation xác nhận).
- **Mix-up**: discovery issuer === env; `iss` callback bắt buộc và exact (mutation xác nhận).
- **ID token**: RS256 ghim, JWKS từ discovery, iss/aud/exp/iat/nonce. Ở mức unit thì đúng, ở mức wiring của callback thì chưa được khóa (🔴). `azp`: không kiểm (🟡 bên dưới).
- **PKCE**: entropy 256 bit, base64url không padding, S256 cố định, verifier chỉ đi `/token`.
- **Replay code / StrictMode**: single-flight theo `code` và xoá transient trước `/token`. Loader của Data Mode chạy 1 lần. Không retry.
- **Refresh**: single-flight, rotation thay token mới, `sub` cố định, lỗi ⇒ anonymous. Nếu không có refresh_token ⇒ không gọi mạng (throw thay vì no-op, 💭).
- **Exposure**: không web storage cho token, không log. Chỉ `id_token_hint` trong URL logout. Lỗi `/token` hiện `error`/`error_description` của IdP, không chứa token.
- **Open redirect**: không có `returnTo`; logout dùng `post_logout_redirect_uri` từ env.
- **Failure**: discovery/token/JWKS lỗi hoặc timeout ⇒ throw ⇒ `errorElement`, không cấp phiên.
- **Seed**: public client, không secret, CORS exact 1 origin, idempotent. Guard production đúng trong code nhưng chưa có test khóa (🔴).

## 🟡 Nên sửa

1. **[FE] Logout thiếu `state`** — `src/oidc/logout.ts:22-25`. BE đã echo `state` (`logout.service.ts:117`). Cân nhắc sinh `state` và kiểm khi quay về `/` để chứng minh được post-logout redirect đến từ IdP (hữu ích cho T5/X1).
2. **[FE] Không kiểm `azp` khi `aud` có nhiều giá trị** — `src/oidc/idToken.ts:54`. OIDC Core §3.1.3.7: nếu `aud` là mảng nhiều phần tử thì `azp` phải có và === client_id. BE hiện phát một aud nên chưa khai thác được, nhưng thêm 3 dòng + 1 test là rẻ.
3. **[FE] Response `/token` thành công không được validate** — `src/oidc/token-exchange.ts:26` ép kiểu thẳng. Thiếu `access_token`/`expires_in` sẽ cho ra session với `undefined`/`NaN`. Cân nhắc dùng zod tối thiểu (`access_token` string, `token_type` ~ `/^bearer$/i`, `expires_in` number).
4. **[FE] Refresh có thể "hồi sinh" phiên sau logout** — `src/oidc/refresh.ts:80`. Nếu `logout()` chạy trong lúc refresh đang bay thì `tokens.set` ghi lại session. Hiện tại logout điều hướng trang nên chưa lộ, nhưng sẽ lộ khi T3 có auto-refresh. Gợi ý: trước khi `set`, kiểm `deps.tokens.get() === current`.
5. **[FE] `error_description` từ query của callback được hiển thị nguyên văn** — `src/oidc/callback.ts:50-51`. Không có XSS (React escape), nhưng attacker tạo được link `/callback?error=x&error_description=<thông điệp lừa đảo>` (content spoofing). Cân nhắc chỉ hiển thị `error` code, hoặc cắt độ dài.
6. **[BE] Test `/authorize` và CORS mô phỏng lại logic thay vì gọi endpoint thật** — `be/test/seed-dev.int-spec.ts` (case scope ⊆ / CORS). F9 nêu `GET /authorize` và preflight `OPTIONS /token`. Test hiện tự kiểm `scope ⊆ client.scopes` và gọi service, nên nếu controller đổi luật thì test không bắt được. Ngoài ra nó dùng scope `openid profile email`, trong khi `.env.example` FE nay là `... offline_access`. Nên dùng đúng chuỗi scope của FE, và nếu harness sẵn thì gọi HTTP thật.
7. **[BE] Resource upsert theo `identifier`** — `be/src/database/seed-dev.ts:86-90`. Khi `ISSUER` đổi, lần chạy sau tạo thêm document `resourceId='demo'` thứ hai (không có unique trên `resourceId`). Ghi chú vào DEBT-077 / B6.4 là đủ.

## 💭 Nit

- `src/oidc/idToken.ts:28-33`: comment nhánh refresh tự mâu thuẫn ("If a nonce is present it must equal expectedNonce… allowed only when it is absent"). Nên viết lại: "refresh mode: nonce phải vắng mặt".
- `src/oidc/refresh.ts:45-47`: F4 ghi "không có refresh_token ⇒ no-op" nhưng code throw (vẫn không gọi mạng, không xoá phiên). Nên thống nhất ngữ nghĩa trong JSDoc.
- `src/routes/Callback.tsx`: component `Callback` gần như không bao giờ render (loader redirect trước). Có thể để `HydrateFallback` hoặc giữ, tùy ý.
- log.md mục frontend-dev bị lỗi encoding (`?? l?m`). Nên ghi lại UTF-8.

## ✂️ Ponytail

- fe-sso-test/src/oidc/index.ts:L1: delete: barrel không ai import (router/test import trực tiếp từng module). Xoá file.
- fe-sso-test/src/oidc/idToken.ts:L48: shrink: kiểm `protectedHeader.alg !== "RS256"` trùng với `algorithms: ["RS256"]` của jose. Bỏ, để test alg (🔴 #2) khóa hành vi.
- fe-sso-test/src/oidc/refresh.ts:L76: shrink: `token.refresh_token ?? undefined`. Dùng `token.refresh_token`.
- be/src/database/seed-dev.ts:L77: shrink: `connection.models.Client ?? connection.model<Client>('Client')`. Dùng `connection.model<Client>('Client')` (trả model đã đăng ký); tương tự L78-79.
- fe-sso-test/vite.config.ts:L18: delete: `globals: true` trong khi mọi test đều `import { describe, it, expect } from "vitest"`. Bỏ, nếu tsconfig không tham chiếu `vitest/globals`.

net: -14 lines possible.