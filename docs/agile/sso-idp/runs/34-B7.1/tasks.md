# Tasks — run 34 — B7.1 security test suite + test infra (M7)

> Plan §B7 B7.1: "Security test suite theo §14 (đủ nhóm: authorization code, refresh, resource, mix-up/iss, state/nonce, session, enumeration, multi-tenant, admin, cookie); concurrent test dùng nhiều request song song thật" — nghiệm thu "Mỗi dòng trong ma trận §14 có ≥1 test tự động; chạy trong CI". Spec §14 (ma trận), §15 (Security Invariants), plan bảng ánh xạ INV → task/test (plan §9). Nhiều test đã có từ run 01–33 ⇒ run này chủ yếu **truy vết + lấp khoảng trống + đưa vào CI**. Backlog test-infra: DEBT-195, 199, 201, 202 (flaky khi máy tải / chạy song song).
>
> Thứ tự: Task 1 → 2 → 3 → 4. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`. Không gọi provider thật.

### [x] Task 1 [test]: Độ tin cậy `test:int` (DEBT-195/199/201/202)
- Cách ly lần chạy: khoá chạy đơn (Redis `SET NX` trong `int-preflight`) hoặc prefix/DB riêng mỗi lần chạy — tech-lead chốt; `testTimeout` hợp lý cho int; sửa 2 test chập chờn đã biết (indexes M3→M4, client-auth-rate-limit X-Forwarded-For) nếu nguyên nhân nằm trong test.
- **Acceptance**: full `test:int` xanh 3 lần liên tiếp; 2 lần chạy song song không làm đỏ nhau (hoặc lần thứ 2 bị từ chối rõ ràng).

### [x] Task 2 [test]: Ma trận truy vết §14 + §15
- Tạo `docs/agile/sso-idp/security-matrix.md`: mỗi dòng §14 (và mỗi INV §15) → test tự động cụ thể (`file › tên test`), cột trạng thái (có / thiếu / ngoài phạm vi kèm lý do, vd. cookie đa trình duyệt thuộc X3).
- **Acceptance**: không dòng nào bỏ trống; mọi "có" trỏ tới test tồn tại (grep được).

### [x] Task 3 [BE]: Lấp khoảng trống
- Viết test cho các dòng "thiếu" ở Task 2 (ưu tiên concurrent thật: code reuse song song, refresh rotation song song, reset/verify token single-use song song, logout chen `/token`). Lỗi sản phẩm phát hiện ⇒ sửa nếu nhỏ, lớn ⇒ báo orchestrator.
- **Acceptance**: ma trận không còn "thiếu" (trừ ngoài phạm vi có lý do); mutation mẫu cho test mới ⇒ RED.

### [x] Task 4 [CI]: Chạy suite bảo mật trong CI
- `.github/workflows/ci.yml`: job int-test với service Mongo replica set + Redis (giống `vg-test-*`), chạy `pnpm -C be test:int`; giữ job E2E. Không lộ secret trong log CI.
- **Acceptance**: workflow hợp lệ (lint YAML / `act` nếu có, hoặc rà kỹ); lệnh chạy giống local; ghi rõ những gì chưa kiểm được khi không có runner.

## Câu hỏi cho tech-lead
- Q-34.1: Cơ chế cách ly test:int.
- Q-34.2: Phạm vi lấp khoảng trống có vừa 1 run không (nếu nhiều, tách theo nhóm §14).
- Q-34.3: CI service Mongo replica set: cách khởi tạo rs trong GitHub Actions.

## Fold tech-lead (2026-10-19) — ƯU TIÊN HƠN text cũ ở trên

Kết luận: **PASS**. Chi tiết xem `review-techlead.md`. Thứ tự: Task 1 ∥ Task 2 → Task 3 → Task 4.

### Phân công
| Task | Người làm | Ghi chú |
|---|---|---|
| 1 Độ tin cậy `test:int` | **backend-dev** | sửa `be/test/int-preflight.mjs`, thêm `be/test/int-teardown.mjs`, script `test:int` |
| 2 Ma trận §14/§15 | **tester** | chỉ tài liệu; làm song song với Task 1 |
| 3 Lấp khoảng trống | **backend-dev** | tester xác nhận mutation RED ở lượt test |
| 4 CI | **backend-dev** | |

### Task 1 (chốt Q-34.1)
- `int-preflight.mjs`: dò TCP như cũ, sau đó lấy khoá `SET vg:int-lock <host:pid:randomUUID> NX PX 120000` (ioredis, `TEST_REDIS_URL ?? redis://localhost:6479`). Không lấy được khoá ⇒ `throw` với thông điệp "another test:int is running (holder=…, ttl=…ms); if stale: docker exec vg-test-redis redis-cli DEL vg:int-lock".
- Heartbeat `setInterval(30s).unref()` chạy Lua: giá trị khớp thì `PEXPIRE 120000`. Lưu client/token/interval vào `globalThis`.
- `int-teardown.mjs` + cờ `--globalTeardown ./test/int-teardown.mjs`: `clearInterval`, Lua "khớp giá trị mới `DEL`", `quit`. Redis lỗi khi nhả khoá ⇒ chỉ `console.warn`.
- Thêm `--testTimeout=20000` vào `test:int`. KHÔNG đổi `jest.config.js`/unit. Giữ `--forceExit` (DEBT-054).
- KHÔNG FLUSH, KHÔNG chạm key khác. Không đổi các spec, trừ khi DEBT-195 vẫn đỏ ở bước dưới.
- **Acceptance (đo được)**:
  1. Full `pnpm -C be test:int` xanh **3 lần liên tiếp**; ghi số test và thời gian vào log.
  2. Chạy hai lần đồng thời: lần thứ hai thoát khác 0 trong ≤ 10 s, thông điệp chứa `another test:int is running`, lần đầu vẫn xanh.
  3. Khoá cũ: `redis-cli -p 6479 SET vg:int-lock stale PX 5000`, chạy ngay ⇒ bị từ chối; chạy lại sau 6 s ⇒ chạy bình thường.
  4. Sau khi chạy xong, `EXISTS vg:int-lock` = 0.
  5. `indexes.int-spec.ts` chạy riêng 10 lần đều xanh (DEBT-195). Nếu đỏ mà không do timeout thì dán nguyên văn lỗi, sửa cho tất định rồi đo lại 10 lần.
  6. `client-auth-rate-limit.int-spec.ts` chạy riêng 5 lần đều xanh (DEBT-199).
