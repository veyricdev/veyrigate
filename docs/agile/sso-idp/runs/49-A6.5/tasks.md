# Tasks — run 49 — A6.5: Keys (M5, lane ADMIN) + DEBT-346/347

> Plan §6 A6.5: "xem JWKS/`kid`/trạng thái, rotate thường, **rotate khẩn cấp** (xác nhận 2 bước + step-up + cảnh báo hậu quả §6.4)" — nghiệm thu "Có cảnh báo rõ trước khi khẩn cấp; kết quả phản ánh trong danh sách key". BE: `be/src/modules/admin/admin-keys.controller.ts` (GET `admin/keys`, POST `rotate` + `RequireRecentAuth(5)`). Tái dùng khuôn A6.1–A6.4 (ConfirmAction, step-up, uncertain không tự gửi lại, `useInvalidateOn`, `useActionNotice`, chỉ hiện control khi có quyền).
>
> Thứ tự: Task 0 [BE] (nếu snapshot thiếu response schema) ‖ Task 1 → 2 → 3 → 4 (frontend-dev). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop. Không đụng `be/keys`.

### [x] Task 0 [BE]: OpenAPI response schema keys (`AdminKeyViewDto`, `KeyListViewDto`, `RotateKeyResultViewDto`) + snapshot + `gen:api` (F0)

### [x] Task 1 [FE]: DEBT-346 (nút Details audit có tên phân biệt) + DEBT-347 (ponytail)

### [x] Task 2 [FE]: Keys server fns + schema — list (kid, alg, trạng thái active/next/retired…, thời điểm), rotate (thường/khẩn cấp theo BE); zod allowlist — tuyệt đối không có private key/material.

### [x] Task 3 [FE]: `/keys` — bảng key, rotate thường (xác nhận + step-up), rotate khẩn cấp (xác nhận 2 bước: gõ xác nhận hoặc tương đương, cảnh báo hậu quả §6.4 — mọi token đang lưu hành bị vô hiệu/đăng xuất…), kết quả phản ánh trong danh sách; uncertain ⇒ không tự gửi lại, chỉ dẫn kiểm tra danh sách; chỉ super_admin.

### [x] Task 4 [E2E]: rotate thường trên stack E2E ⇒ kid mới xuất hiện trong danh sách + JWKS công khai; KHÔNG chạy rotate khẩn cấp nếu nó phá các spec khác (tech-lead quyết định).

## Câu hỏi cho tech-lead
- Q-49.1: BE phân biệt rotate thường/khẩn cấp thế nào; hậu quả thật của khẩn cấp (§6.4) để viết cảnh báo đúng sự thật.
- Q-49.2: Rotate có idempotent không; uncertain ⇒ rủi ro rotate hai lần (đẩy key cũ ra sớm)?
- Q-49.3: E2E rotate có ảnh hưởng spec khác chạy song song/sau (token đã cấp, cache JWKS của RP)?

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `c8216f3` (CodeGraph + đọc trực tiếp): BE `admin/admin-keys.controller.ts`, `admin/admin.dto.ts` (`RotateKeyDto`), `admin/admin.views.ts`, `keys/{key-provider,local-key-provider,key-rotation.service,token-verifier}.ts`, `oauth/logout/logout.service.ts` (`verifyHint`), `oauth/token/token.service.ts` (TTL); `fe-admin/openapi/admin.json`; FE `server/admin-api/client.ts` (`call`/`read`, 401 ⇒ `refreshRejected`), `server/auth/{bff,instance}.ts` (refresh + `verifyIdToken`, `createRemoteJWKSet`), `features/admin-api/{keys,hooks,step-up}.ts`, `components/feedback/confirm-action.tsx`, `components/layout/app-sidebar.tsx`, `routes/resources/new.tsx`; E2E `playwright.config.ts` (`workers: 1`), `config/env.ts` (`ACCESS_TOKEN_TTL=120`, `KEY_LOCAL_DIR=e2e/.keys`); runbook-ops §1.

