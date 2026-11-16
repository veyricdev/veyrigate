# Run 89 `89-X6-mfa` — MFA TOTP + mã khôi phục (M8, lane BE + UI + FE + QA)

Nguồn: outline run 88 (`runs/88-X6-release3/tasks.md` §"Outline run 89") + D88.23–D88.29 (`plan.md` §12). Analyst bỏ qua. **Tech-lead đã fold** trên `develop` HEAD `de14146` (review: `review-techlead.md`, PASS). Mọi điểm mở chốt ở "## Quyết định D89.x" (người dùng ủy quyền, tiêu chí dùng được cho production).

## Mục tiêu
- Đóng DEBT-579 / checklist C-6.3.3 (❌ P1 cuối); C-6.4b và C-6.5 chuyển từ N/A sang có bằng chứng (tester chấm).
- Sửa 🟡 senior run 88 DEBT-628…632 trước; DEBT-632 (helper chung) là điều kiện cho controller MFA.
- Ràng buộc: không thêm dependency (TOTP + AES-GCM bằng `node:crypto`), không tạo container (`veyrigate-mongo`/`veyrigate-redis` dùng chung), E2E admin đi qua TOTP thật.
- **Ra khỏi run 89**: DEBT-334 (`GET /admin/users/:id/sessions` / `identities` + màn fe-admin) ⇒ sau phát hành (D89.1). Run 90 giữ nguyên: pentest + ký F.

## Phát hiện khi kiểm code (`de14146`)
1. `User.mfaSecret` là placeholder (`user.schema.ts:9`), không ai ghi; `PUBLIC_FIELDS = '-passwordHash -mfaSecret'` (`user.service.ts:49`), mapper admin + userinfo chỉ nhắc trong chú thích.
2. `amr` sinh ở 2 chỗ: `AuthenticationService.login` (`['pwd']`, `authentication.service.ts:196`) và `FederationService.callback` (`['fed']`, `federation.service.ts:192`); chảy session → code (`authorize.service.ts:487,509`) → ID token (`token.service.ts:129`, code không có `amr` ⇒ `LEGACY_AMR ['pwd']`). AT admin chỉ mang `auth_time` (`token.service.ts:302`); `RefreshTokenSchema` không có trường xác thực nào.
3. Có **3** đường tạo phiên, không phải 2: `/login` (`ui.controller.ts:322`), callback federation, và **liên kết federation** `POST /auth/link` gọi lại `auth.login` rồi mới `identities.link` (`federation.service.ts:290-330`).
4. `login()` gọi `throttle.onSuccess` (xoá bucket + cấp thiết bị tin cậy) ngay sau `establish`; `LoginBuckets` = danh sách key đã reserve + `trusted` ⇒ lưu được vào vé chờ.
5. Re-check sau `establish` (DEBT-141 khoá, DEBT-600 `passwordHash` đổi, DEBT-187 federation) nằm rải trong từng đường; bước 2 MFA phải lặp lại đủ.
6. `establish(oldId)` luôn huỷ phiên cũ (không tombstone) và tạo id mới ⇒ "nâng `amr` trên phiên hiện có" (D88.24) không có chỗ đứng: mọi lần qua bước 2 đều là `establish`.
7. `/authorize` dùng `AuthorizeRequestContext` TTL cố định 10' (`CONTEXT_TTL_MS`); resume kiểm `reauthAfter` theo `authTime`.
8. `adminTargetForbidden` + `recheckCodeGrant` + callback re-check refresh (`token.controller.ts:384-410, 450-470`) là ba điểm đúng để đặt cổng `/token`; `subjectFailure` đã đọc user.
9. `admin-recover` chỉ dùng Mongo (không Redis), ghi trong transaction `SuperAdminGuard`; tham số allowlist `VALUE_FLAGS`/`SWITCHES`.
10. E2E: ~40 lần đăng nhập admin (`adminToken`, `signInAsAdmin`, hai bản `signInAsAdmin` cục bộ trong `admin-api-risk.spec.ts`/`fe-admin.spec.ts`), `workers: 1`; `adminToken` cũng cấp token `resource=admin` cho **user thường** (`E2E_USER_EMAIL`, mục tiêu khoá/thu hồi) ⇒ user đó cũng phải qua TOTP. X3 chỉ dùng resource `demo`.
11. Int: 5 nơi dựng env (`full-app.ts`, `b73-tester`, `b73c-tester`, `run86-tester`, `seed-e2e-admin.ts`); ~88 chỗ dùng `FLOW_ADMIN_AUD`/`adminResourceIdentifier`, 46 file tạo phiên trực tiếp ⇒ bật cổng mặc định ở int sẽ sửa hàng chục spec không liên quan (D89.4).

## Lô và thứ tự

| Lô | Task | Lane | Phụ thuộc |
|---|---|---|---|
| A | T0 DEBT-628…632 · T1 lõi MFA (TOTP, keyring, schema, mã khôi phục, env) | backend-dev | — |
| B | T2 `/account/mfa` · T3 bước 2 đăng nhập + federation + cổng `admin` ở `/authorize`/`/token`/refresh | backend-dev | A |
| C | T4 reset MFA (admin API + `admin-recover --reset-mfa`) + runbook · T5 fe-admin trạng thái + Reset MFA | backend-dev → frontend-dev | B (T5 sau T4 vì `gen:api`) |
| D | T6 E2E qua TOTP + spec MFA + checklist + gate | tester | C |

Senior review sau lô B (phần nhạy cảm nhất) và sau lô C; tester chỉ chạy gate đầy đủ ở lô D. Nếu lô B vượt 1 lượt làm việc, tách T3 (cổng `/authorize`/`/token`/refresh, AC10–AC15) thành lượt riêng **trước** T2 không được: T3 cần enroll của T2 để test end-to-end; thay vào đó T3 int dùng fixture ghi `User.mfa` trực tiếp (helper `enrollForTest` ở T1).

---

### T0 [BE] DEBT-628…632 (senior run 88) — backend-dev — [x] xong (backend-dev 2026-11-13; senior PASS lô B; int FULL 86/86, 2368/2368; mutation đủ)

- **AC**
  1. DEBT-628: khi transaction cấp secret, dòng đầu tiên ghi ra stdout sau commit là `OIDC_CLIENT_SECRET=…`; **mọi** lần ghi sau commit (secret, "shown once", `tenant/resource/client …`, dòng alert) nằm trong cùng `try` mà lỗi ⇒ stderr có `--rotate-secret` + exit 1. Stub `io.write` ném ở lần ghi thứ 1, 2 và 3 ⇒ cả ba ca có câu hướng dẫn.
  2. DEBT-629: `verifyCurrentPassword` trả `{kind:'throttled', retryAfterSec, report}`; `AccountController.reauth` ghi 1 audit failure `reason:'reauth_throttled'` (action theo scope như `reauth_failed`) khi `report`. 7 lần sai liên tiếp trên `/account/sessions/revoke` ⇒ lần 6, 7 là 429, đúng **1** audit `reauth_throttled`.
  3. DEBT-630: `db:bootstrap --update-uris --ticket T` in đúng 1 dòng `{alert:true, action, eventId}` cho **mỗi** audit thuộc `ALERT_ACTIONS` (ở ca này: `REDIRECT_URI_CHANGED` + `ADMIN_BOOTSTRAPPED`), lặp trên danh sách audit, không liệt kê action cứng.
  4. DEBT-631: `SessionService.revokeOwnedRef(userId, ref)` (public, luôn tombstone, không kiểm sở hữu lần 2 vì `findOwned` đã chứng minh) thay `revokeByDevice` trong `/account/sessions/revoke`. Phiên biến mất giữa `findOwned` và bước xoá (stub) ⇒ tombstone `sess_end:{ref}` vẫn được ghi, trả 303 như thường.
  5. DEBT-632: `liveSession`, `identity`, `limit` chuyển vào provider `UiSessionHelper` (`be/src/modules/ui/ui-session.helper.ts`); `UiController` và `AccountController` gọi provider, không còn bản private; diff hành vi = 0 (int `ui*.int-spec.ts`, `run88-account-*.int-spec.ts` xanh không sửa kỳ vọng).
  6. (💭 kèm, rẻ) `consentDurations`: `Math.max(1, …)` cho phút/ngày; bỏ một trong hai cách nhận diện refusal ở `bootstrap.ts` (lớp `Refusal` **hoặc** regex) — không bắt buộc, làm nếu không đụng AC khác.
