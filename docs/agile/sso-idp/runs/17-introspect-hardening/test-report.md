# Test Report — 2026-10-12 — run 17 introspect-hardening

## Kết quả: **PASS** (506/506 test)

- typecheck `tsc --noEmit` → **0 lỗi**
- lint `eslint src test` → **0 lỗi / 0 warning**
- `pnpm test` (unit) → **127/127** (15 suites)
- `pnpm test:int` → **379/379** (19 suites) — baseline 376 + **3 test QA bổ sung** (suite `session-reflection.int-spec`)
- Tổng: **506/506** (unit 127 + int 379).

Không FAIL. Không sửa code sản phẩm (chỉ thêm test vào `be/test/session-reflection.int-spec.ts`).

---

## Lệnh đã chạy + output thực tế

Shell = Git Bash qua PowerShell wrapper. Container hạ tầng: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (đã `Up`).

```text
$ pnpm typecheck        # tsc --noEmit
TYPECHECK_EXIT=0

$ pnpm lint             # eslint src test   (sau khi thêm test)
LINT=0

$ pnpm test             # jest unit (CI=true FORCE_COLOR=0)
Test Suites: 15 passed, 15 total
Tests:       127 passed, 127 total
Time:        15.431 s

$ pnpm test:int         # jest --runInBand --testRegex \.int-spec\.ts$  (CI reporter)
Test Suites: 19 passed, 19 total
Tests:       379 passed, 379 total
Time:        70.017 s
Ran all test suites.

# suite session-reflection riêng, --verbose (xác nhận 3 test QA mới chạy & pass):
Tests:       8 passed, 8 total        # (5 baseline + 3 QA)
```

### Lưu ý flakiness hạ tầng (quan trọng cho orchestrator)

Lượt chạy `pnpm test:int` ĐẦU TIÊN (reporter tương tác mặc định) báo *transient*
`3 suites failed / 15 tests failed` **và** "Jest did not exit one second after the test run
has completed" (open handles treo tiến trình ~nhiều phút). Chạy lại ngay với reporter CI
(`CI=true FORCE_COLOR=0`) trên cùng container → **376/376 xanh**, rồi **379/379** sau khi thêm
test. Kết luận: 15 fail kia là **nhiễu môi trường** (state DB cũ còn sót + treo open-handle),
KHÔNG phải regression. Dù vậy đây là mùi flake có thật:
→ ghi **DEBT-054** (int suite có open handles làm treo + nhiễu cross-run). Không chặn run 17.

---

## Test QA bổ sung (3, trong `session-reflection.int-spec.ts` — Redis+Mongo thật)

1. **QA (a)** — `an access token minted from a refresh rotation carries sid === the family sessionRef`.
   Lấp chỗ thiếu: baseline chỉ assert `sessionRef` trên **doc RefreshToken**, chưa assert **claim `sid`**
   của AT sau rotate ở mức endpoint. Test: code-grant AT có `sid===ref` → rotate refresh → AT mới vẫn
   `sid===ref` (không undefined, không đổi) → introspect `active:true`.
2. **QA (f)** — `a legacy access token WITHOUT sid stays active + userinfo 200 even AFTER that user is logged out`.
   Mint `at+jwt` KHÔNG `sid` qua `TokenSigner` thật (dạng family pre-B4.7) → `revokeAllForUser`
   (ghi tombstone) → AT mang `sid` chết (control `active:false`), nhưng AT **không `sid`** vẫn
   `active:true` + userinfo 200. Chứng minh tombstone KHÔNG over-block token legacy (Q-C, acceptance (f)
   "kể cả sau logout").
3. **QA** — `/introspect never surfaces the session identifier (sid) in the response body`.
   e2e thật (không mock): body `active:true` không có khoá `sid`, và chuỗi JSON không chứa `sessionRef`
   (exposure budget — `sid` là định danh phiên nội bộ).

---

## Coverage acceptance criteria → test

### Task 1 — DEBT-040/041 (authz caller TRƯỚC liveness ở /introspect)
- [x] Caller không-phận-sự → `{active:false}`, KHÔNG chạm DB (spy theo đối số) — `introspect.int-spec` L260 "DEBT-040: unrelated caller rejected BEFORE any content-dependent lookup (spy proof)".
- [x] DEBT-041: caller=`TOKEN_CLIENT`, `aud` không còn allowed → `{active:false}` vì liveness-aud — L323; đối chứng `aud` hợp lệ cùng caller → `{active:true}` — L334.
- [x] Caller là client token / RS giữ `aud` → `{active:true}` (không hồi quy) — L229, L244.
- [x] Caller không-phận-sự KHÔNG kích `isEnded` kể cả token mang `sid` — L566 "DEBT-040+037".

