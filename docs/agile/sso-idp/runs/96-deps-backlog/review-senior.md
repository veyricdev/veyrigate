# Senior Review — 2026-11-18 (run 96 T1, Lot A + Lot C, chưa commit)

## Kết luận: PASS

Không có 🔴. Có 2 🟡 (DEBT-698, DEBT-699, ghi trong `log.md`), cả hai là tài liệu/comment, không phải code chạy.

## Tổng quan

Diff đúng D96.5–D96.12. 36 gói của #17 khớp lệnh `tasks.md`; TanStack Start/Router giữ 1.168.60 / 1.170.41; ESLint 10.14.0 + @eslint/js 10.0.1 ở 3 gói. Lint chỉ sửa đúng 8 chỗ; không tắt rule trong config. Các file chỉ đổi format (`backup-scripts.spec.ts`, `admin-recover.ts`, `mfa.service.ts`, `federation.int-spec.ts`) chỉ đổi xuống dòng: prettier 3.9 gộp union type vào một dòng. Comment trong `pnpm-workspace.yaml` và `dependabot.yml` đều ghi lý do và DEBT để gỡ. Điểm tốt: bật `minimumReleaseAge` khiến quy tắc 14 ngày (D72) được kiểm máy móc cho cả dependency bắc cầu, ở CI và trong cả 2 Dockerfile. Hai Dockerfile đều COPY `pnpm-workspace.yaml`, và `packageManager` ghim `pnpm@12.6.0` ⇒ CI, image và máy local dùng cùng chính sách.

### Chạy lại (senior, Git Bash, HEAD + working tree)
- `pnpm install --frozen-lockfile`: "Lockfile passes supply-chain policies", exit 0. Kết quả lấy từ cache 8 phút trước; bằng chứng thử bỏ từng mục exclude là của backend-dev.
- `pnpm audit --audit-level high`: exit 0, "1 ignored: 1 high" (picomatch, D96.3/DEBT-690).
- be: typecheck + lint exit 0; unit **1296/1296** (66 suite).
- fe-admin: typecheck + lint exit 0; unit **1658/1658** (69 file).

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm

- **Override `fastify>light-my-request` 6.6.0 (D96.7)**
  - Runtime: `fastify@5.12.7/fastify.js:476-479` chỉ `require('light-my-request')` lazy bên trong `inject()`. Không đường production nào gọi `inject`; grep `be/src` trừ spec không có `.inject(`.
  - `@nestjs/platform-fastify` 12.3.2 khai báo dependency trực tiếp `light-my-request@6.8.0`, nhưng `adapters/fastify-adapter.js` (ESM) không import nó. Đó chính là "platform-fastify trực tiếp vẫn 6.8.0" trong log, và không chạy.
  - Phạm vi: trong lockfile chỉ snapshot `fastify@5.12.7` dùng 6.6.0. Đúng một đường.
  - Bảo mật: GitHub Advisory DB (API công khai) không có advisory nào cho `light-my-request`. `cookie@1.1.1` mà 6.6.0 kéo theo nằm ngoài GHSA-pxg6-pf52-xh8x (<0.7.0). Giữa 6.6.0 và 6.8.0 không có bản 6.7.x. Bản 6.8.1 (2026-11-14) chưa đủ 14 ngày, nên cũng không phải lựa chọn.
  - Kết luận: không hạ cấp bản vá bảo mật nào, không ảnh hưởng runtime.
- **`preserve-caught-error`, 3 chỗ disable** (`mongo.service.ts:48`, `seed.ts:265`, `vault-transit-key-provider.ts:424`): cả ba đúng là không được gắn cause.
  - Nếu Nest bootstrap hỏng, `util.inspect` của Node in cả `[cause]`. Message driver Mongo có thể chứa URI kèm credential. E11000 lặp lại giá trị key (PII). ErrnoException chứa đường dẫn token file.
  - Comment `-- <lý do>` rõ và đúng với code: detail đã scrub được log riêng; chỉ giữ `code`.
- **`preserve-caught-error`, 3 chỗ gắn cause**
  - `bootstrap.ts:138`: cause là lỗi của `validateRedirectUriList`, mà message của nó đã nằm sẵn trong message ngoài ⇒ không lộ gì mới.
  - `bootstrap.ts:465`: cause là lỗi `process.stdout.write`, kiểu EPIPE/EBADF. Lỗi stream của Node không mang dữ liệu đã ghi ⇒ secret không đi vào cause. Ngoài ra CLI chỉ in `cliErrorText(err)` = `err.message` đã scrub (`sync-indexes.ts:92`), không in stack hay cause ⇒ cause không bao giờ tới stderr.
  - `fe-sso-test/src/oidc/http.ts:22`: DOMException TimeoutError, không chứa token. Đây là RP demo.
