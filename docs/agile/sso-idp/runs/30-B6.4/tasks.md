# Tasks — run 30 — B6.4 seed bootstrap + DEBT-137/143/161/163 (M5)

> Plan §B6 dòng 213 (B6.4): seed idempotent `default-tenant`; admin user (từ env); resource `admin`, `demo`; client `fe-admin` (confidential, redirect `http://localhost:3000/auth/callback`), client `fe-sso-test` (public, redirect `http://localhost:5173/callback`, CORS origin tương ứng); "chạy 2 lần không nhân đôi dữ liệu; in ra `client_secret` của fe-admin đúng 1 lần". D2 (fe-admin là BFF/confidential — Q3 plan §12 còn mở, chỉ ảnh hưởng A4; seed client confidential là đủ), D5, D6. Hiện có `be/src/database/seed-dev.ts` (`db:seed-dev`, allowlist development|test) đã seed client `fe-sso-test` + resource `demo`/`other` + user dev.
>
> Thứ tự: Task 1 → 2 (backend-dev); Task 3, 4 độc lập. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`; không tự chạy seed trên DB dev (chỉ int-test trên `vg-test-*`).

### [x] Task 1 [BE]: B6.4 — seed bootstrap idempotent
- Script (vd. `db:seed` / mở rộng `seed-dev` — tech-lead chốt quan hệ với `seed-dev` và việc chạy ở production): `default-tenant`; resource `admin` (`adminResourceIdentifier(issuer)`, scopes `admin.read/admin.write`) + `demo`; admin user từ env (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` hoặc tương đương; password không log, validate độ mạnh) với `UserTenant.roles=['super_admin']`; client `fe-admin` confidential (`client_secret_basic`, grant `authorization_code`+`refresh_token`, allowedResources `admin`, redirect/post-logout theo plan); client `fe-sso-test` như seed-dev hiện tại.
- Secret fe-admin: chỉ tạo + in **đúng 1 lần** khi chưa có credential active (stdout, không vào log pino/audit); chạy lại không in, không rotate.
- **Acceptance**: int: chạy 2 lần ⇒ không nhân đôi (đếm document), secret in đúng 1 lần, lần 2 không đổi credential; admin user login + `/authorize` resource admin ⇒ `/admin/me` 200 với role super_admin; thiếu env bắt buộc ⇒ thoát lỗi, không ghi gì; mutation ⇒ RED.

### [ ] Task 2 [BE] (HOÃN — xem fold): DEBT-143 (+ xem DEBT-124) — super_admin gắn tenant hệ thống
- Quyết định (tech-lead): super_admin chỉ hợp lệ khi membership ở tenant hệ thống (`default-tenant`/platform) hay giữ như hiện tại; nếu ghim thì cập nhật guard + fixture int run 27–29.
- **Acceptance**: theo quyết định; không hồi quy admin int-spec.

### [x] Task 3 [BE]: DEBT-161 + DEBT-163
- DEBT-161: stamp `disabledAt` kiểm `matchedCount`/gộp vào update chính để response khớp DB khi enable/grant song song.
- DEBT-163: `LocalKeyProvider.init()` log WARN liệt kê `*.pem` không có trong `keys.json` (chỉ kid, không xoá) + bước kiểm thư mục trong runbook emergency.
- **Acceptance**: test cho từng debt; mutation ⇒ RED.

### [x] Task 4 [BE]: DEBT-137 — nâng client thành admin-capable
- Khi super_admin gán `admin` cho client chưa admin-capable: bắt buộc rotate secret (revoke secret cũ) và/hoặc audit riêng + cảnh báo — tech-lead chốt.
- **Acceptance**: int: secret/redirect do tenant_admin biết trước không còn dùng lấy token `aud=admin`; mutation ⇒ RED.

## Câu hỏi cho tech-lead
- Q-30.1: Seed bootstrap tách khỏi `seed-dev` hay hợp nhất; có chạy ở production không (env bắt buộc nào).
- Q-30.2: DEBT-143 ghim super_admin vào tenant hệ thống — làm hay hoãn.
- Q-30.3: DEBT-137 cơ chế (bắt rotate secret, xoá redirect cũ, hay chỉ audit).

---

