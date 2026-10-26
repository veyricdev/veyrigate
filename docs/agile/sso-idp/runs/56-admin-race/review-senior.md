# Senior Review — 2026-10-26 (run 56, diff chưa commit so với HEAD `095a15c`)

## Kết luận: PASS

Không còn 🔴. Hai 🟡 nhỏ đưa vào backlog (DEBT-418, DEBT-419).

## Tổng quan

Preflight: codegraph 1.6.2, `status` OK, `sync` OK (index do v1.5.0 build). Đã đọc toàn bộ diff `be/src`, các test int mới hoặc đổi kỳ vọng (admin-api, admin-users, token-code-recheck, authorize, introspect, userinfo), docs spec/security-matrix/runbook/backlog. Chạy lại: be `typecheck` OK, `eslint src test` OK, unit **589/589**. Không chạy int hay E2E vì log dev đã có int 1332/1332, E2E 35/35, mutation 13/13 RED, và mọi điểm review đều trả lời được bằng đọc code.

Điểm tốt:
- Cả ba kỹ thuật đều theo đúng fold, không dùng transaction hay index mới. Cụ thể: điều kiện mức nằm trong filter ghi (`tenantAdminMayChangeLock`), audit tính từ `returnDocument:'before'`, secret áp dụng ghi rồi đọc lại, và epoch disable ghi cùng câu stamp.
- `mintedBeforeDisable` là một hàm thuần duy nhất, dùng ở 5 điểm. Unit test ghim đúng biên `<= lastDisabledAt + 5000`.
- Test race đều dùng barrier thật (spy + promise), không dựa vào timing.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

**I1. tenant_admin không nhận plaintext của secret còn sống trên client admin-capable (T3).**
- `admin-clients.controller.ts:309`: `recheckIssued` chạy sau `rotateSecret` và trước audit/return. Mọi nhánh từ chối đều `revokeSecret` rồi mới `throw`. Nếu revoke lỗi thì lỗi propagate (5xx), không bao giờ tới dòng `return {clientSecret}`.
- Thứ tự phía grant (`client.service.ts` updateForTenant) là revoke#1 → `findOneAndUpdate` → revoke#2 (khi `adminGranted`). Lần đọc lại thấy chưa admin ⇒ insert diễn ra trước update ⇒ bị revoke#2. Lý lẽ đúng.
- Lần đọc lại lỗi ⇒ `refused = err` ⇒ revoke, sau đó `toAdminError` trả nguyên lỗi (5xx). Audit failure chỉ ghi ở nhánh `ForbiddenClientConfigError` và là best-effort, không che lỗi gốc. Audit không chứa secret, chỉ `metadata.version`.

**I2. Khoá do super_admin đặt (hoặc sentinel cũ không mức) chỉ super_admin mở được (T2).**
- `user.service.ts:66-68`: filter `$or:[{lockedUntil:{$ne:SENTINEL}}, {adminLockLevel:'tenant_admin'}]` nằm trong chính câu ghi, cả lock lẫn unlock.
- Sentinel không có mức thì không khớp nhánh thứ hai, nên được coi là super (fail-closed).
- Khoá brute-force (`lockedUntil` nhỏ hơn sentinel) khớp `$ne`, nên tenant_admin vẫn mở được như trước.
- tenant_admin lock một user đang super-lock ⇒ miss ⇒ trả `current` mà không hạ mức.
- `recordFailedLogin` không ghi đè sentinel (`$gt lockedUntil now`), `setPassword` và `clearFailedLoginsIfUnlocked` không xoá sentinel.

**I3. Mỗi lần unlock thật có đúng 1 audit success.**
- `adminUnlock` là một `findOneAndUpdate` với `returnDocument:'before'`. Controller (`admin-users.controller.ts:210-216`) audit khi và chỉ khi `before.lockedUntil != null || before.failedLoginCount > 0`. Vì vậy K unlock song song chỉ có 1 cái thấy trạng thái khoá.
- Unlock chạy song song với lock: unlock ghi sau thì thấy `before` đang khoá, nên có audit success nằm sau `LOCKED`.
- Nhánh `'forbidden'` audit failure. Audit này không best-effort: nếu ghi lỗi thì trả 5xx thay vì 403, vẫn là fail-closed.

