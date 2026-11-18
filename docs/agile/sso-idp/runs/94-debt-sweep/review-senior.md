# Senior Review — 2026-11-17 (run 94, lô A + lô C)

## Kết luận: PASS (lô A và lô C; không có 🔴)

Phạm vi: diff chưa commit của lô A (T1 DEBT-661) và lô C (T3 DEBT-669), cộng phần orchestrator sửa comment `introspect.controller.ts` và câu spec §8. Lô B (T2/T4) không thuộc lượt này.

Đã chạy lại (qua `vg:int-lock`): `run94-reset-ticket.int-spec.ts` + `run86-token-fragment.int-spec.ts` 18/18 PASS; unit `authentication.service.spec.ts` 31/31 PASS. Không chạy harness (DEBT-664, chờ lô B/D).

---

## Lô A — T1 DEBT-661 (vé đổi token `/reset`)

### Tổng quan
Triển khai bám sát D94.2–D94.7: đổi token chỉ khi người dùng bấm `Continue`, `token-fragment.js` không đổi (không tự submit, chỉ `.value` + `replaceState`), vé nằm trên cùng document Mongo, không thêm Redis/env/audit. Code gọn: `consume()` dùng chung bị xoá vì reset là caller duy nhất, hai `findOneAndUpdate` mới đều có filter đầy đủ. Int test D94.8 đủ 11 ca. Đọc lại từng filter, các ca test bắt được mutation như sau:

| Mutation (đảo trong đầu) | Test đỏ |
|---|---|
| `claimResetTicket` bỏ `ticketHash: null` | #2 ca "exchanged" (jar khác đổi lại ⇒ 303) và #8 race (2×303) |
| bỏ `usedAt: null` / `expiresAt` khi đổi | #2 ca "used" / "expired" |
| `resetPassword` bỏ `usedAt: null` | #4 replay vé (201 thay vì 400) và #8 (2×201, `setPassword` 2 lần) |
| `resetPassword` bỏ `expiresAt` | #7 |
| tiêu thụ vé trước `assertAcceptablePassword` | #5 (mật khẩu tốt sau đó 400) |
| `ResetDto` còn nhận `token` | #6 (body hình cũ phải 400, token còn đổi được) |
| set cookie trước khi kiểm kết quả claim | #2 (`jar.values.has('idp_reset')`), #10 |
| bỏ `CsrfGuard` trên `/reset/code` | #9 + harness SESS-CSRF (m2 tự phủ route mới) |

Tác giả nói chưa có RED trước. Bảng trên cho thấy các test hiện có vẫn phân biệt được code đúng với code sai ở mọi điểm của filter, nên tôi không coi việc thiếu RED-trước là blocker.

### 🔴 Blocker
Không có.

