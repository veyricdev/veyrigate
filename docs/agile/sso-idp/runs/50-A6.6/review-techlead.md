# Tech Lead Review — 2026-10-23
## Kết luận: PASS (có fold)

Đối chiếu code `e484913`. Ràng buộc chi tiết nằm ở `tasks.md` mục "Fold tech-lead (2026-10-23)" và được ưu tiên hơn text gốc.

## Kiến trúc đề xuất (nếu cần điều chỉnh)
- Không thêm endpoint BE (không Task 0). Size S giữ nguyên.
- Số liệu: dùng lại hook list sẵn có, mỗi list một trang `limit: 100`, hiển thị `n` hoặc `100+` theo `nextCursor`.
- Health: một method BFF `readiness` gọi BE `/ready` (công khai), chỉ trả enum `up|down|unknown` cho trình duyệt; server fn `getBackendHealth` qua `adminCall` để kiểm session.
- Sự kiện bảo mật: 3 lần gọi `listAudit` (một action mỗi lần, `limit: 10`), gộp ở trình duyệt, fail-closed.

## Điểm mạnh
- Khuôn A5/A6 đủ dùng: `adminCall`, hook list có cursor, `useAuditEvents`, gate super_admin bằng mount có điều kiện (`/keys`), QueryCache tự `signInAgain`, refresh single-flight trong BFF.
- BE `/ready` đã thiết kế theo exposure budget (enum, `no-store`, không message/host).
- Không có mutation mới ⇒ bề mặt rủi ro nhỏ.

## Vấn đề (bắt buộc sửa — đã fold, không cần quay lại analyst)
- [x] Task 2 nói "theo quyền: tenant_admin chỉ thấy tenant của mình", nhưng resources là **toàn cục** ⇒ nhãn "Resources (all tenants)" (F2).
- [x] "lock…" trong danh sách sự kiện: `AUTH_ACCOUNT_LOCKED` không gắn tenant (DEBT-140) nên không bao giờ hiện ⇒ chỉ dùng `ADMIN_USER_LOCKED` (F2).
- [x] "health qua BFF" chưa nêu auth, timeout, ánh xạ trạng thái hay exposure ⇒ F2: kiểm session, 0 fetch khi ẩn danh, timeout 3s, không gửi bearer, 3 trạng thái, không log body.
- [x] "mỗi khối lỗi độc lập" chưa nêu ngữ nghĩa lỗi một phần của khối sự kiện ⇒ fail-closed (không khẳng định "không có sự kiện").
- [x] Đếm gần đúng phải không bao giờ hiện số chính xác giả ⇒ `countText` + mutation.

## Trả lời
- **Q-50.1**: một trang `limit: 100` mỗi list; `100+` khi còn trang. Không Task 0 [BE], không duyệt cursor. Đếm chính xác ⇒ DEBT-356.
- **Q-50.2**: BE `GET /ready` (công khai, không METRICS_TOKEN), gọi từ BFF; trình duyệt chỉ thấy `up|down|unknown`.
- **Q-50.3**: 3 request (một action mỗi request) rồi gộp client-side; lọc client-side từ list không lọc sẽ bỏ sót.

## Đề xuất (không bắt buộc)
- DEBT-356: endpoint đếm/stats theo tenant nếu cần số chính xác > 100.
