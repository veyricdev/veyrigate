# Tech Lead Review — 2026-10-24 (run 53, B7.3)

## Kết luận: PASS (có fold, tách run)

Fold ràng buộc cụ thể ở cuối `tasks.md`, mục "Fold tech-lead (2026-10-24)". Fold ưu tiên hơn text gốc khi mâu thuẫn.

B7.3 size L, gồm 3 phần độc lập về code nhưng phụ thuộc nhau khi nghiệm thu. Tách run:

| Run | Nội dung | Lý do thứ tự |
|---|---|---|
| **53** (run này) | KeyProvider bỏ `KeyObject` + `VaultTransitKeyProvider` + env/config + test Vault + runbook key | Hiện **image prod không boot được**: `KeysModule` ném lỗi khi `NODE_ENV=production` vì chỉ có `LocalKeyProvider`. Phải có provider thật trước thì smoke image mới chạy được nhánh "thành công". Đây cũng là phần rủi ro bảo mật cao nhất (INV-19). |
| **53b** | `be/Dockerfile` + `Dockerfile.dockerignore` + smoke (boot prod thật với Vault dev + Mongo + Redis tạm) + CI `be-image` | Theo khuôn run 52. Cần 53 xong. |
| **53c** | Redis Sentinel (env, ioredis), Redis lỗi ⇒ 503 `temporarily_unavailable`, test "kill Redis", compose prod mẫu, runbook | Độc lập với 53/53b về code; đặt sau để compose mẫu có image BE và Vault. |

Giao **backend-dev** run 53: Task A → B → C (tuần tự). Không có [FE].

Đối chiếu code thật ở HEAD `c543329` (CodeGraph đã sync):
- Keys: `be/src/modules/keys/{key-provider,local-key-provider,token-signer,token-verifier,key-rotation.service,keys.controller,keys.module}.ts`. Test dùng `getSigningKey`: `keys.spec.ts`, `test/demo.int-spec.ts:204`, `test/userinfo.int-spec.ts:256,274`.
- Config: `be/src/config/{validation.schema,configuration}.ts`. `KEY_PROVIDER` enum `local|aws-kms|vault`, `KEY_LOCAL_DIR` bắt buộc với mọi provider.
- Redis: `be/src/database/redis/{redis.module,redis.service,lua-loader}.ts`. Chỉ có **một** client ioredis. `defineCommand` chỉ đăng ký lệnh, boot không cần Redis. Store dùng Redis: `session.service`, `rate-limit.service`, `authorization-code.service`, `authorize-request-context.service`, `federation-state.store`. Không file nào bắt lỗi Redis rồi nuốt; không có fallback memory (`grep new Map|MemoryStore|InMemory` chỉ ra `form.ts`). `test/redis-fail-fast.int-spec.ts` đã khẳng định rate-limit fail-closed.
- Lỗi: `OAuthExceptionFilter` và `HtmlExceptionFilter` map mọi lỗi không phải `HttpException` thành **500** `server_error` / "Something went wrong". `/token` cũng 500 (`token.controller.ts:487`). Như vậy Redis chết hiện ra 500, không im lặng sai, nhưng chưa "rõ" (không 503/`Retry-After`). Việc này để 53c.
- Entry: `main.ts` nạp `.env` ở cwd nếu tồn tại, `bootstrap.ts` có `enableShutdownHooks()`, `/health` là liveness, `/ready` ping Mongo + Redis.
- Build: **BE là CommonJS** (`tsconfig` `module: commonjs`, `dist/main.js` `"use strict"; require(...)`), không phải ESM như brief ghi. jose 5.10.0 có CJS và có `calculateJwkThumbprint`, `decodeProtectedHeader` (đã kiểm bằng `require('jose')` trong `be/`). Asset nest: `views/**/*`, `public/**/*`.
- CI: `.github/workflows/ci.yml` job `int` (service mongo/redis/mailpit), job `fe-admin-image`.
- Docker (chỉ đọc): Engine 28.5.1. Container hiện có: `vg-test-redis`@6479, `vg-test-mongo`@27117, `aegate-*`, `veyrigate-*-1`, `sso-test-*`, `funny_pascal`, `mysql-db`. Cổng 18200 trống.
- Registry/tài liệu: Docker Hub tags API, GitHub releases `hashicorp/vault` và `redis/redis`, Vault Transit API docs. `npm view ioredis time`: 6.0.0 phát hành 2026-07-31, có Sentinel (`sentinels`, `name`, `sentinelPassword`, `natMap`, `enableTLSForSentinelMode` trong `SentinelConnector/index.d.ts`).

