# Biên bản diễn tập — run 87 (X6): rotate khẩn cấp + backup/restore

Người lập: **tester**, 2026-11-12. Code: `develop` `8855df0` + working tree run 87 (chưa commit). BE chạy từ `be/dist`
(`pnpm -C be build` lúc 13:1x, cùng nội dung với `be87/deploy/dist`).

## Kết luận

| Diễn tập | Kết quả | Bằng chứng |
|---|---|---|
| T3 rotate khẩn cấp — Vault (2 BE) | ✅ PASS 30/30 check (orchestrator) | `evidence/rotate-vault-20261112T060754Z.json` (+ `.log`) |
| T3 rotate khẩn cấp — Local (1 BE) | ✅ PASS 23/23 check | `evidence/rotate-local-20261112T062325Z.json` (+ `.log`) |
| T3 lượt tay runbook-ops §1 (Local, curl) | ✅ mọi lệnh chạy đúng như viết, tổng 1,98 s | mục "Lượt tay" dưới đây |
| T1 backup/restore (+ §15 T4 AC5 + `admin-recover` trên DB restore) | ✅ PASS 36/36 check, 55,8 s; phần kỹ thuật 12,8 s (≤ 10 phút) — sau khi sửa DEBT-620/621 | `evidence/backup-restore-20261112T071348Z.json` (+ `.log`) |

## Môi trường

- Host Windows 10, Git Bash; node v22.23.4; gpg (GnuPG) 2.4.8 (Git).
- `veyrigate-mongo`: mongod 7.0.48 (rs0), `mongodump` 100.20.1 (trong container). `veyrigate-redis` redis 7.
- Không tạo container nào (Vault thử `vg-b73-vault` do orchestrator tạo/xoá trong một lệnh). DB diễn tập `vg-drill-*`,
  Redis db 7 (Local, backup) / 8 (Vault), cổng 4987/4988, cwd = thư mục tạm (không nạp `be/.env`).
- Giới hạn (D87.11): BE chạy `NODE_ENV=development` (production cần Vault https + cookie `Secure`, phần đó do
  `docker-smoke.sh` lo); `KEY_PREPUBLISH_SEC=600`, `ACCESS_TOKEN_TTL=900` như production.

## T3 — rotate khẩn cấp

Lệnh tái lập (từ gốc repo, Git Bash):

```bash
pnpm -C be build
node be/scripts/drills/rotate-drill.mjs --provider local
# Vault (orchestrator, một lệnh Bash; root token chỉ sống trong process): xem tasks.md D87.16
VAULT_TEST_ADDR=http://127.0.0.1:18200 VAULT_TEST_ROOT_TOKEN=$T node be/scripts/drills/rotate-drill.mjs --provider vault
```

### Số đo (ms tính từ lúc gửi `POST /admin/keys/rotate {"mode":"emergency"}`)

| Đo | Local | Vault | Ngưỡng |
|---|---|---|---|
| Latency rotate | 94 | 196 | — |
| JWKS instance xoay = `[newKid]` | 99 | 205 | ngay |
| JWKS instance B = `[newKid]` | — (1 BE) | 29 119 | ≤ 32 000 ✅ |
| `/userinfo` AT cũ trên B ⇒ 401 | — | 29 129 | ≤ 32 000 ✅ |
| Verifier RP cache nóng còn nhận AT cũ | có (287 ms sau rotate) | có (29 353 ms sau rotate) | dự kiến (runbook §1 5(ii)) |
| Verifier RP cache nóng nhận AT mới ngay | **không** | **không** | jose `cooldownDuration` 30 s |
| Tổng thời gian harness | 10,8 s | 47,5 s | ≤ 10 phút ✅ |

### AC T3 (cả hai provider, trong `checks` của evidence)

