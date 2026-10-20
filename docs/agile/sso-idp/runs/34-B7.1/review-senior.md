# Senior Review — 2026-10-19 (run 34 B7.1)

## Kết luận: PASS

Không có 🔴. Hai 🟡 mới vào backlog (DEBT-205, DEBT-206). DEBT-204 giữ mức 🟡 và để run 35, lý do ở mục "Đánh giá DEBT-204".

## Tổng quan

Run này gọn và đúng phạm vi tech-lead đã chốt. Khoá chạy đơn chỉ chạm `vg:int-lock`, lấy và nhả đều so giá trị nên không xoá khoá của lần chạy khác. Các test mới chạy song song thật (HTTP qua `Promise.all`/`inject`, Mongo và Redis thật), mỗi test có mutation RED ghi trong log. Sửa INV-15 chỉ 4 dòng, dùng mã lỗi `invalid_target` đã có, không đổi hợp đồng.

Phạm vi review: diff `962cdf3..working tree` gồm `be/test/int-preflight.mjs`, `be/test/int-teardown.mjs`, `be/package.json`, 5 int-spec (9 test), `authorize.service.ts` `resolveResource`, `.github/workflows/ci.yml` job `int`, `security-matrix.md`. Không xem `.github/agents`, `.vscode`, `.mcp.json`, `.claude/`.

Đã tự kiểm:
- `pnpm -C be typecheck`: sạch. `eslint` trên các file thay đổi: sạch.
- `pnpm -C be test:int -- refresh-token session-reflection ui-auth authentication.int authorize.int`: 5/5 suites, 128/128, 39 s. Sau khi chạy, `EXISTS vg:int-lock` = 0.
- Vòng lặp grep tham chiếu ma trận (`LC_ALL=C.UTF-8`): `ok=227 bad=0`.
- Specs dọn Redis theo pattern (`authz_*`, `rl:*`, `sess*`…). Không spec nào `FLUSH*` hoặc xoá `*`, nên các spec không xoá được khoá.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Khoá test:int (state/concurrency)**: `SET NX PX` là atomic. Heartbeat và release dùng Lua so token (`host:pid:uuid`) nên một run cũ không gia hạn hay xoá được khoá đã bị run khác lấy lại. Khi Redis lỗi: probe TCP 2 s, `connectTimeout` 2 s, `maxRetriesPerRequest: 1`, catch sẽ `disconnect`, teardown chỉ cảnh báo. Thêm `--forceExit` nên không treo. Jest không chạy globalTeardown khi globalSetup ném lỗi, nhưng lúc đó khoá chưa được lấy nên không sao. Còn một điểm nhỏ là mất khoá giữa chừng thì không có cảnh báo, xem DEBT-206.
- **INV-10 rotation (R1)**: test có `children(parentId=root) ≤ 1` dựa trên DB nên không phải tautology. Nhánh reuse được kiểm theo `metadata.familyId`; đã xác nhận `refresh-token.service.ts:443` có ghi field này. Mutation bỏ `revokedAt: null` cho 5×200 nên RED.
- **INV-29 / SE12 (logout ∥ /token)**: test dùng `UiController` thật với CSRF hợp lệ và lệch 0..90 ms để phủ cả hai thứ tự. Bất biến được kiểm là `countDocuments({sessionRef, revokedAt:null}) = 0`, và RT trả về (nếu có) thì dùng lại phải ra `invalid_grant`. Log ghi rõ hai lớp phòng thủ che nhau: bỏ một lớp vẫn xanh, bỏ cả hai thì RED 3/3. Như vậy là trung thực và chấp nhận được.
- **INV-27 / AE6 (enumeration)**: so status, body (chỉ che `_csrf` value và CSP `nonce`) và tên các Set-Cookie. Các cặp so đều có nghĩa: unknown/wrong/unverified ở `/login`, new/taken ở `/register`, known/unknown ở `/forgot`, used/unknown ở `/verify-email`. Login unknown so với sai mật khẩu dùng hai email khác nhau mà body vẫn giống nhau, nên đồng thời xác nhận trang không phản chiếu email. Mutation "đã tồn tại ⇒ 400" cho kết quả RED.
- **AE4**: kiểm cả bốn điểm: 401 generic, không có cookie `idp_session`, không có session và đúng 2 `AUTH_LOGIN_FAILED`. Sau khi verify thì đăng nhập được.
- **AE8**: N=5 qua service trên Mongo thật. Kết quả đúng 1 fulfilled, 4 bị từ chối với cùng một thông điệp, `users.verifyEmail` được gọi 1 lần và có 1 audit.
- **INV-15 (boundary input)**: `typeof raw !== 'string'` ⇒ `AuthorizeRedirectError('invalid_target')`. Lệnh này chạy sau Phase 1 nên redirect_uri đã được tin và có kèm `state`/`iss`. Hướng này đúng RFC 8707 §2 (AS không hỗ trợ nhiều resource thì trả `invalid_target`). Không hồi quy: nhánh `resume()` truyền `ctx.resource` là string, các test `authorize`/`admin-target-risk` vẫn xanh. Fastify dùng parser querystring của Node nên chỉ sinh string hoặc mảng, không sinh object lồng nhau, và check `typeof` phủ cả hai trường hợp. `/token` đọc form qua `Map<string,string>`, nên không bị ảnh hưởng.
- **Exposure**: lỗi 500 ở `/authorize` đi qua `HtmlExceptionFilter`, chỉ hiện "Something went wrong.", không lộ stack.
- **CI**: `permissions: contents: read` giữ nguyên, không dùng secrets, không đặt `TEST_*`. Lệnh giống local (`pnpm -C be test:int`). Int-spec không đọc `be/.env` hay `be/keys`; grep `process.env` trong int-spec chỉ ra các biến `TEST_*`, và chúng có giá trị mặc định localhost khớp với port của service. Dòng ghi chú `rs.initiate` có backtick nhưng nằm trong comment YAML nên vô hại.
- **Ma trận**: lấy mẫu A2, R1, R2, SE4, SE12, AE4, AE6, AE8, MX1, INV-3, INV-15, INV-21, INV-27, INV-29. Các test được dẫn kiểm đúng invariant ghi ở dòng tương ứng. Số INV khớp spec §15 (1–29, INV-24 tách thành a/b). Ở INV-21 (public client bắt buộc PKCE), test `clients.int-spec › public client cannot authenticate via client_secret_post` chỉ là bằng chứng phụ, nhưng dòng này vẫn đủ nhờ test thứ nhất (thiếu `code_challenge_method` dùng client public).

