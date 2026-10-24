# Log — run 53 — B7.3 (tách: 53 Vault KeyProvider, 53b Dockerfile BE, 53c Redis Sentinel)

## tech-lead — 2026-10-24

**Kết luận: PASS (có fold, tách run).** Đối chiếu HEAD `c543329` (CodeGraph sync). Fold ở cuối `tasks.md`, review ở `review-techlead.md`.

- **Q-53.1**: run 53 = KeyProvider `signJwt` + `VaultTransitKeyProvider` + env + test Vault + runbook; 53b = `be/Dockerfile` + smoke + CI; 53c = Sentinel + Redis-down 503 + compose mẫu. Vault làm trước vì image prod hiện không boot được (`keys.module.ts` chặn `local` ở production).
- **Q-53.2**:
  - Key: `rsa-2048`, ký `sha2-256` + `pkcs1v15` (mặc định Vault là `pss`), luôn gửi `key_version`, kiểm `vault:vN:` và tự verify.
  - `kid` = thumbprint RFC 7638.
  - JWKS và retire suy ra từ metadata Vault, retire tại `createdAt(v+1) + TTL + 30 s`.
  - Cache 30 s single-flight; kid lạ ⇒ refresh với cooldown 5 s.
  - Emergency: `rotate` → `config min_decryption/min_encryption = N` → `trim min_available = N`.
- **Q-53.3**:
  - Client: `fetch` có sẵn, không thêm thư viện; timeout 2 s, retry 1 lần chỉ cho sign/read.
  - Auth: `VAULT_TOKEN_FILE` (Vault Agent), không có `VAULT_TOKEN` env.
  - TLS: prod bắt buộc https, CA qua `NODE_EXTRA_CA_CERTS`.
  - Policy: `allowed_parameters` để token app không bật được `exportable`.
- **Q-53.4**: `vg-b73-vault` @ `127.0.0.1:18200`, `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55` (2026-10-07). Dọn bằng `docker rm -f vg-b73-vault`. 53b/53c đã có tên/cổng trong kế hoạch. Redis Sentinel dùng `redis:7.4.11-bookworm` (2026-08-17).
- **Thực tế khác brief**:
  - BE là CommonJS, không phải ESM.
  - Interface hiện trả `KeyObject`, không cài được Transit ⇒ Task A refactor.
  - Redis chết hiện cho ra 500 `server_error` (không im lặng sai, không fallback memory), chưa phải 503 ⇒ 53c.
- **Debt**: mở DEBT-388…393. Dev đóng DEBT-071 (đã thoả từ DEBT-145) và DEBT-159 trong run 53. DEBT-013/073 sẽ đóng dạng N/A ở 53c (không dùng Cluster).
- **Chỉ đọc**: `docker version`/`ps -a`, Docker Hub tags API, GitHub releases, tài liệu Vault Transit, `npm view ioredis time`. Không sửa code, không build/run Docker, không chạy E2E.

## backend-dev — 2026-10-24 — shape thật Vault 2.1.2 (ghi TRƯỚC parser; container `vg-b73-vault`, mount tạm `shape-probe` đã unmount)

- `GET /v1/<mount>/keys/<k>` (rsa-2048, sau 1 rotate): `data` = `{allow_plaintext_backup:bool, auto_rotate_period:number, deletion_allowed:bool, derived:bool, exportable:bool, imported_key:bool, latest_version:number, min_available_version:number, min_decryption_version:number, min_encryption_version:number, name:string, supports_decryption/derivation/encryption/signing:bool, type:string, keys:{"<ver>":{certificate_chain:string, creation_time:string(RFC3339 ns, "…Z"), hybrid_public_key:string, name:string("rsa-2048"), public_key:string(PEM SPKI "-----BEGIN PUBLIC KEY-----")}}}`. Key không tồn tại ⇒ 404 `{"errors":[]}`.
- `POST sign/<k>` `{input,key_version,hash_algorithm:"sha2-256",signature_algorithm:"pkcs1v15"}` ⇒ `data:{key_version:number, signature:"vault:v<N>:<base64>"}`.
- **Khác fold**: ký `key_version < min_encryption_version` (cache cũ sau emergency) ⇒ **HTTP 500** (không phải 400), msg "less than the minimum encryption key version"; `key_version > latest` cũng 500. ⇒ cài: Vault trả status lỗi (4xx/5xx, không phải mạng/timeout) khi ký ⇒ xoá cache, refresh, nếu latest đổi thì ký lại 1 lần. Parser zod kiểm field bắt buộc + kiểu, cho phép field thừa (Vault thêm field theo bản, vd `hybrid_public_key`).
- `config {min_decryption_version:N,min_encryption_version:N}` 200; `trim {min_available_version:N}` 200 ⇒ `keys` chỉ còn N.

