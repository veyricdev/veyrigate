# Test Report — 2026-11-11 (run 85, T6 — retry 1)

## Kết quả: PASS (int 2143/2143; mọi gate xanh)

Retry 1 sau khi backend-dev sửa DEBT-600 (`authentication.service.ts` login: đọc lại `findByIdForAuthentication` sau `establish`, `passwordHash` khác hash đã verify ⇒ revoke phiên mới, 401 chung, không audit success, không `onSuccess`/trust). Spec tester không bị sửa; thêm 1 ca `/auth/link`.

## Retry 1 — lệnh đã chạy + output thực tế

File đổi kể từ lượt 1 (`find be/src be/test -newer test-report.md`): `be/src/modules/authentication/authentication.service.ts`, `authentication.service.spec.ts`, `be/test/ui-auth.int-spec.ts`, `be/test/b73-tester.vault-spec.ts` ⇒ trong `be/src` chỉ `authentication.service.ts` (+ unit spec) ⇒ không chạy lại E2E/X3 (theo lệnh orchestrator).

| # | Gate | Lệnh | Kết quả |
|---|---|---|---|
| 1 | be typecheck | `pnpm -C be typecheck` | exit 0 |
| 2 | be lint | `pnpm -C be lint` | 0 problem |
| 3 | be unit | `pnpm -C be test` | `Test Suites: 46 passed`, `Tests: 931 passed, 931 total` |
| 4 | tester spec | `pnpm -C be test:int run85-tester` | `Tests: 49 passed, 49 total` (2 ca DEBT-600 nay xanh + ca link mới) |
| 5 | mutation (test-side) | thay `fresh.passwordHash !== user.passwordHash` bằng `false`, `test:int run85-tester -t "OLD password"` | `Tests: 3 failed, 46 skipped` (change, reset, link đều đỏ); khôi phục, sha256 khớp |
| 6 | int FULL | `pnpm -C be test:int` | `Test Suites: 73 passed, 73 total` · `Tests: 2143 passed, 2143 total` · `Time: 802.622 s` · exit 0. `vg-int-*`: **0 → 0** |
| 7 | vault spec | chạy bởi **orchestrator** (có người dùng duyệt), không phải tester | 31/31 PASS sau khi sửa kỳ vọng cũ `be/test/b73-tester.vault-spec.ts:462` (run 80 thêm `error_description` vào 503 của introspect; vault spec chưa chạy lại từ đó) |
| 8 | E2E / X3 | không chạy lại (không đổi `be/src` ngoài `authentication.service.ts`) | lượt 1: E2E 39/39, X3 42/42 (xem bảng lượt 1) |

Ca mới: `be/test/run85-tester.int-spec.ts › federation /auth/link vs a concurrent password change › a link login with the OLD password racing a password change: not linked, the new session is dead` — `completeLink` (pending link thật qua `FederationStateStore.createLink`) dừng ở `establish` sau khi Argon2 nhận mật khẩu cũ, chủ tài khoản đổi mật khẩu (200), mở cổng ⇒ `kind: 'failed'`, phiên vừa tạo `null`, 0 `FederatedIdentity`, 0 `ACCOUNT_LINKED`, không có ZSET trust.

Checklist sau retry: C-7.4b ⇒ ✅; bảng 201 dòng 142/30/10/19, P0 ❌ 1 (C-14.2.1 ⇒ run 86); 26 tham chiếu run 85 kiểm đúng 1 lần mỗi tên. `security-matrix.md` AE9 ⇒ `có` (§14 47 có / 0 lỗi sản phẩm).

---

# Lượt 1 (giữ để đối chiếu) — FAIL (int 2140/2142)

## Lệnh đã chạy + output thực tế

