# Tasks — run 61 — độ ổn định test (M7, lane test/BE/FE)

> Nguồn: `backlog.md` (đọc nguyên văn + run gốc): DEBT-448 (int timeout `beforeAll`/boot khi máy tải cao — tái hiện run 59, 60: `run56-tester`, `seed-risk`, `seed`, `admin-public-client`, `runbook-drill`, `client-auth-rate-limit`), DEBT-450 (`fe-admin/test/session-store.test.ts` assert không chứa `eyJ` trên ciphertext base64 ngẫu nhiên ⇒ flaky), DEBT-432 (E2E `e2e/tests/lab.spec.ts:73` `lab-replay-step-1` timeout 5 s), DEBT-206 (`int-preflight.mjs` heartbeat bỏ qua kết quả `EXTEND_LUA` = 0), DEBT-096 (`test:int` có `--forceExit`). Mục tiêu: test xanh ổn định mà KHÔNG nới lỏng assertion bảo mật, không thêm retry tràn lan, không tăng timeout toàn cục mù quáng.
>
> Tech-lead: xác minh nguyên nhân gốc từng debt (đọc code thật), thiết kế sửa (ưu tiên sửa gốc: boot app chung, giới hạn worker, chờ có điều kiện thay vì sleep, assertion chính xác hơn), cách chứng minh ổn định (chạy lặp N lần, dưới tải giả lập nếu khả thi), chọn ≤5 task. Hạ tầng: KHÔNG compose up/FLUSH/drop; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop).

### [x] Task 1 [test/BE]: DEBT-448 (+ DEBT-096, DEBT-206 nếu cùng gốc).
### [x] Task 2 [test/FE]: DEBT-450.
### [x] Task 3 [E2E]: DEBT-432.

---

## Fold tech-lead (2026-10-28) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Một run, 5 task. Lane BE: Task 1 → Task 4 → Task 5 → chứng minh ổn định BE. Lane FE (song song): Task 2, Task 3. Không đổi `expect` bảo mật nào ở int/E2E/fe-admin ngoài Task 2 (thay bằng kiểm chặt hơn). Timeout chỉ được nâng ở hook boot qua MỘT hằng số, hoặc từng test có số đo kèm chú thích. Cấm `retries`, cấm nâng `--testTimeout`/expect timeout toàn cục, cấm giảm số vòng/round của test race. Không compose up/FLUSH/drop DB dùng chung; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop). Lọc int: `--testPathPatterns <re>` (đối số vị trí bị bỏ qua ⇒ chạy full ngoài ý muốn — cả 2 sự cố run 59/60 xảy ra ở lượt full ngoài ý muốn, DEBT-452).

**Số đo tech-lead** (máy 28 lõi, rảnh; `security-headers` 114 test ~1 ms/test ⇒ thời gian suite ≈ boot): cache ts-jest ấm **15,8 s / 16,4 s**, `--no-cache` **30,9 s**; `run56-tester` chạy sau nó 19,6 s (tổng test ~8 s ⇒ boot ~11 s). Sự cố: hook 90 s vượt khi lượt chậm ~1,8–2× ⇒ boot 15–30 s nhân 2 chưa đủ giải thích một mình.

**Nguyên nhân gốc xác minh bằng code (khuếch đại dây chuyền)**: khi `beforeAll` hết giờ, `full` chưa được gán ⇒ `afterAll` (`if (full) await full.close()`) bỏ qua, nhưng `bootFullApp` vẫn chạy tiếp ở nền ⇒ app mồ côi giữ kết nối Mongo/Redis, DB `vg-int-<name>-<ts>` không drop, keyDir không xoá, tiếp tục ăn CPU/IO song song với các suite sau (`--runInBand`, cùng process) và bị `--forceExit` che (DEBT-096). Ngoài ra `bootFullApp` ném lỗi giữa chừng (`app.init`/`syncAllIndexes`) cũng không đóng app/xoá keyDir.

