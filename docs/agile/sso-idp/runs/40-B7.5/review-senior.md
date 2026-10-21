# Senior Review — 2026-10-20 (run 40 B7.5)

## Kết luận: REJECT

2 🔴: (1) [BE] `mongoTarget` lộ user/mật khẩu khi password có `/ ? #` chưa encode — đúng invariant F5 phải chặn; (2) [docs/ops] runbook §4c `updateMany` thu hồi toàn bộ RT không gắn `<db_mới>` ⇒ dễ chạy nhầm trên DB đang chạy, lệnh xác minh cho kết quả "0" giả, RT sống lại trên DB restore vẫn còn hiệu lực. Cả hai sửa nhỏ (vài dòng + test). Chuyển **backend-dev** (🔴1 code + test; 🔴2 văn bản runbook + giữ khớp spec §4(i)).

## Tổng quan

Chất lượng tốt. Runbook bám code thật: 22 route, 3 script `pnpm`, alert/metric đều có (đã grep `admin-*.controller.ts`, `audit-action.enum.ts`, `alerts.yml`, `package.json`; anchor trỏ sang `runbook-deploy.md` khớp heading). Các khẳng định khó đoán đều đúng với code và được spec khoá: audit API rỗng cho `TOKEN_REUSE_DETECTED` (DEBT-140), seed không reset mật khẩu/khoá, step-up 403 `{step_up_required,max_age:0}`, disable client ⇒ `401 invalid_client`, 409 khi tự disable client đang phát AT (`admin-clients.controller.ts:141`), §4c dùng đúng 2 update như `RefreshTokenService.revokeWhere` (`refresh-token.service.ts:653-675`) và lập luận "không có reuse burst" đúng theo `rotate` (reuse cần `revokedAt` + `replacedBy`). Diễn tập §4 thủ công có bằng chứng thật, đo được (count/index src==dst, RT giả sống lại rồi bị §4c vô hiệu, sync-indexes không drop index), dọn sạch, chặn bằng regex. Tester phát hiện L1 (không kịp Ctrl-C sau `target:`) là phát hiện có giá trị.

Đã chạy: `pnpm -C be test -- sync-indexes` 5/5; `tsc --noEmit` sạch. Không chạy lệnh runbook lên DB nào.

## 🔴 Blocker

- [ ] **[BE] `be/src/database/mongo/sync-indexes.ts:25` — `mongoTarget` lộ credential khi password chứa `/`, `?`, `#` chưa percent-encode.**
  Đo thực tế với đúng regex:
  ```
  mongodb://u:p/ss@h:1/db  => target: u:p/ss@h:1/db        (lộ user + TOÀN BỘ mật khẩu)
  mongodb://u:p?x@h/db     => target: u:p/test (default)   (lộ user + tiền tố mật khẩu)
  mongodb://u:p#x@h/db     => target: u:p/test (default)
  ```
  Vì sao: `(?:[^/?#]*@)?` không được vượt qua `/?#`, nên nhánh userinfo bị bỏ và `([^/?#@]+)` bắt luôn `user:pass`. Mật khẩu sinh dạng base64 (chứa `/`) mà người trực dán thẳng vào URI lúc sự cố là trường hợp thực tế. Dòng này được in TRƯỚC khi kết nối (driver chưa kịp từ chối URI sai), ra stdout/CI log, và runbook §3c còn dặn **"ghi `target:` vào biên bản"** ⇒ mật khẩu DB production vào biên bản sự cố. F5/F7 yêu cầu "không lộ password" ở mọi dạng URI.
  Đề xuất (fail-closed, allowlist thay vì blacklist): sau khi match, chỉ in khi phần host khớp ngữ pháp host list và phần db khớp ngữ pháp tên DB Mongo; ngược lại `target: (unparseable MONGO_URI)`. Ví dụ:
  ```ts
  const HOSTS = /^(?:[A-Za-z0-9._%-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:,(?:[A-Za-z0-9._%-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?)*$/;
  const DB = /^[^/\\. "$*<>:|?@]*$/;   // ký tự Mongo cấm trong tên DB, cộng thêm `@`
  if (!m || !HOSTS.test(m[1]) || !DB.test(m[2] ?? '')) return 'target: (unparseable MONGO_URI)';
  ```
  (Kiểm db là bắt buộc: `mongodb://user/x:pw@h` cho host `user` hợp lệ nhưng db `x:pw@h` chứa mật khẩu.) Thêm unit test cho 3 dạng trên + `user/x:pw@h`, assert không chứa `p`/`pw`.

