# Tech Lead Review — 2026-10-14 (run 23-bugfix)

## Kết luận: PASS (kèm chỉnh sửa — đã fold vào `tasks.md`, đánh dấu *(tech-lead fold)*)

Preflight CodeGraph: v1.6.2, `status` OK, `sync` xong. Đã đối chiếu code thật: `logger.module.ts`,
`main.ts`, `pino-http@11.0.0/logger.js` + `pino-std-serializers@7.1.0` (res serializer, wrap),
`keys.module.ts`/`local-key-provider.ts`, `e2e/config/env.ts`, `e2e/playwright.config.ts`,
`.gitignore`/`e2e/.gitignore`, `be/jest.config.js`, `be/package.json`, `.github/workflows/ci.yml`,
grep toàn bộ `Logger`/`console.*` trong `be/src`.

## Kiến trúc đề xuất

Không đổi kiến trúc (modular monolith). Chỉ sửa cấu hình log, test harness, config E2E.

## Quyết định chốt

### (1) DEBT-089 — log scrub: **allow-list serializer `res`** (biến thể chặt hơn phương án A)
- `serializers.res` custom (export `serializeResponse`) trả **chỉ** `{ statusCode, headers: { location? } }`
  — allow-list, KHÔNG trả `res.getHeaders()`; `set-cookie`, `x-request-id`… bị loại theo cấu trúc,
  không phụ thuộc redact path.
- `location` rút bằng cắt chuỗi `split(/[?#]/, 1)[0]` (KHÔNG `new URL`: location tương đối như
  `/login?returnTo=…` sẽ ném). Giữ origin+path (tuyệt đối) hoặc path (tương đối); bỏ cả query **và**
  fragment. `location` không phải string/khuyết ⇒ bỏ key (fail-closed). Lý do giữ path: debug redirect
  sai RP rẻ, rủi ro bằng 0 (redirect_uri path đã đăng ký, không mang secret).
- pino-http bọc serializer qua `wrapResponseSerializer` ⇒ hàm custom nhận object `{statusCode, headers, raw}`
  đã map — viết theo shape này, đọc `headers.location`.
- Giữ `REDACT_PATHS` (defense-in-depth cho log tay).
- Cơ chế lộ thật (đã kiểm Node/Fastify): Fastify gửi header qua `res.writeHead(status, headers)`; vì
  `genReqId` đã `res.setHeader('x-request-id')` trước đó, Node gộp mọi header vào `getHeaders()` ⇒
  `location` vào log. Wiring test phải tái tạo đúng chuỗi này (setHeader trước, `writeHead(302,{Location,…})` sau).
- **Bề mặt log đã rà** (kết quả):
  | Bề mặt | Trạng thái | Ghi chú |
  |---|---|---|
  | `res.headers.location` (302 `/authorize`→RP `code`/`state`/`iss`; `/login?returnTo=<authorize URL có login_hint/nonce/code_challenge>`; `/logout`→`post_logout_redirect_uri?state=`) | **LỘ → sửa T1** | allow-list + scrub |
  | `res.headers["set-cookie"]` (`idp_session`) | đang redact; sau T1 bị loại bởi allow-list | test âm bắt buộc |
  | `req.url` (`/authorize?…`, `/logout?id_token_hint=…`, `/verify-email?token=`) | OK — `serializeRequest` bỏ query | giữ + thêm case `id_token_hint`/`login_hint` |
  | `req.headers` (`authorization`, `cookie`) | OK — `serializeRequest` chỉ trả `method`+`url` | test âm bắt buộc |
  | Route có secret trong path param | Không có (grep `@Get(':…')` rỗng) | — |
  | Body `/token`, `/introspect` | pino-http không log body | — |
  | Log tay (`OAuthExceptionFilter`, `token/introspect.controller` in `err.stack`; mongo/redis `err.message`; audit; client-auth; ui; keys) | Không in URL/query/header/token | rủi ro thấp còn lại → DEBT-094 |
  | `seed-dev` `console.log` email | dev-only, không password/hash | chấp nhận |
