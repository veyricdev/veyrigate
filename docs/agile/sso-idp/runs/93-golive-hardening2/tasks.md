# Run 93 `93-golive-hardening2` — điều kiện go-live trong repo + nợ run 92 (M8, lane BE/FE/ops)

Nguồn: orchestrator, sau khi run 92 đóng (CI #48 xanh 8/8 trên `c9a9560`, CodeQL 0 mở). Go-live (1) smoke môi trường thật và DEBT-670 (Alertmanager thật) cần môi trường thật ⇒ ngoài phạm vi repo, không làm ở run này.

## Ràng buộc cứng (truyền nguyên cho mọi agent)
- **Hạ tầng:**
  - KHÔNG `compose up`.
  - KHÔNG tạo / restart container. Ngoại lệ duy nhất: Vault thử theo quy ước đã có.
  - Chỉ dùng `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1`, tách bằng tên DB hoặc db index riêng.
  - KHÔNG FLUSHALL / drop DB không phải của mình.
  - KHÔNG đụng `sso-idp` / `sso-idp-e2e`, ngoài phần setup của E2E.
- **File cấm:**
  - KHÔNG đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.
  - KHÔNG đọc, KHÔNG đụng `be/.env`, `be/keys`.
- **Secret:** KHÔNG in secret hay literal PEM header trong docs/log. Giá trị giống secret trên dòng mới phải dựng lúc chạy (gitleaks, D92.8).
- **Process:** KHÔNG Stop-Process / taskkill process không phải mình tạo.
- **Gói:** KHÔNG download, KHÔNG `npx` gói chưa cài.
- **Git:** KHÔNG commit / push (orchestrator làm), KHÔNG rewrite lịch sử git.
- **Chạy test:**
  - Scratch chỉ trong scratchpad riêng của agent.
  - Không chạy E2E song song với int: webServer E2E build lại `be/dist`.
  - Harness pentest (`be/scripts/pentest`) làm kẹt SMTP Mailpit local (DEBT-664) ⇒ chỉ chạy SAU E2E. Nếu SMTP không trả 220 ⇒ dừng và báo, KHÔNG restart container.

## Task

### T1 [FE/ops] DEBT-679 — client huỷ giữa response stream của app (SSR/BFF) không được làm chết `fe-admin/serve.mjs` — [x] xong lô A
Run 92 chỉ sửa cho asset tĩnh. Cần:
1. Test tái hiện: fixture route trả body `ReadableStream` lớn hoặc chậm; client (curl, như `serve-mjs-risk.test.ts`) đóng socket sau byte đầu.
2. Assert: process còn sống, log không có `ERR_INVALID_STATE`, request kế tiếp vẫn 200.
3. Đỏ ⇒ sửa ở `serve.mjs`: bắt lỗi stream / `process.on` có chọn lọc, không nuốt lỗi khác.
4. Xanh ngay từ đầu ⇒ ghi bằng chứng và đóng DEBT-679.

### T2 [e2e] DEBT-681 — `playwright.x3.config.ts` khởi động server dài hạn bằng `node` trực tiếp (cùng mẫu với `playwright.config.ts` run 92) — [x] xong lô A
- Comment ghi rõ giả thuyết pnpm và tiêu chí xác nhận: 3 dòng `Terminated the WebServer`.
- README ghi chú server không còn `NODE_PATH` của shim pnpm.
- Verify: `pnpm -C e2e e2e:x3` xanh 42.

### T3 [docs/ops] DEBT-258 — go-live (3)
Runbook không còn đặt URI Mongo có mật khẩu trên argv / dòng lệnh. Phạm vi: `runbook-ops.md` §0/§3c/§4a/§4b và mọi chỗ khác trong `docs/agile/sso-idp/runbook-*.md` + script ops nếu có.
- `mongodump` / `mongorestore`: dùng `--config=<file 0600>`.
- `mongosh`: `-u` + nhập mật khẩu qua prompt, hoặc biến môi trường đọc bằng `read -rs`.
- Script trong repo nhận URI qua env/file, không qua argv.
- Grep toàn repo tìm `mongodb://…:…@` trên argv trong docs/scripts (trừ placeholder test int/e2e không bí mật).

### T4 [ops/CI] DEBT-650 — harness pentest chạy trong CI — [x] code xong lô C (CI xác nhận ở D93.11)
Thêm job (hoặc step) dùng service Mongo replica set + Redis + Mailpit (cùng digest như job int/e2e), chạy `be/scripts/pentest/pentest.mjs`:
- Bỏ nhóm đo thời gian `AUTHN-ENUM-TIME-*`: không ổn định trên runner dùng chung; giữ chạy tay theo runbook-deploy §4 bước 0.
- Evidence là artifact CI, không commit.
- Có timeout.
- Không làm CI chậm quá mức (đo thời lượng).
- Xem cùng DEBT-658: fail giả `SHOULD-*` không được làm đỏ job.
- Tech-lead quyết: chạy mỗi push hay chỉ `workflow_dispatch` + lịch.

### T5 [BE/ops] nợ nhỏ run 92 — [x] xong lô D
- **DEBT-677:** chuyển `stringLogoutParams` lên trên khối JSDoc của `LogoutService`. Không đổi logic.
- **DEBT-676:** khoá drill/pentest có hiệu lực theo host. Đề xuất senior: `join(homedir(), '.vg-drill.lock')`, giữ `wx` + 0600, bỏ dòng `.gitignore` nếu không còn cần.
- **DEBT-674:** CodeQL `paths-ignore` / `query-filters` cho thư mục test.
  - Vẫn quét `src` / `scripts`.
  - Đo số cảnh báo trước/sau: chỉ đo được sau push; ghi rõ.

## Thứ tự lô (đề xuất, tech-lead chốt)
1. **A:** T1 + T2 (FE / e2e).
2. **B:** T3 (docs).
3. **C:** T4 (CI).
4. **D:** T5.
5. **E:** gate tester — be unit, int FULL, fe-admin, E2E ×1, X3. Harness đầy đủ chạy SAU E2E.
6. Orchestrator push và xác nhận CI xanh, kể cả job pentest mới.

## Quyết định D93.x (tech-lead fold, 2026-11-17; tiêu chí "dùng được ở production", người dùng ủy quyền)

Chi tiết lý do: `review-techlead.md`.

- **D93.1 (T1, DEBT-679).** Thêm ca vào `fe-admin/test/serve-mjs-risk.test.ts` trên fixture build sẵn có của test (thêm route vào fixture, không `vite build`). Ba ca:
  - (a) Route app trả `ReadableStream` chậm và lớn; client đọc byte đầu rồi `socket.destroy()`.
  - (b) Route passthrough body `fetch()` từ một upstream `node:http` cục bộ, chảy chậm (đường BFF proxy thật: body undici đi thẳng qua srvx); client huỷ sau byte đầu.
  - (c) Stream app gọi `controller.error()` giữa body (upstream reset).

  Mỗi ca assert:
  - `child.exitCode === null` sau ≥ 500 ms;
  - log không chứa `ERR_INVALID_STATE`;
  - `GET /healthz` kế tiếp trả 200.

  Xử lý theo kết quả:
  - **Xanh ngay:** ghi output vitest vào log.md, đóng DEBT-679, không sửa `serve.mjs`.
  - **Đỏ:** sửa `serve.mjs`, ưu tiên ở tầng stream (bắt lỗi của response đó).
  - **Chỉ khi** tầng stream không sửa được: dùng `process.on('uncaughtException')`, với điều kiện:
    - chỉ bắt `code === 'ERR_INVALID_STATE'`;
    - log 1 dòng cố định;
    - mọi lỗi khác: log rồi `process.exit(1)`;
    - kèm test âm: route fixture ném lỗi khác ngoài request (`setImmediate(() => { throw … })`) ⇒ process exit ≠ 0.

  Verify: `pnpm -C fe-admin test` (≥ 1654 + ca mới), typecheck fe-admin.

- **D93.2 (T2, DEBT-681).** BE webServer của `playwright.x3.config.ts`: đổi đoạn cuối `pnpm -C be start:e2e` thành `cd be && node node_modules/ts-node/dist/bin.js test/e2e/e2e-main.ts`. Các bước one-shot phía trước giữ pnpm. Hai vite và tls-proxy đã chạy bằng node.
  - Comment trong **cả hai** config ghi rõ:
    - cơ chế pnpm tách process group là **giả thuyết** (dựa CHANGELOG pnpm 12.6);
    - tiêu chí xác nhận là số dòng `pw:webserver Terminated the WebServer` với `DEBUG=pw:webserver`: **3** cho `playwright.config.ts` (CI #48), **4** cho X3 (4 webServer). Task ghi "3" là sai cho X3;
    - X3 không chạy trên CI ⇒ chỉ xác nhận trên Windows.
  - `e2e/README.md`: ghi chú server không còn `NODE_PATH`/`npm_*` của shim pnpm.

  Verify: `pnpm -C e2e typecheck` 0; `DEBUG=pw:webserver pnpm -C e2e e2e:x3` 42 passed, 4 dòng `Terminated`, sau đó cổng 4100/5273/5274/8443 trống. Không chạy song song với int.

- **D93.3 (T3, DEBT-258) — phạm vi chính xác** (grep trên HEAD `924cbd2`).
  - `runbook-ops.md:21` (§0): `mongosh "<MONGO_URI>"` ⇒ `mongosh "mongodb://<hosts>/<db>?replicaSet=rs0&authSource=admin" -u <user>`. URI không credential, mongosh tự hỏi mật khẩu.
  - `runbook-ops.md:31` (§0, khối cổng xác nhận) và `:387` (§4b bước 5): bỏ `export MONGO_URI='<uri>'`. Dòng đầu subshell thành `read -rs -p 'MONGO_URI: ' MONGO_URI && echo && export MONGO_URI`. Thêm 1 câu giải thích:
    - cả khối là một lệnh ghép, parse xong rồi mới chạy ⇒ `read` đọc bàn phím, không ăn dòng dán (cùng cơ chế với cổng `yes`);
    - biến chỉ sống trong subshell; `/proc/<pid>/environ` chỉ chính user/root đọc được (chấp nhận);
    - cách thay thế: `MONGO_URI="$(cat <file 0600>)"`.
  - `runbook-ops.md:247` (§3c, dev/test): `MONGO_URI` **và** `ADMIN_SEED_PASSWORD` đều nhập qua `read -rs`.
  - `runbook-deploy.md:68/79/113/524`: comment `mongosh <MONGO_URI>` và `mongosh "<MONGO_URI>/<DB>" --quiet --file …` ⇒ URI không credential + `-u <user>`.
  - `runbook-deploy.md:157` (§4 bước 0): cập nhật theo D93.4–D93.6. CI chạy harness không đo thời gian mỗi push; bản đầy đủ chạy tay với `--evidence docs/agile/sso-idp/runs/<run>/evidence`. Bỏ câu "Chưa có trong CI (DEBT-650)".
  - **Giữ nguyên** (ghi lý do vào log):
    - `runbook-ops.md:345`: nội dung file YAML 0600, không phải argv.
    - `ops/backup/mongo-{backup,restore}.sh`: dùng `--config` 0600; `--uri` chỉ nhận URI không có `@`; mongosh nhận qua stdin.
    - `be/scripts/docker-smoke.sh:62/242`: smoke, mật khẩu sinh theo lượt, truyền qua env/`docker run -e NAME`.
    - `release-checklist.md:329`: biên bản ký lịch sử.

  Nghiệm thu (ghi output vào log):
  - `grep -nE "export MONGO_URI='|mongosh \"?<MONGO_URI>|ADMIN_SEED_PASSWORD='" docs/agile/sso-idp/runbook-*.md` ⇒ 0 dòng.
  - `grep -rnE "mongodb://[^ /]*:[^ @]*@" docs/agile/sso-idp/runbook-*.md ops be/scripts` ⇒ chỉ còn `runbook-ops.md:345` và 2 dòng `docker-smoke.sh`.

  Đóng DEBT-258 ⇒ go-live (3) đạt ở mức repo.

- **D93.4 (T4) — cờ `--timing on|off`.** Mặc định `on`, giữ parser theo cặp hiện có, truyền vào `ctx`.
  - Khi `off`, trong `AUTHN`:
    - bỏ vòng đo 200+20 mẫu;
    - mỗi case (`login`, `forgot`, `register`, `register-unverified`) gửi 5 cặp exists/absent xen kẽ;
    - ghi check `must` `AUTHN-ENUM-SHAPE-<case>` = cùng status/body/headers (dùng `shapeOf`);
    - không ghi `AUTHN-ENUM-TIME-*`.
  - `evidence.profile.timing = 'off'` và log 1 dòng `timing checks skipped (--timing off, D93.4)`.
  - Phần còn lại của AUTHN và các nhóm khác giữ nguyên.
  - Mặc định `on` ⇒ lượt chạy tay không đổi.
  - Không thêm `--skip` tổng quát (YAGNI).

- **D93.5 (T4) — cờ `--evidence <dir>`.** Mặc định giữ `runs/90-X6-pentest-signoff/evidence`; `mutate.mjs` không đổi. Header comment và usage cập nhật cả hai cờ. Bộ lọc exposure D90.17 giữ nguyên: lỗi ⇒ không ghi file, exit 1.

- **D93.6 (T4) — job CI `pentest`** trong `.github/workflows/ci.yml`.
  - Trigger theo workflow (push + pull_request `develop`/`main`), **chạy mỗi push**.
  - `runs-on: ubuntu-latest`, `timeout-minutes: 15`, không `needs`, không thêm secret.
  - Service Redis + Mailpit và bước Mongo `docker run … --replSet rs0 -p 27017:27017` + `rs.initiate`: copy nguyên từ job `e2e`, cùng digest.
  - Setup node/pnpm/install giống `e2e`, rồi `pnpm -C be build`.
  - Bước chạy: `node be/scripts/pentest/pentest.mjs --timing off --evidence "$RUNNER_TEMP/pentest-evidence"`, `timeout-minutes: 10`.
  - `actions/upload-artifact` cùng SHA pin hiện dùng: `if: always()`, `name: pentest-evidence`, `retention-days: 14`, `if-no-files-found: warn`.
  - Comment trên job: lý do bỏ đo thời gian (DEBT-658) và đường chạy tay bản đầy đủ.
  - Exit: 0 xanh; 1/2 đỏ. Check `should` fail không đổi exit.

  Lô C **không chạy harness cục bộ** (ràng buộc DEBT-664). Verify lô C:
  - `node --check` 3 file;
  - sau `pnpm -C be build`: `--timing bogus` và `--evidence` thiếu giá trị ⇒ exit 1 kèm usage, trước mọi kết nối;
  - parse `ci.yml` bằng gói yaml đã cài trong `node_modules` (không có thì ghi rõ);
  - phần service/Mongo của job `pentest` giống hệt job `e2e`.

- **D93.7 (T5, DEBT-677 + DEBT-674).**
  - DEBT-677: chỉ di chuyển `stringLogoutParams` cùng doc của nó lên trên JSDoc class; diff thuần di chuyển.
  - DEBT-674: thêm input `config` (YAML inline) cho `codeql-action/init`, giữ `queries: security-extended`:
    ```
    paths-ignore: [be/test/**, fe-admin/test/**, fe-sso-test/test/**, e2e/**, '**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx']
    ```
    `be/src` (trừ spec colocated), `be/scripts`, `fe-admin/src`, `fe-sso-test/src`, `ops` vẫn được quét. Không dùng `query-filters`.
  - Log: trước = 0 mở / 40 đóng (run 92). Số sau chỉ đo được sau push: orchestrator ghi bằng `gh api repos/{owner}/{repo}/code-scanning/alerts`.

- **D93.8 (T5, DEBT-676).**
  - `LOCK_FILE = join(homedir(), '.vg-drill.lock')`, giữ `openSync(…, 'wx', 0o600)`.
  - Comment: một drill/pentest mỗi OS user trên host, mọi checkout; không chạy dưới sudo; drill không bao giờ chạy trên host production (chỉ hạ tầng dev 127.0.0.1).
  - Bỏ dòng `be/.vg-drill.lock` khỏi `.gitignore`.
  - `be/test/drills-lock.spec.ts`: child chạy với `HOME` và `USERPROFILE` trỏ vào thư mục tạm, không chạm `~/.vg-drill.lock` thật. Assert:
    - `LOCK_FILE` nằm dưới home giả, không ở `tmpdir()` gốc hay `BE_DIR`;
    - acquire lần hai ném lỗi;
    - mode 0600 trên POSIX.

  Verify: `pnpm -C be test` (≥ 1285), lint, typecheck be.

- **D93.9 — lô và agent.**
  - **A** (frontend-dev): T1 + T2.
  - **B** (backend-dev): T3, chỉ docs, chạy **song song** với A.
  - **C** rồi **D** (backend-dev, một phiên tuần tự): T4 rồi T5. C bắt đầu **sau khi A xong `e2e:x3`** (X3 build lại `be/dist`).
  - Senior review mỗi lô theo giao thức.

- **D93.10 — gate E (tester), thứ tự cố định.**
  1. be unit; int FULL; fe-admin; E2E ×1 (53); X3 (42).
  2. `pnpm -C be build && timeout 10m node be/scripts/pentest/pentest.mjs --timing off --evidence docs/agile/sso-idp/runs/93-golive-hardening2/evidence` (lượt này ít thư).
  3. Kiểm SMTP 1025 trả 220.
  4. `timeout 25m node be/scripts/pentest/pentest.mjs --evidence docs/agile/sso-idp/runs/93-golive-hardening2/evidence` (lượt đầy đủ).

  Bước 3 không trả 220 ⇒ dừng và báo, KHÔNG restart container, lượt đầy đủ hoãn cho người dùng.

  Kỳ vọng: cả hai lượt exit 0, `must` fail 0. Số `must` lượt `off` = lượt đầy đủ − 4 `TIME` + 4 `SHAPE`.

- **D93.11 — xác nhận CI (orchestrator).** CI xanh gồm job `pentest`. Ghi lại:
  - thời lượng job (kỳ vọng ≤ 8 phút, không kéo dài wall-clock so với `e2e`);
  - artifact `pentest-evidence` có mặt, `summary.must.fail = 0`, `profile.timing = 'off'`.

  Sau đó:
  - đóng DEBT-650;
  - DEBT-658 giữ mở (bootstrap khoảng tin cậy), ghi chú `should` không đổi exit;
  - thêm `pentest` vào danh sách required checks người dùng cần bật (STATUS "Việc tiếp theo").

- **D93.12 — DEBT mới.** DEBT-682 💭: chạy `mutate.mjs all` trong CI khi PR đổi `be/scripts/pentest/**`. Không làm ở run 93.
