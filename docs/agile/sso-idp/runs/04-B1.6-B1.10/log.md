# Log — run 04 (B1.6–B1.10)

## [2026-09-29 09:00] orchestrator — mở run 04
- Đã làm: spec/plan đã có → bỏ qua analyst, sinh `tasks.md` từ plan §5.B1 (B1.6–B1.10) + giả định A1–A6. Không kéo DEBT (lý do trong tasks.md).
- Lưu ý môi trường: cổng host 27017/6379 đang bị container dự án khác (`aegate-*`) chiếm → test tích hợp dùng container riêng cổng khác.
- Lưu ý quy trình: công cụ subagent không khả dụng trong phiên → orchestrator thực thi lần lượt từng vai trò theo đúng file agent.
- Kết quả: DONE
- Bàn giao: tech-lead — review tasks.md

## [2026-09-29 09:20] tech-lead — review tasks B1.6–B1.10
- Đã làm: đối chiếu tasks.md với plan §5.B1, spec §6.1/6.3/6.4/§10/§15; kiểm codebase (`mongo.module.ts`, `lua-loader.ts`, `configuration.ts`).
- File đổi: review-techlead.md, backlog.md (DEBT-005), STATUS.md
- Kết quả: PASS — phạm vi đúng, nghiệm thu đo được; thứ tự B1.6→B1.7→B1.10→B1.8→B1.9
- Bàn giao: backend-dev — hiện thực theo "Kiến trúc đề xuất"

## [2026-09-29 11:30] backend-dev — hiện thực B1.6–B1.10
- Đã làm: 11 schema §10 + TTL (`models.ts` registry, `db:sync-indexes`, autoIndex off ở prod) · Audit (`SecurityModule`: enum, `AuditMetadata` cấm key bí mật type-level + strip runtime, hook `onAlert`) · Rate-limit (Lua INCR+PEXPIRE nhiều key, `@RateLimit` guard 429+Retry-After) · Keys (`KeyProvider`, `LocalKeyProvider` dev-only, `/jwks.json`, `TokenSigner/Verifier` jose 5.10.0 RS256-only, rotation normal/emergency + audit) · Mailer (nodemailer SMTP có timeout + template verify/reset). Dep: `jose@5.10.0`, `nodemailer@10.0.12`, `@types/nodemailer@8.0.2`.
- Sửa nhỏ ngoài file mới: `lua-loader.ts` `numberOfKeys` optional (dynamic key count); `.gitignore` `be/keys/`.
- Verify: typecheck/lint/build/test EXIT=0 (10/10 cũ); runtime (mongo:27117, redis:6479 container riêng): `db:sync-indexes` 12 model EXIT=0, app start OK, `/jwks.json` 200 · 0 member private, `/ready` 200.
- File đổi: xem `git status` — `be/src/{app.module,database/mongo/*,database/redis/lua-loader,modules/{identity,clients,resources,oauth,authentication}/schemas/*,modules/security/**,modules/keys/*,modules/mailer/*}`, `be/package.json`, `.gitignore`, `pnpm-lock.yaml`
- Kết quả: DONE — bàn giao senior-reviewer

## [2026-09-29 13:00] senior-reviewer — vòng 1
- Đã làm: review toàn bộ diff run 04 (9 file sửa + 22 file mới) đối chiếu spec §6.3/§6.4/§8/§10/§15.
- Kết quả: REJECT — 🔴 #1 `TokenVerifier` chấp nhận JWT thiếu `exp` (jose chỉ kiểm `exp` khi có mặt).
- Bàn giao: backend-dev — thêm `requiredClaims: ['exp']`

## [2026-09-29 13:10] backend-dev — sửa 🔴 #1
- Đã làm: `token-verifier.ts` thêm `requiredClaims: ['exp']` + cập nhật comment.
- File đổi: be/src/modules/keys/token-verifier.ts
- Kết quả: DONE — `tsc --noEmit` EXIT=0, `eslint src` EXIT=0
- Bàn giao: senior-reviewer — review lại

## [2026-09-29 13:15] senior-reviewer — vòng 2
- Đã làm: xác nhận fix #1; ghi 🟡 #2 (`trustProxy`/`req.ip`) → DEBT-006, 🟡 #3 (rotate xoá PEM trước ghi state) → DEBT-007.
- File đổi: review-senior.md, backlog.md, STATUS.md
- Kết quả: PASS (5/5 task)
- Bàn giao: tester — xem "Lưu ý cho tester" trong review-senior.md

## [2026-09-29 14:30] tester — test B1.6–B1.10
- Đã làm: unit (audit, keys, mailer) + int (indexes, rate-limit, mailer/Mailpit). Suite Nest không chạy được do NestJS 12 ESM-only × Jest CJS → người dùng chọn phương án 1: Jest ESM gốc (`useESM`, `--experimental-vm-modules`, `@jest/globals`). Sửa kèm: guard `require` trong `sync-indexes.ts`, bỏ `redis.quit()` thừa trong rate-limit int-spec, timeout 30s cho `beforeAll` indexes (flaky ở 5s).
- File đổi: be/jest.config.js, be/package.json, pnpm-lock.yaml, be/src/database/mongo/sync-indexes.ts, 2 spec unit, 2 int-spec, test-report.md, summary.md, STATUS.md, tasks.md
- Kết quả: PASS — unit 25/25, int 20/20 (3 lần liên tiếp), tsc/eslint/build EXIT=0, CLI `db:sync-indexes` trên build CJS EXIT=0
- Bàn giao: người dùng — commit run 04
