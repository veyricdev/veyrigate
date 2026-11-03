# Tasks — run 62 — bump Node 22.23.4 (M7 / X6, lane ops)

> Nguồn: `backlog.md` DEBT-379 (đọc nguyên văn, kể cả ghi chú run 53b: 22.23.4 phát hành 2026-10-20 là bản **security**, đủ 14 ngày từ 2026-11-03 ⇒ bump thẳng, đồng bộ mọi chỗ pin). Chỗ pin hiện tại (grep `22.23.2`, ngoài `runs/`): `.nvmrc`, `.node-version`, `package.json` engines, `README.md:30`, `be/Dockerfile:9`, `fe-admin/Dockerfile:7` (cùng digest `sha256:48e4b67d…`). Lưu ý: `node -v` trên máy dev là **v22.22.3** (lệch pin cả trước run này) — tech-lead xác định ảnh hưởng (engine-strict? CI dùng `node-version-file`?) và cách verify mà không cài Node lên máy người dùng.
>
> Tech-lead: xác minh 22.23.4 vẫn là bản 22.x mới nhất đủ ≥ 14 ngày (nếu có bản mới hơn nhưng < 14 ngày ⇒ vẫn 22.23.4), đọc release notes (CVE nào, có thay đổi hành vi ảnh hưởng Fastify/undici/fetch/crypto không), lấy digest index `node:22.23.4-bookworm-slim` (`docker buildx imagetools inspect`, chỉ đọc), liệt kê đủ chỗ pin (kể cả `.github/workflows`, `ops/`, smoke script), thiết kế verify (build 2 image + smoke `docker-smoke.sh` BE/fe-admin như run 52/53b; unit/int/E2E trên Node đang có). Ngoài phạm vi: thêm Dependabot/Renovate (cấu hình thường trực có tác động ra GitHub — ghi thành câu hỏi cho người dùng, không làm), DEBT-369/371 (từ 2026-11-04).
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; không push image/registry; không cài/đổi Node hệ thống; không kill process/container ngoài của mình (chỉ TaskStop); dọn image/container smoke đúng tên, không prune/wildcard.

### [x] Task 1 [ops]: DEBT-379 — bump Node 22.23.4 đồng bộ mọi chỗ pin + digest mới + verify image.

## Fold tech-lead (2026-11-03) — PASS

**Đã kiểm ngày 2026-11-03**
- Theo `nodejs.org/dist/index.json`, bản 22.x mới nhất là **v22.23.4** (phát hành 2026-10-20, `security: true`, OpenSSL 3.5.9, npm 10.9.9, V8 12.4.254.21 giữ nguyên). Tính đến hôm nay bản này đã đủ 14 ngày. Bản trước đó là 22.23.3 (2026-09-23, không phải bản security). Chưa có 22.x nào mới hơn.
- CVE được sửa trong 22.23.4:
  - CVE-2026-106069 và CVE-2026-106072 (High, tls): từ chối địa chỉ IP viết không chuẩn tắc.
  - CVE-2026-105482 (High, dns): kiểm null byte trong input của resolve.
  - CVE-2026-111497 (High, brotli).
  - CVE-2026-105481 (Medium, http): data guard của agent.
  - CVE-2026-106074 (Medium, crypto): reset random cache giữa các snapshot.
  - CVE-2026-106073 (Low, permission): `realpathSync`.
  - Ngoài CVE còn có: undici 6.29.1, OpenSSL 3.5.9, NSS 3.131.1, c-ares 1.34.9, tzdata 2026e. Phần tls từ chối chain có public key bị chặn và khớp host IPv6 với IP SAN.
- Vì nhảy từ 22.23.2 nên bản bump gồm cả thay đổi của 22.23.3: undici 6.28.1; URL setter xử lý URL không parse được; `fs` patch được trong ESM loader; một cherry-pick V8; node-api chỉ thêm API mới; `util` giữ tên hàm (stack trace hoặc snapshot có thể khác).
- Ảnh hưởng dự kiến: không có thay đổi API.
  - Fastify (http1) không bị đụng.
  - `fetch` (Google, GitHub, Vault, BFF) chạy qua undici đã vá.
  - jose/crypto giữ nguyên hợp đồng.
  - argon2 bản gnu dùng N-API ổn định; glibc của bookworm không đổi.
  - jest `--experimental-vm-modules` và ts-node: ESM loader có thay đổi nhỏ, nên **bắt buộc chạy unit test trên 22.23.4** (bước V3).
  - TLS chặt hơn chỉ ảnh hưởng khi kết nối TLS tới IP viết không chuẩn tắc. Smoke BE gọi Vault dev-tls qua hostname `vg-b73b-vault`, nếu có lỗi thì check 1–4 sẽ bắt được.
