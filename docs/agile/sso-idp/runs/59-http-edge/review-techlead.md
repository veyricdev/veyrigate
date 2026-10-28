# Tech Lead Review — 2026-10-28 (run 59, làm cứng biên HTTP)

## Kết luận: PASS (có điều kiện: làm theo mục "Fold tech-lead" cuối `tasks.md`, ưu tiên hơn text gốc)

3 task triển khai (T1 [FE] DEBT-387, T2 [BE] DEBT-239, T3 [BE] DEBT-197). Đóng 2 debt kèm bằng chứng, không làm code: DEBT-135, DEBT-236. Debt mới: DEBT-431.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc (monolith NestJS/Fastify + BFF TanStack Start). Mọi sửa nằm ở biên HTTP, không thêm dependency, không thêm abstraction ngoài 1 helper dựng `FastifyAdapter` dùng chung cho 3 entry (main, e2e-main, full-app).

## Xác minh từng debt trên HEAD `ad9c775`

| Debt | Còn đúng? | Bằng chứng (đọc source thật) | Quyết định |
|---|---|---|---|
| DEBT-387 | Có | `@tanstack/router-core@1.171.34` `dist/esm/ssr/ssr-server.js:365-376` `getNormalizedURL`: `handledProtocolRelativeURL = rawUrl.pathname.startsWith("//")`, `url = new URL(normalizedHref, rawUrl.origin)`; `@tanstack/start-server-core@1.169.39` `createStartHandler.js:284` `Response.redirect(url, 308)` ⇒ `Location` tuyệt đối theo origin của `request.url` (Host). `fe-admin/src/server.ts` không chặn trước `handler.fetch`. Probe: `/%2F%2Fevil.com`, `/%5C%5Cevil.com` KHÔNG kích hoạt (decodeURI giữ `%2F`/`%5C`); `/\evil` bị WHATWG URL đổi thành `//evil` ⇒ có kích hoạt. Redirect do app tạo (`resolveRedirect`, router.js:556) là path tương đối, không dính Host. | **T1 [FE]**: 404 trước router cho pathname bắt đầu `//` |
| DEBT-239 | Có | `fastify@5.12.5` `fastify.js:645-668` `onBadUrl`: không có `frameworkErrors` ⇒ `res.writeHead(400)` thô, body echo path (`'${path}' is not a valid url component`), không hook. Có `frameworkErrors` ⇒ `Request/Reply` với `routeEventContext` (`fastify.js:434`, `new Context({server, config:{}})` ⇒ không onRequest/onSend/onResponse) ⇒ helmet + metric KHÔNG tự chạy, handler phải tự đặt header + tự observe metric. Cùng cơ chế cho `onMaxParamLength` (`fastify.js:670`, 414 + echo path, find-my-way `maxParamLength` mặc định 100 ⇒ `GET /admin/users/<101 ký tự>` cũng thô) và `FST_ERR_ASYNC_CONSTRAINT` (không dùng). `be/src/main.ts:28`, `test/e2e/e2e-main.ts:33`, `test/full-app.ts:126` đều `new FastifyAdapter(...)` không `frameworkErrors`. Nest `FastifyAdapter` (platform-fastify 12) spread options vào `fastify()` ⇒ `frameworkErrors` top-level đi qua. | **T2 [BE]**: `frameworkErrors` dùng chung |
| DEBT-197 | Có (nửa đầu) | `be` dùng `jose@5.10.0` (node build). `dist/node/esm/runtime/fetch_jwks.js:30,40`: non-200 / JSON hỏng ⇒ `new JOSEError(...)` code `ERR_JOSE_GENERIC`; grep toàn bộ `dist/node/esm`: đây là 2 nơi DUY NHẤT tạo `JOSEError` trần. `jwks/local.js:37,107`: tài liệu JWKS sai hình dạng / chứa khoá không public ⇒ `JWKSInvalid` (`ERR_JWKS_INVALID`) — cũng do provider. `federation.client.ts:116` chỉ coi non-JOSE và `ERR_JWKS_TIMEOUT` là provider ⇒ 3 trường hợp này thành `invalid_identity` 400 thay vì 502. Nửa sau ("lỗi lập trình non-JOSE thành 502"): lỗi mạng của `https.get` (ECONNREFUSED…) là `Error` thường, không tách được với lỗi lập trình một cách tin cậy ⇒ giữ (fail-closed, không đăng nhập được) — chấp nhận. | **T3 [BE]** |
| DEBT-135 | Đúng chữ, không đáng sửa | Echo chỉ tới từ `toAdminError` (`admin.mappers.ts:221-233`) ⇒ chỉ route admin (Bearer admin + scope + step-up cho ghi), giá trị echo là input của CHÍNH admin đó, ≤ `MAX_LEN` theo DTO (`admin.dto.ts:52,85,93`), response JSON + `no-store` + `nosniff`. Đường OAuth không phản chiếu: `authorize.service.ts:554` đổi `InvalidResourceError` thành mô tả cố định. BFF đã cắt `error_description` còn 200 ký tự (`fe-admin/src/server/admin-api/client.ts:117,171`) và React escape. Không có log nào ghi `err.message` này. Cắt ở BE chỉ làm mất thông tin chẩn đoán (URI nào sai). | **ĐÓNG, chấp nhận** |
| DEBT-236 | Đúng (dev/test), ngoài threat model | Root phục vụ là `join(__dirname,'public')` (`bootstrap.ts:45-49`) = `dist/public` khi chạy thật; `dist/public` do Nest CLI `assets` (`nest-cli.json`) chép bằng `copyFileSync` (`@nestjs/cli@12.0.8` `assets-manager.js:273`) ⇒ file thường, không còn symlink. Image: `/app` thuộc root, chạy `USER 1000:1000` (`be/Dockerfile`) ⇒ runtime không tạo được link. Test run 38 chạy trên `src/public` qua `full-app.ts` (`__dirname = be/src`). `@fastify/static@10.1.5` không có option symlink (grep `symlink|realpath|lstat` rỗng) ⇒ muốn chặn phải tự wrap `send` = over-engineering. Kẻ có quyền ghi `src/public` đã có quyền ghi mã nguồn. | **ĐÓNG, chấp nhận** |

