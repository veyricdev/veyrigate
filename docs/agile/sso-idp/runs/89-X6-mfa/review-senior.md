# Senior Review — 2026-11-13 (run 89, lô A+B: T0–T3, working tree trên `2fd23ee`)

## Kết luận: PASS

Không có 🔴. Có 5 🟡 (vào backlog DEBT-637…641) và vài 💭. Chuyển **tester**, nhưng có **điều kiện quy trình** (không phải lỗi code): T0–T3 chỉ được tick sau khi backend-dev/tester chạy **int FULL** (`vg-int-*` 0→0, dọn 3 DB `vg-int-tenantiso-*` còn sót) và chạy lại **13 mutation T2/T3** đã mất output. Senior không chạy int (hai jest PID 49420/8500 vẫn treo, không đụng `vg:int-lock`).

Verify do senior tự chạy: `pnpm -C be typecheck` ✅, `lint` ✅, `test` (unit) 59 suite / 1174 ✅, fe-admin `typecheck` ✅ + `test` ✅.

## Tổng quan

Lô B là phần nhạy cảm nhất của run, và diff bám sát fold. Mấy điểm tốt nên ghi lại:

- **Thứ tự `MfaLoginService.complete`** (`mfa-login.service.ts:204-318`) đúng D89.8: reserve limiter theo user → kiểm mã (Mongo CAS) → `DEL` vé (= 1 mới thắng) → `establish` → re-check → audit → `onSuccess`. Mongo lỗi ở CAS thì vé còn nguyên, thử lại được (có int). Hai POST song song trên cùng vé ⇒ một bên thua CAS `lastStep` hoặc thua `DEL`, nên chỉ có một phiên (có int). Re-check sau `establish` đủ ba thứ: khoá, `pwdFp`, `enrolledAt`. DB lỗi ở re-check thì huỷ phiên vừa tạo rồi ném lỗi.
- **Bước 1 không cho gì khi user đã enroll**: `login()` rẽ sang `{kind:'mfa'}` **sau** mọi kiểm tra (throttle reserve, Argon2, `clearFailedLoginsIfUnlocked`) và **trước** `establish`/`onSuccess`/audit success. Bucket không bị xoá, không cấp thiết bị tin cậy. Vé chỉ lưu `sha256(deviceCookie)`, không lưu cookie. Đúng D89.7.
- **Ba đường tạo phiên đều đi qua một chỗ**: `/login`, callback federation (`federation.service.ts:202`, kiểm enroll **trước** `establish`), `/auth/link` (có MFA ⇒ không link, chuyển sang vé). Không còn đường nào chép riêng logic re-check.
- **TOTP**: `verifyTotp` so cả 3 bước bằng `timingSafeEqual`, không thoát sớm, chỉ nhận bước lớn hơn `lastStep`. CAS `$or:[{lastStep:{$lt:s}}, {lastStep:{$exists:false}}]` kèm `enrolledAt` chặn replay giữa các instance, và chặn luôn mã của một lần enroll cũ. Re-seal lười nằm trong **cùng** update CAS.
- **Keyring**: AES-256-GCM, iv 12 byte, `authTagLength: 16`. AAD buộc `userId`, bản chờ enroll có AAD riêng. `open` không bao giờ ném lên request. Log chỉ có `kid` (đã lọc qua regex) + `requestId`. Parse env chỉ báo tên biến + vị trí phần tử. `validateEnv` chỉ in `path: message`, không in input.
- **Mã khôi phục**: 80 bit CSPRNG, hash `sha256(salt‖code)`, salt riêng mỗi user, dùng một lần bằng `$pull` có điều kiện (CAS), tạo lại thì đổi salt. Không có bản rõ ở đâu ngoài trang `no-store`.
- **Cổng `admin` là một predicate** (`adminMfaSatisfied`) dùng ở `/authorize` (trước consent, trong `issueCode*`, và trong `decideConsent`), `/token` code (`recheckCodeGrant`) và refresh (callback re-check). Code không có `amr`/`mfaAt`, family không có `mfaAt`, hoặc `mfaAt < enrolledAt` ⇒ fail-closed. `resource` ở body `/token` không đổi được `aud`, nên không có đường vòng.
- **T0** gọn. Secret là dòng đầu tiên. Mọi dòng in sau commit đều có câu hướng dẫn rotate. Alert lặp theo danh sách audit thật. `revokeOwnedRef` luôn ghi tombstone. `UiSessionHelper` gom đúng ba thứ.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| User đã enroll không có phiên nếu chưa qua bước 2 (`/login`, federation, `/auth/link`) | ✅ ở cả ba đường; ⚠ còn một khe race hẹp khi enroll diễn ra **giữa** lúc bước 1 đọc `mfaEnrolledAt` và lúc `establish` (🟡-1) | int `run89-mfa-login` AC1/AC14, `federation.int-spec` run 89 AC8/AC9 |
| Thiết bị tin cậy không miễn bước 2; bucket/thiết bị chỉ được áp sau bước 2 | ✅ `onSuccess(buckets, …, deviceHash)` chỉ chạy trong `complete` | int AC1, AC2 |
| Một bước TOTP được nhận tối đa 1 lần (mọi instance), kể cả mã đã dùng để enroll | ✅ CAS `lastStep` + `enrolledAt`; enroll ghi `lastStep` = bước xác nhận | int mfa-state AC8 (20 song song ⇒ 1), account-mfa AC4, mfa-login AC5 |
| Mã khôi phục dùng tối đa 1 lần | ✅ `findOneAndUpdate` lọc theo `hash` + `$pull` | int mfa-state AC8 (10 song song ⇒ 1), mfa-login AC3 |
| So sánh hằng thời gian | ✅ TOTP `timingSafeEqual` cả 3 bước (unit có spy); CSRF `constantTimeEqual`; mã khôi phục so qua hash có salt trong truy vấn (không có oracle thời gian có nghĩa); `pwdFp` chỉ so phía server | unit `totp.spec` |
| Vé: TTL / số lần / ràng buộc trình duyệt | ✅ Redis `mfa_pend:{sha256(id)}` TTL 300 cố định (HSET+EXPIRE trong MULTI; Lua `HINCRBY` chỉ chạy khi key còn, không hồi sinh key mất TTL); 5 lần sai ⇒ `DEL` + phải nhập lại mật khẩu; cookie `__Host-idp_mfa` HttpOnly/Lax; id thô chỉ có trong cookie | int AC1, AC4, AC7 |
| Brute force qua nhiều vé | ✅ `mfa_fail:{u:…}` 10/900 s, reserve **trước** khi tính mã, refund khi đúng, dùng chung với `/account/mfa/*`; ⚠ không có trần lỗi liên tiếp dài hạn (🟡-4) | int AC4 |
| CSRF mọi POST mới | ✅ `/account/mfa/{start,confirm,disable,recovery}` có `CsrfGuard`; `/login/mfa` dùng identity = cookie vé (cookie phiên của người khác không tính) | int account-mfa AC8, mfa-login AC7 |
| Xác thực lại trước khi tắt / tạo lại mã | ✅ `bothFactors`: luôn đòi mật khẩu (không có đường tắt "phiên mới"), qua bucket `pwc:`, **và** TOTP hiện tại (không nhận mã khôi phục, có tiêu thụ bước); tài khoản không mật khẩu: phiên < 5' + TOTP; disable/regenerate là CAS theo `enrolledAt` | int account-mfa AC6, AC7 |
| Enroll cần xác thực lại + mã đúng từ secret chờ của **chính phiên đó** | ✅ `start` qua D88.18; secret chờ ở `mfa_enr:{sessionRef}`, đóng gói với AAD `totp:enr:v1:<userId>`; CAS `mfa:{$exists:false}` | int AC2, AC3, AC5 |
| Phiên/code/family có trước một lần reset + enroll lại thì vô dụng với `admin` | ✅ `mfaAt ≥ enrolledAt` ở cả 3 điểm; `RefreshToken.mfaAt` được chép khi rotate (một đường rotate duy nhất, `refresh-token.service.ts:498/532`) | int admin-mfa-gate AC11, AC12 (bảng), AC13 (refresh 2 lần) |
| `prompt=none` không lách được cổng | ✅ `login_required` về RP, không tạo context | int gate AC10 |
| Sau resume, phiên cũ không dùng lại được context `reauth` | ✅ `reauthAfter = now`; `resume` từ chối `authTime < reauthAfter` | int gate AC10 |
| Lộ dữ liệu: `mfa` không ra khỏi server | ✅ `select:false`, `PUBLIC_FIELDS '-mfa'`, `mfaEnrolledAt` chỉ project `mfa.enrolledAt`; không có `collection.find`/aggregate nào trên `users` trả document ra ngoài | int mfa-state AC6, account-mfa AC9 |
| Enumeration | ✅ chỉ người có mật khẩu đúng (hoặc phiên Google của user) mới biết user có MFA; `/login/mfa` không hiện email; mã sai là một câu cố định | int AC4, AC7 |
| XSS ở view mới | ✅ 4 view chỉ dùng `<%= %>` (autoEscape); `otpauth` có prefix cố định, nhãn đã `encodeURIComponent`; `continueUrl`/`enrollUrl` dựng từ đường dẫn đã `safeReturnTo` | đọc code |
| Open redirect qua `returnTo` của bước 2 | ✅ lưu trong vé sau `safeReturnTo` ở `/login`, federation dùng `resumeUrl(requestId)`, lúc thành công lại qua `safeReturnTo`; không đọc từ body ở bước 2; `restart` chỉ đưa về `/login?returnTo=` (sẽ được kiểm lại) | int AC2 |
| Failure: Redis/Mongo lỗi | ✅ tạo vé lỗi ⇒ 5xx, không phiên; CAS lỗi ⇒ 5xx, vé còn; re-check lỗi ⇒ huỷ phiên + 5xx (⚠ nhánh này chưa có test, 🟡-5) | int "Mongo error at the code check" |
| Env không echo khoá | ✅ `parseMfaKeys` chỉ báo vị trí; production từ chối khoá `.env.example` (so theo giá trị, mọi kid) và `ADMIN_MFA_REQUIRED=false` | unit `validation.schema.spec` (có ca `not.toContain(ex)`) |

