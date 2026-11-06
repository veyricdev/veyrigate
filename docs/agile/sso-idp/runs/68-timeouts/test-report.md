# Test Report — 2026-11-06 (run 68, tester độc lập)

## Kết quả: PASS (E2E 36/36, int 1420/1420, be unit 630/630)

Cổng :4000/:5173/:3000 trống trước khi chạy (`netstat` không có LISTENING) — không có `pnpm dev` của người dùng, không tắt gì. Không compose up, không FLUSH/drop, không seed DB dev, không `drop-int-orphans.mjs`, không commit. Log thô: scratchpad `tester-e2e.log`, `tester-int.log`.

## Lệnh đã chạy + output thực tế

1. `DEBUG=pw:webserver pnpm -C e2e e2e` (rảnh) → exit 0, `36 passed (4.1m)`, wall 247 s.
   - BE: `Starting WebServer process pnpm -C be build && ...` 03:57:20.708Z → `WebServer available` 03:58:10.028Z = **49,3 s** (limit 320 s ⇒ 6,5×).
   - fe-sso-test: 03:58:10.046Z → 03:58:10.977Z = 0,9 s; fe-admin: 03:58:10.980Z → 03:58:17.468Z = 6,5 s (limit 120 s).
   - Dòng `server function failed` / `federation failed: invalid_state` trong log là log của các case negative (suite vẫn 36/36).
2. Config thật: `npx playwright test --list` (trong `e2e/`) → exit 0, `Total: 36 tests in 19 files`. Import `playwright.config` qua `npx tsx` in `[{url:":4000/ready",timeout:320000},{url:":5173/",timeout:120000},{url:":3000/",timeout:120000}] retries= 0` (chỉ url/timeout, không in env).
3. `pnpm -C be test:int` → exit 0, `Test Suites: 53 passed`, `Tests: 1420 passed, 1420 total`, `Time: 469.481 s`. `DEBT-176: 0/10 rounds...`, `DEBT-161 race: 0/15 ...`. `vg-int-*` trên `vg-test-mongo`: 4 trước → 4 sau (**+0**).
4. `pnpm -C be test` → `Test Suites: 39 passed`, `Tests: 630 passed, 630 total`.
5. `git diff --stat`: phần thuộc run = `e2e/playwright.config.ts` (+3/-1), `e2e/README.md`, `be/test/{admin-api,indexes,seed-risk}.int-spec.ts` (mỗi file +3/-2), `backlog.md`, `STATUS.md`. `.vscode/mcp.json` + `.mcp.json` là thay đổi của người dùng, ngoài run (không đụng).

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Task 1 / DEBT-464 — webServer BE `timeout` 320 000 đọc đúng từ config thật (case 2); FE/fe-admin giữ 120 000; E2E full 36/36, BE sẵn sàng 49,3 s (case 1). README khớp `command` thật (đọc diff).
- [x] Task 2 / DEBT-455 — đúng 3 số: DEBT-161 25 000→45 000, M3→M4 60 000→100 000, `seed-risk` 660 000→1 050 000; mỗi spec chỉ đổi 1 số + comment DEBT-448 (case 5); int full 1420/1420 (case 3).
- [x] Không `retries` (config `retries=0`, diff không chứa `retries`), không nới assertion/giảm vòng (diff chỉ dòng timeout + comment).
- [x] Không hồi quy: be unit 630 (case 4); `vg-int-*` +0.

## Coverage security invariants / risk matrix
Run chỉ đổi biên timeout test-infra, không chạm trust boundary ⇒ risk matrix không áp dụng. INV-23 (`assert-dist-clean`) vẫn trong chuỗi webServer BE (case 1 log). Không debt mới.
