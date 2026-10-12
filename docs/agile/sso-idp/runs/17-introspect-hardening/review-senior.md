# Senior Review — 2026-10-12

## Kết luận: PASS

Không có 🔴. Còn 4 🟡 → `backlog.md` DEBT-050…053.

## Tổng quan (ấn tượng chung + điểm tốt)

- Triển khai đúng bản fold của tech-lead: thứ tự authz → liveness, tombstone `sess_end:{ref}` (không kiểm `sess:{ref}` cho AT ⇒ `offline_access` giữ nguyên), `sid` lan qua cả code path và refresh path (`RotationResult.sessionRef`), `/token` kiểm `EXISTS sess:{ref}` sau consume. Spec §8/§9.8/§11/§14/§15 khớp văn bản đã chốt.
- Port `SessionEndLookup` gọn, đúng kiểu `ClientLookup`/`UserExistence`; regex 64-hex chặn `sid` sai dạng trước Redis; verifier ném khi `sid` không phải string (đồng dạng `jti`).
- Tombstone ghi trong cùng MULTI (`revokeRef`) và trong cùng Lua (`sessionRevokeAll`) với DEL ⇒ không có cửa sổ "session đã xoá nhưng chưa có tombstone".
- Test có giá trị thật: spy theo đối số (`findByClientId` không gọi với `client_id` của token), e2e `session-reflection.int-spec` dùng Redis/Mongo thật.
- **Senior tự xác minh**: typecheck 0, lint (src+test) 0, unit 127/127. Mutation (int suite đầy đủ, khôi phục byte-identical, sha256 khớp):

| Mutation | Kết quả |
|---|---|
| M1 đảo lại liveness trước authz ở `introspectAccessToken` | ❌ bị bắt: 2 test (DEBT-040 spy, DEBT-040+037) |
| M2 bỏ `SET sess_end` trong Lua `sessionRevokeAll` | ❌ bị bắt: 2 test (e2e global logout, sessions tombstone) |
| M3 vô hiệu `sessions.exists` ở `/token` | ❌ bị bắt: 2 test (global logout, idle-expire) |
| M4 `isEnded` nuốt lỗi Redis → `false` | ❌ bị bắt: 1 test (propagate) |
| M5 bỏ `sessionRef` ở `signTokensForRefresh` (refresh path) | ❌ bị bắt: 1 test (e2e (d)) |

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Authz trước I/O phụ thuộc nội dung token** (`introspect.controller.ts:L155-L171`): caller không phận sự → `INACTIVE` trước `isAccessTokenLive`; không gọi `users.exists`, `isEnded` hay `findByClientId(token.client_id)`. M1 chứng minh test sẽ fail nếu đảo lại. Response đồng dạng `{active:false}`. ✅
- **Identity / `sid`**: `sid` không phải string → verifier ném → inactive/401; `sid` sai dạng → false, không gọi Redis; `sid` vắng → hành vi cũ (Q-C, test cả introspect và userinfo). `sid` không có trong body `/introspect`. ✅
- **Mọi đường chấm dứt phiên** (CodeGraph callers): `revokeRef` ← `revoke` (local logout, `establish(oldId)`), `revokeByDevice`, `get()` quá absolute; Lua `sessionRevokeAll` ← global logout, `resetPassword`. Không có đường nào khác ghi/xoá `sess:*` trong `src/`. Mọi đường đều ghi tombstone. ✅
- **TTL**: `accessTokenTtl*1000 + 60_000`, đọc từ cùng config `token` với signer; PTTL ∈ (accessTTL, accessTTL+60s] có test (cả MULTI lẫn Lua). ✅
- **Race tombstone ↔ mint AT**: rotation đang chạy song song với logout → INV-11 (`familyRevokedAt` mark-then-check) ném trước khi trả về, nên không ký AT; AT ký trước tombstone có `exp ≤ t_tombstone + accessTTL` < TTL tombstone. ✅ Race code-grant (exists → insert) xem 🟡 #2.
- **Failure**: lỗi Redis trong `isEnded` → introspect 500 `server_error` không có `active`; userinfo 500 (không phải 401/200); `/token` `exists` lỗi → propagate 500. M4 chứng minh test sẽ fail nếu nuốt lỗi. ✅
- **offline_access**: xoá `sess:{ref}` trực tiếp (idle-expire) → AT vẫn active, userinfo 200 (e2e (c)); session hết hạn tự nhiên không ghi tombstone (test sleep). ✅
- **`/token` EXISTS sau consume**: chỉ ở nhánh `authorization_code`; nhánh refresh không chạm ⇒ không phá offline_access (probe senior: rotate sau idle-expire/sau tombstone đều 200). Thiếu `sessionRef` → `invalid_grant`, code vẫn bị consume (single-use giữ). ✅
- **Exposure**: không log token/`sid`; lỗi `invalid_grant` chung chung, không lộ lý do. ✅
- **DEBT-046 không đổi hành vi**: `verifyHint` trả `client` đã null-check; exact-match `isRegisteredRedirectUri` + guard `sub==sessionUserId` giữ nguyên; bỏ `forwardRef` an toàn (OauthModule không import UiModule, không có vòng); bỏ early-return `clientsForUser` tương đương (`Promise.all([])` → `[]`). ✅

## 🟡 Nên sửa

