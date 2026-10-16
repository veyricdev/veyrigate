# Senior Review — 2026-10-16

## Kết luận: REJECT

Một 🔴 [BE]: quy tắc "chỉ super_admin được đụng tới khả năng `aud=admin`" mới chặn ở cửa **gán** resource `admin`, chưa chặn ở các mutation khác trên client **đã** có resource đó. tenant_admin vẫn chiếm được client admin-capable (BFF admin) qua PATCH `redirectUris` + `POST .../secrets`, nên đi xin được token admin của super_admin. Lỗ này chính là mối đe dọa mà fold tech-lead (Q-27.2 b) muốn đóng. Chuyển lại **backend-dev**.

## Tổng quan

Chất lượng chung tốt, bám sát fold:
- Tenant nằm trong filter (`TenantScopedRepository.scope`), lỗi 404 giống hệt nhau từng byte, `clientId` do server sinh (UUID) nên không có oracle E11000.
- Mọi mutation đều có `admin.write` + `@RequireRecentAuth(5)`. Đã đếm đủ: POST/PATCH clients, POST/DELETE secrets, POST/PATCH resources.
- Mapper allowlist rõ ràng; credentials có projection `secretHash: 0` ở DB; plaintext chỉ nằm trong response POST, kèm `no-store` + `Pragma`, và audit chạy trước khi trả.
- Chỉ một cửa `findByClientId` lọc `disabledAt: null`. Đã grep: authorize (l.160, l.303), client-authentication (`/token`, `/introspect`, `/revoke`), liveness, logout (l.80, l.97), admin guard (tenant-context l.175), cộng 2 query CORS. Không còn query `Client` nào khác ngoài `seed-dev`.
- `decideConsent` approve kiểm lại client, redirect_uri và resource, sai thì trả `null` (không 302, không mint code).
- OpenAPI gate theo allowlist `NODE_ENV` (`development`/`test`); production không đăng ký route. `@scarf/scarf` để `false` nên telemetry postinstall bị tắt. Version pin exact.
- Tôi tự chạy lại: typecheck ✅, unit 241/241 ✅, `test:int admin-api` 24/24 ✅.

## 🔴 Blocker

