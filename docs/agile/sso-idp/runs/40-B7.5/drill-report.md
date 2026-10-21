# Drill report — run 40 (B7.5) — 2026-10-20

> Tester, Task 2b. Diễn tập [runbook-ops.md](../../runbook-ops.md) §1–§4 CHỈ trên hạ tầng test
> `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`. Không chạm `aegate-*`, cổng host 27017, DB `sso-idp*`,
> không `--drop`, không FLUSH, không docker run/rm/pull/compose. Không ghi secret/mật khẩu (giá trị tạm
> sinh ngẫu nhiên, không in; dòng `fe-admin client_secret (shown once)` đã che `<REDACTED>` và file output xoá).

## Kết quả: 4/4 kịch bản có bằng chứng — PASS

| # | Kịch bản | Cách | Thời gian (UTC) | Kết quả |
|---|---|---|---|---|
| 1 | Key nghi lộ — emergency rotation | tự động `runbook-drill.int-spec.ts` | 09:55:13–09:55:32 (cả spec 16,3 s; it 0,9 s) | PASS |
| 2 | `TOKEN_REUSE_DETECTED` đột biến | tự động (cùng spec) | như trên (it 1,6 s) | PASS |
| 3 | Mất admin / 0 super_admin | tự động (cùng spec) | như trên (it 0,9 s) | PASS |
| 4 | Backup/restore Mongo | §4(i) tự động (it 0,4 s) + **thủ công** Q-40.1 | thủ công 09:56:12–09:57:50 (~1 ph 38 s) | PASS |

Chạy lại spec sau khi siết assert §2 (xem lệch L3): 4/4 xanh. Nghiệm thu nhẹ: `pnpm -C be test` 387/387
(32 suites); `pnpm -C be test:int` FULL 1203/1203 (45 suites, 330 s, 09:59:45–10:05:17).

## Kịch bản 1–3 + §4(i) — tự động

Lệnh: `pnpm -C be test:int -- --testPathPatterns runbook-drill`

```
PASS test/runbook-drill.int-spec.ts (16.177 s)
  √ §1 emergency rotation: step-up enforced, old AT 401, JWKS = newKid only, refresh survives, audit visible (879 ms)
  √ §2 TOKEN_REUSE_DETECTED: family auto-revoked, admin audit EMPTY, mongosh path finds the user, revoke tools work (1646 ms)
  √ §3 lost admin: seed refuses production, restores super_admin, never resets the password nor the lock; break-glass unlock (877 ms)
  √ §4(i) post-restore "revoke every RT" (runbook mongosh): live RTs die as plain invalid_grant, no reuse burst (441 ms)
Tests: 4 passed, 4 total
```

Đối chiếu từng bước runbook ↔ assert trong spec:

| Runbook | Bước | Assert trong spec |
|---|---|---|
| §1 bước 2 | `GET /admin/keys` ghi kid active | `items[status=active].kid == oldKid` |
| §0 step-up | AT từ refresh không có auth_time | `POST /admin/keys/rotate` → `403 {"error":"step_up_required","max_age":0}`, JWKS không đổi |
| §1 bước 3 | rotate `{"mode":"emergency"}` | `200 {newKid, oldKid, mode:"emergency"}` |
| §1 xác minh | JWKS chỉ newKid; AT cũ chết; refresh vẫn chạy; `GET /admin/keys` 1 item; audit `SIGNING_KEY_ROTATED` | `jwks == [newKid]`; admin API bằng AT cũ `401`; verifier ném; refresh `200` với `kid=newKid`; audit `{targetId:newKid,result:"success",metadata:{mode,oldKid}}` |
| §2 dấu hiệu | metric `sso_audit_events_total{action="TOKEN_REUSE_DETECTED"}` | delta = 1 sau 1 replay; family tự revoke (RT kế tiếp `400`) |
| §2 cảnh báo | `/admin/audit?action=TOKEN_REUSE_DETECTED` rỗng | `items == []` (DEBT-140) |
| §2 mongosh 1–3 | find/aggregate/findOne | event không có `tenantId`, `clientId` đúng, `metadata.count ≥ 1`; family → đúng user; aggregate `[{_id:<rp>,n:1}]` |
| §2 hành động | `sessions/revoke`, `families/:id/revoke`, `PATCH disabled:true` | `204`/`204`/`200`; RT tương ứng `400`; `countDocuments({clientId, revokedAt:null}) == 0`; RT client disable → **`401 invalid_client`** (assert mới) |
| §3c | `NODE_ENV=production` bị từ chối trước khi ghi | `/refusing to run with NODE_ENV=production/`, không tạo user |
| §3c | seed khôi phục role, KHÔNG đổi mật khẩu/khoá | membership `active` + `super_admin`; mật khẩu cũ verify; `lockedUntil`, `failedLoginCount=5` giữ nguyên |
| §3d | break-glass `$unset lockedUntil` | đăng nhập bằng mật khẩu cũ → `GET /admin/keys` `200` |
| §4c | 2 `updateMany` | `countDocuments({revokedAt:null}) == 0`; RT đang giữ → `400 invalid_grant`, metric + audit reuse KHÔNG tăng; chỉ RT đã rotate trước backup bắn reuse (+1) |

