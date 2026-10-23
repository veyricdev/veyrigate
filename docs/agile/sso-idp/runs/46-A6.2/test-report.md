# Test Report — 2026-10-23 — run 46 (A6.2 Resources UI + DEBT-318/319 + Task 0 BE OpenAPI)

## Lượt 2 (sau frontend-dev retry 1 + senior vòng 2 PASS)

### Kết quả: PASS (fe-admin 901/901, 36 file)

- **Case 9** (resources): đã đóng thật. Test trước đây là `it.fails`, nay là `it` và xanh. Repo không còn `it.fails` nào (`grep -rn "it.fails" fe-admin/test` rỗng).
- **DEBT-330** (clients): đã đóng thật. 3 test "uncertain update then revert" xanh, so body bằng `toEqual`.
- **Test rủi ro mới**: 12 test (7 resources, 5 clients). Tất cả xanh, chạy riêng 3 lần liên tiếp đều 49/49.
- **Mutation**: 4 mutant, mỗi mutant chỉ bị test mới bắt (test cũ đều xanh).
- **DEBT-332**:
  - nửa "refetch lỗi": tái hiện được, giữ 🟡, không đảo ngược ý định;
  - nửa "đang refetch": không xảy ra với lần đọc lại ngay sau save.
- **Debt mới**: DEBT-333 💭, flaky do tải khi chạy root `pnpm test`, nằm ngoài diff.

### Lệnh đã chạy + output thực tế (lượt 2)

Cổng :4000/:5173/:3000 được kiểm bằng `netstat -ano | grep LISTENING`: trống trước E2E và trống lại sau E2E.

