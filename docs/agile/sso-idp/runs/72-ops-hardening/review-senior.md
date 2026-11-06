# Senior Review — 2026-11-06

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Run làm đúng fold tech-lead, phạm vi gọn: chỉ comment/tài liệu + xoá biến vô dụng ở compose, đổi Dockerfile sang `FROM` literal không đổi hành vi, thêm `dependabot.yml` đúng nội dung chốt. Bằng chứng đo thật (smoke non-root, V3 quyền file trên FS Linux thật, build + smoke 11/11, 16/16), không suy luận.

Đã tự kiểm (reviewer):
- `git diff -U0 ops/compose/prod.example.yml` bỏ dòng comment ⇒ chỉ còn đúng 3 dòng `-` (`environment:`, `SKIP_SETCAP`, `SKIP_CHOWN`), không có dòng `+` nào ngoài comment.
- Bản sao scratchpad `r72dev/prod.example.yml` = repo (chỉ `<bytes>`→`64mb`); `docker compose -f … config --quiet` exit 0.
- Mỗi Dockerfile có đúng 2 dòng `FROM node:22.23.4-bookworm-slim@sha256:4b150b48…7279da AS build|runtime` (digest = `HEAD`), `ARG`/`${` = 0, `USER 1000:1000` giữ nguyên; `NODE_IMAGE` chỉ còn trong docs các run cũ (không có `--build-arg` nào).
- `dependabot.yml` parse bằng js-yaml: 3 entry `npm /`, `docker [/be,/fe-admin]`, `github-actions /`; `weekly`; `cooldown.default-days: 14` cả 3; groups `applies-to: version-updates` + `update-types: [minor, patch]`; `ignore` `dependency-name: node` + `update-types: ['version-update:semver-major']` — khoá đều khớp options reference fold đã nêu (docker/github-actions chỉ dùng `default-days`, đúng). `.nvmrc` = `.node-version` = `engines.node` = 22.23.4 = tag image.
- Lệnh quyền: secret compose chỉ được redis/sentinel (999) mount (`redis_auth.conf` ở master/replica; `redis_password`, `sentinel_password` ở sentinel) ⇒ `999:999 0400` đúng; be không mount secret nào (dùng `env_file`, do compose client đọc). Approle `100:1000 0400` đúng (agent uid 100; không cho gid 1000 = app đọc secret_id). Không có lệnh nào làm secret world/group-readable.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Secret host → container**: quyền tối thiểu theo uid đúng service; `0440` chỉ cho token sink (cố ý cho app gid 1000), không cho role_id/secret_id. ✅
- **Failure behavior**: Vault không tới được ⇒ không token ⇒ healthcheck fail ⇒ `be` không khởi động (fail-closed, đo thật). Quyền file sai ⇒ redis thoát 1 (fail-closed, V3). Ex-master đơn độc ⇒ `NOREPLICAS` (không ghi lệch). ✅
- **Privilege**: uid ≠ 0, `CapEff 0`, `NoNewPrivs 1` cho mọi dịch vụ hardening; xoá `SKIP_*` không đổi hành vi (log "ignoring SKIP_" biến mất, V2). ✅
- **Supply chain**: digest giữ nguyên; Dependabot chỉ mở PR (không quyền ghi mới), cooldown 14 ngày; giới hạn security update docker/npm ghi trung thực, không tuyên bố Dependabot lo bảo mật cho npm/docker. ✅
- **Exposure**: không secret nào trong diff/log (mật khẩu smoke ngẫu nhiên, không in). ✅

## 🟡 Nên sửa

🟡 **Vận hành: thiếu quyền thư mục `secrets/approle`**
`ops/compose/prod.example.yml:36-42`, `runbook-deploy.md` §10 "Quyền file host" — chỉ ghi `chmod 0700 secrets` (thư mục cha, không vào container) và quyền 2 file approle; **thư mục** `secrets/approle` được bind mount thành `/vault/approle` giữ owner/mode host.
Vì sao: người vận hành tạo thư mục secret với `umask 077` (thói quen phổ biến) ⇒ `0700 <operator>` ⇒ uid 100 không traverse được ⇒ agent không đọc role_id ⇒ không token ⇒ `be` không khởi động. Fail-closed (không phải lỗ hổng) nhưng là sự cố deploy khó đoán vì smoke Docker Desktop thấy `0777` nên không lộ ra.
Đề xuất: thêm `chown 100:1000 secrets/approle` + `chmod 0500 secrets/approle` (hoặc `0700`) vào cả 2 chỗ. → DEBT-503.

## 💭 Nit

- `runbook-deploy.md` §10 "node khởi động lại về vai trò command line rồi Sentinel cấu hình lại": đúng khi Sentinel còn sống; nếu khởi động lại **toàn bộ** stack (Sentinel config ở tmpfs bị mất, sinh lại với `monitor idp redis-master`) thì topology quay về `redis-master` làm master và Sentinel không "sửa" lại. Có thể thêm nửa câu. Không đưa backlog.
- Host uid 999/100 có thể trùng user hệ thống trên host (hoặc lệch khi bật userns-remap) — có thể nhắc "uid là uid trong container; với userns-remap cộng offset". Không đưa backlog.

## ✂️ Ponytail

- ops/compose/prod.example.yml:L32: shrink: khối 4 dòng số đo smoke run 72 lặp nguyên văn `runbook-deploy.md` §10. Thay bằng 1 dòng "Smoke-tested in run 72 with equivalent `docker run` flags (never `compose up`), results: runbook-deploy §10. Still EXAMPLE ONLY." → DEBT-504.
- dependabot.yml, Dockerfile: đúng mức tối thiểu (không thêm `open-pull-requests-limit`, label, reviewer…). Runbook "Lặp lại smoke" là prose, không thêm script — đúng.
net: -3 lines possible.