## Đánh giá DEBT-204 (tham số lặp ở `/authorize`): giữ 🟡, KHÔNG phải 🔴

Lý do (đọc `AuthorizeService.handle`/`AuthorizeController`):
- `scope` lặp (và cả `prompt` lặp) gây TypeError ⇒ 500. Đây là **fail closed**: không có code, không có context, trang lỗi chung. Kẻ tấn công chỉ làm hỏng request của chính mình, không có hiệu ứng lên người dùng khác và không ghi trạng thái.
- `client_id` lặp ⇒ Mongoose `$in` chọn client khớp trước. Nhưng `redirect_uri` vẫn phải khớp chính xác với client đó, còn consent và code đều gắn `client.clientId` từ document. Như vậy request chỉ tương đương một request hợp lệ của client đó, không thành confused deputy.
- `state`/`nonce` lặp ⇒ giá trị bị nối thành chuỗi/mảng. RP so `state`/`nonce` thì thấy lệch và từ chối. Không lộ dữ liệu, không leo thang quyền.
- `redirect_uri` lặp ⇒ trang lỗi 400. `code_challenge`/`max_age`/`response_type` lặp ⇒ 302 lỗi.
- Không có đường nào dẫn tới bypass, cross-tenant, replay, mất dữ liệu hay rò secret, nên không đủ ngưỡng 🔴. Việc chọn mã lỗi và thứ tự kiểm chạm trust boundary, nên để analyst quyết ở run 35 là hợp lý. Đã ghi bổ sung phạm vi (`prompt`, `nonce` lệch INV-5, `request_id`, `client_id` `$in`) vào **DEBT-205**.

## 🟡 Nên sửa (đã vào backlog, không chặn)

🟡 **[BE] Tham số lặp khác ở `/authorize` (DEBT-205, mở rộng DEBT-204)**
`authorize.service.ts:470` `parsePrompt` gọi `.split` trên mảng ⇒ 500. `nonce` lặp được lưu nguyên mảng vào code, nên ID token mang `nonce` mảng (lệch INV-5).
Vì sao: cùng gốc với DEBT-204 (`AuthorizeParams` là interface, không có validation runtime).
Đề xuất: khi làm DEBT-204, kiểm một lần ở controller rằng mọi tham số là chuỗi đơn, và thêm test cho `prompt`/`nonce`/`request_id`/`client_id`.

🟡 **[test] Mất khoá giữa chừng không được báo (DEBT-206)**
`be/test/int-preflight.mjs` (heartbeat): `EXTEND_LUA` trả 0 nghĩa là khoá đã mất (ví dụ máy ngủ hoặc event loop treo quá 120 s rồi run khác lấy khoá), nhưng kết quả bị bỏ qua.
Vì sao: lần chạy vẫn tiếp tục mà không còn được bảo vệ, và đỏ giả sau đó khó truy nguyên.
Đề xuất: `.then((n) => n === 0 && console.warn(...))`. Làm tương tự ở teardown khi `DEL` trả 0.

## 💭 Nit

- `authorize.service.ts:188`: comment "PKCE S256 is mandatory (spec §9.2, INV-15)" bị gán nhầm, đúng ra là **INV-3**. Từ khi có sửa INV-15 thật ngay bên dưới, nhãn sai này dễ gây nhầm hơn trước.
- `refresh-token.int-spec.ts` R1: `winners ≤ 1` và `usable ≤ 1` đúng ngữ nghĩa, vì có thể có 0 winner khi reuse revoke family kịp. Tuy vậy, nếu `firstRefresh()` hỏng thì hai assertion này qua một cách vô nghĩa. Assertion có giá trị thật là `children ≤ 1`. Cân nhắc ghi rõ điều này trong comment.
- `session-reflection.int-spec.ts` SE12: `expect({round, token, live}).toEqual({...live: 0})` là cách gắn ngữ cảnh vòng cho thông điệp lỗi. Cách này ổn, chỉ hơi lạ mắt. `codes.create({...} as never)` thì che kiểu; nên dùng `Parameters<typeof codes.create>[0]` hoặc thêm field còn thiếu.
- `ui-auth.int-spec.ts` `observable`: chỉ so tên Set-Cookie, không so các header khác như `Cache-Control` hay `Retry-After`. Hiện đủ dùng, có thể mở rộng sau.

## ✂️ Ponytail

- be/test/session-reflection.int-spec.ts:L457: shrink: `expect({round,token,live}).toEqual({round,token,live:0})`. Có thể thay bằng `expect(live).toBe(0)` và dồn ngữ cảnh vòng vào tên vòng lặp, nhưng giữ cũng được vì nó cho thông điệp lỗi rõ.
- be/test/int-teardown.mjs:L1: lean. Import `LOCK_KEY` từ preflight thay vì lặp hằng là hợp lý.

net: -1 lines possible. Lean already. Ship.
