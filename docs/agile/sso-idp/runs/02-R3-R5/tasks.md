# Tasks — R3–R5

Nguồn: `plan.md` §4 (Phase R) + §5.B1 (Backend foundation) + §1 (kiến trúc). Gồm **R1–R5** và **B1.1–B1.5**.
spec.md & plan.md đã có sẵn — KHÔNG ghi đè.

Trạng thái: `todo → in-progress → in-review → testing → done`.

---
## R3 — Agent workspace `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done

> ⚠️ **Điều chỉnh so với plan §4**: plan R3 giả định `docs/spec.md`, `docs/plan.md`, root `PROGRESS.md`, `.claude/agents/*`.
> Thực tế repo đã áp dụng layout khác và ĐÃ TỒN TẠI:
> - Spec/plan nằm ở `docs/agile/sso-idp/spec.md` + `plan.md` (KHÔNG phải `docs/spec.md`) — KHÔNG di chuyển/nhân đôi.
> - Agents nằm ở `.github/agents/*.agent.md` (analyst, tech-lead, backend-dev, frontend-dev, senior-reviewer, tester, orchestrator) + `HANDOFF-PROTOCOL.md` — KHÔNG tạo lại ở `.claude/agents/`.
> - Progress log theo tính năng: `docs/agile/sso-idp/_progress.md` + `_handoff.md` (thay cho root `PROGRESS.md`).
> → R3 chỉ còn **xác minh + tài liệu hoá** workspace agent, không dựng lại.

### Việc cần làm
- [x] Xác minh 7 agent tồn tại ở `.github/agents/` và mỗi agent có chỉ dẫn "đọc spec trước" (đối chiếu HANDOFF-PROTOCOL)
- [x] Nếu agent nào thiếu dòng "đọc `docs/agile/sso-idp/spec.md` trước khi làm" → bổ sung (surgical, chỉ thêm 1 dòng, không đổi hành vi khác) — KHÔNG cần thêm: cả 7 agent đã trỏ spec trong `docs/agile/<slug>/`
- [x] Ghi rõ trong README gốc (mục "Agent workspace") vị trí thực tế của spec/plan/agents/progress để không nhầm với đường dẫn trong plan §4

### Nghiệm thu (điều chỉnh từ plan §4)
- 7 agent tồn tại, mỗi agent trỏ đúng nguồn sự thật (spec ở `docs/agile/sso-idp/`)
- README nêu rõ layout agent workspace thực tế; không có file agent trùng lặp ở `.claude/agents/`

### Ghi chú
- KHÔNG tạo `docs/spec.md`/`docs/plan.md`/root `PROGRESS.md` mới (tránh nhân đôi nguồn sự thật).

---

## R4 — CI GitHub Actions `[BE]`

**Phụ thuộc**: R1  ·  **Size**: M  ·  **Trạng thái**: done

### Việc cần làm
- [x] `.github/workflows/ci.yml`:
  - Trigger: `push` + `pull_request` vào nhánh chính (`develop`/`main`)
  - Setup Node theo `.nvmrc` + `corepack enable` (pnpm), cache pnpm store
  - Job `quality`: `pnpm i --frozen-lockfile` → `pnpm lint` → `pnpm -r run typecheck` → `pnpm test` (fan-out, `--if-present` để không đỏ ở giai đoạn placeholder)
  - Job `e2e` (khung): service container `mongo:7` + `redis:7` với healthcheck; hiện tại chưa có test e2e → đánh dấu placeholder/skip rõ ràng, sẽ bật khi có B7.1/X1
- [x] Concurrency group để huỷ run cũ khi push mới
- [x] Ghi chú "chặn merge nếu đỏ" → cần bật branch protection ở GitHub (ngoài repo, ghi vào README)

### Nghiệm thu (plan §4)
- Workflow YAML hợp lệ (validate cú pháp); job `quality` chạy được `pnpm i --frozen-lockfile` + lint/typecheck/test không lỗi cấu hình
- Job `e2e` khai báo service mongo/redis với healthcheck đúng cú pháp
- Thời gian job hợp lý (cache pnpm)

### Ghi chú
- Không chạy được GitHub Actions cục bộ → verify = validate cú pháp YAML + đối chiếu lệnh với script gốc đã pass ở R1. Branch protection do người dùng bật trên GitHub.

---

## R5 — Quy ước secret + README chạy-trong-5-phút `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `.env.example` cho từng package theo plan §1.4 (KHÔNG chứa secret thật, chỉ tên biến + giá trị mẫu/placeholder):
  - `be/.env.example`: `NODE_ENV, PORT, ISSUER, MONGO_URI, REDIS_URL, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, SESSION_IDLE_TTL, SESSION_ABSOLUTE_TTL, KEY_PROVIDER, KEY_LOCAL_DIR, SMTP_URL, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, CSRF_SECRET, RATE_LIMIT_*`
  - `fe-admin/.env.example`: server (`OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, ADMIN_API_BASE_URL, ADMIN_API_RESOURCE, APP_URL`) + client (`VITE_*`)
  - `fe-sso-test/.env.example`: `VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI, VITE_OIDC_POST_LOGOUT_URI, VITE_OIDC_SCOPE, VITE_OIDC_RESOURCE, VITE_DEMO_API_URL`
- [x] Pre-commit secret scan (gitleaks): `.pre-commit-config.yaml` gốc dùng hook gitleaks (config mặc định); ghi hướng dẫn cài `pre-commit install` vào README
- [x] README gốc: mục "Chạy local trong 5 phút" (clone → cp .env.example → pnpm i → docker compose up -d → pnpm dev:all)

### Nghiệm thu (plan §4)
- Clone mới → làm theo README chạy được (đối chiếu các lệnh đã pass ở R1/R2)
- Commit chứa secret bị chặn (verify gitleaks bằng cách chạy `gitleaks detect`/pre-commit thử nếu công cụ có sẵn; nếu không có, validate cú pháp config)

### Ghi chú
- `.env.example` KHÔNG phải secret → được commit; `.env` thật đã bị `.gitignore` loại (R1).
- Danh sách biến bám plan §1.4; giá trị mẫu dùng localhost/placeholder.


## Definition of Done (áp cho R1–R5, rút gọn từ plan §10)
- Lint/cấu hình xanh; không TODO lơ lửng.
- `pnpm i` + `docker compose up -d` chạy được trên máy sạch (đã cài Docker + pnpm/Node theo `.nvmrc`).
- CI YAML hợp lệ; `.env.example` đủ biến theo §1.4; secret scan cấu hình đúng.
- Cập nhật `_progress.md` + `_handoff.md`.
