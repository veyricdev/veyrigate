# Tasks — run 52 — A9: Dockerfile + deploy fe-admin (M7, lane ADMIN) + DEBT-370/374

> Plan §6 A9: "Dockerfile + cấu hình deploy (Node server của Start) + healthcheck" — nghiệm thu "Image chạy, đọc env đúng". A8 (test) đã phủ dần qua A4–A7 (unit/component/E2E đăng nhập → client → audit → step-up); tech-lead xác nhận A8 còn thiếu gì thì gộp. Khuôn: Dockerfile BE (B7.3 nếu đã có) và `runbook-deploy.md`. Không push image, không chạy compose up trên hạ tầng `aegate-*`.
>
> Thứ tự: Task 1 → 2 → 3 (frontend-dev). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: DEBT-370 — giới hạn kích thước body `/_serverFn` ở BFF (413) + test âm; DEBT-374 — cờ signing-out tự hết hạn (không kẹt vĩnh viễn) + test.

### [x] Task 2 [FE/ops]: `fe-admin/Dockerfile` multi-stage (pnpm workspace, build Start, runtime non-root, chỉ prod deps, không chứa `.env`/secret), `.dockerignore`, healthcheck (endpoint nào — liveness của BFF, không gọi IdP), env bắt buộc fail-fast khi thiếu (đã có `server/env.ts`), header bảo mật (A7) áp cho asset tĩnh ở prod (DEBT-362/264 nếu thuộc phạm vi).

### [x] Task 3 [ops/test]: build image thật (nếu Docker có sẵn) và chạy container với env test trỏ BE E2E ⇒ healthcheck healthy, trang login redirect đúng, thiếu env ⇒ thoát với thông báo không lộ giá trị; cập nhật `runbook-deploy.md` phần fe-admin. Dọn container/image tạm sau khi chạy.

## Câu hỏi cho tech-lead
- Q-52.1: Start 1.168.60 build output/entry cho Node (srvx/`dist/server/server.js`?), cách phục vụ asset tĩnh + header ở prod.
- Q-52.2: Healthcheck path và nội dung; có cần `/ready` riêng cho fe-admin (Redis) không.
- Q-52.3: Docker có trên máy không; được phép build/run container tạm tên gì, dọn ra sao mà không đụng `aegate-*`/`vg-test-*`.

## Fold tech-lead (2026-10-24) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `6df705a`, chi tiết ở `review-techlead.md`. Cả 3 task giao frontend-dev, làm theo thứ tự 1 → 2 → 3. Cấm sửa `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`, `fe-admin/.env`. Ghi file UTF-8 không BOM, không NUL.

### Sự thật từ code (sửa text ở trên)

**Build output (Q-52.1)**
- `vite build` sinh `dist/server/server.js`, `export default { fetch }` (Web Fetch, đã bọc `src/server.ts`). File này **không mở cổng**.
- Asset nằm ở `dist/client/assets/*` (tên có hash). Không có `index.html`.
- `vite preview` cần devDependencies, không dùng cho production.

**Env lỗi**: hiện server **không thoát**. `server.ts` bắt lỗi rồi trả 500 cho mọi request, và tên biến được log qua `onValidationError`.

**Bắt buộc https**: build prod luôn có `import.meta.env.PROD`, nên `OIDC_ISSUER`/`ADMIN_API_BASE_URL`/`APP_URL` phải là `https`. ⇒ Container prod **không** đăng nhập được với BE E2E `http://localhost:4000`. **Không thêm cờ nới lỏng** (ví dụ ALLOW_HTTP). Đăng nhập thật trên image ⇒ DEBT-375.

**CLI srvx**: tự nạp `.env`/`.env.production` từ cwd, và `serveStatic` chạy trước app (asset không có header) ⇒ **cấm dùng**.

**Root guard**: không có cookie `fea_sid` thì `liveSession` trả null mà không gọi Redis ⇒ redirect `/auth/login?returnTo=…` (`reloadDocument`).

**CSRF `/_serverFn`**: ưu tiên `Sec-Fetch-Site`. Nếu không có header này thì so `Origin` với `new URL(request.url).origin`. Hành vi sau proxy TLS ghi ở DEBT-376, không sửa trong run này.

**Không có `be/Dockerfile`**: B7.3 chưa làm, nên không có khuôn BE. Không có `.dockerignore` nào trong repo.

### Task 1 [FE]: DEBT-370 + DEBT-374 + DEBT-368

