# Tasks — run 16 — B4.7 (Logout: local/global + RP-initiated + front-channel)

> Nguồn: `plan.md` §5 bảng Phase B dòng **B4.7** (L196); spec **§9.8** (L345–356); D4 (L99, `postLogoutRedirectUris[]` exact-match); INV-4 (exact-match redirect, cấm wildcard); INV-11 (`familyRevokedAt` stamp-first mọi đường revoke); INV-17 (session replacement). Phụ thuộc B2.3 (session) + B4.5 (refresh family) — đều ✅.
> Hiện trạng (M2, runs 07/08 — đọc `summary.md`): `GET /logout` đã là form xác nhận (không huỷ); `POST /logout`+CSRF (`CsrfGuard`) đã revoke **session hiện tại** + audit `SESSION_REVOKED` + clear cookie + redirect `/login?loggedOut=1`. **Lỗ hổng cần B4.7**: POST /logout **chưa revoke refresh-token family** (chỉ giết session); chưa có `scope=all`; chưa RP-initiated (`id_token_hint`/`post_logout_redirect_uri`); chưa front-channel.
> Mã liên quan (xác nhận qua CodeGraph): `be/src/modules/ui/ui.controller.ts` (L115 `GET /logout`, L171 `POST /logout`); `be/src/modules/sessions/session.service.ts` (`revoke`, `revokeAllForUser(userId)` qua Lua — SẴN SÀNG cho global session kill); `be/src/modules/oauth/token/refresh-token.service.ts` (`revokeFamily(familyId, clientId, now)` — keyed theo `familyId+clientId`, **CHƯA có revoke theo `userId`**); `refresh-token.schema.ts` (có `userId`, index `{userId:1,clientId:1}` — đủ cho revoke-by-user); `discovery.controller.ts` (L21 cố ý **chưa** quảng bá `end_session_endpoint`); `client.schema.ts` (có `postLogoutRedirectUris[]`).
> Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (94) + `pnpm test:int` (311) = baseline **405**. Mọi task giữ suite xanh + thêm test mới.

---

## Phạm vi DEBT (đánh giá — kéo từ backlog.md)

- **DEBT-034 → TRONG PHẠM VI (BẮT BUỘC, Task 1)**. Global logout revoke theo `userId` là "đường revoke mới" mà nếu ghi `revokedAt` trực tiếp sẽ mở lại race rotate↔revoke (INV-11). Phải tách `revokeWhere(filter)` (stamp `familyRevokedAt` → revoke) làm cửa duy nhất **trước** khi global logout dùng. Blocker của Task 3.
- **DEBT-038 → TRONG PHẠM VI (Task 2)**. Khi `GET /logout` xử lý `id_token_hint`/`post_logout_redirect_uri` (RP-initiated), discovery mới được quảng bá `end_session_endpoint`. Thay đổi nhỏ, gắn liền logic RP-initiated → gộp vào Task 2.
- **DEBT-037 → DỜI (đề xuất run "logout-staleness"/introspect-hardening sau B4.7)**. Thêm claim `sid` vào access token để introspect phản ánh revoke/logout tức thời là thay đổi cross-cutting (token minting + liên kết session↔token + introspect), **không cần** cho tính đúng của logout; chỉ thu hẹp cửa trễ ≤ access TTL 15' (đã chốt chấp nhận ở run 15 OPEN-1 CHỐT-A). Giữ B4.7 ≤5 task → dời. Ghi lại ở STATUS.
- **DEBT-040/041 → DỜI (cùng run introspect-hardening)**. Reorder authz-trước-liveness ở `/introspect` + sửa caller test `aud` là hardening **introspect**, trực giao với logout. Gộp sẽ làm scope creep + rủi ro regress 311 int-test introspect. Dời; đề xuất tech-lead gộp chung DEBT-037/040/041 thành 1 micro-run introspect ngay sau B4.7.

