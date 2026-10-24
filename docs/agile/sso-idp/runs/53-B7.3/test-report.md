# Test Report — 2026-10-24 (run 53, B7.3 phần 1: Vault Transit KeyProvider)

## Kết quả: PASS

Tổng số test tự động: be unit 475/475, `test:int` 1221/1221, `test:vault` 22/22 (14 của dev + 8 tester mới), fe-admin 1415/1415, fe-sso-test 269/269, E2E 35/35. Mutation của tester: 5 lần thử, 4 đỏ, 1 sống vì có lớp phòng thủ thứ hai. Khi tắt cả hai lớp thì test đỏ, nên lớp phòng thủ đó đã được chứng minh.

Phạm vi: diff chưa commit so với HEAD `c543329`. Tester chỉ thêm `be/test/b73-tester.vault-spec.ts`, không sửa code sản phẩm hay config.

## Lệnh đã chạy + output thực tế

Mọi lệnh chạy foreground. Log nằm ở scratchpad của phiên, không đưa vào repo.

| # | Lệnh | Exit | Output (trích) |
|---|---|---|---|
| 1 | `docker run -d --name vg-b73-vault --cap-add=IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=<openssl rand -hex 16> -p 127.0.0.1:18200:8200 hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55` | 0 | `/v1/sys/health` 200 sau 2 s. Root token chỉ nằm trong biến shell; mỗi lệnh sau đọc lại qua `docker inspect` trong script, không in ra, không ghi file |
| 2 | `pnpm -C be test:vault` (bản của dev, trước khi tester thêm test) | 0 | `Tests: 14 passed, 14 total` |
| 3 | `pnpm -C be test:vault -- b73-tester` | 1 → 0 | Lần đầu T7 đỏ do **lỗi của test**: env thiếu các biến bắt buộc khác. Sau khi sửa env và thêm control dương: `Tests: 8 passed, 8 total` |
| 4 | `pnpm -C be test:vault` (toàn bộ) | 0 | `Test Suites: 2 passed`, `Tests: 22 passed, 22 total` |
| 5 | `pnpm -C be test` | 0 | `Test Suites: 33 passed`, `Tests: 475 passed, 475 total` |
| 6 | `pnpm -C be build` | 0 | nest build + tailwind; `git status` không thấy file được theo dõi nào bị đổi |
| 7 | `pnpm -C be test:int` (lock `vg:int-lock`; `vg-test-*` đang chạy nên không phải `docker start`) | 0 | `Test Suites: 45 passed`, `Tests: 1221 passed, 1221 total`, 322 s, 0 `×`. Stack trace trong log là lỗi được ghi log có chủ đích |
| 8 | `pnpm -C be lint` | 1 → 0 | Lần đầu: 25 lỗi prettier trong file test mới. Sửa bằng `eslint --fix` (chỉ file của tester), chạy lại ⇒ 0 |
| 9 | `pnpm -C be typecheck` | 0 | `tsc --noEmit` |
| 10 | root `pnpm lint` | 0 | |
| 11 | root `pnpm -r run typecheck` | 0 | |
| 12 | root `pnpm test` | 0 | be `475 passed`; fe-admin `Test Files 64 passed`, `Tests 1415 passed`; fe-sso-test `Test Files 31 passed`, `Tests 269 passed` |
| 13 | `pnpm audit --audit-level high` | 0 | `13 vulnerabilities found — Severity: 6 low \| 7 moderate — 1 ignored: 1 high` (bản ignore đã có, không phát sinh mới) |
| 14 | `pnpm -C e2e e2e` (1 lần) | 0 | `35 passed (3.9m)`. Trước khi chạy: cổng 4000/5173/3000 trống, `E2E_REUSE` chưa đặt. Sau khi chạy: cổng trống |
| 15 | `docker rm -f vg-b73-vault`; `docker ps -a --format '{{.Names}}' \| grep vg-b73` | 0 / 1 | Grep rỗng. Image pull theo digest được giữ lại (untagged). Container khác vẫn nguyên trạng: `vg-test-*`, `aegate-mongo/redis`, `veyrigate-mailpit-1` Up |

### `be/keys` trước và sau (không đổi)

| File | sha256 | mtime |
|---|---|---|
| `3d0d39e5-….pem` | `b3c0c678…592119` | 2026-09-29 11:19:28.7527 |
| `keys.json` | `02830f97…4e4721` | 2026-09-29 11:19:28.7743 |

