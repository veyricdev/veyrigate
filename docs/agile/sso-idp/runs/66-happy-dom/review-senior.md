# Senior Review — 2026-11-06
## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)
Thay đổi đúng nguyên văn § Fold tech-lead, 5 file (4 file code/cấu hình + backlog), không file nào ngoài phạm vi (bỏ qua `.vscode/mcp.json`, `.mcp.json` của người dùng). Điểm tốt: giữ khung `auditConfig.ignoreGhsas: []` + comment chính sách nên `.github/workflows/ci.yml:48-49` ("Accepted advisories live in pnpm-workspace.yaml auditConfig.ignoreGhsas, each with a reason") vẫn đúng; tách phần zod sang DEBT-479 thay vì để DEBT-369 mở dở; gỡ ignore chết làm gate CI chặt hơn.

Bằng chứng reviewer tự chạy (Git Bash, gốc repo):
- `pnpm view happy-dom@21.0.4 dist.integrity` = `sha512-tFm+GaLB…cUjQYzHe5mCcraLBw==`, khớp từng ký tự với `pnpm-lock.yaml` (khoá `packages:` happy-dom@21.0.4); `time.modified` 2026-10-20T18:05Z (17 ngày, ≥ 14).
- `git diff --numstat pnpm-lock.yaml` = 11/11; 11 dòng đổi đúng danh sách fold: importers fe-admin/fe-sso-test (specifier+version ×2, peer vitest ×2), `packages:` khoá + integrity, `snapshots:` khoá happy-dom, khoá vitest, `optionalDependencies.happy-dom`. Deps của happy-dom (ws, entities, …) không đổi; không gói nào khác.
- `pnpm audit --audit-level high` exit 0 (7 low | 13 moderate), 0 dòng "ignored".
- `pnpm install --frozen-lockfile --lockfile-only --offline` exit 0, lockfile không đổi sau lệnh (vẫn 11/11) ⇒ lockfile nhất quán với 5 package.json + workspace (không chạm node_modules).
- `node_modules/happy-dom` = 21.0.4 ở cả fe-admin và fe-sso-test.
- `pnpm -C fe-sso-test test`: 31 file, 269/269 xanh.
- `grep` toàn repo (trừ docs/node_modules): không còn `GHSA-834v`/`GHSA-vfj7`/`DEBT-369` trong yml/yaml/json/ts/js; `ignoreGhsas` chỉ còn `pnpm-workspace.yaml:21` (`[]`) và comment `ci.yml:49`.
- EOL: `pnpm-workspace.yaml`, 2 `package.json`, `pnpm-lock.yaml` đều LF.

## 🔴 Blocker
- (không)

## Security invariants / trust boundaries đã kiểm
- Không chạm trust boundary runtime: happy-dom chỉ là `environment` vitest (dev), không import trong `src/`, không vào bundle/Docker.
- Supply chain: bản chọn đủ tuổi, integrity khớp registry; danh sách ignore rỗng ⇒ không ignore nào còn che advisory (audit không báo "ignored"); gate CI fail-closed giữ nguyên (`pnpm audit --audit-level high`, không `--ignore-registry-errors`); override zod giữ nguyên (không hạ bảo vệ GHSA-mrhx).
- Lockfile: `--frozen-lockfile` khớp ⇒ CI `pnpm i --frozen-lockfile` sẽ không lệch.

## 🟡 Nên sửa
- (không)

## 💭 Nit
- (không) — dòng "DEBT-369/371 đã tới hạn" trong `STATUS.md` sẽ lỗi thời khi đóng run; orchestrator dọn lúc ghi "Run vừa đóng".

## Backlog
- DEBT-226/369/371 đóng đúng: lý do + bằng chứng ghi trong cột tiêu đề, giữ nguyên nội dung gốc. DEBT-479 hợp lý (phạm vi, điều kiện gỡ override, cách kiểm `zod@` ≥ 4.6.6 + audit). `backlog.md` 498 dòng (497 trước run + DEBT-479), không 🟡 mới từ lượt này.

## ✂️ Ponytail
Diff là xoá cấu hình chết + bump 1 bản patch; `ignoreGhsas: []` giữ có lý do (ci.yml trỏ tới).
Lean already. Ship.
