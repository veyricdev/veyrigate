# Tech Lead Review — 2026-10-22 (run 45, A6.1b)

## Kết luận: PASS (có fold)

Plan khả thi trên code thật (`a581963`); BE đã đủ endpoint, không cần sửa `be/`. Các điểm phải chỉnh đã fold thẳng vào `tasks.md` mục **"Fold tech-lead"** (F1–F4, ưu tiên hơn text cũ). Không có blocker.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ nguyên lớp hiện có (fe-admin monolith, server fn → `createAdminApi` → BE admin API). Chỉ có các điều chỉnh sau:

- Một panel Secrets + vùng Disable/Enable trên `/clients/$clientId`, không thêm route mới.
- Phát hành secret **không qua `useMutation`**. Server fn được gọi thẳng trong handler, plaintext chỉ nằm trong `useState` của component dialog, và component đó unmount khi đóng.
- Rotate/revoke/disable/enable dùng step-up **không có intent**: nút "Confirm identity" → `reauthenticate(path)`.
- `client.ts` hỗ trợ `DELETE`/204.

## Điểm mạnh

- Ràng buộc run 44 cho secret (useState, no-store, không toast/log/URL/storage) đúng hướng; BE đã chặn từ gốc: audit trước khi trả plaintext, `Pragma: no-cache`, list chỉ trả metadata (projection bỏ `secretHash`), version regex, revoke 404 không oracle, disable phải gửi một mình, 409 tự khoá.
- Lớp FE sẵn có hỗ trợ tốt: `AdminResult` không mang body BE, `uncertain` cho mutation, zod allowlist, mutation `retry: 0` và `gcTime: 0`, không có SSR prefetch/persister, không có devtools trong bundle.
- DEBT-308 được xếp làm trước, đúng thứ tự phụ thuộc.

## Vấn đề (đã fold — dev làm theo `tasks.md` "Fold tech-lead")

- [x] **Step-up intent xung đột** (F3.4): `EditClient` gọi `takeIntent` khi mount, và hàm này xoá `fea:stepup` bất kể action. Một intent "chỉ action" của panel secret vì thế sẽ bị form xoá trước khi panel đọc được. Cách sửa: không lưu intent cho các action này, chỉ redirect step-up khi admin bấm nút, kèm cảnh báo mất thay đổi chưa lưu.
- [x] **`useMutation` giữ plaintext** (F3.1): `gcTime: 0` chỉ có hiệu lực sau khi hết observer, nên trong lúc dialog mở secret vẫn nằm trong `MutationCache`. Cách sửa: không dùng `useMutation` cho issue.
- [x] **DELETE 204 chưa được hỗ trợ** (F2): `Method` không có `DELETE` và `read()` luôn parse JSON, nên revoke thành công sẽ bị báo `unavailable`/`uncertain`.
- [x] **DEBT-308 chỉ key form là chưa đủ** (F1): plaintext và state xác nhận cũng phải reset khi đổi `clientId`. Cách sửa: dùng `key={clientId}` cho toàn bộ thân trang detail.
- [x] **E2E** (F4): dùng `/revoke` + Basic làm bằng chứng (Q-45.1). Bỏ chờ step-up 65 s và kiểm `no-store` trên response của server fn. Ngoài ra kiểm tiếp revoke version, disable rồi enable.
- [x] **Acceptance đo được**: dùng chuỗi secret giả và kiểm nó không xuất hiện trong DOM, QueryCache, MutationCache, storage, URL, console, toast. Thêm các case âm cho version input, cho 404/uncertain của revoke và cho double-submit.

## Cổng security design

- **Tài sản**: plaintext `client_secret` (chỉ có một lần), các version credential, trạng thái enabled của client, các refresh family.
- **Actor**: admin của tenant, super_admin (client admin-capable), người không phải admin.
- **Trust boundary**: browser ↔ server fn (BFF) ↔ BE admin API ↔ `/revoke`.
- **Cross-tenant**: BE trả 404 mờ (`mustFind`). Client admin-capable với người không phải super_admin thì nhận 403 (`mustModify`). FE chỉ hiển thị kết quả.
- **Invariant**:
  - Plaintext chỉ có trong response POST đầu tiên.
  - Sau khi đóng dialog, đổi `clientId`, reload hoặc `pagehide`, plaintext không còn trong bất kỳ kho nào phía client.
  - Rotate đưa version cũ sang grace. Revoke có hiệu lực ngay. Disable thu hồi mọi refresh family và khiến client là "unknown" ở mọi endpoint.
- **Abuse case**:
  - Double-submit tạo 2 version: chặn bằng nút pending.
  - Replay POST issue: server fn POST có cùng posture same-origin như run 43; mỗi lần gọi chỉ sinh version mới và có audit, không lộ secret cũ.
  - Credential cũ/đã revoke: `/revoke` trả 401 (E2E).
  - Revoke lại cùng version: BE trả 404, UI refetch.
  - IDOR version: path chứa `clientId` + version và nằm sau `mustModify`.
  - Enumeration: 404 mờ.
  - Tự khoá: 409 với thông điệp riêng.
- **Failure semantics**:
  - Timeout/5xx/2xx sai schema ở issue thì trả `uncertain`, hiện thông điệp hướng dẫn và không gửi lại. Bản cũ còn trong grace nên không gián đoạn.
  - Revoke uncertain thì refetch.
  - Disable: lỗi revoke phía BE trả 5xx nhưng client vẫn ở trạng thái disabled (fail-closed, BE).
- **Exposure**:
  - Response server fn issue có `no-store`.
  - Không đưa secret vào log/failure/toast/console/URL/storage/SSR.
  - Audit chỉ ghi version (BE có kiểu `ForbiddenMetadataKey`).
  - Test âm được liệt kê ở F2(b), F3.9 và F4.

## Đề xuất (không bắt buộc)

- DEBT-309: step-up từ panel secret làm mất thay đổi chưa lưu của form Settings (run này chỉ cảnh báo). Nếu cần giữ nguyên thì gom việc đọc intent về một chỗ trên trang và phân nhánh theo action.
- DEBT-310: trace Playwright ở CI (`retain-on-failure`) có thể chứa DOM có secret của client E2E (client đã disable ở `finally`). Nếu muốn sạch hẳn thì revoke mọi version ở cleanup hoặc che phần tử `issued-secret` khi chụp.
- DEBT-311: phân biệt 409 tự khoá với 409 cập nhật đồng thời đang dựa vào ngữ cảnh (disable-only PATCH). Nên dùng mã lỗi có cấu trúc (gộp với DEBT-301).
- React DevTools đọc được `useState` khi dialog mở: chấp nhận, vì plaintext bắt buộc phải hiển thị.
