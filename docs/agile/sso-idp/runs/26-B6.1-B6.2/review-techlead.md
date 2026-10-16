# Tech Lead Review — 2026-10-16

## Kết luận: PASS (có fold bắt buộc trong `tasks.md` mục "Fold tech-lead")

Plan đúng vấn đề (B6.1/B6.2, INV-24/26, D3/D6) và khả thi trên code hiện có. Phát hiện **1 lỗ hổng thật** ở `/authorize` + `/login` làm luồng step-up không chạy được — đã fold thiết kế sửa cụ thể vào Task 2 (phạm vi nhỏ, rõ ràng), nên không REJECT. Backend-dev PHẢI làm theo mục Fold (ưu tiên hơn text gốc).

## Kiến trúc đề xuất

Giữ modular monolith NestJS. Không module/abstraction mới ngoài:
- Admin guard token-based đặt **trong `identity/tenant-context/tenant-context.ts`** (brand `TenantContext` không export — chỉ file này mint được). Tái dụng `bearerToken`, `TokenVerifier.verifyAccessToken`, `isAccessTokenLive`, `adminResourceIdentifier` (token.service.ts:28) — cùng chuỗi kiểm như `/demo/me` để không drift.
- Step-up: decorator + guard đọc `auth_time` từ claims đã verify; ngưỡng là tham số decorator (5'), không env.
- Sửa reauth ở `/authorize` bằng 1 trường `reauthAfter` trong `AuthorizeRequestContext` (không thêm cơ chế mới).

## Đối chiếu code thật

| Hạng mục | Hiện trạng | Kết luận |
|---|---|---|
| `TokenVerifier.verifyAccessToken` | RS256, iss, `typ=at+jwt`, claim bắt buộc, `aud` string, `sid` string nếu có | Dùng lại nguyên |
| `isAccessTokenLive` | sid tombstone → client → aud ∈ identifiers(allowedResources) → user tồn tại; lỗi hạ tầng propagate | Dùng lại; thay cho "tra Resource" |
| `adminResourceIdentifier(issuer)` | Đã có, `/token` dùng để quyết định phát `auth_time` | Guard PHẢI dùng hàm này (không ghép chuỗi kiểu demo) |
| `auth_time` trong token | Có cho resource admin từ code grant (giây); **không** có từ refresh grant | Đúng D3, fail-closed — giữ |
| `UserTenant` | `roles[]`, `status` enum `active/suspended`, `isActiveMember` | Guard cần đọc roles + status theo `(sub, client.tenantId)` |
| Tenant context B2.1 | `TenantGuard` chỉ từ cookie phiên; brand private | Thêm guard token-based cùng file |
| `/authorize` `prompt=login`/`max_age` | Parse đúng, trả `login_required` | **Hỏng khi đã có phiên** (xem dưới) |
| `NODE_ENV` | zod `.default('development')`; `seed-dev` `assertNotProduction(undefined)` cho qua | Bắt buộc biến; seed-dev allowlist |
| E2E env | `e2e/config/env.ts:56` đã set `NODE_ENV: "test"` | Task 3 không vỡ E2E |

## Điểm mạnh
- Phạm vi gọn: không mở endpoint quản trị thật trước B6.3; step-up chứng minh bằng controller test-only.
- Bám invariant: tenant không từ request, aud pin, liveness dùng chung, fail-closed 5xx.
- Debt kéo vào đúng tầm (DEBT-098 là rủi ro fail-open thật).

## Vấn đề (đã fold — bắt buộc làm)
- [x] **Step-up không chạy khi đã có phiên** (blocker kỹ thuật cho INV-26): `GET /login` (`ui.controller.ts:106`) redirect `/` khi có phiên ⇒ `prompt=login`/`max_age` dead-end. `resume()` (`authorize.service.ts:118`) bỏ `prompt`/`max_age` ⇒ gọi thẳng `/authorize?request_id=X` cấp code không re-auth (vi phạm `max_age` OIDC). Fold: `reauthAfter` trong context, `/login` render form khi context yêu cầu reauth, `resume` từ chối `login_required` nếu `session.authTime < reauthAfter`, `max_age=0` luôn reauth.
- [x] aud admin phải từ `adminResourceIdentifier(issuer)` (không "tra Resource" riêng, không hard-code).
- [x] Bắt buộc `sid` trên token admin (logout luôn thu hồi được).
- [x] Thứ tự guard + mã lỗi cụ thể (401 invalid_token / 403 insufficient_scope / 403 forbidden không phân biệt member vs role / 5xx khi hạ tầng lỗi).
- [x] Step-up: 403 `{error:"step_up_required", max_age:0}`, không trộn header RFC 9470 (9470 dùng 401); skew tương lai 30s; biên N phút test bằng clock inject.
- [x] Acceptance âm đo được cho cross-tenant (`tenant_admin` B + client A ⇒ 403; `tenantId` trong query/body/header bị bỏ qua), suspended, refresh-token admin ⇒ step_up_required, mutation RED.
- [x] DEBT-098: `seed-dev` allowlist `development|test` (unset ⇒ từ chối).

## Cổng security design
- Tài sản/actor/boundary: admin API (control-plane) ↔ bearer token resource `admin`; actor user có/không vai trò, member tenant khác, client tenant khác — có test.
- Invariant/state: tenant = `client.tenantId` của token + membership active; step-up: `auth_time` từ phiên mới (establish rotate) — có chuỗi request `/authorize`→`/login`→resume→`/token`.
- Abuse cases: token resource khác (confused deputy), ID token thay access token, token sau logout (stale), IDOR tenant qua query/body/header, bỏ qua login gọi thẳng resume, `auth_time` tương lai, token từ refresh né step-up — đều có acceptance.
- Failure: Mongo/Redis lỗi ⇒ 5xx fail-closed; peek Redis lỗi ở `/login` ⇒ giữ hành vi cũ (không mở form, không log request_id).
- Exposure: `/admin/me` chỉ `{sub, tenantId, roles}`, `no-store`, không `sid`/token; lỗi mờ.

## Trả lời câu hỏi
- **Q-26.1**: D6 (plan dòng 101). Vai trò `super_admin`, `tenant_admin`; scope `admin.read` (GET), `admin.write` (mutation). Run này không phân biệt 2 vai trò; quyền xuyên tenant của `super_admin` để B6.3.
- **Q-26.2**: hằng số theo decorator, 5 phút (D3). Không env.
- **Q-26.3**: bắt buộc `NODE_ENV` (không default).

## Đề xuất (không bắt buộc) → backlog
- DEBT-116: `/authorize` không kiểm user là member active của `client.tenantId` (spec §9.10 "không cấp quyền cho Client thuộc Tenant B"). Admin guard đã chặn ở tầng API; luồng OAuth chung để B7.1 (cross-tenant).
- DEBT-117: step-up re-login có thể đổi user (A → B); fe-admin (A5) phải so `sub` mới với phiên trước, khác ⇒ huỷ thao tác/đăng nhập lại.
- DEBT-118: identifier resource dựng 2 kiểu (`new URL('/admin/', issuer)` vs `issuer.replace(/\/+$/,'') + '/demo/'`) — khác nhau khi `ISSUER` có path; thống nhất 1 helper khi chạm.
