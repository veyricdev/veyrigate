# Tech Lead Review — 2026-11-07

## Kết luận: PASS

Run 76 (DEBT-515 + DEBT-513) được vào thẳng backend-dev. Các điểm mở đã chốt và fold vào `tasks.md` § "Fold tech-lead" (F0–F5). Không có Task FE.

## Kiến trúc đề xuất (điều chỉnh)

- **Nhận diện client console**: dùng client đã phát hành admin token của request (`AdminActor.clientId`), KHÔNG thêm env/config. `fe-admin` chỉ là clientId của seed dev (`be/src/database/seed.ts:43`); ở production clientId của console tuỳ deploy. Cách này đã có tiền lệ: guard tự disable ở `admin-clients.controller.ts:159-162`.
- **Phạm vi chặn** (chỉ trên client của actor, sau khối disable hiện có, trước `updateForTenant`):
  1. `scopes` phải giữ mọi scope của chính admin token (thêm `scopes` vào `AdminActor`/`AdminPrincipal`). Cách này chính xác hơn hard-code: `/authorize` từ chối mọi scope xin mà client không có (`authorize.service.ts:532-546`), mà BE không biết BFF xin gì ngoài những gì có trong token.
  2. `allowedResources` phải giữ resource `admin` (`adminResourceIds()` chuyển sang public).
  3. `grantTypes` phải giữ `authorization_code`, và giữ `refresh_token` khi token có `offline_access`.
- **409 `conflict`**, ba thông điệp cố định, không chứa giá trị nào từ input. Đồng nhất với 409 tự disable cùng handler và JSDoc `AdminAuthError.conflict` ("self-lock"). 400 của guard resource `admin` (run 75) giữ nguyên.
- **Không audit**, không ghi DB (đồng nhất 409 tự disable / 400 validate).
- **Race**: quy tắc chỉ phụ thuộc body (mảng thay nguyên khối), token của request và id resource bất biến. Mỗi PATCH được chấp nhận tự thoả bất biến, nên hai PATCH đồng thời luôn để lại trạng thái hợp lệ. Không cần filter điều kiện hay transaction.

## Điểm mạnh

- Phạm vi đúng và nhỏ: chỉ có một route PATCH client và hai route secret; không có route xoá client. Đã xác nhận bằng codegraph.
- Có sẵn mẫu cho cả guard (disable 409) lẫn test (`admin-api.int-spec.ts:787`, helper `tok({client, scope})`), nên việc thêm int test là tuyến tính.
- FE không phải sửa: `fe-admin/src/server/admin-api/client.ts:178` map `409 conflict` cùng description, UI hiển thị `error.message`.
- DEBT-513 là đổi một dòng; `admin-users.controller.ts:63` đã alias `ADMIN_ROLE_VALUES`.

## Vấn đề (đã fold vào tasks.md; không cần REJECT)

- [x] Task 1 để ngỏ cách nhận diện console (env?): chốt `actor.clientId`, không config mới (F0/F1).
- [x] "Tối thiểu scopes `admin.*`" chưa đủ: thiếu `openid`/`offline_access` cũng làm `/authorize` trả `invalid_scope`. Chốt giữ mọi scope của token (F1.1).
- [x] Thiếu `grantTypes` trong phạm vi: mất `authorization_code` thì không đăng nhập được (F1.3).
- [x] "disable/delete": disable đã có 409; không tồn tại route delete ⇒ không cần việc gì thêm, chỉ giữ test hiện có xanh.
- [x] Mã lỗi để ngỏ 400/409: chốt 409 kèm lý do (F1).
- [x] Thứ tự so với 403 tenant_admin và nhánh grant `admin`: guard đứng trước `updateForTenant` nên không revoke secret pass 1 và không ghi DB (F1, mutation M6).
- [x] AC chưa có ca race, ca tenant_admin, ca `offline_access` có điều kiện, mutation cụ thể: bổ sung ở F2.
- [x] Task 3 chưa chỉ chỗ sửa docs: bổ sung F4 (spec §7 quy tắc 6, security-matrix, runbook-ops khôi phục).

## Rủi ro còn lại (backlog)

- DEBT-517 💭: xoá redirect URI callback của console, hoặc `DELETE` đúng secret version BFF đang dùng, vẫn khoá được console từ chính nó. BE không biết URI/version nào console dùng. Chặn kiểu "không được xoá secret cuối cùng" chỉ phủ một phần mà lại cản phản ứng sự cố, nên chưa làm. Đường khôi phục: client admin-capable khác hoặc sửa DB có kiểm soát (runbook-ops, F4).

## Đề xuất (không bắt buộc)

- Hàm guard nên là hàm thuần nhận `(dto, tokenScopes, adminIds)` để unit test không cần Nest.
