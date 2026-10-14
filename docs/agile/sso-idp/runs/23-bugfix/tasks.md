# Tasks — run 23 — bugfix (debt có rủi ro thật sau X1)

> Phạm vi: DEBT-089 (log lộ authorization `code`), DEBT-090 (`.env` E2E không nạp), DEBT-091 (keyset
> dev bị E2E ghi đè), + gộp rẻ DEBT-070/054 (preflight int-test). Mỗi task: **test RED trước khi sửa**.
> § trỏ: plan B1.3 (INV-20), plan §8 X1, backlog DEBT-089..092 / 070 / 054.
> Hạ tầng: KHÔNG `compose up`, KHÔNG FLUSH/drop. Terminal = Git Bash.

---

### [x] Task 1 [BE]: DEBT-089 — không log authorization `code`/`state` trong `res.headers.location`
**Repro / bằng chứng**
- `be/src/common/logger/logger.module.ts`: `REDACT_PATHS` phủ `req.headers.authorization`,
  `req.headers.cookie`, `res.headers["set-cookie"]` và loạt `*.token`/`*.code`/…, nhưng **KHÔNG**
  phủ `res.headers.location`. Có serializer `req` (bỏ query) nhưng **KHÔNG có serializer `res`**.
- pino default res serializer (`pino-std-serializers@7.1.0/lib/res.js`) emit
  `_res.headers = res.getHeaders()` → gồm `location`. 302 của `/authorize` có
  `location = <redirect_uri>?code=<authz_code>&state=<state>[&…]` → **code lộ nguyên văn**.
- Lộ CI: E2E chạy BE `NODE_ENV=test` ⇒ `transport: undefined` ⇒ JSON log; `e2e/playwright.config.ts`
  BE webServer `stdout:"pipe"` ⇒ log ra stdout Playwright ⇒ **log CI công khai**.
- Rà thêm (cùng INV-20): `req.url` đã bỏ query (OK). Kiểm các log tay khác không in `req.query`,
  `req.headers` thô, `id_token_hint`/`code`/`state`/`refresh_token` (grep `this.logger`/`log.`).

**Acceptance (đo được) — test RED trước khi sửa**
- Unit RED: `logger.module.spec.ts` thêm case cho `res` (serializer/redact) — log line của 302
  `/authorize` **không chứa** `code=`, `state=`, hay giá trị authz code/state thật.
- Giữ PATH của `location` (origin + pathname), **bỏ toàn bộ query** — hoặc redact `location` hẳn nếu
  không rẻ (chốt phương án ở plan).
- Int RED: spy mọi sink `Logger.prototype` quanh 1 flow `/authorize`→302, assert output không chứa
  giá trị `code`/`state` thật; verify RED bằng mutation (bỏ serializer res) rồi khôi phục.
- Không hồi quy: `pnpm -C be test` xanh; `set-cookie`/`authorization` vẫn bị drop như cũ.

**Security invariants**
- Tài sản: authorization code (single-use, đổi lấy token), `state` (CSRF binding), `request_id`.
  Actor: bất kỳ ai đọc log (CI public, log server, log agg). Attacker đọc log = có code trước RP.
- Invariant: authz code/state **KHÔNG BAO GIỜ** xuất hiện trong bất kỳ sink log nào (dev pretty, prod
  JSON, CI stdout). Trust boundary: `res.headers.location` (IdP sinh) → pino → stdout/file.
- Failure: serializer ném lỗi khi `location` khuyết/không phải URL hợp lệ → **fail-closed** (bỏ query
  hoặc bỏ cả `location`), KHÔNG để lọt chuỗi thô. State 302 trước→sau không đổi (chỉ log).
- Exposure budget: `code`, `state`, `id_token`, `access_token`, `refresh_token`, `id_token_hint`,
  `request_id` tuyệt đối không có trong log / URL-log / redirect-log.

**Quyết định chưa chốt (đề xuất an toàn)**
- (A) thêm `serializers.res` custom: rút `location` → chỉ `origin+pathname`, drop query (giữ path để
  debug) — **đề xuất mặc định**. (B) thêm `res.headers.location` vào `REDACT_PATHS` `remove:true`
  (đơn giản, mất path). Chốt (A) trừ khi tech-lead muốn tối giản → (B). Ghi ở plan.md.