### Sự thật từ code (sửa text ở trên)
- Trạng thái key CHỈ có `active` | `retiring` (không có `next`/`retired`). `GET /admin/keys` trả các key đang có trong JWKS: 1 `active` + các `retiring` chưa tới `retireAt` (key hết hạn bị lọc khi đọc, xoá khi rotate). View `{kid, alg:'RS256', status, createdAt (chuỗi ISO), retireAt (ISO | null)}`; `nextCursor` luôn `null`. Controller map allowlist ⇒ không có `n/e/d/p/q/dp/dq/qi`, PEM hay đường dẫn.
- **Cả đọc lẫn rotate đều chỉ super_admin** (`assertSuperAdmin`): tenant_admin đọc ⇒ 403 `forbidden`. Rotate: `admin.write` + `RequireRecentAuth(5)`; StepUpGuard chạy TRƯỚC kiểm super_admin (DEBT-325).
- Một endpoint `POST /admin/keys/rotate`, body `{mode:'normal'|'emergency'}` bắt buộc (`IsIn`), không có cờ query. Trả `200 {newKid, oldKid: string|null, mode}`. Audit `SIGNING_KEY_ROTATED`: thành công ⇒ `targetType:'signing_key'`, `targetId:newKid`, `metadata:{mode, oldKid}`, `tenantId` của token; ghi state lỗi ⇒ audit `failure` `reason:'rotate_failed'` + 5xx, key cũ vẫn active.
- OpenAPI snapshot: `/admin/keys` và `/admin/keys/rotate` **không có response schema** ⇒ cần Task 0 [BE].
- TTL ID token = TTL access token (`token.service.ts`) ⇒ "token đã cấp" bên dưới gồm cả AT và ID token.

### Trả lời câu hỏi
- **Q-49.1 — Thường vs khẩn cấp, hậu quả đúng sự thật** (cảnh báo dùng đúng các ý này; KHÔNG thêm hậu quả không có trong code):
  - **Thường**: key mới thành active; key active cũ thành `retiring` (chỉ verify) tới `retireAt = now + ACCESS_TOKEN_TTL`; các key retiring khác giữ nguyên. Token đã cấp vẫn dùng được tới khi hết hạn tự nhiên. Không ai bị đăng xuất.
  - **Khẩn cấp**: JWKS chỉ còn key mới; **mọi key trước đó (active VÀ mọi key retiring) bị gỡ ngay**, private key bị xoá.
    1. Mọi access token và ID token đã cấp bị IdP từ chối ngay (admin API, `/userinfo`, `/introspect`, resource dùng verifier của IdP) — kể cả token của console này.
    2. RP tự verify bằng JWKS đã cache có thể vẫn chấp nhận token cũ tới khi tải lại JWKS (JWKS chưa có `Cache-Control`, DEBT-157) ⇒ phải báo RP tải lại JWKS.
    3. Phiên IdP và refresh token **KHÔNG bị thu hồi**: client lấy token mới bằng refresh; người dùng không bị đăng xuất khỏi IdP. Nghi bị đánh cắp phiên ⇒ thu hồi riêng (runbook-ops §2/§4).
    4. Đăng xuất RP với `id_token_hint` cấp trước khi xoay không quay về ứng dụng (hint không verify được ⇒ trang mặc định của IdP).
    5. Không có rollback.
  - KHÔNG được ghi: "mọi người dùng bị đăng xuất", "refresh token bị thu hồi", "15 phút" (FE không biết TTL; nói "access-token lifetime").
- **Q-49.2 — Không idempotent** (DEBT-158). Kết quả không chắc (timeout, 5xx gồm cả ca "đã xoay nhưng ghi audit lỗi", 2xx sai schema) ⇒ có thể đã xoay.
  - Xoay **thường** hai lần: KHÔNG đẩy key cũ ra sớm (key retiring còn hạn được giữ), chỉ thêm một key retiring trong TTL. Vô hại.
  - Xoay **khẩn cấp** hai lần: token cấp giữa hai lần (kể cả AT console vừa refresh) chết thêm lần nữa; khôi phục bằng refresh.
  - ⇒ FE: KHÔNG tự gửi lại; nhớ `kid` active TRƯỚC khi gửi; uncertain ⇒ đọc lại danh sách và nói rõ cách so (F3).
