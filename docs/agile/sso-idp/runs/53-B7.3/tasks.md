# Tasks — run 53 — B7.3: Dockerfile BE + Vault Transit KeyProvider + Redis Sentinel (M7, lane BE)

> Plan §6 B7.3: "`be/Dockerfile` multi-stage, non-root; compose prod mẫu; hướng dẫn Redis Sentinel/Cluster; **cài KeyProvider thật**; fallback Redis-down đúng §6.2 (không dùng memory cục bộ)". Nghiệm thu: "Image chạy; kill Redis → endpoint cần state trả lỗi rõ, không im lặng sai".
> Q5 đã chốt (2026-10-21): **HashiCorp Vault Transit** (ký qua Transit, self-host) + **Redis Sentinel self-host**.
> Size L ⇒ tech-lead đã tách run (xem fold): **53 = Vault Transit KeyProvider**, 53b = Dockerfile BE, 53c = Redis Sentinel + Redis-down 503.
>
> Hạ tầng: KHÔNG compose up trên `aegate-*`, KHÔNG FLUSH/drop. Không đụng `be/keys`, `be/.env`. Vault/Redis Sentinel cho test chỉ dựng container tạm có tên riêng (tech-lead quy định) và dọn đúng tên; không push image.

## Run 53 (làm ở run này) — backend-dev, thứ tự A → B → C

### [x] Task A [BE]: `KeyProvider` không trả private key — `signJwt` + helper JWS; `LocalKeyProvider`/`TokenSigner`/`TokenVerifier` chuyển sang interface mới (hành vi token không đổi).
### [x] Task B [BE]: `VaultTransitKeyProvider` — ký qua Transit (`sign`, `pkcs1v15`), JWKS từ public key Transit (kid = thumbprint), rotate normal/emergency qua Transit, cache + kid-hint; chọn provider bằng env, prod cấm `local`; test với Vault dev container tạm.
### [x] Task C [BE/ops]: script `test:vault` + preflight, CI chạy test Vault, runbook (deploy §8 Vault, ops §1 emergency), cập nhật `.env.example`/security-matrix.

## Run 53b (kế hoạch, mở sau khi 53 PASS) — `be/Dockerfile`
- [ ] Task 1 [BE/ops]: `be/Dockerfile` multi-stage non-root theo khuôn run 52, `be/Dockerfile.dockerignore` allowlist, smoke script, CI job `be-image` (không push). Không `.env`/key trong mọi layer. Chi tiết ở mục "Kế hoạch 53b" trong fold.

## Run 53c (kế hoạch, mở sau 53b) — Redis Sentinel + Redis-down
- [ ] Task 1 [BE]: ioredis qua Sentinel (env). Redis không dùng được ⇒ 503 `temporarily_unavailable` + `Retry-After` (JSON và HTML); test int "kill Redis" + test Sentinel failover.
- [ ] Task 2 [ops]: compose prod mẫu (file mẫu, không chạy trên hạ tầng thật) + runbook Sentinel. Chi tiết ở mục "Kế hoạch 53c" trong fold.

## Câu hỏi cho tech-lead (đã trả lời trong `review-techlead.md`)
- Q-53.1: Tách run thế nào (L).
- Q-53.2: Transit key type (rsa-2048/ecdsa?) khớp alg hiện tại RS256; mapping `kid` ↔ Transit key version; JWKS lấy public key thế nào; latency/caching; rotate khẩn cấp (gỡ version cũ = `min_decryption_version`/`min_available_version`?).
- Q-53.3: Client Vault (HTTP thuần vs thư viện), auth method (AppRole/token), TLS.
- Q-53.4: Container tạm cho Vault dev / Redis Sentinel test: tên, cổng, dọn.

---

## Fold tech-lead (2026-10-24) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Đối chiếu HEAD `c543329`. BE là **CommonJS** (không phải ESM); jose 5.10.0 dùng được qua `require`. **Không thêm dependency** trong run 53: dùng `fetch` có sẵn của Node 22, `node:crypto` và jose đã có.

