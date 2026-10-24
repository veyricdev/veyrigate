# Senior Review — 2026-10-24 — run 53b (B7.3 phần 2: `be/Dockerfile`, DEBT-384/385)

Phạm vi: diff chưa commit so với HEAD `8cc1c2d` (bỏ `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`):
`be/Dockerfile`, `be/Dockerfile.dockerignore`, `be/scripts/docker-smoke.sh`, CI job `be-image`, `fe-admin/{serve.mjs,Dockerfile.dockerignore,scripts/docker-smoke.sh,test/serve-mjs-risk.test.ts}`, `runbook-deploy.md` §7/§9, backlog/STATUS.
Không build/run Docker (theo phạm vi). Đã chạy: `bash -n` hai smoke script (OK), `pnpm -C fe-admin exec vitest run test/serve-mjs-risk.test.ts` 32/32, `pnpm -C fe-admin lint` 0. `be/src` không đổi (`git diff --stat HEAD -- be/src` rỗng) nên không chạy lại be unit. `be/keys`, `be/.env` không đổi.

## Kết luận: PASS

Không còn 🔴. 1 🟡 mới vào backlog (DEBT-398).

## Tổng quan

Bám sát khuôn run 52 và "Kế hoạch 53b". Những điểm làm tốt:

- Runtime chỉ nhận `/out`, gồm `package.json`, `node_modules` (deploy `--prod`) và `dist` (đã xoá `*.d.ts`/`*.map`/`*.tsbuildinfo`). Đây chính là **lớp chặn thứ hai** cho `.env`: mutation cho thấy `/deploy/.env` có tồn tại, nhưng không file nào từ gốc `/deploy` được copy sang runtime.
- File thuộc root, `USER 1000:1000`, smoke chạy `--read-only --cap-drop ALL --no-new-privileges`. Vì vậy `/app/.env` (thứ `main.ts:16` sẽ nạp) không thể được tạo lúc chạy.
- `HEALTHCHECK` dùng `/health`. Đã đọc `health.controller.ts`: `/health` không chạm dependency nào, `/ready` mới ping Mongo + Redis. Smoke có check riêng cho trường hợp Redis chết.
- Smoke có test âm thật: canary không được lọt vào log; production chặn `KEY_PROVIDER=local`. Check 6 quét cả build stage, kiểm `docker history` và env của image. Token Vault đi qua stdin vào tmpfs (umask 077, `mv` nguyên tử) nên không nằm trong env/argv/file host. Không in log của Vault. `trap` chỉ dọn đúng tên.
- Mutation có bằng chứng: USER, HEALTHCHECK, `**/.env*`, chặn local-ở-prod.
- DEBT-384 làm đúng gốc lỗi: `await server.ready()` ⇒ exit 1 kèm mã lỗi. Có test RED→GREEN và smoke check 14. DEBT-385 khớp gợi ý của run 52.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| Không `.env`/key trong image runtime | ✅ Có 3 lớp: allowlist ignore; copy chọn lọc từ `/deploy`; check 6 bằng `find /` (xdev). Asset Nest chỉ gồm `views/**`, `public/**` từ `src/`, đều bị ignore `**/.env*` chặn trước. |
| `/app/.env` không thể xuất hiện lúc chạy | ✅ `/app` thuộc root, uid 1000 không ghi được; rootfs read-only trong smoke; runbook §9 cấm mount. Còn rủi ro vận hành (ai đó mount volume vào `/app`), runbook đã ghi. |
| Build stage không thấy secret | ✅ Khi build qua CI/smoke. ⚠ Không có chặn lúc build, xem 🟡 DEBT-398. |
| Token Vault không lọt | ✅ Smoke: stdin → tmpfs, `unset APP_TOKEN`, `::add-mask::`. Check 11 grep `hvs.`, `X-Vault-Token`, đường dẫn token. Root token đi vào `docker exec` qua env của docker CLI, không qua argv. |
| Fail-closed khi boot | ✅ Thiếu env ⇒ exit ≠ 0, log chỉ có tên biến (check 9). `local` ở prod ⇒ exit ≠ 0 (check 10). Lỗi `listen`/Vault `init()` reject trong `void bootstrap()` ⇒ unhandled rejection ⇒ exit 1 (BE không bị kiểu lỗi DEBT-384). |
| Liveness và readiness tách nhau | ✅ Redis chết ⇒ `/health` 200, `/ready` 503 `redis:down`, container vẫn chạy (check 7). |
| Image không chứa secret ở history/env | ✅ Check 6 (`docker history` grep + env đúng tập `NODE_ENV NODE_VERSION PATH PORT YARN_VERSION`). |
| CI không push/không secret | ✅ `permissions: contents: read`, `persist-credentials: false`, không login registry, không dùng GitHub secrets. |
| `serve.mjs` không còn thoát 0 khi không listen được | ✅ Test "port already in use" + smoke check 14. Server đầu tiên vẫn sống. |

