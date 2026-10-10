# Tasks — run 14 — B4.5 (Refresh grant + rotation + reuse detection + `/revoke`)

> Mốc **M4** (OAuth đầy đủ). Phạm vi: plan.md §5 bảng Phase B dòng **B4.5**, spec **§9.5** (atomic rotation / strict rotation), spec §10 (RefreshToken), §endpoints `/revoke` (spec dòng 451). Invariant: **INV-10, INV-11, INV-12**. Quyết định liên quan: **D7** (refresh chỉ cấp khi client có grant `refresh_token` **VÀ** scope gốc có `offline_access`), **Q4** (grant_type chuẩn hoá), **Q6** (TTL từ env — `refreshTokenTtl` = absolute lifetime). Audit action `TOKEN_REFRESHED` / `TOKEN_REUSE_DETECTED` / `TOKEN_REVOKED` **đã có** trong `audit-action.enum.ts`.
>
> **Ranh giới B4.4 ↔ B4.5 (chốt rõ)**: B4.4 đã **phát hành** access/id/refresh token lần đầu (grant `authorization_code`) và **insert RefreshToken tối thiểu** qua `TokenService.mintRefreshToken` (`tokenHash`, `familyId` mới, `parentId=null`, bind `clientId/scope/resource/userId`, `issuedAt/expiresAt`). `RefreshTokenSchema` (B4.5-ready) **đã tồn tại** đủ field: `parentId`, `revokedAt`, `replacedBy`, `reuseDetectedAt`, `deviceId`, `ip`, `userAgent`, index unique `tokenHash` + index `familyId` + TTL `expiresAt`. B4.5 **thêm**: (1) grant `refresh_token` ở `/token` (dùng refresh lấy token mới); (2) atomic rotation; (3) reuse-detection → revoke family; (4) scope/resource không mở rộng; (5) `POST /revoke`. B4.5 **KHÔNG** sửa `spec.md`/`plan.md`, không đụng grant `authorization_code` (chỉ mở rộng nhánh `grant_type`).
>
> **DEBT kéo vào run (thuộc phạm vi B4.5)**: **DEBT-025** (gộp pattern "custom ioredis command"/duplicate helper — B4.5 là lúc thêm script/helper thứ 3; tối thiểu đánh giá, nếu không gộp thì ghi lại lý do). Lưu ý B4.5 dùng MongoDB `findOneAndUpdate` cho rotation (không cần Lua Redis) nên DEBT-025 chỉ phát sinh nếu cần helper mới — xem Task 1 note.
>
> **❗ Quyết định chưa chốt — chặn một phần Task 4** (`/revoke` theo **thiết bị**): plan/spec nói `/revoke` "theo token/family/**thiết bị**" nhưng **không có nguồn `deviceId` đáng tin tại `/token`/`/revoke`**: luồng `/token` là server-to-server, `AuthorizationCodeData` **không mang** `deviceId`, và `mintRefreshToken` (B4.4) **không** ghi `deviceId/ip/userAgent/parentId`. Cookie `ANON_COOKIE` (rate-limit) **không** có mặt ở call server-to-server. **Đề xuất MVP (fail-safe)**: `/revoke` hỗ trợ **token** (RFC 7009) + **family** (mở rộng); **revoke-theo-thiết-bị HOÃN** sang B4.7/B6 (cần wire `deviceId` từ session vào code→refresh trước). Task 4 chỉ làm token+family; Task 5 ghi debt device-revoke. **→ báo lại tech-lead xác nhận trước khi dev bắt đầu Task 4.**
>
> **✅ CHỐT (tech-lead, 2026-10-10)**: Chấp nhận MVP. `/revoke` = RFC 7009 với refresh token → **revoke cả family** (xem Task 4, không dùng tham số tuỳ biến). Revoke theo thiết bị **hoãn** thành **DEBT-031**. Lý do: (1) mỗi lần `authorization_code` sinh 1 family mới, nên 1 family ≈ 1 lần đăng nhập của 1 client trên 1 thiết bị, revoke family đã bao phần lớn nhu cầu "theo thiết bị"; (2) `deviceId` lấy từ request server-to-server là input client tự khai, không tin được, không thể làm khoá phân quyền; (3) "đăng xuất thiết bị X" là thao tác của user/admin (B4.7 global logout, B6.3 quản trị family), không phải của client qua RFC 7009. Không cần người dùng quyết.
>
> **Thứ tự làm (tech-lead fold)**: Task 2 → Task 1 → Task 3 → Task 4 → Task 5 (Task 1 dùng helper mint của Task 2).

