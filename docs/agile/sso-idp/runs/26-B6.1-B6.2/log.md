# Log — run 26 — B6.1 + B6.2 (admin guard, step-up) + DEBT-098/105/106

## orchestrator — 2026-10-16
- Người dùng: "chạy tất cả đến khi tôi bảo dừng". M4 xong (run 25) ⇒ mở M5 lane BE. spec/plan có sẵn ⇒ không gọi analyst; sinh `tasks.md` từ plan §B6 (B6.1, B6.2) + DEBT-098/105/106 [BE]. Cổng → tech-lead.

## tech-lead — 2026-10-16
- **PASS** (vòng 1) kèm fold bắt buộc trong `tasks.md` mục "Fold tech-lead". Review: `review-techlead.md`.
- Phát hiện lỗi thật: `prompt=login`/`max_age` khi đã có phiên dead-end ở `GET /login` (redirect `/`), `resume()` bỏ `prompt`/`max_age`. Fold sửa vào Task 2 (`reauthAfter` trong AuthorizeRequestContext).
- Q-26.1: vai trò `super_admin`/`tenant_admin`, scope `admin.read`/`admin.write` (D6). Q-26.2: hằng 5' theo decorator. Q-26.3: `NODE_ENV` bắt buộc.
- Backlog mới: DEBT-116 (authorize không kiểm membership tenant), DEBT-117 (A5 so `sub` sau step-up), DEBT-118 (2 kiểu dựng resource identifier).
- Chuyển → **backend-dev** (Task 1 → 2, Task 3, 4).

## backend-dev — 2026-10-16
- Security trước code: tài sản = admin API (control-plane); actor = user có/không vai trò, member tenant khác, client tenant khác; abuse = token resource khác/ID token/không `sid`/sau logout, tenant qua query/body/header, gọi thẳng `/authorize?request_id` né re-login, `auth_time` cũ/tương lai/thiếu (refresh); failure = Mongo/Redis lỗi ⇒ 5xx; exposure = `/admin/me` chỉ `{sub,tenantId,roles}`, `no-store`, lỗi mờ.
- T1: `AdminTokenGuard` + `@AdminScope` + `@AdminRoles` trong `tenant-context.ts` (brand không export), `AdminAuthError`+filter (`admin-auth.errors.ts`), `UserTenantService.activeRoles`, `AdminModule` `GET /admin/me` (mount mọi env). Thứ tự bearer→verify→aud=`adminResourceIdentifier`→`sid` bắt buộc→liveness (client chụp 1 lần)→scope→membership active+vai trò của `client.tenantId`.
- T2: `StepUpGuard`/`@RequireRecentAuth(5)` (clock `STEP_UP_CLOCK`, skew +30s, 403 `{error:"step_up_required",max_age:0}`, không header 9470). Sửa lỗ hổng fold: `reauthAfter` trong context, `GET /login` render form khi context đòi re-auth (peek lỗi ⇒ 302 `/` như cũ), `resume()` từ chối `login_required` nếu `session.authTime < reauthAfter`/không phiên, `max_age=0` luôn reauth.
- T3: `NODE_ENV` bắt buộc (zod, không default); `seed-dev` allowlist development/test; README/.env.example/comment `demo.enabled`. T4: DEBT-105 (`rotate(..., allowedIdentifiers?)`), DEBT-106 (test fix tự tạo index cũ).
- Verify thật: typecheck ✓, lint ✓, unit 22 suites **220/220**, int 25 suites **539/539** (mới `admin.int-spec.ts` 29), fe-sso-test **240/240**, e2e typecheck ✓, `pnpm -C e2e e2e` **12/12**. Boot thật `AppModule` (spec tạm, đã xoá; DB tạm đã drop) ⇒ `/admin/me` 401 `invalid_token` + no-store.
- Mutation (RED→khôi phục byte-identical, cmp): bỏ aud(1 RED)/sid(1)/role(5)/tenant membership(1)/status(1)/scope(1); resume reauthAfter(2), `/login` luôn 302(2)/luôn form(2), future skew int(1)+unit(1), ngưỡng phút(1), isInteger unit(1); DEBT-105 RED 2 lần gọi; DEBT-106 RED khi bỏ createIndex.
- Backlog mới 🟡: DEBT-119 (đổi tên `assertNotProduction`), DEBT-120 (`GET /login` peek 2 lần). Đóng DEBT-098/105/106. Không commit. → **senior-reviewer**.

## senior-reviewer — 2026-10-16
- **REJECT** (vòng 1). Review: `review-senior.md`.
- 🔴 [BE] `POST /authorize/consent` (`decideConsent`) tiêu thụ được context có `reauthAfter` và cấp code bằng phiên cũ, bỏ qua `prompt=login`/`max_age` (INV-26, OIDC §3.1.2.1). Tái hiện bằng int-test probe tạm trên `vg-test-*`: kết quả 302 kèm `code` (file probe đã xoá). Sửa: kiểm `reauthAfter` trong `decideConsent` như `resume` (hoặc thêm `kind` cho context), kèm int-test và mutation.
- Đã kiểm OK: tenant lấy từ client, lỗi mờ, fail-closed 5xx, `/admin` không CORS + no-store, `/login` không open-redirect/loop, refresh/skew step-up, `NODE_ENV` (dev/Jest/E2E). Verify: typecheck sạch, unit 220/220.
- Backlog 🟡: DEBT-121 (nguồn clock `reauthAfter`), DEBT-122 (`kind` context). Không commit. Chuyển → **backend-dev** (Task 2).

