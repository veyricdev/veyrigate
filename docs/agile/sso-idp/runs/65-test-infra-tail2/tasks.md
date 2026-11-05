# Tasks — run 65 — đuôi test-infra 2 (M7, lane test-infra BE + FE)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-475 (`test:vault`/`test:sentinel` còn `--forceExit` ⇒ handle rò bị che), DEBT-203 (`TEST_MONGO_URI` thay toàn bộ URI ⇒ mọi spec dùng chung 1 DB; DB phụ suy bằng `.replace` rơi về cùng DB — phần còn lại sau guard run 64), DEBT-453 (assertion tiền tố `eyJ` ở `be/test/run54-tester.int-spec.ts`, `debt388-sign-before-commit.int-spec.ts`, `b73-tester.vault-spec.ts`, `fe-admin/test/bff.test.ts`). Bối cảnh: run 61 (gỡ `--forceExit` khỏi int, DEBT-054/096; fixture JWT DEBT-450), run 63–64 (`jest.*.config.js`, `int-hooks.ts`, guard `vg-int-*` ở `intPreflight`).
>
> Tech-lead: xác minh gốc bằng code thật. DEBT-475: cần chạy suite thật — Vault dev throwaway `vg-b73-vault` (lệnh trong `be/test/vault-preflight.mjs` START), Sentinel `bash be/scripts/sentinel-test-env.sh up/down`; chỉ container đúng các tên đó, tạo và xoá bằng chính lệnh có sẵn, token sinh ngẫu nhiên không in. Nếu không chạy được ⇒ hoãn task, không gỡ mù. DEBT-203: quyết cách diff nhỏ nhất (vd. coi override là base URI + hậu tố mỗi spec qua một helper trong `int-hooks.ts`, hay thu hẹp: override chỉ host/port) — nhớ guard run 64 phải còn đúng; nếu chi phí > lợi ích (CI/ai cũng không đặt biến) thì đề xuất đóng chấp nhận + tài liệu. DEBT-453: so với token cụ thể đã phát hành (+ base64/base64url của nó). Không nới timeout/assertion; không `retries`.
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop DB dùng chung (`aegate-*`); chỉ drop DB do chính lượt chạy tạo; KHÔNG chạy `drop-int-orphans.mjs --yes`; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; container Vault/Sentinel chỉ tên `vg-b73-vault`/`vg-b73c-*` qua lệnh có sẵn, xoá đúng tên khi xong; không prune/wildcard; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không commit.

### [x] Task 1 [test-infra/BE]: DEBT-475 — gỡ `--forceExit` khỏi `test:vault`/`test:sentinel`, sửa handle rò nếu có.
- AC: cả hai suite xanh với Vault/Sentinel thật, tự thoát (không treo) ≥ 2 lượt; `--detectOpenHandles` 0 handle (hoặc giải thích handle còn lại).
### [x] Task 2 [test/BE]: DEBT-203 — theo quyết định tech-lead.
- AC: đặt `TEST_MONGO_URI` (tên `vg-int-*`) ⇒ mỗi spec (và DB phụ) có DB riêng hoặc quyết định đóng chấp nhận có lý do; guard run 64 vẫn chặn DB không `vg-int-*`; int full không override 1420/1420, +0 DB `vg-int-*`.
### [x] Task 3 [test/BE+FE]: DEBT-453 — thay `eyJ` bằng so token cụ thể. (BE [x] backend-dev; FE [x] frontend-dev)
- AC: mutation (log/body chứa token thật) ⇒ RED ở từng chỗ sửa; restore byte-identical; spec xanh.

## Fold tech-lead (2026-11-03) — bắt buộc

### Gốc đã xác minh (code thật, chạy thật)

- **DEBT-475** — chạy được suite thật: `vg-b73-vault` (lệnh START của `vault-preflight.mjs`, token ngẫu nhiên không in) + `bash be/scripts/sentinel-test-env.sh up`. Gọi jest y như script nhưng KHÔNG `--forceExit`:
  - `test:sentinel`: 2/2 xanh, `--detectOpenHandles` im lặng, **tự thoát** (25 s tổng, Time 21,2 s) ⇒ chỉ cần gỡ cờ.
  - `test:vault`: 5 suite/31 test xanh (Time 76,6 s) rồi **treo** tới khi `timeout 600` giết (rc 124); `--detectOpenHandles` không báo gì. Từng file: `vault-transit` treo (rc 124 sau 150 s; Time 31 s); `run55`/`b73c`/`run54`/`b73-tester` tự thoát (rc 0, 2–3 s sau tổng kết).
  - Probe `process._getActiveHandles()` (preload ngoài repo) sau 55 s: 13 socket tới `27117` (pool Mongo) + 1 tới `6479` (ioredis) còn mở. Chỉ chạy `-t "full app with an exportable key"` (V7) ⇒ treo, cùng 13+1 socket; chỉ `-t "V8: missing key"` ⇒ thoát sau 13 s.
  - **Gốc**: `be/test/full-app.ts` `bootFullApp` chỉ dọn `started.ctx`, mà `started.ctx` chỉ được gán SAU `builder.compile()`. Factory async `KEY_PROVIDER` (`be/src/modules/keys/keys.module.ts:21`, `transit.init()`) ném NGAY TRONG `compile()`, sau khi `MongooseModule.forRootAsync` (`mongoose.createConnection`) và `redisClientProvider` (`new IORedis`) đã tạo kết nối ⇒ không ai đóng. Không phải lỗi riêng suite Vault: mọi boot full-app hỏng trong compile (cả int) đều rò; int hiện không có ca như vậy nên run 61 không thấy.
