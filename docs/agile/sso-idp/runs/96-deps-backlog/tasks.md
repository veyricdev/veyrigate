# Run 96 — Dependabot PR + dọn backlog (M8, lane ops/docs)

Tiêu chí: dùng được ở production; người dùng ủy quyền "việc nào tự quyết được thì làm" (2026-11-18). Đọc trước: `STATUS.md`, `plan.md` §12 (D72.x Dependabot/cooldown 14 ngày, D83.x deps security, D92.x CI, D96.1–D96.4), `.github/dependabot.yml`, `pnpm-workspace.yaml` (auditConfig, overrides, release-age pins).

## Ràng buộc
- Hạ tầng chung: KHÔNG compose up / tạo container / FLUSH / drop DB không phải của mình / restart container.
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret.
- `pnpm install`/`pnpm update` từ registry npm cho dependency của dự án: được phép trong run này (người dùng ủy quyền). Không `npx`/`dlx` gói lạ.
- Quy tắc 14 ngày (D72.x): không dùng bản phát hành < 14 ngày tuổi trừ ngoại lệ bảo mật có ghi lý do.
- Branch `develop` có branch protection (D96.4): owner push thẳng được (bypass), PR cần 9 check.
- Đọc code qua CodeGraph MCP; terminal = Git Bash.

## T1 [ops/deps] 5 PR Dependabot đang mở
| PR | Nhánh | Nội dung |
|---|---|---|
| #17 (2026-11-16) | `npm-minor-patch-97be499361` | nhóm minor/patch, 38 gói |
| #12 (2026-11-10) | `eslint-10.13.0` | eslint 9.39.5 → 10.14.0 (major, dev) |
| #11 (2026-11-10) | `typescript-7.0.2` | typescript 5.7.3 → 7.0.2 (major, dev) |
| #10 (2026-11-10) | `eslint/js-10.0.1` | @eslint/js 9.39.5 → 10.0.1 (major, dev) |
| #2 (2026-10-24) | `be/npm_and_yarn-0923487b4b` | nhóm `npm_and_yarn` 3 thư mục, 2 cập nhật (thường là security) |

Tech-lead chốt từng PR: áp dụng (toàn bộ / một phần), hoãn có lý do (mở DEBT + cấu hình `ignore` major trong `dependabot.yml` nếu hợp lý), hay đóng. Cách áp dụng: cập nhật trực tiếp trên `develop` bằng pnpm (lockfile nhất quán, giữ overrides/pins), không merge nhánh PR; PR bị thay thế sẽ được orchestrator đóng trên GitHub kèm comment lý do.
AC: be/fe-admin/e2e typecheck + lint + unit xanh; int FULL, E2E, X3 xanh; `pnpm audit --audit-level high` exit 0; supply-chain policy của pnpm OK; image build (CI) xanh.

## T2 [docs] Dọn `backlog.md`
394 dòng chưa đóng (50 🟡, 8 🟢, 141 💭, 195 không gắn mức). Nhiều dòng cũ đã được sửa hoặc trùng (vd. DEBT-408 = DEBT-693 đã đóng run 95).
Việc: với từng dòng mở, kiểm code/tài liệu hiện tại (CodeGraph + grep) và:
- đã xong ⇒ `~~DEBT-N~~ ✅ ĐÓNG (run 96 triage: <bằng chứng file:line hoặc run/commit>)`;
- trùng ⇒ đóng, trỏ sang DEBT còn sống;
- không còn áp dụng (code đã xoá/thiết kế đổi) ⇒ đóng có lý do;
- còn mở ⇒ giữ, gắn mức nếu chưa có (🔴/🟡/💭) theo tiêu chí production.
Không sửa code. Không đóng dòng nào khi không có bằng chứng. Xuất `runs/96-deps-backlog/backlog-triage.md`: bảng tổng (trước/sau theo mức), danh sách đóng kèm bằng chứng, và **top 10 việc còn mở nên làm tiếp** (ưu tiên production).

## Thứ tự
T1 (tech-lead fold → backend-dev → senior → tester) và T2 (một agent triage, chỉ sửa `backlog.md` + file triage) chạy song song. T1 không sửa `backlog.md` (ghi debt mới vào log.md, orchestrator gộp khi đóng run).

