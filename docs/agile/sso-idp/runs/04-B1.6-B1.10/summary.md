# Summary — B1.6–B1.10 (M1) — ✅ PASS 45/45

- Phạm vi: 11 schema §10 + AuditLog, index/TTL + `db:sync-indexes` (autoIndex off ở prod) · Audit (cấm secret type-level + runtime, hook alert) · Rate-limit Redis đa chiều IP/account/device (Lua atomic, 429 + `Retry-After`) · KeyProvider/LocalKeyProvider dev-only, `/jwks.json`, TokenSigner/Verifier RS256, rotation thường/khẩn cấp · Mailer SMTP + template verify/reset.
- Commit: `1dcb2a8`
- Review: tech-lead PASS · senior REJECT vòng 1 (verifier chấp nhận JWT thiếu `exp` → `requiredClaims: ['exp']`) → PASS vòng 2.
- Test: Jest chuyển sang ESM gốc (NestJS 12 ESM-only) — `@jest/globals`, `--experimental-vm-modules`.
- Dep mới: `jose@5.10.0`, `nodemailer@10.0.12`, `@types/nodemailer@8.0.2`, `@jest/globals@30.0.5` (dev).
- Debt để lại: DEBT-005, DEBT-006, DEBT-007 (xem `backlog.md`).
