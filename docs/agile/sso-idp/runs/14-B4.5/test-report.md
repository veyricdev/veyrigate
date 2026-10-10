# Test Report — 2026-10-10 — run 14 (B4.5: refresh grant + rotation + reuse detection + /revoke)

## Kết quả: **PASS** (342/342 test)

- Unit (`pnpm test`): **80/80** pass
- Integration (`pnpm test:int`, Mongo `vg-test-mongo@27117` rs0 + Redis `vg-test-redis@6479`): **262/262** pass
- Typecheck (`tsc --noEmit`): sạch · Lint (`eslint src`): sạch
- Tester bổ sung **5 test QA** mới trong `be/test/refresh-token.int-spec.ts` (suite 27 → 32). KHÔNG sửa code sản phẩm.

## Lệnh đã chạy + output thực tế

### 1. `codegraph sync` → `Already up to date` (index 1.6.2)

### 2. `pnpm typecheck` (cwd `be/`)
```
$ tsc --noEmit
<exit 0, không lỗi>
```

### 3. `pnpm lint` (cwd `be/`)
```
$ eslint src
<exit 0, không lỗi>
```

### 4. `pnpm test` (unit)
```
Test Suites: 13 passed, 13 total
Tests:       80 passed, 80 total
Snapshots:   0 total
Time:        14.675 s
```

### 5. `pnpm test:int` (integration, runInBand, Mongo+Redis thật)
```
PASS test/refresh-token.int-spec.ts (10.838 s)
PASS test/token.int-spec.ts
PASS test/authorization-code.int-spec.ts
... (15 suites)
Test Suites: 15 passed, 15 total
Tests:       262 passed, 262 total
Snapshots:   0 total
Time:        50.039 s
```
Ghi chú: các dòng `ERROR [TokenController] ... SECRET-detail` / `Connection is closed` trên stderr là **đầu vào có chủ đích** của các test fail-closed (inject lỗi Redis/Mongo/signer để assert 500 + body KHÔNG chứa secret). Đây là log phía server (sink được phép), không phải leak ra response/audit; suite vẫn `PASS`.

### 6. Verbose refresh-token suite (xác nhận 5 QA test chạy)
```
√ QA: grant_type=password and empty grant_type both => 400 unsupported_grant_type (dispatch, no rotation)
√ QA: invalid_scope must NOT emit a reuse audit (bad request is not a security event)
√ QA: CONCURRENT /revoke of the same value => both 200, exactly one TOKEN_REVOKED audit (atomic idempotency)
√ QA: /revoke of an expired refresh => 200 (RFC 7009 idempotent, no error leak)
√ QA: body resource mismatch is rejected BEFORE the token is burned (invalid_target, still usable)
Tests:       32 passed, 32 total
```

### 7. Grep "no hard-coded TTL" (Task 5 acceptance)
```
grep -rnE '2592000|refreshTokenTtl *= *[0-9]' be/src/modules/oauth/token/
→ chỉ khớp 1 lần, trong *test* (token.service.spec.ts:20 REFRESH_TTL). KHÔNG có literal TTL trong src sản phẩm (TTL đọc từ config — Q6).
```

## Test FAIL
Không có. 0 FAIL.

## Coverage acceptance criteria

### Task 1 — `RefreshTokenService` rotation/reuse/revoke (unit nằm trong int-spec vì cần Mongo thật)
- [x] Rotation thành công (2 doc cùng family, old.replacedBy=ObjectId con, child.parentId=old._id, refresh mới ≠ cũ) — `happy path: refresh => 200 ...`
- [x] Concurrent → đúng ≤1 hậu duệ, không 2 hậu duệ, family revoke toàn bộ — `CONCURRENT refresh of the same value ...`
- [x] Reuse (replay rotated) → revokeFamily, mọi doc revokedAt, 1 audit TOKEN_REUSE_DETECTED — `reuse: replay a rotated refresh ...`
- [x] `expiresAt` hậu duệ === gốc (absolute, no sliding, Q6) — `happy path ...` (assert getTime bằng nhau)
- [x] Token value không tồn tại → KHÔNG revokeFamily, KHÔNG audit reuse, invalid_grant — `unknown token value ...`
- [x] Concurrent: family revoke toàn bộ kể cả hậu duệ vừa mint (strict) — `CONCURRENT ...` + 2 DETERMINISTIC race
- [x] Hết hạn → invalid, KHÔNG revoke family, KHÔNG audit reuse — `expired refresh ...`
- [x] Sai client (token A rotate với B) → invalid, doc A không đổi; token A đã revoke gọi với B → KHÔNG revoke family A — `cross-client: refresh of client A used by client B ...`
- [x] `replacedBy` === `_id` hậu duệ (ObjectId) — `happy path ...`
- [x] Resource gỡ khỏi `allowedResources` (INV-14) → invalid, doc không đổi, family không revoke — `resource removed from client.allowedResources ...`

