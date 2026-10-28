# Test Report — 2026-10-28 (run 58 — sweep 🟡 BE: T1 DEBT-389/160/158, T2 DEBT-151, T3 DEBT-238)

## Kết quả: PASS

- be unit **614/614** (38 suite); typecheck 0, lint 0, build 0.
- be `test:int` full **1387/1387** (52 suite, 2 shard: 839 + 548). Con số này gồm 14 test tester mới: 5 ở T2 và 9 ở T3.
- Root: `pnpm lint` 0; `pnpm -r run typecheck` 0; `pnpm test` gồm be 614, fe-admin 1416, fe-sso-test 269.
- `pnpm audit --audit-level high` exit 0: 7 low, 9 moderate, 1 high ignored (đã có từ trước).
- E2E full chạy 1 lần: **36 passed** (4.7m).
- Grep secret trên mọi output: 0.
- Không sửa code sản phẩm. Mọi mutation đều được khôi phục; sha256 khớp (case 6).

## Lệnh đã chạy + output thực tế

Chạy trong Git Bash, từ thư mục gốc repo `E:\projects\self\veyrigate`. Mọi lệnh chạy foreground.

1. **Preflight**:
   - `codegraph --version` ⇒ 1.6.2; `codegraph status`; `codegraph sync` ⇒ Done.
   - `vg-test-mongo` và `vg-test-redis` đều `Up`.
   - `redis-cli GET vg:int-lock` trả rỗng trước mỗi lần chạy int (TTL -2).
   - Các cổng `:4000`, `:5173`, `:3000` không LISTEN trước E2E. `E2E_REUSE` chưa đặt.
2. **Test mới**, 2 suite đụng tới: `jest … --testRegex '\.int-spec\.ts$' test/b74-tester` + `test/admin-users`.
   - admin-users: 67/67. b74-tester: 64/64.
   - Lần chạy đầu có 4 FAIL do kỳ vọng của tester sai, đã sửa test (không phải lỗi sản phẩm):
     - T58-6/7/8 ⇒ lỗi parse body của route HTML đi qua **filter global `OAuthExceptionFilter`**, không qua `HtmlExceptionFilter`. Body được parse trước filter cấp route. Hành vi này có từ trước, khớp case `broken JSON on HTML /login` hiện có.
     - T58-11 ⇒ `client_credentials` trả `unsupported_grant_type` 400; đổi sang `refresh_token` để đi tới client auth.
3. **be**:
   - `pnpm -C be test` ⇒ `Test Suites: 38 passed; Tests: 614 passed`.
   - `pnpm -C be test vault-transit-key-provider -t DEBT-389` ⇒ `√ DEBT-389: emergency with config failing, then re-run ⇒ converges…`.
   - `pnpm -C be typecheck` = 0; `pnpm -C be lint` = 0; `pnpm -C be build` = 0.
4. **Int full**: `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit --testTimeout=20000 --globalSetup ./test/int-preflight.mjs --globalTeardown ./test/int-teardown.mjs --testRegex '\.int-spec\.ts$' --shard=1/2` (rồi `2/2`), cùng cờ với script `test:int`.
   - Shard 1: `suites 26/26 tests 839/839`.
   - Shard 2: `suites 26/26 tests 548/548`.
   - Tổng 52 suite, 1387 test, 0 fail.
5. **Root**:
   - `pnpm lint` = 0; `pnpm -r run typecheck` = 0.
   - `pnpm test` = 0: `Tests: 614 passed`, `Tests 1416 passed (1416)` (64 file), `Tests 269 passed (269)` (31 file).
   - `pnpm audit --audit-level high` = 0: `16 vulnerabilities found — Severity: 7 low | 9 moderate — 1 ignored: 1 high`.
