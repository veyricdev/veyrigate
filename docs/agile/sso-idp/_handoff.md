# Handoff — sso-idp
- Trạng thái: DONE (B1.1–B1.5) — tester PASS
- Agent hiện tại: tester
- Cổng gần nhất: **tester** — verify B1.1–B1.5 (chạy thật, đọc EXIT/HTTP/time)
- Kết quả cổng: **PASS (9/9 case · 0 fail · 0 pending)**. Điểm chốt: `/ready` khi Redis DOWN → **503 @ 1.72s/1.71s (KHÔNG treo)**; UP → 200@0.22s; fail-fast thiếu `MONGO_URI` → **EXIT=1** + nêu tên biến + không listen; INV-20 redact runtime proof → **0 leak** (secret bị remove, non-secret giữ); PKCE **RFC 7636 Appendix B** vector pass (test 10/10, EXIT=0); typecheck/lint/build 3× EXIT=0; **không còn Express** (`why express` rỗng, lockfile không resolve); Lua `defineCommand` chạy thật trên Redis → `["mykey","myarg",42]`.
- Việc tiếp theo: **HOÀN TẤT B1.1–B1.5**. Sang nhóm kế B1.6–B1.10 (schema/audit/rate-limit/keys/mailer) theo `_run-plan.md`.
- 🟡 mở (không chặn, ngoài phạm vi B1.1–B1.5): #1 `/ready` 503 body bị ép OAuth-format (`{"error":"server_error","error_description":"Service Unavailable Exception"}`) → mất chi tiết per-dependency `mongo`/`redis`; status 503 vẫn đúng nên acceptance đạt. Đề xuất filter riêng cho health/ready ở vòng sau. #2 `validateEnv` gọi 2 lần lúc boot (senior) — gọn lại khi tiện.
- Vòng lặp: analyst=0, dev/senior=0, dev/tester=0
- Phạm vi lần chạy này: chỉ VERIFY B1.1–B1.5 — KHÔNG sửa code sản phẩm (không đổi file `be/src/**`). Mọi env/script proof tạm đã xoá; `be/.env` restore (gitignored). Port 4000 free.

## Bug đã sửa (chặn nghiệm thu B1.3) — FIXED (readiness ping treo khi Redis down)
- **Triệu chứng**: chạy app với `REDIS_URL=redis://localhost:6399` (port đóng), mongo up. `GET /health` → 200 (đúng). `GET /ready` → **TREO** (`curl -m 4` trả HTTP=000; log app `request aborted ... statusCode:null ... responseTime:3802ms`). Redis liên tục `Redis error` retry. ⇒ nghiệm thu B1.3 "/ready đỏ (503) khi Redis/Mongo down" KHÔNG đạt (treo thay vì 503 nhanh).
- **Nguyên nhân**: client ioredis dùng `maxRetriesPerRequest: null` (hợp lý cho client long-lived) → khi Redis down, `ping()` bị **enqueue chờ reconnect vô hạn** thay vì fail nhanh. `RedisService.ping()` gọi trực tiếp không timeout; `health.controller.ts safePing()` bắt exception nhưng không bao timeout → chờ mãi.
- **Fix (surgical)**: chỉ sửa `be/src/modules/health/health.controller.ts` — thêm hằng `PING_TIMEOUT_MS = 1500` và bọc `safePing()` bằng `Promise.race([ping(), timeout(1500ms→false)])`. Khi ping không phản hồi trong 1.5s → coi là down → `/ready` trả **503 nhanh**. `clearTimeout` trong `finally`; gắn `ping.catch(()=>undefined)` để tránh unhandled rejection từ promise còn treo (ioredis giữ queued). **KHÔNG đổi `maxRetriesPerRequest` của client dùng chung** (giữ nguyên cho data-access), KHÔNG đổi `redis.module.ts`/`redis.service.ts`/`mongo.service.ts`/`main.ts`.