**(a) DEBT-370 — giới hạn body**
- Viết pure function ở `fe-admin/src/server/body-limit.ts`, gọi trong `src/server.ts`: bên trong `withSecurityHeaders`, sau nhánh `envValid`, sau `/healthz` (Task 2), trước `handler.fetch`.
- Áp cho **mọi** method khác `GET`/`HEAD`/`OPTIONS`. BFF không có upload; `/auth/logout` và `/_serverFn` đều nhỏ.
- `MAX_BODY_BYTES = 65_536`.

| Tình huống | Kết quả |
|---|---|
| `content-length` không khớp `^\d+$` | 400 |
| `content-length` > 65 536 | 413 |
| Không có `content-length` mà `request.body !== null` (chunked) | 411 |
| Khác | chuyển tiếp |

- Response lỗi: body văn bản cố định (`Bad Request` / `Payload Too Large` / `Length Required`), `cache-control: no-store`, qua `withSecurityHeaders` nên có CSP/nosniff. Không echo giá trị nào.
- Dựa vào parser HTTP của Node: không đọc quá `Content-Length`, và từ chối request có cả CL lẫn TE. Ghi rõ điều này trong comment. Không tự đếm stream.
- Test âm (spy handler, khẳng định **không gọi** khi bị chặn):
  - 65 536 byte ⇒ handler được gọi.
  - 65 537 ⇒ 413, có header CSP + nosniff + `no-store`.
  - Stream không CL (`new Request(url, { method: "POST", body: ReadableStream, duplex: "half" })`) ⇒ 411.
  - CL `abc` / `-1` / `1e3` ⇒ 400.
  - GET có query dài ⇒ không bị chặn.
  - POST `/auth/logout` nhỏ ⇒ không bị chặn.
- Mutation: bỏ nhánh 413 ⇒ test đỏ. Khôi phục byte-identical.
- Phần "kiểm session trước khi parse input" không làm trong run này ⇒ DEBT-377.

**(b) DEBT-374 — cờ signing-out tự hết hạn** (`features/admin-api/query-client.ts`)
- `let signingOutUntil = 0`. `beginSignOut` đặt `Date.now() + 10_000`. `isSigningOut = () => Date.now() < signingOutUntil`.
- `signInAgain` dùng `isSigningOut()`. Bỏ listener `pageshow`.
- Test với `vi.useFakeTimers()`/`vi.setSystemTime`:
  - t+9 999 ms: `signInAgain`/`reauthenticate`/`startStepUp` không `assign`.
  - t+10 001 ms: cả ba `assign` lại.
  - `beginSignOut` lần 2 gia hạn cửa sổ.
- Sửa `sign-out-race.test.tsx` / `sign-out-race-guard.test.tsx`: không còn phụ thuộc thứ tự test hay listener `pageshow`; mỗi test tự đẩy thời gian qua hạn trong `afterEach`.
- Mutation: hạn = `Infinity` ⇒ test quá hạn đỏ.

**(c) DEBT-368** (`security-headers.ts`)
- `handle` throw ⇒ trả `500 Internal Server Error` text cố định, **vẫn có** CSP/nosniff/`no-store`.
- Ghi log theo quy ước `errors.ts` hiện có: có request id, không ghi giá trị/stack ra response.
- Unit test: `handle` throw ⇒ 500 + header. Mutation: bỏ catch ⇒ đỏ.

**Verify Task 1**: `pnpm -C fe-admin test`, `lint`, `typecheck`, `build`, `check:bundle` đều xanh.

### Task 2 [FE/ops]: entry Node + Dockerfile + healthcheck + CI

**(a) `/healthz` trong `src/server.ts`**
- `GET|HEAD` tại pathname chính xác `/healthz`. Đặt bên trong `withSecurityHeaders`, sau `envValid`, trước body-limit/router.
- Trả 200, body `ok`, `content-type: text/plain; charset=utf-8`, `no-store`.
- Không gọi Redis/IdP/session.
- Test:
  - 200 + header A7.
  - env lỗi ⇒ 500.
  - `POST /healthz` ⇒ không trả `ok`: đi tiếp vào router, kết quả 404/405 nào cũng được, miễn khác 200 `ok`.
  - `/healthz/x` ⇒ không phải healthz.