| # | Gate | Lệnh | Kết quả |
|---|---|---|---|
| 1 | be typecheck | `pnpm -C be typecheck` | `tsc --noEmit`, exit 0 |
| 2 | be lint | `pnpm -C be lint` | `eslint src test`, 0 problem (lượt đầu 607 lỗi `␍` do spec tester ghi CRLF ⇒ đổi LF + `eslint --fix` file đó, chạy lại sạch) |
| 3 | e2e typecheck | `pnpm -C e2e typecheck` | exit 0 |
| 4 | be unit | `pnpm -C be test` | `Test Suites: 46 passed`, `Tests: 930 passed, 930 total` |
| 5 | int FULL | `pnpm -C be test:int` (vg-test-mongo@27117, vg-test-redis@6479, đang chạy sẵn) | `Test Suites: 1 failed, 72 passed, 73 total` · `Tests: 2 failed, 2140 passed, 2142 total` · `Time: 802.288 s` · exit 1. `vg-int-*`: **0 → 0** |
| 6 | vault spec | — | lượt 1 **KHÔNG CHẠY** (retry 1: orchestrator chạy 31/31): không có container Vault (`docker ps -a` không có `vg-b73-vault`/Vault nào, không có image `hashicorp/vault` cục bộ); các run trước chạy bằng `docker run -d --name vg-b73-vault … hashicorp/vault:2.1.2@sha256:c2f6…` (`be/test/vault-preflight.mjs`), bị cấm ở lượt này |
| 7 | E2E | `pnpm -C e2e e2e` (cổng 4000/5173/3000 trống trước khi chạy, DB `sso-idp-e2e`) | lượt 1: 38 passed, 1 failed (lỗi của chính spec mới: login sai mật khẩu render trang lỗi chung 401, không phải form) ⇒ sửa spec (kiểm status 401 của POST `/login`), chạy riêng 1/1 ⇒ lượt 2 toàn bộ **`39 passed (4.5m)`** exit 0 |
| 8 | X3 | `pnpm -C e2e e2e:x3` (4100/5273/5274/8443 trống) | lượt 1: 41 passed, 1 failed (`[webkit] › cross-site … › 2 SSO second RP` — callback alpha không hiện claims trong 30 s, không liên quan cookie mới; DEBT-601) ⇒ lượt 2 **`42 passed (9.3m)`** exit 0 |
| 9 | fe-admin (thêm, vì `fe-admin/` có đổi enum audit: `git diff --stat -- fe-admin` 3 file) | `pnpm -C fe-admin test` | `Test Files 68 passed`, `Tests 1613 passed` |
| 10 | pin action | `grep -hE '^\s*-?\s*uses:' .github/workflows/*.yml \| grep -vE '@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$'` | 23 dòng `uses:`, 0 dòng lệch |

## Test FAIL

- `be/test/run85-tester.int-spec.ts › … › a login with the OLD password racing a password change must not leave a live session` và `… racing a password reset …`
  - Kỳ vọng `{status: 401, liveSession: false}`; thực tế `{status: 302, liveSession: true}`.
  - Cách dựng: spy `SessionService.establish` dừng login của kẻ biết mật khẩu cũ **sau** khi Argon2 đã nhận mật khẩu cũ; chủ tài khoản đổi mật khẩu (`POST /account/password` 200) hoặc reset; mở cổng ⇒ phiên mới được tạo sau sweep `revokeAllUserCredentials` và sống tiếp.
  - Nguyên nhân: `AuthenticationService.login` recheck sau `establish` (DEBT-141) chỉ xét `lockedUntil`, không xét `passwordHash` đã verify. Đề xuất ở DEBT-600.

## Coverage acceptance criteria (T6)

