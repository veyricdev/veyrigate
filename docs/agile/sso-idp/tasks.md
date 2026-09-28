# Tasks — sso-idp (Phase R + B1)

Nguồn: `plan.md` §4 (Phase R) + §5.B1 (Backend foundation) + §1 (kiến trúc). Gồm **R1–R5** và **B1.1–B1.5**.
spec.md & plan.md đã có sẵn — KHÔNG ghi đè.

Trạng thái: `todo → in-progress → in-review → testing → done`.

---

## R1 — Khởi tạo monorepo pnpm workspace + script gốc `[BE]`

**Phụ thuộc**: —  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `git init` (nếu chưa) + `.gitignore` (node_modules, dist, .env, build outputs, coverage)
- [x] `.editorconfig` (utf-8, lf, indent 2 space, trim trailing whitespace)
- [x] `.nvmrc` khớp `.node-version` hiện có (`v22.23.2`)
- [x] `pnpm-workspace.yaml` gộp 3 package: `be/`, `fe-admin/`, `fe-sso-test/`
- [x] `package.json` gốc (private, packageManager pnpm) với script gốc:
  - `dev:all` — chạy song song 3 app (dùng `pnpm -r --parallel run dev` hoặc tương đương)
  - `lint` — `pnpm -r run lint`
  - `typecheck` — `pnpm -r run typecheck`
  - `test` — `pnpm -r run test`
- [x] Tạo thư mục placeholder `be/`, `fe-admin/`, `fe-sso-test/` (đủ để workspace nhận diện; scaffold thực ở B1.1/A1/T1)
- [x] `README.md` khung (mô tả monorepo + link docs/agile/sso-idp)

### Nghiệm thu (plan §4)
- `pnpm i` ở gốc chạy được với 3 package (kể cả khi package con mới có `package.json` tối thiểu)
- `pnpm dev:all` chạy song song 3 app (khi các app đã có script `dev`); ở giai đoạn này chấp nhận placeholder script `dev` in ra thông báo
- `lint`/`typecheck`/`test` gốc fan-out xuống package con không lỗi cấu hình

### Ghi chú
- Tên thư mục `be/`, `fe-admin/`, `fe-sso-test/` theo đề xuất plan §1.1.
- KHÔNG scaffold NestJS/TanStack/React ở task này (đó là B1.1/A1/T1). Chỉ dựng khung workspace + script gốc.

---

## R2 — `docker-compose.yml` (mongo, redis, mailpit) + healthcheck `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done (case "3 service healthy" PENDING — cần Docker host)

### Việc cần làm
- [x] `docker-compose.yml` với 3 service (pin version image theo plan §1.3):
  - `mongo` (mongo:7): port `27017:27017`, volume `mongo_data:/data/db`, healthcheck `mongosh ping`
  - `redis` (redis:7): `--appendonly yes`, port `6379:6379`, volume `redis_data:/data`, healthcheck `redis-cli ping`
  - `mailpit` (axllent/mailpit:v1.21): port SMTP `1025:1025`, UI `8025:8025`
- [x] `volumes: { mongo_data, redis_data }`
- [x] Profile `full` để (sau này) chạy `be` từ `be/Dockerfile`, depends_on mongo+redis healthy — khai báo khung, không cần Dockerfile ở task này
- [x] Ghi chú trong README: URL/port dev theo plan §1.2 (mongo `27017`, redis `6379`, mailpit UI `8025`)

### Nghiệm thu (plan §4)
- `docker compose up -d` → 3 service `mongo`/`redis`/`mailpit` đạt trạng thái healthy
- `docker compose ps` cho thấy healthcheck pass
- (BE kết nối được — sẽ kiểm chứng khi có B1.4; ở task này chỉ cần service healthy)

### Ghi chú
- Spec chỉ dùng `findOneAndUpdate` trên 1 document → KHÔNG cần replica set/transaction (plan §1.3).
- Không commit secret; compose dev không chứa credential thật.

---

## R3 — Agent workspace `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done

> ⚠️ **Điều chỉnh so với plan §4**: plan R3 giả định `docs/spec.md`, `docs/plan.md`, root `PROGRESS.md`, `.claude/agents/*`.
> Thực tế repo đã áp dụng layout khác và ĐÃ TỒN TẠI:
> - Spec/plan nằm ở `docs/agile/sso-idp/spec.md` + `plan.md` (KHÔNG phải `docs/spec.md`) — KHÔNG di chuyển/nhân đôi.
> - Agents nằm ở `.github/agents/*.agent.md` (analyst, tech-lead, backend-dev, frontend-dev, senior-reviewer, tester, orchestrator) + `HANDOFF-PROTOCOL.md` — KHÔNG tạo lại ở `.claude/agents/`.
> - Progress log theo tính năng: `docs/agile/sso-idp/_progress.md` + `_handoff.md` (thay cho root `PROGRESS.md`).
> → R3 chỉ còn **xác minh + tài liệu hoá** workspace agent, không dựng lại.

