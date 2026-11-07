# Senior Review — 2026-11-07 (run 74, sweep 🟡 BE đợt 1)

## Kết luận: PASS

Phạm vi review: T1 (DEBT-487), T2 (DEBT-505), T2b (X3 ca 8), T4 (DEBT-489), T5 (DEBT-488). T3 (DEBT-321) đã hoãn sang run 75 nên không review. Bỏ qua `.vscode/mcp.json` và `.mcp.json`.

Reviewer tự chạy lại: `pnpm -C be typecheck` xanh; `test:int -- "tenant-context[.]int"` 12/12 xanh (gồm 5 ca DEBT-487). Không chạy lại int full, E2E hay X3 vì không có điểm nghi ngờ; số liệu dev ghi trong log là unit 675, int 1477, E2E 37, X3 42.

## Tổng quan (ấn tượng chung + điểm tốt)

- Diff khớp hợp đồng § Fold. Phần code chỉ thêm hoặc bớt khoảng 20 dòng ở 5 file, không có thay đổi ngoài phạm vi.
- DEBT-487: chỉ cần một stage `$set` nối cuối là đóng được cả lớp lỗi, kể cả stage chưa biết, và không phải duy trì allowlist. Lựa chọn này đúng tinh thần YAGNI.
- DEBT-505: đã đổi đủ cả 9 chỗ dùng tên cookie: 5 chỗ đọc, deviceId của rate-limit, 2 `setCookie` và `clearCookie`. Tên cookie được tính một lần trong constructor bằng helper `hostCookieName` sẵn có từ DEBT-008. Khi Secure, code chỉ đọc tên mới, không còn fallback về tên cũ.
- Test Secure s1–s4 dựng một app phụ chỉ gồm `FederationController`. App phụ dùng chung instance thật của `FederationService`, `RateLimitService` và `CsrfService`, cùng Mongo/Redis/mock provider. Chỉ `ConfigService` bị override, và chỉ ở `session.cookieSecure`. Vì vậy logic state, binding và link đều chạy thật, không bị mock mất. Ca s2 còn chứng minh state đã bị tiêu: gửi lại với cookie đúng vẫn nhận 400.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Tenant isolation (DEBT-487)**:
  - Ở `tenant-scoped.repository.ts:70`, stage nối cuối chạy sau mọi stage, nên `$unset` dạng string, `$replaceWith`, `$replaceRoot`, `$project` và `$set` sang tenant khác đều bị ghi đè về tenant của ctx.
  - Pipeline rỗng `[]` thành `[$set ctx]`, tức no-op an toàn.
  - Filter vẫn qua `scope()`, nên không với tới doc của tenant B. Test có kiểm doc tenant B không đổi.
  - Nhánh object vẫn qua `withoutTenantId`. Ở nhánh này `$unset` dạng string không hợp lệ với Mongo, và `$rename` tới `tenantId` đã bị lọc theo target.
  - `options` chỉ nhận `session`, nên không có `upsert` để vượt `scope`.
  - Các pipeline khác trong repo (`user.service.ts`, `consent.service.ts`) gọi thẳng model của collection global hoặc collection không có tenant, nên nằm ngoài bất biến này.
  - Caller run 69 `replaceRoles` (`$set roles`) không đổi hành vi; caller thứ hai `client.service.ts:338` dùng update dạng object nên không chịu ảnh hưởng.
- **Cookie federation (DEBT-505)**:
  - Khi Secure, prefix `__Host-` được trình duyệt ép host-only, `Path=/` và `Secure`. X3 ca 8 đo được trên 3 trình duyệt rằng `__Host-idp_fed; Domain=…` bị từ chối và `idp_fed` bị tossed thì bị server bỏ qua.
  - HttpOnly và `SameSite=Lax` giữ nguyên, maxAge vẫn 600.
  - `Path=/` làm cookie `idp_fed`/`idp_link` (opaque 256-bit, không phải credential) đi kèm mọi request tới IdP. Mức lộ không tăng đáng kể: cả hai đều HttpOnly, không endpoint nào phản chiếu cookie, và pino redact `req.headers.cookie` cùng `res.headers["set-cookie"]` (`logger.module.ts:26-27`).
  - Rate-limit deviceId dùng cùng tên với cookie được set, nên giới hạn theo thiết bị vẫn hiệu lực.
  - CSRF identity của form link (`formCsrfIdentity`) không dựa vào cookie federation, nên không bị ảnh hưởng.
- **Failure behavior (DEBT-489)**:
  - Ca mới spy đúng instance (`refreshSvc`), cho `revokeFamily` ném lỗi, và nhận 500.
  - Body không lộ message, `familyId` hay stack.
  - Có đúng 1 audit `resource_not_allowed` kèm metadata.
  - Family vẫn sống và không phát sinh `TOKEN_REUSE_DETECTED`.
  - Sau restore, retry nhận 400 `invalid_grant` và family bị revoke. Như vậy nhánh fail-closed được kiểm thật, và theo log mutation m1/m2 đều RED.
- **DEBT-488**: chỉ chuyển nguyên văn 2 dòng và re-export, không đổi hành vi. Trong `identity` không còn import nào từ `../admin`.
- **Exposure**: test X3 ca 8 so khác giá trị cookie bằng boolean và không in giá trị. JSON ma trận chỉ chứa tên cookie.

## 🟡 Nên sửa

- [ ] `e2e/x3/cookie-matrix.spec.ts:398`: ca 8 chỉ assert `__Host-idp_fed` có mặt ở callback, chưa assert `idp_fed` bị tossed cũng được gửi tới callback. Spec §9.6 lại ghi "`idp_fed` tossed (`Path=/auth/`) đến callback nhưng bị bỏ qua". Số liệu thật trong `x3-matrix.json` có `idp_fed` ở cả 3 trình duyệt, nên doc hiện vẫn trung thực. Nhưng nếu sau này trình duyệt không gửi cookie tossed nữa, ca vẫn xanh và phần "bị bỏ qua" thành vacuous. Đề xuất: thêm `expect(c.cookieNames).toContain("idp_fed")` (1 dòng). Ghi thành DEBT-514.

## 💭 Nit

- `e2e/x3/cookie-matrix.spec.ts:395`: `fed[0].value !== TOSS` gần như luôn đúng, vì L368 đã chứng minh `__Host-` tossed bị từ chối. Assert vô hại nhưng không thêm tín hiệu; nếu muốn giữ thì `expect(fed[0].value).not.toBe(TOSS)` đọc rõ hơn và vẫn không in giá trị ra log khi pass.
- `be/test/federation.int-spec.ts` s4: đã kiểm GET `/auth/link` với tên cũ thì nhận 400, nhưng chưa kiểm POST với tên cũ. Lỗ hổng không đáng kể vì code đọc qua cùng một field `this.linkCookie`.
- `be/test/refresh-token.int-spec.ts`: `spy.mockRestore()` được gọi cả trong `try` lẫn `finally`. Lần gọi trong `try` là cần cho bước retry, còn lần trong `finally` là idempotent, nên giữ nguyên được.

## ✂️ Ponytail

Lean already. Ship.