**I4. Không code/AT/context nào tạo tại `t <= lastDisabledAt + margin` còn dùng được sau enable (T1).**
- *Code*: `issuedAt` do `create` tự đặt (kiểu `Omit` chặn người gọi truyền vào). Thiếu `issuedAt` ⇒ 0 (fail-closed khi client có epoch).
- *`/token`*: cổng thuần trước ký dùng `client` lúc auth. `recheckCodeGrant` dùng `fresh` sau insert, nên phủ cả disable+enable chen giữa (test b/c).
- *AT*: `isAccessTokenLive` so `claims.iat*1000`. `iat` nằm trong `requiredClaims` của verifier (`token-verifier.ts:112`), tức là đã qua kiểm chữ ký, nên tin được. Một helper phủ cả 4 nơi: `/introspect`, `/userinfo`, demo, `AdminTokenGuard`. `findByClientId` trả `.lean()` nguyên document nên có `lastDisabledAt`.
- *Context*: `trustedClient` so `ctx.createdAt`. Giá trị này do server đặt ở `authorize-request-context.service.ts:91`, không lấy từ input.
- *Epoch*: `lastDisabledAt` chỉ được ghi trong câu stamp có filter `disabledAt:null`. Disable lặp lại không đổi epoch (test g). Ngoài chỗ này không có writer nào khác của `disabledAt` (đã grep).

**Run 54 (ký trước khi commit) vẫn giữ.**
- Thứ tự vẫn là peek → gate (thuần) → ký → consume (Lua, raw so nguyên văn) → kiểm → insert → recheck. Không I/O mới trước khi ký, Lua/peek/consume không đổi.
- Refusal mới ngay sau `consume` (`token.controller.ts:233-237`) dùng **cùng** `client` và cùng `data`, mà `data` byte-identical với `peeked` vì `consume` so `raw`. Vì vậy nó chỉ kích hoạt khi cổng đã từ chối, tức `signed === undefined`: **không có token đã ký nào bị bỏ, trả về hay ghi log**.
- Refusal này cần thiết: thiếu nó thì `issueForAuthorizationCode` sẽ tự ký với `signed` undefined. Code đã bị consume nên bị đốt đúng, và `refuseGrant` ghi đúng 1 `TOKEN_ISSUED failure client_disabled`, không có family.

**Run 55 (consent gắn session) vẫn giữ.** `decideConsent` vẫn gọi `trustedClient` trước mọi nhánh, sau đó mới tới kiểm `kind` rồi `sessionRef`. Chỉ thêm điều kiện, không đổi thứ tự.

**Exposure.**
- 403 dùng `AdminAuthError.forbidden()` với thông điệp cố định.
- Audit chỉ chứa reason, version hoặc level.
- Các trang first-party (null) không redirect, không lộ `state`.

**Failure.**
- Đọc client lỗi trong liveness ⇒ propagate (không trả `active:true`).
- Recheck lỗi ⇒ `failClosed` sẵn có.
- `adminLock`/`adminUnlock` lỗi Mongo ⇒ 5xx trước khi revoke hay audit.

## Trả lời các câu dev đề nghị soi

1. **3 kỳ vọng admin-api bị đổi: đúng là chúng ghim hành vi debt.**
   - "enable ⇒ AT `/introspect` active lại" và "enable ⇒ admin token 200 lại" chính là DEBT-209/156 mà I4 cấm.
   - Kỳ vọng thứ ba (code mới sau enable) chỉ lùi `lastDisabledAt` 60 s để vượt biên. Test không bị nới, mà vẫn kiểm client không bị "brick".
   - `authorization-code.int-spec` thêm `issuedAt` vào payload là hệ quả cơ học.
2. **`resume` gọi `trustedClient` cho mọi nhánh: đúng và đủ.**
   - Trước đây nhánh thường đi `handle()` có đọc lại client và redirect URI, nhưng không có epoch, nên context tạo trước disable rồi resume sau enable vẫn mint được code. Đây chính là lỗ I4 mà fold yêu cầu bịt.
   - Không phá luồng hợp lệ nào:
     - Client chưa từng disable ⇒ `lastDisabledAt` vắng ⇒ `false`.
     - Login thường hay step-up (`reauthAfter`) chỉ bị chặn khi context được tạo trong vòng biên của một lần disable.
     - Consent run 55 không đi qua `resume`.
   - Hệ quả phụ là 💭 (xem dưới): client disabled ở nhánh thường giờ ra trang null ("expired") thay vì `AuthorizeErrorPage('unknown_client')`, và đọc client 2 lần.
