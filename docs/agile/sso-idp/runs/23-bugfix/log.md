# Log — run 23 — bugfix (DEBT-089/090/091 + liên quan)

## 2026-10-14 — analyst (lượt 1)

**Preflight CodeGraph**: `codegraph` v1.6.2; status OK (index v1.5.0, 206 files); `codegraph sync`
cập nhật 2 file (74 nodes). Đọc code qua CodeGraph CLI + `usages`; terminal = Git Bash.

**Đã đối chiếu code thật** (không ghi đè spec.md/plan.md — run dọn debt, § trỏ nằm trong tasks.md):
- `be/src/common/logger/logger.module.ts`: `REDACT_PATHS` phủ `req.headers.authorization/cookie`,
  `res.headers["set-cookie"]`, `*.code`/`*.token`… NHƯNG **không** phủ `res.headers.location`; có
  serializer `req` (bỏ query) nhưng **không có serializer `res`**. pino default res serializer
  (`pino-std-serializers@7.1.0/lib/res.js`) emit `res.getHeaders()` ⇒ `location` lọt → 302 của
  `/authorize` lộ `code`/`state`. `main.ts` dùng `app.get(Logger)` (nestjs-pino). → **DEBT-089 xác nhận thật.**
- `e2e/config/env.ts` + `playwright.config.ts`: BE webServer `NODE_ENV=test` ⇒ `transport:undefined`
  ⇒ JSON log; `stdout:"pipe"` ⇒ log vào stdout Playwright ⇒ lộ CI. `.env` E2E KHÔNG được nạp dù
  README bảo `cp .env.example .env` (DEBT-090); `KEY_LOCAL_DIR:"./keys"` đụng keyset dev (DEBT-091).
- Int-test inline `27117`/`6479` (vd `authorize.int-spec.ts:40-41`), không có jest `globalSetup`
  ⇒ treo ~10' nếu container test chưa chạy (DEBT-070/054) — gộp làm Task 4.
- `.gitignore`: có `.env`, `be/keys/`; cần thêm pattern `keys-e2e/`.

**Đã tạo**: `runs/23-bugfix/tasks.md` — 4 task (T1 [BE] DEBT-089, T2 [E2E] DEBT-090, T3 [E2E]
DEBT-091, T4 [BE] DEBT-070/054), mỗi task repro + acceptance đo được (RED trước sửa) + security
invariants + § trỏ. Không gộp DEBT-081/092 (ponytail) và 082/083/085 (B5/B6 chưa tới).

**Quyết định mở (đề nghị tech-lead chốt)**:
1. DEBT-089: (A) serializer `res` rút `location`→`origin+pathname` bỏ query (đề xuất) vs (B) redact
   `res.headers.location` remove:true (mất path).
2. DEBT-090: (A) nạp `e2e/.env` (đề xuất) vs (B) bỏ `.env.example` + bước cp.
3. DEBT-091: xác nhận cwd BE webServer (repoRoot) + cách LocalKeyProvider giải `KEY_LOCAL_DIR` trước
   khi chốt literal path `./keys-e2e`.
4. DEBT-070/054: cách gắn `globalSetup` cho `test:int` (`--globalSetup be/test/int-preflight.ts`).

→ Chuyển **tech-lead**.

## 2026-10-14 — tech-lead (lượt 1) — **PASS (kèm fold)**

Preflight CodeGraph v1.6.2 status OK + sync. Đối chiếu: logger.module, main.ts, pino-http@11 /
pino-std-serializers@7.1 (wrapResponseSerializer), keys.module + LocalKeyProvider, e2e env/playwright,
gitignore, jest.config, be/package.json, ci.yml, grep mọi `Logger`/`console.*` trong be/src.

**Chốt** (chi tiết `review-techlead.md`, fold vào `tasks.md`):
1. DEBT-089: `serializeResponse` allow-list `{statusCode, headers:{location}}`, location cắt `?`/`#`
   (không `new URL`), fail-closed. Thay test "spy Logger.prototype" (xanh giả) bằng wiring test
   `pinoHttp(buildPinoHttpOptions('test'), memStream)` + mutation; tester grep log E2E = 0.
   Bề mặt khác: `req.url`/`req.headers` OK (serializeRequest), log tay không in URL/token.
2. DEBT-090: (A) nạp `e2e/.env` (path tuyệt đối, existsSync, không try); bỏ fallback password ⇒ throw.
3. DEBT-091: cwd thực BE = `be/` ⇒ `./keys` = keyset dev (xác nhận). Chốt `KEY_LOCAL_DIR` tuyệt đối
   `e2e/.keys`, ignore ở `e2e/.gitignore`.
4. DEBT-070: `be/test/int-preflight.mjs` qua flag `--globalSetup` trong `test:int` (jest.config không
   đổi); verify RED bằng mutation port, KHÔNG dừng container. DEBT-054 giữ mở.

Backlog: +DEBT-093 (E2E vẫn nạp `be/.env` non-override do cwd `be/`), +DEBT-094 (scrub URI credential trong err log).

