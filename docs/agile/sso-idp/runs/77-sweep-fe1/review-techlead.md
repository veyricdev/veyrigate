# Tech Lead Review — 2026-11-07

## Kết luận: PASS

Chi tiết thực thi (file:line, chuỗi chính xác, AC, mutation) đã fold vào `tasks.md`. Đã kiểm code hiện tại bằng CodeGraph (`user-account.tsx`, `user-roles.tsx`, `inputs.ts`, `confirm-action.tsx`, `hooks.ts`, `types.ts`, `admin-users.controller.ts`, `admin-auth.errors.ts`, `users-roles-ui.test.tsx`, `users-ui.test.tsx`, `e2e/tests/fe-admin-roles.spec.ts`, `e2e/tests/support/{fe-admin,admin}.ts`, `e2e/x3/cookie-matrix.spec.ts`).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Toàn bộ run là test/E2E + FE nhỏ; `be/` KHÔNG đổi.

Quyết định đã chốt (người dùng ủy quyền, tiêu chí production):

- **Task 6 (DEBT-494): LÀM trong run này, thu hẹp.** Lý do: repo E2E chưa hề có phiên fe-admin của một **tenant_admin** thật (mọi spec đăng nhập super_admin; roles của viewer lấy từ `/admin/me` trong `fe-admin/src/server/auth/bff.ts:195-226` chưa được chứng minh end-to-end cho vai trò này), và tính chất bảo mật "BFF chỉ chuyển token của chính người dùng, không là confused deputy" chỉ chứng minh được bằng request BFF bị sửa trên stack thật. Phần "PATCH BE trực tiếp bằng token tenant_admin ⇒ 403 ×3" **KHÔNG** đưa vào E2E: đã phủ ở `be/test/admin-users.int-spec.ts:748` (trùng lặp, tốn thời gian suite). Làm thành **test thứ hai, độc lập** trong `fe-admin-roles.spec.ts` (không chèn vào test hiện có: chèn một lần đăng nhập ~20 s giữa bước 4 và 5 sẽ phá ràng buộc "mọi write UI < 50 s sau sign-in admin", `fe-admin-roles.spec.ts:72`).
- **Task 1**: `BY_CODE` của `user-account.tsx` dùng chung cho lock/unlock/revoke-all; chỉ `lock` có thể nhận 409 (`guarded` chỉ gọi ở `admin-users.controller.ts:168` cho lock và `:327` cho roles) ⇒ thêm `conflict` vào `BY_CODE` chung là đủ, không tách map riêng.
- **Task 3**: tạo hằng chung ở `user-account.tsx` (`USER_GONE`), `user-roles.tsx` import từ đó; KHÔNG đụng `routes/users/$userId.tsx:14` (`NOT_FOUND` khác chuỗi, khác ngữ cảnh: tải lần đầu).
- **Thứ tự**: 1 → 2 → 3 (test của Task 2 phải xanh TRƯỚC refactor Task 3 để làm lưới an toàn) → 4 → 6 (dùng helper dọn của Task 4) → 5.

## Điểm mạnh

- Phạm vi đúng sweep 🟡, không lan sang BE.
- Mỗi debt có đề xuất cụ thể, khớp code hiện tại (đã kiểm: `user-roles.tsx:28/39/100/109`, `user-account.tsx:23/36-39`, `inputs.ts:128`, `fe-admin-roles.spec.ts:76-82`, `cookie-matrix.spec.ts:30-49` — số dòng backlog của DEBT-509 lệch nhẹ, đã ghi số đúng vào `tasks.md`).
- Run 76 (409 client console) không chạm `user-account.tsx`; run 69/70 roles đã có, khớp backlog.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm sau đã được sửa thẳng vào `tasks.md` (dev PHẢI theo):

- [x] Task 2 ca `writable=false` như mô tả gốc ("`getUser` ⇒ `not_found` ⇒ không form") **là test rỗng**: khi lần tải đầu đã `not_found` thì `query.data === undefined` và `UserRoles` không được mount (`$userId.tsx:68-74`), bỏ `writable &&` (`user-roles.tsx:28`) vẫn xanh. Ca đúng: dữ liệu đã tải, rồi một write trả `not_found` ⇒ re-read `not_found` ⇒ TanStack giữ `data` + có `error` ⇒ `writable=false`.
- [x] Task 2 ca throw không phải `AdminRequestError`: assert phải là **dialog đóng + status = `ROLES_UNCERTAIN`**, không chỉ "có chữ ROLES_UNCERTAIN" — vì khi bỏ nhánh `instanceof`, `outcomeOf` vẫn trả `{error: ROLES_UNCERTAIN}` (hiện TRONG dialog), chỉ khác ở chỗ dialog không đóng.
- [x] Task 3 `ADMIN_ROLES` của `inputs.ts` là tuple `readonly ["tenant_admin","super_admin"]` ⇒ `ADMIN_ROLES.includes(r)` với `r: string` lỗi typecheck; dùng `ADMIN_ROLES.some((r) => user.roles.includes(r))`, cấm ép kiểu `as`.
- [x] Task 4 cảnh báo dọn không được in `err.message` (lỗi từ `adminToken` có thể mang body BE): dòng cố định + status, hoặc dòng cố định khi throw.
- [x] Task 6 request BFF bị sửa phải được **đếm** (≥ 1, đúng 1) để test không xanh rỗng khi bộ lọc route không khớp.

## Đề xuất (không bắt buộc)

- Không thêm debt mới. Phần ×3 PATCH BE trực tiếp của DEBT-494 coi như đã phủ bởi int-spec (ghi khi đóng DEBT-494).
