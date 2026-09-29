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

