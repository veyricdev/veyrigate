# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: không có (22-X1 đã đóng, commit `c2cf053`).
- **Vòng lặp (run 22)**: analyst=1, tech-lead=2 (+DEBT-084), BE dev=2, FE dev=1 (3 lượt), senior=1 (PASS), tester=1
- **Run vừa đóng**: `22-X1` ✅ 6/6 task — BE unit 191 + int 482, FE 83, E2E pass (cả nhánh consent). Xem `runs/22-X1/summary.md`. **M3 walking skeleton hoàn tất.**
- **Việc tiếp theo**: dọn debt E2E/log (DEBT-089 log `location` chứa `code`, 090, 091) rồi T3–T5 (trang & route, gọi resource thật, security lab) hoặc M5 (B5 federation, B6 admin API).
- **Hạ tầng DEV/E2E (người dùng chỉ định, KHÔNG `compose up` thêm, KHÔNG FLUSH/drop)**: `aegate-mongo`@27017 (DB `sso-idp` dev / `sso-idp-e2e` E2E), `aegate-redis`@6379 (`/1` dev, `/2` E2E; db0 thuộc project khác), `veyrigate-mailpit-1` SMTP@1025/UI@8025. E2E: `pnpm -C e2e e2e`.
- **Hạ tầng test**: BE int `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (phải `docker start` trước — DEBT-070); FE `pnpm -C fe-sso-test test`. Seed dev: `pnpm -C be db:seed-dev` (cần `DEV_SEED_*` trong `be/.env`).

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

37 mục mở. Xem [backlog.md](backlog.md). Run 22 đóng DEBT-004/076/078/079/080/084/086/087/088; mở 082/083/085/089–092.