## Fold tech-lead (2026-10-16) — ƯU TIÊN HƠN text cũ ở trên

**Phạm vi cuối run 30**: Task 1 (B6.4 seed) + Task 3 (DEBT-161, DEBT-163) + Task 4 (DEBT-137, cơ chế thu gọn bên dưới). **Task 2 (DEBT-143) HOÃN** — giữ mở, gắn DEBT-124. Thứ tự backend-dev: Task 1 → Task 4 → Task 3 (Task 3 độc lập). Không chạm FE, không compose/FLUSH/drop, không chạy seed trên DB dev `aegate-mongo` (chỉ int-test DB riêng trên `vg-test-mongo`).

### Trả lời câu hỏi
- **Q-30.1 — Tách file, dùng lại code, CHỈ development|test.** File mới `be/src/database/seed.ts` + script `db:seed` (`node --env-file-if-exists=.env dist/database/seed.js`). `seed-dev.ts` giữ nguyên hành vi (`db:seed-dev` = fe-sso-test/demo/other + dev user; E2E đang dựa vào). `db:seed` = **bootstrap**: tenant + resource `admin` + admin user super_admin + client `fe-admin` + **gọi lại `seedDev(connection, issuer, nodeEnv)`** cho fe-sso-test/demo/other (một nguồn sự thật `buildSeedDevTargets`, không chép cấu hình). Dùng lại `assertNotProduction` (allowlist), gọi trước khi mở kết nối VÀ trong hàm ghi. Production KHÔNG hỗ trợ ở run này: `KeysModule` đã từ chối `LocalKeyProvider` ở production (app chưa chạy được production tới B7.3/Q5), redirect/domain thật chưa chốt (Q7/Q8) ⇒ DEBT-164.
- **Q-30.2 — Hoãn.** Thực tế chỉ có `default-tenant`; ghim super_admin vào tenant hệ thống khi CHƯA có thao tác xuyên tenant (DEBT-124) làm super_admin mất quyền ở tenant khác mà không có đường thay thế, và phải đổi fixture 4 int-spec (`superA` ở `TENANT_A`). Làm cùng DEBT-124 khi bật multi-tenant thật. Seed run này đặt super_admin ở `DEFAULT_TENANT_ID` (tương thích tương lai).
- **Q-30.3 — Thu hồi mọi secret + chỉ client confidential; KHÔNG xoá redirect.** Chi tiết Task 4. Lý do: client confidential + secret cũ bị thu hồi ⇒ redirect do tenant_admin cài chỉ nhận được `code`, không đổi được token (cần secret mới, chỉ super_admin thấy; sau khi có `admin`, tenant_admin không còn sửa client/secret — filter `$nin` + `assertMayModify` sẵn có). Client public không có secret ⇒ chặn hẳn.

