# Run 82 — sweep 🟡/💭 còn lại đợt 2 (M7, lane BE + FE/E2E)

Nguồn: backlog — debt còn mở sau run 81. Analyst bỏ qua. Quyết định: người dùng ủy quyền orchestrator chốt theo tiêu chí production (`plan.md` §12); tech-lead chốt luôn điểm mở.

## Ứng viên (tech-lead chọn lô ≤ 6, ưu tiên bảo mật rồi đến đúng đắn dữ liệu)
- Bảo mật/đầu vào: DEBT-538 (scope token nhận ZWSP/bidi, parity FE), DEBT-533 (redirect-uri validator echo URI trong 400), DEBT-517 (console tự khoá qua redirect URI / secret version — 💭, có thể chỉ tài liệu + guard một phần).
- Đúng đắn dữ liệu: DEBT-537 (`expectedScopes: []` không khớp `scopes: null`), DEBT-134 (PATCH client trả `updatedAt` cũ), DEBT-193 (nhiều FI cùng provider/user).
- Auth: DEBT-120 (`/login` peek context 3 lần), DEBT-121 (`reauthAfter` vs `authTime` khác clock), DEBT-192 (federation `authTime = now`).
- E2E: DEBT-535 + DEBT-536 (X3 ca 1 WebKit cross-site: đo tên cookie phía proxy `tls-proxy.mjs`, thu hẹp miễn trừ).
- Loại: DEBT-534 (sau M7).

## Yêu cầu chung
- Mỗi task: AC cụ thể, test RED trước fix, mutation cho nhánh bảo mật/fail-closed.
- Kiểm code hiện tại — debt cũ có thể đã được sửa gián tiếp (khi đó đóng với bằng chứng).
- Nếu chạm cookie/luồng login/X3: X3 phải giữ 42 ô.
- Không chạy CLI ghi vào DB dev `sso-idp`; không `npx` gói chưa cài.

## Gate
typecheck/lint, unit be, int full (`vg-int-*` không tăng), fe-admin test, E2E 38, X3 42 — tuần tự.

## Fold tech-lead (2026-11-10)

Kết luận: **PASS**, lô 4 task (lý do, chọn/loại, quyết định: `review-techlead.md`). Kiểm trên develop `9a1fbc9`: không ứng viên nào đã được sửa gián tiếp ⇒ không đóng debt nào bằng bằng chứng.

Thứ tự / song song: **backend-dev** làm T1-BE → T2 → T3 (tuần tự, cùng vùng admin/clients/resources). **frontend-dev** làm T1-FE và T4 song song với backend-dev ngay từ đầu (hợp đồng đã chốt, unit FE không phụ thuộc BE). Gate X3 của T4 chạy sau khi diff BE xong. Gate chung tuần tự như mục "Gate" ở trên.

### T1 — DEBT-538: scope token theo đúng ngữ pháp RFC 6749 §3.3 [BE] + [FE]

