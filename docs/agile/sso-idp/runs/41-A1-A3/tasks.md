# Tasks — run 41 — A1–A3: fe-admin scaffold + env + UI foundation (M5, lane ADMIN)

> Plan §6 (Phase A, `fe-admin/`, TanStack Start): A1 scaffold, A2 env validation (T3Env, server/client tách bạch — plan mục 1.4), A3 UI foundation. D2 (BFF/confidential — Q3 đã chốt 2026-10-21). Hiện `fe-admin/` chỉ là placeholder (`package.json` script echo). A4 (đăng nhập BFF) → run 42.
>
> Ràng buộc: mọi dependency pin exact, phiên bản phát hành ≥ 14 ngày (DEBT-228: `minimumReleaseAge`), không cài công cụ toàn cục; scaffold qua `npx`/`pnpm dlx` với phiên bản CLI pin cụ thể (tech-lead chốt). Không phá workspace hiện có (fe-sso-test, be, e2e, CI). Cổng :3000 (redirect fe-admin đã seed).

### [x] Task 1 [FE]: A1 — Scaffold TanStack Start
- Theo plan A1 (add-on shadcn, t3env, tanstack-query/form/table, tailwind, pnpm); xoá file `demo.*`; pin phiên bản; tích hợp workspace (scripts `dev`/`build`/`lint`/`typecheck`/`test` thật thay echo; root `pnpm -r` vẫn chạy; CI job quality bao gồm fe-admin).
- **Acceptance**: `pnpm -C fe-admin dev` chạy ở :3000 (kiểm rồi dừng), `build`/`typecheck`/`lint`/`test` xanh; không còn code demo; `pnpm audit --audit-level high` vẫn exit 0.