- **Khởi tạo thừa**: `store.ts:160` có mọi nhánh (try/catch) đều gán `stored`. `probe.ts:160` gán `status = 0` trong catch cho `ResourceNetworkError`, còn lỗi khác thì throw ⇒ fail-closed giữ nguyên. TS definite-assignment chứng minh không có đường đọc trước khi gán.
- **`styles.css` tái sinh (tailwind 4.1.14 → 4.3.4)**: không có `url()`, `@import` hay tài nguyên ngoài. File vẫn tải qua `<link href="/assets/styles.css">` dưới CSP `style-src 'self'` (`csp.ts:32`), không có SRI hash phải cập nhật. Khác biệt thật gồm 3 chỗ:
  - Stack `--font-sans` mặc định đổi từ `ui-sans-serif,system-ui` sang `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto…`: font trang login/consent BE đổi nhẹ.
  - `:-moz-focusring:where(:not(iframe))`.
  - `margin-trim:block` trong feature query. Còn lại chỉ là khoảng trắng trong `calc()`/`color-mix()`.

  Diff hợp lý với 4.3.4.
- **Lockfile**: 14 tên gói mới, tất cả là dev-only, nguồn gốc đã kiểm bằng `pnpm why -r`:
  - `handlebars`, `uglify-js`, `neo-async`, `wordwrap` ← ts-jest 29.4.15.
  - `cacheable`, `@cacheable/*`, `@keyv/*`, `hookified`, `qified`, `hashery` ← flat-cache 6 / file-entry-cache 11 của eslint 10.
  - `@dual-bundle/import-meta-resolve` ← synckit của eslint-plugin-prettier.
  - `@types/esrecurse` ← eslint-scope 9.

  32 gói bị gỡ (fast-glob, micromatch, tar, ejs…). Không gói nào lạ ngoài phạm vi. `allowBuilds` không đổi ⇒ không có postinstall mới.
- **Supply-chain**: 9 mục `minimumReleaseAgeExclude` đúng danh sách D96.5, ghi phiên bản chính xác. Không mục nào đến từ Lot A/C.
- **`dependabot.yml`**: YAML hợp lệ; `ignore` có `dependency-name` + `versions`, đặt đúng trong khối `npm`. Về security update, xem 🟡 DEBT-699.

## 🟡 Nên sửa

- [ ] **DEBT-698: comment `pnpm-workspace.yaml` (dòng ~8-9) mâu thuẫn với quy trình ngoại lệ bảo mật.**
  - Comment hiện ghi: "A new release < 14 days is never excluded here: pick an older version instead."
  - Vì sao sai: câu đó đúng cho Lot A/C (D96.5), nhưng viết như luật chung. Với CVE khẩn, bản vá **chỉ có** ở bản mới, nên "chọn bản cũ hơn" không vá được. Thực tế plan §12 dòng 394 (D83.x) và run 51 (zod) / run 83 đều dùng đúng đường ngoại lệ. Người trực ca đọc comment này sẽ tưởng phải chờ 14 ngày, hoặc sẽ tắt hẳn `minimumReleaseAge`.
  - Đề xuất câu mới: "Only security fixes may be excluded: exact `name@version`, GHSA + run/D-number + expiry date in a comment; drop when 14 days old". Thêm một bước tương ứng vào `runbook-deploy.md` §7 (mục Dependabot/npm): bump tay ⇒ thêm exclude ⇒ `pnpm install` ⇒ audit ⇒ ghi D. Đây là chỗ duy nhất mô tả "ngoại lệ tay" mà hiện chưa nói tới `minimumReleaseAgeExclude`.
- [ ] **DEBT-699: `ignore` trong `dependabot.yml` có thể chặn cả security PR cho các khoảng đã ignore.**
  - GitHub không nói rõ trong options reference. Riêng `cooldown` được ghi rõ là chỉ áp cho version update, còn ví dụ "customizing security PRs" lại dùng `ignore` để loại một gói khỏi security update.
  - Vì sao: nếu có advisory cho Start <1.169 / router ≤1.170.41 mà bản vá chỉ có ở ≥1.169 (hoặc TS ≥7), Dependabot sẽ im.
  - Giảm nhẹ: runbook-deploy §7 đã ghi npm không có security update (pnpm lock 2 document), và cổng thật là CI `pnpm audit --audit-level high` fail-closed, không bị `ignore` ảnh hưởng ⇒ không phải blocker.
  - Đề xuất: ghi một dòng trong runbook-deploy §7: các mục `ignore` cũng tắt security PR cho khoảng đó; cổng là audit; gỡ cùng DEBT-694/695.

