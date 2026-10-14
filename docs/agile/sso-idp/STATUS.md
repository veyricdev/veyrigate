# Status — sso-idp

> File duy nhất mọi agent đọc đầu tiên. Ghi đè, giữ ≤ 40 dòng.

- **Run hiện tại**: `22-X1` — cổng: **tester PASS** (2026-10-14): 0 FAIL; đóng DEBT-086/087/088 (test, verified RED). Còn mở 089/090/091/092 (cần sửa code/config sản phẩm).
- **Vòng lặp (run 22)**: analyst=1, tech-lead=2, senior=1, tester=1
- **Việc tiếp theo**: **orchestrator** đóng run 22-X1. Tester đã chạy thật: BE typecheck/lint sạch, unit **191**, int **482** (478→482, +4 test); FE 83/build ✓; E2E `pnpm -C e2e e2e` **1 passed (37.3s)** + nhánh consent **1 passed (28.7s)** trên DB tạm mới `sso-idp-e2e-consent-20261014125425` + Redis `/3` (no flush/drop). Xem `runs/22-X1/test-report.md`.
- **Run vừa đóng**: `21-T1-T2` ✅ 4/4 task — 694/694 test (FE 67 + BE unit 175 + int 452).
- **Tiến độ run 22**: T1 ✅ · T2 ✅ (83 test) · T3 ✅ (`e2e/` + Playwright webServer chain) · T6 ✅ (DEBT-084 đóng) · **T4 ✅** (`pnpm -C e2e e2e` ×3 liên tiếp: 1 passed mỗi lần, 28.7/27.7/28.8s, token không lộ) · **T5 ✅** (CI job `e2e` thật: Mongo single-node + Redis service, env giả trong job, `--with-deps chromium`, `retries:0`, upload report khi fail; YAML hợp lệ). DEBT-081 hoãn.
- **✅ DEBT-084 (T6)**: CSP `form-action` theo từng response — `be/src/common/http/csp.ts` (`buildCsp` byte-identical global helmet 8 + `safeCspOrigin` fail-closed), `peek()` không consume/gia hạn TTL (INV-084-3), `/login`+consent+`/logout` thêm origin URI đã exact-match; comment DEBT-015 sửa. Verify: unit 191, int 478 (23 suite), **E2E `pnpm -C e2e e2e` 1 passed (53.6s), không còn "violates form-action"**; mutation A/B RED→khôi phục byte-identical. 10/10 acceptance.
- **Đã chốt run 22**: Q-X1-a `e2e/` riêng; Q-X1-b `DEV_SEED_*` (không tái dùng admin, cấm trùng `ADMIN_SEED_EMAIL`); Q-X1-c dev = Mongo `sso-idp` + Redis `/1`, E2E = Mongo `sso-idp-e2e` + Redis `/2`, cấm FLUSH/drop; Q-X1-d CI Mongo single-node (DEBT-083). BE E2E: build→db:sync-indexes→db:seed-dev→start, readiness `127.0.0.1:4000/ready`, `SESSION_COOKIE_SECURE=false`.
- **Hạ tầng DEV/E2E (3 container chỉ định, KHÔNG `compose up` thêm)**: `aegate-mongo`@27017 (dùng chung — chỉ DB `sso-idp`/`sso-idp-e2e`); `aegate-redis`@6379 (dùng chung, db0 của project khác — dùng `/1`,`/2`); `veyrigate-mailpit-1` SMTP@1025/UI@8025.
- **Hạ tầng BE int-test (giữ nguyên)**: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` (phải `docker start` trước — DEBT-070); FE `pnpm -C fe-sso-test test` (67).

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

## Chặn / cần người quyết định

Xem `plan.md` §12. Còn mở: **Q3, Q5, Q7–Q9**. **Q1, Q4, Q6 đã chốt** (Q6: access 15', refresh 30d, idle 8h, absolute 30d, secret grace 7d — đọc từ env).
- Người dùng: nên sửa `be/.env` local `REDIS_URL=redis://localhost:6379/1` (tránh db0 dùng chung) và thêm `DEV_SEED_EMAIL`/`DEV_SEED_PASSWORD`.

## Backlog mở

41 mục mở. Xem [backlog.md](backlog.md). Run 22 mở DEBT-082–092 (DEBT-084 chặn E2E → T6; DEBT-085 federation B5 form-action).