# Summary — run 30 B6.4 (M5) — ✅ PASS 3/3 task (Task 2 DEBT-143 hoãn)

- **Phạm vi**: T1 `db:seed` (`be/src/database/seed.ts`, chỉ development|test): `default-tenant`, resource `admin` (hậu kiểm) + `demo`/`other` qua `seedDev`, super_admin từ `ADMIN_SEED_*` (`$setOnInsert`, không reset password/lock), `fe-admin` confidential insert-only, secret in stdout đúng 1 lần. T4 DEBT-137: grant `admin` ⇒ revoke mọi secret trước + sau update, `admin` chỉ cho client confidential. T3 DEBT-161 (409 `conflict` khi disable/enable đồng thời), DEBT-163 (WARN kid PEM mồ côi + runbook §6).
- **Bug đã sửa**: (tester FAIL 1) seed re-point resource `admin` cho phép client public/secret cũ lấy token `aud=admin` (PoC `/admin/me` 200) ⇒ seed từ chối re-point khi có client tham chiếu + runtime `adminTargetForbidden` ở `/authorize`, consent, `/token`, refresh (DEBT-172). DEBT-169 `.env.example` làm app không khởi động.
- **Verify**: BE unit 262/262, int 705/705, FE 240/240, E2E 12/12; CLI env matrix 33/33; mutation RED.
- **Commit**: `e950419`.
- **Vòng lặp**: tech-lead=1, BE dev=3 (gồm 1 lần resume sau ngắt phiên), senior=2, tester=2 (FAIL → PASS).
- **Debt**: đóng DEBT-137/161/163/169/172; mở DEBT-164–168, 170, 171, 173–176. DEBT-143/124 hoãn.
