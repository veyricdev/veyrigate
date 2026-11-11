# Test report — run 83 (deps-security)

Người chạy gate: frontend-dev, 2026-11-10 (sau backend-dev T1–T5 + T6). Kết luận: **xanh trừ E2E 38 chưa chạy** (cổng `:5173` bị tiến trình ngoài `veyai-studio` vite, pid 36252, giữ trên `[::1]:5173`; không kill theo chỉ thị ⇒ chờ orchestrator/người dùng giải phóng cổng rồi chạy `pnpm -C e2e e2e`).

## T1 — nodemailer 10.0.12 → 10.1.7 (số của backend-dev, `log.md`)

| Ca `mailer.spec.ts` (SMTP giả `node:net`, ghi RCPT TO) | 10.0.12 | 10.1.7 |
|---|---|---|
| (a) baseline `victim@good.test` ⇒ đúng 1 RCPT | xanh | xanh |
| (b) GHSA-85x2 quoted local part chứa `>` | **đỏ**: RCPT `<attacker@evil.test>` | xanh |
| (c) GHSA-m943 `;` trong quoted/comment | **đỏ**: RCPT `<attacker@evil.test>` | xanh |
| (d) GHSA-8c8m comment lồng kết thúc sớm | **đỏ**: RCPT `<attacker@evil.test>` | xanh |
| (e) GHSA-g73g comment trong angle-addr | **đỏ**: RCPT `<"(attacker@evil.test)victim"@good.test>` | xanh (đúng `<victim@good.test>`) |

- Tổng: 10.0.12 4/4 ca GHSA đỏ, 10.1.7 4/4 xanh; spec +13 ca (be unit 806 → 819). Timeout spec ~5.03 s (biên ≥ 4500, < 9000 ms giữ nguyên).
- AC3 (`@IsEmail()`): từ chối cả 4 chuỗi (b)–(e), nhưng NHẬN `"a;attacker@evil.test"@good.test` và `"x>attacker@evil.test"@good.test` (với 10.1.7 cả hai cho đúng 1 RCPT @good.test) ⇒ đầu vào DEBT-550.
- backend-dev (T1–T5): be typecheck/lint 0 lỗi, unit 819/819, build xanh, int FULL 64 suite **1968/1968**, `vg-int-*` 0 → 0; mailer+authentication int 6/6 (gửi thật qua mailpit).

## T6 — seroval + eslint FE

- `pnpm-workspace.yaml` override `seroval`/`seroval-plugins` 1.6.8 → **1.6.12** (giữ override, comment ghi 2 GHSA + lý do giữ pin: bỏ pin resolve 1.8.0 2026-11-09). `fe-admin` + `fe-sso-test`: `eslint`, `@eslint/js` 9.18.0 → **9.39.5**.
- `pnpm why -r`: seroval chỉ 1.6.12; seroval-plugins chỉ 1.6.12; `@eslint/plugin-kit` chỉ 0.4.1 (0.2.8 đã biến mất).
- eslint 9.39.5: `fe-admin lint` và `fe-sso-test lint` exit 0, **không lỗi mới, không sửa code**.

