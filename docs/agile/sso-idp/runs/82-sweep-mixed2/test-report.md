# Test Report — 2026-11-10 (run 82, tester)

## Kết quả: PASS (be int 1968/1968, be unit 806/806, fe-admin 1613/1613; E2E/X3 KHÔNG chạy — cổng 5173 bận)

Spec mới: `be/test/run82-tester.int-spec.ts` (175 ca, `bootFullApp`, dữ liệu thô chỉ trong `vg-int-run82t-*`). Không sửa code sản phẩm. 0 🔴. Debt mới: DEBT-548, DEBT-549 (💭). DEBT-546 xác nhận là thật (case 6).

## Lệnh đã chạy + output thực tế

1. `pnpm -C be test:int run82-tester` ⇒ `Tests: 175 passed, 175 total` (~30 s).
   Lượt đầu 81 đỏ, rồi 15 đỏ, rồi 6 đỏ: đều do kỳ vọng của tester sai, không phải code:
   - needle `script` trùng với chữ `description`;
   - `''.includes('')`;
   - nhánh lỗi URL tester đoán sai: `a,MARK<b>` không parse được ⇒ absolute; `ftp://` ⇒ https; `MARK\r\nLocation:` ⇒ WHATWG bỏ CR/LF ⇒ scheme `marklocation:` ⇒ https.
   Đã sửa kỳ vọng theo nhánh thật. Body vẫn là câu cố định, không echo giá trị.
