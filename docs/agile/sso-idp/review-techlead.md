# Tech Lead Review — 2026-09-28 (B1.1–B1.5)

## Kết luận: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5)

Review nhóm task **Backend foundation M1 — B1.1–B1.5**. Chỉ review — KHÔNG viết code, KHÔNG đụng `spec.md`/`plan.md`/`tasks.md`. Lịch sử R giữ trong `<details>` cuối file.

---

## Bối cảnh đã đối chiếu (đọc thật)

- `_handoff.md` + `_progress.md`: Phase R (M0) DONE (commit `8b75f24` + `4c2104a`). Cổng hiện tại giao tech-lead review B1.1–B1.5.
- Nguồn sự thật: `plan.md` §5.B1 (bảng B1.1–B1.10), §1.4 (env), §1.5 (công cụ/version), §2 (D1–D12), §11 (rủi ro), §12 (Q1–Q9) + `spec.md` §3 (stack), §5 (cấu trúc `src/`), §6.2/§6.3 (Redis HA, hạ tầng), §13 (bước 1–3, 5), §15 (INV-3, INV-16, INV-20). Đọc trực tiếp.
- Hiện trạng `be/`: chỉ có placeholder — `package.json` (`name:@sso-idp/be`) scripts `echo "[be] TODO: ... at B1.1"` (`dev`/`lint`/`typecheck`/`test`); `be/.env.example` đã có đủ biến §1.4. B1.1 sẽ scaffold NestJS thật thay placeholder. ✓ khớp mô tả đề bài.

---

## 1. Khớp plan §5.B1 + spec §5/§13 — Phạm vi

| Task | plan §5.B1 | spec §13 | spec §5 | Đánh giá |
|---|---|---|---|---|
| B1.1 Scaffold NestJS+Fastify TS strict + ESLint/Prettier + cấu trúc | ✓ dòng B1.1 | bước 1 (NestJS + FastifyAdapter) | `src/{config,common,database,modules,health}` | KHỚP |
| B1.2 Config fail-fast (zod/joi) typed | ✓ dòng B1.2 | bước 1 (ConfigModule Joi/Zod) | `src/config/{configuration,validation.schema}.ts` | KHỚP |
| B1.3 Pino+redact + /health + /ready + helmet + ValidationPipe + filter OAuth + graceful shutdown | ✓ dòng B1.3 | (INV-20 §15; §6.3, §16 observability) | `src/common/{filters,interceptors,pipes}` + `src/health/` | KHỚP |
| B1.4 Mongo(Mongoose)+Redis(ioredis)+Lua loader | ✓ dòng B1.4 | bước 1 (kết nối Mongo+Redis) | `src/database/{mongo,redis}/` | KHỚP |
| B1.5 Crypto utils argon2/CSPRNG/sha256/constant-time/PKCE S256 | ✓ dòng B1.5 | bước 5 (argon2); PKCE §9.2 | `src/modules/oauth/token/pkce.util.ts` (helper) | KHỚP |

**Phạm vi ĐÚNG** — không lấn:
- **B1.6–B1.10** (schema+index, audit, rate-limit, KeyProvider/JWKS, mailer) đã tường minh loại khỏi lần chạy này. B1.4 chỉ dựng *connection module + Lua loader khung*, KHÔNG viết schema §10 (đó là B1.6) và KHÔNG viết Lua script atomic thật (B4.3/B4.5). B1.5 chỉ util thuần, KHÔNG chạm KeyProvider/`jose` (B1.9). ✓
- **B2/B3/B4**: module trong `src/modules/*` được tạo **rỗng đủ để build** (đúng chữ "module rỗng" trong plan §5.B1 + tasks B1.1). Không có logic identity/oauth. ✓

---

## 1b. Thứ tự phụ thuộc (đối chiếu tasks + plan §5.B1)

