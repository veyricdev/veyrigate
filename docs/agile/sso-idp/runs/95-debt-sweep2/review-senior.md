# Senior Review — 2026-11-18

## Lô B (T2 DEBT-683 + DEBT-689), đối chiếu D95.9–D95.14

### Kết luận: PASS

### Tổng quan
Thay đổi gọn, đúng D95.9–D95.14, không lệch.
- `smtp.mailer.ts`: kiểm recipient → kiểm trần → `++pending` → `try { await sendMail } finally { --pending }`.
- Metric theo đúng mẫu `registry` module-level, counter khởi 0, `reason` lạ bị bỏ qua.
- Alert + case promtool + runbook §13 khớp nhau, chữ nghĩa giống hệt nhau.
- Helper `fakeSmtp` bỏ ~90 dòng parser trùng giữa hai suite.
- Test chạm đúng các nhánh quan trọng, và mutation tay xác nhận test đỏ (bảng dưới).

Kiểm các nhánh đếm `pending`:
- **Recipient bị từ chối**: throw trước khi kiểm trần và trước `++` ⇒ không đổi gauge/counter. Test case 3 so sánh toàn bộ `registry.metrics()` trước/sau.
- **Đầy**: chỉ tăng `queue_full`, throw trước `++`, không chạm transport.
- **`sendMail` throw đồng bộ hoặc reject**: lời gọi nằm trong `try` ⇒ `finally` luôn giảm `pending`. Không lệch đếm.
- **Đếm đôi `auth_mail`**: không xảy ra. Mailer không gọi `observeBackgroundWriteFailure` (đã kiểm diff). `auth_mail` vẫn chỉ do caller đếm (D95.10).
- **Shutdown**: đọc `n = this.pending` trước `transport.close()`. Không có race:
  - JS chạy đơn luồng và `onApplicationShutdown` là hàm đồng bộ;
  - các reject do `close()` chỉ chạy `finally` ở microtask sau, nên `n` là số thư còn chờ đúng tại thời điểm đó.
- **PII**: log chỉ có `n`. Message lỗi là chuỗi cố định. Test kiểm log không chứa `example.test`.

Kiểm chứng đã chạy:
- `npm test -- src/modules/mailer src/common/metrics`: 4 suite, 78/78 xanh.
- Mutation tay trên `smtp.mailer.ts`. Đã hoàn lại; sha1 `fe874b10…` trùng bản gốc.

| Mutation | Kết quả |
|---|---|
| m1: bỏ trần (`false &&`) | test cap đỏ |
| m2: `>=` → `>` (off-by-one) | test cap đỏ |
| m3: bỏ `observeMailDropped('shutdown', n)` | test cap đỏ |
| m4: không giảm `pending` khi settle | test cap + pool đỏ |
| m5: `pool: false` (kiểm `peak` sau khi đổi sang `onRcpt`) | pool đỏ: `Received: 20` |

- promtool: không chạy local, vì `docker run` tạo container và lượt này bị cấm. Đã đối chiếu tay với case `SsoAuthMailFailed`/`SsoBackgroundWriteFailed` cũ:
  - cấu trúc `interval`/`input_series`/`alert_rule_test`/`exp_labels`/`exp_annotations` giống;
  - annotation khớp từng chữ với `alerts.yml`;
  - `queue_full` có 25 giá trị (0,0,0, rồi 3 từ phút 3);
  - 2m im, 4m bắn đúng `reason=queue_full`, 24m (cửa sổ (9m,24m] phẳng) im.
  - Hợp lệ. Xác nhận cuối ở job `promtool` CI.

### 🔴 Blocker
Không có.

