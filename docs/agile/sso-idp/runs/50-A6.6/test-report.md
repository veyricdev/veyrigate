# Test Report — 2026-10-23 (run 50, A6.6 Dashboard + DEBT-352)

## Kết quả: PASS (fe-admin 1284/1284, E2E 34/34 + dashboard ×1 lại)

Diff chưa commit so với `e484913`. Tester thêm 2 file test (không sửa code sản phẩm):
- `fe-admin/test/dashboard-ui-risk.test.tsx`: 22 test (risk matrix UI, DEBT-358).
- `fe-admin/test/health-fn-risk.test.ts`: 16 test (BFF `readiness` qua `adminCall` thật).

## Lệnh đã chạy + output thực tế

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `npx vitest run test/dashboard-ui-risk.test.tsx test/health-fn-risk.test.ts` | Lần đầu 21/22: case "session over" so `returnTo=%2F` nhưng `location` stub không có getter `pathname` ⇒ `returnTo=NaN` (lỗi fixture, không phải sản phẩm). Đổi sang `stringMatching(/^\/auth\/login\?returnTo=/)` như `client-secrets.test.tsx` ⇒ **38/38** |
| 2 | `pnpm -C fe-admin typecheck` | `tsc --noEmit` OK |
| 3 | `pnpm -C fe-admin lint` | `eslint .` OK |
| 4 | `pnpm -C fe-admin test` | **Test Files 51 passed (51), Tests 1284 passed (1284)** (1246 dev + 38 tester) |
| 5 | `pnpm -C fe-admin build` | OK |
| 6 | `pnpm -C fe-admin check:bundle` | `scanned 23 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| 7 | `pnpm -C fe-admin gen:api` | `openapi/admin.json → schema.d.ts`; `git diff` schema.d.ts/openapi: rỗng |
| 8 | root `pnpm lint` | OK |
| 9 | `pnpm -r run typecheck` | fe-sso-test, e2e, fe-admin, be: Done |
| 10 | root `pnpm test` (song song) ×4 | Đỏ cả 4 lần, ngoài diff: lần 1 `fe-admin users-ui.test.tsx` "semantic table…" (không thấy table); lần 2–4 `fe-admin check-bundle.test.ts` timeout 5000ms (mỗi lần một case khác). be 416/416 và fe-sso-test 269/269 xanh trong cả 4 lần. fe-admin mỗi lần 1283/1284 |
| 11 | root `pnpm test` khi TẠM bỏ 2 file test của tester (đã trả lại) | Vẫn đỏ: `fe-sso-test router-lab.test.tsx` "purpose:lab…" + 2 case `check-bundle` timeout ⇒ flaky có sẵn (DEBT-333/355), không do diff → **DEBT-360** |
| 12 | `pnpm -r --no-bail --workspace-concurrency=1 run --if-present test` | **EXIT 0**: be 32 suites / 416; fe-admin 51 files / 1284; fe-sso-test 31 files / 269 |
| 13 | `pnpm audit --audit-level high` | `2 vulnerabilities found — Severity: 2 low; 1 ignored: 1 high` (giống run trước) ⇒ OK |
| 14 | Kiểm cổng: `Get-NetTCPConnection` :3000/:4000/:5173 | trống; `E2E_REUSE` rỗng |
| 15 | `pnpm -C e2e e2e` | **34 passed (3.7m)**, gồm `fe-admin-dashboard.spec.ts` (3.2s). Log `server function failed … "Invalid client id"` ×4 thuộc `admin-api-risk.spec.ts` (case âm có chủ đích) |
| 16 | `pnpm -C e2e e2e tests/fe-admin-dashboard.spec.ts` | **1 passed** (5.7s) |
| 17 | grep output (#10–16): `eyJ`, email, `client_secret=`, `password=`, `Bearer …` | `eyJ` 0; email chỉ `admin@example.com`, `dev@example.com` (placeholder seed); 0 secret |

Sau E2E các cổng :3000/:4000/:5173 trống lại. Không compose up, không FLUSH/drop, không seed dev DB.

### Mutation (backup sha256, khôi phục byte-identical)
Chạy trên `dashboard-ui-risk` + `health-fn-risk` + `dashboard-ui` + `health-fn` (78 test). Sau mỗi mutation, file được copy lại từ backup. `sha256sum -c`: cả 4 file OK.
- hooks.ts `1ec3c5be…18a1`
- routes/index.tsx `6ae29d5b…ff08`
- dashboard/summary.ts `43e698c1…6901`
- server/admin-api/client.ts `c3c3f1ba…a092`

| Mutation | Kết quả |
|---|---|
| M1 bỏ `retry: false` của `useBackendHealth` | **2 RED** (DEBT-358 typed/thrown) |
| M2 "Check again" không `disabled` khi đang chạy | **1 RED** |
| M3 "Try again" refetch cả 3 query thay vì query lỗi | **5 RED** |
| M4 kiểm `isPending` trước `failed` (lỗi bị che bởi loading) | **1 RED** |
| M5 bỏ tie-break `eventId` | **1 RED** |
| M6 bỏ cắt 10 | **2 RED** |
| M7 `readiness` nhận 3xx có body ok là "up" | **5 RED** (301/302/303/307/308) |
| M8 forward cookie trình duyệt tới `/ready` | **1 RED** |
| M9 `readiness` nuốt lỗi session store rồi vẫn fetch | **1 RED**. Lần đầu mutate nhầm `call()` (chuỗi xuất hiện 2 lần) ⇒ 78 xanh, bỏ kết quả đó; chạy lại đúng `readiness` |

## Test FAIL (nếu có)
- Không có FAIL thuộc diff run 50.
- Root `pnpm test` song song đỏ 4/4 + 1/1 (khi bỏ file mới) do flaky tải có sẵn ⇒ DEBT-360 (gộp DEBT-333/355). Chạy tuần tự từng package: xanh.

## Coverage acceptance criteria
- [x] **Số client/resource/user từ API thật**
  - E2E `fe-admin-dashboard.spec.ts`: expected tính từ `GET /clients|/resources|/users?limit=100`.
  - `dashboard-ui` counts (100+next ⇒ "100+"/"More than 100", 7, 0, đúng 100 ⇒ "100", `{limit:100}`).
  - `dashboard-ui-risk` "99 ⇒ 99; 100+cursor ⇒ 100+".
- [x] **Thẻ keys chỉ super_admin**
  - E2E: kid active khớp `GET /keys`.
  - `dashboard-ui` gồm tenant_admin, case variant, prefix.
  - `dashboard-ui-risk`: tenant_admin đi `/` → `/keys` → `/clients` → `/` ⇒ 0 lần gọi `listSigningKeys`.
- [x] **Sự kiện bảo mật gần đây**
  - E2E: lock thật ⇒ dòng `ADMIN_USER_LOCKED` với userId, link `/audit?action=ADMIN_USER_LOCKED`.
  - `dashboard-ui`: 3 request `limit:10`, gộp và cắt, link.
  - `dashboard-ui-risk`: tie-break, 3×10 ⇒ 10 mới nhất.
- [x] **Health BE**
  - E2E "Identity provider: Up".
  - `dashboard-ui` up/down/unknown.
  - `health-fn` + `health-fn-risk`.
- [x] **DEBT-352**: `keys-ui*` cũ xanh; gate bằng mount (test tenant_admin ở trên).
- [x] **Mỗi khối lỗi độc lập**: `dashboard-ui-risk` "every block fails on its own" × 6 khối (clients/users/resources/keys/health/events). Mỗi lần đúng 1 `alert` (health ⇒ "Unknown"), các khối khác hiện dữ liệu.
- [x] **Không polling**
  - `dashboard-ui` "read once" (fake timer 10').
  - `dashboard-ui-risk` DEBT-358: health 1 lần sau 10 s với retry thật.
  - Refetch khi focus: DEBT-357 (đã ghi).

## Coverage security invariants / risk matrix
- [x] **Identity: ẩn danh ⇒ 0 fetch**
  - `health-fn` "no session ⇒ unauthenticated, 0 fetch, Set-Cookie clear forward".
  - `health-fn-risk`: session store lỗi ⇒ server fn throw (không bao giờ "up"), 0 fetch (M9).
- [x] **Credential: `/ready` không mang credential nào**
  - `health-fn`: không `authorization`, không `at-SECRET`.
  - `health-fn-risk`: cookie / authorization / x-forwarded-for của trình duyệt không tới `/ready`. Header gửi đi chỉ có `accept` (M8).
- [x] **Authorization: tenant_admin 0 call keys**, kể cả khi điều hướng (ở trên). BE 403 là lớp thứ hai (run 49).
- [x] **Input / Dependency: chỉ 200+`ok` là up, 503+`error` là down; còn lại unknown**
  - `health-fn` gồm 11 case.
  - `health-fn-risk`: 301/302/303/307/308 có body ok ⇒ unknown, không follow (`redirect: manual`, URL cố định, M7); 204; body `{status:"OK"}`; mảng; null; stream body vỡ giữa chừng; 503+`status:"ok"`.
  - Timeout 3 s ⇒ unknown (`health-fn`).
- [x] **Exposure**
  - Kết quả server fn đúng `{"ok":true,"data":"up"|"down"}` dù BE trả thêm `message`/`stack`/IP.
  - Log không chứa `mongo|redis|socket|evil|at-SECRET`.
  - UI: lỗi thrown (`redis://10.0.0.5…`, `mongodb://internal-host`) ⇒ chỉ hiện text cố định.
  - Không hiện IP/UA. URL `/` không có query. E2E không có `eyJ`, `mongo|redis`, email.
