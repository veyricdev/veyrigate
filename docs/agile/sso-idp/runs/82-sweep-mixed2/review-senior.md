# Senior Review — 2026-11-10

## Kết luận: PASS

Không có 🔴. Hai 💭 vào backlog (DEBT-546, DEBT-547). Chuyển **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)

Diff nhỏ và đúng phạm vi 4 task. Điểm tốt:
- Tách hai quy tắc: `SCOPE_TOKEN` cho dữ liệu mới, `STORED_SCOPE_TOKEN` cho dữ liệu đã lưu. Nhờ vậy resource có token cũ vẫn sửa được, mà không có đường nào để ghi thêm token xấu.
- `$literal` đi kèm test cho cả hai hướng `$resourceId`. Mutation bỏ `$literal` làm test đỏ.
- Câu lỗi FE cố định (`SCOPE_TOKEN_MESSAGE`), không echo token. Token có thể vô hình hoặc giả dạng, nên echo nó ra không giúp được người dùng.
- Probe X3 chỉ trả về tên cookie. Ô WebKit cross-site, trước đây chỉ được ghi nhận, giờ có oracle phía server.

Đã chạy lại (cùng máy):
- `pnpm -C be test:int run82-backend`: 116/116.
- be unit: 806/806.
- fe-admin typecheck: 0.
- fe-admin test: 68 file, 1613/1613.

Không chạy E2E/X3, theo yêu cầu.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

### T1 — DEBT-538: scope token

**Boundary input.** `admin.dto.ts:37` áp `@Matches(SCOPE_TOKEN, { each: true })` cho đủ 3 chỗ:
- client scopes (`:127`, dùng chung cho POST và PATCH qua `ClientFieldsDto`);
- `CreateResourceDto.scopes` (`:202`);
- `UpdateResourceDto.scopes` (`:213`).

`expectedScopes` (`:230`) dùng quy tắc lỏng. Điều này an toàn vì `expectedScopes` không bao giờ được ghi xuống DB: nó chỉ là toán hạng so sánh trong filter. Không còn đường nào qua API để ghi token ngoài ngữ pháp.

**Seed, fixture và caller hiện có: không vỡ.** Đã grep `be/src/database/seed.ts`, `seed-dev.ts`, `e2e/tests`, `e2e/x3` và `fe-sso-test/src`. Mọi scope đều là ASCII hợp lệ: `openid`, `profile`, `email`, `offline_access`, `admin.read`, `admin.write`, `e2e.*`. Scope dạng URL như `https://api.x/read` hay `urn:x:y/z` vẫn hợp lệ, vì `:` và `/` nằm trong `%x23-5B`, và AC cũng đã phủ `urn:x:y/z`. Seed ghi thẳng qua service hoặc model, không đi qua DTO, nên dù sao cũng không bị chặn.

**FE parity.** `inputs.ts:32` khớp đúng regex của BE. Bỏ `.min(1)` ở `resourceScopes` vẫn tương đương, vì `+` đã đòi ít nhất 1 ký tự. `storedResourceScopes` giữ `/^\S+$/`, khớp `STORED_SCOPE_TOKEN`.

**Runtime không đổi.** `/authorize` và `/token` không dùng `SCOPE_TOKEN` (grep chỉ ra `admin.dto.ts`). Dữ liệu cũ vẫn chạy, chỉ lần sửa kế tiếp bị 400. Đây là fail-closed ở phía ghi.

**DEBT-545 không chặn.**
- Lỗi xảy ra phía client và hiện ngay ở trường scopes. Cách gỡ là dọn scopes trong cùng form, và client không cần `expectedScopes`.
- Không mất dữ liệu, không lộ gì, không bypass được gì.
- Hiện chưa có dữ liệu thật nào bị ảnh hưởng: chỉ ghi thô vào Mongo mới tạo ra được token xấu, vì API trước run 82 đã từ chối khoảng trắng; ZWSP/bidi thì qua được.
- Giữ ở mức 💭 là đúng.

**Runbook §8 đủ dùng trước deploy, kèm một 💭.**
- Truy vấn chỉ đọc. `$elemMatch: { $not: <regex> }` trên mảng scalar bắt được cả phần tử không phải chuỗi (`[null]`). Dev đã thử trên `vg-test-mongo`.
- Thiếu sót nhỏ: Mongo dùng PCRE, nên `$` cũng khớp *trước* một `\n` ở cuối chuỗi. Token `abc\n` sẽ lọt truy vấn này, trong khi JS (DTO) từ chối nó. Ngoài thực tế khó xảy ra, vì quy tắc cũ `/^\S+$/` đã chặn `\n`, chỉ dữ liệu ghi thô mới có.
- §8 chưa được nhắc trong checklist deploy, nên dễ bị bỏ qua.
- → DEBT-546.

### T2 — DEBT-533: thông điệp cố định

**Exposure.** 5 nhánh trong `redirect-uri.validator.ts` và 3 nhánh trong `client.service.ts` (`validateCorsOrigin` ×2, `allowedResources`) không còn nội suy giá trị. Test int `MARK` (html, ký tự điều khiển, 1500 ký tự) xác nhận 400 không chứa `MARK` và DB/audit không đổi.

