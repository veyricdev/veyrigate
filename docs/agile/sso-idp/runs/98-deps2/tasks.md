# Run 98 — Dependabot PR #18–#21 + dọn ngoại lệ release-age (M8, lane deps/BE)

Tiêu chí: dùng được ở production; người dùng ủy quyền "việc nào tự quyết được thì làm" (2026-11-18), "tiếp tục" (2026-11-21). Đọc trước: `STATUS.md`, `plan.md` §12 (D72.x cooldown 14 ngày, D83.x deps security, D96.1–D96.12), `runs/96-deps-backlog/{tasks,review-techlead,summary}.md` (cách làm run deps trước), `.github/dependabot.yml`, `pnpm-workspace.yaml`, `runbook-deploy.md` §7, `backlog.md` DEBT-694/695/696/697/706/711.

## Ràng buộc
- Hạ tầng chung: KHÔNG compose up / tạo container / FLUSH / drop DB không phải của mình / restart container. Vault test: chỉ container thử `vg-b73-vault` theo `be/test/vault-preflight.mjs` (tạo và xoá theo tên chính xác) nếu tech-lead yêu cầu kiểm vault.
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret/PEM header. Giá trị trông như secret trong test dựng lúc chạy (gitleaks).
- `pnpm install`/`pnpm update`/`pnpm view` từ registry npm cho dependency của dự án: được phép (ủy quyền như run 96). Không `npx`/`dlx` gói lạ.
- Quy tắc 14 ngày (`minimumReleaseAge: 20160`): không dùng bản < 14 ngày tuổi (tính tới ngày áp dụng) trừ ngoại lệ bảo mật high/critical theo runbook-deploy §7.
- Đọc code qua CodeGraph MCP; terminal = Git Bash. Không commit (orchestrator commit).

## T1 [deps] 4 PR Dependabot mở 2026-11-19 (DEBT-706)
- [x] backend-dev 2026-11-21 (xem `log.md`)
| PR | Nội dung |
|---|---|
| #18 | nhóm npm-minor-patch 9 gói: @nestjs/common/core/platform-fastify/testing 12.3.2 → 12.3.3, @nestjs/config 12.0.1 → 12.1.0, mongoose 9.11.4 → 9.12.0, @tanstack/react-query 5.105.3 → 5.106.0, @tanstack/react-start 1.168.60 → 1.168.61, lucide-react 1.67.0 → 1.68.0 |
| #19 | jose 5.10.0 → 6.2.15 (major; ký/kiểm JWT, JWKS, Vault Transit) |
| #20 | @fastify/view 11.1.1 → 12.0.1 (major; render trang login/consent/MFA) |
| #21 | typescript 5.7.3 → 6.0.3 (major, dev; bước đệm DEBT-695: `baseUrl`, `moduleResolution`) |

Tech-lead chốt từng PR (áp dụng toàn bộ / một phần / hoãn có DEBT + `ignore` / đóng), kiểm ngày phát hành từng bản (≥ 14 ngày), breaking change thật (changelog + thử), và ràng buộc hiện có (Start 1.168.61 có kéo router > 1.170.41 không — `ignore` D96.10; override `fastify>light-my-request` D96.7). jose chạm đường ký token ⇒ chỉ rõ test bắt buộc (int token/JWKS/rotate, vault, drill rotate local, pentest). Cập nhật trực tiếp trên `develop` bằng pnpm, giữ overrides/pins.

## T2 [deps] DEBT-697 — dọn `minimumReleaseAgeExclude`
- [x] backend-dev 2026-11-21 (xem `log.md`)
9 mục ngoại lệ run 83 hết tác dụng từ 2026-11-20. Xoá các mục pnpm không còn đòi (thử bỏ từng mục với `pnpm install --frozen-lockfile`), cập nhật comment `pnpm-workspace.yaml`.