- **DEBT-203** — tái hiện: `TEST_MONGO_URI=mongodb://localhost:27117/vg-int-tl203-<ts>?directConnection=true` + `test:int admin-target-risk` ⇒ **1 failed / 8** (ca "seed re-point guard": `.replace('vg-int-admintarget-risk-', …)` ở `:334` không khớp tên override ⇒ seed chạy trên DB chính: `counts` có clients 4, auditlogs 1… thay vì `{clients:1, resources:1}`; rồi `dropDatabase` DB chính giữa file). DB drill không còn sau lượt chạy. Vậy ghi chú backlog "chỉ đặt biến khi chạy MỘT spec" SAI với `admin-target-risk`, và cũng SAI với `b74-tester` (app ngoài boot ở `:100` còn mở khi describe con boot `abortApp`/`tApp` cùng URI ⇒ `close()` của app con drop DB của app ngoài). `indexes.int-spec.ts:147` đã đúng (regex chèn hậu tố trước `?`).
- **DEBT-453** — đúng 4 file của backlog, các dòng: `be/test/run54-tester.int-spec.ts:236, 318, 326, 341`; `be/test/debt388-sign-before-commit.int-spec.ts:232, 314, 332, 464`; `be/test/b73-tester.vault-spec.ts:401`; `fe-admin/test/bff.test.ts:55, 135` (ở đây `rt-|at-` cũng là tiền tố, cùng bệnh). Bằng chứng rủi ro thật: cursor audit là base64url của JSON ⇒ luôn bắt đầu bằng `eyJ` (vd. `fe-admin/test/audit-fn.test.ts:73`), body/log nào sau này mang cursor sẽ đỏ giả. Các chỗ cùng mẫu ngoài 4 file ⇒ DEBT-477 (không làm run này).

### Quyết định + điểm sửa

**Task 1 [BE] — DEBT-475** (làm, không hoãn):
1. `be/src/database/redis/redis.module.ts`: tách thân `useFactory` của `redisClientProvider` thành `export function createRedisClient(config: ConfigService): IORedis`; provider gọi lại nó. Refactor thuần: log/option/listener y hệt.
2. `be/test/full-app.ts`:
   - `BootProgress` thêm `redis?: IORedis` và `mongoBefore?: Set<Connection>`.
   - Trước `builder.compile()`: `started.mongoBefore = new Set(mongoose.connections)`; builder thêm `.overrideProvider(REDIS_CLIENT).useFactory({ factory: (c: ConfigService) => (started.redis = createRedisClient(c)), inject: [ConfigService] })`, đặt TRƯỚC `opts.override` để override của spec vẫn thắng.
   - `catch` của `bootFullApp`: nếu `!started.ctx` (hỏng trong compile) ⇒ `started.redis?.disconnect()` và `close()` mọi `mongoose.connections` không có trong `mongoBefore` (best effort, `.catch(() => undefined)`), RỒI mới `dropIntDb` như cũ. Nhánh có `ctx` giữ nguyên.
3. `be/package.json`: bỏ `--forceExit` khỏi `test:vault` và `test:sentinel`. Không đổi timeout, không `retries`.

**Task 2 [BE] — DEBT-203**: KHÔNG làm helper cho 37 spec (chi phí > lợi ích: CI và không ai đặt biến; guard run 64 đã chặn mất dữ liệu người dùng). Sửa đúng 3 chỗ để "override cho MỘT file spec" là thật, rồi đóng chấp nhận phần còn lại:
1. `be/test/int-hooks.ts`: thêm `withDbSuffix(uri, suffix)` = `uri.replace(/(\/[^/?]+)(\?|$)/, ...)` chèn `-<suffix>` vào cuối tên DB, trước `?` (đúng regex của `indexes.int-spec.ts:147`).
2. `be/test/full-app.ts:91-93`: có override ⇒ `withDbSuffix(TEST_MONGO_URI, <opts.name>-<Date.now()>)` (mỗi app full-app một DB, vẫn tiền tố `vg-int-`); nhánh mặc định giữ nguyên.
3. `be/test/admin-target-risk.int-spec.ts:334` ⇒ `withDbSuffix(MONGO_URI, 'seed')`; `be/test/indexes.int-spec.ts:147` ⇒ `withDbSuffix(MONGO_URI, 'consent-migration')` (kết quả như cũ).
4. Đóng DEBT-203, lý do: override chỉ hỗ trợ MỘT file spec mỗi lượt (spec không full-app dùng thẳng DB override). Sửa câu ở `.github/workflows/ci.yml:73-74` thành "chỉ đặt khi chạy MỘT file spec (DEBT-203)". Guard `intPreflight` không đổi.

