# Tasks — run 37 — B7.2 observability + DEBT-215 (M7)

> Plan §B7 B7.2: "Observability: Prometheus (`prom-client`: số token phát hành, lỗi `/token`, latency), alert rule cho reuse-detected / key rotation khẩn cấp / tăng lỗi `/token`" — nghiệm thu "Dashboard mẫu; alert test bắn được". Spec dòng 501 (#16: Pino structured log redact, Prometheus metrics, AuditLog mở rộng + alerting sự kiện nhạy cảm), §10 (`ALERT_ACTIONS`: `TOKEN_REUSE_DETECTED`, `SIGNING_KEY_ROTATED` emergency, thao tác admin). DEBT-215: refresh bị từ chối sau `rotate` rồi RP retry ⇒ `TOKEN_REUSE_DETECTED` giả ⇒ nhiễu chính alert này.
>
> Thứ tự: Task 1 → 2 → 3 → 4 (backend-dev). Hạ tầng: KHÔNG compose up (không dựng Prometheus/Grafana thật — chỉ file cấu hình + test), KHÔNG FLUSH/drop `aegate-*`. Dependency mới: `prom-client` (pin exact, tech-lead chốt phiên bản).

### [x] Task 1 [BE]: Metrics module + endpoint
- `prom-client` registry riêng (không global default ngoài ý muốn), `GET /metrics` (text exposition). Bảo vệ endpoint: không public trên Internet — tech-lead chốt (bind riêng port/interface, token bearer tĩnh từ env, hoặc chỉ ngoài production + allowlist IP). Không label có dữ liệu nhạy cảm/cardinality cao (không userId, email, token, IP; `client_id` chỉ nếu có trần).
- Default process metrics + HTTP latency histogram theo route template (không path thô).
- **Acceptance**: int: `/metrics` trả đúng format; không có chuỗi nhạy cảm; truy cập trái phép bị chặn; label route là template.

### [x] Task 2 [BE]: Metrics nghiệp vụ
- Counter token phát hành theo grant (`authorization_code`, `refresh_token`) + kết quả; counter lỗi `/token` theo mã lỗi OAuth (tập hữu hạn); counter `TOKEN_REUSE_DETECTED`, `SIGNING_KEY_ROTATED{mode}`, login thất bại/khoá; histogram latency `/token`. Gắn qua chỗ ghi audit hiện có (một điểm, không rải code) nếu khả thi.
- **Acceptance**: int: mỗi đường làm counter tăng đúng 1; lỗi không tăng counter thành công; mutation ⇒ RED.

### [x] Task 3 [ops]: Alert rules + dashboard mẫu + test alert
- `ops/prometheus/alerts.yml` (reuse-detected > 0 trong 5', emergency key rotation, tỉ lệ lỗi `/token` tăng, 5xx), `ops/grafana/dashboard.json` mẫu, README ngắn. Test alert "bắn được": `promtool test rules` nếu có sẵn (KHÔNG cài toàn cục; nếu không có, tech-lead chốt cách kiểm — vd. unit test parse YAML + kiểm biểu thức tham chiếu đúng tên metric đang export).
- **Acceptance**: rule hợp lệ; mọi metric trong rule/dashboard tồn tại trong `/metrics`.

### [x] Task 4 [BE]: DEBT-215 — không báo reuse giả sau refresh bị từ chối
- Khi `recheckAfterRotate` từ chối/lỗi: đánh dấu doc cũ (vd. `rejectedAt`/lý do) để replay token cũ ⇒ `invalid_grant` mà KHÔNG ghi `TOKEN_REUSE_DETECTED` (và không tăng counter reuse); reuse thật vẫn báo. Đổi test pin của tester run 36 sang 0 audit.
- **Acceptance**: int: replay sau 500/400 ⇒ 0 reuse audit; reuse thật (token đã rotate thành công) ⇒ vẫn 1; mutation ⇒ RED.

## Câu hỏi cho tech-lead
- Q-37.1: Bảo vệ `/metrics`.
- Q-37.2: Gắn metrics qua audit service hay interceptor.
- Q-37.3: Cách kiểm alert rule khi không có `promtool`.

---

## Fold tech-lead (2026-10-20) — ƯU TIÊN HƠN text cũ ở trên

> Review: `review-techlead.md` — **PASS**. Thứ tự: Task 1 → 2 → 3 → 4. Task 4 độc lập, làm lúc nào cũng được; Task 3 cần Task 1 + 2 xong trước.

### M0 — Q đã chốt + dependency
- **Q-37.1**: bảo vệ bằng bearer tĩnh `METRICS_TOKEN`. Env tuỳ chọn: unset hoặc rỗng ⇒ route KHÔNG được đăng ký ⇒ 404; có giá trị ⇒ zod `min(32)`. Không mở port riêng.
- **Q-37.2**: gắn ở 2 điểm nghiệp vụ (`AuditService.record` + `TokenController.renderError`) và hook Fastify `onResponse` cho latency. Không dùng interceptor, không dùng `onAlert`.
- **Q-37.3**: devDep `yaml@2.9.1` + Jest đối chiếu rule với `registry.metrics()` + int test "0→1". `alerts.test.yml` để sẵn cho promtool, không chạy, không docker pull.
- **Dependency** (pin exact):
  - `prom-client` **15.1.3**, dependencies: `pnpm -C be add -E prom-client@15.1.3`
  - `yaml` **2.9.1**, devDependencies: `pnpm -C be add -D -E yaml@2.9.1`

### M1 — Registry (Task 1)
- `be/src/common/metrics/metrics.ts` export `const registry = new Registry()`. Mọi metric khai `registers: [registry]`; KHÔNG dùng hay ghi vào `register` global của prom-client.
- Registry là singleton cấp module, **không** phải Nest provider/DI. Lý do: tránh phải sửa provider của khoảng 25 int-spec.
- `collectDefaultMetrics({ register: registry })` gọi đúng 1 lần (guard bằng cờ module) bên trong `registerMetrics` (M2). Chỉ import `metrics.ts` thì collector không chạy, nên unit test không bật nó.

### M2 — Wiring HTTP dùng chung (Task 1)
`be/src/common/metrics/metrics.http.ts` export `registerMetrics(fastify, { token?: string })`, gồm hai phần:
- `addHook('onResponse')` ghi `sso_http_request_duration_seconds` (giá trị `reply.elapsed/1000`). Labels:
  - `method`: thuộc {GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS}, ngoài tập ⇒ `OTHER`.
  - `route`: `request.routeOptions.url`, nếu undefined (404) ⇒ `__unmatched`. **Không bao giờ** dùng `request.url`.
  - `status_class`: `${Math.floor(status/100)}xx`.
- Route thô Fastify `GET /metrics`, chỉ đăng ký khi `token` có giá trị (xem M6). Route nằm ngoài Nest nên không qua `OAuthExceptionFilter` hay pipe.

Nơi gọi:
- `configureApp` gọi `registerMetrics(instance, { token: <METRICS_TOKEN từ ConfigService> })`. Lấy từ config đã validate, không đọc `process.env` thô. Gọi trước khi Nest đăng ký route: `configureApp` chạy trước `init/listen`.
- Int test metrics gọi đúng hàm này trên `app.getHttpAdapter().getInstance()` trước `app.init()`.

Env:
- `envSchema` thêm `METRICS_TOKEN`: optional, rỗng ⇒ undefined, có giá trị ⇒ `min(32)`.
- Thêm vào `.env.example`, comment cách sinh: `openssl rand -hex 32`.

### M3 — Điểm gắn nghiệp vụ (Task 2, thay text Task 2 cũ)
- **`AuditService.record`**: ngay sau `await this.auditModel.create(event)` thành công, trước khối alert, gọi `try { observeAuditEvent(event) } catch { logger.error(...) }`.
  - Đồng bộ, không await, không bao giờ làm `record` ném.
  - Không đổi constructor của `AuditService`.
- **`TokenController.renderError`**: gọi `observeTokenError(endpoint, code)` đúng 1 lần ở đầu hàm.
  - Phủ cả nhánh 429 (`temporarily_unavailable`) lẫn nhánh thường (`TokenError.code`, hoặc `server_error`).
  - `endpoint` ∈ {`token`,`revoke`}, truyền từ `token()`/`revoke()` (thêm tham số).
  - Code ngoài union ⇒ `server_error`.
- **Cắt** 2 metric trùng (ánh xạ ghi trong `ops/README.md`):
  - counter riêng "token phát hành theo grant": đã có `sso_audit_events_total{action="TOKEN_ISSUED"|"TOKEN_REFRESHED"}`.
  - "histogram latency /token": đã có `sso_http_request_duration_seconds{route="/token"}`.

### M4 — Khởi tạo series về 0 (Task 2, BẮT BUỘC)
- Khi import `metrics.ts`, gọi `inc(labels, 0)` cho mọi tổ hợp label hữu hạn:
  - `Object.values(AuditAction)` × {success,failure}
  - `TokenErrorCode` (9 mã) × {token,revoke}
  - {normal,emergency} × {success,failure}
- Lý do: series xuất hiện lần đầu với giá trị 1 thì `increase()` không thấy bước tăng ⇒ alert reuse và emergency KHÔNG bắn ở sự kiện đầu tiên.
- Khi observe gặp label lạ (action ngoài enum, mode ngoài tập) ⇒ bỏ qua: không tạo series mới, không ném.

### M5 — Tên & label (chốt)
| Metric | Loại | Labels (tập hữu hạn) |
|---|---|---|
| `sso_audit_events_total` | Counter | `action` (AuditAction), `result` (success/failure) |
| `sso_signing_key_rotations_total` | Counter | `mode` (normal/emergency), `result`. Tăng trong `observeAuditEvent` khi `action===SIGNING_KEY_ROTATED`, đọc `metadata.mode` |
| `sso_token_endpoint_errors_total` | Counter | `endpoint` (token/revoke), `error` (TokenErrorCode) |
| `sso_http_request_duration_seconds` | Histogram | `method`, `route`, `status_class`; buckets `[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5]` |
| default process metrics | — | mặc định của prom-client |

**CẤM** dùng làm label: userId/sub, email, clientId, tenantId, IP, familyId, kid, reason, scope, resource, path thô. Run này KHÔNG dùng label `client_id`.

### M6 — `/metrics` (Task 1, acceptance thay thế)
Hành vi:
- Chỉ nhận header `Authorization: Bearer <t>`; so sánh `timingSafeEqual(sha256(t), sha256(METRICS_TOKEN))`.
- Thiếu token, sai token, scheme khác, hoặc token qua query ⇒ **401**, header `WWW-Authenticate: Bearer`, body rỗng.
- Đúng ⇒ 200, `Content-Type` = `registry.contentType`, `Cache-Control: no-store`.
- `registry.metrics()` ném ⇒ 500 body rỗng; chỉ log message, không trả stack cho client.

Int test (`test/metrics.int-spec.ts`, Nest + Fastify thật, gọi `registerMetrics` thật):
1. Không cấu hình token ⇒ `GET /metrics` trả 404.
2. Có cấu hình token:
   - thiếu ⇒ 401
   - sai nhưng cùng độ dài ⇒ 401
   - token đúng qua `?token=`, không có header ⇒ 401
   - scheme `Basic` ⇒ 401
   - đúng ⇒ 200, exposition parse được (có `# TYPE sso_audit_events_total counter`).
3. Gọi `GET /admin/users/<objectId ngẫu nhiên>` và `GET /khong-ton-tai-<uuid>` ⇒ output có `route="/admin/users/:id"` (hoặc template tương ứng) và `route="__unmatched"`, KHÔNG chứa objectId/uuid đó.
4. Exposure âm: sau một lần login lỗi (email cố định) và một lần refresh (clientId, IP inject, RT) ⇒ output không chứa email, clientId, IP, RT, familyId.
5. Mutation: bỏ kiểm token ⇒ test 2 RED; dùng `request.url` thay template ⇒ test 3 RED.

### M7 — Ops (Task 3, thay acceptance cũ)
**`ops/prometheus/alerts.yml`**: 1 group `sso-idp`. Mọi biểu thức bọc trong `sum(...)` để đúng khi chạy nhiều instance. Mỗi rule có `labels.severity` và `annotations.summary`; summary không chứa template label nhạy cảm.
- `SsoTokenReuseDetected` (critical): `sum(increase(sso_audit_events_total{action="TOKEN_REUSE_DETECTED"}[5m])) > 0`
- `SsoEmergencyKeyRotation` (critical): `sum(increase(sso_signing_key_rotations_total{mode="emergency",result="success"}[5m])) > 0`
- `SsoTokenErrorRatioHigh` (warning, `for: 10m`): `sum(rate(sso_token_endpoint_errors_total{endpoint="token"}[5m])) / sum(rate(sso_http_request_duration_seconds_count{route="/token"}[5m])) > 0.25 and sum(rate(sso_http_request_duration_seconds_count{route="/token"}[5m])) > 0.1`
- `SsoHttp5xxRatioHigh` (critical, `for: 5m`): số request 5xx / tổng > 0.05.

**`ops/prometheus/alerts.test.yml`**: unit test định dạng promtool.
- Series 0→1 ⇒ reuse và emergency firing; dưới ngưỡng ⇒ không firing.
- Không chạy trong run này (không có promtool, không docker pull); README ghi lệnh.

**`ops/grafana/dashboard.json`**: ≥4 panel:
- token issued/refreshed theo result
- lỗi `/token` theo error
- p95 latency `/token`
- reuse + rotations
- 5xx

**`ops/README.md`**: scrape config (`authorization.credentials_file`), không publish `/metrics` qua ingress, ánh xạ metric ↔ spec, lệnh promtool tuỳ chọn.

**Test rule — `be/src/common/metrics/ops-rules.spec.ts`** (unit, devDep `yaml`):
- Parse `alerts.yml` và `alerts.test.yml`.
- Kiểm shape: `alert`, `expr`, `labels.severity`, `annotations.summary`.
- Trích mọi tên metric trong `expr` (của rule và mọi `targets[].expr` trong dashboard), bỏ hậu tố `_count|_sum|_bucket` ⇒ mỗi tên phải có trong `await registry.metrics()`.
- Mọi cặp `label="value"` dùng trong matcher phải có trong output (có được nhờ M4).
- Mutation: đổi tên metric trong yml ⇒ RED.

**"Alert bắn được"** (int, đặt trong `metrics.int-spec.ts` hoặc `refresh-token.int-spec`):
- Replay RT đã rotate ⇒ trên `/metrics`, `sso_audit_events_total{action="TOKEN_REUSE_DETECTED",result="failure"}` đi từ 0 lên 1.
- Rotate emergency qua `KeyRotationService` ⇒ `sso_signing_key_rotations_total{mode="emergency",result="success"}` +1.

### M2bis — Acceptance Task 2 (thay)
Unit `metrics.spec.ts` (đo delta trước/sau, vì registry tích luỹ qua các test):
- `observeAuditEvent` +1 đúng theo action/result.
- SIGNING_KEY_ROTATED ⇒ +1 ở cả 2 counter.
- Action lạ ⇒ không tạo series mới, không ném.

Int:

| Tình huống | Kỳ vọng |
|---|---|
| Code grant 200 | `TOKEN_ISSUED/success` +1 |
| Refresh 200 | `TOKEN_REFRESHED/success` +1, `TOKEN_ISSUED/success` +0 |
| Refuse (lock sau rotate) | `TOKEN_REFRESHED/failure` +1, success +0 |
| `invalid_grant` | `sso_token_endpoint_errors_total{endpoint="token",error="invalid_grant"}` +1 |
| 429 | `temporarily_unavailable` +1 |
| Login sai | `AUTH_LOGIN_FAILED/failure` +1 |
| Audit `create` ném | counter +0 |
| `observeAuditEvent` ném (spy) | request vẫn 200 như cũ |

Mutation:
- bỏ gọi `observeAuditEvent` trong `record` ⇒ RED
- bỏ `observeTokenError` ⇒ RED
- bỏ khởi tạo 0 ⇒ test matcher của M7 RED

### M8 — DEBT-215 (Task 4, thay text Task 4 cũ)
Thiết kế:
- Marker là `replacedBy: null` trên doc cũ. Không đổi schema; successor vẫn giữ `parentId` cho forensics. `classifyMiss` giữ nguyên (`replacedBy == null` ⇒ invalid thường, không phải reuse).
- `RotationResult` thêm `rotatedFromId`: ObjectId của doc cũ (không phải hash hay token).

Khi nào đánh dấu: trong `recheckAfterRotate`, chỉ **SAU KHI** `revokeFamily` THÀNH CÔNG, chạy `updateOne({ _id: rotatedFromId, replacedBy: <successorId> }, { $set: { replacedBy: null } })`. Lệnh này best-effort (`.catch` + log): nếu lỗi thì chỉ dẫn tới reuse giả, family đã chết.
- Nhánh có reason:
  - revoke OK ⇒ mark ⇒ audit refuse ⇒ throw.
  - revoke ném ⇒ KHÔNG mark. Replay sau đó sẽ quét successor còn sống qua đường reuse, giữ test DEBT-067 xanh.
- Nhánh `recheck_failed`: thay `revokeFamily(...).catch` bằng: revoke thành công ⇒ mark; revoke ném ⇒ không mark.

Ngoài phạm vi, không đụng:
- nhánh race `familyRevokedAt` trong `rotate` (reuse thật xảy ra đồng thời)
- nhánh sign/audit lỗi sau recheck (DEBT-032)

Test:
- Lật pin DEBT-215 (it.each trong `token-code-recheck.int-spec.ts`): replay ⇒ 400 `invalid_grant`, **0** `TOKEN_REUSE_DETECTED`, family vẫn chết; sau Task 2 thì `sso_audit_events_total{action="TOKEN_REUSE_DETECTED"}` +0.
- Thêm assert "0 reuse" vào lần replay sẵn có trong `expectRefreshRefused`.
- Giữ nguyên test DEBT-067 (revoke ném ⇒ replay quét successor).
- Reuse thật (RT rotate thành công rồi replay) vẫn ra 1 reuse: test hiện có ở `refresh-token.int-spec` quanh dòng 568 phải giữ xanh.
- Mutation: bỏ mark ⇒ test pin RED; mark trước revoke ⇒ test DEBT-067 RED.

### M9 — Verify chung
- `pnpm -C be typecheck && pnpm -C be lint && pnpm -C be test && pnpm -C be test:int` xanh.
- E2E không bắt buộc (không đổi UI). Vì `configureApp` có đổi, chạy `pnpm -C e2e e2e` nếu hạ tầng có sẵn (không compose up).
- KHÔNG compose up, KHÔNG dựng Prometheus/Grafana, KHÔNG FLUSH/drop `aegate-*`.
