# Test Report — 2026-10-22 — run 41 (A1–A3 fe-admin)

## Kết quả: PASS (fe-admin 96/96; root be 401 + fe-sso-test 269 + fe-admin 96 = 766/766; 0 FAIL)

Phạm vi: thay đổi chưa commit kể từ `c35174d` (`fe-admin/**`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`). Không sửa code sản phẩm; không cài package; không commit.

### Rà trạng thái trước khi chạy (phiên tester trước bị ngắt)
- Bản sao lưu mutation còn trong scratchpad (`r41/mut/orig.sha`: `src/server/env.ts`, `src/components/feedback/route-states.tsx`, `src/routes/index.tsx`) ⇒ `sha256sum -c` **OK cả 3** — không có file sản phẩm nào bị mutate dở. Mã nguồn `src/` khớp mô tả frontend-dev trong `log.md`.
- File test dở của tester trước: `test/env-matrix.test.ts`, `test/check-bundle.test.ts`, `test/ui-extra.test.tsx`, phần "hostile" trong `test/theme.test.ts` — đã đọc lại, giữ nguyên, chạy xanh (case 1).

## Lệnh đã chạy + output thực tế (Git Bash, foreground)

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm i --frozen-lockfile` | rc=0, "Lockfile is up to date, resolution step is skipped" |
| 2 | `pnpm -C fe-admin typecheck` | rc=0 |
| 3 | `pnpm -C fe-admin lint` | rc=0 |
| 4 | `pnpm -C fe-admin test` | rc=0 — `Test Files 7 passed (7)`, `Tests 96 passed (96)` (dev: 21, tester thêm 75 case) |
| 5 | `pnpm -C fe-admin build` (đủ 7 biến, 2 secret là canary ngẫu nhiên 32 hex) | rc=0, `✓ built`, output `dist/client` + `dist/server` |
| 6 | `BUNDLE_CANARIES=<c1>,<c2> pnpm -C fe-admin check:bundle` | rc=0 — `scanned 3 client files for 7 server env names + 2 canaries: 0 hit(s)`; `grep` canary trên toàn `dist/` (cả server) = 0 (env đọc runtime, không inline lúc build) |
| 7 | Mutation M1: `<p data-x="<c1>">` trong `src/routes/index.tsx` → build → check:bundle | rc=1 — `1 hit(s)` `dist\client\assets\routes-*.js: canary #1` (không in giá trị) |
| 8 | Mutation M2: `data-x="ADMIN_API_RESOURCE"` → build → check:bundle | rc=1 — `dist\client\assets\routes-*.js: ADMIN_API_RESOURCE` |
| 9 | Khôi phục `index.tsx` bằng `cp` từ bản sao lưu → `sha256sum -c` | `OK` (dfb59b39…); build lại + check:bundle ⇒ 0 hit |
| 10 | Smoke `pnpm -C fe-admin dev` (:3000 trống, đủ env) + curl | xem bảng smoke dưới; đã dừng đúng cây tiến trình (`cmd /c vite dev` + `node vite.js`), :3000 trống lại |
| 11 | Smoke dev thiếu `OIDC_CLIENT_SECRET` + `SESSION_SECRET=canary-short-…` (31 ký tự) | `GET /` ⇒ `500 text/plain` body `Internal Server Error`; `/nope` ⇒ 500; log: `- OIDC_CLIENT_SECRET: is required` / `- SESSION_SECRET: must be at least 32 characters`; `grep canary-short` log = 0. Đã dừng tiến trình |
| 12 | root `pnpm lint` | rc=0 (fe-admin, fe-sso-test, be: Done) |
| 13 | root `pnpm -r run typecheck` | rc=0 (fe-sso-test, e2e, fe-admin, be) |
| 14 | root `pnpm test` | rc=0 — fe-admin 96/96 (7 files), fe-sso-test 269/269 (31 files), be 401/401 (32 suites) |
| 15 | `pnpm audit --audit-level high` | rc=0 — `2 vulnerabilities found (1 low, 1 moderate)`, `1 ignored: 1 high` = GHSA-vfj7-8cjw-p6xm có sẵn ở `c35174d` (DEBT-226); diff `pnpm-workspace.yaml` chỉ thêm `overrides`, **không thêm ignore** |
| 16 | Parse `.github/workflows/ci.yml` (js-yaml 4.3.2) | OK; jobs `quality,int,e2e,secrets,promtool` (không job mới); `quality` thêm đúng 1 bước sau `Test`: `pnpm -C fe-admin build && pnpm -C fe-admin check:bundle`, không biến/secret |
| 17 | So `pnpm-lock.yaml` với `git show c35174d:pnpm-lock.yaml` (2 document YAML) | importers `.`/`be`/`e2e`/`fe-sso-test` **SAME**; `fe-admin` `{}` → 13 deps + 17 devDeps; packages +159, gỡ 0; snapshot cũ thay đổi 0, gỡ 0 |
| 18 | Mutation trên test tester (sao lưu + sha256, khôi phục `cp`) | T1 `parseTheme` lỏng (lowercase/includes) ⇒ theme.test 6 FAIL; T2 bỏ refine origin `APP_URL` ⇒ env-matrix 6 FAIL; T3 secret `min(31)` ⇒ 2 FAIL; T4 `title={String(error)}` trên `<h1>` lỗi ⇒ ui-extra "not even attributes" FAIL (layout.test cũ vẫn xanh). Khôi phục ⇒ `sha256sum -c` OK 3/3, full suite rc=0 |

Ghi chú mutation đầu tiên (`{"<c1>".length}`) cho 0 hit vì minifier gập thành số — không phải lỗi script, nhưng là giới hạn của lưới chuỗi literal ⇒ DEBT-277 (💭).

### Smoke dev :3000 (đủ env)

| Request | HTTP | `<html>` | Ghi chú |
|---|---|---|---|
| `GET /` | 200 text/html | `lang="en"` (không class ⇒ system) | skip-link có, `<main id="main">`, đúng 1 `aria-current="page"` |
| Cookie `theme=dark` | 200 | `class="dark"` | |
| Cookie `theme=light` | 200 | `class="light"` | |
| Cookie `theme="><script>alert(1)</script>` | 200 | không class | `alert(1)` không xuất hiện trong HTML |
| Cookie `theme=%22%3E%3Cscript%3E…` | 200 | không class | không phản chiếu |
| Cookie `theme=DARK` | 200 | không class | whitelist phân biệt hoa/thường |
| `GET /nope/deeper` | **404** text/html | — | "Page not found", 0 `aria-current` |

Mọi trang: không chứa 2 canary, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `OIDC_ISSUER`. Inline `<script>` duy nhất là stream hydration `$_TSR` của Start (không phải script theme) — đã ghi ở DEBT-269.

## Test FAIL
Không có.

## Coverage acceptance criteria

Task 1 (A1)
- [x] dev :3000 trả HTML `/` rồi dừng đúng tiến trình — case 10
- [x] build/typecheck/lint/test xanh — case 2–5
- [x] không code demo (`find -iname '*demo*'` ngoài node_modules/dist = 0) — kiểm tay
- [x] root `pnpm i --frozen-lockfile`/`lint`/`-r typecheck`/`test` xanh (4 package) — case 1, 12–14
- [x] `pnpm audit --audit-level high` exit 0 không thêm ignore — case 15
- [x] CI: chỉ thêm 1 bước build + check:bundle vào `quality` — case 16
- [x] importers be/fe-sso-test/e2e không đổi so với `c35174d` — case 17

Task 2 (A2)
- [x] đủ biến ⇒ object; thiếu `OIDC_CLIENT_SECRET` ⇒ throw nêu tên — `env.test.ts`, `env-matrix.test.ts` "missing %s" (×7)
- [x] chuỗi rỗng = thiếu (×7, message giống hệt) — `env-matrix` "empty %s"
- [x] URL sai định dạng (×4) nêu tên, không echo giá trị/log — `env-matrix` "malformed %s"
- [x] secret 31 bị từ chối / 32 nhận (cả 2 secret), canary không trong message + `console.error` — `env-matrix` "secrets"
- [x] secret hợp lệ khác không bị echo khi biến khác lỗi — `env-matrix`
- [x] `APP_URL` có path / trailing slash / query / fragment / userinfo / chữ hoa ⇒ từ chối; origin có cổng ⇒ nhận — `env-matrix` "APP_URL is a bare origin"
- [x] production: `http:` (×3) và `javascript:` (×3) ⇒ throw; dev/test giữ `http:` — `env-matrix` "production requires https"
- [x] dev thiếu `OIDC_CLIENT_SECRET` ⇒ log tên biến, `GET /` 500 trơn — case 11
- [x] check:bundle 0 hit với 2 canary — case 6; phát hiện canary/tên biến thật khi cố tình đưa vào bundle — case 7–8; script trên bundle giả (7 tên, canary theo index, entry rỗng, dist thiếu/rỗng, env.ts không parse được) — `check-bundle.test.ts`
- [x] regex tên của check-bundle khớp đúng key schema — `env-matrix` "check:bundle name list stays in sync" (phần 💭 của DEBT-276)

Task 3 (A3)
- [x] layout render nav + main; skip-link focus đầu tiên trỏ `#main` — `layout.test.tsx`; `main` duy nhất, `tabindex=-1`, Tab thứ 2 rời skip-link — `ui-extra.test.tsx`
- [x] `aria-current="page"` đúng 1 mục trên `/`, 0 mục trên 404 — `ui-extra.test.tsx` + smoke
- [x] toggle theme đổi class `dark`, có `aria-label`; mọi button header có tên — `layout.test.tsx`, `ui-extra.test.tsx`
- [x] theme cookie lạ/độc (`"><script>`, encoded, `__proto__`, `DARK`, NUL, 4KB, non-string) ⇒ `system` — `theme.test.ts`; SSR không phản chiếu — smoke
- [x] error component production không lộ message/stack (cả attribute, title) — `layout.test.tsx`, `ui-extra.test.tsx` (mutation T4 chứng minh); retry chạy lại loader — `ui-extra.test.tsx`
- [x] route không tồn tại ⇒ 404 component — `layout.test.tsx`, `ui-extra.test.tsx`, smoke HTTP 404
- [x] build + check:bundle xanh — case 5–6, 9

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Credential (secret) | absent, empty, 31/32 ký tự, giá trị không bao giờ echo | env-matrix, case 11 |
| Input (env) | valid, missing từng biến, malformed URL, scheme lạ, APP_URL có path/query/userinfo | env-matrix |
| Input (cookie theme) | whitelist, injection `"><script>`, encoded, prototype key, oversized, non-string | theme.test, smoke |
| State | env sai ⇒ mọi request 500 (fail-closed, không render trang thiếu secret) | case 11 |
| Exposure | log validate, message lỗi, UI lỗi (text + attribute + title), HTML SSR, bundle client (tên + canary), bundle server (canary) | env-matrix, ui-extra, case 6–8, 11, smoke |
| Dependency/supply chain | frozen install, audit high, importers khác không đổi, CI YAML | case 1, 15–17 |

Không áp dụng ở run 41: identity/authorization/request chain (chưa có đăng nhập — A4). Đã biết, không chặn: DEBT-274 (https phụ thuộc `NODE_ENV` runtime), DEBT-275 (message lỗi dehydrate vào HTML SSR/RPC — chưa có loader nhạy cảm), DEBT-269 (inline script hydration Start, cookie UI chưa `Secure`) — đều bắt buộc ở A4/A7.

## Debt mới
- DEBT-277 (💭): `check:bundle` chỉ khớp chuỗi literal (minifier gập `"x".length`, tên ghép động lọt); lưới chính là import-protection `server-only`.
