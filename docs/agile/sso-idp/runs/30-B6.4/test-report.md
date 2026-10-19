# Test Report — 2026-10-19 — run 30 (B6.4 seed + DEBT-137/161/163)

# Lượt 2 (retest sau backend-dev retry 1) — 2026-10-19

## Kết quả: PASS (BE unit 262/262, int 705/705, FE 240/240, E2E 12/12; 0 lỗi [BE] chặn)

| Bộ | Kết quả |
|---|---|
| BE typecheck (`pnpm -C be typecheck`) | ✅ exit 0 (trước và sau khi thêm spec tester) |
| BE lint (`pnpm -C be lint`) | ✅ exit 0 (trước và sau khi thêm spec tester) |
| BE unit `pnpm -C be test` | ✅ **262/262** (24 suites) |
| BE int `pnpm -C be test:int` (vg-test-*), code dev | ✅ **697/697** (32 suites); 3 PoC tester `seed-risk.int-spec` + `seed-risk-flow.int-spec` **xanh, không sửa** |
| BE int sau khi thêm spec tester lượt 2 | ✅ **705/705** (33 suites) |
| FE `pnpm -C fe-sso-test test` | ✅ 240/240 (31 files) |
| E2E `pnpm -C e2e e2e` (1 lần) | ✅ **12/12** (47.0s). :5173/:4000/:3000 trống trước; sau chạy :5173/:4000 trống. Không dừng process nào |
| CLI `db:seed` (dist, ma trận env, DB `vg-int-seedcli-*`) | ✅ 33/33 case đúng kỳ vọng (case L2-3) |
| `.env.example` copy tạm khởi động | ✅ qua validation (case L2-4), DEBT-169 đóng đúng |
| Mutation tester (3) | ✅ đều RED, khôi phục `cp` + sha256 khớp (case L2-2) |

### Lệnh đã chạy + output thực tế (lượt 2)
- `pnpm -C be typecheck` → `tc exit 0`; `pnpm -C be lint` → `lint exit 0`.
- `pnpm -C be test` → `Test Suites: 24 passed, 24 total` / `Tests: 262 passed, 262 total`.
- `pnpm -C be test:int` (lần 1, code dev) → `Test Suites: 32 passed, 32 total` / `Tests: 697 passed, 697 total` (`PASS test/seed-risk.int-spec.ts`, `PASS test/seed-risk-flow.int-spec.ts`, `PASS test/admin-public-client.int-spec.ts`, `PASS test/seed.int-spec.ts`).
- `pnpm test:int -- --testPathPatterns admin-target-risk --verbose` → `Tests: 8 passed, 8 total`.
- `pnpm -C be test:int` (lần 2, có spec mới) → `Test Suites: 33 passed, 33 total` / `Tests: 705 passed, 705 total`.
- `pnpm -C fe-sso-test test` → `Test Files 31 passed (31)` / `Tests 240 passed (240)`.
- `pnpm -C e2e e2e` → `12 passed (47.0s)`, exit 0.

### Case L2-1 — Case 1 lượt 1 đã sửa
3 test đỏ lượt 1 nay xanh, không sửa test: seed từ chối re-point (`refusing to point resource 'admin' …`, throw trước mọi ghi), client confidential không còn secret cũ trên client admin-capable, flow end-to-end SPA public + PKCE với `resource=admin` không bao giờ cho `/admin/me` 200.

