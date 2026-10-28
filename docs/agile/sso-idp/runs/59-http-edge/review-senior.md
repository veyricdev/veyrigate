# Senior Review — 2026-10-28 (run 59, làm cứng biên HTTP)

## Kết luận: PASS

Không có 🔴. 2 🟡 + 1 🟡 ponytail ghi vào `backlog.md` (DEBT-442, DEBT-443, DEBT-444). Chuyển **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)

Diff nhỏ, đúng fold tech-lead, không có abstraction thừa ngoài 1 helper dựng adapter. Điểm tốt:

- T1: guard đặt đúng chỗ (sau `/healthz` và `/assets/`, trước `rejectBody`/router, bên trong `withSecurityHeaders`), trả 404 thuần, không tự dựng redirect. Test có cả case âm (router không được gọi) và case dương (không chặn nhầm `/a//b`, `/%2F%2F…`). Smoke 9b được chứng minh bắt lỗi trên image cũ (308).
- T2: handler không I/O, không ném, body cố định, log 500 chỉ `code`; test int so parity header với một 404 thật đi qua helmet thay vì hard-code giá trị — mutation đổi XFO bị bắt.
- T3: test dùng `createRemoteJWKSet` THẬT trên server 127.0.0.1, phủ cả chiều "không được nâng nhầm" (khoá khác cùng `kid`, `kid` lạ ⇒ 400). Mutation thêm `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` ⇒ RED.

Đã chạy lại (foreground): `pnpm -C be test -- framework-errors.spec.ts` 6/6, `federation.client.spec.ts` 30/30 (chung lượt), `pnpm -C fe-admin exec vitest run test/server-entry.test.ts` 34/34, `pnpm -C be run typecheck` 0, `pnpm -C be run lint` 0, `pnpm -C fe-admin run typecheck` 0. Không chạy int/E2E/Docker (đã có ở log backend-dev/frontend-dev).

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

**I1 — fe-admin không có `Location` dựng từ `Host` (T1).**
- Đọc nguồn router thật: `@tanstack/router-core@1.171.34` `ssr/ssr-server.js` `getNormalizedURL` thay `\` ĐẦU TIÊN bằng `%5C` rồi `new URL`, kích hoạt 308 khi `pathname.startsWith("//")`; `start-server-core` `createStartHandler.js` `Response.redirect(url, 308)`.
- Fuzz 400 000 path ngẫu nhiên (`/`, `\`, `.`, `..`, `%2e`, `%2F`, `%5C`, tab) so guard (`new URL(url).pathname`) với logic router trên **chuỗi thô**: 701 chuỗi lệch, ví dụ `//..\x/y` ⇒ guard thấy `/x/y` (cho qua), `getNormalizedURL` thật trả 308 `http://evil.example/..%5Cx/y`. **Không khai thác được hiện tại**: dựng srvx thật (`serve`, cùng phiên bản fe-admin) + socket thô `GET //..\x/y` / `GET http://evil.example//..\x` với `Host: evil.example` ⇒ `request.url` đã là href WHATWG đã chuẩn hoá (`http://evil.example/x/y`, không còn `\`), router đi nhánh thường (200), không 308. `new Request(...)` cũng chuẩn hoá giống vậy. ⇒ guard đúng nhờ một tính chất ngầm của host adapter → 🟡 DEBT-442.
- Biến thể đã thử qua srvx thật: `//a`, `/\/evil`, `/\\..//a`, `/%2e%2e//a`, `/a/..//b`, absolute-form `GET http://evil.example//a` ⇒ đều 404 guard; tab/CR trong request-target bị parser HTTP của Node từ chối trước app; `/%2F%2Fevil` ⇒ router, không 308 (decode giữ `%2F`).
- Thứ tự: `/healthz` khớp chính xác nên `//healthz` rơi vào guard; `//assets/x` không khớp `/assets/` ⇒ guard; `/assets//x` ⇒ 404 nhánh assets. Không đường nào tới router với pathname `//…`.
- Header A7 (CSP nonce, nosniff, no-store) có trên 404 nhờ nằm trong `withSecurityHeaders` (test `expectA7` + smoke 9b CSP).

