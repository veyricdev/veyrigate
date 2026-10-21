# Tasks — run 40 — B7.5 runbook + diễn tập (M7)

> Plan §B7 B7.5: "Runbook: key nghi bị lộ (rotate khẩn cấp), `TOKEN_REUSE_DETECTED` tăng đột biến, quên/khôi phục admin, backup/restore Mongo" — nghiệm thu "Diễn tập runbook 1 lần, ghi kết quả". Nền: `runbook-deploy.md` (§1–6), admin API keys rotate (run 29), metrics + alert (run 37/38: `SsoTokenReuseDetected`, emergency rotation), seed `db:seed` (run 30–31, khôi phục super_admin), spec §8 (rotation khẩn cấp gỡ key cũ khỏi JWKS ngay). Không có KMS (B7.3 chờ Q5) ⇒ runbook ghi rõ phần dev `LocalKeyProvider` vs production.
>
> Thứ tự: Task 1 → 2. Diễn tập CHỈ trên hạ tầng test (`vg-test-*` hoặc DB/Redis E2E), KHÔNG trên DB dev `sso-idp` và KHÔNG drop/FLUSH `aegate-*`. Không compose up.

### [x] Task 1 [ops/docs]: Viết runbook vận hành
- `docs/agile/sso-idp/runbook-ops.md` (hoặc mở rộng runbook hiện có — tech-lead chốt), mỗi kịch bản: dấu hiệu nhận biết (alert/metric/audit), quyết định, các bước lệnh cụ thể (API/CLI có thật trong repo), xác minh sau, rollback, liên lạc:
  1. Key nghi bị lộ ⇒ `POST /admin/keys/rotate {mode:"emergency"}` (step-up), hậu quả (mọi AT cũ 401, refresh vẫn chạy), kiểm JWKS, kiểm PEM mồ côi (§6), báo RP cache JWKS (DEBT-157).
  2. `TOKEN_REUSE_DETECTED` tăng đột biến ⇒ điều tra audit (`GET /admin/audit?action=…`), revoke family/session theo user/client, disable client nếu cần.
  3. Quên/mất admin ⇒ khôi phục super_admin bằng `db:seed` (đường khôi phục khi 0 super_admin — DEBT-142), unlock, reset mật khẩu.
  4. Backup/restore Mongo (mongodump/mongorestore — công cụ có trong image Mongo?), Redis là trạng thái phiên tạm (mất ⇒ người dùng đăng nhập lại; không backup), thứ tự restore + `db:sync-indexes`.
- **Acceptance**: mọi lệnh/endpoint trong runbook tồn tại thật (grep/route list); không chứa secret.

### [x] Task 2 [ops/test]: Diễn tập + ghi kết quả
- Diễn tập 4 kịch bản trên hạ tầng test (tự động hoá được thì viết script/int-test; phần thủ công ghi lệnh + output rút gọn), ghi `runs/40-B7.5/drill-report.md`: thời gian, bước lệch runbook, sửa runbook.
- **Acceptance**: 4/4 kịch bản diễn tập có bằng chứng; runbook đã sửa theo phát hiện.
- [x] **2a [BE]** (backend-dev, run 40): `be/test/runbook-drill.int-spec.ts` — §1–§3 + §4(i) (thu hồi toàn bộ RT sau restore, không bắn reuse) tự động, 4/4 xanh.
- [x] **2b** (tester): diễn tập thủ công §4 trên `vg-test-mongo` + `drill-report.md`.

## Câu hỏi cho tech-lead
- Q-40.1: Diễn tập backup/restore Mongo bằng gì (docker exec mongodump trong vg-test-mongo? DB tạm?) mà không đụng dữ liệu dev.
- Q-40.2: Diễn tập tự động (int-spec) hay thủ công có ghi chép; ai làm (backend-dev viết, tester diễn tập?).
- → Đã trả lời ở F6 dưới.

---

## Fold tech-lead (2026-10-20) — ƯU TIÊN hơn text cũ ở trên

Đối chiếu code thật tại `d8da71c` (CodeGraph + `docker exec … which`). Text cũ sai/thiếu ở các điểm dưới; dev làm theo mục này.