### Task 1 [BE] — B6.4 seed bootstrap (thay text cũ)
**Thiết kế**
- `readAdminSeedConfig(env)` (zod riêng trong `seed.ts`, gọi TRƯỚC khi kết nối DB): `ADMIN_SEED_EMAIL` email; `ADMIN_SEED_PASSWORD` **12–128 ký tự** (chặt hơn rule user 8–128 vì là super_admin). Lỗi chỉ nêu tên biến + ràng buộc, KHÔNG echo giá trị. Không đổi `envSchema` của app ở run này (DEBT-165). Cập nhật `be/.env.example`: `ADMIN_SEED_PASSWORD=` (rỗng) + comment ≥12 ký tự (giá trị `change-me` cũ sẽ bị seed từ chối — đúng ý).
- `seedBootstrap(connection, cfg, issuer, nodeEnv, now?)` → **trả `{ feAdminSecret?: string }`**; CLI `main()` là nơi DUY NHẤT in secret ra stdout (`process.stdout.write`, 1 dòng `fe-admin client_secret (shown once): <secret>`); không `Logger`/pino, không audit, không ghi file. Int-test kiểm qua giá trị trả về.
- Thứ tự ghi (upsert theo khoá ổn định; dùng helper `upsert` E11000 sẵn có — export từ `seed-dev.ts`):
  1. Tenant `{id: DEFAULT_TENANT_ID}` `$setOnInsert {id, name:'Default'}` (giống `TenantService.seedDefault`).
  2. Resource `admin`: khoá `resourceId:'admin'`, `$set {identifier: adminResourceIdentifier(issuer), scopes:['admin.read','admin.write']}`; `demo`/`other` qua `seedDev`. **Hậu kiểm bắt buộc** (vì `upsert` nuốt E11000 và `resourceId` chưa unique — DEBT-127): sau upsert `findOne({resourceId:'admin', identifier: adminResourceIdentifier(issuer)})`; không có (vd. resource admin đã tạo qua API với `resourceId` khác ⇒ E11000 trên `identifier` bị nuốt) ⇒ throw lỗi rõ ràng, dừng trước khi tạo fe-admin.
  3. Admin user: `normalizeEmail`; `User.updateOne({email}, {$setOnInsert:{passwordHash: await hashPassword(pw), emailVerifiedAt: now, failedLoginCount:0}}, {upsert:true})`. **User đã tồn tại ⇒ KHÔNG đổi password, KHÔNG gỡ `lockedUntil`** (khác dev user: chạy lại seed không được reset mật khẩu admin); user tồn tại không có `passwordHash` ⇒ `console.warn` (chỉ email). Membership `UserTenant.updateOne({userId, tenantId: DEFAULT_TENANT_ID}, {$set:{status:'active'}, $addToSet:{roles:'super_admin'}}, {upsert:true})` — đây là đường khôi phục khi còn 0 super_admin (DEBT-142); ghi rõ trong README.
  4. Client `fe-admin` (`$setOnInsert` — không ghi đè cấu hình super_admin đã sửa qua API, không bật lại client đã disable): `clientType:'confidential'`, `tokenEndpointAuthMethod:'client_secret_basic'`, `grantTypes:['authorization_code','refresh_token']`, `redirectUris:['http://localhost:3000/auth/callback']`, `postLogoutRedirectUris:['http://localhost:3000/']`, `allowedCorsOrigins:[]` (BFF gọi server-side), `allowedResources:['admin']`, `scopes:['openid','profile','email','offline_access','admin.read','admin.write']`, `tenantId: DEFAULT_TENANT_ID`. Validate URI bằng `validateRedirectUriList(..., {allowHttpLocalhost:true})` TRƯỚC mọi ghi.
  5. Secret: dùng lại `ClientCredentialService` (`new ClientCredentialService(credentialModel, {getOrThrow: () => ({secretGraceTtl: 0})} as unknown as ConfigService)`) — version/hash Argon2 đúng một chỗ. `!hasActive('fe-admin')` ⇒ `createSecret` ⇒ trả secret; ngược lại không tạo, không rotate, trả `{}`.
- 2 tiến trình seed đồng thời có thể cùng tạo 2 secret — chấp nhận (CLI tuần tự, một operator), ghi JSDoc/README (DEBT-164).
- README `be/`: mục `db:seed` — env bắt buộc, chạy `db:sync-indexes` trước, secret in 1 lần; **mất secret khi còn active** ⇒ runbook: đặt `revokedAt` cho mọi `ClientCredential{clientId:'fe-admin'}` bằng mongosh rồi chạy lại `db:seed` (in secret mới).

**Acceptance (int, DB riêng `vg-int-seed-<ts>` theo mẫu `seed-dev.int-spec`)**
- Chạy `seedBootstrap` 2 lần ⇒ số document `tenants/resources/users/usertenants/clients/clientcredentials` bằng nhau giữa lần 1 và 2; lần 1 trả `feAdminSecret` (chuỗi), lần 2 `undefined`; `ClientCredential` của fe-admin đúng 1 bản, cùng `secretHash`/`version`.
- Lần 2 với `ADMIN_SEED_PASSWORD` khác ⇒ `passwordHash` KHÔNG đổi; admin đang `lockedUntil` ⇒ vẫn khoá; membership roles bị đặt `[]` ⇒ chạy lại có `super_admin`.
- Toàn luồng: admin login → `/authorize` (client fe-admin, `resource=adminResourceIdentifier(issuer)`, PKCE, scope `openid admin.read admin.write`) → consent → `/token` (`client_secret_basic` bằng secret trả về) → `GET /admin/me` 200, roles chứa `super_admin`, tenant `default-tenant`.
- Âm: `readAdminSeedConfig` thiếu/sai email, password 11 ký tự ⇒ throw nêu tên biến, message không chứa giá trị password; `NODE_ENV=production`/rỗng ⇒ throw TRƯỚC khi ghi (đếm document = 0); identifier admin đã tồn tại dưới `resourceId:'adm2'` ⇒ throw, không có client `fe-admin`, không credential.
- Không lộ: spy `console.log/console.warn` + `Logger` ⇒ không chuỗi nào chứa password hay secret.
- Mutation ⇒ RED: (a) bỏ điều kiện `hasActive` ⇒ test "lần 2 undefined" đỏ; (b) `$setOnInsert` passwordHash → `$set` ⇒ test password không đổi đỏ; (c) bỏ hậu kiểm resource ⇒ test `adm2` đỏ.

