# Summary — B1.1–B1.5 (M1) — ✅ PASS 9/9

- Phạm vi: NestJS + Fastify (TS strict), config fail-fast zod, Pino + redact INV-20, `/health` + `/ready`, helmet, ValidationPipe, `OAuthExceptionFilter`, graceful shutdown, Mongo + Redis + Lua loader, crypto utils (argon2id, CSPRNG, sha256, constant-time, PKCE S256).
- Commit: `6d04558`
- Bug đã sửa: thiếu `class-validator`/`class-transformer`; `/ready` treo khi Redis down → timeout ping 1.5s.
- Quyết định: zod cho config; `@node-rs/argon2` (tránh native build trên Windows).
- Debt để lại: DEBT-001, DEBT-002 (xem `backlog.md`).