1. Trước rotate: AT_old `/userinfo` 200, `/introspect` `active:true`; verifier RP nóng verify được AT_old. ✅
2. Emergency ⇒ 200, kid mới khác kid cũ; `GET /admin/keys` đúng 1 item active = newKid. ✅
3. `/jwks.json` = `[newKid]` (A ngay, B ≤ 32 s), `cache-control: no-cache`. ✅
4. AT_old ⇒ `/userinfo` 401, `/introspect` `active:false`, admin API 401. ✅
5. Refresh ⇒ 200, AT mới `kid = newKid`; verifier RP **mới** nhận AT mới, từ chối AT_old. ✅
6. Verifier RP **nóng** vẫn nhận AT_old và **từ chối** AT mới ⇒ ghi vào runbook §1 5(ii). ✅ (kết quả thật như bảng)
7. Audit `SIGNING_KEY_ROTATED` success `metadata.mode:'emergency'`; metric `{mode="emergency",result="success"}` 0 → 1. ✅
8. Rotate normal ⇒ 1 pending; normal lần hai ⇒ 409 `conflict`. ✅
9. Local: `KEY_LOCAL_DIR` = `<newKid>.pem` + `keys.json` (runbook-deploy §6). ✅
10. Vault: `latest_version = min_decryption = min_encryption = min_available = 2`, còn 1 version. ✅ (orchestrator)
11. Lượt tay Local theo runbook-ops §1: ✅ (dưới).

Vault: `pnpm -C be test:vault` 32/32 PASS (orchestrator, cùng lệnh); container `vg-b73-vault` đã xoá.

### Lượt tay runbook-ops §1 (Local, tester)

Một BE (`vg-drill-rotate-local`, Redis db 7, `KEY_PREPUBLISH_SEC=600`) dựng bằng helper của tester
(`scratchpad/t87/manual-rotate-setup.mjs`, dùng `lib.mjs` của harness: lock + guard namespace + dọn như drill);
`ADMIN_AT` lấy qua luồng code + PKCE của harness (thay cho trình duyệt `prompt=login` ở bước 1). Các bước 2–5 + "Xác minh"
chạy bằng `curl` đúng như runbook viết (`scratchpad/t87/manual-rotate.sh`, token đọc từ file 0600, không in):

| Bước runbook §1 | Kết quả thật |
|---|---|
| 2. `GET /admin/keys` | `[{kid:3d75…0008, status:active, activatesAt}]` |
| 3. `POST /admin/keys/rotate {"mode":"emergency"}` | 200 trong 252 ms, body `{newKid:7931…7c46, oldKid:3d75…0008, mode:emergency, activatesAt}` |
| 4. runbook-deploy §6 | `KEY_LOCAL_DIR` = `7931…7c46.pem keys.json` |
| 5(i). `curl -sI $IDP/jwks.json` | `200`, `vary: Origin`, `cache-control: no-cache` |
| Xác minh: `ADMIN_AT` vừa dùng | 401 |
| Xác minh: kid trong JWKS | chỉ `7931…7c46` |
| Xác minh: refresh | 200, AT mới `kid = 7931…7c46` |
| Xác minh: `GET /admin/keys` (AT mới) | đúng 1 item `{kid:7931…7c46, status:active}` |
| Xác minh: audit | `SIGNING_KEY_ROTATED` success, `targetId` = newKid, `metadata.mode:emergency`, `metadata.oldKid` |

Tổng lượt tay (bước 2 → xác minh cuối): **1,98 s** (không tính đăng nhập). Không bước nào sai lệnh/kỳ vọng.
Dọn: `cleanupErrors []`, `postCheck {drillDbsLeft: [], redisDbSizes:{7:0}, e2eUnchanged:true}`.

### Sửa runbook (T3 + senior lượt 2)

- `runbook-ops.md` §0: bỏ "Chưa có UI fe-admin (A4–A6 chờ Q3)" (console có sẵn, curl cho trường hợp console không vào
  được, khoá console ⇒ §7) và "chưa có KMS … TBD B7.3" (production = Vault Transit, run 53, runbook-deploy §8).
- `runbook-ops.md` §1: thêm số đo thật — instance kia bỏ key cũ sau ~29 s (≤ 30 s đúng), AT cũ còn sống ~30 s trên
  instance chưa làm mới cache (cắt ngay ⇒ restart rolling); 5(ii): verifier RP nóng vẫn nhận AT cũ **và** từ chối AT mới
  trong ≤ 30 s (cooldown jose). Mục mất storage Vault (D87.9) đã có ở §4 (backend-dev).
- `runbook-ops.md` §4c (R2-1): tách URI giống `mongo-restore.sh` (bỏ nháy YAML, `head -n1`) và từ chối URI rỗng/có `'`/`\`
  trước khi gọi mongosh; đã thử khối lệnh với 6 dạng `uri:` (nháy đơn, nháy kép, trần, `\`, `'`, rỗng): 3 qua, 3 dừng.
- `runbook-ops.md` §4 bảng chính sách (R2-2): khoá ký backup không đặt hạn; xoay định kỳ = ngừng dùng, không thu hồi;
  chỉ thu hồi khi lộ; giữ public key + fingerprint cũ tới khi bản cuối hết retention.
