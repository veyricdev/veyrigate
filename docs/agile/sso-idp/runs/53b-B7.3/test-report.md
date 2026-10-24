# Test Report — 2026-10-24 (run 53b, B7.3 phần 2: `be/Dockerfile` + DEBT-384/385)

## Kết quả: PASS

- Smoke BE image **11/11**, smoke fe-admin image **14/14** (tester tự build lại cả hai image từ working tree).
- Probe rủi ro độc lập của tester: **13/13 kỳ vọng đúng** (case P1–P13). DEBT-397 tái hiện đúng như dev mô tả (137), giữ 🟡.
- be typecheck/lint/build đều 0. be unit **475/475 × 3 lần** (2 lần trực tiếp + 1 lần trong root `pnpm test`), không tái hiện flake dev nhắc.
- fe-admin **64 file / 1416 test**. Root `pnpm lint` 0, `pnpm -r run typecheck` 0. Root `pnpm test` 0: be 475, fe-admin 1416, fe-sso-test 269.
- `pnpm audit --audit-level high` 0 (6 low, 7 moderate, 1 high đã ignore sẵn).
- `be/keys` sha256 và mtime không đổi. Grep secret trên output của tester: 0.

Phạm vi: diff chưa commit so với HEAD `8cc1c2d`. Tester không sửa code sản phẩm, Dockerfile hay config, không thêm file test vào repo. Script probe chỉ nằm trong scratchpad của phiên. E2E không chạy (không bắt buộc, `be/src` không đổi).

## Lệnh đã chạy + output thực tế

### Case 1 — build BE image (build stage + runtime)
```
docker build -q -f be/Dockerfile --target build -t veyrigate-be:smoke-run53b-build .   # exit 0, 51,7 s
docker build -q -f be/Dockerfile -t veyrigate-be:smoke-run53b .                        # exit 0, 9,4 s (cache)
```

### Case 2 — `bash be/scripts/docker-smoke.sh veyrigate-be:smoke-run53b veyrigate-be:smoke-run53b-build` (exit 0, 50,6 s)
```
ok   check 1: user 1000:1000, uid 1000, app files owned by root
ok   check 2: healthy (HEALTHCHECK on /health)
ok   check 3: /health 200
ok   check 4: /ready 200 mongo up, redis up
ok   check 5: /jwks.json = Vault Transit key v1, kid = thumbprint, no private part
ok   check 6: no /app/.env, no env/key files (runtime + build stage), no src/test/dev deps/maps, clean history and env
ok   check 7: Redis down => /health 200, /ready 503 redis down
ok   check 8: docker stop => exit 0
ok   check 9: missing CSRF_SECRET => exit 1, named, canary absent
ok   check 10: KEY_PROVIDER=local in production => exit 1
ok   check 11: app log: no Mongo password, CSRF secret, Vault token or token path
docker-smoke: 11/11 passed for veyrigate-be:smoke-run53b
```

### Case 3 — build fe-admin + `bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:smoke-run52` (build 0, smoke 0)
```
ok   check 1: user 1000:1000, uid 1000
ok   check 2: healthy
ok   check 3: /healthz 200 ok + CSP, nosniff, no-store
ok   check 4: / => 307 Location /auth/login?returnTo=%2F
ok   check 5: /assets/_clientId-ykOoc9pH.js 200 text/javascript, nosniff, immutable
ok   check 6: missing asset 404 + CSP
ok   check 7: no traversal
ok   check 8: /auth/login 503, CSP, no-store, no detail
ok   check 9: 70 000-byte POST 413 + nosniff
ok   check 10: docker stop => exit 0
ok   check 11: missing SESSION_SECRET => exit 1, named, canary absent
ok   check 12: http APP_URL => exit 1
ok   check 13: no .env/.pem, no src/test/dev deps, clean history and env
ok   check 14: listen error => exit 1, EADDRNOTAVAIL logged
docker-smoke: 14/14 passed for veyrigate-fe-admin:smoke-run52
```

