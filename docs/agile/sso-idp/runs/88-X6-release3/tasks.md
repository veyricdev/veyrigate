# Run 88 — X6 đợt 3: các ❌ P1 còn lại trước ký duyệt (M8)

Nguồn: `release-checklist.md` (❌ P1: D-16, C-7.5.2, C-10.7b, C-6.3.3), backlog DEBT-164/582/586/579 + consent self-service. Analyst bỏ qua. Tech-lead fold trên code sau `6e68a1f` và **chia lô** (có thể tách run 88/89/90); pentest + ký duyệt mục F (D-14) là bước cuối.

Ràng buộc hạ tầng (người dùng, 2026-11-12): không tạo container mới; dùng `veyrigate-mongo`/`veyrigate-redis` với DB/Redis db riêng; không đụng `sso-idp` / `sso-idp-e2e`.

## Ứng viên (orchestrator)

- T1 [BE/ops] DEBT-164 / D-16 — bootstrap production ⇒ **run 88 T1**.
- T2 [BE+UI] DEBT-582 (+DEBT-586) / C-7.5.2 — trang phiên của tôi ⇒ **run 88 T2**.
- T3 [BE+UI] C-10.7b — consent self-service ⇒ **run 88 T3**.
- T4 [BE+UI] DEBT-579 / C-6.3.3 — MFA ⇒ **run 89** (phạm vi chốt D88.23–D88.29).
- T5 [QA] pentest ⇒ **run 90** (cách làm chốt D88.30).
- T6 [user] ký duyệt mục F (D-14) ⇒ **run 90**.

## Task (run 88)

- [x] **T1 [BE/ops] DEBT-164 + DEBT-165 / D-16** — CLI `db:bootstrap` (resource `admin`, client `fe-admin` từ env, secret in một lần, transaction chống chạy song song, chạy trong image production) + runbook-deploy §16 — backend-dev.
- [x] **T2 [BE+UI] DEBT-582 + DEBT-586 / C-7.5.2** — `/account/sessions`: liệt kê phiên + thiết bị tin cậy, huỷ một / mọi phiên khác sau xác thực lại, quên thiết bị — backend-dev.
- [x] **T3 [BE+UI] DEBT-581 / C-10.7b** — màn consent có origin + mô tả scope + thời hạn; `/account/apps` xem/thu hồi consent — backend-dev.
- [x] **T4 [QA]** — E2E `account-self-service.spec.ts`, lượt tay runbook §16, gate đầy đủ, checklist C-7.5.2/C-10.7b/D-16 ⇒ ✅ — tester.

Thứ tự **T1 → T2 → T3 → T4** (T1 độc lập; T2 và T3 cùng sửa controller account và trang `/` nên tuần tự). Nếu trễ: T1 và T2 bắt buộc; T3 dời sang đầu run 89.

## Fold tech-lead (2026-11-12)

Đã kiểm trên `develop` HEAD `6e68a1f` (CodeGraph 600 file đã index + đọc đích). Kết luận: **PASS** (xem `review-techlead.md`). Người dùng ủy quyền tự quyết theo tiêu chí "dùng được cho production" ⇒ mọi điểm mở chốt thành **D88.x** dưới đây; orchestrator chép vào `plan.md` §12 khi đóng run.

### Chia lô (D88.1)

| Run | Nội dung | Lane | Gate |
|---|---|---|---|
| **88 `88-X6-release3`** (fold đầy đủ dưới) | T1 bootstrap production (D-16, DEBT-164 + DEBT-165) → T2 trang phiên (C-7.5.2, DEBT-582/586) → T3 consent self-service + màn consent rõ (C-10.7b, DEBT-581) → T4 gate | backend-dev ×3, tester | lint/typecheck, be, int FULL, vault, E2E ×2 (+ spec mới), X3 42, fe-admin |
| **89 `89-X6-mfa`** (outline, fold lại đầu run 89) | MFA TOTP + mã khôi phục + bắt buộc cho resource `admin` + reset MFA (C-6.3.3, C-6.4b, C-6.5, DEBT-579) + DEBT-334 (phiên/danh tính trong admin) | backend-dev, frontend-dev (fe-admin), tester | như 88 + E2E admin đi qua TOTP |
| **90 `90-X6-pentest-signoff`** (outline) | Pentest scripted + thủ công (ASVS 5.0 L2 / RFC 9700), sửa P0/P1 phát hiện, đếm lại checklist, ký mục F (D-14) | tester, backend-dev (sửa), người dùng (ký) | toàn bộ + biên bản pentest |

Lý do: MFA chạm login, federation, `/authorize`, `/token`, admin API, fe-admin và E2E ⇒ một run riêng, không trộn với ba việc tự phục vụ. Pentest phải chạy trên bề mặt cuối cùng (đã có MFA) nên đặt sau cùng; ký F chỉ sau pentest. T1–T3 không phụ thuộc MFA: trang phiên/consent chỉ thêm nhãn `amr` ở run 89.

### Phát hiện khi kiểm code

1. **Sẵn có nhưng chưa nối**: `SessionService.listByUser` và `revokeByDevice` (`be/src/modules/sessions/session.service.ts:212,237`) đã có, kiểm chủ sở hữu (index + `userId`), `revokeRef` ghi tombstone — **nhưng không ai gọi**, và `revokeByDevice` không thu hồi refresh family gắn `sessionRef`. Trang phiên phải dùng đúng trình tự 3 bước của local logout (`ui.controller.ts:497-522`: `revokeForSession` → xoá phiên + tombstone → sweep), không chỉ gọi `revokeByDevice`.
2. **Phiên không có nhãn thiết bị**: `AuthenticationService.login` nhận `deviceLabel` nhưng `UiController.loginPost` (`ui.controller.ts:315`) và federation không truyền ⇒ `device: {}` ở mọi phiên.
3. **Thiết bị tin cậy chỉ có hash + thời điểm**: ZSET `dc:{u:sha256(userId)}`, member = `sha256(deviceToken)`, score = lúc tin cậy (`login-throttle.service.ts:197-209,265`); không metadata, không gắn với phiên.
4. **Consent**: `ConsentService.revokeById` bắt buộc filter `clientIds` (tenant của admin); không có đường "của chính user". `views/consent.eta` chỉ có `clientId`, resource, scope; không thời hạn, không nơi app nhận kết quả, không link quản lý. `Client` không có `displayName`.
5. **Bootstrap**: `seedBootstrap` (`seed.ts`) chặn `assertDevOrTestEnv`, redirect `localhost:3000` cứng, tạo user + super_admin + gọi `seedDev`; `createSecret`/`insertNextVersion` không khoá ⇒ 2 tiến trình song song cấp được v1 và v2 (2 secret, DEBT-164). `envSchema` vẫn **bắt buộc** `ADMIN_SEED_EMAIL` (`validation.schema.ts:133`) ⇒ env production phải chứa một email vô nghĩa (DEBT-165), mà bootstrap/`admin-recover` dùng `validateEnv` đầy đủ.
6. **MFA**: `User.mfaSecret` là placeholder; `amr` chảy session → code → ID token (`token.service.ts:129,334`); access token admin chỉ mang `auth_time`, không `amr`; refresh family không lưu `amr` ⇒ bắt buộc MFA phải chặn ở **lúc cấp/đổi code** cho resource `admin`, không ở `AdminTokenGuard` (D88.24).
7. **Công cụ pentest có sẵn**: `curl`, `openssl`, `node` (fetch + Playwright của `e2e/`), `python`, `pnpm audit`, CodeQL ở CI. **Không có** ZAP/nmap/nuclei/sqlmap/ffuf/testssl/jq/semgrep/trivy/gitleaks; image local chỉ mongo/redis/vault/mailpit ⇒ pentest viết bằng Node, không tải gì (D88.30).