**(b) `fe-admin/serve.mjs`** (ESM thuần, ≤ 80 dòng, không qua bundler)
- Thêm dependency `"srvx": "0.11.22"`: pin đúng, bản đã có trong lockfile, phát hành 2026-07-11. Diff lockfile chỉ được thêm importer fe-admin → srvx, **không** có version mới. Kiểm lại bằng `git diff pnpm-lock.yaml`.
- Trình tự:
  1. `const app = (await import("./dist/server/server.js")).default`.
  2. Tự kiểm: `const r = await app.fetch(new Request("http://localhost/healthz"))`. Nếu `r.status !== 200` ⇒ `console.error("fe-admin: startup self-check failed (see errors above)")` rồi `process.exit(1)`. Không in env.
  3. `serve({ fetch: app.fetch, gracefulShutdown: true, middleware: [assets] })`. `port`/`hostname` lấy từ `PORT`/`HOST` (mặc định của srvx). **Không** bật trust proxy.
- Middleware `assets`:
  - Chỉ chạy khi `GET|HEAD` và pathname bắt đầu `/assets/`.
  - Gọi `serveStatic({ dir: <dist/client tuyệt đối> })`. **Không bao giờ** `dir` = `dist` hay `dist/server`.
  - Có file ⇒ trả response mới, header gốc cộng `x-content-type-options: nosniff` và `cache-control: public, max-age=31536000, immutable`.
  - Không có file ⇒ `next()`, app trả 404 kèm header A7.
- Không đọc `.env` (không `--env-file`, không dotenv).

**(c) `fe-admin/Dockerfile`** (context = gốc repo: `docker build -f fe-admin/Dockerfile -t <tag> .`)
- Base cho **mọi stage**: `node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`.
  - Đây là index digest, tech-lead đọc bằng `docker buildx imagetools inspect` ngày 2026-10-24.
  - Node 22.23.2 phát hành 2026-07-28 (≥ 14 ngày), khớp `.nvmrc`/engines.
  - Đặt một `ARG NODE_IMAGE=…@sha256:…` dùng chung. Nếu lúc làm digest đã khác, ghi digest mới (đọc bằng imagetools) vào `log.md`. **Không** dùng tag trần.
- Stage `build`:
  1. `corepack enable` (pnpm 12.6.0 theo `packageManager`).
  2. COPY manifest + lockfile trước để tận dụng cache.
  3. `pnpm install --frozen-lockfile --filter @sso-idp/fe-admin...`. Nếu pnpm đòi manifest của importer khác thì COPY thêm **chỉ** `package.json` của chúng.
  4. COPY `fe-admin/`.
  5. `pnpm -C fe-admin build && pnpm -C fe-admin check:bundle`.
  6. Tạo `/out` chỉ gồm prod deps: ưu tiên `pnpm --filter @sso-idp/fe-admin deploy --prod /out`. Nếu pnpm 12 đòi inject-workspace-packages thì dùng cách tương đương, miễn đạt kết quả và ghi lại cách đã chọn trong `log.md`.
  7. Copy `dist/` + `serve.mjs` vào `/out`.
- Stage `runtime`:
  - `ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000`, `WORKDIR /app`.
  - `COPY --from=build /out /app`: file thuộc root, user runtime không ghi được.
  - `USER 1000:1000` (numeric), `EXPOSE 3000`.
  - `HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]`.
  - `CMD ["node","serve.mjs"]` dạng exec, không shell wrapper.
- Image chỉ được chứa `package.json`, `node_modules` (prod), `dist/`, `serve.mjs`. Không chứa `src/`, `test/`, `.env*`, `*.pem`, `be/`, `e2e/`, `docs/`, `.git`.
- **Không** `ARG`/`ENV` nào chứa secret. **Không** `--secret` (build không cần env).

**(d) `fe-admin/Dockerfile.dockerignore`** (BuildKit đọc theo Dockerfile; **không** tạo `.dockerignore` ở gốc)
- Dạng allowlist: `*`, rồi `!package.json`, `!pnpm-lock.yaml`, `!pnpm-workspace.yaml`, `!fe-admin/` (+ `package.json` importer khác nếu cần).
- Sau đó loại: `fe-admin/node_modules`, `fe-admin/dist`, `fe-admin/.env*`, `**/*.pem`, `**/*.log`, `fe-admin/test`, `fe-admin/coverage`.
- Lưu ý: dòng loại phải nằm **sau** dòng `!` vì dòng cuối thắng.

