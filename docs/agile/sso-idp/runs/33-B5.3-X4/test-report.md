# Test Report — 2026-10-19 — run 33 (B5.3 + DEBT-189 + X4)

## Kết quả: PASS

| Hạng mục | Kết quả |
|---|---|
| BE typecheck / lint | sạch / sạch |
| BE unit `pnpm -C be test` | 303/303 |
| BE int `pnpm -C be test:int` (có 5 test mới của tester) | **816/816 ×2 liên tiếp** |
| FE `pnpm -C fe-sso-test test` | 240/240 |
| E2E `pnpm -C e2e e2e` | **16/16 ×2 liên tiếp** (1.7m, 1.2m) |
| Test đỏ của senior (DEBT-199) | **Không phải hồi quy run 33.** Nguyên nhân: hai tiến trình `test:int` chạy đồng thời trên cùng `vg-test-redis`. Xem case 1 |

Không có lỗi gán [BE] hoặc [E2E]. Mở thêm 2 mục 🟡 [test]: DEBT-201 và DEBT-202.

## Case 1 — Ưu tiên 1: điều tra test int đỏ (DEBT-199 / DEBT-195)

**Phương pháp.** Tạo git worktree tạm ở scratchpad tại `ca38e20` (HEAD sạch). `node_modules` được nối bằng junction (dependency giống hệt nhau, `be/package.json` chỉ thêm script `start:e2e`). Chạy full int bằng lệnh jest của script `test:int` (`--runInBand --forceExit --globalSetup ./test/int-preflight.mjs --testRegex '\.int-spec\.ts$'`), luân phiên với working tree. Sau đó gỡ junction an toàn rồi chạy `git worktree remove`; `git worktree list` chỉ còn tree chính.

**Kết quả chạy TUẦN TỰ (mỗi thời điểm chỉ một tiến trình):**

| Lần | Cây | Tests | Đỏ |
|---|---|---|---|
| wt-1 | working tree | 811/811 | — |
| wt-2 | working tree | 811/811 | — |
| wt-3 | working tree | 811/811 | — |
| solo-1 | working tree | 811/811 | — |
| solo-2 | working tree | 810/811 | `indexes` › Consent M3→M4: "Exceeded timeout of 5000 ms" (= DEBT-195) |
| final-1, final-2 | working tree + test tester | 816/816, 816/816 | — |
| head-2 | HEAD `ca38e20` | 779/780 | `admin-target-risk` › seed re-point guard: "Exceeded timeout of 5000 ms" |
| head-solo-3 | HEAD `ca38e20` | 780/780 | — |

Kết luận phần tuần tự: test `client-auth-rate-limit` › "no TRUST_PROXY … share one counter" xanh ở **cả 7/7** lần chạy tuần tự của working tree. Đỏ chập chờn còn lại là timeout 5 s, và **HEAD cũng có** (DEBT-195 và DEBT-202).

**Kết quả chạy ĐỒNG THỜI (2 tiến trình `test:int` cùng lúc, cùng vg-test-mongo/redis):**

| Cặp | Tiến trình | Tests | Có test "share one counter" đỏ? |
|---|---|---|---|
| vô tình (vòng lặp cũ chưa dừng hẳn) | HEAD (head-1) ‖ working tree (wt-4) | 774/780 ‖ 808/811 | — (đỏ `(e)`, `(l)` cùng file client-auth) |
| cố ý 1 | working tree A ‖ working tree B | 754/811 ‖ 753/811 | Có ‖ Có |
| cố ý 2 | working tree A ‖ working tree B | 798/811 ‖ 798/811 | Có ‖ Có |

Thông điệp lỗi khi chạy đồng thời:
```
no TRUST_PROXY => two different X-Forwarded-For share one counter (XFF ignored)
    Expected: 401
    Received: 429
      > 549 |         expect(res.statusCode).toBe(401);
```

