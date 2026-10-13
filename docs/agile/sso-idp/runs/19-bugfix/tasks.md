# Tasks — run 19 — bugfix (DEBT là lỗi thật)

> Run **chỉ sửa bug**. Người dùng yêu cầu ưu tiên sửa lỗi trước khi làm FE.
> Tiêu chí chọn: hành vi sai / rủi ro bảo mật / mất dữ liệu / 500 ngoài ý muốn / audit sai.
> **Loại trừ**: refactor/ponytail thuần (DEBT-062, 025, 042), feature/milestone khác (B5/B6/X3/deploy cluster: DEBT-013, 016, 017, 030, 031, 044, 047, 048, 049), test-infra không chặn (DEBT-054).
> Mỗi task viết **test tái hiện lỗi (RED) trước khi sửa**, rồi sửa cho GREEN.
> § trỏ: spec §8 (token contract), §9.8 (logout/revocation), §11 (endpoints), §15 (Security Invariants); plan §6.2 (Redis), §12 (quyết định mở).

---

### [x] Task 1 [BE]: DEBT-059 — `TOKEN_ISSUED` audit ghi trước re-check ⇒ audit nói "issued" dù không trả token
- **Bằng chứng (code thật)**:
  - `be/src/modules/oauth/token/token.service.ts:139` ghi `AuditAction.TOKEN_ISSUED result:'success'` NGAY sau khi mint, TRƯỚC khi controller re-check phiên.
  - `be/src/modules/oauth/token/token.controller.ts:196–215`: sau `issueForAuthorizationCode`, re-check `sessions.exists(sessionRef)`. Nếu `!live` ⇒ `throw TokenError('invalid_grant')` (không trả token); nếu Redis lỗi ⇒ rethrow (500). Cả hai nhánh xảy ra SAU audit `TOKEN_ISSUED success`.
  - Nhánh **không có `familyId`** (non-`offline_access`): khi `!live`, chỉ `throw invalid_grant` — KHÔNG có event bù nào; audit chỉ còn một dòng `TOKEN_ISSUED` sai sự thật.
- **Repro**: gọi `/token` code grant cho phiên vừa bị logout giữa `exists`-check đầu và insert (hoặc stub `sessions.exists`→false sau mint). Kết quả hiện tại: client nhận `invalid_grant` NHƯNG audit log có `TOKEN_ISSUED success`.
- **Acceptance (đo được)**:
  - Test RED tái hiện: với code grant mà re-check từ chối (`!live`), **không** tồn tại bản ghi audit `TOKEN_ISSUED result:'success'` cho request đó; thay vào đó có event phản ánh từ chối (ví dụ `TOKEN_REVOKED`/`session_ended`, áp dụng cho CẢ nhánh có và không có `familyId`).
  - Khi re-check Redis lỗi (500): audit không được khẳng định `TOKEN_ISSUED success`.
  - Happy path (phiên còn sống): vẫn đúng một `TOKEN_ISSUED success`.
  - Full suite xanh (`pnpm test` 131 + `pnpm test:int` 400 = 531), không giảm số test.
- **Security invariants**:
  - Tài sản: tính toàn vẹn của audit trail (INV-25). Actor: user hợp lệ, attacker lợi dụng TOCTOU logout.
  - Invariant: audit `TOKEN_ISSUED success` CHỈ được ghi khi token thực sự rời server tới client. Mọi nhánh từ chối phải để lại dấu vết đúng (fail-closed, không "success" giả).
  - State: mint → (audit) → re-check phiên → trả/ từ chối. Phải không còn khoảng "đã audit issued nhưng chưa chắc trả".
  - Failure: Redis lỗi ở re-check ⇒ 500 fail-closed; audit phản ánh không-phát-hành.
  - Exposure budget: metadata audit tuyệt đối không chứa token/code/secret (giữ như hiện tại: chỉ `resource, scope, refresh`).