→ **backend-dev** T1→T4 ‖ **frontend-dev** T2→T3 (song song, không chung file). Sau đó tester.

## 2026-10-14 — frontend-dev (T2, T3)

Preflight CodeGraph v1.6.2 (status OK, sync). Đọc tasks/review + env.ts/playwright.config/LocalKeyProvider/ci.yml qua CLI.
T2 DEBT-090: env.ts nạp e2e/.env (path tuyệt đối, existsSync, process.loadEnvFile — KHÔNG try); bỏ fallback `dev-password-123` ⇒ thiếu DEV_SEED_PASSWORD → throw rõ. CI job e2e env: đã có password giả (không đổi). Cập nhật .env.example + README.
T3 DEBT-091: KEY_LOCAL_DIR = resolve(<e2e>, ".keys") tuyệt đối; thêm `.keys/` vào e2e/.gitignore; README ghi isolation.
Verify: typecheck xanh; `pnpm -C e2e e2e` → 1 passed (27.9s). hash be/keys/keys.json TRƯỚC=02830f97…4721 SAU=02830f97…4721 (không đổi); e2e/.keys tự tạo keyset riêng. git check-ignore e2e/.keys/x & e2e/.env khớp; git status không có .env/.keys/.pem. Fail-fast: thiếu password → throw đúng message. KHÔNG đụng be/.
→ đề nghị senior-reviewer.

## [2026-10-14 14:05] backend-dev (T1, T4)
- Đã làm: T1 DEBT-089 export `serializeResponse` (allow-list `{statusCode,headers:{location?}}`, scrub `split(/[?#]/,1)[0]` fail-closed khi non-string) + `buildPinoHttpOptions`; gắn `serializers.res` vào pino-http, giữ REDACT_PATHS. T4 DEBT-070 thêm `be/test/int-preflight.mjs` TCP-probe 27117/6479 timeout 2s, gắn CHỈ qua `--globalSetup` trong script `test:int` (jest.config.js không đổi).
- File đổi: be/src/common/logger/logger.module.ts, logger.module.spec.ts, be/test/int-preflight.mjs (mới), be/package.json.
- Kết quả: DONE — typecheck + lint sạch; `pnpm -C be test` 197 pass/18 suite (KHÔNG chạy globalSetup); `pnpm -C be test:int` 482 pass/23 suite. Mutation T1 (bỏ serializers.res) => RED lộ SECRET_CODE/SECRET_STATE qua location; khôi phục => GREEN. Mutation T4 (port 27117->1, KHÔNG dừng container) => fail 1s với message `docker start vg-test-mongo vg-test-redis`; khôi phục byte-identical.
- Bàn giao: senior-reviewer — review T1/T4; e2e grep (fold case 4) do tester sau khi T2/T3 xong.

## 2026-10-14 14:30 — senior-reviewer — REJECT
- Review T1–T4 đối chiếu tasks.md + review-techlead.md. Ghi `runs/23-bugfix/review-senior.md`.
- Tự kiểm chứng (khôi phục byte-identical, sha256 trùng): mutation bỏ `serializers.res` ⇒ RED, bỏ `serializers.req` ⇒ RED; unit 197/197; typecheck be+e2e, eslint sạch; `loadEnvFile` không override (kể cả biến rỗng), nội dung hỏng KHÔNG ném; preflight port đóng ⇒ throw ~0.2s.
- 🔴 [BE] allow-list `res` loại `x-request-id` ⇒ access log mất hoàn toàn request-id (B1.3, docstring L11 sai). Đề xuất `serializeRequest` trả thêm `id` + assert presence trong wiring test.
- 🟡 [E2E] comment "corrupt .env must throw" sai; 🟡 [BE] preflight bỏ qua `TEST_MONGO_URI`/`TEST_REDIS_URL`; 🟡 [BE] assert `'302'` yếu. Ponytail net -20.
- → backend-dev (🔴 + 🟡2/3); frontend-dev tùy chọn 🟡1.

