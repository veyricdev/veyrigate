# Senior Review — 2026-10-14 (run 22-X1, T1–T6)
## Kết luận: PASS

Không còn 🔴. 6 mục 🟡 → backlog DEBT-086…091 (+ ponytail DEBT-092). Chuyển **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)
- T6 (DEBT-084) bám sát thiết kế tech-lead: origin chỉ lấy từ URI **đã exact-match của chính request** (ctx Redis qua `peek()` / outcome consent / `resolvePostLogoutRedirect`), lớp 2 `safeCspOrigin`, tối đa 1 origin, fail-closed `'self'`. Code nhỏ, comment giải thích được *vì sao*.
- `buildCsp()` **byte-identical** với header helmet thật: reviewer tự dựng Fastify + `@fastify/helmet` 13.1.1 với đúng directive `main.ts` → `IDENTICAL=true`.
- `requestIdFromReturnTo` chặt: đúng path `/authorize`, đúng 1 key `request_id`, chạy sau `safeReturnTo`; trùng key / key thừa / `/authorize/consent` / encode path → null.
- seed-dev: chặn prod trước connect và trước write, đọc `DEV_SEED_*` trước connect, không log password/hash, cấm trùng `ADMIN_SEED_EMAIL`, membership `roles: []`.
- E2E cô lập namespace (`sso-idp-e2e`, Redis `/2`), không FLUSH/drop (grep 0), `reuseExistingServer` opt-in, trace chỉ bật trên CI; assert token vắng mặt trong DOM/URL/Web Storage đo bằng token thật.
- FE DEBT-078/079/080 đúng hướng, có test.

**Bằng chứng reviewer tự chạy**: BE unit 191/191; int **478/478** (23 suite); typecheck + lint BE/e2e sạch; FE 83/83; **E2E `pnpm -C e2e e2e` 1 passed (26.2s)**, log có đúng 1 response `form-action 'self' http://localhost:5173` (GET /login resume), 8 response `'self'`; stdout không có password/`access_token`/`set-cookie`/`idp_session=`. Docker không bị đụng, không FLUSH.

