# Test Report — 2026-11-09 (run 79, sweep 🟡 BE đợt 3)

## Kết quả: PASS (gate đủ, 0 test đỏ; +8 int tester, DEBT-528 đã sửa + đóng)

| Gate (tuần tự) | Kết quả |
|---|---|
| `pnpm -C be typecheck` + `lint` | exit 0 / exit 0 (sau khi thêm test) |
| `pnpm -C be test` | 42 suites, **715/715** |
| `pnpm -C be build` | exit 0 |
| `pnpm -C be test:int` FULL | **60 suites, 1563/1563** (605 s), exit 0 — 1555 của dev + 8 ca tester (+1 suite `run79-tester`) |
| `vg-int-*` trên vg-test-mongo | **4 trước → 4 sau** (chỉ 4 DB `vg-int-vault-v7-*` cũ, đã biết) |
| `pnpm -C fe-admin test` | 67 files, **1570/1570** |
| Cổng 4000/5173/3000 trống ⇒ `pnpm -C e2e e2e` | **38 passed** (4.4 m); `fe-admin-audit.spec.ts:13` ok (DEBT-527 không tái hiện lần này) |
| `pnpm -C e2e e2e:x3` | **42 passed** (9.3 m) ⇒ cổng trống sau |

## Lệnh đã chạy + output thực tế

### 1. DEBT-528 — ca `DEBT-182: %s failing` (`be/test/federation.int-spec.ts`)
- Assert chết cũ: `utModel.countDocuments({ userId: { $in: users.map(_id) } })` sau khi đã có 0 User ⇒ `$in: []`.
- Sửa: spy pass-through `jest.spyOn(UserService.prototype, 'create')` (không mock), đọc `sub` của user tạo TRONG transaction bị abort (`mock.results[0].value`), assert `userModel {_id: sub}` = 0, `utModel {userId: sub}` = 0, FI = 0, và **tổng cả 3 collection trước = sau**; `mockRestore` trong `finally`.
- **Mutation** `user-tenant.service.ts` `addMembership`: `{ session }` ⇒ `{ session: session && undefined }` (ghi UT ngoài transaction). Kết quả:
  ```
  × race x8 with a mid-transaction link failure on one leg ... => no orphan User/UserTenant/FI
  × DEBT-182: link failing (not a duplicate) => original error propagates, nothing provisioned
  √ DEBT-182: addMembership failing ...   (đúng: UT chưa ghi khi chính nó ném)
  Tests: 2 failed, 107 skipped, 6 passed
  ```
  Khôi phục từ backup, sha256 khớp (`e13d91d89a81…`). Trước sửa, ca `link` xanh với mutation này (assert `$in: []`) — đúng nhận định senior.
- Mutation bỏ `session` ở `FederatedIdentityService.link` KHÔNG quan sát được bằng lỗi giữa chừng: FI là insert cuối, sau nó chỉ còn commit ⇒ cần tiêm lỗi commit ⇒ DEBT-530.

### 2. T2 — race thật + lỗi giữa transaction (`federation.int-spec.ts`, +2 ca)
`it.each(['addMembership','link'])` × 8 vòng/ca (vòng chẵn cùng email, lẻ khác email): 2 callback song song cùng `sub`, 1 lời gọi `method` ném lỗi KHÔNG trùng (`mockRejectedValueOnce`).
Assert mỗi vòng: đúng 1 FI cho `sub`; tổng User / UserTenant / FI toàn DB tăng **đúng 1** (không mồ côi ở bất kỳ đâu, kể cả user có id lạ); User theo email = 1; FI.userId tồn tại + có 1 membership default; leg 302 ⇒ session của winner, không `/auth/link`; ≥ 1 leg 5xx, không cookie session, body không chứa text lỗi.
- 8/8 ca race/DEBT-182 xanh (25 s); 2 ca race có sẵn của dev (×10 cùng/khác email) xanh.