2. Mutation (script `scratchpad/mutate.mjs`, backup → thay chuỗi → chạy spec → khôi phục):

   | # | File | Mutation | Kết quả |
   |---|---|---|---|
   | M1 | admin.dto | `SCOPE_TOKEN` → `/^[\x21-\x7E]+$/` (nhận `"` `\`) | 4 đỏ (0x22, 0x5C, mảng lẫn, legacy fixed msg) |
   | M2 | admin.dto | thêm cờ `m` | 6 đỏ (`abc\n`, `\nabc`, `abc\r\n`, `abc\r`, U+2028, mảng lẫn) |
   | M3 | admin.dto | `\x5D-\x7F` (nhận DEL) | 1 đỏ (0x7F) |
   | M4 | admin.dto | blocklist `/^[^\s"\\]+$/` | 14 đỏ (0x7F, 0x80, 0x9F, 0xFF, 0x100, NUL, surrogate, combining…) |
   | M5 | admin.dto | `STORED_SCOPE_TOKEN` = ngữ pháp mới | 10 đỏ (repair ZWSP/bidi/`café`, ma trận `[LEGACY]`) |
   | M6 | admin.dto | client `scopes` dùng quy tắc lỏng | 16 đỏ (client POST/PATCH mọi byte xấu) |
   | M7 | admin.dto | `MaxLength(256)` → 255 | 1 đỏ (ca giới hạn 256) |
   | M8 | redirect-uri.validator | nhánh https thêm `${uri}` | 18 đỏ |
   | M9 | redirect-uri.validator | nhánh absolute thêm `${uri}` | 24 đỏ |
   | M10 | redirect-uri.validator | nhánh fragment ghi `Logger.warn(uri)`, body vẫn cố định | 6 đỏ (chỉ assert pino) |
   | M11 | client.service | CORS https thêm `${origin}` | 4 đỏ |
   | M12 | client.service | allowedResources thêm `${missing}` | 8 đỏ |
   | M13 | resource.service | bỏ `$literal` | 10 đỏ (`$$ROOT`, `$$REMOVE`, `$scopes`, `$identifier`, `$$CURRENT.scopes`, `$a.b`, `$`, repair `$x`) |
   | M14 | resource.service | bỏ `$ifNull` | 4 đỏ (`null`/vắng vs `[]`, 2 ca concurrency) |
   | M15 | resource.service | filter cũ dạng `$in:[null,[]]` | 2 đỏ (`[null]`, `['a',null]`) |
   | M16 | resource.service | bỏ điều kiện `expectedScopes` | ≥ 14 đỏ (mọi ca 409 của `$…` và ma trận) |

   - Lần đầu viết M16 bằng cách bỏ `...expected`: TS6133 không biên dịch (0 test). Đã viết lại bằng `|| true`.
   - Sau toàn bộ: `sha256sum -c` cho `admin.dto.ts`, `client.service.ts`, `redirect-uri.validator.ts`, `resource.service.ts`: cả 4 `OK`, 0 file `*.mutbak`.
3. `pnpm -C be test:int` (full) ⇒ `Test Suites: 64 passed, 64 total`, `Tests: 1968 passed, 1968 total` (= 1793 của dev + 175), 688.9 s.
4. `pnpm -C be test` ⇒ `Test Suites: 43 passed`, `Tests: 806 passed, 806 total`.
5. `pnpm -C be typecheck` ⇒ 0 lỗi. `eslint test/run82-tester.int-spec.ts` ⇒ 0.
6. `pnpm -C fe-admin typecheck` ⇒ 0 lỗi. `pnpm -C fe-admin test` ⇒ `Test Files 68 passed (68)`, `Tests 1613 passed (1613)`.
7. **E2E 38 / X3 42: KHÔNG chạy.**
   - `Get-NetTCPConnection` cho thấy `[::1]:5173` bị node PID 36252 giữ (không phải của chúng ta; frontend-dev cũng ghi nhận). Theo chỉ thị, không dừng tiến trình đó. 4000 và 3000 trống.
   - Bằng chứng X3/E2E còn lại là lượt xanh của frontend-dev (E2E 38/38, X3 42/42) cùng ngày. Diff BE của run 82 không đổi kể từ đó (sha256 ở bước 2).
8. `vg-int-*` trên vg-test-mongo@27117: **4 trước, 4 sau** (4 DB `vg-int-vault-v7-*` cũ, không phải của run này).
9. Runbook-ops §8 trên DB tạm `vg-int-run82t-runbook` (seed rồi drop, kiểm lại không còn): mongosh 7.0.41 chạy đúng truy vấn §8 trên `clients` và `resources`, mỗi collection 17 doc:
   - token hợp lệ;
   - `[]`, `null`, field vắng;
   - ZWSP, bidi, `"`, `\`, `café`, space, `[null]`, DEL;
   - `abc\n`, `\nabc`, `a\nb`, `abc\r\n`, `['ok','abc\n']`.

## Test FAIL (nếu có)

Không có trên code. Hai phát hiện không chặn (💭):

- **Case 6, DEBT-546: xác nhận là THẬT.**
  - Truy vấn §8 nguyên văn bỏ sót `abc\n` và `['ok','abc\n']` (PCRE `$` khớp trước `\n` cuối chuỗi). Nó bắt đúng mọi ca khác, kể cả `\nabc`, `a\nb` và `abc\r\n`, và không báo nhầm token hợp lệ, `[]`, `null` hay field vắng.
  - Thay `$` bằng `\z` (`{ $elemMatch: { $not: /^[\x21\x23-\x5B\x5D-\x7E]+\z/ } }`) là đủ: bắt đủ 13/13 ca xấu, 0 dương tính giả. `$not` nhận regex `\z` bình thường, không cần `$expr`.
  - Tác động thấp: chỉ dữ liệu ghi thô mới có `\n`.
- **DEBT-548: redirect URI chứa CR/LF/TAB thô vẫn được nhận.**
  - `https://app.example.com/cb\r\nSet-Cookie: x=1` và `https://app.example.com/c\tb` ⇒ 201, lưu nguyên chuỗi thô. WHATWG `new URL` bỏ CR/LF/TAB trước khi validator kiểm.
  - Không có header injection: `buildRedirect` đi qua `new URL(...).toString()`, nên ký tự điều khiển bị bỏ. Hệ quả là chuỗi admin thấy khác URL mà code thật sự được gửi tới.
  - Có trước run 82, ngoài phạm vi T2. Ca characterization nằm trong spec, sẽ đỏ khi được sửa.
- **DEBT-549: legacy chứa khoảng trắng/`\n` không sửa được qua `expectedScopes`.**
  - Resource lưu thô `['abc\n']`: `STORED_SCOPE_TOKEN = /^\S+$/` từ chối giá trị đó trong `expectedScopes` ⇒ 400.
  - Chỉ last-write-wins (không gửi `expectedScopes`) mới sửa được. Nhưng fe-admin luôn gửi `expectedScopes` (run 81), nên form fe-admin không sửa được, trái với hướng dẫn §8 "`expectedScopes` = đúng mảng đang lưu".
  - Chỉ dữ liệu ghi thô. Ca nằm trong spec.

## Coverage acceptance criteria

- [x] **T1 AC1:** 4 đường POST/PATCH client và resource × byte biên.
  - Hợp lệ ⇒ 201/200/201/200: 0x21, 0x23, 0x5B, 0x5D, 0x7E.
  - Không hợp lệ ⇒ 400 ×4, DB không đổi, không audit: 0x20, 0x22, 0x5C, 0x7F, 0x80, 0x9F, 0xA0, 0xFF, 0x100.
  - Ca: `byte 0x.. on all 4 paths`.
- [x] **T1 dạng lạ ⇒ 400 ×4** (ca `<shape> => 400 on all 4 paths`):
  - `abc\n`, `\nabc`, `abc\r\n`, `abc\r`, TAB, NUL, U+2028;
  - surrogate lẻ cao/thấp, cặp emoji;
  - combining (`e\u0301`, chỉ combining), fullwidth, BOM, NBSP.
  - Mutation M2 chứng minh `$` của JS không cờ `m` chặn `abc\n`.
- [x] **T1 mảng lẫn 1 mục xấu** ở đầu, giữa, cuối ⇒ 400 ×4.
- [x] **T1 độ dài:**
  - resource 256 ⇒ 201, 257 ⇒ 400 (POST và PATCH); `expectedScopes` 256 ⇒ 200;
  - client 2048 ⇒ 201, 2049 ⇒ 400.
- [x] **T1 phần tử không phải chuỗi** (`''`, `1`, `null`, object, mảng lồng) ⇒ 400 ×4.
- [x] **T1 legacy `/authorize`:**
  - Client và resource lưu thô `zw\u200b`: `/authorize` + `/token` ⇒ 200, `scope` chứa token.
  - PATCH client gửi lại mảng đó ⇒ 400 `invalid_request`. Câu lỗi giống hệt với token `a"b` (cố định), không chứa `zw`, DB không đổi, 0 audit.
  - PATCH resource gửi lại ⇒ 400.
- [x] **T1 repair:** legacy ZWSP, `['ok','a\u202Eb']`, `['$x','café']` ⇒ 200 + 1 audit. `['abc\n']` ⇒ 400 (DEBT-549); last-write-wins ⇒ 200.
- [x] **T2:** 3 trường URI × 10 giá trị độc, cùng CORS ×6 và allowedResources ×4, × POST/PATCH = 80 ca.
  - Giá trị độc: HTML, CRLF, 2 KB, `sk_live_…`, JWT giả, userinfo bí mật, `data:`.
  - Mỗi ca: 400, `application/json`, body **bằng đúng** `{error:'invalid_request', error_description:<câu cố định của nhánh>}`, DB không đổi, 0 audit.
  - Không needle nào xuất hiện trong body hay trong dòng pino của request đó. Có ca chứng minh pino thực sự ghi `/admin/clients`, nên assert log không rỗng nghĩa.
  - Giá trị > 2048 ⇒ 400 của DTO, không echo.
- [x] **T3 `$`/dotted:**
  - `$$ROOT`, `$$REMOVE`, `$scopes`, `$identifier`, `$$CURRENT.scopes`, `a.b`, `['$a.b','c']`, `$`, `$$` lưu đúng giá trị ⇒ 200.
  - `[]`/`null`/vắng vs `['$$REMOVE']`, `['x']` vs `['$scopes']`, `[identifier]` vs `['$identifier']`, `['a.b']` vs `['$a.b']` ⇒ 409.
- [x] **T3 ma trận** stored {`null`, vắng, `[]`, `[null]`, `['a',null]`, `['a']`, `[LEGACY]`} × expected {`[]`, `['a']`, `['a','a']`, `[LEGACY]`} = 28 ca.
  - 200 + 1 audit đúng khi view `scopes ?? []` bằng expected.
  - Ngược lại 409, body = `CONFLICT_BODY` của run 81 (so chuỗi nguyên văn), `cache-control: no-store`, document không đổi, 0 audit.
- [x] **T3 đầu vào độc:** `expectedScopes` = `null`, `[null]`, `{ $ne: [] }`, `[{ $gt: '' }]`, `[['a']]`, `'a'`, `['']`, 51 mục ⇒ 400, DB `null` không đổi.
- [x] **T3 concurrency:** 12 PATCH song song với `expectedScopes: []` trên resource lưu `null` và trên resource field vắng ⇒ đúng 1 ×200, 11 ×409 `CONFLICT_BODY`. DB = scopes của request thắng, 1 audit.

## Coverage security invariants / risk matrix

- [x] **Input** (valid, boundary, malformed, oversized, encoded/injection): T1 byte biên / dạng lạ / độ dài, T2 HTML/CRLF/2 KB, T3 `$`-operator.
- [x] **State** (fresh, stale, already consumed, concurrent):
  - dữ liệu legacy ghi thô;
  - 409 khi stale, DB và audit không đổi;
  - 12 PATCH song song.
- [x] **Exposure** (response, log): T2 body + pino. Mutation M10 chứng minh assert pino bắt được lỗi rò qua log, kể cả khi body vẫn sạch.
- [x] **Authorization:** đường client chạy bằng tenant_admin, resource bằng super_admin. Guard không đổi trong run, actor âm đã phủ ở run 80/81.
- [x] **Dependency:** không đổi trong run. Lỗi Mongo ⇒ 5xx đã phủ ở run 81.
- [ ] **Request chain (cookie, X3):** chưa kiểm lại trong lượt tester vì cổng 5173 bận. Bằng chứng là X3 42/42 của frontend-dev. Phải chạy lại E2E 38 + X3 42 khi cổng trống, trước khi đóng run hoặc ngay sau đó.