### [x] Task 2 [FE]: A2 — Env validation
- T3Env: schema server (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_API_BASE`…) / client tách bạch; import `env` một nơi; thiếu biến bắt buộc ⇒ build/start lỗi rõ; `.env.example` placeholder (gitleaks allowlist nếu cần).
- **Acceptance**: test thiếu `OIDC_CLIENT_SECRET` ⇒ lỗi rõ; grep bundle client không chứa tên/giá trị biến server.

### [x] Task 3 [FE]: A3 — UI foundation
- shadcn components theo plan A3, layout sidebar + header, dark mode, trang lỗi/404/loading, cấu trúc `routes/`, `features/`, `components/`, `lib/`; trang `/` placeholder dùng layout; a11y cơ bản.
- **Acceptance**: component test (Vitest) cho layout/nav; a11y focus/aria cơ bản; build xanh.

## Câu hỏi cho tech-lead
- Q-41.1: Phiên bản TanStack CLI/Start/Router/shadcn/Tailwind/T3Env pin cụ thể (≥14 ngày) + cách scaffold không tương tác.
- Q-41.2: Tích hợp workspace + CI (fe-admin vào job quality; E2E chưa cần).
- Q-41.3: Session BFF (A4) sẽ lưu ở đâu — chỉ cần chừa chỗ trong A2 env.

## Fold tech-lead (2026-10-21) — ƯU TIÊN HƠN text ở trên khi mâu thuẫn

### Chung (cả 3 task)
- **F0 Không dùng TanStack CLI / create-start**: dựng tay tối thiểu trong `fe-admin/`. Lý do: CLI 0.x không có README/flag xác minh được cho chế độ không tương tác; sinh range `^`/bản mới nhất, file demo, có thể tự `git init`/install trong repo. Được tham khảo layout Start 1.168.60 từ docs/source package. Lệnh `npx @tanstack/cli@latest ...` ở plan A1 coi như thay bằng fold này (DEBT-268 cập nhật plan).
- **F1 Phiên bản pin exact** (không `^`/`~`). Quy tắc tuổi: phát hành ≤ 2026-10-07 (≥ 14 ngày tại 2026-10-21) **hoặc** trùng đúng bản đã có trong `pnpm-lock.yaml` ở `c35174d` (không thêm tarball mới, dedupe với fe-sso-test).
  - Runtime: `@tanstack/react-start` **1.168.60**, `@tanstack/react-router` **1.170.41** (đúng bản Start 1.168.60 phụ thuộc), `react`/`react-dom` **19.3.0**, `@t3-oss/env-core` **0.13.11**, `zod` **4.6.5**.
  - UI (A3): `tailwindcss` + `@tailwindcss/vite` **4.3.3**, `radix-ui` **1.7.0**, `class-variance-authority` **0.7.1**, `clsx` **2.1.1**, `tailwind-merge` **3.7.0**, `lucide-react` **1.52.0**, `tw-animate-css` **1.4.0**, `sonner` **2.0.8**. shadcn chỉ chạy qua `pnpm dlx shadcn@4.21.3 ...` (không thành dependency); sau mỗi `init`/`add`, đưa mọi dep nó thêm về pin exact theo danh sách này (dep ngoài danh sách ⇒ chọn bản ≤ 2026-10-07, ghi README).
  - Dev (trùng lockfile): `vite` **8.3.4**, `vitest` **5.0.4**, `@vitejs/plugin-react` **6.1.2**, `happy-dom` **21.0.1**, `typescript` **5.7.3**, `@types/react`/`@types/react-dom` **19.3.0**, `@types/node` **22.10.5**, `eslint` + `@eslint/js` **9.18.0**, `typescript-eslint` **8.71.2**, `globals` **17.13.0**, `eslint-plugin-react-hooks` **7.1.1**. Mới: `@testing-library/react` **16.3.3**, `@testing-library/user-event` **14.6.7**.
  - **HOÃN tới lần dùng đầu (YAGNI, không cài ở run 41)**: `@tanstack/react-query` (A5; ứng viên 5.104.1), `@tanstack/react-form` (A5/A6; 1.33.5), `@tanstack/react-table` (A6; 9.2.6 — v9 khác API v8 mà ví dụ shadcn data-table dùng, chốt lại ở A6). Không cài devtools (router/query). Không cài `@tanstack/router-plugin` riêng (plugin Vite của Start đã gồm), không `vite-tsconfig-paths` (dùng `resolve.alias` `@` → `src`). Acceptance A1 "có Query, Form, Table" của plan dời sang A5/A6.
  - **Verify tuổi**: sau mỗi `pnpm i`/`pnpm add`/`shadcn add`, liệt kê package@version MỚI trong diff `pnpm-lock.yaml` (gồm transitive) và tra `time[version]` trên registry (chỉ-đọc); bản < 14 ngày ⇒ hạ bản cha hoặc `overrides`, nếu không được thì ghi lý do vào README + summary. Bảng phiên bản cuối ghi vào `fe-admin/README.md`.
- **F2 Không phá workspace**: `pnpm i --frozen-lockfile` sạch sau khi cập nhật lockfile; kết quả test be/fe-sso-test/e2e không đổi; `pnpm audit --audit-level high` exit 0 **không thêm** `ignoreGhsas` (cần thêm ⇒ dừng, báo tech-lead). Không sửa `minimumReleaseAge` (DEBT-228 riêng). Nếu cài đòi build script mới ⇒ khai báo trong `allowBuilds` (mặc định `false`, `true` chỉ khi cần, ghi lý do).

### Task 1 (A1) — bổ sung
- `fe-admin/package.json`: `"type": "module"`, scripts `dev` (Vite, `server.port: 3000`, `strictPort: true`), `build`, `preview`, `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`). Bỏ toàn bộ script echo.
- Cấu trúc Start tối thiểu: `vite.config.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx`. **`src/routeTree.gen.ts` được commit** (typecheck CI chạy trước build) và nằm trong `ignores` ESLint. `.gitignore` fe-admin: `dist`, `.output`, `.tanstack`, `.nitro`, `.env`, `.env.*` (trừ `.env.example`).
- ESLint flat config sao theo fe-sso-test (giữ `no-console` warn, `no-unused-vars` pattern `^_`).
- **CI (Q-41.2)**: job `quality` tự gồm fe-admin qua `pnpm lint` / `pnpm -r run typecheck` / `pnpm test` — KHÔNG thêm job. Chỉ thêm 1 bước sau `Test`: `pnpm -C fe-admin build && pnpm -C fe-admin check:bundle` (Task 2). Build CI **không** cần biến server nào, không đặt secret ở CI. Job `e2e` không đổi (E2E fe-admin bắt đầu ở A8).
- Acceptance thêm: gốc repo `pnpm i --frozen-lockfile`, `pnpm lint`, `pnpm -r run typecheck`, `pnpm test` xanh (4 package); `git ls-files fe-admin` không có file demo/sample; dev :3000 trả HTML trang `/` rồi dừng đúng tiến trình đã mở (KHÔNG kill tiến trình khác trên :3000 — cổng bận thì báo).
- `fe-admin/README.md`: lệnh chạy, bảng phiên bản (F1), cách deploy production **chưa chốt** (DEBT-264).

### Task 2 (A2) — thay mô tả cũ
- **Một file server env** `src/server/env.ts`: `createEnv` của `@t3-oss/env-core`, `runtimeEnv: process.env`, `emptyStringAsUndefined: true`. **Không tạo client env** tới khi có biến `VITE_*` đầu tiên (hiện chưa có). Chỉ module dưới `src/server/**` (gọi từ handler `createServerFn` / server entry) được import file này.
- Schema (tên theo plan §1.4; text cũ `ADMIN_API_BASE` là sai): `OIDC_ISSUER` (URL), `OIDC_CLIENT_ID` (≥1 ký tự), `OIDC_CLIENT_SECRET` (≥32), `SESSION_SECRET` (≥32 — **Q-41.3**: chỉ chừa biến này cho A4, không thêm biến Redis/store ở run 41, DEBT-265), `ADMIN_API_BASE_URL` (URL), `ADMIN_API_RESOURCE` (URL, resource indicator), `APP_URL` (URL origin, không path/trailing slash). `NODE_ENV === 'production'` ⇒ `OIDC_ISSUER`, `ADMIN_API_BASE_URL`, `APP_URL` bắt buộc `https:`.
- **Thời điểm validate**: runtime khi server khởi động / trước SSR đầu tiên, KHÔNG ở `vite build` (build không cần secret; "build lỗi" ở text cũ bỏ). Import eager env từ server entry ⇒ lỗi xảy ra trước khi render bất kỳ trang nào; env sai ⇒ không trang nào render (HTTP 500 không kèm chi tiết).
- **Exposure**: `onValidationError` tự viết chỉ in tên biến + message (không in giá trị nhận được, không dump object issue); cấm `skipValidation`/`SKIP_ENV_VALIDATION`. `.env.example` đủ 7 biến, secret để **rỗng** (`OIDC_CLIENT_SECRET=`, `SESSION_SECRET=`), URL dev mẫu ⇒ không cần allowlist gitleaks.
- **`check:bundle`** (script trong package): sau build quét toàn bộ asset **client** (đường dẫn output client thực tế của Start 1.168.60, ghi README); fail nếu chứa tên bất kỳ biến server nào ở trên hoặc chuỗi canary truyền qua env `BUNDLE_CANARIES` (tuỳ chọn).
- Acceptance đo được:
  1. Unit (vitest, inject object env, không sửa `process.env` thật): đủ biến hợp lệ ⇒ trả object; thiếu `OIDC_CLIENT_SECRET` ⇒ throw, message chứa `OIDC_CLIENT_SECRET`; `SESSION_SECRET` 31 ký tự dạng `canary-…` ⇒ throw và message + output `console.error` **không** chứa canary; `production` + `OIDC_ISSUER=http://…` ⇒ throw; chuỗi rỗng ⇒ coi như thiếu.
  2. Smoke: build với đủ env, `OIDC_CLIENT_SECRET`/`SESSION_SECRET` là canary ⇒ `check:bundle` (kèm 2 canary) = 0 hit trong asset client.
  3. Smoke: dev/preview thiếu `OIDC_CLIENT_SECRET` ⇒ log nêu tên biến, `GET /` không trả HTML trang (ghi output vào summary).

### Task 3 (A3) — bổ sung
- shadcn: `pnpm dlx shadcn@4.21.3 init` rồi `add` **chỉ component dùng ở run 41**: `button`, `sidebar` (+ phần nó kéo theo), `dropdown-menu` (đổi theme), `sonner`, `skeleton`. Các component còn lại của plan A3 (`input/label/table/dialog/alert-dialog/select/badge/tabs`) add ở task đầu tiên dùng (A5/A6). Không dùng shadcn `form` (gắn react-hook-form; form dùng TanStack Form). Multi-select để A6.
- **Dark mode không dùng `next-themes`** (sửa component `sonner` sinh ra cho khớp): theme lưu cookie (`light|dark|system`), root đọc phía server và đặt class `<html>`; **không inline `<script>`** (giữ CSP nghiêm cho A7, DEBT-266). Giá trị cookie ngoài whitelist ⇒ `system`.
- Root route: `errorComponent` (production: thông báo chung + thử lại, **không render `error.message`/stack**), `notFoundComponent`, `pendingComponent` (skeleton). Layout: skip-link tới `<main id="main">`, `<nav aria-label>`, `aria-current="page"` cho mục đang chọn, nút toggle sidebar/theme có tên truy cập.
- Acceptance đo được (vitest + Testing Library, happy-dom): layout render nav + main; skip-link là phần tử focus được đầu tiên và trỏ `#main`; mục nav hiện tại có `aria-current="page"`; toggle theme đổi class `dark` và có `aria-label`; error component với lỗi chứa canary ở production **không** hiển thị canary; route không tồn tại ⇒ 404 component. `build` + `check:bundle` xanh.

### Trả lời câu hỏi
- **Q-41.1** → F0 + F1 (dựng tay, không CLI; bảng phiên bản trên).
- **Q-41.2** → Task 1 mục CI: script thật là đủ để `pnpm -r` gom; chỉ thêm bước build + `check:bundle` vào job `quality`; chưa E2E.
- **Q-41.3** → chỉ chừa `SESSION_SECRET` (≥32) ở A2. Kiểu lưu session (cookie mã hoá stateless theo D2 hay Redis opaque-ID) chốt ở review A4 theo kích thước cookie (AT+RT+id_token có thể > 4KB) và nhu cầu thu hồi phía server (DEBT-265).
