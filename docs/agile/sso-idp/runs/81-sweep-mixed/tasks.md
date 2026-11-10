# Run 81 — sweep 🟡 còn lại (M7, lane BE + FE/E2E)

Nguồn: backlog — các debt 🟡 còn mở mà run 78–80 đã hoãn. Analyst bỏ qua. Quyết định: người dùng ủy quyền orchestrator chốt theo tiêu chí production (`plan.md` §12); tech-lead chốt luôn điểm mở, kể cả đổi hợp đồng FE+BE nếu cần cho production.

## Ứng viên (tech-lead chọn lô ≤ 6, ưu tiên bảo mật rồi đến đúng đắn dữ liệu)
- Bảo mật: DEBT-413 (context `login` qua URL `request_id` không gắn trình duyệt tạo nó ⇒ resume bằng phiên kẻ khác), DEBT-517 (console tự khoá qua redirect URI / secret version), DEBT-532 (nhánh format đường ghi resource echo giá trị trong 400).
- Đúng đắn dữ liệu: DEBT-323 (PATCH resource last-write-wins — `expectedScopes` + 409, đổi hợp đồng FE+BE), DEBT-134 (PATCH client trả `updatedAt` cũ), DEBT-193 (nhiều FI cùng provider/user).
- Auth: DEBT-120 (`/login` peek context 3 lần), DEBT-121 (`reauthAfter` vs `authTime` khác clock), DEBT-192 (federation `authTime = now`).
- E2E: DEBT-527 (flake `fe-admin-audit.spec.ts` khi giây = 00).

## Yêu cầu chung
- Mỗi task: AC cụ thể, test RED trước fix, mutation cho nhánh bảo mật/fail-closed.
- Kiểm code hiện tại — debt cũ có thể đã được sửa gián tiếp (khi đó đóng với bằng chứng).
- Nếu chạm cookie/luồng login: X3 phải giữ 42 ô (hoặc cập nhật ma trận có lý do).
- Không chạy CLI ghi vào DB dev `sso-idp`; không `npx` gói chưa cài.

## Gate
typecheck/lint, unit be, int full (`vg-int-*` không tăng), fe-admin test, E2E 38, X3 42 — tuần tự.

## Fold tech-lead (2026-11-10) — lô chốt 4 task, PASS

Kiểm trên code hiện tại (develop `1d8fbe5`). Không ứng viên nào đã được sửa gián tiếp. Lý do chọn/loại + quyết định tự chốt (2 thay đổi hợp đồng): `review-techlead.md`.
Mỗi task: viết test trước, chạy thấy ĐỎ, rồi mới sửa; mutation = hoàn nguyên từng phần fix ⇒ test tương ứng đỏ lại (ghi vào test-report).

**Thứ tự**: T2 → T1 → T3-BE (backend-dev, tuần tự). **Song song được**: T3-FE (frontend-dev) bắt đầu ngay — hợp đồng đã chốt ở đây, mock BE theo mục T3; T4 (E2E) độc lập, làm bất cứ lúc nào. T3-E2E chạy sau khi cả T3-BE và T3-FE xong. Gate cuối tuần tự.

