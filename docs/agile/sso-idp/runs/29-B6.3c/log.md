# Log — run 29 — B6.3c (keys + tenants) + DEBT-145/125/132/154

## orchestrator — 2026-10-16
- Task 4 run 28 chuyển sang (DEBT-146). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ `runs/28-B6.3b/tasks.md` mục "Task 4 — CHUYỂN run 29" + backlog DEBT-145 (bắt buộc), 125, 132, 154. Cổng → tech-lead.

## tech-lead — 2026-10-16
- Kết luận **PASS** với fold bắt buộc trong `tasks.md` (mục "Fold tech-lead"); chi tiết ở `review-techlead.md`.
- Q-29.1: keys GET và rotate chỉ dành cho super_admin. Q-29.2: emergency không revoke session/refresh, vì chúng opaque và không ký bằng key. Q-29.3: luôn revoke khi disable.
- Lỗ mới, cùng gốc DEBT-145: `getPublicKeys()` prune bằng `writeState` ngoài mutex, nên có thể hồi sinh key cũ (đã lộ) thành active và làm mất key mới. Fold: hàm này chỉ đọc, prune chuyển vào rotate. Kèm theo: retry ENOENT trong `getSigningKey`, test race tất định qua seam `atomicRename`.
- Task 3: index `RefreshToken {clientId:1}` (cần `db:sync-indexes` dev/E2E, chỉ thêm index); DEBT-132 dùng `updateOne` có điều kiện (không dùng `$min` hay pipeline). Task 4: filter `lockedUntil: {$not: {$gt: now}}` phủ cả admin lock lẫn brute-force lock.
- Debt mới: DEBT-156…160. Chuyển → backend-dev (Task 1 → 2; Task 3, 4).

## backend-dev — 2026-10-16
- Security gate: tài sản = signing key/JWKS, refresh family của client disable, lock tài khoản; actor super_admin (keys) / tenant_admin (tenants mình, disable client tenant mình); fail-closed: ghi `keys.json` lỗi ⇒ key cũ active + audit failure best-effort; revoke lỗi ⇒ client vẫn disabled, 5xx, retry idempotent; exposure: keys `{kid,alg,status,createdAt,retireAt}`, tenants `{id,name}`, log chỉ kid.
- T1 DEBT-145: mutex promise-chain trong `LocalKeyProvider.rotate`; `getPublicKeys`/`listKeys` chỉ đọc, prune trong rotate; `getSigningKey` đọc lại 1 lần khi ENOENT; README + docblock ghi 1 process/1 node (DEBT-159). Test race tất định (`GatedKeyProvider` chặn `atomicRename`). Mutation: gỡ mutex ⇒ 2 RED; ghi lại trong getPublicKeys ⇒ spy RED; bỏ retry ENOENT ⇒ RED.
- T2: `AdminKeysController` (super_admin GET + rotate step-up, DTO `{mode}`), `AdminTenantsController`, `KeyRotationService.rotate(mode, auditBase)` + `list()`, `TenantService.list`, `toAdminTenant`. Int `admin-keys.int-spec` 18 (normal/emergency 3 endpoint, refresh cũ vẫn 200 sau emergency, 403/step_up/400, exact key set, audit, tenants + cursor 400, OpenAPI). Mutation bỏ gate ⇒ 4 RED.
- T3 DEBT-125/132: `revokeForClient` (`RevokeFilter {clientId}`, fail-closed khi rỗng) gọi ở mọi disable; `disabledAt` stamp bằng `updateOne` điều kiện `disabledAt:null`; index `RefreshToken {clientId:1}`. Int 5 ca (`admin-api`), unit 2. Mutation bỏ revoke ⇒ 3 RED; `$set disabledAt:new Date()` ⇒ RED.
- T4 DEBT-154: `UserService.clearFailedLoginsIfUnlocked`; null ⇒ audit LOGIN_FAILED + 401 chung (body chuẩn hoá trùng sai mật khẩu), không session. Int `ui-auth` 3 ca (admin lock, brute-force lock, login thường). Mutation `resetFailedLogins` ⇒ 2 RED.
- Verify: typecheck/lint sạch; `pnpm -C be test` 254/254; `pnpm -C be test:int` 651/651 (650 + 1 OpenAPI); `pnpm -C e2e e2e` 12/12. Mọi file mutation khôi phục bằng cp + sha256 khớp.
- Người dùng cần chạy `pnpm -C be db:sync-indexes` cho DB dev/E2E (chỉ thêm index `RefreshToken {clientId:1}`); KHÔNG chạy ở đây. Debt mới: DEBT-161, DEBT-162. Chuyển → senior-reviewer.

## senior-reviewer — 2026-10-16
- Kết luận **PASS**, không có 🔴. Chi tiết ở `review-senior.md`. Đã tự chạy: typecheck sạch, unit 254/254, int `admin-keys`/`admin-api`/`ui-auth`/`indexes` 77/77.
- Invariant đã kiểm:
  - Mutex rotate: không mất key đang ký, key đã lộ không quay lại.
  - Read path không ghi; `getSigningKey` retry ENOENT.
  - Emergency ⇒ 401 ở cả 3 endpoint.
  - Role super_admin đọc từ DB mỗi request, kèm step-up.
  - Không lộ key material ở response, log, audit.
  - Revoke khi disable: stamp-first, fail closed, có đường retry.
  - Login vs lock: atomic, thông điệp chung.
- 🟡 mới: DEBT-163 (emergency: process chết sau khi ghi state, trước `rm` ⇒ PEM đã lộ nằm lại trên đĩa, không có log).
- 💭: teardown int quit Redis 2 lần; `disabledAt` ở response lệch vài ms khi 2 lần disable song song (xử lý chung với DEBT-161).
- Chuyển → tester.

## tester — 2026-10-16
- Kết luận **PASS**. Chi tiết và output ở `test-report.md`.
- Số liệu: typecheck/lint sạch; BE unit 254/254; BE int 660/660 (651 + 9 test tester mới); FE 240/240; E2E 12/12.
- Bổ sung `admin-keys.int-spec` (7 test): không token/rác/hết hạn/sai aud trả 401; member/non-member/admin qua client tenant khác trả 403 (keys + tenants); rotate normal ×3 + vượt retention ⇒ token của key retiring hết hạn trả 401, rotate prune bền; rotate song song qua HTTP (normal∥normal, normal∥emergency).
- Bổ sung `admin-api.int-spec` (2 test): code phát trước disable, refresh, cc sau disable và sau enable; 5 disable đồng thời.
- Mutation: bỏ prune ⇒ 1 RED; bỏ revoke ⇒ 2 RED; gỡ mutex ⇒ 2 RED (3/3 lần), có lần ra 500. Khôi phục bằng cp, sha256 khớp.
- Không có 🟡 mới. Người dùng vẫn cần chạy `db:sync-indexes` cho dev/E2E. Chuyển → orchestrator đóng run.