| # | Lệnh | Output |
|---|---|---|
| L2-1 | `pnpm -C fe-admin test` (baseline, trước khi thêm test) | `Test Files 36 passed (36)`, `Tests 889 passed (889)` |
| L2-2 | `pnpm -C fe-admin typecheck` / `lint` | exit 0 / exit 0 |
| L2-3 | `pnpm -C fe-admin test` (sau khi thêm test) | `Test Files 36 passed (36)`, `Tests 901 passed (901)`, exit 0 |
| L2-4 | `pnpm -C fe-admin build` / `check:bundle` | `✓ built`, exit 0 / `scanned 15 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| L2-5 | `pnpm -C fe-admin gen:api`, sau đó `sha256sum -c` | `schema.d.ts: OK`, `admin.json: OK` (không diff) |
| L2-6 | root `pnpm lint` | exit 0 (be, fe-admin, fe-sso-test) |
| L2-7 | root `pnpm -r run typecheck` | exit 0 (be, e2e, fe-admin, fe-sso-test) |
| L2-8 | `pnpm audit --audit-level high` | exit 0: `2 vulnerabilities found, Severity: 2 low, 1 ignored: 1 high` (bản ignore có sẵn) |
| L2-9 | root `pnpm test`, 4 lần | Chi tiết ngay dưới bảng |
| L2-10 | `vitest run test/check-bundle.test.ts --reporter=verbose` (riêng, 3 lần) | `Tests 14 passed (14)` ×3, mỗi test khoảng 115–135ms |
| L2-11 | `pnpm -C e2e e2e` | `30 passed (3.7m)`; `ok 8 … fe-admin-resources.spec.ts … (3.7s)`; `ok 7 … fe-admin-clients.spec.ts … (1.2m)`; exit 0 |
| L2-12 | Grep secret: JWT `eyJ…`, `-----BEGIN`, `"password"`, `"secret"`, `"access_token"`, `"refresh_token"`, `"client_secret"` có giá trị, `client_secret=…` | log E2E: 0; 4 log root test: 0; log fe-admin test: 0 |
| L2-13 | 2 file risk chạy riêng 3 lần | `Tests 49 passed (49)` ×3 |
| L2-14 | Mutation (sao lưu sha256, khôi phục, `sha256sum -c` ⇒ `OK` cả 2 file) | Chi tiết ở mục "Mutation" bên dưới |

**Lệnh L2-9, root `pnpm test` 4 lần:**

| Lần | be | fe-sso-test | fe-admin |
|---|---|---|---|
| 1 | 405/405 | 269/269 | **1 đỏ**: `check-bundle.test.ts` "refuses to pass when dist/client is empty", `Test timed out in 5000ms` |
| 2 | 405/405 | 269/269 | **3 đỏ** `check-bundle` (timeout) và `bff.test.ts` 76 skipped: `vg-test-redis is not reachable`, `[ioredis] Command timed out` |
| 3 | 405/405 | 269/269 | **4 đỏ** `check-bundle` (timeout 5.0–5.6s) |
| 4 | 405/405 | 269/269 | **901/901**, exit 0 |

- Hai file đỏ không nằm trong diff run 46: `git diff HEAD` của `test/check-bundle.test.ts` và `scripts/` rỗng.
- Khi chạy riêng, các file này đều xanh. Lỗi là timeout do tải khi 3 package chạy song song ⇒ ghi DEBT-333.
- `vg-test-redis` vẫn `Up 3 hours` (`docker ps`).

**Mutation (L2-14)** — mỗi mutant bị đúng 1 test đỏ trên 122 test (4 file resources-ui*, clients-ui*):

| Mutant | Test đỏ |
|---|---|
| M1 resources: `setUnsure(!(err instanceof AdminRequestError) or err.uncertain)` (lỗi 4xx xoá `unsure`) | "uncertain, then a 4xx … still sent" |
| M2 resources: bỏ vế `!(err instanceof AdminRequestError)` (lỗi ném không bật `unsure`) | "a thrown error … sent" |
| M3 clients: lỗi không uncertain thì `unknown.current.clear()` | "uncertain, then a 4xx … unknown field is still sent" |
| M4 clients: bỏ nhánh lỗi ném | "a thrown error (network / BFF), then revert: sent" |

Sha256 trước và sau mutation khớp:

- `$resourceId.tsx` `45a3e41e…`
- `$clientId.tsx` `27de1748…`

### Test mới (lượt 2)

**`fe-admin/test/resources-ui-risk.test.tsx`** › "uncertain update: failure sequences (case 9, round 2)" — 7 test:

1. Uncertain 2 lần liên tiếp, rồi hoàn tác về giá trị lúc mount ⇒ PATCH được gửi mỗi lần, body `toEqual {scopes:["read","write"]}`.
2. Uncertain ⇒ 4xx `invalid_request` ⇒ lưu lại cùng giá trị bằng base ⇒ vẫn gửi; "Currently saved" còn hiện trong lúc 4xx và mất sau khi lưu OK.
3. Lỗi ném (`mockRejectedValueOnce`) ⇒ hoàn tác ⇒ gửi.
4. Uncertain nhưng KHÔNG ghi:
   - đọc lại vẫn `read write`; draft `admin  write` giữ nguyên;
   - gửi lại đúng `{scopes:["admin","write"]}`;
   - sau khi lưu OK, "No changes to save." hoạt động lại và không gửi thêm.
5. Refetch do window focus trong lúc `unsure` ⇒ draft `mine` không bị ghi đè; "Currently saved: other" hiện giá trị đọc lại.
6. **DEBT-332, re-read đang chạy** (đọc lại treo):
   - chưa có kết quả, alert rỗng, không có "Currently saved";
   - khi đọc lại xong ⇒ "Currently saved: admin".
   - Nguyên nhân: `useInvalidateOn` trả promise `invalidateQueries` từ `onSettled`, nên `mutateAsync` chờ đọc lại xong.
7. **DEBT-332, re-read lỗi** (tái hiện):
   - nút "Try again" hiện, kèm "Currently saved: read write", tức cache trước khi lưu, trong khi server có thể là `admin`;
   - lần lưu kế vẫn gửi `{scopes:["read","write"]}` ⇒ không đảo ngược ý định, giữ 🟡.

**`fe-admin/test/clients-ui-risk.test.tsx`** › "state: uncertain update, failure sequences (DEBT-330, round 2)" — 5 test, body so bằng `toEqual` chặt:

1. Field unknown cộng field mới đổi được gửi cùng nhau, đúng `{redirectUris:[mount], scopes:["openid","email"]}`:
   - không có field bất biến, không có field không đổi;
   - CORS do người khác sửa trên server không bị gửi;
   - refetch không ghi đè draft (Redirect URIs giữ giá trị admin gõ, CORS vẫn rỗng dù server có `other.example`).
2. Uncertain 2 lần cộng dồn `unknown` (`redirectUris`, rồi `scopes`) ⇒ hoàn tác cả hai ⇒ gửi cả hai ⇒ sau khi lưu OK, "No changes to save." hoạt động lại và không gửi thêm.
3. Uncertain ⇒ 4xx ⇒ lưu lại giá trị bằng base ⇒ vẫn gửi `{redirectUris:[mount]}`.
4. Lỗi ném khi tick resource `admin` ⇒ bỏ tick ⇒ gửi `{allowedResources:[]}`.
5. Uncertain nhưng không ghi ⇒ bấm lưu lại không đổi gì ⇒ argument của lần gọi 2 `toEqual` lần gọi 1.

### Coverage (lượt 2)

- [x] **Task 3, uncertain update không đảo ngược ý định**: đạt. Bằng chứng:
  - case 9 (`it`);
  - 7 test resources mới;
  - 3 test clients của dev cộng 5 test clients mới.
- [x] **INV không đảo ngược ý định**: đạt cho mọi chuỗi đã kiểm:
  - uncertain×2;
  - uncertain → 4xx → lưu;
  - lỗi ném;
  - uncertain không ghi;
  - refetch lúc `unsure`;
  - refetch lỗi.
- [x] **INV PATCH clients chỉ gồm field unknown và field đã đổi**: đạt (`toEqual`, test 1–3 clients).
- [x] **INV refetch không ghi đè draft**: đạt (resources test 4, 5, 7; clients test 1).
- Các mục AC khác giữ nguyên kết quả lượt 1: toàn bộ suite và E2E chạy lại đều xanh.

### Ghi chú môi trường (lượt 2)

- Không sửa code sản phẩm, không cài package, không commit.
- Không `compose up`/FLUSH/drop.
- Không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`.
- Chỉ sửa 2 file test: `resources-ui-risk.test.tsx` và `clients-ui-risk.test.tsx`. Log lệnh nằm ở scratchpad.
- E2E tạo thêm resource `e2e-r<inv>` trong DB `sso-idp-e2e` (DEBT-322, đúng thiết kế).

