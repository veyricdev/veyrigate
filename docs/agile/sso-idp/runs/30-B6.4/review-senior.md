# Senior Review — 2026-10-19 (run 30 B6.4, lượt 1)

## Kết luận: PASS

Không có 🔴. Còn 🟡 (vào backlog DEBT-169…171) — không chặn tester.

Bằng chứng tự chạy: `pnpm -C be typecheck` ✅; unit **260/260** (24 suites); `test:int -- seed admin-api` **81/81** (3 suites: `seed`, `seed-dev`, `admin-api`) trên `vg-test-*`. Không chạy E2E, không chạy seed trên DB dev.

## Tổng quan

Diff gọn, bám sát fold tech-lead. Điểm tốt:
- **Seed** (`be/src/database/seed.ts`): chặn production 2 lớp (`main` trước khi kết nối + `seedBootstrap` trước khi ghi, allowlist `development|test`); admin user và `fe-admin` chỉ `$setOnInsert` (re-run không reset password/lock, không ghi đè cấu hình/không bật lại client disable); secret chỉ tạo khi `!hasActive` và chỉ rời process qua `process.stdout.write` trong `main`; hậu kiểm resource admin chặn trường hợp E11000 bị nuốt; zod riêng cho env admin, message chỉ nêu tên biến + ràng buộc. Int-spec phủ đủ acceptance (2 lần không nhân đôi, secret 1 lần, password/lock giữ, roles khôi phục, `adm2` ⇒ throw không tạo client/credential, prod/unset/rỗng ⇒ 0 document, spy console/Logger/stdout, toàn luồng login → `/authorize` → `/token` basic → `/admin/me` 200 super_admin).
- **DEBT-137**: rule A (admin chỉ cho confidential) ở cả create và PATCH; revoke lượt 1 TRƯỚC update (lỗi ⇒ 5xx, chưa cấp — test "S still works"), lượt 2 NGAY SAU update và trước stamp disable (lỗi ⇒ `AdminGrantSecretRevokeError` → audit failure `secret_revoke_failed` + 5xx). Đọc `current` tenant-scoped ⇒ client tenant khác 404, secret không bị đụng (có test). `ClientCredentialService` đã có trong `ClientsModule.providers`; thiếu wiring ⇒ throw (fail-closed).
- **DEBT-161**: `matchedCount !== 1` ⇒ re-read; không hề báo disable chưa xảy ra; throw trước `revokeForClient`/audit success.
- **DEBT-163**: WARN 1 lần, chỉ kid + tên `keys.json` (không đường dẫn, không nội dung), không xoá, `readdir` lỗi không làm init thất bại; runbook §6 rõ ràng.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Production / env**: `assertNotProduction` gọi trước `validateEnv`/kết nối và lại trong `seedBootstrap` (test 0 document với `production`/unset/rỗng). `validateEnv` + `readAdminSeedConfig` chỉ in path + message, không echo giá trị (zod default/custom message không chứa input).
- **Exposure secret/password**: password chỉ đi vào `hashPassword`; secret fe-admin trả về giá trị, `main` là nơi in duy nhất; không pino/audit/file. Lỗi sau `createSecret` không tồn tại (không bước nào sau nó trừ `connection.close` ở `finally`, chạy sau khi in). Mất secret ⇒ runbook revoke + chạy lại (README).
- **Idempotency**: upsert theo khoá ổn định; `$setOnInsert` cho user/fe-admin; `$addToSet` roles; credential chỉ khi không còn active. 2 tiến trình song song ⇒ 2 secret: đã chấp nhận (DEBT-164).
- **Authorization DEBT-137**: tenant_admin vẫn 403 khi thêm `admin` (`assertAllowedResources`); super_admin cấp ⇒ mọi secret cũ thu hồi; refresh grant của confidential client cần client auth ⇒ secret bị thu hồi chặn luôn refresh cũ. Public client không thể có admin (400, DB không đổi). Cross-tenant ⇒ 404, không revoke.
- **Fail-closed**: revoke lượt 1 lỗi ⇒ không cấp; lượt 2 lỗi ⇒ 5xx + audit failure, khôi phục bằng DELETE secret. Cửa sổ còn lại đã ghi nhận DEBT-166.
- **State/concurrency DEBT-161**: stamp có điều kiện `disabledAt:null` + kiểm `matchedCount`; nhánh re-read thấy `disabledAt` ⇒ trả giá trị DB; chưa disable/biến mất ⇒ 409. Không còn response `disabled:true` sai.
- **Log DEBT-163**: kid là thông tin công khai (JWKS); không lộ đường dẫn/PEM.

