# Test Report — 2026-10-22 (run 43, A5 API layer fe-admin)

## Kết quả: PASS

- fe-admin: **417 pass + 1 expected fail / 418** trong 22 file.
  - Trước run tester: 315 test, 18 file. Tester thêm **103 test** trong 4 file mới.
  - Expected fail là `it.fails` ghi lại DEBT-299 (🟡, không chặn).
- E2E: **27/27**, chạy full 1 lần. Có 1 spec mới `admin-api-risk.spec.ts`.
- Root:
  - `pnpm lint` xanh.
  - `pnpm -r run typecheck` xanh.
  - `pnpm test` xanh: be 401/401, fe-sso-test 269/269, fe-admin 417 (+1 expected fail).
  - `pnpm audit --audit-level high` exit 0 (1 high bị ignore là DEBT-226 có từ trước).
- Không có 🔴. Thêm 1 🟡: **DEBT-299**.

## Lệnh đã chạy + output thực tế

Mọi lệnh chạy foreground bằng Git Bash. Docker `vg-test-*`/`aegate-*` đã chạy sẵn. Cổng :3000, :5173 và :4000 trống trước và sau E2E.

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C fe-admin typecheck` / `lint` / `test` (baseline) | `TC_OK`, `LINT_OK`, `Test Files 18 passed (18)`, `Tests 315 passed (315)` |
| 2 | `npx vitest run test/admin-api-risk.test.ts` | `Tests 34 passed (34)` |
| 3 | `npx vitest run test/admin-fn-risk.test.ts` | `Tests 39 passed (39)` |
| 4 | `npx vitest run test/step-up-risk.test.ts test/unavailable-concurrency.test.ts` | Lần đầu: `1 failed / 29 passed`. Case "an older pending intent…" fail với `expected { redirectUris: 'A-old' } to be null`, đây là DEBT-299. Đổi thành `it.fails` ⇒ `25 passed / 1 expected fail` (step-up-risk) và `4 passed` (concurrency) |
| 5 | `pnpm -C e2e e2e tests/admin-api-risk.spec.ts` | `1 passed (1.1m)`. Log BE chỉ có 2 request admin cho 2 positive control (`PATCH /admin/clients/e2e-missing-…` 404, `GET /admin/clients/fe-admin` 200). Các replay CSRF không tới BE. Validator zod chỉ log key/path, không log giá trị |
| 6 | `pnpm -C fe-admin gen:api` (snapshot gốc) | sha256 `schema.d.ts` = `b282ddd0…6ab9` trước và sau ⇒ **không diff** |
| 7 | Mutation snapshot: backup cp + sha256 `admin.json` = `a445862c…4c4d`, thêm `UpdateClientDto.properties.tamperedField` ⇒ sha `e0cd0120…53fa` | `gen:api` ⇒ `schema.d.ts` sha `399701c9…563e`, có `tamperedField`. Nghĩa là bước `git diff --exit-code` của CI sẽ đỏ |
| 8 | `pnpm -C e2e e2e tests/admin-openapi.spec.ts` (snapshot đã lệch) | **`1 failed`**. Diff in `- "tamperedField"`, thông điệp `fe-admin/openapi/admin.json is stale. Update it with: pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api` |
| 9 | Khôi phục bằng cp từ backup, rồi `gen:api` | `admin.json` `a445862c…4c4d`, `schema.d.ts` `b282ddd0…6ab9`, khớp bản gốc. Đã xoá `e2e/test-results` |
| 10 | `pnpm -C fe-admin typecheck` / `lint` / `test` (sau khi thêm test) | `TC_OK`, `LINT_OK`, `Test Files 22 passed (22)`, `Tests 417 passed \| 1 expected fail (418)` |
| 11 | `pnpm -C fe-admin build && pnpm -C fe-admin check:bundle` | `✓ built`, `check:bundle scanned 3 client files … 0 hit(s)`. Grep thêm `dist/client` cho `Bearer `, `admin api `, `response schema mismatch`, `ADMIN_API_BASE_URL`, `refreshRejected`, `dropSession`, `AdminApiError`: 0 file |
| 12 | `pnpm lint` (root) | exit 0 (be, fe-admin, fe-sso-test) |
| 13 | `pnpm -r run typecheck` | Lần đầu **đỏ [E2E]** do lỗi của tester: spec mới `import("/src/…")` ⇒ TS2307. Sửa bằng cách truyền đường dẫn qua biến ⇒ 4/4 `Done`, exit 0 |
| 14 | `pnpm test` (root) | be `Tests: 401 passed`, fe-sso-test `269 passed`, fe-admin `417 passed \| 1 expected fail`, exit 0 |
| 15 | `pnpm audit --audit-level high` | `2 vulnerabilities found` (1 low, 1 moderate), `1 ignored: 1 high` (GHSA-vfj7, DEBT-226, có từ trước), exit 0 |
| 16 | `pnpm -C e2e e2e` (FULL) | **`27 passed (2.1m)`**, exit 0, gồm `admin-api-risk` và `admin-openapi` |

## Test FAIL

Không có fail chặn.

- [FE] `step-up-risk.test.ts`, case "an older pending intent is not left behind when a newer draft cannot be saved".
  - Kỳ vọng `takeIntent` trả `null`. Thực tế trả `{ redirectUris: "A-old" }`.
  - Nguyên nhân: `saveIntent` thất bại (payload sai schema hoặc storage đầy) nhưng không xoá intent cũ chưa dùng.
  - Tác động: bản nháp cũ được khôi phục kèm thông báo "kiểm tra rồi gửi lại", trong khi toast lại báo bản nháp đã mất.
  - Không tự gửi, chỉ cùng user, tab, action và path, trong vòng 10 phút. Không có bypass hay rò rỉ.
  - ⇒ **DEBT-299** 🟡, đích A6.1, trước khi có form thật. Case được giữ dưới dạng `it.fails`.

## Coverage acceptance criteria (tasks.md + Fold)

- [x] **T1 / F1**: types sinh từ snapshot, script tái lập được.
  - #6: `gen:api` không diff.
  - `typecheck` dùng `components["schemas"]["UpdateClientDto"]` (`client.ts` `ClientPatch`).
  - CI có bước `gen:api && git diff --exit-code` (`ci.yml`).
  - #7: lệch snapshot làm types đổi.
  - #8: spec E2E đỏ khi lệch và in lệnh cập nhật.
  - #16: xanh khi khớp.
- [x] **T2 / F2**: mỗi mã lỗi map đúng (`admin-api.test.ts` của dev, cộng `admin-api-risk.test.ts`).
  - Không rò token hay body BE: canary 20 KB, kiểm cả wire, message và log.
  - Không có proxy chung: id độc chỉ thành một segment đã encode (unit + E2E BE thật).
  - zod chặn input sai (`admin-fn-risk.test.ts`, E2E).
- [x] **T3 / F3**: round-trip không mất dữ liệu form, không lưu secret (`step-up.test.tsx` của dev).
  - Thêm `step-up-risk.test.ts`: giá trị lưu có shape bất kỳ, binding khớp chính xác, payload tiêm tay bị lọc theo allowlist.
  - Retry và invalidation đã có test của dev.
- [x] **T4 / F4**: DEBT-282 503 (`ssr-unavailable.test.tsx`, cộng `unavailable-concurrency.test.ts`). DEBT-289 và `azp` (`bff-a5.test.ts`).
- [x] Nghiệm thu chung: test, typecheck, lint, build, `check:bundle` xanh. E2E full xanh, gồm spec OpenAPI.
  - Fold yêu cầu E2E "2 lần liên tiếp": dev đã chạy 26 × 2. Tester chạy full 1 lần (27/27) theo chỉ định.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Input: path id | Pass schema nhưng độc (`%2F..%2Fadmin%2Fusers`, `%2e%2e`, `..%5c..`, `...`, `?#`, unicode/emoji, U+2215, dấu chấm full-width, NUL/CRLF, đúng 128 ký tự) ⇒ BE nhận đúng 1 segment `/admin/clients/<enc>`, `decodeURIComponent` = id, không query/hash, không header tiêm. Bị chặn: `../x`, `..`, `.`, `/`, `\`, rỗng, 129 ký tự ASCII hoặc unicode | `admin-api-risk` "hostile client ids" (10 + 8 case). E2E: 4 id độc ⇒ `not_found` từ BE thật |
