# Tasks — run 32 — B5.1 + B5.2: federation provider tĩnh + broker flow (M6)

> Plan §B5 (B5.1, B5.2), spec §9.9 (broker, `state` riêng của IdP gắn `request_id`, callback `/auth/{google,github}/callback`, FederatedIdentity collection riêng unique `(provider, providerId)`), §9.1 (`AuthorizeRequestContext` single-use), §13 bước 10, INV-23 (provider chỉ cấu hình tĩnh trong code — không URL do người dùng/tenant nhập, chống SSRF), plan dòng 559/586. B5.3 (account linking an toàn, INV-22) + X4 (E2E mock provider) → **run 33**; run này: email trùng tài khoản local ⇒ **dừng an toàn** (không link, không tạo user trùng, hiện thông báo) chờ B5.3.
>
> Thứ tự: Task 1 → 2 → 3 (backend-dev); Task 4 UI login. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`. Không gọi Google/GitHub thật trong test.

### [x] Task 1 [BE]: B5.1 — provider tĩnh Google + GitHub
- Module `federation/`: định nghĩa provider **cứng trong code** (authorize/token/userinfo/emails endpoint), `client_id`/`client_secret` từ env (optional: thiếu ⇒ provider tắt, nút không hiện). Không có đường cấu hình URL từ DB/request/tenant.
- Google: OIDC code flow + PKCE + `nonce`, verify ID token (iss/aud/exp/nonce qua JWKS Google cứng) hoặc userinfo — tech-lead chốt. GitHub: OAuth code flow, lấy email **primary & verified** từ `GET /user/emails`, không tin email trong profile.
- Seam test: HTTP client inject được để int-test dùng mock (không mở cấu hình URL runtime — tech-lead chốt cách mock vừa an toàn vừa test được, vd. provider `mock` chỉ đăng ký khi `NODE_ENV=test` với endpoint localhost cứng, hoặc stub HTTP).
- **Acceptance**: unit/int: thiếu env ⇒ provider tắt; GitHub email chưa verified/không primary ⇒ không dùng; Google ID token sai iss/aud/nonce/hết hạn ⇒ từ chối; không có code path nhận URL provider từ input (test/grep); secret không log.

### [x] Task 2 [BE]: B5.2 — broker flow
- `GET /auth/{provider}/start?request_id=…` (từ trang login): kiểm context tồn tại (peek, kind=login), sinh `state` riêng (CSPRNG, lưu Redis TTL ngắn, single-use, bind `request_id` + provider + PKCE verifier + nonce + session-binding cookie chống login CSRF) ⇒ redirect provider.
- `GET /auth/{provider}/callback`: consume state (sai/lặp/hết hạn/khác provider ⇒ trang lỗi first-party, không redirect RP), đổi code, lấy identity ⇒ tra `FederatedIdentity(provider, providerId)`: có ⇒ đăng nhập user đó; chưa có + email (verified) chưa thuộc user nào ⇒ tạo User + UserTenant? (tech-lead chốt tenant) + FederatedIdentity; email trùng user local ⇒ dừng an toàn (B5.3). Tạo session (regenerate id, `auth_time`), nối lại `AuthorizeRequestContext` qua `request_id` (resume, xoá context) ⇒ consent/code; `state` của RP echo nguyên vẹn.
- Tôn trọng `prompt=login`/`max_age`/`reauthAfter` (run 26) — đăng nhập social cập nhật `auth_time`.
- Audit login federated (`AUTH_LOGIN_SUCCESS` metadata provider) — không token provider.
- **Acceptance**: int (mock provider): luồng đầy đủ RP → login → provider → callback → consent → code → token, `state` RP nguyên vẹn; state sai/lặp/hết hạn/cross-provider ⇒ từ chối; context hết hạn ⇒ lỗi an toàn; provider trả `error` ⇒ lỗi an toàn; email trùng local ⇒ không link/không tạo user; mutation ⇒ RED.

### [x] Task 3 [BE]: Schema + index FederatedIdentity
- `FederatedIdentity { userId, provider, providerId, email, emailVerified, createdAt, lastLoginAt }` unique `(provider, providerId)` (B2.2 có thể đã có — xác minh), index `userId`; sync-indexes.
- **Acceptance**: `indexes.int-spec` khẳng định index; tạo trùng ⇒ E11000 xử lý an toàn (race 2 callback).

### [x] Task 4 [BE]: UI login — nút social
- Trang login server-side (B2.5) hiện nút Google/GitHub chỉ khi provider bật; link mang `request_id` (không token/secret); CSP `form-action`/redirect cho phép provider host cứng.
- **Acceptance**: int: provider tắt ⇒ không có nút; bật ⇒ có nút đúng URL; CSP không chặn redirect.

## Câu hỏi cho tech-lead
- Q-32.1: Cách mock provider trong test mà vẫn giữ INV-23.
- Q-32.2: Google — verify ID token qua JWKS hay chỉ userinfo.
- Q-32.3: User mới từ social thuộc tenant nào (client.tenantId của context?), trạng thái email verified.
- Q-32.4: Phạm vi có vừa 1 run không.
  - **Trả lời (tech-lead)**: xem `review-techlead.md` và mục Fold dưới.

---

## Fold tech-lead (2026-10-19): BẮT BUỘC, ưu tiên hơn text cũ ở trên

Thứ tự mới: **Task 1 → Task 3 → Task 2 (gồm F10 `amr`) → Task 4**, tất cả backend-dev. Không thêm dependency (dùng `fetch` Node 22 + `jose` sẵn có). Lý do ở `review-techlead.md`.

**Task 1 (provider tĩnh)**
- **F1 — Registry tĩnh + seam test**: `federation/providers.ts` export hằng `GOOGLE`/`GITHUB` (authorize/token/jwks/user/emails URL https cứng, `issuer`, scopes `openid email` / `read:user user:email`). Cung cấp qua DI token `FEDERATION_PROVIDERS` (factory: hằng + `clientId/secret` từ `ConfigService`; chỉ provider có ĐỦ id+secret là `enabled`). Int-test thay bằng `overrideProvider(FEDERATION_PROVIDERS)` trỏ mock `node:http` @ `127.0.0.1` (port ngẫu nhiên). CẤM: provider `mock` trong `src/`, nhánh theo `NODE_ENV`, env/DB/query/header chứa URL provider. Acceptance thêm: test/grep `src/modules/federation` không có `process.env`/`req.query`/body dẫn vào URL fetch (hoặc review tĩnh ghi trong log).
- **F2 — HTTP an toàn**: mọi gọi provider qua 1 helper `fetch` với `AbortSignal.timeout(5000)`, `redirect: 'error'`, `Accept: application/json`; KHÔNG retry đổi code (code single-use, không idempotent). Non-2xx / JSON lỗi / timeout ⇒ `FederationError(<mã cố định>)` ⇒ trang lỗi first-party "provider không khả dụng" (502/503 HTML), không session (fail-closed). `redirect_uri` = `new URL('/auth/<p>/callback', ISSUER).href` (không dùng Host header). GitHub: token endpoint trả 200 kèm `error` trong body ⇒ phải coi là lỗi; header `User-Agent` + `Accept: application/vnd.github+json` cho API; `providerId = String(GET /user .id)` (KHÔNG dùng `login`, đổi được); email = phần tử `/user/emails` có `primary && verified`, không có ⇒ không dùng email.
- **F3 — Google**: verify ID token từ token endpoint bằng `jose.jwtVerify` + `createRemoteJWKSet(<JWKS cứng>, { timeoutDuration: 5000 })` (key set inject qua registry để test dùng `createLocalJWKSet`): `iss ∈ {https://accounts.google.com, accounts.google.com}`, `aud === clientId`, `exp` (clockTolerance 60s), `nonce === state.nonce`, `alg` RS256. `providerId = sub`. Không gọi userinfo. PKCE S256 + `nonce` CSPRNG mỗi leg. Acceptance: sai iss/aud/nonce/chữ ký/hết hạn/thiếu nonce ⇒ từ chối (mỗi case 1 test).
- **F4 — Env**: `GOOGLE_*`/`GITHUB_*` → optional (chuỗi rỗng = chưa đặt); chỉ 1 trong cặp id/secret ⇒ boot FAIL nêu tên biến. `.env.example` để trống 4 biến (bỏ placeholder `your-...`, nếu không bản copy sẽ bật provider với credential rác). Cập nhật `validation.schema.spec`. Acceptance: thiếu cả cặp ⇒ provider tắt + app boot; thiếu 1 nửa ⇒ boot lỗi.

**Task 2 (broker flow)**
- **F5 — `GET /auth/:provider/start?request_id=`**: `:provider` ∈ registry enabled (khác ⇒ 404 HTML). `peek` context: không có / `kind!=='login'` ⇒ trang lỗi "phiên đăng nhập hết hạn" (không redirect). Cookie binding `idp_fed`: đọc, thiếu thì tạo `generateToken()`; `HttpOnly; SameSite=Lax; Secure=<SESSION_COOKIE_SECURE>; Path=/auth/; Max-Age=600` (KHÔNG xoay mỗi leg để 2 tab song song không phá nhau). Sinh `state` (`generateToken`) lưu Redis `fed_state:{sha256(state)}` TTL 600s, `SET NX PX`, giá trị `{provider, requestId, codeVerifier, nonce, bindingHash: sha256(cookie), reauth: boolean, createdAt}`. Rate-limit `RateLimitService.hit({name:'federation'}, {ip, deviceId})` ở cả start + callback. 302 tới provider; `Cache-Control: no-store`.
- **F6 — `GET /auth/:provider/callback`**: (1) consume state ATOMIC single-use (Lua GET+DEL như `authzCtxConsume`) theo `sha256(state)`, TRƯỚC mọi kiểm khác, để state lỗi ở bước sau vẫn chết; (2) thiếu/hết hạn/đã dùng ⇒ lỗi; `record.provider !== :provider` ⇒ lỗi (mix-up); `timingSafeEqual(sha256(cookie idp_fed), bindingHash)` sai/thiếu cookie ⇒ lỗi (login CSRF); Google: query `iss` nếu có phải === issuer Google; (3) query `error` ⇒ trang lỗi có link quay lại `/login?returnTo=/authorize?request_id=...` (context chỉ bị peek nên còn dùng được); (4) đổi code, lấy identity (F2/F3); (5) provisioning (F7); (6) `sessions.establish(cookie idp_session cũ, userId, DEFAULT_TENANT_ID, { amr })` + set cookie session (fixation); (7) audit (F9); (8) 302 tới `/authorize?request_id=<encodeURIComponent(record.requestId)>`. Callback KHÔNG consume `AuthorizeRequestContext`; resume hiện có consume + kiểm `reauthAfter` + consent + code + echo `state` RP. Mọi lỗi ở leg này: trang HTML first-party (`HtmlExceptionFilter`), KHÔNG redirect RP, thông điệp chung không lộ chi tiết. Đích redirect chỉ dựng server-side từ record, không bao giờ từ query.
- **F7 — Provisioning + race + khoá**: `findByProvider(p, id)`:
  - Có FI ⇒ `users.findById`; không có user ⇒ lỗi (fail-closed, KHÔNG tạo lại); `lockedUntil > now` ⇒ từ chối như login local (audit `AUTH_LOGIN_FAILED` reason `locked`); ngược lại cập nhật `lastLoginAt` FI.
  - Không FI ⇒ cần email verified (Google `email_verified===true`, GitHub primary&verified), không có ⇒ trang lỗi "cần email đã xác minh", không tạo gì. `users.findByEmail(email)` có ⇒ **dừng an toàn** (B5.3): không link, không tạo, thông điệp "Đã có tài khoản với email này, hãy đăng nhập bằng mật khẩu", audit `AUTH_LOGIN_FAILED` reason `federated_email_conflict`.
  - Tạo: `users.create({email})` (+ `emailVerifiedAt=now`) → `addMembership(userId, DEFAULT_TENANT_ID)` → `federated.link(...)`. `DuplicateError` ở User (race email/register song song) ⇒ đọc lại FI: có ⇒ dùng user đó; không ⇒ dừng an toàn như trên. `DuplicateError` ở FI (2 callback song song cùng providerId) hoặc lỗi membership ⇒ xoá User+membership VỪA tạo trong request này (thêm `UserService.deleteById` nội bộ, không route), rồi đọc lại FI ⇒ có thì đăng nhập user thắng, không thì lỗi "thử lại". Acceptance: int 2 callback song song cùng `(provider, providerId)` × 10 vòng ⇒ đúng 1 User, 1 FI, 1 membership, không user mồ côi; mỗi callback hoặc có session cùng `userId` hoặc lỗi "thử lại"; mutation bỏ bù trừ ⇒ RED.
- **F8 — Reauth (`reauthAfter`)**: nếu context có `reauthAfter`: Google gửi `max_age=0` và yêu cầu claim `auth_time` (giây) `*1000 >= record.createdAt - 60000`, thiếu/cũ ⇒ từ chối; GitHub (không có cơ chế ép đăng nhập lại) ⇒ start trả trang lỗi và nút GitHub ẩn (DEBT-183). Session mới luôn có `authTime = now` ⇒ resume pass. Acceptance: context `prompt=login` + ID token `auth_time` cũ ⇒ từ chối; GitHub + `prompt=login` ⇒ không có nút, start bị từ chối.
- **F9 — Exposure**: không log `code`, `state`, `codeVerifier`, `nonce`, token/ID token/secret provider, body/`err.message` của response provider; logger chỉ mã lỗi cố định. Audit `AUTH_LOGIN_SUCCESS` + `SESSION_CREATED` như login local, `metadata: { provider, newUser }`, không providerId/email/token. Acceptance: spy logger + đọc audit sau luồng đầy đủ và các luồng lỗi ⇒ không chứa client secret, code, access_token, id_token của mock.
- **F10 — `amr` (đóng DEBT-030)**: `SessionData.amr?: string[]` (`['pwd']` login local; `['fed']` federation, không chép `amr` của provider). `SessionView` → `AuthorizationCodeData.amr` (cả đường mint ở `handle` và consent) → ID token grant `authorization_code`. Session/code cũ thiếu `amr` ⇒ `['pwd']` (trước run 32 chỉ có pwd). Refresh grant: BỎ `amr` khỏi ID token (giống `auth_time`, không bịa; DEBT-185). Acceptance: ID token sau federated login có `amr:['fed']`; local vẫn `['pwd']`; không đọc `amr` từ request.

**Task 3 (schema)**: thu nhỏ. Unique `(provider, providerId)` ĐÃ có (B2.2). Chỉ thêm index `{userId:1}`, `FederatedIdentityService.touchLastLogin(provider, providerId)`; `indexes.int-spec` khẳng định cả 2 index. Race E11000 được test ở F7.

**Task 4 (UI login)**
- **F11**: Nút là `<a href="/auth/<p>/start?request_id=<id>">` (escape bằng Eta), CHỈ render khi provider enabled VÀ `requestIdFromReturnTo(safeReturn)` khác null (không có context ⇒ không nút; không làm luồng social không-RP). GitHub ẩn khi context có `reauthAfter` (F8). `UiModule` import `FederationModule` (export danh sách provider enabled); `FederationModule` không import `UiModule` (provide `HtmlExceptionFilter` cục bộ như Oauth); import `FederationModule` vào `app.module`.
- **F12**: **KHÔNG nới CSP** cho host provider (`<a>` là điều hướng top-level, `form-action` không áp). Acceptance đổi: CSP của `GET /login` có nút giữ nguyên như hiện tại (kỳ vọng DEBT-084 không đổi).

**Chung**
- **F13**: Không gọi mạng thật trong test (mock 127.0.0.1). Acceptance luồng đầy đủ RP → /authorize → /login → start → mock → callback → /authorize resume → consent → code → /token, `state` RP nguyên vẹn, `sub` = User._id local (không phải providerId).
- **F14 — Test âm bắt buộc** (mỗi dòng ≥1 int): state sai / lặp (lần 2) / hết hạn / đúng state nhưng sai route provider / thiếu hoặc sai cookie `idp_fed`; `request_id` không tồn tại hoặc `kind=consent` ở start; provider `error=access_denied`; token endpoint timeout/500 ⇒ không session; user bị admin lock ⇒ không session; email trùng local ⇒ 0 User mới, 0 FI; GitHub email chưa verified/không primary ⇒ không tạo; Google `email_verified=false` ⇒ không tạo; provider không enabled ⇒ 404 start/callback.
- **F15**: Mutation ⇒ RED cho ít nhất: bỏ kiểm binding cookie, bỏ kiểm provider trong record, consume state sau exchange thay vì trước (lặp state), bỏ bù trừ race, bỏ kiểm `lockedUntil`.
- **F16**: Không đụng hạ tầng `aegate-*`; int dùng `vg-test-*` như các run trước.
