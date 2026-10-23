# Tasks — run 47 — A6.3: Users & sessions (M5, lane ADMIN) + DEBT-326/328

> Plan §6 A6.3: "bảng user, chi tiết (federated identities, consents, sessions, refresh families), khoá/mở khoá, revoke session/family/global" — nghiệm thu "Hành động phá huỷ có xác nhận; hiển thị trạng thái `lockedUntil`". BE có sẵn `be/src/modules/admin/admin-users.controller.ts`: GET list, GET `:id`, POST `:id/lock`, `:id/unlock`, `:id/sessions/revoke`, PATCH `:id/roles`, GET `:id/families`, POST `:id/families/:familyId/revoke`, GET `:id/consents`, DELETE `:id/consents/:consentId`. Tái dùng khuôn A6.1/A6.2 (cursor list, detail, `ConfirmAction`, step-up, uncertain không tự retry và lần sau luôn gửi, `useInvalidateOn`, `useActionNotice`, chỉ hiện control khi có quyền).
>
> Thứ tự: Task 1 → 2 → 3 → 4 → 5 (frontend-dev). Task 0 [BE] nếu tech-lead thấy snapshot OpenAPI thiếu response schema. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: DEBT-326 + DEBT-328 — gom helper dùng chung
- `failureMessage`, `useActionNotice`, `ConfirmAction`, `messages`/`textareaClass`, refine path-id trùng lặp ⇒ module dùng chung (vd. `features/shared/`), không đổi hành vi; test cũ xanh nguyên.

### [x] Task 2 [FE]: Users server fns + keys
- list (cursor/lọc theo BE), detail, lock/unlock, sessions revoke (global), families list/revoke, consents list/delete, roles PATCH (nếu vào phạm vi — xem câu hỏi). zod allowlist response (không hash mật khẩu, không token), error union, uncertain.

### [x] Task 3 [FE]: `/users` + `/users/$userId` (thông tin, federated identities, trạng thái `lockedUntil`, khoá/mở khoá có xác nhận)

### [x] Task 4 [FE]: Sessions/families/consents trên chi tiết user — revoke family, revoke toàn bộ session (global), xoá consent; xác nhận, step-up, uncertain, tự khoá (admin tự revoke session của chính mình ⇒ thông điệp/hành vi rõ ràng)

### [x] Task 5 [E2E]: user list ⇒ chi tiết ⇒ lock ⇒ đăng nhập RP bị chặn ⇒ unlock ⇒ revoke family/global ⇒ refresh bị từ chối; dùng user E2E riêng, không phá admin E2E.

## Câu hỏi cho tech-lead
- Q-47.1: Roles PATCH (escalation tenant_admin/super_admin, run 27) có vào run này không, hay tách A6.3b?
- Q-47.2: Phạm vi vừa 1 run? Nếu không, tách thế nào (gợi ý: 47 = T1–T3 + lock/unlock; 48 = sessions/families/consents/roles).
- Q-47.3: E2E: user nào dùng để lock/revoke mà không ảnh hưởng spec khác; tenant isolation.

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `edffce0` (CodeGraph + đọc trực tiếp): BE `admin-users.controller.ts`, `admin.dto.ts` (`UserListQueryDto`, `UpdateUserRolesDto`), `admin.mappers.ts` (`toAdminUser/Family/Consent`), `admin.views.ts`, `user.service.ts` (`ADMIN_LOCKED_UNTIL`), `user-tenant.service.ts` (`listMembersPage`), `authentication.service.ts` (`revokeAllUserCredentials`), `access-token-liveness.ts`, `tenant-context.ts` (`AdminTokenGuard`), `refresh-token.service.ts` (`listFamilies`/`revokeFamily`), `be/test/e2e/seed-e2e-admin.ts`; `fe-admin/openapi/admin.json`; FE `server/admin-api/{client,schemas}.ts`, `features/admin-api/*`, `features/{clients,resources}/*`, `routes/resources/*`, `components/layout/app-sidebar.tsx`; E2E `e2e/tests/support/{admin,fe-admin}.ts`, `e2e/config/env.ts`, `playwright.config.ts` (workers 1).

