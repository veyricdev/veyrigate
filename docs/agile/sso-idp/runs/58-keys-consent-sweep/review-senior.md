# Senior Review — 2026-10-28 (run 58 — sweep 🟡 BE: DEBT-389/160/158, DEBT-151, DEBT-238)

## Kết luận: REJECT

Có 1 🔴 ở T3 (DEBT-238). T1 và T2 đạt, không cần sửa. Chuyển lại **backend-dev**. Đây là điều kiện dừng tech-lead đã ghi trong fold T3: "nếu một nguồn 4xx thật mang `code` khác `FST_` ⇒ DỪNG, báo tech-lead". Có một nguồn như vậy và dev chưa thử tới.

## Tổng quan (ấn tượng chung + điểm tốt)

- **T2 (DEBT-151)** đúng hợp đồng run 28 và gọn.
  - `revokeById` chạy một `findOneAndUpdate` với pipeline `$ifNull` và before-image. Nhờ đó update nguyên tử, không ghi đè `revokedAt`, và cờ `alreadyRevoked` lấy từ đúng ảnh DB trước khi ghi.
  - Filter vẫn giữ `_id`, `userId` và `clientId $in tenantClientIds`.
  - Controller luôn quét family. Khi quét lỗi, nó ghi audit failure best-effort rồi rethrow, tức là fail-closed.
  - Test (a)–(e) đúng invariant. (b) ghi lại được lỗ trước khi sửa: refresh vẫn 200 sau khi quét lỗi. (e) phủ cả consent **đã revoke** ngoài phạm vi và so 404 theo cả status, content-type và body.
  - Test cũ "already revoked ⇒ 404" đổi kỳ vọng có chủ đích và có ghi lý do.
- **T1 (DEBT-389)**: test hội tụ dùng fake Vault, khớp code `VaultTransitKeyProvider.rotate`: `config`/`trim` dùng `n = after.latest`, và `live()` lọc theo `floor = max(min_dec, min_avail)`.
  - Quy tắc dừng mới cho emergency ở runbook §1 bước 3 ("đúng 1 item") đúng với `listKeys()`. Sau một emergency hoàn tất, `floor = n` nên chỉ còn latest, kể cả khi `trim` lỗi, vì `config` đã nâng `min_decryption_version`.
  - Reason `rotate_failed` và `metadata.mode` trong runbook khớp `KeyRotationService.rotate`.
  - Spec §10 (DEBT-160) đúng sự thật: rotation ghi `targetId = result.newKid`.
- **OpenAPI (DEBT-430)**: chuỗi nối trong `@ApiOperation` của `admin-users.controller.ts:417-420` khớp từng byte với `fe-admin/openapi/admin.json:862` và `schema.d.ts:286`.
- Tôi đã chạy lại:
  - Unit `oauth-exception|html-exception|vault-transit-key-provider|consent`: 4 suite / 100 test xanh.
  - `tsc --noEmit` = 0; eslint các file đã đổi = 0.
  - `test:int` theo mẫu admin-users/consent: 11 suite / 289 test xanh, gồm `admin-users.int-spec.ts` (a)–(e).

## 🔴 Blocker

