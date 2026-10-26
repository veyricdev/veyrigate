# Summary — run 56 race admin/disable client (M7, lane BE) — ✅ PASS 3/3 task (DEBT-420 chuyển run 57 theo quyết định người dùng)

- **Phạm vi**: T3 DEBT-166 sau `rotateSecret` đọc lại client; nếu vừa thành admin-capable ⇒ revoke version vừa tạo + audit `admin_granted_concurrently` + 403, không trả plaintext. T2 DEBT-147/153 `users.adminLockLevel` (filter trong câu ghi; lock cũ không level ⇒ super_admin), unlock `findOneAndUpdate` `returnDocument:'before'` ⇒ đúng 1 audit, tenant_admin mở khoá super_admin ⇒ 403 + audit; audit `LOCKED success` ghi ngay sau câu khoá (trước revoke), số phiên ở `SESSION_REVOKED {scope:'all', count, via:'lock'}` (DEBT-421). T1 DEBT-209/156 `clients.lastDisabledAt` + `issuedAt` trên code + `mintedBeforeDisable` (margin 5 s) ở gate trước ký, sau consume, `recheckCodeGrant`, `isAccessTokenLive` (`iat`), `trustedClient`; `resume` kiểm client mọi nhánh. Runbook NTP (đúng chiều, DEBT-419); xoá `resetFailedLogins` (DEBT-418). DEBT-148 chấp nhận (cần transaction 2 collection, không leo quyền).
- **Giữ nguyên run 54/55** (ký trước commit, consent binding).
- **Verify**: be unit 589, int 1347 + 1 skip (L6), fe-admin 1416, fe-sso-test 269, E2E 35/35, audit high 0; mutation 13 + 3 + 1 RED.
- **Vòng lặp**: tech-lead=1, BE dev=3 (impl+418/419, retry 1, retry 2), senior=3 (PASS, REJECT E2E `count`, PASS), tester=2 (FAIL DEBT-420, PASS).
- **Quyết định người dùng (2026-10-26)**: đóng run 56, L6 (lock∥unlock không barrier — trail đôi khi lệch DB, trạng thái/quyền vẫn đúng) quarantine `it.skip`; DEBT-420 gộp DEBT-422 làm ở run 57 (mốc thời gian đơn điệu theo user, audit dùng mốc đó).
- **Commit**: (điền sau).
- **Debt**: đóng DEBT-147/148/153/156/166/209/418/419/421/423; mở 416 (FE thông báo 403 khoá super_admin), 417 💭, **420 🟡 (run 57)**, 422 🟡 (run 57).