- **Q-49.3 — E2E** (suite tuần tự, `workers: 1`):
  - BE verifier dựng JWKS từ provider mỗi lần verify ⇒ sau rotate thường token cũ vẫn verify tới `retireAt` (120s ở E2E) ⇒ spec khác không bị ảnh hưởng.
  - fe-sso-test (trình duyệt) tạo `createRemoteJWKSet` theo trang ⇒ trang mới tải JWKS mới ⇒ không ảnh hưởng.
  - **fe-admin server (sống suốt suite) có rủi ro thật**: `createRemoteJWKSet` mặc định `cooldownDuration` 30s ⇒ ID token `kid` mới (callback hoặc refresh) tới trong 30s kể từ lần tải JWKS gần nhất ⇒ `verifyIdToken` lỗi ⇒ callback hỏng hoặc refresh gọi `dropNew` (huỷ phiên). Ngoài E2E cũng gặp: step-up (callback có thể vừa tải lại JWKS) rồi xoay khẩn cấp ⇒ đọc lại danh sách 401 ⇒ refresh ⇒ admin bị đăng xuất. ⇒ sửa bắt buộc ở F2.
  - `E2E_REUSE=1` dùng env của server đang chạy ⇒ rotate có thể đánh vào `KEY_LOCAL_DIR` của BE dev (`be/keys`) ⇒ spec phải skip khi `E2E_REUSE=1`.
  - **KHÔNG chạy rotate khẩn cấp trong E2E** (BE đã phủ ở `admin-keys.int-spec`; FE phủ bằng unit). E2E chỉ mở dialog khẩn cấp, kiểm cảnh báo và cổng gõ xác nhận, rồi Cancel.

### Phạm vi, phân công, thứ tự
- Task 0 → **backend-dev**; Task 1–4 → **frontend-dev**. Thứ tự: Task 0 ‖ Task 1 → Task 2 (cần snapshot Task 0) → Task 3 → Task 4.
- Ngoài phạm vi: `Cache-Control` JWKS (DEBT-157), rate-limit rotate (DEBT-158), kiểm super_admin trước step-up (DEBT-325), thu hồi phiên/RT khi khẩn cấp, hiện JWKS thô (`n/e`) — trang chỉ hiện metadata (đủ cho "xem JWKS/kid/trạng thái").

### F0 — Task 0 [BE] (backend-dev): OpenAPI response keys (chỉ metadata, không đổi runtime)
- `admin.views.ts`:
  - `AdminKeyViewDto implements KeyMetadata`: `kid` String; `alg` enum `['RS256']`; `status` enum `['active','retiring']`; `createdAt` `DATE`; `retireAt` `NULLABLE_DATE`.
  - `KeyListViewDto { items: AdminKeyViewDto[]; nextCursor }` — `nextCursor` `type: String, nullable: true` (luôn null; giữ hình dạng page như list khác).
  - `RotateKeyResultViewDto { newKid: String; oldKid: String nullable; mode enum ['normal','emergency'] }`.
- `admin-keys.controller.ts`: `@ApiOkResponse({ type: KeyListViewDto })` cho `list`, `@ApiOkResponse({ type: RotateKeyResultViewDto })` cho `rotate`. Không đổi logic.
- `admin.spec.ts` (khuôn run 47/48): key controller trả (từ một `KeyMetadata` đủ field) ↔ property schema; enum `status`/`mode` khớp kiểu TS; `KeyListViewDto` = `['items','nextCursor']`; `RotateKeyResultViewDto` = `['newKid','oldKid','mode']`. Mutation: bỏ 1 property ⇒ RED.
- Cập nhật `fe-admin/openapi/admin.json` + `pnpm -C fe-admin gen:api` (cách run 47/48); commit cả hai.

