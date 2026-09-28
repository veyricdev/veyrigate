# Nhật ký giao ca — sso-idp

## [2026-09-28] orchestrator
- Đã làm: khởi tạo pipeline cho R1–R2; spec.md & plan.md đã có sẵn nên BỎ QUA analyst (theo _run-plan.md); sinh tasks.md cho R1–R2 từ plan §4
- File đổi: _handoff.md, _progress.md, tasks.md
- Kết quả: DONE (khởi tạo)
- Bàn giao cho: tech-lead — review tasks.md R1–R2 về kiến trúc/khả thi

## [2026-09-28] tech-lead
- Đã làm: review khả thi & kiến trúc tasks.md nhóm R1–R2; đối chiếu plan §1.1/§1.2/§1.3 + §4; kiểm `.node-version` (=v22.23.2, khớp `.nvmrc` trong task)
- File đổi: review-techlead.md (tạo mới), _handoff.md, _progress.md
- Kết quả: **PASS** — tasks khớp plan, phạm vi đúng (không lấn R3–R5/B*/A*/T*), nghiệm thu kiểm chứng được; đề xuất fallback nghiệm thu R2 khi Docker không sẵn trên Windows (dùng `docker compose config`) — không chặn code
- Bàn giao cho: backend-dev — hiện thực R1 → R2

## [2026-09-28] backend-dev
- Đã làm: hiện thực R1 (monorepo pnpm workspace + script gốc) và R2 (docker-compose mongo/redis/mailpit + healthcheck + profile `full` khung `be`).
- File tạo mới:
  - Gốc: `.gitignore`, `.editorconfig`, `.nvmrc` (=`v22.23.2`), `pnpm-workspace.yaml` (be, fe-admin, fe-sso-test), `package.json` (private, `packageManager: pnpm@12.6.0`, scripts `dev:all`/`lint`/`typecheck`/`test` — dùng `--if-present --no-bail` cho fan-out), `README.md`, `docker-compose.yml`
  - Package placeholder: `be/package.json` + `be/README.md`, `fe-admin/package.json` + `fe-admin/README.md`, `fe-sso-test/package.json` + `fe-sso-test/README.md` (mỗi cái có script placeholder `dev`/`lint`/`typecheck`/`test`, README chỉ rõ scaffold tại B1.1/A1/T1)
  - Sinh tự động: `pnpm-lock.yaml`
- File cập nhật: `tasks.md` (R1/R2 → `[x]`, Trạng thái → `in-review`), `_progress.md`, `_handoff.md`
- Quyết định/ghi chú:
  - `packageManager` pin `pnpm@12.6.0` (bản ổn định mới nhất trên npm tại thời điểm chạy).
  - mailpit pin `axllent/mailpit:v1.21` (yêu cầu "pin version image" của R2; plan chỉ ghi `axllent/mailpit`).
  - lint/typecheck/test gốc thêm `--if-present --no-bail` theo đề xuất tech-lead để tránh false-negative giai đoạn khung.
  - `be` service trong `docker-compose.yml` đặt `profiles: [full]` (mặc định không chạy), `build.context: ./be` + `depends_on` mongo/redis `service_healthy`; `be/Dockerfile` sẽ có ở B7.3.
- Verify (chạy thật):
  - `pnpm i` → `Scope: all 4 workspace projects`, `Done in 348ms using pnpm v12.6.0` (nhận diện đủ 3 package con + root).
  - `pnpm -r run typecheck` → fan-out 3/4 project, tất cả in TODO + `Done`, EXIT=0.
  - `pnpm lint` → fan-out 3 package, tất cả `Done`, EXIT=0.
  - `docker compose config` → EXIT=0 (YAML/compose spec hợp lệ); default services = `mongo, redis, mailpit`; `--profile full` thêm `be` (EXIT=0).
  - `docker compose up -d` → **FAILED**: daemon không chạy (`failed to connect to the docker API ... dockerDesktopLinuxEngine ... daemon is running`). ⇒ nghiệm thu "3 service healthy" **PENDING verify on a Docker host** (theo fallback tech-lead). Cú pháp compose đã pass qua `docker compose config`.
- Bảo mật: `.gitignore` loại `.env`/`.env.local`/`node_modules`/`dist`; không có secret/`.env` được tạo hay commit.
- Kết quả: R1 PASS · R2 PASS (config) / PENDING (healthy trên Docker host)
- Bàn giao cho: senior-reviewer