---

## Lượt 1

## Kết quả: FAIL [FE] — 1 lỗi đảo ngược ý định (case 9)

- fe-admin: 36 file, **885 pass + 1 expected fail** (`it.fails` ghi lại lỗi FAIL bên dưới).
- be unit: 32 suites, 405/405. fe-sso-test: 269/269 (lần chạy song song đầu có 1 flaky, xem case 6).
- E2E: 30/30 hai lần liên tiếp. typecheck, lint, build, check:bundle, gen:api (không diff), audit: xanh.
- Mọi acceptance của Task 0 đến Task 4 đều đạt, **trừ** một invariant "không đảo ngược ý định" ở trang sửa resource sau `uncertain` (case 9). Bản thân DEBT-327 đã đúng; case 9 cho thấy nó có hậu quả cụ thể, nặng hơn thông điệp sai.

## Lệnh đã chạy + output thực tế

Cổng :4000/:5173/:3000 đã được kiểm (`netstat ... LISTENING`) là trống trước mỗi lần chạy E2E, và trống lại sau khi chạy.

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` | `tsc --noEmit`, exit 0 |
| 2 | `pnpm -C fe-admin lint` | `eslint .`, exit 0 (gồm 2 file test mới) |
| 3 | `pnpm -C fe-admin gen:api` + `sha256sum -c` | `schema.d.ts: OK`, `admin.json: OK` (không diff) |
| 4 | `pnpm -C fe-admin test` | `Test Files 36 passed (36)`, `Tests 885 passed \| 1 expected fail (886)`, exit 0 |
| 5 | `pnpm -C fe-admin build` / `check:bundle` | `✓ built`, exit 0 / `scanned 15 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| 6 | root `pnpm test` | be `Tests: 405 passed, 405 total`; fe-admin 885 + 1 expected fail; fe-sso-test `1 failed \| 268 passed` (`router-lab.test.tsx` "purpose:lab …" `expected '/callback' to be '/lab'`). Chạy lại riêng file đó 3 lần: `7 passed` ×3; cả package: `Tests 269 passed (269)`. Flaky dưới tải, nằm ngoài diff run 46 ⇒ DEBT-331 |
| 7 | root `pnpm lint` | exit 0 (be, fe-admin, fe-sso-test) |
| 8 | root `pnpm -r run typecheck` | exit 0 (be, e2e, fe-admin, fe-sso-test) |
| 9 | `pnpm audit --audit-level high` | exit 0: `2 vulnerabilities found, Severity: 2 low, 1 ignored: 1 high` (bản ignore có sẵn) |
| 10 | `pnpm -C e2e e2e` lần 1 | `30 passed (3.6m)`; `ok 8 … fe-admin-resources.spec.ts … (4.0s)` |
| 11 | `pnpm -C e2e e2e` lần 2 | `30 passed (3.3m)`; `ok 8 … fe-admin-resources.spec.ts … (3.9s)` |
| 12 | Grep secret trong log E2E (JWT `eyJ…`, `-----BEGIN`, `"password"/"secret"/"access_token"/"refresh_token": "<giá trị>"`, `client_secret=…`) | lần 1: 0 / 0; lần 2: 0. Các dòng `server function failed … Error: [ {"code":"custom","message":"Invalid client id"} ]` là test âm có sẵn của spec clients (input validator), không chứa body BE hay secret |
| 13 | Đo verdict BE thật cho bộ corpus (script tạm ở scratchpad, `ts-node` transpile-only: `validateSync(plainToInstance(CreateResourceDto/UpdateResourceDto), {whitelist, forbidNonWhitelisted})` + `validateResourceFormat`) | 44 identifier, 19 resourceId, 13 danh sách scopes. `extra: {patchWithIdentifier:false, patchWithResourceId:false, patchNoScopes:false}`. Kết quả được chép cứng vào `test/resource-form-parity.test.ts` |
| 14 | Mutation (sao lưu sha256, khôi phục, `sha256sum -c` ⇒ `OK` cho cả 2 file) | bỏ luật trim ⇒ **8 đỏ**; `/resources/new` coi mọi viewer là super_admin ⇒ **1 đỏ**; max scopes 50 → 51 ⇒ **2 đỏ** |
| 15 | Kiểm `it.fails` đỏ đúng lý do (tạm đổi thành `it`, khôi phục, sha256 khớp `f05bd883…`) | `AssertionError: expected 'No changes to save.' not to be 'No changes to save.'` |

