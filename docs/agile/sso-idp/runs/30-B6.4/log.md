# Log — run 30 — B6.4 seed bootstrap + DEBT-137/143/161/163

## orchestrator — 2026-10-16
- Kết thúc lane B6 (M5 BE). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B6 dòng 213 (B6.4) + debt cùng vùng (DEBT-143 super_admin/tenant hệ thống, DEBT-137, DEBT-161, DEBT-163). Cổng → tech-lead.

## tech-lead — 2026-10-16
- **PASS** (fold bắt buộc trong `tasks.md` mục "Fold tech-lead"). Đối chiếu code: `seed-dev.ts` (`seedDev`/`seedDevUser`/`upsert`/`assertNotProduction`), `TenantService.seedDefault`, `ClientCredentialService.hasActive/createSecret`, `ClientService.updateForTenant` (stamp `disabledAt`, `$nin` admin), `AdminTokenGuard` (roles theo `client.tenantId`), `LocalKeyProvider.init`, `KeysModule` (từ chối production), `envSchema` `ADMIN_SEED_*`.
- Q-30.1: `seed.ts` + `db:seed` riêng, dùng lại `seedDev`/`ClientCredentialService`; chỉ development|test. Q-30.2: hoãn DEBT-143 (cùng DEBT-124). Q-30.3: super_admin cấp `admin` ⇒ revoke mọi secret 2 lượt (trước/sau update) + admin chỉ cho client confidential; không xoá redirect.
- Fold chính: hậu kiểm resource admin (E11000 bị nuốt), admin user `$setOnInsert` (không reset password/lock), fe-admin `$setOnInsert`, `seedBootstrap` trả secret (CLI in 1 lần), password seed 12–128; DEBT-161 `matchedCount 0` ⇒ re-read/409; DEBT-163 WARN orphan kid + runbook.
- Phạm vi cuối: Task 1, 3, 4 (backend-dev; thứ tự 1 → 4 → 3). Task 2 hoãn. Debt mới: DEBT-164/165/166; DEBT-127 dời B7.1. Cổng → **backend-dev**.

## backend-dev — 2026-10-19 (tiếp lượt bị ngắt)
- Rà `git diff`: Task 1 (`seed.ts`, `seed.int-spec`, README/.env.example/`db:seed`) + code Task 4 đã có, khớp fold; thiếu test Task 4 và toàn bộ Task 3 ⇒ bổ sung. Security: tài sản = secret fe-admin/mật khẩu super_admin/client `aud=admin`; actor tenant_admin (đối thủ); invariant: rerun không reset/rotate, client có admin ⇒ confidential + không còn secret trước grant; fail-closed revoke lượt 1, lượt 2 ⇒ 5xx + audit failure; chỉ log kid/count.
- Task 1 ✅ int 12 (2 lần không nhân đôi, secret 1 lần, password/lock giữ, roles khôi phục, adm2 ⇒ throw, prod/rỗng ⇒ 0 doc, spy log không lộ, login→/authorize→/token→/admin/me 200). Mutation (a) bỏ `hasActive` (b) `$set` passwordHash (c) bỏ hậu kiểm ⇒ RED 1/2/1.
- Task 4 ✅ int `admin-api` +6 (S ⇒ invalid_client /token+/introspect, secret chen giữa bị lượt 2 thu hồi, lỗi lượt 1 ⇒ 5xx chưa cấp, lỗi lượt 2 ⇒ 5xx + audit `secret_revoke_failed` + DELETE khôi phục, rule A 400, cross-tenant 404). Lượt 2 dời lên ngay sau update (trước stamp disable có thể 409). Mutation: bỏ cả 2 lượt ⇒ 4 đỏ; bỏ lượt 2 ⇒ 2 đỏ; bỏ rule A ⇒ 1 đỏ.
- Task 3 ✅ DEBT-161: `matchedCount !== 1` ⇒ re-read; chưa disable ⇒ `ConcurrentClientUpdateError` → 409 (`toAdminError`); unit `client.service.spec` 4, mutation ⇒ 3 đỏ. DEBT-163: `init` WARN orphan kid (bỏ qua `.tmp`, không xoá), runbook §6; unit keys +2, mutation lọc ⇒ 2 đỏ. Mọi mutation khôi phục bằng cp + sha256 khớp.
- Verify: typecheck ✅, lint ✅, unit **260/260** (24 suites), int **678/678** (29 suites), E2E **12/12**. Đóng DEBT-137/161/163; mở 🟡 DEBT-167 (409 sau update chính ⇒ field khác đã ghi mà không audit), DEBT-168 (nhánh `readdir` lỗi chưa test).
- Hạ tầng: Docker Desktop đang tắt ⇒ đã mở + `docker start vg-test-mongo vg-test-redis` (aegate-*/mailpit tự lên theo Docker). Không chạy `db:seed` trên DB dev. Cổng → **senior-reviewer**.