### Quyết định D88.x (người dùng ủy quyền, tiêu chí production)

- **D88.1 Chia lô**: như bảng trên.

**Bootstrap production (T1)**

- **D88.2 CLI riêng `be/src/database/bootstrap.ts` ⇒ `dist/database/bootstrap.js`, script `db:bootstrap`.** Chạy được mọi `NODE_ENV` kể cả production, dùng env của app (`validateEnv` đầy đủ), cách chạy như `admin-recover`: `docker run --rm -i --env-file <env app> <image> node dist/database/bootstrap.js --operator <id>`. Chỉ bảo đảm: tenant `default-tenant`, resource `admin` (`identifier = adminResourceIdentifier(ISSUER)`, scopes `admin.read admin.write`), client `fe-admin` (confidential, `client_secret_basic`, grant `authorization_code refresh_token`, scopes như seed, `allowedResources ['admin']`, CORS rỗng) và 1 credential active. **Không bao giờ** tạo/sửa user, membership, Redis, key.
- **D88.3 Lõi dùng chung**: tách phần resource/client/re-point checks của `seedBootstrap` thành một hàm (vd. `ensureAdminPlane(connection, opts, session?)`) mà `seed.ts` (dev/test, localhost mặc định, vẫn tạo user + `seedDev`) và `bootstrap.ts` cùng gọi. Hành vi `db:seed` không đổi.
- **D88.4 Env riêng của bootstrap** (zod trong `bootstrap.ts`, KHÔNG vào `envSchema` app): `BOOTSTRAP_FE_ADMIN_REDIRECT_URIS`, `BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS` — danh sách cách nhau dấu phẩy, 1–10 phần tử, mỗi phần tử qua `validateRedirectUriList` với `allowHttpLocalhost = NODE_ENV !== 'production'` (production ⇒ chỉ `https`, cấm cả `http://localhost`). Sai ⇒ exit 1 **trước khi kết nối**, thông điệp không echo giá trị.
- **D88.5 Tham số** (allowlist, lạ ⇒ exit 1, không echo): `--operator <id>` bắt buộc (`^[a-z0-9._-]{2,64}$`); `--ticket <ref>` (mẫu D87.12) bắt buộc khi có `--update-uris` hoặc `--rotate-secret`; `--update-uris`; `--rotate-secret`; `--dry-run` (kiểm tham số + env, in `target: host/db` + kế hoạch URI + `dry-run: no connection made`, exit 0, không kết nối — quy ước DEBT-256).
- **D88.6 Chống chạy song song = một transaction Mongo, không lease.** Toàn bộ ghi chạy trong `session.withTransaction` (snapshot, majority, `maxCommitTimeMS 5000`, như `SuperAdminGuard.runGuarded`); câu đầu tiên là touch `opslocks {_id:'bootstrap'} $inc n` (upsert) ⇒ hai lượt đồng thời write-conflict, driver chạy lại lượt thua trên snapshot mới, lượt đó thấy credential active ⇒ không cấp secret. Secret + hash Argon2 sinh **trước** transaction (callback retry dùng lại); chỉ in **sau commit**. Đã loại lock lease (`expiresAt` + takeover): thêm trạng thái treo và phụ thuộc đồng hồ mà transaction đã giải. Mongo standalone ⇒ exit 1 "requires a replica set", không ghi (production đã bắt buộc rs, run 79).
- **D88.7 Secret in đúng một lần**: khi (và chỉ khi) transaction tạo credential, stdout có đúng 1 dòng `OIDC_CLIENT_SECRET=<secret>` (tên env fe-admin dùng) + 1 dòng "shown once, store it in the fe-admin secret store now". Chạy lại ⇒ `fe-admin secret: unchanged (active credential exists)`. Không ghi file, không log, không vào audit.
- **D88.8 Trôi cấu hình**: `fe-admin` đã có mà URI khác env ⇒ exit **2**, in hai danh sách (URI là cấu hình công khai), không ghi. `--update-uris --ticket` ⇒ `$set` cả hai danh sách trong cùng transaction + audit `REDIRECT_URI_CHANGED` (`actorType:'system'`). Lý do có cờ: domain sai ở lần đầu thì không đăng nhập console được để sửa qua API (gà–trứng).
- **D88.9 `--rotate-secret --ticket`**: trong transaction, `revokedAt = now` mọi credential active của `fe-admin` (không grace — dùng khi secret lần đầu bị mất/lộ) + tạo version mới, in một lần như D88.7. fe-admin phải deploy lại với secret mới (runbook).
- **D88.10 Từ chối** (exit 1, không ghi): resource `admin` trỏ identifier khác; client khác `fe-admin` tham chiếu `admin`; `fe-admin` tồn tại mà không admin-capable (`isAdminCapableClient` false); thiếu index unique cần (`clients.clientId`, `resources.identifier`, `clientcredentials {clientId, version}`) ⇒ "run db:sync-indexes first". Bootstrap **không** tự tạo index (`sync-indexes` có dry-run riêng và xoá audit cũ, runbook-ops §0).
- **D88.11 Audit `ADMIN_BOOTSTRAPPED`** (enum mới, vào `ALERT_ACTIONS`): mỗi lượt chạy thật, **trong** transaction: `actorType:'system'`, `actorId:<operator>`, `tenantId:'default-tenant'`, `targetType:'client'`, `targetId:'fe-admin'`, `metadata:{created:{tenant,resource,client}, secretIssued, secretRotated, urisUpdated, ticket?, host: os.hostname()}` qua `sanitizeMetadata`; không URI có credential, không secret. Thêm dòng JSON `{alert:true, action:'ADMIN_BOOTSTRAPPED', eventId}` ra stdout như D87.12. Insert lỗi ⇒ abort toàn transaction.
- **D88.12 Kết hợp `admin-recover`**: bootstrap chỉ **đọc** số super_admin dùng được (định nghĩa `SuperAdminGuard`) và in `usable super_admins: N`; N = 0 ⇒ in bước kế: người quản trị đầu tiên tự `/register` + xác minh email, rồi `db:admin-recover --email … --requested-by … --approved-by … --ticket …` (D87.12, không đổi). Bootstrap không tạo user: user production phải tự đặt mật khẩu qua luồng có xác minh email, không có mật khẩu bootstrap trong env (đúng tinh thần DEBT-165).
- **D88.13 DEBT-165**: `ADMIN_SEED_EMAIL` trong `envSchema` thành **tuỳ chọn** (vẫn `email()` khi có); `configuration.adminSeed` tuỳ chọn; `seed.ts`/`seed-dev.ts` giữ zod riêng bắt buộc như hiện tại. Không xoá biến khỏi CI/drill/e2e (giảm churn).
- **D88.14 "Chạy trong image production"** như D87.15: (a) local chạy `--dry-run` từ bố cục `pnpm --filter @sso-idp/be deploy --prod` + `be/dist`; (b) `be/scripts/docker-smoke.sh` thêm check `--dry-run` (job `be-image` CI). Runbook-deploy **§16 "Lần triển khai đầu tiên"**: `db:sync-indexes` (dry-run trước) → `db:bootstrap --dry-run` → `db:bootstrap` (chép secret vào secret store fe-admin) → khởi động BE + fe-admin → người quản trị đầu đăng ký + xác minh → `db:admin-recover` → đăng nhập console `prompt=login`; kèm xử lý exit 2 và mất secret (`--rotate-secret`).

