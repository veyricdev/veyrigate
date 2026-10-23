# Tasks — run 50 — A6.6: Dashboard (M5, lane ADMIN) + DEBT-352

> Plan §6 A6.6: "Dashboard: số client/resource/user, sự kiện bảo mật gần đây, trạng thái health BE" — nghiệm thu "Dữ liệu từ API thật". Size S. Tái dùng server fns đã có (clients/resources/users/audit/keys) — tránh endpoint BE mới nếu không cần; nếu đếm chính xác đòi hỏi duyệt toàn bộ cursor thì tech-lead quyết định (đếm gần đúng "≥ N", hoặc Task 0 [BE] endpoint thống kê). Health: endpoint health BE hiện có (không lộ chi tiết nội bộ cho trình duyệt).
>
> Thứ tự: Task 1 → 2 → 3 (frontend-dev), Task 0 [BE] nếu tech-lead yêu cầu. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop.

### [x] Task 1 [FE]: DEBT-352 (bỏ `enabled` thừa của `useSigningKeys`).

### [x] Task 2 [FE]: `/` dashboard — thẻ số client/resource/user (theo quyền: tenant_admin chỉ thấy tenant của mình; super_admin có thêm keys), danh sách 5–10 sự kiện bảo mật gần đây (`TOKEN_REUSE_DETECTED`, `SIGNING_KEY_ROTATED`, lock…) link sang `/audit`, trạng thái health BE (up/down/không rõ) qua BFF; mỗi khối lỗi độc lập (một khối lỗi không làm hỏng trang); không tự refetch dồn dập.

### [x] Task 3 [E2E]: dashboard hiển thị số liệu khớp API, có sự kiện bảo mật vừa tạo (vd. lock user E2E), health "up".

## Câu hỏi cho tech-lead
- Q-50.1: Đếm thế nào (BE không có count) — gần đúng, duyệt cursor có giới hạn, hay Task 0 [BE] `/admin/stats`?
- Q-50.2: Health: endpoint nào, gọi từ BFF hay trình duyệt, thông tin gì được phép hiển thị.
- Q-50.3: Sự kiện bảo mật gần đây — filter BE chỉ nhận một `action` ⇒ nhiều request hay lọc client-side.

## Fold tech-lead (2026-10-23) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu code thật `e484913` (CodeGraph + đọc trực tiếp): BE `modules/admin/{admin.dto.ts (PageQueryDto, AuditQueryDto), admin-clients,admin-resources,admin-users,admin-audit,admin-keys}.controller.ts`, `modules/health/health.controller.ts`, `modules/security/audit/audit-action.enum.ts`; FE `routes/{index,__root}.tsx`, `routes/{keys,audit}/index.tsx`, `features/admin-api/{hooks,keys,audit,clients,inputs,query-client}.ts`, `server/admin-api/{client,instance,schemas}.ts`, `server/oidc/discovery.ts` (`fetchWithTimeout`), `server/auth/bff.ts` (refresh single-flight `inflight`), `features/auth/viewer*.ts`; E2E `tests/support/{admin,fe-admin}.ts`, `tests/fe-admin-audit.spec.ts`, `config/env.ts` (`ADMIN_API_BASE_URL = ISSUER`).

### Sự thật từ code (sửa text ở trên)
- BE **không có** count/total/stats. List clients/resources/users/audit: `?limit` 1..100 (mặc định 20) + `nextCursor` (`toPage` lấy `limit+1`) ⇒ một trang 100 với `nextCursor !== null` nghĩa là "> 100".
- Phạm vi dữ liệu:
  - clients = tenant của token (`listForTenant`);
  - users = membership của tenant trong token (cả `active` lẫn `suspended`);
  - **resources = toàn cục** (không lọc tenant);
  - audit = tenant của token (lọc chặt, DEBT-140);
  - keys = chỉ super_admin (tenant_admin ⇒ 403).
  - super_admin chưa xuyên tenant (DEBT-124/143) ⇒ mọi số liệu theo tenant là của tenant trong token.
- `GET /admin/audit` nhận **một** `action` (`IsIn(AuditAction)`), không nhận danh sách.
- Health BE: `GET /health` (liveness, luôn 200) và `GET /ready` (readiness).
  - **Công khai, không auth, không METRICS_TOKEN**; `Cache-Control: no-store`.
  - Body là enum cố định: `{status:'ok',mongo:'up',redis:'up'}` (200) hoặc `{status:'error',mongo:'up'|'down',redis:'up'|'down'}` (503). Không có message/host/stack.
  - `/metrics` (METRICS_TOKEN) KHÔNG dùng.