## Quyết định T1 (tech-lead, 2026-11-18) — D96.5–D96.12
Bằng chứng chi tiết: `review-techlead.md`. Áp dụng thẳng trên `develop`, không merge nhánh PR.

- **D96.5 (D72 cho dependency bắc cầu)**: trong `pnpm-workspace.yaml`, đổi `minimumReleaseAge: 0` thành `minimumReleaseAge: 20160` (14 ngày) và viết lại comment cho đúng. Thêm `minimumReleaseAgeExclude`, ghi **phiên bản chính xác** và chỉ gồm các ngoại lệ bảo mật đã có trong lockfile mà pnpm còn báo lúc commit. Hôm nay đó là `@nestjs/cli@12.0.12`, `@nestjs/schematics@12.0.13`, `@angular-devkit/core@22.2.6`, `@angular-devkit/schematics@22.2.6`, `@angular-devkit/schematics-cli@22.2.6`, `@fastify/static@10.1.10`, `@isaacs/nonrecursive-glob-match@1.1.0`, `glob@14.0.4`, `minimatch@11.0.5`. Comment ghi: ngoại lệ bảo mật run 83, hết hiệu lực từ 2026-11-20 (DEBT-697). **Cấm** exclude bất kỳ bản nào do Lot A/C mới kéo vào; gặp thì hạ phiên bản. `--frozen-lockfile` (CI và cả 2 Dockerfile) cũng kiểm chính sách này.
- **D96.6 (#17, áp dụng một phần)**: áp 36/38 gói, đúng phiên bản trong PR. **Giữ nguyên** `@tanstack/react-start@1.168.60` và `@tanstack/react-router@1.170.41` (Start 1.168.60 pin chính xác router 1.170.41). Lý do giữ: Start 1.169 đổi `createServerFn().inputValidator` thành `.validator`, và `getResponseHeaders()` giờ trả về **bản sao**. Hệ quả là `append("set-cookie")` và `set("cache-control","no-store")` ở `fe-admin/src/features/auth/viewer.ts` và `src/server/admin-api/instance.ts` sẽ mất âm thầm. Việc migrate (dùng `appendResponseHeader`/`setResponseHeader`, sửa 12 mock test, sửa suy kiểu server fn) chuyển sang **DEBT-694** (🟡, lane FE). Override `zod: 4.6.6` đổi thành `4.6.7` (sửa comment; DEBT-479 vẫn mở). Override seroval giữ nguyên vì Start chưa bump. Override minimatch/glob vẫn cần: typescript-estree 8.72.1 còn `^10.2.2`, jest 30.5.2 còn glob `^13.0.6`.
- **D96.7 (Jest và light-my-request)**: `@nestjs/platform-fastify` 12.3.2 làm `fastify` chuyển sang `light-my-request@6.8.0`, bản này kéo cookie@2 chỉ có ESM, nên `app.inject()` hỏng trong Jest trên Node 22 (33 test unit đỏ). Thêm override `'fastify>light-my-request': 6.6.0` (phát hành 2025-02-17, dùng cookie@1 dạng CJS), phạm vi `fastify>`, có comment. Override chỉ ảnh hưởng đường `inject` của test; runtime Node 22.23 tự `require(esm)` được. Gỡ override khi lên Node ≥ 24.9 hoặc khi Jest hỗ trợ require(esm) trên Node 22 (**DEBT-696** 💭).
- **D96.8 (#12 + #10, áp dụng)**: `eslint@10.14.0` + `@eslint/js@10.0.1` cho be, fe-admin, fe-sso-test. Sửa 8 lỗi do rule mới:
  - `be/src/database/bootstrap.ts:138` và `:460`: thêm `{ cause: err }` (lỗi validator và lỗi ghi stdout, không chứa bí mật).
  - `be/src/database/mongo/mongo.service.ts:48`, `be/src/database/seed.ts:265`, `be/src/modules/keys/vault-transit-key-provider.ts:424`: **KHÔNG** gắn cause. Dùng `// eslint-disable-next-line preserve-caught-error -- <lý do>`, lần lượt: URI Mongo có credential; lỗi dup-key chứa PII; đường dẫn token sink.
  - `fe-sso-test/src/oidc/http.ts:22`: thêm `{ cause: err }`.
  - `fe-admin/src/server/session/store.ts:160` và `fe-sso-test/src/oidc/probe.ts:160`: bỏ phần khởi tạo thừa (`let stored: … ;`, `let status: number;`).
  - Không tắt rule trong config.
- **D96.9 (#11, hoãn)**: TypeScript 7.0.2 không kèm compiler API (`require('typescript')` chỉ trả `{version, versionMajorMinor}`). Thử thật: ts-jest lỗi 15/15 suite; typescript-eslint (peer `<6.1.0`), Nest CLI, ts-node, openapi-typescript (`^5.x`) đều không dùng được; `tsc` báo `TS5102 baseUrl removed`. Ghi **DEBT-695** (💭). Trong `.github/dependabot.yml`, khối npm thêm `ignore: [{dependency-name: typescript, versions: ['>=7.0.0']}]` kèm comment DEBT-695; Dependabot vẫn có thể đề xuất TS 6.x.
- **D96.10 (TanStack trong Dependabot)**: khối npm thêm `ignore` cho `@tanstack/react-start` (`versions: ['>=1.169.0']`) và `@tanstack/react-router` (`versions: ['>1.170.41']`), comment DEBT-694, gỡ khi migrate xong.
- **D96.11 (#2, đóng)**: đã bị thay thế. Repo đã có nodemailer 10.1.7 ≥ 10.1.4 (run 83, `b76b78f`) và happy-dom 21.0.4 (run 66, `eb75eed`); sau Lot A nodemailer lên 10.3.1.
- **D96.12 (đóng PR trên GitHub; orchestrator làm sau khi push và CI xanh)**. Comment khi đóng:
  - #17: "Applied on develop in <commit> except @tanstack/react-start/react-router (breaking server-fn/response-header API, tracked as DEBT-694; ignored in dependabot.yml)."
  - #12 và #10: "Applied on develop in <commit> (eslint 10.14.0 + @eslint/js 10.0.1, new recommended rules fixed)."
  - #11: "Deferred: TypeScript 7 ships no compiler API; ts-jest/typescript-eslint/Nest CLI cannot run (DEBT-695). typescript >=7 ignored in dependabot.yml."
  - #2: "Superseded: nodemailer 10.1.7 (run 83) / happy-dom 21.0.4 (run 66) already on develop."
  - Đóng, không merge; nếu GitHub không tự xoá nhánh Dependabot thì xoá.

### Lệnh cho backend-dev (Git Bash, tại repo root)

**Lot A** (runtime + dev, 1 commit):

1. Sửa `pnpm-workspace.yaml` theo D96.5, D96.6, D96.7.
2. Chạy:

   ```
   pnpm --filter @sso-idp/be add -E @fastify/cookie@11.1.5 @fastify/helmet@13.2.0 @nestjs/common@12.3.2 @nestjs/core@12.3.2 @nestjs/platform-fastify@12.3.2 @nestjs/swagger@12.1.0 @node-rs/argon2@2.2.2 class-validator@0.15.1 eta@4.6.0 nestjs-pino@5.3.1 nodemailer@10.3.1 zod@4.6.7
   pnpm --filter @sso-idp/be add -D -E @jest/globals@30.5.2 @nestjs/testing@12.3.2 @tailwindcss/cli@4.3.4 eslint-config-prettier@10.1.8 eslint-plugin-prettier@5.5.7 jest@30.5.2 pino-pretty@13.2.0 prettier@3.9.10 tailwindcss@4.3.4 ts-jest@29.4.15 typescript-eslint@8.72.1
   pnpm --filter @sso-idp/fe-admin add -E @tanstack/react-query@5.105.3 lucide-react@1.67.0 radix-ui@1.8.1 react@19.3.1 react-dom@19.3.1 zod@4.6.7
   pnpm --filter @sso-idp/fe-admin add -D -E @tailwindcss/vite@4.3.4 @testing-library/user-event@14.6.8 @vitejs/plugin-react@6.2.1 globals@17.14.0 tailwindcss@4.3.4 typescript-eslint@8.72.1 vite@8.3.5 vitest@5.1.0
   pnpm --filter @sso-idp/fe-sso-test add -E react@19.3.1 react-dom@19.3.1 react-router@8.5.1 zod@4.6.7
   pnpm --filter @sso-idp/fe-sso-test add -D -E @vitejs/plugin-react@6.2.1 globals@17.14.0 typescript-eslint@8.72.1 vite@8.3.5 vitest@5.1.0
   pnpm --filter @sso-idp/e2e add -D -E @playwright/test@1.64.1
   pnpm install
   pnpm -C be exec eslint --fix src/common/ops/backup-scripts.spec.ts src/database/admin-recover.ts src/modules/mfa/mfa.service.ts test/federation.int-spec.ts
   ```

   Lệnh `eslint --fix` chỉ chỉnh format theo prettier 3.9; diff phải chỉ có xuống dòng và khoảng trắng.
3. Kiểm tra:
   - `pnpm why -r light-my-request`: `fastify` phải dùng 6.6.0.
   - `pnpm why -r zod`: chỉ có 4.6.7.
   - `pnpm why -r @tanstack/react-start`: 1.168.60.
   - `pnpm audit --audit-level high`: exit 0.
   - `pnpm install --frozen-lockfile`: báo "Lockfile passes supply-chain policies".
   - `pnpm typecheck && pnpm lint && pnpm test`: be 1296, fe-admin 1658, fe-sso-test 269.
   - `pnpm -C be build && pnpm -C fe-admin build`.

**Lot C** (dev-only, commit riêng, làm sau Lot A):

1. Chạy:

   ```
   pnpm --filter @sso-idp/be --filter @sso-idp/fe-admin --filter @sso-idp/fe-sso-test add -D -E eslint@10.14.0 @eslint/js@10.0.1
   pnpm install
   ```

2. Sửa 8 chỗ theo D96.8.
3. Sửa `.github/dependabot.yml` theo D96.9 và D96.10.
4. Chạy lại toàn bộ bước kiểm tra 3 của Lot A; lint phải 0 lỗi.

### Rủi ro cần test (tester)

| Gói | Cần kiểm |
|---|---|
| nodemailer 10.3.1 | test fake-SMTP RCPT TO (run 83: chỉ `EENVELOPE` mới tính là bị từ chối); trần hàng đợi 200 + `sso_mail_dropped_total` (run 95); gửi mail xác minh và đặt lại thật qua Mailpit |
| @fastify/helmet 13.2.0 | header bảo mật (CSP nonce, HSTS, COOP/CORP, Referrer-Policy), qua X3 và bước kiểm header của pentest |
| @fastify/cookie 11.1.5 | cookie `__Host-`, ký cookie, ma trận X3 |
| @nestjs/* 12.3.2 | redirect 303/302 (run 95), exception filter và `no-store`, request id |
| class-validator 0.15 | validate DTO; repo không dùng `IsUUID`/`IsIBAN` (hai validator đổi hành vi) |
| eta 4.6 | auto-escape trong template, qua case XSS của pentest |
| nestjs-pino 5.3 | redaction token và cookie trong log, qua test int về log |
| react 19.3.1, radix 1.8.1, lucide | E2E console |
| @playwright/test 1.64.1 | có thể phải chạy `pnpm -C e2e exec playwright install chromium` (tải từ CDN Playwright; CI tự làm). Chạy local thì hỏi orchestrator trước khi tải |

### Thứ tự gate tester (một lượt trên HEAD đã có Lot A + Lot C)

1. Bằng chứng tĩnh từ backend-dev: typecheck, lint, unit, build, audit, frozen-lockfile.
2. Mailpit trả banner SMTP 220 ở :1025 — kiểm **trước** mọi bước cần thư.
3. int FULL (`pnpm -C be test:int`).
4. E2E (`pnpm -C e2e e2e`).
5. X3.
6. Harness pentest đầy đủ, **chỉ chạy sau E2E**.
7. Push, chờ CI 9/9: gồm `be-image`, `fe-admin-image`, `sbom`; trong Docker, frozen-lockfile và chính sách tuổi được kiểm.

Rút gọn gate:
- Lot C chỉ có: dev-dep, 2 `cause` ở CLI bootstrap, 1 `cause` ở RP test, 2 khởi tạo thừa, các comment disable. Không cần chạy full chain riêng cho Lot C, vì lượt full ở trên đã chạy trên HEAD gồm cả hai lô.
- **Bỏ qua** vault, sentinel và drill rotate/backup: ioredis, jose, mongoose không đổi; `vault-transit-key-provider` chỉ thêm comment.
- Mutation 7/7 vẫn chạy trong step pentest của CI như thường lệ.
