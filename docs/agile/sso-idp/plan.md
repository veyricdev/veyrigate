# Plan triển khai: IdP (BE) + Admin FE + SSO Test FE

Plan này bám theo `spec.md` (cùng thư mục, gọi tắt là **spec**). Mọi tham chiếu dạng `§9.5` là mục của spec, `INV-13` là Security Invariant số 13 (spec §15). Plan dùng làm đầu vào cho bước "tạo task → duyệt → phân công → code → review → test".

---

## 0. Cách dùng plan này

- Mỗi task có **ID**, **phụ thuộc**, **kích thước** (S ≈ vài giờ, M ≈ 1–2 ngày, L ≈ 3–5 ngày cho 1 dev/agent) và **tiêu chí nghiệm thu** (trỏ về spec/invariant).
- Prefix: `R` = repo/hạ tầng, `B` = backend, `A` = admin FE, `T` = SSO test FE, `X` = liên module/E2E/release.
- Trạng thái theo dõi trong `PROGRESS.md` ở gốc repo: `todo → in-progress → in-review → testing → done`. Agent điều phối đọc file này để chọn task kế tiếp.
- **Cổng chất lượng (gate) cho mỗi task**: code → `security-reviewer` (đối chiếu INV liên quan) → `test-runner` (test theo §14) → mới được `done`. Task đụng `oauth/`, `keys/`, `clients/`, `admin/` bắt buộc qua security review; task FE qua review UI/UX + bảo mật FE (mục A7).
- **Định nghĩa Done chung** ở mục 10.

---

## 1. Kiến trúc repo & môi trường

### 1.1 Cấu trúc repo

```
<repo>/
├── be/                     # NestJS + Fastify IdP (theo spec §5)
├── fe-admin/               # TanStack Start — trang quản trị
├── fe-sso-test/            # React + React Router — app thử SSO (public client)
├── docs/
│   ├── spec.md             # nguồn sự thật (bản spec)
│   └── plan.md             # = file này
├── .claude/agents/         # subagent: spec-planner, be-coder, fe-coder, security-reviewer, test-runner
├── docker-compose.yml      # mongo, redis, mailpit (+ profile "full" chạy cả be)
├── package.json            # script tổng: dev:all, lint, test, typecheck
├── pnpm-workspace.yaml     # (đề xuất) gộp 3 package vào 1 workspace
├── PROGRESS.md
└── README.md
```

Tên thư mục `be/`, `fe-admin/`, `fe-sso-test/` là đề xuất — đổi tuỳ ý, chỉ cần thống nhất trong plan.

### 1.2 Cổng & URL dev (đề xuất)

| Thành phần | URL | Ghi chú |
|---|---|---|
| BE (IdP) | `http://localhost:4000` | `ISSUER=http://localhost:4000` — issuer phải khớp tuyệt đối ở mọi nơi (INV-9) |
| fe-admin | `http://localhost:3000` | Client **confidential** (BFF) của IdP |
| fe-sso-test | `http://localhost:5173` | Client **public** (SPA + PKCE) |
| MongoDB | `mongodb://localhost:27017` | docker |
| Redis | `redis://localhost:6379` | docker |
| Mailpit | SMTP `1025`, UI `http://localhost:8025` | bắt email verify/reset khi dev |

### 1.3 docker-compose (khung)

```yaml
services:
  mongo:
    image: mongo:7
    ports: ["27017:27017"]
    volumes: [mongo_data:/data/db]
    healthcheck: { test: ["CMD","mongosh","--quiet","--eval","db.adminCommand('ping')"], interval: 10s, retries: 5 }
  redis:
    image: redis:7
    command: ["redis-server","--appendonly","yes"]
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    healthcheck: { test: ["CMD","redis-cli","ping"], interval: 10s, retries: 5 }
  mailpit:
    image: axllent/mailpit
    ports: ["1025:1025","8025:8025"]
  # profile "full": be (build từ be/Dockerfile) phụ thuộc mongo+redis healthy
volumes: { mongo_data: {}, redis_data: {} }
```

Lưu ý: refresh token vẫn chỉ dùng `findOneAndUpdate` điều kiện trên **một document**. Riêng guard "còn ≥ 1 super_admin active" (run 69, DEBT-142) dùng **transaction** (snapshot + câu touch chung) ⇒ **MongoDB replica set là bắt buộc** (prod, `aegate-mongo`, `vg-test-mongo`, CI `int`/`e2e` đều là RS; standalone ⇒ demote/khoá bởi super_admin trả 5xx, không ghi). Pin version image khi chốt.

### 1.4 Biến môi trường (`.env.example` mỗi package, không commit secret)

**be**: `NODE_ENV, PORT, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER(local|aws-kms|vault), KEY_LOCAL_DIR, SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_*`

**fe-admin** (validate bằng T3Env): server — `OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL`; client — chỉ các biến `VITE_*` không nhạy cảm.

**fe-sso-test**: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL` (validate bằng zod ở `env.ts`, fail-fast khi boot).

### 1.5 Công cụ & phiên bản (cần kiểm tra lại lúc scaffold)

- BE: `nest new be --package-manager pnpm --strict --skip-git`, thay `@nestjs/platform-express` bằng `@nestjs/platform-fastify`. Thư viện dự kiến: `@nestjs/mongoose`, `ioredis`, `jose` (JWT/JWKS), `argon2`, `@fastify/helmet`, `@fastify/cookie`, `@fastify/formbody`, `@fastify/csrf-protection`, `@fastify/view` + engine (Eta/Handlebars), `@nestjs/throttler` (Redis storage), `nestjs-pino`, `prom-client`, `@nestjs/swagger`, `nodemailer`.
- fe-admin: TanStack CLI (hiện đánh dấu **alpha**), TanStack Start (đang ở **RC**) → sau khi scaffold phải **pin phiên bản** trong lockfile và ghi lại trong README.
- fe-sso-test: React Router — theo tài liệu hiện hành, v8 đã bỏ package `react-router-dom` (import từ `react-router`) và ESM-only; kiểm tra bằng `npm view react-router version` trước khi cài.

---

## 2. Đề xuất ngoài spec (cần bạn duyệt trước khi code)

Khi lập plan tôi phát hiện một số chỗ spec chưa đủ để triển khai 3 app. Plan đã **giả định phương án khuyến nghị** (cột 3); bạn đổi thì báo để chỉnh task.

| # | Vấn đề | Phương án plan đang giả định | Ảnh hưởng task |
|---|---|---|---|
| D1 | Spec có `/login`, consent, logout-confirm nhưng chưa nói **UI này nằm ở đâu** (chỉ có 2 FE) | **BE tự render** các trang login/register/verify/reset/consent/logout bằng template server-side (cùng origin với cookie session → CSRF/SameSite đơn giản, IdP độc lập với FE nào). Không đặt trong fe-admin | B2.5 |
| D2 | fe-admin đăng nhập bằng cách nào? | **Dogfooding**: fe-admin là **client confidential kiểu BFF** — code exchange + giữ token ở server (server functions của TanStack Start), trình duyệt chỉ có cookie session mã hoá httpOnly; token không bao giờ xuống JS | A4, B6.1 |
| D3 | Step-up re-auth (INV-26) chưa có cơ chế cụ thể | Hỗ trợ `prompt=login` + **`max_age`**; access token cấp cho resource `admin` mang thêm claim **`auth_time`**; API admin từ chối thao tác nhạy cảm nếu `auth_time` quá N phút (đề xuất 5) → trả `403 step_up_required` để fe-admin đẩy user đi re-auth | B4.1, B4.4, B6.2, A5 ✅ CHỐT (Q4) |
| D4 | RP-initiated logout cần `post_logout_redirect_uri` nhưng model `Client` chưa có | Thêm `postLogoutRedirectUris[]` (exact match, cấm wildcard — cùng quy tắc INV-4) | B3.1, B4.7 |
| D5 | Cần một **resource server thật** để test `aud` (INV-8, spec §7) | Module **demo-resource** trong BE, chỉ bật khi `NODE_ENV != production`: `GET /demo/me` verify JWT (iss/aud/exp/sig). Identifier `http://localhost:4000/demo/` | B6.5, T4 |
| D6 | Resource `admin` cho admin API | Resource identifier `http://localhost:4000/admin/`, scope `admin.read`, `admin.write`; quyền theo `UserTenant.roles[]` (`super_admin`, `tenant_admin`) | B6.1, B6.4 |
| D7 | Khi nào cấp refresh token? Spec chưa nói (scopes chỉ có openid/profile/email) | Cấp refresh token khi client có grant `refresh_token` **và** scope yêu cầu gồm `offline_access` (chuẩn OIDC); thêm `offline_access` vào `scopes_supported` | B4.4, B4.5 ✅ CHỐT (Q4) |
| D8 | CORS cho `/token`, `/userinfo`, `/jwks.json` khi SPA public gọi từ trình duyệt | Preflight cho phép nếu origin ∈ **hợp** mọi `allowedCorsOrigins` đã đăng ký; request thực kiểm tra origin ∈ danh sách **của đúng client** (theo `client_id`) | B3.4 |
| D9 | KMS thật chưa chọn | Định nghĩa interface `KeyProvider`; dev dùng `LocalKeyProvider` (file key, **chỉ dev**), prod cắm `AwsKmsProvider`/`VaultProvider` (chọn ở B7.3) | B1.9, B7.3 |
| D10 | Email verify/reset cần mailer | Interface `Mailer`; dev dùng Mailpit; prod chọn SMTP/SES | B1.10 |
| D11 | Admin FE cần client kiểu type-safe cho admin API | BE sinh OpenAPI (`@nestjs/swagger`) → fe-admin sinh types bằng `openapi-typescript`; trước khi BE xong dùng mock (MSW) theo hợp đồng OpenAPI để 2 lane chạy song song | B6.3, A5 |
| D12 | Test federation không thể gọi Google/GitHub thật trong CI | Dùng mock OAuth provider (vd. `oauth2-mock-server`) cho CI; thử tay với Google/GitHub thật ở môi trường dev | B5.*, X4 |

---

## 3. Lộ trình & milestone

Nguyên tắc: **walking skeleton sớm** (M3: đăng nhập email/password end-to-end qua fe-sso-test) nhưng **mọi invariant liên quan được cài ngay từ lúc viết**, không "làm tạm rồi vá sau".

| Milestone | Nội dung | Task |
|---|---|---|
| **M0** Repo sẵn sàng | Monorepo, docker infra, agent workspace, CI khung | R1–R5 |
| **M1** Nền tảng (song song 3 lane) | BE foundation · fe-admin scaffold+UI base · fe-sso-test scaffold | B1.*, A1–A3, T1 |
| **M2** Danh tính & client | Identity, sessions, authentication, UI server-side, clients/resources | B2.*, B3.* |
| **M3** Walking skeleton | `/authorize` → login → `/token` chạy thật; fe-sso-test đăng nhập được | B4.1–B4.4, T2, X1 |
| **M4** OAuth đầy đủ | Consent, refresh+rotation, userinfo/discovery/introspect, logout; test app đủ trang | B4.2, B4.5–B4.7, T3–T5 |
| **M5** Quản trị | Admin API + seed + step-up; fe-admin đăng nhập & các trang | B6.*, A4–A6 |
| **M6** Federation | Google/GitHub broker + account linking | B5.*, X4 |
| **M7** Hardening | Security suite, observability, Docker/KMS, FE hardening, E2E, cookie topology | B7.*, A7–A9, T7, X2, X3, X5 |
| **M8** Release candidate | Pentest checklist, DR drill, runbook, tài liệu | X6 |

### Lane song song (sau M0)

```
Lane BE   : B1 ─▶ B2 ─▶ B3 ─▶ B4 ─▶ B6 ─▶ B5 ─▶ B7
Lane ADMIN: A1─A3 (độc lập) ─▶ [chờ B4.4 + B6.4] A4 ─▶ A5 (mock trước) ─▶ [chờ B6.3] A6.* ─▶ A7─A9
Lane TEST : T1 (độc lập) ─▶ [chờ B4.1–B4.4] T2 ─▶ T3─T5 ─▶ T7
Lane QA   : X1 sau M3 · X2/X3/X5 sau M4–M7 · X4 sau B5 · X6 cuối
```

---

## 4. Phase R — Repo & hạ tầng (M0)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| R1 | Khởi tạo monorepo: git, `.gitignore`, `.editorconfig`, `.nvmrc`, pnpm workspace, script gốc (`dev:all`, `lint`, `typecheck`, `test`) | — | S | `pnpm i` ở gốc cài được cả 3 package (sau khi scaffold); `pnpm dev:all` chạy song song 3 app |
| R2 | `docker-compose.yml` (mongo, redis, mailpit, healthcheck, volume; profile `full`) | R1 | S | `docker compose up -d` → 3 service healthy; BE kết nối được |
| R3 | Agent workspace: `docs/spec.md`, `docs/plan.md`, `PROGRESS.md`, `.claude/agents/*` (mỗi agent có chỉ dẫn "đọc `docs/spec.md` trước") | R1 | S | Chạy thử `spec-planner` ra backlog khớp plan này |
| R4 | CI (GitHub Actions): job theo package — install (cache), lint, typecheck, unit test; job e2e dùng service mongo/redis; chặn merge nếu đỏ | R1 | M | PR mẫu chạy đủ job; thời gian job < ngưỡng đã đặt |
| R5 | Quy ước secret: `.env.example` cho từng package, pre-commit secret scan (vd. gitleaks), README "chạy local trong 5 phút" | R1 | S | Clone mới → làm theo README chạy được; commit chứa secret bị chặn |