**Chốt *(tech-lead fold)*** — thay các dòng Acceptance/Quyết định ở trên nếu mâu thuẫn:
- Export `serializeResponse` = **allow-list**: trả chỉ `{ statusCode, headers: { location? } }` (KHÔNG
  `getHeaders()` nguyên). Hàm nhận object đã map bởi `wrapResponseSerializer` (`{statusCode, headers, raw}`).
- `location` scrub bằng `value.split(/[?#]/, 1)[0]` (KHÔNG `new URL` — location tương đối `/login?returnTo=…`
  sẽ ném). Bỏ query **và** fragment. Không phải string ⇒ bỏ key `location` (fail-closed). Giữ `REDACT_PATHS`.
- Tách `useFactory` → export `buildPinoHttpOptions(nodeEnv)`; `LoggerModule` gọi lại đúng hàm này.
- **Bỏ** test "spy `Logger.prototype`" (pino-http không đi qua Nest Logger ⇒ xanh giả). Thay bằng:
  1. Unit `serializeResponse`: absolute `https://rp.example/cb?code=C&state=S#x` ⇒ `https://rp.example/cb`;
     relative `/login?returnTo=%2Fauthorize%3Flogin_hint%3DL` ⇒ `/login`; khuyết/non-string ⇒ không có
     `location`; input có `set-cookie`/`x-request-id` ⇒ output không có.
  2. Unit `serializeRequest`: `/logout?id_token_hint=H&state=S`, `/authorize?login_hint=L&code_challenge=P` ⇒ chỉ path.
  3. Wiring test (trong `logger.module.spec.ts`, không cần DB): `pinoHttp(buildPinoHttpOptions('test'), memStream)`
     trên `node:http` server: `res.setHeader('x-request-id',…)` trước rồi `writeHead(302, { Location:
     'https://rp.example/cb?code=SECRET_CODE&state=SECRET_STATE#frag', 'Set-Cookie': 'idp_session=SECRET_SID' })`;
     request `GET /authorize?id_token_hint=SECRET_HINT&login_hint=SECRET_LH` với header
     `authorization: Bearer SECRET_AT`, `cookie: idp_session=SECRET_SID`. Assert log **không chứa** `SECRET_`
     và **có** `https://rp.example/cb` + `302`. Mutation bỏ `serializers.res` ⇒ RED; khôi phục ⇒ GREEN; ghi log.md.
  4. (tester, sau T1–T3) `pnpm -C e2e e2e 2>&1 | grep -cE 'code=|state=|id_token_hint=|login_hint=|idp_session='` ⇒ `0`.
- Không cần ghi plan.md (quyết định nằm ở review-techlead.md).

**Phụ thuộc**: không.

---

### [x] Task 2 [E2E]: DEBT-090 — E2E nạp `e2e/.env` nhất quán với README
**Repro / bằng chứng**
- `e2e/README.md` hướng dẫn `cp e2e/.env.example e2e/.env` + set `DEV_SEED_PASSWORD`, nhưng
  `e2e/config/env.ts` / `playwright.config.ts` **không nạp** `e2e/.env` → giá trị bị bỏ qua;
  `DEV_SEED_PASSWORD ?? "dev-password-123"` âm thầm fallback → lệch với seed thực.
- `e2e/.env.example` có `DEV_SEED_PASSWORD=` rỗng → nếu có nạp mà để trống vẫn fallback im lặng.

**Acceptance (đo được)**
- Chọn 1 trong 2 (chốt ở plan), kết quả nhất quán README↔code:
  (A) `config/env.ts` nạp `e2e/.env` (vd `process.loadEnvFile` trong try, no-op nếu thiếu) TRƯỚC khi
  đọc `process.env.DEV_SEED_*`; README giữ nguyên. **hoặc**
  (B) bỏ bước `cp`/`.env.example` trong README + xoá `e2e/.env.example`; chỉ truyền qua process env.
- Verify: `e2e/.env` đặt `DEV_SEED_PASSWORD=xyz` ⇒ BE seed nhận đúng `xyz` (không phải fallback).
  Nếu chọn (B): README không còn nhắc `.env`, `grep` không thấy.
- Không còn fallback password mặc định im lặng: thiếu `DEV_SEED_PASSWORD` ⇒ **fail rõ** (throw) thay
  vì chạy với `dev-password-123` (trừ giá trị CI job `env:` cố ý).

**Security invariants**
- Tài sản: credential user dev (seed). Actor: dev local, CI. Invariant: KHÔNG commit secret thật;
  `.env` phải git-ignored (root `.gitignore` có `.env` — xác nhận phủ `e2e/.env`).
