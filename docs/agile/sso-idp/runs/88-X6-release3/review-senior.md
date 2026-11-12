# Senior Review — 2026-11-12 (run 88, T1–T3, working tree on `6e68a1f`)

## Kết luận: PASS

Không còn 🔴. Có 6 🟡 (vào backlog DEBT-627…632), vài 💭. Chuyển **tester** T4. Riêng 🟡-1 (runbook in secret qua log driver của Docker) là một cờ `--log-driver none` trên hai lệnh: nên sửa **trước** lượt tay runbook §16 của T4, vì tester sẽ chạy đúng lệnh đó.

## Tổng quan

Diff gọn và bám fold. Mấy điểm tốt cần ghi lại:

- **T1** đúng mô hình D88.6. Secret và hash Argon2 được sinh trước callback (callback có thể chạy lại). Touch `opslocks` là câu đầu tiên. Audit được insert **trong** transaction, nên audit lỗi thì mọi ghi khác cũng mất. Secret chỉ in sau commit. Nếu in lỗi sau commit thì có thông báo hướng dẫn `--rotate-secret`. Refusal, drift và index kiểm trước khi ghi. `target:` được in trước mọi lần đọc. Tham số đi qua allowlist, không echo giá trị. Lỗi URI chỉ nêu tên biến và vị trí phần tử (thông điệp của `InvalidRedirectUriError` không chứa URI). `ensureAdminPlane` tách sạch: không có `session` thì giữ nguyên hành vi `upsert` nuốt E11000 của seed, có `session` thì mọi lỗi lan ra để transaction abort.
- **T2**: trình tự huỷ phiên đã gom thành **một** helper `revokeOneSession` mà cả `POST /logout` và `/account/sessions` cùng gọi. Rủi ro "chép trình tự thứ hai" của fold đã được khép. Hai lớp chống IDOR: `findOwned` (SISMEMBER + `userId` đã lưu) và `revokeByDevice` kiểm lại lần nữa. Key thiết bị tin cậy suy ra từ `userId` của phiên. Ca 404 không ghi `ref`/`device` vào audit. Xác thực lại dùng chung bucket 5/900 s với `/account/password`: reserve trước Argon2, refund khi đúng hoặc khi không có mật khẩu.
- **T3**: origin lấy từ `outcome.redirectUri` đã khớp tuyệt đối (qua `safeCspOrigin`, chính giá trị dùng cho CSP `form-action`). Int spec chứng minh `redirect_uri=evil…` trên query không lọt vào HTML. Tra mô tả scope dùng `Object.hasOwn`, nên scope tên `constructor` không đọc được prototype. `revokeOwn` = một `findOneAndUpdate({_id, userId})` before-image, idempotent bằng `$ifNull`. Sweep chạy cả khi `alreadyRevoked` (DEBT-151).
- Template Eta: mọi giá trị động đi qua `<%= %>`, và `autoEscape: true` (`src/bootstrap.ts:53`). Chỗ raw duy nhất là `<%~ confirm() %>` trả chuỗi hằng.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| CSRF trên mọi POST mới (`/account/sessions/revoke`, `revoke-others`, `/account/devices/forget`, `forget-others`, `/account/apps/revoke`) | ✅ `@UseGuards(CsrfGuard)` trên cả 5 route; identity = cookie phiên (`formCsrfIdentity`) | int AC5 (T2), AC7 (T3): thiếu `_csrf` hoặc CSRF của identity khác ⇒ 403, không đổi gì |
| Không bỏ qua được xác thực lại | ✅ `reauth()` chạy trước mọi thao tác huỷ/quên; `authTime` tính bằng ms (cùng đơn vị `Date.now()`, kể cả federation `upstreamAuthTime` ×1000); chỉ đúng khi `authTime ≥ now−300 s` hoặc `verifyCurrentPassword` = ok. Không có đường nào nâng `authTime` mà không xác thực (chỉ `establish`) | int AC3, AC12 |
| Đoán mật khẩu qua ô xác thực lại | ✅ bucket `pwc:` dùng chung, reserve trước Argon2, sai thì không refund; lần thứ 6 ⇒ 429 | int AC3 |
| IDOR phiên | ✅ `findOwned` = SISMEMBER `user_sess:{userId}` + `data.userId === userId`; ref không đúng dạng thì không truy vấn; 404 cố định, audit không có `ref` | int AC4 |
| IDOR thiết bị | ✅ `ZREM dc:{u:<sha256(userId của phiên)>}`; không chạm được ZSET của user khác | int AC9 |
| IDOR consent | ✅ filter `{_id, userId}`; `consent_id` sai dạng thì không truy vấn; 404 cố định, audit không có id | int AC6 + unit `revokeOwn` |
| Huỷ phiên: families → xoá + tombstone → sweep; race với `/token` | ✅ helper chung; dừng ở lỗi đầu, ghi `failedStep`, ném lại lỗi gốc | int AC2, AC7 (×20), AC8 |
| Fail-closed | ✅ Redis/Mongo lỗi ⇒ ném lên `HtmlExceptionFilter` ⇒ 5xx; không render danh sách rỗng giả, không báo thành công | int AC8 (T2, T3) |
| Exposure trang phiên | ✅ không IP, UA thô hay email; nhãn chỉ lấy từ allowlist; UA bị cắt ở 512 ký tự trước khi chạy regex (không có ReDoS: không có lượng từ lồng nhau); `ref` = `sid` công khai; `device` = sha256 một chiều của cookie, chỉ chủ tài khoản thấy | unit device-label (≥ 12 UA + `<script>`/CRLF/10 KB), int AC1 |
| XSS | ✅ Eta autoEscape; `clientId`/scope/resource nguy hiểm cài sẵn trong DB đều được escape | int AC9 (T3) |
| Origin hiển thị lấy từ input không tin cậy | ✅ chỉ lấy từ context đã xác thực, kể cả khi resume `request_id` | int AC1 (×2) |
| Open redirect | ✅ mọi redirect mới là hằng (`/account/sessions?done=<kind>`, `/account/apps?done=revoked`, `/login?returnTo=%2F…`); giá trị `done` lạ thì chỉ là `DONE[done]` = undefined | đọc code |
| Bootstrap: tối đa 1 secret trên mọi lượt chạy song song | ✅ touch `opslocks` + snapshot ⇒ write conflict ⇒ lượt thua chạy lại và thấy credential | int AC3 ×20 có barrier |
| Bootstrap: secret không vào audit/log/argv | ✅ metadata chỉ gồm boolean, `ticket`, `host`, đi qua `sanitizeMetadata`; secret chỉ đi qua `io.write` sau commit. **Ngoài code**: xem 🟡-1 (log driver của Docker) | int AC1, AC11 |
| Bootstrap không chạm `users`/`usertenants`/Redis | ✅ chỉ đọc (`usableSuperAdmins`, cùng định nghĩa `SuperAdminGuard`); child process `REDIS_URL` trỏ cổng 1 | int AC9 |
| Bootstrap refusal không ghi gì | ✅ refusal nằm trong transaction, trước bước ghi, hoặc ở tiền kiểm | int AC6 (4 ca), AC8 (3 ca) |