- `runbook-ops.md` §4b (R2-3): chọn archive theo metadata object lock; chữ ký không ràng buộc tên DB/thời điểm.

## T1 — backup/restore ✅ (lượt chính thức, sau retry 1 của backend-dev)

Lệnh tái lập (từ gốc repo, Git Bash, KHÔNG trong `be/`):

```bash
pnpm -C be build
node be/scripts/drills/backup-restore-drill.mjs --recover-cli <scratch>/be87/deploy/dist/database/admin-recover.js
```

`be87/deploy` = bố cục `pnpm --filter @sso-idp/be deploy --prod` + `dist` chép từ `be/dist` (`diff -rq` chỉ khác
`tsconfig.tsbuildinfo`; không có `.env`/`keys`). Chạy 07:12:51–07:13:48 UTC: **exit 0, 36/36 check, 55,8 s**.
Evidence: `evidence/backup-restore-20261112T071348Z.json` (+ `.log`).

### Số đo so với chính sách (D87.3)

| Bước | ms |
|---|---|
| dump + ký + mã hoá (`mongo-backup.sh`, 11 519 document, archive 344 539 byte) | 1 931 |
| digest nguồn | 492 |
| giải mã + kiểm chữ ký + restore (`mongo-restore.sh`, giải mã 2 lượt — R2-4) | 4 992 |
| digest bản restore | 378 |
| §4c thu hồi toàn bộ RT (`revoke-all-refresh-tokens.mongosh.js`) | 1 163 |
| `db:sync-indexes` | 1 249 |
| boot BE trên DB restore (`/health` + `/ready` 200) | 5 443 |
| **Phần kỹ thuật (restore + §4c + sync-indexes + boot)** | **12 847** |
| `admin-recover --unlock` (kế hoạch + mã + transaction) | 2 796 |

| Mục tiêu | Ngưỡng | Diễn tập | Đánh giá |
|---|---|---|---|
| Phần kỹ thuật, diễn tập (dữ liệu nhỏ) | ≤ 10 phút | 12,8 s | ✅ |
| Phần kỹ thuật production (archive ≤ 1 GB) | ≤ 30 phút | archive 0,34 MB; tuyến tính ⇒ còn xa ngưỡng, nhưng chưa đo ở 1 GB | ✅ trong phạm vi đo được |
| RTO ≤ 2 h (gồm §4d làm tay) | ≤ 2 h | kỹ thuật 12,8 s + CLI 2,8 s; §4d làm tay không diễn tập (phụ thuộc ticket/log) | ✅ phần kỹ thuật, §4d ngoài phạm vi đo |
| RPO ≤ 1 h | khoảng cách 2 backup thành công | một lần dump 1,9 s ⇒ lịch hằng giờ khả thi; alert `SsoMongoBackupStale` 2 h (promtool + `ops-rules.spec`) | ✅ khả thi; lịch cron chưa chạy thật (hạ tầng) |

### Kết quả từng bước (AC diễn tập)

1. Seed `vg-drill-src`: `db:seed` + `db:seed-dev` + 2 000 user (200 có field cũ T4, 50 khoá tạm cũ), 500 consent,
   2 000 RT, 5 000 audit. ✅
2. BE nguồn: luồng code `fe-admin`, `GET /admin/keys` 200, giữ `RT_pre` trong bộ nhớ, dừng BE. ✅
3. `mongo-backup.sh` exit 0, tên chuẩn `idp-vg-drill-src-20261112T071309Z.archive.gz.gpg`, không còn `.partial`, metric
   textfile ghi; manifest `totalDocuments` 11 519 = số document nguồn; `toolVersion` mongodump 100.20.1. ✅
4. Ca âm script (chạy trước restore thật; `negativeCases` đều `true`):
   - AC3 `MONGO_URI` có credential ⇒ từ chối, không echo URI;
   - AC4 `MONGODUMP=false` ⇒ exit ≠ 0, không file mới, không `.partial`, metric không đổi;
   - AC1 DB đích đã tồn tại ⇒ từ chối, DB đích không đổi (1 marker, 1 collection);
   - AC2 `dst == src`, `--drop`, đảo 1 byte (sha256 lệch) ⇒ từ chối trước khi kết nối;
   - DEBT-617 archive ký bằng khoá không pin (rogue signer) ⇒ từ chối trước mongorestore;
   - AC5 số document restore ≠ manifest ⇒ exit 1. ✅
