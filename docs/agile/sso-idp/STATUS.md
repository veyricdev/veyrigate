# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `10-B4.1` (đang mở) — OAuth core `/authorize` (M3 walking skeleton)
- **Cổng**: tester = PASS · 233/233 test (unit 67/67 + int 166/166, trong đó authorize.int-spec.ts
  27/27). Rà soát đủ 9 acceptance criteria (spec §9.2, INV-3/4/14/15) → tester phát hiện 2 gap
  coverage (AC8 `response_type!=code`, AC9 `prompt=none` thiếu test HTTP-level) và tự bổ sung 2
  test (`app.inject`) + 1 assertion `error_description` còn thiếu ở test PKCE-plain có sẵn.
  KHÔNG sửa code production — không có FAIL thật, không có DEBT mới. Xem
  `runs/10-B4.1/test-report.md` (bảng map đủ AC + risk matrix).
- **Vòng lặp**: tech-lead=1, dev=3, senior=3, tester=1
- **Việc tiếp theo**: orchestrator — đóng run 10-B4.1 (PASS tất cả cổng), mở run kế (B4.2 consent
  hoặc B4.3 AuthorizationCode store theo plan.md §B4). Q6/Q1 vẫn mở, không chặn B4.1.

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Sắp chạm tới: **Q6** (chốt tạm session idle 8h/absolute 30d; token TTL → B4.4), **Q1** (consent → B4.2), **Q4** (→ B4.4/B6.2).

## Backlog mở

15 mục — xem [backlog.md](backlog.md).