## [2026-09-28] senior-reviewer
- Đã làm: review R1–R2 (đọc `_handoff.md`, `_progress.md`, `tasks.md`, `review-techlead.md`, plan §1/§4). Đối chiếu từng file: `.gitignore`, `.editorconfig`, `.nvmrc`, `pnpm-workspace.yaml`, `package.json` gốc, `README.md`, `docker-compose.yml`, và 3 cặp `package.json`/`README.md` của `be`/`fe-admin`/`fe-sso-test`.
- Kiểm chứng: `pnpm-workspace.yaml` đủ 3 package ✓ · script gốc `dev:all`/`lint`/`typecheck`/`test` fan-out đúng (`--if-present --no-bail`) ✓ · `.nvmrc`=`v22.23.2` khớp `.node-version`=`v22.23.2` (đọc cả hai) ✓ · image pin `mongo:7`/`redis:7`/`axllent/mailpit:v1.21` ✓ · healthcheck `mongosh ... ping` + `redis-cli ping` đúng cú pháp/khớp §1.3 ✓ · port `27017/6379/1025/8025` khớp §1.2 ✓ · volume `mongo_data`/`redis_data` ✓ · profile `full` → `be` mặc định KHÔNG chạy ✓ · `.gitignore` loại `.env` + không secret hardcode ✓ · surgical: chỉ R1–R2, không lấn R3–R5/scaffold thật ✓.
- Ghi chú môi trường: Docker daemon off → "3 service healthy" PENDING verify on Docker host; `docker compose config` EXIT=0 nên KHÔNG fail (fallback tech-lead).
- Nit (không chặn): thiếu `start_period` healthcheck mongo/redis; `mailpit` chưa có healthcheck → chỉ `running` (tester lưu ý acceptance "3 service healthy" thực chất mongo/redis báo `healthy`).
- File đổi: `review-senior.md` (tạo mới), `_handoff.md`, `_progress.md`.
- Kết quả: **PASS**
- Bàn giao cho: tester — verify `docker compose up -d` + `docker compose ps` trên Docker host; chạy lại `pnpm i`/`dev:all`/`lint`/`typecheck`/`test`.

## [2026-09-28] tester
- Đã làm: kiểm thử R1–R2 theo tiêu chí nghiệm thu plan §4. Chạy lệnh thật, đọc output thực tế.
- Kết quả (chạy thật):
  - R1.1 `pnpm i` → `Scope: all 4 workspace projects`, EXIT=0 ✅
  - R1.2 `pnpm -r run typecheck` → fan-out 3/4, tất cả Done, EXIT=0 ✅
  - R1.3 `pnpm lint` → fan-out 3, tất cả Done, EXIT=0 ✅
  - R1.4 `pnpm dev:all` → 3 script `dev` fan-out song song, tất cả Done, tiến trình tự kết thúc (không treo), EXIT=0 ✅
  - R1.5 `.nvmrc` (`v22.23.2`) == `.node-version` (`v22.23.2`) ✅
  - R2.6 `docker compose config` → EXIT=0 (cú pháp hợp lệ) ✅
  - R2.7 `docker compose up -d` → FAILED (daemon off: `dockerDesktopLinuxEngine ... daemon is running`) ⇒ **PENDING (blocked: no Docker host)** — KHÔNG tính FAIL (fallback tech-lead/senior). Cú pháp đã pass ở case 6.
  - R2.8 `docker compose config --services` mặc định = `mailpit, mongo, redis` (KHÔNG có `be`); `--profile full` thêm `be` ✅
- File đổi: `test-report.md` (tạo mới), `tasks.md` (R1/R2 → `done`), `_progress.md`, `_handoff.md`.
- Kết quả: **PASS** (7/8 case xanh · 1 PENDING vì môi trường không có Docker host)
- Bàn giao cho: hoàn tất R1–R2. Ghi chú: cần verify "mongo/redis healthy" trên một Docker host (case R2.7 còn PENDING).

## [2026-09-28] orchestrator — đóng case PENDING R2.7
- Đã làm: Docker daemon nay đã chạy → verify lại case R2.7. `docker compose up -d` EXIT=0; `docker compose ps` cho thấy **mongo/redis/mailpit đều `(healthy)`** (mailpit có healthcheck sẵn trong image).
- File đổi: test-report.md (R2.7 PENDING → PASS, 8/8), _handoff.md (Trạng thái R1–R2 = DONE hoàn toàn), _progress.md
- Kết quả: **PASS (8/8)** — R1–R2 hoàn tất, không còn PENDING.
- Bàn giao cho: nhóm kế R3–R5 theo _run-plan.md.

## [2026-09-28] orchestrator — khởi tạo R3–R5
- Đã làm: sinh tasks R3–R5 vào tasks.md (từ plan §4 + §1.4). Ghi rõ ĐIỀU CHỈNH R3: agent workspace đã tồn tại ở `.github/agents/` + spec/plan ở `docs/agile/sso-idp/` → R3 chỉ verify+doc, KHÔNG dựng lại `.claude/agents/` hay root PROGRESS.md.
- Kiểm tra hiện trạng: chưa có `.github/workflows/`, chưa có `.env.example`, chưa có root PROGRESS.md.
- File đổi: tasks.md (thêm R3/R4/R5 + DoD), _handoff.md, _progress.md
- Kết quả: DONE (khởi tạo)
- Bàn giao cho: tech-lead — review tasks R3–R5

## [2026-09-28] tech-lead — review R3–R5
- Đã làm: review khả thi & kiến trúc tasks R3–R5; đối chiếu plan §1.4 + §4; kiểm hiện trạng repo thật (`.github/agents/` đủ 7 agent + HANDOFF-PROTOCOL; chưa có `.github/workflows/`, `.env.example`, `.gitleaks.toml`/pre-commit gốc; root `package.json` dùng `--if-present --no-bail`, lockfile tồn tại, `engines.node=22.23.2`).
- Đánh giá:
  - **R3 (điều chỉnh)**: HỢP LÝ — giữ verify+document, KHÔNG dựng lại `.claude/agents/`/`docs/spec.md`/root `PROGRESS.md` (tránh nguồn sự thật kép). Tinh thần plan §4 R3 đã đạt. Lưu ý dev: agent trỏ `spec.md` tương đối theo `docs/agile/<slug>/` (đừng hardcode slug); nhiều khả năng không cần thêm dòng nào.
  - **R4**: nghiệm thu "validate YAML + đối chiếu lệnh đã pass ở R1" CHẤP NHẬN ĐƯỢC (không có runner cục bộ). Đề nghị có bằng chứng validate YAML (actionlint/parse) trong test-report; dùng `node-version-file`.
  - **R5**: `.env.example` be/fe-admin/fe-sso-test KHỚP §1.4 từng biến. gitleaks/pre-commit khả thi trên Windows (cần Python; fallback binary/Docker; hoặc validate config như task cho phép).
