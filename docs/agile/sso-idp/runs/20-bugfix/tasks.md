# Tasks — run 20 — bugfix (DEBT-067/068, 029/039 + 006, 007, 021, 053/061)

> Run **chỉ sửa bug** (người dùng ưu tiên fix bug trước FE). Mỗi task code: viết **test tái hiện lỗi (RED) trước**, rồi sửa cho GREEN.
> Baseline: `pnpm test` 141 + `pnpm test:int` 414 = **555** (cần `docker start vg-test-mongo vg-test-redis`). Không được giảm số test; test cũ chỉ được sửa khi nó khẳng định đúng hành vi lỗi (ghi rõ).
> § trỏ: spec §6.2 (Redis fail behavior), §6.3 (rate limit), §6.4 (key mgmt), §9.3 (client auth/rotation), §11 (endpoint), §15 (INV-18/19/25/29); runbook-deploy.md §1–§4.
> Đã đối chiếu code thật (CodeGraph sync OK, 158 file). Dòng code dẫn theo commit `8a58faa`.

---

### [x] Task 1 [BE]: DEBT-067 — `/token` nhánh `!live`: revoke family ném ⇒ mất audit `TOKEN_ISSUED failure session_ended` (+ DEBT-068)
- **Bằng chứng (code thật)**: `be/src/modules/oauth/token/token.controller.ts:213–227`. Trong `if (!live)`, `await this.refresh.revokeFamilyForEndedSession(...)` (L220) chạy TRƯỚC `await this.tokens.recordIssued(client, data, 'failure', 'session_ended', audit)` (L225). Nếu revoke ném (Mongo `updateMany` lỗi trong `revokeFamily`, hoặc `audit.record` TOKEN_REVOKED lỗi — `refresh-token.service.ts:360–379`) ⇒ exception lan ra, dòng L225 không bao giờ chạy ⇒ 500 (fail-closed đúng) nhưng **0 bản ghi `TOKEN_ISSUED`** cho một code grant bị từ chối. Tester run 19 xác nhận (`runs/19-bugfix/test-report.md` T-067). So sánh: nhánh Redis-lỗi (L199–211) và nhánh audit-success-lỗi (L231–239) đã làm best-effort đúng — chỉ nhánh `!live` lệch.
- **DEBT-068 (gộp, cùng chỗ)**: `token.service.ts:178–179` `recordIssued` tự tính lại `refresh = grantTypes.includes('refresh_token') && scopes.includes('offline_access')`, trùng quy tắc `issueRefresh` (L113–114). Nếu quy tắc phát hành refresh đổi, audit `metadata.refresh` lệch thực tế. Controller đã biết sự thật: `!!familyId`.
- **Repro**: int test — code grant có `offline_access`, stub `sessions.exists` true→false (như case DEBT-059 sẵn có trong `test/token.int-spec.ts`), và `jest.spyOn(refreshService, 'revokeFamilyForEndedSession').mockRejectedValueOnce(new Error('db down'))`. Hiện tại: 500, audit có 0 `TOKEN_ISSUED`.
- **Acceptance (đo được)**:
  - RED→GREEN int: kịch bản repro ⇒ HTTP 500 `{error:'server_error'}`, body không có `access_token`/`refresh_token`; audit có **đúng 1** `TOKEN_ISSUED result:'failure' reason:'session_ended'`, **0** `TOKEN_ISSUED success`.
  - Lỗi gốc (`db down`) vẫn là lỗi được log/rethrow — nếu chính `recordIssued` failure cũng ném thì bị nuốt (`.catch`), KHÔNG che lỗi gốc (unit hoặc int: stub cả hai ném ⇒ vẫn 500, logger nhận message lỗi gốc).
  - Các case DEBT-059 hiện có (có/không `offline_access`, Redis lỗi, audit-success lỗi) giữ nguyên xanh.
  - DEBT-068: `recordIssued` nhận `refresh: boolean` từ caller (`!!familyId`), không tự tính lại. Test: client có `refresh_token` + scope `offline_access` ⇒ `metadata.refresh === true`; không `offline_access` ⇒ `false` (2 assertion trên audit success hiện có ở `token.int-spec.ts`). Unit `token.service.spec.ts` cập nhật chữ ký, không xoá case.
  - Full suite ≥ 555 + test mới, 0 fail; typecheck + lint 0 lỗi.
- **Gợi ý sửa (không bắt buộc hình thức)**: trong `!live`: `try { await revokeFamilyForEndedSession(...) } catch (err) { await recordIssued(...'failure','session_ended'...).catch(() => undefined); throw err; }` rồi mới `await recordIssued(...)` cho nhánh bình thường. Không dùng `finally` (sẽ ghi 2 lần hoặc nuốt lỗi).
- **Security invariants**:
  - Tài sản: tính toàn vẹn audit (INV-25); refresh family vừa mint (INV-29). Actor: user hợp lệ, attacker lợi dụng TOCTOU logout; lỗi hạ tầng.
  - Invariant: mọi code grant bị từ chối vì phiên đã kết thúc để lại **đúng một** `TOKEN_ISSUED failure session_ended`; không bao giờ có `success` khi không trả token. Không trả token trong mọi nhánh lỗi (fail-closed).
  - State: mint (+family) → re-check `!live` → revoke family (có thể lỗi) → audit failure → 500/`invalid_grant`. Nếu revoke lỗi, family có thể còn `active` trong DB nhưng giá trị refresh token **chưa từng rời server** ⇒ không dùng được; chấp nhận (ghi comment), không thêm retry.
  - Exposure: metadata audit chỉ `{resource, scope, refresh}` (+`reason`); không token/code/familyId/sessionRef.
- **Phụ thuộc**: không. § trỏ: spec §8, §9.8, §15 (INV-25, INV-29).

### [x] Task 2 [BE]: DEBT-029 + DEBT-039 (+ DEBT-006) — rate-limit client auth trên `/token`, `/revoke`, `/introspect` (brute-force secret / DoS Argon2)

