# Run 91 `91-X6-golive-hardening` — điều kiện go-live + hardening sau pentest (M8, lane BE + ops)

Nguồn: `runs/90-X6-pentest-signoff/summary.md`, `release-checklist.md` mục F (điều kiện go-live (1)–(4) dòng Tech-lead), `pentest-report.md`, `backlog.md` (DEBT-651/662/663/665/666/667). Analyst bỏ qua. **Tech-lead đã fold 2026-11-16 (HEAD `c7c54c2`) — PASS, xem `review-techlead.md`.**

## Ràng buộc cứng (truyền nguyên cho mọi agent của run này)

- Không tải công cụ, không `npx` gói chưa cài. Không tạo container, không `compose up`; chỉ dùng `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1`. Không restart container (báo orchestrator).
- Redis: không `FLUSHALL`. Mongo: chỉ drop DB của mình (`vg-int-*`, `vg-pentest`). Không chạm `sso-idp` / `sso-idp-e2e` (ngoại lệ: E2E setup của chính bộ E2E).
- Không kill tiến trình không do mình khởi. Không in secret (token, mật khẩu, hash, secret TOTP, `otpauth`, client secret, URI có credential, header PEM nguyên vẹn) ra stdout/log/evidence/tài liệu.
- Không sửa `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/.env`, `be/keys`. Agent KHÔNG đọc `be/.env`, `be/keys`.
- Int test chạy jest trực tiếp, bọc `timeout`, một lượt int tại một thời điểm, không song song với pentest/E2E:
  `cd be && timeout 25m node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.int.config.js --runInBand --testTimeout=60000 --forceExit <file>` (không dùng `pnpm test:int -- -t`).
- Harness pentest `node be/scripts/pentest/pentest.mjs` làm kẹt SMTP Mailpit (DEBT-664) ⇒ chạy **sau** mọi bước cần thư (E2E); kiểm `220` trên 127.0.0.1:1025 trước E2E, kẹt ⇒ dừng và báo orchestrator.
- Scratch chỉ trong thư mục scratchpad riêng của từng agent. Đọc code qua CodeGraph MCP trước; terminal = Git Bash.

## Phạm vi và thứ tự lô (D91.1)

5 task, toàn bộ **[BE]** (kèm ops/docs + harness), không đụng fe-admin / fe-sso-test. Một backend-dev làm tuần tự; senior review sau mỗi lô; tester chạy gate cuối.

| Lô | Task | File chính | Lý do thứ tự |
|---|---|---|---|
| A | T1 (DEBT-667 a/b/c/e) → T2 (DEBT-666) → T3 (DEBT-665) | `authentication.service.ts` (+ spec), `common/metrics`, `ops/prometheus/*`, `runbook-ops.md` | cùng `detach()`: dọn hạ tầng tách rời trước, rồi đếm lỗi, rồi thêm việc tách rời mới (T3 dùng luôn counter) |
| B | T4 (DEBT-651) | `oauth/code`, `token.controller.ts`, `access-token-liveness.ts` | độc lập lô A; rủi ro cao nhất (token endpoint) ⇒ lô riêng, senior review riêng |
| C | T5 (DEBT-662/663 + DEBT-667 d) | `oauth/authorize`, `oauth/discovery`, `ui.controller.ts`, `common/http/request-id.ts` | nhỏ, độc lập |
| D | Gate + harness + checklist | — | sau A–C |

Mỗi lô: be typecheck + lint + unit + int **các file bị đụng** (một lượt int một lúc); int FULL chỉ ở lô D.

## Task

### T1 [BE/test] DEBT-667 (a)(b)(c)(e) — hạ tầng ghi tách rời (lô A)

- [x] backend-dev 2026-11-16: (a)(b)(c)(e) xong — xem `log.md`.

