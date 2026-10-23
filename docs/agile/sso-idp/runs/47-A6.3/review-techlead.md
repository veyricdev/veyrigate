# Tech Lead Review — 2026-10-23

## Kết luận: PASS (có fold)

Plan và các task được duyệt, kèm các ràng buộc ghi trong `tasks.md`, mục "Fold tech-lead (2026-10-23)". Mục đó ưu tiên hơn text cũ của tasks.md khi hai bên mâu thuẫn. Đã đối chiếu với code ở `edffce0` (CodeGraph + đọc trực tiếp): `admin-users.controller.ts`, `admin.dto.ts`, `admin.mappers.ts`, `admin.views.ts`, `user.service.ts`, `user-tenant.service.ts`, `authentication.service.ts`, `access-token-liveness.ts`, `tenant-context.ts`, `refresh-token.service.ts`, `be/test/e2e/seed-e2e-admin.ts`, `fe-admin/openapi/admin.json`, `fe-admin/src/server/admin-api/{client,schemas}.ts`, `features/admin-api/*`, `features/{clients,resources}/*`, `routes/resources/*`, E2E `support/{admin,fe-admin}.ts`, `config/env.ts`, `playwright.config.ts`.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ khuôn A6.1/A6.2, không tạo abstraction mới ngoài việc gom helper (DEBT-326/328). Có năm điều chỉnh.

1. **Thêm Task 0 [BE].** Cả 10 operation users trong snapshot OpenAPI đều chỉ có `"200": {"description": ""}`, không có schema response, và endpoint 204 cũng bị ghi là 200. Task 0 thêm 6 view DTO, các decorator `ApiOkResponse`/`ApiNoContentResponse`, test BE và snapshot. Task này cũng tạo user E2E riêng trong `seed-e2e-admin.ts` cho Task 5.
2. **Cắt phạm vi** (Q-47.1/Q-47.2):
   - roles editor sang 47b (DEBT-335, chặn bởi DEBT-149/142);
   - federated identities và danh sách session: BE không có dữ liệu ⇒ DEBT-334, analyst quyết.
3. **`listUsers` là server fn POST.** Server fn GET mã hoá input vào URL, nên email filter sẽ lọt vào URL, history, log và `returnTo` của `signInAgain()`. Email filter là state của form, không vào search params.
4. **Gom helper dùng chung** vào `components/feedback/` (`confirm-action.tsx`, `form-feedback.ts`) và `pathIdSchema(message)`. `StepUpAlert` nhận `note?`, vì câu "Unsaved changes in Settings…" chỉ đúng ở trang client.
5. **Tự khoá**: BE cấm tự lock (403) nhưng cho tự revoke global/family, và điều đó đăng xuất admin ngay (session bị tombstone ⇒ `isAccessTokenLive` false). UI vẫn cho phép nhưng hiện cảnh báo `role="alert"`; revoke global thành công thì gọi `signInAgain()` (DEBT-337).

## Trả lời câu hỏi

- **Q-47.1**: Roles PATCH không vào run 47. Lý do:
  - BE thay nguyên mảng nên xoá vai trò không-admin (DEBT-149, cần analyst chốt);
  - race giáng hai super_admin (DEBT-142);
  - là UI leo thang quyền, cần cổng security riêng.

  Run 47 chỉ hiển thị `roles`. Snapshot vẫn thêm response schema cho `setRoles` để 47b dùng ngay.
- **Q-47.2**: Vừa 1 run sau khi cắt. Run 47 = Task 0 [BE] + Task 1–5 (users list/detail, lock/unlock, families, consents, revoke global, E2E). Run 47b = roles + DEBT-334 (nếu analyst giữ). Nghiệm thu của plan (xác nhận hành động phá huỷ, hiển thị `lockedUntil`) đạt trong run 47.
- **Q-47.3**:
  - User E2E riêng `e2e-user@example.com`, do `seed:e2e-admin` upsert và reset password/lock/status/roles mỗi lần chạy. Không có vai trò admin, membership active ở `DEFAULT_TENANT_ID`.
  - Không dùng `DEV_SEED_*` (nhiều spec khác dùng) và không dùng admin E2E. Token của target lấy qua client `fe-admin` bằng `adminToken` đã tổng quát hoá.
  - Tenant isolation không kiểm ở E2E, vì stack E2E chỉ có 1 tenant; int-test BE run 28 đã phủ.

## Điểm mạnh

- BE users đã chặt:
  - tenant isolation qua membership, 404 opaque;
  - `assertMayTouchAccount` cho trạng thái toàn cục;
  - lock ghi trước rồi mới revoke (retry idempotent);
  - family/consent giới hạn theo client của tenant;
  - mọi ghi đều có step-up + audit;
  - log BE cắt query string.
- FE đã có đủ khối dựng sẵn: `ConfirmAction` (chặn double-submit, focus, step-up không intent), `useInvalidateOn` (uncertain/throw ⇒ refetch), `client.ts` hỗ trợ DELETE/204 (`schema: null`), drift test OpenAPI ↔ zod.
- Phần lớn thao tác ghi là idempotent (lock, unlock, revoke family, revoke global) nên `uncertain` xử lý đơn giản. Chỉ xoá consent cần thông điệp riêng (DEBT-151).

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm bắt buộc đã được fold vào `tasks.md` thay cho REJECT:

- [x] Task 0 [BE]: thiếu schema response OpenAPI cho users; thiếu user E2E riêng.
- [x] Email filter không được vào URL/log (server fn POST, state form).
- [x] Lock `uncertain`/5xx: lock có thể đã ghi trong khi revoke lỗi ⇒ thông điệp chỉ tới "Revoke all sessions" (nút luôn có mặt).
- [x] Xoá consent `uncertain`: family có thể còn sống (DEBT-151) ⇒ thông điệp chỉ tới revoke family/global.
- [x] Tự khoá: cảnh báo + `signInAgain()`; ẩn Lock khi target là chính mình.
- [x] Revoke global/lock là toàn cục, xuyên tenant ⇒ mô tả trong dialog phải nói rõ.
- [x] Component test render vào `document` (DEBT-312); `not_found` ⇒ ẩn nút ghi (DEBT-320).

## Đề xuất (không bắt buộc)

- DEBT-336: thêm `lockKind` vào view để FE không phải suy ra sentinel năm 9999.
- DEBT-337: chốt hợp đồng tự revoke (chấp nhận + ghi vào OpenAPI, hoặc yêu cầu xác nhận tường minh).
- Debt mới: DEBT-334…337 (backlog.md).