```
B1.1 (R1) ─┬─▶ B1.2 ─┬─▶ B1.3   (Pino/health/ready cần config đã typed)
           │         └─▶ B1.4   (Mongo/Redis đọc MONGO_URI/REDIS_URL từ config)
           └─────────────▶ B1.5 (crypto util thuần, chỉ cần scaffold TS)
```

- B1.1 → B1.2 → B1.3: **hợp lý**. B1.3 (`/ready` check mongo+redis, graceful shutdown) đọc config typed từ B1.2 và cần connection module. ⚠️ Lưu ý nhỏ: `/ready` **thực sự** kiểm tra mongo+redis cần B1.4 (connection). Tasks ghi B1.3 phụ thuộc B1.2 và B1.4 phụ thuộc B1.2 (song song). Nghĩa là nếu chạy tuần tự B1.3 trước B1.4, `/ready` sẽ chưa có client mongo/redis để ping. → **Không chặn** (đề xuất thứ tự thực thi ở §4), nhưng dev nên làm **B1.4 trước hoặc song song B1.3** để `/ready` verify được ngay. Ghi rõ ở §4.
- B1.4 phụ thuộc B1.2: **đúng** (đọc URI từ config).
- B1.5 phụ thuộc B1.1: **đúng** (không cần config/DB; chỉ cần TS + `argon2`).

---

## 2. Tiêu chí nghiệm thu — kiểm chứng được?

| Task | Tiêu chí then chốt | Kiểm chứng được? | Ghi chú |
|---|---|---|---|
| B1.1 | `start:dev` bootstrap qua FastifyAdapter; **không còn dependency Express**; `typecheck`+`lint` EXIT=0 | ✅ | `grep @nestjs/platform-express` trong `be/package.json`+lock → phải rỗng. Chạy `start:dev`, curl app sống. Quan sát được. |
| B1.2 | Thiếu/sai env → app **crash lúc bootstrap**, log rõ biến sai; config typed | ✅ | Xoá 1 biến bắt buộc (vd `MONGO_URI`) → chạy → EXIT≠0 + message nêu tên biến. Kiểm chứng bằng test bootstrap âm. |
| B1.3 | **INV-20** log không chứa giá trị nhạy cảm; `/ready` đỏ khi mongo/redis down; lỗi trả format OAuth (`error`,`error_description`) | ✅ | INV-20: unit test log 1 object có `password/token/...` rồi assert output đã `[Redacted]`. `/ready`: tắt redis → GET `/ready` trả 503. Filter: gửi input sai → body có `error`+`error_description`. |
| B1.4 | Kết nối mongo/redis (dùng compose R2); có retry; đóng sạch khi shutdown; Lua loader đăng ký được | ✅ | Cần Docker host (compose R2 đã healthy). Test 1 script Lua mẫu qua `defineCommand` → gọi trả kết quả. |
| B1.5 | Unit test **vector RFC 7636** PKCE S256 pass; **không** `Math.random` | ✅ | Vector chuẩn: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. `grep Math.random src/**/crypto*` → rỗng. |

**Bốn tiêu chí "đỏ" đề bài nhấn mạnh — đều đo được:**
1. **Fail-fast config (B1.2)**: test bootstrap với env thiếu → non-zero exit + tên biến. ✅
2. **Redact log INV-20 (B1.3)**: assert chuỗi bí mật không xuất hiện trong log output. ✅
3. **`/ready` check mongo+redis (B1.3)**: tắt từng service → 503; cả hai sống → 200. ✅ (⚠️ phụ thuộc B1.4 — xem §1b/§4.)
4. **PKCE S256 vector RFC 7636 (B1.5)**: dùng đúng example vector RFC → deterministic, pass/fail rõ. ✅

---

## 3. Rủi ro/lưu ý kỹ thuật cho backend-dev

**🔧 Blocking? Không.** Tất cả là lưu ý triển khai, không chặn bắt đầu code. Nhưng cần xử lý đúng để tránh sửa lại:

1. **NestJS + Fastify version pin (plan §1.5, §11):** `nest new` mặc định cài `@nestjs/platform-express`. Phải **gỡ express, thêm `@nestjs/platform-fastify`** và pin đồng bộ major giữa `@nestjs/*` (core/common/platform-fastify cùng major, hiện v11). `main.ts` dùng `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())`. Nghiệm thu "không còn Express" phải check cả **lockfile** (transitive), không chỉ `package.json`.

2. **argon2 native build trên Windows (⚠️ điểm dễ vỡ nhất):** `argon2` là native addon, cần build-tools (Visual Studio C++ / windows-build-tools) hoặc prebuild. Trên Windows dễ fail `node-gyp`. **Khuyến nghị:**
   - Ưu tiên `argon2` (bản có prebuilt binaries) — kiểm tra cài được trước khi cam kết.
   - Nếu môi trường Windows không build được: cân nhắc `@node-rs/argon2` (Rust, prebuilt, không cần node-gyp) — **vẫn là argon2**, thoả spec §6/§13. Ghi rõ lựa chọn vào README/handoff.
   - Đây là **lựa chọn dev-env**, không đổi invariant → không cần quyết định của người dùng.

3. **zod vs joi (B1.2):** spec §5/§13 để **"Joi/Zod"** — tự do chọn. Đề xuất **zod** vì:
   - Type inference (`z.infer`) → config typed tự động, khớp yêu cầu "typed config" của B1.2.
   - Đồng bộ với FE (`fe-sso-test` plan §1.4 dùng **zod** ở `env.ts`; T3Env cho fe-admin cũng nền zod) → 1 mental model toàn repo.
   - Joi vẫn hợp lệ (NestJS docs mặc định Joi). Không chặn — dev chốt 1 và ghi lại.

4. **Cấu trúc module rỗng để build được (B1.1):** spec §5 liệt kê nhiều module (`identity`, `oauth/*`, `security/*`…). "Rỗng đủ để build" = tạo **thư mục + `*.module.ts` tối thiểu** (hoặc chỉ thư mục giữ chỗ), KHÔNG import module rỗng vào `AppModule` nếu chưa có `@Module({})` hợp lệ. Tránh tạo file `.ts` rỗng gây lỗi TS "is not a module". Đề xuất: chỉ tạo `AppModule` + `ConfigModule`(B1.2) + `HealthModule`(B1.3) + `DatabaseModule`(B1.4) thật; các module domain để **thư mục trống hoặc stub `@Module({})`** để `typecheck`/`build` xanh.

5. **`/ready` phụ thuộc B1.4 (xem §1b):** để nghiệm thu `/ready` đỏ-khi-down verify được ngay, dev nên hoàn thành B1.4 (connection) trước/song song B1.3. Nếu buộc làm B1.3 trước, viết health indicator dạng có thể inject client sau — nhưng đơn giản hơn là **đảo thứ tự thực thi B1.4 ↔ B1.3** (thứ tự đề xuất §4).

6. **Redis client + Lua loader (B1.4):** dùng `ioredis` (spec §3). Lua loader qua `defineCommand` chỉ là **khung** — KHÔNG viết script atomic consume/rotation ở đây (đó là B4.3/B4.5). Test loader bằng 1 script mẫu tầm thường (vd `return 1`). Không tạo replica set (spec §6.1: chỉ `findOneAndUpdate`, không cần transaction).

7. **Pino redact (B1.3):** dùng `nestjs-pino` (plan §1.5). Redact path đủ theo INV-20 + tasks: `password, token, code, secret, cookie, authorization` (kể cả nested & header `req.headers.authorization`, `req.headers.cookie`). Test phải cover cả trường nested.

8. **Exception filter OAuth format (B1.3):** trả `{ error, error_description }` (RFC 6749 §5.2). Ở B1.3 chỉ cần **khung filter** map lỗi chung; mã lỗi OAuth cụ thể (`invalid_request`, `invalid_client`…) sẽ dùng ở B3/B4. Đừng over-engineer map đầy đủ lúc này.

