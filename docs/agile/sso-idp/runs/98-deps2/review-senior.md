# Senior Review — 2026-11-21 (run 98 deps2: PR Dependabot #18–#21, DEBT-697, DEBT-711)

## Kết luận: PASS

Không có 🔴. Còn 1 🟡 (ponytail, gộp thành DEBT-713), 4 💭. Chuyển sang **tester** (gate D98.13: int FULL, `test:vault`, drill rotate local, E2E, X3, pentest on/off, CI 9/9 kèm smoke check 14 chạy thật).

## Tổng quan

Diff bám sát D98.1–D98.12, gọn, không đụng logic federation/keys (D98.10). Hai chỗ lệch so với fold đều có lý do và đã kiểm:
- `be/tsconfig.build.json` thêm `tsBuildInfoFile: ./dist/tsconfig.build.tsbuildinfo` (ngoài D98.x). Chấp nhận, lý do ở 💭 3.
- `main.ts` truyền `{ NODE_ENV, TRUST_PROXY }` thay vì `process.env` (TS2559). Hành vi y hệt.

Điểm tốt:
- Smoke check 14 ghi log ra file rồi mới grep, tránh SIGPIPE dưới pipefail (bài học DEBT-693).
- Spec T3 phủ đủ ma trận D98.12, thêm cả `' False '`.
- Lockfile sạch: một bản router, một bản jose, một bản TypeScript.

### Bằng chứng chạy lại (Git Bash, repo root, working tree hiện tại)

| Lệnh | Kết quả |
|---|---|
| `pnpm install --frozen-lockfile` | "Lockfile passes supply-chain policies", up to date |
| `pnpm audit --audit-level high` | "No known vulnerabilities found", exit 0 |
| `pnpm typecheck` (be, fe-admin, fe-sso-test, e2e) | xanh |
| `pnpm lint` (be, fe-admin, fe-sso-test) | exit 0, 0 lỗi |
| unit be | 1363/1363 (69 suite) |
| unit fe-admin | 1669/1669 |
| unit fe-sso-test | 269/269 |
| `pnpm -C be build` | `dist/main.js`; tsbuildinfo chỉ ở `be/dist/`, không có file lạc ở `be/`; `git status` không thêm file |
| `require` 2 file `dist` dùng jose + `require('jose')` trên Node 22.23.4 | OK (require(esm)) |
| `pnpm -C be test:int "federation\|token\.int\|admin-keys\|run86-key-prepublish\|runbook-drill\|demo\|userinfo\|b73c\|introspect\|jwks\|rotate\|logout"` | 9 suite, 269/269 |
| `bash -n be/scripts/docker-smoke.sh` | OK |

- `pnpm why -r`: `@tanstack/react-router` chỉ có 1.170.42, `@tanstack/router-core` chỉ có 1.171.35, `jose` chỉ có 6.2.15, `typescript` chỉ có 6.0.3. Chuỗi `typescript@7.13.0` trong output là `openapi-typescript@7.13.0`, không phải bản TS thứ hai.
- Ngày phát hành (`pnpm view <pkg> time`): kiểm mọi gói **mới xuất hiện** trong diff lockfile, kể cả các gói bắc cầu tech-lead chưa liệt kê.
  - 10 gói con TanStack (`history` 1.162.5, `react-start-client` 1.168.40, `react-start-rsc` 0.1.60, `react-start-server` 1.167.47, `router-generator` 1.167.41, `router-plugin` 1.168.43, `start-client-core` 1.170.35, `start-plugin-core` 1.171.50, `start-server-core` 1.169.40, `start-storage-context` 1.167.37): 2026-10-10.
  - `@tokenizer/inflate@0.6.0`: 2026-10-24. `tslib@2.9.1`: 10-30. `sift@17.1.4`: 10-08. `file-type@22.3.0`: 10-29. `@fastify/cors@11.4.0`: 11-02.
  - `jose@6.2.15`: 11-01. `@fastify/view@12.0.1`: 10-08. `typescript@6.0.3`: 04-16.
  - Mốc 14 ngày là 2026-11-07, nên tất cả đều đạt.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

