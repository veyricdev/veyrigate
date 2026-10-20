# Tech Lead Review — 2026-10-20 — run 38 (B7.4 + DEBT-219/223/224)

## Kết luận: PASS (có fold)

Không có blocker. Phần chỉnh sửa đã ghi thẳng vào `tasks.md`, mục "Fold tech-lead", và mục này ưu tiên hơn text cũ. Phạm vi giữ trong 1 run.

## Kiến trúc đề xuất

Không đổi kiến trúc. Ba quyết định chính:

- **Gate supply chain đặt ở CI, fail-closed.** CI có:
  - `pnpm audit --audit-level high` trong job `quality`;
  - job `secrets` chạy gitleaks bằng container;
  - job `promtool` chạy bằng container;
  - workflow riêng `codeql.yml`.
- **Pre-commit gitleaks (R5) giữ nguyên.** File đã có (`.pre-commit-config.yaml` v8.21.2), là lớp tuỳ chọn.
- **Không cài công cụ toàn cục.** Image công cụ chỉ chạy trong CI. Cục bộ dùng Jest (`ops-rules.spec`) và `pnpm audit`.

## Trả lời câu hỏi

- **Q-38.1: đổi sang `@prometheus-io/client@0.16.1` ngay, có time-box.**
  - Gói đã phát hành ~8 tuần, engines `^22`, deps giống prom-client. Chỉ đổi 3 import.
  - Nếu chỉ đổi import mà test đỏ thì revert về prom-client và giữ DEBT-224. Không viết adapter.
- **Q-38.2: SAST dùng CodeQL** (repo public, kiểm bằng GitHub API trả 200, nên miễn phí).
  - Cấu hình `security-extended`, `build-mode: none`. Quyền ghi chỉ cấp ở job.
  - Secret scan dùng gitleaks v8.21.2 qua image trong CI, toàn lịch sử (`fetch-depth: 0`), `--redact --exit-code 1`.
  - Không dùng `gitleaks-action`, vì action này cần license khi owner là org.
  - Không dùng `eslint-plugin-security` vì quá nhiễu.
- **Q-38.3: vừa 1 run** sau khi thu hẹp:
  - bỏ `nonce` vì UI không có inline script;
  - HSTS không điều kiện;
  - federation chỉ rà tĩnh, không đưa vào log-capture.

## Đối chiếu repo thật

### `pnpm audit` (chạy chỉ đọc)

Toàn workspace có 8 lỗ hổng: 3 high, 4 moderate, 1 low. Riêng `--prod` có 1 high và 3 moderate.

- **Prod high: `@fastify/static@8.2.0`** (GHSA-83w8 cùng 3 moderate).
  - Cần nâng lên `10.1.5`. Không dùng `10.1.6` vì mới 11 ngày, chưa đủ 2 tuần.
  - Đây là bump major 8→10, nên phải có regression test traversal/dotfile/listing.
  - `@nestjs/platform-fastify@12.1.1` đang khai peer `@fastify/static ^10.1.2`, nghĩa là hiện repo đã lệch peer. Bản nâng này sửa luôn chỗ đó.
- **Dev high: `source-map-js`.** Bản vá 1.2.2 nằm trong range sẵn có, chỉ cần cập nhật lockfile.
- **Dev high: `braces` GHSA-vfj7.** Chưa có bản vá. Chấp nhận rủi ro bằng ignore theo GHSA, có ghi lý do, theo dõi ở DEBT-226.

### Logging

- Có 32 call-site logger trong `be/src`.
- Request serializer đã allowlist (`id`/`method`/`url` không query). Response serializer chỉ giữ `statusCode` + `location` đã cắt query.
- Rủi ro thật không nằm ở redact path mà ở **chuỗi message/stack**:
  - `OAuthExceptionFilter`, token và introspect log `err.stack`. Mongo E11000 có thể mang `dup key: { email }`.
  - `Mongo error: ${err.message}` có thể lộ URI có credential.
- **Chưa int-spec nào nối pino.** Task 4 phải dựng capture bằng `buildPinoHttpOptions` thật.
- Comment `REDACT_PATHS` ghi wildcard khớp mọi độ sâu là sai: fast-redact chỉ khớp 1 cấp.

### Headers

- CSP không dùng nonce (`script-src 'self'`, `script-src-attr 'none'`).
- discovery trả `Cache-Control: public, max-age=300`, đúng thiết kế, nên không được ép `no-store`.
- `/token` có `no-store`; `/userinfo` có `no-store`.
- Chưa có test header tổng hợp theo loại response.

