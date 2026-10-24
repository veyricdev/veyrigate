# Log — run 53b

- orchestrator: mở run từ "Kế hoạch 53b" (tech-lead fold run 53), gộp DEBT-384/385; không gọi lại tech-lead.

## backend-dev — 2026-10-24 — Task 1–3 xong (đề nghị → senior-reviewer)

- **Trust boundary**: tài sản = token Vault của app, mật khẩu Mongo, `CSRF_SECRET`, `be/.env`/`be/keys` trên máy build. Image không nhận secret lúc build (allowlist `be/Dockerfile.dockerignore`, runtime chỉ copy `package.json`+`node_modules`+`dist` đã lọc). Fail-closed: thiếu env / `KEY_PROVIDER=local` ở production ⇒ thoát 1 trước khi listen, log chỉ tên biến. Smoke đưa token Vault vào tmpfs qua stdin (không env/argv/file host), mọi secret sinh mỗi lần, `::add-mask::` trong CI.
- **T1**: `be/Dockerfile` (base giữ `node:22.23.2-bookworm-slim@sha256:48e4b6…f0f9`: 22.23.3 không security, 22.23.4 security mới 4 ngày ⇒ bump 2026-11-03, ghi DEBT-379), `Dockerfile.dockerignore`, `be/scripts/docker-smoke.sh` 11 check, CI job `be-image` (build stage + runtime, không push). Image phụ trợ (kiểm `tag_last_pushed` Docker Hub + `buildx imagetools inspect`): `mongo:7.0.43@sha256:1f995ad6…7a7b` (push 2026-10-02), `redis:7.4.10-bookworm@sha256:e9b2e45e…4f73` (push 2026-08-05; 7.4.11 bị push lại 2026-10-21 nên không dùng), Vault 2.1.2 như run 53 (dev `-dev-tls`, cert có SAN hostname container). **Khác plan**: `docker stop` khi Redis đang chết ⇒ 137 (`redis.quit()` treo) ⇒ smoke bật lại Redis trước check 8, mở **DEBT-397**; `pnpm deploy` copy cả `be/.env` vào `/deploy` nếu lọt context (mutation thấy) ⇒ allowlist là lớp chặn chính.
- **Mutation (Docker, khôi phục sha256 khớp)**: bỏ `USER` ⇒ check 1 đỏ; bỏ `HEALTHCHECK` ⇒ check 2 đỏ (`none`); bỏ `**/.env*` ⇒ check 6 đỏ (build stage thấy `/repo/be/.env`, `/deploy/.env` — chỉ in tên, image xoá ngay); bỏ cả 2 chặn local-ở-prod (zod + `keys.module`) ⇒ check 10 đỏ (app sống, timeout).
- **T2**: DEBT-385 (`**/.env*`, `*.key|p12|pfx`, `.npmrc`; probe 3 file: cũ lọt 3, mới 0) + DEBT-384 (`await server.ready()` ⇒ exit 1 + mã lỗi). Test mới `serve-mjs-risk` "port already in use" RED (exit 0) → GREEN; smoke fe-admin **14/14** (13 cũ + check 14 `HOST=192.0.2.1` ⇒ exit 1 EADDRNOTAVAIL; RED với `serve.mjs` cũ). **T3**: runbook-deploy §9 (BE image) + 1 dòng §7.
- **Verify**: be typecheck/lint/build 0; be unit 475/475 (lần đầu ngay sau build: 1 fail không rõ tên, 3 lần chạy lại 475/475 — flaky, không truy được); `test:int` 1221/1221 (45 suite); root `pnpm lint` 0, `pnpm -r run typecheck` 0, root `pnpm test` 0 (be 475, fe-admin 64 file/1416, fe-sso-test 269); `pnpm audit --audit-level high` 0 (1 high ignore sẵn). E2E không chạy (không đổi code runtime BE). Grep `hvs.`/private key trên output + file mới: 0. `be/keys` sha256/mtime không đổi.
- **Docker**: chỉ mạng `vg-b73b-net`, container `vg-b73b-{mongo,redis,vault}`, `vg-be-smoke-{ok,noenv,local}`, `vg-fea-smoke-*` (trap xoá); image `veyrigate-be:smoke-run53b[-build|-mut|-mut-build]`, `veyrigate-fe-admin:smoke-run52[-build|-mut]`. Không prune/compose/push.

## senior-reviewer — 2026-10-24 — PASS

- Review `be/Dockerfile`, `Dockerfile.dockerignore`, `be/scripts/docker-smoke.sh`, CI `be-image`, fe-admin `serve.mjs`/ignore (DEBT-384/385), runbook §9. Không 🔴. Lớp thứ hai cho `.env` ở runtime đã có (copy chọn lọc từ `/deploy`, `/app` root-owned); build stage chưa tự chặn ⇒ mở **DEBT-398** (🟡, `RUN ! find … | grep .` sau `COPY be/ be/`; rủi ro qua cache export `mode=max`). Wrapper entrypoint của smoke tương đương `CMD` (💭 volume token để chạy `CMD` gốc). DEBT-397 mức 🟡 đúng. Ponytail: Lean already.
- Đã chạy: `bash -n` 2 smoke script OK; fe-admin `serve-mjs-risk` 32/32; fe-admin lint 0. Không build/run Docker, không E2E. `be/src` không đổi.
- → **tester**.

## tester — 2026-10-24 — PASS

- Build lại từ working tree: `veyrigate-be:smoke-run53b` (+ `-build`) ⇒ `be/scripts/docker-smoke.sh` **11/11**; `veyrigate-fe-admin:smoke-run52` ⇒ smoke **14/14**.
- Probe độc lập (scratchpad, không file repo): history `--no-trunc` grep rộng 0 (runtime + build), Labels null, Env 5 biến; build context thật (bản sao ignore) không có `be/.env`/`be/keys`; runtime chạy `CMD` gốc với `--read-only --cap-drop ALL --no-new-privileges`: CapEff 0, NoNewPrivs 1, PID 1 `node dist/main.js`, ghi `/app/.env` bị từ chối; Redis down ⇒ `/health` 200, `/ready` 503, container sống; DEBT-397 tái hiện (stop khi Redis down ⇒ **137** sau 18 s; Redis sống ⇒ 0 sau 1 s), giữ 🟡. `NODE_ENV=development` crash vì thiếu `pino-pretty` ⇒ xác nhận dev deps bị loại.
- Host: be typecheck/lint/build 0; be unit 475/475 × 3 (không tái hiện flake); fe-admin 64/1416; root lint 0, `-r typecheck` 0, `pnpm test` 0 (475/1416/269); audit high 0. `be/keys` sha256/mtime không đổi; grep secret output 0.
- Mở **DEBT-399** 🟢 (image BE 505 MB; `typescript` 22,6 MB vào runtime qua `@nestjs/swagger`, swagger-ui-dist, npm/yarn trong base). Nit: `be/scripts` vào build context (không secret).
- Dọn: không còn container/mạng `vg-b73b-*`/`vg-be-smoke-*`/`vg-fea-smoke-*`; image `-ctx` đã rmi; giữ image smoke. Xem `test-report.md`.
