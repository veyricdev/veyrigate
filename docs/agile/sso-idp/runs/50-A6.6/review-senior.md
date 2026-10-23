# Senior Review — 2026-10-23
## Kết luận: PASS

Diff chưa commit so với `e484913` (bỏ `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`). Verify độc lập: `tsc --noEmit` OK; `vitest run` 49 file / 1246 test xanh. E2E không chạy lại (theo yêu cầu), chỉ đọc spec.

## Tổng quan (ấn tượng chung + điểm tốt)
- Bám sát fold tech-lead: không endpoint BE mới, một trang `limit: 100` cho mỗi list, `100+` khi còn trang, health qua BFF chỉ trả enum, sự kiện 3 action fail-closed.
- `readiness(ctx)` gọn và đúng thứ tự: kiểm session trước, rồi mới fetch. Có forward `setCookie`. Không bearer, không retry, timeout 3 s. Dùng `redirect: "manual"` qua `fetchWithTimeout`. Kiểm `status` HTTP và body cùng lúc. Log chỉ có route, không trả `mongo`/`redis` ra ngoài.
- `health-fn.test.ts` đi qua `adminCall` thật. Test bao phủ 11 trường hợp "unknown", có 302 trỏ host lạ, và các kiểm âm `authorization`/`at-SECRET`/`mongo|redis` trong output lẫn log.
- Cô lập lỗi tốt: mỗi khối là một component có query riêng. `errorText` không bao giờ hiện lỗi thô (có test `mongodb://internal-host`).
- DEBT-352 đã đóng sạch: gate keys bằng điều kiện mount. Đã đọc test tenant_admin ⇒ 0 lần gọi `listSigningKeys`.

## 🔴 Blocker
- (không có)

## Security invariants / trust boundaries đã kiểm
- **Identity**: `getBackendHealth` → `adminCall` → `readiness`. `auth.accessToken` dùng chung `liveSession` (refresh single-flight).
  - Không có session ⇒ `AdminApiError("unauthenticated")` và 0 fetch. Có test kiểm cả `setCookie` xoá sid.
  - Redis/IdP down ⇒ `ServiceUnavailableError` bị throw ra boundary ⇒ client `isError` ⇒ hiện "Unknown". Fail closed, không bao giờ "Up".
- **Authorization**: số liệu theo tenant do BE lấy từ token; FE không gửi `tenantId`.
  - Thẻ keys chỉ mount khi `roles.includes("super_admin")`. Nếu bỏ mount thì BE vẫn trả 403.
  - Không có input id ⇒ không có IDOR.
- **SSRF / proxy**: URL cố định `${ADMIN_API_BASE_URL}/ready`, server fn không nhận input. Redirect manual ⇒ 3xx trả "unknown", không đi theo `location`.
  - Lạm dụng "Check again" / gọi thẳng server fn: chỉ admin đã đăng nhập mới gọi được. Mỗi lần gọi đúng 1 request `/ready`, không retry, không fan-out.
  - BE `/ready` vốn công khai, nên BFF không khuếch đại so với gọi trực tiếp. Nút bị `disabled` khi đang fetch, nên không dồn request song song từ UI.
  - Không cần rate-limit riêng ở mức này.
- **Exposure**: trình duyệt chỉ nhận `"up" | "down" | "unknown"`. Log không có body. Sự kiện không hiện IP/UA/metadata. URL `/` không có query (có test unit + E2E).
  - E2E kiểm âm `eyJ`, `mongo|redis`, email E2E.
- **Output encoding**: `targetId`/`action` render bằng text React, không có `dangerouslySetInnerHTML`. Test `<img onerror>` hiện dạng text.
  - Link dùng `<Link to="/audit" search={{ action }}>` (router encode). `action` lấy từ BE đã lọc `IsIn(AuditAction)`.
- **Failure semantics của khối sự kiện**: bất kỳ query nào `isError` ⇒ cả khối lỗi, không hiện danh sách thiếu, không hiện "No recent".
  - Kiểm `failed` trước `isPending`, nên khi một query lỗi còn query khác đang tải thì vẫn hiện lỗi (đúng hướng fail-closed).
  - "Try again" chỉ refetch query lỗi. Có test 3 action × khôi phục, `audit` được gọi 4 lần.
