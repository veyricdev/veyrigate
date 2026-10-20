# Test Report — 2026-10-20 — run 38 (B7.4 + DEBT-219/223/224)

## Kết quả: FAIL (BE int 1167/1176; 9 FAIL đều cùng một lỗi [BE])

| Bộ | Kết quả |
|---|---|
| `pnpm audit --audit-level high` | exit 0 (1 low, 1 moderate, 1 high đã ignore = `braces`/DEBT-226) |
| `pnpm audit --prod` | exit 0, "No known vulnerabilities found" |
| Parse YAML (`ci.yml`, `codeql.yml`, `ops/prometheus/alerts.yml`, `alerts.test.yml`) | 4/4 OK |
| `pnpm -r run typecheck` | exit 0 |
| `pnpm -C be lint` | exit 0 |
| BE unit `pnpm -C be test` | 356/356 (29 suite) |
| BE int `pnpm -C be test:int` FULL | **1167 pass / 9 fail / 1176** (43 suite, 322.9 s). 1140 test của dev xanh hết; 9 FAIL nằm trong spec mới của tester |
| FE `pnpm -C fe-sso-test test` | 240/240 (31 file) |
| E2E `pnpm -C e2e e2e` | 16/16 (1.4 phút) |
| Mutation `errorForLog` trả `err.stack` | spec tester RED (`email`, `error text secret`); khôi phục cp, sha256 khớp `f937fcbd…ef2e` |
| `be/src/public` sau mọi lần chạy | chỉ có `styles.css`, `logout-redirect.js`; 0 file `.vg-dot-*` / `vg-link-*` (DEBT-234 không tái hiện) |

## Lệnh đã chạy + output thực tế (Git Bash)

```
$ pnpm audit --audit-level high            -> exit 0
2 vulnerabilities found
Severity: 1 low | 1 moderate
1 ignored: 1 high
$ pnpm audit --prod --audit-level low      -> exit 0
No known vulnerabilities found
$ node -e (yaml.parseAllDocuments) ...
../.github/workflows/ci.yml OK name,on,concurrency,permissions,jobs
../.github/workflows/codeql.yml OK name,on,concurrency,permissions,jobs
../ops/prometheus/alerts.test.yml OK rule_files,evaluation_interval,tests
../ops/prometheus/alerts.yml OK groups
```
Kiểm cấu trúc workflow:
- `ci.yml`: top `permissions: {contents: read}`, không job nào nới quyền;
- `quality` có step `pnpm audit --audit-level high` sau `pnpm i --frozen-lockfile`, không có `--ignore-registry-errors`;
- `secrets`: `fetch-depth: 0`, gitleaks `v8.21.2@sha256:0e99…`, `--redact --exit-code 1`;
- `promtool`: `prom/prometheus:v3.15.0@sha256:efd7…`, mount `:ro`.
- `codeql.yml`: top `contents: read`; job `analyze` có `contents: read, security-events: write, actions: read`; `security-extended`, `build-mode: none`.
- `.gitleaks.toml`: `useDefault = true`, 4 regex giá trị giả, không allowlist path.
- `alerts.yml`: `SsoHttp5xxRatioHigh` có `route!="/metrics"` và `and … > 0.1`.

```
$ pnpm -r run typecheck   -> be/e2e/fe-sso-test/fe-admin Done, exit 0
$ pnpm -C be lint         -> exit 0
$ pnpm -C be test         -> Test Suites: 29 passed; Tests: 356 passed, 356 total
$ pnpm -C be test:int     -> Test Suites: 1 failed, 42 passed, 43 total
                             Tests: 9 failed, 1167 passed, 1176 total  (Time 322.906 s)
$ pnpm -C fe-sso-test test -> Test Files 31 passed (31); Tests 240 passed (240)
$ pnpm -C e2e e2e          -> 16 passed (1.4m)
```

Spec mới của tester: `be/test/b74-tester.int-spec.ts` (36 test: 33 `it` + 2 `it.failing` ghi nhận debt + 1 symlink chỉ ghi nhận hành vi). Chạy riêng: `Tests: 9 failed, 27 passed, 36 total`.

## Test FAIL

