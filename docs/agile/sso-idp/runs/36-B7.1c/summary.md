# Summary — run 36 B7.1c (M7) — ✅ PASS 4/4 task

- **Phạm vi**: T1 `refuseGrant`/`failClosed` (DEBT-213), `resource_not_allowed` ở code grant (DEBT-210), `subjectFailure` chỉ coi khoá admin / user mất là `user_locked` (G1: khoá tạm brute-force không giết family `offline_access`). T2 refresh kiểm lại sau `rotate` (client disabled / khoá admin / mất membership ⇒ revoke cả family, `invalid_grant` đồng nhất; lỗi hạ tầng 500). T3 login password + callback federation đọc lại user sau `establish` ⇒ khoá ⇒ huỷ session vừa tạo, lỗi chung. T4 `access_denied` not_member giống hệt user tự từ chối (DEBT-211).
- **Verify**: BE unit 317/317, int 964/964, FE 240/240, E2E 16/16; mutation 11 nhánh + G1 RED.
- **Commit**: `a80855b`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-116/141/187/207/210/211/213 (+ phần refresh của 156); mở DEBT-214 (refresh không kiểm consent), 215 (reuse giả sau refresh bị từ chối — pin bằng test), 216 (refresh không kiểm resource), 217 (ponytail).
