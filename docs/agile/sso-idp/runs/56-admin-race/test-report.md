# Test Report — 2026-10-26 (run 56, tester)

## Lượt 2 (sau retry 2 + senior vòng 3 PASS) — Kết quả: PASS

Quyết định người dùng 2026-10-26: DEBT-420 (L6 lock ∥ unlock không barrier) không sửa trong run 56, gộp với DEBT-422 sang run 57.

### Thay đổi test (không đụng code sản phẩm)
- `be/test/run56-tester.int-spec.ts`: L6 → `it.skip` (quarantine, giữ nguyên thân test) kèm comment trỏ DEBT-420/run 57 và cách bật lại (đổi `it.skip` → `it`). L5 (barrier) và mọi test khác giữ nguyên.
- Thêm L8 (nit DEBT-423): super lock 2 lần ⇒ 2 `ADMIN_USER_LOCKED success` + 2 `SESSION_REVOKED success` có metadata `{scope:'all', via:'lock'}`.
- `e2e/tests/fe-admin-audit.spec.ts` (DEBT-423): bước SESSION_REVOKED assert `targetId` trên URL = userId, dòng có link tới `/users/<userId>`, và trong vùng Details của chính dòng đó (`aria-controls` → region "Metadata") có term `via` + definition `lock`, term `count` + definition số.

