# Tasks — Run 18 consent-session-hardening

> Run gia cố, xử lý debt. spec.md + plan.md ĐÃ CÓ → không viết lại; task nào đổi ngữ nghĩa ghi rõ § cần tech-lead/dev cập nhật.
> Nền tảng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (unit 127) + `pnpm test:int` (int 379) = **506** (baseline run 17). Mọi task phải giữ suite xanh và thêm test mới.
> Nhãn: tất cả [BE]. Harness race tất định `gateInsert`/`gateInsertBeforeAndFirstUpdate` đã có sẵn trong `be/test/refresh-token.int-spec.ts` → tái dùng cho task race.

---

### [x] Task 1 [BE]: reset mật khẩu revoke MỌI refresh family của user (DEBT-050, ưu tiên cao)
`AuthenticationService.resetPassword` (`be/src/modules/authentication/authentication.service.ts` L172–187) hiện chỉ gọi `this.sessions.revokeAllForUser(userId)` — KHÔNG revoke refresh family. Refresh token cũ vẫn rotate sau reset; khi tombstone hết (~16'), AT mới active trở lại ⇒ kẻ giữ refresh token truy cập tới 30 ngày sau reset.
- Thay đổi: inject `RefreshTokenService`, gọi `revokeAllForUser(userId, now)` **trước** `sessions.revokeAllForUser` (stamp-first, cùng `now`). `revokeAllForUser` đi qua `revokeWhere({userId})` — cửa revoke duy nhất, INV-11 stamp `familyRevokedAt` trước revoke.
- Acceptance (đo được):
  - Int test mới (`be/test/authentication.int-spec.ts` hoặc `refresh-token.int-spec.ts`): user có refresh family active → `resetPassword(token, newPwd)` → dùng refresh token cũ ở `POST /token grant_type=refresh_token` trả **`400 invalid_grant`**; `RefreshToken` của family có `familyRevokedAt != null`.
  - Int test: sau reset, AT cũ mang `sid` phiên đã huỷ → `/introspect` trả `{active:false}` và vẫn false sau khi tombstone hết (vì family đã revoke, rotate không mint AT mới active).
  - Audit vẫn ghi `AUTH_PASSWORD_RESET` 1 lần; thứ tự: setPassword → revoke refresh → revoke session → audit (fail-closed trước mọi revoke).
  - Suite ≥ 506 + test mới, xanh.
- Security invariants:
  - Tài sản: refresh family + AT của nạn nhân; actor: attacker giữ refresh/AT cũ sau khi nạn nhân reset.
  - Invariant: sau reset, KHÔNG refresh token nào thuộc user còn rotate được (INV-11); không AT nào mang `sid` phiên cũ còn active (INV-28). Credential cũ không tái sử dụng.
  - Trust boundary + state: reset token hợp lệ (one-time, atomic consume §9.5) → setPassword → revoke-all family (stamp-first) → revoke-all session (tombstone) → audit. Request kế: `/token` refresh = `invalid_grant`; `/introspect` = inactive.
  - Failure: `consume` fail / `setPassword` fail ⇒ ném `BadRequestException`, KHÔNG revoke (fail-closed, không lộ tồn tại tài khoản — INV-27). Redis/Mongo lỗi khi revoke ⇒ lỗi propagate (fail-closed), không nuốt.
  - Exposure budget: response/log/audit không chứa token, password hash, danh sách family.
- Phụ thuộc: không (độc lập, làm đầu tiên).
- § spec/plan: INV-11, INV-28, §9.5 (password reset atomic), §9.8 (mọi đường chấm dứt phiên). Ngữ nghĩa KHÔNG đổi (bổ sung đúng theo §9.8) → không cần sửa spec.
- *(tech-lead fold)* — BẮT BUỘC, thay các dòng mâu thuẫn ở trên:
  - **Thứ tự chốt**: `validatePassword` → hash → `consume` → `setPassword` → `refreshTokens.revokeAllForUser(userId, now)` → `sessions.revokeAllForUser(userId)` (MARK) → `refreshTokens.revokeAllForUser(userId, now)` lần 2 (SWEEP, đóng race với `/token` — xem Task 2) → audit. `setPassword` PHẢI trước mọi revoke (nếu revoke trước, kẻ biết mật khẩu cũ login chen giữa ⇒ phiên mới sống sót).
  - **Revoke lỗi** (Mongo/Redis) ⇒ propagate ⇒ reset trả lỗi 5xx (KHÔNG nuốt, KHÔNG báo thành công, KHÔNG rollback mật khẩu — rollback = bật lại mật khẩu có thể đã lộ). Trạng thái sau lỗi: mật khẩu mới có hiệu lực, link đã tiêu; phục hồi = xin link mới hoặc login mật khẩu mới rồi logout toàn cục (revoke idempotent). Thêm unit test: `refreshTokens.revokeAllForUser` reject ⇒ `resetPassword` reject, `sessions.revokeAllForUser` và audit KHÔNG được gọi; `setPassword` reject/consume null ⇒ không revoke nào được gọi.
  - **DI**: `AuthenticationModule.imports` thêm `OauthModule` (đã export `RefreshTokenService`; không vòng vì OauthModule không import Authentication/Ui). Cập nhật mock trong `authentication.service.spec.ts` + `authentication.int-spec.ts` (đang `useValue` cho SessionService) thêm `RefreshTokenService`. Test E2E "refresh cũ ⇒ `invalid_grant`" + "AT cũ inactive" đặt ở `refresh-token.int-spec.ts` (đã có app thật + Mongo/Redis), không ở `authentication.int-spec.ts` (toàn mock).
  - Unit test assert **thứ tự gọi** (revoke family → revoke session → revoke family → audit) bằng `mock.invocationCallOrder`.

---

### [x] Task 2 [BE]: vá TOCTOU `/token` code grant — re-check phiên SAU khi insert family (DEBT-051)
`POST /token` authorization_code (`be/src/modules/oauth/token/token.controller.ts` L169–184) kiểm `sessions.exists(data.sessionRef)` **trước** `issueForAuthorizationCode`. Logout chen vào giữa check và insert ⇒ family mang `sessionRef` đã chết được tạo, sống 30d (TOCTOU, cùng lớp với INV-11 race window).
- Thay đổi (mark-then-check kiểu INV-11): giữ check `exists` trước (fail-fast rẻ), **thêm** re-check sau khi `issueForAuthorizationCode` insert family: nếu phiên đã mất (`!exists` HOẶC `isEnded`) ⇒ revoke ngay family vừa tạo (qua `revokeFamily`/`revokeWhere` stamp-first) **và** trả `invalid_grant`, không trả token. Vị trí re-check: ngay sau khi có `familyId` mới, trước khi `reply.send`.
- Quyết định mở (ghi rõ, đề xuất an toàn): nơi đặt re-check — (A) trong `token.controller` sau khi service trả `familyId`, hoặc (B) đẩy xuống `RefreshTokenService.issueForAuthorizationCode` để atomic cùng insert. **Đề xuất B** (gói trong service: insert → re-read phiên → revoke-nếu-chết trong 1 đơn vị, dễ test tất định, tránh rò `familyId` ra controller). Tech-lead chốt.
- Acceptance (đo được):
  - Int test race tất định (tái dùng `gateInsert` trong `be/test/token.int-spec.ts`/`refresh-token.int-spec.ts`): park A sau khi insert family nhưng trước commit/send → B huỷ phiên (`sessions.revoke`) → release A ⇒ A nhận `400 invalid_grant`, family vừa tạo có `familyRevokedAt != null`, KHÔNG token trả về.
  - Test "phiên còn sống": luồng bình thường vẫn trả `200` + token (không regression).
  - Test fail-closed: Redis lỗi khi re-check ⇒ `500`, family đã tạo được revoke hoặc không có token hữu dụng (không mint grant sống).
  - Suite ≥ (506 + Task1) + test mới, xanh.
- Security invariants:
  - Tài sản: refresh family 30d; actor: attacker có code hợp lệ của phiên vừa logout, đua với logout.
  - Invariant: KHÔNG family nào tồn tại với `sessionRef` trỏ phiên đã chấm dứt (mở rộng INV-29 sang cả race sau-insert). Code single-use vẫn bị tiêu đúng 1 lần.
  - Trust boundary + state: code (đã consume atomic, §9.5/INV-13) → exists? → insert family → re-check exists/isEnded → (chết ⇒ revoke family + invalid_grant / sống ⇒ send). Request kế của attacker với family đã revoke = `invalid_grant`.
  - Failure: malformed/expired code → invalid_grant (đã có). Redis lỗi re-check ⇒ fail-closed (không send token). Race logout↔insert cả hai thứ tự đều hội tụ về revoke.
  - Exposure budget: không lộ `familyId`/`sessionRef`/token trong response hay log.
- Phụ thuộc: độc lập với Task 1; nên làm sau Task 1 để tái dùng pattern revoke.
- § spec/plan: INV-29 (hiện ghi "chỉ check trước") + INV-11 pattern. **Ngữ nghĩa mở rộng → cần cập nhật spec §15 INV-29**: thêm "phiên bị huỷ TRONG race với insert family cũng ⇒ family bị revoke ngay, không chỉ check trước insert". Ghi để tech-lead sửa §15/§9.8.
- *(tech-lead fold)* — BẮT BUỘC, thay phần "Thay đổi"/"Quyết định mở" ở trên:
  - **Chốt (A) controller**, bác (B): `issueForAuthorizationCode` thuộc **`TokenService`** (không phải `RefreshTokenService`); `RefreshTokenService` đã inject `TokenService` ⇒ đẩy revoke xuống `TokenService` gây vòng DI hoặc phá "cửa revoke duy nhất" `revokeWhere` (DEBT-034). `TokenController` đã có sẵn `sessions` + `refresh`.
  - Đổi `TokenService.issueForAuthorizationCode` trả `{ response: TokenResponse; familyId?: string }` (familyId chỉ nội bộ, KHÔNG nằm trong body/log). Controller: `exists` (giữ, fail-fast) → issue → **`exists(data.sessionRef)` lần 2** → nếu `false`: nếu có `familyId` thì `refresh.revokeFamily(familyId, client.clientId, now)` (KHÔNG `revokeForSession` — sẽ giết nhầm family `offline_access` cũ của phiên idle-expire, vi phạm §8 giới hạn (1)), audit `TOKEN_REVOKED` `metadata:{reason:'session_ended', count}` (không token/ref/familyId), ném `invalid_grant`. Re-check chạy cả khi không mint refresh (không trả AT cho phiên đã chết). `isEnded` thừa (tombstone ghi cùng MULTI với DEL) — chỉ dùng `exists`.
  - Redis lỗi ở re-check ⇒ revoke `familyId` best-effort (try/catch nội bộ, nuốt lỗi revoke) rồi **ném lỗi gốc** ⇒ 500, không token. Mongo lỗi ở revoke khi phiên chết ⇒ 500, không token (family có thể còn nhưng giá trị refresh chưa bao giờ rời server ⇒ vô dụng).
  - **SWEEP bắt buộc (đóng race còn lại)**: logout hiện revoke family TRƯỚC revoke session ⇒ interleaving logout-revoke-family → /token insert → /token re-check (phiên còn sống) → logout DEL session ⇒ family sống 30d. Sửa `ui.controller.ts` logout (L252-261): sau `sessions.revoke`/`revokeAllForUser`, gọi lại `revokeForSession`/`revokeAllForUser` (idempotent), cộng dồn `tokenCount`. Reset password: xem fold Task 1. Thu hồi thiết bị (`revokeByDevice`) hiện chưa có caller sản phẩm ⇒ ngoài phạm vi.
  - Acceptance bổ sung: (1) race re-check: gate `insertRefreshToken` (kiểu `gateInsert`, spy trên `TokenService`) → park sau insert → `sessions.revoke` → release ⇒ `400 invalid_grant`, family `revokedAt != null`, `TOKEN_REVOKED` 1 lần; (2) race SWEEP: stub `sessions.revoke` của logout để chạy `/token` trọn vẹn giữa bước revoke family và revoke session ⇒ sau logout family của code đó `revokedAt != null`; (3) idle-expire trong cửa sổ: family `offline_access` cũ cùng `sessionRef` KHÔNG bị revoke; (4) Redis lỗi ở re-check ⇒ 500, body không có token.
  - Spec: áp văn bản §15 INV-29 + §9.8 ở mục "Cập nhật spec" cuối file.

---

### [x] Task 3 [BE]: chốt ngữ nghĩa tombstone cho re-login & absolute-expiry (DEBT-052)
`establish(oldId)` → `revoke(oldId)` → `revokeRef` **ghi tombstone** `sess_end:{ref}`; `get()` khi quá absolute cũng gọi `revokeRef` ⇒ ghi tombstone. Cả hai KHÔNG revoke refresh family theo `sessionRef` ⇒ trạng thái lệch: AT inactive ~16' (tombstone) nhưng refresh family vẫn rotate. Hai đường này KHÔNG phải "chấm dứt phiên chủ động" theo §9.8 (re-login = session fixation rotate; absolute-expiry = hết hạn tự nhiên).
- Quyết định (đề xuất an toàn, tech-lead chốt): **Phương án A — KHÔNG ghi tombstone ở 2 đường này**, để chúng cùng lớp với "hết hạn tự nhiên" (§15 giới hạn (1): idle/absolute KHÔNG làm AT inactive; `offline_access` sống độc lập). Cách làm: tách đường revoke — `revokeRef` công khai (logout/device/reset) vẫn tombstone; thêm đường nội bộ `expireRef`/`revokeRefSilently` (dùng cho `get()` absolute + `establish` oldId) chỉ `DEL sess:{ref}`/`sess_rp` + `srem index`, KHÔNG `SET sess_end`.
  - Lý do bác Phương án B (revoke family theo sessionRef ở 2 đường): re-login/absolute-expiry revoke family sẽ phá `offline_access` (refresh đáng lẽ sống độc lập với phiên trình duyệt) — mâu thuẫn §15 giới hạn (1) và §9.8.
  - Cảnh báo: KHÔNG được để đường `establish` (re-login) làm chết refresh family của phiên cũ — chỉ xoay session cookie. Nếu sản phẩm muốn re-login chấm dứt phiên cũ *hoàn toàn*, đó là quyết định mở riêng → nêu nhưng KHÔNG tự thêm.
- Acceptance (đo được):
  - Int test (`be/test/sessions.int-spec.ts`): sau `establish(oldId)`, `isEnded(oldRef)` == **false** (không tombstone); `exists(oldRef)` == false (session cũ đã xoá).
  - Int test: phiên quá absolute → `get(id)` trả null; `isEnded(ref)` == **false**; AT mang `sid=ref` với family `offline_access` → refresh vẫn rotate `200`, AT mới KHÔNG inactive do tombstone (vì không có tombstone).
  - Int test đối chứng: logout/device-revoke/reset VẪN ghi tombstone (`isEnded` true) — không regression đường chủ động.
  - Suite ≥ (506 + Task1/2) + test mới, xanh.
- Security invariants:
  - Tài sản: refresh family `offline_access`; actor: user hợp lệ re-login hoặc phiên hết hạn tự nhiên (không phải attacker).
  - Invariant: re-login & absolute-expiry KHÔNG làm AT inactive qua tombstone và KHÔNG revoke refresh family (nhất quán §15(1)); đường logout chủ động GIỮ nguyên tombstone (INV-28).
  - Trust boundary + state: re-login: oldRef → DEL (không tombstone) → session mới. Absolute-expiry: deadline<=now → DEL (không tombstone) → null. Request kế: AT cũ theo quy tắc client/aud/user + exp, không bị tombstone chặn.
  - Failure: Redis lỗi khi DEL ⇒ propagate (không nuốt); không bao giờ resurrect phiên (giữ guard `XX`).
  - Exposure budget: N/A ngoài quy tắc chung không log ref/token.
- Phụ thuộc: độc lập; **cần § quyết định trước khi code** — tech-lead chốt Phương án A/B và cập nhật **spec §9.8 + §15(1)** (ghi rõ re-login/absolute-expiry = không tombstone, không revoke family).
- § spec/plan: §9.6 (session fixation), §9.8 (tombstone), §15 giới hạn (1)/INV-17/INV-28.
- *(tech-lead fold)* — **Chốt Phương án A**:
  - Cách làm tối giản: `revokeRef(ref, userId, tombstone = true)` (private, mặc định an toàn); chỉ thêm `revoke(id, { tombstone })` nội bộ cho `establish` (truyền `false`) và nhánh absolute của `get()` (truyền `false`). KHÔNG thêm API public mới (`expireRef`/`revokeRefSilently` không cần). Logout local/global, reset, `revokeByDevice` giữ nguyên tombstone.
  - `prompt=login`/`max_age`/re-login **KHÔNG** chấm dứt AT/refresh cũ (re-auth là chứng minh thêm sự hiện diện, không phải tín hiệu xâm phạm; step-up ở RP A không được phá token RP B). Hệ quả chấp nhận (ghi spec): family của phiên cũ không còn bị local logout của phiên mới chạm tới — chỉ logout toàn cục / reset mật khẩu thu hồi; giống phiên idle-expire.
  - Sửa comment `isEnded`/`revokeRef` trong `session.service.ts` (đang liệt kê "absolute-lifetime expiry" là đường ghi tombstone).
  - Acceptance bổ sung: test hiện có `fixation: establish()` vẫn xanh; test absolute dùng `SESSION_CLOCK` giả (không sleep) để `get()` đi vào nhánh `deadline <= now` thật, assert `isEnded == false` và `sess:{ref}` đã xoá, index `user_sess` không còn ref.
  - Test `offline_access` sau re-login ở int (`session-reflection.int-spec.ts`): family mint từ phiên cũ → login lại (cookie cũ) → refresh `200` và `/introspect` AT mới `active:true`.
  - Spec: áp văn bản §8 (giới hạn 1), §9.8, §14 ở mục "Cập nhật spec".

---

### [x] Task 4 [BE]: `ConsentService.grant` atomic 1 round-trip + bỏ ctx thừa nhánh covered (DEBT-026/027)
`grant` (`be/src/modules/oauth/consent/consent.service.ts` L96–137) đọc `findOne` rồi `findOneAndUpdate` **riêng** ⇒ không atomic: 2 grant đồng thời cùng key có thể mất 1 scope khỏi union (fail-closed: chỉ ép re-consent, không over-grant — nhưng vẫn cần đúng union). DEBT-026: xác nhận nhánh "consent covered" (`authorize.service.ts` L201–208) KHÔNG còn write/consume ctx thừa (đã đi thẳng `issueCode`) — nếu còn thì bỏ.
- Thay đổi:
  - Gộp `grant` thành **1 update-pipeline atomic** (`findOneAndUpdate` với aggregation pipeline `[{ $set: ... }]`): union = `$setUnion` của `grantedScopes` hiện có ∪ `requestedScopes`, **lọc bằng `$setIntersection` với `allowedScopes`** (scope client đã mất không carry-forward). `$setOnInsert` qua pipeline dùng `$ifNull`/cond cho `grantedAt`. Giữ `upsert:true`, unique index collapse 2 grant → 1 doc.
  - Kiểm `authorize.service.ts` nhánh covered: xác nhận KHÔNG tạo `AuthorizeRequestContext` (không cặp write/consume Redis thừa). Nếu phát hiện có → bỏ. (Kết quả rà soát hiện tại: nhánh covered đã gọi thẳng `issueCode`, dường như không có ctx thừa → xác nhận lại bằng test, nếu đúng thì chỉ cần test hồi quy, không sửa code.)
- Acceptance (đo được):
  - Int test concurrency (`be/test/consent.int-spec.ts`): 2 `grant` đồng thời cùng (user,client,resource), mỗi lời gọi 1 scope khác nhau (đều thuộc `allowedScopes`) → sau khi cả hai xong, `grantedScopes` == **union đủ cả 2 scope** (hiện assert chỉ `count==1`); `count==1` vẫn đúng.
  - Int test: scope đã bị gỡ khỏi `allowedScopes` không xuất hiện trong `grantedScopes` sau grant (lọc intersection).
  - Int test: upsert lần đầu set `grantedAt`; grant lần 2 KHÔNG đổi `grantedAt`, có đổi `updatedAt`.
  - DEBT-026: test xác nhận nhánh covered không thực hiện write key ctx Redis thừa (assert không có key `authz_req:*` mới tạo trong luồng covered), hoặc ghi rõ "đã không có → chỉ test hồi quy".
  - Suite ≥ (506 + Task1/2/3) + test mới, xanh.
- Security invariants:
  - Tài sản: bản ghi consent (phạm vi uỷ quyền); actor: user chủ consent; invariant chống over-grant.
  - Invariant: `grantedScopes` ⊆ `allowedScopes` (client hiện tại) tại mọi thời điểm; không grant đồng thời nào làm mất scope đã đồng ý (union đúng) và không bao giờ over-grant (fail-closed). Owner luôn = `session.userId`, không lấy từ input client (INV-24).
  - Trust boundary + state: requestedScopes (đã validate ⊆ client.scopes ở authorize) → pipeline atomic (union ∩ allowed) → doc. Concurrency: 2 ghi cùng key hội tụ 1 doc, union đủ.
  - Failure: Mongo lỗi ⇒ propagate (không nuốt, không auto-approve). Nếu scope không thuộc allowed ⇒ bị lọc (không throw, không over-grant).
  - Exposure budget: không log scope nhạy cảm vượt mức; audit theo chuẩn hiện có.
- Phụ thuộc: độc lập; có thể song song Task 1–3.
- § spec/plan: §9.4 (consent), §9.5 (atomicity — class race check-then-act), INV-24. Ngữ nghĩa KHÔNG đổi (sửa để đúng §9.5) → không cần sửa spec.
- *(tech-lead fold)*:
  - **DEBT-026 đóng bằng test hồi quy, không sửa code**: đã xác nhận `authorize.service.ts:204-210` gọi thẳng `issueCode`; lọc `allowedScopes` đã có (`consent.service.ts:119-120`); version env `z.string().min(1)` (`validation.schema.ts:61-62`). Key ctx thật là **`authz_ctx:*`** (không phải `authz_req:*`). Test: GET `/authorize` với consent covered ⇒ redirect có `code`, `redis.keys('authz_ctx:*')` không tăng.
  - Mongoose 9.10.2 **ném lỗi** với update dạng mảng nếu thiếu option `{ updatePipeline: true }` ⇒ bắt buộc truyền. Pipeline KHÔNG cast: `userId` filter vẫn `new Types.ObjectId`; chuỗi bắt đầu bằng `$` trong pipeline bị hiểu là field path ⇒ **bắt buộc** bọc `{ $literal: requestedScopes }` / `{ $literal: allowedScopes }` (chống field-path injection; test với scope `"$grantedScopes"` không được phép mở rộng grant).
  - Mẫu: `grantedScopes: { $setIntersection: [{ $setUnion: [{ $ifNull: ['$grantedScopes', []] }, { $literal: requested }] }, { $literal: allowed }] }`, `grantedAt: { $ifNull: ['$grantedAt', now] }`, `updatedAt: now`, `revokedAt: null`, versions — tất cả trong 1 `$set`. `$setUnion` không giữ thứ tự/khử trùng ⇒ test so sánh dạng tập (sort).
  - Acceptance race: dùng gate tất định (2 promise bắt đầu cùng lúc + `Promise.all`, lặp ≥20 lần) — chấp nhận vì atomic thật nằm ở Mongo; ngoài ra test E11000 upsert-race: nếu `findOneAndUpdate` upsert ném `11000` thì retry 1 lần (Mongo ≥4.2 thường tự retry upsert theo unique index, nhưng không đảm bảo mọi trường hợp).

---

### [x] Task 5 [BE]: runbook drop index Consent cũ + ghi chú vận hành deploy M3→M4 (DEBT-028)
Schema đã khai unique index `{userId, clientId, resource}` (`be/src/modules/oauth/consent/schemas/consent.schema.ts` L15), nhưng môi trường đã deploy với index cũ `{userId, clientId}` cần **drop** khi deploy. `syncIndexes()` (`be/src/database/mongo/sync-indexes.ts`) drop index thừa + build missing.
- Thay đổi (docs/vận hành, KHÔNG code sản phẩm):
  - Thêm bước runbook deploy: chạy `db:sync-indexes` (gọi `syncAllIndexes`) để `Consent` drop `{userId,clientId}` cũ và build `{userId,clientId,resource}`.
  - Ghi chú rủi ro: trước khi build unique index mới trên dữ liệu cũ có thể có >1 doc trùng `{userId,clientId}` (resource khác) — xác nhận không có duplicate vi phạm unique mới; nếu có, dọn trước. Ghi lệnh kiểm tra duplicate.
  - Nơi ghi: `docs/agile/sso-idp/runs/18-consent-session-hardening/` (ghi chú vận hành) + trỏ vào runbook deploy nếu có.
- Acceptance (đo được):
  - Int test (`be/test/indexes.int-spec.ts`): sau `syncAllIndexes`, index của `Consent` CHỈ gồm `_id_` + `{userId:1,clientId:1,resource:1}` unique; KHÔNG còn `{userId:1,clientId:1}`.
  - Ghi chú vận hành nêu rõ lệnh chạy + lệnh kiểm duplicate trước khi sync.
  - Suite ≥ (506 + task trên) + test mới, xanh.
- Security invariants:
  - Tài sản: tính toàn vẹn consent store; actor: vận hành/deploy.
  - Invariant: unique key consent = `{userId,clientId,resource}`; không tồn tại song song 2 index unique mâu thuẫn làm chặn ghi hợp lệ.
  - Failure: nếu dữ liệu cũ có duplicate ⇒ build unique index FAIL ⇒ fail-closed (deploy dừng), xử lý thủ công theo runbook, KHÔNG tự xoá dữ liệu người dùng.
  - Exposure budget: N/A (thao tác index, không dữ liệu nhạy cảm ra ngoài).
- Phụ thuộc: liên quan Task 4 (cùng Consent) nhưng độc lập về code; làm cuối.
- § spec/plan: §10 (Consent store), §9.4. Ngữ nghĩa KHÔNG đổi.
- *(tech-lead fold)*:
  - Test hiện có (`indexes.int-spec.ts` EXPECTED.Consent) đã assert key mới trên DB trống ⇒ acceptance phải **mô phỏng DB cũ**: trên DB riêng, `createIndex({userId:1,clientId:1},{unique:true})` cho collection consents trước → `syncAllIndexes` → `dropped.Consent` chứa tên index cũ, index còn lại đúng `{userId,clientId,resource}` unique. Thêm case duplicate theo key mới ⇒ sync ném lỗi (fail-closed), không xoá doc.
  - Runbook đặt ở file bền `docs/agile/sso-idp/runbook-deploy.md` (không trong thư mục run): build → kiểm duplicate (aggregate `$group` theo `{userId,clientId,resource}` với `resource` thiếu ⇒ `''`, `count>1`) → `pnpm --filter be db:sync-indexes` → xác minh `getIndexes()`. Ghi rõ: doc cũ không có field `resource` — unique index coi missing là `null` ≠ `''` ⇒ cần backfill `resource:''` (`updateMany({resource:{$exists:false}},{$set:{resource:''}})`) TRƯỚC sync, nếu không lookup `normalizeResource` sẽ không thấy consent cũ (ép re-consent — fail-closed nhưng gây UX). Kèm thêm mục DEBT-049 (`maxmemory-policy noeviction`) cho cùng runbook nếu rẻ.

---

## Quyết định mở (cần người/tech-lead chốt)
1. **Task 2 (DEBT-051)**: đặt re-check-after-insert ở controller (A) hay trong `RefreshTokenService.issueForAuthorizationCode` (B). **Đề xuất B** (atomic, dễ test, không rò `familyId`). Cần cập nhật spec §15 INV-29.
2. **Task 3 (DEBT-052)**: Phương án A (bỏ tombstone ở re-login + absolute-expiry) vs B (revoke family theo sessionRef). **Đề xuất A** (bảo toàn `offline_access`, nhất quán §15(1)). Cần cập nhật spec §9.8 + §15(1). Câu hỏi phụ: re-login có nên chấm dứt phiên cũ hoàn toàn không? (mặc định KHÔNG — chỉ xoay cookie).
3. **DEBT-026**: nhánh covered rà soát ban đầu KHÔNG còn ctx write/consume thừa (đã `issueCode` thẳng). Task 4 chỉ xác nhận bằng test; nếu dev phát hiện còn thừa thì bỏ.

### Đã chốt *(tech-lead fold)*
1. Task 2: **controller** (A) + SWEEP ở logout/reset. Lý do + chi tiết: fold Task 2, `review-techlead.md` Q1.
2. Task 3: **Phương án A**; re-login/`prompt=login`/`max_age` KHÔNG chấm dứt token cũ.
3. DEBT-026: đóng bằng test hồi quy (đã xác nhận không còn code thừa).

## Cập nhật spec.md *(tech-lead fold)* — dev áp nguyên văn trong cùng commit

**§8, đoạn "Giới hạn có chủ đích" (L218)** — thay "(1) phiên **hết hạn tự nhiên** (idle/absolute) KHÔNG làm access token inactive — refresh token `offline_access` sống độc lập với phiên trình duyệt;" bằng:
> (1) phiên **hết hạn tự nhiên** (idle/absolute) hoặc **bị thay khi đăng nhập lại** (re-login, `prompt=login`, `max_age`) KHÔNG ghi tombstone, KHÔNG revoke refresh family và KHÔNG làm access token inactive — refresh token `offline_access` sống độc lập với phiên trình duyệt; family đó chỉ bị thu hồi bởi logout toàn cục, reset mật khẩu, `/revoke` hoặc reuse detection;

**§9.8, thay bullet "Mọi đường chấm dứt phiên …"** bằng:
> - Mọi đường **chấm dứt phiên chủ động** (local/global logout, thu hồi thiết bị, reset mật khẩu) ghi tombstone `sess_end:{ref}` cùng thao tác xoá `sess:{ref}` ⇒ access token mang `sid` đó inactive ngay tại `/introspect`/`/userinfo`. Thứ tự bắt buộc: revoke refresh family → xoá phiên + tombstone → revoke refresh family lần 2 (sweep, idempotent) — để family được `/token` tạo song song không sống sót (§15 inv. 29). Lỗi hạ tầng ở bất kỳ bước nào ⇒ thao tác báo thất bại (5xx), không báo thành công; reset mật khẩu không rollback mật khẩu mới.
> - Phiên **hết hạn tự nhiên** (idle/absolute) và phiên cũ **bị thay khi đăng nhập lại** (session fixation, §9.6) chỉ bị xoá, KHÔNG tombstone, KHÔNG revoke family (§8 giới hạn 1).
> - Reset mật khẩu thu hồi toàn bộ session **và** toàn bộ refresh family của user.

**§14 Session** — thêm vào cuối nhóm:
> · reset mật khẩu ⇒ refresh token cũ `invalid_grant` · re-login/absolute-expiry không làm AT/refresh `offline_access` inactive · logout chen giữa lúc `/token` đổi code ⇒ không family nào sống sót

**§15 inv. 28** — thay bằng:
> 28. Access token mang `sid` của một phiên đã bị **chấm dứt chủ động** (logout, thu hồi thiết bị, reset mật khẩu) phải bị `/introspect` và `/userinfo` coi là không hợp lệ ngay lập tức; phiên hết hạn tự nhiên hoặc bị thay khi đăng nhập lại không thuộc diện này. Lỗi hạ tầng khi kiểm là fail-closed.

**§15 inv. 29** — thay (bỏ nhãn "(Task 3)", một phần DEBT-053) bằng:
> 29. `/token` chỉ đổi authorization code khi phiên `sessionRef` gắn với code còn sống, kiểm **cả trước và sau** khi tạo refresh family; code không mang `sessionRef` hoặc phiên đã kết thúc ⇒ `invalid_grant`, không trả token, và family vừa tạo (nếu có) bị revoke ngay. Kết hợp sweep ở §9.8, không tồn tại refresh family sống gắn với phiên đã bị chấm dứt chủ động.

## Debt KHÔNG nằm trong run này
- DEBT-053 (ponytail/nit spec §11 trùng dòng, nhãn "(Task 3)" INV-29, lambda `isEnded`) — rẻ, có thể gộp nếu còn ngân sách nhưng không bắt buộc trong 5 task; để run kế.