---

## 5. Phase B — Backend (`be/`)

### B1. Foundation (spec §13 bước 1–3)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B1.1 | Scaffold NestJS + FastifyAdapter, TS strict, ESLint/Prettier, cấu trúc thư mục theo spec §5 (module rỗng) | R1 | S | `pnpm start:dev` chạy; không còn dependency Express |
| B1.2 | Config module: đọc env, **validate schema (zod/joi) fail-fast**, typed config | B1.1 | S | Thiếu/sai env → app không khởi động, báo rõ biến nào |
| B1.3 | Logging Pino + **redact** (password, token, code, secret, cookie, authorization) + request-id; `/health` (liveness) & `/ready` (check mongo+redis); helmet; global `ValidationPipe` (`whitelist:true`, `forbidNonWhitelisted`); exception filter trả lỗi **chuẩn OAuth** (`error`, `error_description`); graceful shutdown | B1.2 | M | INV-20: test xác nhận log không chứa giá trị nhạy cảm; readiness đỏ khi Redis/Mongo down |
| B1.4 | Mongo module (Mongoose) + Redis module (ioredis) + loader cho **Lua script** (`defineCommand`) | B1.2 | S | Kết nối, retry, đóng sạch khi shutdown |
| B1.5 | Crypto utils: argon2 hash/verify, sinh token ngẫu nhiên (CSPRNG), `sha256` token hash, so sánh constant-time, PKCE S256 helper | B1.1 | M | Unit test có vector chuẩn (RFC 7636 example); không dùng `Math.random` |
| B1.6 | Toàn bộ schema §10 + **index** (kể cả TTL index cho token/reset); script đồng bộ index tường minh (tắt autoIndex ở prod) | B1.4 | M | Unique/TTL index tồn tại đúng như §10; test vi phạm unique bị từ chối |
| B1.7 | Module **Audit**: schema mở rộng §10, enum action, service `record()` **không nhận trường bí mật** (type-level), hook alert cho `TOKEN_REUSE_DETECTED`/`SIGNING_KEY_ROTATED` | B1.6 | M | INV-25; test: payload chứa `password/token/secret` bị loại/không compile |
| B1.8 | Module **Rate-limit** đa chiều (IP + account/email + deviceId) trên Redis; decorator áp cho endpoint | B1.4 | M | §6.3; test brute-force đổi IP vẫn bị chặn theo account |
| B1.9 | **KeyProvider** (interface) + `LocalKeyProvider` (dev) + JWKS endpoint `/jwks.json` (RS256, `kid`) + `TokenSigner/Verifier` (`jose`) + rotation **thường** & **khẩn cấp** (§6.4) | B1.6 | L | INV-19: private key không lộ qua API/log; rotation thường giữ key cũ trong JWKS tới khi hết hạn; khẩn cấp gỡ ngay; test verify token khi đổi key |
| B1.10 | `Mailer` interface + adapter SMTP (Mailpit khi dev) + template email verify/reset | B1.2 | S | Email tới Mailpit; template không chứa dữ liệu thừa |

### B2. Danh tính & phiên (spec §13 bước 5, 7; §9.6, §9.8, §9.12)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B2.1 | **Tenant context** (interceptor/guard lấy tenant từ session/token đã xác thực) + **repository base bắt buộc filter tenant** | B1.6 | M | INV-24: không có đường nào nhận `tenantId` từ body/query; test cross-tenant bị chặn |
| B2.2 | Identity services: User, Tenant (seed `default-tenant`), UserTenant, FederatedIdentity | B2.1 | M | CRUD nội bộ + unique index; `sub` là ID bất biến (không phải email) |
| B2.3 | **Sessions** (Redis): cookie `HttpOnly; Secure; SameSite=Lax`, ID opaque, **cấp ID mới sau login**, idle + absolute timeout, revoke theo thiết bị | B1.4, B1.5 | M | INV-16, INV-17; test fixation; ở dev cho phép `Secure=false` qua cờ env duy nhất |
| B2.4 | **Authentication**: register, verify email, login, lockout (`failedLoginCount/lockedUntil`), forgot/reset password — token **hash + atomic single-use** (`findOneAndUpdate` điều kiện `usedAt:null & expiresAt>now`); response **đồng nhất** chống enumeration | B2.2, B2.3, B1.8, B1.10 | L | INV-27 (§9.12); test reset token dùng đồng thời 2 request chỉ 1 thành công; test không lộ user tồn tại |
| B2.5 | **UI server-side** (theo D1): login, register, verify-result, forgot/reset, consent, logout-confirm, error; CSRF token cho mọi POST form; CSP chặt; CSS build sẵn (Tailwind CLI hoặc CSS tay) | B2.3, B2.4 | L | §9.8: `GET /logout` không phá session; mọi POST có CSRF; không inline script |

### B3. Client & Resource (spec §13 bước 4; §7, §9.3, §9.7)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B3.1 | Clients: `Client` + `ClientCredential` (hash secret, `version`, rotation có overlap/grace); **validator redirect_uri**: absolute, khớp **exact**, cấm wildcard/fragment, chỉ `https` (cho phép `http://localhost` ở dev); thêm `postLogoutRedirectUris[]` (D4) | B2.1 | L | INV-4, INV-18, INV-21; test các biến thể (slash cuối, query lạ, wildcard, subdomain) bị từ chối |
| B3.2 | Resources: `Resource` + `Client.allowedResources[]`; validator `resource` = absolute URI, không fragment, thuộc `allowedResources` | B3.1 | M | INV-14; test resource ngoài danh sách bị reject |
| B3.3 | **Client authentication** cho `/token`: `client_secret_basic`, `client_secret_post`, `none` (public bắt buộc PKCE); chấp nhận credential còn hiệu lực theo version | B3.1 | M | Sai method so với `token_endpoint_auth_method` → `invalid_client`; secret so sánh constant-time |
| B3.4 | **CORS động** theo D8 cho `/token`, `/userinfo`, `/jwks.json`, discovery — dùng `allowedCorsOrigins[]`, **không** dùng `redirect_uris` | B3.1 | S | §9.7; test origin lạ bị chặn, preflight đúng |

### B4. OAuth core (spec §13 bước 6, 8–12; §9.1–9.5, §9.8)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B4.1 | **`/authorize`** + `AuthorizeRequestContext` (Redis, TTL 5–10', single-use): validate `client_id`, `redirect_uri` exact, `response_type=code`, `code_challenge_method=S256` (reject `plain`), `resource`, `scope`; xử lý `prompt=none/login/consent`, **`max_age`** (D3); **lỗi trước khi biết redirect_uri hợp lệ thì hiển thị trang lỗi, không redirect** (chống open redirect) | B3.2, B2.3, B2.5 | L | INV-3, 4, 14, 15; §9.2; test open redirect, PKCE plain, resource lạ |
| B4.2 | **Consent**: schema có `policyVersion/termsVersion`; bỏ qua khi đã đủ scope+version; từ chối → `access_denied`; `prompt=consent` ép hỏi lại; `prompt=none` mà thiếu consent → `consent_required` | B4.1 | M | §9.4; quyết định semantic scope (mục 12, Q1) phải chốt trước task này |
| B4.3 | **AuthorizationCode store** + **Lua consume-with-binding** (đúng script §9.5: chỉ xoá khi `clientId` & `redirectUri` khớp) | B1.4 | M | INV-1, 2, 13; test: request sai `client_id`/`redirect_uri` **không** làm mất code; 2 request đồng thời chỉ 1 thành công; code hết hạn sau 60s |
| B4.4 | **`/token` (authorization_code)**: client auth → consume+bind → verify `code_verifier` → phát hành **access token** (`aud`=resource, `jti`, `scope`, `client_id`, + `auth_time` cho resource admin), **ID token** (`aud`=client_id, `nonce` mang nguyên vẹn, `auth_time`, `amr`, `acr`), refresh token (theo D7) | B4.1, B4.3, B3.3, B1.9 | L | INV-5, 7, 8, 9; §8 (claims đúng contract, `sub` bất biến); `iss` trong redirect từ `/authorize` (RFC 9207) |
| B4.5 | **Refresh grant**: lưu `tokenHash` (không plaintext), `familyId/parentId`, bind `scope/resource/clientId`; **rotation atomic** `findOneAndUpdate({tokenHash, revokedAt:null})`; reuse → revoke cả family + audit `TOKEN_REUSE_DETECTED`; refresh **không mở rộng** scope/resource; `/revoke` theo token/family/thiết bị | B4.4 | L | INV-10, 11, 12; §9.5 (strict rotation); test concurrent refresh chỉ sinh 1 hậu duệ; test leo thang scope bị từ chối |
| B4.6 | **`/userinfo`** (Bearer, verify qua JWKS, claims theo scope) · **discovery** đúng §12 (RS256, `code_challenge_methods_supported:["S256"]`, `end_session_endpoint`, thêm `offline_access` nếu D7) · **`/introspect`** (RFC 7662; chỉ client/resource được phép gọi) | B4.4 | M | Discovery khớp thực tế endpoint; introspect trả `active:false` cho token hết hạn/đã revoke |
| B4.7 | **Logout**: `POST /logout` (local), `POST /logout?scope=all` (global: huỷ mọi session + revoke mọi family), `GET /logout` chỉ xác nhận/khởi tạo RP-initiated (`id_token_hint`, `post_logout_redirect_uri` exact), front-channel; back-channel để P2 | B2.3, B4.5 | L | §9.8; test GET không huỷ session; CSRF trên POST bị chặn; global logout revoke đúng phạm vi |

### B5. Federation (spec §13 bước 10; §9.9)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B5.1 | Cấu hình **tĩnh** Google & GitHub (endpoint cứng trong code, secret từ env); GitHub: lấy email **primary & verified** từ API emails, không tin email trong profile | B2.2 | M | INV-23: không có cấu hình provider nhận URL từ người dùng |
| B5.2 | Broker flow: nút social ở trang login → tạo **`state` riêng của IdP** cho leg này → redirect → callback; nối lại `AuthorizeRequestContext` qua `request_id`; xoá context sau khi dùng | B4.1, B5.1 | L | §9.1, §9.9; test state sai/lặp bị từ chối; `state` của RP vẫn được echo nguyên vẹn ở cuối |
| B5.3 | **Account linking an toàn**: email trùng tài khoản local → **bắt đăng nhập tài khoản local** rồi mới ghi `FederatedIdentity`; email provider chưa verified → không link | B5.2, B2.4 | M | INV-22; test không auto-link theo email; audit `ACCOUNT_LINKED` |

### B6. Admin API & seed (spec §9.10–9.11; D2, D3, D5, D6)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B6.1 | **Admin guard**: verify access token `aud=admin resource`, scope `admin.*`, vai trò từ `UserTenant.roles[]`, tenant từ phiên/token (INV-24) | B4.4, B2.1 | M | Token của resource khác bị từ chối; `tenant_admin` không đụng tenant khác |
| B6.2 | **Step-up**: decorator `@RequireRecentAuth(minutes)` đọc `auth_time`; thiếu/quá hạn → `403 step_up_required` (kèm gợi ý `prompt=login&max_age=0`) | B6.1, B4.1 | M | INV-26; áp cho: đổi `redirect_uris`, rotate/tạo secret, đổi `allowedResources`, đổi vai trò admin, rotate key |
| B6.3 | **Endpoint quản trị** + OpenAPI: clients (CRUD, secret create/rotate/revoke — secret chỉ hiện **1 lần**), resources, users (list/lock/unlock/revoke sessions), refresh-token families (list/revoke), consents (list/revoke), **audit log** (lọc + phân trang server-side), keys (xem JWKS, rotate thường/khẩn cấp), tenants (read-only) | B6.2, B3.*, B1.7, B1.9 | L | Mỗi thao tác nhạy cảm sinh audit + qua step-up; response không chứa `secretHash/tokenHash`; OpenAPI sinh đúng |
| B6.4 | **Seed script** idempotent: `default-tenant`; admin user (từ env); resource `admin`, `demo`; client `fe-admin` (confidential, redirect `http://localhost:3000/auth/callback`), client `fe-sso-test` (public, redirect `http://localhost:5173/callback`, CORS origin tương ứng) | B6.3 | M | Chạy 2 lần không nhân đôi dữ liệu; in ra `client_secret` của fe-admin đúng 1 lần |
| B6.5 | **demo-resource** (chỉ dev): `GET /demo/me` verify JWT đầy đủ `iss/aud/exp/sig/scope`; trả claims để test app hiển thị | B4.4 | S | Bật/tắt theo `NODE_ENV`; token aud sai → 401 |

