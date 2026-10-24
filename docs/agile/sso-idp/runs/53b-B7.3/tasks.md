# Tasks — run 53b — B7.3 phần 2: `be/Dockerfile` (M7, lane BE)

> Kế hoạch đã được tech-lead fold ở run 53: `runs/53-B7.3/tasks.md` mục **"Kế hoạch 53b — `be/Dockerfile`"** — ĐỌC NGUYÊN VĂN, là ràng buộc của run này (orchestrator không gọi lại tech-lead vì plan đã duyệt). Khuôn: run 52 (`fe-admin/Dockerfile`, `Dockerfile.dockerignore`, `scripts/docker-smoke.sh`, CI `fe-admin-image`). Image phụ trợ smoke (mongo/redis) chọn bản ≥14 ngày, ghim digest lúc làm; Vault dùng `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55`. Gộp DEBT-384 (listen lỗi thoát 0 — áp cho cả `serve.mjs`) và DEBT-385 (dockerignore fe-admin mở rộng) vì cùng khuôn.
>
> Hạ tầng: chỉ tên tạm `vg-b73b-*`, `vg-be-smoke-*`, cổng `127.0.0.1:4400`; dọn đúng tên; CẤM prune/wildcard/compose/push; không đụng `aegate-*`/`vg-test-*`/`funny_pascal`. Không đụng `be/keys`, `be/.env`.

### [x] Task 1 [BE/ops]: `be/Dockerfile` + `be/Dockerfile.dockerignore` + `be/scripts/docker-smoke.sh` + CI job `be-image` (không push) theo kế hoạch 53b; mutation như run 52.
### [x] Task 2 [FE/ops]: DEBT-385 (`fe-admin/Dockerfile.dockerignore` loại `**/.env*`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/.npmrc`) + DEBT-384 (`fe-admin/serve.mjs` listen lỗi ⇒ log mã lỗi + exit 1) + smoke fe-admin vẫn 13/13.
### [x] Task 3 [docs]: runbook-deploy mục BE image (env, Vault Agent token file, healthcheck `/health` vs `/ready`).