- **Test bắt buộc** (thay cách "spy `Logger.prototype`" của analyst — **sai cơ chế**: pino-http ghi
  thẳng pino stream, không đi qua Nest `Logger`, spy sẽ luôn xanh giả):
  1. Unit `serializeResponse`: absolute `https://rp.example/cb?code=C&state=S#x` ⇒ `https://rp.example/cb`;
     relative `/login?returnTo=%2Fauthorize%3Flogin_hint%3DL` ⇒ `/login`; khuyết/non-string ⇒ không có key
     `location`; input có `set-cookie`/`x-request-id` ⇒ output không có.
  2. Unit `serializeRequest` thêm: `/logout?id_token_hint=H&state=S`, `/authorize?login_hint=L&code_challenge=P` ⇒ chỉ path.
  3. **Wiring test** (đo đường log thật): tách `useFactory` thành hàm export `buildPinoHttpOptions(nodeEnv)`
     (LoggerModule dùng lại chính hàm này); test dựng `pinoHttp(buildPinoHttpOptions('test'), <memory stream>)`
     + `node:http` server trả 302 `Location: https://rp.example/cb?code=SECRET_CODE&state=SECRET_STATE#frag`
     + `Set-Cookie: idp_session=SECRET_SID`; request có query `id_token_hint=SECRET_HINT&login_hint=SECRET_LH`
     và header `authorization: Bearer SECRET_AT`, `cookie: idp_session=SECRET_SID`. Assert output log
     **không chứa** bất kỳ `SECRET_*` nào, **có** `https://rp.example/cb` và `302`. Mutation: bỏ
     `serializers.res` ⇒ RED (chứa `SECRET_CODE`), khôi phục ⇒ GREEN. Ghi bằng chứng vào log.md.
  4. E2E log check (khả thi — webServer `stdout:"pipe"` đẩy log BE ra stdout Playwright): tester chạy
     `pnpm -C e2e e2e 2>&1 | grep -cE 'code=|state=|id_token_hint=|login_hint=|idp_session='` ⇒ `0`
     (đồng thời E2E pass). Trước fix kỳ vọng > 0 (bằng chứng RED nếu tester có log cũ).

### (2) DEBT-090 — **(A) nạp `e2e/.env`** + bỏ fallback password
- `e2e/config/env.ts`: ở đầu module, path tuyệt đối từ `import.meta.url` (`<repo>/e2e/.env`), `existsSync`
  rồi `process.loadEnvFile(path)` (không bọc try — file hỏng phải ném; Node 22 không override biến đã có
  ⇒ CI `env:` vẫn thắng). Không phụ thuộc cwd.
- `DEV_SEED_PASSWORD`: **bỏ `?? "dev-password-123"`**; thiếu/rỗng ⇒ `throw` thông báo nêu tên biến +
  hướng dẫn (`e2e/.env` hoặc env). Ném tại load config ⇒ fail trước khi khởi webServer. `DEV_SEED_EMAIL`
  giữ default `dev@example.com` (không bí mật).
- Password giả chỉ còn ở `ci.yml` job `e2e` `env:` (scope 1 job, DB service tạm). Seed đã chặn
  `NODE_ENV=production` + min 8 ký tự. ⇒ không còn mặc định đoán được chạy ngoài E2E.
- README: giữ bước `cp`, ghi rõ thiếu password ⇒ fail.

### (3) DEBT-091 — key E2E: **path tuyệt đối `<repo>/e2e/.keys`**, ignore trong `e2e/.gitignore`
- Xác nhận code: webServer `cwd: repoRoot` nhưng lệnh `pnpm -C be start` ⇒ `node dist/main.js` chạy
  với **cwd = `be/`**; `LocalKeyProvider` dùng `join(this.dir, …)` + `mkdir(recursive)` ⇒ giải theo
  `process.cwd()` ⇒ `./keys` = **`be/keys` (keyset dev) — DEBT-091 xác nhận thật**.
- Chốt `KEY_LOCAL_DIR = resolve(<e2eDir>, ".keys")` tính trong `env.ts` (tuyệt đối, miễn nhiễm cwd).
  Thêm `.keys/` vào `e2e/.gitignore`. Không đụng `be/` hay `.gitignore` gốc ⇒ T3 thuần phạm vi e2e.
