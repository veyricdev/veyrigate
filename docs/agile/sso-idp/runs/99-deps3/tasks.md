# Run 99 — Dependabot PR #22 + #23 (M8, lane deps)

Tiêu chí: dùng được ở production; người dùng ủy quyền "việc nào tự quyết được thì làm" (2026-11-18), "tiếp tục" (2026-11-21). Đọc trước: `STATUS.md`, `plan.md` §12 (D72.x cooldown 14 ngày, D96.1–D96.12, D98.1–D98.14), `runs/98-deps2/{tasks,review-techlead,summary}.md` (run deps trước), `.github/dependabot.yml`, `pnpm-workspace.yaml`, `runbook-deploy.md` §7, `backlog.md` DEBT-694/696/712.

## Ràng buộc
- Hạ tầng chung: KHÔNG compose up / tạo container / FLUSH / drop DB không phải của mình / restart container. Vault test: chỉ `vg-b73-vault` qua `be/test/vault-preflight.mjs` nếu cần.
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret/PEM header. Giá trị trông như secret trong test dựng lúc chạy (gitleaks).
- `pnpm install`/`pnpm view` từ registry npm cho dependency dự án: được phép. `docker pull` image `node:22.23.4-bookworm-slim@<digest mới>` chính thức để build/smoke: được phép. Không `npx`/`dlx` gói lạ. Không `git stash`/checkout (working tree dùng chung).
- Quy tắc 14 ngày (`minimumReleaseAge: 20160`): không dùng bản < 14 ngày tuổi trừ ngoại lệ bảo mật high/critical (runbook-deploy §7).
- Đọc code qua CodeGraph MCP; terminal = Git Bash. Không commit (orchestrator commit).

## T1 [deps] PR #23 — nhóm npm-minor-patch 14 cập nhật
- [x] backend-dev
@nestjs/common/core/platform-fastify/testing 12.3.3 → 12.4.0, @nestjs/config 12.1.0 → 12.1.1, @nestjs/mongoose 12.0.0 → 12.0.1, @nestjs/swagger 12.1.0 → 12.1.1, tailwindcss + @tailwindcss/cli + @tailwindcss/vite 4.3.4 → 4.3.5, @playwright/test 1.64.1 → 1.65.0, @tanstack/react-query 5.106.0 → 5.107.1, lucide-react 1.68.0 → 1.70.0, vite 8.3.5 → 8.3.6 (fe-admin + fe-sso-test).
Tech-lead: kiểm ngày phát hành (≥ 14 ngày), changelog Nest 12.4 (minor: hành vi Fastify adapter/guard/pipe?), Playwright 1.65 (bản browser mới ⇒ `playwright install` cho E2E local), tailwind 4.3.5 (CSS output trang login/consent BE có đổi không — so `be` build CSS). Giữ overrides/pins (router 1.170.42, Start 1.168.61, light-my-request 6.6.0).

## T2 [deps/ops] PR #22 — digest `node:22.23.4-bookworm-slim`
- [x] backend-dev
Digest `4b150b48…` → `5ec23b7c…` ở 4 dòng FROM (`be/Dockerfile`, `fe-admin/Dockerfile`). Tech-lead: xác minh digest mới là index chính thức của tag (`docker buildx imagetools inspect`), lý do làm mới (bản vá Debian), Node vẫn v22.23.4; `.nvmrc`/engines không đổi. Smoke image be (14 check) + fe-admin (18 check) như run 97/98.

## T3 [deps] DEBT-712 — kiểm openapi-typescript hỗ trợ TS 6
- [x] backend-dev
Nếu đã có bản openapi-typescript ≥ 14 ngày tuổi với peer TS 6 ⇒ bump + `gen:api` giống hệt; không có ⇒ ghi chú ngày kiểm vào DEBT-712, không đổi.

## Thứ tự
Tech-lead fold (T1–T3, D99.x cuối file này + `review-techlead.md`) → backend-dev → senior → tester (gate đầy đủ: typecheck/lint, unit be/fe-admin/fe-sso-test, int, E2E 53, X3 42, pentest on/off must 269, mutations 7/7, image smoke be + fe-admin).

## Quyết định tech-lead (D99.x, 2026-11-21) — chi tiết + bằng chứng: `review-techlead.md`