- File đổi: review-techlead.md (GHI ĐÈ — nội dung R3–R5), _handoff.md, _progress.md
- Kết quả: **PASS** (R3 · R4 · R5) — không có rủi ro chặn; các lưu ý đều non-blocking. Phạm vi đúng (không lấn B*/A*/T*).
- Bàn giao cho: backend-dev — hiện thực R3 → R4 → R5

## [2026-09-28] backend-dev — hiện thực R3 → R4 → R5
- **R3 (agent workspace — verify + document)**:
  - Xác minh `.github/agents/` đủ **7 agent** (`analyst`, `tech-lead`, `backend-dev`, `frontend-dev`, `senior-reviewer`, `tester`, `orchestrator`) + `HANDOFF-PROTOCOL.md` + `README.md`. ✓
  - Grep chỉ dẫn đọc spec: `backend-dev`/`frontend-dev` đọc `spec.md` (bước 1); `senior-reviewer`/`tester` đối chiếu acceptance criteria trong `spec.md`; `analyst` tạo `spec.md` trong `docs/agile/<slug>/`; `orchestrator`/`tech-lead` vận hành theo `docs/agile/<slug>/` + HANDOFF-PROTOCOL. ⇒ **KHÔNG thêm dòng nào** (tất cả đã trỏ spec đúng, không hardcode slug).
  - File đổi: `README.md` — thêm mục **"Agent workspace"** (vị trí thực tế: agents `.github/agents/`, spec/plan + progress `docs/agile/<slug>/`).
- **R4 (CI GitHub Actions)** — tạo mới `.github/workflows/ci.yml`:
  - Trigger `push`+`pull_request` vào `develop`/`main`; `concurrency` group huỷ run cũ (`cancel-in-progress: true`); `permissions: contents: read` (least privilege).
  - Job `quality` (ubuntu-latest): checkout → `setup-node` (`node-version-file: .nvmrc`) → `corepack enable` → cache pnpm store (key theo `pnpm-lock.yaml`) → `pnpm i --frozen-lockfile` → `pnpm lint` → `pnpm -r run typecheck` → `pnpm test`.
  - Job `e2e` (khung): service containers `mongo:7`+`redis:7` với `--health-cmd/--health-interval/--health-timeout/--health-retries`; bước placeholder `echo "e2e: TODO enable at B7.1/X1"` (không đỏ). Comment nêu rõ bật thật ở B7.1/X1.
  - Comment đầu file: "chặn merge cần bật branch protection trên GitHub".
- **R5 (.env.example + secret scan + README 5 phút)**:
  - Tạo `be/.env.example` — ĐỦ biến §1.4: `NODE_ENV, PORT=4000, ISSUER=http://localhost:4000, MONGO_URI=mongodb://localhost:27017/sso-idp, REDIS_URL=redis://localhost:6379, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER=local (local|aws-kms|vault), KEY_LOCAL_DIR, SMTP_URL=smtp://localhost:1025, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL/PASSWORD, CSRF_SECRET, RATE_LIMIT_WINDOW/MAX`. Placeholder, không secret thật.
  - Tạo `fe-admin/.env.example` — server-only (`OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL=http://localhost:3000`) + client (`VITE_APP_NAME`), có ghi chú "server-only KHÔNG vào client bundle".
  - Tạo `fe-sso-test/.env.example` — `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI=http://localhost:5173/callback, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE="openid profile email", VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`.
  - Tạo `.pre-commit-config.yaml` gốc — hook `gitleaks` (repo `zricethezav/gitleaks`, rev `v8.21.2`, hook id `gitleaks`), dùng config mặc định.
  - Cập nhật `README.md` — mục "Chạy local trong 5 phút" (clone → cp `.env.example` cho 3 package, có cả lệnh Windows `Copy-Item`/`copy` → `pnpm i` → `docker compose up -d` → `pnpm dev:all`) + mục "Secret scan (pre-commit)" hướng dẫn `pre-commit install`.