- `ADMIN_API_BASE_URL` là gốc BE (E2E = issuer) ⇒ BFF gọi `${base}/ready`.
- `AUTH_ACCOUNT_LOCKED` (khoá do đăng nhập sai) **không gắn tenantId** (DEBT-140) ⇒ không bao giờ hiện trong audit tenant ⇒ KHÔNG đưa vào dashboard. `SIGNING_KEY_ROTATED` chỉ hiện ở tenant của super_admin đã xoay (DEBT-350).
- `routes/index.tsx` hiện là placeholder. Guard root (`__root.tsx`) đã chặn người chưa đăng nhập và người không phải admin. `viewer.roles` có sẵn trong route context.

### Trả lời câu hỏi
- **Q-50.1 — Đếm**: KHÔNG thêm Task 0 [BE], KHÔNG duyệt cursor.
  - Mỗi thẻ đọc **một trang `limit: 100`** bằng hook sẵn có.
  - `nextCursor === null` ⇒ hiển thị `items.length`; ngược lại ⇒ `100+` (tên truy cập "More than 100").
  - Không bao giờ hiện số chính xác khi còn trang. Đếm chính xác ⇒ DEBT-356.
- **Q-50.2 — Health**: gọi từ **BFF** (server fn), không gọi từ trình duyệt. Dùng BE `/ready`. Trình duyệt chỉ nhận `"up" | "down" | "unknown"` (không tên dependency, không status code, không body). Chi tiết ở F2.
- **Q-50.3 — Sự kiện bảo mật**: **một request cho mỗi action** (3 request, `limit: 10`) qua server fn `listAudit` sẵn có; gộp và sắp xếp ở trình duyệt, lấy 10 mới nhất.
  - Không lọc client-side từ danh sách chưa lọc: sự kiện bảo mật cũ hơn sẽ bị các sự kiện admin thường đẩy ra khỏi trang.

### Phạm vi, phân công, thứ tự
- Không có Task 0 [BE]. Task 1 → Task 2 → Task 3, cả ba giao **frontend-dev**.
- Ngoài phạm vi: endpoint đếm/stats (DEBT-356), số liệu xuyên tenant (DEBT-124/143), event OAuth gắn tenant (DEBT-140), auto-refresh/polling, biểu đồ.

### F1 — Task 1 [FE]: DEBT-352
- `hooks.ts`: đổi thành `useSigningKeys()` không tham số, bỏ `enabled` (gate là chỉ mount component cho super_admin). `routes/keys/index.tsx` gọi `useSigningKeys()`. Cập nhật JSDoc.
- Test cũ phải xanh, không sửa test.

### F2 — Task 2 [FE]: dashboard `/` (thay text Task 2)
- **Health (BFF)**
  - `server/admin-api/client.ts` thêm `readiness(ctx): Promise<"up" | "down" | "unknown">`:
    - Trước khi gọi: `deps.auth.accessToken(ctx.request)` (append `setCookie` nếu có). Không có session ⇒ `AdminApiError("unauthenticated")` và **0 fetch** (fe-admin không làm proxy cho người ẩn danh dò BE).
    - Gọi `fetchWithTimeout(deps.fetch, base + "/ready", { method: "GET", headers: { accept: "application/json" } }, 3000)`. **KHÔNG gửi `authorization`** (endpoint công khai), không retry, không refresh khi 401.
    - 200 + body `status === "ok"` ⇒ `"up"`; 503 + body `status === "error"` ⇒ `"down"`.
    - Mọi trường hợp khác (timeout, lỗi mạng, 3xx, 401/404/500, body không phải JSON hoặc sai dạng) ⇒ `"unknown"` + `logServerError("admin api GET /ready", err)`. KHÔNG log body.
    - Kiểm body bằng zod cục bộ chỉ đọc `status` (`z.object({ status: z.enum(["ok","error"]) })`). KHÔNG trả `mongo`/`redis` ra khỏi hàm.
  - `features/admin-api/health.ts`: `getBackendHealth = createServerFn({ method: "GET" }).handler(() => adminCall((api, ctx) => api.readiness(ctx)))`, không input.
  - `keys.ts`: `health: ["admin", "health"] as const`. `hooks.ts`: `useBackendHealth()` với `retry: false`.
