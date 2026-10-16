# Summary — run 27 B6.3a (M5) — ✅ PASS 4/4 task

- **Phạm vi**: T1 nền tảng admin API — OpenAPI `GET /openapi/admin.json` chỉ dev/test (`@nestjs/swagger@12.0.2`, không UI), `TenantScopedRepository.find/findOneAndUpdate`, mapper allowlist, phân trang `limit` 1..100 + cursor, `AdminAuthError` statics, `@CurrentAdmin`, audit helper. T2 clients list/get/POST/PATCH + `disabledAt` (chặn tại `findByClientId` + CORS; 409 tự disable), `clientId` server sinh. T3 secrets create/rotate/revoke (plaintext 1 lần, `no-store`). T4 resources global (đọc mọi admin, ghi super_admin, chỉ PATCH `scopes`).
- **Bug đã sửa**: (tech-lead) `decideConsent` không kiểm lại `redirect_uri`/resource của consent context đang chờ ⇒ mint code tới URI vừa gỡ; leo thang qua gán resource `admin`; oracle E11000 `clientId`. (senior REJECT 1) tenant_admin chiếm client admin-capable (PATCH redirect + lấy secret) ⇒ mọi mutation trên client có `admin` chỉ super_admin, PATCH nguyên tử `$nin`. DEBT-133 (2 secret active khi POST đồng thời).
- **Verify**: BE unit 241/241, int 585/585, FE 240/240, E2E 12/12; mutation RED (14 + 3 + 1).
- **Commit**: `b9370c1`.
- **Vòng lặp**: tech-lead=1, BE dev=2, senior=2 (REJECT → PASS), tester=1.
- **Debt**: đóng DEBT-131 (superseded), 133, 136; mở DEBT-124–130, 132, 134, 135, 137–139.
- **Ops**: DB dev `sso-idp` cần `pnpm -C be db:sync-indexes` (index `{tenantId, clientId}`).
