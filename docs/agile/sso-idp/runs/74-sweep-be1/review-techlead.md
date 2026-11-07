# Tech Lead Review — 2026-11-07

## Kết luận: PASS (Task 1, 2, 2b, 4, 5). Task 3 (DEBT-321) tách sang run 75, thiết kế đã duyệt.

## Kiến trúc đề xuất (nếu cần điều chỉnh)
Giữ monolith NestJS hiện có. Run này chỉ sửa cục bộ: repository tenant, controller federation, thêm một module hằng số trong identity, và thêm test. Thiết kế chi tiết của từng task nằm ở `tasks.md` § Fold tech-lead.

## Điểm mạnh
- Gốc của cả 5 debt đều xác minh được bằng code thật:
  - DEBT-487: `tenant-scoped.repository.ts:69/93`.
  - DEBT-505: `federation.controller.ts:31-33/113/254`, đọc tên cố định ở 5 chỗ.
  - DEBT-321: `authorize.service.ts:519/535`.
  - DEBT-489: `refresh-token.service.ts:510-515`, chưa có test.
  - DEBT-488: `user-tenant.service.ts:4`.
- Có sẵn helper `hostCookieName` (DEBT-008) và mẫu cắt cứng, nên DEBT-505 chỉ là áp lại một quyết định đã đo ở run 73.
- Quyết định DEBT-321 (`plan.md` §12) đúng về kỹ thuật và bảo mật: giao (không phải hợp), từ chối (không tự thu hẹp), và tách riêng scope OIDC chuẩn. Không mở lại.

## Vấn đề (bắt buộc sửa nếu REJECT)
Không có vấn đề chặn. Các điều kiện sau là bắt buộc khi triển khai (đã ghi trong fold):
- [ ] DEBT-487: ép `tenantId` bằng stage `$set` cuối do repo nối. Int test trên Mongo thật cho `$unset` string, `$replaceWith`, `$replaceRoot`, `$project` và `$set` tenant khác; mutation ⇒ RED.
- [ ] DEBT-505: deviceId của rate-limit phải dùng cùng tên cookie đã resolve. `clearCookie` phải cùng tên và `Path=/`. Int ở chế độ Secure phải chứng minh tên cũ bị bỏ qua (s2) và cookie tossed bị bỏ qua khi có tên mới (s3). Runbook §11 ghi rõ leg federation đang dở lúc deploy sẽ hỏng.
- [ ] DEBT-489: spy đúng instance `RefreshTokenService`. Kiểm 5xx, body không lộ lỗi, audit `resource_not_allowed`. Sau khi restore spy, refresh lại ⇒ family bị revoke. Chạy 2 mutation.
- [ ] Chỉ thay đổi trong danh sách diff ở § Cổng run 74. Không retries, không nới assertion.

## Đề xuất (không bắt buộc)
- Tách DEBT-321 sang run 75, vì phần sửa còn gồm guard chống tự khoá cho PATCH resource `admin`, sweep ≥ 6 fixture int, copy [FE] fe-admin và truy vấn kiểm DB trước deploy. Thiết kế và các ca a–g + mutation đã có trong fold.
- DEBT-512: kiểm lại ở refresh/code khi admin thu hẹp `Client.scopes`/`Resource.scopes` (cần người dùng chốt: refuse + revoke family, hay thu hẹp).
- DEBT-513: gộp các hằng `ADMIN_ROLES` trùng vào `identity/admin-roles.ts` sau Task 5.
- X3 ca 8: nếu mock Google không chạy được dưới topology TLS mà không sửa harness thì mở debt, không ép.
