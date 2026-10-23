# Test Report — 2026-10-23 (run 45, A6.1b)

## Kết quả lượt 2: PASS [FE] (fe-admin 682/682; risk 32/32; E2E 29/29)

# Lượt 2 — sau frontend-dev retry 1 + senior lượt 2 PASS

DEBT-313/314/315/316 đã đóng thật: `client-secrets-risk.test.tsx` có **0** `it.fails` (`grep -c` = 0), mọi case cũ đã là `it` và xanh. Không còn 🔴. DEBT-318 xác nhận bằng characterisation, giữ 🟡 (không đảo ngược ý định, không lộ secret).

## Lệnh đã chạy + output thực tế (lượt 2, Git Bash, foreground)

| Lệnh | Exit | Output |
|---|---|---|
| `pnpm exec vitest run test/client-secrets-risk.test.tsx` | 0 | `Tests 32 passed (32)` (24 cũ + 8 mới). Lần đầu 2 FAIL do fixture của tester (V1 là version usable cuối ⇒ alert "last usable" chắn `findByRole("alert")`); đổi sang `[V2, V1_GRACE]` revoke v2 ⇒ xanh. |
| `pnpm -C fe-admin typecheck` | 0 | |
| `pnpm -C fe-admin lint` | 0 | |
| `pnpm -C fe-admin test` | 0 | `Test Files 31 passed (31)`, `Tests 682 passed (682)` |
| `pnpm -C fe-admin build` | 0 | `✓ built in 799ms` |
| `pnpm -C fe-admin check:bundle` | 0 | `scanned 8 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| `pnpm -C fe-admin gen:api` | 0 | `git diff --stat src/server/admin-api/schema.d.ts` rỗng |
| `pnpm lint` (root) | 0 | |
| `pnpm -r run typecheck` | 0 | |
| `pnpm test` (root) | 0 | be `Test Suites: 32 passed`, `Tests: 405 passed`; fe-sso-test `Tests 269 passed (269)`; fe-admin `Tests 682 passed (682)` |
| `pnpm audit --audit-level high` | 0 | `2 vulnerabilities found — Severity: 2 low`, `1 ignored: 1 high` |
| `pnpm -C e2e e2e` | 0 | `29 passed (3.3m)`; `fe-admin-secrets.spec.ts:54` ok (5.0s) |

- Trước E2E: `netstat` không LISTENING trên :4000/:5173/:3000, `curl` cả ba = 000 ⇒ được chạy. Sau E2E cả ba lại 000. Không dừng/đụng process nào; không compose, không FLUSH.
- Log E2E có 4 dòng `server function failed … Error: [ {zod …} ]` ("Invalid client id", `unrecognized_keys tenantId`, `invalid_type boolean`…): đó là các case input không hợp lệ có chủ đích của spec E2E, không phải lỗi.
- Grep `S3CR3T|clientSecret|client_secret":` trên log E2E: **0**; `S3CR3T-canary|clientSecret` trên log `pnpm -C fe-admin test`: **0**.

### Mutation (lượt 2)

Sao lưu `hooks.ts`, `client-status.tsx`, `confirm-action.tsx` vào scratchpad `mut2/` + sha256; khôi phục bằng `cp`, sha256 khớp cả 3 (không git checkout).

1. Áp fix DEBT-318 (`!error || !(error instanceof AdminRequestError) || error.uncertain`) ⇒ **2 RED** đúng 2 characterisation DEBT-318 (disable throw, revoke throw) ⇒ test bắt đúng cơ chế, sẽ lật khi dev sửa.
2. Bỏ `key="enable"/"disable"` ⇒ 8 case lượt 2 vẫn xanh (đóng-khi-uncertain đủ cho các case này); `key` đã được case dev "replaced (not relabelled)" bắt (dev mutation: 1 RED). Không thiếu phủ.
3. `outcomeOf` throw ⇒ "try again" ⇒ **1 RED** (revoke throw). Disable/Enable throw không đi qua nhánh này (`setDisabled` tự đóng dialog) — đúng thiết kế.

## Test mới lượt 2 (`fe-admin/test/client-secrets-risk.test.tsx`, +8)

