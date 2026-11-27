# Run 100 — Dependabot PR #25/#26/#27 + DEBT-714 (M8, lane deps)

Tiêu chí: dùng được ở production; người dùng ủy quyền "việc nào tự quyết được thì làm" (2026-11-18), "tiếp tục" (2026-11-27). Đọc trước: `STATUS.md`, `plan.md` §12 (D72.x cooldown 14 ngày, D96.x, D98.x, D99.1–D99.7), `runs/99-deps3/{tasks,review-techlead,test-report,summary}.md` (run deps trước, lỗi Playwright 1.65.0 WebKit), `.github/dependabot.yml`, `pnpm-workspace.yaml`, `runbook-deploy.md` §7, `backlog.md` DEBT-694/696/712/714.

## Ràng buộc
- Hạ tầng chung: KHÔNG compose up / tạo container / FLUSH / drop DB không phải của mình / restart container. Vault test: chỉ `vg-b73-vault` qua `be/test/vault-preflight.mjs`.
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret/PEM header. Giá trị trông như secret trong test dựng lúc chạy (gitleaks).
- `pnpm install`/`pnpm view` từ registry npm cho dependency dự án: được phép. `pnpm -C e2e exec playwright install …`: được phép. Không `npx`/`dlx` gói lạ. Không `git stash`/checkout (working tree dùng chung).
- Quy tắc 14 ngày (`minimumReleaseAge: 20160`): không dùng bản < 14 ngày tuổi (tính tới lúc áp dụng) trừ ngoại lệ bảo mật high/critical (runbook-deploy §7).
- Đọc code qua CodeGraph MCP; terminal = Git Bash; pnpm 12 không có `-s`. Không commit (orchestrator commit).

## T1 [deps] PR #25 — nhóm npm-minor-patch 13 cập nhật (nhánh `origin/dependabot/npm_and_yarn/npm-minor-patch-8c9e93740b`)
- [x] backend-dev
@nestjs/common/core/platform-fastify/testing 12.4.0 → 12.5.0, jose 6.2.15 → 6.2.17 (be/fe-admin/fe-sso-test — đường ký/kiểm token), mongoose 9.12.0 → 9.12.1, nodemailer → 10.5.0, prettier 3.9.10 → 3.10.1 (định dạng có thể đổi ⇒ lint/format), typescript-eslint 8.72.2, lucide-react 1.72.0, @testing-library/user-event 14.6.10, @vitejs/plugin-react 6.3.0, vite 8.3.8. Tech-lead: ngày phát hành, changelog Nest 12.5, jose 6.2.16/17 (gate vault + drill rotate local như D98.13?), prettier 3.10 có đổi format file nào không.

## T2 [deps/BE] PR #26 — `@fastify/formbody` 8.0.2 → 9.0.1 (major)
- [x] backend-dev
Parse body form của login/consent/MFA/token. Tech-lead: breaking (parser mặc định, `bodyLimit`, xử lý key trùng/`__proto__`), yêu cầu peer fastify, có cần sửa code đăng ký plugin; test bắt buộc (int token/login form, pentest).

## T3 [deps] PR #27 — `@types/node` 22.10.5 → 26.6.6
- [x] backend-dev
Runtime là Node 22.23.4 ⇒ types phải theo major 22. Tech-lead chốt: đóng PR + `dependabot.yml` ignore `@types/node` `>=23` (hoặc update-types major), có thể bump trong major 22 nếu bản mới ≥ 14 ngày.

## T4 [deps/test] DEBT-714 — Playwright ≥ 1.65.1
- [x] backend-dev
Nếu 1.65.1 (hoặc bản 1.65.x mới hơn) đã ≥ 14 ngày: bump `e2e`, `playwright install`, X3 webkit phải 14/14 (+ E2E 53); xanh ⇒ gỡ ignore `1.65.0` trong `dependabot.yml`, đóng DEBT-714. Đỏ ⇒ giữ 1.64.1, ghi kết quả vào DEBT-714.

## Thứ tự
Tech-lead fold (T1–T4, D100.x cuối file này + `review-techlead.md`) → backend-dev → senior → tester (gate đầy đủ như D99.6 + phần tech-lead thêm).

