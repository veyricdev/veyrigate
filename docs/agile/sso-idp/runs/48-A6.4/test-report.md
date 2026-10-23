# Test Report — 2026-10-23 (run 48 — A6.4 Audit log + DEBT-339/340/341 + Task 0 BE reuse tenant)

## Kết quả: PASS (FE + BE)

- fe-admin: 43 files / 1120 passed. Gồm 50 test tester mới: `audit-fn-risk` 37, `audit-ui-risk` 11, `users-risk` +2.
- BE int: 45 suites / 1215 passed. Gồm 4 test tester mới trong `admin-users.int-spec.ts`.
- BE unit: 32 suites / 415 passed.
- E2E: 32/32 passed.
- 0 FAIL. Mutation 6/6 RED, mọi file đã khôi phục byte-identical theo sha256.

Phạm vi: diff chưa commit so với `2e171cc`. Không sửa code sản phẩm. Tester chỉ thêm/sửa các file test:
- `be/test/admin-users.int-spec.ts`: +148 dòng, describe "QA run 48".
- `fe-admin/test/audit-fn-risk.test.ts`: file mới.
- `fe-admin/test/audit-ui-risk.test.tsx`: file mới.
- `fe-admin/test/users-risk.test.tsx`: +2 test DEBT-339.

## Lệnh đã chạy + output thực tế

Tất cả chạy foreground. Thư mục làm việc là `E:\projects\self\veyrigate`.

