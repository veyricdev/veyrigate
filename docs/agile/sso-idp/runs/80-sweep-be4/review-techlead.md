# Tech Lead Review — 2026-11-09 (run 80, sweep 🟡 BE đợt 4)

## Kết luận: PASS

Lô 5 task (fold chi tiết: `tasks.md` mục "Fold tech-lead"): T1 DEBT-526, T2 DEBT-237 + DEBT-411, T3 DEBT-324 + DEBT-329 ([BE] + phần [FE] nhỏ), T4 DEBT-325, T5 DEBT-530 + DEBT-529. Chuyển **backend-dev** (T3 có phần **frontend-dev**, có thể do backend-dev làm luôn nếu chỉ sửa `identifierProblem` + bảng parity).

## Kiến trúc đề xuất

Không đổi kiến trúc. Các quyết định tech-lead tự chốt (ủy quyền theo tiêu chí production, `plan.md` §12):

- **DEBT-526 (logout `scope=session`)**: GIỮ thứ tự dừng-ở-lỗi-đầu-tiên hiện có (token → session → sweep). KHÔNG chuyển sang "chạy mọi bước" như `scope=all` (DEBT-150): với `scope=session`, nếu token revoke lỗi mà vẫn revoke session thì lần thử lại rơi vào nhánh "không có phiên" và không còn cách nào revoke refresh family của phiên đó. Dừng sớm giữ phiên sống ⇒ thử lại làm lại đủ. Chỉ thêm audit failure `{scope:'session', failedStep}`.
- **DEBT-324/329 (identifier resource)**: quy tắc chung FE + BE cho điểm GHI (tạo resource): từ chối mọi ký tự thuộc `\p{Cc}` (điều khiển, gồm tab/LF/NUL/DEL), `\p{Cf}` (định dạng: ZWSP U+200B, BOM U+FEFF, bidi U+202E…) hoặc `\p{Z}` (mọi khoảng trắng/separator, gồm space giữa chuỗi) ở BẤT KỲ vị trí nào; scheme (sau `new URL`, đã lowercase) ∈ {`https:`, `http:`, `urn:`}. Lý do: `aud` là chuỗi thô, mọi ký tự mà `new URL` bỏ/encode làm resource vô dụng; `javascript:`/`data:`/`file:` không phải định danh API hợp lý và dễ gây nhầm trong UI. `http:` giữ cho dev/mạng nội bộ (định danh, không phải URL được gọi). Kiểm runtime `/authorize`/`/token` (`resolveForClient`) KHÔNG đổi: identifier lạ chỉ là "không tìm thấy" ⇒ không phá dữ liệu cũ.
- **DEBT-325**: thêm metadata `@SuperAdminOnly()` được kiểm TRONG `AdminTokenGuard` (guard cấp controller, luôn chạy trước `StepUpGuard` cấp method) — không phụ thuộc thứ tự decorator. `assertSuperAdmin` trong handler giữ làm phòng thủ lớp hai.
- **DEBT-411**: chỉ 503 của `/introspect` thêm `error_description` (= global filter / `/token`); 429 của `/introspect` giữ nguyên (ngoài phạm vi debt).

## Kiểm từng ứng viên trên code hiện tại (develop `257bdd4`)

Không ứng viên nào đã được sửa gián tiếp.