### Case L2-2 — Biến thể mới: public + admin ở mọi đường phát hành token (`be/test/admin-target-risk.int-spec.ts`, 8 test)
- `clientType` lạ ⇒ `/authorize resource=admin` về RP `error=invalid_target`, không `code`, không /login (fail-closed): thiếu field, `''`, `'Public'`, `'CONFIDENTIAL'`, `'confidential '`. 5/5 xanh.
- Đường auto-approve: consent `(user, SPA, admin)` lưu từ trước run 30 + session sống, có và không `prompt=none` ⇒ `invalid_target`, không code; đối chứng `demo` ⇒ có code.
- `resource` lặp (demo+admin, admin+demo) ⇒ không bao giờ ra AT `aud=admin` (nếu có code thì AT đổi được không mang aud admin), không 5xx.
- Guard re-point seed với client public ở **tenant khác** (`tenant-b`) tham chiếu `admin` có identifier lạ ⇒ throw `refusing to point`, DB giữ nguyên (`{clients:1, resources:1}`, identifier không đổi).
- Đã có từ dev (`admin-public-client.int-spec`, xanh): `/authorize`, consent POST (client chuyển public giữa render/approve), `/token` code ⇒ `invalid_target`, refresh ⇒ `invalid_grant` không burn; mỗi test có đối chứng `demo`. `token.controller` chỉ hỗ trợ `authorization_code` + `refresh_token` ⇒ 4 chốt phủ hết đường phát hành.
- Mutation (sao lưu ở scratchpad, khôi phục `cp`, `restored sha256 OK` cả 3):
  - M1 `adminTargetForbidden` thành `clientType === 'public'` (không fail-closed) ⇒ 5 đỏ (5 biến thể clientType).
  - M2 bỏ chốt trong `AuthorizeService.resolveResource` ⇒ 6 đỏ (5 clientType + auto-approve). Test `resource` lặp vẫn xanh vì chốt `/token` chặn (phòng thủ nhiều lớp, đúng invariant).
  - M3 bỏ `if (referrer)` trong `seedBootstrap` ⇒ 1 đỏ (re-point tenant khác).

### Case L2-3 — Ma trận env CLI `db:seed` sau khi `ADMIN_SEED_PASSWORD` rời `envSchema` (script tạm `cli-matrix2.cjs`, `cli-par.cjs` ở scratchpad, cwd rỗng, `dist` mới hơn mọi file `src`)
- Env đủ: lần 1 exit 0, `shown once`=1; lần 2 exit 0, =0; lần 3 ISSUER `:4100` exit 0, =0; tenants 1/resources 3/users 1/usertenants 1/clients 2/clientcredentials 1.
- Thiếu từng biến (19) ⇒ exit 1, 0 document, không lộ password. **Khác lượt 1**: thiếu `ADMIN_SEED_PASSWORD` nay báo từ zod riêng của seed `seed: invalid admin environment: ADMIN_SEED_PASSWORD is required` (không còn qua `envSchema`), vẫn fail trước kết nối, 0 ghi.
- Password rỗng / 11 / 129 ký tự ⇒ exit 1 `must be between 12 and 128 characters`, 0 document; biên 12 và 128 ký tự ⇒ exit 0, secret in 1 lần, không lộ password.
- Email sai, `NODE_ENV=production|staging`, ISSUER không URL ⇒ exit 1, 0 document.
- **Mới**: CLI thật với `admin` identifier lạ + client public tham chiếu ⇒ exit 1 `refusing to point resource 'admin' at http://localhost:4000/admin/: client qa-spa already references it …`, DB giữ `{resources:1, clients:1}`.
- 2 CLI song song sau `db:sync-indexes` (như README) ×6 vòng: exit 0,0; chỉ credential fe-admin 1–2 (DEBT-164 chấp nhận), không nhân đôi document khác.
- 🟡 **Phát hiện (DEBT-176)**: 2 CLI song song trên DB **chưa** `db:sync-indexes` (chỉ index `_id_`) ×6 vòng ⇒ 4/6 vòng nhân đôi: `fe-admin` ×2, **user `ADMIN_SEED_EMAIL` ×2**, resource `other`/`demo` ×2, `fe-sso-test` ×2. Dòng "không nhân đôi" ở lượt 1 là may mắn của 1 lần chạy. Không chặn: README ghi rõ `db:sync-indexes` trước `db:seed`, chỉ dev|test, tech-lead đã chấp nhận rủi ro chạy song song (DEBT-164); nhưng seed không kiểm tiền điều kiện ⇒ hỏng dữ liệu im lặng.
- Không case nào lộ password trong stdout/stderr. DB tạm đều drop.

