# Run Plan — SSO IdP qua pipeline AI team

Kế hoạch chạy pipeline (analyst → tech-lead → dev → senior → tester) theo
**`plan.md`** (cùng thư mục). Mỗi lần chạy orchestrator = 1 nhóm task đủ nhỏ để
pipeline hoàn thành trong giới hạn retry.

- **Nguồn sự thật**: `spec.md` (spec) + `plan.md` (plan) — cùng thư mục `docs/agile/sso-idp/`.
- **Slug dùng chung**: `sso-idp` → mọi file handoff nằm ở `docs/agile/sso-idp/`.
- Task ID (R/B/A/T/X) và cột "Phụ thuộc" lấy nguyên từ plan; chạy theo đúng thứ tự đó.
- Spec đã hoàn chỉnh → **có thể bỏ qua analyst** (xem "Biến thể nhanh" ở cuối).

> ⚠️ **`spec.md` và `plan.md` đã viết sẵn — ĐỪNG để analyst ghi đè.** Khi chạy `@orchestrator`,
> thêm câu: *"spec.md và plan.md đã có, KHÔNG ghi đè; nếu thiếu `tasks.md` thì chỉ sinh tasks.md
> từ nhóm task tương ứng trong plan."* Hoặc dùng "Biến thể nhanh" (bỏ qua analyst hoàn toàn).

## Điều kiện tiên quyết (bạn tự chuẩn bị, agent KHÔNG dựng được)

- [ ] Docker chạy được (compose sẽ dựng mongo/redis/mailpit — xem R2)
- [ ] pnpm + Node theo `.nvmrc` (R1)
- [ ] Chốt các "Việc cần bạn quyết định" trong plan §12 **trước** khi tới task bị chặn:
  - Q1 (semantic scope trong consent) → chặn **B4.2**
  - Q4 (`offline_access` / D7) → ảnh hưởng **B4.4/B4.5/B4.6**
  - Q6 (token TTL), Q7 (session timeout) → ảnh hưởng **B2.3/B4.4**
  - Q8 (KeyProvider thật) → chặn **B7.3**
- [ ] Các quyết định ngoài spec D1–D12 (plan §2) đã đọc & đồng ý

---

## Milestone & thứ tự (theo plan §3)

| Mốc | Nội dung | Nhóm task |
|-----|----------|-----------|
| M0 | Repo & hạ tầng | R1–R5 |
| M1 | Backend foundation | B1.* |
| M2 | Danh tính, phiên, client/resource | B2.*, B3.* |
| M3 | **Walking skeleton** (authorize→login→token→claims) | B4.1–B4.4, T1–T2, X1 |
| M4 | OAuth core đầy đủ | B4.5–B4.7 |
| M5 | Federation + Admin API + seed | B5.*, B6.* |
| M6 | Admin FE + SSO Test FE | A*, T3–T7 |
| M7 | E2E liên module | X2–X4 |
| M8 | Hardening & release | B7.*, X5–X6, A9 |

> **Lane song song**: sau M2, lane Backend (B4→B7) và lane FE (A*, T*) chạy song song được
> nhờ mock (A5 dùng MSW, T2 dùng discovery). Nếu chạy tuần tự 1 người, theo đúng thứ tự bảng dưới.

---

## Lệnh chạy từng nhóm

Mỗi lệnh giữ slug `sso-idp`. Chạy tuần tự theo thứ tự các nhóm; orchestrator sẽ chia nhỏ tiếp
nếu 1 nhóm còn quá lớn cho 1 vòng pipeline.

### Phase R — Repo & hạ tầng (M0)

```
# R1–R2 — Monorepo + docker
@orchestrator Làm R1, R2 theo docs/agile/sso-idp/plan.md §4: pnpm workspace monorepo (be/, fe-admin/, fe-sso-test/), script gốc (dev:all/lint/typecheck/test), docker-compose (mongo/redis/mailpit healthcheck). Slug: sso-idp.

# R3–R5 — Agent workspace + CI + secret
@orchestrator Làm R3, R4, R5 theo plan §4: docs/spec.md + docs/plan.md + PROGRESS.md, CI GitHub Actions theo package (lint/typecheck/unit + e2e mongo/redis), .env.example từng package + secret scan + README chạy-trong-5-phút. Slug: sso-idp.
```

### Phase B — Backend `be/` (`:4000`, ISSUER=http://localhost:4000)

