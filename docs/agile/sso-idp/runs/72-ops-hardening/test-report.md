# Test Report — 2026-11-06 (tester, run 72)

## Kết quả: PASS (7/7 nhóm kiểm; 0 FAIL; không debt mới)

Kiểm độc lập như người vận hành theo runbook-deploy §10, trên Docker 28.5.1 (Desktop, overlayfs). Không `docker compose up`. Mọi đối tượng tạm tên `vg-r72t-*`, xoá đúng tên (không prune/wildcard). Script/log: `C:\Users\ADMIN\AppData\Local\Temp\claude\ff7ffefc063065c2\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\r72t\` (`smoke.sh`, `cleanup.sh`, `smoke.log`, `build-*.log`, `smoke-be.log`, `smoke-fe.log`, `unit-be.log`).

## Lệnh đã chạy + output thực tế

### Case 1 — compose config (lấy cờ)
- `docker compose -f ops/compose/prod.example.yml config --quiet` (repo) ⇒ exit 1, chỉ `env file …\ops\compose\secrets\be.env not found` (cố ý).
- Bản sao scratchpad (`<bytes>`→`64mb`, secret rỗng; `diff` với repo sau thay `<bytes>` = giống hệt) ⇒ `config --quiet` exit 0; `config --format json` ⇒ cờ resolve: vault-agent `user 100:1000`, `read_only true`, `cap_drop [ALL]`, `no-new-privileges:true`, `restart unless-stopped`, `environment` **null** (SKIP_* đã bỏ), healthcheck `test -s /run/vault/token` 5s×12; redis `999:999` + secret `/run/secrets/redis_auth.conf` + volume `/data`; sentinel tmpfs `/etc/sentinel:uid=999,gid=999,mode=0700`, entrypoint `sh -c` (lấy nguyên văn từ JSON, `$$`→`$` như compose khi chạy); volume `vault-token` tmpfs `mode=0750,uid=100,gid=1000`; network `internal: true`.

### Case 2 — secrets/ trên volume Linux thật, đúng lệnh runbook
Named volume `vg-r72t-secrets`, helper root (`umask 077`) tạo file (mật khẩu `od /dev/urandom`, role_id/secret_id từ Vault dev, không in), rồi chạy **nguyên văn** 6 lệnh `chmod/chown` của runbook §10 / header compose. `stat`:
```
700 0:0 secrets dir
500 100:1000 secrets/approle dir
400 999:999 secrets/redis_auth.conf nonempty
400 999:999 secrets/redis_password nonempty
400 999:999 secrets/sentinel_password nonempty
400 100:1000 secrets/approle/role_id nonempty
400 100:1000 secrets/approle/secret_id nonempty
```
Mount vào container bằng `--mount type=volume,…,volume-subpath=…,readonly` (tương đương bind file giữ owner/mode host); trong master: `/run/secrets/redis_auth.conf` = `400 999:999`.

### Case 3 — redis master + 1 replica + 1 sentinel + vault-agent (`docker run` cờ tương đương compose)
Cờ chung: `--read-only --cap-drop ALL --security-opt no-new-privileges:true --restart unless-stopped`, `--user` như compose, `--hostname`/`--network-alias` = hostname compose, network `vg-r72t-net --internal`. Vault dev throwaway `vg-r72t-vault` = `hashicorp/vault:2.1.2@sha256:c2f66626…` (digest repo), root token ngẫu nhiên qua env, không in; AppRole `idp`. Redis `redis:7.4.10-bookworm@sha256:e9b2e45e…`.

Mọi tiến trình trong container (`/proc/*/status`, gồm cả shell `docker exec`) + `docker top` phía host:
```
redis-master   : redis-server uid=[999 999 999 999] gid=[999…] CapEff=0000000000000000 CapPrm=0 NoNewPrivs=1 | top: 999 999 redis-server
redis-replica-1: redis-server uid=[999…] CapEff=0000000000000000 NoNewPrivs=1           | top: 999 999 redis-server
redis-sentinel-1: redis-sentinel uid=[999…] CapEff=0000000000000000 NoNewPrivs=1        | top: 999 999 redis-sentinel
vault-agent    : docker-entrypoi + vault uid=[100 100 100 100] gid=[1000…] CapEff=0000000000000000 NoNewPrivs=1 | top: 100 1000 (2 tiến trình)
inspect: running=true restarts=0 ro=true capdrop=[ALL] capadd=[] secopt=[no-new-privileges:true] (cả 4)
```
Chức năng:
```
master : role:master connected_slaves:1 slave0:ip=redis-replica-1,port=6379,state=online
replica: role:slave master_host:redis-master master_link_status:up
SET master OK; GET replica "ok"; SET replica ⇒ READONLY; PING không auth ⇒ NOAUTH
master /data 755 999:999 (appendonlydir ghi được); touch /etc/x ⇒ Read-only file system
sentinel get-master-addr-by-name idp = redis-master 6379; SENTINEL master flags=master num-slaves=1;
  SENTINEL replicas = redis-replica-1:6379 flags=slave; sentinel.conf 600 999:999, /etc/sentinel 700 999:999; PING không auth ⇒ NOAUTH
vault-agent health=healthy; env SKIP_* = 0; log "ignoring SKIP_" = 0; "authentication successful" = 1; "error" = 0
sink: /run/vault 750 100:1000, /run/vault/token 440 100:1000 (95 byte)
reader --user 1000:1000 (như be, :ro): vault token lookup exit 0, path auth/approle/login, policies ["default"]; ghi ⇒ Read-only file system
reader --user 1001:1001: denied; agent touch /vault/x ⇒ Read-only file system
```

### Case 4 — build lại 2 image (`vg-r72t-*`)
- `docker build -f be/Dockerfile -t vg-r72t-be:test .` exit 0; `--target build -t vg-r72t-be:test-build` exit 0; `docker build -f fe-admin/Dockerfile -t vg-r72t-fe-admin:test .` exit 0. Log build: `FROM docker.io/library/node:22.23.4-bookworm-slim@sha256:4b150b48…` (resolve literal, cả hai).
- `node -v` = **v22.23.4** cả hai; `id` = `uid=1000(node) gid=1000(node)`; `Config.User` = `1000:1000` cả hai.
- Dockerfile: mỗi file `^FROM node:22.23.4-bookworm-slim@sha256:4b150b48…7279da AS ` = 2, tổng `FROM` = 2, `NODE_IMAGE` = 0, `USER 1000:1000` giữ; digest = HEAD.

### Case 5 — smoke có sẵn của repo
Bản sao `be/scripts/docker-smoke.sh`, `fe-admin/scripts/docker-smoke.sh` chỉ đổi tên container/network sang `vg-r72t-*` (+ `REPO` tuyệt đối); grep tên cũ trong bản sao = 0.
- `be-smoke.sh vg-r72t-be:test vg-r72t-be:test-build` ⇒ **11/11 passed**, exit 0 (check 6 quét cả build stage).
- `fe-smoke.sh vg-r72t-fe-admin:test` ⇒ **16/16 passed**, exit 0.

### Case 6 — `.github/dependabot.yml` (không tải gì)
js-yaml 4.3.2 (`node_modules` sẵn có) parse OK: `version 2`, 3 update; khoá top/update/group đều nằm trong tập khoá options reference (fold § B): unknown = [] cả 3. npm `/` (`pnpm-lock.yaml` tồn tại), docker `directories [/be, /fe-admin]` (2 Dockerfile tồn tại), github-actions `/` (`.github/workflows` có `ci.yml`, `codeql.yml`); `schedule.interval weekly`; `cooldown {"default-days":14}` cả 3 (≥ 14; docker/actions chỉ dùng `default-days` — đúng giới hạn ecosystem); `applies-to: version-updates` mọi group; `update-types` ∈ {minor, patch}; ignore `version-update:semver-major` cho `node`. `pnpm-lock.yaml` có `---` ở dòng 1 và 158 (2 document, khớp giới hạn đã ghi). `.github/agents` không đổi. Schema SchemaStore không tải (ràng buộc). Hiệu lực thật chỉ sau push ⇒ cần người dùng.

### Case 7 — diff + unit
- `git diff -U0 ops/compose/prod.example.yml` dòng ± không phải comment = đúng 3 dòng `-` (`environment:`, `SKIP_SETCAP`, `SKIP_CHOWN`).
- `pnpm -C be test` ⇒ exit 0, **Test Suites 40/40, Tests 664/664** (Node host v22.22.3 — máy dev, Q62.2).

### Dọn
`cleanup.sh` (rm đúng tên 18 container, 4 volume, 2 network, 3 image): `containers=0 volumes=0 networks=0 images=0` (lọc `^vg-r72t-`); tên gốc smoke (`vg-b73b-*`, `vg-be-smoke-*`, `vg-fea-smoke-*`) = 0. `aegate-mongo/redis`, `vg-test-mongo/redis` vẫn Up, không bị đụng.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Task 1 / DEBT-405 — dịch vụ hardening khởi động non-root theo runbook: Case 1, 2, 3 (cờ lấy từ `compose config`, lệnh quyền runbook nguyên văn trên FS Linux thật).
- [x] Task 1 — diff compose chỉ comment + bỏ SKIP_*: Case 7; agent không SKIP_*/không log "ignoring": Case 3.
- [x] Task 2 / DEBT-466 — Dockerfile `FROM` literal, build + `node -v` v22.23.4 + user 1000 + smoke 11/11, 16/16: Case 4, 5.
- [x] Task 2 — dependabot.yml parse + khoá/thư mục/cooldown: Case 6.
- [x] Không đổi code: unit be 664/664 (Case 7).

## Coverage security invariants / risk matrix
- [x] Identity/Authorization — tiến trình uid ≠ 0 mọi container (Case 3); token sink chỉ owner 100 + nhóm 1000 đọc: reader 1000 OK, 1001 denied (Case 3).
- [x] Credential — Redis/Sentinel không auth ⇒ NOAUTH; mật khẩu/token/role_id/secret_id sinh ngẫu nhiên, không xuất hiện trên command line hay output (Case 2, 3).
- [x] Privilege — `CapEff`/`CapPrm` 0, `NoNewPrivs 1`, rootfs read-only (touch ⇒ Read-only) (Case 3).
- [x] Exposure — secret file `0400` đúng uid; `secrets/` `0700`; approle không group-readable (gid 1000 = app) (Case 2).
- [x] Dependency — replica ghi ⇒ READONLY; agent healthcheck gate (healthy chỉ khi có token). Fail-closed Vault không tới được / approle sai quyền: đã đo ở tech-lead + backend-dev retry, không lặp lại (ngoài phạm vi yêu cầu tester).
- Không áp dụng: replay/concurrency (không có mutation app mới), cross-tenant.
