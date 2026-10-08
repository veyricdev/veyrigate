# Test Report — 2026-10-08 — Run 11 — B4.3 (AuthorizationCode store + Lua consume-with-binding)

## Kết quả: PASS (67/67 unit + 178/178 integration, suite mới 12/12)

## Môi trường
- Preflight CodeGraph: v1.6.2, `status` OK (159 files/2278 nodes), `sync` → "Already up to date".
- Containers: `vg-test-mongo@27117`, `vg-test-redis@6479` — đã Up sẵn (41+ phút), không cần restart.
- Lệnh chạy trong `be/`: `pnpm.cmd test` (unit), `pnpm.cmd test:int` (integration, `--runInBand`).

## Lệnh đã chạy + output thực tế

```
pnpm.cmd test
Test Suites: 12 passed, 12 total
Tests:       67 passed, 67 total

pnpm.cmd test:int
Test Suites: 12 passed, 12 total
Tests:       178 passed, 178 total
PASS test/authorization-code.int-spec.ts
```

Chạy riêng suite mới (verbose, `--testRegex "authorization-code\.int-spec\.ts$"`):
```
PASS test/authorization-code.int-spec.ts (5.3 s)
  AuthorizationCodeService on real Redis (B4.3, spec §9.1 step 3 / §9.5)
    √ stores only sha256(code): no raw code in any key, correct payload + TTL
    √ C5(a): wrong clientId → null, code still intact (EXISTS=1), valid consume right after still succeeds
    √ C5(a): wrong redirectUri → null, code still intact (EXISTS=1), valid consume right after still succeeds
    √ C5(b): two concurrent consumes with the correct identity — exactly one succeeds
    √ C5(c): TTL is fixed at 60s (real PTTL on Redis, no sliding)
    √ C5(c): expired code (TTL elapsed) → consume returns null
    √ C5(d): single-use — consuming an already-consumed code returns null
    √ unknown/empty code → null, no throw
    √ AC7: optional authTime round-trips through create → consume when supplied        [mới]
    √ AC7: authTime is omitted (not fabricated) when caller does not supply it         [mới]
    √ AC8: two codes minted by the service are CSPRNG-distinct (not sequential/predictable) [mới]
    √ AC3 (stronger): 5 concurrent consumes with the correct identity — exactly one succeeds [mới]
Tests: 12 passed, 12 total
```

Chạy lại lần 2 để loại flake (exit code 0 cả hai lần, không có FAIL nào trong bất kỳ lần chạy).

## Test FAIL

Không có. Tất cả test (cũ + mới) PASS ở mọi lần chạy.

## Test mới thêm (vào `be/test/authorization-code.int-spec.ts`, không sửa code production)

Trước khi thêm, 8 test có sẵn (từ dev) đã che AC1, AC2, AC3 (2 concurrent), AC4 (TTL + hết hạn), AC5 (replay), AC6 (key hash, không plaintext trong keyspace). Còn thiếu minh chứng trực tiếp AC7 (payload field optional round-trip) và AC8 (2 code phân biệt ở mức service, không chỉ ở mức `generateToken` unit test). Đã bổ sung 4 case:

1. `AC7: optional authTime round-trips through create → consume when supplied` — tạo code kèm `authTime`, consume lại, assert giá trị giữ nguyên.
2. `AC7: authTime is omitted (not fabricated) when caller does not supply it` — tạo code không kèm `authTime`, assert payload consume **không có** property này (chứng minh service không tự bịa trường — đúng C7/tasks.md).
3. `AC8: two codes minted by the service are CSPRNG-distinct (not sequential/predictable)` — gọi `create()` 2 lần ở mức service (không chỉ unit test `generateToken` riêng lẻ), assert 2 code khác nhau và đúng format CSPRNG (43 ký tự base64url).
4. `AC3 (stronger): 5 concurrent consumes with the correct identity — exactly one succeeds` — nâng từ 2 lên 5 consume đồng thời (tăng độ tin cậy race-condition test, theo khuyến nghị plan §12 "race condition dễ lọt nhất").