### Việc cần làm
- [x] Xác minh 7 agent tồn tại ở `.github/agents/` và mỗi agent có chỉ dẫn "đọc spec trước" (đối chiếu HANDOFF-PROTOCOL)
- [x] Nếu agent nào thiếu dòng "đọc `docs/agile/sso-idp/spec.md` trước khi làm" → bổ sung (surgical, chỉ thêm 1 dòng, không đổi hành vi khác) — KHÔNG cần thêm: cả 7 agent đã trỏ spec trong `docs/agile/<slug>/`
- [x] Ghi rõ trong README gốc (mục "Agent workspace") vị trí thực tế của spec/plan/agents/progress để không nhầm với đường dẫn trong plan §4

### Nghiệm thu (điều chỉnh từ plan §4)
- 7 agent tồn tại, mỗi agent trỏ đúng nguồn sự thật (spec ở `docs/agile/sso-idp/`)
- README nêu rõ layout agent workspace thực tế; không có file agent trùng lặp ở `.claude/agents/`

### Ghi chú
- KHÔNG tạo `docs/spec.md`/`docs/plan.md`/root `PROGRESS.md` mới (tránh nhân đôi nguồn sự thật).

---

## R4 — CI GitHub Actions `[BE]`

**Phụ thuộc**: R1  ·  **Size**: M  ·  **Trạng thái**: done

### Việc cần làm
- [x] `.github/workflows/ci.yml`:
  - Trigger: `push` + `pull_request` vào nhánh chính (`develop`/`main`)
  - Setup Node theo `.nvmrc` + `corepack enable` (pnpm), cache pnpm store
  - Job `quality`: `pnpm i --frozen-lockfile` → `pnpm lint` → `pnpm -r run typecheck` → `pnpm test` (fan-out, `--if-present` để không đỏ ở giai đoạn placeholder)
  - Job `e2e` (khung): service container `mongo:7` + `redis:7` với healthcheck; hiện tại chưa có test e2e → đánh dấu placeholder/skip rõ ràng, sẽ bật khi có B7.1/X1
- [x] Concurrency group để huỷ run cũ khi push mới
- [x] Ghi chú "chặn merge nếu đỏ" → cần bật branch protection ở GitHub (ngoài repo, ghi vào README)

### Nghiệm thu (plan §4)
- Workflow YAML hợp lệ (validate cú pháp); job `quality` chạy được `pnpm i --frozen-lockfile` + lint/typecheck/test không lỗi cấu hình
- Job `e2e` khai báo service mongo/redis với healthcheck đúng cú pháp
- Thời gian job hợp lý (cache pnpm)

### Ghi chú
- Không chạy được GitHub Actions cục bộ → verify = validate cú pháp YAML + đối chiếu lệnh với script gốc đã pass ở R1. Branch protection do người dùng bật trên GitHub.

---

## R5 — Quy ước secret + README chạy-trong-5-phút `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `.env.example` cho từng package theo plan §1.4 (KHÔNG chứa secret thật, chỉ tên biến + giá trị mẫu/placeholder):
  - `be/.env.example`: `NODE_ENV, PORT, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER, KEY_LOCAL_DIR, SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_*`
  - `fe-admin/.env.example`: server (`OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL`) + client (`VITE_*`)
  - `fe-sso-test/.env.example`: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`
- [x] Pre-commit secret scan (gitleaks): `.pre-commit-config.yaml` gốc dùng hook gitleaks (config mặc định); ghi hướng dẫn cài `pre-commit install` vào README
- [x] README gốc: mục "Chạy local trong 5 phút" (clone → cp .env.example → pnpm i → docker compose up -d → pnpm dev:all)

### Nghiệm thu (plan §4)
- Clone mới → làm theo README chạy được (đối chiếu các lệnh đã pass ở R1/R2)
- Commit chứa secret bị chặn (verify gitleaks bằng cách chạy `gitleaks detect`/pre-commit thử nếu công cụ có sẵn; nếu không có, validate cú pháp config)

### Ghi chú
- `.env.example` KHÔNG phải secret → được commit; `.env` thật đã bị `.gitignore` loại (R1).
- Danh sách biến bám plan §1.4; giá trị mẫu dùng localhost/placeholder.

---

# Phase B — Backend foundation (M1)

Nguồn: `plan.md` §5.B1 (bảng B1.1–B1.10) + spec §5 (cấu trúc thư mục) + §13 (bước 1–3). Lần chạy này: **B1.1–B1.5**.
Các task B1.6–B1.10 (schema/audit/rate-limit/keys/mailer) chạy ở nhóm sau.

Trạng thái: `todo → in-progress → in-review → testing → done`.

---

## B1.1 — Scaffold NestJS + FastifyAdapter (TS strict) `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] Scaffold NestJS trong `be/` (thay placeholder), dùng `@nestjs/platform-fastify` (FastifyAdapter), **không** dùng Express
- [x] `tsconfig.json` **strict** (`strict: true`, `noImplicitAny`, `strictNullChecks`, …)
- [x] ESLint + Prettier (khớp `.editorconfig` gốc: lf, 2 space)
- [x] Cấu trúc thư mục theo spec §5: `src/{config,common,database,modules}` với module rỗng (chưa có logic) đủ để build
- [x] Script `be/package.json`: `dev` (`start:dev`), `build`, `lint`, `typecheck`, `test` — thay các placeholder echo

