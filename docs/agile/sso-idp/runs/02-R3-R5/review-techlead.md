# Tech Lead Review — 2026-09-28 (R3–R5)

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