---

### [x] Task 1 [BE]: `RefreshTokenService` — atomic rotation + reuse-detection + revoke family (core, chưa HTTP)
- Mô tả: Tách logic refresh ra service riêng (hoặc method trong `TokenService`) với các primitive thuần MongoDB:
  - `rotate(refreshTokenValue)`: tính `tokenHash = sha256(value)`; **atomic** `RefreshToken.findOneAndUpdate({ tokenHash, revokedAt: null, expiresAt: { $gt: now } }, { $set: { revokedAt: now, replacedBy: <newHash> } }, { new: false })`. `result === null` ⇒ không tìm thấy token active → đi nhánh **reuse/invalid** (xem dưới). `result !== null` ⇒ mint hậu duệ: insert RefreshToken mới cùng `familyId`, `parentId = result._id`, **copy nguyên** `scope`/`resource`/`clientId`/`userId` (INV-12), `issuedAt=now`, `expiresAt` = **giữ nguyên absolute lifetime của family** (`result.expiresAt`, KHÔNG gia hạn — Q6 refreshTokenTtl là absolute).
  - `revokeFamily(familyId, reason)`: `updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now } })` + set `reuseDetectedAt` cho token bị reuse; audit `TOKEN_REUSE_DETECTED` (reason) hoặc `TOKEN_REVOKED`.
  - Nhánh reuse: nếu `tokenHash` tồn tại trong DB nhưng `revokedAt != null` (đã dùng/revoke) ⇒ **reuse** → `revokeFamily(doc.familyId, 'reuse')` + audit `TOKEN_REUSE_DETECTED`. Nếu `tokenHash` **không tồn tại** ⇒ token rác/không hợp lệ → **không** revoke family (không biết family) → trả lỗi grant chuẩn.
  - *(tech-lead fold — bắt buộc)* **Chữ ký `rotate(value, clientId)`**: filter atomic phải là `{ tokenHash, clientId, revokedAt: null, expiresAt: { $gt: now } }` ngay trong Task 1 (Task 3 không cần sửa filter).
  - *(tech-lead fold — bắt buộc)* **`replacedBy` có kiểu `ObjectId`** trong schema, không phải hash. Sinh trước `newId = new Types.ObjectId()` rồi `$set: { replacedBy: newId }`; hậu duệ insert với `_id: newId`. Không được ghi hash vào `replacedBy`.
  - *(tech-lead fold — bắt buộc)* **Khi `findOneAndUpdate` trả `null`**, đọc `findOne({ tokenHash })` rồi phân loại **đúng thứ tự** sau (mọi nhánh lỗi đều ra `invalid_grant`, không phân biệt):
    1. không có doc → invalid, không đổi state;
    2. `doc.clientId !== clientId` → invalid, **không đổi state** (không revoke family của client khác: chống confused-deputy/DoS chéo client);
    3. `doc.revokedAt != null` **và `doc.replacedBy != null`** (đã bị **rotate** rồi) → **reuse** → `revokeFamily` + `reuseDetectedAt` + audit `TOKEN_REUSE_DETECTED`. Nếu `revokedAt != null` nhưng `replacedBy == null` (token đã bị `/revoke` hoặc thuộc family đã bị thu hồi) → chỉ invalid, **không** ghi thêm audit reuse. Như vậy client gọi lại token đã revoke hợp lệ sẽ không gây báo động giả.
    4. còn lại (`revokedAt == null` nhưng đã hết hạn, **hoặc** `resource` không còn trong `client.allowedResources`) → invalid, không revoke family. Hết hạn không phải reuse.
  - *(tech-lead fold — bắt buộc, spec INV-14 dòng 565)* Filter atomic thêm `resource: { $in: client.allowedResources }`. Admin gỡ resource khỏi client thì refresh cũ cho resource đó phải ngừng hoạt động (stale grant). Vì vậy chữ ký thực tế là `rotate(value, client)`.
  - *(tech-lead fold)* Audit metadata chỉ gồm `familyId` và `_id` doc. **Không** ghi `tokenHash`: đây là khoá tra cứu, không cần cho điều tra.
  - *(tech-lead fold — bắt buộc)* **Failure semantics, không dùng transaction**: thứ tự là (a) `findOneAndUpdate` revoke cũ, (b) insert hậu duệ, (c) ký token, (d) audit `TOKEN_REFRESHED`, (e) trả response. Lỗi ở (b)–(d) → 500 và token cũ đã revoke. Client gửi lại → bị coi là reuse → family revoked → user phải login lại. Đây là hành vi fail-closed **chấp nhận được** theo strict rotation. Ghi comment trong code và đưa vào test matrix. Không thêm Mongo transaction (ngoài phạm vi; compose `mongo:7` chưa chắc là replica set).