- **Quyết định chưa chốt**: (a) dời ghi `TOKEN_ISSUED` từ service sang controller SAU re-check (sạch nhất, nhưng service đang ôm audit refresh-grant — cần giữ nhất quán); hay (b) giữ chỗ hiện tại nhưng bù `TOKEN_REVOKED session_ended` cho cả nhánh không-family. **Đề xuất an toàn**: phương án (a) — chuyển audit issued xuống sau re-check cho code grant; nếu re-check từ chối thì ghi event từ chối. Tech-lead chốt.
- **ĐÃ CHỐT *(tech-lead fold)***:
  - `TokenService.issueForAuthorizationCode` KHÔNG ghi audit nữa; thêm `TokenService.recordIssued(client, data, result, reason?, auditCtx)` (service vẫn sở hữu shape event + metadata `{resource, scope, refresh}`).
  - Controller: re-check `live===true` → `await recordIssued(success)` → `reply.send`. Nếu `recordIssued` ném ⇒ `revokeFamily(familyId,…).catch(()=>undefined)` (nếu có family) rồi rethrow 500 — không trả token (giữ INV-25 fail-closed).
  - `!live`: ghi đúng một `TOKEN_ISSUED result:'failure' reason:'session_ended'` cho CẢ hai nhánh; nhánh có family giữ thêm `TOKEN_REVOKED session_ended` (thao tác revoke thật). Không dùng `TOKEN_REVOKED` cho nhánh không-family. Sau đó `invalid_grant`.
  - Redis lỗi ở re-check: revoke family best-effort (như cũ) + `TOKEN_ISSUED failure reason:'session_check_failed'` best-effort (`.catch`, không che lỗi gốc) → rethrow 500.
  - Test: chuyển 2 unit test hiện có ở `token.service.spec.ts` (“audit TOKEN_ISSUED recorded…”, “audit failure => … fail-closed”) sang `recordIssued` / controller — viết lại, không xoá. Int `token.int-spec.ts:540` (happy path) phải vẫn xanh. Thêm int: stub `sessions.exists` true→false ⇒ 0 `TOKEN_ISSUED success`, 1 `failure session_ended` (cả có/không `offline_access`); stub lần 2 reject ⇒ 500, 0 success; audit success reject ⇒ 500, family (nếu có) `revokedAt != null`.
- **Phụ thuộc**: không. § trỏ: spec §8, §9.8, §15 (INV-25, INV-29).

### [x] Task 2 [BE]: DEBT-055 — reset mật khẩu lỗi hạ tầng SAU `setPassword` ⇒ không có audit `AUTH_PASSWORD_RESET`
- **Bằng chứng (code thật)**: `be/src/modules/authentication/authentication.service.ts:174–200`. `setPassword` (L178) chạy trước; nếu `revokeAllForUser`/`sessions.revokeAllForUser` (L191–193) ném ⇒ exception lan ra TRƯỚC audit (L194). Mật khẩu đã đổi trên DB nhưng **không có bất kỳ event audit nào** (không success, không failure).
- **Repro**: stub `refreshTokens.revokeAllForUser` (hoặc `sessions.revokeAllForUser`) ném lỗi; gọi `resetPassword(token, pw)` với token hợp lệ. Hiện tại: password đã đổi, exception 5xx, audit trống.
- **Acceptance (đo được)**:
  - Test RED: sau khi `setPassword` thành công nhưng revoke ném, tồn tại đúng một audit `AUTH_PASSWORD_RESET result:'failure'` (reason `revoke_failed`) và lỗi vẫn rethrow (vẫn 5xx, KHÔNG rollback password).
  - Happy path: vẫn đúng một `AUTH_PASSWORD_RESET result:'success'`.
  - Audit best-effort: nếu chính lệnh ghi audit failure cũng lỗi, không được nuốt lỗi gốc revoke.
  - Full suite xanh 531, không giảm test.
