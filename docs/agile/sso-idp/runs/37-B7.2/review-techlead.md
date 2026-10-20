# Tech Lead Review — 2026-10-20

> Run 37 (B7.2 observability + DEBT-215). Đối chiếu `develop` @ `a80855b` qua CodeGraph: `AuditService.record` + `ALERT_ACTIONS`, `KeyRotationService.rotate` (metadata `mode`), `TokenController.renderError/handleRefreshGrant/refuseGrant/failClosed`, `TokenError`/`TokenErrorCode`, `RefreshTokenService.issueForRefresh/rotate/recheckAfterRotate/classifyMiss/revokeFamily/revokeWhere`, `bootstrap.configureApp`, `registerCorsPreflight` (mẫu route Fastify thô dùng chung với int test), `logger.module` (serializer allowlist), `envSchema`, `HealthController`. Int test dựng module riêng bằng `createNestApplication(new FastifyAdapter())` với provider liệt kê tay, không gọi `configureApp`. Môi trường: Node v22.22.3, Nest 12.1.1, fastify 5.12.5, không có `promtool`.

## Kết luận: PASS (kèm fold M0–M9 trong `tasks.md`)

Plan đúng yêu cầu: spec dòng 501 (#16), §10 (alert reuse / key rotation / admin), dòng 503 (alert tỉ lệ lỗi `/token`), plan B7.2 và DEBT-215. Khả thi trên code hiện có. Các lỗ của task gốc sửa gọn được bằng fold, không cần quay lại analyst:

- Cách bảo vệ `/metrics` chưa chốt.
- Thiếu bước khởi tạo series về 0, nên alert `increase()` không bắn ở lần sự kiện đầu tiên.
- Dễ làm vỡ DI của khoảng 25 int-spec.
- DEBT-215 có thể bỏ sót successor còn sống.

## Kiến trúc đề xuất (điều chỉnh)

Modular monolith giữ nguyên: thêm một thư mục `be/src/common/metrics/`, không thêm Nest module hay DI.

- **Registry singleton cấp module, không DI (M1).** `metrics.ts` export `registry = new Registry()` cùng các metric (`registers: [registry]`, không chạm `register` global) và các hàm `observeAuditEvent(e)` / `observeTokenError(endpoint, code)`. `AuditService` và `TokenController` import hàm trực tiếp. Lý do: inject `MetricsService` sẽ bắt khoảng 25 int-spec đang liệt kê `AuditService`/`TokenController` phải sửa provider. Cách singleton giống `registerCorsPreflight`.
- **Q-37.2: hai điểm gắn, không interceptor (M3).**
  - (a) `AuditService.record`: sau `auditModel.create` thành công, trước alert listener, gọi `observeAuditEvent` đồng bộ trong `try/catch` (metrics lỗi không bao giờ làm hỏng `record`). Không dùng `onAlert`, vì listener chỉ chạy cho `ALERT_ACTIONS` và là async, trong khi cần cả `TOKEN_ISSUED`/`TOKEN_REFRESHED`/`AUTH_LOGIN_FAILED`/`AUTH_ACCOUNT_LOCKED`.
  - (b) `TokenController.renderError`: một điểm, đặt trước cả nhánh 429 lẫn nhánh thường. Mọi lỗi `/token` và `/revoke` đều đi qua đây.
  - Latency: hook Fastify `onResponse` (M2). Nest interceptor không thấy 404/lỗi filter và không có route template.
- **Wiring HTTP dùng chung (M2).** Hàm `registerMetrics(fastify, { token })` trong `metrics.http.ts`: thêm hook `onResponse` cùng route thô `GET /metrics`. `configureApp` gọi nó trước `init`, nên route Nest đăng ký sau đều có hook. Int test gọi đúng hàm này, nên test chạy chính wiring production.

## Trả lời câu hỏi

- **Q-37.1 (bảo vệ `/metrics`): bearer tĩnh `METRICS_TOKEN`, fail-closed.**
  - Env tuỳ chọn: unset hoặc rỗng ⇒ **không đăng ký route** (404, mọi môi trường); có giá trị thì bắt buộc ≥ 32 ký tự (zod).
  - Chỉ nhận header `Authorization: Bearer <token>` (không query string, vì URL được log). So sánh `timingSafeEqual(sha256(a), sha256(b))`.
  - Sai hoặc thiếu ⇒ 401, header `WWW-Authenticate: Bearer`, body rỗng. Đúng ⇒ 200, `Content-Type: registry.contentType`, `Cache-Control: no-store`.
  - Lỗi `registry.metrics()` ⇒ 500 body rỗng, chỉ log message.
  - Không bind port riêng: Nest + Fastify một listener, port thứ hai là over-engineering ở quy mô này. README ghi thêm: không route `/metrics` qua ingress public; Prometheus dùng `authorization.credentials_file`.
- **Q-37.2:** xem kiến trúc ở trên (audit `record` + `renderError` + hook `onResponse`).
- **Q-37.3 (không có `promtool`, không cài toàn cục):**
  - Thêm devDependency `yaml@2.9.1` (pin exact, phát hành 2026-09-11, ≥ 2 tuần, có sẵn type).
  - Jest unit `ops-rules.spec.ts` kiểm cấu trúc rule và đối chiếu mọi tên metric cùng giá trị label trong `expr` với output thật của `registry.metrics()`. Việc này chạy được nhờ M4 (khởi tạo series 0).
  - Int test chứng minh "bắn được": sự kiện thật làm đúng series mà `expr` chọn đi từ 0 lên 1.
  - Kèm `ops/prometheus/alerts.test.yml` (định dạng `promtool test rules`) cho ai có promtool. **Không** chạy qua docker trong run này (kéo image = tải về); đưa vào CI ở DEBT-219.

## Phiên bản dependency

- `prom-client` **15.1.3** (dependencies, exact). Bản mới nhất, phát hành 2024-06-27, `engines.node: ^16 || ^18 || >=20` nên chạy được Node 22. Phụ thuộc: `tdigest`, `@opentelemetry/api`. Không phụ thuộc Nest.
- `yaml` **2.9.1** (devDependencies, exact). Chỉ dùng trong test.

## Cổng security design (`/metrics` là trust boundary)

| Mục | Chốt |
|---|---|
| Tài sản / actor / boundary | Tài sản: số liệu nghiệp vụ (nhịp login lỗi, reuse, rotation) và thông tin process. Actor hợp lệ: Prometheus giữ `METRICS_TOKEN`. Actor không hợp lệ: Internet/RP/user. Boundary: HTTP listener chung. Không có tenant/role/owner (endpoint không thuộc tenant). |
| Invariant | Không token ⇒ không dữ liệu (401 hoặc 404). Thứ tự ghi nhận: chỉ tăng counter sau khi audit ghi thành công. Quan sát metrics không bao giờ đổi status hay body của request nghiệp vụ. |
| Abuse | Brute-force token (≥ 32 ký tự ngẫu nhiên, timing-safe). Token qua query (không nhận). Cardinality DoS bằng path hoặc method ngẫu nhiên: label `route` = template hoặc `__unmatched`, `method` ∈ tập cố định hoặc `OTHER`, `status_class` ∈ `1xx…5xx`. Lộ định danh qua label: không có `userId`/`email`/`clientId`/`tenantId`/IP/`familyId`/`kid`/`reason`. Replay token sau từ chối (DEBT-215): xem M8. |
| Failure semantics | `observe*` ném ⇒ nuốt và log (fail-open cho metrics, không ảnh hưởng nghiệp vụ). Audit ghi lỗi ⇒ không tăng counter (counter khớp audit đã lưu). `registry.metrics()` lỗi ⇒ 500 body rỗng. Env unset ⇒ route không tồn tại (fail-closed). |
| Exposure | Body chỉ có exposition text. Không có token trong log: serializer `req` là allowlist `id/method/url`, đã cắt query. Test âm: sau khi chạy login/refresh có email, clientId, IP, refresh token và familyId cố định, output `/metrics` không chứa chuỗi nào trong số đó. |

## Điểm mạnh

- Đã có sẵn điểm gắn: `AuditService.record` là nơi duy nhất ghi audit (28 caller) và `renderError` là nơi duy nhất render lỗi `/token`/`/revoke`. Metrics nghiệp vụ không phải rải code.
- `KeyRotationService.rotate` đã ghi `metadata.mode` (`normal|emergency`) cho cả success và failure, đủ cho alert rotation khẩn cấp mà không sửa service.
- `TokenErrorCode` là union hữu hạn (9 mã), nên label `error` có trần sẵn.
- Logger đã dùng allowlist serializer (DEBT-089), header `Authorization` của scraper không thể lọt vào log.
- DEBT-215 đã có test pin (run 36 tester), sửa xong sẽ lật test có chủ đích.

## Vấn đề (đã fold, bắt buộc làm theo `tasks.md` mục "Fold tech-lead")

- [x] M1: registry riêng dạng singleton, không DI, không động tới `register` global; `collectDefaultMetrics` gọi một lần, có guard.
- [x] M2: hook `onResponse` cùng route `/metrics` qua `registerMetrics` dùng chung; label route là template; giới hạn cardinality.
- [x] M3: đúng hai điểm gắn nghiệp vụ; cắt "histogram latency `/token`" riêng vì trùng với histogram HTTP `route="/token"`.
- [x] M4: **khởi tạo 0** mọi tổ hợp label hữu hạn. Nếu không, `increase()` không thấy lần reuse hay rotation khẩn cấp đầu tiên, tức alert không bắn.
- [x] M5: chốt tên metric và label (bảng trong `tasks.md`).
- [x] M6: Q-37.1 như trên, kèm test âm.
- [x] M7: Q-37.3 như trên; alert dùng `sum` (đa instance) và có ngưỡng traffic tối thiểu cho tỉ lệ lỗi.
- [x] M8: DEBT-215 chỉ đánh dấu doc cũ **sau khi** revoke family thành công. Nếu không, successor chưa giao còn sống, và test DEBT-067 (`revokeFamily` ném ⇒ replay quét successor) bị phá.
- [x] M9: thứ tự task và verify.

## Đề xuất (không bắt buộc) → `backlog.md`

- DEBT-218: counter sự kiện bảo mật phụ thuộc audit ghi thành công. Mongo down ⇒ reuse vẫn bị chặn (500) nhưng không lên metric hay alert. Cân nhắc thêm alert `up == 0` / 5xx (đã có trong M7) hoặc tăng counter trước khi ghi.
- DEBT-219: chạy `promtool check rules` + `promtool test rules ops/prometheus/alerts.test.yml` trong CI bằng image `prom/prometheus` pin digest.
- DEBT-220: `METRICS_TOKEN` là một giá trị tĩnh, không hỗ trợ xoay chồng lấn. Cân nhắc nhận danh sách 2 token khi có yêu cầu rotate không downtime; B7.3 compose prod không publish `/metrics` ra ngoài.
- Nhắc lại DEBT-032 (không mở mới): sign/audit lỗi **sau** recheck thành công vẫn có thể sinh reuse giả. M8 không phủ trường hợp này (ngoài phạm vi). Có thể tái dùng cùng marker khi xử lý DEBT-032.