## Quyết định mở (cần tech-lead chốt — đề xuất phương án an toàn)

- **OPEN-1 — Phạm vi revoke của LOCAL logout (`POST /logout`).** spec §9.8: local = "revoke refresh-token **family đang active gắn với phiên này**". Hiện access/refresh token **không mang `sessionId`** nên không map được "family nào thuộc session này". Đề xuất an toàn (fail-closed, không cần DEBT-037): local logout = giết **session hiện tại** (đã có) **+** revoke **mọi refresh family của `userId` tại `client` mà phiên này phát sinh** nếu xác định được client; nếu KHÔNG xác định được client của phiên (UI session không bind client) → **chỉ** giết session (giữ nguyên hành vi M2), KHÔNG đụng refresh token của client khác. Ghi rõ: liên kết session↔family chính xác là DEBT-037. **Cần tech-lead xác nhận** diễn giải "family gắn phiên này" cho MVP.
- **OPEN-2 — `GET /logout` RP-initiated: có `id_token_hint` hợp lệ thì auto-logout hay vẫn cần xác nhận?** spec §9.8: GET "**không** tự huỷ session ngay" (chống CSRF qua `<img>`). Đề xuất: GET luôn render form xác nhận; POST (CSRF) mới huỷ; `post_logout_redirect_uri` chỉ được dùng **sau** khi POST huỷ xong và chỉ khi khớp exact-match whitelist của client suy từ `id_token_hint.aud`. Đây là phương án an toàn (fail-closed). **Cần tech-lead xác nhận** (OIDC cho phép bỏ xác nhận nếu có hint hợp lệ, nhưng ta chọn an toàn hơn).

> **CHỐT tech-lead (2026-10-10)** *(tech-lead fold)* — chi tiết ở `review-techlead.md`:
> - **OPEN-1 → liên kết session↔family khi mint**. KHÔNG revoke theo `{userId, clientId}`: làm vậy giết refresh của thiết bị khác, mâu thuẫn acceptance Task 3. Thêm `RefreshToken.sessionRef` (= `session.ref` = sha256(cookie id)) theo luồng `SessionView.ref` → `AuthorizationCodeData.sessionRef` → `insertRefreshToken({sessionRef})` → `rotate` kế thừa `old.sessionRef`. Local logout = `revokeWhere({userId, sessionRef})`. Không đưa vào token/response (đó là DEBT-037, vẫn dời). Token mint trước B4.7 (thiếu `sessionRef`) không bị local logout đụng (chấp nhận).
> - **OPEN-2 → GET luôn chỉ render form**, kể cả hint hợp lệ. POST **validate lại** hint + URI, không tin hidden field.
> - **DEBT-037/040/041 dời** sang micro-run `introspect-hardening` ngay sau B4.7.
> - **Task 4 = [BE] (backend-dev)**: UI là `be/src/views/*.eta`. Run này không có agent FE.

---

