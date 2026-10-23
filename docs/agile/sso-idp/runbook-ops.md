# Runbook — Vận hành sự cố (sso-idp backend)

> File bền (B7.5, run 40). Bổ sung cho [runbook-deploy.md](runbook-deploy.md) — không chép lại:
> §1 `db:sync-indexes`, §3 Redis `noeviction`, §6 PEM mồ côi sau emergency rotate.
> Mọi lệnh/endpoint dưới đây tồn tại trong repo tại thời điểm viết; kịch bản 1–3 và bước §4(i)
> được khoá bằng `be/test/runbook-drill.int-spec.ts` (đổi hành vi ⇒ spec đỏ ⇒ sửa runbook).
> Không ghi secret/PII thật vào ticket, chat, log hay báo cáo: chỉ dùng placeholder `<...>`.

## 0. Chuẩn bị chung

- `IDP` = issuer (vd. `https://idp.example.com`); `ADMIN_AT` = access token `aud=<IDP>/admin` (resource
  `admin`) của user có vai trò phù hợp. Lấy qua authorization code + PKCE của một client admin-capable
  (confidential, `client_secret_basic`, vd. `fe-admin` do `db:seed` tạo). **Chưa có UI fe-admin**
  (A4–A6 chờ Q3) ⇒ người trực tự chạy luồng: trình duyệt mở `/authorize?...&prompt=login` (hoặc
  `max_age=0`) → lấy `code` → `curl -u <client_id>:<client_secret> -d grant_type=authorization_code ... $IDP/token`.
- **Step-up**: mọi thao tác ghi gắn `@RequireRecentAuth(5)` cần `auth_time` ≤ 5 phút. AT có được từ
  refresh grant KHÔNG có `auth_time` ⇒ luôn `403 {"error":"step_up_required","max_age":0}` ⇒ đăng nhập
  lại với `prompt=login`. Đọc (`GET`) chỉ cần `admin.read`, không cần step-up.
- Gọi admin API: `curl -sS -H "Authorization: Bearer $ADMIN_AT" [-H 'content-type: application/json' -d '<json>'] $IDP/<path>`.
- Truy vấn Mongo tay: `mongosh "<MONGO_URI>"` (URI đọc từ secret store; không dán vào ticket).
  Collection mặc định: `auditlogs`, `refreshtokens`, `users`, `usertenants`, `clients`,
  `clientcredentials`, `consents`, `resources`, `tenants`.
- **Kiểm đích Mongo TRƯỚC mọi CLI ghi** (`db:seed`, `db:sync-indexes`): CLI in `target: <host>/<db>` rồi
  kết nối và ghi **ngay trong vài ms** ⇒ không kịp Ctrl-C (diễn tập run 40). Chạy kiểm khô (không kết nối)
  trong `be/` (sau `pnpm --filter be build` — lệnh đọc `./dist`) với ĐÚNG các biến sẽ dùng, khớp mới chạy lệnh thật:
  `MONGO_URI='<uri>' node --env-file-if-exists=.env -e "console.log(require('./dist/database/mongo/sync-indexes.js').mongoTarget(process.env.MONGO_URI))"`
  (gõ sai tên biến ⇒ in đích của `be/.env`, vd. `target: localhost:27017/sso-idp` ⇒ DỪNG).
- Metric: `GET $IDP/metrics` cần `Authorization: Bearer <METRICS_TOKEN>` (route chỉ có khi đặt biến).
  Alert: `ops/prometheus/alerts.yml`.
- **Production vs dev (chung)**: chưa có KMS (Q5/B7.3). `KEY_PROVIDER=local` (`LocalKeyProvider`, thư
  mục `KEY_LOCAL_DIR`) là bản dev, **chỉ hỗ trợ 1 node** (DEBT-159). Mọi bước key cho production = **TBD B7.3**.

---

## 1. Key ký nghi bị lộ — emergency rotation

**Dấu hiệu**: private key/PEM xuất hiện ngoài hệ thống, host chứa `KEY_LOCAL_DIR` bị xâm nhập, token
lạ ký hợp lệ. Sau khi xoay: alert `SsoEmergencyKeyRotation`
(`sso_signing_key_rotations_total{mode="emergency",result="success"}`) bắn — đó là xác nhận, không phải sự cố mới.

