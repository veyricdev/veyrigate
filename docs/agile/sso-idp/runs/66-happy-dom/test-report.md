# Test Report — 2026-11-06 (run 66, tester)

## Kết quả: PASS (8/8 case)

Kiểm độc lập trên working tree chưa commit (2 `package.json` happy-dom 21.0.4, `pnpm-workspace.yaml` `ignoreGhsas: []`, `pnpm-lock.yaml` 11+/11−, backlog). Không sửa code/lockfile repo; mutation chỉ trên bản sao trong scratchpad.

## Lệnh đã chạy + output thực tế (Git Bash, gốc repo, pnpm 12.6.0)

| # | Lệnh | Output thực tế |
|---|---|---|
| 1 | `pnpm audit --audit-level high` | exit **0**; `20 vulnerabilities found` / `Severity: 7 low \| 13 moderate`; `grep -ci ignored` = **0** |
| 2a | Mutation (bản sao scratchpad: 5 `package.json` + `pnpm-workspace.yaml` hiện tại với `ignoreGhsas: []`; lockfile = lockfile hiện tại với happy-dom → 21.0.1 + integrity cũ `pRBs…`; `diff` với `git show HEAD:pnpm-lock.yaml` = **giống hệt**; manifest fe-admin/fe-sso-test → 21.0.1) rồi `pnpm audit --audit-level high` | exit **1**; `high … Happy DOM: Incomplete fix for CVE-2026-33943 …` GHSA-834v-8h66-3h79, paths `fe-admin>happy-dom`, `fe-sso-test>happy-dom`, `fe-sso-test>vitest>happy-dom` (4 paths); `Severity: 7 low \| 13 moderate \| 1 high` ⇒ cổng CI còn chặn khi không có ignore |
| 2b | Đối chứng: cùng bản sao, chép lại lockfile + manifest hiện tại | exit **0**, `7 low \| 13 moderate` |
| 3 | `git diff --stat` + `git status --porcelain` → `pnpm install --frozen-lockfile --offline` → lặp lại | install exit 0, `Lockfile is up to date, resolution step is skipped`; `cmp` trước/sau: **SAME** (7 files, 54+/85−) |
| 3b | `node -e "require('./<pkg>/node_modules/happy-dom/package.json').version"` | `fe-admin 21.0.4`, `fe-sso-test 21.0.4` |
| 4a | `pnpm -C fe-admin typecheck` / `lint` / `test` (`vg-test-redis` đã Up @6479, không cần start) | 0 / 0 / 0; `Test Files 66 passed (66)`, `Tests 1533 passed (1533)` |
| 4b | `pnpm -C fe-sso-test typecheck` / `lint` / `test` | 0 / 0 / 0; `Test Files 31 passed (31)`, `Tests 269 passed (269)` |
| 5 | `pnpm exec vitest run test/client-secrets-risk.test.tsx test/users-ui.test.tsx test/clients-ui.test.tsx` ×3 (fe-admin; 3 file component lớn nhất, env mặc định `happy-dom` theo `vitest.config.ts:14`, không file nào override `@vitest-environment`) | 3/3 lượt: `Test Files 3 passed (3)`, `Tests 126 passed (126)` |

E2E: không chạy (không bắt buộc; happy-dom chỉ là `environment` vitest, không vào bundle).

## Test FAIL

Không có.

## Coverage acceptance criteria

- [x] Task 1 / DEBT-369 — happy-dom 21.0.4 ở fe-admin + fe-sso-test, gỡ ignore GHSA-834v — case 1, 3b, 4a, 4b, 5
- [x] Task 1 — diff lockfile chỉ happy-dom/peer vitest — case 2a (đảo ngược chính xác 11 dòng cho ra đúng HEAD lockfile), case 3
- [x] Task 2 / DEBT-371 — gỡ ignore braces, audit high vẫn exit 0, không dòng "ignored" — case 1
- [x] Cổng CI fail-closed còn hiệu lực (không ignore che advisory) — case 2a/2b
- [x] typecheck/lint/test xanh cả hai gói — case 4a, 4b

## Coverage security invariants / risk matrix

Thay đổi chỉ là dependency dev (không chạm trust boundary runtime). Chiều đã kiểm:
- Dependency (advisory còn mở / đã vá): mutation 21.0.1 ⇒ high chặn (exit 1); 21.0.4 ⇒ exit 0 — case 2a/2b, 1.
- State (lockfile/node_modules lệch): `--frozen-lockfile --offline` không đổi gì, node_modules đúng 21.0.4 — case 3/3b.
- Stability (DOM env mới): 3 file component nặng ×3 ổn định — case 5.

Debt mới: không có (backlog giữ 498 dòng).
