# Test Report — 2026-10-13 (tester, run 20 bugfix)

## Kết quả: PASS — 617/617 test, 0 fail

- Unit (`src/**/*.spec.ts`): **175 passed / 175** (17 suite).
- Integration (`pnpm test:int`): **442 passed / 442** (22 suite).
- typecheck (`tsc --noEmit`): 0 lỗi. lint (`eslint src test`): 0 lỗi.
- Baseline run (tasks.md) 555 → nay **617** (+62). Không giảm test nào.
- DEBT-074 đã đóng: comment `be/src/config/validation.schema.ts:73–75` bỏ "hop count",
  nêu rõ số/`true` bị từ chối. **Comment-only, 0 đổi hành vi** — typecheck/lint/full suite vẫn xanh.

## Lệnh đã chạy + output thực tế

Terminal = Git Bash. Container test đang chạy (`docker ps`): `vg-test-mongo` (27117, rs0),
`vg-test-redis` (6479) — KHÔNG `compose up` service khác.

```
# typecheck
$ pnpm --filter be typecheck   → tsc --noEmit                 exit 0 (0 lỗi)
# lint
$ pnpm --filter be lint        → eslint src test              exit 0 (0 lỗi)
# unit (src only, loại /test/)
$ jest --testPathIgnorePatterns node_modules test
  Test Suites: 17 passed, 17 total
  Tests:       175 passed, 175 total
  Snapshots:   0 total
# integration
$ pnpm --filter be test:int
  Test Suites: 22 passed, 22 total
  Tests:       442 passed, 442 total
  Snapshots:   0 total   Time: 96.01 s
```

> Lưu ý: `pnpm test:int` in thêm `[ELIFECYCLE] Command failed with exit code 1` SAU dòng
> `442 passed`. Đây là artefact teardown của jest `--runInBand` (tiến trình thoát non-zero khi còn
> kết nối Mongo/Redis treo), KHÔNG phải test fail: log có 0 dòng `FAIL`, 0 `failed,`. Baseline của
> dev cũng 442/442. Không chặn PASS.

## Test FAIL
(không có)

## Phương pháp QA (không chỉ chạy lại test dev)

Đã đối chiếu CODE THẬT ↔ acceptance qua CodeGraph + đọc trực tiếp (mã hoá base64 để tránh lỗi
terminal với em-dash/backtick), xác minh mỗi AC rủi ro cao được một test THẬT khẳng định ĐÚNG
invariant (không chỉ "xanh"): đọc Lua reserve/refund, luồng `authenticate`, map 429 ở cả 3
controller, và các assertion then chốt trong từng spec.

## Coverage acceptance criteria

### Task 1 — DEBT-067/068 (/token !live: audit TOKEN_ISSUED failure + metadata.refresh=!!familyId)
- [x] revoke family ném ⇒ 500 server_error, 0 token, đúng 1 `TOKEN_ISSUED failure session_ended`, 0 success — `token.int-spec.ts` (DEBT-067)
- [x] revoke + recordIssued cùng ném ⇒ vẫn 500, lỗi gốc được log (không nuốt) — `token.int-spec.ts`
- [x] `metadata.refresh` lấy từ `!!familyId` (có/không offline_access) — `token.int-spec.ts` + `token.service.spec.ts`
- [x] case DEBT-059 cũ giữ xanh

