# Tech Lead Review — 2026-10-13
## Kết luận: PASS (kèm chỉnh sửa — đã fold vào `tasks.md`, đánh dấu *(tech-lead fold)*)

Cả 5 mục là **lỗi thật**, đối chiếu code `8a58faa` qua CodeGraph:
- T1: `token.controller.ts:219–225` — `revokeFamilyForEndedSession` chạy trước `recordIssued(failure)`, không try ⇒ revoke ném thì mất audit. `token.service.ts:178–179` tính lại `refresh` (DEBT-068). Đúng.
- T2: `RateLimitService.hit` chỉ được gọi từ `ui.controller.ts:395` và `RateLimitGuard`; `ClientAuthenticationService.authenticate` (L58–59) luôn chạy Argon2 kể cả client_id lạ. `/revoke` (L290) dùng chung `authenticateClient`. Đúng.
- T3: `local-key-provider.ts:65/73` `rm` trước `writeState` (L76); `writeState` ghi đè trực tiếp. Đúng.
- T4: `rotateSecret` L73–74 tính từ `listActive` ⇒ trùng version tuần tự; schema L12 index non-unique. Đúng.
- T5: spec §11 có 2 dòng `/introspect` (hiện L453 + L462); `grep -c Task spec.md` = 0. Đúng.

## Kiến trúc đề xuất (chốt D1–D7)
Giữ modular monolith, không thêm module/abstraction mới. Rate limit client auth đặt **một chỗ**: `ClientAuthenticationService.authenticate(input, { ip })` (đã là điểm hội tụ của `/token`, `/revoke`, `/introspect`) thay vì nhân bản trong 2 controller.