## 💭 Nit

- `bootstrap.ts:465`: `{ cause: err }` vô hại nhưng không có giá trị chẩn đoán, vì `cliErrorText` chỉ in `message`. Giữ để thỏa rule là hợp lý; không cần đổi.
- `styles.css`: Tailwind 4.3 tự đổi stack font mặc định. Nếu muốn giao diện BE ổn định qua các lần bump, cân nhắc khai báo `--font-sans` tường minh trong `be/src/styles.css`. Không ghi DEBT.
- Ngoài phạm vi T1, ghi để orchestrator biết: triage T2 đóng DEBT-500 với lý do "Dependabot npm có alert", nhưng `runbook-deploy.md` §7 vẫn ghi "không có alert/security update npm (DEBT-500)". Phần doc này đã được triage chuyển sang DEBT-585; cần bảo đảm DEBT-585 còn mở.

## ✂️ Ponytail
Lean already. Ship.

Diff là bump version, comment cấu hình và 8 sửa lint tối thiểu: không thêm abstraction, helper hay dependency trực tiếp mới. Override `light-my-request` là cách ít code nhất để giữ Jest chạy; một shim ESM hoặc đổi test runner đều tốn hơn.

---

# Retry 1 — 2026-11-18 (access log mất, chưa commit)

## Kết luận: PASS

0 🔴 / 0 🟡 / 4 💭. Phạm vi: `be/src/common/logger/logger.module.ts` (`buildLoggerParams`), `logger.routes.spec.ts` (mới), `be/test/full-app.ts`, `be/scripts/pentest/{ctx,pentest,checks}.mjs` (`HYG-ACCESSLOG`, DEBT-700).

## Tổng quan

Bản sửa nhỏ, đúng chỗ. Không đổi dependency. Phần đáng giá nhất là cả int lẫn unit giờ mount **đúng tham số production**: lỗi lần này lọt qua chính vì `full-app.ts` tự dựng `forRoot` riêng. Check harness mới đo đúng invariant: mỗi response phải có một dòng access log, đối chiếu bằng `req.id`. Check cũ chỉ đo "log có tồn tại".

### Chạy lại (senior)
- be `typecheck` exit 0; `lint` (`eslint src test`) exit 0.
- `jest src/common/logger`: 3 suite, **33/33**.
- int `test/log-capture` (khoá `vg:int-lock` qua globalSetup): **2/2**.
- **Mutation tay**: xoá dòng `forRoutes` ⇒ `logger.routes.spec` 5 đỏ / 1 xanh; int `log-capture` đỏ (`access.length` Expected >= 10, Received 0). Đã hoàn lại; sha256 file trước = sau (`d7ba2e68…4b99`).
- **Probe tạm** (scratchpad, đã xoá): Nest + FastifyAdapter + params production + helmet + cookie + hook `onRequest` trả 204 cho OPTIONS. Mỗi request có đúng **1** dòng và không lộ `SECRET_` cho các trường hợp: `GET /users/:id`, `HEAD /users/42`, `OPTIONS /login` (trả trong onRequest), `GET /users/` 404, `GET //x` 404, `GET /%2e%2e/x` 404, `DELETE /nope` 404. Request gửi kèm `authorization: Bearer SECRET_AUTH` và `cookie: idp_session=SECRET_C`. Với 2 `set-cookie`, response giữ đúng 2 (hook onSend không nhân đôi), log không có `set-cookie`.

## (a) Nguyên nhân gốc — xác nhận từ node_modules
- `nestjs-pino@5.3.1` `dist/cjs/LoggerModule.js`: `DEFAULT_ROUTES = [{ path: '{/*splat}', method: ALL }]`, cố ý không có `/` đầu.
- `@fastify/middie@9.3.6` `index.js:133-141` `joinPrefix`: khi `path[0] !== '/'` và prefix không kết thúc bằng `/` thì `path = '/' + path` ⇒ `/{/*splat}`, chỉ khớp `/`. Lockfile: middie 9.3.5 → 9.3.6, nestjs-pino 5.2.1 → 5.3.1.
- `@nestjs/platform-fastify` 12.3.2 `createMiddlewareFactory`: `this.instance.use(normalizedPath, …)` (router case-sensitive) ⇒ middie lọc theo path đã bị join sai, trước cả bước `re.exec` của Nest.
- Kết luận: chẩn đoán của dev đúng. Với `/{*splat}`, `joinPrefix('', …)` giữ nguyên chuỗi, và path-to-regexp v8 khớp cả `/`.