```
# B1 — Foundation (§13 bước 1–3)
@orchestrator Làm B1.1–B1.5 theo plan §5.B1: scaffold NestJS+Fastify TS strict, config fail-fast (zod/joi), logging Pino+redact + /health + /ready + helmet + ValidationPipe + exception filter chuẩn OAuth + graceful shutdown, Mongo+Redis+Lua loader, crypto utils (argon2, CSPRNG, sha256, PKCE S256). Slug: sso-idp.
@orchestrator Làm B1.6–B1.10 theo plan §5.B1: toàn bộ schema §10 + index/TTL + sync index tường minh, module Audit (không nhận trường bí mật, hook alert), rate-limit đa chiều Redis, KeyProvider + LocalKeyProvider + /jwks.json RS256 + TokenSigner/Verifier + rotation thường/khẩn, Mailer + template verify/reset. Slug: sso-idp.

# B2 — Danh tính & phiên (§9.6, §9.8, §9.12)
@orchestrator Làm B2.1–B2.5 theo plan §5.B2: tenant context từ session (INV-24), identity services + seed default-tenant, sessions Redis (fixation/idle+absolute timeout, INV-16/17), authentication (register/login/lockout/reset atomic single-use, chống enumeration INV-27), UI server-side D1 (login/register/verify/forgot/reset/consent/logout + CSRF + CSP). Slug: sso-idp.

# B3 — Client & Resource (§7, §9.3, §9.7)
@orchestrator Làm B3.1–B3.4 theo plan §5.B3: Client+ClientCredential (rotation có version, INV-18) + validator redirect_uri exact (INV-4/21) + postLogoutRedirectUris (D4), Resource + allowedResources (INV-14), client auth cho /token (basic/post/none), CORS động dùng allowedCorsOrigins (D8, §9.7). Slug: sso-idp.

# B4 — OAuth core (§9.1–9.5, §9.8) — B4.1–B4.4 là mốc walking skeleton M3
@orchestrator Làm B4.1–B4.4 theo plan §5.B4: /authorize + AuthorizeRequestContext (INV-3/4/14/15, chống open redirect, reject PKCE plain, max_age D3), consent versioning (§9.4 — CẦN chốt Q1 trước), AuthorizationCode + Lua consume-with-binding (INV-1/2/13), /token authorization_code (access aud=resource + id_token nonce + refresh, iss RFC 9207, sub bất biến). Slug: sso-idp.
@orchestrator Làm B4.5–B4.7 theo plan §5.B4: refresh grant rotation atomic + reuse→revoke family (INV-10/11/12) + /revoke, /userinfo + discovery §12 + /introspect (RFC 7662), logout local/global + RP-initiated + front-channel (§9.8). Slug: sso-idp.

# B5 — Federation (§9.9)
@orchestrator Làm B5.1–B5.3 theo plan §5.B5: cấu hình tĩnh Google/GitHub endpoint cứng (INV-23, GitHub lấy email primary+verified), broker flow state riêng IdP nối qua request_id, account linking an toàn KHÔNG auto-link theo email (INV-22, bắt re-auth local). Slug: sso-idp.

# B6 — Admin API & seed (§9.10–9.11)
@orchestrator Làm B6.1–B6.5 theo plan §5.B6: admin guard (aud=admin resource, INV-24), step-up @RequireRecentAuth đọc auth_time (INV-26, 403 step_up_required), endpoint quản trị + OpenAPI (secret hiện 1 lần), seed idempotent (default-tenant/admin/resource admin+demo/client fe-admin+fe-sso-test), demo-resource dev (D5). Slug: sso-idp.

# B7 — Hardening & release (§13 bước 14–18)
@orchestrator Làm B7.1–B7.5 theo plan §5.B7: security test suite theo ma trận §14 (concurrent thật), observability Prometheus + alert (reuse/rotation khẩn), Dockerfile multi-stage non-root + KeyProvider thật (Q8) + fallback Redis-down §6.2, supply-chain scan (pnpm audit/SAST/secret), runbook. Slug: sso-idp.
```

### Phase A — Admin FE `fe-admin/` (TanStack Start, BFF confidential client, `:3000`)

```
# A1–A5 — Nền tảng + BFF login + API layer
@orchestrator Làm A1–A5 theo plan §6: scaffold TanStack Start (:3000, xoá file demo, pin version), T3Env (server/client tách), UI foundation shadcn + layout + dark mode, đăng nhập OIDC kiểu BFF (D2, resource=admin), API layer server functions + types từ OpenAPI (D11) + TanStack Query + xử lý 401 và 403 step_up_required. Dùng MSW mock khi BE chưa xong. Slug: sso-idp.

# A6 — Màn hình quản trị
@orchestrator Làm A6.1–A6.6 theo plan §6: Clients (bảng server-side, form validate redirect_uri exact, secret hiện 1 lần + rotate qua step-up), Resources, Users&sessions (revoke), Audit log (highlight TOKEN_REUSE_DETECTED), Keys (rotate khẩn cấp 2 bước + step-up), Dashboard. Slug: sso-idp.

# A7–A9 — Hardening + test + deploy
@orchestrator Làm A7–A9 theo plan §6: CSP/headers/cookie/CSRF FE + không lộ secret vào bundle (INV-20), test Vitest + Playwright (login→tạo client→audit→step-up), Dockerfile deploy Node server của Start + healthcheck. Slug: sso-idp.
```