### Security invariants / trust boundaries đã kiểm
- **Boundary input**: recipient vẫn qua `isDeliverableEmail` trước mọi thứ (D84.1). Suite envelope chuyển sang `fakeSmtp` vẫn xanh.
- **Abuse / DoS**: trần 200 chặn bộ nhớ và hàng đợi tăng vô hạn khi spam `/forgot`/`/register` lúc SMTP treo. Vượt trần ⇒ reject ngay, không mở kết nối.
- **Failure behavior**: fail-open đúng contract. Mọi `mailer.send` là fire-and-forget có `.catch`, nên request vẫn trả trang generic và không tạo oracle. Mất thư được đếm (`sso_mail_dropped_total`) và có alert.
- **Exposure**: log và metric không chứa địa chỉ hay subject. Label `reason` là tập đóng 2 giá trị, nên không có cardinality bomb.
- **Concurrency**: `pending` chỉ đổi đồng bộ quanh `await`, không có TOCTOU giữa lúc kiểm trần và lúc `++`.

### 🟡 Nên sửa
Không có.

### 💭 Nit
- `smtp.mailer.ts` `onApplicationShutdown`: `n` là **cận trên**. Thư đã nhận 250 nhưng promise chưa settle lúc `close()` vẫn bị tính là `shutdown`. Chấp nhận được với counter cảnh báo. Cân nhắc ghi "tối đa" trong runbook §13 nếu muốn chính xác.
- Thư xác minh/đặt lại bị bỏ vì `queue_full` sẽ bắn **cả** `SsoAuthMailFailed` (caller đếm `auth_mail`) **và** `SsoMailDropped`. Đây là quyết định D95.10/D95.11, và runbook §13 đã nói "xử lý như `auth_mail`". Nếu on-call thấy ồn, có thể thêm inhibit rule ở Alertmanager. Không cần sửa ngay.
- `mailer.spec.ts` `fakeSmtp`: `peak` giờ đo lúc nhận RCPT thay vì lúc mở kết nối, nên yếu hơn chút về lý thuyết. Mutation m5 cho thấy vẫn bắt được hồi quy "không pool".

### ✂️ Ponytail
- be/src/modules/mailer/mailer.spec.ts:L13: shrink: `metric()` gần trùng `value()` trong `metrics.spec.ts`. Có thể chấp nhận vì là helper test của file khác, không cần export chung.

Lean already. Ship.

→ Chuyển **tester** (lô D) sau khi có review lô A và xong lô C.

---

## Lô A (T1 DEBT-634), đối chiếu D95.1–D95.8

### Kết luận: PASS

### Tổng quan
Đúng D95.1–D95.8. Diff nhỏ và tái dùng đúng lớp chung:
- `SessionService.revokeAllForUser` (Lua + tombstone `sess_end`) và `createRedisClient` (commandTimeout, `maxRetriesPerRequest: 1`, Sentinel).
- `trustKey` chỉ thêm `export`.
- Sweep tách thành `revokeFamilies`, gọi lại sau Redis.

Hợp đồng `RecoverResult.sessions` + `exitCodeOf` rõ ràng. Int spec bao đủ 4 ca của D95.7 và thêm 3 ca: family sinh giữa commit và revoke, timeout, sweep lỗi.

Kiểm thứ tự (`recoverSuperAdmin` → `revokeAfterCommit`):
1. commit transaction;
2. dòng `recovered:`;
3. dòng JSON alert;
4. Redis (bounded);
5. sweep;
6. dòng `sessions revoked: <n>` hoặc warning cố định;
7. audit `SESSION_REVOKED`.

Đúng D95.4/D95.6. `ADMIN_RECOVERED` vẫn nằm trong transaction.

Kiểm exit code:
- Mọi nhánh lỗi sau commit chỉ đặt `failedStep` và **không ném**. Các nhánh đó là: không có revoker, Redis reject, timeout, sweep reject.
- Kết quả là `'failed'`, rồi `exitCodeOf` trả `3`.
- Audit lỗi chỉ ghi warning, exit code giữ nguyên.
- Từ chối trả `1`.
- Chỉ có một ngoại lệ, xem 💭 2.

