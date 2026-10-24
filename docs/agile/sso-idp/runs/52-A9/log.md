# Log — run 52 — A9 Dockerfile + deploy fe-admin (+ DEBT-370/374)

## tech-lead — 2026-10-24

**Kết luận: PASS (có fold).** Đối chiếu code `6df705a`, build `fe-admin/dist` thật và `node_modules` thật (start-plugin-core 1.171.49, start-client-core 1.170.34, srvx 0.11.22). Fold ở cuối `tasks.md`, review ở `review-techlead.md`.

- **Q-52.1**: `dist/server/server.js` = `export default { fetch }`, không listener; asset `dist/client/assets`. Chốt `fe-admin/serve.mjs` dùng API `srvx` (dep trực tiếp 0.11.22, đã có trong lockfile), không dùng CLI srvx (tự nạp `.env`, static bỏ qua header). Asset `/assets/*`: nosniff + immutable (đóng DEBT-362/264). Self-check `/healthz` lúc boot ⇒ env lỗi thì exit 1.
- **Q-52.2**: `/healthz` liveness trong `server.ts` (không Redis/IdP); không `/ready` (DEBT-378).
- **Q-52.3**: Docker Desktop 4.49.0 / Engine 28.5.1 có sẵn. Tên tạm: image `veyrigate-fe-admin:smoke-run52[-build]`, container `vg-fea-smoke-{ok,noenv,http}`, cổng `127.0.0.1:3300`; dọn bằng tên chính xác, cấm prune/filter/compose.
- **Base image**: `node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9` (Node 22.23.2 ngày 2026-07-28, khớp `.nvmrc`).
- **Sửa thực tế trong tasks**: env lỗi hiện KHÔNG thoát (trả 500 mọi request); prod bắt buộc https nên không đăng nhập được với BE E2E http (⇒ DEBT-375, không thêm cờ nới lỏng). Gộp DEBT-368.
- **A8**: đủ theo plan (unit/component + E2E login/tạo client/audit/step-up trong CI). Thiếu E2E trên build prod/image ⇒ DEBT-375; smoke image (CI job `fe-admin-image`) bù một phần.
- **B7.3**: chưa làm (`be/Dockerfile` không tồn tại), không gộp.
- **Debt mới**: DEBT-375…380.
- **Không** sửa code, không build/run Docker (chỉ `docker version`/`ps`/`buildx imagetools inspect`), không chạy E2E.

## frontend-dev — 2026-10-24

- **T1**: `server/body-limit.ts` (400/411/413, 64 KiB, mọi method ≠ GET/HEAD/OPTIONS) gọi trong `server.ts`; `signingOutUntil` 10 s, bỏ `pageshow` (sửa thêm `step-up.test.tsx` vốn dựa vào `pageshow`); `withSecurityHeaders` bắt throw ⇒ 500 có header. Test mới `server-entry.test.ts`. Mutation: bỏ 413 ⇒ 2 đỏ, hạn `Infinity` ⇒ 3 đỏ, bỏ catch ⇒ 2 đỏ; khôi phục sha256 khớp.
- **T2**: `/healthz` GET/HEAD; **lệch fold**: `/assets/*` lọt vào app trả 404 text ngay trong `server.ts` (đi router thì guard trả 307 login, smoke check 6 đỏ). `serve.mjs` (srvx API, self-check, assets nosniff+immutable, không trust proxy) + `server.node.server.once("close", exit 0)` vì ioredis giữ event loop ⇒ `docker stop` 137 (DEBT-383). Dep `srvx` 0.11.22: diff lockfile chỉ 3 dòng importer, `pnpm install --offline`. `pnpm deploy --prod` chạy thẳng trên pnpm 12 (không cần inject), rồi chỉ copy `package.json`+`node_modules` (+`dist`,`serve.mjs`). Digest base kiểm lại = `sha256:48e4b6…f0f9` (không đổi). CI job `fe-admin-image`.
- **T3**: smoke 13/13 (dưới). Build stage `find .env*` ⇒ 0 (máy có `fe-admin/.env` thật). Mutation docker: bỏ `USER` ⇒ check 1 đỏ; bỏ self-check ⇒ check 11 đỏ (timeout); bỏ header asset ⇒ check 5 đỏ; bỏ `fe-admin/.env*` khỏi ignore ⇒ build stage thấy `/repo/fe-admin/.env` (chỉ in tên), xoá image ngay. Cả 4 file khôi phục sha256 khớp. Runbook §7.
- **Verify**: fe-admin typecheck/lint/build/`check:bundle` (0 hit)/`gen:api` (không diff) xanh; root `pnpm lint`, `pnpm -r run typecheck` exit 0; root `pnpm test` exit 0 (be 416, fe-admin 62 file/1369, fe-sso-test 269); `pnpm audit --audit-level high` exit 0; E2E full (cổng trống, không `E2E_REUSE`) 35/35, 4.6 m. Grep pattern secret trên log test/E2E + file mới: 0 (script chỉ có biến sinh lúc chạy).
- **Docker đã tạo/dọn**: image `veyrigate-fe-admin:smoke-run52`, `:smoke-run52-build`; container `vg-fea-smoke-{ok,noenv,http}` (trap). Cuối: `docker ps -a | grep vg-fea-smoke` rỗng, `docker images | grep smoke-run52` rỗng, không có image `<none>` sót. Không prune/compose/push.
- **Debt**: đóng DEBT-370 (phần body), 374, 368, 362, 264; mở DEBT-381 (POST rỗng không CL ⇒ 411), 382 (`maxRequestBodySize` srvx chưa bật), 383 (`process.exit` thay vì đóng Redis).

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