## Quyết định tech-lead (D100.x, 2026-11-27) — chi tiết + bằng chứng: `review-techlead.md`

- **D100.1 (T1 #25, áp toàn bộ)**: dùng **nguyên lockfile Dependabot**. Từ gốc repo:
  `git diff develop...origin/dependabot/npm_and_yarn/npm-minor-patch-8c9e93740b -- be/package.json fe-admin/package.json fe-sso-test/package.json pnpm-lock.yaml | git apply`
  rồi `pnpm install --frozen-lockfile`. Kỳ vọng: "Lockfile passes supply-chain policies" (tech-lead đã thử trên worktree). Có `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` ⇒ dừng, báo tech-lead, **không** thêm exclude. Bản trẻ nhất là Nest 12.5.0 (2026-11-12 13:14Z). Giữ nguyên mọi override/pin, không thêm ignore. Prettier 3.10.1 không đổi format file nào (`prettier --check` sạch), nên không chạy `--write`.
- **D100.2 (T2 #26, đóng PR, gỡ gói)**: be **không dùng** `@fastify/formbody`. Không file nào import nó. Form do `@nestjs/platform-fastify` tự parse (`registerUrlencodedContentParser` + `fast-querystring`). Commit `f62426b` đã bỏ lệnh đăng ký trùng (app không boot) nhưng còn sót gói. Xoá dòng `"@fastify/formbody": "8.0.2",` khỏi `be/package.json`, **không** nâng lên 9. Lockfile chỉ được mất `@fastify/formbody@8.0.2` + `fastify-plugin@5.1.0` (formbody 9.0.1 vẫn còn, là dependency khai báo của platform-fastify). Không sửa code, không cần ignore: Dependabot tự đóng #26 khi gói không còn trong manifest.
- **D100.3 (T1, Nest 12.5 chặn `__proto__` trong form)**: với 12.5.0, body urlencoded có key `__proto__` trả 400 `invalid_request` "Object contains forbidden prototype property". Trước đó key này bị bỏ qua. Chấp nhận. Backend-dev thêm **2 case int âm** để khoá hành vi:
  - (a) `token.int-spec.ts`: `POST /token`, body hợp lệ + `&__proto__=x` ⇒ 400, JSON `error=invalid_request`, `Cache-Control: no-store`, không 5xx, không có token trong body.
  - (b) route form HTML (POST `/login`, có CSRF hợp lệ; chọn file int đang test login form, ví dụ `b74-tester.int-spec.ts`): thêm `__proto__=x` ⇒ 4xx (không 5xx), body không chứa stack/`at `/giá trị password, không `Set-Cookie` phiên. Body là JSON OAuth hay trang HTML lỗi đều chấp nhận, ghi kết quả thực tế vào test.

  Nếu (b) trả 5xx thì dừng, báo tech-lead. int FULL kỳ vọng 2524 + 2 = **2526**.
- **D100.4 (T3 #27, đóng PR, bump trong major 22)**: runtime là Node 22.23.4 nên types phải theo major 22.
  - `.github/dependabot.yml` (npm `ignore`): thêm `- dependency-name: '@types/node'` + `update-types: ['version-update:semver-major']`, kèm comment "Run 100 (D100.4): types follow the Node runtime major (22.x, .nvmrc/engines). Bump the major with the Node image migration." Mục này không có DEBT: nó gắn với quyết định đổi major Node, đã nằm trong ignore docker `node` major.
  - Bump `@types/node` **22.10.5 → 22.20.5** (2026-10-01; 22.20.6/22.20.7 ngày 2026-11-25 chưa đủ 14 ngày) ở `be`, `fe-admin`, `fe-sso-test`, `e2e` `package.json`. Lockfile chỉ đổi chuỗi peer + `undici-types@6.21.0`. Đã thử: typecheck ×4, lint, be unit 1361 và build đều xanh.
- **D100.5 (T4 DEBT-714, hoãn)**: `playwright-core@1.65.1` phát hành 2026-11-13T**21:36:08Z** (`@playwright/test` 21:12Z, `playwright` 21:15Z), nên chỉ đủ 14 ngày từ **2026-11-27T21:36:08Z**. Tại thời điểm review (02:07Z) frozen-lockfile sẽ fail, và không có ngoại lệ bảo mật. Giữ `@playwright/test` 1.64.1 và ignore `1.65.0`. Backend-dev chỉ cập nhật ghi chú DEBT-714 trong `backlog.md`: "run 100: 1.65.1 đủ tuổi từ 2026-11-27T21:37Z (playwright-core 21:36:08Z); chưa có 1.65.2; để run deps sau / Dependabot PR". **Không** gộp vào run này, kể cả khi gate kết thúc sau 21:37Z (giữ phạm vi gate cố định).
- **D100.6 (thứ tự áp dụng kết hợp; #25 và #26/#27 cùng sửa lockfile nên KHÔNG `git apply` diff của #26/#27)**:
  1. D100.1 (`git apply` lockfile #25 + `pnpm install --frozen-lockfile`).
  2. Sửa tay `package.json` theo D100.2 và D100.4, rồi `pnpm install` (không frozen) để tái sinh lockfile.
  3. `pnpm install --frozen-lockfile` lần nữa ⇒ phải pass policies. `git diff` của `pnpm-lock.yaml` so với lockfile #25 chỉ gồm: formbody 8.0.2/fastify-plugin 5.1.0 bị xoá, `@types/node` 22.10.5 → 22.20.5 (+ peer string), `undici-types@6.21.0`. Có gì khác ⇒ dừng, báo.
  4. Sửa `dependabot.yml` (D100.4) và ghi chú DEBT-714 (D100.5).
- **D100.7 (gate tester, một lượt trên working tree sau D100.1–D100.6)**:
  - Lockfile: sha256 trước = sau `pnpm install --frozen-lockfile`. `pnpm audit --audit-level high` exit 0.
  - `pnpm typecheck` ×4, `pnpm lint`, `pnpm -C be exec prettier --check "src/**/*.ts" "test/**/*.ts"`.
  - Unit be 1361, fe-admin 1669, fe-sso-test 269.
  - Build: be (`dist/main.js`, `styles.css` không đổi), fe-admin (+ `check:bundle` 0 hit), fe-sso-test. `gen:api` ⇒ `schema.d.ts` không đổi.
  - **Int FULL 2526** (gồm 2 case D100.3; `b74-tester` traversal; `token`, `admin-keys`, `run86-key-prepublish`, `runbook-drill`, `federation`, `b73c` phủ jose 6.2.17 + Nest 12.5; Mailpit 220 trước khi chạy, phủ nodemailer 10.5).
  - **`pnpm -C be test:vault` 32/32 (bắt buộc, jose đổi)**: chỉ `vg-b73-vault` qua `be/test/vault-preflight.mjs`.
  - **Drill rotate local (bắt buộc)**: `pnpm -C be build && node be/scripts/drills/rotate-drill.mjs --provider local`, mọi check pass (DB `vg-drill-*`, Redis 7/8, khoá `~/.vg-drill.lock`).
  - E2E 53, X3 42 (chromium + firefox + webkit) trên Playwright **1.64.1**. Không `playwright install` bản mới. Nếu browser của 1.64.1 đã có thì không cần cài lại.
  - Pentest on/off must 269/269 (`HYG-ACCESSLOG`, header/CSRF/traversal cho Nest 12.5 middleware matching). Mutations 7/7.
  - Image smoke: để job CI `be-image` (14 check) và `fe-admin-image` (18 check). Không pull mongo/redis local.
  - Bỏ: sentinel (ioredis không đổi), drill backup/restore, drill rotate vault.
  - Sau push: CI 9/9 xanh.
- **D100.8 (đóng PR trên GitHub; orchestrator làm sau push + CI xanh)**:
  - #25: tự đóng khi develop có đủ bản. Nếu không tự đóng, comment "Applied on develop in <commit>."
  - #26: "@fastify/formbody was an unused direct dependency (Nest's Fastify adapter parses urlencoded bodies itself); removed from be in <commit>." Đóng nếu Dependabot chưa tự đóng.
  - #27: "Runtime is Node 22 (.nvmrc/engines), so @types/node stays on 22.x (bumped to 22.20.5 in <commit>). Majors ignored in dependabot.yml until the Node runtime migration." Đóng.