## senior-reviewer — 2026-10-19
- **PASS** (lượt 1, không 🔴) — `review-senior.md`. Tự chạy: typecheck ✅, unit 260/260, int `seed|admin-api` 81/81 (vg-test-*). Không E2E, không seed DB dev.
- Kiểm invariant: seed chặn production 2 lớp, secret chỉ ra stdout trong `main`, `$setOnInsert` user/fe-admin (không reset password/lock/cấu hình), hậu kiểm resource admin; DEBT-137 fail-closed (lượt 1 trước update, lượt 2 ngay sau, audit failure), rule A, cross-tenant 404; DEBT-161 không báo disable sai; DEBT-163 WARN chỉ kid.
- 🟡 mở DEBT-169 (`.env.example` `ADMIN_SEED_PASSWORD=` rỗng + `envSchema` min(1) ⇒ app không boot khi copy env mới), DEBT-170 (revoke lượt 1 xong mà update null/lỗi ⇒ không audit), DEBT-171 (ponytail). Đánh giá DEBT-167: DB nhất quán, retry hội tụ, nhưng có thể cấp `admin` không audit ⇒ khuyến nghị ưu tiên (fix rẻ trong `.catch` controller). Cổng → **tester**.

## tester — 2026-10-19
- **FAIL** (1 lỗi bảo mật [BE]) — `test-report.md`. Chạy thật: typecheck ✅, lint ✅, unit 260/260, int **684/687** (3 đỏ = test mới tester), FE 240/240, E2E 12/12 (:5173 trống, không kill process nào). CLI `db:seed` ma trận env 28/28 đúng kỳ vọng (DB `vg-int-seedcli-*`, đã drop). Không chạy seed trên DB dev, không đụng `be/.env`/`be/keys` thật.
- 🔴 [BE] DEBT-137 bypass qua `db:seed`: resource `resourceId:'admin'` có identifier khác (ISSUER cũ / tạo qua API) ⇒ tenant_admin gắn được `admin` cho client public/confidential của mình; seed `$set identifier` ⇒ client thành admin-capable không qua rule A/B. Chứng minh end-to-end: SPA public + PKCE (không secret) ⇒ AT `aud=admin` của super_admin ⇒ `/admin/me` 200 (`seed-risk-flow.int-spec`). Trả **backend-dev**.
- Test mới: `be/test/seed-risk.int-spec.ts` (2 seed song song ×5, ISSUER đổi, ISSUER sai, 2 test re-point đỏ), `be/test/seed-risk-flow.int-spec.ts` (đỏ), `admin-api.int-spec` +3 (rule A mọi biến thể + dữ liệu cũ, DEBT-161 race thật 25 cặp — 0/15 chạm nhánh 409). Mutation `assertAdminCapableType` no-op ⇒ 3 đỏ; khôi phục cp + sha256 khớp.
- DEBT-169 xác nhận trên bản copy tạm `.env.example`: app exit 1 `ADMIN_SEED_PASSWORD: Too small`; đối chứng có password ⇒ qua validate.
- Mở 🟡 DEBT-172 (không chặn runtime `resource=admin` cho client public). Cổng → **backend-dev** (retry 1).

## backend-dev — 2026-10-19 (retry 1)
- Security: tài sản = AT `aud=admin`; actor tenant_admin (client public/confidential của mình); invariant "client lấy được `aud=admin` ⇒ confidential, không secret trước grant" phải đúng cả khi dữ liệu không qua admin API. Fail-closed: seed throw trước mọi ghi; runtime từ chối (code đã consume vẫn mất).
- (a) `seed.ts` bước 0 re-point guard (đơn giản: từ chối nếu có referrer khác fe-admin; fe-admin chỉ miễn khi `admin` cũ có dạng `/admin/` = đổi ISSUER). `POST/PATCH /admin/resources` rà: không lỗ tương tự (identifier immutable, resourceId mới không có referrer).
- (b) DEBT-172 `adminTargetForbidden` (token.service): `/authorize` ⇒ `invalid_target`; consent POST ⇒ trang lỗi, không code; `/token` code ⇒ 400 `invalid_target`; refresh ⇒ loại admin identifier khỏi allowlist ⇒ `invalid_grant`, không burn. Sửa fixture `token.service.spec` (client public + aud=admin giờ sai theo rule A ⇒ dùng confidential) + 1 unit âm.
- (c) DEBT-169: bỏ `ADMIN_SEED_PASSWORD` khỏi `envSchema`/`configuration` (seed tự đọc 12..128); unit đọc `.env.example` thật; README/.env.example ghi chú.
- Test: 3 PoC tester xanh (không sửa); `seed.int-spec` +6 (re-point public/confidential/dangling/fe-admin legacy/ISSUER+client khác/đã trỏ), `admin-public-client.int-spec` 4 (mỗi test có control `demo`). Mutation (cp + sha256 khớp): bỏ guard seed ⇒ 7 đỏ (flow PoC vẫn xanh nhờ runtime); bỏ guard seed+authorize ⇒ flow PoC đỏ; bỏ authorize/consent/code/refresh ⇒ 1 đỏ mỗi chốt; thêm lại `min(1)` ⇒ đỏ.
- Verify: typecheck ✅, lint ✅, unit **262/262** (24), int **697/697** (32), E2E **12/12** (:5173/:4000 trống trước/sau). Không chạy seed trên DB dev, không đụng `be/.env`/`be/keys`.
- Đóng DEBT-169/172; mở 🟡 DEBT-173 (race check-then-write seed với client confidential, heuristic miễn fe-admin, AT public `aud=admin` cũ còn qua `AdminTokenGuard`). Cổng → **senior-reviewer** (lượt 2).