9. **Graceful shutdown:** bật `app.enableShutdownHooks()`; mongo/redis đóng trong `onModuleDestroy`/`beforeApplicationShutdown`. Fastify + Nest hỗ trợ sẵn.

---

## 4. Thứ tự thực thi đề xuất (verify từng bước)

```
1. B1.1 scaffold Nest+Fastify strict  -> verify: start:dev bootstrap OK; grep express (pkg+lock) rỗng; typecheck/lint EXIT=0
2. B1.2 config fail-fast zod typed     -> verify: xoá 1 env bắt buộc => bootstrap EXIT≠0 + nêu tên biến
3. B1.4 mongo+redis+Lua loader         -> verify: connect (compose R2 healthy); script Lua mẫu chạy; shutdown đóng sạch
4. B1.3 Pino redact + /health + /ready -> verify: INV-20 test redact; tắt redis => /ready 503; filter trả error/error_description
5. B1.5 crypto utils                    -> verify: test vector RFC 7636 pass; grep Math.random rỗng
```

> Đảo **B1.4 trước B1.3** so với thứ tự đánh số (cả hai đều phụ thuộc B1.2, không phá dependency) để `/ready` verify mongo+redis được ngay khi làm B1.3. B1.5 độc lập, chèn bất kỳ đâu sau B1.1.

---

## 5. "Việc cần bạn quyết định" (plan §12) có chặn B1.1–B1.5?

**KHÔNG.** Rà toàn bộ Q1–Q9 + D1–D12:

| Quyết định | Chặn task | Ảnh hưởng B1.1–B1.5? |
|---|---|---|
| Q1 (consent scope) | B4.2 | Không |
| Q2 (UI BE render) — ĐÃ CHỐT | B2.5 | Không |
| Q3 (fe-admin BFF) | A4 | Không |
| Q4 (max_age/auth_time + offline_access) | B4.4/B6.2 | Không |
| Q5 (KMS/Vault + Redis HA) | B7.3 | Không (B1.4 chỉ single Redis dev; KeyProvider ở B1.9) |
| Q6 (TTL token/session cuối) | — | Không chặn code B1.2. ⚠️ **Lưu ý**: `.env.example` đã đặt TTL mẫu (ACCESS=900, REFRESH=2592000, IDLE=1800, ABSOLUTE=28800). B1.2 chỉ **validate schema + typed**, KHÔNG chốt giá trị cuối → OK. Giá trị chính thức chốt ở Q6 trước B2.3/B4.4. Dev không hardcode TTL trong code (đọc từ config). |
| Q7 (resource identifier) | — | Không (B3.2/B6.4) |
| Q8 (cookie domain) | X3 | Không |
| Q9 (tên project/repo) | — | ⚠️ **Nhẹ**: ảnh hưởng package name/issuer/tên client. `be/package.json` đã dùng `@sso-idp/be`; `ISSUER=http://localhost:4000` (dev) đã có trong `.env.example`. B1.* không hardcode issuer (đọc từ config B1.2) → không chặn. |

⇒ **Không có quyết định nào chặn B1.1–B1.5.** Hai lưu ý Q6/Q9 chỉ yêu cầu dev **đọc giá trị từ config**, không hardcode — đã là yêu cầu sẵn của B1.2.

---

## Rủi ro/thiếu sót thực sự cản trở code B1.1–B1.5

Không có rủi ro **chặn**. Điểm cần theo dõi (đều non-blocking, đã nêu §3):
1. argon2 native build trên Windows — có fallback `@node-rs/argon2`; verify cài được trước khi cam kết.
2. Nghiệm thu "không còn Express" phải check **lockfile** (transitive), không chỉ `package.json`.
3. `/ready` verify cần B1.4 → theo thứ tự thực thi §4.
4. B1.4 cần Docker host cho case connect thật (compose R2 đã healthy) — nhất quán với R2.