### Trả lời câu hỏi
- **Q-47.1 — Roles PATCH KHÔNG vào run 47 ⇒ run 47b.** Lý do: (1) BE thay nguyên mảng `roles` ⇒ xoá vai trò không-admin đang lưu (DEBT-149, analyst phải chốt trước khi có UI bấm được); (2) race hai super_admin giáng nhau ⇒ còn 0 super_admin (DEBT-142); (3) đây là UI leo thang quyền, cần cổng security riêng, không trộn vào run đã nặng. Task 2 KHÔNG tạo server fn/hook `setRoles`. Trang chi tiết chỉ HIỂN THỊ `roles` (text). Theo dõi ở DEBT-335.
- **Q-47.2 — Vừa 1 run sau khi cắt.** Run 47 = Task 0 [BE] + Task 1–5, KHÔNG gồm: roles; federated identities; danh sách session. BE không có dữ liệu cho hai mục sau: `AdminUserView` không có federated identities, không có endpoint list session (chỉ có revoke global) ⇒ DEBT-334 cho analyst/BE. Run 47b = roles editor (sau khi chốt DEBT-149) + phần DEBT-334 nếu analyst giữ yêu cầu plan. Nghiệm thu plan A6.3 ("hành động phá huỷ có xác nhận; hiển thị `lockedUntil`") vẫn đạt trong run 47.
- **Q-47.3 — E2E dùng user riêng do seed tạo**, không dùng `DEV_SEED_*` (nhiều spec khác đăng nhập bằng user đó), không dùng admin E2E. Xem F0(c), F5. Tenant isolation KHÔNG kiểm ở E2E (stack E2E chỉ có 1 tenant); int-test BE run 28 đã phủ (cross-tenant ⇒ 404 byte-identical), không viết lại.