## senior-reviewer — 2026-10-24

- **Kết luận: PASS** (0 🔴). Review ở `review-senior.md`. Chuyển **tester**.
- Đã kiểm: Dockerfile + dockerignore (allowlist, digest, non-root, file thuộc root, exec CMD, HEALTHCHECK, `pnpm deploy --prod` chỉ copy `package.json`+`node_modules`); `serve.mjs` + mã srvx 0.11.22 (`static.mjs` join + `startsWith(dir)`, Host sai ⇒ `_invalid_`, `trustProxy` tắt, graceful shutdown); body-limit (thứ tự 411/400/413, CL+TE/nhiều CL do llhttp); `/healthz`; `/assets/*` 404 lệch fold là đúng; catch DEBT-368; cờ đăng xuất 10 s; smoke script; CI job; runbook §7.
- `process.exit(0)` (DEBT-383): chỉ chạy khi `close` (mọi connection đã đóng). Request đang chạy được chạy hết (≤ 5 s). Không thấy ghi Redis fire-and-forget/`waitUntil` ⇒ không cắt ngang ghi session trong đường bình thường.
- Chạy lại: fe-admin typecheck/lint exit 0; test 62 file/1369 xanh; build exit 0; `check:bundle` 0 hit; không có `*.map`. Không build/run Docker, không E2E.
- Debt mới: DEBT-384 (listen lỗi ⇒ exit 0 im lặng), DEBT-385 (dockerignore `**/.env*`/key khác), DEBT-386 (ponytail ~5 dòng).

## tester — 2026-10-24

- **Kết luận: PASS.** Chi tiết + output ở `test-report.md`.
- Cổng: fe-admin typecheck/lint/build/`check:bundle` (0 hit)/`gen:api` (không diff) exit 0; root `pnpm lint`, `pnpm -r run typecheck` exit 0; root `pnpm test` exit 0 (be 416, fe-admin 64 file/1415, fe-sso-test 269); `pnpm audit --audit-level high` exit 0; E2E full 35/35 (3.9 m, cổng trống, không `E2E_REUSE`).
- Docker: build `veyrigate-fe-admin:smoke-run52`, smoke 13/13 (xem test-report D1). Dọn: container `vg-fea-smoke-*` đã được trap xoá, image xoá đúng tên; `docker ps -a | grep vg-fea-smoke` rỗng, `docker images | grep smoke-run52` rỗng, dangling 0. Không prune/compose/push.
- Test mới: `fe-admin/test/serve-mjs-risk.test.ts` (31: `serve.mjs` thật trên fixture, 21 traversal, method trên `/assets`, header asset, self-check exit 1 không lộ canary), `fe-admin/test/body-limit-risk.test.ts` (15: biên CL). Mutation `serve.mjs` (3), `body-limit.ts` (2), `query-client.ts` (`Infinity`) đều đỏ; khôi phục sha256 khớp.
- Probe `serve.mjs` + dist thật: healthz không chạm Redis; traversal 0 leak; CL lạ/trùng/CL+TE ⇒ 400 của parser Node; cổng bận ⇒ exit 0 im lặng (DEBT-384, giữ 🟡).
- Debt mới: **DEBT-387** 🟡 (308 `Location` tuyệt đối từ `Host` cho path `//`).
- Không sửa code sản phẩm/config/lockfile/Dockerfile; không commit.