### [x] Task 1 [BE]: DEBT-034 — `revokeWhere(filter)` là cửa duy nhất revoke RefreshToken
- Mô tả: Trong `refresh-token.service.ts` tách lõi revoke thành `private async revokeWhere(filter, now, opts)` thực hiện **đúng thứ tự INV-11**: `updateMany({...filter, familyRevokedAt:null}, {familyRevokedAt:now})` TRƯỚC, rồi `updateMany({...filter, revokedAt:null}, {revokedAt:now})`. `revokeFamily(familyId, clientId, ...)` trở thành wrapper gọi `revokeWhere({familyId, clientId})`. Thêm `revokeAllForUser(userId, now, audit)` gọi `revokeWhere({userId})` (mọi family/mọi client của user) — dùng cho global logout. Giữ nhánh `reuse`/`reuseDetectedAt` + audit hiện có.
- Acceptance:
  - Unit: `revokeFamily` hành vi **không đổi** so với baseline (regress test cũ xanh).
  - Unit/int: `revokeAllForUser(userId)` set `familyRevokedAt` **trước** `revokedAt` trên MỌI token của user, trả về số doc đã revoke; token của user khác **không** bị đụng.
  - Int gate (INV-11 race): test `insertRefreshToken` song song với `revokeAllForUser` — một `rotate` đang mint successor S đồng thời với global revoke → sau cùng **không** descendant nào sống sót (`revokedAt!=null` cho toàn family). Dùng cùng kịch thuật race đã có cho `revokeFamily`.
  - Không còn đường ghi `revokedAt` trực tiếp ngoài `revokeWhere` (grep/CodeGraph: mọi `updateMany(... revokedAt ...)` chỉ nằm trong `revokeWhere`).
  - *(tech-lead fold)* Miễn trừ rõ: swap `findOneAndUpdate` trong `rotate` (đánh dấu token cũ đã thay) và self-revoke successor `updateOne` sau re-read (thao tác trên một token, không phải revoke family). Hai chỗ này giữ nguyên; comment trỏ về INV-11.
  - *(tech-lead fold)* `revokeWhere` nhận filter kiểu union đóng `{familyId, clientId} | {userId} | {userId, sessionRef}`. Runtime assert: thiếu khoá bắt buộc hoặc giá trị rỗng → throw, **không bao giờ** chạy `updateMany` với filter rỗng (unit test âm). `userId` cast sang `ObjectId`.
  - *(tech-lead fold)* Thêm `revokeForSession(userId, sessionRef, now)` = `revokeWhere({userId, sessionRef})`. Int: user có 2 family (sessionRef A, B) → revoke A chỉ đụng family A.
  - *(tech-lead fold)* **Liên kết session↔family (OPEN-1)**: `refresh-token.schema` thêm `sessionRef: String` (không thêm index; prefix `{userId,clientId}` đủ dùng). `SessionView` thêm `ref` (`authorize.controller.liveSession` trả `live.ref`). `AuthorizationCodeData.sessionRef?` được set ở `issueCode`/`issueCodeFromContext`. `TokenService` truyền vào `insertRefreshToken`. `rotate` kế thừa `old.sessionRef`. Int: code → token → refresh → successor đều có `sessionRef` = ref của session đã đăng nhập. `sessionRef` không xuất hiện trong token response/JWT.
- Security invariants:
  - **Tài sản**: refresh-token family (quyền phát hành access token mới). **Actor**: owner (được revoke token của chính mình), user khác (không được đụng — cross-user), attacker (replay/race).
  - **Invariant**: MỌI đường revoke phải stamp `familyRevokedAt` trước `revokedAt` (INV-11) → không descendant sống sót sau revoke, với mọi interleaving, không cần transaction. `revokeWhere({userId})` tuyệt đối ràng buộc `userId` trong filter (không revoke nhầm user khác).
  - **Trust boundary / state**: `active (revokedAt:null)` → stamp family → `revokedAt:now`. Request kế: refresh bằng token thuộc family đã revoke → bị từ chối (reuse detection không đổi).
  - **Failure**: DB fault giữa stamp và revoke → fail-closed (token vẫn ở trạng thái đã-stamp, lần revoke sau idempotent nhờ filter `familyRevokedAt:null`/`revokedAt:null`). Race rotate↔revoke: đã đóng bởi re-read stamp.
  - **Exposure budget**: audit/log KHÔNG chứa token value/hash (giữ quy ước hiện có).
- Phụ thuộc: không (blocker của Task 3).

