# Senior Review — 2026-11-07

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Diff đúng fold `tasks.md` + `review-techlead.md`, `be/` không đổi, không `as` mới trong `src/`. Đã kiểm lại độc lập: `pnpm -C fe-admin typecheck` 0, `lint` 0, `test` **1570/1570** (67 file). Mutation M3 tự chạy lại (cast thay `instanceof` ở `user-roles.tsx:109-110`) ⇒ đúng ca B RED (1 failed / 17 passed), khôi phục, hash `git diff` khớp. E2E/X3 không chạy lại: tĩnh đủ kết luận, log dev có M4–M6 + port trống trước/sau.

Điểm tốt:
- Refactor Task 3 không đổi hành vi: `ADMIN_ROLES.some((r) => user.roles.includes(r))` tương đương `user.roles.some((r) => ADMIN_ROLES.includes(r))` (giao khác rỗng); `(["tenant_admin"] as const)` = kết quả `filter` cũ; chuỗi `USER_GONE` giữ nguyên byte. Không có import vòng (`user-account.tsx` không import `user-roles.tsx`).
- Test Task 2 không rỗng: ca A mở form trước rồi mới đổi `getUser` ⇒ `not_found` (đúng điểm tech-lead sửa); ca B assert `noDialog()` nên bắt được đúng mutation "mất nhánh `instanceof`".
- Test E2E Task 6 có 3 lớp chống pass giả: `tampered === 1` (bộ lọc route lệch ⇒ RED), alert **bằng đúng** chuỗi 403 (400 `invalid_request` hay 409 sẽ ra chuỗi khác), roles dev qua API bằng `devBefore`. M5 chứng minh RED.
- `resetRoles` đúng yêu cầu exposure: `catch {}` không bind lỗi, dòng warn cố định chỉ có status.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Authorization / confused deputy (DEBT-494)**: `setUserRoles` (`fe-admin/src/features/admin-api/users.ts:61-63`) chỉ có `inputValidator(SetUserRolesInput)` — schema chấp nhận `super_admin` (`inputs.ts:134-142`), BFF không có cổng vai trò riêng ⇒ 403 trong test thật sự đến từ BE với token của viewer, đúng điều test muốn chứng minh. Đường PATCH BE trực tiếp bằng token tenant_admin đã phủ ở int-spec (theo fold).
- **Failure behavior**: lock 409 ⇒ thông điệp cố định, `msg conflict` (description BE) không vào DOM, không re-read; throw không phải `AdminRequestError` ⇒ đóng dialog + `ROLES_UNCERTAIN`, gửi đúng 1 lần, `boom-xyz` không vào DOM.
- **Exposure trong log E2E**: `resetRoles` không in `err`/token/body; `idOf` chỉ in email seed; `expect(status)` chỉ in số; trace tắt local (`playwright.config.ts`: `trace: CI ? retain-on-failure : off`), CI dùng credential placeholder như các spec sẵn có. Không thấy đường rò mới.
- **State trên `sso-idp-e2e`**: `workers: 1`, `fullyParallel: false` ⇒ không có spec song song thấy E2E user đang là tenant_admin. Cửa sổ trạng thái bẩn còn lại xem 🟡 #1.
- **X3 append (DEBT-509)**: `playwright.x3.config.ts` `workers: 1`, `retries: 0`, Playwright xoá `outputDir` khi bắt đầu ⇒ trong một lần chạy, mỗi ô chỉ được push một lần (worker mới không chạy lại ca đã xong), chạy lại thì file bắt đầu rỗng ⇒ không nhân đôi. Nếu sau này bật `retries > 0`, một ca retry sẽ có 2 ô (failed + passed) — chấp nhận được vì `status` khác nhau, ghi chú để biết.

## 🟡 Nên sửa

1. 🟡 **E2E: trạng thái bẩn trên DB E2E không tự lành** — `e2e/tests/fe-admin-roles.spec.ts:110-114, 163-166`.
   - Grant `tenant_admin` cho target (`:110`) và `browser.newContext()`/`newPage()` (`:112-113`) nằm NGOÀI `try` ⇒ lỗi ở đó bỏ qua `finally`. Test timeout cũng vậy: Playwright bỏ thân test, worker bị huỷ (`retries: 0`) nên `finally` có thể không chạy.
   - `be/src/database/seed-dev.ts:249` chỉ `$setOnInsert: { roles: [] }` ⇒ re-seed KHÔNG trả roles của dev user về `[]`. Nếu một lần chạy bị cắt sau khi dev nhận role (đúng chuyện đã xảy ra ở M5), lần sau `devBefore` là giá trị bẩn: test RED ở `not.toBeChecked()` (không pass giả), nhưng `finally` lại "khôi phục" về chính giá trị bẩn đó ⇒ phải dọn tay mãi.
   - Vì sao: E2E suite dùng DB bền; mọi spec khác dựa vào dev/E2E user không có admin role.
   - Đề xuất: đưa grant + tạo context vào trong `try` (dọn `resetRoles` là idempotent); dùng baseline đã biết của seed: `expect(devBefore, "dev user seeded without admin role").toEqual([])` và `finally` trả dev về `[]` khi khác. ⇒ **DEBT-519**.
2. 🟡 **Quyết định `fe-admin/src/server/auth/bff.ts:50` `export const ADMIN_ROLES`: XOÁ, không gộp.** `git grep ADMIN_ROLES -- fe-admin e2e` cho thấy hằng này **không có tham chiếu nào** (kể cả trong chính `bff.ts`, kể cả test) — export chết, nên câu hỏi server/client bundle không đặt ra. Gộp sang `inputs.ts` vô nghĩa vì không ai dùng. Ngoài phạm vi run 77 (không sửa trong run này) ⇒ **DEBT-518** (-1 dòng; AC `grep "const ADMIN_ROLES" fe-admin/src` = 1 hit).
3. 🟡 ponytail (xem mục ✂️) ⇒ **DEBT-520**.

## 💭 Nit

- `fe-admin/src/features/users/user-roles.tsx:8` import hằng từ module component anh em `user-account.tsx` — chấp nhận theo quyết định tech-lead; nếu số hằng dùng chung tăng thì tách `features/users/messages.ts`.
- `user-account.tsx:7` thứ tự import (`inputs` sau `types`) — linter không bắt, không quan trọng.

## ✂️ Ponytail

- fe-admin/src/server/auth/bff.ts:L50: delete: `export const ADMIN_ROLES` không ai dùng. Không cần thay.
- fe-admin/test/users-roles-ui.test.tsx:L246: shrink: `toBeGreaterThanOrEqual(2)` thừa sau `toBeGreaterThan(reads)` (reads ≥ 1 sau `openDetail`). Bỏ dòng.
- e2e/tests/fe-admin-roles.spec.ts:L174-L177: shrink: `resetRoles` tự dựng context + `adminToken` trùng `superToken` (`:90-93`). Đưa một helper cấp file `freshAdminToken(browser)` cho cả hai.
net: -4 lines possible.