### Ops

- `SsoHttp5xxRatioHigh` chưa có ngưỡng traffic, đúng như DEBT-223 mô tả.
- `ops-rules.spec` đã parse `alerts.test.yml`.

## Điểm mạnh

- Task bám đúng nghiệm thu B7.4 ("không high/critical chưa xử lý") và INV-19/20.
- Ràng buộc hạ tầng rõ: không cài toàn cục, không `docker run` cục bộ.
- Gộp DEBT-219/223/224 hợp lý vì cùng đụng `ops/` và CI.

## Cổng security design (vùng chạm: supply chain, log exposure, response headers)

- **Tài sản:**
  - token, code, verifier, client_secret, cookie session/federation, `METRICS_TOKEN`, private key, email người dùng;
  - lockfile và CI (chuỗi cung ứng).
- **Actor:** người đọc log (operator/hệ thống log tập trung), dependency bên thứ ba, attacker qua HTTP tới `/assets/*`.
- **Abuse cases:**
  - path traversal trên static (`..`, `%2e%2e`, `..%2f`), dotfile, liệt kê thư mục;
  - secret rò vào lịch sử git;
  - giá trị nhạy cảm lọt qua message lỗi (E11000, URI DB);
  - cache trung gian giữ response token hoặc admin.
- **Failure semantics:**
  - registry audit lỗi ⇒ CI đỏ (fail-closed, cấm `--ignore-registry-errors`);
  - gitleaks phát hiện ⇒ exit 1;
  - promtool hoặc CodeQL lỗi ⇒ job đỏ.
- **Exposure rules + test âm đo được:**
  - danh sách giá trị cấm có trong Task 4;
  - capture log và assert không có chuỗi con, kể cả dạng URL-encoded;
  - mutation (a)/(b)/(c) bắt buộc RED;
  - bảng header kèm mutation helmet và `/token`.

## Vấn đề (đã fold, không chặn)

- [x] Task 3: bỏ yêu cầu `nonce`. Thay bằng: không `unsafe-inline`/`unsafe-eval`, CSP === `buildCsp()` hoặc chỉ lệch `form-action`/`frame-src`.
- [x] Task 3: tách rõ route bắt buộc `no-store` và route được cache (discovery, jwks, assets).
- [x] Task 3: HSTS không điều kiện. Bỏ "khi HTTPS".
- [x] Task 1: bản pin cụ thể, regression static bắt buộc, gate CI fail-closed, ignore `braces` có lý do.
- [x] Task 4: định nghĩa "chỗ cho phép" cho email (audit, CLI seed). Thêm 2 kênh lộ cụ thể (stack/E11000, URI DB). Harness pino chưa có nên phải dựng. Bỏ federation khỏi capture.
- [x] Task 5: expr cụ thể (loại `/metrics`, ngưỡng 0.1 rps), thêm 2 case promtool, promtool chỉ chạy CI.
- [x] Task 2: gitleaks qua image (không dùng action), CodeQL quyền cấp job, allowlist theo fingerprint/regex hẹp có lý do.

## Đề xuất (không bắt buộc, đã vào backlog)

- **DEBT-225:** kết quả lần chạy CI đầu của CodeQL, gitleaks, promtool và audit chỉ xác minh được sau push. Orchestrator/tester kiểm và triage.
- **DEBT-226:** `braces` GHSA-vfj7 chưa có bản vá, đang được ignore. Rà lại khi có bản vá; gỡ ignore.
- **DEBT-227:** actions đang pin theo tag, chưa theo SHA. Branch protection cần thêm required checks mới (`secrets`, `promtool`, CodeQL), việc này nằm ngoài repo.
- **DEBT-228:** `minimumReleaseAge: 0` trong `pnpm-workspace.yaml` tắt cooldown chống gói độc mới phát hành. Cân nhắc bật lại (ví dụ 14 ngày, khớp quy tắc "≥ 2 tuần") với `minimumReleaseAgeExclude` cho gói cần.

## Phân công

- **backend-dev:** Task 1 → 1b → 2 → 5 → 3 → 4, tuần tự (cùng sửa `ci.yml` và lockfile).
- **frontend-dev:** không có việc. Backend-dev tự chạy lại FE test nếu lockfile đổi.
- **tester:** full suite (unit, int, FE, E2E), mutation Task 3/4, traversal static, `pnpm audit --audit-level high` exit 0, parse YAML các workflow.
