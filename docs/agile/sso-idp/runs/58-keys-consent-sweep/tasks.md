# Tasks — run 58 — sweep debt 🟡 BE: rotate key + consent/refresh (M7, lane BE)

> Nguồn: `backlog.md` (đọc nguyên văn + run gốc): DEBT-158 (`POST /admin/keys/rotate` không idempotent: audit lỗi sau rotate ⇒ 5xx, gọi lại xoay thêm; spam normal rotate), DEBT-389 (emergency rotate Vault 3 bước không atomic), DEBT-160 (`SIGNING_KEY_CREATED` spec §10 chưa phát), DEBT-151 (DELETE consent: stamp `revokedAt` rồi `revokeForConsent`/audit lỗi ⇒ 5xx, gọi lại…), DEBT-214 (refresh grant không kiểm consent khi bump `policyVersion`), DEBT-238 (`clientErrorStatus` nhận mọi `Error` có `statusCode` 4xx). Spec/plan: §6.4, §9, §10, `security-matrix.md`. Run 54–57 vừa sửa `/token`, consent binding, admin races, audit order — không được phá.
>
> Tech-lead: xác minh từng debt còn đúng HEAD, rủi ro thật, loại cái đã xong/không đáng (đóng kèm bằng chứng); chọn ≤5 task cho run này, tách phần còn lại. Hạ tầng: KHÔNG compose up/FLUSH/drop; Vault tạm chỉ `vg-b73-vault`; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop).

### [x] Task 1 [BE]: DEBT-158 + DEBT-389 + DEBT-160 — rotate key an toàn khi gọi lại/lỗi giữa chừng, audit tạo key.
### [x] Task 2 [BE]: DEBT-151 — revoke consent idempotent/hoàn tất khi gọi lại.
### [ ] Task 3 [BE]: DEBT-214 — refresh và consent (quyết định theo spec).
### [x] Task 4 [BE]: DEBT-238 — phân loại lỗi client chặt hơn.

---

## Fold tech-lead (2026-10-28) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Xác minh tại HEAD `b71405a` (đọc code qua CodeGraph). Phạm vi run: **3 task** (T1–T3). DEBT-214 cần người dùng quyết định ⇒ KHÔNG làm.

| Debt | Còn đúng HEAD? | Quyết định |
|---|---|---|
| DEBT-158 | Đúng: `KeyRotationService.rotate` (key-rotation.service.ts:51) audit lỗi sau rotate ⇒ 5xx, gọi lại xoay thêm | **Đóng, chấp nhận rủi ro** (không code): actor là super_admin + step-up 5', hậu quả mỗi lần thừa = 1 key thêm trong JWKS ≤ `ACCESS_TOKEN_TTL`; FE không tự gửi lại (`uncertainText`); runbook-ops §1 bước 3 đã có "không gọi lại mù". Cooldown/idempotency-key bị loại: phải đổi interface `KeyProvider`, thêm env cho test, vỡ ~25 test xoay liên tiếp — chi phí > rủi ro. Chỉ sửa runbook trong T1. |
| DEBT-389 | Đúng: `VaultTransitKeyProvider.rotate` (vault-transit-key-provider.ts:196) `rotate`→`config`→`trim` không atomic | **T1**: chứng minh "chạy lại emergency hội tụ" bằng test + sửa bẫy runbook (bước 3 "kid active đã khác ⇒ dừng" sai với emergency dở). Không thêm thao tác "hoàn tất emergency". |
| DEBT-160 | Đúng: `SIGNING_KEY_CREATED` có trong enum, không chỗ nào phát | **T1 (docs)**: chốt spec — app không phát; prod key do ops tạo trong Vault (audit device của Vault), rotation phát `SIGNING_KEY_ROTATED` với `targetId=newKid`; dev `LocalKeyProvider.init` tạo key đầu không audit. Không code. |
| DEBT-151 | Đúng: `revokeById` lọc `revokedAt: null` (consent.service.ts:126), controller 404 khi gọi lại (admin-users.controller.ts:435); refresh grant KHÔNG kiểm consent (token.controller.ts:446-457) ⇒ sweep lỗi = family `offline_access` sống tiếp, không có đường retry | **T2** theo hợp đồng senior run 28 (DELETE idempotent 204). |
| DEBT-238 | Đúng: `clientErrorStatus` (oauth-exception.filter.ts:31) tin mọi `Error` có `statusCode` 4xx; hôm nay chưa dep nào lợi dụng (senior run 38 đã rà) | **T3**: thu hẹp predicate (2–3 dòng) + test. |
| DEBT-214 | Đúng: callback recheck của refresh không gọi `isCovered` | **NGOÀI PHẠM VI — chờ người dùng** (Q58.1 ở cuối). |