- Đóng DEBT-195/199/201/202 nếu đạt.

### Task 2 (ma trận) — bổ sung
- File `docs/agile/sso-idp/security-matrix.md`, gồm hai bảng §14 và §15. Cột: Nhóm | Dòng | Test (`đường-dẫn › tên it đúng nguyên văn`) | Trạng thái | Ghi chú.
- Trạng thái chỉ được là: `có` | `thiếu` | `lỗi sản phẩm (DEBT-x → run y)` | `ngoài phạm vi (lý do + nơi xử lý)` | `một phần (phần còn thiếu)`.
- Được dẫn test BE unit/int, `fe-sso-test/test/*` (phía RP: INV-6, iss redirect) và `e2e/`.
- Gán sẵn theo khảo sát tech-lead (tester xác nhận lại):
  - "cross-tenant token issuance", "cross-tenant consent", INV-24 phần OAuth ⇒ `lỗi sản phẩm (DEBT-116 → run 35)`.
  - Cookie đa trình duyệt ⇒ `ngoài phạm vi (X3, DEBT-008)`.
  - INV-19 ⇒ `một phần` (LocalKeyProvider ngoài Mongo, không expose; KMS/Vault chưa có).
- Dự kiến "thiếu" (Task 3 lấp): refresh rotation song song qua `/token`; logout ∥ `/token` song song thật; enumeration HTTP `/login`, `/register`, `/password/reset` (+ verify-email); verify-email token single-use song song.
- **Acceptance**: không ô trống. Mỗi `có` phải grep được: `grep -F "<tên it>" <file>` ra đúng 1 dòng. Dán vòng lặp kiểm và kết quả vào log.