### [x] Task 2 [BE]: `GET /logout` RP-initiated (hint + exact-match post_logout) + DEBT-038 discovery
- Mô tả: Nâng `GET /logout` (ui.controller) nhận optional `id_token_hint`, `post_logout_redirect_uri`, `state`, `client_id`. Nếu có `id_token_hint`: verify chữ ký + `iss` (chấp nhận cả token đã hết hạn — theo OIDC, vì logout sau khi session cũ chết), suy ra `client` từ `aud`/`azp`. Validate `post_logout_redirect_uri` **exact-match** với `client.postLogoutRedirectUris[]` (cấm wildcard, cùng quy tắc INV-4); không khớp (hoặc không có hint) → bỏ qua redirect, dùng mặc định `/login?loggedOut=1`. **GET vẫn CHỈ render form xác nhận, KHÔNG huỷ session** (spec §9.8 — chống CSRF). ~~Lưu các tham số đã validate vào hidden field của form để POST dùng lại.~~ *(tech-lead fold)* Hidden field chỉ mang giá trị thô (`id_token_hint`, `post_logout_redirect_uri`, `state`, `client_id`). POST tính lại qua **cùng** hàm thuần `resolvePostLogoutRedirect(params, session)`; không có giá trị nào được coi là "đã validate" chỉ vì nằm trong form. **DEBT-038**: discovery.controller thêm `end_session_endpoint: {issuer}/logout` (bỏ comment "cố ý chưa quảng bá" L21).
- Acceptance:
  - **Test GET không huỷ session** (acceptance gốc plan L196): `GET /logout` với session live → response 200 form, session **vẫn còn** (`sessions.get(id)` != null sau đó), refresh family **không** bị revoke.
  - `GET /logout?id_token_hint=<valid>&post_logout_redirect_uri=<exact match>` → form chứa hidden `post_logout_redirect_uri` đã validate.
  - `post_logout_redirect_uri` **không** khớp whitelist → KHÔNG xuất hiện trong form/redirect (fallback mặc định); không có open-redirect.
  - `id_token_hint` chữ ký sai/`iss` sai → bỏ qua (coi như không hint), không 500, không lộ lý do chi tiết.
  - Discovery: `GET /.well-known/openid-configuration` → có `end_session_endpoint == {issuer}/logout`; snapshot test cập nhật.
  - *(tech-lead fold)* **Verify hint**: thêm `TokenVerifier.verifyIdTokenHint(token)`. `verify()` hiện bắt buộc `exp` còn hạn nên không dùng lại được. Hàm mới yêu cầu: RS256, `iss` khớp, chữ ký theo JWKS hiện tại, **chấp nhận `exp` đã qua**, **từ chối header `typ: at+jwt`** (access token giả làm hint), `aud` là chuỗi hoặc mảng 1 phần tử. Client lấy theo `aud` phải tồn tại và active. Có query `client_id` khác `aud` → bỏ hint. Có session live mà `sub` ≠ `session.userId` → bỏ redirect. Mỗi case một test âm; tất cả fallback mặc định, không 500.
  - *(tech-lead fold)* `state`: chỉ echo khi redirect về URI đã validate; > 512 ký tự → bỏ. Redirect build bằng `URL.searchParams` (không nối chuỗi). Không có hint (dù có `client_id`) → bỏ `post_logout_redirect_uri` (chỉ chấp nhận khi có hint, fail-closed).
  - *(tech-lead fold)* `logout.eta` có 2 nút: "Sign out" (POST `/logout`) và "Sign out everywhere" (`formaction="/logout?scope=all"`). Response `Cache-Control: no-store`. Code không tự log `id_token_hint` (logger đã cắt query, `logger.module.ts` L47).
- Security invariants:
  - **Tài sản**: session người dùng + đích redirect sau logout. **Actor**: anonymous/attacker (CSRF qua `<img>`/link ẩn), owner.
  - **Invariant**: GET không bao giờ thực hiện destructive action (không huỷ session) → CSRF-triggered logout bất khả. `post_logout_redirect_uri` chỉ được chấp nhận khi exact-match whitelist client suy từ hint đã verify → chống open-redirect/token-leak qua redirect.
  - **Trust boundary / state**: query params là untrusted → validate (verify hint, exact-match URI) trước khi đưa vào form. Không state transition ở GET.
  - **Failure**: hint hỏng/hết hạn/không verify được → fail-closed (bỏ qua redirect, dùng mặc định); không crash.
  - **Exposure budget**: KHÔNG log `id_token_hint` đầy đủ; KHÔNG đưa `post_logout_redirect_uri` chưa validate vào bất kỳ response/redirect/log.