- Exposure: password không ghi vào log/report/trace; `.env.example` chỉ placeholder rỗng.
- Failure: thiếu password ⇒ fail-closed (dừng, không dùng default đoán được).

**Quyết định chưa chốt**: (A) nạp `.env` vs (B) bỏ `.env`. Đề xuất (A) (khớp UX README hiện có, ít phá
vỡ); nếu tech-lead muốn tối giản thì (B).

**Chốt *(tech-lead fold)*: (A)**.
- Đầu `e2e/config/env.ts`: path tuyệt đối `resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env")`;
  `if (existsSync(p)) process.loadEnvFile(p)` — **không** bọc try (file hỏng phải ném). Node 22 không
  override biến đã có ⇒ CI job `env:` vẫn thắng.
- Bỏ `?? "dev-password-123"`; `DEV_SEED_PASSWORD` thiếu/rỗng ⇒ `throw new Error` nêu tên biến + cách đặt
  (`e2e/.env` hoặc env). `DEV_SEED_EMAIL` giữ default `dev@example.com`.
- Verify: (a) không có `e2e/.env` + không có env ⇒ `pnpm -C e2e e2e` fail ngay với message nêu
  `DEV_SEED_PASSWORD`; (b) `e2e/.env` có password ⇒ E2E pass (login dùng đúng giá trị); (c) `git check-ignore e2e/.env` OK
  (đã có trong `e2e/.gitignore`). `pnpm -C e2e typecheck` xanh. README ghi rõ thiếu password ⇒ fail.
**Phụ thuộc**: không (cùng chạm `e2e/config/env.ts` với Task 3 → phối hợp edit).

---

### [x] Task 3 [E2E]: DEBT-091 — tách thư mục key E2E riêng, git-ignored
**Repro / bằng chứng**
- `e2e/config/env.ts` `beEnv()`: `KEY_LOCAL_DIR: "./keys"`; BE webServer `cwd: repoRoot`
  (`playwright.config.ts`), `start = node dist/main.js`. `./keys` giải tương đối theo cwd BE →
  đụng keyset dev (`be/keys/` đang chứa keyset dev thật, git-ignored). E2E init/prune ⇒ nhiễm keyset
  dev. **Phải xác nhận** cwd thực + cách LocalKeyProvider giải `KEY_LOCAL_DIR` trước khi chốt path.

**Acceptance (đo được)**
- Đổi `KEY_LOCAL_DIR` E2E sang thư mục riêng (vd `./keys-e2e`) tách khỏi `be/keys`.
- Thêm pattern vào `.gitignore` phủ thư mục key E2E (vd `keys-e2e/` và/hoặc `**/keys-e2e/`);
  `git check-ignore <path>` trả về path đó.
- Verify: chạy E2E 1 lần ⇒ key mới nằm trong `keys-e2e`; `be/keys` **không đổi** (so `git status`
  trước/sau — `be/keys` clean); E2E vẫn pass (BE `/ready` + login flow).

**Security invariants**
- Tài sản: private signing keys RS256 — dev keyset vs E2E keyset. Invariant: E2E KHÔNG ghi/prune
  keyset dev; không commit key nào (dev lẫn E2E). Exposure: `.pem` không vào git, không vào log.
- Failure: thư mục key E2E chưa tồn tại ⇒ LocalKeyProvider tự tạo+init (hành vi hiện có), KHÔNG
  fallback sang `be/keys`.

**Quyết định chưa chốt**: xác nhận cwd thực của BE webServer (repoRoot) để đặt path tương đối đúng;
kiểm code LocalKeyProvider trước khi chốt literal path.

**Chốt *(tech-lead fold)*** — đã xác nhận code: lệnh `pnpm -C be start` ⇒ `node dist/main.js` chạy với
**cwd = `be/`** (không phải repoRoot); `LocalKeyProvider` dùng `join(dir, …)` ⇒ giải theo `process.cwd()`
⇒ `./keys` = `be/keys` (DEBT-091 thật). `./keys-e2e` tương đối sẽ thành `be/keys-e2e` — **không dùng**.
- `KEY_LOCAL_DIR: resolve(<thư mục e2e>, ".keys")` (tuyệt đối, tính từ `import.meta.url` trong `env.ts`).
- Thêm `.keys/` vào `e2e/.gitignore` (KHÔNG sửa `.gitignore` gốc). README cập nhật mục isolation.
- Verify: hash `be/keys/keys.json` (nếu tồn tại) trước/sau E2E **không đổi**; `e2e/.keys/keys.json` tồn tại;
  `git check-ignore -v e2e/.keys/keys.json` ⇒ `e2e/.gitignore`; `git status --porcelain` không có `.pem`/`.keys`.