### Security invariants / trust boundaries đã kiểm
- **Nguyên tử / race**: `findOneAndUpdate` một document, filter `{tokenHash, usedAt:null, ticketHash:null, expiresAt>now}`. Update set `ticketHash`, nên request thứ hai không còn khớp. Có 1 hệ quả đã được chấp nhận ở D94.3: `expiresAt` bị ghi đè thành now+15' (xem 💭). Bước tiêu thụ vé `{ticketHash, usedAt:null, expiresAt>now}` → `usedAt`; `setPassword` chạy sau khi đã thắng. Int #8 chứng minh 1×303 và 1×201 với `setPassword` 1 lần.
- **Token gốc chết ngay khi đổi**: sau khi đổi, `ticketHash` ≠ null nên filter đổi không khớp nữa. Token không bao giờ được dùng trực tiếp trên `POST /reset` vì `ResetDto` không còn field `token` và `forbidNonWhitelisted` ⇒ 400 trước handler (#6). Đây là sửa đúng DEBT-661.
- **Cookie**: `hostCookieName('idp_reset', secure)`. Với Secure, `__Host-` bắt trình duyệt ép host-only + `Path=/` + Secure, nên subdomain không toss/ghi đè được. Tên trần `idp_reset` chỉ có khi `SESSION_COOKIE_SECURE=false`, và `validation.schema` **cấm** giá trị này ở `NODE_ENV=production` (`validation.schema.spec.ts:51`). Vì vậy rủi ro cookie tossing chỉ có ở dev/E2E http, ngang với `idp_session` (DEBT-008). Thuộc tính: HttpOnly, SameSite=Lax, Path=/, Max-Age=900, không có Domain (#1). Fixation (cài vé của kẻ tấn công vào trình duyệt nạn nhân) cần ghi được cookie `__Host-` hoặc vượt CSRF, cả hai đều không làm được.
- **CSRF + limiter**: `/reset/code` chạy `CsrfGuard` rồi `ui.limit('reset', req, token)`. `/reset` chạy `CsrfGuard` rồi `limit` theo `sha256(vé)`. Limiter chạy trước mọi truy cập DB. Có một điểm nhỏ ở key khi thiếu vé (💭).
- **Đồng nhất lỗi**: mọi 4xx của UI đều qua `HtmlExceptionFilter` ⇒ cùng một thân `The request could not be completed.` (thông điệp `RESET_INVALID` không bao giờ được render). #2 so thân 5 ca bằng nhau, harness `AUTHN-RESET-TICKET` so thân của token đã đổi với token lạ. Không có oracle tồn tại/đã dùng. Body không phải chuỗi (mảng, object `$ne`) ⇒ ValidationPipe 400 cùng thân, không chạm DB.
- **Fail closed**: Mongo lỗi ở bước đổi ⇒ 5xx, không Set-Cookie (#10). `GET /reset` có cookie đúng dạng mà `exists` lỗi ⇒ 5xx, không rơi về form nào. Lỗi khi tiêu thụ vé ⇒ 5xx, cookie giữ nguyên, vé chưa bị đốt.
- **Exposure / log**: token chỉ ở body hoặc fragment; vé chỉ ở cookie. Pino redact `req.headers.cookie`, `*.token`, `set-cookie`. Serializer response chỉ giữ `statusCode` + `location` (`/reset`, không fragment). Filter không log message của 4xx. Int #11 quét log không thấy token/vé nào. 303 tới `/reset` là đường dẫn tương đối cố định, không có open redirect.
- **Policy reject giữ vé**: `assertAcceptablePassword` + `hashPassword` chạy trước khi tiêu thụ. Controller chỉ xoá cookie khi `message === RESET_INVALID` (#5).
- **Thành công**: chuỗi `setPassword → revokeAllUserCredentials → audit → mail → xoá bucket` không đổi (unit thứ tự DEBT-050 vẫn xanh, #4 kiểm phiên cũ bị thu hồi). Cookie bị xoá. `$ifNull emailVerifiedAt` (D91.5) nằm trong `users.setPassword` (`user.service.ts:290`), không bị chạm. Reset vẫn xác minh email.
- **Link cũ trước deploy**: `issueToken` dùng `model.create` không có `ticketHash`, mongoose đặt default `null`. Document cũ không có field này vẫn khớp `ticketHash: null` (Mongo coi thiếu field = null).
- **Index**: unique partial `{ticketHash:1}`, `$type:'string'`, chỉ trên schema reset; có int kiểm. Nhiều document `null` không đụng nhau.
- **Scanner / JS-off**: `GET /reset` không ghi gì (chỉ `exists` khi có cookie đúng dạng). `token-fragment.js` không `submit()`. E2E JS-off: nhập mã ⇒ `Continue` ⇒ form mật khẩu.
- **Harness**: `ROUTES` có `POST /reset/code` (SESS-ROUTELIST). SESS-CSRF có hàng `/reset/code` nên m2 tự phủ. `INJ-NOSQL-reset-code` gửi `token[$ne]` không kèm `password` (đúng, vì có `password` sẽ bị whitelist chặn trước). `AUTHN-RESET-TICKET` là must, dùng user V, token chèn trực tiếp kiểu PREHIJACK, không ghi token vào evidence. Độ phân biệt: xem 🟡-2.

### 🟡 Nên sửa
1. **Reset thành công không vô hiệu các token/vé reset khác còn sống của cùng user** (`authentication.service.ts` `resetPassword`, sau `setPassword`).
   - Vì sao: người dùng xin 2 thư rồi dùng thư 1 thì token thư 2 vẫn sống 30' trong History. Đúng loại rủi ro DEBT-661 nhắm tới. Thêm một ca mới do run 94 tạo ra: khi đang có vé sống, mở link của thư mới ⇒ `GET /reset` hiện thẳng form mật khẩu của vé cũ, token mới **không bao giờ** bị đổi và vẫn nằm trong History.
   - Đây là hành vi có từ trước, không phải regression, nên không chặn.
   - Đề xuất: sau khi `setPassword` thành công, `updateMany({userId, usedAt: null}, {$set: {usedAt: now}})` (best-effort hoặc trong chuỗi revoke), kèm int "2 thư ⇒ reset bằng thư 1 ⇒ token thư 2 đổi ⇒ 400". Đây cũng là khuyến nghị OWASP Forgot Password. ⇒ **DEBT-685**.
2. **Harness `AUTHN-RESET-TICKET`, phần "old shape" không phân biệt được** (`checks.mjs:727`).
   - Vì sao: lúc này token đã đổi ở jar A và jar B không có vé. Nếu `ResetDto` lỡ nhận lại `token`, request vẫn 400 vì token đã chết, nên check vẫn xanh.
   - `INJ-NOSQL-reset` (`checks.mjs:973`) giờ chỉ còn đo whitelist (`token` không thuộc `ResetDto`), không đo injection.
   - Int #6 đã phủ đúng invariant này, nên chỉ là độ phủ của harness.
   - Đề xuất: gửi body hình cũ với một token **mới chưa đổi**, rồi kiểm token đó vẫn đổi được. Đổi tên hoặc bỏ hàng INJ `/reset` (hoặc ghi rõ nó là check whitelist). ⇒ **DEBT-686**.

### 💭 Nit
- `ui.controller.ts` `resetPost`: không có vé ⇒ `limit('reset', req, sha256(''))`, tức một bucket account chung toàn cục cho mọi request thiếu vé. Vô hại vì các request đó đều bị từ chối, nhưng truyền `undefined` (bỏ dimension account) thì đúng ý hơn.
- `ui.controller.ts` `resetPost`: phân loại lỗi bằng `err.message === RESET_INVALID` là ghép nối qua chuỗi. Nếu sau này đổi chữ của policy, có thể vô tình xoá cookie. Một exception class riêng (hoặc `resetPassword` trả `false`) sẽ chắc hơn.
- `claimResetTicket` đặt `expiresAt = now + 15'` kể cả khi token chỉ còn 1', nên vòng đời tối đa token + vé là 45'. D94.3 đã chốt như vậy; `min(expiresAt cũ, now + 15')` sẽ chặt hơn mà không tốn gì.
- Form mật khẩu (vé sống) không cho biết đổi cho tài khoản nào. Trình duyệt dùng cho nhiều tài khoản có thể đổi nhầm trong 15'. Có liên quan tới 🟡-1.
- Runbook §18: trước khi chạy `db:sync-indexes`, `GET /reset` có cookie đúng dạng sẽ quét cả collection (collection nhỏ, có TTL). Không đáng ghi thêm.

### ✂️ Ponytail
- be/src/modules/ui/ui.controller.ts:L395: shrink: khối try/catch dò `err.message` để quyết định xoá cookie. Thay bằng `resetPassword` trả `boolean`; controller xoá cookie và ném 400 khi `false`.
- be/test/helpers/reset-ticket.ts: lean (7 spec dùng `resetByToken`, 3 spec dùng `resetWithToken`).
net: -6 lines possible.

---

## Lô C — T3 DEBT-669 (docs RP/RS) + sửa của orchestrator

### Tổng quan
`docs/integration-rp-rs.md` ngắn, đúng 4 mục của D94.10, ví dụ dùng placeholder `<client_id>:<client_secret>`, không có PEM hay secret. Có link ở `README.md` và spec §8.

### Đối chiếu với code (đã kiểm)
- `at_revoked:{jti}` chỉ được ghi một chỗ: `SessionService.revokeAccessToken` (`session.service.ts:314`), caller duy nhất là `token.controller.ts:346` (code bị dùng lại). Khớp mục 1a.
- `/revoke` với AT không làm gì; thu hồi consent hoặc family không chạm AT. Khớp với `isAccessTokenLive` và mô tả của log lô C.
- `ACCESS_TOKEN_TTL` 900 và `KEY_PREPUBLISH_SEC` mặc định 3600 (`configuration.ts:174/195`, `validation.schema.spec.ts:330`). `/jwks.json` trả `Cache-Control: no-cache` (`keys.controller.ts:40`).
- Mục 1b ghi "Đặt lại mật khẩu (`POST /reset`)": vẫn đúng sau run 94, vì revoke chạy ở `POST /reset` bước vé.
- Comment `introspect.controller.ts` (orchestrator): bây giờ nói đúng rằng denylist `jti` duy nhất là `at_revoked` (D91.8). Câu spec §8 thêm ngoại lệ run 91 và link tới doc. Cả hai khớp code.

### 🔴 Blocker
Không có.
### 🟡 Nên sửa
Không có.
### 💭 Nit
- Mục 4 nhắc "front-channel logout tới các RP đã nhận code trong phiên". Tôi chỉ thấy `renderFrontchannel` / `frontchannelLogoutUri` qua grep, chưa đọc hết luồng. Đề nghị tác giả giữ link tới spec §9.8 làm nguồn chính, như đang có.

### ✂️ Ponytail
Lean already. Ship.

---

# Senior Review — 2026-11-17 — Lô A retry 1 (DEBT-685 + 💭 + ponytail)
## Kết luận: PASS (không 🔴)

## Tổng quan
Retry làm đủ 4 điểm của lượt trước, mỗi điểm có test, và RED-trước có bằng chứng (log.md: #12, #12b, #13 đỏ trước khi sửa). Tôi chạy lại: int run94-reset-ticket 15/15 (lock `vg:int-lock` qua preflight), unit authentication.service 31/31.

- **DEBT-685**: `updateMany({userId: consumed.userId, usedAt: null}, {$set: {usedAt: now}})` chạy trên `this.resetTokens` (model `PasswordResetToken`, collection `passwordresettokens`). Đây là cùng document có `ticketHash`, nên một lệnh đốt cả token chưa đổi lẫn vé đang sống (D94.4). `consumed.userId` lấy từ doc lean nên giữ đúng kiểu ObjectId lưu trong DB, không lệch kiểu. Int #12 kiểm `countDocuments({userId, usedAt: null}) === 0`, thư 3 bị 400 và vé B mất form.
- **Thứ tự sau revoke + audit**: hợp lý. Nếu đặt trước revoke thì một lỗi ở bước đốt sẽ bỏ qua thu hồi credentials, tệ hơn nhiều. Khi `updateMany` lỗi, trạng thái còn lại là: mật khẩu đã đổi, mọi session/refresh đã thu hồi, audit success đã ghi, vé hiện tại đã `usedAt` (chết), các token/vé khác còn sống ≤ 30'. Người dùng thấy 5xx nhưng thực ra đã đổi xong. Thử lại bằng vé này sẽ ra 400; đăng nhập bằng mật khẩu mới vẫn được. Trạng thái này không fail-open: không có credential cũ nào sống, các token còn sót thuộc đúng loại rủi ro D94.6(a) đã chấp nhận, và cùng tiền lệ DEBT-050 (không rollback mật khẩu, lỗi hạ tầng ⇒ 5xx). Tôi chấp nhận. Riêng thư báo "password changed" bị bỏ qua: xem 🟡 bên dưới.
- **Ca "đang có vé sống + mở link thư mới"**: giữ form mật khẩu của vé cũ. Lý do đúng: server không thấy fragment nên không biết có token mới, còn bắt `token-fragment.js` ưu tiên token mới sẽ đổi hợp đồng JS ngoài phạm vi. Cùng một người dùng, cùng một trình duyệt, và token mới chết khi reset xong (int #12b). Chấp nhận.
- **Limiter**: `ticket && sha256(ticket)` cho ra `undefined` khi không có vé. `ui.limit(name, req, account?)` khi đó chỉ đếm theo IP/device, nên đã hết bucket chung `sha256('')`. Vé sai định dạng cũng bị `readResetTicket` lọc về `undefined`, nên kẻ tấn công không tự tạo được bucket account tùy ý.
- **`$min` pipeline**: Mongoose 9.11.4 có `updatePipeline` (mongooseoptions.d.ts:238). Thiếu cờ này Mongoose 9 sẽ từ chối update dạng mảng. `{$min: ['$expiresAt', Date]}` là toán tử biểu thức aggregation trong `$set`, đúng cú pháp. Filter vẫn là atomic CAS (`ticketHash: null`) nên race #8 vẫn xanh. `returnDocument` mặc định 'before' không sao vì chỉ dùng doc để biết có khớp hay không. Int #13 kiểm `expiresAt` giữ nguyên hạn token khi hạn này sớm hơn.
- **boolean thay try/catch**: hợp đồng HTTP không đổi. Vé thiếu, sai, hết hạn hoặc đã dùng đều ra `false`, controller xoá cookie và trả cùng một 400 `RESET_INVALID` qua HtmlExceptionFilter. Mật khẩu bị policy từ chối thì `assertAcceptablePassword` ném trước khi tiêu thụ, controller không chạy tới `clearResetTicket`, nên vé được giữ (int #5). Lỗi hạ tầng vẫn propagate thành 5xx.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- Single-use/rotation: CAS token→vé (`ticketHash: null`) và vé→usedAt vẫn atomic; DEBT-685 thêm "một reset thành công làm chết mọi reset credential khác của user".
- Failure: lỗi ở bước đốt ⇒ 5xx, không báo success; credentials đã thu hồi trước đó; không fail-open.
- Exposure: không log token/vé (int #11); limiter không còn bucket chung dùng để DoS chéo người dùng.
- Boundary: vé sai hình bị chặn bởi `TICKET_SHAPE` trước khi chạm DB và limiter.

## 🟡 Nên sửa
- [ ] authentication.service.ts:L539-L542. Nếu `updateMany` lỗi thì thư báo `sendPasswordChanged` bị bỏ qua, dù mật khẩu đã đổi và audit đã ghi success. Thư này là kênh báo cho chủ hộp thư khi reset không phải do họ làm. Lỗi Mongo xảy ra đúng sau vài lệnh ghi thành công là rất hiếm (nên không phải 🔴), và cùng loại với nhánh revoke lỗi đã có từ trước. Cân nhắc gọi `this.sendPasswordChanged(updated.email)` (detached, không await) ngay sau audit success, trước `updateMany`; vẫn giữ nguyên việc propagate 5xx. Thêm unit test "updateMany ném ⇒ reject và mailer vẫn được gọi". ⇒ **DEBT-687**.

## 💭 Nit
- Chưa có test cho nhánh "`updateMany` lỗi ⇒ 5xx". Nên gộp vào test của DEBT-687.
- Comment ở `ResetDto` vẫn nói "ticket rides in its cookie", đúng. Không còn chỗ nào so chuỗi `RESET_INVALID` trong code điều khiển; hằng số chỉ dùng làm thông điệp.

## ✂️ Ponytail
- authentication.service.ts:L742: delete: `consume()` đã bị xoá, không còn caller. Tốt.
Lean already. Ship.

---

# Senior Review — 2026-11-18 — Lô B (T2 DEBT-664, T4 DEBT-682, DEBT-686)

## Kết luận: REJECT (1 🔴, sửa 1 dòng) ⇒ backend-dev

Phạm vi: `smtp.mailer.ts`, `mailer.spec.ts`, `pentest.mjs`, `checks.mjs` (phần DEBT-686), `mutate.mjs` (comment), `ci.yml` job `pentest`. Lô A/C đã PASS, không review lại.

Đã chạy: unit `mailer.spec.ts` 29/29 PASS; `node --check` pentest/checks/mutate OK; parse `ci.yml` (js-yaml 5.4.2) OK: 9 job, `pentest` timeout 40, step harness 10' + `mut` + mutation 20' (`if: steps.mut.outputs.run == 'true'`). Không chạy harness. Tái hiện `smtpGreeting` trong scratchpad với SMTP nhận kết nối nhưng im lặng (process riêng): xem 🔴.

## Tổng quan
- Pool đúng D94.9-3: `pool: true`, `maxConnections: 5`, `maxMessages: 100`, hằng số, không env. Số đo trước/sau rõ (peak 12 ⇒ 5; 885 ⇒ 16 kết nối cho 884 thư), phân loại (b) có căn cứ, không mở DEBT-684 là đúng.
- Thứ tự hook Nest 12.2.0 đã kiểm: `close()` gọi `callDestroyHook` ⇒ `callBeforeShutdownHook` (mọi module, gồm drain D91.11 ở `AuthenticationService`) ⇒ `callShutdownHook`. Hook chạy cả cho provider `useFactory` (`getNonAliasProviders` ⇒ instance). Vậy `transport.close()` đúng là sau drain.
- Unit test pool RED thật: không pool thì 20 send song song mở 20 kết nối (`peak` 20 > 5); không `close()` thì kết nối rỗi sống ~10 s, quá vòng chờ 1 s ⇒ cũng đỏ.
- CI detect step an toàn: `EVENT`/`BEFORE` qua `env`, không `${{ }}` trong script; mọi biến đều quote; `||` và `elif !` không bị `bash -e` cắt ngang; ca không lấy được diff ⇒ `run=true`. `fetch-depth: 2` đủ cho PR: checkout `refs/pull/N/merge` sâu 2 có cả hai parent, `git diff HEAD^1 HEAD` chỉ cần hai tree. Push: `git diff BEFORE HEAD` hai chấm, không cần merge-base, `--depth=1` đủ. Step chỉ chạy khi các step trước xanh (`success()` ngầm) ⇒ không che lỗi harness.
- DEBT-686 giờ phân biệt đúng/sai: body cũ mang token MỚI từ jar A có vé sống ⇒ nếu `ResetDto` nhận lại `token`, vé đổi mật khẩu (login cũ 401) hoặc token mới bị tiêu (exchange khác 303). Mutant tay đỏ đúng (oldShape 201, login 401, fresh 400). `INJ-NOSQL-reset-code` có target sống (token chưa đổi) và kiểm `ticketHash:null`; `INJ-NOSQL-reset` kiểm vé còn sống.
- `HYG-MAIL`/`HYG-SMTP-AFTER` đúng tier `must`, chỉ ở lượt đầy đủ (`serveMinutes === undefined && !only`) ⇒ không vào `--only` của mutate. Job `pentest` có service Mailpit 1025/8025 ⇒ CI xanh được. Evidence chỉ ghi `SMTP.host` / `hostname:port`, không ghi userinfo nếu `PENTEST_SMTP_URL` có credential.

## 🔴 Blocker
- [ ] **be/scripts/pentest/pentest.mjs:~103 (`smtpGreeting`, hàm `done`) — preflight không exit khi SMTP nhận kết nối mà không chào.**
  `done` gọi `sock.end('QUIT\r\n')`, tức chỉ half-close. Nếu server đã accept mà không đọc, không đóng (đúng trạng thái Mailpit kẹt của DEBT-664: Recv-Q đầy, docker-proxy vẫn accept phía host), socket còn ref và giữ event loop. Harness chỉ đặt `process.exitCode`, không `process.exit` ⇒ process treo.
  Bằng chứng (scratchpad, server im lặng ở process riêng): bản hiện tại trả greeting rỗng sau ~1 s rồi treo tới khi `timeout 15` giết (rc 124). Thêm `sock.unref()` trong `done` ⇒ thoát sau 1022 ms, rc 1.
  Vì sao chặn: D94.9-4 yêu cầu "không 220 ⇒ refuse, exit 1". Đúng ca hỏng chính mà preflight nhắm tới thì lại treo. `HYG-SMTP-AFTER` dùng cùng hàm ⇒ lượt đầy đủ cũng treo ở cuối. `mutate.mjs` spawn `pentest.mjs` ⇒ treo theo. Tester gate bước 5–7 sẽ kẹt thay vì đỏ rõ ràng. CI vẫn fail-closed nhờ step timeout, nhưng phải chờ 10'.
  Đề xuất: trong `done` thêm `sock.unref();` sau `sock.end(...)` (giữ QUIT lịch sự, không giữ process), hoặc dùng `sock.destroy()`. Kiểm tay một lần với server im lặng như trên.

## Security invariants / trust boundaries đã kiểm
- **Failure behavior (mail)**: pool + lỗi kết nối ⇒ `SMTPPool` gọi `queueEntry.callback(err)` cho thư đang gửi trên kết nối hỏng, bỏ kết nối, tạo kết nối mới cho thư kế ⇒ mỗi thư fail một lần ⇒ `sendMail` reject ⇒ `.catch` trong `issueToken` ⇒ `observeBackgroundWriteFailure('auth_mail')` (D91.3) tăng theo từng thư. Không có đường nào nuốt lỗi.
- **Shutdown**: `issueToken` dùng `void this.mailer.send(...)`, không nằm trong `pending` ⇒ drain D91.11 KHÔNG chờ thư. Sau drain, `close()` chỉ đóng kết nối rỗi; kết nối đang gửi chạy tiếp thư hiện tại (nhưng Nest `process.kill` ngay sau hook nên có thể chết giữa chừng); thư còn trong hàng đợi bị reject "Connection pool was closed" ⇒ đếm `auth_mail` + log. Vậy thư chờ lúc shutdown bị mất nhưng có đếm. So với trước (không pool, mọi thư chạy ngay, process kill cắt ngang) không tệ hơn về bản chất; khác ở chỗ burst nằm trong hàng đợi lâu hơn. Đã có trong DEBT-683.
- **DEBT-683 (bộ nhớ)**: SMTP chết kiểu black-hole ⇒ mỗi thư chờ `connectionTimeout` 5 s, 5 kết nối ⇒ xả ~1 thư/s; đầu vào chỉ bị chặn bởi throttle `/forgot`/`/register` (theo IP/account), attacker phân tán có thể đẩy nhanh hơn. Mỗi entry vài KB ⇒ bộ nhớ tăng chậm (cỡ chục MB/giờ ở 10 thư/s), nhưng độ trễ thư tăng không giới hạn (link hết hạn trước khi tới). Alert `SsoBackgroundWriteFailed` vẫn bắn ngay từ thư fail đầu tiên. Giữ P3 như tech-lead, không chặn.
- **CI injection**: không có `${{ }}` trong `run:`; `BEFORE` chỉ dùng ở vị trí đã quote.
- **Exposure**: preflight/HYG chỉ ghi host:port và 3 ký tự mã greeting.

## 🟡 Nên sửa
- **ci.yml step `mut` — `cancel-in-progress` làm lọt thay đổi.** Workflow có `concurrency.cancel-in-progress: true` theo ref. Push A (đổi `csrf.service.ts`) bị push B (chỉ docs) huỷ ⇒ run của B diff `A..B` chỉ thấy docs ⇒ `run=false` ⇒ thay đổi của A không bao giờ qua mutation. Repo này push thẳng `develop` nên ca này có thật. Đề xuất tối thiểu: với `push` luôn `run=true` (mutation ~4', job còn dư), chỉ lọc ở `pull_request`; hoặc ghi rõ giới hạn trong comment và backlog.
- **smtp.mailer.ts:L8–11 — comment dễ hiểu nhầm.** "closed at shutdown, after the detached-write drain" dễ đọc thành thư đã được drain. Thực tế drain không chờ `mailer.send` (`void` trong `issueToken`), thư trong hàng đợi bị bỏ (đếm `auth_mail`). Nên viết thẳng: queued mails are rejected at close (counted as `auth_mail`), DEBT-683.
- **DEBT-688 (đánh giá theo yêu cầu)**: không chặn lô B (lỗi chiều fail-safe: exit 1 giả, không xanh giả; CI không có DB E2E nên `e2eBefore` null). Nhưng ở tester gate thứ tự là E2E ⇒ X3 ⇒ mutate ⇒ harness; token reset E2E sống 30' rất dễ hết hạn đúng trong cửa sổ harness ⇒ exit 1 giả có xác suất cao. `devUnchanged` (`sso-idp`) cùng bệnh. Hai lựa chọn:
  1. Không sửa trong run này: tester chấp nhận exit 1 CHỈ khi `evidence.namespace` cho thấy mọi khác biệt e2e là giảm ở collection có TTL (`emailverificationtokens`, `passwordresettokens`, `refreshtokens`, ...), không collection nào tăng, mọi check `must` xanh; ghi rõ trong `log.md`.
  2. Sửa tối thiểu (~5 dòng, `drills/lib.mjs` `postCheck`): coi là unchanged khi mọi collection khác nhau đều có index `expireAfterSeconds` (đọc `listIndexes`) và `after <= before`; tăng hoặc đổi ở collection không TTL vẫn đỏ. Đánh đổi: harness lỡ xoá doc TTL của E2E sẽ bị che; chấp nhận được.
  Khuyến nghị: làm (2) vì backend-dev đằng nào cũng quay lại sửa 🔴.

## 💭 Nit
- `HYG-MAIL` có thể xanh nhờ thư `@pentest.invalid` sót từ lượt trước bị ngắt (`cleanMailpit` chỉ chạy ở cuối). Gọi thêm `cleanMailpit()` ở đầu (sau preflight) để check chỉ đếm thư của lượt này.
- Mẫu detect không gồm `be/tsconfig*.json`: đổi cấu hình compiler có thể làm neo `from` của mutant lệch mà step không chạy. Cân nhắc thêm `^be/tsconfig[^/]*\.json$`.
- `be/test/mailer.int-spec.ts:13` tạo `SmtpMailer` (giờ là pool) mà không đóng ⇒ kết nối rỗi tới Mailpit sống ~10 s trong worker jest. Gọi `onApplicationShutdown()` sau `send` cho sạch.

## ✂️ Ponytail
- be/scripts/pentest/pentest.mjs:L117: delete: `mailpitCount()` lặp lại cùng truy vấn search của `cleanMailpit()`. Dùng giá trị trả về của `cleanMailpit()` (đã lọc `@pentest.invalid`) làm `actual` của `HYG-MAIL` (`typeof n === 'number' && n >= 1`), push check ngay sau dòng `evidence.mailpitDeleted = ...`.
- be/src/modules/mailer/mailer.spec.ts:L93: shrink: server SMTP giả thứ hai chép gần nguyên server của suite run 83 (L160). Tách một helper `fakeSmtp({ onRcpt, onMessage })` dùng chung.
net: -35 lines possible.

---

# Senior Review — 2026-11-18 — Lô B lượt 2 (retry 1)

## Kết luận: PASS (không còn 🔴) ⇒ tester (lô D)

Đã chạy: unit `test/drills-namespace.spec.ts` + `src/modules/mailer/mailer.spec.ts` 30/30 PASS; `node --check` pentest/checks/mutate/drills lib OK; js-yaml 5.4.2 parse `ci.yml`: 9 job, `pentest` timeout 40, checkout `fetch-depth: 2`, env step `mut` chỉ còn `EVENT`. Chạy lại `b94/cli3.mjs` (hàm `smtpGreeting` cắt nguyên văn từ `pentest.mjs` lúc chạy) với server im lặng `b94/srv.mjs`: greeting rỗng sau 6007 ms, process thoát sau 6010 ms, code 1. Không đụng Mongo/Redis, không chạy harness.

## Tổng quan
- 🔴 lượt 1 đã đóng: `sock.unref()` sau `sock.end('QUIT')`. Preflight và `HYG-SMTP-AFTER` giờ đúng D94.9-4 cả ở ca SMTP accept mà im lặng.
- `ci.yml`: mọi `push` (và sự kiện khác) luôn chạy mutation, chỉ `pull_request` lọc theo `git diff HEAD^1 HEAD` ⇒ hết lỗ `cancel-in-progress`. Bỏ `BEFORE` ⇒ script ngắn hơn. PR: `fetch-depth: 2` đủ (merge commit + 2 parent); không có `HEAD^1` ⇒ `run=true`. Vẫn không có `${{ }}` trong `run:`. Mẫu thêm `^be/tsconfig[^/]*\.json$`.
- `smtp.mailer.ts` comment giờ nói đúng: drain không chờ thư, thư còn trong hàng đợi lúc đóng bị reject (mất, có đếm `auth_mail`), DEBT-683.
- `HYG-MAIL`: `cleanMailpit()` ở đầu lượt (sau khi đã giữ lock + namespace, `evidence.mailpitStale`) rồi dùng số trả về của `cleanMailpit()` cuối lượt ⇒ chỉ đếm thư của lượt này; `mailpitCount` đã xoá. `cleanMailpit` chỉ xoá thư mà MỌI người nhận là `@pentest.invalid` ⇒ không đụng thư E2E.
- `mailer.int-spec.ts` đóng pool trong `finally`.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **DEBT-688 không thành lỗ xanh giả cho việc harness GHI vào DB E2E/dev**: `sameButExpired` chỉ chấp nhận khác biệt là GIẢM ở collection có TTL và collection có mặt ở cả hai bên. Tăng (ở bất kỳ đâu), đổi ở collection không TTL, collection mới/mất, DB xuất hiện/mất đều vẫn đỏ. 10 ca unit phủ đúng các nhánh đó; mutant tay của dev (bỏ điều kiện giảm / có mặt) làm đỏ 2 ca.
- **Câu hỏi "có thể bị lừa không"**: có, ở hai dạng, đều chấp nhận được:
  1. Harness XOÁ doc chưa hết hạn trong collection có TTL của E2E/dev (ví dụ `passwordresettokens`) ⇒ bị coi là hết hạn. Không có đường code nào của harness nhắm tới `sso-idp-e2e`/`sso-idp` (namespace guard `assertNamespace`, mọi ghi đi qua DB `vg-pentest*`), nên đây là lưới thứ hai, không phải lớp bảo vệ chính.
  2. Harness ghi N doc rồi TTL xoá ≥ N doc cùng collection ⇒ bù trừ. Cần cả ghi sai DB lẫn trùng thời điểm; xác suất thấp.
  `ttlCollections` đọc `indexes()` lúc sau (`expireAfterSeconds !== undefined`) ⇒ đúng cho mọi TTL index kể cả `expireAfterSeconds: 0`. Muốn chặt hơn: so thêm số doc có `expiresAt < now` (chỉ giảm ≤ số đã hết hạn lúc trước + cửa sổ chạy). Không cần cho run này.
- Exposure: evidence chỉ thêm `mailpitStale` (số hoặc chuỗi lỗi), không lộ dữ liệu thư.

## 🟡 Nên sửa
- Ponytail lượt 1 còn mở: `mailer.spec.ts` có hai server SMTP giả gần như giống nhau (L93 và L160). Không chặn ⇒ DEBT-689 (P3) trong backlog.

## 💭 Nit
- Comment `ci.yml` đúng: push luôn chạy mutation, nên mỗi push lên `develop` dài thêm khoảng 4 phút. Chi phí này chấp nhận được với timeout 40.

## ✂️ Ponytail
- be/src/modules/mailer/mailer.spec.ts:L93: shrink: server SMTP giả trùng với suite run 83 (L160). Gom vào helper `fakeSmtp({ onRcpt, onMessage })` (DEBT-689).
- be/scripts/pentest/pentest.mjs: `mailpitCount` đã bị xoá đúng như đề xuất.
net: -25 lines possible.
