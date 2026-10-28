# Test Report — 2026-10-28 (run 59, lượt 2: T1 retry 1)

## Kết quả lượt 2: PASS — T1 (DEBT-387) đóng; T2, T3 không hồi quy

- **T1 PASS**: build production thật (`serve.mjs` + `dist/server/server.js`, cổng 3471), raw socket `Host: evil.example`, **18 857 target ⇒ 0 response 308 / 0 `Location` tuyệt đối** (case L2-1). Không chặn nhầm path hợp lệ (case L2-2). `protocol-relative-risk.test.ts` mở rộng (DEBT-447) 7/7, mutation diệt (case L2-3). Docker smoke 16/16.
- **T2/T3**: int full 1420/1420 tính cả chạy lại (case L2-4); be unit 627/627; E2E 36/36.
- Số liệu: be unit 627; int 1420 (lượt full 1402 + `run56-tester` chạy lại 18/18, xem L2-4); fe-admin 65 file / **1455/1455**; fe-sso-test 269; E2E **36/36**; Docker smoke **16/16**; lint/typecheck/build/check:bundle 0; audit exit 0; grep secret 0.

### Lệnh đã chạy + output thực tế (lượt 2)

Preflight: `codegraph --version` 1.6.2, `sync` Done. Lock `vg:int-lock` rỗng trước mỗi lượt int. Cổng :3000/:4000/:5173 trống trước E2E, `E2E_REUSE` không đặt, sau E2E được giải phóng. Không kill/restart process/container nào ngoài process con `node serve.mjs` của probe (script tự `SIGTERM` và chờ `exit`) và container/image smoke của chính tester.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `npx vitest run test/protocol-relative-risk.test.ts` (fe-admin) | **7 passed** (5 cũ + pin h3/srvx + decode corpus) |
| 2 | `pnpm -C fe-admin build` + `node probe-real-build-r2.mjs fe-admin 3471` (scratchpad) | build 0; probe xem L2-1/L2-2; `serve.mjs exited (own child) signal=SIGTERM`, cổng 3471 trống sau đó |
| 3 | `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:smoke-run59 .` + `bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:smoke-run59` | build 0; **`docker-smoke: 16/16 passed`** (gồm 9b `//a` và 9c `/%5C`, `/%5C%5Cevil.example` ⇒ 404 không `Location`); `docker rmi veyrigate-fe-admin:smoke-run59` ok; `docker ps -a` không còn `vg-fea-smoke-*` |
| 4 | `pnpm -C be run typecheck` / `lint` / `test` / `build` | 0 / 0 / 39 suite **627 passed** / 0 |
| 5 | `pnpm -C fe-admin run typecheck` / `lint` / `test` / `check:bundle` | 0 / 0 (1 warning DEBT-433 — sau đó bỏ directive, eslint file sạch) / **65 file, 1455 passed** / `23 client files … 0 hit(s)` |
| 6 | `pnpm -C be test:int --shard=1/2` | 27 suite: **853 passed, 5 failed**, 504 s — cả 5 là timeout (`runbook-drill` `beforeAll` 90 s ×4, `client-auth-rate-limit` 1 test 20 s); máy tải nặng (xem L2-4) |
| 7 | `pnpm -C be test:int <2 file>` (đối số vị trí không lọc ⇒ thực tế chạy **full**, không shard) | 53 suite: **1402 passed, 18 failed**, 977 s; `runbook-drill` PASS 30 s, `client-auth-rate-limit` PASS 7,6 s; 18 fail = toàn bộ `run56-tester` do `beforeAll` `bootFullApp` timeout 90 s |
| 8 | jest trực tiếp `--testPathPatterns run56-tester` (cùng cờ của `test:int`) | **18 passed**, 44 s |
| 9 | root `pnpm lint` / `pnpm -r run typecheck` / `pnpm test` | 0 / 0 / 0 (be 627, fe-admin 1455, fe-sso-test 269) |
| 10 | `pnpm audit --audit-level high` | exit 0 — 7 low, 9 moderate, 1 high ignored |
| 11 | `pnpm -C e2e e2e` (1 lần) | **36 passed (4.6m)** — `lab.spec.ts:73` không flaky lượt này |
| 12 | grep secret (PEM private, `*_SECRET=`, `DEV_SEED_PASSWORD=`, JWK `d`, JWT 3 phần) trên mọi log của tester lượt 2 | 0 hit |