- CI: checkout sạch ⇒ `init()` tự tạo; không cache/upload thư mục này.
**Phụ thuộc**: không (độc lập Task 2).

---

### [x] Task 4 [BE]: DEBT-070/054 — preflight int-test fail-fast thay vì treo ~10'
**Repro / bằng chứng**
- Int-test inline URI `mongodb://localhost:27117` + `redis://localhost:6479` trong từng
  `*.int-spec.ts` (vd `authorize.int-spec.ts:40-41`), KHÔNG có jest `globalSetup`. Nếu container
  `vg-test-mongo`/`vg-test-redis` chưa chạy, ioredis retry + mongoose chờ → suite treo tới ~10' rồi
  mới lỗi mơ hồ (DEBT-070 cần `docker start` trước; DEBT-054 open handles).

**Acceptance (đo được) — test RED trước khi sửa**
- Thêm jest `globalSetup` cho `test:int` (chỉ int, không đụng unit): TCP-probe `27117` + `6479` với
  timeout ngắn (vd 2s). Không kết nối ⇒ **throw thông báo rõ** (tên container + lệnh
  `docker start vg-test-mongo vg-test-redis`) và dừng ngay (< ~5s), KHÔNG treo 10'.
- Verify RED: khi 2 container KHÔNG chạy, `pnpm -C be test:int` fail trong < 10s với message chứa tên
  container (không còn treo). Khi container chạy: int-test xanh như trước.
- (Tùy chọn rẻ) `--detectOpenHandles` hoặc đóng conn trong `afterAll` để DEBT-054 không giữ handle;
  nếu không làm trong run này → ghi lại debt.

**Security invariants**: N/A — chỉ hạ tầng test cục bộ/CI, không chạm trust boundary, không secret,
không dữ liệu thật (probe chỉ TCP connect tới host test local).

**Quyết định chưa chốt**: cách gắn `globalSetup` cho `test:int` (file `be/test/int-preflight.ts` +
flag `--globalSetup` trong script `test:int`). Chốt khi tech-lead cân độ phức tạp vs lợi ích.

**Chốt *(tech-lead fold)***:
- File `be/test/int-preflight.mjs` (JS thuần, `export default async function`, `node:net`; tránh transform
  ts-jest cho globalSetup). Probe song song `localhost:27117` + `localhost:6479`, timeout 2s mỗi cái; lỗi ⇒
  `throw` nêu port + tên container + `docker start vg-test-mongo vg-test-redis`.
- Gắn **chỉ** qua flag trong script `test:int`: `… jest.js --runInBand --globalSetup ./test/int-preflight.mjs --testRegex …`.
  `jest.config.js` KHÔNG đổi ⇒ `pnpm test` (unit) không chạy preflight.
- **Verify RED KHÔNG dừng container** (luật hạ tầng): mutation tạm đổi port probe sang port đóng (vd `1`) ⇒
  `pnpm -C be test:int -- test/health.int-spec.ts` fail < 10s với message đúng; khôi phục ⇒ xanh. `pnpm -C be test` xanh.
- DEBT-054 (open handles) **ngoài phạm vi** — giữ mở trong backlog; T4 chỉ đóng DEBT-070.

---

## Phân công *(tech-lead fold)*
- **backend-dev**: T1 → T4 (file `be/src/common/logger/*`, `be/test/int-preflight.mjs`, `be/package.json`).
- **frontend-dev**: T2 → T3 (file `e2e/config/env.ts`, `e2e/.gitignore`, `e2e/README.md`, `e2e/.env.example`).
- Hai agent **song song** (không chung file). Tester chạy E2E + log grep (T1-4) + verify T3 sau khi cả hai xong.
**Phụ thuộc**: không.

---

> **Không gộp**: DEBT-081/092 (ponytail, thuần dọn dòng, không rủi ro) và DEBT-082/083/085 (thuộc
> B5/B6, chưa tới) — giữ ≤4 task tập trung rủi ro thật. Nêu lại ở STATUS/backlog.n