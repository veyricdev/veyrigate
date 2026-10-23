# Tasks — run 45 — A6.1b: secrets dialog, rotate/revoke, disable/enable (M5, lane ADMIN)

> Plan §6 A6.1 phần còn lại: "dialog hiện `client_secret` **một lần** + rotate (step-up) + revoke" — nghiệm thu "Không hiện lại secret sau khi đóng". Ràng buộc chi tiết đã ghi trước ở `runs/44-A6.1/tasks.md` mục "Run 45 (A6.1b)" (đọc nguyên văn — ưu tiên). Admin API secrets (run 27/31/33: GET list metadata, POST create-or-rotate trả plaintext 1 lần + `no-store`, DELETE version, chỉ confidential, step-up, admin-capable chỉ super_admin; disable phải gửi một mình, 409 tự khoá). DEBT-308 (đổi `clientId` trên `/clients/$clientId` khi detail đã cache ⇒ form giữ client cũ) **bắt buộc sửa trước** khi thêm điều hướng giữa các detail.
>
> Thứ tự: Task 1 → 2 → 3 → 4 (frontend-dev). KHÔNG sửa be/. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: DEBT-308
- `ClientForm` remount theo `clientId` (key hoặc `remountDeps`) — đổi `it.fails` của tester thành `it`; mutation ⇒ RED.

### [x] Task 2 [FE]: Secrets server fns + danh sách version
- `listSecrets`, `issueSecret` (POST, `cache-control: no-store` trên response serverFn), `revokeSecret` (DELETE, version `^[1-9][0-9]{0,8}$`); chỉ client confidential (UI ẩn/disable cho public). Bảng version (status active/grace/expired/revoked, thời điểm) — không có hash.
- **Acceptance**: unit server fn (map lỗi, không log body, plaintext không vào log), zod.

### [x] Task 3 [FE]: Dialog secret một lần + rotate/revoke + disable/enable
- Theo ràng buộc run 44: plaintext chỉ trong `useState` của dialog, không ở `useMutation` data/Query cache/devtools/intent/URL/Web Storage/toast/console/log/SSR; hiển thị text không qua `value`; đóng/unmount xoá; nút copy (Clipboard API) + cảnh báo; step-up cho rotate/revoke/disable: intent chỉ action, quay lại phải bấm lại; `uncertain` rotate ⇒ thông điệp riêng; revoke có xác nhận; disable PATCH `{disabled:true}` một mình + xác nhận "thu hồi mọi refresh token", 409 tự khoá thông điệp riêng; enable.
- **Acceptance**: component test (secret biến mất sau đóng; không có trong DOM khác/Query cache/storage; a11y dialog focus trap, Escape, `aria-live` cho cảnh báo).

### [x] Task 4 [E2E]: secret một lần + disable
- E2E: tạo client confidential qua UI ⇒ rotate (step-up nếu cần) ⇒ dialog hiện secret ⇒ secret dùng được ở `/token` (client_credentials không có — dùng introspect hoặc xác thực Basic tới `/revoke` của token giả ⇒ 200 vs 401) ⇒ đóng/reload không thấy lại; HTML/storage/Query không chứa secret; revoke version ⇒ secret không còn xác thực được; disable ⇒ client bị chặn; dọn.
- **Acceptance**: full E2E xanh 2 lần liên tiếp; grep output 0 secret.

## Câu hỏi cho tech-lead
- Q-45.1: Cách chứng minh secret dùng được trong E2E (endpoint nào nhận client auth mà không cần code).
- Q-45.2: Clipboard API trong môi trường test/E2E; quyền.
- Q-45.3: Phạm vi vừa 1 run không.

## Fold tech-lead (2026-10-22) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật (`a581963`): BE `admin-clients.controller.ts` (`listSecrets`/`issueSecret`/`revokeSecret`/`update`), `client-credential.service.ts`, `client-authentication.service.ts`, `token.controller.ts` (`/revoke`); FE `server/admin-api/client.ts`, `instance.ts`, `features/admin-api/{clients,hooks,query-client,step-up,types,keys}.ts`, `routes/clients/$clientId.tsx`; E2E `fe-admin-clients.spec.ts`, `config/env.ts`.

