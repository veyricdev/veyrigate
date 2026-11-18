# Runbook — Vận hành sự cố (sso-idp backend)

> File bền (B7.5, run 40). Bổ sung cho [runbook-deploy.md](runbook-deploy.md) — không chép lại:
> §1 `db:sync-indexes`, §3 Redis `noeviction`, §6 PEM mồ côi sau emergency rotate.
> Mọi lệnh/endpoint dưới đây tồn tại trong repo tại thời điểm viết; kịch bản 1–3 và bước §4(i)
> được khoá bằng `be/test/runbook-drill.int-spec.ts` (đổi hành vi ⇒ spec đỏ ⇒ sửa runbook).
> Không ghi secret/PII thật vào ticket, chat, log hay báo cáo: chỉ dùng placeholder `<...>`.

## 0. Chuẩn bị chung

- `IDP` = issuer (vd. `https://idp.example.com`); `ADMIN_AT` = access token `aud=<IDP>/admin` (resource
  `admin`) của user có vai trò phù hợp. Lấy qua authorization code + PKCE của một client admin-capable
  (confidential, `client_secret_basic`, vd. `fe-admin` do `db:seed` tạo). Console **fe-admin** có sẵn cho thao
  tác thường (khoá console ⇒ §7); các bước bằng curl dưới đây dùng khi console không vào được hoặc cần ghi lại
  request/response ⇒ người trực tự chạy luồng: trình duyệt mở `/authorize?...&prompt=login` (hoặc
  `max_age=0`) → lấy `code` → `curl -u <client_id>:<client_secret> -d grant_type=authorization_code ... $IDP/token`.
- **Step-up**: mọi thao tác ghi gắn `@RequireRecentAuth(5)` cần `auth_time` ≤ 5 phút. AT có được từ
  refresh grant KHÔNG có `auth_time` ⇒ luôn `403 {"error":"step_up_required","max_age":0}` ⇒ đăng nhập
  lại với `prompt=login`. Đọc (`GET`) chỉ cần `admin.read`, không cần step-up.
- Gọi admin API: `curl -sS -H "Authorization: Bearer $ADMIN_AT" [-H 'content-type: application/json' -d '<json>'] $IDP/<path>`.
- Truy vấn Mongo tay: `mongosh "mongodb://<hosts>/<db>?replicaSet=rs0&authSource=admin" -u <user>` — URI **không
  credential**, mongosh tự hỏi mật khẩu (`Enter password:`, không vang, không vào history/`ps`; DEBT-258). Mật khẩu
  lấy từ secret store; không dán vào ticket.
  Collection mặc định: `auditlogs`, `refreshtokens`, `users`, `usertenants`, `clients`,
  `clientcredentials`, `consents`, `resources`, `tenants`.
- **Kiểm đích Mongo TRƯỚC mọi CLI ghi** (`db:seed`, `db:seed-dev`, `db:sync-indexes`): không cờ, CLI in
  `target: <host>/<db>` rồi kết nối và ghi **ngay trong vài ms** ⇒ không kịp Ctrl-C (diễn tập run 40).
  Run 78 (DEBT-256/257): cả 3 CLI có `--dry-run` = kiểm env như lệnh thật, in `target:` + `dry-run: no
  connection made`, exit 0, **không kết nối**. Gõ biến **một lần** trong subshell, kiểm khô, rồi lệnh thật
  chỉ chạy sau **cổng xác nhận** (`read` dừng chờ gõ `yes`; dán nguyên khối cũng không tự chạy lệnh ghi)
  trong CÙNG subshell (sau `pnpm --filter be build` — script đọc `be/dist`). Dán CHỈ khối này:
  ```bash
  ( read -rs -p 'MONGO_URI: ' MONGO_URI && echo && export MONGO_URI &&   # + biến không bí mật, vd. NODE_ENV; secret khác (vd. ADMIN_SEED_PASSWORD) cũng `read -rs` như khối §3c, không export inline
    pnpm --filter be db:sync-indexes -- --dry-run &&   # ⇒ target: <host>/<db>
    read -r -p 'target dung? go yes de chay that: ' ok && [ "$ok" = yes ] &&
    pnpm --filter be db:sync-indexes )
  ```
  Đích sai (vd. `target: localhost:27017/sso-idp`) ⇒ gõ gì khác `yes` (hoặc Ctrl-C) ⇒ subshell thoát exit 1,
  không kết nối. **URI không lên argv/history (DEBT-258)**: cả khối là một lệnh ghép, bash parse xong rồi mới
  chạy ⇒ `read -rs` đọc từ bàn phím (không vang), không ăn dòng của khối dán (cùng cơ chế với cổng `yes`); biến
  chỉ sống trong subshell (`/proc/<pid>/environ` chỉ chính user/root đọc được — chấp nhận). Thay thế không gõ tay:
  `MONGO_URI="$(cat <file 0600>)" && export MONGO_URI`. Đổi `db:sync-indexes` thành `db:seed`/`db:seed-dev` ở **cả hai** dòng `pnpm`. Cờ khác
  `--dry-run` (vd. `--dry-run=true`, `--dryrun`, `-n`) ⇒ `unknown argument`, exit 1, không kết nối (DEBT-522).
  (pnpm chuyển `--` + `--dry-run` vào `process.argv`, đã kiểm run 78; script nạp `be/.env` nhưng biến đã
  export thắng. Biến env sai/thiếu ⇒ exit 1 trước khi in đích. Lỗi CLI in `[MONGO_URI]` thay cho URI và bỏ
  `user:password@` — DEBT-254.)