### F1 — Task 1 [FE]: DEBT-346/347 (+ DEBT-348 cùng chỗ)
- **DEBT-346** `routes/audit/index.tsx`: nút Details có tên phân biệt — `<span className="sr-only"> for {action} at {timestamp}</span>` (text React). Test RTL: `getByRole('button', { name: /Details for TOKEN_REUSE_DETECTED at / })` tìm đúng 1 nút; mutation bỏ span ⇒ RED.
- **DEBT-347**: xoá `adminKeys.audit.all` (không caller); bỏ prop `nextPage` của `/audit`, caption sr-only cố định "Audit events".
- **DEBT-348** (gộp vì cùng `Details`): metadata nằm trong nhóm riêng có tiêu đề "Metadata" (hoặc nhãn `metadata.{k}`), React key `m:${k}` ⇒ metadata `{IP:"x"}` không còn trùng nhãn "IP" cố định. Cập nhật test `audit-ui-risk` "fixed label" theo hành vi mới; mutation trả về nhãn trần ⇒ RED.
- Ngoài các test kể trên: test cũ xanh, không sửa.

### F2 — Task 2 [FE]: signing-keys server fn + schema (thay text Task 2)
- File mới `features/admin-api/signing-keys.ts` (KHÔNG đặt tên `keys.ts` — đó là query key factory).
- `server/admin-api/schemas.ts` (server-only):
  - `SigningKeySchema = z.object({ kid: z.string().min(1).max(128), alg: z.string(), status: z.enum(['active','retiring']), createdAt: z.string(), retireAt: z.string().nullable() })` — `z.object` strip ⇒ field lạ bị bỏ; CẤM `.passthrough()`/`.loose()`.
  - `SigningKeyListSchema = z.object({ items: z.array(SigningKeySchema), nextCursor: z.null() })`.
  - `RotateKeyResultSchema = z.object({ newKid: z.string().min(1).max(128), oldKid: z.string().nullable(), mode: z.enum(['normal','emergency']) })`.
- `server/admin-api/client.ts`: `listSigningKeys(ctx)` ⇒ `GET /admin/keys`; `rotateSigningKey(ctx, mode)` ⇒ `POST /admin/keys/rotate` body `{ mode }`, comment "not idempotent: never re-sent; timeout/5xx/off-contract 2xx ⇒ uncertain" (hành vi sẵn có của `call`/`read`).
- `features/admin-api/inputs.ts`: `RotateKeyInput = z.object({ mode: z.enum(['normal','emergency']) }).strict()`. Type test (`admin-schema-types.test.ts`) hai chiều cho `mode` và `status` ↔ `schema.d.ts` mới.
- `keys.ts`: `signingKeys: { list: ["admin", "signing-keys"] as const }`. `hooks.ts`: `useSigningKeys(enabled)`, `useRotateSigningKey()` (`onSettled` ⇒ `useInvalidateOn(adminKeys.signingKeys.list)`; không retry).
- **Sửa JWKS cooldown** `server/auth/instance.ts`: `createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000, cooldownDuration: 0 })` + comment: bộ này chỉ verify ID token nhận qua back-channel `/token` (client đã xác thực) ⇒ `kid` không do người ngoài điều khiển; cooldown 30s mặc định làm hỏng callback/refresh trong 30s sau khi IdP xoay key (Q-49.3). Kiểm chứng ở F4 (mutation).
- Test (fake BE như run 48):
  - BE trả key có thêm `n,e,d,p,q,dp,dq,qi,pem,path,privateKey` ⇒ output server fn chỉ còn 5 field allowlist; rotate trả thêm `privateKey` ⇒ bị bỏ.
  - input `{mode:'EMERGENCY'}`, `{mode:'normal', x:1}`, thiếu `mode` ⇒ bị từ chối, 0 request tới BE.
  - rotate: BE timeout / 500 / 200 sai schema ⇒ failure `uncertain: true`, đúng 1 request; 403 `step_up_required` ⇒ `step_up_required`; 403 `forbidden` ⇒ `forbidden`.
  - Mutation: `.passthrough()` ở `SigningKeySchema` ⇒ RED; bỏ `.strict()` input ⇒ RED.

