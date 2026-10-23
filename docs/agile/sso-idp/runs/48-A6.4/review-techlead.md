# Tech Lead Review — 2026-10-23

## Kết luận: PASS (có fold)

Plan được duyệt, kèm các ràng buộc fold ở cuối `tasks.md` (mục "Fold tech-lead (2026-10-23)"). Fold được ưu tiên hơn phần text phía trên khi hai bên mâu thuẫn. Đã đối chiếu code thật `2e171cc` qua CodeGraph.

## Kiến trúc đề xuất (nếu cần điều chỉnh)
- Giữ monolith BE + fe-admin BFF như các run trước. Chỉ thêm hai việc nhỏ ở BE trong **Task 0**:
  - (a) View DTO + `@ApiOkResponse` cho `GET /admin/audit`, vì snapshot OpenAPI chưa có response schema (giống run 46/47).
  - (b) Gắn `tenantId = client.tenantId` cho `TOKEN_REUSE_DETECTED`. Không làm thì `listForTenant` lọc chặt theo tenant và reuse không bao giờ hiện với bất kỳ admin nào, nên yêu cầu "làm nổi reuse" của A6.4 rỗng.
- Bộ lọc audit nằm trong search params và dùng server fn GET. BE không có filter email/IP. Ô id bị ràng buộc bởi `AuditIdSchema` (không có `@`) để email không thể lọt vào URL.
- Lọc metadata phòng thủ đặt ở `schemas.ts` (server-only): chỉ giữ giá trị primitive và bỏ key giống secret. Cách này không dùng allowlist theo tên key, nên không vỡ khi BE thêm key mới.

## Điểm mạnh
- Phạm vi gọn: tái dùng khuôn cursor, zod allowlist, `components/feedback/`, kèm 3 nợ nhỏ của run 47.
- Tasks.md đã nêu đúng các rủi ro chính: PII trong URL, không render HTML, không lộ secret.
- BE đã an toàn ở tầng ghi: `sanitizeMetadata`, kiểu `AuditMetadata` cấm key nhạy cảm, mapper allowlist, `tenantId` gán cuối filter, `no-store`, log cắt query.

## Vấn đề (bắt buộc sửa nếu REJECT)
Không REJECT. Các thiếu sót sau đã được fold thành ràng buộc:
- [x] Thiếu Task 0 [BE] cho response schema audit ⇒ F0(a).
- [x] Reuse không hiện được vì thiếu `tenantId` (DEBT-140) ⇒ F0(b), cộng ghi chú cố định trên UI.
- [x] Task 2 ghi "userId" nhưng BE dùng `actorId`/`targetId`/`targetType` (exact, AND) ⇒ F2 nêu lại đúng các filter.
- [x] Chưa chốt "sự kiện bảo mật khác" ⇒ chỉ làm nổi reuse và `SIGNING_KEY_ROTATED` emergency; mọi `failure` có chữ "Failure".
- [x] UA/`reason` do kẻ tấn công kiểm soát ⇒ có test XSS âm. Link chỉ đi qua `<Link params>` khi id hợp lệ.
- [x] Mutation bắt buộc cho từng task (F0–F3).

## Đề xuất (không bắt buộc)
- DEBT-342: export CSV (hoãn theo Q-48.3).
- DEBT-343: BE thêm filter `subjectId` (OR `actorId`/`targetId`) và pattern cho các filter id trong `AuditQueryDto`.
- DEBT-344: chính sách retention và che IP/UA trong audit, hiện đọc được bởi mọi admin của tenant.
