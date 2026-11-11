# Senior Review — 2026-11-11 (run 85, T1–T5)

## Kết luận: PASS

Không có 🔴. 4 mục 🟡 ⇒ DEBT-596…599 trong `backlog.md`. Chuyển **tester** (T6).

Đã kiểm: `git diff` + file untracked trên `develop` (HEAD `78724b7`, chưa commit). Chạy lại có mục tiêu `pnpm -C be test:int run85` (vg-test-mongo@27117 / vg-test-redis@6479): 4 suite, 41/41 xanh. `git ls-remote` cho 5 tag action đều khớp SHA đã pin (codeql: tag object `f3bbb05…` ⇒ `^{}` = `33d7b85…`, đúng commit đã peel). Lệnh grep kiểm pin ra rỗng (23 dòng `uses:`, tính cả `audit.yml` và job `sbom`). Chạy thử `pnpm --filter @sso-idp/be sbom … --out sbom-be.cdx.json` ở gốc repo: file ra ở gốc, không ở `be/`, nên bước "Check SBOM" đọc đúng đường dẫn (file thử đã xoá).

## Tổng quan

Lô làm gọn và đúng hợp đồng fold. Điểm tốt:
- T4 dùng lại `RateLimitService.reserve` (Lua check-all-then-INCR), nên Argon2 ≤ N dưới concurrency mà không thêm Lua. Mọi khoá đều có hash-tag email. Thứ tự là lookup ⇒ trust ⇒ reserve ⇒ Argon2 ⇒ recheck ⇒ session ⇒ trust write. Trust chỉ ghi sau khi session đã được tạo. Lỗi Redis ở ZSCORE hoặc reserve thì propagate (fail-closed, có ca (8)/(8b)). Lỗi khi ghi trust chỉ trả `false` (fail-safe).
- Chống enumeration: email không tồn tại đi cùng N/A, cùng câu 429 cố định, cùng `Retry-After`. Ca (4) so body và header.
- T5 làm đúng thứ tự reserve ⇒ verify ⇒ policy ⇒ CAS trên hash đã verify (lọc cả lock) ⇒ revoke ⇒ refund ⇒ audit ⇒ mail. Có test spy chứng minh revoke chạy sau CAS (ca (6)). Thư không có token, đi qua guard `SmtpMailer`.
- T2: kiểm `request`/`request_uri` nằm **sau** `isRegisteredRedirectUri`, trong `try` của Phase 2, nên không mở open redirect (ca (5)). `state` lặp không bị echo (catch chỉ gắn `state` kiểu string).
- T3: tập mật khẩu nạp lúc import module (fail-closed khi boot). Script dẫn xuất chỉ dùng stdlib. Assets nest đã có `*.txt`, Dockerfile copy `be/dist`, không có `.dockerignore` chặn.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| Bucket key: email đã normalize nhất quán với lookup | ✅ | `ui.controller.ts:293` `normalizeEmail(body.email)`; `findByEmailForAuthentication` dùng cùng hàm; federation `pending.email` đã normalize (`federation.service.ts:181/361`) |
| Race reserve ↔ verify | ✅ | Lua `RESERVE_SCRIPT` kiểm hết rồi mới INCR; ca (5) 10 song song ⇒ đúng 5 Argon2, 5×429, 1 audit (`SET NX`) |
| Thiết bị kẻ tấn công không xoá được bucket N của nạn nhân | ✅ | `DEL N` chỉ chạy khi đăng nhập đúng mật khẩu nạn nhân |
| 429 vs 401 không tạo oracle | ✅ có lưu ý | Cùng ngưỡng, cùng câu, cùng header cho email có và không có. Lệch thời gian nhỏ: xem 🟡 S2 |
| Cookie `__Host-idp_dc` | ✅ | `HttpOnly; Secure (theo cookieSecure); SameSite=Lax; Path=/; Max-Age=7776000`, không `Domain`; ca (10) |
| Trust chỉ cấp sau khi đăng nhập thành công, gắn với user | ✅ | `authentication.service.ts:231-235` (sau session + audit), ZSET theo `sha256(userId)`; ca (3) chặn cookie dùng chéo user và cookie bịa |
| Fail-closed khi Redis lỗi | ✅ | ZSCORE/reserve/MGET/SET NX đều propagate; ca (8)/(8b): 5xx, 0 Argon2, không có cookie phiên |
| Revoke xoá trust | ✅ | `forgetDevices` best-effort, chạy cả khi một bước trước đó lỗi (runStep nuốt lỗi, first-error-wins giữ nguyên); ca (7), T5 (5) |
| T5 CSRF | ✅ | `@UseGuards(CsrfGuard)` chạy trước pipe/handler; identity = cookie phiên; ca (1)/(1b) |
| T5 CAS + thứ tự revoke | ✅ | `user.service.ts` `findOneAndUpdate({_id, passwordHash: oldHash, lockedUntil ≯ now})`; ca (6)/(7) ⇒ 409, không revoke |
| T5 mail không lộ | ✅ | `passwordChangedMessage` chỉ có thời điểm + `/forgot`, HTML escape; test (5) kiểm không có `token=`/`#token` |
| T2 thứ tự lỗi so với open redirect | ✅ | `authorize.service.ts:233-248` sau Phase 1; ca (5) |
| `/userinfo` POST không đọc body | ✅ | `handle()` chỉ gọi `bearerToken(req)`; ca (8)/(7b) |
| T3 boot fail-closed + NFKC | ✅ | `password-policy.ts:39`; so trên `normalize('NFKC').toLowerCase()`; file 10 000 dòng |
| Pin action theo commit đã peel | ✅ | `git ls-remote` khớp 5/5 |