### B7. Hardening & release (spec §13 bước 14–18)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| B7.1 | **Security test suite** theo §14 (đủ nhóm: authorization code, refresh, resource, mix-up/iss, state/nonce, session, enumeration, multi-tenant, admin, cookie); concurrent test dùng nhiều request song song thật | B4.*, B5.*, B6.* | L | Mỗi dòng trong ma trận §14 có ≥1 test tự động; chạy trong CI |
| B7.2 | Observability: Prometheus (`prom-client`: số token phát hành, lỗi `/token`, latency), alert rule cho reuse-detected / key rotation khẩn cấp / tăng lỗi `/token` | B1.7 | M | Dashboard mẫu; alert test bắn được |
| B7.3 | `be/Dockerfile` multi-stage, non-root; compose prod mẫu; hướng dẫn Redis Sentinel/Cluster; **cài KeyProvider thật** (AWS/GCP KMS hoặc Vault — chốt ở mục 12); fallback Redis-down đúng §6.2 (không dùng memory cục bộ) | B1.9 | L | Image chạy; kill Redis → endpoint cần state trả lỗi rõ, không im lặng sai |
| B7.4 | Bảo mật chuỗi cung ứng & cấu hình: `pnpm audit`, SAST, secret scan, kiểm tra security headers, rà toàn bộ log | B7.1 | M | Không lỗ hổng high/critical chưa xử lý |
| B7.5 | Runbook: key nghi bị lộ (rotate khẩn cấp), `TOKEN_REUSE_DETECTED` tăng đột biến, quên/khôi phục admin, backup/restore Mongo | B7.2 | M | Diễn tập runbook 1 lần, ghi kết quả |

---

## 6. Phase A — Admin FE (`fe-admin/`, TanStack Start)

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| A1 | **Scaffold** từ thư mục gốc repo (chạy tương tác nếu không chắc ID add-on):<br>`npx @tanstack/cli@latest create fe-admin --add-ons shadcn,t3env,tanstack-query,tanstack-form,tanstack-table --tailwind --package-manager pnpm`<br>Kiểm tra ID bằng `npx @tanstack/cli@latest create --list-add-ons`; nếu shadcn+tailwind sinh trùng dependency thì dọn lại; **xoá các file `demo.*`**; pin phiên bản (Start đang RC, CLI alpha) | R1 | S | `pnpm dev` chạy ở `:3000`; có Tailwind, shadcn, Query, Form, Table; không còn code demo |
| A2 | **Env validation (T3Env)**: schema server/client tách bạch (mục 1.4), import `env` ở nơi duy nhất; build fail nếu thiếu | A1 | S | Thiếu `OIDC_CLIENT_SECRET` → build/start lỗi rõ; biến server không lọt vào bundle client |
| A3 | **UI foundation**: cài các component shadcn cần (button, input, label, form, table, dialog, alert-dialog, dropdown-menu, select/multi-select, badge, tabs, sonner, skeleton, sidebar/nav), layout (sidebar + header), dark mode, trang lỗi/404/loading, quy ước cấu trúc `routes/`, `features/`, `components/`, `lib/` | A1 | M | Storybook không bắt buộc; có trang `/` placeholder dùng layout; a11y cơ bản (focus, aria) |
| A4 | **Đăng nhập OIDC kiểu BFF** (D2): route `/auth/login` (sinh `state`, `nonce`, PKCE, `resource=admin`, redirect), `/auth/callback` (server: kiểm `state`, kiểm `iss` trong redirect, đổi code bằng client_secret, **validate ID token phía RP**: chữ ký qua JWKS, `iss`, `aud`, `exp`, **`nonce`**), lưu token trong **session cookie mã hoá httpOnly** (chỉ server đọc), refresh tự động ở server, `/auth/logout` (RP-initiated, `id_token_hint`), guard route bằng `beforeLoad`, chặn theo vai trò | B4.4, B6.4 (client `fe-admin`) | L | INV-6 (RP tự validate nonce); token không xuất hiện trong JS/localStorage/DevTools Application; đăng xuất xoá cả session IdP |
| A5 | **API layer**: server functions gọi admin API bằng access token của session; types sinh từ OpenAPI (D11); cấu hình TanStack Query (query key factory, retry, invalidation); xử lý `401` (refresh/đăng nhập lại) và **`403 step_up_required`** (chuyển sang `/auth/login?stepup=1` với `prompt=login&max_age=0`, quay lại đúng thao tác) | A4, B6.3 (dùng MSW mock trước) | M | Có mock chạy độc lập khi BE chưa xong; step-up round-trip không mất dữ liệu form |
| A6.1 | **Clients**: bảng (TanStack Table, phân trang/sort/lọc **phía server**), form tạo/sửa (TanStack Form + zod; editor `redirect_uris`, `postLogoutRedirectUris`, `allowedCorsOrigins` **kiểm exact/absolute URL, cảnh báo wildcard**), chọn `allowedResources`, chọn `clientType`/auth method; dialog hiện `client_secret` **một lần** + rotate (step-up) + revoke | A5, B6.3 | L | Không hiện lại secret sau khi đóng; sửa `redirect_uris` đi qua step-up; lỗi validate hiển thị theo field |
| A6.2 | **Resources**: bảng + form (`identifier` absolute URI, scopes) | A5 | M | Validate `identifier` phía FE trùng quy tắc BE |
| A6.3 | **Users & sessions**: bảng user, chi tiết (federated identities, consents, sessions, refresh families), khoá/mở khoá, revoke session/family/global | A5 | M | Hành động phá huỷ có xác nhận; hiển thị trạng thái `lockedUntil` |
| A6.4 | **Audit log**: bảng lọc theo action/user/client/thời gian, phân trang server, làm nổi `TOKEN_REUSE_DETECTED`; xem chi tiết metadata (đã redact) | A5 | M | Không hiển thị dữ liệu nhạy cảm; export CSV (tuỳ chọn) |
| A6.5 | **Keys**: xem JWKS/`kid`/trạng thái, rotate thường, **rotate khẩn cấp** (xác nhận 2 bước + step-up + cảnh báo hậu quả §6.4) | A5 | M | Có cảnh báo rõ trước khi khẩn cấp; kết quả phản ánh trong danh sách key |
| A6.6 | **Dashboard**: số client/resource/user, sự kiện bảo mật gần đây, trạng thái health BE | A5 | S | Dữ liệu từ API thật |
| A7 | **Hardening FE**: CSP nghiêm, security headers, cookie `HttpOnly/Secure/SameSite`, CSRF cho server functions có side-effect, không log token/secret, chặn clickjacking, kiểm tra lộ biến server vào client bundle | A4 | M | INV-20 áp cho FE; scan bundle không chứa secret |
| A8 | **Test**: unit (Vitest) cho validator/form; component test; e2e Playwright: đăng nhập → tạo client → xem audit → step-up | A6.* | M | Chạy được trong CI với BE + Mongo + Redis dựng sẵn |
| A9 | Dockerfile + cấu hình deploy (Node server của Start) + healthcheck | A8 | S | Image chạy, đọc env đúng |

---

## 7. Phase T — SSO Test FE (`fe-sso-test/`, React + React Router)

Mục tiêu app này: **kiểm chứng IdP từ phía RP** — vừa là demo, vừa là "phòng thí nghiệm" để thử các tình huống tấn công/sai cấu hình.

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| T1 | **Scaffold**: Vite + React + TypeScript + React Router (khuyến nghị chế độ Data Mode `createBrowserRouter`, SPA thuần — không cần SSR); `env.ts` validate bằng zod; Tailwind (tuỳ chọn) | R1 | S | `pnpm dev` ở `:5173`; thiếu env → báo lỗi rõ |
| T2 | **OIDC client viết tay (mỏng)**: fetch discovery; sinh PKCE (`S256` bằng WebCrypto), `state`, `nonce`; redirect tới `/authorize` (kèm `resource`, `scope`); ở callback: **kiểm `state`**, **kiểm `iss` trong redirect**, đổi code (public client, không secret), **validate ID token**: chữ ký qua JWKS (`jose`), `iss`, `aud`, `exp`, **`nonce`**; quản lý token **trong bộ nhớ** (không localStorage); refresh có xử lý rotation; RP-initiated logout | B4.1–B4.4 | L | INV-6; mọi bước validate có test; thay đổi 1 tham số (state/nonce/iss) thì login **thất bại đúng cách** |
| T3 | **Trang & route**: `/` (trạng thái đăng nhập), `/login`, `/callback`, `/profile` (claims ID token), `/tokens` (xem access/ID/refresh metadata, đếm ngược hết hạn), `/api-test`, `/logout`, trang lỗi hiển thị `error`/`error_description` từ IdP; route guard cho trang cần đăng nhập | T2 | M | Điều hướng đúng sau login (giữ trang đích ban đầu) |
| T4 | **Gọi resource thật**: nút gọi `GET /demo/me` (demo-resource) bằng access token; nút gọi kèm token **sai `aud`** (xin token cho resource khác) để thấy bị 401; nút `userinfo` | T3, B6.5, B4.6 | M | Hiển thị pass/fail rõ ràng kèm giải thích INV-8 |
| T5 | **Security lab** (chỉ dev): (a) **Refresh replay** — dùng lại refresh token cũ, kỳ vọng family bị revoke; (b) bảng chỉnh tham số `/authorize` thủ công (đổi `redirect_uri`, `code_challenge_method=plain`, bỏ `nonce`, `resource` lạ, `prompt=none` khi chưa login…) và ghi kết quả IdP trả về; (c) đổi `state` trước callback | T3, B4.5 | M | Mỗi kịch bản có "kết quả mong đợi" và tô xanh/đỏ nếu IdP xử lý đúng/sai |
| T6 | *(Tuỳ chọn)* Chế độ so sánh với thư viện chuẩn `oidc-client-ts` để phát hiện IdP lệch chuẩn (khác cách tự viết ở T2) | T2 | S | Cả 2 client đăng nhập được; ghi lại khác biệt nếu có |
| T7 | **Test**: unit cho PKCE/validator; e2e Playwright (login, consent, refresh, logout, kịch bản lab) | T5 | M | Chạy trong CI cùng BE |

---

## 8. Phase X — Liên module, E2E, phát hành

| ID | Task | Phụ thuộc | Size | Nghiệm thu |
|---|---|---|---|---|
| X1 | **Walking skeleton (M3)**: email/password → `/authorize` → login (UI BE) → `/token` → fe-sso-test hiển thị claims | B4.1–B4.4, T2 | M | Demo được; chạy tự động bằng Playwright 1 kịch bản |
| X2 | **E2E đầy đủ**: consent, refresh rotation, reuse-detect, logout local/global, admin tạo client mới → fe-sso-test dùng client đó đăng nhập, step-up, đổi `redirect_uris` làm test app hỏng đúng cách | M4–M5 | L | Chạy CI ổn định (không flaky) |
| X3 | **Cookie topology matrix** (§9.6): dựng các domain dev (`*.localhost` hoặc `localtest.me`, kèm HTTPS cục bộ nếu cần `Secure`), chạy Playwright trên **Chromium/Firefox/WebKit**: interactive login, logout, POST, fetch; `prompt=none` qua iframe ghi nhận **best-effort** | X2 | M | Bảng kết quả theo (topology × trình duyệt); quyết định cuối về `SameSite` được ghi lại |
| X4 | **Federation E2E** với mock OAuth provider: đăng nhập social mới, email trùng → bắt re-auth (INV-22), state sai/lặp | B5.* | M | Không auto-link; test chạy CI không cần Google/GitHub thật |
| X5 | **Security regression trong CI**: gom suite B7.1 + lab T5 + test FE hardening; chặn merge khi vi phạm INV | B7.1 | M | Mỗi INV có ≥1 test được ánh xạ (mục 9) |
| X6 | **Release checklist**: pentest tự động/thủ công theo OWASP ASVS/OAuth BCP, dependency audit, diễn tập backup/restore + rotate khẩn cấp, review lại danh sách "Việc cần quyết định" đã đóng hết, tài liệu vận hành | B7.*, A9, X5 | M | Checklist ký duyệt; không còn mục P0 mở |

---

## 9. Ma trận truy vết: Invariant → task hiện thực → nơi kiểm chứng

| INV | Nội dung (rút gọn) | Hiện thực | Kiểm chứng |
|---|---|---|---|
| 1, 2 | Code dùng 1 lần, TTL 60s | B4.3 | B7.1 |
| 3 | PKCE S256 bắt buộc | B4.1, B1.5 | B7.1, T5 |
| 4 | `redirect_uri` exact | B3.1, B4.1 | B7.1, T5 |
| 5 | ID token mang `nonce` | B4.4 | B7.1 |
| 6 | **RP** validate `nonce` | T2, A4 | T7, A8 |
| 7 | `aud` ID token = client_id | B4.4 | B7.1, T2 |
| 8 | `aud` access token = resource | B4.4, B6.5 | T4, B7.1 |
| 9 | `iss` đúng + trong redirect | B4.4, B4.6 | T2, T5 |
| 10, 11 | Refresh atomic + reuse → revoke family | B4.5 | B7.1, T5 |
| 12 | Refresh không đổi scope/resource | B4.5 | B7.1 |
| 13 | Consume+bind code | B4.3 | B7.1 |
| 14, 15 | `resource` absolute + allowed; 1 grant = 1 resource | B3.2, B4.1 | B7.1, T5 |
| 16, 17 | Cookie session; ID mới sau login | B2.3 | B7.1, X3 |
| 18 | Secret không plaintext; rotation | B3.1 | B7.1 |
| 19 | Private key không lộ | B1.9, B7.3 | B7.4 |
| 20 | Không log bí mật | B1.3, B1.7, A7 | B7.4 |
| 21 | Public client bắt buộc PKCE | B3.3 | B7.1 |
| 22 | Account linking cần re-auth | B5.3 | X4 |
| 23 | Federation provider tĩnh | B5.1 | B7.1 |
| 24 | Tenant context từ phiên | B2.1, B6.1 | B7.1 (cross-tenant) |
| 25 | Mọi thao tác nhạy cảm có audit | B1.7, B6.3 | B7.1 |
| 26 | Step-up cho thao tác admin | B6.2, A5 | A8, X2 |
| 27 | Chống enumeration | B2.4 | B7.1 |

