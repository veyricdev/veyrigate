# Test Report — 2026-10-12 — run 16 (B4.7 Logout: local/global + RP-initiated + front-channel)

> QA lượt 1 (sau senior PASS lượt 3). Nơi DUY NHẤT chứa output lệnh cho run này.
> Đã đối chiếu acceptance `tasks.md` (gồm *(tech-lead fold)*) với suite hiện có; bổ sung **4 test unit** QA cho 2 lỗ hổng coverage (fail-closed `verifyHint` khi client bị xoá; CSP-injection sink `frameSrcOrigins`). KHÔNG sửa code sản phẩm.

## Kết quả: **PASS** (473/473 test)

- Unit (`pnpm test`): **127 passed, 127 total** (15 suites) — baseline 123 **+4 QA**.
- Integration (`pnpm test:int`): **346 passed, 346 total** (18 suites) — không đổi (chỉ thêm unit).
- `pnpm typecheck` (tsc --noEmit): **OK** (exit 0).
- `pnpm lint` (eslint src): **OK** (exit 0) — đã sửa 1 lỗi prettier do test QA mới, lint lại sạch.
- Tổng = 127 + 346 = **473** (baseline run 16 = 469, QA +4).

## Lệnh đã chạy + output thực tế

```
# be/ (Git Bash), Mongo vg-test-mongo@27117 rs0 + Redis vg-test-redis@6479 (docker ps: Up)

$ pnpm typecheck    → $ tsc --noEmit                         EXIT 0 (không lỗi)
$ pnpm lint         → $ eslint src                           EXIT 0 (không lỗi)

$ pnpm test
  Test Suites: 15 passed, 15 total
  Tests:       127 passed, 127 total
  Snapshots:   0 total
  Ran all test suites.

$ pnpm test:int
  Test Suites: 18 passed, 18 total
  Tests:       346 passed, 346 total
  Snapshots:   0 total
  Ran all test suites.

# Trích riêng suite logout.service (sau khi thêm QA):
$ jest logout.service.spec
  Test Suites: 1 passed, 1 total
  Tests:       17 passed, 17 total   (baseline 13 + 4 QA)
```

(ERROR/WARN trong log unit là audit-alert giả-lập có chủ đích; các dòng `redis down: SECRET-detail`
trong int là test fail-closed xác nhận secret KHÔNG lộ ra response — đều thuộc test đã PASS.)

## Test FAIL
- Không có.

## Test QA bổ sung (file: `be/src/modules/oauth/logout/logout.service.spec.ts`)
1. `verifyHint` — trả `{clientId, sub}` khi hint verify + client còn tồn tại (happy, direct).
2. `verifyHint` — **null khi hint verify nhưng client đã bị xoá** (fail-closed; nhánh `if(!client) return null` trước đây chỉ test gián tiếp).
3. `verifyHint` — **null khi verify throw** (hint giả/hết-hạn-fail/rác) — swallow, không ném.
4. `frameSrcOrigins` — chỉ sinh origin an toàn cho directive CSP (scheme+host[:port], không `[;,\s]`); directive `frame-src` ghép đúng allowlist, không smuggling sau `;` (Task 4 invariant, injection sink).

## Coverage acceptance criteria → test

