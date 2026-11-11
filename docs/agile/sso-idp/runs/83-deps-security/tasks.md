# Run 83 — cập nhật dependency có advisory (M7, lane BE + FE)

Nguồn: `pnpm audit` 2026-11-10 (20 advisory: 13 moderate, 7 low; bản JSON ở scratchpad orchestrator, chạy lại `pnpm audit --json` để có số mới) + push `develop` 2026-11-10: GitHub Dependabot báo 6 cảnh báo trên default branch (2 high, 4 moderate) — máy không có `gh`, chi tiết high chưa xem được (có thể trùng hoặc khác `pnpm audit`). Analyst bỏ qua. Người dùng ủy quyền chốt theo tiêu chí production (`plan.md` §12).

## Advisory theo gói (từ `pnpm audit`)
- **be, runtime**: `nodemailer` (>=3 <10.1.4, moderate ×5 ⇒ cần >= 10.1.4, có thể là major), `fastify` (>=5.12.2 <5.12.6, low ⇒ patch), `fast-uri` 3.x (<3.1.9) và 4.x (<4.2.3) qua fastify/ajv (moderate), `minimatch` (<11.0.1, qua `@nestjs/swagger>@fastify/static>glob`).
- **be, dev**: `glob` (<=14.0.1, qua jest reporters), `@eslint/plugin-kit` (<0.3.4), `deepmerge` (<=4.3.1, chưa có bản vá, qua jest-config).
- **fe-admin, runtime**: `seroval` (<1.6.11, qua `@tanstack/react-router>@tanstack/router-core`).

## Yêu cầu
- Tech-lead: chốt từng gói — nâng trực tiếp, nâng cha, hay `pnpm.overrides` (chỉ khi cha chưa có bản dùng bản vá); gói không có bản vá (deepmerge, chỉ dev) ⇒ ghi chấp nhận rủi ro có lý do. Đọc changelog major (nodemailer) — API `createTransport`/`sendMail` mà `be` dùng có đổi không.
- Không thêm dependency mới. Cài gói cần mạng: được phép (người dùng ủy quyền "tự xử lý"), chỉ từ registry npm qua pnpm, không `npx` gói lạ.
- Sau khi nâng: `pnpm audit` không còn moderate/high nào sửa được; lockfile commit cùng.
- Gate đầy đủ: typecheck/lint, be unit, int FULL (`vg-int-*` không tăng), fe-admin test + build, E2E 38 (gửi mail qua mailpit — magic link/OTP nếu có), X3 42.

## Fold tech-lead (2026-11-10)

Kết luận: **PASS**. Lý do chi tiết: `review-techlead.md`. Số liệu `pnpm audit` chạy lại 2026-11-10: 20 advisory (13 moderate, 7 low, 0 high), giống analyst. Thứ tự: backend-dev làm T1→T5 trước (cùng `pnpm-lock.yaml` + `pnpm-workspace.yaml`), frontend-dev làm T6 sau khi backend-dev xong lockfile. Gate chung T7 chạy sau cùng. Không thêm dependency trực tiếp mới. Mọi phiên bản là **pin chính xác** (không `^`/`~`), cài chỉ từ registry npm qua pnpm.

Ngoại lệ quy tắc 14 ngày (bản sửa bảo mật không chờ, `plan.md` §12 Q62.1), chỉ các gói sau: `@fastify/static` 10.1.10 (2026-11-04), `glob` 14.0.4 (2026-11-06), `minimatch` 11.0.5 (2026-11-05), `@isaacs/nonrecursive-glob-match` 1.1.0 (2026-11-05, dep mới của minimatch 11, tác giả isaacs, 0 dep, không install script), `@nestjs/cli` 12.0.12 (2026-11-06), `@nestjs/schematics` 12.0.13 (2026-11-06) và dep transitive mà chúng pin (vd. `@angular-devkit/*` 22.2.6: ghi ngày vào test-report). Gói khác < 14 ngày xuất hiện trong diff lockfile ⇒ dừng, báo lại tech-lead.

### [BE] backend-dev

