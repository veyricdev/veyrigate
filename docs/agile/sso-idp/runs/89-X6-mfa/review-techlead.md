# Tech Lead Review — 2026-11-12

Phạm vi: fold run 89 `89-X6-mfa` (outline run 88 + D88.23–D88.29) trên `develop` HEAD `de14146`. Đã đọc `STATUS.md`, `runs/88-X6-release3/{tasks.md, review-senior.md}`, `release-checklist.md` (C-6.3.3, C-6.3.4, C-6.4b, C-6.5, E-334), backlog DEBT-579/334/622–632, và code qua CodeGraph + đọc đích: `authentication.service.ts` (`login`, `verifyCurrentPassword`), `login-throttle.service.ts` (`LoginBuckets`, `onSuccess`), `federation.service.ts` (callback + link), `session.service.ts` (`create`/`establish`/`revokeByDevice`/`findOwned`), `authorize.service.ts` (`handle`/`resume`/`issueCode*`), `token.service.ts` + `token.controller.ts` (`recheckCodeGrant`, refresh re-check, `adminTargetForbidden`), `refresh-token.schema.ts`, `account.controller.ts`, `session-revoke.ts`, `ui.controller.ts`, `admin-users.controller.ts`, `admin-recover.ts`, `user.schema.ts`, `validation.schema.ts`, `be/test/full-app.ts`, `e2e/tests/support/{admin,fe-admin}.ts`, `e2e/playwright.config.ts`.

## Kết luận: PASS

Khả thi trên code hiện có, không thêm dependency hay container. Điều kiện là làm theo bản fold (`tasks.md`), vì bản fold sửa 6 chỗ outline/D88 không khớp code (xem "Vấn đề"). Chia 4 lô A→D, có senior review sau lô B và lô C. DEBT-334 ra khỏi run (D89.1). Các điểm mở đã chốt thành D89.1–D89.24.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

- Giữ **modular monolith**. Thêm một module `mfa/`: phần thuần (TOTP, base32, keyring AES-GCM, mã khôi phục), `MfaService` lưu trạng thái ở Mongo (CAS) và `MfaLoginService` quản lý vé Redis cùng bước hoàn tất chung. Route HTML nằm ở `ui/mfa.controller.ts`, dùng `UiSessionHelper` (DEBT-632).
- **Một bước hoàn tất chung cho cả 3 đường tạo phiên** (`/login`, callback federation, `/auth/link`). Re-check sau `establish` (khoá, `pwdFp`, `enrolledAt`) chỉ viết một lần, không chép vào từng đường.
- **Cổng `admin` là một predicate** (`adminMfaSatisfied`, D89.5), kiểm ở 3 điểm: `/authorize`, `/token` code, refresh. Predicate dựa trên `mfaAt ≥ user.mfa.enrolledAt`, không dựa vào việc "family thừa hưởng". Nhờ vậy family có trước deploy và phiên có trước một lần reset đều fail-closed, mà CLI không phải chạm Redis.

## Điểm mạnh

- D88.23–D88.29 đã chọn đúng hướng: TOTP + mã khôi phục, không SMS. Bắt buộc theo resource thay vì theo vai trò, CAS `lastStep` chống replay giữa các instance, khoá ở env (backup lộ không lộ seed), reset mật khẩu không gỡ MFA.
- Nền đã có: `revokeAllUserCredentials`, bucket `pwc:` có reserve/refund, mẫu `RequireRecentAuth(5)` + `assertMayTouchAccount`, transaction `SuperAdminGuard` của CLI, `safeReturnTo`, CSRF identity theo cookie, harness E2E chạy `workers: 1`.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các lệch giữa outline/D88 và code đã sửa trong fold, ghi lại để dev không làm theo mô tả cũ:

- [x] Outline chỉ nêu 2 đường đăng nhập. Code có đường thứ 3, `/auth/link`, đi qua `auth.login` rồi mới `identities.link`. Nếu bỏ qua thì người chỉ có mật khẩu sẽ gắn được Google của mình vào tài khoản có MFA ⇒ D89.14 (không liên kết khi đã enroll), T3 AC9, DEBT-633.
- [x] D88.24 "refresh family thừa hưởng vì chỉ sinh từ code" sai với family có trước deploy (không có trường nào để phân biệt) ⇒ `RefreshToken.mfaAt`, family cũ bị `invalid_grant` (D89.5, T3 AC13, deploy bước 4).
- [x] D88.24 "nâng `amr` trên phiên hiện có" không có chỗ trong `establish` (luôn tạo id mới). Ca này cũng chỉ còn là race vì enroll/reset đều revoke-all ⇒ bỏ, thay bằng đăng nhập lại (D89.6).
- [x] `admin-recover --reset-mfa` là CLI chỉ dùng Mongo, nên không thu hồi được phiên Redis. Phiên cũ (`amr ∋ mfa`) vẫn mở được console sau khi reset ⇒ thêm điều kiện `mfaAt ≥ enrolledAt` vào predicate (D89.5/D89.17), phần còn lại ghi DEBT-634.
- [x] D88.27 không nói lúc nào xoá bucket đăng nhập / cấp thiết bị tin cậy. Nếu làm ở bước 1 thì kẻ có mật khẩu được reset bucket và được tin thiết bị mà chưa qua yếu tố 2 ⇒ hoãn `onSuccess` tới khi xong bước 2, bucket lưu trong vé (D89.7, T3 AC1/AC2).
- [x] D88.28 "tắt MFA = mật khẩu + TOTP" là ngõ cụt với tài khoản chỉ federation ⇒ D89.23 (phiên < 5' + TOTP).
- [x] E2E: `adminToken` cấp token `resource=admin` cả cho **user thường** (`E2E_USER`, mục tiêu khoá), và có khoảng 40 lần đăng nhập admin. Luật replay giới hạn khoảng 1 lần/30 s/user ⇒ seed enroll cả `E2E_USER`, bộ cấp bước tận dụng cửa sổ ±1, ngân sách thời gian đo được và có sẵn biện pháp (D89.20/D89.21).
- [x] Bật cổng mặc định ở int sẽ phải sửa khoảng 46 file tạo phiên trực tiếp, mà không thêm bằng chứng nào ⇒ harness int đặt `ADMIN_MFA_REQUIRED=false` (cùng tiền lệ `KEY_PREPUBLISH_SEC=0`); spec cổng riêng, E2E và X3 chạy `true` (D89.4).
- [x] Run quá lớn nếu giữ cả DEBT-334 (thêm 2 endpoint đọc + màn fe-admin, không thuộc dòng ❌ nào) ⇒ chuyển ra sau phát hành (D89.1).

## Đề xuất (không bắt buộc)

- Khi đóng run, orchestrator chép D89.1–D89.24 vào `plan.md` §12 và cập nhật `spec.md` §4 ("MFA-ready" ⇒ TOTP + mã khôi phục, bắt buộc cho resource `admin`) cùng §10 (`User.mfa`, `RefreshToken.mfaAt`).
- Backlog mới (đã thêm): DEBT-633 liên kết federation cho tài khoản có MFA; DEBT-634 `admin-recover --reset-mfa` không kết thúc phiên Redis; DEBT-635 chưa có CLI mã hoá lại hàng loạt / kiểm kid; DEBT-636 context `/authorize` 10' có thể hết trong lúc admin enroll lần đầu. DEBT-334 đổi đích sang sau phát hành.
- Run 90 (pentest) nên có nhóm check MFA theo T3 abuse cases: brute force qua nhiều vé, replay giữa tab, bỏ qua qua federation/link/`prompt=none`, code/family cũ ở `/token`.
- Người dùng: thêm `MFA_ENCRYPTION_KEYS` vào `be/.env` (lấy từ `.env.example`) trước khi chạy app dev sau run 89.