### F0. Vị trí & phân công
- Runbook mới **`docs/agile/sso-idp/runbook-ops.md`** (file bền, tách khỏi `runbook-deploy.md`; trỏ chéo tới deploy §1 `db:sync-indexes`, §3 Redis, §6 PEM mồ côi — không chép lại).
- **backend-dev**: Task 1 + Task 2a (int-spec diễn tập kịch bản 1–3) + F5 (CLI in DB đích). **tester**: Task 2b (chạy spec, diễn tập thủ công kịch bản 4, viết `drill-report.md`; được sửa *văn bản* `runbook-ops.md` theo lệch phát hiện và ghi lại trong report). Senior review như thường lệ.
- Mỗi kịch bản có ô **"Production vs dev"**: không KMS (Q5/B7.3) ⇒ phần key ghi rõ chỉ `LocalKeyProvider` (dev); bước prod ghi "TBD B7.3", không bịa lệnh.

### F1. Kịch bản 1 — key nghi lộ (sửa/thêm)
- Điều kiện gọi thật: `POST /admin/keys/rotate` body `{"mode":"emergency"}` cần **super_admin** + scope `admin.write` + **step-up `RequireRecentAuth(5)`** (auth_time ≤ 5 phút ⇒ đăng nhập lại fe-admin với `prompt=login`/`max_age` trước khi gọi). Response `{newKid, oldKid, mode}`.
- **Không idempotent (DEBT-158)**: 5xx/timeout ⇒ KHÔNG gọi lại mù; kiểm `GET /admin/keys` (kid active đổi chưa) + `GET /admin/audit?action=SIGNING_KEY_ROTATED` (event admin có `tenantId` nên thấy được) rồi mới quyết định.
- Hậu quả ghi đúng: oldKid + mọi key retiring rời JWKS ngay ⇒ AT/ID token cũ fail verify; **session Redis và refresh token KHÔNG bị thu hồi** ⇒ refresh vẫn phát AT mới ký newKid. Điểm quyết định: nghi lộ kèm xâm nhập host ⇒ người trực cân nhắc thu hồi phiên (công cụ ở F2) — không mặc định.
- Xác minh: `GET /jwks.json` chỉ còn newKid; alert `SsoEmergencyKeyRotation`; deploy §6 (PEM mồ côi, chỉ xoá đúng oldKid). Báo RP xoá cache JWKS (DEBT-157). `LocalKeyProvider` đọc `keys.json` mỗi lần ⇒ tiến trình khác thấy ngay, nhưng chỉ hỗ trợ 1 node dev (DEBT-159).
- Rollback: KHÔNG có (key cũ đã xoá, không đưa lại JWKS) — ghi rõ.

### F2. Kịch bản 2 — `TOKEN_REUSE_DETECTED` tăng đột biến (SỬA SAI)
- **`GET /admin/audit?action=TOKEN_REUSE_DETECTED` trả RỖNG**: event ghi ở `RefreshTokenService` không có `tenantId` (DEBT-140), `listForTenant` lọc chặt tenant. Runbook dùng: (a) metric `sso_audit_events_total{action="TOKEN_REUSE_DETECTED"}` / alert `SsoTokenReuseDetected` (ngưỡng `>0` trong 5m — nêu cách phân biệt lẻ tẻ (RP retry/bug) vs đột biến (tấn công), theo `clientId`); (b) truy vấn **chỉ-đọc** mongosh `db.auditlogs.find({action:'TOKEN_REUSE_DETECTED'}).sort({timestamp:-1})` (metadata `familyId`, `count`; `clientId`) ⇒ `db.refreshtokens.findOne({familyId}, {userId:1, clientId:1})` ra user. Dev xác nhận tên collection/field bằng code, không đoán.
- Family bị reuse **đã tự revoke**. Hành động thêm (endpoint có thật): `POST /admin/users/:id/sessions/revoke`, `POST /admin/users/:id/families/:familyId/revoke`, `POST /admin/users/:id/lock`; client nghi lộ ⇒ `PATCH /admin/clients/:clientId {"disabled":true}` (revoke toàn bộ RT theo `clientId`, DEBT-125) và/hoặc xoay secret `POST /admin/clients/:clientId/secrets` + `DELETE …/secrets/:version`. Không có cách revoke mọi family của client mà KHÔNG disable ⇒ DEBT-251.
- Exposure: runbook/report không chép `tokenHash`, IP/email thật; chỉ placeholder.