### Case L2-4 — `.env.example` copy tạm khởi động (DEBT-169)
Bản copy ở scratchpad (sha256 trùng bản gốc; `be/.env` thật không đụng), `node --env-file-if-exists=.env be/dist/main.js`, `MONGO_URI`/`REDIS_URL` trỏ cổng 1, `timeout 25`:
- (a) copy nguyên (`ADMIN_SEED_PASSWORD=` rỗng) ⇒ exit 124 (qua validation, treo chờ kết nối), không `Invalid environment variables`.
- (b) bỏ hẳn dòng `ADMIN_SEED_PASSWORD` ⇒ exit 124, qua validation.
- (c) env cũ còn `ADMIN_SEED_PASSWORD` có giá trị ⇒ exit 124, qua validation (schema không strict).
- Đối chứng (d) bỏ `CSRF_SECRET` ⇒ exit 1 `Invalid environment variables` + `CSRF_SECRET: Invalid input` (validation vẫn hoạt động).
- Sau chạy không còn process `dist/main.js` / `dist/database/seed.js`.

## Test FAIL (lượt 2)
Không có.

## Coverage acceptance criteria (lượt 2)
- [x] T1/T4 invariant admin chỉ cho client confidential không secret cũ, qua đường seed re-point: `seed-risk*` (PoC lượt 1, nay xanh) + `seed.int-spec` (dev +6) + `admin-target-risk` (tenant khác) + CLI L2-3
- [x] T1 env thiếu/sai ⇒ lỗi, không ghi, không lộ password: CLI L2-3 (ma trận mới sau DEBT-169)
- [x] DEBT-169 app boot với `.env.example`: L2-4 + unit `validation.schema.spec` (dev)
- [x] DEBT-172 chặn runtime 4 chốt: `admin-public-client` (dev) + `admin-target-risk` (biến thể)
- [x] Các AC còn lại như lượt 1: vẫn xanh trong unit 262 / int 705 / E2E 12

## Coverage security invariants / risk matrix (lượt 2)
- [x] Identity: super_admin (flow PoC), client tenant khác (`tenant-b` referrer)
- [x] Credential: public PKCE không secret (PoC flow), confidential secret cũ (PoC)
- [x] Authorization: `clientType` thiếu/sai hoa-thường/khoảng trắng ⇒ fail-closed (M1 RED)
- [x] Input: `resource` lặp; password 11/12/128/129; env thiếu từng biến
- [x] State: consent lưu trước run 30 + session sống (auto-approve, `prompt=none`); resource `admin` identifier lạ; ISSUER đổi
- [x] Concurrency: 2 CLI song song có/không sync-indexes (DEBT-176)
- [x] Dependency: Mongo/Redis không tới được khi boot ⇒ không fail ở validation (L2-4)
- [x] Request chain: /authorize → consent → /token → /admin/me (PoC flow); refresh
- [x] Exposure: password không ở stdout/stderr CLI mọi case
- Dư đã biết, không chặn: DEBT-173 (AT cũ public+admin qua `AdminTokenGuard`), DEBT-174 (confidential + `none`).

## Debt mới (lượt 2)
- DEBT-176 🟡 [BE]: `db:seed` không kiểm/không tạo unique index ⇒ 2 seed song song trên DB chưa sync-indexes nhân đôi user super_admin / fe-admin / resources; xem `backlog.md`.

## File test mới (tester lượt 2)
- `be/test/admin-target-risk.int-spec.ts` (mới, 8 test xanh)

---

# Lượt 1

## Kết quả: FAIL (BE int 684/687; 3 test mới của tester đỏ = 1 lỗi bảo mật [BE])

| Bộ | Kết quả |
|---|---|
| BE typecheck (`tsc --noEmit`) | ✅ exit 0 |
| BE lint (`eslint src test`) | ✅ exit 0 (cả 2 file spec mới) |
| BE unit `pnpm -C be test` | ✅ 260/260 (24 suites) |
| BE int `pnpm -C be test:int` (vg-test-*) | ❌ **684/687** (31 suites, 2 suite đỏ) — 678 của dev xanh + 6 test mới tester xanh; 3 test mới tester đỏ (case 1) |
| FE `pnpm -C fe-sso-test test` | ✅ 240/240 (31 files) |
| E2E `pnpm -C e2e e2e` (1 lần) | ✅ 12/12 (1.0m). :5173 trống từ đầu, không phải dừng process nào; sau khi chạy :5173/:4000 đã giải phóng |
| CLI `db:seed` (dist, ma trận env, DB `vg-int-seedcli-*`) | ✅ 28/28 case đúng kỳ vọng (case 3) |
| DEBT-169 (copy `.env.example`) | Xác nhận tái hiện (case 4) |

