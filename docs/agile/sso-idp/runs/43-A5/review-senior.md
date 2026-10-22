# Senior Review — 2026-10-22 (run 43, A5 API layer fe-admin)

## Kết luận: PASS

Không có 🔴. Có 3 🟡, ghi vào backlog thành DEBT-296…298.

Đã tự chạy `pnpm -C fe-admin typecheck`, `lint`, `test`, `build`, `check:bundle` và `gen:api`:
- Tất cả đều xanh: 18 file test, 315 test.
- `check:bundle` 0 hit.
- Không chạy E2E (đúng quy tắc).

## Tổng quan

**Thiết kế chặt và bám fold.**
- Không có proxy chung. Có 3 server fn, mỗi fn gọi đúng một endpoint với method cố định.
- `clientId` được kiểm bằng zod rồi mới `encodeURIComponent`.
- Patch được validate bằng `.strict()`.
- Response được parse bằng zod theo allowlist.
- Bảng ánh xạ lỗi được triển khai đúng từng dòng, kể cả 3xx (`redirect: manual`) ⇒ `unavailable`.

**Lệch fold (trả lỗi bằng union value) là hợp lý.**
- `ShallowErrorPlugin` chỉ giữ `message`, nên nếu throw thì `code` và `uncertain` sẽ mất.
- Union `{ok:false,error:{code,message,uncertain?}}` còn hẹp hơn throw. `toFailure()` tự liệt kê từng field, nên không lộ thêm gì.
- `AdminApiError` không bao giờ ra khỏi `adminCall`. Mọi lỗi khác vẫn đi qua `serverFnErrorBoundary` và thành 500/503 chung.

**Test có giá trị thật.**
- Hai 401 song song có gate ở token endpoint, khẳng định đúng 1 refresh grant.
- Canary AT không xuất hiện trong lỗi đã serialise hay trong log.
- Cờ ALS độc lập theo từng request.
- Step-up được kiểm cho các trường hợp hết hạn, khác action, khác `sub` và JSON hỏng.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

### AT không rời `src/server`
- `accessToken()` chỉ được `client.ts` dùng.
- `AdminApiFailure` chỉ gồm 3 field:
  - `code`;
  - `message`: câu cố định, hoặc `error_description` (≤ 200 ký tự) với 400/409;
  - `uncertain`.
- Log chỉ ghi method, route template và status.
- `check:bundle` 0 hit.
- Build xanh khi `instance.ts`, `client.ts` và `schemas.ts` đều có `server-only`.

