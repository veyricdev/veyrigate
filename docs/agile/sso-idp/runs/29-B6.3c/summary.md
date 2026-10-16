# Summary — run 29 B6.3c (M5) — ✅ PASS 4/4 task

- **Phạm vi**: T1 DEBT-145 — `LocalKeyProvider.rotate` qua promise-chain mutex; `getPublicKeys`/`listKeys` chỉ đọc, prune trong rotate; `getSigningKey` đọc lại khi ENOENT (1 process/key dir — DEBT-159). T2 `GET /admin/keys`, `POST /admin/keys/rotate {mode}` (super_admin, step-up, audit `SIGNING_KEY_ROTATED`), `GET /admin/tenants`. T3 disable client ⇒ revoke mọi refresh family (`RevokeFilter {clientId}`, index `{clientId:1}`); giữ `disabledAt` gốc. T4 login dùng `clearFailedLoginsIfUnlocked` atomic ⇒ lock đặt giữa chừng không bị xoá.
- **Bug đã sửa**: (tech-lead) `getPublicKeys` prune ghi state ngoài mutex ⇒ có thể hồi sinh key đã lộ / mất key mới.
- **Verify**: BE unit 254/254, int 660/660, FE 240/240, E2E 12/12; mutation RED (mutex, prune, revoke, ENOENT, gate).
- **Commit**: `dc7704d`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-125/132/145/146/154; mở DEBT-156–163.
- **Ops**: DB dev/E2E cần `pnpm -C be db:sync-indexes` (index `RefreshToken {clientId:1}`).
