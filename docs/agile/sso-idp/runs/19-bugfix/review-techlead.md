# Tech Lead Review — 2026-10-12
## Kết luận: PASS (kèm tech-lead fold vào `tasks.md`)

Cả 5 mục đều đã được đối chiếu với code thật (CodeGraph CLI, index đã sync) và đều là lỗi thật. DEBT-060 là lỗi **tiềm ẩn/rủi ro thấp**: từ MongoDB 4.2 trở đi, server tự retry upsert E11000 khi predicate là equality trên đúng các field của unique index, và trường hợp này khớp (`userId,clientId,resource`). Vẫn giữ vì chi phí rẻ, retry idempotent và dùng làm phòng thủ nhiều lớp. Kiến trúc giữ **modular monolith** NestJS, không thêm module/abstraction mới.

## Kiến trúc đề xuất (3 quyết định mở — ĐÃ CHỐT)

### QĐ-1 (DEBT-059) — audit `TOKEN_ISSUED`
- **Vị trí**: `TokenService` vẫn **sở hữu việc dựng event**: tách thành method `recordIssued(...)`, giữ metadata `{resource, scope, refresh}` ở service, nhất quán với refresh-grant. `issueForAuthorizationCode` **không ghi audit nữa**. **Controller gọi** `recordIssued` **SAU** khi re-check `live === true` và **TRƯỚC** `reply.send`.
- Audit lỗi sau re-check OK ⇒ revoke family best-effort (`revokeFamily(...).catch`) rồi rethrow (500). Không trả token, không để family mồ côi.
- **Nhánh `!live`** (cả có và không có family): ghi đúng **một** `TOKEN_ISSUED result:'failure' reason:'session_ended'` (metadata như success). Nhánh có family **giữ thêm** `TOKEN_REVOKED session_ended` vì nó ghi nhận một thao tác revoke thật. Không dùng `TOKEN_REVOKED` cho nhánh không-family vì khi đó không có gì bị revoke.
- **Nhánh Redis lỗi ở re-check**: ghi `TOKEN_ISSUED failure reason:'session_check_failed'` **best-effort** (`.catch(() => undefined)`, không che lỗi gốc), sau đó rethrow (500).
- Các lần từ chối trước mint (check `exists` đầu tiên, PKCE, …) giữ nguyên, ngoài phạm vi run này.

### QĐ-2 (DEBT-001) — `/ready` 503
- **Chọn: trả 503 trực tiếp trong controller** qua `@Res({ passthrough: true })` + `reply.status(503)` rồi `return` body. **KHÔNG** đụng `OAuthExceptionFilter` (không dùng path allowlist hay decorator trong filter global, vì dễ gãy khi đổi prefix/route và mở rộng bề mặt). Mọi exception khác (kể cả lỗi bất ngờ trong `/ready`) vẫn đi qua filter ⇒ OAuth endpoints giữ nguyên format.
- **Exposure**: body là enum cố định `{status:'error'|'ok', mongo:'up'|'down', redis:'up'|'down'}`. Không có message lỗi, host, URI hay stack. Chi tiết lỗi chỉ ghi vào log server (giữ `logger.warn`). Thêm header `Cache-Control: no-store`.

### QĐ-3 (DEBT-005) — Redis fail-fast
- `commandTimeout` = env `REDIS_COMMAND_TIMEOUT_MS` (zod `positiveInt`, mặc định **1000**, max 10000). Giá trị này nhỏ hơn `PING_TIMEOUT_MS` = 1500 nên health không đổi hành vi (ping reject sớm ⇒ `false`).
- `maxRetriesPerRequest`: **`null` → `1`**. Lý do (đã kiểm source ioredis 6.0.0): `commandTimeout` chỉ reject promise, còn command **vẫn nằm trong offlineQueue** và sẽ **được gửi lại khi reconnect**. Nếu giữ `null`, khi Redis down lâu queue tăng vô hạn và replay hàng loạt write cũ (session create, INCR rate-limit…). Với `1`, queue được flush định kỳ bằng `MaxRetriesPerRequestError`. Giữ `enableOfflineQueue:true` (để boot/blip ngắn không vỡ) và giữ `retryStrategy`.
- **Lua** (`defineCommand`: rateLimitHit, consume code/context, revokeAll): timeout áp cho từng EVALSHA/EVAL. Các script đều O(nhỏ) nên 1000ms đủ. Timeout = **kết cục không xác định**: script có thể đã chạy, nhưng mọi caller đã fail-closed (consume code ⇒ 500, code có thể đã mất ⇒ client làm lại flow; revoke idempotent).
- **Rate-limit**: `hit` throw ⇒ guard/`ui.limit` throw ⇒ 5xx. Đây là **fail-closed** (không cho qua) và đã đúng sẵn, không thêm catch nào.
- **Tombstone/liveness** (`isEnded`/`exists`): lỗi propagate ⇒ 500 (đã có test `sessions.int-spec` C9/DEBT-037), giữ nguyên.
- **Test int hiện có**: không int-spec nào boot `RedisModule`/`AppModule`; tất cả tự tạo client `maxRetriesPerRequest:1` ⇒ **không bị ảnh hưởng**. Vì vậy cần tách `buildRedisOptions(config)` (hàm thuần) để test được option thật.

## Điểm mạnh
- Bằng chứng trỏ đúng dòng code. Từng task có repro + RED-first + acceptance đo được + security invariants.
- Phạm vi chặt (chỉ sửa bug), loại trừ có lý do, đề xuất run 20 hợp lý.
- Giữ đúng các quyết định cũ: không rollback password (DEBT-050), `$setIntersection`/`$literal` (DEBT-027), revoke đúng phạm vi family (DEBT-051).

## Vấn đề (đã fold vào tasks.md — không chặn)
- [x] T1: chốt vị trí/event (QĐ-1); xử lý audit lỗi sau re-check (revoke family); hai unit test hiện có ở `token.service.spec.ts` (audit success + audit-fail fail-closed) phải được **chuyển/viết lại** chứ không xoá.
- [x] T2: revoke **cả 3 bước dù bước trước lỗi** (pre-revoke → MARK → SWEEP), gom lỗi đầu tiên, audit failure kèm `failedStep`, rồi rethrow. Lý do: hiện tại một lỗi ở pre-revoke (Mongo) làm bỏ qua việc revoke session (Redis), trong khi link reset đã bị consume nên user không retry được.
- [x] T3: ghi rõ đây là phòng thủ nhiều lớp (Mongo ≥4.2 tự retry); test bằng mock là đủ; chỉ match `code===11000`.
- [x] T4: chốt QĐ-2; test bằng cách stub `MongoService.ping` reject **với `OAuthExceptionFilter` được đăng ký global**. Case Mongo-down ⇒ **đóng luôn DEBT-003**.
- [x] T5: chốt QĐ-3; tách `buildRedisOptions`; test RED gọi tới `127.0.0.1:1` bằng option hiện tại (vẫn pending sau 2.5s), GREEN reject trong ≤ timeout+500ms; thêm 1 test fail-closed cho rate-limit.

## Đề xuất (không bắt buộc → backlog)
- DEBT-063: reset password lỗi revoke ⇒ link đã consume, UI chỉ báo lỗi chung. Cần thông điệp/đường "yêu cầu link mới" và cảnh báo alert cho `AUTH_PASSWORD_RESET failure`.
- DEBT-064: `/ready` public lộ trạng thái up/down; hạn chế ở ingress/network nội bộ (B7 runbook).