### Task A — interface mới (không đổi hành vi token)

**File**
- `be/src/modules/keys/key-provider.ts`
- `be/src/modules/keys/jws.ts` (mới)
- `be/src/modules/keys/local-key-provider.ts`
- `be/src/modules/keys/token-signer.ts`
- `be/src/modules/keys/token-verifier.ts`
- test: `keys.spec.ts`, `test/demo.int-spec.ts`, `test/userinfo.int-spec.ts`

1. **Interface `KeyProvider`**
   - Thay `getSigningKey()` bằng `signJwt(header: { typ: string }, payload: JWTPayload): Promise<string>`. Provider tự đặt `alg: 'RS256'` và `kid` (thứ tự header `{alg, kid, typ}`), rồi ký trong cùng một lời gọi. Không còn kiểu `KeyObject` trong file này.
   - `getPublicKeys(kidHint?: string)`: tham số tuỳ chọn. `LocalKeyProvider` bỏ qua tham số này.
   - `listKeys`, `rotate`, `KeyMetadata`, `RotationResult` giữ nguyên, nên hợp đồng admin API và fe-admin không đổi.
2. **`jws.ts`**: `encodeCompactJws(header, payload, signFn: (input: Buffer) => Promise<Buffer>): Promise<string>`.
   - Encode base64url bằng `Buffer.toString('base64url')`.
   - Không nhận header có `alg` khác `RS256`.