## Kịch bản 4 — thủ công (Q-40.1)

`TS=1792490163`. Mọi `mongosh`/`mongodump`/`mongorestore` chạy bằng `docker exec vg-test-mongo …` (kết nối
`localhost:27017` BÊN TRONG container `vg-test-mongo` = cổng host 27117; không đụng cổng host 27017). Git
Bash: `MSYS_NO_PATHCONV=1` (xem L4).

**B0 — kiểm khô đích (không kết nối)** — trong `be/`:
```
$ MONGO_URI="mongodb://127.0.0.1:27117/vg-drill-src-$TS?directConnection=true" node --env-file-if-exists=.env -e "console.log(require('./dist/database/mongo/sync-indexes.js').mongoTarget(process.env.MONGO_URI))"
target: 127.0.0.1:27117/vg-drill-src-1792490163
$ MONGO_UIR="x" node --env-file-if-exists=.env -e "…cùng lệnh…"      # mô phỏng gõ sai tên biến
target: localhost:27017/sso-idp                                     # rơi về DB dev ⇒ lý do của L1
```

**B1 — tạo nguồn** (09:56:12, `dist` build lúc 16:43 local, mới hơn src F5):
```
$ NODE_ENV=test MONGO_URI="mongodb://127.0.0.1:27117/vg-drill-src-$TS?directConnection=true" \
  ADMIN_SEED_EMAIL="drill-admin-$TS@fixture.test" ADMIN_SEED_PASSWORD="<ngẫu nhiên, không in>" pnpm --filter be db:seed
target: 127.0.0.1:27117/vg-drill-src-1792490163
seed: ensured resource admin
seed-dev: upserted client fe-sso-test / resource demo / resource other
seed: ensured super_admin <id> <drill-admin-1792490163@fixture.test>
seed: ensured client fe-admin
fe-admin client_secret (shown once): <REDACTED>
exit=0 (7,8 s)
```
Chèn 1 RT giả (`tokenHash` giả, `familyId: drill-fam-$TS`, `expiresAt` +1 ngày) ⇒ `active RT in src: 1`.

Ảnh chụp nguồn trước backup (count / số index): auditlogs 0/6, clientcredentials 1/2, clients 2/4,
consents 0/2, emailverificationtokens 0/3, federatedidentities 0/3, passwordresettokens 0/3,
refreshtokens 1/6, resources 3/2, tenants 1/2, users 1/2, usertenants 1/2 (12 collection, 10 doc).

**B2 — backup** (09:56:52):
```
$ docker exec vg-test-mongo mongodump --db=vg-drill-src-$TS --archive=/tmp/vg-drill-$TS.gz --gzip
done dumping …tenants (1) …clients (2) …usertenants (1) …users (1) …clientcredentials (1) …resources (3)
…refreshtokens (1) …federatedidentities/passwordresettokens/emailverificationtokens/consents/auditlogs (0)
exit=0 (0,6 s); archive 2371 byte trong container
$ docker exec vg-test-mongo mongorestore --archive=… --gzip --dryRun --verbose
archive prelude × 12 collection … dry run completed / 0 document(s) restored successfully   # không đếm doc ⇒ L2
```

**B3 — thay đổi sau backup** (09:57:09): `$set {familyRevokedAt, revokedAt}` cho RT giả ở nguồn ⇒
`matched 1 modified 1 | active RT in src: 0`; `dst exists before restore: false`.

