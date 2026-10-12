# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `18-consent-session-hardening`, cổng: **tester ✅ PASS** → orchestrator đóng run. Tester thêm 3 int test (DEBT-056/057/058) lấp khe senior, mutation chứng minh load-bearing (revert nguyên trạng, KHÔNG sửa code sản phẩm). Full suite: typecheck/lint OK, unit 131 + int 400 = **531** xanh. Xem `runs/18-consent-session-hardening/test-report.md`.
- **Vòng lặp (run 18)**: analyst=1, tech-lead=1 (PASS), dev=2 (retry 1), senior=2 (REJECT → PASS). **Vòng lặp (run 17)**: analyst=1, tech-lead=1 (PASS), dev=1, senior=1 (PASS), tester=1 (PASS)
- **Run vừa đóng**: `17-introspect-hardening` ✅ 4/4 task — 506/506 test (unit 127 + int 379). Xem `runs/17-introspect-hardening/summary.md`.
- **Việc tiếp theo**: orchestrator đóng run 18 (commit code dev + 3 int test tester). Sau đó hoàn tất M3/M4 còn cần T2 (fe-sso-test) + X1, T3–T5.
  Hạ tầng test: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`; full suite = `pnpm test` (unit 131) + `pnpm test:int` (int 400) = **531**.

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
| [16](runs/16-B4.7/summary.md) | M4 | B4.7 | ✅ 473/473 | `8613b4f` |
| [17](runs/17-introspect-hardening/summary.md) | M4 | introspect-hardening (DEBT-037/040/041/043/045/046) | ✅ 506/506 | `70842e0` |

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

43 mục mở (+DEBT-050…053 senior run 17, +DEBT-054 tester run 17, +DEBT-055 tech-lead run 18, +DEBT-059…062 senior run 18; DEBT-056/057/058 đã đóng ở run 18 bởi tester). Xem [backlog.md](backlog.md): DEBT-037/040/041/043/045/046 → introspect-hardening; DEBT-044 → consent-hardening/B7; DEBT-047/048/049 (run 17 tech-lead) → sau; DEBT-039 → B7.1; DEBT-042 → B7; DEBT-026/027 → consent-hardening.
