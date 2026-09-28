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

Lưu ý: spec chỉ dùng `findOneAndUpdate` điều kiện trên **một document** cho refresh token → **không cần MongoDB replica set/transaction**. Pin version image khi chốt.

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
| D3 | Step-up re-auth (INV-26) chưa có cơ chế cụ thể | Hỗ trợ `prompt=login` + **`max_age`**; access token cấp cho resource `admin` mang thêm claim **`auth_time`**; API admin từ chối thao tác nhạy cảm nếu `auth_time` quá N phút (đề xuất 5) → trả `403 step_up_required` để fe-admin đẩy user đi re-auth | B4.1, B4.4, B6.2, A5 |
| D4 | RP-initiated logout cần `post_logout_redirect_uri` nhưng model `Client` chưa có | Thêm `postLogoutRedirectUris[]` (exact match, cấm wildcard — cùng quy tắc INV-4) | B3.1, B4.7 |
| D5 | Cần một **resource server thật** để test `aud` (INV-8, spec §7) | Module **demo-resource** trong BE, chỉ bật khi `NODE_ENV != production`: `GET /demo/me` verify JWT (iss/aud/exp/sig). Identifier `http://localhost:4000/demo/` | B6.5, T4 |
| D6 | Resource `admin` cho admin API | Resource identifier `http://localhost:4000/admin/`, scope `admin.read`, `admin.write`; quyền theo `UserTenant.roles[]` (`super_admin`, `tenant_admin`) | B6.1, B6.4 |
| D7 | Khi nào cấp refresh token? Spec chưa nói (scopes chỉ có openid/profile/email) | Cấp refresh token khi client có grant `refresh_token` **và** scope yêu cầu gồm `offline_access` (chuẩn OIDC); thêm `offline_access` vào `scopes_supported` | B4.4, B4.5 |
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

- [ ] **Q1** (chặn B4.2): `Consent` theo `user × client` hay `user × tenant × client × resource`? *Khuyến nghị bắt đầu `user × client`, chừa chỗ mở rộng.*
- [x] **Q2** (chặn B2.5): **ĐÃ CHỐT** — D1: UI login/consent/logout do **BE render**.
- [ ] **Q3** (chặn A4): xác nhận D2 — fe-admin là **BFF/confidential client**.
- [ ] **Q4** (chặn B4.4/B6.2): xác nhận D3 (`max_age` + `auth_time` cho step-up) và D7 (`offline_access`).
- [ ] **Q5** (chặn B7.3): KMS/Vault dùng dịch vụ nào? Hạ tầng Redis (Sentinel/Cluster, self-host/managed)?
- [ ] **Q6**: thời hạn token/session cuối cùng (đề xuất access 15', refresh 30 ngày sliding, idle 8h, absolute 30 ngày) và grace period rotate secret (24h/7 ngày?).
- [ ] **Q7**: quy ước `identifier` resource ở môi trường thật (domain thật hay URN).
- [ ] **Q8**: danh sách domain thật của các app để lập ma trận cookie (X3).
- [ ] **Q9**: tên project/repo (để đặt package name, issuer, tên client mặc định).