3. **`adminLock` ném 5xx sau 2 vòng: chấp nhận được.**
   - Muốn tới đó phải có miss (super-lock), rồi đọc lại thấy đã mở, rồi miss lần nữa (bị super-lock lại). Tức là lock/unlock bị lật 2 lần trong vài ms.
   - Ở nhánh này request không ghi gì, không revoke, không audit, nên retry an toàn. Fail-closed đúng.
4. **Refusal sau `consume`: đúng.** Đã phân tích ở mục "Run 54". Code bị đốt, không có token đã ký nào bị trả về hay ghi log, có đúng 1 audit failure.

Các điểm khác được yêu cầu kiểm:
- **Margin 5 s / dữ liệu cũ / clock skew**: client không có epoch ⇒ hành vi cũ. Mọi code trước deploy hết hạn sau 60 s và chưa client nào có epoch, nên `?? 0` vô hại. Lệch đồng hồ đã có runbook yêu cầu NTP (có 1 câu sai chiều, xem 🟡 DEBT-419).
- **Lock cũ không level ⇒ super_admin**: đúng như mô tả ở I2.
- **Unlock `returnDocument:'before'`**: audit đúng 1 lần, đúng như mô tả ở I3.
- **`recheckIssued`**: không trả plaintext, revoke fail-closed, đúng như mô tả ở I1.
- **DEBT-417**: mô tả đúng. Mức 💭 hợp lý vì nó chỉ ảnh hưởng cách đọc audit, không ảnh hưởng quyền.

Rủi ro còn lại đã ghi nhận (không phải lỗi):
- Một `/authorize` đã đọc client trước disable nhưng treo hơn 5 s và chỉ mint code sau khi re-enable thì code vẫn sống. Cửa sổ là ms trong thực tế, và margin được thiết kế cho đúng tình huống này.
- Resource server tự verify JWT vẫn tin AT tối đa 15'. Điều này đã được chấp nhận trong spec §9.11.

## 🟡 Nên sửa

🟡 **Maintainability: `resetFailedLogins` chết ở prod và lệch ngữ nghĩa mức khoá** (DEBT-418)
`be/src/modules/identity/user.service.ts:244`: hàm này chỉ còn caller trong test (`identity.int-spec.ts:127`, `ui-auth.int-spec.ts:329,394`).
Vì sao: nó `$unset lockedUntil` nhưng không xoá `adminLockLevel`. Nếu ai đó dùng lại nó cho đường admin thì sẽ để lại mức "mồ côi". Hôm nay vô hại vì `adminLock` luôn ghi đè mức, nhưng đây là bẫy.
Đề xuất: xoá hàm, chuyển 3 caller test sang `adminUnlock(sub, true)` hoặc `updateOne` trực tiếp. Lý do tương tự áp dụng cho `updateStatus({lockedUntil})`: nó vẫn ghi được sentinel không có mức (hiện chỉ test federation dùng), cân nhắc thu hẹp `UserStatusPatch`.

🟡 **Docs: runbook nói sai chiều lệch đồng hồ** (DEBT-419)
`docs/agile/sso-idp/runbook-ops.md` (mục NTP run 56) viết "artefact mint trên instance chạy chậm có thể sống lại".
Vì sao: instance mint chạy **chậm** cho `t` nhỏ hơn, nên artefact bị coi là trước disable và chết (fail-closed). Artefact sống lại khi instance mint chạy **nhanh** hơn instance ghi disable quá 5 s, hoặc instance ghi disable chạy chậm. Người trực sự cố sẽ soi nhầm node.
Đề xuất: sửa thành "đồng hồ instance mint đi trước instance thực hiện disable > 5 s".

## 💭 Nit

