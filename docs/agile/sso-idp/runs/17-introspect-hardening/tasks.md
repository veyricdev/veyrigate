# Tasks — run 17 — introspect-hardening (DEBT-037/040/041/043/044/045/046)

> Micro-run dọn nợ quanh `/introspect`, `/userinfo`, `/token`, logout. Chỉ task của run này.
> Nhãn: tất cả [BE]. § trỏ spec.md / plan.md / backlog.md.
> Full suite nền (run 16): unit 127 + int 346 = **473**. Mỗi task PHẢI giữ xanh + bổ sung test.

---

### [x] Task 1 [BE]: DEBT-040 + DEBT-041 — authz caller TRƯỚC liveness ở `/introspect`
- **Mô tả**: Trong `introspectAccessToken` (be/src/modules/oauth/introspect/introspect.controller.ts), đảo thứ tự: sau `verifyAccessToken` (JOSE fail → `INACTIVE`), kiểm **authz caller** (`claims.client_id === caller.clientId` HOẶC `caller.allowedResources.includes(claims.aud)`) TRƯỚC khi gọi `isAccessTokenLive`. Caller không được phép → `INACTIVE` mà KHÔNG chạm DB liveness. Sửa comment mô tả thứ tự. Nhánh refresh token (`introspectRefreshToken`) đã đúng (IDOR guard trước liveness) — giữ nguyên, chỉ rà comment.
  - DEBT-041: test `introspect.int-spec` nhánh "aud no longer allowed" hiện dùng caller `RS_CLIENT` → authz cũng false nên không cô lập được nhánh `aud` của liveness. Đổi caller sang `TOKEN_CLIENT` (authz đậu qua `client_id === caller.clientId`) để test THẬT SỰ kiểm nhánh `aud` của `isAccessTokenLive`.
- **Acceptance** (đo được):
  - Caller confidential hợp lệ NHƯNG không phải client của token và không giữ `aud` trong `allowedResources` → response `{active:false}`, và **không** có query `users.exists`/`clients.findByClientId` (chứng minh bằng spy/mock đếm 0 lần gọi, HOẶC test tích hợp với token của user đã bị xoá + caller không-phận-sự vẫn trả `{active:false}` không phụ thuộc user tồn tại).
  - Test DEBT-041: caller = `TOKEN_CLIENT`, token có `aud` không còn trong `allowedResources` của client phát hành → `{active:false}` vì liveness-`aud` false (không phải vì authz). Assert authz-đậu bằng một test đối chứng cùng caller nhưng `aud` hợp lệ → `{active:true}`.
  - Caller là chính client của token hoặc RS giữ `aud` → vẫn `{active:true}` như trước (không hồi quy).
  - Toàn bộ suite xanh (473 + test mới).
  - *(tech-lead fold)* Bằng chứng "không chạm DB" PHẢI dùng spy (phương án "user đã xoá" bị loại: thứ tự cũ cũng trả `active:false`, không phân biệt được). Lưu ý xác thực caller cũng gọi `findByClientId(caller)` → assert **theo đối số**: `findByClientId` KHÔNG được gọi với `claims.client_id` của token, và `users.exists` gọi 0 lần (sau Task 2: lookup tombstone cũng 0 lần).
- **Security invariants**:
  - *Tài sản*: trạng thái sống/chết của token + tín hiệu "user/client còn tồn tại". *Actor*: confidential client không-phận-sự (không phải client token, không giữ `aud`).
  - *Invariant*: caller không-phận-sự KHÔNG được kích DB lookup theo nội dung token người khác (đóng kênh timing "user/client còn tồn tại" + tải DB thừa); với họ mọi token → `{active:false}` đồng dạng.
  - *Trust boundary*: input = token do caller nộp; quyết định authz phải xảy ra TRƯỚC mọi I/O phụ thuộc nội dung token.
  - *Failure*: DB fault trong liveness vẫn fail-closed (500, không `active:true`) — nhưng chỉ xảy ra SAU khi caller đã qua authz.
  - *Exposure budget*: response không lộ lý do (`{active:false}` đồng dạng cho "không sống" và "không phận sự"); token không vào log.
