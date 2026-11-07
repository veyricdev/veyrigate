# Tech Lead Review — 2026-11-07

## Kết luận: PASS

Run 75 (DEBT-321 + DEBT-512) được vào thẳng dev. Chi tiết bắt buộc nằm ở `tasks.md` § Fold tech-lead.

## Kiến trúc đề xuất (điều chỉnh)

- Gom một hàm thuần `grantableScopes` (`be/src/modules/oauth/scope-policy.ts`) tính `client ∩ (OIDC ∪ resource)`, dùng ở 4 điểm: authorize, chặn trên consent, đổi code, refresh. Không thêm service hay abstraction nào khác.
- Ngữ nghĩa nhất quán cho mọi đường:
  - Yêu cầu mới thì **từ chối**: authorize ⇒ `invalid_scope`, đổi code ⇒ `invalid_grant` reason `scope_not_allowed`.
  - Grant sống lâu thì **thu hẹp**: refresh lấy giao, lưu vào RT kế nhiệm. Ba trường hợp (i) giao rỗng, (ii) mất hết scope ngoài OIDC, (iii) mất `offline_access` ⇒ `invalid_grant` + revoke family.
- Thu hẹp ở pre-check của `issueForRefresh`, **trước khi ký** (DEBT-388 ký trước swap). Lưu `kept` vào successor để thêm lại scope không hồi sinh quyền (nhất quán với DEBT-415).

## Điểm mạnh

- Quyết định §12 rõ ràng. Thiết kế T3 run 74 vẫn khớp code hiện tại: đã kiểm lại `authorize.service.ts:519/535/344`, `token.controller.ts:383/416`, `refresh-token.service.ts:136/370/469`, `admin-resources.controller.ts:110`.
- Chọn B (thu hẹp) đúng về bảo mật. Phép giao không leo thang được, thu hồi có hiệu lực trong ≤ TTL access, và không gây đăng xuất hàng loạt khi admin chỉnh cấu hình.
- Seed và E2E không bị ảnh hưởng: resource `admin` có `admin.read/write`, demo chỉ dùng scope OIDC, E2E fe-admin-resources tạo resource riêng.

## Vấn đề (đã fold vào tasks.md; không cần REJECT)

- [x] B cần chạy trước khi ký (DEBT-388). Nếu thu hẹp sau rotate, AT đã mang scope cũ.
- [x] RT kế nhiệm phải lưu scope đã thu hẹp. Nếu không, admin thêm lại scope thì quyền sống lại.
- [x] "Giao rỗng" được định nghĩa cụ thể bằng (i)–(iii), để family chỉ có scope OIDC (demo) không bị revoke nhầm.
- [x] Code grant: hiện `isCovered` dùng consent cũ, nên scope đã gỡ vẫn đổi được token. Bổ sung check `scope_not_allowed` trong `recheckCodeGrant`.
- [x] Mutation (f) của run 74 sẽ không còn RED khi có check mới ở `/token`. Thêm assert DB `consents.grantedScopes`.
- [x] Guard resource `admin`: ý "audit failure" của run 74 không khớp code (400 validate hiện không ghi audit), nên bỏ audit. Lọc thêm `identifier` vì `resourceId` không unique (DEBT-077).
- [x] Runbook §12 có q1–q3 chỉ đọc. Chạy thử trên `sso-idp-e2e`, không chạy trên DB dev.

## Security design gate

| Mục | Nội dung |
|---|---|
| Tài sản | Scope trong AT/RT. Riêng `admin.*` là quyền quản trị toàn hệ thống. |
| Actor | super_admin chỉnh resource, tenant/super admin chỉnh client, RP, người dùng. |
| Trust boundary | Admin API với `/authorize` và `/token`. |
| Invariant | Scope phát ra ⊆ giao hiện hành. Refresh không bao giờ mở rộng scope. Resource `admin` luôn có `admin.read/write`. |
| Abuse case | Hồi sinh scope qua RT cũ (r1 lần 2). Code mang scope đã gỡ (c1, c2). Báo reuse giả sau revoke (r3). Race giữa pre-check và rotate: chấp nhận, giới hạn bởi TTL 15'. Tự khoá fe-admin (g). |
| Failure semantics | Revoke lỗi ⇒ 500 kèm audit (r7). DB lỗi ⇒ fail-closed như hiện hành. |
| Exposure | Body lỗi OAuth không lộ chi tiết. Audit chỉ ghi `{resource, familyId}`. |

## Đề xuất (không bắt buộc)

- DEBT-515 (`backlog.md`): kiểm tra và, nếu cần, thêm guard chống tự khoá phía client console (gỡ `admin.*` khỏi `Client.scopes` hoặc gỡ resource `admin` khỏi `allowedResources` của BFF client).