## 🟡 Nên sửa

1. 🟡 **Race: enroll đồng thời với bước 1 của người đã có mật khẩu** — `authentication.service.ts:223` / `federation.service.ts:202`. Đọc `mfaEnrolledAt` xong mới `establish`. Re-check sau `establish` (`authentication.service.ts:258-266`, `federation.service.ts:233`) chỉ kiểm khoá và hash mật khẩu, không kiểm enroll.
   Vì sao: nếu enroll của nạn nhân (ghi Mongo → revoke-all) lọt vào giữa "đọc `null`" và "`establish`", phiên mật-khẩu-only được tạo **sau** sweep sẽ sống, trái bất biến "user đã enroll không có phiên khi chưa qua bước 2". Cửa sổ chỉ vài ms và bị login bucket giới hạn. Console `admin` vẫn an toàn nhờ D89.5, nên đây không phải 🔴, nhưng RP khác thì bị ảnh hưởng.
   Đề xuất: trong cùng khối re-check, đọc thêm `users.mfaEnrolledAt(sub)`; khác `null` ⇒ huỷ phiên vừa tạo và trả lỗi chung như DEBT-141. Mutation: bỏ dòng này ⇒ một unit đỏ (stub `mfaEnrolledAt` trả `null` rồi `Date`). → **DEBT-637**
