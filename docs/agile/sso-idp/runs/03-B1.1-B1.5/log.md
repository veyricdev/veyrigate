# Log — B1.1–B1.5

## [2026-09-28] orchestrator — khởi tạo B1.1–B1.5
- Đã làm: Phase R (M0) đã DONE (commit 8b75f24 + 4c2104a). Sang M1 Backend foundation. Sinh tasks B1.1–B1.5 vào tasks.md từ plan §5.B1 (bảng B1.1–B1.5) + spec §5 (cấu trúc thư mục) + §13. spec/plan KHÔNG ghi đè.
- Phạm vi lần chạy: B1.1 (scaffold NestJS+Fastify TS strict + ESLint/Prettier + cấu trúc §5), B1.2 (config fail-fast zod/joi typed), B1.3 (Pino+redact + /health + /ready + helmet + ValidationPipe + exception filter OAuth + graceful shutdown), B1.4 (Mongo Mongoose + Redis ioredis + Lua loader), B1.5 (crypto utils argon2/CSPRNG/sha256/constant-time/PKCE S256). B1.6–B1.10 để nhóm sau.
- Hiện trạng `be/`: mới có placeholder (`package.json` script echo, `README.md`, `.env.example`) — B1.1 sẽ scaffold thật thay placeholder.
- File đổi: tasks.md (thêm Phase B — B1.1–B1.5), _handoff.md, _progress.md
- Kết quả: DONE (khởi tạo)
- Bàn giao cho: tech-lead — review tasks B1.1–B1.5 (kiến trúc/khả thi)

## [2026-09-28] tech-lead — review B1.1–B1.5
- Đã làm: review kiến trúc & khả thi nhóm B1.1–B1.5. Đọc thật `_handoff.md`, `_progress.md`, `tasks.md` (Phase B), `plan.md` §5.B1/§1.4/§1.5/§2/§11/§12, `spec.md` §3/§5/§6.1-6.3/§13/§15, `be/package.json` + `be/.env.example` (placeholder hiện tại).
- Đánh giá:
  - **Phạm vi**: B1.1–B1.5 KHỚP plan §5.B1 + spec §5/§13; KHÔNG lấn B1.6–B1.10/B2/B3/B4 (module domain chỉ rỗng đủ build; Lua loader khung; crypto util không chạm KeyProvider/jose). ✓
  - **Thứ tự phụ thuộc**: B1.1→B1.2→{B1.3,B1.4} và B1.5←B1.1 hợp lý. ⚠️ Đề xuất **đảo B1.4 trước B1.3** (cả hai phụ thuộc B1.2) để nghiệm thu `/ready` mongo+redis verify được ngay — non-blocking.
  - **Nghiệm thu kiểm chứng được**: 4 điểm trọng tâm đều đo được — fail-fast config (bootstrap âm), redact INV-20 (assert log), `/ready` mongo+redis (503 khi down), PKCE S256 vector RFC 7636 (verifier `dBjftJeZ...` → challenge `E9Melhoa2Owv...`). ✓
  - **Rủi ro dev (non-blocking)**: gỡ Express + pin `@nestjs/*` cùng major (check lockfile); **argon2 native build Windows** → fallback `@node-rs/argon2`; chọn **zod** (type-infer, đồng bộ FE); module rỗng dùng stub `@Module({})` tránh lỗi "not a module"; không hardcode TTL/issuer (đọc config).
  - **plan §12**: rà Q1–Q9/D1–D12 → KHÔNG có quyết định nào chặn B1.1–B1.5 (Q6 TTL/Q9 tên project chỉ yêu cầu đọc từ config, không hardcode).
- File đổi: review-techlead.md (GHI ĐÈ — nội dung B1.1–B1.5, giữ lịch sử R trong `<details>`), _handoff.md, _progress.md
- Kết quả: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5)
- Bàn giao cho: **backend-dev** — hiện thực theo thứ tự B1.1 → B1.2 → B1.4 → B1.3 → B1.5