### Case 4 — metadata image BE (`docker image inspect`, `docker history --no-trunc`)
```
Labels=null
Env=[PATH, NODE_VERSION=22.23.2, YARN_VERSION=1.22.22, NODE_ENV=production, PORT=4000]
User=1000:1000  Cmd=["node","dist/main.js"]  Entrypoint=["docker-entrypoint.sh"]  WorkingDir=/app
history --no-trunc | grep -ciE 'secret|password|token=|mongodb://|redis://|hvs\.|BEGIN .*PRIVATE|api[_-]?key'
  runtime: 0    build stage: 0
```
Grep này rộng hơn check 6 của smoke: có thêm `secret`, `password` không dấu `=`, `hvs.`, PEM và `api_key`.

### Case 5 — nội dung `/app` của runtime
```
/app: dist/ node_modules/ package.json   (root:root 755, không có .env)
du: /app/node_modules 148M, /app/dist 1.1M
top-level node_modules: @fastify/{cookie,formbody,helmet,static,view} @nestjs/{common,config,core,mongoose,platform-fastify,swagger}
  @node-rs/argon2 @prometheus-io/client class-transformer class-validator eta ioredis ipaddr.js jose mongoose nestjs-pino
  nodemailer pino-http reflect-metadata rxjs zod
```
Không có ở top-level: jest, ts-jest, ts-node, @nestjs/cli, @nestjs/testing, eslint, prettier, supertest, pino-pretty, mongodb-memory-server, vitest.
Không có `*.ts`/`*.map` trong `/app/dist`. `*.spec.js` chỉ thấy trong thư mục test do chính thư viện bên thứ ba publish (pino, json-schema-traverse, tdigest).
**Ngoại lệ:** có `.pnpm/typescript@5.7.3` (22,6 MB). Gói này vào image vì `@nestjs/swagger` (dependency runtime) link tới nó. Đây không phải devDependency của `be`. Ghi DEBT-399.

### Case 6 — build context thật của `be/Dockerfile.dockerignore`
Tester dựng một Dockerfile probe trong scratchpad, dùng **bản sao** của ignore file làm `probe.Dockerfile.dockerignore`, chạy `COPY . /ctx` rồi liệt kê tên file. Image `veyrigate-be:smoke-run53b-ctx` đã `rmi` ngay sau đó.
```
CTX files: 192
CTX top: be package.json pnpm-lock.yaml pnpm-workspace.yaml
CTX be: .prettierignore .prettierrc Dockerfile Dockerfile.dockerignore README.md eslint.config.mjs jest.config.js nest-cli.json package.json scripts src tsconfig.build.json tsconfig.json
CTX sensitive: [/ctx/be/src/modules/keys ]   # thư mục mã nguồn tên "keys", không phải be/keys
```
`be/.env` và `be/keys/` đều có trên máy build nhưng không lọt vào context. `be/node_modules`, `be/dist`, `be/test` cũng không.

### Case 7 — probe rủi ro runtime (`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`)
Thiết lập: mạng `vg-b73b-net`, `vg-b73b-mongo` (có auth, mật khẩu sinh mỗi lần), `vg-b73b-redis`, image digest giống smoke. App `vg-b73b-probe` chạy `CMD` gốc của image, **không override entrypoint**.
App chạy `NODE_ENV=test` + `KEY_PROVIDER=local` (`KEY_LOCAL_DIR=/tmp/keys`, tmpfs) để không cần Vault. Production chặn `local` (smoke check 10). `development` thì cần `pino-pretty`, gói này đúng là không có trong image: lần thử đầu container exit 1 với lỗi `unable to determine transport target for "pino-pretty"`, xác nhận devDependency đã bị loại.
```
P vg-b73b-probe caps: true [ALL] [no-new-privileges]
P vg-b73b-probe /health: 200
P vg-b73b-probe /ready: 200
sh: 1: cannot create /app/.env: Read-only file system
P write /app/.env (uid1000, ro rootfs): denied
P /app/.env exists: no
P /app perms: root:root 755 root:root 755 root:root 755
P effective caps: CapPrm: 0000000000000000 CapEff: 0000000000000000 NoNewPrivs: 1
P pid1: node dist/main.js
P health status: healthy
P redis-down /health: 200
P redis-down /ready: {"status":"error","mongo":"up","redis":"down"} 503
P redis-down after 3s /health: 200 /ready: 503 running: true
P DEBT-397 redis-down stop exit: 137 after 18s
P   log: ... "RedisService","msg":"Closing Redis connection"
P   log: ... "MongoClient","msg":"Mongo disconnected"
P vg-b73b-probe2 caps: true [ALL] [no-new-privileges]
P vg-b73b-probe2 /health: 200
P vg-b73b-probe2 /ready: 200
P control redis-up stop exit: 0 after 1s
```
Log của probe không chứa mật khẩu Mongo hay `CSRF_SECRET` (không có dòng `LEAK`).