- **Phụ thuộc**: không (làm trước Task 2 để tránh xung đột cùng file).
- **§**: spec §214; plan §introspect; backlog DEBT-040, DEBT-041.

---

### [x] Task 2 [BE]: DEBT-037 — claim `sid` trong access token + introspect/userinfo phản ánh logout/revoke tức thời

> **(tech-lead fold) — BẢN CHỐT, THAY THẾ các điểm mâu thuẫn bên dưới.** Mô tả gốc của analyst giữ lại để truy vết; khi khác nhau, khối này thắng.
>
> 1. **Không kiểm "session còn sống" cho access token** (lý do: refresh family kế thừa `sessionRef`, refresh 30d > idle 8h ⇒ kiểm `sess:{sid}` tồn tại sẽ giết mọi AT mint từ refresh sau khi phiên idle-expire ⇒ phá `offline_access`). Thay bằng **tombstone kết thúc phiên**:
>    - `SessionService.revokeRef` (multi hiện có) thêm `SET sess_end:{ref} 1 PX <accessTokenTtl*1000 + 60000>`; Lua `sessionRevokeAll` thêm `redis.call('SET','sess_end:'..ref,'1','PX',ARGV[1])` trong vòng lặp (truyền TTL qua ARGV). ⇒ phủ MỌI đường chấm dứt: local logout, global logout, `revokeByDevice`, reset password (`revokeAllForUser`), `get()` quá absolute, `establish(oldId)`.
>    - Thêm `SessionService.isEnded(ref): Promise<boolean>` = `EXISTS sess_end:{ref}`; lỗi Redis **propagate** (không nuốt).
>    - Port trong `access-token-liveness.ts`: `SessionEndLookup { isEnded(ref: string): Promise<boolean> }` (đổi tên từ `SessionLookup.alive` của analyst — ngữ nghĩa khác).
>    - `isAccessTokenLive`: sau check `sub` ObjectId, nếu `claims.sid !== undefined`: `sid` không khớp `/^[0-9a-f]{64}$/` ⇒ false (không gọi Redis); `isEnded(sid)` true ⇒ false. Đặt check này TRƯỚC `clients.findByClientId` (Redis rẻ hơn Mongo). `sid` vắng ⇒ bỏ qua (Q-C).
>    - `verifyAccessToken`: nếu `payload.sid !== undefined && typeof payload.sid !== 'string'` ⇒ throw (đồng dạng `jti`). `AccessTokenClaims.sid?: string`.
> 2. **Mint**: `signAccessToken(..., sessionRef?: string)` set `claims.sid` khi có. Nhánh code: `data.sessionRef`. Nhánh refresh: `RotationResult` THÊM `sessionRef?: string` (trả `old.sessionRef ?? undefined` từ `rotate`) → `signTokensForRefresh({..., sessionRef})`. ID token **không** thêm `sid` run này (DEBT-044 hoãn).
> 3. **Lỗi Redis**: `/introspect` → 500 (như DB fault hiện có). `/userinfo` → **500** (không 401: 401 khiến RP coi như token hỏng/đăng xuất, che lỗi hạ tầng). Không bao giờ `active:true`/200.
> 4. **Exposure (sửa)**: `sid` NẰM trong JWT ⇒ RP/RS đọc được — chấp nhận (Q-A). Invariant thay thế: `sid`/`ref` là định danh, **không phải capability**; body `/introspect` vẫn không trả `sid`; không log token. Sửa comment `refresh-token.schema.ts` ("never exposed in token/response") cho đúng.
> 5. **Acceptance bổ sung/thay thế** (int test, Redis+Mongo thật):
>    - (a) AT từ code grant có `sid === sessionRef` lưu trên RefreshToken cùng request; AT sau rotate có cùng `sid`.
>    - (b) Local logout session A ⇒ AT(A) introspect `{active:false}`, userinfo 401; AT(B) cùng user `{active:true}`/200. Global logout ⇒ cả hai inactive. Reset password ⇒ inactive. `revokeByDevice` ⇒ inactive.
>    - (c) **Không hồi quy offline_access**: xoá `sess:{ref}` trực tiếp (mô phỏng idle-expire, KHÔNG qua revoke) ⇒ refresh vẫn rotate được; AT mới (mang `sid` đó) `{active:true}`, userinfo 200.
>    - (d) Logout rồi AT mint từ refresh trước logout (cùng `sid`) ⇒ inactive.
>    - (e) TTL `sess_end:{ref}` ∈ (accessTTL, accessTTL+60s] (đọc `PTTL`).
>    - (f) Token legacy không `sid` ⇒ hành vi cũ (`active:true` nếu client/aud/user còn), kể cả sau logout (khẳng định rõ baseline).
>    - (g) `sid` sai dạng (ký bằng signer test) ⇒ `{active:false}`, Redis không được gọi (spy). `sid` kiểu số ⇒ `{active:false}` (verifier throw).
>    - (h) Redis lỗi trong `isEnded` ⇒ introspect 500, userinfo 500, không `active:true`/200.
>    - (i) Caller không-phận-sự ⇒ `isEnded` 0 lần (nối Task 1).
> 6. **Cập nhật spec.md** trong task này — văn bản chốt ở mục "Cập nhật spec.md (tech-lead fold)" cuối file.
> 7. Lưu ý Cluster: Lua ghi `sess_end:*` không khai báo trong KEYS — cùng loại DEBT-013, không làm tệ hơn; thêm `sess_end` vào mô tả DEBT-013.

