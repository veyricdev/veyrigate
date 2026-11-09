# Run 77 — sweep 🟡 FE/E2E đợt 1 (M7, lane FE)

Nguồn: backlog DEBT-490, 491, 492, 493, 494, 509 (mô tả + đề xuất chi tiết trong `backlog.md`). Analyst bỏ qua. Quyết định: người dùng ủy quyền orchestrator chốt theo tiêu chí production (`plan.md` §12). Tech-lead PASS 2026-11-07 (`review-techlead.md`), chi tiết bên dưới là bắt buộc.

**Thứ tự**: 1 → 2 → 3 → 4 → 6 → 5. `be/` KHÔNG đổi. Không ép kiểu `as` mới trong `src/`. Không in token/mật khẩu/`err.message` của BE ở test/E2E.

## Task 1 [FE] DEBT-490 — lock 409 `last_super_admin` thông điệp cố định

- [x] Xong (frontend-dev 2026-11-07)

- `fe-admin/src/features/users/user-account.tsx:36-39` `BY_CODE` thêm đúng chuỗi: `conflict: "Not locked: the tenant must keep at least one active super admin."`. (Chỉ `lock` có thể 409: BE `admin-users.controller.ts:168` `guarded`; unlock/revoke-all không bao giờ 409 ⇒ map chung là đủ.)
- Test `fe-admin/test/users-ui.test.tsx` cạnh ca `"lock forbidden: fixed message in the dialog, no re-read"` (`:381`): `it("lock conflict (last super admin): fixed message in the dialog, the BE description never in the DOM")` — `user = { ...USER, roles: ["super_admin"] }`, `mocks.lock.mockResolvedValue(fail("conflict"))`, `confirmIn(button("Lock"), "Lock account")`; assert `alert` trong dialog `textContent` **bằng đúng** chuỗi trên; `document.body.textContent` không chứa `"msg conflict"`; `mocks.lock` gọi 1 lần; không re-read (như ca forbidden).
- **Mutation M1**: xoá dòng `conflict` ⇒ ca mới RED (DOM hiện `msg conflict`).
- verify: `pnpm -C fe-admin typecheck && pnpm -C fe-admin lint && pnpm -C fe-admin test`.

## Task 2 [FE] DEBT-492 — test roles thiếu ca

- [x] Xong (frontend-dev 2026-11-07)

Trong `fe-admin/test/users-roles-ui.test.tsx`, `describe("outcomes")`:

- **Ca A (writable=false)** — KHÔNG dùng "`getUser` ⇒ `not_found` ngay lần đầu" (khi đó `query.data` undefined, `UserRoles` không mount, `$userId.tsx:68-74` ⇒ test rỗng). Đúng: `it("not_found then the re-read is not_found too: the form is gone (writable=false), the notice stays")` — `openDetail()` với `getUser` ok; SAU khi mở, `vi.mocked(getUser).mockResolvedValue(fail("not_found") as never)` và `setRoles.mockResolvedValue(fail("not_found") as never)`; tick Tenant admin, `save()`, `noDialog()`; `await waitFor(() => expect(within(roles()).queryByRole("checkbox")).toBeNull())`; `saveButton()` null; status `roles()` = `"This user no longer exists in this tenant."`; `getUser` được gọi lại (≥ 2 lần).
- **Ca B (throw không phải `AdminRequestError`)** — `it("a throw that is not an AdminRequestError (BFF/network) => dialog closes, ROLES_UNCERTAIN, sent once")`: `setRoles.mockRejectedValue(new Error("boom-xyz"))`; tick, `save()`; **`noDialog()`** (bắt buộc: khi mất nhánh `instanceof`, `outcomeOf` vẫn trả `ROLES_UNCERTAIN` nhưng TRONG dialog); status = `ROLES_UNCERTAIN`; chờ 30 ms, `setRoles` gọi đúng 1 lần; `document.body.textContent` không chứa `"boom-xyz"`.
- **Mutation M2**: `user-roles.tsx:28` bỏ `writable && ` ⇒ Ca A RED. **M3**: `user-roles.tsx:109` đổi thành `if ((err as AdminRequestError).uncertain) return { done: ROLES_UNCERTAIN };` (và `:110` `(err as AdminRequestError).code`) ⇒ Ca B RED. Khôi phục, `git diff` sạch ngoài phần sửa thật.