### [x] Task 1 [BE+DOCS]: DEBT-389 hội tụ emergency + runbook; đóng DEBT-158 (chấp nhận), DEBT-160 (spec)

- **Không sửa code sản phẩm**. Nếu test dưới RED trên code hiện tại ⇒ dừng, báo tech-lead trước khi sửa.
- Unit `be/src/modules/keys/vault-transit-key-provider.spec.ts` (fake Vault sẵn có), test mới "DEBT-389: emergency với `config` lỗi rồi chạy lại ⇒ hội tụ":
  1. `init`; ghi `k1` = kid active. `vault.fail.config = [503]`; `rotate('emergency')` ⇒ reject `vault config failed`.
  2. Cửa sổ dở (ghi lại hành vi, không phải mong muốn): `listKeys()` có 2 item (`k2` active, `k1` retiring); `signJwt` ⇒ header `kid = k2` (app không ký bằng key cũ).
  3. Gọi lại `rotate('emergency')` ⇒ ok, `newKid = k3`; fake Vault nhận `config` với `min_decryption_version = min_encryption_version = 3` và `trim min_available_version = 3`; `listKeys()` đúng 1 item `{k3, active}`; `getPublicKeys()` chỉ `k3`; `getPublicKeys(k1)` không chứa `k1`.
  - Mutation (ghi kết quả trong log): (a) `config` dùng `before.latest` thay `n` ⇒ RED; (b) bỏ lời gọi `config` ⇒ RED. Khôi phục byte-identical (sha256).
- `runbook-ops.md` §1:
  - Bước 3: thay quy tắc "Đã xoay ⇒ dừng" bằng: **normal**: kid active khác bước 2 ⇒ đã xoay, dừng. **emergency**: chỉ coi là xong khi `GET /admin/keys` có **đúng 1 item** (`active`, kid ≠ bước 2); kid active đã đổi mà còn item `retiring` ⇒ emergency dở (Vault `config` lỗi, DEBT-389) ⇒ **gọi lại emergency** (hội tụ: min_* = latest, trim). Dấu hiệu trong audit: `SIGNING_KEY_ROTATED result:"failure" reason:"rotate_failed" metadata.mode:"emergency"`.
  - Mục Vault: sửa dòng DEBT-389 cho đúng (app luôn ký bằng latest; key cũ còn trong JWKS và Vault còn cho ký version cũ tới khi chạy lại).
- `spec.md` §10 AuditLog: thêm 1 câu sau danh sách action: "`SIGNING_KEY_CREATED` không do app phát (run 58, DEBT-160): prod key do ops tạo trong Vault (audit device của Vault); mỗi rotation phát `SIGNING_KEY_ROTATED` (`targetId` = kid mới); dev `LocalKeyProvider` tạo key đầu lúc boot không audit."
- Backlog: chuyển DEBT-158 (chấp nhận, lý do ở bảng trên), DEBT-160, DEBT-389 sang đóng kèm bằng chứng.
- verify: `pnpm -C be test -- vault-transit-key-provider keys` xanh; `pnpm -C be test` toàn bộ; `git diff -- be/src ':!*.spec.ts'` rỗng cho T1.

### [x] Task 2 [BE]: DEBT-151 — DELETE consent idempotent, luôn sweep, audit mỗi lần