- **Security invariants**:
  - Tài sản: audit cho thao tác đổi credential nhạy cảm. Actor: owner reset hợp lệ; attacker dùng link rò.
  - Invariant: mọi lần `setPassword` thành công PHẢI để lại đúng một audit phản ánh kết cục (success/failure). Không được rollback password (tránh tái kích hoạt credential có thể đã rò) — giữ nguyên quyết định run 18 (DEBT-050).
  - State: setPassword(OK) → revoke(…) → audit. Nhánh catch của revoke phải audit failure rồi rethrow.
  - Failure: fail-closed (vẫn 5xx), không báo success giả.
  - Exposure budget: audit không chứa mật khẩu/hash/token reset.
- ***(tech-lead fold)***: chạy **cả 3 bước** revoke (pre-revoke families → MARK sessions → SWEEP families) **kể cả khi bước trước lỗi** (mỗi bước try/catch riêng, giữ lỗi ĐẦU TIÊN), vì link reset đã consume ⇒ user không retry được; bỏ qua MARK chỉ vì Mongo lỗi sẽ để session bị chiếm tiếp tục sống. Có lỗi ⇒ audit `AUTH_PASSWORD_RESET failure reason:'revoke_failed' metadata:{failedStep:'pre_revoke'|'sessions'|'sweep'}` (best-effort `.catch`) rồi rethrow lỗi đầu tiên. Thứ tự gọi khi không lỗi giữ nguyên (test DEBT-057 SWEEP phải vẫn xanh). Thêm acceptance: stub pre-revoke ném ⇒ `sessions.revokeAllForUser` VẪN được gọi.
- **Phụ thuộc**: không. § trỏ: spec §9.8, §15 (INV-11/28). Nền tảng: DEBT-050 (run 18).

### [x] Task 3 [BE]: DEBT-060 — `ConsentService.grant` upsert ném `E11000` ⇒ 500 hiếm ở bước consent
- **Bằng chứng (code thật)**: `be/src/modules/oauth/consent/consent.service.ts:122–148`. Một `findOneAndUpdate(..., {upsert:true})` duy nhất trên khóa composite unique; KHÔNG try/catch. Hai upsert đồng thời cùng khóa có thể khiến Mongo ném `E11000 duplicate key` (hành vi đã biết của upsert race) ⇒ lan ra 500.
- **Repro**: mock model `findOneAndUpdate` ném lỗi `{ code: 11000 }` lần đầu, trả document lần hai. Hiện tại: không retry ⇒ 500.
- **Acceptance (đo được)**:
  - Test RED: khi upsert ném `code===11000` một lần, `grant` **retry đúng 1 lần** rồi trả `Consent` hợp lệ (không 500).
  - Lỗi 11000 lần thứ hai (hoặc lỗi không phải 11000): KHÔNG retry, propagate nguyên trạng.
  - Giữ nguyên tính atomic/union-bounded (`$setUnion` ∩ `allowedScopes`, `$literal`) đã khóa ở DEBT-027 — retry không được mở đường over-grant.
  - Full suite xanh 531, không giảm test.
- **Security invariants**:
  - Tài sản: bản ghi consent (phạm vi ủy quyền). Actor: owner (userId từ session, không từ input client).
  - Invariant: retry KHÔNG được làm `grantedScopes` vượt `allowedScopes` (giữ `$setIntersection`); không auto-approve; không mất scope do race.
  - State: grant → (E11000) → retry 1 lần → kết quả hội tụ về một document.
  - Failure: chỉ bắt đúng `code===11000`; các lỗi khác fail-closed. Retry giới hạn 1 để tránh vòng lặp vô hạn khi lỗi bền.
  - Exposure budget: không log nội dung lỗi mongo thô ra response.
