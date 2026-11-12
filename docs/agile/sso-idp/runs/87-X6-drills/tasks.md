# Run 87 — X6 diễn tập + sweep (M8, lane BE + ops + QA)

Nguồn: `plan.md` §X6 ("diễn tập backup/restore + rotate khẩn cấp"), backlog DEBT-252/253 + các 🟡/💭 nhỏ còn mở. Analyst bỏ qua. Tech-lead fold trên code sau `8855df0`.

Ràng buộc hạ tầng (người dùng, 2026-11-12): KHÔNG tạo container mới (trừ Vault thử `vg-b73-vault` khi cần, xoá sau); diễn tập chạy trên `veyrigate-mongo`/`veyrigate-redis` bằng DB riêng (vd. `vg-drill-*`), không đụng `sso-idp` / `sso-idp-e2e`.

## Task

- [x] **T1 [ops/docs] DEBT-253 (phần code ✅ backend-dev 2026-11-12: `ops/backup/*`, harness `be/scripts/drills/*`, alert, runbook-ops §4) — ✅ tester 2026-11-12 retry 1: diễn tập 36/36, phần kỹ thuật 12,8 s, `evidence/backup-restore-20261112T071348Z.json`, `drill-report.md` (lượt đầu FAIL: DEBT-620/621, backend-dev đã sửa)** — chính sách backup + diễn tập backup/restore**: chốt lịch, RPO/RTO, PITR, mã hoá file backup, quyền, retention, nơi lưu (D87.x); runbook-ops §backup đầy đủ lệnh; diễn tập thật: seed DB `vg-drill-src` → `mongodump --archive --gzip` (mã hoá theo chính sách) → `mongorestore` sang `vg-drill-restore` → đối chiếu số document/index/hash từng collection + app boot đọc được (login, JWKS) → đo thời gian; ghi biên bản vào `runs/87-X6-drills/drill-report.md`; dọn DB diễn tập.
- [x] **T2 [BE] DEBT-252 — khôi phục super_admin ở production**: CLI riêng (không dùng `db:seed`), audit `ADMIN_RECOVERED`, yêu cầu xác nhận 2 người (cách làm D87.x), chạy được trong image production; runbook-ops mục break-glass; int spec.
- [x] **T3 [ops/QA] diễn tập rotate khẩn cấp** (✅ tester 2026-11-12: Local 23/23 + lượt tay §1 1,98 s, Vault 30/30 (orchestrator); runbook-ops §0/§1 sửa; `drill-report.md`): Local (keys dir tạm) và Vault (container thử): rotate emergency → JWKS chỉ còn key mới, token cũ bị từ chối ở `/userinfo` + `/introspect`, RP remote JWKS refetch; đo thời gian; theo runbook-ops §1; ghi vào `drill-report.md`; sửa runbook nếu bước nào sai.
- [x] **T4 [BE/FE] DEBT-589** (AC5 §15 chạy trong diễn tập T1) — migration `$unset failedLoginCount/lockTransitionNonce` (idempotent, dry-run), bỏ `failedLoginCount` khỏi `admin.views.ts` + OpenAPI + fe-admin.
- [x] **T5 [ops/E2E] DEBT-590 + DEBT-608** (E2E 2 lượt — tester) — pin image test/dev trong `ci.yml` + `docker-compose.yml` theo `@sha256:` (kèm comment tag); `fe-admin-users.spec.ts` không phụ thuộc số dữ liệu tồn đọng (tạo family riêng hoặc lọc), bỏ giới hạn 100 trang.
- [x] **T6 [QA]** (✅ tester 2026-11-12 retry 1: lint/typecheck, be 1018, int 2275, vault 32, E2E 42 ×2, X3 42, fe-admin 1626; checklist D-4/D-5/D-6 ✅, E-252/E-253 ✅, D-16 ❌ P1, 202/149/29/5/19; security-matrix §Run 87) — checklist (dòng backup/restore, rotate khẩn cấp, recovery), security-matrix; gate: lint/typecheck, be unit, int FULL, vault, E2E, X3 42, fe-admin.

## Fold tech-lead (2026-11-12)

Đã kiểm trên `develop` HEAD `8855df0` (CodeGraph sync + đọc đích). Kết luận: **PASS**, lý do xem `review-techlead.md`.

**Vừa một run.** Thứ tự **T4 → T2 → T5 → T1 → T3 → T6**:
- T4 làm trước vì nhỏ và sửa `UserService.adminUnlock`, hàm mà T2 dùng lại (thêm `session`).
- T2 làm trước T1 vì diễn tập T1 dùng CLI recovery trên DB đã restore (bằng chứng thật cho D-6).
- T5 độc lập, rẻ.
- T3 dùng lại harness boot/đăng nhập của T1.

Nếu trễ: **T1, T2, T3 bắt buộc xong** (D-4/D-5/D-6 P1); T4 (💭) và T5 (💭/🟡) được dời sang run 88.

### Phát hiện khi kiểm code

1. **DEBT-589 lệch với code hiện tại.**
   - `admin.views.ts`, `admin.mappers.ts` (`toAdminUser`), `fe-admin/openapi/admin.json` và `fe-admin/src` đều **không** lộ `failedLoginCount`; mapper có chú thích loại trừ field này.
   - Field vẫn được **ghi** `0`:
     - trong `user.service.ts`: `clearFailedLoginsIfUnlocked`, `setPassword`, `adminUnlock`, `updateStatus`;
     - trong `seed.ts`, `seed-dev.ts`, `test/e2e/seed-e2e-admin.ts`.
   - Field còn được **đọc** đúng một chỗ có tác dụng: `admin-users.controller.ts:256` (`before.failedLoginCount > 0` ⇒ ghi audit unlock).
   - Không còn chỗ nào tăng biến đếm (run 85 đã xoá `recordFailedLogin`).
   - ⇒ T4 sửa phạm vi theo D87.17, không đổi FE/OpenAPI.
2. **Production không có đường bootstrap** (DEBT-164 vẫn mở, không có trong checklist).
   - `db:seed` chỉ chạy dev/test, nên production không tạo được resource `admin`, client `fe-admin` hay super_admin đầu tiên.
   - CLI T2 giải phần super_admin: user tự đăng ký + verify, rồi CLI nâng quyền khi chưa có super_admin.
   - Phần client/resource **không** thuộc run này ⇒ checklist thêm **D-16 ❌ P1**, đề xuất làm ở run 88 trước khi ký (D87.20).
