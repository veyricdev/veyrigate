# Test Report — 2026-10-28 (run 57 — thứ tự audit lock/unlock DEBT-420 + sort/cursor DEBT-422 + DEBT-427)

## Kết quả: PASS

- BE unit 594/594, int **1366/1366** (1355 cũ + 11 test tester mới, 0 skip), root test 594 + 1416 + 269, **E2E 36/36** (35 cũ + 1 mới).
- L5|L6|L7: **25/25 lượt liên tiếp xanh** (250 vòng L6 không barrier).
- 5 mutation của tester đều RED; khôi phục byte-identical (sha256 OK).
- Không mở DEBT mới.

Phiên trước bị ngắt khi Docker tắt. Lúc resume đã kiểm:
- Sản phẩm không ở trạng thái mutant: `git diff --stat -- be/src` vẫn là 7 file, +181/−79, khớp diff ban đầu. Các dòng fix trong `log.md` đều có mặt. Phiên trước tester chưa mutate gì.
- `vg:int-lock` trống.
- Chỉ chạy `docker start vg-test-mongo vg-test-redis`.

## File test tester thêm

- `be/test/run57-tester.int-spec.ts`: 11 test, chạy trên app thật qua HTTP.
- `e2e/tests/fe-admin-audit-paging.spec.ts`: 1 test E2E.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be test:int --testPathPatterns run57-tester` | PASS 11/11 (98.8 s) |
| 2 | `pnpm -C be test:int --testPathPatterns run56-tester -t "L5\|L6\|L7"` × 25 lượt liên tiếp | 25/25 exit 0, mỗi lượt `3 passed, 15 skipped` (16–24 s/lượt) |
| 3 | `… run57-tester -t "M1\|M2"` × 3 lượt thêm | 3/3 exit 0 (`2 passed`) |
| 4 | `pnpm -C be typecheck` / `lint` / `build` | exit 0 / 0 / 0 |
| 5 | `pnpm -C be test` | 38 suite, 594 passed |
| 6 | `pnpm -C be test:int --shard=1/3`, `2/3`, `3/3` (foreground, lock trống trước khi chạy) | 18 suite/591 + 17/435 + 17/340 = **52 suite, 1366 passed, 0 skip, 0 fail** (158 s + 204 s + 153 s) |
| 7 | root `pnpm lint` | exit 0 (be, fe-sso-test, fe-admin) |
| 8 | `pnpm -r run typecheck` | exit 0 (be, fe-sso-test, fe-admin, e2e) |
| 9 | root `pnpm test` | exit 0: 594 + 1416 (64 file) + 269 (31 file) |
| 10 | `pnpm audit --audit-level high` | exit 0 (7 low, 9 moderate, 1 high đã ignore sẵn) |
| 11 | `pnpm -C e2e e2e` (một lần; :4000/:5173/:3000 trống; `E2E_REUSE` không đặt) | exit 0, **36 passed** (4.6 m). Có test mới `fe-admin-audit-paging` (6.8 s). Harness tự `db:sync-indexes` trên `sso-idp-e2e` |
| 12 | Grep secret trong mọi log (JWT `eyJ….….`, `PRIVATE KEY`, `hvs.`, `adminLockMarkAt`) | 0 match. Riêng `adminLockMarkAt` chỉ khớp tên test X1 |
| 13 | `git --no-pager diff --stat -- fe-admin/` | rỗng |
| 14 | grep `record(…, { timestamp })` trong `be/src` | 4 chỗ, đều ở `admin-users.controller.ts` (177, 192, 205, 241) |

Log `[fe-admin] server function failed` trong E2E đến từ các negative test hardening đã có (zod `Invalid client id`, `unrecognized_keys tenantId`…), không liên quan run này.

## Mutation (tester; backup sha256 trong scratchpad, khôi phục và `sha256sum -c` OK)

| Mutation | Test RED |
|---|---|
| A: audit LOCKED/UNLOCKED success dùng `Date.now()` thay vì mốc | M1, M2 |
| B: `keepHigher` luôn false (tenant hạ mức super/legacy) | M1, M2, V1, V3 |
| C: cursor `_id: {$lte}` | P1, P2, P4 |
| D: regex `i` có cờ `/i` (chấp nhận hex hoa) | P3 |
| E: `afterMark` không cộng mốc (follow-up dùng giờ Node) | O1 |

Lần chạy đầu của A làm `tsc` báo TS6133 nên 0 test được chạy, không tính là RED. Đã viết lại mutation để giữ biến được tham chiếu và chạy lại.

## Coverage acceptance criteria

- [x] T1.1 helper mốc: unit `admin-lock-mark.spec` của dev (trong 594). M2 kiểm DB mark = now + writes − 1.
- [x] T1.2 `adminLock` 1 pipeline, giữ mức, path no-op vẫn bump mốc: L1, L2, L7 (run56), V1, V2, V3, M1.
- [x] T1.3 unlock pipeline, mốc trùng audit: (b), (d) của dev. M2: ts nằm trong khoảng mốc.
- [x] T1.4 `record(input, {timestamp})`, timestamp sai ⇒ throw: unit `audit.service.spec` (594).
- [x] T1.5 controller: follow-up > LOCKED success. O1 với mốc vượt giờ Node 1 h; M1 ghép theo `requestId` cho mọi SESSION_REVOKED.
- [x] T1.6a L6 bật lại: 25 lượt liên tiếp xanh (≥ 20).
- [x] T2.1/2.2 sort/cursor `(timestamp,_id)`, cursor `{t,i}`: P1, P2, P4, T2a/b/d của dev.
- [x] T2.2 cursor cũ `{t,e}` ⇒ 400: P3, T2c. E2E: cursor cũ trong URL hiện alert, có nút "First page".
- [x] T2.3 index: `indexes.int-spec` (trong int full). E2E harness sync trên `sso-idp-e2e`. KHÔNG sync DB dev `sso-idp`, việc này người dùng làm.
- [x] T2.5 fe-admin không đổi; `/audit` phân trang đúng: E2E `fe-admin-audit-paging`. 24 event: trang 1 có 20 dòng, "Next page" ra 4 dòng, khớp từng dòng với API `limit=100`, không trùng.
- [x] DEBT-427: P3 (`t` = 8.64e15+1, 8.64e15+2, 9e15, MAX_SAFE, 1e300 ⇒ 400; biên 8.64e15 ⇒ 200).

## Coverage security invariants / risk matrix

- [x] **Identity/Authorization** (4 actor: super1, super2, tenant1, tenant2). Không tenant nào hạ hoặc mở khoá mức super/legacy:
  - M1 replay trail với luật DEBT-153, 0 vi phạm.
  - V1: sentinel legacy, tenant lock vẫn giữ không có level, tenant unlock 403.
  - V3: tenant unlock 403 không ghi DB, mốc không đổi.
  - P4: cursor chứa `_id` của tenant B ⇒ chỉ trả dòng tenant A, đúng vị trí.
- [x] **State/concurrent (DEBT-420)**:
  - M1: 12 vòng × 6–8 thao tác song song, thứ tự và tập con ngẫu nhiên tất định, 3 trạng thái đầu (mở / tenant khoá / super khoá), tổng ≥ 72 thao tác. Mỗi vòng, trail success sắp theo `(timestamp,_id)` khi replay ra đúng trạng thái DB (locked + level). Timestamp success tăng chặt. `DB mark ≥ ts success cuối`. Mỗi lock có đúng 1 `LOCKED success`.
  - Cộng thêm L6: 25 lượt × 10 vòng.
- [x] **Trùng ms**: M2, 5 vòng × 7 thao tác song song cùng một `now` inject (`now` ở quá khứ). Mốc cuối = `now + writes − 1`, ts success đôi một khác nhau và nằm trong khoảng đó, replay khớp DB. (d) của dev chạy tuần tự.
- [x] **Retry (DEBT-152)**, O1: mốc vượt giờ Node 1 h, revoke lỗi ⇒ 5xx, body không lộ lỗi. Trail `success, failure, success`. Failure cùng `requestId` và ts lớn hơn success. `SESSION_REVOKED` của lần retry có ts lớn hơn success của chính nó.
- [x] **Input (cursor)**, P3: 32 payload ⇒ 400 với body `{invalid_request, invalid cursor}`. Gồm:
  - cursor cũ `{t,e}`;
  - `t` dạng string, bool, null, âm, thập phân, vượt biên, 1e300, operator;
  - `i` hex hoa, sai độ dài, rỗng, có khoảng trắng hoặc `\n`, operator `$gt`/`$ne`, mảng, số, null;
  - mảng, chuỗi, `__proto__`, `constructor`, JSON cụt, không phải JSON.

  Ngoài ra 4 chuỗi bị DTO chặn ⇒ 400. Ba trường hợp ⇒ 200: biên 8.64e15, `t:0`, key thừa (`tenantId` của B bị bỏ qua). Không có 5xx.
- [x] **Phân trang**:
  - P1: 36 event của A trải trên 3 ms, chèn theo thứ tự `_id` xáo trộn, `eventId` ngẫu nhiên, có nhiễu từ tenant B và event không tenant. Đi hết trang với limit 1/2/5/7/11/12/36/100, kết quả đúng bằng toàn tập sắp `(ts desc, _id desc)`. Super cùng tenant thấy cùng danh sách. Item không có `_id`. Cursor chỉ có `{t,i}`, `i` là hex thường.
  - P2: ghi chen giữa các trang cùng ms với cursor. `_id` nhỏ hơn ⇒ xuất hiện đúng 1 lần; `_id` lớn hơn ⇒ không xuất hiện ở trang sau. Tập gốc không trùng, không sót.
- [x] **Exposure**, X1: `adminLockMarkAt` không xuất hiện trong hơn 100 body đã gọi (lock, unlock, GET user, list users, audit list, …), trong toàn bộ collection audit, hay trong log pino. Log không chứa JWT.
- [x] **Dependency/failure**: revoke lỗi ⇒ khoá giữ nguyên, 5xx (O1, test DEBT-152 và (i) trong int full). Không có đường HTTP nào đặt được timestamp audit (grep #14).

## Ghi chú

- `pnpm -C be db:sync-indexes` trên DB dev `sso-idp`: tester KHÔNG chạy; vẫn chờ người dùng.