## Task 3 [FE] DEBT-493 — ponytail roles/account (không đổi hành vi)

- [x] Xong (frontend-dev 2026-11-07)

- `user-account.tsx`: thêm `export const USER_GONE = "This user no longer exists in this tenant.";`; `BY_CODE.not_found: USER_GONE`; xoá `const ADMIN_ROLES` cục bộ (`:23`), import `ADMIN_ROLES` từ `@/features/admin-api/inputs`; `accountGate` (`:32`): `protectedTarget: !viewer.roles.includes("super_admin") && ADMIN_ROLES.some((r) => user.roles.includes(r))` (tuple readonly ⇒ KHÔNG `ADMIN_ROLES.includes(r: string)`, KHÔNG `as`).
- `user-roles.tsx`: xoá `NOT_FOUND` (`:39`), dùng `USER_GONE` import từ `./user-account` (`:112`); `:100` thành `const shown = showSuper ? ADMIN_ROLES : (["tenant_admin"] as const);` (`as const` là literal, không phải ép kiểu).
- KHÔNG đụng `routes/users/$userId.tsx:14` (chuỗi khác, ngữ cảnh tải lần đầu).
- AC: `grep -rn "no longer exists in this tenant" fe-admin/src` = 1 hit; `grep -rn "const ADMIN_ROLES" fe-admin/src` = 1 hit (`inputs.ts`); toàn bộ test fe-admin xanh không sửa test (gồm Task 1/2); typecheck/lint 0.

## Task 4 [E2E] DEBT-491 — dọn `finally` có cảnh báo

- [x] Xong (frontend-dev 2026-11-07)

- `e2e/tests/fe-admin-roles.spec.ts:76-82`: tách helper cấp file `async function resetRoles(browser: Browser, userId: string, roles: string[]): Promise<void>` — context mới, `adminToken(ctx)` (token mới), `adminApi(fresh, "PATCH", \`/users/${userId}/roles\`, { roles })`; status ≠ 200 ⇒ `console.warn(\`fe-admin-roles cleanup: PATCH roles answered ${status}; a seeded user may keep an admin role\`)`; throw ⇒ `console.warn("fe-admin-roles cleanup: failed before an answer; a seeded user may keep an admin role")` (KHÔNG in `err`, `err.message`, token, body). Không throw; luôn đóng context.
- verify: chạy spec xanh; **mutation M4** (tạm, không commit): body `{ roles: ["x"] }` ⇒ log có dòng warn với `400`, test vẫn xanh; khôi phục. Grep output Playwright `eyJ`/mật khẩu E2E: 0 hit.

## Task 6 [E2E] DEBT-494 — viewer tenant_admin qua UI thật (LÀM, thu hẹp)

- [x] Xong (frontend-dev 2026-11-07)