## 🟡 Nên sửa

1. 🟡 **Exposure: secret production đi qua log driver của Docker** (DEBT-627)
   `docs/agile/sso-idp/runbook-deploy.md` §16 bước 3 (và lệnh `--rotate-secret` ở phần sự cố): `docker run --rm -i … bootstrap.js` để stdout của container đi qua logging driver của daemon.
   Vì sao: với `json-file` mặc định, `--rm` xoá log khi container dừng. Nhưng host production thường cấu hình `journald`/`awslogs`/`gelf`/`fluentd`/`splunk`, và các driver này **chuyển** dòng `OIDC_CLIENT_SECRET=…` vào kho log tập trung. Như vậy bất biến D88.7 "không log" bị phá ngoài code.
   Đề xuất: thêm `--log-driver none` vào hai lệnh in secret (bỏ luôn `-i` vì CLI không đọc stdin), kèm một câu giải thích trong runbook. Nên sửa trước lượt tay T4.
2. 🟡 **Bootstrap: stdout gãy trước dòng secret thì operator không được hướng dẫn** (DEBT-628)
   `be/src/database/bootstrap.ts:413-416`: ba dòng `tenant/resource/client …` được in **trước** `OIDC_CLIENT_SECRET=`. Nếu stdout gãy ở đó (EPIPE), lỗi lan ra là `bootstrap failed: …` mà không có câu "--rotate-secret". Credential đã commit, và chạy lại chỉ in "unchanged".
   Đề xuất: in dòng secret là dòng đầu tiên sau commit, hoặc bọc mọi lần ghi sau commit (khi `secretIssued`) trong cùng `try` hướng dẫn rotate.
