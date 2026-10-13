# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: không có (20-bugfix đã đóng, commit `08adee8`). **T1 (scaffold fe-sso-test) chưa làm.**
- **Vòng lặp (run 20)**: analyst=3 (lỗi mạng ×2), tech-lead=2, dev=4, senior=4 (REJECT×3 → PASS, +1 lượt ngoài giới hạn), tester=1
- **Run vừa đóng**: `19-bugfix` ✅ 5/5 task — 555/555 test (unit 141 + int 414). Xem `runs/19-bugfix/summary.md`.
- **Run vừa đóng**: `18-consent-session-hardening` ✅ 5/5 task — 531/531 test (unit 131 + int 400). Xem `runs/18-consent-session-hardening/summary.md`.
- **Việc tiếp theo**: FE — **T1** scaffold fe-sso-test → **T2** OIDC client → **X1** walking skeleton (Playwright). Debt còn mở chủ yếu thuộc B5/B6/B7/deploy.

## Tiến độ

| Run | Mốc | Nhóm task | Kết quả | Commit |
|---|---|---|---|---|
| [01](runs/01-R1-R2/summary.md)–[02](runs/02-R3-R5/summary.md) | M0 | R1–R5 | ✅ 11/11 | `8b75f24`, `4c2104a` |
| [03](runs/03-B1.1-B1.5/summary.md) | M1 | B1.1–B1.5 | ✅ 9/9 | `6d04558` |
| [04](runs/04-B1.6-B1.10/summary.md) | M1 | B1.6–B1.10 | ✅ 45/45 | `1dcb2a8` |
| [05](runs/05-B2.1-B2.3/summary.md) | M2 | B2.1–B2.3 | ✅ 80/80 | `aea2d3f` |
| [06](runs/06-B2.4-B2.5/summary.md) | M2 | B2.4–B2.5 | ✅ 123/123 | `f62426b` |
| [07](runs/07-BUG-login-session/summary.md)–[08](runs/08-BUG-logout-action/summary.md) | M2 | BUG-login-session, BUG-logout-action | ✅ 158/158 | `f62426b` |
| [09](runs/09-B3.1-B3.4/summary.md) | M2 | B3.1–B3.4 | ✅ 206/206 | `c813f4b` |
| [10](runs/10-B4.1/summary.md) | M3 | B4.1 | ✅ 233/233 | `cd15c81` |
| [11](runs/11-B4.3/summary.md) | M3 | B4.3 | ✅ 245/245 | `7bebdb7` |
| [12](runs/12-B4.2/summary.md) | M4 | B4.2 | ✅ 269/269 | `b89ca9e` |
| [13](runs/13-B4.4/summary.md) | M3 | B4.4 | ✅ 310/310 | `c6a8026` |
| [14](runs/14-B4.5/summary.md) | M4 | B4.5 | ✅ 342/342 | `b529c35` |
| [15](runs/15-B4.6/summary.md) | M4 | B4.6 | ✅ 405/405 | `d513348` |
| [16](runs/16-B4.7/summary.md) | M4 | B4.7 | ✅ 473/473 | `8613b4f` |
| [17](runs/17-introspect-hardening/summary.md) | M4 | introspect-hardening (DEBT-037/040/041/043/045/046) | ✅ 506/506 | `70842e0` |
| [18](runs/18-consent-session-hardening/summary.md) | M4 | consent-session-hardening (DEBT-026/027/028/050/051/052) | ✅ 531/531 | `46da89a` |
| [19](runs/19-bugfix/summary.md) | M4 | bugfix (DEBT-059/055/060/001/005) | ✅ 555/555 | `8a58faa` |
| [20](runs/20-bugfix/summary.md) | M4 | bugfix (DEBT-067/029/039/006/007/021/053/061) | ✅ 617/617 | `08adee8` |

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

24 mục mở. Xem [backlog.md](backlog.md). Run 20 đóng DEBT-006/007/021/029/039/053/061/067/068/074; mở DEBT-071–073, 075.
