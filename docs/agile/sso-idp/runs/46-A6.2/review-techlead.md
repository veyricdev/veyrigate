# Tech Lead Review — 2026-10-23

## Kết luận: PASS (có fold)

Plan và các task được duyệt, kèm các ràng buộc ghi trong `tasks.md`, mục "Fold tech-lead (2026-10-23)". Mục đó ưu tiên hơn text cũ của tasks.md khi hai bên mâu thuẫn. Đã đối chiếu với code ở `7f92122` qua CodeGraph: `admin-resources.controller.ts`, `admin.dto.ts`, `resource.validator.ts`, `resource.service.ts`, `admin.mappers.ts`, `admin.views.ts`, `fe-admin/openapi/admin.json`, `fe-admin/src/server/admin-api/client.ts`, `features/admin-api/*`, `routes/clients/$clientId.tsx`, `client-status.tsx` và `e2e/playwright.config.ts`.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ nguyên khuôn A6.1, không tạo abstraction mới. Có ba điều chỉnh.

1. **Thêm Task 0 [BE].** `GET /admin/resources/:id`, `POST` và `PATCH` chưa có schema response trong OpenAPI. Task chỉ thêm 3 decorator, cộng test BE và cập nhật snapshot, giống run 44 T1.
2. **Không đè `listResources`/`useResources` hiện có.** Hai hàm này cấp option cho form client. Thêm `listResourcePage`, `getResource`, `createResource`, `updateResource`. Tái cấu trúc `adminKeys.resources` thành `all/options/list/detail`, để mọi lần ghi resource đều làm mới cả ô chọn trong form client.
3. **Ẩn UI ghi khi viewer không có `super_admin`.** Đây chỉ là UX. Lý do: ở BE, step-up guard chạy trước `assertSuperAdmin`.

## Trả lời câu hỏi

### Q-46.1: Quy tắc và hành vi BE

**`identifier`**
- Giới hạn ≤2048 ký tự, `new URL(v)` phải parse được, và `hash === ""`.
- BE không kiểm thêm gì: không chặn scheme (kể cả `javascript:`), không chặn wildcard, không trim. Riêng `https://a/#` vẫn qua.
- FE kiểm giống hệt BE, cộng một ngoại lệ được duyệt: chặn khoảng trắng đầu/cuối (DEBT-324).

**`resourceId`**
- Phải khớp `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Bất biến cùng với `identifier`.

**`scopes`**
- Tối đa 50 phần tử, mỗi phần tử ≤256 ký tự và khớp `^\S+$`.
- Khi PATCH là bắt buộc và thay nguyên mảng; `[]` hợp lệ.
- BE không chặn trùng lặp. FE chặn trùng; việc này vô hại.

**Step-up, quyền và mã lỗi**
- Cả POST và PATCH đều cần step-up (`RequireRecentAuth(5)`) và quyền `super_admin`.
- Mã lỗi:
  - 409 khi trùng `resourceId` hoặc `identifier`;
  - 403 khi không phải super_admin;
  - 404 khi không tìm thấy.
- Resource là dữ liệu global, không có tenant.

### Q-46.2: Dữ liệu cho E2E

- DB E2E không được reset, và cũng cấm drop/FLUSH. Vì vậy mỗi lần chạy tạo một resource duy nhất: `e2e-r<inv>`, với `inv = 9999999999999 - Date.now()`. Lần chạy mới nhất luôn nằm ở trang 1, vì danh sách sort theo `identifier`.
- Không dọn dữ liệu được, chấp nhận việc tích luỹ (DEBT-322).
- Mọi thao tác ghi phải xong trong khoảng 50 s sau đăng nhập, vì E2E đặt `ACCESS_TOKEN_TTL=120`. Không viết E2E cho step-up.

### Q-46.3: Phạm vi

Gói gọn trong 1 run với Task 0 + 1 + 2 + 3 + 4, kích cỡ M. DEBT-320 nằm ngoài phạm vi.

## Điểm mạnh

- Tái dùng đúng các bài học từ run 44/45:
  - đóng băng `base` để refetch không ghi đè form;
  - remount theo id (DEBT-308);
  - `uncertain` thì không tự gửi lại;
  - không parse thông điệp lỗi của BE để đoán field.
- Đưa DEBT-318/319 vào sớm, trước khi khuôn status/focus bị nhân bản sang resources.
- Phạm vi nhỏ, không thêm phụ thuộc mới. `@tanstack/react-form` và `radix-ui` đã có sẵn.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm bắt buộc đã được fold vào tasks.md:

- [x] Thêm Task 0 [BE] (schema response OpenAPI).
- [x] Không phá `listResources`/`useResources` của form client; key resources mới nằm dưới `resources.all`.
- [x] Scopes của resource là 50/256, khác client (20/2048): không dùng lại hằng số của client.
- [x] `identifier` luôn hiển thị dạng text, không bao giờ là `href`, vì BE chấp nhận `javascript:`. Có test kiểm.
- [x] Path id dùng luật lỏng giống `ClientIdSchema`, không dùng regex lúc tạo, để vẫn mở được resource cũ.
- [x] E2E dùng tên duy nhất mỗi lần chạy và không dọn dữ liệu. Có ràng buộc thời gian để không cần step-up.

## Đề xuất (không bắt buộc), đã ghi backlog

- **DEBT-321**: `Resource.scopes` không được dùng khi cấp token. Cần chốt ngữ nghĩa.
- **DEBT-322**: resource không xoá/archive được; DB E2E tích luỹ dữ liệu.
- **DEBT-323**: PATCH resource ghi đè lẫn nhau (last-write-wins), không có kiểm soát đồng thời.
- **DEBT-324**: BE không chặn khoảng trắng đầu/cuối và scheme lạ trong `identifier`.
- **DEBT-325**: `StepUpGuard` chạy trước `assertSuperAdmin`, nên tenant_admin phải step-up vô ích rồi mới nhận 403.