- ***(tech-lead fold)***: lỗi **tiềm ẩn** — MongoDB ≥4.2 (compose: `mongo:7`) tự retry upsert E11000 khi filter là equality trên đúng key unique (khớp ở đây). Fix là phòng thủ nhiều lớp (server cũ/edge case); giữ vì rẻ + idempotent. Test bằng mock là đủ (không cần race int). Nhận diện: `(err as {code?:unknown}).code === 11000` — không match theo message. Tách query thành helper private để gọi lại y hệt (cùng pipeline/`$literal`).
- **Phụ thuộc**: không. § trỏ: spec §9.4, §9.5, §15. Nền tảng: DEBT-027 (run 18).

### [x] Task 4 [BE]: DEBT-001 — `/ready` 503 bị `OAuthExceptionFilter` ép `{error:"server_error"}` ⇒ mất chi tiết `mongo`/`redis`
- **Bằng chứng (code thật)**:
  - `be/src/modules/health/health.controller.ts:42–53` ném `ServiceUnavailableException({status:'error', mongo, redis})`.
  - `be/src/app.module.ts:32–37` đăng ký `OAuthExceptionFilter` làm `APP_FILTER` global (`@Catch()` bắt tất cả).
  - `be/src/common/filters/oauth-exception.filter.ts:52–66,69–79`: 503 → `errorCodeForStatus` trả `server_error`; `describe()` chỉ đọc `.message`, nên object `{mongo, redis}` bị bỏ ⇒ body trả về mất chi tiết per-dependency.
- **Repro**: int test gọi `/ready` khi một dependency "down" (stub `safePing` hoặc ping fail) — body hiện tại là `{error:'server_error', error_description:...}`, không có `mongo`/`redis`.
- **Acceptance (đo được)**:
  - Test RED: `/ready` khi Mongo down trả HTTP 503 với body chứa `mongo:'down'` và `redis` tương ứng (không bị rewrite thành `server_error`).
  - `/ready` khi cả hai up vẫn 200 `{status:'ok', mongo:'up', redis:'up'}`.
  - Các route OAuth khác (`/token`,…) vẫn giữ format RFC 6749 `{error,error_description}` — filter không bị vô hiệu hóa ngoài health.
  - Full suite xanh 531, không giảm test.
- **Security invariants**: N/A trực tiếp — endpoint health không chạm trust boundary (không authz/secret). Lưu ý exposure: `/ready` chỉ phơi trạng thái up/down của dependency (đã được chấp nhận ở spec health), KHÔNG được thêm chi tiết nhạy cảm (host/credential/stack trace) vào body.
- **Quyết định chưa chốt**: (a) loại trừ route health khỏi `OAuthExceptionFilter` (ví dụ `@Catch(HttpException)` bỏ qua, hoặc check path/route trong filter); hay (b) trả 503 trực tiếp qua `reply` trong controller (không ném exception). **Đề xuất an toàn**: (a) cho filter bỏ qua các route health (`/health`,`/ready`) để giữ format OAuth cho phần còn lại; tech-lead chốt cách nhận diện route (path allowlist vs decorator).
- **ĐÃ CHỐT *(tech-lead fold)***: phương án **(b)** — `readiness(@Res({ passthrough: true }) reply)`: khi down ⇒ `reply.status(503)` + `return {status:'error', mongo, redis}`; **không** sửa `OAuthExceptionFilter` (không allowlist path/decorator). Body chỉ enum cố định `'up'|'down'`, không message/host/stack; header `Cache-Control: no-store`. Chi tiết lỗi chỉ ở log server (`logger.warn` hiện có). Bỏ import `ServiceUnavailableException`.
  - Test (int mới hoặc trong file int phù hợp): app Nest với `HealthController` + **`APP_FILTER` OAuthExceptionFilter** đăng ký thật; `MongoService.ping`/`RedisService.ping` stub. Case: mongo down, redis down, cả hai up. Assert body không có `error`/`error_description`. Một route ném HttpException trong cùng app vẫn ra `{error,error_description}`.
  - Case Mongo-down ⇒ **đóng luôn DEBT-003**.
- **Phụ thuộc**: không. § trỏ: spec §11 (endpoints, health). Liên quan: DEBT-003 (đóng cùng task này).

