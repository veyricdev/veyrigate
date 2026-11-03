# Tasks — run 64 — đuôi test-infra BE (M7, lane test-infra BE)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-470 (`test:vault`/`test:sentinel` cùng lỗi cờ mảng như DEBT-452/456), DEBT-473 (chú thích lỗi thời `be/test/int-preflight.mjs:19`), DEBT-471 (spec int nhẹ `dropDatabase` vô điều kiện khi `TEST_MONGO_URI` đặt; `full-app` thì bỏ drop ⇒ hai ngữ nghĩa — liên quan DEBT-203), DEBT-474 (gộp DEBT-472 vào DEBT-467). Bối cảnh: run 63 (`runs/63-int-setup-sweep/` — `be/jest.int.config.js`, `be/test/int-hooks.ts`).
>
> Tech-lead: xác minh gốc bằng code thật (`--listTests`/`--showConfig` cho vault/sentinel; không cần Vault/Sentinel chạy để chứng minh cấu hình). Quyết mẫu cho DEBT-471 (ứng viên: (a) mọi drop qua `dropIntDb` guard tên `vg-int-`; (b) chặn một chỗ ở globalSetup — `TEST_MONGO_URI` có tên DB không `vg-int-` ⇒ ném lỗi; (c) bỏ drop khi có `TEST_MONGO_URI`) — chọn cái ít diff nhất mà vẫn loại được việc xoá DB người dùng chỉ định, và nói rõ có đóng/cập nhật DEBT-203 không. Không nới timeout/assertion; không `retries`.
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop DB dùng chung (`aegate-*`); chỉ drop DB do chính lượt chạy tạo; KHÔNG chạy `drop-int-orphans.mjs --yes` (chờ người dùng); không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; không tạo/xoá container Vault/Sentinel ngoài tên `vg-b73-vault`/`vg-b73c-*` theo script có sẵn (nếu cần chạy suite thật — chỉ khi tester quyết); không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không commit.

### [x] Task 1 [test-infra/BE]: DEBT-470 — `test:vault`/`test:sentinel` dùng file config riêng như `jest.int.config.js`.
- AC: `pnpm -C be test:vault "<re>" --listTests` (và sentinel) chỉ liệt kê file khớp; `--testTimeout=N` thêm từ CLI ⇒ `--showConfig` cho scalar N; không đổi globalSetup/Teardown, `--forceExit`, `--runInBand`, timeout 60000 hiện có (trừ khi tech-lead chứng minh cần); CI/README trỏ lệnh vẫn đúng.
### [x] Task 2 [test-infra/BE]: DEBT-473 — sửa chú thích `int-preflight.mjs:19` (và chú thích tương tự trong `vault-preflight.mjs`/`sentinel-preflight.mjs` nếu thành lỗi thời sau Task 1).
- AC: không còn chú thích nói gắn qua cờ `--globalSetup` trên CLI.
### [x] Task 3 [test/BE]: DEBT-471 — một ngữ nghĩa drop cho mọi spec int khi `TEST_MONGO_URI` đặt.
- AC: theo quyết định tech-lead; chứng minh bằng mutation/drill: `TEST_MONGO_URI` trỏ DB tên không `vg-int-` ⇒ DB đó KHÔNG bị xoá (dùng DB drill tên riêng trên `vg-test-mongo@27117`, tự dọn sau); int full không có `TEST_MONGO_URI` vẫn 1420/1420, +0 DB `vg-int-*`.
### [x] Task 4 [docs]: DEBT-474 — đóng DEBT-472 gộp vào DEBT-467 (chuyển số đo V11).

## Fold tech-lead (2026-11-03) — bắt buộc

### Gốc đã xác minh (code thật, jest 30.0.5, không cần Vault/Sentinel chạy)

