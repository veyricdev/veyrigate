# Test Report — 2026-10-19 (run 32, B5.1 + B5.2 federation)

## Kết quả: PASS (BE unit 303/303, BE int 780/780, FE 240/240, E2E 12/12)

Không có lỗi [BE]. DEBT-189 được xác nhận bằng test thật và **chấp nhận ở mức 🟡** (lý do ở mục Coverage security). Mở thêm DEBT-191 (🟡, defence in depth).

## Lệnh đã chạy + output thực tế

Hạ tầng: `vg-test-mongo`@27117 và `vg-test-redis`@6479 đã chạy sẵn. Không `compose up`, không FLUSH/drop `aegate-*`, không gọi Google/GitHub thật (mock `node:http` @127.0.0.1 qua `overrideProvider(FEDERATION_PROVIDERS)`).

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit`, sạch (chạy lại sau khi thêm test) |
| 2 | `pnpm -C be lint` | `eslint src test`, sạch, exit 0 |
| 3 | `pnpm -C be test:int -- federation` (lần 1, sau khi thêm test tester) | `Tests: 1 failed, 48 passed, 49 total`. Case lỗi là **lỗi của test**: mock `signGoogle` luôn gọi `.setExpirationTime(now+300)` nên claim `exp` truyền vào bị ghi đè. Đã bỏ case `exp` khỏi test int; `exp` đã có unit `federation.client.spec.ts` "expired (beyond 60s skew)" |
| 4 | `pnpm -C be test:int -- federation` (lần 2) | `Tests: 49 passed, 49 total` (31 của dev + 18 của tester) |
| 5 | `pnpm -C be test` | `Test Suites: 25 passed, 25 total`, `Tests: 303 passed, 303 total` |
| 6 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)`, `Tests 240 passed (240)` |
| 7 | `pnpm -C be test:int` (toàn bộ) | `Test Suites: 35 passed, 35 total`, `Tests: 780 passed, 780 total` (762 của dev + 18 mới) |
| 8 | `pnpm -C e2e e2e` (1 lần; :5173 và :4000 trống trước khi chạy, không phải kill gì) | `12 passed (46.7s)`; sau khi chạy :5173/:4000 đã được giải phóng |

### Mutation (tester, bổ sung cho F15 của dev)

Sao lưu bằng `cp` vào scratchpad, khôi phục bằng `cp`, rồi `sha256sum -c` cho kết quả `OK` cho cả 2 file. Không dùng git checkout/restore.

| Mutant | Lệnh | Kết quả |
|---|---|---|
| M1 `provider-http.ts`: `redirect: 'error'` thành `'follow'` | jest `test/federation.int-spec.ts -t "3xx"` | **RED**: 2 failed (cả 2 test 3xx) |
| M2 `federation-state.store.ts`: consume không atomic (GET, chờ 5 ms, rồi DEL) | jest `-t "concurrent callbacks\|replayed state"` | **RED**: 1 failed (concurrent replay), 2 passed (replay tuần tự không bắt được, đúng như dự đoán) |

sha256 sau khôi phục: `provider-http.ts 7058ec56…c8280`, `federation-state.store.ts f0ba0815…c1ae6`, cả hai `OK`.

## Test FAIL

Không còn test FAIL. Lần chạy #3 lỗi do test viết sai, đã sửa test chứ không sửa code sản phẩm.

## Test tester đã thêm

File `be/test/federation.int-spec.ts`, describe `tester risk matrix (run 32)`, 18 test. Mock thêm hook `mock.raw` (ghi đè response thô theo path) và `mock.hits` (ghi lại các path đã bị gọi); cả hai được reset trong `afterEach`.