### T1 [BE] (+ [E2E] assert X3) DEBT-413 — context `login` gắn trình duyệt tạo nó
- [x] backend-dev 2026-11-10: phần BE xong — cookie `idp_authz`/`__Host-idp_authz`, `bindingHash`, Lua `authzCtxConsumeLogin` (so trước DEL), `consumeForResume`; int `authorize` khối "DEBT-413" ca 1/1b/1s/2–6 + `federation` ca 8 + redis-down hàng resume; helper resume của authorize/federation/admin/oauth-tenant-isolation/run55/run56/seed/seed-risk-flow/admin-public-client/b74/run75-resource-scopes mang cookie (`authzBinding` trong `oauth-fixtures.ts`); spec §9.1 + runbook-deploy §11. Mutation 4/5 đỏ, M5 là mutant tương đương (xem log). **Còn lại [E2E]: assert X3 ca 1 (`e2e/x3/cookie-matrix.spec.ts`) — không thuộc phạm vi backend-dev lần này.**
- **Chốt hợp đồng**: cookie `idp_authz` (`__Host-idp_authz` khi Secure, qua `hostCookieName`), giá trị `generateToken()`, `HttpOnly; SameSite=Lax; Path=/; Secure` theo `sessionCookie.secure`; `Max-Age` 600 s (= `CONTEXT_TTL_MS`, export hằng). Có sẵn trong request ⇒ dùng lại giá trị (không xoay), set lại chỉ để làm mới `Max-Age`. Set CHỈ khi outcome `login_required`.
- **Chỗ sửa**:
  - `be/src/modules/oauth/authorize/authorize-request-context.service.ts`: `AuthorizeRequestContext` (:19-48) thêm `bindingHash?: string` (doc: chỉ context `login`, server-side, không bao giờ ra view/URL/log/audit); export `CONTEXT_TTL_MS` (:10) và `AUTHZ_BINDING_COOKIE = 'idp_authz'`; thêm script Lua thứ 2 `authzCtxConsumeLogin` (nạp cùng `loadLuaScripts` :84):
    ```lua
    local v = redis.call('GET', KEYS[1])
    if not v then return nil end
    local d = cjson.decode(v)
    if d.kind == 'login' and (ARGV[1] == '' or d.bindingHash ~= ARGV[1]) then return nil end
    redis.call('DEL', KEYS[1])
    return v
    ```
    và method `consumeForResume(requestId, bindingHash: string | undefined)` (truyền `bindingHash ?? ''`). `consume` cũ (:112) giữ nguyên cho `decideConsent`.
  - `be/src/modules/oauth/authorize/authorize.service.ts`: `handle` (:198) và `resume` (:163) nhận thêm tham số cuối `bindingHash?: string`; `resume` gọi `consumeForResume(requestId, bindingHash)` thay `consume` (:168), giữ kiểm `kind !== 'login'` (:170), truyền `bindingHash` vào `this.handle(...)` (:195); nhánh `!hasSession` (:272-280) truyền `bindingHash` vào `createContext` (:493, thêm tham số, spread `...(bindingHash !== undefined ? { bindingHash } : {})`). Context `consent` không có `bindingHash`.
  - `be/src/modules/oauth/authorize/authorize.controller.ts` `handle` (:65-93): `name = hostCookieName(AUTHZ_BINDING_COOKIE, this.sessionCookie.secure)`; `existing = req.cookies?.[name]`; `binding = existing || generateToken()`; nhánh resume (:83) truyền `existing ? sha256(existing) : undefined` (KHÔNG dùng binding mới sinh — resume không cookie phải thất bại); nhánh fresh (:88) truyền `sha256(binding)`. `respond` (:154-158) khi `login_required`: `reply.setCookie(name, binding, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: CONTEXT_TTL_MS / 1000 })` (truyền `binding` vào `respond`). `sha256`/`generateToken` từ `common/crypto/crypto.util` (như `federation.service.ts:5`).
  - `docs/agile/sso-idp/spec.md` §9.1: 2–3 dòng mô tả binding + cookie mới; `runbook-deploy.md`: 1 dòng "login đang dở lúc deploy ⇒ Request expired, bắt đầu lại từ RP".
- **Security design**: tài sản = context login (`state` + `code_challenge` của RP nạn nhân). Actor: chủ trình duyệt tạo context; kẻ tấn công có URL `request_id` (lịch sử, log proxy) và phiên của chính mình. Invariant: code chỉ được cấp khi resume diễn ra trong trình duyệt có cookie khớp `bindingHash`; mismatch không xoá context. Abuse cases: replay URL ở trình duyệt khác (chặn); resume không cookie (chặn); context cũ không `bindingHash` (chặn); đốt context của nạn nhân (không được — so trước DEL); race 2 resume đúng cookie (Lua atomic ⇒ đúng 1 thành công); confused deputy qua federation (leg provider của kẻ tấn công vẫn dừng ở resume); cookie tossing (prod `__Host-`; dev không Secure như `idp_fed`, chấp nhận). Failure: Redis lỗi ⇒ 503 như hiện hành (không fail-open). Exposure: cookie HttpOnly, không vào URL/HTML; Redis chỉ giữ sha256; không log/audit binding.
- **AC**:
  1. `GET /authorize` (không phiên) ⇒ 302 `/login?returnTo=...` + `Set-Cookie` `idp_authz` (dev) / `__Host-idp_authz` (Secure) với `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=600`; request đã có cookie ⇒ cùng giá trị (không xoay).
  2. Login rồi resume kèm cookie đó ⇒ 302 về RP với `code` + `state` (hành vi cũ).
  3. Resume bằng phiên hợp lệ nhưng KHÔNG cookie / cookie khác ⇒ 400 trang "Request expired", không `Location`, body không chứa `state`/`redirect_uri`, không code; ngay sau đó resume đúng cookie ⇒ vẫn 302 code (context còn).
  4. Context `login` không có `bindingHash` (ghi thẳng Redis) ⇒ 400 dù có cookie.
  5. Hai tab: 2 `/authorize` cùng cookie ⇒ cả 2 `request_id` resume được.
  6. 2 resume đồng thời đúng cookie ⇒ đúng 1 code.
  7. Context `consent` qua `GET /authorize?request_id` ⇒ 400 và bị tiêu thụ (test DEBT-122 `authorize.int-spec.ts:785` xanh, không sửa).
  8. Federation: callback → resume trong cùng cookie jar ⇒ code; jar khác ⇒ 400.
  9. Redis lỗi ở resume ⇒ 503 (redis-down không đổi).
