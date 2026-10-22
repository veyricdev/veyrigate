# Tasks — run 43 — A5: API layer fe-admin (M5, lane ADMIN)

> Plan §6 A5: "server functions gọi admin API bằng access token của session; types sinh từ OpenAPI (D11); cấu hình TanStack Query (query key factory, retry, invalidation); xử lý `401` (refresh/đăng nhập lại) và `403 step_up_required` (chuyển sang `/auth/login?stepup=1` với `prompt=login&max_age=0`, quay lại đúng thao tác)" — nghiệm thu "step-up round-trip không mất dữ liệu form". D11: `openapi-typescript` sinh types từ `GET /openapi/admin.json` (dev-only, run 27). BE admin API đã có đủ (run 26–31) ⇒ MSW chỉ cần nếu tech-lead thấy cần cho test độc lập. Debt: DEBT-281 (E2E step-up round-trip), DEBT-282/289 (503 vs 500 khi Redis/IdP down).
>
> Thứ tự: Task 1 → 2 → 3 → 4 (frontend-dev). KHÔNG sửa be/ (báo nếu lệch hợp đồng). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: Types từ OpenAPI
- `openapi-typescript` (pin exact ≥14 ngày) sinh `src/server/admin-api/schema.d.ts` từ snapshot OpenAPI commit vào repo (script `gen:api` đọc từ BE dev/E2E hoặc file; CI kiểm snapshot không lệch — tech-lead chốt).
- **Acceptance**: types sinh được, typecheck dùng types; script tái lập được.

### [x] Task 2 [FE]: Admin API client phía server
- Client gọi `ADMIN_API_BASE_URL` với AT của session (refresh trước nếu cần — dùng cơ chế run 42), timeout, không retry mutation, map lỗi: 401 ⇒ refresh 1 lần rồi đăng nhập lại; 403 `step_up_required` ⇒ lỗi có kiểu cho UI; 403 khác/404/409/400 ⇒ lỗi có kiểu, message chung; 5xx/network ⇒ 503 có kiểu (DEBT-289). Không bao giờ trả AT/body lỗi thô về client.
- Server functions (`createServerFn`) mỏng cho các endpoint A6 sẽ dùng (list/get clients trước; còn lại khi A6 cần — YAGNI).
- **Acceptance**: test với BE thật (int, như run 42 dùng fake IdP + BE?) hoặc mock theo hợp đồng: mỗi mã lỗi map đúng, không rò token/message.

### [x] Task 3 [FE]: TanStack Query + step-up round-trip
- `@tanstack/react-query` (phiên bản đã chốt run 41: 5.104.1 — xác nhận ≥14 ngày), query key factory, retry chỉ cho GET lỗi tạm, invalidation sau mutation.
- Step-up: mutation nhận `step_up_required` ⇒ lưu ý định (payload form) an toàn phía server hoặc sessionStorage KHÔNG chứa secret (tech-lead chốt) ⇒ `/auth/login?stepup=1&returnTo=…` ⇒ quay lại khôi phục form và cho người dùng xác nhận gửi lại (không tự gửi).
- **Acceptance**: component test round-trip không mất dữ liệu form; secret (vd. client secret vừa tạo) không bao giờ lưu để khôi phục.

### [x] Task 4 [FE/E2E]: DEBT-282 + DEBT-281 (theo fold: DEBT-282 + DEBT-289 + `azp`; DEBT-281 → A6.1)
- DEBT-282: SSR khi Redis/IdP down trả 503 (nếu router không cho, chặn sớm ở server middleware trước router — tech-lead chốt).
- DEBT-281: E2E step-up round-trip thật (fe-admin → thao tác nhạy cảm đơn giản, vd. đổi `redirectUris` client E2E → step-up → quay lại → xác nhận → thành công).
- **Acceptance**: test 503; E2E xanh 2 lần liên tiếp.

## Câu hỏi cho tech-lead
- Q-43.1: Nguồn OpenAPI cho gen (snapshot file vs BE chạy) + kiểm lệch trong CI.
- Q-43.2: Lưu ý định form qua step-up ở đâu.
- Q-43.3: Test API client: BE thật trong int (cần boot BE từ fe-admin test?) hay mock theo hợp đồng.
- Q-43.4: Phạm vi vừa 1 run không.