**Tài sản/actor/boundary**: consent + family refresh của user×client×resource; actor = admin `admin.write` + step-up 5' của tenant token; boundary = tenant (client thuộc tenant, `tenantClientIds`) + user là member tenant (`mustFind`).

**Thiết kế**
- `ConsentService.revokeById(id, userId, clientIds, now)` ⇒ trả `{ consent: Consent; alreadyRevoked: boolean } | null`. Filter giữ `_id`, `userId`, `clientId: {$in: clientIds}` và **bỏ** `revokedAt: null`; `clientIds` rỗng ⇒ null như cũ. Một round-trip `findOneAndUpdate` update-pipeline `[{ $set: { revokedAt: { $ifNull: ['$revokedAt', now] } } }]` (`updatePipeline: true`, cast `userId` tay như `upsertGrant`), `returnDocument: 'before'` ⇒ `alreadyRevoked = before.revokedAt != null`. Consent đã revoke **giữ nguyên `revokedAt` đầu tiên** (không ghi đè). Không đụng `grantedScopes`/versions.
- Controller `revokeConsent`: null ⇒ 404 opaque như cũ. Luôn gọi `revokeForConsent(t.id, clientId, resource, now)` (idempotent, stamp `familyRevokedAt`, giữ race-close INV-11). Thứ tự giữ: consent trước, family sau.
  - `revokeForConsent` ném ⇒ audit `OAUTH_CONSENT_REVOKED result:'failure' reason:'family_sweep_failed'` metadata `{clientId, resource, alreadyRevoked}` **best-effort** (`.catch(() => undefined)`), rethrow (5xx).
  - Thành công ⇒ audit success như cũ + `metadata.alreadyRevoked`. Audit success lỗi ⇒ 5xx (giữ như hiện tại); gọi lại hội tụ.
- Sửa `@ApiOperation` description: bỏ "An already revoked consent is a 404." ⇒ "Idempotent: an already revoked consent of this user/tenant is a 204 and its families are swept again."; sửa doc comment `revokeById`.
- Không đổi FE trong run này (nhánh `not_found` "already revoked" của FE nay chỉ còn khi ngoài phạm vi ⇒ DEBT-428).

**Invariant**: sau mọi 204, không còn RT active nào của user×client×resource; `revokedAt` của consent không bao giờ bị ghi đè; ngoài phạm vi tenant/user ⇒ 404 byte-identical bất kể trạng thái revoke.

**Test int bắt buộc** (`be/test/admin-users.int-spec.ts`, describe "run 58 DEBT-151"; lỗi tiêm bằng `jest.spyOn(app.get(RefreshTokenService|AuditService), ...).mockRejectedValueOnce`):
- (a) Gọi lại sau revoke thành công ⇒ 204; `revokedAt` = lần đầu (so `getTime()`); audit thứ 2 `alreadyRevoked:true, count:0`. **Sửa** test cũ (~dòng 1074, "Already revoked => 404, no second audit"): đổi kỳ vọng có chủ đích, ghi lý do trong log.
- (b) Sweep lỗi: lần 1 ⇒ 500, consent đã stamp, refresh bằng RT mới nhất của family vẫn 200 (ghi lại lỗ trước fix); audit failure `family_sweep_failed`; lần 2 ⇒ 204, refresh ⇒ `invalid_grant`, mọi doc family revoked, audit success `alreadyRevoked:true`.
- (c) Audit success lỗi lần 1 ⇒ 5xx, family đã revoke; lần 2 ⇒ 204 + đúng 1 audit success (`alreadyRevoked:true`).
- (d) Race: 2 DELETE song song (`Promise.all`) ⇒ cả 2 là 204; đúng 1 audit `alreadyRevoked:false` + 1 `alreadyRevoked:true`; family revoked.
- (e) Âm (mới): consent **đã revoke** thuộc client tenant B / thuộc user khác cùng tenant / ObjectId không tồn tại / id sai dạng ⇒ 404 byte-identical (body + content-type) với 404 hiện tại; DB không đổi (`revokedAt` và family của đối tượng kia không bị đụng). Test cross-tenant 404 hiện có (~dòng 1541) vẫn xanh.
- (f) Guard: thiếu step-up ⇒ `403 step_up_required`; chỉ `admin.read` ⇒ `403 insufficient_scope`: dùng test cũ, ghi tên trong log; thêm nếu chưa có cho route này.
- `consent.service.spec.ts` (nếu mock `findOneAndUpdate`) và `token-code-recheck.int-spec.ts` (DEBT-144 dùng `revokeById`) cập nhật theo kiểu trả mới; kỳ vọng hành vi không đổi.
- **Mutation** (log): (1) thêm lại `revokedAt: null` vào filter ⇒ (a)(b) RED; (2) bỏ sweep khi `alreadyRevoked` ⇒ (b) RED; (3) bỏ `clientId: {$in}` ⇒ (e) RED; (4) `$set: {revokedAt: now}` (ghi đè) ⇒ (a) RED.
- `security-matrix.md`: thêm dòng DEBT-151 vào bảng DEBT (tên test (a)–(e)).
- verify: `pnpm -C be test`; `pnpm -C be test:int -- admin-users token-code-recheck`; int full; typecheck/lint.