3. 🟡 **Audit: xác thực lại bị throttle không được ghi** (DEBT-629)
   `be/src/modules/authentication/authentication.service.ts:385-386`: `verifyCurrentPassword` bỏ qua `reserved.report`, trong khi `changePassword` (dòng 328) ghi `fail('throttled')` một lần mỗi cửa sổ.
   Vì sao: một phiên bị đánh cắp dò mật khẩu qua `/account/sessions` sẽ chạm trần mà không để lại dấu vết `throttled` (chỉ có các `reauth_failed` riêng lẻ). Hai cửa vào cùng một bucket mà tín hiệu cảnh báo lệch nhau.
   Đề xuất: khi `report` thì trả `{kind:'throttled', report:true}`, rồi controller ghi `SESSION_REVOKED`/`TRUSTED_DEVICE_REVOKED failure reason:'reauth_throttled'`.
4. 🟡 **Bootstrap: dòng cảnh báo cho `REDIRECT_URI_CHANGED`** (DEBT-630)
   `bootstrap.ts:304-314, 433-435`: `REDIRECT_URI_CHANGED` thuộc `ALERT_ACTIONS` (`audit-action.enum.ts:52`), nhưng CLI chỉ in dòng `{alert:true}` cho `ADMIN_BOOTSTRAPPED`. Hiện vẫn lần ra được nhờ `urisUpdated:true` trong sự kiện đó.
   Đề xuất: in một dòng `{alert:true, action, eventId}` cho **mỗi** audit thuộc `ALERT_ACTIONS` (lặp `audits`), như `AuditService.record` làm cho app.
5. 🟡 **`/account/sessions/revoke` bỏ qua kết quả `revokeByDevice`; hai đường xoá phiên lệch nhau** (DEBT-631)
   `be/src/modules/ui/account.controller.ts:139, 176`: bước 2 gọi `revokeByDevice`, hàm này kiểm chủ sở hữu **lần hai** và trả `false` mà **không ghi tombstone** khi phiên vừa biến mất giữa `findOwned` và bước 2. Local logout gọi `revoke(id)`, hàm này luôn ghi tombstone.
   Vì sao: hiện vô hại (phiên tự hết hạn thì không cần tombstone; logout song song thì logout đã ghi). Nhưng helper "chung" đang nhận hai `deleteSession` có ngữ nghĩa khác nhau, và giá trị trả về `false` bị nuốt im.
   Đề xuất: dùng `revokeRef(ref, userId, true)` (cần public hoặc thêm `revokeOwnedRef`), vì quyền sở hữu đã được `findOwned` chứng minh. Bớt một vòng Redis và hai đường thống nhất "luôn tombstone".