## Lệnh đã chạy + output thực tế

- `pnpm -C be typecheck` → `tc exit 0`; `pnpm -C be lint` → `lint exit 0` (chạy lại sau khi thêm test: vẫn 0).
- `pnpm -C be test` → `Test Suites: 24 passed, 24 total` / `Tests: 260 passed, 260 total`.
- `pnpm -C be test:int` → `Test Suites: 2 failed, 29 passed, 31 total` / `Tests: 3 failed, 684 passed, 687 total`. Suite đỏ: `test/seed-risk.int-spec.ts`, `test/seed-risk-flow.int-spec.ts`. (Cảnh báo `Cannot log after tests are done … [ioredis] Unhandled error event` có sẵn từ `redis-fail-fast`, không mới.)
- `pnpm -C fe-sso-test test` → `Test Files 31 passed (31)` / `Tests 240 passed (240)`.
- `pnpm -C e2e e2e` → `12 passed (1.0m)`.
- `pnpm test:int -- --testPathPatterns admin-api.int-spec --verbose` (riêng) → `Tests: 47 passed, 47 total`; dòng thông tin `DEBT-161 race: 0/15 disable requests got 409`.

### Case 1 — 🔴 [BE] DEBT-137 bị bypass qua `db:seed` (re-point resource `admin`)
`seedBootstrap` upsert resource khoá `resourceId:'admin'` bằng `$set {identifier: adminResourceIdentifier(issuer)}`. Nếu trước đó `resourceId:'admin'` tồn tại với identifier KHÁC (seed chạy với ISSUER cũ — đường "đổi ISSUER" mà seed-dev hỗ trợ; hoặc super_admin `POST /admin/resources {resourceId:'admin', identifier:<khác>}` — `createUnique` chỉ chặn trùng `resourceId`), thì app coi `admin` là resource thường ⇒ tenant_admin gắn được `admin` cho client **public** của mình (`assertAllowedResources` chỉ so identifier admin) hoặc client confidential có secret tenant_admin biết. Chạy `db:seed` ⇒ identifier bị đổi thành identifier admin ⇒ client đó admin-capable mà KHÔNG qua rule A (public) / rule B (revoke secret). `/authorize`/`/token` không kiểm `clientType` khi `resource=admin` nên không có lớp chặn runtime.
- `seed-risk.int-spec` › "resource admin re-pointed … must not make a PUBLIC client admin-capable" — kỳ vọng seed từ chối HOẶC client public không admin-capable; thực tế `{threw:false, spaIsAdminCapable:true}`.
- `seed-risk.int-spec` › "a CONFIDENTIAL client whose secret predates the re-point keeps no live pre-grant secret" — thực tế `{threw:false, bffAdminWithLiveOldSecret:true}`.
- `seed-risk-flow.int-spec` (chứng minh end-to-end): super_admin được seed đăng nhập qua SPA public (redirect do tenant_admin kiểm soát) với `resource=<admin aud>` → consent → `/token` chỉ `client_id`+PKCE (không secret) → `GET /admin/me` **200** với `sub` của super_admin. Kỳ vọng: không bao giờ 200.
- Tác động: đúng kịch bản DEBT-137 (tenant_admin lấy AT `aud=admin` của super_admin qua redirect của mình), invariant run 30 "client có admin ⇒ confidential + không còn secret trước grant" bị vi phạm. Phạm vi hiện tại dev|test (seed chặn production), nhưng là lỗi do run 30 đưa vào và thiết kế sẽ mang sang seed production (DEBT-164).
- Nghi nguyên nhân / gợi ý cho backend-dev: (a) seed: khi `admin` đã tồn tại với identifier khác (hoặc trước khi re-point) ⇒ áp rule A/B: từ chối nếu có client public tham chiếu `admin`, và thu hồi secret của client confidential (≠ fe-admin) tham chiếu `admin`, hoặc đơn giản từ chối re-point và yêu cầu xử lý tay; và/hoặc (b) chặn runtime: `/authorize` (hoặc `TokenService`/`AdminTokenGuard`) từ chối `resource=admin` cho client `public` — lớp này cũng phủ dữ liệu cũ (DEBT-172).