### [x] Task 3 [BE]: DEBT-238 — thu hẹp `clientErrorStatus`

- `be/src/common/filters/oauth-exception.filter.ts`: chỉ nhận lỗi 4xx khi `code` là `undefined` hoặc string bắt đầu `FST_`. `code` khác (string khác, số) ⇒ `undefined` ⇒ 500 + error log. Doc comment ghi invariant: outbound client phải bọc lỗi (như `providerFetchJson`, `VaultStatusError` dùng `status` chứ không `statusCode`); lỗi kiểu `http-errors` không có `code` vẫn coi là client error — chấp nhận, không dep runtime nào dùng (senior run 38). `HtmlExceptionFilter` dùng chung helper nên tự áp.
- Trước khi sửa: xác nhận bằng int test thật rằng các nguồn 4xx đi qua nhánh này vẫn 4xx, không error log: JSON body hỏng (400), content-type lạ (415), body quá lớn (413), URL hỏng (400), `@fastify/static` path không canonical (403). Dùng test có sẵn (b74-tester / static-assets / security-headers, ghi tên) hoặc thêm. **Nếu một nguồn thật mang `code` không phải `FST_` ⇒ DỪNG, báo tech-lead**, không tự nới predicate.
- Unit `oauth-exception.filter.spec.ts` thêm: `{statusCode:404, code:'ESDK_NOT_FOUND'}` ⇒ 500 + log; `{statusCode:403, code:403}` (số) ⇒ 500; `{statusCode:415, code:'FST_ERR_CTP_INVALID_MEDIA_TYPE'}` ⇒ 415 không log; `{statusCode:403}` không code ⇒ 403 (đã có). Một case HtmlExceptionFilter tương ứng (SDK-shaped ⇒ 500).
- Mutation: (1) bỏ kiểm `code` ⇒ case SDK RED; (2) chỉ nhận `FST_` (bỏ nhánh không code) ⇒ int static 403 RED.
- verify: unit + int các nhóm trên + int full.

### Cổng security (bắt buộc cho T2/T3)

- T2 abuse: IDOR/cross-tenant (e) ⇒ 404 byte-identical cả với consent đã revoke; enumeration: 204 vs 404 chỉ phân biệt trong phạm vi user+tenant admin vốn đã thấy (chấp nhận, hợp đồng run 28); replay/retry ⇒ hội tụ, không ghi đè `revokedAt`; race (d); refresh xoay song song với sweep ⇒ cơ chế `familyRevokedAt` không đổi (ghi tên test race sweep chung đã có, không bắt thêm).
- T2 failure: DB lỗi ở `revokeById` ⇒ 5xx, không gì đổi; sweep lỗi ⇒ 5xx + failure audit best-effort; audit lỗi ⇒ 5xx; mọi trường hợp gọi lại ⇒ 204 và trạng thái đúng. Fail-closed.
- T2 exposure: 204 body rỗng; audit metadata chỉ `clientId/resource/count/alreadyRevoked`, không hash/token.
- T3: lỗi upstream mang `statusCode` + `code` lạ ⇒ 500 + log (không giấu lỗi server, không lộ status upstream); body 4xx vẫn chuỗi cố định, `no-store`.
- Không phá: ký-trước-commit (run 54), consent binding/Q35.5 ở code grant (run 55), admin level/races (run 56), audit mark/order (run 57). Run này chỉ chạm `admin-users.controller.ts#revokeConsent`, `ConsentService.revokeById`, `oauth-exception.filter.ts`.

