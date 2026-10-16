# Tech Lead Review — 2026-10-16

## Kết luận: PASS (có fold bắt buộc trong `tasks.md` mục "Fold tech-lead")

Không có blocker cần người quyết định; các lệch so với code thật đã được fold thẳng vào `tasks.md` (ưu tiên hơn text gốc). Dev làm theo fold.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ modular monolith: endpoint mới nằm trong `AdminModule` (controller theo nhóm clients/secrets/resources), tái dùng `ClientService`/`ClientCredentialService`/`ResourceService` + `TenantScopedRepository`. Không thêm service/lớp trừu tượng mới ngoài: 1 helper audit admin, 3 mapper allowlist, 1 helper đăng ký OpenAPI. Không cache.

Trả lời câu hỏi:
- **Q-27.1**: `@nestjs/swagger@12.0.2` (peer khớp Nest 12.1.1, `@fastify/static` 8.2.0, class-validator/transformer đã có). Chỉ JSON, không UI, `GET /openapi/admin.json` chỉ khi `NODE_ENV !== 'production'`, `include: [AdminModule]`.
- **Q-27.2**: HOÃN super_admin xuyên tenant (DEBT-124). Run 27: cả hai vai trò chỉ dùng tenant của token. Phân vai chỉ ở: ghi Resource global và gán resource `admin`.
- **Q-27.3**: tạo client không bao giờ trả secret; secret chỉ qua `POST /admin/clients/:id/secrets`.
- **Q-27.4**: không DELETE client; disable bằng `disabledAt`, đảo được. Resource `identifier`/`resourceId` bất biến, chỉ PATCH `scopes`.

## Điểm mạnh
- Tách B6.3 a/b hợp lý; run 27 đi đúng vào phần nhạy cảm nhất (control plane của client).
- Nền móng run 26 dùng lại được nguyên trạng: guard, step-up, lỗi opaque, `no-store`.
- Validator B3.1/B3.2 và `ClientCredentialService` (version unique + retry, grace, verify timing-equalised) đủ cho Task 2/3, không cần viết lại.
- Enum audit đã có sẵn đủ action client/secret, đã nằm trong `ALERT_ACTIONS`.

## Vấn đề (đã fold — dev bắt buộc theo)
- [x] **Task 4 không khả thi như viết**: `Resource` không có `tenantId` (spec §10 là global). "Theo tenant / cross-tenant" bị bỏ; ghi chỉ `super_admin`, đọc mọi admin.
- [x] **Leo thang tenant_admin → admin khác**: tenant_admin gán resource `admin` vào client của mình là đi xin được token `aud=admin` (`admin.write`) của các admin khác cùng tenant (kể cả super_admin) ⇒ chỉ `super_admin` mới được gán.
- [x] **Oracle cross-tenant khi tạo**: `clientId` unique toàn cục ⇒ E11000 lộ việc id đã có ở tenant khác ⇒ server tự sinh `clientId`.
- [x] **Client không có trường disable**: thêm `disabledAt` và chặn ở một cửa duy nhất `ClientService.findByClientId` (authorize/token/introspect/liveness/logout đều đi qua) + 2 query của `ClientCorsService`. Chặn tự disable client đang phát hành token admin (409).
- [x] **Lỗ redirect cũ sau khi gỡ**: `decideConsent` lấy lại client nhưng không kiểm lại `ctx.redirectUri` còn đăng ký ⇒ context consent đang chờ (TTL ≤10') vẫn mint code tới URI admin vừa gỡ (ví dụ URI bị chiếm). Fold: kiểm lại, sai thì trang lỗi first-party (không 302), kèm test mutation.
- [x] **Acceptance "cache ClientCorsService làm mới"**: không có cache ⇒ đổi sang test hành vi CORS sau PATCH. Thêm validator origin còn thiếu.
- [x] **Step-up theo field dễ lọt** ⇒ mọi mutation run 27 đều step-up (5').
- [x] **Diff audit**: `AuditMetadata` chỉ nhận primitive phẳng, `sanitizeMetadata` xoá key chứa `token|secret|...` ⇒ quy ước `changedFields` + đếm; diff nguyên tử qua `findOneAndUpdate` trả before-doc.
- [x] **Bất biến**: `clientType`/`tokenEndpointAuthMethod` (đổi confidential→public sẽ bỏ qua secret), `clientId`, `tenantId`; ràng buộc cặp type⇔auth method lúc tạo (hiện `ClientService.create` chưa kiểm).
- [x] **Đổi identifier resource** làm chết ngay mọi AT (liveness so `aud` với `identifiersFor`) và với `admin` thì khoá admin API ⇒ bất biến.

### Security design gate (đã đủ sau fold)
- Tài sản/actor/boundary: client config + secret (asset), tenant_admin/super_admin (actor), tenant theo token ↔ tenant của client/resource (boundary); owner vs non-owner ⇒ 404 byte-identical.
- Invariant: tenantId nằm trong filter; field bất biến; disabled ⇒ không auth, AT inactive ngay; plaintext secret chỉ trong một response `no-store`.
- Abuse: IDOR cross-tenant (404), enumeration clientId (server sinh id), confused deputy (resource `admin`), stale token (step-up 5', liveness), replay/race (version unique + retry 1 lần, `findOneAndUpdate`), tự khoá (409).
- Failure: Mongo lỗi ⇒ 5xx; audit lỗi sau mutation ⇒ 5xx, không rollback; audit lỗi ở secret ⇒ không trả plaintext.
- Exposure: mapper allowlist, projection `secretHash:0`, không log/audit plaintext, OpenAPI không lộ `secretHash`, prod không có route OpenAPI.

## Đề xuất (không bắt buộc) → backlog
- DEBT-124: super_admin xuyên tenant (chọn tenant đích + audit) — sau tenants API (run 28+).
- DEBT-125: disable client không revoke refresh family; enable lại thì family cũ (≤30d) sống lại.
- DEBT-126: các lần admin bị từ chối (401/403/step_up) chưa ghi audit/alert.
- DEBT-127: `Resource.resourceId` không có unique index (chỉ pre-check ở admin).
- DEBT-128: `/token` không kiểm lại redirect_uri còn đăng ký lúc đổi code (cửa sổ 60s, code bind redirect).
- DEBT-129: rotate thành công nhưng audit lỗi ⇒ secret mới mất, secret cũ vào grace ⇒ client chết sau grace nếu không rotate lại (runbook).
- Nit: `AdminAuthError` giờ chứa cả lỗi không-auth — đổi tên khi có dịp (không làm run này).
