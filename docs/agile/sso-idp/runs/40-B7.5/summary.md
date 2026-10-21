# Summary — run 40 B7.5 (M7) — ✅ PASS 2/2 task

- **Phạm vi**: T1 `runbook-ops.md` 4 kịch bản (key lộ ⇒ emergency rotate có step-up; reuse spike ⇒ metric/alert + mongosh chỉ-đọc + revoke/lock/disable; mất admin ⇒ `db:seed` chỉ dev/test, break-glass 2 người cho prod; backup/restore ⇒ restore sang DB mới, thu hồi toàn bộ RT qua `getSiblingDB`, chuyển app trước khi mở traffic). T2 diễn tập: kịch bản 1–3 + §4(i) tự động (`runbook-drill.int-spec.ts`), kịch bản 4 thủ công trên `vg-test-mongo` (`drill-report.md`). F5 `db:seed`/`db:sync-indexes` in `target: host/db` không credential trước khi chạm DB.
- **Bug đã sửa**: (senior REJECT 1, 2) `mongoTarget` lộ mật khẩu chứa `/?#` hoặc bắt đầu bằng chữ số ⇒ allowlist host/db + fail-closed khi còn `@` (fuzz 500k URI, 0 lộ); runbook §4c ghi nhầm DB đang chạy; §4b gọi admin API khi app đã tắt / trỏ DB cũ.
- **Verify**: BE unit 401/401, int 1203/1203; diễn tập 4/4 + diễn tập lại §4c bản mới.
- **Commit**: `27b1a69`.
- **Vòng lặp**: tech-lead=1, BE dev=3, senior=3 (REJECT, REJECT, PASS), tester=2 (2b + nghiệm thu).
- **Debt**: đóng DEBT-259/260/262; mở DEBT-251–258, 261, 263.