**(e) `fe-admin/scripts/docker-smoke.sh <image-tag>`** (bash, `set -euo pipefail`)
- Dùng cho cả Task 3 và CI.
- Chỉ tạo container tên `vg-fea-smoke-ok` / `vg-fea-smoke-noenv` / `vg-fea-smoke-http`. Có `trap` `docker rm -f` **đúng 3 tên này**, `>/dev/null 2>&1 || true`.
- Cổng `127.0.0.1:3300:3000`.
- Cờ run: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`.
- Env giả:
  - `OIDC_ISSUER=https://idp.example.invalid`, `ADMIN_API_BASE_URL=https://idp.example.invalid`, `ADMIN_API_RESOURCE=https://idp.example.invalid/admin/`, `APP_URL=https://admin.example.invalid`, `OIDC_CLIENT_ID=fe-admin`.
  - `SESSION_REDIS_URL=redis://127.0.0.1:1/0`: trỏ vào chính container, **không** nối Redis host.
  - Secret sinh lúc chạy: `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"`. Truyền bằng `-e NAME` (lấy giá trị từ env của shell), **không** đặt giá trị trên command line, không ghi file trong repo.
- Script **không** tự xoá image (Task 3/CI tự lo). Không `prune`.
- Assertion (fail ⇒ exit ≠ 0, in tên check, **không** in giá trị secret):
  1. `docker image inspect` có `.Config.User` = `1000:1000`. `docker exec vg-fea-smoke-ok id -u` ≠ 0.
  2. Health = `healthy` trong ≤ 60 s.
  3. `/healthz` ⇒ 200, body `ok`, có `content-security-policy`, `x-content-type-options: nosniff`, `cache-control: no-store`.
  4. `/` (không cookie) ⇒ 3xx, `Location` bắt đầu `/auth/login?returnTo=` hoặc `https://admin.example.invalid/auth/login`. Ghi lại dạng thực tế.
  5. Một asset `.js` (lấy tên bằng `docker exec … ls /app/dist/client/assets`) ⇒ 200, `content-type: text/javascript`, `nosniff`, `cache-control` chứa `immutable`.
  6. `/assets/khong-ton-tai.js` ⇒ 404 có CSP.
  7. Traversal: `/assets/..%2f..%2fserver%2fserver.js`, `/assets/%2e%2e/%2e%2e/server/server.js`, `/server/server.js`, `/assets/../../package.json` (`curl --path-as-is`). Không cái nào trả 200 với body chứa `createServerEntry`, `serverEnv` hoặc `"dependencies"`.
  8. `/auth/login` ⇒ 503 (IdP không tới được), có CSP + `no-store`. Body không chứa `example.invalid`, `ECONN`, `ENOTFOUND`, `    at `, hay giá trị secret.
  9. `POST /_serverFn/x` với `Sec-Fetch-Site: same-origin` và body 70 000 byte ⇒ 413 + nosniff.
  10. `docker stop -t 10 vg-fea-smoke-ok` ⇒ ExitCode ∈ {0, 143}, **không** 137.
  11. `vg-fea-smoke-noenv`: thiếu `SESSION_SECRET`, và `OIDC_CLIENT_SECRET` = canary 40 ký tự sinh ngẫu nhiên. Container phải thoát với ExitCode ≠ 0 trong ≤ 20 s (`docker wait` có timeout). `docker logs` chứa `SESSION_SECRET` và **không** chứa canary.
  12. `vg-fea-smoke-http`: `APP_URL=http://admin.example.invalid` ⇒ thoát ≠ 0, log chứa `APP_URL`.
  13. Vệ sinh image:
      - `docker run --rm --entrypoint sh <tag> -c 'find / -xdev \( -name ".env*" -o -name "*.pem" \) 2>/dev/null'` ⇒ rỗng.
      - Không có `/app/src`, `/app/test`.
      - Không có `/app/node_modules/{vitest,happy-dom,typescript,@testing-library}`.
      - `docker history --no-trunc <tag>` và `.Config.Env` không chứa `SECRET=`/`PASSWORD=`/`redis://`. Env chỉ gồm `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV`, `HOST`, `PORT`.

**(f) CI**: thêm job `fe-admin-image` vào `.github/workflows/ci.yml`.
- `permissions: contents: read`, `timeout-minutes: 20`.
- Bước: `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:ci .` rồi `bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:ci`.
- Không login registry, không push, không cache-to.
- Cập nhật comment đầu file: thêm `fe-admin-image` vào danh sách required checks.

### Task 3 [ops/test]: chạy thật trên máy + runbook