- [ ] **[docs/ops] `runbook-ops.md:233-237` (§4c) — `updateMany` thu hồi toàn bộ RT chạy trên `db` hiện tại, không gắn `<db_mới>`.**
  Vì sao: §0 dặn mở `mongosh "<MONGO_URI>"` (URI production ⇒ `db` = DB **đang chạy/cũ**). §4b-3 dùng `db.getSiblingDB('<db_mới>')` nhưng không đổi `db`, rồi §4c dùng `db.refreshtokens...`. Người trực làm đúng từng dòng sẽ: (a) thu hồi mọi RT trên DB cũ (đăng xuất hàng loạt, và câu Rollback "RT đã thu hồi trên DB mới không ảnh hưởng DB cũ" thành sai); (b) `countDocuments({revokedAt:null})` chạy cùng handle sai ⇒ in `0`, **xác minh giả**; (c) DB restore vẫn còn RT sống lại (kể cả bản bị đánh cắp) ⇒ app trỏ sang ⇒ vi phạm bất biến (i) mà runbook tuyên bố đã xử lý. Đây đúng loại "updateMany nhầm DB" cần chặn.
  Đề xuất: viết snippet tự ràng buộc đích và in đích:
  ```js
  const d = db.getSiblingDB('<db_mới>'); print('DB:', d.getName());   // phải = <db_mới>, DỪNG nếu khác
  const now = new Date();
  d.refreshtokens.updateMany({ familyRevokedAt: null }, { $set: { familyRevokedAt: now } });
  d.refreshtokens.updateMany({ revokedAt: null }, { $set: { revokedAt: now } });
  d.refreshtokens.countDocuments({ revokedAt: null });   // kỳ vọng 0
  ```
  và §4b-2 nói rõ mở mongosh tới `<db_mới>` (hoặc dùng `d`). Spec §4(i) không cần đổi (nó chạy trên kết nối DB tạm).

## Security invariants / trust boundaries đã kiểm

- **Exposure**: runbook/report grep âm sạch (không PEM, không `password=`, không URI có credential, secret fe-admin che). `mongoTarget` sạch cho URI hợp lệ (userinfo có `@`/`:` encode hay không, nhiều host, `+srv`, query) — **hở với `/ ? #` chưa encode** ⇒ 🔴1. Lỗi CLI chưa scrub ⇒ đã có DEBT-254.
- **Đích ghi (state)**: CLI `target:` + kiểm khô §0 giảm rủi ro rơi về `be/.env`; mongorestore luôn `--nsFrom/--nsTo`, kiểm DB mới chưa tồn tại, cấm `--drop` — đúng. `dropDatabase` chỉ trong diễn tập, chặn regex + listDatabases — đúng. §4c thiếu ràng buộc DB ⇒ 🔴2. Break-glass §3d trên `db` là chủ đích (DB prod) nhưng nên in đích ⇒ 🟡.
- **Authorization**: rotate/ghi admin cần super_admin/`admin.write` + `RequireRecentAuth(5)` — spec §1 khoá (AT từ refresh ⇒ 403, JWKS không đổi). Break-glass 2 người + biên bản ngoài hệ thống, không audit ⇒ DEBT-252 đã ghi.
- **Replay/idempotency**: rotate không idempotent, runbook bắt kiểm `GET /admin/keys` + audit trước khi gọi lại — đúng DEBT-158. Sau restore: stale RT đã rotate trước backup vẫn bắn reuse (tín hiệu thật), RT bị §4c thu hồi ra `invalid_grant` — spec §4(i) khoá cả hai.
- **Failure behavior**: seed `NODE_ENV=production` từ chối trước ghi (spec §3). Nhưng guard chỉ dựa vào `NODE_ENV` mà lệnh §3c lại tự đặt `NODE_ENV=development` ⇒ 🟡3.
- **Chuỗi request**: sau emergency rotate, AT dùng để xoay chết ⇒ runbook xác minh bằng AT mới từ refresh (L5) — đúng và đã khoá.

## 🟡 Nên sửa (→ backlog DEBT-257…260)

