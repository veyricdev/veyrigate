# Senior Review — 2026-09-28 (R3–R5)

## Kết luận: **PASS** (R3 · R4 · R5)

Không còn 🔴 blocker. Đã đối chiếu từng file với `plan.md` §1.2/§1.4/§4 và hiện trạng repo thật. Phạm vi đúng (chỉ R3–R5, không lấn B*/A*/T*).

---

## Tổng quan

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

---

<details>
<summary>Vòng trước — Senior Review R1–R2 (giữ nguyên để tham chiếu)</summary>

# Senior Review — 2026-09-28 (R1–R2)

## Kết luận: **PASS**

Phạm vi R1 (monorepo pnpm workspace + script gốc) và R2 (docker-compose mongo/redis/mailpit + healthcheck + profile `full`) khớp `plan.md` §1 và §4, đối chiếu đủ tiêu chí. Không còn 🔴 blocker. Chuyển sang **tester** để xác nhận "3 service healthy" trên Docker host.

## Tổng quan
Diff gọn, kỷ luật, đúng "chỉ dựng khung — scaffold thật ở B1.1/A1/T1". Không lấn R3–R5 (không có CI/gitleaks/.env.example), không scaffold app thật. Placeholder tối giản, đủ để `pnpm-workspace` nhận diện. Config khớp nguồn sự thật gần như 1:1 với plan §1.3. Verify thật đã ghi trong handoff (`pnpm i` 4 project, `typecheck`/`lint` EXIT=0, `docker compose config` EXIT=0).

Điểm tốt cụ thể:
- `pnpm-workspace.yaml` liệt kê đủ 3 package (`be`, `fe-admin`, `fe-sso-test`) — khớp §1.1.
- Script gốc `dev:all`/`lint`/`typecheck`/`test` fan-out đúng; `--if-present --no-bail` xử lý đúng giai đoạn khung (theo đề xuất tech-lead), tránh false-negative.
- `.nvmrc` (`v22.23.2`) **khớp** `.node-version` (`v22.23.2`) — đã đọc cả hai file.
- docker-compose: image pin (`mongo:7`, `redis:7`, `axllent/mailpit:v1.21`); healthcheck `mongosh --quiet --eval db.adminCommand('ping')` và `redis-cli ping` đúng cú pháp và khớp §1.3; port `27017/6379/1025/8025` đúng §1.2/§1.3; volume `mongo_data`/`redis_data`.
- Profile `full` đặt trên service `be` → mặc định `docker compose up -d` KHÔNG chạy `be` (đúng yêu cầu). `depends_on ... service_healthy` khai báo khung hợp lý; `be/Dockerfile` để B7.3.
- Bảo mật: `.gitignore` loại `.env`/`.env.local`; không secret hardcode trong compose/package.json.

## 🔴 Blocker
- Không có.

## 🟡 Nên sửa
- Không có (trong phạm vi R1–R2). Các điểm dưới là 💭 nit, không chặn PASS.

## 💭 Nit
- `docker-compose.yml:9-13` — healthcheck mongo/redis đã có `interval`/`retries` khớp plan nhưng thiếu `start_period`. Mongo lần đầu init hơi lâu; thêm `start_period: 10s` sẽ giảm nguy cơ container bị đánh dấu `unhealthy` tạm thời lúc khởi động. Không bắt buộc vì `retries: 5 × interval 10s` đã đủ dung sai.
- `docker-compose.yml` — cân nhắc thêm healthcheck cho `mailpit` (vd. HTTP `/livez` hoặc `/readyz` cổng 8025) để tiêu chí "3 service healthy" của R2 áp được cho cả `mailpit`. Plan §1.3 không yêu cầu, nên đây chỉ là gợi ý; hiện `mailpit` không có healthcheck nên `docker compose ps` sẽ không hiện `healthy` cho nó. Tester lưu ý: acceptance "3 service healthy" thực chất chỉ mongo/redis báo `healthy`; mailpit chỉ `running` — vẫn coi là đạt.
- `package.json` (gốc) — `packageManager: pnpm@12.6.0` cố định là tốt cho reproducibility; nếu môi trường CI (R4 sau này) dùng bản pnpm khác sẽ cần đồng bộ. Ghi nhận để R4.

## Ghi chú môi trường
- Docker daemon tắt trên máy dev → tiêu chí R2 "3 service healthy" **PENDING verify on a Docker host**. `docker compose config` đã EXIT=0 (cú pháp/compose spec hợp lệ). Theo fallback tech-lead, KHÔNG coi là fail → không ảnh hưởng kết luận PASS.

## Bàn giao
- Cổng: **senior** → Kết quả: **PASS**
- Tiếp theo: **tester** — chạy `docker compose up -d` + `docker compose ps` trên Docker host xác nhận `mongo`/`redis` đạt `healthy`; chạy lại `pnpm i` + `pnpm dev:all`/`lint`/`typecheck`/`test` xác nhận fan-out không lỗi.

</details>
