# Log — run 51 — A7 Hardening FE (+ DEBT-360/359)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đối chiếu code `b9e6cb8` và source dist thật của TanStack. Fold ghi trong `tasks.md`, review ở `review-techlead.md`.

- **Phạm vi**: 1 run, size M, tất cả giao frontend-dev, không có [BE].
  - Thứ tự: T1 (DEBT-360/333/355/331 + 359) → T2 (CSP/header, DEBT-269/266/298/292) → T3 (cookie UI, test CSRF, INV-20 log) → T4 E2E.
- **Sự thật đã kiểm**
  - Nonce chỉ đi qua `router.options.ssr.nonce`; Start không tự sinh nonce và không đặt header.
  - `getRouter` được gọi bên trong `handler.fetch`, nên ALS ở `server.ts` dùng được.
  - `getGlobalStartContext` throw khi chạy ngoài context.
  - CSRF server fn đã có và fail-closed; E2E đã phủ (run 43).
  - Cookie `fea_*` đã đúng. `theme`/`sidebar_state` thiếu `Secure`, và `sidebar_state` thiếu `SameSite`.
  - DEBT-360: quá tải CPU do 3 runner chạy song song trên 28 core.
- **Quyết định**
  - Dùng nonce, không dùng hash, không `strict-dynamic`.
  - `form-action` gồm `'self'` và issuer.
  - `Referrer-Policy: same-origin`.
  - `no-store` khi response chưa có `cache-control`.
  - Dev và prod dùng `script-src` giống nhau.
  - Root test chạy `--workspace-concurrency=1`.
- **Debt mới**: DEBT-361 (`style-src 'unsafe-inline'`), DEBT-362 (header cho asset tĩnh ở prod), DEBT-363 (Trusted Types / report-to / meta nonce).

## frontend-dev — 2026-10-24

**T1–T4 xong.** T1: root `test` chạy `--workspace-concurrency=1`, `vi.waitFor` ở router-lab, timeout 20 s chỉ cho check-bundle, DEBT-359. T2: `security-headers.ts` + `server.ts` (ngoài cùng) + `router.tsx` `ssr.nonce`. T3: `writePrefCookie`, ma trận cookie http/https, test wiring CSRF, `no-console` + test canary. T4: `fe-admin-hardening.spec.ts` + replay `Sec-Fetch-Site: none`.
- **Lệch fold (cần senior/tech-lead xác nhận)**: E2E bắt được vi phạm `script-src eval` từ zod 4 (`new Function` probe, xảy ra cả ở prod, không phải Vite). Đã sửa bằng `z.config({ jitless: true })` (`src/lib/zod-jitless.ts`, import đầu tiên trong `router.tsx`), không nới CSP ⇒ DEBT-364. `env.ts`/`idp.ts` log có từ trước dùng `eslint-disable` từng dòng ⇒ DEBT-365.
- **Verify**: fe-admin typecheck/lint/build OK, test 57 file / 1328; `check:bundle` 2 canary ⇒ 0 hit; `gen:api` không diff. Root lint, `-r typecheck`, e2e typecheck OK. Root `pnpm test` 3/3 xanh (72/61/58 s; be 416, fe-admin 1328, fe-sso-test 269); lệnh song song cũ 2/2 xanh (ghi nhận). E2E full 2/2 xanh (35/35, 280 s/239 s).
- **Mutation** (backup sha256, khôi phục byte-identical): 6 mutation T2, Secure, sidebar bỏ helper, bỏ CSRF, log body token, bỏ jitless, `console.log` (eslint) ⇒ đều RED. Bỏ `withSecurityHeaders` khỏi `server.ts` ⇒ chỉ E2E RED (đúng như fold dự kiến).
- **Hạ tầng**: Docker restart giữa phiên ⇒ đã `docker start vg-test-redis vg-test-mongo` (container test có sẵn, không compose up); không có lock `vg:int-lock`; cổng :4000/:5173/:3000 trống trước và sau E2E. Đóng DEBT-360/333/355/331/359/269/266/298/292; mở DEBT-364/365. → **senior-reviewer**.

