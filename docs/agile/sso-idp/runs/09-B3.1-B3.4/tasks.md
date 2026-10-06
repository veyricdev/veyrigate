# Tasks — Run 09 — B3.1–B3.4 (M2: Client & Resource)

> Nguồn: plan.md §B3 (spec §13 bước 4; §7, §9.3, §9.7). Tất cả là **[BE]**.
> Phụ thuộc đã xong: B2.1 (Client/tenant schema nền), B2.3/B2.5 (sessions, UI). Không có DEBT trong phạm vi B3.

## [BE] B3.1 — Clients + ClientCredential + validator redirect_uri  (Size L)
- Schema `Client` + `ClientCredential`: hash secret, `version`, rotation có overlap/grace.
- Validator `redirect_uri`: absolute, khớp **exact**, cấm wildcard/fragment, chỉ `https`
  (cho phép `http://localhost` ở dev). Thêm `postLogoutRedirectUris[]` (D4).
- Invariant: INV-4, INV-18, INV-21.
- Nghiệm thu: test các biến thể (slash cuối, query lạ, wildcard, subdomain) bị từ chối.
- Spec: §7, §9.3; plan §B3.1, D4.

## [BE] B3.2 — Resources + Client.allowedResources[] + validator resource  (Size M)
- Schema `Resource` + `Client.allowedResources[]`.
- Validator `resource` = absolute URI, không fragment, thuộc `allowedResources`.
- Invariant: INV-14.
- Nghiệm thu: resource ngoài danh sách bị reject.
- Phụ thuộc: B3.1.

## [BE] B3.3 — Client authentication cho /token  (Size M)
- Hỗ trợ `client_secret_basic`, `client_secret_post`, `none` (public bắt buộc PKCE).
- Chấp nhận credential còn hiệu lực theo `version` (overlap/grace từ B3.1).
- Nghiệm thu: sai method so với `token_endpoint_auth_method` → `invalid_client`;
  secret so sánh constant-time.
- Phụ thuộc: B3.1.

## [BE] B3.4 — CORS động (D8)  (Size S)
- CORS động cho `/token`, `/userinfo`, `/jwks.json`, discovery — dùng `allowedCorsOrigins[]`,
  **không** dùng `redirect_uris`. Preflight cho phép nếu origin ∈ hợp mọi allowedCorsOrigins
  đã đăng ký; request thực kiểm origin ∈ danh sách của đúng client (theo client_id).
- Spec: §9.7, D8.
- Nghiệm thu: origin lạ bị chặn, preflight đúng.
- Phụ thuộc: B3.1.

## Cổng pipeline
tech-lead → backend-dev → senior-reviewer → tester. Mỗi cổng tối đa 2 retry.