- [ ] **[BE] Leo thang quyền: tenant_admin chiếm client admin-capable**
  `be/src/modules/clients/client.service.ts:323-326` (`updateForTenant` chỉ chạy `assertAllowedResources` khi `patch.allowedResources !== undefined`) và `be/src/modules/admin/admin-clients.controller.ts:193-209` (`issueSecret`), `:226-248` (`revokeSecret`). Không có kiểm vai trò nào trên **trạng thái hiện tại** của client.
  **Kịch bản**:
  1. super_admin cấu hình BFF admin (hoặc bất kỳ client nào) có `allowedResources: [..., 'admin']`. Chính test `admin-api.int-spec.ts:618` cũng làm đúng bước này.
  2. tenant_admin cùng tenant gọi `PATCH /admin/clients/<bff> {redirectUris:[..., "https://evil.example/cb"]}`, được 200 vì không gửi `allowedResources`.
  3. tenant_admin gọi `POST /admin/clients/<bff>/secrets`, được 200 và nhận plaintext secret mới của BFF.
  4. tenant_admin gửi cho super_admin link `/authorize?client_id=<bff>&redirect_uri=https://evil.example/cb&resource=<admin>&...`. Session SSO và consent sẵn có làm code bay thẳng tới evil, đổi code bằng secret vừa lấy là có AT `aud=admin` mang role super_admin.

  Biến thể chỉ gây phá hoại: PATCH `allowedResources: []` (danh sách không chứa admin nên lọt qua), gỡ `redirectUris`, hoặc `DELETE .../secrets/<v>` trên BFF. Cả ba khóa admin API của mọi admin, kể cả super_admin. 409 chống tự khóa chỉ phủ `disabled` và chỉ khi trùng `principal.clientId`.
  **Vì sao chặn**: đây là confused deputy / privilege escalation tenant_admin → super_admin, đúng invariant fold Q-27.2(b) yêu cầu. DEBT-131 có ghi nhận phía "allowedResources luôn 403" nhưng bỏ sót các field khác và endpoint secrets.
  **Đề xuất**:
  - Mọi mutation (PATCH, POST secrets, DELETE secrets) lên client mà `allowedResources` **hiện tại** chứa resourceId của resource `admin` đều yêu cầu `super_admin`, ngoài ra trả 403 `forbidden`.
  - Làm nguyên tử cho PATCH: với actor không phải super_admin, thêm `allowedResources: { $nin: adminResourceIds }` vào filter `findOneAndUpdate`. Khi không match thì đọc lại bằng `getForTenant` để phân biệt 404 với 403 (chỉ trong cùng tenant nên không tạo oracle).
  - Secrets: kiểm trên doc `mustFind` trước khi rotate/revoke.
  - Test int (tenant_admin trên client đã có `admin`): PATCH `redirectUris` ⇒ 403 và DB không đổi; POST secrets ⇒ 403, không có version mới; DELETE secret ⇒ 403 và credential còn hiệu lực; PATCH `allowedResources: []` ⇒ 403. super_admin ⇒ 200. Kèm mutation RED (bỏ kiểm ⇒ test đỏ).

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| Tenant isolation (IDOR cross-tenant) | ✅ `{clientId, tenantId}` nằm trong filter. `mustFind` chạy trước khi chạm credentials. 404 opaque. |
| Enumeration clientId | ✅ UUID do server sinh. `forbidNonWhitelisted` ⇒ body `clientId`/`tenantId` là 400. |
| Field bất biến | ✅ `clientType`/`tokenEndpointAuthMethod`/`clientId`/`tenantId` không có trong `UpdateClientDto` ⇒ 400. Resource chỉ PATCH `scopes`. |
| Ràng buộc type ⇔ auth method | ✅ `isValidAuthMethodFor` trong `create` (dùng chung cho seed). |
| Gán resource `admin` | ✅ khi tạo/PATCH `allowedResources`. ❌ **chưa** áp cho mutation khác trên client đã có `admin` (🔴). |
| Step-up mọi mutation | ✅ đủ 6 handler. |
| Disable chặn mọi đường | ✅ `findByClientId` + CORS (đã grep toàn bộ caller). Refresh family sống lại khi enable lại ⇒ DEBT-125 (đã biết). |
| Lộ secret | ✅ projection DB, mapper allowlist, audit chỉ `version`, plaintext không vào exception. OpenAPI chỉ chứa schema DTO. |
| Atomic diff | ✅ `findOneAndUpdate` trả before-doc. ⚠ create-vs-rotate có race (🟡 1). |
| Failure | ✅ thiếu `ResourceService`/issuer ⇒ throw 5xx. Lỗi Mongo/audit ⇒ 5xx. Audit secret lỗi ⇒ không trả plaintext. |
| OpenAPI ở production | ✅ allowlist NODE_ENV, unit gate. Route không nằm dưới `/admin`. |
| Dependency | ✅ `@nestjs/swagger@12.0.2` pin, scarf tắt build. Kéo theo `swagger-ui-dist` (không mount, chỉ tốn dung lượng). |

## 🟡 Nên sửa

1. **[BE] Race create-vs-rotate secret**: `admin-clients.controller.ts:200-203`. Hai POST đồng thời trên client chưa có credential sẽ cùng đi nhánh `createSecret`, sinh ra 2 version `expiresAt: null` cùng active vô hạn: secret "thừa" không bao giờ vào grace. Đề xuất: luôn gọi `rotateSecret`. Khi chưa có credential active nó tương đương `createSecret` (`updateMany` không đụng gì), nên `hasActive` chỉ còn quyết định tên action audit. Cách này vừa hết race vừa bỏ được 1 nhánh.
2. **[BE] `updateForTenant` trả `after` không có `updatedAt` mới**: `client.service.ts:346`. `after = {...before, ...set}` nên response PATCH mang `updatedAt` cũ, gây nhầm cho UI/ETag sau này. Cân nhắc dùng `returnDocument:'after'` cho response và giữ before cho diff (2 doc từ 1 lệnh thì không được; có thể chấp nhận gán `updatedAt: new Date()` vào `after`).
3. **[BE] `toAdminError` phản chiếu input vào `error_description`** (`allowedResources entry is not a known resource: ${missing}`, origin, ...). Không lộ gì vì resource là global và đọc được, nhưng chuỗi tối đa 2048 ký tự bị echo lại. Chấp nhận được; có thể cắt ngắn.

## 💭 Nit