### Nghiệm thu (plan §5.B1)
- `pnpm --filter @sso-idp/be start:dev` (hoặc `dev`) chạy, app bootstrap qua FastifyAdapter
- Không còn dependency Express trong `be/`
- `pnpm --filter @sso-idp/be typecheck` + `lint` EXIT=0

---

## B1.2 — Config module fail-fast (zod/joi) `[BE]`

**Phụ thuộc**: B1.1  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `src/config/validation.schema.ts` (zod hoặc joi) validate env theo `be/.env.example` (§1.4)
- [x] `src/config/configuration.ts` typed config + ConfigModule
- [x] Fail-fast: thiếu/sai env → app KHÔNG khởi động, log rõ biến nào sai

### Nghiệm thu (plan §5.B1)
- Thiếu/sai env → app crash lúc bootstrap, thông báo rõ biến lỗi
- Config có kiểu (typed), không dùng `process.env` rải rác trong code

---

## B1.3 — Logging Pino + redact + /health + /ready + helmet + ValidationPipe + exception filter OAuth + graceful shutdown `[BE]`

**Phụ thuộc**: B1.2  ·  **Size**: M  ·  **Trạng thái**: done

### Việc cần làm
- [x] Pino logger + **redact** (`password, token, code, secret, cookie, authorization`) + request-id
- [x] `/health` (liveness) và `/ready` (check mongo+redis — đỏ khi 1 trong 2 down)
- [x] `helmet`
- [x] Global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`)
- [x] Exception filter trả lỗi **chuẩn OAuth** (`error`, `error_description`)
- [x] Graceful shutdown (đóng mongo/redis sạch)

### Nghiệm thu (plan §5.B1)
- INV-20: test xác nhận log KHÔNG chứa giá trị nhạy cảm (redact hoạt động)
- `/ready` đỏ khi Redis/Mongo down; `/health` xanh khi app sống
- Lỗi validation/exception trả đúng format OAuth

---

## B1.4 — Mongo (Mongoose) + Redis (ioredis) + Lua loader `[BE]`

**Phụ thuộc**: B1.2  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `src/database/mongo/` — Mongoose connection module (retry, đóng sạch khi shutdown)
- [x] `src/database/redis/` — ioredis connection module
- [x] Loader cho **Lua script** qua `defineCommand` (khung, script cụ thể ở B4.3/B4.5)

### Nghiệm thu (plan §5.B1)
- Kết nối mongo/redis thành công (dùng compose R2); có retry; đóng sạch khi shutdown
- Lua loader đăng ký command được (test với 1 script mẫu)

---

## B1.5 — Crypto utils (argon2, CSPRNG, sha256, constant-time, PKCE S256) `[BE]`

**Phụ thuộc**: B1.1  ·  **Size**: M  ·  **Trạng thái**: done

### Việc cần làm
- [x] argon2 hash/verify (password)
- [x] Sinh token ngẫu nhiên bằng **CSPRNG** (`crypto.randomBytes`) — KHÔNG `Math.random`
- [x] `sha256` token hash
- [x] So sánh **constant-time** (`crypto.timingSafeEqual`)
- [x] PKCE **S256** helper (verifier→challenge)

### Nghiệm thu (plan §5.B1)
- Unit test có **vector chuẩn RFC 7636** (PKCE S256 example) → pass
- Không dùng `Math.random` ở bất kỳ đâu trong crypto utils

---

## Definition of Done (áp cho R1–R5, rút gọn từ plan §10)
- Lint/cấu hình xanh; không TODO lơ lửng.
- `pnpm i` + `docker compose up -d` chạy được trên máy sạch (đã cài Docker + pnpm/Node theo `.nvmrc`).
- CI YAML hợp lệ; `.env.example` đủ biến theo §1.4; secret scan cấu hình đúng.
- Cập nhật `_progress.md` + `_handoff.md`.
