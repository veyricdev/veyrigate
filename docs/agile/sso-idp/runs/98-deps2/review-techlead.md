# Tech Lead Review — 2026-11-21 (run 98: PR Dependabot #18–#21, DEBT-697, DEBT-711)

## Kết luận: PASS (có điều kiện: làm đúng D98.1–D98.14 ở cuối `tasks.md`)

Áp dụng cả 4 PR trên `develop` bằng pnpm, kèm 3 chỗ PR thiếu:
- #18 phải bump thêm `@tanstack/react-router` lên 1.170.42. Nếu không, fe-admin cài 2 bản router.
- #19 cần 1 test int tạo key `extractable`.
- #21 cần sửa tsconfig: bỏ `baseUrl`, đặt `rootDir` cho bản build.

T2: xoá hết 9 mục `minimumReleaseAgeExclude`. T3: thêm một dòng warn lúc boot, chỉ khi `NODE_ENV=production` và `TRUST_PROXY` không được đặt (unset hoặc rỗng).

## Bằng chứng

Thử trên git worktree tạm trong scratchpad, ở HEAD `5613da6`. Áp lần lượt T2, #18, #19, #20, #21. Worktree đã xoá và đã `git worktree prune`. Working tree và lockfile của repo không đổi.

### Ngày phát hành (`pnpm view <pkg> time`)

Mốc 14 ngày tính tới 2026-11-21 là 2026-11-07. Mọi bản đích đều đạt. Bản mới nhất là `mongoose@9.12.0`, phát hành 2026-11-04T22:27Z. Nếu áp sau ngày này thì càng cũ hơn, vẫn đạt.

| Gói | Bản | Ngày |
|---|---|---|
| @nestjs/common, core, platform-fastify, testing | 12.3.3 | 2026-11-04 |
| @nestjs/config | 12.1.0 | 2026-11-04 |
| mongoose (kéo mongodb 7.8.0, phát hành 2026-10-30) | 9.12.0 | 2026-11-04 |
| @tanstack/react-query (query-core 5.106.0) | 5.106.0 | 2026-11-04 |
| @tanstack/react-start (router-core 1.171.35) | 1.168.61 | 2026-10-10 |
| @tanstack/react-router | 1.170.42 | 2026-10-10 |
| lucide-react | 1.68.0 | 2026-11-04 |
| jose | 6.2.15 | 2026-11-01 |
| @fastify/view (fastify-plugin 6.0.0, phát hành 2026-06-09) | 12.0.1 | 2026-10-08 |
| typescript | 6.0.3 | 2026-04-16 |

Các gói bắc cầu mới (`fastify@5.12.8`, `@fastify/cors@11.4.0`, `tslib@2.9.1`, `file-type@22.3.0`, `sift@17.1.4`) đều phát hành ≤ 2026-11-02. `pnpm install --frozen-lockfile` sau khi áp tất cả báo "Lockfile passes supply-chain policies", **không còn mục exclude nào**.

### #18 (nhóm minor/patch)

- **Lỗi thật trong PR:** `@tanstack/react-start@1.168.61` pin chính xác `@tanstack/react-router@1.170.42`. Dependabot không bump router trực tiếp vì `ignore >1.170.41` (D96.10). Do đó lockfile của PR có cả `react-router@1.170.41` (dep trực tiếp) lẫn `1.170.42` (qua Start và router-plugin). Hai bản router trong một app React sẽ lệch context ⇒ phải bump router trực tiếp lên 1.170.42.
- Start 1.168.61 vẫn trước mốc vỡ API 1.169.0, vì `start-server-core` 1.169.40 < 1.169.41. Diff dist so với 1.168.60:
  - `start-server-core/request-response.js`: chỉ tách biến `const event = getH3Event()`. `getResponseHeaders` không đổi (không trả bản sao), nên rủi ro mất Set-Cookie/no-store của DEBT-694 **không** áp dụng.
  - `router-core/ssr/ssr-server.js`: `getNormalizedURL` giữ nguyên, chỉ thêm export `dehydrateMatch`.
  - h3-v2 vẫn 2.0.1-rc.20, srvx 0.11.22.
- fe-admin: typecheck xanh. Test 1668/1669: case đỏ duy nhất là `protocol-relative-risk.test.ts` "is the version the fold verified (1.171.34)", tức là pin phiên bản router-core mà DEBT-442 cố ý đặt ra. Diff ở trên là bước "re-run knowingly" ⇒ đổi kỳ vọng thành 1.171.35. Build và `check:bundle` xanh (0 hit).
- `@nestjs/platform-fastify@12.3.3`: vẫn `@fastify/middie@9.3.6` và `light-my-request@6.8.0` (y như 12.3.2), fastify 5.12.7 → 5.12.8. nestjs-pino không đổi ⇒ access log (D96 retry 1) không đổi; `HYG-ACCESSLOG` của pentest canh. Override `fastify>light-my-request: 6.6.0` (D96.7) vẫn áp: lockfile có cả 6.6.0 (fastify) và 6.8.0 (platform-fastify, như trước).
- be: typecheck xanh, unit 1351/1351. `pnpm audit --audit-level high` exit 0.
- mongoose 9.12 dùng driver `mongodb ~7.8` (7.8.0). Driver 7 hỗ trợ server 7.0 replica set. Cần int FULL (Mongo 7 rs0) để xác nhận transaction/index.

