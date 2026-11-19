# Run 97 — ops/security hardening (M8, lane BE/ops)

Tiêu chí: dùng được ở production; người dùng ủy quyền "việc nào tự quyết được thì làm" (2026-11-18). Chọn từ top 10 của `runs/96-deps-backlog/backlog-triage.md` (phần làm được trong repo). Đọc trước: `STATUS.md`, `spec.md`, `plan.md` §12, `runbook-ops.md`, `runbook-deploy.md`, `backlog.md` các DEBT dưới đây.

## Ràng buộc (như các run trước)
- Hạ tầng chung: KHÔNG compose up / tạo container / FLUSH / drop DB không phải của mình / restart container.
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret/PEM header. Giá trị trông như secret trong test dựng lúc chạy (gitleaks).
- Không kill process không phải mình tạo (ngoại lệ tiptap vite :5173). Không npx/dlx gói lạ; dependency mới cần lý do + quy tắc 14 ngày (`minimumReleaseAge`).
- Harness pentest đầy đủ chỉ chạy SAU E2E; SMTP `220` trước mỗi lô cần thư.
- Đọc code qua CodeGraph MCP; terminal = Git Bash.

## T1 [BE] DEBT-072 (🟡) — trần toàn cục xác thực client theo `client_id`
Rate limit client auth hiện theo IP / client_id+IP ⇒ botnet xoay IP vẫn ép Argon2 hàng loạt (DoS). Thêm giới hạn toàn cục theo `client_id` (ngưỡng cao, cửa sổ ngắn), fail-closed hợp lý (429 + `Retry-After`), không mở đường khoá client hợp lệ vĩnh viễn (DoS ngược) — tech-lead cân bằng. Metric + alert khi chạm trần.

## T2 [BE] DEBT-126 (🟡) — audit/metric khi admin bị từ chối
401 `invalid_token` / 403 `forbidden` / `insufficient_scope` / `step_up_required` trên admin API chưa audit/alert. Audit `result:'failure'` (không token; chỉ `sub` khi đã verify), counter theo lý do, alert tỉ lệ. Không để audit thành vector DoS ghi Mongo (giới hạn/gộp).

## T3 [BE/ops] DEBT-218 (🟡) — counter bảo mật không phụ thuộc audit thành công
`sso_audit_events_total`, rotations/reuse chỉ tăng khi ghi audit OK ⇒ Mongo lỗi lúc reuse thì alert im. Tăng counter trước/độc lập với ghi audit (chấp nhận lệch), có counter lỗi ghi audit.

## T4 [BE/ops] DEBT-280 (🟡) — fe-admin Redis ở production
fe-admin dùng chung Redis với IdP (prefix `fea:`), `SESSION_REDIS_URL` chưa bắt buộc TLS ở production. Production: bắt buộc `rediss://` (env validation fe-admin, fail khi boot), runbook-deploy: ACL user chỉ `~fea:*` (hoặc Redis riêng), kiểm ACL ở smoke nếu làm được không tạo container.

## T5 [BE/ops] DEBT-618 (🟡) — app tự phát alert `ADMIN_RECOVERED`
Alert chỉ dựa vào dòng JSON stdout của CLI chạy tay. App phát metric từ audit `ADMIN_RECOVERED` mới (định kỳ đọc collection audit, có chỉ mục phù hợp; hoặc change stream nếu replica set — tech-lead chọn) + alert Prometheus + runbook.

## Gộp khi đóng run 96 (orchestrator)
DEBT-694…700 từ log run 96 vào backlog; DEBT-585 đóng (runbook-deploy §7 + dependabot.yml đã sửa run 96).

## Thứ tự
Tech-lead fold (chỉ đọc code, viết docs) có thể chạy song song với gate run 96. Code run 97 bắt đầu SAU khi run 96 commit.

## Tech-lead (2026-11-19)

- **Kết luận: PASS có điều chỉnh**, xem `review-techlead.md`. Khi D97.x và mô tả task ở trên mâu thuẫn, làm theo D97.x.
- T5 đổi hướng: **không** dùng change stream, dùng poll một aggregate nhỏ trên index `{action:1}` có sẵn (D97.18).
- T4 đổi hướng: production nên dùng **Redis riêng** cho fe-admin (TLS + user ACL), không chung instance IdP. Chung instance chỉ chấp nhận khi có user ACL `~fea:*` (D97.22).
- Chia lô ở D97.25: A (fe-admin) ∥ B (audit/metric) → C (client auth) → D (gate).

## Quyết định D97.x (tech-lead fold, 2026-11-19)

Tiêu chí: dùng được ở production (người dùng ủy quyền). Số dòng theo working tree lúc fold (trên `8641174` + thay đổi run 96 chưa commit). Dev đọc lại vị trí trước khi sửa.

