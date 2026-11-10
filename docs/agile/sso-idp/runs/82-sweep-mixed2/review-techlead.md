# Tech Lead Review — 2026-11-10 (run 82, sweep 🟡/💭 đợt 2, BE + FE/E2E)

## Kết luận: PASS

Lô 4 task (fold chi tiết: `tasks.md` mục "Fold tech-lead (2026-11-10)"):

| Task | Debt | Lane |
|---|---|---|
| T1 | DEBT-538: scope token theo ngữ pháp RFC 6749 §3.3, parity FE | [BE] **backend-dev** + [FE] **frontend-dev** |
| T2 | DEBT-533: câu cố định cho lỗi redirect URI / CORS origin / allowedResources | [BE] **backend-dev** |
| T3 | DEBT-537: `expectedScopes` khớp như view admin (`null`/vắng/`[]`) | [BE] **backend-dev** |
| T4 | DEBT-535 + DEBT-536: X3 ca 1 đo cookie resume phía proxy, thu hẹp miễn trừ | [E2E] **frontend-dev** |

Thứ tự: backend-dev T1-BE → T2 → T3; frontend-dev T1-FE + T4 song song từ đầu; chạy X3 sau khi BE xong; gate chung tuần tự.

## Kiến trúc đề xuất

Không đổi kiến trúc (modular monolith NestJS + BFF fe-admin). Không đổi hợp đồng HTTP nào ngoài việc thắt validation (T1) và bỏ echo khỏi câu lỗi (T2). Các quyết định tech-lead tự chốt theo ủy quyền (`plan.md` §12, tiêu chí production):

### Chốt 1 — DEBT-538: dùng đúng ngữ pháp RFC thay vì danh sách đen Unicode

- Backlog gợi ý chặn `\p{Cc}\p{Cf}\p{Z}`. Chọn thay bằng ngữ pháp chuẩn `scope-token = 1*( %x21 / %x23-5B / %x5D-7E )`: một regex ASCII, đơn giản hơn, chặn luôn mọi lớp Unicode giả dạng (homoglyph, ký tự kết hợp) mà danh sách đen bỏ sót, và đúng với yêu cầu của client OAuth thật (scope ngoài ngữ pháp đằng nào cũng không đi qua được tham số `scope` chuẩn).
- `expectedScopes` **cố ý giữ quy tắc lỏng cũ**: nó chỉ là giá trị so sánh với dữ liệu đã lưu; nếu thắt theo, một resource đang lưu scope cũ không hợp lệ sẽ không sửa được qua API (mọi PATCH kèm `expectedScopes` bị 400). Không có rủi ro injection: so sánh bằng `$literal` (T3).
- Dữ liệu cũ: không migration tự động (chỉ super_admin/admin nhập được, chưa thấy dữ liệu thật). Runbook-ops thêm truy vấn chỉ đọc để tìm; lần sửa kế tiếp trường đó bị 400 cho tới khi dọn. Đây là fail-closed có chủ đích.
- `/authorize`/`/token` không đổi: token ngoài ngữ pháp không thể có trong `Client.scopes` mới ⇒ `invalid_scope` như hiện hành.

### Chốt 2 — DEBT-533: câu cố định, không kèm chỉ số mục

- Bỏ phần echo ở 5 nhánh `redirect-uri.validator.ts` và 3 nhánh cùng lớp trong `client.service.ts` (CORS origin ×2, `allowedResources` không tồn tại). Cả 8 đi qua cùng `toAdminError` ⇒ `invalid_request` với `err.message`; làm một lần cho trọn lớp.
- Không thêm chỉ số mục (`redirectUris[2]`) vào câu: cần đổi chữ ký validator dùng chung với seed; form fe-admin đã kiểm từng dòng phía client. Ghi thành DEBT-539 (💭).
- fe-admin hiển thị `error_description` dạng text (`clients-ui-risk.test.tsx:159-174`), test FE dùng message mock ⇒ không sửa FE.

