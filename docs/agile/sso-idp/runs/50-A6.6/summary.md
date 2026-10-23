# Summary — run 50 A6.6 (M5, lane ADMIN) — ✅ PASS 3/3 task

- **Phạm vi**: T1 [FE] DEBT-352 (`useSigningKeys()` không tham số, gate bằng mount). T2 [FE] dashboard `/`: đếm client/user (tenant) và resource (toàn cục) bằng 1 trang `limit:100` (`100+` khi còn trang), thẻ signing keys chỉ super_admin, health BE qua BFF `readiness` (session trước, không authorization, 3 s, không retry/redirect, trình duyệt chỉ nhận up/down/unknown), 10 sự kiện bảo mật gần nhất từ 3 truy vấn audit (một truy vấn lỗi ⇒ cả khối lỗi), mỗi khối lỗi độc lập, không polling. T3 [E2E] dashboard khớp admin API, health Up, sự kiện lock.
- **Verify**: fe-admin 1284/1284, be 416, fe-sso-test 269 (chạy tuần tự), E2E 34/34 (×2 dev, ×1 tester), audit high 0, `gen:api` không diff, check:bundle 0; mutation 5 + 9 RED; grep secret/email 0.
- **Commit**: `b9d8675`.
- **Vòng lặp**: tech-lead=1, FE dev=1, senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-352/358; mở DEBT-356 (BE count), 357 (refetch khi focus), 359 (ponytail), **DEBT-360 🟡** (root `pnpm test` song song gần như luôn đỏ do timeout — gộp 333/355, ưu tiên sửa).
- **Lane ADMIN**: A6 xong trừ A6.3b roles (chờ DEBT-149/142). Tiếp: DEBT-360 + A7 hardening FE.