- [ ] 🔴 **Bảo mật/vận hành: client huỷ upload giữa body ⇒ 500 + ERROR log (regression B7.4), vi phạm điều kiện dừng T3**
  `be/src/common/filters/oauth-exception.filter.ts:40-42`: predicate mới coi mọi `code` khác `FST_*` là lỗi server.
  - **Nguồn**: Fastify core `lib/content-type-parser.js` `rawBody → onEnd(err)` (fastify 5.12.5, khoảng dòng 289-299). Khi stream body của request lỗi, Fastify **tự gắn** `err.statusCode = 400` rồi `done(err)`. Lỗi đó là của Node: `Error('aborted')` với `code: 'ECONNRESET'`.
  - **Đã tái hiện** bằng probe Fastify 5.12.5 thật (scratchpad, không đụng repo): `POST` với `Content-Length: 100`, gửi `{"a":` rồi đóng socket. Error handler nhận `{"name":"Error","code":"ECONNRESET","statusCode":400,"msg":"aborted"}`. `onResponse` không chạy, nên không có metric.
  - **Hậu quả**: trước run 58, lỗi này đi nhánh 400, không log. Sau run 58, nó rơi vào nhánh `else`, nên `this.logger.error(errorForLog(exception))` chạy ở mỗi request.
  - **Vì sao là 🔴**:
    - Client **ẩn danh** chỉ cần mở TCP, gửi nửa body (ví dụ `POST /token`, `/introspect`, form login) rồi RST là bơm được một dòng ERROR mỗi kết nối.
    - Việc này không tốn gì cho kẻ tấn công. Body parser chạy trước handler, nên rate-limit trong route không chặn được.
    - Đây đúng là thuộc tính B7.4 mà doc comment của filter nêu: "an anonymous client cannot raise 5xx metrics/alerts or log noise". Metric 5xx không bị ảnh hưởng vì `onResponse` không chạy, nhưng ERROR log thì có. Hậu quả là alert dựa trên log bị nhiễu và log bị ngập.
    - Fold T3 yêu cầu dừng và báo tech-lead khi gặp nguồn như vậy. Danh sách nguồn mà dev đã thử (400 JSON hỏng/rỗng, 413, 415, URL hỏng, static 403) không có "client abort".
  - **Đề xuất** (chốt với tech-lead vì đây là nới predicate): nhận thêm đúng hình dạng mà Fastify core gắn status, tức là `code === 'ECONNRESET' && statusCode === 400`. Tốt nhất là match chặt `message === 'aborted'`, giống cách `isRedisUnavailable` match đúng hình dạng đã quan sát. Một lỗi SDK outbound mang `ECONNRESET` sẽ không có `statusCode` 4xx, vì chỉ `rawBody` của Fastify gắn status này, nên mục tiêu DEBT-238 vẫn giữ.
  - Thêm:
    - Unit `oauth-exception.filter.spec.ts`: `{statusCode:400, code:'ECONNRESET', message:'aborted'}` ⇒ 400, không log. Cùng mã nhưng statusCode 404 ⇒ 500 + log.
    - Int hồi quy trong `b74-tester.int-spec.ts` (đã có log-capture): mở socket thật, gửi nửa body vào `POST /token` rồi destroy, sau đó kiểm 0 dòng ERROR của `OAuthExceptionFilter`.
    - Mutation: bỏ nhánh `ECONNRESET` ⇒ int RED.
    - Cập nhật doc comment `clientErrorStatus` và dòng DEBT-238 trong `security-matrix.md`.
  - Ngoài ra, nên rà lại `onEnd` / `rawBody` (gồm cả preParsing stream) để chắc không còn đường nào khác của Fastify gắn `statusCode` lên lỗi không có `FST_`. Khi đọc 5.12.5, tôi chỉ thấy chỗ này.

## Security invariants / trust boundaries đã kiểm