- Acceptance:
  - Rotation thành công: 1 refresh value hợp lệ → DB có đúng 2 doc cùng `familyId` (cũ `revokedAt` set + `replacedBy`=hash mới; mới `parentId`=\_id cũ), giá trị refresh mới ≠ cũ, `sha256` không trùng.
  - **Concurrent**: 2 request `rotate` đồng thời cùng refresh value → **đúng 1** thành công sinh 1 hậu duệ, request kia nhận `null` từ `findOneAndUpdate` → đi nhánh reuse (assert chỉ 1 doc con `parentId`=\_id gốc tồn tại; không có 2 hậu duệ). (test concurrent — plan B4.5 bắt buộc).
  - Reuse: dùng lại refresh value **đã rotate** → `revokeFamily` chạy, **mọi** doc cùng `familyId` có `revokedAt != null`, audit ghi 1 `TOKEN_REUSE_DETECTED` với `familyId` trong metadata (không log token/hash plaintext dạng giá trị bí mật — chỉ hash/id nội bộ).
  - `expiresAt` hậu duệ === `expiresAt` của token gốc (không sliding, absolute theo Q6) — 1 test so sánh.
  - Token value không tồn tại trong DB → **không** gọi `revokeFamily`, không ghi `TOKEN_REUSE_DETECTED`; trả lỗi để Task 3 map `invalid_grant`.
  - *(tech-lead fold)* Concurrent: sau cuộc đua, **family bị revoke toàn bộ**, kể cả hậu duệ vừa mint (strict rotation: request thua bị coi là reuse). Assert số hậu duệ = 1 **và** mọi doc của family có `revokedAt != null`.
  - *(tech-lead fold)* Hết hạn: doc có `expiresAt <= now` và `revokedAt == null` → invalid, **không** revoke family, không có audit reuse. 1 unit test.
  - *(tech-lead fold)* Sai client: token của A được gọi `rotate(value, 'B')` → invalid, doc A không đổi gì (`revokedAt`, `replacedBy` vẫn null); token **đã revoke** của A gọi với `'B'` → **không** revoke family A. 2 test.
  - *(tech-lead fold)* `replacedBy` của doc cũ === `_id` của hậu duệ (kiểu ObjectId).
  - *(tech-lead fold)* Resource bị gỡ khỏi `client.allowedResources` → invalid, doc không đổi, family không bị revoke. 1 test.
- Security invariants:
  - **Tài sản**: refresh token family (phiên offline của user); **actor**: owner hợp lệ, attacker giữ refresh cũ/đã rò.
  - **Invariant (INV-10)**: rotate atomic, tra cứu **chỉ bằng `tokenHash`** (sha256 giá trị bí mật), **không** bằng `_id`; DB **không** lưu plaintext (giữ nguyên B4.4).
  - **Invariant (INV-11)**: mỗi refresh value dùng được **đúng 1 lần**; reuse → revoke **toàn bộ family** ngay (strict rotation, **không** grace-period retry — spec §9.5 dòng 332).
  - **Failure/abuse**: replay (reuse) → fail-closed revoke family; concurrency → chỉ 1 hậu duệ; token rác → không leak sự tồn tại của family khác (không revoke nhầm). DB down giữa rotate → fail-closed (propagate 5xx ở Task 3, **không** cấp token).
  - **Exposure budget**: giá trị refresh token (plaintext) **không** xuất hiện trong log/audit/metadata/exception message; chỉ `tokenHash`/`familyId`/`_id` nội bộ được ghi.
- Phụ thuộc: Task 2 (helper mint dùng chung) *(tech-lead fold: đảo thứ tự, trước đây ghi phụ thuộc vòng)*; dùng `RefreshTokenSchema` + `AuditService` đã có.
- § liên quan: spec §9.5, §10; INV-10/11/12; plan §12 Q6.