- **Merge/sort**: `flat → sort(timestamp desc, eventId desc) → slice(10)`. Mỗi event thuộc đúng một action nên không trùng key.
- **Không polling**: không có `refetchInterval`. Có test fake timer 10 phút ⇒ mỗi fn gọi đúng 1 lần.
  - DEBT-357 (refetch on focus, `staleTime: 0`) để mức 💭 là đúng: đây là mặc định toàn app, mỗi request đều qua guard của BE, không phải vòng lặp.

## 🟡 Nên sửa
- **DEBT-358 — Test "no retry" của health là vacuous**
  - `fe-admin/test/dashboard-ui.test.tsx:118`: `renderDashboard` đặt `queryClient.setQueryDefaults(["admin"], { retry: false })`. Key `["admin","health"]` cũng khớp prefix này.
  - Vì vậy test "server fn %s => Unknown, asked once (no retry)" (`:208`) không kiểm `retry: false` trong `useBackendHealth` (`hooks.ts`): bỏ dòng đó thì test vẫn xanh.
  - Vì sao: không có `retry: false`, lỗi thrown hoặc `unavailable` bị `isTransient` cho retry 2 lần. Mỗi lần BFF chờ tới 3 s ⇒ khoảng 9 s "Checking…" và 3 lần ping `/ready`. Đây đúng là hành vi fold cấm, nhưng không có lưới chặn.
  - Đề xuất: cho health một test riêng với `createQueryClient()` không override retry (hoặc chỉ override các key khác), kiểm `health` được gọi đúng 1 lần sau lỗi thrown. Thêm mutation bỏ `retry: false` ⇒ phải RED.
- **DEBT-359 (ponytail)** — xem mục ✂️: `CountCard` suy lại điều kiện `countText`; `SecurityEvents` chép tay options của `useAuditEvents`.

## 💭 Nit
- **"Check again" nằm ngoài fold, chấp nhận được.** Nó là lối duy nhất để đọc lại health khi `retry: false` (ngoài reload). Nút `disabled` khi `isFetching`, có test "asks once more".
  - Có thể thêm một assert rằng nút bị disabled khi đang chờ, nhưng không bắt buộc.
- **`summary.ts` `mergeRecent`: có thể dùng so sánh chuỗi thường.** `b.timestamp.localeCompare(a.timestamp)` chạy đúng với ISO UTC cùng định dạng. Với chuỗi ISO, `a < b` / `a > b` (so sánh code unit) rõ ý hơn và không phụ thuộc collation; với dữ liệu hiện tại thì không sai.
- **`IdleQueries` không che lỗi thật.**
  - Nó chỉ dùng trong 3 file test shell (layout/guard/ui-extra). Các file này trước đây render `/` placeholder không có `QueryClientProvider`, và đây vẫn là provider duy nhất (`getRouter` không được dùng trong test).
  - Dashboard có test riêng với query client thật. JSDoc đã nói rõ mục đích.
- **E2E đã ổn định ở mức cần thiết**:
  - expected lấy từ API ngay trước khi đọc trang (suite `workers: 1`);
  - row được lọc theo cả `ADMIN_USER_LOCKED` lẫn `userId`;
  - `finally` có unlock bằng token mới.
  - Nếu tenant E2E có hơn 10 sự kiện bảo mật mới hơn lần lock vừa làm thì row sẽ bị cắt. Điều này không xảy ra với suite tuần tự hiện tại.

## ✂️ Ponytail
- fe-admin/src/routes/index.tsx:L92: shrink: `text === String(query.data.items.length)` suy ngược lại điều kiện của `countText`. Thay bằng `query.data.nextCursor === null`.
- fe-admin/src/routes/index.tsx:L193-L200: shrink: `useQueries` chép tay `queryKey`/`queryFn` của `useAuditEvents`. Thay bằng `auditListQuery(params)` (`queryOptions`) dùng chung cho cả hai.
- fe-admin/src/features/dashboard/summary.ts:L24: shrink: `localeCompare`. Thay bằng `(a, b) => (a.timestamp < b.timestamp ? 1 : ...)` hoặc giữ nguyên (nit).

net: -4 lines possible.