> **(tech-lead fold — retry 1) — ƯU TIÊN CAO NHẤT, thay bước 1–2 của "Thiết kế rate limit" bên dưới + siết guard `TRUST_PROXY`.** Lý do: `review-senior.md` 🔴1/🔴2, `review-techlead.md` §"Bổ sung — retry 1".
>
> **R1 — 🔴1: reserve-then-refund atomic (thay `peek`→`hit`)**. Invariant đo được: *trong một cửa sổ, số lần Argon2 cho một `client_id|ip` ≤ `CLIENT_MAX` và cho một `ip` ≤ `IP_MAX`, kể cả khi request song song, nhiều instance* (overshoot = 0).
> - `RateLimitService.reserve(...)` = **1 Lua script** (`rateLimitReserve`, KEYS = 2 khoá, ARGV = 2 limit + windowMs): `GET` từng key (nil ⇒ 0); nếu **bất kỳ** key nào `>= limit` ⇒ trả blocked + `PTTL` lớn nhất trong các key vượt, **không INCR key nào**; ngược lại `INCR` **tất cả**, `PEXPIRE windowMs` khi count==1. Trả `RateLimitResult` hiện có (`retryAfterSec ≥ 1`).
> - `RateLimitService.refund(...)` = Lua `rateLimitRefund`: mỗi key chỉ `DECR` khi **tồn tại và > 0** (không tạo key, không âm, giữ TTL).
> - **Cùng slot (Redis Cluster/DEBT-013)**: 2 khoá chung hash tag theo IP: `rl:client-auth:{<sha256(ip)>}:ip` và `rl:client-auth:{<sha256(ip)>}:client:<sha256(clientId|ip)>` (giữ `normalize` lowercase như cũ) ⇒ không CROSSSLOT. Không đổi key/Lua của `hit()` (login). `beforeEach` xoá `rl:client-auth:*` vẫn khớp.
> - Luồng `authenticate` (method ≠ `none`): **`reserve` TRƯỚC `findByClientId`** (đóng 🟡 query Mongo khi đã bị chặn) → blocked ⇒ `ClientAuthRateLimitedError` (không DB, không Argon2) → `findByClientId` + `verifySecret` → **thất bại ⇒ giữ reservation** (đó chính là lần đếm thất bại) ⇒ `InvalidClientError` → **thành công ⇒ `refund`** rồi trả client. Lỗi bất ngờ giữa chừng (Mongo/Argon2 ném) ⇒ không refund (chặt hơn, hết theo TTL).
> - `method === 'none'`: như cũ, **không** gọi `reserve`/`refund`.
> - **Failure semantics**: `reserve` ném/timeout ⇒ fail-closed 500 `server_error` (D5). `refund` ném ⇒ **best-effort**: `logger.warn` (chỉ `err.message`; không clientId/IP thô, không secret), **vẫn trả thành công** — sai lệch chỉ theo hướng chặt hơn (+1, hết theo cửa sổ). Tiến trình chết giữa reserve và refund ⇒ thừa 1, hết theo TTL. Refund vắt qua ranh giới cửa sổ có thể trừ 1 ở cửa sổ mới — chấp nhận (sàn 0), ghi comment.
> - **Ngữ nghĩa ngưỡng** (ghi vào spec §11 + `.env.example`): `CLIENT_AUTH_FAIL_*_MAX` = *số lần thất bại + số lượt xác thực đang chạy* trong cửa sổ; thành công không tích luỹ. Giữ default 30/10.
> - **Xoá `RateLimitService.peek()`** và các assertion `peek` ở `rate-limit.int-spec.ts` (thay bằng test `reserve`/`refund`). Không giữ code chết.
> - Acceptance bổ sung ((a)–(g) giữ kỳ vọng, chỉ đổi cơ chế):
>   - (k) **Race**: CLIENT_MAX=3, IP_MAX=5, N=50 request **song song** (`Promise.all`), cùng IP+client, secret sai ⇒ spy `verifySecret` gọi **đúng 3** lần; 3×401 + 47×429. Biến thể client_id xoay vòng cùng IP ⇒ **đúng 5** lần.
>   - (l) **Không phạt client hợp lệ**: 3 request song song đúng secret ⇒ 3×200; sau đó cả 2 khoá = 0/không tồn tại; lặp 5 đợt ⇒ luôn 200.
>   - (m) `refund` ném (spy) ⇒ 200 + có token + `warn` được gọi; counter = 1.
>   - (n) `reserve` ném ⇒ 500, `findByClientId` và `verifySecret` **không** được gọi (thay phần peek của (i)).
>   - (o) Bị chặn ⇒ spy `clients.findByClientId` **không** được gọi.
>   - (p) Lua: key hết hạn rồi `refund` ⇒ không tạo lại key, không âm; `reserve` khi 1 key vượt ⇒ key kia **không** tăng.
>   - (j) viết lại để mutation M5 chết: lấp đầy bucket IP bằng client confidential sai secret, rồi request `none` hợp lệ vẫn qua client auth; spy `reserve`/`refund` không được gọi.
>
> **R2 — 🔴2: `parseTrustProxy` từ chối mọi giá trị ≈ "tin mọi hop"** (throw, thông báo nêu entry + lý do):
> - CIDR IPv4 prefix **< 8** (gồm `0.0.0.0/0`, `0.0.0.0/1`…). CIDR IPv6 prefix **< 8** (gồm `::/0`; vẫn cho `fd00::/8`).
> - **IPv4-mapped IPv6** (`::ffff:…/p`): đã kiểm thực tế với `@fastify/proxy-addr@5.1.1`: `::ffff:0:0/96` và `::ffff:0.0.0.0/96` tin **mọi IPv4**. Quy về IPv4 với prefix `p-96`; `p < 104` ⇒ từ chối.
> - Hop count **> 10** ⇒ từ chối (hop dư ⇒ client prepend XFF giả). Giữ `>= 1`.
> - Unit bắt buộc: `0.0.0.0/0`, `::/0`, `0.0.0.0/7`, `::/7`, `::ffff:0:0/96`, `::ffff:0.0.0.0/96`, `11` ⇒ throw; `10.0.0.0/8`, `fd00::/8`, `::ffff:10.0.0.0/104`, `10` ⇒ hợp lệ. `validation.schema.ts` dùng chung hàm (không lặp logic).
>
> **R3 — 🟡 `main.ts` đọc env trước ConfigModule (bắt buộc)**: trước `parseTrustProxy`, nạp `.env` ở cwd (cùng đường dẫn mặc định của `@nestjs/config`) bằng `process.loadEnvFile()` **chỉ khi file tồn tại** (Node 22). Đã kiểm: `loadEnvFile` **không ghi đè** biến môi trường thật — cùng thứ tự ưu tiên với `@nestjs/config`. Sau `NestFactory.create`: hàm thuần `assertTrustProxyConsistent(adapterValue, config.app.trustProxy)` so khớp sâu, lệch ⇒ throw (fail-fast trước `listen`). Giữ `app.trustProxy` (giờ có người đọc — đóng ponytail). Runbook §5 + `.env.example`: ghi 2 nguồn được hỗ trợ + cảnh báo **số hop phải đúng bằng số proxy**. Verify: unit cho `assertTrustProxyConsistent` (bằng/khác/false vs 1/mảng khác thứ tự ⇒ lệch).
>
> **R4 — mọi 🟡 còn lại của senior: BẮT BUỘC vòng này**: (h) test INV-13 (chặn → xoá `rl:client-auth:*` → đổi code ⇒ 200); (f) thêm IP2 + secret **đúng** ⇒ 200; T4 retry E11000 (spy `findOne` stale lần 1 ⇒ thành công v+1; ép E11000 2 lần ⇒ rejects); T3 spy `rename` ném ⇒ `keys.json` cũ parse được + không còn `*.tmp`; emergency `rm` lỗi ⇒ `logger.error`; T1 case revoke **và** `recordIssued` cùng ném ⇒ 500, logger nhận lỗi gốc. Nit/ponytail rẻ cũng làm: xoá `void keys` (`client-auth-rate-limit.int-spec.ts:300–301`); đưa `writeFile(tmp)` vào `try` ở `local-key-provider.ts`. **Không làm** vòng này: `error_description` cho `/introspect` 429.
> - Mutation senior sẽ chạy lại: M5, M11, M15, M16 phải **chết**; thêm "bỏ refund" ((l) chết), "INCR trước kiểm ngưỡng" ((k)/(p) chết), "bỏ guard mapped /96" (R2 chết).
> - Full suite ≥ 590 + mới, 0 fail; typecheck + lint 0 lỗi.
>
> **(tech-lead fold) — BẢN CHỐT, THAY THẾ mọi chỗ mâu thuẫn bên dưới** (khoá, ngưỡng, bucket, acceptance a–g). Lý do: `runs/20-bugfix/review-techlead.md`.
>
> **Bước 0 — DEBT-006 `trustProxy` (bắt buộc làm trước rate limit)**: không có nó, sau reverse proxy bucket `ip` = giới hạn toàn cục và `clientId|ip` = khoá theo client_id trần ⇒ attacker khoá được `/token` của mọi client.
> - Env `TRUST_PROXY` (tuỳ chọn, mặc định tắt): rỗng/`false` ⇒ `false`; còn lại ⇒ **chỉ** danh sách IP/CIDR phân tách dấu phẩy (validate từng phần tử bằng `net.isIP`, cả phần IP của `ip/prefix`). **Từ chối `true`** và **từ chối giá trị dạng số (số hop)** ở `validation.schema.ts`/`parseTrustProxy` (`true` ⇒ spoof IP; số ⇒ Fastify 5 âm thầm bỏ qua ⇒ `req.ip` rơi về IP socket, bucket IP thành giới hạn toàn cục). Hàm thuần `parseTrustProxy(raw)` (`be/src/config/trust-proxy.ts`) trả `false | string[]` dùng cho `main.ts` → `new FastifyAdapter({ trustProxy })`; test int dựng app bằng cùng hàm. Thêm `.env.example` + runbook-deploy (đặt đúng IP/CIDR proxy, không dùng số hop).
> - Acceptance: unit `parseTrustProxy` (rỗng/false/`true`⇒lỗi/**số (vd. `1`,`2`) ⇒ lỗi**/`10.0.0.1,10.0.0.0/8`/IP sai⇒lỗi/`010.0.0.0/8` octal⇒lỗi/`,` danh sách rỗng⇒lỗi); unit chạy qua `FastifyAdapter` thật (inject XFF ⇒ kiểm `req.ip`) + cross-check `@fastify/proxy-addr` thật (IP công khai không bị tin). Int: không cấu hình ⇒ 2 request với `X-Forwarded-For` khác nhau dùng **chung** counter (XFF bị bỏ qua); `trustProxy: '127.0.0.1'` ⇒ counter **độc lập** theo XFF.
>
> **Thiết kế rate limit (D1–D6 chốt)**:
> - Thực thi tại **một chỗ**: `ClientAuthenticationService.authenticate(input, ctx: { ip: string | undefined })` — `ctx` bắt buộc (không optional), `ip` rỗng ⇒ `'unknown'`. Cả `/token`, `/revoke`, `/introspect` đi qua đây ⇒ không nhân bản trong controller. `method === 'none'` ⇒ bỏ qua rate limit (không Argon2, không secret).
> - **Chỉ đếm thất bại**: thêm `RateLimitService.peek(rule, subject)` (GET các key, không INCR; tái dùng hàm dựng key của `hit` — tách `keysFor()`; trả cùng `RateLimitResult` với `count >= limit` ⇒ exceeded, `retryAfterSec` từ PTTL, ≥1).
>   1. Trước `findByClientId`/Argon2: `peek({name:'client-auth', limit: IP_MAX}, {ip})` và `peek({name:'client-auth', limit: CLIENT_MAX}, {account: \`${clientId}|${ip}\`})` (2 lời gọi vì limit khác nhau). Bị chặn ⇒ ném `ClientAuthRateLimitedError(retryAfterSec)` — KHÔNG Argon2, KHÔNG truy vấn DB.
>   2. Sau khi xác định thất bại (client lạ / sai method / sai secret) ⇒ `hit()` cả 2 khoá rồi ném `InvalidClientError`. Thành công ⇒ không đếm. Request bị 429 ⇒ không đếm.
>   - Một bucket `client-auth` chung cho `/token`, `/revoke`, `/introspect` (D6).
> - Ngưỡng (D2): `CLIENT_AUTH_FAIL_IP_MAX` (default **30**), `CLIENT_AUTH_FAIL_CLIENT_MAX` (default **10**), cửa sổ `RATE_LIMIT_WINDOW`. Bỏ các biến `CLIENT_AUTH_RATE_LIMIT_*`/`INTROSPECT_RATE_LIMIT_*`.
> - 429 (D4): controller map `ClientAuthRateLimitedError` ⇒ status 429, header `Retry-After`, `Cache-Control: no-store` (đã có), body `{error:'temporarily_unavailable'}` (thêm vào `TokenErrorCode` và kiểu lỗi introspect); không `WWW-Authenticate`.
> - Redis lỗi ở `peek`/`hit` (D5) ⇒ ném nguyên lỗi ⇒ 500 `server_error`, không token, không `active`.
>
> **Acceptance chốt** (thay a–g; ngưỡng test: CLIENT_MAX=3, IP_MAX=5):
> - (a) Cùng IP+client_id, secret sai: lần 1–3 ⇒ 401; lần 4 ⇒ 429 + `Retry-After ≥ 1` + `temporarily_unavailable`; spy `verifySecret` chứng minh lần 4 **không** gọi.
> - (b) Đúng secret sau khi bị chặn ⇒ vẫn 429 (chặn trước Argon2) — có chủ đích; ghi comment.
> - (c) **Thành công không đếm**: 20 request đúng secret liên tiếp ⇒ đều 200/không 429.
> - (d) Basic và `client_secret_post` cùng client_id ⇒ chung counter.
> - (e) client_id xoay vòng không tồn tại cùng IP ⇒ lần 6 ⇒ 429 (bucket ip), không Argon2.
> - (f) Client A bị khoá ở IP1 ⇒ client A từ IP2 (qua trustProxy + XFF) vẫn xác thực được (attacker không khoá được client hợp lệ ở IP khác).
> - (g) `/revoke` và `/introspect` chung bucket với `/token` (2 sai ở `/token` + 1 sai ở `/introspect` ⇒ lần 4 ở `/revoke` ⇒ 429). `/introspect` 429 không có `active`.
> - (h) 429 trên `authorization_code` với code hợp lệ ⇒ code không bị consume (INV-13).
> - (i) Redis `peek`/`hit` ném ⇒ 500 `server_error`, không token.
> - (j) `method:'none'` (public client) không bị đếm/chặn.
> - Isolation: test module mặc định ngưỡng cao (vd. 10000) cho mọi file int hiện có; spec mới ghi đè ngưỡng nhỏ + `beforeEach` xoá `rl:client-auth:*`. Unit: config default + từ chối ≤0; `peek` không tăng counter.
> - Đổi chữ ký `authenticate(input, ctx)` ⇒ cập nhật các lời gọi trực tiếp trong test (`clients.int-spec.ts` …) thêm `{ ip: '127.0.0.1' }` — chỉ đổi chữ ký, không xoá/đổi kỳ vọng.
> - Full suite ≥ 555 + mới, 0 fail; typecheck + lint 0 lỗi.
- **Bằng chứng (code thật)**:
  - `RateLimitService` (`be/src/modules/security/rate-limit/rate-limit.service.ts`) + `@RateLimit` guard chỉ được dùng ở `ui.controller.ts:395–402` (login/register/reset). `token.controller.ts` và `introspect.controller.ts` **không** inject `RateLimitService` (grep: 0 tham chiếu).
  - `token.controller.ts:115–130` `authenticateClient` → `clientAuth.authenticate` → `ClientCredentialService.verifySecret` chạy Argon2id **cho mọi request**, kể cả `client_id` không tồn tại (dummy hash, `client-credential.service.ts:102–106`) ⇒ attacker gửi vô hạn request với `client_id` tuỳ ý ⇒ CPU DoS; và brute-force secret của client có thật không bị chặn. `/revoke` (L290) dùng chung `authenticateClient`. `/introspect` (`introspect.controller.ts:114–133`) cùng mẫu.
  - spec §6.3/§14 yêu cầu rate limit đa chiều; §11 chưa ghi cho `/token`/`/introspect`.
