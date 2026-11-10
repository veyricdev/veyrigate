# Runbook — Deploy (sso-idp backend)

> File bền (không nằm trong thư mục run). Ghi các bước vận hành bắt buộc khi deploy,
> đặc biệt khi schema/index thay đổi. Mọi bước **fail-closed**: nếu một bước lỗi, **dừng
> deploy** và xử lý thủ công theo đúng mục dưới — KHÔNG tự xoá dữ liệu người dùng.

## 1. Đồng bộ index Mongo (`db:sync-indexes`)

`syncIndexes()` **build** index còn thiếu và **drop** index không còn khai báo trong schema.
Lệnh:

```bash
pnpm --filter be build          # cần dist/ để chạy CLI (CJS)
pnpm --filter be db:sync-indexes
```

CLI đọc `MONGO_URI` từ env (`--env-file-if-exists=.env`), chạy `syncAllIndexes` cho mọi model
trong `be/src/database/mongo/models.ts`, in ra index đã drop theo từng model, rồi thoát.
Lỗi bất kỳ ⇒ exit code 1 (deploy dừng).

**Run 28 (B6.3b) — index audit mới.** `AuditLog` thêm index ghép
`{tenantId: 1, timestamp: -1, eventId: -1}` (`tenantId_1_timestamp_-1_eventId_-1`) cho
`GET /admin/audit`. Không unique ⇒ không cần dọn dữ liệu trước; chỉ cần chạy
`db:sync-indexes` như trên (build index trên collection lớn có thể mất thời gian — chạy trước
rollout). Xác minh: `db.auditlogs.getIndexes()` có đúng key trên.

**Run 57 (DEBT-422) — thay index audit.** `GET /admin/audit` sắp theo `(timestamp desc, _id desc)`;
index ghép đổi thành `{tenantId: 1, timestamp: -1, _id: -1}`. `db:sync-indexes` build index mới và
**drop** `tenantId_1_timestamp_-1_eventId_-1`. Chạy trước rollout (prod `autoIndex:false`); thiếu index
thì kết quả vẫn đúng, chỉ chậm hơn. Cursor `after` phát hành trước deploy (`{t, e}`) trả 400
`invalid_request` — fe-admin hiện nút "First page". Xác minh: `getIndexes()` có key mới, không còn key cũ.

**Run 71 (DEBT-344) — thời hạn lưu audit (TTL).** Index `timestamp_1` của `auditlogs` thành TTL
`expireAfterSeconds = AUDIT_RETENTION_DAYS × 86400` (mặc định 180 ngày = `15552000`; khoảng 30–3650).
- `db:sync-indexes` đổi TTL **tại chỗ** bằng `collMod` (không drop/rebuild, không có cửa sổ thiếu index)
  trước `syncIndexes()`; output phải là `AuditLog: synced` (không có `dropped [timestamp_1]`). `collMod`
  lỗi ⇒ exit 1, KHÔNG fallback drop/recreate. Quyền: `collMod` thuộc `dbAdmin` (như createIndex/dropIndex).
- ⚠ **Lần chạy đầu XOÁ VĨNH VIỄN mọi event cũ hơn N ngày — không hoàn tác.** Có nghĩa vụ lưu giữ
  (pháp lý/hợp đồng) ⇒ **export trước** (vd. `mongoexport --collection auditlogs --query
  '{"timestamp":{"$lt":{"$date":"<now - N ngày>"}}}'`) và lưu nơi có retention riêng.
- TTL monitor của Mongo chạy ~60 s/lần và xoá theo lô ⇒ lần đầu trên collection lớn tốn I/O: chạy giờ
  thấp điểm, theo dõi tải.
- Xác minh: `db.auditlogs.getIndexes()` có `{ key: { timestamp: 1 }, name: 'timestamp_1',
  expireAfterSeconds: <N × 86400> }`; index cursor run 57 còn nguyên.
- **Đổi `AUDIT_RETENTION_DAYS` chỉ có hiệu lực sau khi chạy lại `db:sync-indexes`** (prod `autoIndex:false`;
  app không tự đổi index). Rút ngắn N ⇒ lại xoá vĩnh viễn phần vượt ngưỡng.
- Dev `sso-idp`: người dùng tự chạy `pnpm -C be db:sync-indexes` (cũng trước `db:seed`: seed chỉ
  `createIndexes`, gặp `timestamp_1` cũ không TTL sẽ lỗi IndexOptionsConflict).

## 2. Di trú index `Consent` M3→M4 (DEBT-028)

**Bối cảnh.** Q1 đổi khoá consent từ `{userId, clientId}` sang
`{userId, clientId, resource}` (unique). Môi trường đã deploy trước đó mang index cũ
`{userId, clientId}`; schema hiện tại khai `{userId, clientId, resource}` unique
(`be/src/modules/oauth/consent/schemas/consent.schema.ts`). `db:sync-indexes` sẽ:

- **drop** `userId_1_clientId_1` (index cũ, không còn khai báo), và
- **build** `userId_1_clientId_1_resource_1` unique (index mới).

### 2a. Backfill `resource` TRƯỚC khi sync (bắt buộc)

Doc consent cũ **không có field `resource`**. Unique index coi `resource` thiếu là `null`,
khác với sentinel `''` mà service dùng (`ConsentService.normalizeResource` map `undefined → ''`).
Nếu không backfill, lookup `find()`/`isCovered()` theo `resource:''` sẽ KHÔNG thấy doc cũ ⇒
ép re-consent (fail-closed nhưng gây UX xấu). Chạy backfill trước khi sync:

```js
// mongosh <MONGO_URI>
db.consents.updateMany({ resource: { $exists: false } }, { $set: { resource: '' } });
```

### 2b. Kiểm duplicate theo khoá mới TRƯỚC khi build unique index (bắt buộc)

Dữ liệu cũ có thể có >1 doc trùng `{userId, clientId, resource}` (sau backfill) ⇒ build unique
index sẽ **FAIL (E11000)**. `syncAllIndexes` fail-closed: ném lỗi, **không** xoá doc nào.
Kiểm trước:

```js
// mongosh <MONGO_URI> — liệt kê nhóm vi phạm (count > 1) theo khoá mới
db.consents.aggregate([
  { $group: {
      _id: { userId: '$userId', clientId: '$clientId', resource: { $ifNull: ['$resource', ''] } },
      count: { $sum: 1 },
      ids: { $push: '$_id' },
  } },
  { $match: { count: { $gt: 1 } } },
]);
```