## Kiến trúc đề xuất

### 1. `KeyProvider` không còn trả private key

Interface hiện tại `getSigningKey(): { kid, privateKey: KeyObject }` **không cài được bằng Vault Transit**, vì Transit không bao giờ trả private key. Interface này cũng vi phạm INV-19 ở mức thiết kế. Đổi thành:

```ts
signJwt(header: { typ: string }, payload: JWTPayload): Promise<string>; // provider đặt alg=RS256 + kid
getPublicKeys(kidHint?: string): Promise<PublicJwk[]>;
listKeys(): Promise<KeyMetadata[]>;   // giữ nguyên
rotate(mode, retainSec): Promise<RotationResult>; // giữ nguyên
```

Provider tự chọn version, đặt `kid` vào header rồi ký **trong cùng một lời gọi**. Nhờ vậy không có race "đọc kid rồi rotate rồi ký bằng key khác". Phần mã hoá compact JWS dùng chung một helper `jws.ts`. `LocalKeyProvider` giữ `getSigningKey()` như method riêng của class (test dev cần để giả token), nhưng method này không nằm trong interface.

### 2. Vault Transit

- Client là **`fetch` có sẵn của Node 22**. Không thêm thư viện: `node-vault` không đáng thêm cho 5 endpoint.
- Key type `rsa-2048`. Ký RS256 = `hash_algorithm=sha2-256` + `signature_algorithm=pkcs1v15` (mặc định của Vault là **`pss`**, sai RS256). `prehashed=false`. `marshaling_algorithm` chỉ áp cho ECDSA ⇒ không gửi.
- `kid` = RFC 7638 thumbprint của JWK công khai, **không** dùng `v<N>`. Lý do: nếu key Transit bị tạo lại cùng tên thì version đếm lại từ 1 ⇒ `kid` trùng với token cũ.
- Luôn gửi `key_version`. Kiểm tiền tố `vault:v<N>:` đúng N, rồi tự verify chữ ký bằng public key đã cache trước khi trả token (fail-closed).
- JWKS và rotate suy ra **hoàn toàn từ metadata Vault**, app không giữ state. Cụ thể:
  - Version N đang retiring tới `creation_time(N+1) + ACCESS_TOKEN_TTL + cache TTL`.
  - Emergency = `rotate` → `config min_decryption_version=min_encryption_version=N` → `trim min_available_version=N`.
- Cache metadata trong process 30 s, single-flight. Gặp `kid` lạ ⇒ refresh, có cooldown 5 s. Hết TTL thì không dùng bản cũ.
- Auth: `VAULT_TOKEN_FILE` do Vault Agent ghi (AppRole/K8s auth nằm ở Agent). App **không** đọc token từ env.
- TLS: prod bắt buộc `https://`, CA qua `NODE_EXTRA_CA_CERTS`.
- Policy least-privilege với `allowed_parameters`, để token app không bật được `exportable` hay `deletion_allowed`.

### 3. Redis Sentinel (53c)

Giữ một client. Có `REDIS_SENTINELS` thì vào chế độ Sentinel, nếu không thì `REDIS_URL` như hiện tại. Giữ nguyên `commandTimeout` + `maxRetriesPerRequest: 1`. Không Cluster ⇒ DEBT-013/073 thành N/A. Chi tiết ở kế hoạch 53c trong `tasks.md`.

## Trả lời câu hỏi

### Q-53.1: Tách run
Xem bảng ở trên: 53 = Vault KeyProvider, 53b = Dockerfile, 53c = Sentinel. Thứ tự này đảo so với gợi ý của orchestrator, vì không có provider thật thì image prod không boot được (`keys.module.ts` ném lỗi "LocalKeyProvider is dev-only").