## [2026-09-28] backend-dev — hoàn tất B1.1–B1.5 + sửa bug bootstrap
- Đã làm: hiện thực xong B1.1–B1.5 (scaffold NestJS+Fastify TS strict, config fail-fast zod, Pino+redact+/health+/ready+helmet+ValidationPipe+exception filter OAuth+graceful shutdown, Mongo+Redis+Lua loader, crypto utils argon2/CSPRNG/sha256/constant-time/PKCE S256). Orchestrator verify runtime phát hiện **1 bug thật chặn nghiệm thu B1.3** → đã sửa surgical.
- 🐞 **Bug (chặn B1.3)**: app crash lúc bootstrap — `ERROR: The "class-validator" package is missing. Please, make sure to install it to use ValidationPipe.`; `curl /health` connection refused (exit 7); app KHÔNG listen.
  - **Nguyên nhân**: `main.ts` bật global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` nhưng `be/package.json` thiếu `class-validator` + `class-transformer` (NestJS ValidationPipe yêu cầu 2 package này lúc khởi tạo).
- ✅ **Fix (surgical)**: thêm `class-validator@0.14.2` + `class-transformer@0.5.1` vào `dependencies` của `be/package.json`; `pnpm i` cập nhật lockfile. KHÔNG sửa `main.ts` hay file nào khác.
- **Verify THẬT (đọc EXIT code + HTTP status, không giả định)**:
  - `pnpm i` (gốc) → EXIT=0, `Packages: +12 -7`, lockfile cập nhật ✅
  - `pnpm --filter @sso-idp/be typecheck` → EXIT=0 ✅
  - `pnpm --filter @sso-idp/be lint` → EXIT=0 ✅
  - `pnpm --filter @sso-idp/be test` → EXIT=0 (2 suite, 10/10 test PASS: crypto.util + pkce.util) ✅
  - `pnpm --filter @sso-idp/be build` → EXIT=0 ✅
  - Runtime (env tạm đầy đủ dựa `.env.example`; mongo:7@27017 + redis:7@6379 `(healthy)` qua docker compose):
    - App log: `Nest application successfully started` — **KHÔNG còn ERROR class-validator**, app listen thành công ✅
    - `curl -w %{http_code} /health` → **200** (`{"status":"ok"}`) ✅
    - `curl -w %{http_code} /ready` → **200** (`{"status":"ok","mongo":"up","redis":"up"}`) ✅
    - Đã `kill` app + `rm` env tạm sau verify. `git status`: chỉ `be/package.json` + `pnpm-lock.yaml` là file đổi thuộc fix này — **KHÔNG commit env tạm**.
- File đổi: `be/package.json` (thêm 2 dep), `pnpm-lock.yaml` (auto), `tasks.md` (B1.1–B1.5 checkbox `[x]`, Trạng thái `in-review`), `_handoff.md` (GHI ĐÈ), `_progress.md`.
- Kết quả: **DONE (dev)** — B1.1–B1.5 code + runtime verify PASS (/health 200, /ready 200).
- Bàn giao cho: **senior-reviewer** — review B1.1–B1.5.

## [2026-09-28] senior-reviewer — review B1.1–B1.5
- Đã làm: review chất lượng/đúng đắn/bảo mật/over-engineering nhóm B1.1–B1.5. Đọc thật `_handoff.md`, `_progress.md`, `tasks.md` (Phase B), `review-techlead.md`, `spec.md` §5/§13/§15 (INV-3/16/20), `plan.md` §1.4/§1.5/§5.B1. Đọc trực tiếp toàn bộ code `be/` liên quan: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `jest.config.js`, `main.ts`, `app.module.ts`, `config/*`, `common/logger/logger.module.ts`, `common/filters/oauth-exception.filter.ts`, `common/crypto/{crypto,pkce}.util.ts` + `.spec.ts`, `database/mongo/*`, `database/redis/*`, `modules/health/*`, module stub domain.
- Kiểm chứng (đọc code + grep + get_errors):
  - **Bảo mật**: redact INV-20 đủ 6 khoá + wildcard nested + header `authorization/cookie/set-cookie` (`remove:true`) ✓ · CSPRNG `randomBytes`, **không** `Math.random` (grep `src/**` rỗng, chỉ có trong comment/test) ✓ · constant-time `timingSafeEqual` + length guard ✓ · argon2id params OWASP (m=19456,t=2,p=1) ✓ · PKCE S256 vector RFC 7636 Appendix B pass ✓ · không secret hardcode; `.env.example` chỉ placeholder ✓.
  - **Đúng đắn**: fail-fast config zod báo tên biến ✓ · exception filter OAuth format `{error,error_description}` qua APP_FILTER ✓ · graceful shutdown (`enableShutdownHooks` + redis `quit()` + mongoose auto-close) ✓ · `/health` 200 / `/ready` 503-khi-down (status đúng) ✓.
  - **Cấu trúc**: khớp spec §5; module domain stub `@Module({})` KHÔNG import vào AppModule ✓ · Lua loader chỉ khung ✓ · không lấn B1.6+/B2+ ✓.
  - **Express**: `be/package.json` không có platform-express; trong lockfile là **optional peer** (`optional:true`), KHÔNG resolve (grep `platform-express@[0-9]` rỗng) ✓. argon2 fallback `@node-rs/argon2` (đúng khuyến nghị tech-lead Windows).
  - **Sạch**: `get_errors` 6 file lõi → No errors; không TODO/FIXME lơ lửng trong `src/`.
- 🟡 **2 điểm nên sửa (non-blocking)**:
  - #1 `/ready` khi down: `ServiceUnavailableException({status,mongo,redis})` bị `OAuthExceptionFilter` (`@Catch()`) map thành `{error:'server_error',error_description:'Service Unavailable'}` (payload per-dependency mất; HTTP 503 vẫn đúng). Runtime verify dev chỉ chứng minh nhánh 200. Đề xuất filter riêng cho health/ready hoặc trả 503 trực tiếp qua reply.
  - #2 `config.module.ts` gọi `validateEnv` 2 lần (`validate` + trong `load` factory) — thừa, idempotent, nên gộp.
- 💭 Nit: `REDIS_CLIENT` string token (cân nhắc Symbol); TTL đơn vị chốt Q6; filter map OAuth code tối giản (đúng, mở rộng ở B3/B4).
- File đổi: `review-senior.md` (GHI ĐÈ — nội dung B1.1–B1.5, giữ R3–R5 + R1–R2 trong `<details>`), `_handoff.md` (GHI ĐÈ), `_progress.md`.
- Kết quả: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5) — không có 🔴 blocker. Phạm vi đúng.
- Bàn giao cho: **tester** — verify B1.1–B1.5, ưu tiên nhánh 503 `/ready` (đọc status + body thực tế) để chốt 🟡 #1; INV-20 redact; PKCE vector; fail-fast config; Lua loader script mẫu; grep không còn Express.

## [2026-09-28] backend-dev — sửa bug `/ready` treo khi Redis down (chặn nghiệm thu B1.3)
- 🐞 **Bug (chặn B1.3)**: chạy app với `REDIS_URL=redis://localhost:6399` (port đóng), mongo up. `GET /health` → 200 (đúng); `GET /ready` → **TREO** (`curl -m 4` HTTP=000; log app `request aborted ... statusCode:null ... responseTime:3802ms`). Redis liên tục `Redis error` retry. Nghiệm thu B1.3 "/ready đỏ (503) khi Redis/Mongo down" KHÔNG đạt vì treo thay vì trả 503 nhanh.
- 🔎 **Nguyên nhân**: ioredis dùng `maxRetriesPerRequest: null` (hợp lý cho client long-lived) → khi Redis down, `ping()` bị **enqueue chờ reconnect vô hạn** thay vì fail nhanh. `RedisService.ping()` gọi trực tiếp không timeout; `health.controller.ts safePing()` bắt exception nhưng không bao timeout → chờ mãi.
- ✅ **Fix (surgical — chỉ 1 file `be/src/modules/health/health.controller.ts`)**:
  - Thêm hằng `PING_TIMEOUT_MS = 1500`.
  - Bọc `safePing()` bằng `Promise.race([ping(), timeout])` — `timeout` là `setTimeout(...,1500)` resolve `false`. Ping không phản hồi trong 1.5s → coi là down → `/ready` trả **503 nhanh**.
  - `clearTimeout` trong `finally`; gắn `ping.catch(() => undefined)` chống unhandled rejection từ promise ioredis còn treo (vẫn queued khi timeout thắng).
  - **KHÔNG** đổi `maxRetriesPerRequest` của client dùng chung (giữ nguyên cho data-access). KHÔNG chạm `redis.module.ts`/`redis.service.ts`/`mongo.service.ts`/`main.ts`.
- **Verify THẬT (đọc EXIT + HTTP status + time_total)**:
  - `pnpm --filter @sso-idp/be typecheck` → EXIT=0 ✅ · `lint` → EXIT=0 ✅ · `test` → EXIT=0 (2 suite, 10/10) ✅ · `build` → EXIT=0 ✅
  - Runtime (mongo:7@27017 + redis:7@6379 `(healthy)`; env tạm `be/.env` gitignored):
    - **Redis UP** (`redis://localhost:6379`): `/health` **200** (0.21s); `/ready` **200** `{"status":"ok","mongo":"up","redis":"up"}` (0.21s) — nhanh ✅
    - **Redis DOWN** (`redis://localhost:6399`, mongo up): `/health` **200** (0.22s); `/ready` **503** `{"error":"server_error","error_description":"Service Unavailable Exception"}` (**1.73s** — KHÔNG treo) ✅. Lặp 2 lần: 503 @ 1.73s / 1.71s (ổn định).
    - Đã kill app + free port 4000 (taskkill PID chiếm :4000). `git check-ignore be/.env` EXIT=0 → env tạm KHÔNG commit.
  - Ghi chú: body 503 vẫn qua `OAuthExceptionFilter` (🟡 #1 của senior — chỉ ảnh hưởng body, status 503 đúng; NGOÀI phạm vi task). Case mongo-down optional; mongoose chặn bootstrap khi mongo unreachable (lifecycle riêng, không thuộc bug readiness ping) — chưa verify lần này.
- File đổi: `be/src/modules/health/health.controller.ts` (source duy nhất), `_handoff.md` (GHI ĐÈ), `_progress.md` (append). `tasks.md` giữ B1.1–B1.5 `[x]`, Trạng thái `in-review`.
- Kết quả: **FIXED** — `/ready` trả 503 trong ~1.7s khi Redis down, không còn treo.
- Bàn giao cho: **tester** — verify lại nhánh 503 `/ready` (redis/mongo down → 503 trong ~1–2s, không treo) + nhánh 200 (up).

## [2026-09-28] tester — verify B1.1–B1.5 (Backend foundation)
- Đã làm: kiểm thử B1.1–B1.5 theo acceptance (`tasks.md` Phase B + `plan.md` §5.B1 + spec §13 + INV-20). **Chạy lệnh thật, đọc EXIT code / HTTP status / thời gian** — không giả định. Docker mongo:7+redis:7+mailpit `(healthy)`.
- Kết quả (9/9 case xanh, 0 fail, 0 pending):
  - **B1.1** — `typecheck` EXIT=0 · `lint` EXIT=0 · `build` EXIT=0 ✅. Không còn Express: `pnpm --filter @sso-idp/be why express` + `why @nestjs/platform-express` đều rỗng; `grep -c "platform-express@[0-9]" pnpm-lock.yaml` = 0 (chỉ optional peer không resolve); `be/package.json` không có express ✅
  - **B1.5** — `test` EXIT=0, **10/10 pass** (crypto.util + pkce.util). Vector **RFC 7636 Appendix B** có trong `pkce.util.spec.ts` (`dBjftJeZ...` → `E9Melhoa2Owv...`) ✅. `grep -rn "Math.random" src/` → chỉ ở TÊN TEST + COMMENT, KHÔNG dùng thật (CSPRNG `crypto.randomBytes`) ✅
  - **B1.2 fail-fast** — `ts-node validateEnv({})` → throw + liệt kê đủ 18 biến thiếu ✅. Bootstrap `node dist/main.js` thiếu `MONGO_URI` (move `.env` tạm) → `ERROR [ExceptionHandler] Invalid environment variables: - MONGO_URI: ...`, **REAL_APP_EXIT=1**, app KHÔNG listen ✅. Đã restore `be/.env`.
  - **B1.3 endpoints UP** — app listen (log `Redis connected` + `Nest application successfully started`); `/health` **200** @0.22s; `/ready` **200** `{"status":"ok","mongo":"up","redis":"up"}` @0.22s ✅
  - **B1.3 /ready Redis DOWN** (`REDIS_URL=redis://localhost:6399`, mongo up) — `/health` **200** @0.22s; `/ready` **503** @ **1.717s / 1.715s** (2 lần, KHÔNG treo) ✅. Body: `{"error":"server_error","error_description":"Service Unavailable Exception"}` (OAuth-format — xác nhận 🟡 #1 senior: chi tiết per-dependency bị `OAuthExceptionFilter` nuốt; status 503 vẫn ĐÚNG → acceptance đạt). `curl -m 6 -w "%{http_code} %{time_total}"`.
  - **B1.3 INV-20 redact** — runtime proof: chạy `pino` với REDACT_PATHS **y hệt** `logger.module.ts`, log object chứa bí mật (top-level + nested + header). Output: `nested:{}`, `req.headers:{}`, `username:"alice"` giữ lại; **0/10 giá trị bí mật lộ** (REDACT_EXIT=0) ✅. Cấu hình: đủ 6 khoá INV-20 + header `authorization/cookie/set-cookie` + `remove:true`.
  - **B1.4** — kết nối mongo/redis thật (gián tiếp qua `/ready` 200 `{"mongo":"up","redis":"up"}` + log connect). Lua loader `defineCommand`: verify thật với script mẫu `sampleEcho` (`return {KEYS[1],ARGV[1],42}`) trên Redis thật → `["mykey","myarg",42]` (LUA_EXIT=0) ✅
- Vệ sinh: đã kill app + free port 4000 sau mỗi runtime; restore `be/.env` (gitignored, `git check-ignore` EXIT=0 → KHÔNG commit); xoá mọi env/script proof tạm. `git status`: không có file test tạm — chỉ file B1.1–B1.5 thật + docs.
- KHÔNG sửa code sản phẩm (`be/src/**` không đổi) — đúng vai tester.
- File đổi: `test-report.md` (GHI ĐÈ — B1.1–B1.5, giữ R3–R5/R1–R2 trong `<details>`), `tasks.md` (B1.1–B1.5 → `done`), `_handoff.md` (GHI ĐÈ), `_progress.md` (append).
- Kết quả: **PASS** (9/9). B1.1–B1.5 hoàn tất.
- Bàn giao cho: hoàn tất B1.1–B1.5 → nhóm kế B1.6–B1.10. 🟡 mở (không chặn, ngoài phạm vi): #1 `/ready` 503 body OAuth-format (đề xuất filter riêng); #2 `validateEnv` gọi 2 lần lúc boot.
