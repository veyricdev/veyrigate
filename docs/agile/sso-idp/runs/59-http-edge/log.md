# Log — run 59

- orchestrator: mở run làm cứng biên HTTP DEBT-387/236/239/135/197.

## [2026-10-28 10:00] tech-lead
- Đã làm: xác minh 5 debt trên `ad9c775` bằng source thư viện thật (router-core/start-server-core, fastify 5.12.5 onBadUrl/onMaxParamLength/frameworkErrors, jose 5.10.0 fetch_jwks/local, @fastify/static 10.1.5, @nestjs/cli assets copy); đóng DEBT-135/236 có bằng chứng; fold 3 task + cổng security vào `tasks.md`.
- File đổi: `runs/59-http-edge/review-techlead.md`, `runs/59-http-edge/tasks.md`, `runs/59-http-edge/log.md`, `STATUS.md`, `backlog.md` (đóng 135/236, mở DEBT-431).
- Kết quả: PASS — T1 [FE] 387 (404 cho `//`), T2 [BE] 239 (frameworkErrors cả 400 + 414, header parity helmet, metric `__unmatched`), T3 [BE] 197 (giữ 502, thêm `ERR_JOSE_GENERIC`/`ERR_JWKS_INVALID`).
- Bàn giao: frontend-dev (T1) song song backend-dev (T2, T3).

## [2026-10-28 12:10] frontend-dev (T1)
- Đã làm: T1 DEBT-387 — `fe-admin/src/server.ts` path bắt đầu `//` (WHATWG đổi `/\x` thành `//x`) ⇒ 404 text/plain trước `rejectBody`/router, trong `withSecurityHeaders`; describe mới 18 test (5 URL âm × GET/HEAD/POST: 404, `location` null, A7, router không gọi; dương `/a//b`, `/%2F%2Fevil.example`, `/` ⇒ router 1 lần); smoke check 9b; runbook §7.
- Mutation: bỏ guard ⇒ 15 RED; `=== "//"` ⇒ 12 RED; khôi phục sha256 `3f4ae034…42c8` khớp, 34/34 xanh.
- Verify: fe-admin typecheck 0, lint 0, test 64 file/1434 pass, build 0, check:bundle 0 hit; root `pnpm lint` exit 0 (lần đầu RED do `be/test/b74-tester.int-spec.ts` đang sửa bởi backend-dev, lần sau xanh). Docker `veyrigate-fe-admin:smoke-run59`: smoke 15/15; cùng script với image cũ `smoke-run52` ⇒ FAIL 9b `//a answered 308` (chứng minh check bắt được). Đã xoá image run59, không còn container `vg-fea-smoke-*`; grep secret log = 0. Không chạy E2E (backend-dev chạy cuối).
- File đổi: `fe-admin/src/server.ts`, `fe-admin/test/server-entry.test.ts`, `fe-admin/scripts/docker-smoke.sh`, `runbook-deploy.md`, `backlog.md` (đóng DEBT-387), `tasks.md`, `STATUS.md`. Debt mới: không.
- Bàn giao: senior-reviewer (sau khi backend-dev xong T2/T3).

