# Summary — run 78 sweep 🟡 BE đợt 2 (M7, lane BE) — ✅ PASS 6/6 task (+4 debt senior sửa trong run)

- **Phạm vi**: T1 DEBT-139 — rotate refresh dùng `returnDocument: 'before'`. T2 DEBT-155 — `families?after=` sai định dạng ⇒ 400 `invalid cursor`. T3 DEBT-150 — logout `scope=all` dùng `revokeAllUserCredentials` (lỗi ⇒ 5xx, không audit thành công, retry được). T4 DEBT-198 — `link_required` set lại cookie `idp_fed`. T5 DEBT-254 — `cliErrorText` che URI/credential trong lỗi CLI. T6 DEBT-256/257 — `--dry-run` cho `db:seed`/`db:seed-dev`/`db:sync-indexes`; runbook-ops §0/§3c/restore bước 5 có cổng xác nhận `read … yes`.
- **Sau senior**: DEBT-522 CLI từ chối đối số lạ; DEBT-523 scrub `@` cuối + query bí mật; DEBT-524 gộp cookie options; DEBT-525 scrub cắt 2 KB + regex tuyến tính (cũ: 47,6 s trên 10 KB; mới ≈ 1 ms trên 100 KB).
- **Verify**: be 708, int FULL 1552/1552 (`vg-int-*` 4→4), fe-admin 1570, E2E 38, X3 42. Tester: flake `db-cli-dry-run` do ngưỡng 3 s ⇒ thay bằng đếm socket + đối chứng dương; +15 ca int (logout global với Redis/Mongo thật + lỗi giữa chừng, `idp_fed` replay/foreign, scrub lỗi driver thật); mutation đỏ đúng chỗ; cổng runbook kiểm bằng stub `echo` (chỉ `yes` chạy).
- **Commit**: `691aa7d`.
- **Vòng lặp**: tech-lead=1, BE dev=3 (REJECT 🔴 runbook ⇒ retry 1; 🟡 ReDoS ⇒ retry 2), senior=2, tester=1 (PASS).
- **Debt**: đóng DEBT-139/150/155/198/254/256/257/522/523/524/525; mở DEBT-521 (logout global lỗi giữa chừng không có audit thất bại).