**Cơ chế.** Mọi int-spec dùng `app.inject`, nên socket IP luôn là `127.0.0.1`. Vì vậy mọi tiến trình dùng chung bucket `rl:client-auth:{sha256(127.0.0.1)}:ip` (IP_MAX=5) trên cùng `vg-test-redis`. `beforeEach` chỉ xoá key của chính nó. Tiến trình thứ hai cộng thêm lỗi vào bucket IP này (hoặc xoá `rl:*` trong afterAll) nên request thứ 1–3 đã bị 429. Mã run 33 không chạm `client-auth`, `rate-limit.service`, `trust-proxy` hay file test đó. `configureApp`/`bootstrap.ts` không được int-spec này dùng (spec tự dựng `FastifyAdapter`). Bucket `login` mà `/auth/link` dùng là key `rl:login:*`, khác `rl:client-auth:*`.

**Kết luận.** Test đỏ mà senior thấy là **flaky có sẵn từ trước, do chạy song song**, không phải hồi quy. Senior thấy đỏ 2/2 lần, khớp với kịch bản có một `test:int` khác (của agent khác) chạy cùng lúc. Bằng chứng: tuần tự 0 đỏ; đồng thời 4/4 tiến trình đỏ; HEAD đỏ y hệt khi chạy song song. DEBT-199 đã ghi nguyên nhân gốc. Mở **DEBT-201** (khoá chống chạy song song trong `int-preflight`) và **DEBT-202** (timeout 5 s, có từ HEAD).

## Case 2 — Test bổ sung của tester (`be/test/federation.int-spec.ts`, mục "account linking", T33-1…T33-5)

| Test | Rủi ro | Kết quả | Mutation |
|---|---|---|---|
| T33-1 max_age=60 + linking bằng password ⇒ code; ID token `auth_time` = thời điểm link | max_age + federation (link) | PASS | — |
| T33-2 login **local** max_age=60 không session ⇒ code (`auth_time` mới); session cũ 1 h ⇒ `/authorize` đẩy về `/login`; replay `request_id` bằng session cũ ⇒ RP nhận `error=login_required`, không code | max_age local (F1 không hồi quy local) | PASS | — |
| T33-3 bucket `login` THẬT (`rl:login:account:sha256(email)`) bị đầy ⇒ `POST /auth/link` 429 **và** `POST /login` cùng email 429; không FI, không tăng `failedLoginCount`; pending KHÔNG bị tiêu (sau đó link thành công) | brute-force password qua đường link | PASS | Bỏ `limit(req,'login',pending.email)` ⇒ **RED** |
| T33-4 một danh tính provider, 2 pending link (email đổi ở provider) ⇒ link đầu thắng; link thứ hai ⇒ 400 "signed in, but … not linked", session thuộc user A, đúng 1 FI (→ B), không có `ACCOUNT_LINKED` cho A | nhánh `DuplicateError`/`not_linked` | PASS | — |
| T33-5 trình duyệt đang có session của user khác (bị cài sẵn) ⇒ link xoay session: session cũ bị thu hồi, session mới thuộc target, không có FI cho user kia | session fixation | PASS | Không truyền `oldSessionId` ⇒ **RED** |

Mutation: sao lưu `federation.controller.ts`/`federation.service.ts` vào scratchpad, sửa bằng `sed`, khôi phục bằng `cp`; `sha256sum -c` báo OK cả hai. Không dùng git checkout/restore.

## Case 3 — E2E X4 (F20–F22)

- `pnpm -C e2e e2e` ×2: 16/16 mỗi lần. Gồm 4 kịch bản federation: user mới; email trùng ⇒ link ⇒ lần sau vào thẳng; state bị sửa/callback bị replay ⇒ trang lỗi first-party; sai password ở trang link.
- Log 2 lần chạy: `grep -cE 'code=|state=|id_token'` = 0 / 0. Log BE chỉ có path và mã cố định (`federation failed: invalid_state`, `federation link failed: credentials`).
- INV-23 / entry E2E không lọt `dist`: sau build, `grep -rlE "__E2E_MOCK_PROVIDER__|e2e-main|mock-google" be/dist` ⇒ rỗng. `assert-dist-clean.mjs` ⇒ exit 0. Probe âm: tạo `be/dist/zz-tester-probe.js` chứa marker ⇒ guard exit 1; xoá probe ⇒ exit 0.
- Không request nào ra ngoài localhost/127.0.0.1: spec dùng `page.on("request")` để kiểm và đều PASS. Không gọi Google/GitHub thật.
- Sau khi chạy: :4000/:5173 không còn listener, không còn tiến trình jest/playwright/e2e-main. Lần này :5173 trống nên không phải dừng vite tiptap.