- [x] **State / concurrency**
  - "Check again" disabled khi pending; click thêm không gửi request; 1 request/click (M2).
  - Chưa có kết quả ⇒ "Checking…" và không có nút (không bao giờ "Up").
  - 5 lời gọi song song ⇒ đúng 5 request (không fan-out/retry).
- [x] **Events fail-closed**
  - 1/2/3 query lỗi ⇒ khối lỗi, không list, không "No recent". "Try again" chỉ hỏi lại các query lỗi: tổng 4/5/6 lần gọi, đúng tập action (M3).
  - Một query lỗi khi query khác còn pending ⇒ vẫn lỗi (M4).
- [x] **Output encoding**
  - action lạ `FUTURE_ACTION` và action HTML `<script>…` ⇒ hiện dạng text, không có phần tử `script`, không thực thi, không nhãn bảo mật.
  - href bắt đầu `/audit`, không chứa `<>"`.
  - `targetId` `<img onerror>` (`dashboard-ui`).
- [x] **Request chain**: health `unauthenticated` ⇒ `signInAgain` (`location.assign("/auth/login?returnTo=…")`).
- Không áp dụng: replay/single-use (không có mutation mới), cross-tenant (tenant lấy từ token ở BE; super_admin xuyên tenant thuộc DEBT-124/143).

## Debt
- **DEBT-358** đóng (test `dashboard-ui-risk` "DEBT-358", mutation M1 2 RED).
- **DEBT-360** mới (🟡 [TEST]): root `pnpm test` song song đỏ 5/5, ngoài diff.