- Metric: `GET $IDP/metrics` cần `Authorization: Bearer <METRICS_TOKEN>` (route chỉ có khi đặt biến).
  Alert: `ops/prometheus/alerts.yml`.
- **Production vs dev (chung)**: production ký bằng **Vault Transit** (`KEY_PROVIDER=vault`, run 53, cấu hình theo
  [runbook-deploy §8](runbook-deploy.md#8-vault-transit-keyprovider-production-run-53)); bước key riêng cho Vault ghi ở cuối §1. `KEY_PROVIDER=local`
  (`LocalKeyProvider`, thư mục `KEY_LOCAL_DIR`) là bản dev, **chỉ hỗ trợ 1 node** (DEBT-159).
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
     Đo ở diễn tập run 87 (jose `createRemoteJWKSet` mặc định, cache đã nóng): sau emergency verifier đó **vẫn nhận AT
     cũ** (0,3 s và 29 s sau rotate) và **từ chối AT mới** (kid lạ nhưng còn trong `cooldownDuration` 30 s ⇒ không
     refetch) — RP không xoá cache vừa nhận token giả vừa từ chối token thật trong ≤ 30 s. Verifier mới (cache rỗng)
     nhận AT mới và từ chối AT cũ ngay.
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
  Đo ở diễn tập run 87 (2 BE, `runs/87-X6-drills/drill-report.md`): rotate 196 ms; JWKS instance xoay = `[newKid]` ngay
  (205 ms); instance kia = `[newKid]` sau 29,1 s và `/userinfo` với AT cũ `401` sau 29,1 s ⇒ trong ~30 s đầu, AT cũ còn
  được instance chưa làm mới cache chấp nhận. Cần cắt ngay trên mọi instance ⇒ restart rolling các instance còn lại.
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
- Còn admin khác ⇒ dùng admin API (unlock, roles). Không còn ai ⇒ dev/test: `db:seed`; production: §3d `admin-recover`.
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
( read -rs -p 'MONGO_URI: ' MONGO_URI && echo &&
  read -rs -p 'ADMIN_SEED_PASSWORD (tam): ' ADMIN_SEED_PASSWORD && echo &&
  export NODE_ENV=test MONGO_URI ADMIN_SEED_PASSWORD ADMIN_SEED_EMAIL='<email>' &&
  pnpm --filter be db:seed -- --dry-run &&   # ⇒ target: <host>/<db>
  read -r -p 'target dung? go yes de chay that: ' ok && [ "$ok" = yes ] &&
  pnpm --filter be db:seed )
```
- **Trước khi chạy**: cổng xác nhận theo §0 — đọc dòng `target:` của dry-run, chỉ gõ `yes` khi đúng (script
  nạp `be/.env` nếu không truyền biến; gõ sai tên biến ⇒ rơi về DB dev). Lệnh thật in lại `target: <host>/<db>` (đã bỏ credential) — ghi vào biên bản;
  nó KHÔNG phải điểm dừng (kết nối/ghi bắt đầu ngay sau đó).
- `NODE_ENV` khác `development|test` ⇒ từ chối trước khi kết nối:
  `seed-dev: refusing to run with NODE_ENV=production (only development|test; never production)` (DEBT-164).
- User đã tồn tại: seed **không đổi mật khẩu, không gỡ khoá** (`$setOnInsert`); chỉ đặt membership `default-tenant` `status:'active'` + thêm `super_admin`.
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

**3d. Production — break-glass: CLI `admin-recover` (run 87, DEBT-252, D87.12–D87.14)**
- Dùng khi **không còn super_admin dùng được** (membership active + `super_admin`, user tồn tại, không bị admin khoá)
  trong `default-tenant`. User cần nâng quyền phải **đã tồn tại** (tự đăng ký + xác minh email); CLI không bao giờ tạo user.
- **Hai người**: người thực hiện (`--requested-by`) và người duyệt (`--approved-by`, tên khác). Env production + credential
  Mongo chỉ mở ra khi có đủ 2 người (secret store). Đây là **kiểm soát thủ tục** (D87.13): ai có `MONGO_URI` quyền ghi đều
  vượt được CLI; kiểm soát thật là secret store 2 người + audit `ADMIN_RECOVERED` ghi **cùng transaction** + alert qua log.
- Chạy bằng **image production đang deploy** với **đúng env của app** (cùng file env đang dùng cho container app; `-i` bắt buộc
  để gõ mã). Kiểm khô trước — không kết nối:
```bash
docker run --rm -i --env-file <env-app-production> <image> node dist/database/admin-recover.js \
  --email '<email>' --requested-by <nguoi-thuc-hien> --approved-by <nguoi-duyet> --ticket <INC-123> --dry-run
# ⇒ target: <host>/<db>        (người duyệt đọc to: phải là DB app production)
# ⇒ dry-run: no connection made, exit 0
```
- Chạy thật = cùng lệnh, bỏ `--dry-run` (thêm `--unlock` nếu user đang bị **admin** khoá). CLI in kế hoạch rồi mới hỏi mã:
  `target: <host>:<port>/<db>`, `user: <id>`, `membership default-tenant: ...`, `locked: yes|no`, `usable super_admins: N`,
  hai tên, ticket, rồi `confirmation code: 1234-5678`. **Người duyệt đọc to** target, user id, N; đúng ⇒ gõ lại mã (một dòng,
  ≤ 120 s). Thành công ⇒ `recovered: user <id>, audit event <eventId>` + dòng JSON `{"alert":true,"action":"ADMIN_RECOVERED",...}`,
  exit 0. CLI **không in email**. **Bắt buộc (DEBT-618)**: dán nguyên dòng JSON `{"alert":true,...}` + `eventId` vào
  kênh incident/security **ngay** và ghi vào ticket — CLI chạy ngoài app nên không có alert listener; output của
  `docker run --rm` trên host ops thường không vào pipeline log, nên dòng dán tay này là alert.
- Từ chối (exit 1, không đổi membership/user, ghi audit `ADMIN_RECOVERED` failure nếu ghi được):
  - `refused: user_not_found` — email sai/chưa đăng ký (email được chuẩn hoá trim + chữ thường);
  - `refused: super_admin_exists` — còn super_admin dùng được ⇒ dùng admin API của người đó. Chỉ khi super_admin còn đó nhưng
    **không ai đăng nhập được** (đã nghỉ, mất hộp thư): thêm `--allow-existing-super-admin` (audit `forced:true`, ghi lý do vào ticket);
  - `refused: target_locked` — user bị admin khoá: chạy lại với `--unlock` (gỡ `lockedUntil`/`adminLockLevel`, audit `unlocked:true`);
  - `refused: not_confirmed` — sai mã, EOF hoặc quá 120 s ⇒ chạy lại từ đầu (mã mới mỗi lần).
- Lỗi khác (`admin-recover failed: ...`, exit 1) ⇒ không ghi gì (transaction abort): Mongo không tới được (5 s), DB không có
  `default-tenant` (sai `MONGO_URI`), Mongo standalone (không có transaction), audit không ghi được. Tham số sai ⇒ exit 1
  trước khi kết nối, không echo giá trị.
- Recover thường (không `--reset-mfa`) không chạm Redis, không thu hồi phiên. Sau khi phục hồi: user đăng nhập
  `prompt=login`; nghi lộ ⇒ đổi mật khẩu ở `/account/password` (thu hồi mọi phiên, D85.6). `--reset-mfa` thu hồi
  phiên sau commit: xem §11 (run 95, D95.8).
- Exit code (D95.5):

  | Code | Nghĩa |
  |---|---|
  | `0` | recovered; nếu `--reset-mfa` thì phiên Redis + sweep family đã xong |
  | `1` | từ chối / lỗi trước commit / tham số sai — không ghi gì (trừ audit failure) |
  | `3` | **Mongo đã commit**, nhưng thu hồi phiên Redis lỗi / quá 10 s (`(redis)`) hoặc sweep family lỗi (`(sweep)`) (chỉ `--reset-mfa`) ⇒ §11 (xử lý khác nhau theo nhánh), **không chạy lại CLI** |
- **Đường cuối, chỉ khi image không chạy được**: mongosh trên đúng 1 user đã tồn tại, mọi lệnh qua `d`, người chứng kiến đọc to
  `DB:`. ⚠ **Không sinh audit event** ⇒ biên bản ngoài hệ thống (thời gian, 2 người, lý do, lệnh):
```js
const d = db.getSiblingDB('<db_production>'); print('DB:', d.getName());   // phải = DB app production đang dùng
const u = d.users.findOne({ email: '<email-chuẩn-hoá-chữ-thường>' }, { _id: 1 });
if (!u) throw new Error('không thấy user');                                   // KHÔNG tạo user bằng tay
const r1 = d.usertenants.updateOne({ userId: u._id, tenantId: 'default-tenant' },
  { $set: { status: 'active' }, $addToSet: { roles: 'super_admin' } });
if (r1.matchedCount !== 1) throw new Error('membership default-tenant: matchedCount=' + r1.matchedCount);
// chỉ khi đang khoá (cùng phiên): d.users.updateOne({ _id: u._id }, { $unset: { lockedUntil: 1, adminLockLevel: 1 } })
```

**Xác minh**
- Đăng nhập (`prompt=login`) → `ADMIN_AT` → `GET /admin/keys` → `200` (chỉ super_admin mới được).
- `GET /admin/audit?action=ADMIN_RECOVERED` thấy event (`metadata.requestedBy/approvedBy/ticket`); alert từ log đã bắn.
- Xem lại `GET /admin/users` để gỡ quyền thừa.

**Rollback**: gỡ vai trò bằng `PATCH /admin/users/<userId>/roles` (super_admin, step-up; không tự sửa chính mình).

---

## 4. Backup / restore MongoDB

**Phạm vi**: chỉ Mongo. Redis (session, authorize-context, tombstone, one-time code) là trạng thái tạm,
**không backup**: mất Redis ⇒ người dùng đăng nhập lại; cấu hình theo [runbook-deploy §3](runbook-deploy.md#3-redis--maxmemory-policy-noeviction-debt-049).
Signing key (`KEY_LOCAL_DIR`/Vault Transit) KHÔNG nằm trong Mongo (INV-19). Backup storage Vault ngoài phạm vi
(DEBT-391): mất storage Vault ⇒ tạo transit key mới theo runbook-deploy §8 và xử lý như emergency (§1: mọi token cũ chết).

**Chính sách (run 87, D87.2–D87.9)**

| Mục | Quyết định |
|---|---|
| Cơ chế | `mongodump --archive --gzip --db=<db>` **mỗi giờ phút :17 UTC**, đọc từ secondary (`readPreference=secondary` trong URI của config). Không `--oplog` (chỉ chạy khi dump cả instance) ⇒ snapshot không nhất quán tuyệt đối giữa collection; chấp nhận vì restore luôn chạy §4c (thu hồi mọi RT) + §4d + `db:sync-indexes`. Replica set lo mất node; backup cho lỗi logic, thao tác nhầm, mất site. |
| Công cụ | image `mongo:7.0.43@sha256:1f995ad…` (cùng major với server) hoặc database-tools 100.x trên host backup; `gnupg` ≥ 2.3 của distro trên host backup và host restore (gói hạ tầng, không tải trong repo). |
| RPO / RTO | **RPO ≤ 1 h** (khoảng cách hai backup thành công; alert ở 2 h). **RTO ≤ 2 h** từ quyết định restore tới mở lại traffic (gồm §4d làm tay); phần kỹ thuật (giải mã + restore + §4c + `db:sync-indexes` + boot) **≤ 30 phút** với archive ≤ 1 GB. |
| PITR | **Không** ở bản phát hành này (D87.4): PITR oplog tự dựng không rename được namespace (phá quy tắc restore vào DB mới của 4b); công cụ đúng là Percona Backup for MongoDB ⇒ DEBT-610. |
| Mã hoá | `gpg` khoá công khai (`--recipient-file <backup-pub.asc> --cipher-algo AES256 --compress-algo none`). Host backup **chỉ giữ public key**. Private key có passphrase, sinh offline: file key ở secret store A (ops lead), passphrase ở secret store B (người thứ hai) ⇒ **restore cần 2 người**. Xoay key hằng năm; giữ private key cũ tới khi bản cuối mã hoá bằng nó hết retention. **Ký nguồn gốc (DEBT-617)**: mỗi archive còn được **ký** bằng khoá ký riêng của host backup (`--sign --local-user <BACKUP_SIGN_KEY>`; private key sinh trên chính host đó, chỉ ở `GNUPGHOME` của user chạy job, không passphrase hoặc agent cache); fingerprint của nó được **pin** ở secret store B và đưa cho restore qua `BACKUP_SIGNER_FPR`; public key ký nạp vào keyring của host restore. Mã hoá bằng khoá công khai không chứng minh ai tạo file — ai có public key + quyền ghi bucket đều dựng được archive + manifest hợp lệ ⇒ restore từ chối mọi archive không có `VALIDSIG` của fingerprint đã pin. Xoay khoá ký cùng lịch; host backup bị lộ ⇒ thu hồi khoá ký, pin khoá mới, coi các bản ký sau thời điểm lộ là không tin cậy. **Vòng đời khoá ký (senior R2-2)**: restore từ chối `EXPKEYSIG`/`REVKEYSIG` ⇒ khoá ký **không đặt hạn** (`--quick-gen-key … never`); xoay định kỳ = **ngừng dùng** (đổi `BACKUP_SIGN_KEY` sang khoá mới), **không** thu hồi, không để hết hạn — nếu không, bản ≤ 35 ngày ký bằng khoá cũ không restore được; **chỉ thu hồi khi khoá bị lộ**. Giữ public key ký cũ trong keyring host restore và fingerprint cũ ở secret store B tới khi bản cuối ký bằng nó hết retention; restore bản cũ ⇒ `BACKUP_SIGNER_FPR` = fingerprint đã ký bản đó. |
| Retention | Bản hằng giờ giữ **48 h** trên host backup (thư mục `0700`, đĩa mã hoá; script tự prune theo mẫu tên). Bản 00:17 UTC chép offsite, giữ **35 ngày** (lifecycle rule). Không có bản tháng. Audit có TTL 180 ngày riêng. |
| Nơi lưu / quyền | Offsite = object storage ở **failure domain khác** production (khác region/tài khoản), versioning + **object lock 35 ngày**. Credential job backup chỉ `put`; credential restore chỉ đọc, ops giữ. Mongo: user `backup` (role `backup`) cho dump; user `restore` (role `restore`) chỉ tạo khi restore. URI có mật khẩu chỉ nằm trong file `--config` mode `0600` (YAML `uri: …`), **không bao giờ trên argv**; script từ chối `MONGO_URI` có `@`. |
| Giám sát | Script ghi `veyrigate_backup_last_success_timestamp_seconds{db}` vào textfile collector (`BACKUP_TEXTFILE_DIR`) chỉ khi **mọi** bước thành công; alert `SsoMongoBackupStale` (> 2 h hoặc thiếu metric, `for: 10m`, `ops/prometheus/alerts.yml`). Mỗi lần chạy tự kiểm `sha256` + `gpg --list-packets`. **Diễn tập restore đầy đủ mỗi quý** và sau thay đổi schema lớn: `node be/scripts/drills/backup-restore-drill.mjs`. |
| Biên bản | Mỗi lần restore: ai (2 người), khi nào, ticket, file backup (tên + sha256), số document. |

**4a. Backup** — `ops/backup/mongo-backup.sh <db> <out-dir>` (cron hằng giờ :17 trên host backup):
```bash
# /etc/veyrigate/backup.yaml (0600, owner = user chạy job):  uri: mongodb://backup:<pw>@<hosts>/?replicaSet=rs0&readPreference=secondary&authSource=admin
MONGO_BACKUP_CONFIG=/etc/veyrigate/backup.yaml BACKUP_PUBKEY=/etc/veyrigate/backup-pub.asc \
  BACKUP_SIGN_KEY=<fpr khoá ký của host backup> BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  ops/backup/mongo-backup.sh <db> /srv/backup/mongo
# ⇒ mongo-backup: ok idp-<db>-<UTC>.archive.gz.gpg (<n> collections, <N> documents, <bytes> bytes)
```
- Kết quả: `idp-<db>-<yyyymmddTHHMMSSZ>.archive.gz.gpg` + `.manifest.json` (`db`, thời gian, phiên bản tool, số
  document từng collection lấy từ dòng `done dumping`, `totalDocuments`, `bytes`, `sha256`). Archive rõ không bao giờ
  chạm đĩa (`mongodump | gpg --sign --encrypt` → `.partial`; manifest cũng ghi `.partial`; **cả hai** chỉ đổi sang tên
  chuẩn ở bước cuối). Lỗi bất kỳ bước nào ⇒ exit ≠ 0, xoá `.partial`, không ghi metric; mongodump lỗi ⇒ in 20 dòng
  cuối log của nó ra stderr (URI có credential bị che).
- Dump DB không tồn tại (0 collection) = lỗi. `MONGODUMP` đổi lệnh dump (vd. `docker exec <container-mongo> mongodump`
  — khi đó dùng `MONGO_URI` không credential, vì `--config` là đường dẫn host).
- Offsite: chép bản 00:17 UTC (`.gpg` + `.manifest.json`) bằng credential chỉ `put`.

**4b. Restore (luôn vào DB MỚI, không `--drop` lên DB đang chạy)** — cần 2 người (key + passphrase, D87.5)
1. Dừng ghi: scale app về 0 (hoặc dừng tiến trình) — tránh client ghi vào DB cũ trong lúc chuyển.
2. Lấy `.gpg` + `.manifest.json` (credential chỉ đọc), nạp private key vào `GNUPGHOME` tạm (`0700`) trên host restore,
   rồi (tạo user Mongo `restore` khi cần; file config `0600` như 4a):
   ```bash
   MONGO_RESTORE_CONFIG=/etc/veyrigate/restore.yaml BACKUP_SIGNER_FPR=<fpr đã pin ở secret store B> \
     ops/backup/mongo-restore.sh idp-<db>-<UTC>.archive.gz.gpg <db> <db_mới>
   # ⇒ mongo-restore: ok <db> -> <db_mới> (<N> documents, 0 failed)
   ```
   Script từ chối **trước khi kết nối**: tuỳ chọn bất kỳ (`--drop`…), `<db_mới>` = `<db>`, tên sai, thiếu manifest,
   manifest của DB khác, `sha256` không khớp, và archive **không có chữ ký hợp lệ của fingerprint đã pin** (một lượt
   giải mã + kiểm chữ ký ra `/dev/null` trước, nên không gì tới mongorestore); rồi từ chối `<db_mới>` đã tồn tại.
   Lấy file từ bucket có object lock và đối chiếu `sha256` với bản offsite. **Chọn archive theo metadata object lock**
   (thời điểm ghi/retention của bucket), không theo tên file hay manifest: chữ ký chỉ chứng minh host backup tạo ra file,
   **không** ràng buộc tên DB hay thời điểm dump ⇒ một bản cũ hơn (đã ký hợp lệ) đổi tên vẫn qua kiểm chữ ký (senior R2-3).
   Thành công chỉ khi dòng cuối của
   mongorestore là `N document(s) restored successfully. 0 document(s) failed` với N = `totalDocuments` của manifest.
   **Mọi lỗi sau khi bắt đầu ghi** (lệch số document, `decryption or mongorestore failed` — gpg chỉ phát hiện tag
   MDC/AEAD hỏng hoặc chữ ký sai ở **cuối** luồng, khi mongorestore đã ghi) ⇒ exit 1 với câu
   `<db_mới> may be partially written: do NOT use it, drop it` ⇒ **không dùng** `<db_mới>`, drop nó, điều tra.
   Gpg hỏi passphrase (người thứ hai gõ; hai lượt giải mã, agent cache lượt hai). Xong ⇒ `gpgconf --kill gpg-agent`
   và xoá `GNUPGHOME` tạm.
3. So số liệu: mỗi collection `countDocuments()` của `<db_mới>` khớp `collections` của manifest; `getIndexes()` cùng
   tên index như nguồn:
   `const d=db.getSiblingDB('<db_mới>'); d.getCollectionNames().sort().forEach(c=>print(c, d[c].countDocuments(), d[c].getIndexes().map(i=>i.name).sort().join(',')))`
4. **Bắt buộc — thu hồi toàn bộ RT (4c)** trên `<db_mới>`, app vẫn tắt (mongosh: mọi lệnh ghi qua
   `const d = db.getSiblingDB('<db_mới>')`, không qua `db` trần). **Chưa làm 4d** — 4d cần admin API.
5. Chạy khối cổng xác nhận của §0, ở prompt `MONGO_URI:` nhập URI tới `<db_mới>` (hoặc đọc từ file 0600): dry-run phải in `<db_mới>` rồi mới gõ `yes` cho `db:sync-indexes`
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
Chạy **file** `ops/backup/revoke-all-refresh-tokens.mongosh.js` (cùng file harness diễn tập dùng): DB lấy từ `TARGET`,
**không** từ `db` trần (mongosh mở bằng URI production thì `db` là DB **đang chạy/cũ** ⇒ thu hồi nhầm = đăng xuất hàng
loạt, còn `<db_mới>` giữ RT sống lại). File dừng (exit 1) nếu `TARGET` sai mẫu, DB không tồn tại, không có collection
`refreshtokens` (gõ sai tên ⇒ `0` giả) hoặc còn RT sống sau update. URI (có mật khẩu) **không lên argv** (DEBT-616): đọc
từ file config `0600` vào biến shell, script đi qua stdin, mongosh đọc stdin như **file** (`/dev/stdin`: lỗi ⇒ exit 1;
không dùng chế độ REPL vì REPL chạy tiếp sau `throw` và exit 0):
```bash
URI="$(sed -n 's/^uri:[[:space:]]*["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}[[:space:]]*$/\1/p' /etc/veyrigate/restore.yaml | head -n1)"
case "$URI" in ''|*\'*|*\\*) echo 'URI rong hoac co ky tu khong ho tro (quote/backslash): dung lai'; unset URI; false ;; esac &&
{ printf "db = connect('%s');\nconst TARGET='%s';\n" "$URI" '<db_mới>'; cat ops/backup/revoke-all-refresh-tokens.mongosh.js; } |
  mongosh --nodb --quiet /dev/stdin; unset URI
# Tách URI giống mongo-restore.sh (bỏ quote YAML '…'/"…"); URI có ' hoặc \ bị từ chối (sẽ phá chuỗi JS) — senior R2-1.
# ⇒ DB: <db_mới>   (người chứng kiến đọc to)
# ⇒ active RT: 0
# ⇒ total RT: <n>   (> 0 nếu dump có RT; đối chiếu collections.refreshtokens của manifest)
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

**Production vs dev**: cùng script; production dùng `--config` 0600 + user `backup`/`restore`, diễn tập dùng
`MONGO_URI` không credential qua `docker exec`. Diễn tập: `runs/87-X6-drills/drill-report.md` (harness
`be/scripts/drills/backup-restore-drill.mjs`, DB `vg-drill-*`); bản cũ `runs/40-B7.5/drill-report.md`.

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
  đường mongosh cuối của §3d (2 người, biên bản ngoài hệ thống, **không sinh audit**), qua `d` đã in `DB:`, chỉ đúng 1 document.
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

## 11. Mất yếu tố thứ hai (MFA) / mã bị chặn (run 89, D89.16, D89.17, D89.25)

Ai được yêu cầu: chính chủ tài khoản. **Trước khi reset**, xác minh danh tính qua **kênh thứ hai** độc lập với
email/mật khẩu (ASVS 6.4.4): gọi lại số điện thoại trong hồ sơ nhân sự, gặp trực tiếp, hoặc quản lý trực tiếp xác nhận
trên kênh nội bộ đã biết. Ghi ticket (ai yêu cầu, ai xác minh, cách xác minh). Không reset chỉ vì một email/chat.

Thử trước (không cần admin):
- Còn **mã khôi phục** (mất thiết bị, D89.27) ⇒ đăng nhập bằng mã khôi phục ở ô "Code", rồi `/account/mfa`: ô
  "Authenticator code or recovery code" nhận **mật khẩu + một mã khôi phục khác** (mỗi mã dùng một lần) để
  "Create new recovery codes" hoặc "Turn off two-step verification", rồi bật lại với thiết bị mới. Audit
  `MFA_RECOVERY_USED {via:'account'}` + `MFA_DISABLED`/`MFA_RECOVERY_REGENERATED` `{factor:'recovery_code'}`.
- Trang bước 2 báo "Authenticator codes are blocked…" (D89.25: 50 mã sai **liên tiếp**, alert `AUTH_MFA_LOCKED`
  + thư cho user) ⇒ chỉ **mã khôi phục** mở lại (D89.28: `/forgot` **không** mở — kẻ có cả mật khẩu lẫn hộp thư không
  được thêm lượt đoán). Hết mã khôi phục ⇒ reset qua admin bên dưới, sau xác minh kênh 2. Alert này nghĩa là **có người
  khác đang có mật khẩu**: user phải đổi mật khẩu ngay.
- **Quy tắc alert (D89.28)**: `AUTH_MFA_LOCKED` **≥ 2 lần trong 24 h cho cùng `targetId`** ⇒ on-call khoá tài khoản ngay
  (`POST /admin/users/{id}/lock`), liên hệ chủ tài khoản qua kênh 2, chỉ mở khoá + đổi mật khẩu + reset MFA sau khi xác minh
  (kẻ tấn công có thể đang giữ cả mật khẩu lẫn hộp thư).

Reset qua admin API (đường chính, còn admin khác):
- fe-admin ⇒ chi tiết user ⇒ "Reset two-step verification", hoặc `POST /admin/users/{id}/mfa/reset` (`admin.write`,
  token có `auth_time` < 5'). Trả `204` kể cả khi user không có MFA (idempotent: lỗi mạng ⇒ tải lại rồi bấm lại được).
- Kết quả: gỡ `User.mfa`, đăng xuất mọi phiên, thu hồi mọi refresh family + thiết bị tin cậy, thư cho user, audit
  `ADMIN_USER_MFA_RESET` (alert) `{wasEnrolled}`. 5xx + audit `revoke_failed` ⇒ MFA **đã** gỡ (thư đã gửi ngay khi gỡ,
  D89.26), bấm lại để thu hồi nốt.
- tenant_admin không reset được tài khoản có vai trò admin / còn active ở tenant khác (403, audit `target_super_admin`
  hoặc `target_not_allowed`); người cần là super_admin.
- Ngay sau reset user phải enroll lại ở `/account/mfa` (enroll ⇒ revoke-all) trước khi vào console.

Reset bằng CLI (không còn admin nào dùng được console, vd. super_admin duy nhất mất thiết bị):
```bash
docker run --rm -i --env-file <env app> "$IMG" node dist/database/admin-recover.js \
  --email <email> --requested-by <a> --approved-by <b> --ticket <ref> --reset-mfa --dry-run   # in kế hoạch, KHÔNG kết nối
docker run --rm -i --env-file <env app> "$IMG" node dist/database/admin-recover.js \
  --email <email> --requested-by <a> --approved-by <b> --ticket <ref> --reset-mfa [--allow-existing-super-admin]
```
- ⚠ `admin-recover` **luôn cấp `super_admin`** (+ membership active) cho `--email`: chỉ dùng cho tài khoản sẽ là
  super_admin. **KHÔNG** dùng để reset MFA cho user thường — user thường dùng admin API ở trên.
- Như §3d (hai người, mã xác nhận gõ lại); kế hoạch in thêm `mfa: enrolled -> reset`. Trong **một** transaction: cấp lại
  `super_admin`, gỡ `mfa`, thu hồi mọi refresh family (Mongo), audit `ADMIN_RECOVERED {mfaReset:true}`; dán dòng
  `{"alert":true,…}` vào kênh sự cố.
- Sau commit (run 95, DEBT-634, D95.8) CLI thu hồi **mọi phiên** Redis + thiết bị tin cậy + sweep refresh family
  (cùng đường với `POST /admin/users/{id}/sessions/revoke`), in `sessions revoked: <n>`, audit
  `SESSION_REVOKED {via:'admin_recover', recoveredEventId, count}`. Kế hoạch (cả `--dry-run`) in thêm
  `sessions: revoked in Redis after commit`.
- **Exit 3** (audit `SESSION_REVOKED` failure `revoke_failed {failedStep}`) ⇒ Mongo **đã** đổi (super_admin cấp, MFA gỡ,
  family thu hồi trong transaction). **Không chạy lại CLI.** Ghi ticket (exit code, dòng warning, `eventId`). Hai nhánh
  (run 95, DEBT-692):
  - `warning: recovered, but sessions were NOT revoked (redis): see runbook-ops section 11` (`failedStep:'sessions'`):
    Redis lỗi **hoặc chỉ chậm** (quá 10 s). Redis chậm ⇒ phiên cũ **có thể vẫn sống** và dùng được ở RP khác; chỉ khi
    Redis chết hẳn thì login/SSO mới không đọc được phiên. Sửa Redis theo §5, rồi:
    - (a) còn admin khác ⇒ gọi `POST /admin/users/{id}/sessions/revoke` ngay;
    - (b) không còn ⇒ user đăng nhập và enroll MFA ở `/account/mfa` trước mọi việc khác (enroll ⇒ thu hồi mọi phiên,
      family và thiết bị tin cậy, D89.13).
  - `warning: recovered, sessions revoked: <n>, but refresh families were NOT swept (sweep): see runbook-ops section 11`
    (`failedStep:'sweep'`): phiên Redis + thiết bị tin cậy **đã** thu hồi; chỉ bước sweep family sau Redis (Mongo) lỗi,
    nên một family do `/token` tạo giữa commit và revoke có thể còn sống. **Không** cần sửa Redis: kiểm Mongo (`/ready`,
    replica set), rồi (a) hoặc (b) ở trên (cả hai đều sweep lại family).
- Dòng `warning: trusted devices were not forgotten (redis)` (exit vẫn `0`/`3` theo bước khác): nếu không kèm dòng `(redis)` thì phiên đã thu hồi nhưng
  thiết bị tin cậy còn ⇒ thiết bị đó chỉ được giới hạn thử `/login` nới hơn, không bỏ qua được mật khẩu/MFA. Khi Redis ổn,
  gọi (a) hoặc làm (b) để xoá; ghi vào ticket.

## 12. Xoay `MFA_ENCRYPTION_KEYS` (run 89, D89.12)

Seed TOTP mã hoá AES-256-GCM bằng khoá trong env (`kid:base64`, phần tử đầu = khoá hiện hành), AAD gắn `userId`.
1. Sinh khoá: `openssl rand -base64 32`; lưu ở secret store (KHÔNG cùng chỗ backup Mongo — backup + khoá = lộ seed).
2. Thêm khoá mới **lên đầu**: `MFA_ENCRYPTION_KEYS=k2:<mới>,k1:<cũ>` cho app **và** mọi CLI (`db:bootstrap`,
   `db:admin-recover`, `db:sync-indexes` đều chạy `validateEnv` đầy đủ). Deploy.
3. Mỗi lần user nhập đúng TOTP, seed được mã hoá lại bằng khoá hiện hành trong cùng update (lười, không có CLI hàng loạt —
   DEBT-635). Đếm còn bao nhiêu seed dùng kid cũ (chỉ đọc, qua `d` đã in `DB:` như §3d):
   ```js
   const d = db.getSiblingDB('<db>'); print('DB:', d.getName());
   print('k1 left:', d.users.countDocuments({ 'mfa.secret.kid': 'k1' }));
   ```
4. Chỉ gỡ `k1` khỏi env khi số trên = 0. Gỡ sớm ⇒ user đó không đăng nhập được bước 2 (giải mã lỗi = sai mã, log ERROR
   có `kid`) ⇒ phải reset MFA (§11).
5. **Mất mọi khoá** (hoặc lộ khoá): mọi user mất MFA. Mở ticket sự cố, đặt khoá mới, rồi reset MFA hàng loạt có ticket:
   ```js
   const d = db.getSiblingDB('<db>'); print('DB:', d.getName());
   print('enrolled:', d.users.countDocuments({ mfa: { $exists: true } }));   // dry-run: in số trước
   // d.users.updateMany({ mfa: { $exists: true } }, { $unset: { mfa: 1 } })  // chạy khi 2 người đã duyệt
   ```
   Sau đó thu hồi phiên (`POST /admin/users/{id}/sessions/revoke` hoặc xoay `sess:*` theo §5) và báo user enroll lại.
   Khoá bị lộ (không mất) ⇒ thêm khoá mới lên đầu (bước 2), chờ đăng nhập mã hoá lại, cân nhắc reset hàng loạt vì backup
   cũ + khoá lộ vẫn giải được seed cũ.

## 13. Lỗi ghi nền đăng ký / quên mật khẩu / gửi thư (run 91, DEBT-666)

Từ run 90 (DEBT-659/660) `/register` và `/forgot` luôn trả trang thành công chung; việc ghi phụ thuộc tài khoản chạy tách rời
sau phản hồi. Lỗi ở đó không thành 5xx: người dùng thấy "đã gửi" nhưng không có tài khoản/token/thư.

**Dấu hiệu**: alert `SsoBackgroundWriteFailed` (critical) hoặc `SsoAuthMailFailed` (warning), nhãn `what`; counter
`sso_background_write_failures_total{what}`; log app ERROR `<what> background write failed: <lớp lỗi + frame>` hoặc
`Authentication email delivery failed`.

| `what` | Việc hỏng | Hệ quả cho người dùng |
|---|---|---|
| `register` | tạo user / membership / token xác minh của email mới | không có tài khoản (hoặc có nhưng thiếu token/thư) |
| `forgot` | ghi token đặt lại mật khẩu | không nhận thư đặt lại |
| `resend_verify` | phục hồi đăng ký chưa xác minh qua `/register` lặp lại: ghi token **đặt lại** + thư "Finish creating your account" (DEBT-665, D91.4) | không nhận thư hoàn tất đăng ký |
| `auth_mail` | SMTP từ chối/không tới được khi gửi thư xác minh hoặc đặt lại (token đã ghi) | thư không tới |

**Tra cứu**: lọc log app theo khoảng thời gian alert, chuỗi `background write failed` / `Authentication email delivery failed`.
Log **không** có email (cố ý, không lộ PII, không dò được tồn tại) ⇒ không tra được người dùng cụ thể; chỉ biết số lượng và thời điểm.

**Thao tác**:
1. Kiểm phụ thuộc: `GET /ready` (Mongo/Redis), §5 nếu Redis; SMTP (kết nối, hạn mức, thông tin đăng nhập) nếu `auth_mail`.
2. Sửa phụ thuộc; xác nhận counter ngừng tăng (alert tự hết sau 15 phút không có sự kiện mới).
3. Người dùng bị ảnh hưởng tự phục hồi, **không** có thao tác DB nào. Hướng dẫn theo `what`:
   - `register` ⇒ đăng ký lại cùng email. Tài khoản chưa được tạo ⇒ thành đăng ký mới; đã tạo mà chưa xác minh ⇒ nhận thư
     "Finish creating your account" (link đặt mật khẩu) và đặt mật khẩu qua link đó.
   - `forgot` ⇒ dùng `/forgot` lại.
   - `resend_verify` ⇒ đăng ký lại sau 30 phút (token đặt lại cũ hết hạn), hoặc dùng `/forgot`.
   - `auth_mail` ⇒ token đã ghi nhưng thư không tới. Hướng dẫn dùng **`/forgot`** (luôn phát token mới; đặt lại mật khẩu
     thành công cũng xác minh email, D91.5). Đăng ký lại cũng được: tài khoản chưa xác minh nhận thư "Finish creating your
     account" ngay, trừ khi còn token đặt lại sống (30 phút) — không gửi lại thư **xác minh**.
   Từ run 91 (D91.14) trang `/verify-email` đòi cả mật khẩu tài khoản; ai không biết mật khẩu (kể cả tài khoản do người khác
   tạo bằng email của mình) dùng `/forgot`.

**Thư bị bỏ (run 95, DEBT-683)**: mailer SMTP giữ tối đa `MAX_PENDING_MAIL = 200` thư chưa xong (đang gửi + chờ trong pool);
gauge `sso_mail_queue_depth`. Thư bị bỏ đếm ở `sso_mail_dropped_total{reason}`, alert `SsoMailDropped` (warning, nhãn `reason`).
Mailer không log từng thư bị bỏ (caller đã log `Authentication email delivery failed` cho thư xác minh/đặt lại, và đếm `auth_mail`).

| `reason` | Nguyên nhân | Thao tác |
|---|---|---|
| `queue_full` | SMTP chậm/chết, hoặc spam `/forgot`/`/register` vượt throttle | xử lý như `auth_mail` ở trên (kiểm SMTP; người dùng dùng `/forgot`) |
| `shutdown` | thư còn chờ khi app dừng (deploy/restart); log WARN `mail queue closed with <n> unsent message(s)` | người dùng bị ảnh hưởng dùng `/forgot`; deploy lúc ít tải |
