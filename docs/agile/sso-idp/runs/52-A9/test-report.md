# Test Report — 2026-10-24 — run 52 (A9 Dockerfile + deploy fe-admin, DEBT-370/374/368/362/264)

## Kết quả: PASS — mọi cổng xanh; smoke image 13/13; E2E full 35/35; 46 test rủi ro mới xanh

| Cổng | Kết quả |
|---|---|
| `pnpm -C fe-admin typecheck` / `lint` / `build` / `check:bundle` / `gen:api` | exit 0 cả 5. `check:bundle scanned 23 client files for 8 server env names + 0 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)`; `gen:api` không diff `schema.d.ts` |
| root `pnpm lint` | exit 0 |
| `pnpm -r run typecheck` | exit 0 |
| root `pnpm test` (tuần tự) | exit 0. be `32 suites / 416 passed`; fe-admin `64 files / 1415 passed` (62/1369 của dev + 2 file / 46 test của tester); fe-sso-test `31 / 269` |
| `pnpm audit --audit-level high` | exit 0. `13 vulnerabilities found — Severity: 6 low \| 7 moderate`, `1 ignored: 1 high` (happy-dom, hạn 2026-11-04) |
| `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:smoke-run52 .` | exit 0 (12.6 s, cache BuildKit) |
| `bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:smoke-run52` | exit 0, **`docker-smoke: 13/13 passed`** (case D1) |
| Dọn Docker | `docker rm -f vg-fea-smoke-{ok,noenv,http}` ⇒ "No such container" (trap đã dọn); `docker image rm veyrigate-fe-admin:smoke-run52` ⇒ Untagged + Deleted `sha256:0d45ea9d…`; tag `:smoke-run52-build` không tồn tại. Sau đó `docker ps -a \| grep vg-fea-smoke` rỗng, `docker images \| grep smoke-run52` rỗng, dangling = 0 |
| E2E full `pnpm -C e2e e2e` (1 lần) | exit 0, **`35 passed (3.9m)`** |
| Grep secret trên mọi log + 2 file test mới | regex `PRIVATE KEY` / `client_secret=` / `SESSION_SECRET=<giá trị>` / `OIDC_CLIENT_SECRET=<giá trị>` / `redis://user:pass@` / JWT = 0 file |

Trước E2E và smoke: `netstat` không có LISTENING trên `:3000/:4000/:5173/:3300`, `E2E_REUSE` chưa đặt. Không compose up/down, không prune/filter-delete/push, không FLUSH/drop, không đụng container khác hay `pnpm dev`. Không sửa code sản phẩm/config/lockfile/Dockerfile (git status sau cùng: chỉ thêm 2 file test).

## Lệnh đã chạy + output thực tế

Log ở scratchpad phiên (`fea-*.log`, `docker-build.log`, `smoke.log`, `root-lint.log`, `root-tc.log`, `root-test.log`, `audit.log`, `e2e.log`, `probe-real.mjs`, `busy.mjs`).

### D1 — smoke image (nguyên văn)
```text
ok   check 1: user 1000:1000, uid 1000
ok   check 2: healthy
ok   check 3: /healthz 200 ok + CSP, nosniff, no-store
ok   check 4: / => 307 Location /auth/login?returnTo=%2F
ok   check 5: /assets/_clientId-ykOoc9pH.js 200 text/javascript, nosniff, immutable
ok   check 6: missing asset 404 + CSP
     /assets/..%2f..%2fserver%2fserver.js => 404
     /assets/%2e%2e/%2e%2e/server/server.js => 307
     /server/server.js => 307
     /assets/../../package.json => 307
ok   check 7: no traversal
ok   check 8: /auth/login 503, CSP, no-store, no detail
ok   check 9: 70 000-byte POST 413 + nosniff
ok   check 10: docker stop => exit 0
ok   check 11: missing SESSION_SECRET => exit 1, named, canary absent
ok   check 12: http APP_URL => exit 1
ok   check 13: no .env/.pem, no src/test/dev deps, clean history and env
docker-smoke: 13/13 passed for veyrigate-fe-admin:smoke-run52
```