- Phụ thuộc: không (độc lập Task 1; `client.postLogoutRedirectUris[]` đã có từ D4/B3.1).

### [x] Task 3 [BE]: `POST /logout` — local revoke family + `scope=all` global logout
- Mô tả: Mở rộng `POST /logout` (đã có `CsrfGuard`): (a) **local** (mặc định): giữ revoke session hiện tại + audit; **BỔ SUNG** revoke refresh family gắn phiên này theo OPEN-1 đã chốt. (b) **global** (`?scope=all`): `sessions.revokeAllForUser(userId)` + `refreshTokens.revokeAllForUser(userId)` (Task 1) + audit `SESSION_REVOKED`(+`TOKEN_REVOKED` family) với `scope:'all'`. Sau khi huỷ: nếu có `post_logout_redirect_uri` đã validate (từ Task 2, exact-match) → redirect về đó kèm `state`; ngược lại `/login?loggedOut=1`. Clear session cookie trong mọi nhánh.
- Acceptance:
  - `POST /logout` (local) → session hiện tại chết; refresh family theo OPEN-1 bị revoke (`familyRevokedAt`+`revokedAt`); session/token của thiết bị khác của cùng user **còn sống**.
  - `POST /logout?scope=all` → **mọi** session của user chết (int: tạo 2 session khác cookie → cả 2 `sessions.get` trả null); **mọi** refresh family của user bị revoke; user khác không bị đụng.
  - **CSRF trên POST bị chặn** (acceptance gốc plan L196): POST không kèm CSRF token hợp lệ → 403, session/token **không** đổi.
  - POST idempotent: gọi lần 2 (session đã mất) → vẫn 302, không 500, không double-revoke lỗi.
  - `post_logout_redirect_uri` validated → redirect 302 về đúng URI + `state`; không có → `/login?loggedOut=1`.
  - *(tech-lead fold)* **Open-redirect âm**: POST (CSRF hợp lệ) với `post_logout_redirect_uri` ngoài whitelist, hoặc hint giả/hint của client khác → 302 `/login?loggedOut=1`; `Location` không chứa URI lạ. POST chạy lại `resolvePostLogoutRedirect` (Task 2).
  - *(tech-lead fold)* **Local = theo `sessionRef`**: user có session A (family FA, client X) và session B (family FB, **cùng client X**). Logout từ A → FA revoke, **FB còn sống**, session B còn sống. Không có hint vẫn revoke FA.
  - *(tech-lead fold)* **Thứ tự**: revoke token → revoke session → audit → clear cookie → redirect. Lỗi Mongo/Redis ở bất kỳ bước nào → 5xx (HtmlExceptionFilter), không 302 thành công; gọi lại idempotent (test inject lỗi `revokeWhere` → session vẫn sống, retry thành công). `scope` khác `all` → local (không 400). Global dùng `userId` từ session live; không có session → chỉ clear cookie + redirect, không revoke gì.
  - *(tech-lead fold)* Audit local: `SESSION_REVOKED` + `TOKEN_REVOKED` (`metadata:{scope:'session', count}`, chỉ khi `count>0`). Global: `SESSION_REVOKED` (`scope:'all', count`) + `TOKEN_REVOKED` (`scope:'all', count`). Actor = user. Không có token/hash/hint.