- **Số liệu**: dùng hook sẵn có `useClients({ limit: 100 })`, `useResourcePage({ limit: 100 })`, `useUsers({ limit: 100 })`. KHÔNG thêm server fn đếm.
  - Hàm thuần `countText(page) => page.nextCursor === null ? String(page.items.length) : "100+"`.
  - Nhãn: "Clients (this tenant)", "Users (this tenant)", "Resources (all tenants)". Mỗi thẻ link tới `/clients`, `/users`, `/resources`.
  - super_admin có thêm thẻ "Signing keys", nằm trong component riêng chỉ mount khi `viewer.roles.includes("super_admin")` (khuôn `routes/keys/index.tsx`). Thẻ dùng `useSigningKeys()`, hiện kid active (font mono, dạng text) và số key retiring, link `/keys`.
  - tenant_admin ⇒ không mount thẻ keys ⇒ 0 lần gọi `listSigningKeys`.
- **Sự kiện bảo mật gần đây**
  - `const SECURITY_ACTIONS = ["TOKEN_REUSE_DETECTED", "SIGNING_KEY_ROTATED", "ADMIN_USER_LOCKED"] as const`. Không thêm `AUTH_ACCOUNT_LOCKED` vì nó không bao giờ có trong audit tenant (DEBT-140).
  - Dùng `useQueries` (hoặc 3 `useAuditEvents`) với `{ action, limit: 10 }`, qua `adminKeys.audit.list` và `listAudit` sẵn có. Gộp, sắp xếp theo `timestamp` giảm dần (bằng nhau ⇒ theo `eventId`), lấy 10.
  - Mỗi dòng render bằng text React, không `dangerouslySetInnerHTML`: action, nhãn bảo mật bằng chữ (khuôn `alertLabel` của `/audit`), `timestamp` ISO nguyên văn, `result`, `targetId`.
    - Được chuyển `alertLabel` sang file dùng chung nếu cần, nhưng không đổi hành vi `/audit`.
    - Mỗi dòng có link "View in audit log" tới `/audit?action=<action>`.
    - KHÔNG hiện IP/UA/metadata.
  - **Fail-closed**:
    - Bất kỳ query nào trong 3 query lỗi ⇒ khối hiện lỗi + "Try again" (refetch các query lỗi). **Không** hiện "No recent security events" và không hiện danh sách thiếu.
    - Đang tải ⇒ trạng thái loading.
    - Rỗng thật ⇒ "No recent security events in this tenant."
  - Câu ghi chú cố định dưới tiêu đề: "Events recorded for this tenant." (đúng với DEBT-140/350).
- **Hiển thị health**: "Identity provider: Up" / "Down — a dependency is not ready" / "Unknown — no answer from the identity provider". Dùng chữ, không chỉ màu. Server fn lỗi (unavailable hoặc throw) ⇒ hiển thị "Unknown".
- **Cô lập lỗi**
  - Mỗi khối là component riêng với query riêng.
  - Khối lỗi ⇒ hiện `AdminRequestError.message` (hoặc thông điệp cố định khi lỗi không phải `AdminRequestError`) + "Try again" trong khối đó. Các khối khác vẫn render bình thường.
  - `unauthenticated` vẫn đi `signInAgain` (QueryCache sẵn có).