- **Verify (chạy thật, đọc output)**:
  - `pnpm i --frozen-lockfile` → `Scope: all 4 workspace projects`, `Already up to date`, `Done in 90ms`, **EXIT=0** ✅ (lockfile hợp lệ cho CI).
  - Validate YAML: `python -c "import yaml"` → không có module `yaml`; `npx actionlint` → không phải npm package. Dùng **`js-yaml@4.1.0` qua `pnpm dlx`**: `.github/workflows/ci.yml` → **OK**, `.pre-commit-config.yaml` → **OK**, EXIT=0 ✅.
    - 🐞 **Phát hiện + sửa bug thật khi validate**: `run: echo "e2e: TODO enable ..."` chứa `: ` trong plain scalar → YAML hiểu nhầm thành mapping (`bad indentation of a mapping entry`). Đã **quote toàn bộ** value: `run: 'echo "e2e: TODO enable at B7.1/X1"'` → parse OK. (Cũng thử inline `options` nhưng giữ dạng folded `>-` sau khi fix run.)
  - `.pre-commit-config.yaml` parse OK (như trên).
  - gitleaks/pre-commit: `command -v gitleaks`/`pre-commit` → **CHƯA CÀI** trên máy này. Theo fallback task: chỉ validate YAML config (đã PASS) + ghi "tool chưa cài" (không chạy được `gitleaks detect`).
  - `.env.example` KHÔNG bị gitignore: `git check-ignore -v be/.env.example fe-admin/.env.example fe-sso-test/.env.example` → **EXIT=1** (không ignored); `git status` hiển thị `?? be/.env.example` (3 file untracked) ✅. `.gitignore` chỉ loại `.env`/`.env.local`.
- File tạo mới: `.github/workflows/ci.yml`, `be/.env.example`, `fe-admin/.env.example`, `fe-sso-test/.env.example`, `.pre-commit-config.yaml`.
- File cập nhật: `README.md` (Agent workspace + Chạy local 5 phút + Secret scan), `tasks.md` (R3/R4/R5 → `[x]`, Trạng thái → `in-review`), `_progress.md`, `_handoff.md`.
- Bảo mật: không commit secret thật; `.env.example` chỉ placeholder; `permissions: contents: read` cho workflow.
- Kết quả: R3 · R4 · R5 = **DONE (in-review)**.
- Bàn giao cho: senior-reviewer.

## [2026-09-28] senior-reviewer — review R3–R5
- Đã làm: review R3–R5 (đọc `_handoff.md`, `_progress.md`, `tasks.md` R3–R5, `review-techlead.md`, plan §1.2/§1.4/§4). Đối chiếu từng file thật: `ci.yml`, `be/.env.example`, `fe-admin/.env.example`, `fe-sso-test/.env.example`, `.pre-commit-config.yaml`, `README.md`, `.gitignore`.
- Kiểm chứng:
  - **R3**: `.github/agents/` đủ **7 agent** + HANDOFF-PROTOCOL + README (list_dir) ✓ · `file_search` cho `.claude/agents/**`, `docs/spec.md`, `**/PROGRESS.md` → **No files found** (không nhân đôi nguồn sự thật) ✓ · README mục "Agent workspace" nêu đúng layout thực tế, dùng `<slug>` động không hardcode ✓ · quyết định "verify+doc, không thêm dòng agent" hợp lý.
  - **R4**: `get_errors ci.yml` → No errors ✓ · trigger/concurrency/`permissions: contents: read` ✓ · job `quality` `.nvmrc`+corepack+cache+`--frozen-lockfile`+lint/typecheck/test ✓ (đã pass R1) · **bug YAML `e2e run:` đã fix ĐÚNG** (quote toàn bộ value) ✓ · job `e2e` service mongo:7/redis:7 healthcheck khớp §1.3, port §1.2, placeholder không đỏ ✓ · branch protection ghi README (ngoài repo) ✓.
  - **R5**: đối chiếu TỪNG biến §1.4 — `be` đủ 100% (KEY_PROVIDER ghi đúng `local|aws-kms|vault`, RATE_LIMIT_WINDOW/MAX) ✓ · `fe-admin` server-only KHÔNG prefix VITE_ + client `VITE_APP_NAME`, có comment không vào bundle ✓ · `fe-sso-test` đủ 7 biến VITE_* ✓ · không secret thật (toàn placeholder) ✓ · `.gitignore` loại `.env`/`.env.local` NHƯNG không loại `.env.example` ✓ · gitleaks config hợp lệ (`get_errors` No errors) ✓ · README 5 phút + Secret scan đủ luồng ✓.
- Nit (không chặn): TTL đơn vị chốt ở B1.2 (đã ghi chú); nghiệm thu "commit secret bị chặn" mới ở mức validate config (gitleaks chưa cài) → đề nghị tester thử `gitleaks detect` với secret giả; e2e health-cmd `\"` literal trong `>-` là đúng cho Docker, tester lưu ý khi bật thật ở B7.1/X1.
- File đổi: `review-senior.md` (GHI ĐÈ — nội dung R3–R5, giữ R1–R2 trong `<details>`), `_progress.md`, `_handoff.md`.
- Kết quả: **PASS** (R3 · R4 · R5) — không có 🔴 blocker, không có 🟡. Phạm vi đúng (không lấn B*/A*/T*).
- Bàn giao cho: **tester** — verify YAML/lệnh CI, thử gitleaks với secret giả nếu công cụ sẵn, chạy lại luồng README 5 phút.

