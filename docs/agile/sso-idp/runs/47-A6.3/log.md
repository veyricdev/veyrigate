# Log — run 47 — A6.3 Users & sessions (+ DEBT-326/328)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đã đối chiếu code `edffce0` qua CodeGraph. Fold vào `tasks.md` gồm:

- **Phạm vi**
  - Thêm Task 0 [BE]: 6 view DTO + decorator OpenAPI cho 10 operation users; user E2E riêng trong `seed-e2e-admin.ts`.
  - Cắt roles (47b, DEBT-335), federated identities và danh sách session (BE không có dữ liệu, DEBT-334).
  - Thứ tự: Task 0 ‖ 1 → 2 → 3 → 4 → 5.
- **Q-47.1**: roles sang 47b (DEBT-149/142).
- **Q-47.2**: vừa 1 run sau khi cắt.
- **Q-47.3**: `e2e-user@example.com` do seed reset mỗi lần chạy; token lấy qua `fe-admin` (`adminToken` tổng quát hoá); không E2E tenant isolation.
- **Ràng buộc chính**
  - `listUsers` là server fn POST; email không vào URL/search/`returnTo`/log.
  - Lock uncertain ⇒ chỉ tới "Revoke all sessions"; consent uncertain ⇒ chỉ tới revoke family/global (DEBT-151).
  - Tự revoke ⇒ cảnh báo + `signInAgain()`.
  - Gom helper sang `components/feedback/`, `pathIdSchema`.
- **Debt mới**: DEBT-334…337.
- Chuyển: **backend-dev** (Task 0) ‖ **frontend-dev** (Task 1), rồi frontend-dev Task 2–5.

## frontend-dev Task 1 — 2026-10-23

- DEBT-326/328: `git mv` `confirm-action.tsx` ⇒ `fe-admin/src/components/feedback/`; mới `components/feedback/form-feedback.ts` (`failureMessage`, `fieldMessages`, `textareaClass`), bỏ bản sao trong `client-form.tsx`/`resource-form.tsx`; không shim, mọi import cập nhật.
- `StepUpAlert` `note?` + `ConfirmAction` `stepUpNote?`; câu "Unsaved changes in Settings…" = `SETTINGS_STEP_UP_NOTE` (client-status.tsx), chỉ truyền ở panel client. `inputs.ts` `pathIdSchema(message)`.
- Verify fe-admin: typecheck 0, lint 0, test 36 files / 901 passed (không sửa file test), build OK, check:bundle 0 hit. Không chạy E2E. Không đụng be/, openapi, schema.d.ts.
- DEBT-326/328 chuyển "Đã đóng". Tiếp: Task 2 (cần snapshot Task 0).

## backend-dev — Task 0 — 2026-10-23
- OpenAPI (chỉ metadata, không đổi runtime/mapper/DTO request): 6 view DTO trong `admin.views.ts`; `@ApiOkResponse` cho list/get/lock/unlock/setRoles/listFamilies/listConsents, `@ApiNoContentResponse` cho 3 op 204. Snapshot cũ VỐN đã ghi 204 cho 3 op này (fold nói "200" là chưa đúng) ⇒ JSON phần đó không đổi. `admin.spec.ts` +2 test (key mapper ↔ view, enum/nullable, 7 `$ref`, 3 op chỉ `204` không `content`), RED `undefined` trước fix.
- Snapshot: :4000 không chạy ⇒ dựng in-process (7 controller theo thứ tự `AdminModule`, guard mock, spec tạm đã xoá). Diff: đúng 7 op users thêm `content`, +6 schema, path/phần khác byte-identical ⇒ `admin.json` +260/−7; `gen:api` ⇒ `schema.d.ts` +80/−14.
- Seed (trust boundary: chỉ NODE_ENV=test + DB `sso-idp-e2e`, guard giữ nguyên): `readE2eUserConfig` (thiếu biến ⇒ bỏ qua; trùng `ADMIN_SEED_EMAIL`/`DEV_SEED_EMAIL` sau normalize ⇒ throw trước khi kết nối, không echo password); `seedE2eAdmin(..., e2eUser?)` guard trùng admin trước mọi ghi; tách `resetAdminUser` (hết `return` sớm) + `seedE2eUser` (user/membership chỉ ghi khi lệch; log id, không password). `e2e/config/env.ts` thêm `E2E_USER_EMAIL`/`E2E_USER_PASSWORD` vào `beEnv()`.
- Test seed: unit +7 (`readE2eUserConfig`), int +7 (bỏ qua, tạo mới, lần 2 không ghi dù admin "unchanged", lock/suspended/tenant_admin/password ⇒ reset, roles-only drift, membership mất, trùng admin ⇒ throw + DB byte-identical). Mutation: return sớm ⇒ 4 đỏ; bỏ guard ⇒ 1; bỏ check roles ⇒ 1 (thêm case roles-only sau khi mutation sống sót); sha khôi phục khớp.
- Verify: be unit 32 suites/414; `test:int` 45 suites/1210 (vg-test-*, lock thường); be typecheck 0, lint 0, prettier OK; fe-admin typecheck 0; e2e typecheck 0. Không chạy seed thật/E2E. Không debt mới.
- Bước tiếp: frontend-dev Task 2 (snapshot sẵn sàng); seed user E2E chạy ở Task 5.