### [x] Task 2 [BE]: Refactor mint — B4.4 `mintRefreshToken` ghi đủ family/device fields; hậu duệ dùng chung đường mint
- Mô tả: Thống nhất đường tạo RefreshToken để B4.4 (lần đầu) và B4.5 (hậu duệ) dùng chung 1 helper. Helper nhận `{ userId, clientId, scope, resource, familyId, parentId, expiresAt, deviceId?, ip?, userAgent? }`. B4.4 gọi với `familyId = new`, `parentId = null`; B4.5 gọi với `familyId/parentId/expiresAt` kế thừa từ token gốc. Ghi `ip`/`userAgent` nếu có sẵn ở request `/token` (best-effort, không bắt buộc cho MVP); `deviceId` để trống (xem quyết định chưa chốt ở header). **Không** đổi hành vi observable của B4.4 (310 test hiện có phải xanh).
- Acceptance:
  - B4.4 flow (grant `authorization_code`) vẫn phát refresh token khi D7 thoả, RefreshToken doc vẫn có `familyId` mới + `parentId=null`; **230 int + 80 unit test B4.4 giữ nguyên xanh** (regression gate).
  - Helper dùng chung: hậu duệ (Task 1) và lần đầu (B4.4) đi qua **cùng** 1 code path mint (grep/đọc xác nhận không còn 2 nơi `refreshTokens.create` tách rời).
  - `expiresAt` lần đầu = `now + refreshTokenTtl` (B4.4 giữ nguyên); hậu duệ = kế thừa (Task 1) — 1 test mỗi nhánh.
- Security invariants:
  - **Invariant**: lần đầu và hậu duệ sinh `tokenHash` từ giá trị ngẫu nhiên đủ entropy (giữ `generateToken()` hiện có), không tái dùng giá trị; `parentId` chuỗi liên kết đúng 1 family.
  - **Exposure**: không log plaintext; `ip`/`userAgent` chỉ lưu DB (đã là field schema), không echo ra token response.
  - N/A trust-boundary mới (chỉ refactor nội bộ) ngoài việc giữ fail-closed của B4.4.
- Phụ thuộc: không — **làm đầu tiên** *(tech-lead fold)*. Helper nhận thêm `_id?` (để Task 1 sinh trước `newId` cho `replacedBy`).
- § liên quan: spec §10; plan B4.4↔B4.5 boundary.

### [x] Task 3 [BE]: `/token` grant `refresh_token` — HTTP handler + scope/resource không mở rộng
- Mô tả: Mở rộng `TokenController.handle` nhánh `grant_type === 'refresh_token'` (hiện chỉ `authorization_code`): parse `refresh_token` (bắt buộc, lặp → `invalid_request`), `scope` (tùy chọn — **chỉ cho phép thu hẹp**), client auth như B4.4 (basic/post/none, >1 method → từ chối; thực hiện **trước** rotation). Kiểm `client.grantTypes` chứa `refresh_token` (nếu không → `unsupported_grant_type`). Gọi `RefreshTokenService.rotate` (Task 1); verify `clientId` của token khớp client đã auth (mismatch → `invalid_grant`, **không** rotate — kiểm trong cùng atomic filter: thêm `clientId` vào filter `findOneAndUpdate`). Phát access token (+ id token nếu `openid`) với **đúng `resource`/`scope` của token gốc**; nếu request gửi `scope` thì phải là **tập con** của scope gốc (vi phạm → `invalid_scope`). Audit `TOKEN_REFRESHED`. Mọi response `no-store`.
- *(tech-lead fold — bắt buộc, khớp code thật)*:
  - **Dispatch grant**: hiện `handle()` ném `unsupported_grant_type` cho mọi `grant_type !== 'authorization_code'` **trước** client auth. Cần đổi thành: `grant_type` thuộc {`authorization_code`,`refresh_token`} → client auth (chung) → nhánh riêng; giá trị khác → `unsupported_grant_type`. Hành vi cũ của B4.4 phải giữ nguyên.
  - **Client không có grant `refresh_token` → `unauthorized_client`**, không phải `unsupported_grant_type` (RFC 6749 §5.2; giống cách B4.4 đang xử lý `authorization_code`). Acceptance bên dưới đã sửa theo.
  - **`invalid_scope` chưa có** trong `TokenErrorCode` (`token.errors.ts`) → thêm vào.
  - **Kiểm scope trước khi rotate**: phép so tập con cần scope gốc, nên dev đọc `findOne({tokenHash, clientId})` (chỉ đọc) để so. Vi phạm → `invalid_scope`, không ghi DB. Rotation atomic vẫn là nguồn sự thật. Nếu doc đổi giữa lúc đọc và lúc rotate, `rotate` trả invalid như thường. Chấp nhận 1 lần đọc thừa. *Cách khác cũng hợp lệ*: rotate trước, sau đó mới so scope trên `result`. Cách này **không được dùng** vì sai scope sẽ làm tiêu mất refresh hợp lệ (cùng tinh thần INV-13).
  - **Nội dung token phát từ refresh** (doc RefreshToken không lưu `nonce`/`authTime`): ID token **không** có `nonce` (OIDC Core §12.2) và **không** có `auth_time`. Access token cho admin resource **không** có `auth_time`, nên step-up B6.2 fail-closed (buộc login lại). Không được bịa `auth_time = now`. `signIdToken` hiện nhận `AuthorizationCodeData`, cần nới chữ ký (chỉ cần `userId`, `nonce?`, `authTime?`). ID token chỉ phát khi **scope hiệu lực** (sau khi thu hẹp) có `openid`.
  - **Luôn phát refresh mới** khi refresh thành công (rotation bắt buộc). Không áp lại D7 lên scope thu hẹp: refresh con giữ scope gốc, nên `offline_access` vẫn còn.