- `authorize.service.ts:172`: nhánh resume thường giờ đọc client 2 lần (`trustedClient` rồi `handle()`), và client disabled ra trang null thay vì `unknown_client`. Cả hai đều là trang first-party, không phải vấn đề bảo mật. Nếu muốn giữ thông điệp riêng thì cho `trustedClient` trả lý do.
- `token.controller.ts`: `?? 0` lặp ở 3 chỗ. Có thể để `mintedBeforeDisable` nhận `tMs?: number` và tự fail-closed.
- `admin-users.controller.ts:218`: `after` dựng tay từ `before`. Nên ghi chú rằng `toAdminUser` không đọc `adminLockLevel`, nếu không thì sau này DEBT-336 thêm `lockKind` sẽ trả mức cũ.

## ✂️ Ponytail

- be/src/modules/identity/user.service.ts:L244: delete: `resetFailedLogins` (0 caller prod). Thay bằng `adminUnlock(sub, true)` trong 3 test.

net: -13 lines possible.

---

# Senior Review — Vòng 2 (2026-10-26), phạm vi retry 1 (DEBT-420)

## Kết luận: REJECT

Có 1 🔴: một E2E đang có sẵn sẽ đỏ vì metadata bỏ `count`. Phần sửa thứ tự audit đi đúng hướng và không có lỗi bảo mật.

## Tổng quan

- `AdminUsersController.lock` (`admin-users.controller.ts:169-185`) gọi `audit.record` ngay sau khi `await adminLock` resolve. `AuditService.record` (`audit.service.ts:117-123`) lấy `timestamp = new Date()` đồng bộ, trước I/O đầu tiên. Như vậy timestamp LOCKED chỉ phụ thuộc vào lúc nhận phản hồi câu ghi khoá, không còn bị kéo ra sau revoke chậm. Cách làm gọn, không cần thêm lock hay sequence.
- Audit lỗi: promise đã khởi chạy trước revoke và có `.catch` chặn unhandled rejection. Revoke vẫn chạy hết, sau đó `await audited` ném lỗi thành 5xx. Kết quả: đã khoá, đã revoke, chưa có success. Retry idempotent và ghi success. Fail-closed đúng.
- Revoke lỗi sau khi success đã bắt đầu ghi: `onFailure` ghi `failure revoke_failed`, timestamp lấy sau I/O revoke nên luôn đứng sau success. Trail: success, failure, 5xx. Retry thêm 1 success. DEBT-152 vẫn giữ: success, failure, success.
- Đã chạy lại: `tsc --noEmit` 0, `eslint src test` 0, be unit 589/589. Không chạy int/E2E (ngoài phạm vi).

## 🔴 Blocker

- [ ] **E2E `e2e/tests/fe-admin-audit.spec.ts:55-56` sẽ FAIL.** Test lọc `ADMIN_USER_LOCKED` từ `start`, mở Details, rồi assert có `definition` khớp `/^\d+$/` và có `term` đúng bằng `count`. Metadata giờ chỉ còn `{level}` (kiểu chuỗi), nên cả term `count` lẫn giá trị số đều không còn. Filter `from=start` đã loại các event cũ còn `count`, nên test chắc chắn đỏ.
  Vì sao chặn: retry 1 chỉ chạy unit/int. Lượt 2 tester chạy E2E (35/35) sẽ đỏ, tức chắc chắn tốn thêm một vòng. Ngoài ra đây là thay đổi hợp đồng audit đang hiển thị trên fe-admin (run 48/50 dùng `count` làm bằng chứng đã revoke).
  Đề xuất, chọn một:
  - (a) Giữ thông tin: sau khi revoke thành công, ghi thêm `SESSION_REVOKED success {scope:'all', count, via:'lock'}`, giống `revokeSessions` ở `:255-259`. LOCKED success giữ nguyên vị trí hiện tại. E2E đổi assert sang term `level`, có thể thêm assert một row `SESSION_REVOKED` có `count`. Cách này đóng luôn DEBT-421.
  - (b) Chấp nhận mất `count`: sửa E2E assert term `level` và giá trị tương ứng với vai trò actor E2E (xác minh trong seed).

  Chọn cách nào cũng phải chạy E2E `fe-admin-audit` trước khi bàn giao.

## Security invariants / trust boundaries đã kiểm