## [2026-09-28] tester — verify R3–R5
- Đã làm: kiểm thử R3–R5 theo tiêu chí nghiệm thu (plan §1.4 + §4). Chạy lệnh thật, đọc output thực tế. 11/11 case xanh.
- Kết quả (chạy thật):
  - R3.1 `ls .github/agents/` → 7 `.agent.md` + HANDOFF-PROTOCOL.md ✅
  - R3.2 `.claude/agents/*` / `docs/spec.md` / root `PROGRESS.md` → No such file / No files found (không nhân đôi nguồn) ✅
  - R3.3 `grep -n "agent workspace" README.md` → dòng 99, bảng nêu đúng vị trí agents/spec/plan/progress ✅
  - R4.4 `pnpm dlx js-yaml@4.1.0 ci.yml` → YAML VALID EXIT=0 (actionlint/pyyaml không cài → dùng js-yaml) ✅
  - R4.5 grep job `quality`: node-version-file + corepack + `--frozen-lockfile` + lint + typecheck + test ✅
  - R4.6 grep job `e2e`: `mongo:7`+`redis:7` + `--health-cmd/--health-interval/--health-timeout/--health-retries` ✅
  - R5.7 3 `.env.example` đối chiếu §1.4 từng biến: be đủ 100% · fe-admin server+client đủ · fe-sso-test đủ 7 VITE_* ✅
  - R5.8 `git check-ignore .env.example` EXIT=1 (không ignored); `.env`/`.env.local` bị ignored đúng ✅
  - R5.9 `.pre-commit-config.yaml` js-yaml VALID + hook `gitleaks` (rev v8.21.2) ✅
  - R5.10 **secret scan THẬT**: gitleaks/pre-commit CHƯA cài, nhưng Docker RUNNING → `docker run zricethezav/gitleaks:v8.21.2 detect` trên file tạm chứa `-----BEGIN PRIVATE KEY-----` → `RuleID: private-key`, `leaks found: 1`, EXIT=1 (PHÁT HIỆN). Đã xoá file tạm. ⇒ **PASS (không PENDING)**. (Lưu ý: AWS example `AKIA...EXAMPLE` bị gitleaks allowlist → đổi sang private-key block.)
  - R5.11 `pnpm i --frozen-lockfile` EXIT=0 (lockfile hợp lệ cho CI) ✅
- File đổi: `test-report.md` (GHI ĐÈ — R3–R5, giữ R1–R2 trong `<details>`), `tasks.md` (R3/R4/R5 → `done`), `_progress.md`, `_handoff.md`.
- Kết quả: **PASS** (11/11 case xanh · 0 pending).
- Bàn giao cho: hoàn tất R3–R5. Không còn PENDING.

## [2026-09-28] orchestrator — khởi tạo B1.1–B1.5
- Đã làm: Phase R (M0) đã DONE (commit 8b75f24 + 4c2104a). Sang M1 Backend foundation. Sinh tasks B1.1–B1.5 vào tasks.md từ plan §5.B1 (bảng B1.1–B1.5) + spec §5 (cấu trúc thư mục) + §13. spec/plan KHÔNG ghi đè.
- Phạm vi lần chạy: B1.1 (scaffold NestJS+Fastify TS strict + ESLint/Prettier + cấu trúc §5), B1.2 (config fail-fast zod/joi typed), B1.3 (Pino+redact + /health + /ready + helmet + ValidationPipe + exception filter OAuth + graceful shutdown), B1.4 (Mongo Mongoose + Redis ioredis + Lua loader), B1.5 (crypto utils argon2/CSPRNG/sha256/constant-time/PKCE S256). B1.6–B1.10 để nhóm sau.
- Hiện trạng `be/`: mới có placeholder (`package.json` script echo, `README.md`, `.env.example`) — B1.1 sẽ scaffold thật thay placeholder.
- File đổi: tasks.md (thêm Phase B — B1.1–B1.5), _handoff.md, _progress.md
- Kết quả: DONE (khởi tạo)
- Bàn giao cho: tech-lead — review tasks B1.1–B1.5 (kiến trúc/khả thi)

## [2026-09-28] tech-lead — review B1.1–B1.5
- Đã làm: review kiến trúc & khả thi nhóm B1.1–B1.5. Đọc thật `_handoff.md`, `_progress.md`, `tasks.md` (Phase B), `plan.md` §5.B1/§1.4/§1.5/§2/§11/§12, `spec.md` §3/§5/§6.1-6.3/§13/§15, `be/package.json` + `be/.env.example` (placeholder hiện tại).
- Đánh giá:
  - **Phạm vi**: B1.1–B1.5 KHỚP plan §5.B1 + spec §5/§13; KHÔNG lấn B1.6–B1.10/B2/B3/B4 (module domain chỉ rỗng đủ build; Lua loader khung; crypto util không chạm KeyProvider/jose). ✓
  - **Thứ tự phụ thuộc**: B1.1→B1.2→{B1.3,B1.4} và B1.5←B1.1 hợp lý. ⚠️ Đề xuất **đảo B1.4 trước B1.3** (cả hai phụ thuộc B1.2) để nghiệm thu `/ready` mongo+redis verify được ngay — non-blocking.
  - **Nghiệm thu kiểm chứng được**: 4 điểm trọng tâm đều đo được — fail-fast config (bootstrap âm), redact INV-20 (assert log), `/ready` mongo+redis (503 khi down), PKCE S256 vector RFC 7636 (verifier `dBjftJeZ...` → challenge `E9Melhoa2Owv...`). ✓
  - **Rủi ro dev (non-blocking)**: gỡ Express + pin `@nestjs/*` cùng major (check lockfile); **argon2 native build Windows** → fallback `@node-rs/argon2`; chọn **zod** (type-infer, đồng bộ FE); module rỗng dùng stub `@Module({})` tránh lỗi "not a module"; không hardcode TTL/issuer (đọc config).
  - **plan §12**: rà Q1–Q9/D1–D12 → KHÔNG có quyết định nào chặn B1.1–B1.5 (Q6 TTL/Q9 tên project chỉ yêu cầu đọc từ config, không hardcode).
