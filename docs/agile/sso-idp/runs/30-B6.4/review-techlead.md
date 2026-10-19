# Tech Lead Review — 2026-10-16

## Kết luận: PASS (có fold bắt buộc trong `tasks.md` mục "Fold tech-lead")

Phạm vi cuối: **Task 1** (B6.4 seed bootstrap) + **Task 3** (DEBT-161, DEBT-163) + **Task 4** (DEBT-137, thu gọn). **Task 2 (DEBT-143) hoãn**, gắn với DEBT-124. Không có blocker: text gốc mơ hồ nhưng các quyết định còn thiếu đã chốt trong fold, nên không cần trả về analyst.

## Kiến trúc đề xuất

- Giữ modular monolith, không thêm module. Seed là CLI rời (`be/src/database/seed.ts`, `db:seed`), giống `seed-dev.ts`/`sync-indexes.ts`: kết nối Mongoose thô, không boot Nest.
- Q-30.1: tách file nhưng dùng lại code. `db:seed` gọi lại `seedDev()` cho fe-sso-test/demo/other (một nguồn sự thật `buildSeedDevTargets`), dùng lại `ClientCredentialService` (`hasActive`/`createSecret`), `hashPassword`, `normalizeEmail`, `adminResourceIdentifier`, `assertNotProduction`. `db:seed-dev` giữ nguyên vì E2E đang dựa vào nó. Chỉ chạy development|test: production chưa khả thi (`KeysModule` từ chối `LocalKeyProvider` ở production; Q5/Q7/Q8 còn mở). Ghi DEBT-164.
- Q-30.2: hoãn. Hiện chỉ có `default-tenant`. Nếu ghim mà chưa có DEBT-124 (xuyên tenant) thì super_admin mất quyền ở mọi tenant khác và không có đường thay thế; 4 int-spec dùng `superA` ở `TENANT_A`. Seed đặt super_admin ở `DEFAULT_TENANT_ID` để tương thích về sau.
- Q-30.3: khi super_admin thêm `admin` cho client chưa có admin thì thu hồi toàn bộ secret, làm 2 lượt (trước và sau update). Thêm quy tắc chỉ client confidential mới được dùng resource `admin`. Không xoá redirect: không có secret thì redirect do tenant_admin cài chỉ nhận được `code`, không đổi được token.

## Điểm mạnh

- Nền sẵn có khớp thiết kế: `TenantService.seedDefault` (upsert `$setOnInsert`), `seed-dev` (allowlist env, upsert theo khoá ổn định, kiểm env trước khi kết nối), `ClientCredentialService.hasActive/createSecret` (version max+1 có retry E11000), `AdminTokenGuard` lấy vai trò từ `UserTenant` theo `client.tenantId`.
- Việc chặn tenant_admin với client đã có admin đã được làm atomic (`$nin` trong filter). Task 4 chỉ phải lấp khoảng hở trước thời điểm cấp quyền.
- Task 3 nhỏ và cục bộ (`updateForTenant` stamp, `LocalKeyProvider.init`).

## Vấn đề (đã fold, backend-dev bắt buộc làm theo)

- [x] Text gốc chưa chốt tách hay gộp seed, chưa chốt phạm vi production, chưa chốt cơ chế DEBT-137: đã chốt (xem trên).
- [x] **Seed nuốt E11000 không an toàn cho resource `admin`**: `upsert()` bỏ qua E11000. Nếu identifier admin đã tồn tại dưới `resourceId` khác (tạo qua API), upsert theo `resourceId:'admin'` sẽ âm thầm không ghi gì, còn fe-admin trỏ `allowedResources:['admin']` vào một resource không tồn tại. Bắt buộc hậu kiểm `findOne({resourceId, identifier})` và throw nếu không thấy.
- [x] **Không reset mật khẩu admin khi chạy lại**: `seedDevUser` dùng `$set passwordHash` và gỡ `lockedUntil`, nhưng làm vậy với super_admin là sai. Admin user dùng `$setOnInsert`, không đụng `lockedUntil`. Membership dùng `$addToSet super_admin` + `status:'active'` làm đường khôi phục (DEBT-142).
- [x] **fe-admin dùng `$setOnInsert`** để không ghi đè cấu hình super_admin đã sửa qua API.
- [x] **Secret "in đúng 1 lần" phải test được**: `seedBootstrap` trả `{feAdminSecret?}`, chỉ CLI in ra stdout; không đi qua Logger/pino/audit/file.
- [x] **Mật khẩu admin**: dùng schema riêng của seed, 12–128 ký tự. `.env.example` hiện để `change-me`, phải đổi thành rỗng.
- [x] **DEBT-137 cho client public**: thu hồi secret không có tác dụng vì client public không có secret, nên bắt buộc Rule A (admin ⇒ confidential).
- [x] **DEBT-137 fail semantics**: thu hồi trước update (lỗi thì chưa cấp quyền, fail-closed) và thu hồi lại sau update (bắt secret phát hành chen giữa). Lỗi ở lượt 2: audit failure + 5xx, khôi phục bằng `DELETE secrets/:version`.
- [x] **DEBT-161**: `matchedCount 0` ⇒ đọc lại; vẫn chưa disable thì 409 trước khi revoke/audit success, không trả `disabled:true` sai.

### Cổng security design (seed + DEBT-137 chạm trust boundary)

- Tài sản/actor: secret fe-admin, mật khẩu super_admin, client có quyền lấy `aud=admin`. Actor: operator (CLI, có quyền DB), super_admin, tenant_admin (đối thủ trong DEBT-137).
- Invariant: chạy lại seed không reset mật khẩu, không gỡ khoá, không rotate secret, không nhân đôi document. Client có admin thì không còn secret nào phát hành trước thời điểm cấp quyền, và không là client public.
- Abuse case: tenant_admin cài sẵn redirect/secret rồi nhờ super_admin cấp `admin` (đã đóng bằng revoke + Rule A). Seed chạy nhầm ở production (allowlist chặn trước khi kết nối). Resource admin trùng identifier (hậu kiểm). Race secret của tenant_admin (DEBT-166, cửa sổ ms, cần step-up).
- Failure: Mongo lỗi giữa chừng khi seed ⇒ throw, chạy lại thì hội tụ. Lỗi revoke ở lượt 1 ⇒ fail-closed, ở lượt 2 ⇒ 5xx + audit failure. `readdir` lỗi trong `init` ⇒ chỉ warn.
- Exposure: secret chỉ nằm trong giá trị trả về/stdout CLI. Password không xuất hiện trong lỗi zod/log (có test spy). Audit chỉ ghi count/flag. WARN orphan chỉ ghi kid.

## Đề xuất (không bắt buộc, đã ghi backlog)

- DEBT-164: seed production (redirect/domain từ env, KMS, khoá chống chạy đồng thời) — B7.
- DEBT-165: `ADMIN_SEED_*` đang là env bắt buộc lúc runtime của app (`configuration.adminSeed` không có consumer). Nên bỏ khỏi `envSchema`, chỉ để seed đọc (least privilege) — B7.3.
- DEBT-166: race `issueSecret` của tenant_admin vượt qua revoke lượt 2. Có thể kiểm lại sau khi insert (client đã có admin ⇒ revoke version vừa tạo + 403) — B7.1.
- DEBT-127 (`resourceId` unique) vẫn mở, chuyển đích sang B7.1: cần dọn DB dev/E2E (ops), không thuộc agent run này. Run này đã giảm thiểu bằng hậu kiểm trong seed.