6. 🟡 **Helper private trùng giữa `UiController` và `AccountController`** (DEBT-632, dev đã tự nêu)
   `account.controller.ts:478-500` (`liveSession`, `identity`, `limit`) chép từ `ui.controller.ts`.
   Vì sao: `liveSession` là điểm xoá cookie chết, `limit` quyết định khoá chiều thiết bị. Lệch dần thì sẽ ra hai hành vi phiên khác nhau.
   Đề xuất: đưa vào một provider nhỏ (vd. `UiSessionHelper`) hoặc hàm thuần trong `ui/`. Nên làm ở run 89, vì `/account/mfa` sẽ là controller thứ ba dùng chúng.

## 💭 Nit

- `authorize.controller.ts` `accessMinutes: Math.round(ttl/60)`: TTL < 30 s thì hiện "0 minutes", và `refreshDays` < 0,5 ngày thì hiện "0 days". Config hiện tại không chạm tới, nhưng `Math.max(1, …)` thì rẻ.
- `consent.eta`: client native (custom scheme) không ra origin nên không có câu "will receive the result at". Hợp lý, nhưng có thể in chuỗi scheme cho người dùng thấy.
- `SessionService.findOwned` không kiểm hạn tuyệt đối như `listByUser`. Vô hại (huỷ một phiên đã quá hạn), chỉ khác nhất quán.
- `seed.ts`: bước 4 (`fe-admin`) giờ chạy **trước** `seedDev` + super_admin, không còn sau như trước. Tất cả đều insert-only nên kết quả cuối như cũ; ghi chú ở header seed đã cập nhật.
- `bootstrap.ts:400` regex `/^bootstrap: /` cùng lớp `Refusal`: hai cách nhận diện refusal. Một là đủ (cho `ensureAdminPlane` ném `Refusal`, hoặc bỏ lớp `Refusal`).
- Audit tự phục vụ không có `tenantId`, giống `/logout` hiện có, nên tenant_admin lọc theo tenant sẽ không thấy. Ghi để run 89 (DEBT-334) quyết định.

## ✂️ Ponytail

- be/src/database/bootstrap.ts:L198: delete: lớp `Refusal` cùng nhánh regex `/^bootstrap: /` trùng vai trò. Giữ một trong hai.
- be/src/database/bootstrap.ts:L209-210: shrink: `sameList` sort `b` lại trong mỗi lần gọi `every`. Sort cả hai một lần (`const x=[...a].sort(), y=[...b].sort()`) hoặc so `JSON.stringify` của hai mảng đã sort.
- be/src/database/bootstrap.ts:L114,124-125: stdlib: `z.string().optional().safeParse` chỉ để lấy chuỗi. Dùng `typeof env[name] === 'string' ? env[name] : ''`, bỏ zod ở đây.
- be/src/modules/ui/account.controller.ts:L478-500: delete: `liveSession`/`identity`/`limit` chép từ `UiController`. Dùng chung một helper (🟡-6).
- be/src/modules/ui/account.controller.ts:L139,176: shrink: `revokeByDevice` kiểm sở hữu lần hai sau `findOwned`. Gọi xoá theo ref trực tiếp (🟡-5).
- be/src/modules/ui/account.controller.ts:L444-461: shrink: `recordRevoked` có union hai nhánh chỉ để đổi metadata. Cho caller truyền `metadata` sẵn.

net: -35 lines possible.

## Verify (senior chạy lại)

- `pnpm -C be typecheck`: exit 0. `pnpm -C be lint`: exit 0.
- `pnpm -C be test`: 1069/1069 ở 3 lượt. Có **1 lượt** (chạy song song với int) ra 1068/1069, 1 test fail; không tái hiện được qua 3 lượt chạy lại, và log lượt đó không giữ tên test (chạy `--silent`). Ghi là flake chưa định danh: tester để ý ở gate T4, không chặn run này.
- `pnpm -C be test:int -- run88`: 3 suite, 45/45 xanh, trên container dùng chung `veyrigate-mongo:27117` / `veyrigate-redis:6479`, DB `vg-int-*` tự dọn. Không đụng `sso-idp` / `sso-idp-e2e`.
