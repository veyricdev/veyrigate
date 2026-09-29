# Senior Review — 2026-09-28 (R3–R5)

## Kết luận: **PASS** (R3 · R4 · R5)

Không còn 🔴 blocker. Đã đối chiếu từng file với `plan.md` §1.2/§1.4/§4 và hiện trạng repo thật. Phạm vi đúng (chỉ R3–R5, không lấn B*/A*/T*).

---

## Tổng quan (R3–R5)

Vòng R3–R5 làm gọn và đúng nguyên tắc surgical:

- **R3** chọn "verify + document" thay vì dựng lại — tránh nguồn sự thật kép, đúng với layout đang vận hành.
- **R4** `ci.yml` cấu trúc rõ, least-privilege, cache pnpm hợp lý, e2e để placeholder không đỏ.
- **R5** `.env.example` bám sát §1.4 từng biến, tách server/client đúng, chỉ chứa placeholder.

Điểm tốt nổi bật: bug YAML `run:` chứa `: ` trong plain scalar đã được backend-dev phát hiện + fix (quote toàn bộ value) khi validate bằng `js-yaml` — đúng tinh thần "verify thật, đọc output".

---

## R3 — Agent workspace (verify + document)

**PASS.** Kiểm chứng:

- `.github/agents/` có **đủ 7 agent** (`analyst`, `tech-lead`, `backend-dev`, `frontend-dev`, `senior-reviewer`, `tester`, `orchestrator`) + `HANDOFF-PROTOCOL.md` + `README.md`. Đếm trực tiếp thư mục ✓
- **KHÔNG** tạo `.claude/agents/*`, `docs/spec.md`, hay root `PROGRESS.md` — `file_search` cho cả 3 đều "No files found" ✓ (tránh nguồn sự thật kép — đúng cảnh báo INV/rủi ro).
- Thư mục `.github/agents/.claude/` là artefact của skills, KHÔNG phải bản agent trùng — không cần xử lý ✓
- `README.md` mục **"Agent workspace"** nêu đúng vị trí thực tế: agents `.github/agents/`, spec/plan `docs/agile/<slug>/`, progress `_progress.md`/`_handoff.md`; ghi rõ "không dùng `docs/spec.md` hay root `PROGRESS.md`". Dùng `<slug>` động, không hardcode ✓
- Quyết định "không thêm dòng nào cho agent" hợp lý: các agent đã trỏ spec trong thư mục tính năng theo HANDOFF-PROTOCOL.

Quyết định điều chỉnh R3 (chỉ document) **đúng** — khớp đánh giá tech-lead.

---

## R4 — CI GitHub Actions (`.github/workflows/ci.yml`)

**PASS.** Kiểm chứng:

- YAML hợp lệ: `get_errors` trên `ci.yml` → **No errors found**; backend-dev đã validate bằng `js-yaml@4.1.0` EXIT=0.
- Trigger `push`+`pull_request` vào `develop`/`main` ✓ · `concurrency` (`cancel-in-progress: true`) ✓ · `permissions: contents: read` (least privilege) ✓
- Job `quality`: `checkout@v4` → `setup-node@v4` với `node-version-file: .nvmrc` ✓ → `corepack enable` (trước khi gọi `pnpm`) ✓ → cache pnpm store (key theo `hashFiles('pnpm-lock.yaml')`) ✓ → `pnpm i --frozen-lockfile` → `pnpm lint` → `pnpm -r run typecheck` → `pnpm test`. Các lệnh đều đã PASS thật ở R1; root scripts dùng `--if-present --no-bail` ⇒ không đỏ ở giai đoạn placeholder ✓
- **Bug YAML `e2e` đã fix ĐÚNG**: `run: 'echo "e2e: TODO enable at B7.1/X1"'` — value quote toàn bộ, `: ` không còn bị hiểu nhầm thành mapping. Đọc file xác nhận ✓
- Job `e2e`: service `mongo:7`+`redis:7` với `--health-cmd/--health-interval/--health-timeout/--health-retries` qua folded scalar `>-`; port map đúng §1.2 (27017/6379). Health-cmd `mongosh ... ping` + `redis-cli ping` khớp §1.3 ✓ Bước chỉ là placeholder → **không đỏ**, comment nêu bật thật ở B7.1/X1 ✓
- "Chặn merge khi CI đỏ" xử lý đúng: comment đầu file + README ghi cần bật branch protection trên GitHub (thao tác ngoài repo) ✓

