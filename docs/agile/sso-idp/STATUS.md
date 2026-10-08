# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: không có (11-B4.3 đã đóng, commit `7bebdb7`).
- **Run vừa đóng**: `11-B4.3` ✅ 4/4 cổng — 245/245 test (unit 67 + int 178). Xem `runs/11-B4.3/summary.md`.
- **Vòng lặp (run 11)**: tech-lead=1, dev=1, senior=1, tester=1
- **Việc tiếp theo**: **bị chặn bởi quyết định** — B4.2 cần **Q1** (consent semantic), B4.4 cần **Q4**
  (D3 max_age/auth_time, D7 offline_access). Lane khác không chặn: T1, A1–A3 (xem plan §3).
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

Xem `plan.md` §12. Sắp chạm tới: **Q6** (chốt tạm session idle 8h/absolute 30d; token TTL → B4.4), **Q1** (consent → B4.2), **Q4** (→ B4.4/B6.2).

## Backlog mở

16 mục — xem [backlog.md](backlog.md).