---

## Fold tech-lead (2026-10-22) — ƯU TIÊN HƠN text cũ ở trên

> Kết luận **PASS kèm fold**. Đã đối chiếu với code thật ở `9d2de22`. Không cần sửa `be/`, không thêm MSW.
>
> **Phiên bản chốt** (tra registry, chỉ đọc; pin exact, không dùng `^`):
> - `openapi-typescript@7.13.0`: devDependency, phát hành 2026-02-11, peer `typescript ^5.x` khớp 5.7.3.
> - `@tanstack/react-query@5.104.1`: dependency, phát hành 2026-10-02 (được 20 ngày), peer `react ^18 || ^19` khớp 19.3.0.
>
> Không thêm `openapi-fetch`, `msw`, `@tanstack/react-router-ssr-query` hay persister.

### Phạm vi cuối (Q-43.4)
- Giữ Task 1, 2, 3 và phần **DEBT-282 + DEBT-289** của Task 4. Thêm kiểm `azp` (một dòng, lấy từ DEBT-288).
- **DEBT-281 (E2E step-up round-trip) chuyển sang A6.1.**
  - A5 chưa có trang hay form thật nào. Dựng một route "sandbox" chỉ để chạy E2E thì sẽ thành code chết ship lên production.
  - A6.1 đã có nghiệm thu "sửa `redirect_uris` đi qua step-up", nên E2E nên đặt ở đó.
  - Trong A5, round-trip được chứng minh bằng component test (F3) và unit test server (F2).
- DEBT-283, DEBT-285 và phần còn lại của DEBT-288 không làm trong run này. Đích trong backlog đã được dời.

### F1 — Task 1: nguồn OpenAPI và kiểm lệch (Q-43.1)
- **Nguồn là snapshot commit vào repo**: `fe-admin/openapi/admin.json`. Gen chạy offline từ file nên build và CI không cần BE.
  - `gen:api` = `openapi-typescript openapi/admin.json -o src/server/admin-api/schema.d.ts`. File sinh ra được commit và nằm dưới `src/server/`.
  - `fetch:api` = `node scripts/fetch-openapi.mjs`. Script lấy `GET ${ADMIN_OPENAPI_URL || "http://127.0.0.1:4000"}/openapi/admin.json` từ BE dev đang chạy, rồi ghi `JSON.stringify(doc, null, 2) + "\n"`. Không đọc `.env`, không gửi token.
- **Kiểm lệch hai lớp:**
  1. Job CI `quality` chạy `pnpm -C fe-admin gen:api && git diff --exit-code -- fe-admin/src/server/admin-api/schema.d.ts`, để types luôn khớp snapshot.
  2. Spec E2E mới `e2e/tests/admin-openapi.spec.ts` (BE E2E chạy `NODE_ENV=test` nên route có sẵn).
     - GET `/openapi/admin.json` rồi so **deep-equal** với `fe-admin/openapi/admin.json`.
     - Khi lệch, thông báo lỗi phải in lệnh cập nhật: `pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api`.
     - Spec không đăng nhập và không ghi DB.
- **Phát hiện khi đối chiếu code:** OpenAPI của BE **không có schema cho response**.
  - Bằng chứng: không controller admin nào có `@ApiOkResponse`/`@ApiResponse`, `be/nest-cli.json` không bật swagger plugin, mapper trả về `interface`.
  - Vì vậy types sinh ra chỉ đúng cho **request**: DTO có `@ApiProperty`, query, path.
  - Body request của server fn dùng type từ `schema.d.ts`, ví dụ `components["schemas"]["UpdateClientDto"]`.
  - **Response được parse bằng zod** trong `src/server/admin-api/schemas.ts`, giống `AdminMeSchema`. Zod mặc định strip, nên schema đóng vai allowlist: field BE lỡ thêm không bao giờ tới browser.
  - Response sai schema thì log và trả lỗi 500 chung (không phải 503).
  - Bổ sung response schema ở BE được ghi thành DEBT-290.
- **Nghiệm thu thêm:**
  - `typecheck` dùng type sinh ra ít nhất ở server fn `updateClient`.
  - Spec lệch-snapshot xanh.
  - Bước diff đã có trong `ci.yml`.