- Kết quả rỗng ⇒ an toàn, chạy `db:sync-indexes`.
- Có nhóm `count > 1` ⇒ **DỪNG**. Hợp nhất thủ công (giữ doc có `grantedScopes` hợp nhất /
  `updatedAt` mới nhất, revoke/xoá doc dư) theo chính sách sản phẩm. **KHÔNG** để script tự xoá.
  Sau khi dọn, chạy lại 2b rồi mới sync.

#### Nếu `db:sync-indexes` đã chạy và FAIL E11000 (phục hồi)

`syncIndexes()` (mongoose 9) **drop index cũ TRƯỚC** khi build index mới. Khi build lỗi:

- `consents` **không còn unique index nào** (`userId_1_clientId_1` đã drop, `userId_1_clientId_1_resource_1` chưa có) — kiểm bằng `db.consents.getIndexes()` (chỉ còn `_id_`).
- Các model đứng SAU `Consent` trong `be/src/database/mongo/models.ts` **chưa được sync**.
- Không doc nào bị xoá.

Phục hồi (theo thứ tự, không bỏ bước):
1. **Không rollout** tiến trình ứng dụng mới; nếu bản cũ đang chạy, giữ nhưng coi khoảng này là có thể phát sinh duplicate mới.
2. Chạy lại truy vấn 2b, hợp nhất thủ công các nhóm `count > 1` (như trên).
3. Chạy lại 2b ⇒ phải rỗng (nếu không, lặp bước 2 — app cũ có thể vừa ghi thêm).
4. `pnpm --filter be db:sync-indexes` ⇒ exit 0.
5. Xác minh 2c. Chỉ khi 2c đúng mới sang bước 5–6 của §4.

### 2c. Xác minh sau sync

```js
// mongosh <MONGO_URI>
db.consents.getIndexes();
// Kỳ vọng: _id_ + userId_1_clientId_1_resource_1 (unique: true); KHÔNG còn userId_1_clientId_1.
```

Bằng chứng tự động: `be/test/indexes.int-spec.ts` — mô phỏng DB cũ (tạo index cũ rồi sync),
assert index cũ nằm trong danh sách `dropped.Consent`, index còn lại đúng khoá mới unique, và
sync fail-closed (E11000, không xoá doc) khi dữ liệu cũ vi phạm khoá mới.

## 2d. Index unique `ClientCredential {clientId, version}` (DEBT-021)

Run 20 đổi `{clientId:1, version:1}` thành **unique**. `syncIndexes` sẽ drop index non-unique cùng tên rồi build unique.
Kiểm duplicate TRƯỚC khi sync:

```js
db.clientcredentials.aggregate([
  { $group: { _id: { clientId: '$clientId', version: '$version' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 } } },
]);
```

- Rỗng ⇒ sync. Có nhóm ⇒ DỪNG: với mỗi nhóm, đánh số lại version cho doc tạo sau (`version = max + 1`) hoặc revoke doc dư nếu là secret không ai dùng. KHÔNG xoá credential đang hợp lệ khi chưa xác nhận với chủ client.
- Nếu sync đã FAIL: `clientcredentials` mất index `{clientId, version}` (chỉ ảnh hưởng hiệu năng `verifySecret` + cho phép trùng tạm) ⇒ dọn rồi sync lại như mục phục hồi ở 2b. Lưu ý `ClientCredential` đứng TRƯỚC `Consent` trong `models.ts` ⇒ lỗi ở đây làm `Consent` và các model sau chưa được sync.

(Collection mặc định của model `ClientCredential` là `clientcredentials`; dev xác minh bằng `db.getCollectionNames()`.)

## 3. Redis — `maxmemory-policy noeviction` (DEBT-049)

Session, authorize-context, tombstone, one-time code sống trong Redis với TTL. Nếu Redis evict
key dưới áp lực bộ nhớ, phiên/tombstone/code có thể biến mất sớm ⇒ hành vi bảo mật lệch
(ví dụ tombstone mất ⇒ AT đã logout lại "sống"). Đặt chính sách **không evict** để key chỉ mất
theo TTL, không theo áp lực RAM:

```bash
redis-cli CONFIG GET maxmemory-policy        # kiểm hiện trạng
redis-cli CONFIG SET maxmemory-policy noeviction
# và ghi cố định trong redis.conf: maxmemory-policy noeviction
```

Giám sát `used_memory` vs `maxmemory`; với `noeviction`, Redis sẽ trả lỗi ghi khi đầy — hệ
fail-closed (thao tác ghi phiên/code lỗi rõ ràng) thay vì âm thầm mất dữ liệu bảo mật.

## 4. Thứ tự deploy đề xuất

1. Backfill `resource` (2a).
2. Kiểm duplicate (2b) — rỗng mới tiếp.
2'. Kiểm duplicate ClientCredential (2d) — rỗng mới tiếp.
3. `pnpm --filter be build && pnpm --filter be db:sync-indexes` (1 + 2).
4. Xác minh index (2c).
5. Đặt `maxmemory-policy noeviction` (3) nếu chưa.
6. Rollout tiến trình ứng dụng.

## 5. `TRUST_PROXY` khi chạy sau reverse proxy (DEBT-006)

`req.ip` là cơ sở của rate limit client auth theo IP (§6.3) và audit. Sau reverse proxy, nếu không
cấu hình, mọi client xuất hiện với IP của proxy ⇒ bucket theo IP thành **giới hạn toàn cục** (ai
cũng khoá được `/token`) và khoá `client_id|ip` trở thành khoá theo `client_id` trần ⇒ attacker
khoá được client hợp lệ.

- Đặt `TRUST_PROXY` = **đúng IP/CIDR của reverse proxy** (vd. `10.0.0.0/8`; danh sách phân tách
  bằng dấu phẩy). **Chỉ nhận IP/CIDR.**
- **Không dùng số hop.** Fastify 5 (`getTrustProxyFn`) âm thầm bỏ qua `trustProxy` dạng số
  (fail-closed, không xác thực được peer liền kề) ⇒ `req.ip` rơi về IP socket của proxy, bucket IP
  thành giới hạn toàn cục mà **không có cảnh báo**. Vì vậy app **từ chối khởi động** nếu `TRUST_PROXY`
  là một số — thông báo lỗi hướng dẫn đặt IP/CIDR của proxy.
