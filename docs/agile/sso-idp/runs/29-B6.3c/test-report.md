# Test Report — 2026-10-16 — run 29 (B6.3c)

## Kết quả: PASS

| Bộ | Kết quả |
|---|---|
| BE typecheck + lint | sạch (exit 0) |
| BE unit `pnpm -C be test` | 254/254 (23 suite) |
| BE int `pnpm -C be test:int` (vg-test-mongo@27117, vg-test-redis@6479) | **660/660** (28 suite) = 651 của dev + 9 test tester mới |
| FE `pnpm -C fe-sso-test test` | 240/240 (31 file) |
| E2E `pnpm -C e2e e2e` (1 lần) | 12/12 (44.9s) |

Không có lỗi [BE]/[FE].

## Lệnh đã chạy và output thực tế

1. `pnpm -C be typecheck && pnpm -C be lint && pnpm -C be test` (baseline, trước khi thêm test): `Test Suites: 23 passed` / `Tests: 254 passed, 254 total`, exit 0.
2. Chạy riêng test mới, có filter: `jest --runInBand --forceExit --globalSetup ./test/int-preflight.mjs --testRegex "(admin-keys|admin-api)\.int-spec\.ts$" -t "run 29 QA"` cho ra `Tests: 54 skipped, 9 passed, 63 total`.
3. Lần chạy cuối, sau khi thêm test: `pnpm -C be lint && pnpm -C be typecheck && pnpm -C be test` cho `Tests: 254 passed, 254 total`, EXIT=0. Sau đó `pnpm -C be test:int` cho `Test Suites: 28 passed, 28 total` / `Tests: 660 passed, 660 total`, EXIT=0.
4. `pnpm -C fe-sso-test test`: `Test Files 31 passed (31)` / `Tests 240 passed (240)`, EXIT=0.
5. `pnpm -C e2e e2e`: `12 passed (44.9s)`, EXIT=0. Trước khi chạy, :5173 và :4000 đều trống nên không phải dừng process nào. Sau khi chạy, Playwright đã tự dừng webServer, không còn listener nào trên hai cổng đó.
6. Prettier `--check` trên 2 file test vừa sửa: `All matched files use Prettier code style!`

Log teardown `ERROR [Testing] Error: Connection is closed.` có xuất hiện trong output. Đây là chỗ Redis bị quit 2 lần, đã ghi ở 💭 senior, và không làm test fail.

## Mutation (sao lưu bằng cp, khôi phục bằng cp, `sha256sum -c` đều OK)

| Mutation | Test bắt được |
|---|---|
| M1: rotate không prune (`...entries.map` thay cho `live(entries, now)`) | RED 1 — "rotate normal x3 then past retention" |
| M2: disable không revoke (`revoked = 0`) | RED 2 — cả 2 test "run 29 QA … after disable" |
| M3: gỡ mutex (`rotateExclusive` gọi thẳng) | RED 2/2 test song song qua HTTP, lặp lại 3 lần đều RED. Một lần quan sát được normal ∥ emergency trả **500** khi không có mutex: mutex là thứ chặn lỗi này. |

File khôi phục: `be/src/modules/keys/local-key-provider.ts` (c636ad7e…), `be/src/modules/admin/admin-clients.controller.ts` (51cc49c0…).

## Test bổ sung của tester (9 test, đều PASS)

`be/test/admin-keys.int-spec.ts` — describe `run 29 QA (tester) — keys/tenants risk matrix`:
1. Case 1–3 (`it.each`, gồm GET /admin/keys, POST /admin/keys/rotate, GET /admin/tenants): gọi không token, token rác, token hết hạn, token sai audience (demo) đều trả 401 `invalid_token`, có `no-store`, JWKS không đổi.
2. Case 4: các token sau đều bị 403 `forbidden` ở keys (GET, POST) và tenants, JWKS không đổi:
   - member không có role;
   - end user không thuộc tenant A;
   - tenant_admin của tenant nodoc dùng client A;
   - tenant_admin A dùng client nodoc;
   - super_admin A dùng client nodoc (role tính theo tenant).

   Ngoài ra tenant_admin A với `limit=100` chỉ thấy `[A]`.
3. Case 5: rotate normal 3 lần liên tiếp, ra K0→K1→K2→K3.
   - Trong cửa sổ retention: AT của K0..K3 đều 200 ở `/admin/me`, user AT của K0 200 ở `/userinfo`. Có đúng 1 key active, PEM chỉ còn K3.
   - Lệch `Date.now` qua `ACCESS_TOKEN_TTL`: JWKS chỉ còn K3; AT ký bằng K0..K2 bị 401 ở `/admin/me`, user AT K0 bị 401 ở `/userinfo` và `/demo/me`. jose kiểm `exp` bằng đồng hồ thật, nên 401 ở đây là do key bị gỡ chứ không phải do token hết hạn. Lúc này `keys.json` vẫn còn 4 entry, vì đường đọc không ghi.
   - Rotate tiếp theo prune: `keys.json` còn `{K3 retiring, K4 active}`. Quay về đồng hồ thật thì K0..K2 vẫn 401, nghĩa là prune đã được ghi bền. PEM chỉ còn K4.
