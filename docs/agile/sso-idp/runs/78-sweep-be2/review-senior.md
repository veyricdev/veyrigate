# Senior Review — 2026-11-09 (run 78, sweep 🟡 BE đợt 2)

## Kết luận: PASS (lượt 2 — lượt 1 REJECT, xem bên dưới)

Code T1–T6 đúng, test có bắt lỗi thật; **một 🔴 duy nhất ở tài liệu vận hành** (runbook-ops §0) — khối lệnh mẫu chạy lệnh ghi thật ngay sau dry-run, không có điểm dừng, nên DEBT-257 chưa thật sự đóng. Sửa 2–4 dòng doc là PASS (không cần chạy lại gate code). ⇒ **backend-dev**.

## Tổng quan

- Diff nhỏ, gom đúng module, tái dùng `revokeAllUserCredentials` / `FAMILY_ID` / `scrubUriCredentials` / `mongoTarget` thay vì viết logic song song. Không thay đổi ngoài phạm vi.
- Kiểm lại: `pnpm test` (sync-indexes + refresh-token spec) 34/34; `pnpm test:int` (`ui.int-spec` + `db-cli-dry-run.int-spec`) 99/99; `dist/` có `isDryRun`/`cliErrorText` (build mới). `git diff` sạch mutation.
- Độ lệch dev trong `log.md` — đánh giá:
  - T1 mutation `'after'` không làm int đỏ: **chấp nhận**. `rotate` chỉ đọc field không bị `$set` đổi; unit spy tham số 3 là chốt đúng, ngữ nghĩa 'before' vẫn được int rotate/reuse phủ.
  - T3 test ở `ui.int-spec` (mock DI) thay vì 2 session Redis thật: **chấp nhận**. Mock gọi `AuthenticationService.prototype.revokeAllUserCredentials` thật nên phần cần chứng minh (controller dùng đường chung, đủ 3 bước, fail-closed) được kiểm; bản thân `revokeAllUserCredentials` đã có unit + int store thật (admin lock/reset, DEBT-055).
  - T5 `grep err.message be/src/database` = 3: **chấp nhận** — 1 là helper, 2 là log module đã scrub sẵn; 0 catch CLI in thô.
  - T6 `db:seed -- --dry-run` exit 1 khi thiếu `ADMIN_SEED_PASSWORD`: **chấp nhận và đúng** — dry-run phải kiểm env như lệnh thật; runbook đã ghi "env sai/thiếu ⇒ exit 1 trước khi in đích".

## 🔴 Blocker

- [ ] `docs/agile/sso-idp/runbook-ops.md` §0 (khối bash mới ~:30-35) — **lệnh ghi thật chạy tự động ngay sau dry-run**.
  Khối `( export MONGO_URI=...; pnpm ... db:sync-indexes -- --dry-run; # comment; pnpm ... db:sync-indexes )` khi dán nguyên (cách ops thường làm với code block) sẽ chạy cả hai lệnh liên tiếp; dòng comment "sai ⇒ thoát, DỪNG" không dừng được gì.
  Vì sao: đây đúng kịch bản DEBT-256/257 cần chặn (diễn tập run 40: đích sai, không kịp Ctrl-C). `db:sync-indexes` có thể drop index / đặt TTL audit làm XOÁ VĨNH VIỄN audit > 180 ngày; `db:seed` ghi user/secret. Dry-run vô nghĩa nếu không có điểm xác nhận giữa nó và lệnh thật ⇒ AC DEBT-257 ("xác nhận đích ⇒ chạy lệnh thật") chưa thỏa.
  Đề xuất (chọn một): (a) mở subshell tương tác `bash` → `export MONGO_URI=...` → chạy dry-run → đọc → gõ lệnh thật → `exit`, viết thành các bước đánh số, không phải một block; hoặc (b) giữ một block nhưng chèn cổng xác nhận:
  `read -r -p 'target dung? gõ yes: ' ok && [ "$ok" = yes ] && pnpm --filter be db:sync-indexes`.
  Áp tương tự cho tham chiếu §seed (:191) và bước 5 (:273) nếu chúng dẫn chiếu khối này. Cập nhật dòng DEBT-257 trong backlog cho khớp.

