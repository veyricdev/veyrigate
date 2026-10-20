# Tech Lead Review — 2026-10-20

> Run 36 (B7.1c). Đối chiếu code `develop` @ `29c1a45` qua CodeGraph: `TokenController` (`handleAuthorizationCodeGrant`, `recheckCodeGrant`, `handleRefreshGrant`), `RefreshTokenService.issueForRefresh/rotate/revokeFamily`, `AuthenticationService.login`, `FederationService.callback/completeLink/loginExisting`, `SessionService.establish/revoke/revokeRef`, `AuthorizeService.assertMember/decideConsent`, `AuthorizeController.buildErrorRedirect/buildRedirect`, `UserService.clearFailedLoginsIfUnlocked` + `ADMIN_LOCKED_UNTIL`.

## Kết luận: PASS (kèm fold G0–G8 trong `tasks.md`)

Plan đúng vấn đề (đóng nốt DEBT-207/210/211/213, phần còn lại của DEBT-116/141/156/187), khả thi trên code hiện có, không cần đổi schema hay thêm module. Có một abuse case chưa được nêu (khoá brute-force do kẻ tấn công kích ⇒ giết family refresh). Lỗ này sửa gọn được bằng fold G1, không cần quay lại analyst.

## Kiến trúc đề xuất (điều chỉnh)

- **Refresh (G4).** Không inject thêm `ClientService/UserService/UserTenantService` vào `RefreshTokenService`. Thay vào đó `issueForRefresh` nhận callback **bắt buộc** `recheck(userId)`, gọi ngay sau `rotate` và trước sign. `TokenController` cung cấp logic, dùng chung `subjectFailure` với code grant. Lý do: một nguồn sự thật cho "user/membership còn hợp lệ", không trùng logic giữa hai lớp, không đụng DI của khoảng 18 int-spec đang liệt kê `RefreshTokenService`.
- **Login (G5, trả lời Q-36.1).** Kiểm lại trong service, ngay sau `establish`: `AuthenticationService.login` và `FederationService.callback`. Link (`completeLink`) đi qua `login` nên tự được phủ. Khi khoá: `sessions.revoke(established.id)` (tombstone) + lỗi chung hiện có (401 `GENERIC_LOGIN_ERROR` / trang `account_locked`).
- **Q-36.2.** Phạm vi vừa 1 run. Fixture refresh chỉ phải sửa ở test mong 200 (khoảng 17 userId ngẫu nhiên trong `refresh-token`/`client-auth-rate-limit`). Helper `seedOAuthUser` đã có từ run 35.

## Điểm mạnh

- Thiết kế T4 run 35 vẫn đúng với code: thứ tự "ghi trước, đọc lại sau" khớp phía huỷ (admin lock ghi `lockedUntil` rồi `revokeAllUserCredentials`; disable ghi `disabledAt` rồi `revokeForClient`). Vì vậy không interleaving nào để lọt family/session.
- `revokeFamily` đã stamp `familyRevokedAt` trước `updateMany`, nên revoke sau `rotate` cũng đóng được race với rotate đồng thời (INV-11).
- `SessionService.create` `sadd` index user trong cùng MULTI, nên `sessionRevokeAll` của admin lock chạy sau post-check vẫn quét được session mới.
- DEBT-211 sửa nhỏ: deny và not_member cùng thứ tự tham số `error, state, iss` khi bỏ `error_description`, nên so byte-identical được.

## Vấn đề (đã fold, dev bắt buộc làm theo; không REJECT)

- [x] **G1. Abuse case lockout (bảo mật, mức cao).** Nếu refresh dùng `lockedUntil > now` như `recheckCodeGrant` hiện tại thì kẻ tấn công biết email chỉ cần 5 lần sai mật khẩu là kích lock tạm. Khi đó mọi refresh của nạn nhân trong cửa sổ lock sẽ revoke cả family (Q35.3). Hơn nữa, sau `rotate` token cũ đã bị tiêu, nên kể cả chỉ "từ chối, không revoke" thì family cũng chết. Lock tạm theo thiết kế không quét session/family. Quyết định: grant (code + refresh) chỉ coi **khoá admin** (`ADMIN_LOCKED_UNTIL`) hoặc user mất là `user_locked`. Login vẫn chặn mọi khoá. Có test âm cho khoá tạm và mutation.
- [x] **G4.** Plan cũ để ngỏ chỗ đặt kiểm và audit. Đã chốt: callback bắt buộc, audit `TOKEN_REFRESHED failure reason` (không thêm enum), lỗi hạ tầng thì revoke best-effort + 500.
- [x] **G2/G3.** Đã chốt hình dạng helper DEBT-213 (biến thể `session_ended` dùng `revokeFamilyForEndedSession`) và predicate resource DEBT-210 (cùng `decideConsent`: `adminTargetForbidden` + `resolveForClient` theo `resourceId`, reason `resource_not_allowed`). `TokenController` cần inject `ResourceService`.
- [x] **G5.** Post-check login không được tăng counter, không được ghi `AUTH_LOGIN_SUCCESS`/`SESSION_CREATED`. Lỗi DB thì revoke best-effort rồi 500.
- [x] **G6.** `errorDescription` của `AuthorizeRedirectError` thành optional, `assertMember` không truyền mô tả.

### Cổng security design

- **Tài sản / actor / boundary:** refresh family, session IdP. Actor: user bị khoá admin, user mất membership `active` ở `client.tenantId`, client bị disable, admin đồng thời, kẻ tấn công kích lockout (G1). Tenant lấy từ client đọc lại (INV-24).
- **Invariant:** sau khi lock admin / disable / suspend hoàn tất, không còn family hay session mới nào sống, bất kể interleaving. Khoá tạm không làm mất grant.
- **Abuse cases:** race lock/disable/suspend (spy gọi bản gốc rồi đổi trạng thái), replay token cũ sau khi bị từ chối (vẫn `invalid_grant`), enumeration (body byte-identical, login thông điệp chung), DoS lockout (G1).
- **Failure semantics:** Mongo/Redis lỗi khi đọc lại ⇒ refresh revoke best-effort + 500; login revoke session best-effort + 500, không cookie. Audit refuse thì best-effort khi revoke ném (DEBT-067).
- **Exposure:** audit chỉ có reason, `resource`, `familyId`; không token/hash/mật khẩu. RP chỉ thấy `invalid_grant` / `access_denied` không mô tả.

## Đề xuất (không bắt buộc)

- DEBT-214 (mới): refresh không kiểm consent theo thiết kế, nên khi bump `policyVersion`/`termsVersion` thì family cũ vẫn refresh được. Cần quyết định nếu chính sách yêu cầu re-consent.
- Sau run này có thể gộp `subjectFailure` vào chỗ khác nếu introspect/userinfo cần cùng ngữ nghĩa. Hiện chưa cần, không làm.
