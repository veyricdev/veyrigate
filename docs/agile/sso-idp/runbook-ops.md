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
- **Kiểm đích Mongo TRƯỚC mọi CLI ghi** (`db:seed`, `db:seed-dev`, `db:sync-indexes`): không cờ, CLI in
  `target: <host>/<db>` rồi kết nối và ghi **ngay trong vài ms** ⇒ không kịp Ctrl-C (diễn tập run 40).
  Run 78 (DEBT-256/257): cả 3 CLI có `--dry-run` = kiểm env như lệnh thật, in `target:` + `dry-run: no
  connection made`, exit 0, **không kết nối**. Gõ biến **một lần** trong subshell, kiểm khô, rồi lệnh thật
  chỉ chạy sau **cổng xác nhận** (`read` dừng chờ gõ `yes`; dán nguyên khối cũng không tự chạy lệnh ghi)
  trong CÙNG subshell (sau `pnpm --filter be build` — script đọc `be/dist`). Dán CHỈ khối này:
  ```bash
  ( export MONGO_URI='<uri>'            # + các biến khác của lệnh, vd. NODE_ENV/ADMIN_SEED_*
    pnpm --filter be db:sync-indexes -- --dry-run &&   # ⇒ target: <host>/<db>
    read -r -p 'target dung? go yes de chay that: ' ok && [ "$ok" = yes ] &&
    pnpm --filter be db:sync-indexes )
  ```
  Đích sai (vd. `target: localhost:27017/sso-idp`) ⇒ gõ gì khác `yes` (hoặc Ctrl-C) ⇒ subshell thoát exit 1,
  không kết nối. Đổi `db:sync-indexes` thành `db:seed`/`db:seed-dev` ở **cả hai** dòng `pnpm`. Cờ khác
  `--dry-run` (vd. `--dry-run=true`, `--dryrun`, `-n`) ⇒ `unknown argument`, exit 1, không kết nối (DEBT-522).
  (pnpm chuyển `--` + `--dry-run` vào `process.argv`, đã kiểm run 78; script nạp `be/.env` nhưng biến đã
  export thắng. Biến env sai/thiếu ⇒ exit 1 trước khi in đích. Lỗi CLI in `[MONGO_URI]` thay cho URI và bỏ
  `user:password@` — DEBT-254.)
- Metric: `GET $IDP/metrics` cần `Authorization: Bearer <METRICS_TOKEN>` (route chỉ có khi đặt biến).
  Alert: `ops/prometheus/alerts.yml`.
- **Production vs dev (chung)**: chưa có KMS (Q5/B7.3). `KEY_PROVIDER=local` (`LocalKeyProvider`, thư
  mục `KEY_LOCAL_DIR`) là bản dev, **chỉ hỗ trợ 1 node** (DEBT-159). Mọi bước key cho production = **TBD B7.3**.
