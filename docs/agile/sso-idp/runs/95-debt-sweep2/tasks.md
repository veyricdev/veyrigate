# Run 95 — debt sweep 2 (M8, lane BE/ops)

Tiêu chí: dùng được ở production (người dùng ủy quyền tự quyết). Đọc trước: `STATUS.md`, `spec.md` §4/§8, `plan.md` §12 (D89.x, D91.x, D94.x), `runbook-ops.md`, `backlog.md` các DEBT dưới đây.

## Ngoài phạm vi
- DEBT-673/675 (chờ người dùng), go-live (1)/DEBT-670 (môi trường thật), DEBT-690 (chờ picomatch vá).
- DEBT-633/622 (luồng federation + MFA, lớn) — run sau.

## Ràng buộc (giữ nguyên các run trước)
- Hạ tầng chung `veyrigate-mongo`/`veyrigate-redis`/`veyrigate-mailpit-1`: KHÔNG `compose up`, KHÔNG tạo container, KHÔNG FLUSH/drop DB không phải của mình, KHÔNG restart container (cần người dùng).
- Không đọc/sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Không in secret/PEM header.
- Không kill process không phải mình tạo (ngoại lệ duy nhất: tiptap vite :5173). Không download/npx gói chưa cài.
- Giá trị trông như secret trong test phải dựng lúc chạy (D92.8, gitleaks).
- Harness pentest đầy đủ chỉ chạy SAU E2E; SMTP `220` trước mỗi lô cần thư (D94.12).
- Đọc code qua CodeGraph MCP; terminal = Git Bash.

## T0 [orchestrator] DEBT-579 dọn backlog
Run 89 đã đóng MFA (TOTP + mã khôi phục + bước 2 + cổng admin, tester lô D PASS) nhưng dòng DEBT-579 vẫn 🔄. Orchestrator đóng khi đóng run (WebAuthn đã có ở DEBT-624).

## T1 [BE/ops] DEBT-634 (🟡)
`admin-recover --reset-mfa` chỉ ghi Mongo; phiên Redis cũ của user vẫn sống với RP khác. Hướng: CLI thu hồi phiên Redis sau commit (best-effort, in rõ kết quả, exit code phân biệt "Mongo xong nhưng Redis lỗi"), dùng lại đúng đường thu hồi của `POST /admin/users/:id/sessions/revoke`; runbook-ops cập nhật (nếu Redis lỗi ⇒ bắt buộc gọi API revoke). Tech-lead chốt có áp dụng cho mọi nhánh recover (không chỉ `--reset-mfa`) hay không.
AC: int test: phiên Redis của user trước recover ⇒ sau recover không dùng được (SSO tới RP khác phải đăng nhập lại); Redis không kết nối được ⇒ Mongo vẫn commit, CLI in cảnh báo cố định + exit code riêng; audit ghi số phiên đã thu hồi.
- [x] Lô A xong (backend-dev, 2026-11-18): D95.1–D95.8, xem log.md.

## T2 [BE] DEBT-683 (💭) + DEBT-689 (🟡 ponytail)
Hàng đợi pool nodemailer không giới hạn. Đặt trần (vượt ⇒ bỏ thư, `observeBackgroundWriteFailure('auth_mail')`, log cố định không PII), metric độ sâu hàng đợi, log số thư bị bỏ khi shutdown. Tech-lead chốt: trần bao nhiêu, cấu hình qua env hay hằng; đếm "đang chờ" bằng gì (nodemailer không lộ độ dài hàng đợi công khai ⇒ đếm in-flight tự quản).
Đồng thời tách helper `fakeSmtp({ onRcpt, onMessage })` trong `mailer.spec.ts` dùng cho cả hai suite (DEBT-689).
AC: unit: SMTP treo + gửi N > trần ⇒ đúng (N − trần) thư bị bỏ, counter tăng, không ném lỗi ra request; metric phản ánh độ sâu; shutdown log số bị bỏ. Pentest `HYG-MAIL`/`HYG-SMTP-AFTER` vẫn xanh.