### Lệnh đã chạy + output thực tế (Git Bash, foreground)
`codegraph sync` Done. `vg:int-lock` trống trước khi chạy (TTL -2). Cổng :4000/:5173/:3000 trống trước và sau E2E; `E2E_REUSE` không đặt. Không start/stop/restart process hay container nào.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be typecheck` | exit 0 |
| 2 | `pnpm -C be lint` | sạch |
| 3 | `pnpm -C be test` | 37 suites, **589/589** |
| 4 | `pnpm -C be test:int` (full, 1 lượt, không shard) | 51 suites, **1347 passed, 1 skipped (L6), 1348 total** |
| 5 | `pnpm -C be test:int --testPathPatterns run56-tester -t "L5\|L6\|L8" --verbose` | L5 ✓ (152 ms), L8 ✓ (154 ms), L6 skipped |
| 6 | `pnpm lint` (root) | be/fe-admin/fe-sso-test Done |
| 7 | `pnpm -r run typecheck` | be/fe-admin/fe-sso-test/e2e Done |
| 8 | `pnpm test` (root) | be 589/589; fe-admin 64 files **1416/1416**; fe-sso-test 31 files **269/269** |
| 9 | `pnpm audit --audit-level high` | 6 low, 7 moderate, 0 high (1 high ignored theo cấu hình sẵn có) |
| 10 | `pnpm -C e2e e2e` (1 lần) | exit 0, **35 passed (4.1m)**; `fe-admin-audit.spec.ts` ok (4.6s) |

Grep secret trên log E2E (JWT `eyJ…\.…`, `client_secret=`, `password=`, `vgs_…`, `BEGIN … PRIVATE`): 0 dòng. Log int không lưu riêng; phơi nhiễm phía int do X1 trong `run56-tester` kiểm (xanh).

### Coverage
- [x] DEBT-423 — E2E `fe-admin-audit` (targetId URL + link + `via`/`lock` + `count` trong Details của đúng dòng) + int L8. **Đóng.**
- [x] DEBT-421 — int `admin-users` + E2E (xanh).
- [x] DEBT-147/153/166/209/156 — các test tester lượt 1 (L1–L5, L7, R1–R4, D1–D2, X1) xanh trong full int.
- [ ] DEBT-420 — L6 quarantine (`it.skip`), chuyển run 57 cùng DEBT-422 theo quyết định người dùng. Không tính là PASS của invariant này.

---

## Lượt 1

## Kết quả: FAIL (2/14 test tester FAIL; mọi suite khác xanh)

- FAIL thuộc **DEBT-147** (lock ∥ unlock): sau khi chạy song song, DB đã mở khoá nhưng audit trail kết thúc ở `ADMIN_USER_LOCKED success`. Lỗi tái hiện cả khi có barrier (L5) lẫn khi chạy đồng thời thật, không barrier (L6: **8/10 vòng**). Chi tiết ở "Test FAIL" bên dưới.
- Các phần còn lại PASS: DEBT-166 (race secret, cả hai thứ tự), DEBT-153 (mức khoá), DEBT-209/156 (disable → enable), không hồi quy run 54/55, E2E 35/35.
- Chuyển lại **backend-dev** (Task 2). Theo dõi ở DEBT-420 🔴. Mục này chặn run, không được chuyển thành debt để PASS.

## Lệnh đã chạy + output thực tế

Preflight: `codegraph --version` cho 1.6.2; `codegraph status` báo up to date (index do v1.5.0 build); `codegraph sync` báo Done. Container `vg-test-mongo` và `vg-test-redis` đã Up sẵn, không phải start hay restart. Các cổng :4000, :5173, :3000 trống trước và sau E2E. `E2E_REUSE` không được đặt.

| # | Lệnh (Git Bash, foreground) | Kết quả |
|---|---|---|
| 1 | `pnpm -C be typecheck` | exit 0 |
| 2 | `pnpm -C be lint` | exit 0 |
| 3 | `pnpm -C be test` (unit) | Test Suites 37/37, Tests **589/589** |
| 4 | `pnpm -C be build` | Done (OK) |
| 5 | `pnpm -C be test:int -- run56-tester` (spec mới) | **12/14**: L5 và L6 FAIL (ổn định qua 3 lần chạy) |
| 6 | `pnpm -C be test:int` (full, giữ lock `vg:int-lock` bình thường) | Suites 50/51, Tests **1344/1346**. Chỉ fail `run56-tester` L5 và L6. 1332 test của dev đều xanh |
| 7 | `pnpm lint` (root) | exit 0 |
| 8 | `pnpm -r run typecheck` | exit 0 |
| 9 | `pnpm test` (root) lần 1 | exit 0: be 589/589, fe-admin 1416/1416 (64 files), fe-sso-test 269/269 (31 files) |
| 10 | `pnpm test` (root) lần 2 | exit 0: số liệu y hệt lần 1, không flaky |
| 11 | `pnpm audit --audit-level high` | exit 0: 13 vuln (6 low, 7 moderate), 1 high đã ignore sẵn |
| 12 | `pnpm -C e2e e2e` (full, 1 lần) | exit 0, **35 passed (4.0m)** |
| 13 | grep secret trên toàn bộ log | `eyJ…` (JWT) = 0, `clientSecret":"…` = 0, `passwordHash":"$argon` = 0 |

Case L5 và L6 FAIL (trích output):

```
× L5 lock written but held before its audit; super unlock completes; released => trail must end on the DB state (unlocked)
    Expected: "ADMIN_USER_UNLOCKED"
    Received: "ADMIN_USER_LOCKED"
× L6 10 rounds super lock || super unlock (from tenant-locked) => final DB state == last success event of the trail
    + "round 0: db locked=false, trail ends ADMIN_USER_LOCKED"   (… các vòng 1,2,3,5,6,8,9 cũng vậy)
