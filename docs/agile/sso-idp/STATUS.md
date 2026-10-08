# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `13-B4.4` — cổng: **tester PASS** → chờ orchestrator đóng run. 4/4 cổng.
- **Run vừa đóng**: `12-B4.2` ✅ 4/4 cổng — 269/269 test (unit 67 + int 202). Xem `runs/12-B4.2/summary.md`.
- **Vòng lặp (run 12)**: analyst=1, tech-lead=1, dev=1, senior=1, tester=1
- **Vòng lặp (run 13)**: analyst=1, tech-lead=1, dev=2, senior=2 (REJECT→PASS), tester=1
- **Việc tiếp theo**: orchestrator đóng run 13-B4.4 (viết summary.md, mở run kế). Tester PASS: build+typecheck+lint sạch; unit 80/80; int 230/230 (token 24/24, +1 QA Task1-fold legacy `/token`). Xem `runs/13-B4.4/test-report.md`.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (80) + `pnpm test:int` (230) = 310.

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

20 mục — xem [backlog.md](backlog.md) (mới: DEBT-029 rate-limit `/token` → B7, DEBT-030 amr/acr → B5).