- **RED trước**: `bootstrap.spec.ts` (AC1 với `io` stub, AC3), `run89-t0.int-spec.ts` (AC2, AC4), unit `ui-session.helper.spec.ts` (cookie chết bị xoá, CSRF identity, 429 khi limiter chặn).
- **Mutation**: đưa dòng `tenant …` lên trước secret ⇒ AC1 đỏ; bỏ `report` ⇒ AC2 đỏ; lọc alert chỉ `ADMIN_BOOTSTRAPPED` ⇒ AC3 đỏ; quay lại `revokeByDevice` ⇒ AC4 đỏ.
- **File**: `be/src/database/bootstrap.ts` (+ spec), `be/src/modules/authentication/authentication.service.ts`, `be/src/modules/ui/{account.controller.ts, ui.controller.ts, ui.module.ts, ui-session.helper.ts}`, `be/src/modules/sessions/session.service.ts`, `be/src/modules/oauth/authorize/authorize.service.ts` (AC6), `be/test/run89-t0.int-spec.ts`.

### T1 [BE] Lõi MFA: TOTP, keyring, `User.mfa`, mã khôi phục, env (D89.2–D89.4, D89.10–D89.12) — backend-dev — [x] xong (backend-dev 2026-11-13; senior PASS lô B; int FULL 86/86, 2368/2368; mutation đủ)

- **Cổng security**
  - **Tài sản**: seed TOTP, mã khôi phục, khoá `MFA_ENCRYPTION_KEYS`.
  - **Actor**: kẻ có bản backup Mongo / quyền đọc DB; kẻ có quyền ghi DB (chép ciphertext giữa user); kẻ đoán mã; 2 instance song song.
  - **Bất biến**: seed không bao giờ nằm rõ trong Mongo, log, audit, response (ngoài màn enroll của chính chủ); ciphertext của user A giải mã với AAD của user B thất bại; một bước TOTP được nhận **tối đa 1 lần** trên mọi instance; một mã khôi phục dùng **tối đa 1 lần**.
  - **Abuse**: replay mã vừa dùng; dùng bước cũ hơn bước đã dùng; 2 request đồng thời cùng mã; kid lạ / tag sai / iv sai độ dài; timing compare.
  - **Failure**: khoá env sai/thiếu ⇒ không boot (mọi `NODE_ENV`); giải mã lỗi ⇒ coi như sai mã (đếm vào giới hạn) + `logger.error` chỉ có `kid` + `requestId`; Mongo lỗi ⇒ ném (5xx), không bao giờ "đúng mã".
  - **Exposure**: `mfa` `select:false`; mapper admin chỉ `{enrolled, enrolledAt}`; userinfo không đổi.
- **AC**
  1. `totp.ts` (thuần, không I/O): `hotp(secret, counter, digits)` + `totpAt(secret, step)`; đạt **mọi** vector RFC 6238 phụ lục B cho SHA-1 (8 chữ số, T = 59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000) và RFC 4226 phụ lục D (6 chữ số, counter 0–9).
  2. `base32` encode/decode RFC 4648 không padding: round-trip 1000 buffer ngẫu nhiên; decode từ chối ký tự ngoài bảng; secret mới = 20 byte `randomBytes` ⇒ 32 ký tự.
  3. `verifyTotp(secret, code, now, lastStep)`: chỉ nhận `^\d{6}$` (sau khi bỏ khoảng trắng); so cả 3 bước `c-1, c, c+1` bằng `timingSafeEqual` (không thoát sớm); trả bước khớp **lớn hơn** `lastStep`, hoặc null. Bảng ca: mã của `c+2` ⇒ null; mã của `c-1` khi `lastStep = c-1` ⇒ null; mã đúng nhưng `lastStep = c` ⇒ null.
  4. `MfaKeyring` (`mfa-crypto.ts`): parse `kid:base64` phân cách dấu phẩy, kid `^[a-z0-9-]{1,16}$` duy nhất, khoá giải đúng 32 byte; phần tử đầu = khoá hiện hành. AES-256-GCM, iv 12 byte ngẫu nhiên, tag 16 byte, AAD `totp:v1:<userId>` (bản chờ enroll: `totp:enr:v1:<userId>`). Ca âm: AAD user khác / tag lật 1 bit / kid không có trong keyring / iv 11 byte ⇒ trả `null` (không ném lên request), log ERROR không chứa ciphertext/userId.
  5. Env (`validation.schema.ts` + spec): `MFA_ENCRYPTION_KEYS` **bắt buộc mọi `NODE_ENV`**, sai dạng ⇒ lỗi chỉ nêu tên biến + vị trí phần tử (không echo); `NODE_ENV=production` + khoá trùng giá trị trong `be/.env.example` ⇒ từ chối. `ADMIN_MFA_REQUIRED` boolean mặc định `true`; `false` + production ⇒ từ chối.
  6. Schema `User.mfa` (`select:false`): `{secret:{kid,iv,ct,tag}, enrolledAt:Date, lastStep:Number, recoverySalt:String, recovery:[{hash:String}]}`; xoá `mfaSecret` khỏi schema và `PUBLIC_FIELDS`. `findById`/`findByEmail`/mapper admin/userinfo không trả `mfa` (test: user có `mfa` ⇒ JSON không chứa `ct`, `recovery`, `recoverySalt`).
  7. `MfaService` (Mongo, không Redis): `enroll(userId, secret, step, codes)` CAS `{_id, mfa:{$exists:false}}` (đã có ⇒ `already_enrolled`); `verify(userId, code, enrolledAt)` = đọc + `verifyTotp` + CAS `{_id, 'mfa.enrolledAt': enrolledAt, $or:[{'mfa.lastStep':{$lt:s}}, {'mfa.lastStep':{$exists:false}}]}` `$set lastStep` (và khi kid ≠ hiện hành: `$set secret` mã hoá lại trong **cùng** update); `consumeRecovery(userId, code, enrolledAt)` = chuẩn hoá + `updateOne({_id, 'mfa.enrolledAt', 'mfa.recovery.hash': h}, {$pull})`; `regenerate`, `disable` CAS theo `enrolledAt`; `state(userId)` ⇒ `{enrolled, enrolledAt, recoveryLeft}`.
  8. Concurrency (int, Mongo thật): 20 lần `verify` song song cùng mã ⇒ đúng 1 thành công; 10 lần `consumeRecovery` song song cùng mã ⇒ đúng 1; `verify` với mã bước `c` sau khi đã nhận `c+1` ⇒ thất bại.
  9. Mã khôi phục: 10 mã × 16 ký tự Crockford (80 bit, `randomBytes`), hiển thị `XXXX-XXXX-XXXX-XXXX`; chuẩn hoá nhập (hoa, bỏ `-`/khoảng trắng, `O→0`, `I/L→1`); lưu `sha256(salt‖code)` hex, salt 16 byte/user; không lưu bản rõ ở đâu.
  10. Xoay khoá: keyring `[k2,k1]`, user mã hoá bằng `k1` ⇒ `verify` đúng ⇒ document có `secret.kid = k2`, giải bằng `k2`; mã sai ⇒ không đổi `kid`.
  11. Helper test `enrollForTest(conn, keyring, userId, secret)` (trong `be/test/`, không vào `dist`, `assert-dist-clean` vẫn xanh) để T3/T4/E2E seed dùng chung.