**T2 — `DELETE /admin/users/:id/consents/:consentId`**

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| AuthZ tenant/user (IDOR) | OK | Filter `_id + userId + clientId $in tenantClientIds(ctx, distinctClientIds(user))`; `mustFind` 404 cho user ngoài tenant; `OBJECT_ID_HEX` chặn id sai dạng trước `new ObjectId` (không có CastError 500). Test (e): 4 biến thể 404 byte-identical, DB không đổi, family của đối tượng kia còn sống |
| Enumeration 204 vs 404 | OK (chấp nhận) | 204 chỉ khi consent thuộc đúng user và client của tenant mà admin vốn đã liệt kê/thao tác được (hợp đồng run 28). Ngoài phạm vi thì luôn 404 opaque, bất kể trạng thái revoke |
| Không ghi đè `revokedAt` | OK | `$ifNull: ['$revokedAt', now]`; test (a) so `getTime()`; mutation M4 RED (log dev) |
| Retry/replay hội tụ | OK | Mỗi lần gọi đều `revokeForConsent` (idempotent, stamp `familyRevokedAt` theo INV-11); test (b)(c) |
| Race 2 DELETE | OK | Pipeline update trên 1 doc là nguyên tử, before-image cho đúng 1 lần `alreadyRevoked:false`; test (d) |
| Fail-closed | OK | Lỗi `revokeById` ⇒ 5xx, không gì đổi. Quét lỗi ⇒ audit failure best-effort + rethrow. Audit success lỗi ⇒ 5xx sau khi family đã chết. Body 5xx không chứa message lỗi (test (b)(c)) |
| Exposure | OK | 204 body rỗng (test (a)); metadata audit chỉ có `clientId/resource/count/alreadyRevoked`, không hash/token; `alreadyRevoked` chỉ đọc được qua audit API của tenant đó |
| Guard | OK | `@AdminScope('admin.write')` + `@RequireRecentAuth(5)` không đổi; test cũ `cross-tenant user, step-up and scope on family/consent routes` xanh |
| Tương tác run 55 / refresh | OK | `isCovered` vẫn từ chối `revokedAt` khác null; `upsertGrant` reset `revokedAt: null` trên cùng doc (re-consent hợp lệ). Refresh không kiểm consent (DEBT-214, ngoài phạm vi, Q58.1); đường an toàn duy nhất vẫn là quét family, nay có retry |
| Caller khác của `revokeById` | OK | Chỉ `token-code-recheck.int-spec.ts:205`, không dùng giá trị trả về |

**T3 — `clientErrorStatus`**

- SDK-shaped (`statusCode` 4xx + `code` lạ hoặc kiểu số) ⇒ 500 + log, không lộ status upstream. OK.
- Nguồn 4xx thật đã rà: Fastify JSON parser (`FST_ERR_CTP_INVALID_JSON_BODY` / `EMPTY_JSON_BODY`), body limit, media type, content-length (`FST_*`), bad URL (`FST_ERR_BAD_URL`).
- `@fastify/static` 10.1.5: 403 `forbiddenPathError()` không có `code`. Lỗi của `@fastify/send` có `code` (ENOENT/ENAMETOOLONG/ENOTDIR ⇒ 404) bị plugin đổi thành `callNotFound()` trước khi tới filter. 412/416 qua `http-errors` không có `code`.
- `HttpException` (class-validator/ValidationPipe, 429 của app) bắt ở nhánh trước.
- Không có dep runtime nào khác (mongoose/ioredis/jose/nodemailer) gắn `statusCode`.
- **Ngoại lệ**: client abort mid-body (`ECONNRESET` + 400 do Fastify gắn), xem 🔴.
- `HtmlExceptionFilter` dùng chung helper. Ở trường hợp abort, nó trả 500 không log (DEBT-237), nên chỉ OAuth filter gây nhiễu log.

**T1**: không đổi code sản phẩm (`git diff -- be/src ':!*.spec.ts'` chỉ có T2/T3). Runbook không còn bẫy "kid đã khác ⇒ dừng" cho emergency.

## 🟡 Nên sửa

Không có 🟡 mới. DEBT-428 (copy/retry ở FE sau khi DELETE idempotent) đã do tech-lead mở; DEBT-430 (snapshot OpenAPI chống lệch) đã mở.

## 💭 Nit