- "uncertain Disable that went through: Enable needs the trigger AND a deliberate confirm…": sau uncertain, không có `alertdialog`; `role=status` = `UNCERTAIN_STATUS`; bấm trigger "Enable client" mở instance MỚI (title "Enable this client?", không có `role=alert` cũ, focus ở Cancel); PATCH vẫn đúng 1 ⇒ **không còn đường một click Enable lại**.
- `it.each` Disable/Enable **throw** (TypeError chứa canary) ⇒ dialog đóng, notice `UNCERTAIN_STATUS`, 1 PATCH, canary không ở DOM/cache/storage/URL/log/toast.
- "DEBT-318 characterisation: thrown Disable does NOT re-read the detail": `getClient` không được gọi lại; trigger cũ vẫn là "Disable client" (cùng hành động ⇒ lặp lại idempotent), KHÔNG xuất hiện "Enable client".
- Revoke throw (canary) ⇒ alert = text uncertain revoke, revoke 1 lần, không canary; characterisation DEBT-318: `listSecrets` không gọi lại.
- Revoke uncertain (`AdminRequestError`) ⇒ list đọc lại, revoke 1 lần; bấm lại ⇒ 404 "already revoked" (không ghi trùng có hại).
- `it.each` refetch **throw** (detail / secret list) khi secret đang hiện ⇒ cùng dialog, secret còn; Close ⇒ không còn ở mọi sink; mở lại ⇒ không `issued-secret`, store sạch.

## Coverage lượt 2

- [x] DEBT-313: risk "DEBT-313: uncertain Disable…", "…did NOT go through…", "…replaced (not relabelled)…" + lượt 2 "Enable needs the trigger AND a deliberate confirm".
- [x] DEBT-314: risk "DEBT-314…" (kết quả lỗi) + lượt 2 refetch list throw.
- [x] DEBT-315: risk "DEBT-315…", "throw that is not an AdminRequestError…" + lượt 2 disable/enable/revoke throw.
- [x] DEBT-316: risk "DEBT-316…" + lượt 2 refetch detail throw.
- [x] Notice `UNCERTAIN_STATUS` hiển thị (`role=status`) cho uncertain và throw.
- [x] Plaintext sau đóng: canary 7 case lượt 1 + 2 case refetch-throw lượt 2 (DOM/Query+MutationCache/local+sessionStorage/URL/console/toast).
- [x] DEBT-318 🟡 xác nhận: UI cũ sau throw không đảo ngược ý định (trigger cũ là cùng hành động; revoke lặp ⇒ 404), không lộ secret ⇒ giữ 🟡.

| Chiều risk matrix | Lượt 2 |
|---|---|
| Dependency (throw / uncertain khi ghi) | disable, enable, revoke throw; revoke uncertain |
| Dependency (refetch throw khi đọc) | detail, secret list |
| State (stale UI / retry) | sau uncertain/throw chỉ còn trigger; retry revoke ⇒ 404 |
| Exposure | canary trong message lỗi ⇒ không ở sink nào; sau Close/mở lại |

## Debt lượt 2

- DEBT-313/314/315/316: đóng (đã ở bảng đã đóng của backlog).
- DEBT-318 🟡: xác nhận bằng 2 characterisation (sẽ RED khi sửa ⇒ dev đổi assertion thành "được đọc lại"). Không nâng 🔴.
- Không mở debt mới.

---

# Lượt 1

## Kết quả lượt 1: FAIL ([FE] DEBT-313 nâng thành 🔴)

Mọi lệnh đều xanh: fe-admin 671 pass + 3 expected fail / 674; root `pnpm test` gồm be 405, fe-sso-test 269 và fe-admin 671 (+3 `it.fails`); E2E 29/29 ×2.

Gate vẫn **FAIL** vì DEBT-313 đã được xác nhận bằng test thật. Khi Disable trả `uncertain`, BE thực ra đã disable client. Sau refetch, chính dialog Disable đang mở chuyển thành "Enable this client?" nhưng vẫn giữ lỗi "check the client status before trying again". Admin bấm "thử lại" **một lần**, ở cùng vị trí nút, là gửi `PATCH { disabled: false }` và bật lại client. Đây đúng là trường hợp "bấm nhầm bật lại client chỉ bằng một hành động tự nhiên". Tác động bảo mật: admin thường disable vì client bị lộ secret, và client đó bị bật lại.

## Lệnh đã chạy + output thực tế

Chạy foreground trên Git Bash, kết quả theo thứ tự:

| Lệnh | Exit | Output |
|---|---|---|
| `pnpm exec vitest run test/client-secrets-risk.test.tsx` | 0 | `21 passed \| 3 expected fail (24)` |
| `pnpm -C fe-admin typecheck` | 0 | Lần đầu exit 2 vì lỗi kiểu trong test mới của tester (dòng 155). Đã sửa test, chạy lại exit 0. |
| `pnpm -C fe-admin lint` | 0 | |
| `pnpm -C fe-admin test` | 0 | `Test Files 31 passed (31)`, `Tests 671 passed \| 3 expected fail (674)` |
| `pnpm -C fe-admin build` | 0 | `✓ built in 809ms` |
| `pnpm -C fe-admin check:bundle` | 0 | `scanned 8 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| `pnpm -C fe-admin gen:api` | 0 | `git diff --stat src/server/admin-api/schema.d.ts` rỗng (không diff) |
| `pnpm lint` (root) | 0 | be / fe-sso-test / fe-admin: Done |
| `pnpm -r run typecheck` | 0 | be, e2e, fe-admin, fe-sso-test: Done |
| `pnpm test` (root) | 0 | be `Tests: 405 passed`; fe-sso-test `Tests 269 passed`; fe-admin `Tests 670 passed \| 3 expected fail`. Đây là lần chạy trước khi thêm case DEBT-316; sau khi thêm, fe-admin chạy lại được 671. |
| `pnpm audit --audit-level high` | 0 | `2 vulnerabilities found — Severity: 2 low`, `1 ignored: 1 high` |
| `pnpm -C e2e e2e` lần 1 | 0 | `29 passed (3.3m)`; `fe-admin-secrets.spec.ts:54` ok (5.0s) |
| `pnpm -C e2e e2e` lần 2 | 0 | `29 passed (3.1m)`; `fe-admin-secrets.spec.ts:54` ok (4.7s) |

- Trước E2E đã kiểm cổng: `netstat` không có LISTENING trên :4000, :5173, :3000; `curl` tới cả ba đều trả 000. Vì vậy E2E được phép chạy. Sau E2E, cả ba cổng lại trống: webServer của Playwright tự dừng.
- Tester không dừng process nào của người dùng. Docker (`vg-test-*`, `aegate-*`, mailpit) đã chạy sẵn, không đụng tới.
- Grep `S3CR3T|clientSecret|client_secret":` trên output của cả hai lần E2E: **0** hit.

### Mutation

Sao lưu vào scratchpad `mut/` kèm sha256. Khôi phục bằng `cp` rồi `sha256sum -c`: cả 3 file đều OK. Không dùng git checkout.

1. Áp đúng bản sửa mà review đề xuất cho DEBT-313 (`key={String(disabled)}`), DEBT-314 (gate bằng `secrets.data !== undefined`) và DEBT-315 (lỗi không phải `AdminRequestError` ⇒ `UNCERTAIN_ISSUE`). Kết quả: **6 test chuyển RED**, gồm 3 characterisation và 3 `it.fails` (lúc này báo "expected to fail but passed"). Như vậy các test bắt đúng cơ chế, không pass vì lý do phụ.
2. Bỏ guard `busy.current` trong `ConfirmAction`: vẫn **xanh**. Lý do là `fireEvent` chạy trong `act`, nên giữa hai click React đã render lại và nút đã `disabled`. Lớp `pending` một mình đủ giữ invariant "1 PATCH"; ref là phòng thủ thêm (💭, không phải debt).

## Test FAIL (nếu có)

- **[FE] DEBT-313 🔴**
  - Test: `client-secrets-risk.test.tsx` › "DEBT-313 characterisation (current hazard)…" (đang PASS = hành vi hiện tại đã được chứng minh) và `it.fails` "DEBT-313 (desired)…".
  - Kỳ vọng: khi trạng thái thật đổi, dialog Disable biến mất, hoặc không còn nút confirm Enable ở cùng chỗ.
  - Thực tế:
    - Vẫn là cùng instance `alertdialog`; title đổi thành "Enable this client?".
    - Vẫn hiện `role=alert` "…check the client status before trying again".
    - Một click vào nút confirm ⇒ `updateClient` lần 2 với `{ clientId: "app-1", patch: { disabled: false } }`.
  - Nguyên nhân: `client-status.tsx` có hai `<ConfirmAction>` cùng vị trí trong ternary, nên React giữ chung state `open` và `result`.
  - Sửa:
    - Thêm `key` theo `disabled` cho mỗi `ConfirmAction`. Mutation 1 xác nhận cách này đóng được hazard.
    - Đưa thông điệp `uncertain` ra `notice` của section. Nếu chỉ thêm key thì dialog đóng và mất luôn thông điệp.
    - Sau khi sửa: đổi `it.fails` ⇒ `it` và xoá test characterisation.
- Không có test nào FAIL ngoài ý muốn.

## Coverage acceptance criteria