### Trả lời câu hỏi
- **Q-45.1** — Dùng `POST /revoke` (RFC 7009) với `Authorization: Basic base64(clientId:secret)`, `content-type: application/x-www-form-urlencoded`, body `token=<chuỗi ngẫu nhiên>`: secret hợp lệ ⇒ **200 `{}`** (token lạ là no-op), sai/đã revoke/client disabled ⇒ **401 `invalid_client`** (`findByClientId` loại client disabled). Không cần code/user/consent. Không dùng `/introspect` (cũng chạy được nhưng không thêm giá trị). Rate limit client-auth ở E2E là 1000 (`e2e/config/env.ts`) ⇒ vài lần 401 không gây 429. Gọi từ Node (Playwright `request`/`fetch`), không qua trình duyệt (không CORS). Client tạo qua UI phải là `confidential` + `client_secret_basic`.
- **Q-45.2** — Unit/component: jsdom không có `navigator.clipboard` ⇒ stub `Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true })`; test cả resolve (thông báo "Copied") và reject/không có API (thông báo "Copy failed — select the text and copy it manually", KHÔNG chứa secret). E2E **không** test clipboard (cần `grantPermissions`, khác nhau giữa headless/CI): đọc secret từ DOM (`getByTestId("issued-secret").textContent()`). Không tự xoá clipboard sau N giây (không kiểm chứng được, ghi đè clipboard của người dùng) — chỉ cảnh báo bằng text.
- **Q-45.3** — Vừa 1 run **sau khi cắt**: KHÔNG E2E step-up cho rotate/revoke/disable (E2E step-up round-trip đã có từ run 44; ở run này rotate ngay sau đăng nhập, `auth_time` còn mới ⇒ không chờ 65 s); step-up của các action mới chỉ kiểm bằng component test. Không thêm route riêng cho secrets: một panel trên `/clients/$clientId`.

### F1 — DEBT-308 (Task 1, thay text cũ)
- Trong `ClientPage` bọc **toàn bộ** phần thân detail (`ClientFacts` + `EditClient` + panel Secrets + vùng Disable/Enable mới) bằng `<Fragment key={clientId}>` (hoặc `remountDeps` theo `clientId`). Lý do: không chỉ form — state plaintext của dialog secret và state xác nhận disable cũng phải mất khi đổi `clientId` (nếu không, secret của client A có thể hiện trên trang của B). Đổi `it.fails` ⇒ `it`; thêm 1 case: dialog secret đang mở ở A, điều hướng sang B ⇒ secret không còn trong DOM.

### F2 — Lớp server admin API (Task 2, bổ sung)
- `client.ts` hiện chỉ có `Method = "GET" | "POST" | "PATCH"` và `read()` luôn `res.json()` ⇒ DELETE 204 sẽ thành `unavailable` + `uncertain`. Bắt buộc: thêm `"DELETE"`; operation "không body" (204 ⇒ `undefined`, không parse; 2xx khác 204 cho DELETE ⇒ `uncertain`). Timeout/5xx ở DELETE/POST ⇒ `uncertain` (đã đúng do `method !== "GET"`).
- `listSecrets(clientId)` GET (`admin.read`), zod allowlist `{ items: [{ version:int≥1, createdAt:string, expiresAt:string|null, revokedAt:string|null, status: enum(active,grace,expired,revoked) }] }`.
- `issueSecret(clientId)` POST **không body**; schema `{ clientId, version:int≥1, clientSecret: string.min(1).max(512) }`; server fn `createServerFn({ method: "POST" })`, input chỉ `ClientIdSchema`; trong handler đặt `cache-control: no-store` (+ `pragma: no-cache`) trên **response của server fn** (`getResponseHeaders().set(...)`) — cả khi trả lỗi. `clientSecret` không bao giờ vào `logServerError`, message lỗi hay `AdminApiFailure` (2xx sai schema ⇒ chỉ route + "response schema mismatch", `uncertain`).
- `revokeSecret({ clientId, version })` server fn POST ⇒ BE DELETE; `version` = `z.number().int().min(1).max(999_999_999)` ở input; path build `String(version)`.
- Query key `adminKeys.clients.secrets(clientId) = ["admin","clients","secrets",clientId]` (dưới `clients.all` ⇒ invalidation sẵn có phủ).
- Thêm `IssuedSecretViewDto`/`CredentialListViewDto` vào test drift `admin-schema-types.test.ts`.
- Acceptance thêm (unit, đo được): (a) response server fn issue có `cache-control: no-store`; (b) fetch mock trả body chứa secret giả `S3CR3T-…`: mọi spy `console.*`/`logServerError` và mọi `AdminApiFailure` không chứa chuỗi đó — nhánh 2xx sai schema, 5xx, timeout; (c) DELETE 204 ⇒ ok; 404 ⇒ `not_found`; timeout ⇒ `uncertain`; (d) version `0`, `-1`, `1.5`, `1e9` bị input validator từ chối, BE không được gọi.