## Test FAIL (nếu có)

- **Case 9.** `test/resources-ui-risk.test.tsx` › "after an uncertain update that landed, reverting to the original scopes is sent (not 'No changes')" (hiện là `it.fails`).
  - **Kỳ vọng**:
    1. scopes ban đầu `read write`;
    2. admin lưu `admin`, nhận `uncertain`, nhưng PATCH đã ghi thật (đọc lại thấy `["admin"]`);
    3. admin hoàn tác về `read write` rồi lưu ⇒ PATCH `{scopes:["read","write"]}` được gửi.
  - **Thực tế**: UI báo "No changes to save." và không gửi request. Server giữ `["admin"]`, còn UI khẳng định không có gì cần lưu. Đây là đảo ngược ý định, kèm xác nhận sai.
  - **Nguyên nhân nghi ngờ**:
    - `ResourceForm.baseRef` chỉ được dời khi có `saved`. Nhánh `uncertain` trong `routes/resources/$resourceId.tsx` (`EditScopesForm.onSubmit` → `failureMessage`) giữ mốc lúc mount;
    - `sameScopes(values, base)` so với mốc cũ.
    - Form đóng băng nên dữ liệu đọc lại không hiện ở đâu (DEBT-327, có test characterisation), và người dùng không thể tự phát hiện.
  - **Mức độ**: `Resource.scopes` hiện chỉ có giá trị tài liệu (DEBT-321), nên không có tác động bảo mật trực tiếp. Tuy vậy, lỗi rơi đúng tiêu chí "đảo ngược ý định", không thể chuyển thành debt để PASS.
  - **Hướng sửa (gợi ý, dev quyết định)**: sau `uncertain`, coi mốc là không biết, để lần lưu kế tiếp luôn gửi PATCH. PATCH thay nguyên mảng nên idempotent. Hoặc dời mốc theo dữ liệu đọc lại, kèm dòng "Currently saved: …" (gộp DEBT-327).
  - **Khi sửa xong**: đổi `it.fails` thành `it`.
  - **Liên quan**: cùng khuôn đã tồn tại ở `/clients/$clientId` (kết luận từ đọc code, chưa test). Field ở đó có ý nghĩa bảo mật (redirectUris, allowedResources), nên đã ghi DEBT-330 🟡 và đề nghị sửa cùng lúc.