- **RED trước**: `be/src/modules/mfa/{totp,base32,mfa-crypto,recovery-codes}.spec.ts`, `mfa.service.spec.ts` (Mongo mock cho AC7 lọc đúng filter), `be/test/run89-mfa-state.int-spec.ts` (AC6, AC8, AC10), `validation.schema.spec.ts` (AC5).
- **Mutation**: bỏ `$lt: s` khỏi filter ⇒ AC8 đỏ; AAD không chứa userId ⇒ AC4 đỏ; so `===` thoát sớm thay `timingSafeEqual` ⇒ unit kiểm "đã so cả 3" (spy) đỏ; cửa sổ ±2 ⇒ AC3 đỏ; bỏ kiểm khoá ví dụ ở production ⇒ AC5 đỏ.
- **File**: `be/src/modules/mfa/` (mới: `mfa.module.ts`, `totp.ts`, `base32.ts`, `mfa-crypto.ts`, `recovery-codes.ts`, `mfa.service.ts` + spec), `be/src/modules/identity/{schemas/user.schema.ts, user.service.ts}`, `be/src/modules/admin/admin.mappers.ts`, `be/src/config/{validation.schema.ts, configuration.ts}` (+ spec), `be/.env.example`, 5 nơi dựng env test (D89.4), `be/test/helpers/mfa.ts` (cạnh `mail-token.ts`).

### T2 [BE+UI] `/account/mfa`: enroll, tắt, tạo lại mã, thư (D89.13, D89.18, D89.23) — backend-dev — [x] xong (backend-dev 2026-11-13; senior PASS lô B; int FULL 86/86, 2368/2368; mutation đủ)

