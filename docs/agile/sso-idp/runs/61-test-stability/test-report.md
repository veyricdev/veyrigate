# Test Report — 2026-11-03 (tester, run 61)

## Kết quả: PASS (T1–T5 đều PASS; 0 test đỏ ngoài mutation/drill cố ý)

Máy 28 lõi, rảnh. Tester tự `docker start vg-test-mongo vg-test-redis` (trước đó Exited) và dừng lại sau khi xong. `vg:int-lock` trống trước mỗi lượt int. Cổng 3000/4000/5173 trống trước E2E.

## Lệnh đã chạy + output thực tế

### Case 1 — `pnpm -C be test:int` full, không `--forceExit` (script hiện tại không còn cờ này)
```
Test Suites: 53 passed, 53 total
Tests:       1420 passed, 1420 total
Time:        513.927 s
Ran all test suites.
EXIT=0
```
- Thời điểm (timestamp theo dòng): dòng `Test Suites` 1793670003.19 → tiến trình thoát (`EXIT=0`) 1793670003.71 ⇒ **tự thoát ≈ 0,5 s** sau dòng tổng kết. Không có "Jest did not exit", không có warn `[int-preflight]`/`[int-teardown]`.
- DB `vg-int-*` (listDatabases, read-only): trước **607** → sau **610**. 3 DB mới: `vg-int-authorize-1793669794143`, `vg-int-clrl-1793669852236`, `vg-int-demo-1793669986190` — đúng 3 suite tự dựng app đã nêu nguyên văn trong DEBT-454 (ghi sau `dropDatabase`; không qua `bootFullApp`). 0 DB từ suite full-app. keyDir `vg-*-keys-*` trong `%TEMP%`: 19 trước = 19 sau (0 mới).

### Case 2 — T1 mutation `bootFullApp` ném lỗi (spec tạm `be/test/zz-t61-mut.int-spec.ts`, đã xoá)
Chèn tạm `throw new Error('T61-MUT-<stage>')` (bật bằng env `T61_MUT`) sau `compile`, sau `app.init()`, sau `syncAllIndexes`. Spec mỗi stage: `expect(bootFullApp(...)).rejects.toThrow('T61-MUT-<stage>')` + liệt kê DB `vg-int-t61mut-<stage>-*` và keyDir `vg-t61mut-<stage>-keys-*`.
```
T61 compile leftovers {"dbs":[],"dirs":[]}
T61 init leftovers {"dbs":[],"dirs":[]}
T61 sync leftovers {"dbs":[],"dirs":[]}
Tests: 3 passed, 3 total
```
- Đối chứng (kiểm probe có nhạy): tạm comment `dropDatabase` + `rm(keyDir)` trong `catch` của `bootFullApp` ⇒ **3 failed**, mỗi stage còn 1 DB + 1 keyDir (vd. `vg-int-t61mut-sync-1793670165086`, `vg-t61mut-sync-keys-4cVLi2`). Đã drop đúng 3 DB đó và xoá đúng 3 keyDir đó (do chính drill tạo).
- Khôi phục: `sha256sum -c` ⇒ `full-app.ts: OK` (`f8f7d862…7b083b`); spec tạm đã xoá; DB count về 610.

### Case 3 — T4 đọc code + drill A (6479, chỉ key `vg:int-lock`)
- Đọc code: heartbeat `EXTEND_LUA` trả 0 ⇒ `lock.lost = true` + warn (một lần); lỗi Redis của heartbeat chỉ warn. Teardown: `RELEASE_LUA` so giá trị, 0 ⇒ warn; `lost || released === 0` ⇒ ném sau khi đã `quit`/`disconnect`; lỗi Redis ở teardown (released undefined) chỉ warn, không ném. Chỉ chạm `vg:int-lock`.
- Drill A: `pnpm test:int --testPathPatterns "run56-tester|security-headers"`, ~3 s sau khi lock được giữ, `SET vg:int-lock t61-tester-drill PX 120000`:
```
[int-preflight] lost vg:int-lock: another run may have shared vg-test-*
Tests:       132 passed, 132 total
[int-teardown] vg:int-lock no longer held this run's token
Error: Jest: Got error running globalTeardown - ...int-teardown.mjs, reason: [int-teardown] vg:int-lock was lost during this run: failing it (not exclusive)
EXIT=1
after=t61-tester-drill
```
  Test xanh nhưng exit 1 (fail-closed), key vẫn giữ giá trị drill (teardown không xoá lock của người khác) ⇒ DEL chỉ khi giá trị = `t61-tester-drill` ⇒ `EXISTS` 0.

### Case 4 — FE
- `pnpm -C fe-admin test`: `Tests 1533 passed (1533)` (66 file), 36,2 s.
- `pnpm exec vitest run test/session-store.test.ts` × 20 (Redis 6479 bật): **pass=20 fail=0**, mỗi lượt `Tests 15 passed (15)`, không skip.

### Case 5 — E2E lab (cổng 3000/4000 trống, không `E2E_REUSE`)
`pnpm -C e2e exec playwright test tests/lab.spec.ts -g "refresh replay" --repeat-each=5`:
```
ok 5 [chromium] › tests\lab.spec.ts:73:1 › lab refresh replay: rotate, replay old RT ⇒ invalid_grant, descendant ⇒ invalid_grant (2.1s)
5 passed (1.4m)
```
Log server: lượt replay RT cũ ⇒ `TOKEN_REUSE_DETECTED` + 400, descendant ⇒ 400. Sau lệnh, webServer tự dừng (3000/4000/5173 không còn LISTENING).

## Test FAIL (nếu có)
- Không có. (Đỏ cố ý: control case 2, drill A case 3.)

## Coverage acceptance criteria
- [x] T1 DEBT-448 — case 2 (ném sau compile/init/sync ⇒ lỗi gốc, 0 DB, 0 keyDir; đối chứng RED), case 1 (0 DB/keyDir từ suite full-app, 1420 xanh).
- [x] T2 DEBT-450 — case 4 (session-store 20/20 với Redis thật; fe-admin 1533).
- [x] T3 DEBT-432 — case 5 (5/5).
- [x] T4 DEBT-206 — case 3 (đọc code + drill A: warn + exit 1 + không xoá lock người khác).
- [x] T5 DEBT-096 — case 1 (không `--forceExit`, exit 0, tự thoát ≈ 0,5 s ≤ 15 s).
- [x] Chứng minh ổn định BE (phần tester) — case 1 full rảnh 1420/1420. Không lặp lượt dưới tải (backend-dev đã có; ngoài yêu cầu tester).

## Coverage security invariants / risk matrix
- [x] State (lock) — fresh (case 1 exit 0), overwritten giữa chừng (case 3 ⇒ fail-closed, exit 1).
- [x] Dependency — Redis lỗi ở teardown chỉ warn (đọc code; không drill).
- [x] Exposure — session-store: AT/IDT/RT/cookie không ở dạng rõ/base64/base64url (case 4, ×20).
- [x] Replay — RT cũ + descendant bị từ chối (case 5).
- Ghi nhận (không chặn, đã có debt): DEBT-454 tái hiện đúng 3 DB `authorize`/`clrl`/`demo` mỗi lượt full.
