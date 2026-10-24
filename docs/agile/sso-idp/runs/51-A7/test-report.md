# Test Report — Lượt 3 (2026-10-24) — run 51 sau frontend-dev retry 2 (race đăng xuất)

## Kết quả: PASS — mọi cổng xanh; E2E full 35/35; `fe-admin.spec.ts` riêng 5/5 lần liên tiếp

| Cổng | Kết quả |
|---|---|
| `pnpm -C fe-admin typecheck` / `lint` | exit 0 / exit 0 |
| `pnpm -C fe-admin test` | exit 0. **`61 files / 1349 passed`** (1346 + 3 test mới của tester, L3-1) |
| `fe-admin build` (2 secret ngẫu nhiên) + `BUNDLE_CANARIES=<2 secret> check:bundle` | exit 0. `scanned 23 client files for 8 server env names + 2 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| `pnpm -C fe-admin gen:api` | exit 0, `schema.d.ts` sha256 `0724da9d…` trước = sau (không diff) |
| root `pnpm lint` | exit 0 |
| `pnpm -r run typecheck` | exit 0 (be, e2e, fe-admin, fe-sso-test: Done) |
| root `pnpm test` (tuần tự, 60 s) | exit 0. be `32 suites / 416`, fe-admin `61 / 1349`, fe-sso-test `31 / 269` |
| `pnpm audit --audit-level high` | exit 0. `13 vulnerabilities found — Severity: 6 low \| 7 moderate`, `1 ignored: 1 high` (happy-dom, DEBT-370) |
| Harness prod `valid` / `badenv` (scratchpad `prod/`, build mới) | `RESULT mode=valid fails=0` (152 ok, CSRF `/_serverFn` + logout 20 dòng 403) / `RESULT mode=badenv fails=0` |
| Chromium trên build prod | `/clients`, `/users`, `/` ⇒ `violations=0`; import đủ `22 fulfilled`; đối chứng inline ⇒ 1 vi phạm, `control executed=false`; `RESULT fails=0` |
| `pnpm -C e2e typecheck` | exit 0 |
| E2E `tests/fe-admin.spec.ts` riêng, 5 lần liên tiếp (retries 0) | 5/5 exit 0, mỗi lần `2 passed (1.1m)`; bước `waitForURL(IdP /logout)` (dòng 93) và IdP `/login` sau đó đều qua |
| E2E full `pnpm -C e2e e2e` (1 lần) | exit 0, **`35 passed (3.9m)`** |
| Grep secret 21 log `r51d/*` | regex JWT / `Bearer ` / `client_secret=` / `PRIVATE KEY` / `fea_sid=<giá trị>` = 0 file |

Trước mọi lần chạy E2E: `:3000/:4000/:5173` không LISTENING (netstat), `E2E_REUSE` chưa đặt; sau mỗi lần vẫn 0. Không compose up, không FLUSH/drop, không đụng `pnpm dev`.

## Lệnh đã chạy + output thực tế (lượt 3)
Log ở scratchpad `r51d/` (`fea-*.log`, `build.log`, `bundle.log`, `gen.log`, `h-valid.log`, `h-bad.log`, `browser.log`, `root-*.log`, `audit.log`, `e2e-tc.log`, `spec-1..5.log`, `e2e-full.log`). Số liệu trích nguyên văn ở bảng trên.

### L3-1 — test mới `fe-admin/test/sign-out-race-guard.test.tsx` (3 test, eslint sạch)
Test của dev (`sign-out-race.test.tsx`) dùng 1 query + 1 mutation. Tester thêm đúng kịch bản E2E đã tái hiện:
- **8 query dashboard pending** (`useQueries`, 8 key giống các khối dashboard) ⇒ `isFetching()===8` ⇒ submit form Sign out ⇒ submit `defaultPrevented=false`, `method=post`, `action=/auth/logout`, `isSigningOut()` true ⇒ cả 8 reject `unauthenticated` ⇒ `isFetching()` 0, **`location.assign` 0 lần**.
- **Characterisation DEBT-374 (cờ kẹt: `beginSignOut` không kèm `pageshow`)**: `signInAgain()` không điều hướng (đúng mô tả UX gap của DEBT-374); nhưng `RootRoute.options.beforeLoad` với `getViewer()→null` vẫn ném `redirect` có `href=/auth/login?returnTo=%2Fclients%3Fx%3D1`, `reloadDocument=true` ⇒ **fail-closed**, không fail-open. Giữ 🟡.
- Đối chứng: có viewer ⇒ guard cho qua (`{ viewer: { sub: "u1" } }`) dù cờ kẹt.
- **Mutation** (backup scratchpad, khôi phục sha256 khớp: `query-client.ts` `e46b5fdb…`, `__root.tsx` `96bd7bdb…`; `git diff` `__root.tsx` rỗng):
  - Bỏ guard `if (signingOut) return` ⇒ test characterisation RED (test 8-query vẫn xanh vì `cancelQueries` đã chặn `onError`: phòng thủ 2 lớp).
  - Bỏ `cancelQueries` ⇒ 3/3 xanh (guard `signInAgain` chặn).
  - Bỏ **cả hai** ⇒ test 8-query RED: `expected "vi.fn()" to not be called at all, but actually been called 8 times`.
  - Gate guard gốc bằng cờ (giả lập fail-open) ⇒ test characterisation RED.

## Test FAIL
Không có.

## Coverage acceptance criteria (lượt 3, phạm vi retry 2)
- [x] Race đăng xuất đóng: unit 8 query (L3-1) + E2E riêng 5/5 + full 35/35 tới IdP `/logout`
- [x] Form POST logout vẫn submit, không bị chặn: L3-1 (`defaultPrevented=false`)
- [x] Không hồi quy lint/typecheck/test/build/bundle/gen:api/audit: bảng trên
- [x] CSP/header/CSRF build prod: harness + Chromium

## Coverage security invariants / risk matrix (lượt 3)
- [x] Request chain: logout POST ⇒ request kế tiếp (IdP `/logout` ⇒ `/login`) không bị huỷ — E2E 5/5 + full
- [x] State/concurrent: 8 response `unauthenticated` đến sau submit ⇒ 0 điều hướng (L3-1)
- [x] Fail-closed khi cờ kẹt: guard gốc vẫn redirect (L3-1, mutation gate ⇒ RED)
- [x] Request chain CSRF `/_serverFn` + logout: 403 (harness valid)
- [x] Exposure: grep secret log 0; `check:bundle` 2 canary 0 hit

Debt mới: không (DEBT-374 giữ 🟡, đã có characterisation).

---

# Test Report — Lượt 2 (2026-10-24) — run 51 retry 1 cổng audit (zod 4.6.6 + override + ignore happy-dom)

## Kết quả: FAIL — E2E 34/35 ⇒ trả **frontend-dev** [FE]

Cổng audit đã **xanh**, zod bump đúng, smoke CSP prod sạch. Nhưng E2E full đỏ 1 test (`fe-admin.spec.ts:31`). Điều tra (case L2-6, L2-7) tách được 2 nguyên nhân, **cả hai đều không do zod bump hay diff run 51**:
1. **Lỗi test (tester đã sửa)**: assertion `body.includes("eyJ")` bắt nhầm `nextCursor` của audit (base64url JSON `{t,e}`). Chứng minh bằng decode key, không phải JWT.
2. **Lỗi sản phẩm, race đăng xuất (🔴 trả frontend-dev)**: bấm "Sign out" khi query dashboard còn đang chạy ⇒ server huỷ session ⇒ query trả `unauthenticated` ⇒ `QueryCache.onError` gọi `signInAgain()` ⇒ `location.assign("/auth/login…")` **huỷ điều hướng logout** (303 tới `end_session` không bao giờ được theo) ⇒ session IdP còn sống ⇒ đăng nhập lại im lặng, tạo session fe-admin mới. Người dùng tưởng đã đăng xuất nhưng vẫn đăng nhập. Tái hiện 4/7 lần chạy riêng spec có tới bước logout.

| Cổng | Kết quả |
|---|---|
| `pnpm audit --audit-level high` | **exit 0**. `13 vulnerabilities found — Severity: 6 low \| 7 moderate`, `1 ignored: 1 high` (happy-dom) |
| root `pnpm lint` | exit 0 |
| `pnpm -r run typecheck` | exit 0 (be, e2e, fe-admin, fe-sso-test Done) |
| root `pnpm test` (tuần tự, 56 s) | exit 0. be `32 suites / 416`, fe-admin **`59 files / 1343`** (+1 file / 8 test của tester), fe-sso-test `31 / 269` |
| fe-admin build (env secret ngẫu nhiên) + `check:bundle` 2 canary | exit 0. `scanned 23 client files for 8 server env names + 2 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| `pnpm -C be build` | exit 0 |
| Harness prod `valid` / `badenv` | `RESULT mode=valid fails=0` / `RESULT mode=badenv fails=0` |
| Browser Chromium trên build prod | `violations=0`, import đủ 22 chunk (22 fulfilled), đối chứng inline ⇒ 1 vi phạm, `RESULT fails=0` |
| E2E full `pnpm -C e2e e2e` (1 lần) | **exit 1: `1 failed, 34 passed (4.0m)`**. Xem L2-6 |
| Grep secret trên 19 log r51c-* | JWT/Bearer/client_secret/PRIVATE KEY/`fea_sid` = 0 trên mọi log |

## Lệnh đã chạy + output thực tế (lượt 2)

Tất cả chạy foreground. Trước E2E: `:3000/:4000/:5173` trống, `E2E_REUSE` chưa đặt. Sau mỗi lần chạy E2E các cổng vẫn trống. Không compose up, không FLUSH/drop. Mongo `sso-idp-e2e` (aegate-mongo) chỉ **đọc** để đếm sự kiện audit.

### L2-1 — test mới `fe-admin/test/zod-collections.test.ts` (8 test)
Nội dung: các schema input BFF (`ClientPatchSchema`/`UpdateClientInput`/`CreateClientInput`, build trên `@/lib/zod` jitless) vẫn validate đúng sau bump.
- 5 trường URI/scopes: 20 phần tử thì qua, 21 thì bị từ chối với đúng 1 issue `too_big` (`maximum: 20`, path đúng).
- `grantTypes` 21 phần tử enum hợp lệ ⇒ bị từ chối.
- **200k phần tử sai kiểu ⇒ đúng 1 issue `too_big`**, không validate từng phần tử (đây chính là vector GHSA-mrhx-c7xc-m3w5).
- Create vẫn strict (`clientSecret` lạ ⇒ từ chối), body hợp lệ thì qua.
- Kết quả: `Tests 8 passed (8)`, eslint OK.
- **Đối chứng trên zod 4.6.5** (thư mục mồ côi `node_modules/.pnpm/zod@4.6.5`, probe ở scratchpad, repo không bị sửa): cùng schema `z.array(z.string().max(2048)).max(20)` với 200k phần tử ⇒ `200001` issue `invalid_type`, 256 ms. Trên 4.6.6 ⇒ `1` issue `too_big`, 2 ms. ⇒ Test này **RED trên 4.6.5**, GREEN trên 4.6.6.
- Đã có sẵn từ trước, vẫn xanh: `admin-fn-risk.test.ts` ("21 redirect URIs" bị chặn trước admin API), `admin-fn.test.ts` (21 URI ⇒ reject).

### L2-2..L2-5 — cổng tĩnh, build, smoke prod
Xem bảng trên. Harness `valid` chi tiết:
- `/_serverFn` GET/POST với cross-site / same-site / none / evil Origin / Origin null / không header ⇒ **12/12 là 403**, đủ header CSP/XFO/nosniff/`no-store`.
- Đối chứng same-origin ⇒ 500 (fn id không tồn tại), tức là request đã qua CSRF.
- `/auth/logout` cross-site / same-site / evil / không header ⇒ **4/4 là 403**, `set-cookie#=0`. GET ⇒ 405.
- `form-action 'self' https://127.0.0.1:39991` (issuer vẫn được parse qua env zod 4.6.6).

### L2-6 — E2E full: 34/35, `fe-admin.spec.ts:31` FAIL
```
Error: no JWT in any fe-admin document or /_serverFn response
+   "/_serverFn/eyJmaWxlIjoiL3NyYy9mZWF0dXJlcy9hZG1pbi1hcGkvYXVkaXQudHM_…"   (listAudit)
```
Lượt 1 và các lần chạy trước 09:29 (thời điểm bump) đều pass test này. Sau bump: 3/9 lần chạy (1 full + 8 riêng spec) pass. Thời điểm trùng nhau nhưng không có quan hệ nhân quả (xem L2-7).

### L2-7 — chẩn đoán (sửa tạm spec rồi khôi phục, sha256 khớp, chỉ chạy riêng `tests/fe-admin.spec.ts`)
- **(a) `eyJ` = audit cursor**: in key sau khi decode base64url mọi chuỗi `eyJ…` trong body `/_serverFn` ⇒ 3/3 là `decodedKeys=t,e`, `followedByDot=false`, len 83. Khớp `encodeAuditCursor` (`be/src/modules/admin/admin-audit.controller.ts:16`).
  - DB E2E dùng chung, không bao giờ được dọn: `ADMIN_USER_LOCKED` 45, `SIGNING_KEY_ROTATED` 13 (> `RECENT_LIMIT` 10) ⇒ khối "Recent security events" (run 50) nhận `nextCursor`.
  - Body có bị bắt hay không tuỳ timing, nên test chập chờn.
- **(b) race đăng xuất**: gắn listener request/response/navigation. Lần fail:
  ```
  3ms   click Sign out
  54    POST /auth/logout (navigation)
  56–129  8 response /_serverFn của dashboard (gửi trước click) trả về
  132   POST /auth/logout net::ERR_ABORTED
  133   GET /auth/login (navigation) → 302 /authorize → 302 /auth/callback → 302 / → 200
  ```
  ⇒ trang trở về `/` đã đăng nhập, IdP `/logout` không bao giờ được mở.
  - Nguồn: `fe-admin/src/features/admin-api/query-client.ts` `onError` ⇒ `signInAgain()` ⇒ `location.assign`. Code này có từ trước run 51; `routes/index.tsx` trong diff run 51 chỉ refactor `auditListQuery`.
  - Lần pass (có chờ 8 s trước click): POST logout 303 ⇒ IdP `/logout` 200 ⇒ confirm 302 ⇒ `:3000/`.
- Chạy riêng spec (sau khi sửa assertion): 4 lần ⇒ pass 2, fail 2, cả 2 lần fail đều ở `waitForURL(/logout)` (dòng 93).

### L2-8 — tester sửa test E2E (không phải code sản phẩm)
`e2e/tests/fe-admin.spec.ts:85-88`: thay `body.includes("eyJ")` bằng regex dạng JWT `/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\./` (JWS, và JWE có segment key rỗng).
- Kiểm regex: cursor ⇒ false, JWS ⇒ true, JWE `dir` ⇒ true, đường dẫn fn id ⇒ false.
- `pnpm -C e2e typecheck` exit 0.
- 3 kiểm tra `eyJ` khác (Web Storage, DOM, SSR HTML) giữ nguyên.

## Test FAIL
- `e2e/tests/fe-admin.spec.ts:31` (bước logout) — kỳ vọng: Sign out ⇒ IdP `/logout` ⇒ hết session IdP. Thực tế: khi query dashboard còn đang chạy, logout bị huỷ và người dùng được đăng nhập lại im lặng.
  - Nghi ngờ nguyên nhân: `signInAgain()` (QueryCache/MutationCache `onError`) chạy trong lúc form logout đang điều hướng.
  - Gợi ý cho dev: khi submit Sign out, chặn redirect tự động (cờ "đang đăng xuất" làm `signInAgain` không làm gì, và/hoặc `queryClient.cancelQueries()` trước khi submit).
  - Cần thêm test unit/E2E tất định cho race này (query trả `unauthenticated` sau khi submit logout ⇒ không `location.assign`).

## Coverage acceptance criteria (lượt 2, phạm vi retry)
- [x] Audit high = 0 (trừ ignore có lý do): L2-2
- [x] zod 4.6.6 vẫn validate đúng ở BFF (max 20, oversized, strict): L2-1, kèm đối chứng RED trên 4.6.5
- [x] Không hồi quy lint/typecheck/test/build/bundle: L2-2..L2-4
- [x] CSP/header/CSRF build prod: L2-5
- [ ] E2E full xanh: **FAIL**, L2-6/L2-7

## Coverage security invariants / risk matrix (lượt 2)
- [x] Input oversized (GHSA-mrhx): 200k phần tử ⇒ 1 issue (L2-1)
- [x] Request chain CSRF `/_serverFn` + logout: 16/16 bị chặn 403 (L2-5)
- [x] Exposure: không JWT trong body BFF (đã kiểm bằng decode, L2-7a); grep log = 0
- [ ] **Request chain logout ⇒ request kế tiếp**: FAIL. Logout bị huỷ, session IdP còn, đăng nhập lại im lặng (L2-7b)

Debt mới: **DEBT-372** (DB E2E dùng chung tích luỹ không giới hạn).

---

# Test Report — 2026-10-24 — run 51 (A7 Hardening FE + DEBT-360/359/269/266/298/292/364/365/366)

## Kết quả: FAIL — chỉ 1 cổng: `pnpm audit --audit-level high` (2 high, advisory mới công bố, không do diff run 51) ⇒ trả **backend-dev + frontend-dev** [BE|FE]

Phần nghiệm thu chức năng và bảo mật A7 đều **PASS**:
- fe-admin 58 file / 1335 test (thêm 1 file / 2 test của tester).
- Root `pnpm test` tuần tự xanh 2/2 lần.
- E2E 35/35.
- Harness production 0 lỗi.
- Browser trên build prod: 0 vi phạm CSP.
- 4 mutation của tester đều RED.

Cổng duy nhất đỏ là `pnpm audit`. Lockfile không đổi so với `b9e6cb8` (`git diff HEAD -- pnpm-lock.yaml` rỗng). Run 50 audit sạch, chỉ có 1 ignored. Hai advisory dưới đây được công bố sau đó:

| # | Gói | Advisory | Bản sửa (ngày phát hành) | Đường dẫn | Tác động |
|---|---|---|---|---|---|
| 1 | `zod` 4.6.5 (high) | GHSA-mrhx-c7xc-m3w5 "Zod can exhaust memory while validating oversized constrained collections" | 4.6.6 (2026-10-11, 13 ngày) | `be>zod`, `fe-admin>zod`, `fe-admin>@t3-oss/env-core>zod` | Runtime: BE validate input không tin cậy ⇒ DoS bộ nhớ có thể xảy ra |
| 2 | `happy-dom` 21.0.1 (high) | GHSA-834v-8h66-3h79 "Incomplete fix for CVE-2026-33943 … host code execution" | 21.0.4 (2026-10-20, 4 ngày) | `fe-admin>happy-dom`, `fe-admin>vitest>happy-dom`, fe-sso-test | Chỉ dev/test |

CI chạy `pnpm audit --audit-level high` fail-closed (comment ở `pnpm-workspace.yaml`), nên merge sẽ bị chặn. Có hai hướng:
- Bump `zod` → 4.6.6 (be + fe-admin) và `happy-dom` → 21.0.4 (fe-admin + fe-sso-test).
- Hoặc tạm thêm `ignoreGhsas` kèm lý do và ngày re-review, theo quy ước có sẵn. Quy ước release-age 14 ngày (run 41) có thể khiến bản sửa chưa "đủ tuổi"; đây là quyết định của tech-lead/orchestrator.

Tester không cài package.

## Lệnh đã chạy + output thực tế

Tất cả chạy foreground. Trước khi chạy E2E: `:3000/:4000/:5173` trống, `E2E_REUSE` chưa đặt. Sau E2E các cổng này vẫn trống. `vg-test-redis`/`vg-test-mongo` đã Up sẵn (không cần `docker start`). Không compose up, không đụng `aegate-*`.

| # | Lệnh | Output thực tế |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` | OK (16 s) |
| 2 | `pnpm -C fe-admin lint` | OK (11 s) |
| 3 | `pnpm -C fe-admin test` (trước khi thêm test) | `Test Files 57 passed (57)`, `Tests 1333 passed (1333)` (22 s) |
| 4 | `pnpm -C fe-admin build` (env build có `OIDC_CLIENT_SECRET`/`SESSION_SECRET` ngẫu nhiên) | `✓ built` |
| 5 | `BUNDLE_CANARIES=<2 secret build> pnpm -C fe-admin check:bundle` | `scanned 23 client files for 8 server env names + 2 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| 6 | `pnpm -C fe-admin gen:api` | không diff `schema.d.ts` |
| 7 | `npx vitest run test/csp-nonce-concurrency.test.tsx` (mới) | `Tests 2 passed (2)`; eslint + tsc OK |
| 8 | root `pnpm lint` | exit 0 (be, fe-admin, fe-sso-test Done) |
| 9 | root `pnpm -r run typecheck` | be/e2e/fe-admin/fe-sso-test Done |
| 10 | root `pnpm test` lần 1 (`--workspace-concurrency=1`) | exit 0, 55 s; be `32 suites / 416`, fe-admin `58 files / 1335`, fe-sso-test `31 files / 269` |
| 11 | root `pnpm test` lần 2 | exit 0, 55 s; số liệu giống hệt lần 1 |
| 12 | root `pnpm audit --audit-level high` | **exit 1**: `15 vulnerabilities found — Severity: 6 low \| 7 moderate \| 2 high` (xem bảng trên) |
| 13 | `pnpm -C e2e e2e` | exit 0, `35 passed (3.9m)`, gồm `fe-admin-hardening.spec.ts` (14.3 s) và `admin-api-risk.spec.ts` (có replay `Sec-Fetch-Site: none`) |
| 14 | Harness prod `valid` (case 1) | `RESULT mode=valid fails=0` |
| 15 | Harness prod `badenv` (case 2) | `RESULT mode=badenv fails=0` |
| 16 | Browser trên build prod (case 3) | `RESULT fails=0` |
| 17 | `check:bundle` sau khi khôi phục mutation và rebuild | `22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| 18 | Grep secret trên log E2E/root test (`eyJ…`, `Bearer …`, `client_secret=…`, `BEGIN … PRIVATE`, `fea_sid=<16+>`) | 0 / 0 / 0 / 0 / 0 trên cả 3 log |

### Case 1 — harness production `valid`

Script ở scratchpad `prod/harness.mjs`, không commit. Script import `fe-admin/dist/server/server.js` (build prod) và gọi `fetch` trực tiếp, không mở cổng. Env prod hợp lệ dùng https: issuer/admin API trỏ `https://127.0.0.1:39991` (đóng ⇒ IdP down), Redis `127.0.0.1:39992` (đóng ⇒ store down). Console bị spy.

Mỗi response đều được kiểm:
- CSP có nonce ≥16 byte.
- `script-src` không có `unsafe-inline`/`unsafe-eval`/`strict-dynamic`/`*`.
- `frame-ancestors 'none'` và XFO `DENY`.
- `nosniff`, `Referrer-Policy: same-origin`, COOP, Permissions-Policy.

Kết quả theo từng request:

**Trang và route**
- `GET /` (không cookie) ⇒ **307** `/auth/login?returnTo=%2F`.
  - Có đủ header, có HSTS `max-age=31536000` (APP_URL https).
  - `form-action 'self' https://127.0.0.1:39991`.
- `GET /auth/login` (IdP down) ⇒ **503** `no-store`, có header.
- `GET /clients` và `GET /users` **đồng thời** (cookie `__Host-fea_sid`, Redis down) ⇒ cả hai **503** `no-store`, có HSTS.
  - Mọi `<script>` trong HTML mang đúng nonce của chính response đó.
  - `meta csp-nonce` bằng nonce của chính response.
  - HTML **không** chứa nonce của response kia.
  - Hai nonce khác nhau.
- `GET /definitely-not-a-route` ⇒ 503 (có cookie, store down), có header.
- `GET /assets/missing.js` ⇒ 307, có header.

**`/_serverFn` (GET và POST)**
- Các biến thể `Sec-Fetch-Site: cross-site|same-site|none`, `Origin: https://evil.example`, `Origin: null`, không header nào ⇒ **12/12 là 403**, mỗi response có CSP/XFO/nosniff/`no-store`.
- Đối chứng `same-origin` ⇒ 500 (fn id không tồn tại). Request đã qua CSRF, đúng như kỳ vọng.

**`/auth/logout`**
- POST với `cross-site`, `same-site`, evil Origin, không header ⇒ **403**, 0 `Set-Cookie`, có header.
- `GET` ⇒ 405.
- POST same-origin (Redis down) ⇒ 503, kèm `Set-Cookie: __Host-fea_sid=<v>; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`.

**Log**
- 8 dòng console, 25 nonce thu được, **0 nonce xuất hiện trong log**.
- Log không chứa `eyJ`, `Bearer `, `__Host-fea_sid=`, `OIDC_CLIENT_SECRET` hay `SESSION_SECRET`.
- Đã đọc tay: chỉ có thông điệp cố định, request id và tên lỗi.

### Case 2 — harness production `badenv`

Thiếu `OIDC_ISSUER`/`OIDC_CLIENT_SECRET`/`SESSION_SECRET`. `GET /`, `GET /_serverFn/x`, `POST /auth/logout` ⇒ **500**, mỗi response đều:
- có đủ header;
- `form-action 'self'` (không có issuer);
- `no-store`;
- không HSTS (không có app URL);
- 0 nonce trong log.

### Case 3 — Chromium trên build production

Script ở scratchpad `prod/browser.mjs`, không commit. Node http trên `127.0.0.1:39990` phục vụ `dist/client/assets` cùng fetch entry prod; Playwright của gói `e2e`.

Thu vi phạm:
- Listener `securitypolicyviolation` gắn qua `addInitScript`.
- Thêm các dòng console `Content Security Policy|Refused to`.

Kết quả:
- `/clients`, `/users`, `/` (trang 503 SSR có hydrate) ⇒ **0 vi phạm**. Client đã chạy: tải `preload-helper`, `step-up-*`, `index-*`, và có global `$_TSR`.
- `import()` **toàn bộ 22 chunk** client ngay trong trang dưới CSP thật ⇒ 22 fulfilled, **0 vi phạm** (gồm cả eval probe của zod).
- Đối chứng dương: chèn `<script>` inline không nonce ⇒ đúng 1 vi phạm `script-src-elem inline`, script không chạy. Cách đếm không dùng sleep: event vi phạm của đối chứng xếp hàng sau mọi vi phạm từ import, nên khi đã thấy đối chứng thì mọi vi phạm trước đó cũng đã được dispatch.

## Mutation (tester) — backup sha256, khôi phục byte-identical

| # | Mutation | Kết quả | Khôi phục |
|---|---|---|---|
| M1 | `step-up.ts` import `"zod"` trực tiếp, rồi `vite build` (tái hiện phát hiện của senior) | Browser prod: `/users`, `/` mỗi trang 1 vi phạm `script-src eval`; sau import-all có 2 vi phạm ⇒ `RESULT fails=4` **RED** | `sha256sum -c` OK; đã rebuild; `check:bundle` 0 |
| M2 | `security-headers.ts` dùng biến module dùng chung thay ALS | `csp-nonce-concurrency` 2/2 **RED** | OK |
| M3 | Nonce cố định ở cấp module | 2/2 **RED** | OK |
| M4 | `console.error("csp", nonce)` trong wrapper | Test "logs never hold a nonce" **RED**; ESLint `no-console` báo `47:3 error Unexpected console statement` | OK |

Các mutation của frontend-dev trong `log.md` (6 mutation T2, Secure, sidebar, CSRF, log token, jitless, `console.log`) không chạy lại.

ESLint `no-restricted-imports` (stdin, `src/features/probe.ts`):
- `import "zod"` ⇒ error.
- `"zod/v4"`, `"zod/mini"` ⇒ error (pattern).
- `import("zod")` động ⇒ **không** báo. Lưới thứ hai là `check:bundle` đếm eval cùng browser prod ⇒ DEBT-367.

## Test FAIL
- `pnpm audit --audit-level high`:
  - Kỳ vọng: không có high nào chưa ignore.
  - Thực tế: 2 high (`zod` GHSA-mrhx-c7xc-m3w5, `happy-dom` GHSA-834v-8h66-3h79).
  - Nguyên nhân: advisory mới công bố sau run 50; lockfile không đổi. **Không** phải hồi quy của run 51.

## Test mới (tester)
- `fe-admin/test/csp-nonce-concurrency.test.tsx`:
  - (1) Hai request A/B đan xen qua `await`, B xong trước A. Mỗi bên dùng `getRouter()` thật, render stream có deferred loader. Assert:
    - mỗi HTML có ≥2 `<script>`, tất cả mang nonce của chính nó;
    - không chứa nonce bên kia;
    - giá trị deferred đọc `currentCspNonce()` đúng của request;
    - console (5 mức) không chứa nonce nào.
  - (2) 20 request song song ⇒ 20 nonce khác nhau, mỗi nonce bằng giá trị `getRouter()` thấy bên trong handler.

## Coverage acceptance criteria
- [x] CSP nghiêm có nonce, không `unsafe-inline`/`unsafe-eval`:
  - unit `security-headers (a)(b)`, `csp-nonce-ssr (a)(b)`, `csp-nonce-concurrency`;
  - prod case 1 và case 3;
  - E2E `fe-admin-hardening`.
- [x] Security headers (XFO, nosniff, Referrer, Permissions, COOP, HSTS chỉ https, `no-store` không ghi đè): unit (c)–(i), case 1/2.
- [x] Header áp cho mọi loại response:
  - redirect 3xx (307 guard), 404/unknown (503 do store down, có header);
  - 500 env lỗi (case 2), 503 (case 1, unit h);
  - `/_serverFn` (case 1, E2E), logout (case 1).
- [x] `Set-Cookie` nhiều giá trị được giữ: unit (c); logout prod giữ `Set-Cookie` qua wrapper.
- [x] Chặn clickjacking: `frame-ancestors 'none'` + XFO (unit, case 1/2, E2E).
- [x] Cookie:
  - `theme`/`sidebar_state` có `SameSite=Lax`, `Secure` chỉ khi https (`pref-cookies.test.tsx`), E2E `sameSite: "Lax"`;
  - ma trận `fea_*` http/https (`cookie-matrix.test.ts`);
  - prod `__Host-fea_sid … HttpOnly; SameSite=Lax; Secure` (case 1).
- [x] CSRF server fn (GET+POST × `cross-site|same-site|none`, evil Origin, Origin null, không header) ⇒ 403:
  - unit `csrf-wiring.test.ts`;
  - prod case 1 (12/12);
  - E2E `admin-api-risk` (`none`).
- [x] Logout cross-site bị chặn: case 1 (4 biến thể ⇒ 403, 0 cookie).
- [x] Không log token/secret (INV-20 FE):
  - `log-canary.test.ts` (canary qua callback/refresh 400/500);
  - `admin-api-risk.test.ts` (đã có);
  - case 1/2 (log prod không có nonce/token/cookie/secret);
  - grep log E2E/root = 0;
  - ESLint `no-console` hoạt động (M4).
- [x] Bundle không lộ secret, 0 lời gọi eval: `check:bundle` (2 canary ⇒ 0 hit, 0 lần gọi Function/eval), case 3 import-all 0 vi phạm, M1 RED.
- [x] T1: root `pnpm test` tuần tự xanh 2/2 (55 s / 55 s).
- [x] zod qua `@/lib/zod` + `no-restricted-imports` hoạt động (stdin probe, M1). Ngoại lệ `import()` động ⇒ DEBT-367.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | anonymous (redirect), có cookie phiên (store down), actor cross-site | case 1, E2E |
| Credential | không có, cookie `__Host-fea_sid` ngẫu nhiên (không hợp lệ hoặc store down) | case 1 |
| Authorization / origin | `Sec-Fetch-Site` cross-site, same-site, none, same-origin (đối chứng); Origin evil/null; không header | `csrf-wiring`, case 1, E2E |
| Input | path lạ, asset thiếu, fn id không tồn tại | case 1 |
| State | 2 request đan xen; 20 song song; nonce mới mỗi response | `csp-nonce-concurrency`, case 1 |
| Dependency | IdP down ⇒ 503, Redis down ⇒ 503, env lỗi ⇒ 500: đều có header, fail-closed (không có 200 hay guest) | case 1/2 |
| Request chain | 307 guard; logout 303/503 với `Set-Cookie` clear | case 1, E2E logout `form-action` |
| Exposure | nonce/token/cookie/secret không có trong log; HTML không có nonce request khác; bundle không có secret | case 1/2/3, `check:bundle`, grep |

## Debt mới
- **DEBT-367** [FE] 💭: `no-restricted-imports` không bắt `import("zod")` động. Lưới thứ hai đã có: `check:bundle` đếm eval và CSP chặn. Hướng xử lý: thêm `no-restricted-syntax` cho `ImportExpression[source.value=/^zod/]`, hoặc chấp nhận.
- **DEBT-368** [FE] 💭: senior nit chưa làm. Nếu `handle` throw, `withSecurityHeaders` reject ⇒ runtime trả 500 tự sinh, không có CSP/`no-store`. Thân lỗi mặc định không có script nên rủi ro thấp. Trong mọi nhánh lỗi đã thử (IdP down, Redis down, env lỗi, fn id lạ) Start đều tự bắt và trả response có header. Hướng xử lý: `try/catch` trong `run` trả 500 thuần.
