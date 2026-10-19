# Tasks — run 31 — admin-hardening: DEBT-173/174/175/176/167/170

> Nguồn: backlog.md (DEBT-167, 170, 173, 174, 175, 176) — dư sau run 27–30 (admin API, seed). Spec §9.11 (control-plane, audit đầy đủ), INV-24/26, D6. Mỗi task: test âm + mutation RED. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`; không chạy seed trên DB dev.

### [x] Task 1 [BE]: DEBT-174 + DEBT-175 + DEBT-173(3) — một invariant "client được phép aud=admin"
- Predicate duy nhất nhận `client`: từ chối khi `clientType !== 'confidential'` HOẶC `tokenEndpointAuthMethod === 'none'` (allowlist method thật sự xác thực). Dùng chung ở `/authorize`, consent, `/token`, refresh **và `AdminTokenGuard`** (chặn token `aud=admin` cũ của client public/lệch — DEBT-173 điểm 3). Tính `adminAud` một lần (DEBT-175).
- **Acceptance**: int: bản ghi lệch `{confidential, none}` + admin ⇒ không đổi được code / refresh, token cũ ⇒ 401/403 ở `/admin/*`; client hợp lệ không hồi quy; mutation từng chốt ⇒ RED.

### [x] Task 2 [BE]: DEBT-173(1)(2) + DEBT-176 — seed an toàn khi đồng thời
- Seed kiểm/đồng bộ unique index trước khi ghi (gọi `syncAllIndexes` hoặc exit 1 khi thiếu — tech-lead chốt); đóng check-then-write của guard re-point (vd. re-check sau upsert + rollback/throw, hoặc thao tác điều kiện) ; xem lại ngoại lệ `fe-admin`.
- **Acceptance**: int: 2 seed song song trên DB chưa sync ⇒ không nhân đôi; race tenant_admin gắn admin giữa check và upsert ⇒ seed fail-closed; mutation ⇒ RED.

### [x] Task 3 [BE]: DEBT-167 + DEBT-170 — audit đầy đủ khi PATCH client thất bại một phần
- Khi service đã ghi thay đổi / đã revoke secret rồi gặp 409/404/lỗi DB: controller ghi audit failure kèm `changedFields`/`revokedCount` (`reason: 'concurrent_update' | 'admin_grant_aborted'`), không mất dấu vết; hoặc dời 409 trước update chính nếu gọn hơn (tech-lead chốt).
- **Acceptance**: int: mô phỏng từng nhánh ⇒ có audit tương ứng, không lộ secret; mutation ⇒ RED.

## Câu hỏi cho tech-lead
- Q-31.1: AdminTokenGuard chặn theo client hiện tại (DB) — chấp nhận chi phí tra client mỗi request (đã có `seen.client`?).
- Q-31.2: Seed: tự `syncAllIndexes` hay bắt buộc chạy trước.

## Fold tech-lead (2026-10-19) — ƯU TIÊN hơn text phía trên

**Q-31.1 — chốt**: chặn ở `AdminTokenGuard` theo client hiện tại trong DB. Chi phí = 0: `isAccessTokenLive` đã gọi `ClientService.findByClientId` (trả nguyên `Client` lean, có `clientType` + `tokenEndpointAuthMethod`) và guard đã giữ nó trong `seen.client`; chỉ nới type `seen` thành `Client` và thêm 1 nhánh sau `if (!live || !seen.client)`. Không thêm query, không cache.
**Q-31.2 — chốt**: seed TỰ đảm bảo index, nhưng bằng `model.createIndexes()` cho mọi model trong `MODELS` (chỉ tạo thiếu, không drop), KHÔNG gọi `syncAllIndexes` (drop index ngoài schema là tác dụng phụ bất ngờ của một lệnh seed). Lỗi (E11000 do dữ liệu đã trùng, xung đột spec/tên index) ⇒ throw trước MỌI ghi ⇒ CLI exit 1, message gợi ý chạy `db:sync-indexes`/dọn trùng. README giữ khuyến nghị `db:sync-indexes`.

### Task 1 — chốt
- Predicate nhận `client` (gộp DEBT-174/175), **allowlist**: client được phép `aud=admin` ⇔ `clientType === 'confidential' && (tokenEndpointAuthMethod === 'client_secret_basic' || tokenEndpointAuthMethod === 'client_secret_post')`. Thiếu field/giá trị lạ ⇒ cấm (fail-closed; khớp client auth vốn chỉ nhận đúng method lưu). Dạng gợi ý: `adminTargetForbidden(client: Pick<Client,'clientType'|'tokenEndpointAuthMethod'>, resource: string|undefined, adminAud: string)` hoặc tách `isAdminCapableClient(client)` + caller so `resource === adminAud` — dev chọn, nhưng MỘT định nghĩa duy nhất.
- 5 chốt: `/authorize` (`resolveResource`), consent (`decideConsent`), `/token` code (`issueForAuthorizationCode`), refresh (`issueForRefresh` filter allowlist), `AdminTokenGuard` (⇒ `AdminAuthError.invalidToken()` 401, cùng mã với token không live, không lộ lý do). `AuthorizeService` tính `adminAud` một lần trong constructor (bỏ 2 lần `adminResourceIdentifier(this.issuer)`/request).
- KHÔNG đổi `isAccessTokenLive`/`/introspect`/`/userinfo` trong run này (admin API chỉ đi qua guard) ⇒ DEBT-177.
- Acceptance bổ sung: (a) client `{confidential, none}` + `admin` (ghi DB trực tiếp) ⇒ `/authorize resource=admin` redirect `invalid_target`; code đã cấp trước khi lệch ⇒ `/token` 400 `invalid_target` (nếu không auth được qua PKCE thì ghi rõ chốt nào chặn); refresh `aud=admin` ⇒ 400 `invalid_grant`, family không burn. (b) AT `aud=admin` cấp hợp lệ cho client confidential, sau đó đổi DB client thành `{public,none}` hoặc `{confidential,none}` ⇒ `GET /admin/me` 401 `invalid_token`. (c) control: fe-admin/`client_secret_post` không hồi quy. Mutation: bỏ từng chốt (5) và revert predicate về chỉ kiểm `clientType` ⇒ RED ở (a)/(b).

### Task 2 — chốt (đơn giản nhất, đóng DEBT-173(1)(2) bằng cấu trúc)
- **Seed KHÔNG BAO GIỜ re-point resource `admin`**. Bước 2 đổi `$set` ⇒ `$setOnInsert: {resourceId, identifier, scopes}`; giữ post-check `exists({resourceId:'admin', identifier: adminAud})` ⇒ throw.
- Guard bước 0 rút gọn: (i) resource `admin` tồn tại với identifier ≠ `adminAud` (kể cả dạng `<origin>/admin/` do đổi ISSUER) ⇒ throw trước mọi ghi, KHÔNG có ngoại lệ fe-admin (operator tự sửa/xoá bản ghi rồi chạy lại; ghi hướng dẫn trong message + README); (ii) resource `admin` chưa tồn tại mà có client tham chiếu `admin` ⇒ throw (giữ nguyên). Bỏ `isAdminIdentifierShape`/`issuerMove`.
- Lý do đóng race: khi `admin` chưa tồn tại, tenant_admin không thể gắn `admin` qua API (`assertAllowedResources` đòi resource tồn tại và đọc `identifier` trong CÙNG một query ⇒ đọc sau insert thì thấy admin ⇒ 403). Không còn trạng thái "admin tồn tại nhưng chưa phải admin identifier rồi bị seed đổi".
- Index: đầu `seedBootstrap` (sau `assertNotProduction`, trước bước 0) gọi `createIndexes()` cho mọi `MODELS` (để test gọi trực tiếp được). Credential fe-admin 1–2 bản khi chạy song song vẫn là DEBT-164 (ngoài phạm vi).
- Acceptance thay thế: (a) DB rỗng chưa có index, `Promise.all` 2 `seedBootstrap` (2 connection) lặp ≥10 vòng ⇒ mỗi vòng đúng 1 user email, 1 `fe-admin`, 1 resource `admin`/`demo`/`other`, 1 `fe-sso-test`, 1 membership (credential: 1–2, không assert =1). Mutation bỏ `createIndexes` ⇒ RED (chấp nhận RED xác suất; ghi số vòng RED/10). (b) dữ liệu đã trùng email ⇒ seed throw trước ghi, 0 document mới. (c) `admin` có identifier khác (legacy API) hoặc dạng ISSUER cũ, chỉ fe-admin tham chiếu ⇒ refused, identifier KHÔNG đổi (sửa test `ISSUER change … fe-admin alone => re-pointed` thành refused). (d) chạy lại cùng ISSUER ⇒ idempotent, scopes đã sửa của `admin` không bị reset. Mutation: `$setOnInsert`→`$set` ⇒ RED ở (c).

### Task 3 — chốt (loại bỏ 409-sau-ghi thay vì audit nó)
- **DEBT-167**: `PATCH` có `disabled: true` kèm BẤT KỲ field nào khác ⇒ 400 `invalid_request` (`'disable must be sent alone'`), kiểm ở controller trước service (cùng chỗ kiểm `empty update`). Khi đó lần `findOneAndUpdate` chính của một PATCH disable có update rỗng ⇒ 409 `ConcurrentClientUpdateError` không còn để lại thay đổi field nào. `disabled:false` + field khác vẫn cho phép (nằm trong `$set` atomic). Cập nhật mô tả Swagger `UpdateClientDto.disabled`. Dev xác nhận bằng test: 409 ⇒ document không đổi field nghiệp vụ nào.
- **DEBT-170**: cấp `admin` không thể đi cùng `disabled:true` nữa; còn lại các nhánh sau revoke lượt 1 (`secretsRevoked > 0`): `findOneAndUpdate` trả null (404) hoặc throw (DB), và revoke lượt 2 throw (đã có `AdminGrantSecretRevokeError`). Service ném lỗi mang `secretsRevoked` (mở rộng `AdminGrantSecretRevokeError` hoặc một class `AdminGrantAbortedError{secretsRevoked, cause?}` — dev chọn, tối thiểu). Controller: ghi `CLIENT_SECRET_REVOKED result:'success' metadata {reason:'admin_grant_aborted', count}` (khi count>0) + `ADMIN_CLIENT_UPDATED result:'failure' reason:'admin_grant_aborted'` (nhánh 404/DB) hoặc giữ `'secret_revoke_failed'` (nhánh lượt 2, thêm `count`); mỗi audit `.catch(() => undefined)` rồi trả lỗi gốc (404 opaque / 5xx). Metadata chỉ số đếm, không secret/hash/version.
- Bỏ `reason:'concurrent_update'` (không còn cần).
- Acceptance thay thế: int (a) `{disabled:true, redirectUris:[...]}` ⇒ 400, DB không đổi; (b) disable-only 409 (race disable∥enable, test hiện có) ⇒ không field nào khác đổi; test DEBT-161 hiện có vẫn xanh (disable∥disable 200/200). Unit/int với spy: (c) grant admin, `findOneAndUpdate` ⇒ null ⇒ 404 + `CLIENT_SECRET_REVOKED{reason:'admin_grant_aborted',count:N}` + `ADMIN_CLIENT_UPDATED failure`; (d) ⇒ throw ⇒ 5xx + cùng audit; (e) lượt 2 throw ⇒ audit có `count`. Mutation: bỏ check 400 ⇒ RED (a); bỏ audit abort ⇒ RED (c)/(d).

### Thứ tự
Task 1 → Task 3 → Task 2 (độc lập nhau; Task 2 chạm int seed riêng). Chạy full BE unit + int sau mỗi task (fixture tạo client trực tiếp qua model có thể thiếu `tokenEndpointAuthMethod` ⇒ Task 1 allowlist làm đỏ — sửa fixture, KHÔNG nới predicate).