- (a) `authentication.service.spec.ts` `race()`: `clearTimeout` khi xong (hoặc `unref`). AC: chạy riêng file này với `--detectOpenHandles` không còn open handle/"worker failed to exit gracefully" từ file này.
- (b) `beforeApplicationShutdown`: chờ `drainBackgroundWrites()` tối đa **5 000 ms** (`Promise.race` với timer `unref`, `clearTimeout` khi xong); hết hạn ⇒ `logger.warn('shutdown: <n> background write(s) still pending')` (chỉ số lượng) rồi trả về (D91.11). AC unit (fake timers): việc treo vĩnh viễn ⇒ hook trả về sau ~5 s và log đúng `n`; việc xong trước ⇒ không log, không timer treo.
- (c) Đổi tên `AuthenticationService.settled()` ⇒ `drainBackgroundWrites()`, cập nhật mọi caller (int test); `int-hooks.settled` giữ tên. AC: `git grep -n "\.settled()" be/src be/test` không còn lời gọi tới phương thức của `AuthenticationService`.
- (e) Unit khoá `requestIdHeader:false`: request mang header `request-id: X` (không phải `x-request-id`) ⇒ `req.id` ≠ `X`, header phản hồi `x-request-id` ≠ `X`.

### T2 [BE/ops] DEBT-666 — đếm và alert lỗi ghi nền (lô A, điều kiện go-live (2))

- [x] backend-dev 2026-11-16: counter + 2 alert + promtool test + runbook-ops §13 + runbook-deploy §4 bước 7.

- Counter `sso_background_write_failures_total{what}` trong `common/metrics/metrics.ts` (tiền tố `sso_` như mọi metric hiện có, D91.2); `what` ∈ tập hữu hạn **{`register`, `forgot`, `resend_verify`, `auth_mail`}**; mọi series khởi tạo 0 (M4); giá trị ngoài tập ⇒ không tạo series, không throw (như `observeAuditEvent`).
- `detach(what, …)` nhận `what` kiểu union trên; nhánh `catch` tăng counter rồi mới log (lỗi của logger không được nuốt counter). Lỗi gửi thư trong `issueToken` (`mailer.send(...).catch`) tăng `auth_mail` (D91.3).
- `ops/prometheus/alerts.yml`: `SsoBackgroundWriteFailed` — `sum by (what) (increase(sso_background_write_failures_total{what=~"register|forgot|resend_verify"}[15m])) > 0`, `severity: critical`; `SsoAuthMailFailed` — cùng biểu thức với `what="auth_mail"`, `severity: warning`. Annotation trỏ `runbook-ops.md` §13. Thêm test vào `alerts.test.yml` (mỗi rule ≥ 1 ca bắn + 1 ca không bắn).
- `runbook-ops.md` §13 mới "Lỗi ghi nền đăng ký / quên mật khẩu / gửi thư (run 91, DEBT-666)": ý nghĩa từng `what`; tra log `background write failed` theo khoảng thời gian (log không có email ⇒ không tra được người cụ thể, nói rõ); thao tác: kiểm Mongo/SMTP (`/ready`, §5), sau phục hồi người dùng đăng ký lại (⇒ T3 gửi lại thư xác minh) hoặc `/forgot` lại. `runbook-deploy.md` (mục go-live): alert này phải được nạp vào Prometheus thật và có receiver trước khi mở đăng ký.
- **AC**:
  - unit `metrics.spec.ts`: 4 series bắt đầu 0; `what` lạ không tạo series.
  - unit `authentication.service.spec.ts`: `createWithPasswordHash` reject ⇒ `register` +1 đúng 1, các series khác không đổi; `issueToken` reject trong `/forgot` ⇒ `forgot` +1; mailer reject ⇒ `auth_mail` +1; mọi argument logger không chứa email đầu vào.
  - int: Mongo `create` lỗi giả (spy) ⇒ `POST /register` trả giống hệt nhánh thành công (status + body); sau `drainBackgroundWrites()`, `GET /metrics` (Bearer) có `sso_background_write_failures_total{what="register"} 1`; body `/metrics` không chứa email.
  - `ops-rules.spec.ts` xanh (tự kiểm metric/label của alert mới có trong registry).