## frontend-dev Task 2–5 — 2026-10-23
- T2: `schemas.ts` +6 zod allowlist (user/family/consent + page), `inputs.ts` `UserIdSchema`/`FamilyIdSchema`/`ConsentIdSchema`/`UserListInput`(strict)/`UserPageInput`/`Revoke*Input`, `client.ts` 9 method (route log = template), `features/admin-api/users.ts` (`listUsers` = server fn **POST**), keys `users.*`, hooks (mọi ghi ⇒ `useInvalidateOn(users.all)`, retry 0). Không có `setRoles` (47b).
- T3/T4: `/users` (status+after trong search; email = state form, input không `name`), `/users/$userId` (id ≠ 24 hex ⇒ không gọi BE; `Fragment key`; `not_found` kể cả sau ghi ⇒ ẩn mọi nút ghi), `features/users/user-account.tsx` (lockStatus ISO/sentinel 9999, gate self/tenant_admin, lock/unlock uncertain ⇒ đóng dialog + thông điệp ngoài, revoke-all idempotent ở lại dialog, self ⇒ `role="alert"` + `signInAgain()`), `user-grants.tsx` (families/consents, phân trang state cục bộ, consent uncertain ⇒ DEBT-151 msg, 404 ⇒ refetch). Sidebar "Users".
- T5: `adminToken(ctx,{email,password})`, `expectSignInBlocked`, `e2e/tests/fe-admin-users.spec.ts` (lock ⇒ RT0 400 + login chặn ⇒ unlock ⇒ RT1 revoke family 400 ⇒ RT2 revoke all 400; dọn bằng revoke-all đầu, unlock ở finally).
- Verify: fe-admin typecheck 0, lint 0, test 38 files/998 (mới: users-fn 51, users-ui 45, schema-types +1 it), build OK, check:bundle 0 hit, gen:api sha256 trùng (không diff); root lint xanh; e2e typecheck 0; E2E 31/31 ×2 liên tiếp (3.6m, 3.5m; :4000/:5173/:3000 trống trước mỗi lần).
- Mutation 14/14 bị giết (POST→GET, sentinel, self lowercase, gate tenant_admin, lock/consent uncertain giữ dialog, not_found, signInAgain, revoke family inactive, id lỏng, bỏ invalidate, email vào search, email vào log route, passthrough allowlist); sha256 khôi phục khớp cả 14.
- Grep log E2E: 0 password/secret/JWT/email. Debt mới: DEBT-338 (family đã revoke tích luỹ ở DB E2E). Tiếp: **senior-reviewer**.

## senior-reviewer — 2026-10-23
- **Kết luận: PASS** (0 🔴). Xem `review-senior.md`.
- Tự chạy lại: fe-admin test 38 file/998 xanh, typecheck 0, lint 0; be unit 32 suite/414 xanh, typecheck 0. Không chạy E2E/int.
- Invariant đã kiểm:
  - BE chỉ đổi metadata;
  - seed: guard NODE_ENV + DB, email trùng admin/dev ⇒ throw trước khi ghi, hội tụ, không log password;
  - email chỉ nằm trong body POST, không vào URL/log/`returnTo`; zod strip;
  - lock/unlock và consent uncertain ⇒ đóng dialog; revoke-all/family ⇒ giữ dialog (idempotent);
  - tự revoke-all ⇒ `signInAgain()`, nhánh uncertain đi qua 401 ⇒ `onError`;
  - gate tenant_admin/self/not_found.
- 🟡 ⇒ DEBT-339 (dialog revoke family unmount khi uncertain-nhưng-đã-áp-dụng: mất thông điệp/focus), DEBT-340 (E2E `finally` unlock dùng token có thể hết hạn). Ponytail ⇒ DEBT-341 (net -8).
- Tiếp: **tester**.

## tester — 2026-10-23
- **Kết quả: PASS [FE + BE]**. Xem `test-report.md`.
- fe-admin: typecheck 0, lint 0, test 39 file / 1019 xanh (998 cũ + 21 test rủi ro mới trong `fe-admin/test/users-risk.test.tsx`), build OK, check:bundle 0 hit, `gen:api` sha256 trùng.
- Root:
  - `pnpm lint` xanh, `pnpm -r run typecheck` xanh;
  - `pnpm test` lần 1 đỏ 1 test: `check-bundle.test.ts` timeout 5000ms khi chạy song song, là flake DEBT-333 đã biết, ngoài diff. Lần 2 xanh (269 / 1019 / 414);
  - `pnpm audit --audit-level high` exit 0 (2 low, 1 high đã ignore).
- E2E 31/31 ×2 (3.5m mỗi lần), :4000/:5173/:3000 trống trước mỗi lần chạy. Grep output: 0 JWT, 0 password, 0 email của user E2E, không có `/admin/users?…`. Seed thật in "admin user unchanged" và "E2E user unchanged" ở cả 2 lần (hội tụ, không đụng admin). Không chạy `test:int`.
- Test rủi ro mới:
  - lock/unlock uncertain-đã-áp-dụng ⇒ nút ngược chiều cần xác nhận lại;
  - dialog Lock đang mở không biến thành Unlock;
  - self revoke-all uncertain ⇒ 401 ⇒ `signInAgain`, `returnTo` không có email;
  - tenant_admin tự xem tài khoản admin của mình;
  - email không vào `returnTo`/storage/reload/URL chi tiết/step-up;
  - not_found ở lần tải đầu;
  - sentinel 9999 vs near-date;
  - paging consents/families;
  - characterisation DEBT-339.
- Mutation 3/3 bị giết (bỏ `key` lock/unlock; invalidate chỉ khi thành công; bỏ gate `!self`). sha256 khôi phục OK.
- DEBT-339 giữ 🟡: không đảo ngược ý định, không lộ PII, không leo thang quyền. Không có debt mới.
- Tiếp: **orchestrator** đóng run 47.