- [x] **T1 — nodemailer 10.0.12 → 10.1.7** (`be/package.json` dependencies). Vá 5 GHSA: GHSA-4ffr-jq9g-5ffx, GHSA-g73g-hqqh-jr95 (sửa từ 10.0.13), GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h (sửa từ 10.1.4). Cùng major 10 (không phải major bump); changelog 10.0.13–10.1.7 không có breaking; `createTransport({ url, connectionTimeout, greetingTimeout, socketTimeout })` + `sendMail({ from, to, subject, text, html })` trong `be/src/modules/mailer/smtp.mailer.ts` giữ nguyên, **không sửa code sản phẩm**.
  - AC1: `be/src/modules/mailer/mailer.spec.ts` ca timeout vẫn xanh với biên hiện có (≥ 4500 ms, < 9000 ms). Lưu ý 10.1.0: thời gian chờ greeting nay tính vào `connectionTimeout` (ngân sách connect + greeting = 5 s, trước là tới 10 s) ⇒ chặt hơn, đúng ý. Nếu câu lỗi đổi làm `/greeting|timeout/i` đỏ: chỉ nới regex theo câu mới, **không** nới biên thời gian.
  - AC2 (ca âm mới, unit, trong `mailer.spec.ts`): server SMTP giả bằng `node:net` (220 → EHLO 250 → MAIL 250 → ghi mọi `RCPT TO` → DATA 354/250 → QUIT 221), gửi `SmtpMailer.send` với ≥ 5 giá trị `to`: (a) baseline `victim@good.test` ⇒ đúng 1 RCPT `<victim@good.test>`; (b) quoted local part chứa `>` dẫn tới domain khác (GHSA-85x2); (c) `;` trong quoted string/comment cắt group (GHSA-m943); (d) comment lồng kết thúc sớm (GHSA-8c8m); (e) comment trong angle-addr (GHSA-g73g). Dựng chuỗi sao cho domain "lậu" là `evil.test`. Kỳ vọng mỗi ca (b)–(e): **không** RCPT nào chứa `evil.test`, hoặc `send` reject. Ghi vào test-report kết quả ca này trên 10.0.12 (trước khi nâng: ít nhất 1 ca đỏ) và trên 10.1.7 (xanh).
  - AC3 (characterization, không sửa DTO): 1 unit kiểm `class-validator` `@IsEmail()` (như `RegisterDto`/`EmailDto`, `ui.controller.ts:41-52`) nhận hay từ chối 4 chuỗi hostile ở AC2; chỉ ghi kết quả (đầu vào cho DEBT-550), không đổi hành vi.
  - Verify: `pnpm -C be test -- mailer`; `pnpm -C be test:int -- mailer authentication` (mailpit `veyrigate-mailpit-1` SMTP 1025/UI 8025 phải chạy; `mailer.int-spec.ts` gửi thật qua SMTP và đọc lại qua API mailpit; E2E 38 không có ca gửi mail nên đây là kiểm chứng gửi thật duy nhất); `pnpm why -r nodemailer` ⇒ chỉ 10.1.7.
- [x] **T2 — NestJS 12.1.1 → 12.2.0 (kéo fastify 5.12.5 → 5.12.7) + fast-uri**. `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify`, `@nestjs/testing` = **12.2.0** (cả 4 cùng số; 12.2.0 phát hành 2026-10-19, pin `fastify` 5.12.7; là bản platform-fastify cũ nhất có fastify ≥ 5.12.6). Không thêm `fastify` làm dep trực tiếp, không override `fastify`. `@nestjs/config` 12.0.1, `@nestjs/mongoose` 12.0.0, `@nestjs/swagger` 12.0.2 giữ nguyên (peer `^12`). Vá GHSA-389g-gv7q-r4x8.
  - fast-uri: phải về **3.1.9** (nhánh ajv `^3.0.1`) và **4.2.3** (nhánh `@fastify/ajv-compiler`/`fast-json-stringify` `^4.0.0`), không override, không thêm dep trực tiếp (dải của cha đã nhận bản vá; chỉ cần lockfile resolve lại, vd. `pnpm update -r fast-uri`, rồi kiểm không package.json nào có `fast-uri`). Vá GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp.
  - AC: `pnpm why -r fastify` ⇒ chỉ 5.12.7; `pnpm why -r fast-uri` ⇒ chỉ 3.1.9 và 4.2.3; số test be unit/int không giảm.
  - Verify (đúng chỗ fastify chạm): `pnpm -C be typecheck`; `pnpm -C be test`; `pnpm -C be test:int -- run59-http-edge static-assets discovery token introspect userinfo` (biên HTTP, body/form parser, CORS preflight hook `onRequest`, header, static), rồi int FULL ở T7.