**Identity: chữ ký token (jose 6)**
- Mọi `jwtVerify` đều pin `algorithms: ['RS256']`: `token-verifier.ts:66/87/108`, `federation.client.ts:112`, `fe-admin/src/server/oidc/id-token.ts:26`, `fe-sso-test/src/oidc/idToken.ts:42`. Mặc định thuật toán của jose 6 vì thế không ảnh hưởng; vẫn không có `none`/HS* confusion.
- `typ: 'at+jwt'` (`token-verifier.ts:111`) và kiểm tay `typ !== 'at+jwt'` của `id_token_hint` không đổi.
- `crit`: jose 6 vẫn từ chối mọi extension `crit` lạ (JWSInvalid), không đổi so với 5.
- `clockTolerance: Number.MAX_SAFE_INTEGER` (chấp nhận hint hết hạn): ngữ nghĩa so `exp`/`nbf` giữ nguyên. Int `logout`/`token` xanh.
- `KeyObject` và `CryptoKey`: không có call site nào kiểm `instanceof KeyObject` hay đọc `asymmetricKeyType` trên kết quả của jose. Ký bằng `node:crypto` (be), kiểm bằng `createLocalJWKSet` (jose import thành `CryptoKey`). kid lấy từ `calculateJwkThumbprint`, không đổi (tech-lead đã đối chiếu 5 với 6; `runbook-drill`/`run86-key-prepublish` int xanh).

**Ánh xạ lỗi 401/502 (federation)**
- Đã đọc `jose@6.2.15/dist/webapi/jwks/remote.js`:
  - `fetch(url, { signal, redirect: "manual" })`.
  - `TimeoutError` ⇒ `JWKSTimeout` (`ERR_JWKS_TIMEOUT`).
  - Lỗi mạng ⇒ TypeError, không bọc ⇒ nhánh `!(err instanceof errors.JOSEError)` ⇒ 502.
  - `status !== 200` ⇒ `JOSEError` generic ⇒ 502.
- Bổ sung so với fold: `redirect: "manual"` nghĩa là JWKS trả 3xx ⇒ status ≠ 200 ⇒ 502, **không** đi theo redirect. Không mở thêm bề mặt SSRF. URL vẫn là hằng `GOOGLE.jwksUrl` (INV-23).
- Tên lớp lỗi và `code` jose 6 dùng trong `PROVIDER_JOSE_CODES` (`ERR_JWKS_TIMEOUT`, `ERR_JOSE_GENERIC`, `ERR_JWKS_INVALID`, `ERR_JWKS_NO_MATCHING_KEY`) không đổi. jose chỉ nạp một lần (bản ESM, kể cả qua require(esm)), nên không có hazard hai bản `JOSEError` làm `instanceof` sai.

**Exposure (T3)**
- Message là hằng `TRUST_PROXY_BOOT_WARNING`, không nội suy giá trị env. Warn chỉ bắn khi giá trị rỗng, nên cũng không có gì để lộ.
- Không đổi state hay quyền. Không fail boot: fail-open có chủ đích theo D98.11, và chỉ là log.
- `main.ts` đọc `process.env` sau khi nạp `.env`, nên giá trị `TRUST_PROXY` lấy từ `.env` cũng được tính.

**Smoke check 14**
- `ENV_ARGS` không có `TRUST_PROXY`; image có `ENV NODE_ENV=production`.
- `vg-be-smoke-ok` chỉ được `docker run` một lần: không `--restart`, không `docker start` lại. Check 8 `stop` nhưng không `rm`, nên `docker logs` còn đủ log và đếm đúng 1 lần boot.
- `grep -c … || true`: khi 0 hit thì `grep` in `0` rồi exit 1, `|| true` không in gì ⇒ `warns="0"` ⇒ `fail 14`. Đúng, an toàn với `set -e` và pipefail (không có pipe).
- Pattern không chứa `§`, nên escape JSON của pino không làm lệch kết quả.