## Lệnh đã chạy + output thực tế

```
pnpm -C be typecheck                 -> exit 0
pnpm -C be lint                      -> exit 0
pnpm -C be test                      -> Test Suites: 25 passed; Tests: 303 passed, 303 total
pnpm -C fe-sso-test test             -> Test Files 31 passed (31); Tests 240 passed (240)
pnpm -C be test:int  (lần 1)         -> Tests: 816 passed, 816 total (exit 0)
pnpm -C be test:int  (lần 2)         -> Tests: 816 passed, 816 total (exit 0)
pnpm -C e2e e2e      (lần 1)         -> 16 passed (1.7m) (exit 0)
pnpm -C e2e e2e      (lần 2)         -> 16 passed (1.2m) (exit 0)
jest -t "T33-" federation.int-spec   -> Tests: 5 passed
mutation M-a (bỏ login limiter)      -> Tests: 1 failed (T33-3)
mutation M-b (bỏ oldSessionId)       -> Tests: 1 failed (T33-5)
so sánh HEAD vs working tree         -> bảng ở case 1
```

## Test FAIL

Không có test nào FAIL thuộc phạm vi run 33. Đỏ chập chờn ở case 1 là lỗi hạ tầng test có từ trước (DEBT-195/199/201/202).

## Coverage acceptance criteria

- [x] T1 / DEBT-189 (F1–F4): int của dev (max_age không session, `auth_time` cũ ⇒ từ chối, mới ⇒ code, `auth_time` thật, skew/clamp, GitHub ⇒ `reauth_required`, admin step-up) + `authorize.int-spec` F1 + **T33-1, T33-2** (local và link).
- [x] T2 / B5.3 (F5–F14): (a)…(m), F11 byte-identical, F12, email-từ-form, Redis fail-closed, DEBT-186 + **T33-3, T33-4, T33-5**.
- [x] T4' (F15/F16): bù trừ `allSettled` giữ lỗi gốc, body 8 MB ⇒ 502 và đóng socket sớm, JWKS ECONNREFUSED ⇒ 502 (int của dev, xanh trong 816).
- [x] T3 / X4 (F17–F22): E2E ×2 xanh, không lộ code/state/token, dist sạch + probe guard âm, không request ra ngoài.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Identity | user khác cài session sẵn; user đích khác (email đổi) | T33-5; (j) |
| Credential | sai password; đúng password nhưng bị lock/chỉ-federated/chưa verify | (b)(c)(d)(e), F11 |
| Authorization | link vào user khác bằng email từ form | test "email never taken from the form" |
| Input | `_csrf` thiếu/sai; field thừa | (h), email-từ-form |
| State | replay, hết hạn, song song, 2 pending cho cùng danh tính | (f)(i)(m), **T33-4** |
| Dependency | Redis lỗi khi tạo pending; JWKS lỗi mạng; body quá trần | Redis fail-closed, F16 |
| Request chain | callback ⇒ `/auth/link` ⇒ POST ⇒ `/authorize` ⇒ `/token`; xoay session | (a), T33-1, T33-5 |
| Rate-limit | bucket `login` dùng chung `/login` ↔ `/auth/link`, 429 không tiêu pending | **T33-3** |
| Re-auth | max_age local/federation/link; prompt=login | T33-1, T33-2, (l), các test DEBT-189 |
| Exposure | log/URL/HTML/audit không có token/email/providerId; output E2E | F12, (a), case 3 |

## Debt mới

- **DEBT-201** 🟡 [test]: chặn `test:int` chạy song song (khoá Redis trong preflight) hoặc tách DB/prefix cho mỗi run.
- **DEBT-202** 🟡 [test]: timeout mặc định 5 s gây đỏ chập chờn khi máy tải (có từ HEAD).
- Cập nhật **DEBT-199**: đã có nguyên nhân gốc (chạy song song), không phải hồi quy.