## senior-reviewer — 2026-10-24

**Kết luận: PASS.** Không có 🔴, 1 🟡 ⇒ DEBT-366. Chi tiết ở `review-senior.md`.

- **Đã chạy lại**: fe-admin typecheck/lint/build OK, test 57 file / 1328 xanh. Kiểm trực tiếp `dist/client`: không có `async_hooks`/`randomBytes`; `ssr.nonce` đọc từ meta. Không chạy E2E.
- **Security invariants**: các mục sau đều đạt.
  - Nonce 128 bit mới cho mỗi response, ALS bao `getRouter`, không rò giữa các request.
  - Mọi script SSR/stream có nonce; `no-store`; giữ `Set-Cookie`; 500/503 có header.
  - HSTS chỉ https; `form-action` có issuer; XFO/`frame-ancestors`.
  - CSRF fail-closed (unit + E2E `none`); ma trận cookie; INV-20 canary.
- **DEBT-364**: chấp nhận jitless toàn cục, áp cả server (không đáng kể về hiệu năng, không cần tách client). Tuy vậy, bản `vite build` dựng `StoredIntent` (z.object) trong chunk chung `step-up-*.js` trước khi config chạy. Zod probe eval lúc dựng schema (`schemas.js:1166-1168`, đã chứng minh bằng script node) ⇒ production còn 1 vi phạm CSP mỗi lần tải trang (không hở bảo mật). ⇒ DEBT-366: chuyển sang re-export `src/lib/zod.ts` + `no-restricted-imports`.
- **DEBT-365**: chấp nhận `eslint-disable` từng dòng. Hai dòng log chỉ in text cố định / tên biến + thông điệp schema tự đặt, không echo giá trị. Đóng cùng run.
- **Ponytail**: Lean already. → **tester**.

## frontend-dev (DEBT-366) — 2026-10-24

- **Sửa**: `src/lib/zod.ts` (config jitless, re-export `z`), 16 module chuyển sang import từ đó, ESLint `no-restricted-imports` cấm `zod`, bỏ `lib/zod-jitless.ts` + import ở đầu `router.tsx`. Nit: `countText` lại gán vào `const text`. Chưa làm 2 💭 khác của senior: try/catch trong wrapper, test 2 request đan xen.
- **Chứng minh trên build prod**: `check:bundle` import mọi chunk `dist/client` với `Function`/`eval` được bọc để đếm, fail-closed; thêm 5 test. Build thật: 22 chunk, 0 lần gọi. Mutation `step-up.ts` import `zod` trực tiếp ⇒ lint lỗi `no-restricted-imports`, `check:bundle` đếm 1 lần gọi ⇒ đỏ (tái hiện đúng phát hiện của senior); khôi phục, sha256 khớp.
- **Verify**: fe-admin typecheck/lint/build OK; test 57 file / 1328 → 1333 (+5 test check-bundle); `check:bundle` 2 canary ⇒ 0 hit, 0 lần gọi Function/eval; root lint OK; E2E full 35/35 (240 s); cổng trống trước và sau; scan secret 0 hit. Đóng DEBT-364/365/366. → **tester**.

## tester — 2026-10-24

**Kết quả: FAIL. Chỉ 1 cổng đỏ: `pnpm audit --audit-level high`, do 2 advisory high mới công bố (không phải hồi quy của run 51).** Toàn bộ nghiệm thu A7 PASS. Chi tiết ở `test-report.md`.

- **Gói bị cảnh báo**:
  - `zod` 4.6.5: GHSA-mrhx-c7xc-m3w5, cạn bộ nhớ, ảnh hưởng be + fe-admin runtime. Bản sửa 4.6.6.
  - `happy-dom` 21.0.1: GHSA-834v-8h66-3h79, chỉ dev. Bản sửa 21.0.4.
  - Lockfile không đổi so với HEAD. ⇒ backend-dev + frontend-dev bump, hoặc tech-lead quyết định `ignoreGhsas` có lý do (bản sửa còn non so với quy ước 14 ngày).