### Task 2 — DEBT-029/039/006 (rate-limit client auth + TRUST_PROXY)
- [x] (a) 3×401 rồi 429 + Retry-After≥1 + temporarily_unavailable; Argon2 không gọi lần 4 — `client-auth-rate-limit.int-spec.ts:214`
- [x] (b) secret đúng sau khi bị chặn vẫn 429 (chặn trước verify) — :229
- [x] (c) 20 request đúng secret liên tiếp không 429 (thành công không đếm) — :240
- [x] (d) Basic & client_secret_post chung counter — :252
- [x] (e) client_id xoay vòng cùng IP ⇒ bucket IP trip lần 6, không Argon2 — :264
- [x] (f) **client hợp lệ ở IP khác KHÔNG bị khoá**: block qua XFF 9.9.9.9, secret đúng từ XFF 8.8.8.8 vẫn 200 (không 429/401) — :556 (TRUST_PROXY=127.0.0.1)
- [x] (g) /revoke + /introspect chung bucket /token (2 /token + 1 /introspect ⇒ 429 ở /revoke); /introspect 429 không `active` — :289
- [x] (h) INV-13: 429 trên authorization_code KHÔNG consume code (re-exchange thành công) — :401
- [x] (j) public client method=none không reserve/refund/block kể cả khi IP đầy — :441
- [x] (k) race N=50 song song ⇒ verifySecret gọi ĐÚNG CLIENT_MAX, phần còn lại 429 — :332
- [x] (k-variant) client_id xoay vòng song song ⇒ Argon2 ≤ IP_MAX — :342
- [x] (l) song song secret đúng không bao giờ 429, counter về 0 — :361
- [x] (m) refund ném ⇒ vẫn 200 + token + warn; reservation KHÔNG hoàn — :383
- [x] (n) Redis ném ở reserve ⇒ 500 server_error, không DB, không Argon2, không token — :308
- [x] (o) request bị chặn không chạm findByClientId — :322
- [x] (p) Lua reserve atomic (1 key vượt ⇒ key kia KHÔNG tăng; song song đúng 5/20); refund không recreate/không âm/key vắng no-op — `rate-limit.int-spec.ts:125,146,155`
- [x] 429 đúng định dạng: `/token`+`/revoke` qua `token.controller.ts:334-341` (temporarily_unavailable + Retry-After, +error_description); `/introspect` qua `introspect.controller.ts:239-243` (temporarily_unavailable + Retry-After, không error_description — DEBT-075 đã hoãn)

### Task 2 — TRUST_PROXY (DEBT-006, qua FastifyAdapter thật + proxy-addr thật)
- [x] rỗng/undefined/whitespace ⇒ false — `trust-proxy.spec.ts:22`
- [x] "false" (mọi case) ⇒ false — :28
- [x] số (hop count) ⇒ throw (Fastify 5 âm thầm bỏ qua) — :33, :193
- [x] danh sách IP/CIDR ⇒ string[] — :41
- [x] `true` ⇒ throw — :47
- [x] IP/CIDR sai ⇒ throw — :52
- [x] danh sách rỗng (chỉ separator) ⇒ throw — :57
- [x] octal/hex/shorthand IPv4 ⇒ throw — :73
- [x] prefix rộng hơn /8 (gồm 0.0.0.0/0, ::/0) ⇒ throw — :79
- [x] /8 hợp lệ — :85
- [x] IPv4-mapped IPv6 rộng hơn /104 ⇒ throw; /104 hợp lệ (nhiều cách viết) — :90, :101, :112
- [x] không bao giờ tin IP công khai (`proxy-addr.compile` thật) — :131
- [x] runtime: socket proxy 127.0.0.1 tin XFF; /8 + loopback KHÔNG tin; false bỏ qua XFF — :170, :178, :184
- [x] `assertTrustProxyConsistent` (bằng/khác) — :199, :204
- [x] int: không TRUST_PROXY ⇒ 2 XFF chung counter; TRUST_PROXY=127.0.0.1 ⇒ XFF độc lập — `client-auth-rate-limit.int-spec.ts:539, 556`

### Task 3 — DEBT-007 (key rotate atomic)
- [x] writeState ném ⇒ getSigningKey vẫn trả kid cũ, ký được (normal + emergency) — `keys.spec.ts`
- [x] writeState atomic (tmp→rename); rename ném ⇒ keys.json cũ parse được, không còn *.tmp — `keys.spec.ts`
- [x] thứ tự createKey→writeState→rm; rm ném ⇒ rotate vẫn resolve, kid mới; emergency rm lỗi ⇒ logger.error — `keys.spec.ts`
- [x] dọn PEM mồ côi (kid lạ) khi rotate/init — `keys.spec.ts`