### 3. T3 — boot check với `hello` thật (`be/test/run79-tester.int-spec.ts`, 4 ca mới)
Nest `TestingModule` (`MongooseModule.forRoot` vào vg-test-mongo rs0 + `MongoService` + config giả `nodeEnv`), `init()` chạy `onApplicationBootstrap`.
- production + hello thật (`setName:'rs0'`) ⇒ init resolve, 0 WARN/ERROR DEBT-483, `ping()` true.
- production + hello THẬT bỏ `setName/hosts/primary/setVersion` (giả lập standalone; ca kiểm server thật là `rs0`) ⇒ init reject đúng thông điệp cố định, không host:port, không `mongodb://`, không `cause`.
- development + cùng giả lập ⇒ init resolve, đúng 1 WARN, không host.
- production + lỗi driver THẬT (`MongoClient` `mongodb://u:r79-S3CRET@127.0.0.1:1/x`, server selection 800 ms) ⇒ reject thông điệp cố định không `cause`; log error có "could not read the server topology" + `127.0.0.1:1`, không chứa secret.
- 4/4 xanh, jest thoát sạch.
- **Mutation** (`mongo.service.ts`; sha256 khôi phục khớp `350c07a12a89…`): production không throw khi standalone + bỏ scrub ⇒ ca standalone production đỏ (1 failed). Ca lỗi driver vẫn xanh khi bỏ scrub: driver thật không lặp mật khẩu trong message (`ECONNREFUSED 127.0.0.1:1`, như run 78) — scrub là phòng thủ chiều sâu, unit `mongo.service.spec.ts` phủ chuỗi tự viết có secret.
- Ghi nhận: bản thử đầu (close connection rồi gọi hello) treo Jest vì open handle; đã thay bằng client cổng đóng. Một process jest của lần chạy treo (PID 23008, `run79-tester`) vẫn còn — không giữ `vg:int-lock` (PTTL -2), không ảnh hưởng gate; theo ràng buộc không dùng Stop-Process/taskkill ⇒ người dùng tự đóng.

### 4. T1 — audit failure logout `scope=all` persisted thật (`be/test/session-reflection.int-spec.ts`, +2 ca)
Module thật (Redis sessions + Mongo families + `AuditService` ghi `AuditLog`), 2 trình duyệt/user. `it.each` lỗi ở `pre_revoke` (spy `RefreshTokenService.revokeAllForUser`) và `sessions` (spy `sessions.revokeAllForUser`), lỗi mang `mongodb://u:r79-S3CRET@h boom`.
Assert: 5xx, body không có secret; đúng 1 doc `SESSION_REVOKED` failure: `reason:'revoke_failed'`, `targetId = session.ref`, `metadata` đúng 2 khoá `{scope:'all', failedStep}`; JSON doc không chứa session id A/B, csrf, access/refresh token A/B, `r79-S3CRET`, `boom`; 0 audit success.
- 15/15 xanh.
- **Mutation** (`ui.controller.ts`; sha256 khôi phục khớp `5b6d13356035…`): (a) thêm `sid: id` (session id thô) vào metadata ⇒ 2 đỏ; (b) `onFailure` không ghi audit ⇒ 2 đỏ (`Expected length: 1, Received length: 0`).

### 5. Gate
Lệnh như bảng trên, chạy tuần tự; output thật ở scratchpad của phiên. E2E: `38 passed (4.4m)`; X3: `42 passed (9.3m)`; `netstat` trước/sau: 4000/5173/3000 không LISTENING.

## Test FAIL
(không có)

## Coverage acceptance criteria
- [x] T1 AC(1)(2)(4) — `ui.int-spec` (dev) + `session-reflection` DEBT-521 ×2 (tester, store thật); AC(3) — `ui.int-spec` ca audit ném (dev).
- [x] T5 — `admin-api.int-spec` (dev); int full xanh.
- [x] T4 — `seed-risk.int-spec` NotWritablePrimary + `seed-dev.int-spec` đổi tên (dev); typecheck 0.
- [x] T6 — `keys.spec` DEBT-168 (dev); unit 715.
- [x] T3 — `mongo.service.spec.ts` 6 ca (dev) + `run79-tester.int-spec` 4 ca hello thật (tester).
- [x] T2 AC(1)(2) — ca DEBT-182 (đã sửa DEBT-528); AC(3) — race ×10 cùng/khác email (dev) + race có lỗi giữa chừng ×8 ×2 (tester); AC(4) — luồng provision Google/GitHub hiện có xanh.

## Coverage security invariants / risk matrix
- [x] State/concurrent — 2 callback song song cùng identity, có/không lỗi giữa transaction (T2).
- [x] Dependency partial failure — lỗi insert membership/FI (T2), lỗi Mongo/Redis ở bước revoke (T1), lỗi driver khi đọc `hello` (T3): fail-closed, không che thành success.
- [x] Exposure — response body (T1, T2), audit sink (T1), log khởi động + message lỗi (T3): không secret/URI/token.
- [x] Identity — logout bởi chính user; negative actor (user khác không bị đụng) phủ bởi ca run 78 trong cùng describe.
- [ ] Commit-time failure sau insert FI (mutation bỏ `session` ở `link`) — DEBT-530 (không chặn: code hiện tại đúng, đã đọc).