## [2026-10-28 13:30] backend-dev (T2, T3)
- Security: T2 actor = request chưa xác thực (path), handler không I/O/không ném, không echo URL vào body/log/label; T3 actor = phản hồi JWKS của provider, fail-closed (không session/user/link), 502 chỉ cho lỗi tầng JWKS, lỗi token vẫn 400.
- Đã làm: T2 `be/src/common/http/framework-errors.ts` (`frameworkErrors` 400/414 ⇒ `{"error":"invalid_request"}`, header helmet + `no-store`, 500 ⇒ `server_error` + log chỉ `code`; observe `httpDuration` `__unmatched`, `METHODS` export từ `metrics.http.ts`) + `createFastifyAdapter` thay ở `main.ts`/`e2e-main.ts`/`full-app.ts` (các spec tự dựng app tối giản giữ `new FastifyAdapter()` ⇒ DEBT-441); int `b74-tester` (parity tự động với 404 tham chiếu, 3 case + hồi quy styles.css), unit `framework-errors.spec.ts` 6; runbook §9. T3 `federation.client.ts` `PROVIDER_JOSE_CODES`; unit remote JWKS thật 7 case (+ timeout), int DEBT-197 503/JSON hỏng ⇒ 502.
- RED trước fix: int 239 3 fail (thiếu `no-store`); unit 197 3 fail, int 197 2 fail (400 thay vì 502).
- Mutation (backup sha256, khôi phục byte-identical `869aea60…` / `d7136ac0…`): T2 bỏ `frameworkErrors` 3 RED, bỏ observe 3 RED (lần đầu lỗi biên dịch, làm lại bằng no-op hợp lệ), XFO=DENY 3 RED, echo message 3 RED; T3 bỏ TIMEOUT 1 RED (thêm case timeout vì ban đầu sống sót), bỏ GENERIC 2 RED, bỏ INVALID 1 RED, thêm `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` 2 RED.
- Verify: be typecheck/lint 0, unit 39 suite/627 pass, build 0; `test:int` shard 1/2 841 + 2/2 550 = 1391 pass; smoke BE `veyrigate-be:smoke-run59` 11/11 (đã xoá 2 image, không container/network sót); root `pnpm lint` 0, `pnpm -r run typecheck` 0, root `pnpm test` exit 0 (be 627, fe-admin 1434, fe-sso-test 269); E2E full 36/36 (cổng trống, không `E2E_REUSE`); grep secret 5 log = 0.
- File đổi: `be/src/common/http/framework-errors{,.spec}.ts`, `be/src/common/metrics/metrics.http.ts`, `be/src/main.ts`, `be/test/e2e/e2e-main.ts`, `be/test/full-app.ts`, `be/test/b74-tester.int-spec.ts`, `be/src/modules/federation/federation.client{,.spec}.ts`, `be/test/federation.int-spec.ts`, `runbook-deploy.md`, `backlog.md` (đóng 197/239, mở DEBT-440/441), `tasks.md`, `STATUS.md`.
- Bàn giao: senior-reviewer (T1+T2+T3).

## [2026-10-28 14:30] senior-reviewer
- Preflight: codegraph 1.6.2, `status` OK, `sync` Done.
- Đã làm: review T1/T2/T3 theo cổng security (I1/I2/I3). Đọc nguồn router-core 1.171.34 `getNormalizedURL`, fastify 5.12.5 `onBadUrl`/`onMaxParamLength`/`setupResponseListeners`, jose 5.10.0 nơi ném `JOSEError`/`JWKSInvalid`. Fuzz 400k path: guard vs router lệch trên chuỗi thô có `\` (vd. `//..\x/y` ⇒ 308 theo Host với `getNormalizedURL` thật) nhưng qua srvx thật + socket thô thì `request.url` đã chuẩn hoá ⇒ không khai thác được (🟡 DEBT-442). Absolute-form, `/./`, `%2e%2e`, `\` ⇒ 404 guard.
- Chạy lại: be `framework-errors.spec` 6/6, `federation.client.spec` 30/30, fe-admin `server-entry.test` 34/34, be typecheck/lint 0, fe-admin typecheck 0. Không chạy int/E2E/Docker, không sửa code, không kill process.
- Kết quả: **PASS** (0 🔴). Debt mới: DEBT-442 (comment invariant + test router-core cho guard `//`), DEBT-443 (parity header lấy từ response tham chiếu, không danh sách cố định), DEBT-444 (ponytail ~-12 dòng).
- File đổi: `runs/59-http-edge/review-senior.md`, `runs/59-http-edge/log.md`, `backlog.md`, `STATUS.md`.
- Bàn giao: tester.

