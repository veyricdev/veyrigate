# Tasks — run 63 — dọn mẫu setup/teardown int test (M7, lane test-infra BE)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-461 (14 spec import `./full-app` chỉ để lấy hằng số ⇒ nạp cả `AppModule`), DEBT-462 (`closeFullApp(booting)` không chờ seed còn lại của `beforeAll` ⇒ DB mồ côi), DEBT-463 (2 kiểu mẫu chờ setup, `afterAll` ném `TypeError` khi setup hỏng sớm, `.catch(() => undefined)` nuốt lý do boot muộn, chú thích lặp 15 lần, `rm(keyDir)` không `.catch` ở `full-app.ts`), DEBT-454 (DB `vg-int-*` mồ côi; `client-auth-rate-limit`/`authorize`/`demo` còn để lại 1 DB mỗi lượt rảnh), DEBT-452 + DEBT-456 (lọc `test:int` bằng đối số vị trí không lọc; truyền lại `--testTimeout` thành mảng). Bối cảnh: run 61 (`runs/61-test-stability/` — summary, review-senior-be.md, log.md có số đo).
>
> Tech-lead: xác minh gốc từng debt bằng code thật; thiết kế MỘT mẫu chung cho mọi hook int (đề xuất của senior run 61: `beforeAll(() => (setup = boot()), T)`; `afterAll`: chờ `setup` có log lý do rồi `full?.close()`), tách hằng số sang file không import; tìm thao tác ghi sau `dropDatabase` ở 3 suite DEBT-454; quyết DEBT-452/456 sửa script hay chỉ tài liệu. Dọn 581+ DB mồ côi đã tồn tại = thao tác xoá dữ liệu ⇒ CHỈ đề xuất script/lệnh, KHÔNG chạy (người dùng duyệt). Cách chứng minh: int full rảnh ≥ 2 lượt + 1 lượt dưới tải (script `load2.mjs` run 61), đếm DB `vg-int-*` trước/sau = +0, mutation (hook timeout giữa seed ⇒ 0 DB mồ côi). Không nới timeout/assertion; không `retries`.
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop DB dùng chung (`aegate-*`); chỉ drop DB do chính lượt chạy/drill tạo, đúng tên; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start` (đang dừng); không kill/Stop-Process PID nào (chỉ TaskStop task của mình); không commit.

### [x] Task 1 [test/BE]: DEBT-461 + 462 + 463 — một mẫu setup/teardown, hằng số tách file.
### [x] Task 2 [test/BE]: DEBT-454 — 3 suite không còn để lại DB; đề xuất lệnh dọn DB cũ cho người dùng.
### [x] Task 3 [test-infra]: DEBT-452 + 456 — lọc/truyền cờ `test:int`.

---

## Fold tech-lead (2026-11-03) — bắt buộc

### Gốc đã xác minh (code thật + đo)

- **DEBT-454**: KHÔNG phải "ghi sau drop" trong cùng `describe`. Cả 3 file có **2 `describe` cấp file dùng chung `MONGO_URI`**; `describe` 1 drop ở `afterAll`, `describe` 2 chạy SAU, dựng app `MongooseModule.forRoot(MONGO_URI)` (autoIndex mặc định bật ⇒ tạo collection/index) và **không bao giờ drop**:
  - `client-auth-rate-limit.int-spec.ts`: drop :210; `describe('TRUST_PROXY…')` :484 — `buildApp()` + `seedClient()` ghi `clients`, `afterAll` :538 không drop.
  - `authorize.int-spec.ts`: drop :156; `describe('Authorize HTTP flow…')` :462 — `beforeAll` :484 dựng `httpApp` + `cs.create`, `afterAll` :545 chỉ `httpApp.close()`.
  - `demo.int-spec.ts`: drop :147; `describe('…production defence-in-depth')` :333 — `beforeAll` :337 dựng app (autoIndex), `afterAll` :367 không drop.
  - Đo (tech-lead `docker start vg-test-mongo vg-test-redis`): **610** `vg-int-*` = authorize 221, clrl 193, demo 154, vault-v7 16 (timestamp ≤ 2026-10-26, trước run 61), lẻ 26. Khớp test-report run 61: full rảnh +3 đúng 3 file này, 0 từ suite full-app.
- **DEBT-452**: `--testRegex` của jest-cli 30.0.5 là `type: 'array'` (yargs) và là cờ CUỐI của script ⇒ pnpm nối `authorize` vào sau ⇒ yargs nuốt thành phần tử thứ 2 của `testRegex` (OR) ⇒ `--listTests` ra **66** file (53 int-spec + `authorize.*` trong `src`/`dist`). Dạng `--testRegex=…` vẫn bị nuốt; `-- authorize` còn tệ hơn (1408). Positional trước `--testRegex` hoặc `--testPathPatterns` ⇒ đúng 2 file. Không phải lỗi pnpm.
- **DEBT-456**: `--testTimeout` lặp ⇒ yargs gộp mảng (`--showConfig`: `"testTimeout": [ … ]`). Khi `testTimeout` nằm trong file config và CLI chỉ 1 lần ⇒ scalar `30000` (probe bằng config tạm trong scratchpad).
- **DEBT-461/462/463**: khớp backlog. 26 file dùng `FULL_APP_BOOT_TIMEOUT_MS` = `full-app.ts` + 11 file full-app (13 cặp hook: `b74-tester` ×3) + 14 file nhẹ (15 cặp hook: `seed-dev` ×2; IIFE ở `indexes`/`seed`/`seed-risk`). `closeFullApp` chỉ chờ boot ⇒ hook hết giờ khi đang seed thì `close()` chạy song song với seed.

### Quyết định

- **DEBT-452/456 ⇒ sửa script** (không chỉ tài liệu): thêm `be/jest.int.config.js` (CJS như `jest.config.js`): `{ ...require('./jest.config.js'), testRegex: '\\.int-spec\\.ts$', testTimeout: 20000, globalSetup: './test/int-preflight.mjs', globalTeardown: './test/int-teardown.mjs' }`; script `test:int` = `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.int.config.js --runInBand`. CLI không còn cờ mảng/cờ đã có ⇒ positional lọc được, `--testTimeout=N` ghi đè sạch. CI (`ci.yml:131`) không đổi lệnh. `test:vault`/`test:sentinel` KHÔNG đổi run này (DEBT-470).
- **Một file helper mới `be/test/int-hooks.ts`** — chỉ import `mongoose` (KHÔNG import `../src`, không `./full-app`):
  ```ts
  /** <chuyển nguyên chú thích số đo DEBT-448 từ full-app.ts> */
  export const INT_SETUP_TIMEOUT_MS = 70_000;
  /** afterAll: wait for a beforeAll setup that may have outlived its hook (DEBT-448); never throws, logs why. */
  export async function settled(setup: Promise<unknown> | undefined): Promise<void> {
    await setup?.catch((err: unknown) =>
      console.warn(`[int] setup failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  /** Drop one test DB; refuses a DB name not starting with `vg-int-`. */
  export async function dropIntDb(uri: string): Promise<void> { /* createConnection(serverSelectionTimeoutMS 5000) → dropDatabase → close in finally */ }
  ```
  `full-app.ts`: import 3 thứ trên; XOÁ `FULL_APP_BOOT_TIMEOUT_MS`, `closeFullApp`, hàm riêng `dropDatabase` (thay bằng `dropIntDb`); `rm(keyDir…)` trong `catch` của `bootFullApp` thêm `.catch(() => undefined)`. Không re-export (một đường import).
- **MỘT mẫu hook** cho mọi cặp hook kiểu DEBT-448 (chú thích 1 dòng):
  ```ts
  // DEBT-448: afterAll waits for a setup that outlived its hook, then cleans up what it opened.
  const boot = async (): Promise<void> => { full = await bootFullApp({ ... }); /* seed… */ };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close(); // file nhẹ: await connection?.dropDatabase(); await connection?.close(); await redis?.quit() …
  }, INT_SETUP_TIMEOUT_MS);
  ```
  Biến tài nguyên `let full: FullApp | undefined` (hoặc `?.` ở afterAll) để `afterAll` không ném `TypeError` khi setup hỏng sớm. Không IIFE, không `booting`, không `.catch(() => undefined)` trong spec.

### Task 1 [test/BE] — DEBT-461 + 462 + 463
- Tạo `be/test/int-hooks.ts`; sửa `be/test/full-app.ts` như trên.
- Chuyển **13 cặp hook / 11 file full-app** (`b73c-tester`, `b74-tester`×3, `log-capture`, `redis-down`, `run55/56/57-tester`, `run59-http-edge-tester`, `runbook-drill`, `security-headers`, `static-assets`) và **15 cặp hook / 14 file nhẹ** (`authentication`, `authorize-params`, `authorize`, `clients`, `consent`, `identity`, `indexes`, `oauth-tenant-isolation`, `seed-dev`×2, `seed-e2e-admin`, `seed-risk`, `seed`, `tenant-context`, `ui-auth`) sang mẫu trên. 14 file nhẹ import từ `./int-hooks`, KHÔNG còn import `./full-app`.
- KHÔNG đổi giá trị timeout, assertion, số test; không `retries`.
- **AC/verify**:
  - `grep -rn "closeFullApp\|FULL_APP_BOOT_TIMEOUT_MS\|(setup = (async" be/test` ⇒ 0 dòng; `grep -rn "catch(() => undefined)" be/test/*.int-spec.ts` ⇒ không dòng nào trong `afterAll` chờ setup.
  - 14 file nhẹ: `grep -l "from './full-app'"` ⇒ 0 trong số đó; `grep -n "^import" be/test/int-hooks.ts` ⇒ chỉ `mongoose`.
  - Tổng `grep -c "beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS)" be/test/*.int-spec.ts` = **28**.
  - `pnpm -C be lint`, `pnpm -C be typecheck` sạch; `pnpm -C be test` (unit) 630 xanh.

### Task 2 [test/BE] — DEBT-454
- 3 file `client-auth-rate-limit`, `authorize`, `demo`: bỏ `dropDatabase` trong `afterAll` của `describe` đầu (giữ close); thêm MỘT `afterAll` cấp file, cuối file, ngoài mọi `describe`: `afterAll(() => dropIntDb(MONGO_URI), INT_SETUP_TIMEOUT_MS)` — jest chạy nó sau khi mọi `describe` con đã đóng app. Không đổi tên DB.
- **Lệnh dọn DB cũ** (tech-lead đã viết; chỉ chạy dry-run = liệt kê, 610 target): `node C:\Users\ADMIN\AppData\Local\Temp\claude\E--projects-self-veyrigate\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\drop-int-orphans.mjs` ; thêm `--yes` để xoá — **chỉ người dùng chạy sau khi duyệt**. Script: chỉ 27117; từ chối khi `vg:int-lock` đang giữ; chỉ tên `^vg-int-(<name>-)?\d{13}$` có timestamp cũ hơn 1 h. backend-dev/tester KHÔNG chạy `--yes`.
- **AC/verify**: `node <scratchpad>\listdb.mjs vg-int- -q` trước/sau `pnpm -C be test:int --testPathPatterns "client-auth-rate-limit|authorize\.int|demo\.int"` ⇒ **+0**; đối chứng trên HEAD trước khi sửa ⇒ **+3** (ghi số; drop đúng 3 DB đối chứng đó bằng tên).

### Task 3 [test-infra] — DEBT-452 + 456
- Tạo `be/jest.int.config.js`, đổi script `test:int` như "Quyết định". Thêm 2 dòng vào `be/README.md` (mục test): lọc bằng positional hoặc `--testPathPatterns <re>`; `--testTimeout=N` ghi đè được. Khi đóng run sửa dòng ⚠ DEBT-456 trong STATUS.
- **AC/verify** (không cần chạy test):
  - `pnpm -C be test:int authorize --listTests` ⇒ đúng 2 dòng (`authorize.int-spec.ts`, `authorize-params.int-spec.ts`); trước sửa = 66.
  - `pnpm -C be test:int --listTests | wc -l` ⇒ 53.
  - `pnpm -C be test:int --testTimeout=30000 --showConfig | grep '"testTimeout"'` ⇒ `30000` scalar; không cờ ⇒ `20000`; `--showConfig` vẫn có `globalSetup`/`globalTeardown` đúng.

### Chứng minh ổn định (backend-dev; tester lặp ≥ 1 lượt rảnh)
Mỗi lượt đếm trước/sau: `node <scratchpad>\listdb.mjs vg-int- -q` và keyDir `ls "$TEMP" | grep -c -- "-keys-"` (prefix `vg-`).
1. **Full int rảnh ×2**: `pnpm -C be test:int` ⇒ mỗi lượt 1420/1420 (không giảm), exit 0, tự thoát, **DB +0, keyDir +0**, output không có `TypeError` và không có `[int] setup failed`.
2. **Full int dưới tải ×1**: `node <scratchpad>\load2.mjs 28 3600 <scratchpad>\load.stop` (nền, tự dừng) rồi `pnpm -C be test:int`; xong tạo file `load.stop`. AC như (1). Ghi thời gian. (Nếu `load2.mjs` mất: tái tạo ~20 dòng — N `worker_threads` busy-loop `Math.sqrt` đến hết D giây hoặc khi file stop tồn tại, kiểm mỗi 50 vòng 1e6; không kill từ ngoài.)
3. **Mutation** (spec tạm `be/test/zz-t63-mut.int-spec.ts`, xoá sau; DB `vg-int-t63mut-*`, keyDir `vg-t63mut-*-keys-*`):
   - **M1 (DEBT-462)**: `boot` = `bootFullApp({ name: 't63mut' })` + seed ghi ~5 s (vd. 50× `ResourceService.create` cách 100 ms) rồi log `seed-done <ts>`; hook timeout 3000 ms ⇒ hook đỏ (mong đợi); bọc `close` log `close-start <ts>`. AC: `close-start ≥ seed-done`, 0 DB `vg-int-t63mut-*`, 0 keyDir, tự thoát. Đối chứng mẫu cũ (`closeFullApp(booting)`) ⇒ `close-start < seed-done` (ghi có/không DB mồ côi).
   - **M2 (DEBT-463)**: (a) setup ném ngay dòng đầu (trước khi gán `connection`) ⇒ chỉ lỗi gốc + `[int] setup failed: <msg>`, KHÔNG `TypeError`; đối chứng mẫu cũ ⇒ có `TypeError`. (b) setup reject SAU hook timeout ⇒ dòng warn có đúng lý do.
   - **M3 (DEBT-454)**: tạm bỏ `afterAll(() => dropIntDb…)` ở 1 file ⇒ +1 DB; khôi phục ⇒ +0.
   - Chỉ drop đúng DB/keyDir do mutation/đối chứng tạo (theo tên), ghi lại.
4. `pnpm -C be test:vault` chạy 1 lượt nếu Vault dev sẵn (vì `full-app.ts` đổi); không thì ghi "không chạy" + lý do.
