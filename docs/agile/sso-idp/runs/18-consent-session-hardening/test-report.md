# Test Report — 2026-10-12 — Run 18 consent-session-hardening

## Kết quả: PASS (531/531 test: unit 131 + int 400)

Baseline run 17 / dev run 18 = 528 (unit 131 + int 397). Tester thêm **3 int test** lấp khe senior
(DEBT-056/057/058) → **531**. Không sửa code sản phẩm (chỉ thêm test). Typecheck + lint xanh.

## Lệnh đã chạy + output thực tế

```
# cwd: be/  (shell = Git Bash; Mongo vg-test-mongo@27117 rs0, Redis vg-test-redis@6479 đang Up)

$ pnpm typecheck        # tsc --noEmit
TYPECHECK_PASS   (exit 0)

$ pnpm lint             # eslint src test
LINT_PASS        (exit 0)

$ pnpm test             # jest unit
Test Suites: 15 passed, 15 total
Tests:       131 passed, 131 total

$ pnpm test:int         # jest --runInBand --testRegex \.int-spec\.ts$
Test Suites: 19 passed, 19 total
Tests:       400 passed, 400 total
```

### Mutation-check (xác nhận test mới load-bearing — code sản phẩm đã revert ngay sau)
Mỗi mutation chạy `refresh-token.int-spec` rồi kiểm exit code (RED = suite fail):

| Mutation (tạm thời, đã revert) | Test kỳ vọng RED | Kết quả |
|---|---|---|
| Bỏ SWEEP (revoke family lần 2) ở `resetPassword` | DEBT-057 SWEEP race | RESULT_FAIL ✅ |
| Bỏ CẢ hai revoke family ở `resetPassword` | DEBT-056 (tombstone expiry) | RESULT_FAIL ✅ |
| Bỏ best-effort revoke ở catch re-check `token.controller.ts` | DEBT-058 | RESULT_FAIL ✅ |

Sau mỗi mutation đã khôi phục nguyên trạng; `grep -rn 'MUTATION-TEST' be/src be/test` ⇒ no markers left;
`git diff` của 2 file chỉ còn đúng thay đổi dev run 18.

Ghi chú: bỏ RIÊNG pre-revoke (giữ SWEEP) KHÔNG làm test nào RED — vì SWEEP dùng
`revokeAllForUser(userId)` là siêu tập của pre-revoke cho case "family tồn tại trước reset". Pre-revoke
chỉ load-bearing cho interleaving "login chen giữa sau setPassword", đã có unit `invocationCallOrder`
bắt thứ tự gọi (mutation M4 lượt 1: 3 unit RED). DEBT-057 (race SWEEP thật) nay đóng bằng int race.

## Test FAIL
Không có.

## Coverage acceptance criteria (tasks.md + tech-lead fold)