## backend-dev (retry 1) — 2026-10-16
- Security trước code: tài sản = code/`auth_time` cho RP đòi `prompt=login`/`max_age`; actor = người giữ cookie phiên cũ; abuse = `request_id` context re-auth (hoặc login thường) POST vào `/authorize/consent`, `request_id` consent đi qua resume; failure = consume lỗi Redis vẫn propagate (không đổi); exposure = lỗi về RP chỉ `error`/`state`/`iss`.
- Sửa triệt để (đóng DEBT-122): `AuthorizeRequestContext.kind: 'login'|'consent'` (bắt buộc). `resume` chỉ nhận `login` (khác/thiếu ⇒ null ⇒ trang 400 first-party); `decideConsent` chỉ nhận `consent` (khác/thiếu ⇒ `AuthorizeRedirectError('login_required')` về redirectUri/state của ctx, không ghi consent, không audit, không code). Context đã consume ⇒ single-use. Cửa tiêu thụ theo `request_id` chỉ có 2 (đã rà; `peek` ở `/login` chỉ đọc). Context cũ không `kind` (TTL ≤10') bị cả 2 cửa từ chối (fail-closed).
- Test mới: admin int "bypass via POST /authorize/consent" (302 `error=login_required`, state, không code, spy `grant` 0 lần, consent/resume lần 2 ⇒ 400); authorize int "consent request_id qua resume ⇒ 400 + đã consume", "login request_id thường POST consent ⇒ login_required, không consent". RED trước khi sửa: 302 có code (`error` null).
- Mutation (khôi phục byte-identical, sha256): bỏ check `decideConsent` ⇒ 2 RED; bỏ check kind ở `resume` ⇒ 1 RED.
- Verify thật: typecheck ✓, lint ✓, unit 22 suites **220/220**, int 25 suites **542/542** (+3). Không commit. → **senior-reviewer** (lượt 2).

## senior-reviewer (lượt 2) — 2026-10-16
- **PASS**. Review: `review-senior.md` mục "Lượt 2".
- 🔴 lượt 1 đã đóng: `kind` (`login`/`consent`) bắt buộc trên context. `resume` chỉ nhận `login`, `decideConsent` chỉ nhận `consent` (kiểm trước deny/approve) ⇒ `login_required`, không consent/code. Rà lại: chỉ 2 cửa consume, `peek` chỉ đọc.
- Chạy lại repro lượt 1 (test admin int) và probe tạm (đã khôi phục, `sha256sum -c` OK): context re-auth + deny ⇒ `login_required`, không consent, replay 400; context cũ không có `kind` ⇒ cả 2 cửa từ chối; 4 POST đồng thời ⇒ đúng 1 302, không có `code`. Mutation của reviewer (tắt check `kind` ở consent) ⇒ 2 RED, khôi phục byte-identical.
- Verify: typecheck/lint sạch, unit 220/220, int 25 suites 542/542. Không hồi quy phần lượt 1.
- Backlog 🟡: DEBT-123 (gắn `sessionRef` vào context consent; cùng cơ chế giải DEBT-121). Không commit. Chuyển → **tester**.

## tester — 2026-10-16
- **PASS**. Báo cáo: `test-report.md`.
- Chạy thật: BE typecheck/lint sạch, unit 22 suites **220/220**, int 25 suites **554/554** (542 dev + 12 tester), fe-sso-test **240/240**, E2E **12/12** (×2). DEBT-106 chạy riêng `-t` xanh, DEBT-105 `-t` xanh. Boot `dist/main.js` thiếu/rỗng `NODE_ENV` ⇒ exit 1, message nêu `NODE_ENV`.
- Test mới (`admin.int-spec.ts` › "tester risk matrix (run 26)", 12 test): token hết hạn / bị sửa payload / ký bằng khoá lạ / nằm ở query hoặc dùng scheme Basic ⇒ 401; user bị xoá ⇒ 401; sai scope (read↔write, lookalike) ⇒ 403 (`insufficient_scope` đứng trước step-up); positive control tenant B; body lỗi không lộ tenant/sub/roles; 5 resume đồng thời ⇒ đúng 1 code; cookie cũ sau re-login không lấy được code.
- E2E lần đầu fail 1/12 (`lab.spec.ts:10`, có từ run 25): race giữa `waitForResponse` và `load` ⇒ URL chưa commit. BE vẫn trả 400 đúng. Đã sửa trong test (chờ `toHaveURL` + heading). Không phải lỗi [BE]. Không mở debt mới. Không commit. → **orchestrator** đóng run.

## orchestrator — 2026-10-16 (đóng run)
- Mọi cổng PASS. Commit `7321765`. summary.md + dòng Tiến độ STATUS.md; 🟡 đã ở backlog.