**Trang phiên của tôi (T2)**

- **D88.15 Route**: `GET /account/sessions` (cần phiên sống, không thì 302 `/login?returnTo=%2Faccount%2Fsessions`); `POST /account/sessions/revoke` (`ref`), `POST /account/sessions/revoke-others`, `POST /account/devices/forget` (`device`), `POST /account/devices/forget-others`. Mọi POST: `CsrfGuard` (identity = cookie phiên), limiter `this.limit('account_sessions', req, userId)`, PRG `303 /account/sessions?done=<kind>`. Trang có nút "Sign out everywhere" = form `POST /logout?scope=all` sẵn có (không làm lại). `/` thêm link "Your sessions", "Connected apps".
- **D88.16 Hiển thị (exposure)**: mỗi phiên = nhãn thiết bị, phương thức (`pwd` ⇒ "Password", `fed` ⇒ "Google/GitHub sign-in"; run 89 thêm "+ authenticator"), `createdAt`, `lastSeenAt` (UTC ISO), cờ "This browser". **Không** IP, UA thô, email. `ref` chỉ nằm trong `value` input ẩn (định danh công khai một chiều, = `sid`). Tối đa 50 phiên mới nhất theo `lastSeenAt`. Thiết bị tin cậy = "Trusted since <ngày>", cờ "This browser" khi `sha256(cookie thiết bị đang gửi)` trùng member; một câu giải thích: thiết bị tin cậy chỉ miễn giới hạn đăng nhập theo mạng (D85.2), quên nó **không** đăng xuất nó. Không thêm metadata cho thiết bị tin cậy (loại hash `dcm:`: phải đồng bộ prune với ZSET).
- **D88.17 Nhãn thiết bị**: hàm thuần `deviceLabelFromUserAgent(ua)` ⇒ `"<Browser> on <OS>"` chỉ từ allowlist (Browser: Edge, Chrome, Firefox, Safari, Opera, Other; OS: Windows, macOS, iOS, Android, Linux, ChromeOS, Other); không bao giờ lưu/hiện UA thô. Gán lúc tạo phiên ở login mật khẩu **và** federation. Phiên cũ không nhãn ⇒ "Unknown device".
- **D88.18 Xác thực lại trước khi huỷ** (ASVS 5.0 7.5.2: "having authenticated again with at least one factor"): mọi POST huỷ/quên hợp lệ khi **(a)** `session.authTime ≥ now − 300 s` (cùng cửa sổ 5' với step-up admin, D3), **hoặc (b)** form có `current_password` đúng. (b) qua bucket `reservePasswordChange` sẵn có (5/900 s theo user, reserve trước Argon2, refund khi đúng) ⇒ không thành oracle đoán mật khẩu thứ hai. Sai ⇒ 400 render lại, không huỷ gì, audit `SESSION_REVOKED failure reason:'reauth_failed'`. Tài khoản không mật khẩu và phiên > 5' ⇒ trang báo "sign out and sign in again to manage sessions" (DEBT-622). Đã loại "không cần xác thực lại": ASVS L2 ghi rõ.
- **D88.19 Ngữ nghĩa**
  - **Huỷ 1 phiên** (`ref` khớp `^[0-9a-f]{64}$`, ≠ phiên hiện tại; hiện tại ⇒ 400 "use Sign out"): kiểm chủ sở hữu bằng `sismember(user_sess:{userId}, ref)` + `userId` đã lưu; không phải của mình/không tồn tại ⇒ trang 404 cố định, không đổi gì, audit failure `reason:'not_found'` **không** ghi `ref` lạ. Của mình ⇒ trình tự local logout: `revokeForSession(userId, ref)` → xoá phiên + tombstone (`revokeRef`, có SREM) → sweep `revokeForSession` (INV-28/29). Lỗi ⇒ dừng, audit `SESSION_REVOKED failure revoke_failed {scope:'session', via:'self', failedStep}` + 5xx; retry idempotent. Thành công ⇒ audit `SESSION_REVOKED success {scope:'session', via:'self'}` (`targetId` = ref đã huỷ) + `TOKEN_REVOKED {count}` khi > 0. Dùng **một helper chung** với local logout (không chép logic thứ hai).
  - **Huỷ mọi phiên khác**: `listByUser` rồi chạy trình tự trên cho mỗi `ref ≠ current` (chạy hết, lỗi đầu tiên thắng như DEBT-055). Phiên tạo song song sau `listByUser` không bị huỷ — chấp nhận (không tồn tại lúc người dùng bấm), ghi trong spec. Audit `{scope:'others', count}`. Không động family không gắn phiên sống (offline_access của phiên đã thay/hết hạn): thuộc "Connected apps" (T3) và "Sign out everywhere".
  - **Quên 1 thiết bị**: `device` khớp `^[0-9a-f]{64}$` ⇒ `ZREM dc:{u:…} device` (key theo user hiện tại nên không chạm được thiết bị người khác); 0 phần tử ⇒ 404 cố định. **Quên mọi thiết bị khác**: `ZREM` mọi member ≠ hash cookie hiện tại (không có cookie ⇒ `DEL`). Audit action mới `TRUSTED_DEVICE_REVOKED {scope:'device'|'others', count}`; Redis lỗi ⇒ 5xx (fail-closed; khác `forgetDevices` best-effort trong revoke-all vốn là bước phụ).
- **D88.20 Lỗi hạ tầng**: Redis lỗi ở GET ⇒ 5xx qua `HtmlExceptionFilter` (không render danh sách rỗng giả); Mongo lỗi ở bước family ⇒ như D88.19. Trang `Cache-Control: no-store`.

**Consent self-service + màn consent (T3)**

- **D88.21 Màn consent** (`views/consent.eta`, chỉ thêm; giữ nguyên nút `Allow`/`Deny` và field cho E2E): (1) `clientId` (đậm, như cũ) + "will receive the result at **<origin của `redirectUri` trong context đã xác thực>**" (chống phishing); (2) mô tả cố định cho `openid` ("Confirm your identity"), `profile`, `email`, `offline_access` ("Stay signed in when you are not using it"); scope resource hiện mã như cũ; (3) **thời hạn**: luôn có "Each access lasts up to <ACCESS_TOKEN_TTL/60> minutes"; khi scope được cấp có `offline_access` **và** client có grant `refresh_token` thêm "The app can keep access for up to <REFRESH_TOKEN_TTL/86400> days without you signing in again"; (4) "Your choice is remembered until you revoke it in **Connected apps** (`/account/apps`) or our terms change." Không thêm `displayName` cho client (đổi admin API + fe-admin, ngoài phạm vi ⇒ DEBT-623). C-10.7a giữ ⚠.
- **D88.22 `/account/apps`**: `GET` (cần phiên, như D88.15) liệt kê consent **active** của `userId` (mọi tenant — consent thuộc về user), sắp `updatedAt desc`, tối đa 100, qua `ConsentService.listOwn(userId, limit)` mới; mỗi dòng: `clientId` (+ "(disabled)" / "Removed application"), resource identifier (`''` ⇒ "Sign-in only"), scope, `grantedAt`/`updatedAt`. `POST /account/apps/revoke` (`consent_id` khớp `^[0-9a-f]{24}$`, `CsrfGuard`, limiter `account_apps`), **không** đòi xác thực lại (ASVS 10.7.3 không yêu cầu; thu hồi là hướng an toàn). Logic: `ConsentService.revokeOwn(id, userId, now)` mới = một `findOneAndUpdate({_id, userId}, [$set revokedAt $ifNull])` before-image (như `revokeById`, không filter tenant) ⇒ null ⇒ 404 cố định, audit failure `reason:'not_found'` không ghi id; có ⇒ `refreshTokens.revokeForConsent(userId, clientId, resource, now)` (cả khi `alreadyRevoked`, để retry hoàn tất sweep — DEBT-151) ⇒ audit `OAUTH_CONSENT_REVOKED success {clientId, resource, count, alreadyRevoked, via:'self'}`, `actorType:'user'`; sweep lỗi ⇒ audit failure `family_sweep_failed` + 5xx. Trang ghi rõ access token đã cấp còn dùng được tới tối đa `ACCESS_TOKEN_TTL` (giống thu hồi của admin, §9.11 "Chấp nhận"). Đường admin giữ nguyên; cả hai theo thứ tự "consent trước, family sau".

**MFA (run 89 — chốt ngay để run 89 fold nhanh)**

- **D88.23 Phạm vi**: TOTP **RFC 6238** (HMAC-SHA-1, 6 chữ số, bước 30 s — tương thích mọi app authenticator; secret 20 byte CSPRNG, base32) + **10 mã khôi phục**. Không WebAuthn/passkey ở bản phát hành này (DEBT-624), không SMS/email OTP (ASVS hạn chế, cần gọi ngoài). Tự viết bằng `node:crypto` (khoảng 40 dòng, kiểm bằng vector RFC 6238 phụ lục B), **không** thêm dependency.
- **D88.24 Bắt buộc theo resource, không theo vai trò**: authorization code cho resource `admin` chỉ được cấp khi phiên có `amr ⊇ {'mfa'}` (kiểm ở `/authorize`), và `/token` từ chối (`invalid_grant`) code `resource=admin` mà `amr` thiếu `mfa` (phòng thủ chiều sâu); refresh family thừa hưởng vì chỉ sinh từ code đó. Lý do: AT admin không mang `amr`, family không lưu `amr` (phát hiện 6); chỉ admin dùng được resource `admin` nên tương đương "bắt buộc cho admin" mà không cần đồng bộ khi vai trò đổi. Phiên chưa MFA xin resource `admin`: đã enroll ⇒ trang bước 2 (luồng pending D88.27 trên phiên hiện có, nâng `amr` + `authTime`); chưa enroll ⇒ trang "Admin console requires two-step verification" + link `/account/mfa?returnTo=…`. Env `ADMIN_MFA_REQUIRED` (mặc định `true`; `false` chỉ nhận khi `NODE_ENV` ≠ production — validation từ chối boot). User thường: MFA tuỳ chọn; đã enroll thì **mọi** đăng nhập (mật khẩu **và** federation) đều đòi bước 2 (ASVS 6.3.4, không đường xác thực ẩn). Thiết bị tin cậy **không** bỏ qua MFA.
- **D88.25 Lưu secret**: AES-256-GCM, khoá từ env `MFA_ENCRYPTION_KEYS` = `kid:base64(32 byte)` cách nhau dấu phẩy, phần tử đầu là khoá hiện hành; bắt buộc ở production (thiếu/sai độ dài ⇒ không boot), dev/test lấy từ `.env.example`. AAD = `totp:v1:<userId>` (chống chép ciphertext giữa user). Lưu `{kid, iv, ct, tag}`; giải mã thất bại ⇒ coi như sai mã + log ERROR không lộ dữ liệu. Xoay khoá: thêm khoá mới lên đầu, mã hoá lại lười khi xác minh thành công; runbook. Không dùng Vault Transit: thêm phụ thuộc mạng vào mọi lần đăng nhập; khoá ở env (không ở Mongo) ⇒ **backup Mongo bị lộ không lộ seed TOTP** (D87). Mã khôi phục: 16 ký tự Crockford base32 (80 bit), lưu `sha256(salt‖code)` với salt 16 byte theo user, dùng một lần bằng `$pull` có điều kiện; tạo lại thay toàn bộ.
- **D88.26 Chống replay + giới hạn**: cửa sổ ±1 bước; mỗi user lưu `mfa.lastStep`, ghi CAS `{'mfa.lastStep': {$lt: step}}` ⇒ cùng một mã (hoặc bước cũ hơn) không bao giờ được nhận lần 2, kể cả qua 2 instance. Giới hạn: 5 lần sai mỗi vé pending (hết ⇒ xoá vé, phải nhập lại mật khẩu, chịu D85.2) và 10 lần sai/900 s theo user trên mọi vé (reserve trước khi kiểm, như D85.6) ⇒ 429; audit `AUTH_MFA_FAILED` (lần đầu mỗi cửa sổ), `AUTH_MFA_THROTTLED` vào `ALERT_ACTIONS`.
- **D88.27 Luồng đăng nhập**: mật khẩu (hoặc callback federation) đúng + user đã enroll ⇒ **chưa** tạo phiên; tạo vé `mfa_pend:{sha256(id)}` Redis TTL 300 s, dùng một lần (`GETDEL` khi xong/hết lượt), cookie `__Host-idp_mfa` (HttpOnly, `Secure` khi `SESSION_COOKIE_SECURE`, SameSite=Lax, Path=/) chứa `userId`, `returnTo` đã `safeReturnTo`, `amr` gốc, quyết định thiết bị tin cậy, số lần sai. `GET/POST /login/mfa` (CSRF identity = cookie vé). Đúng ⇒ `sessions.establish` với `amr [gốc,'otp','mfa']` (mã khôi phục: `[gốc,'mfa']`), `authTime = now`, giữ re-check khoá sau establish (DEBT-141). Reset mật khẩu **không** gỡ MFA (ASVS 6.4.3).
- **D88.28 Enroll / tắt / mất yếu tố**: `/account/mfa` (cần phiên + xác thực lại D88.18) hiện khoá thủ công (base32 nhóm 4) + link `otpauth://totp/Veyrigate:<email>?secret=…&issuer=Veyrigate&algorithm=SHA1&digits=6&period=30`, không QR (cần dependency ⇒ DEBT-625); secret chờ lưu mã hoá ở Redis `mfa_enr:{sessionRef}` TTL 600 s; nhập đúng 1 mã ⇒ ghi Mongo CAS "chưa enroll" ⇒ hiện 10 mã khôi phục **một lần** (`no-store`) ⇒ `revokeAllUserCredentials` (như D85.6: mọi phiên kể cả hiện tại, mọi family, thiết bị tin cậy) + thư thông báo. Tắt MFA / tạo lại mã khôi phục: mật khẩu + mã TOTP hiện tại; tắt ⇒ revoke-all + thư. Mất yếu tố: mã khôi phục; hết mã ⇒ admin `POST /admin/users/:id/mfa/reset` (step-up 5', tenant scoping, tenant_admin không reset được super_admin, revoke-all, audit `ADMIN_USER_MFA_RESET`, thư cho user) và break-glass `admin-recover --reset-mfa` (cùng xác nhận 2 người D87.12/13).
- **D88.29 Step-up**: console admin dùng `prompt=login`/`max_age` như cũ ⇒ đăng nhập lại của user đã enroll luôn gồm TOTP ⇒ `auth_time` là lúc qua bước 2. `/account/password` giữ mật khẩu hiện tại (một yếu tố đủ, ASVS 7.5.1); tắt MFA/tạo lại mã đòi cả hai yếu tố. `acr` giữ cố định (DEBT-626 nếu RP cần `acr_values`).

**Pentest (run 90)**

- **D88.30 Cách làm**: harness Node ESM `be/scripts/pentest/` (mẫu harness drill D87.11: assert không gian tên, chỉ dọn thứ mình sở hữu, idempotent); mỗi check = `{id, ref: 'ASVS 5.0 x.y.z' | 'RFC 9700 §…' | 'OIDC Core §…', request tóm tắt không secret, expected, actual, pass}`. Không tải công cụ; Playwright đã có trong `e2e/` cho luồng trình duyệt.
  - **Không gian tên**: Mongo `vg-pentest` (27017), Redis `/7` (`DBSIZE` = 0 lúc bắt đầu, chỉ `FLUSHDB` db 7, không chạy cùng lúc với drill), BE `127.0.0.1:4989`, fe-admin `:3989`; `sso-idp`/`sso-idp-e2e` chỉ đếm trước/sau. Cấu hình gần production nhất chạy được local (HTTPS cục bộ như X3 khi cần `Secure`); giới hạn ghi vào biên bản.
  - **Nhóm check tối thiểu**: OAuth (biến thể `redirect_uri`: hoa/thường, `/` cuối, userinfo, IDN, `..`; open redirect qua `post_logout_redirect_uri`/`returnTo`; PKCE thiếu/`plain`/sai; replay + tiêm code chéo client; mix-up `iss`; leo `resource`/`scope` khi refresh; RT reuse; nhầm loại token ID↔AT ở `/userinfo`/`/introspect`; JWT `alg:none`, HS256 bằng khoá JWKS, `kid`/`jku`/`x5u` lạ); phiên (fixation, cờ cookie, CSRF mọi POST thiếu/sai/khác identity, clickjacking/CSP/CORS mọi route theo OpenAPI + danh sách route UI); xác thực (enumeration theo **thời gian** ≥ 200 mẫu/ca so median, throttle với `X-Forwarded-For` giả khi `TRUST_PROXY` trống, MFA brute-force/replay/bỏ qua qua federation/reset/`prompt=none`); IDOR `/account/*` và admin chéo tenant; injection (toán tử NoSQL `email[$ne]` ở form/JSON, CRLF ở `returnTo`/`state`, template Eta, input quá dài); DEBT-604 (lịch sử trình duyệt sau fragment); supply chain (`pnpm audit --prod`, CodeQL CI, quét secret bằng `git grep` mẫu khoá/token vì không có gitleaks).
  - **Thủ công**: tester khám phá giới hạn 2 h bằng trình duyệt + DevTools theo ASVS V3/V6/V7/V10, ghi từng thử nghiệm.
  - **Bằng chứng**: `runs/90-…/evidence/pentest-<UTC>.json` (+ `.log`), cùng luật lọc D87.11 (tự grep `eyJ`, `$argon2`, `password`, `secret`, `otpauth` ⇒ exit 1); `pentest-report.md`: phát hiện, mức (P0/P1/P2 theo D84.7), cách tái hiện, trạng thái. P0/P1 sửa trong run 90 rồi chạy lại check; P2 ⇒ backlog. Ký mục F chỉ khi không còn P0/P1 mở.

### Ảnh hưởng E2E / X3 / fe-admin

- **Run 88**: E2E thêm `e2e/tests/account-self-service.spec.ts` (T4); spec cũ không đổi (nút `Allow`/`Deny`, field consent giữ nguyên; trang `/` chỉ thêm link — tester kiểm lại `logout.spec.ts`, `password-change.spec.ts`). X3: không đổi cookie/topology ⇒ chạy lại 42 làm hồi quy. fe-admin: chỉ enum audit (`ADMIN_BOOTSTRAPPED`, `TRUSTED_DEVICE_REVOKED`) qua `gen:api` + `AUDIT_ACTIONS` ở `fe-admin/src/features/admin-api/inputs.ts` + `fe-admin/test/admin-schema-types.test.ts` (backend-dev làm, như run 87 T2 AC12); không UI mới.
- **Run 89**: ảnh hưởng lớn — mọi E2E admin phải qua TOTP: `seed:e2e-admin` enroll secret từ `e2e/.env` (`E2E_ADMIN_TOTP_SECRET`, mã hoá bằng khoá test); helper Playwright tính TOTP bằng `node:crypto` và **chờ bước mới** khi bước hiện tại đã dùng (luật replay D88.26) ⇒ rủi ro E2E chậm/flaky, giảm bằng `storageState`. fe-admin: trạng thái MFA ở chi tiết user + nút Reset MFA (step-up), phiên/danh tính (DEBT-334). X3: user X3 không enroll ⇒ không đổi; thêm 1 hàng cookie `__Host-idp_mfa` nếu tester thấy cần.
- **Run 90**: không đổi E2E; harness pentest tách khỏi E2E.

---

### T1 [BE/ops] DEBT-164 + DEBT-165 / D-16 — bootstrap production (D88.2–D88.14) — backend-dev

- **Cổng security** (trust boundary: công cụ tạo control-plane, chạy ngoài HTTP, in một credential)
  - **Tài sản**: client `fe-admin` (admin-capable) + secret, resource `admin`, vết audit.
  - **Actor**: operator; người có shell trên host ops; lượt bootstrap thứ hai chạy song song (CI/người khác); dữ liệu cài sẵn bởi kẻ có quyền ghi DB (client lạ trỏ `admin`).
  - **Bất biến**: không bao giờ chạm `users`/`usertenants`/Redis; tối đa **1** secret được in trên mọi tổ hợp lượt chạy đồng thời; secret chỉ ở stdout của lượt tạo ra nó và chỉ sau commit; mọi lượt ghi có đúng 1 audit `ADMIN_BOOTSTRAPPED` **trong cùng transaction**; nhánh từ chối không ghi gì.
  - **Abuse cases**: chạy song song (2 secret, DEBT-164); trỏ nhầm DB (confused deputy) ⇒ `target:` in trước mọi ghi; URI `http`/wildcard/fragment ở production; resource `admin` bị re-point hoặc client khác tham chiếu `admin` (DEBT-137); `fe-admin` bị đổi thành public trước khi bootstrap; chạy lại để "câu" secret (không in khi đã có); argv/log lộ credential Mongo.
  - **Failure semantics**: tham số/env sai ⇒ exit 1 trước kết nối (< 1 s với URI cổng đóng); Mongo không tới ⇒ exit 1 (`serverSelectionTimeoutMS 5000`); standalone/txn lỗi/audit lỗi ⇒ abort, không ghi, không in secret; commit xong mà ghi stdout lỗi ⇒ exit 1 + dòng hướng dẫn `--rotate-secret`.
  - **Exposure**: stdout/stderr không chứa email, hash, URI có credential, giá trị env khác; secret không vào audit/log.
- **AC**
  1. DB rỗng sau `db:sync-indexes`, env production hợp lệ (URI https) ⇒ tạo tenant + resource `admin` (identifier = `adminResourceIdentifier(ISSUER)`) + client `fe-admin` đúng URI env + 1 credential active; stdout có đúng 1 dòng khớp `^OIDC_CLIENT_SECRET=[A-Za-z0-9_-]{43}$` và secret đó qua `ClientCredentialService.verifySecret`; 1 audit `ADMIN_BOOTSTRAPPED success` với `metadata.created` đúng, `secretIssued:true`; exit 0.
  2. Chạy lại cùng env ⇒ không có dòng `OIDC_CLIENT_SECRET=`, số credential không đổi, in `fe-admin secret: unchanged`, audit `secretIssued:false`, exit 0.
  3. Hai lượt song song trên DB rỗng (barrier trước câu touch), lặp ≥ 20 lần ⇒ mỗi lần đúng 1 credential active và tổng đúng 1 dòng secret trong 2 stdout; không có client/resource trùng.
  4. URI env khác client đã có ⇒ exit 2, DB không đổi. `--update-uris --ticket T-1` ⇒ hai danh sách được thay, audit `REDIRECT_URI_CHANGED` + `ADMIN_BOOTSTRAPPED {urisUpdated:true}`; `--update-uris` thiếu `--ticket` ⇒ exit 1 trước kết nối.
  5. `--rotate-secret --ticket T-2` ⇒ mọi credential cũ có `revokedAt` (secret cũ `verifySecret` thất bại ngay), 1 version mới active, in một lần; audit `secretRotated:true`.
  6. Từ chối, exit 1, không ghi gì (đếm mọi collection trước/sau): resource `admin` trỏ identifier khác; client `x` có `allowedResources:['admin']`; `fe-admin` tồn tại dạng public/`none`; thiếu index unique D88.10.
  7. `NODE_ENV=production` + `http://localhost:3000/...`, `https://*.example.com/cb` hoặc URI có fragment ⇒ exit 1 trước kết nối, thông điệp không chứa URI.
  8. Mongo standalone (hoặc stub `startSession`/`withTransaction` ném) ⇒ exit 1 "replica set", không ghi. Stub insert audit ném trong transaction ⇒ không client/credential nào tồn tại sau đó, không in secret.
  9. `users`/`usertenants` không đổi (count + nội dung) ở mọi ca; khi không có super_admin dùng được, stdout có `usable super_admins: 0` + câu hướng dẫn `db:admin-recover`.
  10. `--dry-run` ⇒ in `target:` + URI + `dry-run: no connection made`, exit 0, không kết nối (URI cổng đóng, < 1 s). Tham số lạ / tên sai mẫu ⇒ exit 1, không echo.
  11. Mọi stdout/stderr ở AC1–AC10 không chứa `$argon2`, mật khẩu trong `MONGO_URI`, email.
  12. DEBT-165: `validateEnv` production **không** có `ADMIN_SEED_EMAIL` ⇒ hợp lệ; có nhưng sai dạng ⇒ vẫn lỗi; `db:seed` thiếu `ADMIN_SEED_EMAIL` ⇒ vẫn exit 1 như cũ.
  13. `db:seed` (dev/test) hành vi không đổi: `seed-dev.int-spec.ts` và spec seed hiện có xanh, không sửa kỳ vọng.
  14. Enum `ADMIN_BOOTSTRAPPED` trong `ALERT_ACTIONS`; OpenAPI sinh lại, `fe-admin/src/server/admin-api/schema.d.ts` khớp (`gen:api`), `AUDIT_ACTIONS` fe-admin có thêm, `fe-admin/test/admin-schema-types.test.ts` xanh.
  15. D88.14(a) `--dry-run` từ bố cục `pnpm deploy --prod` exit 0; (b) check trong `docker-smoke.sh`; runbook-deploy §16 viết theo D88.14.
- **RED trước**: `be/test/run88-bootstrap.int-spec.ts` (AC1–AC9, AC11, AC13) gọi hàm xuất `bootstrapAdminPlane(connection, opts, io)`; `be/src/database/bootstrap.spec.ts` unit parse tham số + env (AC4 thiếu ticket, AC7, AC10); 1 ca child-process trên `dist` cho AC10; `validation.schema.spec.ts` (AC12).
- **Mutation** (mỗi cái làm đỏ ít nhất 1 AC): bỏ touch `opslocks` ⇒ AC3; in secret trước commit / trong callback ⇒ AC8; insert audit ngoài transaction ⇒ AC8; `allowHttpLocalhost: true` ở production ⇒ AC7; bỏ kiểm admin-capable ⇒ AC6; `$set` URI khi drift không có cờ ⇒ AC4.
- **File**: `be/src/database/bootstrap.ts` (+ `bootstrap.spec.ts`), `be/src/database/seed.ts` (tách lõi D88.3), `be/package.json` (`db:bootstrap`), `be/src/modules/security/audit/audit-action.enum.ts`, `be/src/config/validation.schema.ts` + `configuration.ts` (+ spec), `be/scripts/docker-smoke.sh`, `be/.env.example` (biến `BOOTSTRAP_*` dạng chú thích), OpenAPI sinh + `fe-admin/src/server/admin-api/schema.d.ts`, `fe-admin/src/features/admin-api/inputs.ts`, `docs/agile/sso-idp/runbook-deploy.md` §16, `be/test/run88-bootstrap.int-spec.ts`.
- **Rủi ro**: `withTransaction` chạy lại callback ⇒ callback không được có side effect ngoài DB (in/log/sinh secret); race có thể không tái hiện ⇒ dùng barrier như run 87 T2 AC9.

### T2 [BE+UI] DEBT-582 + DEBT-586 / C-7.5.2 — trang phiên của tôi (D88.15–D88.20) — backend-dev

- **Cổng security**
  - **Tài sản**: phiên Redis, refresh family gắn `sessionRef`, thiết bị tin cậy (quyền miễn throttle).
  - **Actor**: chủ tài khoản; kẻ giữ phiên bị đánh cắp (muốn huỷ phiên nạn nhân / giữ phiên mình); user khác (IDOR); trang khác site (CSRF).
  - **Bất biến**: chỉ huỷ được phiên/thiết bị của chính `userId` phiên hiện tại; sau khi huỷ phiên X: `sess:X` mất, `sess_end:X` tồn tại, không còn family active có `sessionRef = X` (kể cả family `/token` chèn song song — sweep); AT mang `sid=X` inactive ngay ở `/introspect`/`/userinfo` (INV-28); không thao tác nào chạy khi chưa xác thực lại (D88.18).
  - **Abuse cases**: IDOR `ref`/`device` của user khác hoặc bịa; huỷ phiên hiện tại qua form; CSRF thiếu/sai; POST sau khi cửa sổ xác thực lại hết hạn; đoán mật khẩu qua ô xác thực lại (bucket chung D85.6); race huỷ ∥ `/token` đổi code của phiên đó; race huỷ ∥ chính phiên đó đang request (SET XX không hồi sinh).
  - **Failure semantics**: Redis/Mongo lỗi ⇒ 5xx, audit failure kèm `failedStep`, không báo thành công; retry idempotent.
  - **Exposure**: không IP/UA thô/email trên trang; audit không ghi `ref` lạ; log không chứa mật khẩu.
- **AC**
  1. User đăng nhập ở 2 trình duyệt A, B (UA Chrome/Windows và Firefox/Linux) ⇒ `GET /account/sessions` ở A liệt kê 2 phiên, nhãn "Chrome on Windows" / "Firefox on Linux", A có "This browser"; HTML không chứa IP, UA thô, email; `Cache-Control: no-store`. Không phiên ⇒ 302 `/login?returnTo=%2Faccount%2Fsessions`.
  2. A (phiên < 5') huỷ B ⇒ 303; `sess:B` mất, `sess_end:B` có; family `sessionRef=B` bị revoke, family của A sống; AT `sid=B` ⇒ `/userinfo` 401, `/introspect` `active:false`; request kế của B ⇒ về login; audit `SESSION_REVOKED success {scope:'session', via:'self'}` + `TOKEN_REVOKED {count}`.
  3. Phiên A cũ hơn 300 s (đồng hồ tiêm), không `current_password` ⇒ 400, không đổi gì; mật khẩu sai ⇒ 400 + audit `reauth_failed`; mật khẩu đúng ⇒ thành công. 6 lần sai liên tiếp ⇒ lần thứ 6 là 429 (bucket 5/900 s dùng chung với `/account/password`).
  4. `ref` của user khác / bịa / sai dạng ⇒ 404 cố định; `ref` của phiên hiện tại ⇒ 400 "use Sign out"; không phiên nào của cả hai user thay đổi; audit failure không chứa `ref` đã gửi.
  5. Thiếu `_csrf` / CSRF của identity khác ⇒ 403 như `CsrfGuard` hiện có, không đổi gì.
  6. "Huỷ mọi phiên khác" với 3 phiên ⇒ chỉ còn phiên hiện tại, family của 2 phiên kia bị revoke, family của phiên hiện tại sống; audit `{scope:'others', count:2}`.
  7. Race: barrier giữa bước 1 (`revokeForSession`) và bước 2 trong khi `/token` đổi code của phiên B ⇒ sau cùng không còn family active `sessionRef=B` (lặp ≥ 20).
  8. Stub Mongo lỗi ở bước family ⇒ 5xx, phiên B **còn sống**, audit failure `failedStep:'pre_revoke'`; stub Redis lỗi ở bước xoá ⇒ 5xx, audit `failedStep:'sessions'`; gỡ stub, gửi lại ⇒ thành công.
  9. Thiết bị tin cậy: đăng nhập mật khẩu ở A và B ⇒ trang liệt kê 2 "Trusted since", A có "This browser"; quên B ⇒ `ZSCORE` của B null, A còn; quên mọi thiết bị khác ⇒ chỉ còn A; `device` không tồn tại ⇒ 404; audit `TRUSTED_DEVICE_REVOKED`; phiên B **không** bị huỷ khi quên thiết bị B.
  10. Phiên tạo bằng federation có nhãn và phương thức "Google/GitHub sign-in"; phiên cũ không `device.label` ⇒ "Unknown device".
  11. Unit `deviceLabelFromUserAgent`: ≥ 12 UA thật + UA rỗng / dài 10 KB / chứa `<script>` / CRLF ⇒ chỉ ra giá trị trong allowlist.
  12. Tài khoản không mật khẩu, phiên > 300 s ⇒ trang hiện câu D88.18 thay cho ô mật khẩu; POST ⇒ 400, không đổi gì.
- **RED trước**: `be/test/run88-account-sessions.int-spec.ts` (AC1–AC10, AC12), unit `be/src/modules/sessions/device-label.spec.ts` (AC11).
- **Mutation**: bỏ sweep bước 3 ⇒ AC7; bỏ kiểm `sismember`/`userId` ⇒ AC4; bỏ điều kiện xác thực lại ⇒ AC3; `tombstone:false` ⇒ AC2; "others" không loại `current` ⇒ AC6; quên thiết bị dùng key không theo user hiện tại ⇒ AC9.
- **File**: `be/src/modules/ui/ui.controller.ts` hoặc `be/src/modules/ui/account.controller.ts` mới trong `UiModule` (khuyến nghị tách, `ui.controller.ts` đã 635 dòng), helper huỷ phiên chung với local logout, `be/src/views/sessions.eta` (mới), trang `/` (link), `be/src/modules/sessions/device-label.ts` (+ spec), `be/src/modules/authentication/login-throttle.service.ts` (list/forget theo member), `authentication.service.ts` + `federation.service.ts` (truyền nhãn), `audit-action.enum.ts` (`TRUSTED_DEVICE_REVOKED`) + OpenAPI/fe-admin enum như T1 AC14, `be/test/run88-account-sessions.int-spec.ts`.
- **Rủi ro**: chép trình tự huỷ thứ hai sẽ lệch dần với local logout ⇒ bắt buộc helper chung (senior soát).

### T3 [BE+UI] DEBT-581 / C-10.7b — consent self-service + màn consent rõ (D88.21–D88.22) — backend-dev

- **Cổng security**
  - **Tài sản**: consent (user × client × resource), refresh family theo consent.
  - **Actor**: chủ tài khoản, user khác (IDOR), trang khác site (CSRF), RP lừa đảo (phishing qua màn consent).
  - **Bất biến**: chỉ thu hồi consent có `userId` = phiên hiện tại; sau thu hồi: `/authorize` hỏi lại, refresh của user × client × resource đó ⇒ `invalid_grant` (Q58.1), family khác sống; màn consent chỉ hiện dữ liệu đã xác thực (origin từ `redirectUri` đã khớp tuyệt đối trong context, không từ query).
  - **Abuse cases**: IDOR `consent_id`; CSRF; thu hồi lặp (idempotent + sweep lại); race thu hồi ∥ refresh (family chết nhờ kiểm consent ở refresh); XSS qua `clientId`/scope/resource (Eta escape); origin hiển thị lấy từ tham số chưa xác thực.
  - **Failure semantics**: Mongo lỗi ở sweep ⇒ audit failure + 5xx; consent đã đánh dấu thu hồi (như admin), retry hoàn tất sweep.
  - **Exposure**: trang không hiện `familyId`, token, email người khác.
- **AC**
  1. Màn consent cho client có grant `refresh_token` + xin `offline_access` hiện: `clientId`, origin của `redirectUri` đã đăng ký, mô tả 4 scope OIDC, "up to 15 minutes" (theo `ACCESS_TOKEN_TTL`), "up to 30 days" (theo `REFRESH_TOKEN_TTL`), link `/account/apps`; client không có grant `refresh_token` hoặc không xin `offline_access` ⇒ **không** có câu "days". Nút/field cũ giữ nguyên (spec consent hiện có xanh, không sửa).
  2. TTL đổi qua env (test 600/86400) ⇒ câu đổi theo, không hard-code.
  3. `GET /account/apps` sau khi đồng ý 2 client ⇒ 2 dòng (scope, resource, ngày); consent đã thu hồi không hiện; client bị disable ⇒ "(disabled)"; client bị xoá ⇒ "Removed application". Không phiên ⇒ 302 `/login?returnTo=%2Faccount%2Fapps`.
  4. Thu hồi consent C1 ⇒ 303; `revokedAt` set; refresh family user × C1 × resource ⇒ `/token` refresh `invalid_grant`; family user × C2 vẫn refresh được; `/authorize` C1 hiện lại màn consent; audit `OAUTH_CONSENT_REVOKED success {via:'self', count, alreadyRevoked:false}`, `actorType:'user'`.
  5. Gửi lại cùng `consent_id` ⇒ 303, `alreadyRevoked:true`, sweep chạy lại (family chèn tay sau lần 1 bị revoke).
  6. `consent_id` của user khác / bịa / sai dạng ⇒ 404 cố định, consent người khác không đổi, audit failure không chứa id.
  7. Thiếu/sai CSRF ⇒ 403, không đổi gì.
  8. Stub sweep lỗi ⇒ 5xx + audit `family_sweep_failed`; gỡ stub, gửi lại ⇒ thành công, family bị revoke.
  9. `clientId`/scope chứa `<script>` (cài tay trong DB) ⇒ HTML đã escape ở màn consent và `/account/apps`.
  10. Đường admin `DELETE /admin/users/:id/consents/:consentId` không đổi (spec admin hiện có xanh).
- **RED trước**: `be/test/run88-account-apps.int-spec.ts` (AC1–AC10) + unit `consent.service.spec.ts` (`listOwn`, `revokeOwn`).
- **Mutation**: `revokeOwn` bỏ filter `userId` ⇒ AC6; bỏ sweep khi `alreadyRevoked` ⇒ AC5; câu "days" không phụ thuộc grant/scope ⇒ AC1; origin lấy từ query thay vì context ⇒ AC1.
- **File**: `be/src/views/consent.eta`, `be/src/views/apps.eta` (mới), `be/src/modules/oauth/authorize/authorize.controller.ts` (dữ liệu render), `be/src/modules/oauth/consent/consent.service.ts` (+ spec), controller account (chung T2), `be/test/run88-account-apps.int-spec.ts`.
- **Rủi ro**: T2 và T3 cùng sửa controller account và `/` ⇒ tuần tự T2 → T3.

### T4 [QA] gate + checklist — tester

- E2E mới `e2e/tests/account-self-service.spec.ts` (setup E2E riêng, DB `sso-idp-e2e`/Redis `/2`): (a) 2 context đăng nhập ⇒ A thấy 2 phiên, huỷ B (nhập mật khẩu) ⇒ B về login; (b) đồng ý app lab ⇒ `/account/apps` có dòng ⇒ thu hồi ⇒ lần authorize sau hiện consent; (c) màn consent có câu thời hạn + origin.
- Lượt tay runbook-deploy §16 trên DB riêng `vg-bootstrap-check` (27017, tạo rồi `dropDatabase` **đúng tên đó**, không dùng Redis): `--dry-run` → chạy thật → chạy lại → song song 2 lượt → `--update-uris` → `--rotate-secret`; ghi thời gian + output đã che secret vào `test-report.md`.
- Gate: lint/typecheck, be unit, int FULL, vault, E2E ×2, X3 42, fe-admin.
- Checklist: C-7.5.2, C-10.7b, D-16 ⇒ ✅ (bằng chứng `đường-dẫn › tên test`, kiểm "đúng 1 dòng chứa tên"); C-6.3.3 giữ ❌ P1 (run 89), D-14 giữ ❌ (run 90); đếm lại bảng tổng bằng script; `security-matrix.md` §Run 88.

### Outline run 89 `89-X6-mfa` (fold lại ở đầu run 89 trên code sau run 88)

- T1 [BE] lõi TOTP RFC 6238 + mã hoá `MFA_ENCRYPTION_KEYS` + schema `User.mfa` (thay placeholder `mfaSecret`) + mã khôi phục (D88.23, D88.25, D88.26) — backend-dev.
- T2 [BE+UI] `/account/mfa` enroll/tắt/tạo lại mã + thư thông báo (D88.28) — backend-dev.
- T3 [BE] bước 2 khi đăng nhập mật khẩu + federation (`/login/mfa`, vé pending, giới hạn) + bắt buộc cho resource `admin` ở `/authorize` + `/token` + `ADMIN_MFA_REQUIRED` (D88.24, D88.27, D88.29) — backend-dev.
- T4 [BE] `POST /admin/users/:id/mfa/reset` + `admin-recover --reset-mfa` + `GET /admin/users/:id/sessions` / `identities` (DEBT-334) + OpenAPI — backend-dev.
- T5 [FE] fe-admin: trạng thái MFA + Reset MFA (step-up, mẫu `UNCERTAIN_*`), phiên/danh tính của user — frontend-dev.
- T6 [QA] `seed:e2e-admin` + helper TOTP E2E, spec MFA (enroll, replay, recovery, admin bắt buộc, federation không bỏ qua), gate đầy đủ; checklist C-6.3.3 ✅, C-6.4b, C-6.5 cập nhật — tester.
- Thứ tự T1 → T2 → T3 → T4 → T5 → T6. Rủi ro: E2E admin chậm vì luật replay; int fixture đang mint code admin không có `amr: mfa` (spec cũ không liên quan MFA chạy `ADMIN_MFA_REQUIRED=false`, spec MFA mới bật `true`).

### Outline run 90 `90-X6-pentest-signoff`

- T1 [QA/BE] harness `be/scripts/pentest/` theo D88.30 (backend-dev viết khung + không gian tên; tester viết check).
- T2 [QA] chạy harness + 2 h thủ công ⇒ `pentest-report.md` + evidence.
- T3 [BE] sửa phát hiện P0/P1 (nếu có) + chạy lại check liên quan.
- T4 [QA] đếm lại checklist toàn bộ, đóng DEBT-604 hoặc ghi ⚠, gate đầy đủ.
- T5 [user] ký mục F (D-14): tester → tech-lead → senior → người dùng.