Phạm vi đúng: B1.1–B1.5 không lấn B1.6–B1.10/B2/B3/B4. Module domain chỉ tạo rỗng đủ build.

---

## Điểm mạnh (B1.1–B1.5)

- Phạm vi tách sạch: foundation thuần, không rò logic OAuth/identity vào M1 sớm.
- Mọi tiêu chí nghiệm thu **đo được**, kể cả 4 điểm bảo mật trọng tâm (fail-fast, redact, /ready, PKCE vector).
- Bám sát spec §5 (cấu trúc) + §13 (thứ tự) + INV-20; crypto util đặt nền cho INV-3 (PKCE S256) đúng chỗ.
- Kế thừa nhất quán R1 (TS strict, lint/format khớp `.editorconfig`, lockfile cho CI).

## Đề xuất (không bắt buộc)
- Chốt **zod** cho B1.2 (type-infer + đồng bộ FE) — ghi vào handoff.
- Chốt hướng argon2 (native vs `@node-rs/argon2`) sớm để tránh block giữa chừng trên Windows.
- Health check: cân nhắc `@nestjs/terminus` cho `/health`+`/ready` (chuẩn hoá indicator mongo/redis) — tuỳ dev, không bắt buộc.
- `.env.example`: đã có ghi chú nhóm server-only (fe-admin) từ R5 — giữ nguyên.

**Bàn giao**: → **backend-dev** hiện thực theo thứ tự §4 (B1.1 → B1.2 → B1.4 → B1.3 → B1.5).

---

<details>
<summary>Lịch sử review R3–R5 (đã PASS, giữ tham chiếu)</summary>

## Bối cảnh đã đối chiếu — lịch sử (R3–R5)

- `_handoff.md` + `_progress.md`: R1–R2 DONE (commit 8b75f24, 8/8 case). Cổng hiện tại giao cho tech-lead review R3–R5.
- Nguồn sự thật: `plan.md` §1.4 (biến môi trường) + §4 (Phase R). Đọc trực tiếp.
- Hiện trạng repo:
  - `.github/agents/`: có **đủ 7 agent** `*.agent.md` (analyst, tech-lead, backend-dev, frontend-dev, senior-reviewer, tester, orchestrator) + `HANDOFF-PROTOCOL.md` + `README.md`. ✓
  - `.github/workflows/`: **chưa có** → R4 tạo mới, không đè.
  - `.env.example`: **chưa có** ở mọi package → R5 tạo mới.
  - `.pre-commit-config.yaml`/`.gitleaks.toml` gốc: **chưa có** (bản trong `.agents/plugins/superpowers/` là của skill, không liên quan) → R5 tạo mới.
  - Root `package.json`: scripts `lint`/`typecheck`/`test` đã dùng `--if-present --no-bail`; `engines.node=22.23.2`; `pnpm-lock.yaml` tồn tại (⇒ `--frozen-lockfile` trong CI hợp lệ).

---

## Đánh giá điều chỉnh R3 (verify + document thay vì dựng lại)

**Kết luận: điều chỉnh HỢP LÝ — giữ nguyên, không nên bám cứng plan §4.**

Lý do:
- Plan §4 R3 giả định `docs/spec.md`, `docs/plan.md`, root `PROGRESS.md`, `.claude/agents/*`. Thực tế repo đã chốt layout khác và **đang vận hành**: spec/plan ở `docs/agile/sso-idp/`, agents ở `.github/agents/`, progress theo tính năng (`_progress.md`/`_handoff.md`). `HANDOFF-PROTOCOL.md` mô tả đúng layout này và cả pipeline R1–R2 đã chạy trọn trên nó.
- Dựng lại theo đường dẫn cũ sẽ tạo **nguồn sự thật kép** (2 bản spec/plan, 2 nơi progress) → vi phạm nguyên tắc surgical + đúng rủi ro "nhân đôi nguồn sự thật" mà đề bài cảnh báo.
- Tinh thần plan §4 R3 (**có agent workspace, mỗi agent đọc spec trước khi làm, sinh backlog khớp plan**) đã đạt sẵn: các agent đều trỏ `spec.md` trong thư mục tính năng theo HANDOFF-PROTOCOL. R3 điều chỉnh chỉ còn xác minh + tài liệu hoá — đúng và đủ.