Redis client có được đóng không:
- `main` gọi `revoker?.close()` trong `finally` (`disconnect()`), rồi `process.exit(code)`. Promise còn treo sau `Promise.race` timeout không giữ được process.
- Timer của `bounded` đã `unref()` và bị `clearTimeout` trong `finally`.
- Sau `disconnect()`, ioredis reject các lệnh đang chờ. Vì vậy cả trong Jest cũng không rò handle: case `redis://127.0.0.1:1` mất 1,5 s, case treo bị cắt ở 200 ms.
- Client tạo lazy, chỉ khi `revokeSessions` thực sự được gọi. Vì vậy nhánh từ chối hoặc không xác nhận không mở kết nối Redis.

Kiểm chứng đã chạy (2026-11-18):
- Unit `src/database/admin-recover.spec.ts`: 17/17.
- Int `run95-admin-recover-sessions` với `--detectOpenHandles`: 8/8 (13,4 s), không báo open handle. Khoá `vg:int-lock` do globalSetup giữ.
- eslint 5 file lô A: sạch. `tsc --noEmit`: sạch.
- Mutation tay trên `admin-recover.ts`, đã hoàn lại (`git diff --stat` trùng bản dev: +174/−19):

| Mutation | Kết quả |
|---|---|
| m1: bỏ sweep sau Redis (`if (at.getTime() < 0)`) | đỏ: "family minted between…" và "sweep fails…" |
| m2: `DEL` sai key thiết bị tin cậy | đỏ: D95.7 (1), `exists(trustKey) = 1` |

### Đánh giá 5 lệch dev tự nhận
1. **`--reset-mfa` không inject revoker ⇒ `'failed'` (exit 3)**: chấp nhận.
   - Fail-closed về báo cáo. Gọi `recoverSuperAdmin` theo kiểu lập trình mà quên revoker sẽ lộ ra ngay, không âm thầm báo "đã thu hồi".
   - `main` luôn inject revoker khi `--reset-mfa`, nên ở CLI nhánh này không xảy ra.
   - Hệ quả: test run 87 L391 (`--reset-mfa` không có revoker) giờ ghi thêm một audit failure. Test không assert điều đó, xem 💭 4.
2. **Text `warning: trusted devices were not forgotten (redis)`**: chấp nhận. D95.3 chỉ yêu cầu "dòng warning", không chốt chữ. Dòng này cố định, không có email hay URI. Runbook chưa nhắc tới, xem 🟡 1.
3. **Bound 10 s chỉ bọc bước Redis, sweep không bound**: chấp nhận.
   - Đúng chữ D95.3 ("cả bước Redis").
   - Sweep chạy trên connection Mongo đã mở và vừa commit, có server-selection timeout của driver.
   - Bọc thêm cũng không cứu được gì, vì Mongo lỗi ở bước này đằng nào cũng ra exit 3.
4. **Int spec dựng ConfigService tối thiểu**: chấp nhận.
   - Đã đối chiếu `buildConfig`: các key `database.redisUrl` / `redisCommandTimeoutMs` / `redisSentinel`, `app`, `token` khớp với chỗ `createRedisClient` / `SessionService` đọc.
   - Builder `sessionRevoker` là cùng một hàm với `main`, đúng ý D95.7(3).
   - Lỗ còn lại: đường `new ConfigService(buildConfig(env))` của `main` không chạy trong test nào. CLI build chỉ được spawn ở dry-run. Xem 💭 3.
5. **Logger `RedisClient` in `ECONNREFUSED`**: chấp nhận.
   - Đây là logger dùng chung, message đã qua `scrubUriCredentials`, chỉ còn host:port.
   - Dòng cố định của D95.5 vẫn không có chi tiết lỗi.
   - Khi Redis chết, mỗi lần reconnect in một dòng (200 ms → 2 s), nên tối đa khoảng 10 dòng trong 10 s. Chấp nhận được cho CLI.

### 🔴 Blocker
Không có.

