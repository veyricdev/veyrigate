# Test Report — 2026-10-20 (run 37, B7.2 observability + DEBT-215)

## Kết quả: PASS

| Bộ | Kết quả |
|---|---|
| BE typecheck + lint (`tsc --noEmit`, `eslint src test`) | sạch, exit 0 |
| BE unit `pnpm -C be test` | **351/351** (28 suite) |
| BE int `pnpm -C be test:int` (FULL) | **1012/1012** (39 suite); dev báo 986, tester thêm 26 |
| FE `pnpm -C fe-sso-test test` | **240/240** (31 file) |
| E2E `pnpm -C e2e e2e` (1 lần) | **16/16** (1.3m) |
| Mutation (tester) | 7/7 RED, khôi phục bằng cp, sha256 khớp |

Không có test FAIL. Không lỗi nào gán [BE] hay [ops].

## Lệnh đã chạy + output thực tế (foreground)

- `pnpm -C be typecheck && pnpm -C be lint` ⇒ `$ tsc --noEmit`, `$ eslint src test`, exit=0.
- `pnpm -C be test` ⇒ `Test Suites: 28 passed, 28 total` / `Tests: 351 passed, 351 total`.
- `pnpm -C be test:int` ⇒ `Test Suites: 39 passed, 39 total` / `Tests: 1012 passed, 1012 total`, exit=0. Có 1 dòng nhiễu "Cannot log after tests are done" từ `ioredis` (Unhandled error event lúc teardown). Dòng này đã có từ trước, cũng xuất hiện trong log int của run 33/36, nên không do run này gây ra.
- `pnpm -C fe-sso-test test` ⇒ `Test Files 31 passed (31)` / `Tests 240 passed (240)`.
- `pnpm -C e2e e2e` ⇒ `16 passed (1.3m)`. Trước khi chạy, :4000 và :5173 đều trống nên không phải dừng process nào. Sau khi chạy không còn listener.
- Khoá `vg:int-lock` sau khi chạy: `EXISTS` = 0. Không compose up, không docker run/rm/pull, không FLUSH, không chạm `aegate-*`, `be/keys`, `be/.env`.

## Test tester bổ sung

### `be/test/metrics.int-spec.ts`: describe `tester risk matrix (run 37)` (21 test)

Module test thêm `AdminClientsController` và `AdminUsersController` thật để có route admin chứa id.

