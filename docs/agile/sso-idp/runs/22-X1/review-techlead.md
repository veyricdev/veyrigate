# Tech Lead Review — 2026-10-14
## Kết luận: PASS (kèm chỉnh sửa — đã fold vào `tasks.md` mục "Chốt tech-lead")

## Kiến trúc đề xuất (nếu cần điều chỉnh)
- Giữ monolith BE + 2 SPA; E2E là package workspace `e2e/` độc lập (không service mới, không container mới).
- Cô lập dữ liệu theo **namespace**, không theo dọn dẹp: Dev = Mongo `sso-idp` + Redis `/1`; E2E = Mongo `sso-idp-e2e` + Redis `/2`. Không bao giờ FLUSH/drop.
- BE trong E2E chạy từ `dist` (`build → db:sync-indexes → db:seed-dev → start`), readiness qua `GET http://127.0.0.1:4000/ready`.

## Quyết định
| Q | Chốt | Căn cứ code |
|---|---|---|
| Q-X1-a | Package `e2e/`; script `e2e` (KHÔNG tên `test`); root `pnpm e2e` | root `pnpm test` = `pnpm -r run test` trong job `quality` → script `test` sẽ kéo Playwright + webServer vào CI quality |
| Q-X1-b | `DEV_SEED_EMAIL/PASSWORD`, chỉ đọc trong `seed-dev.ts`, không vào `envSchema`; cấm trùng `ADMIN_SEED_EMAIL`; upsert `UserTenant` default, `roles: []` | plan D6/B6.4: admin = `UserTenant.roles` `super_admin`/`tenant_admin` → không tái dùng; `register()` luôn `addMembership` (`authentication.service.ts:80`), `TenantGuard` cần membership active |
| Q-X1-c | Redis DB index qua URL (dev `/1`, E2E `/2`); Mongo E2E `sso-idp-e2e` | `new IORedis(redisUrl, …)` (`redis.module.ts:45`) parse `/N`; Lua qua `defineCommand` (script cache theo server); 0 pub/sub/`duplicate`/`SELECT` → an toàn. `aegate-redis` db0 hiện có 13 key của project khác |
| Q-X1-d | CI Mongo **single-node**, không `--replSet` | grep `startSession`/`withTransaction` = 0 → YAGNI |

Phân công: **T1 backend-dev**; **T2–T5 frontend-dev**. Thứ tự: T1 ∥ T2 → T3 → T4 → T5.

## Bổ sung DEBT-084 (2026-10-14) — fold thành Task 6 [BE]
- **Kết luận: PASS — chốt phương án (a) CSP `form-action` theo từng response**; giao **backend-dev T6**; T4/T5 chờ T6.
- Đối chiếu code: helmet global `form-action 'self'` (`main.ts:52`). 3 trang render form dẫn tới redirect RP: `GET /login` (`ui.controller.ts:96`; POST → `/authorize?request_id` → RP), consent (`authorize.controller.ts:147`; POST → RP qua `decideConsent`), `GET /logout` (`ui.controller.ts:128`; POST → `post_logout_redirect_uri`). Comment DEBT-015 (`authorize.controller.ts:45`) và việc đóng DEBT-015 dựa trên int-test không chạy browser → sai trên Chromium.
- Vì sao (a): header CSP của **trang chứa form** quyết định; server đã có URI exact-match cho cả 3 trang (ctx Redis qua `request_id`; outcome consent; `resolvePostLogoutRedirect`). Tiền lệ override CSP per-response: `renderFrontchannel`.
- Loại (b): `code` lộ trong HTML trung gian (bfcache/back/cache), thêm hop + phụ thuộc JS/click, phá semantics 302 của nhiều int-test. Loại (c): mất phòng thủ exfil form khi có injection.
- Điểm bắt buộc (chi tiết trong T6): `peek()` không DEL/không gia hạn ctx; chỉ nhận returnTo đúng dạng `/authorize?request_id=…`; origin chỉ từ URI đã exact-match + `safeCspOrigin` lớp 2; directive khác y hệt global qua `buildCsp()` dùng chung với frontchannel; Redis lỗi ⇒ `'self'` (fail-closed); test CSP theo route + E2E X1 xanh.
- Cổng security design: đủ (asset/actor/boundary, invariant INV-084-1..3, abuse: link attacker/enumeration/header injection/replay ctx, failure Redis/client hỏng, acceptance âm 2/4/6/7).
- Backlog: DEBT-085 (federation B5 — nút social không được là form POST nếu không thêm origin provider tĩnh).

