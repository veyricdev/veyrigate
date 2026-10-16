# Summary — run 28 B6.3b (M5) — ✅ PASS 3/3 task (Task 4 → run 29)

- **Phạm vi**: T1 users — `GET /admin/users[/:id]`, lock (sentinel `ADMIN_LOCKED_UNTIL` + `revokeAllUserCredentials` tách từ resetPassword), unlock, `sessions/revoke`, `PATCH roles` (chỉ super_admin chạm `super_admin`, cấm tự đổi, filter atomic). User/session global ⇒ tenant_admin 403 với target là admin hoặc active ở tenant khác. T2 families (aggregate theo `familyId`) + consents (revoke kéo theo family qua `RevokeFilter`), lọc theo client của tenant. T3 `GET /admin/audit` (khớp chính xác, cursor opaque, index `{tenantId,timestamp,eventId}`).
- **Bug đã sửa**: (senior REJECT 1) forgot/reset gỡ admin lock ⇒ `setPassword` pipeline `$cond` giữ sentinel. DEBT-152 (retry lock không ghi audit success).
- **Verify**: BE unit 243/243, int 625/625, FE 240/240, E2E 12/12; mutation RED.
- **Commit**: `c9791aa`.
- **Vòng lặp**: tech-lead=1, BE dev=2, senior=2 (REJECT → PASS), tester=1.
- **Debt**: đóng DEBT-152; mở DEBT-140–151 (151 đã chốt hợp đồng 204 idempotent), 153–155. DEBT-145 (race rotate key) bắt buộc ở run 29.
- **Ops**: DB dev cần `pnpm -C be db:sync-indexes` (index audit mới).