### T3 DEBT-218 — counter không phụ thuộc ghi audit (làm trước, T2/T5 dựa vào)

**D97.1 Vị trí.** `be/src/modules/security/audit/audit.service.ts:128` `record()`.
- Hiện tại: `create` ở :139, rồi mới `observeAuditEvent` ở :142.
- Mongo lỗi ⇒ `sso_audit_events_total` (và `sso_signing_key_rotations_total`) không tăng. `SsoTokenReuseDetected`/`SsoEmergencyKeyRotation` im lặng.
- 83 call site đều đi qua `record()` ⇒ sửa **một chỗ**, không sửa caller.

**D97.2 Thứ tự mới trong `record()`.**
1. Dựng `event` (như cũ, gồm `eventId`).
2. `observeAuditEvent(event)` trong `try/catch` (như cũ). Đếm **trước** khi ghi.
3. `try { await create(event) } catch (err)`:
   - `observeAuditWriteFailure(event.action)`;
   - `logger.error({ alert: ALERT_ACTIONS.has(action), action, eventId, auditWriteFailed: true }, 'audit write failed')`. Không metadata, không message của lỗi Mongo (có thể chứa giá trị document);
   - `throw err`. Giữ fail-closed INV-25: caller vẫn 5xx như cũ.
4. Nhánh alert (`ALERT_ACTIONS` log `audit alert` + listener) giữ **sau** `create`, như cũ. Ghi lỗi thì dòng `auditWriteFailed` ở bước 3 thay cho nó.
- Chấp nhận lệch: counter có thể lớn hơn số document trong `auditlogs`. Lệch đúng bằng `sso_audit_write_failures_total`.

**D97.3 Metric** (`be/src/common/metrics/metrics.ts`, mẫu module-level như D95.11).

| Tên | Kiểu | Label | Hàm |
|---|---|---|---|
| `sso_audit_write_failures_total` | Counter | `action` ∈ `AuditAction` (44 giá trị) | `observeAuditWriteFailure(action)` |

- Khởi tạo 0 cho mọi action (vòng `for` như `auditEvents`). Action lạ ⇒ bỏ qua.
- Đổi help của `sso_audit_events_total` thành: "Audit events recorded, by action and result (counted before the write; failed writes are also in sso_audit_write_failures_total)." Sửa JSDoc `observeAuditEvent` ("PERSISTED" ⇒ "recorded, before the write").
- Help của `sso_signing_key_rotations_total` giữ.

**D97.4 Alert** `SsoAuditWriteFailed` (critical): `sum(increase(sso_audit_write_failures_total[5m])) > 0`. Summary trỏ runbook-ops §14 (D97.24). `alerts.test.yml`: một case có lỗi ⇒ fire, một case 0 ⇒ không. Thêm case `SsoTokenReuseDetected` khi counter tăng mà failure cũng tăng (vẫn fire). Không sửa rule cũ.

**D97.5 Test T3.**
- Unit `audit.service.spec.ts`:
  - model `create` reject ⇒ `record` reject;
  - `sso_audit_events_total{action=TOKEN_REUSE_DETECTED,result=failure}` +1;
  - `sso_audit_write_failures_total{action=TOKEN_REUSE_DETECTED}` +1;
  - log không chứa metadata;
  - `create` OK ⇒ failure counter không đổi.
- Mutation tay (ghi trong log): đưa `observeAuditEvent` về sau `create` ⇒ case reject đỏ.
- Int: không cần file mới. `metrics.int-spec` phải còn xanh (help đổi, tên giữ).

### T2 DEBT-126 — audit/metric khi admin bị từ chối

**D97.6 Vị trí.**
- `be/src/modules/identity/tenant-context/tenant-context.ts`, `AdminTokenGuard.canActivate` :161.
  - Các throw: :178 (không bearer), :184 (verify lỗi), :187 (`aud`≠admin / thiếu `sid`), :201 (không live), :204 (client hết admin-capable), :207 (`insufficient_scope`), :213/:221 (`forbidden`).
- `StepUpGuard` :306 (`step_up_required`).
- `AdminAuthErrorFilter` (`admin-auth.errors.ts:68`): mọi `AdminAuthError` của 5 controller admin đi qua đây, kể cả `forbidden` ném từ handler (`assertSuperAdmin`…).

**D97.7 Metric ở filter, không audit ở filter.**

| Tên | Kiểu | Label | Hàm |
|---|---|---|---|
| `sso_admin_auth_denied_total` | Counter | `reason` ∈ `ADMIN_DENY_REASONS = ['invalid_token','insufficient_scope','forbidden','step_up_required']` | `observeAdminAuthDenied(reason)` |