**Hiển thị trên fe-admin vẫn hợp lý.**
- UI hiển thị nguyên `error_description` (`clients-ui.test.tsx:276`; `clients-ui-risk.test.tsx:160` kiểm escape XSS). Câu cố định vẫn đọc được.
- Form tự kiểm từng dòng URI trước khi gửi, với câu lỗi có số dòng (`client-form-schema.ts:38-45`). Vì vậy câu cố định từ BE chỉ xuất hiện khi BE và FE lệch nhau, hoặc ở nhánh `allowedResources` (resource bị xóa song song).
- Mất "dòng nào sai" cho caller API thuần đã có DEBT-539 ghi nhận.

### T3 — DEBT-537: filter `expectedScopes`

**Index và hiệu năng.** Filter là `{ resourceId, identifier, $expr }`. `identifier` có unique index (`resource.schema.ts:9`), nên planner chọn IXSCAN theo `identifier` và `$expr` chỉ được đánh giá trên tối đa 1 document. `$expr` không dùng được index, nhưng ở đây không cần. Không có hồi quy hiệu năng.

**Operator injection.**
- `expectedScopes` qua `@IsArray` + `@IsString({ each: true })` + `ArrayMaxSize(50)` + `MaxLength(256)`, nên object hay `{ $gt: '' }` bị 400 trước khi tới service.
- `$literal` chặn việc chuỗi `$…` bị hiểu là field path hoặc biến (`$$ROOT`), có test 200/409 với `['$resourceId']`.
- Chuỗi bắt đầu bằng `$$` cũng nằm trong `$literal`, nên an toàn.

**Concurrency 200/409.**
- Điều kiện vẫn nằm trong filter của một `findOneAndUpdate` đơn document. WiredTiger đánh giá lại filter khi có write conflict, nên hai PATCH cùng `expectedScopes` chỉ có một cái khớp.
- Test 12 PATCH song song của run 81 nằm trong int full 1793/1793 của backend-dev.
- Ngữ nghĩa `[]`:
  - khớp vắng, `null` và `[]`;
  - không khớp `[null]` hay `['a', null]`;
  - có mutation chứng minh với `$in: [null, []]`.

### T4 — DEBT-535/536: X3 proxy

**Exposure.** `/__x3_seen` trả về `seen.get(request_id) ?? []`, chỉ gồm tên cookie (`cookieNames` cắt ở `=`, rồi sort).
- Không có giá trị nào được ghi vào `seen`. Không log, không ghi đĩa.
- Proxy listen `127.0.0.1` (`tls-proxy.mjs:127`).
- `request_id` chỉ là key trong bộ nhớ và không xuất hiện trong response.
- Spec không đưa `requestId` vào `Cell`, nên `x3-matrix.json` không có nó. Dev đo được 0 `request_id`.
- `playwright.x3.config.ts:54` đặt `trace: "off"`, nên URL probe cũng không vào trace.

**Phạm vi.** Grep toàn repo (trừ `node_modules`/`test-results`) chỉ thấy `__x3_seen` và `__x3_echo` trong `e2e/x3/`. Không có trong `be/src`, `fe-admin/src` hay `fe-sso-test/src`, và không có trong code production.

**Oracle.** Assert proxy chạy ở mọi project × topology. Probe trả `[]` khi `request_id` không tìm thấy, nên `toContain` sẽ đỏ chứ không xanh im lặng. Mutation proxy làm đỏ 6/6 ô. Miễn trừ phía trình duyệt đã thu hẹp đúng `webkit && cross-site && rỗng`.

## 🟡 Nên sửa

Không có.

## 💭 Nit

### DEBT-546: runbook-ops §8

`runbook-ops.md` §8: regex trong mongosh đi qua PCRE, nên `$` khớp trước `\n` ở cuối chuỗi và truy vấn bỏ sót token như `abc\n`.
- Cân nhắc dùng `{ $not: { $regex: '^[\\x21\\x23-\\x5B\\x5D-\\x7E]+\\z' } }`; cần kiểm cú pháp với `$not`, vì `$not` nhận regex object, nên có thể phải dùng `$nor`/`$expr` + `$regexMatch`.
- Hoặc chỉ ghi chú giới hạn này trong runbook.
- Kèm theo: thêm "chạy §8, kết quả rỗng hoặc đã dọn" vào checklist deploy (runbook-deploy), để dữ liệu cũ không làm admin bất ngờ gặp 400 sau deploy.

### DEBT-547: tls-proxy.mjs

`e2e/x3/tls-proxy.mjs:79`: `new URL(req.url, base)` không có try/catch. Một request-target lỗi (vd. absolute-form `http://[`) sẽ ném lỗi trong handler và làm proxy harness sập giữa lượt X3.
- Chỉ ảnh hưởng harness test.
- Cân nhắc `URL.canParse` hoặc try/catch, rồi forward như cũ.

## ✂️ Ponytail

Lean already. Ship.

- `cookieNames` gom lại logic của `/__x3_echo`, không thêm abstraction mới.
- Map FIFO ≤ 256 là cách tối thiểu để giới hạn bộ nhớ.
- Nhánh miễn trừ `resumeHeaderUnreported` vẫn có giá trị như tín hiệu chéo phía trình duyệt, nên không đề xuất xóa.
- `$expr` một điều kiện thay cho 2 nhánh cũ, vừa giảm dòng vừa sửa đúng lỗi `null`.