### Ngoài phạm vi — chờ người dùng: DEBT-214 (Q58.1)

**Câu hỏi**: khi tăng `policyVersion`/`termsVersion` của consent, refresh token (`offline_access`) đã cấp có phải **dừng** (buộc user đồng ý lại) không?
- **A (đề xuất, giữ hiện tại)**: không dừng. Đồng ý lại xảy ra ở lần `/authorize` tương tác kế tiếp (code grant đang dở đã bị chặn, Q35.5). Ghi rõ vào spec §9.4. Không tốn gì, không làm chết đồng loạt RP.
- **B**: refresh grant kiểm `isCovered` (cả version) ⇒ `invalid_grant` ngay sau bump; mọi client offline phải đăng nhập lại cùng lúc (thundering herd, RP phải xử lý). Chi phí ~10 dòng + test, cần báo RP trước.
- **C**: bump kèm lệnh ops sweep family theo version (chọn theo client/resource). Linh hoạt nhất, tốn nhất.
Chỉ chọn B/C khi pháp lý yêu cầu re-consent bắt buộc. Chưa có trả lời ⇒ giữ A, DEBT-214 mở.

## Fold tech-lead bổ sung T3 (2026-10-28) — ƯU TIÊN

**Quyết định**: chấp nhận đề xuất senior, match **chặt đúng một hình dạng**. Không dùng allowlist theo nguồn (filter không biết nguồn lỗi). Không kiểm `request.raw.aborted`/socket trong filter: cách đó cũng nuốt ERROR log của lỗi server thật xảy ra trùng lúc client ngắt, và buộc đổi chữ ký helper dùng chung với `HtmlExceptionFilter`.

**Rà Fastify 5.12.5 (`node_modules/.pnpm/fastify@5.12.5`) + plugin đang đăng ký**, các chỗ gán `statusCode` 4xx:
- `lib/content-type-parser.js:294-297` `rawBody.onEnd(err)`: lỗi stream payload chưa có `statusCode >= 400` ⇒ `err.statusCode = 400`. **Đây là chỗ DUY NHẤT gắn 4xx lên lỗi lạ (không `FST_`).** Mọi parser có `parseAs` đi qua đây: JSON/text mặc định và `application/x-www-form-urlencoded` (`@fastify/formbody`, `parseAs: 'buffer'`). Repo không có `preParsing`/parser tuỳ biến (grep `be/src`), nên `payload` = `request.raw`. Lỗi duy nhất `IncomingMessage` phát ra là `ConnResetException('aborted')` (`code:'ECONNRESET'`, `message:'aborted'`, Node v22.22.3). Mọi đường đều dẫn tới nó: client đóng/RST giữa body, `requestTimeout`/`headersTimeout` của Node, lỗi parse HTTP giữa body (chunked hỏng). Các trường hợp này đều đi qua `clientError` ⇒ socket destroy ⇒ `abortIncoming`.
- `lib/validation.js:441-449`: gán 400 kèm `code ||= 'FST_ERR_VALIDATION'`. Đã có `FST_`, và Nest không dùng schema Fastify. `validation.js:305` gán 500, ngoài phạm vi.
- `fastify.js:661/686` (`onBadUrl`/`onMaxParamLength`): ghi response thô, có mã `FST_`. `four-oh-four.js:58`: payload chứ không phải error. `error-handler.js:140-149`: chỉ đọc `status`/`statusCode`, không gán lên error.
- Plugin: `@fastify/formbody`, `cookie`, `cors`, `helmet`, `middie`, `view` không gán `statusCode`. `@fastify/static`/`send`: senior đã rà (403 không `code`; `ENOENT…` ⇒ `callNotFound`).

