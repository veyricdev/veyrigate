# Run 94 `94-debt-sweep` — nợ còn mở làm được trong repo (M8, lane BE/UI/QA/ops)

**Nguồn:** orchestrator, sau run 93 (CI #50 xanh 9/9, CodeQL 0 mở).

**Ngoài phạm vi run này:**
- DEBT-673 (untrack `.agents/`) và DEBT-675 (ngoại lệ container cho smoke cục bộ): chờ người dùng quyết.
- Go-live (1) và DEBT-670: cần môi trường thật.

## Ràng buộc cứng (truyền nguyên cho mọi agent)

**Hạ tầng**
- KHÔNG `compose up`.
- KHÔNG tạo / restart container. Ngoại lệ duy nhất là Vault thử theo quy ước đã có.
- Chỉ dùng `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1`, tách bằng tên DB hoặc db index riêng.
- KHÔNG FLUSHALL / drop DB không phải của mình.
- KHÔNG đụng `sso-idp` / `sso-idp-e2e`, ngoài phần setup của E2E.

**File cấm**
- KHÔNG đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.
- KHÔNG đọc, KHÔNG đụng `be/.env` và `be/keys`.

**Secret**
- KHÔNG in secret hoặc literal PEM header trong docs/log.
- Giá trị giống secret trên dòng mới phải dựng lúc chạy (D92.8).

**Process / gói**
- KHÔNG Stop-Process / taskkill process không phải mình tạo.
- KHÔNG download, KHÔNG npx gói chưa cài.

**Git**
- KHÔNG commit / push (orchestrator làm).
- KHÔNG rewrite lịch sử git.

**Chạy test**
- Scratch chỉ trong scratchpad riêng của agent.
- Không chạy E2E song song với int.
- Harness pentest đầy đủ làm kẹt SMTP Mailpit local (DEBT-664) ⇒ chỉ chạy SAU E2E.
- Kiểm 220 trước mọi việc cần thư:
  ```bash
  timeout 6 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1025; head -c 30 <&3'
  ```
- SMTP không trả 220 ⇒ dừng và báo, KHÔNG restart container.

## Task

### T1 [BE/UI] DEBT-661 (P2)
**Vấn đề:** token `/reset#token=…` và `/verify-email` nằm lại trong History DB của trình duyệt. Người có quyền vào profile trình duyệt có thể dùng token trong TTL 30'.

**Hướng xử lý**
1. Khi trang tải, JS POST token (CSRF như hiện có) lên server.
2. Server tiêu thụ token và đổi lấy "vé" ngắn hạn, gắn với phiên/cookie anon và một lần dùng.
3. URL trong lịch sử trình duyệt hết hiệu lực.

**Yêu cầu giữ nguyên**
- Luồng JS-off (đã có ở run 86, D86.x) vẫn chạy được.
- Giữ các invariant hiện có:
  - D91.14: `/verify-email` đòi mật khẩu, ≤ 5 lần/token;
  - không lộ token qua Referer / request;
  - không dò được email.

**Tech-lead chốt:** thiết kế vé (Redis, TTL, gắn cookie nào), xử lý JS-off, có làm cả `/verify-email` không.

**Phải có**
- int test
- E2E cập nhật (`token-fragment.spec.ts`)
- check harness tương ứng nếu phù hợp

### T2 [QA/pentest] DEBT-664
**Chẩn đoán đã có (orchestrator 2026-11-16, backlog):**
- Listener SMTP của Mailpit ngừng accept sau khoảng 440 thư mỗi lượt AUTHN (Recv-Q 845).
- HTTP :8025 vẫn sống.

**Việc cần làm**
1. Tìm nguyên nhân phía client: nodemailer pool / kết nối không đóng / gửi song song quá nhiều. Đọc code mailer BE: transport có `pool` không, có đóng connection không. So với cấu hình Mailpit (giới hạn kết nối?).
2. Sửa ở BE nếu đó là lỗi thật có thể xảy ra ở production, ví dụ rò kết nối SMTP. Nếu chỉ do tải test, sửa ở harness: giảm số thư, hoặc dùng sink.
3. Harness: thêm check `HYG-MAIL`, đòi ≥ 1 thư `@pentest.invalid` tới Mailpit, đỏ nếu 0. Harness cũng kiểm 220 trước khi chạy.

**Mục tiêu:** sau lượt harness đầy đủ, SMTP vẫn trả 220.

### T3 [docs] DEBT-669
Viết hướng dẫn RP/RS trong tài liệu tích hợp (tech-lead chọn file):
- Thao tác nhạy cảm dùng `/introspect`, vì RS verify JWT cục bộ không thấy denylist `at_revoked`.
- `ACCESS_TOKEN_TTL` giữ ngắn (900 s).
- ID token không thu hồi được.

### T4 [ops/CI] DEBT-682
Thêm job/step CI chạy `node be/scripts/pentest/mutate.mjs all` khi push/PR đổi `be/scripts/pentest/**` hoặc `be/scripts/drills/lib.mjs`:
- dùng paths filter (`dorny/paths-filter` chưa có ⇒ cân nhắc `git diff --name-only` với base, KHÔNG thêm action mới nếu tránh được);
- mỗi mutant phải đỏ đúng check kỳ vọng;
- có timeout.

## Thứ tự lô (đề xuất, tech-lead chốt)
1. **A:** T1.
2. **B:** T2 + T4. Cùng vùng harness; chạy sau A nếu A thêm check harness.
3. **C:** T3 (docs, song song).
4. **D:** gate tester — be unit, int FULL, fe-admin nếu chạm, E2E ×1, X3 nếu chạm UI, rồi harness đầy đủ SAU E2E.
5. Orchestrator push và xác nhận CI.

## Quyết định D94.x (tech-lead fold, 2026-11-17)

Tiêu chí: dùng được ở production (người dùng ủy quyền). Các D94.x thay hướng xử lý đề xuất ở T1 ("khi trang tải, JS POST"). Khi D94.x và mô tả task mâu thuẫn, làm theo D94.x.

### T1: DEBT-661

**D94.1 Phạm vi: chỉ `/reset`. `/verify-email` giữ nguyên, chấp nhận có ghi chú.**
- Theo D91.14, token xác minh một mình vô dụng: còn cần mật khẩu của tài khoản và tối đa 5 lần thử.
- Kịch bản còn lại là pre-hijacker (biết mật khẩu do chính mình đặt) đọc được History của nạn nhân. Kịch bản này đòi truy cập cục bộ vào trình duyệt nạn nhân. Khi đó D91.13 vẫn giữ: nạn nhân không kích hoạt mật khẩu lạ.
- Không đổi template, route, script của `/verify-email`.
- DEBT-661 đóng sau run này với ghi chú cho verify.

**D94.2 Không đổi token khi trang tải.** Chỉ đổi khi người dùng bấm (submit form).
- Lý do: trình quét link trong mail có chạy JS (sandbox detonation) sẽ tiêu thụ token trước người dùng thật. Link đặt lại khi đó chết với cả nhóm người dùng đứng sau bộ quét. Đây là lỗi production.
- Mọi cách "claim lúc tải" đều không phân biệt được bộ quét với người dùng.
- `token-fragment.js` **không** tự submit.

**D94.3 Luồng và route**

Mail và link giữ nguyên `/reset#token=<43>`.

1. **`GET /reset`**:
   - Có cookie vé hợp lệ (đúng dạng `/^[A-Za-z0-9_-]{43}$/`, document có `ticketHash` = sha256(vé), `usedAt: null`, `expiresAt > now`) ⇒ render **form mật khẩu**. Form có `_csrf` + `password`, **không có** field `token`.
   - Ngược lại ⇒ render **form mã**, action `/reset/code`:
     - field mã đúng D86.1 (`id="token"`, `id="token-manual"`, cùng các thuộc tính);
     - nút `Continue`;
     - `<script src="/assets/token-fragment.js">` cuối form.

     Vé không hợp lệ ⇒ xoá cookie.
   - `Cache-Control: no-store` như hiện tại (helper `form`).
2. **`POST /reset/code`**, body `{_csrf, token}` (`TokenDto`):
   - Guard và limiter: `CsrfGuard`, rồi `ui.limit('reset', req, token)` (limiter chuyển từ `POST /reset` sang đây).
   - Đổi token: một lệnh `findOneAndUpdate({tokenHash: sha256(token), usedAt: null, ticketHash: null, expiresAt: {$gt: now}}, {$set: {ticketHash: sha256(ticket), expiresAt: now + 15'}})`, với `ticket = generateToken()`.
   - Thành công ⇒ set cookie vé và `303 Location: /reset` (đường dẫn tương đối cùng origin, không fragment).
   - Thất bại ⇒ `400` với đúng thông điệp hiện có `This link is invalid or expired.`.
3. **`POST /reset`**, body `{_csrf, password}` (`ResetDto` bỏ `token`; `forbidNonWhitelisted` ⇒ body hình cũ có `token` bị 400 trước handler, token **không** bị chạm):
   - Bước 1: `CsrfGuard`, rồi `ui.limit('reset', req, sha256(vé))`.
   - Bước 2: kiểm cookie vé đúng dạng, thiếu ⇒ 400 cùng thông điệp.
   - Bước 3: `assertAcceptablePassword`, rồi `hashPassword`. Mật khẩu bị từ chối ⇒ vé còn nguyên.
   - Bước 4: tiêu thụ nguyên tử `findOneAndUpdate({ticketHash, usedAt: null, expiresAt > now}, {$set: {usedAt: now}})`.
   - Bước 5: chuỗi hiện có giữ nguyên: `setPassword` → `revokeAllUserCredentials` → audit → mail đổi mật khẩu → xoá bucket login.
   - Thành công hoặc vé không hợp lệ ⇒ xoá cookie.

Mọi trường hợp token/vé sai cho **cùng status và thân lỗi**: không tồn tại, hết hạn, đã dùng, đã đổi, sai dạng. Không log token hay vé. Không thêm audit action.

**D94.4 Store: Mongo, cùng document `PasswordResetToken`, không dùng Redis.**
- Thêm field `ticketHash: {type: String, default: null}`.
- Index unique partial `{ticketHash: 1}` với `partialFilterExpression: {ticketHash: {$type: 'string'}}`. Chỉ schema reset.
- Lý do chọn Mongo:
  - một store, mẫu nguyên tử sẵn có;
  - TTL index sẵn dọn vé;
  - không thêm failure mode Redis.
- Mỗi token đổi được tối đa một vé (filter `ticketHash: null`).

**D94.5 Cookie vé**
- Tên: `hostCookieName('idp_reset', secure)` ⇒ `__Host-idp_reset` khi Secure.
- Giá trị: `generateToken()`.
- Thuộc tính: `httpOnly`, `secure` theo `SessionCookie.secure`, `sameSite: 'lax'`, `path: '/'`, `maxAge: 900`.
- Lax để người dùng mở lại link từ webmail trong cùng trình duyệt thì thấy thẳng form mật khẩu. POST cross-site đã bị CSRF chặn.
- Không gắn với cookie CSRF ẩn danh: vé tự nó là bearer httpOnly, gắn thêm không tăng an toàn.
- Thêm cookie này vào kiểm kê cookie (X3 / spec §9.6) nếu có danh sách.

**D94.6 JS-off và rủi ro còn lại (chấp nhận có ghi chú)**
- JS-off cùng luồng: nhập mã trong thư ⇒ `Continue`.
- JS bật hay tắt thì History vẫn ghi `/reset#token=…`. Token chết ngay khi bấm `Continue`.
- Còn lại:
  - (a) Khoảng từ lúc tải trang tới lúc bấm. Nếu người dùng bỏ dở trước khi bấm, token sống tới 30' (như trước run).
  - (b) Người có quyền vào cookie jar của chính profile đó, trong 15' TTL vé. Năng lực này cũng đủ dùng phiên webmail.
- `history.replaceState` giữ nguyên.

**D94.7 Tương thích và deploy**
- Link gửi trước deploy: cùng dạng, document cũ không có `ticketHash` (khớp `null`) ⇒ chạy bình thường.
- Tab form một bước cũ đang mở lúc deploy ⇒ 400, token còn nguyên ⇒ người dùng mở lại link trong thư.
- Thư, `/forgot`, `token-fragment.js` không đổi.
- Mongo lỗi sau khi lệnh đổi đã áp dụng nhưng mất phản hồi ⇒ token chết mà không có vé ⇒ người dùng xin link mới qua `/forgot`. Chấp nhận.
- Dedupe "còn token sống" của D91.4 tính cả document đã đổi mà chưa dùng (≤ 15'). Chấp nhận; `/forgot` không có dedupe.
- Thêm runbook-deploy §18 "Triển khai run 94":
  - `db:sync-indexes` thêm một index partial (dry-run trước, chỉ thêm, không xoá). App chạy đúng cả trước khi có index;
  - hành vi tab cũ;
  - STATUS ghi một dòng ⚠ deploy.

**D94.8 Kiểm chứng T1 (bắt buộc)**

Int:
1. Đổi token hợp lệ ⇒ 303 `/reset`, Set-Cookie đúng thuộc tính (D94.5), document có `ticketHash`, `usedAt: null`, `expiresAt ≈ now + 15'`.
2. Thân lỗi 400 giống hệt nhau cho cả 5 trường hợp: token đã đổi (gửi lại từ jar khác), không tồn tại, hết hạn, đã dùng, sai dạng. Không trường hợp nào set cookie vé.
3. `GET /reset`:
   - có vé ⇒ form mật khẩu, không có `name="token"`;
   - không có vé / vé sai / vé hết hạn ⇒ form mã;
   - luôn `no-store`.
4. `POST /reset` với vé và mật khẩu hợp lệ ⇒ đổi được, các assertion revoke hiện có còn xanh, cookie bị xoá. Lặp lại cùng vé ⇒ 400.
5. Mật khẩu bị policy từ chối ⇒ lỗi; vé vẫn dùng được với mật khẩu tốt.
6. Body hình cũ `{_csrf, token, password}` ⇒ 400; mật khẩu không đổi; token vẫn đổi được.
7. Vé hết hạn (chỉnh `expiresAt` lùi) ⇒ 400.
8. Đua song song:
   - 2 lần đổi cùng token ⇒ đúng 1 lần 303;
   - 2 lần `POST /reset` cùng vé ⇒ đúng 1 lần thành công, `setPassword` chạy 1 lần.
9. CSRF thiếu hoặc sai trên `/reset/code` ⇒ 403, token không đổi.
10. Mongo lỗi khi đổi (giả lập) ⇒ 5xx, không Set-Cookie.
11. Log không chứa token hay vé.

E2E `token-fragment.spec.ts`:
- **JS bật**:
  - fragment điền và ẩn field (như cũ);
  - bấm `Continue` ⇒ form mật khẩu tại `/reset` không fragment;
  - không request line hay Referer nào mang token (như cũ);
  - mở **link gốc** ở context mới, `Continue` ⇒ trang lỗi invalid/expired (đây là bản sửa DEBT-661);
  - mở lại link ở cùng context ⇒ form mật khẩu;
  - đổi mật khẩu thành công và đăng nhập được.
- **JS tắt**: nhập mã, `Continue`, đổi mật khẩu, đăng nhập.

Harness:
- Cập nhật mọi chỗ dùng `POST /reset` với `token` (`checks.mjs` dòng ~340, ~477, ~939): thêm `POST /reset/code` vào danh sách route và CSRF.
- Mutant m2 phải tự đỏ trên route mới.
- Check mới `AUTHN-RESET-TICKET`, tier must. Lấy token theo cùng cách check `AUTHN-PREHIJACK-VERIFY` đang làm. Kỳ vọng:
  - đổi ở jar A;
  - jar B đổi lại cùng token ⇒ 400, thân giống token lạ;
  - jar B gửi body hình cũ ⇒ 400 và mật khẩu cũ vẫn đăng nhập được.

### T2: DEBT-664

**D94.9 Làm theo trình tự sau.**

Đọc code đã thấy: `issueToken` dùng `void this.mailer.send(...)`, `SmtpMailer` không `pool`. Vậy mỗi thư mở một kết nối SMTP, số kết nối đồng thời không giới hạn. Một lượt AUTHN khoảng 440 thư ⇒ hàng trăm kết nối cùng lúc. Ở production đây cũng là rủi ro (MTA thật giới hạn số kết nối mỗi client ⇒ 421, mất thư) ⇒ **sửa ở BE, không điều kiện**.

1. **Đo trước khi sửa** (bằng chứng ghi trong `log.md`):
   - Viết SMTP sink bằng `node:net` trong scratchpad, cổng riêng (ví dụ 2525). Không tải gói.
   - Sink trả 220, 250, 354; đếm peak kết nối đồng thời; đánh dấu kết nối nào đóng có QUIT/FIN.
   - Chạy `pentest.mjs --only AUTHN` (hoặc nhóm gửi thư) với `SMTP_URL` trỏ sink. Harness đang cố định `SMTP_URL` (`pentest.mjs` dòng ~127) ⇒ thêm override env `PENTEST_SMTP_URL`, mặc định giữ nguyên.
   - Đọc thêm `docker logs --tail 200 veyrigate-mailpit-1` và `docker exec veyrigate-mailpit-1 /mailpit version`. Chỉ đọc, KHÔNG restart.
2. **Quy tắc phân loại**:
   - (a) Có kết nối không đóng quá `socketTimeout + 5 s` sau thư cuối ⇒ rò kết nối = lỗi production, sửa ở BE.
   - (b) Peak lớn hơn 5 ⇒ burst không giới hạn = lỗi production, sửa bằng (3).
   - (c) Sau (3), peak ≤ 5 và mọi kết nối đã đóng, nhưng Mailpit vẫn kẹt ⇒ lỗi phía Mailpit dưới tải test:
     - sửa ở harness (giảm hoặc giới hạn số thư của nhóm AUTHN; không giảm độ phủ check must);
     - mở DEBT-684: nâng pin Mailpit, cần người dùng.
3. **Sửa BE** (`smtp.mailer.ts`):
   - `createTransport({url, pool: true, maxConnections: 5, maxMessages: 100, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000})`. Hằng số trong code, không thêm env.
   - `close()` transport khi shutdown (`OnApplicationShutdown` của module mailer, sau phần chờ việc tách rời D91.11).
   - Unit test với SMTP server `node:net` trong test (không cần Mailpit): 20 thư song song ⇒ peak ≤ 5, nhận đủ 20; sau `close()` không còn socket.
   - Hàng đợi pool không giới hạn ⇒ DEBT-683 (P3).
4. **Harness**:
   - **Preflight**: trước khi boot, đọc greeting `127.0.0.1:1025` trong 6 s. Không có `220` ⇒ refuse, exit 1, thông điệp cố định "SMTP 127.0.0.1:1025 gives no 220 greeting (DEBT-664)".
   - **`HYG-MAIL`** (must): trước `cleanMailpit`, search Mailpit `to:"pentest.invalid"` ⇒ cần ≥ 1. Bằng 0, hoặc Mailpit HTTP lỗi ⇒ đỏ.
   - **`HYG-SMTP-AFTER`** (must): sau mọi nhóm, đọc lại greeting ⇒ cần `220`. Ghi `smtpAfter` vào evidence.
   - Hai check này **không** nằm trong `--only` của mutate (mutate không chạy AUTHN).
5. **Tiêu chí xong**:
   - lượt `pentest.mjs` đầy đủ (timing on) **và** `--timing off` local đều xanh, kể cả `HYG-SMTP-AFTER`;
   - sau đó lệnh kiểm 220 trong ràng buộc cứng trả `220`;
   - CI job `pentest` xanh với 2 check mới;
   - bằng chứng đo (peak trước/sau, nhánh a/b/c) ghi trong `log.md`.

### T3: DEBT-669

**D94.10 Tạo file mới `docs/integration-rp-rs.md`.**
- Đây là tài liệu cho người tích hợp, nên không đặt trong `docs/agile`.
- Thêm link từ `README.md`. Spec §8 thêm một dòng trỏ tới file.

Nội dung, ngắn và cụ thể:
1. **RS và thao tác nhạy cảm**: gọi `POST /introspect` (có xác thực client) mỗi request; `active: false` ⇒ 401.
   - Lý do: denylist `at_revoked:{jti}` chỉ thấy được qua introspect/userinfo.
   - Dev đọc mọi chỗ ghi `at_revoked` để liệt kê **đúng** sự kiện thu hồi. Không viết những gì code không làm.
   - Verify JWT cục bộ chỉ hợp cho thao tác chịu được độ trễ thu hồi ≤ `ACCESS_TOKEN_TTL`.
2. **`ACCESS_TOKEN_TTL` giữ 900 s** (plan §12 chốt 900 s): tăng TTL là tăng cửa sổ dùng token đã bị thu hồi. RS cache JWKS ≤ `KEY_PREPUBLISH_SEC`.
3. **ID token không thu hồi được**: chỉ dùng để xác lập danh tính lúc đăng nhập, không dùng làm credential gọi API. Phiên RP theo cơ chế logout hiện có.
4. **Không có cơ chế phát tán denylist** tới RS; ghi rõ như vậy.

Không đưa secret hay PEM vào ví dụ; ví dụ dùng placeholder `<client_secret>`.

### T4: DEBT-682

**D94.11 Hai step mới trong job `pentest`**, đặt sau "Upload pentest evidence", không thêm action.
- Checkout của job đặt `fetch-depth: 2`.
- Job `timeout-minutes: 15` ⇒ 40.

**Step "Detect mutation-relevant changes"** (`id: mut`):
- Truyền sự kiện qua `env`, không nội suy `${{ }}` trong script: `EVENT=${{ github.event_name }}`, `BEFORE=${{ github.event.before }}`.
- Cách lấy danh sách file đổi:

  | Trường hợp | Cách lấy | Không lấy được ⇒ |
  |---|---|---|
  | `pull_request` | `git diff --name-only HEAD^1 HEAD` (`GITHUB_SHA` là merge commit; parent 1 = base) | `run=true` |
  | `push`, `BEFORE` toàn số 0 (push đầu tiên của nhánh) | — | `run=true` |
  | `push`, còn lại | `git fetch --no-tags --depth=1 origin "$BEFORE"`, rồi `git diff --name-only "$BEFORE" HEAD` | `run=true` (force-push hoặc sha không với tới) |
  | Sự kiện khác | — | `run=true` |

- Khớp (`grep -E`) ⇒ `run=true`:
  - `^be/scripts/pentest/`
  - `^be/scripts/drills/lib\.mjs$`
  - `^\.github/workflows/ci\.yml$`
  - sáu file nguồn mà mutant vá: `be/src/modules/oauth/authorize/authorize.service.ts`, `be/src/modules/ui/csrf.service.ts`, `be/src/modules/ui/mfa.controller.ts`, `be/src/bootstrap.ts`, `be/src/modules/identity/tenant-context/tenant-scoped.repository.ts`, `be/src/common/http/request-id.ts`.
- Comment "giữ đồng bộ với `MUTATIONS[].file`" ở cả `ci.yml` và `mutate.mjs`.
- In danh sách file khớp và lý do ra log.

**Step "Mutation harness (DEBT-682)"**:
- `if: steps.mut.outputs.run == 'true'`, `timeout-minutes: 20`.
- Chạy `node be/scripts/pentest/mutate.mjs all`. Exit ≠ 0 (mutant không đỏ đúng check, `dist` thay đổi, còn file sót) ⇒ job đỏ.

**Kiểm chứng**:
- Chạy đoạn script detect cục bộ với 4 ca: PR (giả lập merge commit trong clone scratch), `BEFORE` toàn số 0, sha không tồn tại, range thật. Ghi output vào `log.md`.
- `node be/scripts/pentest/mutate.mjs all` xanh cục bộ sau lô A và B.
- Push run 94 tự kích hoạt step (vì đổi `be/scripts/pentest/**`) ⇒ orchestrator xác nhận trên CI.

### Lô, agent, thứ tự

**D94.12 Tiền điều kiện**: SMTP 220 đã xác nhận lúc fold (2026-11-17, tech-lead). Mỗi lô cần thư phải kiểm lại; không có 220 ⇒ dừng, báo orchestrator. Người dùng restart, agent không restart.

**D94.13 Chia lô**

| Lô | Nội dung | Agent | Ghi chú |
|---|---|---|---|
| **A** | T1 (BE + eta + int + E2E + harness check + runbook §18) | backend-dev | Không cần frontend-dev: eta và static JS nằm trong BE, `token-fragment.js` không đổi. |
| **B** | T2 + T4 | backend-dev | Tuần tự **sau A** (cùng `pentest.mjs`/`checks.mjs`). T4 chỉ chạm `ci.yml` và comment ở `mutate.mjs`. |
| **C** | T3 | backend-dev hoặc orchestrator | Song song với A, chỉ docs. |
| **D** | Gate tester | tester | Thứ tự bên dưới. |

Thứ tự gate ở lô D:
1. be unit
2. int FULL
3. E2E ×1 (SMTP 220 trước)
4. X3 (chạm cookie và trang UI)
5. `mutate.mjs all`
6. harness đầy đủ (timing on) **sau** E2E
7. kiểm 220 sau harness ⇒ tiêu chí D94.9-5

fe-admin không chạm ⇒ bỏ.

Sau đó senior review, rồi orchestrator push và xác nhận CI (pentest + step mutation chạy).

**D94.14 DEBT mới**
- **DEBT-683** (P3, [BE]): hàng đợi pool nodemailer không giới hạn. Cần cap + metric độ sâu hàng đợi + log khi bỏ thư.
- **DEBT-684** (P3, [QA/infra]): **chỉ mở nếu** D94.9 rơi vào nhánh (c). Nội dung: nâng pin Mailpit (CI và local), cần người dùng.

Tiến độ DEBT sau run:
- DEBT-661 đóng sau lô D (ghi chú D94.1/D94.6).
- DEBT-664 đóng khi đạt D94.9-5.
- DEBT-669 đóng khi có D94.10.
- DEBT-682 đóng khi CI chạy step mutation xanh.
