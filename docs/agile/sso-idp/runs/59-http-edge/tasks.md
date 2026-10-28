# Tasks — run 59 — làm cứng biên HTTP (M7, lane BE/FE)

> Nguồn: `backlog.md` (đọc nguyên văn + run gốc): DEBT-387 (fe-admin/Start router trả `308` với `Location` tuyệt đối dựng từ `Host` cho `GET //a` — trái runbook §7), DEBT-236 (`@fastify/static` 10 theo symlink trong `src/public/` ra ngoài thư mục), DEBT-239 (URL percent-encoding hỏng bị Fastify `onBadUrl` trả 400 `FST_ERR_BAD_URL` trước …), DEBT-135 (`error_description` admin phản chiếu input ≤2048 ký tự), DEBT-197 (`verifyGoogleIdToken`: JWKS non-200/JSON hỏng ⇒ `JOSEError` …). Spec/plan: §6.2, B7.4, A7, runbook-deploy §7/§9, `security-matrix.md`. Không phá run 51–58 (CSP/headers, body limit, error filter DEBT-238).
>
> Tech-lead: xác minh từng debt còn đúng HEAD, rủi ro thật, đóng cái đã xong/không đáng (kèm bằng chứng); chọn ≤5 task; chỉ ra lane [BE]/[FE]. Hạ tầng: KHÔNG compose up/FLUSH/drop; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop).

### [ ] Task 1 [FE]: DEBT-387 — path bắt đầu `//` không tạo redirect theo `Host`.
### [ ] Task 2 [BE]: DEBT-236 — static không theo symlink ra ngoài root.
### [ ] Task 3 [BE]: DEBT-239 — URL hỏng trả lỗi đúng định dạng/header (CSP, no-store) và không log noise.
### [ ] Task 4 [BE]: DEBT-135 — cắt/không phản chiếu input trong `error_description` admin.
### [ ] Task 5 [BE]: DEBT-197 — lỗi JWKS Google ⇒ lỗi rõ (503/thông báo), không 500 mơ hồ.

---

## Fold tech-lead (2026-10-28) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Bằng chứng xác minh từng debt: `review-techlead.md`. **Đóng không code**: DEBT-135 (echo chỉ tới chính admin đã xác thực, JSON + nosniff + no-store, BFF cắt 200 ký tự, đường OAuth không phản chiếu), DEBT-236 (`dist/public` là bản chép `copyFileSync`, image root-owned + user 1000, `@fastify/static` 10.1.5 không có option symlink). ⇒ **Task 2 và Task 4 gốc HUỶ.** Còn 3 task, đánh số lại T1–T3. Lane: T1 → frontend-dev; T2, T3 → backend-dev (độc lập, làm song song được). Text gốc Task 5 ghi "503": SAI, hợp đồng `provider_unavailable` là **502** (`federation.controller.ts:55`).

### Cổng security (chung cho cả 3 task)

- **Tài sản/actor/boundary**: request HTTP chưa xác thực từ Internet (T1, T2) — kẻ tấn công điều khiển path và `Host`; provider Google qua mạng (T3) — sự cố/kẻ tấn công điều khiển phản hồi JWKS (status, body). Không task nào đổi authn/authz, cookie, session, CSRF.
- **Invariant**: (I1) không response nào của fe-admin có `Location` dựng từ `Host` (runbook §7). (I2) mọi response lỗi của BE, kể cả lỗi trước routing, có bộ header helmet như response thường + `cache-control: no-store`, body không echo input, không log level ≥ 50 cho lỗi 4xx của client, metric đếm đúng 1 lần với `route` cố định (không bao giờ là URL thô). (I3) lỗi phía provider (JWKS) = 502 `provider_unavailable`; lỗi phía token = 400 `invalid_identity`; cả hai: không session, không user, không link.
- **Abuse case**: `Host` giả + `//evil.example/a` / `/\evil.example` (open redirect, cache poisoning); percent-encoding hỏng + param > 100 ký tự (né header, log/metric mù, phản chiếu path); JWKS 503 / JSON rác / JWKS sai hình dạng (phân loại sai ⇒ sự cố provider bị giấu sau 400); token ký bằng khoá lạ (vẫn phải 400, không được nâng thành 502).
- **Failure semantics**: T1 trả trước router, không chạm phụ thuộc. T2 không chạm phụ thuộc; handler không được ném (ném ⇒ Fastify 500 thô) — chỉ set header + send + observe. T3: fetch JWKS đã có timeout (`PROVIDER_TIMEOUT_MS`), fail-closed (không đăng nhập), không retry (code dùng một lần).
- **Exposure**: không echo path/`Host`/body provider vào response, log hay label metric.