### Case 2 — Test mới xanh (6)
- `seed-risk.int-spec`: (1) **2 seed song song** × 5 vòng trên DB rỗng: tenants 1/resources 3/users 1/usertenants 1/clients 2; credential fe-admin 1–2 (DEBT-164 chấp nhận), mọi secret trả về đều verify được với credential còn sống, membership `['super_admin']`, không lỗi khác E11000. (2) **ISSUER khác** giữa 2 lần: resources vẫn 3, `admin`/`demo` re-point tại chỗ sang ISSUER mới, không phát secret mới, `secretHash` không đổi, fe-admin `allowedResources:['admin']`. (3) ISSUER không phải URI ⇒ throw, 0 document.
- `admin-api.int-spec` › "run 30 QA (tester) …": (4) client public: super_admin PATCH `['admin']`, `['admin','admin']`, `['admin','api']` ⇒ 400; tenant_admin PATCH/POST public có `admin` ⇒ 403; DB không đổi. (5) client public cũ đã mang `admin` (dữ liệu trước run 30) + super_admin PATCH gửi lại `admin` ⇒ 400, field khác không bị ghi. (6) **DEBT-161 race thật**: 10× disable‖disable ⇒ cả 2 200, `disabledAt` 2 response = DB; 15× disable‖enable ⇒ disable chỉ 200/409 (409 ⇒ `conflict`), enable 200, số audit success khớp (409 không để audit success). Ghi chú: race thật không chạm nhánh `matchedCount 0` (0/15) — nhánh đó được phủ bởi unit `client.service.spec` của dev.
- Mutation (tester): `assertAdminCapableType` → no-op ⇒ 3 đỏ (`rule A` của dev + test (4) + (5)); khôi phục bằng `cp` bản sao lưu, sha256 khớp (`restored sha256 OK`).

### Case 3 — Ma trận env CLI `db:seed` (script tạm `cli-matrix.cjs` ở scratchpad, chạy `node --env-file-if-exists=.env be/dist/database/seed.js` với cwd rỗng — không nạp `be/.env` thật; dist build 08:50 mới hơn src)
- Env đủ: lần 1 exit 0, dòng `shown once` = 1; lần 2 exit 0, = 0; lần 3 ISSUER `:4100` exit 0, = 0, document: tenants 1/resources 3/users 1/usertenants 1/clients 2/clientcredentials 1.
- Thiếu từng biến bắt buộc (19 biến: NODE_ENV, ISSUER, MONGO_URI, REDIS_URL, 4 TTL, KEY_LOCAL_DIR, SMTP_URL, GOOGLE_*, GITHUB_*, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_*) ⇒ mọi case exit 1, 0 document ghi, không in password. NODE_ENV thiếu ⇒ `refusing to run with NODE_ENV=(unset)`; còn lại `Invalid environment variables`.
- `ADMIN_SEED_PASSWORD` rỗng ⇒ exit 1 (envSchema); 11 ký tự ⇒ exit 1 `must be between 12 and 128 characters`; email sai ⇒ exit 1; `NODE_ENV=production`/`staging` ⇒ exit 1 trước khi kết nối; ISSUER không phải URL ⇒ exit 1. Tất cả 0 document.
- 2 tiến trình CLI song song ⇒ cả 2 exit 0, **2 dòng `shown once`**, 2 credential fe-admin, các collection khác không nhân đôi — đúng rủi ro đã chấp nhận DEBT-164.
- Không case nào lộ password trong stdout/stderr. DB tạm đã drop.

### Case 4 — DEBT-169 xác nhận
Bản copy tạm `.env.example` → `<scratch>/env169a/.env` (sha256 trùng bản gốc; `be/.env` thật không đụng), chạy `node --env-file-if-exists=.env be/dist/main.js` với `MONGO_URI`/`REDIS_URL` trỏ cổng 1 (không chạm DB dev): **exit 1**, `Invalid environment variables` + `ADMIN_SEED_PASSWORD: Too small: expected string to have >=1 characters`. Đối chứng `env169b` (chỉ điền ADMIN_SEED_PASSWORD placeholder): qua validate env, treo chờ kết nối, bị `timeout 25` dừng (exit 124). ⇒ DEBT-169 đúng như senior mô tả (app không boot khi copy env mới). Không còn process `dist/main.js`/`seed.js` sót.