## T3 [BE] DEBT-570 (💭, RFC 9700 §4.12)
Redirect sau POST form có credential dùng 302 (`/login`, consent, và tech-lead rà các POST form UI khác: `/login/mfa`, `/auth/link`, `/register`?, `/account/*`). Đổi sang 303. Không đổi redirect của GET `/authorize`.
AC: int test status 303 cho từng route được đổi; E2E 53 + X3 42 xanh không sửa assertion ngoài status; harness pentest không còn check nào kỳ vọng 302 ở các route này (cập nhật check nếu có, mutation không yếu đi).
- [x] Lô C xong (backend-dev, 2026-11-18): D95.15–D95.18, xem log.md (thêm `be/scripts/drills/lib.mjs` `codeFlow`).

## Thứ tự lô (đề xuất, tech-lead chốt)
- Lô A: T1. Lô B: T2. Lô C: T3. Lô D: tester gate đầy đủ (unit, int FULL, E2E, X3, `mutate.mjs all`, harness on/off, SMTP 220).
- **Tech-lead chốt ở D95.20** (A ∥ B, C sau A+B, D). Sửa AC: T1 "SSO tới RP khác" đo bằng D95.7; T1 áp chỉ `--reset-mfa` (D95.2); T2 counter thư bị bỏ là `sso_mail_dropped_total`, `auth_mail` vẫn do caller đếm (D95.10/D95.11); T3 "E2E/X3 không sửa assertion ngoài status" giữ, danh sách sửa ở D95.16.

## Quyết định D95.x (tech-lead fold, 2026-11-18)

Tiêu chí: dùng được ở production (người dùng ủy quyền). Khi D95.x và mô tả task ở trên mâu thuẫn, làm theo D95.x. Số dòng là của `d23666a`.

### T1: DEBT-634 (`admin-recover` thu hồi phiên Redis)

**D95.1 Chỗ sửa.**
- CLI: `be/src/database/admin-recover.ts` (`recoverSuperAdmin` + `main`, script `db:admin-recover`).
- Nhánh hiện có: từ chối (`user_not_found` / `super_admin_exists` / `target_locked` / `not_confirmed`), `--dry-run`, `--unlock`, `--allow-existing-super-admin`, `--reset-mfa`.
- `POST /admin/users/:id/sessions/revoke` (`admin-users.controller.ts:276`) gọi `AuthenticationService.revokeAllUserCredentials` (`authentication.service.ts:682`), theo thứ tự:
  1. families (Mongo);
  2. `SessionService.revokeAllForUser` (Lua `REVOKE_ALL_SCRIPT`: xoá `sess:*`, ghi `sess_end:*`, xoá `user_sess:{id}`);
  3. sweep families;
  4. quên thiết bị tin cậy (`dc:{u:sha256(id)}`, best-effort).

**D95.2 Phạm vi: chỉ `--reset-mfa`.**
- `--reset-mfa`: yếu tố thứ hai bị gỡ vì mất/lộ thiết bị ⇒ phiên cũ (có `mfaAt`) phải chết ở mọi RP. Đây là lỗ DEBT-634.
- `--unlock`: khoá admin đã thu hồi mọi phiên lúc khoá (`admin-users.controller.ts:209`); user bị khoá không đăng nhập được ⇒ không có phiên để thu hồi.
- Recover thường (chỉ cấp `super_admin`): phiên cũ là của chính user, không đổi gì về bảo mật; console vẫn đòi MFA (D89.5). Không thêm failure mode Redis vào đường break-glass chính.
- Không có `--reset-mfa` ⇒ CLI **không** tạo client Redis (giữ hành vi run 87).

