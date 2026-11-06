# Senior Review — 2026-11-06
## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)
Diff nhỏ, đúng § Fold F1–F5. Che ở BE, lúc đọc, theo vai trò membership live (`AdminTokenGuard` → `memberships.activeRoles` mỗi request ⇒ không tin claim cũ; int chứng minh giáng super_admin ⇒ cùng token bị che ngay). `toAdminAuditEvent(e, { fullPii })` bắt buộc tham số; caller duy nhất là `admin-audit.controller.ts:98`. `maskIp` fail-closed, không bao giờ echo chuỗi gốc. `collMod` đổi TTL tại chỗ trước `syncIndexes`, lỗi lan ra `main` ⇒ `process.exit(1)`, không fallback drop; guard "model đã đăng ký với TTL khác ⇒ throw" chặn đường drop+rebuild của Mongoose. Một nguồn TTL: `createAuditLogSchema` dùng chung cho `MongoModule.forFeatureAsync` (config), `buildModels(env)` (sync/seed/seed-dev), `full-app.ts` (env) — không lệch. Test mạnh: body JSON không chứa IP/UA đã seed và không chứa chuỗi `userAgent`; mutation đã ghi trong log.

Kiểm lại (reviewer chạy thật): unit be `admin.spec` + `mask-ip.spec` + `validation.schema.spec` 139/139; int `run71-audit-pii` + `indexes` 26/26; `tsc --noEmit` be sạch; fe-admin `audit-ui.test.tsx` 23/23. Probe `maskIp` thêm: `::ffff:0x7f.0.0.1`→`127.0.0.0/24`, `::ffff:127.1`→vắng, `1.2.3.4%eth0`→vắng, `::FFFF:1.2.3.4`→`/24`, NAT64 `64:ff9b::cb00:714d`→`64:ff9b::/48` (không lộ), Teredo→`2001:0:4136::/48` (chỉ IPv4 server) — đều không echo; ngoại lệ 6to4 (xem 🟡).

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- Identity/authz: quyết định `fullPii` = `actor.roles.includes('super_admin')`, roles đọc từ `UserTenant` live mỗi request, tenant = tenant của client đã verify (không từ body/query). Cross-tenant: endpoint vẫn scope `ctx.tenantId` như trước.
- Exposure: tenant_admin không nhận UA (key vắng), IP chỉ prefix; parse lỗi ⇒ vắng `ip`. Không có filter/sort `ip`/`userAgent` (whitelist DTO) ⇒ không oracle. `Cache-Control: no-store` sẵn có.
- Failure: env sai ⇒ boot fail, thông điệp nêu tên biến, không echo env khác (test canary). `collMod` lỗi ⇒ exit 1. Collection chưa có ⇒ để `syncIndexes` tạo (tránh `indexes()` NamespaceNotFound).
- Dữ liệu: runbook-deploy cảnh báo rõ lần sync đầu XOÁ VĨNH VIỄN event > N ngày, export trước, giờ thấp điểm, rút ngắn N lại xoá; đổi env cần chạy lại sync.
- DEBT-497 (DB chưa sync ⇒ dev `autoIndex` phát `IndexOptionsConflict`, `db:seed` lỗi): chấp nhận cho prod — prod `autoIndex:false` nên app không bị ảnh hưởng; seed lỗi ồn ào TRƯỚC khi ghi (không mất dữ liệu); runbook đã ghi thứ tự sync trước seed. Giữ mức 💭 trong backlog.

## 🟡 Nên sửa
- [ ] be/src/modules/admin/mask-ip.ts:20 — **6to4 (`2002::/16`) lộ nguyên IPv4**: `/48` của 6to4 = `2002:WWXX:YYZZ::/48`, chính là IPv4 /32 của người dùng (probe: `2002:cb00:714d::1` → `2002:cb00:714d::/48` = 203.0.113.77). Vì sao: vi phạm invariant "tenant_admin không thấy IP đầy đủ" (hiếm — 6to4 đã deprecated RFC 7526 — nên 🟡, không 🔴). Đề xuất: nếu `v6.range() === '6to4'` thì lấy IPv4 nhúng (`parts[1..2]`) rồi `v4Prefix`; thêm ca unit `2002:cb00:714d::1` → `203.0.113.0/24`. → DEBT-498.

## 💭 Nit
- be/src/database/mongo/sync-indexes.ts:15 — default `retentionDays = 180`: một CLI mới gọi `syncAllIndexes(conn)` trên prod sẽ lặng lẽ `collMod` về 180 ngày. Hiện chỉ `main` (prod) truyền env và guard throw nếu model app đăng ký khác, nên chấp nhận; nếu thêm caller prod khác thì bỏ default.
- runbook-deploy §1 "Run 71": có thể ghi yêu cầu MongoDB ≥ 5.1 (đổi index thường thành TTL qua `collMod`); hiện mongo:7 nên đủ.
- fe-admin/src/routes/audit/index.tsx:241 — vai trò viewer FE lấy từ root context; nếu lệch BE (giáng giữa phiên) chỉ đổi nhãn "Hidden"/"—", BE vẫn che ⇒ vô hại.

## ✂️ Ponytail
Lean already. Ship.