- **Không dùng `@RateLimit` guard nguyên trạng** vì: guard chạy trước controller, chỉ đọc `body[accountField]` — không thấy `client_id` trong header Basic (`client-auth-request.ts:63–90`). Đề xuất: **gọi trực tiếp `RateLimitService.hit()` trong controller**, sau `resolveClientAuth` (đã có `clientId` chuẩn hoá từ Basic HOẶC body, đã từ chối Basic≠body) và **trước** `clientAuth.authenticate` (trước Argon2). Request lỗi parse/`unsupported_grant_type`/`ClientAuthRequestError` không chạm Argon2 nên không cần đếm (nhưng được phép).
- **Đề xuất phương án (cần tech-lead chốt — xem "Quyết định mở")**:
  - Khoá: 2 lần `hit()` với 2 bucket/ngưỡng riêng (vì `hit()` áp 1 `limit` chung cho mọi dimension của một lần gọi):
    1. `{name:'client-auth:ip'}` subject `{ip}` — chặn DoS Argon2 bằng `client_id` xoay vòng.
    2. `{name:'client-auth:client'}` subject `{account: \`${clientId}|${ip}\`}` — chặn brute-force secret của một client từ một IP, ngưỡng thấp hơn. KHÔNG khoá theo `client_id` đơn thuần (attacker từ xa khoá được client hợp lệ = DoS client).
    - Lưu ý: `normalize()` lowercase `account` ⇒ `client_id` khác hoa/thường dùng chung counter — chỉ làm đếm chặt hơn, chấp nhận (ghi comment). Key Redis là sha256 nên `client_id`/IP thô không vào Redis.
  - `/token` + `/revoke` dùng chung bucket (cùng tài nguyên: secret của client); `/introspect` bucket riêng (`introspect:*`) vì resource server có thể gọi tần suất cao.
  - Ngưỡng: đọc từ env mới, mặc định an toàn: `CLIENT_AUTH_RATE_LIMIT_IP_MAX=300`, `CLIENT_AUTH_RATE_LIMIT_CLIENT_MAX=60`, `INTROSPECT_RATE_LIMIT_IP_MAX=600`, `INTROSPECT_RATE_LIMIT_CLIENT_MAX=300`, cửa sổ dùng `RATE_LIMIT_WINDOW` (60s). Thêm vào `validation.schema.ts` (positiveInt, có default) + `configuration.ts` + `.env.example`.
  - Vượt ngưỡng: HTTP **429**, header `Retry-After: <sec>`, `Cache-Control: no-store` (đã có), body `{error:'temporarily_unavailable', error_description:'Too many requests.'}` (mã cố định, không echo input); KHÔNG gửi `WWW-Authenticate`; KHÔNG chạy Argon2; KHÔNG consume code/refresh.
  - Redis lỗi khi `hit()`: **fail-closed 500 `server_error`** (nhất quán §6.2 và `/token` vốn phụ thuộc Redis). Không ghi audit cho 429 (tránh flood audit); log warn được phép chứa `clientId` (không phải secret), tuyệt đối không log secret.
