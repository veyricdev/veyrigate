# Log — run 19 — bugfix (debt là lỗi thật)

## analyst — run 19 (bugfix)

- Preflight CodeGraph: v1.6.2, status OK (index v1.5.0 → `codegraph sync` 1 file, 67 nodes). Đọc code qua CLI/awk, terminal = Git Bash.
- Rà 29 DEBT mở trong `backlog.md`. Xác minh với code thật, chọn 5 **lỗi thật** (severity × chi phí thấp) cho run 19:
  - **Task 1 DEBT-059** — `token.service.ts:139` audit `TOKEN_ISSUED success` ghi TRƯỚC controller re-check (`token.controller.ts:196–215`); nhánh không-family không có event bù ⇒ audit sai.
  - **Task 2 DEBT-055** — `authentication.service.ts:174–200`: revoke lỗi sau `setPassword` ⇒ exception trước audit L194 ⇒ password đổi nhưng không audit nào.
  - **Task 3 DEBT-060** — `consent.service.ts:122–148`: upsert không try/catch ⇒ race `E11000` → 500; thiếu retry-once.
  - **Task 4 DEBT-001** — `health.controller.ts:42–53` ném 503 chi tiết, nhưng global `OAuthExceptionFilter` (`app.module.ts:34`, `oauth-exception.filter.ts:52–79`) ép `{error:'server_error'}` ⇒ mất `mongo`/`redis`.
  - **Task 5 DEBT-005** — `redis.module.ts:22–26`: `maxRetriesPerRequest:null` + không `commandTimeout` ⇒ lệnh request-path treo khi Redis down (health đã tự vá riêng, request-path thì chưa).
- Mỗi task: nhãn [BE], bằng chứng/repro, acceptance đo được (RED trước khi sửa), security invariants, § trỏ. Quyết định chưa chốt (DEBT-059 vị trí audit; DEBT-001 cách loại route health; DEBT-005 giá trị `commandTimeout`) đã ghi + đề xuất phương án an toàn cho tech-lead.
- Đề xuất **run 20** (lỗi thật còn lại, không làm run 19): DEBT-029+039 (rate-limit /token,/introspect — cần chốt nguồn `client_id` basic-auth), DEBT-007 (atomic key rotate, dev-only), DEBT-021 (rotateSecret atomic + unique index, gắn B6.3), DEBT-053 + DEBT-061 (doc fixes rẻ).
- Loại trừ: ponytail/refactor (062/025/042), feature/milestone (B5/B6/X3/deploy: 013/016/017/030/031/032/044/047/048/049), test-infra không chặn (054), đã đóng run 18 (050/051/052/056–058).
- **KHÔNG sửa spec.md/plan.md** (giữ nguyên theo giao thức). Chỉ tạo `runs/19-bugfix/tasks.md`.
- Cổng: analyst ✅ → đề nghị chuyển **tech-lead**.

## tech-lead — run 19 (bugfix)

- Preflight CodeGraph: v1.6.2, `status` OK, `sync` up to date. Đọc code qua CLI `codegraph node`, terminal = Git Bash.
- Đối chiếu code thật: cả 5 mục đều là lỗi thật. DEBT-060 là lỗi tiềm ẩn (Mongo ≥4.2 tự retry upsert E11000), giữ làm phòng thủ nhiều lớp.
- **Kết luận: PASS**, các chỉnh sửa đã fold vào `tasks.md` (*(tech-lead fold)*). Chốt:
  - QĐ-1 DEBT-059: `TokenService.recordIssued` do controller gọi SAU re-check `live`, TRƯỚC send. `!live` ⇒ `TOKEN_ISSUED failure session_ended` (cả 2 nhánh; có family thì thêm `TOKEN_REVOKED`). Redis lỗi ⇒ `failure session_check_failed` best-effort + 500. Audit success lỗi ⇒ revoke family + 500.
  - QĐ-2 DEBT-001: controller trả 503 trực tiếp (`@Res({passthrough:true})`), KHÔNG sửa filter global. Body chỉ enum up/down + `no-store`. Đóng kèm DEBT-003.
  - QĐ-3 DEBT-005: `REDIS_COMMAND_TIMEOUT_MS` default 1000; `maxRetriesPerRequest` null→1 (offlineQueue replay, đã kiểm source ioredis 6.0.0); tách `buildRedisOptions`. Lua/rate-limit/tombstone vẫn fail-closed; int test hiện có không bị ảnh hưởng.
  - Fold T2: chạy đủ 3 bước revoke dù có bước lỗi, audit `failedStep`, rethrow lỗi đầu tiên.
