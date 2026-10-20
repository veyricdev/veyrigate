# Test Report — 2026-10-20 (run 34 B7.1, tester)

## Kết quả: PASS

BE unit 303/303 · BE int 827/827 (2 lần chạy full, 35/35 suites) · FE 240/240 · E2E 16/16 · typecheck 0 lỗi · lint 0 lỗi. Không có test FAIL, không có lỗi sản phẩm mới.

Phạm vi: thay đổi chưa commit kể từ `962cdf3`: khoá `test:int` (`be/test/int-preflight.mjs`, `be/test/int-teardown.mjs`, `be/package.json`), 9 test mới của backend-dev và 2 test INV-15 bổ sung của tester, fix INV-15 trong `AuthorizeService.resolveResource`, job CI `int`, `security-matrix.md`.

Hạ tầng: Docker Desktop khởi động lại trong lượt này, sau đó `docker start vg-test-mongo vg-test-redis`. Không `docker run/rm`, không compose up, không FLUSH. `aegate-*` và `veyrigate-mailpit-1` tự lên theo Docker, tester không đụng tới. Container lạc `funny_pascal` (Created) vẫn còn và chờ người dùng gỡ.

## Lệnh đã chạy + output thực tế

Tất cả chạy foreground bằng Git Bash.

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit`, không lỗi |
| 2 | `pnpm -C be lint` | `eslint src test`, không lỗi |
| 3 | `pnpm -C be test` | `Test Suites: 25 passed` · `Tests: 303 passed, 303 total` · 75.0 s |
| 4 | `pnpm -C be test:int` (lần 1, chạy cùng lúc với #5) | `Test Suites: 35 passed` · `Tests: 827 passed, 827 total` · 276.8 s · exit 0 |
| 5 | `pnpm -C be test:int` (lần 2, khởi động khi khoá của #4 đã có) | exit 1 sau **1870 ms**, thông điệp `another test:int is running (holder=…, ttl=117250ms)` |
| 6 | `redis-cli EXISTS vg:int-lock` sau #4 | `0` |
| 7 | `redis-cli SET vg:int-lock stale PX 5000` rồi `test:int -- test/indexes.int-spec.ts` ngay | exit 1 sau 2053 ms (bị từ chối) |
| 8 | Sau 6 s, chạy lại `test:int -- test/indexes.int-spec.ts` | `Tests: 18 passed, 18 total`, `EXISTS vg:int-lock` = 0 |
| 9 | Mutation INV-15 (case 11) | 3 failed / 46 passed (49) ⇒ RED |
| 10 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)` · `Tests 240 passed (240)` |
| 11 | `pnpm -C e2e e2e` (1 lần) | `16 passed (1.7m)`, exit 0. Sau khi chạy, không còn listener 3000/4000/5173. Cổng :5173 trống từ trước nên không phải dừng tiến trình nào. |
| 12 | `pnpm -C be test:int` (lần 3, full) | `Test Suites: 35 passed` · `Tests: 827 passed, 827 total` · 258.0 s · exit 0. `EXISTS vg:int-lock` = 0 |
| 13 | Parse `.github/workflows/ci.yml` (js-yaml 3.15.2 có sẵn trong store pnpm) | jobs `quality, int, e2e`; `permissions {"contents":"read"}`; `int`: timeout 30, services `mongo, redis, mailpit`, step cuối `pnpm -C be test:int`; không có `TEST_MONGO/REDIS`, không có `secrets.` |
| 14 | Vòng lặp grep ma trận (`LC_ALL=C.UTF-8`, xem log Task 2) | trước khi sửa: `refs ok=227 bad=0`; sau khi thêm 2 test tester vào INV-15: `refs ok=229 bad=0` |

Số 827 = 825 (backend-dev) + 2 test INV-15 của tester.

## Test FAIL

Không có.

## Coverage acceptance criteria