- **[docs] `runbook-ops.md:23-27` — kiểm khô và lệnh thật là 2 lần gõ biến riêng.** Kiểm khô đúng không bảo đảm lệnh thật không gõ sai tên biến (chính lỗi L1 muốn chặn). Cân nhắc: `export MONGO_URI='<uri>'` một lần trong subshell `( export ...; node -e ...mongoTarget...; read -p 'Đúng đích? ' ; pnpm --filter be db:... )` — hoặc gộp vào DEBT-256 (`--confirm-target`). → DEBT-257.
- **[docs] `runbook-ops.md:20,26,153,208,221,227` — URI có mật khẩu nằm trên argv/biến inline ⇒ vào shell history và `ps`.** Vì sao: máy người trực/bastion giữ history lâu hơn sự cố. Cân nhắc: mongodump/mongorestore `--config=<file 0600>` (YAML có `uri:`), mongosh nhập password qua prompt (`mongosh "<uri không password>" -u <user>`), hoặc tối thiểu `HISTCONTROL=ignorespace` + dòng bắt đầu bằng dấu cách. → DEBT-258.
- **[docs] `runbook-ops.md:153` — lệnh §3c đặt `NODE_ENV=development`.** Guard production của seed chỉ dựa vào `NODE_ENV`, nên trỏ `MONGO_URI` prod kèm `NODE_ENV=development` là vượt guard. Ghi rõ "CẤM dùng lệnh này với URI production — đó là vượt DEBT-164; production dùng §3d" (và dùng `NODE_ENV=test` cho thống nhất với diễn tập). → DEBT-259.
- **[docs] `runbook-ops.md:176-182` (§3d break-glass) — ghi lên DB prod mà không in đích/không kiểm `u`.** Thêm `print(db.getName())` và `if (!u) throw 'không thấy user'` trước 2 update; kiểm `matchedCount === 1` cho cả update `users`. Rẻ, giảm sai sót khi làm tay dưới áp lực. → DEBT-260.

## 💭 Nit

- `runbook-ops.md:123` — `?action=SESSION_REVOKED|TOKEN_REVOKED|...` là ký hiệu "một trong", nhưng API so khớp chính xác (`AuditQueryDto.action` enum) ⇒ người trực dán nguyên sẽ nhận 400/rỗng và có thể kết luận sai. Viết "gọi riêng từng `action=`".
- `be/test/runbook-drill.int-spec.ts:407-408` — thiếu dòng trống trước `it('§4(i)…`. Spec §3 break-glass lọc `{ email }` trong khi runbook lọc `{ _id: u._id }` — nên dùng cùng filter để "replay nguyên văn".
- `mongoTarget` đặt ở `sync-indexes.ts` nhưng `seed.ts` import từ module CLI đó; vị trí tự nhiên hơn là cạnh `scrubUriCredentials` (`common/logger/error-log.ts`). Không bắt buộc.

## ✂️ Ponytail

Lean already. Ship.
(Code mới 12 dòng + 1 file spec dùng lại harness `full-app`/`oauth-fixtures`, không helper mới; runbook trỏ chéo `runbook-deploy` thay vì chép lại. Không có gì đáng cắt.)

---

# Lượt 2 — 2026-10-20 (sau backend-dev retry 1)

## Kết luận: REJECT

2 🔴, cả hai sửa nhỏ: (1) [BE] `mongoTarget` vẫn lộ **user + tiền tố số của mật khẩu** khi mật khẩu bắt đầu bằng 1–5 chữ số rồi tới `?`/`#` chưa encode (biến thể của 🔴1 lượt 1 mà allowlist chưa phủ); (2) [docs/ops] DEBT-262 nâng lên 🔴: §4b bước 4 bắt làm checklist 4d qua admin API khi app đã scale 0 và chưa trỏ `<db_mới>` — runbook không làm theo được trong sự cố, và cách "làm cho được" (gọi API trên app còn chạy) ghi thay đổi bảo mật vào **DB cũ** rồi mất khi chuyển. Sửa chỉ là đổi thứ tự/văn bản. Chuyển **backend-dev** (retry 2).

## Tổng quan

Fix lượt 1 đúng hướng và làm kỹ: allowlist host/DB fail-closed, test RED trước, mutation có bằng chứng; §4c/§3d giờ tự ràng buộc DB (`d = db.getSiblingDB`, in `DB:`, throw khi DB không tồn tại, `matchedCount === 1`), rất tốt cho thao tác tay dưới áp lực. DEBT-259/260 + nit `action=` gộp gọn, spec §3 dùng cùng filter `_id` như runbook. Không hồi quy phần đạt lượt 1.

