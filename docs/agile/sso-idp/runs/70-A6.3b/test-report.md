# Test Report — 2026-11-06 (run 70, A6.3b roles UI)

## Kết quả: PASS

fe-admin 1562/1562 · typecheck/lint 0 lỗi · build + `check:bundle` 0 hit · E2E full 37/37 · `fe-admin-roles.spec.ts` ×3 + ma trận tester ×4 (1 + 3) xanh · mutation 2/2 RED, restore sạch.

## Lệnh đã chạy + output thực tế

Cổng :4000/:5173/:3000 kiểm bằng `netstat -ano | grep LISTENING` trước MỖI lần chạy E2E: trống (không có `pnpm dev` của người dùng).

| # | Lệnh | Output |
|---|---|---|
| U1 | `pnpm -C fe-admin test` | `Test Files 67 passed (67)` · `Tests 1562 passed (1562)` · exit 0 |
| U2 | `pnpm -C fe-admin typecheck` / `lint` | exit 0 / exit 0 |
| U3 | `pnpm -C fe-admin build` + `check:bundle` | build exit 0; `check:bundle scanned 23 client files for 8 server env names + 0 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| E1 | `pnpm -C e2e e2e` (config repo, nguyên trạng) | `37 passed (4.0m)`, exit 0; `ok 16 … fe-admin-roles.spec.ts … (4.7s)`. 4 dòng `server function failed … "Invalid client id"` là ca cố ý của `fe-admin-clients.spec.ts` (id sai ⇒ 404), có từ trước |
| E2 | `npx playwright test --config <scratchpad>/pw/playwright.tester.config.ts --project tester-matrix` (spec tester tạm, import nguyên `e2e/playwright.config.ts` + helper `e2e/tests/support/*`; cùng webServer/env E2E, DB `sso-idp-e2e`) | `1 passed (1.3m)` |
| E3 | cùng config, `--repeat-each=3` (project `roles-spec` = `e2e/tests/fe-admin-roles.spec.ts` + `tester-matrix`) | `6 passed (1.9m)`: roles-spec 7.7 s / 5.2 s / 4.9 s; matrix 10.7 s / 10.0 s / 10.2 s |
| M | mutation (xem dưới) | 2/2 RED đúng 1 test; `sha1sum -c` OK, `git diff` trước == sau (`cmp` giống hệt) |

Grep log E1/E2/E3 tìm `eyJ`, mật khẩu E2E, `refresh_token`: 0 hit.

### E2 — ma trận phân quyền qua UI thật (spec tester, KHÔNG ở repo)

Dữ liệu: 3 member seed của tenant E2E — target `E2E_USER_EMAIL`, admin seed (super_admin), dev seed user. Roles ban đầu ghi nhận: `{"target":[],"admin":["super_admin"],"dev":[]}`.

A. Viewer super_admin (admin seed, `signInAsAdmin`):
- `/users/<target>`: region "Admin roles" có `group "Admin roles"` (fieldset/legend), checkbox "Tenant admin" + "Super admin", mỗi cái có accessible description đúng hint; không có nút "Save roles" khi chưa đổi; `status` luôn có.
- Tick Super admin ⇒ "Save roles" ⇒ `alertdialog` có accessible name "Change the admin roles of this user?", có `alert` cảnh báo super admin, "Grant: Super admin"; focus nằm trong dialog; **Cancel** (không ghi) ⇒ dialog đóng, focus về nút "Save roles"; API roles target vẫn `[]`.
- `/users/<admin>` (chính mình): "You cannot change your own roles.", 0 checkbox, 0 group.

B. Viewer tenant_admin (cấp `tenant_admin` cho target qua `PATCH /admin/users/:id/roles` bằng token admin, rồi target đăng nhập fe-admin):
- `/users/<dev>`: có checkbox "Tenant admin"; checkbox `/super admin/i` = 0; text "Super admin" trên trang = 0 (không render, không chỉ disabled).
- Request thủ công có `super_admin` từ phiên tenant_admin: `page.route` sửa body server fn (`tenant_admin` → `super_admin`, đúng 1 request bị sửa) ⇒ BE `PATCH …/roles` 403 ⇒ UI hiện thông điệp cố định "…only a super admin can grant or remove super admin…"; roles dev không đổi.
- `/users/<admin>` (target super_admin): "Only a super admin can change the roles of a super admin.", 0 checkbox.
- `/users/<target>` (chính mình): "You cannot change your own roles.", 0 checkbox.
- PATCH BE trực tiếp bằng token tenant_admin: dev `{roles:["super_admin"]}` ⇒ `403 forbidden`; admin `{roles:["tenant_admin"]}` (giáng super) ⇒ `403 forbidden`; chính mình `{roles:[]}` ⇒ `403 forbidden`; roles dev/admin không đổi.

Dọn (`finally`, có kiểm status 200): target ⇒ `[]`, dev ⇒ như ban đầu; GET lại: `TESTER restored roles {"target":[],"admin":["super_admin"],"dev":[]}` = ban đầu, ở cả 4 lần chạy. Sau đó E1 (seed lại toàn bộ) cũng xanh.

### M — mutation (backup `user-roles.tsx` ngay trước, `cp` restore, `sha1sum -c` + `cmp` `git diff`)

| Mutant | Thay đổi | Kết quả (`vitest run users-roles-ui/users-ui/users-risk`) |
|---|---|---|
| MA | `const shown = ADMIN_ROLES;` (checkbox super cho cả tenant_admin) | RED: `viewer tenant_admin > no Super admin checkbox at all (not even disabled)` — 1 failed / 84 passed |
| MB | `canEdit: writable && !self,` (tenant_admin có form trên target super_admin) | RED: `viewer tenant_admin > target holds super_admin: no form, fixed text` — 1 failed / 84 passed |

## Test FAIL (nếu có)

Không có.

## Coverage acceptance criteria

- [x] Task 1 — server fn + UI roles: U1 (component 16 + server fn 13 của dev), E2 A/B (UI thật), E3.
- [x] Checkbox super chỉ cho viewer super (không render): E2 B, MA.
- [x] self / target super_admin với viewer tenant_admin ⇒ không form + text: E2 A/B, MB.
- [x] tenant_admin được đổi `tenant_admin` người khác (không dùng `protectedTarget`): E2 B (dev có form).
- [x] 403 thông điệp cố định: E2 B (request sửa tay qua BFF thật); 409/400/5xx/step-up: component test (U1) — 409 không dựng tất định (tasks.md).
- [x] Body chỉ vai trò admin: U1 (ca `auditor`).
- [x] a11y: fieldset/legend (`group`), label checkbox, hint `aria-describedby`, dialog có tên, focus vào dialog + về trigger khi Cancel: E2 A. Không có `@axe-core/playwright` trong repo ⇒ không cài, kiểm bằng accessibility tree/`ariaSnapshot`.
- [x] Task 2 — E2E grant 403 → 200 → remove: E1, E3 ×3.
- [x] Regression: U1–U3, E1 37/37.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | super_admin, tenant_admin, user không vai trò (403 → 200), self | E2 A/B, E1 roles |
| Authorization | escalation lên super (UI + BFF sửa body + BE trực tiếp), giáng super bởi tenant_admin, tự đổi mình | E2 B |
| Input | body bị sửa sau UI (BFF chuyển tiếp, BE chặn); enum/trùng/>2/field lạ chặn trước BE | E2 B, U1 (`users-fn`) |
| State | draft khác server mới có nút; Cancel không ghi; idempotent dọn | E2 A, E2 dọn |
| Request chain | token MỚI sau grant có hiệu lực (200) | E1/E3 roles-spec |
| Exposure | thông điệp 403 cố định trên UI; log E2E 0 hit token/mật khẩu | E2 B, grep log |
| Dependency | 5xx ⇒ ROLES_UNCERTAIN, gửi 1 lần | U1 (component) |

Debt mới: **DEBT-494** (🟡, ma trận viewer tenant_admin chỉ có trong script tester tạm ⇒ nên đưa vào repo spec). Script/spec tạm nằm ở scratchpad, không có file nào trong repo (`git status` như trước khi test, cộng file này + `backlog.md`/`log.md`/`STATUS.md`).