- [x] **Task 1 / AC1** (full `test:int` xanh liên tiếp): case 4 và case 12 đều 827/827. backend-dev đã ghi 3 lần trước đó (825/825).
- [x] **Task 1 / AC2** (2 lần chạy đồng thời): lần 2 thoát khác 0 sau 1.87 s (≤ 10 s), thông điệp chứa `another test:int is running`; lần 1 vẫn xanh (case 4, 5).
- [x] **Task 1 / AC3** (khoá cũ): bị từ chối khi còn hạn, chạy được sau 6 s (case 7, 8).
- [x] **Task 1 / AC4** (không còn khoá sau khi chạy xong): `EXISTS` = 0 sau mọi lần chạy (case 6, 8, 12).
- [x] **Task 1 / AC5–6** (`indexes` ×10, `client-auth-rate-limit` ×5): tester không đo lại; dựa vào số đo của backend-dev trong log. Cả hai suite đều xanh trong 2 lần chạy full ở trên.
- [x] **Task 2** (ma trận): §14 có 47 dòng (có 44 / một phần 0 / thiếu 0 / lỗi sản phẩm 2 / ngoài phạm vi 1). §15 có 30 dòng (có 28 / một phần 1 / thiếu 0 / lỗi sản phẩm 1 / ngoài phạm vi 0). Tổng **77 = 72 có / 1 một phần / 0 thiếu / 3 lỗi sản phẩm / 1 ngoài phạm vi**, khớp bảng Tổng hợp. Không ô trống, UTF-8 không BOM, không CRLF. Mọi tham chiếu grep ra đúng 1 dòng (case 14).
- [x] **Task 3** (lấp khoảng trống): 9 test mới xanh trong 2 lần chạy full. `thiếu` = 0. Mutation của R1/SE12/AE6/AE4/AE8 đã được backend-dev ghi trong log. Tester tự chạy lại mutation INV-15 (case 11).
- [x] **Task 4** (CI): YAML parse được, lệnh giống local, không secret, không `TEST_*` (case 13). **Chưa chạy trên runner thật**: lần push đầu tiên là phép kiểm.

## Coverage security invariants / risk matrix

Trust boundary của run: input `/authorize` (INV-15) và trạng thái dùng chung của hạ tầng test (khoá).

| Chiều | Trường hợp đã kiểm | Test / case |
|---|---|---|
| Input: boundary/malformed | `resource` là mảng 1 phần tử, mảng rỗng (service), `resource=A&resource=B`, `B,A`, `A,A`, `resource=A&resource=` (giá trị thứ hai rỗng), `resource[]=`, `resource%5B%5D=`, `resource[0]=` (HTTP) | `authorize.int-spec.ts › B7.1 INV-15 (tester): resource as a 1-element or empty array => invalid_target with state, never bound`; `… › B7.1 INV-15 (tester): resource[]= / resource[0]= / resource=A&resource= => no array binding, no 5xx`; `… › B7.1 INV-15: repeated resource (two allowed, non-admin) …` |
| Exposure (redirect) | Lỗi trả về kèm `state` và `iss`, không có `code`, không có `AuthorizeRequestContext` nào chứa `resource` dạng mảng | 3 test INV-15 ở trên |
| Authorization | Consent đã có cho từng resource riêng lẻ, nên chỉ việc lặp tham số mới có thể chặn cấp code (negative thật, không tautology) | test INV-15 của backend-dev |
| State: concurrent | 2 lần `test:int` đồng thời; khoá cũ còn TTL và khoá đã hết TTL | case 4–8 |
| State: concurrent (sản phẩm) | R1 refresh N=5, SE12 logout ∥ `/token` K=10, AE8 verify-email N=5 | xanh trong case 4 và case 12; mutation do backend-dev ghi |
| Identity/enumeration | AE6 ×4, AE4 | xanh trong case 4 và case 12 |

### Mutation INV-15 (tester)

- Sao lưu `be/src/modules/oauth/authorize/authorize.service.ts` vào scratchpad; sha256 `b73cd1d4…de637c`.
- Mutation: xoá 5 dòng (comment và khối `if (typeof raw !== 'string') throw invalid_target`) trong `resolveResource`.
- Chạy `test:int -- test/authorize.int-spec.ts`: **3 failed / 49**. Đúng 3 test INV-15 (2 test của tester, 1 test của backend-dev) RED, các test khác xanh.
- Khôi phục bằng `cp` từ bản sao lưu, sha256 khớp, `git diff --stat` trở lại +5 dòng như trước. Không dùng `git checkout`/`restore`.

Ghi chú về các dạng ngoặc: Fastify dùng parser querystring của Node nên `resource[]` và `resource[0]` là key khác, không phải `resource`. Vì vậy flow đi tiếp mà không có resource (code không bind resource) hoặc trả lỗi; test chấp nhận cả hai, miễn là không 5xx và không bind mảng. Nếu sau này đổi sang parser `qs` (có hỗ trợ ngoặc) thì test này sẽ chặn hồi quy.

## Debt

Không mở debt mới. DEBT-204/205 (tham số lặp khác ở `/authorize`, run 35) và DEBT-206 (heartbeat không báo khi mất khoá) vẫn mở, không chặn.
