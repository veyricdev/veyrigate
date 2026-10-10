# Senior Review — 2026-10-10 (run 15 — B4.6, lượt 2)

## Kết luận: PASS

Cả 2 🔴 lượt 1 đã đóng, có bằng chứng test; không phát sinh 🔴 mới. Thứ tự liveness → authz ở `/introspect` không tạo oracle qua body (mọi nhánh âm vẫn `{active:false}` 200 cùng shape); refactor form parse giữ nguyên hành vi `/token`. Còn 3 🟡 nhỏ → backlog DEBT-040..042. Chuyển **tester**.

Tự kiểm (Git Bash): `tsc --noEmit` sạch, `eslint src` sạch, `pnpm test` **94/94**, `pnpm test:int` introspect/userinfo/token/discovery **67/67** (khớp báo cáo dev 304/304 toàn suite).

## Tổng quan (ấn tượng chung + điểm tốt)

- `isAccessTokenLive` (`be/src/modules/oauth/access-token-liveness.ts:L31-L46`) là hàm thuần, phụ thuộc qua 2 interface hẹp (`ClientLookup`, `UserExistence`) → `/userinfo` và `/introspect` không thể lệch nhau nữa. Kiểm `ObjectId.isValid(sub)` trước khi chạm DB nên `sub` rác → `false`, không thành CastError/500. Lỗi DB **không bị nuốt** → 500 (có test `introspect.int-spec.ts:L374`). Đúng hướng đề xuất lượt 1.
- `/userinfo` tái dùng liveness nhưng vẫn chỉ 1 lần đọc user (closure `fetched` cache document có `select` tường minh) — không phát sinh query thừa.
- `verifyAccessToken` thêm kiểm `typeof` string cho `aud/sub/client_id/scope/jti` (`token-verifier.ts:L68-L76`) — đóng luôn 🟡 kiểu claim.
- `registerCorsPreflight` dùng chung giữa `main.ts:L51` và test → test chạy đúng code production; thêm case preflight `/token`.
- `form.ts`: `FormParseError` trung lập, mỗi controller tự map lỗi — cùng pattern với `ClientAuthRequestError`, nhất quán.

## 🔴 Blocker

Không còn. Xác minh từng mục lượt 1:

- [x] 🔴#1 `/introspect` liveness — `introspect.controller.ts:L147-L152` gọi `isAccessTokenLive` sau `verifyAccessToken`. Test: client bị xoá (L253), `aud` không còn trong `allowedResources` (L271), user không tồn tại (L281), `sub` sai định dạng (L288) → `{active:false}`; DB fault khi liveness → 500 (L374). Test seed user thật (L136-L138), hết che lỗi.
- [x] 🔴#2 bằng chứng token-confusion — `token.int-spec.ts:L217-L235` decode header từ response `/token` **thật**: access `typ: at+jwt`, ID `typ: JWT`. `keys.spec.ts:L136-L239` phủ `verifyAccessToken`: hợp lệ resolve; HS256, `iss` sai, thiếu `exp`, thiếu từng claim `sub/jti/client_id/scope`, `aud` mảng, `typ: JWT`, claim không phải string → reject.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| Token confusion | ✅ `/token` phát `at+jwt` (test e2e), ID token `JWT`; `verifyAccessToken` pin `typ` (unit) |
| `alg`/`iss`/`exp`/claim/kiểu claim | ✅ unit đủ case |
| Liveness access token (client/aud/user) | ✅ hàm chung, 4 case âm + fail-closed 500 |
| Thứ tự liveness → authz caller (enumeration) | ✅ Không có oracle qua **nội dung**: caller không được phép luôn nhận `{active:false}` dù token live hay không. Kênh còn lại chỉ là **timing** (caller không được phép vẫn kích DB lookup client/user) và 500 khi DB lỗi; muốn khai thác phải đã cầm một access token hợp lệ (vốn chứa sẵn `sub`/`client_id`), rò tối đa "user/client còn tồn tại" — blast radius thấp → 🟡 DEBT-040, không chặn |
| Caller auth trước mọi thứ | ✅ `handle()` L93: auth caller trước khi đọc `token` → không oracle cho caller chưa xác thực |
| IDOR / confused deputy | ✅ giữ nguyên (refresh: owning client; access: `client_id` hoặc `aud ∈ caller.allowedResources`) |
| Fail-closed | ✅ DB lỗi ở refresh lookup và liveness → 500 `server_error`, không có `active` |
| Refactor form `/token` | ✅ Tương đương bản cũ: so media type (cho phép charset), `null/undefined` bỏ qua, mảng (tham số lặp) → 400 `invalid_request`, giá trị khác qua `String()`. `parseFormBody` chỉ map `FormParseError`, lỗi khác vẫn ném → 500 như trước. `resolveClientAuth` chung giữ 401 + `WWW-Authenticate: Basic`. `token.int-spec` + `refresh-token.int-spec` xanh |
| CORS | ✅ `Vary: Origin` luôn có trên discovery/JWKS; 401/403 `/userinfo` echo ACAO theo union allowlist (body không PII), success vẫn per-client; không `*`, không Allow-Credentials |
| Exposure | ✅ không đổi so lượt 1 (không log token; introspect không trả hash/`_id`/`familyId`) |

