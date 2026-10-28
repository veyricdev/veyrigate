# Test Report — 2026-10-28 (run 60, phòng thủ cuối redirect + dọn sau run 59)

## Kết quả: PASS — T1 (DEBT-446/447) + T2 (DEBT-444/445/451/460)

- Số liệu: be unit **630/630**; int full **1420/1420** (shard 1/2 858 + 2/2 562, không timeout, không chạy lại); fe-admin 66 file **1533/1533** (1482 + 51 test tester mới); fe-sso-test 269; E2E **36/36**; probe build production thật **19 208 target ⇒ 0 `Location` ra ngoài origin**; mutation tích hợp trên build thật (bỏ guard `//`) ⇒ lớp cuối chặn **5 832/5 832** redirect 308; lint/typecheck/build/check:bundle 0; audit exit 0; grep secret 0.
- Không debt mới. Không chạy Docker smoke (tuỳ chọn; dev 16/16; probe build thật ở case 2–3 mạnh hơn cho lớp mới).

## Lệnh đã chạy + output thực tế

Preflight: codegraph 1.6.2, `sync` Done. Lock `vg:int-lock` (`docker exec vg-test-redis redis-cli GET`) rỗng trước mỗi shard. Cổng :3000/:4000/:5173 trống trước E2E, `E2E_REUSE` không đặt, sau E2E các cổng (và 3561/3562 của probe) trống. Không kill/stop/restart process hay container nào; chỉ process con `node serve.mjs` và server IdP giả của chính probe (script tự `SIGTERM`, chờ `exit`, `close`). Không đụng `aegate-*`, mailpit, `be/keys`, `be/.env`.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be run typecheck` / `lint` / `build` / `test` | 0 / 0 / 0 / 39 suite **630 passed** |
| 2 | `pnpm -C fe-admin run typecheck` / `lint` | 0 / 0 |
| 3 | `npx vitest run test/location-guard-risk.test.ts` (fe-admin, file mới của tester) | **51 passed** (case 1) |
| 4 | `pnpm -C fe-admin build` + `check:bundle` | 0 / `23 client files … 0 hit(s)` |
| 5 | `node probe-run60.mjs fe-admin 3561 3562 <certdir>` (scratchpad `r60t/`) | case 2 |
| 6 | mutation `server.ts` (bỏ guard `//`) + build + probe, khôi phục + build lại | case 3 |
| 7 | mutation `security-headers.ts` (Ma, Mb) + vitest file mới, khôi phục | case 4 |
| 8 | `pnpm -C fe-admin test` | 66 file, **1533 passed** |
| 9 | `pnpm -C be test:int --shard=1/2` | 27 suite **858 passed**, 300 s (gồm `b74-tester`, `run59-http-edge-tester`) |
| 10 | `pnpm -C be test:int --shard=2/2` | 26 suite **562 passed**, 281 s (gồm `federation.int-spec`) |
| 11 | root `pnpm lint` / `pnpm -r run typecheck` / `pnpm test` | 0 / 0 / 0 (be 630, fe-admin 1533, fe-sso-test 269) |
| 12 | `pnpm audit --audit-level high` | exit 0 — 7 low, 9 moderate, 1 high ignored |
| 13 | `pnpm -C e2e e2e` (1 lần) | **36 passed (4.4m)**; log WebServer: 0 dòng `location guard` |
| 14 | grep secret (PEM private, `*_SECRET=`, `DEV_SEED_PASSWORD=`, JWK `"d":`, JWT 3 phần) trên mọi log tester | 0 hit; khoá TLS tự ký của IdP giả đã xoá sau probe |

### Case 1 — `fe-admin/test/location-guard-risk.test.ts` (mới, 51 test, tên chứa `DEBT-446`)