## Security invariants / trust boundaries đã kiểm
- **Exposure (log)**: hook `onSend` mới của nestjs-pino (`exposeFastifyResponseHeaders`) chép **mọi** header sang `reply.raw`, kể cả `set-cookie`, vì vậy chỉ còn serializer chặn chúng.
  - `serializeResponse` là allow-list (`statusCode` + `location` đã cắt query/fragment); `serializeRequest` chỉ lấy `id/method/url` không kèm query. Thêm vào đó là redact `res.headers["set-cookie"]` / `req.headers.authorization|cookie`.
  - Spec mới assert không có `SECRET_|set-cookie|idp_session` cho `/login` và không có `SECRET_AT` cho body `/token`. Probe đã kiểm thêm `authorization`/`cookie` ở phía request.
- **Hành vi response không đổi**: Node `writeHead` ưu tiên header truyền vào ⇒ `set-cookie` không bị nhân đôi (probe: 2 → 2). Header bị một hook sau xoá vẫn có thể còn trên raw, nhưng `be/src` không có `removeHeader` nào ⇒ không áp dụng.
- **Chi tiết `forRoutes`**:
  - Không log đôi: helmet/cookie/static/view đều bọc `fastify-plugin` ⇒ `middieContexts` rỗng, mỗi request đúng 1 dòng.
  - `method: ALL` phủ OPTIONS/HEAD.
  - App không có `setGlobalPrefix` ⇒ phần `exclude` prefix mà `defaultRoutes()` thêm vào không cần.
- **(d) Wiring dùng chung**:
  - Chỉ còn `full-app.ts` và `logger.routes.spec.ts` gọi `PinoLoggerModule.forRoot`, cả hai spread `buildLoggerParams`, chỉ thay đích ghi.
  - E2E (`e2e-main.ts`) và production đi qua `AppModule` → `forRootAsync(buildLoggerParams)`.
  - Không còn chỗ nào dựng logger riêng.
- **(e) HYG-ACCESSLOG**:
  - Đỏ khi mất log: `sent > 0 && matched === sent`, nên không thể pass rỗng.
  - Không flaky: HYG chạy trong `finally` **sau** `be.stop()` ⇒ stdout đã đóng, log đầy đủ.
  - `TRUST_PROXY` rỗng ⇒ `req.id` do server sinh, duy nhất, và được echo qua `x-request-id` (`framework-errors.ts:75`).
  - Evidence chỉ có số đếm (`accessLines`, `responses`, `logged`, `routes[]`); `served` (method/pathname/status/reqId) không ghi ra file, pathname không kèm query ⇒ không lộ secret.

## 🔴 Blocker
(không có)

## 🟡 Nên sửa
(không có)

## 💭 Nit
- `logger.routes.spec.ts`: probe của senior đã kiểm 3 điểm sau, nhưng spec chưa có. Cân nhắc đưa vào spec để khoá hồi quy:
  - một route có tham số (`/users/:id`);
  - `OPTIONS` + `HEAD`;
  - request kèm `authorization`/`cookie`.
- `checks.mjs` `accessLog`: `byId.set` ghi đè ⇒ log đôi (2 dòng cùng `req.id`) không bị phát hiện. Có thể đếm và đòi đúng 1 dòng. Đây chỉ là nhiễu, không phải bảo mật.
- `test/log-capture.int-spec.ts:29`: comment còn ghi "the production `buildPinoHttpOptions`" ⇒ nên đổi thành `buildLoggerParams`.
- `logger.module.ts`: nếu sau này thêm `setGlobalPrefix`, `/{*splat}` sẽ thành `/<prefix>/{*splat}` và bỏ sót route được exclude cũng như gốc prefix. Comment đã nói rõ điều kiện "No global prefix is set"; khi thêm prefix thì cần thêm `exclude` routes.

## ✂️ Ponytail
Lean already. Ship.

`buildLoggerParams` là 4 dòng và thay 2 nơi dựng tham số trùng nhau. `accessLog` khoảng 20 dòng, không có abstraction thừa.
