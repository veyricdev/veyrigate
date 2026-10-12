# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `16-B4.7`. Cổng: **tester PASS** (lượt 1, 2026-10-12) — orchestrator đóng run. Tester thêm 4 test unit QA (`logout.service.spec`: `verifyHint` fail-closed khi client bị xoá; `frameSrcOrigins` injection-safe CSP sink). Full suite **473/473** (unit 127 + int 346), tsc+lint(src) sạch. Xem `runs/16-B4.7/test-report.md`. 🔴 cuối đã đóng: senior tự chạy mutation đảo `familyRevokedAt`↔`revokedAt` trong `revokeWhere` → đúng 2 test `ordering (INV-11)` FAIL (A nhận 200), đã khôi phục byte-identical. 🟡 lượt 2 đã sửa: validator spec +4 case; POST /logout nhánh no-session fail-open. 🟡 còn lại đã vào backlog: DEBT-043 (mở rộng cho local logout), DEBT-045 (lint chưa phủ `test/`), DEBT-046 (ponytail/nit). Xem `runs/16-B4.7/review-senior.md` (lượt 3).
- **Vòng lặp (run 16)**: analyst=1, tech-lead=1 (PASS), dev=3 (DONE, DONE retry1, DONE retry2), senior=3 (REJECT, REJECT, PASS), tester=1 (PASS)
- **Run vừa đóng**: `15-B4.6` ✅ 4/4 task — 405/405 test (unit 94 + int 311). Xem `runs/15-B4.6/summary.md`.
- **Vòng lặp (run 15)**: analyst=1, tech-lead=1 (PASS), dev=2 (DONE, DONE retry1), senior=2 (REJECT, PASS), tester=1 (PASS)
- **Việc tiếp theo**: **tester** (run 16) → micro-run introspect-hardening (DEBT-037/040/041/043/045/046) → run consent-hardening (DEBT-026/027/028). Muốn hoàn tất M3 còn cần T2 (fe-sso-test) + X1.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (**127**, +4 QA) + `pnpm test:int` (**346**) = **473** (baseline 405 + 68 mới). Race+ordering chạy 3 lần đều 6/6. CHƯA commit.

## Tiến độ

| Run | Mốc | Nhóm task | Kết quả | Commit |
|---|---|---|---|---|
| [01](runs/01-R1-R2/summary.md) | M0 | R1–R2 | ✅ 8/8 | `8b75f24` |
| [02](runs/02-R3-R5/summary.md) | M0 | R3–R5 | ✅ 11/11 | `4c2104a` |
| [03](runs/03-B1.1-B1.5/summary.md) | M1 | B1.1–B1.5 | ✅ 9/9 | `6d04558` |
| [04](runs/04-B1.6-B1.10/summary.md) | M1 | B1.6–B1.10 | ✅ 45/45 | `1dcb2a8` |
| [05](runs/05-B2.1-B2.3/summary.md) | M2 | B2.1–B2.3 | ✅ 80/80 | `aea2d3f` |
| [06](runs/06-B2.4-B2.5/summary.md) | M2 | B2.4–B2.5 | ✅ 123/123 | `f62426b` |
| [07](runs/07-BUG-login-session/summary.md) | M2 | BUG-login-session | ✅ 144/144 | `f62426b` |
| [08](runs/08-BUG-logout-action/summary.md) | M2 | BUG-logout-action | ✅ 158/158 | `f62426b` |
| [09](runs/09-B3.1-B3.4/summary.md) | M2 | B3.1–B3.4 | ✅ 206/206 | `c813f4b` |
| [10](runs/10-B4.1/summary.md) | M3 | B4.1 | ✅ 233/233 | `cd15c81` |
| [11](runs/11-B4.3/summary.md) | M3 | B4.3 | ✅ 245/245 | `7bebdb7` |
| [12](runs/12-B4.2/summary.md) | M4 | B4.2 | ✅ 269/269 | `b89ca9e` |
| [13](runs/13-B4.4/summary.md) | M3 | B4.4 | ✅ 310/310 | `c6a8026` |
| [14](runs/14-B4.5/summary.md) | M4 | B4.5 | ✅ 342/342 | `b529c35` |
| [15](runs/15-B4.6/summary.md) | M4 | B4.6 | ✅ 405/405 | `d513348` |

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

30 mục mở. Xem [backlog.md](backlog.md): DEBT-037/040/041/043/045/046 → introspect-hardening; DEBT-044 → sau DEBT-037; DEBT-039 → B7.1; DEBT-042 → B7; DEBT-026/027 → consent-hardening.
