# Test Report — 2026-10-20 (run 39 X2/T7, Task 4 + nghiệm thu Task 0–3)

## Kết quả: PASS

| Bộ | Kết quả |
|---|---|
| BE typecheck / lint | sạch / sạch |
| BE unit `pnpm -C be test` | 382/382 (31 suite) |
| BE int `pnpm -C be test:int` (FULL, vg-test-*) | 1199/1199 (44 suite) |
| FE `pnpm -C fe-sso-test test` | 269/269 (31 file) |
| E2E `pnpm -C e2e e2e` FULL lần 1 | 21/21 passed (1.8m, wall 110 s) |
| E2E `pnpm -C e2e e2e` FULL lần 2 (liên tiếp) | 21/21 passed (1.8m, wall 110 s) |
| E2E `logout.spec.ts admin-client.spec.ts --repeat-each=3` | 15/15 passed (1.9m, wall 115 s) |
| `pnpm -C e2e typecheck` | sạch |
| CI YAML parse (js-yaml 4.3.2) | `ci.yml` OK (quality,int,e2e,secrets,promtool), `codeql.yml` OK |
| Ma trận grep | 0 BAD mới (xem case 6) |
| Rò rỉ trong output E2E | `code=` 0, `state=` 0, `eyJ` 0, `client_secret` 0, giá trị secret/password (4) 0 |

Không có test FAIL. Không lỗi sản phẩm. Tổng 382 + 1199 + 269 + 21×2 + 15 = 1907 lượt test, 0 fail.

## Lệnh đã chạy + output thực tế

1. **Sửa 3 debt chất lượng test** (chỉ `e2e/tests/**`; sao lưu + sha256 trước khi sửa, không git checkout/restore):
   - Trước: `logout.spec.ts f09c8249…`, `admin-client.spec.ts a555452e…`, `support/admin.ts 01e04737…`. Sau: `5003f2a8…`, `d375b99e…`, `662696c7…`.
   - DEBT-246: `typeof at === "string" && at.length > 0 && typeof rt === "string" && rt.length > 0` (boolean) ở `logout.spec.ts › signedInPage` và `support/admin.ts › adminToken`.
   - DEBT-247: **đề xuất của senior không hiệu lực, đo được.** Listener tạm ở `localhost:3000` (scratchpad, chỉ đếm số request, không ghi URL):
     - `context.route("http://localhost:3000/**", r => r.abort())` ⇒ `admin-client.spec.ts` 3 passed, **hits=5**: route của Playwright không thấy redirect hop.
     - Thử `page.route` trên IdP + `route.fetch({maxRedirects:0})` ⇒ FAIL `fe-admin authorization reached the redirect` (hop sau một 302 đã fulfill cũng không đi qua route), hits +1. Đã bỏ.
     - Chốt: CDP `Fetch.enable` (pattern `http://localhost:3000/*`, stage Request) + `Fetch.failRequest` ⇒ `admin-client.spec.ts` 3 passed (1.1m), **hits +0**. Vẫn đọc `code` từ `Location` của 302. Ràng buộc chỉ Chromium ⇒ DEBT-249 💭.
     - Listener đã dừng (`taskkill` theo PID sau khi kiểm command line `listen3000`).
   - DEBT-248: `jwtPayload()` decode base64url phần giữa (không verify), assert boolean `"auth_time" in` ⇒ token tương tác `true`, token refresh grant `false`, token `forceLogin` `true`. Xanh ở mọi lượt chạy bên dưới.