- **Số liệu**:
  - fe-admin: typecheck/lint/build OK; 58 file / 1335 test (+1 file / 2 test của tester); `check:bundle` 2 canary ⇒ 0 hit, 22 chunk, 0 lần gọi Function/eval; `gen:api` không diff.
  - Root: lint OK, `-r typecheck` OK; `pnpm test` tuần tự 2/2 xanh (55 s / 55 s; be 416, fe-admin 1335, fe-sso-test 269).
  - E2E 35/35 (3.9 phút). Cổng trống trước và sau; không dùng `E2E_REUSE`.
  - Grep secret trên log: 0.
- **Build production** (harness ở scratchpad, gọi fetch entry `dist/server/server.js`, không commit):
  - Header/CSP có trên mọi loại response: 307, 503 (IdP down, Redis down), 500 env lỗi, `/_serverFn`, logout.
  - CSRF `/_serverFn` GET/POST 12/12 là 403; logout cross-site 4/4 là 403, không có cookie.
  - 2 request đồng thời: mỗi HTML chỉ chứa nonce của chính nó.
  - 0 nonce, 0 token/secret trong log.
  - Chromium trên build prod: 0 vi phạm CSP, kể cả khi import toàn bộ 22 chunk; đối chứng inline ⇒ 1 vi phạm.
- **Test mới**: `fe-admin/test/csp-nonce-concurrency.test.tsx` (A/B đan xen + 20 request song song, nonce không lọt vào log).
- **Mutation** (backup sha256, khôi phục byte-identical), đều RED:
  - `step-up` import `zod` trực tiếp ⇒ browser prod bắt 2 vi phạm eval.
  - Thay ALS bằng biến dùng chung.
  - Nonce cố định.
  - `console.error(nonce)` ⇒ test RED và ESLint `no-console`.
- **Debt mới**: DEBT-367 (`import("zod")` động lọt lint), DEBT-368 (wrapper không try/catch, senior nit).
- **2026-10-24 tech-lead (fold audit)**: đã tự xác minh bằng `pnpm audit --json` + `npm view time`. Quyết định:
  - zod ⇒ bump 4.6.6: 3 `package.json` + override `zod: 4.6.6`; ngoại lệ quy tắc 14 ngày vì là bản sửa bảo mật, 13 ngày tuổi, 0 dependency. BFF fe-admin khai thác được, BE thì không.
  - happy-dom ⇒ `ignoreGhsas` GHSA-834v-8h66-3h79, bump vào 2026-11-04.
  - Lệnh và verify chính xác: `tasks.md` mục "Fold tech-lead — audit (2026-10-24)".
  - Debt mới DEBT-369/370. Chuyển **backend-dev** (`be/package.json`) + **frontend-dev** (phần còn lại, `pnpm install`, verify) ⇒ tester chạy lại cổng audit.
- **2026-10-24 frontend-dev (retry 1, cổng audit)**: áp dụng đúng fold. `zod` 4.6.5⇒4.6.6 ở `be`/`fe-admin`/`fe-sso-test` `package.json`; `pnpm-workspace.yaml` thêm override `zod: 4.6.6` + `ignoreGhsas` GHSA-834v-8h66-3h79. `pnpm install` (không up/add).
  - Lockfile +24/-23, chỉ dòng zod: override, 3 importer, key `zod@4.6.6` (integrity `sha512-4Umz…UhA==`), tham chiếu `zod: 4.6.6` / `zod-validation-error: 4.0.2(zod@4.6.6)`. Ngoài danh sách fold, vẫn chỉ là zod: peer range `^3.24.0 || ^4.0.0`/`^3.25.0 || ^4.0.0` ⇒ `4.6.6` (override ghi đè peer) và hậu tố `(zod@4.6.6)` trong key `@t3-oss/env-core`/`zod-validation-error`. `happy-dom` không đổi (21.0.1); `grep -c zod@4.6.5` = 0; key mới duy nhất `zod@4.6.6`; `pnpm -r why zod` chỉ 4.6.6.
  - `pnpm audit --audit-level high` exit 0 (13 low/moderate; "1 ignored: 1 high", fold dự kiến 2: braces 3.0.3 vẫn trong lockfile, nên số đếm có thể do registry).
  - Root `pnpm lint` exit 0; `pnpm -r run typecheck` exit 0 (4 project); root `pnpm test` exit 0: be 32 suites/416 tests, fe-admin 58 files/1335, fe-sso-test 31/269.
  - `fe-admin build` exit 0; `check:bundle` quét 23 file, 22 chunk, 0 Function/eval, 0 hit. `be build` exit 0. Không chạy E2E. ⇒ chuyển **senior-reviewer**/tester chạy lại cổng audit + smoke CSP prod.