- **Mô tả** (analyst, gốc): Đưa claim `sid` (= `sessionRef` của session phát hành, tức `sha256(cookie id)`) vào access token. `/introspect` (access token) và `/userinfo` kiểm session còn sống qua `sid` → một access token thuộc session đã logout/revoke trả `{active:false}` / `401 invalid_token` NGAY (không chờ hết `exp` 15').
  - **Mint**: `signAccessToken` (token.service.ts) nhận thêm `sessionRef?` và set `claims.sid = sessionRef` khi có. Nhánh authorization_code grant đã có `data.sessionRef` (code mang `sessionRef` từ run 16) → truyền xuống. Nhánh refresh grant (`signTokensForRefresh`): lấy `sessionRef` từ RefreshToken đang rotate (doc đã có `sessionRef` từ run 16) → truyền vào input và set `sid`. Token mint TRƯỚC run 16 không có `sessionRef` → `sid` vắng (xử lý ở điểm dưới).
  - **Claims type**: thêm `sid?: string` vào `AccessTokenClaims` (token-verifier.ts).
  - **Liveness**: mở rộng `isAccessTokenLive` (access-token-liveness.ts) + cả hai call site (introspect, userinfo): khi `claims.sid` CÓ → session phải còn sống (`SessionService` đọc `sess:{sid}` trả non-null) mới live; session chết → not live. Khi `sid` VẮNG (token legacy pre-run-16) → **QUYẾT ĐỊNH C** bên dưới (không regress về false). Thêm port `SessionLookup { alive(ref): Promise<boolean> }` để `isAccessTokenLive` không phụ thuộc toàn bộ `SessionService` (cùng kiểu `ClientLookup`/`UserExistence`).
  - **Thứ tự ở introspect**: session-liveness nằm TRONG `isAccessTokenLive`, vẫn chạy SAU authz caller (Task 1) → caller không-phận-sự không kích Redis session lookup.
- **Acceptance** (đo được):
  - Access token mint qua authorization_code grant có scope openid+offline → giải mã thấy claim `sid` = `sha256(cookie id)` của session đó (so khớp với `sessionRef` lưu trên RefreshToken cùng request).
  - Access token sau refresh-rotation vẫn mang `sid` = `sessionRef` của family.
  - Sau **global logout** (xoá `sess:{ref}`): `/introspect` access token cũ (chưa hết `exp`) → `{active:false}`; `/userinfo` → `401 invalid_token`. Trước logout cùng token → `active:true` / 200.
  - Sau **local logout** của đúng session đó → như trên; session KHÁC của cùng user (ref khác) → token của nó vẫn `active:true` (không over-revoke).
  - Token legacy (không `sid`) → hành vi theo Quyết định C (xem dưới): có test khẳng định rõ.
  - Redis session lookup lỗi (down) trong introspect → **500 fail-closed** (không `active:true`); trong userinfo → 401/5xx fail-closed (không 200). Có test.
  - Suite xanh + test mới (đề xuất ≥ 6 int test).
- **Security invariants**:
  - *Tài sản*: khả năng gọi resource bằng access token sau khi phiên đã logout/revoke. *Actor*: attacker giữ access token của session đã bị logout (ví dụ token lộ, hoặc user đã "đăng xuất mọi thiết bị").
  - *Invariant*: access token mang `sid` của session đã chết KHÔNG còn hiệu lực tại `/introspect` + `/userinfo` ngay lập tức (độ trễ 0, không chờ `exp`). Local logout chỉ vô hiệu token của ĐÚNG session đó, không chạm session khác cùng user.
  - *State transition*: `sess:{sid}` tồn tại → logout DEL → request kế tiếp mang cùng access token: introspect `{active:false}` / userinfo 401.
  - *Failure*: Redis session lookup malformed/down → fail-closed (không cấp `active:true`/200). `sid` không phải ref hợp lệ → not live (không coi là lỗi hạ tầng).
  - *Exposure budget*: `sid` KHÔNG được xuất hiện trong body `/introspect` trả về cho RS, trong URL/redirect, log hay audit (nó là định danh phiên nội bộ). Chỉ dùng nội bộ để đối chiếu.
- **QUYẾT ĐỊNH MỞ (đề xuất phương án an toàn)**:
  - **Q-A (sid = gì)**: `sid = sessionRef = sha256(cookie id)`. *Rủi ro*: lộ ra ngoài sẽ tiết lộ định danh phiên nội bộ (dùng để tra `sess_rp`/revoke). **Đề xuất**: dùng `sessionRef` làm `sid` NHƯNG tuyệt đối không đưa `sid` vào response introspect/userinfo. Nếu senior muốn tách bạch, phương án B: `sid` = giá trị ngẫu nhiên riêng lưu cùng session (thêm trường), map `sid→sessionRef`. Mặc định chọn A (rẻ, đã có hạ tầng) + ẩn khỏi mọi output → ghi debt nếu cần tách.
  - **Q-B (session chết ⇒ access token inactive ngay hay chỉ khi logout)**: session "chết" gồm cả hết hạn idle/absolute (TTL Redis), không chỉ logout chủ động. **Đề xuất (an toàn)**: `sid` vắng ở `sess:{sid}` ⇒ not live, bất kể lý do (logout hay TTL). Đây là fail-closed, khớp ngữ nghĩa "token gắn với một phiên sống".
  - **Q-C (token legacy không có sid)**: **Đề xuất A**: `sid` vắng ⇒ GIỮ hành vi cũ (liveness chỉ theo client/aud/user tồn tại) — không regress, không over-block token hợp lệ phát trước run 16. Ghi rõ đây là cửa sổ debt tự đóng khi mọi token cũ hết hạn (≤15'). Nếu senior muốn fail-closed tuyệt đối (sid bắt buộc) → cần migration/thời điểm cutover, ghi debt.
- **Phụ thuộc**: Task 1 (cùng file introspect; thứ tự authz→liveness phải sẵn).
- **§**: spec **§214 (CẦN SỬA HỢP ĐỒNG)** — §214 hiện khẳng định `/introspect` access token "KHÔNG phản ánh revoke refresh-family hay logout"; sau DEBT-037 điều này THAY ĐỔI: introspect + userinfo phản ánh logout/revoke tức thời qua `sid`. Analyst sẽ cập nhật §214 (và dòng §444/§453 nếu cần) khi tech-lead xác nhận phương án Q-A/Q-C; spec §userinfo. plan §introspect/§userinfo. backlog DEBT-037.

---

### [x] Task 3 [BE]: DEBT-043 — logout (local + global) vô hiệu authorization code đã mint trong Redis

> **(tech-lead fold)**:
> - Ở đây (user-present, ≤60s) kiểm **phiên còn sống**: thêm `SessionService.exists(ref): Promise<boolean>` = `EXISTS sess:{ref}` (KHÔNG dùng `get()` — nó trượt idle TTL và cần raw id). Không dùng port tombstone của Task 2. Gọi trong `handleAuthorizationCodeGrant` (token.controller.ts) SAU `consume` + check `resource`, TRƯỚC `issueForAuthorizationCode`. Lỗi Redis propagate → 500, không mint.
> - **Bỏ nhánh "code không `sessionRef` → bỏ qua"**: mọi đường mint code đều set `sessionRef` (`authorize.service.ts:306/327`). Code thiếu `sessionRef` ⇒ `invalid_grant` (fail-closed; chỉ chạm code ≤60s quanh deploy). Đổi `AuthorizationCodeData.sessionRef` thành bắt buộc; sửa fixture test (`token.int-spec.ts`, `authorization-code.int-spec.ts`…) truyền `sessionRef` của session thật/giả lập.
> - Acceptance "Code không mang `sessionRef` → hoạt động như cũ" **thay bằng** "→ `invalid_grant`, không mint, code đã bị consume".
> - Thêm: phiên idle-expire (xoá `sess:{ref}` trực tiếp) trước khi đổi code ⇒ `invalid_grant` (chấp nhận: user phải login lại).
> - Bổ sung spec §15 (văn bản ở cuối file).

- **Mô tả** (analyst, gốc): Sau logout, authorization code đã mint (Redis `authz_code:{sha256(code)}`, TTL 60s) vẫn đổi được thành refresh family mới mang `sessionRef` của session đã chết. Fix (gợi ý backlog, fail-closed tại consume): trong `/token` (authorization_code grant), SAU khi `consume` trả data mang `sessionRef`, kiểm **session còn sống** (`sess:{sessionRef}` tồn tại) TRƯỚC khi mint refresh token. Session chết → từ chối (`invalid_grant`), không mint. Code không có `sessionRef` (public client/pre-run-16) → bỏ qua kiểm (không có phiên để ràng buộc). Dùng cùng port `SessionLookup.alive(ref)` của Task 2.
  - Lựa chọn thay thế (ghi để tech-lead chốt): logout chủ động DEL các `authz_code` của session. **Không đề xuất** vì code key = `sha256(code)`, logout không biết code nào → không enumerate được; kiểm-tại-consume là đúng chỗ và fail-closed.
- **Acceptance** (đo được):
  - Mint code (authorization_code flow) → global logout session đó → `POST /token` đổi code → **`invalid_grant`** (hoặc 400 OAuth error), KHÔNG mint refresh/access token. Kiểm Redis: không có RefreshToken family mới.
  - Local logout đúng session → cùng kết quả cho code của session đó.
  - Code của session còn sống → `/token` vẫn đổi thành công (không hồi quy).
  - Code không mang `sessionRef` → `/token` vẫn hoạt động như cũ.
  - Session lookup down → fail-closed (từ chối mint, 5xx hoặc invalid_grant theo chuẩn hiện có), không mint token. Có test.
  - Suite xanh + test mới.
- **Security invariants**:
  - *Tài sản*: refresh family mới (quyền truy cập dài hạn). *Actor*: attacker giữ authorization code chưa hết 60s của một session vừa logout (code chặn/replay trong cửa sổ TTL).
  - *Invariant*: không được mint refresh/access token gắn `sessionRef` của một session đã chết; cửa sổ ≤60s sau logout bị đóng.
  - *State transition*: code(sessionRef=X) tồn tại → logout DEL `sess:{X}` → `/token` consume → kiểm `sess:{X}` vắng → từ chối; code đã bị `consume` DEL (single-use vẫn giữ: code không tái dùng được dù bị từ chối).
  - *Failure*: session lookup lỗi → fail-closed (không mint). Code mismatch binding vẫn như cũ (INV-13, không DEL nhầm).
  - *Exposure budget*: không lộ `sessionRef`/lý do chi tiết trong response lỗi (`invalid_grant` chung).
  - *Lưu ý race*: consume (Redis Lua, single-use) xảy ra trước kiểm session; nếu logout chen giữa consume và mint → kiểm session (sau consume) bắt được → fail-closed. Thứ tự rõ: consume → check session alive → mint.
- **Phụ thuộc**: Task 2 (dùng chung `SessionLookup.alive`).
- **§**: spec §9.5/§10 (authorization code), §9.8 (logout); plan §token/§logout; backlog DEBT-043.

---

### [x] Task 4 [BE]: DEBT-044 (nếu rẻ sau 037) + DEBT-045 + DEBT-046 — front-channel sid, lint phủ test, nit

> **(tech-lead fold)**: **DEBT-044 HOÃN** — KHÔNG làm trong run này (ID token không thêm `sid`; front-channel đúng chuẩn cần 1 iframe/cặp (client, sid), đổi `clientsForUser` + `frontchannelIframes` — ngoài phạm vi). Task 4 = DEBT-045 + DEBT-046. Không quảng bá `frontchannel_logout_session_supported`. Backlog DEBT-044 đã cập nhật đích.

- **Mô tả** (gộp dọn-nợ rẻ; tách commit logic nếu cần):
  - **DEBT-044** (chỉ làm nếu DEBT-037 đã đưa `sid` vào ID token — KIỂM TRA trước; nếu ID token CHƯA có `sid` thì DEBT-037 chỉ thêm `sid` cho access token → DEBT-044 **HOÃN**, ghi debt, KHÔNG tự mở rộng scope): nếu ID token có `sid`, front-channel iframe `src` (logout.service.ts `frontchannelIframes`) thêm query `sid` = sessionRef; discovery quảng bá `frontchannel_logout_session_supported: true`. Quyết định mở: có đưa `sid` vào ID token không → thuộc DEBT-037; nếu không, 044 hoãn.
  - **DEBT-045**: đổi script `lint` trong be/package.json `eslint src` → `eslint src test`; chạy `--fix`; sửa 2 lỗi prettier (`refresh-token.int-spec.ts:L148`, `ui.int-spec.ts:L882`).
  - **DEBT-046** (net ≈ -5 dòng, không đổi hành vi): gỡ `forwardRef` thừa (ui.module.ts:L1,L10–12 → import trực tiếp); `logout.service.ts:L66` dùng lại `client` từ `verifyHint` thay vì `findByClientId` 2 lần (đổi `verifyHint` trả thêm `client`); xoá early-return thừa (session.service.ts:L245); `defaultRedirect` public → hằng module (logout.service.ts:L34); sửa comment "No length cap" mâu thuẫn `@Length(0,4096)` (ui.controller.ts:L55); sửa lý do cast ObjectId (refresh-token.service.ts:L397); sửa doc `gateInsert` "ANY interleaving" (refresh-token.int-spec.ts:L146).
- **Acceptance** (đo được):
  - `pnpm lint` (nay = `eslint src test`) **exit 0**, 0 lỗi/0 warning.
  - `pnpm typecheck` xanh.
  - Full suite **473 + test mới từ Task 1–3** vẫn xanh (DEBT-046 không đổi hành vi → không test mới ngoài hồi quy).
  - DEBT-044: nếu làm, discovery JSON có `frontchannel_logout_session_supported: true` + test front-channel `src` chứa `sid`; nếu hoãn, ghi rõ trong log.md + backlog cập nhật.
  - Git diff DEBT-046 chỉ chạm các dòng nêu trên, net giảm dòng, không đổi public behavior.
- **Security invariants**:
  - DEBT-045/046: **N/A** (chất lượng/lint/dead-code, không chạm trust boundary) — trừ: KHÔNG được vô tình đổi logic authz khi refactor `verifyHint` (logout.service.ts) → giữ nguyên exact-match redirect + `sub==sessionUserId` guard; có test hồi quy redirect logout.
  - DEBT-044: *Exposure budget* — front-channel `src` chỉ thêm `sid` (sessionRef) + `iss`; KHÔNG token/PII; `sid` ở đây là định danh phiên gửi tới RP đã đăng ký `frontchannelLogoutUri` (allowlist), chấp nhận được theo OIDC Front-Channel Logout. Vẫn lọc ký tự phá CSP như hiện có.
- **Phụ thuộc**: DEBT-044 phụ thuộc Task 2 (ID token `sid`). DEBT-045/046 độc lập — có thể làm song song, nhưng chạy sau Task 1–3 để lint/suite phản ánh code cuối.
- **§**: spec §462 (discovery), §9.8 (front-channel); plan §logout; backlog DEBT-044, DEBT-045, DEBT-046.

---

## Quyết định mở cần tech-lead/senior chốt (tóm tắt)
1. **Q-A** DEBT-037: `sid = sessionRef` (đề xuất) + ẩn khỏi mọi output, hay `sid` riêng không lộ ref nội bộ (phương án B, tốn thêm trường/map). → mặc định A.
2. **Q-B** DEBT-037: session chết (gồm hết TTL idle/absolute) ⇒ access token inactive ngay — đề xuất fail-closed: `sess:{sid}` vắng ⇒ not live.
3. **Q-C** DEBT-037: token legacy không `sid` ⇒ giữ hành vi cũ (đề xuất A, không regress) hay fail-closed tuyệt đối (cần cutover/migration).
4. **DEBT-044**: có đưa `sid` vào ID token không? Nếu không → 044 hoãn (không mở rộng scope run này).

### Chốt (tech-lead fold) — chi tiết lý do trong `review-techlead.md`
1. **Q-A**: `sid = sessionRef`. `sid` LỘ cho RP/RS (nằm trong JWT) — chấp nhận vì băm một chiều, không phải capability. Body `/introspect` không trả `sid`. Không làm phương án B (→ DEBT-047 nếu có pairwise `sub`).
2. **Q-B**: AT inactive ngay khi phiên bị **chấm dứt chủ động** (tombstone `sess_end:{ref}`, TTL accessTTL+60s); phiên **hết hạn tự nhiên** KHÔNG làm AT inactive (giữ `offline_access`). Code grant (Task 3) thì yêu cầu phiên còn sống.
3. **Q-C**: không `sid` ⇒ hành vi cũ. Cửa sổ thật: tới khi family pre-B4.7 hết (≤30d), mỗi AT ≤15' (baseline) — KHÔNG phải "≤15'". Đóng hẳn → DEBT-048.
4. **DEBT-044**: HOÃN.

## Cập nhật spec.md (tech-lead fold) — dev áp dụng ở Task 2 (trừ mục §15-c ở Task 3)

**§8 — ví dụ Access Token**: thêm dòng `"sid": "<sha256 hex 64 ký tự của session id>"` sau `"client_id"`, và thêm 1 gạch đầu dòng vào "Quy tắc bắt buộc":
> - `sid` (khi có) = `sessionRef` = sha256(session id) của phiên IdP đã phát hành grant; AT mint từ refresh mang `sid` của family. `sid` là định danh, không phải credential — không endpoint nào hành động theo `sid` do client gửi mà không kiểm ownership qua phiên đã xác thực.

**§8 — thay TOÀN BỘ đoạn "Quyết định về revocation strategy" (dòng 214) bằng**:
> **Quyết định về revocation strategy** (chốt rõ ràng, không để mở): MVP dùng self-contained JWT access token, ngắn hạn (15 phút), không denylist `jti`. Logout hoặc revoke tác động ngay tới session và refresh-token family. Với access token, **resource server tự verify JWT offline vẫn chấp nhận token tới `exp`** (độ trễ tối đa = TTL access token); resource server cần tín hiệu tức thời phải gọi `/introspect`.
> `/introspect` (access token) và `/userinfo` trả inactive / `401 invalid_token` khi: chữ ký/`iss`/`exp`/`typ` sai; client phát hành không còn hoặc không còn được cấp `aud`; user `sub` không còn; **hoặc phiên `sid` đã bị chấm dứt chủ động** (local/global logout, thu hồi thiết bị, đổi/reset mật khẩu) — hiệu lực ngay, qua tombstone `sess_end:{sid}` sống `TTL access token + 60s`. Caller `/introspect` không phải client của token và không giữ `aud` nhận `{active:false}` **trước** mọi tra cứu phụ thuộc nội dung token.
> Giới hạn có chủ đích: (1) phiên **hết hạn tự nhiên** (idle/absolute) KHÔNG làm access token inactive — refresh token `offline_access` sống độc lập với phiên trình duyệt; (2) access token không có `sid` (family phát hành trước B4.7) chỉ theo quy tắc client/aud/user; (3) mất dữ liệu Redis ⇒ quay về baseline ≤ TTL access token. Lỗi Redis/DB khi kiểm ⇒ 500, không bao giờ `active:true`/200.

**§9.8 — thêm sau khối Local/Global logout**:
> - Mọi đường chấm dứt phiên (local/global logout, thu hồi thiết bị, reset mật khẩu) ghi tombstone `sess_end:{ref}` cùng thao tác xoá `sess:{ref}` ⇒ access token mang `sid` đó inactive ngay tại `/introspect`/`/userinfo`; authorization code đã mint của phiên đó không còn đổi được (§15).
> - Front-channel hiện chỉ gửi `iss` (chưa `sid`, DEBT-044).

**§11 — bảng endpoint**:
> - `/userinfo`: `trả claims theo scope, verify access token qua JWKS + liveness (client/aud/user, phiên sid chưa bị chấm dứt)`
> - `/introspect`: `kiểm tra token real-time (RFC 7662): authz caller trước, rồi liveness (client/aud/user, phiên sid chưa bị chấm dứt; refresh: family còn active)`

**§14 — dòng "Session:"**: thêm `· access token có sid inactive ngay sau logout/revoke phiên tại /introspect & /userinfo · phiên idle-expire không chặn refresh/offline_access · code mint trước logout bị từ chối ở /token`.

**§15 — thêm 2 invariant (28, 29)**:
> 28. Access token mang `sid` của một phiên đã bị chấm dứt chủ động phải bị `/introspect` và `/userinfo` coi là không hợp lệ ngay lập tức; lỗi hạ tầng khi kiểm là fail-closed.
> 29. (Task 3) `/token` chỉ đổi authorization code khi phiên `sessionRef` gắn với code còn sống; code không mang `sessionRef` hoặc phiên đã kết thúc ⇒ `invalid_grant`, không mint token.

Không sửa §12 (discovery) run này.
5. **Spec §214**: DEBT-037 đổi hợp đồng — analyst cập nhật §214 (+ §444/§453 nếu cần) SAU khi Q-A/Q-C chốt. Hiện spec.md/plan.md KHÔNG sửa trong lượt analyst này (chờ xác nhận phương án).