### Chốt 3 — DEBT-537: một điều kiện `$expr` mô phỏng đúng `toAdminResource`

- Gợi ý backlog `{ scopes: null }` / `$in: [null, []]` sai ở biên: với field mảng, `{scopes: null}` khớp cả mảng **chứa** `null` (`[null]`, `['a', null]`) ⇒ kỳ vọng `[]` có thể ghi đè một danh sách khác rỗng. Chọn `{ $expr: { $eq: [{ $ifNull: ['$scopes', []] }, { $literal: expectedScopes }] } }`, đúng phép `r.scopes ?? []` mà `GET` trả về ⇒ "cái admin thấy" và "cái filter so" là một.
- `$literal` bắt buộc: `$` là ký tự hợp lệ trong scope (cả theo RFC), không có nó `'$resourceId'` bị đọc thành field path (cùng lớp lý do DEBT-132 tránh pipeline update với giá trị người dùng).
- Filter vẫn có `resourceId` + `identifier` (đi index), nguyên tử như run 81.

### Chốt 4 — DEBT-535/536: oracle phía server thay cho header Playwright

- Proxy X3 đã là chỗ đo cookie theo tên (`/__x3_echo`, run 73). Thêm ghi tên cookie của `GET /authorize?request_id=…` theo `request_id` + probe `/__x3_seen`. Assert universal: cả 6 ô ca 1 phải thấy `__Host-idp_authz` và `__Host-idp_session` ở phía server ⇒ ô WebKit cross-site không còn chỉ "ghi nhận".
- Giữ assert theo header trình duyệt, thu hẹp miễn trừ đúng như DEBT-536 (chỉ WebKit + cross-site + rỗng). Làm cả hai vì oracle proxy là bằng chứng chính, header trình duyệt vẫn bắt hồi quy sớm ở 5 ô còn lại.
- Ranh giới: probe chỉ trong proxy test (127.0.0.1, không dùng ngoài X3), chỉ tên, bộ nhớ có giới hạn, không log, không ghi `request_id` hay giá trị vào `x3-matrix.json`.

## Kiểm từng ứng viên trên code hiện tại (develop `9a1fbc9`)

Không ứng viên nào đã được sửa gián tiếp ⇒ không đóng debt nào bằng bằng chứng.

| Debt | Trạng thái code | Quyết định |
|---|---|---|
| 538 | `admin.dto.ts:34` `SCOPE_TOKEN = /^\S+$/`; JS `\s` không gồm U+200B/U+202E/U+00AD ⇒ lọt; dùng ở `:119` (client), `:193`, `:204`, `:220` (resource) | **Chọn T1**: bảo mật/đầu vào (scope vô hình/giả dạng trong UI admin và màn consent), rẻ, test được |
| 533 | `redirect-uri.validator.ts:33,40,44,52,59` còn `: ${uri}`; `client.service.ts:160,167,460` cùng lớp; `admin.mappers.ts:234` đưa `err.message` ra 400 | **Chọn T2**: exposure, rẻ, cùng mẫu DEBT-532 |
| 537 | `resource.service.ts:99-104` nhánh `[]` chỉ `$size: 0` / `$exists: false` | **Chọn T3**: đúng đắn dữ liệu (resource `null` không bao giờ lưu được từ fe-admin) |
| 535/536 | `e2e/x3/cookie-matrix.spec.ts:176` miễn mọi WebKit có header rỗng; `tls-proxy.mjs` chưa ghi gì cho `/authorize` | **Chọn T4**: assert bảo mật của DEBT-413 đang có lỗ trên một ô; sửa thuần test |
| 517 | `admin-clients.controller.ts:200-202` chỉ `assertKeepsOwnAccess` cho scopes/resources; BE không lưu `redirect_uri`/version secret console dùng | Hoãn (💭 sau M7): cần đổi mô hình dữ liệu family admin; chỉ admin tự khoá, có runbook khôi phục |
| 134 | `client.service.ts:389` `after = { ...before, ...set }`; schema `timestamps: true` (`client.schema.ts:38`) | Hoãn: fix đúng cần `timestamps:false` + `updatedAt` tường minh trên cả lệnh ghi chính lẫn stamp disable (đường admin grant/disable nhạy cảm nhất của client); fe-admin đọc lại sau settle nên UI đúng. Giá trị thấp so với rủi ro chạm đường đó |
| 193 | Unique chỉ `(provider, providerId)` | Hoãn: unique `(userId, provider)` làm `db:sync-indexes` lỗi trên DB đã có bản trùng; chưa có trang quản lý liên kết |
| 120 | `ui.controller.ts` vẫn 3 `peek` trên `GET /login` | Hoãn: chỉ hiệu năng (2 GET Redis), đụng CSP `form-action` |
| 121 | `reauthAfter` vẫn từ `Date.now()` của `AuthorizeService` | Hoãn: lệch clock nhiều node fail-closed (UX); hướng sửa khi làm: so `session.ref` thay vì thời gian |
| 192 | Federation `authTime = now` | Hoãn: giới hạn đã biết, chưa RP nào cần |
| 534 | | Loại (sau M7, đúng tasks.md) |

