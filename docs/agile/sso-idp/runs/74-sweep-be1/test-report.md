# Test Report — 2026-11-07 (run 74, tester)

## Kết quả: PASS

| Cổng | Kết quả |
|---|---|
| Unit be | 675/675 (40 suites) |
| Int full (`pnpm -C be test:int`) | 1477/1477 (56 suites); `vg-int-*` trước 4 → sau 4 (+0) |
| typecheck be / lint be / typecheck e2e | sạch / sạch / sạch (e2e không có script lint) |
| E2E mặc định (`pnpm -C e2e e2e`) | 37/37 (4.4m) |
| X3 (`pnpm -C e2e e2e:x3`, sau E2E, không song song) | 42/42 (9.4m); ca 8 Chromium/Firefox/WebKit ok |
| Probe độc lập DEBT-487 (spec tạm, đã xoá) | 16/16 |
| Probe độc lập DEBT-505 (thêm tạm vào `federation.int-spec.ts`, đã restore md5) | 115/115 (gồm s1–s4 của dev + qa1–qa5) |
| DEBT-489 ×3 (`refresh-token[.]`) | 63/63 ×3 |
| Mutation bỏ stage `$set tenantId` cuối | RED 14/28 (dev 5/5 + probe 9/9) |

Trước mọi lần chạy E2E/X3: các cổng 4000/5173/3000/4100/5273/5274/8443 đều trống (`netstat`). Sau run: `git diff` trùng byte với snapshot lúc bắt đầu, không còn file tạm nào trong repo.

## Lệnh đã chạy + output thực tế

1. Preflight: `codegraph sync` cho kết quả Done. `docker ps` cho thấy `vg-test-mongo`/`vg-test-redis` đang Up. Số DB `vg-int-*` = 4 (4 DB `vg-int-vault-v7-*` của người dùng).
2. **DEBT-487 probe**: tạo tạm `be/test/zz-qa74-probe.int-spec.ts`, dùng Mongo thật `vg-int-qa74probe-<ts>` (spec tự `dropDatabase`). Gọi trực tiếp `TenantScopedRepository.findOneAndUpdate(ctxA, …)`:
   - Pipeline độc hại (10 ca): `$set tenantId {$literal:'tenant-B'}`, `$set {$concat:['tenant-','B']}`, `$set '$status'` (field path), `$set '$$REMOVE'`, `$unset ['roles','tenantId']` (mảng), `$addFields {tenantId, 'nested.x'}`, `$addFields {$toString}` + `meta.tenantId`, `$replaceWith {$mergeObjects:['$$ROOT',{tenantId:'tenant-B'}]}`, multi-stage `$unset`→`$set B`→`$project tenantId:0`, pipeline rỗng. Ca nào cũng thoả: giá trị trả về = doc trước; doc A vẫn `tenantId:'tenant-A'`; doc B cùng `userId` không đổi; tổng vẫn đúng 2 doc.
   - Control: `[{ $set: { roles: ['tenant_admin'] } }]` vẫn áp, tenant giữ A.
   - Filter vượt tenant (5 ca, cả pipeline lẫn object update): `{tenantId:'tenant-B'}`, `$or`, `$and`, `$expr $eq tenant-B`, `{tenantId:{$ne:'tenant-A'}}` đều trả `null`, doc B không đổi.
   - Kết quả: `Tests: 16 passed, 16 total`. Đã xoá file, không còn DB `vg-int-qa74probe-*`.
3. **Mutation** (backup `tenant-scoped.repository.ts` và `git diff` ngay trước khi mutate): `pipeline ? [...update]` (bỏ stage cuối), chạy `pnpm test:int 'tenant-context[.]|zz-qa74-probe[.]'` được `Tests: 14 failed, 14 passed, 28 total`.
   - RED: 5/5 ca DEBT-487 của dev và 9/9 pipeline probe.
   - Vẫn xanh như kỳ vọng: pipeline rỗng, filter, control.
   - Restore xong: md5 `f9ef40bd…` khớp, `git diff` khớp snapshot trước mutate (`cmp` OK). Chạy mutation 2 lần (lần 2 để lấy tên ca), cả hai lần đều restore và kiểm như trên.
