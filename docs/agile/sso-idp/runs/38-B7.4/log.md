# Log — run 38 — B7.4 supply chain & cấu hình (+ DEBT-219/223/224)

## orchestrator — 2026-10-20
- Tiếp M7. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B7 (B7.4) + backlog DEBT-219 (promtool CI), 223 (alert 5xx thiếu ngưỡng traffic), 224 (đổi prom-client). Cổng → tech-lead.

## tech-lead — 2026-10-20
- Preflight CodeGraph (sync).
- `pnpm audit` chỉ đọc. Toàn workspace: 3 high, 4 moderate, 1 low. `--prod`: 1 high, 3 moderate.
  - Prod high: `@fastify/static@8.2.0`.
  - Dev high: `source-map-js`, `braces` (braces chưa có bản vá).
- **PASS có fold**, ghi vào `tasks.md` mục "Fold tech-lead".
- Q-38.1: đổi sang `@prometheus-io/client@0.16.1`, time-box; đỏ thì revert.
- Q-38.2: CodeQL (repo public) + gitleaks qua image trong CI; pre-commit giữ nguyên.
- Q-38.3: vừa 1 run.
- Fold chính:
  - `@fastify/static` lên 10.1.5 (sửa luôn lệch peer với platform-fastify) + regression traversal;
  - gate audit fail-closed;
  - bỏ nonce, HSTS không điều kiện, bảng `no-store` so với cacheable;
  - harness pino capture (chưa int-spec nào có) + 2 kênh lộ (E11000/stack, URI DB);
  - expr DEBT-223 cụ thể.
- Mở DEBT-225…228. Phân công: backend-dev (Task 1→1b→2→5→3→4), tester; frontend-dev không có việc.

## backend-dev — 2026-10-20
- Preflight CodeGraph (sync). Thứ tự 1→1b→2→5→3→4. Audit trước: toàn bộ 3 high/4 mod/1 low, `--prod` 1 high/3 mod ⇒ sau: toàn bộ 0 high (1 mod, 1 low, `braces` ignore có lý do, DEBT-226), `--prod` 0 lỗ hổng; `pnpm audit --audit-level high` exit 0. **T1**: `@fastify/static` 10.1.5 exact (hết lệch peer), lockfile `source-map-js` 1.2.2, `auditConfig.ignoreGhsas` (hạn rà 2027-01-18), CI step audit fail-closed. `@eslint/plugin-kit` low: 0.3.4 ngoài range eslint ⇒ bỏ qua. **Bug thật**: static 10 mặc định `dotfiles:'allow'` (RED: `/assets/.x` 200) ⇒ `dotfiles:'ignore'`. `static-assets.int-spec` 12 case (traversal raw/encoded/`%5c`, dotfile, listing). Jest không require được `content-disposition@3` (ESM) ⇒ shim test-only (DEBT-229).
- **T1b**: `@prometheus-io/client@0.16.1` exact, gỡ prom-client, chỉ đổi import; metrics.spec + ops-rules.spec (31) + metrics.int-spec (42) xanh ⇒ không revert; đóng DEBT-221/224. **T2**: `codeql.yml` (security-extended, build-mode none, ghi chỉ ở job), job `secrets` gitleaks v8.21.2 ghim digest (Docker Hub API, không pull), `fetch-depth: 0`, `--redact --exit-code 1`; `.gitleaks.toml` (useDefault + 4 regex giá trị giả, có lý do). Rà tĩnh: không PEM/AKIA/ghp được track, `.env.example` chỉ placeholder. **gitleaks CHƯA chạy cục bộ** (không có quyền người dùng) ⇒ DEBT-225. **T5**: expr 5xx loại `/metrics` + `and ... > 0.1` (dạng như rule /token để giữ assert `^sum(`), +2 case promtool; job `promtool` (prom/prometheus v3.15.0 ghim digest). **promtool CHƯA chạy cục bộ**. YAML 4 file parse OK. Đóng DEBT-219/223.
- **T3**: `test/full-app.ts` = AppModule + `configureApp` thật (config hermetic `ignoreEnvFile`, outbox mail, pino stream). `security-headers.int-spec` 19 loại × 6 assert = 114. RED thật: `/register`,`/forgot` (form CSRF) + 404 thiếu no-store ⇒ `no-store` trong `UiController.form()` + `OAuthExceptionFilter`. Mutation: `formAction` mở `https:` ⇒ 18 RED; bỏ `frameAncestors` ⇒ 18 RED; bỏ no-store `/token` ⇒ 4 RED; (bỏ hẳn `formAction` là mutation tương đương: helmet mặc định `'self'`). Khôi phục cp + sha256 OK.
- **T4** bảng rà tĩnh 44 call-site (`be/src`, trừ spec): SỬA `oauth-exception.filter:47`, `token.controller:489`, `introspect.controller:265` (stack+message ⇒ `errorForLog`: name+code+frames); `mongo.module:36`, `redis.module:47`, `health.controller:82` (`scrubUriCredentials`). OK: metrics.http:58, audit.service:129/141, token.controller:469 (lỗi nội bộ metrics/listener); refresh-token:268, client-auth:152 (Mongo updateOne theo _id / Redis, không giá trị người dùng); audit.service:133 (eventId/action); federation.* (code cố định); ui.controller/federation.service peek (chuỗi cố định); keys/* (kid, không khoá); mongo/redis connected/closing; authentication:298 (chuỗi cố định); CLI seed/seed-dev/sync-indexes (console operator, email cho phép). Comment `REDACT_PATHS` sửa (`*` = 1 cấp). `log-capture.int-spec` (register→verify→login→authorize/token PKCE→refresh→userinfo→introspect/revoke→admin→metrics→3×500 E11000 email+token→/ready + Mongo error URI user:pass): RED trước sửa (email, uri password, access token) ⇒ xanh. Mutation (a) url có query ⇒ RED (verify token); (b) bỏ redact authorization + serializer trả headers ⇒ RED (metrics/basic/access/admin token); (c) trả stack ở từng site filter/token/introspect ⇒ mỗi cái RED (email, token). sha256 OK.
- Verify thật: typecheck `-r` OK, lint OK, BE unit **356**/29, BE int **1140**/42, FE **240**, E2E **16/16**. Không còn process (cổng 4000/5173 trống). Debt mới: DEBT-229, DEBT-230. Đề nghị → **senior-reviewer**.
- **senior-reviewer (2026-10-20)**: **PASS**, 0 🔴. Tự chạy: `pnpm audit --audit-level high` exit 0, typecheck/lint OK, BE unit 356/29, int (static-assets, security-headers, log-capture, metrics.int) 170/170. Kiểm: traversal/dotfile/listing static 10, mọi 500 qua `OAuthExceptionFilter`+`errorForLog`, harness hermetic (`ignoreEnvFile`), allowlist gitleaks 4 chuỗi giả cụ thể (không path), audit fail-closed, ảnh ghim digest, quyền CI tối thiểu, expr 5xx đúng thứ tự ưu tiên. 🟡 → DEBT-231 (codeql-action v3→v4), DEBT-232 (`persist-credentials: false` job secrets), DEBT-233 (no-store trang lỗi HTML), DEBT-234 (file dot sót ở `src/public`). Đề nghị → **tester**.