## Điểm mạnh
- Phạm vi đúng X1 (plan §8): 1 kịch bản, chỉ Chromium, Mailpit để X2.
- Invariant bảo mật từng task rõ (fail-closed production, token không vào DOM/URL/storage, không echo `error_description`).
- DEBT-078/079/080 mô tả đúng vị trí code và có test âm cụ thể.
- Nhận diện đúng hạ tầng dùng chung và cấm FLUSH.

## Vấn đề (đã fold — dev bắt buộc làm theo, không cần quay lại analyst)
- [x] T1 thiếu `UserTenant` membership → user dev khác user đăng ký thật; sẽ 403 ở mọi route `TenantGuard`. Fold: upsert membership `roles: []`.
- [x] T1 đề xuất tái dùng `ADMIN_SEED_*` → rủi ro leo quyền khi B6.4 gán role theo biến này. Fold: `DEV_SEED_*` + chặn trùng admin email.
- [x] T1 upsert phải reset `failedLoginCount`, `$unset lockedUntil`, `$min emailVerifiedAt` để E2E lặp lại không bị khoá sau 1 lần chạy fail.
- [x] T3 `start:dev --watch` + `db:seed-dev` cần `dist/` (hiện chưa có) → đổi chuỗi build/sync-indexes/seed/start; readiness `/ready` thay discovery (discovery 200 cả khi Redis chết).
- [x] T3 `reuseExistingServer` local mặc định sẽ chạy E2E trên BE dev (DB dev) → mặc định `false`, opt-in `E2E_REUSE=1`.
- [x] T3 `fe-sso-test/.env` không tồn tại → `webServer.env` phải cấp `VITE_OIDC_*`.
- [x] T3 cookie `Secure` mặc định `true` (`validation.schema.ts`) → E2E bắt buộc `SESSION_COOKIE_SECURE=false`; dùng host `localhost` nhất quán (redirect_uri/CORS so khớp chính xác; :5173↔:4000 same-site nên `SameSite=Lax` ổn).
- [x] T2/T4 kỳ vọng claim `email` — ID token KHÔNG có `email` (`signIdToken`: sub/aud/iss/exp/iat/amr/acr/nonce). Fold: render `sub/iss/aud/exp`.
- [x] T4 assert "token không trong DOM" cần đo được → lấy token thật từ response `/token` rồi assert vắng mặt trong content/URL/Web Storage.
- [x] T4 consent: CI DB sạch luôn có màn consent; local lần 2 không → rẽ nhánh xác định, không sleep.
- [x] T4 trace Playwright ghi giá trị `fill` (password) → chỉ `retain-on-failure` ở CI với credential giả; local `off`.
- [x] T5 CI cần full env `envSchema` (giá trị giả trong `env:`, không GitHub secrets); `retries: 0`; upload report khi fail.

## Kiểm tra cổng security design
- Tài sản/actor/trust boundary: có (credential dev, token, logout state; env→seed→Mongo; IdP→FE query). Bổ sung: user dev **không** có role (non-admin), tách khỏi admin seed.
- Invariant/state: seed fail-closed production trước connect; flow anonymous→login→session cookie→code→token in-memory.
- Abuse: replay code (BE đã có, ngoài phạm vi), refresh race (DEBT-078), logout state sai/lặp (DEBT-079), content-spoofing `error_description` (DEBT-080), nhầm DB dùng chung (namespace + cấm flush).
- Failure: Mongo/Redis không sẵn sàng → `/ready` ≠ 200 → webServer timeout fail rõ; cổng bận → fail (strictPort, no reuse).
- Exposure: password không vào log/stdout/trace/report/commit; token không vào DOM/URL/storage — có test âm đo được (T4).

## Đề xuất (không bắt buộc)
- T1 int-test dùng `vg-test-mongo@27117` DB riêng như `seed-dev.int-spec.ts` hiện có; kiểm: 2 lần chạy → 1 user + 1 membership, roles rỗng, trùng admin email → throw.
- Cập nhật `be/.env` local của người dùng sang `REDIS_URL=redis://localhost:6379/1` (người dùng tự sửa — agent không in/ghi secret).
- Backlog: DEBT-082 (seed ghi đè password nếu email đã đăng ký tay — dev-only, xử lý khi gộp B6.4/DEBT-077); DEBT-083 (bật `--replSet` CI khi xuất hiện transaction).