### Security invariants / trust boundaries đã kiểm
- **State / thứ tự**: thu hồi chỉ chạy sau commit. Sweep chạy sau Redis, nên chặn được family do `/token` tạo trong khe giữa hai bước (test + m1).
  - Family tạo sau sweep vẫn chết: `mfa` đã gỡ, và family cũ đã bị đánh `familyRevokedAt`.
  - Khi `/token` chạy, phiên đã có tombstone nên `exists(ref)` là false.
- **Phạm vi**: key Redis chỉ gồm `user_sess:{id}` + `sess:*` của chính index đó (Lua) và `dc:{u:sha256(id)}` của user đích. Test (2) xác nhận user khác còn nguyên phiên, thiết bị và family.
- **Failure behavior**: Redis chết hoặc treo thì Mongo giữ commit (D95.5). Kết quả `'failed'`, exit 3, audit failure `revoke_failed {failedStep}`. Không ném, không báo thành công giả.
- **Exposure**: dòng in không có email, URI hay lỗi Redis. Test `expectClean` kiểm cả output lẫn warnings. Audit metadata là giá trị cố định.
- **Identity**: actor audit là `system` / `requestedBy`, cùng hình với API. `targetId` là id thật. Không lộ thêm gì so với `ADMIN_RECOVERED`.

### 🟡 Nên sửa
1. **runbook-ops.md §11 (đoạn Exit 3): hướng xử lý chưa tách `(redis)` và `(sweep)`.** → DEBT-692
   - Với `(sweep)`, Redis **đã** thu hồi xong (code: `failedStep` chỉ thành `'sweep'` khi Redis OK). Lỗi nằm ở Mongo.
   - Runbook vẫn bảo "Sửa Redis theo §5" và câu "Trong lúc Redis chết, phiên cũ cũng không dùng được". Câu này cũng sai cho trường hợp Redis chậm hoặc timeout: Redis vẫn sống, phiên vẫn dùng được.
   - Ngoài ra dòng `warning: trusted devices were not forgotten (redis)` (exit 0) chưa có hướng xử lý.
   - Vì sao: on-call 3 giờ sáng đọc runbook theo nghĩa đen. Sửa nhầm hệ thống thì kéo dài thời gian phiên cũ còn sống.
   - Đề xuất: tách hai gạch đầu dòng. `(redis)`: §5, rồi (a)/(b). `(sweep)`: kiểm Mongo, rồi (a) (API revoke cũng sweep) hoặc (b). Thêm một câu cho dòng thiết bị tin cậy: gọi API revoke khi Redis hồi, hoặc bỏ qua vì đó chỉ là quota throttle.

### 💭 Nit
1. Chữ `sessions were NOT revoked (sweep)` của D95.5 không đúng nghĩa đen cho nhánh sweep, vì phiên đã thu hồi, chỉ family chưa. Đổi chữ là đổi D95.5, nên ghi vào DEBT-692 để tech-lead quyết cùng runbook.
2. `admin-recover.ts` `main`: nếu `conn.close()` trong `finally` reject sau khi đã commit, `main` ném và CLI trả **1**. Runbook định nghĩa 1 là "lỗi trước commit". Rất hiếm, và chạy lại thì user đã là super_admin. Cân nhắc `await conn.close().catch(() => undefined)`.
3. Không test nào chạy `sessionRevoker(new ConfigService(buildConfig(env)))` thật, tức không có CLI build non-dry-run với `--reset-mfa`. Typecheck che phần hình dạng. Một ca `buildConfig(validateEnv(<env int tối thiểu>))` trong int spec sẽ khoá lại.
4. `run87-admin-recover.int-spec.ts` L388–399: có thể thêm `expect(result.sessions).toBe('failed')` để ghi lại lệch (1) ở chỗ người đọc thấy.

