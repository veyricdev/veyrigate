# Test Report — 2026-10-16 — run 27 (B6.3a)

## Kết quả: PASS (BE unit 241/241, BE int 585/585, FE 240/240, E2E 12/12; typecheck + lint sạch)

Không có test FAIL ở lần chạy cuối. Không có lỗi [BE]/[FE] mới chặn run.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit` exit 0 |
| 2 | `pnpm -C be lint` | lần 1: 1 lỗi prettier ở test tester mới viết (`admin-api.int-spec.ts:1166`) ⇒ `eslint --fix` riêng file test đó; lần 2: sạch (exit 0) |
| 3 | `pnpm -C be test` | `Test Suites: 23 passed, 23 total` / `Tests: 241 passed, 241 total` |
| 4 | `pnpm -C be test:int admin-api -t "tester run 27"` | lần 1: 4 passed, 1 failed (assertion của tester sai: body 404 Nest có chứa chuỗi path `/openapi/...`; sửa thành "không có key `paths`") ⇒ lần 2: `5 passed` |
| 5 | `pnpm -C be test:int` (vg-test-mongo@27117, vg-test-redis@6479) | `Test Suites: 26 passed, 26 total` / `Tests: 585 passed, 585 total` (580 trước run tester + 5 mới) |
| 6 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)` / `Tests 240 passed (240)` |
| 7 | `pnpm -C e2e e2e` (1 lần; `:5173`/`:4000` trống trước khi chạy) | `12 passed (1.1m)`; webServer do Playwright tự dừng, sau khi chạy không còn LISTEN `:5173`/`:4000` |

Mutation test (tester, chứng minh test DEBT-136 có giá trị): đổi re-read cùng tenant trong `ClientService.updateForTenant` (`getForTenant(ctx, …)`) thành `clients.findOne({ clientId })` không scope ⇒ test DEBT-136 RED (`status: 403` thay vì `404`, tức oracle tồn tại xuyên tenant). Đã khôi phục từ bản sao, sha256 khớp bản trước khi mutate (`c934043e…`).

## Test mới (tester) — `be/test/admin-api.int-spec.ts` › `tester run 27 — gaps`

1. **DEBT-136**: client admin-capable của tenant B (`BFF_B`, `allowedResources` chứa `admin`); actor tenant_admin A và super_admin A; 7 thao tác (GET, PATCH redirectUris / allowedResources:[] / disabled:true, GET/POST secrets, DELETE secrets/1) ⇒ đều 404, body byte-identical với UUID ngẫu nhiên, `{error:"not_found"}`, không có `clientSecret`; snapshot client + credentials của B không đổi.
2. **Disable ⇒ liveness admin token**: super_admin tạo client admin-capable X; AT `aud=admin` do X phát hành GET `/admin/clients` 200 → disable X ⇒ 401 `invalid_token` → enable ⇒ 200.
3. **Disable ⇒ `/token` với `client_secret_post`** (bổ sung cho test basic/public đã có): 400 (auth qua) → disable ⇒ 401 `invalid_client` → enable ⇒ 400.
4. **Grace TTL**: rotate ⇒ version cũ `expiresAt` ∈ [now+3600s ± 2s] (CLIENT_SECRET_GRACE_TTL test = 3600), version mới không hết hạn. (Hết grace ⇒ 401 đã có ở test Task 3, chỉnh `expiresAt`, không sleep.)
5. **OpenAPI production trên Fastify thật**: `NODE_ENV=production` và unset ⇒ `registerAdminOpenApi` = false, `GET /openapi/admin.json` 404, không có tài liệu (`paths`).

## Coverage acceptance criteria (đối chiếu tasks.md + Fold tech-lead)

