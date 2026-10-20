# Test Report — 2026-10-20 (run 35, B7.1b)

## Kết quả: PASS

BE unit 317/317, BE int 935/935 (38 suites), FE 240/240, E2E 16/16. Typecheck và lint sạch. Không test nào FAIL, không có lỗi [BE] mới. Tester thêm 69 int-test (866 ⇒ 935). DEBT-212 đã đóng.

## Phạm vi đối chiếu

Diff chưa commit kể từ `b2694ee` trong `be/`: T1 (`repeatedParam`, 12 khoá), T2 (`assertMember` ở `handle` và `decideConsent`), T3 (`TokenController.recheckCodeGrant`), fixture `be/test/oauth-fixtures.ts`, ma trận. Đối chiếu với acceptance trong `tasks.md` và phần Fold F0–F9. Code đọc qua CodeGraph: `AuthorizeService.handle/resume/decideConsent/assertMember/resolveResource/parsePrompt/parseMaxAge`, `repeatedParam`, `AuthorizeController.handle`.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| 1 | `codegraph sync` | Done |
| 2 | `pnpm -C be typecheck` | `tsc --noEmit`, không lỗi |
| 3 | `pnpm -C be lint` | `eslint src test`, không lỗi (sau `prettier --write` cho 3 file test tester sửa) |
| 4 | `pnpm -C be test:int -- authorize-params oauth-tenant-isolation federation` | `Test Suites: 3 passed`, `Tests: 176 passed, 176 total` |
| 5 | `pnpm -C be test` | `Test Suites: 26 passed, 26 total`, `Tests: 317 passed, 317 total` |
| 6 | `pnpm -C fe-sso-test test` | `Test Files 31 passed (31)`, `Tests 240 passed (240)` |
| 7 | `pnpm -C be test:int` (khoá `vg:int-lock` trống trước khi chạy) | exit 0, `Test Suites: 38 passed, 38 total`, `Tests: 935 passed, 935 total`, `Time: 272.113 s` |
| 8 | `pnpm -C e2e e2e` (cổng 5173/4000/3000 trống, không phải dừng process nào) | exit 0, `16 passed (1.7m)` |

Ghi chú output: lần chạy 7 có cảnh báo `Cannot log after tests are done … [ioredis] Unhandled error event` ngay sau `sessions.int-spec` (đoạn `redis-fail-fast`). Cảnh báo này có từ trước, không thuộc file run 35, và không làm test fail. Dòng `ERROR … federation provisioning compensation failed` là log có chủ đích của test race đã có từ run 32.

### Mutation (sao lưu + `cp` + sha256, không dùng git checkout)

File `be/src/modules/oauth/authorize/authorize.service.ts`, sha256 `c4a5d2c9…3f8c` trước và sau mỗi mutation (khớp).

| Mutation | Suite | Kết quả |
|---|---|---|
| M1: chỉ đường `resume` bỏ `assertMember` (cờ `_resumed`) | oauth-tenant-isolation + federation | **4 RED / 100**, đúng 4 test mới: 2 "DEBT-212 …" và 2 federation "password login form …", "Google federated …". Mọi test cũ vẫn xanh, nghĩa là lỗ phủ DEBT-212 là thật |
| M2: tắt kiểm Phase 2 (`false && repeatedParam(…PHASE2…)`) | authorize-params | **33 RED / 76**: 27 case ma trận mới (9 khoá × 3 dạng) + 6 test cũ |
| M3: tắt kiểm Phase 1 (`client_id`/`redirect_uri`) | authorize-params | **7 RED / 76**: 6 case ma trận mới + 1 test cũ (`client_id repeated`). Test cũ `redirect_uri repeated (both registered)` **không** đỏ, vì mảng vẫn rơi vào `invalid_redirect_uri` ⇒ 400. Case mới bắt được vì assert `findByClientId` không được gọi |

## Test FAIL

Không có.

## Test tester thêm (69)

- `be/test/authorize-params.int-spec.ts` › `every recognised parameter x repetition shape (tester run 35)` (+61):
  - `covers all 12 recognised keys`
  - `%s repeated as %s => refused per trust phase, nothing written`: 12 khoá × 3 dạng (`k=&k=`, `k=<hợp lệ>&k=`, `k=&k=<hợp lệ>`) = 36 case. Kỳ vọng: `client_id`/`redirect_uri`/`request_id` ⇒ 400, không `Location`, không gọi `findByClientId`/`consume`. `resource` ⇒ 302 `invalid_target`. 8 khoá còn lại ⇒ 302 `invalid_request` + `iss`, có `state` gốc (trừ `state` lặp: không có `state`). Không bao giờ 500, số key `authz_code:*`/`authz_ctx:*` không đổi, mọi lời gọi lookup đều nhận string.
  - `bracket key %s is an unrecognised parameter => ignored, normal flow`: 12 khoá × (`k[]`, `k[0]`), mỗi khoá gửi hai lần = 24 case. Parser query mặc định của Fastify không gộp key dạng ngoặc vào khoá thật, nên các key này bị bỏ qua như tham số lạ (RFC 6749 §3.1) ⇒ 200 consent, lookup chỉ nhận `CLIENT`.