### Task 2 — refactor mint dùng chung
- [x] B4.4 flow vẫn phát refresh, familyId mới + parentId=null — regression: `token.int-spec` + `token.service.spec` (D7 tests) toàn xanh
- [x] Helper dùng chung (hậu duệ + lần đầu cùng path `insertRefreshToken`) — xác nhận qua CodeGraph (service gọi `tokens.insertRefreshToken`) + regression
- [x] `expiresAt` lần đầu = now+ttl; hậu duệ kế thừa — `happy path ...` + token.service.spec D7

### Task 3 — `/token` grant `refresh_token`
- [x] Happy path 200, access aud=resource gốc, scope gốc, refresh mới, audit TOKEN_REFRESHED — `happy path ...`
- [x] authorization_code không đổi sau refactor dispatch — `token.int-spec` toàn xanh
- [x] `grant_type=password`/rỗng/absent → unsupported_grant_type — **QA bổ sung**: `grant_type=password and empty ...` (dev chỉ có `client_credentials`)
- [x] Token từ refresh: id token không nonce/auth_time; admin-less access không auth_time — `id token from refresh ...`
- [x] Thu hẹp bỏ openid → response không id_token — `narrowing scope drops openid ...`
- [x] **Leo thang scope bị từ chối** → 400 invalid_scope, KHÔNG rotate (token còn active) — `scope escalation ...`
- [x] Thu hẹp scope → access token scope thu hẹp, refresh mới giữ scope gốc (INV-12) — `narrowing scope ...`
- [x] `resource` khác token gốc → invalid_target, không rotate — `body resource different ...` + **QA** `body resource mismatch ... still usable`
- [x] Client mismatch → invalid_grant, token A không revoke/rotate — `cross-client ...`
- [x] Reuse → invalid_grant + family revoked + audit reuse, response không rò lý do — `reuse ...` + `replay a ROTATED refresh WITH a bad scope ...`
- [x] Fail-closed: lỗi giữa chừng → 500, no-store, không phát token một phần — `fail-closed: audit failure after rotate ...`
- [x] Client không có grant refresh_token → unauthorized_client; thiếu refresh_token → invalid_request — `client without refresh_token grant ...`

### Task 4 — `POST /revoke` (RFC 7009)
- [x] refresh hợp lệ → 200, doc revoked, audit TOKEN_REVOKED; reuse ở /token → invalid_grant (KHÔNG audit reuse) — `revoke a valid refresh ...`
- [x] Family ≥2 thế hệ: revoke bằng con active → cả family revoked; revoke bằng cha đã rotate → vẫn 200 — `revoke by active child ...`
- [x] Gọi 2 lần → cả hai 200, 1 audit TOKEN_REVOKED — `revoke twice ...` (sequential) + **QA** `CONCURRENT /revoke ... atomic idempotency` (song song)
- [x] Cả Basic lẫn body secret → invalid_request; thiếu token → invalid_request; mọi response no-store — `revoke: both Basic and body secret ...`
- [x] Log/audit không chứa token — `revoke: audit/log never contains the token value ...`
- [x] Token client khác (IDOR) → 200 nhưng token A unchanged — `revoke token of another client (IDOR) ...`
- [x] Token không tồn tại / access token (sai type) → 200 no-op — `revoke unknown token / wrong type ...` + **QA** `/revoke of an expired refresh => 200`
- [x] Client auth sai → 401 invalid_client + no-store — `revoke with bad client auth ...`
- [x] Mongo lỗi → 500 server_error + no-store (fail-closed exception to always-200) — `revoke: Mongo failure ...`

### Task 5 — test matrix + DEBT
- [x] Unit ≥80, int ≥230, tổng ≥310+ → **80 + 262 = 342**
- [x] typecheck + lint sạch; không literal TTL hard-code trong src (grep)
- [x] backlog.md có DEBT-031 (device-revoke) + DEBT-025 đánh giá (+ DEBT-032..036)
- [x] Fail-closed hệ quả: (b)-(d) lỗi → client gửi lại → family revoked → login lại (hành vi đúng) — `fail-closed: audit failure after rotate ...` (retry → invalid_grant + family dead)
- [x] Concurrent rotation trên Mongo thật, Promise.all ≥2 HTTP, không mock model — `CONCURRENT refresh ...`

