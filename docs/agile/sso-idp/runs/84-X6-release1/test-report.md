# Test Report — 2026-11-11 (run 84, X6 đợt 1, tester T4 + T5)

## Kết quả: PASS (gate T5 đủ: be unit 905/905, int FULL 2052/2052, E2E 38/38, `vg-int-*` 0 → 0)

- T4 `release-checklist.md`: xong, vòng `grep -F` bằng chứng 235 tham chiếu / 196 duy nhất / **0 lệch**.
- Test tester `be/test/run84-tester.int-spec.ts`: **37/37** xanh, 11 mutation đều đỏ ≥ 1 ca, sha256 khớp sau khôi phục.
- Gate: typecheck ✅, lint ✅, be unit **905/905** ✅, int FULL **68 suite / 2052/2052** ✅ (= 2015 của backend-dev + 37 `run84-tester`), `vg-int-*` **0 → 0**, E2E **38/38** ✅. Lượt đầu bị chặn vì Docker Desktop ngừng; chạy lại toàn bộ sau khi coordinator khởi động lại container. Không có test FAIL.
- **P0 ❌ của checklist: 7** (đầu vào run 85), không phải lỗi của T1/T2.

## Lệnh đã chạy + output thực tế

1. `pnpm -C be test:int run84-tester` (trước mutation):
   ```
   PASS test/run84-tester.int-spec.ts (24.776 s)
   Tests:       34 passed, 34 total
   ```
   sau khi thêm 3 ca TRACE: `Tests:       37 passed, 37 total`.
2. Vòng kiểm bằng chứng (`check.py` ở scratchpad: tách `` `đường-dẫn › tên` ``, đếm dòng chứa tên):
   ```
   lần 1: COUNT=0 … falls back without a hint / COUNT=0 … race: admin lock + credential sweep … / COUNT=0 … Redis refuse / blackhole … / COUNT=2 … nosniff, Referrer-Policy, frame protection
          refs=238 unique=197 bad=4
   sửa:   refs=235 unique=196 bad=0
   ```
3. Grep phủ định dùng trong checklist: `child_process` 0, `eval(` 0, `md5` 0, `breach|pwned|common-password` 0.
4. Mutation (`pnpm test:int run84-tester` mỗi lần; khôi phục bằng bản sao, sha256 trước = sau):

   | Mutation | File | Đỏ | sha256 |
   |---|---|---|---|
   | MT1 kiểm bản NFKC | `email-address.ts` | 7 failed, 30 passed | khớp `015c1b24cbcc` |
   | MT2 kiểm bản `toLowerCase()` | `email-address.ts` | 2 failed | khớp |
   | MT3 email `@IsOptional()` (Register/Email DTO) | `ui.controller.ts` | 13 failed | khớp `67ed15a2d4bc` |
   | MT4 `LABEL` chỉ chữ thường | `email-address.ts` | 2 failed | khớp |
   | MT5 F5 kiểm `normalizeEmail(email)` | `federation.service.ts` | 3 failed | khớp `aa6b89dad168` |
   | MT6 `findByEmail` trước kiểm ngữ pháp | `federation.service.ts` | 11 failed | khớp |
   | MT7 304 khi có header điều kiện | `keys.controller.ts` | 3 failed | khớp `bee180d0569e` |
   | MT8 `getPublicKeys().catch(() => [])` | `keys.controller.ts` | 1 failed | khớp |
   | MT9 HSTS `maxAge 15552000` | `bootstrap.ts` | 3 failed | khớp `0ffcc1671a00` |
   | MT10 `/login` `Content-Type: text/html` (không charset) | `ui.controller.ts` | 1 failed | khớp |
   | MT11 route TRACE echo header | `bootstrap.ts` | 3 failed | khớp |

   Lần thử hỏng (ghi trung thực): MT1/MT2 bản đầu gán lại tham số `unknown` ⇒ TS18046, MT3 bản đầu để import thừa ⇒ TS6133 (0 test chạy) ⇒ viết lại; MT10 bản đầu `application/json` không charset ⇒ Fastify tự thêm charset, sống ⇒ đổi sang HTML.
5. `pnpm -C be typecheck` ⇒ exit 0. `pnpm -C be lint` ⇒ lần 1 `✖ 10 problems (10 errors)` prettier, tất cả ở `test/run84-tester.int-spec.ts` ⇒ `eslint --fix` file đó ⇒ exit 0.
6. `pnpm -C be test`:
   ```
   Test Suites: 44 passed, 44 total
   Tests:       905 passed, 905 total
   ```