- **2026-10-24 senior-reviewer (vòng 2, cổng audit)**: **PASS**. Tự kiểm: diff lockfile chỉ đổi zod; 2 loại dòng ngoài danh sách fold (peer range bị override ghi thành `4.6.6`, hậu tố key `(zod@4.6.6)`) là hành vi chuẩn của pnpm, chấp nhận được (hệ quả ghim cứng đã có trong DEBT-369). Integrity khớp `npm view`, không có package mới, happy-dom vẫn 21.0.1. `pnpm -r why zod` chỉ ra 4.6.6. `pnpm audit --audit-level high` exit 0. `pnpm -r run typecheck` exit 0. Chạy audit trên bản sao ở scratchpad: "1 ignored" = happy-dom; GHSA-vfj7-8cjw-p6xm (braces) đã bị withdraw 2026-10-23 nên entry ignore đã chết ⇒ DEBT-371 (gỡ cùng DEBT-369, đóng DEBT-226), không gỡ trong run này. ⇒ **tester**.
- **2026-10-24 tester (lượt 2, retry cổng audit)**: **FAIL — E2E 34/35** ⇒ trả **frontend-dev**. Chi tiết `test-report.md` § Lượt 2.
  - Xanh: `pnpm audit --audit-level high` exit 0 (6 low / 7 moderate, "1 ignored: 1 high"); root lint, `-r typecheck`; root `pnpm test` (be 416, fe-admin 59 file / 1343, fe-sso-test 269); fe-admin build + `check:bundle` (22 chunk, 0 Function/eval, 0 hit); be build; harness prod valid/badenv fails=0 (CSRF `/_serverFn` 12/12 + logout 4/4 là 403); Chromium prod 0 vi phạm CSP; grep secret 0.
  - Test mới `fe-admin/test/zod-collections.test.ts` (8 test): max 20 ở 5 trường + grantTypes, strict create, 200k phần tử ⇒ 1 issue `too_big`. Đối chứng zod 4.6.5 ⇒ 200001 issue (RED).
  - E2E full 1 lần: `fe-admin.spec.ts:31` FAIL. Chẩn đoán bằng 8 lần chạy riêng spec (instrument tạm, đã khôi phục, sha khớp):
    - (a) Lỗi test: `includes("eyJ")` bắt nhầm audit `nextCursor` (decode ra `{t,e}`, DB E2E có > 10 sự kiện). Tester đã sửa assertion thành regex dạng JWT.
    - (b) 🔴 Lỗi sản phẩm (có từ trước run 51): bấm Sign out khi query dashboard còn đang chạy ⇒ `onError` ⇒ `signInAgain()` ⇒ `location.assign` huỷ POST logout (`ERR_ABORTED`) ⇒ IdP session còn ⇒ đăng nhập lại im lặng. Tái hiện 4/7.
  - Debt mới: DEBT-372 (DB E2E tích luỹ không giới hạn).