### Task 2 — HOÃN (DEBT-143 giữ mở, cùng DEBT-124). Không làm gì ở run này.

### Task 3 [BE] — DEBT-161 + DEBT-163 (thay text cũ)
- **DEBT-161** (`ClientService.updateForTenant`, nhánh `patch.disabled === true && before.disabledAt == null`): lấy `matchedCount` của `repo.updateOne` stamp. `1` ⇒ như cũ. `0` ⇒ đọc lại `getForTenant(ctx, clientId)`: `disabledAt != null` (request song song đã disable) ⇒ dùng giá trị DB cho `after.disabledAt`; ngược lại (enable song song chen giữa, hoặc super_admin vừa cấp `admin` ⇒ filter `$nin` không khớp) ⇒ throw lỗi miền mới (vd. `ConcurrentClientUpdateError`) → `toAdminError` map **409 `conflict`**. Lỗi xảy ra TRƯỚC `revokeForClient` và audit success (không audit success sai). Không gộp vào `$set` chính (giữ lý do DEBT-132).
  - Acceptance (unit với model/repo giả): stamp `matchedCount:0` + re-read `disabledAt:null` ⇒ 409, không trả `disabled:true`; re-read `disabledAt:T` ⇒ `after.disabledAt=T`; `matchedCount:1` ⇒ như cũ. Mutation bỏ kiểm `matchedCount` ⇒ RED.
- **DEBT-163** (`LocalKeyProvider.init`): sau khi đọc/ghi state, `readdir(dir)` lọc `*.pem`, kid không có trong `keys.json` ⇒ **một** `logger.warn` liệt kê kid (không đường dẫn, không nội dung), KHÔNG xoá. `readdir` lỗi ⇒ warn ngắn, không làm init thất bại. `keys.json.*.tmp` bỏ qua.
  - Runbook: thêm vào `docs/agile/sso-idp/runbook-deploy.md` mục "Sau emergency rotate": kiểm `KEY_LOCAL_DIR` chỉ còn `<newKid>.pem` + `keys.json`; WARN orphan khi khởi động ⇒ xoá thủ công đúng kid đã lộ sau khi xác nhận kid không có trong `keys.json` (thư mục dùng chung nhiều process: orphan có thể là PEM vừa tạo của process khác đang rotate — chỉ xoá kid đã biết là bị lộ).
  - Acceptance (unit `keys.spec`, thư mục tạm): `orphan.pem` + state hợp lệ ⇒ `init` warn đúng 1 lần chứa `orphan`, file vẫn còn; không orphan ⇒ không warn. Mutation warn mọi pem (bỏ lọc theo state) ⇒ RED.