**[BE] `@fastify/static` 10 trả lỗi 403 "Forbidden path" nhưng `OAuthExceptionFilter` biến nó thành 500 `server_error`.** Trả lại **backend-dev**.

- 9 test: `/assets//..//app.module.ts`, `/assets/....//app.module.ts`, `/assets/%00../app.module.ts`, `/assets/..%00/app.module.ts`, `/assets//etc/passwd`, `/assets/C%3a%5cWindows%5cwin.ini`, `/assets/%5c%5c127.0.0.1%5cc$%5cWindows%5cwin.ini`, `/assets/%2e%2e%5c%2e%2e%5cpackage.json`, và URL bình thường `/assets//styles.css`.
- Kỳ vọng: 4xx (403/404), không nội dung ngoài `public/`. Thực tế: **500** `{"error":"server_error",…}`. Không lộ nội dung (assert "không có file ngoài `public/`" đều qua trước assert status).
- Nguyên nhân (đã đọc stack trong log thu được): `@fastify/static@10.1.5/index.js:157,309` gọi `reply.send(forbiddenPathError())`. Hàm này (`:640`) trả `Error('Forbidden')` có `statusCode = 403`. Lỗi rơi vào `OAuthExceptionFilter` global (`be/src/common/filters/oauth-exception.filter.ts:37`): không phải `HttpException` ⇒ status 500, kèm log level 50 `OAuthExceptionFilter`.
- Tác động (vì sao FAIL dù không lộ dữ liệu):
  - Người ẩn danh tạo 5xx tuỳ ý trên `route="/assets/*"`. Metric dùng route template, và rule `SsoHttp5xxRatioHigh` (sửa ở run này) chỉ loại `/metrics`. Chỉ cần trên 0.1 rps và trên 5% traffic là bắn được alert **critical** giả. Đây đúng loại báo động sai mà DEBT-223 nhắm tới.
  - Mỗi request sinh một error log level 50.
  - URL hợp lệ có `//` (`/assets//styles.css`) cũng nhận 500.
  - Lỗi do run này: nâng 8→10.
- Gợi ý sửa (dev quyết): trong `OAuthExceptionFilter`, lỗi không phải `HttpException` mà có `statusCode` số trong khoảng 400–499 (lỗi chuẩn của Fastify/plugin) ⇒ trả đúng status đó + `errorCodeForStatus`, không log error. Hoặc xử lý riêng `/assets/*`. Khi xanh: 9 case trong `b74-tester.int-spec.ts` phải pass.

## Coverage acceptance criteria

- [x] T1 audit: `pnpm audit --audit-level high` exit 0, `--prod` 0 lỗ hổng (lệnh trên); CI step fail-closed (kiểm cấu trúc).
- [ ] T1 regression `@fastify/static` 8→10: traversal/dotfile/listing không lộ file (dev `static-assets.int-spec` 12/12 + tester 27 biến thể đều không lộ). **Nhưng** 9 biến thể trả 500 thay vì 4xx ⇒ FAIL ở trên. E2E 16/16 (UI tải `/assets/styles.css` 200).
- [x] T1b `@prometheus-io/client`: `metrics.spec`, `ops-rules.spec`, `metrics.int-spec` xanh trong full run.
- [x] T2 workflow parse + `fetch-depth: 0` + `--exit-code 1` + quyền ghi CodeQL chỉ ở job + allowlist có lý do. gitleaks/CodeQL/promtool **chưa chạy** (không chạy cục bộ theo fold) ⇒ DEBT-225.
- [x] T3 headers: dev `security-headers.int-spec` 114/114. Tester thêm loại HTML lỗi:
  - `POST /login` không có CSRF ⇒ 403 HTML có nosniff/no-referrer/XFO/HSTS ≥180 ngày/CSP === `buildCsp()`, không `x-powered-by`;
  - `GET /authorize` 500 ⇒ đủ header gốc;
  - **xác nhận DEBT-233**: 403 HTML không có `no-store` (`it.failing` pass); `/authorize` 500 HTML cũng không có `Cache-Control` (cùng DEBT-233);
  - federation callback 500 có `no-store` (controller đặt trước).
