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

