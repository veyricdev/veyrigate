# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: — (run 24 đã đóng, `374863d`). Kế tiếp: **run 25** = E2E (T4) + T5; sửa DEBT-101/102 [FE] trước E2E; chạy `pnpm -C be db:sync-indexes` trên DB dev/E2E trước E2E nút B.
- **Vòng lặp (run 24)**: analyst=2, tech-lead=2 (REJECT → PASS), senior=1, tester=1
- **Run vừa đóng**: `24-T3-B6.5-T4` ✅ 5/5 task — BE unit 211 + int 507, FE 187. Xem `runs/24-T3-B6.5-T4/summary.md`.
- **Việc tiếp theo**: T3–T5 (trang & route fe-sso-test, gọi resource thật, security lab) hoặc M5 (B5 federation, B6 admin API). Debt đáng chú ý: DEBT-095 (hai request-id, `x-request-id` chưa validate), DEBT-054/096 (open handles, `--forceExit`).
- **Hạ tầng DEV/E2E (người dùng chỉ định, KHÔNG `compose up` thêm, KHÔNG FLUSH/drop)**: `aegate-mongo`@27017 (DB `sso-idp` dev / `sso-idp-e2e` E2E), `aegate-redis`@6379 (`/1` dev, `/2` E2E; db0 thuộc project khác), `veyrigate-mailpit-1` SMTP@1025/UI@8025. E2E: `pnpm -C e2e e2e`.
- **Hạ tầng test**: BE int `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (`test:int` tự kiểm và báo lệnh `docker start` nếu chưa chạy); FE `pnpm -C fe-sso-test test`. Seed dev: `pnpm -C be db:seed-dev` (cần `DEV_SEED_*` trong `be/.env`); E2E cần `e2e/.env` (`DEV_SEED_PASSWORD`).

## Tiến độ

| Run | Mốc | Nhóm task | Kết quả | Commit |
|---|---|---|---|---|
| [01](runs/01-R1-R2/summary.md)–[04](runs/04-B1.6-B1.10/summary.md) | M0–M1 | R1–R5, B1.1–B1.10 | ✅ 56/56 | `8b75f24`…`1dcb2a8` |
| [05](runs/05-B2.1-B2.3/summary.md)–[08](runs/08-BUG-logout-action/summary.md) | M2 | B2.1–B2.5, BUG login/logout | ✅ 158/158 | `aea2d3f`, `f62426b` |
| [09](runs/09-B3.1-B3.4/summary.md) | M2 | B3.1–B3.4 | ✅ 206/206 | `c813f4b` |
| [10](runs/10-B4.1/summary.md)–[13](runs/13-B4.4/summary.md) | M3–M4 | B4.1, B4.3, B4.2, B4.4 | ✅ 310/310 | `cd15c81`…`c6a8026` |
| [14](runs/14-B4.5/summary.md)–[16](runs/16-B4.7/summary.md) | M4 | B4.5–B4.7 | ✅ 473/473 | `b529c35`…`8613b4f` |
| [17](runs/17-introspect-hardening/summary.md) | M4 | introspect-hardening | ✅ 506/506 | `70842e0` |
| [18](runs/18-consent-session-hardening/summary.md) | M4 | consent-session-hardening | ✅ 531/531 | `46da89a` |
| [19](runs/19-bugfix/summary.md)–[20](runs/20-bugfix/summary.md) | M4 | bugfix (DEBT-059…061) | ✅ 617/617 | `8a58faa`, `08adee8` |
| [21](runs/21-T1-T2/summary.md) | M3 | T1–T2 (+ seed-dev) | ✅ 694/694 | `676cd92` |
| [22](runs/22-X1/summary.md) | M3 | X1 walking skeleton (+ DEBT-076/078/079/080/084/004) | ✅ BE 673 + FE 83 + E2E | `c2cf053` |
| [23](runs/23-bugfix/summary.md) | M3 | bugfix (DEBT-089/090/091/070) | ✅ BE 680 + E2E | `8a36ae4` |
| [24](runs/24-T3-B6.5-T4/summary.md) | M3 | T3 + B6.5 + T4 (+ DEBT-100) | ✅ BE 718 + FE 187 | `374863d` |

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

Xem [backlog.md](backlog.md). Run 22 đóng DEBT-004/076/078/079/080/084/086/087/088; mở 082/083/085/089–092. Run 23 đóng **DEBT-089/090/091/070** (tester); mở DEBT-093/094 (tech-lead), DEBT-095–097 (senior). Run 24 tech-lead mở DEBT-098/099; frontend-dev (smoke Task 3) mở DEBT-100 — **backend-dev (Task 4) ĐÃ ĐÓNG DEBT-100** (gốc: index `consents` cũ sót ở DB dev; fix ops `db:sync-indexes` + int-test repro). Senior mở DEBT-101…106. Giữ mở: DEBT-054 (gỡ `--forceExit`, ngoài phạm vi). E2E (T4)+T5 → run 25 (orchestrator mở sau khi run 24 PASS; **chạy `db:sync-indexes` trên DB dev/E2E trước khi E2E nút B**).