**I2 — lỗi trước routing của BE (T2).**
- `fastify@5.12.5` `onBadUrl`/`onMaxParamLength`: có `frameworkErrors` ⇒ `Request/Reply` trên `routeEventContext` (không hook) ⇒ handler tự đặt header + observe; xác nhận handler không đọc `request.url`, body là hằng, log 500 chỉ `code` (mã nội bộ Fastify, không phải input).
- CSP: `buildCsp()` không tham số == header helmet toàn cục (đã có acceptance byte-identity run 33; parity test run 59 so lại với 404 thật). Trang HTML của BE không dùng nonce (`script-src 'self'`) nên không có khác biệt kiểu "trang HTML vs JSON".
- 3 nơi tạo adapter thật (`main.ts`, `e2e-main.ts`, `full-app.ts`) đều qua `createFastifyAdapter`; `main.ts` vẫn truyền `parsedTrustProxy` và giữ `assertTrustProxyConsistent`; `full-app` `trustProxy: undefined` = mặc định Fastify (như cũ). ~40 spec tự dựng app tối giản còn `new FastifyAdapter()` (không helmet, không kiểm biên) — đã có DEBT-441.
- Metric: nhãn cố định `route="__unmatched"`, method qua `METHODS`/`OTHER`, không bao giờ URL thô. `reply.elapsedTime` luôn 0 trong context này (Fastify chỉ gọi `setupResponseListeners` ở `route.js`) — đã ghi DEBT-440, đếm vẫn đúng.
- Không có access log cho các request này (middleware nestjs-pino chạy ở hook onRequest, không chạy trong `routeEventContext`); trước run 59 cũng vậy. Chỉ metric thấy được — chấp nhận (💭 bên dưới).

**I3 — JWKS Google (T3).**
- `jose@5.10.0` node: `JOSEError` trần chỉ có ở `runtime/fetch_jwks.js:30,40` (non-200, non-JSON); `JWKSInvalid` ở `jwks/local.js:37,107` (JWKS sai hình dạng / khoá không public) — đều thuộc tài liệu provider trả về, token không điều khiển được. `JWKSTimeout` ở `fetch_jwks.js:27`. Các lỗi do token (`ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWKS_NO_MATCHING_KEY`, claim, alg) vẫn 400.
- Fail-closed: cả 502 và 400 đều ném trước khi tạo session/user/link; int DEBT-197 kiểm `expectNoSession`, 0 user, 0 `FederatedIdentity`, khôi phục `registry.google.jwks` trong `finally`. Lỗi non-JOSE vẫn 502 (chấp nhận theo fold).
- Token lạ `kid` buộc jose tải lại JWKS (cooldown mặc định); nếu Google đang hỏng ⇒ 502 đúng trạng thái provider, không phải oracle mới.

**Exposure**: không echo path/`Host`/body provider vào response, log, label (đã kiểm cả 3 task).

## 🟡 Nên sửa

🟡 **Bảo mật (phòng thủ chiều sâu): guard `//` phụ thuộc ngầm vào việc `request.url` đã chuẩn hoá** — DEBT-442
`fe-admin/src/server.ts:29,43` — guard tính `pathname` bằng `new URL(request.url)`, còn router tính bằng `new URL(request.url.replace("\\", "%5C"))`. Hai cách parse chỉ trùng nhau khi `request.url` không chứa `\`.
Vì sao: với chuỗi thô `http://h//..\x/y` guard thấy `/x/y` còn router trả 308 `Location` theo `Host` (đã tái hiện bằng `getNormalizedURL` thật). Hôm nay srvx và `new Request` luôn đưa href đã chuẩn hoá nên không khai thác được, nhưng đổi host adapter / runtime (hoặc nâng router-core đổi cách chuẩn hoá) là mở lại DEBT-387 mà test hiện tại (dùng `new Request`) không phát hiện.
Đề xuất: (a) ghi invariant này vào comment guard (1 dòng: "`request.url` là href WHATWG đã chuẩn hoá — srvx/Request — nên guard và `getNormalizedURL` thấy cùng pathname"), và (b) thêm 1 test cấp router-core (không mock): với các chuỗi mà guard cho qua, `getNormalizedURL(new Request(u).url).handledProtocolRelativeURL === false` — bắt được nếu router-core đổi hành vi khi nâng phiên bản. Không cần đổi logic guard.

