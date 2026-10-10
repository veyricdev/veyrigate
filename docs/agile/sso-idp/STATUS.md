# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `15-B4.6` — cổng: **tester PASS** → chờ orchestrator đóng. 405/405 test (unit 94 + int 311; tester +7 int lấp khe fold). Xem `runs/15-B4.6/test-report.md`.
- **Run vừa đóng**: `14-B4.5` ✅ 5/5 task — 342/342 test (unit 80 + int 262). Xem `runs/14-B4.5/summary.md`.
- **Senior run 15**: lượt 1 REJECT (liveness `/introspect`, thiếu test `at+jwt`/`verifyAccessToken`) → lượt 2 **PASS**; 🟡 còn mở → DEBT-040..042. Xem `runs/15-B4.6/review-senior.md`.
- **Vòng lặp (run 15)**: analyst=1, tech-lead=1 (PASS), dev=2 (DONE, DONE retry1), senior=2 (REJECT, PASS), tester=1 (PASS)
- **Vòng lặp (run 14)**: analyst=1, tech-lead=1, dev=3, senior=3 (REJECT, REJECT, PASS), tester=1 (PASS)
- **Việc tiếp theo**: **orchestrator** đóng run 15 (tester PASS). Sau đó B4.7 (logout; DEBT-034/037/038/040/041) → run consent-hardening (DEBT-026/027/028). Hoàn tất M3 cần thêm T2 (fe-sso-test) + X1.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (94) + `pnpm test:int` (311) = **405**.

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

26 mục mở — xem [backlog.md](backlog.md) (run 15 dev đóng DEBT-019/020/033/035/036; còn DEBT-037/038 → B4.7, DEBT-039 → B7.1, DEBT-040/041 → B4.7, DEBT-042 → B7, DEBT-026/027 → consent-hardening).
