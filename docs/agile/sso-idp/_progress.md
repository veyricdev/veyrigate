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