### ✂️ Ponytail
- be/src/database/admin-recover.ts:L186: shrink: `session ? { session } : {}` lặp 2 lần. Có thể gán `const opts = session ? { session } : {}` một lần. Lợi -1 dòng, không đáng.

Lean already. Ship.

→ Lô A + lô B PASS ⇒ backend-dev lô C (T3 DEBT-570), rồi tester lô D.

---

## Lô C (T3 DEBT-570), đối chiếu D95.15–D95.18

### Kết luận: PASS

### Tổng quan
Thay đổi gọn và theo đúng một quy tắc: mọi redirect trả từ handler `@Post` ⇒ 303, mọi `@Get` giữ 302. Helper dùng chung nhận `status` tường minh (`backToLogin(reply, 302|303)`, `handleError(reply, err, 302|303)`), nên mỗi caller tự chọn mã, không suy luận ngầm. `Location`, cookie, CSRF, authn không đổi. Điểm tốt: dev đổi luôn các check lỏng sau POST (`=== 302` có điều kiện, `not.toBe(302)`), không chỉ `toBe(302)`, nên các check đó vẫn có nghĩa. Không chỗ nào dùng `302 || 303`.

**(a) Quét toàn bộ `be/src`** (`@Post`/`@Get`/`redirect(`/`Location`/`.code(30`), không chỉ danh sách D95.15:
- `@Post` có redirect, tất cả là 303:
  - `/login`, `/login/mfa`, `/account/password`;
  - `/logout`, cả nhánh RP 503/505 và nhánh cuối 602/606 (cùng một method, dòng 470–606);
  - `/account/mfa/{start,confirm,disable,recovery}`;
  - `/account/{sessions/revoke, sessions/revoke-others, devices/forget, devices/forget-others, apps/revoke}` (327/437 vốn đã 303);
  - `/auth/link`;
  - `/authorize/consent`, gồm `handleError` nhánh `AuthorizeRedirectError`;
  - `/reset/code` (vốn đã 303).
- `@Post` không redirect: `/register`, `/forgot`, `/verify-email`, `/reset`, `/token`, `/revoke`, `/introspect`, `/userinfo`. Module admin không có redirect. Không có header `Location` hay `code(30x)` viết tay.
- `@Get` giữ 302:
  - `/`, `/login`, `/register`, `/account/password`, `/account/sessions`, `/account/apps`, `/account/mfa`;
  - `/login/mfa` (`backToLogin(reply, 302)`);
  - `/authorize`: `respond()` (211/249) chỉ được gọi từ GET (108/112), `handleError(…, 302)`;
  - `/auth/:provider/start`, `/auth/:provider/callback` (166/170/173).
  - Không GET nào bị đổi nhầm.
- `@HttpCode(303)` trên consent không có tác dụng khi handler dùng `@Res()`: nhánh nào cũng tự đặt mã (redirect 303 hoặc `status(400)`). Đổi từ 302 chỉ cho nhất quán. Chấp nhận.

**(b) Assertion test.** Đã grep diff `be/test`, `e2e`, `be/scripts` tìm `||`, `[30x,…]`, `toContain`, `.not.`, khoảng `>=300`:
- `authorize.int-spec.ts:1179` `expect([303, 403]).toContain(...)`: mảng cũ là `[302, 403]` (403 = CSRF fail-closed, có comment). Mảng mới không nhận 302 ⇒ không nới.
- `run86-tester.int-spec.ts:428` `not.toBe(303)`: đổi theo mã thành công mới (trước là `not.toBe(302)`).
- Các `=== 302` còn lại trong test đều là response GET (`/authorize` resume, `/auth/*/start|callback`). Đã đọc từng chỗ: `admin` 999, `authorize` 907/1291/1361, `federation` 296/1265/2519, `seed-risk-flow` 239, `full-app` 276.
- Harness: `signedIn`, `ctx.uiLogin`, 748, 785, `pentest.mjs:120` đúng 303. Ở 442 chỉ `res` là POST; `fakeHome`/`promoted` là GET, giữ 302. `ctx.authorize` không kiểm status, chỉ lấy `Location`.
- E2E: `fe-admin.ts:43` đúng 303. `mfa.spec.ts:105` và `account-self-service.spec.ts:181` là GET, giữ 302.
- `b73c-tester.vault-spec.ts:249` là POST `/logout` ⇒ 303 đúng. Sửa tĩnh; job vault của CI là gate.