### F3 — Dialog secret + rotate/revoke + disable/enable (Task 3, thay/bổ sung)
1. **Không `useMutation` cho issue.** `MutationCache` giữ `state.data` suốt thời gian observer còn mount (`gcTime: 0` chỉ tính sau khi hết observer) ⇒ plaintext vào cache. Gọi trực tiếp `issueSecret({ data })` trong handler của dialog, `pending` là `useState` cục bộ; xong (thành công/lỗi/uncertain) ⇒ `invalidateQueries(adminKeys.clients.secrets(clientId))`. Revoke/disable/enable được dùng `useMutation` (không có secret).
2. Plaintext chỉ ở `useState` của **component con chỉ mount khi dialog mở** (Dialog/AlertDialog từ gói `radix-ui` 1.7.0 đã có — KHÔNG cài thêm; thêm `components/ui/dialog.tsx`/`alert-dialog.tsx` kiểu shadcn). Đóng (nút, Escape) ⇒ unmount ⇒ mất state. Chặn đóng do click ra ngoài (`onInteractOutside` preventDefault); Escape vẫn đóng (a11y). Listener `pagehide` xoá state (bfcache). Hiển thị trong `<code data-testid="issued-secret">` (text, `select-all`), không `input value`, không đặt chính secret trong vùng `aria-live` (cảnh báo thì `role="status"`). Không `toast` chứa secret; toast "Secret copied" được phép.
3. Nút Issue/Rotate/Revoke/Disable/Enable disabled khi pending (chống double-submit ⇒ 2 version). Nhãn: chưa có version `active`/`grace` ⇒ "Issue secret", có ⇒ "Rotate secret" (cùng endpoint). Sau rotate, dialog ghi version cũ còn hiệu lực tới `expiresAt` lấy từ danh sách sau refetch (không tự tính).
4. **Step-up (thay "intent chỉ action")**: KHÔNG lưu intent cho rotate/revoke/disable/enable. Lý do: `EditClient` gọi `takeIntent` khi mount và `takeIntent` **xoá key `fea:stepup` bất kể action** ⇒ intent của panel secret sẽ bị form ăn mất (một key, đọc một lần). Khi nhận `step_up_required`: KHÔNG tự redirect; hiện alert "Confirm your identity to continue. Unsaved changes in Settings will be lost." + nút "Confirm identity" ⇒ `reauthenticate(path)` (tách từ `startStepUp`: chỉ `location.assign('/auth/login?stepup=1&returnTo=…')`, không ghi storage). Quay lại: không gì tự chạy, admin bấm lại. Test: sau `step_up_required` của rotate, `sessionStorage` không có `fea:stepup`, server fn không bị gọi lại.
5. **`uncertain` rotate** ⇒ đúng thông điệp run 44 ("Có thể đã tạo version mới mà không hiển thị được secret — xem danh sách version, revoke version lạ rồi rotate lại"), refetch danh sách, KHÔNG tự gửi lại.
6. **Revoke**: AlertDialog xác nhận nêu version + "ngay lập tức, không có grace; token đã cấp không bị thu hồi". Nếu version bị revoke là **version `active`/`grace` cuối cùng** (tính từ danh sách đang hiện) ⇒ thêm cảnh báo `role="alert"`: client sẽ không còn secret dùng được, mọi xác thực client (/token, /revoke, /introspect) lỗi cho tới khi Issue secret. Chỉ hiện nút Revoke cho `active`/`grace`. 404 ⇒ "Version này đã bị revoke hoặc không tồn tại" + refetch. `uncertain` ⇒ refetch + bảo kiểm danh sách.
7. **Public client**: không render panel secrets (không gọi `listSecrets`). Client admin-capable với admin không phải super_admin ⇒ 403 ⇒ thông điệp `forbidden` (không ẩn trước, BE quyết).
8. **Disable**: PATCH `{ disabled: true }` một mình (server fn `updateClient` có sẵn; KHÔNG trộn với form Settings). AlertDialog: disable thu hồi mọi refresh token của client, đăng nhập/gọi token bằng client này dừng ngay. 409 khi disable ⇒ thông điệp cố định "This client issues the admin console's own sign-in token and cannot be disabled here." **Enable**: PATCH `{ disabled: false }`, xác nhận ngắn, ghi rõ refresh token đã thu hồi không quay lại. Cả hai có thể `step_up_required` ⇒ như (4). Thành công/uncertain ⇒ invalidate `clients.all`.
9. Acceptance thêm (component, secret giả `S3CR3T-…`): sau khi đóng dialog (nút và Escape) và sau khi đổi `clientId`: `document.body.innerHTML`, `JSON.stringify` state của mọi query trong QueryCache và mọi mutation trong MutationCache, `localStorage`/`sessionStorage`, `location.href`, mọi spy `console.*` và `toast.*` **không** chứa chuỗi; khi dialog đang mở, QueryCache/MutationCache cũng không chứa. Focus vào dialog khi mở, trả về nút gốc khi đóng; click ngoài không đóng. Double click Rotate ⇒ server fn gọi đúng 1 lần.