### Case 8 — kiểm tra trên host
```
pnpm -C be run typecheck   # exit 0
pnpm -C be run lint        # exit 0
pnpm -C be run build       # exit 0
pnpm -C be test  (lần 1)   # Test Suites: 33 passed; Tests: 475 passed, 475 total
pnpm -C be test  (lần 2)   # Test Suites: 33 passed; Tests: 475 passed, 475 total
pnpm -C fe-admin test      # Test Files 64 passed (64); Tests 1416 passed (1416)
pnpm lint                  # exit 0
pnpm -r run typecheck      # exit 0
pnpm test                  # exit 0 — be 475/475 (lần thứ 3), fe-admin 64/1416, fe-sso-test 31 file/269
pnpm audit --audit-level high  # exit 0 — 13 vulnerabilities (6 low | 7 moderate), 1 ignored: 1 high
be/keys: sha256 + mtime trước/sau: diff rỗng
grep 'hvs\.|BEGIN … PRIVATE KEY|mongodb://user:pass@|CSRF_SECRET=…' trên mọi log của tester: 0 file
```

## Test FAIL

Không có.

Flake be unit mà dev nhắc (1 fail không rõ tên ngay sau build) **không tái hiện** qua 3 lần chạy, trong đó lần 1 chạy ngay sau `pnpm -C be build`. Không mở debt mới vì không có bằng chứng; nếu tái diễn thì ghi tên test.

## Coverage acceptance criteria

- [x] T1 `be/Dockerfile` multi-stage, non-root, file root-owned: smoke check 1; case 4 (User 1000:1000); case 7 (`/app` root 755, ghi `/app/.env` bị từ chối).
- [x] T1 không `.env`/key trong mọi layer: smoke check 6 (runtime + build stage); case 4 (history grep rộng, Labels null, Env 5 biến); case 6 (context thật không có `be/.env`, `be/keys`).
- [x] T1 không src/test/devDependency/map: smoke check 6; case 5 (riêng `typescript` là transitive runtime ⇒ DEBT-399 🟢); case 7 (`development` crash vì thiếu `pino-pretty` ⇒ dev dep đã bị loại).
- [x] T1 HEALTHCHECK = `/health`, Redis chết ⇒ `/health` 200 + `/ready` 503: smoke check 2 và 7; case 7 (giữ 503 ≥ 3 s, container vẫn chạy, health `healthy`).
- [x] T1 fail-closed khi boot: smoke check 9 (thiếu env ⇒ 1, canary vắng) và check 10 (`local` ở prod ⇒ 1).
- [x] T1 JWKS = khoá Vault Transit: smoke check 5.
- [x] T1 `docker stop` ⇒ 0/143 (Redis sống): smoke check 8; case 7 đối chứng (0 sau 1 s).
- [x] T1 CI job `be-image` không push: đã đọc diff `ci.yml`, job chỉ build + smoke (senior đã review). Tester không chạy CI.
- [x] T2 DEBT-385 ignore fe-admin: smoke fe-admin check 13; `fe-admin test` 1416 xanh.
- [x] T2 DEBT-384 `serve.mjs` listen lỗi ⇒ exit 1 + mã lỗi: smoke fe-admin check 14 (EADDRNOTAVAIL); test `serve-mjs-risk` nằm trong 1416.
- [x] T3 runbook §7/§9: đã đọc; nội dung khớp hành vi đã quan sát (`/health` vs `/ready`, token file, cấm mount `/app`).

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Case |
|---|---|---|
| Credential | env thiếu; token Vault qua stdin/tmpfs; `KEY_PROVIDER=local` ở prod | smoke 9, 10, 11 |
| Exposure — image | history `--no-trunc` (runtime + build), Env, Labels, file `.env`/PEM/key ở mọi path, build context | smoke 6, case 4, 6 |
| Exposure — log | canary khi thiếu env; mật khẩu Mongo/CSRF/root token/app token không xuất hiện trong log app; log probe sạch | smoke 9, 11, case 7 |
| Privilege | uid 1000; CapEff/CapPrm = 0; NoNewPrivs = 1; rootfs read-only; `/app` không ghi được | smoke 1, case 7 |
| State — `/app/.env` lúc chạy | không tồn tại; không tạo được (read-only + root-owned) | smoke 6, case 7 |
| Dependency — Redis | down ⇒ `/health` 200, `/ready` 503 `redis:down`, container sống, health giữ `healthy`; Redis quay lại ⇒ `/ready` 200 | smoke 7, case 7 |
| Dependency — Redis lúc shutdown | down ⇒ `docker stop -t 15` ⇒ **137** sau 18 s (DEBT-397 🟡, characterisation); up ⇒ 0 sau 1 s | case 7 |
| Process | PID 1 = `node dist/main.js` khi chạy `CMD` gốc không override entrypoint (đóng 💭3 của senior ở mức probe) | case 7 |
| Listen lỗi (fe-admin) | địa chỉ không gán được ⇒ exit 1 + mã lỗi | smoke fe-admin 14 |