- **D99.1 (T1 #23, áp toàn bộ)**: dùng **nguyên lockfile Dependabot**, không chạy `pnpm add`. Từ gốc repo:
  `git diff origin/develop...origin/dependabot/npm_and_yarn/npm-minor-patch-a73d3f2602 -- be/package.json e2e/package.json fe-admin/package.json fe-sso-test/package.json pnpm-lock.yaml | git apply`
  rồi `pnpm install --frozen-lockfile`. Kỳ vọng: báo "Lockfile passes supply-chain policies". Có `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` ⇒ dừng, báo tech-lead, **không** thêm exclude. Mọi bản đều ≥ 14 ngày, trẻ nhất là react-query 5.107.1 (2026-11-06 23:04Z). Giữ nguyên toàn bộ override/pin (router 1.170.42, Start 1.168.61, `fastify>light-my-request` 6.6.0, seroval, redocly 1.34.20). Không thêm ignore Dependabot.
- **D99.2 (T1, styles.css)**: chạy `pnpm -C be build`. Diff `be/src/public/styles.css` phải chỉ có dòng banner `tailwindcss v4.3.4` ⇒ `v4.3.5`. Commit file tái sinh này. Nếu có rule CSS khác ⇒ dừng, báo tech-lead.
- **D99.3 (T1, Playwright 1.65)**: trước E2E chạy `pnpm -C e2e exec playwright install chromium firefox webkit`. Có breaking liên quan: cookie match RFC 6265, chờ `inert`, accessible name bỏ text không render. E2E/X3 đỏ ⇒ phân loại:
  - (a) test viết sai theo semantics mới: sửa test, ghi lý do;
  - (b) app gửi cookie hoặc host/path sai: là bug app, dừng, báo tech-lead.

  **Cấm** hạ Playwright để né lỗi.
- **D99.4 (T2 #22, áp toàn bộ)**: `git diff origin/develop...origin/dependabot/docker/be/node-image-976c282264 -- be/Dockerfile fe-admin/Dockerfile | git apply`. Kỳ vọng: 4 dòng `FROM` có `@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`. Digest này là index chính thức của tag (docker-node rev `80f02a54`, tạo 2026-11-05), `NODE_VERSION=22.23.4`. `.nvmrc`/`engines` không đổi.
- **D99.5 (T3 DEBT-712, không đổi)**: openapi-typescript `latest` = 7.13.0 (2026-02-11), peer `typescript ^5.x`, chưa có bản mới. Backend-dev chỉ thêm vào cột ghi chú DEBT-712 trong `backlog.md`: "kiểm 2026-11-21 (run 99): vẫn 7.13.0, peer ^5.x — chưa bump". Không đụng `fe-admin/package.json`.
- **D99.6 (gate tester, bắt buộc)**: chạy trên working tree sau D99.1–D99.4.
  - Lockfile: sha256 trước = sau `pnpm install --frozen-lockfile`. `pnpm audit` không có high/critical mới.
  - `pnpm typecheck` ×4, `pnpm lint`.
  - Unit: be 1361, fe-admin 1669, fe-sso-test 269. Nếu số test đổi thì phải giải thích.
  - Build: be (`dist/main.js`), fe-admin (+ `check:bundle` 0 hit), fe-sso-test. `pnpm -C fe-admin gen:api` ⇒ `schema.d.ts` không đổi.
  - Int FULL 2524 (gồm `b74-tester` static traversal: không có 5xx, không lộ file ngoài `public`).
  - E2E 53 (`pnpm -C e2e e2e`), X3 42 (chromium + firefox + webkit), pentest on/off must 269/269, mutations 7/7.
  - Image smoke: build lại `be` + `fe-admin` với digest mới. be 14 check, fe-admin 18 check (như run 97/98). `docker run --rm <img> node -v` ⇒ `v22.23.4`.
  - Vault/drill không bắt buộc (không đổi code key/vault).
  - Sau push: CI 9/9 xanh. Dependabot tự đóng #22/#23.

## D99.7 (orchestrator, sau tester FAIL — thay D99.3 phần Playwright)
- X3 webkit 8/14: lỗi driver Playwright 1.65.0 (`_WKPage._onTargetCreated` assert `!_provisionalPage` khi điều hướng cross-site tới trang có COOP `same-origin`), không phải lỗi app/test (chromium/firefox 28/28). Hướng prod: giữ độ phủ WebKit của ma trận cookie hơn là bản tool mới.
- ⇒ Giữ `@playwright/test` **1.64.1** trong run này (các gói khác của #23 giữ nguyên). `.github/dependabot.yml`: ignore `@playwright/test` versions `["1.65.0"]` (để Dependabot đề xuất 1.65.1+ khi đủ 14 ngày). DEBT-714 💭 [deps/test]: bump Playwright ≥ 1.65.1 từ 2026-11-27, điều kiện X3 webkit 14/14.
- Smoke image be 14 check: để job CI `be-image` (không pull mongo/redis local). Gate lại: frozen-lockfile, typecheck e2e, E2E 53, X3 42 (3 trình duyệt) trên Playwright 1.64.1 (`playwright install` lại browser của 1.64.1).