## [2026-10-14 14:30] backend-dev (retry 1)
- Đã làm: 🔴 request-id — `serializeRequest` trả thêm `id: req.id` (giữ allow-list `res`), sửa docstring L11; wiring test parse JSON ở dòng `request completed`, assert `req.id`, `res.statusCode===302`, `res.headers.location===https://rp.example/cb`, `Object.keys(res.headers)===[location]` (🟡3). 🟡2 `int-preflight.mjs` đọc `TEST_MONGO_URI`/`TEST_REDIS_URL` (`new URL`, fallback localhost:27117/6479; URI hỏng → fallback); harden probe (unref + settled guard, hết leak handle). 🟡1 sửa comment `e2e/config/env.ts` cho đúng `loadEnvFile` (file hỏng-nội-dung KHÔNG ném; guard thật là kiểm thiếu password). Ponytail: rút docstring `serializeResponse` 14→6 dòng.
- File đổi: be/src/common/logger/logger.module.ts, logger.module.spec.ts, be/test/int-preflight.mjs, be/package.json, e2e/config/env.ts (chỉ comment).
- Kết quả: DONE — typecheck(be+e2e)/lint xanh; `pnpm -C be test` 198 pass/18 suite (KHÔNG globalSetup); `pnpm -C be test:int` 482 pass/23 suite exit 0. Mutation 🔴 (bỏ `id` khỏi serializeRequest) ⇒ unit + wiring RED (`req.id`); khôi phục byte-identical ⇒ GREEN. 🟡2 verify thủ công: override→real OK, override→port đóng throw `localhost:9`, URI hỏng fallback OK. T4 mutation (default port→1, KHÔNG dừng container) ⇒ fail 1s msg `docker start vg-test-mongo vg-test-redis`; khôi phục byte-identical.
- Lưu ý: thêm `--forceExit` vào `test:int` — globalSetup khiến jest exit≠0 do DEBT-054 (open handles ioredis teardown) dù 482 pass; `--forceExit` ⇒ exit 0, preflight vẫn fail-fast. DEBT-054 vẫn mở (ngoài phạm vi).
- Bàn giao: senior-reviewer (lượt 2) — review 🔴 + 3 🟡 + `--forceExit`; e2e grep (fold case 4) do tester.

## [2026-10-14 14:55] senior-reviewer (lượt 2) — PASS
- Đã làm: xác minh 🔴 request-id đóng (tự mutation bỏ `id` ⇒ RED 2/8, khôi phục sha256 trùng); 🟡1–3 lượt 1 sửa đúng; unit 198, int 482 exit 0, typecheck be+e2e, eslint sạch. `--forceExit`: test RED ⇒ exit 1, preflight fail ⇒ exit 1 (không che lỗi).
- Phát hiện: Fastify `request.id` (audit, counter `req-N`) ≠ id pino-http (access log) ⇒ không nối audit↔log (có từ trước; docstring hứa sai); `x-request-id` client không validate. Không 🔴 (JSON-escape, audit không dùng id client).
- File đổi: runs/23-bugfix/review-senior.md, backlog.md (+DEBT-095/096/097), STATUS.md.
- Kết quả: PASS — 🔴 đã đóng; 🟡 vào backlog.
- Bàn giao: tester — chạy lại unit/int/E2E + grep log E2E (fold case 4), xác nhận `req.id` trong dòng `request completed`.

## 2026-10-14 — tester — **PASS**

Preflight CodeGraph v1.6.2 (index up-to-date). Terminal = Git Bash. KHÔNG compose up / FLUSH / drop /
dừng container. Không sửa code sản phẩm; test hiện có phủ đủ acceptance (không bổ sung).

- **Chạy thật**: `pnpm -C be typecheck`/`lint`=0; E2E typecheck=0; `pnpm -C be test` **198/198** exit 0
  (KHÔNG chạy globalSetup — xác nhận unit ≠ int); `pnpm -C be test:int` **482/482** exit 0
  (`vg-test-mongo@27117`+`vg-test-redis@6479`). Preflight fail-fast: `TEST_MONGO_URI=…localhost:1` ⇒
  globalSetup throw nêu `vg-test-mongo (localhost:1)` + `docker start`, **exit 1 trong 1.67s**
  (`--forceExit` không che fail). KHÔNG đụng container thật.
- **E2E thật** `DEBUG=pw:webserver pnpm -C e2e e2e` ⇒ **1 passed (27.9s)**; thu toàn bộ stdout/stderr BE
  webServer (210 dòng log, 103 `[WebServer]` pino JSON). **Grep sạch**: `code=`/`state=`/`id_token_hint=`/
  `login_hint=`/`idp_session=`/`set-cookie`/`authorization`/password E2E/raw JWT `eyJ` = **0**; **9** dòng
  `request completed`, **9/9 có `req.id`**; `res.headers` chỉ allow-list `location` đã cắt query
  (`GET /authorize`→`http://localhost:5173/callback`, không `?code=&state=`).
- **Keyset/ignore**: `be/keys/keys.json` sha256 trước=sau `02830f97…d7e4721` (KHÔNG đổi); `be/keys` git
  clean; `e2e/.keys/keys.json` tồn tại; `git check-ignore` OK cho `e2e/.env` (`.gitignore:6`) + `e2e/.keys/`
  (`:8`); 0 file `.pem`/key track.
- **Đóng DEBT**: 089/090/091/070 (bảng "Đã đóng" trong test-report.md). Giữ mở: 054 (ngoài phạm vi T4),
  095/096/097 (senior). Chi tiết + output: `runs/23-bugfix/test-report.md`.
- Dọn file rác gốc repo (`=12`,`=23` từ tool trước) + script grep tạm trong `e2e/.keys` (git-ignored, đã xoá).
- Bàn giao: **orchestrator** đóng run (cổng tester PASS). Code chưa commit — out-of-scope `.vscode/mcp.json`,
  `.mcp.json`, `.github/agents/*` đừng commit chung run này.

## [2026-10-14] orchestrator
- Đã làm: commit `8a36ae4`; viết `summary.md`; cập nhật `STATUS.md`.
- Kết quả: DONE — run 23 đóng.