## senior-reviewer — 2026-10-19 (lượt 2)
- **PASS** (không 🔴) — mục "lượt 2" trong `review-senior.md`. Tự chạy (vg-test-*): typecheck ✅, unit **262/262**, int **697/697** (3 PoC tester `seed-risk*` xanh, không sửa). Probe tạm `be/test/zz-review-probe.int-spec.ts` (DB tự drop, file đã xoá). Không E2E, không seed DB dev, không đụng `be/.env`/`be/keys`.
- Kiểm: guard seed trước mọi ghi, quét referrer mọi tenant; `adminTargetForbidden` ở `/authorize`/consent/code/refresh (refresh dùng chung allowlist đã lọc cho `rotate` ⇒ không burn); `clientType` lạ (`'Confidential'`) ⇒ 400 `invalid_target`; env: `envSchema` không strict ⇒ e2e/`be/.env` cũ còn `ADMIN_SEED_PASSWORD` vẫn boot.
- DEBT-173 (3) probe xác nhận AT cũ public+admin ⇒ `/admin/me` 200 (+ `/introspect` active). Đánh giá 🟡 không 🔴: sau fix không còn đường phát hành; đường tenant_admin duy nhất (seed re-point) là mã mới chưa từng deploy; dư ≤ `ACCESS_TOKEN_TTL`. Khuyến nghị fold 2 dòng vào `AdminTokenGuard` khi chạm lại.
- 🟡 mở DEBT-174 (predicate khoá `clientType` trong khi client auth khoá `tokenEndpointAuthMethod`; probe bản ghi DB lệch confidential+`none` ⇒ AT `aud=admin` không secret 200), DEBT-175 (ponytail). Cổng → **tester** (retest run 30).

## tester — 2026-10-19 (retest, lượt 2)
- **PASS** — mục "Lượt 2" trong `test-report.md`. Chạy thật: typecheck ✅, lint ✅, unit **262/262**, int **697/697** (3 PoC `seed-risk*` xanh, không sửa) rồi **705/705** sau khi thêm spec tester, FE 240/240, E2E **12/12** (:5173/:4000 trống trước/sau, không dừng process nào). Không chạy seed trên DB dev, không đụng `be/.env`/`be/keys`, không compose up/FLUSH.
- Biến thể mới `be/test/admin-target-risk.int-spec.ts` (8): `clientType` lạ (thiếu/''/'Public'/'CONFIDENTIAL'/'confidential ') ⇒ `invalid_target` fail-closed; auto-approve (consent cũ + session, có/không `prompt=none`) ⇒ không code; `resource` lặp ⇒ không AT admin; guard re-point seed với referrer tenant khác ⇒ throw, 0 ghi. Mutation M1 (không fail-closed) 5 đỏ, M2 (bỏ chốt authorize) 6 đỏ, M3 (bỏ guard seed) 1 đỏ; khôi phục cp + sha256 khớp.
- CLI `db:seed` ma trận env (dist) 33/33: thiếu `ADMIN_SEED_PASSWORD` nay lỗi từ zod seed (`is required`), 11/129 ⇒ exit 1, biên 12/128 ⇒ exit 0; CLI re-point có referrer public ⇒ exit 1, 0 ghi; không lộ password. `.env.example` copy (rỗng / bỏ dòng / env cũ có giá trị) ⇒ qua validation; đối chứng thiếu `CSRF_SECRET` ⇒ exit 1.
- 🟡 mở DEBT-176: 2 CLI song song trên DB chưa `db:sync-indexes` ⇒ nhân đôi user super_admin/fe-admin/resources (4/6 vòng); có index ⇒ chỉ credential (DEBT-164). Không chặn (README yêu cầu sync-indexes, dev|test). Cổng → **orchestrator** đóng run 30.


## orchestrator — 2026-10-19 (đóng run)
- Phiên trước bị ngắt giữa backend-dev; orchestrator xác nhận không có mutation treo rồi giao resume. Mọi cổng PASS. Commit `e950419`.