**Supply chain**
- `minimumReleaseAgeExclude` đã xoá hẳn khoá; frozen-lockfile vẫn qua chính sách.
- Không gói nào < 14 ngày tuổi (bảng ở trên). Audit high: 0.

## 🟡 Nên sửa

- [ ] **DEBT-713 (ponytail, gộp các dòng ✂️ bên dưới)**: test T3 có 2 case thừa, smoke check 14 lấy log hai lần.
  - Vì sao: case thừa làm phình spec mà không bắt thêm lỗi nào. Riêng case "never echoes" tạo cảm giác an toàn giả: cả hai input đều rỗng, nên test không chứng minh được gì về việc không in giá trị env.
  - Đề xuất: sửa ở run kế tiếp chạm file này. Không chặn run 98.

## 💭 Nit

1. **Số dòng cứng trong comment** (`be/test/federation.int-spec.ts:393`): comment "private key is exported at L2410/L2475" sẽ sai ngay khi có ai thêm dòng phía trên.
   - Cân nhắc trỏ tới tên khối test thay vì số dòng, ví dụ "exported by the run-59 F16 JWKS tests".
2. **Comment bị ngắt dòng lệch** (`be/src/modules/federation/federation.client.ts:124`): `` (wrong JWKS shape => `ERR_JWKS_INVALID`). Every`` rồi xuống dòng `// other JOSE failure …`. Comment còn đúng nội dung, chỉ cần reflow cho liền.
3. **`tsBuildInfoFile` ngoài D98.x** (`be/tsconfig.build.json:3`): chấp nhận.
   - Lý do: TS6 cộng `rootDir: ./src` đẩy tsbuildinfo ra `be/`, thành file untracked và không bị gitignore.
   - Đặt vào `dist/` thì `deleteOutDir: true` (`nest-cli.json`) xoá nó cùng output, nên incremental không bao giờ thấy tsbuildinfo cũ đi với `dist` rỗng (lỗi "tsc không emit" kinh điển).
   - `Dockerfile.dockerignore` loại `be/dist`. Stage build `find … -name '*.tsbuildinfo' -delete` trước khi copy sang runtime, nên file không lọt vào image.
   - Đã kiểm: build xong chỉ có `be/dist/tsconfig.build.tsbuildinfo`.
4. **`moduleResolution: bundler` đi với `module: commonjs`** (`be/tsconfig.json:4`):
   - TS resolve type theo condition `import`, nhưng lúc chạy Node `require` theo condition `require`. Với gói dual có type CJS và ESM khác nhau, typecheck có thể xanh trong khi runtime lệch (thường ở interop default export).
   - Hiện vô hại: `dist` giống hệt từng byte, unit/int xanh, jose chỉ có một entry.
   - Khi làm bước TS 7 (DEBT-695), cân nhắc `module`/`moduleResolution: node20`. Cặp này mô hình hoá đúng require(esm) của Node 22 và để TS báo lỗi đúng chỗ. Chỉ ghi chú vào DEBT-695, không cần DEBT mới.

## ✂️ Ponytail

- be/src/config/trust-proxy.spec.ts:L223: delete: case "TRUST_PROXY absent from the env object" trùng case `['unset', undefined]` (L214). Bỏ case này.
- be/src/config/trust-proxy.spec.ts:L241: shrink: case "never echoes an env value" so 2 input rỗng với nhau, nên không chứng minh gì. Thay bằng một dòng `expect(warning).toBe(<hằng export>)` trong `it.each` ở L213 (hoặc bỏ hẳn: message là hằng).
- be/scripts/docker-smoke.sh:L303: delete: `docker logs vg-be-smoke-ok >"$TMP/log"` lặp lại đúng lệnh ở check 11 (L265). Check 12 và 13 không ghi đè `$TMP/log`, nên `grep -c` file sẵn có.

net: -9 lines possible.
