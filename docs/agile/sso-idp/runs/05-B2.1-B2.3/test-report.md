# Test Report — 2026-09-29
## Kết quả: PASS (80/80 test: unit 35/35 + int 45/45) + 5/5 kiểm tĩnh/boot

Môi trường: Windows + bash · Mongo `vg-test-mongo` :27117 · Redis `vg-test-redis` :6479 · Mailpit :1025/8025 (đã chạy sẵn; không đụng 27017/6379).
Test thêm (chỉ test, không sửa code sản phẩm): `be/test/sessions.int-spec.ts` — "INV-16: IDs are opaque and random — unique per session, no userId/tenant/device inside".

## Lệnh đã chạy + output thực tế (trong `be/`)
| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm typecheck` | `tsc --noEmit` exit 0 |
| 2 | `pnpm lint` | `eslint src` exit 0; `npx eslint test/sessions.int-spec.ts` exit 0 |
| 3 | `pnpm build` | `nest build` exit 0 |
| 4 | `pnpm test` | `Test Suites: 7 passed, 7 total` · `Tests: 35 passed, 35 total` (exit 0) |
| 5 | `pnpm test:int` | `Test Suites: 6 passed, 6 total` · `Tests: 45 passed, 45 total` (exit 0; trước khi thêm test: 44/44) |
| 6 | `pnpm test:int -- test/sessions test/tenant-context` ×3 | `Tests: 18 passed, 18 total` ×3 — không flake (test idle dùng TTL 1s trên Redis thật) |
| 7 | `NODE_ENV=production SESSION_COOKIE_SECURE=false node dist/main.js` (MONGO 27117, REDIS 6479) | exit **1**: `Error: Invalid environment variables: - SESSION_COOKIE_SECURE: SESSION_COOKIE_SECURE=false is not allowed when NODE_ENV=production` |
| 8 | Đối chứng `NODE_ENV=development SESSION_COOKIE_SECURE=false` | `Nest application successfully started`, sống tới timeout 15s (exit 124); Mongo có tenant `default-tenant` (DB kiểm tra đã drop) |
| 9 | Đối chứng `NODE_ENV=production SESSION_COOKIE_SECURE=true` | exit 1 nhưng vì lý do KHÁC, **qua** validation env: `LocalKeyProvider is dev-only; configure a KMS/Vault provider (plan B7.3)` — hành vi có chủ đích từ run 04, không phải lỗi run 05 |

Kết luận #7–#9: cấm `Secure=false` ở production là do validation env (thông báo nêu đúng tên biến), không phải do lỗi khác.

## Test FAIL
(không có)

## Coverage acceptance criteria
**B2.3 — Sessions + cookie**
- [x] INV-16 cookie `HttpOnly; Secure; SameSite=Lax; Path=/`, không Domain, Max-Age=absolute — `session.cookie.spec.ts` "sets idp_session with…"; clear cùng attributes — "clear uses the same attributes…"; Secure chỉ tắt khi cờ dev — "omits Secure only when the dev flag is false"
- [x] INV-16 giá trị opaque/ngẫu nhiên, không chứa userId/email — `sessions.int-spec` "INV-16: IDs are opaque and random…" (**mới**) + "stores only sha256(id)…" (43 ký tự base64url = 256 bit)
- [x] INV-17 / fixation: ID trước login ≠ sau login, ID cũ không dùng được (cả anonymous, cả re-login, cả ID giả) — `sessions.int-spec` "fixation: establish() always issues a new ID…"
- [x] Idle hết hạn → mất (sliding khi hoạt động) — "idle: sliding while active, gone after idle TTL…"
- [x] Absolute hết hạn dù đang hoạt động → mất; TTL không vượt deadline — "absolute: expires even when continuously active…"
- [x] Revoke theo thiết bị chỉ huỷ đúng phiên đó + chống IDOR — "revokeByDevice revokes exactly that session; other user cannot revoke it (IDOR)"
- [x] Redis không chứa ID thô — "stores only sha256(id): no raw ID in any key or value…"
- [x] `SESSION_COOKIE_SECURE=false` + production → không khởi động — `validation.schema.spec` "\"false\" in production → throws…" + boot thật (lệnh #7)
- [x] Phụ: revoke/revokeAll/listByUser prune, chống hồi sinh (C4), lỗi Redis không bị nuốt (C9), config enum/IDLE≤ABSOLUTE (C1) — các case còn lại trong `sessions.int-spec`/`validation.schema.spec`

**B2.1 — Tenant context (INV-24)**
- [x] `tenantId` gửi trong query/body/header bị bỏ qua — `tenant-context.int-spec` "tenantId in query/body/header is ignored…" (header `x-tenant-id: tenant-B` gửi ở mọi request)
- [x] Context tenant A không thấy dữ liệu tenant B (kể cả khi filter ghi tenant B; update/delete/create không vượt tenant) — "context A never sees tenant B data…", "update/delete cannot reach tenant B…", "create takes tenantId from the context…"
- [x] Không session → 401 (cả session giả) — "no session → 401; unknown session → 401"
- [x] Phụ: không membership → 403, gỡ membership mất quyền ngay (C10); thiếu context → throw — các case tương ứng

**B2.2 — Identity**
- [x] CRUD nội bộ chạy (user/tenant/membership/federated) — `identity.int-spec` "creates a user…", "membership: add…", "federated identity: link + find…", "updates status fields only…"
- [x] Trùng email (không phân biệt hoa thường) → lỗi unique — "duplicate email (case-insensitive) → DuplicateError"
- [x] Trùng membership → lỗi unique — "membership: … duplicate membership → DuplicateError"
- [x] Trùng `provider+providerId` → lỗi unique — "federated identity: … duplicate → DuplicateError…"
- [x] Đổi email không đổi `sub` — "changing email keeps sub…"
- [x] Seed chạy 2 lần (và song song) không nhân đôi tenant — "seeds default-tenant at boot; running the seed again…" + boot thật (lệnh #8)

## Ghi chú (không phải FAIL, đã có trong backlog)
- DEBT-012 (`changeEmail` giữ `emailVerifiedAt`): chưa có test khẳng định hành vi đúng — nằm ngoài nghiệm thu run này, để B2.4 kèm fix.
- Chưa có test E2E trình duyệt: run này chưa có UI/login thật (A5); cookie attributes đã kiểm qua Fastify inject.