- **Đồng hồ (NTP) bắt buộc trên mọi instance BE** (run 56, DEBT-209): disable client ghi `lastDisabledAt`;
  code/AT/context tạo tới `lastDisabledAt + 5 s` (`CLIENT_DISABLE_MARGIN_MS`) chết vĩnh viễn kể cả khi
  enable lại. Lệch đồng hồ giữa instance > 5 s làm biên này vô hiệu: artefact chỉ sống lại khi đồng hồ
  instance **mint** đi TRƯỚC (nhanh hơn) instance **ghi disable** quá 5 s (hoặc instance ghi disable
  chạy chậm); instance mint chạy chậm cho `t` nhỏ hơn ⇒ artefact bị coi là trước disable ⇒ chết
  (fail-closed). Khi điều tra, soi node có đồng hồ nhanh nhất so với node đã xử lý lệnh disable. Kiểm: `timedatectl show -p NTPSynchronized` = `yes` trên từng node. Disable khẩn
  rồi enable lại ⇒ người dùng của client phải đăng nhập/consent lại; resource server tự verify JWT vẫn tin
  AT cũ tới `exp` (≤ 15') — cần cắt tức thời thì resource server phải gọi `/introspect`.

---

## 1. Key ký nghi bị lộ — emergency rotation

**Dấu hiệu**: private key/PEM xuất hiện ngoài hệ thống, host chứa `KEY_LOCAL_DIR` bị xâm nhập, token
lạ ký hợp lệ. Sau khi xoay: alert `SsoEmergencyKeyRotation`
(`sso_signing_key_rotations_total{mode="emergency",result="success"}`) bắn — đó là xác nhận, không phải sự cố mới.

**Quyết định**
- Nghi lộ ⇒ **emergency** (key cũ rời JWKS ngay, key mới ký ngay). Xoay định kỳ ⇒ `{"mode":"normal"}`: key mới
  vào JWKS ngay với `status:"pending"` và chỉ ký từ `activatesAt` = lúc xoay + `KEY_PREPUBLISH_SEC` (pre-publish,
  run 86, DEBT-393); key cũ ký tiếp tới đó rồi verify-only thêm `ACCESS_TOKEN_TTL`.
- **`KEY_PREPUBLISH_SEC` ≥ 600 ở production** (mặc định 3600; RP cache JWKS ≤ 10'). Đổi biến này: Vault suy ra
  `activatesAt` lúc đọc nên version đang pending dịch theo giá trị mới; Local đã ghi `activatesAt` vào `keys.json` nên không đổi.
- Emergency **KHÔNG thu hồi session Redis và refresh token**. Nếu nghi lộ kèm xâm nhập host/đánh cắp
  phiên ⇒ người trực cân nhắc thêm các bước thu hồi ở §2 (theo user/client) hoặc §4(i) (toàn bộ RT,
  DEBT-251). Không mặc định.

**Các bước** (super_admin + `admin.write` + step-up)
1. Đăng nhập lại (`prompt=login`) lấy `ADMIN_AT` mới (auth_time ≤ 5').
2. Ghi lại **tập kid** hiện tại: `GET /admin/keys` → `items[].{kid,status,activatesAt}` (`status:"active"` = kid
   đang ký; `pending` = đã publish, ký từ `activatesAt`).
3. `POST /admin/keys/rotate` body `{"mode":"emergency"}` → `200 {"newKid","oldKid","mode":"emergency","activatesAt"}`
   (`activatesAt` = lúc tạo: ký ngay; emergency gỡ cả key `pending`).
   - Rotate **normal** → `200 {…,"activatesAt"}`: kiểm `GET /admin/keys` có `newKid` `status:"pending"` với đúng
     `activatesAt`, key cũ vẫn `active`. **Không rotate normal lần hai khi còn `pending`**: IdP trả
     `409 {"error":"conflict","error_description":"A newer signing key is already published and does not sign yet. …"}`,
     không đổi gì, audit `SIGNING_KEY_ROTATED result:"failure" reason:"rotation_pending" metadata.pendingKid`. Chờ tới
     `activatesAt`, hoặc dùng emergency nếu key lộ.
   - `403 step_up_required` ⇒ quay lại bước 1. `403 forbidden` ⇒ không phải super_admin.
   - **Không idempotent (DEBT-158)**: 5xx/timeout ⇒ **KHÔNG gọi lại mù**. Kiểm trước:
     `GET /admin/keys` (kid active đã khác kid ở bước 2 chưa?) và
     `GET /admin/audit?action=SIGNING_KEY_ROTATED` (event `result:"success"`, `targetId`=newKid,
     `metadata.mode`, `metadata.oldKid`). Quy tắc dừng (DEBT-389, run 58):
     - **normal** (run 86): so **tập kid** với bước 2 — có kid mới (dù `pending` hay `active`) ⇒ đã xoay, dừng; không
       có kid mới ⇒ mới gọi lại. Không so kid active: trong `KEY_PREPUBLISH_SEC` kid active **không đổi** sau rotate normal.
     - **emergency**: chỉ coi là xong khi `GET /admin/keys` có **đúng 1 item** (`status:"active"`, kid ≠ bước 2).
       Kid active đã đổi mà còn item `retiring` ⇒ emergency **dở** (Vault `config` lỗi sau `rotate`) ⇒ **gọi lại
       emergency**: lần chạy lại hội tụ (min_* = latest, trim), tạo thêm 1 version là chấp nhận được. Dấu hiệu trong
       audit: `SIGNING_KEY_ROTATED result:"failure" reason:"rotate_failed" metadata.mode:"emergency"`.
       Với pre-publish (run 86, Vault): emergency dở thường hiện **kid cũ vẫn `active` + kid mới `pending`** (version mới
       chưa thành sàn) ⇒ cũng là dở ⇒ gọi lại emergency.
     Một lần xoay thừa không phá gì nhưng làm AT mới ký bằng key vừa tạo cũng chết (DEBT-158, chấp nhận).
4. Dev `LocalKeyProvider`: làm theo [runbook-deploy §6](runbook-deploy.md#6-sau-emergency-rotate--kiểm-key_local_dir-debt-163-dev-localkeyprovider)
   (PEM mồ côi; chỉ xoá đúng `<oldKid>.pem`).
5. Cache JWKS ngoài IdP (DEBT-157/349, run 84 D84.2/D84.3):
   - (i) `/jwks.json` trả `Cache-Control: no-cache` trên 200 (GET/HEAD, kèm `Vary: Origin`; lỗi 503 = `no-store`) ⇒
     CDN/proxy phải revalidate mỗi lần, **không được** cấu hình ghi đè thành TTL dài (`max-age`/`s-maxage`, "cache
     everything"). Kiểm qua đúng đường public: `curl -sI $IDP/jwks.json` (xem Xác minh).
   - (ii) Sau emergency: báo **mọi** RP/resource server tự verify JWT **xoá cache JWKS ngay** (restart/reload process
     hoặc lệnh xoá cache của thư viện) — kể cả RP cache ngắn. Lý do: AT giả ký bằng key đã lộ mang đúng `oldKid`, kid
     đó vẫn nằm trong cache nên RP **không** gặp kid lạ và **không** refetch; refetch-theo-kid không giúp gì ở đây.
     RP không xoá cache ⇒ vẫn chấp nhận AT ký bằng key đã lộ trong suốt thời gian cache của nó: với jose
     `createRemoteJWKSet` mặc định (`cacheMaxAge` 10') đó là cửa sổ còn lại **tối đa 10 phút** sau rotate; RP cache
     lâu hơn ⇒ lâu hơn tương ứng. Yêu cầu thường trực với RP: cache JWKS trong process ≤ 10 phút.
   - (iii) fe-admin **không cần** restart: JWKS của nó chỉ verify ID token nhận qua back-channel `/token` (client đã
     xác thực, TLS tới chính IdP); sau emergency IdP không còn ký bằng key đã gỡ nên không token nào ký bằng key
     đó đi vào kênh này (D84.3).
   - (iv) Rotate **normal** (không có key lộ): key mới nằm trong JWKS `KEY_PREPUBLISH_SEC` trước khi ký (run 86,
     DEBT-393) ⇒ RP cache JWKS ≤ `KEY_PREPUBLISH_SEC` đã có kid mới trước token đầu tiên. RP vẫn nên refetch khi gặp
     `kid` lạ (jose `createRemoteJWKSet` mặc định đạt) cho trường hợp emergency.

**Xác minh** (kỳ vọng cụ thể)
- `ADMIN_AT` vừa dùng để xoay cũng ký bằng `oldKid` ⇒ giờ `401`. Đọc kiểm tra bằng AT mới: refresh RT
  admin (`grant_type=refresh_token`) là đủ cho `GET` (`admin.read` không cần step-up).
- `curl -sS $IDP/jwks.json` → `keys[].kid` chỉ có `newKid` (không còn `oldKid` hay key `retiring` nào).
- `curl -sI $IDP/jwks.json` (qua CDN/proxy public) → `200` với `cache-control: no-cache` và `vary: Origin`.
  Output thật (run 84, BE cục bộ trên DB test `vg-int-*`, bỏ các header bảo mật ở giữa):
  ```
  HTTP/1.1 200 OK
  ...
  vary: Origin
  cache-control: no-cache
  content-type: application/json; charset=utf-8
  ```
  Thấy `max-age=…`, `s-maxage` hoặc `Age:` lớn ⇒ CDN đang ghi đè: sửa cấu hình CDN rồi purge `/jwks.json`.
- AT/ID token cũ: admin API → `401 invalid_token`; RP verify theo JWKS → fail.
- Refresh vẫn chạy: `POST /token grant_type=refresh_token` → `200`, AT mới có header `kid = newKid`.
- `GET /admin/keys` → đúng 1 item `{kid:newKid,status:"active"}`.

**Rollback**: **KHÔNG có**. Key cũ đã bị xoá khỏi state, không đưa lại JWKS. Người dùng/RP chỉ cần
đăng nhập lại hoặc refresh.

**Pre-publish trên Vault (run 86)**: version mới của rotate normal ký từ `creation_time + KEY_PREPUBLISH_SEC` (suy ra
lúc đọc, không có job nền); version sàn (đầu tiên / sau emergency) ký ngay. Hai instance rotate normal cùng lúc có thể tạo
**hai** version `pending` (DEBT-603): vô hại (cả hai trong JWKS, active là version mới nhất đã tới `activatesAt`), rotate
normal tiếp theo vẫn `409` tới khi hết pending. Tránh deploy trong `KEY_PREPUBLISH_SEC` sau một rotate normal: version vừa
xoay có thể hiện `pending` trở lại với bản cũ hơn đang ký; vô hại nhưng gây bất ngờ.

**Production (Vault Transit, run 53)** — cùng bước 1–3 và 5 ở trên (bước 4 chỉ cho dev). Emergency trên Vault gồm 3 bước
trong một request: `rotate` → `config min_decryption_version = min_encryption_version = N` → `trim min_available_version = N`.
- **`trim` KHÔNG đảo ngược**: vật liệu key cũ bị huỷ trong Vault. Đúng ý khi key lộ; không có rollback.
- Kiểm trên Vault (token ops, không phải token app): `vault read <mount>/keys/<key>` ⇒ `latest_version` = N,
  `min_decryption_version` = `min_encryption_version` = `min_available_version` = N, `keys` chỉ còn **1** version.
- Instance khác ngừng chấp nhận key cũ trong ≤ 30 s (cache metadata); không instance nào ký được bằng key cũ nữa (Vault chặn).
- `config` lỗi ⇒ response 5xx + audit `result:"failure" reason:"rotate_failed"` (DEBT-389). App luôn ký bằng version
  mới nhất (key mới), nhưng key cũ còn `retiring` trong JWKS và Vault vẫn cho ký bằng version cũ **tới khi chạy lại**.
  Kiểm `GET /admin/keys` (bước 3): còn item `retiring` ⇒ gọi lại emergency; mỗi lần chạy lại tạo thêm 1 version —
  chấp nhận được, lần chạy lại hội tụ (min_* = latest, trim; unit test DEBT-389 trong `vault-transit-key-provider.spec.ts`).
- `trim` lỗi ⇒ rotate vẫn `200`, log ERROR `trim failed after emergency rotation (new kid …)`; key cũ đã không ký/verify được.
  Ops trim tay: `vault write <mount>/keys/<key>/trim min_available_version=N` (N = `latest_version`).

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
( export NODE_ENV=test MONGO_URI='<uri>' ADMIN_SEED_EMAIL='<email>' ADMIN_SEED_PASSWORD='<tạm>'
  pnpm --filter be db:seed -- --dry-run &&   # ⇒ target: <host>/<db>
  read -r -p 'target dung? go yes de chay that: ' ok && [ "$ok" = yes ] &&
  pnpm --filter be db:seed )
```
- **Trước khi chạy**: cổng xác nhận theo §0 — đọc dòng `target:` của dry-run, chỉ gõ `yes` khi đúng (script
  nạp `be/.env` nếu không truyền biến; gõ sai tên biến ⇒ rơi về DB dev). Lệnh thật in lại `target: <host>/<db>` (đã bỏ credential) — ghi vào biên bản;
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
5. Chạy khối cổng xác nhận của §0 với `export MONGO_URI='<uri tới db_mới>'`: dry-run phải in `<db_mới>` rồi mới gõ `yes` cho `db:sync-indexes`
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

## 5. Redis chết / failover Sentinel (run 53c)

**Dấu hiệu**: `/ready` 503 `redis:"down"`; người dùng thấy trang "temporarily unavailable"; RP/RS nhận
`503 temporarily_unavailable` + `Retry-After: 5` ở `/token`, `/userinfo`, `/introspect`; alert HTTP 5xx;
log app `Redis error: …` (không có mật khẩu/URI đầy đủ).

**Không làm**: restart app (không giúp, `/health` vẫn 200), bật fallback memory, FLUSH Redis, đổi
`maxmemory-policy` (phải `noeviction`, runbook-deploy §3).

1. `read -rs REDISCLI_AUTH && export REDISCLI_AUTH` (nhập mật khẩu sentinel, không vào history/`ps`; **không**
   dùng `redis-cli -a`), rồi `redis-cli -h <sentinel> -p 26379 SENTINEL get-master-addr-by-name <master>` ⇒
   master hiện tại; `SENTINEL replicas <master>` / `SENTINEL ckquorum <master>`. Xong: `unset REDISCLI_AUTH`.
2. Master chết + còn replica ⇒ Sentinel tự failover (vài giây); app tự kết nối master mới, 503 hết.
3. `min-replicas-to-write 1`: mẫu có 2 replica ⇒ 1 replica chết vẫn ghi được (khôi phục replica sớm). **Không còn
   replica đồng bộ** ⇒ Redis trả `NOREPLICAS` ⇒ app trả **500 `server_error`, không `Retry-After`** (không phải
   503: `NOREPLICAS` chưa có trong `isRedisUnavailable`, DEBT-402) ở login/`/token`/logout — fail-closed, không
   "thành công giả". Nhận diện: log app `NOREPLICAS`, alert HTTP 5xx; `/ready` có thể vẫn 200 (đọc được) ⇒
   khôi phục replica, `INFO replication` trên master (`connected_slaves`, `lag`).
4. Mất toàn bộ dữ liệu Redis (không backup): mọi người dùng phải đăng nhập lại, code/flow dở bị hỏng; tombstone
   `sess_end:*` mất ⇒ AT đã logout có thể "sống" lại tới hết `ACCESS_TOKEN_TTL` (≤ 15') — ghi biên bản; RT
   (Mongo) không ảnh hưởng.
5. Sau khi hồi phục: `/ready` 200, metric `temporarily_unavailable` về 0. Khi Redis chết hẳn, request lỗi
   **thường** không tiêu code/RT/phiên. Nhưng `Command timed out` không bảo đảm lệnh chưa chạy (Redis chậm,
   failover giữa request): code có thể đã bị tiêu rồi mới timeout ⇒ client thử lại `/token` nhận
   `invalid_grant` ⇒ **bắt đầu lại luồng** (`/authorize`; với RT: đăng nhập lại). Đây là hành vi an toàn,
   không phải lỗi mới.

## 6. Audit: ai thấy IP/User-Agent, thời hạn lưu (run 71, DEBT-344)

- `GET /admin/audit` (và fe-admin Audit/Dashboard): **super_admin** của tenant thấy nguyên `ip` +
  `userAgent`; **tenant_admin** chỉ thấy tiền tố mạng (IPv4 `/24`, IPv6 `/48`) và không có `userAgent`.
  Vai trò đọc mỗi request (giáng super_admin ⇒ request kế tiếp đã che). Không có filter theo IP.
- tenant_admin cần IP đầy đủ cho điều tra (lạm dụng, khoá tài khoản) ⇒ nhờ super_admin tra theo
  `eventId`/`requestId`; không đọc Mongo tay thay cho quy trình này.
- Event cũ hơn `AUDIT_RETENTION_DAYS` (mặc định 180 ngày) bị Mongo TTL xoá — không còn trong API lẫn DB.
  Cần giữ lâu hơn cho một sự cố ⇒ export ngay khi mở sự cố (xem runbook-deploy §1 "Run 71").
- TTL **không** xoá backup Mongo (§4) và log ứng dụng (pino): retention của backup/log theo chính sách
  riêng; restore backup cũ mang lại event cũ, TTL sẽ xoá lại sau ≤ ~60 s khi index có mặt.

## 7. Console fe-admin bị khoá (run 76, DEBT-515/517)

**Dấu hiệu**: đăng nhập fe-admin lỗi ở `/authorize` (`invalid_scope`, `invalid_target`,
`redirect_uri` không khớp) hoặc `/token` (`unauthorized_client`, `invalid_client`), hay admin API trả
`401`/`403 insufficient_scope` cho mọi người dùng console.

- BE đã chặn console tự gỡ scope của token, resource `admin`, `authorization_code`/`refresh_token` hay tự
  disable (409 `conflict`, spec §7 quy tắc 6). Còn khoá được bằng: xoá redirect URI/post-logout URI của
  console, `DELETE` đúng secret version BFF đang dùng (DEBT-517), hoặc sửa từ một client admin-capable khác.
- **Cách 1 (ưu tiên)**: đăng nhập bằng một client admin-capable khác (super_admin) và `PATCH /admin/clients/<console>`
  trả lại `scopes`, `allowedResources` (có `admin`), `grantTypes`, `redirectUris`, `disabled:false`;
  secret mất ⇒ `POST /admin/clients/<console>/secrets` rồi cập nhật secret store của BFF. Có audit.
- **Cách 2 (chỉ khi không còn client admin-capable nào)**: sửa collection `clients` có kiểm soát như
  §3d (2 người, biên bản ngoài hệ thống, **không sinh audit**), qua `d` đã in `DB:`, chỉ đúng 1 document.
  Lệnh này đi vòng qua `validateConfig` (định dạng redirect URI, scope, resource): **chép nguyên giá trị** từ
  cấu hình BFF đang chạy (scope BFF xin, callback URI) hoặc từ document trong bản backup gần nhất (§4),
  **không gõ tay**; người thứ hai đối chiếu từng mảng trước khi chạy.
```js
const r = d.clients.updateOne({ clientId: '<console-client-id>' }, { $set: {
  scopes: [/* scope BFF xin, vd openid email offline_access admin.read admin.write */],
  allowedResources: [/* resourceId hiện có + resourceId của resource admin */],
  grantTypes: ['authorization_code', 'refresh_token'],
  redirectUris: [/* callback của BFF */], disabledAt: null } });
if (r.matchedCount !== 1) throw new Error('clients: matchedCount=' + r.matchedCount);
```
  Secret mất hết ⇒ không tạo secret bằng tay trong DB; sau khi đăng nhập lại được bằng client khác thì
  dùng Cách 1 để phát hành secret.
- **Xác minh**: đăng nhập fe-admin (`prompt=login`) → trang Clients mở được (`GET /admin/clients` `200`).

## 8. Scope ngoài ngữ pháp RFC 6749 §3.3 trong dữ liệu cũ (run 82, DEBT-538)

Từ run 82, `scopes` của client và resource qua admin API chỉ nhận `scope-token` của RFC 6749 §3.3 (ASCII
hiển thị trừ `"` và `\`). Document lưu trước đó có token ngoài ngữ pháp (ZWSP, bidi, chữ có dấu, khoảng
trắng…) vẫn chạy như cũ, nhưng **lần PATCH kế tiếp gửi lại đúng mảng đó sẽ `400`** cho tới khi dọn. Không có
migration tự động. Tìm (chỉ đọc, qua `d` đã in `DB:` như §3d):
```js
const bad = { scopes: { $elemMatch: { $not: /^[\x21\x23-\x5B\x5D-\x7E]+\z/ } } }; // \z, không phải $: regex Mongo (PCRE) cho $ khớp trước \n cuối chuỗi
d.clients.find(bad, { _id: 0, tenantId: 1, clientId: 1, scopes: 1 }).forEach((c) => printjson(c));
d.resources.find(bad, { _id: 0, resourceId: 1, identifier: 1, scopes: 1 }).forEach((r) => printjson(r));
```
- Dọn qua admin API (có audit): client ⇒ `PATCH /admin/clients/<id>` với `scopes` sạch (RP nào đang xin
  token cũ phải đổi theo); resource ⇒ `PATCH /admin/resources/<id>` với `scopes` sạch và `expectedScopes` =
  đúng mảng đang lưu (`expectedScopes` cố ý giữ quy tắc lỏng cũ nên vẫn khớp được token cũ). fe-admin làm việc
  này qua form sửa resource. Ngoại lệ: token đang lưu chứa khoảng trắng/`\n` không qua được cả quy tắc lỏng
  (DEBT-549) ⇒ PATCH qua API **không** kèm `expectedScopes` (last-write-wins) khi không ai đang sửa resource đó.
  Không sửa Mongo tay.

---

## 9. 5xx/timeout khi tạo hoặc rotate client secret (run 84, DEBT-129)

**Dấu hiệu**: `POST /admin/clients/<id>/secrets` trả 5xx hoặc timeout; fe-admin hiện `UNCERTAIN_ISSUE`
(không chắc secret đã được phát). Fail-closed (run 79): audit được ghi **trước** khi trả plaintext, audit lỗi ⇒
5xx và plaintext không bao giờ được gửi. Nhưng version mới có thể **đã** được tạo, và version cũ **đã** vào grace
(`expiresAt` = lúc gọi + `CLIENT_SECRET_GRACE_TTL`) ⇒ client ngừng xác thực khi hết grace nếu không làm gì.

**KHÔNG gọi lại mù** (mỗi lần gọi tạo thêm 1 version mà không ai có plaintext). Các bước (`admin.write` + step-up, §0):
1. `GET /admin/clients/<id>/secrets` → `items[].{version,createdAt,expiresAt,revokedAt,status}`.
   - Version client **đang dùng** = version cũ, giờ `status:"grace"`; ghi lại `expiresAt` của nó = **hạn chót thật**
     để giao secret mới.
   - Version **mồ côi** = version lớn hơn version đang dùng, `createdAt` ≈ thời điểm lỗi, `status:"active"` (đã
     `revoked` nếu lỗi ở bước kiểm lại quyền sau khi ghi — khi đó không cần thu hồi). Không có version mới ⇒ lỗi
     xảy ra trước khi ghi: không có gì để thu hồi, sang bước 4.
2. Kiểm audit: `GET /admin/audit?action=CLIENT_SECRET_ROTATED&targetId=<id>` (secret đầu tiên:
   `action=CLIENT_SECRET_CREATED`) → có event `result:"success"` với `metadata.version` = version mồ côi?
   - **Thiếu** ⇒ đúng ca DEBT-129: ghi audit (Mongo) lỗi. **Khắc phục Mongo/audit trước** rồi mới làm bước 4 — gọi
     lại khi audit còn hỏng chỉ tạo thêm version mồ côi.
   - Có ⇒ request đã xong nhưng phản hồi mất (timeout mạng/proxy): plaintext vẫn mất, làm tiếp như dưới.
3. Thu hồi version mồ côi: `DELETE /admin/clients/<id>/secrets/<version_mồ_côi>` → `204`. **Chỉ** version lớn hơn
   version đang dùng, xác định theo `createdAt`/thời điểm lỗi — **KHÔNG** thu hồi version client đang dùng (thu hồi có
   hiệu lực ngay, không grace ⇒ client chết ngay).
4. Rotate lại **đúng 1 lần**: `POST /admin/clients/<id>/secrets` → `201 {"clientId","version","clientSecret"}`; triển
   khai `clientSecret` cho client **trước `expiresAt` của version cũ** (bước 1). Lần rotate lại **không gia hạn**
   grace: `rotateSecret` chỉ hạ `expiresAt` (version chưa có hạn hoặc có hạn muộn hơn), không bao giờ nâng. Lỡ hạn ⇒
   client nhận `401 invalid_client`; **không có API gia hạn** — chỉ còn cách giao secret mới càng sớm càng tốt. Lại
   5xx ⇒ quay lại bước 1.

**Xác minh** (kỳ vọng cụ thể)
- Client dùng secret mới: luồng thật của RP (`POST /token` `grant_type=authorization_code`/`refresh_token`,
  `client_secret_basic`) → `200`. Kiểm nhanh không cần người dùng:
  `curl -sS -u <client_id>:<secret_mới> -d token=x $IDP/introspect` → `200 {"active":false}` (xác thực client đạt;
  secret sai/đã thu hồi ⇒ `401 {"error":"invalid_client"}`).
- `GET /admin/clients/<id>/secrets`: đúng **1** version `active` (mới nhất), version cũ `grace` với `expiresAt`
  **không đổi** so với bước 1, version mồ côi `revoked`.
- Audit: `CLIENT_SECRET_REVOKED` cho version mồ côi, `CLIENT_SECRET_ROTATED result:"success"` cho version mới.

---

## 10. Email ngoài ngữ pháp D84.1 trong dữ liệu cũ (run 84, DEBT-550/556)

Từ run 84, `/register`, `/forgot`, federation tạo mới/gắn tài khoản và `SmtpMailer` chỉ nhận `local@domain` ASCII hẹp
(D84.1: local `[A-Za-z0-9._+'-]` 1–64 ký tự, không `.` đầu/cuối, không `..`; domain ≥ 2 nhãn LDH, nhãn cuối bắt đầu
bằng chữ, ≤ 253; tổng ≤ 254; không quote, comment, `%`, `!`, IP literal, Unicode). Tài khoản lưu **trước** đó với địa
chỉ ngoài ngữ pháp (vd. quoted local part):
- **vẫn đăng nhập** bằng mật khẩu (`/login` giữ luật cũ) và bằng identity federation **đã liên kết**;
- **không nhận được** thư xác minh/đặt lại mật khẩu: `/forgot` trả `400` trang lỗi chung (như với địa chỉ không có
  tài khoản — không lộ tài khoản tồn tại);
- federation **tạo mới/gắn** với email đó bị chặn (`email_unverified`).

Tìm (chỉ đọc, qua `d` đã in `DB:` như §3d; regex neo `^…\z`, không cờ `m` — `$` của PCRE khớp trước `\n` cuối chuỗi):
```js
const d = db.getSiblingDB('<db>'); print('DB:', d.getName());   // phải = DB app đang dùng
const D841 = /^(?=[^@]{1,64}@)(?=.{1,254}\z)[A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*@(?=.{1,253}\z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z/;
const bad = { email: { $not: D841 } };
print('count:', d.users.countDocuments(bad));
d.users.find(bad, { _id: 1 }).limit(5).forEach((u) => print(u._id.toString()));
```
Output thật (run 84, DB tạm `vg-int-run84-runbook-*` trên `vg-test-mongo`, đã drop; seed = 9 địa chỉ hợp lệ + 30 địa
chỉ bị từ chối lấy từ bảng `be/src/common/validation/email-address.spec.ts`; đối chiếu chéo trên cùng DB: 0 địa chỉ
hợp lệ bị đánh dấu, 0 địa chỉ bị từ chối lọt qua):
```
DB: vg-int-run84-runbook-1794362614
count: 30
6af3cd1785a3fe331b82ef2c
6af3cd1785a3fe331b82ef2d
6af3cd1785a3fe331b82ef2e
6af3cd1785a3fe331b82ef2f
6af3cd1785a3fe331b82ef30
```
Chỉ in `_id` (không đưa email vào ticket/chat). `count: 0` ⇒ không cần làm gì. Khác 0 ⇒ liên hệ người dùng qua kênh đã
xác minh khác, đổi email qua kênh có kiểm soát (từng tài khoản, có người duyệt). **Không sửa hàng loạt** trong Mongo.
