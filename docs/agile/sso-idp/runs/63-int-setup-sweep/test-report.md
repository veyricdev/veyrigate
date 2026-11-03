# Test Report — 2026-11-03 (tester, run 63)

## Kết quả: PASS (full int 1420/1420, unit 630/630, mutation 5/5 hành vi đúng kỳ vọng)

Hạ tầng: `vg-test-mongo`/`vg-test-redis` đã chạy sẵn (không start/stop gì). Đếm trước mọi lượt: `listdb.mjs vg-int- -q` = **610**, keyDir `vg-*-keys-*` trong `$TEMP` = **19**.

## Lệnh đã chạy + output thực tế

1. **Full int rảnh ×1** — `pnpm -C be test:int` (log `scratchpad/t63t/full.log`)
   - `Test Suites: 53 passed, 53 total` / `Tests: 1420 passed, 1420 total` / `Time: 496.153 s`; exit 0, wall 499 s (1793686508 → 1793687007), tự thoát (không `--forceExit`).
   - `[int] setup failed` = 0, `Exceeded timeout` = 0; `TypeError` = 2 dòng, đều là log cố ý `vault read failed: TypeError` (có từ run 61).
   - Sau: DB 610 (**+0**), keyDir 19 (**+0**).
2. **Lọc/config** (không chạy test)
   - `pnpm -C be test:int authorize --listTests` ⇒ đúng 2 file: `authorize.int-spec.ts`, `authorize-params.int-spec.ts`.
   - `pnpm -C be test:int --listTests` ⇒ 53 dòng `*.int-spec.ts`.
   - `--testTimeout=30000 --showConfig` ⇒ `"testTimeout": 30000` (scalar, cả 2 chỗ); không cờ ⇒ `20000`; `globalSetup`=`test\int-preflight.mjs`, `globalTeardown`=`test\int-teardown.mjs`.
   - Lượt lọc thật `pnpm -C be test:int "demo[.]int"` ⇒ chỉ `PASS test/demo.int-spec.ts`, `Tests: 15 passed, 15 total`, exit 0; DB 610 (+0), keyDir 19 (+0).
3. **Mutation** — spec tạm `be/test/zz-t63t-mut.int-spec.ts` (đã xoá), `pnpm -C be test:int zz-t63t`, exit 1 (mong đợi), wall 27 s, tự thoát. `Tests: 3 failed, 2 passed` — 3 đỏ là cố ý.
   - **(a) M1 hook timeout giữa seed** (`bootFullApp({name:'t63tmut'})` + 50 insert cách 100 ms, hook 3000 ms): `Exceeded timeout of 3000 ms for a hook` (mong đợi); `seed-done 1793687070090` ≤ `close-start 1793687070117` ⇒ close chạy SAU seed. DB `vg-int-t63tmut*` = 0, keyDir `*t63t*` = 0, tổng DB 610 / keyDir 19.
   - **(b) M2a setup ném sớm** (trước khi gán `full`): chỉ lỗi gốc `t63t boom early` + `[int] setup failed: t63t boom early`; `TypeError` trong log = 0. **M2b** reject sau hook timeout 500 ms ⇒ `[int] setup failed: t63t late reason` (lý do không bị nuốt).
   - **(c) `dropIntDb` guard**: URI `.../t63t-not-int` ⇒ reject `dropIntDb: refusing DB "t63t-not-int"`; look-alike `.../vg-intx-t63t` ⇒ reject `refusing DB "vg-intx-t63t"`. Cả 2 PASS. `listdb t63t` = 0 (không tạo DB nào).
   - Dọn: không có DB/keyDir nào do mutation để lại ⇒ không drop gì.
4. **Unit** — `pnpm -C be test` ⇒ `Test Suites: 39 passed`, `Tests: 630 passed, 630 total`, exit 0, 31 s.
5. **Grep tĩnh** (AC Task 1/2): `closeFullApp|FULL_APP_BOOT_TIMEOUT_MS|(setup = (async` = 0 dòng; mẫu `beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS)` = 28; `int-hooks.ts` chỉ import `mongoose`; 14 file nhẹ import `./full-app` = 0; drop cấp file có ở `client-auth-rate-limit`:591, `authorize`:1485, `demo`:380.

## Test FAIL (nếu có)
Không có (3 đỏ trong spec mutation là kỳ vọng).

## Coverage acceptance criteria
- [x] Task 1 (DEBT-461/462/463) — grep tĩnh (5); M1 close sau seed, 0 mồ côi (3a); M2a/M2b không TypeError, giữ lý do (3b); unit 630 (4).
- [x] Task 2 (DEBT-454) — full int +0 DB (1); lượt lọc `demo` +0 (2).
- [x] Task 3 (DEBT-452/456) — `--listTests` 2/53, `testTimeout` scalar 30000 / mặc định 20000, global hooks đúng (2).
- [x] Ổn định — full int rảnh 1420/1420, exit 0, tự thoát, DB/keyDir +0, 0 `setup failed`/`Exceeded timeout` (1).
- [ ] `test:vault` — không chạy (không có container Vault dev), như backend-dev.

## Coverage security invariants / risk matrix
- [x] Dependency / State (setup timeout, setup fail sớm, reject muộn) — 3a, 3b.
- [x] Input/guard xoá dữ liệu: tên DB ngoài `vg-int-` và look-alike `vg-intx-` bị từ chối trước `dropDatabase` (fail closed) — 3c.
- [x] Exposure: lý do lỗi setup hiện trong log `[int] setup failed: <msg>` — 3b.
- Không áp dụng Identity/Authorization (thay đổi chỉ ở hạ tầng test).

Debt mới: không có.