- **Trail ↔ DB (DEBT-420), một instance**: unlock ghi DB sau lock thì phản hồi về sau và audit cũng sau. Đạt, trừ 2 ngoại lệ hẹp ghi ở DEBT-422: timestamp trùng ms, và phản hồi của 2 connection trong pool về đảo thứ tự.
- **Chiều ngược lại** (unlock ghi trước, lock ghi sau; DB đang khoá nhưng trail kết thúc ở UNLOCKED): cùng gốc với mục trên, chỉ xảy ra khi phản hồi đảo hoặc trùng ms. Nhánh `adminLock` "đã khoá sẵn" trả `current` từ `findById`, và timestamp lấy lúc nhận phản hồi read. Unlock chen vào sau read vẫn phải chờ phản hồi ghi của chính nó, nên thông thường audit sau. Không có bypass. Nếu trail sai theo chiều này thì phía an toàn vẫn giữ (DB khoá).
- **Fail-closed**: audit lỗi thì vẫn revoke rồi trả 5xx. Revoke lỗi thì giữ lock, ghi audit failure, trả 5xx. Không có nhánh nào trả 200 khi revoke chưa xong. Đạt.
- **Exposure**: metadata `{level}` và `{failedStep}` không chứa secret. Đạt.
- **Đa instance**: thứ tự đi theo đồng hồ của từng node, rủi ro đã ghi trong runbook NTP. Chấp nhận, vì audit vốn chưa từng có thứ tự toàn cục.
- Không đụng tới run 54/55 hay DEBT-153 (filter mức vẫn nằm trong câu ghi).

## 🟡 Nên sửa

- **DEBT-421** — `admin-users.controller.ts:169-174`: nghĩa của `ADMIN_USER_LOCKED success` đã đổi từ "đã khoá và đã revoke hết (có count)" thành "đã ghi khoá". Số phiên bị thu hồi mất. Người đọc audit chỉ biết revoke chưa xong khi tìm thấy một event `failure` đi sau. Spec §9.11 và security-matrix chưa ghi nghĩa mới.
  Đề xuất: ghi một audit riêng sau revoke (xem 🔴 (a)) và cập nhật nghĩa này vào spec §9.11.
- **DEBT-422** — tie-break của trail trên admin API: `listForTenant` sort `{timestamp:-1, eventId:-1}`, mà `eventId` là `randomUUID()`. Khi lock ghi DB rồi unlock ghi ngay sau (localhost, Mongo nhanh), hai `timestamp` rất dễ trùng ms, nên fe-admin hiển thị thứ tự LOCKED/UNLOCKED ngẫu nhiên. L5/L6 và int sort `{timestamp, _id}` (ObjectId tăng theo thứ tự tạo trong process) nên không bắt được. Phản hồi của 2 connection trong pool về đảo thứ tự cũng có thể làm đảo trail.
  Đề xuất: tối thiểu ghi vào spec/runbook rằng "cùng ms thì thứ tự không xác định". Tốt hơn là tie-break đơn điệu (`_id`, UUIDv7 hoặc sequence) trong cả sort lẫn cursor. Chặt hơn nữa: `$inc lockVersion` trong cùng câu ghi lock/unlock và đưa giá trị đó vào metadata.

## 💭 Nit

- `admin-users.controller.ts:175`: `audited.catch(() => undefined)` đúng. Dùng `Promise.allSettled` rồi ném lỗi revoke trước, lỗi audit sau, có thể dễ đọc hơn. Không bắt buộc.
- Comment ở `:162` "Lock first, THEN revoke" vẫn đúng. Nên thêm ý "audit success = lock written" cho khớp DEBT-421.

## ✂️ Ponytail

Lean already. Ship. (Retry 1 còn giảm code: bỏ destructure `sessionCount`.)

---

# Senior Review — Vòng 3 (2026-10-26), phạm vi retry 2 (DEBT-421: `SESSION_REVOKED {via:'lock'}`, E2E, spec/matrix)

## Kết luận: PASS

Theo quyết định người dùng (2026-10-26): L6/DEBT-420 (lock ∥ unlock không barrier, trail lệch DB do thứ tự phản hồi Mongo) KHÔNG xét trong run 56 — gộp với DEBT-422 sang run 57. Vòng này chỉ review retry 2.

## Tổng quan