- File đổi: review-techlead.md (GHI ĐÈ — nội dung B1.1–B1.5, giữ lịch sử R trong `<details>`), _handoff.md, _progress.md
- Kết quả: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5)
- Bàn giao cho: **backend-dev** — hiện thực theo thứ tự B1.1 → B1.2 → B1.4 → B1.3 → B1.5

## [2026-09-28] backend-dev — hoàn tất B1.1–B1.5 + sửa bug bootstrap
- Đã làm: hiện thực xong B1.1–B1.5 (scaffold NestJS+Fastify TS strict, config fail-fast zod, Pino+redact+/health+/ready+helmet+ValidationPipe+exception filter OAuth+graceful shutdown, Mongo+Redis+Lua loader, crypto utils argon2/CSPRNG/sha256/constant-time/PKCE S256). Orchestrator verify runtime phát hiện **1 bug thật chặn nghiệm thu B1.3** → đã sửa surgical.
- 🐞 **Bug (chặn B1.3)**: app crash lúc bootstrap — `ERROR: The "class-validator" package is missing. Please, make sure to install it to use ValidationPipe.`; `curl /health` connection refused (exit 7); app KHÔNG listen.
  - **Nguyên nhân**: `main.ts` bật global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` nhưng `be/package.json` thiếu `class-validator` + `class-transformer` (NestJS ValidationPipe yêu cầu 2 package này lúc khởi tạo).
- ✅ **Fix (surgical)**: thêm `class-validator@0.14.2` + `class-transformer@0.5.1` vào `dependencies` của `be/package.json`; `pnpm i` cập nhật lockfile. KHÔNG sửa `main.ts` hay file nào khác.
- **Verify THẬT (đọc EXIT code + HTTP status, không giả định)**:
  - `pnpm i` (gốc) → EXIT=0, `Packages: +12 -7`, lockfile cập nhật ✅
  - `pnpm --filter @sso-idp/be typecheck` → EXIT=0 ✅
  - `pnpm --filter @sso-idp/be lint` → EXIT=0 ✅
  - `pnpm --filter @sso-idp/be test` → EXIT=0 (2 suite, 10/10 test PASS: crypto.util + pkce.util) ✅
  - `pnpm --filter @sso-idp/be build` → EXIT=0 ✅
  - Runtime (env tạm đầy đủ dựa `.env.example`; mongo:7@27017 + redis:7@6379 `(healthy)` qua docker compose):
    - App log: `Nest application successfully started` — **KHÔNG còn ERROR class-validator**, app listen thành công ✅
    - `curl -w %{http_code} /health` → **200** (`{"status":"ok"}`) ✅
    - `curl -w %{http_code} /ready` → **200** (`{"status":"ok","mongo":"up","redis":"up"}`) ✅
    - Đã `kill` app + `rm` env tạm sau verify. `git status`: chỉ `be/package.json` + `pnpm-lock.yaml` là file đổi thuộc fix này — **KHÔNG commit env tạm**.
- File đổi: `be/package.json` (thêm 2 dep), `pnpm-lock.yaml` (auto), `tasks.md` (B1.1–B1.5 checkbox `[x]`, Trạng thái `in-review`), `_handoff.md` (GHI ĐÈ), `_progress.md`.
- Kết quả: **DONE (dev)** — B1.1–B1.5 code + runtime verify PASS (/health 200, /ready 200).
- Bàn giao cho: **senior-reviewer** — review B1.1–B1.5.

## [2026-09-28] senior-reviewer — review B1.1–B1.5
- Đã làm: review chất lượng/đúng đắn/bảo mật/over-engineering nhóm B1.1–B1.5. Đọc thật `_handoff.md`, `_progress.md`, `tasks.md` (Phase B), `review-techlead.md`, `spec.md` §5/§13/§15 (INV-3/16/20), `plan.md` §1.4/§1.5/§5.B1. Đọc trực tiếp toàn bộ code `be/` liên quan: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `jest.config.js`, `main.ts`, `app.module.ts`, `config/*`, `common/logger/logger.module.ts`, `common/filters/oauth-exception.filter.ts`, `common/crypto/{crypto,pkce}.util.ts` + `.spec.ts`, `database/mongo/*`, `database/redis/*`, `modules/health/*`, module stub domain.
- Kiểm chứng (đọc code + grep + get_errors):
  - **Bảo mật**: redact INV-20 đủ 6 khoá + wildcard nested + header `authorization/cookie/set-cookie` (`remove:true`) ✓ · CSPRNG `randomBytes`, **không** `Math.random` (grep `src/**` rỗng, chỉ có trong comment/test) ✓ · constant-time `timingSafeEqual` + length guard ✓ · argon2id params OWASP (m=19456,t=2,p=1) ✓ · PKCE S256 vector RFC 7636 Appendix B pass ✓ · không secret hardcode; `.env.example` chỉ placeholder ✓.
  - **Đúng đắn**: fail-fast config zod báo tên biến ✓ · exception filter OAuth format `{error,error_description}` qua APP_FILTER ✓ · graceful shutdown (`enableShutdownHooks` + redis `quit()` + mongoose auto-close) ✓ · `/health` 200 / `/ready` 503-khi-down (status đúng) ✓.
  - **Cấu trúc**: khớp spec §5; module domain stub `@Module({})` KHÔNG import vào AppModule ✓ · Lua loader chỉ khung ✓ · không lấn B1.6+/B2+ ✓.
  - **Express**: `be/package.json` không có platform-express; trong lockfile là **optional peer** (`optional:true`), KHÔNG resolve (grep `platform-express@[0-9]` rỗng) ✓. argon2 fallback `@node-rs/argon2` (đúng khuyến nghị tech-lead Windows).
  - **Sạch**: `get_errors` 6 file lõi → No errors; không TODO/FIXME lơ lửng trong `src/`.
- 🟡 **2 điểm nên sửa (non-blocking)**:
  - #1 `/ready` khi down: `ServiceUnavailableException({status,mongo,redis})` bị `OAuthExceptionFilter` (`@Catch()`) map thành `{error:'server_error',error_description:'Service Unavailable'}` (payload per-dependency mất; HTTP 503 vẫn đúng). Runtime verify dev chỉ chứng minh nhánh 200. Đề xuất filter riêng cho health/ready hoặc trả 503 trực tiếp qua reply.
  - #2 `config.module.ts` gọi `validateEnv` 2 lần (`validate` + trong `load` factory) — thừa, idempotent, nên gộp.
- 💭 Nit: `REDIS_CLIENT` string token (cân nhắc Symbol); TTL đơn vị chốt Q6; filter map OAuth code tối giản (đúng, mở rộng ở B3/B4).
- File đổi: `review-senior.md` (GHI ĐÈ — nội dung B1.1–B1.5, giữ R3–R5 + R1–R2 trong `<details>`), `_handoff.md` (GHI ĐÈ), `_progress.md`.
- Kết quả: **PASS** (B1.1 · B1.2 · B1.3 · B1.4 · B1.5) — không có 🔴 blocker. Phạm vi đúng.
- Bàn giao cho: **tester** — verify B1.1–B1.5, ưu tiên nhánh 503 `/ready` (đọc status + body thực tế) để chốt 🟡 #1; INV-20 redact; PKCE vector; fail-fast config; Lua loader script mẫu; grep không còn Express.

## [2026-09-28] backend-dev — sửa bug `/ready` treo khi Redis down (chặn nghiệm thu B1.3)
- 🐞 **Bug (chặn B1.3)**: chạy app với `REDIS_URL=redis://localhost:6399` (port đóng), mongo up. `GET /health` → 200 (đúng); `GET /ready` → **TREO** (`curl -m 4` HTTP=000; log app `request aborted ... statusCode:null ... responseTime:3802ms`). Redis liên tục `Redis error` retry. Nghiệm thu B1.3 "/ready đỏ (503) khi Redis/Mongo down" KHÔNG đạt vì treo thay vì trả 503 nhanh.
- 🔎 **Nguyên nhân**: ioredis dùng `maxRetriesPerRequest: null` (hợp lý cho client long-lived) → khi Redis down, `ping()` bị **enqueue chờ reconnect vô hạn** thay vì fail nhanh. `RedisService.ping()` gọi trực tiếp không timeout; `health.controller.ts safePing()` bắt exception nhưng không bao timeout → chờ mãi.
- ✅ **Fix (surgical — chỉ 1 file `be/src/modules/health/health.controller.ts`)**:
  - Thêm hằng `PING_TIMEOUT_MS = 1500`.
  - Bọc `safePing()` bằng `Promise.race([ping(), timeout])` — `timeout` là `setTimeout(...,1500)` resolve `false`. Ping không phản hồi trong 1.5s → coi là down → `/ready` trả **503 nhanh**.
  - `clearTimeout` trong `finally`; gắn `ping.catch(() => undefined)` chống unhandled rejection từ promise ioredis còn treo (vẫn queued khi timeout thắng).
  - **KHÔNG** đổi `maxRetriesPerRequest` của client dùng chung (giữ nguyên cho data-access). KHÔNG chạm `redis.module.ts`/`redis.service.ts`/`mongo.service.ts`/`main.ts`.
- **Verify THẬT (đọc EXIT + HTTP status + time_total)**:
  - `pnpm --filter @sso-idp/be typecheck` → EXIT=0 ✅ · `lint` → EXIT=0 ✅ · `test` → EXIT=0 (2 suite, 10/10) ✅ · `build` → EXIT=0 ✅
  - Runtime (mongo:7@27017 + redis:7@6379 `(healthy)`; env tạm `be/.env` gitignored):
    - **Redis UP** (`redis://localhost:6379`): `/health` **200** (0.21s); `/ready` **200** `{"status":"ok","mongo":"up","redis":"up"}` (0.21s) — nhanh ✅
    - **Redis DOWN** (`redis://localhost:6399`, mongo up): `/health` **200** (0.22s); `/ready` **503** `{"error":"server_error","error_description":"Service Unavailable Exception"}` (**1.73s** — KHÔNG treo) ✅. Lặp 2 lần: 503 @ 1.73s / 1.71s (ổn định).
    - Đã kill app + free port 4000 (taskkill PID chiếm :4000). `git check-ignore be/.env` EXIT=0 → env tạm KHÔNG commit.
  - Ghi chú: body 503 vẫn qua `OAuthExceptionFilter` (🟡 #1 của senior — chỉ ảnh hưởng body, status 503 đúng; NGOÀI phạm vi task). Case mongo-down optional; mongoose chặn bootstrap khi mongo unreachable (lifecycle riêng, không thuộc bug readiness ping) — chưa verify lần này.
- File đổi: `be/src/modules/health/health.controller.ts` (source duy nhất), `_handoff.md` (GHI ĐÈ), `_progress.md` (append). `tasks.md` giữ B1.1–B1.5 `[x]`, Trạng thái `in-review`.
- Kết quả: **FIXED** — `/ready` trả 503 trong ~1.7s khi Redis down, không còn treo.
- Bàn giao cho: **tester** — verify lại nhánh 503 `/ready` (redis/mongo down → 503 trong ~1–2s, không treo) + nhánh 200 (up).

## [2026-09-28] tester — verify B1.1–B1.5 (Backend foundation)
- Đã làm: kiểm thử B1.1–B1.5 theo acceptance (`tasks.md` Phase B + `plan.md` §5.B1 + spec §13 + INV-20). **Chạy lệnh thật, đọc EXIT code / HTTP status / thời gian** — không giả định. Docker mongo:7+redis:7+mailpit `(healthy)`.
- Kết quả (9/9 case xanh, 0 fail, 0 pending):
  - **B1.1** — `typecheck` EXIT=0 · `lint` EXIT=0 · `build` EXIT=0 ✅. Không còn Express: `pnpm --filter @sso-idp/be why express` + `why @nestjs/platform-express` đều rỗng; `grep -c "platform-express@[0-9]" pnpm-lock.yaml` = 0 (chỉ optional peer không resolve); `be/package.json` không có express ✅
  - **B1.5** — `test` EXIT=0, **10/10 pass** (crypto.util + pkce.util). Vector **RFC 7636 Appendix B** có trong `pkce.util.spec.ts` (`dBjftJeZ...` → `E9Melhoa2Owv...`) ✅. `grep -rn "Math.random" src/` → chỉ ở TÊN TEST + COMMENT, KHÔNG dùng thật (CSPRNG `crypto.randomBytes`) ✅
  - **B1.2 fail-fast** — `ts-node validateEnv({})` → throw + liệt kê đủ 18 biến thiếu ✅. Bootstrap `node dist/main.js` thiếu `MONGO_URI` (move `.env` tạm) → `ERROR [ExceptionHandler] Invalid environment variables: - MONGO_URI: ...`, **REAL_APP_EXIT=1**, app KHÔNG listen ✅. Đã restore `be/.env`.
  - **B1.3 endpoints UP** — app listen (log `Redis connected` + `Nest application successfully started`); `/health` **200** @0.22s; `/ready` **200** `{"status":"ok","mongo":"up","redis":"up"}` @0.22s ✅
  - **B1.3 /ready Redis DOWN** (`REDIS_URL=redis://localhost:6399`, mongo up) — `/health` **200** @0.22s; `/ready` **503** @ **1.717s / 1.715s** (2 lần, KHÔNG treo) ✅. Body: `{"error":"server_error","error_description":"Service Unavailable Exception"}` (OAuth-format — xác nhận 🟡 #1 senior: chi tiết per-dependency bị `OAuthExceptionFilter` nuốt; status 503 vẫn ĐÚNG → acceptance đạt). `curl -m 6 -w "%{http_code} %{time_total}"`.
  - **B1.3 INV-20 redact** — runtime proof: chạy `pino` với REDACT_PATHS **y hệt** `logger.module.ts`, log object chứa bí mật (top-level + nested + header). Output: `nested:{}`, `req.headers:{}`, `username:"alice"` giữ lại; **0/10 giá trị bí mật lộ** (REDACT_EXIT=0) ✅. Cấu hình: đủ 6 khoá INV-20 + header `authorization/cookie/set-cookie` + `remove:true`.
  - **B1.4** — kết nối mongo/redis thật (gián tiếp qua `/ready` 200 `{"mongo":"up","redis":"up"}` + log connect). Lua loader `defineCommand`: verify thật với script mẫu `sampleEcho` (`return {KEYS[1],ARGV[1],42}`) trên Redis thật → `["mykey","myarg",42]` (LUA_EXIT=0) ✅
- Vệ sinh: đã kill app + free port 4000 sau mỗi runtime; restore `be/.env` (gitignored, `git check-ignore` EXIT=0 → KHÔNG commit); xoá mọi env/script proof tạm. `git status`: không có file test tạm — chỉ file B1.1–B1.5 thật + docs.
- KHÔNG sửa code sản phẩm (`be/src/**` không đổi) — đúng vai tester.
- File đổi: `test-report.md` (GHI ĐÈ — B1.1–B1.5, giữ R3–R5/R1–R2 trong `<details>`), `tasks.md` (B1.1–B1.5 → `done`), `_handoff.md` (GHI ĐÈ), `_progress.md` (append).
- Kết quả: **PASS** (9/9). B1.1–B1.5 hoàn tất.
- Bàn giao cho: hoàn tất B1.1–B1.5 → nhóm kế B1.6–B1.10. 🟡 mở (không chặn, ngoài phạm vi): #1 `/ready` 503 body OAuth-format (đề xuất filter riêng); #2 `validateEnv` gọi 2 lần lúc boot.