- [x] T1 projection không lộ hash — unit `admin.spec.ts` mapper key set; int "client projection", secrets listing không `$argon2`/`secretHash`, DB projection `listMetadata`
- [x] T1 phân trang trần — int "limit=101 / limit=0 / limit=abc / repeated after ⇒ 400", "pagination walks every client once"
- [x] T1 tenant chỉ từ token — int "?tenantId= / body tenantId ⇒ 400"
- [x] T1 OpenAPI sinh được (test env) — int "GET /openapi/admin.json"; production ⇒ unit gate + **int mới #5**
- [x] T2 CRUD, clientId server sinh — int "CRUD", "client-chosen clientId ⇒ 400"
- [x] T2 cross-tenant 404 byte-identical — int "cross-tenant GET/PATCH"; client admin-capable tenant khác — **int mới #1 (DEBT-136)**
- [x] T2 step-up / insufficient_scope — int "auth_time > 5 min", "admin.read only ⇒ 403"
- [x] T2 validation âm (redirect, CORS, resource, auth-method), bất biến, PATCH rỗng — int tương ứng
- [x] T2 tenant_admin gán `admin` ⇒ 403; client admin-capable: mọi mutation tenant_admin ⇒ 403 — int tương ứng
- [x] T2 CORS sau PATCH — int "after PATCH allowedCorsOrigins"
- [x] T2 disable chặn `/token`, `/introspect`, `/authorize`, CORS (2 query), enable lại — int "disable ⇒ …" + **int mới #2 (liveness admin), #3 (client_secret_post)**
- [x] T2 tự disable ⇒ 409; decideConsent sau gỡ redirect ⇒ không 302/không code — int tương ứng
- [x] T2 audit đúng action, metadata không key bí mật — int "audit: create …"
- [x] T3 secret mới auth `/token`; cũ trong grace rồi hết; revoke ngay; listing metadata; plaintext không trong audit/log (spy stdout/stderr) — int "create → rotate → expire → revoke" + **int mới #4**
- [x] T3 version không hợp lệ 400, cross-tenant 404, public 400, step-up, audit lỗi ⇒ 500 không plaintext, 2 POST đồng thời (DEBT-133) — int tương ứng
- [x] T4 resources: mọi admin đọc; tenant_admin POST/PATCH 403 DB không đổi; validation 400; trùng 409; PATCH identifier/resourceId 400; audit; step-up — int Task 4
- [x] E2E toàn luồng không hồi quy — `pnpm -C e2e e2e` 12/12

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | tenant_admin A, super_admin A, tenant_admin B, không token | int Task 1–4, mới #1 |
| Credential | AT admin hợp lệ, `auth_time` cũ (step-up), chỉ `admin.read`, AT do client đã disable | int step-up/scope, mới #2 |
| Authorization | owner tenant, cross-tenant (client thường + admin-capable), wrong role (tenant_admin ghi resource / client admin-capable), super_admin không xuyên tenant | int cross-tenant, mới #1 |
| Input | redirect wildcard/fragment/http-nonlocal, CORS có path/`*`, resource lạ, field bất biến, `tenantId` lạ, limit biên 0/101/abc, version 0/-1/abc/1.5/01 | int Task 1–3 |
| State | disable → enable, rotate → grace → expire → revoke → create lại, revoke lặp ⇒ 404, pending consent sau gỡ redirect | int Task 2–3, mới #3/#4 |
| Concurrency | 2 POST secrets đồng thời | int DEBT-133 |
| Dependency | audit ghi lỗi ⇒ 500, plaintext không trả | int Task 3 |
| Exposure | response (không `secretHash`/`$argon2`/plaintext ở listing, 404 không oracle), audit, stdout/stderr log, OpenAPI production 404 | int Task 3, mới #1/#5 |

## Ghi chú / debt

- DEBT-136 **đóng** (int mới #1 + mutation RED).
- DEBT-139 (mới, 🟡 [BE], ngoài phạm vi run): log E2E in cảnh báo Mongoose "`new` option for `findOneAndUpdate()` is deprecated" — nguồn `refresh-token.service.ts:271` `{ new: false }` (code cũ, không thuộc diff run 27).
- Dev DB/E2E: E2E chạy `db:sync-indexes` trong webServer; dev DB `sso-idp` vẫn cần `pnpm -C be db:sync-indexes` thủ công cho index `{tenantId, clientId}` (không chạy bởi tester).