### F3. Kịch bản 3 — quên/mất admin (SỬA SAI)
- `pnpm --filter be db:seed` **từ chối khi `NODE_ENV` ≠ development|test** (`assertNotProduction`, DEBT-164) ⇒ production **chưa có công cụ khôi phục được hỗ trợ**. Runbook ghi thẳng: dev/test dùng `db:seed`; production = **break-glass** mongosh (2 người, biên bản ngoài hệ thống vì không có audit event) tương đương bước 3 của seed: `usertenants` `{userId, tenantId:'default-tenant'}` `$set {status:'active'}` + `$addToSet {roles:'super_admin'}` (dev xác nhận tên collection/field). DEBT-252.
- `db:seed` với user ĐÃ tồn tại: **không đổi mật khẩu, không gỡ khoá** (`$setOnInsert`), chỉ kích hoạt membership + thêm `super_admin`. Seed còn chặn khi resource `admin` trỏ identifier khác / client lạ tham chiếu `admin` (guard bước 0) — runbook liệt kê thông báo lỗi và cách xử.
- Mật khẩu: KHÔNG có endpoint admin reset ⇒ tự phục vụ `/forgot` → email → `/reset`. Khoá: `lockedUntil` tự hết hạn, hoặc `POST /admin/users/:id/unlock` bởi admin khác; không còn admin nào ⇒ break-glass `$unset lockedUntil`, `failedLoginCount:0`.
- `ADMIN_SEED_EMAIL/PASSWORD` chỉ nêu tên biến; seed in secret `fe-admin` một lần ra stdout khi tạo mới ⇒ nhắc không dán vào ticket/log.

### F4. Kịch bản 4 — backup/restore Mongo (bổ sung bắt buộc)
- Công cụ: image `mongo:7` đã có `mongodump`/`mongorestore`/`mongosh` (database-tools 100.18.0, đã kiểm trong `vg-test-mongo`) ⇒ **không cài gì**, chạy qua `docker exec`.
- Runbook prod: `mongodump --uri=<URI> --db=<db> --archive=<file> --gzip`; restore vào **DB mới** bằng `--nsFrom/--nsTo`, rồi trỏ app sang; không `--drop` lên DB đang chạy; dừng ghi (scale app 0) khi restore; sau restore chạy deploy §1 `db:sync-indexes` + 2c. Backup chứa hash mật khẩu/secret/RT + PII ⇒ mã hoá khi lưu, giới hạn truy cập, retention. Lịch/RPO/RTO/PITR chưa quyết (Q5) ⇒ DEBT-253.
- **Bất biến bảo mật sau restore về thời điểm cũ** (bắt buộc trong runbook): (i) RT đã rotate/revoke sau điểm backup **sống lại** (kể cả family đã reuse-revoke) ⇒ bước bắt buộc thu hồi toàn bộ RT còn hiệu lực (mongosh `updateMany` trên `refreshtokens` — dev xác định đúng field làm RT vô hiệu theo `RefreshTokenService`, và **ghi rõ có bắn `TOKEN_REUSE_DETECTED` hàng loạt khi client dùng lại không**; nếu có, runbook báo trước để không nhầm sự cố); (ii) client disable, secret revoke, gỡ role, consent revoke, khoá user sau điểm backup bị đảo ⇒ checklist áp lại từ log ứng dụng/ticket (audit trong DB cũng bị lùi). Redis giữ nguyên (không backup; mất Redis ⇒ đăng nhập lại).
- Mỗi bước có lệnh xác minh + kết quả kỳ vọng (không câu chung "kiểm tra kỹ").

### F5. An toàn CLI (code nhỏ, bắt buộc)
- `db:sync-indexes` (và `db:seed` nếu chưa) in **`target: <host>/<db>`** (credential scrub — tái dùng tiện ích scrub URI run 38) TRƯỚC khi sync/ghi. Lý do: script nạp `be/.env` (`MONGO_URI` dev `sso-idp`) qua `--env-file-if-exists`; biến env truyền vào thắng, nhưng gõ sai tên biến ⇒ âm thầm rơi về DB dev và `syncIndexes` **drop** index. Unit test dòng in (không lộ password).