## 🟡 Nên sửa

🟡 **[BE] DX/onboarding: `.env.example` làm app không khởi động được** (DEBT-169)
`be/.env.example:45` — `ADMIN_SEED_PASSWORD=` (rỗng) trong khi `envSchema` (`be/src/config/validation.schema.ts:59`) vẫn yêu cầu `z.string().min(1)`.
Vì sao: luồng onboarding trong `README.md:46` (`cp be/.env.example be/.env`) giờ làm `pnpm start:dev`, `db:sync-indexes`, `db:seed-dev` đều fail `ADMIN_SEED_PASSWORD` ngay — trước run 30 chạy được với `change-me`. Fail-closed nên không có rủi ro bảo mật, nhưng là regression không có trong acceptance.
Đề xuất: làm luôn DEBT-165 (bỏ `ADMIN_SEED_*` khỏi `envSchema`/`configuration` — không có consumer runtime) hoặc tối thiểu thêm ghi chú "điền `ADMIN_SEED_PASSWORD` ≥12 ký tự trước khi chạy" vào bước copy env của `README.md`.

🟡 **[BE] Audit: DEBT-167 nên ưu tiên lên — có thể cấp `admin` mà không có dòng audit nào** (đánh giá DEBT-167, không mở trùng)
`be/src/modules/clients/client.service.ts:308-330` + `admin-clients.controller.ts:138-153` — PATCH `{allowedResources:[…admin], disabled:true}` của super_admin: update chính + 2 lượt revoke đã ghi DB, rồi stamp thua race ⇒ `ConcurrentClientUpdateError` ⇒ 409, controller không audit gì.
Vì sao: thay đổi "nửa vời" về mặt quan sát — DB nhất quán (một `findOneAndUpdate` nguyên tử, retry hội tụ, không có trạng thái hỏng), nhưng một lần nâng quyền client lên `aud=admin` + thu hồi secret không để lại dấu vết audit; tương tự `redirectUris` đổi bởi tenant_admin khi race với super_admin grant. Xác suất thấp (cần 3 request chen nhau) nên không 🔴.
Đề xuất (rẻ, ~8 dòng, cùng mẫu `AdminGrantSecretRevokeError` đã có): trong `.catch` của controller, khi `err instanceof ConcurrentClientUpdateError` ⇒ `audit.record({...base, action: ADMIN_CLIENT_UPDATED, result:'failure', reason:'concurrent_update'})` (best-effort). Muốn đủ `changedFields`/`adminGranted` thì đính `before`/flag vào error.

🟡 **[BE] Audit: revoke lượt 1 thành công nhưng update không xảy ra ⇒ secret bị thu hồi im lặng** (DEBT-170)
`be/src/modules/clients/client.service.ts:275` rồi `:297-306` — sau `revokeAllSecrets` lượt 1, nếu `findOneAndUpdate` trả `null` (client bị xoá chen giữa ⇒ 404) hoặc ném lỗi DB (5xx), mọi secret của client đã `revokedAt` nhưng không có `CLIENT_SECRET_REVOKED` nào.
Vì sao: fail-closed đúng (không cấp quyền), nhưng client confidential đang chạy mất secret mà audit/ops không biết lý do.
Đề xuất: gộp cùng fix DEBT-167 — controller audit failure `reason:'admin_grant_aborted'` kèm `count` khi service báo đã revoke (vd. trả/đính `secretsRevoked` vào error).

## 💭 Nit

- `be/src/database/seed.ts:150-176` — `ADMIN_SEED_EMAIL` trùng email một user thường đã tồn tại ⇒ user đó được gắn `super_admin` với mật khẩu cũ của họ, chỉ có dòng log "ensured super_admin". Dev-only, chủ ý (đường khôi phục); cân nhắc `console.warn` khi user đã tồn tại TRƯỚC lần seed đầu (vd. upsert trả `upsertedCount === 0` và membership chưa có `super_admin`).
- `be/src/database/seed.ts:133` — `$set identifier` ghi đè identifier của resource `admin` khi `ISSUER` đổi: đúng ý (khoá theo `resourceId`), chỉ nên thêm 1 dòng trong README rằng đổi `ISSUER` thì chạy lại `db:seed`.
- Client public đã có `admin` từ trước run 30 (dữ liệu cũ) không bị rule A chạm tới; hiện chỉ seed/super_admin tạo được nên không có — ghi nhận, không cần làm.

