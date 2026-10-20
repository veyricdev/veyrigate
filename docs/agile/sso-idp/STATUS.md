# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: — (run 34 đã đóng, `2007080`). Kế tiếp: run 35 = B7.1b lỗi sản phẩm: DEBT-116 (cross-tenant OAuth), 204/205 (tham số lặp), 128/141/144/156.
- **⚠ Người dùng**: `be/.env` dev còn placeholder `your-*` cho `GOOGLE_*`/`GITHUB_*` ⇒ từ run 32 sẽ BẬT provider với credential rác ⇒ đặt 4 biến rỗng (hoặc credential thật).
- **Run vừa đóng**: `34-B7.1` ✅ 4/4 — BE unit 303 + int 827, FE 240, E2E 16; ma trận §14/§15 72/77 có. Xem `runs/34-B7.1/summary.md`.
- **Việc tiếp theo**: sau M6 → M7 hardening (B7.*, T7, X2/X3/X5); A4–A6 fe-admin chờ Q3 (plan §12). Debt đáng chú ý: DEBT-124/143 (super_admin xuyên tenant), DEBT-140 (audit OAuth chưa gắn tenant), DEBT-177, DEBT-095, DEBT-054/096.
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
| [25](runs/25-T5-T4e2e/summary.md) | M3 | T5 lab + T4 E2E (+ DEBT-101/102) | ✅ FE 240 + E2E 12 + BE 211 | `d823b04` |
| [26](runs/26-B6.1-B6.2/summary.md) | M5 | B6.1–B6.2 (+ DEBT-098/105/106/122) | ✅ BE 774 + FE 240 + E2E 12 | `7321765` |
| [27](runs/27-B6.3a/summary.md) | M5 | B6.3a admin API: clients, secrets, resources | ✅ BE 826 + FE 240 + E2E 12 | `b9370c1` |
| [28](runs/28-B6.3b/summary.md) | M5 | B6.3b admin users, families, consents, audit | ✅ BE 868 + FE 240 + E2E 12 | `c9791aa` |
| [29](runs/29-B6.3c/summary.md) | M5 | B6.3c keys + tenants (+ DEBT-125/132/145/154) | ✅ BE 914 + FE 240 + E2E 12 | `dc7704d` |
| [30](runs/30-B6.4/summary.md) | M5 | B6.4 seed (+ DEBT-137/161/163/169/172) | ✅ BE 967 + FE 240 + E2E 12 | `e950419` |
| [31](runs/31-admin-hardening/summary.md) | M5 | admin-hardening (DEBT-167/170/173–176/178) | ✅ BE 1001 + FE 240 + E2E 12 | `a299314` |
| [32](runs/32-B5.1-B5.2/summary.md) | M6 | B5.1–B5.2 federation broker (+ DEBT-030) | ✅ BE 1083 + FE 240 + E2E 12 | `4c36371` |
| [33](runs/33-B5.3-X4/summary.md) | M6 | B5.3 linking + X4 E2E (+ DEBT-184/186/189/191) | ✅ BE 1119 + FE 240 + E2E 16 | `b84fa92` |
| [34](runs/34-B7.1/summary.md) | M7 | B7.1 security matrix + test infra + CI int (+ INV-15 fix) | ✅ BE 1130 + FE 240 + E2E 16 | `2007080` |

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).

## Backlog mở

Xem [backlog.md](backlog.md). Run 22 đóng DEBT-004/076/078/079/080/084/086/087/088; mở 082/083/085/089–092. Run 23 đóng **DEBT-089/090/091/070** (tester); mở DEBT-093/094 (tech-lead), DEBT-095–097 (senior). Run 24 tech-lead mở DEBT-098/099; frontend-dev (smoke Task 3) mở DEBT-100 — **backend-dev (Task 4) ĐÃ ĐÓNG DEBT-100** (gốc: index `consents` cũ sót ở DB dev; fix ops `db:sync-indexes` + int-test repro). Senior mở DEBT-101…106. Run 26 tech-lead mở DEBT-116/117/118; backend-dev đóng DEBT-098/105/106, mở DEBT-119/120; senior mở DEBT-121/122; backend-dev retry 1 đóng DEBT-122; senior lượt 2 mở DEBT-123. Run 27 tech-lead mở DEBT-124…129; backend-dev mở DEBT-130…132; senior mở DEBT-133…135; backend-dev retry 1 đóng DEBT-131/133; senior lượt 2 mở DEBT-136…138; tester đóng DEBT-136, mở DEBT-139. Run 28 tech-lead mở DEBT-140…146 (Task 4 → run 29); backend-dev mở DEBT-147…150; senior mở DEBT-151…153; backend-dev retry 1 đóng DEBT-152; senior lượt 2 mở DEBT-154, chốt hợp đồng DEBT-151; tester mở DEBT-155. Run 29 tech-lead mở DEBT-156…160; backend-dev đóng DEBT-125/132/145/146/154, mở DEBT-161/162; senior mở DEBT-163; tester PASS, không debt mới. Run 30 tech-lead mở DEBT-164…166 (DEBT-143 hoãn, DEBT-127 dời B7.1); backend-dev đóng DEBT-137/161/163, mở DEBT-167/168; senior mở DEBT-169…171; tester FAIL (🔴 seed re-point), xác nhận DEBT-169, mở DEBT-172; backend-dev retry 1 đóng DEBT-169/172, mở DEBT-173; senior lượt 2 mở DEBT-174/175; tester lượt 2 PASS, mở DEBT-176. Run 34 tech-lead mở DEBT-203; backend-dev đóng DEBT-195/199/201/202/004, mở DEBT-204. Run 33 tech-lead mở DEBT-192…194; backend-dev mở DEBT-195/196; senior mở DEBT-197…200. Run 32 tech-lead mở DEBT-182…186; backend-dev đóng DEBT-030, mở DEBT-187/188; senior mở DEBT-189/190; tester PASS, mở DEBT-191. Run 31 tech-lead mở DEBT-177; backend-dev đóng DEBT-167/170/173/174/175/176, mở DEBT-178; senior mở DEBT-179/180; tester PASS, đóng DEBT-178, mở DEBT-181. Run 25 tech-lead mở DEBT-107/108; frontend-dev đóng DEBT-101/102, mở DEBT-109/110/111; senior mở DEBT-112…115. Giữ mở: DEBT-054 (gỡ `--forceExit`, ngoài phạm vi). E2E (T4)+T5 → run 25 (orchestrator mở sau khi run 24 PASS; **chạy `db:sync-indexes` trên DB dev/E2E trước khi E2E nút B**).