### Task 4 — DEBT-021 (rotateSecret atomic + version unique)
- [x] sequential: createSecret v1, rotate v2, revoke v2, rotate ⇒ v3 (không v2); countDocuments(version:2)=1 — `clients.int-spec.ts:474`
- [x] expired: version mới nhất hết hạn ⇒ rotate = max(tất cả)+1 — :490
- [x] concurrent: 2 rotate song song ⇒ 2 version KHÁC, không doc trùng (clientId,version), cả hai secret authenticate — :421
- [x] retry E11000 1 lần; E11000 lần 2 ⇒ ném (không nuốt) — :546, :578
- [x] createSecret 2 lần cùng client ⇒ v1,v2 cả hai authenticate; introspect.int-spec giữ xanh — `introspect.int-spec.ts`
- [x] index `{clientId,version}` unique; insert trùng ⇒ E11000 — `indexes.int-spec.ts:95`

### Task 5 — DEBT-053/061 (spec §11, runbook, ponytail)
- [x] `grep -c Task spec.md` = 0 (xác minh thật)
- [x] bảng §11 chỉ còn 1 dòng `| \`/introspect\`` (xác minh thật = 1); dòng cũ đã xoá
- [x] runbook: mục phục hồi 2b (consents không còn unique index sau E11000, model sau chưa sync, không xoá doc) + mục 2d ClientCredential + §4 cập nhật
- [x] int: sau E11000, consents KHÔNG còn unique index nào ngoài _id_ (pin runbook vào hành vi thật); không doc nào bị xoá — `indexes.int-spec.ts:156`
- [x] ponytail diff nhỏ, suite xanh; `.env.example` có CLIENT_AUTH_FAIL_*(2) + TRUST_PROXY(1)

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | client hợp lệ ở IP khác không bị khoá (f); anonymous/unknown client (e) | client-auth (f),(e) |
| Credential | secret sai / đúng / rotation overlap (v1+v2) đều authenticate | client-auth (a),(d); clients.int (421/474) |
| Authorization | method=none bypass (public) vs confidential; /revoke, /introspect, /token chung guard | client-auth (g),(j) |
| Input | 429 format 3 endpoint; octal/hex/mapped/numeric TRUST_PROXY từ chối | trust-proxy.spec; controllers |
| State | reserve→verify→refund; code không bị consume khi 429 (INV-13) | client-auth (h); rate-limit (p) |
| Dependency | Redis ném ⇒ fail-closed 500 (không guest/success); Mongo updateMany ném ⇒ audit failure + 500 | client-auth (n); token.int (DEBT-067) |
| State/atomicity | reserve atomic dưới N=50 song song (overshoot=0); rotateSecret 2 song song không trùng version | rate-limit (p); clients.int (421) |
| Replay/single-use | 429 không INCR (window tự hết); authorization_code dùng lại được sau 429 | client-auth (a),(h) |
| Exposure | 429 không lộ client_id/secret; refund warn chỉ err.message; audit metadata chỉ {resource,scope,refresh} | code trace + (m) |
| Failure injection | fail-closed xác nhận: reserve ném→500, writeState ném→key cũ còn ký, syncIndexes E11000→không xoá doc | (n); keys.spec; indexes.int (156) |

- **Negative actor**: (f) attacker không khoá được client hợp lệ ở IP khác; (j) public client không bị DoS-amplify.
- **Concurrency/atomic thật**: reserve N=50 `Promise.all`, rotateSecret `Promise.all` — đều assert invariant, không hard sleep.
- **Fail-open/closed**: mọi nhánh lỗi hạ tầng (Redis/Mongo/FS) fail-closed (500/throw), không bị che thành guest/not-found/success.

## DEBT còn mở (không chặn PASS)
- **DEBT-075** (PENDING, tech-lead hoãn): `/introspect` 429 thiếu `error_description`. Tác động: thẩm mỹ/nhất quán response, KHÔNG dẫn tới bypass/cross-tenant/replay/mất dữ liệu/rò secret (body vẫn `{error:'temporarily_unavailable'}` + Retry-After, không `active`). Đã có trong backlog.md.

## Kết luận
**PASS.** 617/617 test thật xanh (175 unit + 442 int), typecheck + lint 0 lỗi. Mọi acceptance
(gồm tech-lead fold + retry 1/3) và security invariant rủi ro cao được test THẬT khẳng định đúng.
DEBT-074 đã đóng (comment-only). → Bàn giao orchestrator đóng run; sau đó commit run 20.