3. **`main.ts` nạp `.env` theo cwd**; script `db:*` dùng `--env-file-if-exists=.env`.
   - Nếu chạy BE/CLI diễn tập với cwd `be/`, các biến trong `be/.env` (DB dev, SMTP…) sẽ lọt vào; chỉ biến đã export mới thắng.
   - ⇒ Harness chạy `node <abs>/be/dist/...` với **cwd = thư mục scratch rỗng**, không qua `pnpm db:*` (D87.11).
4. `SuperAdminGuard` (`super-admin-guard.ts`) đã có `runGuarded` (transaction snapshot/majority) và "touch" `$inc superAdminGuard`. CLI T2 dùng đúng cơ chế này, không viết khoá mới.
5. **Digest image.**
   - `be/scripts/docker-smoke.sh` đã pin `mongo:7.0.43@sha256:1f995ad…` và `redis:7.4.10-bookworm@sha256:e9b2e45…` (bản phát hành ≥ 14 ngày). Vault đã pin ở mọi nơi.
   - Local có `axllent/mailpit:v1.21`, RepoDigest `sha256:81370195cd4a0eab9604d17c2617a7525b0486f9365555253b6c5376c6350f1a` (image tạo 2024-12-20).
   - `mongo:7`/`redis:7` ở local được build 2026-11-11/05, tức < 14 ngày ⇒ **không** pin theo bản local (D87.18).
6. **Công cụ có sẵn, không cần tải.**
   - Host: `gpg` 2.4.8 (Git Bash), OpenSSL 3.5.4.
   - `veyrigate-mongo`: mongod 7.0.48, `mongodump` 100.20.1, OpenSSL 3.0.2, **không có** gpg.
   - Không nơi nào có `age`.
   - Oplog của `veyrigate-mongo` có 48 GB nhưng chứa lẫn DB của người khác (`sso-idp-e2e`) ⇒ **không** diễn tập PITR oplog trên container dùng chung (D87.4).
7. **Trạng thái hạ tầng diễn tập.**
   - Redis db 7 và 8 đang trống (`DBSIZE 0`); cổng 4987/4988 trống.
   - `listDatabases` hiện có `sso-idp-e2e` nhưng chưa có `sso-idp`, nên guard "DB đích chưa tồn tại" **không** đủ bảo vệ `sso-idp` ⇒ harness còn ép tên DB khớp `^vg-drill-`.
8. `runbook-ops.md` §0 còn hai câu đã sai từ run 50/53: "Chưa có UI fe-admin (A4–A6 chờ Q3)" và "chưa có KMS (Q5/B7.3)… Mọi bước key cho production = TBD B7.3" ⇒ T3 sửa.
9. `be/test/runbook-drill.int-spec.ts` ca §3 đang khoá đường break-glass mongosh và `failedLoginCount`. T2/T4 phải cập nhật ca này cùng lúc với runbook §3d.

### Quyết định D87.x (người dùng ủy quyền, tiêu chí production) — orchestrator chép vào `plan.md` §12 khi đóng run

**Backup (DEBT-253)**

- **D87.1 Lô**: thứ tự như trên, gói trong một run.
- **D87.2 Cơ chế**
  - Dump logic toàn bộ DB app **mỗi giờ**, phút :17 UTC: `mongodump --archive --gzip --db=<db>`, đọc từ secondary (`readPreference=secondary` trong config).
  - Binary: image `mongo:7.0.43@sha256:1f995ad…` (cùng major với server, đã pin ở smoke) hoặc database-tools 100.x trên host backup.
  - Không dùng `--oplog` vì option này chỉ chạy khi dump cả instance. Hệ quả: snapshot không nhất quán tuyệt đối giữa các collection. Dữ liệu nhỏ nên dump chỉ mất vài giây, và restore đã chịu được độ lệch này (§4c thu hồi mọi RT, §4d áp lại thay đổi bảo mật, `db:sync-indexes`). Runbook phải ghi rõ điều này.
  - Replica set (bắt buộc từ run 79) lo mất node; backup dành cho lỗi logic, thao tác nhầm, mất site.
- **D87.3 RPO/RTO**
  - **RPO ≤ 1 h**, tính bằng khoảng cách giữa hai backup thành công. Alert khi bản thành công cuối cũ hơn 2 h.
  - **RTO ≤ 2 h**, từ quyết định restore tới khi mở lại traffic, gồm cả checklist §4d làm tay.
  - Phần kỹ thuật (giải mã + restore + §4c + `db:sync-indexes` + boot) **≤ 30 phút** với archive ≤ 1 GB.
  - Ngưỡng cho diễn tập (dữ liệu nhỏ): phần kỹ thuật ≤ 10 phút; vượt ⇒ FAIL, phải điều tra.
- **D87.4 PITR: không làm ở bản phát hành này.**
  - PITR tự dựng từ oplog (dump `local.oplog.rs` theo `ts` + `mongorestore --oplogReplay --oplogFile --oplogLimit`) không rename được namespace, nên không restore song song vào DB mới như §4b được.
  - Nó cũng là một cơ chế thứ hai phải diễn tập và trực.
  - Công cụ đúng cho việc này là Percona Backup for MongoDB (cần tải) ⇒ DEBT-610.
  - RPO 1 h chấp nhận được vì §4c/§4d đã bù phần thay đổi bảo mật.
- **D87.5 Mã hoá: `gpg` khoá công khai**
  - Lệnh: `gpg --batch --yes --trust-model always --recipient-file <backup-pub.asc> --cipher-algo AES256 --compress-algo none --encrypt`.
  - Archive đã gzip nên gpg không nén. Toàn vẹn dựa vào MDC/AEAD của gpg cộng `sha256` ghi trong manifest.
  - Host backup **chỉ giữ public key**: lộ host hay storage cũng không đọc được backup.
  - Private key có passphrase, sinh offline. File key ở secret store A (ops lead), passphrase ở secret store B (người thứ hai, security hoặc ops khác) ⇒ **restore cần 2 người**.
  - Xoay key hằng năm; giữ private key cũ tới khi bản cuối cùng mã hoá bằng nó hết retention (35 ngày).
  - Loại `openssl enc` (không có AEAD, mặc định không xác thực), `openssl cms` (giải mã file lớn không chạy theo luồng), `age` (không có sẵn, cần tải).
  - Production cần gói `gnupg` của distro trên host backup. Đây là điều kiện hạ tầng ghi trong runbook, không phải tải trong run này.
- **D87.6 Retention**
  - Bản hằng giờ giữ **48 h** trên host backup (thư mục `0700`, đĩa mã hoá).
  - Bản 00:17 UTC mỗi ngày chép offsite, giữ **35 ngày**. Không có bản tháng.
  - Lý do:
    - restore cũ hơn vài ngày gần như vô ích với IdP (RT, phiên, khoá đã đổi);
    - 35 ngày đủ để phát hiện sự cố muộn trong một chu kỳ tháng;
    - đồng thời giới hạn thời gian PII của user đã xoá còn trong backup.
  - Audit có TTL 180 ngày riêng; lưu audit lâu hơn là việc khác, ngoài phạm vi.
  - Xoá bằng lifecycle rule ở storage offsite; script chỉ prune thư mục local theo đúng mẫu tên.