## backend-dev — 2026-10-24 — Task A/B/C xong (đề nghị → senior-reviewer)

- **Trust boundary**: tài sản = private key (chỉ trong Vault, `exportable=false`) + token Vault của app (`#token`, file Agent) + kid/JWKS; actor = app⇄Vault, super_admin rotate, attacker chọn `kid`. Fail-closed: Vault lỗi ⇒ retry 1 lần (sign/read) rồi throw, không token chưa ký; cache hết hạn + refresh lỗi ⇒ throw; boot sai cấu hình ⇒ không boot. Exposure: log chỉ `vault <op> failed: status=<n>|<ErrName>`, không token/path/body/chữ ký; lỗi env chỉ tên biến.
- **A**: `KeyProvider.signJwt` + `jws.ts`; `getPublicKeys(kidHint?)`; `LocalKeyProvider.getSigningKey` chỉ ở class; `TokenSigner` payload golden = `SignJWT` cũ; `TokenVerifier` truyền `kid`. **B**: `VaultTransitKeyProvider`, env zod (`KEY_PROVIDER local|vault`, prod ⇒ vault + https), `keys.module`, `ops/vault/idp-signer.hcl`. **C**: `test:vault` + `vault-preflight.mjs` (fail không skip), CI job `int` 2 step, runbook-deploy §8, runbook-ops §1 Vault, security-matrix INV-19 ⇒ `có`, `.env.example`.
- **Khác fold (thực tế Vault 2.1.2)**: (1) ký version < `min_encryption_version` ⇒ 500 (không 400) ⇒ refresh+ký lại khi status 400/≥500 và latest đổi. (2) `GET keys` **ẩn** version < `min_decryption_version` ⇒ mutation "bỏ lọc floor" KHÔNG đỏ V3 thật (đã chạy: 2/2 pass) ⇒ bắt bằng unit fake (`trim failure after emergency`, fake liệt kê mọi version); floor giữ làm defence in depth. (3) Key không có quyền đọc ⇒ 403 (V8 404 dùng key bị root xoá). (4) Vault down + cache hết ⇒ verify ra 401/`active:false`, không 5xx ⇒ DEBT-394.
- **Lỗi tự phát hiện + fix**: Jest in object provider khi test fail (mutation m6) làm lộ token con vào output ⇒ chuyển `token`/`cfg` sang ES private field `#`; test `dumped provider object` (+ mutation m11 đỏ). Chỉ là token con của Vault dev tạm (đã huỷ cùng container), không vào repo.
- **Verify (foreground, output thật)**: be unit 475/475 (33 suite); `test:int` 1221/1221 (45 suite, chạy 2 lần); `test:vault` 14/14 (thiếu env ⇒ exit 1 kèm lệnh docker; Vault không healthy ⇒ fail); be lint/typecheck/build 0; root `pnpm lint` 0, `pnpm -r run typecheck` 0, root `pnpm test` (be 475 + fe-admin 1415 + fe-sso-test 269); `pnpm audit --audit-level high` exit 0 (1 high đã ignore sẵn); E2E `pnpm -C e2e e2e` 35 passed (cổng 4000/5173/3000 trống, không `E2E_REUSE`, provider local).
- **Mutation 10/10 đỏ đúng test, khôi phục byte-identical (sha256)**: pkcs1v15→V1(vault); version vN→V11; self-verify→V11 byte lật; floor→unit trim-fail (V3 thật vẫn xanh, xem trên); config→V3(vault); exportable→V7 (unit+vault+full-app); cooldown→V4 (50 lần đọc); AbortSignal→V10; refine prod⇒vault→V13; `allowed_parameters`→V6. Thêm m11 (lộ token qua object) → đỏ.
- **Docker**: chỉ `vg-b73-vault` @127.0.0.1:18200, image `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55` (giữ lại, untagged). Root token ngẫu nhiên, chỉ đọc qua `docker inspect` trong lệnh, không ghi file; grep output: 0 lần root token, 0 token `hvs.` thật. Đã `docker rm -f vg-b73-vault`; `docker ps -a | grep vg-b73` rỗng. Không đụng `aegate-*`/`vg-test-*`/`be/keys`/`be/.env`.
- **Backlog**: đóng DEBT-071, DEBT-159; mở DEBT-394 (🟡, 53c). Không commit.

## senior-reviewer — 2026-10-24