### Sự thật từ code (đối chiếu `edffce0`)
- **Phân quyền**: controller dùng `AdminTokenGuard`. GET cần `admin.read`; mọi ghi cần `admin.write` + `@RequireRecentAuth(5)` (step-up chạy trước kiểm quyền trong handler). Mọi vai trò admin (tenant_admin/super_admin) đều có `admin.write`.
- **Tenant isolation**: target chỉ tồn tại qua `UserTenant` của tenant token (`mustFind`). Khác tenant, không tồn tại, hoặc id không phải 24 hex ⇒ **404 opaque**. Families/consents lọc `clientId ∈ client của tenant`; family/consent của client tenant khác ⇒ 404.
- **Trạng thái toàn cục**: `User`, lock, session, refresh family là GLOBAL. `assertMayTouchAccount`: tenant_admin KHÔNG được lock/unlock/revoke-global user có vai trò admin ở BẤT KỲ tenant nào, hoặc có membership active ở tenant khác ⇒ **403 `forbidden`**. super_admin không bị giới hạn. Revoke family/consent KHÔNG qua kiểm này (đã giới hạn theo client của tenant).
- **Lock** (`POST :id/lock`, 200 + user view): tự khoá chính mình ⇒ 403. Ghi `lockedUntil = 9999-12-31T23:59:59.999Z` (`ADMIN_LOCKED_UNTIL`) TRƯỚC, rồi `revokeAllUserCredentials` (refresh → session → sweep). Revoke lỗi ⇒ 5xx nhưng lock ĐÃ ghi; gọi lại idempotent. Lock do đăng nhập sai (A3) là `lockedUntil` ngắn hạn.
- **Unlock** (200 + user view): xoá `lockedUntil` + `failedLoginCount`; KHÔNG khôi phục session/token. Tự unlock chính mình được phép (vô hại).
- **Revoke global** (`POST :id/sessions/revoke`, **204**): kết thúc MỌI session IdP + MỌI refresh family của user ở MỌI client/tenant; idempotent. **BE cho phép tự revoke chính mình**, có hiệu lực ngay: access token admin có `sid`, `isAccessTokenLive` thấy session đã kết thúc ⇒ lần gọi admin API kế tiếp 401 ⇒ BFF refresh thất bại (family đã revoke) ⇒ `unauthenticated` ⇒ `signInAgain()`.
- **Revoke family** (`POST :id/families/:familyId/revoke`, **204**): `familyId` phải khớp `^[A-Za-z0-9-]{1,128}$` (khác ⇒ 404); idempotent (đã revoke ⇒ vẫn 204, không audit). Access token đã cấp KHÔNG bị thu hồi (sống tới `exp`, ≤15'); session IdP KHÔNG bị kết thúc.
- **Xoá consent** (`DELETE :id/consents/:consentId`, **204**): `consentId` 24 hex; đã revoke ⇒ **404**. DEBT-151 còn mở: 5xx sau khi stamp ⇒ consent biến khỏi danh sách nhưng family có thể còn sống, và không có đường retry.
- **List users**:
  - lọc `email`: exact, BE normalize. Email không phải member của tenant ⇒ `{items:[],nextCursor:null}`, y như không tồn tại (không có oracle);
  - lọc `status` `active|suspended` (của membership);
  - `limit` 1..100 (mặc định 20); `after` = `_id` membership (24 hex, sai ⇒ 400);
  - một trang có thể ít hơn `limit` (membership mồ côi bị lọc) mà vẫn có `nextCursor`.
- **Families list**: `after` = `familyId` (BE nhận mọi chuỗi, DEBT-155). **Consents list**: chỉ consent active, `after` 24 hex.
- **View** (allowlist BE):
  - user `{id,email,emailVerified,locked,lockedUntil,membershipStatus,roles,createdAt}`;
  - family `{familyId,clientId,resource,scope[],createdAt,lastRotatedAt,expiresAt,active,revokedAt}`;
  - consent `{id,clientId,resource,grantedScopes[],policyVersion,termsVersion,grantedAt,updatedAt}`.

  Không có hash, token, session ref hay federated identity.
- **OpenAPI snapshot**: 10 operation users đều `"200": {"description": ""}`, KHÔNG có schema response; endpoint 204 cũng ghi là 200 ⇒ cần **Task 0 [BE]**.
- **Log BE** cắt query string (`logger.module.ts`: `url.split('?')`) ⇒ email filter không vào log BE.
- **fe-admin**: `Viewer` có `sub`, `roles` (chỉ gate UX). `signInAgain()` đưa `location.pathname + location.search` vào `returnTo`. Server fn `GET` mã hoá input vào URL.

### Phạm vi, phân công, thứ tự
- Task 0 → **backend-dev**; Task 1–5 → **frontend-dev**.
- Thứ tự: Task 0 ‖ Task 1 → Task 2 (cần snapshot từ Task 0) → Task 3 → Task 4 → Task 5 (cần seed Task 0(c)).
- Ngoài phạm vi run 47: roles editor (DEBT-335); federated identities + danh sách session (DEBT-334); lọc/sort server ngoài những gì BE có; export; tenant switcher (DEBT-124/143); DEBT-147/148/151/153/155 (BE).

### [x] F0 — Task 0 [BE] (backend-dev)
(a) **View DTO** trong `be/src/modules/admin/admin.views.ts`, cùng khuôn (`implements` interface mapper, dùng `DATE`/`NULLABLE_DATE`):
- `AdminUserViewDto`: `membershipStatus` khai báo `enum: ['active','suspended']`; `lockedUntil` và `createdAt` là `NULLABLE_DATE`;
- `UserPageViewDto`;
- `AdminFamilyViewDto` (`revokedAt` nullable), `FamilyPageViewDto`;
- `AdminConsentViewDto` (`policyVersion`/`termsVersion` là `String` nullable), `ConsentPageViewDto`.

Page = `{items, nextCursor: string|null}`.

(b) **Decorator** trong `admin-users.controller.ts`:
- `@ApiOkResponse`: `UserPageViewDto` (list); `AdminUserViewDto` (get, lock, unlock, **setRoles** — để snapshot đủ cho 47b); `FamilyPageViewDto` (listFamilies); `ConsentPageViewDto` (listConsents);
- `@ApiNoContentResponse()` cho `revokeSessions`, `revokeFamily`, `revokeConsent`.

KHÔNG đổi hành vi runtime, mapper hay DTO request.

(c) **User E2E riêng** trong `be/test/e2e/seed-e2e-admin.ts` (giữ guard `NODE_ENV=test` + DB `sso-idp-e2e`):
- Đọc `E2E_USER_EMAIL`/`E2E_USER_PASSWORD` từ env. Thiếu ⇒ bỏ qua bước này, không lỗi.
- Email phải khác `ADMIN_SEED_EMAIL` và `DEV_SEED_EMAIL`; trùng ⇒ throw trước khi ghi.
- Upsert idempotent:
  - User: email normalize, `emailVerifiedAt` set, password hash, `failedLoginCount: 0`, `$unset lockedUntil`;
  - `UserTenant` `{tenantId: DEFAULT_TENANT_ID, status: 'active', roles: []}` (KHÔNG vai trò admin).
- Mỗi lần chạy reset password/lock/status/roles nếu lệch; không ghi khi đã khớp.
- **Bước admin hiện có `return` sớm khi "unchanged" ⇒ tách hàm, bước user E2E phải luôn chạy.**
- Không in password.
- `e2e/config/env.ts`: thêm `E2E_USER_EMAIL = "e2e-user@example.com"` và `E2E_USER_PASSWORD` (placeholder không bí mật, comment như `ADMIN_SEED_PASSWORD`), đưa vào `beEnv()`.

**Test**
- `admin.spec.ts`: `keys('AdminUserViewDto'|'AdminFamilyViewDto'|'AdminConsentViewDto')` khớp key mapper; `ref(...)` cho 7 operation có body; 3 operation 204 không có `content`.
- `seed-e2e-admin.spec.ts`/`.int-spec.ts`:
  - user E2E được tạo mới;
  - chạy lần 2 không ghi (converged);
  - user đã bị lock / suspended / có `roles:['tenant_admin']` ⇒ được reset;
  - email trùng admin ⇒ throw, DB không đổi;
  - thiếu env ⇒ bỏ qua.

**Verify**
- unit + int (`test:int`) + lint + typecheck BE xanh;
- `pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api`. Lệnh này cần BE dev đang chạy và KHÔNG được dừng process có sẵn. Không có BE dev ⇒ ghi log, frontend-dev chạy ở Task 2;
- `git diff fe-admin/openapi/admin.json` chỉ thêm schema response của users.

### F1 — Task 1 [FE]: DEBT-326 + DEBT-328 (thay text cũ)
- `git mv src/features/clients/confirm-action.tsx src/components/feedback/confirm-action.tsx`, giữ nguyên `ConfirmAction`, `outcomeOf`, `useActionNotice`, `StepUpAlert`, `ActionOutcome`.
  - `StepUpAlert` nhận thêm `note?: string`. Câu "Unsaved changes in Settings will be lost." chỉ được truyền từ các panel của trang client.
  - `ConfirmAction` thêm prop `stepUpNote?`.
  - Text hiển thị ở trang client/resource KHÔNG đổi.
- `src/components/feedback/form-feedback.ts` gồm:
  - `failureMessage` (chuyển từ `client-form.tsx`);
  - `fieldMessages` (= `messages` cũ; bỏ bản sao trong `resource-form.tsx`);
  - `textareaClass` (bỏ bản sao trong `resource-form.tsx`).
- `inputs.ts`: thêm `pathIdSchema(message)` dùng chung. `ClientIdSchema = pathIdSchema("Invalid client id")`, `ResourcePathIdSchema = pathIdSchema("Invalid resource id")`; message giữ nguyên.
- KHÔNG để re-export/shim ở đường dẫn cũ; cập nhật mọi import.
- Không đổi hành vi: toàn bộ test fe-admin cũ xanh **không sửa assertion** (chỉ được sửa đường dẫn import). `typecheck` + `lint` xanh. Đóng DEBT-326/328.

### F2 — Task 2 [FE]: users server fns + types (thay text cũ)

**Schemas** (`server/admin-api/schemas.ts`, zod strip = allowlist)
- `AdminUserSchema`: `membershipStatus: z.enum(["active","suspended"])`, `lockedUntil: z.string().nullable()`, `createdAt: z.string().nullable()`, `roles: z.array(z.string())`.
- `UserPageSchema`, `AdminFamilySchema`, `FamilyPageSchema`, `AdminConsentSchema`, `ConsentPageSchema`.
- `admin-schema-types.test.ts` thêm `toEqualTypeOf` với 6 DTO mới (sau Task 0).

**Inputs** (`inputs.ts`)
- `UserIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/)`.
- `FamilyIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)`.
- `ConsentIdSchema`: 24 hex.
- `UserListInput = PageInput.extend({ email: z.string().trim().min(1).max(320).optional(), status: z.enum(["active","suspended"]).optional() }).strict()`.
- `UserPageInput = PageInput.extend({ userId: UserIdSchema })`, dùng cho families/consents.
- `RevokeFamilyInput {userId, familyId}`, `RevokeConsentInput {userId, consentId}`.

**`client.ts`: thêm method**
- `listUsers`, `getUser`;
- `lockUser`, `unlockUser`: POST không body, schema `AdminUserSchema`;
- `revokeUserSessions`: POST, `schema: null`;
- `listUserFamilies`; `revokeUserFamily`: POST, `schema: null`;
- `listUserConsents`; `revokeUserConsent`: DELETE, `schema: null`.

Path `/admin/users/${encodeURIComponent(id)}`…. `route` trong log là template (`/admin/users/:id/lock`…), không bao giờ chứa id hay email. Query của `listUsers` dựng bằng `URLSearchParams` (`limit`, `after`, `email`, `status`).

**Server fn** (`features/admin-api/users.ts`)
- **`listUsers` dùng `createServerFn({ method: "POST" })`** dù là thao tác đọc. Lý do: server fn GET đưa input vào URL ⇒ email filter lọt vào URL/log/history.
- Các GET khác (getUser/families/consents — chỉ có id hex) giữ GET. Mọi ghi là server fn POST.

**Keys**

```
users: { all: ["admin","users"], list: (p) => ["admin","users","list",p], detail: (id) => ["admin","users","detail",id],
         families: (id,p) => ["admin","users","families",id,p], consents: (id,p) => ["admin","users","consents",id,p] }
```

Mọi ghi user (thành công, `uncertain`, throw lạ) ⇒ `useInvalidateOn(adminKeys.users.all)`. Lock cũng revoke family, nên phải làm mới cả families.

**Hooks** (`hooks.ts`): `useUsers`, `useUser`, `useUserFamilies`, `useUserConsents`, `useLockUser`, `useUnlockUser`, `useRevokeUserSessions`, `useRevokeUserFamily`, `useRevokeUserConsent`. Mutation giữ mặc định `retry: 0`.

**Acceptance (unit, đo được)**
- 400 / 403 `forbidden` / 403 `step_up_required` / 404 / 409 ⇒ trả đúng code.
- POST/DELETE gặp timeout, 5xx, 2xx sai schema, hoặc 2xx khác 204 cho op `schema:null` ⇒ `uncertain`. GET 5xx ⇒ không `uncertain`.
- id `abc`, `../x`, 25 hex; familyId `a/b`; consentId không hex ⇒ input validator từ chối, `fetch` KHÔNG được gọi.
- `email`/`after` được encode trong query gửi BE.
- **Email filter**: request của server fn `listUsers` không chứa email trong URL. Với fetch timeout và 5xx, mọi spy `console.*`/`logServerError` không chứa chuỗi email.
- Response BE có thêm `passwordHash`/`failedLoginCount`/`tokenHash` ⇒ các field này không có trong dữ liệu trả về (strip).
- `gen:api` không diff.

### F3 — Task 3 [FE]: `/users`, `/users/$userId`, lock/unlock (bổ sung)
- Sidebar thêm `{ to: "/users", label: "Users" }`.

**`/users`**
- Search params chỉ có `status?` và `after?` (validate, `.catch(undefined)`).
- **Email filter là state của form trên trang, KHÔNG vào search params, URL hay `returnTo`.** Input email không có `name`; submit chặn native GET như form client.
- Bảng: email (link sang chi tiết bằng `id`), trạng thái lock, membership, roles, createdAt. Phân trang "Next page"/"First page" như resources. Email luôn render dạng text.

**`/users/$userId`**
- `userId` không khớp 24 hex ⇒ trạng thái not-found, KHÔNG gọi BE.
- Bọc thân trang bằng `<Fragment key={userId}>` để state dialog/notice mất khi đổi user.
- Lỗi `not_found` (kể cả refetch sau một lần ghi) ⇒ ẩn mọi nút ghi (bài học DEBT-320).

**Hiển thị lock (nghiệm thu plan)** — tính từ `locked` + `lockedUntil`. Ngày hiển thị dạng ISO, KHÔNG format theo locale (tránh lệch khi hydrate):
- `locked` và `lockedUntil` có năm ≥ 9999 ⇒ "Locked by an administrator (until unlocked)";
- `locked`, trường hợp còn lại ⇒ "Temporarily locked after failed sign-ins until <lockedUntil>";
- `!locked` ⇒ "Not locked" (`lockedUntil` ở quá khứ không hiển thị như đang khoá).

**Gate UX** (BE vẫn là nơi quyết định)
- Target là chính viewer (`user.id === viewer.sub`, so sánh lowercase) ⇒ không render nút Lock, hiện "You cannot lock your own account.".
- Viewer không có `super_admin` và `user.roles` có `tenant_admin`/`super_admin` ⇒ không render Lock/Unlock/Revoke-all, hiện "Only a super admin can change this account.".
- Nút Lock khi `!locked`, Unlock khi `locked`.

**Lock / Unlock**
- Lock: `ConfirmAction` destructive. Mô tả: khoá tài khoản (toàn cục, mọi tenant) tới khi admin mở; kết thúc ngay mọi session và refresh token của user ở mọi ứng dụng.
- Unlock: có xác nhận. Ghi rõ: xoá đếm đăng nhập sai, KHÔNG khôi phục session đã kết thúc.
- `outcomeOf` byCode:
  - `forbidden` ⇒ "Only a super admin can change this account: it holds an admin role or belongs to another tenant.";
  - `not_found` ⇒ "This user no longer exists in this tenant.".
- **Lock `uncertain`/throw** ⇒ "The lock may not have been applied, or sessions may not all have ended. The current state is shown below; if the account shows as locked, use "Revoke all sessions" to make sure." KHÔNG tự gửi lại. Nút "Revoke all sessions" luôn có mặt với cùng điều kiện gate.
- Unlock `uncertain` ⇒ "…The current state is shown below; check it before trying again."

**Test và acceptance**
- Component test render vào `container: document` (DEBT-312 — trang có AlertDialog).
- 3 trạng thái lock hiển thị đúng (sentinel, ngày gần, quá khứ).
- Self ⇒ không có nút Lock. tenant_admin xem user có `tenant_admin` ⇒ không có nút ghi.
- Double click Lock ⇒ server fn được gọi đúng 1 lần. Cancel/Escape ⇒ không gọi.
- `step_up_required` ⇒ `StepUpAlert` không có note Settings; `sessionStorage` không có `fea:stepup`; không tự gọi lại.
- `uncertain` ⇒ thông điệp như trên + refetch; server fn được gọi đúng 1 lần.
- 403 ⇒ thông điệp forbidden. Id sai ⇒ không gọi `getUser`.
- Sau khi lọc email ⇒ `location.href` không chứa email.

### F4 — Task 4 [FE]: families, consents, revoke global (bổ sung)
- Ba section trên trang chi tiết, mỗi section có một `useActionNotice` và heading `tabIndex=-1`. Phân trang families/consents bằng state cục bộ (`after`), không vào URL.

**Families**
- Cột: clientId, resource, scope, createdAt, lastRotatedAt, expiresAt, trạng thái (`active` / revoked lúc `revokedAt` / expired).
- Nút Revoke chỉ hiện cho family `active`.
- Xác nhận: "Revokes this refresh token family: the application must sign the user in again. Access tokens already issued stay valid until they expire."
- Idempotent ⇒ khi `uncertain` cho phép bấm lại, thông điệp: "The outcome is unknown; the list was reloaded. Revoking again is safe."
- 404 ⇒ "This family is not visible in this tenant." + refetch.

**Consents**
- Cột: clientId, resource, grantedScopes, grantedAt, updatedAt; nút Revoke.
- Xác nhận: user sẽ được hỏi consent lại; refresh token của client × resource đó bị thu hồi.
- 404 ⇒ "This consent was already revoked." + refetch.
- **`uncertain`/throw** ⇒ refetch + "The outcome is unknown. If the consent no longer appears, its refresh tokens may not all be revoked: revoke the matching family below, or use "Revoke all sessions"." (DEBT-151).

**Revoke all sessions (global)**
- Destructive. Mô tả: kết thúc MỌI session IdP và MỌI refresh token của user ở MỌI ứng dụng/tenant (không chỉ tenant này); access token đã cấp sống tới khi hết hạn.
- Gate như Lock, trừ trường hợp self (xem dưới).
- Idempotent ⇒ khi `uncertain` cho phép bấm lại ("…running it again is safe").

**Tự khoá (target là chính viewer)**
- Revoke all sessions VẪN được phép (BE cho phép; hợp lệ khi nghi bị lộ), nhưng thêm `warning` `role="alert"`: "This is your own account: you will be signed out of this console and every other application immediately." Thành công ⇒ gọi `signInAgain()`, không hiện notice.
- Families của chính mình: mọi dialog revoke family có `warning` `role="alert"`: "One of these may be this console's own sign-in: revoking it signs you out when the console next refreshes its token."

**Acceptance**
- Revoke chỉ hiện cho family `active`.
- 204 ⇒ notice + focus heading + invalidate `users.all`.
- Consent 404 ⇒ thông điệp + refetch. Consent `uncertain` ⇒ thông điệp DEBT-151, server fn gọi đúng 1 lần.
- Self + revoke global thành công ⇒ `signInAgain` được gọi (spy `location.assign` tới `/auth/login?returnTo=…`). Self ⇒ có mặt cả hai cảnh báo.
- `step_up_required` ở cả 3 action ⇒ `StepUpAlert`, không lưu intent.

### F5 — Task 5 [E2E] (thay text cũ)
- File mới `e2e/tests/fe-admin-users.spec.ts`, 1 test, `test.setTimeout` ≤ 120 s.
- Target = `E2E_USER_EMAIL` (seed ở Task 0(c), reset mỗi lần chạy nên không cần dọn). Vẫn unlock ở `finally` qua admin API cho chắc.

**Support**
- Tổng quát hoá `adminToken(context, { email?, password?, forceLogin? })`, mặc định là admin seed; không đổi hành vi spec cũ. Dùng để lấy refresh token của user E2E qua client `fe-admin`: gating admin resource theo client, không theo user, nên user không có vai trò admin vẫn nhận được token.
- Thêm `expectSignInBlocked(context, email, password)`: submit form `/login` ⇒ vẫn ở `/login` của IdP, không tới redirect `:3000`.
- Mỗi lần target đăng nhập dùng `browser.newContext()` mới.

**Kịch bản**
1. Target đăng nhập ⇒ RT0.
2. Admin `signInAsAdmin` ở fe-admin ⇒ `/users` ⇒ lọc email ⇒ mở chi tiết ⇒ thấy "Not locked" ⇒ Lock (xác nhận) ⇒ thấy "Locked by an administrator". `page.url()` không chứa email.
3. `adminRefresh(RT0)` ⇒ 400; `expectSignInBlocked`.
4. Unlock ⇒ "Not locked". Target đăng nhập ⇒ RT1.
5. Reload chi tiết ⇒ Revoke family đang active (xác nhận) ⇒ `adminRefresh(RT1)` ⇒ 400.
6. Target đăng nhập ⇒ RT2 ⇒ Revoke all sessions ⇒ `adminRefresh(RT2)` ⇒ 400.

Không log/annotation nào chứa token hay password; message của `expect` không nội suy token.

**Ngoài phạm vi E2E**: step-up (vừa đăng nhập, `auth_time` còn mới), xoá consent, roles, tenant isolation — đã phủ bằng component test và int-test BE.

**Acceptance**: full E2E xanh 2 lần liên tiếp (31 test); các spec cũ không đổi kết quả.

### Cổng security (đã kiểm)
- **Tài sản / actor / boundary**
  - Tài sản: lock state, session IdP, refresh family, consent (toàn cục, xuyên tenant).
  - Actor: super_admin, tenant_admin, chính mình.
  - Boundary: browser → server fn BFF (session cookie; token chỉ ở server) → admin API. BE là điểm thực thi duy nhất; gate FE chỉ là UX.
- **Invariant**
  - Không có lần ghi nào tự gửi lại.
  - Ghi không idempotent (consent) không khuyến khích bấm lại khi `uncertain`.
  - Sau lock luôn có đường "Revoke all sessions" để hoàn tất revoke.
- **Abuse**
  - IDOR/cross-tenant ⇒ BE 404 (int run 28); FE validate id trước khi gọi.
  - Enumeration bằng email ⇒ giới hạn theo tenant, không có oracle.
  - Double submit ⇒ chặn bằng `busy` ref.
  - Auth cũ ⇒ step-up 5', không lưu intent.
  - Race lock ∥ unlock ⇒ DEBT-147 (chấp nhận).
  - tenant_admin unlock user do super_admin khoá ⇒ DEBT-153 (chấp nhận, ngoài phạm vi).
- **Failure**: timeout 10 s; GET retry ≤2 (lỗi tạm thời); mutation không retry; ghi gặp 5xx/timeout ⇒ `uncertain` + refetch.
- **Exposure**
  - Allowlist zod: không hash, token hay session ref.
  - Email không vào URL, search params, `returnTo`, server fn GET hay log.
  - Ngày hiển thị dạng ISO text.
  - email/clientId/resource render dạng text, không làm `href`.