Đã chạy: `pnpm -C be test` 394/394 (32 suites); `pnpm -C be test:int -- runbook-drill` 4/4; `tsc --noEmit` sạch. Probe `mongoTarget` bằng bản sao nguyên văn logic (scratchpad, `node`). Không chạy lệnh runbook lên DB nào.

## 🔴 Blocker

- [ ] **[BE] `be/src/database/mongo/sync-indexes.ts:25-28` — mật khẩu dạng `<1–5 chữ số>[?#]…` chưa encode vẫn lộ user + tiền tố mật khẩu.**
  Đo (logic nguyên văn):
  ```
  mongodb://u:12345?x@h/db          => target: u:12345/test (default)
  mongodb://admin:2024?Secret@h/sso => target: admin:2024/test (default)
  mongodb://u:1234#@h/db            => target: u:1234/test (default)   (lộ TOÀN BỘ mật khẩu "1234")
  mongodb://u:12345/?x@h/db         => target: u:12345/test (default)
  mongodb://h:1,u:123?x@h2/db       => target: h:1,u:123/test (default)
  ```
  Vì sao: nhánh userinfo `[^/?#]*@` bị `?`/`#` chặn ⇒ `user:12345` khớp đúng ngữ pháp `HOST` (`host:port`, port ≤ 5 chữ số); phần sau dừng ở `?`/`#` nên `m[2]` rỗng và `DB_NAME('')` qua. Allowlist chỉ kiểm phần đã match, không kiểm phần còn lại của URI vẫn chứa `@` (dấu hiệu userinfo chưa được bóc). Kết quả in trước khi kết nối và runbook §3c dặn ghi vào biên bản — cùng invariant F5 của lượt 1. Biến thể `/` an toàn (phần sau rơi vào `m[2]` chứa `@` ⇒ bị `DB_NAME` chặn).
  Đề xuất (1 điều kiện, fail-closed): còn `@` sau đoạn đã match ⇒ userinfo chưa bóc được ⇒ không in gì.
  ```ts
  if (!m || uri.slice(m[0].length).includes('@') || !HOST_LIST.test(m[1]) || !DB_NAME.test(m[2] ?? '')) {
  ```
  Đã thử trên probe: 7 dạng lộ ở trên ⇒ `(unparseable MONGO_URI)`; 4 dạng hợp lệ trong spec (`%40` encode, `+srv` user không password, IPv6 `%3A`, `/?directConnection`) giữ nguyên. Thêm các URI trên vào `it.each` (assert không chứa `u:`/`admin`/`2024`/`1234`). Đánh đổi: URI hợp lệ có `@` thô trong query (hiếm) cũng ra `unparseable` — chấp nhận được vì fail-closed.

- [ ] **[docs/ops] `runbook-ops.md:230,237-241` (§4b) — DEBT-262: bước 4 chạy checklist 4d qua admin API giữa "bước 1 scale app về 0" và "bước 6 trỏ app sang `<db_mới>`".**
  Vì sao là 🔴: (a) làm nguyên văn thì không có API để gọi ⇒ người trực phải tự ứng biến lúc sự cố; (b) ứng biến tự nhiên nhất — bật lại app (vẫn trỏ DB cũ) hoặc chưa scale hết — khiến mọi `PATCH .../clients {"disabled":true}`, gỡ role, lock, xoá consent, xoay secret ghi vào **DB cũ**; bước 6 chuyển sang `<db_mới>` ⇒ các thay đổi đó biến mất **im lặng**, client/role đã thu hồi sống lại — đúng bất biến (ii) mà 4d tồn tại để bảo vệ, và không có tín hiệu nào báo sai (API trả 200). Đây là lỗi thực thi của runbook, sửa chỉ là đổi thứ tự/văn bản ⇒ theo tiêu chí giao, coi là 🔴 sửa trong run này.
  Đề xuất (chỉ văn bản):
  - Bước 4: chỉ **4c** (mongosh qua `d`, app vẫn tắt).
  - Bước 6: trỏ app sang `<db_mới>` nhưng **chưa mở traffic người dùng** (vd. ingress/route công khai đóng, chỉ người trực gọi admin API; nếu hạ tầng không cho, ghi rõ khoảng hở và làm 4d ngay lập tức, ưu tiên disable client/gỡ role/lock trước).
  - Bước 7 (mới): **4d** qua admin API trên app đã trỏ `<db_mới>`; xác minh từng mục bằng `GET` tương ứng (vd. `GET /admin/clients/<id>` ⇒ `disabled:true`), rồi mới mở traffic + theo dõi alert.
  - 4d thêm 1 dòng: "CHỈ chạy sau khi app trỏ `<db_mới>` — gọi trên app còn trỏ DB cũ ⇒ thay đổi mất khi chuyển".
  Đóng DEBT-262 khi sửa.