- CI: checkout sạch ⇒ `init()` tự tạo thư mục + key; không cache/upload thư mục này.
- Verify: `sha256sum be/keys/keys.json` (nếu có) trước/sau E2E **không đổi**; `e2e/.keys/keys.json` tồn tại;
  `git check-ignore -v e2e/.keys/keys.json` trả `e2e/.gitignore`; `git status --porcelain` không có `.pem`.

### (4) DEBT-070 — globalSetup **chỉ** qua flag trong script `test:int`
- File `be/test/int-preflight.mjs` (JS thuần, `export default async`, `node:net` — tránh rủi ro
  ts-jest transform ESM cho globalSetup). Script: `… jest.js --runInBand --globalSetup ./test/int-preflight.mjs --testRegex …`.
- `jest.config.js` **không đổi** ⇒ `pnpm test` (unit, regex `.*\.spec\.ts$`, không khớp `.int-spec.ts`) không bị ảnh hưởng.
- Probe song song `localhost:27117` + `localhost:6479` (cùng host int-spec dùng), timeout 2s mỗi cái; lỗi ⇒
  `throw` nêu port + tên container + `docker start vg-test-mongo vg-test-redis`.
- **Verify RED KHÔNG được dừng container** (luật hạ tầng): mutation tạm đổi port probe sang port đóng
  (vd `1`) ⇒ `pnpm -C be test:int -- test/health.int-spec.ts` fail < 10s với message đúng; khôi phục ⇒ xanh.
  Đo `pnpm -C be test` vẫn xanh + không chạy preflight.
- DEBT-054 (open handles): **ngoài phạm vi** run này — giữ mở. T4 chỉ đóng DEBT-070.

## Phân công

| Task | Agent | File chạm | Song song |
|---|---|---|---|
| T1 DEBT-089 | **backend-dev** | `be/src/common/logger/logger.module.ts`, `logger.module.spec.ts` | ✅ với FE |
| T4 DEBT-070 | **backend-dev** (sau T1, cùng lượt) | `be/test/int-preflight.mjs`, `be/package.json` | — |
| T2 DEBT-090 | **frontend-dev** | `e2e/config/env.ts`, `e2e/README.md`, `e2e/.env.example` | ✅ với BE |
| T3 DEBT-091 | **frontend-dev** (cùng lượt, sau T2 — chung `env.ts`) | `e2e/config/env.ts`, `e2e/.gitignore`, `e2e/README.md` | — |

BE và FE không chung file ⇒ chạy song song. E2E log check (T1-4) + verify T3 do **tester** chạy sau khi cả hai xong.

## Điểm mạnh
- Repro đúng, bằng chứng trỏ tới thư viện thật (pino-std-serializers res.js); xác định đúng lộ log CI.
- Mỗi task có security invariants + fail-closed rõ; phạm vi gọn (≤4 task, không gộp ponytail).

## Vấn đề (đã fold, không chặn)
- [x] T1 int-test "spy `Logger.prototype`" sai cơ chế (luôn xanh giả) ⇒ thay bằng wiring test memory stream.
- [x] T1 phương án A dùng "origin+pathname" ngầm `new URL` ⇒ ném với location tương đối; chốt cắt chuỗi + allow-list.
- [x] T2 "loadEnvFile trong try" nuốt lỗi parse ⇒ `existsSync` + để ném.
- [x] T3 giả định `./keys-e2e` theo `repoRoot` — sai: cwd thực là `be/` ⇒ path tuyệt đối trong `e2e/`.
- [x] T4 verify RED yêu cầu container KHÔNG chạy — trái luật hạ tầng ⇒ mutation port.

## Đề xuất (không bắt buộc → backlog)
- DEBT-093: BE E2E chạy cwd `be/` ⇒ `main.ts` nạp `be/.env` (non-override): biến dev không có trong
  `beEnv()` (vd `TRUST_PROXY`) lọt vào E2E; comment "never reads the real be/.env" không đúng hẳn.
- DEBT-094: log tay in `err.message`/`err.stack` của driver Mongo/Redis — xác nhận driver không chứa URI có credential; cân nhắc scrub `://user:pass@`.