```

### Mutation (spec mới; backup sha256, khôi phục byte-identical)

Chỉ chạy `run56-tester`. Sau mỗi mutation, sha256 của file trùng với bản gốc, và `git diff --stat -- be/src` không đổi (12 files, +252/−47).

| Mutation | Test RED |
|---|---|
| m1: `recheckIssued` return sớm (bỏ đọc lại) | R1, R3, R4 (+ L5, L6 vốn đã đỏ) |
| m2: `mintedBeforeDisable` luôn trả `false` | D1, D2 |
| m3: bỏ điều kiện mức trong `tenantAdminMayChangeLock` (`$or:[{}]`) | L1, L2, L7 |

Lượt m2 đầu tiên lỗi biên dịch (TS18049), nên không tính. Đã chạy lại bằng biến thể hợp lệ về kiểu.

## Test FAIL

**L5 / L6: lock ∥ unlock làm audit trail kết thúc sai trạng thái DB (DEBT-147).**

- Kỳ vọng: khi DB cuối cùng ở trạng thái mở khoá (unlock ghi sau lock), sự kiện success cuối cùng trong trail (theo `timestamp`) phải là `ADMIN_USER_UNLOCKED`. Đây cũng là điều fold (g) yêu cầu: "UNLOCKED ghi sau LOCKED".
- Thực tế:
  - DB `lockedUntil` đã được xoá, nhưng trail là `UNLOCKED success` rồi mới đến `LOCKED success`.
  - Người đọc audit hoặc SIEM sẽ kết luận user đang bị khoá trong khi thực tế đã mở.
  - Unlock vẫn có đúng 1 audit, nên I3 về số lượng audit vẫn đạt.
  - Lỗi tái hiện bằng request HTTP đồng thời thật, không cần barrier, ở 8/10 vòng.
- Nguyên nhân nghi ngờ:
  - `AdminUsersController.lock` (`admin-users.controller.ts:159-183`) ghi sentinel qua `adminLock` trước, sau đó `await revokeAllUserCredentials` (Redis + Mongo, chậm), rồi mới ghi audit `LOCKED success`.
  - Một unlock chen vào khoảng giữa sẽ ghi DB và audit `UNLOCKED` trước, nên audit `LOCKED` (ghi sau) trở thành sự kiện cuối.
  - Test (g) của dev chỉ phủ thứ tự ngược lại: unlock bị giữ trước khi ghi, lock hoàn tất.
- Hướng sửa: để backend-dev chọn. Hai ví dụ:
  - Ghi audit LOCKED ngay sau câu ghi khoá, trước khi revoke, và vẫn giữ audit `revoke_failed` riêng như DEBT-152.
  - Hoặc sau khi revoke thì đọc lại user. Nếu không còn bị admin-khoá thì audit lock phải phản ánh điều đó (ví dụ `metadata.superseded`), hoặc thứ tự ghi phải bảo đảm trail khớp DB.
  - Cách nào cũng phải giữ yêu cầu của DEBT-152 (retry sau `revoke_failed` không được để trail kết thúc ở failure).

## Coverage acceptance criteria

Spec mới: `be/test/run56-tester.int-spec.ts`, 14 case, chạy trên app thật (`bootFullApp`) qua HTTP: admin API, `/token`, `/introspect`, `/userinfo`, `/authorize`, `/authorize/consent`.

- [x] T3 (a) giữ sau insert, grant xen vào ⇒ 403, không trả plaintext, có audit failure: dev (a) + **R1** (biến thể **ROTATE** với v1 có sẵn: v1 cũng chết ⇒ 401 tại `/token`; đúng 1 audit `ROTATED failure admin_granted_concurrently` với `version:2`)
- [x] T3 (b) giữ trước insert: dev (b) + **R3** (barrier kép: tenant giữ trước insert, super giữ sau update/trước revoke#2 ⇒ đọc lại thấy admin, tự revoke, 403, đúng 1 audit failure, 0 version sống trước cả revoke#2)
- [x] Thứ tự ngược (super giữ giữa revoke#1 và update): **R2**. Tenant nhận 201 khi client chưa admin-capable. Ngay khi grant hoàn tất, plaintext đó trả 401 (bị revoke#2). Đúng 1 audit `CREATED success`
- [x] Không barrier, 10 vòng issue ∥ grant: **R4**. Mọi 201 đều chết sau grant, 0 version sống, audit nhất quán (201 ⇔ đúng 1 success)
- [x] T3 (c)(d)(e): test của dev, chạy xanh trong full int
- [x] T2 (a)(c) super lock ⇒ tenant unlock 403 + audit failure; tenant lock không hạ mức: dev + **L1** (kiểm toàn bộ trail theo thứ tự)
- [x] T2 (d) sentinel cũ không mức ⇒ coi là super_admin: dev + **L2**
- [x] T2 (e) brute-force lock ⇒ tenant_admin mở được: dev + **L3** (counter về 0, đúng 1 audit)
- [x] T2 (f) N unlock song song ⇒ 1 audit: dev (barrier) + **L4** (5 vòng × 8 unlock đồng thời thật, super/tenant trộn ⇒ đúng 1 success mỗi vòng)
- [ ] **T2 (g) unlock ∥ lock ⇒ trail kết thúc đúng trạng thái DB: FAIL (L5, L6)**
- [x] super lock ∥ tenant unlock: **L7**, 8 vòng, luôn kết thúc ở trạng thái khoá mức `super_admin`
- [x] T2 (h): test của dev, xanh
- [x] T1 (a)(d)(e) disable → enable (<60 s) ⇒ mọi artefact tạo trước disable đều chết: **D1**
  - code ⇒ `invalid_grant`, kèm 1 audit `client_disabled`
  - AT ⇒ `/introspect` trả `active:false`, `/userinfo` trả 401
  - RT ⇒ `invalid_grant` (không hồi quy run 35/36)
  - consent context ⇒ trang 400 first-party, không `Location`, không mint code mới
  - login context resume ⇒ 400
- [x] Client chưa từng disable không bị ảnh hưởng: phần đối chứng của **D1** (code 200, AT active, RT 200, consent 302 kèm code, resume 302 kèm code)
- [x] Artefact tạo sau enable + margin thì sống: **D2** (`lastDisabledAt` lùi 10 s ⇒ code/AT/userinfo/RT/consent/resume đều OK). Artefact tạo ngay sau enable, còn trong margin 5 s, bị từ chối đúng thiết kế
- [x] T1 (b)(c)(f)(g)(h) và các race barrier: test của dev, xanh
- [x] Không hồi quy run 54 (`debt388-sign-before-commit`, `run54-tester`) và run 55 (`run55-tester`): đều nằm trong full int, xanh

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity / Authorization | tenant_admin vs super_admin; tenant_admin trên khoá của super/khoá cũ/brute-force | L1, L2, L3, L7, R1–R4 |
| Credential | secret v1 cũ + v2 mới sau grant ⇒ 401; plaintext đã trả ⇒ chết sau grant | R1, R2, R4 |
| State | consumed/replay: code/RT/AT/context cũ sau re-enable; enable trong margin vs sau margin | D1, D2 |
| Concurrency | barrier hai chiều cho secret; N unlock; lock ∥ unlock; super lock ∥ tenant unlock | R1–R4, L4–L7 |
| Request chain | consent POST và login resume sau disable/enable; refresh sau disable | D1 |
| Exposure | log pino + toàn bộ audit không chứa JWT hay plaintext secret nào đã trả | X1; grep log lệnh = 0 |

Kết quả theo invariant:
- **I1** đạt (R1–R4).
- **I2** đạt (L1, L2, L7).
- **I3** chỉ đạt một phần:
  - Số lượng audit đúng (L4; L5 cũng thấy đúng 1 UNLOCKED).
  - Thứ tự trail sai so với DB, nên **FAIL** (L5, L6).
- **I4** đạt (D1, D2).
- Run 54/55 giữ nguyên.

## Dọn dẹp

- Không kill/stop/restart process hay container nào. Không compose, không FLUSH.
- Không đụng `be/keys`, `be/.env`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.
- Không sửa code sản phẩm, không cài package, không commit.
- File mới duy nhất ngoài docs: `be/test/run56-tester.int-spec.ts`.