### Không thành proxy hay SSRF
- `base` lấy từ env.
- `path` chỉ được ghép từ hằng số, id đã encode và `URLSearchParams`.
- Không nhận URL, method hay header từ client.
- `ClientIdSchema` chặn `/`, `\`, `.` và `..`. Riêng `encodeURIComponent` đã đủ an toàn.

### CSRF
- `createCsrfMiddleware` lọc `handlerType === "serverFn"`, nên áp cho mọi server fn, kể cả `updateClient` (POST).
- `listClients` và `getClient` là GET chỉ đọc. Trang cross-site không đọc được response vì không có CORS.

### 401: refresh một lần
- Chỉ gửi lại 1 lần. Nếu lần hai vẫn 401 thì gọi `dropSession`: destroy phiên, revoke RT, xoá cookie. Không có vòng lặp.
- 403 `step_up_required` không kích hoạt refresh.
- Hai 401 song song chỉ tạo đúng 1 refresh (có test).
- Refresh khi IdP down trả 503 và giữ nguyên phiên.
- Còn một khe race hẹp, xem 🟡 DEBT-296.

### Intent step-up
- Lưu trong `sessionStorage` của tab, gắn với `v`, `action`, `path`, `sub` và `exp`.
- TTL 10 phút. Intent có `exp` xa hơn hiện tại quá TTL cũng bị loại.
- Đọc một lần là xoá, kể cả khi bị loại.
- Payload được zod parse cả khi lưu (allowlist) lẫn khi khôi phục.
- Không tự gửi lại. Đăng xuất thì xoá intent.
- `returnTo` được lọc phía server bằng `sanitizeReturnTo` của run 42.

### DEBT-282: AsyncLocalStorage
- Mỗi request chạy trong một `run` riêng với một state object mới, nên cờ không thể rò sang request khác.
- Chỉ đổi 500 thành 503. Body stream được chuyển tiếp nguyên, không đọc, thêm `no-store`.
- 404 và 200 giữ nguyên.

### DEBT-289
- Lỗi network, timeout và 5xx đổi thành `ServiceUnavailableError`.
- Issuer mismatch, 404 và sai schema vẫn là 500 (fail-closed).
- Logout khi discovery chết vẫn xoá `fea_sid`.

### `azp`
- Nếu `azp` có mặt thì phải bằng `clientId`, kể cả khi `aud` đơn. Có test âm.

### Snapshot OpenAPI
- CI chạy `gen:api && git diff --exit-code` để giữ types khớp snapshot.
- E2E so deep-equal BE thật với snapshot.
- Hai lớp bổ sung cho nhau. Khi lệch, lỗi in sẵn lệnh cập nhật.

### Override dependency
- `openapi-typescript>@redocly/openapi-core: 1.34.20` có phạm vi hẹp và chỉ chạm devDependency.
- Lockfile đã resolve 1.34.20, nhất quán với quy tắc ≥ 14 ngày (DEBT-295).

## 🟡 Nên sửa

### 🟡 [FE] Khe race trong single-flight refresh ép buộc (DEBT-296)

`fe-admin/src/server/auth/bff.ts:260-271` (`refresh`).

**Chuỗi sự kiện:**
1. Caller ép buộc chờ `running`.
2. `running` là refresh thường, thấy `atExp` còn xa nên không refresh, và trả về đúng token cũ.
3. Caller lookup `inflight` lần hai. Nếu ngay microtask đó một request khác vừa đăng ký một refresh **thường**, caller nhận promise ấy.
4. Promise đó lại trả token cũ, nên lần gửi lại vẫn 401.
5. `dropSession` chạy: admin bị đăng xuất và RT bị revoke oan.

**Vì sao đáng sửa:** xác suất thấp, và đây là fail-closed chứ không phải bypass. Nhưng đây chính là mutant còn sống mà dev đã ghi trong log.

**Đề xuất:** dùng một vòng lặp, rồi mới tự đăng ký `doRefresh(key, stale)`:

```ts
while ((p = inflight.get(key))) {
  const s = await p;
  if (s?.tokens.accessToken !== stale) return s;
}
```

Cách này gọn hơn hai lần lookup hiện tại.

### 🟡 [FE] Mutation 2xx lỗi parse không được đánh dấu `uncertain` (DEBT-297)

`fe-admin/src/server/admin-api/client.ts:114-118`.

**Hiện trạng:**
- Mutation 2xx với body không phải JSON gọi `unavailable(op, …, false)`, tức `uncertain=false` cố định.
- Mutation 2xx sai schema thì ném `Error` (500 chung).

**Vì sao:**
- Với PATCH, 2xx nghĩa là BE **đã áp dụng** thay đổi.
- UI lại nhận `unavailable` hoặc 500 mà không có `uncertain`, nên `useUpdateClient` không invalidate.
- Người dùng thấy dữ liệu cũ và có thể gửi lại.
- PATCH là idempotent nên ở A5 không gây hại. A6 sẽ thêm create và rotate, hai thao tác này không idempotent.

**Đề xuất (chọn một):**
- Dùng `op.method !== "GET"` làm `uncertain` ở nhánh 2xx không phải JSON.
- Hoặc phía client invalidate cả khi mutation gặp lỗi không phải `AdminRequestError`.

### 🟡 [FE] Server fn GET thiếu `cache-control: no-store` (DEBT-298)

`fe-admin/src/features/admin-api/clients.ts:10-16`.

**Vì sao:**
- `listClients` và `getClient` là server fn GET trả dữ liệu tenant.
- Response không có `no-store`. Cache trung gian, hoặc cache trình duyệt trên máy dùng chung sau khi đăng xuất, có thể giữ danh sách client của tenant.

**Đề xuất (chọn một):**
- Đặt `no-store` cho mọi response serverFn trong middleware (`setResponseHeader`).
- Hoặc gộp vào đợt header hardening ở A7 (DEBT-266/269).

## 💭 Nit

- **`step-up.ts` `takeIntent` xoá intent ngay khi đọc.**
  - Ở dev, `React.StrictMode` mount hai lần, nên lần mount thứ hai mất bản nháp.
  - A6.1 nên gọi trong initializer của `useState` hoặc có ref guard. Prod không bị ảnh hưởng.
- **`query-client.ts` `signInAgain` chưa có cơ chế cắt vòng lặp.**
  - Tình huống: BE luôn trả 401 với một AT mà `/admin/me` vẫn chấp nhận (ví dụ cấu hình `aud` lệch giữa các route).
  - Khi đó vòng login (SSO im lặng) ⇒ quay lại trang ⇒ `unauthenticated` lặp mãi.
  - Guard run 42 có cùng mẫu này. Đáng thêm một cờ "vừa login" trong `sessionStorage` ở A6/A7.
- **`unavailable.ts` có thể gán nhầm 503.**
  - Tình huống: trong cùng request, một lỗi phụ thuộc đã được map 503 rồi nuốt, sau đó gặp một 500 thật không liên quan.
  - Request khi đó trả 503 thay vì 500. Chấp nhận được, chỉ cần biết.

## ✂️ Ponytail

- fe-admin/src/server/admin-api/client.ts:L17: delete: bảng `STATUS` và base `PublicError` của `AdminApiError`. Lỗi này không bao giờ ra khỏi `adminCall` nên không ai đọc `status`. Thay bằng `extends Error`.
- fe-admin/src/server/auth/bff.ts:L260: shrink: hai lần lookup `inflight`. Thay bằng một vòng `while` (xem DEBT-296): ngắn hơn và đúng hơn.
- fe-admin/src/features/admin-api/hooks.ts:L7: yagni: `useClients` và `useClient` chưa có UI nào dùng. Giữ được vì A6 dùng ngay, nhưng đừng thêm hook nào nữa trước khi có màn hình.

net: -12 lines possible.

→ PASS, chuyển **tester**.