- 💭 `be/src/modules/oauth/consent/consent.service.ts:113-114`: lý do "the pipeline is not schema-cast, so the `userId` filter is cast" dễ hiểu nhầm. Mongoose vẫn cast **filter** khi update dạng pipeline; cái không được cast là **update**. Cast tay vô hại. Nên viết lại một câu cho đúng, hoặc bỏ câu đó vì đoạn `upsertGrant` đã giải thích.
- 💭 Ngữ nghĩa cần biết, có từ trước run 58 và không đổi: `upsertGrant` dùng lại cùng `_id` khi re-consent. Vì vậy một DELETE retry, nếu tới sau khi user đã đồng ý lại, sẽ revoke luôn consent mới và quét family mới. Hướng này an toàn (đúng ý admin), nhưng audit sẽ ghi `alreadyRevoked:false` cho lần retry. Có thể thêm một câu vào `@ApiOperation` hoặc runbook nếu FE làm retry (DEBT-428).

## ✂️ Ponytail

Lean already. Ship. (Diff sản phẩm khoảng 60 dòng: predicate 3 dòng, `revokeById` một round-trip, controller tái dùng `event` cho 2 nhánh audit; test helper trong describe DEBT-151 vừa đủ, không có abstraction thừa.)

---

# Senior Review — Vòng 2 — 2026-10-28 (phạm vi: retry 1 T3, DEBT-238)

## Kết luận: PASS

Không còn 🔴. Không có 🟡 mới, không mở debt. DEBT-238 đóng. T1 và T2 đã PASS ở vòng 1, vòng này không xét lại. Chuyển sang **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)

- `clientErrorStatus` (`be/src/common/filters/oauth-exception.filter.ts:46-64`) khớp đúng fold lần 1 + lần 2:
  - Guard `!(exception instanceof Error) && !types.isNativeError(exception)`. Không dùng `isNativeError` một mình, đúng yêu cầu fold.
  - `fastifyBodyAbort = code === 'ECONNRESET' && status === 400 && message === 'aborted'`, đặt trước nhánh `code`/`FST_`.
  - Không nới thêm gì: dải status 400–499 nguyên số và nhánh `FST_` giữ như vòng 1.
- `html-exception.filter.ts` không đổi. `git diff --stat` của file này rỗng, chỉ có spec đổi.
- Doc comment đúng sự thật. Nó nêu ngoại lệ duy nhất có `code` ngoài `FST_`, nguồn `content-type-parser.js` rawBody `onEnd`, rủi ro còn lại đã chấp nhận, và lý do giữ `instanceof` cho `@fastify/error`.
- Unit đúng mục đích:
  - U-A1 dùng Error native khác realm qua `node:vm` ⇒ 400, `no-store`, 0 log.
  - U-A2 dùng `Object.create(Error.prototype)` khác realm ⇒ 500 + log. U-A3 dùng object thường khác realm ⇒ 500 + log.
  - U-A4 dùng hình dạng `@fastify/error` cùng realm ⇒ 413, 0 log.
  - Có 5 case "look-alike" (404, không statusCode, `socket hang up`, `read ECONNRESET`, `ECONNREFUSED`) và case object thường cùng realm. Không có test sai kỳ vọng 500 cho `Object.create(Error.prototype)` cùng realm, đúng ghi chú fold.
- Int socket thật (`be/test/b74-tester.int-spec.ts`, describe `run 58 retry 1 DEBT-238: client aborts mid-body`):
  - Wrapper được cài lên **prototype trước `bootFullApp`**, vì Nest bind `catch` lúc init. Dev dùng wrapper thường thay `jest.spyOn`, có lý do: `afterEach(restoreAllMocks)` của file sẽ reset spy. `afterAll` khôi phục bản gốc. Lệch nhỏ so với chữ của fold nhưng đúng ý fold.
  - Đếm `"level":50` trên **cả hai** stream (`lines` + `abortLines`). Không lọc theo tên logger.
  - Poll có điều kiện ≤ 5 s và có `expect(caught.length).toBeGreaterThan(0)`, nên không pass rỗng.
  - Kiểm shape `{ECONNRESET, 400, 'aborted'}`, `isNativeError`, `clientErrorStatus(err) === 400`, không có unhandled rejection. Có cả biến thể RST (`resetAndDestroy`) và FIN (`destroy`).
  - Assertion đếm log có sức phân biệt thật. Log retry 1 lần đầu ghi nhận dòng level 50 "non-Error thrown (object)" của `OAuthExceptionFilter` lọt vào chính các stream này khi guard chưa nhận lỗi khác realm.