**B4 — restore sang DB mới (không `--drop`)**:
```
$ docker exec vg-test-mongo mongorestore --archive=/tmp/vg-drill-$TS.gz --gzip --nsFrom="vg-drill-src-$TS.*" --nsTo="vg-drill-dst-$TS.*"
10 document(s) restored successfully. 0 document(s) failed to restore.     exit=0 (2,6 s)
```

**B5 — so sánh + bất biến (i)** (09:57:25):
```
src(pre-backup) vs dst: counts + index names IDENTICAL          # 12 collection, cùng count, cùng tên index
dst fake RT revokedAt: ABSENT (alive again) | familyRevokedAt: ABSENT | expiresAt>now: true
dst active RT before 4c: 1
# runbook §4c bản 2026-10-20 (2 updateMany trên `db` trần, stamp trước) — bản qua `d` diễn tập lại ở B8
4c familyRevokedAt modified 1 | revokedAt modified 1
dst active RT after 4c: 0
```
⇒ Chứng minh F4(i): RT bị thu hồi ở nguồn SAU điểm backup **sống lại** ở DB restore; bước §4c vô hiệu nó.
(Hành vi `/token` với RT đã thu hồi kiểu này = `invalid_grant`, không reuse burst — đã khoá ở spec §4(i).)

**B6 — `db:sync-indexes` trên dst** (09:57:36): kiểm khô `target: 127.0.0.1:27117/vg-drill-dst-1792490163`
khớp ⇒ chạy:
```
$ NODE_ENV=test MONGO_URI="mongodb://127.0.0.1:27117/vg-drill-dst-$TS?directConnection=true" pnpm --filter be db:sync-indexes
target: 127.0.0.1:27117/vg-drill-dst-1792490163
User/FederatedIdentity/Tenant/UserTenant/Client/ClientCredential/Resource/Consent/RefreshToken/
PasswordResetToken/EmailVerificationToken/AuditLog: synced          # không model nào "dropped [...]"
exit=0 (2,0 s)
dst indexes before/after sync IDENTICAL (nothing dropped/created)
```

**B7 — dọn** (09:57:47):
```
regex /^vg-drill-(src|dst)-\d+$/ + có trong listDatabases ⇒ drop
drop vg-drill-src-1792490163 {"ok":1}   drop vg-drill-dst-1792490163 {"ok":1}
remaining vg-drill-*: []
$ docker exec vg-test-mongo rm -f /tmp/vg-drill-$TS.gz ; ls /tmp  ⇒ chỉ còn mongodb-27017.sock
```
Sau `test:int` FULL: `listDatabases` lọc `^vg-(drill|int-runbook)` = `[]`; không còn tiến trình node/jest do
tester khởi động.

**B8 — nghiệm thu 2026-10-21: chạy lại §4c sau retry 1/2 (qua `d = db.getSiblingDB(...)` + guard DB tồn tại)**
(`TS=1792569980`, 08:03–08:05 UTC). Xác nhận đích trước: `docker inspect vg-test-mongo` = image `mongo:7`,
cổng host 27117; `listDatabases` lọc `^vg-drill` = `[]`. Khối JS lấy **nguyên văn từ `runbook-ops.md` §4c**
(sed trích khối ```js```), chỉ thay `<db_mới>`. Mô phỏng đúng tình huống prod: mongosh mở bằng URI của DB
"cũ/đang chạy" `vg-drill-src-$TS` (2 RT sống), `d` = `vg-drill-dst-$TS` (3 RT sống + 1 RT đã thu hồi từ trước).
```
DB: vg-drill-dst-1792569980        active RT: 0        tổng RT: 4        exit=0
src active (phải giữ 2): 2 | src familyRevokedAt null: 2 | dst active: 0 | dst RT thu hồi từ trước giữ stamp cũ: 1
# gõ sai tên: <db_mới> = vg-drill-dst-typo-$TS
DB: vg-drill-dst-typo-1792569980
Error: DB không tồn tại: vg-drill-dst-typo-1792569980        exit=1 (không tạo DB typo, không ghi gì)
```
⇒ §4c bản mới chỉ ghi vào `<db_mới>`, DB mở kết nối (`db`) không bị đụng; guard chặn tên sai (hết `0` giả).
Dọn: regex `^vg-drill-(src|dst)-1792569980$` ∩ `listDatabases` ⇒ drop đúng 2 DB `{"ok":1}`; còn lại `[]`.
Đánh số §4b sau retry 2 (1 scale 0 → 2 restore → 3 so số liệu → 4 chỉ 4c → 5 kiểm khô + sync-indexes →
6 trỏ app chưa mở traffic → 7 checklist 4d): các tham chiếu trong report (L1 §4b-5, L2 §4b-2/§4b-3) vẫn đúng.

