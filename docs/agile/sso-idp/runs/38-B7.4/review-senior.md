# Senior Review — 2026-10-20 — run 38 (B7.4 + DEBT-219/223/224)

## Kết luận: PASS

Không có 🔴. Bốn mục 🟡 không chặn, đã ghi vào `backlog.md` (DEBT-231…234). Chuyển sang **tester**.

## Tổng quan

Thay đổi gọn, đúng phạm vi và bám sát fold của tech-lead. Điểm tốt:
- Bắt được một **bug thật** khi nâng `@fastify/static` 8→10: bản 10 mặc định `dotfiles: 'allow'`. Dev chứng minh bằng RED trước rồi mới sửa bằng `dotfiles: 'ignore'`. Test đặt một dotfile thật trong `public/`, nên kết quả 404 chứng minh luật dotfile chứ không phải do file không tồn tại.
- `errorForLog` chặn kênh lộ thật sự (message/stack của E11000 có email) bằng cách đơn giản nhất: không bao giờ log message. Mutation (c) đỏ ở cả 3 call-site.
- `full-app.ts` dựng app thật theo cách hermetic: `ignoreEnvFile`, config `validateEnv(env)` cục bộ, outbox thay SMTP, pino ghi vào stream, khoá nằm trong `mkdtemp`. Không đọc `be/.env`.
- Cổng `pnpm audit` fail-closed (không có `--ignore-registry-errors`). Chỉ ignore đúng một GHSA, có lý do và ngày rà lại.
- Ảnh container ghim digest. Job `secrets`/`promtool` kế thừa `permissions: contents: read`. CodeQL chỉ cấp quyền ghi ở cấp job.

Tự kiểm lại (2026-10-20, Git Bash):
- `pnpm audit --audit-level high` exit 0 (1 low, 1 moderate, 1 high đã ignore);
- `pnpm -C be typecheck` OK, `lint` OK;
- BE unit 356/356 (29 suite);
- `test:int` các spec `static-assets`, `security-headers`, `log-capture`, `metrics.int`: 4 suite, 170/170 xanh.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Static (boundary input)**: traversal raw, `%2e%2e`, `..%2f`, `%2e%2e%2f`, `..%5c`, hai cấp, dotfile raw và `%2e`, listing `/assets/` và `/assets`. Không file nào ngoài `public/` bị trả về, không liệt kê thư mục. `public/` chỉ có `styles.css` và `logout-redirect.js`, không có `index.html`.
- **Exposure (log)**:
  - Lỗi 500 đều đi qua `OAuthExceptionFilter`: global `APP_FILTER`, `AdminAuthErrorFilter` chỉ bắt `AdminAuthError`, nên lỗi 500 ở admin cũng rơi vào filter này.
  - `errorForLog` bỏ message (gồm message nhiều dòng) và không stringify giá trị không phải `Error`. `cause` không được log.
  - pino-http chỉ thấy status 500 (exception đã bị filter nuốt), nên không serialize `err` gốc.
  - `HtmlExceptionFilter` không log gì, không có kênh lộ (nhưng cũng không có tín hiệu, đây là việc có từ trước).
  - Các call-site `.message` còn lại (`metrics.http:58`, `audit.service:129/141`, `token.controller:470`, `refresh-token.service:268`) là lỗi nội bộ hoặc updateOne theo `_id`. Bảng rà tĩnh trong log hợp lý.
- **Exposure (header)**: bảng 19 loại × 6 assert chạy trên `configureApp` thật. CSP === `buildCsp()` (`frame-ancestors 'none'`, `form-action 'self'`, không có `unsafe-*`). CSP nới ở login/consent/logout/frontchannel đã được phủ ở `ui.int-spec`/`federation.int-spec`/`csp.spec` (DEBT-084). `no-store` có ở `/token`, `/introspect`, `/revoke`, `/userinfo`, `/admin/*` (200/401/500), `/metrics`, form UI và 404/500 JSON. Discovery, JWKS, assets không bị ép `no-store`.
- **Supply chain**:
  - audit fail-closed;
  - gitleaks quét toàn lịch sử với `--redact`, nên log job không in secret;
  - allowlist `.gitleaks.toml` gồm 4 chuỗi giả cụ thể, `regexTarget = "match"`, không allowlist path hay thư mục, `useDefault = true` giữ nguyên rule gốc. Không thể dùng để tắt scan diện rộng.
- **Ops**: `A/B > 0.05 and C > 0.1`. Thứ tự ưu tiên PromQL cho ra `((A/B) > 0.05) and (C > 0.1)`, hai vế đều không còn label sau `sum`, nên `and` khớp đúng. Case traffic thấp (0.05 rps, 100% 5xx) và case chỉ `/metrics` lỗi đều sẽ cháy nếu thiếu điều kiện, nên đây là test có nghĩa. Hai case 10%/1% có sẵn (1.67 rps) vẫn đúng.

## 🟡 Nên sửa (không chặn ⇒ backlog)

