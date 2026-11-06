# Tasks — run 66 — bump happy-dom 21.0.4 + gỡ ignore chết (M7, lane ops FE)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-369 (từ 2026-11-04: bump `happy-dom` 21.0.1 → 21.0.4 ở `fe-admin` và `fe-sso-test`, gỡ entry `ignoreGhsas` GHSA-834v-8h66-3h79, diff lockfile chỉ đổi happy-dom; override `zod` giữ tới lần bump zod kế tiếp), DEBT-371 (gỡ entry chết GHSA-vfj7-8cjw-p6xm braces `pnpm-workspace.yaml:22-25`, cùng commit; đóng DEBT-226). Bối cảnh: run 51 (`runs/51-A7/`).
>
> Tech-lead: kiểm lại trên registry (`pnpm view happy-dom@21.0.4 time version`, tuổi ≥ 14 ngày, release notes/advisory GHSA-834v đã vá ở 21.0.4; còn advisory mới nào cho 21.0.4 không); kiểm braces advisory vẫn withdraw; xác định có bản 21.0.x mới hơn không (chọn đúng bản theo quy tắc ≥ 14 ngày, trừ ngoại lệ bản sửa bảo mật). Cách chứng minh: `pnpm audit --audit-level high` exit 0 sau khi gỡ cả 2 ignore; diff lockfile chỉ happy-dom (+ deps của nó nếu đổi — liệt kê); `pnpm -C fe-admin test` 1533, `pnpm -C fe-sso-test test` xanh, typecheck/lint; E2E không bắt buộc (happy-dom chỉ dùng trong unit) trừ khi tech-lead thấy cần.
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop `aegate-*`; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `pnpm install` chỉ trong repo (không global), không đổi version pnpm/Node; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` của người dùng (be :4000, fe-sso-test :5173 — `pnpm install` có thể chạm node_modules đang dùng: báo nếu cần người dùng tạm dừng); không commit.

### [x] Task 1 [FE/ops]: DEBT-369 — bump happy-dom 21.0.4 (fe-admin, fe-sso-test), gỡ ignore GHSA-834v-8h66-3h79.
### [x] Task 2 [FE/ops]: DEBT-371 — gỡ ignore chết braces GHSA-vfj7-8cjw-p6xm; đóng DEBT-226.

## § Fold tech-lead (bắt buộc) — 2026-11-06

**Bản chọn: `happy-dom` 21.0.4** (exact pin như hiện tại). Registry (`pnpm view happy-dom time`/`dist-tags`): `latest` = 21.0.4, phát hành 2026-10-20T18:05Z ⇒ 17 ngày tuổi (≥ 14, không cần ngoại lệ); không có 21.0.5+/21.1/22.x. `dependencies` của 21.0.4 giống hệt 21.0.1 (ws, entities, whatwg-mimetype, buffer-image-size, @types/*), `engines.node >=20` (máy dev 22.22.3). GHSA-834v-8h66-3h79: dải lỗi `>=17.0.0 <=21.0.3` ⇒ 21.0.4 đã vá. Braces GHSA-vfj7-8cjw-p6xm: vẫn withdraw (audit không báo nó dù gỡ ignore). Không advisory nào cho 21.0.4.

**Bằng chứng probe (bản sao lockfile + 5 package.json trong scratchpad, KHÔNG chạm repo):**
- Baseline: audit exit 0, "1 ignored: 1 high" (chỉ happy-dom ⇒ entry braces đã chết).
- Gỡ cả 2 ignore, chưa bump: exit 1, 1 high GHSA-834v (happy-dom 21.0.1) ⇒ gate CI hoạt động.
- Bump 21.0.4 + `pnpm install --lockfile-only`: exit 0, `7 low | 13 moderate`, 0 high/critical.

**Điểm sửa chính xác (4 file, không file nào khác):**
1. `fe-admin/package.json:49` — `"happy-dom": "21.0.1"` → `"21.0.4"`.
2. `fe-sso-test/package.json:31` — như trên.
3. `pnpm-workspace.yaml` — trong `auditConfig.ignoreGhsas`, xoá 2 khối comment + 2 entry (braces 4 dòng = DEBT-371, happy-dom 5 dòng = DEBT-369); **giữ** 2 dòng comment chính sách `# \`pnpm audit\` exceptions ...` + `auditConfig:` và đổi thành `  ignoreGhsas: []` (đã probe: exit 0). Lý do giữ khung: `.github/workflows/ci.yml:49` trỏ tới `auditConfig.ignoreGhsas`; ngoại lệ sau này có chỗ đặt. KHÔNG đụng `overrides`/`zod`.
4. `pnpm-workspace.yaml` comment override zod (`... Drop on the next zod bump (DEBT-369).`) → đổi `DEBT-369` thành `DEBT-479` (DEBT-369 đóng; việc gỡ override zod chuyển sang DEBT-479). Giữ file LF (eol=lf).