| # | Acceptance (tasks.md) | Test phủ | KQ |
|---|---|---|---|
| T2-a | **GET /logout KHÔNG huỷ session** (plan L196) | ui.int "authenticated GET logout renders confirmation without changing session state" (L456); "GET /logout renders hidden RP params ... without destroying session state" (L700) assert `sessions.revoke`/`revokeForSession` not called | PASS |
| T2-b | GET hint+URI exact-match → form chứa hidden `post_logout_redirect_uri` đã validate | ui.int L700 | PASS |
| T2-c | URI không khớp whitelist → KHÔNG xuất hiện trong form/redirect (no open-redirect) | ui.int "GET /logout does NOT reflect ... fail validation" (L733) | PASS |
| T2-d | `id_token_hint` sai chữ ký/iss → bỏ qua, không 500, không lộ lý do | logout.service.spec "falls back when the hint does not verify" (L88) + QA #3 | PASS |
| T2-e | Discovery `end_session_endpoint == {issuer}/logout` | discovery.int "advertises end_session_endpoint" (L157) + snapshot (L107) | PASS |
| T2-f | state >512 bỏ; state echo chỉ khi URI validated | logout.service.spec "drops a state longer than 512 chars" (L70), "appends capped encoded state" (L64) | PASS |
| T2-g | `Cache-Control: no-store` trên form | ui.int L700 assert `cache-control: no-store` | PASS |
| T3-a | POST local → session hiện tại chết; family theo sessionRef revoke; thiết bị khác SỐNG | ui.int "POST local logout revokes only this session family" (L751) + refresh-token.int "revokeForSession revokes only matching session family; other devices survive" (L963, real Mongo) | PASS |
| T3-b | POST `scope=all` → MỌI session + MỌI family của user; user khác không đụng | ui.int "POST ?scope=all revokes every session + family" (L778) + refresh-token.int "revokeAllForUser revokes every family ... but never another user" (L980, real) | PASS |
| T3-c | **CSRF trên POST bắt buộc** (plan L196): thiếu/sai → 403, không đổi state | ui.int "POST logout without CSRF fails closed" (L469), "with invalid CSRF" (L484), "cross-session CSRF replay" (L499) | PASS |
| T3-d | POST idempotent (gọi lần 2, session mất) → 302, không 500 | ui.int "POST logout retry is idempotent" (L646), "POST with no live session only clears cookie" (L1013) | PASS |
| T3-e | `post_logout_redirect_uri` validated → 302 đúng URI + state; không → `/login?loggedOut=1` | ui.int "POST redirects to resolved post-logout URI with state" (L915) | PASS |
| T3-f | **Open-redirect âm** POST: URI ngoài whitelist/hint giả → `/login?loggedOut=1`, Location không chứa URI lạ | ui.int "POST with a non-matching redirect falls back to default (no open redirect)" (L945) | PASS |
| T3-g | **Local = theo sessionRef**, family cùng client của session khác SỐNG | refresh-token.int "revokeForSession ... only the matching session family" (L963) + e2e (L1160) | PASS |
| T3-h | **Thứ tự** revoke token→session→audit→clear→redirect; lỗi bước nào → 5xx, không 302 success; retry idempotent | ui.int "fail-closed ordering: revokeForSession throws → 5xx" (L814), "sessions.revoke throws → 5xx" (L846) | PASS |
| T3-i | Audit local `SESSION_REVOKED`+`TOKEN_REVOKED`(count>0); global `scope:'all'` | ui.int L751 (TOKEN_REVOKED count:2), L778 (scope:all) | PASS |
| T2/T3 | `id_token_hint` hết hạn chấp nhận / access token bị từ chối / aud-sub lệch | keys.spec "verifyIdTokenHint": accepts EXPIRED (L271), rejects access token typ (L287), rejects wrong iss (L281), multi-aud (L293), non-RS256 (L299); logout.service.spec aud-sub lệch (L113, L120) | PASS |
| T4-a | Client có `frontchannel_logout_uri` → iframe đúng URI + `iss`, CSP cho phép origin đã đăng ký | ui.int "renders front-channel page with iframes + relaxed frame-src only on that response" (L965) | PASS |
| T4-b | Client KHÔNG đăng ký → không iframe, redirect thẳng | ui.int "no front-channel RP → redirects straight through" (L997) | PASS |
| T4-c | `frontchannel_logout_uri` chỉ HTTPS + exact-match, no wildcard; giá trị lạ bị từ chối lúc đăng ký | clients.int "accepts valid https frontchannelLogoutUri" (L136) + "rejects variant" (L155: non-https/wildcard/fragment/relative/CSP-inject semicolon) | PASS |
| T4-d | Back-channel: KHÔNG thêm endpoint/logic (no route `backchannel`) | Xác nhận code: không route `backchannel` (grep 0 kết quả trong controller/module); P2 đã ghi trong tasks/plan | PASS |
| T4-e | CSP chỉ nới `frame-src` ở trang trung gian; trang khác giữ CSP mặc định | ui.int L965 assert trang `/login` sau đó KHÔNG có `frame-src https://rp1` | PASS |
| T5-a | Audit metadata `scope:'all'`, `userId`, không token value | ui.int L778; refresh-token.int "revoke: audit/log never contains token value" (L782) | PASS |
| T5-b | `pnpm test` + `pnpm test:int` xanh, tổng > 405 | 473 > 405 | PASS |

## Coverage security invariants / risk matrix

| Chiều rủi ro | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | owner (logout chính mình); other user (global không đụng user khác) | ui.int L778; refresh-token.int L980 |
| Credential | CSRF absent / malformed / replayed (cross-session) | ui.int L469/L484/L499 |
| Credential (hint) | valid / **expired (chấp nhận)** / malformed-sig / wrong-iss / token-confusion (access token) / multi-aud | keys.spec L266–L299; QA #1–#3 |
| Authorization | non-owner redirect (hint sub ≠ session user) → default; client_id ≠ hint aud → default; cross-client URI → default | logout.service.spec L103/L113/L120 |
| Input/injection | open-redirect (URI ngoài whitelist) → default; **CSP directive-injection ở sink `frameSrcOrigins`** | ui.int L945, L733; **QA #4**; clients.int L155 (reject ở registration) |
| State | fresh (session live), stale/consumed (no session, idempotent retry) | ui.int L646/L1013 |
| Dependency | **client bị xoá** sau khi hint phát hành → fail-closed null (không redirect); Mongo/Redis fault giữa revoke → 5xx (fail-closed); fault sau revoke → fail-open default (user đã logout) | **QA #2**; ui.int L814/L846/L878/L897 |
| Request chain | sau `Set-Cookie Max-Age=0` (clear) → request kế anonymous; INV-17 không resurrect | ui.int clear-cookie asserts; sessions.int (SET XX) |
| Exposure | audit/redirect KHÔNG mang token value/hash; hint KHÔNG log; URI chưa validate KHÔNG vào response/CSP | refresh-token.int L782; ui.int L733; QA #4 |
| INV-11 (stamp-first) | race + ordering: descendant mint trong lúc revokeAllForUser / revokeForSession không sống sót; stamp `familyRevokedAt` trước `revokedAt` | refresh-token.int L1026/L1052/L1086/L1119 |

## Kết luận & bàn giao
- **PASS** — 473/473 (127 unit + 346 int), typecheck + lint (src) sạch. Mọi acceptance B4.7 (gồm tech-lead fold) + mọi chiều risk matrix áp dụng đều có ≥1 test và đều xanh. Không FAIL, không security debt mới.
- Ghi chú (không chặn): DEBT-045 (lint chưa phủ `test/`) đã có trong backlog; stray file rỗng `=1` ở gốc repo tồn tại từ trước phiên QA (0-byte, untracked) — ngoài phạm vi test, nên dev dọn trước khi commit.
- Bàn giao: **orchestrator** đóng run (cổng tester PASS). Code CHƯA commit.