- **Acceptance (đo được)**:
  - RED→GREEN int (`test/token.int-spec.ts` hoặc file mới `test/client-auth-rate-limit.int-spec.ts`, cấu hình ngưỡng nhỏ, vd. client=3, ip=5):
    - (a) Cùng IP + cùng `client_id`, secret sai: request 1–3 ⇒ 401 `invalid_client`; request 4 ⇒ **429** + `Retry-After` ≥ 1 + body `error:'temporarily_unavailable'`; spy `verifySecret`/`verifyPassword` chứng minh request 4 **không** gọi Argon2.
    - (b) Client_id qua **Basic** và qua **body** (`client_secret_post`) cùng giá trị ⇒ chung một counter (3 Basic + 1 post ⇒ 429).
    - (c) Cùng IP, `client_id` xoay vòng (không tồn tại) ⇒ chặn bởi bucket IP ở request 6.
    - (d) `client_id` khác cùng IP ⇒ counter `client` độc lập (chỉ bucket IP chung).
    - (e) `/revoke` chung bucket với `/token`; `/introspect` bucket riêng, cùng hành vi 429 (không body introspection, không `active`).
    - (f) Request 429 trên `grant_type=authorization_code` với code hợp lệ ⇒ code **không** bị consume (lần sau sau khi reset counter vẫn đổi được) — INV-13.
    - (g) Redis `hit` ném ⇒ 500 `server_error`, không token.
  - Test hiện có không vỡ: test module cung cấp `security` config ngưỡng cao hoặc xoá `rl:client-auth*`/`rl:introspect*` trong `beforeEach` (counter Redis sống 60s xuyên file test, cùng IP `127.0.0.1` của `inject`).
  - Unit: config validation default/từ chối giá trị ≤0.
  - Full suite ≥ 555 + mới, 0 fail; typecheck + lint 0 lỗi.