**Lệnh chuẩn (Git Bash, từ gốc repo, pnpm 12.6.0 — không đổi version pnpm/Node):**
```
pnpm install --lockfile-only          # chỉ ghi lockfile, chưa chạm node_modules
git diff --stat pnpm-lock.yaml        # phải là 11 insertions / 11 deletions
pnpm install --frozen-lockfile        # materialize node_modules (xem rủi ro bên dưới)
pnpm audit --audit-level high         # exit 0, không dòng "ignored"
pnpm -C fe-admin typecheck && pnpm -C fe-admin lint && pnpm -C fe-admin test      # 1533 xanh
pnpm -C fe-sso-test typecheck && pnpm -C fe-sso-test lint && pnpm -C fe-sso-test test   # 269 xanh
```

**Diff lockfile kỳ vọng (đúng 11 dòng đổi, 0 package mới/mất):** importers fe-admin + fe-sso-test: `specifier`/`version` happy-dom 21.0.1→21.0.4 (4) + chuỗi peer của `vitest@5.0.4(...)(happy-dom@21.0.4)(...)` (2); `packages:` khoá `happy-dom@21.0.4` + `integrity sha512-tFm+GaLBgo6o0awHnvHaNoraVo27qJ+2tZEtZ+cIa08hXbeitrxAJajLI05hsUy/2/YTKcUjQYzHe5mCcraLBw==` (2); `snapshots:` khoá `happy-dom@21.0.4` (1), khoá `vitest@5.0.4(...happy-dom@21.0.4...)` (1), `optionalDependencies.happy-dom: 21.0.4` (1). Deps của happy-dom (ws 8.22.0, entities 7.0.1, …) KHÔNG đổi. Khác thế này (vd zod, ws, bất kỳ gói nào khác) ⇒ dừng, `git checkout pnpm-lock.yaml`, báo lại.

**Cách chứng minh (ghi vào báo cáo dev):** `pnpm view happy-dom@21.0.4 time.modified version` + ngày; `git diff --stat` 4 file; `git diff pnpm-lock.yaml` khớp 11 dòng trên; `pnpm audit --audit-level high` exit 0 và output không có "ignored"; `grep -c "GHSA-834v\|GHSA-vfj7" pnpm-workspace.yaml` = 0; `node -e "console.log(require('./fe-admin/node_modules/happy-dom/package.json').version)"` = 21.0.4 (tương tự fe-sso-test); số test fe-admin 1533 / fe-sso-test 269 + typecheck/lint xanh. E2E KHÔNG bắt buộc (happy-dom chỉ là `environment` vitest trong `fe-admin/vitest.config.ts:14`, `fe-sso-test/vite.config.ts:17`; không import trong `src/`; không vào bundle/Docker runtime).

**Rủi ro `pnpm install` khi `pnpm dev` người dùng đang chạy (be :4000, fe-sso-test :5173):** dev server không nạp happy-dom/vitest, nhưng `--frozen-lockfile` sẽ tạo `node_modules/.pnpm/happy-dom@21.0.4` + thư mục vitest có hậu tố peer mới, relink junction `fe-admin|fe-sso-test/node_modules/{happy-dom,vitest}` và có thể prune bản 21.0.1 cũ. Trên Windows có thể EPERM/EBUSY nếu file bị khoá (vitest watch, TS server IDE). Quy tắc: chạy `--lockfile-only` trước (an toàn, không chạm node_modules); khi `--frozen-lockfile` lỗi EPERM/EBUSY ⇒ KHÔNG kill tiến trình, KHÔNG xoá node_modules, dừng lại và báo orchestrator để hỏi người dùng tạm dừng `pnpm dev`/vitest watch rồi chạy lại. Sau install, nếu vite :5173 báo optimize-deps lại thì là bình thường (không restart hộ). Không `pnpm dedupe`/`pnpm update`.

**Đóng debt khi xong:** DEBT-369 (phần happy-dom; phần zod chuyển DEBT-479), DEBT-371, DEBT-226.