## 🟡 Nên sửa

- 🟡 **Đảo thứ tự: authz caller trước liveness ở `/introspect`** (DEBT-040)
  `introspect.controller.ts:L147-L160` — liveness (2 query DB) chạy trước kiểm `claims.client_id === caller.clientId || caller.allowedResources.includes(claims.aud)`.
  Vì sao: authz chỉ cần `claims` + `caller` đã có trong bộ nhớ, rẻ hơn; đặt trước thì caller không được phép (confused deputy) không kích được DB lookup → bỏ kênh timing "user/client còn tồn tại" và bớt tải DB vô ích. Kết quả `active` không đổi vì cả hai điều kiện đều phải đúng.
  Đề xuất: chuyển khối `authorized` lên trước `isAccessTokenLive`; sửa comment test L274-L275 ("liveness is checked FIRST").

- 🟡 **Test liveness `aud` của `/introspect` không cô lập được nhánh `aud`** (DEBT-041)
  `introspect.int-spec.ts:L271-L279` — caller là `RS_CLIENT` (chỉ có `RESOURCE`), token `aud: removed.example`. Bỏ kiểm `aud` trong `isAccessTokenLive` thì authz vẫn trả `active:false` → test vẫn xanh (nhánh này hiện chỉ được `/userinfo` "aud not in client.allowedResources" phủ gián tiếp qua hàm chung).
  Đề xuất: dùng caller `TOKEN_CLIENT` (authz qua `client_id === caller`) để chỉ liveness có thể trả `false`.

- 🟡 **`KeysModule` → `ClientsModule`** (giữ từ lượt 1, dev chủ động để debt — DEBT-042)
  `keys.module.ts` — module hạ tầng khoá phụ thuộc module nghiệp vụ chỉ để JWKS có CORS; nguy cơ vòng import nếu `ClientsModule` cần `TokenVerifier`. Đề xuất: chuyển route `jwks.json` sang `oauth/` cạnh discovery.

## 💭 Nit

- 💭 `userinfo.controller.ts:L112-L114` — comment "Only reached on the success path (a 401/403 carries no PII to protect cross-origin)" giờ lệch: 401/403 cũng có CORS (union) ở `unauthorized()`. Sửa thành "success path dùng allowlist per-client".
- 💭 `introspect.int-spec.ts:L168, L352` — ký tự `?` thay cho em-dash (mất encoding khi lưu) trong comment.
- 💭 `introspect.controller.ts:L57` — "phuong an" tiếng Việt không dấu trong JSDoc tiếng Anh (còn từ lượt 1).
- 💭 5 interface Reply gần giống nhau (`JwksReply`, `DiscoveryReply`, `UserinfoReply`, `IntrospectReply`, `TokenReply`) — gom `JsonReply` vào `common/http/http.types.ts` (còn từ lượt 1).
- 💭 `verify(token, audience)` không pin `typ` — cân nhắc `typ: 'JWT'` khi B4.7 dùng cho `id_token_hint`.

## ✂️ Ponytail

- be/src/modules/keys/keys.controller.ts:L8: shrink: `JwksReply` (và 4 interface Reply anh em). Một `JsonReply` trong `common/http/http.types.ts`.
net: -15 lines possible.