- `AdminAuthErrorFilter.catch`: `if (err.status === 401 || err.status === 403)` ⇒ `observeAdminAuthDenied(String(err.body.error))` trong `try/catch` (metric không bao giờ làm hỏng response). 400/404/409 không đếm.
- Label đúng 4 giá trị, khởi tạo 0. Không label route/tenant/sub.
- Wire response **không đổi**. Opaque như cũ.

**D97.8 Audit chỉ khi token đã verify chữ ký** (có `sub` thật). Token thiếu hoặc sai chữ ký (:178, :184) ⇒ chỉ metric. Kẻ không có token hợp lệ không tạo được document Mongo.
- Thêm `AuditAction.ADMIN_ACCESS_DENIED` (`result:'failure'`). **Không** vào `ALERT_ACTIONS`: alert qua metric (D97.10).
- Field audit:
  - `actorId = claims.sub`, `clientId = claims.client_id`;
  - `tenantId = seen.client.tenantId` khi đã có client, không thì bỏ;
  - `metadata = { reason, method, route }`. `route` là template route (cùng nguồn label `route` của `metrics.http.ts`), không phải URL thô.
- `reason` nội bộ (chi tiết hơn wire, chỉ nằm trong audit): `wrong_audience` (:187), `not_live` (:201), `not_admin_capable` (:204), `insufficient_scope` (:207), `forbidden` (:213/:221).
- `not_live` quan trọng nhất: AT admin bị replay sau logout/thu hồi.
- `step_up_required` **không** audit: đây là luồng UX bình thường của fe-admin (AT > 5' ⇒ đăng nhập lại), audit sẽ thành nhiễu. Chỉ metric.
- Handler ném `forbidden` (sau guard) không audit ở run này. Principal đã hợp lệ; controller audit thao tác của mình khi cần.

**D97.9 Chống DoS ghi Mongo (bắt buộc), trong một helper `auditDenied(...)` của guard.**
1. Dedupe: `SET adm_deny:{<sha256(sub)>}:<reason> 1 NX EX 900` (qua `RedisService`). Key đã có ⇒ bỏ audit. ≤ 1 document / sub / reason / 15'.
2. Trần toàn cục: `RateLimitService.hit({ name: 'admin-deny-audit', limit: 60, windowSec: 60 }, { account: 'global' })`. Vượt ⇒ bỏ audit. Tổng ≤ 60 document/phút dù có nhiều tài khoản. Dùng script `rateLimitHit` có sẵn, không thêm Lua.
3. `await audit.record(...)`.
- Cả 3 bước trong `try/catch`. Redis hoặc Mongo lỗi ⇒ `logger.warn('admin deny audit skipped: <err.name>')`, **vẫn ném đúng `AdminAuthError` ban đầu**.
- Không biến 401/403 thành 5xx: request đã bị từ chối, audit là best-effort. Đây là ngoại lệ có chủ đích với INV-25, vì INV-25 áp cho thao tác nhạy cảm *thành công*.
- Lỗi ghi audit vẫn được T3 đếm ở `sso_audit_write_failures_total`.
- Thời gian thêm vào mỗi lần từ chối: ≤ 1 round-trip Redis khi dedupe trúng. Request thành công không chậm thêm.
- Ở :201, `isAccessTokenLive` lỗi hạ tầng vẫn propagate (5xx) như cũ. Chỉ nhánh `!live` mới audit.

**D97.10 Alert** (`ops/prometheus/alerts.yml`, warning cả hai, trỏ runbook-ops §15):
- `SsoAdminAccessDenied`: `sum(increase(sso_admin_auth_denied_total{reason=~"forbidden|insufficient_scope"}[15m])) >= 10`. Dò quyền bằng token đã xác thực.
- `SsoAdminInvalidTokenHigh`: `sum(rate(sso_admin_auth_denied_total{reason="invalid_token"}[5m])) > 0.2`, `for: 10m` (≈ 12/phút liên tục 10').
- Không dùng tỉ lệ trên tổng request admin: traffic admin thấp nên tỉ lệ dao động mạnh (bài học DEBT-223). Dùng ngưỡng tuyệt đối, chỉnh theo traffic thật.
- `alerts.test.yml`: mỗi rule một case fire, một case dưới ngưỡng. Thêm case `step_up_required` tăng mạnh ⇒ không alert.

**D97.11 Test T2.**
- Unit `admin-guards.spec.ts` (constructor guard thêm `AuditService`, `RedisService`/`RateLimitService` ⇒ sửa chỗ dựng guard):
  - token sai chữ ký ⇒ 401, `record` không được gọi;
  - token `not_live` ⇒ 401, `record` một lần với `reason:'not_live'`, `actorId=sub`;
  - lần hai cùng sub ⇒ không gọi (dedupe);
  - Redis reject ⇒ vẫn 401, không 5xx;
  - `record` reject ⇒ vẫn 401/403;
  - `insufficient_scope`/`forbidden` ⇒ đúng reason.
- Unit filter: 401/403 tăng counter theo `body.error`; 404/409/400 không tăng.
- Int `run97-admin-denied.int-spec.ts` (full app):
  - (a) bearer rác ×20 ⇒ 20×401, `sso_admin_auth_denied_total{reason="invalid_token"}` +20, **0** document `ADMIN_ACCESS_DENIED`;
  - (b) AT admin hợp lệ rồi logout, gọi ×5 ⇒ 401, đúng **1** document `not_live`, document không có trường token/`authorization`;
  - (c) user thường (token RP, `aud` khác) ⇒ 401 + 1 document `wrong_audience`;
  - (d) admin thiếu `admin.write` ⇒ 403 `insufficient_scope` + 1 document;
  - (e) token step-up quá hạn ⇒ 403 `step_up_required`, counter +1, 0 document.
  - Dọn key `adm_deny:*` của test (chỉ key mình tạo, DB Redis int).
- Mutation tay: bỏ bước dedupe ⇒ (b) đỏ (5 document).

### T1 DEBT-072 — trần toàn cục xác thực client theo `client_id`

**D97.12 Vị trí.**
- `be/src/modules/clients/client-authentication.service.ts:112` `authenticate`: reserve per-IP :124–131, `findByClientId` + Argon2, refund :142.
- `be/src/modules/security/rate-limit/rate-limit.service.ts`: `RESERVE_SCRIPT` :62, `reserve` :162, `refund` :187.
- Map 429 ở `be/src/modules/oauth/token/token.controller.ts:606`, giữ nguyên.
- Config: `be/src/config/validation.schema.ts:174–176`, `configuration.ts:91–93,207–208`.

**D97.13 Thiết kế: bucket thất bại toàn cục theo client, có miễn trừ nguồn đã từng thành công.**
- Chỉ đếm *thất bại* (thành công thì refund, như bucket per-IP) ⇒ client hợp lệ không tự chạm trần. Nhưng botnet đốt hết trần bằng secret sai thì RP thật bị 429 (DoS ngược).
- Chặn DoS ngược: nguồn (IP) đã xác thực **thành công** cho client đó trong 7 ngày được **bỏ qua** bucket toàn cục. Nó vẫn chịu bucket per-IP / per-client+IP cũ.
  - Backend RP thường có IP ổn định ⇒ không bị khoá khi bị tấn công.
  - Kẻ tấn công không giả được IP nguồn khi `TRUST_PROXY` đúng (runbook-deploy §5).
- Rủi ro còn lại (chấp nhận, ghi runbook, DEBT-704): RP chưa thành công lần nào từ IP hiện tại trong 7 ngày (IP mới, RP ít traffic) vẫn có thể bị 429 trong lúc bị tấn công. Xử lý ở proxy/WAF theo runbook-ops §16.

**D97.14 Thứ tự mới trong `authenticate`** (chỉ `basic`/`post`; `none` không đổi).
1. Reserve per-IP như cũ (:124). Bị chặn ⇒ 429, không đụng Mongo.
2. `client = findByClientId` (Mongo, rẻ). Đã nằm trước Argon2, không đổi timing.
3. Reserve toàn cục bằng script mới `rateLimitReserveGlobal`:
   - KEYS = [`gKey`, `okKey`, `logKey`]; ARGV = [limit, windowMs].
   - Client tồn tại: `tag = sha256(clientId)`, `gKey = rl:client-auth-g:{<tag>}`, `okKey = rl:client-auth-g:{<tag>}:ok:<sha256(ip)>`, `logKey = rl:client-auth-g:{<tag>}:logged`.
   - Client **không tồn tại**: một bucket chung `tag = 'unknown'`, không có `okKey` (truyền key không bao giờ được set). Không tạo key theo client_id ngẫu nhiên của kẻ tấn công.
   - Lua:
     - `okKey` tồn tại ⇒ `{0,0,0}` (miễn, không INCR);
     - `GET gKey >= limit` ⇒ chặn, trả `{1, pttl, first}`, `first` = kết quả `SET logKey 1 NX PX pttl` (1 lần / cửa sổ);
     - không thì INCR + PEXPIRE lần đầu ⇒ `{0,0,0}`.
   - Bị chặn ⇒ refund best-effort bucket per-IP của bước 1 (request này không chạy Argon2), rồi `throw new ClientAuthRateLimitedError(retryAfterSec, 'client' | 'unknown_client')`.
4. Argon2 (`verifySecret`) như cũ, luôn chạy.
5. Thất bại ⇒ giữ cả hai reservation.
6. Thành công ⇒ refund per-IP như cũ + script `rateLimitClientOk` (KEYS = [`gKey`, `okKey`]):
   - DECR `gKey` nếu > 0 (như `REFUND_SCRIPT`);
   - `SET okKey 1 PX 604800000`.
   - Best-effort: lỗi chỉ warn như `refund()` hiện tại.
- Mỗi bước một script, các key cùng hash tag (Cluster không hỗ trợ, DEBT-013, nhưng giữ quy ước).
- Hai script per-IP và toàn cục **không** atomic với nhau. Chấp nhận được: mỗi script tự atomic nên Argon2 vẫn ≤ limit/cửa sổ cho mỗi bucket.
- Redis lỗi ở bước 3 ⇒ propagate như reserve hiện tại (503 `temporarily_unavailable`, fail-closed).
- `ClientAuthRateLimitedError` thêm `readonly scope: 'source' | 'client' | 'unknown_client'`. Per-IP cũ = `'source'`.

**D97.15 Ngưỡng** (cửa sổ = `RATE_LIMIT_WINDOW`, như bucket cũ; env `positiveInt` có default, không bắt buộc set):
- `CLIENT_AUTH_FAIL_GLOBAL_MAX` default **100**: số lần xác thực sai / client / cửa sổ, cộng mọi IP không được miễn.
  - Per-client+IP hiện là 10 ⇒ cần ≥ 10 IP mới chạm.
  - 100 Argon2 × ~50–100 ms ≈ ≤ 10 s CPU/phút/client.
- `CLIENT_AUTH_FAIL_UNKNOWN_MAX` default **300**: bucket chung cho client_id không tồn tại (dummy Argon2).
- TTL miễn trừ 7 ngày là **hằng** `TRUSTED_SOURCE_TTL_MS` (YAGNI env).
- Validation spec thêm default + từ chối `0`/âm, như `CLIENT_AUTH_FAIL_*` hiện có (`validation.schema.spec.ts:125`). Thêm vào `.env.example` của be (giá trị mặc định + comment).

**D97.16 Metric, log, alert.**

| Tên | Kiểu | Label | Hàm |
|---|---|---|---|
| `sso_client_auth_rate_limited_total` | Counter | `scope` ∈ `CLIENT_AUTH_LIMIT_SCOPES = ['source','client','unknown_client']` | `observeClientAuthRateLimited(scope)` |

- Tăng ở service, ngay trước khi ném `ClientAuthRateLimitedError` ⇒ `/token`, `/revoke`, `/introspect` đều được đếm. `sso_token_endpoint_errors_total` giữ như cũ.
- Log chỉ khi script trả `first = 1`:
  - client tồn tại ⇒ `logger.warn('client-auth global limit reached', { clientId })`. clientId là định danh đã đăng ký, không phải input tuỳ ý;
  - client không tồn tại ⇒ `{ clientId: '(unknown)' }`;
  - ≤ 1 dòng / client / cửa sổ. Không IP, không secret.
- Alert `SsoClientAuthGlobalLimit` (warning): `sum by (scope) (increase(sso_client_auth_rate_limited_total{scope=~"client|unknown_client"}[5m])) > 0`, trỏ runbook-ops §16. `scope="source"` không alert (brute-force một IP đã bị chặn, nhiễu).
- `alerts.test.yml`: case `client` fire, case chỉ `source` không fire.

**D97.17 Test T1.**
- Unit `client-authentication.service.spec.ts`:
  - thứ tự gọi: per-IP → find → global → verify;
  - global chặn ⇒ không Argon2, per-IP được refund, lỗi có `scope:'client'`;
  - unknown client dùng key `{unknown}`;
  - thành công gọi `rateLimitClientOk`;
  - Redis lỗi ở global ⇒ propagate.
- Int: mở rộng `be/test/client-auth-rate-limit.int-spec.ts` (đã có hạ tầng `TRUST_PROXY` + XFF ở :484), app riêng `CLIENT_AUTH_FAIL_GLOBAL_MAX=3`, `CLIENT_AUTH_FAIL_UNKNOWN_MAX=3`:
  - (a) 3 XFF khác nhau, mỗi XFF 1 lần sai ⇒ lần 4 từ XFF thứ 4 ⇒ 429 + `Retry-After` ≥ 1, counter `{scope="client"}` +1;
  - (b) XFF đã từng thành công ⇒ vẫn 200 khi bucket toàn cục đầy (miễn trừ, chống DoS ngược);
  - (c) XFF mới, secret **đúng**, khi bucket đầy ⇒ 429 (hành vi đã chấp nhận, khoá bằng test);
  - (d) client_id ngẫu nhiên ×4 từ 4 XFF ⇒ lần 4 429 `scope="unknown_client"`, không có key Redis chứa client_id thô;
  - (e) cửa sổ hết (xoá đúng key của test) ⇒ 200;
  - một case qua `/introspect`.
- Không cần check harness mới. Harness chạy từ một IP nên bucket per-IP (30/10) luôn chặn trước trần toàn cục 100. Tester xác nhận các check rate-limit client auth hiện có vẫn xanh.
- Mutation tay: bỏ nhánh `okKey` trong Lua ⇒ (b) đỏ.

### T5 DEBT-618 — app tự phát alert `ADMIN_RECOVERED`

**D97.18 Chọn poll, không change stream.** Lý do:
- change stream cần replica set ở **mọi** môi trường test (Mongo dev/int dùng chung có thể standalone) và cần lưu resume token;
- mỗi replica IdP nhận event trùng;
- event cực hiếm (vài lần/năm).
- Production có rs (run 79) nhưng lợi ích không đáng. Poll stateless, an toàn khi restart/nhiều replica.

**D97.19 Thiết kế.** File mới `be/src/modules/security/audit/audit-alert-watch.ts`, provider `AuditAlertWatch` trong `SecurityModule` (`security.module.ts:9`, cùng `AuditService`).
- `onApplicationBootstrap`: `void this.poll()` (không chặn boot), rồi `setInterval(poll, 60_000).unref()`. `onModuleDestroy`: `clearInterval`.
- `poll()`:
  - `auditModel.aggregate([{ $match: { action: { $in: ['ADMIN_RECOVERED','ADMIN_BOOTSTRAPPED'] } } }, { $group: { _id: '$action', ts: { $max: '$timestamp' } } }])`, `maxTimeMS: 5000`;
  - dùng index `{action:1}` có sẵn (`audit-log.schema.ts:37`) ⇒ **không thêm index**, không cần bước `db:sync-indexes`;
  - kết quả ⇒ `setAuditAlertLastEvent(action, tsSeconds)`.
- Lỗi ⇒ `logger.warn('audit alert poll failed: <err.name>')`, giữ giá trị gauge cũ, không throw.
- Không chồng lệnh: cờ `running` bỏ tick nếu tick trước chưa xong.
- Sửa comment `ALERT_ACTIONS` (`audit-action.enum.ts:79–83`): "app poll ⇒ gauge ⇒ alert SsoAdminRecovered; dòng JSON vẫn bắt buộc dán (runbook-ops §3d)".

**D97.20 Metric + alert.**

| Tên | Kiểu | Label | Hàm |
|---|---|---|---|
| `sso_audit_alert_last_event_timestamp_seconds` | Gauge | `action` ∈ `['ADMIN_RECOVERED','ADMIN_BOOTSTRAPPED']` | `setAuditAlertLastEvent(action, sec)` |

- Khởi tạo 0 (không có event = 0).
- Alert `SsoAdminRecovered` (critical): `time() - max(sso_audit_alert_last_event_timestamp_seconds{action="ADMIN_RECOVERED"}) < 1800`.
  - Fire trong 30' sau event, không cần `for`. Restart pod không làm fire lại event cũ (> 30').
  - Nhiều replica: `max` gộp. Giá trị 0 ⇒ không fire.
- Alert `SsoAdminBootstrapped` (warning): cùng dạng, `action="ADMIN_BOOTSTRAPPED"`. Lần deploy đầu sẽ fire, ghi trong runbook-deploy §16.
- `alerts.test.yml`: `time()` của promtool bắt đầu từ 0 ⇒ dev chọn series (vd. giá trị bám theo thời gian test) sao cho có một case fire và một case "event cũ" không fire.
- Rủi ro chấp nhận: app chết > 30' quanh lúc recover ⇒ không fire. Dòng JSON thủ công (§3d) vẫn là đường chính. Ghi runbook.

**D97.21 Test T5.**
- Unit `audit-alert-watch.spec.ts`: aggregate trả 2 dòng ⇒ gauge đúng giây; reject ⇒ gauge giữ, không throw; tick chồng ⇒ bỏ.
- Int `run97-audit-alert-watch.int-spec.ts` (DB int):
  - insert `ADMIN_RECOVERED` bằng `AuditService.record`, gọi `poll()` trực tiếp ⇒ `/metrics` có gauge ≈ timestamp;
  - `explain` của aggregate dùng `IXSCAN action_1`.
- Không cần harness.

### T4 DEBT-280 — Redis của fe-admin ở production

**D97.22 Hướng production.**
- Khuyến nghị: **Redis riêng cho fe-admin** (instance nhỏ standalone, TLS, user ACL riêng).
  - Mất phiên fe-admin chỉ buộc admin đăng nhập lại.
  - Redis IdP chạy Sentinel (runbook-deploy §10) mà fe-admin chưa hỗ trợ Sentinel (`fe-admin/src/server/redis.ts` chỉ nhận URL). Trỏ thẳng master thì failover làm fe-admin 503 tới khi sửa env ⇒ DEBT-701.
- Dùng chung instance IdP chỉ khi có user ACL hạn chế ở D97.23.
- Code (`fe-admin/src/server/env.ts:27`): ở production (`isProduction(source)`, :51), `SESSION_REDIS_URL` phải:
  - (a) có protocol `rediss:`;
  - (b) có `username` khác rỗng và khác `default`, tức bắt buộc user ACL riêng.
  - Sai ⇒ thông báo cố định `"must be a rediss:// URL with an ACL username in production"`, không echo giá trị (giữ `onValidationError` hiện có).
  - Ngoài production giữ `url()`: dev/E2E `redis://` không đổi. E2E chạy `vite dev`, không PROD.
- ioredis tự bật TLS với `rediss://`. Không thêm option `tls` (YAGNI). CA riêng thì dùng `NODE_EXTRA_CA_CERTS`, ghi runbook.
- Test `fe-admin/test/env-matrix.test.ts` (+ `env.test.ts` nếu cần):
  - production: `redis://u@h` ⇒ lỗi chỉ tên biến; `rediss://h` (không user) ⇒ lỗi; `rediss://default@h` ⇒ lỗi; `rediss://fea@h:6380/0` ⇒ OK;
  - thông điệp không chứa URL/mật khẩu;
  - ngoài production: `redis://localhost:6379/1` vẫn OK.
- `fe-admin/scripts/docker-smoke.sh:35`:
  - đổi sang `rediss://fea@127.0.0.1:1/0` (vẫn cổng đóng trong container);
  - thêm một check: container với `SESSION_REDIS_URL=redis://127.0.0.1:1/0` ⇒ thoát mã 1, log có `SESSION_REDIS_URL` và không có `redis://`;
  - chỉ chạy ở CI `fe-admin-image` (máy dev không tạo container). Cập nhật số check trong runbook-deploy §7 (hiện "13 check").
- `fe-admin/.env.example`, `fe-admin/README.md:31`: ghi yêu cầu production.

**D97.23 Runbook-deploy §7**, bảng env (:233): thay "Nên" bằng "Bắt buộc ở production (boot fail)". Thêm khối ACL:

```
ACL SETUSER fea on >… resetkeys ~fea:* resetchannels -@all +get +set +del +pexpire +getdel +ping +info +select
```

- `+info` cho ready check của ioredis; `+select` khi URL có `/db`.
- Kiểm bằng `ACL DRYRUN`, dán kết quả vào ticket deploy:
  - `ACL DRYRUN fea GET fea:x` ⇒ OK;
  - `ACL DRYRUN fea GET sess:x` ⇒ bị từ chối;
  - `ACL DRYRUN fea KEYS *` ⇒ bị từ chối.
- Đây là phần "kiểm ACL ở smoke" của task. **Không** dựng Redis ACL trong CI smoke ở run này: thêm container + TLS cert vào CI tốn hơn lợi ích, và kiểm chỉ có ý nghĩa ở môi trường thật ⇒ DEBT-702.
- Ghi Redis riêng (D97.22) là mặc định khuyến nghị.

### Runbook-ops (chung lô B/C)

**D97.24 Mục mới `runbook-ops.md`** (mục kế tiếp sau §13; dev chỉnh số nếu run 96 đã thêm mục):
- §14 `SsoAuditWriteFailed`:
  - nguyên nhân: Mongo/quyền ghi `auditlogs`; thao tác nhạy cảm đang 5xx (fail-closed);
  - đối chiếu `sso_audit_events_total` với số document để biết sự kiện nào thiếu (đặc biệt `TOKEN_REUSE_DETECTED` ⇒ xử lý theo §2 dù không có document).
- §15 `SsoAdminAccessDenied` / `SsoAdminInvalidTokenHigh`:
  - truy vấn `auditlogs` `{action:'ADMIN_ACCESS_DENIED'}` theo `actorId`/`metadata.reason`;
  - `not_live` lặp lại ⇒ token admin bị lộ ⇒ thu hồi phiên user + đổi mật khẩu;
  - `invalid_token` cao mà không có document ⇒ có người quét token rác từ ngoài ⇒ xem log proxy.
- §16 `SsoClientAuthGlobalLimit`:
  - đọc log `client-auth global limit reached` để lấy `clientId`;
  - RP báo 429 ⇒ xác nhận IP egress của RP, chặn nguồn tấn công ở proxy/WAF;
  - **không** xoá bucket (để tự hết cửa sổ). Nếu bắt buộc, chỉ `DEL` đúng key `rl:client-auth-g:{sha256(clientId)}` (ghi lệnh tính hash trong runbook);
  - nêu rủi ro còn lại D97.13.
- §3d: bổ sung "app cũng phát `SsoAdminRecovered` trong ≤ 60 s + scrape; vẫn phải dán dòng JSON".
- `runbook-deploy.md` §4 bước 7: danh sách alert phải nạp thêm 6 rule mới. §16 (bootstrap): `SsoAdminBootstrapped` sẽ fire ở lần đầu.

### Chia lô, gate, DEBT

**D97.25 Chia lô**

| Lô | Nội dung | Agent | Tự verify của dev |
|---|---|---|---|
| **A** | T4: `fe-admin/src/server/env.ts`, test env, `docker-smoke.sh`, `.env.example`, README, runbook-deploy §7 | backend-dev (code server fe-admin, không UI) | fe-admin `test` + `typecheck` + `lint`; smoke để CI |
| **B** | T3 → T2 → T5: `audit.service.ts`, `audit-action.enum.ts`, `tenant-context.ts`, `admin-auth.errors.ts`, `audit-alert-watch.ts` (mới), `security.module.ts`, `metrics.ts`, `alerts.yml`/`alerts.test.yml`, runbook-ops §3d/§14/§15, runbook-deploy §4/§16 | backend-dev | unit audit/admin-guards/metrics/`ops-rules.spec` + int `run97-admin-denied`, `run97-audit-alert-watch`, `metrics.int-spec`, các int admin hiện có |
| **C** | T1: `client-authentication.service.ts`, `rate-limit.service.ts`, config + spec, `metrics.ts`, alerts, runbook-ops §16, be `.env.example` | backend-dev | unit client-auth/rate-limit/validation + int `client-auth-rate-limit` + int token/introspect |
| **D** | Gate | tester | thứ tự dưới |

- A không chung file với B/C (runbook-deploy khác mục: A §7, B §4/§16) ⇒ **A ∥ B**.
- C **sau** B: chung `metrics.ts`, `alerts*.yml`, `metrics.spec`, runbook-ops. B trước C vì T2 thêm `AuditAction` (đổi số series `sso_audit_*` mà spec metrics đếm).
- Không cần frontend-dev.
- Chỉ bắt đầu code sau khi run 96 commit.

Thứ tự gate ở lô D:
1. be unit; fe-admin test/typecheck/lint
2. int FULL
3. kiểm SMTP 220 ⇒ E2E ×1
4. X3
5. `mutate.mjs all` + các mutation tay ở D97.5/D97.11/D97.17 (dev đã ghi, tester chạy lại một lần)
6. kiểm SMTP 220 ⇒ harness đầy đủ (timing on rồi off), **sau** E2E. Không có check mới, mọi `must` xanh
7. kiểm SMTP 220 sau harness (`HYG-SMTP-AFTER`)

promtool, `fe-admin-image` (smoke mới) và vault chạy ở CI. Sau gate: senior review, orchestrator push, xác nhận CI 9/9 trên commit.

**D97.26 DEBT** (orchestrator gộp vào backlog khi đóng run 96/97)
- Mở **DEBT-701** (🟡 [FE/ops]): fe-admin `createSessionRedis` chỉ nhận URL standalone, không Sentinel ⇒ dùng chung Redis Sentinel của IdP thì failover làm fe-admin 503. Hiện xử lý bằng Redis riêng (D97.22). Thêm `SESSION_REDIS_SENTINELS` nếu ops cần HA cho console.
- Mở **DEBT-702** (💭 [ops/CI]): kiểm ACL `~fea:*` chỉ bằng `ACL DRYRUN` thủ công trong runbook (D97.23). Tự động hoá bằng container Redis ACL+TLS trong job `fe-admin-image` nếu muốn bằng chứng CI.
- Mở **DEBT-703** (💭 [BE/ops]): IdP `REDIS_URL`/Sentinel không bắt buộc TLS ở production (`be/src/config/validation.schema.ts` không kiểm `rediss`). Hiện dựa vào network `--internal` (runbook-deploy §9). Cân nhắc bắt buộc `rediss://` + user ACL như D97.22 khi Redis khác host.
- Mở **DEBT-704** (💭 [BE]): trần toàn cục client auth (D97.13) vẫn có thể trả 429 cho RP hợp lệ từ IP chưa thành công lần nào trong 7 ngày khi đang bị tấn công. Cân nhắc allow-list IP egress theo client (field admin) nếu xảy ra thực tế.
- Đóng sau lô D:
  - DEBT-218 (D97.1–D97.5);
  - DEBT-126 (D97.6–D97.11);
  - DEBT-072 (D97.12–D97.17; phần "WAF ở gateway" ⇒ runbook-ops §16);
  - DEBT-618 (D97.18–D97.21);
  - DEBT-280 (D97.22–D97.23).
