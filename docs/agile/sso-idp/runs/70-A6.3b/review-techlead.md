# Tech Lead Review — 2026-11-06

## Kết luận: PASS

(Đạt sau khi fold — § Fold tech-lead trong `tasks.md` là phần bắt buộc của task, dev làm theo đó.)

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc: giữ mẫu A6.3 (server fn BFF một endpoint cố định + zod input → `adminCall` → client `call` có schema response; hook `useUserWrite`; `ConfirmAction` + `outcomeOf` + `useActionNotice`). Một component mới `features/users/user-roles.tsx`, không thêm abstraction hay dependency. Không có việc [BE]: hợp đồng và seed E2E đã đủ.

## Điểm mạnh

- BE đã xong và chặt (run 69): body là tập admin roles đầy đủ, idempotent, vai trò khác được giữ (DEBT-149); 403 opaque cho self / non-super cấp super / non-super đổi super_admin (điều kiện nằm trong filter nguyên tử, không TOCTOU); 409 qua `SuperAdminGuard` có audit `last_super_admin`.
- Lớp FE sẵn có xử lý `step_up_required`, `uncertain` cho mutation 5xx, cắt `error_description`, không proxy chung.
- Seed `seed:e2e-admin` reset `E2E_USER_EMAIL` về `roles: []` mỗi run, Playwright `workers: 1` ⇒ E2E roles làm được mà không đụng seed BE.

## Security design (trust boundary: UI leo thang quyền)

- Tài sản: vai trò admin của membership tenant. Actor: super_admin, tenant_admin (viewer); target: chính mình / tenant_admin khác / super_admin / user thường / user có vai trò ngoài admin / user ngoài tenant (404).
- Invariant: không ai đổi vai trò của chính mình; chỉ super_admin cấp/gỡ/chạm super_admin; luôn ≥ 1 super_admin active (409); vai trò ngoài admin không mất. BE quyết định; UI chỉ ẩn (viewer roles từ `/admin/me`, có thể cũ ⇒ 403 cố định).
- Abuse: viewer tenant_admin sửa DOM để gửi `super_admin` ⇒ BE 403 (UI không render checkbox — test M1); gửi role lạ / trùng / > 2 ⇒ zod chặn ở server fn (0 fetch); race giáng hai super_admin ⇒ 409 cố định; double-click ⇒ `ConfirmAction.busy`; 5xx ⇒ không tự gửi lại, re-read.
- Exposure: thông điệp 403/409/400 cố định ở FE, `error_description` BE không vào DOM (test M3); không log body; email lọc không vào URL (E2E như spec users).
- Failure: BE/IdP down ⇒ `unavailable` ⇒ ROLES_UNCERTAIN + invalidate; step-up ⇒ `StepUpAlert`, không lưu intent.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không REJECT. Các điểm bắt buộc đã fold vào `tasks.md` (dev PHẢI làm):

- [x] Hợp đồng BE chính xác (body là tập đầy đủ, mã lỗi, ai được gì) — tasks.md § Fold.
- [x] Không dùng `accountGate().protectedTarget` cho roles: tenant_admin được đổi `tenant_admin` của tenant_admin khác theo BE; có test khẳng định.
- [x] Checkbox `super_admin` không render cho viewer tenant_admin; form ẩn khi self hoặc (viewer không super và target là super_admin).
- [x] Body không chứa vai trò ngoài admin; thông điệp lỗi cố định, không lộ description BE.
- [x] Draft reset theo `key` khi vai trò server đổi; nút lưu chỉ khi có thay đổi; dialog liệt kê grant/remove; grant super_admin có cảnh báo `role="alert"`.
- [x] Mutation M1–M4, `pnpm -C fe-admin test`/typecheck/lint/`check:bundle`.
- [x] E2E `fe-admin-roles.spec.ts`: grant → hiệu lực thật (E2E user `GET /admin/users` 403 → 200) → gỡ; `finally` dọn qua API. 409 không dựng tất định (actor luôn là survivor) ⇒ component test + BE int run 69.

## Đề xuất (không bắt buộc)

- DEBT-490 (backlog): Lock UI chưa có thông điệp cố định cho 409 `last_super_admin` (run 69 thêm 409 cho lock) — sweep FE sau.
- Đóng DEBT-335 khi run PASS. DEBT-334 (BE identities/sessions) ngoài phạm vi.