### #19 jose 5.10.0 → 6.2.15 (be). fe-admin và fe-sso-test đã ở 6.2.12, nay lên patch 6.2.15

- jose 6 chỉ có ESM (`"type":"module"`, exports chỉ có `types`/`default`). Ảnh hưởng tới từng cách chạy:
  - Jest của be đã chạy ESM (`--experimental-vm-modules`, `useESM`) vì NestJS 12 ⇒ unit 1351/1351 xanh.
  - Bản build CJS (`dist/*.js` gọi `require('jose')`): Node 22.23.4 `require(esm)` được, `require('./dist/modules/keys/token-verifier.js')` OK.
  - Drill (`scripts/drills/lib.mjs`, `createRequire` + `require('jose')`): OK.
  - ts-node (`start:e2e`, `mock-google.ts`): load OK.
  - Không cần shim như cookie@2 ở D96.7.
- Call site (be):

  | Nhóm | Vị trí |
  |---|---|
  | ký | `token-signer.ts`, `local-key-provider.ts` (chỉ dùng type `JWTPayload`, ký bằng `node:crypto`) |
  | kiểm | `token-verifier.ts` (`createLocalJWKSet`, `jwtVerify`, `decodeProtectedHeader`) |
  | Vault Transit | `vault-transit-key-provider.ts` (`calculateJwkThumbprint` ⇒ kid) |
  | federation | `federation.client.ts` (`jwtVerify`, `errors`), `providers.ts` (`createRemoteJWKSet`, `timeoutDuration`) |
  | drill/pentest | `scripts/drills/rotate-drill.mjs` (`jwtVerify`, `createRemoteJWKSet`, `decodeProtectedHeader`), `scripts/pentest/checks.mjs` (`decodeJwt`) |
  | test | 11 spec int/vault/e2e |

  fe-admin dùng `createRemoteJWKSet` (BFF) và `jwtVerify` (id-token). fe-sso-test dùng `jwtVerify` và `createRemoteJWKSet`.
- Breaking change đã kiểm bằng cách chạy thật:
  1. `generateKeyPair()` giờ mặc định trả key **non-extractable**. `exportJWK(privateKey)` ném `TypeError: non-extractable CryptoKey cannot be exported as a JWK`. Đúng chỗ này ở `be/test/federation.int-spec.ts:393` (`googleKey`, được export private ở dòng 2409 và 2474, khối run-59 F16) ⇒ int đỏ nếu không sửa. Các chỗ khác chỉ export public key (luôn export được). fe-admin `fake-idp.ts` đã dùng `{ extractable: true }`.
  2. Input `KeyObject` (key của `node:crypto`) vẫn ký và kiểm được, đã thử.
  3. `calculateJwkThumbprint` cho **cùng kết quả** giữa 5.10.0 và 6.2.15 trên cùng JWK. kid của key đang có không đổi, nên token và JWKS đã phát hành vẫn kiểm được sau deploy.
  4. JWKS từ xa giờ lấy bằng `fetch` thay vì `http.get`. Cách phân loại lỗi trong `federation.client.ts` vẫn đúng:
     - non-200 hoặc non-JSON ⇒ `JOSEError` `ERR_JOSE_GENERIC`;
     - timeout ⇒ `JWKSTimeout`;
     - lỗi mạng ⇒ `TypeError` (không phải JOSE) ⇒ 502;
     - JWKS sai dạng ⇒ `JWKSInvalid`.

     `createRemoteJWKSet(...).jwks()` vẫn có, nên DEBT-445 (key set rỗng ⇒ 502) vẫn chạy. Comment "jose 5.10.0 runtime/fetch_jwks.js" ở `federation.client.ts:122` và `providers.ts:50` đã cũ, phải sửa.
- Kết quả: be typecheck, unit 1351, build, lint đều xanh. fe-admin 1669 (sau pin DEBT-442), fe-sso-test 269/269.

### #20 @fastify/view 11.1.1 → 12.0.1

- Diff `index.js` có 2 thay đổi:
  1. Thêm engine `squirrelly`.
  2. `engine = resolvedEngine?.default ?? resolvedEngine`, để engine truyền vào dạng module namespace vẫn dùng được.

  be truyền `{ eta: new Eta({...}) }` (`bootstrap.ts:53`). Instance Eta không có thuộc tính `default` (đã thử), nên hành vi giữ nguyên.
- Phụ thuộc chuyển sang `fastify-plugin ^6.0.0`, bản mà các plugin `@fastify/*` khác trong lockfile đã dùng sẵn. Kiểu bỏ alias deprecated `PointOfViewOptions`; repo không dùng alias này.
- be unit 1351 xanh. Render trang login, consent, MFA và auto-escape được int FULL, E2E và case XSS của pentest bao phủ.