## T7 — gate chung (output thật)

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | exit 0, "Lockfile is up to date, resolution step is skipped" |
| 2a | `pnpm audit` | exit 0: "All found vulnerabilities were already reviewed and decided to be ignored / 1 ignored: 1 low" (GHSA-gcqx-w48m-w2h4 deepmerge) |
| 2b | `pnpm audit --json` | exit 0; `metadata.vulnerabilities` = `{info:0, low:1, moderate:0, high:0, critical:0}`, `advisories` rỗng (0). `low:1` là chính deepmerge đã ignore (pnpm vẫn đếm trong metadata) — không còn advisory nào khác |
| 2c | `pnpm audit --audit-level high` | exit 0 (cùng thông báo 1 ignored low) |
| 3 | Diff lockfile T6 (trước/sau T6, key gói không tính snapshot peer) | Mới: `seroval@1.6.12` (2026-10-21T11:35Z, 20 ngày), `seroval-plugins@1.6.12` (2026-10-21T11:35Z, 20 ngày). `eslint@9.39.5` (2026-07-10), `@eslint/js@9.39.5` (2026-07-10), `@eslint/config-array@0.21.2` (2026-03-06) đã có sẵn từ be (T4), nay dùng chung. Gỡ: `eslint@9.18.0`, `@eslint/js@9.18.0`, `@eslint/config-array@0.19.2`, `@eslint/core@0.10.0`, `@eslint/core@0.13.0`, `@eslint/plugin-kit@0.2.8`, `seroval@1.6.8`, `seroval-plugins@1.6.8`. **Không gói nào < 14 ngày ngoài ngoại lệ.** Importer so với HEAD: `be`, `fe-admin`, `fe-sso-test` đổi (đúng 3 package.json đã sửa), `.` và `e2e` không đổi |
| 4 | `pnpm typecheck` (be, e2e, fe-admin, fe-sso-test) | exit 0, cả 4 Done |
| 4 | `pnpm lint` (be, fe-admin, fe-sso-test; e2e không có script lint) | exit 0, cả 3 Done |
| 4 | `pnpm -C be test` | 43 suite, **819/819** |
| 5 | `pnpm -C fe-admin test` | 68 file, **1613/1613** |
| 5 | `pnpm -C fe-admin build` | exit 0 (client + server, `dist/server/server.js` 264.38 kB) |
| 5 | `pnpm -C fe-admin check:bundle` | exit 0: 23 client file, 8 server env name, 22 chunk, 0 Function/eval, **0 hit** |
| 6 | `pnpm -C fe-sso-test test` | 31 file, **269/269** (không file test nào của fe-sso-test đổi trong run) |
| 6 | `pnpm -C fe-sso-test build` | exit 0 |
| 7 | `vitest run router server-entry csp-nonce-ssr ssr-unavailable error-boundary admin-fn users-fn resources-fn secrets-fn signing-keys-fn audit-fn health-fn` (trong fe-admin; lưu ý `pnpm -C fe-admin test -- …` chuyển `--` cho vitest nên chạy FULL, đã dùng `pnpm exec vitest run …`) | 16 file, **395/395** |
| 8a | E2E `pnpm -C e2e e2e` (38) | **CHƯA CHẠY**: `:4000`, `:3000` trống, nhưng `:5173` LISTENING pid 36252 (`veyai-studio` vite) — E2E cần fe-sso-test Vite `:5173` strictPort. Không kill. Kiểm lại trước khi viết report: vẫn bị giữ |
| 8b | X3 `pnpm -C e2e e2e:x3` (cổng 4100/5273/5274/8443 trống trước khi chạy) | **42 passed (9.7m)** |
| 9 | `docker build -f be/Dockerfile -t veyrigate-be:run83 .` | exit 0; trong image (`/app`): nodemailer **10.1.7**, fastify **5.12.7**, `require` cả hai OK |
| 9 | `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:run83 .` | exit 0 |
| 9 | `docker rmi veyrigate-be:run83 veyrigate-fe-admin:run83` | Untagged cả 2; `docker images` không còn tag `run83` |

## Ghi chú

- `pnpm peers check` có 3 peer chưa khớp, không do T6: `ts-jest@29.2.5` muốn jest ^29 (có từ trước), `@nestjs/schematics@12.0.13` muốn typescript >=6.0.0 (từ T3; build/lint be xanh), `vite@8.3.4` muốn `@types/node` ^20.19 || >=22.12 (có từ trước). Đã báo, không mở DEBT mới.
- Không sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`; không đụng DB `sso-idp`.
- Việc còn lại: E2E 38 khi `:5173` trống.

---

# Test Report (tester) — 2026-11-10/11

## Kết quả: PASS (0 🔴; 1 💭 mới DEBT-559)

Phiên tester bị ngắt giữa chừng (2026-11-10) rồi chạy tiếp 2026-11-11; số dưới đây là output thật của các lệnh, lượt cuối ghi rõ. `vg-test-mongo`/`vg-test-redis` đã dừng qua đêm ⇒ `docker start vg-test-mongo vg-test-redis` (được phép) trước int lượt 2.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm audit` | exit 0: "All found vulnerabilities were already reviewed and decided to be ignored / 1 ignored: 1 low" (deepmerge GHSA-gcqx) |
| 2 | `pnpm install --frozen-lockfile` | exit 0, "Lockfile is up to date, resolution step is skipped"; `git status` không đổi |
| 3 | `pnpm -C be test` | 43 suite, **819/819** |
| 4 | `pnpm -C be test:int` FULL lượt 1 (trước khi có spec mới) | 64 suite, **1968/1968**, exit 0 |
| 5 | `pnpm -C be test:int` FULL lượt 2 (có `run83-tester`) | 65 suite, **1982/1982**, exit 0 (725 s). `mailer.int-spec` (gửi thật qua mailpit `veyrigate-mailpit-1`), `static-assets`, `security-headers`, `run59-http-edge-tester`, `run73-host-cookie`, `b74-tester`, `run83-tester` PASS |
| 6 | `vg-int-*` trên `vg-test-mongo` | trước 0, sau lượt 1: 0, sau lượt 2: 0 |
| 7 | `pnpm -C fe-admin test` | 68 file, **1613/1613** |
| 8 | `pnpm -C fe-sso-test test` | 31 file, **269/269** |
| 9 | E2E `pnpm -C e2e e2e` (kiểm ngay trước: `:4000`, `:5173`, `:3000` trống) | **38 passed (6.3m)**, exit 0. Log có 4 dòng `[fe-admin] server function failed … "Invalid client id"` = ca âm có chủ đích (PATCH client không tồn tại), không phải lỗi |
| 10 | X3 | không chạy lại (42/42 đã chạy trong run, theo chỉ thị) |

## Kiểm độc lập theo vùng rủi ro của bản nâng

