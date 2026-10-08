# Senior Review — 2026-10-08
## Kết luận: PASS

## Tổng quan

Triển khai đúng phạm vi B4.3: chỉ store + Lua primitive, không đụng `/authorize` hay `/token`
(xác nhận bằng usages — `AuthorizationCodeService` chỉ có trong DI providers/exports của
`OauthModule`, không controller nào gọi nó). Pattern tái dùng nhất quán với
`AuthorizeRequestContextService`/`SessionService` đã có: `RedisService.client`, `loadLuaScripts`,
`generateToken`/`sha256` từ B1.5, `SET ... PX NX` khi tạo.

Đã tự chạy lại toàn bộ test (không chỉ tin lời khai), và **tự verify Lua script trực tiếp trên
Redis thật** (ngoài test suite của dev) để loại rủi ro "test pass nhờ event-loop Node, không phải
Redis atomic thật". Bằng chứng cụ thể ở dưới.

### Bằng chứng đã chạy lại

```
pnpm.cmd typecheck   → tsc --noEmit, exit 0
pnpm.cmd lint        → eslint src, exit 0
pnpm.cmd test        → Test Suites: 12 passed, 12 total / Tests: 67 passed, 67 total
pnpm.cmd test:int    → Test Suites: 12 passed, 12 total / Tests: 174 passed, 174 total
                       PASS test/authorization-code.int-spec.ts (8/8):
                         ✓ stores only sha256(code) ... correct payload + TTL
                         ✓ C5(a): wrong clientId → null, code intact, valid consume after OK
                         ✓ C5(a): wrong redirectUri → null, code intact, valid consume after OK
                         ✓ C5(b): two concurrent consumes, correct identity — exactly one succeeds
                         ✓ C5(c): TTL fixed at 60s (real PTTL)
                         ✓ C5(c): expired code (TTL elapsed) → null
                         ✓ C5(d): single-use — second consume → null
                         ✓ unknown/empty code → null, no throw
```

Khớp đúng số dev khai (typecheck/lint PASS, unit 67/67, int 174/174, suite mới 8/8).

### Verify độc lập trên Redis thật (không qua code TS/test của dev)

Load đúng Lua source từ service (`consumeAuthCode`) bằng `SCRIPT LOAD` + `EVALSHA` trực tiếp qua
`docker exec vg-test-redis redis-cli`:

```
SET testkey '{"clientId":"c1","redirectUri":"r1","foo":"bar"}' (TTL 60s)
EVALSHA ... testkey wrong-client r1   → (nil)
EXISTS testkey                        → 1   (KHÔNG bị xoá khi sai binding — đúng §9.5/INV-13)
EVALSHA ... testkey c1 r1             → trả nguyên JSON, DEL thành công
EXISTS testkey                        → 0
EVALSHA ... testkey c1 r1 (lần 2)     → (nil), không throw
```

**Concurrency thật** (không qua Node/ioredis pipelining — 10 tiến trình `docker exec` riêng biệt
chạy song song bằng PowerShell `Start-Job`, mỗi job là 1 TCP connection độc lập gọi
`EVALSHA ... testkey c1 r1`):

```
10 EVALSHA song song trên cùng key → đúng 1 trả data, 9 còn lại (nil)
```

→ Atomicity là tính chất của Redis engine (single-threaded command execution), không phải artifact
của test runner. Đây là lý do mạnh hơn việc chỉ chạy `Promise.all` trong Jest (vẫn đã kiểm, xem
dưới) vì loại được khả năng 2 lệnh JS "song song" thực ra serialize qua cùng 1 connection/pipeline
theo cách khiến test pass dù Lua có bug.

Test `Promise.all` trong `authorization-code.int-spec.ts` (C5(b)) tạo đúng 2 promise trước khi
await bất kỳ cái nào (`Promise.all([svc.consume(...), svc.consume(...)])`) — gọi concurrent thật
ở tầng ioredis, không phải tuần tự giả. Đã đọc bytes gốc của file xác nhận đúng 2 lời gọi khác
nhau (không phải lỗi hiển thị do PowerShell console rút gọn dòng trùng).

### cjson / failure behavior

- Key không tồn tại → Lua trả `nil` ngay ở `if not value then return nil end`, không gọi
  `cjson.decode` trên giá trị rỗng → an toàn.
- Giá trị không phải JSON hợp lệ (test tay: `SET badkey "not-json-at-all"` rồi `EVALSHA`) →
  `cjson.decode` throw lỗi Redis (`ERR user_script ... Expected value but found invalid token`).
  Đường này **không thể xảy ra qua API thật** vì `create()` là nơi duy nhất viết key và luôn
  `JSON.stringify` payload hợp lệ — nhưng nếu dữ liệu bị corrupt ngoài ý muốn, hành vi là throw
  (fail-closed), không coi là "không có code" / không log giá trị gì nhạy cảm trong message lỗi.
  Hợp lý, không cần xử lý thêm trong phạm vi task này.

### Không rò plaintext code

- Đọc toàn bộ `authorization-code.service.ts`: không có `console.log`/`Logger` nào đụng tới biến
  `code`. Error duy nhất (`AuthorizationCode collision`) không chứa `code`.