4. Case 6: gửi 2 rotate normal song song qua HTTP. Cả hai 200, kid khác nhau và nối chuỗi đúng (oldKid của lần 2 = newKid của lần 1). Có đúng 1 active, JWKS chứa cả 3 kid, PEM chỉ của active, token cũ vẫn 200.
5. Case 7: gửi normal ∥ emergency song song qua HTTP. Không có 5xx; mỗi request trả 200, hoặc 401 nếu bị xác thực sau khi emergency đã gỡ key. Nếu emergency 200 thì kid trước rotate không còn trong JWKS. Có đúng 1 active và AT mới ký bằng nó đạt 200. `GET /admin/keys` khớp JWKS, PEM chỉ của active. Không audit `SIGNING_KEY_ROTATED` nào chứa key material.

`be/test/admin-api.int-spec.ts` — describe `run 29 QA (tester) — /token grant paths after disable (DEBT-125)`:

8. Case 8: kiểm các đường grant sau khi disable client.
   - Đối chứng trước: code mint như `/authorize` → `/token` trả 200 kèm refresh.
   - Một code khác mint TRƯỚC khi disable rồi đổi SAU khi disable: không 200, không có `access_token`, lỗi thuộc {`invalid_client`, `invalid_grant`}.
   - Refresh khi đang disable: không 200.
   - `client_credentials`: 400, không token. Grant này không được hỗ trợ (`unsupported_grant_type`), nên không có đường cc để kiểm thêm.
   - Enable lại: refresh cũ vẫn `invalid_grant` và không còn family nào sống. Code mới sau khi enable thì 200, client không bị khoá vĩnh viễn.
9. Case 9: 5 PATCH `disabled:true` đồng thời. Tất cả 200, `disabledAt` có giá trị, 0 family sống, có ít nhất 1 audit `metadata.disabled:true`. Đếm chính xác số audit nằm trong DEBT-161.

## Coverage acceptance criteria (đối chiếu fold tech-lead)

- [x] T1 DEBT-145: các test sau đều PASS trong unit 254; dev đã mutation, tester làm lại M3 ở tầng HTTP:
  - normal ∥ emergency, normal ∥ normal, chain không kẹt;
  - đường đọc không ghi (spy), retry ENOENT (`keys.spec` describe DEBT-145);
  - mức HTTP: case 5, 6, 7.
- [x] T2 keys:
  - Normal: token cũ 200 ở 3 endpoint, kid mới, JWKS có cả 2, `retiring` + `retireAt` (dev).
  - Emergency: 401 ở cả 3 endpoint, JWKS = {newKid}, refresh cũ 200 (dev).
  - Phân quyền: tenant_admin 403, step-up 403, `mode` sai trả 400, `?emergency` bị bỏ qua (dev); không token / member / cross-tenant cho 401/403 (case 1–4).
  - Exposure (đúng tập key) + audit (dev, case 7).
  - OpenAPI (dev).
- [x] T2 tenants:
  - tenant_admin chỉ thấy tenant mình; nodoc trả `[]`; super_admin thấy tất cả, có phân trang; cursor/limit sai trả 400 (dev).
  - Cross-tenant qua client lạ và member: 403 (case 4).
- [x] T3 DEBT-125/132:
  - disable → enable: `invalid_grant`, family bị stamp, client khác sống;
  - disable 2 lần giữ mốc đầu và vẫn revoke;
  - cross-tenant 404; revoke lỗi trả 5xx, sau đó retry (dev);
  - đường code/refresh/cc sau disable (case 8), disable đồng thời (case 9);
  - mutation M2.
- [x] T4 DEBT-154 (dev, `ui-auth` 3 ca, đã nằm trong int 660):
  - admin lock và brute-force lock xen giữa lúc đọc và lúc reset đều cho 401 chung byte-identical, lock giữ nguyên, không session, không audit SUCCESS;
  - login thường xoá lock đã hết hạn.

  Tester đã xem lại seam spy (đọc snapshot chưa khoá → ghi lock vào DB → trả snapshot), thấy đúng invariant "không tạo session khi `lockedUntil > now` tại thời điểm ghi". DEBT-141 (lock đặt sau reset, trước establish) vẫn ngoài phạm vi.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | anonymous, member không role, user ngoài tenant, tenant_admin, super_admin | case 1–4; dev 403 |
| Credential | absent, malformed, expired, sai aud, ký bằng key retiring đã hết hạn / key bị emergency gỡ | case 1–3, case 5; dev emergency |
| Authorization | cross-tenant qua client lạ (kể cả super_admin), tenant_admin đọc tenants, disable client tenant khác (dev 404) | case 4; dev |
| Input | `mode` thiếu/lạ/thừa field, query `?emergency`, cursor `$gt`/space/129 ký tự, limit 0/101 | dev |
| State | rotate liên tiếp + prune, code phát trước disable, refresh sau disable/enable, disable lặp | case 5, 8; dev |
| Concurrency | rotate HTTP ∥ (normal/normal, normal/emergency), 5 disable đồng thời; unit race tất định | case 6, 7, 9; `keys.spec` |
| Dependency | ghi state lỗi, audit lỗi, rm PEM lỗi (unit), revoke lỗi trả 5xx fail-closed (dev int) | dev |
| Exposure | response keys/rotate (đúng tập key, regex key material), audit, log chỉ ghi kid | dev, case 7 |

## Ghi chú

- Không có 🟡 mới, không mở DEBT-164.
- DB dev/E2E vẫn cần `pnpm -C be db:sync-indexes` (chỉ thêm index `RefreshToken {clientId:1}`); tester KHÔNG chạy lệnh này. E2E 12/12 vẫn pass khi chưa có index (chỉ ảnh hưởng hiệu năng).