- [x] **T3 — `@fastify/static` 10.1.5 → 10.1.10 (glob `^14` ⇒ 14.0.4, minimatch 11.0.5) + `@nestjs/cli` 12.0.8 → 12.0.12 (pin `minimatch` 11.0.5) + `@nestjs/schematics` 12.0.6 → 12.0.13** (cli 12.0.12 đòi `^12.0.13`; nâng cùng để không có 2 bản). Vá GHSA-3g3m-2fjr-6pw4 (glob, nhánh runtime) và GHSA-g3hv-75wg-m249 (minimatch, nhánh runtime + cli). Peer `@fastify/static` của platform-fastify 12.2.0 là `^10.1.2` ⇒ khớp.
  - AC: `pnpm why -r @fastify/static` ⇒ chỉ 10.1.10; `pnpm -C be build` xanh (`nest build`); trang/asset tĩnh và `/openapi/admin.json` (dev/test) như cũ.
  - Verify: `pnpm -C be build`; `pnpm -C be test:int -- static-assets` + spec chứa `ADMIN_OPENAPI_PATH`.
- [x] **T4 — dev tooling be + override/ignore ở root**.
  - `be/package.json` devDependencies: `eslint` và `@eslint/js` 9.18.0 → **9.39.5** (eslint 9.39.5 dùng `@eslint/plugin-kit ^0.4.1` ⇒ vá GHSA-xffm-g5w8-qvg7; cùng major 9, phát hành 2026-07-10). `typescript-eslint` be 8.20.0, `jest` 30.0.5, `ts-jest` 29.2.5 giữ nguyên.
  - `pnpm-workspace.yaml` `overrides` thêm 2 dòng (bản cha mới nhất vẫn chưa có bản vá: `@typescript-eslint/typescript-estree` 8.72.2 dùng `minimatch ^10.2.2`; `jest` 30.5.2 dùng `glob ^13.0.6`), kèm comment nêu GHSA, lý do, điều kiện gỡ (DEBT-552):
    - `'minimatch@>=7.0.0 <11.0.1': 11.0.5`
    - `'glob@>=9.0.0 <14.0.2': 14.0.4`
    - (chỉ bản nằm trong dải advisory bị ép; minimatch 3.x của eslint và glob < 9 không đổi.)
  - `pnpm-workspace.yaml` `auditConfig.ignoreGhsas`: thêm `GHSA-gcqx-w48m-w2h4` (deepmerge ≤ 4.3.1, low, **không có bản vá**, chỉ qua `jest-config`, dev) với comment lý do + ngày xem lại **2027-02-10** (DEBT-552).
  - AC: `pnpm why -r minimatch` không còn bản 7.x–11.0.0; `pnpm why -r glob` không còn bản 9.x–14.0.1; `pnpm why -r deepmerge` chỉ qua `jest-config` (nếu có đường runtime ⇒ không ignore, báo tech-lead); `pnpm why -r @eslint/plugin-kit` ⇒ chỉ ≥ 0.3.4.
  - Verify: `pnpm -C be lint` (0 lỗi; nếu eslint 9.39.5 báo lỗi mới ở code cũ: sửa tối thiểu, liệt kê trong test-report); `pnpm -C be test` (jest phát hiện đủ ≥ 806 test với glob 14); int FULL ở T7.
  - **Fallback** (chỉ khi một override làm vỡ tooling không sửa được trong ≤ 1 lần thử): gỡ override đó, KHÔNG thêm GHSA vào `ignoreGhsas` (sẽ che luôn nhánh runtime đã sửa ở T3), ghi đường dev còn lại vào test-report + DEBT-552, báo tech-lead.
- [x] **T5 — [ops] `github/codeql-action/init@v3` và `github/codeql-action/analyze@v3` → `@v3.39.3`** trong `.github/workflows/codeql.yml` (2 dòng). Giả thuyết cho 2 cảnh báo high của Dependabot: GHSA-vqf5-2xx6-9wfm (high, `github/codeql-action` 3.26.11–3.28.2, sửa 3.28.3) bắn trên tag trôi `v3` cho cả 2 action con (init + analyze là 2 dependency). Rủi ro thật bằng 0 ở repo này (chỉ JS/TS, không Kotlin; tag `v3` hiện trỏ dòng v3.39.x), nhưng tag cụ thể giúp Dependabot xác định bản và đóng alert. Không đổi tham số khác, không lên v4.
  - Verify: diff đúng 2 dòng; `git ls-remote --tags https://github.com/github/codeql-action refs/tags/v3.39.3` có kết quả. Alert có đóng không chỉ kiểm được sau push ⇒ người dùng.