- **D87.7 Nơi lưu và quyền**
  - Offsite: object storage ở **failure domain khác** production (khác region/tài khoản nhà cung cấp), bật versioning và **object lock** 35 ngày.
  - Credential của job backup chỉ có quyền `put` (không list/get/delete). Credential restore riêng, chỉ đọc, do ops giữ.
  - Mongo: user `backup` (role có sẵn `backup`) cho dump; user `restore` (role `restore`) chỉ tạo khi cần restore.
  - URI/mật khẩu Mongo đi qua `--config=<file 0600>` (YAML `uri:`), **không** đặt trên argv. Script từ chối `MONGO_URI` có `@` trên argv. Đây là phần DEBT-258 cho đường backup/restore.
  - Mỗi lần restore ghi biên bản: ai, khi nào, ticket nào.
- **D87.8 Giám sát**
  - Script backup chỉ ghi `veyrigate_backup_last_success_timestamp_seconds` vào textfile collector (khi có `BACKUP_TEXTFILE_DIR`) sau khi **mọi** bước thành công.
  - Alert `SsoMongoBackupStale`: `time() - veyrigate_backup_last_success_timestamp_seconds > 7200` trong 10 phút, thêm vào `ops/prometheus/alerts.yml` + `ops-rules.spec`.
  - Mỗi lần chạy, script tự kiểm `sha256` và `gpg --list-packets` (không cần private key).
  - Diễn tập restore đầy đủ **mỗi quý** và sau mỗi thay đổi schema lớn, bằng harness D87.11.
- **D87.9 Ngoài Mongo**
  - Redis: không backup (giữ quyết định §4).
  - Signing key Vault: ngoài phạm vi (DEBT-391 vẫn mở). Mất storage Vault ⇒ tạo transit key mới và xử lý như emergency (mọi token cũ chết). Runbook thêm 1 dòng.
- **D87.10 Script trong repo (dùng chung cho production và diễn tập)**
  - `ops/backup/mongo-backup.sh <db> <out-dir>`
    - Env: `MONGO_BACKUP_CONFIG` hoặc `MONGO_URI` không có credential, `BACKUP_PUBKEY`, `MONGODUMP` (mặc định `mongodump`; diễn tập dùng `docker exec veyrigate-mongo mongodump`), `BACKUP_TEXTFILE_DIR`.
    - Pipe dump → gpg, ghi ra `<name>.partial`; không có file rõ nào chạm đĩa, không có file nào trong container.
    - `set -o pipefail`; chỉ `mv` sang tên chuẩn `idp-<db>-<UTC yyyymmddTHHMMSSZ>.archive.gz.gpg` khi mọi bước exit 0.
    - Ghi `<name>.manifest.json`: `{db, startedAt, finishedAt, toolVersion, collections:{name:count}, totalDocuments, bytes, sha256}`. Số document lấy từ stderr "done dumping".
    - Sau đó: `sha256sum -c` + `gpg --list-packets`, prune file local > 48 h đúng mẫu tên, rồi mới ghi metric.
    - Lỗi ở bất kỳ bước nào ⇒ exit ≠ 0, xoá `.partial`, không ghi metric.
  - `ops/backup/mongo-restore.sh <file.gpg> <src-db> <dst-db>`
    - Kiểm `sha256` theo manifest.
    - Từ chối: `dst` đã tồn tại, `dst == src`, có `--drop`, tên đích không hợp lệ.
    - Lệnh: `gpg --decrypt | $MONGORESTORE --archive --gzip --nsInclude='<src>.*' --nsFrom='<src>.*' --nsTo='<dst>.*'`.
    - Bắt buộc dòng cuối `N document(s) restored successfully. 0 document(s) failed` với N = `totalDocuments` của manifest; lệch ⇒ exit 1.
  - `ops/backup/revoke-all-refresh-tokens.mongosh.js`: khối §4c tách ra file, nhận DB qua `--eval "const TARGET='<db>'"`. Runbook và harness gọi **cùng** file để không lệch nhau.
- **D87.11 Harness diễn tập + bằng chứng tái lập**
  - Vị trí: `be/scripts/drills/`, Node ESM, import `be/dist` và dependency của `be` (mongoose, jose). Không vào image (Dockerfile chỉ chép `dist`).
  - Gồm: `lib.mjs` (boot BE con, luồng code + PKCE lấy AT/RT, timeout), `seed-drill-data.mjs`, `collection-digest.mongosh.js`, `backup-restore-drill.mjs`, `rotate-drill.mjs`.
  - Chạy lại bằng `node be/scripts/drills/backup-restore-drill.mjs` và `node be/scripts/drills/rotate-drill.mjs --provider local|vault`.
  - Đầu ra: `runs/87-X6-drills/evidence/<drill>-<UTC>.json` (+ `.log`), commit làm bằng chứng.
  - **Không gian tên** (assert lúc bắt đầu; sai ⇒ exit trước khi ghi):
    - Mongo `127.0.0.1:27017/?directConnection=true`, DB khớp `^vg-drill-(src|restore|rotate-local|rotate-vault)$`.
    - Redis `redis://127.0.0.1:6379/7` (backup + rotate local) và `/8` (rotate vault); `DBSIZE` phải = 0 lúc bắt đầu.
    - Cổng BE 4987/4988.
    - `KEY_LOCAL_DIR`, `GNUPGHOME`, archive và cwd đều trong `mkdtemp` của scratch.
  - **Dọn** (`finally`):
    - `dropDatabase` **chỉ** với DB khớp regex trên;
    - `redis-cli -n 7|8 FLUSHDB` chỉ đúng db index đó (**không bao giờ** `FLUSHALL`, không đụng db 0/1/2);
    - xoá thư mục tạm, kill tiến trình con.
  - **Hậu kiểm**: `listDatabases` không còn `vg-drill-*`; `DBSIZE` db 7/8 = 0; `sso-idp-e2e` có cùng số collection/document như lúc bắt đầu (chỉ đếm, trước và sau).
  - **Bằng chứng chỉ được chứa**: tên collection, số document, tên/spec index, digest sha256, mã HTTP, `kid`, thời gian, phiên bản công cụ.
    - **Không** chứa token, mật khẩu, hash, email thật (dùng `drill-*@drill.invalid`), URI có credential.
    - Harness tự grep bằng chứng theo `eyJ`, `$argon2`, `password`, `secret` ⇒ khớp thì exit 1.
  - Mọi HTTP `AbortSignal.timeout(5000)`; boot ≤ 30 s; toàn harness ≤ 10 phút.
  - BE diễn tập chạy `NODE_ENV=development`, vì production đòi `SESSION_COOKIE_SECURE` + Vault https (phần đó đã có `docker-smoke.sh` lo). Report ghi giới hạn này.