- **fastify 5.12.7 / Nest 12.2.0 — biên HTTP:** body limit 413, content-type 415, header bảo mật + `no-store`/cacheable, trang lỗi HTML/JSON, bad URL (DEBT-239), cookie `__Host-` đều đã có int (b74/run59/run73/security-headers/run81/...) và xanh trong cả 2 lượt FULL; trust proxy phủ bằng unit `src/config/trust-proxy.spec.ts` (FastifyAdapter thật) trong 819. Không thấy khoảng trống.
- **`@fastify/static` 10.1.10 (+ `@fastify/send` 4.2.1):** khoảng trống = validator cache, HEAD, Range, và encoding traversal khác bản trong `static-assets.int-spec.ts` ⇒ thêm `be/test/run83-tester.int-spec.ts` (14 ca, xanh):
  - caching: 200 có ETag (weak `W/"size-mtime"` — mặc định của send), Last-Modified, `cache-control` có `max-age=0`, không `no-store`; If-None-Match ⇒ 304 body rỗng; If-Modified-Since ⇒ 304; ETag cũ ⇒ 200 đầy đủ.
  - HEAD ⇒ 200, `content-length` = byte GET, body rỗng; `Range: bytes=0-9` ⇒ 206 + `content-range` đúng + đúng 10 byte; range vượt ⇒ 416.
  - traversal (đi tới `/assets/` không bị WHATWG chuẩn hoá trước): `%252e%252e/`, `%252e%252e%252f`, `..%5c..%5c`, `%2e%2e%5c%2e%2e%5c`, `..%00/`, `C:%5cWindows%5cwin.ini`, `%2fetc%2fhosts` ⇒ không 200, < 500, không lộ nội dung `app.module.ts`/`package.json`/win.ini.
  - Đã bỏ 5 biến thể (`.%2e`, `%2e.`, `..\`, `%c0%ae`, `styles.css%00/../../`): inject/WHATWG chuẩn hoá thành `/app.module.ts` hoặc fastify 400 trước khi tới static ⇒ không mutation nào làm đỏ, không đo được `@fastify/static`.
- **Mutation** (`be/src/bootstrap.ts`, mỗi lần khôi phục bằng bản sao rồi `sha256sum -c` = `0ffcc167…dcb3` OK; `git diff --stat` sau cùng chỉ có file của run 83):

  | Mutation | Ca đỏ |
  |---|---|
  | M1 `etag: false, lastModified: false` | 3 (200 validators, If-None-Match, If-Modified-Since) |
  | M2 `acceptRanges: false` | 2 (206, 416) |
  | M3 `cacheControl: false` | 1 (200 validators) |
  | M4 thay `@fastify/static` bằng handler ngây thơ `readFile(join(public, decodeURIComponent(rest)))` | **14/14** (mọi ca, kể cả stale ETag, HEAD, 7 traversal) |

- **nodemailer — RCPT vẫn phân biệt phiên bản:** bản sao ngoài repo (`scratchpad/nm-regress/deps`, `npm install --ignore-scripts` alias `nodemailer@10.0.12` + `@10.1.7`, không đụng lockfile/package.json của repo), script dựng lại đúng logic SMTP giả + assert của `mailer.spec.ts` (cùng `createTransport` options, chỉ `EENVELOPE` = rejected):
  - 10.0.12: **4/7 đỏ** — 85x2 RCPT `<attacker@evil.test>` (+ `<"\"x">`, `<""@good.test>`), m943 `<attacker@evil.test>`, 8c8m `<attacker@evil.test>`, g73g `<"(attacker@evil.test)victim"@good.test>`; baseline + 2 ca `@IsEmail()`-accepted xanh.
  - 10.1.7: **0/7 đỏ** — khớp số backend-dev. Chạy 2 lần (10/11 và 11/11), cùng kết quả.
- `mailer.spec.ts` sau DEBT-555 nằm trong be unit 819 (xanh).

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] T1 AC1/AC2/AC3 — be unit 819 (`mailer.spec.ts`), bản sao 10.0.12 vs 10.1.7 ở trên, `mailer.int-spec` gửi thật
- [x] T2 fastify/Nest — int FULL 2 lượt + `run83-tester`; số test không giảm (1968 → 1982)
- [x] T3 `@fastify/static` — `static-assets` + `run83-tester` (14 ca, mutation M1–M4)
- [x] T4/T6 tooling — unit 819, fe-admin 1613, fe-sso-test 269
- [x] T7 — audit exit 0, frozen install, int FULL, `vg-int-*` 0 → 0, E2E 38

## Coverage risk matrix
- [x] Input: encoded/double-encoded/backslash/NUL/drive-path traversal — `run83-tester` traversal
- [x] Input: header hostile (Range vượt, ETag giả) — `run83-tester`
- [x] Exposure: nội dung ngoài `public/` không vào response — traversal; RCPT không ra domain lạ — `mailer.spec` + bản sao
- [x] Dependency: SMTP timeout — `mailer.spec` (biên 4500–9000 ms)
- [ ] Exposure: path request được echo trong 404 route không khớp ⇒ 💭 DEBT-559 (có từ trước, Nest mặc định, không chặn)
