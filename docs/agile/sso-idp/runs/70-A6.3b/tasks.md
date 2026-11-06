# Tasks — run 70 — A6.3b đổi vai trò user trong fe-admin (M5/M7, lane ADMIN)

> Nguồn: `plan.md` A6.3 (Users & sessions) — phần roles tách thành A6.3b ở run 47 (`runs/47-A6.3/summary.md`, DEBT-335); quyết định đã chốt `plan.md` §12 "Chốt bổ sung 2026-11-06": DEBT-149 (PATCH chỉ thay `tenant_admin`/`super_admin`, giữ vai trò khác), DEBT-142 (luôn còn ≥ 1 super_admin active ⇒ BE trả 409 `conflict` mô tả cố định). BE đã xong ở run 69 (`runs/69-decided-be/`, OpenAPI `fe-admin/openapi/admin.json` đã regenerate). Kéo các DEBT trong `backlog.md` thuộc phạm vi roles UI (DEBT-335 và liên quan).
>
> Tech-lead: xác định hợp đồng BE thật (`PATCH /admin/users/:id/roles` body/response/lỗi 400/403/404/409/`step_up_required`), quyền ai được đổi gì (tenant_admin vs super_admin, escalation run 27), UI theo mẫu A6.3 hiện có (server fn BFF, form, xác nhận cho hành động nguy hiểm, thông điệp 409 "phải còn ít nhất một super_admin", step-up), a11y; E2E cho luồng đổi vai trò (seed E2E có user phù hợp?). Cách chứng minh: unit/component test, mutation, `pnpm -C fe-admin test`, typecheck/lint, `check:bundle`, E2E (+ ca mới).
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop `aegate-*` (E2E tự seed DB `sso-idp-e2e` như script vẫn làm); không seed/sync DB dev `sso-idp`; KHÔNG `drop-int-orphans.mjs`; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; mutation: backup NGAY trước khi mutate, restore xong so `git diff`; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` người dùng (kiểm cổng :4000/:5173/:3000 trước E2E; đang dùng ⇒ dừng và báo); không commit.

### [x] Task 1 [FE]: A6.3b — server fn BFF + UI đổi vai trò (tenant_admin/super_admin) trên trang chi tiết user, xử lý 409/403/step-up.
### [x] Task 2 [FE/E2E]: E2E luồng đổi vai trò (thành công + 409 last super_admin nếu dựng được).

## § Fold tech-lead (bắt buộc — 2026-11-06)

### Hợp đồng BE thật (đọc từ `be/src/modules/admin/admin-users.controller.ts:301-360`, `admin.dto.ts:219-230`, `admin-auth.errors.ts`, `fe-admin/openapi/admin.json` `/admin/users/{id}/roles`)

- `PATCH /admin/users/:id/roles`, `admin.write` + `RequireRecentAuth(5)`. Body `{ roles: ("tenant_admin"|"super_admin")[] }` (≤ 2, unique; field lạ/giá trị lạ ⇒ 400 `invalid_request`). Là **tập đích đầy đủ của vai trò admin** (không phải delta); vai trò ngoài admin được BE giữ (DEBT-149). Idempotent (gửi lại cùng tập = cùng kết quả, không audit thêm).
- 200 ⇒ `AdminUserView` (= `AdminUserSchema` hiện có; `roles` = vai trò khác + tập mới).
- 403 `forbidden` (opaque, không phân biệt lý do): target là chính mình; viewer không phải super_admin mà body có `super_admin`; viewer không phải super_admin mà target **đang** giữ `super_admin` (điều kiện nằm trong filter nguyên tử). 403 `step_up_required` khi `auth_time` > 5 phút. 404 `not_found`: id sai định dạng / không thuộc tenant (cross-tenant = missing). 409 `conflict` (mô tả cố định BE): super_admin gỡ `super_admin` khiến tenant không còn super_admin active — chỉ xảy ra khi race hai super_admin giáng nhau (actor luôn là survivor) ⇒ **không dựng được tất định trong E2E**. 5xx ⇒ `unavailable` (uncertain cho mutation).
- tenant_admin ĐƯỢC cấp/gỡ `tenant_admin` cho người khác (kể cả một tenant_admin khác) — đúng hợp đồng BE; UI KHÔNG được dùng `accountGate().protectedTarget` (gate của lock) để ẩn form roles.
- Viewer roles trong BFF lấy từ `/admin/me` (làm mới ở mỗi refresh) — chỉ là gợi ý UX; BE quyết định (403 ⇒ thông điệp cố định).

### Task 1 [FE] — điểm sửa

1. `features/admin-api/inputs.ts`: `SetUserRolesInput = z.object({ userId: UserIdSchema, roles: z.array(z.enum(["tenant_admin","super_admin"])).max(2) }).strict()` + refine không trùng; type `SetUserRolesParams`.
2. `server/admin-api/client.ts`: `setUserRoles(ctx, userId, roles)` → một `call` cố định `PATCH`, route template `/admin/users/:id/roles`, path `userPath(userId) + "/roles"`, body `{ roles }`, schema `AdminUserSchema` (theo cách các PATCH hiện có truyền body). Không log body.
3. `features/admin-api/users.ts`: `setUserRoles = createServerFn({ method: "POST" }).inputValidator(SetUserRolesInput)...`; `hooks.ts`: `useSetUserRoles = () => useUserWrite<SetUserRolesParams, AdminUser>(setUserRoles)` (invalidate `users.all` như các write khác).
4. Component mới `features/users/user-roles.tsx` (`UserRoles`), render trong `routes/users/$userId.tsx` cạnh `UserAccount` (cùng `viewer`, `path`, `writable`). Section `<h2 id="roles-title">Admin roles</h2>` + `useActionNotice` (status region riêng, focus heading sau khi xong).
   - Gate thuần, export để test: `rolesGate(viewer, user)` ⇒ `self` (so khớp sub không phân biệt hoa thường như `accountGate`), `canEdit = writable && !self && (viewerSuper || !user.roles.includes("super_admin"))`, `showSuper = viewerSuper`.
   - `self` ⇒ chỉ text "You cannot change your own roles." (không checkbox). Viewer không super + target có `super_admin` ⇒ "Only a super admin can change the roles of a super admin." `!writable` ⇒ không form.
   - Form: `<fieldset><legend>Admin roles</legend>` với checkbox có `<label>` gắn `htmlFor`: "Tenant admin" (`tenant_admin`), và **chỉ khi `showSuper`** "Super admin" (`super_admin`) — không render (không chỉ disabled) cho viewer tenant_admin. Mỗi checkbox có hint qua `aria-describedby` (tenant admin: quản trị tenant này; super admin: mọi tenant, resource, khóa ký).
   - Body gửi = các checkbox admin đang tick, thứ tự cố định `["tenant_admin","super_admin"]`; viewer không super không bao giờ gửi `super_admin`; không gửi vai trò khác (BE giữ).
   - Draft reset khi vai trò admin trên server đổi: đặt `key` = admin roles đã sort của `user` (remount, không `useEffect` đồng bộ) ⇒ refetch/thành công không để draft cũ lệch base.
   - Nút lưu = `ConfirmAction` trigger "Save roles", chỉ render khi draft khác server (không đổi ⇒ không có nút). Dialog liệt kê rõ "Grant: …" / "Remove: …". Cấp `super_admin` ⇒ `destructive` + `warning` `role="alert"` ("Super admin can manage every tenant, every resource and the signing keys."). Gỡ `super_admin` ⇒ thêm câu "The tenant must keep at least one active super admin." Không thêm `confirmText` (không over-engineer).
   - Kết quả (`run`): thành công ⇒ `{done: "Roles updated. They apply on the user's next request."}`; lỗi qua `outcomeOf(err, ROLES_UNCERTAIN, BY_CODE)` với **thông điệp FE cố định** (không hiện `error_description` BE): `forbidden` ⇒ "You cannot make this change: only a super admin can grant or remove super admin or change a super admin, and nobody can change their own roles."; `conflict` ⇒ "Not changed: the tenant must keep at least one active super admin."; `invalid_request` ⇒ "The roles were rejected. Reload the page and try again."; `not_found` ⇒ như `refused()` của user-account (invalidate + done). `uncertain`/throw ⇒ đóng dialog, `{done: ROLES_UNCERTAIN}` = "The roles may not have been changed. The current roles are shown below; check them before trying again." (không tự gửi lại). `step_up_required` ⇒ `StepUpAlert` sẵn có của `ConfirmAction` (không lưu intent; chọn lại checkbox sau khi xác nhận danh tính là chấp nhận được — ghi trong JSDoc).
   - Facts "Roles" trong `UserAccount` giữ nguyên.
5. Verify Task 1 — component test (`test/users-roles-ui.test.tsx` hoặc mở rộng `users-ui.test.tsx`) + server fn (`users-fn.test.ts`):
   - viewer super: thấy 2 checkbox; grant tenant_admin ⇒ fetch đúng `PATCH /admin/users/<id>/roles` body `{"roles":["tenant_admin"]}`; grant super ⇒ dialog có alert; gỡ hết ⇒ body `{"roles":[]}`.
   - viewer tenant_admin: không có checkbox "Super admin" (`queryByRole("checkbox",{name:/super admin/i})` null); target có `super_admin` ⇒ không form; target là tenant_admin khác ⇒ CÓ form (khẳng định không dùng `protectedTarget`); target `["auditor","tenant_admin"]` gỡ tenant_admin ⇒ body `{"roles":[]}` (không chứa `auditor`).
   - self ⇒ không form, có text. Không đổi ⇒ không có nút "Save roles".
   - 403/409/400 ⇒ đúng chuỗi cố định, và `error_description` BE giả lập (vd. "secret-desc-xyz") KHÔNG xuất hiện trong DOM. 5xx ⇒ dialog đóng + ROLES_UNCERTAIN, PATCH gửi đúng 1 lần. step_up ⇒ StepUpAlert, không ghi sessionStorage `fea:stepup`.
   - server fn: `roles:["owner"]`, trùng lặp, > 2 phần tử, field thừa, userId sai ⇒ bị chặn trước BE (0 fetch).
   - a11y: fieldset/legend, label, hint `aria-describedby`, focus về `roles-title` sau xong, status region luôn render.
   - Mutation (backup ngay trước, restore, so `git diff`): (M1) render checkbox super bất kể `showSuper` ⇒ test tenant_admin RED; (M2) bỏ check `self` ⇒ test self RED; (M3) đưa `err.message` vào thông điệp 409 ⇒ test "không lộ description" RED; (M4) gửi cả vai trò không-admin trong body ⇒ test `auditor` RED.
   - `pnpm -C fe-admin test`, `typecheck`, `lint`, `check:bundle` xanh (không thêm dependency).

### Task 2 [FE/E2E] — điểm sửa (KHÔNG cần sửa seed BE ⇒ không có việc [BE])

- `seed:e2e-admin` đã reset `E2E_USER_EMAIL` về membership `{active, roles: []}` mỗi run; admin seed là super_admin; Playwright `workers: 1`.
- Spec mới `e2e/tests/fe-admin-roles.spec.ts`: đầu test lấy token admin của E2E user (context riêng) và ghi nhận `GET /admin/users` ⇒ 403; admin đăng nhập fe-admin (`signInAsAdmin`), lọc email `E2E_USER_EMAIL` (email không vào URL), mở chi tiết, tick "Tenant admin" ⇒ "Save roles" ⇒ confirm ⇒ status "Roles updated…"; API (`adminApi` GET `/users/:id`) có `tenant_admin`; **chứng minh hiệu lực**: token admin MỚI của E2E user gọi `GET /admin/users` ⇒ 200; bỏ tick ⇒ save ⇒ API `roles` = `[]`. `finally`: `PATCH /users/:id/roles {roles: []}` bằng token admin API (dọn cho spec khác dù fail giữa chừng). Mọi UI write trong ~50 s sau sign-in (`ACCESS_TOKEN_TTL=120`, xem JSDoc spec users).
- 409 không dựng tất định ⇒ phủ bằng component test (Task 1) + BE int/race run 69; ghi rõ trong JSDoc spec.
- Verify: `pnpm -C e2e e2e` toàn bộ xanh (36 → 37), kiểm cổng :4000/:5173/:3000 trước khi chạy theo § Ràng buộc.

### Đóng debt
- Khi PASS: đóng DEBT-335. DEBT-334 KHÔNG thuộc run này (BE identities/sessions) — giữ nguyên. Mới: DEBT-490 (backlog).
