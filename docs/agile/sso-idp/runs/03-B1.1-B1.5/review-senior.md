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