### Mutation T6 (reviewer tự chạy; khôi phục, md5 khớp baseline cả 5 file)
| # | Đột biến | Kết quả |
|---|---|---|
| M2 | `peek` dùng Lua consume (GET+DEL) | ✅ RED (`peek does NOT consume…`) |
| M3 | `requestIdFromReturnTo` chỉ cần có `request_id` (cho key thừa) | ✅ RED (unit 2 + int 1) |
| M4 | bỏ try/catch quanh `peek` (Redis lỗi → 500) | ✅ RED |
| M5 | `/logout` lấy origin từ `post_logout_redirect_uri` thô | ✅ RED |
| M6 | consent dùng `new URL().host` thay `safeCspOrigin` | ✅ RED |
| M7 | consent không set CSP (hồi quy DEBT-084) | ✅ RED |
| M1b | `peek` = `GETEX PX TTL+60s` (gia hạn) | ✅ RED |
| **M1a** | `peek` = `GETEX PX CONTEXT_TTL_MS` (reset TTL về 10') | ❌ **SỐNG** → 🟡 DEBT-086 |
| **M8** | log warn chèn `request_id` + `returnTo` | ❌ **SỐNG** → 🟡 DEBT-087 |

Code thật đúng (GET thuần, log tĩnh) — hai mục sống sót là lỗ của **test**, nên xếp 🟡, không phải 🔴.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **INV-084-1 (nguồn origin)**: `/login` → `ctx.redirectUri` (đã qua `isRegisteredRedirectUri` = so khớp chuỗi chính xác, lúc `createContext`); consent → `redirectUri` trong `handle()` sau Phase 1; `/logout` → `resolved` chỉ khác `defaultRedirect` khi hint ký hợp lệ + `aud`/`client_id` khớp + exact-match `postLogoutRedirectUris` (`appendState` không đổi origin). Không bao giờ đọc `redirect_uri`/`returnTo`/`post_logout_redirect_uri` thô (M5 RED). Tối đa 1 origin, không wildcard/scheme-source.
- **INV-084-2**: các directive khác giống hệt global (đo trực tiếp với helmet + test so map directive với `/register`). Không có trang nào khác bị nới `form-action`: chỉ 3 call site `buildCsp({formAction})` (login, consent, logout); frontchannel chỉ nới `frame-src`.
- **INV-084-3**: `peek` = `GET` thuần, không DEL/không PEXPIRE (đọc code); single-use được test (M2 RED); không gia hạn chỉ bảo vệ một phần (M1a sống).
- **Fail-closed**: Redis lỗi → 200 + `'self'` (M4 RED); ctx thiếu/đã dùng/hỏng → `'self'`; `safeCspOrigin` từ chối `;`/`,`/space/scheme lạ/opaque → header không tách directive (test #7).
- **Abuse**: link `/login?returnTo=/authorize?request_id=<ctx attacker>` chỉ thêm origin của redirect URI đã đăng ký — không mở đích redirect mới; `request_id` 256-bit, TTL 10'. Header chỉ lộ origin.
- **Exposure**: `/login`, consent, `/logout` đều `Cache-Control: no-store`. Phát hiện ngoài phạm vi (có sẵn từ trước): access log pino in header `location` chứa `code`/`state`/`request_id` → DEBT-089.
- **seed-dev**: `NODE_ENV=production` chặn trước `validateEnv`/connect và trước mỗi write; lỗi zod chỉ nêu tên biến/giới hạn; stdout chỉ `<sub> <email>`. Ghi đè password user có sẵn = DEBT-082 (đã nhận, có ghi trong comment + README).
- **E2E/CI**: không GitHub secrets; mọi giá trị env là placeholder; trace `retain-on-failure` chỉ trên CI với credential giả; local trace off. CI Mongo single-node + `directConnection=true` khớp code (0 `startSession`/`withTransaction`). Env CI phủ đủ `envSchema` (chỉ thiếu `TRUST_PROXY`, vốn optional).

## 🟡 Nên sửa
🟡 **[BE test] INV-084-3: test TTL không bắt được việc reset TTL** — DEBT-086
`be/test/authorize.int-spec.ts:355-365` — `ttlBefore` đo ngay sau `create` (~600000ms), ngủ 25ms, rồi chỉ assert `ttlAfter <= ttlBefore`.
Vì sao: `GETEX PX CONTEXT_TTL_MS` reset TTL về đúng ~600000, nhỏ hơn hoặc bằng `ttlBefore` → test vẫn xanh (M1a). Một lần refactor "tiện tay" có thể biến peek thành trượt TTL; mỗi lần GET /login sẽ kéo dài sự sống của ctx.
Đề xuất: trước `peek` chạy `redis.pexpire(key, 5000)`, rồi assert `pttl <= 5000`.

🟡 **[BE test] Redis-fail không kiểm log** — DEBT-087
`be/test/ui.int-spec.ts:245` — tên test có "without logging request_id" nhưng không assert gì về log (M8 sống).
Vì sao: acceptance #4 yêu cầu log không chứa request_id; hiện invariant chỉ được đảm bảo nhờ đọc code.
Đề xuất: `jest.spyOn(Logger.prototype, 'warn')` rồi assert không có lời gọi nào chứa `secret-id`.

🟡 **[BE test] Byte-identity với helmet chưa được test tự động** — DEBT-088
`be/src/common/http/csp.spec.ts:7` so với hằng số tự viết; `ui.int-spec` so map directive.
Vì sao: helmet nâng cấp default (vd. thêm directive) → global đổi nhưng `buildCsp` thì không, nên 3 trang nới CSP sẽ âm thầm lệch khỏi global. Acceptance #8 ghi "đo từ app".
Đề xuất: trong `ui.int-spec` thêm `expect(registerCsp).toBe(buildCsp())`. Thêm kiểm `form-action 'self'` cho `/`, trang lỗi, trang frontchannel (hiện test frontchannel không assert `form-action`).

🟡 **[BE, có từ trước, nay hiện trên CI] Access log lộ authorization code** — DEBT-089
Logger pino (`logger.module.ts`, redact `*.code`) in `res.headers.location` nguyên văn: E2E stdout có `"location":"http://localhost:5173/callback?code=…&state=…"` và `request_id`. Playwright `stdout: 'pipe'` → nay xuất hiện trong log CI.
Vì sao: spec INV-20 (redaction). Code dùng 1 lần + PKCE nên rủi ro thấp, nhưng log prod là nơi lưu lâu, nhiều người đọc.
Đề xuất: redact `res.headers.location` (hoặc serializer bỏ query của location). Ngoài phạm vi run này.

🟡 **[E2E] `e2e/.env` không bao giờ được nạp** — DEBT-090
`e2e/README.md:42` + `e2e/.env.example` hướng dẫn `cp … e2e/.env`, nhưng `playwright.config.ts`/`config/env.ts` không gọi `process.loadEnvFile`; Playwright cũng không tự nạp.
Vì sao: dev đặt password vào `e2e/.env` mà không có tác dụng; fallback `dev-password-123` (`config/env.ts:14`) âm thầm được dùng (vẫn chạy được vì seed dùng cùng giá trị) → tài liệu sai, dễ gây hiểu lầm.
Đề xuất: hoặc `try { process.loadEnvFile('.env') } catch {}` trong config, hoặc xoá `.env.example` + bước `cp`, chỉ ghi biến môi trường.

🟡 **[E2E] Keyset ký dùng chung với dev** — DEBT-091
`e2e/config/env.ts:46` `KEY_LOCAL_DIR: "./keys"`, BE chạy với cwd `be/` → `be/keys` = đúng thư mục của BE dev.
Vì sao: lúc boot E2E, `LocalKeyProvider.init()` tạo key / prune key retiring vào keyset dev — trái nguyên tắc "E2E không đè dữ liệu dev" (Q-X1-c). Tác động nhỏ (cùng hành vi như dev boot) nhưng cô lập không trọn.
Đề xuất: `KEY_LOCAL_DIR: "./keys-e2e"` + thêm vào `.gitignore`.

## 💭 Nit
- `renderFrontchannel` giờ thừa hưởng `font-src`/`img-src` của global và đổi phân cách `'; '` → `';'` — đúng mục tiêu "một nguồn duy nhất", chỉ ghi nhận.
- `seed-dev.ts:238` `$set: {status:'active'}` kích hoạt lại membership `suspended` mỗi lần seed (dev-only; cân nhắc `$setOnInsert`).
- `Home.tsx` lazy initializer có side effect (consume sessionStorage). Prod chạy đúng; dev StrictMode dùng kết quả lần gọi đầu nên vẫn đúng, nhưng `Home.test.tsx` mock `consumeLogout` nên không có test StrictMode + `handleLogoutLanding` thật.
- CI chưa cache trình duyệt Playwright (`~/.cache/ms-playwright`) → mỗi lần chạy tải lại ~150MB.

## ✂️ Ponytail
- fe-sso-test/src/oidc/token-exchange.ts:L20: delete: `KNOWN_TOKEN_ERROR_CODES` + ternary — mọi mã trong whitelist đã đi qua sanitizer y nguyên (`[a-z0-9_]`, ≤64). Chỉ giữ `error.replace(/[^a-z0-9_-]/gi,"").slice(0,64) || "unknown"` (giống DEBT-081).
- be/src/common/http/csp.ts:L90: delete: `if (origin === 'null') return null;` — regex dòng 91 đã loại `'null'`.
- be/src/modules/ui/return-to.ts:L15: shrink: 2 dòng → `return params.get('request_id') || null;`.
- be/src/modules/ui/ui.controller.ts:L126: shrink: gộp `setLoginFormActionCsp` vào `login()` (2 header + 1 lời gọi `loginFormActionOrigin`), bỏ 1 helper + docblock.
- e2e/.env.example:L1: delete: (nếu chọn hướng "chỉ env var" ở DEBT-090) file không được nạp.
net: -28 lines possible.