## ✂️ Ponytail

- be/src/database/seed.ts:L160: shrink: `findOne(...).select('_id')` rồi `exists({email, passwordHash:{$exists:true}})` = 2 query. `select('_id passwordHash')` một lần rồi kiểm `!userDoc.passwordHash`.
- be/src/modules/clients/client.service.ts:L337: shrink: trả hai shape tuỳ `adminGranted`. Luôn `return { before, after, adminGranted, secretsRevoked }` (controller đã kiểm truthy).
- be/src/modules/clients/client.service.ts:L273: shrink: `adminResourceIds()` tra lại resource admin mà `assertAllowedResources` vừa tìm thấy. Cho `assertAllowedResources` trả `resourceId` admin (hoặc `undefined`) thay vì boolean.
- be/src/database/seed.ts:L87: delete: helper `model<T>` chỉ để `connection.models[name] ?? connection.model(name)`; `seed-dev.ts` viết inline. Giữ cũng được — 4 dòng.
net: -10 lines possible.

---

# Senior Review — 2026-10-19 (run 30 B6.4, lượt 2 — sau backend-dev retry 1)

## Kết luận: PASS

Không có 🔴. 🔴 của tester (DEBT-137 bypass qua seed re-point) đã đóng ở 2 lớp: seed từ chối trước mọi ghi, và chặn runtime `aud=admin` cho client không confidential ở cả 4 điểm phát hành. Còn 🟡 mới DEBT-174/175 (backlog) — không chặn tester.

Bằng chứng tự chạy (vg-test-*): `pnpm -C be typecheck` ✅; unit **262/262** (24 suites); int **697/697** (32 suites, gồm 3 PoC tester `seed-risk*.int-spec` không sửa — nay xanh). Probe tạm (`be/test/zz-review-probe.int-spec.ts`, DB `vg-int-reviewprobe-*` tự drop, file đã xoá sau khi chạy) cho các biến thể bên dưới. Không E2E, không chạy seed trên DB dev, không đụng `be/.env`/`be/keys`.

## Tổng quan

Fix đúng hướng và đủ hẹp: guard seed bước 0 (`be/src/database/seed.ts:133-160`) chạy trước mọi ghi, quét referrer `admin` toàn bộ tenant, chỉ miễn `fe-admin` khi mọi `admin` cũ có dạng `<origin>/admin/` (đổi ISSUER); `adminTargetForbidden` (`token.service.ts:37-43`) là predicate thuần, fail-closed với `clientType` lạ/thiếu, gắn ở `/authorize` (redirect `invalid_target`), consent POST (re-resolve client ⇒ trang lỗi, không code, không consent), `/token` code (sau consume ⇒ code mất, đúng fail-closed) và refresh (lọc khỏi allowlist, dùng chung list cho `rotate` ⇒ `invalid_grant`, không burn, không reuse-alarm giả). Mỗi test runtime có control `demo` ⇒ guard không phải blanket refusal. DEBT-169: `ADMIN_SEED_PASSWORD` rời `envSchema`/`configuration` (không còn consumer runtime); unit đọc `.env.example` thật là cách kiểm hồi quy tốt.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm (lượt 2)