Hợp đồng: `scope-token = 1*( %x21 / %x23-5B / %x5D-7E )` ⇒ `SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/` (ASCII hiển thị, trừ `"` và `\`). Mọi ký tự khác (Cc/Cf/Z, ZWSP, bidi, soft hyphen, chữ ngoài ASCII) ⇒ 400 của ValidationPipe như hiện hành.

- [x] [BE] `be/src/modules/admin/admin.dto.ts:34` đổi `SCOPE_TOKEN`; áp cho `ClientFieldsDto.scopes` (POST + PATCH client), `CreateResourceDto.scopes`, `UpdateResourceDto.scopes`.
- [x] [BE] `UpdateResourceDto.expectedScopes` **KHÔNG** dùng ngữ pháp mới: giữ quy tắc lỏng cũ (`/^\S+$/`, ≤ 256 ký tự, ≤ 50 mục) dưới tên riêng (vd. `STORED_SCOPE_TOKEN`) ⇒ admin vẫn sửa được resource đang lưu scope cũ không hợp lệ (gửi `scopes` sạch + `expectedScopes` = giá trị cũ). Mô tả OpenAPI nêu rõ.
- [x] [BE] `runbook-ops.md`: 1 mục ngắn, truy vấn **chỉ đọc** (mongosh) tìm `clients`/`resources` có scope ngoài ngữ pháp; lần sửa kế tiếp của trường đó sẽ 400 cho tới khi dọn. Không migration tự động.
- [x] [FE] `fe-admin/src/features/resources/resource-form-schema.ts` (`scopesText`), `fe-admin/src/features/clients/client-form-schema.ts` (`scopeTokens`), `fe-admin/src/features/admin-api/inputs.ts` (`resourceScopes`; thêm regex cho client `scopes` ở dòng 38) dùng cùng regex; câu lỗi cố định, không echo token (vd. `Scopes may only use visible ASCII characters other than " and \`). `expectedScopes` ở `inputs.ts:102` và `EditResourceDraftSchema` giữ quy tắc lỏng (parity với BE). — frontend-dev: `SCOPE_TOKEN`/`SCOPE_TOKEN_MESSAGE` export ở `inputs.ts`, dùng ở 2 form + server fn client/resource; `expectedScopes` = `storedResourceScopes` (`/^\S+$/`); test `fe-admin/test/scope-token.test.ts` (RED 20/23 trước fix), parity cập nhật; M1/M3/M4/M5/M6a/M6b đều RED.
- [x] [FE] Nếu test drift OpenAPI/`schema.d.ts` đỏ do mô tả DTO đổi: sinh lại bằng script hiện có (không sửa tay). — frontend-dev: backend-dev đã sinh lại `openapi/admin.json` + `schema.d.ts` (mô tả `expectedScopes`); fe-admin typecheck/test xanh sau đó, không sửa tay.
- AC: POST/PATCH client và POST/PATCH resource với từng token `zw​`, `a‮b`, `a­b`, `a"b`, `a\\b`, `a\u007Fb`, `café`, `a b` ⇒ 400, DB không đổi, không audit success. Token ``!#$%&'()*+,-./:;<=>?@[]^_`{|}~``, `admin.read`, `urn:x:y/z` ⇒ 2xx. Resource lưu thô `['zw​']` ⇒ PATCH `{scopes:['ok'], expectedScopes:['zw​']}` ⇒ 200. FE: form tạo/sửa resource và client báo lỗi trường scopes với cùng bộ ca, không gọi server; `resource-form-parity.test.ts` phủ ngữ pháp mới.
- RED trước: int (vd. `be/test/run82-scope-token.int-spec.ts`) PATCH resource `scopes:['zw​']` ⇒ hiện 200 ⇒ RED; test schema FE với `zw​` ⇒ hiện hợp lệ ⇒ RED.
- Mutation: M1 trả `SCOPE_TOKEN` về `/^\S+$/` ⇒ RED; M2 bỏ `@Matches` ở `UpdateResourceDto.scopes` ⇒ RED; M3 áp ngữ pháp mới cho `expectedScopes` ⇒ ca sửa legacy RED; M4/M5/M6 bỏ regex ở từng schema FE ⇒ RED.

### T2 — DEBT-533: thông điệp cố định cho lỗi cấu hình client [BE]

- [x] `be/src/modules/clients/redirect-uri.validator.ts:33,40,44,52,58-60` bỏ `: ${uri}`: `redirect_uri must not contain a wildcard`, `redirect_uri must be an absolute URI`, `redirect_uri must not contain a fragment`, `redirect_uri host contains an invalid character`, `redirect_uri must use https (http://localhost only allowed outside production)`.
- [x] Cùng lớp, cùng đường `toAdminError` ⇒ làm luôn: `client.service.ts:159-161,166-168` (`validateCorsOrigin`: `allowedCorsOrigins entry must be an exact origin`, `allowedCorsOrigins entry must use https (http://localhost only outside production)`), `client.service.ts:459-461` (`allowedResources entry is not a known resource`).
- [x] Seed (`seed.ts:105-106`, `seed-dev.ts:96-97`) không đổi code (lỗi CLI của operator; câu cố định là đủ).
- AC: qua API, POST và PATCH `/admin/clients` với payload chứa `MARK` (html, path, ký tự điều khiển, chuỗi dài) cho `redirectUris`, `postLogoutRedirectUris`, `frontchannelLogoutUri`, `allowedCorsOrigins`, `allowedResources` ⇒ 400 `invalid_request`, `error_description` **bằng đúng** câu cố định của nhánh, không chứa `MARK`; DB không đổi, không audit success. fe-admin không đổi (test FE dùng message mock).
- RED trước: int "`error_description` không chứa `MARK`" cho từng nhánh ⇒ hiện RED.
- Mutation: thêm lại `${uri}` / `${origin}` / `${missing}` vào bất kỳ một nhánh ⇒ RED.

### T3 — DEBT-537: `expectedScopes` khớp đúng như view admin [BE]

Hợp đồng: khớp khi `ifNull(stored.scopes, []) == expectedScopes` (chính xác, có thứ tự), đúng phép ánh xạ `toAdminResource` (`r.scopes ?? []`). `[]` khớp field vắng, `null`, `[]`; không bao giờ khớp mảng khác rỗng (kể cả `[null]`).

- [x] `be/src/modules/resources/resource.service.ts:99-104` thay cả hai nhánh bằng một điều kiện `{ $expr: { $eq: [{ $ifNull: ['$scopes', []] }, { $literal: expectedScopes }] } }` trong filter nguyên tử (cùng `resourceId`, `identifier`). **Bắt buộc `$literal`**: scope bắt đầu bằng `$` là token hợp lệ theo RFC và không được bị đọc thành field path. Nhánh `exists` ⇒ 409 giữ nguyên; `expectedScopes` vắng ⇒ không thêm điều kiện.
- AC (int): lưu thô `scopes:null` ⇒ PATCH `{scopes:['x'], expectedScopes:[]}` ⇒ 200, DB `['x']`, 1 audit success; field vắng ⇒ 200 (hồi quy); `[]` ⇒ 200; lưu `['a']` + kỳ vọng `[]` ⇒ 409; lưu thô `[null]` + kỳ vọng `[]` ⇒ 409; lưu `['a','b']` + kỳ vọng `['b','a']` ⇒ 409; lưu `['$resourceId']` + kỳ vọng `['$resourceId']` ⇒ 200; resource có `resourceId = R`, lưu `['R']`, kỳ vọng `['$resourceId']` ⇒ 409; `expectedScopes` vắng ⇒ last write wins như cũ. Mọi 409: DB không đổi, không audit.
- RED trước: ca `scopes:null` ⇒ hiện 409 ⇒ RED.
- Mutation: M1 filter cũ ⇒ ca null RED; M2 bỏ `$literal` ⇒ 2 ca `$resourceId` RED; M3 dùng `{scopes: null}` hoặc `$in: [null, []]` ⇒ ca `[null]` RED.

### T4 — DEBT-535 + DEBT-536: X3 ca 1 đo cookie resume phía proxy [E2E]

- [x] `e2e/x3/tls-proxy.mjs`: request host IdP, `GET /authorize` có `request_id` ⇒ ghi **tên** cookie (sắp xếp, không giá trị) vào `Map` trong bộ nhớ theo `request_id`, ≤ 256 mục (FIFO), không log, không ghi đĩa; vẫn forward bình thường. Probe test-only `GET /__x3_seen?request_id=<id>` trên host IdP ⇒ JSON mảng tên (`[]` nếu chưa thấy), `cache-control: no-store`, không forward, không CORS. — frontend-dev: chạy proxy độc lập: ghi tên, probe 200 `no-store` không CORS, id lạ ⇒ `[]`, 257 id ⇒ id đầu bị đẩy, POST không ghi, giá trị cookie không xuất hiện; trước fix probe bị forward (502/404) ⇒ RED.
- [x] `e2e/x3/cookie-matrix.spec.ts` ca 1: `trackIdp` giữ thêm `request_id` của request resume; đọc probe bằng `APIRequestContext` riêng (`ignoreHTTPSErrors`, không mang cookie của context); ghi `c.resumeCookieNamesProxy`. Assert **mọi project × topology**: tên từ proxy chứa `__Host-idp_authz` **và** `__Host-idp_session`. — frontend-dev: X3 42/42 xanh, cả 6 ô ca 1 `resumeCookieNamesProxy` chứa `__Host-idp_authz` + `__Host-idp_session` (WebKit cross-site: header trình duyệt `[]`, proxy đủ); `x3-matrix.json` 0 `eyJ`, 0 `request_id`; mutation proxy bỏ authz ⇒ 6/6 đỏ, khôi phục sha256 khớp.
- [x] Assert theo header trình duyệt giữ lại, miễn trừ thu hẹp đúng DEBT-536: `!(project === "webkit" && rp.topology === "cross-site" && resume.length === 0)`; nhánh miễn trừ vẫn bị oracle proxy ép. — frontend-dev: `resumeHeaderUnreported(project, topology, names)`; kiểm predicate: chỉ ô WebKit same-site rỗng khác giữa bản hẹp (không miễn) và bản nới (miễn).
- AC: X3 giữ **42 ô**; cả 6 ô ca 1 có `resumeCookieNamesProxy` chứa 2 tên; `x3-matrix.json` không chứa giá trị cookie hay `request_id`.
- RED trước: assert proxy viết trước khi proxy có probe ⇒ `/__x3_seen` đi tới BE ⇒ 404 ⇒ RED.
- Mutation: proxy bỏ `__Host-idp_authz` khỏi tên ghi nhận ⇒ RED cả 6 ô; nới miễn trừ về `project === "webkit"` (bỏ topology) ⇒ chứng minh bằng một kiểm predicate (unit nhỏ hoặc ghi tay vào summary) rằng ô WebKit same-site header rỗng không còn được miễn.

### Không làm run này
DEBT-517, 134, 193, 120, 121, 192 (hoãn, lý do ở `review-techlead.md`); DEBT-534 (sau M7). Debt mới: DEBT-539.