- [x] Task 1, DEBT-308 (remount theo `clientId`, secret không theo sang client khác): `client-secrets.test.tsx` "DEBT-308…" và risk "navigating away while the issue is pending…" (câu trả lời đến sau khi đã chuyển client ⇒ không hiện ở đâu).
- [x] Task 2, server fn (`no-store`, map lỗi, không log body/plaintext, version validator, DELETE 204/404/timeout): `secrets-fn.test.ts`, `admin-secrets.test.ts` (dev). Đã đối chiếu và chạy xanh.
- [x] Task 3, dialog một lần:
  - Secret biến mất sau mọi đường đóng. Risk `it.each` có 4 đường: Close, Escape, pagehide, điều hướng sang `/clients`. Thêm 2 case: unmount toàn app, và pagehide khi đang pending.
  - Sau đó `invalidateQueries()` toàn bộ rồi **mở lại dialog**: không có `issued-secret`, và `stores()` (DOM, Query/MutationCache, local/sessionStorage, URL, console, toast) không chứa canary.
- [x] Task 3, rotate `uncertain` / step-up / 403 / 404 / unauthenticated: dev + risk "issue failures" `it.each` (uncertain, forbidden, not_found ⇒ đúng thông điệp, Cancel đóng, issue đúng 1 lần).
- [x] Task 3, revoke có xác nhận + cảnh báo version cuối: dev + risk "only a grace version left…" (grace là usable cuối ⇒ alert; sau revoke nút đổi thành "Issue secret") và "active + grace ⇒ không alert".
- [x] Task 3, disable PATCH một mình, 409 tự khoá, enable: dev + risk "409 on ENABLE is not the self-lockout message", "double click on Disable confirm ⇒ one PATCH".
- [ ] Task 3, disable `uncertain`: **FAIL**, xem DEBT-313 ở trên.
- [x] Task 3, a11y:
  - Focus vào dialog khi mở và trả về trigger khi đóng (dev).
  - Risk keyboard: dialog secret có tên theo title và có `aria-describedby`. Tab ở nút cuối quay về nút đầu, Shift+Tab ở nút đầu tới nút cuối. Escape trả focus về "Rotate secret".
  - AlertDialog Disable: focus ban đầu ở **Cancel**. Escape đóng, không gửi request, focus về trigger.
- [x] Task 4, E2E (issue ⇒ no-store ⇒ `/revoke` 200 ⇒ reload không thấy ⇒ rotate ⇒ revoke v1 401/200 ⇒ disable 401 ⇒ enable 200): xanh ×2, grep 0 secret.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Exposure (DOM / cache / storage / URL / log / toast) | canary sau Close, Escape, pagehide, điều hướng, unmount, pending rồi điều hướng, pending rồi pagehide, refetch sau khi đóng, mở lại | risk "canary…" (7 case) |
| Exposure (message lỗi) | lỗi throw có message chứa canary ⇒ không hiện | risk "throw that is not an AdminRequestError…" |
| Dependency (network / BFF 500 / 5xx uncertain) | issue throw, uncertain, forbidden, not_found; danh sách được đọc lại; không gửi lại | risk "issue failures" |
| Dependency (refetch lỗi khi secret đang hiện) | danh sách lỗi (DEBT-314) và detail lỗi (DEBT-316) ⇒ dialog unmount, secret mất (fail-closed) | risk "DEBT-314…", "DEBT-316…" |
| State (concurrent / double-submit) | double-click confirm Disable; Cancel/Escape bị khoá khi pending; double-click Rotate/Revoke (dev) | risk + dev |
| State (stale UI sau uncertain) | Disable uncertain rồi refetch ⇒ dialog lật thành Enable | risk "DEBT-313…" ⇒ **FAIL** |
| Authorization | 403 list/issue (admin-capable, không phải super_admin) ⇒ forbidden; cross-tenant do BE quyết (404) | dev + risk |
| Request chain | step-up không có intent; quay lại không gì tự chạy (dev). Sau revoke/disable ⇒ refetch | dev |
| Input | version 0/-1/1.5/1e9/"01"/NaN bị chặn trước BE | `secrets-fn.test.ts` (dev) |

## Debt

- **DEBT-313**: nâng 🟡 ⇒ 🔴 (FAIL gate).
- **DEBT-314 🟡**: xác nhận bằng test. Fail-closed, nên giữ 🟡.
- **DEBT-315 🟡**: xác nhận bằng test. Thông điệp hiện là "Something went wrong. Please try again.".
- **DEBT-316 🟡 mới**: refetch detail lỗi ⇒ toàn bộ thân detail kèm dialog secret bị thay bằng lỗi ⇒ secret mất.
- **DEBT-317 💭 mới**: pagehide khi đang pending bỏ qua chặn đóng ⇒ version mới được tạo mà admin không nhận được thông điệp uncertain.

## File test mới

`fe-admin/test/client-secrets-risk.test.tsx`: 24 case, trong đó 3 `it.fails` cho DEBT-313/314/315 (desired), cần đổi thành `it` sau khi sửa.