- [x] Checklist cập nhật, bằng chứng kiểm `grep -F` (script: 25 tham chiếu run 85 trong `release-checklist.md`, mỗi tên đúng 1 lần trong file test) — B-6.1, B-5.3.1, C-6.1.1, C-6.2.2, C-6.2.4, C-15.1.1, D-3 ✅; C-6.2c ⚠; C-6.1b ⚠ (phần ngữ cảnh ✅); C-6.3a đổi bằng chứng; C-15.2a/D-2 chờ người dùng; D-15 mới ✅; C-7.4b ✅ ⇒ ❌ (DEBT-600). Bảng tổng đếm lại bằng script: 201 dòng, 141/30/11/19, P0 ❌ = 1 (C-14.2.1 ⇒ run 86).
- [x] `security-matrix.md`: thêm AE9 (đổi mật khẩu, `lỗi sản phẩm` DEBT-600), bảng tổng §14 48 dòng.
- [x] E2E `e2e/tests/password-change.spec.ts` (DEBT-594): user riêng qua `/register` + thư xác minh Mailpit, 2 context; CSRF (không token / token bịa ⇒ 403), sai mật khẩu hiện tại ⇒ câu cố định, thành công ⇒ A phải đăng nhập lại, B `prompt=none` từ `consent_required` thành `login_required`, mật khẩu cũ ⇒ 401, mật khẩu mới ⇒ vào được.
- [x] Spec tester `be/test/run85-tester.int-spec.ts` 48 ca (46 xanh, 2 đỏ = DEBT-600).
- [x] X3: thêm `expectDeviceCookieShape` vào ca 1 của `e2e/x3/cookie-matrix.spec.ts` (`__Host-idp_dc`, Secure, HttpOnly, Path=/, host-only, Lax nơi áp SameSite, 90 ngày, không có `idp_dc`) — xanh 6/6 ô, tổng vẫn 42.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test (`run85-tester.int-spec.ts`) | Kết quả |
|---|---|---|---|
| Credential | device cookie 42/44 ký tự, `.`/`+`/`/`, non-ASCII, escape hỏng, 4000 ký tự, rỗng, JSON | `cookie %s: no 500, never looked up, …` | ✅ không 500, 0 ZSCORE, token mới, tính như thiết bị lạ |
| Credential | cookie tin cậy viết percent-encode | `a percent-encoded spelling of a trusted token …` | ✅ decode 1 lần, vẫn tin cậy, token cũ bị xoay |
| Credential | cookie quá 90 ngày; cookie cũ sau reset (replay) | `a trusted entry older than 90 days …`, `… trusted before a password reset is not trusted after it` | ✅ |
| Credential | lỗi của thiết bị tin cậy không tính vào N/A | `trusted-device failures (D = 10) …` | ✅ scope `device`, chủ tài khoản vẫn vào |
| Identity | 429 bucket account: email có vs không | `account bucket (20 over 5 networks …)` | ✅ status/body/header giống; audit không có email |
| Identity | 429 + cookie đúng dạng: số ZSCORE | `throttled with a well-formed device cookie …` | ✅ 1 = 1 |
| State | login mật khẩu cũ ∥ đổi / reset; `/auth/link` ∥ đổi | `a login with the OLD password racing a password %s …`, `a link login with the OLD password racing a password change …` | lượt 1 ❌ DEBT-600 ⇒ retry 1 ✅ |
| State | đổi ∥ reset; 2 lần đổi song song | `change and reset at the same time …`, `two concurrent changes …` | ✅ 1 mật khẩu cuối, không 5xx, đúng 1 audit success |
| Input | biến thể HOA/fullwidth/math-bold/từ sản phẩm | `register refuses %s …`, `the change form refuses the email local part …` | ✅ |
| Input | `request_uri` URL-encode khoá, NUL, `javascript:`, `urn:` PAR, 8 KB, escape hỏng, không `=`; `r%65quest` | `%s => 302 %s to the trusted redirect_uri, never a code` | ✅ |
| Input | `request` + `prompt=none` không phiên; `REQUEST_URI` | 2 ca | ✅ `request_not_supported` thắng; tên tham số phân biệt hoa thường |
| Exposure | `POST /userinfo` token trong JSON/query/form+query/text/body field | `token only in the %s …` | ✅ 401 |
| Input | body 2 MB (JSON/form) không header; có header; JSON hỏng | 3 ca | ✅ 401/413/200, không 5xx |

Ghi chú (không chặn, gộp DEBT-599): `networkOf('0:0:0:0:0:ffff:1.2.3.4')` ra `0000:0000:0000:0000` thay vì IPv4 (chỉ gom chặt hơn, không bypass).
