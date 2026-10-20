# Tech Lead Review — 2026-10-19 (run 34 B7.1)

## Kết luận: PASS (có điều kiện: theo mục "Fold tech-lead" trong `tasks.md`, ưu tiên hơn text cũ)

Không có blocker. Plan đúng hướng (truy vết + lấp khoảng trống + CI). Phải chỉnh 3 việc: (1) chốt cơ chế cách ly, (2) **thu hẹp phạm vi**: run 34 chỉ viết test, không gom ~17 debt sản phẩm đang hẹn "B7.1" vào, (3) CI cần thêm Mailpit, không cần replica set.

## Kiến trúc đề xuất

Không đổi kiến trúc. Hạ tầng test giữ nguyên các container (`vg-test-mongo@27117`, `vg-test-redis@6479`, Mailpit@1025/8025) và thêm một khoá chạy đơn trong `int-preflight`.

## Khảo sát khả thi (đối chiếu code tại `b84fa92` + working tree)

- `test:int` = jest `--runInBand --forceExit --globalSetup ./test/int-preflight.mjs`. `int-preflight.mjs` hiện chỉ dò TCP. Chưa có globalTeardown và chưa có `testTimeout` (mặc định 5 s).
- Mongo: mỗi spec dùng DB riêng `vg-int-<tên>-${Date.now()}` ⇒ hai lần chạy song song **không** đụng nhau ở Mongo. Redis dùng chung db0 của `vg-test-redis`. Các spec gọi `KEYS`+`DEL` (`authz_code:*`, `rl:*`, `authz_ctx:*`…), và `authorization-code.int-spec` còn đọc `redis.keys('*')` ⇒ đúng nguồn gốc DEBT-199/201.
- `be/src` và `be/test` không có `startSession`/`withTransaction`/change stream. URI test dùng `directConnection=true` ⇒ **không cần replica set** (rs0 ở local chỉ là cấu hình container).
- Không int-spec nào nạp `ConfigModule` (`be/.env`). Khoá ký dùng `mkdtemp` ⇒ CI không cần `be/.env`/`be/keys`. **Riêng `mailer.int-spec.ts` cần Mailpit** (`TEST_SMTP_URL`/`TEST_MAILPIT_API`, mặc định `localhost:1025/8025`) ⇒ job CI phải có service Mailpit.
- `TEST_MONGO_URI` khi được đặt sẽ thay **toàn bộ** URI ⇒ mọi spec dùng chung một DB (có spec `dropDatabase`) ⇒ CI **không được** đặt biến này (DEBT-203).
- `ioredis@6.0.0` có sẵn trong `be` ⇒ `.mjs` import được để làm khoá.

## Trả lời câu hỏi

### Q-34.1 Cơ chế cách ly: chọn **khoá chạy đơn trên Redis**

Không chọn hướng mỗi lần chạy một Redis DB/prefix: hướng đó phải sửa hơn 22 spec, vẫn cần khoá để cấp số DB, và các assertion `keys('*')` sẽ thành mơ hồ.

- `int-preflight.mjs`: dò TCP như cũ, sau đó `SET vg:int-lock <host:pid:random> NX PX 120000`. Nếu không lấy được khoá ⇒ throw ngay, thông báo nêu holder và PTTL, kèm gợi ý gỡ khi chắc chắn khoá đã cũ: `docker exec vg-test-redis redis-cli DEL vg:int-lock`.
- Heartbeat: `setInterval(...).unref()` mỗi 30 s, chạy Lua "so giá trị rồi mới `PEXPIRE`". Với `--runInBand`, globalSetup chạy cùng tiến trình với test nên heartbeat sống suốt lần chạy. Nếu tiến trình bị kill, khoá tự hết hạn sau ≤ 120 s.
- `test/int-teardown.mjs` (thêm `--globalTeardown` vào script) chạy Lua "so giá trị rồi mới `DEL`", sau đó `clearInterval` và `quit`. Token và client truyền qua `globalThis`. Nếu Redis lỗi khi nhả khoá thì chỉ cảnh báo, không làm đỏ lần chạy; TTL sẽ tự dọn.
- Dùng cùng `TEST_REDIS_URL` với các spec. Không FLUSH, không đụng key khác.
- Thêm `--testTimeout=20000` vào `test:int` (áp cho cả hook). Unit test giữ nguyên 5 s.
- DEBT-199 không cần sửa test vì nguyên nhân là chạy song song và đã được khoá xử lý. DEBT-195: sau khi tăng timeout, chạy riêng file `indexes.int-spec.ts` 10 lần. Nếu còn đỏ mà không phải do timeout thì bắt nguyên văn lỗi và sửa cho tất định (không đoán trước).

### Q-34.2 Phạm vi: vừa 1 run **nếu chỉ viết test**; debt sản phẩm tách sang run sau

Khảo sát nhanh theo tên test (`it(`) trong `be/test/*.int-spec.ts`, `be/src/**/*.spec.ts`, `fe-sso-test/test/*`:

| Nhóm §14 | ~dòng | Có test | Thiếu test | Lỗi sản phẩm / ngoài phạm vi |
|---|---|---|---|---|
| Authorization code | 6 | 6 (C5a premature, reuse song song HTTP `token.int-spec` "two concurrent exchanges", PKCE plain, verifier, expired, resource) | 0 | – |
| Refresh token | 4 | 3 | **1: rotation song song thật qua `/token`** (hiện chỉ có race tất định cho revoke và `/revoke` song song) | – |
| Resource | 2 | 2 | 0 | – |
| Mix-up & issuer | 2 | 2 (BE + `fe-sso-test` callback/idToken) | 0 | – |
| state/nonce | 2 | 2 | 0 | – |
| Session | 10 | 9 | **1: logout ∥ `/token` song song thật** (hiện có seam tất định `token.int-spec` "session ends between re-check") | – |
| Account & enumeration | 6 | 4 | **2: phản hồi byte-identical cấp HTTP cho `/login`, `/register`, `/password/reset` (và verify-email); verify-email token single-use song song** | – |
| Multi-tenant | 4 | 2 (client/admin) | – | **2: cross-tenant token issuance + consent = lỗi sản phẩm DEBT-116** (`/authorize`/`/token` không kiểm membership trong `client.tenantId`; đã xác nhận: `isActiveMember` chỉ được gọi ở `TenantGuard`) |
| Admin step-up | 1 | 1 | 0 | – |
| Cookie & chung | 5 | 4 (CSRF, escape/CSP, open redirect, SSRF hard-coded) | 0 | 1: cookie đa trình duyệt ⇒ ngoài phạm vi (X3, DEBT-008) |

Ước lượng: khoảng 42 dòng, 35 đã có (≈ 83%), **5 thiếu test**, 2 lỗi sản phẩm, 1 ngoài phạm vi. §15: phần lớn đã ánh xạ trong plan §9. Các INV cần tester ghi chú riêng: INV-6 (phía RP, `fe-sso-test`), INV-19 (KMS/Vault, MVP dùng LocalKeyProvider ngoài Mongo ⇒ "một phần"), INV-24 (theo DEBT-116).

Kết luận: 5 test còn thiếu vừa sức một run. **Không** sửa sản phẩm cho các debt đang hẹn "B7.1" (DEBT-116/128/141/144/156 cùng cụm "re-check ở `/token`/`/authorize`", và DEBT-140/142/147/150/151/155/166/127/197). Các debt này chạm trust boundary và cần analyst thiết kế theo cổng security design (mã lỗi, fail-closed, race) ⇒ tách:

- **Run 35 (B7.1b)**: cross-tenant + re-check code/refresh grant: DEBT-116, 128, 144, 156, 141. Phải đi qua analyst trước.
- **Run 36 (B7.1c)**: race admin và audit: DEBT-140, 142, 147, 150, 151, 155, 166, 197. DEBT-127 chờ người dùng dọn DB dev/E2E.

### Q-34.3 CI Mongo: **không cần replica set**

Dùng service `mongo:7` single-node map `27117:27017` (cùng cách job e2e, DEBT-083 vẫn áp dụng). Nếu sau này có transaction thì đổi service thành step `docker run -d -p 27117:27017 mongo:7 --replSet rs0`, rồi `mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'` và chờ PRIMARY. Ghi chú này đặt trong YAML.

## Điểm mạnh

- Đã có sẵn nhiều concurrent test thật (code reuse HTTP, reset password, registration, rate-limit N=50, admin rotate).
- Mongo đã cách ly theo spec ⇒ khoá chỉ cần cho Redis.
- Preflight hiện có là chỗ đặt khoá tự nhiên, không phải thêm abstraction.

## Vấn đề (đã fold vào `tasks.md`, không chặn)

- [x] Q-34.1 chưa chốt ⇒ chốt khoá Redis + heartbeat + teardown + `--testTimeout=20000`.
- [x] Task 3 "lỗi lớn báo orchestrator" quá mơ hồ ⇒ ngưỡng cụ thể: chỉ sửa nếu ≤ 15 dòng trong 1 hàm, không đổi hợp đồng HTTP/mã lỗi; nếu không thì ghi DEBT và đặt trạng thái matrix "lỗi sản phẩm". Không commit test đỏ.
- [x] Acceptance "ma trận không còn thiếu" mâu thuẫn với DEBT-116 ⇒ thêm trạng thái "lỗi sản phẩm (DEBT-x, run y)".
- [x] Task 4 thiếu Mailpit; phải cấm đặt `TEST_MONGO_URI`/`TEST_REDIS_URL` trong CI; đóng DEBT-004 (job e2e đã chạy thật từ run 22).
- [x] Kỳ vọng cụ thể cho các test song song (xem fold).

## Đề xuất (không bắt buộc)

- DEBT-203 (backlog): `TEST_MONGO_URI` override nên là base URI, mỗi spec tự nối hậu tố như nhánh mặc định.
- Bổ sung probe Mailpit vào preflight: không làm (YAGNI). Lỗi `mailer.int-spec` khi thiếu Mailpit đã đủ rõ.