- **Chuyển lại**: **frontend-dev**.

## Test mới của tester

| File | Số test | Nội dung |
|---|---|---|
| `fe-admin/test/resource-form-parity.test.ts` (node) | 74 | So bảng FE với verdict BE **đo thật** (lệnh 13). Invariant: form không bao giờ nhận giá trị BE từ chối; mọi khác biệt đều do FE chặt hơn và được liệt kê. Server fn input khớp BE cho resourceId/scopes. PATCH có `identifier`/`resourceId`/thiếu `scopes` bị cả BE lẫn server fn từ chối |
| `fe-admin/test/resources-ui-risk.test.tsx` (jsdom, StrictMode, route tree thật) | 20 (19 + 1 `it.fails`) | Body POST chính xác ở các biên; 10 case lỗi field (có focus, `aria-invalid`, không gửi, không step-up); tenant_admin không có đường ghi ở list/new/detail; DEBT-327 characterisation và case 9; ô chọn resource của form client được đọc lại sau khi tạo resource |

## Coverage acceptance criteria

- [x] **Task 0** (OpenAPI 3 response): `admin.spec.ts` có sẵn trong be 405/405. `gen:api` không diff (lệnh 3). `admin-schema-types.test.ts` xanh.
- [x] **Task 1 DEBT-318**: `client-secrets-risk.test.tsx` "was re-read" xanh. Ở hook mức resources, test `resources-ui.test.tsx` › invalidation cho thấy throw lạ và uncertain thì refetch, `forbidden` thì không.
- [x] **Task 1 DEBT-319**: test focus heading và vùng status luôn render trong `clients-ui*.test.tsx`/`client-secrets-risk.test.tsx` xanh (dev có mutation RED; tester không lặp lại).
- [x] **Task 2** (server fn): `resources-fn.test.ts` 44 test xanh. Đã đọc đủ: map 400/403/404/409/step_up; uncertain chỉ cho write; GET 5xx không uncertain; `../x`, `a/b` không gọi fetch; `after` được encode; không log body.
- [x] **Task 3, luật identifier mirror BE**:
  - `resource-form-schema.test.ts` cộng bảng parity (case 1–3): biên 2048/2049; `urn:`, `a:`;
  - `https://a/#` qua (giống BE), `https://a/#x` chặn;
  - khoảng trắng đầu/cuối gồm tab, NBSP, BOM, U+2028 bị FE chặn chặt hơn (đã duyệt, DEBT-324);
  - unicode host qua và gửi nguyên văn (case 4).
- [x] **Task 3, resourceId**: 64 qua, 65 chặn; ký tự đầu `-`, `.`, `_` chặn; chữ hoa, `é`, `a\n` chặn. Form, server fn và BE khớp nhau ở cả 19 case (case 2, 5).
- [x] **Task 3, scopes**:
  - 50 qua, 51 chặn; 256 qua, 257 chặn;
  - trùng qua tab/newline bị chặn;
  - NBSP, tab, U+3000, U+2028 bên trong bị tách thành hai token, nên BE không bao giờ nhận token chứa khoảng trắng;
  - ký tự astral: FE chặt hơn (case 3, 5).
- [x] **Task 3, PATCH chỉ `scopes`**: `resources-ui.test.tsx` "PATCH is { scopes } only". Server fn strict (case 3).
- [x] **Task 3, refetch không ghi đè draft**: `resources-ui.test.tsx` "a refetch while editing never overwrites the edit".
- [x] **Task 3, remount theo `resourceId`**: `resources-ui.test.tsx` "switching to another resource … remounts".
- [x] **Task 3, step-up restore không auto submit** (create và update, StrictMode): `resources-ui.test.tsx`, 2 test.
- [x] **Task 3, uncertain không retry**: `resources-ui.test.tsx` (create `toHaveBeenCalledTimes(1)`), case 8 (update).
- [x] **Task 3, `javascript:` không thành link ở list và detail**: `resources-ui.test.tsx` cộng case 6 (cả cursor `?after=javascript:…` vẫn là `href` nội bộ `/resources?after=`).
- [x] **Task 3, tenant_admin không có control ghi và không gọi server fn**: case 6 (list/new/detail; draft step-up cũ bị bỏ qua; `assign` không gọi).
- [ ] **Task 3, uncertain update**: không đảo ngược ý định — **FAIL**, case 9.
- [x] **Task 3, ô chọn resource của form client vẫn hoạt động**: case 7 (`/clients/new` thấy resource vừa tạo, cùng QueryClient), cộng `clients-ui*.test.tsx` xanh.
- [x] **Task 4, E2E**: 30/30 ×2 (lệnh 10, 11), spec resources xanh cả hai lần.