- Security invariants:
  - **Tài sản**: mọi session + mọi refresh family của user. **Actor**: owner (logout chính mình), attacker (CSRF, replay), user khác (không được ảnh hưởng — global chỉ theo `userId` của phiên gọi).
  - **Invariant**: scope global tuyệt đối giới hạn theo `userId` suy từ **session đã xác thực** (KHÔNG tin `userId`/`scope` do body/khách gửi ngoài query `scope=all`); CSRF token bắt buộc cho destructive POST; INV-11 giữ qua `revokeWhere` (Task 1).
  - **Trust boundary / state**: `session live` → POST+CSRF hợp lệ → `session revoked` + `family revoked` + cookie cleared; request kế dùng cookie cũ → anonymous (session null), không resurrect (INV-17 `SET XX`).
  - **Failure**: thứ tự huỷ chốt **fail-closed & idempotent** — nếu revoke token lỗi sau khi session đã chết, retry an toàn (filter idempotent). Redis down khi `revokeAllForUser` → fail-closed (báo lỗi, không coi là logout thành công một phần âm thầm); đề xuất thứ tự **revoke token trước, session sau** để không còn access path nào sống nếu một bước fail.
  - **Exposure budget**: audit chứa `userId`/`sessionRef`/`familyId` (không token value); redirect KHÔNG mang token.
- Phụ thuộc: Task 1 (`revokeAllForUser`), Task 2 (validated `post_logout_redirect_uri`).

### [x] Task 4 [BE]: Front-channel logout — iframe thông báo RP khác *(tech-lead fold: nhãn [BE], backend-dev; UI là `be/src/views/*.eta`)*
- Mô tả: Sau khi POST logout thành công, nếu client (suy từ hint) có `frontchannel_logout_uri` đăng ký (thêm field vào `client.schema.ts` nếu chưa có — exact URI, HTTPS) → render trang trung gian chứa `<iframe src="{frontchannel_logout_uri}?iss={issuer}&sid=...">` cho mỗi RP cần thông báo, rồi auto-redirect về `post_logout_redirect_uri`/mặc định. **Back-channel để P2** (chỉ ghi chú, KHÔNG triển khai — spec §9.8 (4)). Nếu MVP chưa có client nào đăng ký front-channel → task chỉ dựng khung + field schema + test "không có RP front-channel thì bỏ qua iframe".
- Acceptance:
  - Client có `frontchannel_logout_uri` → trang logout render `<iframe>` trỏ đúng URI + query `iss` (+`sid` nếu DEBT-037 có; nếu chưa, bỏ `sid` và ghi chú), CSP cho phép iframe các origin đã đăng ký.
  - Client KHÔNG đăng ký → không render iframe, redirect thẳng.
  - `frontchannel_logout_uri` chỉ nhận HTTPS + exact-match (không wildcard); giá trị lạ bị từ chối lúc đăng ký client.
  - Back-channel: xác nhận **không** có endpoint/logic nào được thêm (kiểm chứng: không route mới `backchannel`); ghi P2 vào spec/log.
  - *(tech-lead fold)* **Chọn RP đúng**: RP cần báo = mọi client **đã nhận code trong phiên**, KHÔNG chỉ client của hint. Redis set `sess_rp:{ref}`: `SADD clientId` khi mint code (cùng chỗ set `sessionRef`), `PEXPIRE` = absolute TTL. Local logout đọc set của session hiện tại; global lấy union qua `listByUser` **trước** khi revoke. `revokeRef`/Lua `revokeAll` xoá thêm `sess_rp:*` (cùng ràng buộc Cluster DEBT-013). Lọc client còn active và có `frontchannelLogoutUri`. Int: login vào RP1 + RP2 (cả hai đăng ký), logout có hint của RP1 → 2 iframe.
  - *(tech-lead fold)* Field `frontchannelLogoutUri` (Client schema + `client.service` create/update DTO) validate bằng `validateRedirectUriList` sẵn có (https, absolute, không fragment, không wildcard). Query `iss` thêm bằng `URL.searchParams`.
  - *(tech-lead fold)* **CSP**: helmet global (`main.ts` L27) chặn iframe ngoài và inline script. Chỉ trang trung gian override header CSP: `frame-src` = danh sách origin (scheme+host+port) tính từ URI đã đăng ký; giữ `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`. Auto-redirect bằng script tĩnh trong `be/src/public` (không inline), timeout ≤ 3s kèm `<noscript>` link. `Cache-Control: no-store`. Test assert header CSP của trang này và trang khác vẫn CSP mặc định.
  - *(tech-lead fold)* Không có RP front-channel → 302 thẳng (không render trang trung gian).