### Phase T — SSO Test FE `fe-sso-test/` (React + React Router, public SPA + PKCE, `:5173`)

```
# T1–T2 — Scaffold + OIDC client viết tay (thuộc walking skeleton M3)
@orchestrator Làm T1, T2 theo plan §7: Vite+React+React Router SPA (:5173) + env zod, OIDC client mỏng viết tay (fetch discovery, PKCE S256 WebCrypto, state/nonce, callback kiểm state+iss, validate ID token iss/aud/exp/nonce qua JWKS bằng jose, token trong memory, refresh rotation, RP-initiated logout, INV-6). Slug: sso-idp.

# T3–T5 — Trang + gọi resource thật + security lab
@orchestrator Làm T3–T5 theo plan §7: các route (/,/login,/callback,/profile,/tokens,/api-test,/logout + guard + trang lỗi hiện error_description), gọi GET /demo/me bằng access token + case sai aud→401 (INV-8) + userinfo, security lab dev (refresh replay→family revoke, bảng chỉnh tham số /authorize, đổi state trước callback). Slug: sso-idp.

# T6–T7 — (tuỳ chọn) so sánh oidc-client-ts + test
@orchestrator Làm T7 (và T6 nếu muốn) theo plan §7: unit PKCE/validator + e2e Playwright (login/consent/refresh/logout/kịch bản lab). Slug: sso-idp.
```

### Phase X — Liên module, E2E, phát hành

```
# X1 — Walking skeleton (M3) — chạy sau B4.1–B4.4 + T2
@orchestrator Làm X1 theo plan §8: walking skeleton email/password → /authorize → login UI BE → /token → fe-sso-test hiện claims; Playwright 1 kịch bản. Slug: sso-idp.

# X2–X4 — E2E đầy đủ + cookie matrix + federation
@orchestrator Làm X2, X3, X4 theo plan §8: E2E đầy đủ (consent/refresh rotation/reuse-detect/logout local+global/admin tạo client→test app dùng→step-up→đổi redirect_uris hỏng đúng cách), cookie topology matrix đa trình duyệt (§9.6), federation E2E với mock OAuth provider (D12, INV-22 không auto-link). Slug: sso-idp.

# X5–X6 — Security regression CI + release
@orchestrator Làm X5, X6 theo plan §8: gom security regression vào CI (B7.1 + lab T5 + FE hardening, chặn merge khi vi phạm INV), release checklist (OWASP ASVS/OAuth BCP, dependency audit, diễn tập backup+restore + rotate khẩn cấp, đóng hết P0). Slug: sso-idp.
```

---

## Biến thể nhanh (bỏ qua analyst)

Spec + plan đã đủ chi tiết. Muốn tiết kiệm vòng lặp thì chạy thẳng dev → review → test thay vì
cả pipeline. Ví dụ cho nhóm B4.1–B4.4:

```
@backend-dev Hiện thực B4.1–B4.4 theo docs/agile/sso-idp/plan.md §5.B4 và docs/agile/sso-idp/spec.md §9.1–9.5. Ghi handoff ở docs/agile/sso-idp/.
@senior-reviewer Review thay đổi B4.1–B4.4 ở docs/agile/sso-idp/. Trả PASS/REJECT.
@tester Viết + chạy test cho B4.1–B4.4 theo acceptance trong plan và ma trận §14. Báo pass/fail thật.
```

Nhóm FE thay `@backend-dev` bằng `@frontend-dev`.

---

## Lưu ý giới hạn

- **Retry cap = 2** mỗi cổng. Nhóm phức tạp (B4.3 Lua atomic, B4.5 refresh rotation, B5.2
  broker) dễ REJECT/FAIL nhiều lần → nếu kẹt, tách nhỏ hơn (vd tách "PKCE verify" khỏi "phát token").
- Agent **không dựng hạ tầng thật** (KMS thật, Redis HA, k8s). R2 dựng compose dev; KeyProvider
  thật để ở B7.3 (cần chốt Q8).
- **Ma trận Invariant → task**: plan §9 (đủ 27 INV + nơi kiểm chứng) — tester dùng làm checklist.
- **Definition of Done**: plan §10.
- File handoff giữa agent: `_handoff.md` (trạng thái hiện tại, ghi đè) + `_progress.md` (log,
  ghi thêm) — theo `HANDOFF-PROTOCOL.md`.
```

