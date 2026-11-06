# Senior Review — 2026-11-06

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Diff gọn, bám đúng § Fold tech-lead và mẫu A6.3 sẵn có: một server fn POST → `adminCall` (token chỉ ở BFF) → một `call` PATCH cố định `/admin/users/:id/roles` có schema `AdminUserSchema`; hook `useUserWrite` (invalidate `users.all`, không retry); một component `user-roles.tsx` dùng lại `ConfirmAction`/`outcomeOf`/`useActionNotice`. Không thêm dependency hay abstraction. Kiểm lại: `pnpm -C fe-admin test` 67 file / 1562 test xanh, `typecheck` + `lint` sạch.

Điểm tốt: `rolesGate` thuần, export để test; checkbox `super_admin` không render (không chỉ disabled) cho viewer không super; body luôn lọc qua `ADMIN_ROLES` theo thứ tự cố định nên không thể mang vai trò ngoài admin; draft reset qua `key` (không `useEffect` đồng bộ); test DOM khẳng định `error_description` giả ("secret-desc-xyz") không xuất hiện cho 403/409/400/step-up.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Authorization (UX gate, BE quyết định)**: `rolesGate` (`user-roles.tsx:23-31`) khớp hợp đồng BE run 69: `self` so sub không phân biệt hoa thường (như `accountGate`); `canEdit = writable && !self && (viewerSuper || !target.super_admin)`; `showSuper = viewerSuper`. Không dùng `protectedTarget` — test "target is another tenant_admin: the form IS offered" khẳng định. Viewer tenant_admin không thể gửi `super_admin` từ UI: `shown` loại `super_admin` và `draft` khởi tạo từ `current` của target không có `super_admin` (canEdit chặn target super). Sửa DOM/gọi server fn trực tiếp ⇒ BE 403 opaque.
- **Lệch fold (`writable` là tham số thứ 3 của `rolesGate`)**: hợp lý — fold ghi `canEdit = writable && ...` nhưng chữ ký 2 tham số; đưa `writable` vào gate giữ một chỗ quyết định, không đổi ngữ nghĩa.
- **Boundary input**: `SetUserRolesInput` strict, `z.enum(ADMIN_ROLES)`, `.max(2)`, refine không trùng, `UserIdSchema`; test server fn: role lạ / trùng / > 2 / field thừa (`tenantId`) / id `../x` / thiếu roles ⇒ throw, 0 fetch.
- **Exposure**: 403/409/400 có chuỗi FE cố định trong `BY_CODE`; `not_found`/`step_up_required`/uncertain xử lý riêng; mã còn lại (`unauthenticated`, `unavailable` không uncertain) rơi về `err.message` là văn bản cố định theo mã ở BFF (`AdminApiFailure` chỉ chở description cho `invalid_request`/`conflict` — cả hai đã có chuỗi cố định). Client không log body (`client.ts` chỉ log route template).
- **Failure behavior**: 5xx/2xx lệch schema ⇒ `uncertain` (test server fn), UI đóng dialog + `ROLES_UNCERTAIN`, PATCH gửi đúng 1 lần (test), invalidate để đọc lại; throw không phải `AdminRequestError` cũng ⇒ uncertain. Double-click chặn bởi `ConfirmAction.busy`.
- **Step-up**: `step_up_required` ⇒ `StepUpAlert`, không lưu intent (`fea:stepup` null — test), đã ghi JSDoc.
- **E2E**: chứng minh hiệu lực thật (token mới của target 403 → 200), email không vào URL UI; `finally` dọn qua API bằng token mới; không phụ thuộc thứ tự (seed reset mỗi run, `workers: 1`).
- **A11y**: `fieldset/legend`, `label htmlFor`, hint `aria-describedby`, status region luôn render, focus về `roles-title` (`tabIndex=-1`) sau xong, cảnh báo grant super `role="alert"`, dialog là `AlertDialog` (focus trap + trả focus về trigger khi Cancel).

## 🟡 Nên sửa

- [ ] `e2e/tests/fe-admin-roles.spec.ts:76-79` — dọn `finally` nuốt mọi lỗi (`.catch(() => undefined)`) và không kiểm status của PATCH dọn. Vì sao: nếu dọn thất bại (token, 4xx), E2E user còn `tenant_admin` mà không ai biết; spec khác trong cùng lượt có thể chạy với target là admin (vd. Lock ⇒ `protectedTarget`) và fail khó hiểu. Đề xuất: giữ không-throw nhưng `console.warn` một dòng cố định ("roles cleanup failed: <status>") khi status ≠ 200 hoặc khi throw (không in token). → DEBT-491.
- [ ] `fe-admin/test/users-roles-ui.test.tsx` — thiếu ca `writable=false` (user `not_found` ⇒ `gone`) không có form, và ca `mutateAsync` throw lỗi không phải `AdminRequestError` ⇒ `ROLES_UNCERTAIN`. Vì sao: bỏ `writable &&` khỏi `canEdit` (`user-roles.tsx:28`) hay nhánh `instanceof` (`:109`) không làm test nào RED. Đề xuất: thêm 2 ca, mock `getUser` trả `not_found` sau lần đầu / `setRoles.mockRejectedValue(new Error())`. → DEBT-492.

## 💭 Nit

- `user-roles.tsx:66-68` — text "Only a super admin can change the roles of a super admin." hiện cả khi viewer stale (roles `/admin/me` cũ); chấp nhận được vì BE quyết định, chỉ ghi nhận.

## ✂️ Ponytail

- fe-admin/src/features/users/user-roles.tsx:39: shrink: `NOT_FOUND` lặp lại đúng chuỗi `BY_CODE.not_found` của `user-account.tsx`. Export một hằng dùng chung (hoặc dùng lại `refused()` pattern) để hai chỗ không lệch.
- fe-admin/src/features/users/user-account.tsx:23: shrink: `const ADMIN_ROLES` cục bộ trùng `ADMIN_ROLES` vừa export ở `inputs.ts:128`. Import từ `inputs.ts`.
- fe-admin/src/features/users/user-roles.tsx:100: shrink: `ADMIN_ROLES.filter((r) => r !== "super_admin")` ⇒ `["tenant_admin"] as const` (hoặc `ADMIN_ROLES.slice(0, 1)`).
net: -4 lines possible.

(Ba dòng ponytail gộp thành DEBT-493.)