- **2026-10-24 frontend-dev (retry 2, race đăng xuất)**: sửa gốc. `query-client.ts` thêm `beginSignOut(queryClient)` (cờ module + `cancelQueries()`, reset khi `pageshow` persisted) và `isSigningOut()`; `signInAgain` return sớm khi cờ bật; `step-up.ts` `startStepUp`/`reauthenticate` cũng bỏ qua (không lưu draft). `SignOutButton` gọi `beginSignOut` rồi `clearIntent` trong `onSubmit`, form POST không bị chặn.
  - Test mới `fe-admin/test/sign-out-race.test.tsx` (3): đối chứng (không đăng xuất ⇒ assign), query + mutation pending ⇒ Sign out ⇒ cả hai trả `unauthenticated` ⇒ `location.assign` 0 lần, submit không `defaultPrevented`, `isFetching` 0, step-up không lưu draft; bfcache restore ⇒ chạy lại. `step-up.test.tsx` bọc provider + reset cờ.
  - Mutation (sha256 khôi phục khớp): bỏ guard `signInAgain` / `reauthenticate` / `startStepUp` / gọi `beginSignOut` / `cancelQueries` / reset pageshow ⇒ 6/6 RED.
  - Verify: fe-admin typecheck/lint OK, test 60 file/1346; build + `check:bundle` (23 file, 22 chunk, 0 eval, 0 hit); root lint, `-r typecheck` exit 0; root test be 416, fe-admin 1346, fe-sso-test 269; `pnpm audit --audit-level high` exit 0 (6 low/7 moderate, 1 ignored high).
  - E2E (:3000/:4000/:5173 trống, không `E2E_REUSE`): `fe-admin.spec.ts` riêng 6 lần liên tiếp `2 passed`; full `pnpm -C e2e e2e` 2 lần `35 passed` (4.0m, 3.9m). Debt mới DEBT-373 (tab khác). ⇒ **senior-reviewer**.
- **2026-10-24 senior-reviewer (vòng 3, retry 2 race đăng xuất + assertion E2E + zod-collections)**: **PASS**, không có 🔴.
  - Đã kiểm: mọi đường `location.assign` tới `/auth/login` đều qua `signInAgain`/step-up và đều được gate. Form logout là POST thuần, không `preventDefault`, CSRF không đổi. `useQueryClient` nằm trong `Wrap` của router. Guard gốc không bị gate (cờ kẹt vẫn fail closed khi điều hướng). Regex JWT đúng mục đích. `zod-collections` đạt.
  - Chạy lại: fe-admin 60 file / 1346 passed, `tsc` exit 0, eslint 4 file sạch.
  - Debt mới: **DEBT-374** (cờ `signingOut` kẹt khi POST không unload trang ⇒ không tự về login và nút "Confirm identity" chết. Đề xuất cờ tự hết hạn). Nit: test bfcache phụ thuộc thứ tự, `includes("eyJ")` còn lại ở E2E.
  - ⇒ **tester** lượt 3.
- **2026-10-24 tester (lượt 3, sau retry 2 race đăng xuất)**: **PASS**. Chi tiết `test-report.md` § Lượt 3.
  - Test mới `fe-admin/test/sign-out-race-guard.test.tsx` (3): 8 query dashboard pending + Sign out ⇒ 0 `location.assign`, form POST không bị chặn; characterisation DEBT-374: cờ kẹt ⇒ `signInAgain` im lặng nhưng guard `__root` vẫn redirect `/auth/login` `reloadDocument` (fail-closed); đối chứng có viewer. Mutation: bỏ guard + `cancelQueries` ⇒ RED (8 lần assign); gate guard gốc ⇒ RED; khôi phục sha khớp.
  - Cổng: fe-admin typecheck/lint OK, test 61 file / 1349; build + `check:bundle` 2 canary (23 file, 22 chunk, 0 eval, 0 hit); `gen:api` không diff; root lint, `-r typecheck` exit 0; root test be 416 / fe-admin 1349 / fe-sso-test 269; audit exit 0 (6 low / 7 moderate, 1 ignored high); harness prod valid/badenv fails=0; Chromium prod 0 vi phạm CSP.
  - E2E (cổng trống, không `E2E_REUSE`): `fe-admin.spec.ts` riêng 5/5 `2 passed`; full 1 lần `35 passed (3.9m)`. Grep secret 0. Debt mới: không. ⇒ orchestrator đóng run.