---

## R5 — `.env.example` + secret scan + README 5 phút

**PASS.** Đối chiếu **từng biến** với plan §1.4:

**`be/.env.example`** — đủ 100% §1.4: `NODE_ENV, PORT=4000, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER(local|aws-kms|vault ghi đúng chú thích), KEY_LOCAL_DIR, SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_WINDOW/MAX`. ✓ Port/URL khớp §1.2.

**`fe-admin/.env.example`** — đủ §1.4, tách nhóm rõ:
- Server-only: `OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL` — **KHÔNG** prefix `VITE_` ✓ (biến nhạy cảm không lọt bundle client — đúng INV env-validation A2).
- Client: `VITE_APP_NAME` (không nhạy cảm) ✓
- Có comment "KHÔNG đưa vào client bundle" cho nhóm server ✓

**`fe-sso-test/.env.example`** — đủ §1.4: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`. ✓ Tất cả `VITE_*` (public client) đúng bản chất.

**Bảo mật (INV-20 tinh thần) — PASS**: không có credential thật. Tất cả là placeholder (`your-*`, `change-me`, `replace-with-random-32-bytes`) hoặc localhost URL. `.gitignore` loại `.env`/`.env.local` nhưng KHÔNG loại `.env.example` (đọc `.gitignore` xác nhận; `git check-ignore` EXIT=1) ⇒ mẫu được commit, secret thật thì không ✓

**gitleaks config (`.pre-commit-config.yaml`)** — hợp lệ: repo `zricethezav/gitleaks`, `rev: v8.21.2`, hook `id: gitleaks`; `get_errors` → No errors found. Header ghi hướng dẫn cài ✓

**README** — mục "Chạy local trong 5 phút" (clone → cp `.env.example` cho 3 package, có lệnh macOS/Linux + Windows PowerShell + cmd → `pnpm i` → `docker compose up -d` → `pnpm dev:all`) + mục "Secret scan" (`pre-commit install` + `pre-commit run gitleaks`). Luồng khớp lệnh đã pass ở R1/R2 ✓

---

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

Không có (đều đã được xử lý đúng).

## 💭 Nit (không chặn, để tester/vòng sau cân nhắc — KHÔNG yêu cầu sửa ở R3–R5)

- `be/.env.example`: các TTL đang là số giây thô (`ACCESS_TOKEN_TTL=900`...); B1.2 chốt schema sẽ quyết định đơn vị/định dạng — hiện comment đã ghi "chốt ở B1.2", chấp nhận được.
- Nghiệm thu R5 "commit chứa secret bị chặn" mới ở mức **validate config** (gitleaks/pre-commit chưa cài trên máy dev). Đề nghị **tester**: nếu cài được gitleaks, tạo 1 file secret giả rồi chạy `gitleaks detect` để chứng minh chặn thật; nếu không, ghi rõ lý do môi trường trong `test-report.md`.
- `e2e` health-cmd trong folded scalar dùng `\"` literal (YAML không xử lý escape trong `>-`) — đây là hành vi đúng cho `--health-cmd` của Docker trên runner; chỉ lưu ý khi tester bật e2e thật ở B7.1/X1 rằng cần xác minh healthcheck chạy trên GitHub runner.

---

## Bàn giao

→ **tester**: verify `ci.yml` (validate YAML/actionlint nếu có; đối chiếu lệnh đã pass R1); thử `gitleaks detect` với secret giả nếu công cụ sẵn; chạy lại luồng README 5 phút. R3–R5 = **PASS**, sẵn sàng kiểm thử.