## Security invariants / trust boundaries đã kiểm

- **T3 logout `scope=all`** (`ui.controller.ts:354-366`): `revokeAllUserCredentials` chạy cả 3 bước (pre_revoke → sessions MARK → sweep) dù bước trước ném, rồi ném lỗi đầu ⇒ 5xx qua `HtmlExceptionFilter` TRƯỚC audit/clear cookie/redirect ⇒ không audit success, không Set-Cookie xoá, không `Location`, body không chứa message lỗi (test kiểm `not.toContain('boom')`). Không revoke đôi gây lỗi: sweep cũ của controller đã bị gỡ khỏi nhánh global (`if (!global)`), mọi revoke idempotent. `rpCandidates` vẫn thu trước revoke. Nhánh `scope=session` giữ nguyên thứ tự (revokeForSession → revoke → sweep). Failure-audit thiếu = DEBT-521 đã ghi. OK.
- **T4 `idp_fed`** (`federation.controller.ts:152-158`): giá trị set lại = `req.cookies[this.bindingCookie]`, chính giá trị `FederationService.callback` vừa so `constantTimeEqual(sha256(binding), record.bindingHash)` sau `states.consume` single-use (`federation.service.ts:146-151`) — attacker không cấy/ghi đè được (không có binding hợp lệ thì đã `invalid_state` trước nhánh này). Chỉ gia hạn ở `link_required`; `signed_in`/`denied`/lỗi không set (test signed_in kiểm `undefined`). Tên `__Host-` khi Secure, không phát `idp_fed` trần (test secure app kiểm). Kéo dài binding chỉ tới `FED_LINK_TTL_MS` (600s) — cùng trần với state, không mở rộng phạm vi. Pending link vẫn single-use + so binding ở POST `/auth/link`. Không vào log/URL. OK.
- **T2 cursor** (`admin-users.controller.ts:371-374`): kiểm SAU `mustFind` ⇒ user tenant khác vẫn 404 (không oracle qua 400 vs 404); mô tả cố định, không phản chiếu `after`; `listFamilies` không được gọi. Query lặp `after=a&after=b` (mảng) ⇒ ép chuỗi có dấu phẩy ⇒ 400. OK.
- **T5 scrub** (`sync-indexes.ts:92-96`): thay literal `MONGO_URI` trước, rồi regex userinfo. Đã thử: `mongodb+srv://u:p%40w@a.b,c.d/db?authSource=admin` ⇒ `[redacted]@a.b,c.d/...` (srv + nhiều host + encode OK). Non-Error ⇒ chuỗi cố định. Còn lỗ nhỏ (🟡 bên dưới): mật khẩu dạng đã decode chứa `@` chỉ bị cắt tới `@` đầu; option bí mật ở query (`tlsCertificateKeyFilePassword=`) không được scrub nếu driver lặp lại ở dạng khác literal.
- **T6 `--dry-run`**: return trước `createConnection` ở cả 3 CLI, sau `assertNotProduction`/`validateEnv`/đọc config; chỉ in `mongoTarget` (allowlist). Test CLI build thật: exit 0, < 3s, stderr rỗng, stdout chính xác, không chứa secret; không cờ ⇒ exit 1, không secret. Parse: `includes('--dry-run')` ở bất kỳ vị trí nào (kể cả sau `--` của pnpm) ⇒ an toàn theo chiều "có cờ ⇒ không kết nối". Chiều ngược lại fail-open với biến thể gõ sai (🟡 bên dưới).
- **T1**: `{ returnDocument: 'before' }` cùng ngữ nghĩa `new:false`; filter `revokedAt: null` + swap nguyên tử giữ nguyên ⇒ reuse detection không đổi.

## 🟡 Nên sửa