## tester — 2026-10-20
- Preflight CodeGraph (sync). **FAIL** ⇒ trả **backend-dev**. Chi tiết: `test-report.md`.
- Đã chạy:
  - `pnpm audit --audit-level high` exit 0; `--prod` 0 lỗ hổng.
  - YAML 4 file OK; cấu trúc workflow đúng fold.
  - typecheck `-r` + lint OK.
  - BE unit 356/356.
  - BE int FULL **1167/1176**: 1140 của dev xanh hết, 9 FAIL ở spec mới `be/test/b74-tester.int-spec.ts`.
  - FE 240/240, E2E 16/16.
- **[BE] FAIL**: `@fastify/static` 10 gửi `forbiddenPathError()` (Error có `statusCode` 403) cho đường dẫn non-canonical/NUL/`\`/tuyệt đối, ví dụ `/assets//styles.css` hoặc `/assets/....//x`. `OAuthExceptionFilter` coi đó là lỗi không lường trước ⇒ **500** `server_error` + error log level 50.
  - Không lộ nội dung.
  - Nhưng người ẩn danh bơm được 5xx vào `route="/assets/*"`, đủ để bắn `SsoHttp5xxRatioHigh` (critical) giả.
  - Đây là hồi quy do nâng 8→10.
- Kiểm chéo xanh:
  - 18 biến thể traversal không lộ (unicode/overlong/double-encode/`//`/`/assets/../`);
  - header HTML lỗi đủ header gốc; xác nhận DEBT-233 (403/500 HTML không `no-store`, `it.failing`);
  - log federation callback lỗi (state, binding, provider code, `error_description`, Google secret) + admin 500 (Error nhiều dòng/chuỗi/object) cho 0 bí mật;
  - mutation `errorForLog`⇒`err.stack` RED; khôi phục, sha256 OK.
- 🟡 mới:
  - DEBT-235: `errorForLog` để lọt dòng message có dạng `"    at …"`. Xác nhận nit senior bằng `it.failing`.
  - DEBT-236: static theo symlink trong `public/` ra ngoài. Cần quyền ghi, nên ngoài threat model.
- DEBT-234 không tái hiện: `src/public` sạch sau mọi lần chạy. Không còn process (:5173/:4000 trống).