- **Test (RED trước)**: `be/test/authorize.int-spec.ts` khối mới "DEBT-413 browser binding" ca 1–6 (ca 4 `redis.set` thẳng key `authz_ctx:<id>`); `be/test/federation.int-spec.ts` ca 8 (helper `:253-275` lấy thêm cookie binding từ `res.cookies`). Cập nhật helper resume ở `be/test/{authorize,authorize-params,federation,ui,admin,oauth-tenant-isolation,run55-tester,run56-tester}.int-spec.ts` để mang cookie binding (đọc từ `Set-Cookie` của 302 `/authorize`) — không nới server để test xanh. RED: ca 1 (không Set-Cookie), ca 3 (hiện 302 code). X3: `e2e/x3/cookie-matrix.spec.ts` ca 1 (:161-171) thêm `const resume = await idp.find("GET", "/authorize")` và kỳ vọng request resume cuối có `__Host-idp_authz` trong `names` (mọi trình duyệt: top-level Lax). X3 phải giữ 42 ô.
- **Mutation**: Lua bỏ so `bindingHash` ⇒ ca 3 đỏ; so trong JS sau `consume` (DEL trước) ⇒ vế "context còn" của ca 3 đỏ; xoay cookie mỗi request ⇒ ca 1/5 đỏ; bỏ `httpOnly` ⇒ ca 1 đỏ; resume dùng binding mới sinh khi thiếu cookie ⇒ ca 3 (không cookie) đỏ.

### T2 [BE] DEBT-532 — nhánh format identifier không echo giá trị
- [x] backend-dev 2026-11-10: 2 câu cố định ở `validateResourceFormat`; unit `it.each` 2 input × 2 hàm + int `admin-api` 2 body (400 `invalid_request`, không `MARK`, 0 document, 0 audit); mutation từng nhánh ⇒ 1 đỏ, sha256 khớp.
- **Chỗ sửa**: `be/src/modules/resources/resource.validator.ts:24,27`: `'resource must be an absolute URI'`, `'resource must not contain a fragment'` (bỏ `${resource}`). Không đổi chỗ khác: runtime `/authorize` (`authorize.service.ts:567`) dùng câu cố định riêng; `/token` (`token.controller.ts:399,461`) và resume consent (`authorize.service.ts:395`) chỉ nhận giá trị đã kiểm. (Không test nào assert câu cũ — đã grep.)
- **Security design**: exposure — 400 admin không phản chiếu input; status/code không đổi.
- **AC**: `POST /admin/resources` (super_admin, step-up mới) identifier `abc-MARK`, `https://a/#x-MARK` ⇒ 400 `invalid_request`, body không chứa `MARK`, 0 document, 0 audit.
- **Test (RED trước)**: `be/src/modules/resources/resource.validator.spec.ts` thêm `it.each` 2 input ⇒ `message` không chứa input (cả qua `validateResourceFormat` và `validateResourceIdentifier`); `be/test/admin-api.int-spec.ts` khối "Task 4 — resources" ca validation 400 (~:1055) thêm 2 body + `expect(JSON.stringify(res.json())).not.toContain('MARK')`. RED: hiện echo.
- **Mutation**: khôi phục `${resource}` ở một trong 2 nhánh ⇒ ca tương ứng đỏ.

### T3 [BE] + [FE] + [E2E] DEBT-323 — PATCH resource `expectedScopes` + 409
- **Chốt hợp đồng**: body `{ scopes: string[], expectedScopes?: string[] }`. Có `expectedScopes` ⇒ ghi chỉ khi scopes đang lưu đúng bằng mảng đó (có thứ tự; `[]` khớp mảng rỗng hoặc field vắng); không khớp mà resource tồn tại ⇒ 409 `{error:'conflict', error_description:'The resource was changed since it was read.'}`. Vắng ⇒ hành vi cũ (last-write-wins, tương thích ngược). fe-admin luôn gửi.