- `be/src/database/mongo/sync-indexes.ts:99-101` `isDryRun` — **cờ an toàn fail-open khi gõ sai**: `--dry-run=true`, `--dryrun`, `--dry_run`, `-n` đều bị bỏ qua ⇒ CLI kết nối và GHI thật. Vì sao: người gõ một biến thể của cờ an toàn tin rằng mình đang chạy khô; với `db:sync-indexes` hậu quả là drop index/TTL audit. Đề xuất: 3 CLI từ chối mọi đối số không biết (`argv.slice(2).filter(a => a !== '--' && a !== '--dry-run')` khác rỗng ⇒ in `unknown argument` + exit 1 trước kết nối) + 1 ca test CLI `--dry-run=true` ⇒ exit 1. (Tech-lead fold chốt "cờ khác giữ hành vi cũ" nên không chặn run này.) → DEBT-522.
- `be/src/common/logger/error-log.ts:26` / `cliErrorText` — scrub còn sót: mật khẩu decode chứa `@` (`u:p@ss@h`) ⇒ còn `ss@h`; secret ở query (`tlsCertificateKeyFilePassword`, `authMechanismProperties=AWS_SESSION_TOKEN:`) không scrub. Rủi ro thấp (driver hiếm khi lặp lại dạng decode), lớp literal đã phủ trường hợp chính. Đề xuất: regex userinfo lấy tới `@` CUỐI trong authority (`[^\s/?#]*@` tham lam trong authority) + che giá trị các key query có `password|token|secret`. → DEBT-523.

## 💭 Nit

- `be/src/modules/ui/ui.controller.ts:357` comment "family -> sessions MARK -> SWEEP below, done inside" — "below" sai (sweep nằm trong service). Và block comment SWEEP dài :368-375 giờ chỉ áp cho nhánh session — xem ponytail.

## ✂️ Ponytail

- be/src/modules/federation/federation.controller.ts:L264: shrink: `linkCookieOptions()` giờ trùng hệt `bindingCookieOptions(FED_LINK_TTL_MS)`. Gọi `this.bindingCookieOptions(FED_LINK_TTL_MS)` (đổi tên `cookieOptions(ttlMs)`), xoá hàm (~-9 dòng).
- be/src/modules/ui/ui.controller.ts:L376: shrink: `if (!global) { tokenCount += revokeForSession(...) }` tách rời khỏi nhánh else chỉ để giữ chỗ comment. Dời sweep vào cuối nhánh `else` (sau `sessions.revoke`), rút block comment SWEEP còn 2 dòng (~-6 dòng).
- (→ DEBT-524)

net: -15 lines possible.

---

# Lượt 2 — 2026-11-09

## Kết luận: PASS ⇒ tester

🔴 lượt 1 đã sửa; DEBT-522/523/524 sửa đúng ý. Còn 1 🟡 mới (ReDoS regex scrub mới) ⇒ DEBT-525, không chặn.

Kiểm lại: `pnpm test` error-log + sync-indexes spec 38/38; `pnpm test:int` db-cli-dry-run + ui + federation 221/221. `git diff` không còn mutation.

## 🔴 lượt 1 — runbook-ops cổng xác nhận: ĐÃ ĐÓNG
`runbook-ops.md:30-33`, §3c `:194-197`, khôi phục bước 5 `:280`: `( export …; pnpm … -- --dry-run && read -r -p '…' ok && [ "$ok" = yes ] && pnpm … )`. Kiểm các lỗ người điều phối nêu:
- **Dán nguyên khối (bash)**: bash parse xong cả `( … )` rồi mới chạy ⇒ `read` chờ phím thật; chỉ dòng `yes` gõ tay mới qua. Dòng dán THỪA sau `)` sẽ rơi vào `read` — runbook đã ghi "Dán CHỈ khối này"; phải đúng chữ `yes` mới qua ⇒ chấp nhận.
- **`set -e`**: không liên quan — chuỗi `&&`, mọi lỗi (dry-run exit 1, `read` EOF, khác `yes`) đều dừng trước lệnh ghi.
- **Shell không phải bash**: zsh `read -p` = đọc coprocess ⇒ lỗi ⇒ `&&` dừng; dash/sh `read -p` không hỗ trợ ⇒ lỗi ⇒ dừng; PowerShell ⇒ parse lỗi. Tất cả **fail closed** (không chạy lệnh ghi).
- **stdin là pipe/file** (`bash < file`): `read` đọc dòng kế tiếp/EOF ⇒ chỉ qua nếu dòng đó đúng `yes` (cố ý) ⇒ chấp nhận.
- Lệnh thật cùng subshell ⇒ cùng env đã dry-run (biến export thắng `--env-file-if-exists`).

