# Senior Review — 2026-10-24 (run 52, A9 + DEBT-370/374/368/362/264)

## Kết luận: PASS

Không có 🔴. Còn 3 🟡, đã ghi vào backlog thành DEBT-384…386. Chuyển sang **tester**.

## Tổng quan

Diff gọn, bám đúng fold. `serve.mjs` dùng API srvx, nên không nạp `.env` và không có static chạy trước app. Image tách build/runtime: runtime chỉ còn `package.json`, `node_modules` prod, `dist/` và `serve.mjs`. Toàn bộ file thuộc root, chạy user `1000:1000`. Base image ghim theo digest, `CMD` dạng exec.

Body limit đặt đúng chỗ: trong `withSecurityHeaders`, trước router. DEBT-368 đóng lỗ "500 trần không header". Cờ đăng xuất giờ tự hết hạn.

Lệch fold ở `/assets/*` (404 ngay trong `server.ts`) là **đúng**. Nếu để router xử lý thì guard trả 307 về trang login, và một chunk cũ sẽ nạp HTML login như script. Response 404 này vẫn đi qua `withSecurityHeaders`, nên có CSP/nosniff/no-store.

Đã chạy lại (foreground):
- `pnpm -C fe-admin typecheck` exit 0, `lint` exit 0.
- `test` 62 file / 1369 test xanh.
- `build` exit 0. `check:bundle` 0 hit (22 chunk, 0 lần gọi Function/eval).
- `dist/client` chỉ có `assets/`, không có `*.map`.

Không build/run Docker, không chạy E2E.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Secret trong image / build context**:
  - `Dockerfile.dockerignore` là allowlist. Gốc repo chỉ cho `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` và `fe-admin/`. Loại `fe-admin/.env*`, `**/*.pem`, `node_modules`, `dist`, `test`, `coverage`. Dòng loại nằm sau dòng `!`, nên đúng thứ tự.
  - Máy dev có `fe-admin/.env` thật (ignored). File này bị loại khỏi context, nên không vào cả build stage. Vite chỉ nạp `.env*` ở gốc `fe-admin`, mà dòng này đã chặn.
  - Không có `ARG`/`ENV` secret, không `--secret`.
  - Runtime chỉ nhận `/out`. `/out` chỉ copy `package.json` + `node_modules` của `pnpm deploy --prod`, không lấy `src`/`test`/config.
  - Chỗ còn thiếu (lớp phòng thủ thêm) ⇒ 🟡-2.
- **Non-root, không ghi được app**:
  - `COPY --from=build /out /app` không có `--chown`, nên file thuộc root.
  - `USER 1000:1000` dạng số. Smoke check 1 và mutation đã chứng minh.
  - Rootfs read-only + `cap-drop ALL` + `no-new-privileges` đều chạy được.