- **Cổng security**
  - **Tài sản**: quyền gắn/gỡ yếu tố thứ hai của tài khoản.
  - **Actor**: chủ tài khoản; kẻ có phiên bị đánh cắp (không có mật khẩu/TOTP); kẻ CSRF; kẻ có mật khẩu nhưng không có thiết bị.
  - **Bất biến**: enroll cần phiên + xác thực lại D88.18 và 1 mã đúng từ secret đang chờ; tắt/tạo lại cần **mật khẩu + TOTP hiện tại** (tài khoản không mật khẩu: phiên < 5' + TOTP); enroll/tắt ⇒ `revokeAllUserCredentials` (mọi phiên kể cả hiện tại, mọi family, thiết bị tin cậy); mã khôi phục hiện đúng 1 lần.
  - **Abuse**: phiên đánh cắp enroll TOTP của kẻ tấn công (chặn bởi xác thực lại + thư thông báo); phiên đánh cắp tắt MFA (cần cả 2 yếu tố); replay mã enroll để đăng nhập (`lastStep` = bước enroll); enroll song song 2 tab (CAS); đọc secret chờ của phiên khác (key theo `sessionRef`).
  - **Failure**: Redis lỗi khi lưu secret chờ ⇒ 5xx, không ghi Mongo; Mongo CAS thua ⇒ "already enabled", không revoke; revoke-all lỗi sau khi đã ghi Mongo ⇒ 5xx + audit `revoke_failed` `failedStep`, MFA **giữ** trạng thái mới (như reset mật khẩu, DEBT-050); thư lỗi ⇒ chỉ log.
  - **Exposure**: trang enroll + trang mã khôi phục `Cache-Control: no-store`; secret/mã không vào log, audit, URL (`returnTo` không chứa secret), thư.
- **AC**
  1. `GET /account/mfa` không phiên ⇒ 302 `/login?returnTo=%2Faccount%2Fmfa`; có phiên ⇒ trạng thái tắt/bật (`enrolledAt`, số mã còn lại); `returnTo` chỉ nhận qua `safeReturnTo`, giá trị lạ ⇒ bỏ.
  2. `POST /account/mfa/start` (CSRF + `account_mfa` limiter + xác thực lại D88.18) ⇒ secret mới mã hoá ở Redis `mfa_enr:{sessionRef}` TTL 600; trang có khoá base32 nhóm 4 và link `otpauth://totp/Veyrigate:<email>?secret=…&issuer=Veyrigate&algorithm=SHA1&digits=6&period=30` (nhãn URL-encode), `no-store`.
  3. `POST /account/mfa/confirm` mã đúng ⇒ `MfaService.enroll` với `lastStep` = bước vừa khớp ⇒ xoá `mfa_enr` ⇒ trang 10 mã khôi phục `no-store` ⇒ revoke-all ⇒ cookie phiên bị xoá ⇒ link "Continue" tới `/login?returnTo=<returnTo an toàn>` ⇒ thư `mfaEnabledMessage` ⇒ audit `MFA_ENROLLED`. Mã sai ⇒ 400, secret chờ giữ nguyên, đếm vào giới hạn D89.9. Secret chờ hết hạn ⇒ 400 "start again".
  4. Ngay sau AC3, đăng nhập bằng đúng mã đã dùng để enroll (cùng bước) ⇒ bị từ chối (replay).
  5. Hai `confirm` song song (cùng phiên, cùng mã) ⇒ đúng 1 enroll, 1 lần revoke-all, 1 thư.
  6. `POST /account/mfa/disable`: thiếu mật khẩu / mật khẩu sai / TOTP sai / dùng mã khôi phục thay TOTP ⇒ 400, MFA còn; đủ cả hai ⇒ `$unset mfa` (CAS `enrolledAt`) ⇒ revoke-all ⇒ thư `mfaDisabledMessage` ⇒ audit `MFA_DISABLED` (alert). Tài khoản chỉ federation: phiên < 5' + TOTP ⇒ thành công; phiên ≥ 5' ⇒ 400 hướng dẫn đăng nhập lại.
  7. `POST /account/mfa/recovery` (mật khẩu/phiên mới + TOTP) ⇒ 10 mã mới, salt mới, mã cũ hết hiệu lực; thư `mfaRecoveryRegeneratedMessage`; audit `MFA_RECOVERY_REGENERATED`; không revoke.
  8. Mọi POST thiếu `_csrf` / CSRF identity khác ⇒ 403, không đổi gì. Sai mật khẩu qua đây dùng bucket `pwc:` (D88.18, có audit throttled theo T0 AC2); sai TOTP dùng bucket MFA D89.9.
  9. Response, log capture, audit, thư ở AC2–AC7 không chứa base32 secret, `otpauth://` (trừ trang AC2), mã khôi phục (trừ trang AC3/AC7), `ct`.
  10. `/account/sessions`: cột phương thức hiện `Password + authenticator` / `Google/GitHub + authenticator` khi `amr` có `mfa` (D89.24); trang `/` (`home`) có link `/account/mfa`.
- **RED trước**: `be/test/run89-account-mfa.int-spec.ts` (AC1–AC9; TOTP tính bằng `totpAt` của T1 với clock điều khiển hoặc bước hiện tại), unit `templates.spec` cho 4 thư (không chứa mã/secret).
- **Mutation**: bỏ revoke-all sau enroll ⇒ AC3 (phiên cũ còn sống) đỏ; `lastStep` không ghi khi enroll ⇒ AC4 đỏ; nhận mã khôi phục ở `disable` ⇒ AC6 đỏ; key `mfa_enr` theo userId thay `sessionRef` ⇒ ca "phiên khác của cùng user không thấy secret chờ" đỏ.
- **File**: `be/src/modules/ui/mfa.controller.ts` (mới, dùng `UiSessionHelper`), `be/src/modules/ui/ui.module.ts`, `be/src/views/{account-mfa.eta, account-mfa-codes.eta, sessions.eta}`, trang `/` (`UiController.home`, `message.eta`: thêm link), `be/src/modules/mailer/templates.ts` (+ spec), `be/src/modules/security/audit/audit-action.enum.ts`, config rate-limit `account_mfa`.

### T3 [BE] Bước 2 khi đăng nhập + cổng resource `admin` (D89.5–D89.9, D89.14, D89.15) — backend-dev — [x] xong (backend-dev 2026-11-13; senior PASS lô B; int FULL 86/86, 2368/2368; mutation đủ)

- **Cổng security**
  - **Tài sản**: phiên IdP, authorization code + token `resource=admin`, thiết bị tin cậy.
  - **Actor**: kẻ có mật khẩu (credential stuffing thành công) không có thiết bị; kẻ có phiên Google của nạn nhân; kẻ có phiên IdP cũ (trước enroll/reset); RP gửi `prompt=none`; 2 tab/2 instance.
  - **Bất biến**: user đã enroll **không bao giờ** có phiên mà không qua bước 2 (cả `/login`, callback federation, `/auth/link`); thiết bị tin cậy không miễn bước 2; code/token `resource=admin` chỉ cấp khi `adminMfaSatisfied` (D89.5) ở **cả** `/authorize`, `/token` (code) và refresh; phiên/code/family có trước lần enroll hiện tại không thoả cổng.
  - **Abuse**: gọi thẳng `/authorize?request_id=` hoặc `/token` với code cũ; vé MFA dùng lại sau khi xong; brute force 6 chữ số qua nhiều vé (giới hạn theo user); khoá/đổi mật khẩu xảy ra giữa bước 1 và bước 2; vé của user A dùng với cookie phiên của user B; `returnTo` độc qua vé; federation link để gắn Google của kẻ tấn công vào tài khoản có MFA.
  - **Failure**: Redis lỗi khi tạo/đọc vé ⇒ 5xx, không phiên; Mongo lỗi ở CAS ⇒ 5xx, vé **không** bị xoá (thử lại được), không phiên; re-check sau `establish` lỗi ⇒ huỷ phiên vừa tạo + 5xx (như DEBT-141).
  - **Exposure**: trang `/login/mfa` không hiện email; lỗi mã = một câu cố định; audit không chứa mã; cookie vé HttpOnly.
- **AC**
  1. `/login` mật khẩu đúng + user đã enroll ⇒ **không** phiên mới (Redis `sess:*` của user không đổi), cookie vé `__Host-idp_mfa`/`idp_mfa` (HttpOnly, SameSite=Lax, Path=/, Max-Age 300), 302 `/login/mfa`; không audit `AUTH_LOGIN_SUCCESS`; bucket đăng nhập **không** được xoá và không cấp thiết bị tin cậy ở bước này.
  2. `POST /login/mfa` mã đúng ⇒ `establish` với `amr ['pwd','otp','mfa']`, `authTime = mfaAt = now`; 302 `returnTo` đã lưu trong vé (không đọc từ body); audit `AUTH_LOGIN_SUCCESS {mfa:'totp'}` + `SESSION_CREATED`; `throttle.onSuccess` chạy với bucket/thiết bị lưu trong vé; vé bị xoá (`DEL` = 1 là điều kiện thắng); cookie vé bị xoá.
  3. Mã khôi phục đúng ⇒ `amr ['pwd','mfa']`, mã đó hết hiệu lực, audit `MFA_RECOVERY_USED {left}`; dùng lại ⇒ sai.
  4. Mã sai: lần 1–4 ⇒ 400 cùng câu; lần 5 ⇒ vé bị xoá, 302 `/login?returnTo=…` "start again"; audit `AUTH_MFA_FAILED` lần đầu mỗi cửa sổ. 10 lần sai/900 s theo user trên **nhiều vé** ⇒ lần 11 là 429 trước khi tính mã; `AUTH_MFA_THROTTLED` đúng 1 lần (alert).
  5. Replay: mã đã dùng để đăng nhập ở tab 1 ⇒ tab 2 (vé khác, cùng bước) bị từ chối; 2 `POST /login/mfa` song song cùng vé + mã đúng ⇒ đúng 1 phiên.
  6. Khoá admin / đổi mật khẩu / tắt MFA / reset MFA xảy ra **giữa** bước 1 và bước 2 ⇒ bước 2 thất bại (re-check sau `establish`: khoá, `pwdFp = sha256(passwordHash)` trong vé, `mfa.enrolledAt` trùng lúc verify), phiên vừa tạo bị huỷ, không audit success.
  7. Vé hết hạn / không cookie / cookie lạ ⇒ 302 `/login`; CSRF thiếu/khác identity (identity = cookie vé) ⇒ 403; cookie phiên của user khác gửi kèm không ảnh hưởng (`establish` dùng `userId` của vé).
  8. Federation callback user đã enroll ⇒ vé (`amr ['fed']`, `authTime` = `upstreamAuthTime`, giữ D88.29/max_age), 302 `/login/mfa`, chưa có phiên; xong bước 2 ⇒ `amr ['fed','otp','mfa']`, re-check khoá DEBT-187; user chưa enroll ⇒ hành vi cũ không đổi.
  9. `/auth/link` mật khẩu đúng + user đã enroll ⇒ **không** liên kết (`identities` không đổi, outcome `not_linked` lý do `mfa_enrolled`), chuyển sang vé MFA để đăng nhập (D89.14, DEBT-633).
  10. `/authorize` `resource=admin`, `ADMIN_MFA_REQUIRED=true`: phiên đã thoả cổng ⇒ như cũ. Phiên không có `mfa` + user đã enroll ⇒ context `login` với `reauthAfter = now` ⇒ 302 `/login` (đăng nhập lại có bước 2) ⇒ resume cấp code. User chưa enroll ⇒ 403 trang `mfa-required.eta` có link `/account/mfa?returnTo=%2Fauthorize%3Frequest_id%3D…`, **không** code. `prompt=none` ⇒ `login_required` về RP.
  11. Phiên `amr` có `mfa` nhưng `mfaAt < user.mfa.enrolledAt` (phiên trước reset + enroll lại) ⇒ coi như không thoả (AC10).
  12. `/token` code `resource=admin` mà code thiếu `mfa`/`mfaAt` hoặc `mfaAt < enrolledAt` hiện tại hoặc user không còn enroll ⇒ `invalid_grant`, audit lý do `mfa_required`, code bị tiêu (như các re-check khác). Code mint trực tiếp không `amr` ⇒ `invalid_grant`.
  13. `RefreshToken.mfaAt` được ghi khi family sinh từ code đã thoả cổng và chép sang token kế khi rotate; refresh `resource=admin` mà family không có `mfaAt` (family có trước deploy) hoặc `mfaAt < enrolledAt` ⇒ `invalid_grant` `mfa_required`.
  14. Resource khác `admin` (vd. `api`, `demo`) + user chưa enroll ⇒ không bị cổng chặn (MFA tuỳ chọn); user đã enroll ⇒ mọi đăng nhập vẫn qua bước 2 (AC1).
  15. `ADMIN_MFA_REQUIRED=false` (test) ⇒ AC10–AC13 không áp; `amr`/`mfaAt` vẫn ghi đúng khi user có MFA.
  16. ID token sau bước 2 có `amr` đúng như session; `acr` không đổi (D88.29).
- **RED trước**: `be/test/run89-mfa-login.int-spec.ts` (AC1–AC9, AC14), `be/test/run89-admin-mfa-gate.int-spec.ts` (AC10–AC13, AC15, AC16; `ADMIN_MFA_REQUIRED=true` truyền qua `opts.env`), unit `authorize.service.spec.ts` (nhánh AC10 + `prompt=none`), `token.service.spec.ts` (predicate D89.5 bảng ca).
- **Mutation**: bỏ cổng ở `/token` (chỉ giữ `/authorize`) ⇒ AC12 đỏ; bỏ so `mfaAt ≥ enrolledAt` ⇒ AC11 đỏ; không chép `mfaAt` khi rotate ⇒ AC13 (refresh lần 2) đỏ; gọi `onSuccess` ở bước 1 ⇒ AC1 đỏ; xoá vé trước CAS ⇒ ca "Mongo lỗi, thử lại được" (AC failure) đỏ; bỏ re-check `pwdFp` ⇒ AC6 đỏ; federation callback `establish` trước khi kiểm enroll ⇒ AC8 đỏ.
- **File**: `be/src/modules/mfa/mfa-login.service.ts` (mới: vé + hoàn tất chung cho 3 đường), `be/src/modules/ui/mfa.controller.ts` (`GET/POST /login/mfa`), `be/src/views/{login-mfa.eta, mfa-required.eta}`, `be/src/modules/authentication/{authentication.service.ts, login-throttle.service.ts}` (kiểu trả `login`, `onSuccess` nhận hash thiết bị), `be/src/modules/ui/ui.controller.ts` (`loginPost`), `be/src/modules/federation/{federation.service.ts, federation.controller.ts}`, `be/src/modules/sessions/session.service.ts` (`mfaAt`), `be/src/modules/oauth/{authorize/authorize.service.ts, authorize/authorize.controller.ts, code/authorization-code.service.ts, token/token.controller.ts, token/token.service.ts, token/refresh-token.service.ts, token/schemas/refresh-token.schema.ts}`, audit enum.

### T4 [BE/ops] Reset MFA: admin API + `admin-recover --reset-mfa` + runbook (D89.16, D89.17, D89.22) — backend-dev — [x] xong (backend-dev 2026-11-13, + DEBT-640/D89.25; chờ senior lô C)

- **Cổng security**
  - **Tài sản**: yếu tố thứ hai của user khác (gỡ = hạ tài khoản về 1 yếu tố).
  - **Actor**: super_admin; tenant_admin (tenant của mình); admin tenant khác (cross-tenant); kẻ có AT admin cũ > 5'; operator CLI.
  - **Bất biến**: reset cần `admin.write` + step-up 5' (`RequireRecentAuth(5)`); target ngoài tenant ⇒ 404 như mọi route user; tenant_admin không reset được user có `super_admin` ở bất kỳ tenant nào (403, audit `target_super_admin`); reset ⇒ revoke-all + thư cho user; CLI chỉ qua xác nhận 2 người D87.12/13.
  - **Abuse**: IDOR qua id user tenant khác; reset rồi đăng nhập bằng mật khẩu đánh cắp (thư cảnh báo + alert); reset super_admin để hạ bảo vệ console (chỉ super_admin khác, alert); replay request sau network lỗi (idempotent).
  - **Failure**: revoke-all lỗi sau `$unset` ⇒ 5xx + audit `revoke_failed`, MFA vẫn đã gỡ (fe-admin `UNCERTAIN_*`); CLI: transaction abort ⇒ không đổi gì.
  - **Exposure**: response 204 không body; audit metadata `{wasEnrolled}`; CLI không in email (D87).
- **AC**
  1. `POST /admin/users/:id/mfa/reset` super_admin, target có MFA ⇒ 204; `mfa` bị gỡ; mọi phiên/family/thiết bị tin cậy của target bị thu hồi; audit `ADMIN_USER_MFA_RESET` (alert) `{wasEnrolled:true}`; thư `mfaResetByAdminMessage`.
  2. Gọi lại ⇒ 204, `{wasEnrolled:false}`, không thư.
  3. AT không `auth_time` gần (> 5') ⇒ 403 `step_up_required`; thiếu `admin.write` ⇒ 403; user tenant khác ⇒ 404; tenant_admin → target super_admin ⇒ 403, MFA còn.
  4. `AdminUserView` có `mfa: {enrolled, enrolledAt?}`; không có `secret`/`recovery`; OpenAPI + `gen:api` + `fe-admin/src/server/admin-api/schema.d.ts` khớp; `AUDIT_ACTIONS` fe-admin có 7 action mới (D89.19), `fe-admin/test/admin-schema-types.test.ts` xanh.
  5. `admin-recover --reset-mfa` (+ xác nhận 2 người): trong **cùng** transaction `SuperAdminGuard`: `$unset mfa`, thu hồi mọi refresh family của user (Mongo), audit `ADMIN_RECOVERED {mfaReset:true}`; `--dry-run` in kế hoạch `mfa: reset`, không kết nối; tham số allowlist giữ nguyên quy tắc không echo. Không đụng Redis; sau đó phiên cũ của user không lấy được code `admin` (D89.5, phiên có `mfaAt` cũ hơn lần enroll mới hoặc user chưa enroll).
  6. Runbook: `runbook-ops.md` mục mới "Mất yếu tố thứ hai" (ai được yêu cầu, xác minh danh tính qua kênh thứ hai trước khi reset — ASVS 6.4.4; đường API vs CLI; user enroll lại ngay ⇒ revoke-all); "Xoay `MFA_ENCRYPTION_KEYS`" (thêm khoá mới lên đầu, deploy, chỉ gỡ kid cũ khi `db.users.countDocuments({'mfa.secret.kid':'<cũ>'}) == 0`; mất mọi khoá = mọi user mất MFA ⇒ reset hàng loạt có ticket). `runbook-deploy.md` §17 theo D89.22.
- **RED trước**: `be/test/run89-admin-mfa-reset.int-spec.ts` (AC1–AC4), `admin-recover.spec.ts` (parse `--reset-mfa`, dry-run), `run87-admin-recover.int-spec.ts` thêm ca AC5 (transaction abort khi audit lỗi ⇒ `mfa` còn).
- **Mutation**: bỏ `assertMayTouchAccount`/kiểm super_admin ⇒ AC3 đỏ; `$unset` ngoài transaction CLI ⇒ AC5 (audit lỗi) đỏ; bỏ revoke-all ⇒ AC1 đỏ.
- **File**: `be/src/modules/admin/{admin-users.controller.ts, admin.mappers.ts, dto}`, `be/src/database/admin-recover.ts` (+ spec), OpenAPI sinh, `fe-admin/src/server/admin-api/schema.d.ts`, `fe-admin/src/features/admin-api/inputs.ts`, `docs/agile/sso-idp/{runbook-ops.md, runbook-deploy.md}`.

### T5 [FE] fe-admin: trạng thái MFA + Reset MFA — frontend-dev — [x] xong (frontend-dev 2026-11-13; fe-admin test 1649/1649, mutation 9/9 đỏ; chờ senior lô C)

- **AC**
  1. Chi tiết user (`fe-admin/src/routes/users/$userId.tsx`) hiện "Two-step verification: On (since …)" / "Off" từ `mfa`.
  2. Nút "Reset two-step verification" chỉ khi `enrolled` và actor có `admin.write`; hộp xác nhận nêu hậu quả (đăng xuất mọi nơi, user phải enroll lại để vào console); mutation qua BFF với mẫu step-up hiện có (`step-up.ts`: `step_up_required` ⇒ `prompt=login&max_age=0` rồi quay lại, lần này đi qua TOTP) và mẫu `UNCERTAIN_*` khi lỗi mạng (hiện "không chắc đã reset, tải lại để kiểm", không tự thử lại).
  3. 403/404 ⇒ thông báo cố định không lộ chi tiết; sau thành công tải lại dữ liệu user (trạng thái Off).
  4. Danh sách audit hiển thị nhãn cho 7 action mới.
  5. Không lưu gì về MFA ở client ngoài response; test không snapshot giá trị nhạy cảm.
- **RED trước**: test component/route trong `fe-admin/test/` (hiện/ẩn nút theo quyền + trạng thái, step-up, `UNCERTAIN_*`, 403/404).
- **Mutation**: hiện nút khi chỉ có `admin.read` ⇒ đỏ; tự retry sau lỗi mạng ⇒ đỏ.
- **File**: `fe-admin/src/routes/users/$userId.tsx`, `fe-admin/src/features/admin-api/*` (hàm `resetUserMfa`), `fe-admin/src/features/audit/*` (nhãn), `fe-admin/test/*`.

### T6 [QA] E2E qua TOTP + spec MFA + checklist + gate (D89.20, D89.21) — tester — [x] xong (tester 2026-11-16: E2E 52/52 ×2, X3 42/42, int FULL 89/89 2393/2393, `test-report.md`)

- **AC**
  1. `e2e/tests/support/totp.ts` (`node:crypto`, không dependency) + `e2e/tests/totp.spec.ts` (không trình duyệt) đạt vector RFC 6238 SHA-1 như T1 AC1.
  2. Bộ cấp bước theo secret (trong tiến trình): bước kế = `max(last+1, c-1)`; nếu > `c+1` ⇒ chờ tới đầu bước `next-1` + 1 s; khi IdP báo mã không được nhận ⇒ chờ bước kế và thử lại **1** lần (ca `E2E_REUSE=1`). Log tổng thời gian chờ ở cuối suite.
  3. `seed:e2e-admin` enroll admin E2E và `E2E_USER` bằng `E2E_ADMIN_TOTP_SECRET` / `E2E_USER_TOTP_SECRET` (base32 placeholder không bí mật ở `e2e/config/env.ts`, truyền qua `beEnv()`), mã hoá bằng `MFA_ENCRYPTION_KEYS` của `beEnv()`, `lastStep` gỡ, `enrolledAt = now`, recovery rỗng; seed user `E2E_MFA_USER` **không** MFA (đặt lại mỗi lượt). `seed-e2e-admin.int-spec.ts` cập nhật.
  4. `adminToken`, `signInAsAdmin` (support) và hai bản cục bộ (`admin-api-risk.spec.ts`, `fe-admin.spec.ts`) điền mã khi gặp `/login/mfa`; mọi spec admin cũ xanh không nới kỳ vọng.
  5. `e2e/tests/mfa.spec.ts`: (a) `E2E_MFA_USER` enroll qua `/account/mfa` (đọc khoá từ trang, tính mã), thấy 10 mã đúng 1 lần, bị đăng xuất; (b) đăng nhập đòi mã, mã sai ×5 ⇒ phải nhập lại mật khẩu; (c) replay mã vừa dùng ⇒ từ chối; (d) mã khôi phục đăng nhập được 1 lần, lần 2 từ chối; (e) user chưa enroll vào fe-admin ⇒ trang "requires two-step verification"; (f) federation (mock Google) user đã enroll ⇒ trang bước 2, chưa có phiên trước khi nhập mã; (g) admin Reset MFA qua fe-admin ⇒ user đăng nhập không cần mã, rồi enroll lại được.
  6. Gate: be typecheck/lint/unit, int FULL (`vg-int-*` 0→0), vault (container thử, xoá sau), fe-admin typecheck + test, E2E full ×2, X3 42 (beEnv X3 có khoá; user X3 không enroll ⇒ không đổi), `assert-dist-clean` xanh (helper `enrollForTest`/seed không vào `dist`).
  7. Đo thời gian E2E full so với run 88; tăng > 50% ⇒ làm D89.21 (dùng lại phiên IdP cho `adminToken` không `forceLogin`) trong run này và đo lại; ghi số đo vào `test-report.md`.
  8. Checklist: C-6.3.3 ❌ ⇒ ✅ (bằng chứng int + E2E), C-6.4b N/A ⇒ ✅/⚠ (reset mật khẩu không gỡ MFA; mất yếu tố ⇒ reset có xác minh, runbook-ops), C-6.5 N/A ⇒ chấm lại (lookup secret = mã khôi phục; OOB vẫn N/A), C-6.3.4 thêm bằng chứng federation không bỏ qua MFA; đếm lại P0 ❌ = 0; `security-matrix.md` thêm hàng MFA (replay, brute force, bỏ qua qua federation/link/`prompt=none`, cổng `/token`/refresh).
- **File**: `e2e/tests/support/{totp.ts, admin.ts, fe-admin.ts}`, `e2e/tests/{totp.spec.ts, mfa.spec.ts, admin-api-risk.spec.ts, fe-admin.spec.ts}`, `e2e/config/env.ts`, `e2e/x3/env.ts`, `be/test/e2e/seed-e2e-admin.ts`, `be/test/seed-e2e-admin.int-spec.ts`, `docs/agile/sso-idp/{release-checklist.md, security-matrix.md}`, `runs/89-X6-mfa/test-report.md`.

### Ảnh hưởng E2E / X3 / fe-admin (tóm tắt)
- E2E: mọi đăng nhập admin và `E2E_USER` qua TOTP thật; secret cố định không bí mật cấp qua env của E2E; không cài gói nào. Luật replay ⇒ tối đa ~1 lần đăng nhập/30 s/user khi dồn; bộ cấp bước tận dụng cửa sổ ±1 (3 lần liền) rồi chờ.
- X3: chỉ thêm `MFA_ENCRYPTION_KEYS` vào env; không user nào enroll ⇒ 42 ca không đổi.
- fe-admin: `gen:api` (view user + enum audit) + T5; luồng đăng nhập BFF không đổi (`prompt=login&max_age=0` sẵn có tự đi qua bước 2).

### Migration / deploy (runbook-deploy §17, T4 viết)
1. Sinh khoá: `openssl rand -base64 32`, đặt `MFA_ENCRYPTION_KEYS=k1:<base64>` vào env của app **và** mọi CLI (`db:bootstrap`, `db:admin-recover`, `db:sync-indexes` dùng `validateEnv` đầy đủ); lưu ở secret store, **không** cùng chỗ backup Mongo; restore drill cần khoá này (ghi vào runbook backup).
2. `ADMIN_MFA_REQUIRED` để trống (= `true`). Không đặt `false` ở production (boot bị từ chối).
3. Trước deploy: `db.users.countDocuments({mfaSecret:{$exists:true}})` phải = 0 (placeholder chưa từng ghi); nếu > 0 ⇒ `$unset` theo mẫu §15 (dry-run trước).
4. Sau deploy: mọi refresh family `resource=admin` cũ ⇒ `invalid_grant` ở lần refresh kế ⇒ fe-admin đăng nhập lại 1 lần; mỗi admin phải enroll ở `/account/mfa` trước khi vào console (trang hướng dẫn tự hiện). Admin mất thiết bị trước khi có admin thứ hai ⇒ `admin-recover --reset-mfa`.
5. Người dùng (dev): thêm `MFA_ENCRYPTION_KEYS` vào `be/.env` từ `be/.env.example`, nếu không app dev không boot.

## Quyết định D89.x

- **D89.1 Chia lô + cắt phạm vi**: 4 lô như bảng. DEBT-334 (xem phiên/danh tính của user trong admin) ra khỏi run 89 ⇒ sau phát hành: không phải dòng ❌ (E-334 ⚠ P2), chỉ đọc, admin đã có "revoke all sessions"; giữ run 89 vừa một lượt review. Run 90 không đổi.
- **D89.2 Module**: `be/src/modules/mfa/` (`MfaModule`: thuần `totp`/`base32`/`mfa-crypto`/`recovery-codes`; `MfaService` = trạng thái Mongo; `MfaLoginService` = vé Redis + hoàn tất chung cho `/login`, callback federation, `/auth/link`). Route HTML ở `be/src/modules/ui/mfa.controller.ts` dùng `UiSessionHelper` (DEBT-632). Không service/container mới.
- **D89.3 Dữ liệu**: `User.mfa` `select:false` như T1 AC6; đọc có chủ đích (`+mfa` chỉ trong `MfaService`, projection `mfa.enrolledAt` cho admin view/cổng). `mfaSecret` bị xoá khỏi schema.
- **D89.4 Env + test**: `MFA_ENCRYPTION_KEYS` bắt buộc mọi `NODE_ENV` (không có đường "MFA tắt vì thiếu khoá"); production từ chối khoá trong `.env.example`. `ADMIN_MFA_REQUIRED` mặc định `true`, `false` chỉ ngoài production. Harness int (`full-app.ts`) đặt `ADMIN_MFA_REQUIRED=false` (cùng tiền lệ `KEY_PREPUBLISH_SEC=0`), spec run 89 truyền `true` qua `opts.env`; E2E/X3 chạy mặc định `true` (giống production). Lý do: bật mặc định ở int sửa ~46 file không liên quan mà không thêm bằng chứng nào ngoài các spec cổng riêng.
- **D89.5 Cổng `admin`**: `adminMfaSatisfied = amr ∋ 'mfa' ∧ mfaAt có ∧ user.mfa.enrolledAt có ∧ mfaAt ≥ enrolledAt`. Trường mới `mfaAt` (ms) trên `SessionData`, `AuthorizationCodeData`, `RefreshToken` (chép khi rotate). Kiểm ở `/authorize` (trước consent, và trong `issueCode`/`issueCodeFromContext`), `/token` code (`recheckCodeGrant`, lý do `mfa_required`) và refresh (callback re-check). Thay cho D88.24 "family thừa hưởng": family có trước deploy không có `mfaAt` ⇒ bị từ chối (fail-closed, fe-admin đăng nhập lại 1 lần). So `enrolledAt` làm phiên/code/family có trước một lần reset + enroll lại vô dụng với `admin` mà không cần CLI chạm Redis.
- **D89.6 `/authorize` thiếu MFA**: bỏ "nâng `amr` trên phiên hiện có" (D88.24): enroll/reset luôn revoke-all nên phiên đã enroll mà thiếu `mfa` chỉ còn là ca race ⇒ context `login` `reauthAfter=now` ⇒ đăng nhập lại. Chưa enroll ⇒ 403 `mfa-required.eta` + link `/account/mfa?returnTo=/authorize?request_id=…`. `prompt=none` ⇒ `login_required`. Context 10' có thể hết trong lúc enroll lần đầu ⇒ trang hết hạn sẵn có, admin mở lại console (DEBT-636).
- **D89.7 Kiểu trả `login()`**: `{kind:'session', …} | {kind:'mfa', ticketId}`. Bước 1 chạy đủ kiểm như cũ (throttle reserve, Argon2, `clearFailedLoginsIfUnlocked`) rồi mới rẽ; mật khẩu đúng + MFA chờ **không** xoá bucket, không cấp thiết bị tin cậy, không audit success (kẻ có mật khẩu vẫn tốn lượt D85.2).
- **D89.8 Vé**: Redis hash `mfa_pend:{sha256(id)}` TTL 300 cố định: `userId, returnTo (safeReturnTo), amr, firstAuthTime, pwdFp, buckets (JSON), deviceHash, trustDevice, deviceLabel, fails`. Cookie `__Host-idp_mfa` khi `SESSION_COOKIE_SECURE`, ngược lại `idp_mfa`. Sai ⇒ `HINCRBY fails` (≥ 5 ⇒ `DEL`). Đúng ⇒ verify ⇒ CAS `lastStep` ⇒ `DEL` (= 1 mới thắng) ⇒ `establish` ⇒ re-check ⇒ audit ⇒ `onSuccess`. CSRF identity = cookie vé. Limiter IP `login_mfa` như `/login`.
- **D89.9 Giới hạn theo user**: key `mfa_fail:{userId}` 10/900 s, reserve trước khi tính mã, refund khi đúng; dùng chung cho `/login/mfa` và `/account/mfa/*`. `AUTH_MFA_FAILED` lần đầu mỗi cửa sổ, `AUTH_MFA_THROTTLED` (alert) lần đầu bị chặn.
- **D89.10 TOTP**: RFC 6238 SHA-1/6/30 s, ±1 bước, so cả 3 bằng `timingSafeEqual`, nhận bước khớp > `lastStep`; enroll ghi `lastStep` = bước của mã xác nhận.
- **D89.11 Mã khôi phục**: như T1 AC9; ô nhập chung "Code": 6 chữ số ⇒ TOTP, còn lại ⇒ mã khôi phục. `/account/mfa` hiện số mã còn lại.
- **D89.12 Mã hoá**: như T1 AC4; mã hoá lại lười trong cùng update CAS khi verify đúng; secret chờ enroll cũng mã hoá (AAD riêng). Không bulk re-encrypt ở run này (DEBT-635).
- **D89.13 `/account/mfa`**: `GET /account/mfa`, `POST /account/mfa/{start,confirm,disable,recovery}`; secret chờ ở `mfa_enr:{sessionRef}` TTL 600; không QR (DEBT-625); nhãn `otpauth` cố định `Veyrigate`.
- **D89.14 Federation**: callback user đã enroll ⇒ vé như `/login`. `/auth/link` user đã enroll ⇒ không liên kết ở bản phát hành này (chỉ đăng nhập qua vé), DEBT-633 — tránh để kẻ có mật khẩu (chưa qua yếu tố 2) gắn danh tính mới vào tài khoản.
- **D89.15 Thời điểm + `amr`**: đường mật khẩu `authTime = mfaAt = lúc xong bước 2` (hai yếu tố cách nhau ≤ 300 s); federation `authTime = upstreamAuthTime` (giữ bất biến max_age), `mfaAt = lúc xong bước 2`. `amr`: `[gốc,'otp','mfa']` (TOTP) / `[gốc,'mfa']` (mã khôi phục).
- **D89.16 Reset qua API**: như T4 AC1–AC3; idempotent 204 (hợp mẫu `UNCERTAIN_*`); tự reset chính mình được phép (đã qua step-up có TOTP; hậu quả chỉ là phải enroll lại).
- **D89.17 Reset qua CLI**: `admin-recover --reset-mfa` chỉ Mongo, trong transaction; không thu hồi phiên Redis (CLI giữ đặc tính Mongo-only của D87); phiên cũ không vào được `admin` nhờ D89.5, còn với RP khác sống tới khi user enroll lại (revoke-all) hoặc hết hạn — DEBT-634.
- **D89.18 Thư**: 4 mẫu (bật, tắt, tạo lại mã, admin reset), không chứa mã/secret, link `/account/mfa`; fire-and-forget như thư đổi mật khẩu.
- **D89.19 Audit**: `AUTH_MFA_FAILED`, `AUTH_MFA_THROTTLED`*, `MFA_ENROLLED`, `MFA_DISABLED`*, `MFA_RECOVERY_REGENERATED`, `MFA_RECOVERY_USED`, `ADMIN_USER_MFA_RESET`* (* = `ALERT_ACTIONS`); `ADMIN_RECOVERED` thêm `mfaReset`. Không bao giờ ghi mã, secret, `otpauth`.
- **D89.20 E2E lấy mã TOTP**: helper `node:crypto` trong `e2e/` (chép ~25 dòng, tự kiểm bằng vector RFC — không import từ `be/`, không thêm gói); secret cố định không bí mật trong `e2e/config/env.ts` ⇒ `beEnv()` ⇒ `seed:e2e-admin` ghi `User.mfa` qua helper test T1 AC11; bộ cấp bước T6 AC2 tôn trọng luật replay thay vì nới luật ở server.
- **D89.21 Ngân sách E2E**: tăng > 50% thời gian full ⇒ `adminToken` không `forceLogin` dùng lại cookie phiên IdP đã qua MFA (cache theo user, phiên chết ⇒ đăng nhập lại qua TOTP); làm trong run 89, không để sang 90.
- **D89.22 Deploy**: như mục "Migration / deploy"; không có migration dữ liệu ngoài kiểm `mfaSecret`.
- **D89.23 Tài khoản không mật khẩu**: tắt MFA/tạo lại mã = phiên < 5' + TOTP (thay "mật khẩu + TOTP" của D88.28/D88.29).
- **D89.24 Nhãn phiên**: `/account/sessions` hiện phương thức có "+ authenticator" khi `amr ∋ 'mfa'`.
- **D89.25 Trần lỗi liên tiếp yếu tố 2 (DEBT-640, backend-dev lô C, NIST 800-63B §5.2.2 ≤ 100)**: `User.mfa.failures` (Mongo, `$inc` mỗi mã sai ở `/login/mfa` và `/account/mfa/*`, mọi vé/cửa sổ; `$unset` khi **bất kỳ** mã đúng — TOTP hay mã khôi phục — trong cùng update CAS). Trần `MFA_FAILURE_CAP = 50`: từ đó **mã TOTP bị từ chối kể cả đúng** (câu cố định "Authenticator codes are blocked…", không tính thêm lỗi), **mã khôi phục vẫn nhận** (80 bit, vẫn qua giới hạn 10/900 s) và mở lại; `resetPassword` (chứng minh hộp thư) `$unset failures`; reset MFA (admin/CLI) gỡ cả `mfa`. Đúng lúc chạm trần: audit `AUTH_MFA_LOCKED` (alert, `{via, failures}`) một lần + thư `mfaLockedMessage` cho user. Kẻ chỉ có mật khẩu đẩy được tới trần nhưng **không** khoá vĩnh viễn chủ tài khoản (mã khôi phục / `/forgot`); alert là tín hiệu "mật khẩu đã lộ". Không thêm Redis, không thời gian chờ tự mở (tránh để kẻ tấn công chỉ cần chờ). Runbook-ops §11.
- **D89.26 Thư reset MFA (DEBT-642)**: `POST /admin/users/:id/mfa/reset` gửi thư ngay khi CAS gỡ `mfa` thành công, **trước** revoke-all; revoke lỗi + gọi lại (`wasEnrolled:false`) vẫn đúng 1 thư.
- **D89.27 Mất thiết bị, tự phục vụ (DEBT-643)**: `/account/mfa/{disable,recovery}` nhận mật khẩu (hoặc phiên < 5' với tài khoản không mật khẩu) + **TOTP hoặc mã khôi phục**; mã khôi phục bị tiêu (`MFA_RECOVERY_USED {left, via:'account'}`), audit thành công mang `{factor:'totp'|'recovery_code'}`; mã đúng xoá bộ đếm D89.25. Runbook-ops §11.
- **D89.28 Reset mật khẩu không xoá trần (DEBT-644)**: `resetPassword` không còn đụng `mfa.failures`; chỉ mã khôi phục (hoặc TOTP khi dưới trần) và reset MFA admin/CLI xoá. Quy tắc alert: `AUTH_MFA_LOCKED` ≥ 2 lần/24 h cùng user ⇒ admin khoá + xác minh kênh 2 (runbook-ops §11, `security-matrix.md`). Kèm: trần nằm trong filter CAS TOTP (chính xác khi song song); kiểm quyền reset dùng một lần đọc membership (`touchRefusal`), lỗi DB không bị gắn nhãn `target_not_allowed`; thư khoá có câu "Someone else knows your password".
- **D89.29 Tenant của audit MFA (DEBT-645)**: mọi audit bước 2 (`AUTH_MFA_FAILED/THROTTLED/LOCKED`, `MFA_RECOVERY_USED`, `AUTH_LOGIN_SUCCESS/FAILED`, `SESSION_CREATED`) mang `tenantId` = tenant của phiên IdP mà vé tạo (`DEFAULT_TENANT_ID`, như `establish`); audit `/account/mfa` (`MFA_ENROLLED/DISABLED/RECOVERY_REGENERATED/RECOVERY_USED`, `AUTH_REAUTH_FAILED`, `revoke_failed`) mang `session.tenantId` ⇒ admin của tenant thấy qua `GET /admin/audit`. Các audit đăng nhập cũ không qua MFA (`AUTH_LOGIN_FAILED` của `login()`…) vẫn chưa có tenant — ngoài phạm vi, không đổi.
- **D89.30 CSP `form-action` của `/login/mfa` (DEBT-647, blocker E2E tester T6)**: POST `/login/mfa` kết thúc bằng 302 `/authorize?request_id` → 302 RP; Chromium áp `form-action` của trang form cho cả chuỗi (DEBT-084) nên GET `/login/mfa` và mọi lần render lại 400 (mã sai, bị chặn) đặt CSP theo từng response như `GET /login`: thêm đúng một origin RP khi `returnTo` của vé là đúng `/authorize?request_id=<id>` của context còn sống (peek, không tiêu), còn lại `'self'`; Redis lỗi ⇒ `'self'`. Logic dùng chung `UiSessionHelper.setLoginFormActionCsp` (chuyển từ `UiController`). Các trang MFA khác không có chuỗi POST→RP (`mfa-required` và trang mã khôi phục chỉ có link GET). Kèm DEBT-646: câu "bị chặn" thành "Use a recovery code. If you have none left, contact your administrator." (không còn gợi ý đặt lại mật khẩu, khớp D89.28).

## Tiêu chí xong run
- be typecheck/lint/unit, int FULL (`vg-int-*` 0→0), vault (container thử, xoá sau), fe-admin typecheck + test, E2E full ×2 + X3 42 qua TOTP, `assert-dist-clean`; checklist C-6.3.3 ✅, P0 ❌ = 0; runbook-deploy §17 + runbook-ops (mất yếu tố, xoay khoá) viết xong; senior PASS lô B và lô C.