- Acceptance:
  - Happy path: refresh hợp lệ → 200, access token mới `aud`=resource gốc, `scope`=scope gốc, **refresh_token mới** trong body; audit `TOKEN_REFRESHED`.
  - *(tech-lead fold)* Grant `authorization_code` (B4.4) hành vi không đổi sau khi refactor dispatch; `grant_type=password`/rỗng → `unsupported_grant_type`.
  - *(tech-lead fold)* Token phát từ refresh: ID token (nếu `openid`) không có `nonce`/`auth_time`; access token cho admin resource không có `auth_time`. 1 int test giải mã JWT.
  - *(tech-lead fold)* Thu hẹp bỏ `openid` → response **không** có `id_token`.
  - **Leo thang scope bị từ chối** (plan B4.5 bắt buộc): request `scope` chứa scope **ngoài** scope gốc → **400 `invalid_scope`**, **không** rotate (token gốc vẫn active — assert DB). 1 test.
  - Thu hẹp scope: request `scope` ⊂ scope gốc → 200, access token mang đúng scope thu hẹp; **refresh mới vẫn giữ scope gốc** (INV-12: không vĩnh viễn mở/thu — giữ grant gốc). (quyết định: refresh con kế thừa scope **gốc**, access token theo scope request thu hẹp — ghi rõ trong code comment).
  - `resource` **không** nhận từ body ở refresh (bind theo token gốc); nếu body gửi `resource` khác → bỏ qua hoặc `invalid_target` (chốt: **từ chối** `invalid_target` nếu khác token gốc). 1 test.
  - Client mismatch: refresh của client A dùng bởi client B (auth B) → `invalid_grant`, token A **không** bị revoke/rotate (assert DB unchanged). 1 test.
  - Reuse (token đã rotate) → `invalid_grant` + family revoked (Task 1) + audit `TOKEN_REUSE_DETECTED`; response **không** rò lý do chi tiết (chuẩn OAuth `invalid_grant`). 1 int test.
  - `grant_type=refresh_token` nhưng client **không** có grant → **`unauthorized_client`** *(tech-lead sửa từ `unsupported_grant_type`)*, token không bị rotate. Thiếu `refresh_token` param → `invalid_request`.
  - Fail-closed: Mongo/audit/signer lỗi giữa chừng → 500, `no-store`, **không** rò token/secret, **không** phát token một phần. 1 int test.
- Security invariants:
  - **Tài sản/actor**: như Task 1 + client credential; attacker thử dùng refresh của client khác (cross-client), hoặc mở rộng scope/resource.
  - **Invariant (INV-12)**: refresh **không bao giờ** mở rộng `scope`/`resource` vượt grant gốc; chỉ được thu hẹp. `clientId` phải khớp (chống dùng refresh chéo client).
  - **Trust boundary**: input = form body `/token` (server-to-server); client auth **trước** rotation; rotation atomic đã bao binding `clientId`.
  - **State transition**: refresh active → (rotate) → refresh revoked + hậu duệ active + access mới; request kế tiếp dùng refresh cũ → reuse → family revoked.
  - **Failure**: malformed/expired (`expiresAt` qua) → `invalid_grant`; revoked → `invalid_grant` + nếu reuse thì revoke family; dependency down → fail-closed 5xx.
  - **Exposure budget**: không echo `scope`/`resource` sai trong lỗi quá mức; không log refresh plaintext; `invalid_grant` không phân biệt "không tồn tại" vs "đã revoke" (chống enumeration).