- **DEBT-470 — đúng.** `be/package.json:17-18` để `--testRegex "\.vault-spec\.ts$"` / `"\.sentinel-spec\.ts$"` là cờ CUỐI (yargs `type: array`).
  - Script vault nguyên văn + `run54 --listTests` ⇒ **6 file**: 5 `*.vault-spec.ts` + **`test\run54-tester.int-spec.ts`** (đối số vị trí thành phần tử thứ 2 của `testRegex`, OR) ⇒ bộ lọc không thu hẹp mà còn kéo int-spec vào chạy dưới preflight Vault.
  - Sentinel + `zzz --listTests` ⇒ vẫn ra `redis-sentinel.sentinel-spec.ts` (bộ lọc bị nuốt).
  - Vault + `--testTimeout=5000 --showConfig` ⇒ `"testTimeout": [60000, 5000]` (mảng).
  - Probe config tạm ở scratchpad (`{...jest.config.js, testRegex, testTimeout: 60000, globalSetup, globalTeardown}` + CLI `--runInBand --forceExit`): `run54 --listTests` ⇒ chỉ `run54-tester.vault-spec.ts`; `--testTimeout=5000 --showConfig` ⇒ scalar `5000`. Cách của run 63 áp được nguyên.
- **DEBT-473 — đúng.** `be/test/int-preflight.mjs:19` còn "Attached ONLY via the `--globalSetup` flag in the `test:int` script". `vault-preflight.mjs`/`sentinel-preflight.mjs` KHÔNG có câu tương tự (chỉ "Jest globalSetup for `test:vault`/`test:sentinel`") ⇒ sau Task 1 vẫn đúng, không sửa.
- **DEBT-471 — đúng, rộng hơn backlog ghi.** 37 file trong `be/test/` đọc `TEST_MONGO_URI` theo mẫu `process.env.TEST_MONGO_URI ?? 'mongodb://localhost:27117/vg-int-<x>-<ts>…'` (thay NGUYÊN URI). Có **~45 chỗ `dropDatabase()` trực tiếp** trong 33 spec (admin-*, authentication, authorize-params, clients, consent, debt388, discovery, federation, identity, indexes, introspect, metrics, oauth-tenant-isolation, refresh-token, run54-tester, seed*, session-reflection, tenant-context, token*, ui-auth, userinfo…), không qua `dropIntDb`. `full-app.ts:70` và `:181` thì bỏ drop khi có `TEST_MONGO_URI`. ⇒ `TEST_MONGO_URI=…/sso-idp` + `pnpm -C be test:int consent` sẽ **xoá DB `sso-idp`**. Spec suy DB phụ bằng `.replace('vg-int-…-', …)` (vd. `admin-target-risk.int-spec.ts:334`) sập về chính DB override khi biến đặt (thuộc DEBT-203).
  - `vault-preflight.mjs` gọi `intPreflight()` (default import) ⇒ chặn ở `int-preflight.mjs` phủ cả `test:int` lẫn `test:vault`; `test:sentinel` không dùng Mongo.
  - `jest.config.js` (unit) `testRegex: '.*\\.spec\\.ts$'` không khớp `*.int-spec.ts` ⇒ `pnpm test` không chạy int-spec (không có đường vòng qua unit). Chạy int-spec bằng config tự chế thì bỏ qua globalSetup — ngoài phạm vi, chấp nhận.
- **DEBT-474 — đúng.** DEBT-472 (V11 `vault-transit-key-provider.spec.ts` > 5000 ms dưới tải) cùng gốc DEBT-467.

### Quyết định

- **DEBT-470 ⇒ 2 file config** (CJS, cạnh `jest.int.config.js`, chú thích 1–2 dòng trỏ DEBT-470):
  - `be/jest.vault.config.js`: `{ ...require('./jest.config.js'), testRegex: '\\.vault-spec\\.ts$', testTimeout: 60000, globalSetup: './test/vault-preflight.mjs', globalTeardown: './test/int-teardown.mjs' }`.
  - `be/jest.sentinel.config.js`: `{ ...require('./jest.config.js'), testRegex: '\\.sentinel-spec\\.ts$', testTimeout: 60000, globalSetup: './test/sentinel-preflight.mjs' }` (KHÔNG globalTeardown — giữ như hiện tại, sentinel không lấy int lock).
  - Script: `"test:vault": "node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.vault.config.js --runInBand --forceExit"`, `"test:sentinel": "… --config jest.sentinel.config.js --runInBand --forceExit"`. Giữ `--forceExit` (gỡ là việc riêng, không thuộc run này). CI (`.github/workflows/ci.yml:151,158`) và `runbook-deploy.md:298,419` gọi `pnpm -C be test:vault|test:sentinel` không đối số ⇒ không đổi.
  - Không gộp 2 file thành 1 config chọn theo biến môi trường (thêm nhánh, không lợi).