**Điểm cần lưu ý cho dev (không chặn — làm rõ tiêu chí, không sửa task):**
- Các agent tham chiếu `spec.md` **tương đối theo `docs/agile/<slug>/`** (vì `<slug>` động theo từng tính năng), KHÔNG hardcode `docs/agile/sso-idp/spec.md`. Do đó tiêu chí R3 "nếu agent thiếu dòng đọc `docs/agile/sso-idp/spec.md`" nên hiểu là **thiếu chỉ dẫn đọc spec trong thư mục tính năng** — hiện `backend-dev`, `frontend-dev`, `senior-reviewer`, `tester` đều đã có (analyst/orchestrator có trách nhiệm tạo/điều phối). ⇒ Nhiều khả năng R3 sẽ **không cần thêm dòng nào**, chỉ verify + cập nhật README. Nếu quyết định thêm dòng cho agent nào, giữ đúng phong cách "spec trong `docs/agile/<slug>/`", tránh chèn slug cứng.
- Có thư mục `.github/agents/.claude/skills/` — là artefact của skills, KHÔNG phải bản agent trùng lặp. Không cần xử lý.

Tiêu chí nghiệm thu R3 **kiểm chứng được**: liệt kê 7 file agent (đã xác nhận tồn tại), grep chỉ dẫn đọc spec, và README nêu layout thực tế — đều quan sát được.

---

## R4 — CI GitHub Actions

**Kết luận: PASS.**

- Khớp tinh thần plan §4 R4: job install(cache)+lint+typecheck+unit test; job e2e dùng service mongo/redis; chặn merge nếu đỏ.
- **Cách nghiệm thu "validate cú pháp YAML + đối chiếu lệnh" là CHẤP NHẬN ĐƯỢC** cho phạm vi này: không có runner GitHub cục bộ, và các lệnh trong job (`pnpm i --frozen-lockfile`, `pnpm lint`, `pnpm -r run typecheck`, `pnpm test`) đều là lệnh đã **PASS thực tế ở R1** → rủi ro sai lệnh thấp. Đây là mức verify hợp lý, không cần dựng runner giả.
- Nhất quán: root scripts đã `--if-present --no-bail` ⇒ job `quality` không đỏ ở giai đoạn placeholder. `--frozen-lockfile` hợp lệ vì lockfile đã có.
- Xử lý đúng phần "chặn merge": branch protection là thao tác **ngoài repo** trên GitHub, task ghi rõ đưa vào README — đúng, không tự ý coi là hoàn tất.

Lưu ý cho dev (không chặn):
- Nên có bước validate YAML thật khi code (ví dụ `actionlint` nếu sẵn, hoặc ít nhất parse YAML) và ghi output vào test-report — để tiêu chí "YAML hợp lệ" có bằng chứng, không chỉ đọc mắt.
- Job `e2e` để **placeholder/skip rõ ràng** (bật ở B7.1/X1) là đúng — đừng viết test e2e ở R4.
- `.node-version`/`.nvmrc` = `v22.23.2` (có tiền tố `v`); `actions/setup-node` với `node-version-file` đọc được cả hai định dạng — dùng file thay vì hardcode version.

---

## R5 — Secret convention + README 5 phút

**Kết luận: PASS.**