## Điểm mạnh

- tasks.md chọn đúng nhóm biên HTTP, đã nêu "không phá run 51–58".
- Có sẵn khung test tái dùng: `fe-admin/test/server-entry.test.ts` (mock router, `expectA7`), `be/test/b74-tester.int-spec.ts` (bảng case 4xx + metric + errorLines), `be/test/federation.int-spec.ts:1998` (mẫu JWKS remote thật trên 127.0.0.1).

## Vấn đề (bắt buộc làm theo fold — không phải lý do REJECT)

- [x] Text gốc T3 "lỗi JWKS ⇒ 503": SAI mã. Hợp đồng hiện hành `provider_unavailable` = **502** (`federation.controller.ts:55`). Giữ 502.
- [x] Text gốc T4 (DEBT-135), T2 (DEBT-236): bỏ, đóng có bằng chứng (bảng trên).
- [x] T2 (DEBT-239) phải phủ cả 414 `FST_ERR_MAX_PARAM_LENGTH` (cùng lỗ, cùng handler), không chỉ 400.
- [x] `frameworkErrors` chạy NGOÀI hook ⇒ phải tự đặt header + tự ghi metric; cấm thêm cơ chế thứ hai (vd. `rewriteUrl` đoán trước lỗi decode: điều kiện của find-my-way phức tạp, lệch là lọt).
- [x] T1 KHÔNG được thay bằng redirect tương đối tự dựng (`Location: /a`): dễ sinh `//evil` / `/\evil` (open redirect). Trả 404.

## Đề xuất (không bắt buộc)

- DEBT-431 (💭): `jose@5.10.0` node `fetch_jwks` chỉ race `response` với socket `timeout` (idle) ⇒ body JWKS nhỏ giọt có thể giữ request lâu hơn `PROVIDER_TIMEOUT_MS`. Google là provider tin cậy, rủi ro thấp; xử lý khi nâng jose 6 (dùng `AbortSignal.timeout` cho cả fetch).