Trước và sau giống hệt nhau.

### Grep secret

Đã grep root token Vault (chuỗi 32 hex lấy qua `docker inspect`), `hvs\.[A-Za-z0-9]{10,}` và `VAULT_DEV_ROOT_TOKEN_ID=<hex>` trên mọi log của lần chạy này:

- Root token: 0 lần.
- `hvs.` thật: 0 lần, trừ `mut-token.log`. Đây là mutation M-d (đổi `#token` thành field thường): Jest in object provider khi T6 fail, nên token con lộ ra. Đó chính là điều T6 phải bắt được.
  - File log này đã được redact (`hvs.<REDACTED>`).
  - Tiền tố token đã xuất hiện một lần trong transcript của tester khi grep in dòng khớp.
  - Đó là token con có TTL 15 phút của Vault dev tạm, và đã mất cùng `docker rm -f`.
  - Không token nào nằm trong repo. Grep `*.md`/`*.ts`/`*.mjs`/`*.json` trong repo tìm root token: 0.

### Mutation của tester

Mỗi mutation đều có backup và kiểm sha256 trước/sau. Khôi phục **byte-identical** (`RESTORED-IDENTICAL`).

| Mutation | Kết quả |
|---|---|
| M-a: verifier `algorithms:['RS256','PS256']` | **Sống**. Lý do: JWK trong JWKS mang `alg:'RS256'`, nên `createLocalJWKSet` không chọn key cho PS256. Đây là lớp phòng thủ thứ hai |
| M-a2: M-a + bỏ `alg` khỏi JWK của Vault | **T2 đỏ**. PS256 có chữ ký Transit thật lọt qua |
| M-b: bỏ cooldown kid (`>= 0`) | **T3 đỏ** (lần thử đầu bị TS6133 do field không còn được đọc; sửa mutation rồi chạy lại) |
| M-c: dùng cache quá hạn khi refresh lỗi (fail-open) | **T5 đỏ** |
| M-d: `#token` thành field thường | **T6 đỏ** |

Không chạy lại 10 mutation của dev. Đã có bằng chứng của dev trong `log.md`.

## Test FAIL

Không có test FAIL nào do code sản phẩm. Hai lần đỏ trong lúc chạy đều do code test của tester và đã sửa:

- T7 lần đầu: env thiếu biến.
- Lint lần đầu: lỗi prettier.

## Coverage acceptance criteria

Test V1–V14 của dev (`vault-transit.vault-spec.ts`, `vault-transit-key-provider.spec.ts`, `validation.schema.spec.ts`) đã được chạy lại độc lập và đều xanh:

- [x] Task A: interface `signJwt`, golden token, hành vi token không đổi. Bằng chứng: `keys.spec.ts` (be unit 475), `test:int` 1221, E2E 35 (provider local).
- [x] V1 RS256 PKCS#1 v1.5, kid = thumbprint, PSS không verify: vault V1. Tester T1 bổ sung client JWKS chuẩn.
- [x] V2 rotate normal / retireAt / rời JWKS: vault V2.
- [x] V3 emergency: vault V3, V3b. Tester T4 kiểm full-app.
- [x] V4 hai instance + kid hint, 50 kid ≤ 1 lần đọc: vault V4. Tester T3 kiểm qua `/userinfo`, 2 cửa sổ cooldown.
- [x] V5 cache cũ ký lại bằng kid mới: vault V5.
- [x] V6 quyền token con (âm): vault V6.
- [x] V7 key exportable / plaintext backup / aes ⇒ không boot: vault V7 ×3 + full-app.
- [x] V8 init fail-closed, không lộ: vault V8 + unit. Tester T6 bổ sung.
- [x] V9 403 ⇒ đọc lại file: vault V9 + unit.
- [x] V10 hố đen ≤ 2×timeout+500 ms: unit V10.
- [x] V11 / V12: unit.
- [x] V13 config: `validation.schema.spec.ts` (be unit). Tester T7 bổ sung.
- [x] V14 full-app `KEY_PROVIDER=vault`: vault V14 + tester T1/T4.
- [x] Task C: `test:vault` fail khi thiếu env (bằng chứng của dev); CI/runbook §8 đã đọc. Runbook §8 mô tả đúng hành vi Vault down, khớp T5.

## Coverage security invariants / risk matrix