**Khôi phục super_admin (DEBT-252)**

- **D87.12 CLI `admin-recover`**
  - File `be/src/database/admin-recover.ts` ⇒ `dist/database/admin-recover.js`; script `db:admin-recover`.
  - Chạy production: `docker run --rm -i --env-file <env app production> <image> node dist/database/admin-recover.js <args>`.
  - Dùng **chính env của app** (`validateEnv` đầy đủ ⇒ `MONGO_URI` đúng là DB app). Chấp nhận **mọi** `NODE_ENV`, kể cả production (khác seed).
  - **Tham số** (allowlist; lạ ⇒ exit 1, không echo):
    - `--email <e>`
    - `--requested-by <id>`, `--approved-by <id>`: `^[a-z0-9._-]{2,64}$`, phải **khác nhau**
    - `--ticket <ref>`: `^[A-Za-z0-9._#/-]{1,64}$`
    - tuỳ chọn: `--unlock`, `--allow-existing-super-admin`, `--dry-run`
  - **`--dry-run`** theo quy ước DEBT-256: kiểm tham số + env, in `target:` + `dry-run: no connection made`, exit 0, **không kết nối**.
  - **Chạy thật**:
    1. Kết nối với `serverSelectionTimeoutMS: 5000`.
    2. Đọc kế hoạch:
       - user theo `normalizeEmail`; không có ⇒ từ chối, **không bao giờ tạo user**;
       - membership `default-tenant` hiện tại;
       - trạng thái khoá;
       - số super_admin **dùng được** của `default-tenant`, định nghĩa giống `SuperAdminGuard`: membership active + `super_admin`, user tồn tại, `lockedUntil ≠ ADMIN_LOCKED_UNTIL`.
    3. In kế hoạch: `target: host/db`, `user <id>`, membership, locked yes/no, `usable super_admins: N`, hai tên, ticket. **Không in email.**
    4. In mã xác nhận ngẫu nhiên 8 chữ số (`crypto.randomInt`, dạng `1234-5678`), rồi đọc **một dòng** stdin, chờ tối đa 120 s.
    5. Mã đúng ⇒ **một transaction** qua `SuperAdminGuard.runGuarded`:
       - touch `$inc superAdminGuard` các membership super_admin của tenant;
       - đếm lại số super_admin dùng được trong transaction;
       - upsert membership `{status:'active', $addToSet roles 'super_admin'}`;
       - nếu có `--unlock`: `UserService.adminUnlock(id, true, now, session)` (thêm tham số `session`);
       - insert audit `ADMIN_RECOVERED`.
    6. Commit ⇒ in `recovered: user <id>, audit event <eventId>`, exit 0.
  - **Audit `ADMIN_RECOVERED`** (enum mới, thêm vào `ALERT_ACTIONS`):
    - `actorType:'system'`, `actorId:<requested-by>`, `tenantId:'default-tenant'` (để thấy qua `GET /admin/audit`), `targetType:'user'`, `targetId:<userId>`, `result`, `reason?`.
    - `metadata:{requestedBy, approvedBy, ticket, unlocked, forced, usableSuperAdmins, host: os.hostname()}`.
    - **Không** có email, hash, IP. Đi qua `sanitizeMetadata`.
    - CLI in thêm một dòng JSON `{alert:true, action:'ADMIN_RECOVERED', eventId}` ra stdout để log pipeline bắn alert (alert listener chỉ có trong process app).
  - **Từ chối** (exit 1, không đổi membership/user). Có kết nối thì ghi thêm audit **failure** best-effort, ngoài transaction:
    - `reason:'user_not_found'` (không có `targetId`);
    - `'super_admin_exists'`;
    - `'target_locked'`: user bị admin khoá mà thiếu `--unlock` (nếu vẫn nâng thì được một admin không đăng nhập được);
    - `'not_confirmed'`: sai mã, EOF hoặc hết 120 s.
    - Audit failure lỗi ⇒ vẫn exit 1, in câu cố định.
  - **Lỗi trong transaction** (Mongo standalone không có transaction, audit insert lỗi, mất kết nối) ⇒ abort, **không ghi gì**, exit 1. Thông báo lỗi qua `cliErrorText`.
  - **Sau khi phục hồi** (ghi trong runbook): user đăng nhập `prompt=login`; nếu nghi lộ thì đổi mật khẩu ở `/account/password` (thu hồi mọi phiên, D85.6).
  - CLI **không** đụng Redis và không thu hồi phiên: không thêm phụ thuộc lúc đang sự cố, và admin API vẫn đòi `prompt=login`/step-up cho thao tác ghi.
- **D87.13 "Xác nhận 2 người" offline là kiểm soát thủ tục, không phải mật mã — runbook ghi thẳng như vậy.**
  - Ai có `MONGO_URI` quyền ghi đều vượt được mọi CLI. Kiểm soát thật gồm:
    - (a) env production/credential Mongo chỉ mở ra khi có 2 người (secret store);
    - (b) CLI bắt hai định danh khác nhau, và người duyệt phải đọc to `target:`, user id, N rồi mới gõ lại mã;
    - (c) audit nằm trong cùng transaction và alert qua log.
  - Đã loại token/HMAC hai pha và chia secret kiểu XOR: tốn công quản lý khoá mà vẫn không chặn được người có quyền ghi DB.
- **D87.14 Đã có super_admin dùng được ⇒ mặc định từ chối.**
  - `--allow-existing-super-admin` dành cho trường hợp super_admin còn đó nhưng không ai đăng nhập được (người đã nghỉ, mất hộp thư).
  - Khi dùng: audit `metadata.forced:true` + `usableSuperAdmins:N`; `--ticket` vẫn bắt buộc.
  - Race (CLI ∥ CLI, CLI ∥ demote qua API) được tuần tự hoá bằng touch trong transaction: write conflict ⇒ driver retry trên snapshot mới ⇒ thấy N ≥ 1 ⇒ từ chối, trừ khi có force.