- [x] T4 log:
  - dev `log-capture.int-spec` xanh;
  - tester thêm luồng federation callback lỗi: state giả, `error=access_denied` + `error_description` bí mật, fetch provider ném lỗi chứa code/email, provider trả 400 echo code + `GOOGLE_CLIENT_SECRET`, `FederationStateStore.consume` ném ⇒ 500;
  - admin 500 với Error nhiều dòng (E11000 + email), throw chuỗi, throw object;
  - kết quả: log có `federation failed: invalid_state` / `provider_unavailable` và dòng access 500, nhưng **0 bí mật** (state, binding cookie, provider code, client secret, `METRICS_TOKEN`, admin token, email, error text), kể cả dạng URL-encoded;
  - mutation `errorForLog` ⇒ RED.
  - Riêng message có dòng giống frame `"    at …"` thì lọt (xác nhận nit senior) ⇒ DEBT-235 (`it.failing`).
- [x] T5 ops: `ops-rules.spec` xanh; YAML parse; expr đúng fold. promtool chỉ chạy CI (DEBT-225).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Input (path) | overlong UTF-8 `%c0%ae`, `%e0%80%ae`, `%u002e`, fullwidth `．`, `‥`, double-encode `%252e`, `.%2e`/`%2e.`, `//`, `/assets/../assets/…`, `styles.css/../../`, `....//`, `..;`, NUL, đường tuyệt đối `/etc/passwd`, `C:\`, UNC | `b74-tester` static: 0 lộ; 9 ⇒ 500 (FAIL) |
| Input (symlink) | symlink trong `public/` trỏ ra `src/app.module.ts` | tạo được (Windows), phục vụ **200** ⇒ cần quyền ghi `public/`, ngoài threat model ⇒ DEBT-236 |
| Identity / Credential | `/metrics` sai bearer 401, admin không token 401 (dev); admin bearer hợp lệ cho các case 500 | security-headers, b74-tester |
| Dependency failure | state store lỗi ⇒ 500 (không che thành success); provider down ⇒ 502 `provider_unavailable`; admin service lỗi ⇒ 500 | b74-tester |
| Exposure (log) | state, binding cookie, provider code, `error_description`, client secret Google + OAuth client, token, email, error text, raw + URL-encoded | b74-tester log capture (0 khớp) + mutation RED |
| Exposure (header) | HTML 403/500 lỗi: nosniff/referrer/frame/HSTS/CSP/x-powered-by/server; `no-store` thiếu ⇒ DEBT-233 | b74-tester headers |
| Ops | 5xx do client kích hoạt trên `/assets/*` vào metric ⇒ alert critical giả | phân tích từ FAIL + `metrics.http.ts:37` (route template) |

## Ghi chú hạ tầng
- Docker: `vg-test-mongo`/`vg-test-redis` đã chạy sẵn, không start/stop gì. Khoá `vg:int-lock` do preflight/teardown xử lý, không đụng tay.
- :5173/:4000 trống trước và sau E2E. Không còn process nào do tester khởi động.
- Không đụng `be/keys`, `be/.env`, `aegate-*`. Không commit.

---

# Lượt 2 — 2026-10-20 (sau backend-dev retry 1 + senior lượt 2 PASS)

## Kết quả: PASS (BE int FULL 1193/1193)

| Bộ | Kết quả |
|---|---|
| `pnpm audit --audit-level high` | exit 0 (1 low, 1 moderate, 1 high ignore = `braces`/DEBT-226); `--prod`: "No known vulnerabilities found" |
| Parse YAML (`ci.yml`, `codeql.yml`, `alerts.yml`, `alerts.test.yml`) | 4/4 OK; checkout job `secrets` = `{fetch-depth: 0, persist-credentials: false}`, `promtool` = `{persist-credentials: false}` (DEBT-232) |
| `pnpm -r run typecheck` / `pnpm -C be lint` | exit 0 / exit 0 |
| BE unit `pnpm -C be test` | **366/366** (30 suite) |
| `b74-tester.int-spec.ts` chạy riêng | **53/53**. 36 case cũ: 9 case FAIL lượt 1 nay xanh; 0 `it.failing` (2 cái đã thành `it`). Thêm 17 case mới của lượt 2 |
| BE int `pnpm -C be test:int` FULL | **1193/1193** (43 suite, 318.1 s) = 1176 của dev + 17 case mới |
| FE `pnpm -C fe-sso-test test` | **240/240** (31 file) |
| E2E `pnpm -C e2e e2e` (1 lần) | **16/16** (1.6 phút) |
| Mutation: `clientErrorStatus` luôn trả `undefined` | **10 RED** (9 traversal cũ + case mới "static forbidden path"). Khôi phục bằng cp, sha256 `7375cdc9…97c5` khớp |
| Mutation: cận trên `<= 499` thành `<= 599` | **1 RED** ("dependency Error with statusCode 503"). Khôi phục bằng cp, sha256 khớp |

## Lệnh đã chạy + output thực tế (Git Bash)

```
$ pnpm -C be test:int -- b74-tester            -> Tests: 53 passed, 53 total
$ pnpm -r run typecheck                         -> be/e2e/fe-sso-test/fe-admin Done, exit 0
$ pnpm -C be lint                               -> exit 0
$ pnpm -C be test                               -> Test Suites: 30 passed; Tests: 366 passed, 366 total
$ pnpm -C be test:int                           -> Test Suites: 43 passed, 43 total
                                                   Tests: 1193 passed, 1193 total  (Time: 318.104 s)
$ pnpm -C fe-sso-test test                      -> Test Files 31 passed (31); Tests 240 passed (240)
$ pnpm -C e2e e2e                               -> 16 passed (1.6m)
$ pnpm audit --audit-level high                 -> exit 0 (Severity: 1 low | 1 moderate; 1 ignored: 1 high)
$ pnpm audit --prod                             -> No known vulnerabilities found
# mutation 1 (clientErrorStatus => undefined)   -> Tests: 10 failed, 43 passed, 53 total
# mutation 2 (status <= 599)                    -> Tests: 1 failed, 52 passed, 53 total
```

Output thực tế của các ca 4xx (in bằng `console.warn` trong spec):
```
broken JSON (anonymous admin POST): POST /admin/clients -> 400 cc=no-store {"error":"invalid_request","error_description":"Body is not valid JSON but content-type is set to 'application/json'"}
broken JSON on /token:              POST /token         -> 400 cc=no-store (cùng body)
broken JSON on HTML /login:         POST /login         -> 400 cc=no-store (cùng body; JSON vì lỗi đi qua filter global)
empty JSON body:                    POST /admin/clients -> 400 cc=no-store "Body cannot be empty when content-type is set to 'application/json'"
body over 1 MiB:                    POST /admin/clients -> 413 cc=no-store "Request body is too large"
unsupported content-type:           POST /admin/clients -> 415 cc=no-store "Unsupported Media Type"
unsupported content-type on /token: POST /token         -> 415 cc=no-store "Unsupported Media Type"
malformed percent-encoding:         GET /assets/%E0%A4%A -> 400 cc=undefined {"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'/assets/%E0%A4%A' is not a valid url component","statusCode":400}
malformed (unmatched path):         GET /nope/%zz%       -> 400 cc=undefined (giống trên)
  headers: {"content-type":"application/json","content-length":"125","date":…,"connection":"keep-alive"}
static forbidden path:              GET /assets//styles.css -> 403 cc=no-store {"error":"access_denied","error_description":"The request could not be completed."}
```

## Test mới (lượt 2)

Thêm vào `be/test/b74-tester.int-spec.ts`, block `retry 1: Fastify client errors vs real server errors`, gồm 17 case. Mỗi case đọc `/metrics` (bearer) trước và sau request, và đếm số dòng log `"level":50`.

**10 ca 4xx**: JSON hỏng (admin ẩn danh, `/token`, HTML `/login`), body rỗng, body > 1 MiB, content-type sai (×2), URL percent-encoding hỏng (×2), static forbidden path.
- Cả 10 ca: status đúng (400/413/415/403), 0 dòng error log mới, `status_class="5xx"` của route không tăng.
- Riêng các ca đi qua filter: `status_class="4xx"` +1, có `no-store`, body không chứa input (content-type `evilmark`, payload).

**6 ca lỗi server trên `/admin/clients`** (spy `listForTenant`): MongoServerError E11000, MongoNetworkError, ioredis `ECONNREFUSED`, Error có `statusCode: 503`, Error có `status: 404` (không phải `statusCode`), Error có `statusCode: '403'` (chuỗi).
- Cả 6 ca: **500** `server_error`, có error log mới, `5xx` +1, `4xx` không đổi.

**1 ca HTML**: lỗi dạng Redis `ECONNREFUSED` trên `/authorize` ⇒ 500 HTML, `no-store`, `5xx` +1.

## Test FAIL
Không có.

## Quan sát không chặn ⇒ DEBT-239 🟡

URL percent-encoding hỏng (`FST_ERR_BAD_URL`) được Fastify `onBadUrl` trả lời trực tiếp, trước routing, hook và filter của Nest. Hành vi này có từ trước run 38 (Fastify 5.12.5 không đổi ở run này), nên không phải hồi quy.

Hệ quả:
- Không có security header (nosniff/CSP/HSTS/frame) và không có `no-store`.
- Body echo nguyên path thô (JSON, `content-type: application/json`).
- Không chạy hook `onResponse` ⇒ không vào `sso_http_request_duration_seconds` (không 4xx, không 5xx).
- Không có error log.

Đánh giá: không bơm được alert 5xx, không lộ gì ngoài path do chính người gửi đưa vào, và echo nằm trong JSON chứ không phải HTML. Phần hở thực sự là thiếu header cơ sở và metric không thấy loại request này. Vì vậy ghi PENDING, không FAIL.

Ghi nhận thêm (có từ trước, không mở debt): lỗi body của Fastify (`FastifyError`) được `FastifyAdapter.mapException` của Nest đổi thành `HttpException(message, statusCode)`. Do đó `error_description` là message cố định của Fastify, không phải mô tả chung của `clientErrorStatus`. Đã kiểm: các message này không chứa input (không content-type, không payload).

## Coverage acceptance criteria (lượt 2)
- [x] FAIL lượt 1 (9 case `@fastify/static` 403 thành 500): nay xanh. Mutation tắt nhánh 4xx ⇒ 10 RED.
- [x] `it.failing` DEBT-233 (403 HTML có `no-store`) và DEBT-235 (dòng message giống frame) đã thành `it`, xanh; `grep -c it.failing` = 0.
- [x] T1 audit, T1b, T2 (YAML + `persist-credentials: false`), T3, T4, T5: full int 1193/1193, FE 240, E2E 16/16, audit exit 0.
- [x] Fastify 4xx chuẩn (JSON hỏng 400, body quá lớn 413, content-type sai 415, URL hỏng 400): đúng 4xx, 0 error log.
- [x] Lỗi server thật (Mongo/Redis) vẫn 500, có log, có metric 5xx.
- [x] Alert không bị bơm: `status_class="5xx"` không tăng ở mọi ca 4xx.

## Coverage security invariants / risk matrix (lượt 2)

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | anonymous (body/URL/static), admin bearer hợp lệ (ca 500) | `b74-tester` retry 1 |
| Input | JSON hỏng/rỗng, body > 1 MiB, content-type lạ, percent-encoding hỏng, path non-canonical | 10 ca 4xx |
| Dependency | Mongo duplicate/network, Redis ECONNREFUSED, dep mang `statusCode` 503 / `status` 404 / `statusCode` chuỗi ⇒ fail-closed 500 + log, không bị hạ xuống 4xx | 7 ca 5xx + mutation `<= 599` RED |
| Exposure | body 4xx không echo content-type/payload (ngoại lệ `FST_ERR_BAD_URL`, DEBT-239); log 0 bí mật (case cũ) | retry 1 + log capture |
| Ops/metric | 4xx ⇒ `status_class="4xx"`, 5xx thật ⇒ `5xx`; không có 5xx giả trên `/assets/*`, `/admin/clients`, `/token`, `/login` | so `/metrics` trước/sau |

## Ghi chú hạ tầng (lượt 2)
- `vg-test-mongo`/`vg-test-redis` đã chạy sẵn, không start/stop gì. Khoá `vg:int-lock` do preflight/teardown xử lý.
- :5173 và :4000 trống trước và sau E2E, không phải dừng process nào. Không còn process jest/playwright/vite nào do tester khởi động.
- `be/src/public` sau mọi lần chạy chỉ có `styles.css` và `logout-redirect.js`.
- Không đụng `be/keys`, `be/.env`, `aegate-*`. Không commit.