### Danh mục case

1. **Parity identifier**: 40 dòng, mỗi dòng có verdict BE đo được.
2. **Parity resourceId**: 19 dòng.
3. **Parity scopes**: 9 danh sách, 4 loại khoảng trắng bên trong, token rỗng, PATCH có field lạ.
4. **Body POST chính xác** (4 biên): đúng 3 key; identifier nguyên văn; scopes tách bởi tab/newline.
5. **10 lỗi field**: không gửi, không step-up, focus field lỗi, `aria-invalid`, `aria-describedby`.
6. **tenant_admin**: list, new, detail.
7. **Ô chọn resource của form client** được làm mới sau khi tạo resource.
8. **DEBT-327 characterisation**: thông điệp nói "reloaded: check it", nhưng scopes đọc lại (`server-saved`) không có trong DOM; form giữ text của admin; không tự gửi lại.
9. **Hoàn tác sau uncertain đã ghi thật**: FAIL (`it.fails`).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | super_admin, tenant_admin (không có ẩn danh: root route bắt đăng nhập, đã có ở run 43–44) | case 6, `resources-ui.test.tsx` |
| Credential | step-up `step_up_required` ⇒ draft, re-auth, restore, không auto-submit; draft cũ với viewer không có quyền bị bỏ qua | `resources-ui.test.tsx` ×2, case 6 |
| Authorization | tenant_admin không có UI ghi và không gọi server fn; BE 403 ⇒ thông điệp cố định | case 6, `resources-ui.test.tsx` "result regions" |
| Input | biên 2048/2049, 64/65, 50/51, 256/257; whitespace lạ; unicode/astral; `javascript:`, `data:`, `file:`; path traversal `../x` `a/b` | case 1–5, `resources-fn.test.ts` |
| State | uncertain không retry (create, update); double submit gửi 1 lần; refetch không ghi đè; **uncertain đã ghi + hoàn tác ⇒ FAIL** | `resources-ui.test.tsx`, case 8–9 |
| Dependency | GET 5xx ⇒ `unavailable`; POST/PATCH 5xx, timeout, 2xx sai schema ⇒ uncertain | `resources-fn.test.ts` |
| Request chain | step-up → `/auth/login?stepup=1&returnTo=%2Fresources%2Fdemo` → restore | `resources-ui.test.tsx` |
| Exposure | identifier chỉ là text (list, detail, cursor); không log body BE; log E2E không có token/secret; bundle client không có tên env server | case 6, `resources-fn.test.ts`, lệnh 5 và 12 |

- **INV** `resourceId`/`identifier` không bao giờ đổi qua UI: đạt. Không có `<input>` cho chúng ở detail; server fn `.strict()` và BE đều từ chối (case 3).
- **INV** chỉ ghi khi admin bấm (không auto-submit): đạt.
- **INV** không đảo ngược ý định: **không đạt** (case 9).
- **Ghi nhận thêm (không chặn)**:
  - DEBT-329: ký tự điều khiển C0 ở hai đầu và tab/LF ở giữa identifier qua cả FE lẫn BE, làm chuỗi lưu khác URL đã parse;
  - DEBT-330: khả năng cùng lỗi case 9 ở trang client;
  - DEBT-331: flaky fe-sso-test.
- Không có giá trị nào FE nhận mà BE từ chối.

## Ghi chú môi trường

- Không sửa code sản phẩm, không cài package, không commit.
- Không `compose up`/FLUSH/drop.
- Không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`.
- Script đo BE (`corpus.js`, `be-verdicts.js`) và test tạm `zz-tmp-parity` chỉ nằm ở scratchpad hoặc đã xoá. `git status` không có file lạ.
- E2E tạo thêm 2 resource `e2e-r<inv>` trong DB `sso-idp-e2e` (DEBT-322, đúng thiết kế).