### F3 — Task 3 [FE]: `/keys` (thay text Task 3)
- `routes/keys/index.tsx`; sidebar thêm "Signing keys" (icon khác `KeyRoundIcon` của Clients). Non-super_admin: chỉ `<p>Only a super_admin can view and rotate signing keys.</p>`, KHÔNG gọi server fn (query `enabled: false`), khuôn `routes/resources/new.tsx`.
- Bảng (text React, ISO nguyên văn, kid font mono): Key ID, Algorithm, Status ("Active — signs new tokens" / "Retiring — verification only"), Created, Retires at (`—` khi null). Active trước, rồi retiring theo `retireAt`. Lỗi đọc ⇒ `AdminRequestError.message` + "Try again".
- **Xoay thường**: `ConfirmAction` (trigger "Rotate key"), mô tả: "A new key signs new tokens. The current key stays in JWKS for verification until the tokens it signed expire (access-token lifetime). Nobody is signed out."
- **Xoay khẩn cấp** (xác nhận 2 bước; step-up do BE đòi):
  - Bước 1: nút destructive "Emergency rotation…" mở dialog; `warning` `role="alert"` liệt kê đúng 5 ý của Q-49.1 (tiếng Anh, giữ ý, không thêm hậu quả) + câu "This console's session will be refreshed; you may be asked to sign in again." + link `/audit?action=SIGNING_KEY_ROTATED`.
  - Bước 2: ô "Type EMERGENCY to confirm" (khớp chính xác, phân biệt hoa thường, không trim); nút xác nhận `disabled` tới khi khớp; đóng/Cancel ⇒ xoá ô. Thêm prop tuỳ chọn `confirmText?: string` vào `components/feedback/confirm-action.tsx` (không tạo dialog mới; caller cũ không đổi).
- **Kết quả** (`run` trả `ActionOutcome`):
  - Thành công ⇒ `{done}`: thường "Rotated. New active key {newKid}; {oldKid} is now verification only."; khẩn cấp "Emergency rotation done. New active key {newKid}. Previous keys were removed from JWKS. Tell relying parties to refetch JWKS." (`oldKid` null ⇒ bỏ vế đó). Announce qua `useActionNotice` (`role="status"`, focus heading). Danh sách đọc lại (`useInvalidateOn`).
  - `step_up_required` ⇒ `StepUpAlert` (không lưu intent, không lưu chữ đã gõ); quay lại phải gõ lại.
  - `forbidden` ⇒ thông điệp cố định.
  - **Uncertain** (lỗi không phải `AdminRequestError`, hoặc `err.uncertain`) ⇒ `{done: msg}` (khuôn DEBT-339: đóng dialog, announce): "The result is unknown and the request was not sent again. The key list has been reloaded: if the active key is no longer {kidBefore}, the rotation was applied — do not rotate again." (`kidBefore` = kid active lúc mở dialog; không có ⇒ bỏ mệnh đề). Không tự gửi lại.
- Sau khẩn cấp, GET danh sách nhận 401 ⇒ BFF refresh 1 lần và gửi lại (cơ chế sẵn có của `call`). KHÔNG thêm logic refresh mới.
- Test (RTL):
  - tenant_admin ⇒ không bảng/nút, 0 lần gọi server fn;
  - bảng đúng; kid chứa `<img onerror>` hiện dạng text;
  - xoay thường ⇒ server fn đúng 1 lần với `{mode:'normal'}`, status có newKid;
  - khẩn cấp: nút disabled với `emergency`, ` EMERGENCY`, rỗng; enabled với `EMERGENCY`; gửi `{mode:'emergency'}` đúng 1 lần; double-click ⇒ 1 lần; Cancel rồi mở lại ⇒ ô trống;
  - dialog khẩn cấp có ý "refresh tokens and IdP sessions are not revoked" và "no rollback"; KHÔNG có câu nói mọi người dùng bị đăng xuất;
  - uncertain ⇒ thông điệp có `kidBefore`, server fn đúng 1 lần, list được invalidate;
  - step-up ⇒ `StepUpAlert`, không gọi lại.
  - Mutation: bỏ cổng `confirmText` ⇒ RED; uncertain gọi lại rotate ⇒ RED; bỏ gate super_admin ⇒ RED.

