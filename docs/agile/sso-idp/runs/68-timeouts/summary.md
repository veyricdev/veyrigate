# Summary — run 68 biên thời gian E2E webServer + int timeout sát (M7, lane test-infra) — ✅ PASS 2/2 task

- **Phạm vi**: T1 DEBT-464 — đo webServer BE (build ~35 s, `start:e2e` ts-node ~41 s, `seed:e2e-admin` ~20 s, sync/seed-dev ~10 s): rảnh 49–68 s, dưới tải 28 luồng 102–104 s ⇒ `e2e/playwright.config.ts` timeout BE 120 → 320 s (≥ 3× max tải, comment số đo); FE giữ 120 s; `e2e/README.md` mô tả đúng chuỗi BE. T2 DEBT-455 — đo lại (rảnh + tải, 135/135 ×2): 6 điểm đã ≥ 2× đóng chấp nhận có số đo; nâng 3 điểm theo ≥ 3× max tải: DEBT-161 `admin-api` 25 → 45 s, M3→M4 `indexes` 60 → 100 s, `seed-risk` 10 vòng 660 → 1050 s.
- **Verify**: E2E 36/36 (rảnh ×2, BE 49–68 s) + `lab.spec` 10/10 dưới tải (BE 102,1 s / 320 s); 5 spec int 135/135 rảnh + tải; int full 1420/1420 (`vg-int-*` 4 → 4), be 630; config thật đọc 320000/120000/120000, `retries=0`; lint/typecheck 0.
- **Commit**: `4c8e67a`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1 (PASS, 0 🟡), tester=1 (PASS).
- **Debt**: đóng DEBT-464/455; mở DEBT-480 (`TS_NODE_TRANSPILE_ONLY` cho `start:e2e`/`seed:e2e-admin` — cần chứng minh Nest DI/metadata), DEBT-481 (`seed-risk` giảm `dropDatabase` mỗi vòng). Không thêm `retries`, không nới assertion.