- `be/test/oauth-tenant-isolation.int-spec.ts` (+5):
  - `DEBT-212: resume after login as a NON-member … => access_denied (state from ctx), no code, context consumed`: có audit `not_member`. Replay cùng `request_id` ⇒ trang first-party, không redirect, không code.
  - `DEBT-212: resume after login as a non-member holding a still-valid consent => access_denied, no code`
  - `control (resume): ACTIVE member of tenant B resumes => 200 consent screen`
  - `MT1 + prompt=none + still-valid consent (covered branch) => access_denied, no code`
  - `control: ACTIVE member of tenant B + prompt=none + covered consent => code`
- `be/test/federation.int-spec.ts` › `cross-tenant RP after a real login (run 35, DEBT-116/212, MT1)` (+3), client RP thứ hai ở `tenant-B`:
  - `password login form => resume => access_denied for a default-tenant-only user, no code, no membership granted`: dùng form `POST /login` thật với CSRF, `state` gốc được echo, có `iss`. Không thêm `UserTenant` cho tenant-B. Có audit `OAUTH_AUTHORIZE failure not_member tenantId=tenant-B`.
  - `Google federated (new user) => resume => access_denied; provisioned into default-tenant only`: mock Google, user mới chỉ có 1 membership, và `/authorize` mới với session federated sống cũng bị từ chối.
  - `control: a password user who IS an active member of tenant-B resumes to a code`

## Coverage acceptance criteria

- [x] T1 `scope`/`prompt`/`nonce`/`state`/`code_challenge(_method)`/`response_type`/`max_age` lặp ⇒ 302 `invalid_request`: test của dev + ma trận 12×3 của tester
- [x] T1 `client_id`/`redirect_uri`/`request_id` lặp ⇒ 400, không `Location`, spy lookup/consume: test của dev + ma trận
- [x] T1 `state` lặp không echo, `resource` lặp giữ `invalid_target`, `utm` lặp bị bỏ qua: test của dev + ma trận + bracket keys
- [x] T1 unit helper: `authorize.service.spec.ts` (14)
- [x] T2 MT1 (session sống, `prompt=none`, consent cũ, suspended, user mới ở default-tenant, DB lỗi ⇒ 500), MT2, đối chứng: `oauth-tenant-isolation` (dev 8 + tester 5)
- [x] T2 đường resume sau login (DEBT-212): `oauth-tenant-isolation` › DEBT-212 ×2 và `federation` › password/Google
- [x] T3 recheck code grant (5 lý do, race, body giống từng byte, `recheck_failed` ⇒ 500, đối chứng): `token-code-recheck.int-spec` (16), xanh trong lần chạy 7
- [x] T5 toàn suite xanh, số test tăng (unit 317, int 935), FE 240 không đổi, E2E 16/16
- [x] Ma trận 75/77 `có`: đếm lại bằng script trên cột trạng thái, ra `có` 75, `một phần` 1 (dòng 19), `ngoài phạm vi` 1 (CK1), tổng 77, khớp bảng tổng. Grep 248 tham chiếu `file › tên test` trong ma trận: 0 thiếu. Đã bổ sung 4 test mới vào dòng MT1.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp đã kiểm | Test |
|---|---|---|
| Identity | user tenant A, member suspended, member active (đối chứng), user mới chỉ có default-tenant, user federated (Google) | `oauth-tenant-isolation`, `federation › cross-tenant …` |
| Authorization | cross-tenant qua `client_id` của tenant khác: session có sẵn, resume sau login, `prompt=none`, consent còn hiệu lực (cả nhánh covered + `prompt=none`), POST consent | như trên + MT2 |
| Input | 12 khoá × {rỗng-rỗng, hợp lệ-rỗng, rỗng-hợp lệ} + `k[]`/`k[0]` | `authorize-params › every recognised parameter …` |
| State | login context single-use (replay ⇒ trang lỗi), context bị consume khi `access_denied` | `DEBT-212: resume …` |
| Request chain | `/authorize` (signed out) ⇒ `/login` (form thật hoặc Google) ⇒ `Set-Cookie` session mới ⇒ `/authorize?request_id=` | `federation › cross-tenant …` |
| Dependency | `isActiveMember` ném ⇒ 500 fail-closed (dev), `recheck_failed` ⇒ 500 (dev) | `oauth-tenant-isolation › fail-closed`, `token-code-recheck` |
| Exposure | redirect không chứa `tenant-B`/`member`, lý do chỉ ở audit, body 500 không chứa chi tiết lỗi | `expectAccessDenied`, `expectDeniedAtRp` |

Invariant "không cấp code/consent cho (user, client) khi user không `active` ở `client.tenantId`" đã có bằng chứng trên mọi đường cấp code của `/authorize`: fresh, covered, `prompt=none`, resume (password và federated), POST consent. Code grant `/token` cũng đã được phủ.

## Rủi ro còn mở (không chặn, đã có DEBT)

- DEBT-211 (🟡 [BE]): `access_denied` của not_member có `error_description`, còn deny thật thì không. Chưa sửa, blast radius thấp, giữ nguyên debt của senior.
- DEBT-207 (refresh grant và login re-check, run 36), DEBT-208/209/210/213: không đổi.
- Không mở 🟡 mới.
