# Senior Review — 2026-09-29
## Kết luận: PASS

## Tổng quan
Code gọn, bám sát C1–C12, không over-engineering. Điểm tốt:
- Session: key sha256(id), `SET … XX` khi slide (test race C4 dùng hook clock), absolute 2 lớp, `establish` duy nhất, lỗi Redis không bị nuốt (có test).
- `revokeByDevice` kiểm cả SISMEMBER lẫn stored userId (test IDOR có cả case ref bị cấy vào index).
- `TenantContext` brand `unique symbol` không export, lưu trên request bằng Symbol riêng, freeze; guard kiểm membership active mỗi request.
- Repo: `tenantId` merge sau cùng, `create` ghi đè, `withoutTenantId` lọc cả toán tử `$rename/$unset`.
- `DuplicateError` là lỗi domain (INV-27); `link` không tra theo email (INV-22); seed upsert + nuốt E11000.
- DEBT-002 đóng đúng (sync-indexes vẫn gọi validateEnv riêng — hợp lệ, là CLI).

Đối chiếu C1–C12: tất cả ✅.

## 🔴 Blocker
(không có)

## 🟡 Nên sửa
- [ ] user.service.ts `changeEmail` — giữ nguyên `emailVerifiedAt` của email cũ → `email_verified=true` sai sau đổi email. Đề xuất `$unset:{emailVerifiedAt:1}` cùng update + test. → DEBT-012.
- [ ] session.service.ts `REVOKE_ALL_SCRIPT` + MULTI trong `create`/`revokeRef` — không tương thích Redis Cluster (CROSSSLOT). Sentinel không ảnh hưởng. → DEBT-013 (khi chốt Q5).
- [ ] user.service.ts `updateStatus` — chỉ `$set` tuyệt đối `failedLoginCount` → lockout có thể bị lách khi login song song. Đề xuất `$inc` atomic + `lockedUntil` trong 1 update. → DEBT-014 (B2.4).

## 💭 Nit
- `listByUser`: `JSON.parse` không bọc try → dữ liệu hỏng thành 500 (chấp nhận, đúng §6.2).
- `revoke(id)`: GET rồi MULTI — ref stale trong `user_sess` tới lần `listByUser`; vô hại.
- tenant-context.ts: 403 → filter map `access_denied`; 401 → `invalid_client` (DEBT-009).
- `TenantContext.sessionRef`/`userId` ngoài spec — hợp lý cho B2.5.
- `addMembership`: `new Types.ObjectId(userId)` ném BSONError với id sai định dạng — đầu vào tin cậy, chấp nhận.