**Predicate chính xác** (`be/src/common/filters/oauth-exception.filter.ts#clientErrorStatus`), thêm đúng một ngoại lệ trước kiểm `code`:
```ts
const { statusCode: status, code, message } = exception as {...};
// Fastify rawBody tags the request stream's own abort error with 400 (client gone mid-body).
const fastifyBodyAbort = code === 'ECONNRESET' && status === 400 && message === 'aborted';
if (!fastifyBodyAbort && code !== undefined && !(typeof code === 'string' && code.startsWith('FST_'))) return undefined;
```
Giữ nguyên `instanceof Error`. Không nới cho `code` hay status khác.

**Unit** (`oauth-exception.filter.spec.ts`, describe DEBT-238):
- `Object.assign(new Error('aborted'), {code:'ECONNRESET', statusCode:400})` ⇒ 400, `invalid_request`, `no-store`, **0** `logger.error`.
- Cùng `code`+`message`, `statusCode:404` ⇒ 500 + log. Không có `statusCode` (outbound hang-up) ⇒ 500 + log.
- `ECONNRESET`+400 với message `'socket hang up'` / `'read ECONNRESET'` ⇒ 500 + log.
- `code:'ECONNREFUSED'` + 400 + `'aborted'` ⇒ 500 + log.
- Object thường (không `Error`) cùng hình dạng ⇒ 500.
- `html-exception.filter.spec.ts`: hình dạng abort ⇒ 400 page (không còn 500). Một case `ECONNRESET`+404 ⇒ 500.

**Int abort thật** (`be/test/b74-tester.int-spec.ts`, describe mới `run 58 retry 1 DEBT-238: client aborts mid-body`, dùng `lines`/`errorLines` sẵn có):
- `await full.app.listen(0, '127.0.0.1')` (mẫu `b73-tester.vault-spec.ts:232`), rồi `const spy = jest.spyOn(OAuthExceptionFilter.prototype, 'catch')`.
- `net.connect`, ghi `POST /token HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 200\r\n\r\ngrant_type=client_cre`. Sau callback write + 50 ms ⇒ `socket.resetAndDestroy()` (RST). Thêm biến thể JSON `Content-Type: application/json` gửi `{"a":` rồi `destroy()` (FIN).
- Chờ có điều kiện: poll ≤5 s tới khi `spy` được gọi, rồi `settle`. Không có lời gọi ⇒ test FAIL, không được pass rỗng.
- Kỳ vọng:
  - Lỗi `spy.mock.calls[0][0]` có `code==='ECONNRESET'`, `statusCode===400`, `message==='aborted'`. Đây là bằng chứng chống vacuous, ghi shape vào log.
  - `clientErrorStatus(lỗi đó) === 400`.
  - `errorLines()` không đổi, tức **0 dòng `"level":50` từ bất kỳ logger nào**, Fastify cũng tính.
  - Không có unhandled rejection.
  - Nếu Fastify/Node tự log level 50 ở đường này ⇒ DỪNG, báo tech-lead. Không lọc theo tên logger để test xanh.
- Ghi chú: test là tripwire cho Node/Fastify. Nâng cấp làm đổi message hoặc chỗ gắn status ⇒ RED.

**Mutation** (ghi log):
- (1) bỏ nhánh `fastifyBodyAbort` ⇒ int + unit 400 RED.
- (2) bỏ `message === 'aborted'` ⇒ unit `socket hang up` RED.
- (3) `status === 400` ⇒ `status 4xx bất kỳ` ⇒ unit 404 RED.
- (4) bỏ `code === 'ECONNRESET'` ⇒ unit `ECONNREFUSED` RED.