- **D87.15 Chứng minh "chạy trong image production" mà không tạo container local**
  - (a) Local: `pnpm --filter @sso-idp/be deploy --prod <scratch>/deploy`, chép `be/dist` vào (đúng bố cục `/app` của Dockerfile), chạy `node dist/database/admin-recover.js --dry-run …` với cwd đó ⇒ exit 0. Thêm một lần chạy thật vào `vg-drill-restore` trong diễn tập T1.
  - (b) CI: `be/scripts/docker-smoke.sh` thêm check `docker run --rm --network none -e … <image> node dist/database/admin-recover.js --dry-run …` ⇒ exit 0 + dòng `target:`. Chạy ở job `be-image` khi người dùng push, không chạy local.

**Rotate khẩn cấp**

- **D87.16 Diễn tập rotate (T3)**
  - **Local**: một BE, `KEY_PROVIDER=local`, `KEY_PREPUBLISH_SEC=600` (như production), `ACCESS_TOKEN_TTL=900`, `METRICS_TOKEN` ngẫu nhiên.
  - **Vault**: hai BE A/B cùng `vg-drill-rotate-vault` + Redis `/8`; Vault `vg-b73-vault`, mount riêng `vg-drill-transit`; policy theo `ops/vault/idp-signer.hcl` (làm đúng runbook-deploy §8, tức là kiểm luôn mục đó). Token app nằm trong file `0600` ở scratch (`VAULT_TOKEN_FILE`), xoá khi dọn.
  - **Đo** (ms, tính từ lúc gửi rotate):
    - latency của rotate;
    - JWKS A chỉ còn `newKid`;
    - JWKS B chỉ còn `newKid` (**≤ 32 s** = cache 30 s + biên);
    - `/userinfo` trên B với AT cũ trả 401 (≤ 32 s).
  - Thêm một lượt **làm tay** theo runbook-ops §1 bằng curl ở Local (tester), ghi tổng thời gian. Bước nào sai thì sửa runbook ngay trong run này.
  - **Phần Vault do orchestrator chạy trong một lệnh Bash** (root token chỉ sống trong process đó, không in, không ghi file):
    1. `T=$(openssl rand -hex 16)`
    2. `docker run` theo `vault-preflight.mjs`
    3. `node be/scripts/drills/rotate-drill.mjs --provider vault`
    4. `pnpm -C be test:vault` (gate T6)
    5. `docker rm -f vg-b73-vault`, chạy cả khi bước trước lỗi
    6. `docker ps -a --filter name=vg-b73-vault` phải rỗng.

**Sweep**

- **D87.17 DEBT-589 (sửa phạm vi)**
  - Bỏ `failedLoginCount` và `lockTransitionNonce` khỏi `user.schema.ts`, `UserDoc`, `UserView`, `UserStatusPatch` và mọi chỗ ghi (`user.service.ts`, `seed.ts`, `seed-dev.ts`, `test/e2e/seed-e2e-admin.ts`).
  - Điều kiện audit unlock (`admin-users.controller.ts:256`) chỉ còn `before.lockedUntil != null`.
  - Giữ `lockedUntil`, `adminLockLevel`, `adminLockMarkAt`.
  - Không đổi FE/OpenAPI (vốn không lộ); thêm test hồi quy chứng minh không lộ.
  - Dọn dữ liệu bằng khối mongosh ở `runbook-deploy.md` §15 mới, chạy sau deploy qua `const d = db.getSiblingDB('<db>')`:
    - (i) **dry-run**: `countDocuments` cho `{$or:[{failedLoginCount:{$exists:true}},{lockTransitionNonce:{$exists:true}}]}` và cho khoá tạm cũ `{lockedUntil:{$lt:new Date(), $ne: ISODate('9999-12-31T23:59:59.999Z')}}`;
    - (ii) `updateMany` với `$unset` tương ứng;
    - (iii) chạy lại ⇒ `modifiedCount 0` (idempotent).
  - Không thêm CLI: chạy một lần, và field sót lại vô hại vì mongoose strict không đọc.
- **D87.18 DEBT-590 digest**
  - Pin `mongo:7.0.43@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b` và `redis:7.4.10-bookworm@sha256:e9b2e45ecd47fbb69b877cf8d045d5cccaaaed52524b6e098b4abe8212994f73` (cùng digest với `docker-smoke.sh`/`prod.example.yml`, đã ≥ 14 ngày).
  - Pin `axllent/mailpit:v1.21@sha256:81370195cd4a0eab9604d17c2617a7525b0486f9365555253b6c5376c6350f1a` (RepoDigest local, image 2024-12).
  - Chỗ áp dụng: `ci.yml` dòng 84/180 (`redis` service), 91 (mailpit), 124/215 (`docker run … mongo:7`); `docker-compose.yml` (3 service). Mỗi chỗ kèm comment `# <tag>, pinned 2026-11-12 (DEBT-590)`.
  - Không pull, không `compose up`. Local vẫn chạy `veyrigate-mongo` 7.0.48 trong khi CI chạy 7.0.43: chấp nhận được (cùng 7.0, chỉ là image test).
  - Guard: spec Jest mới `be/src/common/ops/image-pins.spec.ts`.
    - Đọc `.github/workflows/*.yml`, `docker-compose.yml`, `ops/compose/*.yml`, `be/scripts/docker-smoke.sh`, `be/test/vault-preflight.mjs`.
    - Mọi tham chiếu image (`image:` và ảnh trong `docker run`) phải có `@sha256:[0-9a-f]{64}`; được miễn placeholder `<registry>/veyrigate-be@sha256:<digest>`.
  - Dependabot không cập nhật image trong `services:` của workflow ⇒ DEBT-611.
- **D87.19 DEBT-608**
  - Mỗi lần chạy, `seed:e2e-admin` xoá **mọi** `refreshtokens` của user mục tiêu `E2E_USER_EMAIL`. Guard sẵn có: chỉ `NODE_ENV=test` + DB `sso-idp-e2e`. Hợp lý vì spec vốn mở đầu bằng revoke all; không đổi API.
  - Spec bỏ vòng 100 trang: family sống phải ở **trang đầu**, cho phép tối đa 2 lần "Next page" (family do spec khác trong cùng lượt tạo). Không thấy ⇒ fail, thông điệp ghi số family.
  - Đã loại phương án `?active=true`: phải đổi Admin API/fe-admin chỉ vì một test.
- **D87.20 Checklist**
  - D-4/D-5/D-6 ⇒ ✅, bằng chứng là evidence JSON + spec.
  - E-252/E-253 ⇒ đóng. D-3 ghi chú DEBT-590 đã đóng.
  - Thêm **D-16** "Bootstrap production (resource `admin`, client `fe-admin` với redirect từ env, super_admin đầu tiên)" ❌ **P1**, DEBT-164. Phần super_admin đầu tiên do T2 giải; phần còn lại đề xuất làm ở run 88, trước phần F.
  - D-13 giữ ⚠ (DEBT-391/392).