**Được phép**
- `docker build` với tag `veyrigate-fe-admin:smoke-run52` và `veyrigate-fe-admin:smoke-run52-build` (`--target build`).
- Chạy `docker-smoke.sh veyrigate-fe-admin:smoke-run52` ⇒ 13/13 xanh. Dán output vào `log.md`, bỏ phần secret.

**Kiểm build stage**: `docker run --rm --entrypoint sh veyrigate-fe-admin:smoke-run52-build -c 'find / -xdev -name ".env*" -not -path "*/node_modules/*" 2>/dev/null'` ⇒ rỗng. Máy dev có sẵn `fe-admin/.env` thật, nên đây là canary thật.

**Mutation** (mỗi cái: sửa → build tag `…:smoke-run52` → chạy smoke → kỳ vọng đỏ đúng check → khôi phục byte-identical, kiểm bằng `git diff --stat` rỗng cho file đó):

| Sửa | Check phải đỏ |
|---|---|
| Bỏ `USER 1000:1000` | 1 |
| Bỏ bước self-check trong `serve.mjs` | 11 |
| Bỏ header trong middleware `assets` | 5 |
| Bỏ dòng `fe-admin/.env*` trong `Dockerfile.dockerignore` | kiểm build stage ở trên (xoá image ngay sau đó) |

**Dọn (bắt buộc, kể cả khi fail)**
- `docker rm -f vg-fea-smoke-ok vg-fea-smoke-noenv vg-fea-smoke-http`
- `docker image rm veyrigate-fe-admin:smoke-run52 veyrigate-fe-admin:smoke-run52-build`
- Cuối cùng chạy `docker ps -a --format '{{.Names}}' | grep vg-fea-smoke` và `docker images | grep smoke-run52` ⇒ đều rỗng. Ghi vào `log.md`.

**Cấm**
- `docker system/image/builder/container prune`, xoá theo `--filter`/wildcard.
- `compose up/down`, push.
- Đụng `aegate-*`, `vg-test-*`, `veyrigate-*-1`, `sso-test-*`, `funny_pascal`, `mysql-db`.
- Dừng process.
- Build cache của BuildKit để lại, không dọn bằng prune.

**`runbook-deploy.md`**: thêm mục `## 7. fe-admin (BFF) — image & deploy`, gồm:
- Lệnh build.
- Bảng env, ghi rõ: prod bắt buộc `https` cho 3 URL; secret ≥ 32 ký tự; `SESSION_REDIS_URL` nên `rediss://` + ACL `~fea:*` (DEBT-280).
- Chạy sau reverse proxy TLS. **Không** bật trust proxy.
- **Chỉ 1 replica** cho tới khi xong DEBT-278.
- Rate limit `/auth/login` ở proxy (DEBT-284).
- Healthcheck `/healthz` là liveness, không phải readiness (DEBT-378).
- Header của asset.
- Thoát khi env lỗi (log chỉ có tên biến).
- `docker stop` graceful 5 s.
- Cách cập nhật digest base image (`docker buildx imagetools inspect`, tuổi ≥ 14 ngày).

**Debt đóng khi xong**: DEBT-370 (phần giới hạn body), DEBT-374, DEBT-368, DEBT-362, DEBT-264.

### Cổng security (tester/senior kiểm)

| Hạng mục | Nội dung |
|---|---|
| Tài sản | `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, cookie phiên, server bundle |
| Trust boundary | internet → proxy TLS → container `:3000`. Docker build context → image layers |
| Invariant: không secret trong image | Không có `.env`/PEM ở cả build stage lẫn runtime; không có trong `history`/Env |
| Invariant: không chạy root | User 1000, rootfs read-only vẫn chạy được |
| Invariant: env lỗi thì thoát | Log chỉ có tên biến |
| Invariant: header | Mọi response có `nosniff`, kể cả asset, 404, 413, 500 |
| Abuse: body lớn/chunked | DoS bộ nhớ qua zod ⇒ 413/411 trước handler |
| Abuse: traversal | Không lộ `dist/server` hay `package.json` |
| Abuse: Host/X-Forwarded giả | Không ảnh hưởng URL tuyệt đối (dựng từ `APP_URL`, trust-proxy tắt) |
| Abuse: probe healthz | Không lộ version/dependency |
| Failure semantics | Redis/IdP chết ⇒ 503 theo request, healthz vẫn 200 (liveness). env lỗi ⇒ fail-closed bằng exit 1. SIGTERM ⇒ đóng trong ≤ 5 s |
| Exposure | Response lỗi dùng text cố định; log không có giá trị env/secret/stack trong body |