### Task 4 [BE] — DEBT-137 nâng client thành admin-capable (thay text cũ)
- **Rule A (create + PATCH): resource `admin` chỉ cho client `confidential`.** `createForTenant`: `allowedResources` chứa admin + `clientType:'public'` ⇒ `InvalidClientConfigError` (400). PATCH: `clientType` bất biến; kiểm trên bản đọc trước (bước 1 dưới).
- **Rule B (PATCH bởi super_admin thêm `admin` cho client CHƯA có `admin`) — thu hồi mọi secret, 2 lượt:**
  1. `assertAllowedResources` (sẵn có) → đọc tenant-scoped `getForTenant(ctx, clientId)` (null ⇒ 404 như cũ, không đụng secret client tenant khác); chuyển trạng thái = `before.allowedResources` không chứa admin id && patch chứa admin id (nhánh super_admin hiện bỏ qua `adminResourceIds()` ⇒ phải tra khi `patch.allowedResources` có mặt).
  2. Public ⇒ 400 (Rule A). Confidential ⇒ `credentials.revokeAll(clientId, now)` (method mới: `updateMany({clientId, revokedAt:null}, {$set:{revokedAt: now}})`, trả số bản) **TRƯỚC** update — lỗi ⇒ 5xx, chưa cấp admin (fail-closed).
  3. Update như cũ (findOneAndUpdate).
  4. `revokeAll` **lần 2 SAU** update (bắt secret tenant_admin phát hành chen giữa bước 2–3; sau bước 3 `assertMayModify` chặn tenant_admin). Lỗi ⇒ audit `ADMIN_CLIENT_UPDATED result:'failure' reason:'secret_revoke_failed'` + 5xx; khôi phục: super_admin `DELETE /admin/clients/:id/secrets/:version`.
  5. Audit: `ADMIN_CLIENT_UPDATED` metadata thêm `adminGranted:true`; thêm `CLIENT_SECRET_REVOKED` `{reason:'admin_granted', count:n}` khi `n>0`. Không thêm enum.
  - Điều phối đặt ở `ClientService.updateForTenant` (inject `ClientCredentialService` — kiểm `ClientsModule` providers) hoặc controller — chọn chỗ ít đổi nhất, nhưng bước 2 trước update, bước 4 sau.
  - Refresh family không cần revoke: family hiện có bind resource khác `admin` (1 resource/grant, không token exchange) nên không nâng lên `aud=admin` được.
- Tenant_admin vẫn bị chặn thêm `admin` (403 sẵn có) — không đổi.
- **Acceptance (int `admin-api`)**: client confidential tenant A do tenant_admin tạo + `POST secrets` (secret S); super_admin PATCH thêm `admin` ⇒ 200, mọi `ClientCredential` của client `revokedAt != null`; client auth bằng S (`/token` hoặc `/introspect`) ⇒ `invalid_client`; super_admin `POST secrets` ⇒ secret mới dùng được; tenant_admin `POST secrets`/PATCH redirect ⇒ 403. Client public + super_admin POST/PATCH có `admin` ⇒ 400, DB không đổi. PATCH lại (đã có admin) ⇒ không revoke thêm. Audit có `adminGranted` + `CLIENT_SECRET_REVOKED reason=admin_granted`. Mutation ⇒ RED: bỏ cả 2 lượt revoke ⇒ S vẫn dùng được; bỏ Rule A ⇒ test public đỏ.
- Rủi ro còn lại (DEBT-166): `issueSecret` của tenant_admin đã qua `assertMayModify` trước bước 3 nhưng insert sau bước 4 (cửa sổ ms, cần step-up) ⇒ secret sống sót.

### Kiểm tra chung
- `pnpm -C be lint`, unit, `test:int` xanh; không hồi quy admin int-spec run 27–29 và `seed-dev.int-spec`.
- Khi xong: đóng DEBT-137/161/163 trong backlog. Tech-lead đã mở DEBT-164…166.

### Retry 1 [BE] — tester FAIL case 1 (seed re-point `admin`) + DEBT-172 + DEBT-169
- [x] (a) `seedBootstrap` bước 0 (trước mọi ghi): chưa có `admin` mang admin identifier ⇒ client nào tham chiếu `admin` (trừ `fe-admin` khi mọi `admin` cũ có dạng `<origin>/admin/` = đổi ISSUER) ⇒ throw, không ghi. `POST /admin/resources` rà: `createUnique` chặn trùng `resourceId`, identifier immutable, client chỉ tham chiếu resource đã tồn tại ⇒ không có referrer tồn tại trước ⇒ không đổi.
- [x] (b) DEBT-172 runtime: `adminTargetForbidden` — `/authorize` + consent POST + `/token` code + refresh.
- [x] (c) DEBT-169: `ADMIN_SEED_PASSWORD` rời `envSchema`/`configuration`.