### [x] T1 [FE] DEBT-387 — path bắt đầu `//` ⇒ 404, không bao giờ redirect theo `Host`

- **Sửa** `fe-admin/src/server.ts`, ngay sau nhánh `/assets/` (trước `rejectBody`), mọi method: `pathname.startsWith("//")` ⇒ `new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })` (nằm trong `withSecurityHeaders` ⇒ có CSP/nosniff/no-store). `pathname` lấy từ `new URL(request.url)` sẵn có (WHATWG đã đổi `\` thành `/`). **Cấm** thay bằng redirect tương đối tự dựng.
- Bằng chứng nguồn: `@tanstack/router-core@1.171.34` `ssr-server.js:365` `getNormalizedURL` + `@tanstack/start-server-core@1.169.39` `createStartHandler.js:284` `Response.redirect(url, 308)`; `/%2F%2F…`, `/%5C%5C…` không kích hoạt (đã probe).
- **Runbook §7** (dòng "Không bật trust proxy"): thêm "path bắt đầu `//` ⇒ 404 (DEBT-387); proxy chỉ nên nhận `Host` = host của `APP_URL`".
- **Test bắt buộc** (`fe-admin/test/server-entry.test.ts`, describe mới):
  - (âm) `http://evil.example//a`, `http://evil.example//evil.example/x?y=1`, `http://localhost:3000///a`, `http://localhost:3000//`, `http://evil.example/\evil.example` (chuỗi có backslash), method GET/HEAD/POST ⇒ 404, header `location` null, `expectA7`, router KHÔNG được gọi.
  - (dương, không chặn nhầm) `/a//b`, `/%2F%2Fevil.example`, `/` ⇒ router được gọi đúng 1 lần.
- **Smoke** `fe-admin/scripts/docker-smoke.sh`: thêm 1 check `curl --path-as-is -H 'Host: evil.example' http://…//a` ⇒ 404, không `location`, có `content-security-policy` (tester chạy nếu được phép dùng Docker; không thì ghi rõ "không chạy").
- **Mutation** (ghi `log.md`): xoá guard ⇒ case âm RED; đổi `startsWith("//")` thành `=== "//"` ⇒ RED.
- **Verify**: `pnpm -C fe-admin test` + lint/typecheck như run 52.

### [x] T2 [BE] DEBT-239 — URL hỏng / param quá dài ⇒ lỗi đúng định dạng, có header, no-store, metric, không log

- Bằng chứng nguồn: `fastify@5.12.5` `fastify.js:645` (`onBadUrl` 400 thô, echo path), `:670` (`onMaxParamLength` 414 thô, echo path; find-my-way `maxParamLength` mặc định 100), cả hai gọi `options.frameworkErrors` nếu có, với `routeEventContext` (`:434`, không hook) ⇒ helmet/metric KHÔNG tự chạy.
- **Sửa**: file mới `be/src/common/http/framework-errors.ts` export (1) `frameworkErrors(error, request, reply)` và (2) `createFastifyAdapter(trustProxy?)` trả `new FastifyAdapter({ trustProxy, frameworkErrors })`. Thay 3 chỗ: `be/src/main.ts:28`, `be/test/e2e/e2e-main.ts:33`, `be/test/full-app.ts:126` (full-app giữ không trustProxy). Không còn `new FastifyAdapter` nào ngoài helper (senior grep). **Cấm** thêm cơ chế thứ hai (`rewriteUrl` đoán lỗi decode — điều kiện find-my-way phức tạp, lệch là lọt).
- **Handler** (không ném, không I/O): `status = error.statusCode` nếu là số nguyên 400–499, ngược lại 500. Header cố định = đúng bộ header helmet đặt cho response JSON thường (CSP, HSTS, nosniff, XFO, Referrer-Policy, COOP, CORP, Origin-Agent-Cluster, X-DNS-Prefetch-Control, X-Download-Options, X-Permitted-Cross-Domain-Policies, X-XSS-Protection) với **giá trị giống hệt**, + `Cache-Control: no-store`. Body 4xx `{"error":"invalid_request"}`; 500 `{"error":"server_error"}` + 1 dòng log Nest `error` chỉ có `error.code`. Không đọc/echo `request.url`. Sau `send`: `httpDuration.observe({ method: <cùng quy tắc METHODS/OTHER của metrics.http>, route: '__unmatched', status_class }, reply.elapsedTime / 1000)` — dùng lại `httpDuration`, không thêm metric/label.
- **Test bắt buộc** (`be/test/b74-tester.int-spec.ts`, full-app thật; sửa bảng case cũ + thêm):
  - `/assets/%E0%A4%A`, `/nope/%zz%` ⇒ 400; `GET /admin/users/` + 101×`a` ⇒ 414. Mỗi case: `cache-control: no-store`; MỌI header helmet trong danh sách trên có giá trị == response tham chiếu `GET /nope-<RUN>` (404 qua helmet) — so sánh tự động, không hard-code giá trị trong test; body đúng chuỗi trên, KHÔNG chứa `%zz`, `%E0`, `aaaa`, `assets`, `nope`; `errorLines()` không đổi; metric `('__unmatched','4xx')` +1 đúng một lần; `('/assets/*','4xx')` không đổi; mọi `5xx` không đổi. Bỏ nhánh `framework: true` + `console.warn` ghi nhận debt.
  - (hồi quy) `/assets/styles.css` 200 vẫn có header helmet; `/assets//styles.css` 403 giữ hành vi run 58.
  - unit nhỏ cho handler với lỗi `statusCode` 500 giả ⇒ 500 `server_error`, đủ header (nhánh không với tới qua HTTP).
- **Runbook §9**: 1 dòng "URL hỏng / param > 100 ký tự ⇒ 400/414 JSON cố định, có header bảo mật, metric `route="__unmatched"`" (DEBT-239).
- **Mutation**: bỏ `frameworkErrors` khỏi helper ⇒ RED; bỏ observe ⇒ RED; đổi 1 giá trị header (vd. XFO) ⇒ RED parity; echo `error.message` vào body ⇒ RED.
- **Verify**: `pnpm -C be test`, `pnpm -C be test:int`, lint/typecheck.

### [x] T3 [BE] DEBT-197 — JWKS Google lỗi ⇒ 502 `provider_unavailable`

- Bằng chứng nguồn: `be` dùng `jose@5.10.0`; `dist/node/esm/runtime/fetch_jwks.js:30,40` (non-200 / JSON hỏng ⇒ `JOSEError` trần, code `ERR_JOSE_GENERIC`; là 2 nơi duy nhất tạo `JOSEError` trần trong bản node); `jwks/local.js:37,107` (JWKS sai hình dạng / khoá không public ⇒ `ERR_JWKS_INVALID`).
- **Sửa** `be/src/modules/federation/federation.client.ts:116`: `provider_unavailable` khi `!(err instanceof errors.JOSEError)` HOẶC `err.code` ∈ {`ERR_JWKS_TIMEOUT`, `ERR_JOSE_GENERIC`, `ERR_JWKS_INVALID`}; comment trỏ 2 file jose trên. Mọi code JOSE khác (chữ ký, claim, alg, `ERR_JWKS_NO_MATCHING_KEY`) vẫn `invalid_identity`. Nửa "lỗi non-JOSE ⇒ 502" của DEBT-197: giữ nguyên (lỗi mạng `https.get` là `Error` thường, không tách tin cậy được; fail-closed) — chấp nhận.
- **Test bắt buộc**:
  - unit `federation.client.spec.ts`, `createRemoteJWKSet` THẬT trỏ server `http` 127.0.0.1 port 0 (đóng trong `afterAll`): JWKS 503 ⇒ `provider_unavailable`; 200 body `not json` ⇒ `provider_unavailable`; 200 `{"keys":"x"}` ⇒ `provider_unavailable`; (dương) 200 JWKS đúng + token hợp lệ ⇒ identity; (âm, chống nâng nhầm) JWKS đúng + token ký khoá khác cùng `kid` ⇒ `invalid_identity`; `kid` không có trong JWKS ⇒ `invalid_identity`.
  - int `federation.int-spec.ts`, cạnh case "F16: remote JWKS refusing connections" (~dòng 1998, cùng mẫu thay `registry.google.jwks`, khôi phục trong `finally`): JWKS 503 và JWKS JSON hỏng ⇒ callback 502, `expectNoSession`, 0 user, 0 `FederatedIdentity`.
- **Mutation**: bỏ từng code khỏi tập ⇒ case tương ứng RED; thêm `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` vào tập ⇒ case âm RED.
- **Verify**: `pnpm -C be test`, `pnpm -C be test:int`.

### Không làm / ngoài phạm vi

- Không đổi CSP/headers fe-admin (run 51), body limit (run 52), `clientErrorStatus` (run 58). Không nâng jose (DEBT-431). Không cần E2E mới (không đổi luồng UI); tester chạy E2E 36 làm hồi quy theo lệ.