**(c) `drills/lib.mjs` `codeFlow`:**
- POST `/login`, POST `/login/mfa` ⇒ 303. GET `/authorize` khi chưa có phiên (344) giữ 302. Đúng.
- `codeStatus` = 302 khi GET `/authorize` trả code thẳng, = 303 khi đi qua POST `/authorize/consent`. Đúng, và chặt hơn trước vì không nhận cả hai mã.
- Lệch D95.16 hợp lý: không sửa thì drill backup-restore/rotate đỏ ở CI. Local chỉ chạy được `node --check`.

**(d) Mutation tay.** Backup ở scratchpad, đã hoàn lại, `sha1sum -c` OK cả 2 file:

| Mutation | Đỏ ở đâu |
|---|---|
| m1 `ui.controller.ts:343` 303 ⇒ 302 | `run95-post-303` › POST /login signed in (+ run89 AC14) |
| m2 `mfa.controller.ts:104` GET `backToLogin` 302 ⇒ 303 (GET đổi nhầm) | `run95-post-303` › đối chứng GET /login/mfa |
| m3 `mfa.controller.ts:140` nhánh `restart` 303 ⇒ 302 | spec mới không phủ nhánh này; `run89-mfa-login` AC4 (`fifth.statusCode` 303) bắt |

Tổng: 2 suite, 4 test đỏ đúng lý do.

**Chạy lại:**
- `pnpm test:int run95-post-303` 27/27 (14.6 s, lấy `vg:int-lock` bình thường);
- `pnpm typecheck` exit 0;
- eslint `src/modules/ui`, federation, authorize, admin-recover, spec mới: 0 lỗi;
- `node --check` `drills/lib.mjs`, `pentest/checks.mjs` OK.

### 🔴 Blocker
Không có.

### Security invariants / trust boundaries đã kiểm
- **Chuỗi request**: client đổi 303 thành GET, như đã làm với 302 ⇒ cookie phiên/ticket/thiết bị đặt trước redirect không đổi. `Location` giữ nguyên (spec mới assert từng `Location`). Redirect consent → RP vẫn qua `buildRedirect` với `redirectUri` đã exact-match từ context lưu, không lấy từ body.
- **CSP form-action (DEBT-084/647)**: code nới `form-action` không đổi, chỉ cập nhật comment. E2E ở lô D là gate cho chuỗi POST → 303 → RP trên Chromium.
- **Open redirect**: `safeReturnTo` vẫn bọc `returnTo` ở `/login` và `/login/mfa`. Harness `OAUTH-OPENREDIR-*` vẫn chỉ nhận đúng 303 + path nội bộ.
- **Failure behavior**: POST `/account/*` hết phiên vẫn về `/login`, không thành công giả. Consent mất phiên ⇒ `/login`, không bao giờ cấp code.
- **Exposure**: không thêm log hay header.

### 🟡 Nên sửa
Không có.

### 💭 Nit
- `e2e/tests/login.spec.ts:58` comment "that 302s to `/callback`", giờ là 303 (POST consent). Chỉ là comment; sửa khi chạm file.
- `run95-post-303` không phủ POST `/logout` nhánh RP (`ui.controller.ts:503`) và nhánh `restart` của `/login/mfa` (140). Cả hai đã có suite khác assert 303 (m3 xác nhận run89 AC4; ui/session-reflection cho logout RP), nên không cần thêm.
- `run86-tester.int-spec.ts:428` `not.toBe(303)` là assertion phủ định có từ trước, chỉ đổi số. Muốn chặt hơn thì cân nhắc assert mã cụ thể thay vì "không phải 303".