7. Lượt 1: `docker exec vg-test-mongo mongosh …` ⇒ `Error response from daemon: Docker Desktop is unable to start`; mongoose `:27117` ⇒ `Server selection timed out after 4000 ms` ⇒ dừng. Lượt 2 (sau khi coordinator khởi động lại `vg-test-*`, aegate-*, mailpit):
   - `vg-int-*` trước (mongoose `listDatabases` trên `localhost:27117`): `vg-int count 0`
   - `pnpm -C be test:int` (exit 0):
     ```
     Test Suites: 68 passed, 68 total
     Tests:       2052 passed, 2052 total
     Time:        675.19 s, estimated 845 s
     ```
   - `vg-int-*` sau: `vg-int count after 0`
   - Cổng 4000/5173/3000 trống (netstat, không tiến trình LISTENING) ⇒ `pnpm -C e2e e2e` (exit 0): `38 passed (4.7m)`. Log có các dòng `[fe-admin] server function failed …` / `federation failed: invalid_state` / `federation link failed: credentials` — đều từ ca âm của suite (ồn đã biết, DEBT-110), không ca nào fail.
8. `git diff --stat -- fe-admin fe-sso-test e2e` ⇒ trống ⇒ bỏ fe-admin, fe-sso-test, X3 (đúng điều kiện tasks T5).

## Test FAIL (nếu có)

Không có.

## Coverage acceptance criteria

- [x] T4: mỗi dòng đúng 1 trạng thái (đếm bằng script: A 36, B 42, C 108, D 14, E 54) — `release-checklist.md` bảng tổng
- [x] T4: vòng `grep -F` mọi bằng chứng dạng test ra đúng 1 dòng — case 2 (`bad=0`), ghi `log.md`
- [x] T4: mỗi ❌ có P-level + DEBT/task (D-14 "ký duyệt" là task đợt 4, không có P-level)
- [x] T4: bảng tổng khớp số dòng; liệt kê P0 ❌ (dưới)
- [x] T5: mutation T1/T2 đã ghi (backend-dev M1–M7, J1/J2 trong `log.md`; tester MT1–MT11, case 4)
- [x] T5: typecheck + lint + be unit — case 5, 6
- [x] T5: int FULL 2052/2052 + `vg-int-*` 0 → 0 — case 7
- [x] T5: E2E 38/38 (register/forgot chạm) — case 7

## Coverage security invariants / risk matrix

T1 (email D84.1) và T2 (JWKS) — chiều đã kiểm thêm so với test dev:

- [x] Input — Unicode look-alike / dạng gập NFKC / ký tự `toLowerCase()` ra ASCII / ZWSP: `run84-tester › T1-a …` (8), `› T1-d …` (8 + 3)
- [x] Input — type confusion (mảng, tham số lặp, toán tử Mongo `$ne`/`$gt`/`$regex`) cả `/login`: `› T1-b …` (5)
- [x] Input — biên hợp lệ (chữ hoa, `+tag`, subdomain) ⇒ đúng 1 thư tới địa chỉ đã lưu: `› T1-c …`
- [x] State/order — F5 kiểm ngữ pháp trước mọi tra theo email, sau tra `(provider, providerId)` (spy), có tài khoản local dạng đã gập: `› T1-d …`
- [x] Exposure — 400 không echo `good.test`/`evil.test`; 5xx JWKS không lộ `SECRET-DETAIL`/`boom`: `› T1-a`, `› T2-b`
- [x] Dependency — key provider lỗi không phải `KeyProviderUnavailableError` ⇒ 5xx `no-store`, không 200 rỗng: `› T2-b` (MT8)
- [x] Request chain — GET có điều kiện không nhận 304/bản cũ: `› T2-a`
- [x] Transport — HSTS ≥ 1 năm, TRACE, charset: `› ASVS 3.4.1 …`, `› ASVS 13.4.4 …`, `› ASVS 4.1.1 …`
- Identity/Authorization: không đổi ở run 84 (T1 chỉ thêm điều kiện từ chối); federation identity đã liên kết vẫn đăng nhập — test dev `federation.int-spec.ts` "run 84".

## P0 ❌ từ checklist (đầu vào run 85)

1. B-6.1 — OIDC Core §6.1/§6.2: `request`/`request_uri` bị bỏ qua thay vì `request_not_supported`/`request_uri_not_supported` (DEBT-571)
2. B-5.3.1 — OIDC Core §5.3.1: UserInfo không có POST (DEBT-584)
3. C-6.1.1 — ASVS 6.1.1 L1: chưa tài liệu/chống khoá tài khoản có chủ đích (DEBT-575, DEBT-016)
4. C-6.2.2 — ASVS 6.2.2/6.2.3 L1: không đổi được mật khẩu (DEBT-573)
5. C-6.2.4 — ASVS 6.2.4 L1: không kiểm mật khẩu phổ biến (DEBT-574)
6. C-14.2.1 — ASVS 14.2.1 L1: token một lần trong query link email (DEBT-577; tech-lead có thể chốt ⚠)
7. C-15.1.1 — ASVS 15.1.1 L1: chưa có thời hạn khắc phục lỗ hổng thành phần (DEBT-576)

Debt mới: DEBT-568–584 (không có 🔴; 9 🟡, 8 💭). Không mục nào chặn run 84 (chúng là khoảng trống so với chuẩn, không phải hồi quy của T1/T2).