- Security invariants:
  - **Tài sản**: danh sách RP được thông báo + trang trung gian. **Actor**: attacker (bơm iframe tới URI lạ), RP khác.
  - **Invariant**: iframe `src` chỉ từ `frontchannel_logout_uri` đã đăng ký (allowlist), KHÔNG từ input khách; CSP `frame-src`/`default-src` siết theo origin đã đăng ký; không mở iframe tới origin tuỳ ý → chống redirect/clickjacking/SSRF phía browser.
  - **Trust boundary / state**: chỉ chạy **sau** khi session đã huỷ (Task 3). Không huỷ thêm state; chỉ thông báo.
  - **Failure**: RP front-channel không phản hồi/timeout → fail-open phía UX (vẫn hoàn tất logout IdP, iframe lỗi không chặn redirect); logout IdP là nguồn sự thật.
  - **Exposure budget**: query iframe KHÔNG chứa token/`id_token_hint`/PII; chỉ `iss`(+`sid` nếu có).
- Phụ thuộc: Task 2, Task 3. **Lưu ý tech-lead**: nếu MVP chưa có RP front-channel thực, cân nhắc thu hẹp task này thành chỉ schema field + ghi chú P2 (có thể dời phần render iframe) — xác nhận trước khi dev.

### [x] Task 5 [BE]: Audit + integration end-to-end logout (local/global/RP-initiated/CSRF)
- Mô tả: Bổ sung audit action cho `TOKEN_REVOKED` (family) nếu chưa có enum; viết suite integration bao trọn §9.8: local vs global, GET-không-huỷ, CSRF-chặn, RP-initiated redirect exact-match, front-channel iframe render/skip. Cập nhật `end_session_endpoint` snapshot. Giữ baseline 405 xanh + thêm test mới.
- Acceptance:
  - Audit: local logout ghi `SESSION_REVOKED` (1 session); global ghi `SESSION_REVOKED` + `TOKEN_REVOKED` với metadata `scope:'all'`, `userId`, không token value.
  - Suite int mới phủ: (1) GET không huỷ session, (2) POST local revoke đúng phạm vi, (3) POST `scope=all` giết mọi session + revoke mọi family, (4) CSRF thiếu/sai → 403 + không đổi state, (5) `post_logout_redirect_uri` exact-match pass / non-match fallback, (6) front-channel render/skip.
  - `pnpm test` + `pnpm test:int` xanh, tổng > 405 (ghi số mới vào summary).
  - *(tech-lead fold)* Enum `TOKEN_REVOKED`/`SESSION_REVOKED` đã có, **không** thêm enum. Bộ int phủ thêm: (7) open-redirect âm qua POST, (8) local không đụng family cùng client của session khác, (9) hint `typ: at+jwt`/`aud` sai/`sub` lệch session bị bỏ, (10) refresh bằng token đã revoke sau logout → `invalid_grant`, (11) cookie cũ sau logout → GET `/authorize` yêu cầu login lại.
- Security invariants:
  - **Tài sản**: tính toàn vẹn audit trail. **Actor**: auditor/admin đọc log.
  - **Invariant**: mọi logout destructive sinh đúng 1 bộ audit; audit không chứa token/hash/`id_token_hint`.
  - **Exposure budget**: test assert log/response KHÔNG chứa token value, hash, hint đầy đủ.
  - Phần còn lại: N/A (task kiểm chứng, không mở trust boundary mới) — rủi ro đã phủ ở Task 1–4.
- Phụ thuộc: Task 1–4.