- Test: assert tường minh `raw).not.toContain(code)` và `redis.keys('*')` quét toàn bộ keyspace để
  chắc chắn không key nào chứa plaintext code — kiểm tra thật, không chỉ "đoán".
- Key Redis `authz_code:{sha256(code)}` xác nhận qua `redis.exists(authz_code:${code})` → 0 (không
  tồn tại key dùng plaintext).

### Payload / phạm vi field

Đối chiếu `spec.md` §10: `AuthorizationCode (Redis, atomic consume+bind — mục 9.5): clientId,
redirectUri, codeChallenge, resource, scope, nonce, userId, TTL 60s, single-use`. Code khai đúng 7
field + `authTime` optional (có JSDoc giải thích rõ lý do B4.4 cần `auth_time`, không tự ý thêm
field khác ngoài spec) — đúng C7.

### Đối chiếu C1–C7 (tech-lead)

| # | Yêu cầu | Kết quả |
|---|---|---|
| C1 | Key theo hash, không plaintext | ✅ `authz_code:${sha256(code)}`, verify thật trên Redis |
| C2 | Lua tên riêng `consumeAuthCode`, đăng ký qua `loadLuaScripts` trong constructor | ✅ |
| C3 | `numberOfKeys: 1`, ARGV cho clientId/redirectUri, không thêm KEYS thứ 2 | ✅ |
| C4 | `SET ... PX 60000 NX`, throw khi `ok !== 'OK'` | ✅ |
| C5 | 4 test tối thiểu (sai binding giữ code; concurrent 1 thắng; TTL thật; replay null) | ✅ 8 test, vượt yêu cầu, có test thêm (unknown/empty code, payload+key format) |
| C6 | Không log plaintext code | ✅ đọc code xác nhận không có log nào đụng `code` |
| C7 | Không bịa field ngoài spec | ✅ đúng 7 field + `authTime` optional có giải thích |

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **INV-13 (premature consumption / DoS)**: sai `clientId` hoặc `redirectUri` không xoá code —
  verify cả bằng Jest test và bằng `redis-cli EVALSHA` tay trên Redis thật, key vẫn `EXISTS=1`
  sau lần consume sai, và consume đúng ngay sau đó vẫn thành công.
- **INV-1/2 (single-use)**: consume đúng lần 2 trả null — verify cả hai cách.
- **Concurrency/atomicity**: 10 tiến trình OS độc lập gọi `EVALSHA` song song trên cùng key → đúng
  1 thành công. Đây là bằng chứng mạnh hơn yêu cầu техlead (C5(b) chỉ cần `Promise.all` trong một
  process Node).
- **Exposure**: không log/throw lộ plaintext `code`; key Redis dùng hash; test quét toàn keyspace
  xác nhận không key nào chứa plaintext.
- **Fail-closed**: lỗi Redis/dữ liệu hỏng → throw, không âm thầm coi là "code không tồn tại".
- **Cluster-safety (DEBT-013 note)**: Lua chỉ dùng 1 KEYS → không có CROSSSLOT nếu sau này chuyển
  Redis Cluster — xác nhận đúng bằng đọc source, không có KEYS thứ 2 nào bị thêm.
- **Phạm vi/trust boundary**: `AuthorizationCodeService` export nhưng chưa được bất kỳ controller
  nào gọi (xác nhận bằng `usages_ide`) — đúng chỉ đạo "không wire /authorize, /token" của run này;
  không có nguy cơ route thật đang dùng code chưa hoàn thiện.

## 🟡 Nên sửa

(không có mục mới — không phát hiện vấn đề đáng kể ngoài phạm vi ponytail dưới)

## 💭 Nit

- `authorization-code.service.ts`: JSDoc của `CONSUME_SCRIPT` và class đã rất đầy đủ (trích dẫn
  đúng spec §9.5, INV-13, INV-1/2, INV-20) — tốt, không cần sửa, chỉ ghi nhận làm mẫu tốt cho các
  service Redis sau này.

## ✂️ Ponytail

- `authorization-code.service.ts:L54`: yagni: `type AuthCodeRedis = { consumeAuthCode(...): Promise<string | null> }` định nghĩa riêng một type chỉ dùng 1 lần tại chỗ gọi (`as unknown as AuthCodeRedis`). Đây là bản sao gần như y hệt `AuthzRedis` trong `authorize-request-context.service.ts` (cùng pattern "khai type cho lệnh ioredis tự định nghĩa"). Không gộp thành việc của run này (đổi 2 file khác phạm vi), nhưng ghi nhận trùng lặp nhỏ giữa 2 service.
- `authorization-code.service.ts`: không phát hiện field/abstraction/config thừa nào khác — service ngắn (113 dòng), không có interface/factory/option dư so với nhu cầu thật của task.

net: -0 lines possible trong phạm vi run này (bản sao `AuthCodeRedis`/`AuthzRedis` là vấn đề liên-file, để lại backlog DEBT-025 thay vì sửa ở 1 trong 2 service). Lean already cho phần code mới của B4.3. Ship.