- `e2e/tests/support/fe-admin.ts:8` `signInAsAdmin(page, email = ADMIN_SEED_EMAIL, password = ADMIN_SEED_PASSWORD)` (mặc định giữ hành vi mọi caller hiện có).
- Test MỚI thứ hai trong `fe-admin-roles.spec.ts` (không chèn vào test hiện có: phá ràng buộc < 50 s ở `:72`): `test("fe-admin roles: a tenant_admin viewer gets the gates, and a tampered BFF request is refused (403)", ...)`, `test.setTimeout(120_000)`:
  1. Token super_admin (API) ⇒ id của `E2E_USER_EMAIL` (target/viewer), `ADMIN_SEED_EMAIL`, `DEV_SEED_EMAIL` qua `GET /users?email=`; ghi `devBefore = roles của dev`; assert target roles `[]`.
  2. `PATCH /users/{e2eUser}/roles {roles:["tenant_admin"]}` (API) ⇒ 200.
  3. `try`: context mới, `goto(FE_ADMIN_URL/users)`, `signInAsAdmin(page, E2E_USER_EMAIL, E2E_USER_PASSWORD)`.
     - `/users/{e2eUser}` (self): vùng "Admin roles" có text `You cannot change your own roles.`, 0 checkbox.
     - `/users/{adminSeed}` (super_admin): `Only a super admin can change the roles of a super admin.`, 0 checkbox; vùng Account có `Only a super admin can change this account.`, không nút Lock.
     - `/users/{dev}`: đúng 1 checkbox (`Tenant admin`), 0 checkbox `/super admin/i`.
     - `page.route` lên POST `/_serverFn*` có `postData` chứa id dev và `tenant_admin` ⇒ `route.continue({ postData: body.replaceAll("tenant_admin", "super_admin") })`, đếm `tampered++` (request khác `route.continue()` nguyên vẹn). Tick Tenant admin, Save roles, Change roles ⇒ `alert` trong dialog **bằng đúng** `"You cannot make this change: only a super admin can grant or remove super admin or change a super admin, and nobody can change their own roles."`; `expect(tampered).toBe(1)`; roles của dev qua API (token super_admin mới nếu cần) **bằng** `devBefore`.
  4. `finally`: đóng context; `resetRoles(browser, e2eUser, [])`; nếu roles dev ≠ `devBefore` ⇒ `resetRoles(browser, dev, devBefore)`.
- Không gọi PATCH BE trực tiếp bằng token tenant_admin (đã phủ `be/test/admin-users.int-spec.ts:748`). Không log token/mật khẩu.
- **Mutation M5** (tạm): bỏ `replaceAll` (route chỉ `continue()`) ⇒ assert alert/`tampered`/roles dev RED theo đúng chỗ (write hợp lệ thành công); khôi phục, chạy dọn xác nhận dev về `devBefore`.
- verify: `pnpm -C e2e e2e` full **38/38** (37 + 1), chạy riêng spec ×3 xanh.

## Task 5 [E2E] DEBT-509 — X3 matrix không mất ô khi worker restart

- [x] Xong (frontend-dev 2026-11-07)

- `e2e/x3/cookie-matrix.spec.ts:39-49` `afterAll`: nối thay vì ghi đè — `const prev = (all[testInfo.project.name] as { cells?: unknown[] } | undefined)?.cells ?? [];` rồi `cells: [...prev, ...cells]` (version/date ghi lại như cũ). Không thêm hook/biến môi trường mới vào sản phẩm.
- AC: run X3 bình thường ⇒ `x3-matrix.json` có 3 project × 14 ô = **42**, cặp `(browser, case, topology)` không trùng.
- **Mutation M6** (tạm, không commit): chèn `throw new Error("x3-inject")` vào đầu một ca giữa file ⇒ worker restart; với fix: JSON vẫn đủ 42 ô, đúng 1 ô `status: "failed"`; với code cũ (`git stash` phần fix, giữ injection) ⇒ thiếu ô (chứng minh RED). Khôi phục, `git diff e2e/x3` chỉ còn fix.

## Gate

fe-admin typecheck/lint/test (≥ 1567 + 3); E2E **38/38**; X3 **42** (JSON đủ 42 ô); `be/` không đổi (`git diff --stat be` rỗng) ⇒ be unit/int không bắt buộc. Mutation M1–M6 ghi vào test-report. Khi xong: đóng DEBT-490/491/492/493/494/509 trong `backlog.md` (DEBT-494 ghi: phần ×3 PATCH BE trực tiếp phủ bởi int-spec `:748`, không vào E2E).