---

### T4 [BE] DEBT-589 — bỏ field cũ (D87.17) — backend-dev

- **AC**
  1. `grep -rn "failedLoginCount\|lockTransitionNonce" be/src` hoặc rỗng, hoặc chỉ còn chú thích trong `admin.mappers.ts` (sửa thành "legacy fields removed run 87").
  2. Trên doc có sẵn `failedLoginCount: 3` + `lockTransitionNonce`, các thao tác login thành công / reset / admin unlock **không ghi** `failedLoginCount` (field cũ giữ nguyên tới khi chạy migration). Hành vi khoá/mở khoá không đổi.
  3. Unlock user không bị khoá ⇒ không có audit `ADMIN_USER_UNLOCKED`, kể cả khi doc còn `failedLoginCount > 0`. Unlock user đang bị khoá ⇒ đúng 1 audit.
  4. `GET /admin/users/:id` không có key `failedLoginCount`/`lockTransitionNonce` (hồi quy).
  5. Chạy mongosh §15 trên `vg-drill-restore` ở T1 (seed có field cũ): dry-run N > 0, apply `modifiedCount = N`, chạy lại 0, đếm sau = 0. Số liệu vào evidence.
- **RED trước**
  - `be/test/run87-legacy-user-fields.int-spec.ts` cho AC2–AC4 (seed doc thô qua `collection.insertOne`).
  - Cập nhật `runbook-drill.int-spec.ts` §3, `seed*.int-spec.ts`, `admin-users.int-spec.ts` (điều kiện audit).
- **Mutation**
  - Khôi phục `$set: { failedLoginCount: 0 }` ở `clearFailedLoginsIfUnlocked` ⇒ AC2 đỏ.
  - Khôi phục `|| before.failedLoginCount > 0` ⇒ AC3 đỏ.