- Thiếu/rỗng/`false` ⇒ mặc định TẮT (dùng IP socket). Chỉ dùng khi KHÔNG có proxy trước app.
- **TUYỆT ĐỐI không** `TRUST_PROXY=true` — tin mọi `X-Forwarded-For` ⇒ client spoof IP vượt
  bucket. App **từ chối khởi động** nếu gặp `true`, một số, hoặc IP/CIDR sai (`parseTrustProxy`).

## 6. Sau emergency rotate — kiểm `KEY_LOCAL_DIR` (DEBT-163, dev `LocalKeyProvider`)

Emergency rotate ghi `keys.json` mới rồi mới xoá PEM cũ (best-effort). Process chết giữa hai bước, hoặc
`rm` lỗi (log ERROR), có thể để lại `<oldKid>.pem` — **private key đã lộ** — trong thư mục.

- Sau `POST /admin/keys/rotate {mode:'emergency'}`: `KEY_LOCAL_DIR` chỉ còn `<newKid>.pem` + `keys.json`
  (`newKid` trong response/audit `SIGNING_KEY_ROTATED`).
- Khi khởi động, `LocalKeyProvider.init()` log **WARN** `Private key file(s) not in keys.json (orphans,
  not deleted): <kid>, ...` (chỉ kid, không đường dẫn/nội dung). Code **không tự xoá**.
- Xử lý: xác nhận kid **không** có trong `keys.json` và **chính là kid đã biết bị lộ** (`oldKid` của lần
  emergency) rồi mới xoá thủ công `<kid>.pem`. Thư mục dùng chung nhiều process ⇒ orphan khác có thể là
  PEM vừa tạo của process đang rotate: KHÔNG xoá kid không xác định được nguồn gốc.

## 7. fe-admin (BFF) — image & deploy

Image Node một process (`node serve.mjs`, srvx), đặt **sau reverse proxy TLS**. Không chứa `.env`,
key, `src/`, test hay devDependencies; chạy user `1000:1000`, rootfs read-only được.

**Build** (context = gốc repo; ignore = `fe-admin/Dockerfile.dockerignore`, allowlist):

```bash
docker build -f fe-admin/Dockerfile -t <registry>/veyrigate-fe-admin:<version> .
bash fe-admin/scripts/docker-smoke.sh <registry>/veyrigate-fe-admin:<version>   # 13 check, như CI `fe-admin-image`
```

**Build context fail-closed (DEBT-398)**: bước đầu stage `build` quét context qua bind mount (không tạo
layer) và **dừng build** nếu thấy `.env*`, `*.pem|key|p12|pfx`, `.npmrc`, `be/keys/`, `**/.keys/` (in tên
file, không in nội dung) ⇒ sửa `.dockerignore`, không xoá bước guard. Cần **BuildKit** (`RUN --mount`;
mặc định của `docker build` từ Docker 23). **Cấm** `--cache-to …,mode=max` ra registry hay bất cứ đâu
ngoài máy build (cache `max` chứa layer trung gian của stage `build`); nếu cần cache từ xa chỉ dùng
`mode=min` hoặc không export cache.

**Env** (chỉ từ môi trường process; image không đọc file `.env`, không có `--env-file`):

| Biến | Ghi chú |
|---|---|
| `OIDC_ISSUER`, `ADMIN_API_BASE_URL`, `APP_URL` | Bắt buộc `https` ở build prod. `APP_URL` là origin trần (không path, không `/` cuối) |
| `ADMIN_API_RESOURCE` | Resource indicator của admin API |
| `OIDC_CLIENT_ID` | Client confidential của fe-admin |
| `OIDC_CLIENT_SECRET`, `SESSION_SECRET` | ≥ 32 ký tự, ngẫu nhiên, lấy từ secret store; không đặt trong image/compose commit |
| `SESSION_REDIS_URL` | Nên `rediss://` + user ACL chỉ `~fea:*` (DEBT-280) |
| `HOST`, `PORT` | Mặc định image `0.0.0.0`, `3000` |

- **Env lỗi ⇒ container thoát mã 1** (tự kiểm `/healthz` lúc boot). Log chỉ có **tên biến** + lý do
  cố định, không bao giờ giá trị.
- **Không listen được** (cổng bận, `HOST` không có trên interface…) ⇒ thoát mã 1, log
  `fe-admin: listen failed: <mã lỗi>` (DEBT-384). Đặt `restart: on-failure`/`unless-stopped`.
- **Không bật trust proxy**: URL tuyệt đối dựng từ `APP_URL`, không từ `Host`/`X-Forwarded-*`. Path bắt đầu `//` (kể cả `/\x`, URL chuẩn hoá thành `//x`, và `/%5C…`, `/%09/…` mà h3 giải mã thành `//…` trước router) ⇒ 404, không redirect (DEBT-387/442); proxy chỉ nên nhận `Host` = host của `APP_URL`. Lớp cuối (DEBT-446): response có `Location` tuyệt đối ngoài origin `APP_URL`/`OIDC_ISSUER` (hoặc có authority/userinfo, không parse được) ⇒ 404 + log `location guard failed … blocked an off-origin Location (status N)`; gặp log này nghĩa là guard `//` đã hồi quy (thường sau nâng h3/srvx/router-core).
- **Chỉ 1 replica** cho tới khi xong DEBT-278.
- **Rate limit `/auth/login` ở proxy** (DEBT-284).
- Sau proxy TLS, trình duyệt không gửi `Sec-Fetch-Site` có thể bị CSRF check chặn nhầm (DEBT-376).

**Healthcheck**: `GET|HEAD /healthz` ⇒ `200 ok`, `no-store`. Đây là **liveness**, không phải readiness:
không chạm Redis/IdP (Redis/IdP chết ⇒ 503 theo từng request, `/healthz` vẫn 200). `/ready` ⇒ DEBT-378.
Image có `HEALTHCHECK` (30 s, timeout 3 s, start 15 s, 3 lần).

**Header**:
- Mọi response của app (trang, `/auth/*`, `/_serverFn`, 404, 413, 500, 503): CSP nonce, `nosniff`,
  XFO `DENY`, HSTS (khi `APP_URL` https), mặc định `cache-control: no-store`.