**D95.3 Không dùng Nest standalone context.**
- Lý do: `createApplicationContext(AppModule)` dựng cả app (key provider/Vault, listener alert, MFA keyring…): nặng, thêm failure mode và side effect.
- Dựng thủ công đúng các lớp dùng chung, không viết lại logic:
  - `const config = new ConfigService(buildConfig(env))` (`env` = `validateEnv` sẵn có);
  - `const redis = new RedisService(createRedisClient(config))` (`redis.module.ts`: giữ `commandTimeout`, `maxRetriesPerRequest: 1`, Sentinel);
  - `new SessionService(redis, config).revokeAllForUser(userId)`: đúng bước `sessions` của API (Lua + tombstone `sess_end` ⇒ access token mang `sid` chết qua liveness).
- Thiết bị tin cậy: thêm `export` cho `trustKey` ở `login-throttle.service.ts:307` (không đổi gì khác). CLI `DEL` key đó best-effort như API: lỗi ⇒ dòng warning, không đổi exit code.
- Sweep families **sau** Redis, như bước `sweep` của API (chặn family do `/token` tạo giữa commit và revoke):
  - tách 2 lệnh `updateMany` đang có trong transaction (`familyRevokedAt` rồi `revokedAt`) thành hàm cục bộ `revokeFamilies(conn, userId, at, session?)`;
  - gọi trong transaction như cũ, và gọi lại sau Redis (không session).
- Luôn `redis.client.disconnect()` trong `finally` (retryStrategy của ioredis không tự dừng). Cả bước Redis bị chặn bởi `Promise.race` 10 s.

**D95.4 Thứ tự và hợp đồng hàm.**
- Bước Redis chạy **sau** khi transaction Mongo commit, sau dòng `recovered: …` và dòng JSON alert (giữ nguyên hai dòng đó).
- `RecoverIo` thêm `revokeSessions?: (userId: string) => Promise<number>` (inject để int test dùng Redis int). `main` dựng nó theo D95.3, chỉ khi `args.resetMfa`. Sweep Mongo nằm trong `recoverSuperAdmin` (cần `conn`).
- `RecoverResult` nhánh `recovered` thêm `sessions: 'not_requested' | { revoked: number } | 'failed'`.
- Dry-run với `--reset-mfa` in thêm `sessions: revoked in Redis after commit` (không kết nối).

**D95.5 Exit code.**

| Code | Nghĩa |
|---|---|
| `0` | recovered; nếu `--reset-mfa` thì Redis + sweep đã xong |
| `1` | từ chối / lỗi trước commit / tham số sai (như cũ) |
| `3` | **Mongo đã commit**, nhưng thu hồi phiên Redis hoặc sweep lỗi / quá 10 s |

Không dùng `2` (hay bị hiểu là sai cú pháp). Dòng in cố định: không email, không chi tiết lỗi Redis (có thể chứa URI).
- Thành công: `sessions revoked: <n>`.
- Lỗi: `warning: recovered, but sessions were NOT revoked (redis): see runbook-ops section 11` (hoặc `(sweep)`).

**D95.6 Audit.**
- `ADMIN_RECOVERED` ghi trong transaction, trước bước Redis, nên không chứa số phiên.
- Thêm một event sau bước Redis, cùng hình với API: `action: SESSION_REVOKED`, `actorType: 'system'`, `actorId: requestedBy`, `tenantId: default-tenant`, `targetType: 'user'`, `targetId`.
  - Thành công: `metadata: {scope: 'all', via: 'admin_recover', recoveredEventId, count}`.
  - Lỗi: `result: 'failure'`, `reason: 'revoke_failed'`, `metadata: {scope: 'all', via: 'admin_recover', recoveredEventId, failedStep: 'sessions' | 'sweep'}`.
- Ghi bằng `auditModel.create`, best-effort. Ghi lỗi ⇒ `warning: the session revoke audit event could not be written`, exit code không đổi.

**D95.7 Test.** Thay AC "SSO tới RP khác phải đăng nhập lại" bằng thứ đo được: `/authorize` đọc phiên qua `sessions.get`, nên `null` nghĩa là phải đăng nhập lại; không cần dựng full app.