- **DEBT-473 ⇒** `int-preflight.mjs:19-20` thành: "Attached ONLY via `globalSetup` in `jest.int.config.js` (`test:int`) and, through `vault-preflight.mjs`, in `jest.vault.config.js` (`test:vault`), so plain `pnpm test` (unit) never runs it. Pure JS (.mjs) to avoid ts-jest transform."
- **DEBT-471 ⇒ ứng viên (b): chặn MỘT chỗ ở globalSetup, fail-closed**, + gỡ 2 điều kiện `!TEST_MONGO_URI` ở `full-app.ts` để còn **một** ngữ nghĩa: "DB override phải tên `vg-int-*`, là DB dùng-một-lần; mọi spec drop như nhánh mặc định".
  - (a) = sửa ~45 chỗ drop trong 33 file; (c) = cũng ~45 chỗ. (b) = ~10 dòng ở 1 file + 2 điều kiện ở `full-app.ts`, chặn TRƯỚC khi bất kỳ spec nào kết nối (kể cả spec drop ở `beforeAll`/vòng lặp như `seed-risk`). Chọn (b).
  - `int-preflight.mjs`, trong `intPreflight()` ở dòng ĐẦU (trước probe và trước `acquireLock()` ⇒ ném ra không để lại lock/kết nối nào):
    ```js
    // DEBT-471: specs use TEST_MONGO_URI as-is and drop it; refuse anything but a throwaway vg-int-* DB.
    const override = process.env.TEST_MONGO_URI;
    if (override !== undefined) {
      const m = /^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(override);
      const db = m ? decodeURIComponent(m[1]) : '';
      if (!db.startsWith('vg-int-')) {
        throw new Error(`TEST_MONGO_URI must name a throwaway "vg-int-*" DB (got "${db}"): int specs drop it`);
      }
    }
    ```
    Thông điệp CHỈ in tên DB, KHÔNG in URI (có thể chứa user:pass). `""`, không path, `/?x=1`, URI hỏng ⇒ tên rỗng ⇒ từ chối (fail-closed). Tech-lead đã thử regex: `…/vg-int-x?…` ✓, `…/sso-idp` ✗, `u:p@a:1,b:2/vg-int-y` ✓, `mongodb+srv://h/vg-int-z` ✓, không DB ✗, `""` ✗. `decodeURIComponent` ném với `%` hỏng ⇒ globalSetup ném = vẫn fail-closed (chấp nhận).
  - `full-app.ts:70`: bỏ `&& !process.env.TEST_MONGO_URI` (giữ `dropIntDb(...).catch(() => undefined)`). `full-app.ts:181`: bỏ điều kiện, giữ `await conn.dropDatabase()` (kết nối đã mở; guard tên nằm ở preflight).
  - KHÔNG sửa 33 spec nhẹ; KHÔNG đổi `dropIntDb`.
  - **DEBT-203: KHÔNG đóng, cập nhật.** (b) bỏ được hậu quả nặng (xoá DB người dùng/dev), nhưng override vẫn thay NGUYÊN URI ⇒ mọi spec chung một DB ⇒ đỏ giả khi chạy nhiều spec (và DB phụ suy bằng `.replace` sập về một). Ghi vào DEBT-203: "run 64: preflight chặn override không `vg-int-*`; phần base URI + hậu tố mỗi spec còn mở; chỉ đặt biến khi chạy MỘT spec".
