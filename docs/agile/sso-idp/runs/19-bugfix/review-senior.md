# Senior Review — 2026-10-13
## Kết luận: PASS

Run 19-bugfix (DEBT-059/055/060/001+003/005). Không còn 🔴. Có 6 mục 🟡, đã ghi vào `backlog.md` dưới dạng DEBT-065…070.

## Bước 0 — rà mutation còn sót từ lượt review trước + baseline
- So `git diff` của 7 file nguồn (token.controller/service, authentication.service, consent.service, health.controller, redis.module, config/validation) với `tasks.md` (bản đã fold) và `log.md` của backend-dev: **khớp hoàn toàn, không thấy mutation sót**. Không có `.only/.skip`, không có `git stash`. Không phải khôi phục file nào.
- Có một byte hỏng nhưng **không phải mutation**: ở comment của 3 file test mới, dấu backtick bị PowerShell escape (`` `b `` thành `\x08`, các ký tự khác thành `\`). Xem 🟡#1.
- Baseline: `pnpm test` **141/141**, `pnpm test:int` **413/413** (21 suites), typecheck + lint exit 0. Ghi chú: int cần `vg-test-mongo@27117` + `vg-test-redis@6479`. Hai container này đang dừng nên lần chạy đầu treo hoặc fail vì timeout hạ tầng, không phải lỗi code. Sau `docker start` thì suite xanh.
- sha256 baseline: token.controller `c34e10de…`, authentication.service `737b9766…`, consent.service `447f3ab4…`, redis.module `d5487d4f…`, health.controller `48e010e7…`. Sau mỗi mutation, file đều được ghi lại từ buffer gốc và sha256 khớp (`restored OK`), tức byte-identical. Kiểm lại sau lượt mutation cuối: cả 5 hash vẫn khớp baseline.

## Tổng quan
Fix đúng phương án tech-lead đã chốt, gọn và có comment giải thích "vì sao". Điểm tốt:
- DEBT-059: `TOKEN_ISSUED success` được dời xuống **sau** re-check và **ngay trước** `reply.send`. Nếu ghi audit success lỗi thì revoke family, trả 500 và không trả token. Đúng INV-25/29.
- DEBT-055: `runStep` cô lập từng bước, giữ lỗi đầu tiên. Audit failure là best-effort, không che lỗi gốc. Không rollback password.
- DEBT-001: không đụng tới filter global, chỉ trả 503 trực tiếp. Body chỉ gồm enum `up|down`, có `no-store`.
- DEBT-005: tách `buildRedisOptions` thành hàm thuần nên test được option thật. Có giải thích lý do `maxRetriesPerRequest:1` (chống replay offline queue).

## Mutation testing (16 mutant, mỗi mutant khôi phục ngay bằng sha256)
| # | Mutation | Kết quả |
|---|---|---|
| M1 | Ghi audit `success` TRƯỚC re-check (cách cũ) | KILLED (token.int 4 fail) |
| M2 | Bỏ `failure session_ended` khi `!live` | KILLED (2 fail) |
| M3 | Audit success lỗi mà không revoke family | KILLED (1 fail) |
| M4 | Nhánh re-check Redis lỗi lại ghi `success` | KILLED (1 fail) |
| M5 | Bỏ re-check (`live=true`), tức phá race run 18 | KILLED (3 fail) |
| M14 | Happy path không ghi `success` | KILLED (2 fail) |
| M6 | Reset: dừng lại ở bước lỗi đầu tiên | KILLED |
| M7 | Reset: giữ lỗi CUỐI thay vì lỗi đầu | KILLED |
| M8 | Reset: audit failure không best-effort (che lỗi gốc) | KILLED |
| M15 | Reset: lỗi revoke vẫn ghi `success` | KILLED |
| M9 | Consent: retry với mọi lỗi | KILLED |
| M10 | Consent: không retry | KILLED |
| M11 | Redis `maxRetriesPerRequest:null` | KILLED (RED/GREEN timing) |
| M12/12b | Bỏ/undefined `commandTimeout` | KILLED, **nhưng chỉ nhờ test assert option** |
| M16 | Như M12b, chỉ chạy 2 test hành vi (GREEN + rate-limit fail-closed) | **SURVIVED**, xem 🟡#2 |
| M13 | `/ready` bỏ status 503 | KILLED (3 fail) |

Flakiness: chạy `redis-fail-fast` + `health` **5 lần liên tiếp với `--detectOpenHandles`**: 9/9 pass cả 5 lần, không có cảnh báo open handle hay "did not exit".

## 🔴 Blocker
Không có.

## Security invariants / trust boundaries đã kiểm
- **INV-25 (audit integrity, DEBT-059)**: Có 4 đường ra sau mint. Live + audit OK → `success` rồi send. Live + audit lỗi → revoke family + 500, không token. `!live` → (revoke family + `TOKEN_REVOKED`) + `failure session_ended` + `invalid_grant`. Re-check ném lỗi → revoke family best-effort + `failure session_check_failed` best-effort + rethrow 500. Không còn đường nào ghi `success` mà không trả token (M1/M4 bị kill). Cũng không có đường nào trả token khi audit success lỗi (M3 + int "audit of success fails").
- **INV-29 (TOCTOU, run 18)**: re-check vẫn nằm sau insert, áp dụng cho mọi code grant; M5 bị kill. Thứ tự "audit trước re-check" (M1) bị bắt bởi test int `exists true→false`.
- **Exposure**: metadata `recordIssued` chỉ gồm `{resource, scope, refresh}`, không chứa token/code/secret (unit test assert `toEqual`). `/ready` không lộ message/host (test assert `not.toContain('mongo refused')`). Body 503 không có `error`/`error_description`.
- **Filter OAuth không đổi**: `oauth-exception.filter.ts` không có trong diff. Route `/boom` trong cùng app vẫn trả `{error:'server_error', error_description}`.
- **Credential reset (INV-11/28, DEBT-055)**: cả 3 bước đều chạy dù bước trước lỗi (M6 bị kill). Lỗi được rethrow nên vẫn 5xx. Không rollback. Audit failure không chứa password/hash/token (`metadata:{failedStep}`).
- **Consent (DEBT-060)**: chỉ retry khi `code===11000`. Retry đúng 1 lần, lần thứ hai propagate nguyên lỗi. Hai lần ghi có cùng filter + pipeline (`$setIntersection`, `$literal`); test assert `calls[0]` bằng `calls[1]`, nên không mở đường over-grant. `userId` vẫn lấy từ server.
- **Fail-closed khi Redis down (DEBT-005)**: `RateLimitGuard.canActivate` và `UiController.limit` không có `catch` cho qua. `hit` reject thì thành 5xx, đúng fail-closed (int test assert `rejects`). Shared client không dùng blocking command hay pub/sub, nên `commandTimeout` không phá lệnh hợp lệ nào. Lua (`defineCommand`) có timeout per EVALSHA; caller đều fail-closed như tech-lead ghi.
- **Failure behavior**: không nhánh nào biến lỗi DB/Redis thành success hay guest.

## 🟡 Nên sửa
1. 🟡 **Byte điều khiển hỏng trong comment test**
   `be/test/redis-fail-fast.int-spec.ts:9`: comment chứa `\` + `\x08` (backspace) + `uildRedisOptions\`. Các comment khác ở L11, L23, `be/test/health.int-spec.ts:21-24` và `be/src/modules/oauth/consent/consent.service.spec.ts:6` đều có backtick bị đổi thành `\`.
   Vì sao: file được ghi qua PowerShell double-quote (`` ` `` là ký tự escape). Byte điều khiển trong source làm diff/grep khó đọc, và lint không bắt được.
   Đề xuất: đổi `\…\` về `` `…` `` và xoá `\x08`. Sau này nên ghi file bằng tool edit hoặc here-string đơn `@'…'@`.
2. 🟡 **Test hành vi DEBT-005 không chứng minh `commandTimeout`**
   `be/test/redis-fail-fast.int-spec.ts:59-68,77-96`: trỏ tới `127.0.0.1:1`, nên kết nối bị **refused**. `maxRetriesPerRequest:1` đã tự flush queue nhanh, nên bỏ `commandTimeout` thì test GREEN và rate-limit vẫn xanh (M16 SURVIVED). Chỉ test assert option mới kill được mutant đó.
   Vì sao: acceptance là "Redis **không phản hồi**". Kịch bản nguy hiểm là server nhận TCP nhưng treo (blackhole, partition, Redis bị kẹt), và đó mới là chỗ `commandTimeout` có tác dụng.
   Đề xuất: thêm một case với `net.createServer()` accept socket nhưng không bao giờ trả lời. Assert `get` reject trong khoảng `timeout + 500ms` với thông báo `Command timed out`, rồi đóng server và socket trong `finally`.
3. 🟡 **`!live` khi revoke family ném lỗi thì mất audit failure**
   `token.controller.ts:215-224`: nếu `revokeFamilyForEndedSession` ném (Mongo lỗi ở `revokeFamily` hoặc ở audit `TOKEN_REVOKED`), `recordIssued(failure, session_ended)` không chạy và request trả 500. Kết quả vẫn fail-closed và không có `success` giả, nhưng audit thiếu dòng phản ánh từ chối. Đây đúng là lớp lỗi mà DEBT-055 vừa sửa cho reset.
   Đề xuất: bọc revoke trong `try/finally`, hoặc ghi `failure` best-effort trước khi rethrow. Thêm int test stub `revokeFamilyForEndedSession` reject.
4. 🟡 **Trùng logic tính `refresh`**
   `token.service.ts:178` `recordIssued`: tính lại `scopes` + `refresh` y hệt `issueRefresh` trong `issueForAuthorizationCode`. Nếu hai chỗ lệch nhau sau này, audit sẽ nói sai việc có cấp refresh hay không.
   Đề xuất: controller truyền `refresh: familyId !== undefined`, hoặc `issueForAuthorizationCode` trả về `issueRefresh`. Khi đó `recordIssued` không cần biết quy tắc grant.
5. 🟡 **Interface reply riêng thay vì type dùng chung**
   `health.controller.ts:6-9`: khai báo `HealthReply` riêng, trong khi DEBT-022 đã gom các shape vào `common/http/http.types.ts`.
   Đề xuất: dùng `Pick<HttpReply, 'status' | 'header'>`.
6. 🟡 **Hạ tầng test int không có preflight**
   `pnpm test:int` cần `vg-test-mongo@27117` + `vg-test-redis@6479` đang chạy. Nếu không, suite treo khoảng 10 phút với 328 fail do timeout, và không có thông báo rõ ràng.
   Đề xuất: ghi runbook test, hoặc thêm jest `globalSetup` kiểm port rồi fail-fast với hướng dẫn `docker start …`. Cũng đã cập nhật số tổng test trong STATUS (531 → 554).

## 💭 Nit
- `authentication.service.ts:224`: cast `failedStep as string` không cần thiết nếu khai báo `metadata` đúng union.
- `token.service.spec.ts` test "recordIssued(success)" gọi `issueForAuthorizationCode` chỉ để lấy `res` rồi `mockClear`. Có thể build `data` trực tiếp để test chỉ kiểm `recordIssued`.
- `recordIssued` dùng `data.resource ?? ''`. Code grant không có resource đã bị chặn bằng `invalid_target` trước khi tới đây, nên `?? ''` là phòng thủ chết.

## ✂️ Ponytail
- be/src/modules/oauth/token/token.service.ts:L178: shrink: tính lại `scopes`/`refresh` trong `recordIssued`. Thay bằng tham số `refresh: boolean` (controller truyền `!!familyId`), bớt khoảng 3 dòng.
- be/src/modules/oauth/token/token.controller.ts:L205,L236: shrink: khối `if (familyId) await this.refresh.revokeFamily(...).catch(()=>undefined)` lặp 2 lần. Thay bằng helper local `const revokeMinted = () => …`, bớt khoảng 4 dòng.
- be/src/modules/health/health.controller.ts:L6: delete: `interface HealthReply`. Thay bằng `Pick<HttpReply,'status'|'header'>`, bớt 4 dòng.
- be/src/modules/oauth/consent/consent.service.ts:L120-L141: shrink: 2 lần gọi `upsertGrant` với 7 đối số y hệt. Thay bằng `const attempt = () => this.upsertGrant(...)` rồi `try { return await attempt() } catch … return attempt()`, bớt khoảng 9 dòng.
- be/src/modules/authentication/authentication.service.ts:L181-L194: shrink: comment cũ ("Any infra failure here propagates… do NOT swallow") nay chồng lên comment DEBT-055 mới. Gộp lại thành một đoạn, bớt khoảng 4 dòng.
net: -24 lines possible.

## Chuyển tiếp
PASS → **tester**. Các mục 🟡 đã vào `backlog.md` dưới dạng DEBT-065…070.