🟡 **Test: parity header của T2 dùng danh sách helmet cố định** — DEBT-443
`be/test/b74-tester.int-spec.ts` (`HELMET` 12 tên) — test chỉ so 12 header đã biết.
Vì sao: invariant I2 là "cùng bộ header như response thường". Nếu nâng `@fastify/helmet` thêm header mới (vd. COEP/Permissions-Policy bật mặc định), response thường có, `frameworkErrors` không có, test vẫn xanh.
Đề xuất: lấy danh sách từ chính response tham chiếu: mọi header của 404 `/nope-<RUN>` trừ tập nhỏ không thuộc helmet (`content-type`, `content-length`, `date`, `connection`, `keep-alive`, `cache-control`, `vary`), rồi so từng cái với response lỗi. Giữ assert "tham chiếu có đủ 12 header" làm sàn.

🟡 **Ponytail** — DEBT-444 (chi tiết ở mục Ponytail; ~-12 dòng).

## 💭 Nit

- 💭 `be/src/common/http/framework-errors.ts:58-66`: request bị `frameworkErrors` trả lời không có dòng access log (pino-http không chạy). Runbook §9 ghi "không log lỗi" — đúng; có thể thêm "và không có access log, chỉ metric `__unmatched`" để vận hành không đi tìm log. Không mở debt.
- 💭 `fe-admin/test/server-entry.test.ts`: tên case `http://evil.example/\evil.example` thực tế được `new Request` đổi thành `//evil.example` trước khi tới guard — test đúng, nhưng chỉ chứng minh cho chuỗi đã chuẩn hoá (liên quan DEBT-442).
- 💭 `be/src/modules/federation/federation.client.spec.ts`: case timeout lặp lại thân `verify` chỉ để đổi `timeoutDuration`; cho `verify` nhận timeout (gộp vào DEBT-444).

## ✂️ Ponytail

- be/src/common/http/framework-errors.ts:L36: shrink: 3 interface `EdgeError`/`EdgeRequest`/`EdgeReply` (14 dòng). Thay bằng `Pick<FastifyError,'statusCode'|'code'>`, `Pick<FastifyRequest,'method'>`, `Pick<FastifyReply,'code'|'headers'|'send'|'elapsedTime'>` (fake reply trong spec ép kiểu 1 lần).
- be/src/common/http/framework-errors.ts:L55: shrink: `reply.headers({ ...HEADERS })` — Fastify đã chép từng key, bản sao thừa. `reply.headers(HEADERS)` (bỏ `Readonly` ở kiểu hằng nếu cần).
- be/src/modules/federation/federation.client.spec.ts:L208: shrink: case timeout dựng lại `createRemoteJWKSet` + `code(verifyGoogleIdToken(...))`. `verify(token, 200)` với tham số timeout mặc định 1000.

net: -12 lines possible.

---

# Senior Review — Vòng 2 (2026-10-28, T1 retry 1: DEBT-387/442, bypass h3 decode)

## Kết luận: PASS

Không có 🔴. 1 🟡 (DEBT-446, phòng thủ lớp cuối) + 1 💭 (DEBT-447, mở rộng corpus/pin phiên bản). Chuyển **tester**.

## Tổng quan

Fix đúng chỗ và tối thiểu: guard tính thêm đúng pathname router sẽ thấy (bản sao URL, không chạm request), vẫn 404 thuần trong `withSecurityHeaders`, trước `rejectBody`/router. Không tự dựng redirect, không đổi hành vi path hợp lệ (`/a//b`, `/%2F%2F…`, `/a%5C` vẫn tới router). Test entry có case dương/âm, smoke 9c, và quan trọng nhất là test của tester chạy h3 + router-core + srvx THẬT bằng request-target thô vẫn xanh không sửa.