- **Security invariants**:
  - Tài sản: client secret (INV-18), CPU (Argon2), authorization code chưa dùng (INV-13). Actor: anonymous/attacker (xoay `client_id`, xoay IP), client hợp lệ khác, client hợp lệ cùng NAT.
  - Invariant: không request nào chạy Argon2 khi đã vượt ngưỡng; rate-limit diễn ra trước mọi thay đổi state (consume code, rotate refresh); attacker không thể khoá client hợp lệ ở IP khác (khoá theo `client_id|ip`, không theo `client_id` trần).
  - Trust boundary: `client_id` lấy từ `resolveClientAuth` (Basic hoặc body — **chưa xác thực**, chỉ dùng làm khoá đếm, không dùng cho quyết định cấp quyền). `req.ip` hiện là IP socket (DEBT-006 chưa bật `trustProxy`) — sau reverse proxy mọi client chung IP ⇒ bucket IP thành global; ghi nhận, không sửa ở run này.
  - Failure: Redis down ⇒ fail-closed 500. Race: counter INCR+PEXPIRE trong Lua (atomic, đã test ở `rate-limit.int-spec.ts`).
  - Enumeration: 429 trả như nhau cho `client_id` tồn tại hay không (không khác biệt body/thời gian vì không chạy Argon2 ở cả hai).
  - Exposure: response/log/Redis key không chứa secret; Redis key chỉ chứa sha256.
- **Phụ thuộc**: không (độc lập T1, nhưng cùng file `token.controller.ts` — làm SAU T1 để tránh xung đột). § trỏ: spec §6.2, §6.3, §9.3, §11, §14; plan B1.8.

### [x] Task 3 [BE]: DEBT-007 — `LocalKeyProvider.rotate()` xoá PEM trước khi ghi `keys.json` ⇒ lỗi giữa chừng làm hỏng state key

> **(tech-lead fold)**: **BỎ mục "Dọn rác" PEM mồ côi** trong `init`/`rotate` — 2 tiến trình dùng chung thư mục key (rolling deploy) sẽ xoá PEM vừa tạo của nhau trước khi ghi state ⇒ tái tạo đúng lỗi đang sửa. PEM mồ côi do `writeState` lỗi là key mới chưa từng ký (vô hại). File tạm tên duy nhất `keys.json.<randomUUID>.tmp` (mode 0o600) rồi `rename`; nếu `rename` lỗi ⇒ `rm` file tạm best-effort, ném lỗi. `rm` PEM cũ lỗi: normal ⇒ `logger.warn`, emergency ⇒ `logger.error` (chỉ kid). Acceptance "tạo sẵn `<uuid>.pem` lạ ⇒ sau rotate không còn" → thay bằng: "PEM lạ không bị đụng tới".
- **Bằng chứng (code thật)**: `be/src/modules/keys/local-key-provider.ts:56–78`. Thứ tự hiện tại: `createKey()` (ghi PEM mới) → `rm(PEM cũ)` (L65 emergency / L73 normal) → `writeState(next)` (L76). Nếu `writeState` lỗi (disk full/EPERM) ⇒ `keys.json` vẫn trỏ `active = old.kid` nhưng PEM cũ đã mất ⇒ `getSigningKey()` (L37–44) ném `ENOENT` ⇒ **mọi lần ký token 500** cho tới khi sửa tay. Thêm: `writeState` (L110–112) ghi đè trực tiếp — crash giữa chừng để lại JSON cụt ⇒ `readState` ném `SyntaxError` ⇒ mất cả JWKS. Dev-only (plan D9), nhưng chạy ở mọi môi trường `KEY_PROVIDER=local`.
- **Repro**: unit `keys.spec.ts` (đã có `mkdtemp`): `init()`; `jest.spyOn(provider as any, 'writeState').mockRejectedValueOnce(new Error('ENOSPC'))`; `await expect(provider.rotate('normal', 60)).rejects.toThrow()`; rồi `provider.getSigningKey()` ⇒ hiện tại ném ENOENT.
- **Acceptance (đo được)**:
  - RED→GREEN unit (cả `normal` và `emergency`): sau `rotate` thất bại ở bước ghi state, `getSigningKey()` vẫn trả **kid cũ** và ký được; `getPublicKeys()` vẫn chứa kid cũ.
  - `writeState` atomic: ghi `keys.json.tmp` (mode 0o600) rồi `rename` sang `keys.json`. Test: spy `rename` (hoặc chặn) ném ⇒ `keys.json` cũ còn nguyên, parse được.
  - Thứ tự mới: `createKey` → `writeState(next)` → **sau đó** `rm` PEM cũ (best-effort). Nếu `rm` lỗi: rotate vẫn thành công (state đúng), log warn; test: spy `rm` ném ⇒ `rotate` resolve, `getSigningKey()` trả kid mới.
  - Dọn rác: `rotate` (hoặc `init`) xoá mọi `*.pem` có kid không phải `active` trong state (thu PEM mồ côi từ lần lỗi trước). Test: tạo sẵn `<uuid>.pem` lạ ⇒ sau `rotate` không còn.
  - Case hiện có ở `keys.spec.ts` (L300–350: normal giữ public JWK, emergency xoá hết) giữ xanh. Full suite ≥ 555 + mới.