#### T3-BE
- [x] backend-dev 2026-11-10: `UpdateResourceDto.expectedScopes` (`@IfPresent` + cùng validator), filter nguyên tử trong `updateScopes`, `ConcurrentResourceUpdateError` ⇒ 409 `conflict` câu cố định, không audit; int `admin-api` khối "DEBT-323 expectedScopes" ca 1–8 (11 test) + unit DTO/mapper `admin.spec.ts`; snapshot `fe-admin/openapi/admin.json` sửa tay + `gen:api` (deep-equal với tài liệu BE phục vụ: `run80-tester` OpenAPI xanh). Mutation 3/3 đỏ.
- **Chỗ sửa**: `be/src/modules/admin/admin.dto.ts` `UpdateResourceDto` (:199-207): thêm `expectedScopes?: string[]` với `@IfPresent()` (:37) + cùng decorator như `scopes` + `@ApiPropertyOptional` (mô tả 409). `be/src/modules/resources/resource.service.ts` `updateScopes` (:79-93): tham số `expectedScopes?: string[]`; filter thêm `expectedScopes === undefined ? {} : expectedScopes.length === 0 ? { $or: [{ scopes: { $size: 0 } }, { scopes: { $exists: false } }] } : { scopes: expectedScopes }`; `before` null ⇒ `findOne({ resourceId, identifier })` tồn tại ⇒ ném `ConcurrentResourceUpdateError` (export từ `resource.service.ts`), else null. `be/src/modules/admin/admin.mappers.ts` `toAdminError` (:228-240): map lỗi mới ⇒ `AdminAuthError.conflict('The resource was changed since it was read.')`. `be/src/modules/admin/admin-resources.controller.ts` `update` (:139): truyền `dto.expectedScopes`, `.catch((e) => { throw toAdminError(e); })`; kiểm admin.* (:129-137) giữ trước. Cập nhật `fe-admin/openapi/admin.json` + `pnpm -C fe-admin gen:api` theo quy trình hiện có (`fetch:api`/`gen:api`, không cài gì mới).
- **Security design**: actor super_admin (guard + step-up không đổi). Invariant: có `expectedScopes` thì không bao giờ ghi đè giá trị khác giá trị caller đã thấy. Race: điều kiện nằm trong filter `findOneAndUpdate` (nguyên tử). Failure: Mongo lỗi ⇒ 5xx như cũ. Exposure: 409 câu cố định, không trả scopes hiện tại.
- **AC**: (1) expected = đang lưu ⇒ 200, ghi, 1 audit success; (2) expected khác ⇒ 409 `conflict`, DB không đổi, 0 audit; (3) expected `[]` với resource scopes `[]` hoặc field vắng ⇒ 200; (4) không có expected ⇒ 200 (LWW cũ); (5) resource không tồn tại + expected ⇒ 404; (6) 2 PATCH đồng thời cùng expected, scopes khác nhau ⇒ đúng 1 200, 1 409; (7) expected sai kiểu / > 50 phần tử / `null` ⇒ 400; (8) admin resource bỏ admin.* + expected đúng ⇒ vẫn 400 cũ.
- **Test (RED trước)**: `be/test/admin-api.int-spec.ts` khối "Task 4 — resources" (:1010) ca 1–8 (ca 3 field vắng: `updateOne({$unset:{scopes:1}})` trên resource test); unit DTO `be/src/modules/admin/admin.spec.ts` ca 7. RED: ca 2/6 hiện 200.
- **Mutation**: bỏ điều kiện scopes trong filter ⇒ ca 2/6 đỏ; bỏ nhánh `$exists:false` ⇒ ca 3 đỏ; 409 thành 404 ⇒ ca 2 đỏ.

