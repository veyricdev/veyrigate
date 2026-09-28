# Test Report — 2026-09-28 (B1.1–B1.5)

## Kết quả: **PASS** (9/9 case xanh · 0 fail · 0 pending)

Kiểm thử B1.1–B1.5 (Backend foundation) theo acceptance criteria (`tasks.md` Phase B + `plan.md` §5.B1 + spec §13 + INV-20 §9). **Chạy lệnh thật, đọc EXIT code / HTTP status / thời gian thực tế** — KHÔNG giả định PASS.

Môi trường: mongo:7@27017 + redis:7@6379 + mailpit@1025/8025 đều `(healthy)` (`docker compose ps`). Node v22.23.2, pnpm v12.6.0.
2 bug đã sửa trước đó (verify lại trong lần này): (1) ValidationPipe thiếu class-validator → nay app listen OK; (2) `/ready` treo khi Redis down → nay trả **503 @ ~1.7s** (KHÔNG treo).

### Điểm nhấn kết quả thật
- **/ready 503 khi Redis DOWN**: HTTP **503**, time **1.717s / 1.715s** (2 lần, ổn định, KHÔNG treo). Body OAuth-format `{"error":"server_error","error_description":"Service Unavailable Exception"}` (xác nhận 🟡 #1 của senior — chi tiết per-dependency bị OAuthExceptionFilter nuốt; status 503 vẫn ĐÚNG).
- **Fail-fast config**: `validateEnv({})` throw + liệt kê 18 biến thiếu; bootstrap thiếu `MONGO_URI` → **EXIT=1**, nêu tên `MONGO_URI`, app KHÔNG listen.
- **INV-20 redact**: runtime proof (pino + REDACT_PATHS thật) → 10/10 giá trị bí mật (top-level + nested + header) bị **remove**; field non-sensitive giữ lại. 0 leak.
- **PKCE RFC 7636**: vector Appendix B (`dBjftJeZ...` → `E9Melhoa2Owv...`) có trong test; `test` EXIT=0, 10/10.
- **Không còn Express**: `pnpm why express` + `why @nestjs/platform-express` rỗng; `platform-express@[0-9]` không resolve trong lockfile.

## Bảng case B1.1–B1.5 → kết quả

| # | Case | Lệnh chính | Kỳ vọng | Kết quả |
|---|------|-----------|---------|---------|
| 1 | B1.1 typecheck/lint/build | `pnpm --filter @sso-idp/be typecheck`/`lint`/`build` | 3× EXIT=0 | ✅ PASS (0/0/0) |
| 2 | B1.1 không còn Express | `pnpm why express` / `why @nestjs/platform-express` / grep lockfile | rỗng · không resolve | ✅ PASS |
| 3 | B1.5 test (PKCE RFC 7636 + crypto) | `pnpm --filter @sso-idp/be test` | EXIT=0 · 10/10 · vector Appendix B | ✅ PASS |
| 4 | B1.5 không `Math.random` trong crypto | `grep -rn Math.random src/` | chỉ ở tên test + comment, KHÔNG dùng thật | ✅ PASS |
| 5 | B1.2 fail-fast (unit) | `ts-node validateEnv({})` | throw + nêu tên biến | ✅ PASS |
| 6 | B1.2 fail-fast (bootstrap) | `node dist/main.js` thiếu `MONGO_URI` | EXIT≠0 + nêu `MONGO_URI` + không listen | ✅ PASS (EXIT=1) |
| 7 | B1.3 endpoints UP | `curl /health` `/ready` (mongo+redis up) | 200 / 200 nhanh | ✅ PASS (200@0.22s / 200@0.22s) |
| 8 | B1.3 /ready Redis DOWN | `curl -m 6 -w` (REDIS_URL=:6399) | /health 200 · /ready **503 ~1–2s không treo** | ✅ PASS (503@1.72s/1.71s) |
| 9 | B1.3 INV-20 redact | pino runtime proof (REDACT_PATHS thật) | secret bị remove, non-secret giữ | ✅ PASS (0 leak) |

**B1.4** (mongo+redis thật + Lua loader): kết nối thật chứng minh gián tiếp qua case 7 (`/ready` 200 `{"mongo":"up","redis":"up"}` + log `Redis connected`); Lua `defineCommand` verify thật với script mẫu → xem "Case B1.4" bên dưới.

## Lệnh đã chạy + output thực tế (B1.1–B1.5)

### Case 1 — B1.1 typecheck / lint / build
```
$ pnpm --filter @sso-idp/be typecheck   →  $ tsc --noEmit          →  TYPECHECK_EXIT=0
$ pnpm --filter @sso-idp/be lint        →  $ eslint src            →  LINT_EXIT=0
$ pnpm --filter @sso-idp/be build       →  $ nest build            →  BUILD_EXIT=0
```

### Case 2 — B1.1 không còn Express
```
$ pnpm --filter @sso-idp/be why express               → (rỗng)  WHY_EXPRESS_EXIT=0
$ pnpm --filter @sso-idp/be why @nestjs/platform-express → (rỗng) WHY_PLATFORM_EXIT=0
$ grep -c "platform-express@[0-9]" pnpm-lock.yaml      → 0  (không resolve; chỉ optional peer)
$ grep -i express be/package.json                      → (none)
```

### Case 3 — B1.5 test (PKCE RFC 7636 + crypto)
```
$ pnpm --filter @sso-idp/be test
 PASS  src/common/crypto/pkce.util.spec.ts
 PASS  src/common/crypto/crypto.util.spec.ts
Test Suites: 2 passed, 2 total
Tests:       10 passed, 10 total
TEST_EXIT=0
$ grep -n "dBjftJeZ\|E9Melhoa2Owv\|7636" src/common/crypto/pkce.util.spec.ts
4:  it('matches the RFC 7636 Appendix B test vector', () => {
6:    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
7:    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
```

### Case 4 — B1.5 không `Math.random` trong crypto
```
$ grep -rn "Math.random" src/
src/common/crypto/crypto.util.spec.ts:34:  it('is not Math.random — produces distinct values', () => {   ← tên test
src/common/crypto/crypto.util.ts:8:  * - CSPRNG token generation (`crypto.randomBytes` — never `Math.random`).  ← comment
```
→ KHÔNG có lệnh gọi `Math.random()` thật; chỉ xuất hiện trong tên test + comment. CSPRNG dùng `crypto.randomBytes`.

### Case 5 — B1.2 fail-fast (unit `validateEnv({})`)
```
$ npx ts-node -e "import {validateEnv} from './src/config/validation.schema'; validateEnv({})"
THREW AS EXPECTED:
Invalid environment variables:
  - ISSUER: Invalid input: expected string, received undefined
  - MONGO_URI: ...
  - REDIS_URL: ...
  - ACCESS_TOKEN_TTL / REFRESH_TOKEN_TTL / SESSION_IDLE_TTL / SESSION_ABSOLUTE_TTL: expected number, received NaN
  - KEY_LOCAL_DIR / SMTP_URL / GOOGLE_CLIENT_ID/SECRET / GITHUB_CLIENT_ID/SECRET: ...
  - ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD / CSRF_SECRET: ...
  - RATE_LIMIT_WINDOW / RATE_LIMIT_MAX: expected number, received NaN
```
→ Throw + liệt kê **đủ 18 biến thiếu** với tên rõ ràng.

### Case 6 — B1.2 fail-fast (bootstrap thiếu `MONGO_URI`)
```
(tạm move be/.env; env shell từ .env.example bỏ MONGO_URI)
$ node dist/main.js
[Nest] ERROR [ExceptionHandler] Error: Invalid environment variables:
  - MONGO_URI: Invalid input: expected string, received undefined
REAL_APP_EXIT=1
listen check: (app never started listening — correct)
```
→ App **crash lúc bootstrap, EXIT=1**, nêu đúng `MONGO_URI`, KHÔNG listen. (Đã restore `be/.env` sau test.)

### Case 7 — B1.3 endpoints UP (mongo+redis up)
```
app log: Redis connected · MongooseModule initialized · Nest application successfully started
$ curl -m 6 -w "HTTP=%{http_code} TIME=%{time_total}" /health
{"status":"ok"}                                   HTTP=200 TIME=0.223s
$ curl -m 6 -w "HTTP=%{http_code} TIME=%{time_total}" /ready
{"status":"ok","mongo":"up","redis":"up"}         HTTP=200 TIME=0.223s
```

### Case 8 — B1.3 /ready Redis DOWN (REDIS_URL=redis://localhost:6399)
```
app: Nest application successfully started (listen OK dù Redis down)
$ curl -m 6 -w "HTTP=%{http_code} TIME=%{time_total}" /health
{"status":"ok"}                                                          HTTP=200 TIME=0.218s
$ curl -m 6 -w "HTTP=%{http_code} TIME=%{time_total}" /ready   (run 1)
{"error":"server_error","error_description":"Service Unavailable Exception"}  HTTP=503 TIME=1.717s
$ curl ... /ready   (run 2)
{"error":"server_error","error_description":"Service Unavailable Exception"}  HTTP=503 TIME=1.715s
```
→ `/ready` trả **503 trong ~1.72s (KHÔNG treo)**, ổn định 2 lần. Body là OAuth-format (chi tiết per-dependency `mongo`/`redis` bị `OAuthExceptionFilter` nuốt — **🟡 #1 của senior xác nhận đúng**; chỉ ảnh hưởng body, status 503 vẫn đạt acceptance). Đã kill app + restore `be/.env` sau test.

### Case 9 — B1.3 INV-20 redact (runtime proof)
Chạy `pino` với **REDACT_PATHS y hệt** `src/common/logger/logger.module.ts`, log 1 object chứa bí mật:
```
=== RAW LOG LINE ===
{"level":30,...,"nested":{},"req":{"headers":{}},"username":"alice","msg":"login attempt"}
=== RESULT ===
username retained (non-sensitive): true
SECRET values leaked: NONE (0) - PASS      REDACT_EXIT=0
```
→ Top-level (`password/token/code/secret/cookie/authorization`) + nested (`nested.password`, `nested.access_token`) + header (`req.headers.authorization/cookie`) đều bị **remove** (`nested:{}`, `req.headers:{}`); field `username` non-sensitive được giữ. **0/10 giá trị bí mật lộ**. (Script proof tạm đã xoá.)
Kiểm cấu hình: đủ 6 khoá INV-20 top-level + header `authorization/cookie/set-cookie` + `remove:true`.

### Case B1.4 — Mongo/Redis thật + Lua loader `defineCommand`
- **Kết nối thật**: chứng minh gián tiếp — case 7 `/ready` 200 `{"mongo":"up","redis":"up"}` + log `Redis connected` + `MongooseModule dependencies initialized` (kết nối mongo:7/redis:7 thật qua compose).
- **Lua loader**: verify thật với script mẫu (cùng cơ chế `defineCommand` như `loadLuaScripts()`):
```
client.defineCommand('sampleEcho', { numberOfKeys: 1, lua: "return {KEYS[1], ARGV[1], 42}" })
await client.sampleEcho('mykey', 'myarg')  →  ["mykey","myarg",42]
defineCommand works: YES - PASS   LUA_EXIT=0
```
→ `defineCommand` đăng ký + gọi được trên Redis thật. (Script proof tạm đã xoá.)

## Coverage acceptance criteria (B1.1–B1.5)
- [x] B1.1 `start:dev` bootstrap FastifyAdapter · không còn Express · typecheck+lint EXIT=0 → case 1, 2, 7
- [x] B1.2 thiếu/sai env → crash bootstrap, báo rõ biến · config typed → case 5, 6
- [x] B1.3 INV-20 log không chứa bí mật → case 9
- [x] B1.3 `/ready` đỏ (503) khi Redis down · `/health` xanh → case 7, 8
- [x] B1.3 lỗi trả format OAuth (`error`, `error_description`) → case 8 (body OAuth-format)
- [x] B1.4 kết nối mongo/redis thành công · Lua loader đăng ký command → case 7, B1.4
- [x] B1.5 unit test vector RFC 7636 pass · không `Math.random` → case 3, 4

## Ghi chú / bàn giao
- 🟡 #1 (senior): `/ready` 503 body bị ép OAuth-format, mất chi tiết `mongo`/`redis` down. **KHÔNG chặn** acceptance (status 503 đúng, không treo). Đề xuất filter riêng cho health/ready ở vòng sau — ghi nhận, ngoài phạm vi B1.1–B1.5.
- Vệ sinh: đã kill app + free port 4000 + restore `be/.env` (gitignored, KHÔNG commit) + xoá mọi env/script proof tạm sau mỗi lần. `git status` không có file test tạm.
- Kết luận: **B1.1–B1.5 PASS** — bàn giao hoàn tất.

---

<details>
<summary>Vòng trước — Test Report R3–R5 (đã PASS, giữ tham chiếu)</summary>

# Test Report — 2026-09-28 (R3–R5)

## Kết quả: **PASS** (11/11 case xanh · 0 pending)

Kiểm thử R3–R5 theo tiêu chí nghiệm thu (plan §1.4 + §4). Chạy lệnh thật, đọc output thực tế.
Tất cả 11 case xanh. Case 10 (secret scan thật) KHÔNG rơi vào PENDING vì đã chạy được
`gitleaks` qua Docker image (`zricethezav/gitleaks:v8.21.2` — trùng version pin trong
`.pre-commit-config.yaml`) và xác nhận nó BÁO PHÁT HIỆN secret giả (private-key), sau đó XOÁ file tạm.

Công cụ dùng: `js-yaml@4.1.0` (validate YAML qua `pnpm dlx`) · `git check-ignore` ·
`docker run zricethezav/gitleaks:v8.21.2` (secret scan) · `pnpm i --frozen-lockfile`.

## Bảng case R3–R5 → kết quả

| # | Case | Lệnh chính | Kỳ vọng | Kết quả |
|---|------|-----------|---------|---------|
| 1 | R3 đủ 7 agent + HANDOFF-PROTOCOL | `ls .github/agents/` | 7 `.agent.md` + HANDOFF-PROTOCOL.md | ✅ PASS |
| 2 | R3 không nhân đôi nguồn | `ls` / `file_search` | không có `.claude/agents/*`, `docs/spec.md`, root `PROGRESS.md` | ✅ PASS |
| 3 | R3 README "Agent workspace" | `grep -n` | nêu đúng vị trí spec/plan/agents/progress | ✅ PASS |
| 4 | R4 ci.yml YAML hợp lệ | `js-yaml@4.1.0` | parse OK, EXIT 0 | ✅ PASS |
| 5 | R4 job `quality` đủ bước | `grep -nE` | node-version-file, corepack, frozen-lockfile, lint, typecheck, test | ✅ PASS |
| 6 | R4 job `e2e` service mongo/redis | `grep -nE` | `mongo:7`+`redis:7`+healthcheck | ✅ PASS |
| 7 | R5 3 `.env.example` đủ biến §1.4 | đọc + đối chiếu | be/fe-admin/fe-sso-test đủ 100% biến | ✅ PASS |
| 8 | R5 `.env.example` KHÔNG bị gitignore | `git check-ignore` | EXIT 1 (không ignored); `.env`/`.env.local` bị ignored | ✅ PASS |
| 9 | R5 `.pre-commit-config.yaml` + gitleaks | `js-yaml` + `grep` | YAML OK + hook `gitleaks` | ✅ PASS |
| 10 | R5 secret scan thật | `docker run gitleaks detect` | phát hiện secret giả, EXIT 1 | ✅ PASS |
| 11 | Regression lockfile | `pnpm i --frozen-lockfile` | EXIT 0 | ✅ PASS |

## Lệnh đã chạy + output thực tế (R3–R5)

### Case 1 — 7 agent + HANDOFF-PROTOCOL
```
$ ls .github/agents/
analyst.agent.md  backend-dev.agent.md  frontend-dev.agent.md  senior-reviewer.agent.md
tester.agent.md  tech-lead.agent.md  orchestrator.agent.md  HANDOFF-PROTOCOL.md  README.md
$ ls .github/agents/*.agent.md | wc -l  →  7
```
→ Đủ 7 agent `.agent.md` + `HANDOFF-PROTOCOL.md`. (Ghi chú: có `.github/agents/.claude/skills/`
là thư mục skills — KHÔNG phải `.claude/agents/`.)

### Case 2 — không nhân đôi nguồn sự thật
```
$ ls .claude/agents/            → No such file or directory (OK)
$ ls docs/spec.md               → No such file or directory (OK)
$ ls PROGRESS.md                → No such file or directory (OK)
file_search **/PROGRESS.md      → No files found
file_search **/.claude/agents/**→ No files found
```

### Case 3 — README "Agent workspace"
```
$ grep -n -i "agent workspace" README.md
99:## Agent workspace
```
Nội dung bảng: Agents `.github/agents/*.agent.md` (7) + HANDOFF-PROTOCOL · Spec/plan
`docs/agile/<slug>/spec.md`+`plan.md` · Progress/handoff `docs/agile/<slug>/_progress.md`+`_handoff.md`.
Ghi rõ "không dùng `docs/spec.md` hay root `PROGRESS.md`". ✅

### Case 4 — ci.yml YAML hợp lệ
```
$ pnpm dlx js-yaml@4.1.0 .github/workflows/ci.yml > /dev/null
ci.yml: YAML VALID (js-yaml@4.1.0) EXIT=0
```
(actionlint/pyyaml không cài trên máy → dùng js-yaml.)

### Case 5 — job `quality` đủ bước
```
27:  node-version-file: .nvmrc
30:  run: corepack enable
44:  run: pnpm i --frozen-lockfile
47:  run: pnpm lint
50:  run: pnpm -r run typecheck
53:  run: pnpm test
```

### Case 6 — job `e2e` service mongo/redis
```
61:  image: mongo:7
65:  --health-cmd "mongosh --quiet --eval \"db.adminCommand('ping')\""
66:  --health-interval 10s --health-timeout 5s --health-retries 5
68:  image: redis:7
72:  --health-cmd "redis-cli ping"
73:  --health-interval 10s --health-timeout 5s --health-retries 5
```

### Case 7 — 3 `.env.example` đủ biến §1.4
- **be** ✅: NODE_ENV, PORT, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL,
  SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER (local|aws-kms|vault), KEY_LOCAL_DIR,
  SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD,
  CSRF_SECRET, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX — **đủ 100%**.
- **fe-admin** ✅: server OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET,
  ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL + client VITE_APP_NAME (có comment "server-only
  KHÔNG vào client bundle") — **đủ**.
- **fe-sso-test** ✅: VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI,
  VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL — **đủ 7 biến**.
- Không có secret thật (toàn placeholder localhost/your-*).

### Case 8 — `.env.example` KHÔNG bị gitignore
```
$ git check-ignore -v be/.env.example fe-admin/.env.example fe-sso-test/.env.example
(no output)  check-ignore EXIT=1   ← không ignored ✅
$ git check-ignore -v be/.env be/.env.local
.gitignore:9:.env        be/.env
.gitignore:10:.env.local be/.env.local   ← .env/.env.local bị loại đúng ✅
```

### Case 9 — `.pre-commit-config.yaml` + gitleaks
```
$ pnpm dlx js-yaml@4.1.0 .pre-commit-config.yaml > /dev/null
.pre-commit-config.yaml: YAML VALID EXIT=0
$ grep -nE "gitleaks" .pre-commit-config.yaml
3:  - repo: https://github.com/zricethezav/gitleaks
6:      - id: gitleaks
```
(repo rev `v8.21.2`, hook id `gitleaks`.)

### Case 10 — secret scan THẬT (gitleaks qua Docker)
`gitleaks`/`pre-commit` CHƯA cài trên máy, nhưng Docker daemon RUNNING → chạy đúng version pin.
Tạo file tạm `.gitleaks-tmp/fake-secret.txt` chứa block `-----BEGIN PRIVATE KEY-----`:
```
$ MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/.gitleaks-tmp:/scan" \
    zricethezav/gitleaks:v8.21.2 detect --source=/scan --no-git -v
Finding:  -----BEGIN PRIVATE KEY-----...
RuleID:   private-key
File:     /scan/fake-secret.txt
2:35PM WRN leaks found: 1
gitleaks EXIT=1        ← PHÁT HIỆN secret ✅
$ rm -rf .gitleaks-tmp  → CONFIRMED GONE (file tạm đã xoá)
```
Ghi chú: chuỗi AWS example `AKIAIOSFODNN7EXAMPLE` bị gitleaks allowlist (no leak) — đã đổi sang
private-key block để có bằng chứng phát hiện dứt khoát. Cùng version `v8.21.2` với pre-commit hook
⇒ hook sẽ chặn commit chứa secret thật.

### Case 11 — regression lockfile
```
$ pnpm i --frozen-lockfile
Scope: all 4 workspace projects
Already up to date
Done in 58ms using pnpm v12.6.0
EXIT=0
```

## Coverage acceptance criteria (R3–R5)
- [x] R3.1 đủ 7 agent + HANDOFF-PROTOCOL — case 1
- [x] R3.2 không nhân đôi nguồn (.claude/agents, docs/spec.md, root PROGRESS.md) — case 2
- [x] R3.3 README "Agent workspace" đúng layout — case 3
- [x] R4.4 ci.yml YAML hợp lệ — case 4
- [x] R4.5 job `quality` đủ bước — case 5
- [x] R4.6 job `e2e` service mongo:7+redis:7 healthcheck — case 6
- [x] R5.7 3 `.env.example` đủ biến §1.4 — case 7
- [x] R5.8 `.env.example` không bị gitignore — case 8
- [x] R5.9 `.pre-commit-config.yaml` + hook gitleaks — case 9
- [x] R5.10 secret scan thật phát hiện secret giả — case 10
- [x] R5.11 lockfile hợp lệ cho CI — case 11

---

<details>
<summary>Test Report — 2026-09-28 (R1–R2) — PASS (8/8)</summary>

## Kết quả: **PASS** (8/8 case xanh)

Tất cả case R1 & R2 xanh. Case R2 "3 service healthy" ban đầu PENDING (Docker daemon off) đã được **verify lại ngày 2026-09-28 khi Docker chạy** → mongo/redis/mailpit đều `healthy`. Không có case nào FAIL.

## Bảng case → kết quả

| # | Case | Lệnh | Kỳ vọng | Kết quả |
|---|------|------|---------|---------|
| 1 | R1 `pnpm i` (3 package con) | `pnpm i` | "all 4 workspace projects", EXIT 0 | ✅ PASS |
| 2 | R1 typecheck | `pnpm -r run typecheck` | EXIT 0 (placeholder OK) | ✅ PASS |
| 3 | R1 lint | `pnpm lint` | EXIT 0 | ✅ PASS |
| 4 | R1 dev:all fan-out 3 app | `pnpm dev:all` | 3 script `dev` chạy song song, không treo | ✅ PASS |
| 5 | R1 `.nvmrc` == `.node-version` | đọc 2 file | cả hai = `v22.23.2` | ✅ PASS |
| 6 | R2 compose config | `docker compose config` | EXIT 0 (cú pháp hợp lệ) | ✅ PASS |
| 7 | R2 mongo/redis healthy | `docker compose up -d` + `ps` | mongo & redis `healthy` | ✅ PASS (verified 2026-09-28) |
| 8 | R2 `be` không chạy mặc định | `docker compose config --services` | default không có `be`; `--profile full` mới có | ✅ PASS |

## Lệnh đã chạy + output thực tế

### Case 1 — `pnpm i`
```
Scope: all 4 workspace projects
Already up to date
Done in 6ms using pnpm v12.6.0
EXIT=0
```

### Case 2 — `pnpm -r run typecheck`
```
Scope: 3 of 4 workspace projects
be typecheck$ echo "[be] TODO: typecheck at B1.1"
fe-admin typecheck$ echo "[fe-admin] TODO: typecheck at A1"
fe-sso-test typecheck$ echo "[fe-sso-test] TODO: typecheck at T1"
(3× Done)
EXIT=0
```

### Case 3 — `pnpm lint`
```
$ pnpm -r --no-bail run --if-present lint
Scope: 3 of 4 workspace projects
be lint$ echo "[be] TODO: lint at B1.1"      └─ Done
fe-sso-test lint$ echo "[fe-sso-test] TODO: lint at T1"   └─ Done
fe-admin lint$ echo "[fe-admin] TODO: lint at A1"   └─ Done
EXIT=0
```

### Case 4 — `pnpm dev:all` (timeout 30s safety net)
```
$ pnpm -r --parallel run dev
Scope: 3 of 4 workspace projects
fe-admin dev: "[fe-admin] TODO: scaffold TanStack Start at A1"    Done
fe-sso-test dev: "[fe-sso-test] TODO: scaffold Vite + React + React Router at T1"    Done
be dev: "[be] TODO: scaffold NestJS + Fastify at B1.1"    Done
EXIT=0
```
→ 3 script `dev` fan-out song song, tất cả `Done`, tiến trình tự kết thúc (placeholder là `echo` process ngắn — KHÔNG treo).

### Case 5 — `.nvmrc` vs `.node-version`
```
.nvmrc        = v22.23.2
.node-version = v22.23.2
```
→ Khớp.

### Case 6 — `docker compose config`
```
config EXIT=0
```

### Case 8 — services mặc định vs `--profile full`
```
--- services (default) ---
mailpit
mongo
redis
EXIT=0
--- services (--profile full) ---
mongo
redis
be
mailpit
EXIT=0
```
→ Mặc định KHÔNG có `be`; chỉ `--profile full` mới thêm `be`. Đúng yêu cầu.

### Case 7 — `docker compose up -d` + `ps` (verified 2026-09-28)
Lần đầu (Docker daemon off) → PENDING. **Verify lại khi Docker chạy:**
```
$ docker compose up -d   → EXIT=0
$ docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
SERVICE   STATUS                    PORTS
mailpit   Up 20 seconds (healthy)   0.0.0.0:1025->1025, 0.0.0.0:8025->8025
mongo     Up 20 seconds (healthy)   0.0.0.0:27017->27017
redis     Up 21 seconds (healthy)   0.0.0.0:6379->6379
```
⇒ **PASS** — cả 3 service `healthy` (mailpit image có sẵn healthcheck).

## Test FAIL (nếu có)
- Không có.

</details>

## Coverage acceptance criteria
- [x] AC-R1.1 `pnpm i` 3 package → case 1
- [x] AC-R1.2 typecheck EXIT 0 → case 2
- [x] AC-R1.3 lint EXIT 0 → case 3
- [x] AC-R1.4 dev:all fan-out 3 app → case 4
- [x] AC-R1.5 `.nvmrc` == `.node-version` → case 5
- [x] AC-R2.6 compose config valid → case 6
- [x] AC-R2.7 mongo/redis healthy → case 7 **(verified 2026-09-28)**
- [x] AC-R2.8 `be` không chạy mặc định → case 8

## Ghi chú
- Case 7 đã verify thật khi Docker chạy: mongo/redis/mailpit đều `healthy`.
- `mailpit` thực tế BÁO `healthy` (image `axllent/mailpit` có healthcheck sẵn) → nit của senior không còn áp dụng.

</details>