Ghi chú DEBT-397: log cho thấy `Closing Redis connection` chạy **trước** `Mongo disconnected`. Nghĩa là Mongo vẫn đóng được trong lúc `redis.quit()` treo, rồi process vẫn không thoát cho tới SIGKILL. Mức 🟡 vẫn đúng: HTTP đóng trước nên không mất dữ liệu, chỉ mất graceful exit khi Redis đang sự cố. Kế hoạch sửa ở run 53c.

## Đo kích thước (cho DEBT-399 🟢, không sửa)

| Image | `docker images` | `.Size` |
|---|---|---|
| `veyrigate-be:smoke-run53b` | 505 MB | 102 243 249 |
| `veyrigate-be:smoke-run53b-build` | 1,16 GB | 205 424 628 |
| `veyrigate-fe-admin:smoke-run52` | 567 MB | 115 360 255 |

Layer `COPY /out /app` 156 MB. Top `.pnpm` (KB): typescript@5.7.3 22 596, es-toolkit 14 380, swagger-ui-dist 11 724, rxjs 11 332, libphonenumber-js 11 116, zod 7 676, class-validator 7 604, mongodb 4 484, fastify 3 876, @microsoft/tsdoc 3 108. Base còn `/usr/local/lib/node_modules` (npm + corepack) 19 MB và `/opt/yarn-v1.22.22` 5,2 MB.

## Nit (không mở debt)

- `docker-smoke.sh` trong `be/Dockerfile.dockerignore` chỉ khớp ở root, nên `be/scripts/docker-smoke.sh` vẫn vào context và layer `COPY be/ be/` của build stage. File không chứa secret và không vào runtime, chỉ làm cache build stage bị bust khi sửa smoke. Có thể đổi thành `be/scripts`.

## Docker — dọn dẹp

Đã tạo: mạng `vg-b73b-net`; container `vg-b73b-{mongo,redis,vault}`, `vg-be-smoke-{ok,noenv,local}` (trap của smoke); `vg-fea-smoke-*` (trap); `vg-b73b-{mongo,redis,probe,probe2}` (probe); image `veyrigate-be:smoke-run53b`, `veyrigate-be:smoke-run53b-build`, `veyrigate-be:smoke-run53b-ctx` (đã `rmi`), `veyrigate-fe-admin:smoke-run52`.
Lần probe đầu dùng `NODE_ENV=development` nên crash vì thiếu `pino-pretty`. Tester dừng tiến trình đó và xoá đúng tên `vg-b73b-{probe,probe2,mongo,redis}` + mạng.
Sau cùng: không còn container hoặc mạng `vg-b73b-*`, `vg-be-smoke-*`, `vg-fea-smoke-*`. Không prune, không compose, không push, không đụng `aegate-*`/`vg-test-*`/`funny_pascal`. Image smoke được giữ để orchestrator/CI tham chiếu: `veyrigate-be:smoke-run53b[-build]`, `veyrigate-fe-admin:smoke-run52`.