- **Security invariants**:
  - Tài sản: private key ký token (INV-19). Actor: operator/admin gọi rotate; lỗi FS.
  - Invariant: tại mọi thời điểm, `keys.json` trỏ `active` tới một PEM tồn tại; private key của kid đã retiring/emergency-dropped không còn trên đĩa **sau khi** state mới đã bền (PEM mồ côi có thể tồn tại tạm khi `rm` lỗi ⇒ bị dọn ở lần rotate/init sau). Emergency: chấp nhận rủi ro PEM cũ còn tạm trên đĩa nếu `rm` lỗi — PHẢI log error (không im lặng) vì emergency nghĩa là key bị lộ.
  - Failure: lỗi ghi state ⇒ fail-closed cho rotate (ném), nhưng key cũ vẫn ký được (không DoS). PEM mới tạo nhưng không vào state ⇒ là mồ côi, bị dọn.
  - Exposure: không log nội dung PEM/đường dẫn private ngoài kid.
- **Phụ thuộc**: không. § trỏ: spec §6.4, §15 (INV-19); plan D9, B7.3.

### [x] Task 4 [BE]: DEBT-021 — `rotateSecret` không atomic + version có thể trùng (kể cả không concurrent)

> **(tech-lead fold)**: `createSecret` (L63) cứng `version: 1` ⇒ sau index unique, gọi lần 2 trên cùng client sẽ E11000. `test/introspect.int-spec.ts:245/327/338/365/379/441` gọi `createSecret(TOKEN_CLIENT)` nhiều lần cùng DB ⇒ **sẽ vỡ**. Sửa: `createSecret` và `rotateSecret` dùng chung helper `insertNextVersion(clientId, secretHash)` = `findOne({clientId}).sort({version:-1})` + 1, insert, E11000 ⇒ tính lại + retry đúng 1 lần, lần 2 ném (D7). `createSecret` vẫn không bắt đầu grace (giữ ngữ nghĩa). Acceptance thêm: `createSecret` 2 lần trên cùng client ⇒ v1, v2, cả hai secret authenticate được; introspect.int-spec giữ xanh không sửa test. Concurrent test (`clients.int-spec.ts:385`) assert: 2 version khác nhau, cả hai authenticate được.
- **Bằng chứng (code thật)**:
  - `be/src/modules/clients/client-credential.service.ts:71–89`: `nextVersion = max(version của listActive) + 1`. `listActive` (L123–131) lọc `revokedAt:null` + chưa hết hạn ⇒ **lỗi tuần tự, không cần race**: v1 active, rotate ⇒ v2; `revokeSecret(c, 2)` ⇒ active=[v1] ⇒ rotate lần nữa ⇒ **v2 lần nữa** (trùng doc v2 đã revoke). Tương tự khi version mới nhất đã hết hạn. Hậu quả: `revokeSecret(clientId, 2)` (`updateOne {version, revokedAt:null}`) nhắm vào version "2" mơ hồ; audit/admin theo version sai.
  - Concurrent: 2 `rotateSecret` cùng lúc đọc cùng snapshot ⇒ cùng `nextVersion`. Index `client-credential.schema.ts:12` `{clientId:1, version:1}` **không unique** ⇒ cả hai insert thành công. Test `test/clients.int-spec.ts:378–410` đang **khẳng định hành vi lỗi** này (comment ghi rõ cần đổi khi fix).
- **Acceptance (đo được)**:
  - RED→GREEN int (sequential): createSecret ⇒ v1; rotate ⇒ v2; revokeSecret(v2); rotate ⇒ **v3** (không phải v2); `countDocuments({clientId, version:2}) === 1`.
  - RED→GREEN int (expired): version mới nhất đã hết hạn ⇒ rotate cho version = max(tất cả) + 1.
  - `nextVersion` tính từ **mọi** credential của client (`findOne({clientId}).sort({version:-1})`), không chỉ active.
  - Index đổi thành `{clientId:1, version:1}, {unique:true}`. Int `indexes.int-spec.ts`: index tồn tại với `unique:true`; insert trùng `(clientId, version)` ⇒ E11000.
  - Concurrent: sửa test `clients.int-spec.ts:385` theo đúng chỉ dẫn trong comment của nó — 2 rotate đồng thời ⇒ hoặc (đề xuất) cả hai thành công với **version khác nhau** nhờ retry đúng 1 lần khi E11000 (tính lại `nextVersion`), hoặc đúng một bị từ chối với lỗi domain rõ ràng. Assert: không tồn tại 2 doc trùng `(clientId, version)`; mỗi secret được trả về authenticate được; không có secret nào bị trả về mà không được lưu.
  - Retry vẫn E11000 lần 2 ⇒ ném lỗi (không nuốt, không vòng lặp vô hạn).
  - Full suite ≥ 555 + mới (test concurrent sửa, không xoá).
- **Ghi chú không-atomic còn lại (ghi comment, không sửa)**: `create` rồi `updateMany` (grace) không trong transaction. Nếu `updateMany` lỗi: ném lỗi cho caller, secret mới **không** được trả về (mồ côi vô hại vì không ai biết giá trị), version cũ chưa bắt đầu grace (vẫn hợp lệ như trước rotate — không xấu hơn trạng thái trước). Transaction Mongo (rs0 sẵn) để admin API thật (B6.3).
- **Security invariants**:
  - Tài sản: client secret (INV-18), tính định danh version cho revoke/audit (INV-26). Actor: admin/operator (control-plane), 2 admin đồng thời.
  - Invariant: `(clientId, version)` là duy nhất; `revokeSecret(c, v)` tác động đúng một credential xác định; secret thô chỉ trả về khi doc đã insert thành công, không bao giờ log/persist thô.
  - Failure/race: E11000 ⇒ retry 1 lần ⇒ hết thì fail-closed (ném). Không trả secret cho insert thất bại.
  - Migration: index cũ non-unique cùng key ⇒ `syncIndexes` sẽ drop rồi build lại unique (mongoose `model.js:1351–1353`: `cleanIndexes` TRƯỚC `createIndexes`). Dữ liệu trùng sẵn có (do race cũ) ⇒ E11000 ⇒ khoảng không index. Runbook bổ sung ở Task 5.
  - Exposure: lỗi domain không chứa secret/hash.
