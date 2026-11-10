# Senior Review — 2026-11-10 (run 81, sweep-mixed)

## Kết luận: PASS

Không có 🔴. Một 🟡 mới (DEBT-536, siết điều kiện ghi-nhận X3), DEBT-535 giữ 🟡 (lý do bên dưới).

## Tổng quan (ấn tượng chung + điểm tốt)

Diff gọn, bám fold, mỗi task có test RED + mutation có ghi lại. Kiểm lại tại chỗ (2026-11-10): `pnpm -C be test` 806/806; `pnpm -C be test:int` lọc `authorize[.]int|federation[.]int|admin-api[.]int|redis-down` 282/282 (4 suite); `pnpm -C fe-admin typecheck` 0; `pnpm -C fe-admin test` 1589/1589 (67 file). Không chạy E2E/X3 (theo yêu cầu).

Điểm tốt:
- T1: so binding nằm **trong Lua trước DEL** (`authorize-request-context.service.ts` `CONSUME_LOGIN_SCRIPT`), nên người cầm URL không đốt được context của nạn nhân. `ARGV[1] == ''` và `d.bindingHash == nil` đều không bao giờ khớp. Context `consent` vẫn bị tiêu thụ như trước (DEBT-122 giữ nguyên).
- T1 controller: resume truyền `existing ? sha256(existing) : undefined` chứ không dùng giá trị mới sinh, có comment giải thích. `|| undefined` chặn cookie rỗng. Chỉ đọc tên cookie của mode hiện tại (`hostCookieName`), nên prod không nhận tên `idp_authz` trần do cookie tossing đặt vào (ca 1s).
- T1 test helper: 12 file int chỉ **mang cookie** của 302 `/authorize` (`authzBinding` trong `oauth-fixtures.ts`, `cookieOf(...)` trong `seed.int-spec.ts`). run75 (e) gọi service trực tiếp với cùng `binding` cho `handle` và `resume`. Không có nhánh nào phía server chỉ dành cho test. b74 còn thêm giá trị binding vào danh sách "không được xuất hiện trong log": tốt.
- T3 BE: điều kiện `expectedScopes` nằm trong filter của `findOneAndUpdate` (nguyên tử). `exists()` sau đó chỉ để phân biệt 404 với 409 (không có endpoint DELETE nên không có race đáng kể). 409 dùng câu cố định, không trả scopes hiện tại, không audit. Kiểm admin.* vẫn chạy trước.
- T2: sửa ở nguồn, không thêm lớp bọc.
- T4: một dòng, đúng gốc lỗi (Chrome bỏ `:00` ⇒ `fill` đọc lại khác).

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / binding (T1)**: thiếu cookie, cookie khác, context cũ không có `bindingHash` ⇒ 400 "Request expired", không `Location`, body không có `state`/`redirect_uri`, context vẫn còn (ca 3, 4). Có test mutation cho từng vế. Cookie 256-bit CSPRNG nên không đoán được; mismatch không tiêu thụ gì nên không có oracle đốt context.
- **Concurrency**: 2 resume đúng cookie ⇒ đúng 1 code (ca 6, Lua atomic). 2 PATCH cùng `expectedScopes` ⇒ 1 lần 200, 1 lần 409 (T3 ca 6, filter atomic).
- **Chuỗi request**: cookie chỉ được set khi `login_required` và dùng lại giá trị (ca 1, 1b, 5 nhiều tab). Federation callback là `GET` top-level (`federation.controller.ts:121`), nên cookie Lax đi kèm trên 302 tới resume (fed ca 8). Resume rơi lại `login_required` thì context mới gắn đúng hash cũ.
- **Failure**: Redis down ở cửa resume ⇒ 503, không biến thành "Request expired" (thêm hàng trong `redis-down.int-spec.ts`). Mongo lỗi ở PATCH ⇒ 5xx như cũ (`.catch` → `toAdminError` trả lại lỗi lạ nguyên vẹn).
- **Exposure**: Redis chỉ giữ sha256; cookie HttpOnly, không vào URL/HTML. Access log đã redact `req.headers.cookie` và `res.headers["set-cookie"]` (`logger.module.ts`). 409 và hai câu của T2 đều cố định.
- **AuthZ (T3)**: guard, `@SuperAdminOnly`, step-up không đổi. Ca 8 xác nhận refusal admin.* vẫn chạy trước điều kiện mới.

### Nhận định riêng: X3 ca 1, ô WebKit cross-site chỉ ghi nhận (DEBT-535)

**Lập luận đúng.** Oracle ở đây là chính BE:
- Resume (`GET /authorize?request_id`) chỉ cấp code khi có cả phiên hợp lệ lẫn binding khớp. Điều này đã chứng minh ở int test, kèm mutation Lua bỏ so sánh ⇒ ca 1s/3/4/fed 8 đỏ.
- Nếu thiếu binding, trang là 400 không `Location`. Nếu thiếu phiên, kết quả là `login_required` và quay lại `/login`. Cả hai đường đều không tới được claims panel, và vòng `login()` sẽ hết 30 s rồi đỏ.
- Vì vậy "đạt claims" kéo theo "trình duyệt đã gửi cả `__Host-idp_session` lẫn `__Host-idp_authz`". Header rỗng hoàn toàn, kể cả cookie phiên mà BE bắt buộc phải có, chỉ giải thích được bằng lỗ báo cáo của `request.allHeaders()` trên request theo redirect của WebKit-Windows.
- Phần mất đi chỉ là quan sát phía trình duyệt, còn bất biến vẫn được kiểm. Nới như vậy chấp nhận được cho run này. **DEBT-535 giữ 🟡, không phải 🔴.**

