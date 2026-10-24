# Tech Lead Review — 2026-10-24 (run 52, A9 + DEBT-370/374)

## Kết luận: PASS (có fold)

Fold ràng buộc cụ thể ở cuối `tasks.md` ("Fold tech-lead (2026-10-24)"). Fold ưu tiên hơn text gốc khi mâu thuẫn. Giao **frontend-dev** cả 3 task, thứ tự 1 → 2 → 3. Không có [BE].

Đã đối chiếu code thật ở HEAD `6df705a`:
- fe-admin: `src/{server.ts,start.ts}`, `src/server/{env,security-headers,unavailable}.ts`, `src/server/auth/bff.ts` (`login`, `handleCallback`, `sameOrigin`, `liveSession`), `src/routes/__root.tsx`, `src/features/auth/viewer.ts`, `src/features/admin-api/{query-client,step-up}.ts`, `package.json`, `vite.config.ts`, `.env.example`, build thật `dist/server/server.js` + `dist/client/assets`.
- Thư viện (node_modules thật): `start-plugin-core@1.171.49` `vite/preview-server-plugin/plugin.js`, `start-client-core@1.170.34` `createCsrfMiddleware` (bản đã bundle), `srvx@0.11.22` (`cli.mjs`, `static.mjs`, `_chunks/_plugins.mjs`, `_chunks/_utils2.mjs`).
- Repo: `pnpm-workspace.yaml`, root `package.json` (pnpm 12.6.0), `.nvmrc` (v22.23.2), `.gitignore`, `.github/workflows/ci.yml`, `e2e/playwright.config.ts`, `e2e/tests/*`.
- Môi trường (chỉ đọc): `docker version` cho ra 28.5.1 / Desktop 4.49.0; `docker ps -a`; `docker buildx imagetools inspect node:22.23.2-bookworm-slim` (đọc registry, không pull); `nodejs.org/dist/index.json`; `pnpm view srvx time`.

## Trả lời câu hỏi

### Q-52.1: Build output, entry Node, asset tĩnh và header

**Build output**
- `vite build` sinh `dist/server/server.js`. File này `export default` một object `{ fetch }` (Web Fetch handler, đã bọc bởi `src/server.ts`) và **không mở cổng**.
- Asset client nằm ở `dist/client/assets/*` (tên có hash). Không có `index.html` (SSR).
- `vite preview` (plugin `preview-server`) chỉ import `server.js` rồi gọi `fetch` qua `srvx/node`. Nó cần devDependencies nên không dùng cho production.

**Import runtime còn lại (external)**
- Từ `server.js` và `assets/*`: `react`, `react/jsx-runtime`, `@tanstack/react-router` (+`/ssr/server`), `@tanstack/react-query`, `@tanstack/react-form`, `zod`, `@t3-oss/env-core`, `ioredis`, `jose`, `radix-ui`, `sonner`, `clsx`, `class-variance-authority`, `tailwind-merge`, `lucide-react`.
- Tất cả đều thuộc `dependencies` của fe-admin. Phần `start-server-core`/h3 đã được bundle sẵn.
- ⇒ Runtime cần `node_modules` prod của fe-admin. fe-admin không phụ thuộc package workspace nào.

**Header hiện tại**: A7 (`withSecurityHeaders`) chỉ áp cho response đi qua `server.ts`. Asset tĩnh do host phục vụ nên **không có header** (DEBT-362).

**Không dùng CLI `srvx`.** Đã đọc `srvx@0.11.22/dist/cli.mjs`:
1. CLI tự nạp `.env` + `.env.production` từ cwd (dòng 271). Một file `.env` lọt vào image sẽ âm thầm thành cấu hình.
2. `serveStatic` chạy **trước** fetch của app, nên asset không có `nosniff`/cache.
3. Không có bước tự kiểm lúc khởi động.