| # | Chốt | Lý do |
|---|---|---|
| D1 | **Chỉ đếm lần thất bại** (`invalid_client`: client lạ, sai method, sai secret). Trước Argon2: `peek()` 2 khoá — `ip` và `account=clientId|ip` — nếu đã ≥ ngưỡng ⇒ 429, không Argon2, không chạm DB. Sau `InvalidClientError` ⇒ `hit()`. Không đếm request thành công, **không đếm request 429** (window tự hết hạn, `Retry-After` chính xác). Bỏ qua hoàn toàn khi `method==='none'` (không Argon2, không secret để brute-force). | Đếm cả thành công sẽ 429 chính RP backend refresh nhiều user / RS introspect mỗi request. Attacker luôn thất bại ⇒ vẫn bị chặn cả DoS Argon2 lẫn brute-force. Cần thêm `RateLimitService.peek()` (~15 dòng, dùng chung hàm tạo key với `hit`). Burst đồng thời vượt ngưỡng tối đa = độ song song của attacker trong 1 window — chấp nhận. |
| D2 | `CLIENT_AUTH_FAIL_IP_MAX=30`, `CLIENT_AUTH_FAIL_CLIENT_MAX=10` (positiveInt, có default), cửa sổ `RATE_LIMIT_WINDOW`. Bỏ 2 biến `INTROSPECT_*`. | Failure-only nên ngưỡng thấp an toàn cho traffic hợp lệ; 2 biến thay 4. |
| D3 | `RateLimitService` trực tiếp, nhưng gọi trong `ClientAuthenticationService` (tham số `ctx: { ip: string \| undefined }` **bắt buộc**; ip rỗng ⇒ dùng `'unknown'`, vẫn đếm). Lỗi mới `ClientAuthRateLimitedError(retryAfterSec)`; 2 controller map sang 429. | Một nơi thực thi invariant "không Argon2 khi bị chặn"; không thể quên ở caller mới. |
| D4 | 429 `{error:'temporarily_unavailable'}` + `Retry-After` + `no-store`, không `WWW-Authenticate`, không `error_description` echo input. Thêm mã vào `TokenErrorCode` + kiểu lỗi introspect. | Chấp nhận (RFC 6749 không có mã cho 429; mã này được dùng rộng rãi). |
| D5 | Redis lỗi ở `peek`/`hit` ⇒ fail-closed 500. Áp cả `/revoke` (client tự retry). | Fail-open mất bảo vệ đúng lúc hệ thống yếu. |
| D6 | `/token` + `/revoke` + `/introspect` dùng **chung** bucket `client-auth` (cùng tài sản: secret client). | Failure-only nên không còn lý do tách bucket introspect. |
| D7 | Retry đúng 1 lần khi E11000, lần 2 ném. **Áp cho cả `createSecret`** (xem Vấn đề #2). | |

**DEBT-006 (trustProxy) — đưa vào run này (T2, bước 0).** Không có nó, sau reverse proxy `req.ip` = IP proxy ⇒ bucket `ip` thành **giới hạn toàn cục** (30 lần sai/phút từ bất kỳ ai ⇒ khoá `/token` cho mọi client) và `clientId|ip` thành khoá theo client_id trần ⇒ attacker khoá được client hợp lệ — đúng điều D1 muốn tránh. Bật rate limit mà không có trustProxy = thêm vector DoS mới, tệ hơn hiện trạng. Chi phí nhỏ (~20 dòng): env `TRUST_PROXY` = rỗng/`false` (mặc định, tắt) | số hop | danh sách IP/CIDR; **từ chối `true`** (tin mọi `X-Forwarded-For` ⇒ spoof IP vượt bucket). Hàm thuần `parseTrustProxy()` dùng chung cho `main.ts` (`new FastifyAdapter({ trustProxy })`) và test. Cũng sửa luôn IP cho rate-limit login và audit.

## Điểm mạnh
- Bằng chứng có file:dòng, đúng code thật; repro RED trước.
- T1 phân tích đúng thứ tự best-effort, không dùng `finally`.
- T2 nhận ra guard không thấy client_id trong Basic; khoá `client_id|ip` thay vì client_id trần.
- T4 phát hiện lỗi tuần tự (không cần race) — quan trọng hơn race.
- T5 khoá tài liệu runbook bằng assertion int (nếu mongoose đổi thứ tự, test đỏ).

## Vấn đề (đã fold vào tasks.md — dev làm theo bản fold)
- [x] **#1 T2 — thiếu trustProxy ⇒ rate limit thành DoS toàn cục.** Fold: bước 0 DEBT-006 + test spoof (không trustProxy ⇒ XFF bị bỏ qua; có trustProxy ⇒ 2 XFF khác nhau có counter độc lập).
- [x] **#2 T4 — unique index làm vỡ test/hành vi `createSecret`.** `createSecret` cứng `version: 1` (`client-credential.service.ts:63`); `introspect.int-spec.ts:245/327/338/365/379/441` gọi `createSecret(TOKEN_CLIENT)` nhiều lần trên cùng DB ⇒ E11000 sau khi index unique. Fold: `createSecret` dùng chung `nextVersion` (max mọi version + 1) + retry E11000; thêm test "createSecret 2 lần ⇒ v1, v2, cả hai authenticate được".
- [x] **#3 T2 — đếm cả request thành công phạt traffic hợp lệ.** Fold: failure-only + `peek()` (D1).
- [x] **#4 T3 — dọn PEM mồ côi trong `init`/`rotate` có race** khi 2 tiến trình dùng chung thư mục key (rolling deploy): B xoá PEM vừa tạo của A trước khi A ghi state ⇒ chính lỗi đang sửa. Fold: **bỏ** GC; PEM mồ côi do `writeState` lỗi là key mới chưa từng dùng (vô hại). `rm` lỗi ở emergency ⇒ `logger.error` (kid, không đường dẫn). File tmp tên duy nhất (`keys.json.<random>.tmp`), `rename` sau.
- [x] **#5 T2 — isolation test.** Failure-only đếm các case `invalid_client` sẵn có ở nhiều file int (cùng `127.0.0.1`, cùng Redis, TTL 60s) ⇒ có thể 429 ngẫu nhiên. Fold: test module mặc định ngưỡng cao; spec mới đặt ngưỡng nhỏ + xoá `rl:client-auth:*` trong `beforeEach`.
- [x] **#6 T5 — văn bản spec §11** cập nhật theo D1/D6 (failure-only, chung bucket) + runbook ghi `TRUST_PROXY`.

## Đề xuất (không bắt buộc) → backlog
- DEBT-071: `LocalKeyProvider.getPublicKeys()` ghi state khi prune (read-modify-write) có thể đè `rotate` đồng thời — dev-only.
- DEBT-072: rate limit phân tán (botnet xoay IP) cho client auth — cần giới hạn toàn cục/WAF, ngoài phạm vi.

---

# Bổ sung — retry 1 (2026-10-13, sau senior REJECT)
## Kết luận: PASS (sau fold *(tech-lead fold — retry 1)* trong `tasks.md` Task 2 R1–R4) → **backend-dev retry 1**

Thừa nhận: D1 vòng 1 của tech-lead chấp nhận "burst = độ song song attacker" — **sai**: không có cận trên (senior đo 200 req ⇒ 200 Argon2). Hai 🔴 đều đúng, đã đối chiếu code (`client-authentication.service.ts:95–140`, `rate-limit.service.ts:95–112`, `trust-proxy.ts:50–63`, `main.ts:25`, `config.module.ts:19–22`).

## 🔴1 — Chốt (a) reserve-then-refund atomic
| Tiêu chí | (a) reserve-then-refund | (b) semaphore Argon2 theo IP |
|---|---|---|
| Cận trên Argon2/cửa sổ | = ngưỡng (overshoot 0) | ngưỡng + (in-flight × số đợt trước khi `hit` ghi) — vẫn có burst, chỉ bị trải theo thời gian |
| Thành phần mới | 2 Lua nhỏ (reserve, refund) — thay `peek` (xoá) | giữ `peek`+`hit` + counter in-flight + TTL an toàn + `finally` ⇒ 3 cơ chế |
| Redis lỗi giữa chừng | reserve lỗi ⇒ 500 (fail-closed); refund lỗi ⇒ +1 chặt hơn, hết theo TTL | DECR trong `finally` lỗi ⇒ semaphore kẹt tới TTL ⇒ **khoá cả client hợp lệ** cùng IP |
| Multi-instance | đúng (atomic ở Redis) | đúng |
| Khoá client hợp lệ | chỉ khi > `CLIENT_MAX` lượt **đang chạy** cùng lúc từ 1 IP (Argon2 ~vài chục ms ⇒ cần >10 song song thực) | thêm tham số concurrency phải tune |

⇒ **(a)**: đơn giản hơn, đóng race bằng chính Redis atomic, failure mode chỉ lệch về phía an toàn. (b) không cho cận trên chặt và có kẹt semaphore.

Chi tiết bắt buộc (đã fold):
- 1 script cho cả 2 khoá: kiểm **tất cả** trước, chỉ INCR khi **không** khoá nào vượt (tránh bucket IP bị đốt bởi request đã bị bucket client chặn và ngược lại).
- **Cluster/DEBT-013**: hash tag `{sha256(ip)}` chung cho 2 khoá ⇒ cùng slot. Không động tới `hit()`/login (khoá đơn, không cross-slot).
- **Reserve trước `findByClientId`** ⇒ đóng luôn 🟡 query Mongo khi bị chặn; enumeration không đổi (429 trước mọi tra cứu).
- Refund: `DECR` chỉ khi key tồn tại và > 0; lỗi ⇒ warn, vẫn 200. Tiến trình chết ⇒ thừa 1, tự hết.
- Không thêm env mới; ngữ nghĩa ngưỡng ghi lại = thất bại + đang chạy. Default 10/30 đủ rộng cho RP (thành công được hoàn ngay).
- Xoá `peek()` (không caller còn lại ngoài test của chính nó).

## 🔴2 — Quy tắc từ chối `TRUST_PROXY`
- CIDR v4 **/0–/7** và v6 **/0–/7** ⇒ throw. Ngưỡng /8 vì `10.0.0.0/8`, `fd00::/8` là cấu hình hợp lệ phổ biến; dưới /8 không có mạng proxy nội bộ hợp lý.
- **Phát hiện thêm** (đã chạy thử `@fastify/proxy-addr@5.1.1`): `::ffff:0:0/96` / `::ffff:0.0.0.0/96` ⇒ tin **mọi IPv4** — chỉ chặn "/0" sẽ lọt. Quy tắc: IPv4-mapped quy về v4 (`p-96`), `p < 104` ⇒ throw.
- Hop count > 10 ⇒ throw (hop dư = client chèn XFF giả). Không cố chặn mọi tổ hợp nhiều CIDR rộng (vd. `0.0.0.0/8,…`) — ngoài phạm vi, runbook cảnh báo.

## 🟡 — Xác nhận sửa trong vòng này
- [x] `main.ts` đọc env trước ConfigModule: **nạp sớm** `process.loadEnvFile('.env')` nếu tồn tại (đã kiểm không ghi đè biến thật — cùng ưu tiên `@nestjs/config`) **+** check khởi động `assertTrustProxyConsistent` (lệch ⇒ throw). Chỉ ghi runbook là không đủ (lỗi lặng lẽ).
- [x] `findByClientId` trước peek — giải bằng R1 (reserve trước).
- [x] Toàn bộ test thiếu: (h), (f)+200, (j) chết M5, T4 retry/2×E11000, T3 rename/emergency, T1 double-throw.
- [x] Nit/ponytail rẻ: `void keys`, `writeFile` vào `try`, `app.trustProxy` có người đọc (R3). Hoãn: `error_description` `/introspect` 429 (nhất quán, không phải lỗi).

## Security gate (delta)
- Invariant: Argon2/cửa sổ ≤ ngưỡng với concurrency bất kỳ, multi-instance (test (k)).
- Abuse: race (k), xoay client_id (k-biến thể), spoof XFF qua CIDR rộng/mapped (R2), cấu hình lệch `.env` (R3).
- Failure: reserve lỗi ⇒ 500 không DB/Argon2 (n); refund lỗi ⇒ 200 + warn (m); TTL luôn được đặt ở INCR đầu (p).
- Exposure: log refund chỉ `err.message`; khoá Redis chỉ sha256; 429 giữ D4.

## Đề xuất (không bắt buộc) → backlog
- DEBT-073: `RateLimitService.hit()` (login, nhiều dimension) cũng peek-free nhưng các key khác slot ⇒ CROSSSLOT nếu Cluster — gộp vào DEBT-013/B7.3.

# Bổ sung — retry 3 (2026-10-13, orchestrator chốt thay tech-lead)
## Quyết định: BỎ hỗ trợ `TRUST_PROXY` dạng số (hop count) — chỉ nhận IP/CIDR
Lý do (senior lượt 3 🔴): Fastify 5.12.5 `getTrustProxyFn` âm thầm map `trustProxy` dạng số ⇒ `false` (fail-closed, không xác thực được peer liền kề), nên số hop trông `đã cấu hình` nhưng `req.ip` vẫn là IP socket của proxy ⇒ bucket IP = giới hạn toàn cục, không cảnh báo. Chốt: `parseTrustProxy` **throw** với giá trị dạng số (thông báo hướng dẫn dùng IP/CIDR của proxy); bỏ nhánh `number`, `MAX_HOPS`, cast ở `main.ts`; type trả `false | string[]`. Cập nhật runbook §TRUST_PROXY, `.env.example`, `validation.schema`, AC `tasks.md`. (Không cần vòng tech-lead đầy đủ — sửa nhỏ, đổi hợp đồng theo khuyến nghị senior.)