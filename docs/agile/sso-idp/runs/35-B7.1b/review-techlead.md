# Tech Lead Review — 2026-10-20

Run 35 (B7.1b), `tasks.md` do analyst viết. Đối chiếu code `develop` @ `b2694ee` qua CodeGraph: `AuthorizeController.handle/consent/handleError`, `AuthorizeService.handle/resume/decideConsent/resolveResource/parsePrompt`, `TokenController.handleAuthorizationCodeGrant`, `TokenService.issueForAuthorizationCode`, `RefreshTokenService.issueForRefresh/rotate/revokeFamily`, `AuthenticationService.login/revokeAllUserCredentials`, `FederationService.loginExisting/completeLink`, `SessionService.establish/revoke`, `UserTenantService`, `ConsentService.find/isCovered/grant`, `ClientService.findByClientId`, `OauthModule`, `IdentityModule`, fixture trong `be/test/*.int-spec.ts`.

## Kết luận: PASS (kèm fold, phạm vi thu hẹp)

Không có blocker. Thiết kế đúng vấn đề và đúng với code thật. Đã fold chỉnh vào `tasks.md` mục "Fold tech-lead" (F0–F9). Điều chỉnh lớn nhất là phạm vi: **run 35 = T1, T2, T3, T5. T4 tách sang run 36 (DEBT-207).**

## Kiến trúc đề xuất (nếu cần điều chỉnh)

- Giữ modular monolith, không thêm module. `OauthModule` import `IdentityModule` (không vòng, IdentityModule chỉ import SessionsModule).
- **Không tạo class provider mới** cho kiểm lại code grant. Lý do: khoảng 15 int-spec tự liệt kê `providers`, mỗi class mới buộc sửa tất cả. Dùng method private trong `TokenController` (F2).
- Mẫu "phía huỷ ghi trạng thái trước rồi quét, phía cấp insert trước rồi đọc lại" đã kiểm trên code: disable (`disabledAt` ⇒ `revokeForClient`), lock (`lockedUntil` ⇒ `revokeAllUserCredentials` gồm pre_revoke/sessions/sweep), revoke consent (`revokeById` ⇒ `revokeForConsent`). Lập luận đúng, không cần lock phân tán.

## Điểm mạnh

- Ranh giới tin `redirect_uri` của T1 khớp code: Phase 1 dùng `AuthorizeErrorPage`, Phase 2 dùng `AuthorizeRedirectError` và catch gắn `redirectUri/state`. Chặn `client_id` mảng trước `findByClientId` để Mongoose không cast sang `$in`.
- T2 lấy tenant chỉ từ client document và không tự cấp membership, đúng §9.10/INV-24. Kiểm lại ở POST consent xử lý race giữa render và submit.
- T3 gom kiểm lại về một chỗ sau insert family, đặt sau khối kiểm session INV-29 có sẵn. Body `invalid_grant` giống hệt từng byte, lý do chỉ ghi ở audit.
- Cổng security design đủ cho T1–T3: tài sản, actor, invariant, state, abuse (IDOR cross-tenant, race, enumeration, replay qua single-use), failure fail-closed, exposure. Mỗi kiểm có test âm và mutation.

## Vấn đề (đã fold, dev làm theo `tasks.md` § Fold tech-lead)