Hướng (a) đúng và gọn. `LOCKED success {level}` nghĩa là đã ghi khoá. Việc thu hồi phiên tách thành event riêng `SESSION_REVOKED success {scope:'all', count, via:'lock'}`, dùng lại đúng khuôn của `sessions/revoke` (`admin-users.controller.ts:250-265`), nên fe-admin không cần đổi gì (action đã có trong `fe-admin/src/features/admin-api/inputs.ts:136`). Phần xoá import `ADMIN_LOCKED_UNTIL` là hệ quả trực tiếp. Không có thay đổi ngoài phạm vi.

Verify lại: be `tsc --noEmit` 0; eslint (controller + int-spec) 0; `pnpm -C be test` 589/589 (37 suite); e2e `tsc --noEmit` 0. Không chạy int/E2E (theo phạm vi).

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Chỉ ghi khi revoke thành công**: `admin-users.controller.ts:189-197` nằm sau `await revokeAllUserCredentials(...)`. Khi có lỗi, `revokeAllUserCredentials` (`authentication.service.ts:268-271`) gọi `onFailure` rồi rethrow, nên lệnh `record(SESSION_REVOKED)` không chạy. Trail lỗi là `LOCKED success` → `LOCKED failure revoke_failed`, rồi 5xx. Đạt.
- **Audit `LOCKED success` lỗi** (`audited` reject): revoke vẫn chạy, `await audited` ném lỗi, nên `SESSION_REVOKED` không được ghi, rồi 5xx. Thà thiếu event còn hơn ghi event sai, chấp nhận được (fail-closed, lock và revoke vẫn giữ).
- **Đúng 1 lần cho retry DEBT-152**: int `admin-users.int-spec.ts:651-664` assert trail LOCKED `[success, failure, success]` và `SESSION_REVOKED` có đúng 1 bản ghi `{scope:'all', count:0, via:'lock'}` (bản ghi của lần retry). Đạt. Mutation bỏ SESSION_REVOKED ⇒ 2 test RED (log dev).
- **Exposure**: metadata chỉ có `scope`/`count`/`via` (hằng + số), không có token, email hay session id. `targetId` = user id, giống `sessions/revoke`. Đạt.
- **Authz**: đường đi trước revoke không đổi (`mustFind` theo tenant, chặn tự khoá, `assertMayTouchAccount`). `tenantId`/`actorId` lấy từ `adminAuditBase` (int `:561-568` assert `actorId`/`tenantId`).
- **Spec/matrix**: spec §9.11 (dòng "Khoá tài khoản theo mức") mô tả đúng: `LOCKED success {level}` = đã ghi khoá; `SESSION_REVOKED … via:'lock'` chỉ ghi khi revoke xong; revoke lỗi ⇒ `LOCKED failure revoke_failed` + 5xx; cùng ms thì thứ tự chưa xác định (DEBT-422). Hàng DEBT-420/421 trong security-matrix trỏ đúng test.

## 🟡 Nên sửa

- [ ] `e2e/tests/fe-admin-audit.spec.ts:62-69` — bước SESSION_REVOKED chưa ràng buộc đúng mục đích. Bước này dựa vào việc form vẫn giữ Target id + From mà không assert `targetId` trên URL (bước UNLOCKED có assert, `:74`), cũng không assert term `via`/definition `lock`. Vì sao: E2E user có thể có `SESSION_REVOKED` từ đường khác trong cửa sổ `from` (vd. `sessions/revoke`, logout-all), khi đó test vẫn xanh dù lock không ghi event. Đề xuất: thêm `expect(new URL(page.url()).searchParams.get("targetId")).toBe(userId)` và assert term `^via$` + definition `^lock$`. → DEBT-423.

## 💭 Nit

- `be/test/admin-users.int-spec.ts:570-579` — lần lock thứ hai mới assert `LOCKED success` = 2. Có thể assert thêm `SESSION_REVOKED via:'lock'` = 2 để khoá luôn câu "mỗi lần revoke thành công đều có event".
- Comment `admin-users.controller.ts:165-170` vẫn nhắc "an unlock landing after this write can only audit after it". Câu này không còn đúng tuyệt đối (L6/DEBT-420 sang run 57). Nên sửa cho khớp khi làm run 57.

## ✂️ Ponytail

Lean already. Ship.
