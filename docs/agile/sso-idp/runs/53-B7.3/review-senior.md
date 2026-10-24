# Senior Review — 2026-10-24 (run 53, B7.3 phần 1: Vault Transit KeyProvider)

## Kết luận: PASS

Không có 🔴. Hai 🟡 vào backlog (DEBT-395, DEBT-396). Chuyển **tester**.

Phạm vi: diff chưa commit so với HEAD `c543329`, gồm `be/src/modules/keys/*` (`jws.ts`, `vault-transit-key-provider.ts`, `key-provider.ts`, `local-key-provider.ts`, `token-signer.ts`, `token-verifier.ts`, `keys.module.ts`), `be/src/config/*`, `be/test/vault-*`, `ops/vault/idp-signer.hcl`, `.github/workflows/ci.yml`, `be/package.json`, `be/.env.example`, runbook-deploy §8, runbook-ops §1, security-matrix INV-19, backlog. Bỏ qua `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.

Tự chạy (foreground): `tsc --noEmit` 0; `eslint src/modules/keys src/config test/vault-transit.vault-spec.ts` 0; jest `src/modules/keys src/config` 4 suite, 158/158. Không chạy `test:int`/`test:vault`/E2E (không dựng Vault, theo brief). Số liệu int/vault/E2E/mutation lấy từ log backend-dev.

## Tổng quan

Thiết kế gọn và đúng hướng. Interface `KeyProvider` không còn `KeyObject`, nên INV-19 được bảo đảm ở mức kiểu chứ không chỉ ở mức quy ước. Provider chọn version, đặt `kid` và ký trong một lời gọi, nên không có race "đọc kid → rotate → ký bằng key khác".

Phần ký fail-closed ba lớp, đúng fold:
- luôn gửi `key_version`;
- kiểm tiền tố `vault:vN:` đúng N;
- `crypto.verify` bằng public key của chính version đó.

Toàn bộ state được suy ra từ metadata Vault, nên không có state cục bộ để lệch giữa các instance. Token Vault nằm trong private field `#` và có test chống lộ khi object bị dump. Đây là lỗi dev tự phát hiện qua mutation, xử lý rất tốt.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng (code) |
|---|---|---|
| Không private key trong process | Đạt | `key-provider.ts` chỉ còn `signJwt`/`getPublicKeys`/`listKeys`/`rotate`. `LocalKeyProvider.getSigningKey` là method của class, ngoài interface; production bị chặn ở zod `superRefine` và `keys.module.ts`. Boot từ chối `exportable`/`allow_plaintext_backup`/type ≠ RSA/`supports_signing` ≠ true (`vault-transit-key-provider.ts:295-300`), kiểm lại ở **mọi** lần refresh chứ không chỉ lúc boot. |
| Chỉ RS256, chống alg confusion | Đạt | `jws.ts:444` từ chối alg ≠ `RS256` trước khi gọi `signFn` (test none/HS256/PS256/rs256). Body ký có `signature_algorithm:'pkcs1v15'` + `hash_algorithm:'sha2-256'`; V1 chứng minh PSS không verify. Verify: cả 3 hàm `jwtVerify` đều `algorithms:['RS256']`; JWKS có `alg:'RS256'`. |
| `kid` do attacker kiểm soát | Đạt | `kid` chỉ dùng để so sánh trong Map (`getPublicKeys:147`), **không bao giờ** vào URL Vault. URL dựng từ `mount`/`key` lấy từ env, đã qua regex (`^[a-z0-9][a-z0-9_-]*(/[a-z0-9_-]+)*$`, `^[A-Za-z0-9_-]+$`, không có `.`), nên không có path traversal hay SSRF. Kid lạ ⇒ refresh tối đa 1 lần / 5 s (`lastHintRefresh` đặt **trước** khi refresh, kể cả khi refresh lỗi). Token không decode được ⇒ `decodeProtectedHeader` throw **trước** `getPublicKeys` ⇒ không chạm Vault (test spy). `kid` khác kiểu string ⇒ không dùng làm hint. |
| Self-verify / đúng version | Đạt | `signWith:228-238`: zod + regex + `Number(m[1]) !== entry.version` + `verify(sha256, input, entry.publicKey, sig)`. V11 có 3 case; mutation đỏ. |
| Lệch fold #1 (Vault trả 500 ⇒ refresh + ký lại) | Đạt, không lặp, không ký sai version | `signJwt:134-139`: chỉ ký lại khi `fresh.latest !== set.latest`, và chỉ **một** lần (lời gọi `signWith` thứ hai không nằm trong try). Lần ký lại dùng `entry` của bộ key mới, nên `kid` header, `key_version` và public key dùng để self-verify đều cùng một version. Nếu `latest` không đổi thì giữ nguyên lỗi gốc. Cận trên số lời gọi: 2 sign + 2 read + 2 sign. Xem 🟡 DEBT-395 về tải. |
| Cache / single-flight / không stale | Đạt | TTL 30 s; `refresh(false)` dùng chung promise; `seq`/`cachedSeq` chặn load cũ về muộn ghi đè sau `invalidate()` (cần cho emergency "ngay"); hết hạn + refresh lỗi ⇒ throw (V12). |
| JWKS cửa sổ version | Đạt | `live()`: latest ∪ {v ≥ floor, có v+1, `createdAt(v+1) + TTL + 30 s > now`}; floor = max(min_decryption, min_available). Cộng 30 s đúng với trường hợp B còn ký v ≤ 30 s sau khi v+1 ra đời. |
| Rotate | Đạt | normal/emergency không retry (`retryable=false`). Thứ tự `rotate → invalidate → read → config → invalidate → trim`. `config` lỗi ⇒ throw (audit failure). `trim` lỗi ⇒ log ERROR kèm kid mới (public), vẫn thành công. Trim không đảo ngược, runbook-ops ghi rõ. |
| Failure: timeout/mạng/5xx | Đạt | `AbortSignal.timeout` trên mọi fetch (undici áp cả lúc đọc body). Retry 1 lần chỉ cho sign/read; 403 ⇒ đọc lại file 1 lần (tối đa 3 lời gọi khi 403 + 5xx xen kẽ). `/token` 5xx, không có token chưa ký. |
| Exposure | Đạt | Log/lỗi chỉ có `vault <op> failed: status=<n>` hoặc **tên** lỗi (`err.name`, không `message`/`cause`, vì `cause` của undici có thể chứa URL). Lỗi đọc token file chỉ có `code` (ENOENT…), không có path. Token chỉ chấp nhận ký tự ASCII in được, nên CR/LF không lọt vào header. Body lỗi Vault bị drain, không log. Token/cfg nằm trong `#private` (test dump). Lỗi env chỉ nêu tên biến (test canary `vault-canary`). |
| Config | Đạt | Production ⇒ `KEY_PROVIDER=vault` + `VAULT_ADDR` https; `KEY_LOCAL_DIR` chỉ bắt buộc với `local`; bỏ `aws-kms`; không có biến `VAULT_TOKEN` (zod strip, test canary). |
| Policy `idp-signer.hcl` | Đạt, least-privilege | 5 path đúng một key. `allowed_parameters` trên `config`/`trim` ⇒ không bật được `exportable`/`deletion_allowed`/`allow_plaintext_backup`/`auto_rotate_period` (V6 + mutation). Không có export/backup/delete/create. Rủi ro còn lại khi token app bị lộ: kẻ có token ký được JWT tuỳ ý bằng key này, và DoS được bằng `config`/`trim`. Đây là rủi ro vốn có của mọi signer, không trích xuất được key. |
| CI | Đạt | Token sinh ngẫu nhiên mỗi lần chạy, `::add-mask::` **trước** khi dùng, không dùng GitHub secret, image ghim digest, chỉ bind loopback. Preflight fail chứ không skip. |
| DEBT-394 | Đúng mức 🟡, fail-closed | Vault down + cache hết hạn ⇒ `getPublicKeys` throw ⇒ caller map ra 401/`active:false`, logout bỏ hint. Không có đường nào chấp nhận token sai hay dùng bản key cũ, nên **không** phải bypass. Đây chỉ là lỗi tín hiệu (RS/RP không phân biệt sự cố với token hỏng). Mỗi lỗi vẫn có log ERROR `vault read failed`. Để 53c gộp với cơ chế 503 là hợp lý. Runbook §8 mô tả đúng hành vi hiện tại. |
| DEBT-388 | Không xấu đi, còn đỡ hơn | Lệch fold #1 làm instance có cache cũ ký lại được sau emergency, thay vì 5xx sau khi code/RT đã bị tiêu, nên giảm một nguồn gây DEBT-388. Vault hố đen ⇒ `signJwt` reject ≤ 2×timeout (V10). Lỗi mạng **không** kích hoạt nhánh ký lại (chỉ `VaultStatusError`), nên độ trễ tối đa không cộng dồn. Rủi ro gốc (tiêu code/xoay RT trước khi ký) giữ ở DEBT-388. |