### F6. Diễn tập (trả lời Q-40.1 / Q-40.2)
- **Q-40.2 — lai**: kịch bản 1–3 tự động bằng **1 file** `be/test/runbook-drill.int-spec.ts` (harness có sẵn: DB tạm `vg-int-runbook-drill-<ts>` trên `vg-test-mongo@27117`, `vg-test-redis@6479`, `KEY_LOCAL_DIR` thư mục tạm; tái dùng helper token/step-up như `admin-keys.int-spec.ts`, không viết helper mới nếu đã có). Mỗi `it` đi đúng thứ tự bước runbook và assert các khẳng định của runbook: (1) emergency rotate ⇒ AT cũ 401, refresh vẫn ra AT mới verify được, JWKS chỉ newKid, audit thấy qua `/admin/audit`; thiếu step-up ⇒ bị từ chối; (2) replay RT ⇒ family revoked, `/admin/audit?action=TOKEN_REUSE_DETECTED` **rỗng** (khoá hành vi DEBT-140 để runbook không lỗi thời âm thầm), DB có event, `sessions/revoke` và `disabled:true` làm RT còn lại hết hiệu lực; (3) 0 super_admin ⇒ `seedBootstrap` (NODE_ENV=test) khôi phục role; mật khẩu cũ vẫn đăng nhập được, `lockedUntil` vẫn còn; `NODE_ENV=production` ném lỗi trước khi ghi. Không lặp test cũ ngoài phần cần nối chuỗi.
- **Q-40.1 — kịch bản 4 thủ công (tester)**, CHỈ `vg-test-mongo`, tên DB khớp `^vg-drill-(src|dst)-[0-9]+$`:
  1. Tạo nguồn: `MONGO_URI='mongodb://localhost:27117/vg-drill-src-<ts>?directConnection=true'` + `ADMIN_SEED_EMAIL/PASSWORD` tạm (không ghi vào report) `pnpm --filter be db:seed`; xác nhận dòng `target:` (F5) là `vg-drill-src-<ts>` trước khi tiếp. mongosh chèn 1 doc RT giả (hash giả) vào nguồn.
  2. `docker exec vg-test-mongo mongodump --db=vg-drill-src-<ts> --archive=/tmp/vg-drill-<ts>.gz --gzip`.
  3. Mô phỏng thay đổi sau backup: set `revokedAt` cho RT giả ở nguồn.
  4. `docker exec vg-test-mongo mongorestore --archive=/tmp/vg-drill-<ts>.gz --gzip --nsFrom='vg-drill-src-<ts>.*' --nsTo='vg-drill-dst-<ts>.*'` (**cấm `--drop`**).
  5. So `countDocuments` từng collection + `getIndexes()` src vs dst; RT giả ở dst **chưa revoke** (chứng minh F4(i)); áp bước thu hồi RT của runbook trên dst ⇒ hết hiệu lực.
  6. `MONGO_URI='…/vg-drill-dst-<ts>?directConnection=true' pnpm --filter be db:sync-indexes` ⇒ `target:` đúng dst, exit 0, không drop index nào.
  7. Dọn: `dropDatabase()` ĐÚNG 2 DB `vg-drill-src/dst-<ts>` (kiểm regex trước), `docker exec vg-test-mongo rm /tmp/vg-drill-<ts>.gz`.
  - **Cấm**: `docker exec aegate-mongo`, mọi URI port 27017, DB `sso-idp`/`sso-idp-e2e`, `--drop`, FLUSH Redis, compose up, docker run/pull, cài công cụ toàn cục.
- `drill-report.md`: mỗi kịch bản: thời gian bắt đầu/kết thúc, lệnh (che secret), output rút gọn (số đếm/tên index/status code — không nội dung doc), lệch runbook + đã sửa gì. 4/4 có bằng chứng.

### F7. Acceptance bổ sung (đo được)
- Grep dương: mọi route trong `runbook-ops.md` có trong controller (`admin-keys/users/clients/audit`, `/jwks.json`, `/forgot`, `/reset`); mọi script `pnpm` có trong `be/package.json`; metric/alert có trong `ops/prometheus/alerts.yml`.
- Grep âm: `runbook-ops.md` + `drill-report.md` không chứa `-----BEGIN`, `password=`, `mongodb://<user>:<pass>@`, giá trị `ADMIN_SEED_PASSWORD` thật.
- `pnpm -C be test` + `test:int` xanh (gồm `runbook-drill.int-spec.ts`); sau diễn tập `vg-test-mongo` không còn DB `vg-drill-*`.

## Retry 1 (senior REJECT 2026-10-20)
- [x] 🔴1 [BE] `mongoTarget` allowlist fail-closed: host list `host[:port]` (nhiều host, IPv6) + tên DB theo ký tự Mongo cho phép (cấm `@`/`#`); không khớp ⇒ `target: (unparseable MONGO_URI)`. Unit +7.
- [x] 🔴2 [docs] runbook-ops §4c (và §4b-4): mọi lệnh ghi qua `const d = db.getSiblingDB('<db_mới>')` + in `DB:` + throw nếu DB không tồn tại; rà toàn runbook: §3d cùng lớp ⇒ cũng qua `d`.
- [x] Gộp DEBT-259 (§3c chỉ dev/test, cấm URI prod, `NODE_ENV=test`), DEBT-260 (§3d in DB, `if (!u) throw`, `matchedCount === 1` cả 2 update), nit `action=` từng giá trị; spec §3 break-glass dùng cùng filter `_id` như runbook + assert `matchedCount`.