Test mới của tester nằm ở `be/test/b73-tester.vault-spec.ts`, chạy trên Vault thật, token con theo `ops/vault/idp-signer.hcl`.

| Chiều | Trường hợp | Test |
|---|---|---|
| Credential / interop | Token ký bởi Vault được verify bởi BE (`/userinfo` 200, `/introspect` `active:true`) **và** bởi client chuẩn jose `createRemoteJWKSet` qua HTTP thật tới `/jwks.json` (access + id token) | **T1** |
| Input / alg confusion | `kid` hợp lệ của Vault, payload thật, với: `alg:none`; HS256 khoá bằng modulus `n`; HS256 khoá bằng JSON của JWK; **PS256 có chữ ký Transit thật (`pss`, `salt_length:hash`)**. Đã sanity check rằng PS256 thật sự verify được nếu cho phép PS256. Kết quả cả bốn: `/userinfo` 401 (body không có `sub`), `/introspect` `active:false`; token thật vẫn 200 | **T2** (mutation M-a2) |
| Abuse / DoS khuếch đại | 50 token kid ngẫu nhiên qua `/userinfo` ⇒ ≤ 1 lần đọc Vault. Sang cửa sổ 5 s kế tiếp (đồng hồ bơm +5,001 s) thêm 50 ⇒ ≤ 1 lần đọc | **T3** (mutation M-b) |
| State / rotation | Emergency trên full-app: JWKS chỉ còn kid mới; token cũ `/userinfo` 401 + `/introspect` `active:false` + client remote JWKS reject; token mới (kid mới) `/userinfo` 200 + `active:true` + remote JWKS verify; Vault chỉ còn version 2 | **T4** |
| Dependency down (fail-closed, DEBT-394) | Cắt proxy TCP tới Vault: `/token` ≥ 500, body không có `access_token`/`id_token`/`refresh_token`/`eyJ`. Trong TTL: `/userinfo` 200 (cache). Quá TTL (+31 s): `/userinfo` **401**, `/introspect` `active:false`, `/jwks.json` ≥ 500 và không trả key cũ, log có `vault read failed: …`. Bật lại proxy ⇒ 200 | **T5** (mutation M-c). Ghi chú: code đã bị tiêu khi ký lỗi, đây là DEBT-388 đã biết |
| Exposure | `util.inspect` (showHidden/getters, depth 20), `JSON.stringify(p)`, `String(p)`, `Object.entries` không chứa token con hay đường dẫn token file. Lỗi của `signJwt`/`rotate` khi token bị revoke và `init` khi file thiếu: `inspect`/`JSON.stringify`/`stack` không có token hay đường dẫn. `afterEach` kiểm Logger Nest + toàn bộ output pino của full-app: không có root token, không `hvs.`, không token con, không thư mục token | **T6** + afterEach mọi test (mutation M-d) |
| Config prod | `production` + `vault` có `VAULT_TOKEN` (canary) nhưng thiếu `VAULT_TOKEN_FILE` ⇒ từ chối, lỗi nêu `VAULT_TOKEN_FILE`, không lặp lại canary. Control dương: thêm file thì boot được. `KEY_PROVIDER=local` ⇒ lỗi `KEY_PROVIDER`; `VAULT_ADDR=http://` ⇒ lỗi `VAULT_ADDR` | **T7** + `validation.schema.spec.ts` |
| Dependency partial (DEBT-395) | Vault `sign` trả 500 cho 10 `signJwt` đồng thời ⇒ cả 10 reject `vault sign failed: status=500` (không có token). Đếm được **10** lần đọc metadata (1 lần mỗi request, không single-flight) | **T8**: characterisation, DEBT-395 vẫn 🟡 |
| Authorization (token app) | Không export / không bật exportable / không deletion / không xoá / không ký key khác | vault V6 (dev), chạy lại xanh |

INV-19 không bị vi phạm: không có private key trong process, JWKS chỉ có `alg,e,kid,kty,n,use` (V1), key `exportable=false` được kiểm lúc boot (V7).

## Debt

Không mở debt mới (không có DEBT-397).

Đã thêm bằng chứng characterisation vào hai debt đang mở, mức giữ nguyên 🟡, hẹn 53c:
- **DEBT-394** (T5).
- **DEBT-395** (T8: 10 lần đọc cho 10 request).

Khi sửa hai debt này phải đổi kỳ vọng của T5/T8.
