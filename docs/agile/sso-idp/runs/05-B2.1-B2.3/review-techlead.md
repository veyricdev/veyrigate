# Tech Lead Review — 2026-09-29

## Kết luận: PASS (có điều kiện C1–C12 — dev bắt buộc làm, senior kiểm)

Plan đúng vấn đề (INV-16/17/24, §9.6, §9.10), phạm vi vừa, thứ tự B2.3 → B2.1 → B2.2 (A2) hợp lý. Không có lỗi cấu trúc cần trả analyst; các điểm dưới là **ràng buộc hiện thực** để tránh lỗ bảo mật tinh vi.

## Kiến trúc đề xuất

Giữ **modular monolith** (NestJS hiện tại). Không thêm service/abstraction mới ngoài danh sách dưới.

```
be/src/config/                         env SESSION_COOKIE_SECURE + gộp validate/load (DEBT-002)
be/src/modules/sessions/
  session.service.ts                   create/get/establish/revoke/listByUser/revokeByDevice/revokeAllForUser
  session.cookie.ts                    set/clear/read cookie `idp_session` (1 chỗ duy nhất đọc cờ Secure)
  sessions.module.ts                   export SessionService
be/src/modules/identity/
  tenant-context/                      TenantContext (branded) + TenantGuard + @Tenant() + TenantScopedRepository
  tenant.service.ts, user.service.ts, user-tenant.service.ts, federated-identity.service.ts
  identity.module.ts                   imports SessionsModule
main.ts                                register @fastify/cookie
```

Redis layout (A4):
- `sess:<sha256(id)>` → JSON `{userId, tenantId, authTime, createdAt, lastSeenAt, device}`, TTL = `min(idle, createdAt+absolute−now)`.
- `user_sess:<userId>` → SET các `sha256(id)`; `EXPIRE` = absolute TTL mỗi lần thêm.
- `sessionRef` (dùng cho list/revoke theo thiết bị) = chính `sha256(id)` — không đảo ngược được thành cookie.

Thứ tự làm cho dev:
1. Config (C1, C2) → `.env.example` → test config.
2. `@fastify/cookie` + `session.cookie.ts` (C3, C8).
3. `SessionService` (C4–C7, C9) → int-test trên Redis `6479`.
4. Tenant context + repository (C10–C11) → int-test Fastify + Redis + Mongo `27117`.
5. Identity services + seed (C12) → int-test Mongo.

## Điểm mạnh

- Chỉ lưu `sha256(sessionId)` trong Redis; tái dùng `generateToken`/`sha256` (B1.5) — không cần primitive mới.
- Cờ dev duy nhất `SESSION_COOKIE_SECURE` + fail-fast ở production đúng plan §11.
- Tenant chỉ lấy từ session, chừa nguồn access token cho B6.1 — đúng YAGNI.
- `sub` = `_id` bất biến; schema/unique index B1.6 đã có đủ (`email`, `provider+providerId`, `userId+tenantId`, `Tenant.id`).
- Kéo DEBT-002 vào run vì đằng nào cũng chạm config.

## Vấn đề (bắt buộc khi code — không phải lý do REJECT)

**B2.3 — Config & cookie**
- [ ] **C1** `SESSION_COOKIE_SECURE`: **không** dùng `z.coerce.boolean()` (`"false"` → `true`). Dùng `z.enum(['true','false']).default('true').transform(v => v === 'true')` (hoặc `z.stringbool()` zod v4). Rule production bằng `superRefine` ở cấp object, message nêu tên biến. Test: `"false"` + `development` → false; `"false"` + `production` → throw; thiếu biến → true.
- [ ] **C2** DEBT-002: bỏ `validate`, giữ `load: [() => buildConfig(validateEnv(process.env))]` (load vẫn throw → vẫn fail-fast). Sửa comment đầu `configuration.ts`/`config.module.ts` cho khớp. Cập nhật `.env.example`: `SESSION_IDLE_TTL=28800`, `SESSION_ABSOLUTE_TTL=2592000`, `SESSION_COOKIE_SECURE=true` (ghi chú dev localhost đặt `false`); thêm rule `SESSION_IDLE_TTL ≤ SESSION_ABSOLUTE_TTL`.
- [ ] **C3** Thêm `@fastify/cookie` (pin version khớp major fastify mà `@nestjs/platform-fastify@12` dùng), register trong `main.ts` **và** trong app của int-test. **Không** ký cookie (ID 256-bit ngẫu nhiên, ký không thêm an toàn).
- [ ] **C8** Cookie: `HttpOnly; Secure(=cờ); SameSite=Lax; Path=/`, **không set `Domain`** (host-only), `Max-Age = SESSION_ABSOLUTE_TTL`. `clear` dùng cùng attributes. Chỉ `session.cookie.ts` đọc cờ Secure.