## Coverage security invariants / risk matrix

- [x] **INV-10** (rotate atomic, tra cứu chỉ bằng `tokenHash`, không plaintext trong DB) — `happy path` (findOneAndUpdate theo tokenHash) + audit metadata assert không chứa token/hash (`JSON.stringify(meta)` not contain rt/sha256(rt))
- [x] **INV-11** (mỗi refresh dùng đúng 1 lần; reuse → revoke toàn bộ family ngay, no grace) — `reuse ...`, `CONCURRENT ...`, 2× `DETERMINISTIC race (INV-11)` (reuse-revoke và /revoke, dùng gate promise — KHÔNG hard sleep)
- [x] **INV-12** (refresh không mở rộng scope/resource; chỉ thu hẹp; clientId phải khớp) — `scope escalation ...`, `narrowing scope ...`, `body resource different ...`, `cross-client ...`
- [x] **INV-14** (resource gỡ khỏi allowedResources → stale grant ngừng) — `resource removed from client.allowedResources ...`
- [x] **Concurrent refresh chỉ 1 hậu duệ** — `CONCURRENT refresh ...` (assert descendants ≤1, family toàn revoked)
- [x] **Leo thang scope bị từ chối** — `scope escalation ...` + **QA** `invalid_scope must NOT emit reuse audit` (chặn false-alarm/exposure budget)
- [x] **/revoke RFC 7009** (200 đồng nhất chống enumeration; IDOR guard; idempotent; fail-closed 500 khi hạ tầng lỗi) — toàn bộ nhóm Task 4 + **QA** concurrent/expired
- [x] **Fail-closed** (DB/audit/signer lỗi → 5xx, không phát token một phần, không che thành guest/success) — `fail-closed ...`, `revoke: Mongo failure ...`, token.int-spec inject Redis/Mongo/signer
- [x] **Exposure budget** (refresh plaintext/hash không xuất hiện ở audit/log/response) — assert trong `happy path`, `revoke: audit/log never contains the token value`; sentinel `SECRET-detail` chỉ ở server log, không ở body (token.int-spec)

### Risk matrix (chiều đã kiểm)
| Chiều | Case đã kiểm |
|---|---|
| Identity | owner (happy), cross-client B (cross-client, IDOR revoke) |
| Credential | valid (happy), absent/sai (bad client auth 401), cả Basic+body (invalid_request) |
| Authorization | owner rotate/revoke; non-owner (client B) rotate → invalid_grant không revoke A; IDOR revoke → 200 no-op; client không có grant → unauthorized_client |
| Input | valid; boundary (scope= rỗng, scope dup); malformed (unknown token); escalation (scope ngoài gốc, resource khác) |
| State | fresh (happy); stale/expired (expired refresh, /revoke expired); already consumed (reuse); retry (fail-closed retry); concurrent (CONCURRENT rotate, CONCURRENT /revoke, 2× deterministic race) |
| Dependency | healthy; audit lỗi (fail-closed rotate), Mongo lỗi (/revoke 500), Redis/signer lỗi (token.int-spec) |
| Request chain | rotate → revoke token cũ → request kế tiếp dùng token cũ = reuse → family revoked (reuse, fail-closed retry) |
| Exposure | response (no access/refresh khi 500), audit/log (không token/hash), server log sentinel không lọt body |

## DEBT / lưu ý (không chặn PASS)
- **DEBT-035** (senior lượt 3, → B4.6): còn thiếu test tất định cho thứ tự "rotate re-read **TRƯỚC** stamp → revoke-pass bắt hậu duệ" (bổ sung cho 2 test tất định hiện có ép thứ tự ngược lại) và biến thể /revoke bằng con active trong cửa sổ race. INV-11 hiện đã có: 1 test ngẫu nhiên CONCURRENT + 2 test tất định (reuse‖, /revoke‖) + QA concurrent /revoke. Chiều ordering còn lại đã được senior theo dõi là debt hoãn B4.6 — KHÔNG phải bug, không chặn acceptance B4.5.
- DEBT-031/032/033/034/036 đã ghi trong backlog, ngoài phạm vi run.

## Kết luận
**PASS** — 342/342 test (80 unit + 262 int), mọi acceptance criteria của Task 1–5 (gồm tech-lead fold) và các invariant INV-10/11/12/14 có ≥1 test đo được. Không phát hiện bug. Không có security invariant nào ở trạng thái FAIL/DEBT-để-PASS. Bàn giao orchestrator đóng run; code chưa commit (dev/senior sẽ commit theo quy trình).