### F4 — Task 4 [E2E] (thay text Task 4)
- `e2e/tests/fe-admin-keys.spec.ts`; đầu file `test.skip(process.env.E2E_REUSE === "1", "rotation would hit the reused BE key dir")`.
- Luồng: đăng nhập fe-admin (context A) ⇒ `/keys` ⇒ đọc kid active K1 ⇒ "Rotate key" ⇒ xác nhận ⇒ status có K2 ≠ K1; bảng: K2 Active, K1 Retiring.
- `request.get(<BE>/jwks.json)` (không qua fe-admin) ⇒ `keys[].kid` chứa K2 và K1; không key nào có `d`/`p`/`q`.
- Ngay sau đó context B mới đăng nhập fe-admin ⇒ tới app (`viewer-email`) — chứng minh callback chấp nhận ID token ký bằng K2. **Mutation**: bỏ `cooldownDuration: 0` rồi chạy RIÊNG spec ⇒ context B phải lỗi; ghi kết quả thật (nếu không RED vì quá 30s thì ghi thời gian đo).
- Khẩn cấp (không gửi): mở dialog ⇒ thấy cảnh báo; nút xác nhận disabled ⇒ gõ `EMERGENCY` ⇒ enabled ⇒ Cancel ⇒ `/jwks.json` vẫn chứa K1 và K2 (không có rotate khẩn cấp).
- Kiểm âm: `page.url()` không có `kid`/`mode`; text trang không có `eyJ`, `"d":`, `BEGIN`.
- Không FLUSH/drop; `e2e/.keys` tự dọn key retiring hết hạn ở lần rotate sau. Không đụng `be/keys`.

### Cổng security (đã kiểm)
- **Tài sản/actor/boundary**: private key (chỉ trong provider; API chỉ trả metadata) và quyền xoay key toàn nền tảng. Actor: super_admin (đọc + xoay), tenant_admin (403 cả đọc), non-admin (guard). Boundary: trình duyệt ↔ BFF (server fn + zod strict) ↔ BE (`AdminTokenGuard`, scope, step-up, `assertSuperAdmin`).
- **Invariant/transition**: luôn đúng 1 key active; thường: active→retiring(retireAt) + key mới active; khẩn cấp: JWKS = {key mới}; mutex trong process (DEBT-145). Chuỗi request: khẩn cấp ⇒ AT console chết ⇒ GET kế 401 ⇒ refresh 1 lần ⇒ ID token kid mới ⇒ verify được nhờ `cooldownDuration: 0`.
- **Abuse case**: nhấn nhầm khẩn cấp ⇒ 2 bước + gõ xác nhận + step-up; double-submit ⇒ `busy` ref, không retry; credential cũ ⇒ step-up 5 phút; uncertain ⇒ không gửi lại, so kid; gọi server fn trực tiếp ⇒ vẫn qua guard BE; IDOR/enumeration ⇒ không có id đầu vào; race hai admin ⇒ mutex BE, cả hai áp dụng (xem Q-49.2).
- **Failure semantics**: provider ghi lỗi ⇒ key cũ còn active, 5xx ⇒ FE uncertain (thông điệp vẫn đúng); audit lỗi sau khi xoay ⇒ 5xx dù đã xoay ⇒ uncertain + so kid; timeout ⇒ uncertain; refresh sau khẩn cấp lỗi ⇒ `unauthenticated` (đăng nhập lại), đã cảnh báo.
- **Exposure**: trình duyệt chỉ nhận `kid/alg/status/createdAt/retireAt` và `newKid/oldKid/mode`; URL không tham số; log chỉ route template. Test âm: F2 (strip material), F3 (XSS text, gate), F4 (JWKS không private member, trang không `eyJ`/`BEGIN`).