- **DEBT-474 ⇒** gạch DEBT-472 "✅ ĐÓNG (run 64: gộp DEBT-467)", nối vào mô tả DEBT-467 số đo V11: lượt `pnpm -C be test` ngay sau int dưới tải 48,6 s (V11 > 5000 ms) vs chạy lại 630/630 38,0 s (run 63 backend-dev).

### File / điểm sửa

| File | Sửa |
|---|---|
| `be/jest.vault.config.js` (mới) | như trên |
| `be/jest.sentinel.config.js` (mới) | như trên |
| `be/package.json:17-18` | 2 script dùng `--config`, chỉ còn `--runInBand --forceExit` |
| `be/test/int-preflight.mjs:19-20` | chú thích (DEBT-473) |
| `be/test/int-preflight.mjs` `intPreflight()` | guard DEBT-471 ở dòng đầu |
| `be/test/full-app.ts:70`, `:181` | bỏ điều kiện `!process.env.TEST_MONGO_URI` |
| `docs/agile/sso-idp/backlog.md` | DEBT-470/471/473 đóng; DEBT-472 đóng gộp; DEBT-467 thêm số đo V11; DEBT-203 thêm ghi chú run 64 |

### Chứng minh (dev tự verify; tester lặp lại)

1. **DEBT-470** (không cần Vault/Sentinel): `pnpm -C be test:vault run54 --listTests` ⇒ đúng 1 file `run54-tester.vault-spec.ts` (trước sửa: 6, có `run54-tester.int-spec.ts`); `pnpm -C be test:sentinel zzz --listTests` ⇒ 0 file; `pnpm -C be test:vault --testTimeout=5000 --showConfig` ⇒ `"testTimeout": 5000` scalar, `globalSetup` = `vault-preflight.mjs`, `globalTeardown` = `int-teardown.mjs`; sentinel `--showConfig` ⇒ `globalTeardown: null`, `testTimeout: 60000`; cả hai không filter ⇒ `--listTests` = 5 vault-spec / 1 sentinel-spec như trước. Không bắt buộc chạy suite Vault/Sentinel thật (không đổi spec); tester chỉ chạy thật nếu tự quyết, bằng script có sẵn (`vg-b73-vault`/`vg-b73c-*`).
2. **DEBT-471 drill** (trên `vg-test-mongo@27117`, DB riêng `vg-drill471-<ts>` — KHÔNG có tiền tố `vg-int-`):
   - Tạo DB drill + 1 doc (vd. `docker exec vg-test-mongo mongosh --quiet vg-drill471-<ts> --eval 'db.d.insertOne({k:1})'`).
   - `TEST_MONGO_URI="mongodb://localhost:27117/vg-drill471-<ts>?directConnection=true" pnpm -C be test:int consent` ⇒ exit ≠ 0, lỗi globalSetup nêu `vg-drill471-<ts>`, KHÔNG có URI đầy đủ; `countDocuments` của DB drill vẫn = 1; `vg:int-lock` không bị giữ.
   - **Mutation**: tạm vô hiệu guard ⇒ cùng lệnh ⇒ DB drill BIẾN MẤT (consent `afterAll` drop) ⇒ chứng minh guard là thứ chặn. Hoàn nguyên (diff cuối không chứa mutation).
   - Dương: `TEST_MONGO_URI=".../vg-int-drill471-<ts>?directConnection=true" pnpm -C be test:int consent` xanh và sau đó DB đó không còn; tương tự với 1 spec full-app (vd. `pnpm -C be test:int security-headers`) ⇒ xanh + DB bị drop (chứng minh `full-app.ts` cùng ngữ nghĩa). KHÔNG chạy cả suite với override (DEBT-203).
   - Dọn: drop DB drill theo ĐÚNG tên đã tạo. Không đụng `vg-int-*` khác, không `drop-int-orphans.mjs --yes`.
3. Hồi quy: `pnpm -C be test:int` (không override) 1420/1420, đếm `vg-int-*` trước/sau +0; `pnpm -C be test` 630/630; lint + `tsc` sạch cho file đổi.
4. Không nới timeout/assertion, không `retries`, không đổi spec ngoài `full-app.ts`.
