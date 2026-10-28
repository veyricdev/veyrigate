# Tasks — run 60 — phòng thủ cuối cho redirect + dọn sau run 59 (M7, lane FE/BE)

> Nguồn: `backlog.md` (đọc nguyên văn + run gốc): DEBT-446 🟡 (fe-admin: response có `Location` tuyệt đối ra ngoài origin `APP_URL`/`OIDC_ISSUER` ⇒ chặn — phòng thủ cuối vì guard `//` run 59 phụ thuộc nội bộ h3 RC/srvx/router-core), DEBT-447 💭 (bỏ `if (includes("%"))` thừa ở `fe-admin/src/server.ts`), DEBT-444 (ponytail `be/src/common/http/framework-errors.ts`), DEBT-445 💭 (JWKS Google `{"keys":[]}` ⇒ 400 thay vì 502). Liên quan: runs/59-http-edge/{review-senior.md,test-report.md,summary.md}, runbook-deploy §7/§9, `security-matrix.md`.
>
> Tech-lead: xác minh, thiết kế (DEBT-446: những redirect hợp lệ nào hiện có — login tới IdP `/authorize`, logout tới `end_session`, step-up, `returnTo` nội bộ — phải giữ nguyên; tiêu chí origin chính xác; hành vi khi chặn), test âm + mutation, cổng security; chọn ≤4 task. Hạ tầng: KHÔNG compose up/FLUSH/drop; không đụng `be/keys`, `be/.env`; không kill process (chỉ TaskStop).

### [x] Task 1 [FE]: DEBT-446 + DEBT-447.
### [x] Task 2 [BE]: DEBT-444 + DEBT-445.

## Fold tech-lead (2026-10-28) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Bằng chứng xác minh: `review-techlead.md`. Giữ 2 task; T1 → **frontend-dev**, T2 → **backend-dev** (độc lập, song song được). Không đổi authn/authz, cookie, session, CSRF, env, Dockerfile.

### Cổng security (chung)

- **Tài sản/actor/boundary**: (T1) điều hướng của trình duyệt admin; kẻ tấn công Internet điều khiển path/`Host`. Nguồn origin hợp lệ DUY NHẤT là cấu hình server: `APP_URL` (origin trần, đã validate ở `env.ts`) và `OIDC_ISSUER` (`discovery.ts` đã ép mọi endpoint cùng origin issuer). (T2) phản hồi JWKS của Google (sự cố/kẻ tấn công trên đường mạng điều khiển status/body); token do client gửi.
- **Invariant**: (I1) mọi response đi qua `withSecurityHeaders` có `Location` thì HOẶC là tham chiếu tương đối không authority (các dạng `//h`, `/\h`, `\\h`, `/<tab>/h` bị coi là CÓ authority), HOẶC là URL tuyệt đối có `origin` ∈ {origin `APP_URL`, origin `OIDC_ISSUER`} và không userinfo. Ngược lại ⇒ thay bằng 404. (I2) T2: lỗi phía provider = 502 `provider_unavailable`; lỗi phía token = 400 `invalid_identity`; cả hai không session/user/link (giữ nguyên run 59).
- **Abuse case**: hồi quy guard `//` (nâng h3/srvx/router-core) ⇒ 308 `Location: http://<Host>//x`; `Location` tuyệt đối tới host na ná (`http://app.evil`, `http://app@evil`, khác scheme/port); `javascript:`/`data:` (origin `"null"`); JWKS rỗng bị phân loại là token xấu; token kid lạ KHÔNG được nâng thành 502.
- **Failure semantics**: T1 không I/O; `new URL` ném ⇒ coi là vi phạm (fail-closed ⇒ 404). Thiếu `appUrl`/`issuer` (unit test gọi không `site`) ⇒ tập origin rỗng ⇒ mọi `Location` tuyệt đối bị chặn, tương đối vẫn qua. T2 giữ timeout `PROVIDER_TIMEOUT_MS`, không retry, fail-closed.
- **Exposure**: response bị chặn: body cố định `Not Found`, KHÔNG mang header gốc (không `Location`, không `Set-Cookie`), vẫn đủ header A7 + `no-store`. Log đúng 1 dòng mức error, nội dung cố định + status số; KHÔNG chứa `Location`, `Host`, path, query.