## Security design gate

- Tài sản/actor: cấu hình client/resource (scope, URI) do `tenant_admin`/`super_admin` ghi; authz không đổi (resource: super_admin + step-up; client: `admin.write` + `RequireRecentAuth(5)`). T1/T2/T3 không thêm đường ghi mới.
- Invariant: T1 không token nào ngoài ngữ pháp vào DB qua API; T3 ghi chỉ khi `view(stored) == expected`, 409 ⇒ DB và audit không đổi.
- Abuse case: scope vô hình/giả dạng (T1); echo nội dung tấn công vào 400 (T2, dù JSON + text-only ở FE); `$`-injection vào `$expr` (T3, `$literal`); lost-update qua `null` (T3); ô X3 xanh im lặng (T4).
- Failure semantics: không gọi ngoài mới; lỗi Mongo vẫn 5xx (`toAdminError` rethrow), không fail-open. Probe X3 không có ⇒ test đỏ (fail-closed).
- Exposure: T2 bỏ echo; T4 chỉ tên cookie, không giá trị/`request_id` ra file kết quả.

## Điểm mạnh

- 4 task nhỏ, mỗi task có RED trước và mutation cụ thể; module tách biệt (admin DTO, clients validator, resources service, e2e/x3) ⇒ diff không chồng nhau ngoài T1/T2 cùng vùng admin/clients (khác file).
- T1 dùng ngữ pháp chuẩn thay danh sách đen; T3 dùng đúng phép ánh xạ của view thay vì ghép điều kiện vá biên.
- T4 bịt lỗ đo của DEBT-413 bằng hạ tầng proxy đã có, không thêm phụ thuộc.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Lưu ý thực thi (bắt buộc làm đúng):

- [ ] T1: `expectedScopes` giữ quy tắc lỏng ở cả BE lẫn FE; ca sửa resource legacy phải xanh.
- [ ] T1: câu lỗi FE cố định, không echo token.
- [ ] T3: có `$literal`; một điều kiện `$expr` cho cả `[]` lẫn khác rỗng; 409 không audit, DB không đổi.
- [ ] T4: X3 đúng 42 ô; probe chỉ trả tên; không ghi `request_id`/giá trị ra đĩa hay log.
- [ ] Không chạy CLI ghi DB dev `sso-idp`; dữ liệu thô (`scopes:null`, `[null]`, `['zw​']`) chỉ dựng trong DB int `vg-int-*`.

## Đề xuất (không bắt buộc)

- DEBT-539 (mới, 💭): câu lỗi cấu hình client nêu trường + chỉ số mục (`redirectUris[2] …`) để caller API biết dòng nào sai mà không echo giá trị.
- Khi làm DEBT-121: so `session.ref` (phiên mới sau login) thay cho so thời gian giữa 2 clock.
