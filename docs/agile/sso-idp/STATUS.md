# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `12-B4.2` (Consent) — cổng = **tester PASS** → chờ orchestrator đóng run.
- **Run vừa đóng**: `11-B4.3` ✅ 4/4 cổng — 245/245 test (unit 67 + int 178). Xem `runs/11-B4.3/summary.md`.
- **Vòng lặp (run 12)**: analyst=1, tech-lead=1 (PASS), backend-dev=1 (DONE), senior=1 (PASS), tester=1 (PASS — 269 test: unit 67 + int 202, +5 test; DEBT-027 fail-closed)
- **Việc tiếp theo**: orchestrator đóng run 12 (không commit). Q1/Q4 **ĐÃ CHỐT** (plan §12).
  B4.2 = B4.2a consent store (`user×client×resource`) + B4.2b wire /authorize + trang consent BE + issue code via B4.3.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; PowerShell gọi `pnpm.cmd`.

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q6, Q7–Q9**. Q6 (token TTL) sẽ cần cho **B4.4**. **Q1, Q4 đã chốt**.

## Backlog mở

18 mục — xem [backlog.md](backlog.md).