### Task 2 — DEBT-037 (sid + introspect/userinfo phản ánh logout tức thời)
- [x] (a) AT code-grant `sid===sessionRef` lưu trên RefreshToken cùng request — `token.int-spec` L737.
- [x] (a) AT sau rotate mang cùng `sid` family — **QA (a)** (mới) + `refresh-token.int-spec` bind/inherit `sessionRef` trên doc.
- [x] (b) Local logout → AT(A) introspect `{active:false}` + userinfo 401; AT(B) `{active:true}`/200 — `session-reflection` L204.
- [x] (b) Global logout → cả hai inactive — `session-reflection` L218. Reset pw / `revokeByDevice` phủ qua tombstone (cùng đường `revokeRef`/Lua).
- [x] (c) Idle-expire (xoá `sess:{ref}` trực tiếp, KHÔNG revoke) → AT vẫn `active:true` + userinfo 200; `isEnded`=false — `session-reflection` L227.
- [x] (d) Logout rồi dùng AT mint từ refresh TRƯỚC logout (cùng `sid`) → inactive — `session-reflection` L235.
- [x] (e) TTL `sess_end:{ref}` ∈ (accessTTL, accessTTL+60s] — `session-reflection` L254.
- [x] (f) Token legacy không `sid` → hành vi cũ, **kể cả sau logout** — **QA (f)** (mới, e2e) + `introspect` L529 / `userinfo` L402 (stub).
- [x] (g) `sid` sai dạng → `{active:false}`, Redis KHÔNG gọi (spy) — `introspect` L538; `sid` kiểu số → verifier throw → `{active:false}` — `introspect` L547; userinfo tương ứng L408/L415.
- [x] (h) Redis lỗi trong `isEnded` → introspect **500** — `introspect` L556; userinfo **500 (không 401/200)** — `userinfo` L421.
- [x] (i) Caller không-phận-sự → `isEnded` 0 lần — `introspect` L566.
- [x] `sid` KHÔNG xuất hiện trong body /introspect — `introspect` L516 (stub) + **QA** (mới, e2e, cả JSON string).

### Task 3 — DEBT-043 (logout vô hiệu authorization code trong /token)
- [x] Global logout session → `/token` đổi code → `invalid_grant`, không mint — `token.int-spec` L752.
- [x] Idle-expire (`sess` mất, không qua revoke) trước đổi code → `invalid_grant` — L768.
- [x] Code không `sessionRef` → `invalid_grant` (fail-closed, theo fold) — L778.
- [x] Session còn sống → code vẫn đổi được (không hồi quy) — L785; refresh-path không bị ảnh hưởng — toàn bộ `refresh-token.int-spec` xanh (379/379).

### Task 4 — DEBT-045/046 (lint phủ test, nit)
- [x] `pnpm lint` = `eslint src test` → exit 0, 0 lỗi/0 warning.
- [x] `pnpm typecheck` xanh.
- [x] DEBT-044 HOÃN (ID token không thêm `sid` run này) — không test; không quảng bá `frontchannel_logout_session_supported` (discovery suite xanh).
- [x] DEBT-046 không đổi public behavior — regression 506/506 xanh.

### Cập nhật spec (tech-lead fold)
- [x] §8/§9.8/§11/§14/§15 (inv 28,29) khớp hành vi đã test (senior đã xác nhận văn bản; QA đối chiếu hành vi: tombstone chủ động → inactive, idle-expire → không chặn, code sau logout → invalid_grant).

---

## Coverage security invariants / risk matrix

| Chiều | Case đã kiểm | Test |
|---|---|---|
| Authorization | caller owner/RS/non-owner/cross-client | introspect L229/244/252/260/566 |
| Credential | absent/bad secret/post vs basic | introspect L208/221/418 |
| Input | `sid` valid / malformed / non-string / absent | introspect L505–547; userinfo L384–415 |
| State | fresh / ended(tombstone) / idle-expired / replay-after-rotate | session-reflection L204–251; QA (a)/(f) |
| Dependency | Redis `isEnded` lỗi → 500 (introspect + userinfo) | introspect L556; userinfo L421 |
| Request chain | code → logout → /token (invalid_grant); refresh → rotate → sid kế thừa | token L752; QA (a) |
| Exposure | `sid` không vào body /introspect (stub + e2e JSON) | introspect L516; QA |

- **Fail-closed**: lỗi Redis/DB → 500, KHÔNG bao giờ `active:true`/200 — xác nhận (introspect+userinfo).
- **Không over-block / không over-revoke**: local logout chỉ giết đúng session (B unaffected); idle-expire & token legacy giữ nguyên hiệu lực — xác nhận bằng test THẬT.
- **Exposure**: `sid` (=sessionRef) không rò ra body introspect/URL; là định danh một chiều, không phải capability — xác nhận.

Không phát hiện bypass / cross-tenant / replay / rò secret chưa có bằng chứng ⇒ không có FAIL ẩn.

---

## Kết luận

**PASS — 506/506.** Cổng tester PASS. Thêm 3 test QA (acceptance (a)-refresh, (f)-baseline-sau-logout, sid-exposure e2e) lấp các chỗ chỉ được chứng minh gián tiếp. Đề nghị bàn giao orchestrator đóng run. Ghi **DEBT-054** (int suite open-handle treo + nhiễu cross-run; không chặn).
n