- `AdminAuthError` giờ chứa cả lỗi không liên quan auth (đã ghi nit tech-lead).
- `sameValue` dùng `JSON.stringify`: đúng vì mảng có thứ tự, nhưng đổi thứ tự thôi cũng thành "changed". Chấp nhận.

## ✂️ Ponytail

- be/src/modules/identity/tenant-context/tenant-scoped.repository.ts:L16: yagni: `FindOptions.projection` không có caller nào. Bỏ field và tham số thứ 2 của `model.find`.
- be/src/modules/admin/admin-clients.controller.ts:L200: shrink: nhánh `rotate ? rotateSecret : createSecret`. Luôn `rotateSecret`, giữ `hasActive` chỉ cho action audit (đồng thời sửa 🟡 1).
- be/src/modules/clients/client-credential.service.ts:L98: shrink: `hasActive` lặp điều kiện của `listActive`. Dùng `(await this.listActive(id, new Date())).length > 0` (đọc thêm hash, không đáng kể ở admin) hoặc chấp nhận như hiện tại.
- be/src/modules/admin/admin.openapi.ts:L22: keep: duyệt `$ref` bằng regex/BFS thay cho `include:[AdminModule]` có lý do (bootstrap int không mount AdminModule). Không cắt.

net: -6 lines possible.

---

# Lượt 2 — 2026-10-16

## Kết luận: PASS

🔴 lượt 1 đã đóng. Không còn 🔴 mới. Chuyển **tester**.

## Tổng quan

Fix đúng hướng và gọn. "Admin-capable ⇒ chỉ super_admin" giờ là quy tắc chủ đích, áp trên trạng thái **hiện tại** của client chứ không chỉ ở cửa gán:
- PATCH (`client.service.ts:223-246`): actor không phải super_admin ⇒ filter `findOneAndUpdate` có thêm `allowedResources: {$nin: adminIds}`. Kiểm và ghi nằm trong một lệnh nên nguyên tử. Không khớp ⇒ đọc lại `getForTenant` **trong cùng tenant**: có ⇒ 403, không ⇒ 404.
- Secrets (`admin-clients.controller.ts:260-266`): `mustModify` = `mustFind` (404 opaque) rồi `assertMayModify` ⇒ 403. Áp cho cả POST lẫn DELETE.
- DEBT-133: luôn gọi `rotateSecret`. `hasActive` chỉ dùng để chọn tên action audit. Có int test cho 2 POST đồng thời.
- Tôi tự chạy lại: typecheck ✅, unit **241/241** ✅, int **580/580** (26 suite) ✅.

## Thử lại kịch bản tấn công

| Kịch bản (actor = tenant_admin, client đã có resource `admin`) | Kết quả |
|---|---|
| PATCH `redirectUris` thêm evil | ✅ 403 `forbidden`, DB không đổi (int: snapshot client + credentials) |
| POST secrets để lấy plaintext | ✅ 403, body không có `clientSecret`, không có version mới |
| DELETE secret (khóa admin API) | ✅ 403, secret cũ vẫn xác thực được |
| PATCH `allowedResources: []` / giữ nguyên / `disabled` / `scopes` | ✅ 403 cả 4 (vòng lặp int) |
| Thêm `admin` vào client thường (create/PATCH) | ✅ 403 (`assertAllowedResources`, giữ nguyên từ lượt 1) |
| Client admin-capable của **tenant khác** | ✅ 404 theo cấu trúc: filter có `tenantId`, đọc lại cũng scope theo tenant ⇒ `null` ⇒ 404 giống id ngẫu nhiên. Không có oracle 403/404 xuyên tenant. (Int mới chỉ phủ id ngẫu nhiên, xem 🟡 1.) |
| Phân biệt 403/404 trong cùng tenant | ✅ Không phải oracle: tenant_admin vốn đọc được `allowedResources` qua GET. |
| Resource `admin` chưa đăng ký | ✅ `adminIds = []` ⇒ không client nào admin-capable. Điều này an toàn: không có resource thì không mint được `aud=admin`, và `assertAllowedResources` bắt mọi resourceId phải tồn tại nên tenant_admin không cài sẵn được id "tương lai". Ghi Resource chỉ super_admin. Thiếu wiring ⇒ throw 5xx (fail closed). |
| Disable | ✅ `disabled` đi cùng filter `$nin`. 409 tự-disable vẫn chạy trước. |
| super_admin | ✅ 200/201/204. Client thường vẫn để tenant_admin quản lý đầy đủ. |