### Q-53.2: Key type, kid, JWKS, cache, rotate khẩn cấp

**Key**
- `rsa-2048` khớp RS256 và `LocalKeyProvider` (RSA-2048) ⇒ không đổi `alg`, RP không cần đổi gì.
- Ops tạo key với `exportable=false` và `allow_plaintext_backup=false`. Hai cờ này không tắt được về sau.
- Không dùng `auto_rotate_period`: rotate phải đi qua admin API để có audit.
- Lúc boot, provider đọc key và **từ chối khởi động** nếu `exportable` hoặc `allow_plaintext_backup` là true, type không phải `rsa-2048|rsa-3072|rsa-4096`, hoặc `supports_signing` không true.

**kid ↔ version**
- `kid = calculateJwkThumbprint({kty,n,e}, 'sha256')`.
- Map version → {kid, jwk, createdAt} dựng từ `GET /v1/<mount>/keys/<name>`. Với key RSA, field `keys` là map version → `{creation_time, name, public_key(PEM)}`; data còn có `latest_version`, `min_decryption_version`, `min_encryption_version`, `min_available_version`.
- Tài liệu chính thức chỉ ví dụ key AES (`keys: {"1": <epoch>}`). Vì vậy dev **phải ghi lại** shape thật từ container Vault tạm vào `log.md` trước khi viết parser. Parser dùng zod strict; shape lạ thì fail-closed.

**JWKS**: gồm `latest_version` (active), cộng các version `v >= min_decryption_version` có `creation_time(v+1) + retainSec + cacheTtl > now`. Phần `+ cacheTtl` có lý do: instance khác có thể còn ký bằng v tới 30 s sau khi v+1 ra đời.

**Latency**
- Mỗi token tốn 1 round-trip Vault (LAN vài ms, có keep-alive mặc định của undici).
- Verify không gọi Vault, chỉ dùng cache.
- `/jwks.json` công khai không được gây 1 lời gọi Vault cho mỗi request. Chỉ cache miss mới gọi, và kid lạ chỉ refresh tối đa 1 lần mỗi 5 s.

**Rotate khẩn cấp**
- Không dùng riêng `min_decryption_version`, vì nó không chặn ký: chặn ký là việc của `min_encryption_version`, và Vault từ chối `key_version < min_encryption_version`.
- Trình tự:
  1. `rotate`.
  2. Đọc lại để biết N.
  3. `config {min_decryption_version:N, min_encryption_version:N}` ⇒ instance nào còn cache cũ mà ký bằng version cũ sẽ bị Vault từ chối, tự refresh rồi thử lại 1 lần.
  4. `trim {min_available_version:N}` ⇒ huỷ vật liệu key cũ, **không đảo ngược được**. Đúng ý khi key bị lộ.
- Trim lỗi: log ERROR rồi vẫn coi rotate thành công (key cũ đã không ký được và không còn trong JWKS), giống `removePem` hiện tại. Config lỗi: throw ⇒ 5xx + audit failure; chạy lại emergency sẽ hội tụ.
- Instance khác vẫn chấp nhận token key cũ tối đa 30 s (cache TTL). RP ngoài thì tuỳ cache JWKS của họ (DEBT-157).

### Q-53.3: Client, auth, TLS

**Client**: HTTP thuần qua `fetch`, `AbortSignal.timeout(VAULT_TIMEOUT_MS)` (mặc định 2000, tối đa 10000). Retry:
- `sign` và đọc key: retry 1 lần khi lỗi mạng/5xx/timeout. Không retry 4xx, trừ 403 (xem bên dưới).
- `rotate`/`config`/`trim`: **không** retry.

Không thêm dependency.

**Auth**: token đọc từ `VAULT_TOKEN_FILE`, do sink của Vault Agent (auto-auth AppRole hoặc Kubernetes) ghi.
- Đọc 1 lần lúc init. Gặp 403 ⇒ đọc lại file, thử lại 1 lần; vẫn 403 ⇒ fail.
- Không có biến `VAULT_TOKEN` trong env, vì env lộ qua `docker inspect`/`/proc`.
- Không tự login AppRole trong app, vì app sẽ phải giữ `secret_id` và tự renew.