## Security invariants / trust boundaries đã kiểm (lượt 2)

- **Exposure (`mongoTarget`)** — probe biến thể yêu cầu: user không password (`svc@h`) ✓; password rỗng (`u:@h`, `:pw@h`) ✓; `%` encode lỗi (`p%zz`, `p%`) ✓ (userinfo vẫn bóc được, host cấm `%`); `authSource`/`authMechanism` query ✓ không in; DB dài 300 ký tự ✓ (không lộ gì, chỉ dài); unicode DB (`дб`) ✓ in nguyên — hợp lệ; unicode user/pass ✓; `@` thô trong password (`p@ss`) ✓ (userinfo tham lam tới `@` cuối); `#frag` ✓; scheme hoa ✓. **Hở**: password `<digits>[?#]` ⇒ 🔴1 lượt 2.
- **Đích ghi (state)** — rà mọi lệnh ghi trong `runbook-ops.md`: §3d `updateOne` ×2 và §4c `updateMany` ×2 đều qua `d` tường minh + in `DB:` + guard (`!u`, `matchedCount`, DB tồn tại) ✓. §2 dùng `db` trần chỉ cho `find`/`aggregate`/`findOne`/`countDocuments` (chỉ-đọc, đích = DB prod là đúng) ✓. CLI ghi (`db:seed`, `db:sync-indexes`) có kiểm khô §0 + `target:` ✓ (còn DEBT-256/257). `runbook-deploy.md` §2a backfill `db` trần ⇒ DEBT-261 💭, ngoài phạm vi, đồng ý mức 💭 (idempotent, đích cố ý là prod).
- **§4c guard**: `listDatabases` chặn DB gõ sai ⇒ hết `0` giả; in `tổng RT` để đối chiếu dump.log ✓.
- **Thứ tự sự cố (§4b)** ⇒ 🔴2 lượt 2.

## 🟡 Nên sửa

Không có mục mới (giữ DEBT-254/256/257/258 như lượt 1).

## 💭 Nit

- `runbook-ops.md:26` — kiểm khô dùng `./dist/...` ⇒ cần `pnpm --filter be build` trước; §3c có, §4b bước 5 không nhắc. Thêm "(sau `pnpm --filter be build`)" ở §0 cho đủ.

## ✂️ Ponytail

Lean already. Ship. (Fix đề xuất là 1 điều kiện trong `if` sẵn có; không thêm helper.)

---

# Lượt 3 — 2026-10-21 (sau backend-dev retry 2)

## Kết luận: PASS

Cả 2 🔴 lượt 2 đã đóng, không hồi quy. Chuyển **tester** nghiệm thu.

## Tổng quan

Sửa đúng phạm vi đề xuất, không thêm gì thừa: 1 điều kiện trong `if` sẵn có, 6 URI hồi quy, và 1 property test có seed cố định (tái lập được, không flaky). Test RED trước (7/19) và mutation bỏ điều kiện ⇒ 7 đỏ cho thấy test thật sự khoá hành vi. Runbook §4b giờ là trình tự làm được nguyên văn.

Đã chạy: `pnpm -C be test` 401/401 (32 suites); `pnpm -C be test:int -- runbook-drill` 4/4 (đã bật Docker Desktop + `docker start vg-test-mongo vg-test-redis`). Probe `mongoTarget` bằng thân hàm trích nguyên văn từ `sync-indexes.ts`. Không chạy lệnh runbook lên DB nào, không E2E.

## 🔴 Blocker

Không có.