| Input: query | Cursor `x&limit=1000#/../../admin/users` vẫn nằm trong `after`, path không đổi | `admin-api-risk` |
| Input: patch | Sai kiểu (`redirectUris` là string hoặc số, `disabled` là `"true"` hoặc `1`, `frontchannel` là số, `scopes` là object), enum lạ (`client_credentials`, `implicit`), 21 URI, URI 2049 ký tự, key lạ (`tenantId`, `clientId`, `clientSecret`, `secretHash`, `__proto__` lấy từ JSON, `constructor`), patch null/array/string, input null ⇒ bị chặn trước API. Biên (20 × 2048, `null`, 2 grant, id `%2F`/unicode/128) ⇒ đi qua. Key lạ ở top-level bị strip | `admin-fn-risk` (39). E2E: `tenantId`, `"true"`, `client_credentials` ⇒ lỗi chung, BE không bị gọi |
| Request chain / CSRF | Replay đúng request `updateClient` (POST) và `getClient` (GET) kèm cookie phiên, với: không có header nào, Origin lạ, `Origin: null`, Referer lạ, Referer look-alike (`http://localhost:3000.evil.example/`), `Sec-Fetch-Site: cross-site` (kèm Origin đúng), `Sec-Fetch-Site: same-site` ⇒ **403**, body không rò. Positive control Origin đúng ⇒ 200 | `admin-api-risk.spec.ts` (E2E, dev server thật) |
| Exposure | Canary 20 KB trong body BE 500/502/302/403 step_up/403 forbidden/404/403 raw ⇒ message cố định, wire < 200 ký tự, không có canary hay AT trong wire/message/log. 409 chỉ giữ 200 ký tự đầu. `error_description` không phải string ⇒ câu cố định. Status lạ (451) ⇒ Error không chứa body. 2xx có `secretHash`/`clientSecret`/`accessToken` ⇒ bị strip | `admin-api-risk` "raw BE bodies" (10). E2E: response serverFn không có `eyJ`, `secretHash`, `clientSecret`, `Bearer`, `WWW-Authenticate`, `invalid_token` |
| Credential / State | 401 ⇒ refresh ⇒ 401 ⇒ phiên bị huỷ. **Request kế tiếp** dùng cookie cũ ⇒ `unauthenticated`, không gọi BE, không refresh, cookie bị xoá lại | `admin-api-risk` "401 chain" |
| Credential | `step_up_required` không bao giờ refresh (lặp 5 lần ⇒ 0 refresh grant). 401 ⇒ refresh OK ⇒ 403 step_up ⇒ `step_up_required`, đúng 1 refresh, phiên giữ nguyên, không xoá cookie | `admin-api-risk` |
| Concurrency | 3 lời gọi song song, BE từ chối mọi token ⇒ đúng 1 refresh grant, RT không bao giờ gửi 2 lần, cả 3 đều `unauthenticated`, phiên bị xoá. (2 lời gọi song song 401 ⇒ 1 refresh đã có test của dev) | `admin-api-risk` |
| Dependency | Mutation 5xx (504) ⇒ `uncertain`. GET 5xx (599) ⇒ không `uncertain`. BFF không retry. (Timeout và network đã có test của dev) | `admin-api-risk` |
| State: step-up intent | `sub` khác (prefix `u10`, rỗng, khác hoa thường), action khác (prefix, hoa thường), path khác (thêm query, bỏ query, `/` cuối, hoa thường, ký tự encode), `exp` đúng bằng now ⇒ bỏ (now − 1 ms thì khôi phục). JSON hỏng hoặc shape lạ (`null`, array, string, number, rỗng, `exp` là string hoặc null, `v` là `"1"`, thiếu `sub`, payload null/array/quá dài) ⇒ bỏ và **đã bị tiêu thụ**. Payload tiêm `clientSecret`/`accessToken`/`__proto__` ⇒ chỉ còn field allowlist, không prototype pollution. `saveIntent` không ghi field ngoài schema. Draft sai schema ⇒ không lưu, vẫn step-up | `step-up-risk` (26, gồm 1 `it.fails` = DEBT-299) |
| Concurrency: SSR 503 | A đặt cờ giữa chừng trong khi B đang chạy ⇒ A 503 (no-store, body chuyển tiếp nguyên), B 500. 50 request đan xen, request lẻ đặt cờ sau timer ⇒ đúng các request lẻ thành 503. Cờ đặt trong callback `setTimeout` lồng ⇒ vẫn thuộc request đó. Request có cờ nhưng trả 200/302/404 ⇒ giữ nguyên status | `unavailable-concurrency` (4) |
| Bundle | Client bundle không chứa chuỗi server của admin-api | #11 |

Không kiểm: Identity "other user / cross-tenant" ở tầng BFF. BFF không tự quyết quyền mà forward AT của chính phiên đó, và cross-tenant đã có ma trận ở BE (B7.1).

## File test thêm (tester)

- `fe-admin/test/admin-api-risk.test.ts`
- `fe-admin/test/admin-fn-risk.test.ts`
- `fe-admin/test/step-up-risk.test.ts`
- `fe-admin/test/unavailable-concurrency.test.ts`
- `e2e/tests/admin-api-risk.spec.ts`

Không sửa code sản phẩm. `fe-admin/openapi/admin.json` và `schema.d.ts` đã được khôi phục, sha256 khớp bản gốc.