- Phụ thuộc: Task 1, Task 2.
- § liên quan: spec §8/§9.3/§9.5, §10; INV-10/11/12; D7.

### [x] Task 4 [BE]: `POST /revoke` — thu hồi theo **token** + **family** (RFC 7009 + mở rộng family)
- Mô tả: Endpoint `POST /revoke` (RFC 7009): client auth (như `/token`; public client → không secret nhưng phải khớp `client_id`), body `token` (refresh token value) [+ optional `token_type_hint`]. Hành vi: tính `tokenHash`, tìm doc; **chỉ client sở hữu** (`clientId` khớp) mới được revoke (IDOR guard). Mặc định RFC 7009: revoke token đó. **Mở rộng family**: tham số `revoke_scope=family` (hoặc tương đương, chốt tên trong code) → `revokeFamily(familyId)`. Audit `TOKEN_REVOKED`. Theo RFC 7009: **luôn trả 200** kể cả token không tồn tại/đã revoke (không leak), trừ lỗi client auth (401 `invalid_client`). **Revoke theo thiết bị KHÔNG làm trong run này** (xem quyết định chưa chốt ở header — Task 5 ghi debt).
- *(tech-lead fold — bắt buộc, thay phần "mở rộng family" ở trên)*:
  - **Bỏ tham số `revoke_scope`**. Revoke 1 refresh token → **revoke cả family** của nó. Đây là hành vi mặc định, RFC 7009 §2.1 cho phép server thu hồi thêm token liên quan. Lý do: chỉ revoke đúng 1 token là vô nghĩa với rotation, vì hậu duệ đang active mới là token client đang giữ. Không có API tuỳ biến cần ghi tài liệu hay test.
  - Filter: `updateMany({ familyId, clientId: client.clientId, revokedAt: null }, { $set: { revokedAt: now } })`. `familyId` lấy từ `findOne({ tokenHash, clientId: client.clientId })`. Bind `clientId` ở **cả hai** câu lệnh. **Không** set `reuseDetectedAt`, **không** set `replacedBy`.
  - `token_type_hint`: chấp nhận rồi **bỏ qua** (RFC 7009 §2.1 cho phép). Không trả `unsupported_token_type`. Access token (JWT) → 200 no-op, vì JWT không revoke được trước `exp` (spec §8 revocation strategy).
  - **Dùng chung** content-type check, `parseForm` và `resolveClientAuth` + `clientAuth.authenticate` với `/token`, không copy. Dev có thể đặt `@Post('/revoke')` trong `TokenController` hoặc tách helper. Lỗi parse/auth render cùng định dạng `TokenError` (`invalid_request` 400, `invalid_client` 401 kèm `WWW-Authenticate` khi dùng Basic). Thiếu `token` → `invalid_request`.
  - Client **không** cần có grant `refresh_token` để revoke. Chỉ cần là owner.
  - Audit `TOKEN_REVOKED` chỉ ghi khi có ≥1 doc thực sự đổi (`modifiedCount > 0`). Metadata `{ familyId, count }`, không có hash/token.
  - Failure: Mongo hoặc audit lỗi → 500 `server_error` + `no-store`. Đây là ngoại lệ có chủ đích so với "luôn 200": client biết revoke **chưa** thành công để thử lại, và lỗi này không lộ thông tin về token.