- Backlog mới: DEBT-063 (UX/alert khi reset bị lỗi revoke), DEBT-064 (giới hạn `/ready` ở mạng nội bộ).
- Cổng: tech-lead ✅ → **backend-dev** (thứ tự T1→T2→T3→T4→T5).
## [2026-10-12 17:22] backend-dev
- Đã làm: T1–T5 (DEBT-059/055/060/001+003/005), RED-first mỗi bug rồi GREEN. File đổi: token.service.ts (+recordIssued, bỏ audit trong issueForAuthorizationCode), token.controller.ts (recordIssued sau re-check: success→send / audit-fail→revoke+500; !live→failure session_ended cả 2 nhánh; redis err→session_check_failed best-effort+500), authentication.service.ts (3 bước revoke chạy đủ, giữ lỗi đầu, audit failure failedStep, rethrow), consent.service.ts (tách upsertGrant, retry-once code===11000), health.controller.ts (/ready trả 503 trực tiếp @Res + no-store, bỏ ServiceUnavailableException), redis.module.ts (export buildRedisOptions, commandTimeout + maxRetriesPerRequest 1), config (REDIS_COMMAND_TIMEOUT_MS zod default 1000/max 10000 → DatabaseConfig) + .env.example. Specs: token.service.spec, token.int-spec (DEBT-059 x4), authentication.service.spec (DEBT-055 x3 viết lại 2 + thêm 1), consent.service.spec (mới x4), health.int-spec (mới x5), redis-fail-fast.int-spec (mới x4), validation.schema.spec (+3).
- Kết quả: DONE — typecheck/lint sạch; pnpm test 141/141; pnpm test:int 413/413 (tổng 554, trước 531, +23, không giảm test). RED chứng minh: DEBT-005 old-options pending>2.5s; DEBT-060 retry=2 lần gọi; DEBT-001 503 body giữ mongo/redis không bị server_error.
- Bàn giao: senior-reviewer — review 5 task, đặc biệt fail-closed audit (INV-25/29), revoke 3-bước, filter không đổi.

## [2026-10-13 08:xx] senior-reviewer
- Preflight CodeGraph v1.6.2 (`sync`: up to date). Terminal Git Bash.
- Bước 0: so `git diff` nguồn với tasks.md/log dev ⇒ **không có mutation sót**, không phải khôi phục. Phát hiện comment test bị PowerShell escape (byte `\x08`) ⇒ 🟡 DEBT-065.
- Baseline: unit 141/141, int 413/413, typecheck/lint 0. (int cần `docker start vg-test-mongo vg-test-redis`; lần đầu container dừng ⇒ timeout hạ tầng, không phải lỗi code ⇒ DEBT-070.)
- Mutation 16 mutant (DEBT-059 ×6, 055 ×4, 060 ×2, 005 ×3, 001 ×1): 15 KILLED; 1 SURVIVED (bỏ `commandTimeout` khi chỉ chạy test hành vi, vì `127.0.0.1:1` bị refused) ⇒ DEBT-066. Mỗi mutant khôi phục ngay, sha256 khớp baseline (5 file).
- `redis-fail-fast` + `health` chạy 5 lần với `--detectOpenHandles`: xanh, không có open handle.
- **Kết luận: PASS**. 0 🔴; 6 🟡 → DEBT-065…070 (065 comment hỏng, 066 test blackhole, 067 `!live` revoke ném thì mất audit failure, 068 trùng `refresh`, 069 ponytail -24 dòng, 070 preflight hạ tầng int). Ghi `runs/19-bugfix/review-senior.md`.
- Bàn giao: **tester**.
## [2026-10-13 09:15] tester
- Preflight CodeGraph OK. Terminal Git Bash. ??c STATUS/tasks/review-senior/backlog.
- **DEBT-065 (s?a file test, ???c ph?p)**: kh?i ph?c backtick + xo? byte `\x08` trong 3 file test m?i (`redis-fail-fast.int-spec.ts`, `health.int-spec.ts`, `consent.service.spec.ts`) b?ng Node string-replace. X?c minh 0 control byte, kh?ng BOM.
- **DEBT-066 (ch? th?m test ? ??ng)**: th?m case `net.createServer` accept-nh?ng-im-l?ng (blackhole) v?o `redis-fail-fast.int-spec.ts` (`GREEN(DEBT-066)`). `get` reject `Command timed out` ~1040ms (? commandTimeout+500ms); teardown s?ch (`--detectOpenHandles` kh?ng c?nh b?o). **Mutant-kill x?c nh?n**: t?m b? `commandTimeout` kh?i `buildRedisOptions` ? case DEBT-066 FAIL (jest timeout 10s) c?n c?c case `127.0.0.1:1` refused v?n PASS ? ch?ng minh ch? `commandTimeout` c?t treo blackhole. Ngu?n ?? kh?i ph?c (`diff`=IDENTICAL), kh?ng residue.
- **DEBT-067**: ?i?u tra `token.controller` nh?nh `!live` ? `revokeFamilyForEndedSession` n?m TR??C `recordIssued failure session_ended` ? m?t audit t? ch?i (v?n fail-closed 500). L? **l?i ordering code**, KH?NG s?a (quy t?c code sai ? tr? dev). Gi? DEBT-067 **m?**, ghi r? ? backlog + test-report (T-067). Kh?ng ch?n PASS (kh?ng bypass/over-grant/r? secret; ch? thi?u 1 d?ng audit nh?nh hi?m).
- **Full suite TH?T**: typecheck 0, lint 0, `pnpm test` **141/141** unit, `pnpm test:int` **414/414** int (21 suite PASS) = **555** t?ng (baseline 554, +1 do DEBT-066). 0 fail. (Log int c? `ERROR redis down` l? output c? ? c?a test ?m; jest exit?0 do eventual-rejection sau teardown ? DEBT-070 ? kh?ng ph?i fail.)
- B?o c?o: `runs/19-bugfix/test-report.md` (b?ng acceptance?test?PASS/FAIL + risk matrix). Backlog: DEBT-065/066 ? "?? ??ng"; DEBT-067 m? (tr? backend-dev).
- **C?ng tester: PASS**. B?n giao: orchestrator ??ng run (DEBT-067 sang run k?).