## T3 [BE] DEBT-711 — cảnh báo `TRUST_PROXY` lúc boot
- [x] backend-dev 2026-11-21 (xem `log.md`)
`NODE_ENV=production` mà `TRUST_PROXY` rỗng ⇒ một dòng warn lúc boot (không boot fail: IdP có thể chạy không sau proxy). Tech-lead chốt nội dung/điều kiện; unit test.

## Thứ tự
Tech-lead fold (T1–T3) → backend-dev (T1 + T2 + T3) → senior → tester (gate đầy đủ như run 96: unit, int FULL, E2E, X3, mutation, harness on/off; thêm vault/drill nếu tech-lead yêu cầu cho jose). Debt mới ghi `log.md`, orchestrator gộp khi đóng run. Đóng PR trên GitHub sau khi CI xanh.

## Quyết định D98.x (tech-lead fold, 2026-11-21)

Bằng chứng chi tiết ở `review-techlead.md`. **PASS**: áp cả 4 PR, có bổ sung phần còn thiếu.
- Mọi bản đích phát hành ≤ 2026-11-04, tức ≥ 14 ngày tuổi.
- Sau khi xoá hết exclude (T2), `--frozen-lockfile` vẫn qua chính sách.

- **D98.1 (T2, DEBT-697)**: xoá **toàn bộ** khoá `minimumReleaseAgeExclude` (9 mục) trong `pnpm-workspace.yaml`, không để khoá rỗng.
  - Đã thử: bỏ cả 9 mục cùng lúc ⇒ `pnpm install --frozen-lockfile` báo "Lockfile passes supply-chain policies", trên cả lockfile HEAD và lockfile sau khi áp 4 PR. Bỏ hết vẫn qua thì không mục nào còn cần ⇒ không phải thử từng mục.
  - Comment phía trên: thay đoạn "Security exceptions from run 83 … (DEBT-697)" bằng "No security exceptions in force (run 98 removed the run-83 ones, DEBT-697). A new one goes in `minimumReleaseAgeExclude:` as an exact `<pkg>@<version>` with GHSA, D-number and expiry date (runbook-deploy §7)."