---

## 10. Definition of Done

**Mỗi task**: (1) code merge qua PR nhỏ, lint + typecheck xanh; (2) test tự động cho hành vi mới (unit + tích hợp; task bảo mật có test **đồng thời/race** khi liên quan); (3) qua `security-reviewer` với các INV được liệt kê ở cột nghiệm thu; (4) không log/hiển thị dữ liệu nhạy cảm; (5) cập nhật `PROGRESS.md` và tài liệu nếu đổi hành vi; (6) không để TODO bảo mật lơ lửng.

**Mỗi milestone**: chạy được bằng `docker compose up -d && pnpm dev:all` trên máy sạch; E2E của milestone xanh; bảng truy vết (mục 9) cập nhật.

---

## 11. Rủi ro & lưu ý

- **Công cụ còn "non-stable"**: TanStack Start (RC) và CLI (alpha) có thể đổi API → pin version, tránh nâng cấp giữa chừng; kiểm tra `--list-add-ons` ngay khi scaffold.
- **Race condition** là lỗi dễ lọt nhất: B4.3, B4.5, B2.4 bắt buộc có test song song thật (nhiều request đồng thời), không chỉ test tuần tự.
- **Cookie dev vs prod**: `Secure` cookie trên `http://localhost` khác nhau giữa trình duyệt (Safari khắt khe) → gom về đúng **một** cờ cấu hình, không rải điều kiện `NODE_ENV` khắp nơi; kiểm chứng thật ở X3.
- **Phụ thuộc chéo lane**: A4 và T2 phụ thuộc BE M3 — dùng mock (MSW) và contract OpenAPI để không chờ; chốt contract sớm ở B6.3.
- **Refresh token với client public + strict rotation**: khi mạng lỗi client có thể phải đăng nhập lại (đã chấp nhận ở §9.5) — T5 và tài liệu phải nói rõ để không bị hiểu là bug.
- **Phạm vi**: back-channel logout, DPoP, MFA, dynamic client registration nằm **ngoài** plan này (P2 của spec).

---

## 12. Việc cần bạn quyết định (chặn task tương ứng)

- [x] **Q1** (chặn B4.2): **ĐÃ CHỐT** — `Consent` key theo **`user × client × resource`** (unique `{userId, clientId, resource}`). Lý do: `Client.tenantId` đã bắt buộc (1 client ⇒ 1 tenant) nên chiều tenant là thừa, không cần đưa vào key; mỗi `/authorize` bind đúng 1 `resource` (INV-14/15, resource indicators) nên consent phải tính theo resource để scope-audience đúng boundary và revoke/version độc lập từng resource. Document (public client không gửi `resource`) dùng sentinel `resource = ""` (chuỗi rỗng) để vẫn 1 index duy nhất.
- [x] **Q2** (chặn B2.5): **ĐÃ CHỐT** — D1: UI login/consent/logout do **BE render**.
- [x] **Q3** (chặn A4): **ĐÃ CHỐT** (người dùng, 2026-10-21) — xác nhận D2: fe-admin là **BFF/confidential client** (BE của fe-admin giữ `client_secret`, trình duyệt chỉ có session cookie).
- [x] **Q4** (chặn B4.4/B6.2): **ĐÃ CHỐT** — xác nhận **D3** (`prompt=login` + `max_age` → re-auth; access token resource `admin` mang claim `auth_time`; API nhạy cảm từ chối `403 step_up_required` nếu `auth_time` quá hạn) và **D7** (cấp refresh token **chỉ khi** client có grant `refresh_token` **VÀ** scope xin gồm `offline_access`; thêm `offline_access` vào `scopes_supported`). Đúng OIDC Core/§offline_access. Ghi chú schema: `Client` hiện **chưa có** trường `grantTypes[]` — B4.4 phải thêm `grantTypes: string[]` (mặc định `['authorization_code']`) trước khi cấp refresh token; không thuộc phạm vi B4.2.
- [x] **Q5** (chặn B7.3): **ĐÃ CHỐT** (người dùng, 2026-10-21) — **HashiCorp Vault Transit** (KeyProvider ký qua Transit, self-host) + **Redis Sentinel self-host**.
- [x] **Q6** (chặn B4.4): **ĐÃ CHỐT** (user ủy quyền analyst/tech-lead tự quyết theo hướng production). Giá trị chốt, đọc từ config/env đã có (`TokenConfig` trong `configuration.ts`, validate `positiveInt` trong `validation.schema.ts`) — **không hard-code**:
  - **`ACCESS_TOKEN_TTL` = 900s (15 phút)**. Lý do: spec §8 khuyến nghị 15' + chốt revocation = self-contained JWT ngắn hạn (độ trễ revoke tối đa = TTL access). Đủ ngắn để giới hạn thiệt hại token rò rỉ, đủ dài để tránh refresh quá dày.
  - **`REFRESH_TOKEN_TTL` = 2592000s (30 ngày)** — là **absolute lifetime** của refresh token (sliding/rotation là B4.5; B4.4 chỉ set `expiresAt = issuedAt + REFRESH_TOKEN_TTL`). Lý do: cân bằng UX "nhớ đăng nhập" với rủi ro token sống lâu; 30 ngày là mặc định production phổ biến cho `offline_access`.
  - **`SESSION_IDLE_TTL` = 28800s (8h)**, **`SESSION_ABSOLUTE_TTL` = 2592000s (30 ngày)** — đã dùng từ B2.4, giữ nguyên; ràng buộc `IDLE <= ABSOLUTE` đã enforce trong validation.schema.ts. **Không thuộc phạm vi B4.4** (chỉ ghi lại để chốt trọn Q6).
  - **Grace period rotate client secret = `CLIENT_SECRET_GRACE_TTL` = 604800s (7 ngày)** — đã default trong validation.schema.ts (C2). Lý do: đủ cho một chu kỳ deploy/rollout rotate secret an toàn mà không gián đoạn client. **Không thuộc phạm vi B4.4.**
  - **Lưu ý B4.4**: chỉ `ACCESS_TOKEN_TTL` và `REFRESH_TOKEN_TTL` (khi cấp refresh theo D7) được B4.4 tiêu thụ. ID token TTL **= `ACCESS_TOKEN_TTL`** (OIDC cho phép; tránh thêm config thừa). Không thêm env mới trong B4.4 — tất cả env trên đã tồn tại.
- [x] **Q7**: **ĐÃ CHỐT** (2026-11-06, orchestrator — người dùng ủy quyền tự quyết theo tiêu chí dùng được cho production) — `identifier` resource = **URI tuyệt đối `https://` của API** ở từng môi trường (vd. `https://api.<domain>/`), cấu hình qua seed/admin, không hard-code. Lý do: RFC 8707 yêu cầu URI tuyệt đối; dạng https trùng giá trị API tự kiểm `aud`, dễ vận hành hơn URN. Dev/test giữ giá trị hiện có.
- [x] **Q8**: **ĐÃ CHỐT** (2026-11-06, orchestrator, ủy quyền) — chưa có domain thật ⇒ X3 kiểm **topology**, không kiểm tên: IdP và app cùng registrable domain (same-site, subdomain khác nhau) + ít nhất 1 app khác site (cross-site), domain dev qua `*.localtest.me`/`*.localhost` + HTTPS cục bộ khi cần `Secure`; domain thật cắm qua env lúc triển khai. DEBT-008 (`__Host-` khi `Secure`) làm cùng X3.
- [x] **Q9**: **ĐÃ CHỐT** (2026-11-06, orchestrator, ủy quyền) — tên sản phẩm **Veyrigate** (tên repo). Package name nội bộ giữ `sso-idp`/`@sso-idp/*` (không lộ ra người dùng; đổi chỉ gây churn). `ISSUER` là cấu hình theo môi trường triển khai (không có giá trị mặc định production). Tên hiển thị/branding mới (nếu có) dùng "Veyrigate".

### Chốt bổ sung 2026-11-06 (orchestrator — người dùng ủy quyền tự quyết theo tiêu chí dùng được cho production)