## backend-dev — retry 1 — 2026-10-20
- Preflight CodeGraph (sync). Sửa 🔴: `clientErrorStatus()` (Error không phải HttpException, `statusCode` số nguyên 400–499) ⇒ `OAuthExceptionFilter` trả đúng status + `errorCodeForStatus`, mô tả chung (không echo message), `no-store`, KHÔNG log; 5xx/không statusCode/non-Error giữ 500 + `errorForLog`. `HtmlExceptionFilter` dùng cùng hàm + `Cache-Control: no-store` (DEBT-233). Abuse: ẩn danh gửi `/assets//x`, NUL, `\`, đường tuyệt đối ⇒ 403, không còn 5xx metric/error log; lỗi dependency không mang statusCode 4xx vẫn 500 (fail-closed quan sát được).
- DEBT-235: `errorForLog` bỏ dòng frame nằm trong `err.message`. DEBT-232: `persist-credentials: false` job `secrets` + `promtool`. Alert `SsoHttp5xxRatioHigh` KHÔNG loại `/assets/*`: sau sửa không còn 5xx do client; 5xx thật trên assets (đĩa/IO) vẫn nên báo.
- RED trước: unit filter (403 nhận 500) + errorForLog (lọt `framesecret`); `b74-tester` 2 `it.failing` ⇒ `it`, kỳ vọng 9 case không đổi. Mutation tắt nhánh 4xx ⇒ unit 1 RED + `b74-tester` 9 RED; khôi phục cp, sha256 `7375cdc9b0b2dc6d…` khớp.
- Verify thật: typecheck `-r` OK, lint OK, BE unit **366**/30, `b74-tester` 36/36, BE int FULL **1176/1176** (43 suite, 317.8 s), E2E **16/16**. :5173/:4000 trống trước/sau. Đóng DEBT-232/233/235; mở DEBT-237 (💭). Đề nghị → **senior-reviewer** lượt 2.

## senior-reviewer — lượt 2 — 2026-10-20
- Preflight CodeGraph (sync). **PASS**, 0 🔴 ⇒ chuyển **tester** (chạy lại `b74-tester` + full int).
- Tự chạy:
  - typecheck/lint OK;
  - BE unit 366/30;
  - int `b74-tester`/`static-assets`/`security-headers`/`log-capture`: 164/164.
- Kiểm:
  - `clientErrorStatus` chỉ nhận Error có `statusCode` nguyên 400–499. Rà runtime deps (jose, mongoose/mongodb, ioredis, nodemailer, argon2, zod, class-validator, eta, @fastify/*) và `src/`: không chỗ nào ném Error mang `statusCode`. Provider fetch bọc thành `FederationError` ⇒ hôm nay không lỗi server nào bị hạ xuống 4xx.
  - Body 4xx cố định (JSON lẫn HTML), `no-store` ở cả 2 filter.
  - Filter DEBT-235 không lọc mất frame thật.
  - Giữ `/assets/*` trong alert là hợp lý (5xx còn lại là IO thật).
  - `persist-credentials: false` ở `secrets`/`promtool`.
- 🟡 mới: DEBT-238 (`clientErrorStatus` tin theo hình dạng, không theo nguồn ⇒ dep tương lai có thể giấu lỗi upstream). 💭: 401 không có `WWW-Authenticate`; vị trí helper; khe mutate message trong `errorForLog`.

## tester — lượt 2 — 2026-10-20
- Preflight CodeGraph (sync). **PASS** ⇒ chuyển orchestrator đóng run. Chi tiết: `test-report.md` § Lượt 2.
- Đã chạy:
  - typecheck `-r` + lint OK;
  - BE unit **366/366**;
  - `b74-tester` **53/53**: 9 case FAIL lượt 1 nay xanh, 0 `it.failing`, thêm 17 case mới;
  - BE int FULL **1193/1193** (43 suite, 318 s);
  - FE **240/240**, E2E **16/16**;
  - `pnpm audit --audit-level high` exit 0, `--prod` 0 lỗ hổng;
  - YAML 4/4 OK (`persist-credentials: false` ở `secrets`/`promtool`).
- Biến thể mới, mỗi ca so `/metrics` và đếm error log trước/sau:
  - Fastify 4xx (JSON hỏng/rỗng 400 trên admin ẩn danh, `/token`, `/login`; body > 1 MiB 413; content-type sai 415 ×2; URL hỏng 400 ×2; static 403): đúng 4xx, 0 error log, `status_class="5xx"` không tăng.
  - Lỗi server (MongoServerError, MongoNetworkError, Redis ECONNREFUSED, Error `statusCode` 503 / `status` 404 / `statusCode` chuỗi; HTML `/authorize` ECONNREFUSED): 500, có log, `5xx` +1.
- Mutation: `clientErrorStatus` ⇒ undefined: 10 RED; cận `<= 599`: 1 RED. Khôi phục cp, sha256 `7375cdc9…` khớp.
- 🟡 mới: DEBT-239. `FST_ERR_BAD_URL` (Fastify `onBadUrl`) đi tắt qua hook/filter, có từ trước run 38:
  - không header cơ sở, không `no-store`;
  - echo path thô;
  - không vào metric.
- Không còn process do tester khởi động (:5173/:4000 trống, không phải dừng gì). Không commit.

## orchestrator — 2026-10-20 (đóng run)
- Mọi cổng PASS. Commit `11786b9`.