### T3 [BE] DEBT-665 — đường phục hồi thư xác minh (lô A)

- [x] backend-dev 2026-11-16: (a)(b) + int + harness check mới; AC harness đo 1/3 lượt (Mailpit kẹt sau lượt 1, DEBT-664) — 2 lượt còn lại chờ orchestrator restart Mailpit.
- [x] backend-dev retry 1 (2026-11-16): (a) sửa — token **đặt lại** + thư "Finish creating your account", `isUnverifiedWithPassword` (`exists`, không đọc hash), ≤ 1 thư/30'; (c) DEBT-671 — `/verify-email` đòi mật khẩu (giữ chỗ lượt thử trước Argon2, ≤ 5/token, lượt sai thứ 5 đốt token); int D91.13 + 2 mutation RED; E2E 4 spec cập nhật (typecheck xanh, chưa chạy); harness `AUTHN-PREHIJACK-VERIFY` thêm (chưa chạy, Mailpit); runbook-ops §13 bước 3 theo `what`, runbook-deploy §4 bước 8. Chờ: harness ×3 + E2E sau khi restart Mailpit.

> **Retry 1 (tech-lead 2026-11-16, sau senior REJECT lô A — `review-senior.md` 🔴 pre-hijacking):** thiết kế (a) cũ — gửi lại **thư xác minh** cho tài khoản chưa xác minh — kích hoạt mật khẩu do người tạo tài khoản chọn, có thể là kẻ tấn công. Nạn nhân tự đăng ký (mật khẩu B bị bỏ qua), bấm thư mình đang chờ ⇒ tài khoản mang mật khẩu A của kẻ tấn công được xác minh. Thay bằng (a) mới + (c) dưới đây (D91.4 sửa, D91.13, D91.14). Invariant của T3: **xác minh hộp thư không bao giờ kích hoạt một mật khẩu mà người giữ hộp thư không chứng minh được là biết.**

