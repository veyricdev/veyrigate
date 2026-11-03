# Test Report — 2026-11-03 (run 64, tester)

## Kết quả: PASS (AC 4/4; int 1420/1420, unit 630/630, drill + 2 mutation đúng kỳ vọng)

Kiểm độc lập trên diff chưa commit (`be/jest.vault.config.js`, `be/jest.sentinel.config.js`, `be/package.json`, `be/test/int-preflight.mjs`, `be/test/full-app.ts`). Không sửa code sản phẩm; 2 mutation tạm đã hoàn nguyên byte-identical (sha256).

## Lệnh đã chạy + output thực tế

### Case 1 — DEBT-470 `--listTests` (không cần Vault/Sentinel)
| Lệnh | Kết quả |
|---|---|
| `pnpm -C be test:vault --listTests` | 5 file: `b73-tester`, `vault-transit`, `run55-tester`, `b73c-tester`, `run54-tester` `.vault-spec.ts` |
| `pnpm -C be test:vault run54 --listTests` | 1 file `test\run54-tester.vault-spec.ts` |
| `pnpm -C be test:vault zzzqq --listTests` | 0 file |
| `pnpm -C be test:sentinel --listTests` | 1 file `redis-sentinel.sentinel-spec.ts` |
| `pnpm -C be test:sentinel run54 --listTests` / `zzzqq` | 0 / 0 |
| Đối chứng script CŨ (HEAD) chạy tay `… --testRegex "\.vault-spec\.ts$" run54 --listTests` | 6 file, gồm `run54-tester.int-spec.ts` (tái hiện lỗi gốc) |

### Case 2 — DEBT-470 `--showConfig`
- vault: `testRegex ["\\.vault-spec\\.ts$"]`, `testTimeout 60000`, globalSetup `be\test\vault-preflight.mjs`, globalTeardown `be\test\int-teardown.mjs`, `forceExit true`, `runInBand true`, `maxWorkers 1`.
- vault `--testTimeout=5000`: `"testTimeout": 5000` (scalar, cả project lẫn globalConfig).
- sentinel: `testRegex ["\\.sentinel-spec\\.ts$"]`, `testTimeout 60000`, globalSetup `sentinel-preflight.mjs`, **không có** `globalTeardown` (grep 0 dòng), `forceExit`/`runInBand` true; `--testTimeout=5000` ⇒ scalar 5000.

### Case 3 — fail-fast thiếu env
- `pnpm -C be test:vault` (không `VAULT_TEST_*`) ⇒ rc 1, `globalSetup … vault-preflight.mjs, reason: test:vault needs VAULT_TEST_ADDR and VAULT_TEST_ROOT_TOKEN. Start a dev Vault:` + lệnh hướng dẫn.
- `pnpm -C be test:sentinel` ⇒ rc 1, `test:sentinel needs the throwaway Sentinel on 127.0.0.1:26390 … bash be/scripts/sentinel-test-env.sh up`.

### Case 4 — DEBT-471 drill âm qua `test:int` (vg-test-mongo@27117)
- Tạo `vg-drill471t-1793694204` + 1 doc (count 1). `vg-int-*` trước: 610.
- `TEST_MONGO_URI="mongodb://localhost:27117/vg-drill471t-1793694204?directConnection=true" pnpm test:int "consent[.]"` ⇒ **rc 1**, `int-preflight.mjs, reason: TEST_MONGO_URI must name a throwaway "vg-int-*" DB (got "vg-drill471t-1793694204"): int specs drop it`; grep `localhost:27117` trong output = **0**; count doc = **1**; `redis-cli EXISTS vg:int-lock` = **0**.

### Case 5 — DEBT-471 drill âm qua `test:vault`
- Stub HTTP local (node, 127.0.0.1:18299, `/v1/sys/health` ⇒ 200; không container) để vượt bước Vault health tới `intPreflight()`; `VAULT_TEST_ROOT_TOKEN` là giá trị giả.
- `… pnpm test:vault run54` với cùng `TEST_MONGO_URI` ⇒ **rc 1**, `vault-preflight.mjs, reason: TEST_MONGO_URI must name a throwaway "vg-int-*" DB (got "vg-drill471t-1793694204")…`; grep URI/token giả trong output = **0**; count = **1**; lock = **0**. Stub đã dừng (TaskStop).