### [x] Task 5 [BE]: DEBT-005 — Redis down treo request do `maxRetriesPerRequest:null`, không `commandTimeout`
- **Bằng chứng (code thật)**: `be/src/database/redis/redis.module.ts:22–26`: client dùng `maxRetriesPerRequest:null`, KHÔNG set `commandTimeout`. Lệnh trên đường request (rate-limit, session `exists`, re-check `/token`, tombstone) sẽ **queue vô hạn** khi Redis down/reconnecting. `health.controller.ts:24–29,62–64` đã tự vá riêng cho `/ready` bằng `Promise.race` timeout — xác nhận request-path chưa có fail-fast.
- **Repro**: int test với Redis dừng (hoặc địa chỉ không phản hồi) gọi một route dùng Redis trên đường request; hiện tại request treo tới khi socket tự lỗi (rất lâu) thay vì fail-fast.
- **Acceptance (đo được)**:
  - Test RED/verify: khi Redis không phản hồi, lệnh Redis trên đường request **fail-fast trong ngưỡng cấu hình** (`commandTimeout` từ env, mặc định đề xuất ≤ 1–2s) thay vì treo; request trả lỗi có kiểm soát (fail-closed 5xx/503) chứ không treo quá ngưỡng.
  - Happy path (Redis up): mọi test hiện có vẫn xanh (không làm chậm/đứt lệnh bình thường).
  - `/ready` vẫn trả 503 với chi tiết (không hồi quy DEBT-001/Task 4).
  - Full suite xanh 531, không giảm test.
- **Security invariants**:
  - Tài sản: tính sẵn sàng (availability) và tính fail-closed của các kiểm tra bảo mật phụ thuộc Redis (rate-limit, session liveness, tombstone logout).
  - Actor: attacker gây tải/ngắt Redis để DoS hoặc để "fail-open" bỏ qua kiểm tra bảo mật.
  - Invariant: Redis timeout/down ⇒ các kiểm tra bảo mật **fail-closed** (từ chối), KHÔNG fail-open bỏ qua rate-limit/liveness. Request không được treo quá `commandTimeout`.
  - State: lệnh Redis → (timeout) → lỗi có kiểm soát → handler quyết định fail-closed.
  - Failure: phân biệt rõ timeout vs lỗi khác; không để lệnh mồ côi treo tài nguyên (giữ pattern swallow eventual rejection như health).
  - Exposure budget: không leak địa chỉ/credential Redis ra response/log mức client.
- **Quyết định chưa chốt**: giá trị `commandTimeout` (đề xuất đọc từ env, mặc định an toàn 1500ms khớp `PING_TIMEOUT_MS`); có cần `enableOfflineQueue:false` cho client request-path hay giữ nguyên để không vỡ khởi động? **Đề xuất an toàn**: thêm `commandTimeout` cấu hình-được, giữ `maxRetriesPerRequest:null` cho reconnect, kiểm từng call-site bảo mật xử lý lỗi fail-closed. Tech-lead chốt giá trị + phạm vi (plan §6.2).
- **ĐÃ CHỐT *(tech-lead fold)*** (đã kiểm source ioredis 6.0.0):
  - Env `REDIS_COMMAND_TIMEOUT_MS` (zod `positiveInt`, default **1000**, max 10000) → `DatabaseConfig.redisCommandTimeoutMs`; thêm vào `.env.example`. < `PING_TIMEOUT_MS`(1500) nên `/ready` không đổi hành vi.
  - `maxRetriesPerRequest: null → 1`. Lý do: `commandTimeout` chỉ reject promise, command **vẫn trong offlineQueue và được gửi lại khi reconnect** ⇒ với `null`, Redis down lâu = queue vô hạn + replay hàng loạt write cũ. `1` flush queue định kỳ (`MaxRetriesPerRequestError`). Giữ `enableOfflineQueue:true` (boot/blip ngắn), giữ `retryStrategy`, `lazyConnect:false`.
  - Tách hàm thuần `buildRedisOptions(cfg): RedisOptions` trong `redis.module.ts` (export) để test option thật; cập nhật doc comment module + comment `PING_TIMEOUT_MS` (không còn “queues forever”).
  - Lua (`defineCommand`): timeout áp per EVALSHA; script đều nhỏ. Timeout = **kết cục không xác định** (script có thể đã chạy) — caller hiện tại đều fail-closed (consume ⇒ 500; revoke idempotent). KHÔNG thêm retry ở caller.
  - Rate-limit: `hit` throw ⇒ guard/`ui.limit` 5xx = fail-closed (không cho qua). KHÔNG thêm catch cho-qua ở bất kỳ call-site bảo mật nào.
  - Test int hiện có không boot `RedisModule` (tự tạo client `maxRetriesPerRequest:1`) ⇒ không ảnh hưởng.
  - Test RED/GREEN (int): client từ `buildRedisOptions` trỏ `redis://127.0.0.1:1` (`retryStrategy` mặc định) ⇒ `get('k')` reject trong ≤ timeout+500ms (RED: option cũ vẫn pending sau 2.5s — dùng `Promise.race`, swallow rejection, `disconnect()` cuối test). Thêm: `RateLimitService.hit` với client đó ⇒ reject (fail-closed, không `allowed:true`). Unit: zod default/override của env.