**TLS**
- `NODE_ENV=production` ⇒ zod bắt `VAULT_ADDR` phải `https:`.
- CA riêng qua `NODE_EXTRA_CA_CERTS` (cơ chế có sẵn của Node).
- Cấm mọi cờ tắt xác thực TLS.

**Namespace (Enterprise)**: không làm (YAGNI).

### Q-53.4: Container tạm

**Run 53**
- Container: một Vault dev `vg-b73-vault`, image `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55`. Bản 2.1.2 phát hành 2026-10-07, 17 ngày; 2.2.x mới 2 và 9 ngày nên chưa dùng.
- Cổng `127.0.0.1:18200`. Root token sinh ngẫu nhiên mỗi lần chạy, không ghi vào repo hay log.
- Dọn bằng `docker rm -f vg-b73-vault`. Image được giữ lại (là image pull về, không phải tài nguyên đang chạy) và ghi vào log.
- Test timeout dùng TCP server "hố đen" trong process, không cần container.

**Run 53b / 53c**: tên và cổng đã ghi trong kế hoạch ở `tasks.md`. Redis cho Sentinel dùng `redis:7.4.11-bookworm`: phát hành 2026-08-17, cùng nhánh với `redis:7` đang dùng ở dev/test. Digest lấy lúc làm bằng `docker buildx imagetools inspect`, vì Docker Hub build lại tag thường xuyên; hôm nay là `sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b`, push 2026-10-21.

## Điểm mạnh
- Redis đã fail-fast và fail-closed (DEBT-005), không có fallback memory. Phần "§6.2 không memory" đã đạt, chỉ còn thiếu Sentinel và mã lỗi rõ.
- `KeyRotationService` (audit, `retainSec = ACCESS_TOKEN_TTL`) và `KeyMetadata` không phụ thuộc file, nên dùng lại nguyên cho Vault.
- Khuôn Dockerfile/smoke/CI của run 52 dùng lại được gần như nguyên cho 53b.

## Vấn đề (đã fold, bắt buộc theo fold)
- [x] Interface `getSigningKey(): KeyObject` không cài được bằng Transit ⇒ đổi sang `signJwt` (Task A).
- [x] Tài liệu Vault mặc định `signature_algorithm=pss` ⇒ bắt buộc `pkcs1v15`, có test và mutation.
- [x] Nếu dùng `kid = v<N>` thì tạo lại key sẽ trùng kid ⇒ chuyển sang thumbprint.
- [x] Policy chỉ có `update` cho `keys/<k>/config` thì vẫn bật được `exportable=true` ⇒ bắt buộc `allowed_parameters`, kèm test âm.
- [x] Rotate thường khi nhiều instance: instance B chưa có kid mới thì verify token của instance A sẽ fail ⇒ `getPublicKeys(kidHint)` + cooldown.
- [x] Thời điểm retire phải cộng cache TTL.
- [x] `KEY_LOCAL_DIR` đang bắt buộc với mọi provider ⇒ chỉ bắt buộc khi `local`. Bỏ `aws-kms` khỏi enum.
- [x] Thứ tự run: Vault trước Dockerfile.

## Đề xuất (không bắt buộc, đã vào backlog)
- DEBT-388: refresh/code grant xoay RT hoặc tiêu code **trước** khi ký ⇒ Vault chập chờn = mất code; client retry RT sẽ bị coi là reuse ⇒ family bị revoke hàng loạt.
- DEBT-389: rotate khẩn cấp gồm nhiều bước, không atomic.
- DEBT-390: metric/alert cho Vault (latency ký, lỗi), quyết định không đưa Vault vào `/ready`.
- DEBT-391: Vault server HA/unseal/backup nằm ngoài app, cần runbook hạ tầng.
- DEBT-392: Redis Sentinel TLS/ACL (53c xem xét).
- DEBT-393: key rollover cho RP (pre-publish key mới trước khi ký).