1. 6 callback song song cùng state+code ⇒ đúng 1 phiên (302), 5 cái còn lại 400 không session, 1 FI.
2. `state` bị lặp trong query (mảng) ⇒ 400.
3. Cookie `idp_fed` của trình duyệt/tab khác (đang có leg sống) ⇒ 400, 0 FI.
4. `error` + `code` cùng lúc ⇒ trang denied, không session; `error` dùng state đã tiêu ⇒ 400 (không có link quay lại).
5. Token endpoint trả 302 ⇒ 502, đích redirect không bao giờ bị gọi.
6. GitHub `/user` trả 307 ⇒ 502, đích không bị gọi, 0 FI.
7. Token response 8 MB không phải JSON ⇒ 502, không echo body.
8. GitHub `/user/emails` trả object ⇒ 502; trả `[]` ⇒ 400; 0 FI.
9. JWKS Google lỗi (không phải timeout) ⇒ fail-closed (400), không session, không user.
10. ID token với nonce của kẻ tấn công, hoặc `iss` giả dạng `accounts.google.com.evil.example`, qua callback đầy đủ ⇒ 400, không tạo gì.
11. Email trùng không phân biệt hoa thường, kể cả tài khoản local **chưa verify** ⇒ 409, không link, không tạo.
12. Cùng id số ở Google (`sub`) và GitHub (`id`) ⇒ 2 tài khoản riêng. GitHub với email trùng user được tạo từ Google ⇒ 409 (không auto-link chéo provider).
13. FI còn nhưng user đã bị xoá ⇒ 400, không tạo lại user.
14. Khoá brute-force (`lockedUntil` +10 phút) ⇒ 403, không session.
15. Redis state store ném lỗi ⇒ 500 trang first-party, không session, không redirect, không lộ thông điệp.
16. Tra FI trên Mongo ném lỗi ⇒ 500, không session, không user (lỗi không bị che thành guest/success).
17. `max_age=0` khi CÓ session IdP ⇒ Google nhận `max_age=0`, `auth_time` cũ bị từ chối, GitHub start bị từ chối.
18. **DEBT-189** (test đặc tả hành vi hiện tại): `max_age=60` và `max_age=0` khi KHÔNG có session IdP ⇒ URL Google không có `max_age`, ID token Google có `auth_time` cách đây 30 ngày vẫn được nhận, ID token phát cho RP có `auth_time ≈ now`, `amr:['fed']`. Khi sửa DEBT-189, test này sẽ RED và phải đảo kỳ vọng.

## Coverage acceptance criteria

- [x] T1: thiếu env ⇒ provider tắt; nửa cặp ⇒ boot lỗi: unit `static registry`, `validation.schema.spec` (dev); int `enabled providers`.
- [x] T1: GitHub email chưa verified / không primary / không có ⇒ không dùng: int `it.each` (dev) + tester #8.
- [x] T1: Google ID token sai iss/aud/nonce/chữ ký/HS256/hết hạn/thiếu nonce ⇒ từ chối: unit (dev); int aud (dev) + tester #10.
- [x] T1: không có code path nhận URL provider từ input: unit static check (dev); tester #5, #6 (không follow redirect).
- [x] T1: secret không log: int `exposure (F9)` (dev).
- [x] T2: luồng đầy đủ RP → … → /token, `state` RP (`rp-state/with+odd=chars&x`) nguyên vẹn, `sub` = User._id: int `full flow` (dev).
- [x] T2: state sai / lặp / hết hạn / cross-provider ⇒ từ chối: int (dev) + tester #1, #2.
- [x] T2: thiếu/sai cookie `idp_fed` ⇒ từ chối: int (dev) + tester #3.
- [x] T2: context hết hạn ⇒ lỗi an toàn: int `context expired` (dev); start với request_id lạ/kind consent ⇒ 400 (dev).
- [x] T2: provider trả `error` ⇒ lỗi an toàn: int access_denied (dev) + tester #4.
- [x] T2: email trùng local ⇒ không link/không tạo: int (dev) + tester #11, #12.
- [x] T2: mutation ⇒ RED: dev F15 5/5 + tester M1, M2.
- [x] T3: index `{userId:1}` + unique `(provider, providerId)`: `indexes.int-spec` (int toàn bộ PASS); race E11000 ×10 (dev).
- [x] T4: provider tắt ⇒ không nút; bật ⇒ nút đúng URL; CSP không đổi: int `enabled providers`, `full flow` (dev).
- [x] F10 `amr`: `['fed']` sau federation, `['pwd']` sau login local (dev); tester #18 (`amr:['fed']`).

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | user mới, user đã link, user bị xoá (FI mồ côi), user local cùng email (đã/chưa verify) | full flow, second login, tester #11, #12, #13 |
| Credential (state / cookie / ID token) | thiếu, sai, hết hạn, đã dùng, replay song song, mảng, cookie của trình duyệt khác; ID token sai aud/iss/nonce/chữ ký/alg | dev F14 + tester #1, #2, #3, #10; unit |
| Authorization | provider tắt / tên lạ (`__proto__`, `constructor`) ⇒ 404; user bị khoá (admin, brute-force) ⇒ 403; không auto-link (kể cả chéo provider) | dev + tester #12, #14 |
| Input | `error`+`code`, query lặp, `iss` giả dạng, body 8 MB, emails sai kiểu | tester #2, #4, #7, #8, #10 |
| State | state tươi / đã tiêu / hết hạn / cùng lúc ×6; context đã tiêu; race tạo user ×10 ×2 | dev + tester #1 |
| Dependency | token 500 / timeout / 200+error / 3xx; GitHub API 3xx; JWKS lỗi; Redis lỗi; Mongo lỗi ⇒ fail-closed, không bị che thành success/guest | dev + tester #5, #6, #9, #15, #16 |
| Request chain | start → provider → callback → `/authorize` resume → consent → `/token`; `Set-Cookie` session mới, session cũ bị revoke (fixation) | full flow (dev) |
| Exposure | log, audit, trang lỗi không chứa secret/code/token; body provider và thông điệp lỗi hạ tầng không bị echo | exposure (dev) + tester #7, #15, #16 |
| Re-auth | `prompt=login` (Google `max_age=0` + `auth_time`, GitHub chặn); `max_age=0` khi có session; `max_age` khi không có session (DEBT-189) | dev F8 + tester #17, #18 |