🟡 **#1 Bảo mật (có từ trước, run này làm lộ rõ): reset mật khẩu không thu hồi refresh family** → DEBT-050
`authentication.service.ts:L179` — `resetPassword` chỉ gọi `sessions.revokeAllForUser`, không gọi `RefreshTokenService.revokeAllForUser`.
Vì sao: probe của senior (Redis/Mongo thật): sau reset, refresh cũ vẫn rotate **200**; AT mới bị inactive chỉ trong lúc tombstone còn sống; sau khi tombstone hết hạn (~16'), rotate tiếp cho AT **active:true / userinfo 200**. Kẻ tấn công đã lấy được refresh token (lý do điển hình khiến user reset) vẫn giữ quyền truy cập 30 ngày. Spec §217/§365 nói reset "chấm dứt phiên" nên RP dễ hiểu nhầm là đã cắt hết quyền. Lỗ hổng này không phải do run này tạo ra (trước đây reset cũng không revoke family), và nằm ngoài phạm vi DEBT của run ⇒ không REJECT.
Đề xuất: trong `resetPassword` gọi `refreshTokens.revokeAllForUser(userId, now)` trước `sessions.revokeAllForUser` (cùng thứ tự với global logout), kèm int test "reset ⇒ refresh cũ `invalid_grant`". Ưu tiên cao, làm ở run kế.

🟡 **#2 Race TOCTOU ở `/token` giữa kiểm `exists` và insert family** → DEBT-051
`token.controller.ts:L179-L185`: `exists(sess)` true → (logout chen vào: `revokeForSession` chưa thấy family, xoá `sess`, ghi tombstone) → `issueForAuthorizationCode` insert family mang `sessionRef` đã chết.
Vì sao: family này sống sót sau logout tới 30 ngày. AT của nó bị tombstone chặn ~16', sau đó rotate cho AT active. Cửa sổ race chỉ cỡ mili-giây và cần kẻ tấn công giữ code, nên rủi ro thấp; nhưng đúng loại bug INV-11 đã xử lý cho rotation.
Đề xuất: mark-then-check như INV-11: sau khi insert family, kiểm lại `exists(sess:{ref})` (hoặc `isEnded`); nếu phiên đã mất thì revoke family vừa tạo và trả `invalid_grant`. Có thể viết test tất định bằng cách gate insert, giống `gateInsert`.

🟡 **#3 Tombstone từ `establish(oldId)` / `get()` quá absolute giết AT của family vẫn còn sống** → DEBT-052
`session.service.ts:L151-L153`, `L166-L168`: re-login (`prompt=login`, `max_age`, step-up) khi phiên cũ còn sống sẽ ghi tombstone cho ref cũ, nhưng refresh family của ref cũ **không** bị revoke.
Vì sao: RP `offline_access` rotate vẫn thành công nhưng nhận AT bị `/introspect`/`/userinfo` từ chối trong ~16'. Đây là trạng thái lệch (grant hợp lệ nhưng token vô dụng), ngược với lý do Q-B ("giữ offline_access"). Tech-lead đã chấp nhận cho nhánh absolute; nhánh `establish` thì chưa phân tích.
Đề xuất: chọn **một** ngữ nghĩa: hoặc (a) `establish`/absolute không ghi tombstone (tách `revokeRef(ref, uid, {tombstone})`), hoặc (b) cùng lúc revoke family theo `sessionRef`. Ghi quyết định vào spec §9.8.

🟡 **#4 Spec §11 còn dòng `/introspect` cũ trùng lặp** → DEBT-053
`spec.md:L460` (`| /introspect | POST | kiểm tra token hợp lệ real-time ... |`) vẫn còn, cùng bảng với dòng mới ở `L451`.
Vì sao: hai định nghĩa trong cùng một bảng hợp đồng; người đọc sẽ không biết dòng nào đúng.
Đề xuất: xoá dòng `L460`.

## 💭 Nit

- `spec.md:L590` — invariant 29 bắt đầu bằng "(Task 3)": nhãn quy trình không nên nằm trong spec, nên bỏ.
- `logout.service.ts:L38` — task yêu cầu đổi thành hằng module, nhưng `defaultRedirect` vẫn là field public (ui.controller dùng) cạnh `DEFAULT_REDIRECT`, nên thành hai nguồn. Chấp nhận được; có thể export hằng và bỏ field.
- Comment ở `introspect.controller.ts`/`userinfo.controller.ts`/`access-token-liveness.ts` lặp cùng một đoạn mô tả `sid` 3 lần. Nên để mô tả ở `isAccessTokenLive`, call site chỉ trỏ tới đó.

## ✂️ Ponytail

- be/src/modules/oauth/introspect/introspect.controller.ts:L170: shrink: `{ isEnded: (ref) => this.sessions.isEnded(ref) }`. Truyền thẳng `this.sessions` (thoả `SessionEndLookup` theo cấu trúc; `isEnded` không dùng `this` ngoài phương thức của chính instance).
- be/src/modules/oauth/userinfo/userinfo.controller.ts:L114: shrink: như trên. Thay bằng `this.sessions`.
- be/src/modules/oauth/introspect/introspect.controller.ts:L161-L165: shrink: comment 5 dòng lặp lại doc của `isAccessTokenLive`. Thay bằng 1 dòng `// Liveness (spec §214) — see isAccessTokenLive; infra fault => 500.`
- be/src/modules/oauth/userinfo/userinfo.controller.ts:L94-L99: shrink: như trên, giữ 2 dòng (401 vs 500).

net: -9 lines possible.