**`.env.example` — đủ biến theo §1.4?** Đối chiếu từng dòng:
- `be`: danh sách trong task **khớp §1.4** (NODE_ENV, PORT, ISSUER, MONGO_URI, REDIS_URL, ACCESS/REFRESH TTL, SESSION_IDLE/ABSOLUTE_TTL, KEY_PROVIDER, KEY_LOCAL_DIR, SMTP_URL, GOOGLE/GITHUB *_ID/SECRET, ADMIN_SEED_*, CSRF_SECRET, RATE_LIMIT_*). ✓ Ghi rõ `KEY_PROVIDER(local|aws-kms|vault)` như §1.4 khi tạo mẫu.
- `fe-admin`: tách server (`OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL`) + client (`VITE_*`). **Khớp §1.4.** ✓ Lưu ý §1.4 nhấn mạnh biến server **không lọt vào bundle client** — mẫu chỉ để tên, ghi chú rõ nhóm nào là client-safe.
- `fe-sso-test`: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`. **Khớp §1.4.** ✓

**gitleaks/pre-commit khả thi trên Windows?** — Có, với lưu ý:
- `pre-commit` là công cụ Python; chạy trên Windows nếu có Python + pip. Hook gitleaks của pre-commit tải binary theo OS → hoạt động trên Windows.
- Fallback nếu máy không có Python: chạy `gitleaks` binary trực tiếp (Windows có bản release) hoặc qua Docker (`zricethezav/gitleaks`). Nghiệm thu R5 đã dự phòng đúng: **nếu công cụ có sẵn thì chạy `gitleaks detect` thử; nếu không, validate cú pháp config** — mức verify này chấp nhận được.
- Đề nghị dev: khi verify, thử tạo 1 file có secret giả rồi chạy `gitleaks detect` để chứng minh "commit chứa secret bị chặn"; nếu không có công cụ, ghi rõ trong test-report là validate config + lý do môi trường.

**README 5 phút:** luồng clone → cp .env.example → pnpm i → docker compose up -d → pnpm dev:all là đủ và đối chiếu được với lệnh đã pass ở R1/R2. ✓

Tiêu chí nghiệm thu R5 **kiểm chứng được** (đối chiếu biến với §1.4, chạy/validate gitleaks, dò README theo lệnh đã pass).

---

## Rủi ro/thiếu sót thực sự cản trở code R3–R5

Không có rủi ro **chặn**. Các điểm cần lưu ý (đều non-blocking, đã nêu trên):
1. R3: tránh hardcode slug trong chỉ dẫn agent; nhiều khả năng không cần thêm dòng nào (chỉ verify + README).
2. R4: nên có bằng chứng validate YAML (actionlint/parse) trong test-report, không chỉ đọc mắt.
3. R5: gitleaks phụ thuộc Python/Docker trên Windows — nếu thiếu, dùng nhánh fallback "validate config" mà task đã cho phép, và ghi rõ lý do.

Phạm vi đúng: R3–R5 không lấn sang B*/A*/T*. Không tạo `docs/spec.md`/root `PROGRESS.md`/`.claude/agents/*` mới (tránh nguồn sự thật kép).

---

## Điểm mạnh

- Điều chỉnh R3 đúng nguyên tắc surgical + tránh nhân đôi nguồn sự thật.
- Mọi tiêu chí nghiệm thu R3–R5 quan sát/kiểm chứng được; cách verify thay thế (YAML syntax, validate config) hợp lý cho phần không chạy cục bộ được.
- `.env.example` bám sát §1.4 từng biến.
- Nhất quán với R1 (`--if-present --no-bail`, lockfile, node version file).

## Đề xuất (không bắt buộc)
- R4: thêm `permissions:` tối thiểu (least privilege) cho workflow; dùng `concurrency` như task đã nêu.
- R5: trong `.env.example`, ghi chú nhóm biến "server-only, KHÔNG đưa vào client bundle" (fe-admin) để nhắc INV env-validation ở A2 sau này.

**Bàn giao**: → **backend-dev** hiện thực R3 → R4 → R5.