### F4 — E2E (Task 4, thay text cũ)
Một test, client mới mỗi lần, `test.setTimeout` ≤ 120 s, không chờ refresh:
1. Đăng nhập, tạo client `confidential` + `client_secret_basic` qua UI.
2. Issue secret ⇒ đọc `issued-secret` ⇒ `waitForResponse` của server fn issue có `cache-control` chứa `no-store` ⇒ đóng ⇒ `POST /revoke` Basic với S1 ⇒ 200; `page.content()`, `localStorage`/`sessionStorage` không chứa S1; reload ⇒ không có `issued-secret`, HTML không chứa S1.
3. Rotate ⇒ S2; S1 (grace) và S2 ⇒ 200.
4. Revoke version 1 qua UI (xác nhận) ⇒ S1 ⇒ 401, S2 ⇒ 200.
5. Disable qua UI ⇒ S2 ⇒ 401; Enable ⇒ S2 ⇒ 200.
6. `finally`: disable qua admin API (như run 44). Không `console.log`/annotation chứa secret; message của `expect` không nội suy giá trị secret.
- Acceptance: full E2E xanh 2 lần liên tiếp; output reporter không chứa secret. CI `trace: retain-on-failure` có thể chụp DOM chứa secret của client E2E (đã disable ở `finally`) — chấp nhận, xem DEBT-310.

### Ngoài phạm vi run 45
React DevTools vẫn thấy `useState` khi dialog đang mở — không tránh được (plaintext phải hiển thị), chấp nhận. Không thêm Query/Router devtools. Không lọc/sort version phía server. Mất thay đổi chưa lưu của form khi step-up từ panel secret: chỉ cảnh báo bằng text (DEBT-309).