Golden: payload tự dựng `{...claims, iss, aud, iat, exp, jti, sub?}`. Ngữ nghĩa ghi đè key giống `SignJWT` (spread giữ vị trí key đã có). `exp = iat + ttl` thay vì hai lần `Date.now()` riêng, nhất quán hơn. Test golden kiểm thứ tự header, thứ tự claim và kiểu dữ liệu, rồi verify qua JWKS.

## 🟡 Nên sửa

🟡 **Hiệu năng: Vault lỗi hàng loạt ⇒ khuếch đại đọc metadata** (DEBT-395)
`vault-transit-key-provider.ts:137` — `signJwt` gọi `this.refresh(true)` (force, bỏ single-flight) sau **mọi** 400/5xx.
- Vì sao: khi Vault quá tải và trả 5xx, N request `/token` đồng thời sinh N lần đọc `keys/<k>`. Mỗi lần đọc lại tự retry 1 lần khi 5xx, tức ~2N lời gọi thêm dồn vào một Vault đang yếu, ngoài 2N lời gọi sign. Tình huống emergency thì chỉ cần một lần đọc chung.
- Đề xuất: dùng `this.refresh(false)` để các request đang chờ dùng chung một promise. Nếu promise đang bay bắt đầu trước khi rotate thì `latest` không đổi ⇒ trả lỗi gốc cho request đó. Đây là fail-closed, các request sau sẽ được ký. Thêm unit: 10 `signJwt` đồng thời đều nhận 500 ⇒ ≤ 1 lần đọc (+1 retry).