**B2.3 — SessionService**
- [ ] **C4** Chống "hồi sinh" session: sau `create`, **mọi** lệnh ghi trên `get`/sliding chỉ được là `SET key val XX EX ttl` hoặc `EXPIRE` (không `SET` thường/`HSET` — sẽ tạo lại key vừa bị revoke song song). Test: revoke xen giữa get → session không quay lại.
- [ ] **C5** Absolute enforced 2 lớp: TTL Redis = `min(idle, deadline−now)` + check `createdAt+absolute ≤ now` → DEL. Cho phép inject clock (`now()`) để test absolute không phải sleep 30 ngày; idle test dùng TTL nhỏ (1–2s) trên Redis thật.
- [ ] **C6** Index theo user: `create` = `MULTI(SET sess NX EX, SADD user_sess, EXPIRE user_sess absolute)`; `revoke` = `MULTI(DEL, SREM)`; `listByUser` bỏ + `SREM` các member đã hết hạn. `revokeAllForUser` xoá cả key index.
- [ ] **C7** `revokeByDevice(userId, sessionRef)` phải kiểm **quyền sở hữu** (`SISMEMBER user_sess:<userId> ref` **và** `session.userId === userId`) trước khi DEL — chống IDOR huỷ phiên người khác. Test: user A không huỷ được ref của user B.
- [ ] **C9** Gộp `rotate`/`establish` thành **một** hàm `establish(oldId | undefined, userId, tenantId, opts)`: huỷ `oldId` (bất kể trạng thái) rồi tạo ID mới. Không giữ 2 API cho cùng việc. Lỗi Redis **không** được nuốt thành "không có session" (để lộ ra 5xx, §6.2); treo khi Redis down đã theo dõi ở DEBT-005.

**B2.1 — Tenant context**
- [ ] **C10** `TenantGuard`: session hợp lệ **và** `UserTenant{userId, tenantId, status:'active'}` tồn tại (1 query trên unique index sẵn có) — "đã authorize" theo INV-24, và membership bị gỡ thì mất quyền ngay. Brand bằng `unique symbol` không export; factory chỉ export cho guard. Không session/không membership → 401/403.
- [ ] **C11** `TenantScopedRepository` tối giản (chỉ hàm B2.2 cần: `findOne/find/create/updateOne/deleteOne`): filter = `{ ...filter, tenantId: ctx.tenantId }` (**merge sau cùng**, caller không ghi đè được); `create` gán `tenantId` từ ctx, bỏ giá trị input; `updateOne` loại `tenantId` khỏi update. Chỉ áp cho collection có `tenantId` (UserTenant nay, Client ở B3). User/FederatedIdentity/Tenant là **global** (§9.10) — không ép qua repo này. Test cross-tenant + test filter chứa `tenantId` khác vẫn bị ghi đè.

**B2.2 — Identity**
- [ ] **C12** 
  - Seed `default-tenant`: `updateOne({id}, {$setOnInsert}, {upsert:true})` trong `OnApplicationBootstrap`; bắt `E11000` (2 instance boot cùng lúc) coi như thành công.
  - Lỗi trùng unique → **lỗi domain** (vd `DuplicateError`), **không** ném `HttpException`/409 có message "email đã tồn tại" — B2.4 cần response đồng nhất (INV-27).
  - Email chuẩn hoá tường minh (`trim().toLowerCase()`) ở service, không chỉ dựa setter schema. Test tìm bằng email hoa.
  - "Cập nhật trạng thái" User = các field đã có (`emailVerifiedAt`, `failedLoginCount`, `lockedUntil`) — **không** thêm field `status` mới.
  - `FederatedIdentityService.link` **không** tra/tự link theo email (INV-22).
  - Không log/không trả `passwordHash` ngoài hàm verify.

## Đề xuất (không bắt buộc) → đã đưa vào `backlog.md`

- DEBT-008: prefix cookie `__Host-idp_session` khi production (đòi `Secure`, `Path=/`, không `Domain`) — cân nhắc ở X3.
- DEBT-009: `OAuthExceptionFilter` map 401 → `invalid_client`, sai ngữ nghĩa cho request thiếu session; tách xử lý ở B2.5 (UI redirect login).
- DEBT-010: `UserSchema.passwordHash` nên `select: false`; `UserTenant.status` nên có `enum`.
- DEBT-011: audit event cho tạo/huỷ session (INV-25) — thêm action khi làm login/logout B2.4/B2.5.