2. `pnpm -C e2e typecheck` ⇒ `tsc --noEmit` không lỗi.
3. `pnpm -C be typecheck` ⇒ `TYPECHECK_OK`; `pnpm -C be lint` (`eslint src test`) ⇒ `LINT_OK`.
4. `pnpm -C be test` ⇒ `Test Suites: 31 passed, 31 total` / `Tests: 382 passed, 382 total` / `Time: 28.091 s`.
5. `pnpm -C be test:int` (Docker Desktop đang chạy, `vg-test-mongo`/`vg-test-redis` Up, khoá `vg:int-lock` qua preflight) ⇒ `Test Suites: 44 passed, 44 total` / `Tests: 1199 passed, 1199 total` / `Time: 301.271 s` (wall 304 s). Stack trace trong log là log mong đợi của test fail-closed, `^FAIL ` = 0.
6. **Ma trận** (`security-matrix.md`): vòng grep của run 34 trên bản sao trước khi sửa ⇒ `ok=259 bad=17`; sau khi sửa ⇒ `ok=276 bad=17`. 17 BAD có sẵn từ trước, đều là describe lồng (`token-code-recheck.int-spec.ts › refresh grant re-check after rotate (run 36 Task 2) › …`) hoặc ô rút gọn `› …`, giới hạn của vòng lặp (chỉ tách ở ` › ` đầu tiên), không phải tham chiếu sai: kiểm tay tên lá, ví dụ `race: membership suspended right after rotate …` ⇒ 1 dòng, tên describe ⇒ 1 dòng (DEBT-250 💭). Mục mới "Run 39" ⇒ `ok=7 bad=0`. Mọi tham chiếu `e2e/…` (10 tên riêng biệt, 23 lần) ⇒ đúng 1 dòng mỗi tên. File UTF-8 không BOM, 0 CR.
7. **CI**: `node -e` + js-yaml 4.3.2 parse `ci.yml`, `codeql.yml` ⇒ OK. Job `e2e` chạy `pnpm -C e2e e2e` = `playwright test` với `testDir: "./tests"` (mọi spec, gồm `logout`, `admin-client`). `retries: 0`, `workers: 1`. Env job chỉ `DEV_SEED_EMAIL`, `DEV_SEED_PASSWORD`, **không dùng `secrets.`**; `E2E_FE_ADMIN_SECRET` lấy từ `e2e/config/env.ts` qua `beEnv()`. RP thứ hai chọn cổng trống động (`freePort` + `--strictPort`), không cố định 5174 ⇒ không xung đột với FE :5173 / BE :4000. Workflow không đổi kể từ `98195a9`.
8. `pnpm -C fe-sso-test test` ⇒ `Test Files 31 passed (31)` / `Tests 269 passed (269)` / `Duration 2.85s`.
9. `pnpm -C e2e e2e` lần 1 ⇒ `21 passed (1.8m)`, exit 0, wall 110 s. Lần 2 liên tiếp ⇒ `21 passed (1.8m)`, exit 0, wall 110 s. Từng test: `admin-client` 3, `api-test` 1, `federation` 4, `lab` 10 (gồm 6 `it.each`), `login` 1, `logout` 2. Seed: cả hai lần `fe-admin credential unchanged`, `admin user unchanged` (idempotent). `be/dist clean` có trong log. Trước khi chạy: 3000/4000/5173/5174 trống (không phải dừng vite nào).
10. `pnpm -C e2e exec playwright test logout.spec.ts admin-client.spec.ts --repeat-each=3` ⇒ `15 passed (1.9m)`, exit 0.
11. Rò rỉ: grep 6 log E2E (2 full, repeat, 3 lượt admin-client) ⇒ `code=` 0, `state=` 0, `eyJ` 0, `client_secret` 0; so khớp 4 giá trị SECRET/PASSWORD (đọc từ `e2e/config/env.ts` + `e2e/.env` trong node, không in) ⇒ 0 hit.
12. Sau cùng: không còn tiến trình do tester khởi động (3000/4000/5173/5174 trống; các vite còn lại là dự án khác của người dùng, cổng 6084).

**Tổng thời gian E2E**: 1.8m (wall 110 s) cho 21 test, dưới mục tiêu 5'.

## Test FAIL (nếu có)

Không có ở các lần chạy nghiệm thu. Một lần FAIL trong lúc thử phương án DEBT-247 (`page.route` + `maxRedirects:0`) là của phương án bị loại, không phải lỗi sản phẩm. [E2E]

## Coverage acceptance criteria

- [x] Task 0 (1) idempotent: seed chạy 2 lần (2 lượt E2E full) ⇒ `credential unchanged`, `admin user unchanged`; int `be/test/seed-e2e-admin.int-spec.ts` (6) trong 1199. (2) guard DB/NODE_ENV: unit `be/test/e2e/seed-e2e-admin.spec.ts` (16) trong 382. (3) không in secret: case 11. (4) `be/dist clean` trong log webServer.
- [x] Task 1 logout local/global: `e2e/tests/logout.spec.ts` (2) xanh ×2 full + ×3 repeat; không lộ token (case 11). DEBT-246 làm assert RT không còn pass rỗng.
- [x] Task 2 step-up / consent / redirect_uris: `e2e/tests/admin-client.spec.ts` (3) xanh ×2 full + ×3 repeat; client tạo mới mỗi lần, disable ở `afterAll` (không có cảnh báo `disable client` trong log). Tiền đề `auth_time` đã pin (DEBT-248).
- [x] Task 3 FE unit: 269/269 (mutation đã ghi ở log frontend-dev).
- [x] Task 4 ma trận: tham chiếu E2E ở SE5, SE6, SE7, AD1 (§14), INV-4, INV-10, INV-11, INV-26, INV-28 (§15) + mục "Run 39 (X2/T7): truy vết E2E" (gồm consent). Bảng tổng hợp không đổi (các dòng đã `có`). CI YAML parse OK. Thời gian E2E 1.8m.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | user dev 2 context; super_admin; user khác client | `logout.spec.ts` (2), `admin-client.spec.ts` (3) |
| Credential | AT/RT hợp lệ, AT sau logout (401), RT sau global logout (`invalid_grant`), token refresh grant thiếu `auth_time` | `logout.spec.ts › logout global…`, `admin-client.spec.ts › step-up…` |
| Authorization | step-up 403 `step_up_required` + side effect 0, re-auth 201 | `admin-client.spec.ts › step-up…` |
| State | RT replay / descendant (lab), consent Deny không lưu / Allow lưu | `lab.spec.ts › lab refresh replay…`, `admin-client.spec.ts › consent…` |
| Request chain | 302 có `code` tới :3000 bị chặn ở tầng mạng (0 hit đo được); logout ⇒ request kế tiếp ở context kia | DEBT-247 (case 1), `logout.spec.ts` |
| Exposure | output E2E: không `code=`/`state=`/`eyJ`/secret | case 11 |
| Redirect | `redirect_uris` đổi ⇒ IdP 400, 0 request tới callback cũ (INV-4) | `admin-client.spec.ts › redirect_uris changed…` |

Debt mới: DEBT-249 💭 (CDP chỉ Chromium), DEBT-250 💭 (giới hạn vòng grep ma trận). Đóng: DEBT-246, DEBT-247, DEBT-248.