- **Q58.1 / DEBT-214** — refresh grant **kiểm consent hiện hành**: nếu consent của (user, client, resource) không còn hoặc `policyVersion`/`termsVersion` thấp hơn bản bắt buộc ⇒ `invalid_grant` + revoke family (client phải chạy lại `/authorize` để đồng ý lại). Lý do: đổi điều khoản phải có đồng ý mới mới hợp lệ về pháp lý; tốn một lần đăng nhập lại là chấp nhận được.
- **DEBT-149** — `PATCH /admin/users/:id/roles` **chỉ thay các vai trò do admin quản lý** (`tenant_admin`, `super_admin`); vai trò khác đang lưu được giữ nguyên. Lý do: không làm mất dữ liệu ngoài phạm vi API.
- **DEBT-142** — mọi thao tác giáng/vô hiệu super_admin dùng **cập nhật có điều kiện nguyên tử** bảo đảm còn ≥ 1 super_admin active; vi phạm ⇒ 409. Lý do: không bao giờ được mất quyền quản trị toàn hệ thống.
- **DEBT-415** — refresh khi resource của family đã bị gỡ khỏi `allowedResources` ⇒ `invalid_grant` **và revoke family** (đồng nhất nhánh race DEBT-216).
- **DEBT-344** — audit: thời hạn lưu cấu hình `AUDIT_RETENTION_DAYS` (mặc định 180 ngày, TTL index); `ip`/`userAgent` chỉ super_admin xem đầy đủ, tenant admin thấy IP đã che (IPv4 /24, IPv6 /48) và không thấy userAgent. Lý do: tối thiểu hoá dữ liệu cá nhân nhưng vẫn đủ điều tra sự cố.
- **DEBT-405** — `ops/compose/prod.example.yml`: dịch vụ có `read_only` + `cap_drop: [ALL]` phải chạy non-root với `user:` tường minh và entrypoint không cần quyền root; chứng minh bằng smoke compose cục bộ tên riêng (không đụng `aegate-*`).
- **Q62.1 / DEBT-466** — bật **Dependabot** (`.github/dependabot.yml`: npm, docker, github-actions; hằng tuần; nhóm minor/patch; `cooldown` ≥ 14 ngày theo quy tắc hiện hành, bản sửa bảo mật không chờ). Có hiệu lực khi người dùng push.
- **DEBT-321** (chốt 2026-11-07) — khi `/authorize`/`/token` có `resource`, scope được cấp = giao của scope xin với `Client.scopes` **và** `Resource.scopes` của resource đó (scope OIDC chuẩn `openid`/`profile`/`email`/`offline_access` không thuộc resource, chỉ so với `Client.scopes`); scope ngoài giao ⇒ `invalid_scope` như hiện hành. Lý do: trường `Resource.scopes` hiển thị trong admin phải được thực thi, nếu không là cấu hình giả.
- **DEBT-512** (chốt 2026-11-07) — refresh grant **thu hẹp** scope của token mới về giao hiện hành (scope family ∩ `Client.scopes` ∩ `Resource.scopes` theo quy tắc DEBT-321); KHÔNG revoke family chỉ vì admin bỏ bớt scope (tránh đăng xuất hàng loạt khi chỉnh cấu hình). Nếu giao còn rỗng (không còn scope nào của resource) ⇒ `invalid_grant` + revoke family như DEBT-415. Lý do: thu hồi quyền có hiệu lực ở lần refresh kế tiếp (≤ TTL access 15 phút) mà không phá phiên hợp lệ.
- **Run 84 (X6 đợt 1, chốt 2026-11-11, tech-lead — ủy quyền)**: chi tiết + lý do ở `runs/84-X6-release1/tasks.md` / `review-techlead.md`.
  - **D84.1 (DEBT-550/556) ngữ pháp email đầu vào**: địa chỉ được nhận ở mọi đường **có thể dẫn tới gửi thư hoặc tạo/gắn tài khoản** = `local@domain` ASCII, đúng 1 `@`:
    - local: 1–64 ký tự trong `[A-Za-z0-9._+'-]`, không bắt đầu/kết thúc bằng `.`, không `..`. Cố ý hẹp hơn atext RFC 5322: loại `"`, `(`, `)`, `<`, `>`, `,`, `;`, `:`, `\`, `[`, `]`, `@` thứ hai, khoảng trắng, C0/DEL (lớp lỗi addressparser, run 83) **và** `%`, `!` (định tuyến relay kiểu `user%host@relay` / UUCP — cùng lớp "thư đi nơi khác chuỗi đã lưu"), cùng `#`, `$`, `&`, `*`, `/`, `=`, `?`, `^`, dấu backtick, `{`, `|`, `}`, `~` (gần như không dùng thật, thu hẹp bề mặt parser).
    - domain: ≥ 2 nhãn LDH, mỗi nhãn 1–63 ký tự `[A-Za-z0-9-]` không bắt đầu/kết thúc bằng `-`, nhãn cuối bắt đầu bằng chữ cái (loại `a@1.2.3.4`), tổng domain ≤ 253, không IP literal `[...]`, không dấu chấm cuối; IDN chỉ nhận dạng A-label `xn--` (U-label và SMTPUTF8 bị từ chối ⇒ DEBT-560).
    - tổng ≤ 254. Không trim/không sửa chuỗi: chuỗi thô phải khớp (sau đó `normalizeEmail` như cũ).
    - Áp ở: `RegisterDto`, `EmailDto` (`/forgot`), email provider ở nhánh **tạo/gắn mới** của federation, và **sink** `SmtpMailer.send` (phòng thủ chiều sâu). **KHÔNG** áp cho `LoginDto` (không gửi thư; tài khoản cũ có địa chỉ ngoài ngữ pháp vẫn đăng nhập được) và filter tìm kiếm admin (`admin.dto.ts:241`, không gửi thư). Không có route đổi email (`UserService.changeEmail` chỉ test gọi) ⇒ không áp.
    - Giữ `@IsEmail()` cạnh decorator mới (giao hai luật, không bao giờ nới).
  - **D84.2 (DEBT-157) cache HTTP của `/jwks.json`**: `Cache-Control: no-cache` trên 200 (GET và HEAD), giữ `Vary: Origin`; lỗi giữ `no-store` như hiện tại. Không `max-age` (run 80 đã loại 300): mọi lần RP/CDN refetch đều thấy JWKS hiện hành ⇒ emergency rotate có hiệu lực ngay ở tầng HTTP, rotate thường không có cửa sổ "kid lạ" do cache trung gian. Chi phí: mỗi refetch tới origin (LocalKeyProvider đọc file, Vault có cache metadata 30 s) — chấp nhận ở quy mô này. Cache trong process của RP là trách nhiệm RP ⇒ runbook nêu yêu cầu.
  - **D84.3 (DEBT-349) fe-admin `createRemoteJWKSet`**: **không đổi code**, đóng DEBT-349 dạng chấp nhận. Lý do: tập JWKS này chỉ verify ID token nhận qua back-channel `/token` (client đã xác thực, TLS tới chính IdP); sau emergency rotate IdP không trả token ký bằng key đã gỡ, kẻ giữ key lộ không chèn được token vào kênh này; `cooldownDuration: 0` đã xử lý kid mới. Không cần restart fe-admin sau emergency rotate (ghi vào runbook).
  - **D84.4 (DEBT-393) pre-publish cho rotate thường**: **làm**, ở đợt 2 (run 85). Hợp đồng sơ bộ (fold run 85 chốt chi tiết): rotate `normal` đăng key mới vào JWKS ngay, trạng thái `pending` + `activatesAt = createdAt + KEY_PREPUBLISH_SEC`; key hiện tại vẫn ký tới `activatesAt`, sau đó thành `retiring` tới `activatesAt + ACCESS_TOKEN_TTL`; `emergency` bỏ qua pre-publish và gỡ cả key `pending`; `KEY_PREPUBLISH_SEC` mặc định 3600, khoảng 0–86400 (0 = hành vi hiện tại); Vault suy ra từ `creation_time` của version (không thêm state), Local lưu trong `keys.json`; `KeyMetadata.status` thêm `pending` ⇒ đổi admin DTO + schema/UI fe-admin.
  - **D84.5 (DEBT-129)**: chỉ runbook (fail-closed hiện tại đúng, run 79; fe-admin đã hiện `UNCERTAIN_ISSUE`). Nội dung ở T3.
  - **D84.6 người viết checklist**: **tester** (lane QA), không phải tech-lead. Lý do: bằng chứng phải được kiểm bằng `grep -F` như `security-matrix.md` (chạy lệnh, không chỉ đọc), và người duyệt (tech-lead/senior) không nên tự viết thứ mình ký. Tech-lead cố định danh mục (T4) để tester không tự mở rộng phạm vi.
  - **D84.7 chuẩn đối chiếu**: OAuth 2.0 Security BCP **RFC 9700** (§2, §4); **OIDC Core 1.0** (+ Discovery 1.0, RP-Initiated Logout 1.0); RFC 8707, 9207, 7009, 7662, 6749 §3.3; **OWASP ASVS 5.0.0 mức L2** (bản hiện hành, có chương V10 OAuth/OIDC đúng cho IdP — thay cách đánh số ASVS 4 ở phần ứng viên). **P0** = ❌ ở một MUST/SHALL của RFC 9700/OIDC Core cho tính năng đang phát hành, vi phạm một INV (spec §15), hoặc yêu cầu ASVS L1 ⇒ chặn phát hành.
  - **D85.1 Chia lô**: run 85 = T1–T6 dưới (P0: mongoose + supply chain, 571/584, 574, 575, 573; T6 QA). Run 86 (X6 đợt 2b) = DEBT-577 (P0, fragment), DEBT-393 [BE] + [FE] (D85.7), DEBT-572 (P1), DEBT-583 (P2), gate. Lý do: 577 và 393 không phụ thuộc lô này, 393 cần lane FE; gộp vào thì lô vượt 6 task. Run 87 = đợt 3 (diễn tập), run 88 = đợt 4 (pentest + ký). Phát hành vẫn bị chặn tới khi 577 xong (run 86), đúng định nghĩa P0.
  - **D85.2 Chống khoá có chủ đích (DEBT-575, đóng DEBT-016)**: chọn **throttle theo (tài khoản, mạng) + device cookie tin cậy** (mẫu "device cookies" của OWASP), **bỏ khoá cứng theo tài khoản**; không CAPTCHA, không gọi ngoài.
    - Loại *progressive delay*: giữ kết nối mở (khuếch đại DoS lên IdP), và nếu khoá theo tài khoản thì vẫn làm chậm chính nạn nhân.
    - Loại *chỉ (account, IP)*: botnet N mạng được 5N lần đoán mỗi 15' vào một tài khoản ⇒ cần trần theo tài khoản; trần đó chỉ không khoá nạn nhân khi nạn nhân có đường tin cậy (device cookie).
    - Hằng số (không thêm env, ghi trong tài liệu): mạng = IPv4 /32, IPv6 /64 (IPv4-mapped ⇒ IPv4); cửa sổ 900 s; **N = 5** lần thử/(email, mạng) cho thiết bị chưa tin cậy; **A = 20** lần thử/email cộng mọi thiết bị chưa tin cậy; **D = 10** lần thử/(email, device cookie) cho thiết bị tin cậy, không chịu N và A. Hợp đồng ở T4.
  - **D85.3 DEBT-577: SỬA (không chấp nhận ⚠), ở run 86**, bằng token trong **fragment**: link `…/reset#token=…`, `…/verify-email#token=…`; trang đọc fragment bằng script ngoài `/assets/token-fragment.js`, điền ô ẩn, `history.replaceState` xoá fragment; POST mang token trong body như hiện tại.
    - Không chọn "POST-only": link email bắt buộc là điều hướng GET, nên token vẫn phải nằm trong URL, hoặc người dùng tự gõ mã.
    - Lý do theo ASVS 5.0 14.2.1 (URL và query string không được chứa thông tin nhạy cảm): token reset tương đương mật khẩu trong 30' (chiếm được tài khoản). Query rơi vào access log của reverse proxy/CDN/WAF và vào lịch sử/đồng bộ trình duyệt, nằm ngoài tầm kiểm soát của IdP. Các giảm thiểu hiện có (một lần, TTL, `no-referrer`, logger cắt query) đều dựa vào người vận hành. Fragment không bao giờ gửi lên server hay vào Referer. Chi phí thấp (1 script, 2 template, link builder), và chưa phát hành nên không cần giữ `?token=`.
    - Không có JS: ô "Mã trong email" hiện ra (`<noscript>`), thư in mã dưới link.
  - **D85.4 DEBT-574 nguồn danh sách**: SecLists (giấy phép **MIT**, theo `api.github.com/repos/danielmiessler/SecLists/license`) commit `64b41f2156e1ae3edb592535c1b4b4dd0d6fe26a`, file `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (835 538 byte, git blob `38eb37702244f55fda75cab281eb2145cd7685b6`; gốc là danh sách NCSC UK lấy từ HIBP Pwned Passwords, ghi công CC BY 4.0 trong NOTICE).
    - Dẫn xuất: NFKC + lowercase, giữ dòng dài 8–128 (khớp chính sách), bỏ trùng giữ thứ hạng đầu, lấy **10 000** dòng đầu (ASVS 6.2.4 cần ≥ 3000, dư 3 lần; khoảng 100 KB).
    - Nhúng tại `be/src/modules/authentication/password-policy/common-passwords.txt`, đưa vào build qua assets của `nest-cli.json`; nạp một lần lúc khởi động; thiếu, hỏng hoặc < 3000 dòng ⇒ **không khởi động** (fail-closed). File thô không commit.
    - Kèm từ ngữ cảnh (6.2.11): `veyrigate`, `sso-idp`, `ssoidp`, phần local của email (≥ 4 ký tự) và cả email.
    - 6.2.12 (kiểm "đã lộ" qua dịch vụ) **không làm** vì cấm gọi ngoài ⇒ ⚠ có lý do, DEBT-587.
  - **D85.5 DEBT-576**:
    - SBOM = `pnpm sbom` sẵn có (CycloneDX 1.7, `--prod --lockfile-only`, mỗi gói deploy một file); job CI `sbom` upload artifact giữ 90 ngày; không thêm dependency.
    - Thêm workflow `audit.yml` chạy `pnpm audit --audit-level high` **hằng ngày**. Lý do: advisory mongoose ra giữa hai lần push, chỉ lộ ra ở push sau.
    - Chính sách thời hạn khắc phục, ghi tại `runbook-deploy.md` §14, tính từ lần phát hiện đầu tiên (CI, audit định kỳ hoặc Dependabot):

      | Mức | Chạy ở production (dependency prod của be/fe-admin, base image, image compose prod) | Chỉ dev/CI |
      |---|---|---|
      | Critical | ≤ 72 h | ≤ 7 ngày |
      | High | ≤ 7 ngày | ≤ 30 ngày |
      | Moderate | ≤ 30 ngày | ≤ 90 ngày |
      | Low | ≤ 180 ngày hoặc lô dependency kế tiếp | như cột trái |

    - Không có bản vá ⇒ ghi ngoại lệ vào `auditConfig.ignoreGhsas` (lý do, khả năng chạm tới, hạn xem lại ≤ 90 ngày) và dismiss cảnh báo Dependabot cùng lý do. Bản vá bảo mật bỏ qua cooldown 14 ngày (quy tắc hiện hành), có ghi ngoại lệ. Cập nhật thường: Dependabot hằng tuần, merge trong ≤ 30 ngày sau cooldown; nâng major theo kế hoạch.
  - **D85.6 DEBT-573 đổi mật khẩu**: `GET/POST /account/password`, có CSRF (identity = cookie phiên), cần phiên sống, cần mật khẩu hiện tại + mật khẩu mới. Limiter chung + bucket lỗi riêng 5/900 s theo user (reserve trước Argon2), chính sách D85.4. Ghi bằng compare-and-set trên hash cũ, rồi gọi `revokeAllUserCredentials` (huỷ **mọi** phiên kể cả phiên hiện tại, mọi refresh family, mọi device cookie tin cậy) ⇒ người dùng đăng nhập lại bằng mật khẩu mới.
    - Chọn đăng xuất cả phiên hiện tại vì dùng lại đúng đường reset đã được kiểm (INV-11/28, DEBT-050/055): không thêm logic "trừ phiên hiện tại", không có race khoá admin giữa lúc revoke và lúc tạo phiên mới. Giá phải trả: 1 lần đăng nhập lại.
    - Gửi thư thông báo (không có link token) khi đổi **và** khi reset. Audit `AUTH_PASSWORD_CHANGED`.
  - **D85.7 DEBT-393 pre-publish (run 86)** — chốt hợp đồng D84.4:
    - Trạng thái suy ra theo thời gian, không có tiến trình nền ghi state. `activatesAt(v) = createdAt(v) + KEY_PREPUBLISH_SEC` với mọi version tạo bởi rotate `normal`. Version "sàn" (Vault `floor`; ở Local là phần tử duy nhất sau emergency hoặc init) có `activatesAt = createdAt`.
    - **active** = version mới nhất có `activatesAt ≤ now`, nếu không có thì là version sàn. Version mới hơn active là **pending** (có trong JWKS, không ký). Version cũ hơn active là **retiring** tới `activatesAt(version kế tiếp) + ACCESS_TOKEN_TTL` (+ `KEY_CACHE_TTL_MS` ở Vault như hiện tại), sau đó rời JWKS.
    - `KEY_PREPUBLISH_SEC`: env mới, số nguyên 0–86400, mặc định **3600**; 0 = hành vi hiện tại. Runbook ghi: giá trị phải ≥ thời gian cache JWKS dài nhất của RP (runbook-ops §1 yêu cầu RP ≤ 10').
    - Rotate `normal` khi đang có version pending ⇒ **409** `{"error":"rotation_pending"}`, không rotate, audit `SIGNING_KEY_ROTATED` failure `reason:'rotation_pending'`. Emergency luôn được phép: key mới active ngay, gỡ mọi version cũ **kể cả pending** (Vault: `min_decryption_version = n` như hiện tại; Local: `next = [fresh]`).
    - Vault: ký qua `transit/sign/<key>` với tham số `key_version` = version active, suy ra từ `creation_time` (không thêm state). Local: mỗi phần tử `keys.json` thêm `activatesAt` (ISO); phần tử cũ không có trường này ⇒ coi `activatesAt = createdAt`. Chỉ `init`/`rotate` ghi file (DEBT-145); trạng thái đọc ra là giá trị suy ra.
    - Admin API: item của `GET /admin/keys` là `{kid, alg, status: 'pending'|'active'|'retiring', createdAt, activatesAt, retireAt}` (thêm `activatesAt`, ISO); `POST /admin/keys/rotate` trả thêm `activatesAt` của `newKid`; sinh lại OpenAPI và `fe-admin/src/server/admin-api/schema.d.ts`.
    - fe-admin: zod `status` thêm `pending`, `activatesAt` bắt buộc; nhãn `pending: "Pending — published, signs from <thời điểm>"`; thứ tự active → pending → retiring; dashboard đếm pending riêng; hộp xác nhận rotate normal nói rõ key mới bắt đầu ký sau `KEY_PREPUBLISH_SEC`; 409 `rotation_pending` ⇒ thông điệp cố định, không retry; mutation có kết quả không chắc chắn giữ mẫu `UNCERTAIN_*` hiện có.
  - **D85.8 DEBT-553/557**: pin **mọi** `uses:` theo commit đã peel, kèm comment `# vX.Y.Z`. Nâng lên major mới nhất có bản phát hành ≥ 14 ngày, vì v4 của `checkout`/`setup-node`/`cache`/`upload-artifact` chạy Node 20, đã hết hạn.
    - Đã đọc release note v5–v7. Thay đổi phá vỡ chỉ gồm: Node 24 + runner ≥ 2.327.1 (runner GitHub-hosted đáp ứng); setup-node v6 chỉ tự cache cho npm (ta dùng pnpm + cache tay); checkout v7 chặn checkout fork PR cho `pull_request_target`/`workflow_run` (ta không dùng hai trigger này).
    - **codeql-action lên v4** (v3 ngừng hỗ trợ 12/2026, DEBT-231): `v4.39.3` cùng đợt phát hành với `v3.39.3` đang dùng (run 83 đã nhận ngoại lệ 14 ngày cho đợt này) ⇒ không phải mã mới.
    - Image Docker trong workflow (`redis:7`, `mongo:7`, `mailpit`) chỉ dùng cho test ⇒ pin digest để sau (DEBT-590).
  - **D85.9 DEBT-571/584**: có `request` hoặc `request_uri` (kể cả rỗng hay lặp) ⇒ redirect lỗi sau khi redirect_uri đã được tin; discovery khai `request_parameter_supported: false`, `request_uri_parameter_supported: false`. `POST /userinfo` dùng chung handler với GET; token **chỉ** lấy từ header `Authorization: Bearer` (form body theo RFC 6750 §2.2 là tuỳ chọn; giữ bất biến "không bao giờ lấy từ query/body"); body bị bỏ qua.
  - **D85.10 Chốt P-level**: DEBT-572 P1 ⇒ run 86; DEBT-583 P2 ⇒ run 86 (rẻ); C-6.2c: 6.2.11 ✅ sau T3, 6.2.12 ⚠ (D85.4). Các dòng P1/P2 khác ở phần E giữ phân loại của tester (run 84).
  - **D85.11 Xoay device token (sửa D85.2)** — amends D85.2, decided by orchestrator under the user's production-readiness delegation; senior finding 1 (DEBT-596): mỗi lần đăng nhập mật khẩu thành công luôn cấp token thiết bị **mới** bằng `generateToken()`, không bao giờ dùng lại giá trị cookie gửi lên (chống cookie fixation ở chế độ không `__Host-`, và cookie từng lộ không được tin cậy lại sau reset); có cookie gửi lên thì `ZREM` hash cũ trong cùng `MULTI` với `ZADD`. Kèm DEBT-597: có cookie đúng dạng thì luôn `ZSCORE` (khoá `userId` hoặc `absent:` + sha256(email) cho email không tồn tại).
  - **D86.1 (T1, sửa chữ D85.3) Một field mã duy nhất**: `reset.eta`/`verify.eta` có đúng **một** `<input name="token" id="token">`, mặc định hiện ra:
    - Bọc trong `<label id="token-manual">Code from the email …</label>`.
    - Thuộc tính: `required`, `maxlength="43"`, `pattern="[A-Za-z0-9_-]{43}"`, `autocomplete="one-time-code"`, `spellcheck="false"`, `value=""`.
    - Script điền giá trị rồi đặt `hidden` cho label (field trong phần tử `hidden` vẫn được submit).
    - Không dùng `<noscript>`, vì nó gây trùng field (xem phát hiện).
    - Fragment sai hoặc thiếu ⇒ field vẫn hiện để nhập tay.
    - Thẻ `<script src="/assets/token-fragment.js"></script>` đặt cuối form, không `async`/`defer`, CSP không đổi.
    - `TokenDto.token`: thêm trim (`@Transform`) cho mã dán tay. Không thêm `@Matches`: sai mã ⇒ vẫn đi đường lỗi hiện có, không lộ thêm oracle.
  - **D86.2 (T1) Script** `be/src/public/token-fragment.js`: IIFE ES5, không phụ thuộc gì.
    - `var m = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash)`. Khớp ⇒ `field.value = m[1]` (chỉ dùng `.value`, không `innerHTML`) và `label.hidden = true`.
    - Khi `location.hash` bắt đầu bằng `#token=` (kể cả sai dạng) ⇒ luôn gọi `history.replaceState(null, '', location.pathname)`.
  - **D86.3 (T1) Thư và link**:
    - `link.hash = 'token=' + token`, không còn `searchParams`.
    - `verifyEmailMessage`/`resetPasswordMessage` nhận thêm `code`. Text thêm dòng `If the link does not open the form, enter this code on the page: <code>`, HTML thêm `<p>…<code>${escapeHtml(code)}</code></p>`.
    - GET bỏ hẳn `@Query('token')`: không đọc, không render, không redirect. Redirect để xoá query vô ích vì query đã vào log proxy.
    - Link `?token=` gửi trước khi deploy ⇒ trang hiện field trống ⇒ người dùng xin link mới (TTL ngắn; chưa phát hành).
  - **D86.4 (T4) POST `/logout` không có khoá `_csrf`** trong body (dù có tham số RP hay không):
    - Render **đúng trang xác nhận của GET**: 200, `Cache-Control: no-store`, cùng nới `form-action` theo origin đã kiểm, cùng quy tắc chỉ phản chiếu `post_logout_redirect_uri` khi hợp lệ.
    - Không `sessions.get`, không revoke, không xoá cookie, không audit.
    - Có khoá `_csrf` (kể cả chuỗi rỗng) ⇒ kiểm như hiện tại; sai ⇒ 403, không đổi state.
    - Tách helper `renderLogoutConfirm(req, reply, params)` dùng chung cho GET và POST.
  - **D86.5 (T4) Bỏ `@UseGuards(CsrfGuard)` trên `POST /logout`**, kiểm trong handler (hoặc một `LogoutCsrfGuard` riêng) **trước** mọi thao tác session.
  - **D86.6 (T4) CSRF hai identity, chỉ cho `POST /logout`**: `_csrf` hợp lệ khi bằng HMAC của cookie phiên đã gửi, **hoặc** HMAC của cookie CSRF ẩn danh (`csrfCookieName(secure)`) đã gửi và không rỗng.
    - Lý do: trang xác nhận render từ POST cross-site không thấy cookie phiên `Lax`.
    - Kẻ tấn công không đọc được cookie nào trong hai cookie đó (httpOnly, `__Host-` ở chế độ secure), và cũng không có secret HMAC ⇒ không giả được.
    - Rủi ro còn lại chỉ ở chế độ không secure (cookie tossing từ subdomain anh em, giống mọi form ẩn danh hiện có) và hậu quả chỉ là bị đăng xuất.
    - Các form khác giữ `CsrfGuard` một identity.
  - **D86.7 (T4) `LogoutDto`** thêm `logout_hint` (`@IsOptional @IsString @Length(0, 4096)`) và `ui_locales` (`@Length(0, 256)`). Cả hai được chấp nhận rồi **bỏ qua**: không phản chiếu, không log.
  - **D86.8 (T2, sửa chữ D85.7) Hình 409**: `409 {"error":"conflict","error_description":"A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation."}` (câu cố định, không thời gian, không kid; dùng `AdminAuthError.conflict` sẵn có).
    - Audit `SIGNING_KEY_ROTATED` `result:'failure'` `reason:'rotation_pending'` `metadata:{mode:'normal', pendingKid}`, ghi best-effort: audit lỗi vẫn trả 409.
    - Lý do: cả Admin API chỉ dùng một mã 409 (`conflict`) và BFF đã map sẵn ⇒ không thêm `AdminApiErrorCode`, không đổi BFF.
    - Mã nghiệp vụ `rotation_pending` nằm ở audit và OpenAPI description.
  - **D86.9 (T2) Local `keys.json`**:
    - Mỗi phần tử có `{kid, publicJwk, createdAt, activatesAt?, retireAt?}`.
    - Rotate normal ghi `fresh.activatesAt = now + prepublishSec`, và ghi cho active trước đó `retireAt = fresh.activatesAt + retainSec`.
    - Emergency/init ghi `activatesAt = createdAt`.
    - **Không ghi `status` nữa; đọc thì bỏ qua `status`.**
    - Suy ra theo thứ tự mảng (thứ tự tạo): **active** = phần tử cuối có `activatesAt ≤ now`, không có thì phần tử đầu; sau active là **pending**; trước active là **retiring** khi `retireAt > now`, thiếu `retireAt` thì coi như đã rời JWKS.
    - Phần tử cũ không có `activatesAt` ⇒ `activatesAt = createdAt`; `retireAt` cũ được giữ.
    - PEM: rotate normal **không** xoá PEM của active hiện tại (nó còn ký tới `fresh.activatesAt`). Mỗi rotate xoá best-effort PEM của mọi phần tử đang là retiring, rồi prune phần tử hết hạn như hiện tại. Emergency xoá mọi PEM cũ như hiện tại.
    - `init` chỉ tạo key khi không còn phần tử live (không dựa vào `status`).
    - Constructor `new LocalKeyProvider(dir, opts?: { prepublishSec?: number; now?: () => number })`, mặc định `prepublishSec: 0`, `now: Date.now`. `KeysModule` luôn truyền giá trị config.
    - 409 kiểm **trong mutex** ⇒ hai rotate normal đồng thời cho đúng một 200 và một 409.
  - **D86.10 (T2) Vault**:
    - `VaultProviderDeps` thêm `prepublishSec` (mặc định 0; `KeysModule` truyền config).
    - `activatesAt(v) = v === floor ? createdAt : createdAt + prepublishSec*1000`.
    - Active = version lớn nhất ≥ floor có `activatesAt ≤ now()`, tính ở **mỗi** lần ký từ key set đã cache. Cache 30 s không làm trễ kích hoạt, vì version pending đã nằm trong cache từ lâu trước đó.
    - `signWith` dùng `key_version = active.version`. `signOnce` retry khi active version đổi (không còn so `latest`).
    - `live()`: version > active ⇒ pending (`retireAt null`); version < active và ≥ floor ⇒ retiring tới `activatesAt(v+1) + ttl + KEY_CACHE_TTL_MS`.
    - Rotate normal: `refresh(true)`, có pending ⇒ ném `RotationPendingError`, không gọi Vault.
    - Hai instance rotate cùng lúc có thể tạo hai version pending (Vault tuần tự hoá `rotate`, không tuần tự hoá phần kiểm của ta). Cả hai đều nằm trong JWKS, không gây hại ⇒ chấp nhận, ghi runbook (DEBT-603).
  - **D86.11 (T2) Hợp đồng chung**:
    - `KeyMetadata` thêm `activatesAt: string` và `status: 'pending'|'active'|'retiring'`; `retireAt` của pending/active là `null`.
    - `RotationResult` thêm `activatesAt`; emergency thì bằng `createdAt`.
    - `RotationPendingError {pendingKid, activatesAt}` đặt ở `key-provider.ts`.
    - Config: `KEY_PREPUBLISH_SEC` nằm trong `KeysConfig.prepublishSec`, validation số nguyên `0..86400`, mặc định `3600`, mọi môi trường. Không ép mức tối thiểu ở production; runbook bắt buộc ≥ 600.
  - **D86.12 (T2) Env test**:
    - `be/test/full-app.ts` đặt `KEY_PREPUBLISH_SEC: '0'` (giữ hợp đồng của các int cũ, có comment).
    - Spec mới `run86-key-prepublish.int-spec.ts` dùng 3600 và đồng hồ điều khiển được.
    - `e2e/config/env.ts` đặt `KEY_PREPUBLISH_SEC: "20"`. Spec E2E keys chờ không còn pending lúc bắt đầu (poll ≤ 40 s, vì lần chạy trước có thể bị ngắt), rồi rotate, thấy hàng Pending, thử rotate lần hai ⇒ thông điệp 409, poll tới khi K2 Active (≤ 40 s), rồi context B đăng nhập như hiện tại (vẫn kiểm refetch JWKS của DEBT-349).
  - **D86.13 (T3) fe-admin**:
    - Zod: `status` thêm `pending`, `activatesAt: z.string()` bắt buộc ở cả item lẫn kết quả rotate.
    - Nhãn: `pending: "Pending — published, signs from <activatesAt>"`.
    - Thứ tự: active → pending (theo `activatesAt` tăng) → retiring (theo `retireAt` tăng).
    - Nút "Rotate key" (normal) bị **disabled** khi có pending, kèm câu giải thích. 409 vẫn được xử lý cho trường hợp race: `BY_CODE.conflict` = câu cố định, không retry.
    - Text sau rotate normal: `Rotated. New key <newKid> is published and signs from <activatesAt>. <oldKid> keeps signing until then, then is verification only.`
    - `uncertainText` cho normal dựa vào **tập kid** trước lúc xác nhận: "if the list now has a key that was not there before (pending or active), the rotation was applied — do not rotate again". Emergency giữ câu so kid active.
    - Hộp xác nhận normal: "The new key is published at once and starts signing after the pre-publish delay (KEY_PREPUBLISH_SEC, default 1 hour). Until then the current key keeps signing."
    - Dashboard: thêm dòng "Pending keys".
  - **D86.14 (T5) `networkOf`**:
    - Giữ cổng `isIP(raw)` của Node trước: `ipaddr.parse` nhận cả dạng `127.1`, hex hay octal mà `req.ip` không bao giờ có.
    - Bỏ `%zone`, rồi `ipaddr.process(raw)`. IPv4 ⇒ `toString()`. IPv6 ⇒ `toFixedLengthString().split(':').slice(0,4).join(':')`.
    - Lý do giữ đúng định dạng 4 nhóm đệm 0 như hiện nay: key bucket Redis giữ nguyên byte, deploy không reset đếm.
    - Không dùng `toNormalizedString()` như backlog gợi ý, vì nó bỏ đệm 0 ⇒ key đổi.
  - **D86.15 (T5) CSP**: `baseUri: ["'none'"]` trong helmet (`bootstrap.ts`) **và** `['base-uri', "'none'"]` trong `csp.ts`. Vị trí directive giữ nguyên (thứ tự mặc định helmet), test byte-identity sẽ chứng minh.
  - **D87.1 Lô**: thứ tự như trên, gói trong một run.
  - **D87.2 Cơ chế**
    - Dump logic toàn bộ DB app **mỗi giờ**, phút :17 UTC: `mongodump --archive --gzip --db=<db>`, đọc từ secondary (`readPreference=secondary` trong config).
    - Binary: image `mongo:7.0.43@sha256:1f995ad…` (cùng major với server, đã pin ở smoke) hoặc database-tools 100.x trên host backup.
    - Không dùng `--oplog` vì option này chỉ chạy khi dump cả instance. Hệ quả: snapshot không nhất quán tuyệt đối giữa các collection. Dữ liệu nhỏ nên dump chỉ mất vài giây, và restore đã chịu được độ lệch này (§4c thu hồi mọi RT, §4d áp lại thay đổi bảo mật, `db:sync-indexes`). Runbook phải ghi rõ điều này.
    - Replica set (bắt buộc từ run 79) lo mất node; backup dành cho lỗi logic, thao tác nhầm, mất site.
  - **D87.3 RPO/RTO**
    - **RPO ≤ 1 h**, tính bằng khoảng cách giữa hai backup thành công. Alert khi bản thành công cuối cũ hơn 2 h.
    - **RTO ≤ 2 h**, từ quyết định restore tới khi mở lại traffic, gồm cả checklist §4d làm tay.
    - Phần kỹ thuật (giải mã + restore + §4c + `db:sync-indexes` + boot) **≤ 30 phút** với archive ≤ 1 GB.
    - Ngưỡng cho diễn tập (dữ liệu nhỏ): phần kỹ thuật ≤ 10 phút; vượt ⇒ FAIL, phải điều tra.
  - **D87.4 PITR: không làm ở bản phát hành này.**
    - PITR tự dựng từ oplog (dump `local.oplog.rs` theo `ts` + `mongorestore --oplogReplay --oplogFile --oplogLimit`) không rename được namespace, nên không restore song song vào DB mới như §4b được.
    - Nó cũng là một cơ chế thứ hai phải diễn tập và trực.
    - Công cụ đúng cho việc này là Percona Backup for MongoDB (cần tải) ⇒ DEBT-610.
    - RPO 1 h chấp nhận được vì §4c/§4d đã bù phần thay đổi bảo mật.
  - **D87.5 Mã hoá: `gpg` khoá công khai**
    - Lệnh: `gpg --batch --yes --trust-model always --recipient-file <backup-pub.asc> --cipher-algo AES256 --compress-algo none --encrypt`.
    - Archive đã gzip nên gpg không nén. Toàn vẹn dựa vào MDC/AEAD của gpg cộng `sha256` ghi trong manifest.
    - Host backup **chỉ giữ public key**: lộ host hay storage cũng không đọc được backup.
    - Private key có passphrase, sinh offline. File key ở secret store A (ops lead), passphrase ở secret store B (người thứ hai, security hoặc ops khác) ⇒ **restore cần 2 người**.
    - Xoay key hằng năm; giữ private key cũ tới khi bản cuối cùng mã hoá bằng nó hết retention (35 ngày).
    - Loại `openssl enc` (không có AEAD, mặc định không xác thực), `openssl cms` (giải mã file lớn không chạy theo luồng), `age` (không có sẵn, cần tải).
    - Production cần gói `gnupg` của distro trên host backup. Đây là điều kiện hạ tầng ghi trong runbook, không phải tải trong run này.
  - **D87.6 Retention**
    - Bản hằng giờ giữ **48 h** trên host backup (thư mục `0700`, đĩa mã hoá).
    - Bản 00:17 UTC mỗi ngày chép offsite, giữ **35 ngày**. Không có bản tháng.
    - Lý do:
      - restore cũ hơn vài ngày gần như vô ích với IdP (RT, phiên, khoá đã đổi);
      - 35 ngày đủ để phát hiện sự cố muộn trong một chu kỳ tháng;
      - đồng thời giới hạn thời gian PII của user đã xoá còn trong backup.
    - Audit có TTL 180 ngày riêng; lưu audit lâu hơn là việc khác, ngoài phạm vi.
    - Xoá bằng lifecycle rule ở storage offsite; script chỉ prune thư mục local theo đúng mẫu tên.
  - **D87.7 Nơi lưu và quyền**
    - Offsite: object storage ở **failure domain khác** production (khác region/tài khoản nhà cung cấp), bật versioning và **object lock** 35 ngày.
    - Credential của job backup chỉ có quyền `put` (không list/get/delete). Credential restore riêng, chỉ đọc, do ops giữ.
    - Mongo: user `backup` (role có sẵn `backup`) cho dump; user `restore` (role `restore`) chỉ tạo khi cần restore.
    - URI/mật khẩu Mongo đi qua `--config=<file 0600>` (YAML `uri:`), **không** đặt trên argv. Script từ chối `MONGO_URI` có `@` trên argv. Đây là phần DEBT-258 cho đường backup/restore.
    - Mỗi lần restore ghi biên bản: ai, khi nào, ticket nào.
  - **D87.8 Giám sát**
    - Script backup chỉ ghi `veyrigate_backup_last_success_timestamp_seconds` vào textfile collector (khi có `BACKUP_TEXTFILE_DIR`) sau khi **mọi** bước thành công.
    - Alert `SsoMongoBackupStale`: `time() - veyrigate_backup_last_success_timestamp_seconds > 7200` trong 10 phút, thêm vào `ops/prometheus/alerts.yml` + `ops-rules.spec`.
    - Mỗi lần chạy, script tự kiểm `sha256` và `gpg --list-packets` (không cần private key).
    - Diễn tập restore đầy đủ **mỗi quý** và sau mỗi thay đổi schema lớn, bằng harness D87.11.
  - **D87.9 Ngoài Mongo**
    - Redis: không backup (giữ quyết định §4).
    - Signing key Vault: ngoài phạm vi (DEBT-391 vẫn mở). Mất storage Vault ⇒ tạo transit key mới và xử lý như emergency (mọi token cũ chết). Runbook thêm 1 dòng.
  - **D87.10 Script trong repo (dùng chung cho production và diễn tập)**
    - `ops/backup/mongo-backup.sh <db> <out-dir>`
      - Env: `MONGO_BACKUP_CONFIG` hoặc `MONGO_URI` không có credential, `BACKUP_PUBKEY`, `MONGODUMP` (mặc định `mongodump`; diễn tập dùng `docker exec veyrigate-mongo mongodump`), `BACKUP_TEXTFILE_DIR`.
      - Pipe dump → gpg, ghi ra `<name>.partial`; không có file rõ nào chạm đĩa, không có file nào trong container.
      - `set -o pipefail`; chỉ `mv` sang tên chuẩn `idp-<db>-<UTC yyyymmddTHHMMSSZ>.archive.gz.gpg` khi mọi bước exit 0.
      - Ghi `<name>.manifest.json`: `{db, startedAt, finishedAt, toolVersion, collections:{name:count}, totalDocuments, bytes, sha256}`. Số document lấy từ stderr "done dumping".
      - Sau đó: `sha256sum -c` + `gpg --list-packets`, prune file local > 48 h đúng mẫu tên, rồi mới ghi metric.
      - Lỗi ở bất kỳ bước nào ⇒ exit ≠ 0, xoá `.partial`, không ghi metric.
    - `ops/backup/mongo-restore.sh <file.gpg> <src-db> <dst-db>`
      - Kiểm `sha256` theo manifest.
      - Từ chối: `dst` đã tồn tại, `dst == src`, có `--drop`, tên đích không hợp lệ.
      - Lệnh: `gpg --decrypt | $MONGORESTORE --archive --gzip --nsInclude='<src>.*' --nsFrom='<src>.*' --nsTo='<dst>.*'`.
      - Bắt buộc dòng cuối `N document(s) restored successfully. 0 document(s) failed` với N = `totalDocuments` của manifest; lệch ⇒ exit 1.
    - `ops/backup/revoke-all-refresh-tokens.mongosh.js`: khối §4c tách ra file, nhận DB qua `--eval "const TARGET='<db>'"`. Runbook và harness gọi **cùng** file để không lệch nhau.
  - **D87.11 Harness diễn tập + bằng chứng tái lập**
    - Vị trí: `be/scripts/drills/`, Node ESM, import `be/dist` và dependency của `be` (mongoose, jose). Không vào image (Dockerfile chỉ chép `dist`).
    - Gồm: `lib.mjs` (boot BE con, luồng code + PKCE lấy AT/RT, timeout), `seed-drill-data.mjs`, `collection-digest.mongosh.js`, `backup-restore-drill.mjs`, `rotate-drill.mjs`.
    - Chạy lại bằng `node be/scripts/drills/backup-restore-drill.mjs` và `node be/scripts/drills/rotate-drill.mjs --provider local|vault`.
    - Đầu ra: `runs/87-X6-drills/evidence/<drill>-<UTC>.json` (+ `.log`), commit làm bằng chứng.
    - **Không gian tên** (assert lúc bắt đầu; sai ⇒ exit trước khi ghi):
      - Mongo `127.0.0.1:27017/?directConnection=true`, DB khớp `^vg-drill-(src|restore|rotate-local|rotate-vault)$`.
      - Redis `redis://127.0.0.1:6379/7` (backup + rotate local) và `/8` (rotate vault); `DBSIZE` phải = 0 lúc bắt đầu.
      - Cổng BE 4987/4988.
      - `KEY_LOCAL_DIR`, `GNUPGHOME`, archive và cwd đều trong `mkdtemp` của scratch.
    - **Dọn** (`finally`):
      - `dropDatabase` **chỉ** với DB khớp regex trên;
      - `redis-cli -n 7|8 FLUSHDB` chỉ đúng db index đó (**không bao giờ** `FLUSHALL`, không đụng db 0/1/2);
      - xoá thư mục tạm, kill tiến trình con.
    - **Hậu kiểm**: `listDatabases` không còn `vg-drill-*`; `DBSIZE` db 7/8 = 0; `sso-idp-e2e` có cùng số collection/document như lúc bắt đầu (chỉ đếm, trước và sau).
    - **Bằng chứng chỉ được chứa**: tên collection, số document, tên/spec index, digest sha256, mã HTTP, `kid`, thời gian, phiên bản công cụ.
      - **Không** chứa token, mật khẩu, hash, email thật (dùng `drill-*@drill.invalid`), URI có credential.
      - Harness tự grep bằng chứng theo `eyJ`, `$argon2`, `password`, `secret` ⇒ khớp thì exit 1.
    - Mọi HTTP `AbortSignal.timeout(5000)`; boot ≤ 30 s; toàn harness ≤ 10 phút.
    - BE diễn tập chạy `NODE_ENV=development`, vì production đòi `SESSION_COOKIE_SECURE` + Vault https (phần đó đã có `docker-smoke.sh` lo). Report ghi giới hạn này.

  **Khôi phục super_admin (DEBT-252)**

  - **D87.12 CLI `admin-recover`**
    - File `be/src/database/admin-recover.ts` ⇒ `dist/database/admin-recover.js`; script `db:admin-recover`.
    - Chạy production: `docker run --rm -i --env-file <env app production> <image> node dist/database/admin-recover.js <args>`.
    - Dùng **chính env của app** (`validateEnv` đầy đủ ⇒ `MONGO_URI` đúng là DB app). Chấp nhận **mọi** `NODE_ENV`, kể cả production (khác seed).
    - **Tham số** (allowlist; lạ ⇒ exit 1, không echo):
      - `--email <e>`
      - `--requested-by <id>`, `--approved-by <id>`: `^[a-z0-9._-]{2,64}$`, phải **khác nhau**
      - `--ticket <ref>`: `^[A-Za-z0-9._#/-]{1,64}$`
      - tuỳ chọn: `--unlock`, `--allow-existing-super-admin`, `--dry-run`
    - **`--dry-run`** theo quy ước DEBT-256: kiểm tham số + env, in `target:` + `dry-run: no connection made`, exit 0, **không kết nối**.
    - **Chạy thật**:
      1. Kết nối với `serverSelectionTimeoutMS: 5000`.
      2. Đọc kế hoạch:
         - user theo `normalizeEmail`; không có ⇒ từ chối, **không bao giờ tạo user**;
         - membership `default-tenant` hiện tại;
         - trạng thái khoá;
         - số super_admin **dùng được** của `default-tenant`, định nghĩa giống `SuperAdminGuard`: membership active + `super_admin`, user tồn tại, `lockedUntil ≠ ADMIN_LOCKED_UNTIL`.
      3. In kế hoạch: `target: host/db`, `user <id>`, membership, locked yes/no, `usable super_admins: N`, hai tên, ticket. **Không in email.**
      4. In mã xác nhận ngẫu nhiên 8 chữ số (`crypto.randomInt`, dạng `1234-5678`), rồi đọc **một dòng** stdin, chờ tối đa 120 s.
      5. Mã đúng ⇒ **một transaction** qua `SuperAdminGuard.runGuarded`:
         - touch `$inc superAdminGuard` các membership super_admin của tenant;
         - đếm lại số super_admin dùng được trong transaction;
         - upsert membership `{status:'active', $addToSet roles 'super_admin'}`;
         - nếu có `--unlock`: `UserService.adminUnlock(id, true, now, session)` (thêm tham số `session`);
         - insert audit `ADMIN_RECOVERED`.
      6. Commit ⇒ in `recovered: user <id>, audit event <eventId>`, exit 0.
    - **Audit `ADMIN_RECOVERED`** (enum mới, thêm vào `ALERT_ACTIONS`):
      - `actorType:'system'`, `actorId:<requested-by>`, `tenantId:'default-tenant'` (để thấy qua `GET /admin/audit`), `targetType:'user'`, `targetId:<userId>`, `result`, `reason?`.
      - `metadata:{requestedBy, approvedBy, ticket, unlocked, forced, usableSuperAdmins, host: os.hostname()}`.
      - **Không** có email, hash, IP. Đi qua `sanitizeMetadata`.
      - CLI in thêm một dòng JSON `{alert:true, action:'ADMIN_RECOVERED', eventId}` ra stdout để log pipeline bắn alert (alert listener chỉ có trong process app).
    - **Từ chối** (exit 1, không đổi membership/user). Có kết nối thì ghi thêm audit **failure** best-effort, ngoài transaction:
      - `reason:'user_not_found'` (không có `targetId`);
      - `'super_admin_exists'`;
      - `'target_locked'`: user bị admin khoá mà thiếu `--unlock` (nếu vẫn nâng thì được một admin không đăng nhập được);
      - `'not_confirmed'`: sai mã, EOF hoặc hết 120 s.
      - Audit failure lỗi ⇒ vẫn exit 1, in câu cố định.
    - **Lỗi trong transaction** (Mongo standalone không có transaction, audit insert lỗi, mất kết nối) ⇒ abort, **không ghi gì**, exit 1. Thông báo lỗi qua `cliErrorText`.
    - **Sau khi phục hồi** (ghi trong runbook): user đăng nhập `prompt=login`; nếu nghi lộ thì đổi mật khẩu ở `/account/password` (thu hồi mọi phiên, D85.6).
    - CLI **không** đụng Redis và không thu hồi phiên: không thêm phụ thuộc lúc đang sự cố, và admin API vẫn đòi `prompt=login`/step-up cho thao tác ghi.
  - **D87.13 "Xác nhận 2 người" offline là kiểm soát thủ tục, không phải mật mã — runbook ghi thẳng như vậy.**
    - Ai có `MONGO_URI` quyền ghi đều vượt được mọi CLI. Kiểm soát thật gồm:
      - (a) env production/credential Mongo chỉ mở ra khi có 2 người (secret store);
      - (b) CLI bắt hai định danh khác nhau, và người duyệt phải đọc to `target:`, user id, N rồi mới gõ lại mã;
      - (c) audit nằm trong cùng transaction và alert qua log.
    - Đã loại token/HMAC hai pha và chia secret kiểu XOR: tốn công quản lý khoá mà vẫn không chặn được người có quyền ghi DB.
  - **D87.14 Đã có super_admin dùng được ⇒ mặc định từ chối.**
    - `--allow-existing-super-admin` dành cho trường hợp super_admin còn đó nhưng không ai đăng nhập được (người đã nghỉ, mất hộp thư).
    - Khi dùng: audit `metadata.forced:true` + `usableSuperAdmins:N`; `--ticket` vẫn bắt buộc.
    - Race (CLI ∥ CLI, CLI ∥ demote qua API) được tuần tự hoá bằng touch trong transaction: write conflict ⇒ driver retry trên snapshot mới ⇒ thấy N ≥ 1 ⇒ từ chối, trừ khi có force.
  - **D87.15 Chứng minh "chạy trong image production" mà không tạo container local**
    - (a) Local: `pnpm --filter @sso-idp/be deploy --prod <scratch>/deploy`, chép `be/dist` vào (đúng bố cục `/app` của Dockerfile), chạy `node dist/database/admin-recover.js --dry-run …` với cwd đó ⇒ exit 0. Thêm một lần chạy thật vào `vg-drill-restore` trong diễn tập T1.
    - (b) CI: `be/scripts/docker-smoke.sh` thêm check `docker run --rm --network none -e … <image> node dist/database/admin-recover.js --dry-run …` ⇒ exit 0 + dòng `target:`. Chạy ở job `be-image` khi người dùng push, không chạy local.

  **Rotate khẩn cấp**

  - **D87.16 Diễn tập rotate (T3)**
    - **Local**: một BE, `KEY_PROVIDER=local`, `KEY_PREPUBLISH_SEC=600` (như production), `ACCESS_TOKEN_TTL=900`, `METRICS_TOKEN` ngẫu nhiên.
    - **Vault**: hai BE A/B cùng `vg-drill-rotate-vault` + Redis `/8`; Vault `vg-b73-vault`, mount riêng `vg-drill-transit`; policy theo `ops/vault/idp-signer.hcl` (làm đúng runbook-deploy §8, tức là kiểm luôn mục đó). Token app nằm trong file `0600` ở scratch (`VAULT_TOKEN_FILE`), xoá khi dọn.
    - **Đo** (ms, tính từ lúc gửi rotate):
      - latency của rotate;
      - JWKS A chỉ còn `newKid`;
      - JWKS B chỉ còn `newKid` (**≤ 32 s** = cache 30 s + biên);
      - `/userinfo` trên B với AT cũ trả 401 (≤ 32 s).
    - Thêm một lượt **làm tay** theo runbook-ops §1 bằng curl ở Local (tester), ghi tổng thời gian. Bước nào sai thì sửa runbook ngay trong run này.
    - **Phần Vault do orchestrator chạy trong một lệnh Bash** (root token chỉ sống trong process đó, không in, không ghi file):
      1. `T=$(openssl rand -hex 16)`
      2. `docker run` theo `vault-preflight.mjs`
      3. `node be/scripts/drills/rotate-drill.mjs --provider vault`
      4. `pnpm -C be test:vault` (gate T6)
      5. `docker rm -f vg-b73-vault`, chạy cả khi bước trước lỗi
      6. `docker ps -a --filter name=vg-b73-vault` phải rỗng.

  **Sweep**

  - **D87.17 DEBT-589 (sửa phạm vi)**
    - Bỏ `failedLoginCount` và `lockTransitionNonce` khỏi `user.schema.ts`, `UserDoc`, `UserView`, `UserStatusPatch` và mọi chỗ ghi (`user.service.ts`, `seed.ts`, `seed-dev.ts`, `test/e2e/seed-e2e-admin.ts`).
    - Điều kiện audit unlock (`admin-users.controller.ts:256`) chỉ còn `before.lockedUntil != null`.
    - Giữ `lockedUntil`, `adminLockLevel`, `adminLockMarkAt`.
    - Không đổi FE/OpenAPI (vốn không lộ); thêm test hồi quy chứng minh không lộ.
    - Dọn dữ liệu bằng khối mongosh ở `runbook-deploy.md` §15 mới, chạy sau deploy qua `const d = db.getSiblingDB('<db>')`:
      - (i) **dry-run**: `countDocuments` cho `{$or:[{failedLoginCount:{$exists:true}},{lockTransitionNonce:{$exists:true}}]}` và cho khoá tạm cũ `{lockedUntil:{$lt:new Date(), $ne: ISODate('9999-12-31T23:59:59.999Z')}}`;
      - (ii) `updateMany` với `$unset` tương ứng;
      - (iii) chạy lại ⇒ `modifiedCount 0` (idempotent).
    - Không thêm CLI: chạy một lần, và field sót lại vô hại vì mongoose strict không đọc.
  - **D87.18 DEBT-590 digest**
    - Pin `mongo:7.0.43@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b` và `redis:7.4.10-bookworm@sha256:e9b2e45ecd47fbb69b877cf8d045d5cccaaaed52524b6e098b4abe8212994f73` (cùng digest với `docker-smoke.sh`/`prod.example.yml`, đã ≥ 14 ngày).
    - Pin `axllent/mailpit:v1.21@sha256:81370195cd4a0eab9604d17c2617a7525b0486f9365555253b6c5376c6350f1a` (RepoDigest local, image 2024-12).
    - Chỗ áp dụng: `ci.yml` dòng 84/180 (`redis` service), 91 (mailpit), 124/215 (`docker run … mongo:7`); `docker-compose.yml` (3 service). Mỗi chỗ kèm comment `# <tag>, pinned 2026-11-12 (DEBT-590)`.
    - Không pull, không `compose up`. Local vẫn chạy `veyrigate-mongo` 7.0.48 trong khi CI chạy 7.0.43: chấp nhận được (cùng 7.0, chỉ là image test).
    - Guard: spec Jest mới `be/src/common/ops/image-pins.spec.ts`.
      - Đọc `.github/workflows/*.yml`, `docker-compose.yml`, `ops/compose/*.yml`, `be/scripts/docker-smoke.sh`, `be/test/vault-preflight.mjs`.
      - Mọi tham chiếu image (`image:` và ảnh trong `docker run`) phải có `@sha256:[0-9a-f]{64}`; được miễn placeholder `<registry>/veyrigate-be@sha256:<digest>`.
    - Dependabot không cập nhật image trong `services:` của workflow ⇒ DEBT-611.
  - **D87.19 DEBT-608**
    - Mỗi lần chạy, `seed:e2e-admin` xoá **mọi** `refreshtokens` của user mục tiêu `E2E_USER_EMAIL`. Guard sẵn có: chỉ `NODE_ENV=test` + DB `sso-idp-e2e`. Hợp lý vì spec vốn mở đầu bằng revoke all; không đổi API.
    - Spec bỏ vòng 100 trang: family sống phải ở **trang đầu**, cho phép tối đa 2 lần "Next page" (family do spec khác trong cùng lượt tạo). Không thấy ⇒ fail, thông điệp ghi số family.
    - Đã loại phương án `?active=true`: phải đổi Admin API/fe-admin chỉ vì một test.
  - **D87.20 Checklist**
    - D-4/D-5/D-6 ⇒ ✅, bằng chứng là evidence JSON + spec.
    - E-252/E-253 ⇒ đóng. D-3 ghi chú DEBT-590 đã đóng.
    - Thêm **D-16** "Bootstrap production (resource `admin`, client `fe-admin` với redirect từ env, super_admin đầu tiên)" ❌ **P1**, DEBT-164. Phần super_admin đầu tiên do T2 giải; phần còn lại đề xuất làm ở run 88, trước phần F.
    - D-13 giữ ⚠ (DEBT-391/392).

  ---
- **Không tự quyết (cần người dùng)**: push lên remote; cài Node 22.23.4 trên máy dev (Q62.2); xoá image Docker cũ; xoá DB test/dev; sửa `be/.env`.