**Quyết định**
- Nghi lộ ⇒ **emergency** (key cũ rời JWKS ngay). Xoay định kỳ ⇒ `{"mode":"normal"}` (key cũ verify-only thêm `ACCESS_TOKEN_TTL`).
- Emergency **KHÔNG thu hồi session Redis và refresh token**. Nếu nghi lộ kèm xâm nhập host/đánh cắp
  phiên ⇒ người trực cân nhắc thêm các bước thu hồi ở §2 (theo user/client) hoặc §4(i) (toàn bộ RT,
  DEBT-251). Không mặc định.

**Các bước** (super_admin + `admin.write` + step-up)
1. Đăng nhập lại (`prompt=login`) lấy `ADMIN_AT` mới (auth_time ≤ 5').
2. Ghi lại kid hiện tại: `GET /admin/keys` → `items[].{kid,status}` (`status:"active"` = kid sắp bị thay).
3. `POST /admin/keys/rotate` body `{"mode":"emergency"}` → `200 {"newKid","oldKid","mode":"emergency"}`.
   - `403 step_up_required` ⇒ quay lại bước 1. `403 forbidden` ⇒ không phải super_admin.
   - **Không idempotent (DEBT-158)**: 5xx/timeout ⇒ **KHÔNG gọi lại mù**. Kiểm trước:
     `GET /admin/keys` (kid active đã khác kid ở bước 2 chưa?) và
     `GET /admin/audit?action=SIGNING_KEY_ROTATED` (event `result:"success"`, `targetId`=newKid,
     `metadata.mode`, `metadata.oldKid`). Đã xoay ⇒ dừng; chưa ⇒ mới gọi lại. Một lần xoay thừa
     không phá gì nhưng làm AT mới ký bằng key vừa tạo cũng chết.
4. Dev `LocalKeyProvider`: làm theo [runbook-deploy §6](runbook-deploy.md#6-sau-emergency-rotate--kiểm-key_local_dir-debt-163-dev-localkeyprovider)
   (PEM mồ côi; chỉ xoá đúng `<oldKid>.pem`).
5. Báo các RP xoá cache JWKS / refetch `/.well-known/openid-configuration` + `/jwks.json` (DEBT-157): RP cache JWKS lâu sẽ từ chối AT mới
   (kid lạ) hoặc — tệ hơn — vẫn chấp nhận AT ký bằng key đã lộ nếu tự verify bằng cache.

**Xác minh** (kỳ vọng cụ thể)
- `ADMIN_AT` vừa dùng để xoay cũng ký bằng `oldKid` ⇒ giờ `401`. Đọc kiểm tra bằng AT mới: refresh RT
  admin (`grant_type=refresh_token`) là đủ cho `GET` (`admin.read` không cần step-up).
- `curl -sS $IDP/jwks.json` → `keys[].kid` chỉ có `newKid` (không còn `oldKid` hay key `retiring` nào).
- AT/ID token cũ: admin API → `401 invalid_token`; RP verify theo JWKS → fail.
- Refresh vẫn chạy: `POST /token grant_type=refresh_token` → `200`, AT mới có header `kid = newKid`.
- `GET /admin/keys` → đúng 1 item `{kid:newKid,status:"active"}`.

**Rollback**: **KHÔNG có**. Key cũ đã bị xoá khỏi state, không đưa lại JWKS. Người dùng/RP chỉ cần
đăng nhập lại hoặc refresh.

**Production**: TBD B7.3 (KMS/Vault chưa chốt — Q5). Không có lệnh production ở đây.

---

## 2. `TOKEN_REUSE_DETECTED` tăng đột biến

**Dấu hiệu**: alert `SsoTokenReuseDetected` — `sum(increase(sso_audit_events_total{action="TOKEN_REUSE_DETECTED",result="failure"}[5m])) > 0`.
Metric KHÔNG có nhãn client/user (chủ đích) ⇒ phân loại bằng Mongo bên dưới.

> ⚠ Từ run 48, `GET /admin/audit?action=TOKEN_REUSE_DETECTED` hiện event cho admin của **tenant sở hữu
> client** (`tenantId = client.tenantId`); admin tenant khác thấy rỗng. Các event OAuth/auth khác vẫn chưa
> gắn tenant (DEBT-140) ⇒ không kết luận "không có sự cố" chỉ từ API này; mongosh bên dưới là nguồn đầy đủ.

**Điều tra (mongosh, CHỈ ĐỌC)**
```js
// 1. Sự kiện mới nhất: clientId + metadata.familyId + metadata.count (số RT vừa bị thu hồi)
db.auditlogs.find({ action: 'TOKEN_REUSE_DETECTED' },
  { timestamp: 1, clientId: 1, 'metadata.familyId': 1, 'metadata.count': 1, requestId: 1 })
  .sort({ timestamp: -1 }).limit(50);
// 2. Phân bố theo client trong 1h (đột biến tập trung 1 client => client/RP đó có vấn đề)
db.auditlogs.aggregate([
  { $match: { action: 'TOKEN_REUSE_DETECTED', timestamp: { $gte: new Date(Date.now() - 3600e3) } } },
  { $group: { _id: '$clientId', n: { $sum: 1 } } }, { $sort: { n: -1 } } ]);
// 3. Family -> chủ sở hữu
db.refreshtokens.findOne({ familyId: '<familyId>' }, { userId: 1, clientId: 1 });
```
- **Lẻ tẻ** (1–2 event, 1 client, rải rác): thường RP retry/race khi refresh song song hoặc bug lưu RT
  ⇒ báo chủ RP, theo dõi.
- **Đột biến** (nhiều family, nhiều user, cùng client hoặc cùng dải thời gian ngắn): nghi RT bị đánh
  cắp hàng loạt (lộ storage của RP, lộ DB/backup) ⇒ xử lý như sự cố bảo mật.
- Không chép `tokenHash`, IP, email, userAgent thật vào ticket/báo cáo — chỉ id/placeholder.

**Hành động** (family bị reuse **đã tự thu hồi**; các bước dưới là bổ sung; ghi = `admin.write` + step-up)
- Theo user (`<userId>` từ bước 3; tra bằng email: `GET /admin/users?email=<email>`):
  - Toàn bộ phiên + RT: `POST /admin/users/<userId>/sessions/revoke` → `204`.
  - Một family: `GET /admin/users/<userId>/families` → `POST /admin/users/<userId>/families/<familyId>/revoke` → `204`.
  - Khoá tài khoản (lock + thu hồi mọi phiên/RT): `POST /admin/users/<userId>/lock` → `200`.
    tenant_admin không được chạm user có vai trò admin/ở tenant khác (403) ⇒ cần super_admin.
- Theo client nghi lộ:
  - `PATCH /admin/clients/<clientId>` body `{"disabled":true}` (gửi riêng, không kèm field khác) → `200`:
    client coi như không tồn tại ở mọi endpoint và **mọi RT của client bị thu hồi** (DEBT-125).
    Không disable được client đang phát `ADMIN_AT` của chính bạn (`409`).
  - Xoay secret: `POST /admin/clients/<clientId>/secrets` (secret mới chỉ hiện 1 lần trong response; bản
    cũ còn hiệu lực `CLIENT_SECRET_GRACE_TTL`) → thu hồi bản cũ ngay: `GET /admin/clients/<clientId>/secrets`
    → `DELETE /admin/clients/<clientId>/secrets/<version>` → `204`. Thu hồi secret KHÔNG thu hồi token đã phát.
  - Không có cách thu hồi mọi family của 1 client mà không disable (DEBT-251).

**Xác minh**
- `db.refreshtokens.countDocuments({ clientId: '<clientId>', revokedAt: null })` → `0` sau disable.
- Refresh bằng RT của user/family đã thu hồi → `400 invalid_grant`; RT của client đã disable →
  `401 invalid_client` (xác thực client thất bại trước khi xét RT).
- Admin action có trong `GET /admin/audit?action=<một giá trị>` — API so khớp chính xác (enum), gọi **riêng
  từng** giá trị: `SESSION_REVOKED`, `TOKEN_REVOKED`, `ADMIN_USER_LOCKED`, `ADMIN_CLIENT_UPDATED`,
  `CLIENT_SECRET_REVOKED` (không ghép `A|B`: nhận 400). Các event admin có tenantId nên thấy được.

**Rollback**: bật lại client `PATCH {"disabled":false}` (RT cũ KHÔNG sống lại — người dùng đăng nhập
lại); mở khoá `POST /admin/users/<userId>/unlock`. Phiên/RT đã thu hồi không khôi phục được.

**Production vs dev**: như nhau (không phụ thuộc KMS).

---

## 3. Quên mật khẩu / mất admin / không còn super_admin

**Dấu hiệu**: admin API trả `403 forbidden` cho mọi người (0 super_admin/không còn membership admin
active); admin bị khoá (`lockedUntil`); quên mật khẩu.

**Quyết định**
- Còn admin khác ⇒ dùng admin API (unlock, roles). Không còn ai ⇒ dev/test: `db:seed`; production: break-glass.
- Mật khẩu: **không có endpoint admin đặt lại mật khẩu** ⇒ chỉ tự phục vụ `/forgot` → email → `/reset`.

**3a. Khoá tài khoản**
- Khoá do sai mật khẩu: `lockedUntil` tự hết hạn; hoặc `/reset` thành công cũng gỡ khoá này.
- Khoá do admin (`lockedUntil = 9999-12-31T23:59:59.999Z`): `/reset` **không** gỡ; cần
  `POST /admin/users/<userId>/unlock` (admin khác, `admin.write` + step-up) → `200`.

**3b. Mật khẩu**: người dùng mở `$IDP/forgot` → nhập email → link trong email → `$IDP/reset`. Reset
thu hồi mọi phiên + RT của user (chủ đích).

**3c. Khôi phục super_admin — CHỈ dev/test (`db:seed`)**
> ⛔ CẤM dùng với URI production, dù đặt `NODE_ENV` gì: guard của seed chỉ dựa vào `NODE_ENV` (DEBT-164),
> nên `NODE_ENV=test` + URI prod là **vượt guard**. Production ⇒ §3d break-glass.
```bash
pnpm --filter be build
NODE_ENV=test MONGO_URI='<uri>' ADMIN_SEED_EMAIL='<email>' ADMIN_SEED_PASSWORD='<tạm>' pnpm --filter be db:seed
```
- **Trước khi chạy**: kiểm khô đích theo §0 (script nạp `be/.env` nếu không truyền biến; gõ sai tên
  biến ⇒ rơi về DB dev). Lệnh thật in lại `target: <host>/<db>` (đã bỏ credential) — ghi vào biên bản;
  nó KHÔNG phải điểm dừng (kết nối/ghi bắt đầu ngay sau đó).
- `NODE_ENV` khác `development|test` ⇒ từ chối trước khi kết nối:
  `seed-dev: refusing to run with NODE_ENV=production (only development|test; never production)` (DEBT-164).
- User đã tồn tại: seed **không đổi mật khẩu, không gỡ khoá, không reset `failedLoginCount`**
  (`$setOnInsert`); chỉ đặt membership `default-tenant` `status:'active'` + thêm `super_admin`.
  ⇒ Sau seed vẫn đăng nhập bằng **mật khẩu cũ**; nếu đang khoá thì làm 3a/3d trước.
- Lần đầu tạo `fe-admin`, seed in `fe-admin client_secret (shown once): ...` ra stdout ⇒ chép thẳng
  vào secret store, **không** dán vào ticket/log/chat.
- Lỗi guard và cách xử:
  - `seed: refusing to point resource 'admin' at <id>: it already exists with identifier <other>` ⇒
    resource `admin` trỏ issuer khác: sửa/xoá resource đó (và client tham chiếu) rồi chạy lại.
  - `seed: refusing to point resource 'admin' at <id>: client <clientId> already references it` ⇒ gỡ
    `admin` khỏi `allowedResources` của client đó (hoặc xoá client) rồi chạy lại.
  - `seed: ensuring the <Model> indexes failed (<code>)` ⇒ có dữ liệu trùng: dọn rồi `db:sync-indexes` (deploy §1/§2).
  - `seed: invalid admin environment: ...` ⇒ thiếu/sai `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` (12–128 ký tự).

**3d. Production — break-glass (KHÔNG có công cụ được hỗ trợ, DEBT-252)**
- 2 người (thực hiện + chứng kiến), biên bản ngoài hệ thống (thời gian, người, lý do, lệnh) vì **không
  sinh audit event**. Tương đương bước 3 của seed, trên đúng 1 user đã tồn tại:
  Mọi lệnh ghi qua `d` (không dùng `db` trần); người chứng kiến đọc to dòng `DB:` trước khi chạy tiếp.
  Dán từng khối; khối nào `throw` thì DỪNG, không sửa tay rồi chạy tiếp:
```js
const d = db.getSiblingDB('<db_production>'); print('DB:', d.getName());   // phải = DB app production đang dùng
const u = d.users.findOne({ email: '<email-chuẩn-hoá-chữ-thường>' }, { _id: 1 });
if (!u) throw new Error('không thấy user');                                   // KHÔNG tạo user bằng tay
const r1 = d.usertenants.updateOne({ userId: u._id, tenantId: 'default-tenant' },
  { $set: { status: 'active' }, $addToSet: { roles: 'super_admin' } });
if (r1.matchedCount !== 1) throw new Error('membership default-tenant: matchedCount=' + r1.matchedCount);
```
```js
// chỉ khi đang khoá và không còn admin nào để gọi /unlock (cùng phiên mongosh, `d`/`u` ở trên):
const r2 = d.users.updateOne({ _id: u._id }, { $unset: { lockedUntil: 1 }, $set: { failedLoginCount: 0 } });
if (r2.matchedCount !== 1) throw new Error('users: matchedCount=' + r2.matchedCount);
```

**Xác minh**
- `d.usertenants.countDocuments({ roles: 'super_admin', status: 'active' })` ≥ 1 (cùng `d`).
- Đăng nhập (`prompt=login`) → `ADMIN_AT` → `GET /admin/keys` → `200` (chỉ super_admin mới được).
- Sau đó đổi mật khẩu qua `/forgot` nếu nghi lộ; xem lại `GET /admin/users` để gỡ quyền thừa.

**Rollback**: gỡ vai trò bằng `PATCH /admin/users/<userId>/roles` (super_admin, step-up; không tự sửa chính mình).

---

## 4. Backup / restore MongoDB

**Phạm vi**: chỉ Mongo. Redis (session, authorize-context, tombstone, one-time code) là trạng thái tạm,
**không backup**: mất Redis ⇒ người dùng đăng nhập lại; cấu hình theo [runbook-deploy §3](runbook-deploy.md#3-redis--maxmemory-policy-noeviction-debt-049).
Signing key (`KEY_LOCAL_DIR`/KMS) KHÔNG nằm trong Mongo (INV-19) — backup riêng theo B7.3.

**Công cụ**: image `mongo:7` có sẵn `mongodump`/`mongorestore`/`mongosh` ⇒ chạy qua `docker exec <container-mongo> ...`
hoặc máy có database-tools; không cài thêm.

**Chính sách** (lịch, RPO/RTO, PITR/oplog, nơi lưu, retention): **chưa quyết — DEBT-253 / Q5**. Tối thiểu:
backup chứa hash mật khẩu, hash secret client, RT hash, PII ⇒ **mã hoá khi lưu** (vd. `gpg --symmetric`/KMS),
quyền đọc giới hạn như DB production, xoá theo retention, không để trong `/tmp` lâu.

**4a. Backup**
```bash
mongodump --uri='<MONGO_URI>' --db=<db> --archive=<file>.gz --gzip 2> <file>.dump.log
# số liệu nguồn = các dòng "done dumping <db>.<coll> (N documents)" trong <file>.dump.log => lưu cùng backup
# xác minh: mongorestore --archive=<file>.gz --gzip --dryRun --verbose  (đọc được, liệt kê collection;
#   in "0 document(s) restored" — dryRun KHÔNG đếm document, số liệu lấy từ dump.log)
```
- Qua container (`docker exec <container-mongo> mongodump ... --archive=/tmp/<file>.gz`) file nằm TRONG
  container: chép ra nơi lưu đã mã hoá rồi `docker exec <container-mongo> rm /tmp/<file>.gz`.
- Git Bash (Windows): đặt `MSYS_NO_PATHCONV=1` cho các lệnh `docker exec ... /tmp/...`, nếu không đường
  dẫn bị đổi thành `C:/...`; ngược lại `docker cp <đường-dẫn-host>` lại hỏng khi biến này bật.

**4b. Restore (luôn vào DB MỚI, không `--drop` lên DB đang chạy)**
1. Dừng ghi: scale app về 0 (hoặc dừng tiến trình) — tránh client ghi vào DB cũ trong lúc chuyển.
2. Kiểm `<db_mới>` chưa tồn tại (`db.adminCommand({listDatabases:1,nameOnly:true})`), rồi
   `mongorestore --uri='<MONGO_URI_không_db>' --archive=<file>.gz --gzip --nsFrom='<db>.*' --nsTo='<db_mới>.*'`
   → dòng cuối `N document(s) restored successfully. 0 document(s) failed` với N = tổng số trong dump.log.
3. So số liệu: mỗi collection `countDocuments()` của `<db_mới>` khớp dump.log; `getIndexes()` cùng tên
   index như nguồn. Một lệnh in cả hai (so với bản chạy trên nguồn lúc backup, nếu có):
   `const d=db.getSiblingDB('<db_mới>'); d.getCollectionNames().sort().forEach(c=>print(c, d[c].countDocuments(), d[c].getIndexes().map(i=>i.name).sort().join(',')))`
4. **Bắt buộc — thu hồi toàn bộ RT (4c)** trên `<db_mới>`, app vẫn tắt (mongosh: mọi lệnh ghi qua
   `const d = db.getSiblingDB('<db_mới>')`, không qua `db` trần). **Chưa làm 4d** — 4d cần admin API.
5. Kiểm khô đích (§0) = `<db_mới>`, rồi `MONGO_URI='<uri tới db_mới>' pnpm --filter be db:sync-indexes`
   → dòng `target:` = `<db_mới>`, mỗi model `<Model>: synced` (không có `dropped [...]`), exit 0; xác minh như [runbook-deploy §1 + 2c](runbook-deploy.md#1-đồng-bộ-index-mongo-dbsync-indexes).
6. Trỏ app sang `<db_mới>`, rollout, nhưng **CHƯA mở traffic người dùng** (bước vận hành, tuỳ hạ tầng
   triển khai — repo không có cấu hình ingress/LB: vd. giữ route công khai/ingress đóng hoặc chưa đưa
   instance vào LB, chỉ người trực gọi được `$IDP/admin/...` và `/authorize`+`/token` để lấy `ADMIN_AT`
   theo §0). Hạ tầng không cho chặn ⇒ ghi rõ khoảng hở vào biên bản và làm bước 7 **ngay**, ưu tiên
   disable client → gỡ role/suspend → lock user trước.
7. **Checklist 4d** qua admin API trên app ĐÃ trỏ `<db_mới>`; xác minh từng mục bằng `GET` tương ứng
   (`GET /admin/clients/<id>` ⇒ `disabled:true`; `GET .../secrets` ⇒ version đã thu hồi có
   `status:"revoked"`; `GET /admin/users/<id>` ⇒ `roles`/`membershipStatus`/`locked:true` đúng;
   `GET /admin/users/<id>/consents` ⇒ consent đã thu hồi không còn trong danh sách). Đủ mục ⇒ mới mở traffic người dùng, theo dõi alert. Giữ DB cũ (nếu còn) chỉ-đọc
   tới khi xác nhận xong.

**4c. Bất biến (i) — RT đã rotate/thu hồi sau điểm backup SỐNG LẠI** (kể cả family đã bị reuse-revoke)
⇒ ai giữ bản RT cũ (kẻ trộm) lại dùng được. Thu hồi toàn bộ (cùng 2 update như `RefreshTokenService.revokeWhere`, stamp trước).
**Chỉ chạy qua `d`** — KHÔNG dùng `db` trần: mongosh mở bằng URI production thì `db` là DB **đang chạy/cũ**
(thu hồi nhầm ⇒ đăng xuất hàng loạt, còn `<db_mới>` giữ RT sống lại và lệnh đếm cho `0` giả).
Dán nguyên khối; nó dừng nếu `<db_mới>` không tồn tại (gõ sai tên ⇒ DB rỗng ⇒ cũng cho `0` giả):
```js
const d = db.getSiblingDB('<db_mới>'); print('DB:', d.getName());   // người chứng kiến đọc to: phải = <db_mới>
if (!db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.some((x) => x.name === d.getName())) throw new Error('DB không tồn tại: ' + d.getName());
const now = new Date();
d.refreshtokens.updateMany({ familyRevokedAt: null }, { $set: { familyRevokedAt: now } });
d.refreshtokens.updateMany({ revokedAt: null }, { $set: { revokedAt: now } });
print('active RT:', d.refreshtokens.countDocuments({ revokedAt: null }));   // kỳ vọng 0
print('tổng RT:', d.refreshtokens.countDocuments());                         // > 0 nếu dump có RT (đối chiếu dump.log)
```
- Hậu quả: mọi RP phải đăng nhập lại (refresh → `400 invalid_grant`); session Redis vẫn còn nên đăng
  nhập lại thường không cần mật khẩu. Alert `SsoTokenErrorRatioHigh` có thể bắn — dự kiến.
- **KHÔNG bắn `TOKEN_REUSE_DETECTED` hàng loạt**: RT bị thu hồi kiểu này không có `replacedBy` ⇒ dùng lại
  = `invalid_grant` thường. Chỉ RT **đã rotate trước điểm backup** (bản sao bị đánh cắp) mới kích hoạt
  reuse ⇒ `SsoTokenReuseDetected` sau restore = tín hiệu thật, điều tra theo §2.
- Không có lệnh/endpoint "revoke all" có audit (DEBT-251) ⇒ ghi biên bản.

**4d. Bất biến (ii) — checklist áp lại thay đổi bảo mật sau điểm backup** (audit trong DB cũng bị lùi ⇒
lấy nguồn từ log ứng dụng, ticket, alert, ghi chép sự cố):
**CHỈ chạy sau khi app trỏ `<db_mới>` (§4b bước 6–7)** — gọi trên app còn trỏ DB cũ thì API vẫn trả
`200` nhưng thay đổi ghi vào DB cũ và **mất im lặng** khi chuyển (client/role đã thu hồi sống lại).
- [ ] client bị disable (`PATCH /admin/clients/<id> {"disabled":true}`)
- [ ] secret client bị thu hồi/xoay (`DELETE .../secrets/<version>`, `POST .../secrets`) — secret xoay sau backup không có trong DB: phát lại và giao cho RP
- [ ] vai trò bị gỡ (`PATCH /admin/users/<id>/roles`), membership bị suspend
- [ ] user bị khoá (`POST /admin/users/<id>/lock`), consent bị thu hồi (`DELETE /admin/users/<id>/consents/<consentId>`)
- [ ] mật khẩu đã đổi sau backup trở về hash cũ ⇒ báo user liên quan dùng `/forgot`
- [ ] signing key: không bị ảnh hưởng (không ở Mongo); nếu sự cố gốc là lộ key ⇒ §1
- [ ] user/client/resource tạo sau backup bị mất ⇒ tạo lại theo ticket

**Rollback**: trỏ app lại DB cũ (nếu còn nguyên vẹn) — chỉ khi DB mới sai; RT đã thu hồi trên DB mới
không ảnh hưởng DB cũ.

**Production vs dev**: lệnh như nhau; chính sách/lưu trữ/mã hoá production chờ DEBT-253.
Diễn tập: `runs/40-B7.5/drill-report.md` (tester, `vg-test-mongo`, DB `vg-drill-*`).