Điều kiện hiện tại hơi rộng (DEBT-536 bên dưới).

**Cách xác nhận phía server rẻ:**
1. **Ngay bây giờ, không sửa code.** Access log pino của BE X3 ghi mỗi request `req.method` và `req.url` (đã bỏ query), kèm `res.statusCode` và `location` (đã bỏ query) (`serializeRequest`/`serializeResponse`, `logger.module.ts`). Trong ô WebKit cross-site, tìm dòng `POST /login → 302 location /authorize`, ngay sau đó phải là `GET /authorize → 302` với `location` là đường callback của RP, không phải `/login` và không phải `400`. Như vậy là chứng minh phía server rằng resume thành công. Cách này dùng được nếu runner X3 giữ stdout của BE. Tên cookie thì log không có, vì đã redact có chủ đích.
2. **Để ô này assert được (sửa DEBT-535).** `e2e/x3/tls-proxy.mjs` đã thấy `req.headers.cookie` trên mọi request forward (cùng cách `/__x3_echo` đang lấy tên). Ghi **tên** cookie của `GET /authorize?request_id=` vào một file JSONL trong `test-results/`, rồi để spec đọc file đó thay cho `allHeaders()` ở ô này. Cách này không đụng BE và không lộ giá trị cookie.

## 🟡 Nên sửa

- [ ] **DEBT-536** `e2e/x3/cookie-matrix.spec.ts:176`: miễn trừ quá rộng.
  - Điều kiện `testInfo.project.name !== "webkit" || resume.length > 0` miễn cho **mọi** ô WebKit có header rỗng, kể cả same-site. Lý do được ghi lại (và DEBT-535) chỉ nói tới cross-site.
  - Vì sao cần sửa: nếu sau này WebKit same-site cũng báo header rỗng (thật hoặc do lỗi), test vẫn xanh im lặng, và cell không còn bằng chứng mà không ai biết.
  - Đề xuất: thu hẹp thành `!(project === "webkit" && rp.topology === "cross-site" && resume.length === 0)`. Ở nhánh ghi nhận, nên assert thêm `c.outcome` hoặc claims đã thấy, vì đó chính là oracle mà lập luận dựa vào.

### Hai chỗ frontend-dev lệch fold: cả hai đúng

1. **`expectedScopes` đọc từ draft lúc lưu, không chốt lúc mount.** `useStepUpDraft` (`step-up.ts:81-89`) bắt đầu bằng `null` và chỉ `setDraft` trong `useEffect`, tức là sau lần render đầu. Bản fold `useState(() => draft?.expectedScopes ?? resource.scopes)` vì vậy sẽ **luôn** thấy `null` và chốt `resource.scopes` lúc mount sau step-up, tức giá trị đã refetch. Hậu quả là một lần ghi đè im lặng, đúng lost-update mà DEBT-323 muốn chặn. Đọc lúc lưu (`savedScopes ?? draft?.expectedScopes ?? mountScopes`) là cách sửa đúng. `draft` không bị xoá trong suốt vòng đời component nên giá trị ổn định. Test step-up (`resources-ui.test.tsx:455-478`) có phân biệt được: server đổi thành `["changed"]` nhưng PATCH vẫn gửi `["read","write"]`.
2. **Lần lưu thành công gần nhất trở thành base kế tiếp.** Nếu không làm vậy, lần lưu thứ 2 trong cùng form sẽ gửi giá trị lúc mount ⇒ 409 giả với chính mình. `saved.scopes` là giá trị BE vừa ghi (`after = {...before, scopes}`), nên dùng làm kỳ vọng là đúng. Có test (calls[1] gửi `expectedScopes: ["write","read"]`).
- Sau `unsure`/409, form dùng `resource.scopes` (giá trị đọc lại đang hiển thị), đúng fold. Nếu refetch chưa về kịp thì lần lưu chỉ 409 thêm một lần (fail closed), không ghi đè.

## 💭 Nit

- `be/src/modules/admin/admin.mappers.ts:239-241`: câu 409 lặp lại literal đã có trong `ConcurrentResourceUpdateError`. Hiện vẫn khớp nhau; nếu muốn một nguồn thì có thể dùng `err.message` như nhánh `ConcurrentClientUpdateError`. Literal cũng có lý do riêng ("câu cố định ngay tại mapper"), nên không bắt buộc.
- `be/src/modules/admin/admin.spec.ts:12-15`: import `class-transformer`/`class-validator` chen giữa các import nội bộ. Chỉ là thứ tự import.

## ✂️ Ponytail

Lean already. Ship.
