# Tasks — run 74 — sweep 🟡 BE bảo mật đợt 1 (M7, lane BE)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-487 (`TenantScopedRepository.findOneAndUpdate` pipeline chưa khoá `tenantId` với `$unset` string / `$replaceWith` / `$replaceRoot` / `$project`), DEBT-505 (cookie federation `idp_fed`/`idp_link` `Path=/auth/` không thể `__Host-` ⇒ subdomain cùng site ép binding), DEBT-321 (BE không thực thi `Resource.scopes`; quyết định đã chốt `plan.md` §12 "DEBT-321 (chốt 2026-11-07)": giao `Client.scopes` ∩ `Resource.scopes`, scope OIDC chuẩn chỉ so `Client.scopes`), DEBT-489 (nhánh fail-closed DEBT-415 `revokeFamily` lỗi ⇒ 5xx chưa có test), DEBT-488 (identity import `ADMIN_ROLE_VALUES` từ admin DTO). Bối cảnh: run 69 (guard/pipeline), run 73 (`hostCookieName`, X3 suite), run 46 (A6.2 resources).
>
> Tech-lead: xác minh gốc bằng code thật; diff nhỏ nhất; DEBT-321: tác động lên seed/dev/E2E (resource `admin`, demo, x3 — scopes của resource có sẵn có đủ không, nếu không thì cập nhật seed), discovery `scopes_supported`, refresh (scope family) và consent; DEBT-505: đổi `Path=/` + `__Host-` khi Secure, cắt cứng như DEBT-008, ảnh hưởng luồng federation đang dở lúc deploy; có nên thêm ca vào X3 (`e2e/x3/cookie-matrix.spec.ts`) cho tossing `idp_fed`. Cách chứng minh: int test từng debt + mutation ⇒ RED, int full, unit be, E2E 37, X3 nếu đổi (`pnpm -C e2e e2e:x3`, không song song E2E).
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop `aegate-*`; không seed/sync DB dev `sso-idp` (lưu ý: sync lần đầu xoá audit cũ — run 71); KHÔNG `drop-int-orphans.mjs`; không sửa hosts/kho chứng chỉ; không tải gì; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; mutation: backup NGAY trước mutate, restore xong so `git diff`; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` người dùng (kiểm cổng trước E2E/X3); không commit.

### [x] Task 1 [BE]: DEBT-487 — pipeline chỉ nhận stage an toàn / ép `tenantId` cuối.
### [x] Task 2 [BE]: DEBT-505 — `__Host-idp_fed`/`__Host-idp_link` khi Secure, `Path=/`.
### [x] Task 2b [E2E]: X3 ca 8 — tossing `idp_fed` từ subdomain anh em (xem § Fold).
### [→ run 75] Task 3 [BE+FE]: DEBT-321 — thực thi `Resource.scopes` (giao với `Client.scopes`). Tách sang run 75 (xem § Fold).
### [x] Task 4 [test/BE]: DEBT-489 — test nhánh fail-closed revoke lỗi ⇒ 5xx.
### [x] Task 5 [BE]: DEBT-488 — chuyển `ADMIN_ROLE_VALUES` sang identity.

## § Fold tech-lead (2026-11-07) — BẮT BUỘC

**Phạm vi chốt run 74**: Task 1, 2 (+2b X3), 4, 5. **Task 3 (DEBT-321) tách sang run 75.** Thiết kế ở dưới đã duyệt nên run 75 vào thẳng dev. Lý do tách: task này chạm `authorize.service` (handle + `decideConsent`) và cần thêm guard PATCH cho resource `admin` (chống tự khoá). Nó còn kéo theo ≥ 6 file int fixture tạo resource `admin`/`api` với `scopes: []` rồi xin `admin.*`/`api.read` qua `/authorize` (`admin.int-spec.ts:323`, `admin-api.int-spec.ts:308`, `admin-keys.int-spec.ts:331`, `admin-users.int-spec.ts:376`, `authorize.int-spec.ts:143`, `federation.int-spec.ts:502`, …; dev sweep đủ bằng `grep resources.create`). Ngoài ra phải sửa copy fe-admin `resource-form.tsx:25` ("Informational: …" sẽ sai sau thay đổi ⇒ [FE]) và runbook-deploy (kiểm DB trước deploy). Nhồi tất cả vào sweep 5 task thì quá rộng cho một cổng review.

Thứ tự: 5 → 1 → 4 → 2 → 2b. Task 5 là refactor thuần, làm trước để diff các task sau sạch. Mỗi task: viết test RED trước (task chỉ có test thì dùng mutation ⇒ RED). Backup NGAY trước khi mutate, restore xong thì `git diff` chỉ còn thay đổi chủ đích.

### Task 1 [BE] DEBT-487 — xác minh gốc
- `tenant-scoped.repository.ts:69` map `withoutTenantId` cho từng stage, nhưng `withoutTenantId:93` chỉ lọc khi giá trị toán tử là object. Vì vậy `{ $unset: 'tenantId' }` (string) đi nguyên. `$replaceWith`/`$replaceRoot`/`$project` tạo doc không có `tenantId`, và việc lọc key `tenantId` trong doc mới chỉ làm mất nó. Caller duy nhất dùng pipeline là `UserTenantService.replaceRoles` (`$set: { roles }`), nên hiện chưa khai thác được, đúng mức 🟡.
- **Diff**: nhánh pipeline = `[...update, { $set: { tenantId: ctx.tenantId } }]`, tức repo nối một stage cuối giữ bất biến tenant sau mọi stage. Bỏ `map(withoutTenantId)` cho pipeline vì đã ép ở cuối. Nhánh object giữ nguyên. Sửa comment L57 thành "pipeline: repo appends a final `$set` of the ctx tenant; any stage may run, the tenant cannot change". Không allowlist stage (YAGNI): ép ở cuối đã phủ cả stage chưa biết.
- **Chứng minh** (`be/test/tenant-context.int-spec.ts`, Mongo thật, vì không mock được ngữ nghĩa pipeline): một membership tenant A và một doc tenant B cùng `userId`. Chạy từng pipeline: `[{ $unset: 'tenantId' }]`, `[{ $replaceWith: { userId: '$userId', status: 'active', roles: [] } }]`, `[{ $replaceRoot: { newRoot: { userId: '$userId', status: 'active', roles: [] } } }]`, `[{ $project: { tenantId: 0 } }]`, `[{ $set: { tenantId: 'tenant-B' } }]`. Sau mỗi pipeline, đọc thô bằng `_id` ⇒ `tenantId === A`; doc tenant B không đổi; giá trị trả về = doc trước. Control: `replaceRoles` hiện hành (int roles run 69) xanh. Mutation: bỏ stage nối ⇒ ≥ 4/5 ca RED.

### Task 2 [BE] DEBT-505 — xác minh gốc
- `federation.controller.ts:31/33` dùng tên cố định `idp_fed`/`idp_link` với `path: '/auth/'` (L113, L254), nên không thể mang `__Host-`. Tên cố định được đọc ở 5 chỗ: `start:107`, `callback:140`, `linkForm:175-176`, `linkSubmit:211/217`, `limit:262` (deviceId). Probe run 73 đã đo được: cookie tossed qua `Domain=alpha.localhost` vẫn được IdP nhận.
- **Diff**: trong constructor đặt `this.bindingCookie = hostCookieName(FED_BINDING_COOKIE, secure)` và `this.linkCookie = hostCookieName(FED_LINK_COOKIE, secure)` (helper DEBT-008, `session.cookie.ts:14`). Thay MỌI `req.cookies?.[FED_*]`, `setCookie`, `clearCookie` bằng 2 field này, kể cả deviceId trong `limit`: phải cùng tên, nếu không rate-limit theo thiết bị mất tác dụng. Đặt `path: '/'` ở cả 2 option và sửa comment L30 ("Scoped to `/auth/`"). Cắt cứng như DEBT-008: khi Secure không đọc tên cũ, không fallback. `clearCookie` dùng đúng option của `set` (tên + `Path=/`).
- **Hệ quả chấp nhận**:
  - (a) Leg federation đang dở lúc deploy (≤ 10' TTL): callback/link không thấy `__Host-idp_fed` ⇒ trang lỗi cố định `invalid_state` 400. Người dùng bấm lại "Sign in with …" là xong. Ghi thêm 1 gạch vào runbook-deploy §11.
  - (b) `Path=/` ⇒ `idp_fed` (HttpOnly, Lax, opaque 256-bit) đi kèm mọi request tới IdP. Giá trị này không phải credential đăng nhập và header `cookie` không bị log (pino redact sẵn có), nên chấp nhận.
  - (c) Dev http: cookie cũ cùng tên với `Path=/auth/` có thể che cookie mới tối đa 10' (cookie path dài được gửi trước). `start` tái dùng giá trị đọc được nên binding vẫn nhất quán. Chấp nhận, không code thêm.
- **Chứng minh int** (`federation.int-spec.ts`): đổi kỳ vọng `path: '/auth/'` (L588, L1398, L1425) thành `'/'`. Thêm `describe` chế độ Secure với cfg `session.cookieSecure: true` (tham số hoá `cfg` hoặc boot thứ 2 trong cùng file; dev chọn cách ít trùng lặp):
  - (s1) `start` ⇒ `Set-Cookie: __Host-idp_fed=…; Path=/; HttpOnly; Secure; SameSite=Lax`, không `Domain`, không có tên `idp_fed`.
  - (s2) Callback chỉ mang `idp_fed=<binding đúng>` (tên cũ) ⇒ 400 `invalid_state`, state đã tiêu.
  - (s3) Callback mang `__Host-idp_fed` đúng và `idp_fed=<attacker>` ⇒ 302: đọc đúng tên mới, bỏ qua tên bị tossed.
  - (s4) `link_required` ⇒ `__Host-idp_link` `Path=/`; GET `/auth/link` với `idp_link` (tên cũ) ⇒ 400; POST link xoá `__Host-idp_link` `Path=/`.
  - Mutation: trả lại tên cố định ở `callback` ⇒ s2/s3 RED; `path:'/auth/'` ⇒ s1 RED.
  - Chế độ http: toàn bộ int federation hiện hành xanh (tên không đổi).
- Docs: spec §9.6 thay gạch "Cookie federation `idp_fed`/`idp_link` chưa có `__Host-` (DEBT-505)" bằng câu nói đã có `__Host-` khi Secure, `Path=/`. Runbook-deploy §11 thêm ý (a). Security-matrix CK1 bổ sung test mới.

### Task 2b [E2E] X3 ca 8 — tossing `idp_fed` (có, 1 ca)
- Lý do: int không chứng minh được trình duyệt thật nhận `__Host-idp_fed` đặt trong phản hồi 302, rồi gửi lại ở callback cross-site top-level từ mock provider (Lax). X3 đã chạy `start:e2e` (có mock Google) với `SESSION_COOKIE_SECURE=true`.
- Ca 8 (same-site, 3 trình duyệt): từ `app.alpha` ghi `document.cookie = "idp_fed=x3toss; Domain=alpha.localhost; Path=/auth/; Secure"` và `"__Host-idp_fed=x3toss; Domain=alpha.localhost; Path=/; Secure"`. Sau đó chạy luồng RP alpha → `/login` → Google (mock) → callback ⇒ đăng nhập xong; jar IdP có `__Host-idp_fed` host-only với giá trị ≠ `x3toss` (đo tên và so khác, không in giá trị). Ghi ô vào bảng spec §9.6 và `runs/74-sweep-be1/x3-matrix.json`.
- Nếu mock Google không chạy được dưới topology TLS X3 mà không sửa harness ngoài `cookie-matrix.spec.ts`/`env.ts` thì không ép: mở debt mới, ghi lý do vào log. Int s1–s4 vẫn là cổng.
- Chạy `pnpm -C e2e e2e:x3` 1 lần sau E2E 37 (KHÔNG song song; kiểm cổng trước).

### Task 4 [test] DEBT-489 — xác minh gốc
- Ở `refresh-token.service.ts:510-515` (`classifyMiss`), khi `revokeFamily` ném thì code chạy `refuse().catch(() => undefined)` rồi `throw err`. `/token` chỉ map `RefreshRotationError` sang `invalid_grant`, nên lỗi này thành 5xx. Chưa có test nào spy `revokeFamily` reject ở nhánh này (`refresh-token.int-spec.ts:678` chỉ đi đường thành công).
- **Diff test-only** (`refresh-token.int-spec.ts`, cạnh ca DEBT-415):
  - Chuẩn bị: `firstRefresh()`, gỡ resource khỏi `allowedResources`, rồi `jest.spyOn(app.get(RefreshTokenService), 'revokeFamily').mockRejectedValueOnce(new Error('r74-revoke-boom'))` (spy đúng instance mà `this.revokeFamily` gọi).
  - Refresh ⇒ status 500; body không chứa `r74-revoke-boom`/`familyId`/stack.
  - Có đúng 1 audit `TOKEN_REFRESHED failure reason:'resource_not_allowed'` với metadata `{resource, familyId}`.
  - Family **chưa** bị revoke (mock không ghi) và không có `TOKEN_REUSE_DETECTED`.
  - `finally`: restore spy và `allowedResources`.
  - Sau restore, refresh cùng RT ⇒ 400 `invalid_grant` và family bị revoke (đường fail-closed không để family sống mãi).
- Mutation (mỗi cái riêng, restore giữa hai lần): (m1) `await this.revokeFamily(...).catch(() => 0)` ⇒ ca thành 400 ⇒ RED; (m2) xoá `await refuse().catch(...)` trong `catch` ⇒ audit RED.

### Task 5 [BE] DEBT-488
- Xác minh: `identity/user-tenant.service.ts:4` import `ADMIN_ROLE_VALUES` từ `admin/admin.dto` (DTO kéo theo class-validator/swagger). Định nghĩa ở `admin.dto.ts:219-220`.
- **Diff**: tạo file mới `be/src/modules/identity/admin-roles.ts`, chuyển nguyên văn `ADMIN_ROLE_VALUES` và `AdminRole` sang. `admin.dto.ts` import để dùng trong decorator và `export { ADMIN_ROLE_VALUES, type AdminRole } from '../identity/admin-roles'`, nên các caller phía admin giữ nguyên import. `user-tenant.service.ts` import `./admin-roles`. Không gộp các `ADMIN_ROLES` trùng ở `tenant-context.ts:107`/`admin-users.controller.ts:63` (ngoài phạm vi ⇒ DEBT-513).
- Chứng minh: typecheck, lint, unit be, int roles (run 69/70) xanh; `grep -rn "from '../admin" be/src/modules/identity` rỗng. Không mutation vì là refactor thuần, không có hành vi mới.

### Task 3 [BE+FE] DEBT-321 → **run 75** (thiết kế đã duyệt, giữ quyết định `plan.md` §12)
- Gốc: `authorize.service.ts:519 validateScope` chỉ so với `client.scopes`; `resolveResource:535` trả `identifier` và bỏ qua `Resource.scopes`.
- `/authorize` `handle`: giữ thứ tự lỗi hiện hành, tức `validateScope` theo client trước (⇒ `invalid_scope`), rồi `resolveResource` (⇒ `invalid_target`). `resolveResource` trả `Resource`. Sau đó, nếu có resource, mọi scope xin không thuộc `OIDC_SCOPES = {openid, profile, email, offline_access}` phải nằm trong `resource.scopes`; nếu không ⇒ `invalid_scope`. Từ chối chứ không tự thu hẹp, đúng "như hiện hành". Áp cả cho nhánh `resume` (đi qua `handle`).
- `decideConsent`: hàm này đã gọi lại `resolveForClient`, nên dùng luôn Resource đó. Bound `allowedScopes` của `consents.grant` = `client.scopes ∩ (OIDC ∪ resource.scopes)`. Nếu admin bớt scope của resource trong lúc màn consent đang mở, consent không phủ scope đó ⇒ ở `/token`, `recheckCodeGrant` gọi `isCovered` trả sai ⇒ `consent_revoked`. Đây là đường sẵn có, không cần code mới ở `/token`.
- **Chống tự khoá**: `PATCH /admin/resources/admin` (resource có `identifier === adminResourceIdentifier(issuer)`) mà bỏ `admin.read` hoặc `admin.write` ⇒ 400, không ghi DB, audit failure như lỗi validate hiện hành. Thiếu guard này, super_admin có thể khoá cả fe-admin và UI không cứu được.
- Refresh / code đã phát hành khi scope của resource bị thu hẹp: nằm ngoài quyết định đã chốt, và `Client.scopes` hiện cũng chưa được kiểm lại ⇒ DEBT-512. Run 75 không làm phần này trừ khi người dùng chốt.
- Discovery `scopes_supported` chỉ liệt kê scope OIDC chuẩn (RFC 8414 là SHOULD, không bắt buộc liệt kê scope của resource) ⇒ không đổi. Request không có `resource` thì `/token` đã trả `invalid_target` ⇒ không đổi.
- Seed/dev/E2E/X3:
  - `seed.ts:195` resource `admin` = `['admin.read','admin.write']`, khớp scopes BFF (`seed.ts:84`).
  - `seed-dev.ts:66-71`: demo client chỉ có scope OIDC, resource demo/other `scopes: []` ⇒ không ảnh hưởng.
  - E2E/X3 dùng 2 seed này ⇒ kỳ vọng E2E 37 và X3 không đổi.
  - Seed dùng `$setOnInsert`, nên DB cũ có resource `admin` đã bị sửa scopes qua UI sẽ khoá fe-admin. Runbook-deploy thêm mục "trước deploy run 75": truy vấn mongosh liệt kê client có scope ngoài OIDC không nằm trong `scopes` của mọi `allowedResources` của nó, và kiểm resource `admin`.
- Int: fixture tạo resource `admin`/`api` phải mang đúng scopes (không nới check). Ca mới:
  - (a) Resource thiếu scope ⇒ `invalid_scope` redirect, không có context/code.
  - (b) Scope OIDC + scope resource hợp lệ ⇒ code.
  - (c) `openid` ⇒ code, dù resource có `scopes: []`.
  - (d) Scope thuộc resource nhưng không thuộc client ⇒ `invalid_scope` (giao, không phải hợp).
  - (e) Resume sau login khi scope resource bị gỡ giữa chừng ⇒ `invalid_scope`.
  - (f) Bớt scope resource giữa lúc render và approve consent ⇒ `/token` `invalid_grant`.
  - (g) PATCH resource `admin` bỏ `admin.write` ⇒ 400, DB nguyên.
  - Mutation: bỏ kiểm resource ⇒ a/d/e RED; dùng hợp thay vì giao ⇒ d RED; bỏ bound ở `decideConsent` ⇒ f RED; bỏ guard PATCH ⇒ g RED.
- [FE] hint ở `resource-form.tsx:25` đổi thành "Enforced: a token with this resource only gets scopes listed here and on the client (standard OIDC scopes excepted).", kèm test fe-admin tương ứng.

### Cổng run 74
- Chạy `pnpm -C be test` (unit), int full (`test:int`, 1467 + N, +0 DB mồ côi), typecheck, lint, E2E 37 (`pnpm -C e2e e2e`, kiểm cổng 5173/BE trước), rồi X3 (`pnpm -C e2e e2e:x3`, 39 + 3 nếu ca 8 vào). Không retries, không nới assertion.
- Diff chỉ gồm:
  - Code: `tenant-scoped.repository.ts`, `federation.controller.ts`, `identity/admin-roles.ts` (mới), `admin.dto.ts`, `user-tenant.service.ts`.
  - Test: `tenant-context.int-spec.ts`, `federation.int-spec.ts`, `refresh-token.int-spec.ts`, `e2e/x3/cookie-matrix.spec.ts`.
  - Docs: `spec.md` §9.6, `runbook-deploy.md` §11, `security-matrix.md` CK1, run 74.
- Debt mở ở review này: DEBT-512, DEBT-513 (`backlog.md`).