### [FE] frontend-dev (sau khi backend-dev xong T1–T5 trên lockfile)

- [x] **T6 — seroval + eslint FE**. (frontend-dev 2026-11-10: xong; lint 0 lỗi mới; E2E 38 chưa chạy vì `:5173` bị `veyai-studio` giữ, xem test-report)
  - `pnpm-workspace.yaml` `overrides`: `seroval` và `seroval-plugins` 1.6.8 → **1.6.12** (cả hai cùng số; 1.6.12 phát hành 2026-10-21, ≥ 14 ngày, bản cuối nhánh 1.6). Vá GHSA-f86p-h4j2-7qgj (< 1.6.11) và GHSA-9wx9-5pv9-3349 (< 1.6.10). Không bỏ override (bỏ sẽ resolve 1.8.0, phát hành 2026-11-09); không nâng `@tanstack/*` (`router-core` dùng `^1.6.7`, đã nhận bản vá; chính override đang giữ bản cũ). Sửa comment override: lý do nay là bảo mật (2 GHSA) + tuổi bản; gỡ khi nâng Start (DEBT-267/228).
  - `fe-admin/package.json` và `fe-sso-test/package.json`: `eslint` + `@eslint/js` 9.18.0 → **9.39.5** (GHSA-xffm-g5w8-qvg7). `typescript-eslint` 8.71.2 giữ nguyên (minimatch của nó do override T4 xử lý).
  - AC: `pnpm why -r seroval` và `pnpm why -r seroval-plugins` ⇒ chỉ 1.6.12; `pnpm why -r @eslint/plugin-kit` ⇒ chỉ ≥ 0.3.4; fe-admin ≥ 1613 test, fe-sso-test không giảm.
  - Verify (serialization router/Start): `pnpm -C fe-admin typecheck`; `pnpm -C fe-admin lint`; `pnpm -C fe-admin test -- router server-entry csp-nonce-ssr ssr-unavailable error-boundary admin-fn users-fn resources-fn secrets-fn signing-keys-fn audit-fn health-fn` (loader/server fn qua seroval, SSR dehydrate + nonce, `ShallowErrorPlugin`), rồi `pnpm -C fe-admin test` FULL; `pnpm -C fe-admin build` + `pnpm -C fe-admin check:bundle`; `pnpm -C fe-sso-test lint` + `pnpm -C fe-sso-test test`; E2E `pnpm -C e2e e2e` (38, có SSR fe-admin thật) + X3 42.

### T7 — Gate chung (người làm cuối, ghi số vào test-report)

- [x] `pnpm install --frozen-lockfile` xanh từ lockfile đã đổi.
- [x] `pnpm audit` ⇒ "No known vulnerabilities found" (exit 0); `pnpm audit --json` ⇒ `metadata.vulnerabilities` toàn 0; `pnpm audit --audit-level high` exit 0 (bước CI). Nếu đã dùng fallback T4: chỉ còn đúng các đường dev đã ghi, không advisory nào ở đường runtime.
- [x] Diff lockfile: liệt kê mọi `tên@bản` mới kèm ngày phát hành (`pnpm view <pkg> time --json`); chỉ gói trong danh sách ngoại lệ ở đầu mục này (và gói ≥ 14 ngày) được xuất hiện; importer ngoài các package.json đã sửa không đổi.
- [x] (E2E 38/38 do tester chạy 2026-11-11) `pnpm typecheck`, `pnpm lint` (mọi workspace); be unit (≥ 806), int FULL (≥ 1968, `vg-int-*` không tăng), fe-admin (≥ 1613) + build, fe-sso-test, E2E 38, X3 42.
- [x] Smoke image (deps runtime đổi): `docker build` `be/Dockerfile` và `fe-admin/Dockerfile` với tag riêng `veyrigate-*:run83`, trong image be chạy `node -e "require('nodemailer'); require('fastify')"` in đúng version; xoá đúng 2 image tag `run83` sau khi xong. KHÔNG `compose up` hạ tầng mới, không đụng `aegate-*`.
- [x] Không sửa `be/.env`, `be/keys`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`. Cổng `:5173` đang thuộc tiến trình ngoài (`veyai-studio`): không kill; nếu E2E/X3 cần cổng ⇒ báo orchestrator.