🟡 **[CI] `github/codeql-action@v3` sắp hết hạn** (DEBT-231)
`.github/workflows/codeql.yml:33,39`: dùng `init@v3`/`analyze@v3`.
Vì sao: v4 (chạy Node 24) đã phát hành, GitHub thông báo deprecate v3 vào 12/2026. Workflow mới sẽ hỏng chỉ sau vài tuần.
Đề xuất: chuyển lên `@v4`, hoặc ghim SHA của v4 cùng lúc với DEBT-227.

🟡 **[CI] Job `secrets` mount `.git` có GITHUB_TOKEN vào container bên thứ ba** (DEBT-232)
`.github/workflows/ci.yml:196-203 (checkout L196, docker run L202)`: `actions/checkout@v4` mặc định `persist-credentials: true`, tức ghi token vào `.git/config` (extraheader). Sau đó toàn bộ repo được `-v "$PWD:/repo"` vào image gitleaks.
Vì sao: token chỉ có quyền `contents: read` và image đã ghim digest, nên rủi ro thấp. Nhưng job này không cần credential: nguyên tắc tối thiểu là không đưa token vào container của bên thứ ba.
Đề xuất: thêm `persist-credentials: false` cho checkout ở job `secrets` (và cả `promtool`, cho đồng bộ).

🟡 **[BE] Trang lỗi HTML (4xx/5xx) của route form không có `no-store`** (DEBT-233)
`be/src/modules/ui/html-exception.filter.ts:20`: `HtmlExceptionFilter` render `error.eta` mà không đặt `Cache-Control`. Ví dụ POST `/login` sai CSRF trả 403, 429 do rate limit, 500 ở `/authorize`.
Vì sao: fold Task 3 yêu cầu "lỗi 4xx/5xx từ những route đó" cũng phải `no-store`, và bảng header chưa có dòng HTML lỗi. Nội dung trang là chuỗi cố định, không có CSRF/token, nên không lộ gì; vì vậy chỉ để 🟡.
Đề xuất: `reply.header('Cache-Control', 'no-store')` trong filter, và thêm 1 dòng `UI HTML POST /login 403` vào `security-headers.int-spec`.

🟡 **[test] `static-assets.int-spec` ghi file vào cây nguồn `src/public/`** (DEBT-234)
`be/test/static-assets.int-spec.ts:14`: nếu tiến trình chết giữa chừng (`--forceExit`, timeout, Ctrl+C), file `.vg-dot-*` sẽ nằm lại trong `src/public`. Khi build, nest-cli copy assets sang `dist/`, và file có thể bị commit nhầm.
Vì sao: test không nên để lại rác trong cây nguồn. Luật dotfile hiện chặn việc phục vụ file này, nhưng rác vẫn còn đó.
Đề xuất: thêm `.vg-dot-*` vào `be/.gitignore`. Cách khác: dọn file sót ở `beforeAll`.

## 💭 Nit

- `be/src/common/logger/error-log.ts:17`: filter `/^\s+at /` vẫn giữ một dòng message nếu dòng đó tự bắt đầu bằng `"    at "`, ví dụ input `"x\n    at <secret>"`. Rất khó khai thác. Nếu muốn chặt: bỏ `1 + số dòng của err.message` dòng đầu của stack thay vì lọc theo regex.
- `error-log.ts:24`: `scrubUriCredentials` dừng ở `@` đầu tiên. Password có `@` không encode (`u:p@ss@host`) sẽ lộ phần `ss`. URI hợp lệ phải encode `@`, nên chỉ ghi nhận.
- `be/test/security-headers.int-spec.ts:56`: `redirect_uri` hard-code chuỗi, nên dùng `FLOW_REDIRECT` (đã export) như `log-capture`.
- `ci.yml` `secrets`: `--verbose` cùng `--redact` thì an toàn. Có thể bỏ `--verbose` để log gọn hơn; finding vẫn hiện trong report.

## ✂️ Ponytail

Lean already. Ship.

---

# Lượt 2 — 2026-10-20 (sau tester FAIL, backend-dev retry 1)

## Kết luận: PASS

## Tổng quan
Bản sửa nhỏ và đúng chỗ. `clientErrorStatus()` chỉ nhận `Error` thật (không nhận object thường) có `statusCode` là số nguyên 400–499. Với lỗi đó, `OAuthExceptionFilter` trả đúng status, mô tả chung (không echo message), `no-store`, và không ghi error log. Mọi trường hợp khác vẫn trả 500 kèm `errorForLog`. `HtmlExceptionFilter` dùng cùng hàm, có thêm `no-store` (DEBT-233). Unit spec khoá cả biên: `500/503/399/600/403.5/'403'/NaN` ⇒ 500 + log, non-Error ⇒ 500. Mutation tắt nhánh 4xx ⇒ RED (theo log dev). Không thấy hồi quy ở phần đã PASS lượt 1.

Tự chạy (Git Bash):
- `pnpm -C be typecheck` và `lint`: OK.
- `pnpm -C be test`: 366/366 (30 suite).
- `pnpm -C be test:int -- b74-tester static-assets security-headers log-capture`: 164/164 (4 suite).