### [x] Task 1 [test/BE] DEBT-448 — backend-dev
1. **Đo trước (bắt buộc; instrument tạm, không commit)**: đo theo pha trong `bootFullApp` (`compile`; `configureApp`+`init`+`ready`; `syncAllIndexes`) và tổng suite cho `security-headers`, `run56-tester`, `runbook-drill`, `seed-risk`, `seed`, `admin-public-client`, `client-auth-rate-limit`: (a) cache ấm, (b) `--no-cache`, (c) dưới tải CPU giả lập. Tải giả lập = script trong scratchpad (worker_threads busy-loop; KHÔNG chạm Docker), chỉnh số worker đến khi `security-headers` chậm ≥ 2× so với (a); ghi số worker. Bảng số đo vào log.md. Gỡ instrument, sha256 xác nhận.
2. **Sửa gốc dây chuyền** trong `be/test/full-app.ts`: (i) `bootFullApp` tự dọn khi ném lỗi (đóng app nếu đã tạo, `rm` keyDir, ném lại lỗi gốc); (ii) export `FULL_APP_BOOT_TIMEOUT_MS` — một hằng số, giá trị ≈ max(boot dưới tải (c)) × 3 làm tròn, chú thích ghi số đo; (iii) helper `closeFullApp(pending?: Promise<FullApp>)` = chờ promise boot (nuốt lỗi boot vì `beforeAll` đã báo) rồi `close()`. Mọi `.int-spec.ts` gọi `bootFullApp` (11 file / 17 chỗ) giữ promise boot, `beforeAll(…, FULL_APP_BOOT_TIMEOUT_MS)` và `afterAll(() => closeFullApp(booting), FULL_APP_BOOT_TIMEOUT_MS)`. Không đổi `.vault-spec.ts`/`.sentinel-spec.ts` (không chạy được ở run này; DEBT-412 giữ mở).
3. Suite tự dựng app/kết nối (`client-auth-rate-limit`, `admin-public-client`, `seed`, `seed-risk`): chỉ áp mẫu dọn-khi-timeout + hằng số boot khi bảng đo cho thấy hook đó cần. Timeout THÂN test (vd. `seed-risk` 10 vòng 120 s, 1 test `client-auth-rate-limit` 20 s) chỉ nâng từng test khi số đo dưới tải (c) × 2 > timeout hiện tại, chú thích số đo; không đổi assertion/số vòng.
4. (Tuỳ số đo) Nếu (b) − (a) ≥ 40 % boot (a): thử ts-jest transpile-only (`isolatedModules: true` trong `jest.config.js`, kiểm kiểu đã do `pnpm -C be typecheck`). Chỉ giữ khi không có cảnh báo deprecation, be unit + int full xanh, typecheck 0; không đạt ⇒ bỏ, ghi số đo.
5. **Mutation T1**: tạm đặt timeout hook boot của `security-headers` = 1 ms, chạy `--testPathPatterns "security-headers|run56-tester"` ⇒ `security-headers` đỏ (mong đợi), `run56-tester` XANH, sau lệnh KHÔNG còn DB `vg-int-security-headers-*` (liệt kê qua script node read-only tới 27117; không drop thủ công DB nào ngoài DB mồ côi do chính drill tạo). Lặp drill trên bản CHƯA sửa (stash tạm) ⇒ DB còn sót ⇒ chứng minh fix có tác dụng. Khôi phục byte-identical (sha256).

### [x] Task 2 [test/FE] DEBT-450 — frontend-dev
- Gốc: `raw` chứa ciphertext/IV/tag base64url ngẫu nhiên ~180 ký tự ⇒ P(chứa `eyJ`) ≈ 180/64³ ≈ 1/1 400 mỗi lượt.
- Fixture `accessToken`/`idToken` có dạng JWT thật, dài, phân biệt (header `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9`, payload, sig ≥ 20 ký tự mỗi phần); RT giữ.
- Thay `not.toContain("eyJ")` bằng: với mỗi bí mật S ∈ {accessToken, idToken, RT, cookie} và mỗi phần JWT: `raw` không chứa S, `base64(S)`, `base64url(S)`; mọi đoạn `[A-Za-z0-9_-]{16,}` của `raw` sau `Buffer.from(seg, "base64url")` không chứa S hay `"accessToken"`/`"refreshToken"`/`"idToken"` (giữ ý nghĩa cũ của `eyJ` = bắt "mã hoá base64 chứ không mã hoá mật"). Thêm kiểm cấu trúc: tập khoá của `JSON.parse(raw)` đúng tập mong đợi; `tokens` khớp `^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$`.
- **Mutation** `fe-admin/src/server/session/store.ts` (sha256 trước/sau, khôi phục byte-identical): (M1) lưu tokens JSON rõ ⇒ RED; (M2) lưu `base64url(JSON.stringify(tokens))` ⇒ RED; (M3) thêm field `accessToken` rõ cạnh blob ⇒ RED.
- **Ổn định**: script scratchpad 10 000 lần `create` (vg-test-redis, chỉ xoá key mình tạo) đếm số `raw` dính kiểm cũ (`includes("eyJ")`, kỳ vọng > 0) vs kiểm mới (kỳ vọng 0); `session-store.test.ts` 50 lượt liên tiếp xanh; `pnpm -C fe-admin test` full ≥ 1533, typecheck/lint 0.