- **PoC tester**: 3 test đỏ lượt trước nay xanh, không chỉnh test. Mutation dev (bỏ guard seed ⇒ 7 đỏ; bỏ seed+authorize ⇒ flow PoC đỏ; bỏ từng chốt runtime ⇒ 1 đỏ) khớp với đọc code.
- **`clientType` lạ**: probe `clientType:'Confidential'` (sai hoa/thường) + `none` ⇒ `/token` 400 `invalid_target` — so sánh `!== 'confidential'` là allowlist, fail-closed ✅.
- **Refresh token cũ public+admin**: `allowedIdentifiers` đã lọc được truyền vào `rotate` (atomic filter) ⇒ pre-check và rotate nhất quán, family không bị revoke/burn, không phát AT ✅ (int `admin-public-client` + đọc `refresh-token.service.ts:139-176`).
- **Consent**: kiểm trên client *hiện tại* (re-resolve), `ctx.resource` là identifier đã chuẩn hoá lúc `/authorize` ⇒ so chuỗi với `adminResourceIdentifier(issuer)` đúng sink.
- **Seed guard**: chạy trước tenant/resource upsert (0 ghi khi từ chối); không phân tenant khi tìm referrer (đúng — client tenant khác cũng thành admin-capable); message chỉ nêu `clientId` (không secret). Race check-then-write với client confidential + ngoại lệ fe-admin `/admin/` origin khác: đã ghi DEBT-173 (1)(2) — cả hai cần super_admin hoặc canh thời điểm với CLI dev-only, chấp nhận.
- **AT `aud=admin` cũ của client public qua `AdminTokenGuard` (DEBT-173 (3))**: probe xác nhận AT ký trước fix (public client vẫn liệt kê `admin`) ⇒ `GET /admin/me` **200** super_admin; `/introspect` cũng `active:true` (cùng `isAccessTokenLive`). Đánh giá: **không phải lỗ khai thác được sau deploy** ⇒ 🟡, không 🔴, vì: (a) sau fix không còn đường phát hành nào (`signAccessToken` chỉ có 2 caller: code + refresh, cả 2 đã chặn); (b) đường duy nhất để tenant_admin tạo dữ liệu public+admin là seed re-point — mã mới của chính run 30, chưa từng commit/deploy ⇒ không tồn tại AT nào sinh từ nó; trước run 30 chỉ super_admin tự gán mới có; (c) cửa sổ dư ≤ `ACCESS_TOKEN_TTL` (900s) sau deploy. Vẫn khuyến nghị làm ngay khi chạm lại (2 dòng: `seen.client` lấy thêm `clientType` + `tokenEndpointAuthMethod`, từ chối nếu không confidential/`none`) — resource server là điểm thực thi cuối, phủ mọi đường phát hành tương lai.
- **Env / dev / E2E**: `envSchema` không `.strict()` ⇒ `e2e/config/env.ts` (vẫn truyền `ADMIN_SEED_PASSWORD`) và `be/.env` cũ (`change-me`) không vỡ boot; `ci.yml` chỉ dùng `ADMIN_SEED_EMAIL`. `db:seed` vẫn đòi 12..128 qua zod riêng (README ghi rõ). `configuration.adminSeed` giữ `email` (seed-dev dùng chặn trùng).

## 🟡 Nên sửa (mới)

🟡 **[BE] Invariant runtime khoá theo `clientType`, nhưng client auth khoá theo `tokenEndpointAuthMethod`** (DEBT-174)
`be/src/modules/oauth/token/token.service.ts:42` — `adminTargetForbidden` chỉ xét `clientType`, còn `ClientAuthenticationService.authenticate` (`client-authentication.service.ts:113-118`) cho qua không secret mọi client có `tokenEndpointAuthMethod:'none'`.
Vì sao: docstring hứa chặn cả "a direct DB write", nhưng bản ghi lệch `{clientType:'confidential', tokenEndpointAuthMethod:'none'}` + `admin` ⇒ probe: code `aud=admin` đổi được ở `/token` **200 chỉ với PKCE, không secret**. API (`isValidAuthMethodFor` khi create, `clientType`/method bất biến khi PATCH) và seed không tạo được tổ hợp này ⇒ không phải đường của tenant_admin, nên 🟡. Nhưng thứ thực sự chứng minh "có secret" là method, không phải type.
Đề xuất: `adminTargetForbidden(client, …)` nhận client và trả `true` khi `clientType !== 'confidential' || tokenEndpointAuthMethod === 'none'`; dùng chung cho chốt `AdminTokenGuard` của DEBT-173 (3).

## 💭 Nit

- `authorize.service.ts:312,453` — `adminResourceIdentifier(this.issuer)` tính lại (new URL) mỗi request ở 2 chỗ trong khi `TokenService.adminResource` đã có sẵn (refresh dùng nó). Xem ponytail.

## ✂️ Ponytail (lượt 2, chỉ phần retry 1)

- be/src/modules/oauth/authorize/authorize.service.ts:L312: shrink: `adminResourceIdentifier(this.issuer)` gọi 2 lần/request. Một field `private readonly adminAud` trong constructor (như `AdminTokenGuard.adminAud`).
- be/src/modules/oauth/token/token.service.ts:L37: shrink: predicate nhận `(clientType, resource, adminIdentifier)` rời rạc, cả 4 caller đều có client + `adminResource`. Nhận `client` (gộp với DEBT-174) ⇒ caller ngắn hơn, không quên field.
net: -6 lines possible.