### Case L2-1 — probe build production thật (I1)

`probe-real-build-r2.mjs` (scratchpad): spawn `node serve.mjs` với env giả như `docker-smoke.sh` (secret sinh ngẫu nhiên, Redis `127.0.0.1:1`), `HOST=127.0.0.1 PORT=3471`, chờ `/healthz` 200 theo điều kiện; socket thô `GET|HEAD|POST <target> HTTP/1.1`, `Host: evil.example`, `Connection: close`. Corpus: 39 biến thể (25 của senior + `/%5C`, `/%5Ca`, `/%5C%2F`, `/%09/`, `/./%5C`, `/.%5C%5C`, `/%25%5C%5Cevil.example`, `/%255C%255Cevil.example`, `/%2E/%5C%5Cevil.example`, `/%0D/evil.example`, `/%0D%5Cevil.example`, `/%E0/%5C`, `/%5C%3F`, `/%5C%23x`) × 3 method; corpus lượt 1 (10 token, độ sâu 4 origin-form + 3 absolute-form); corpus mới 18 token (thêm `%25 %2525 %2E %5c %0D %E0 %3F %23`, độ sâu 3 origin-form + 2 absolute-form).

```
targets=18857 statuses={"307":12150,"400":866,"404":5835,"411":6}
308-or-absolute-Location-or-error=0
distinct Location shapes: ["/auth/login?returnTo=…","/%25/evil.example","/%2F","/a", … chỉ đường dẫn tương đối, một "/" đầu]
serve.mjs exited (own child), code=null signal=SIGTERM
```

`411` ×6 = POST không `Content-Length` (`rejectBody`, DEBT-370); `400` = h3 URIError (`%E0`, …) trước router.

### Case L2-2 — không chặn nhầm (Host = `admin.example.invalid`)

```
"/" => 307 /auth/login?returnTo=%2F              "/users" => 307 /auth/login?returnTo=%2Fusers
"/auth/login" => 503 (IdP .invalid, như smoke 8)   "/a//b" => 307 /a/b
"/%2F%2Fevil.example" => 307 /auth/login?returnTo=%2F%252F%252Fevil.example
"/a%5C" => 307 /a      "/%E0%A4%A" => 400 (h3)     "/clients", "/audit" => 307 login
"/healthz" => 200      "/assets/alert-label-DWz7S-LX.js" => 200
"/users?q=%2F%2Fx" => 307 /auth/login?returnTo=%2Fusers%3Fq%3D%252F%252Fx
```

Không path hợp lệ nào nhận 404 "Not Found" của guard.

### Case L2-3 — mở rộng `fe-admin/test/protocol-relative-risk.test.ts` (DEBT-447 phần test)

- Tripwire phiên bản: `h3-v2` (của `start-server-core`) = `2.0.1-rc.20`, `srvx` (fe-admin, cùng bản `serve.mjs`) = `0.11.22`.
- Test "decode corpus": `TOKENS_DECODE` = 10 token cũ + `%25`, `%2525`, `%2E`, `%5c`, `%0D`, `%E0`, `%3F`, `%23`; độ sâu 3 origin-form + 2 absolute-form qua srvx + h3 + router-core thật: `[run59-tester] DEBT-447 corpus: 6518 targets, guard 404 1528, router 4126, h3 400 864` ⇒ 0 redirect; sàn guard > 500, router > 500, h3 400 > 0. Corpus cũ không đổi: `12222 targets, guard 404 4208, router 8014`.
- Đổi tên test in-process cho rõ (chỉ có nghĩa với path không có `%`, không mô phỏng h3 — nit senior). Bỏ directive `eslint-disable-line no-new` thừa (DEBT-433).
- Mutation (`fe-admin/src/server.ts`, backup sha256 `0138d8d9…74b5`, khôi phục và xác minh byte-identical): bỏ vế `routerPathname(...)` ⇒ "decode corpus" **RED**; bỏ `replaceAll("%25","%2525")` ⇒ 7/7 xanh — mutant tương đương về bảo mật (guard giải mã nhiều hơn h3 ⇒ chỉ có thể chặn dư, không vượt); ghi nhận, không phải lỗ hổng.