Mở rộng `be/test/run87-admin-recover.int-spec.ts` (hoặc file mới `run95-admin-recover-sessions.int-spec.ts`), dùng Redis int (6479/db0, int vẫn dùng):
1. Tạo 2 phiên cho user qua `SessionService.create`, rồi recover `--reset-mfa` với `revokeSessions` thật. Kỳ vọng:
   - `sessions.get(id) === null` cho cả hai, `isEnded(ref) === true`;
   - `SMEMBERS user_sess:{id}` rỗng, key `dc:{u:…}` không còn;
   - audit `SESSION_REVOKED {via: 'admin_recover', count: 2}`, kết quả `sessions: {revoked: 2}`.
2. Phiên của **user khác** còn sống (không thu hồi lan).
3. `revokeSessions` dựng bằng đúng builder của `main`, trỏ `redis://127.0.0.1:1`. Kỳ vọng:
   - membership và `mfa` đã commit, `sessions: 'failed'`;
   - audit `SESSION_REVOKED` failure `revoke_failed {failedStep: 'sessions'}`;
   - dòng warning đúng chữ, hàm map exit code trả `3`;
   - xong < 12 s, Jest không báo open handle.
4. Recover không `--reset-mfa` ⇒ `revokeSessions` không được gọi, `sessions: 'not_requested'`, phiên của user còn sống.
5. Unit: parse không đổi; dry-run `--reset-mfa` in dòng `sessions:` và không kết nối.

**D95.8 runbook-ops.**
- §3d: bỏ câu "CLI không đụng Redis…". Thay bằng: recover thường không chạm Redis; `--reset-mfa` xem §11; thêm bảng exit code 0/1/3.
- §11 "Reset bằng CLI": thay đoạn "CLI **không** chạm Redis (DEBT-634)…" bằng:
  - CLI thu hồi mọi phiên + thiết bị tin cậy + sweep family sau commit, in `sessions revoked: <n>`, audit `SESSION_REVOKED {via: 'admin_recover'}`.
  - **Exit 3** ⇒ Mongo đã đổi, **không chạy lại CLI**. Sửa Redis theo §5. Sau đó:
    - (a) còn admin khác ⇒ gọi `POST /admin/users/{id}/sessions/revoke` ngay;
    - (b) không còn ⇒ user đăng nhập và enroll MFA ở `/account/mfa` trước mọi việc khác (enroll ⇒ thu hồi mọi phiên, D89.13).
    - Ghi ticket.
  - Trong lúc Redis chết, phiên cũ cũng không dùng được (login/SSO đọc Redis).

### T2: DEBT-683 + DEBT-689 (trần hàng đợi mail)