- Mutation M1–M7 trong log khớp fold:
  - M1 và M5 làm int RED cả hai biến thể, có tên test.
  - M6 ⇒ U-A4 RED. M7 ⇒ U-A2/U-A3 RED.
  - Dev ghi sha256 khôi phục OK. Tôi không chạy lại mutation để không sửa code. Đối chiếu code thì từng mutation đều bị ít nhất một test nêu trên bắt.
- `security-matrix.md` dòng DEBT-238 liệt kê đúng tên các test unit/int hiện có, kể cả ngoại lệ ECONNRESET+400+aborted và guard realm.

**Tôi đã chạy lại:**
- `pnpm -C be test -- oauth-exception html-exception`: 2 suite / 32 test xanh.
- `pnpm -C be typecheck` = 0; eslint `src/common/filters src/modules/ui test/b74-tester.int-spec.ts` = 0.
- `pnpm -C be test:int -- b74-tester` (preflight giữ `vg:int-lock`): 1 suite / 55 test xanh. Log in shape thật ở cả hai biến thể: `rst`/`fin` ⇒ `{"name":"Error","code":"ECONNRESET","statusCode":400,"message":"aborted"}`.

## 🔴 Blocker

Không có. 🔴 vòng 1 (client abort mid-body ⇒ 500 + ERROR log) đã sửa và có tripwire socket thật.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| Client ẩn danh không bơm được ERROR log/5xx qua abort mid-body (B7.4) | OK | Int RST + FIN: 0 dòng level 50 trên cả hai stream. Unit 400 `invalid_request`, `no-store` |
| Lỗi server/SDK không bị giấu thành 4xx (DEBT-238) | OK | Look-alike (404 / thiếu statusCode / message khác / code khác) ⇒ 500 + log. `ESDK_*` và code dạng số ⇒ 500 |
| Phần nới guard không mở cho dữ liệu attacker | OK | `isNativeError` cần slot `[[ErrorData]]`. JSON/form/query chỉ cho ra object/array thường (U-A3). `Object.create(Error.prototype)` khác realm ⇒ 500 (U-A2). Ở prod (không VM), guard tương đương `instanceof` |
| 4xx của Fastify (`@fastify/error`, không native) giữ nguyên | OK | U-A4 413. Hồi quy nguồn thật vòng 1 (`retry 1: Fastify client errors vs real server errors …`) vẫn nằm trong 55 test xanh |
| Exposure | OK | Body 500 không chứa message upstream (unit `upstream detail`). Đường abort trả body chuẩn `invalid_request` |
| Nhánh `HttpException` / `isDependencyUnavailable` / `errorForLog` | Không đổi | Đúng quyết định fold lần 2 |

## 🟡 Nên sửa

Không có.

## 💭 Nit

- 💭 `be/test/b74-tester.int-spec.ts`, `abortMidBody`: sau khi spy được gọi, test chờ cố định `setImmediate` + 50 ms rồi mới đếm level 50. Logger pino ở đây ghi đồng bộ vào `Writable`, và M1/M5 RED cho thấy khoảng chờ đủ. Nếu sau này đổi sang transport async thì khoảng chờ này có thể ngắn quá, dẫn tới false-green. Nhưng việc đổi đó cũng sẽ phá các test log-capture khác của file, nên không mở debt.
- 💭 `console.warn` in shape lỗi trong int là bằng chứng có chủ đích (log retry ghi shape). Chấp nhận, dù output Jest hơi ồn.

## ✂️ Ponytail

Lean already. Ship. Predicate thêm 1 hằng boolean và 1 điều kiện guard. Int test dùng lại `bootFullApp`, `lines` và `Writable` sẵn có, chỉ có một helper cho hai biến thể.