2. 🟡 **Logic xác thực lại bị chép lần hai** — `mfa.controller.ts:302-331` `firstFactor` gần như là bản sao của `account.controller.ts:336-380` `reauth` (cửa sổ 5', `hasPassword`, `verifyCurrentPassword`, audit `reauth_failed`/`reauth_throttled` một lần, 429). Có cả hai hằng `NO_PASSWORD_REAUTH` khác chữ.
   Vì sao: DEBT-632 được mở ra chính để không chép logic phiên/xác thực giữa các controller. Lần sửa D88.18 kế tiếp (ví dụ đổi cửa sổ, đổi luật audit) sẽ phải sửa hai chỗ. Bản MFA cũng đã lệch: audit thất bại thiếu `ip`/`userAgent`/`requestId`.
   Đề xuất: một `reauth(session, password, {action, metadata, alwaysPassword})` trong `UiSessionHelper` (hoặc `AuthenticationService`), cả hai controller gọi chung. → **DEBT-638**
3. 🟡 **Audit thất bại mang action có alert** — `mfa.controller.ts:316-326` và `:369-381` ghi `MFA_DISABLED` (thuộc `ALERT_ACTIONS`) với `result:'failure'` cho `reauth_failed` / `reauth_throttled` / `revoke_failed`. `AuditService.record` (`audit.service.ts:147`) bắn alert theo action, không xét `result`.
   Vì sao: gõ sai mật khẩu ở form "Turn off" cũng phát alert "MFA_DISABLED" dù chưa có gì bị tắt. On-call sẽ nhận nhiễu, và dễ coi thường alert thật. (`revoke_failed` sau khi đã tắt thì alert là đúng.)
   Đề xuất: ghi thất bại xác thực lại dưới một action không có alert (ví dụ `AUTH_REAUTH_FAILED`, hoặc `MFA_DISABLE_FAILED`), hoặc cho `record` chỉ alert khi `result:'success'` với các action "đã đổi trạng thái". Kèm một test: sai mật khẩu ở `/account/mfa/disable` ⇒ không có alert. → **DEBT-639**
4. 🟡 **Brute force TOTP chỉ bị giới hạn tốc độ, không có trần** — `mfa-login.service.ts:23-25`: 10 lần / 900 s / user, không có giới hạn lỗi liên tiếp dài hạn.
   Vì sao: người đã có mật khẩu thử được khoảng 960 mã/ngày. Với cửa sổ ±1 bước, xác suất trúng khoảng 0,3 %/ngày, nghĩa là khoảng 50 % sau chừng 8 tháng nếu không ai để ý. NIST 800-63B §5.2.2 đặt trần ≤ 100 lần sai liên tiếp. Alert `AUTH_MFA_THROTTLED` chỉ bắn một lần mỗi cửa sổ. Ngược lại, chính bucket này cũng cho người có mật khẩu chặn bước 2 của chủ tài khoản (lockout vector, cùng loại DEBT-575). Chủ tài khoản thoát được bằng reset mật khẩu, vì kẻ tấn công sẽ mất bước 1.
   Đề xuất: đếm lỗi liên tiếp theo user (Mongo hoặc Redis TTL 24 h–30 ngày, xoá khi đúng). Vượt N (ví dụ 50) ⇒ gửi thư cho user + một alert riêng + bắt đặt lại mật khẩu (huỷ mọi vé). Ghi rõ vào `security-matrix.md` để pentest run 90 chấm. → **DEBT-640**
5. 🟡 **Thiếu test cho vài nhánh failure của T2/T3** — (a) `mfa-login.service.ts:248-254`: re-check sau `establish` bị lỗi DB ⇒ huỷ phiên + 5xx. Chưa có test, và cũng không có `mfa-login.service.spec.ts` unit. (b) `mfa.controller.ts:226`/`:256`: revoke-all lỗi sau enroll/disable ⇒ 5xx + audit `revoke_failed`, MFA giữ trạng thái mới (Failure của T2). Chưa có int. (c) AC6 "reset + enroll lại giữa hai bước" (`run89-mfa-login.int-spec.ts:289`) chỉ chạm filter `enrolledAt` trong `verify`, chưa chạm re-check `enrolledNow` ở dòng 259. Nhánh đó (reset xảy ra giữa verify và `establish`) chưa có test. (d) Dev đã nêu: thiếu unit `authorize.service.spec` cho nhánh cổng. Int gate AC10 đã phủ hành vi, nên mục (d) chỉ là 💭.
   Vì sao: đây là các đường fail-closed. Mutation đổi chúng thành fail-open hiện sẽ không đỏ test nào.
   Đề xuất: một unit `mfa-login.service.spec.ts` với Redis/Mongo stub cho (a) và (c) (stub `mfaEnrolledAt` trả giá trị khác `check.enrolledAt`). Một ca int stub `revokeAllUserCredentials` ném lỗi cho (b). → **DEBT-641**

## 💭 Nit

- **Revoke-all lỗi sau enroll ⇒ 5xx trước khi hiện mã khôi phục** (dev đã nêu). Chấp nhận được: authenticator đã chạy, user đăng nhập bằng TOTP rồi tạo lại mã được. Nếu muốn mượt hơn, render trang mã kèm cảnh báo "chưa đăng xuất được mọi nơi" thay vì 5xx.
- **`returnTo` của bước 2 lấy từ vé** (dev đã nêu): đúng AC2 T3, và nó an toàn hơn đọc từ body.
- **Double-submit hợp lệ trên cùng vé**: bên thua CAS bị tính là "mã sai" (`HINCRBY fails` + có thể ghi `AUTH_MFA_FAILED`). Hai mã khôi phục **khác nhau** gửi song song trên một vé thì cả hai đều bị tiêu, chỉ một bên được phiên. Chỉ tốn mã của chính chủ, không ảnh hưởng bảo mật.
- **Khoá E2E** (`e2e/config/env.ts`) cũng công khai trong repo, nhưng production chỉ từ chối khoá `.env.example`. Cân nhắc từ chối cả hai (một danh sách khoá công khai), hoặc ghi chú trong runbook-deploy §17.
- **Lệch đồng hồ giữa các instance** có thể làm `mfaAt < enrolledAt` nếu user đăng nhập lại trong vài giây sau khi enroll trên instance khác. Hậu quả chỉ là đăng nhập lại một lần (fail-closed).
- Cổng `/authorize` đọc `mfaEnrolledAt` hai lần mỗi request `admin` (`handle` + `issueCode*`). Đây là defense in depth, chi phí không đáng kể.
- `reportCommitted` (`bootstrap.ts`): `countUsable()` nằm ngoài câu hướng dẫn rotate. Không sao, vì secret đã in ở dòng đầu.

## ✂️ Ponytail

- be/src/modules/ui/mfa.controller.ts:L302: shrink: `firstFactor` chép `AccountController.reauth` (~30 dòng). Thay bằng một `reauth()` dùng chung trong `UiSessionHelper` (xem 🟡-2).
- be/src/modules/federation/federation.service.ts:L261: delete: `setMfaTicketCookie` chỉ chuyển tiếp. Inject `MfaLoginService` vào `FederationController` và gọi thẳng `setTicketCookie`.
- be/src/modules/mfa/mfa.service.ts:L9: yagni: token `MFA_CLOCK` + `@Optional() @Inject` không module nào provide. Unit spec đã truyền `now` qua `new MfaService(…)`. Bỏ phần DI, giữ tham số constructor thường, hoặc dùng fake timers.
- be/src/modules/mfa/mfa-login.service.ts:L130: shrink: `exists()` chỉ dùng cho `GET /login/mfa`. Có thể bỏ kiểm tra, để POST tự trả `expired`. Lợi ích nhỏ (khoảng 3 dòng), giữ nguyên cũng được.

net: -40 lines possible.


---

# Senior Review — 2026-11-13 (run 89, lô C phần BE: T4 + DEBT-640/D89.25, working tree trên `2fd23ee`)

## Kết luận: PASS

Không có 🔴. 3 🟡 (backlog DEBT-642…644) + vài 💭. Chuyển tiếp **frontend-dev T5** (API không đổi bởi các 🟡 này) rồi **tester** lô D. Phạm vi: `admin-users.controller.ts` (`resetMfa`), `admin.mappers/views`, `database/admin-recover.ts`, `mfa/{mfa.service,mfa-login.service}.ts`, `ui/mfa.controller.ts`, `authentication.service.ts` (`resetPassword`), `user.service.ts`, `user.schema.ts`, `mailer/templates.ts`, `audit-action.enum.ts`, runbook-ops §11/§12, runbook-deploy §17, spec `run89-admin-mfa-reset` / `run89-mfa-cap` / `run87-admin-recover` (ca AC5). Không đọc `fe-admin/` (T5 đang làm).

Senior tự chạy (thật): be `tsc --noEmit` ✅, eslint các file lô C ✅, `npm test` unit 60 suite 1188/1188 ✅. **Không** chạy int (theo yêu cầu, giữ `vg:int-lock`); con số int FULL 2381/2381 và mutation 11/11 là của backend-dev.

## Tổng quan

- `resetMfa` đúng thứ tự an toàn: `mustFind` (404 cho id lạ/khác tenant, trước mọi kiểm quyền ⇒ không có oracle tồn tại) → `assertMayTouchAccount` (tenant_admin không chạm tài khoản có vai trò admin hay thuộc tenant khác) → CAS `$unset` trên `mfa.enrolledAt` → revoke-all → audit alert → thư. `RequireRecentAuth(5)` + `admin.write`; response 204 không body; view chỉ `{enrolled, enrolledAt}` (projection native, không bao giờ nạp seed).
- CLI `--reset-mfa`: `$unset` + đóng dấu/thu hồi family nằm **trong** `runGuarded` cùng audit `ADMIN_RECOVERED` ⇒ audit lỗi = không đổi gì (có int). Dry-run không kết nối, không in email; plan dòng `mfa: enrolled -> reset`.
- D89.25: `$inc` qua `findOneAndUpdate(returnDocument:'after')` nên đúng **một** request thấy `failures === 50` ⇒ `AUTH_MFA_LOCKED` + thư đúng một lần mỗi đợt; mã đúng (TOTP hay mã khôi phục) `$unset` trong cùng update CAS; ở trần TOTP bị từ chối nhưng không đếm thêm, vé vẫn đếm `fails` (≥5 ⇒ restart). Không thêm Redis, không tự mở theo thời gian. Gọn.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Authorization / IDOR**: `:id` khác tenant hoặc không phải ObjectId ⇒ 404 trước kiểm quyền (int AC3). tenant_admin → target có `super_admin`/`tenant_admin`/membership active ở tenant khác ⇒ 403 + audit failure (alert, vì cùng action) `target_super_admin`/`target_not_allowed`, MFA còn (int). Tự reset: tenant_admin bị chặn (chính mình có vai trò admin), super_admin được (D89.16). Thiếu `admin.write` ⇒ 403, `auth_time` > 5' ⇒ `step_up_required` (int).
- **Privilege escalation qua reset**: reset chỉ hạ yếu tố của target; không cấp quyền. Sau reset target không vào được `admin` cho tới khi enroll lại (D89.5 `enrolledAt` null ⇒ cổng từ chối), enroll ⇒ revoke-all. CLI luôn **cấp** `super_admin` cho `--email` (hành vi D87, hai người xác nhận) — xem 💭 runbook.
- **State/concurrency**: `disable(id, enrolledAt)` là CAS ⇒ reset ∥ enroll lại không gỡ nhầm enrollment mới; gọi lại ⇒ `wasEnrolled:false`, 204 (idempotent). Đếm lỗi: `$inc` nguyên tử, trần đọc-rồi-CAS có cửa sổ race nhưng bị chặn bởi limiter reserve-trước 10/900 s ⇒ trần thực tế ≤ 59 < 100 (💭 1). Mã đúng ∥ mã sai: thứ tự bất kỳ đều đúng ngữ nghĩa "liên tiếp".
- **Kẻ có mật khẩu khoá chủ tài khoản?** Đẩy tới trần cần ≥ 50 lượt ⇒ ≥ 75' (limiter), mỗi đợt bắn alert + thư. Chủ mở lại bằng mã khôi phục (vẫn nhận ở trần, có int) hoặc `/forgot` (có int) — không khoá vĩnh viễn. Kẻ có **cả** hộp thư thì đặt lại trần vô hạn lần (🟡 3).
- **Bypass trần**: ở trần, đường `/account/mfa/{disable,recovery}` (`bothFactors`) cũng trả `suspended`; mã khôi phục sai vẫn `$inc`; `recordFailure` lọc `mfa: {$exists:true}` nên enroll dở không tạo `mfa` rỗng. Không thấy đường nào kiểm TOTP mà bỏ qua `verify`.
- **Failure**: revoke lỗi sau `$unset` ⇒ 5xx + `revoke_failed` (alert), MFA vẫn gỡ, gọi lại hoàn tất (int) — nhưng thư bị mất (🟡 1). Mongo lỗi ở `recordFailure` ⇒ 5xx (không thành "đúng"). `clearMfaFailures` lỗi ⇒ 5xx sau khi mật khẩu đã đổi (💭 2).
- **Exposure**: 204 không body; audit `{wasEnrolled}` / `{via, failures}`, không mã/secret; thư không chứa mã; CLI không in email, tham số không echo; view `AdminMfaView` không có `secret/recovery/recoverySalt/failures/lastStep` (int AC4). Thông báo "Authenticator codes are blocked…" chỉ hiện sau bước 1 đúng mật khẩu ⇒ không phải oracle cho người chưa có mật khẩu.
- **Chuỗi request**: sau reset API mọi phiên/family/thiết bị tin cậy bị thu hồi ⇒ request kế với cookie/RT cũ thất bại (int). CLI không chạm Redis (DEBT-634 đã chấp nhận): phiên cũ của target với RP khác sống tiếp, nhưng enroll lại cần mật khẩu hoặc phiên < 5' (`firstFactor`) nên cookie bị đánh cắp cũ không tự gắn authenticator của kẻ tấn công được.

## 🟡 Nên sửa

1. 🟡 **Thư báo reset bị mất khi revoke-all lỗi lần đầu**
   `be/src/modules/admin/admin-users.controller.ts:357-377` — thư chỉ gửi khi `wasEnrolled` của **chính request đó**. Lần 1: CAS gỡ `mfa` (`wasEnrolled=true`) rồi `revokeAllUserCredentials` ném ⇒ 5xx, chưa tới đoạn gửi thư. Lần thử lại (đúng hướng dẫn runbook/`UNCERTAIN_*`): `wasEnrolled=false` ⇒ không thư. Int `failure: revoke-all fails…` xác nhận đường này nhưng không kiểm thư.
   Vì sao: thư cho chủ tài khoản là biện pháp phát hiện chính của abuse "reset rồi đăng nhập bằng mật khẩu đánh cắp" (T4 cổng security); chủ tài khoản không bao giờ biết yếu tố 2 đã bị gỡ.
   Đề xuất: gửi thư (fire-and-forget) ngay sau khi CAS trả `true`, trước revoke-all — giống cách `wasEnrolled` đã được ghi vào audit `revoke_failed`. Thêm assert "đúng 1 thư" vào ca int revoke lỗi + retry. → **DEBT-642**

2. 🟡 **Runbook-ops §11 hướng dẫn một việc không làm được**
   `docs/agile/sso-idp/runbook-ops.md:612-613` — "Còn mã khôi phục ⇒ … `/account/mfa` ⇒ Create new recovery codes hoặc tắt và bật lại với thiết bị mới". Nhưng `bothFactors` (`be/src/modules/ui/mfa.controller.ts:~337-360`) đòi **mã TOTP 6 số** cho cả `disable` và `recovery`, mã khôi phục bị từ chối ("Enter the 6-digit code…").
   Vì sao: người mất thiết bị làm theo runbook sẽ đăng nhập được bằng mã khôi phục nhưng không đổi được sang thiết bị mới; support tưởng tự phục vụ được và trì hoãn reset. Mỗi lần đăng nhập tiêu thêm một mã khôi phục.
   Đề xuất: sửa §11 cho đúng ("mã khôi phục chỉ để đăng nhập; mất thiết bị ⇒ vẫn cần reset qua admin sau xác minh kênh 2"), hoặc (quyết định của tech-lead) cho `disable` nhận mật khẩu + **mã khôi phục** (tiêu mã đó, revoke-all, thư) để tự phục vụ thật. → **DEBT-643**

3. 🟡 **`/forgot` đặt lại trần ⇒ kẻ có cả mật khẩu và hộp thư đoán TOTP không giới hạn số đợt**
   `be/src/modules/authentication/authentication.service.ts:347` — `resetPassword` `$unset mfa.failures` vô điều kiện. Kẻ kiểm soát hộp thư: 50 lần sai → `/forgot` → 50 lần nữa… Thông lượng vẫn chỉ ~960 mã/ngày (limiter 10/900 s), tức trần 50 không thêm bảo vệ nào trước actor này so với trước DEBT-640; NIST 800-63B §5.2.2 chỉ cho reset bộ đếm khi xác thực **thành công**.
   Vì sao: đây đúng là actor mạnh nhất mà yếu tố 2 phải chống (mật khẩu + email cùng lộ); bảo vệ còn lại chỉ là alert `AUTH_MFA_LOCKED` lặp lại mỗi ~75'.
   Đề xuất (chọn một): (a) runbook-ops §11 + quy tắc alert: `AUTH_MFA_LOCKED` ≥ 2 lần/24 h cho cùng `targetId` ⇒ admin khoá tài khoản + liên hệ kênh 2 (rẻ nhất, không đổi code); (b) `resetPassword` chỉ hạ bộ đếm xuống `CAP - 10` thay vì 0 khi đang ≥ trần (vẫn mở cho chủ, nhưng mỗi đợt `/forgot` chỉ thêm 10 lượt và bắn lại alert ngay); (c) không xoá khi reset mật khẩu, chỉ mã khôi phục / reset admin. Ghi hàng này vào `security-matrix.md` để pentest run 90 chấm. → **DEBT-644**

## 💭 Nit

1. `be/src/modules/mfa/mfa.service.ts:103,112` — trần kiểm khi đọc, filter CAS không có `failures`. Thêm `'mfa.failures': { $not: { $gte: MFA_FAILURE_CAP } }` vào filter update ⇒ trần chính xác kể cả request song song (hiện bị limiter chặn ở ≤ 59, vẫn ≤ 100).
2. `be/src/modules/authentication/authentication.service.ts:347` — `clearMfaFailures` không `.catch` ⇒ Mongo lỗi ở đây trả 5xx cho một lần đặt lại mật khẩu **đã thành công** (link đã tiêu). Cân nhắc `.catch(() => logger.warn(...))` như dòng `throttle.clearAccount` ngay dưới (user `/forgot` lại được), hoặc chuyển lên trước audit success.
3. `be/src/modules/admin/admin-users.controller.ts:343-354` — `catch` bắt **mọi** lỗi của `assertMayTouchAccount`: Mongo lỗi lần 1 rồi lần 2 thành công ⇒ audit `target_not_allowed` sai. Nên chỉ audit khi lỗi là `AdminAuthError` forbidden (xem thêm ponytail).
4. runbook-ops §11 (CLI): nói thẳng "`admin-recover` luôn **cấp `super_admin`** cho `--email`; KHÔNG dùng để reset MFA cho user thường" — hiện chỉ ngầm hiểu qua "cấp lại `super_admin`".
5. `mfaLockedMessage` (`be/src/modules/mailer/templates.ts:141`): thêm một câu "If this was not you, someone knows your password" để user hiểu vì sao nên đổi mật khẩu (runbook đã nói điều này cho support, thư thì chưa).
6. Test thiếu nhỏ: chưa có int cho đường `via:'account'` chạm trần / `suspended` ở `/account/mfa/disable`, và tenant_admin → user dùng chung (active ở tenant khác) ⇒ 403 cho route reset (mới có ca super_admin).
7. Ghi nhận, không thuộc lô C: `super_admin` là vai trò theo membership của tenant client phát token; bất biến "chỉ super_admin khác reset được super_admin" giả định admin client chỉ ở `default-tenant` — giống mọi route user admin khác (revoke/lock), không mở DEBT.

## ✂️ Ponytail

- be/src/modules/admin/admin-users.controller.ts:L346: shrink: `membershipsOf` gọi lần hai trong `catch` chỉ để chọn `reason`. Cho `assertMayTouchAccount` (hoặc một `touchRefusal()` trả `null | 'target_super_admin' | 'target_not_allowed'`) dùng chính `all` đã đọc ⇒ một query, `catch` biến mất.
- be/src/database/admin-recover.ts:L331-341: (giữ) hai `updateMany` chép thứ tự `revokeWhere` vì cần `session` của transaction — chấp nhận, không đề xuất trừu tượng hoá.
net: -6 lines possible.

---

# T5 fe-admin (trạng thái MFA + Reset MFA) — senior 2026-11-13

## Kết luận: PASS

Không có 🔴. 1 🟡 (backlog DEBT-645) + 6 💭. Chuyển **tester** lô D (T6). Phạm vi: `fe-admin/src/server/admin-api/{client.ts, schemas.ts}`, `features/admin-api/{users.ts, hooks.ts, inputs.ts}`, `features/users/user-account.tsx`, `routes/users/index.tsx`, `features/audit/alert-label.ts`, test `users-mfa-ui` (mới), `users-fn`, `audit-ui`, `users-ui`, `users-risk`, `users-roles-ui`. Không review `be/` (chỉ đọc để đối chiếu contract).

Senior tự chạy (thật): `pnpm -C fe-admin typecheck` ✅, `lint` ✅, `test` 69 file 1649/1649 ✅. Mutation 9/9 là của frontend-dev (không chạy lại).

## Tổng quan

- Gọn và đúng khuôn sẵn có: `resetUserMfa` là bản sao 1-1 của `revokeUserSessions` (server fn POST + `UserIdSchema` regex 24 hex ở BFF, `encodeURIComponent` ở path, `schema: null` ⇒ chỉ 204 hợp lệ, 2xx khác ⇒ `uncertain`), hook đi qua `useUserWrite` (`retry: 0` mặc định, `onSettled` invalidate `users.all` khi thành công/uncertain, không invalidate khi bị từ chối rõ ràng).
- `resetSecondFactor` theo đúng mẫu `setLocked` (DEBT-313: lỗi không chắc ⇒ đóng hộp, báo ở `role="status"`, không có nút xác nhận mà click kế có thể gửi lại), self ⇒ `signInAgain()` như revoke-all. `ConfirmAction` có `busy` ref chống double-click cùng tick (có test "double click ⇒ sent once"), không đóng được khi `pending`.
- Cổng UI: chỉ trong `canWrite` (= `writable && !protectedTarget`) và `user.mfa.enrolled`; tenant_admin xem chính mình/admin khác ⇒ ẩn (khớp BE `assertMayTouchAccount`); super_admin tự reset ⇒ cảnh báo `role="alert"` trong hộp.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Server-function boundary / IDOR**: id validate ở BFF (`inputValidator(UserIdSchema)`), token lấy từ phiên server-side (`deps.auth.accessToken`), client không gửi gì khác ngoài id; quyền/tenant do BE quyết (404 trước kiểm quyền). Không có tham số nào client điều khiển path ngoài id đã regex.
- **CSRF**: dùng cùng cơ chế server fn POST như mọi write user khác (lock/unlock/revoke-all) — không thêm bề mặt mới.
- **Authorization UI khác quyền**: nút ẩn chỉ là UX; BE vẫn trả 403 ⇒ `BY_CODE.forbidden` cố định. `insufficient_scope` gộp vào `forbidden` ở `client.ts:175` (có test `users-fn`).
- **Step-up**: `step_up_required` ⇒ `outcomeOf` ⇒ `StepUpAlert` (không lưu intent, không tự gửi lại khi quay về; test).
- **Failure behavior**: 5xx/timeout/lỗi mạng/2xx lệch contract ⇒ `uncertain` (`client.ts` `unavailable(..., method !== GET)`), hoặc throw không phải `AdminRequestError` ⇒ đều thành `MFA_RESET_UNCERTAIN`, đóng hộp, đọc lại; không retry (query-client `mutations.retry: 0`). Không biến thành "thành công".
- **Lời khuyên khi không chắc (đối chiếu BE mới: thư gửi ngay sau `$unset`, trước revoke-all)**: vẫn đúng. Hai trạng thái quan sát được: (a) còn **On** ⇒ CAS chưa chạy ⇒ "reset lại" an toàn (idempotent); (b) **Off** ⇒ factor đã gỡ và thư đã đi (BE `admin-users.controller.ts:349-352`), chỉ revoke-all có thể dở ⇒ "Revoke all sessions" gọi đúng cùng `revokeAllUserCredentials` (controller :209 và :353: phiên, family, thiết bị tin cậy) ⇒ hoàn tất mà không gửi thư lần hai. Nếu lần đọc lại cũng lỗi (BE down) UI có thể còn hiện On cũ ⇒ "reset lại" vẫn vô hại. Xem 💭 3 về audit trail.
- **Exposure / XSS**: mọi dữ liệu BE (`enrolledAt`, email, mã action) render qua text node React, không `dangerouslySetInnerHTML`; 403/404 không hiện `error_description` (test "BE text never shown"). View chỉ `{enrolled, enrolledAt}`; không lưu gì về MFA ở browser (test `sessionStorage`/`localStorage` rỗng); mutation `gcTime: 0`.
- **Race**: dữ liệu `enrolled` cũ (tab khác vừa reset) ⇒ nút vẫn hiện ⇒ BE 204 `wasEnrolled:false` ⇒ báo thành công + đọc lại Off. Vô hại.
- **A11y hộp thoại**: Radix `AlertDialog` (focus trap, Escape, không đóng bằng click ngoài), `AlertDialogTitle` + `AlertDialogDescription` gắn nhãn, cảnh báo self `role="alert"`, kết quả vào `role="status"` luôn render, focus về heading section sau khi xong (DEBT-319). Cột danh sách có `<th scope="col">`.

## 🟡 Nên sửa

1. 🟡 **3/4 nhãn alert MFA (và các tuỳ chọn lọc MFA không phải admin) không bao giờ khớp event nào trong audit của tenant**
   `fe-admin/src/features/audit/alert-label.ts:9-11`, `fe-admin/src/features/admin-api/inputs.ts:194-202` — `AUTH_MFA_THROTTLED`, `AUTH_MFA_LOCKED` (BE `mfa-login.service.ts:161-191`, ctx `MfaAuditContext = {ip, userAgent, requestId}`) và `MFA_DISABLED` (`ui/mfa.controller.ts:254-262`) ghi **không có `tenantId`**, còn `GET /admin/audit` lọc chặt `tenantId` (`audit.service.ts:90,114`) — đúng giới hạn DEBT-140. Hệ quả: chỉ `ADMIN_USER_MFA_RESET` (qua `adminAuditBase`) hiện được; lọc theo `AUTH_MFA_LOCKED` luôn trả "không có event" ngay cả khi đang bị brute force.
   Vì sao: admin đọc trang audit/bộ lọc sẽ tin "không có tấn công MFA" — âm tính giả ở đúng nhóm event cảnh báo D89.19. Phát hiện thật vẫn có qua alert listener/log, nên không phải 🔴; test FE dùng event giả nên không lộ ra. AC4 ("nhãn cho 7 action mới") vì thế chỉ kiểm được ở mức đơn vị.
   Đề xuất: (BE) gắn `tenantId` cho các event MFA đăng nhập/tài khoản theo hướng DEBT-140 (tenant của client ở phiếu `/login/mfa`; `/account/mfa` không có client ⇒ quyết định riêng); hoặc (FE, rẻ) ghi chú dưới bộ lọc "event đăng nhập/MFA không gắn tenant — xem alert/log", như ghi chú `AUTH_ACCOUNT_LOCKED` ở `dashboard/summary.ts:15`. Cùng lúc cân nhắc thêm `ADMIN_USER_MFA_RESET` (có tenant, alert) vào `SECURITY_ACTIONS` của dashboard. Tester T6 nên ghi điều này vào `security-matrix.md`. → **DEBT-645**

## 💭 Nit

1. `alert-label.ts:8` — `ADMIN_USER_MFA_RESET` được gắn "reset by an administrator" cả khi `result: failure` (BE ghi failure `target_super_admin`/`target_not_allowed`/`revoke_failed` dưới cùng action). Cột Result vẫn ghi Failure nhưng nhãn đỏ đọc như đã reset; cân nhắc "two-step verification reset (attempt)" hoặc nhánh theo `e.result`.
2. `user-account.tsx` `BY_CODE.forbidden` ("Only a super admin can change this account…") cũng hiện cho `insufficient_scope` (gộp ở BFF). Hiện không xảy ra (BFF luôn xin `admin.write`), nhưng nếu scope bị thu hẹp sau này thì câu sai lý do. Chấp nhận giả định `canWrite` thay cho `admin.write` (viewer không mang scope) — nên ghi rõ trong test-report.
3. Hoàn tất bằng "Revoke all sessions" sau uncertain ⇒ audit có `ADMIN_USER_MFA_RESET` failure `revoke_failed` + `ADMIN_USER_SESSIONS_REVOKED`, nhưng không bao giờ có `ADMIN_USER_MFA_RESET` success. Đúng về bảo mật; nếu muốn trail sạch thì sau uncertain vẫn cho bấm Reset lại khi Off (BE idempotent, revoke + audit success). Không bắt buộc.
4. `schemas.ts:80` — `enrolledAt: z.string().nullable()`: cân nhắc `z.string().datetime().nullable()` để giá trị lệch contract bị bắt ở BFF thay vì hiện nguyên văn (React vẫn escape, chỉ là chất lượng hiển thị).
5. Dashboard `SECURITY_ACTIONS` (`features/dashboard/summary.ts:17`) không có event MFA nào — ngoài AC T5, gộp vào DEBT-645.
6. Self-reset khi uncertain: hộp đóng, admin vẫn ở console (phiên có thể còn sống nếu revoke dở). Lời khuyên "Revoke all sessions" trên chính mình dẫn tới `signInAgain` nên đủ; có thể thêm một câu riêng cho self.

## ✂️ Ponytail

Lean already. Ship.


# Delta (D89.26–29 + fe follow-up) — senior 2026-11-13

## Kết luận: PASS

Phạm vi: chỉ phần sửa DEBT-642…645 (D89.26–D89.29), nit lô C và follow-up fe-admin sau review T5 (working tree trên `2fd23ee`, chưa commit). Không chạy `test:int`/e2e (tester đang dùng cổng/DB).

Tự chạy: be `tsc --noEmit` sạch; eslint các module chạm (`mfa`, `ui`, `admin`, `authentication`, `identity`, `mailer` + `run89-mfa-audit-tenant.int-spec.ts`) sạch; be unit `npm test` 60/60 suite, **1188/1188**. fe-admin `tsc --noEmit` sạch; vitest **1653/1653** (lần chạy đầu 1 test đỏ, chạy lại xanh, không tái hiện — khả năng flaky do máy đang tải E2E song song; tester để ý nếu lặp lại).

## Tổng quan

Các sửa đúng ý quyết định và gọn. `bothFactors` giữ thứ tự tốt: trạng thái → mật khẩu (luôn hỏi, không lối tắt 5') → mã rỗng → reserve limiter user → `checkCode` → đếm sai/refund. Mật khẩu kiểm **trước** mã nên không có oracle mã khi chưa qua yếu tố 1. Trần nằm trong filter CAS (`$not: {$gte: CAP}` khớp cả khi chưa có trường) nên đua song song không lọt TOTP đúng lúc vừa chạm trần. `touchRefusal` một lần đọc, lỗi DB nổi lên 5xx thay vì bị gắn `target_not_allowed`.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Mã khôi phục ở `/account/mfa` không vượt trần/reauth**: `firstFactor(..., alwaysPassword=true)` chạy trước mọi kiểm mã; tài khoản không mật khẩu chỉ qua khi phiên < 5'. Mã khôi phục 80 bit, mỗi lần thử đi qua `reserveAttempt` (10/900 s/user, chung với `/login/mfa`), sai ⇒ `recordWrongCode(..., 'account')` cộng trần. Mã đúng `$pull` là CAS (dùng một lần) + `$unset mfa.failures` — đúng D89.27/D89.28 (mã khôi phục là cách hợp lệ duy nhất của user để mở trần).
- **TOTP bị treo ở trần vẫn bị từ chối ở trang account**: `verify` trả `{ok:false, suspended:true}` trước khi giải mã seed, bất kể mã đúng/sai; `bothFactors` trả `SUSPENDED_CODE`, **không** `recordWrongCode` (không đẩy bộ đếm/không thư lặp), không refund limiter. Không có đường nào khác xoá `mfa.failures` ngoài `verify` dưới trần, `consumeRecovery`, `disable`/admin reset (gỡ cả `mfa`). Đã grep: `clearMfaFailures` biến mất, `resetPassword` không chạm `mfa`.
- **Phiên bị đánh cắp + mật khẩu không tắt được MFA nếu thiếu yếu tố 2**: mã rỗng ⇒ 400 trước reserve; mã sai ⇒ 400 + đếm; `disable(userId, enrolledAt)` là CAS trên enrollment đã kiểm. Lưu ý chấp nhận được: kẻ có phiên + mật khẩu đẩy được trần tới 50 (DoS TOTP của chủ) — y như qua `/login/mfa`, đã có alert `AUTH_MFA_LOCKED` + quy tắc ≥2/24 h.
- **D89.26 thứ tự reset admin**: CAS `disable` → thư (chỉ khi `wasEnrolled`) → `revokeAllUserCredentials` → audit success; revoke lỗi + gọi lại thấy `wasEnrolled:false` ⇒ không thư thứ hai. Đúng.
- **Tenant của audit (D89.29)**: bước 2 gắn `DEFAULT_TENANT_ID` — trùng tenant `establish` dùng và `SESSION_CREATED` vốn có; `/account/mfa` gắn `session.tenantId` (luôn là `DEFAULT_TENANT_ID` vì mọi phiên IdP lập ở tenant đó). `register()`/federation luôn `addMembership(DEFAULT_TENANT_ID)` nên không tạo kênh rò mới: admin tenant mặc định vốn đã thấy `SESSION_CREATED` của mọi user; tenant khác không thấy gì thêm. `GET /admin/audit` ép `filter.tenantId = ctx.tenantId` sau cùng. Nội dung audit không chứa mã/seed (chỉ `left`, `via`, `factor`, `failures`).
- **Exposure**: thư khoá chỉ văn bản cố định + link `/account/mfa`; không mã, không IP.
- **fe-admin**: nhãn `ADMIN_USER_MFA_RESET` theo `result` (failure ⇒ "refused or incomplete", không nói "reset by"); `MFA_DISABLED` failure duy nhất là `revoke_failed` sau khi đã gỡ nên nhãn "turned off" đúng; `enrolledAt: z.iso.datetime().nullable()` từ chối chuỗi lạ thay vì in thẳng; câu uncertain cho self-reset hợp lý.
- **Runbook-ops §11**: khớp code (mã khôi phục + mật khẩu ở `/account/mfa`, `/forgot` không mở trần, quy tắc ≥2 `AUTH_MFA_LOCKED`/24 h ⇒ khoá, thư gửi ngay khi gỡ, cảnh báo `admin-recover` luôn cấp `super_admin`). `security-matrix.md` dòng "Kẻ có mật khẩu + hộp thư đặt lại trần" khớp.

## 🟡 Nên sửa

- [ ] 🟡 **Câu hướng dẫn trái với D89.28** — `be/src/modules/ui/mfa.controller.ts:60-61` `SUSPENDED_CODE` = "...Use a recovery code, or reset your password." hiển thị ở cả `/login/mfa` và `/account/mfa`. Vì sao: sau D89.28 `/forgot` **không** còn mở trần, nên user làm theo sẽ đặt lại mật khẩu rồi vẫn bị chặn (và runbook §11 nói ngược lại) — tốn một vòng hỗ trợ đúng lúc đang bị tấn công. Đề xuất: "Use a recovery code. If you have none left, contact your administrator." (+ khuyên đổi mật khẩu như thư khoá). Kèm hai comment cũ cùng gốc: `mfa.controller.ts:59` ("only a recovery code or a password reset helps") và `be/src/modules/mfa/mfa.service.ts:34-35` ("a recovery code, a password reset or an MFA reset ends it") ⇒ bỏ "password reset". Nên có assertion int/unit chặn câu "reset your password" trong `SUSPENDED_CODE`. → **DEBT-646**.

## 💭 Nit

- D89.29 trong `tasks.md` nói "admin của tenant thấy qua `GET /admin/audit`": thực tế chỉ admin **tenant mặc định** thấy (mọi phiên IdP ở đó); admin tenant khác không thấy sự kiện MFA của thành viên mình. Không phải lỗ hổng (không rò sang tenant khác), chỉ nên ghi rõ phạm vi khi DEBT-140 được làm.
- `bothFactors` tiêu một mã khôi phục rồi `disable`/`regenerate` có thể 409 (đua với reset admin) — mã đã mất. Chấp nhận được (hiếm, user vẫn còn mã khác), không cần sửa.

## ✂️ Ponytail

Lean already. Ship.