🟡 **Ponytail** (DEBT-396): xem mục ✂️. Không ảnh hưởng tính đúng.

## 💭 Nit

- `token-verifier.ts` / `vault-transit-key-provider.ts:148`: cooldown kid hint dùng **chung** mọi kid. Attacker gửi kid rác đều đặn sẽ giữ cooldown "nóng", nên token hợp lệ mang kid mới (instance khác vừa rotate normal) có thể bị 401 thêm tối đa 5 s. Thực tế lần refresh do attacker gây ra cũng nạp luôn kid mới, nên cửa sổ ≤ 5 s và không phải bypass. Ghi chú cho DEBT-393 (pre-publish key) là đủ.
- `call()` khi 403 kéo dài (ví dụ policy sai): mỗi request `sign` đều đọc lại token file 1 lần. Chấp nhận được; có thể nhớ thời điểm reload gần nhất nếu thấy I/O.
- Golden test (`keys.spec.ts`) chỉ so thứ tự và kiểu, chưa so **byte** với `SignJWT` cũ. Có thể cố định `Date.now`/`randomUUID` rồi so `decodeJwt` của hai token. Không bắt buộc.
- `VAULT_ADDR` chấp nhận query/userinfo (`https://u:p@host?x`). URL sẽ hỏng hoặc fetch từ chối (chỉ log tên lỗi). Có thể refine "không search/userinfo"; đây là cấu hình ops nên để nit.
- Clock skew app ↔ Vault ảnh hưởng `retireAt` (dùng `creation_time` của Vault so với `Date.now()` của app). NTP là giả định hạ tầng, có thể thêm một dòng vào runbook §8.

## ✂️ Ponytail

- `be/src/modules/keys/vault-transit-key-provider.ts:L420-423`: shrink: kiểm `kty !== 'RSA' || typeof n/e` lặp lại `asymmetricKeyType === 'rsa'` ngay trên. Có thể bỏ khối `if`, chỉ cast `as { n: string; e: string }` (`export` JWK của key RSA luôn có `n`/`e`).
- `be/src/modules/keys/vault-transit-key-provider.ts:L74-79`: shrink: comment `VaultNetworkError` "Never retried / logged with more than…" dễ đọc thành "không retry", trong khi lỗi mạng **có** retry (`call:361`). Viết lại một dòng rõ nghĩa.
- `be/src/modules/keys/vault-transit-key-provider.ts:L393-402`: shrink: `try/catch` rồi `if (err instanceof VaultStatusError) throw err` có thể gọn bằng cách kiểm `!res.ok` ngoài `try`, chỉ bọc `res.json()`.

net: -8 lines possible.