| # | Lệnh | Output thực tế |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` | exit 0 (`tsc --noEmit`, 0 lỗi) |
| 2 | `pnpm -C fe-admin lint` | exit 0 |
| 3 | `pnpm -C fe-admin test` | `Test Files 43 passed (43)`, `Tests 1120 passed (1120)` |
| 4 | `pnpm -C fe-admin build` | exit 0, `✓ built in 1.89s` (client) và `✓ built in 1.16s` (server) |
| 5 | `pnpm -C fe-admin check:bundle` | `scanned 21 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| 6 | `pnpm -C fe-admin gen:api` | exit 0. sha256 `schema.d.ts` trước và sau giống nhau (`OK`) ⇒ không có diff thêm ngoài phần Task 0 |
| 7 | `pnpm lint` (root) | Lần 1: exit 1, 2 lỗi prettier trong test tester mới (`admin-users.int-spec.ts` L1548/L1596). Đã `prettier --write` file test đó. Lần 2: exit 0 |
| 8 | `pnpm -r run typecheck` | exit 0 |
| 9 | `pnpm test` (root) | fe-sso-test 31 files / 269 passed; fe-admin 43 / 1120 passed; be 32 suites / 415 passed |
| 10 | `pnpm audit --audit-level high` | exit 0: `2 vulnerabilities found, Severity: 2 low, 1 ignored: 1 high` (giống các run trước) |
| 11 | `pnpm -C be test:int` (preflight tự lấy `vg:int-lock`) | `Test Suites: 45 passed, 45 total`, `Tests: 1215 passed, 1215 total` (trước run: 1211, +4 tester) |
| 12 | `jest … --testRegex admin-users\.int-spec\.ts$ --verbose` | 45 passed. 4 test "QA run 48" √ (386/344/368/389 ms) |
| 13 | `pnpm -C e2e e2e` | `32 passed (3.6m)`. Trước khi chạy đã kiểm :4000/:5173/:3000 đều trống (netstat LISTENING), không đụng `pnpm dev` |

**Grep log** (e2e.log, be-int.log, fe-test.log, root-test.log):
- JWT `eyJ…{20,}`: 0.
- `client_secret|password|refresh_token|access_token=<giá trị>`: 0.
- `argon2id$`: 0.
- Email chỉ có trong dòng seed cố định đã có từ trước (`seed-dev: upserted user … <dev@example.com>`, `seed: ensured super_admin … <admin@example.com>`, fixture `drill-admin-…@fixture.test`). Không có email nào từ audit/URL/query.
- 4 dòng `[fe-admin] server function failed` trong E2E là zod reject của test âm clients đã có từ trước (`Invalid client id`, `Unrecognized key: "tenantId"` …). Không liên quan run 48, không lộ dữ liệu.

## Mutation (tester), backup sha256 rồi khôi phục byte-identical

| # | Mutation | Kết quả |
|---|---|---|
| M1 | `token.controller.ts`: `tenantId: body.get("tenantId") ?? client.tenantId` | 1 RED (case 1: tenant hint bị bỏ qua). Khôi phục sha `5facadd4…` khớp |
| M2 | `refresh-token.service.ts` `revokeFamily`: `tenantId: undefined` | 2 RED (case 1, case 3: concurrent). Khôi phục sha `d0d28cd9…` khớp |
| M3 | `refresh-token.service.ts`: nuốt lỗi audit reuse (`.catch(() => undefined)`) | 1 RED (case 4: fail-closed). Khôi phục sha khớp |
| M4 | `schemas.ts`: bỏ `hash` khỏi denylist | 1 RED (`sha256Hash`). Khôi phục, `sha256sum -c` OK |
| M5 | `user-grants.tsx`: chỉ coi `AdminRequestError && uncertain` là không chắc (bỏ nhánh throw) | 1 RED (test throw DEBT-339). Khôi phục, OK |
| M6 | `routes/audit/index.tsx`: link user cho mọi `actorType !== "client"` | 2 RED (`robot`, `system` actor). Khôi phục, OK |

## Test FAIL (nếu có)

Không có. Hai lần đỏ trong lúc viết test là lỗi giả định của tester, không phải bug sản phẩm. Đã chỉnh test:
- Top-level field sai kiểu: server fn **throw** `response schema mismatch` (generic 500, theo thiết kế "GET off contract là bug"), không trả `{ok:false}`. Test giờ assert throw và message/stack không chứa giá trị.
- Lỗi xác định khi revoke family: dialog modal làm phần còn lại `aria-hidden`, nên không lấy được region theo role. Test chuyển sang assert text toàn trang.

## Coverage acceptance criteria

- [x] **Lọc action/user/client/thời gian**:
  - `audit-ui` filters (form → search → fn), `audit-fn` (query encode đúng thứ tự);
  - E2E `fe-admin-audit.spec.ts` (action + targetId + from, ≥1 hàng, link user, Details `count`).
- [x] **Phân trang server**:
  - `audit-ui` "Next keeps the filters…";
  - `invalid_request` + cursor ⇒ "First page";
  - tester: cursor giả hợp charset ⇒ BE 400 ⇒ chỉ 1 param được encode (`audit-fn-risk`).
- [x] **Làm nổi `TOKEN_REUSE_DETECTED`**:
  - `audit-ui` (nhãn chữ reuse/emergency, "Failure");
  - tester: nhãn là `<strong>` chữ trong hàng, link duy nhất là `/clients/app-1`;
  - BE: admin tenant sở hữu thấy đúng 1 event, tenant khác 0 (int dev + tester).
- [x] **Chi tiết metadata đã redact**:
  - `audit-fn` strip;
  - tester: 14 biến thể key secret, `__proto__`/`constructor`, object/array/deep bị bỏ; 19 key BE đang dùng giữ nguyên (không lọc thừa).
- [x] **Không hiển thị dữ liệu nhạy cảm**:
  - top-level `tenantId/_id/__v/passwordHash/sessionId` bị strip;
  - IP/UA chỉ có trong Details và không vào URL hay request khi mở;
  - E2E: URL/text không có email và không có `eyJ`.
- [x] **DEBT-339**:
  - dev: uncertain applied/active;
  - tester: lỗi throw ⇒ đóng dialog + status, 1 lần gửi dù click 3 lần, không lộ message lỗi; lỗi xác định ⇒ dialog giữ, hiện message, không hiện uncertain.
- [x] **DEBT-340**: E2E `fe-admin-users` pass trong suite 32/32.
- [x] **DEBT-341**: test cũ xanh (1120).
- [x] **Export CSV**: hoãn theo Q-48.3 (DEBT-342), không kiểm.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Identity / Authorization | admin tenant A (owner) thấy 1; admin tenant B (cross-tenant) thấy 0 | int dev `run 48 (DEBT-140 part)` + tester case 1/2/3 |
| Input (tenant injection) | `tenantId`/`tenant` ở query, `tenantId`/`tenant_id` ở body, header `x-tenant-id`/`x-tenant`/`tenant` khi refresh **và** replay ⇒ event Mongo `tenantId = TENANT_A`, B thấy 0 | tester case 1 (M1 RED) |
| Authorization (cross-client) | client tenant B replay value đã rotate của A ⇒ `invalid_grant`, 0 event reuse, family của A còn dùng được | tester case 2 |
| State / concurrency | 4 replay đồng thời ⇒ tất cả 400 `invalid_grant`, mọi event `tenantId=A`, số event admin A thấy = số trong Mongo, B 0, family revoked hết | tester case 3 (M2 RED) |
| Dependency (fail-closed) | ghi audit reuse lỗi ⇒ ≥500 `no-store`, body không có token/thông điệp lỗi, family vẫn revoked, successor 400, 0 event | tester case 4 (M3 RED) |
| Reuse/family revoke không đổi | family revoked hết sau reuse (case 1/3); test dev `refresh-token` reuse + `TOKEN_REFRESHED` không tenant; drill §2 | int 1215 xanh |
| Input FE (validator) | own `__proto__`/`constructor`, `tenant_id`, limit chuỗi/101/1.5, id số/mảng, cursor 513 ký tự hoặc có `=`, `a%40b.c`, newline, `＠` (U+FF20), time thiếu offset, action chữ thường, `null` ⇒ reject, 0 BE call | `audit-fn-risk` (16 case) + `audit-fn` (16 case dev) |
| Input FE (URL) | `__proto__`/`constructor`/`tenantId`/`tenant_id` trong search ⇒ fn chỉ nhận `{limit, action}`, không ô nhiễm prototype; Filter dựng lại search sạch | `audit-ui-risk` |
| Input FE (form) | `a%40b.c`, `＠`, `<script>`, `javascript:` ⇒ lỗi field, không navigate, không request; email ở 1 ô chặn cả lần submit; URL tự dựng với email ở cả 3 ô ⇒ bị bỏ khỏi request/form/DOM | `audit-ui-risk` + `audit-ui` (dev) |
| Exposure (metadata) | key secret biến thể (`access_token`, `ID-TOKEN`, `X-Api-Secret`, `Set-Cookie`, `sha256Hash`…), object/array/deep bị bỏ; HTML/`javascript:` giữ dạng chuỗi rồi render text | `audit-fn-risk`, `audit-ui` XSS (dev) |
| Exposure (render) | action/actorType lạ render text, không nhãn, Details vẫn chạy; actor `system`/`robot` có id 24-hex không thành link; target `client` không link (DEBT-345) | `audit-ui-risk` (M6 RED) |
| Exposure (URL) | mở Details không đổi URL, không có request mới, IP/UA/requestId không vào URL | `audit-ui-risk` |
| Exposure (BFF→BE) | request BE chỉ có bearer, không cookie, không body | `audit-fn-risk` |
| Request chain | E2E lock/unlock ⇒ `/audit` lọc ⇒ link/Details; `finally` lấy token mới rồi unlock (DEBT-340) | E2E 32/32 |

## DEBT

- **DEBT-346** (🟡, giữ nguyên): xác nhận tự nhiên. Mọi hàng có nút tên đúng "Details". Test tester phải dùng `within(row)` để phân biệt, đúng như người dùng screen reader cũng không phân biệt được. Không nghiêm trọng hơn mô tả của senior.
- **DEBT-348** (💭, mới): trong Details, metadata dùng chung namespace nhãn với các trường cố định, và React `key={k}`. Metadata `{IP: …}` hiện 2 dòng "IP". IP thật không bị thay hay ẩn (test `audit-ui-risk` "fixed label"), nhưng dễ gây nhầm. BE hiện chưa ghi key như vậy.
- Không có PENDING.