4. **DEBT-505**: backup `federation.int-spec.ts` (md5 `1b867776…`), chèn tạm 5 ca vào describe Secure, chạy `pnpm test:int 'federation[.]'` được `Tests: 115 passed, 115 total`, rồi restore (md5 khớp). Các ca thêm:
   - (qa1) Header `Set-Cookie` thô của `start` (Secure): đúng 1 dòng `__Host-idp_fed=` có `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, không có `Domain=`; không có dòng nào `idp_fed=`.
   - (qa2) `start` Secure nhận cookie tossed tên cũ `idp_fed`: binding mới ≠ giá trị tossed, tức không nhận binding của kẻ tấn công.
   - (qa3) `start` Secure nhận `__Host-idp_fed` có sẵn: tái dùng giá trị (2 tab).
   - (qa4) Chế độ http: `Set-Cookie` dùng tên cũ `idp_fed`, `Path=/`, không `Secure`, không `Domain`, không có `__Host-`. Callback chỉ mang `__Host-idp_fed` ⇒ 400, không tạo FI.
   - (qa5) Chế độ http: cả leg với tên cũ ⇒ 302, tạo 1 FI.
   - s1–s4 của dev cũng xanh (gồm `__Host-idp_link` `Path=/`, không Domain; GET `/auth/link` với tên cũ ⇒ 400; POST xoá `__Host-idp_link` `Path=/`).
5. **DEBT-489**: `pnpm test:int 'refresh-token[.]'` ×3 được `Tests: 63 passed, 63 total` cả 3 lần. Ca `DEBT-489: DEBT-415 revokeFamily fault => 5xx …` chạy 206/238/215 ms.
6. `pnpm -C be typecheck` sạch; `pnpm -C be lint` sạch; `pnpm -C e2e typecheck` exit 0; `pnpm -C be test` cho `Tests: 675 passed, 675 total`.
7. `pnpm -C be test:int` cho `Test Suites: 56 passed, 56 total` / `Tests: 1477 passed, 1477 total` (516.6 s). `vg-int-*` = 4 (+0).
8. `pnpm -C e2e e2e` cho `37 passed (4.4m)`, exit 0.
9. `pnpm -C e2e e2e:x3` cho `42 passed (9.4m)`, exit 0. Ca 8: `ok 14 [chromium]`, `ok 28 [firefox]`, `ok 42 [webkit]`.

## So JSON X3 với bảng spec §9.6

So từng ô `e2e/test-results/x3-matrix.json` (lượt chạy của tester) với `runs/74-sweep-be1/x3-matrix.json` (của dev) theo khoá (browser, case, topology) và giá trị (outcome, status, cookieNames, storedSameSite): 42/42 ô, **0 khác**. Đối chiếu bảng §9.6 thấy khớp hết:
- Ca 1: Chromium/Firefox lưu `Lax`, WebKit lưu `None`.
- Ca 4/5 cross-site: Chromium/Firefox không gửi session, WebKit có gửi.
- Ca 6: rejected/ignored, `idp_session` tossed tới IdP.
- Ca 7: cross-site Chromium/Firefox `login_required`, WebKit `code`.
- Ca 8: "signed in; tossed ignored", cookie tới callback = `__Host-idp_csrf, __Host-idp_fed, idp_fed` ở cả 3 trình duyệt.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] T5 DEBT-488: typecheck/lint/unit/int xanh. `user-tenant.service.ts` import `./admin-roles`, `admin.dto.ts` re-export (đọc diff).
- [x] T1 DEBT-487: dev 5 ca + probe 10 pipeline + 5 filter (case 2), mutation ⇒ RED (case 3).
- [x] T4 DEBT-489: ×3 ổn định (case 5).
- [x] T2 DEBT-505: s1–s4 + qa1–qa5, gồm cả Secure và http (case 4).
- [x] T2b X3 ca 8: 3/3 trình duyệt, JSON khớp §9.6 (case 9).
- [x] Cổng: unit 675, int 1477 (+0 DB), E2E 37, X3 42.

## Coverage security invariants / risk matrix
- [x] Authorization / cross-tenant (INV-24): ghi qua pipeline không đổi/xoá được `tenantId`; filter nhắm tenant B (`$or/$and/$expr/$ne`) không chạm doc B (case 2).
- [x] Input / encoded payload: biểu thức `$literal`, `$concat`, field path, `$$REMOVE`, `$mergeObjects $$ROOT` (case 2).
- [x] Credential tossed / replayed: `idp_fed` tên cũ ở `start` không được nhận (qa2), ở callback bị bỏ qua (s2/s3); `__Host-` có `Domain` bị trình duyệt từ chối (X3 ca 8).
- [x] Request chain: start (Set-Cookie) → callback → link GET/POST clear (s1–s4, X3 ca 8 cross-site top-level qua mock Google).
- [x] Dependency failure: `revokeFamily` reject ⇒ 5xx fail-closed, không lộ lỗi, retry revoke (DEBT-489, case 5).
- [x] Exposure: không in giá trị cookie/secret; X3 chỉ đo tên cookie.

Không mở debt mới.
