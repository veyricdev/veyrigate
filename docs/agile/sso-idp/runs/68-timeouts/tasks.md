# Tasks — run 68 — biên thời gian E2E webServer + int timeout sát (M7, lane test-infra)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-464 (1 lần `playwright test` báo `Timed out waiting 120000ms from config.webServer`: chuỗi BE `build` → `assert-dist-clean` → `db:sync-indexes` → `db:seed-dev` → `seed:e2e-admin` → `ts-node e2e-main` chưa `/ready` sau 120 s, ngay sau lượt chạy dưới tải), DEBT-455 (biên timeout còn sát dưới tải 28 luồng: hook `admin-keys` 29,6 s / 60 s, test DEBT-161 `admin-api` 13,3 s / 25 s, M3→M4 `indexes` 27,0 s / 60 s, hook `run56-tester` 25,8 s / 70 s; `seed-risk` 10 vòng 320–340 s / 660 s). Bối cảnh: `e2e/playwright.config.ts`, run 61 (`runs/61-test-stability/` số đo, `scratchpad/load2.mjs` tải 28 luồng nếu còn), run 63 (`INT_SETUP_TIMEOUT_MS`).
>
> Tech-lead: ĐO trước khi quyết. DEBT-464: thời gian từng bước webServer BE (rảnh + dưới tải), xem bước nào trội (build? seed?), quyết: tách build/seed ra `globalSetup`, bỏ bước thừa, hay nâng `timeout` webServer theo số đo (×3 max dưới tải như quy ước run 61/63). DEBT-455: đo lại trên máy hiện tại (rảnh + tải) các test/hook nêu tên; chỉ nâng từng chỗ theo số đo, hoặc giảm chi phí thật (vd. `seed-risk` `dropDatabase` mỗi vòng); nếu biên đã ≥ 2× thì đóng chấp nhận có số đo. Không `retries`, không nới assertion.
>
> Ràng buộc: E2E dùng `aegate-mongo` DB `sso-idp-e2e` + `aegate-redis` `/2` + Mailpit như STATUS mô tả — KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*` (kể cả DB E2E, trừ những gì chính script E2E vẫn làm); không seed/sync-indexes DB dev `sso-idp`; không dừng `pnpm dev` của người dùng (be :4000, fe-sso-test :5173 — nếu E2E cần các cổng đó thì DỪNG và báo); KHÔNG chạy `drop-int-orphans.mjs`; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); tiến trình tải (load2) phải tự kết thúc theo thời hạn; không commit.

### [x] Task 1 [E2E-infra]: DEBT-464 — webServer BE sẵn sàng trong biên có số đo.
### [x] Task 2 [test/BE]: DEBT-455 — biên timeout int theo số đo mới.

## Fold tech-lead (2026-11-06) — bắt buộc

**Số đo** (máy 28 lõi; tải = `load2.mjs` 28 worker_threads busy-loop, tự dừng theo thời hạn/stop-file; cổng :4000/:5173/:3000 trống — không có `pnpm dev` của người dùng, không tắt gì). Log thô trong scratchpad tech-lead (`e2e-idle1.log`, `e2e-load1.log`, `e2e-load2.log`, `int-idle.log`, `int-load.log`); không phải bằng chứng của dev.

DEBT-464 — `DEBUG=pw:webserver pnpm -C e2e exec playwright test tests/lab.spec.ts` (đúng config: DB `sso-idp-e2e`, redis `/2`), mốc theo dòng `$ <script>` (±1 s):

| Bước webServer BE | rảnh | tải #1 | tải #2 |
|---|---|---|---|
| `build` (tailwind + `nest build`) + `assert-dist-clean` | 29,2 s | 37,9 s | 33,6 s |
| `db:sync-indexes` | 1,0 s | 5,1 s | 4,1 s |
| `db:seed-dev` | 3,0 s | 6,1 s | 6,1 s |
| `seed:e2e-admin` (ts-node, type-check đầy đủ) | 11,1 s | ~17–20 s | 19,5 s |
| `start:e2e` (ts-node) → `/ready` 200 | 24,2 s | ~37–41 s | 41,1 s |
| **Tổng tới `WebServer available`** | **68,5 s** | **104,1 s** | **104,3 s** |

fe-sso-test 2,0 / 4,1 s, fe-admin 19,9 / 12,9 s (rảnh / tải) — biên 120 s ≥ 6×, giữ. Đo phụ: `seed:e2e-admin` rảnh 11,2 / 10,5 s thường vs 4,1 / 4,0 s với `TS_NODE_TRANSPILE_ONLY=true` (≈ 7 s/bước ts-node là type-check).

DEBT-455 — `pnpm -C be test:int "(admin-keys|admin-api|indexes|run56-tester|seed-risk)[.]int-spec" --verbose` + `--setupFilesAfterEnv` scratch bọc `beforeAll/afterAll` đo hook; 135/135 xanh cả 2 lượt:

| Điểm | rảnh | tải | limit | biên dưới tải | Quyết định |
|---|---|---|---|---|---|
| hook `admin-keys` beforeAll | 1,8 s | 17,5 s | 60 s | 3,4× | đóng, giữ |
| hook `admin-api` beforeAll | 1,6 s | 18,4 s | 60 s | 3,3× | đóng, giữ |
| test DEBT-161 `admin-api` | 2,1 s | 13,9 s | 25 s | **1,8×** | nâng 45 000 |
| test M3→M4 `indexes` | 2,5 s | 33,0 s | 60 s | **1,8×** | nâng 100 000 |
| test DEBT-422 `indexes` | 1,3 s | 19,2 s | 45 s | 2,3× | giữ |
| hook `indexes` / `run56-tester` / `seed-risk` | 2,2 / 2,0 / 1,3 s | 25,6 / 19,2 / 18,6 s | 70 s | 2,7× / 3,6× / 3,8× | đóng, giữ |
| test `seed-risk` 10 vòng | 40,1 s | 343,2 s | 660 s | **1,9×** | nâng 1 050 000 |

**Quyết định**

1. **Task 1 [E2E-infra] DEBT-464**: chỉ nâng `timeout` webServer **BE** trong `e2e/playwright.config.ts` từ `120_000` lên `320_000` (≥ 3 × 104,3 s), kèm comment 1–2 dòng ghi số đo (rảnh 68,5 s; 28 luồng 104 s; bước trội: build ~34–38 s, `start:e2e` ~41 s, `seed:e2e-admin` ~20 s). FE/fe-admin giữ 120 s. KHÔNG tách build/seed ra `globalSetup` (chỉ dời thời gian, thêm bề mặt; tổng không giảm); KHÔNG bỏ bước nào (`assert-dist-clean` ~0 s, INV-23; seed là điều kiện của suite); KHÔNG đổi `TS_NODE_TRANSPILE_ONLY` trong run này (giảm ~7 s/bước nhưng chưa có bằng chứng Nest DI + `emitDecoratorMetadata` chạy đúng khi transpile-only; ts-jest int vẫn type-check đầy đủ) → DEBT-480. Sửa `e2e/README.md` § What it runs: dòng BE đang lỗi thời (thiếu `assert-dist-clean`, `seed:e2e-admin`, `start:e2e` = `ts-node e2e-main`) — ghi đúng chuỗi lệnh + timeout 320 s và lý do (1 câu).
2. **Task 2 [test/BE] DEBT-455**: chỉ 3 điểm < 2×, mỗi điểm nâng tới ≥ 3× max dưới tải và cập nhật comment `DEBT-448` sẵn có ngay trên dòng timeout bằng số đo run 68 (giữ số run 61 nếu muốn, nêu cả hai):
   - `be/test/admin-api.int-spec.ts` test DEBT-161 (dòng ~1932): `25_000` → `45_000`.
   - `be/test/indexes.int-spec.ts` test M3→M4 (dòng ~179): `60_000` → `100_000`.
   - `be/test/seed-risk.int-spec.ts` test 10 vòng (dòng ~283): `660_000` → `1_050_000`. Giảm chi phí `dropDatabase` mỗi vòng KHÔNG làm ở run này (vòng phải bắt đầu từ DB không index — là chính điều test chứng minh; đổi cách dọn cần đo riêng) → DEBT-481.
   - Các hook/test còn lại ≥ 2× ⇒ đóng chấp nhận có số đo (bảng trên). KHÔNG đổi `INT_SETUP_TIMEOUT_MS`, hook 60 s của `admin-keys`/`admin-api`, không `retries`, không nới assertion, không giảm số vòng/số request.

**Cách chứng minh (dev ghi vào log + test-report)**

- `git diff --stat` chỉ: `e2e/playwright.config.ts`, `e2e/README.md`, 3 spec BE trên (+ docs run). Mỗi spec diff chỉ đổi đúng 1 số timeout + comment.
- E2E: `pnpm -C e2e e2e` full xanh (rảnh) với cổng trống; thêm 1 lượt `DEBUG=pw:webserver ... tests/lab.spec.ts` dưới tải 28 luồng (load tự dừng), ghi tổng thời gian BE tới `WebServer available` và tỉ lệ so 320 s. Nếu :4000/:5173/:3000 bận ⇒ DỪNG và báo, không tắt gì.
- Int: lệnh lọc 5 spec ở trên rảnh + dưới tải đều xanh; ghi thời lượng 3 test đã nâng và biên mới.
- `pnpm -C be lint` (các spec sửa) + `pnpm -C be typecheck` + `pnpm -C e2e typecheck` xanh.
- Đóng DEBT-464/455 trong `backlog.md` kèm số đo.

**Nhãn**: Task 1 [E2E-infra] → frontend-dev (hoặc backend-dev; chỉ config + README). Task 2 [test/BE] → backend-dev.