6. **Mutation**:
   - Backup sha256 trước khi sửa. Khôi phục bằng `cp`, sau đó `sha256sum -c` ⇒ `OK` cho cả 3 file sản phẩm và `vault-transit-key-provider.ts`.

   | # | Mutation | Kết quả |
   |---|---|---|
   | M-A | `oauth-exception.filter.ts`: tắt nhánh `fastifyBodyAbort` (`!(fastifyBodyAbort && false)`) | b74 54/61 RED: 2 test RST/FIN của dev + T58-6, 7, 8, 9, 10 |
   | M-B | Bỏ kiểm `code` (`Date.now() < 0 &&`) | b74 61/64 RED: `run 58 SDK error statusCode 404 + code ESDK_NOT_FOUND`, `run 58 outbound ECONNRESET statusCode 400 "read ECONNRESET"`, `run 58 numeric code 403` (admin route ⇒ phải 500 + log) |
   | M-C | Controller: không sweep khi `alreadyRevoked` | admin-users 64/67 RED: (b), T58-1, T58-2 |
   | M-D | `revokeById`: `$set: {revokedAt: now}` (ghi đè) | 64/67 RED: (a), T58-1, T58-2 |
   | M-E | Thêm lại `revokedAt: null` vào filter | 60/67 RED: (a), (b), (c), (d), T58-1, T58-2, `revoke consent => /authorize shows the consent screen again…` |
   | M-T1 | `vault-transit-key-provider.ts` `config` dùng `before.latest` | unit 3 RED, gồm DEBT-389 |

   Ghi chú: lần đầu chạy M-A và M-B, TS báo lỗi biên dịch (biến không dùng / `unknown`), nên suite không chạy được và kết quả không tính. Đã viết lại mutation cho biên dịch được rồi chạy lại.
7. **E2E**: `pnpm -C e2e e2e` ⇒ exit 0, `36 passed (4.7m)`.
   - Log có 4 dòng `[fe-admin] server function failed` (zod `Invalid client id` / `unrecognized_keys tenantId`). Đây là các case âm có chủ đích của E2E.
   - Sau khi chạy, các cổng đều đã đóng.
8. **Grep secret**:
   - Phạm vi: log int (2 shard), log mutation, E2E, root test, build, lint, typecheck.
   - Pattern: `BEGIN .*PRIVATE`, `admin-users-int-password`, `full-app-csrf-secret`, `gsecret-`, JWT `eyJ…\.eyJ`, `client_secret=`, `refresh_token":"`, `hvs\.`, `DEV_SEED_PASSWORD=`.
   - Kết quả: **0** cho mọi pattern.

## Test FAIL (nếu có)

Không có FAIL sản phẩm. 4 FAIL ở lần chạy đầu là do kỳ vọng của tester sai (xem mục 2) và đã sửa trong test.

## Test tester thêm

**`be/test/admin-users.int-spec.ts`**, describe `run 58 tester DEBT-151: retry/replay/concurrency/guard risk matrix`:

- **T58-1**: gọi tuần tự 4 lần rồi bắn song song 6 lần ⇒ mọi lần đều 204, body rỗng.
  - Trước mỗi lần gọi lại, test "hồi sinh" 1 RT trong family. Mỗi lần gọi đều quét family về 0 active, nên sweep chạy ở **mọi** lần.
  - `revokedAt` đầu tiên giữ nguyên.
  - 10 audit success, đúng 1 cái `alreadyRevoked:false`. Tổng `count` = 5.
  - Metadata chỉ có `alreadyRevoked/clientId/count/resource`, không có `tokenHash` hay `refresh_token`.
  - Refresh `offline_access` ⇒ `invalid_grant`. Family khác của cùng user vẫn sống.
- **T58-2**: sweep lỗi 2 lần liên tiếp, lần 2 audit failure cũng lỗi ⇒ 500 cả hai lần, body không lộ message.
  - Lần 3 ⇒ 204, family chết, refresh ⇒ `invalid_grant`, `revokedAt` đầu tiên giữ nguyên.
  - Audit: 1 failure `family_sweep_failed` + 1 success `{count:1, alreadyRevoked:true}`.
- **T58-3**: `revokeById` (DB) lỗi ⇒ 500, không gì đổi (`revokedAt` null, family sống, 0 audit). Gọi lại ⇒ 204 `alreadyRevoked:false`.
- **T58-4**: admin tenant B thao tác trên user **là member của B**, nhắm consent của client tenant A.
  - Cả khi consent đang active lẫn khi đã revoke ⇒ 404 byte-identical (status + content-type + body) với ObjectId không tồn tại.
  - Consent, family và audit không đổi.
- **T58-5**: guard trên consent **đã revoke**.
  - Không token ⇒ 401; auth cũ hơn 6' ⇒ 403 `step_up_required`; chỉ `admin.read` ⇒ 403 `insufficient_scope`.
  - Không sweep, không đổi `revokedAt`, 0 audit.

**`be/test/b74-tester.int-spec.ts`**:

- Describe `run 58 tester DEBT-238: mid-body abort on other routes + real 5xx still logged`:
  - Dùng app riêng; bọc prototype của cả `OAuthExceptionFilter` và `HtmlExceptionFilter` trước boot.
  - Socket thật, ghi nửa body rồi đóng. Chờ có điều kiện ≤ 5 s cho tới khi filter được gọi.
  - Mỗi test kiểm: shape `{ECONNRESET, 400, 'aborted'}`, `clientErrorStatus = 400`, **0 dòng `"level":50`** trên cả hai stream, không có unhandled rejection.
  - **T58-6**: `POST /authorize/consent` form, RST.
  - **T58-7**: `POST /login` form, FIN.
  - **T58-8**: `POST /login` `Transfer-Encoding: chunked`, chunk dở rồi RST.
  - **T58-9**: `POST /admin/clients` JSON ẩn danh, RST.
  - **T58-10**: `POST /introspect` form, FIN.
  - **T58-11** (đối chứng): `findByClientId` ném lỗi `ECONNRESET` + `statusCode:400` + `'read ECONNRESET'` trên `/token` ⇒ 500 `server_error`, body không lộ, **có** dòng level 50.
- 3 case thêm vào `it.each` "… thrown on an admin route => 500 server_error + error log + 5xx metric" (lỗi đi thẳng qua filter):
  - `ESDK_NOT_FOUND` + 404.
  - Outbound `ECONNRESET` + 400 `read ECONNRESET`.
  - `code` dạng số 403.

## Coverage acceptance criteria

- [x] **T1 DEBT-389**: unit hội tụ emergency.
  - Test `DEBT-389: emergency with config failing, then re-run ⇒ converges…` xanh.
  - Mutation M-T1 làm nó RED.
  - `git diff -- be/src ':!*.spec.ts'` không có file `keys/`.
- [x] **T1 runbook §1** khớp hành vi code:
  - Đọc lại `VaultTransitKeyProvider.rotate`/`live` và `KeyRotationService.rotate`.
  - Emergency xong ⇒ `floor = n` ⇒ `listKeys` đúng 1 item, kể cả khi `trim` lỗi.
  - `config` lỗi ⇒ 2 item (`retiring` + `active` mới) và audit `failure reason:"rotate_failed" metadata.mode`.
  - Bước `rotate` của Vault lỗi ⇒ kid không đổi ⇒ quy tắc "kid ≠ bước 2" vẫn đúng.
- [x] **T1 DEBT-160**: câu thêm vào spec §10 khớp `KeyRotationService` (`targetId = result.newKid`).
- [x] **T2 (a)–(e)** của dev và guard `cross-tenant user, step-up and scope on family/consent routes` đều xanh. Tester thêm T58-1…T58-5.
- [x] **T3**:
  - Unit `oauth-exception` / `html-exception` nằm trong 614.
  - Int abort `/token` RST/FIN của dev xanh. Tester thêm T58-6…T58-11.
  - Nguồn 4xx thật không đổi: `retry 1: Fastify client errors vs real server errors …` xanh, gồm JSON hỏng/rỗng 400, 413, 415 trên admin và `/token`, bad URL 400 (2 case), static 403.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Identity | anonymous (abort, DELETE không token) | T58-5 (401), T58-6…10 |
| Authorization | tenant khác (user là member B) / user khác / id lạ / id sai dạng, kể cả consent đã revoke ⇒ 404 byte-identical | T58-4, (e) |
| Credential/scope | step-up hết hạn, `admin.read` | T58-5, guard cũ |
| State | đã revoke (gọi lại), retry sau lỗi, replay N lần | T58-1/2/3, (a)(b)(c) |
| Concurrency | 6 DELETE song song, 2 DELETE song song | T58-1, (d) |
| Dependency | sweep lỗi ×2, audit failure lỗi, `revokeById` lỗi, audit success lỗi ⇒ fail-closed 500, gọi lại hội tụ | T58-2/3, (b)(c) |
| Request chain | sau revoke, request refresh kế tiếp ⇒ `invalid_grant` | T58-1/2, (b)(d) |
| Input | nửa body form / JSON / chunked trên 5 route | T58-6…10 |
| Exposure | body 5xx không lộ message; audit chỉ 4 khóa metadata; không lộ `ECONNRESET` | T58-1/2/3/11 |
| Log (B7.4 / DEBT-238) | abort ⇒ 0 ERROR; lỗi thật / look-alike ⇒ 500 + ERROR | T58-6…11 + 3 case admin |

## Ghi chú (không mở debt)

- Lỗi parse body trên route HTML (`/login`, `/authorize/consent`) do filter global (JSON) xử lý chứ không phải `HtmlExceptionFilter`. Hành vi này có từ trước run 58. Khi client ngắt kết nối thì không còn ai nhận response, nên không ảnh hưởng.
- Senior đã nêu ở 💭 vòng 1: DELETE gọi lại sau khi user đồng ý lại sẽ revoke consent mới. Tester không đổi kết luận đó. Liên quan DEBT-428.