- **Phụ thuộc**: không (Task 5 phụ thuộc task này cho phần runbook). § trỏ: spec §9.3, §10 (MongoDB index), §15 (INV-18, INV-26); plan B6.3.

### [x] Task 5 [BE]: DEBT-053 + DEBT-061 — sửa spec.md §11, runbook §2b phục hồi khi `syncIndexes` lỗi (+ ponytail rẻ của DEBT-053)

> **(tech-lead fold)**: văn bản §11 theo bản chốt T2: `/token`: "`...; rate limit client auth theo lần thất bại (IP và client_id+IP, chung bucket với /revoke, /introspect), kiểm trước verify secret (429 temporarily_unavailable + Retry-After)`"; `/introspect`: "`...; chung rate limit client auth với /token`". Runbook-deploy thêm mục `TRUST_PROXY` (đặt đúng IP/CIDR reverse proxy; không bao giờ `true`; thiếu ⇒ rate limit theo IP proxy = giới hạn toàn cục). Dòng `/introspect` trùng hiện ở spec **L462** (không phải L461).
- **Bằng chứng**:
  - spec.md §11: `/introspect` xuất hiện **2 lần** — L449 (bản mới, đầy đủ liveness) và L461 (bản cũ "kiểm tra token hợp lệ real-time (RFC 7662) cho resource server cần"). Nhãn "(Task 3)" ở inv. 29 (§15, L593) **đã không còn** (grep `Task` trong spec.md = 0) ⇒ phần đó của DEBT-053 đã xong, chỉ cần xác nhận.
  - runbook §2b ghi "`syncAllIndexes` fail-closed: ném lỗi, **không** xoá doc nào" — đúng về dữ liệu nhưng **thiếu trạng thái index**: mongoose 9.10.2 `Model.syncIndexes` (`node_modules/mongoose/lib/model.js:1351–1353`) gọi `cleanIndexes` (drop `userId_1_clientId_1`) TRƯỚC `createIndexes` ⇒ build lỗi E11000 ⇒ collection `consents` **không còn unique index nào**; app đang chạy có thể ghi duplicate tiếp trong khoảng này. Ngoài ra `syncAllIndexes` (`be/src/database/mongo/sync-indexes.ts:12–15`) dừng ở model lỗi ⇒ các model sau trong `MODELS` chưa được sync.
- **Văn bản đề xuất (dev áp nguyên văn, chỉnh nhỏ được)**:
  - spec.md §11: **xoá** dòng `| \`/introspect\` | POST | kiểm tra token hợp lệ real-time (RFC 7662) cho resource server cần |` (dòng cuối bảng). Đồng thời thêm rate limit (từ Task 2) vào 2 dòng còn lại:
    - `/token`: `... atomic rotation (hash-based) cho refresh token; rate limit client auth theo IP và client_id+IP trước khi verify secret (429 + Retry-After)`
    - `/introspect`: `... refresh: family còn active); rate limit client auth riêng (429 + Retry-After)`
  - runbook-deploy.md — thêm cuối §2b:
    ```markdown
    #### Nếu `db:sync-indexes` đã chạy và FAIL E11000 (phục hồi)

    `syncIndexes()` (mongoose 9) **drop index cũ TRƯỚC** khi build index mới. Khi build lỗi:

    - `consents` **không còn unique index nào** (`userId_1_clientId_1` đã drop, `userId_1_clientId_1_resource_1` chưa có) — kiểm bằng `db.consents.getIndexes()` (chỉ còn `_id_`).
    - Các model đứng SAU `Consent` trong `be/src/database/mongo/models.ts` **chưa được sync**.
    - Không doc nào bị xoá.

    Phục hồi (theo thứ tự, không bỏ bước):
    1. **Không rollout** tiến trình ứng dụng mới; nếu bản cũ đang chạy, giữ nhưng coi khoảng này là có thể phát sinh duplicate mới.
    2. Chạy lại truy vấn 2b, hợp nhất thủ công các nhóm `count > 1` (như trên).
    3. Chạy lại 2b ⇒ phải rỗng (nếu không, lặp bước 2 — app cũ có thể vừa ghi thêm).
    4. `pnpm --filter be db:sync-indexes` ⇒ exit 0.
    5. Xác minh 2c. Chỉ khi 2c đúng mới sang bước 5–6 của §4.
    ```
  - runbook-deploy.md — thêm mục mới `## 2d. Index unique \`ClientCredential {clientId, version}\` (DEBT-021)`:
    ~~~markdown
    Run 20 đổi `{clientId:1, version:1}` thành **unique**. `syncIndexes` sẽ drop index non-unique cùng tên rồi build unique.
    Kiểm duplicate TRƯỚC khi sync:

    ```js
    db.clientcredentials.aggregate([
      { $group: { _id: { clientId: '$clientId', version: '$version' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    ```

    - Rỗng ⇒ sync. Có nhóm ⇒ DỪNG: với mỗi nhóm, đánh số lại version cho doc tạo sau (`version = max + 1`) hoặc revoke doc dư nếu là secret không ai dùng. KHÔNG xoá credential đang hợp lệ khi chưa xác nhận với chủ client.
    - Nếu sync đã FAIL: `clientcredentials` mất index `{clientId, version}` (chỉ ảnh hưởng hiệu năng `verifySecret` + cho phép trùng tạm) ⇒ dọn rồi sync lại như mục phục hồi ở 2b. Lưu ý `ClientCredential` đứng TRƯỚC `Consent` trong `models.ts` ⇒ lỗi ở đây làm `Consent` và các model sau chưa được sync.
    ~~~
    (Collection mặc định của model `ClientCredential` là `clientcredentials`; dev xác minh bằng `db.getCollectionNames()`.)
  - runbook §4 "Thứ tự deploy": chèn sau bước 2: `2'. Kiểm duplicate ClientCredential (2d) — rỗng mới tiếp.`
- **Ponytail rẻ của DEBT-053 (code, an toàn, không đổi hành vi)**:
  - `introspect.controller.ts:170` và `userinfo.controller.ts:114`: thay `{ isEnded: (ref) => this.sessions.isEnded(ref) }` bằng `this.sessions` (đủ kiểu structural theo `access-token-liveness.ts:25`). Lưu ý `this`-binding: `isAccessTokenLive` gọi `sessions.isEnded(...)` dạng method (L69) ⇒ an toàn.
  - `logout.service.ts:26/37`: hằng `DEFAULT_REDIRECT` + field `defaultRedirect` song song — giữ một nguồn (field đọc hằng là chấp nhận được; chỉ xoá nếu không cần cho `ui.controller.ts:149/239/318`). Rút comment lặp nếu thấy.
  - **KHÔNG** gộp DEBT-062/069 ở run này (≈ -50 dòng, đụng nhiều file đang sửa ở T1/T2 ⇒ rủi ro xung đột) — đề xuất run kế.
