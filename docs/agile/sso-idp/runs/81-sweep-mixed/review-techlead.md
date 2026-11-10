# Tech Lead Review — 2026-11-10 (run 81, sweep 🟡 còn lại, BE + FE/E2E)

## Kết luận: PASS

Lô 4 task (fold chi tiết: `tasks.md` mục "Fold tech-lead (2026-11-10)"):

| Task | Debt | Lane |
|---|---|---|
| T1 | DEBT-413 — context `login` gắn trình duyệt tạo nó (cookie binding) | [BE] + [E2E] (assert X3 ca 1) — **backend-dev** |
| T2 | DEBT-532 — thông điệp cố định cho nhánh format identifier resource | [BE] — **backend-dev** |
| T3 | DEBT-323 — PATCH resource `expectedScopes` + 409 | [BE] **backend-dev** + [FE] **frontend-dev** + [E2E] |
| T4 | DEBT-527 — flake `fe-admin-audit.spec.ts` khi giây = 00 | [E2E] — **frontend-dev** (hoặc backend-dev nếu tiện) |

## Kiến trúc đề xuất

Không đổi kiến trúc (modular monolith NestJS + BFF fe-admin). Hai thay đổi hợp đồng, tech-lead tự chốt theo ủy quyền (`plan.md` §12, tiêu chí production):

### Chốt 1 — DEBT-413: cookie binding cho context `login` (hợp đồng HTTP mới, chỉ BE; RP không đổi)