| AC | Test | PASS/FAIL |
|---|---|---|
| T1 reset: refresh cũ ⇒ 400 invalid_grant, family revoked, audit 1× | refresh-token.int: "after resetPassword the old refresh token is invalid_grant and the family is revoked" | PASS |
| T1 reset: AT cũ (sid) inactive, vẫn inactive | refresh-token.int: "the old access token (sid=session) is inactive after reset and stays inactive" | PASS |
| T1 reset: thứ tự revoke family→session→family→audit; fail-closed | authentication.service.spec (unit invocationCallOrder) | PASS |
| **DEBT-056**: AT/refresh cũ vẫn vô hiệu SAU khi tombstone sess_end hết TTL (del key, không sleep) | refresh-token.int: "after the sess_end tombstone expires, the old refresh is STILL invalid_grant (family revoked, not tombstone-gated)" (MỚI) | PASS |
| T2 TOCTOU: logout chen sau insert family ⇒ invalid_grant, family revoked, audit TOKEN_REVOKED session_ended 1× | refresh-token.int: "logout slipping in AFTER the family insert ⇒ invalid_grant ... (TOCTOU)" | PASS |
| T2: session còn sống ⇒ 200 + token (no regression) | refresh-token.int: "session still live ⇒ 200 + token (no regression)" | PASS |
| T2: Redis lỗi re-check ⇒ 500, không token | refresh-token.int: "Redis error on the post-insert re-check ⇒ 500, no usable grant minted" | PASS |
| **DEBT-058**: Redis lỗi re-check ⇒ family vừa mint best-effort revoke (familyRevokedAt set) | refresh-token.int: "Redis error on the re-check ⇒ 500 AND the just-minted family is best-effort revoked" (MỚI) | PASS |
| T2: code grant non-refresh, session chết trong cửa sổ ⇒ invalid_grant, không AT/id | refresh-token.int: "non-refresh code grant ... ⇒ invalid_grant, no access/id token" | PASS |
| T2: idle-expire trong cửa sổ ⇒ family offline_access cũ KHÔNG bị revoke | refresh-token.int: "session merely idle-expires in the window ⇒ the OLD offline_access family ... is NOT revoked" | PASS |
| **DEBT-057**: race SWEEP thật ở reset (gate sessions.revokeAllForUser, /token chạy trọn trong cửa sổ) ⇒ family bị SWEEP revoke; RED nếu bỏ SWEEP | refresh-token.int: "a /token family inserted during the reset window is revoked by the SWEEP (dies RED without SWEEP)" (MỚI) | PASS |
| T3 re-login / prompt=login KHÔNG giết AT/refresh cũ; family offline_access sống, refresh rotate, AT active | session-reflection.int: "DEBT-052: re-login keeps the old offline_access family alive (refresh rotates, AT active)" | PASS |
| T3 absolute-expiry: no tombstone, không revoke family | session-reflection.int (DEBT-052 block) + refresh-token.int idle/absolute | PASS |
| T4 consent union: 2 grant đồng thời cùng key ⇒ union đủ cả 2 scope, count==1 | consent.int: "grant is idempotent/atomic: two concurrent grants ... union preserved (DEBT-027)" | PASS |
| T4 lọc allowedScopes: scope đã gỡ không carry-forward | consent.int: "grant intersects with allowedScopes ... never carries forward" | PASS |
| T4 chống field-path injection (scope \$grantedScopes không mở rộng grant) | consent.int: "grant requesting a scope outside allowedScopes is filtered out" | PASS |
| T4 grantedAt bất biến, updatedAt tiến | consent.int: "grantedAt is set on insert and never changed ... updatedAt advances" | PASS |
| DEBT-026: nhánh covered KHÔNG ghi key authz_ctx thừa | authorize.int: "already-covered consent => GET /authorize skips the screen and 302s a code immediately" (snapshot authz_ctx count) | PASS |
| T5 DEBT-028: syncAllIndexes DROP index cũ {userId,clientId}, build {userId,clientId,resource} | indexes.int: "syncAllIndexes drops the old {userId,clientId} unique index and builds {userId,clientId,resource}" | PASS |
| logout (local + global) giết AT/refresh | refresh-token.int B4.7 revokeWhere/sessionRef + ui/ui-auth int | PASS |

## Coverage security invariants / risk matrix

| Invariant / chiều rủi ro | Test | PASS/FAIL |
|---|---|---|
| INV-11 (stamp familyRevokedAt trước revoke; cửa revoke duy nhất revokeWhere) | refresh-token.int ordering (revokeAllForUser / revokeForSession) + race tất định | PASS |
| INV-28 (AT sid phiên đã huỷ ⇒ inactive) | refresh-token.int AT inactive + DEBT-056 (vẫn đúng sau tombstone hết) | PASS |
| INV-29 (phiên huỷ trong race với insert family ⇒ family revoke ngay) | refresh-token.int TOCTOU + non-refresh + DEBT-057 SWEEP | PASS |
| INV-24 (owner consent = session.userId, không lấy từ input) | consent.int union/intersect (owner cố định) | PASS |
| State: fresh / stale / already-consumed / concurrent | reset token consume one-time + rotation reuse + consent concurrent race ×20 | PASS |
| Dependency: Redis timeout/unavailable ở re-check ⇒ fail-closed 500 + best-effort revoke | DEBT-058 (MỚI) + Redis-error re-check hiện có | PASS |
| Request chain: Set tombstone rồi request kế; tombstone hết TTL rồi request kế | DEBT-056 (del sess_end rồi rotate ⇒ invalid_grant) | PASS |
| Exposure: response/audit không lộ familyId / sessionRef / token | TOCTOU audit metadata assert (familyId/sessionRef undefined) | PASS |
| Authorization negative actor: cross-client refresh / cross-user revoke | refresh-token.int cross-client + revokeAllForUser never another user | PASS |
| Replay / concurrency atomic (consent upsert, refresh rotation, reset) | race tất định gateInsert / gateInsertBeforeAndFirstUpdate + consent ×20 | PASS |

## Kết luận
**PASS.** 531/531 xanh. Khe senior lượt 2 đã lấp: **DEBT-056, DEBT-057, DEBT-058 đóng** — mỗi test đã
chứng minh load-bearing bằng mutation có kiểm chứng RED, product code revert nguyên trạng. Code sản
phẩm KHÔNG đổi. Các khe còn lại DEBT-059 (B7) / DEBT-060 (run kế) / DEBT-061 (deploy M4) / DEBT-062
(gộp DEBT-053) ngoài phạm vi run này — giữ mở.