5. `mongo-restore.sh` vào `vg-drill-restore` exit 0; 12 collection khớp hoàn toàn (count, spec index, sha256 EJSON
   canonical theo `_id`). ✅
6. §4c: `DB: vg-drill-restore`, `active RT: 0`, `total RT: 2001`. ✅
7. `db:sync-indexes`: 12 model `synced`, không `dropped`. ✅
8. BE trên DB restore (cùng `KEY_LOCAL_DIR`): `/health` 200, `/ready` 200, discovery 200, JWKS 1 kid; admin đăng nhập +
   `GET /admin/keys` 200; **`RT_pre` ⇒ 400 `invalid_grant`** (ca âm của §4c); RT mới ⇒ 200. ✅
9. runbook-deploy §15 (T4 AC5) trên DB restore: dry-run `legacy 200`, `expiredLocks 50`; apply `modifiedCount` 200 + 50;
   chạy lại 0 + 0; đếm sau 0/0. ✅
10. T2 trên DB restore, CLI từ bố cục deploy: admin bị khoá (mongosh) ⇒ không đăng nhập được; `--dry-run` exit 0
    `dry-run: no connection made`; `--unlock` (hai tên `drill-ops-a`/`drill-ops-b`, ticket `DRILL-87`) exit 0, kế hoạch
    `target: 127.0.0.1:27017/vg-drill-restore`, `locked: yes (admin lock)`, `usable super_admins: 0`,
    `recovered: user <id>, audit event <uuid>`; output không có email; đăng nhập lại được;
    `GET /admin/audit?action=ADMIN_RECOVERED` 200, 1 event success. ✅
11. Thời gian: bảng trên. ✅
12. Dọn + hậu kiểm: `cleanupErrors []`, `drillDbsLeft []`, Redis db 7 = 0, `sso-idp-e2e` không đổi (`e2eUnchanged:true`).
    Sau lượt: `listDatabases` = `admin config local sso-idp-e2e`; Redis db 7/8 = 0; không còn `%TEMP%\vg-drill-*`,
    lock, gpg-agent/scdaemon. ✅

### Lỗi tìm thấy trong diễn tập và đã sửa (retry 1 backend-dev)

Ba lượt đầu (trước retry) treo sau `[13.3s] source app stopped (RT_pre kept in memory)`:

1. **DEBT-620** — `mongo-backup.sh` đếm document bằng regex không cho backtick, trong khi mongodump 100.20.1 in
   ``done dumping `vg-drill-src.users` (2002 documents)`` ⇒ mọi backup exit 1 `mongodump reported no collection`
   (production: backup hằng giờ không bao giờ thành công). Sửa: `DONE_RE` nhận cả hai dạng, neo `<db>.`;
   `be/src/common/ops/backup-scripts.spec.ts` (5 ca, gồm dòng log thật 100.20 và DB cùng tiền tố).
2. **DEBT-621** — `lib.mjs` `startBe().stop()` coi `exit` SIGTERM (`code === null`) là chưa thoát ⇒ `stop()` lần hai
   trong `finally` chờ mãi, không dọn (xác định bằng inspector: chỉ còn 3 socket Mongo). Sửa: `stoppable()` dừng
   idempotent theo `exitCode`/`signalCode`, `postCheck`/`conn.close` chặn lỗi, `disable-scdaemon` trong GNUPGHOME tạm.

Sau mỗi lượt treo tester dọn tay đúng tài nguyên drill sở hữu (drop `vg-drill-src`, `FLUSHDB` db 7, lock, thư mục tạm,
`gpgconf --kill`).

### Giới hạn

- BE `NODE_ENV=development` (D87.11); khoá gpg diễn tập không passphrase (production: key + passphrase ở 2 secret store).
- Dữ liệu 0,34 MB: chưa đo được thời gian ở 1 GB (ngưỡng 30 phút) — đề xuất đo ở lần diễn tập quý đầu trên bản sao
  production (D87.8).
- PITR không diễn tập (D87.4, DEBT-610). §4d làm tay không diễn tập.

## Kiểm bí mật trong evidence

`grep -nE 'eyJ|argon2|password|secret'` trên `evidence/*`: chỉ khớp tên check `"fe-admin secret issued"` (3 file JSON) và tên collection `passwordresettokens`; không có `mongodb://…@`,
không có token, hash, mật khẩu, URI có credential. Harness tự chạy `assertClean` trước khi ghi.