- **D98.2 (#18, áp dụng, bổ sung router)**: áp 9 gói đúng phiên bản PR, **thêm `@tanstack/react-router` 1.170.41 → 1.170.42**.
  - Lý do: Start 1.168.61 pin chính xác router 1.170.42. Giữ nguyên PR thì fe-admin có 2 bản router.
  - Start 1.168.61 vẫn nằm trước mốc vỡ 1.169. Diff dist: `getResponseHeaders`, `getNormalizedURL`, h3-v2 2.0.1-rc.20 và srvx 0.11.22 đều không đổi.
  - Override seroval, zod và `fastify>light-my-request` giữ nguyên.
  - Mọi bản bắc cầu mới đều ≥ 14 ngày tuổi: `mongodb@7.8.0`, `fastify@5.12.8`, `@fastify/cors@11.4.0`, router-core 1.171.35.
  - `@nestjs/platform-fastify` 12.3.3 vẫn middie 9.3.6 và light-my-request 6.8.0, như 12.3.2.
- **D98.3 (pin DEBT-442)**: trong `fe-admin/test/protocol-relative-risk.test.ts`, đổi `"1.171.34"` → `"1.171.35"` ở cả tên test lẫn `toBe`, không đổi gì khác.
  - Lý do: đây là bước "re-run knowingly". `ssr/ssr-server.js` chỉ thêm export `dehydrateMatch`, thân `getNormalizedURL` giống hệt.
  - Case h3/srvx giữ nguyên và vẫn xanh.
- **D98.4 (`dependabot.yml`)**:
  - Ignore router: `versions: ['>1.170.41']` → `['>1.170.42']`.
  - Comment: "Start 1.168.61 pins router 1.170.42 (run 98, D98.2)".
  - Ignore Start `>=1.169.0` và TypeScript `>=7.0.0` giữ nguyên.
- **D98.5 (#19 jose 6.2.15, áp dụng)**: be, fe-admin và fe-sso-test cùng lên 6.2.15.
  - Breaking change duy nhất trúng repo: `generateKeyPair()` mặc định non-extractable, nên `exportJWK(privateKey)` ném lỗi.
  - Sửa `be/test/federation.int-spec.ts:393` thành `await generateKeyPair('RS256', { extractable: true })`, kèm comment 1 dòng ("jose 6: private key is exported at L2409/L2474").
  - Không cần sửa gì khác. Đã thử thật:
    - `KeyObject` vẫn ký và kiểm được.
    - `calculateJwkThumbprint` ra kết quả giống jose 5, nên kid và token đã phát hành vẫn kiểm được.
    - `createRemoteJWKSet().jwks()` vẫn có (DEBT-445).
    - Lỗi mạng JWKS giờ là `TypeError`, không phải lỗi JOSE ⇒ vẫn 502.
    - jose 6 chỉ có ESM: Jest của be đã chạy ESM; `dist` CJS, drill `require('jose')` và ts-node đều OK nhờ require(esm) của Node 22.23.4.
- **D98.6 (comment jose, không đổi logic)**:
  - `be/src/modules/federation/federation.client.ts:122`: "jose 5.10.0 `runtime/fetch_jwks.js`" → "jose 6 `jwks/remote.js` (fetch; network error => TypeError, non-JOSE => 502; non-200 / non-JSON => bare `ERR_JOSE_GENERIC`)".
  - `providers.ts:50`: "(jose 5.10.0)" → "(jose 6)".
- **D98.7 (#20 @fastify/view 12.0.1, áp dụng, không sửa code)**:
  - Bản 12 thêm squirrelly và resolve engine theo `engine = resolved?.default ?? resolved`. be truyền instance `new Eta(...)`, instance này không có `default` ⇒ hành vi không đổi.
  - `fastify-plugin ^6.0.0` đã có sẵn trong lockfile.
- **D98.8 (#21 TypeScript 6.0.3, áp dụng cho be, fe-admin, fe-sso-test, e2e)**:
  - `be/tsconfig.json`: xoá `"baseUrl": "./"`, thêm `"moduleResolution": "bundler"` ngay sau `"module": "commonjs"`. `dist` sinh ra giống hệt từng byte so với ngầm định.
  - `be/tsconfig.build.json`: thêm `"compilerOptions": { "rootDir": "./src" }`. Thiếu dòng này, `nest build` báo `TS5011`.
  - `fe-admin/tsconfig.json`: xoá `"baseUrl": "."`, giữ `paths`.
  - **Cấm** `ignoreDeprecations`.
  - Đã chạy thật: ts-jest (peer `<7`), typescript-eslint (`<6.1.0`), Nest CLI, ts-node, vite.
  - openapi-typescript 7.13.0 có peer `^5.x` ⇒ chỉ cảnh báo, output `gen:api` giống hệt ⇒ ghi **DEBT-712**.
  - DEBT-695 vẫn mở cho TS 7; ghi chú bước TS 6 đã xong ở run 98.
- **D98.9 (lệnh cho backend-dev; Git Bash, ở repo root; xong bước nào kiểm bước đó)**:
  ```
  # 1. T2 (D98.1) sửa pnpm-workspace.yaml, rồi:
  pnpm install --frozen-lockfile
  # 2. #18 (D98.2-D98.4)
  pnpm --filter @sso-idp/be add -E @nestjs/common@12.3.3 @nestjs/core@12.3.3 @nestjs/platform-fastify@12.3.3 @nestjs/config@12.1.0 mongoose@9.12.0
  pnpm --filter @sso-idp/be add -D -E @nestjs/testing@12.3.3
  pnpm --filter @sso-idp/fe-admin add -E @tanstack/react-query@5.106.0 lucide-react@1.68.0 @tanstack/react-start@1.168.61 @tanstack/react-router@1.170.42
  # 3. #19 (D98.5-D98.6)
  pnpm --filter @sso-idp/be --filter @sso-idp/fe-admin --filter @sso-idp/fe-sso-test add -E jose@6.2.15
  # 4. #20 (D98.7)
  pnpm --filter @sso-idp/be add -E @fastify/view@12.0.1
  # 5. #21 (D98.8) sửa 3 tsconfig, rồi:
  pnpm --filter @sso-idp/be --filter @sso-idp/fe-admin --filter @sso-idp/fe-sso-test --filter @sso-idp/e2e add -D -E typescript@6.0.3
  pnpm install
  ```
  Kiểm cuối:
  - `pnpm why -r` cho từng gói: `@tanstack/react-router` chỉ có 1.170.42, `jose` chỉ có 6.2.15, `typescript` chỉ có 6.0.3; với `light-my-request`, fastify dùng 6.6.0.
  - `pnpm audit --audit-level high`: exit 0.
  - `pnpm install --frozen-lockfile`: báo "passes supply-chain policies".
  - `pnpm peers check`: chỉ còn openapi-typescript/typescript và vite/@types/node (cảnh báo này có từ trước).
  - `pnpm typecheck && pnpm lint && pnpm test`: be 1351 + test T3, fe-admin 1669, fe-sso-test 269.
  - `pnpm -C be build` ra `be/dist/main.js` (không phải `dist/src/`).
  - `pnpm -C fe-admin build && pnpm -C fe-admin check:bundle`.
  - `pnpm -C fe-admin gen:api`: không có diff.
- **D98.10 (cấm)**:
  - Exclude bản mới (gặp bản < 14 ngày ⇒ hạ phiên bản).
  - Start ≥ 1.169, router > 1.170.42, TypeScript ≥ 7.
  - Sửa logic federation/keys.
- **D98.11 (T3, DEBT-711)**: thêm vào `be/src/config/trust-proxy.ts` hàm thuần `trustProxyBootWarning(env: { NODE_ENV?: string; TRUST_PROXY?: string }): string | null`.
  - **Điều kiện**: trả message khi và chỉ khi `NODE_ENV === 'production'` và `TRUST_PROXY` unset hoặc rỗng sau `trim()`. Trả `null` khi `TRUST_PROXY=false` (không phân biệt hoa thường; coi như vận hành đã khẳng định không có proxy), khi có IP/CIDR, hoặc khi không phải production.
  - **Message cố định, không chèn giá trị env**: `TRUST_PROXY is not set in production: req.ip is the TCP peer. Behind a reverse proxy every client shares the proxy IP (per-IP throttles and client-auth caps act globally; the proxy x-request-id is ignored). Set TRUST_PROXY to the proxy IP/CIDR (runbook-deploy §5), or TRUST_PROXY=false if clients connect directly.`
  - `be/src/main.ts`: sau `await configureApp(app)`, trước `listen`, thêm `const warning = trustProxyBootWarning(process.env); if (warning) new Logger('Bootstrap').warn(warning);` (`Logger` của `@nestjs/common`; pino đã gắn trong `configureApp`).
  - Không boot fail, không thêm metric, không sửa `e2e-main.ts`.
- **D98.12 (T3: test và docs)**:
  - Unit `be/src/config/trust-proxy.spec.ts`:
    - production + `TRUST_PROXY` unset / `''` / `'  '` ⇒ message.
    - production + `'false'` / `'FALSE'` / `'10.0.0.0/8'` ⇒ `null`.
    - `development`, `test` hoặc `NODE_ENV` unset, kèm `TRUST_PROXY` unset ⇒ `null`.
    - Message chứa `TRUST_PROXY` và `runbook-deploy §5`.
  - `be/scripts/docker-smoke.sh`: sau khi `vg-be-smoke-ok` healthy, `docker logs vg-be-smoke-ok 2>&1 | grep -c 'TRUST_PROXY is not set in production'` phải đúng `1` (image production, không có `TRUST_PROXY`). Sai thì `fail` với mã kế tiếp.
  - `runbook-deploy.md` §5, bullet "Thiếu/rỗng/`false`": thêm "từ run 98, production mà thiếu/rỗng ⇒ một dòng warn lúc boot; đặt `TRUST_PROXY=false` nếu chắc chắn không có proxy".
- **D98.13 (thứ tự gate tester, một lượt trên HEAD có đủ T1–T3)**:
  1. Bằng chứng tĩnh D98.9 (backend-dev).
  2. Mailpit trả 220 ở :1025.
  3. **int FULL** (`pnpm -C be test:int`). Phủ jose: `token`, `admin-keys`, `run86-key-prepublish`, `runbook-drill`, `federation` (F16 JWKS thật), `demo`/`userinfo` (alg confusion), `b73c`. Phủ cả mongoose 9.12 trên Mongo 7 rs0.
  4. **`pnpm -C be test:vault` (bắt buộc)**: container `vg-b73-vault` theo `be/test/vault-preflight.mjs`, tạo và xoá theo đúng tên. Kỳ vọng 32/32. Lý do: Vault Transit kiểm token và kid bằng jose 6.
  5. **Drill rotate local (bắt buộc)**: `pnpm -C be build && node be/scripts/drills/rotate-drill.mjs --provider local`. Chạy trên DB `vg-drill-*`, Redis 7/8, khoá `~/.vg-drill.lock`; đi qua `require('jose')` (require(esm)) và JWKS warm/cold. Mọi check phải pass.
  6. E2E (`pnpm -C e2e e2e`): mock-google qua ts-node + jose 6 + TS 6.
  7. X3.
  8. Harness pentest on/off, chạy sau E2E: 269/269 `must`, gồm `HYG-ACCESSLOG` (platform-fastify 12.3.3) và XSS/escape (view 12).
  9. Push, CI 9/9: `be-image` (smoke có check warn T3), `fe-admin-image`, `sbom`, mutation 7/7.

  Bỏ qua: sentinel (ioredis không đổi), drill backup/restore, drill rotate vault (bước 4 và 5 đã phủ đường jose).
- **D98.14 (đóng PR trên GitHub; orchestrator làm sau khi push và CI xanh)**:
  - #18: "Applied on develop in <commit>, plus @tanstack/react-router 1.170.42 (react-start 1.168.61 pins that exact router; this PR kept 1.170.41 and would have installed two router copies). dependabot.yml router ignore moved to >1.170.42 (DEBT-694)."
  - #19: "Applied on develop in <commit> (jose 6.2.15 in be, fe-admin, fe-sso-test; one integration test now generates an extractable key, JWK thumbprints/kids unchanged)."
  - #20: "Applied on develop in <commit> (@fastify/view 12.0.1; the Eta instance engine is unaffected)."
  - #21: "Applied on develop in <commit> (TypeScript 6.0.3: baseUrl removed, be moduleResolution bundler, rootDir in be/tsconfig.build.json). typescript >=7 stays ignored (DEBT-695)."
  - Nếu Dependabot đã tự đóng thì thôi. Nếu PR còn mở: comment rồi đóng, không merge.

**DEBT mới**: DEBT-712 (💭 [deps]). openapi-typescript 7.13.0 có peer `typescript ^5.x`, nên cảnh báo peer với TS 6.0.3; output `gen:api` đã kiểm là giống hệt. Bump khi có bản hỗ trợ TS 6 đã ≥ 14 ngày tuổi.

**Đóng khi run PASS**: DEBT-706, DEBT-697, DEBT-711. DEBT-695 vẫn mở, ghi chú bước TS 6 đã xong.