## [2026-10-28 13:45] tester
- Đã làm: Preflight codegraph OK. Viết `fe-admin/test/protocol-relative-risk.test.ts` (router-core + h3 + srvx thật, corpus raw target), `be/test/run59-http-edge-tester.int-spec.ts` (raw socket BE thật, header từ 404 tham chiếu), thêm describe "run 59 tester" vào `be/test/federation.int-spec.ts` (remote JWKS thật 12 case); probe build production thật qua `serve.mjs`. Mutation T1/T2/T3 có backup sha256, khôi phục byte-identical.
- Kết quả: **FAIL** — T1: `GET /%5C…`/`/%09/…` + `Host: evil.example` ⇒ 308 `Location: http://evil.example/…` trên build thật (h3@2.0.1-rc.20 `H3Event` ghi `request._url.pathname = decodeURI(...)` sau guard). T2 PASS 17/17, T3 PASS 12/12. be 627, int 1420 (858+562), fe-admin 1437/1439, fe-sso-test 269, E2E 36, lint/typecheck/build/check:bundle 0, audit exit 0, grep secret 0. Chi tiết: test-report case T1-B/T2/T3.
- File đổi: 3 file test trên, `runs/59-http-edge/test-report.md`, `log.md`, `backlog.md` (DEBT-387 mở lại, DEBT-442 gộp vào 387, đóng DEBT-443, mở DEBT-445 💭), `STATUS.md`.
- Bàn giao: frontend-dev — guard xét pathname sau phép `decodeURI` kiểu h3 (không sửa request), thêm smoke `/%5C`; `protocol-relative-risk.test.ts` phải xanh không sửa test; rồi senior + tester.

## [2026-10-28 15:30] frontend-dev (T1 retry 1)
- Đã làm: đọc h3@2.0.1-rc.20 `H3Event` (`decodePathname`, bundle `server.js:30,49,423-433`: URIError ⇒ 400 trước router), srvx 0.11.22 FastURL (setter qua NativeURL). `server.ts`: guard = pathname gốc `//` HOẶC `routerPathname()` (bản sao URL, áp đúng `decodeURI` + `%25`⇒`%2525`) bắt đầu `//`; không sửa request, không redirect; URIError ⇒ bỏ qua (h3 trả 400). `/a//b`, `/%2F%2F…` vẫn tới router. Test `server-entry` +4 URL âm (`/%5C`, `/%5C%5Cevil.example`, `/%09/…`, `/./%5C`) ×3 method, +2 dương (`/a%5C`, `/%E0%A4%A`) = 48; smoke 9c; runbook §7.
- Test tester `protocol-relative-risk.test.ts` (không sửa): 5/5, corpus 12222 target, guard 404 4208, router 8014, 0 redirect.
- Mutation: guard cũ (chỉ `startsWith("//")` gốc) ⇒ tester 2/5 RED (1732 target 308), entry 12 RED; bỏ decodeURI ⇒ 14 RED; khôi phục sha256 `0138d8d9…74b5` khớp.
- Verify: fe-admin typecheck 0, lint 0 (1 warning ở file tester ⇒ DEBT-433), test 1453/1453 (1/5 lượt có 1 fail không rõ tên ⇒ DEBT-433), build 0, check:bundle 0 hit; root `pnpm lint` 0; root `pnpm test` 0 (be 627, fe-admin 1453, fe-sso-test 269). Docker `smoke-run59` 16/16, image đã xoá, không còn container smoke. E2E full 1 lần (cổng trống, không `E2E_REUSE`): 35/36 — `lab.spec.ts:73` timeout 5 s, chạy lại riêng 1/1 pass ⇒ DEBT-432. Grep secret log 0.
- File đổi: `fe-admin/src/server.ts`, `fe-admin/test/server-entry.test.ts`, `fe-admin/scripts/docker-smoke.sh`, `runbook-deploy.md`, `backlog.md` (đóng DEBT-387/442, mở DEBT-432/433 💭), `STATUS.md`.
- Bàn giao: senior-reviewer rồi tester.