- **Cookie mới** `idp_authz` (tên `__Host-idp_authz` khi `cookieSecure`, qua `hostCookieName`, cùng quy tắc DEBT-008/505): giá trị CSPRNG (`generateToken`), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` theo config, `Max-Age` = TTL context (600 s). **Một cookie cho cả trình duyệt, không xoay mỗi request** (giống `idp_fed`): có rồi thì dùng lại và chỉ làm mới `Max-Age` ⇒ nhiều tab cùng lúc không phá nhau. Đây là câu trả lời cho lý do hoãn run 80 ("nhiều tab ⇒ cần tập hợp/tên cookie theo request"): không cần tập hợp, vì ràng buộc là "cùng trình duyệt", không phải "cùng tab".
- Set **chỉ** khi outcome là `login_required` (fresh hoặc resume rơi lại vào login). Context `login` lưu `bindingHash = sha256(cookie)` (không lưu giá trị thô; chỉ ở Redis).
- **Resume** dùng script Lua mới `authzCtxConsumeLogin(key, bindingHash|'')`: GET → decode → nếu `kind == 'login'` và (`ARGV[1] == ''` hoặc `bindingHash ~= ARGV[1]`) ⇒ trả nil **KHÔNG DEL**; còn lại DEL + trả giá trị. Lý do so trong Lua trước DEL (cùng mẫu INV-13 của `consumeAuthCode`): kẻ có URL không thể "đốt" context của nạn nhân; context kind `consent` đi nhầm cửa vẫn bị tiêu thụ như hiện hành (test DEBT-122 `authorize.int-spec.ts:785` không đổi).
- Mismatch / thiếu cookie / context cũ không có `bindingHash` ⇒ trang lỗi first-party 400 (`expiredPage`), không `Location`, không `state`, không code, không audit mới. Fail-closed.
- `consume` cũ giữ nguyên cho `decideConsent` (consent đã gắn `sessionRef`, DEBT-123).
- Federation: không đổi; callback 302 về `/authorize?request_id` trong cùng trình duyệt ⇒ cookie có mặt (top-level GET, Lax). Kẻ tấn công dùng `request_id` lộ để chạy leg provider trong trình duyệt của mình vẫn bị chặn ở resume.
- **Rollout**: context đang dở lúc deploy (≤ 10') không có `bindingHash` ⇒ "Request expired", người dùng bắt đầu lại từ RP. Ghi vào summary/runbook-deploy (một dòng), không cần migration.
- X3: cookie mới ⇒ chạy lại đủ 42 ô; ca 1 (login tương tác, same-site + cross-site) thêm assert yêu cầu `GET /authorize` resume mang tên cookie binding. Ca 2 (SSO có phiên) và ca 7 (`prompt=none`) không tạo context ⇒ không đổi.

### Chốt 2 — DEBT-323: `expectedScopes` + 409 (hợp đồng admin API + BFF)

- `PATCH /admin/resources/:id` body nhận thêm `expectedScopes?: string[]` (cùng validator với `scopes`). **Tuỳ chọn** ở BE (client API khác không vỡ); **fe-admin luôn gửi**. Có ⇒ filter `findOneAndUpdate` thêm điều kiện scopes đúng bằng mảng đó (khớp chính xác, có thứ tự; `[]` khớp mảng rỗng **hoặc** field vắng). Không khớp mà resource còn ⇒ **409 `conflict`** (câu cố định), DB không đổi, không audit success. Resource không còn ⇒ 404 như cũ.
- So trong handler là không đủ (run 80): cửa sổ lost-update là lúc admin mở form, nên giá trị kỳ vọng phải do FE mang theo.
- FE: kỳ vọng = scopes lúc form mount (đóng băng), mang qua step-up draft; sau kết quả không chắc chắn (`unsure`) hoặc 409 thì kỳ vọng = giá trị server vừa đọc lại (đang hiển thị "Currently saved") ⇒ lưu lại là ghi đè có ý thức.
- Việc bắt buộc `expectedScopes` cho mọi caller ⇒ DEBT-534 (💭).

### Chốt nhỏ — DEBT-532

Đổi chính `validateResourceFormat` sang câu cố định (`resource must be an absolute URI`, `resource must not contain a fragment`) thay vì bọc trong `validateResourceIdentifier`: runtime (`/authorize` `authorize.service.ts:567`, `/token` `token.controller.ts:399/461`, resume `:395`) không bao giờ đưa message này ra ngoài (map sang câu cố định riêng hoặc giá trị đã kiểm từ context/code) ⇒ không có hành vi runtime nào đổi; một chỗ sửa, không còn đường echo nào.

## Kiểm từng ứng viên trên code hiện tại (develop `1d8fbe5`)

Không ứng viên nào đã được sửa gián tiếp ⇒ không đóng debt nào bằng bằng chứng.

| Debt | Trạng thái code | Quyết định |
|---|---|---|
| 413 | `authorize-request-context.service.ts:19-48` không có trường binding; `authorize.service.ts:163-170` `resume` chỉ `consume(requestId)`; `authorize.controller.ts:82-86` không đọc cookie nào ngoài session | **Chọn T1** — bảo mật (login CSRF ở RP qua URL `request_id` lộ). Khả thi: mẫu `idp_fed` (`federation.controller.ts:111-114`, `federation.service.ts:129,250`) đã có; Lua so-trước-DEL đã có mẫu (`authorization-code.service.ts:47-58`) |
| 532 | `resource.validator.ts:24,27` còn echo `${resource}`; `admin.mappers.ts:234` đưa `err.message` vào 400 | **Chọn T2** — exposure, rẻ |
| 323 | `resource.service.ts:79-93` filter chỉ `{resourceId, identifier}`; `$resourceId.tsx:105` gửi `{scopes}` | **Chọn T3** — đúng đắn dữ liệu; người dùng cho phép đổi hợp đồng FE+BE |
| 527 | `e2e/tests/fe-admin-audit.spec.ts:15-16,40,43` `start` chỉ bỏ ms, giây có thể = 0 | **Chọn T4** — flake gate, 1 dòng |
| 517 | `admin-clients.controller.ts:196-202` chỉ chặn disable + mất `admin.*`/resource admin; BE không ghi `redirect_uri`/version secret mà console dùng | Hoãn (💭 sau M7). Làm đúng cần lưu `redirect_uri` + version secret của lần `/token` vào family admin rồi guard theo đó — thay đổi mô hình dữ liệu token, lợi ích thấp (chỉ super_admin/tenant_admin tự khoá; có runbook khôi phục) |
| 134 | `client.service.ts:388` `after = {...before, ...set}` vẫn còn | Hoãn: fe-admin `useUpdateClient` invalidate khi settle (`hooks.ts`) ⇒ UI luôn đọc lại `updatedAt` đúng; chỉ caller API thô thấy giá trị cũ. Lý do kỹ thuật run 80 giữ nguyên (timestamps Mongoose) |
| 193 | Unique chỉ `(provider, providerId)` | Hoãn: unique `(userId, provider)` sẽ làm `db:sync-indexes` thất bại trên DB đã có bản trùng (E2E tích luỹ) ⇒ cần bước dọn dữ liệu + trang quản lý liên kết; chưa có nhu cầu |
| 120 | `ui.controller.ts:141,177,190` — 3 `peek` trên `GET /login` | Hoãn: chỉ hiệu năng (2 GET Redis thừa) |
| 121 | `reauthAfter` vẫn từ clock khác `session.authTime` | Hoãn: fail-closed UX, NTP đủ |
| 192 | `authTime = now` cho federation | Hoãn: giới hạn đã biết, chưa RP nào cần |

## Điểm mạnh

- T1 tái dùng 2 mẫu đã kiểm chứng trong repo (cookie binding `idp_fed`, Lua so-trước-DEL) thay vì phát minh cơ chế mới; RP không phải sửa gì.
- T1 giữ nguyên ngữ nghĩa DEBT-122/123 (cửa nào nhận kind nào; consent gắn phiên).
- T3 sửa đúng gốc lost-update (giá trị kỳ vọng từ lúc mở form) và vẫn tương thích ngược cho caller API khác.
- T2 xoá đường echo ở nguồn, không thêm lớp bọc.
- 4 task chạm module tách biệt (oauth/authorize, resources validator, resources PATCH + fe-admin resources, e2e audit) ⇒ diff không chồng nhau, trừ T2/T3 cùng thư mục `resources` (khác file/hàm).

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Lưu ý thực thi (bắt buộc làm đúng):

- [ ] T1: so binding **trong Lua trước DEL**; context `consent` qua cửa resume vẫn bị tiêu thụ (test DEBT-122 không đổi); cookie KHÔNG xoay khi đã có; `bindingHash`/cookie không bao giờ vào view/URL/log/audit; X3 giữ 42 ô.
- [ ] T1: mọi helper int-test đang resume (`authorize`, `authorize-params`, `federation`, `ui`, `admin`, `oauth-tenant-isolation`, `run55-tester`, `run56-tester`) phải mang cookie binding từ 302 `/authorize` — không được nới server để test xanh.
- [ ] T3: 409 không ghi audit success, DB không đổi; `expectedScopes` vắng ⇒ hành vi cũ y hệt; kiểm "admin resource phải giữ admin.*" vẫn chạy trước.
- [ ] T3 FE: kỳ vọng mang qua step-up draft; không gửi kỳ vọng "mới" một cách im lặng ngoài 2 trường hợp đã chốt (`unsure`, sau 409).

## Đề xuất (không bắt buộc)

- DEBT-533 (mới): `redirect-uri.validator.ts` echo URI trong 400 admin — cùng lớp với 532, nhưng fe-admin có thể đang hiển thị; làm khi chạm clients.
- DEBT-534 (mới): sau một chu kỳ phát hành, cân nhắc bắt buộc `expectedScopes` (hoặc ETag/`If-Match`) cho mọi caller.
- Sau T1 có thể gộp 3 `peek` của `GET /login` (DEBT-120) nếu backend-dev chạm `ui.controller` — không bắt buộc, không nằm trong lô.
