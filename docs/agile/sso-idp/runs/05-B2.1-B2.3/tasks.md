# Phase B — Danh tính & phiên (M2) — run 05: B2.1–B2.3

Nguồn: `plan.md` §5.B2 (B2.1–B2.3) · spec §6.1 (Mongo vs Redis), §9.6 (session/cookie), §9.10 (multi-tenancy), §10 (data model), §15 (INV-16, 17, 24).
spec.md/plan.md đã có → orchestrator sinh tasks (bỏ qua analyst). Trạng thái: `todo → in-progress → in-review → testing → done`.

**Backlog trong phạm vi**: DEBT-002 (`validateEnv` gọi 2 lần) — run này PHẢI sửa config (thêm env cookie) → xử lý luôn. Các DEBT khác ngoài phạm vi.

**Giả định đã chốt (orchestrator)**:
- A1 (Q6, chốt tạm theo đề xuất plan §12): `SESSION_IDLE_TTL=28800` (8h), `SESSION_ABSOLUTE_TTL=2592000` (30 ngày) trong `.env.example`/`.env`; giá trị vẫn đổi được qua env.
- A2: Thứ tự làm **B2.3 → B2.1 → B2.2** (tenant context lấy từ session nên session phải có trước).
- A3: Cookie dùng `@fastify/cookie`. Cờ dev duy nhất `SESSION_COOKIE_SECURE` (mặc định `true`); `false` bị **từ chối khi `NODE_ENV=production`** (fail-fast ở validation).
- A4: Redis chỉ lưu **sha256(sessionId)** làm key (`sess:<hash>`), không lưu ID thô. Chỉ mục theo user `user_sess:<userId>` để revoke theo thiết bị / toàn bộ.
- A5: Tenant context B2.1 chỉ từ **session**; nguồn từ access token để B6.1 (chừa interface). Chưa có login thật (B2.4) → test tạo session qua service.
- A6: `sub` = `User._id` (ObjectId dạng string), bất biến; email đổi được không ảnh hưởng `sub`.

---

## B2.3 — Sessions trên Redis + cookie `[BE]`
**Phụ thuộc**: B1.4, B1.5 · **Size**: M · **Trạng thái**: in-review
- [x] Env `SESSION_COOKIE_SECURE` (A3) + cập nhật TTL (A1); gộp `validate`+`load` trong `config.module.ts` (DEBT-002)
- [x] `SessionService`: `create(userId, tenantId, {deviceLabel?})` sinh ID CSPRNG (B1.5), lưu `{userId, tenantId, authTime, createdAt, lastSeenAt, device}` với TTL = idle; `get(id)` kiểm absolute (`createdAt + ABSOLUTE ≤ now` → huỷ) và gia hạn idle (sliding, không vượt absolute)
- [x] `rotate(oldId)` / `establish(...)`: **luôn cấp ID mới sau xác thực**, huỷ ID cũ (kể cả anonymous) — INV-17
- [x] `revoke(id)`, `listByUser(userId)`, `revokeByDevice(userId, sessionRef)`, `revokeAllForUser(userId)`
- [x] Cookie `idp_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, không có userId/email trong giá trị — INV-16
**Nghiệm thu**: INV-16, INV-17 · test fixation (ID trước login ≠ ID sau, ID cũ không còn dùng được) · idle hết hạn → mất; absolute hết hạn dù đang hoạt động → mất · revoke theo thiết bị chỉ huỷ đúng phiên đó · Redis không chứa ID thô · `SESSION_COOKIE_SECURE=false` + production → app không khởi động.

## B2.1 — Tenant context + repository bắt buộc filter tenant `[BE]`
**Phụ thuộc**: B1.6, B2.3 · **Size**: M · **Trạng thái**: in-review
- [x] Guard/decorator lấy tenant **chỉ từ session đã xác thực** (A5) → `TenantContext` (kiểu branded, chỉ guard tạo được)
- [x] Base repository tenant-scoped: mọi hàm truy vấn nhận `TenantContext` bắt buộc và đưa `tenantId` **vào chính câu query** (không find-rồi-kiểm)
- [x] Không có đường nào đọc `tenantId` từ body/query/header
**Nghiệm thu**: INV-24 · test: request gửi `tenantId` khác trong body/query bị bỏ qua · truy vấn dữ liệu tenant B bằng context tenant A → không thấy · không có session → 401.

## B2.2 — Identity services `[BE]`
**Phụ thuộc**: B2.1 · **Size**: M · **Trạng thái**: in-review
- [x] `TenantService` + seed idempotent `default-tenant` lúc boot
- [x] `UserService` (tạo, tìm theo id/email chuẩn hoá lowercase, cập nhật trạng thái), `UserTenantService` (membership, roles), `FederatedIdentityService` (find/link theo `provider+providerId`) — chỉ nội bộ, chưa có controller
- [x] `sub` = `User._id` (A6)
**Nghiệm thu**: CRUD nội bộ chạy · trùng email / trùng membership / trùng `provider+providerId` → lỗi unique · đổi email không đổi `sub` · seed chạy 2 lần không nhân đôi tenant.