**Quyết định**: thêm file `fe-admin/serve.mjs` (ESM thuần, không qua bundler, khoảng 60 dòng) dùng API lập trình của `srvx` (`serve`, `srvx/static`):
- Thêm `"srvx": "0.11.22"` vào `dependencies` của fe-admin. Bản này phát hành 2026-07-11 (≥ 14 ngày) và đã có trong lockfile (transitive qua start-plugin-core), nên không resolve bản mới.
- Chỉ phục vụ `GET|HEAD /assets/*` từ `dist/client`, kèm `nosniff` + `cache-control: public, max-age=31536000, immutable`. Mọi đường khác đi vào app và nhận header A7. Điều này đóng DEBT-362 và DEBT-264.
- Tự kiểm lúc boot: gọi `app.fetch(GET /healthz)`. Khác 200 thì `exit 1`. Khi env lỗi, `server.ts` đã trả 500 cho mọi request, nên container **thoát** thay vì sống mà hỏng.
- Shutdown: dùng `gracefulShutdown` của srvx (SIGTERM, 5 s).
- Bind: `HOST`/`PORT` từ env (srvx `resolvePortAndHost`).
- **Không bật** trust-proxy của srvx. BFF dựng URL tuyệt đối từ `APP_URL` (đã kiểm `bff.ts` `login`/`handleCallback`: chỉ đọc `searchParams` của `request.url`).

### Q-52.2: Healthcheck

- Dùng `GET|HEAD /healthz`, đặt trong `src/server.ts`: bên trong `withSecurityHeaders`, sau nhánh `envValid`, trước giới hạn body và router.
- Trả `200`, body đúng 2 byte `ok`, `text/plain`, `no-store`.
- Không chạm Redis, IdP, session hay router. Không lộ version/build/tên dependency.
- **Không làm `/ready` riêng trong run này.**
  - Redis/IdP chết đã trả 503 theo từng request (`withUnavailableStatus`).
  - Readiness gắn Redis sẽ khiến orchestrator rút mọi instance khi Redis dùng chung chập chờn: từ "giảm chức năng" thành "sập hẳn".
  - Hiện chỉ chạy 1 instance (DEBT-278).
  - Ghi thành DEBT-378.

### Q-52.3: Docker trên máy

- **Có**: Docker Desktop 4.49.0, Engine 28.5.1, BuildKit mặc định, context `desktop-linux`.
- Container đang có: `aegate-*`, `vg-test-*`, `veyrigate-*-1`, `sso-test-*`, `funny_pascal`, `mysql-db`. **Không được đụng.**
- Được phép build/run, chỉ với tên tạm:
  - image `veyrigate-fe-admin:smoke-run52` và `veyrigate-fe-admin:smoke-run52-build`;
  - container có tiền tố `vg-fea-smoke-`;
  - cổng host `127.0.0.1:3300` (tránh 3000 của dev/E2E, 5173 của tiptap).
- Dọn bằng tên chính xác: `docker rm -f <tên>`, `docker image rm <tag>`. **Cấm** `docker system/image/container prune`, xoá theo `--filter`/wildcard, `compose up/down`.
- Container smoke **không** nối tới Redis/Mongo trên host. `SESSION_REDIS_URL=redis://127.0.0.1:1/0` trỏ vào chính container nên bị từ chối ngay.

## Xác nhận A8 (plan §6)

Plan yêu cầu: "đăng nhập → tạo client → xem audit → step-up", chạy trong CI có BE + Mongo + Redis.

**Đã đủ**
- Unit/component: 61 file, 1349 test.
- E2E:
  - `fe-admin.spec.ts`: login/logout BFF.
  - `fe-admin-clients.spec.ts`: tạo client + step-up.
  - `fe-admin-audit.spec.ts`.
  - `admin-client.spec.ts`: step-up 403 ⇒ re-auth.
  - Cùng các spec risk/hardening.
- Job `e2e` trong `ci.yml` chạy toàn bộ.

**Thiếu (không gộp vào run này)**
- E2E chạy fe-admin bằng `vite dev` (`e2e/playwright.config.ts:65`), **chưa bao giờ** chạy trên build production/image.
- Build prod bắt buộc URL `https` (`env.ts` `isProduction` = `import.meta.env.PROD`). BE E2E lại là `http://localhost:4000`.
- Vì vậy luồng đăng nhập thật trên image cần TLS terminator. Phần này vượt cỡ S ⇒ DEBT-375.
- Run này bù một phần bằng smoke image (Task 3): healthcheck, redirect của guard, header của asset, 413, env lỗi thì thoát, kiểm vệ sinh image. Smoke cũng chạy trong CI.