3. **`LocalKeyProvider`**
   - `signJwt` gọi `crypto.sign('sha256', input, privateKey)` (RSA mặc định PKCS#1 v1.5).
   - Giữ `getSigningKey()` làm method **public của class** (không thuộc interface) cho test dev đang dùng để giả token.
   - Đóng **DEBT-071**: đã thoả từ DEBT-145, `getPublicKeys` không còn ghi file. Ghi bằng chứng vào backlog.
4. **`TokenSigner.sign`**
   - Tự dựng payload `{...claims, iss, aud: options.audience, iat, exp, jti, sub?}`, giống hệt `SignJWT` hiện tại: `iat = floor(now/1000)`, `exp = iat + expiresInSec`, `jti = randomUUID()`, `sub` chỉ khi có. Rồi gọi `keys.signJwt({ typ: options.typ ?? 'JWT' }, payload)`.
   - Bỏ import `SignJWT`.
5. **`TokenVerifier`** (3 hàm verify): lấy `kid` bằng `decodeProtectedHeader(token)`. Nếu decode throw thì để nguyên throw (giữ semantics 401/inactive). Truyền `kid` vào `getPublicKeys(kid)`.
6. **Verify Task A**
   - Toàn bộ `pnpm -C be test` và `test:int` xanh mà không sửa kỳ vọng của test token.
   - Thêm test golden: token từ `TokenSigner` mới verify được bằng `jwtVerify` với JWKS; header đúng `{alg:'RS256',kid,typ}`; claims `iss/aud/iat/exp/jti/sub` đúng kiểu như trước.
   - `grep -n "privateKey\|KeyObject" be/src/modules/keys/key-provider.ts be/src/modules/keys/token-signer.ts` ⇒ rỗng.

### Task B — `VaultTransitKeyProvider`

**File**
- `be/src/modules/keys/vault-transit-key-provider.ts` (mới)
- `keys.module.ts`
- `be/src/config/{validation.schema,configuration}.ts`
- `be/.env.example`

**Env** (zod, fail-fast lúc boot, thông báo lỗi chỉ nêu tên biến, không nêu giá trị)

| Biến | Ràng buộc |
|---|---|
| `KEY_PROVIDER` | enum `local\|vault` (**bỏ `aws-kms`**). `NODE_ENV=production` mà khác `vault` ⇒ lỗi ở zod. Giữ thêm chặn ở `keys.module.ts`. |
| `KEY_LOCAL_DIR` | Chỉ bắt buộc khi `local`. |
| `VAULT_ADDR` | Bắt buộc khi `vault`. Là URL; `production` ⇒ phải `https:`. |
| `VAULT_TOKEN_FILE` | Bắt buộc khi `vault`. Đường dẫn file do Vault Agent ghi. **Không** có biến `VAULT_TOKEN`. |
| `VAULT_TRANSIT_MOUNT` | Mặc định `transit`. Regex `^[a-z0-9][a-z0-9_-]*(/[a-z0-9_-]+)*$`. |
| `VAULT_TRANSIT_KEY` | Bắt buộc khi `vault`. Regex `^[A-Za-z0-9_-]+$` (không `/`, không `..`). |
| `VAULT_TIMEOUT_MS` | `positiveInt.max(10000).default(2000)`. |

Không thêm env cho TTL cache: dùng hằng số `KEY_CACHE_TTL_MS = 30_000` và `KID_REFRESH_COOLDOWN_MS = 5_000`, có comment lý do.

**HTTP tới Vault**
- `fetch(VAULT_ADDR + '/v1/' + mount + '/...')`, header `X-Vault-Token`, `signal: AbortSignal.timeout(VAULT_TIMEOUT_MS)`.
- Dùng đúng path `sign/<key>` (không thêm hậu tố hash vào path), `hash_algorithm` đặt trong body.
- Không gửi `marshaling_algorithm` (chỉ áp cho ECDSA).
- Retry:
  - `sign` và đọc key: retry 1 lần khi lỗi mạng, timeout hoặc 5xx.
  - 403: đọc lại `VAULT_TOKEN_FILE` rồi thử lại 1 lần.
  - 4xx khác: không retry.
  - `rotate`, `config`, `trim`: **không retry**.
- Log lỗi chỉ gồm `vault <op> failed: status=<n>` (hoặc tên lỗi mạng). **Cấm** log token, body response, đường dẫn file token, hay input/chữ ký.

**`init()`** (gọi trong factory, lỗi ⇒ app không boot)
1. Đọc token file. File thiếu hoặc rỗng ⇒ throw.
2. `GET keys/<key>`. 404 ⇒ throw (app **không** tạo key; ops tạo).
3. **Từ chối** nếu:
   - `type ∉ {rsa-2048, rsa-3072, rsa-4096}`;
   - `exportable === true`;
   - `allow_plaintext_backup === true`;
   - `supports_signing !== true`.
4. Parse response bằng zod strict:
   - `latest_version`, `min_decryption_version`, `min_encryption_version`, `min_available_version`.
   - `keys: Record<string, {creation_time: string, public_key: string, ...}>`.
   - Shape lạ ⇒ throw.
   - **Trước khi viết parser**, dev ghi shape thật (bỏ PEM, chỉ để tên field và kiểu) lấy từ container tạm vào `log.md`.

**Cache metadata**
- Map version → `{kid, jwk, createdAt}`:
  - `jwk` lấy từ `createPublicKey(pem).export({format:'jwk'})`. Bắt buộc `kty==='RSA'` và modulus ≥ 2048 bit, nếu không thì throw.
  - `kid = await calculateJwkThumbprint({kty,n,e}, 'sha256')`.
- TTL 30 s, single-flight (các request đồng thời dùng chung một promise).
- Refresh lỗi ⇒ **throw**, không dùng bản quá hạn (fail-closed).

**`signJwt`**
1. Lấy `latest_version` = N từ cache.
2. `encodeCompactJws` với `kid(N)`.
3. Gửi body `{input: base64(signingInput), key_version: N, hash_algorithm: 'sha2-256', signature_algorithm: 'pkcs1v15'}`.
4. Parse `signature` bằng `^vault:v(\d+):([A-Za-z0-9+/]+={0,2})$`. Version ≠ N ⇒ throw.
5. Chuyển base64 sang base64url.
6. **Tự verify** bằng `crypto.verify('sha256', input, publicKey(N), sig)`. Sai ⇒ throw.
7. Vault trả 400 vì `key_version < min_encryption_version` (cache cũ sau emergency ở instance khác) ⇒ xoá cache, refresh, ký lại 1 lần.

**`getPublicKeys(kidHint?)` / `listKeys()`**
- Tập version live = `latest_version` (`active`) ∪ {v < latest | v ≥ max(min_decryption_version, min_available_version) và `createdAt(v+1) + retainSec + KEY_CACHE_TTL_MS > now`} (`retiring`, `retireAt` = vế trái).
- `retainSec`: `KeyRotationService` truyền vào `rotate`. Provider nhận `ACCESS_TOKEN_TTL` qua constructor để tính JWKS (cùng nguồn `token.accessTokenTtl`).
- `kidHint` không có trong cache và đã quá cooldown 5 s kể từ lần refresh do hint gần nhất ⇒ refresh 1 lần. Trong cooldown thì dùng cache, **không** gọi Vault.
- `/jwks.json` không bao giờ gây quá 1 lời gọi Vault cho mỗi 30 s, cộng 1 lời gọi mỗi 5 s do kid lạ.

**`rotate(mode, retainSec)`**
- `normal`: ghi nhớ `oldKid` (latest trong cache mới refresh) → `POST keys/<key>/rotate` → xoá cache → đọc lại → `newKid = kid(latest)`.
- `emergency`: như normal, rồi:
  - `POST keys/<key>/config {min_decryption_version: N, min_encryption_version: N}`. Lỗi ⇒ **throw**; `KeyRotationService` đã audit failure. Runbook: chạy lại emergency.
  - `POST keys/<key>/trim {min_available_version: N}`. Lỗi ⇒ log ERROR `trim failed after emergency rotation (new kid …)`, rotate vẫn thành công (giống `removePem`).
- Không mutex trong process: Vault tự serialize. Không lưu state ngoài Vault.
- Đóng **DEBT-159** (rotate an toàn nhiều process).

**`keys.module.ts`**
- `vault` ⇒ `new VaultTransitKeyProvider(cfg, accessTokenTtl)` + `init()`.
- `local` + `production` ⇒ throw (giữ nguyên).

**Policy Vault mẫu** (`ops/vault/idp-signer.hcl`, mới; `<mount>`/`<key>` là placeholder ghi trong comment)
```hcl
path "<mount>/sign/<key>"        { capabilities = ["update"] }
path "<mount>/keys/<key>"        { capabilities = ["read"] }
path "<mount>/keys/<key>/rotate" { capabilities = ["update"] }
path "<mount>/keys/<key>/config" { capabilities = ["update"]
  allowed_parameters = { "min_decryption_version" = [], "min_encryption_version" = [] } }
path "<mount>/keys/<key>/trim"   { capabilities = ["update"]
  allowed_parameters = { "min_available_version" = [] } }
```
Không cấp `export`, `delete`, `create`, `backup` hay quyền ở key khác.

### Task C — test, CI, runbook

**Container tạm (máy dev)**
- Tên `vg-b73-vault`, image `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55` (bản 2.1.2 phát hành 2026-10-07, ≥ 14 ngày).
- Lệnh: `docker run -d --name vg-b73-vault --cap-add=IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=<openssl rand -hex 16> -p 127.0.0.1:18200:8200 <image>`
- Root token chỉ nằm trong biến shell của phiên. Không ghi vào repo, `log.md` hay file nào khác.
- Dọn (bắt buộc, kể cả khi fail): `docker rm -f vg-b73-vault`, rồi `docker ps -a --format '{{.Names}}' | grep vg-b73` ⇒ rỗng. Ghi vào `log.md`. Image pull được giữ lại; ghi tên + digest vào log.
- **Cấm**: prune, xoá theo filter/wildcard, `compose up/down`, đụng `aegate-*`/`vg-test-*`/`veyrigate-*-1`/`sso-test-*`/`funny_pascal`/`mysql-db`, dừng process.

**Script `test:vault`** (`be/package.json`)
- Jest `--runInBand`, `--testRegex "\.vault-spec\.ts$"`, globalSetup `test/vault-preflight.mjs`.
- Preflight cần `VAULT_TEST_ADDR` + `VAULT_TEST_ROOT_TOKEN` và `GET /v1/sys/health` 200. Thiếu ⇒ **fail** (không skip), in lệnh `docker run` ở trên.
- `test:int` **không đổi**; `*.vault-spec.ts` không lọt vào regex `.int-spec`.

**Setup trong test** (root token chỉ dùng ở setup)
- Bật mount `vg-transit-<rand>`.
- Mỗi test tạo key riêng `k-<uuid>` (`rsa-2048`, `exportable=false`).
- Tạo policy theo mẫu `ops/vault/idp-signer.hcl` và **token con có policy đó**. Provider luôn chạy bằng token con, ghi vào file tạm `mkdtemp`.

**Test bắt buộc** (`be/test/vault-transit.vault-spec.ts` + unit `vault-transit-key-provider.spec.ts` có fetch giả)

| # | Kịch bản | Kỳ vọng |
|---|---|---|
| V1 | `TokenSigner` + provider Vault ký | `jwtVerify` (jose, RS256) với JWKS của provider pass; `kid` = thumbprint; `crypto.verify` kiểu PSS trên cùng chữ ký ⇒ false |
| V2 | Rotate normal | kid mới ký; token kid cũ vẫn verify; `listKeys` có `retiring` với `retireAt` = `createdAt(new) + retain + 30s`; với `retainSec` nhỏ (2 s, cache bơm đồng hồ giả hoặc TTL nhỏ qua constructor) kid cũ rời JWKS |
| V3 | Rotate emergency | JWKS chỉ còn kid mới **ngay** trên instance đó; token kid cũ verify fail; ký bằng `key_version` cũ trực tiếp qua token con ⇒ Vault từ chối; `GET keys` không còn version cũ (đã trim) |
| V4 | Hai provider (2 instance) chung 1 key: A rotate normal, B (cache cũ) verify token mới của A | Pass nhờ `kidHint`. 50 kid ngẫu nhiên liên tiếp ⇒ ≤ 1 lần đọc Vault (đếm qua fetch bọc) |
| V5 | Emergency trên A, B còn cache cũ rồi ký | B ký thành công bằng kid **mới** (sau 400 ⇒ refresh ⇒ ký lại) |
| V6 | Quyền token con (âm) | `GET export/signing-key/<k>` ⇒ 403; `config {exportable:true}` ⇒ 403; `config {deletion_allowed:true}` ⇒ 403; `DELETE keys/<k>` ⇒ 403; sign key khác ⇒ 403 |
| V7 | Key `exportable=true` (hoặc `allow_plaintext_backup=true`, hoặc type `aes256-gcm96`) | `init()` throw; app không boot |
| V8 | Key không tồn tại / token file thiếu / token sai | `init()` throw; log không chứa token, không chứa đường dẫn file |
| V9 | Token file đổi (token cũ bị revoke) | Gặp 403 ⇒ đọc lại file ⇒ thành công; file vẫn sai ⇒ throw sau đúng 2 lần gọi |
| V10 | Hố đen: TCP server trong process accept nhưng không trả lời | `signJwt` reject trong ≤ `2 × VAULT_TIMEOUT_MS + 500 ms` (1 retry); không treo |
| V11 | Unit: `vault:v(N+1):…` khi xin N; chữ ký sai byte; JSON lạ; `public_key` không phải RSA hoặc < 2048 bit | Đều throw |
| V12 | Unit cache | 100 lần `getPublicKeys()` trong 30 s ⇒ 1 lần đọc; 10 lời gọi đồng thời lúc cache trống ⇒ 1 lần đọc (single-flight); refresh lỗi khi cache đã hết hạn ⇒ throw (không trả bản cũ) |
| V13 | Config (unit `validation.schema.spec.ts`) | `production` + `local` ⇒ lỗi; `production` + `VAULT_ADDR=http://…` ⇒ lỗi; `vault` thiếu `VAULT_TRANSIT_KEY`/`VAULT_TOKEN_FILE` ⇒ lỗi; `vault` không cần `KEY_LOCAL_DIR`; `aws-kms` ⇒ lỗi; mount/key chứa `..` hoặc `/` sai quy tắc ⇒ lỗi |
| V14 | Full-app (`test/full-app.ts`) với `KEY_PROVIDER=vault` trỏ Vault tạm | `/jwks.json` trả key Vault; luồng `/token` (code) cấp `id_token`/`access_token` verify được; `/userinfo` dùng được access token đó |

**Mutation** (mỗi cái: sửa → chạy test → phải đỏ đúng test → khôi phục, `git diff --stat` của file đó rỗng)

| Sửa | Test phải đỏ |
|---|---|
| Bỏ `signature_algorithm: 'pkcs1v15'` | V1 |
| Bỏ kiểm version trong `vault:vN:` | V11 |
| Bỏ bước tự verify | V11 (chữ ký sai byte) |
| Bỏ lọc `min_decryption_version` khi dựng JWKS | V3 |
| Bỏ lời gọi `config` trong emergency | V3 hoặc V5 |
| Bỏ kiểm `exportable` ở `init` | V7 |
| Bỏ cooldown `kidHint` | V4 (đếm lời gọi) |
| Bỏ `AbortSignal.timeout` | V10 |
| Bỏ refine `production` ⇒ `vault` | V13 |
| Bỏ `allowed_parameters` khỏi `idp-signer.hcl` | V6 |

**CI** (`.github/workflows/ci.yml`, job `int`): thêm 2 step sau `test:int`.
1. `docker run -d --name vg-ci-vault --cap-add=IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=$TOKEN -p 127.0.0.1:18200:8200 <image@digest>`. Token sinh bằng `openssl rand -hex 16` và đánh `::add-mask::`. Chờ `/v1/sys/health` (tối đa 30 s).
2. `pnpm -C be test:vault` với `VAULT_TEST_ADDR`/`VAULT_TEST_ROOT_TOKEN` lấy từ step env.

Không dùng GitHub secrets, không push.

**Runbook**

`runbook-deploy.md` §8 "Vault Transit KeyProvider":
- Bật transit; tạo key `rsa-2048 exportable=false allow_plaintext_backup=false`, không `auto_rotate_period`.
- Policy `ops/vault/idp-signer.hcl`.
- Vault Agent auto-auth (AppRole/K8s) với sink file ⇒ `VAULT_TOKEN_FILE` (quyền 0400, owner uid của app).
- `VAULT_ADDR` https + `NODE_EXTRA_CA_CERTS`.
- Bảng env.
- Ý nghĩa cache 30 s: emergency có hiệu lực trên instance khác ≤ 30 s; RP ngoài theo DEBT-157.
- Vault down ⇒ không cấp được token (5xx), verify vẫn chạy tới khi cache hết hạn (≤ 30 s), sau đó 5xx.
- Backup Vault là trách nhiệm hạ tầng (DEBT-391).

`runbook-ops.md` §1 (emergency):
- Thêm nhánh Vault: trim là **không đảo ngược**.
- Kiểm bằng `vault read <mount>/keys/<key>` (min_* = latest, chỉ còn 1 version).
- Config lỗi ⇒ chạy lại emergency.
- Kiểm `GET /admin/keys` trước khi retry (DEBT-158).

`security-matrix.md`: thêm dòng INV-19 cho V1/V3/V6/V7. `.env.example`: thêm biến Vault (đã comment).

### Cổng security (senior/tester kiểm)

| Hạng mục | Nội dung |
|---|---|
| Tài sản | Private key ký (chỉ nằm trong Vault, non-exportable), Vault token của app, `kid`/JWKS |
| Actor / trust boundary | App ⇄ Vault (mạng nội bộ, TLS ở prod); admin super_admin + step-up gọi rotate; RP/RS đọc JWKS công khai; attacker điều khiển `kid` trong header token gửi vào `/userinfo`/`/introspect` |
| Invariant | Process không bao giờ có private key (interface không có `KeyObject`; policy không có `export`; key `exportable=false` kiểm lúc boot). Mọi token ký RS256 PKCS#1 v1.5 với `kid` khớp version thật (tự verify). JWKS = active ∪ retiring chưa hết hạn ∪ không dưới `min_decryption_version` |
| Chuyển trạng thái | normal: v → v+1, v verify-only tới `createdAt(v+1)+TTL+30s`. emergency: v+1 active, min_* = v+1, trim ⇒ v biến mất, mọi instance ngừng ký bằng v ngay (Vault chặn) và ngừng chấp nhận v ≤ 30 s |
| Abuse | `kid` ngẫu nhiên ⇒ không khuếch đại tải lên Vault (cooldown, V4). Token kid cũ sau emergency ⇒ fail (V3). Token app bị lộ ⇒ chỉ ký được key này, không export, không bật exportable, không xoá (V6). Rotate lặp (DEBT-158) không đổi |
| Failure semantics | Vault timeout/5xx/mạng ⇒ retry 1 lần rồi throw ⇒ `/token` 5xx, không cấp token, không token chưa ký. Refresh cache lỗi ⇒ throw (không dùng bản cũ). Boot: mọi cấu hình sai ⇒ không boot. Config emergency lỗi ⇒ 5xx + audit failure. Trim lỗi ⇒ ERROR log, rotate vẫn thành công |
| Exposure | Log/response không có Vault token, đường dẫn token file, body Vault, chữ ký hay input ký. Lỗi env chỉ nêu tên biến. `listKeys`/JWKS không có field private (giữ test INV-19 hiện có) |

### Kế hoạch 53b — `be/Dockerfile` (để orchestrator mở run sau)

**Image và file**
- Theo khuôn `fe-admin/Dockerfile`: cùng `NODE_IMAGE` digest `node:22.23.2-bookworm-slim@sha256:48e4b67d…f0f9`; bump bản Node theo DEBT-379.
- Build từ repo root: `pnpm install --frozen-lockfile --filter @sso-idp/be...` → `pnpm -C be build` → `pnpm --filter @sso-idp/be deploy --prod /deploy`. Copy `package.json`, `node_modules`, `dist` (bỏ `*.d.ts`, `*.map`; giữ `dist/views`, `dist/public`).
- Runtime: `NODE_ENV=production PORT=4000`, `USER 1000:1000`, file root-owned, `CMD ["node","dist/main.js"]`.
- `HEALTHCHECK` gọi `/health` (liveness). **Không** dùng `/ready`: Redis chết không được làm restart container.
- `@node-rs/argon2` cần bản gnu ⇒ base bookworm (glibc), đừng đổi sang alpine.
- `be/Dockerfile.dockerignore` allowlist, rút kinh nghiệm DEBT-385: `**/.env*`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/.npmrc`, `be/keys/`, `**/.keys/`.
- `main.ts` nạp `.env` ở cwd nếu có ⇒ smoke phải chứng minh `/app/.env` không tồn tại.

**Smoke** (`be/scripts/docker-smoke.sh`)
- Mạng tạm `vg-b73b-net`.
- Phụ trợ: `vg-b73b-mongo`, `vg-b73b-redis`, `vg-b73b-vault` (image ghim digest, bản ≥ 14 ngày).
- App: `vg-be-smoke-ok`, cổng `127.0.0.1:4400`.
- Check:
  - user ≠ 0; `/health` 200; `/ready` 200; `/jwks.json` có key Vault;
  - không `.env`/PEM/`be/keys` trong image (cả build stage);
  - env thiếu ⇒ exit ≠ 0 ≤ 20 s, log chỉ tên biến, không canary;
  - `KEY_PROVIDER=local` + production ⇒ exit ≠ 0;
  - `docker stop` ⇒ 0/143;
  - stop `vg-b73b-redis` ⇒ `/health` 200, `/ready` 503.
- Mutation như run 52.
- CI job `be-image`, không push.
- Dọn đúng tên.

### Kế hoạch 53c — Redis Sentinel + Redis-down (để orchestrator mở run sau)

**Env**
- `REDIS_SENTINELS` (`host:port,host:port`, ≥ 1), `REDIS_SENTINEL_MASTER`, `REDIS_SENTINEL_PASSWORD` (tuỳ chọn), `REDIS_PASSWORD`/`REDIS_USERNAME`/`REDIS_DB`.
- Có `REDIS_SENTINELS` ⇒ chế độ Sentinel và cấm `REDIS_URL`; không có ⇒ `REDIS_URL` như hiện tại.
- Production + standalone ⇒ WARN lúc boot (không chặn).

**Client**: `buildRedisOptions` giữ `commandTimeout`, `maxRetriesPerRequest: 1`, `retryStrategy` cho cả hai chế độ. Không Cluster ⇒ đóng DEBT-013/073 dạng N/A, runbook ghi "Cluster không hỗ trợ".

**Lỗi rõ**
- Predicate `isRedisUnavailable(err)` dựng từ bảng lỗi **quan sát thật** trong test kill: `MaxRetriesPerRequestError`, `Command timed out`, `Connection is closed.`, lỗi Sentinel không tới được.
- `OAuthExceptionFilter`, `HtmlExceptionFilter` và `token.controller` renderError ⇒ **503** `temporarily_unavailable` + `Retry-After: 5` + `no-store`. Metric label giữ union hiện có.
- Không chuyển thành fail-open ở bất kỳ đâu.

**Test kill**: TCP proxy trong process trỏ tới `vg-test-redis`, rồi huỷ proxy ⇒ kiểm:
- `/authorize`, `POST /login`, `/authorize/consent`, `/token` (code + refresh), `/userinfo`, `/introspect` (`active:false` vẫn đúng ma trận #28), `/logout`, `/ready` 503, `/health` 200;
- không `Set-Cookie` phiên, không token;
- sau khi bật lại proxy thì hoạt động trở lại.

**Test Sentinel** (`test:sentinel`, opt-in, fail nếu thiếu hạ tầng)
- Container: `vg-b73c-redis-a`@16390, `vg-b73c-redis-b`@16391, `vg-b73c-sentinel`@26390 trên mạng `vg-b73c-net`.
- Cấu hình: `announce-hostnames`/`resolve-hostnames yes`, `down-after-milliseconds 1000`, quorum 1. `natMap` chỉ trong test.
- Kịch bản: stop master ⇒ lệnh reject nhanh trong lúc chuyển, ghi được trên master mới ≤ 15 s.
- Image `redis:7.4.11-bookworm@<digest lúc làm>`.
- Dọn đúng tên.

**Compose prod mẫu** `ops/compose/prod.example.yml`: BE image, Vault Agent sidecar, 3 sentinel + 1 master + 1 replica, `noeviction` (DEBT-049), `min-replicas-to-write 1`, `/metrics` không publish (DEBT-220). Chỉ là file mẫu, **không chạy**.
