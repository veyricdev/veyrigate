# Test Report — 2026-11-16 (run 89 T6, working tree on `de14146` + T0–T5 + D89.25–D89.30, uncommitted)

## Kết quả: PASS

E2E 52/52 ×2 (12,5 m và 14,2 m; 44 cũ + `totp.spec` 4 + `mfa.spec` 4), X3 42/42 (9,9 m), int FULL 89 suite 2393/2393 (`vg-int-*` 0 → 0), be unit 60 suite 1188/1188, fe-admin 69 file 1653/1653, typecheck be/e2e/fe-admin + lint be sạch, `assert-dist-clean` xanh (bước build của webServer E2E). Checklist: C-6.3.3 ❌ ⇒ ✅, C-6.4b N/A ⇒ ✅, C-6.5 N/A ⇒ ✅, C-6.3.4 thêm bằng chứng; A–D 202 dòng = 155 ✅ / 29 ⚠ / 1 ❌ / 17 N/A, P0 ❌ 0, ❌ còn lại: D-14.

Trong lúc gate, tester phát hiện 🔴 **DEBT-647** (sản phẩm): `/login/mfa` dùng CSP toàn cục `form-action 'self'` ⇒ Chromium chặn chuỗi POST `/login/mfa` → `/authorize` → 302 về RP ⇒ mọi đăng nhập admin qua TOTP treo (4/4 spec admin đỏ ở lượt nhắm đầu tiên). Đã báo orchestrator kèm bằng chứng, backend-dev sửa (D89.30) cùng DEBT-646 (câu bị chặn); mọi số ở trên là sau bản sửa.

## Lệnh đã chạy + output thực tế