## Kiến trúc đề xuất

- Giữ nguyên: một container Node cho BFF, đặt sau reverse proxy TLS. Không thêm Nitro/adapter.
- Thêm đúng 4 file:
  - `fe-admin/serve.mjs`
  - `fe-admin/Dockerfile`
  - `fe-admin/Dockerfile.dockerignore` (BuildKit đọc file ignore riêng của Dockerfile, không đụng `.dockerignore` gốc mà B7.3 sẽ cần)
  - `fe-admin/scripts/docker-smoke.sh`
- Thêm 1 job CI `fe-admin-image`.
- Không có Dockerfile BE: B7.3 chưa làm, `be/Dockerfile` không tồn tại. Không gộp vào run này. Khuôn fe-admin sẽ được tái dùng.

## Điểm mạnh

- Phạm vi gọn, đúng plan (A9 cỡ S) và gom đúng 2 debt nhỏ cùng vùng code.
- Hạ tầng đã có sẵn ranh giới rõ: env fail-closed chỉ log tên biến, header A7 ở server entry, CSRF fail-closed, 503 khi phụ thuộc chết.
- `tasks.md` đã cấm compose up/push, đúng ràng buộc hạ tầng.

## Vấn đề (đã fold, không REJECT)

- [x] Text Task 3 "trỏ BE E2E ⇒ trang login redirect đúng" **không khả thi**: prod build bắt buộc `https`. Thay bằng: guard `/` redirect tới `/auth/login?returnTo=…`; `/auth/login` với IdP không tới được trả 503 có header. Đăng nhập thật trên image ⇒ DEBT-375.
- [x] Task 2 "env bắt buộc fail-fast (đã có `server/env.ts`)" là **sai thực tế**. Hiện env lỗi làm server **sống và trả 500 mọi request**, không thoát. Đã fold self-check trong `serve.mjs`.
- [x] Task 2 chưa chỉ định entry/host Node. Đã chốt `serve.mjs` + `srvx` (Q-52.1), không dùng CLI srvx (tự nạp `.env`).
- [x] DEBT-370 chưa nêu ngữ nghĩa với body chunked hoặc `Content-Length` sai. Đã fold: 411/400/413, ngưỡng 64 KiB, áp mọi method có body.
- [x] Thiếu cổng security cho image (non-root, không secret trong layer, kiểm build stage, traversal asset, giới hạn quyền runtime). Đã fold kèm test âm + mutation.
- [x] Gộp thêm DEBT-368 (wrapper header throw ⇒ 500 của srvx không có header). Trên prod giờ srvx là host thật nên debt này có hiệu lực. Sửa nhỏ, cùng file.

## Đề xuất (không bắt buộc) ⇒ backlog DEBT-375…380

- DEBT-375: E2E/đăng nhập thật trên image prod (cần TLS).
- DEBT-376: `createCsrfMiddleware({ origin: APP_URL })`. Sau proxy TLS, nhánh `Origin` so với `request.url` (http) sẽ chặn nhầm trình duyệt không gửi `Sec-Fetch-Site`. Lỗi này fail-closed nên chỉ ảnh hưởng khả dụng.
- DEBT-377: kiểm session trước khi parse input của `/_serverFn` (phần còn lại của DEBT-370).
- DEBT-378: `/ready` khi chạy nhiều instance / orchestrator.
- DEBT-379: Node 22.23.3 (2026-09-23) đã có. Cân nhắc bump đồng bộ `.nvmrc`/engines/image và lập chính sách làm mới digest base image (Renovate/Dependabot docker).
- DEBT-380: kích thước image và CPU. `serveStatic` nén br/gzip cho từng request; `@tanstack/react-start` (nằm trong `dependencies`) kéo phần build-time vào image. Nên nén sẵn hoặc để proxy làm, và xem có chuyển react-start sang devDependencies được không.