**DEBT-595** (`/auth/link` giữ chiều `account` của limiter `login`): **chấp nhận được**. Bucket `rl:login:account:<email>` giờ chỉ `/auth/link` ghi. Để làm nó đầy, kẻ tấn công cần một pending link cho email nạn nhân, nghĩa là tài khoản ở IdP upstream có email đã xác minh trùng email nạn nhân, và mỗi link chỉ dùng được một lần, phải đi lại một vòng federation. Hậu quả chỉ là chặn bước liên kết, không chặn `/login`. Việc đoán mật khẩu ở đường link vẫn chịu N/A, vì `completeLink` gọi `auth.login`. Giữ 💭 như backend-dev đề xuất, quyết ở run 86–87.

## 🟡 Nên sửa

1. 🟡 **Không xoay device token khi đăng nhập** (DEBT-596)
   `login-throttle.service.ts:121-123` `deviceTokenFor(presented)` dùng lại cookie đã có, kể cả cookie chưa từng được tin cậy cho user này.
   Vì sao: (a) chế độ `SESSION_COOKIE_SECURE=false` dùng tên `idp_dc` không có prefix `__Host-`. Subdomain anh em ghi được cookie này (cookie fixation). Nạn nhân đăng nhập xong, giá trị do kẻ tấn công chọn trở thành tin cậy, và kẻ đó được đi đường D (10/15' không chịu A). (b) Cookie từng bị lộ, sau reset (ZSET đã xoá) sẽ được tin cậy lại ngay lần đăng nhập kế tiếp trên cùng trình duyệt, vì giá trị không đổi.
   Đề xuất: luôn `generateToken()` khi đăng nhập thành công. Response đằng nào cũng có `Set-Cookie`, ZSET giữ tối đa 20 phần tử nên hash cũ tự rơi ra. Có thể `ZREM` hash cũ trong cùng `MULTI`. Hợp đồng D85.2 ("dùng lại giá trị cũ") cần tech-lead đổi.

2. 🟡 **Lệch thời gian ở đường quyết định trust** (DEBT-597)
   `login-throttle.service.ts:133`: ZSCORE chỉ chạy khi `userId && deviceToken`. Kẻ tấn công gửi cookie đúng dạng bất kỳ: email có thật tốn thêm 1 round-trip Redis, email không tồn tại thì không. Khi đã bị throttle (không có Argon2 để che), mỗi request rẻ và chỉ bị limiter chung chặn (ip/device 100/60 s, xoay IP/cookie là qua). Lấy thống kê trên nhiều request thì có thể dò ra email có tồn tại.
   Vì sao: phần còn lại của luồng đã cố ý cân bằng (DUMMY_HASH, cùng ngưỡng/câu).
   Đề xuất: có cookie đúng dạng thì luôn ZSCORE, dùng `userId ?? 'absent:' + sha256(email)` (key không bao giờ tồn tại). Sửa 1 dòng, không đổi hợp đồng.

3. 🟡 **NOTICE không đi vào build/image** (DEBT-598)
   `be/nest-cli.json:7` chỉ copy `password-policy/*.txt`.
   Vì sao: image được phát hành có chứa dữ liệu dẫn xuất từ SecLists (MIT, yêu cầu kèm notice) và danh sách NCSC/HIBP (CC BY 4.0, yêu cầu ghi công khi chia sẻ bản chuyển thể). Ghi công hiện chỉ nằm trong repo.
   Đề xuất: thêm `"modules/authentication/password-policy/*.NOTICE.md"` vào assets. Kiểm bằng `test -s be/dist/…/common-passwords.NOTICE.md`.

4. 🟡 **`networkOf` tự parse IPv6 trong khi `ipaddr.js` đã là dependency** (DEBT-599, ponytail)
   `login-throttle.service.ts:50-76` có khoảng 25 dòng tự mở rộng `::`, tự xử lý dạng mapped hex và zone. `ipaddr.js` 2.5.0 đã có trong `be/package.json` và đang dùng ở `config/trust-proxy.ts`. Đây cũng là thư viện `proxy-addr` dùng để tính `req.ip`.
   Vì sao: tự parse dễ lệch với cách `req.ip` được chuẩn hoá (dạng có IPv4 nhúng không phải mapped, zone). Dùng chung một thư viện thì phân loại nhất quán.
   Đề xuất: `ipaddr.isValid(raw) ? ipaddr.process(raw) : null`; `kind()==='ipv4'` ⇒ `toString()`, còn lại ⇒ `toNormalizedString().split(':').slice(0,4).join(':')`; null ⇒ `'unknown'`. Bảng unit hiện có giữ nguyên làm hồi quy.

## 💭 Nit

- `be/src/database/seed-dev.ts:142`: comment còn nhắc `AuthenticationService.validatePassword`, hàm này đã bị xoá. Nên trỏ sang `PASSWORD_LENGTH_MESSAGE`/`assertAcceptablePassword` (seed vẫn chỉ kiểm độ dài, đúng D85.4).
- `login-throttle.service.ts:190-191`: `onSuccess` dựa vào vị trí `keys[0]`/`keys[1]`. Dễ vỡ nếu sau này đổi thứ tự bucket. Lấy theo `scope` (`find(k => k.scope !== 'account')`, `find(k => k.scope === 'account')`) thì tự mô tả.
- Race hẹp: một login có mật khẩu cũ đang chạy dở, hoàn tất sau `forgetDevices` của reset hoặc đổi mật khẩu, thì `ZADD` lại thiết bị. Hậu quả chỉ là kẻ đó được đường D (không chịu A) cho mật khẩu mới mà hắn không biết, không chiếm được tài khoản. Nếu làm S1 thì có thể ghi kèm "trust epoch" theo user. Không mở debt riêng.

## ✂️ Ponytail

- be/src/modules/authentication/login-throttle.service.ts:L50: native: tự mở rộng IPv6 + nhánh mapped-hex. Thay bằng `ipaddr.process()` + `toNormalizedString()` (dependency đã có).
- be/src/modules/authentication/login-throttle.service.ts:L121: shrink: method `deviceTokenFor` chỉ có một dòng. Inline `generateToken()` ở `authentication.service.ts:232` (nếu làm S1), hoặc `context.deviceToken ?? generateToken()`.

net: -22 lines possible.