**Kết luận: PASS** (0 🔴) → chuyển **tester**. Chi tiết: `review-senior.md`.
- Security invariants đã kiểm theo code: không private key qua interface; chỉ RS256 (`jws.ts` chặn trước `signFn`, verify `algorithms:['RS256']`); `kid` attacker chỉ so trong Map, không vào URL (mount/key qua regex env, không `.`) ⇒ không SSRF/path injection; cooldown 5 s đặt trước refresh; `vault:vN:` + self-verify; lệch fold #1 ký lại tối đa 1 lần, chỉ khi `latest` đổi, dùng entry mới (không ký sai version, không lặp); cache/single-flight/`seq` chống ghi đè muộn, refresh lỗi ⇒ throw; rotate không retry, trim lỗi chỉ log; token `#private`, log chỉ op/status/err.name; config prod ⇒ vault + https, không `VAULT_TOKEN`; policy `allowed_parameters` đúng least-privilege; CI mask trước khi dùng.
- DEBT-394: fail-closed (không bypass), mức 🟡 đúng, để 53c. DEBT-388: lệch fold #1 giảm (không tăng) rủi ro.
- Tự chạy: be `tsc --noEmit` 0; eslint keys/config/vault-spec 0; jest `src/modules/keys src/config` 158/158. Không chạy int/vault/E2E, không dựng container, không sửa code.
- Debt mới: DEBT-395 🟡 (`signJwt` `refresh(true)` khuếch đại đọc khi Vault 5xx hàng loạt), DEBT-396 🟡 ponytail (~-8 dòng). 💭: cooldown kid dùng chung, 403 kéo dài đọc file mỗi request, golden chưa so byte, `VAULT_ADDR` nhận query/userinfo, clock skew.

## tester — 2026-10-24

**Kết luận: PASS.** Chi tiết + output: `test-report.md`.
- Chạy lại độc lập: be unit 475/475; `test:int` 1221/1221 (45 suite; `vg-test-*` đang chạy); `test:vault` 22/22 (14 của dev + 8 tester); be lint/typecheck/build 0; root `pnpm lint` 0, `pnpm -r run typecheck` 0, root `pnpm test` (be 475 + fe-admin 1415 + fe-sso-test 269); `pnpm audit --audit-level high` exit 0 (1 high đã ignore sẵn); E2E 35 passed (cổng 4000/5173/3000 trống, không `E2E_REUSE`). `be/keys` sha256/mtime trước = sau.
- Test mới `be/test/b73-tester.vault-spec.ts` (T1–T8, chạy với Vault thật):
  - T1: client chuẩn `createRemoteJWKSet` verify được + `/introspect`.
  - T2: none/HS256×2/PS256 có chữ ký Transit thật với kid hợp lệ ⇒ 401/`active:false`.
  - T3: kid storm qua `/userinfo` ⇒ ≤ 1 lần đọc / 5 s.
  - T4: emergency trên full-app ⇒ token cũ 401, token mới OK, JWKS chỉ còn kid mới.
  - T5: Vault down ⇒ fail-closed. Characterisation DEBT-394: quá TTL thì `/userinfo` 401, `/introspect` `active:false`, `/jwks.json` 5xx; Vault trở lại thì phục hồi.
  - T6: token không lộ qua inspect/JSON/lỗi/log/pino.
  - T7: config prod.
  - T8: characterisation DEBT-395, 10 request ⇒ 10 lần đọc.
- Mutation tester (backup sha256, khôi phục byte-identical): M-b cooldown ⇒ T3 đỏ; M-c dùng cache quá hạn ⇒ T5 đỏ; M-d bỏ `#token` ⇒ T6 đỏ; M-a2 cho phép PS256 + bỏ `alg` của JWK ⇒ T2 đỏ. M-a chỉ cho phép PS256 thì sống, vì JWK `alg:'RS256'` là lớp phòng thủ thứ hai.
- Docker: chỉ `vg-b73-vault` @127.0.0.1:18200, image ghim digest. Root token ngẫu nhiên, chỉ đọc qua `docker inspect` trong lệnh. Đã `docker rm -f vg-b73-vault`; `docker ps -a | grep vg-b73` rỗng. Không đụng container khác.
- Grep secret: root token 0. Có một token con `hvs.` xuất hiện trong log của mutant M-d (đúng điều T6 phải bắt); log đó đã được redact. Token này thuộc Vault dev tạm, đã huỷ cùng container, không vào repo.
- Debt: không mở mới. DEBT-394/395 thêm bằng chứng characterisation, giữ 🟡. Không sửa code sản phẩm, không commit.
