# Tasks — run 38 — B7.4 supply chain & cấu hình + DEBT-219/223/224 (M7)

> Plan §B7 B7.4: "Bảo mật chuỗi cung ứng & cấu hình: `pnpm audit`, SAST, secret scan, kiểm tra security headers, rà toàn bộ log" — nghiệm thu "Không lỗ hổng high/critical chưa xử lý". R5 (pre-commit secret scan, gitleaks) có thể đã có — xác minh. Backlog: DEBT-219, 223, 224. Không cài công cụ toàn cục; công cụ mới chỉ qua devDependency pin exact hoặc chạy trong CI.
>
> Thứ tự: Task 1 → 2 → 3 → 4 → 5. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`, KHÔNG docker run/pull.

### [x] Task 1 [BE/FE]: Dependency audit
- Chạy `pnpm audit --prod` và đầy đủ cho workspace; xử lý mọi high/critical (nâng phiên bản pin exact / override có lý do / ghi chấp nhận rủi ro có căn cứ nếu không áp dụng được). DEBT-224: đổi `prom-client` → `@prometheus-io/client` (exact) nếu tech-lead chốt; chạy lại spec metrics.
- CI: bước `pnpm audit --audit-level high` (chặn merge).
- **Acceptance**: báo cáo audit trước/sau trong log; 0 high/critical chưa xử lý; test xanh.

### [x] Task 2 [CI]: SAST + secret scan
- SAST: tech-lead chốt (vd. CodeQL action, hoặc eslint-plugin-security đã có/không). Secret scan: gitleaks (xác minh R5) chạy trong CI trên toàn lịch sử/diff; không lộ secret thật trong repo (rà `be/.env.example`, `e2e/.env*`, fixtures, key test).
- **Acceptance**: workflow hợp lệ (parse YAML); chạy secret scan cục bộ nếu công cụ có sẵn trong repo, không thì ghi rõ; mọi phát hiện được xử lý hoặc allowlist có lý do.

### [x] Task 3 [BE]: Security headers
- Kiểm toàn bộ response loại chính (UI HTML, JSON OAuth, `/jwks.json`, discovery, `/admin/*`, `/metrics`, lỗi 4xx/5xx, 404): CSP (nonce, `form-action`, `frame-ancestors`), HSTS (khi HTTPS), `X-Content-Type-Options`, `Referrer-Policy`, `Cache-Control: no-store` cho response nhạy cảm, không `X-Powered-By`/server banner.
- **Acceptance**: int-test bảng header theo loại response; thiếu ⇒ sửa ở `configureApp`/helmet.

### [x] Task 4 [BE]: Rà log
- Rà mọi chỗ log (pino, console, error filter, audit metadata): không password/token/code/secret/cookie/authorization/email thô ngoài chỗ cho phép (spec §B1.3 redact). Test chạy luồng đầy đủ (login, authorize, token, refresh, federation, admin, metrics) thu log và grep mẫu bí mật.
- **Acceptance**: int-test thu log toàn luồng ⇒ 0 khớp; mutation (bỏ một redact) ⇒ RED.

### [x] Task 5 [ops]: DEBT-223 + DEBT-219
- DEBT-223: rule `SsoHttp5xxRatioHigh` thêm ngưỡng traffic tối thiểu, loại `route="/metrics"`; thêm case trong `alerts.test.yml`.
- DEBT-219: CI chạy `promtool check rules` + `promtool test rules` (qua container image trong CI, không cài cục bộ).
- **Acceptance**: `ops-rules.spec` xanh; workflow parse được.

## Câu hỏi cho tech-lead
- Q-38.1: Đổi prom-client ngay hay giữ.
- Q-38.2: Công cụ SAST + secret scan; CI hay pre-commit.
- Q-38.3: Phạm vi vừa 1 run không.

---

## Fold tech-lead (2026-10-20) — ƯU TIÊN HƠN text cũ ở trên

Kết luận: **PASS có fold**. Phạm vi giữ 1 run (5 task + Task 1b). Thứ tự: 1 → 1b → 2 → 5 → 3 → 4. Hạ tầng: như trên; `docker run` CHỈ trong workflow CI, không chạy cục bộ.

### Trả lời câu hỏi
- **Q-38.1 (prom-client)**: ĐỔI ngay, time-box (Task 1b). `@prometheus-io/client@0.16.1` (2026-08-27, engines `^22`, deps giống prom-client) pin exact. Gỡ `prom-client`. Chỉ đổi import (3 chỗ: `metrics.ts`, `metrics.http.ts`, `test/metrics.int-spec.ts`). Nếu chỉ đổi import mà `metrics.spec`/`ops-rules.spec`/`metrics.int-spec` không xanh (khác API hoặc khác exposition, assert `version=0.0.4`) ⇒ revert về prom-client 15.1.3, ghi lý do vào log, giữ DEBT-224 mở. Không viết adapter.
- **Q-38.2 (SAST + secret scan)**: chạy ở **CI**. Pre-commit gitleaks (R5) đã có (`.pre-commit-config.yaml`, gitleaks v8.21.2), giữ nguyên làm lớp tuỳ chọn ở máy dev, không bắt buộc cài.
  - SAST = **CodeQL** (repo `veyricdev/veyrigate` public ⇒ miễn phí). Workflow riêng `.github/workflows/codeql.yml`: `javascript-typescript`, `build-mode: none`, `queries: security-extended`, chạy khi push/PR vào develop|main và `schedule` hằng tuần. `permissions` ở **cấp job**: `contents: read`, `security-events: write`, `actions: read`. Top-level giữ `contents: read`. Không thêm `eslint-plugin-security` (nhiễu `detect-object-injection`).
  - Secret scan = gitleaks trong CI qua **container image** `zricethezav/gitleaks:v8.21.2` (cùng phiên bản pre-commit), job `secrets` trong `ci.yml`: `actions/checkout` với `fetch-depth: 0`, rồi `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 git /repo --redact --exit-code 1 --no-banner`. KHÔNG dùng `gitleaks/gitleaks-action` (cần license khi owner là org). Ghim digest nếu lấy được qua registry HTTP API (không `docker pull`). Không lấy được thì ghim tag và ghi log.
  - Phát hiện ⇒ sửa (xoá secret thật + coi như lộ) hoặc allowlist trong `.gitleaks.toml` / `.gitleaksignore` (theo fingerprint). Mỗi mục ghi lý do. Không allowlist cả thư mục `be/src` hay `test/`. Giá trị giả đã biết (`dev-password-123` trong ci.yml, khoá sinh trong test bằng mkdtemp) thì allowlist theo fingerprint hoặc regex hẹp.
  - Chạy cục bộ: không có gitleaks/semgrep trong PATH và không được `docker run`. Chỉ được dùng `go run github.com/zricethezav/gitleaks/v8@v8.21.2 git . --redact --no-banner` (vào Go module cache, không cài PATH) **nếu người dùng đồng ý**. Không có thì ghi "chưa chạy cục bộ", và DEBT-225 theo dõi lần chạy CI đầu.
- **Q-38.3 (phạm vi)**: vừa 1 run sau khi thu hẹp như dưới (bỏ `nonce`, bỏ federation khỏi log-capture, HSTS không điều kiện). Không tách.

### Số liệu audit thực tế (tech-lead chạy `pnpm audit` chỉ đọc, 2026-10-20)
Toàn workspace có 8 lỗ hổng (1 low, 4 moderate, 3 high). `--prod` có 4 (3 moderate, 1 high).

| Gói | Mức | Đường | Xử lý bắt buộc |
|---|---|---|---|
| `@fastify/static` 8.2.0 (direct `be`) | **high** GHSA-83w8-p2f5-377r + 3 moderate (GHSA-pr96, x428, 8pvw) | **prod** | Nâng exact `10.1.5` (2026-09-26; KHÔNG dùng 10.1.6 vì mới 11 ngày). Lưu ý: `@nestjs/platform-fastify@12.1.1` ĐANG khai peer `@fastify/static ^10.1.2`, tức hiện đã lệch peer. `@nestjs/swagger` peer `^8‖^9‖^10` vẫn hợp. |
| `source-map-js` <1.2.2 | high GHSA-68fv-2mgg-jv7q | dev (`@tailwindcss/cli`) | `1.2.2` (2026-09-30) nằm trong range `^1.2.1`. Chỉ cập nhật lockfile (`pnpm update source-map-js -r`). Cần override thì pin exact và ghi lý do. |
| `braces` ≤3.0.3 | high GHSA-vfj7-8cjw-p6xm, **chưa có bản vá** | dev (jest → micromatch) | Chấp nhận rủi ro: input glob do dev/CI tự viết, không phải input người dùng. Ghi ignore theo GHSA (`auditConfig.ignoreGhsas` trong `pnpm-workspace.yaml`, pnpm 12 kiểm cú pháp). Comment lý do + ngày rà lại. DEBT-226. |
| `sprintf-js` ≤1.1.3 | moderate, chưa có bản vá | dev | Dưới ngưỡng gate. Không làm. |
| `@eslint/plugin-kit` <0.3.4 | low | dev (fe-sso-test) | Tuỳ chọn: cập nhật lockfile nếu nằm trong range. |

### Task 1 [BE] — fold
- Nhãn đổi thành [BE] (FE chỉ có 1 low dev). Bước:
  1. nâng `@fastify/static` 10.1.5;
  2. cập nhật lockfile `source-map-js`;
  3. ignore `braces` có lý do.
- **Regression `@fastify/static` 8→10 (bắt buộc, int-test)**:
  - `GET /assets/styles.css` ⇒ 200, `content-type: text/css`;
  - `GET /assets/../app.module.js`, `/assets/%2e%2e/...`, `/assets/..%2f...` ⇒ không 200 và không trả nội dung ngoài `public/`;
  - dotfile `/assets/.x` ⇒ 404 hoặc 403;
  - thư mục `/assets/` ⇒ không liệt kê file.
  - E2E 16/16 vẫn xanh (UI dùng CSS).
- **Gate CI**: thêm step `pnpm audit --audit-level high` vào job `quality`, sau Install, trên toàn workspace (gồm dev, vì dev deps chạy trong CI). **Fail-closed**: KHÔNG dùng `--ignore-registry-errors`. Registry lỗi ⇒ job đỏ, rerun tay.
- **Acceptance**:
  - log ghi bảng trước/sau;
  - `pnpm audit --audit-level high` exit 0 cục bộ (chỉ còn GHSA đã ignore có lý do);
  - `pnpm audit --prod` 0 high/critical;
  - `pnpm ls --depth 0 -r` không còn cảnh báo peer `@fastify/static`;
  - BE unit + int + E2E xanh.

### Task 1b [BE] — DEBT-224 (xem Q-38.1)
- **Acceptance**:
  - `be/package.json` không còn `prom-client`;
  - `metrics.spec`, `ops-rules.spec`, `metrics.int-spec` xanh;
  - output `/metrics` giữ đúng tên metric/label (ops không đổi). Nếu rơi vào nhánh revert thì ghi rõ trong log.
- Đóng DEBT-221 cùng DEBT-224.

### Task 2 [CI] — fold (xem Q-38.2)
- Rà repo (tĩnh, `git ls-files`): `be/.env.example`, `e2e/.env.example`, `fe-*/.env.example`, `ci.yml`, fixtures. Không có private key PEM thật được track (`be/keys/` đã gitignore). Kết quả ghi log.
- **Acceptance**:
  - `ci.yml` và `codeql.yml` parse được (dùng `yaml` có sẵn trong be: `node -e` parse);
  - job `secrets` dùng `fetch-depth: 0` + `--exit-code 1`;
  - CodeQL chỉ có quyền ghi ở cấp job;
  - mỗi allowlist có lý do.
  - Kết quả CodeQL/gitleaks lần chạy CI đầu ⇒ DEBT-225 (orchestrator/tester kiểm sau push).

### Task 3 [BE] — Security headers (fold)
- **Bỏ yêu cầu `nonce`**: UI không có inline script (`script-src 'self'`, `script-src-attr 'none'`). Thay bằng: `script-src` không chứa `'unsafe-inline'`/`'unsafe-eval'`. Route không có CSP riêng phải có CSP === `buildCsp()`. Route có CSP riêng (login/consent/logout/frontchannel) chỉ được khác ở `form-action`/`frame-src`.
- **HSTS**: helmet phát không điều kiện. Assert `strict-transport-security` có `max-age>=15552000` trên mọi loại response. Không làm logic "chỉ khi HTTPS".
- **`Cache-Control`** theo loại:
  - **bắt buộc `no-store`**: `/token`, `/introspect`, `/revoke`, `/userinfo`, `/admin/*` (JSON), `/metrics`, `/login` và các trang HTML có form/CSRF, lỗi 4xx/5xx từ những route đó;
  - **ĐƯỢC cache** (không ép no-store): `/.well-known/openid-configuration` (hiện `public, max-age=300`), `/jwks.json`, `/assets/*`.
- Mọi loại phải có:
  - `x-content-type-options: nosniff`;
  - `referrer-policy` (`no-referrer` của helmet);
  - `x-frame-options` hoặc `frame-ancestors 'none'`;
  - **không** có `x-powered-by`;
  - không có header `server` lộ phiên bản.
- Loại cần phủ:
  - UI HTML 200;
  - JSON OAuth 200 + 400 (`invalid_request`);
  - discovery;
  - jwks;
  - `/admin/*` 200 + 401;
  - `/metrics` 200 + 401;
  - 404 route lạ;
  - 500: ép lỗi bằng mock dependency, theo cách các int-spec hiện có làm.
- Thiếu header thì sửa tại `configureApp`/helmet hoặc controller tương ứng, không rải header thủ công ở nơi khác. Đổi helmet config thì phải giữ `buildCsp()` byte-identical (spec DEBT-084).
- **Acceptance**: 1 int-spec dạng bảng (`describe.each`) dùng **`configureApp` thật** (hoặc helper bootstrap int đang dùng chung). Mutation: bỏ `formAction`/`frameAncestors` khỏi helmet, hoặc bỏ `no-store` ở `/token` ⇒ RED.

### Task 4 [BE] — Rà log (fold)
- **Chính sách lộ (exposure rules)** áp cho log ứng dụng (pino/Nest Logger/console trong runtime server):
  - không được có giá trị thô của: password, access/refresh/id token, authorization code, `code_verifier`, client_secret, cookie `idp_session`/federation cookies, header `Authorization`, CSRF token, `METRICS_TOKEN`, private key, email người dùng.
  - **Được phép**: email trong **audit** (không phải log) theo thiết kế hiện tại; CLI seed (`seed.ts`, `seed-dev.ts` in email ra console của operator), giữ nguyên.
- **Rà tĩnh 32 call-site** (`grep logger\.(log|warn|error|debug|verbose)` + `console.*` trong `be/src`). Ghi bảng trong log: file:dòng ⇒ dữ liệu ⇒ OK/sửa. Rủi ro đã thấy, phải xét:
  1. `OAuthExceptionFilter` và `token`/`introspect` controller log `err.stack ?? err.message` của lỗi không lường trước. Mongo `E11000` có `dup key: { email: "…" }`, đó là kênh lộ email/giá trị. Cần cách xử lý cụ thể: log `err.name` + `code` + stack đã cắt dòng message, hoặc scrub `dup key:`; dev chọn cách đơn giản nhất và có test.
  2. `Mongo error: ${err.message}` / readiness `${err.message}`: URI có `user:pass@` không được xuất hiện. Test với URI chứa credential giả.
  3. Comment `REDACT_PATHS` ghi "wildcard any depth" là **sai**: fast-redact `*` chỉ khớp 1 cấp. Sửa comment cho đúng. Chỉ thêm path khi có call-site thật log object nhạy cảm, không mở rộng đoán mò.
- **Int-test thu log**: hiện **không int-spec nào nối pino**. Thêm 1 spec bootstrap app với `LoggerModule` của nestjs-pino dùng **`buildPinoHttpOptions` thật** + destination stream ghi vào bộ nhớ, và `app.useLogger(app.get(Logger))`.
  - Luồng cần chạy: register/login (password), `/authorize` ⇒ code, `/token` code + PKCE (`code_verifier`), refresh, `/userinfo` Bearer, `/introspect` + `/revoke` (client_secret Basic), 1 call `/admin/*` Bearer, `/metrics` Bearer `METRICS_TOKEN`, 1 lỗi 500 có message chứa email (case E11000 hoặc mock ném `Error` chứa email+token).
  - Thu mọi giá trị bí mật **thực tế đã dùng** ⇒ assert log thu được không chứa chuỗi con nào trong đó. Kiểm cả dạng URL-encoded của code/token.
  - Federation: không nằm trong log-capture. Chỉ rà tĩnh (các dòng log federation chỉ in `code` lỗi cố định).
- **Acceptance**:
  - spec xanh với ≥1 assert dương: log có `req.id`/statusCode, chứng minh capture hoạt động thật;
  - **Mutation (RED bắt buộc)**: (a) `serializeRequest` trả nguyên `req.url` có query; (b) bỏ `'req.headers.authorization'` **và** cho serializer trả headers; (c) bỏ cách scrub ở mục 1 ⇒ RED;
  - khôi phục và kiểm sha256 như run 37.

### Task 5 [ops] — fold
- DEBT-223:
  - expr: `(sum(rate(…{status_class="5xx",route!="/metrics"}[5m])) / sum(rate(…{route!="/metrics"}[5m])) > 0.05) and sum(rate(…{route!="/metrics"}[5m])) > 0.1`;
  - giữ `for: 5m`, giữ annotations (ops-rules.spec so annotation);
  - promtool test thêm 2 case: (i) traffic thấp (<0.1 rps, toàn 5xx) ⇒ không alert; (ii) chỉ `/metrics` 5xx ⇒ không alert. Case 10%/1% hiện có vẫn đúng.
- DEBT-219:
  - job `promtool` trong `ci.yml`, dùng image `prom/prometheus` ghim tag exact (bản ≥ 2 tuần, digest nếu lấy được qua HTTP API) với `--entrypoint promtool`: `check rules /ops/prometheus/alerts.yml` và `test rules /ops/prometheus/alerts.test.yml`.
  - Chỉ chạy trong CI. Cục bộ dựa vào `ops-rules.spec`, ghi rõ promtool chưa chạy cục bộ. Kết quả lần chạy đầu ⇒ DEBT-225.
- **Acceptance**: `ops-rules.spec` xanh; workflow parse được; đóng DEBT-223, DEBT-219 (phần CI; xác nhận thực tế ở DEBT-225).

### Phân công
- **backend-dev**: Task 1, 1b, 2, 5, 3, 4. Một dev làm tuần tự vì cùng sửa `ci.yml`/lockfile.
- **frontend-dev**: không có việc. Chỉ chạy lại `pnpm -C fe-sso-test test` nếu lockfile đổi; backend-dev tự chạy.
- **tester**: chạy full (unit/int/FE/E2E), mutation Task 3/4, kiểm traversal `@fastify/static`, kiểm `pnpm audit --audit-level high` exit 0, parse YAML workflow.