### #21 TypeScript 5.7.3 → 6.0.3 (dev)

- `tsc`:
  - be và fe-admin báo `TS5101 Option 'baseUrl' is deprecated`. Bỏ `baseUrl` ⇒ xanh: be không import kiểu `src/...`, còn `paths` của fe-admin đã dùng `./src/*`.
  - be giữ `module: commonjs`. `moduleResolution` ngầm định chạy được. `node10` bị TS6 deprecate (`TS5107`). Đặt **tường minh `"moduleResolution": "bundler"`** ⇒ typecheck xanh, và `dist` build ra giống hệt từng byte so với khi để ngầm định.
  - fe-sso-test và e2e xanh, không cần sửa.
- `nest build` báo `TS5011` (TS6 đổi mặc định `rootDir` thành thư mục chứa tsconfig, nên đòi `rootDir` tường minh). Thêm `"compilerOptions": { "rootDir": "./src" }` vào `be/tsconfig.build.json` ⇒ ra `dist/main.js` đúng bố cục cũ. Không đặt trong `tsconfig.json`, vì file đó include cả `test/`.
- Công cụ:
  - ts-jest 29.4.15 (peer `<7`): be unit 1351 xanh.
  - typescript-eslint 8.72.1 (peer `<6.1.0`): lint be, fe-admin, fe-sso-test 0 lỗi.
  - Nest CLI build OK.
  - ts-node 10.9.2 load `mock-google.ts` OK.
  - fe-admin `vite build` và fe-sso-test `tsc -b && vite build` OK.
  - openapi-typescript 7.13.0 có peer `typescript ^5.x` (bản mới nhất, chưa có bản mới hơn) ⇒ cảnh báo peer. Chạy `openapi-typescript openapi/admin.json` ra file **giống hệt** `schema.d.ts` hiện tại ⇒ chấp nhận, ghi DEBT-712.
- Peer `@nestjs/schematics@12.0.13` đòi `typescript >=6.0.0` nay đã thoả, nên mất 1 cảnh báo peer cũ.
- `pnpm audit --audit-level high` exit 0.

### T2 DEBT-697

Bỏ **cả 9 mục cùng lúc** rồi chạy `pnpm install --frozen-lockfile` ⇒ "Lockfile passes supply-chain policies (930 entries)". Trên lockfile sau khi áp đủ 4 PR, kết quả cũng vậy. Bỏ tất cả mà vẫn qua thì không mục nào còn cần, nên không phải thử từng mục.

### T3 DEBT-711

`main.ts` parse `TRUST_PROXY` trước khi tạo adapter. `parseTrustProxy` trả `false` cho cả unset, rỗng và `false`. Pentest dùng `NODE_ENV=test`, nên warn không làm nhiễu harness. `e2e-main.ts` từ chối production. Docker smoke (`be/scripts/docker-smoke.sh`, job `be-image`) chạy image production **không** có `TRUST_PROXY`, nên đây là chỗ đo được warn trên bản build thật.

## Kiến trúc đề xuất

Không đổi kiến trúc. Hai chỉnh cấu hình: `be/tsconfig.json` có `moduleResolution: bundler`, `be/tsconfig.build.json` có `rootDir: ./src`. Đây là bước đệm TS 7 (DEBT-695 còn mở cho TS 7).

## Điểm mạnh

- Chính sách 14 ngày chạy máy móc qua `--frozen-lockfile`. Nhờ vậy dọn ngoại lệ (T2) chỉ cần đúng một lệnh để kiểm.
- Test pin phiên bản router-core (DEBT-442) bắt được việc bump TanStack ngầm, đúng như thiết kế.
- Phân loại lỗi JWKS dựa trên lớp lỗi và code của jose, không dựa trên message, nên đổi `http.get` sang `fetch` không làm vỡ.

## Vấn đề (đã chốt cách xử lý; làm khác ⇒ senior REJECT)

- [ ] #18 phải kèm `@tanstack/react-router@1.170.42`. `pnpm why -r @tanstack/react-router` chỉ được có **một** bản (D98.2).
- [ ] Không bump Start lên ≥ 1.169 hay router > 1.170.42 (DEBT-694 vẫn mở).
- [ ] `federation.int-spec.ts:393` phải dùng `generateKeyPair('RS256', { extractable: true })`. Không được nới chỗ khác (D98.5).
- [ ] TS6: không dùng `ignoreDeprecations: "6.0"` để né `baseUrl`. Phải bỏ thật (D98.8).
- [ ] Không thêm lại `minimumReleaseAgeExclude`. Gặp bản < 14 ngày ⇒ hạ phiên bản (D98.10).
- [ ] Warn T3 không được in giá trị env và không được làm boot fail (D98.11).

## Đề xuất (không bắt buộc)

- Khi openapi-typescript có bản hỗ trợ TS 6 (≥ 14 ngày) thì bump để hết cảnh báo peer (DEBT-712).
- `@types/node` 22.10.5 < `^22.12` (peer của vite 8.3.5) là cảnh báo peer có từ trước, không thuộc run này. Gộp vào lần bump Node/types sau.
