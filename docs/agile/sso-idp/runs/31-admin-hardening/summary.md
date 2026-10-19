# Summary — run 31 admin-hardening (M5) — ✅ PASS 3/3 task

- **Phạm vi**: T1 predicate allowlist `isAdminCapableClient` (confidential + `client_secret_basic|post`, thiếu field ⇒ cấm) dùng ở 5 chốt: `/authorize`, consent, `/token` code, refresh, `AdminTokenGuard` (token `aud=admin` cũ của client lệch ⇒ 401). T3 `PATCH {disabled:true}` phải đi một mình (400), grant admin bị huỷ giữa chừng ⇒ audit `CLIENT_SECRET_REVOKED{admin_grant_aborted,count}`. T2 seed `createIndexes()` mọi model trước khi ghi; resource `admin` chỉ `$setOnInsert`, identifier khác ⇒ từ chối (bỏ ngoại lệ fe-admin).
- **Verify**: BE unit 271/271, int 730/730, FE 240/240, E2E 12/12; race 2 CLI process thật 0/30 nhân đôi (mutant không index 5/10); mutation RED.
- **Commit**: `a299314`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-167/170/173/174/175/176/178; mở DEBT-177, 179, 180, 181.