- Acceptance:
  - `POST /revoke` với refresh value hợp lệ của đúng client → 200; doc có `revokedAt` set; audit `TOKEN_REVOKED`. Dùng lại refresh đó ở `/token` → `invalid_grant`, **không** có audit `TOKEN_REUSE_DETECTED` *(tech-lead fold)*.
  - *(tech-lead fold, thay test `revoke_scope`)* Family có ≥2 thế hệ (đã rotate 1 lần). Revoke bằng **token con đang active** → mọi doc cùng `familyId` có `revokedAt` set (đếm). Revoke bằng **token cha đã rotate** → family cũng bị thu hồi (vẫn 200).
  - *(tech-lead fold)* Gọi `/revoke` 2 lần liên tiếp → cả hai 200, chỉ **1** audit `TOKEN_REVOKED`.
  - *(tech-lead fold)* Body có cả `client_secret` lẫn header Basic → `invalid_request`; thiếu `token` → `invalid_request`; mọi response `no-store`.
  - *(tech-lead fold)* Log/audit không chứa giá trị `token`. Assert bằng spy logger/audit hoặc grep output test.
  - Token của client khác (auth client B, token thuộc client A) → **không** revoke (IDOR), vẫn trả **200** (RFC 7009 không leak) nhưng DB token A unchanged (assert). 1 test.
  - Token không tồn tại / access token (sai type) → **200** no-op, no error (RFC 7009). 1 test.
  - Client auth sai → **401 `invalid_client`** + `no-store`. 1 test.
  - Response `no-store`; body rỗng/`{}` theo RFC 7009.
- Security invariants:
  - **Tài sản/actor**: refresh family của owner; attacker thử revoke token của user/client khác (DoS/IDOR), hoặc dò sự tồn tại token (enumeration).
  - **Invariant**: chỉ client sở hữu token mới revoke được (filter bind `clientId`); revoke là **fail-closed** đối với bảo mật nhưng **không leak tồn tại** (luôn 200 trừ auth fail).
  - **Trust boundary**: form body `/revoke`; client auth bắt buộc trước thao tác ghi.
  - **State transition**: token active → revoked; family (nếu `family`) → mọi member revoked; request `/token` kế tiếp với token đã revoke → `invalid_grant`.
  - **Failure/abuse**: replay revoke = idempotent 200; cross-client revoke bị chặn; enumeration bị chặn (200 đồng nhất); DB down → fail-closed 5xx.
  - **Exposure budget**: không echo token, không phân biệt lý do trong body; không log plaintext.
- Phụ thuộc: Task 1 (`revokeFamily`), Task 2.
- § liên quan: spec §endpoints (`/revoke`, dòng 451), §9.5; INV-11.

### [x] Task 5 [BE]: Test matrix tổng hợp + DEBT + verify toàn suite
- Mô tả: Bổ sung test còn thiếu gom theo invariant (concurrent rotation chỉ 1 hậu duệ; reuse → family revoked; scope escalation từ chối; cross-client guard; `/revoke` idempotent & IDOR). Ghi **DEBT mới** vào `backlog.md`: (a) **DEBT-031** (device-revoke): *tech-lead đã ghi sẵn vào backlog, dev chỉ cần xác nhận*; (b) đánh giá **DEBT-025** (helper dup) — nếu B4.5 không thêm Lua Redis thì ghi "không phát sinh, giữ DEBT-025 nguyên trạng tới B4.6" hoặc gộp nếu có helper mới. Chạy `pnpm -C be typecheck && lint`, `pnpm test` (unit) + `pnpm test:int` (int, hạ tầng `vg-test-mongo@27117` rs0 + `vg-test-redis@6479`).
- Acceptance:
  - Toàn bộ test xanh: unit ≥ 80 (+ mới), int ≥ 230 (+ mới); **tổng ≥ 310 + số test B4.5 thêm**; không regression B4.4.
  - typecheck + lint sạch; không literal TTL hard-code (grep assert — TTL qua config, Q6).
  - `backlog.md` có DEBT-031 (device-revoke) và cập nhật trạng thái DEBT-025.
  - *(tech-lead fold)* Test matrix ghi rõ cả **hệ quả fail-closed**: nếu (b)–(d) của Task 1 lỗi rồi client gửi lại → family bị revoke → client phải login lại. Đây là hành vi đúng, không phải bug.
  - *(tech-lead fold)* Concurrent rotation chạy trên **Mongo thật** (`vg-test-mongo`, int test, `Promise.all` ≥ 2 request HTTP `/token`), không mock model.
  - Test matrix ghi rõ **strict rotation là hành vi đúng** (reuse → re-login), để tester không hiểu nhầm là bug (spec §9.5 dòng 332).
- Security invariants: tổng hợp — mỗi invariant INV-10/11/12 có **≥1 test đo được** (atomic/1-hậu-duệ, reuse→family-revoked, no-escalation). N/A thêm trust boundary mới.
- Phụ thuộc: Task 1–4.
- § liên quan: spec §9.5; INV-10/11/12; backlog DEBT-025.