- `/assets/*` (tên có hash, phục vụ từ `dist/client`): `nosniff` + `cache-control: public, max-age=31536000, immutable`.
  Asset không tồn tại ⇒ 404 có header của app.
- Body: mọi method ≠ GET/HEAD/OPTIONS bị giới hạn 64 KiB theo `Content-Length` (sai ⇒ 400, quá ⇒ 413,
  không có mà vẫn có body/chunked ⇒ 411), trước khi router đọc body (DEBT-370).

**Dừng**: `docker stop` gửi SIGTERM ⇒ srvx đóng graceful tối đa 5 s (`SERVER_SHUTDOWN_TIMEOUT`) rồi
thoát mã 0. Để `stop -t` ≥ 10 s.

**Cập nhật base image** (2 dòng `FROM node:<version>-bookworm-slim@sha256:<digest> AS build|runtime` literal
trong `fe-admin/Dockerfile` và `be/Dockerfile`, ghim theo digest — không dùng `ARG` trong `FROM` vì Dependabot
không đọc, dependabot-core#2057):
1. Chọn bản Node phát hành ≥ 14 ngày, trùng `.nvmrc` + `.node-version` + `engines` (đổi cùng lúc, DEBT-379).
2. `docker buildx imagetools inspect node:<version>-bookworm-slim` ⇒ lấy `Digest` (index digest).
3. Sửa cả 2 dòng `FROM` của **cả hai** Dockerfile; không dùng tag trần.
4. Build + `docker-smoke.sh` xanh trước khi merge.

**Dependabot** (`.github/dependabot.yml`, run 72, DEBT-466): hằng tuần, `cooldown.default-days: 14` (version
update chờ 14 ngày như quy tắc ghim tay), nhóm minor/patch cho npm và github-actions, nhóm `node-image` (be +
fe-admin một PR), bỏ qua Node major. Giới hạn:
- `docker`: Dependabot **không có security update** ⇒ CVE Node/Debian khẩn = bump tay theo ngoại lệ bảo mật.
- `npm`: pnpm 12 ghi `pnpm-lock.yaml` thành 2 YAML document ⇒ dependency graph không thấy phụ thuộc ⇒ **không
  có alert/security update npm** (version update vẫn chạy, DEBT-500). Chặn bảo mật = CI `pnpm audit
  --audit-level high` fail-closed + ngoại lệ tay (tiền lệ zod run 51).
- `github-actions`: security update chạy được, không bị cooldown.
- PR đổi tag `node` **phải sửa tay cùng PR** `.nvmrc`/`.node-version`/`engines` (Dependabot không làm, DEBT-502).
- Bật "Dependabot alerts / security updates" trong Settings repo là việc người dùng khi push; hiệu lực kiểm ở
  Insights → Dependency graph → Dependabot.

## 8. Vault Transit KeyProvider (production, run 53)

Production **bắt buộc** `KEY_PROVIDER=vault` (`local` bị từ chối lúc boot). Private key RSA nằm trong
Vault Transit, `exportable=false`; app chỉ gửi dữ liệu cần ký (RS256 = `sha2-256` + `pkcs1v15`) và tự
verify chữ ký trước khi trả token.

**Chuẩn bị Vault** (ops, một lần; `<mount>`/`<key>` khớp env bên dưới):

```bash
vault secrets enable -path=<mount> transit
vault write -f <mount>/keys/<key> type=rsa-2048 exportable=false allow_plaintext_backup=false
# KHÔNG đặt auto_rotate_period: rotate phải đi qua POST /admin/keys/rotate để có audit.
# ví dụ mount=transit, key=idp-signer (đổi theo VAULT_TRANSIT_MOUNT / VAULT_TRANSIT_KEY):
sed -e 's#<mount>#transit#g' -e 's#<key>#idp-signer#g' ops/vault/idp-signer.hcl > /tmp/idp-signer.hcl
vault policy write idp-signer /tmp/idp-signer.hcl
```

- Policy `ops/vault/idp-signer.hcl`: chỉ `sign`/`read`/`rotate` của **một** key, `config` chỉ nhận
  `min_decryption_version`/`min_encryption_version`, `trim` chỉ nhận `min_available_version`. Không cấp
  `export`, `backup`, `delete`, key khác.
- Token app: **Vault Agent** auto-auth (AppRole hoặc Kubernetes) với `sink "file"` ⇒ đường dẫn này là
  `VAULT_TOKEN_FILE`. File quyền `0400`, owner là uid chạy app (1000). App đọc file lúc boot và đọc lại
  một lần khi Vault trả 403 (Agent đã renew). **Không** có biến `VAULT_TOKEN`.
- TLS: `VAULT_ADDR` phải `https://` ở production (zod chặn). CA riêng ⇒ `NODE_EXTRA_CA_CERTS=/path/ca.pem`.
  Không dùng cờ tắt xác thực TLS.

**Env**

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `KEY_PROVIDER` | có | `vault` (production), `local` chỉ dev/test |
| `VAULT_ADDR` | khi `vault` | URL, `https:` ở production |
| `VAULT_TOKEN_FILE` | khi `vault` | Sink của Vault Agent |
| `VAULT_TRANSIT_MOUNT` | không | Mặc định `transit`; `^[a-z0-9][a-z0-9_-]*(/[a-z0-9_-]+)*$` |
| `VAULT_TRANSIT_KEY` | khi `vault` | `^[A-Za-z0-9_-]+$` |
| `VAULT_TIMEOUT_MS` | không | Mặc định 2000, tối đa 10000; `sign`/đọc key retry 1 lần (mạng/timeout/5xx) |
| `KEY_LOCAL_DIR` | khi `local` | Không dùng với `vault` |

**Boot từ chối** (app không khởi động, log chỉ tên lỗi, không token/đường dẫn): token file thiếu/rỗng,
key không tồn tại (404) hoặc không có quyền (403), key không phải `rsa-2048/3072/4096`, `exportable` hoặc
`allow_plaintext_backup` = true, `supports_signing` ≠ true, metadata Vault không đúng dạng.

**Hành vi chạy**
- `kid` = RFC 7638 thumbprint của public key (không phải số version).
- Metadata key (JWKS) cache **30 s** trong mỗi instance. Emergency rotate ở instance A: A ngừng chấp nhận
  key cũ ngay; instance khác ≤ 30 s. Vault từ chối ký bằng version cũ ngay với **mọi** instance (instance
  cache cũ tự refresh rồi ký lại bằng key mới). RP ngoài theo cache JWKS của họ (DEBT-157).
- Token mang `kid` lạ (instance khác vừa rotate) ⇒ refresh metadata tối đa 1 lần / 5 s.
- Rotate normal: version cũ còn trong JWKS tới `creation_time(mới) + ACCESS_TOKEN_TTL + 30 s`.
- **Vault down**: không cấp được token (`/token` 5xx, không phát token chưa ký). Verify (`/userinfo`,
  `/introspect`, admin API) chạy bằng cache tới khi hết hạn (≤ 30 s); sau đó trả **503
  `temporarily_unavailable` + `Retry-After: 5`** (run 53c, DEBT-394): vẫn fail-closed nhưng RS/RP phân biệt
  được sự cố với token sai (`/introspect` không có `active`; token hỏng định dạng vẫn 401/`active:false`).
  Logout bỏ qua `id_token_hint` (về trang mặc định) — chỉ là chọn redirect, không cấp quyền. `/ready`
  không kiểm Vault (DEBT-390).
- Backup/HA/unseal của Vault là trách nhiệm hạ tầng (DEBT-391): mất storage Vault = mất key ký.

**Kiểm sau deploy**: `curl -sS $IDP/jwks.json` có 1 key `kid` dạng 43 ký tự base64url;
`vault read <mount>/keys/<key>` ⇒ `exportable false`, `allow_plaintext_backup false`.

**Test**: `pnpm -C be test:vault` (cần `VAULT_TEST_ADDR` + `VAULT_TEST_ROOT_TOKEN` của một Vault dev tạm;
thiếu ⇒ fail kèm lệnh `docker run`, không skip). CI chạy trong job `int`.

## 9. IdP backend (BE) — image & deploy (run 53b)

Image Node một process (`node dist/main.js`, NestJS + Fastify), đặt **sau reverse proxy TLS**. Base
`node:22.x-bookworm-slim` ghim digest (glibc, vì `@node-rs/argon2` dùng bản gnu — **không** đổi sang
alpine). Không chứa `.env`, PEM/key, `be/keys`, `src/`, test, source map, `*.d.ts` hay devDependencies;
chạy user `1000:1000`, file app thuộc root, rootfs read-only được (`--read-only --tmpfs /tmp`).

**Build** (context = gốc repo; ignore = `be/Dockerfile.dockerignore`, allowlist, loại `**/.env*`,
`**/*.pem|key|p12|pfx`, `**/.npmrc`, `be/keys/`):

```bash
docker build -f be/Dockerfile --target build -t <registry>/veyrigate-be:<version>-build .   # chỉ để quét
docker build -f be/Dockerfile -t <registry>/veyrigate-be:<version> .
bash be/scripts/docker-smoke.sh <registry>/veyrigate-be:<version> <registry>/veyrigate-be:<version>-build
```

**Build context fail-closed (DEBT-398)**: bước đầu stage `build` quét context qua bind mount (không tạo
layer) và **dừng build** nếu thấy `.env*`, `*.pem|key|p12|pfx`, `.npmrc`, `be/keys/`, `**/.keys/` (in tên
file, không in nội dung) ⇒ sửa `.dockerignore`, không xoá bước guard. Cần **BuildKit** (`RUN --mount`;
mặc định của `docker build` từ Docker 23). **Cấm** `--cache-to …,mode=max` ra registry hay bất cứ đâu
ngoài máy build (cache `max` chứa layer trung gian của stage `build`); nếu cần cache từ xa chỉ dùng
`mode=min` hoặc không export cache.

Smoke (như CI `be-image`, 11 check) dựng mạng `vg-b73b-net` + Mongo/Redis/Vault dev (TLS) tạm, rồi
kiểm: non-root, `HEALTHCHECK` healthy, `/health` + `/ready` 200, `/jwks.json` đúng key Vault Transit,
không `.env`/key trong image (cả build stage), Redis chết ⇒ `/health` 200 + `/ready` 503, `docker stop`
**khi Redis vẫn chết** ⇒ thoát 0 trong < 10 s (DEBT-397), thiếu biến ⇒ thoát ≠ 0 (chỉ nêu tên), `KEY_PROVIDER=local` ⇒ thoát ≠ 0, log không có secret.
Không push, không đăng nhập registry.

**Env** (chỉ từ môi trường process; image đặt sẵn `NODE_ENV=production`, `PORT=4000`). `main.ts` nạp
`.env` ở cwd **nếu có** ⇒ không bao giờ mount/ghi file `/app/.env` (image không có, rootfs read-only).

| Nhóm | Biến | Ghi chú |
|---|---|---|
| Bắt buộc | `ISSUER` | URL công khai `https://…` (khớp proxy) |
| Bắt buộc | `MONGO_URI` + **một trong** `REDIS_SENTINELS` (+ `REDIS_SENTINEL_MASTER`, production, §10) / `REDIS_URL` (standalone) | Từ secret store (chứa mật khẩu); Redis `noeviction` (§3) |
| Bắt buộc | `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `SESSION_IDLE_TTL`, `SESSION_ABSOLUTE_TTL` | Giây (Q6) |
| Bắt buộc | `SMTP_URL`, `ADMIN_SEED_EMAIL`, `CSRF_SECRET`, `RATE_LIMIT_WINDOW`, `RATE_LIMIT_MAX` | `CSRF_SECRET` ngẫu nhiên dài, từ secret store |
| Key ký | `KEY_PROVIDER=vault`, `VAULT_ADDR` (`https:`), `VAULT_TOKEN_FILE`, `VAULT_TRANSIT_KEY` (+ `VAULT_TRANSIT_MOUNT`, `VAULT_TIMEOUT_MS`) | Xem §8. `local` bị từ chối ở production |
| TLS Vault | `NODE_EXTRA_CA_CERTS=/path/ca.pem` | Chỉ khi Vault dùng CA riêng; file CA mount read-only |
| Tuỳ chọn | `TRUST_PROXY` (§5), `METRICS_TOKEN` (≥ 32, không publish `/metrics` ra ngoài), `GOOGLE_*`/`GITHUB_*` (theo cặp), `CONSENT_*`, `CLIENT_*` | |

- **Env lỗi ⇒ thoát mã 1** trước khi listen; log chỉ có **tên biến** + lý do, không giá trị.
- URL hỏng (percent-encoding sai) / param > 100 ký tự ⇒ 400/414 JSON cố định `{"error":"invalid_request"}`, có header bảo mật + `no-store`, metric `route="__unmatched"`, không log lỗi (DEBT-239).
- `NODE_ENV=production` tắt `autoIndex` ⇒ chạy `db:sync-indexes` (§1) **trước** khi chuyển traffic
  (image có `dist/database/mongo/sync-indexes.js`:
  `docker run --rm <env…> <image> node dist/database/mongo/sync-indexes.js`).

**Token Vault (Vault Agent sidecar)**: Agent auto-auth (AppRole/Kubernetes) ghi `sink "file"` vào một
volume dùng chung (tmpfs/`emptyDir` medium Memory), app mount **read-only** cùng volume và đặt
`VAULT_TOKEN_FILE` = đường dẫn sink. File `0400`/`0440`, đọc được bởi uid 1000. App đọc file lúc boot
(thiếu/rỗng ⇒ không boot) và đọc lại một lần khi Vault trả 403 (Agent đã renew). **Không** truyền token
qua biến môi trường hay `docker run -e`. App phải khởi động **sau** khi Agent ghi sink lần đầu
(`depends_on` healthy / init container), nếu không app thoát 1 và được restart.

**Healthcheck**
- Image có `HEALTHCHECK` (30 s, timeout 3 s, start 20 s, 3 lần) gọi `GET /health` = **liveness**: chỉ cần
  process trả lời, không chạm Mongo/Redis/Vault.
- `GET /ready` = **readiness**: 200 khi Mongo + Redis ping được, 503 `{status:'error',mongo,redis}` khi
  không. Dùng cho LB/`readinessProbe` (rút instance khỏi pool), **không** dùng cho restart: Redis/Mongo
  chết thì mọi container cùng fail, restart không giúp gì. `/ready` không kiểm Vault (DEBT-390).

**Dừng**: `docker stop` gửi SIGTERM ⇒ Nest đóng HTTP, Mongo, Redis rồi thoát mã 0. Để `stop -t` ≥ 15 s.
Redis: `QUIT` chỉ khi đang kết nối, tối đa 1 s, rồi luôn `disconnect()` ⇒ Redis **đang chết** vẫn thoát 0
trong vài giây (run 53c, DEBT-397; smoke check 8).

**Cập nhật base image**: như §7 (2 dòng `FROM` literal cùng digest với `fe-admin/Dockerfile`, đổi cả hai +
`.nvmrc` + `.node-version` + `engines` cùng lúc, bản ≥ 14 ngày, DEBT-379; Dependabot nhóm `node-image`). Image phụ trợ của smoke (Mongo/Redis/Vault) ghim digest
trong `be/scripts/docker-smoke.sh`.

## 10. Redis Sentinel (production, run 53c)

Plan §6.2: production chạy **Redis Sentinel** (self-host, Q5). **Không hỗ trợ Redis Cluster** (Lua/MULTI
nhiều key khác slot — DEBT-013/073 đóng dạng N/A). Mẫu topology: `ops/compose/prod.example.yml` (1 master
+ 2 replica + 3 sentinel quorum 2, `noeviction`, `min-replicas-to-write 1`, Vault Agent sidecar, không
publish `/metrics`, mọi service `user:` không root) — **chỉ là file mẫu, không chạy nguyên trạng**.

**Đã smoke run 72 (DEBT-405)** bằng `docker run` cùng cờ (`--read-only --cap-drop ALL --security-opt
no-new-privileges:true --user …`, tmpfs, secret bind `:ro`, network `--internal`), không `compose up`: PID 1
của redis master/2 replica/3 sentinel (999:999) và vault-agent (100:1000) đều Uid ≠ 0, `CapEff 0`,
`NoNewPrivs 1`; `connected_slaves:2`, replica ghi ⇒ `READONLY`; `SENTINEL ckquorum idp` 3 sentinel; stop
master ⇒ failover ~6 s, master cũ quay lại làm replica; vault-agent ghi sink `0440 100:1000`, app uid 1000
đọc được, uid khác bị từ chối; Vault không tới được ⇒ không token ⇒ `be` không khởi động (fail-closed).

Lưu ý khi deploy:
- **Quyền file host** (compose `secrets:` không Swarm và bind mount giữ owner/mode host; Docker Desktop hiện
  `0777 root` nên phải kiểm trên host Linux): `chmod 0700 secrets`; `chown 999:999` + `chmod 0400`
  `secrets/redis_auth.conf`, `secrets/redis_password`, `secrets/sentinel_password`; `chown 100:1000` +
  `chmod 0400` `secrets/approle/role_id`, `secrets/approle/secret_id` (**không** 0440: gid 1000 là nhóm app);
  **thư mục** `secrets/approle` (bind mount `/vault/approle`) `chown 100:1000` + `chmod 0500` — tạo dưới
  `umask 077` (`0700 <operator>`) ⇒ uid 100 không vào được ⇒ agent không có token ⇒ `be` không khởi động.
- **`CONFIG REWRITE failed: Read-only file system`** sau failover là chủ ý (rootfs + config ro): vai trò mới
  chỉ ở RAM, node khởi động lại về vai trò command line rồi Sentinel cấu hình lại; master cũ đứng một mình
  trả `NOREPLICAS` (`min-replicas-to-write 1`), không ghi lệch.
- **Kiểm uid image**: trên containerd image store `docker image inspect <repo>@sha256:<index>` trả config
  rỗng ⇒ dùng `docker create` + `docker inspect` container, hoặc `docker run --rm --entrypoint id <image>`.

Lặp lại smoke (không script): bản sao `prod.example.yml` + secret giả ⇒ `docker compose config`; tạo network
`--internal` tên riêng; `docker run` từng dịch vụ cùng cờ + `--network-alias` = hostname; kiểm
`/proc/1/status` (Uid/CapEff/NoNewPrivs), `redis-cli INFO replication`, `SENTINEL ckquorum idp`; stop master
⇒ `SENTINEL get-master-addr-by-name idp` đổi; dọn đúng tên container/volume/network (không prune).

**Đánh đổi `min-replicas-to-write`**: `1` ⇒ không replica nào đồng bộ thì Redis trả `NOREPLICAS` và app trả
**500 `server_error` không `Retry-After`** ở thao tác ghi (login, `/token`, logout) — fail-closed nhưng dừng
ghi. Vì vậy mẫu dùng **2 replica** (1 replica chết vẫn ghi). `0` ⇒ vẫn ghi khi mất replica nhưng ghi đã xác
nhận (phiên, code, tombstone `sess_end:*`) có thể mất khi failover (replication bất đồng bộ) — mẫu không chọn.

**Secret**: `env_file:` chỉ giữ secret ngoài file compose/git; biến vẫn nằm trong `Config.Env` ⇒ ai có quyền
docker (= root host) đọc được qua `docker inspect`. Bí mật nên lấy qua secret file / Vault Agent; hiện app chỉ
đọc từ file với `VAULT_TOKEN_FILE` (`*_FILE` cho secret khác: chưa hỗ trợ, X6).

**Env** (đặt **một** chế độ; có cả `REDIS_URL` và `REDIS_SENTINELS` ⇒ app không boot, log nêu tên biến):

| Biến | Ghi chú |
|---|---|
| `REDIS_SENTINELS` | `host:port[,host:port…]` (IPv6: `[addr]:port`), ≥ 1; nên ≥ 3 |
| `REDIS_SENTINEL_MASTER` | Tên master group (`sentinel monitor <tên> …`), bắt buộc với `REDIS_SENTINELS` |
| `REDIS_SENTINEL_PASSWORD` | Tuỳ chọn — `requirepass` của sentinel |
| `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_DB` | Tuỳ chọn (db mặc định 0); **chỉ** dùng với Sentinel — standalone đặt trong `REDIS_URL` (đặt kèm `REDIS_URL` ⇒ không boot) |
| `REDIS_URL` | Standalone (dev/test). Production + `REDIS_URL` vẫn boot nhưng log WARN "no failover" |

Client giữ nguyên giới hạn fail-fast cho cả hai chế độ (`REDIS_COMMAND_TIMEOUT_MS`, `maxRetriesPerRequest 1`,
retry ≤ 2 s) và hỏi sentinel master hiện tại mỗi lần (re)connect. Hostname sentinel/master phải resolve được
từ container app (`sentinel announce-hostnames yes` + tên DNS ổn định). Không TLS tới Redis/Sentinel ⇒ chỉ
mạng nội bộ (`internal: true`).

**Redis không trả lời (chết, failover, mạng)** — kill test `be/test/redis-down.int-spec.ts`:
- Mọi endpoint cần state (`/authorize`, `POST /login`, `/authorize/consent`, `/token` code + refresh,
  `/userinfo`, `/introspect`, `POST /logout`) ⇒ **503 `temporarily_unavailable`** +
  `Retry-After: 5` + `Cache-Control: no-store` (HTML với trang UI, JSON với OAuth). Không `Set-Cookie`
  phiên, không token, `/introspect` không có `active`. Không có fallback memory/fail-open.
- Chỉ lỗi ioredis đã quan sát (`MaxRetriesPerRequestError`, `Command timed out`) thành 503; lỗi lạ vẫn 500
  (fail-closed). Metric `sso_token_endpoint_errors_total{error="temporarily_unavailable"}` tăng; HTTP 5xx
  alert vẫn bắt.
- Redis chết hẳn (kill test): request thất bại không tiêu code/RT/phiên ⇒ Redis về, cùng phiên/code/RT dùng
  tiếp (không reuse detection). Nhưng `Command timed out` không bảo đảm lệnh chưa chạy (Redis chậm/failover giữa
  request có thể đã consume code rồi mới timeout) ⇒ thử lại `/token` có thể nhận `invalid_grant` ⇒ RP bắt đầu
  lại luồng.
- `/health` 200, `/ready` 503 `redis:"down"` ⇒ LB rút instance; **không** restart container.
- Failover thật (test `test:sentinel`): dừng master ⇒ lệnh bị từ chối nhanh (≤ ~1 s, 503) trong lúc chuyển,
  ghi được trên master mới sau ~5 s (down-after 1 s ở test; production đặt theo mạng, vd 5 s).

**Test**: `bash be/scripts/sentinel-test-env.sh up && pnpm -C be test:sentinel; bash be/scripts/sentinel-test-env.sh down`
(container `vg-b73c-redis-a`@16390, `vg-b73c-redis-b`@16391, `vg-b73c-sentinel`@26390, mạng `vg-b73c-net`;
thiếu ⇒ fail kèm lệnh, không skip; chạy `up` lại trước mỗi lần test vì test failover đổi master).

## 11. Cookie phiên `__Host-` (DEBT-008, run 73) — đăng nhập lại 1 lần sau deploy

Khi `SESSION_COOKIE_SECURE=true` (bắt buộc ở production), tên cookie là `__Host-idp_session` và
`__Host-idp_csrf` (`Secure; HttpOnly; SameSite=Lax; Path=/`, **không** `Domain`). Ở dev/E2E http
(`SESSION_COOKIE_SECURE=false`) tên vẫn là `idp_session`/`idp_csrf`. Không có env mới, tên suy ra từ cờ này.

- **Cắt cứng**: BE không đọc tên cũ `idp_session` khi `Secure`, và cũng không chủ động xoá cookie cũ.
  ⇒ **sau lần deploy đầu tiên có run 73, mọi người dùng phải đăng nhập lại 1 lần**. Cookie cũ bị bỏ
  qua rồi hết hạn theo Max-Age; session Redis cũ hết theo idle TTL (không tombstone). Báo trước
  cho người dùng/RP.
- **Federation (DEBT-505, run 74)**: khi `Secure`, cookie `idp_fed`/`idp_link` thành `__Host-idp_fed`/
  `__Host-idp_link` với `Path=/` (trước là `Path=/auth/`). Leg Google/GitHub đang dở lúc deploy
  (≤ 10 phút TTL) về callback/link không thấy cookie mới ⇒ trang lỗi cố định `invalid_state` 400;
  người dùng bấm lại "Sign in with …" là xong. Không cần thao tác vận hành.
- **Cookie `idp_authz` (DEBT-413, run 81)**: login đang dở lúc deploy (context ≤ 10 phút, không có `bindingHash`) ⇒ sau khi đăng nhập thấy "Request expired"; người dùng bắt đầu lại từ RP. Không cần thao tác vận hành.
- Dev chạy http phải giữ `SESSION_COOKIE_SECURE=false`. Nếu để `true` trên `http://`, WebKit lưu cookie
  nhưng không gửi ⇒ không đăng nhập được.
- Reverse proxy/CDN không được viết lại `Set-Cookie` (thêm `Domain`, đổi `Path`): trình duyệt sẽ từ
  chối cookie `__Host-` ⇒ không ai đăng nhập được.
- Ma trận trình duyệt (X3): `pnpm -C e2e e2e:x3` (cần `openssl`, cổng 4100/5273/5274/8443 trống,
  không chạy cùng lúc `pnpm -C e2e e2e`). Chi tiết ở `e2e/README.md`; bảng kết quả ở spec §9.6.

## 12. Trước deploy run 75 — `Resource.scopes` được thực thi (DEBT-321/512)

Từ run 75, scope cấp được = `Client.scopes` ∩ (OIDC ∪ `Resource.scopes`) (OIDC = `openid profile email
offline_access`, chỉ so với client). Hệ quả sau deploy: `/authorize` xin scope ngoài giao ⇒ `invalid_scope`;
code đang chờ đổi mang scope ngoài giao ⇒ `invalid_grant`; refresh **thu hẹp** family về giao hiện hành
(lưu vào RT kế nhiệm), hoặc `invalid_grant` + revoke khi (i) giao rỗng, (ii) mất hết scope ngoài OIDC,
(iii) `offline_access` không còn trong `Client.scopes`. Seed chỉ `$setOnInsert`, nên DB đã sửa tay qua UI
có thể lệch. **Chạy 3 truy vấn chỉ đọc dưới đây trên DB production TRƯỚC deploy** (thay `ISSUER`; các
truy vấn chỉ `find`/`aggregate` không `$out`/`$merge`, không ghi gì):

```js
// mongosh "<MONGO_URI>/<DB>" --quiet --file run75-check.js
const ISSUER = 'https://id.example.com'; // = env ISSUER của BE
const OIDC = ['openid', 'profile', 'email', 'offline_access'];
const ADMIN = new URL('/admin/', ISSUER).href;

// q1: resource `admin` phải có cả admin.read và admin.write (thiếu ⇒ fe-admin bị khoá sau deploy).
const admin = db.resources.find({ identifier: ADMIN }, { _id: 0, resourceId: 1, scopes: 1 }).toArray();
printjson({ q1: admin, ok: admin.length > 0 && admin.every((r) => ['admin.read', 'admin.write'].every((s) => (r.scopes || []).includes(s))) });

// q2: theo TỪNG cặp client/resource (DEBT-516): scope ngoài OIDC của client mà resource đó không liệt kê
// ⇒ `/authorize?resource=<resource>&scope=<scope>` sẽ bị invalid_scope. Không gộp scope các resource: scope
// chỉ có ở A vẫn hỏng khi xin cho B. Client không có resource nào (hoặc resourceId không tồn tại) không có
// cặp nào nên không được liệt kê (không thu hẹp gì; resource lạ đã là invalid_target từ trước).
printjson({ q2: db.clients.aggregate([
  { $lookup: { from: 'resources', localField: 'allowedResources', foreignField: 'resourceId', as: 'res' } },
  { $unwind: '$res' },
  { $project: { _id: 0, clientId: 1, resource: '$res.identifier', lost: { $setDifference: [{ $ifNull: ['$scopes', []] },
      { $setUnion: [OIDC, { $ifNull: ['$res.scopes', []] }] }] } } },
  { $match: { 'lost.0': { $exists: true } } },
]).toArray() });

// q3: RT đang active có scope ngoài giao hiện hành, chia "sẽ thu hẹp" / "sẽ bị revoke" theo (i)–(iii).
const q3 = { narrow: 0, revoke: 0, samples: [] };
db.refreshtokens.aggregate([
  { $match: { revokedAt: null, expiresAt: { $gt: new Date() } } },
  { $lookup: { from: 'clients', localField: 'clientId', foreignField: 'clientId', as: 'c' } },
  { $lookup: { from: 'resources', localField: 'resource', foreignField: 'identifier', as: 'r' } },
  { $project: { _id: 0, clientId: 1, resource: 1, scope: 1,
      clientScopes: { $ifNull: [{ $first: '$c.scopes' }, []] }, resScopes: { $ifNull: [{ $first: '$r.scopes' }, []] }, hasRes: { $gt: [{ $size: '$r' }, 0] } } },
]).forEach((t) => {
  if (!t.hasRes) return; // resource đã mất: rotate/classify xử lý như trước run 75
  const ok = new Set(t.clientScopes.filter((s) => OIDC.includes(s) || t.resScopes.includes(s)));
  const kept = t.scope.filter((s) => ok.has(s));
  if (kept.length === t.scope.length) return;
  const nonOidc = (a) => a.some((s) => !OIDC.includes(s));
  const dead = kept.length === 0 || (nonOidc(t.scope) && !nonOidc(kept)) ||
    (t.scope.includes('offline_access') && !kept.includes('offline_access'));
  q3[dead ? 'revoke' : 'narrow']++;
  if (q3.samples.length < 20) q3.samples.push({ clientId: t.clientId, resource: t.resource, dropped: t.scope.filter((s) => !ok.has(s)), dead });
});
printjson({ q3 });
```

Kỳ vọng: `q1.ok: true`, `q2: []`, `q3.narrow = q3.revoke = 0`. Nếu không:

- q1 sai ⇒ thêm `admin.read admin.write` vào resource `admin` (fe-admin trước deploy, hoặc `updateOne` có
  duyệt) **trước khi** deploy. Sau deploy, BE từ chối PATCH bỏ hai scope này (400 `invalid_request`).
- q2/q3 khác rỗng ⇒ thêm scope còn thiếu vào resource tương ứng TRƯỚC deploy, hoặc chấp nhận và báo
  trước cho RP liệt kê (RP xin scope đó sẽ nhận `invalid_scope`; người dùng có family bị revoke phải đăng
  nhập lại). Thêm lại scope sau deploy **không** khôi phục family đã thu hẹp/revoke — RP cần `/authorize` mới.
- AT đã phát trước deploy giữ scope cũ tới khi hết hạn (≤ 15').