Đã chạy lại (foreground): `vitest run test/server-entry.test.ts test/protocol-relative-risk.test.ts` 53/53; toàn bộ fe-admin 65 file / 1453/1453; `typecheck` 0; `lint` 0 lỗi, 1 warning (DEBT-433). Không chạy E2E/Docker, không sửa code, không kill process.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

**I1 — không request nào guard cho qua mà router trả 308 `Location` theo `Host`.** Đối chiếu từng bước trên source thật (`node_modules/.pnpm`) và bundle `fe-admin/dist/server/server.js`:

1. **`decodePathname` h3@2.0.1-rc.20** (`dist/h3-Bz4OPZv_.mjs:25-27`, bundle `server.js:30-32`): `decodeURI(p.includes("%25") ? p.replace(/%25/g, "%2525") : p)`. `routerPathname` dùng `replaceAll("%25", "%2525")` vô điều kiện — tương đương (không có `%25` thì replace là identity). Thứ tự `%25` trước `decodeURI` giống hệt ⇒ `%255C` không bị giải 2 lần.
2. **Điều kiện kích hoạt**: h3 `if (url.pathname.includes("%"))` trên `req._url` (srvx `FastURL`, `instanceof URL` đúng nhờ `Symbol.hasInstance`); guard kiểm `includes("%")` trên pathname WHATWG. srvx `FastURL` giữ pathname thô chỉ khi KHÔNG khớp `_needsNormRE` (backslash, `^ # " < > { }`, backtick, non-ASCII, dot-segment kể cả `%2e` không phân biệt hoa thường); các ký tự còn lại mà WHATWG sẽ percent-encode (space, C0) bị llhttp của Node từ chối trước app. ⇒ pathname thô == pathname WHATWG với mọi target tới được app; nếu có lệch thì chỉ theo hướng guard thấy thêm `%` (chặn dư, không vượt).
3. **URL setter**: h3 gán `url.pathname = …` trên FastURL ⇒ setter của `lazyInherit` ⇒ `this._url` = `new NativeURL(this.href)` rồi setter native. `routerPathname` = `new URL(request.url)` với `request.url` = `this._url.href` (srvx `NodeRequest.url`) ⇒ cùng href, cùng setter native ⇒ cùng kết quả (backslash ⇒ `/`, tab/CR/LF bị bỏ, dot-segment resolve, ký tự cấm re-encode).
4. **`%2F` giữ nguyên**: `decodeURI` không giải ký tự reserved (`/ ? #`), `decodePath` của router giải theo segment cũng giữ `%2F` ⇒ `/%2F%2Fevil.example` tới router, không 308, không tạo `//` muộn hơn.
5. **URIError ⇒ 400 trước router**: bundle `server.js:423-433` `requestHandler`: `new H3Event(request)` trong try, `URIError` ⇒ `new Response(null, { status: 400 })`, `startRequestResolver` (nơi có `getNormalizedURL` + `Response.redirect(url, 308)`, `server.js:6800-6803`) không chạy. Nhánh catch cho qua của guard là đúng. Setter URL không ném.
6. **Lớp giữa guard và router**: `withSecurityHeaders` → `rejectBody` (chỉ đọc header) → `withUnavailableStatus` → `requestHandler` (h3) → `startRequestResolver` → `getNormalizedURL(request.url)`. Không có lớp nào khác viết lại URL. `getNormalizedURL` thay backslash đầu tiên bằng `%5C`: sau setter native, href không còn backslash trong pathname (nếu còn thì ở query, không đổi pathname). `serve.mjs` middleware `assets` chỉ đọc `request.url`. Trust proxy tắt ⇒ host từ `Host` qua `HOST_RE`, không ảnh hưởng pathname.