### [x] T1 [FE] DEBT-446 + DEBT-447 — kiểm `Location` ở lớp cuối; bỏ `if` thừa

**Redirect hợp lệ hiện có (phải giữ nguyên; đã đối chiếu code HEAD 876b786)**:

| Nguồn | Status | `Location` |
|---|---|---|
| `bff.ts` `login` (kể cả `stepup=1`) | 302 | `authorization_endpoint` từ discovery: tuyệt đối, origin = origin `OIDC_ISSUER` |
| `bff.ts` `handleCallback` | 302 | `sanitizeReturnTo(...)`: luôn path tương đối `/…` (không `//`, không `\`, không `/auth/…`) |
| `bff.ts` `logout` không cookie | 303 | `/` |
| `bff.ts` `logout` có cookie | 303 | `end_session_endpoint`: origin issuer (`post_logout_redirect_uri` chỉ nằm trong query) |
| `__root.tsx` `beforeLoad` chưa đăng nhập | 307 | `/auth/login?returnTo=…` tương đối (`resolveRedirect` hạ URL nội bộ về path) |
| Router chuẩn hoá path / serverFn redirect | 307 / JSON | tương đối (probe run 59: 12 150 lần 307, chỉ path tương đối) |
| Router `handledProtocolRelativeURL` | 308 | **tuyệt đối theo `Host`**: thứ phải chặn |

`query-client.ts`/`step-up.ts` dùng `location.assign` phía client (không phải header, ngoài phạm vi). `serve.mjs` `assets` (srvx `serveStatic`) đứng NGOÀI `withSecurityHeaders`; srvx 0.11.22 `static.mjs` không phát redirect (DEBT-449).

**Thiết kế** (`fe-admin/src/server/security-headers.ts`, trong `withSecurityHeaders`, ngay sau khi có `res` (cả nhánh catch) và TRƯỚC `new Headers(res.headers)`):
1. `const loc = res.headers.get("location")`; null ⇒ như cũ.
2. Hợp lệ ⇔ hàm nội bộ `allowedLocation(loc, origins)`, `origins` = `Set` các `new URL(x).origin` của `appUrl`/`issuer` có mặt:
   - `URL.canParse(loc)` (có scheme) ⇒ `u = new URL(loc)`; hợp lệ khi `origins.has(u.origin)` và `u.username === "" && u.password === ""`. Origin `"null"` (`javascript:`, `data:`, scheme lạ) không bao giờ có trong set.
   - ngược lại (tương đối) ⇒ `u = new URL(loc, "http://base.invalid")`; hợp lệ khi `u.origin === "http://base.invalid"` (bắt `//h`, `/\h`, `\\h`, `/\t/h`) và không userinfo. `new URL` ném ⇒ không hợp lệ.
   - So khớp bằng `origin` chuẩn hoá (scheme + host + port mặc định). CẤM `startsWith`, so host đơn thuần, regex.
3. Không hợp lệ ⇒ `res.body?.cancel().catch(() => {})` (không await chặn); `logServerError("location guard", new Error(\`blocked an off-origin Location (status ${res.status})\`))`; `res = new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })`, rồi gắn header A7 như mọi response.
4. Áp cho mọi status (không chỉ 3xx). Không option/flag tắt. Guard `//` trong `server.ts` giữ làm lớp chính. Cập nhật doc comment `withSecurityHeaders` (1–2 dòng).
5. DEBT-447: `routerPathname` bỏ `if (url.pathname.includes("%"))`, giữ `try/catch` (không `%` ⇒ `decodeURI` identity, setter idempotent); sửa comment tương ứng.
6. Docs: runbook-deploy §7 gạch "Không bật trust proxy" thêm câu: lớp cuối DEBT-446, `Location` tuyệt đối ngoài origin `APP_URL`/`OIDC_ISSUER` ⇒ 404 + log `location guard failed … blocked an off-origin Location (status N)`; gặp log này nghĩa là guard `//` đã hồi quy (thường sau nâng h3/srvx/router-core). `security-matrix.md`: thêm dòng DEBT-446 trỏ tên test.

**Test (bắt buộc, tên chứa `DEBT-446`)**:
- `fe-admin/test/security-headers.test.ts`, `site = { appUrl: "http://localhost:3000", issuer: "http://localhost:4000/realm" }`:
  - **Đối chứng (giữ nguyên status + `Location` + `Set-Cookie`, không log)**: `/x`; `/`; `/auth/login?returnTo=%2F%2Fevil.example`; `http://localhost:3000/next`; `HTTP://LOCALHOST:3000/n`; `http://localhost:4000/oauth2/authorize?client_id=a` (issuer có path, so origin); 303 + 2 `Set-Cookie` giữ thứ tự (case (c) có `site`).
  - **Âm (⇒ 404, body `Not Found`, không `location`, không `set-cookie`, có CSP/XFO/nosniff/`no-store`)**: `http://evil.example/x`; `//evil.example/x`; `/\evil.example`; `\\evil.example`; `/<TAB>/evil.example`; `https://localhost:3000/` (khác scheme); `http://localhost:3001/` (khác port); `http://localhost:3000.evil.example/`; `http://localhost:3000@evil.example/`; `http://u:p@localhost:3000/`; `javascript:alert(1)`; `data:text/html,x`; `http://[::1` (không parse được); `Response.redirect("http://evil.example//x", 308)` (headers bất biến); 302 tới `http://evil.example/` kèm `Set-Cookie` (cookie bị bỏ).
  - Không `site`: case (d) hiện có đổi sang truyền `site` cho đường dương; thêm case không `site`: `Response.redirect("http://localhost:4000/next", 302)` ⇒ 404; `/x` ⇒ giữ.
  - Log: spy `console.error` đúng 1 lần cho mỗi response bị chặn; chuỗi KHÔNG chứa `evil`, `javascript`, `u:p`, path/query của `Location`; có status số.
  - Body gốc bị huỷ: `ReadableStream` với `cancel` spy ⇒ được gọi.
- `fe-admin/test/protocol-relative-risk.test.ts`: 1 case dùng `getNormalizedURL` THẬT của router-core với `http://evil.example//..\x/y` (mẫu senior run 59) ⇒ `Response.redirect(url, 308)` bọc `withSecurityHeaders(…, site)` ⇒ 404, không `location` (lớp cuối độc lập cách parse path).
- `fe-admin/test/server-entry.test.ts`: (a) mock `handler.fetch` trả `Response.redirect("http://evil.example//x", 308)` cho `/clients` ⇒ 404 không `location` (qua entry thật, `site` từ env); (b) đối chứng mock trả 302 tới `<origin OIDC_ISSUER>/authorize` ⇒ giữ 302 + `location`. Test `//`/`%5C` hiện có giữ assert "router không được gọi" để lớp cuối không che hồi quy lớp chính.
- `bff.test.ts`/`bff-risk.test.ts`: không đổi, phải xanh.

**Mutation (mỗi cái RED ≥ 1 test, ghi tên test vào log)**: M1 bỏ hẳn kiểm `Location`; M2 so `u.host` thay `u.origin` ⇒ case khác scheme RED; M3 chỉ kiểm khi `loc.startsWith("http")` ⇒ `//evil`, `/\evil` RED; M4 `loc.startsWith(appUrl)` thay so origin ⇒ `localhost:3000.evil`/`@evil` RED; M5 bỏ kiểm userinfo ⇒ `u:p@` RED; M6 đưa `loc` vào message log ⇒ test log RED; M7 giữ `res.headers` gốc khi chặn ⇒ test `set-cookie`/`location` RED; M8 bỏ guard `//` ở `server.ts` ⇒ test "router không được gọi" RED. DEBT-447 là refactor: không mutation; `server-entry.test.ts` + `protocol-relative-risk.test.ts` (corpus decode) phải xanh.

**Verify**: `pnpm -C fe-admin exec vitest run test/security-headers.test.ts test/server-entry.test.ts test/protocol-relative-risk.test.ts test/bff.test.ts test/bff-risk.test.ts`; `pnpm -C fe-admin test` (toàn bộ ≥ 1455 + mới); `typecheck`, `lint`, `build`, `check:bundle` = 0. Tester: E2E 36 (login/logout/step-up thật là đối chứng tích hợp), Docker smoke 16/16 (9b/9c không đổi).

### [x] T2 [BE] DEBT-444 + DEBT-445

1. DEBT-444 (ponytail, hành vi không đổi): `be/src/common/http/framework-errors.ts` bỏ `EdgeError/EdgeRequest/EdgeReply` ⇒ `Pick<FastifyError, 'statusCode' | 'code'>`, `Pick<FastifyRequest, 'method'>`, `Pick<FastifyReply, 'code' | 'headers' | 'send' | 'elapsedTime'>`; GIỮ guard runtime `Number.isInteger(sc)` + 400..499. `reply.headers(HEADERS)` (bỏ spread). `framework-errors.spec.ts`: fake reply ép kiểu đúng 1 chỗ. `federation.client.spec.ts`: `verify(token, timeoutMs = 1000)`, case timeout dùng `verify(token, 200)`.
2. DEBT-445: `providers.ts` `GoogleProvider.jwks: JWTVerifyGetKey & { jwks?: () => JSONWebKeySet | undefined }` (remote set của jose 5.10.0 có `jwks()`; fake `createLocalJWKSet` vẫn khớp; KHÔNG `as any`). `verifyGoogleIdToken` catch: `err.code === 'ERR_JWKS_NO_MATCHING_KEY' && provider.jwks.jwks?.()?.keys.length === 0` ⇒ `provider_unavailable`; còn lại giữ nguyên. Comment 1 dòng (JWKS rỗng không do token gây ra). Sửa câu trong comment/spec/`security-matrix.md` nói "`ERR_JWKS_NO_MATCHING_KEY` luôn 400".
3. **Test (tên chứa `DEBT-445`)** trong `federation.client.spec.ts` (server 127.0.0.1 + `createRemoteJWKSet` THẬT như run 59): `{"keys":[]}` ⇒ `provider_unavailable`; đối chứng: JWKS 1 khoá khác `kid` ⇒ `invalid_identity`; khoá khác cùng `kid` ⇒ `invalid_identity` (đã có, phải xanh); `{"keys":[]}` rồi server đổi sang JWKS đúng (`cooldownDuration: 0`) ⇒ identity (không kẹt trạng thái lỗi).
4. **Mutation**: bỏ nhánh DEBT-445 ⇒ test `{"keys":[]}` RED; mọi `ERR_JWKS_NO_MATCHING_KEY` ⇒ 502 ⇒ đối chứng kid lạ RED; `keys.length <= 1` ⇒ đối chứng RED.
5. **Verify**: `pnpm -C be test -- framework-errors.spec.ts federation.client.spec.ts`; `pnpm -C be test` (≥ 627); `typecheck`, `lint` = 0; int nhắm `b74-tester` (parity header DEBT-239) + `federation` (DEBT-197); nếu đối số vị trí không lọc thì dùng `--testPathPatterns` như tester run 59. KHÔNG docker compose/FLUSH.