| # | Chiều rủi ro | Test | Kỳ vọng / thực tế |
|---|---|---|---|
| 1 | Credential malformed | 10 case `credential: …`: token ngắn hơn 1 ký tự, dài hơn 1 ký tự, chỉ prefix 32 ký tự, token rỗng, chỉ có scheme, 2 dấu cách, token viết hoa, scheme `Token`, scheme dính liền token, tab thay cho dấu cách | 401, `WWW-Authenticate: Bearer`, body rỗng ✔ |
| 2 | Credential case | `bearer`, `BEARER`, `bEaReR` | 200. Auth scheme không phân biệt hoa thường theo RFC 9110 §11.1, còn token thì có phân biệt (xem case viết hoa ở #1) ✔ |
| 3 | Header lặp | `authorization` dạng mảng 2 giá trị (inject) | 401 ✔ |
| 4 | Header lặp, socket thật (`app.listen(0)` + raw TCP) | Gửi 2 header `Authorization`, header sai đứng trước | 401 (Node giữ header đầu) ✔ |
| 5 | Header lặp, socket thật | Header đúng đứng trước | 200. Đây là ngữ nghĩa của Node, không phải lỗ hổng vì người gọi vẫn phải có token ✔ |
| 6 | Input: method lạ (đóng DEBT-222) | `PROPFIND /probe/x` qua raw socket | Label `method="OTHER"`, chuỗi `PROPFIND` không xuất hiện ✔ |
| 7 | Exposure / route có id thật | `GET /admin/clients/<clientId thật>`, `GET /admin/users/<ObjectId>?x=<RUN>`, `POST /admin/users/<id>/families/<uuid>/revoke` (401) | Có `route="/admin/clients/:clientId"`, `/admin/users/:id`, `/admin/users/:id/families/:familyId/revoke`. clientId, RUN, ObjectId, uuid đều không có trong output ✔ |
| 8 | Cardinality | Chạy 2 lô, mỗi lô 125 request với id/uuid/query ngẫu nhiên (probe, admin, path không khớp route, GET/POST/DELETE) | Lô 2 thêm **0** series. Không series nào chứa hex24/uuid, tổng < 60 ✔ |
| 9 | Counter đúng 1 | Mọi `AuditAction` (30) × {success, failure} ghi qua `AuditService.record` thật (Mongo) | Series tương ứng +1, mọi series `sso_audit_events_total` khác +0, số series không đổi ✔ |
| 10 | Counter đúng 1 | Xoay khoá `normal` | `rotations{normal,success}` +1, `emergency` +0 ✔ |

### `be/test/token-code-recheck.int-spec.ts`: DEBT-215 khi chạy song song (5 test)

| # | Chiều | Test | Kết quả |
|---|---|---|---|
| 11 | State: retry song song | Sau refresh bị từ chối do `recheck_failed` (500) hoặc `user_locked` (400), bắn 6 replay song song | Cả 6 trả 400 `invalid_grant`, không có token, **0** audit reuse, metric reuse +0, family chết ✔ |
| 12 | Reuse thật, song song | RT đã rotate thành công (200), sau đó 6 replay song song | Cả 6 trả 400. Reuse audit ≥1 và metric tăng đúng bằng số audit. Family revoke toàn bộ, RT kế nhiệm bị 400 ✔ |
| 13 | Concurrent first-use | Dùng cùng 1 RT cho 6 request song song | Nhiều nhất 1 request 200. Các request thua báo reuse và giết luôn RT của request thắng ✔ |
| 14 | Race giữa replay và refusal | Replay chạy giữa lúc rotate và lúc unlink (đường lock) | Không có token, family chết, nhiều nhất 1 reuse (đánh đổi đã được senior chấp nhận). Retry sau khi refusal xong là `invalid_grant` và không thêm reuse ✔ |

### Mutation (tester; sao lưu, cp + sha256, KHÔNG dùng git checkout)

| ID | Mutation | Kết quả |
|---|---|---|
| A | `rotate` ghi `replacedBy: null` (reuse không bao giờ được phát hiện) | RED 9 test, gồm #12, #13 và các test reuse của dev |
| B | unlink nhắm `_id` ngẫu nhiên (unlink không có tác dụng) | RED 10 test, gồm #11 ×2 và #14 |
| C | label `route` = `request.url` | RED 4 test, gồm #7 và #8 |
| D | label `method` = method thô | RED #6 |
| E | `observeAuditEvent` +2 cho `ACCOUNT_UNLINKED` | RED #9 |
| G | bỏ cờ `/i` của regex Bearer | RED #2 ×3 |

Sau mỗi mutation đã khôi phục. `sha256sum -c` trên `refresh-token.service.ts`, `metrics.http.ts`, `metrics.ts`, `audit.service.ts` đều OK.

## Coverage acceptance criteria (fold M0–M9)

- [x] M0/Q-37.1 env: unset/rỗng ⇒ undefined, 31 ký tự ⇒ boot fail (đã có `validation.schema.spec.ts` "shorter than 32 chars"), 32 ký tự ⇒ giữ nguyên. Unit 351 xanh.
- [x] M1 registry riêng: `metrics.spec` "never touches the prom-client global registry".
- [x] M2/M6 `/metrics`: 404 khi tắt; 401 cho mọi credential sai (dev 5 case + tester #1–#4); 200 kèm content-type/no-store; 500 body rỗng.
- [x] M2/M6 test 3, label route là template: dev (probe) + tester #7, #8.
- [x] M6 test 4, exposure: dev + tester #7.
- [x] M3/M2bis counter nghiệp vụ: dev (bảng M2bis) + tester #9, #10.
- [x] M4 khởi tạo 0, alert bắn 0→1: dev (reuse, emergency).
- [x] M7 ops: `ops-rules.spec` (unit) đối chiếu metric/label trong rule, test promtool và dashboard với registry. Tester kiểm chéo độc lập bằng grep: ops chỉ dùng 4 metric `sso_audit_events_total`, `sso_signing_key_rotations_total`, `sso_token_endpoint_errors_total`, `sso_http_request_duration_seconds(_count|_bucket)`, cả 4 đều được khai trong `metrics.ts`. Dashboard có 7 `expr`. Không chạy promtool vì không cài (DEBT-219).
- [x] M8 DEBT-215: dev (lật pin, revoke lỗi ⇒ quét successor) + tester #11–#14.
- [x] M9: typecheck/lint/unit/int FULL/FE/E2E xanh như bảng trên.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm |
|---|---|
| Identity | anonymous (`/metrics` không header; admin route không token ⇒ 401), người giữ token hợp lệ |
| Credential | absent, valid, malformed (10 dạng), độ dài khác, scheme khác hoặc khác hoa thường, header lặp (inject + socket thật), token qua query (dev) |
| Input | path/id/query ngẫu nhiên, method lạ (OTHER), route admin có id |
| State | retry song song sau refusal, reuse thật song song, concurrent first-use, race trước unlink |
| Dependency | registry ném ⇒ 500 (dev), audit ghi lỗi ⇒ counter +0 (dev), observe ném ⇒ request 200 (dev), recheck lỗi + revoke lỗi (dev) |
| Exposure | output `/metrics`: không có id/email/IP/RT/family/tenant/clientId/method thô. Body 401/500 rỗng |
| Request chain | không áp dụng (không có Set-Cookie hay xoay token trong `/metrics`). Chuỗi refresh ⇒ replay đã phủ ở #11–#14 |

Ghi nhận, không mở debt mới:
- Header `Authorization` lặp thì Node giữ giá trị đầu (#5). Không phải bypass.
- Nhiễu `ioredis` lúc teardown int đã có từ trước, thuộc DEBT-054 (`--forceExit`).

Debt: đóng **DEBT-222** (đã có test #6). Không có 🟡 mới, nên không mở DEBT-225.