**Fuzz vi sai độc lập (của reviewer, scratchpad, không vào repo)**: srvx 0.11.22 `serve` thật + socket thô, handler = bản sao nguyên văn guard, rồi `H3Event` thật + `getNormalizedURL` thật; 17 token (`/`, backslash, `.`, `%2e`, `%2E`, `%5C`, `%5c`, `%25`, `%2525`, `%09`, `%0D`, `%2F`, `%E0`, `a`, `?`, `%3F`, `%23`), độ sâu 4 origin-form + absolute-form ⇒ **148 620 target: 0 bypass** (guard cho qua mà router 308); 27 176 là h3 400; 288 "chặn dư" đều là target thô bắt đầu `//` (vd. `//..%5C` — h3 giải thành `/`), tức chặn input thù địch, không chặn traffic hợp lệ. Bổ sung cho corpus 12 222 của tester (thiếu `%25`, `%2E` hoa, `%0D`, `%E0`, `%3F`).

**Exposure**: 404 body hằng, không echo path/Host; A7 header có (test `expectA7`, smoke 9b CSP). Smoke 9c kiểm 404 + không `Location` cho `/%5C`, `/%5C%5Cevil.example` — đủ cho mục tiêu hồi quy image.

**Không chặn nhầm**: `/`, `/a//b`, `/%2F%2Fevil.example`, `/a%5C` tới router, `/%E0%A4%A` qua guard (h3 400); corpus tester: router 8 014 target.

## 🟡 Nên sửa

🟡 **Phòng thủ lớp cuối: guard sao chép nội bộ h3 theo phiên bản** — DEBT-446
`fe-admin/src/server.ts:24-34` — `routerPathname` đúng với h3@2.0.1-rc.20 + srvx 0.11.22 + router-core 1.171.34 (đã chứng minh ở trên), nhưng là bản sao logic nội bộ của 3 thư viện. Đây là lần thứ 2 trong run guard lệch khỏi pipeline thật (vòng 1: backslash của router; vòng 2: decode của h3).
Vì sao: một bản nâng h3 (đang RC)/srvx đổi cách decode/chuẩn hoá ⇒ có thể mở lại 308 `Location` theo `Host`. `protocol-relative-risk.test.ts` chỉ pin phiên bản router-core; h3/srvx được chạy thật nên corpus chỉ bắt được nếu token liên quan có trong corpus.
Đề xuất (cân nhắc, không bắt buộc trong run này): thêm kiểm tra ở response, độc lập với cách parse path — trong `withSecurityHeaders` (đã dựng lại `Response`, nên headers bất biến của `Response.redirect` không phải vấn đề): nếu có `Location` tuyệt đối mà origin ∉ {origin `APP_URL`, origin `OIDC_ISSUER`} ⇒ thay bằng 404 text/plain + log 1 dòng không chứa URL. Lớp này chặn cả lớp lỗi "URL tuyệt đối dựng từ `Host`" (308 router và mọi chỗ dùng `url.origin`), giữ guard hiện tại làm lớp chính. Cần test: redirect tới issuer (login) và `Location` tương đối không bị đụng. Phương án thay thế: từ chối `Host` ≠ host `APP_URL` (trừ `/healthz` cho healthcheck Docker) — mạnh hơn nhưng rủi ro chặn nhầm sau reverse proxy, nên ưu tiên kiểm `Location`.

## 💭 Nit

- 💭 DEBT-447: `fe-admin/test/protocol-relative-risk.test.ts` — thêm token `%25`, `%2E`, `%0D`, `%E0`, `%3F` vào `TOKENS` (fuzz reviewer với các token này 0 bypass, nhưng nên nằm trong repo) và pin phiên bản h3 (`h3-v2`) + srvx giống tripwire router-core, để bản nâng buộc chạy lại có chủ đích. Test thứ 3 ("in-process … `new Request`") không mô phỏng h3 nên chỉ còn giá trị cho nhánh không có `%` — có thể ghi rõ trong tên test.
- 💭 `fe-admin/src/server.ts:59`: vế `pathname.startsWith("//")` thừa về bảo mật (router chỉ thấy `routerPathname`), nhưng giữ để chặn sớm input thù địch `//…` — chấp nhận, không mở debt.

## ✂️ Ponytail

- fe-admin/src/server.ts:L26: shrink: `if (url.pathname.includes("%"))` thừa — không có `%` thì `decodeURI` là identity và setter với pathname đã chuẩn hoá là idempotent. Bỏ `if`, giữ try/catch (gộp vào DEBT-447 khi chạm file).

net: -2 lines possible.