- **Không refetch dồn dập**: KHÔNG `refetchInterval`, không polling, không vòng lặp cursor. Retry theo `isTransient` mặc định (≤ 2); health dùng `retry: false`.
- **Test** (RTL + fake BE như run 48/49):
  - BFF `readiness`:
    - 200 ok ⇒ up; 503 có error-body ⇒ down.
    - 200 body lạ / 500 / 302 / timeout / body không phải JSON ⇒ unknown.
    - Request tới `/ready` **không** có header `authorization`.
    - Không có session ⇒ `unauthenticated` và 0 fetch.
    - `JSON.stringify` kết quả server fn không chứa `mongo`/`redis`.
  - Đếm:
    - 100 items + có `nextCursor` ⇒ "100+"; 7 items + `nextCursor` null ⇒ "7".
    - Mỗi hook được gọi với `{ limit: 100 }`.
  - Keys: tenant_admin ⇒ không có thẻ keys, 0 lần gọi `listSigningKeys`. super_admin ⇒ thẻ có kid active.
  - Sự kiện:
    - `listAudit` được gọi đúng 3 lần, với đúng 3 action và `limit: 10`.
    - Kết quả gộp theo thứ tự thời gian giảm dần xuyên các action; > 10 ⇒ cắt còn 10.
    - Một action lỗi ⇒ khối lỗi, không có "No recent security events".
    - `targetId` `<img src=x onerror=alert(1)>` hiện dạng text.
    - Link `/audit?action=ADMIN_USER_LOCKED`.
  - Cô lập: `listUsers` lỗi ⇒ thẻ Clients/Resources và health vẫn hiện.
  - **Mutation bắt buộc** (ghi kết quả RED thật):
    - `countText` luôn trả `items.length` ⇒ RED.
    - Bỏ gate super_admin ⇒ RED.
    - Khối sự kiện vẫn hiện danh sách khi một query lỗi ⇒ RED.
    - Gửi `authorization` tới `/ready` ⇒ RED.
    - Bỏ kiểm session trong `readiness` ⇒ RED.

### F3 — Task 3 [E2E] (thay text Task 3)
- File `e2e/tests/fe-admin-dashboard.spec.ts` (khuôn `fe-admin-audit.spec.ts`).
- Chuẩn bị: `adminToken` (context riêng) ⇒ tìm E2E user qua `/users?email=` ⇒ `POST /users/{id}/lock` rồi `unlock`. Đặt unlock cleanup trong `finally` như spec users/audit.
- Kỳ vọng lấy từ API thật: `adminApi` GET `/clients?limit=100`, `/resources?limit=100`, `/users?limit=100`, `/keys` ⇒ tính text mong đợi (`n` hoặc `100+`) và kid active.
- fe-admin `/` ⇒ `signInAsAdmin`, rồi kiểm:
  - các thẻ khớp text mong đợi;
  - thẻ Signing keys có kid active (admin E2E là super_admin);
  - health "Up";
  - khối sự kiện có dòng `ADMIN_USER_LOCKED` với `targetId` = userId và link `href="/audit?action=ADMIN_USER_LOCKED"`.
- Kiểm âm: URL `/` không có query; text trang không có `eyJ`, `mongo`, `redis`, hay email của E2E user.
- Không FLUSH/drop, không compose up. Suite chạy tuần tự (`workers: 1`) nên số liệu không đổi giữa lúc đọc API và lúc đọc trang.

### Cổng security (đã kiểm)
- **Tài sản/actor/boundary**
  - Tài sản: số liệu tenant, audit tenant, kid active, trạng thái BE.
  - Actor: super_admin, tenant_admin. Non-admin/ẩn danh bị guard root chặn; server fn health tự kiểm session.
  - Boundary: trình duyệt ↔ BFF (server fn, không input tự do) ↔ BE (`AdminTokenGuard`, scope `admin.read`, `assertSuperAdmin` cho keys; `/ready` công khai).
- **Invariant**: chỉ đọc, không có mutation mới. Tenant lấy từ token ở BE (FE không gửi tenantId). Không hiện số chính xác giả khi còn trang.
- **Abuse case**
  - Gọi `getBackendHealth` ẩn danh ⇒ `unauthenticated`, 0 request tới BE (không khuếch đại ping Mongo/Redis).
  - tenant_admin gọi thẳng `listSigningKeys` ⇒ BE trả 403.
  - IDOR/enumeration ⇒ không có id đầu vào.
  - XSS qua `targetId`/`action` ⇒ render text React.
  - 401 song song từ 6–7 query ⇒ đã có refresh single-flight `inflight`.
- **Failure semantics**
  - BE/Mongo/Redis chậm ⇒ health timeout 3s ⇒ "Unknown" (fail-closed: không bao giờ "Up" khi không chắc).
  - Một list lỗi ⇒ chỉ khối đó lỗi.
  - Một action audit lỗi ⇒ cả khối sự kiện lỗi (không khẳng định "không có sự kiện").
- **Exposure**
  - Trình duyệt chỉ nhận enum health 3 giá trị (không tên dependency, status hay body).
  - Dashboard không hiện IP/UA/metadata. Log chỉ có route template `/ready`. URL không có tham số.
  - Test âm: F2 (không `authorization`, không `mongo/redis`, XSS), F3 (`eyJ`, email, tên dependency).