Mỗi ca kiểm: giữ ⇒ status 302, `Location` nguyên văn, `Set-Cookie` giữ, 0 log; chặn ⇒ 404 `Not Found`, không `Location`/`Set-Cookie`, `no-store`, đúng 1 dòng log chứa `(status 302)` và KHÔNG chứa `evil`/`xn--`/`bücher`/`[::`/`blob`/`idp.example`/`fea_tx`.
- **`:443` tường minh** (issuer cấu hình `https://idp.example:443/realm`): giữ `https://idp.example:443/authorize`, `https://idp.example/authorize`, `https://admin.example:443/next`, `HTTPS://IDP.EXAMPLE:443/x`; chặn `http://idp.example:443/…`, `http://idp.example/…`, `:8443`, `:4430`.
- **IDN** (`APP_URL` `https://bücher.example`): giữ dạng punycode/Unicode/hoa; chặn `bucher.example`, `xn--bcher-kva.example.evil`, `bücher.example.evil`.
- **IPv6** (`http://[::1]:3000`): giữ `[0:0:0:0:0:0:0:1]:3000`; chặn `[::2]`, khác port, `[::ffff:127.0.0.1]`, `127.0.0.1`.
- **Dạng đổi authority**: chặn ` //evil`, `\t//evil`, `\/evil`, `/\/evil`, `http:evil.example` (không `//`), `https:/\evil`, `HtTp://evil`, `http://evil.example\@localhost:3000/`, `localhost.` (trailing dot), `LOCALHOST:3000@evil`, `ftp:`/`ws:`/`file:`/`vbscript:`, `http://evil.example/, /x`, 2 header `Location` (lạ trước). NUL/CR/LF: `Headers` ném `TypeError` nên không bao giờ tới wire.
- **Đối chứng tương đối/encoded**: giữ `/%2F%2Fevil`, `/%5C%5Cevil`, `?returnTo=//evil`, `/#//evil`, `?next=//evil`, `x/../..//y`, `http://%6Cocalhost:3000/`, `http://localhost:3000\@evil.example/` (`\` kết thúc authority ⇒ host là app, `@evil…` là path — đúng như trình duyệt); 2 header `/x` + lạ ⇒ gộp thành 1 path tương đối, giữ.
- **`blob:`** (nit senior, ghi nhận): `blob:http://localhost:3000/<uuid>` **qua** guard (origin của blob URL là origin bên trong); `blob:http://evil.example/…` bị chặn. Không khai thác được: trình duyệt coi redirect tới `blob:` là network error, không nguồn nào phát. Không mở debt (đồng ý senior).

### Case 2 — build production thật, Host giả (I1)

`probe-run60.mjs`: spawn `node serve.mjs` (env như `docker-smoke.sh`: secret sinh ngẫu nhiên, Redis `127.0.0.1:1`, `NODE_ENV=production`), cổng 3561; IdP giả HTTPS tự ký ở 3562 (chỉ child tin qua `NODE_EXTRA_CA_CERTS`) phục vụ discovery, `OIDC_ISSUER=https://127.0.0.1:3562`, `APP_URL=https://admin.example.invalid`. Socket thô; corpus run 59 (39 biến thể × GET/HEAD/POST) × 4 Host (`evil.example`, `admin.example.invalid.evil.example`, `admin.example.invalid:443`, `[::1]:3000`) + corpus vét cạn 10/18 token origin-form + absolute-form. Tiêu chí: `Location` tuyệt đối có origin ∉ {app, issuer} hoặc có userinfo, hoặc tương đối có authority, hoặc status 308 ⇒ vi phạm.

```
targets=19208 statuses={"307":12180,"400":872,"404":6132,"411":24} errors=0
withLocation=12180 multiLocation=0
OFF-ORIGIN-or-308 Location=0
distinct Location shapes (138) sample: ["/auth/login?returnTo=…","/%25/evil.example","/%2F","/a",…]
flow POST /auth/logout (no cookie, Origin=app) => 303 / offOrigin=false set-cookie=0
flow POST /auth/logout (cookie, Origin=app) => 303 https://127.0.0.1:3562/session/end?post_logout_redirect_uri=https%3A%2F%2Fadmin.example.invalid%2F&client_id=fe-admin offOrigin=false set-cookie=1
flow POST /auth/logout (cookie, Origin=app, Host=evil.example) => 303 https://127.0.0.1:3562/session/end?… offOrigin=false set-cookie=1
flow GET /auth/login (Redis down) => 503            flow GET /auth/login?stepup=1 (Redis down) => 503
flow GET /auth/callback (no tx cookie) => 400        flow GET / (root guard) => 307 /auth/login?returnTo=%2F
flow GET /users?q=%2F%2Fx => 307 /auth/login?returnTo=%2Fusers%3Fq%3D%252F%252Fx     flow GET asset => 200
discovery hits on fake IdP=1
child log: 33 lines; "location guard" lines=0
serve.mjs exited (own child), code=null signal=SIGTERM; fake IdP closed
```

- 0 `Location` ra ngoài origin; guard `//` (lớp chính) vẫn trả 404 nên lớp cuối không kích hoạt (0 dòng log) ⇒ không chặn nhầm traffic thật.
- Logout có cookie đi qua lớp cuối trên build thật với `Location` tuyệt đối tới `end_session_endpoint` (origin issuer, port tường minh 3562) ⇒ giữ, kèm `Set-Cookie` xoá sid; Host giả không đổi đích. Login/step-up trên build thật cần Redis (đây là Redis chết ⇒ 503, không `Location`): đối chứng login ⇒ IdP `/authorize`, step-up, callback `returnTo` lấy từ E2E (case 5).

### Case 3 — mutation tích hợp trên build thật: bỏ guard `//` (lớp cuối có thật sự đỡ?)

`fe-admin/src/server.ts` backup sha256 `e26412df5bf28294…389d`; đổi điều kiện guard `//` thành `false && (…)`; `pnpm -C fe-admin build` 0; chạy lại probe:

```
targets=19208 statuses={"307":12276,"400":944,"404":5832,"411":156} errors=0
OFF-ORIGIN-or-308 Location=0
404 "Not Found" bodies=5700            (HEAD không body)
child log: 5865 lines; "location guard" lines=5832
   [fe-admin] location guard failed, request id <id>: Error: blocked an off-origin Location (status 308)
child log mentions evil.example=false
```

Không có guard `//`, router phát 308 `Location: http://<Host>//…` (run 59 lượt 1 tái hiện được) ⇒ lớp DEBT-446 đổi **toàn bộ 5 832** response 404 thành `Not Found`, 1 dòng log/response, log không chứa Host/path. Luồng logout/root guard giữ nguyên. Khôi phục: sha256 khớp `e26412df…389d`, `git diff --stat` như trước mutation (13 dòng của DEBT-447), build lại 0 (bundle có lại `routerPathname(request.url).startsWith`).

### Case 4 — mutation `security-headers.ts` với file test mới

Backup sha256 `7d905e751a394cd7…`, khôi phục byte-identical sau mỗi mutation (`git diff --stat` 27 dòng như dev).
- Ma: so `host` thay `origin` ⇒ **4 RED** (`http://idp.example/authorize` với issuer https, `ftp://`, `ws://`, `blob:` đối chứng).
- Mb: so `hostname` bỏ qua port/scheme ⇒ **8 RED** (`http://idp.example:443`, `:8443`, `:4430`, …).
- M1–M8 của dev (log.md) không chạy lại: đã ghi RED kèm tên test, file test dev không đổi.

### Case 5 — E2E 36/36 (đối chứng tích hợp redirect thật, dev server fe-admin có diff T1)

`fe-admin.spec.ts:31` BFF login ⇒ IdP ⇒ callback ⇒ admin, logout kết thúc phiên IdP (end_session); `:108` callback giả mạo ⇒ trang lỗi chung; `fe-admin-risk.spec.ts:89` step-up đổi user ⇒ huỷ phiên; `fe-admin-clients.spec.ts:30` + `admin-client.spec.ts:49` step-up round-trip quay lại đúng `returnTo`; `fe-admin-hardening.spec.ts:38` CSP/headers/cookie. Log WebServer: **0** dòng `location guard` (không chặn nhầm); 4 dòng `server function failed` là lỗi zod do test risk cố ý gửi input sai (như các run trước).

### Case 6 — T2 (DEBT-444/445/451/460)

- `federation.client.spec.ts` (remote JWKS thật trên 127.0.0.1) trong be unit 630: `{"keys":[]}` ⇒ `provider_unavailable`; 1 khoá kid khác ⇒ `invalid_identity`; khoá khác cùng kid ⇒ `invalid_identity`; rỗng rồi JWKS đúng (`cooldownDuration: 0`) ⇒ identity.
- HTTP thật (`federation.int-spec.ts`, shard 2/2 PASS): `DEBT-445: an EMPTY key set … => 502, nothing created`; `token fault other-key-same-kid / unknown-kid on a healthy JWKS => 400 invalid_identity (never 502), nothing created`; timeout/5xx/khoá private ⇒ 502.
- framework-errors không hồi quy: `framework-errors.spec` trong unit 630; `run59-http-edge-tester` (17 test: header parity, body cố định, `no-store`, không echo, không log ERROR, keep-alive, 40 request đồng thời) + `b74-tester` PASS trong shard 1/2.

## Test FAIL

Không có.

## Coverage acceptance criteria

- [x] T1 DEBT-446 thiết kế (origin chuẩn hoá, userinfo, tương đối có authority, fail-closed, mọi status, 404 bỏ header gốc, log cố định) — test dev + case 1, 3, 4.
- [x] T1 redirect hợp lệ giữ nguyên: login/step-up ⇒ `/authorize`, callback `returnTo`, logout `/` + `end_session` — case 2 (logout trên build thật), case 5 (E2E đầy đủ).
- [x] T1 DEBT-447 (refactor `routerPathname`) — case 2 (corpus decode trên build thật: 0 vi phạm), `protocol-relative-risk.test.ts` trong 1533.
- [x] T2 DEBT-445 JWKS rỗng ⇒ 502, kid lạ ⇒ 400 — case 6. DEBT-444/451/460 không đổi hành vi — case 6.
- [x] Cổng chung: be/fe-admin unit/typecheck/lint/build, check:bundle, int full, root lint/typecheck/test, audit, E2E — bảng lệnh.

## Coverage security invariants / risk matrix

- [x] I1 × Identity anonymous × Input encoded/oversized path (corpus run 59) × Host giả 4 dạng (khác host, hậu tố, `:443` tường minh, IPv6) × Method GET/HEAD/POST × Request chain origin-form + absolute-form × Exposure `Location`/log — case 2, 3.
- [x] I1 × Input dạng URL lệch chuẩn (`:443`, IDN, IPv6, trailing dot, `\`, tab/space, scheme không `//`, scheme lạ, nhiều header) — case 1.
- [x] I1 × Dependency: lớp chính (guard `//`) hỏng ⇒ lớp cuối fail-closed — case 3. Redis chết ⇒ login 503 không `Location` — case 2.
- [x] I1 Exposure: response bị chặn không `Location`/`Set-Cookie`; log không Host/path/URL — case 1, 3.
- [x] I2 × Dependency (JWKS rỗng/timeout/5xx/khoá private) vs Credential (kid lạ, khoá khác cùng kid) × State (rỗng rồi hồi phục) — case 6; không session/user/link (int).
- Ghi nhận (không debt): `blob:<origin hợp lệ>` qua guard, không khai thác được (case 1).