- **Acceptance (đo được)**:
  - `grep -c '| \`/introspect\`' docs/agile/sso-idp/spec.md` = **1**; `grep -c 'Task' spec.md` = 0.
  - runbook có mục "phục hồi" ghi đủ 3 trạng thái (không unique index, model sau chưa sync, không xoá doc) + 5 bước; có mục 2d + §4 cập nhật.
  - Int `indexes.int-spec.ts` case "fails closed..." (L144) thêm assertion chứng minh tài liệu: sau E11000, `consents.indexes()` **không** còn index unique nào ngoài `_id_` (khoá runbook vào hành vi thật; nếu mongoose đổi thứ tự, test đỏ ⇒ cập nhật runbook).
  - Ponytail: full suite giữ nguyên số test, xanh; typecheck + lint 0 lỗi; diff code ≤ ~15 dòng.
  - File UTF-8 không BOM.
- **Security invariants**: Tài sản: tính duy nhất consent (Q1, INV liên quan consent §9.4) và credential version. Actor: operator deploy. Invariant: runbook không bao giờ hướng dẫn xoá dữ liệu tự động; mọi bước fail-closed (dừng rollout). Failure: khoảng không-unique được ghi rõ thay vì ẩn. Exposure: lệnh mẫu không chứa secret/URI thật. Ponytail: N/A (không đổi hành vi, chỉ đổi cách truyền dependency).
- **Phụ thuộc**: Task 2 (văn bản §11 rate limit), Task 4 (mục 2d). § trỏ: spec §10, §11; runbook §2, §4.

---

## Quyết định mở (tech-lead chốt trước khi dev làm Task 2/4)

> **(tech-lead fold — retry 1)**: D1 bước 1–2 thay bằng **reserve-then-refund atomic** (1 Lua, 2 khoá cùng hash tag `{sha256(ip)}`, reserve trước `findByClientId`, refund khi thành công, refund lỗi ⇒ warn + vẫn 200). Huỷ câu "burst vượt ngưỡng tối đa = độ song song của attacker — chấp nhận" (sai, senior 🔴1). `TRUST_PROXY`: từ chối prefix < 8 (v4/v6), IPv4-mapped < /104, hop > 10.

> **(tech-lead fold) — ĐÃ CHỐT**: D1 failure-only (`peek` trước Argon2, `hit` khi `invalid_client`; không đếm thành công/429; bỏ qua `none`) · D2 `CLIENT_AUTH_FAIL_IP_MAX=30`, `CLIENT_AUTH_FAIL_CLIENT_MAX=10` · D3 `RateLimitService` gọi trong `ClientAuthenticationService` (ctx ip bắt buộc) · D4 đồng ý · D5 fail-closed 500 · D6 một bucket chung cho cả 3 endpoint · D7 retry 1 lần, áp cả `createSecret`. **DEBT-006 đưa vào T2 (bước 0)**. Bảng dưới là đề xuất gốc của analyst, giữ để tham chiếu.

| # | Câu hỏi | Đề xuất an toàn | Phương án khác / tradeoff |
|---|---|---|---|
| D1 | Khoá rate-limit `/token`/`/introspect` | 2 bucket: theo IP + theo `client_id\|IP`; `client_id` lấy từ `resolveClientAuth` (Basic hoặc body, sau khi đã từ chối Basic≠body), đếm **trước** Argon2 | Chỉ `client_id` ⇒ attacker khoá được client hợp lệ (DoS). Chỉ IP ⇒ không phân biệt client sau NAT. Đếm chỉ lần **thất bại** (peek trước, INCR khi `invalid_client`) ⇒ không phạt traffic hợp lệ, nhưng cần API mới `peek()` cho `RateLimitService` + vẫn phải chặn DoS bằng bucket IP — để run sau nếu traffic thật bị 429 |
| D2 | Ngưỡng | env, mặc định: client-auth IP 300 / client\|IP 60; introspect IP 600 / client\|IP 300; cửa sổ `RATE_LIMIT_WINDOW`=60s | Dùng chung `RATE_LIMIT_MAX`=100 ⇒ quá thấp cho RP backend refresh nhiều user hoặc RS introspect mỗi request |
| D3 | Dùng `RateLimitService` hiện có hay guard `@RateLimit` | Gọi `RateLimitService.hit()` trực tiếp trong controller (guard không thấy `client_id` trong Basic) | Mở rộng guard với extractor tuỳ biến — thêm trừu tượng không cần |
| D4 | Body 429 | `{error:'temporarily_unavailable'}` + `Retry-After` + `no-store` | RFC 6749 §5.2 không có mã cho 429; `invalid_request` gây hiểu nhầm; `slow_down` thuộc device flow |
| D5 | Redis lỗi khi rate-limit | Fail-closed 500 (nhất quán §6.2) | Fail-open ⇒ mất bảo vệ Argon2 đúng lúc hệ thống yếu |
| D6 | `/revoke` có nằm trong phạm vi | Có — dùng chung `authenticateClient` nên miễn phí, chung bucket `/token` | Loại ra ⇒ `/revoke` thành đường vòng brute-force/DoS |
| D7 | DEBT-021 khi E11000 concurrent | Retry đúng 1 lần (tính lại version) | Từ chối ngay với lỗi domain (đơn giản hơn, admin tự thử lại) |

## Đề xuất run kế (không vừa run 20)

| DEBT | Lý do hoãn |
|---|---|
| DEBT-062 + DEBT-069 | Ponytail ≈ -50 dòng ở `token.controller`/`ui.controller`/`consent.service` — đụng file T1/T2 đang sửa; làm sau khi run 20 merge |
| DEBT-006 | `trustProxy` — ảnh hưởng hiệu lực bucket IP của Task 2 sau reverse proxy; thuộc deploy B7.x, nên làm trước khi bật production |
| DEBT-070 / DEBT-054 | Preflight cổng test-infra — không phải lỗi sản phẩm |
| Rate-limit chỉ-đếm-thất-bại (D1 phương án khác) | Chỉ khi traffic thật bị 429 oan |