**Task 3 [BE] + [FE] — DEBT-453**: so với token cụ thể đã phát hành.
- [BE] helper mới `be/test/issued-tokens.ts`:
  - `recordIssued(provider: KeyProvider): string[]` gán đè **thuộc tính riêng** `provider.signJwt` một lần (gọi bản gốc, push JWT trả về). KHÔNG dùng `jest.spyOn`, để `jest.restoreAllMocks()` và các `jest.spyOn(signer, 'sign')`/`holdSigns()` trong spec không gỡ nó.
  - `leakForms(t)` = `[t, t.split('.')[2], base64(t), base64url(t)]`; `expectNoIssued(text, issued)`: mọi dạng của mọi token đều `not.toContain`.
  - `run54-tester.int-spec.ts`, `debt388-sign-before-commit.int-spec.ts`: `issued = recordIssued(provider)` ngay sau khi tạo `provider` (cái truyền vào `KEY_PROVIDER useValue`); log (`afterEach`), audit (`afterAll`) và body dùng `expectNoIssued`; giữ kiểm tên khoá `/access_token|refresh_token|id_token/` (tất định). `afterAll`: `expect(issued.length).toBeGreaterThan(0)` (chống pass rỗng).
  - `b73-tester.vault-spec.ts` T5: `issued = recordIssued(full.app.get<KeyProvider>(KEY_PROVIDER))` sau boot; `expectOutage` dùng `expectNoIssued` + giữ `/access_token|refresh_token|"kty"/`; cuối T5 (sau khi Vault trở lại, code/RT thành công) `expect(issued.length).toBeGreaterThan(0)`.
- [FE] `fe-admin/test/support/fake-idp.ts`: thêm `issued: string[]`; `sign()` và `issue()` push mọi giá trị phát ra (id_token, access_token, refresh_token). `fe-admin/test/bff.test.ts:55` và `:135`: thay `eyJ|rt-|at-` bằng kiểm không chứa token nào trong `idp.issued` (rõ + base64 + base64url), giữ `error_description`; happy path `:135` thêm `expect(idp.issued.length).toBeGreaterThan(0)`.

### Security
Trust boundary = dữ liệu test do chính lượt chạy tạo; code sản phẩm chỉ có một refactor thuần (`createRedisClient`). Invariant giữ: không spec int nào drop DB ngoài `vg-int-*` (guard run 64 + `dropIntDb`; hậu tố chỉ nối sau tên `vg-int-*`). Kiểm lộ token mạnh hơn trước: chỗ nào trước kiểm `eyJ` thì giờ kiểm mọi JWT đã ký ở mọi dạng mã hoá + giữ kiểm tên khoá; kiểm không-rỗng chặn pass vì không ký gì.

### Chứng minh (dev tự làm, tester làm lại độc lập)
- **T1**: Vault/Sentinel bằng đúng lệnh có sẵn; xoá đúng tên khi xong (`docker rm -f vg-b73-vault`, `sentinel-test-env.sh down`). (a) Trước sửa: `vault-transit` không `--forceExit` ⇒ treo (bọc `timeout 150`, rc 124). (b) Sau sửa: `pnpm -C be test:vault` ×2 và `pnpm -C be test:sentinel` ×2 xanh, tự thoát ≤ 10 s sau dòng tổng kết; `-t "full app with an exportable key" --detectOpenHandles` thoát, 0 handle. (c) Mutation: bỏ khối dọn mới trong `catch` ⇒ V7 treo lại; hoàn nguyên sha256 khớp. (d) `pnpm -C be test` (có `redis.module.spec.ts`) xanh; `test:int` full 1420/1420, `vg-int-*` trước/sau không tăng.
- **T2**: override `vg-int-tl203b-<ts>`: `test:int admin-target-risk` 8/8 (trước sửa 7/8 như trên), `b74-tester`, `indexes`, `security-headers` xanh; sau mỗi lượt không còn DB nào bắt đầu bằng tên override. Override tên không `vg-int-*` ⇒ vẫn bị guard từ chối. Int full không override 1420/1420, +0 DB.
- **T3**: mỗi chỗ sửa một mutation làm lộ token thật (BE: tạm `this.logger.warn(token)` ở nhánh drop của `token.controller.ts`; chèn access token vào body 503/400; ghi token vào một audit. FE: fake/BFF trả access token trong trang lỗi và trong viewer) ⇒ RED đúng assert đó; hoàn nguyên sha256 khớp; spec xanh ≥ 3 lượt.

### Thứ tự + nhãn
T1 [BE] → T2 [BE] (cùng `full-app.ts`, làm nối tiếp) → T3 [BE] rồi [FE]. Orchestrator gọi **backend-dev** cho T1, T2 và phần BE của T3; **frontend-dev** cho phần FE của T3 (`fe-admin/test/support/fake-idp.ts`, `fe-admin/test/bff.test.ts`). Container Vault/Sentinel của tech-lead ĐÃ xoá (dev tự dựng lại bằng lệnh START, token mới). Không commit.