**Doc + matrix**:
- Doc comment `clientErrorStatus`: thêm 1 câu. Đây là ngoại lệ duy nhất có `code` ngoài `FST_`. Nguồn là `fastify/lib/content-type-parser.js rawBody onEnd`, hình dạng Node `ConnResetException('aborted')`. Rủi ro còn lại chấp nhận: SDK nào tự chép `statusCode:400` lên lỗi `ECONNRESET 'aborted'` của response upstream sẽ thành 400 không log. Không dep runtime nào làm vậy.
- `security-matrix.md` dòng DEBT-238: thêm tên unit mới + int `› run 58 retry 1 DEBT-238: client aborts mid-body › …`, ghi "ngoại lệ ECONNRESET+400+aborted (Fastify rawBody)".

**verify**:
- `pnpm -C be test -- oauth-exception html-exception`.
- `pnpm -C be test:int -- b74-tester`.
- `pnpm -C be test` và int full.
- typecheck/lint các file đổi.
- T1/T2 không đụng lại.

## Fold tech-lead bổ sung T3 lần 2 (2026-10-28) — ƯU TIÊN

Fold này ưu tiên hơn fold bổ sung T3 lần 1 khi hai bên mâu thuẫn. Mọi nội dung khác của lần 1 giữ nguyên: predicate, 6 unit, int abort, M1–M4, doc và matrix.

**Quyết định: phương án A.** Guard trong `clientErrorStatus` đổi thành:
```ts
import { types } from 'node:util';
if (!(exception instanceof Error) && !types.isNativeError(exception)) return undefined;
```
Mọi thứ khác trong predicate giữ nguyên, kể cả `fastifyBodyAbort` và nhánh `FST_`. `HtmlExceptionFilter` gọi lại `clientErrorStatus` nên tự hưởng thay đổi, không sửa file đó.

**Bác B và C**:
- B (child process ngoài Jest VM) cần harness boot Nest riêng cùng IPC log. Đó là hạ tầng mới, nặng hơn cả bản sửa.
- C mất tripwire socket thật. Fold lần 1 cần tripwire này để bắt Node hoặc Fastify đổi message hay chỗ gắn status.

**Đánh giá bảo mật của A** (kiểm trên Node v22.22.3):
- `util.types.isNativeError(v)` chỉ trả true khi `v` thật sự là object Error. Cụ thể, `v` phải mang internal slot `[[ErrorData]]`, tức được tạo bởi constructor Error/`*Error` hoặc `super()` của một subclass, ở bất kỳ realm nào. Hàm không đọc prototype, `Symbol.toStringTag` hay property. Vì vậy:
  - object thường ⇒ false;
  - `Object.create(Error.prototype)` ⇒ false;
  - `new Proxy(new Error(), {})` ⇒ false, vì Proxy không phải JSError;
  - object cross-realm tạo bằng `Object.create(Error.prototype)` ⇒ false;
  - `new Error` cross-realm ⇒ true;
  - instance của `class extends Error` ⇒ true.
- Attacker chỉ đưa vào được dữ liệu: JSON, form hoặc query thành object hay array thường. Attacker không tạo được object có `[[ErrorData]]`. Mọi giá trị đến filter đều do code server ném ra.
- A là **superset nghiêm ngặt** của guard cũ. Phần nới thêm chỉ gồm Error thật từ realm khác: Jest VM, `node:vm`, lỗi Node core được nạp ngoài context. Prod không chạy trong VM, nên ở prod A tương đương guard cũ. Sau guard, `code`/`statusCode`/`message` vẫn phải khớp đúng như trước.
- **CẤM dùng `isNativeError` một mình.** Lỗi `@fastify/error` 4.2.0, tức mọi lỗi `FST_*` (413, 415, 400 ...), dựng bằng `Object.create(Base.prototype)` mà không gọi Error. Các lỗi này có `isNativeError` = false và `instanceof Error` = true (đã kiểm). Nếu chỉ dùng `isNativeError`, toàn bộ 4xx của Fastify sẽ rơi xuống 500 kèm ERROR log.
- `Error.isError` (ES2026) không có trên Node 22.23 và lib ES2023 ⇒ không dùng.