| Debt | Trạng thái code | Quyết định |
|---|---|---|
| 526 | `ui.controller.ts:376-382` nhánh `scope=session` không try/catch, không audit failure; `ui.int-spec.ts:1148,1180` khẳng định 0 audit | **Chọn T1** — sự kiện bảo mật không để lại dấu vết; cùng hình T1 run 79 |
| 237 | `html-exception.filter.ts:15-45` không có logger; 500 của UI/`/authorize`/federation chỉ còn dòng access | **Chọn T2** — vận hành production: 500 không chẩn đoán được |
| 411 | `introspect.controller.ts:276-281` 503 chỉ `{error}` | **Gộp T2** — cùng lớp "bề mặt lỗi", 1 dòng |
| 324 | `resource.validator.ts:19-29` chỉ `new URL` + hash; nhận `javascript:` và khoảng trắng đầu/cuối | **Chọn T3** — toàn vẹn cấu hình (resource chết im lặng) |
| 329 | Còn (bảng `fe-admin/test/resource-form-parity.test.ts` ghi lỗ hổng NUL/tab/LF/ZWSP cả 2 phía) | **Gộp T3** |
| 325 | `admin-resources.controller.ts:94,121`, `admin-keys.controller.ts:41,68` kiểm super_admin trong handler, sau `StepUpGuard` | **Chọn T4** — tenant_admin bị bắt đăng nhập lại vô ích rồi vẫn 403; rẻ |
| 530 | Ca DEBT-182 `federation.int-spec.ts:2052-2090` spy `link` reject ⇒ bỏ `session` ở `link` không bị bắt | **Chọn T5** — test chặn hồi quy cho transaction vừa thêm ở run 79 |
| 529 | `user-tenant.service.ts:46` `deleteMembership` chỉ còn `admin-users.int-spec.ts:899` dùng | **Gộp T5** — cùng module identity/federation, xoá code chết |
| 134 | Còn (`client.service.ts:389` `after = {...before, ...set}`; Mongoose `timestamps` tự ghi `updatedAt` riêng nên gán tay sẽ lệch DB) | Hoãn: chỉ hiển thị; sửa đúng cần `timestamps:false` + `updatedAt` tường minh trên CẢ 2 lệnh ghi (main + disable stamp) hoặc đọc lại — không đáng rủi ro ở sweep |
| 323 | Còn (`resource.service.ts:79-93` last-write-wins) | Hoãn. Chốt: so sánh trong handler (`before.scopes` vào filter) không giải quyết lost update thật (cửa sổ là lúc admin mở form, không phải trong request) ⇒ cần FE gửi `If-Match`/`expectedScopes` — đổi hợp đồng FE+BE; chỉ super_admin, hiếm. Ghi chú vào backlog |
| 413 | Còn (context `login` không gắn trình duyệt) | Hoãn: cần cookie gắn context (nhiều tab ⇒ cần tập hợp/ tên cookie theo request), đụng ma trận X3; rủi ro thấp (CSPRNG, TTL 10', no-referrer). Ứng viên run hardening riêng |
| 157 | Còn (`keys.controller.ts:36-38` không `Cache-Control`) | Hoãn. Chốt: KHÔNG thêm `max-age=300` như đề xuất gốc — với CDN phía trước nó làm chậm cả việc RP thấy kid mới sau rotate thường (ký bằng key mới ngay, DEBT-393). Gộp quyết định cache JWKS với DEBT-349/393 vào X6 (runbook: báo RP refetch sau emergency) |
| 120 | Còn (3 peek `GET /login`) | Hoãn: chỉ hiệu năng |
| 121 | Còn | Hoãn: fail-closed UX, NTP đủ |
| 192 | Còn | Hoãn: giới hạn đã biết |
| 193 | Còn | Hoãn: chưa có trang quản lý liên kết |

## Điểm mạnh

- Mỗi task chạm 1 module (ui, filters, resources, tenant-context guard, federation/identity) — diff không chồng chéo.
- T1 bám đúng invariant đã kiểm (fail-closed, retry được) thay vì sao chép máy móc semantics `scope=all`.
- T3 đặt quy tắc ở điểm ghi, không đổi đường runtime ⇒ không có rủi ro dữ liệu cũ.
- T4 đặt kiểm vai trò ở guard cấp controller ⇒ thứ tự xác định, không lệ thuộc thứ tự decorator.
- T5 xoá code chết và thêm đúng test mà mutation run 79 chỉ ra là thiếu.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Lưu ý thực thi (bắt buộc làm đúng):
- [ ] T1: không đổi thứ tự bước, hình audit success, nhánh `scope=all`; audit failure không chứa message lỗi/token/session id thô.
- [ ] T2: log chỉ qua `errorForLog` (không message); body/view lỗi không đổi.
- [ ] T3: FE không bao giờ nhận cái BE từ chối (invariant bảng parity); cột `be` của bảng phải ĐO lại bằng validator thật như ghi chú đầu file.
- [ ] T4: thứ tự lỗi 401 → 403 `insufficient_scope` → 403 `forbidden` (membership) → 403 `forbidden` (super_admin) → `step_up_required` không đổi cho các route khác.
- [ ] T5: spy commit phải là `mongoose.mongo.ClientSession.prototype` (cùng class driver Mongoose dùng), `mockRejectedValueOnce`, restore trong `finally`.

## Đề xuất (không bắt buộc)

- DEBT-323: khi làm, dùng `expectedScopes` trong body PATCH (FE gửi danh sách đang hiển thị) + filter `{scopes: expected}` ⇒ 409; ghi vào backlog (cập nhật dòng DEBT-323).
- DEBT-157/349/393: một quyết định chung về cache JWKS trong X6.