- Digest index của `node:22.23.4-bookworm-slim`, lấy bằng `docker buildx imagetools inspect` ngày 2026-11-03: **`sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`**. Manifest amd64 là `sha256:9f0dde62…`, tạo ngày 2026-10-28, base debian:bookworm-slim. Tag này có thể được build lại sau, nên dev phải chạy lại lệnh inspect trước khi sửa. Nếu ra digest khác thì dùng digest mới và ghi vào log. Việc này không tính là lỗi.
- Các chỗ pin, tìm bằng grep `22\.23\.2|48e4b67d` (bỏ qua `runs/` và `backlog.md`):
  - Cần sửa đúng 6 chỗ: `.nvmrc`, `.node-version`, `package.json` engines (đang là `"22.23.2"` khớp chính xác), `README.md:30`, `be/Dockerfile:9`, `fe-admin/Dockerfile:7`.
  - `.github/workflows/ci.yml`: 4 job dùng `node-version-file: .nvmrc` nên tự theo. **Không sửa**, và run này cũng không được sửa workflow.
  - `ops/` không có image node. Smoke script không pin Node.
  - `runbook-deploy.md` §9 (dòng 234–235 và 304) viết chung `<version>`/`22.x`, nên không sửa.
  - `@types/node` 22.10.5 và engines của dependency trong lockfile (`^22.22.3`, `>=22.22.0`) không phải pin. **Không đổi lockfile.**
- Máy dev đang chạy Node v22.22.3. Đã đo bằng một project tạm trong scratchpad (`engines.node: "22.23.4"`, pnpm 12.6.0): `pnpm install` thoát 0 và không cảnh báo, kể cả khi thêm `--config.engine-strict=true`. Nghĩa là pin lệch không chặn install hay test, và cũng không có thông báo nào. Tình trạng lệch này đã có từ trước run. Repo không có `.npmrc` hay `engine-strict`. CI cài đúng 22.23.4 qua `.nvmrc`. Ghi thành DEBT-465.

### Task 1 [ops] — backend-dev

backend-dev làm cả `fe-admin/Dockerfile` vì chỉ đổi 1 dòng ARG, không cần gọi frontend-dev.

Chỉ sửa những chỗ sau:
1. `.nvmrc` và `.node-version`: `v22.23.4`.
2. `package.json` engines: `"node": "22.23.4"`, giữ kiểu khớp chính xác như cũ.
3. `README.md:30`: `v22.23.4`.
4. `be/Dockerfile:9` và `fe-admin/Dockerfile:7`: `ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`. Trước khi sửa, chạy lại `docker buildx imagetools inspect node:22.23.4-bookworm-slim`. Dùng giá trị ở dòng `Digest:` đầu tiên (digest index), không dùng digest manifest amd64.
5. `backlog.md`: đóng DEBT-379 (✅) cho phần bump, ghi digest và kết quả verify. Phần Dependabot/Renovate đã chuyển sang DEBT-466.

**Tiêu chí nghiệm thu**
- AC1: `git grep -nE "22\.23\.2|48e4b67d" -- ':!docs/agile/sso-idp/runs' ':!docs/agile/sso-idp/backlog.md'` trả 0 dòng. Ngoài docs của run và backlog, `git grep -n "22.23.4"` chỉ ra đúng 6 chỗ ở trên.
- AC2: `git diff --stat` chỉ gồm 6 file trên cộng docs trong `docs/agile/sso-idp/**`. `pnpm-lock.yaml` và `.github/**` không đổi.
- AC3: cả hai image build được trên base mới. Trong mỗi image, `node -v` ra `v22.23.4` và `node -p process.versions.openssl` ra `3.5.9`.
- AC4: smoke BE 11/11 và smoke fe-admin 14/14 (số check hiện tại của script). Nếu script in ra số khác thì ghi đúng số đó; điều kiện là dòng "passed" xuất hiện và không có fail.
- AC5: unit test của be và fe-admin xanh trên Node 22.23.4 (chạy trong container). Số test không ít hơn run 61 (be 630, fe-admin 1533).
- AC6: dọn dẹp theo đúng tên (quy tắc ở dưới). `be/keys` và `be/.env` không đổi (`git status` không hiện).