**Ảnh hưởng tới các nhánh khác**:
- Nhánh `HttpException` (cả hai filter) được kiểm trước và vẫn dùng `instanceof HttpException`. `HttpException` là class userland cùng realm ⇒ không đổi. A chỉ chạm nhánh "không phải HttpException".
- `isDependencyUnavailable` (`instanceof Error`) và `errorForLog` (`instanceof Error`) **không sửa trong run này**:
  - Lỗi cross-realm chỉ có dưới VM. Ở đó lỗi bị từ chối vẫn log `non-Error thrown (object)`: đúng là ERROR log, và không chứa message, nên vẫn an toàn theo B7.4.
  - Prod không bị ảnh hưởng.
  - Không mở debt.
- Doc comment `clientErrorStatus`: thêm 1 câu. "Guard nhận cả Error native khác realm (`types.isNativeError`, Jest VM). `instanceof` vẫn cần cho lỗi `@fastify/error` (không native)."

**Unit bổ sung** (`oauth-exception.filter.spec.ts`, describe DEBT-238; tạo realm khác bằng `runInNewContext` của `node:vm`):
- U-A1: `vm.runInNewContext('Object.assign(new Error("aborted"),{code:"ECONNRESET",statusCode:400})')` ⇒ 400, `invalid_request`, `no-store`, **0** `logger.error`. Case này diệt mutation M5.
- U-A2: `vm.runInNewContext('Object.assign(Object.create(Error.prototype),{code:"ECONNRESET",statusCode:400,message:"aborted"})')` ⇒ **500** + log. Đây là case phủ định cho phần nới: object cross-realm không native thì không qua được cả hai điều kiện. Ghi chú: `Object.create(Error.prototype)` **cùng realm** vẫn qua `instanceof`, như hôm nay. Không viết test kỳ vọng 500 cho case cùng realm này, vì kỳ vọng đó sai với A.
- U-A3: object thường cross-realm `vm.runInNewContext('({code:"ECONNRESET",statusCode:400,message:"aborted"})')` ⇒ 500 + log.
- U-A4: `Object.assign(Object.create(Error.prototype), {code:'FST_ERR_CTP_BODY_TOO_LARGE', statusCode:413, message:'x'})` cùng realm (hình dạng của `@fastify/error`) ⇒ 413, 0 log. Case này diệt mutation M6.
- `html-exception.filter.spec.ts`: thêm 1 case U-A1 cross-realm ⇒ 400 page.

**Int**: áp patch `b74-retry1.patch` (scratchpad, describe `run 58 retry 1 DEBT-238: client aborts mid-body`) đúng như fold lần 1, gồm RST + FIN, poll spy ≤5 s, shape `{ECONNRESET,400,'aborted'}`, `clientErrorStatus(err)===400`, **0 dòng level 50** trên cả hai stream. Giữ nguyên ghi chú hạ tầng: bọc prototype trước khi boot, đếm trên cả root logger static.

**Mutation** (bổ sung vào M1–M4; mỗi mutation khôi phục sha256 và ghi log):
- M1 (bỏ nhánh `fastifyBodyAbort`) phải làm **int abort RED cả 2 biến thể**, không chỉ unit. Ghi rõ tên test int RED.
- M5: guard quay về chỉ `instanceof Error` ⇒ int abort RED + U-A1 RED.
- M6: guard chỉ `types.isNativeError` ⇒ U-A4 RED.
- M7: guard thành `typeof exception === 'object' && exception !== null` ⇒ U-A2/U-A3 RED.

**verify**: như fold lần 1. Thêm grep chứng minh `HtmlExceptionFilter` không đổi (`git diff --stat` không có file này ngoài spec), và `pnpm -C be typecheck`.

**Bàn giao**: ⇒ backend-dev tiếp tục retry 1 T3. DEBT-238 đóng khi senior PASS.