### Đánh giá DEBT-189: chấp nhận 🟡, không gán [BE] FAIL

Test #18 xác nhận lỗ là thật. Khi người dùng chưa có session IdP, `max_age=N` (kể cả `max_age=0` đứng riêng, không kèm `prompt=login`) không được chuyển sang Google. Một phiên Google 30 ngày tuổi vẫn qua được, và ID token phát cho RP ghi `auth_time ≈ now`.

Lý do chấp nhận:
- **Cơ chế step-up của hệ thống không bị vượt.** fe-admin và gợi ý trong `403 step_up_required` (B6.2/A5) đều dùng `prompt=login&max_age=0`. Nhánh này đặt `reauthAfter`, ép Google `max_age=0` và kiểm `auth_time` (dev F8 + tester #17). Khi đã có session IdP, `max_age` cũng ép re-auth (#17).
- **Điều kiện khai thác hẹp.** Kẻ tấn công phải đang nắm một phiên Google còn sống trên trình duyệt của nạn nhân, và session IdP phải đã hết hạn. Khi đó hắn vốn đã đăng nhập được qua social login bình thường. Lỗ này chỉ làm sai độ "mới" của `auth_time` mà RP thấy với RP chỉ gửi `max_age`.
- **Không thuộc nhóm phải FAIL.** Không có cross-tenant, không replay, không rò secret, không mất dữ liệu. Không vượt invariant INV-26 như đã hiện thực (D3: `prompt=login` + `max_age`).

Điều kiện phải đóng: DEBT-189 có hạn **run 33 (B5.3)**, trước khi bất kỳ RP nào chỉ dựa vào `max_age` để step-up. Nếu có RP như vậy trước run 33, lỗ này nâng lên 🔴.

### Debt mới
- **DEBT-191** 🟡 [BE]: `providerFetchJson` không giới hạn kích thước body (tester #7: 8 MB vẫn được đọc hết vào bộ nhớ trước khi fail) và lỗi JWKS không phải timeout trả 400 `invalid_identity` thay vì 502 (tester #9). Cả hai vẫn fail-closed. Host provider là hằng nên rủi ro thấp; đây là defence in depth.
