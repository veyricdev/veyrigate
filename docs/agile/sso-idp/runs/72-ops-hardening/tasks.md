# Tasks — run 72 — compose prod mẫu chạy non-root + Dependabot (M7, lane ops)

> Nguồn: `backlog.md` (đọc nguyên văn): DEBT-405 (`ops/compose/prod.example.yml` `x-hardening` `read_only` + `cap_drop: [ALL]` cho redis master/replica/sentinel/vault-agent — run 53c đã thêm `user:` một phần nhưng **chưa từng chạy**), DEBT-466 / Q62.1 (digest base image + `.nvmrc` chỉ làm mới bằng tay). Quyết định đã chốt `plan.md` §12 "Chốt bổ sung 2026-11-06": dịch vụ hardening chạy non-root với `user:` tường minh, chứng minh bằng smoke; bật Dependabot (`.github/dependabot.yml`: npm, docker, github-actions; hằng tuần; nhóm minor/patch; `cooldown` ≥ 14 ngày; bản sửa bảo mật không chờ). Bối cảnh: run 53b/53c (`be/Dockerfile`, Sentinel), run 52 (fe-admin Dockerfile), run 62 (quy tắc ≥ 14 ngày).
>
> Tech-lead: xác minh bằng chạy thật — KHÔNG dùng `docker compose up` (ràng buộc người dùng). Thay vào đó `docker compose -f ops/compose/prod.example.yml config` để lấy cấu hình đã resolve, rồi `docker run` TỪNG dịch vụ hardening (redis master/replica/sentinel, vault-agent nếu khả thi không cần Vault thật — hoặc chứng minh tới bước entrypoint) với đúng cờ tương đương (`--user`, `--read-only`, `--cap-drop ALL`, tmpfs, `--security-opt no-new-privileges`), tên container `vg-r72-*`, network riêng `vg-r72-net`, xoá đúng tên khi xong. Dependabot: schema hợp lệ (cú pháp `cooldown` đúng tài liệu GitHub hiện hành; ecosystem đúng thư mục: root pnpm workspace, `be/Dockerfile`, `fe-admin/Dockerfile`, `.github/workflows`); không chạm `.github/agents`. Cách chứng minh: log khởi động từng container, `redis-cli PING`/replication/sentinel `master` thật giữa các container, uid tiến trình ≠ 0; validate dependabot.yml (schema JSON chính thức nếu tải được — hỏi orchestrator nếu cần tải file).
>
> Ràng buộc: KHÔNG `docker compose up`; KHÔNG FLUSH/drop/đụng `aegate-*`/`vg-test-*` (ngoài `docker start` vg-test-*); container/network chỉ tên `vg-r72-*`, xoá đúng tên, không prune/wildcard; image pull chỉ đúng tag/digest đã pin trong repo; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; không in secret; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` người dùng; không commit, không push.

### [x] Task 1 [ops]: DEBT-405 — `prod.example.yml` dịch vụ hardening khởi động được non-root (sửa theo kết quả smoke) + runbook.
### [x] Task 2 [ops]: DEBT-466 — `.github/dependabot.yml` (npm, docker, github-actions; cooldown ≥ 14 ngày; security không chờ).

## § Fold tech-lead (2026-11-06) — BẮT BUỘC đọc trước khi làm

### A. Kết quả đo DEBT-405 (đã chạy thật, đã xoá sạch `vg-r72-*`)

Môi trường: Docker 28.5.1 (Desktop, containerd image store), Compose v2.40.2. Bản sao `prod.example.yml` + `vault-agent.hcl` ở scratchpad (`<bytes>`→`64mb`, `secrets/*` mật khẩu ngẫu nhiên `openssl rand`, `be.env` rỗng). Trong repo `docker compose -f ops/compose/prod.example.yml config` exit 1 **chỉ** vì thiếu `secrets/be.env` (cố ý); bản sao exit 0, resolved đủ `read_only`/`cap_drop`/`no-new-privileges`/`user:`/tmpfs/volume. Rồi `docker run` từng dịch vụ với cờ tương đương (`--read-only --cap-drop ALL --security-opt no-new-privileges:true --user …`, tmpfs, secret bind `:ro`, named volume, network `--internal vg-r72-net`, alias = hostname compose), image đúng digest repo (`redis:7.4.10-bookworm@sha256:e9b2e45e…`, `hashicorp/vault:2.1.2@sha256:c2f66626…`):

| Dịch vụ | Khởi động | PID 1 (`/proc/1/status`) | Chức năng |
|---|---|---|---|
| redis-master (999:999) | ✅ | Uid/Gid 999, `CapEff 0`, `NoNewPrivs 1` | PING, SET OK, `connected_slaves:2` online; AOF ghi được `/data` (volume mới kế thừa owner 999 từ image) |
| redis-replica-1/2 (999:999) | ✅ | như trên | `master_link_status:up`; SET ⇒ `READONLY` (đúng) |
| redis-sentinel-1/2/3 (999:999, tmpfs `/etc/sentinel` uid 999 0700) | ✅ | như trên | `sentinel.conf` 0600 999; `get-master-addr-by-name idp` = `redis-master`; `ckquorum` "3 usable Sentinels"; peer flags `sentinel` (không s_down) — **không cần** `sentinel sentinel-pass` |
| Failover (stop master) | ✅ | — | 6 s ⇒ `+odown #quorum 3/2` ⇒ `+switch-master … redis-replica-2`; master cũ `start` lại ⇒ replica của replica-2, 2 replica online, SET trên master mới OK, GET từ master cũ OK |
| vault-agent (100:1000) + Vault dev throwaway `vg-r72-vault` (AppRole, root token ngẫu nhiên không in) | ✅ | Uid 100, Gid 1000, `CapEff 0`, `NoNewPrivs 1` | token sink sau 1 s; `/run/vault` `0750 100:1000`, file `0440 100:1000`; health `healthy`; reader `--user 1000:1000` (như be, mount `:ro`) đọc được + `vault token lookup` OK; ghi ⇒ Read-only; uid 1001 ⇒ bị từ chối |
| vault-agent khi Vault không tới được | chạy, retry backoff | — | 8 s không có token ⇒ healthcheck không healthy ⇒ `be` (`service_healthy`) không khởi động = fail-closed ✅ |

Phát hiện phụ (không chặn):
1. Image vault 2.1.2 mặc định `User=vault`; entrypoint khi non-root **bỏ qua** `SKIP_SETCAP`/`SKIP_CHOWN` và in "Container is running as non-root user, ignoring SKIP_…" ⇒ 2 biến vô dụng.
2. Sau failover Redis log `CONFIG REWRITE failed: Read-only file system` (Sentinel gửi trong MULTI; không chặn failover). Hệ quả: vai trò mới chỉ ở RAM; node khởi động lại quay về vai trò command line rồi Sentinel cấu hình lại; master cũ khởi động lại chưa có replica ⇒ `min-replicas-to-write 1` ⇒ `NOREPLICAS` (không nhận ghi lệch).
3. Docker Desktop hiển thị secret bind mount `0777 root` ⇒ quyền file host **không đo được** ở đây. Trên Linux bind mount giữ owner/mode host ⇒ runbook phải ghi lệnh `chown/chmod` cụ thể.
4. `docker image inspect <repo>@sha256:<index>` trên containerd store trả config rỗng ⇒ kiểm uid bằng `docker create` + `docker inspect` container (hoặc `docker run --rm --entrypoint id …`).

### B. Quyết định & điểm sửa

**Task 1 (DEBT-405) — chỉ tài liệu/comment + xoá biến vô dụng, không đổi hành vi:**
- `ops/compose/prod.example.yml`:
  - Xoá khối `environment:` (`SKIP_SETCAP`, `SKIP_CHOWN`) của `vault-agent` (phát hiện 1); comment: non-root ⇒ entrypoint không chown/setcap/su-exec; agent không mlock ⇒ không `IPC_LOCK`.
  - Header: thay câu "THIS EXAMPLE HAS NOT BEEN STARTED…" bằng: đã smoke run 72 bằng `docker run` tương đương (không `compose up`) — uid ≠ 0, CapEff 0, replication, failover Sentinel, vault-agent sink; giữ "EXAMPLE ONLY".
  - Comment ở `redis-master`: phát hiện 2 (CONFIG REWRITE thất bại là hệ quả chủ ý của rootfs ro + secret ro; vai trò do Sentinel giữ).
  - Comment ở `secrets:`/header: file host phải đọc được bởi uid container — `redis_auth.conf`, `redis_password`, `sentinel_password` ⇒ `chown 999:999` + `chmod 0400`; `secrets/approle/role_id|secret_id` ⇒ `chown 100:1000` + `chmod 0400` (KHÔNG 0440: gid 1000 cũng là nhóm của app); thư mục `secrets/` `0700`.
- `runbook-deploy.md` §10 (dòng ~391–394): thay "mới qua `docker compose config`, **chưa khởi động thử** (DEBT-405)" bằng kết quả smoke + 3 lưu ý (quyền file host; CONFIG REWRITE; kiểm uid bằng `docker create`/`inspect`) + cách lặp lại smoke ngắn (network `--internal` tên riêng, `docker run` cùng cờ, `/proc/1/status` Uid/CapEff/NoNewPrivs, `INFO replication`, `SENTINEL ckquorum`, stop master ⇒ `get-master-addr-by-name`, dọn đúng tên). Không thêm script.
- Đóng DEBT-405 trong `backlog.md` (gạch + "✅ ĐÓNG (run 72 …)" + số đo bảng A).

**Task 2 (DEBT-466) — Dependabot:**
- Dockerfile dùng `ARG NODE_IMAGE=…` + `FROM ${NODE_IMAGE}`: Dependabot **không** resolve ARG trong FROM (dependabot-core#2057 OPEN, bình luận mới nhất 2026-11-04) ⇒ đổi `be/Dockerfile`, `fe-admin/Dockerfile` sang 2 dòng literal `FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build` / `… AS runtime`, xoá `ARG NODE_IMAGE` (không nơi nào truyền `--build-arg NODE_IMAGE` — đã grep repo). Sửa comment cách làm mới trong 2 Dockerfile và `runbook-deploy.md` §7 (dòng 249–253) + §9 (dòng 384) cho khớp.
- Tạo `.github/dependabot.yml` (không chạm `.github/agents`, `.github/instructions`), nội dung chốt:

```yaml
# Dependabot (run 72, DEBT-466, plan §12). Version updates wait 14 days (cooldown, same rule as manual
# pins); cooldown never applies to security updates. Limits and manual steps: runbook-deploy §7.
version: 2
updates:
  - package-ecosystem: npm # pnpm 12 workspace, root pnpm-lock.yaml
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 14 }
    groups:
      npm-minor-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]
  - package-ecosystem: docker
    directories: [/be, /fe-admin]
    schedule: { interval: weekly }
    cooldown: { default-days: 14 }
    ignore:
      - dependency-name: node
        update-types: ['version-update:semver-major'] # a Node major is a deliberate migration
    groups:
      node-image: # be + fe-admin in one PR: both images always share the digest
        applies-to: version-updates
        patterns: [node]
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 14 }
    groups:
      actions-minor-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]
```

- KHÔNG bật ecosystem `docker-compose` run này (root `docker-compose.yml` là hạ tầng dev người dùng quản lý; `prod.example.yml` tên không chuẩn, chưa rõ được dò) ⇒ debt mới.
- Giới hạn phải ghi trong comment file + runbook §7: (a) ecosystem `docker` **không có security updates** ⇒ CVE Node/Debian khẩn = bump tay theo ngoại lệ bảo mật; (b) **pnpm 12 ghi `pnpm-lock.yaml` thành 2 YAML document** (đã kiểm: `---` ở dòng 1 và 158) ⇒ dependency graph không thấy phụ thuộc ⇒ **không có alert/security update cho npm**; version update vẫn chạy. "Bản sửa bảo mật không chờ" cho npm dựa vào CI `pnpm audit --audit-level high` fail-closed + ngoại lệ bảo mật tay (tiền lệ zod run 51); với github-actions thì security update chạy được và không bị cooldown; (c) PR Dependabot đổi tag `node` phải sửa tay cùng PR `.nvmrc`/`.node-version`/`engines` — Dependabot không làm; (d) bật "Dependabot alerts / security updates" trong Settings repo là việc người dùng khi push.
- Nguồn tài liệu đã đọc (orchestrator xác minh):
  - https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference — khoá `cooldown` (`default-days`, `semver-major-days`, `semver-minor-days`, `semver-patch-days`, `include`, `exclude`; mặc định 3 ngày nếu bỏ), "only available for version updates, not security updates"; docker/docker-compose/github-actions chỉ hỗ trợ `default-days`; `groups.applies-to` (`version-updates`|`security-updates`), `update-types`, `patterns`; `directories` hỗ trợ glob; `package-ecosystem` `npm` cho pnpm v7–v12, `docker`, `docker-compose`, `github-actions`; `interval` `weekly`.
  - https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories — docker & docker-compose: security updates "Not supported"; ghi chú pnpm lockfile 2 document (mặc định pnpm 12 khi pin `packageManager`) ⇒ không alert/security update.
  - https://github.com/dependabot/dependabot-core/issues/2057 — ARG toàn cục trong FROM chưa hỗ trợ (OPEN).

### C. Cách chứng minh (dev ghi số đo thật vào log)

- V1 `docker compose -f <bản sao scratchpad> config --quiet` exit 0 sau khi sửa; diff `prod.example.yml` chỉ gồm comment + xoá khối `environment` của vault-agent.
- V2 Lặp lại smoke vault-agent **sau khi xoá SKIP_*** (Vault dev `vg-r72-vault`, digest repo, token ngẫu nhiên không in): sink 0440 100:1000, health healthy, log không còn "ignoring SKIP_". Redis không đổi hành vi ⇒ chạy lại tuỳ chọn. Dọn đúng tên `vg-r72-*` (container, volume, network); `docker ps -a` / `docker volume ls` / `docker network ls` lọc `vg-r72` rỗng.
- V3 (khuyến nghị) chứng minh lưu ý quyền file trên Linux FS thật: volume `vg-r72-perm` chứa `redis_auth.conf` `0400 0:0` ⇒ redis 999 thoát lỗi đọc config; `0400 999:999` ⇒ khởi động OK.
- V4 Dockerfile: mỗi file `grep -c '^FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS '` = 2, không còn `NODE_IMAGE`; `docker build -f be/Dockerfile -t vg-r72-be .` và `docker build -f fe-admin/Dockerfile -t vg-r72-fe-admin .` xanh; `docker run --rm --entrypoint node <img> -v` = v22.23.4; xoá 2 image đúng tên.
- V5 `.github/dependabot.yml`: parse bằng `js-yaml` có sẵn trong `node_modules` (không cài mới); validate schema SchemaStore `https://json.schemastore.org/dependabot-2.0.json` CHỈ khi orchestrator cho tải (không phải schema chính thức GitHub; nếu schema không biết `cooldown` thì ghi lại, không sửa file theo schema); kiểm tay: 3 ecosystem, thư mục tồn tại (`/pnpm-lock.yaml`, `/be/Dockerfile`, `/fe-admin/Dockerfile`, `/.github/workflows`), mọi entry `cooldown.default-days ≥ 14`. Hiệu lực thật chỉ kiểm được sau push (Insights → Dependency graph → Dependabot) ⇒ "cần người dùng".
- V6 `git status` chỉ thêm: `ops/compose/prod.example.yml`, `be/Dockerfile`, `fe-admin/Dockerfile`, `.github/dependabot.yml`, `docs/agile/sso-idp/runbook-deploy.md`, `backlog.md`, `STATUS.md`, docs run 72. Không đụng `.vscode/mcp.json`, `.mcp.json` (thay đổi sẵn của người dùng).