- [x] **F0 Phạm vi**: T3 kiểm `user_locked` (`findById` null ⇒ fail) và `not_member` nên mọi test đổi code bằng `userId` ngẫu nhiên sẽ đỏ. Ước lượng: `token.int-spec` (33 lần mint code, 12 userId ngẫu nhiên), `refresh-token.int-spec` (13 + 15), `session-reflection`, `client-auth-rate-limit`, `admin-*`. Analyst chưa tính phần này, chỉ tính ~55 chỗ tenant ở T2. T4 còn kéo thêm authentication/federation và các family insert trực tiếp. ⇒ Tách T4 sang run 36 (DEBT-207).
- [x] **F1 Fixture**: thêm một helper `be/test/oauth-fixtures.ts` `seedOAuthUser(...)` tạo User + UserTenant thật. Chỉ thay userId ở các test đi qua code grant hoặc `/authorize` có session.
- [x] **F2 DI**: thêm `IdentityModule` vào `OauthModule`. Inject `UserTenantService` vào `AuthorizeService`. Inject `ClientService/UserService/UserTenantService/ConsentService` vào `TokenController`. Sửa các int-spec tự liệt kê providers và `new AuthorizeService(...)` trong `authorize.int-spec`.
- [x] **F3 T1**: định nghĩa rõ helper (undefined hợp lệ). `/authorize/consent` (`@IsString()`) và `/token` (`parseForm` từ chối tham số lặp) đã an toàn, không đụng.
- [x] **F4 T2 audit**: hiện tại `recordAuthorize` luôn ghi `result:'success'`, nên nhánh `not_member` ghi như vậy sẽ sai về ngữ nghĩa với cảnh báo bảo mật. ⇒ `result:'failure'`, `reason:'not_member'`.
- [x] **F5 T2 decideConsent**: kiểm đặt sau re-resolve client và trước `grant`, dùng `tenantId` của client vừa đọc lại.
- [x] **F6/F7 T3**: nếu revoke trong nhánh fail bị ném thì vẫn ghi audit (mẫu DEBT-067). Ghi nhận tương tác: `consent_revoked` bắt luôn trường hợp client mất scope giữa render và POST consent (fail-closed, đúng ý). Spy race gọi bản gốc trước rồi mới đổi trạng thái.
- [x] **F8 T5**: sửa acceptance ma trận và trạng thái DEBT-116/141/156 theo phạm vi mới.

## Quyết định Q35.1–Q35.6

| # | Kết luận |
|---|---|
| Q35.1 | Chấp nhận: 302 `access_denied` + `state` + `iss`, kiểm trước consent và trước `prompt=none ⇒ consent_required`. `redirect_uri` đã tin, mã trùng với user tự từ chối nên không lộ lý do. |
| Q35.2 | Chấp nhận: không tự cấp membership (§9.10 "dưới bất kỳ hình thức nào"). Seed dev và E2E đều dùng `default-tenant` nên không hồi quy. Mở DEBT-208 (admin API thêm member). **Báo người dùng biết** hệ quả: client ở tenant khác `default-tenant` chỉ dùng được khi membership tạo bằng seed/DB. |
| Q35.3 | Chấp nhận mặc định (revoke cả family), áp dụng ở run 36 cùng T4. |
| Q35.4 | Chấp nhận: giữ `invalid_target` (RFC 8707 §2, không làm hồi quy INV-15). |
| Q35.5 | Chấp nhận: `isCovered` đầy đủ. Version lấy từ env nên chỉ đổi khi deploy/restart, ảnh hưởng ≤60s. |
| Q35.6 | Chấp nhận residual, ghi DEBT-209. |

Không mục nào cần người dùng quyết định.

## Đề xuất (không bắt buộc)

- DEBT-210: code grant chưa kiểm lại `data.resource` còn thuộc `allowedResources` (refresh đã kiểm). Một nhánh cùng mẫu DEBT-128, nên làm cùng run 36.
- Run 36 (T4): đặt kiểm lại refresh **bên trong** `issueForRefresh` sau `rotate`, trước sign và trước audit `TOKEN_REFRESHED success`. Đặt ở controller sẽ để lại audit success giả (mẫu DEBT-059). Kiểm lại login đặt trong `AuthenticationService.login` sẽ phủ luôn `FederationService.completeLink` (đang gọi `login`).

## Phạm vi cuối run 35

T1 (DEBT-204/205), T2 (DEBT-116 authorize/consent, MT1/MT2/24b, kèm helper fixture), T3 (code grant: DEBT-116 /token, 128, 144, 156 race, 141 phần code), T5 (ma trận + backlog + toàn suite). T4 sang run 36 (DEBT-207). Debt mới: DEBT-207…210.