### Task 3 (lấp khoảng trống) — kỳ vọng cụ thể
- **Refresh rotation song song**: N=5 `POST /token grant_type=refresh_token` cùng một RT qua `Promise.all` (HTTP thật). Kỳ vọng: ≤ 1 phản hồi 200, các phản hồi còn lại 400 `invalid_grant`. Sau đó thử dùng **mọi** RT mới nhận được: tối đa 1 RT dùng được. Nếu có nhánh reuse thì family bị revoke và có `TOKEN_REUSE_DETECTED`. Không có 5xx.
- **Logout ∥ `/token`**: lặp K=10 lần, mỗi lần một phiên mới, code `offline_access`, rồi `Promise.all([POST /logout (CSRF hợp lệ), POST /token code])`. Bất biến sau mỗi vòng: không còn refresh doc chưa revoke có `sessionRef` của phiên đó. Nếu `/token` trả 200 kèm RT thì RT đó dùng ⇒ `invalid_grant`. Không có 5xx.
- **Enumeration HTTP**: với `/login` (email không tồn tại / sai mật khẩu), `/register` (email mới / đã tồn tại), `/password/reset` (tồn tại / không), verify-email resend nếu có route: so status, body và tên các header `Set-Cookie` **sau khi chuẩn hoá** token CSRF và CSP nonce (regex thay bằng placeholder), kỳ vọng giống nhau từng byte. Không đo timing (đã có `DUMMY_HASH`).
- **Verify-email single-use song song**: N=5 consume cùng token ⇒ đúng 1 thành công, `emailVerifiedAt` được ghi 1 lần, 1 audit event.
- Đặt test vào spec sẵn có cùng chủ đề (`refresh-token`, `token`/`session-reflection`, `ui-auth`, `authentication`), không tạo framework/helper mới ngoài hàm cục bộ.
- **Lỗi sản phẩm**: chỉ sửa khi ≤ 15 dòng trong 1 hàm và không đổi hợp đồng HTTP/mã lỗi; nếu không thì mở DEBT (từ số tiếp theo trong backlog), đánh `lỗi sản phẩm` trong matrix, và KHÔNG commit test đỏ (không dùng `it.skip`/`it.failing`).
- **KHÔNG** làm các debt sản phẩm đang hẹn "B7.1" trong run này: DEBT-116/128/141/144/156 chuyển **run 35 (B7.1b, qua analyst)**; DEBT-140/142/147/150/151/155/166/197 chuyển **run 36 (B7.1c)**; DEBT-127 chờ người dùng dọn DB.
- **Acceptance**: các test mới xanh 3 lần. Mutation cho mỗi test mới (ví dụ bỏ điều kiện atomic trong rotate, bỏ re-check session ở `/token`, đổi thông điệp nhánh "đã tồn tại", consume token không atomic) phải làm test RED; ghi diff mutation và kết quả vào log, sau đó revert. Matrix chỉ còn `thiếu` = 0.

### Task 4 (CI, chốt Q-34.3)
- Thêm job `int` vào `.github/workflows/ci.yml` (song song với `quality`/`e2e`; `timeout-minutes: 30`). Services:
  - `mongo:7`, ports `27117:27017`, single-node (không rs vì không có transaction; ghi chú cách bật rs như review), health-check như job e2e;
  - `redis:7`, ports `6479:6379`;
  - `axllent/mailpit:v1.21`, ports `1025:1025`, `8025:8025` (cần cho `mailer.int-spec`).
- Các step setup-node/corepack/cache/`pnpm i --frozen-lockfile` giống các job khác, sau đó `pnpm -C be test:int`.
- **KHÔNG** đặt `TEST_MONGO_URI`/`TEST_REDIS_URL` (override làm mọi spec dùng chung 1 DB, xem DEBT-203). Không dùng secrets. Giữ `permissions: contents: read`.
- Cập nhật comment branch protection để thêm status check `int`. Đóng DEBT-004 (job e2e đã chạy thật).
- **Acceptance**: YAML parse được (`node -e "require('yaml').parse(...)"` nếu có package `yaml`, hoặc `actionlint` nếu đã cài sẵn; KHÔNG tải tool mới). Lệnh chạy giống local. Log ghi rõ: chưa chạy trên runner thật nên lần push đầu tiên là phép kiểm (chưa xác minh được thứ tự health-check của Mailpit).