Hạ tầng: chỉ `veyrigate-mongo` (27017 E2E/X3; 27117 int), `veyrigate-redis` (6379/2 E2E; 6479 int), `veyrigate-mailpit-1`. Không tạo container, không compose, không FLUSH. Cổng 3000/4000/5173/4100/8443 trống trước mỗi lượt (không kill gì). Log thô: scratchpad `t89/` (không commit).

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be typecheck` / `lint` / `test` (đầu run, trước bản sửa) | exit 0 / exit 0 / 1187/1188: `vault-transit-key-provider.spec.ts › V10 … within 2 × VAULT_TIMEOUT_MS + 500 ms` 1186 ms > 1100 (máy bận, senior đang review song song; code Vault không đổi; lượt cuối #10 xanh) |
| 2 | `pnpm -C e2e exec playwright test totp mfa fe-admin-risk fe-admin admin-api-risk` (nhắm, trước bản sửa) | admin-api-risk, fe-admin, fe-admin-risk ×2: timeout 30 s, trang đứng ở "Two-step verification" có mã; log BE `POST /login/mfa 302` → `GET /authorize 302` (về :3000) ⇒ **DEBT-647**. `mfa.spec` lỗi test (`otpauth` nhãn URL-encode `%3A`) ⇒ sửa test |
| 3 | int FULL #1 (trước bản sửa, `timeout 25m` + `--runInBand --testTimeout=60000 --forceExit`) | 87/89 suite, 2391/2393: 2 đỏ = ca RED của chính bản sửa đang làm (`run89-mfa-login › DEBT-647 …`, `run89-mfa-cap › … fixed text` cho DEBT-646), không phải hồi quy; `vg-int-*` 0 → 0 |
| 4 | E2E nhắm `totp` + `mfa` (enroll/federation, trước bản sửa) | 5/6; federation đỏ do test (link Google chỉ có ở login tiếp tục được từ RP) ⇒ viết lại bắt đầu từ fe-sso-test |
| 5 | `pnpm -C e2e e2e` (sau bản sửa, trước D89.21) | 50/52, **20,5 m**: `fe-admin.spec` timeout 30 s và `fe-admin-roles:88` timeout 120 s ⇒ thời gian chờ TOTP (lỗi test/ngân sách) ⇒ làm D89.21 + `test.setTimeout(90_000)` cho 4 test 30 s có đăng nhập IdP |
| 6 | `pnpm -C e2e e2e` (lượt bị cắt) | 10 ok rồi `Target crashed` + `worker process exited unexpectedly (code=3221225794)` ở 0 ms cho mọi test sau ⇒ tiến trình Claude Code thoát giữa chừng (môi trường), bỏ |
| 7 | `pnpm -C e2e e2e` cuối #1 | 51/52 (14,8 m): `account-self-service:171` "verification mail in Mailpit" timeout 30 s — Mailpit vừa khởi động lại sau khi máy bật (`Up 17 minutes`), BE log `Authentication email delivery failed` ở `/register` đầu tiên; mọi thư sau đều tới ⇒ môi trường, chạy thêm lượt |
| 8 | `pnpm -C e2e e2e` cuối #2 / #3 | **52 passed (12,5 m)** / **52 passed (14,2 m)**, exit 0; `totp allocator (worker …): 46 codes, waited 396 s` / `404 s` |
| 9 | `pnpm -C e2e e2e:x3` | **42 passed (9,9 m)**, exit 0 (run 88: 9,7 m) |
| 10 | int FULL cuối (cùng cờ, một mình) | `before=0` · `Test Suites: 89 passed, 89 total` · `Tests: 2393 passed, 2393 total` (1046 s) · `after=0` |
| 11 | `pnpm -C be test` cuối | `Test Suites: 60 passed` · `Tests: 1188 passed, 1188 total` |
| 12 | `pnpm -C fe-admin typecheck` / `test` | exit 0 / `Test Files 69 passed` · `Tests 1653 passed` |
| 13 | `pnpm -C be typecheck` / `lint`, `pnpm -C e2e typecheck` (cuối) | exit 0 / 0 / 0 |
| 14 | Đếm checklist + kiểm bằng chứng (script scratch) | `C {"n":108,"✅":78,"⚠":17,"N/A":13}` · `total {"n":202,"✅":155,"⚠":29,"N/A":17,"❌":1}` · ❌ `D-14` · `refs 306 errors 0` |

Không chạy: `test:vault` (cần container Vault mới — cấm tạo container; run 89 không đổi code Vault).

### Thời gian E2E (AC7, D89.21)

| Lượt | Thời gian | Ghi chú |
|---|---|---|
| run 88 | 5,3–5,7 m | 44 test |
| run 89 trước D89.21 | 20,5 m (+260 %) | mỗi `adminToken`/`signInAsAdmin` đi password + TOTP; luật replay ⇒ 1 mã/30 s/user sau 3 mã đầu |
| run 89 sau D89.21 | 12,5 m / 14,2 m / 14,8 m | `adminToken` không `forceLogin` dùng lại cookie IdP của lần đăng nhập mới gần nhất cùng user (≤ 180 s, vì step-up admin API cần `auth_time` < 5'); phiên chết (khoá/thu hồi/reset) ⇒ form đăng nhập như cũ |

Vẫn +120–160 % so với run 88. Nguyên nhân đo được: 46 mã TOTP/lượt, bộ cấp bước chờ 396–404 s (≈ 6,7 phút) — phần còn lại nằm ngoài D89.21: `signInAsAdmin` (đăng nhập qua trang fe-admin, ~16 lần), `forceLogin` (step-up, 5 lần), đăng nhập mới khi cache > 180 s; cộng `mfa.spec` (~1 phút). Không nới luật server. Ghi **DEBT-648** (🟢, sau phát hành: thêm admin E2E có seed riêng hoặc dùng lại phiên trong `signInAsAdmin` ở spec không kiểm chính bước đăng nhập). X3 không đổi.

## Test FAIL (nếu có)

Không còn ở lượt cuối. Lịch sử (đều đã xử lý):
- `/login/mfa` → RP bị CSP chặn — kỳ vọng 302 tới fe-admin callback, thực tế trình duyệt đứng ở trang bước 2 — **lỗi sản phẩm DEBT-647**, backend-dev sửa (D89.30), int `run89-mfa-login › DEBT-647 (D89.30) …` + E2E xanh.
- 2 ca int RED (#3) — ca kiểm của bản sửa DEBT-646/647 viết trước khi sửa; xanh ở #10.
- `fe-admin.spec:33`, `fe-admin-roles:88` timeout — ngân sách thời gian test (chờ TOTP) — lỗi test, sửa bằng D89.21 + timeout 90 s cho 4 test 30 s có đăng nhập IdP (không nới kỳ vọng nào).
- `account-self-service:171`, lượt bị cắt — môi trường (Mailpit vừa khởi động; tiến trình thoát).

## Thay đổi test (không đụng `src`)

- `e2e/tests/support/totp.ts` (mới): HOTP/TOTP RFC 4226/6238 bằng `node:crypto`, base32, sổ seed theo email, bộ cấp bước theo secret (`next = max(last+1, c-1)`; c-1 chỉ khi còn > 5 s trong bước; > c+1 ⇒ chờ tới 1 s vào bước `next-1`), `markStale` + thử lại 1 lần, log tổng chờ khi worker thoát.
- `e2e/tests/totp.spec.ts` (mới, không trình duyệt): mọi vector RFC 4226 D (0–9) + RFC 6238 B SHA-1 (6 thời điểm), base32, bộ cấp bước.
- `support/fe-admin.ts`: `passSecondFactor` / `passSecondFactorIfAsked` (302 = nhận; 400 + alert ⇒ bước mới, thử lại 1 lần); `signInAsAdmin` gọi nó. `support/admin.ts`: nhánh `/login/mfa` trong `adminToken` + D89.21. Hai bản `signInAsAdmin` cục bộ (`admin-api-risk`, `fe-admin`) và `signIn` của `fe-admin-risk` qua bước 2.
- `fe-admin-risk.spec.ts`: user "không có vai trò admin" đổi từ dev user sang `E2E_USER` (đã enroll, không vai trò). Lý do: D89.5 gác resource `admin` cho **mọi** user, dev user chưa enroll giờ dừng ở trang "Two-step verification required" của IdP (đúng thiết kế, có ở `mfa.spec (e)`), không còn tới trang 403 của fe-admin. Kỳ vọng của 2 test giữ nguyên.
- `be/test/e2e/seed-e2e-admin.ts`: bước 6 (AC3) — admin + `E2E_USER` enroll bằng seed cố định (`enrollForTest`, khoá `MFA_ENCRYPTION_KEYS`, không `lastStep`/`failures`/mã khôi phục, `enrolledAt = now`) mỗi lượt; seed rỗng ⇒ gỡ `mfa` (X3 đặt rỗng vì đăng nhập `E2E_USER` chỉ bằng mật khẩu); `E2E_MFA_USER_*` hội tụ như `E2E_USER` và luôn KHÔNG MFA. Trước run này seed chưa enroll ai (không khớp fold) ⇒ tester bổ sung theo danh sách file của T6. `seed-e2e-admin.int-spec.ts` +5 ca (cấu hình, enroll + mở seed bằng AAD userId, hội tụ lần 2, X3 gỡ, không in seed/khoá).
- `e2e/config/env.ts` (`E2E_MFA_USER_*` → `beEnv`), `e2e/x3/env.ts` (seed rỗng).
- `e2e/tests/mfa.spec.ts` (mới, 4 test): user đăng ký mới mỗi lượt cho các ca có mã sai (bucket 10/900 s theo userId — dùng user seed cố định thì 2 lượt liền nhau trong 15' sẽ 429).

## Coverage acceptance criteria (T6)

- [x] AC1 helper `node:crypto` + vector RFC — `totp.spec.ts` (4 test).
- [x] AC2 bộ cấp bước, thử lại 1 lần, log tổng chờ — `support/totp.ts`; `totp.spec › step allocator…`; log `46 codes, waited 396 s`.
- [x] AC3 seed enroll admin + `E2E_USER`, `E2E_MFA_USER` không MFA mỗi lượt — `seed-e2e-admin.ts` bước 6; `seed-e2e-admin.int-spec.ts › MFA (run 89 T6 AC3)` (5 ca, trong int FULL #10).
- [x] AC4 mọi đường đăng nhập admin E2E qua TOTP, spec admin cũ xanh không nới kỳ vọng — 44 test cũ xanh ×2 (đổi user ở `fe-admin-risk`, xem trên).
- [x] AC5 `mfa.spec.ts`: (a)(b)(c)(d) + tắt bằng TOTP và bằng mã khôi phục — `mfa: enroll (key, no QR) => …`; (f) — `mfa: federation (mock Google) …`; (e) — `(e) not enrolled => …`; (g) — `(g) admin resets …`. Trần 50: để int (`run89-mfa-cap.int-spec.ts`, 5 ca xanh) vì 50 mã sai vượt bucket 10/900 s.
- [x] AC6 gate: be typecheck/lint/unit, int FULL 0→0, fe-admin typecheck + test, E2E ×2, X3 42, `assert-dist-clean`. Vault: không chạy (lý do trên).
- [x] AC7 đo thời gian, làm D89.21, đo lại — mục "Thời gian E2E"; phần vượt còn lại ⇒ DEBT-648.
- [x] AC8 checklist + security-matrix — `release-checklist.md` (C-6.3.3/6.4b/6.5 ✅, C-6.3.4 thêm bằng chứng, bảng tổng, ghi chú Run 89), `security-matrix.md` §Run 89 (+3 hàng: DEBT-645, DEBT-647, E2E).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | user đã enroll / chưa enroll / federation-only / admin / user không vai trò | `mfa.spec` (4), `fe-admin-risk` |
| Credential | TOTP đúng / sai ×5 / replay cùng bước / mã khôi phục dùng 1 lần, dùng lại / mật khẩu + TOTP, mật khẩu + mã khôi phục để tắt | `mfa.spec › mfa: enroll …` |
| Authorization | resource `admin` cho user chưa enroll ⇒ 403 trang IdP, không code tới fe-admin; user không vai trò sau bước 2 ⇒ 403 của fe-admin; admin reset qua fe-admin (super_admin) | `mfa.spec (e)(g)`, `fe-admin-risk` |
| State | vé bước 2 không tạo phiên (`/account/mfa` ⇒ 302 `/login`); 5 lỗi ⇒ vé huỷ, về mật khẩu; enroll ⇒ mọi phiên chết; reset ⇒ đăng nhập không mã rồi enroll lại; replay giữa 2 trình duyệt | `mfa.spec` |
| Request chain | POST `/login/mfa` → `/authorize` → RP dưới CSP thật của Chromium (int không bắt được ⇒ DEBT-647); `/account/mfa?returnTo=/authorize…` → enroll → `/login` → bước 2 → tiếp tục authorize cũ | `mfa.spec (e)`, mọi spec admin |
| Exposure | không QR, khoá chỉ hiện ở trang setup; mã khôi phục hiện đúng 1 lần (không có ở `/account/mfa` sau đó); không in mã/seed/URL (log chỉ đếm) | `mfa.spec`, `seed-e2e-admin.int-spec › never prints a seed or the key` |
| Dependency / concurrency / cap | CAS song song, Redis/Mongo lỗi, trần 50, tenant audit | int run 89 (security-matrix §Run 89), không lặp ở E2E |