### ✂️ Ponytail
Lean already. Ship.

---

## Lô A retry 1 (DEBT-692 + nit 2/4), đối chiếu runbook ↔ code

### Kết luận: PASS

### Tổng quan
DEBT-692 xử lý đúng ý: runbook-ops §11 tách 2 nhánh exit 3 theo đúng chữ CLI in ra; bảng exit ở §3d nêu `(redis)`/`(sweep)`.

Đối chiếu với `be/src/database/admin-recover.ts`:
- **Chữ warning**: 2 dòng trong runbook trùng từng ký tự với code (447, 449). `failedStep` trong audit (`'sessions'`/`'sweep'`) khớp mô tả.
- **Nhánh `(redis)`**: code đặt `failedStep='sessions'` cả khi Redis lỗi lẫn khi `bounded` hết 10 s. Runbook nói "lỗi hoặc chỉ chậm, phiên cũ có thể vẫn sống" là đúng.
- **Nhánh `(sweep)`**: code chỉ vào nhánh này khi `revokeSessions` thành công ⇒ "phiên đã thu hồi, không cần sửa Redis" đúng. Khi cả hai bước cùng lỗi, `??=` giữ `'sessions'` nên CLI in dòng `(redis)`; (a)/(b) của nhánh này cũng sweep lại family, nên không thiếu bước.
- **(a) và (b)**:
  - (a) `POST /admin/users/{id}/sessions/revoke` gọi `revokeAllUserCredentials` (families, sessions, sweep, `forgetDevices`).
  - (b) enroll MFA: `mfa.controller.ts:392` gọi cùng hàm.
  - Vậy câu "cả hai đều sweep lại family" và "xoá thiết bị tin cậy" đúng.
- **Lệch D95.5** (dòng sweep thêm `sessions revoked: <n>`): chấp nhận. Đã ghi log; int `run95-admin-recover-sessions:342` assert đúng chuỗi mới, kèm `not.toContain('sessions were NOT revoked')`.
- **Nit 2**: `conn.close().catch(...)` nằm trong `finally` ⇒ lỗi đóng Mongo chỉ in warning, exit code đã tính (0/3) giữ nguyên, không thành 1. Không có test riêng (cần spawn CLI): chấp nhận.
- **Nit 4**: run87 assert `toMatchObject({ status: 'recovered', userId, sessions: 'failed' })` khi không inject `revokeSessions`.

**Chạy lại:** unit `admin-recover.spec` 17/17; int `run95-admin-recover-sessions` 8/8. Không chạy lại `run87` vì cần `pnpm build`; dev đã chạy 2 suite 35/35.

### 🔴 Blocker
Không có.

### Security invariants / trust boundaries đã kiểm
- **Failure behavior**: mọi nhánh lỗi sau commit cho exit 3 và chữ trỏ đúng mục runbook. Không nhánh nào in "thành công" khi phiên có thể còn sống. Lỗi đóng Mongo không che exit 3.
- **Exposure**: các dòng in mới là chuỗi cố định, không email, URI hay chi tiết lỗi.

### 🟡 Nên sửa
Không có.

### 💭 Nit
- Câu về dòng `warning: trusted devices were not forgotten (redis)` trong runbook ghi "phiên đã thu hồi nhưng thiết bị tin cậy còn". Thực tế `del(trustKey)` chạy trong `finally` của `revokeSessions`, nên dòng này có thể đi kèm dòng `(redis)`, khi phiên **chưa** thu hồi. Cân nhắc viết: "nếu không kèm dòng `(redis)` thì phiên đã thu hồi". Thao tác (a)/(b) vẫn đúng ở cả hai trường hợp.

### ✂️ Ponytail
Lean already. Ship.

→ Lô C + lô A retry 1 PASS ⇒ tester lô D (gate D95.20).
