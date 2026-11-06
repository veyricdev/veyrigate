# Tech Lead Review — 2026-11-06
## Kết luận: PASS (kèm § Fold tech-lead bắt buộc trong `tasks.md`)

## Kiến trúc đề xuất (nếu cần điều chỉnh)
Giữ monolith hiện có, diff nhỏ nhất:
- Retention = TTL trên index `timestamp_1` có sẵn (không thêm field `expireAt`, không backfill); số ngày từ env `AUDIT_RETENTION_DAYS` qua một factory schema dùng chung cho app (`autoIndex` dev/test) và `db:sync-indexes`.
- Đổi `expireAfterSeconds` trên DB có sẵn bằng `collMod` trong `syncAllIndexes` TRƯỚC `syncIndexes()` (Mongoose 9 mặc định drop rồi create khi khác `expireAfterSeconds` ⇒ có cửa sổ thiếu index + rebuild trên collection lớn; `collMod` đổi tại chỗ, Mongo 7 hỗ trợ đổi index thường thành TTL).
- Che lúc đọc ở mapper `toAdminAuditEvent` theo `actor.roles` (áp cả dữ liệu cũ, không ghi lại DB); FE chỉ hiển thị.

## Điểm mạnh
- Quyết định §12 (DEBT-344) đúng kỹ thuật và bảo mật: tối thiểu hoá PII, vẫn giữ /24 /48 đủ để điều tra; không mở lại.
- Bề mặt nhỏ: chỉ một đường đọc (`GET /admin/audit`), không export, không route chi tiết, không filter `ip` ⇒ không oracle.
- Tenant scoping + allowlist mapper (B6.3b) sẵn có; `ipaddr.js` đã là dependency.

## Vấn đề (đã fold — dev bắt buộc làm, không cần quay lại analyst)
- [x] Cách đổi TTL an toàn prod chưa nêu ⇒ F2 `collMod` + mutation chứng minh không drop.
- [x] Validation env mơ hồ (`z.coerce` nhận `"1e2"`, `''`⇒0) ⇒ F1 regex + [30, 3650], unset/'' ⇒ 180.
- [x] Che IP thiếu ca biên (IPv4-mapped dạng hex, zone id, dạng IPv4 không chuẩn `127.1`, chuỗi rác, `''` từ federation) và quy tắc "không bao giờ echo chuỗi gốc" ⇒ F3.
- [x] `userAgent` phải VẮNG key (không null/'') + kiểm toàn body JSON (bắt rò qua metadata) ⇒ F3.
- [x] FE "—" cho UA gây hiểu nhầm "không ghi nhận"; zod không được `.ip()` ⇒ F4.
- [x] Runbook: lần sync đầu xoá vĩnh viễn event > N ngày, đổi env cần chạy lại sync ⇒ F5.

## Security design gate
- Tài sản: `ip`, `userAgent` của actor trong audit. Actor: super_admin, tenant_admin (cùng tenant), non-admin (đã chặn bởi guard). Trust boundary: BE → BFF → trình duyệt; che ở BE, BFF/FE không bao giờ nhận giá trị đầy đủ cho tenant_admin.
- Invariant: response cho viewer không có `super_admin` không chứa IP đầy đủ/UA trong bất kỳ field nào; quyết định theo vai trò membership của request hiện tại (giáng vai trò ⇒ request sau bị che).
- Abuse: oracle qua filter/sort (không có, cấm thêm), trả chuỗi gốc khi parse lỗi (cấm), IPv4-mapped lộ IPv4 đủ (bắt buộc unmap), cache (đã `no-store`).
- Failure: `collMod` lỗi ⇒ sync exit ≠ 0, không fallback drop; env sai ⇒ boot fail; mask lỗi ⇒ vắng `ip` (fail-closed).
- Test âm đo được: body JSON không chứa IP/UA đã seed cho tenant_admin; mutation `fullPii=true` ⇒ RED.

## Đề xuất (không bắt buộc) → `backlog.md`
- DEBT-495: cảnh báo khi TTL index lệch env (boot/`/ready` hoặc log cảnh báo) — tránh đổi env mà quên sync.
- DEBT-496: retention/che IP trong log ứng dụng (pino request log) và backup Mongo — ngoài phạm vi TTL.
