# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `20-bugfix` — cổng: **tester PASS** (617/617: unit 175 + int 442; tsc 0, eslint 0). **CHƯA commit** → orchestrator đóng run rồi commit. Scaffold fe-sso-test vẫn chưa làm (FE sau).
- **Vòng lặp (run 20)**: analyst=1, tech-lead=2 (PASS, PASS retry 1) + orchestrator chốt retry 3 (bỏ hop count), backend-dev=4 (lượt 1, retry 1/2/3), senior-reviewer=4 (REJECT ×3, PASS lượt 4)
- **Run vừa đóng**: `19-bugfix` ✅ 5/5 task — 555/555 test (unit 141 + int 414). Xem `runs/19-bugfix/summary.md`.
- **Run vừa đóng**: `18-consent-session-hardening` ✅ 5/5 task — 531/531 test (unit 131 + int 400). Xem `runs/18-consent-session-hardening/summary.md`.
- **Việc tiếp theo**: **orchestrator** đóng run 20 (tester PASS 617/617; xem `runs/20-bugfix/test-report.md`) rồi commit. Tester xác minh 5 task [BE] qua code+test thật: reserve/refund atomic song song, 429 đúng ở /token+/revoke+/introspect, không khoá client hợp lệ ở IP khác (f), 429 không consume code, Redis→500, TRUST_PROXY qua FastifyAdapter+proxy-addr thật, DEBT-067 audit, key rotate atomic, insertNextVersion+unique index. Đóng **DEBT-074** (comment-only). Còn mở **DEBT-075** (`/introspect` 429 thiếu `error_description`, tech-lead hoãn — không chặn). Rồi FE: scaffold fe-sso-test → T2 → X1.

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

33 mục mở (run 20: tech-lead mở DEBT-071/072/073; senior mở DEBT-075; **tester đóng DEBT-074**). Xem [backlog.md](backlog.md). Run 19 đóng DEBT-001/003/005/055/059/060/065/066; mở DEBT-063/064/067–070.