- **Path traversal ở `/assets/*`** (`serve.mjs:25-34` + `srvx/static`):
  - Cổng `startsWith("/assets/")` chạy trên pathname đã chuẩn hoá theo WHATWG: `..`, `%2e%2e` và `\` đã được gộp. Vì vậy `/assets/../../x` không qua được cổng.
  - `serveStatic` dùng path thô, `join(dir, path)`, rồi kiểm `filePath.startsWith(resolve(dir)+sep)`. Không thoát được khỏi `dist/client`. `%2f` không được decode nên chỉ là tên file chữ, trả 404.
  - Null byte: `stat` throw nhưng bị `.catch(() => null)` bắt.
  - Symlink: `dist/client` được build trong image, không có symlink.
  - `dist/server/assets` không bao giờ nằm trong `dir`.
  - Host sai định dạng bị srvx đổi thành `_invalid_`, nên `new URL()` trong middleware không throw.
- **Header**:
  - Asset có `nosniff` + `immutable`.
  - 404/400/411/413/500/503 của app đều đi qua `withSecurityHeaders`. Ở đó `no-store` là mặc định khi response không tự đặt `cache-control`.
  - Nhánh `catch` (DEBT-368) trả text cố định. Log dùng `logServerError` (request id, name + message, không stack). Test có canary chứng minh không echo.
- **Body limit** (`body-limit.ts`). Thứ tự kiểm:
  1. Method ∈ GET/HEAD/OPTIONS ⇒ bỏ qua.
  2. Không có CL mà có body ⇒ 411.
  3. CL không khớp `^\d+$` ⇒ 400. Bao gồm số âm, hex, `1e3`, `1.5`. Khoảng trắng đầu/cuối đã bị parser Node cắt.
  4. CL > 65 536 ⇒ 413. Chuỗi số rất dài cũng ra 413 vì `Number` vẫn so được.

  Phần còn lại dựa vào llhttp:
  - CL + TE cùng lúc ⇒ parser từ chối.
  - Nhiều CL khác nhau ⇒ parser từ chối.
  - Không đọc quá CL.

  Body bị chặn trước router, nên zod không bao giờ thấy nó. Trường hợp POST rỗng không CL ⇒ 411 (DEBT-381) là fail-closed, chấp nhận.
- **Healthz**: chỉ đúng `GET|HEAD /healthz`, không chạm Redis/IdP/session, body `ok`, không lộ version. Self-check lúc boot làm env lỗi ⇒ exit 1. Log chỉ có tên biến (smoke check 11 có canary).
- **Trust proxy**: `trustProxy` không truyền vào srvx (undefined ⇒ tắt), nên `X-Forwarded-Host` bị bỏ qua.
- **Shutdown / `process.exit(0)` (DEBT-383)** — câu hỏi "có cắt ngang request đang chạy hoặc ghi session dở không":
  - `close` của `http.Server` chỉ phát khi **mọi** connection đã đóng. `server.close()` chỉ đóng connection rảnh; request đang chạy (kể cả SSR stream) được chạy hết, tối đa 5 s.
  - Các lệnh Redis của phiên đều được `await` trước khi trả response. `grep` không thấy ghi Redis kiểu fire-and-forget, và không dùng `waitUntil`.
  - ⇒ Không cắt ngang trong đường bình thường. Chỉ khi quá 5 s thì `forceClose` mới `closeAllConnections` rồi exit. Hành vi này tương đương SIGKILL, và lệnh Redis vẫn nguyên tử theo từng lệnh.
  - Điểm lệch: thoát mã 0 cả khi bị force close (💭-1).
- **Smoke script**:
  - Secret sinh lúc chạy, truyền bằng `-e NAME`, không in ra.
  - Trap chỉ `docker rm -f` 3 tên chính xác. Không prune, không xoá image.
  - Không đụng container khác. Cổng chỉ bind loopback.
- **CI `fe-admin-image`**: `permissions: contents: read`, `persist-credentials: false`. Không login registry, không push, không có secret.
- **Runbook §7**: khớp code (env, https, thoát mã 1, header, 64 KiB, graceful 5 s rồi thoát 0, HEALTHCHECK, cách lấy digest). Còn thiếu case listen lỗi ⇒ xem 🟡-1.

## 🟡 Nên sửa

🟡 **Độ tin cậy: lỗi listen bị nuốt, process thoát mã 0 trong im lặng** (DEBT-384)
`fe-admin/serve.mjs:36`: srvx gọi `this.serve().catch(() => {})` (`srvx/dist/adapters/node.mjs:933`).
Vì sao:
- Nếu `listen` lỗi (`EADDRINUSE`, hoặc `EACCES` khi đặt `PORT` < 1024 với uid 1000), lỗi không được log.
- Client Redis tạo lười, nên không có gì giữ event loop. Process thoát **mã 0** mà không có dòng log nào.
- `restart: on-failure` sẽ không khởi động lại, và người vận hành không biết vì sao.

Đề xuất: sau `serve(...)` thêm
`await server.ready().catch((e) => { console.error("fe-admin: listen failed:", e.code); process.exit(1); });`
rồi ghi một dòng vào runbook §7.

🟡 **Bảo mật (phòng thủ chiều sâu): allowlist chỉ chặn `.env*` ở gốc `fe-admin`** (DEBT-385)
`fe-admin/Dockerfile.dockerignore:9-10`: `fe-admin/.env*` không khớp file `.env` ở thư mục con (`fe-admin/e2e/.env`, `fe-admin/scripts/.env.local`…). Ngoài `*.pem`, các dạng key khác cũng không bị loại.
Vì sao:
- File loại này hiện không có. Vite cũng không nạp chúng, và runtime chỉ nhận `/out`.
- Nhưng nếu có, chúng sẽ nằm trong layer `COPY fe-admin/` của build stage (cache, `--target build`).
Đề xuất: đổi thành `**/.env*`, thêm `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/.npmrc`. Smoke check 13 + kiểm build stage giữ nguyên.

🟡 **Ponytail** (DEBT-386, xem mục ✂️): 2 chỗ thừa nhỏ, khoảng 5 dòng.

## 💭 Nit

- 💭-1: `serve.mjs:39` thoát mã 0 cả sau "Graceful shutdown timed out" (force close). Sau khi sửa DEBT-383, nên phân biệt được, ví dụ exit 1 khi bị force. Runbook hiện ghi "thoát mã 0" là đúng với code.
- 💭-2: `query-client.ts:17,23` dùng `Date.now()` (đồng hồ hệ thống). Nếu đồng hồ bị lùi (NTP/người dùng chỉnh) thì cửa sổ bị kéo dài. `performance.now()` là đồng hồ đơn điệu. Ngoài ra, bỏ `pageshow` có nghĩa là bấm Back (bfcache) trong 10 s sau Sign out sẽ còn bị tắt tự đăng nhập tối đa 10 s. Cả hai đều fail-closed và ngắn.
- 💭-3: `body-limit.ts:53-54`: response 400/411/413 không có `connection: close`. Node vẫn đọc bỏ phần body còn lại (`_dump`) tới hết `Content-Length` khai báo, giới hạn bởi `requestTimeout` 300 s. Chỉ tốn băng thông, không tốn bộ nhớ. Thêm `connection: close` sẽ cắt socket sớm.
- 💭-4: `docker-smoke.sh:28,81`: `grep … | head -n1` dưới `set -o pipefail` có thể đỏ giả do SIGPIPE khi output lớn. Output hiện rất nhỏ nên không xảy ra. Có thể dùng `grep -m1` hoặc `awk 'NR==1'`.
- 💭-5: `HEALTHCHECK` gọi `127.0.0.1`. Nếu người vận hành đặt `HOST` là một IP cụ thể khác loopback thì healthcheck luôn fail. Đáng thêm một dòng runbook: "giữ `HOST=0.0.0.0`".
- 💭-6: `docker-smoke.sh:128` vẫn chấp nhận 143, dù code luôn thoát 0. Có thể giữ, để lường trước DEBT-383.

## ✂️ Ponytail

- fe-admin/serve.mjs:L26: delete: `if (request.method !== "GET" && request.method !== "HEAD") return next();`. `serveStatic` đã tự lọc GET/HEAD (mặc định `methods`) và gọi `next()` ⇒ `found` undefined ⇒ `next()`.
- .github/workflows/ci.yml:L253-255: yagni: step `actions/setup-node` chỉ để script gọi `node -e randomBytes`. Runner `ubuntu-latest` đã có sẵn node, phiên bản không quan trọng ⇒ bỏ 3 dòng (hoặc giữ nếu muốn đồng bộ `.nvmrc`).
- fe-admin/scripts/docker-smoke.sh:L132-133: shrink: `secret 30` rồi cắt 40 ký tự ⇒ dùng thẳng `CANARY="$(secret 30)"` (30 byte base64url = 40 ký tự).

net: -5 lines possible.