### [x] Task 3 [E2E] DEBT-432 — frontend-dev
- Gốc (code): `Lab.tsx` `onReplay` chỉ `setSteps` SAU khi cả 3 bước xong = 3 lượt `/token` tuần tự (+ kiểm id_token qua JWKS ở bước 1) ⇒ `expect(step-1)` mặc định 5 s thực chất chờ toàn chuỗi.
- Sửa `e2e/tests/lab.spec.ts`: sau `run.click()` chờ có điều kiện `await expect(page.getByTestId("lab-replay-steps")).toBeVisible({ timeout: 20_000 })` (chú thích: 3 round trip tuần tự render cùng lúc; cùng cỡ `lab-result-*` 15 s), rồi `await expect(run).toBeEnabled()`; giữ nguyên assert PASS từng bước, `lab-replay-note`, `exchanges === 2`, `unreadable === 0`, `expectNoSecretsExposed`. Không đổi `playwright.config` (retries 0, expect timeout mặc định), không thêm `waitForTimeout`.
- **Ổn định** (cổng trống, không `E2E_REUSE`): `pnpm -C e2e exec playwright test tests/lab.spec.ts -g "refresh replay" --repeat-each=10` rảnh 10/10 và dưới tải CPU giả lập 10/10, ghi thời gian mỗi lượt; E2E full 1 lần 36/36. Mutation: tạm đổi `replayRefreshToken` thành no-op (bước 2 ⇒ "ACCEPTED", FAIL) ⇒ test RED ⇒ khôi phục byte-identical.

### [x] Task 4 [test/BE] DEBT-206 — backend-dev
- `int-preflight.mjs`: heartbeat `.then((n) => { if (n === 0) { mark lost; console.warn('[int-preflight] lost vg:int-lock …') } })`. `int-teardown.mjs`: `RELEASE_LUA` trả 0 ⇒ warn; sau khi đóng kết nối, nếu lost hoặc release = 0 ⇒ ném lỗi ⇒ `test:int` exit ≠ 0 (lượt mất độc quyền không đáng tin). Giữ: chỉ chạm `vg:int-lock`, so sánh giá trị, lỗi Redis ở teardown vẫn chỉ warn.
- **Drill**: `--testPathPatterns "run56-tester|security-headers"` (~35 s > heartbeat 30 s); trong lúc chạy ghi đè `vg:int-lock` bằng giá trị khác (script node ioredis tới 6479, chỉ key này) ⇒ có warn + exit ≠ 0 + key vẫn giữ giá trị drill ⇒ dọn key (chỉ khi giá trị = giá trị drill). Mutation bỏ nhánh `n === 0` ⇒ drill exit 0 (RED) ⇒ khôi phục byte-identical. Lượt không drill exit 0. (Kiểm trước: jest 30.0.5 có biến lỗi globalTeardown thành exit ≠ 0 không; nếu không ⇒ `process.exitCode = 1` + ghi rõ trong log.)

### [x] Task 5 [test/BE] DEBT-096 (+ DEBT-054) — backend-dev, sau Task 1/4
- Chạy full int bằng jest trực tiếp, bỏ `--forceExit`, thêm `--detectOpenHandles`; liệt kê handle còn mở; sửa handle thuộc code repo (spec thiếu `quit`/`close`, app mồ côi…).
- Chỉ gỡ `--forceExit` khỏi `test:int` khi 3 lượt full liên tiếp (gồm lượt chứng minh dưới) tự thoát ≤ 15 s sau dòng tổng kết, exit 0, không "Jest did not exit". Không đạt ⇒ GIỮ `--forceExit`, ghi danh sách handle (nguồn, file) vào DEBT-096/054; không chặn PASS run. `test:vault`/`test:sentinel` giữ nguyên.

### [x] Chứng minh ổn định BE (backend-dev sau Task 5; tester lặp lại)
- 7 suite ở Task 1.1 × 3 lượt dưới tải (c): 0 timeout, bảng boot.
- `pnpm -C be test:int` full: 2 lượt rảnh + 1 lượt dưới tải (c), cả 3 xanh, không chạy lại riêng; tổng ≥ 1420; ghi thời gian. Không chạy song song E2E/Docker smoke/lượt int khác.
- `pnpm -C be test` ≥ 630, `typecheck`/`lint` 0.

### Ngoài phạm vi (backlog)
DEBT-452 (đối số vị trí `test:int`), DEBT-453 (assert `eyJ` trên log/body ở spec BE), DEBT-412 (vault boot) giữ mở.