## 🔴 Blocker
Không có.

## Security invariants / trust boundaries đã kiểm
- **Hạ lỗi server xuống 4xx (trọng tâm).** Nhánh 4xx tin vào *hình dạng* lỗi, không tin vào *nguồn* lỗi. Vì vậy tôi rà mọi runtime dep có thể ném lỗi trên đường request: `jose`, `mongoose`/`mongodb@7.6.0`, `ioredis`, `nodemailer`, `@node-rs/argon2`, `zod`, `class-validator`, `eta`, `@fastify/view|cookie|formbody`.
  - Không dep nào gán `statusCode` lên Error ném ra. `nodemailer` chỉ gán lên response stream của fetch nội bộ.
  - `src/` không có chỗ nào tự gán `statusCode` (grep: chỉ có serializer log).
  - Outbound provider (`provider-http.ts`) bọc mọi lỗi thành `FederationError` (không có `statusCode`).
  - Kết luận: hôm nay không có lỗi server thật nào bị hạ xuống 4xx. Rủi ro còn lại là dep tương lai ⇒ DEBT-238 (🟡).
- **Hệ quả phụ (tốt)**: lỗi chuẩn của Fastify core, ví dụ body sai JSON (`FST_ERR_CTP_*` 400/413/415) hay URL hỏng (400), trước đây cũng thành 500 qua filter global. Nay trả 4xx, nên bớt một nguồn 5xx/alert giả do người ẩn danh tạo ra.
- **Body 4xx không echo**: JSON trả `error_description` cố định, HTML trả chuỗi cố định theo nhánh status. Unit test assert không lộ `secret-detail`.
- **HtmlExceptionFilter cùng hành vi**: status lấy từ cùng hàm, `no-store` đặt trước `view`, `Retry-After` chỉ cho 429 HttpException. Filter này không log 500; đây là hành vi có sẵn, đã ghi ở DEBT-237.
- **DEBT-235 regex**: `filter(/^\s+at / && !err.message.includes(line.trim()))`.
  - Không lọc mất frame thật, trừ khi message chứa nguyên văn chuỗi frame đó. Muốn vậy message phải trùng y hệt `at Fn (path:line:col)`, thực tế không xảy ra; nếu xảy ra thì chỉ mất 1 dòng debug, không lộ gì.
  - `\r\n` bị `trim()` xử lý.
  - Khe còn lại 💭: nếu code mutate `err.message` sau khi stack đã capture, dòng "    at …" của message cũ có thể lọt. Chưa thấy chỗ nào làm vậy.
- **Không loại `/assets/*` khỏi `SsoHttp5xxRatioHigh`**: hợp lý. Sau bản sửa, `@fastify/static` chỉ còn trả 5xx khi lỗi IO/đĩa thật, đáng báo. Loại route thì mất tín hiệu đó. Ngưỡng `> 0.1 rps` (DEBT-223) đã chặn nhiễu ở traffic thấp.
- **persist-credentials**: `false` ở job `secrets` (repo mount vào image gitleaks) và `promtool`. Các job còn lại không đưa repo vào container bên thứ ba nên không bắt buộc. CodeQL action là first-party.

## 🟡 Nên sửa

🟡 **[BE] `clientErrorStatus` tin theo hình dạng lỗi, không theo nguồn** (DEBT-238)
`be/src/common/filters/oauth-exception.filter.ts:26`: mọi `Error` có `statusCode` 4xx đều được coi là lỗi do client gây ra, nên bị nuốt (không log, không 5xx).
Vì sao: nhiều HTTP client/SDK phổ biến (kiểu `http-errors`, một số SDK cloud) gắn `statusCode` của upstream lên lỗi. Nếu sau này thêm một dep như vậy, upstream trả 401/403/404 sẽ biến thành 401 `invalid_client`/403/404 cho client, không có error log và không có alert. Đó là lỗi server bị giấu, và còn lộ trạng thái upstream qua status code. Hôm nay chưa có dep nào như thế (đã rà ở trên), nên chưa chặn.
Đề xuất: thu hẹp về lỗi phát sinh trước handler, ví dụ chỉ nhận khi `code` bắt đầu bằng `FST_` hoặc lỗi không có `code` (dạng `forbiddenPathError`). Cách khác: giữ hình dạng hiện tại nhưng thêm comment invariant "outbound client phải bọc lỗi như `providerFetchJson`" kèm unit test cho một lỗi giả lập SDK.

## 💭 Nit
- `oauth-exception.filter.ts:82`: Error không phải HttpException mà mang 401 sẽ map thành `invalid_client` nhưng không có `WWW-Authenticate` (RFC 6749 §5.2). Hiện chưa có nguồn nào sinh ra lỗi này, nên chỉ ghi nhận.
- `html-exception.filter.ts:2` import helper từ `common/filters/oauth-exception.filter`. Nếu helper được dùng ở nơi thứ ba, có thể tách ra `common/filters/client-error.ts`.
- `error-log.ts:19`: khe mutate message nêu ở trên.

## ✂️ Ponytail
Lean already. Ship.