**Lệnh verify** (chạy trong Git Bash tại `E:/projects/self/veyrigate`; lệnh docker nào có đường dẫn thì đặt `MSYS_NO_PATHCONV=1`)
- V1 (cho AC1, AC2): hai lệnh `git grep` ở AC1 và `git diff --stat`.
- V2 (cho AC3, AC4): build và smoke với tag riêng của run.
  ```
  docker build -f be/Dockerfile --target build -t veyrigate-be:smoke-run62-build .
  docker build -f be/Dockerfile -t veyrigate-be:smoke-run62 .
  docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:smoke-run62 .
  for i in veyrigate-be:smoke-run62 veyrigate-fe-admin:smoke-run62; do docker run --rm --entrypoint node "$i" -p 'process.version+" "+process.versions.openssl'; done
  bash be/scripts/docker-smoke.sh veyrigate-be:smoke-run62 veyrigate-be:smoke-run62-build
  bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:smoke-run62
  ```
  Check 10 của smoke BE có thể FAIL giả do SIGPIPE (DEBT-408). Gặp thì chạy lại 1 lần và ghi vào log. FAIL 2 lần liên tiếp thì dừng và báo lại.
- V3 (cho AC5): chạy unit test trên 22.23.4 mà không cài Node lên máy người dùng. Container có tên cố định, mount repo **read-only**, rồi copy sang `/w` và bỏ `node_modules`, `.git`, mọi file `.env*` và `be/keys`. Bỏ các file này để không đưa secret vào container; `node_modules` của Windows cũng không chạy được trên Linux.
  ```
  MSYS_NO_PATHCONV=1 docker run --rm --name vg-n62-unit -v "E:/projects/self/veyrigate:/src:ro" \
    node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da \
    bash -ec 'mkdir /w; cd /src; tar --exclude=node_modules --exclude=./.git --exclude=".env*" --exclude=./be/keys -cf - . | tar -xf - -C /w; test ! -e /w/be/keys; test ! -e /w/be/.env; cd /w; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; corepack enable; node -v; pnpm install --frozen-lockfile; pnpm -C be test; pnpm -C fe-admin test'
  ```
  - Nếu lỗi mạng hoặc registry: ghi log và báo orchestrator. Khi đó chỉ dựa vào AC3, AC4 và CI sau khi push; AC5 không được tính là PASS.
  - Int và E2E: code không đổi, nên không chạy lại trên host. Host vẫn là Node 22.22.3 nên chạy cũng không chứng minh được gì. CI sẽ chạy int và E2E trên 22.23.4 sau khi push.
- V4: `git status --short` không có `be/keys`, `be/.env`, `.github/` hay `pnpm-lock.yaml`.

**Quy tắc dọn dẹp** (theo đúng tên; không prune, không wildcard, không `-a`)
- Container:
  - Script smoke tự `docker rm -f` các tên trong mảng của nó (trap EXIT). V3 dùng `--rm`.
  - Nếu bị ngắt giữa chừng: chỉ chạy `docker rm -f vg-n62-unit`, hoặc đúng các tên trong `NAMES` của script (`vg-b73b-*`, `vg-be-smoke-*`, `vg-fea-smoke-*`), cùng `docker network rm <NET của script>`.
  - Trước khi rm, chạy `docker ps -a --format '{{.Names}}'` để chắc container đó do run này tạo.
- Image:
  - Giữ `veyrigate-be:smoke-run62`, `veyrigate-be:smoke-run62-build` và `veyrigate-fe-admin:smoke-run62` cho tester.
  - Image smoke cũ (`*:smoke-run52`, `*:smoke-run53b*`) và `node:22.23.2-bookworm-slim` **không xoá** trong run này vì không phải của run. Hỏi người dùng trong summary.
  - Không chạy `docker image prune`, `system prune` hay `rmi $(...)`.
- Không push image, không `compose up`, không stop hay kill container khác (`aegate-*`, `vg-test-*`, mailpit).

### Câu hỏi cho người dùng (không làm trong run này)
- Q62.1: có bật Dependabot/Renovate cho `docker` (digest) và `.nvmrc` với cooldown 14 ngày không? Đây là cấu hình thường trực trên GitHub (DEBT-466).
- Q62.2: có cài Node 22.23.4 lên máy dev (`nvm install 22.23.4`) để host khớp pin không? (DEBT-465)