### T1 — test mới `fe-admin/test/serve-mjs-risk.test.ts` (31 test, không cần build/Docker)
Chạy **`serve.mjs` thật** (copy byte-identical) làm child process trên fixture build trong `fe-admin/node_modules/.cache/serve-mjs-risk-<pid>-<rand>` (gitignored, `srvx` resolve như trong image, xoá ở `afterAll`). `dist/server/server.js` giả có marker; `package.json`, `serve.mjs`, `dist/client/robots.txt` có marker. HTTP thô qua socket (path giữ nguyên byte). Chờ sẵn sàng bằng poll `/healthz` (điều kiện, không sleep cố định).
- Asset GET ⇒ 200, `text/javascript`, `nosniff`, `public, max-age=31536000, immutable`; HEAD ⇒ 200 body rỗng + header; `Accept-Encoding: gzip, br` vẫn giữ header.
- `POST/PUT/PATCH/DELETE/OPTIONS` trên asset có thật ⇒ đi vào app, không bao giờ trả file.
- `/assets/khong-ton-tai.js`, `/robots.txt` (file thật ở `dist/client` ngoài `/assets/`), `/assets/`, `/assets` ⇒ app.
- 21 path traversal: `../`, `%2e%2e`/`%2E%2E`, `..%2f`/`%2F`, double-encode `%252e`, backslash `..\`, `%5c`, null byte `%00` (2 dạng), `//assets/..`, `/assets//..`, `/assets/./..`, `/assets/x/../../..`, `/server/server.js`, `/package.json`, `/serve.mjs`, absolute-form `http://127.0.0.1/assets/../../package.json` ⇒ không cái nào trả marker server bundle / package.json / mã `serve.mjs`.
- Boot self-check lỗi (fixture trả 500) ⇒ exit **1**, log có `fe-admin: startup self-check failed`, **không** chứa canary 40 ký tự đặt ở `OIDC_CLIENT_SECRET`/`SESSION_SECRET`.
- `/healthz` GET/HEAD ⇒ 200.

Lần chạy đầu 1 đỏ do lỗi của test (socket thô nhận body chunked `2\r\nok\r\n0`), đã sửa assertion; sau đó `Tests 46 passed (46)` (cùng T2). eslint + `tsc --noEmit` sạch.

**Mutation `serve.mjs`** (sha256 gốc `c1c1e9eb…eb78`, khôi phục khớp, `git status` vẫn `?? serve.mjs` như trước):

| Mutation | Kết quả |
|---|---|
| Bỏ `headers.set("x-content-type-options", "nosniff")` | 2 đỏ (asset GET, HEAD/gzip) |
| Self-check thành `if (false)` | 1 đỏ (exit 1, timeout 15 s ⇒ không thoát) |
| `dir` = gốc fixture + bỏ kiểm prefix `/assets/` | 10 đỏ (asset + 8 traversal tới `package.json`/`serve.mjs`) |

### T2 — test mới `fe-admin/test/body-limit-risk.test.ts` (15 test)
`rejectBody` thuần: CL `0`, `65535`, `65536`, `065536` ⇒ qua; `65537`, `0065537`, `99999999999999999999999` ⇒ 413; `""`, `+10`, `10, 10`, `10 10` ⇒ 400 (text cố định, `no-store`, không echo giá trị); POST không CL không body ⇒ qua; GET/HEAD/OPTIONS với CL `999999999`/`abc` ⇒ không chặn; method lạ (`PROPFIND`, `post`) ⇒ 413.

**Mutation `body-limit.ts`** (sha256 `483fb741…fe65f`, khôi phục khớp): ngưỡng `> MAX+1` ⇒ 3 đỏ; xoá nhánh 400 ⇒ 9 đỏ.
**Mutation DEBT-374** `query-client.ts` (sha256 `8e5eb8c5…8d9f`, khôi phục khớp): hạn = `Infinity` ⇒ 4 đỏ (`sign-out-race`, `sign-out-race-guard`, `step-up`).

### P1 — probe `serve.mjs` thật + `dist` thật (không Docker, env giả `.invalid`, Redis `127.0.0.1:1`)
Script scratchpad `probe-real.mjs`, 39 + 13 request thô. Trích:

| Request | Kết quả |
|---|---|
| `GET/HEAD /healthz` (Redis tắt, chỉ gọi healthz) | 200 + CSP/nosniff/no-store; log server **không** có lỗi ioredis ⇒ healthz không chạm Redis |
| `POST /healthz` CL 0 | 307 login (không phải `ok`) |
| asset thật GET/HEAD/gzip | 200 `text/javascript`, nosniff, immutable |
| `POST/PUT/DELETE/OPTIONS /assets/<asset>` | 404 text + CSP/nosniff/no-store |
| traversal (`../`, `%2e%2e`, `..%2f`, `%5c`, `\`, `%00`, `%252e`, absolute-form) | 404 hoặc 307 login; 0 leak (`createServerEntry`/`serverEnv`/`"dependencies"`/secret) |
| `GET /assets/<NUL thô>` | 400 từ parser Node (không vào app) |
| CL `65536` / `65537` / `0` (Sec-Fetch-Site same-origin) | 500 JSON server-fn-không-tồn-tại / **413** + A7 / 500 JSON |
| CL `+10`, CL khổng lồ, CL trùng, CL+TE | 400 từ parser Node (body rỗng, không header A7 — trước app, không có nội dung để sniff) |
| TE chunked / POST không CL không body | 411 + A7 (POST rỗng = DEBT-381, đã biết) |
| `X-Forwarded-Host: evil.example` | bị bỏ qua (trust proxy tắt) |
| `GET //a` với `Host: evil.example` | **308 `Location: http://evil.example/a`** ⇒ DEBT-387 |
| `GET //evil.example/x` (Host đúng) | 308 `http://127.0.0.1:<port>/evil.example/x` (cùng origin, không open redirect) |
| `/auth/login` với `Host: evil.example` | 503 như thường (URL dựng từ `APP_URL`) |
| Log server | không chứa secret; có stack trace server-fn và `[ioredis] ... ECONNREFUSED 127.0.0.1:1` (chỉ ở log, không vào response) |

### P2 — characterisation DEBT-384 (cổng bận)
`busy.mjs`: giữ một cổng bằng `net.createServer`, chạy `serve.mjs` với `PORT` đó ⇒ **`exit code=0 signal=null after 680 ms`**, stdout/stderr **rỗng**. Khớp mô tả DEBT-384 (thoát 0 im lặng). Trong container cổng nằm trong netns riêng nên `EADDRINUSE` hiếm; giữ 🟡.

## Test FAIL
Không có test sản phẩm FAIL. (1 đỏ ở lần chạy đầu T1 là lỗi assertion của test, đã sửa — xem T1.)

## Coverage acceptance criteria
- [x] Plan A9 "image chạy" — D1 check 1–3, 10 (non-root, healthy, stop exit 0).
- [x] Plan A9 "đọc env đúng" — D1 check 4, 8 (redirect/503 dùng `APP_URL`/IdP từ env), check 11 (thiếu `SESSION_SECRET` ⇒ exit 1, tên biến, không canary), check 12 (http `APP_URL` ⇒ exit 1); T1 self-check exit 1.
- [x] Healthcheck — D1 check 2–3; `server-entry.test.ts` `/healthz`; P1 healthz không chạm Redis; T1.
- [x] T1 DEBT-370 body limit — `server-entry.test.ts` + T2 + P1 (413/411/400 + A7, router không gọi).
- [x] T1 DEBT-374 cờ signing-out 10 s — `sign-out-race.test.tsx` (t+9 999 / t+10 001 / gia hạn), `sign-out-race-guard.test.tsx`; mutation `Infinity` ⇒ 4 đỏ.
- [x] T1 DEBT-368 throw ⇒ 500 có header — `security-headers.test.ts` (dev) xanh trong root test.
- [x] T2 asset header (DEBT-362/264) — D1 check 5, T1, P1.
- [x] T2 image vệ sinh (không `.env`/PEM/src/test/dev deps, history/Env sạch) — D1 check 13.
- [x] T3 runbook §7 — đã đọc, khớp hành vi đo được (healthz liveness, exit khi env lỗi, header asset, 1 replica, không trust proxy). Bổ sung khuyến nghị pin Host ⇒ DEBT-387.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | anonymous (không cookie) ⇒ 307 login | D1 check 4, P1 |
| Credential | secret thiếu ⇒ exit 1; canary không ra log | D1 check 11, T1 |
| Input | CL biên 0/65535/65536/65537, dạng lạ, khổng lồ, trùng, CL+TE, chunked; traversal 21+ biến thể | T2, `server-entry.test.ts`, T1, P1 |
| Input — method | GET/HEAD vs POST/PUT/PATCH/DELETE/OPTIONS trên `/assets`, `/healthz` | T1, P1, `server-entry.test.ts` |
| Request chain | Host giả, `X-Forwarded-Host` giả, `//` path | P1 ⇒ DEBT-387 |
| State | cửa sổ đăng xuất hết hạn/gia hạn | `sign-out-race*.test.tsx`, mutation |
| Dependency | Redis tắt ⇒ healthz 200; IdP không tới ⇒ 503 không chi tiết; cổng bận ⇒ exit 0 (DEBT-384) | P1, D1 check 8, P2 |
| Exposure | response lỗi text cố định; log không secret; image không secret | D1 check 8/11/13, T1, P1, grep |
| INV không chạy root | uid 1000, read-only rootfs | D1 check 1–2 |
| INV header mọi response | asset/404/413/411/500 có nosniff (trừ 400 do parser Node trước app, body rỗng) | D1, T1, P1 |

## Debt mới
- **DEBT-387** 🟡 — 308 với `Location` tuyệt đối `http://<Host>` cho path bắt đầu `//` (xem P1). `no-store` chặn cache-poisoning, attacker chỉ ảnh hưởng response của chính mình ⇒ không chặn PASS.