## Lệch runbook ↔ thực tế (đã sửa văn bản `runbook-ops.md`)

| # | Lệch | Sửa |
|---|---|---|
| L1 | §3c/§4b-5 bảo "kiểm `target:` TRƯỚC khi để chạy tiếp / Ctrl-C ngay": CLI in `target:` rồi kết nối + ghi ngay trong cùng tiến trình (không có điểm chờ/xác nhận) ⇒ không người nào kịp dừng; gõ sai tên biến rơi về `localhost:27017/sso-idp` (B0) | §0 thêm lệnh **kiểm khô đích** (`node --env-file-if-exists=.env -e "…mongoTarget(process.env.MONGO_URI)"`, không kết nối); §3c, §4b-5 trỏ về đó, `target:` của lệnh thật chỉ để ghi biên bản. Code: DEBT-256 |
| L2 | §4a: `--dryRun` "liệt kê collection" nhưng in `0 document(s) restored` — không cho số liệu; §4b-3 "ghi lúc backup" không nói ghi ở đâu | §4a: lưu stderr mongodump (`done dumping … (N documents)`) làm số liệu nguồn; §4b-2 kỳ vọng `N document(s) restored … 0 failed` = tổng dump; §4b-3 thêm 1 lệnh mongosh in count + tên index; kiểm `<db_mới>` chưa tồn tại trước restore |
| L3 | §2 xác minh chỉ nêu `400 invalid_grant`; RT của client đã disable thực tế ra `401 invalid_client` (client auth thất bại trước); spec cũ chỉ assert `≥400` | §2 xác minh thêm `401 invalid_client`; spec siết `toBe(401)` + `error: invalid_client` (test, không đổi code sản phẩm) |
| L4 | §4: Git Bash đổi `/tmp/...` trong `docker exec` thành `C:/...`; bật `MSYS_NO_PATHCONV=1` thì `docker cp <host-path>` hỏng; file archive nằm trong container | §4a ghi chú Git Bash + chép archive ra nơi lưu mã hoá rồi `rm` trong container |
| L5 | §1 xác minh dùng `GET /admin/keys` nhưng `ADMIN_AT` vừa xoay cũng ký bằng oldKid ⇒ `401` | §1 xác minh: lấy AT mới bằng refresh (đủ cho `GET`, không cần step-up) |

Không lệch: §2 audit API rỗng (DEBT-140), §3 seed không reset mật khẩu/khoá, §3 production bị từ chối,
§4c không bắn reuse burst, `mongorestore --nsFrom/--nsTo` không cần `--drop`, `db:sync-indexes` sau restore
không drop index nào, công cụ có sẵn trong `mongo:7`.

## Risk matrix (kịch bản 4 + chung)

- State: backup cũ → RT thu hồi sau backup sống lại (B5) → §4c vô hiệu (B5) ; RT đã rotate trước backup → reuse thật (spec §4(i)).
- Request chain: refresh sau §4c → `invalid_grant` (spec); refresh client disable → `401 invalid_client` (spec §2).
- Input/target: biến sai tên → DB dev (B0, chỉ in, không kết nối); `NODE_ENV=production` → từ chối trước ghi (spec §3).
- Exposure: report/runbook không chứa PEM, cặp khoá-giá trị mật khẩu, URI có credential (grep âm F7 = 0); secret `fe-admin` che + file xoá; mật khẩu seed ngẫu nhiên không in.
- Blast radius: chỉ `vg-test-mongo`; drop chặn bởi regex + listDatabases; không `--drop`.

## Debt mới
- DEBT-256 🟡 — CLI DB không có chế độ kiểm khô/xác nhận đích (xem `backlog.md`).