- **File**: `user.schema.ts`, `user.service.ts`, `admin-users.controller.ts`, `admin.mappers.ts` (chú thích), `seed.ts`, `seed-dev.ts`, `test/e2e/seed-e2e-admin.ts`, các spec liên quan, `runbook-deploy.md` §15, `runbook-ops.md` §3c/§3d (bỏ `failedLoginCount`).
- **Rủi ro**: khoá tạm cũ (`lockedUntil` < `ADMIN_LOCKED_UNTIL`) vẫn chặn login tới khi hết hạn (≤ 15', run 85), sau đó migration dọn. Ghi rõ trong §15.

### T2 [BE] DEBT-252 — CLI khôi phục super_admin (D87.12–D87.15) — backend-dev

- **Cổng security** (trust boundary: công cụ nâng quyền chạy ngoài HTTP)
  - **Tài sản**: role `super_admin`, membership `default-tenant`, trạng thái khoá, vết audit.
  - **Actor**: người thực hiện, người duyệt, kẻ có shell trên host ops, tài khoản bị chiếm được đem đi nâng quyền.
  - **Bất biến**:
    - không bao giờ tạo user;
    - chỉ chạm membership `default-tenant` và, khi có `--unlock`, trường khoá của **một** user;
    - mỗi lần nâng quyền có đúng 1 audit success **trong cùng transaction**;
    - mọi nhánh từ chối không đổi membership/user;
    - stdout/stderr không chứa email, hash, URI có credential, giá trị env.
  - **Abuse cases**:
    - chạy lại khi đã có super_admin ⇒ từ chối (D87.14);
    - trỏ nhầm DB (confused deputy) ⇒ `target:` và kế hoạch được in **trước** mã xác nhận;
    - race với demote/lock qua API hoặc với CLI thứ hai ⇒ touch + đếm lại trong transaction;
    - user đang bị admin khoá ⇒ phải có `--unlock` tường minh;
    - một người tự duyệt ⇒ tên trùng bị từ chối (chỉ là kiểm soát thủ tục, D87.13);
    - dò email (enumeration): công cụ chỉ dành cho operator ⇒ chấp nhận câu `user not found`.
  - **Failure semantics**:
    - Mongo không tới được ⇒ exit 1 trước khi in kế hoạch;
    - không có transaction (standalone) ⇒ fail-closed, không ghi;
    - audit insert lỗi ⇒ abort toàn bộ;
    - stdin EOF hoặc quá 120 s ⇒ `not_confirmed`, không ghi gì ngoài audit failure best-effort.
- **AC** (ca âm đo được)
  1. Không có super_admin dùng được, user tồn tại, mã đúng ⇒ membership active + `super_admin`; đúng 1 audit `ADMIN_RECOVERED` success, `metadata` đủ khoá theo D87.12, `tenantId: 'default-tenant'`; JSON audit không chứa email/`$argon2`; exit 0.
  2. Có ≥ 1 super_admin dùng được ⇒ exit 1, membership/user không đổi, audit failure `super_admin_exists`. Thêm `--allow-existing-super-admin` ⇒ success, `forced:true`, `usableSuperAdmins:1`.
  3. super_admin duy nhất đang bị admin khoá ⇒ tính là 0 dùng được ⇒ cho phép mà không cần force.
  4. User không tồn tại ⇒ exit 1, `users.countDocuments()` không đổi, audit failure `user_not_found`.
  5. Các lỗi tham số ⇒ exit 1 **trước khi kết nối**, thông điệp không echo giá trị. Đo bằng URI trỏ cổng đóng: phải thoát < 1 s, tức là chưa tới `serverSelectionTimeoutMS`. Các lỗi gồm:
     - `--requested-by` = `--approved-by`;
     - thiếu `--ticket`;
     - ticket hoặc tên sai mẫu;
     - tham số lạ.
  6. Mã sai / EOF / hết thời gian (tiêm đồng hồ hoặc stream) ⇒ exit 1, không đổi gì, audit failure `not_confirmed`.
  7. Target bị admin khoá, thiếu `--unlock` ⇒ `target_locked`, không đổi gì. Có `--unlock` ⇒ gỡ `lockedUntil`/`adminLockLevel`, `adminLockMarkAt` tăng, `metadata.unlocked:true`.
  8. Audit insert ném lỗi (stub `create` trong transaction) ⇒ membership **không** đổi (abort), exit 1.
  9. Hai CLI song song trên DB chưa có super_admin:
     - khác user ⇒ đúng 1 success + 1 `super_admin_exists`;
     - cùng user ⇒ cả hai success (idempotent).
     - Không bao giờ có membership nửa vời.
  10. `--dry-run` ⇒ in `target:` + `dry-run: no connection made`, exit 0, không kết nối.
  11. stdout/stderr của mọi ca trên không chứa email đầu vào, URI credential hay `passwordHash`.
  12. Phần enum/schema:
      - `ADMIN_RECOVERED` nằm trong `ALERT_ACTIONS`;
      - OpenAPI enum được sinh lại, `fe-admin/src/server/admin-api/schema.d.ts` khớp (`gen:api`);
      - `AUDIT_ACTIONS` ở `fe-admin/src/features/admin-api/inputs.ts` có thêm `"ADMIN_RECOVERED"`;
      - `fe-admin/test/admin-schema-types.test.ts` xanh.
  13. D87.15(a) chạy được từ bố cục `pnpm deploy --prod`; D87.15(b) có check trong `docker-smoke.sh`.
- **RED trước**
  - `be/test/run87-admin-recover.int-spec.ts` (AC1–AC9, AC11): gọi hàm xuất `recoverSuperAdmin(connection, opts, io)` với `io = { input, output, now, timeoutMs }`.
  - `be/src/database/admin-recover.spec.ts`: unit parse tham số (AC5, AC10).
  - Một ca child-process trên `dist` cho AC5/AC10.
- **Mutation**
  - Bỏ kiểm hai tên khác nhau ⇒ AC5 đỏ.
  - Insert audit ngoài transaction ⇒ AC8 đỏ.
  - Đếm super_admin mà không loại user bị admin khoá ⇒ AC3 đỏ.
  - Bỏ touch `$inc` ⇒ AC9 phải đỏ được (lặp ≥ 20 lần trong test).
  - Bỏ kiểm `target_locked` ⇒ AC7 đỏ.
- **File**
  - BE: `be/src/database/admin-recover.ts` (+ spec), `be/package.json` (`db:admin-recover`), `audit-action.enum.ts`, `user.service.ts` (`adminUnlock` thêm `session?`), `admin.openapi.ts`/OpenAPI sinh.
  - fe-admin: `fe-admin/openapi/admin.json`, `fe-admin/src/server/admin-api/schema.d.ts`, `fe-admin/src/features/admin-api/inputs.ts` (đúng 1 dòng; backend-dev làm, không cần lane FE).
  - Khác: `be/scripts/docker-smoke.sh`, `be/test/runbook-drill.int-spec.ts` §3, `runbook-ops.md` §3d viết lại (CLI thay mongosh; mongosh chỉ còn là đường cuối khi image không chạy được, kèm cảnh báo không có audit).
- **Rủi ro**
  - `validateEnv` đầy đủ buộc operator phải có env của app (đúng ý D87.13).
  - TTY: `docker run` cần `-i` (runbook ghi).
  - `os.hostname()` trong container là id container (vẫn có ích trong log).

### T5 [ops/E2E] DEBT-590 + DEBT-608 (D87.18–D87.19) — backend-dev; tester chạy E2E

- **AC**
  1. `image-pins.spec.ts` xanh; bỏ `@sha256` ở bất kỳ chỗ nào ⇒ đỏ (mutation).
  2. `grep -nE "image: [^ ]+$|mongo:7 " .github/workflows/ci.yml docker-compose.yml` không còn dòng nào chưa pin.
  3. `seed-e2e-admin.int-spec.ts` có ca mới: seed 30 RT (revoked + active) của user mục tiêu và 1 RT của user khác ⇒ sau seed còn 0 RT của mục tiêu, RT của user khác giữ nguyên. Mutation xoá cả RT của user khác ⇒ đỏ.
  4. E2E `fe-admin-users.spec.ts` xanh 2 lượt liên tiếp; spec không còn chuỗi `100 pages`.
- **File**: `.github/workflows/ci.yml`, `docker-compose.yml`, `be/src/common/ops/image-pins.spec.ts`, `be/test/e2e/seed-e2e-admin.ts`, `be/test/seed-e2e-admin.int-spec.ts`, `e2e/tests/fe-admin-users.spec.ts`.
- **Rủi ro**
  - Digest mailpit là RepoDigest local (index digest của tag lúc pull). Nếu sai, CI không pull được và job `int` đỏ ngay ⇒ thấy được; sửa bằng `docker buildx imagetools inspect` (cần mạng, bước của người dùng/CI).
  - Không chạm job workflow nào khác.

### T1 [ops/QA] DEBT-253 — chính sách + diễn tập backup/restore (D87.2–D87.11) — backend-dev viết script/harness; tester chạy và viết biên bản

- **AC tài liệu**
  - `runbook-ops.md` §4: thay "Chính sách: chưa quyết" bằng D87.2–D87.9 (bảng lịch/RPO/RTO/retention/nơi lưu/quyền/khoá/giám sát) + lệnh `ops/backup/*.sh`, bỏ `--uri=` trên argv.
  - §4c gọi `revoke-all-refresh-tokens.mongosh.js`.
  - Alert `SsoMongoBackupStale` + `ops-rules.spec` xanh.
- **AC script** (backend-dev; harness chạy các ca âm này trước ca chính, ghi vào evidence)
  1. `mongo-restore.sh` vào DB đã tồn tại ⇒ exit ≠ 0, DB đích không đổi (đếm trước/sau).
  2. `dst == src`, có `--drop`, hoặc sha256 trong manifest sai (sửa 1 byte `.gpg`) ⇒ exit ≠ 0, không kết nối.
  3. `MONGO_URI` có `@` ⇒ exit ≠ 0, không echo URI.
  4. `mongodump` lỗi giữa chừng (`MONGODUMP=false`) ⇒ không có file tên chuẩn, không còn `.partial`, metric không đổi.
  5. Số document ở dòng cuối của restore ≠ manifest ⇒ exit 1.
- **AC diễn tập** (tester)
  1. Seed `vg-drill-src`:
     - `db:seed` (`NODE_ENV=test`, admin `drill-admin@drill.invalid`) + `db:seed-dev`;
     - `seed-drill-data.mjs` sinh: 2 000 user (dùng chung 1 hash Argon2), trong đó 200 user có field cũ của T4; 500 consent; 2 000 RT (một nửa revoked, `expiresAt` ở tương lai); 5 000 audit (timestamp trong 24 h, để TTL không xoá).
  2. Boot BE trên src, chạy luồng code cho `fe-admin`, giữ `RT_pre` (chỉ trong bộ nhớ), rồi dừng BE.
  3. `mongo-backup.sh` với khoá gpg tạm (`GNUPGHOME` trong scratch; khoá diễn tập không có passphrase, production thì có).
  4. `mongo-restore.sh` sang `vg-drill-restore`.
  5. Digest từng collection khớp hoàn toàn: count, index spec (name/key/unique/expireAfterSeconds/partialFilterExpression), và sha256 EJSON canonical (`relaxed:false`) của doc sắp theo `_id`.
  6. §4c qua file mongosh ⇒ `active RT: 0`.
  7. `db:sync-indexes` ⇒ mọi model `synced`, không có `dropped`.
  8. Boot BE trên restore với cùng `KEY_LOCAL_DIR` (giống Vault: key không bị restore ảnh hưởng). Kiểm:
     - `/health` 200, `/ready` 200;
     - `/.well-known/openid-configuration` 200;
     - `/jwks.json` ≥ 1 key;
     - đăng nhập admin + luồng code ⇒ `GET /admin/keys` 200;
     - **`RT_pre` ⇒ 400 `invalid_grant`** (ca âm của §4c); RT mới ⇒ 200.
  9. Migration T4 §15 trên DB restore (AC5 của T4).
  10. CLI T2 chạy từ bố cục `deploy --prod`:
      - khoá admin diễn tập (qua admin API nếu có super_admin khác, hoặc bằng mongosh trên `vg-drill-restore`);
      - `admin-recover --unlock` với hai tên;
      - kỳ vọng: đăng nhập lại được, `GET /admin/audit?action=ADMIN_RECOVERED` thấy event.
  11. Đo thời gian: dump, encrypt, restore, digest, sync-indexes, boot, và tổng phần kỹ thuật (≤ 10 phút, D87.3).
  12. Dọn và hậu kiểm theo D87.11.
- **Bằng chứng**
  - `runs/87-X6-drills/drill-report.md` (tester): lệnh tái lập, môi trường (phiên bản mongod/mongodump/gpg, HEAD), bảng số liệu, thời gian, ca âm, các bước runbook đã sửa.
  - `evidence/backup-restore-<UTC>.json` được commit.
- **File**: `ops/backup/mongo-backup.sh`, `ops/backup/mongo-restore.sh`, `ops/backup/revoke-all-refresh-tokens.mongosh.js`, `be/scripts/drills/*`, `ops/prometheus/alerts.yml`, `be/src/common/metrics/ops-rules.spec.ts`, `runbook-ops.md` §4, `runs/87-X6-drills/drill-report.md`, `runs/87-X6-drills/evidence/*`.
- **Rủi ro**
  - Pipe nhị phân `docker exec -i` trong Git Bash: kiểm bằng restore thành công + digest. Nếu lỗi, chuyển sang ghi file trong scratch (không bao giờ để file rõ trong container) và ghi lại.
  - Cần `MSYS_NO_PATHCONV=1` cho `docker exec` (runbook §4a).
  - gpg-agent trên Windows với `GNUPGHOME` tạm: chạy `gpgconf --kill gpg-agent` khi dọn.
  - Không bao giờ `docker cp` vào container dùng chung.

### T3 [ops/QA] diễn tập rotate khẩn cấp (D87.16) — tester (Local + lượt tay), orchestrator (Vault)

- **AC** (cả hai provider, ghi trong evidence)
  1. Trước rotate:
     - AT_old (user diễn tập, client `fe-admin`): `/userinfo` 200, `/introspect` `active:true`;
     - verifier RP (`jose.createRemoteJWKSet` mặc định, đã nóng cache) verify được AT_old.
  2. `POST /admin/keys/rotate {"mode":"emergency"}` ⇒ 200. `GET /admin/keys` có đúng 1 item active, kid khác trước.
  3. `/jwks.json` chỉ còn `newKid` (A ngay lập tức, B ≤ 32 s), header `cache-control: no-cache`.
  4. AT_old ⇒ `/userinfo` 401, `/introspect` `active:false`, admin API 401.
  5. Refresh ⇒ 200, AT mới có `kid = newKid`. Verifier RP **mới** verify được AT mới và từ chối AT_old.
  6. Verifier RP **còn cache nóng** vẫn chấp nhận AT_old. Đây là bằng chứng cho runbook §1 5(ii); ghi kết quả thật. Ghi luôn việc verifier nóng có verify được AT mới ngay hay không (jose `cooldownDuration` mặc định 30 s).
  7. Audit `SIGNING_KEY_ROTATED` success `metadata.mode:'emergency'`; metric `sso_signing_key_rotations_total{mode="emergency",result="success"}` tăng 1.
  8. Rotate normal ⇒ `pending`; rotate normal lần hai ⇒ 409 `conflict`.
  9. Local: `KEY_LOCAL_DIR` đúng runbook-deploy §6 (chỉ còn PEM của key sống).
  10. Vault: `GET <mount>/keys/<key>` có `latest_version = min_decryption_version = min_encryption_version = min_available_version = N` và chỉ còn 1 version.
  11. Lượt tay Local theo runbook-ops §1: mọi lệnh chạy đúng như viết, hoặc đã được sửa; ghi tổng thời gian.
- **Sửa tài liệu**: `runbook-ops.md` §0 (chữ cũ, phát hiện 8); §1 (thay "≤ 30 s" bằng số đo thật nếu khác); thêm mục mất storage Vault (D87.9). Ghi các sửa đổi vào `drill-report.md`.
- **File**: `be/scripts/drills/rotate-drill.mjs`, `runbook-ops.md` §0/§1, `drill-report.md`, `evidence/rotate-{local,vault}-<UTC>.json`.
- **Rủi ro**
  - Token app Vault nằm trên đĩa scratch trong lúc chạy (cần cho `VAULT_TOKEN_FILE`), xoá khi dọn; root token không bao giờ chạm đĩa.
  - Đồng hồ: hai BE cùng host nên không lệch.

### T6 [QA] — tester

- `release-checklist.md` theo D87.20:
  - D-4/D-5/D-6 ✅, bằng chứng dạng `đường-dẫn › tên test` hoặc file evidence;
  - thêm D-16 ❌ P1;
  - cập nhật E-252/E-253/D-3;
  - đếm lại bảng tổng bằng script.
- `security-matrix.md`: thêm dòng cho CLI recovery (AC2/AC5/AC6/AC8 của T2) và cho mã hoá backup/guard (AC script 1–3 của T1).
- **Gate** (ghi vào `test-report.md`):
  - `pnpm lint` + typecheck;
  - `pnpm -C be test`;
  - `pnpm -C be test:int` FULL;
  - `test:vault` (orchestrator, trong lệnh Vault của D87.16);
  - E2E `pnpm -C e2e e2e`, X3 42;
  - `pnpm -C fe-admin test`.
- **Hậu kiểm hạ tầng** (D87.11):
  - không có container mới (`docker ps -a` chỉ có 3 container cũ);
  - không còn DB `vg-drill-*`;
  - Redis db 7/8 trống;
  - `sso-idp-e2e` chỉ do E2E thay đổi.
