# Summary — run 79 sweep 🟡 BE đợt 3 (M7, lane BE) — ✅ PASS 6/6 task

- **Phạm vi**: T1 DEBT-521 — logout `scope=all` lỗi một phần ghi audit `SESSION_REVOKED` failure `{scope, failedStep}`. T5 DEBT-179 — điểm ghi admin-capable dùng `isAdminCapableClient` (client `{confidential, none}` ⇒ 400). T4 DEBT-180/119 — `seedBootstrap` chỉ gợi ý dọn trùng khi 11000/IndexOptionsConflict/IndexKeySpecsConflict, lỗi khác giữ `{cause}`; `assertDevOrTestEnv`. T6 DEBT-168 — seam `listDir()` + test nhánh `readdir` lỗi. T3 DEBT-483 — boot check `hello` (replica set/mongos): production không boot nếu Mongo không hỗ trợ transaction, dev/test 1 WARN. T2 DEBT-182/188 — provisioning federated (User + UserTenant + FI) trong 1 transaction, bỏ bù trừ `deleteById`; bên thua race ⇒ 302 với session bên thắng.
- **Verify**: be 715, int FULL 1563/1563 (`vg-int-*` 4→4), fe-admin 1570, E2E 38 (dev lần 1 37/38 flake DEBT-527), X3 42. Tester: sửa DEBT-528 (đếm mồ côi thật bằng spy `create` + tổng trước/sau), race có lỗi giữa transaction 8 vòng × 2, boot check với `hello` rs0 thật + standalone giả + lỗi driver thật, audit failure trong Mongo không chứa token/secret; mutation đỏ đúng chỗ.
- **Commit**: `7b69671`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1 (PASS, 2 🟡), tester=1 (PASS).
- **Debt**: đóng DEBT-119/168/179/180/182/188/483/521/528; mở DEBT-526 (logout `scope=session` lỗi một phần không audit), 527 (flake E2E audit giây = 00), 529 (ponytail `deleteMembership`), 530 (bỏ `session` ở insert FI chưa có test chặn).
- ⚠ Deploy: production chạy Mongo standalone sẽ KHÔNG khởi động (T3).