**TOCTOU ở secrets (dev chấp nhận) — tôi đánh giá CHẤP NHẬN ĐƯỢC.** Cửa sổ chỉ mở khi super_admin **đồng thời** gán `admin` cho client mà tenant_admin đang POST/DELETE secret. Cửa sổ này không cho tenant_admin thêm gì so với trước lúc gán: ngay trước khoảnh khắc đó họ vẫn hợp lệ xoay secret và sửa redirect của client ấy. Rủi ro thật nằm ở chính thao tác **nâng cấp** client do tenant_admin cấu hình lên admin-capable (redirect URI và secret tenant_admin đã biết vẫn còn nguyên), không nằm ở race. Đã ghi 🟡 2. Tôi cũng không muốn biến `assertMayModify` thành nguyên tử vì phải đưa điều kiện vào `ClientCredentialService` (khác collection), đổi lại lợi ích gần như bằng 0.

## Không hồi quy (đối chiếu lượt 1)

Tenant scope trong filter, 404 byte-identical, clientId UUID, field bất biến (400), step-up + `admin.write` đủ 6 handler, `findByClientId` + 2 query CORS lọc `disabledAt`, projection `secretHash:0`, plaintext chỉ có trong POST `no-store`/`Pragma` và audit chạy trước khi trả, `decideConsent` kiểm lại, OpenAPI gate theo NODE_ENV: không đổi, toàn bộ suite xanh.

## Security invariants / trust boundaries đã kiểm (lượt 2)

| Invariant | Kết quả |
|---|---|
| Escalation tenant_admin → super_admin qua client admin-capable | ✅ đóng (PATCH nguyên tử, secrets kiểm trên doc) |
| Cross-tenant oracle 403/404 | ✅ theo cấu trúc (re-read scoped) |
| Concurrency PATCH vs gán `admin` | ✅ `$nin` trong filter |
| Concurrency secrets vs gán `admin` | ⚠ TOCTOU, chấp nhận (xem trên) |
| Concurrency create/rotate secret | ✅ luôn rotate, int 2 POST song song |
| Fail closed thiếu wiring | ✅ `adminResourceIds` throw |

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

1. **[BE] Thiếu int cho client admin-capable của tenant khác** ⇒ DEBT-136. Hiện chỉ test id ngẫu nhiên. Nếu sau này ai đó đổi re-read sang `findOne` không scope (ví dụ để lấy message tốt hơn), oracle 403 xuyên tenant sẽ lọt mà không test nào đỏ. Đề xuất: tenant_admin A gọi PATCH/POST/DELETE secrets lên client admin-capable của tenant B ⇒ 404 byte-identical với id ngẫu nhiên.
2. **[BE] Nâng cấp client lên admin-capable kế thừa cấu hình do tenant_admin đặt** ⇒ DEBT-137. Khi super_admin PATCH thêm `admin` vào client mà tenant_admin tạo hoặc từng sửa, `redirectUris`/CORS/secret tenant_admin đã biết vẫn còn hiệu lực, nên tenant_admin vẫn lấy được token `aud=admin` (social engineering kiểu "nhờ thêm admin cho client của em"). Đây là quyết định của super_admin nên không chặn. Cân nhắc: khi gán `admin` thì ghi audit riêng hoặc bắt buộc rotate secret, UI B6.4 hiển thị cảnh báo.
3. **[BE] Ponytail lượt 1 chưa xử lý** ⇒ DEBT-138: `FindOptions.projection` vẫn không có caller.

## 💭 Nit

- `adminResourceIds` và `assertAllowedResources` cùng lặp khối throw "ResourceService and app.issuer are required". Có thể tách thành 1 helper `requireAdminWiring()`.
- `validateConfig` chạy trước kiểm vai trò, nên tenant_admin gửi URI sai lên client admin thì nhận 400 chứ không phải 403. Vô hại.

## ✂️ Ponytail

- be/src/modules/identity/tenant-context/tenant-scoped.repository.ts:L16: yagni: `projection` không có caller. Bỏ field và tham số `model.find`.
- be/src/modules/clients/client.service.ts:L302: shrink: khối kiểm wiring lặp với `adminResourceIds` (L265). Gọi chung 1 helper.

net: -8 lines possible.