Câu hỏi của orchestrator: smoke dùng `--entrypoint sh … exec node dist/main.js` cho container chính thì có khác image thật không?
Không khác về hành vi. Cwd vẫn là `WORKDIR /app`, vẫn user 1000, vẫn HEALTHCHECK của image, PID 1 vẫn là `node` (do `exec`). `docker-entrypoint.sh` của image node với `node …` cũng chỉ `exec`. Lệnh `CMD` gốc vẫn được chạy không sửa ở check 9 và 10. Tuy vậy, chưa có check nào chạy `CMD` gốc **đến lúc listen**: hai check đó dừng ở bước validate env. Xem 💭 3.

## 🟡 Nên sửa

🟡 **Build stage không tự chặn secret lọt context (DEBT-398)**
`be/Dockerfile:20-27`: nếu ignore file hỏng (sửa nhầm thứ tự dòng `!`, hoặc thêm `!be/.env…`), `be/.env` vào layer `COPY be/ be/` và vào `/deploy/.env`. Mutation của dev đã cho thấy điều này. Hiện chỉ smoke (check 6 với `--target build`) bắt được.
Vì sao: lớp build không được push trong cấu hình hiện tại, nhưng có 2 đường lọt thực tế:
- pipeline release chỉ `docker build` mà không chạy smoke;
- build cache export `--cache-to type=registry,mode=max` (hoặc `type=gha`). Kiểu export này đẩy cả layer của stage trung gian lên registry hoặc cache, tức là đẩy luôn `.env` dev (mật khẩu Mongo, secret OAuth).

Đề xuất: thêm 1 bước fail-closed ngay sau `COPY be/ be/`, ví dụ `RUN ! find /repo -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '.npmrc' | grep .`. Build sẽ đỏ trước khi có layer `/deploy`. Mutation: bỏ `**/.env*` ⇒ build fail. Áp tương tự cho `fe-admin/Dockerfile`. Runbook §9 thêm 1 dòng: "không export build cache `mode=max` ra ngoài".

## 💭 Nit

1. **Runbook §9 "Token Vault"**: "File `0400`/`0440`, đọc được bởi uid 1000" chỉ đúng khi owner (0400) là uid 1000, hoặc group (0440) là gid 1000. Sink của Vault Agent mang owner là uid của Agent. Cân nhắc viết rõ: "Agent chạy uid 1000 với `mode 0400`, hoặc chung gid 1000 với `mode 0440`". §8 đang ghi "owner uid của app", nên hai chỗ nên khớp nhau.
2. **DEBT-397** ghi "đã đóng HTTP/Mongo trước". HTTP thì đúng (Nest `dispose()` chạy trước `onApplicationShutdown`). Thứ tự giữa Mongo và Redis trong `onApplicationShutdown` thì chưa được chứng minh. Mức 🟡 và kế hoạch 53c vẫn đúng: không mất dữ liệu vì HTTP đã đóng, chỉ mất drain/rollout lúc sự cố Redis. Có thể sửa chữ thành "đã đóng HTTP trước".
3. **Smoke**: chưa có check nào chạy `CMD` gốc tới lúc listen (lý do: token phải có trước khi app boot). Rủi ro thấp vì wrapper `exec` đúng lệnh `CMD`. Nếu muốn đóng hẳn: tạo volume tạm `vg-b73b-token` và ghi token vào đó qua một container `--rm` đọc stdin. Container app mount volume đó read-only rồi chạy image **không** override entrypoint. Cách này cũng giống deploy thật với sink của Agent hơn.
4. **Smoke check 2 khi fail** in 20 dòng log app. Log này chưa qua check 11 (CI có mask, chạy local thì không). Rủi ro thấp, ghi để biết.
5. **Smoke dùng tên cố định**: hai lần chạy song song trên cùng máy sẽ xoá container của nhau (`remove_all` ở đầu). CI không bị vì mỗi job chạy trên runner riêng. Một dòng comment là đủ.
6. **Base Node 22.23.2** trong khi 22.23.4 là bản **security** (4 ngày tuổi). DEBT-379 đã hẹn bump 2026-11-03. Run 51 từng lấy zod theo ngoại lệ security trước 14 ngày. Cân nhắc đọc danh sách CVE của 22.23.4: nếu có lỗi HTTP parser/TLS/crypto mức high thì áp cùng ngoại lệ, vì IdP nhận traffic Internet qua proxy.
7. **Image 505 MB**: chưa đo được (không chạy Docker). Base slim còn npm/yarn/corepack (`YARN_VERSION` trong env). Dòng swagger kéo theo `swagger-ui-dist` (~10 MB) vì decorator `@nestjs/swagger` là dependency runtime. Lần chạm sau nên đo `du -sh /app/node_modules/.pnpm/* | sort -h | tail` trước khi quyết định cắt gì. Đây không phải nợ.

## ✂️ Ponytail

- be/scripts/docker-smoke.sh:L111-116: shrink (tuỳ chọn, không bắt buộc): check 1 kiểm user 2 lần (`Config.User` + `id -u`); giữ được vì `id -u` bắt override lúc chạy.

Lean already. Ship.