- **Phụ thuộc**: chạy sau Task 4 (cùng chạm health). § trỏ: plan §6.2, spec §6.2, §15.

---

## Đề xuất run 20 (lỗi thật còn lại — KHÔNG làm ở run 19)

| DEBT | Vì sao là lỗi/rủi ro thật | Vì sao hoãn khỏi run 19 |
|---|---|---|
| DEBT-029 + DEBT-039 | `/token`, `/revoke`, `/introspect` chưa `@RateLimit` ⇒ brute-force secret/code và DoS CPU (Argon2 mỗi call introspect). `RateLimitGuard` đã sẵn, chỉ thiếu áp. | Cần chốt nguồn khóa: `client_id` có thể ở body (`client_secret_post`) hoặc Authorization header (`client_secret_basic`) — guard hiện chỉ đọc body field; cần mở rộng key để phủ cả basic auth. Quyết định thiết kế → tách run. |
| DEBT-007 | `LocalKeyProvider.rotate()` xóa PEM trước khi ghi `keys.json` ⇒ lỗi giữa chừng hỏng state key. | Dev-only (KeyProvider thật thay sau), mức nghiêm trọng thấp hơn; fix atomic-rename gọn nhưng không chặn. |
| DEBT-021 | `ClientCredentialService.rotateSecret` không atomic ⇒ hai rotate đồng thời có thể trùng `version` (index không unique). | Gắn với admin API thật (B6.3) và cần thêm unique index `(clientId, version)` — có tính migration. |
| DEBT-053 | spec.md §11 còn dòng `/introspect` cũ trùng (≈L460); nhãn "(Task 3)" ở inv.29. **Sửa tài liệu rẻ.** | Không phải lỗi runtime; gom chung đợt dọn doc (có thể kèm DEBT-061) để không mở spec giữa run bug-fix code. |
| DEBT-061 | Runbook §2b `syncIndexes` drop index cũ trước build; lỗi E11000 ⇒ Consent không còn unique, runbook chưa ghi trạng thái/phục hồi. **Sửa tài liệu rẻ.** | Việc deploy M4; liên quan vận hành, không chặn code. Có thể gom với DEBT-053 thành 1 task doc. |

> **Không chọn (ngoài phạm vi "lỗi thật")**: DEBT-003/004 (test/CI milestone sau), 006/008 (hardening proxy/cookie — X3), 013/016/017/030/031/032/042/044/047/048/049 (feature/milestone B5/B6/deploy), 025/062 (ponytail refactor), 050/051/052/056/057/058 (đã đóng run 18), 054 (test-infra, không chặn — nên làm khi dựng CI thật).
