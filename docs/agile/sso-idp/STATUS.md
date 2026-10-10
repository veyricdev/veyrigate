# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `14-B4.5` — cổng: **tester ✅ PASS** → **orchestrator đóng run** (analyst ✅, tech-lead ✅, dev ✅ retry 2, senior ✅ lượt 3, tester ✅). **342/342 test** (80 unit + 262 int; tester +5 QA). typecheck+lint sạch. Mọi acceptance Task 1–5 + INV-10/11/12/14 có ≥1 test đo được; /revoke RFC 7009 + fail-closed phủ đủ. 🟡 còn mở → DEBT-034..036 (DEBT-035 hoãn B4.6, không chặn). Xem `runs/14-B4.5/test-report.md` + `review-senior.md`. **Code chưa commit.**
- **Run vừa đóng**: `13-B4.4` ✅ 4/4 cổng — 310/310 test (unit 80 + int 230). Xem `runs/13-B4.4/summary.md`.
- **Vòng lặp (run 14)**: analyst=1, tech-lead=1, dev=3, senior=3 (REJECT, REJECT, PASS), tester=1 (PASS)
- **Việc tiếp theo**: orchestrator **đóng run 14** (commit + summary). Sau B4.5: hoàn tất M3/M4 cần thêm T2 (fe-sso-test) + X1.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (80) + `pnpm test:int` (262) = **342**.

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

23 mục — xem [backlog.md](backlog.md) (mới run 14: DEBT-031 device-revoke → B4.7/B6.3, DEBT-032 transaction rotation → B7, DEBT-033 discovery revocation_endpoint → B4.6).