## Test FAIL
- `seed-risk.int-spec` › re-point ⇒ public client admin-capable — kỳ vọng seed từ chối hoặc client không admin-capable vs thực tế client public tham chiếu resource admin — [BE] seed `$set identifier` không áp rule A/B.
- `seed-risk.int-spec` › re-point ⇒ client confidential giữ secret cũ — kỳ vọng không còn secret trước grant vs thực tế còn — [BE] như trên.
- `seed-risk-flow.int-spec` › SPA public lấy AT `aud=admin` — kỳ vọng `/admin/me` ≠ 200 vs thực tế 200 (super_admin) — [BE] như trên + không có chặn runtime public/admin.

## Coverage acceptance criteria
- [x] T1 chạy 2 lần không nhân đôi, secret 1 lần, credential không đổi — `seed.int-spec` (dev) + CLI case 3
- [x] T1 password/lock giữ, roles khôi phục, fe-admin insert-only — `seed.int-spec` (dev)
- [x] T1 login → /authorize admin → /token basic → /admin/me 200 super_admin — `seed.int-spec` (dev)
- [x] T1 thiếu/sai env ⇒ lỗi, không ghi, không lộ password — `seed.int-spec` + CLI case 3 (19 biến + 6 giá trị sai)
- [x] T1 production/rỗng ⇒ throw trước ghi; adm2 ⇒ throw — `seed.int-spec` + CLI case 3
- [x] T1 không log secret/password — `seed.int-spec` + CLI case 3
- [ ] T1/T4 invariant admin chỉ cho client confidential không secret cũ — **FAIL** qua đường seed re-point (case 1)
- [x] T4 grant ⇒ revoke mọi secret, S ⇒ invalid_client, 2 lượt, fail-closed, audit, cross-tenant 404 — `admin-api` (dev)
- [x] T4 rule A trên create/PATCH (mọi biến thể list, tenant_admin, dữ liệu cũ) — `admin-api` (dev + tester (4)(5)), mutation RED
- [x] T3 DEBT-161 — unit `client.service.spec` (dev) + race thật tester (6)
- [x] T3 DEBT-163 — unit `keys.spec` (dev, nằm trong 260 unit)

## Coverage security invariants / risk matrix
- [x] Identity: super_admin, tenant_admin (403), user khác tenant (404) — `admin-api`
- [x] Credential: secret S trước grant (revoked), secret chen giữa (lượt 2), secret mới super_admin — `admin-api` (dev)
- [x] Authorization: negative actor tenant_admin POST/PATCH admin ⇒ 403 — tester (4)
- [x] Input: env thiếu/rỗng/ngắn/sai định dạng, ISSUER không URL, list `admin` trùng — case 3, tester (3)(4)
- [x] State: seed lần 2, ISSUER đổi, dữ liệu cũ (public đã có admin), resource `admin` identifier khác — case 2/3, **case 1 FAIL**
- [x] Concurrency: 2 seed in-process ×5 + 2 CLI song song; disable‖disable, disable‖enable ×25 — case 2/3
- [x] Dependency: revoke lượt 1/2 lỗi — `admin-api` (dev); Mongo không tới được ⇒ CLI không ghi (case 3, thiếu MONGO_URI)
- [x] Request chain: login → /authorize → consent → /token → /admin/me cho fe-admin (dev) và SPA public (case 1)
- [x] Exposure: password/secret không ở stdout/stderr CLI (case 3), console/Logger (dev); secret chỉ 1 dòng stdout

## Debt mới
- DEBT-172 🟡 [BE] — không có chặn runtime `resource=admin` cho client public (dữ liệu trước run 30 / mọi đường ghi ngoài API); xem `backlog.md`.

## File test mới / sửa (tester)
- `be/test/seed-risk.int-spec.ts` (mới, 5 test: 3 xanh, 2 đỏ)
- `be/test/seed-risk-flow.int-spec.ts` (mới, 1 test đỏ)
- `be/test/admin-api.int-spec.ts` (+3 test xanh, describe "run 30 QA (tester)")