## DEBT-522 `isDryRun` — OK
`sync-indexes.ts:102-106`: `argv.slice(2)` bỏ `--`, mọi đối số khác `--dry-run` ⇒ ném `unknown argument (allowed: --dry-run)` (không phản chiếu đối số). Gọi ĐẦU `main` (trước `assertNotProduction`/`validateEnv`/in đích/kết nối) ở 3 CLI ⇒ catch ⇒ exit 1. Cờ node (`--env-file-if-exists`) nằm ở `execArgv`, không ở `argv` ⇒ không vướng. Không phá luồng: các nơi gọi CLI trong repo (`be/package.json` scripts, `e2e/playwright.config.ts:45`, `e2e/playwright.x3.config.ts:66-67`) không truyền đối số; không Dockerfile/workflow nào gọi CLI; Jest import không chạy `main` (`require.main` guard); `seed-e2e-admin.ts` import hàm, không gọi CLI. E2E 38/X3 42 của dev xác nhận.

## DEBT-523 scrub — đúng chức năng, nhưng regex mới có ReDoS
- Userinfo `[^\s/?#]*@` (tham lam tới `@` cuối trước `/ ? #`/khoảng trắng): `@` trong path/query không bị nuốt (dừng ở `/`/`?`); nhiều host + srv OK. URI không có scheme không được scrub — chấp nhận: `MONGO_URI`/`REDIS_URL` bắt buộc scheme qua `validateEnv`, và `cliErrorText` đã thay literal URI trước.
- Che query key pass/pwd/secret/token/key/cred/auth: đúng, che dư (`authSource`, `author=`, `keyboard=`) là phía an toàn trong log lỗi.

🟡 **Hiệu năng/ReDoS: regex che key=value có độ phức tạp ~bậc ba**
`be/src/common/logger/error-log.ts:33-35` — `\b([\w.-]*(?:pass|…|key|…)[\w.-]*)=` : hai `[\w.-]*` bao quanh một alternation, cộng `\b` khớp ở mỗi `.`/`-`. Đo (Node, regex copy nguyên): chuỗi `"key."` lặp 1000 ⇒ 55 ms, 2000 ⇒ 429 ms, 4000 (16 KB) ⇒ 3,1 s; ~20 KB treo vài phút (lần đo đầu của tôi phải dừng tay).
Vì sao: hàm chạy trên event loop của APP (`redis.module.ts:72`, `mongo.module.ts:37`, `health.controller.ts:82`), không chỉ CLI. Đầu vào là message lỗi driver/Redis — không phải input request trực tiếp, nên khả năng khai thác thấp (không 🔴), nhưng một message dài bất thường có thể chặn tiến trình hàng giây.
Đề xuất: viết tuyến tính — `text.replace(/([\w.-]+)=([^\s&#;]*)/g, (m, k) => SECRET_KEY.test(k) ? `${k}=[redacted]` : m)` với `SECRET_KEY = /pass|pwd|secret|token|key|cred|auth/i`, và/hoặc cắt `text` ≤ 2 KB trước khi scrub; thêm unit timing (`'key.'.repeat(5000)` < 50 ms). Ghi chú: regex userinfo (cũ lẫn mới) bậc hai theo dải chữ cái dài không có `://` (`'a'` × 40000 ⇒ 2 s) — có từ trước, cắt độ dài cũng xử lý luôn. → DEBT-525.

## DEBT-524 ponytail — OK
`federation.controller.ts`: `linkCookieOptions` xoá, idp_link set/clear dùng `bindingCookieOptions(FED_LINK_TTL_MS)` (object y hệt cũ). `ui.controller.ts`: sweep session vào cuối `else`, comment rút gọn, "SWEEP below" sửa.
💭 Tên `bindingCookieOptions` giờ dùng cả cho `idp_link` — `fedCookieOptions(ttlMs)` rõ hơn (không cần sửa).

## ✂️ Ponytail lượt 2
- be/src/common/logger/error-log.ts:L33: shrink: regex key=value lồng 2 `[\w.-]*` quanh alternation. Một regex `([\w.-]+)=` + test key bằng callback (tuyến tính, cùng số dòng).
net: -0 lines possible (thay thế, không xoá). Phần còn lại: Lean already. Ship.
