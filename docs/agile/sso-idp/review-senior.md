# Senior Review — 2026-09-28 (B1.1–B1.5)

## Kết luận: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5)

Không có 🔴 blocker. Đã đọc thật toàn bộ code `be/` liên quan, đối chiếu `spec.md` §5/§13/§15 (INV-3, INV-16, INV-20), `plan.md` §1.4/§1.5/§5.B1, `tasks.md` (Phase B), và lưu ý tech-lead. Phạm vi đúng (chỉ B1.1–B1.5, không lấn B1.6+/B2+). Có **2 điểm 🟡 nên sửa** (không chặn PASS) và vài nit.

---

## Tổng quan

Nền tảng backend chắc, kỷ luật, đúng tinh thần "foundation thuần — không rò logic OAuth/identity vào M1 sớm". Điểm mạnh nổi bật:

- **Bảo mật đúng chuẩn**: redact log phủ đủ 6 khoá INV-20 + wildcard nested + header `authorization`/`cookie`/`set-cookie` (`remove: true`); crypto util dùng CSPRNG `randomBytes` (KHÔNG `Math.random` — grep xác nhận sạch), constant-time `timingSafeEqual` có kiểm độ dài trước, argon2id params khớp baseline OWASP (m=19456 KiB, t=2, p=1).
- **PKCE S256 chuẩn RFC 7636**: dùng đúng vector Appendix B (`dBjftJeZ...` → `E9Melhoa2Owv...`), test pass; base64url không padding, ascii encoding đúng.
- **Fail-fast config typed**: zod schema + `validateEnv` báo rõ từng biến sai; config gom namespace, phần còn lại đọc qua `ConfigService`, không đụng `process.env` rải rác.
- **Cấu trúc khớp spec §5**; module domain chỉ stub `@Module({})` và **không** import vào `AppModule` (chỉ Config/Logger/Mongo/Redis/Health là thật) — đúng "rỗng đủ build".
- **Không còn Express**: `be/package.json` không có `@nestjs/platform-express`; trong lockfile nó chỉ là **optional peer** của `@nestjs/core`/`@nestjs/testing` (`optional: true`), KHÔNG được resolve/cài (grep `platform-express@[0-9]` rỗng) — đạt tiêu chí "check cả lockfile transitive" của tech-lead.
- **argon2 fallback**: chọn `@node-rs/argon2` (Rust, prebuilt) — tránh node-gyp fail trên Windows đúng khuyến nghị tech-lead §3.2, vẫn là argon2id (thoả spec §6/§13).
- Verify runtime thật đã ghi handoff: `/health` 200, `/ready` 200 (mongo+redis up), typecheck/lint/test/build EXIT=0, 10/10 test pass.

Đã tự xác minh: `get_errors` trên 6 file lõi (`main.ts`, `health.controller.ts`, `oauth-exception.filter.ts`, `config.module.ts`, `logger.module.ts`, `crypto.util.ts`) → **No errors**. Không có TODO/FIXME lơ lửng trong `src/`; không secret hardcode.

---

## B1.1 — Scaffold NestJS + Fastify (TS strict)