## [2026-10-28 16:30] senior-reviewer (vòng 2, T1 retry 1)
- Preflight: codegraph 1.6.2, `sync` Done.
- Đã làm: đối chiếu `routerPathname` với source thật h3@2.0.1-rc.20 `decodePathname`/`H3Event` (`dist/h3-Bz4OPZv_.mjs:25,56`; bundle `server.js:30,49`), srvx 0.11.22 `FastURL`/`NodeRequestURL`/setter `lazyInherit`, `requestHandler` URIError ⇒ 400 (`server.js:423-433`), router-core `getNormalizedURL`/`decodePath`, `createStartHandler` 308 (`server.js:6800-6803`), middleware `serve.mjs`. Tương đương: thứ tự `%25`, setter native trên cùng href, `%2F` giữ nguyên; không lớp nào khác viết lại URL. Fuzz vi sai độc lập (scratchpad, srvx + h3 + router-core thật, 17 token, 148 620 target): 0 bypass, 288 chặn dư đều là target thô `//…`.
- Chạy lại: fe-admin `server-entry` + `protocol-relative-risk` 53/53, toàn bộ 1453/1453, typecheck 0, lint 0 lỗi (1 warning DEBT-433). Không chạy E2E/Docker, không sửa code, không kill process.
- Kết quả: **PASS** (0 🔴). Debt mới: DEBT-446 🟡 (kiểm `Location` tuyệt đối ngoài origin APP_URL/OIDC_ISSUER ở response làm lớp cuối), DEBT-447 💭 (corpus thêm `%25`/`%2E`/`%0D`/`%E0`/`%3F`, pin h3/srvx, ponytail bỏ `if` thừa).
- File đổi: `runs/59-http-edge/review-senior.md`, `runs/59-http-edge/log.md`, `backlog.md`, `STATUS.md`.
- Bàn giao: tester (T1 lượt 2).

## [2026-10-28 18:30] tester (lượt 2, T1 retry 1)
- Preflight: codegraph 1.6.2, `sync` Done.
- Đã làm: probe build production thật (`pnpm -C fe-admin build` + `node serve.mjs` cổng 3471, raw socket, `Host: evil.example`) 18 857 target (corpus lượt 1 + token senior `%25`/`%2525`/`%2E`/`%5c`/`%0D`/`%E0`/`%3F`/`%23` + 39 biến thể × GET/HEAD/POST) ⇒ 0 redirect 308, 0 `Location` tuyệt đối; path hợp lệ (`/`, `/users`, `/a//b`, `/%2F%2F…`, `/a%5C`, asset, `/healthz`) không bị guard chặn. Mở rộng `fe-admin/test/protocol-relative-risk.test.ts` (DEBT-447): tripwire h3-v2 2.0.1-rc.20 + srvx 0.11.22, "decode corpus" 6518 target 0 redirect, bỏ directive thừa (DEBT-433). Mutation `server.ts` (sha256 `0138d8d9…74b5` khôi phục byte-identical): bỏ vế `routerPathname` ⇒ RED; bỏ `%25` ⇒ xanh (mutant tương đương, chỉ chặn dư). Docker `smoke-run59` 16/16, image đã xoá, không còn container smoke.
- Kết quả: **PASS** — be unit 627, int 1420 (full 1402 + `run56-tester` chạy lại 18/18; timeout `bootFullApp` 90 s do tải máy ⇒ DEBT-448), fe-admin 1455/1455, fe-sso-test 269, E2E 36/36, lint/typecheck/build/check:bundle 0, audit exit 0, grep secret 0. Chi tiết: test-report "Lượt 2" case L2-1…L2-4.
- File đổi: `fe-admin/test/protocol-relative-risk.test.ts`, `runs/59-http-edge/test-report.md`, `log.md`, `backlog.md` (đóng DEBT-433, DEBT-447 còn ponytail `if`, mở DEBT-448 💭), `STATUS.md`.
- Bàn giao: orchestrator đóng run 59.