- (a) **Sửa (D91.4)**: nhánh "đã tồn tại" của `register`: sau `hashPassword` (giữ thứ tự, **không** thêm `await` trên đường phản hồi), user chưa xác minh (`emailVerifiedAt` null) và có mật khẩu ⇒ `detach('resend_verify', …)` phát **token đặt lại** (`issueToken(this.resetTokens, …, '/reset', RESET_TTL_MS, …)`), **không** phát token xác minh. Thư dùng template mới "hoàn tất đăng ký": báo có người (có thể là bạn) vừa đăng ký bằng email này; bấm để **đặt mật khẩu**; nếu không phải bạn, bỏ qua. Không nhắc mật khẩu cũ. Hoàn tất `/reset` ⇒ `setPassword` (`$ifNull` đặt `emailVerifiedAt`, D91.5) + `revokeAllUserCredentials` ⇒ mật khẩu A mất hiệu lực, phiên cũ bị thu hồi.
  - Chống spam: còn token **đặt lại** sống (`usedAt: null`, `expiresAt > now`, TTL 30') ⇒ không phát ⇒ ≤ 1 thư/30'/tài khoản qua đường này. Mức này bằng mức `/forgot` đang cho phép, nên không mở thêm bề mặt. Throttle `ui.limit('register')` giữ nguyên. Đua 2 request ⇒ ≤ 2 thư: chấp nhận, ghi comment.
  - User đã xác minh / user chỉ federation ⇒ không làm gì (như cũ). Kiểm "có mật khẩu" bằng projection/`exists`, không kéo `passwordHash` (nit senior).
  - Nhãn metric giữ `resend_verify` (D91.2 không đổi tập nhãn; ý nghĩa: "phục hồi đăng ký chưa xác minh").
- (b) `resetPassword` thành công đặt `emailVerifiedAt` nếu đang null, **giữ ngày cũ** nếu đã có (`$ifNull` trong cùng update nguyên tử — đã làm ở lô A, senior đồng ý; không có nhánh lỗi riêng để log).
- (c) **Mới — DEBT-671 (D91.14)**: xác minh email phải chứng minh biết mật khẩu. `POST /verify-email` nhận thêm `password`. Thứ tự xử lý:
  1. Đọc token (sống, chưa dùng) **không tiêu thụ** ⇒ lấy user.
  2. `passwordMatches` (Argon2).
  3. Chỉ khi đúng mới tiêu thụ token nguyên tử (`findOneAndUpdate` như `consume`) rồi `users.verifyEmail`.
  
  Sai mật khẩu, token sai/hết hạn hoặc user không có mật khẩu ⇒ cùng **một** thông báo chung 400 ("link không hợp lệ/hết hạn hoặc mật khẩu sai"); token **không** bị đốt. `verify.eta` thêm ô mật khẩu (`autocomplete="current-password"`) và dòng "Không phải bạn tạo tài khoản này, hoặc quên mật khẩu? ⇒ `/forgot`". Route giữ throttle `ui.limit` hiện có, thêm limiter theo token (≤ 5 lần sai/token, rồi đốt token) để không thành oracle đoán mật khẩu. Không ghi mật khẩu/token vào log/audit. Hậu quả với nạn nhân: không xác minh được tài khoản kẻ tấn công tạo ⇒ đi `/forgot` (hoặc (a)) ⇒ đặt mật khẩu của mình.
  - Tương thích: thư xác minh gửi trước deploy vẫn dùng được, chỉ phải nhập mật khẩu. Ghi vào summary và `runbook-deploy`.
  - E2E: cập nhật các spec điền form `/verify-email` (`e2e/tests/account-self-service.spec.ts`, `mfa.spec.ts`, `password-change.spec.ts`, `token-fragment.spec.ts` — rà bằng `git grep verify-email e2e`) để nhập mật khẩu. Đây là test code, không đổi hành vi E2E khác.
- **AC int (khoá invariant — bắt buộc)**:
  - **Pre-hijack qua đường phục hồi (a)**: kẻ tấn công `POST /register` (email V, mật khẩu A) ⇒ token xác minh đầu hết hạn ⇒ nạn nhân `POST /register` (email V, mật khẩu B) ⇒ phản hồi giống nhánh mới; sau drain: 0 token xác minh mới, đúng 1 token **đặt lại** + 1 thư (template hoàn tất đăng ký). Nạn nhân dùng token đó đặt mật khẩu C ⇒ `emailVerifiedAt` ≠ null; `POST /login` với **A ⇒ thất bại** (thông báo chung), với **B ⇒ thất bại**, với **C ⇒ thành công**; mọi phiên/refresh family tạo trước đó bị thu hồi.
  - **Pre-hijack qua thư đầu (c)**: kẻ tấn công đăng ký (V, A) ⇒ nạn nhân mở link xác minh đầu, nhập mật khẩu khác A ⇒ 400 chung, `emailVerifiedAt` vẫn null, token **chưa** bị đốt; `POST /login` với A ⇒ thất bại (chưa xác minh). Nhập sai 5 lần ⇒ token bị đốt (lần 6 với A cũng 400).
  - Người dùng hợp lệ: đăng ký (V, B) ⇒ xác minh với B ⇒ 200, `emailVerifiedAt` ≠ null, login B thành công.
  - Còn token đặt lại sống ⇒ `register` lặp ⇒ 0 token mới, 0 thư. User đã xác minh ⇒ 0 token, 0 thư. User chỉ federation ⇒ 0.
  - `/forgot` → `/reset` trên user chưa xác minh ⇒ `emailVerifiedAt` ≠ null; trên user đã xác minh ⇒ `emailVerifiedAt` giữ ngày cũ.
  - Lỗi giả ở `issueToken` trong nhánh (a) ⇒ `resend_verify` +1, phản hồi không đổi.
  - Log/audit của mọi ca trên không chứa email, mật khẩu, token.
- **AC harness**: `AUTHN-ENUM-TIME-register-unverified` (must) giữ nguyên ý nghĩa (việc tách rời) ⇒ xanh; `AUTHN-ENUM-TIME-register` xanh. Thêm `AUTHN-PREHIJACK-VERIFY` (must): xác minh bằng token hợp lệ nhưng sai mật khẩu ⇒ 400, tài khoản chưa xác minh.
- **`runbook-ops.md` §13 bước 3 (viết lại, nit 🟡 senior)**: theo `what`:
  - `register` ⇒ người dùng đăng ký lại. Nếu tài khoản chưa được tạo thì thành đăng ký mới; nếu đã tạo mà chưa xác minh ⇒ nhận thư "hoàn tất đăng ký", đặt mật khẩu qua link.
  - `forgot` ⇒ `/forgot` lại.
  - `resend_verify` ⇒ đăng ký lại sau 30' hoặc dùng `/forgot`.
  - `auth_mail` ⇒ token đã ghi nhưng thư không tới; đăng ký lại **không** gửi thư mới trong 24 h (token xác minh còn sống) ⇒ hướng dẫn dùng **`/forgot`** (đặt lại mật khẩu cũng xác minh email, D91.5), hoặc chờ token hết hạn.
  
  Không có thao tác DB nào.

### T4 [BE] DEBT-651 — code dùng lại ⇒ thu hồi token đã phát (lô B, RFC 6749 §4.1.2, D91.6–D91.9)

- [x] backend-dev 2026-11-16: bước 1–4 xong (Lua consume ghi dấu, `markIssued`/`markReplayed`, denylist `at_revoked:<jti>` trong `isAccessTokenLive`, fail-closed); int `code-replay.int-spec.ts` 9/9 + mutation m1–m4 RED; harness `OAUTH-CODE-REPLAY-REVOKE` (must) + `OAUTH-CODE-REPLAY-XCLIENT` thêm, chưa chạy (Mailpit). Kèm DEBT-672 (lô A) đóng.

Thiết kế bắt buộc; hợp đồng lỗi `invalid_grant` hiện có không đổi; giữ sign-trước-consume (DEBT-388) và `peek` như cũ.

1. **Dấu đã dùng, nguyên tử với consume**: Lua `consumeAuthCode`, khi binding khớp và `DEL`, đồng thời `HSET` dấu `clientId=<clientId>` + `PEXPIRE` `max(60 s, ACCESS_TOKEN_TTL)`. Hai key dùng chung hash-tag (`authz_code:{<sha256>}` / `authz_code_used:{<sha256>}`) để giữ Cluster-safe; đổi định dạng key ⇒ code đang bay lúc deploy (≤ 60 s) hỏng, người dùng đăng nhập lại — ghi vào summary/runbook-deploy như các run trước. Không lưu code thô.
2. **Sau khi phát**: khi `issueForAuthorizationCode` trả về, `HSET` `familyId` (nếu có), `jti` và `atExp` của AT vào dấu, rồi đọc `replayed`; `replayed=1` ⇒ `refuseGrant(..., 'code_replayed')` (revoke family vừa phát + denylist AT, `invalid_grant`). Đặt **trước** `recordIssued` success. Lỗi Redis ở bước này ⇒ `failClosed` (revoke family best-effort, 500) như `session_check_failed`.
3. **Lần đổi lặp** (consume trả null): dấu tồn tại **và** `clientId` của dấu = client **đã xác thực** của request ⇒ `HSET replayed 1`; có `familyId` ⇒ `refresh.revokeFamily(familyId, clientId, now, { reuse: true, audit })` (ghi `TOKEN_REUSE_DETECTED`, metadata thêm `kind:'authorization_code'`, không chứa code/jti ⇒ alert `SsoTokenReuseDetected` sẵn có bắn); có `jti` ⇒ denylist AT. Phản hồi vẫn **400 `invalid_grant`**. Dấu thuộc client khác ⇒ **không** revoke, không đánh dấu, `invalid_grant` (D91.7). Không đòi khớp `redirect_uri`/`code_verifier` ở lần lặp. Lỗi Redis/Mongo khi revoke ⇒ 500 `server_error` (fail-closed; cờ `replayed` còn nên bước 2 vẫn bắt nếu phát song song).
4. **Denylist AT**: `at_revoked:{jti}` PX = `atExp − now` (bỏ qua nếu ≤ 0). `isAccessTokenLive` kiểm key khi claim `jti` có mặt (sau kiểm `sid`, trước lookup Mongo) ⇒ áp cho `/introspect`, `/userinfo`, `AdminTokenGuard`, `/demo/me` (cùng một hàm). Lỗi Redis ⇒ ném (fail-closed như hiện tại). Giới hạn chấp nhận ⇒ DEBT-669.

- **AC int** (`token.int-spec.ts` hoặc file mới `code-replay.int-spec.ts`):
  - đổi lần 1 ⇒ 200 (AT1, RT1); lần 2 cùng client ⇒ 400 `invalid_grant`; sau đó refresh RT1 ⇒ 400 `invalid_grant`; introspect AT1 ⇒ `active:false`; `/userinfo` với AT1 ⇒ 401; đúng 1 audit `TOKEN_REUSE_DETECTED` `kind:'authorization_code'`; audit/log không chứa code, RT, AT.
  - lần 2 bởi **client khác đã xác thực** ⇒ 400 `invalid_grant`; RT1 refresh 200; AT1 `active:true`; 0 audit reuse.
  - lần 2 cùng client nhưng `code_verifier`/`redirect_uri` sai ⇒ vẫn thu hồi như ca 1.
  - code không `offline_access` (không family) ⇒ lần 2 ⇒ AT1 `active:false`.
  - đua: lần lặp chen giữa consume và ghi `familyId` (spy trì hoãn `issueForAuthorizationCode`) ⇒ lần 1 trả `invalid_grant` (không token), family của lần 1 bị revoke.
  - Redis lỗi khi ghi dấu sau phát ⇒ 500, family vừa phát bị revoke, không token trả về.
  - code không tồn tại / dấu đã hết TTL ⇒ `invalid_grant`, không revoke gì.
  - unit `access-token-liveness.spec.ts`: `jti` trong denylist ⇒ false; không `jti` ⇒ không truy vấn denylist.
- **AC harness**: `SHOULD-CODE-REPLAY-REVOKE` ⇒ đổi ID `OAUTH-CODE-REPLAY-REVOKE`, tier **must** (D91.9) ⇒ xanh; thêm `OAUTH-CODE-REPLAY-XCLIENT` (must): lần lặp bởi client khác không thu hồi token của client gốc.

### T5 [BE] DEBT-662 + DEBT-663 + DEBT-667 (d) — P2 nhỏ (lô C)

- [x] backend-dev 2026-11-16: `response_mode` + discovery; `no-store` qua `UiSessionHelper.liveSession`/`identity` (+ `/login/mfa`); `requestIdFrom` + `trustedProxies` (`BlockList`), `full-app` truyền `TRUST_PROXY` như `main.ts`; int `run91-lotc.int-spec.ts`; harness `OAUTH-RESPMODE-form_post/-fragment`, `DISCO-RESPMODES`, `SESS-HDR-*` no-store (chưa chạy). Kèm ponytail lô B: bỏ `@Optional` `ConfigService` (3 chỗ test truyền stub); signer trả `jti`/`exp` **không làm** (đụng `TokenSigner.sign` + golden/vault spec). Hướng dẫn RP "đổi code đúng một lần" ở runbook-deploy §4 bước 9.

- **`response_mode` (DEBT-662)**: `/authorize` chỉ nhận `response_mode` vắng hoặc đúng `query`. Giá trị khác (`form_post`, `fragment`, `query.jwt`, rỗng, lặp tham số) ⇒ khi `client_id` + `redirect_uri` đã hợp lệ: 302 về redirect URI đã đăng ký, `error=invalid_request`, `error_description` cố định (không phản chiếu giá trị), kèm `state` + `iss` như các lỗi redirect khác; trước khi `redirect_uri` hợp lệ ⇒ trang lỗi 400 như hiện có, không `Location`. Không tạo code/context. Discovery thêm `response_modes_supported: ["query"]`.
  - AC int: 4 giá trị sai ⇒ 302 `error=invalid_request`, `Location` không có `code=`; `response_mode=query` ⇒ code bình thường; client/redirect sai + `form_post` ⇒ 400 không `Location`; discovery có đúng `["query"]`.
  - Harness: thêm `OAUTH-RESPMODE-form_post`, `OAUTH-RESPMODE-fragment`, `DISCO-RESPMODES` (must).
- **`Cache-Control` (DEBT-663)**: `GET /` (cả nhánh có phiên lẫn 302 về `/login`) đặt `no-store`. Rà mọi route HTML `GET` của UI/account/MFA/federation: trang phụ thuộc phiên hoặc có CSRF token mà chưa `no-store` ⇒ thêm, ưu tiên ở helper chung (`form()` / `hasLiveSession`) thay vì rải từng route (D91.12).
  - AC int: `GET /` có phiên ⇒ 200 + `no-store`; không phiên ⇒ 302 + `no-store`.
  - Harness: `SESS-HDR-*` đòi `no-store` cho mọi route HTML IdP phụ thuộc phiên/CSRF; route ngoại lệ (tĩnh: `/jwks.json`, discovery, `/health`, `/ready`) liệt kê tường minh trong harness.
- **`x-request-id` (DEBT-667 d, D91.10)**: `requestIdFrom` chỉ nhận `x-request-id` của client khi `TRUST_PROXY` được đặt **và** `req.socket.remoteAddress` thuộc danh sách đó (CIDR bằng `node:net` `BlockList`, không thêm dependency); khác ⇒ luôn sinh id mới. `runbook-deploy.md`: reverse proxy phải ghi đè header (vd. `proxy_set_header X-Request-ID $request_id`), không chuyển tiếp nguyên header của client.
  - AC unit `request-id.spec.ts`: không `TRUST_PROXY` + header hợp lệ ⇒ id mới; `TRUST_PROXY=10.0.0.0/8` + socket `10.1.2.3` ⇒ giữ header; socket `203.0.113.5` ⇒ id mới; `::ffff:10.1.2.3` ⇒ giữ; header không hợp lệ từ proxy tin cậy ⇒ id mới (như D90.10).
  - AC int: audit `requestId` = header `x-request-id` phản hồi ở cả hai trường hợp.

### Lô D — gate (tester)

- be typecheck + lint + unit FULL; int FULL một lượt (`vg-int-*` 0→0); E2E ×2 (kiểm SMTP 220 trên 127.0.0.1:1025 trước); X3 42. fe-admin **không** chạy (không đụng) — ghi lý do.
- Alert: không có `promtool` ⇒ `ops-rules.spec.ts` là cổng (như B7.2).
- Harness pentest lượt cuối **sau** E2E: toàn bộ must (254 cũ + `OAUTH-CODE-REPLAY-REVOKE` + các check mới của T3/T4/T5) xanh, exit 0; evidence `pentest-<ts>` ghi HEAD.
- `release-checklist.md`: đoạn "Run 91" đầu file; điều kiện go-live (2) ⇒ ✅ phía repo (phần nạp alert vào Prometheus thật thuộc người vận hành, gộp vào smoke go-live (1)); cập nhật dòng C-* của DEBT-651/662/663/665; mục F **không** sửa chữ ký đã có, chỉ thêm ghi chú "Run 91".

## Quyết định D91.x (tech-lead 2026-11-16, tiêu chí "dùng được ở production", người dùng ủy quyền)

- **D91.1** Phạm vi 5 task, chỉ BE; thứ tự A (T1→T2→T3, cùng `detach`) → B (T4) → C (T5) → D gate. Không có task FE.
- **D91.2** Metric theo quy ước có sẵn `sso_*`: `sso_background_write_failures_total{what}`, nhãn hữu hạn, khởi tạo 0 (không dùng `idp_` như nháp).
- **D91.3** Đếm cả lỗi gửi thư (`auth_mail`) — thư không tới cũng "im lặng" như lỗi ghi DB; alert `warning` tách khỏi `critical` của ghi DB.
- **D91.4** ~~Gửi lại thư xác minh qua nhánh "đã tồn tại" của `/register`~~ — **sửa ở retry 1**: nhánh "đã tồn tại" + chưa xác minh + có mật khẩu phát **token đặt lại** (thư "hoàn tất đăng ký"), tách rời, chỉ khi không còn token đặt lại sống (≤ 1 thư/30'/tài khoản, bằng mức `/forgot`). Lý do: gửi lại thư xác minh để nạn nhân tự kích hoạt mật khẩu của kẻ tấn công (pre-hijacking, senior 🔴). Đặt lại buộc chủ hộp thư tự chọn mật khẩu và thu hồi credential cũ. Phương án "ghi hash(B) rồi gửi thư xác minh" bị loại vì kẻ tấn công đăng ký lại ghi đè A. Không thêm route `/resend`.
- **D91.5** Reset mật khẩu thành công đặt `emailVerifiedAt` nếu null, giữ ngày cũ nếu có (`$ifNull`).
- **D91.13** Invariant T3, khoá bằng int: xác minh hộp thư không bao giờ kích hoạt mật khẩu mà người giữ hộp thư không chứng minh được là biết. Sau luồng phục hồi, mật khẩu do bên thứ ba đặt **không** đăng nhập được.
- **D91.14** DEBT-671 xử lý **trong run 91** (lô A retry): `/verify-email` đòi mật khẩu; kiểm trước khi tiêu thụ token; ≤ 5 lần sai/token rồi đốt token. Lý do theo tiêu chí production:
  - Tài khoản IdP là SSO cho mọi RP ⇒ chiếm được là mất tất cả.
  - Run này đang sửa đúng luồng đó.
  - Bản sửa nhỏ: một ô form + kiểm Argon2, không thêm route.
  
  Phương án loại: chỉ cảnh báo trên trang (không chặn được); "xác minh xong buộc đặt lại mật khẩu" (người dùng hợp lệ phải đặt mật khẩu hai lần).
- **D91.6** Dấu `authz_code_used` ghi nguyên tử trong Lua consume, TTL `max(60 s, ACCESS_TOKEN_TTL)`, hash-tag chung với key code; cờ `replayed` được đọc lại sau khi phát để đóng cửa sổ đua.
- **D91.7** Chỉ thu hồi khi client đã xác thực của lần lặp = client của code (chống confused deputy); không đòi khớp verifier/redirect ở lần lặp.
- **D91.8** AT thu hồi bằng denylist `at_revoked:{jti}` trong `isAccessTokenLive` (một chỗ cho introspect/userinfo/admin/demo). ID token và RS tự verify JWT cục bộ không thu hồi được ⇒ DEBT-669.
- **D91.9** Harness: `SHOULD-CODE-REPLAY-REVOKE` ⇒ `OAUTH-CODE-REPLAY-REVOKE`, tier must.
- **D91.10** `x-request-id` của client chỉ nhận từ địa chỉ thuộc `TRUST_PROXY` (CIDR qua `node:net` `BlockList`); proxy phải ghi đè header.
- **D91.11** Shutdown chờ việc tách rời tối đa 5 s, sau đó log số việc còn dở và trả về (grace period mặc định 30 s của orchestrator còn dư).
- **D91.12** `no-store` cho mọi trang HTML phụ thuộc phiên/CSRF qua helper chung; harness kiểm toàn bộ route HTML.