**PASS.** `main.ts` bootstrap qua `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())`; `tsconfig.json` strict đủ (`strict`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals/Parameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`); ESLint flat config + prettier khớp `.editorconfig`; scripts `dev/build/lint/typecheck/test` thật (thay placeholder echo). Không còn Express (pkg + lockfile). Cấu trúc `src/{config,common,database,modules}` khớp spec §5.

## B1.2 — Config fail-fast (zod) typed

**PASS** (với 1 nit — xem 🟡 #2). zod schema mirror `.env.example`/§1.4; `validateEnv` gom mọi issue và nêu tên biến → fail-fast rõ ràng. `buildConfig` trả cây config typed theo namespace. `Env` suy ra bằng `z.infer`. TTL validate là positive int (đơn vị/giá trị cuối chốt ở Q6 — đúng, không hardcode).

## B1.3 — Pino redact + /health + /ready + helmet + ValidationPipe + filter OAuth + graceful shutdown

**PASS** (với 🟡 #1). Kiểm chứng:
- **Redact (INV-20)**: đủ `password, token, code, secret, cookie, authorization` + biến thể OAuth (`access_token/refresh_token/id_token/client_secret/authorization_code`) + header `req.headers.authorization`/`req.headers.cookie`/`res.headers["set-cookie"]`, wildcard `*.field` cho nested, `remove: true`. ✓ request-id qua `genReqId` (nhận `x-request-id` hoặc sinh `randomUUID`, set lại header). ✓
- **helmet**: `app.register(helmet)` (Fastify plugin) ✓
- **ValidationPipe**: `whitelist: true, forbidNonWhitelisted: true, transform: true` global ✓
- **Exception filter OAuth**: `@Catch()` global qua `APP_FILTER` trong `AppModule`; map status→`error` code (`invalid_request/invalid_client/access_denied/temporarily_unavailable/server_error`), `error_description` từ message; lỗi non-HTTP log stack (không rò ra client). ✓
- **Graceful shutdown**: `app.enableShutdownHooks()`; Redis `quit()` trong `onApplicationShutdown`; Mongo do `@nestjs/mongoose` đóng theo shutdown hook. ✓
- **/health** 200 luôn khi process sống; **/ready** ping mongo+redis song song, 503 khi 1 trong 2 down. ✓ (chi tiết payload — xem 🟡 #1)

## B1.4 — Mongo + Redis + Lua loader

**PASS.** `MongoModule` (`MongooseModule.forRootAsync`) đọc `database.mongoUri`, `serverSelectionTimeoutMS: 5000`, `retryAttempts: 5`, `retryDelay: 1000`, log connect/error/disconnect; đóng sạch qua shutdown hooks. `RedisModule` cung cấp client ioredis chung (`maxRetriesPerRequest: null` + `retryStrategy` backoff) hợp lý cho client dài hạn; `RedisService.onApplicationShutdown` `quit()`. `lua-loader.ts` đúng **khung** (`defineCommand` qua `loadLuaScripts(client, scripts)`) — KHÔNG viết script atomic thật (đúng để dành B4.3/B4.5). `RedisService.client` getter mở đường gắn custom command sau. ✓

## B1.5 — Crypto utils

**PASS.** `hashPassword/verifyPassword` (argon2id), `generateToken` (CSPRNG `randomBytes` → base64url), `sha256` (hex), `constantTimeEqual` (`timingSafeEqual` + length guard), `deriveS256Challenge` (PKCE S256). Test: vector RFC 7636 Appendix B pass, sha256 empty-string vector, generateToken url-safe/độ dài 43, constant-time đủ nhánh. Không `Math.random`. ✓

---

## 🔴 Blocker

Không có.

## 🟡 Nên sửa (không chặn PASS — xử lý ở vòng sau hoặc khi tester xác nhận)

- [ ] 🟡 **#1 — `/ready` khi down: payload per-dependency bị filter OAuth nuốt mất.**
  `health.controller.ts:34-40` ném `ServiceUnavailableException({ status:'error', mongo:'down'|'up', redis:'down'|'up' })`, NHƯNG `OAuthExceptionFilter` (`@Catch()` toàn cục) bắt luôn exception này: status 503 → `errorCodeForStatus(503)` = `server_error`, `describe()` không thấy field `message` trong payload → trả về `exception.message` (`"Service Unavailable"`).
  ⇒ Body thực tế client nhận: `{ error: "server_error", error_description: "Service Unavailable" }` (HTTP 503), **KHÔNG** phải `{ status:"error", mongo:"down", redis:"up" }` như controller định trả.
  **Vì sao đáng lưu ý**: (a) HTTP 503 — tín hiệu ops/orchestrator then chốt — **vẫn đúng**, nên nghiệm thu "/ready đỏ khi 1 trong 2 down" ở mức status code vẫn đạt; nhưng (b) chi tiết "mongo down hay redis down" bị mất, giảm giá trị chẩn đoán; (c) endpoint hạ tầng `/ready` bị ép vào format OAuth error là **ngữ nghĩa lệch** — `/health` `/ready` không phải endpoint OAuth. Ngoài ra runtime verify trong handoff chỉ chứng minh nhánh **200** (up), chưa chứng minh nhánh **503** trả đúng cái gì.
  **Đề xuất**: cho `HealthController` dùng `@UseFilters()` với filter riêng (hoặc để filter OAuth bỏ qua route health/ready), hoặc trả 503 trực tiếp qua `reply` thay vì ném exception. Surgical, phạm vi nhỏ. Nếu chốt "chỉ cần đúng status 503" thì hạ xuống nit — nhưng nên ghi rõ quyết định.

- [ ] 🟡 **#2 — `validateEnv` chạy 2 lần lúc bootstrap (thừa).**
  `config.module.ts:19-21`: `NestConfigModule.forRoot({ validate: validateEnv, load: [() => buildConfig(validateEnv(process.env))] })`. `validate` đã parse+validate env một lần; `load` factory lại gọi `validateEnv(process.env)` lần nữa để lấy giá trị coerced. Không sai kết quả (idempotent) nhưng lặp công + hơi khó đọc; comment thừa nhận "re-parses to recover coerced values".
  **Đề xuất**: `validate` trả về `Env` đã coerce (nó có sẵn), rồi `load` đọc lại từ `ConfigService`/biến đã validate — hoặc gộp thành 1 factory `load` duy nhất tự validate. Không chặn (chỉ chạy 1 lần lúc boot), nhưng đáng gọn lại để tránh nhầm sau này.

## 💭 Nit (không yêu cầu sửa)

- `redis.constants.ts` — `REDIS_CLIENT` dùng string token `'REDIS_CLIENT'`; cân nhắc `Symbol`/`InjectionToken` để tránh trùng token vô tình khi module lớn dần. Không chặn ở quy mô hiện tại.
- `.env.example` TTL đang là giây thô (900/2592000/…); đơn vị/định dạng cuối chốt Q6 — comment đã ghi rõ, chấp nhận.
- `oauth-exception.filter.ts` map status→OAuth code hiện tối giản (đúng lời tech-lead "đừng over-engineer" ở B1.3); mã lỗi cụ thể `invalid_grant/unsupported_grant_type/...` sẽ dùng ở B3/B4 — ghi nhận, không sửa bây giờ.
- `MongoService.ping()` `res?.ok === 1` phụ thuộc `admin().ping()` trả `{ ok: 1 }` — chuẩn MongoDB, ổn.

---

## Lưu ý cho tester

1. **Ưu tiên verify nhánh 503 của `/ready`** (chưa được chứng minh ở dev): tắt Redis (hoặc Mongo) khi app đang chạy → `curl -w %{http_code} /ready`. Xác nhận (a) status **503** và (b) body thực tế nhận được — để chốt 🟡 #1 là "chỉ cần status" hay cần fix payload. Ghi rõ body quan sát được vào `test-report.md`.
2. **INV-20 redact**: dựng test/log 1 object chứa `password/token/code/secret/cookie/authorization` (kể cả nested + header `authorization`) rồi assert output log KHÔNG chứa giá trị bí mật (bị `remove`). Đây là tiêu chí bảo mật trọng tâm.
3. **PKCE vector RFC 7636**: đã có test pass; xác nhận `pnpm --filter @sso-idp/be test` EXIT=0, 10/10.
4. **Fail-fast config**: xoá 1 biến bắt buộc (vd `MONGO_URI`) trong env tạm → bootstrap phải EXIT≠0 và message nêu tên biến.
5. **Lua loader**: nếu có Docker host, đăng ký 1 script mẫu (`return 1`) qua `loadLuaScripts` rồi gọi để xác nhận `defineCommand` hoạt động.
6. Không còn Express: `grep @nestjs/platform-express` trong `be/package.json` (rỗng) + xác nhận không resolve trong lockfile.

---

<details>
<summary>Vòng trước — Senior Review R3–R5 (đã PASS, giữ tham chiếu)</summary>

# Senior Review — 2026-09-28 (R3–R5)

## Kết luận: **PASS** (R3 · R4 · R5)

Không còn 🔴 blocker. Đã đối chiếu từng file với `plan.md` §1.2/§1.4/§4 và hiện trạng repo thật. Phạm vi đúng (chỉ R3–R5, không lấn B*/A*/T*).

---

## Tổng quan (R3–R5)

Vòng R3–R5 làm gọn và đúng nguyên tắc surgical:

- **R3** chọn "verify + document" thay vì dựng lại — tránh nguồn sự thật kép, đúng với layout đang vận hành.
- **R4** `ci.yml` cấu trúc rõ, least-privilege, cache pnpm hợp lý, e2e để placeholder không đỏ.
- **R5** `.env.example` bám sát §1.4 từng biến, tách server/client đúng, chỉ chứa placeholder.

Điểm tốt nổi bật: bug YAML `run:` chứa `: ` trong plain scalar đã được backend-dev phát hiện + fix (quote toàn bộ value) khi validate bằng `js-yaml` — đúng tinh thần "verify thật, đọc output".

---

## R3 — Agent workspace (verify + document)

**PASS.** Kiểm chứng:

- `.github/agents/` có **đủ 7 agent** (`analyst`, `tech-lead`, `backend-dev`, `frontend-dev`, `senior-reviewer`, `tester`, `orchestrator`) + `HANDOFF-PROTOCOL.md` + `README.md`. Đếm trực tiếp thư mục ✓
- **KHÔNG** tạo `.claude/agents/*`, `docs/spec.md`, hay root `PROGRESS.md` — `file_search` cho cả 3 đều "No files found" ✓ (tránh nguồn sự thật kép — đúng cảnh báo INV/rủi ro).
- Thư mục `.github/agents/.claude/` là artefact của skills, KHÔNG phải bản agent trùng — không cần xử lý ✓
- `README.md` mục **"Agent workspace"** nêu đúng vị trí thực tế: agents `.github/agents/`, spec/plan `docs/agile/<slug>/`, progress `_progress.md`/`_handoff.md`; ghi rõ "không dùng `docs/spec.md` hay root `PROGRESS.md`". Dùng `<slug>` động, không hardcode ✓
- Quyết định "không thêm dòng nào cho agent" hợp lý: các agent đã trỏ spec trong thư mục tính năng theo HANDOFF-PROTOCOL.

Quyết định điều chỉnh R3 (chỉ document) **đúng** — khớp đánh giá tech-lead.

---

## R4 — CI GitHub Actions (`.github/workflows/ci.yml`)

**PASS.** Kiểm chứng:

- YAML hợp lệ: `get_errors` trên `ci.yml` → **No errors found**; backend-dev đã validate bằng `js-yaml@4.1.0` EXIT=0.
- Trigger `push`+`pull_request` vào `develop`/`main` ✓ · `concurrency` (`cancel-in-progress: true`) ✓ · `permissions: contents: read` (least privilege) ✓
- Job `quality`: `checkout@v4` → `setup-node@v4` với `node-version-file: .nvmrc` ✓ → `corepack enable` (trước khi gọi `pnpm`) ✓ → cache pnpm store (key theo `hashFiles('pnpm-lock.yaml')`) ✓ → `pnpm i --frozen-lockfile` → `pnpm lint` → `pnpm -r run typecheck` → `pnpm test`. Các lệnh đều đã PASS thật ở R1; root scripts dùng `--if-present --no-bail` ⇒ không đỏ ở giai đoạn placeholder ✓
- **Bug YAML `e2e` đã fix ĐÚNG**: `run: 'echo "e2e: TODO enable at B7.1/X1"'` — value quote toàn bộ, `: ` không còn bị hiểu nhầm thành mapping. Đọc file xác nhận ✓
- Job `e2e`: service `mongo:7`+`redis:7` với `--health-cmd/--health-interval/--health-timeout/--health-retries` qua folded scalar `>-`; port map đúng §1.2 (27017/6379). Health-cmd `mongosh ... ping` + `redis-cli ping` khớp §1.3 ✓ Bước chỉ là placeholder → **không đỏ**, comment nêu bật thật ở B7.1/X1 ✓
- "Chặn merge khi CI đỏ" xử lý đúng: comment đầu file + README ghi cần bật branch protection trên GitHub (thao tác ngoài repo) ✓

---

## R5 — `.env.example` + secret scan + README 5 phút

**PASS.** Đối chiếu **từng biến** với plan §1.4:

**`be/.env.example`** — đủ 100% §1.4: `NODE_ENV, PORT=4000, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER(local|aws-kms|vault ghi đúng chú thích), KEY_LOCAL_DIR, SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_WINDOW/MAX`. ✓ Port/URL khớp §1.2.

**`fe-admin/.env.example`** — đủ §1.4, tách nhóm rõ:
- Server-only: `OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL` — **KHÔNG** prefix `VITE_` ✓ (biến nhạy cảm không lọt bundle client — đúng INV env-validation A2).
- Client: `VITE_APP_NAME` (không nhạy cảm) ✓
- Có comment "KHÔNG đưa vào client bundle" cho nhóm server ✓

**`fe-sso-test/.env.example`** — đủ §1.4: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`. ✓ Tất cả `VITE_*` (public client) đúng bản chất.

**Bảo mật (INV-20 tinh thần) — PASS**: không có credential thật. Tất cả là placeholder (`your-*`, `change-me`, `replace-with-random-32-bytes`) hoặc localhost URL. `.gitignore` loại `.env`/`.env.local` nhưng KHÔNG loại `.env.example` (đọc `.gitignore` xác nhận; `git check-ignore` EXIT=1) ⇒ mẫu được commit, secret thật thì không ✓

**gitleaks config (`.pre-commit-config.yaml`)** — hợp lệ: repo `zricethezav/gitleaks`, `rev: v8.21.2`, hook `id: gitleaks`; `get_errors` → No errors found. Header ghi hướng dẫn cài ✓

**README** — mục "Chạy local trong 5 phút" (clone → cp `.env.example` cho 3 package, có lệnh macOS/Linux + Windows PowerShell + cmd → `pnpm i` → `docker compose up -d` → `pnpm dev:all`) + mục "Secret scan" (`pre-commit install` + `pre-commit run gitleaks`). Luồng khớp lệnh đã pass ở R1/R2 ✓

---

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

Không có (đều đã được xử lý đúng).

## 💭 Nit (không chặn, để tester/vòng sau cân nhắc — KHÔNG yêu cầu sửa ở R3–R5)

- `be/.env.example`: các TTL đang là số giây thô (`ACCESS_TOKEN_TTL=900`...); B1.2 chốt schema sẽ quyết định đơn vị/định dạng — hiện comment đã ghi "chốt ở B1.2", chấp nhận được.
- Nghiệm thu R5 "commit chứa secret bị chặn" mới ở mức **validate config** (gitleaks/pre-commit chưa cài trên máy dev). Đề nghị **tester**: nếu cài được gitleaks, tạo 1 file secret giả rồi chạy `gitleaks detect` để chứng minh chặn thật; nếu không, ghi rõ lý do môi trường trong `test-report.md`.
- `e2e` health-cmd trong folded scalar dùng `\"` literal (YAML không xử lý escape trong `>-`) — đây là hành vi đúng cho `--health-cmd` của Docker trên runner; chỉ lưu ý khi tester bật e2e thật ở B7.1/X1 rằng cần xác minh healthcheck chạy trên GitHub runner.

---

## Bàn giao

→ **tester**: verify `ci.yml` (validate YAML/actionlint nếu có; đối chiếu lệnh đã pass R1); thử `gitleaks detect` với secret giả nếu công cụ sẵn; chạy lại luồng README 5 phút. R3–R5 = **PASS**, sẵn sàng kiểm thử.

---

<details>
<summary>Vòng trước — Senior Review R1–R2 (giữ nguyên để tham chiếu)</summary>

# Senior Review — 2026-09-28 (R1–R2)

## Kết luận: **PASS**

Phạm vi R1 (monorepo pnpm workspace + script gốc) và R2 (docker-compose mongo/redis/mailpit + healthcheck + profile `full`) khớp `plan.md` §1 và §4, đối chiếu đủ tiêu chí. Không còn 🔴 blocker. Chuyển sang **tester** để xác nhận "3 service healthy" trên Docker host.

## Tổng quan
Diff gọn, kỷ luật, đúng "chỉ dựng khung — scaffold thật ở B1.1/A1/T1". Không lấn R3–R5 (không có CI/gitleaks/.env.example), không scaffold app thật. Placeholder tối giản, đủ để `pnpm-workspace` nhận diện. Config khớp nguồn sự thật gần như 1:1 với plan §1.3. Verify thật đã ghi trong handoff (`pnpm i` 4 project, `typecheck`/`lint` EXIT=0, `docker compose config` EXIT=0).

Điểm tốt cụ thể:
- `pnpm-workspace.yaml` liệt kê đủ 3 package (`be`, `fe-admin`, `fe-sso-test`) — khớp §1.1.
- Script gốc `dev:all`/`lint`/`typecheck`/`test` fan-out đúng; `--if-present --no-bail` xử lý đúng giai đoạn khung (theo đề xuất tech-lead), tránh false-negative.
- `.nvmrc` (`v22.23.2`) **khớp** `.node-version` (`v22.23.2`) — đã đọc cả hai file.
- docker-compose: image pin (`mongo:7`, `redis:7`, `axllent/mailpit:v1.21`); healthcheck `mongosh --quiet --eval db.adminCommand('ping')` và `redis-cli ping` đúng cú pháp và khớp §1.3; port `27017/6379/1025/8025` đúng §1.2/§1.3; volume `mongo_data`/`redis_data`.
- Profile `full` đặt trên service `be` → mặc định `docker compose up -d` KHÔNG chạy `be` (đúng yêu cầu). `depends_on ... service_healthy` khai báo khung hợp lý; `be/Dockerfile` để B7.3.
- Bảo mật: `.gitignore` loại `.env`/`.env.local`; không secret hardcode trong compose/package.json.

## 🔴 Blocker
- Không có.

## 🟡 Nên sửa
- Không có (trong phạm vi R1–R2). Các điểm dưới là 💭 nit, không chặn PASS.

## 💭 Nit
- `docker-compose.yml:9-13` — healthcheck mongo/redis đã có `interval`/`retries` khớp plan nhưng thiếu `start_period`. Mongo lần đầu init hơi lâu; thêm `start_period: 10s` sẽ giảm nguy cơ container bị đánh dấu `unhealthy` tạm thời lúc khởi động. Không bắt buộc vì `retries: 5 × interval 10s` đã đủ dung sai.
- `docker-compose.yml` — cân nhắc thêm healthcheck cho `mailpit` (vd. HTTP `/livez` hoặc `/readyz` cổng 8025) để tiêu chí "3 service healthy" của R2 áp được cho cả `mailpit`. Plan §1.3 không yêu cầu, nên đây chỉ là gợi ý; hiện `mailpit` không có healthcheck nên `docker compose ps` sẽ không hiện `healthy` cho nó. Tester lưu ý: acceptance "3 service healthy" thực chất chỉ mongo/redis báo `healthy`; mailpit chỉ `running` — vẫn coi là đạt.
- `package.json` (gốc) — `packageManager: pnpm@12.6.0` cố định là tốt cho reproducibility; nếu môi trường CI (R4 sau này) dùng bản pnpm khác sẽ cần đồng bộ. Ghi nhận để R4.

## Ghi chú môi trường
- Docker daemon tắt trên máy dev → tiêu chí R2 "3 service healthy" **PENDING verify on a Docker host**. `docker compose config` đã EXIT=0 (cú pháp/compose spec hợp lệ). Theo fallback tech-lead, KHÔNG coi là fail → không ảnh hưởng kết luận PASS.

## Bàn giao
- Cổng: **senior** → Kết quả: **PASS**
- Tiếp theo: **tester** — chạy `docker compose up -d` + `docker compose ps` trên Docker host xác nhận `mongo`/`redis` đạt `healthy`; chạy lại `pnpm i` + `pnpm dev:all`/`lint`/`typecheck`/`test` xác nhận fan-out không lỗi.

</details>

</details>