**D95.9 Trần: hằng `MAX_PENDING_MAIL = 200`.**
- Export từ `smtp.mailer.ts`. Không dùng env (YAGNI); đổi bằng một bản phát hành.
- Lý do chọn 200:
  - pool 5 kết nối, `socketTimeout` 10 s ⇒ khi SMTP treo, thư thứ 200 chờ tối đa ~200/5 × 10 s ≈ 400 s, nhỏ hơn TTL token reset (30') và verify (24 h);
  - SMTP bình thường (~0,1 s/thư) xả 200 thư trong vài giây;
  - bộ nhớ ~200 × vài KB.
- Throttle `/forgot` và `/register` vẫn là lớp chặn chính.

**D95.10 Đếm in-flight tự quản** trong `SmtpMailer`: `private pending = 0`.
- Thứ tự trong `send`:
  1. kiểm recipient (như cũ, không tính vào trần);
  2. `if (this.pending >= MAX_PENDING_MAIL)` ⇒ `observeMailDropped('queue_full')` rồi `throw new Error('mailer: queue full')` (không chạm transport);
  3. `pending++`, cập nhật gauge;
  4. `try { await sendMail } finally { pending--; cập nhật gauge }`.
- `pending` = thư đã nhận mà chưa settle (đang gửi ≤ 5 + đang chờ trong pool). Không đọc nội bộ nodemailer.
- `SmtpMailer` **không** gọi `observeBackgroundWriteFailure`.
  - Mọi caller đã `.catch`: verify/reset ở `issueToken` đếm `auth_mail`, thư thông báo chỉ log. Gọi thêm trong mailer sẽ đếm đôi.
  - Thư bị bỏ luôn được đếm ở counter riêng (D95.11).
- Không ném lỗi ra request: mọi `mailer.send` hiện là fire-and-forget (`authentication.service.ts:666,739`, `admin-users.controller.ts:367`, `mfa-login.service.ts:209`, `mfa.controller.ts:415`). Unit kiểm promise reject; int không đổi.

**D95.11 Metric.** Thêm vào `be/src/common/metrics/metrics.ts`, đúng mẫu `registry` module-level (không dùng provider):

| Tên | Kiểu | Label | Hàm |
|---|---|---|---|
| `sso_mail_queue_depth` | Gauge | không | `setMailQueueDepth(n)` |
| `sso_mail_dropped_total` | Counter | `reason` ∈ `MAIL_DROP_REASONS = ['queue_full', 'shutdown']` | `observeMailDropped(reason, n = 1)` |

- Help của gauge: "Mails accepted by the SMTP mailer and not yet sent or failed.".
- Counter khởi tạo 0 như các counter khác; `reason` lạ ⇒ bỏ qua.
- `ops/prometheus/alerts.yml` thêm `SsoMailDropped` (warning): `sum by (reason) (increase(sso_mail_dropped_total[15m])) > 0`, summary/description trỏ runbook-ops §13.
- `alerts.test.yml` thêm case. `ops-rules.spec.ts` tự kiểm tên metric.

**D95.12 Log** (logger `SmtpMailer`).
- Bỏ thư vì đầy: **không** log từng thư trong mailer. Caller đã log mỗi lỗi; tránh log flood. Counter là nguồn đếm.
- Shutdown: `onApplicationShutdown` đọc `n = this.pending` **trước** `transport.close()`. Nếu `n > 0` ⇒ `observeMailDropped('shutdown', n)` và `warn('mail queue closed with <n> unsent message(s)')`. Không ghi địa chỉ, không subject.
- runbook-ops §13: thêm dòng cho `sso_mail_dropped_total{reason}` / alert `SsoMailDropped`:
  - `queue_full` = SMTP chậm/chết hoặc spam ⇒ xử lý như `auth_mail`;
  - `shutdown` = thư mất khi deploy ⇒ người dùng dùng `/forgot`.

**D95.13 Helper `fakeSmtp` (DEBT-689)** trong `mailer.spec.ts`.
- Chữ ký: `fakeSmtp({ onRcpt?, onMessage? }) => Promise<{ port, sockets: Set<Socket>, close() }>`.
- Gom parser dòng/`DATA` của suite pool (L86) và suite envelope (L154).
- Suite timeout (server không chào) giữ nguyên, dùng lại cho test treo.

**D95.14 Test T2** (unit: `mailer.spec.ts`, spec metrics, `ops-rules.spec`).
1. Server không chào (suite timeout), gửi `MAX_PENDING_MAIL + 5` thư. Kỳ vọng:
   - đúng 5 promise reject `mailer: queue full` ngay, trước khi bất kỳ promise nào khác settle;
   - `sso_mail_dropped_total{reason="queue_full"}` +5, gauge = 200.
   - Sau đó `onApplicationShutdown()` ⇒ warn log có `200`, counter `shutdown` +200; mọi promise settle (≤ 15 s), gauge = 0.
2. Suite pool (20 thư) vẫn xanh; gauge về 0 sau khi xong.
3. Recipient sai ⇒ reject như cũ, không đổi gauge/counter.

Pentest `HYG-MAIL`/`HYG-SMTP-AFTER` không sửa, phải xanh ở lô D.

### T3: DEBT-570 (303 sau POST form)

**D95.15 Quy tắc: mọi redirect trả từ handler `@Post` của UI/consent/federation ⇒ 303; mọi handler `@Get` giữ 302.**
- Áp cho mọi redirect sau POST, không chỉ redirect "có credential". Lý do:
  - POST → 303 đúng ngữ nghĩa (RFC 9110 §15.4.4);
  - một quy tắc dễ kiểm hơn danh sách ngoại lệ.
- Đổi (file:line):
  - `ui.controller.ts`: 339, 343 (`POST /login`); 424 (`POST /account/password`, hết phiên); 503, 505, 602, 606 (`POST /logout`).
  - `mfa.controller.ts`:
    - 140, 153 (`POST /login/mfa`);
    - `backToLogin` (501) nhận thêm tham số `status`: gọi từ `POST /login/mfa` (112, 137) với 303, từ `GET /login/mfa` (104) với 302;
    - 178, 203, 251, 283 (`POST /account/mfa/{start,confirm,disable,recovery}`, hết phiên).
  - `account.controller.ts`: 97, 142, 192, 222, 273 (`POST /account/{sessions/revoke, sessions/revoke-others, devices/forget, devices/forget-others, apps/revoke}`, hết phiên). 327, 437 đã là 303.
  - `federation.controller.ts`: 243, 246 (`POST /auth/link`).
  - `authorize.controller.ts`:
    - `@HttpCode(302)` (125) ⇒ 303;
    - 137, 149–151, 154–156 (`POST /authorize/consent`);
    - `handleError` (255–257) nhận thêm `status`: `consent` truyền 303, `handle` (GET) giữ 302.
- Giữ 302 (GET, không đổi):
  - `ui.controller.ts` 149, 173, 230, 404;
  - `mfa.controller.ts` 104, 169;
  - `account.controller.ts` 83, 240;
  - `federation.controller.ts` 117, 166, 170, 173;
  - `authorize.controller.ts` 211, 249–251, 257 (khi gọi từ GET).
- `POST /reset/code` (382) đã là 303. `POST /register`, `/forgot`, `/verify-email`, `/reset` không redirect (render trang) ⇒ không đổi.

**D95.16 Test cần sửa.** Chỉ đổi status 302 ⇒ 303 cho response của POST. Assertion của GET mà đỏ ⇒ đó là bug, không sửa test.
- Harness:
  - `be/scripts/pentest/ctx.mjs:79` (`uiLogin` nhận ra bước MFA);
  - `checks.mjs:19` (`signedIn`): mọi caller là response POST `/login` hoặc `/login/mfa`; dev kiểm từng caller;
  - `checks.mjs:442`: chỉ `res.status` của login. `fakeHome`/`promoted` là GET `/`, giữ 302;
  - `checks.mjs:748` (`oldPasswordLogin`), `checks.mjs:785` (restart sau mã sai), `pentest.mjs:120` (`enroll`);
  - text `expected` ở 111/117, comment ctx 74/93.
  - Chấp nhận **đúng** 303, không `302 || 303` (không làm yếu check). `mutate.mjs` không chạm status ⇒ không đổi.
- E2E:
  - `e2e/tests/support/fe-admin.ts:43` (+ comment 31);
  - `e2e/tests/mfa.spec.ts` 171, 181, 193, 201, 209, 229, 270, 364 (+ comment 84);
  - giữ `mfa.spec.ts:105`, `account-self-service.spec.ts:181` (GET);
  - X3 (`e2e/x3/`) không assert status ⇒ không đổi.
- Int: các file ứng viên (POST `/login`, `/login/mfa`, `/logout`, `/authorize/consent`, `/auth/link`, `/account/*`):
  - `admin.int-spec.ts`, `admin-public-client`, `authorize.int-spec.ts`, `b73c-tester.int-spec.ts`, `b73c-tester.vault-spec.ts:249`, `federation.int-spec.ts`, `log-capture`, `oauth-tenant-isolation`;
  - `run55-tester`, `run56-tester`, `run73-host-cookie`, `run81-tester`, `run85-password-change`, `run85-tester`, `run86-tester`;
  - `run88-account-sessions`, `run89-account-mfa`, `run89-admin-mfa-gate`, `run89-mfa-cap`, `run89-mfa-login`, `run91-lotc`, `run92-codeql`, `run94-reset-ticket`;
  - `seed-risk-flow`, `seed.int-spec.ts`, `session-reflection`, `ui-auth`, `ui.int-spec.ts`.
  - Danh sách chính xác = các assertion đỏ ở int FULL sau khi đổi BE. Dev ghi vào log số assertion đã đổi theo từng file.
  - `full-app.ts:276` (GET `/authorize`) giữ.
- `b73c-tester.vault-spec.ts` cần container Vault ⇒ không chạy local ở run này (ràng buộc không tạo container). Sửa tĩnh; job vault của CI là gate.

**D95.17 Test mới.** Một int spec `run95-post-303.int-spec.ts`:
- với mỗi route POST ở D95.15, ít nhất một nhánh redirect ⇒ `303`, `Location` giữ như trước;
- kèm 3 đối chứng GET giữ `302`: `GET /authorize` không phiên, `GET /account/sessions` không phiên, `GET /login/mfa` không vé.

Không thêm check harness mới.

**D95.18 Tương thích.**
- Trình duyệt và client HTTP đều đổi 303 thành GET, như đã làm với 302 sau POST ⇒ RP không phải đổi gì. Redirect consent → `redirect_uri` giờ là 303.
- Thêm một dòng vào `docs/integration-rp-rs.md`: "Redirect về `redirect_uri` sau màn consent và về `post_logout_redirect_uri` sau `POST /logout` là `303`".
- Không cần runbook-deploy.

### Lô, gate, DEBT

**D95.19 Tiền điều kiện.**
- SMTP 220 đã xác nhận lúc fold (2026-11-18, tech-lead, `127.0.0.1:1025`).
- Mỗi lô cần thư phải kiểm lại. Không có 220 ⇒ dừng, báo orchestrator (người dùng restart, agent không restart).

**D95.20 Chia lô**

| Lô | Nội dung | Agent | Tự verify của dev |
|---|---|---|---|
| **A** | T1: `admin-recover.ts`, export `trustKey`, int D95.7, runbook-ops §3d/§11 | backend-dev | unit admin-recover + int `run87-admin-recover` (+ file mới) |
| **B** | T2: `smtp.mailer.ts`, `metrics.ts`, `mailer.spec.ts` (`fakeSmtp`), `alerts.yml`/`alerts.test.yml`, runbook-ops §13 | backend-dev | unit `mailer.spec`, spec metrics, `ops-rules.spec` |
| **C** | T3: 5 controller, int spec mới + sửa status int, E2E, harness, `docs/integration-rp-rs.md` | backend-dev | int FULL (chạm nhiều file); E2E để lô D |
| **D** | Gate | tester | thứ tự bên dưới |

- A và B không chung file code (chỉ khác mục trong runbook) ⇒ chạy song song được.
- C chạy **sau** A và B: int FULL của C là lần chạy sạch đầu tiên của cả run.
- Không cần frontend-dev (eta/UI không đổi). fe-admin không chạm ⇒ bỏ suite fe-admin.

Thứ tự gate ở lô D:
1. be unit
2. int FULL
3. kiểm SMTP 220 ⇒ E2E ×1
4. X3
5. `mutate.mjs all`
6. kiểm SMTP 220 ⇒ harness đầy đủ (timing on rồi off), **sau** E2E
7. kiểm SMTP 220 sau harness (`HYG-SMTP-AFTER`)

Vault suite chạy ở CI. Sau gate: senior review, orchestrator push, xác nhận CI (gồm `pentest` + mutation + vault).

**D95.21 DEBT**
- Mở **DEBT-691** (P3 💭 [BE/ops]): exit 3 của `admin-recover` không có đường "chỉ thu hồi phiên" trong CLI; hiện dựa vào API revoke hoặc việc user tự enroll MFA (D95.8). Thêm `--revoke-sessions-only` nếu ops cần trong thực tế.
- Đóng sau lô D: DEBT-634 (D95.1–D95.8), DEBT-683 (D95.9–D95.12), DEBT-689 (D95.13), DEBT-570 (D95.15–D95.18). T0 DEBT-579: orchestrator.