- [x] Lượt 2 🔴1 `sync-indexes.ts:29-38`: `uri.slice(m[0].length).includes('@')` ⇒ fail-closed. Lập luận đóng lớp lỗi (không chỉ vá các ví dụ): một URI có credential bắt buộc chứa `@`. Nếu nhánh userinfo (tham lam) đã ăn hết `@` đứng trước `/?#` đầu tiên thì `m[1]` nằm sau `@` cuối đó, còn mọi `@` phía sau hoặc rơi vào `m[2]` (bị `DB_NAME` chặn) hoặc nằm sau đoạn match (bị điều kiện mới chặn). Nếu nhánh userinfo không chạy thì `@` chắc chắn nằm sau đoạn match ⇒ chặn. Vậy không còn đường nào để user/password rơi vào `m[1]`/`m[2]`.
  Tự thử thêm (đều sạch): `u:123,456?x@h` và `u:1,h2:2#@h` (password giả danh danh sách host) ⇒ unparseable; `u:1.2.3?x@`, `u:[::1]?@`, `[u:1]?@` (giả IPv6) ⇒ unparseable; `u:12;34?@` ⇒ unparseable; password có dấu cách, `\n`, `\` ⇒ `h/db`; `%2F` encode ⇒ `h/db`; `authMechanismProperties=AWS_SESSION_TOKEN:…` trong query ⇒ không in; unix socket `%2Ftmp…` ⇒ unparseable (chấp nhận được); scheme hoa ⇒ in; khoảng trắng đầu ⇒ unparseable. Fuzz 200 000 URI (password 1–10 ký tự từ `0-9/?#:@,.[]%-_abXY`, có/không port, db, `+srv`, query) ⇒ **0 lần lộ user hoặc password**.
- [x] Lượt 2 🔴2 `runbook-ops.md` §4b: đọc như người trực, làm nguyên văn từng bước:
  1 scale 0 → 2 kiểm `<db_mới>` chưa tồn tại + `mongorestore --nsFrom/--nsTo` (chỉ ghi `<db_mới>`) → 3 so số liệu qua `d` (chỉ đọc) → 4 chỉ 4c qua `d` + in `DB:` + throw nếu DB không tồn tại, app vẫn tắt → 5 kiểm khô §0 rồi `db:sync-indexes` với URI `<db_mới>` → 6 trỏ app sang `<db_mới>`, chưa mở traffic, có hướng dẫn khi hạ tầng không chặn được → 7 checklist 4d qua admin API trên app đã trỏ `<db_mới>`, xác minh bằng `GET` → mở traffic. 4d có cảnh báo "CHỈ chạy sau bước 6–7".
  **Không còn bước ghi nào có thể rơi vào DB cũ**: mọi lệnh ghi mongosh qua `d`; CLI ghi có kiểm khô + `target:`; admin API chỉ được gọi sau khi trỏ app. Câu Rollback ("RT đã thu hồi trên DB mới không ảnh hưởng DB cũ") giờ đúng. Cách xác minh bằng `GET` khớp mapper (dev đã đối chiếu, tôi đối chiếu tên trường trong runbook với nội dung lượt 2: `disabled`, `status:"revoked"`, `roles`/`membershipStatus`/`locked`).

## Security invariants / trust boundaries đã kiểm (lượt 3)

- **Exposure**: `mongoTarget` như trên, đóng theo lập luận cấu trúc + fuzz. Dòng `target:` đưa vào biên bản giờ an toàn.
- **Đích ghi (state)**: §4b 1–7 + 4c/4d như trên ✓. §3d/§4c giữ guard lượt 2 ✓ (không đổi).
- **Thứ tự/khả thi**: §4b làm được nguyên văn, không cần ứng biến ✓. §0 đã nhắc build trước kiểm khô ✓ (nit lượt 2 đã xử lý).
- **Hồi quy**: phần lượt 1–2 đã đạt không đổi; unit 401/401, drill 4/4.

## 🟡 Nên sửa

Không có.

## 💭 Nit (→ DEBT-263)

- `runbook-ops.md` §4b bước 6–7: lấy `ADMIN_AT` sau khi trỏ `<db_mới>` cần một admin **có trong bản backup** với vai trò đúng. Admin được tạo/đổi mật khẩu/cấp role sau điểm backup sẽ không đăng nhập được (hoặc phải dùng mật khẩu cũ) đúng lúc cần làm 4d. Nên thêm 1 dòng: "không đăng nhập được admin trên `<db_mới>` ⇒ §3 (break-glass qua `d = db.getSiblingDB('<db_mới>')`)". → DEBT-263.
- `runbook-ops.md` §0: "trong `be/` (sau `pnpm --filter be build` ...)" — `--filter` là cú pháp chạy từ gốc repo; viết "chạy `pnpm --filter be build` ở gốc repo, rồi `cd be`" cho khỏi đoán. Không ghi debt.

## ✂️ Ponytail

Lean already. Ship. (Điều kiện mới 1 dòng; property test ~20 dòng là self-check tối thiểu cho invariant bảo mật, không đề xuất cắt.)
