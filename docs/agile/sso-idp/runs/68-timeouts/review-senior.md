# Senior Review — 2026-11-06 — run 68 (DEBT-464/455)

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)
Diff đúng và chỉ đúng fold tech-lead: 1 số `timeout` webServer BE (120_000 → 320_000) + comment, README § What it runs, và 3 spec BE mỗi file đổi đúng 1 số timeout + comment (`git diff --stat`: 20+/11-). Không `retries` (config vẫn `retries: 0`), không nới assertion, không giảm vòng/request, FE/fe-admin giữ 120 s, `INT_SETUP_TIMEOUT_MS`/hook 60 s không đổi. Mọi con số trong comment/README/backlog đối chiếu được với log thô (dev68-*.log, e2e-*.log, int-*.log trong scratchpad). Điểm tốt: comment `DEBT-448` giữ số run 61 và thêm số run 68, nên người sau thấy được xu hướng; quyết định không đổi `TS_NODE_TRANSPILE_ONLY` và không đổi cách dọn `seed-risk` được tách thành DEBT-480/481 có bước chứng minh rõ.

Đối chiếu số đo (log thô):
- webServer BE: tech-lead rảnh 03:06:37.437→03:07:45.943 = 68,5 s; tải 104,1 / 104,3 s; dev tải 03:38:02.148→03:39:44.279 = 102,1 s. 320 / 104,3 = 3,07×. Khớp comment config + README (~69 s / ~104 s).
- DEBT-161 `admin-api`: 2054 / 13910 ms (tech-lead), 1918 / 13091 ms (dev). 45 / 13,9 = 3,2×.
- M3→M4 `indexes` (test "drops the old {userId,clientId} unique index…"): 2531 / 32973 ms (tech-lead), 1987 / 31038 ms (dev). 100 / 33,0 = 3,03×.
- `seed-risk` 10 vòng: 40111 / 343159 ms (tech-lead), 36218 / 330002 ms (dev). 1 050 / 343,2 = 3,06×.
- 135/135 cả 4 lượt int; E2E 36/36 rảnh (dev68-e2e-idle), `lab.spec` 10/10 dưới tải. Tải `load2` tự dừng (dev68-load*.log "done").
- Lint 3 spec exit 0, `pnpm -C e2e typecheck` exit 0 (chạy lại khi review).

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
Diff không chạm trust boundary (chỉ số timeout test/E2E + tài liệu). Đã kiểm: chuỗi `command` webServer BE không đổi (vẫn có `assert-dist-clean`, INV-23); E2E vẫn dùng DB `sso-idp-e2e` + redis `/2` như trước; không log/secret mới; README không chứa giá trị env.

## 🟡 Nên sửa
(không có)

Về câu hỏi "nâng timeout có che regression hiệu năng thật không": không đáng 🟡. Các timeout này chưa bao giờ là ngân sách hiệu năng (trước run 68 `seed-risk` đã là 660 s ≈ 16× rảnh); việc nâng chỉ đổi điểm báo đỏ của một lượt treo, không bỏ assertion nào. Phần hiệu năng thật đã có chỗ theo dõi: DEBT-480 (≈ 7 s/bước ts-node type-check) và DEBT-481 (chi phí `dropDatabase` mỗi vòng). Hệ quả đáng biết: một BE khởi động treo giờ mất tới 320 s mới báo đỏ (trước 120 s) — chấp nhận được cho E2E local/CI.

## 💭 Nit
- `backlog.md` DEBT-455 dùng số đo của dev (13,1 / 31,0 / 330,0 s) trong khi comment ở spec dùng số của tech-lead (13,9 / 33,0 / 343,2 s). Cả hai đều có trong log và đều ghi rõ nguồn; chỉ là hai bộ số khác nhau cho cùng một quyết định. Không cần sửa.
- `tasks.md` (fold tech-lead) ghi fe-admin dưới tải 12,9 s; `e2e-load2.log` cho 22,9 s (03:15:15.563→03:15:38.441). Biên 120 s vẫn ≥ 5×, quyết định giữ 120 s không đổi. Không nằm trong diff.
- Dòng `[ELIFECYCLE] Command failed with exit code 1` ở cuối các lượt `lab.spec` (cả tech-lead lẫn dev, cả trước thay đổi) là lúc Playwright tắt webServer, không phải lỗi test.

## ✂️ Ponytail
Lean already. Ship.
