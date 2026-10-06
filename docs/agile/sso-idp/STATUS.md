# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `09-B3.1-B3.4` (đã xong)
- **Cổng**: tester · **Kết quả**: tester PASS — 206/206 test (67 unit + 139 int), bổ sung 1 test concurrent cho DEBT-021, không có case nghiệm thu thiếu bằng chứng, không blocker mới
- **Vòng lặp**: tech-lead=1, dev=1, senior=1, tester=1
- **Việc tiếp theo**: orchestrator đóng run 09, commit, mở run kế tiếp.

## Tiến độ

| Run | Mốc | Nhóm task | Kết quả | Commit |
|---|---|---|---|---|
| [01](runs/01-R1-R2/summary.md) | M0 | R1–R2 | ✅ 8/8 | `8b75f24` |
| [02](runs/02-R3-R5/summary.md) | M0 | R3–R5 | ✅ 11/11 | `4c2104a` |
| [03](runs/03-B1.1-B1.5/summary.md) | M1 | B1.1–B1.5 | ✅ 9/9 | `6d04558` |
| [04](runs/04-B1.6-B1.10/summary.md) | M1 | B1.6–B1.10 | ✅ 45/45 | `1dcb2a8` |
| [05](runs/05-B2.1-B2.3/summary.md) | M2 | B2.1–B2.3 | ✅ 80/80 | `aea2d3f` |
| [06](runs/06-B2.4-B2.5/summary.md) | M2 | B2.4–B2.5 | ✅ 123/123 | chưa commit |
| [07](runs/07-BUG-login-session/summary.md) | M2 | BUG-login-session | ✅ 144/144 | chưa commit |
| [08](runs/08-BUG-logout-action/summary.md) | M2 | BUG-logout-action | ✅ 158/158 | chưa commit |
| [09](runs/09-B3.1-B3.4/test-report.md) | M2 | B3.1–B3.4 | ✅ 206/206 | chưa commit |

## Chặn / cần người quyết định

Xem `plan.md` §12. Sắp chạm tới: **Q6** (chốt tạm session idle 8h/absolute 30d; token TTL → B4.4), **Q1** (consent → B4.2), **Q4** (→ B4.4/B6.2).

## Backlog mở

11 mục — xem [backlog.md](backlog.md).