### F2 — Task 2: admin API client phía server (cổng security)
- **Tài sản:** AT admin (`admin.read admin.write`, `aud` admin), RT trong phiên Redis, dữ liệu tenant.
- **Actor:** admin đã đăng nhập, người dùng không phải admin, trang cross-site.
- **Trust boundary:** browser ⇄ `/_serverFn` (CSRF middleware đã có) và BFF ⇄ BE admin API.
- **Không có proxy chung** (chống confused deputy và SSRF):
  - Mỗi server fn gọi **một** endpoint cố định với method cố định.
  - Input được validate bằng zod qua `.inputValidator`.
  - ID trong path phải qua zod (`clientId` dài 1–128 ký tự, không chứa `/`, `\`, `.` đứng riêng) rồi `encodeURIComponent`.
  - Không bao giờ nhận URL, path, method hay header từ client.
- **Lấy AT:** thêm `accessToken(request)` vào `createAuth`.
  - Hàm dùng lại `store.get` và `refresh` (single-flight) như `viewer`.
  - Trả `{ token, key }` hoặc null, kèm `setCookie` xoá khi cần.
  - Token không ra khỏi `src/server/`.
- **Forced refresh khi gặp 401:** `refresh(key, { staleAccessToken })`.
  - Trong `doRefresh`, sau khi đọc lại phiên: nếu `current.tokens.accessToken !== staleAccessToken` thì một request khác đã refresh rồi, dùng token đó và KHÔNG refresh nữa.
  - Nếu còn bằng nhau thì refresh, bất kể `atExp`.
  - Dùng chung `inflight`. Test bắt buộc: hai lời gọi song song cùng nhận 401 thì fake IdP chỉ nhận **đúng 1** refresh grant (RT single-use, replay sẽ revoke cả family).
- **Bảng ánh xạ lỗi.** Wire shape lấy theo `be/src/modules/identity/tenant-context/admin-auth.errors.ts`.

  | BE trả | BFF làm | `code` trả client |
  |---|---|---|
  | 401 `invalid_token` | Forced refresh **1 lần**, rồi gửi lại **1 lần**, kể cả mutation: 401 do guard chặn trước handler nên chưa có gì được thực thi. Nếu refresh trả null (`invalid_grant`) hoặc lần gửi lại vẫn 401: `store.destroy`, revoke RT best-effort, append `set-cookie` xoá `fea_sid`. | `unauthenticated` |
  | 403 `step_up_required` | Không refresh: AT lấy từ refresh grant không bao giờ có `auth_time` (`tenant-context.ts`). | `step_up_required` |
  | 403 `forbidden` hoặc `insufficient_scope` | — | `forbidden` |
  | 404 `not_found` | — | `not_found` |
  | 400 `invalid_request` hoặc 409 `conflict` | Lấy `error_description` nếu là string, cắt còn tối đa 200 ký tự, hiển thị dạng text thuần (A6.1 cần). | `invalid_request` / `conflict` |
  | 5xx, 3xx (`redirect: "manual"`), body không parse được, lỗi network, timeout | Không retry ở BFF. | `unavailable`, thêm `uncertain: true` nếu là mutation gặp timeout, lỗi network hoặc 5xx (không biết kết quả) |
  | Mọi trường hợp khác | Log. | 500 chung |

- **Retry và timeout:**
  - BFF không retry gì ngoài trường hợp 401 nói trên. Retry GET do TanStack Query lo (F3), để không nhân đôi số lần retry.
  - Mỗi lời gọi timeout 10 s qua `fetchWithTimeout`.
- **Truyền lỗi qua boundary:** `AdminApiError extends PublicError`.
  - Own property gồm `code` (enum allowlist) và `uncertain?`.
  - Message là câu chung theo `code`. Riêng 400 và 409 dùng `error_description` đã cắt.
  - Test giống `error-boundary.test.tsx`: body serialise chỉ có name, message, code, status, uncertain.
  - **Không có AT, `WWW-Authenticate` hay body BE thô.**
  - Nếu seroval không giữ own property thì đổi sang trả union giá trị `{ ok:false, error:{ code, … } }` và ghi lý do vào log.md.
- **Log:** `logServerError` ghi method, route template (`PATCH /admin/clients/:clientId`) và status. Không ghi body, header hay token.
- **Server fn (YAGNI):**
  - `listClients` (GET), `getClient` (GET).
  - `updateClient`: serverFn POST, gọi BE `PATCH /admin/clients/{id}`. Đây là mẫu mutation có step-up.
  - Không làm UI (thuộc A6.1).
- **Test (Q-43.3): mock theo hợp đồng bằng cách inject `fetch`.**
  - Mở rộng `test/support/fake-idp.ts`, vốn đã có `/admin/me` và refresh. Không dùng MSW, không boot BE trong vitest.
  - Body lỗi copy đúng từ `admin-auth.errors.ts`.
  - Case bắt buộc:
    - mỗi dòng của bảng trên;
    - 401 rồi refresh rồi OK;
    - 401 rồi `invalid_grant`: phiên bị xoá và cookie bị xoá;
    - 401 hai lần liên tiếp;
    - 401 song song: chỉ 1 refresh;
    - mutation timeout: `uncertain`, fetch chỉ được gọi 1 lần;
    - không có cookie: `unauthenticated` và không gọi BE;
    - response có field lạ (`secretHash`): field bị strip;
    - `clientId="../x"`: zod chặn, BE không bị gọi;
    - canary AT không xuất hiện trong lỗi đã serialise hay trong `console.error`.
  - Hợp đồng thật được bảo đảm bằng snapshot OpenAPI (F1) và E2E ở A6.1.

### F3 — Task 3: TanStack Query và step-up (Q-43.2)
- **QueryClient** được tạo trong `getRouter()`: mỗi request SSR một instance, browser một instance. Đưa vào cây bằng `QueryClientProvider` ở root.
  - **Không SSR prefetch, không hydrate:** query chạy phía client sau guard (xem DEBT-291).
  - `queries.retry = (n, e) => n < 2 && isTransient(e)`. Transient gồm `unavailable` và lỗi 500/503 chung.
  - **Không bao giờ retry** `unauthenticated`, `step_up_required`, `forbidden`, `not_found`, `invalid_request`, `conflict`.
  - `mutations.retry = 0` và **`mutations.gcTime = 0`**, để kết quả mutation (ví dụ secret vừa tạo ở A6.1) không nằm lại trong mutation cache.
  - Không persister, không ghi cache vào storage.
- **Query key factory** ở `src/features/admin-api/keys.ts`:
  - `adminKeys.all = ["admin"]`, `clients.all`, `clients.list(params)`, `clients.detail(id)`.
  - Mutation thành công thì invalidate `clients.all`. Lỗi có `uncertain` cũng invalidate, để hiện trạng thái thật.
- **`unauthenticated`:** gọi `location.assign("/auth/login?returnTo=" + encodeURIComponent(pathname + search))`, full reload như guard.
- **Step-up (Q-43.2): ý định lưu trong `sessionStorage` phía client, KHÔNG lưu ở Redis.**
  - Lý do: callback step-up luôn cấp session id **mới** và huỷ phiên cũ (`bff.ts`, bước 10). State server-side gắn với phiên cũ sẽ mất, hoặc phải tốn công di chuyển. `sessionStorage` thì sống qua điều hướng cross-origin trong cùng tab và chỉ thuộc tab đó.
  - Helper ở `src/features/admin-api/step-up.ts`: `saveIntent({ action, path, payload })` và `takeIntent(action, path, viewerSub)`.
  - Lưu dưới key `fea:stepup`, giá trị `{ v:1, action, path, sub, payload, exp }`, với `exp = now + 10 phút` (bằng TTL tx đăng nhập).
  - **Dùng một lần:** đọc xong là xoá, kể cả khi bị loại.
  - Ý định bị loại khi:
    - đã hết hạn;
    - khác `action` hoặc khác `path`;
    - `sub` khác viewer hiện tại (máy dùng chung);
    - `v` không nhận ra, hoặc JSON hỏng.
  - **Payload là dữ liệu không tin cậy:** parse lại bằng zod schema của form rồi mới đổ vào form.
  - **Chỉ lưu các field form khai báo trong allowlist.** Thao tác không có payload (rotate, revoke) chỉ lưu `action` và id.
  - **Không bao giờ lưu** secret, token hay dữ liệu server trả về.
  - Bọc mọi truy cập storage bằng `try/catch`. Storage bị chặn thì vẫn step-up được, chỉ mất bản nháp, và có toast báo.
  - Nút đăng xuất xoá key này trước khi POST logout.
  - **Luồng:**
    1. Mutation nhận `step_up_required`.
    2. Gọi `saveIntent`.
    3. Gọi `location.assign("/auth/login?stepup=1&returnTo=" + encodeURIComponent(path))`. Phía server, `sanitizeReturnTo` chặn open redirect.
    4. Khi quay lại, form gọi `takeIntent` và khôi phục giá trị.
    5. Form hiện thông báo "Bạn vừa xác thực lại, hãy kiểm tra rồi bấm Gửi". **Người dùng tự bấm gửi**, không tự động gửi.
    6. Cửa sổ step-up của BE là 5 phút. Quá hạn thì nhận lại `step_up_required` và lặp lại luồng.
- **Component test (happy-dom).** Dùng một harness form chỉ nằm trong `test/` (không ship), gồm `useMutation` và helper. Các case:
  - Gửi form, server fn mock ném `step_up_required`: `location.assign` được gọi với đúng URL.
  - Unmount rồi remount với cùng viewer: form có lại giá trị, mutation **chưa** chạy lại. Bấm gửi thì mutation chạy đúng 1 lần.
  - Remount khi `sub` khác, đã hết hạn hoặc khác path: form rỗng, key bị xoá.
  - Field secret không nằm trong allowlist: không có trong `sessionStorage`.
  - Payload bị sửa tay sai schema: bị loại.
  - Query: `step_up_required` và `forbidden` không retry (queryFn chạy 1 lần); `unavailable` được retry đúng 2 lần.

### F4 — Task 4: DEBT-282, DEBT-289 và `azp`
- **DEBT-282 (SSR trả 503).** Chặn ở server entry `src/server.ts`, trước router. Không sửa router-core.
  - Bọc `handler.fetch` trong `AsyncLocalStorage.run({ unavailable:false }, …)`. Module ALS là server-only.
  - Khi `toPublicError` trả status 503 thì đặt cờ. Việc này làm ở hai nơi: nhánh server của `safely` và `serverFnErrorBoundary`.
  - Sau `handler.fetch`: nếu cờ đã đặt và `res.status === 500` thì trả `new Response(res.body, { status: 503, headers })`. Chỉ chuyển tiếp stream, không đọc nó. Thêm `cache-control: no-store`.
  - Các status khác giữ nguyên. Không xoá cookie, không redirect (giữ fold run 42).
  - Test:
    - Trang SSR khi Redis hoặc IdP chết: 503, HTML lỗi chung, không có `set-cookie` xoá.
    - Lỗi thông thường: vẫn 500.
    - Trang không tồn tại: vẫn 404.
- **DEBT-289.** Áp dụng trong `createDiscovery` và các lời gọi IdP mà lỗi còn chưa được xử lý.
  - Lỗi network, timeout (fetch reject, `AbortSignal.timeout`) và HTTP 5xx đổi thành `ServiceUnavailableError`.
  - Issuer mismatch, sai schema, endpoint khác origin vẫn là `Error` (500): đây là lỗi cấu hình, phải fail-closed.
  - Test:
    - Logout và login khi fetch discovery bị reject: trả 503, và logout vẫn xoá `fea_sid`.
    - Discovery trả 500: thành 503.
    - Issuer mismatch: vẫn 500.
- **`azp` (một phần DEBT-288).** Trong `id-token.ts` thêm `if (payload.azp !== undefined && payload.azp !== clientId) throw …` (OIDC Core §3.1.3.7). Kèm một test âm.
- **Nghiệm thu chung:**
  - `pnpm -C fe-admin test`, `typecheck`, `lint`, `build`, `check:bundle` đều xanh.
  - `pnpm -C e2e e2e` xanh 2 lần liên tiếp, kể cả spec OpenAPI mới.
  - Client bundle không chứa `src/server/admin-api/*` (`check:bundle` sẵn có).