## Kết quả verify THẬT (đọc EXIT code + HTTP status + time_total)
- `pnpm --filter @sso-idp/be typecheck` → EXIT=0
- `pnpm --filter @sso-idp/be lint` → EXIT=0
- `pnpm --filter @sso-idp/be test` → EXIT=0 (2 suite, 10/10 test PASS)
- `pnpm --filter @sso-idp/be build` → EXIT=0
- Runtime (env tạm từ `be/.env` — gitignored, KHÔNG commit; mongo:7@27017 + redis:7@6379 `(healthy)`):
  - **Redis UP** (`REDIS_URL=redis://localhost:6379`): `/health` → **200** (`TIME=0.21s`); `/ready` → **200** (`{"status":"ok","mongo":"up","redis":"up"}`, `TIME=0.21s`). Nhanh.
  - **Redis DOWN** (`REDIS_URL=redis://localhost:6399` port đóng, mongo up): `/health` → **200** (`TIME=0.22s`); `/ready` → **503** (`{"error":"server_error","error_description":"Service Unavailable Exception"}`, `TIME=1.73s`) — **KHÔNG treo**. Lặp 2 lần: 503 @ 1.73s / 1.71s (ổn định).
  - Đã kill app + free port 4000 sau verify. `be/.env` gitignored (`git check-ignore be/.env` EXIT=0) → KHÔNG commit env tạm. File source đổi duy nhất: `be/src/modules/health/health.controller.ts`.
  - Ghi chú: nhánh 503 vẫn qua `OAuthExceptionFilter` nên body là format OAuth (🟡 #1 của senior — chỉ ảnh hưởng body, KHÔNG ảnh hưởng status 503; nằm NGOÀI phạm vi task này). Case mongo-down là optional; mongoose chặn bootstrap khi mongo unreachable (lifecycle riêng, không thuộc bug readiness ping) — chưa verify trong lần này.

- Nguồn: plan §5.B1 + spec §5 (cấu trúc) + §13
- Lưu ý cho backend-dev (từ review-techlead.md §3): (1) gỡ Express + pin `@nestjs/*` cùng major, check lockfile; (2) **argon2 native build trên Windows** — fallback `@node-rs/argon2` nếu node-gyp fail; (3) đề xuất **zod** cho B1.2 (type-infer); (4) module domain chỉ tạo rỗng đủ build (stub `@Module({})`), không import module rỗng vào AppModule; (5) không hardcode TTL/issuer — đọc từ config (Q6/Q9 chưa chốt nhưng không chặn).
- Không có quyết định plan §12 (Q1–Q9/D1–D12) nào chặn B1.1–B1.5.
- Đã xong trước đó: Phase R (M0) — R1–R5 (commit 8b75f24 + 4c2104a)

---
### (lịch sử) R3 · R4 · R5 — DONE
- Cổng gần nhất trước đó: tester PASS (11/11 case, 0 pending)
- Phạm vi lần chạy này: R3 (agent workspace — verify+doc), R4 (CI GitHub Actions), R5 (.env.example §1.4 + gitleaks pre-commit + README 5 phút)
- File mới: `.github/workflows/ci.yml`, `be/.env.example`, `fe-admin/.env.example`, `fe-sso-test/.env.example`, `.pre-commit-config.yaml`
- File sửa: `README.md`, `tasks.md`, `test-report.md`
- Verify tester (chạy thật): 11/11 case PASS. ci.yml + .pre-commit-config.yaml YAML VALID (js-yaml@4.1.0); job `quality` đủ bước + job `e2e` mongo:7/redis:7 healthcheck (grep); 3 `.env.example` đủ biến §1.4; `.env.example` KHÔNG bị gitignore (check-ignore EXIT=1, `.env`/`.env.local` bị loại); **secret scan THẬT PASS** — gitleaks v8.21.2 qua Docker phát hiện private-key giả (EXIT=1, đã xoá file tạm) ⇒ KHÔNG pending; `pnpm i --frozen-lockfile` EXIT=0
- Đã xong trước đó: R1–R2 (commit 8b75f24, 8/8 case PASS)