#### T3-FE
- [x] frontend-dev 2026-11-10: `expectedScopes` = scopes lúc mount / của draft step-up / của lần lưu xong; sau `unsure` hoặc 409 = giá trị đọc lại ("Currently saved"); 409 thông điệp cố định; `useUpdateResource` re-read cả khi 409 (không thì "Currently saved" là cache cũ); `EditResourceValues` = `{scopes}` (draft không lọt vào form). Mutation M1–M5 đỏ, khôi phục sha256 khớp. Chờ kiểu: `admin-schema-types.test.ts:95` (typecheck đỏ tới khi BE sinh lại `schema.d.ts`)
- **Chỗ sửa**: `fe-admin/src/features/admin-api/inputs.ts:97-100` `patch: z.object({ scopes: resourceScopes, expectedScopes: resourceScopes.optional() }).strict()`; `fe-admin/src/features/resources/resource-form-schema.ts:75` `EditResourceDraftSchema` thêm `expectedScopes: z.array(z.string().max(256)).max(50).optional()`; `fe-admin/src/routes/resources/$resourceId.tsx` `EditScopesForm` (:79-127): `const [mountScopes] = useState(() => draft?.expectedScopes ?? resource.scopes)`; state `conflict`; khi submit `expectedScopes = unsure || conflict ? resource.scopes : mountScopes`; payload step-up (:110) thêm `expectedScopes`; lỗi `AdminRequestError` code `conflict` ⇒ `setConflict(true)`, thông báo "These scopes were changed by someone else. The saved scopes are shown below; saving again replaces them." và hiện dòng "Currently saved" (như `unsure`); lưu thành công ⇒ reset `conflict`.
- **AC**: (1) lưu gửi `expectedScopes` = scopes lúc mount (không theo refetch); (2) 409 ⇒ thông báo trên + "Currently saved"; lần lưu sau gửi `expectedScopes` = giá trị server mới; (3) step-up: draft khôi phục gửi `expectedScopes` gốc (lúc mở form trước step-up); (4) `unsure` ⇒ gửi giá trị server đọc lại; (5) server fn từ chối `expectedScopes` sai kiểu (zod strict).
- **Test (RED trước)**: `fe-admin/test/resources-ui.test.tsx` ca 1–4 (spy body mutation); `fe-admin/test/resources-fn.test.ts` ca 5; `fe-admin/test/resource-form-schema.test.ts` draft có/không `expectedScopes`. RED: body hiện chỉ `{scopes}`.
- **Mutation**: gửi `resource.scopes` thay `mountScopes` ⇒ ca 1 đỏ; bỏ `expectedScopes` khỏi draft ⇒ ca 3 đỏ; không đổi sang giá trị server sau 409 ⇒ ca 2 đỏ.

#### T3-E2E
- [x] frontend-dev 2026-11-10: thêm bước 5 vào test có sẵn (E2E giữ 38): PATCH qua admin API ⇒ API stale `expectedScopes` = 409 body cố định; UI lưu ⇒ thông báo conflict + "Currently saved: e2e.read e2e.other", DB giữ giá trị API; lưu lại ⇒ dòng biến mất + "Saved.", DB = giá trị UI. Log BE: đúng 2 lần 409 trên resource test. X3 ca 1 (T1): assert resume mang `__Host-idp_authz` — WebKit cross-site chỉ ghi nhận (DEBT-535)
- `e2e/tests/fe-admin-resources.spec.ts`: mở trang sửa resource test, đổi scopes qua admin API (helper `adminApi`), lưu trong UI ⇒ thấy thông báo conflict; API đọc lại = giá trị đổi qua API; lưu lần nữa ⇒ "Saved.". Thêm vào test có sẵn (E2E giữ 38) hoặc test mới (39) — ghi rõ trong test-report.

### T4 [E2E] DEBT-527 — flake audit khi giây = 00
- [x] frontend-dev 2026-11-10: thêm `if (start.getSeconds() === 0) start.setSeconds(1);` sau `setMilliseconds(0)`; chỉ `--list` + typecheck (E2E chạy ở gate). Gốc: Playwright `fill` (`playwright-core@1.64.0` coreBundle) ném `Malformed value` khi `input.value !== value` sau gán — Chrome bỏ `:00`; mô phỏng start: cũ 15/876 mẫu (2') kết thúc `:00`, có fix 0
- **Chỗ sửa**: `e2e/tests/fe-admin-audit.spec.ts:15-16`: sau `start.setMilliseconds(0)` thêm `if (start.getSeconds() === 0) start.setSeconds(1);` (vẫn trước mọi sự kiện của test; assert `from` = `start.toISOString()` :48 giữ nguyên).
- **AC**: ép tạm giây = 0 (sửa cục bộ, không commit) ⇒ không còn `Malformed value`; chạy file 3 lần liên tiếp xanh.
- **Test/Mutation**: ép giây = 0 + bỏ dòng mới ⇒ đỏ (`Malformed value`); có dòng mới ⇒ xanh.

### Ngoài lô (giữ backlog) — lý do ở `review-techlead.md`
DEBT-517 (💭 sau M7), 134, 193, 120, 121, 192. Debt mới: DEBT-533, DEBT-534 (`backlog.md`).

### Gate (tuần tự)
`pnpm -C be typecheck` + lint, unit be, int full (`vg-int-*` không tăng), fe-admin test, E2E 38 (+ ca T3 nếu thêm test mới), X3 42 (bắt buộc vì T1 thêm cookie). Không chạy CLI vào DB dev `sso-idp`.