### Case L2-4 — int full + timeout môi trường

Shard 1/2 (504 s; lượt 1 là 243 s) và lượt full (977 s) có `beforeAll` `bootFullApp` vượt 90 s ở suite khác nhau mỗi lượt; mọi suite đó xanh khi chạy lại (`runbook-drill`, `client-auth-rate-limit` trong lượt full; `run56-tester` 18/18 riêng). Diff run 59 chạm `full-app.ts` chỉ đổi adapter (`createFastifyAdapter()`), 52/53 suite boot bình thường ⇒ đánh giá: tải máy, không phải hồi quy. Ghi **DEBT-448** 💭. Tổng: 1402 (full) + 18 (`run56-tester` chạy lại) = **1420/1420**, bằng lượt 1.

### Coverage lượt 2

- [x] T1 / I1 — Identity anonymous × Input encoded (`%5C`, `%5c`, `%09`, `%0D`, `%25`, `%2525`, `%2E`, `%E0`, `%3F`, `%23`, `\`, dot-segment) × method GET/HEAD/POST × Request chain origin-form + absolute-form × Exposure `Location`: L2-1, L2-3, smoke 9b/9c.
- [x] T1 không chặn nhầm: L2-2.
- [x] T2 / I2, T3 / I3 — không hồi quy: int full (L2-4), `run59-http-edge-tester` 17/17 và `federation.int-spec` trong lượt full.
- Debt: đóng DEBT-433; DEBT-447 còn ponytail `if` trong `server.ts`; mở DEBT-448 💭. DEBT-446 🟡 giữ nguyên (lớp phòng thủ cuối, ngoài phạm vi tester).

---

# Lượt 1

## Test Report — 2026-10-28 (run 59, làm cứng biên HTTP)

## Kết quả: FAIL — T1 (DEBT-387) bị bypass thật; T2, T3 PASS

- **T1 FAIL** (fe-admin 1437/1439, 2 test tester RED đúng lỗi): guard `//` chạy TRƯỚC h3; trên srvx thật, h3 sửa URL của request sau guard ⇒ `GET /%5C` (và `/%5Cevil.example`, `/%09/…`…) + `Host: evil.example` ⇒ **308 `Location: http://evil.example/…`**. Vi phạm I1 (runbook §7). Đã tái hiện trên **bản build production thật** (`serve.mjs` + `dist/server/server.js`).
- **T2 PASS**: raw socket tới BE thật đang listen, 17/17; DEBT-443 đã được phủ (danh sách header lấy từ 404 tham chiếu).
- **T3 PASS**: remote JWKS thật sau callback đầy đủ, 12/12; mutation diệt hết.
- Tổng số đã chạy: be unit 627/627; int full 1420/1420 (shard 1/2 858 + 2/2 562); fe-admin 1437/1439 (2 RED = case T1-B); fe-sso-test 269/269; E2E 36/36.

## Lệnh đã chạy + output thực tế

Preflight: `codegraph --version` 1.6.2, `status` OK, `sync` Done. Lock `vg:int-lock` trống trước mỗi lượt int (`GET` ⇒ rỗng). Cổng :4000/:5173/:3000 trống, `E2E_REUSE` không đặt, sau E2E các cổng được giải phóng. Không chạy Docker smoke (không bắt buộc). Không kill/restart process hay container nào; process con `node serve.mjs` của probe do chính script tạo và tự dừng.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be run typecheck` / `lint` / `test` / `build` | 0 / 0 (sau `prettier --write` 2 file test của tester) / 39 suite, **627 passed** / 0 |
| 2 | `pnpm -C be test:int --shard=1/2` | 27 suite, **858 passed**, 243 s |
| 3 | `pnpm -C be test:int --shard=2/2` | 26 suite, **562 passed**, 298 s (tổng 1420 = 1391 dev + 17 + 12 tester) |
| 4 | `pnpm -C fe-admin run typecheck` / `lint` / `build` / `check:bundle` | 0 / 0 / 0 / 0 hit (23 file client, 22 chunk) |
| 5 | `pnpm -C fe-admin test` | 64/65 file, **1437 passed, 2 failed** (`protocol-relative-risk.test.ts`, case T1-B) |
| 6 | root `pnpm lint` / `pnpm -r run typecheck` | 0 / 0 |
| 7 | root `pnpm test` | exit 1 — be 627 ✓, fe-admin 2 failed/1437 ✓ (T1-B), fe-sso-test 269 ✓ |
| 8 | `pnpm audit --audit-level high` | exit 0 — 7 low, 9 moderate, 1 high đã ignore (như các run trước) |
| 9 | `pnpm -C e2e e2e` (1 lần) | **36 passed** (6.7 m) |
| 10 | grep secret (PEM private, `*_SECRET=`, `DEV_SEED_PASSWORD=`, JWK `d`, JWT 3 phần) trên mọi log của tester | 0 hit |

### Case T1-A — test router-core thật, không mock (`fe-admin/test/protocol-relative-risk.test.ts`)

- `getNormalizedURL` thật của `@tanstack/router-core@1.171.34` (resolve theo chuỗi `react-start → start-server-core → router-core`, đúng bản bundle dùng; khoá phiên bản bằng 1 test), **h3 thật** `h3-v2` = `h3@2.0.1-rc.20` (`new H3Event(request)` như `requestHandler` của bundle), srvx node adapter thật (`srvx/node`, cùng bản `serve.mjs`), `server.ts` thật. Chỉ thay phần còn lại của Start bằng đúng 2 dòng của `createStartHandler.js:281-284`.
- Request target gửi nguyên byte qua `http.request` (`path` verbatim) với `Host: evil.example`: 25 biến thể × GET/HEAD/POST (danh sách của senior + `%5C`, `%09`, `%0A`, absolute-form) và corpus vét cạn 10 token (`/`, `\`, `.`, `..`, `%2e`, `%2F`, `%5C`, `%09`, `a`, `?`) độ sâu 4, origin-form + absolute-form.
- Test in-process đề xuất của senior (`new Request(u).url` ⇒ `handledProtocolRelativeURL === false` với mọi URL guard cho qua): **xanh** trên > 5000 URL — nhưng KHÔNG bắt được lỗi bên dưới vì `new Request` không có `_url` mà h3 sửa được.

### Case T1-B — bypass (FAIL)

Output vitest (trước khi thêm h3 vào stand-in: 5/5 xanh, corpus 8201 target, guard 1848 / router 6353; sau khi thêm h3 thật: 2 RED):

```
× senior's variants, Host: evil.example => never 308, never a Location
  - Expected [ "GET", "/%5C%5Cevil.example", 308, undefined ]
  + Received [ "GET", "/%5C%5Cevil.example", 308, "http://evil.example/evil.example" ]
× exhaustive corpus ... expected [ …(1732) ] to deeply equal []
  "/%5C 308 http://evil.example/",  "/%5Ca 308 http://evil.example/a",
  "/%5C%2F 308 http://evil.example/%2F",  "/%09/ 308 http://evil.example/",
  "/./%5C 308 http://evil.example/", "/.%5C%5C 308 http://evil.example/", ...
```

Xác nhận độc lập trên **build production thật** (không mock gì): `pnpm -C fe-admin build`, rồi `node serve.mjs` (env giả giống `docker-smoke.sh`, Redis `127.0.0.1:1`), raw socket `Host: evil.example` (script ở scratchpad `probe-real-build.mjs`):

```
GET  "/%5C%5Cevil.example" 308 http://evil.example/evil.example
HEAD "/%5C%5Cevil.example" 308 http://evil.example/evil.example
POST "/%5C%5Cevil.example" 308 http://evil.example/evil.example
control /users: 307 /auth/login?returnTo=%2Fusers
variants=63 statuses={"307":9,"308":3,"404":51}
```

Các biến thể `//…` của senior (kể cả `//..\x/y`, `/\/evil`, absolute-form) đều 404 ở guard — phần đó của fix đúng.

Nguyên nhân (đọc bundle `dist/server/server.js:47-49,423-427` và srvx): srvx đưa cho app một request có `_url` (FastURL) dùng chung; `requestHandler` của h3 tạo `new H3Event(request)` và với pathname có `%` thì **gán** `url.pathname = decodeURI(pathname)`. `decodeURI` giải `%5C` ⇒ `\` và `%09` ⇒ tab; setter pathname WHATWG đổi `\` thành `/` và bỏ tab ⇒ `request.url` chuyển từ `http://evil.example/%5C%5Cevil.example` thành `http://evil.example///evil.example` (đã in ra bằng `dbg.mjs`: `['after', 'http://evil.example///evil.example']`). Sau đó `createStartHandler` gọi `getNormalizedURL(request.url)` ⇒ `handledProtocolRelativeURL` ⇒ `Response.redirect(url, 308)` với origin = `Host`. Guard trong `server.ts` chạy trước bước này nên chỉ thấy `/%5C%5C…`. Gọi bundle in-process bằng `new Request(...)` ⇒ 307 bình thường (không `_url`), đó là lý do test dev (`new Request`) và smoke 9b (`//a`) đều xanh.

Mức ảnh hưởng: giống DEBT-387 gốc (Location tuyệt đối dựng từ `Host`; `normalizedHref` luôn bắt đầu `/` nên không ra host khác `Host`), có `no-store`. Nhưng đây là đúng invariant I1 mà T1 phải đóng ⇒ **FAIL, trả frontend-dev**.

Gợi ý sửa (frontend-dev quyết): guard phải xét pathname **sau** phép biến đổi của h3, vd. `const u = new URL(request.url); try { if (u.pathname.includes("%")) u.pathname = decodeURI(u.pathname) } catch { /* h3 sẽ trả 400 */ }; if (u.pathname.startsWith("//")) ⇒ 404` (không sửa `request`). Thêm smoke 9c `GET /%5C` + `Host: evil.example` ⇒ không 308. Test `protocol-relative-risk.test.ts` phải xanh (không sửa test).

Mutation T1 (backup sha256 `3f4ae034…42c8`, khôi phục byte-identical, xác minh bằng sha256): bỏ guard ⇒ 2 RED; `startsWith("//")` → `=== "//"` ⇒ 2 RED (chạy trước khi thêm h3 vào stand-in; khi đó test hiện tại xanh với code gốc).

### Case T2 — raw socket tới BE thật (`be/test/run59-http-edge-tester.int-spec.ts`, 17/17)

- App full (`bootFullApp` + `listen(0)`), socket thô, path nguyên byte. Header tham chiếu lấy từ `GET /nope-<RUN>` 404 trừ `content-type, content-length, date, connection, keep-alive, cache-control, vary, transfer-encoding`: **12 header** (`content-security-policy, cross-origin-opener-policy, cross-origin-resource-policy, origin-agent-cluster, referrer-policy, strict-transport-security, x-content-type-options, x-dns-prefetch-control, x-download-options, x-frame-options, x-permitted-cross-domain-policies, x-xss-protection`), sàn 12 tên của fold.
- 11 case: `/assets/%E0%A4%A`, `/nope-RUN/%zz%`, `/%`, `%0d%0aSet-Cookie:%20pwn=1%zz`, `%3Cscript%3E…%zz`, param 101 / 5000 ký tự, param 101 có payload mã hoá, POST có body, DELETE 414, OPTIONS ⇒ 400/414, body đúng `{"error":"invalid_request"}`, `no-store`, JSON, không `set-cookie`/`location`, header == tham chiếu, raw response + log sink + `/metrics` không chứa marker, 0 dòng level 50/60, `__unmatched` 4xx +1 đúng method label, 5xx không đổi.
- HEAD ⇒ 400 không body, label `HEAD`; `PROPFIND` ⇒ label `OTHER`, `/metrics` không có `method="PROPFIND"`.
- Chuỗi request: lỗi framework rồi request thường trên **cùng socket keep-alive** ⇒ 2 response (400 rồi 404), cả hai có header đủ.
- Đồng thời: 40 request song song (20×400, 20×414) ⇒ `__unmatched` 4xx đúng +40, 0 5xx, 0 ERROR.
- Hồi quy: param đúng 100 ký tự vẫn vào route (401 của admin guard), `%41` hợp lệ ⇒ 404 bình thường.
- Mutation (backup sha256, khôi phục byte-identical): helmet thêm `crossOriginEmbedderPolicy` (`bootstrap.ts` `0ffcc167…dcb3`) ⇒ spec tester **14 RED**, `b74-tester` (danh sách cố định) **vẫn PASS** — chứng minh DEBT-443 có thật và nay đã phủ; adapter bỏ `frameworkErrors` (`framework-errors.ts` `869aea60…d325`) ⇒ 15 RED.

### Case T3 — remote JWKS thật sau callback (`be/test/federation.int-spec.ts`, describe "run 59 tester", 12/12)

`createRemoteJWKSet` thật trên server 127.0.0.1, đi trọn `/auth/google/start` → provider giả → `/auth/google/callback`:

| JWKS | Kỳ vọng | Thực tế |
|---|---|---|
| 200 JWKS đúng (đối chứng) | 302 đăng nhập | 302 |
| 503 / 500 HTML / 200 không phải JSON / `{"keys":"x"}` / thiếu `keys` / mảng JSON / không trả lời (timeout 300 ms) | 502 | 502 ×7 |
| 200 JWKS chứa khoá **private** (`ERR_JWKS_INVALID`) | 502 | 502 |
| khoá khác cùng `kid` (chữ ký sai) / `kid` lạ | 400 | 400 ×2 |
| `{"keys":[]}` | ghi nhận | 400 (DEBT-445 💭) |

Mỗi case lỗi: không cookie session, không `idp_link`, không `location`, `no-store`, 0 user, 0 `FederatedIdentity`, marker body provider không có trong trang lỗi lẫn collection audit.
Mutation (`federation.client.ts` `d7136ac0…4d39`, khôi phục byte-identical): bỏ `ERR_JWKS_INVALID` ⇒ 4 RED; bỏ `ERR_JOSE_GENERIC` ⇒ 3 RED; bỏ `ERR_JWKS_TIMEOUT` ⇒ 1 RED; thêm `ERR_JWKS_NO_MATCHING_KEY` ⇒ 2 RED.

## Test FAIL

- `fe-admin/test/protocol-relative-risk.test.ts` › "senior's variants…" và "exhaustive corpus…" — kỳ vọng: không response nào 308 / có `Location`; thực tế: `/%5C…`, `/%09/…` (1732 target trong corpus) ⇒ 308 `Location: http://evil.example/…` — nguyên nhân: h3 `H3Event` giải mã và ghi lại `request._url.pathname` sau guard (xem case T1-B). Trả **frontend-dev**.

## Coverage acceptance criteria

- [ ] T1 — `//` không bao giờ redirect theo `Host`: **FAIL** (case T1-B); phần `//…` thô đúng (T1-A, probe build thật 51/63 = 404, còn lại 307 tương đối hoặc 308 do `%5C`).
- [x] T2 — 400/414 JSON cố định, header == 404 tham chiếu, `no-store`, không echo, không log ERROR, `__unmatched` +1 (case T2; b74 của dev cũng xanh trong int full).
- [x] T3 — JWKS 503/JSON hỏng/`{"keys":"x"}`/timeout ⇒ 502 không session/user/link; chữ ký sai/kid lạ ⇒ 400 (case T3).
- [x] Runbook §7/§9 đã có dòng mới (frontend-dev/backend-dev); §7 sẽ phải bổ sung khi sửa T1.

## Coverage security invariants / risk matrix

- [ ] I1 (Identity anonymous × Input encoded `%5C`/`%09`/`\`/dot-segment × Request chain absolute-form × Exposure `Location`) — **FAIL** (T1-B).
- [x] I2 Input malformed/oversized/injection-shaped (CRLF, `<script>` mã hoá) × method GET/HEAD/POST/DELETE/OPTIONS/unknown × Exposure response/log/metric label × State keep-alive kế tiếp × Concurrency 40 — case T2.
- [x] I3 Dependency unavailable/timeout/partial (sai hình dạng, khoá private, rỗng) × Credential malformed (chữ ký sai, kid lạ) × Exposure trang lỗi/audit — case T3; fail-closed (không session/user/link) ở mọi nhánh.
- Không áp dụng: authorization/tenant (không task nào đổi authn/authz), replay (code provider dùng một lần, đã có test run 32).