### Case 6 — Mutation guard (chứng minh guard là thứ chặn)
- sha256 `int-preflight.mjs` trước: `0d510148…e7d6e8d6ce3e6fb9fc04765e2be800c7e1aed8`; 146 dòng trước/sau sed.
- Mutation `if (false && !db.startsWith('vg-int-'))` ⇒ cùng lệnh Case 4 ⇒ rc 0, consent 18/18 và DB `vg-drill471t-1793694204` **biến mất** (listDatabases 0).
- Hoàn nguyên từ bản sao ⇒ sha256 `0d510148…aed8` khớp; lock 0.

### Case 7 — Guard, các biên (gọi `intPreflight()` trực tiếp, chỉ input bị từ chối, nên không tới probe/lock)
`""`, không path, `/` rỗng, `/?x=/vg-int-a`, `u:p@h:1/sso-idp`, `MONGODB://` hoa, `http://h/vg-int-a`, `xvg-int-a` ⇒ đều REJECT, message chỉ chứa tên DB (không `u:p@`/host); `%ZZ` ⇒ `URI malformed` (vẫn ném = fail-closed). Mọi tham chiếu Mongo env trong `be/test` là `TEST_MONGO_URI` (38/38), nên không có biến nào khác đi vòng qua guard.

### Case 8 — Override dương `vg-int-*`
- `vg-int-drill471t-consent-1793694204` ⇒ consent 1/1 suite, 18/18; DB sau run: không còn.
- `vg-int-drill471t-security-headers-1793694204` (spec full-app) ⇒ 114/114; DB sau run: không còn.
- Mutation đối chứng `full-app.ts:181` về `if (!process.env.TEST_MONGO_URI) await conn.dropDatabase();` (269 dòng trước/sau) ⇒ security-headers 114/114 và DB `vg-int-drill471t-fa-mut-1793694204` **còn lại** (exists=1) ⇒ chứng minh override được dùng và chính thay đổi `full-app.ts` là thứ drop. Hoàn nguyên sha256 `f9e32dd6…6897d0d` khớp.
- Dọn: drop đúng `vg-int-drill471t-fa-mut-1793694204` (`{"ok":1,"dropped":…}`); `vg-drill471t-1793694204` đã bị mutation Case 6 xoá. Còn `*drill471t*` = 0. `git status be/` chỉ còn diff của dev.

### Case 9 — Hồi quy
- `pnpm -C be test:int` (không `TEST_MONGO_URI`, env check 0): **53/53 suite, 1420/1420**, 491,2 s, rc 0. `vg-int-*` 610 trước / **610 sau (+0)** (610 là orphan cũ, chờ người dùng duyệt `--yes`). Lock sau run 0.
- `pnpm -C be test`: **39/39 suite, 630/630**, 33,0 s, rc 0.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Task 1 DEBT-470: lọc qua `--listTests` vault 5/1/0, sentinel 1/0/0 (Case 1); `--testTimeout=5000` scalar; globalSetup/Teardown, `--forceExit`, `--runInBand`, 60000 như script cũ; sentinel không teardown (Case 2); CI/README gọi không đối số, chạy như cũ, fail-fast có hướng dẫn (Case 3).
- [x] Task 2 DEBT-473: chú thích `int-preflight.mjs:19-21` trỏ `jest.int.config.js`/`jest.vault.config.js`, không còn "`--globalSetup` flag" (diff).
- [x] Task 3 DEBT-471: Case 4–8 + int full 1420/1420 +0 DB (Case 9).
- [x] Task 4 DEBT-474: backlog DEBT-472 đóng gộp DEBT-467 (đã review senior; tester không đổi).

## Coverage security invariants / risk matrix
- [x] Invariant "không spec int nào drop DB tên khác `vg-int-*`": Input valid/boundary/malformed (Case 7), DB thật bị chặn qua 2 đường vào `test:int`/`test:vault` (Case 4/5), mutation chứng minh guard là thứ chặn (Case 6).
- [x] Fail-closed: URI rỗng/không path/hỏng/`%` hỏng ⇒ ném (Case 7). Thứ tự: ném trước probe/lock ⇒ không lock sót (Case 4/5).
- [x] Exposure: output/log không chứa URI, credential hay token giả (Case 4/5/7).
- [x] State: lock `vg:int-lock` = 0 sau mỗi lượt; DB drill dọn đúng tên.
- Ngoài phạm vi (đã ghi DEBT-203): override thay nguyên URI ⇒ chỉ dùng cho MỘT spec.

Debt mới: không.