Không sửa `authorization-code.service.ts`. Không nới assertion nào trong test có sẵn.

## Coverage acceptance criteria

- [x] AC1 (sai `client_id` → null, không xoá, consume đúng sau đó OK, INV-13) — `C5(a): wrong clientId...` (có sẵn, PASS).
- [x] AC2 (sai `redirect_uri` → tương tự) — `C5(a): wrong redirectUri...` (có sẵn, PASS).
- [x] AC3 (2+ consume đồng thời đúng binding → đúng 1 thành công, INV-1) — `C5(b)` (2 concurrent, có sẵn) + `AC3 (stronger)` (5 concurrent, mới) — cả hai PASS, `EXISTS=0` sau cuộc đua xác nhận đúng 1 lần `DEL`.
- [x] AC4 (TTL ≤ 60000ms, >0; hết hạn → null) — `C5(c): TTL is fixed...` (PTTL thật `>59000 && <=60000`) + `C5(c): expired code...` (force-expire bằng `PEXPIRE 1` thật trên Redis, không sleep 60s, không mock clock) — có sẵn, PASS.
- [x] AC5 (replay lần 2 → null, INV-2) — `C5(d): single-use...` (có sẵn, PASS).
- [x] AC6 (key Redis không chứa plaintext code; không log plaintext, INV-20) — test đầu tiên `stores only sha256(code)...` quét toàn bộ `redis.keys('*')` xác nhận không key nào chứa code thô, cộng đọc source `authorization-code.service.ts` xác nhận không có `console.log`/`Logger` nào output `code` (chỉ JSDoc nhắc INV-20) — có sẵn + review thủ công, PASS.
- [x] AC7 (payload đúng field spec: clientId, redirectUri, codeChallenge, resource, scope, nonce, userId + authTime optional) — test đầu tiên assert `data` ⊇ 7 field; 2 test mới `AC7: optional authTime...` xác nhận round-trip khi có và **không bịa** khi không có.
- [x] AC8 (code sinh bằng CSPRNG, đủ entropy, 2 lần tạo khác nhau) — unit `crypto.util.spec.ts` (`generateToken` not Math.random, distinct) có sẵn + test mới `AC8: two codes minted by the service...` xác nhận ở mức service (không chỉ util), đúng format 43 ký tự base64url.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity/Authorization (consume binding) | đúng clientId+redirectUri (owner), sai clientId, sai redirectUri (non-owner claim) | `C5(a)` x2, test đầu, `AC3` |
| Credential/Token | code hợp lệ, code không tồn tại, code rỗng, code đã tiêu (replay), code hết hạn | `unknown/empty`, `C5(d)`, `C5(c): expired` |
| State | fresh (vừa tạo), stale/expired (TTL=0), already consumed, concurrent race | tất cả 12 case |
| Request chain / concurrency | 2 consume đồng thời, 5 consume đồng thời cùng code | `C5(b)`, `AC3 (stronger)` |
| Exposure | Redis keyspace (`KEYS *`) không chứa plaintext code; source code không log plaintext | test đầu (`allKeys.some(...code) === false`), review source |
| Input | payload field đúng/thiếu optional (`authTime`) | 2 test `AC7` mới |

Không phát hiện vi phạm nào trong INV-1/2/13/20. Không có DEBT mới cần mở từ phía tester (các DEBT đã ghi bởi tech-lead/senior — DEBT-013, DEBT-025 — không nằm trong phạm vi xác nhận lại ở đây vì không ảnh hưởng acceptance criteria của run này).

## Dọn file tạm
- Không tạo file tạm nào ngoài việc sửa trực tiếp `be/test/authorization-code.int-spec.ts` (thêm 4 test, giữ nguyên 8 test cũ). Không có file rác cần xoá.
