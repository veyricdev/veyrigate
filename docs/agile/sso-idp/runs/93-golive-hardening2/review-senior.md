# Senior Review — 2026-11-17

## Lô B — T3 DEBT-258 (go-live 3), chỉ docs

Phạm vi: `git diff docs/agile/sso-idp/runbook-ops.md docs/agile/sso-idp/runbook-deploy.md docs/agile/sso-idp/backlog.md` (chưa commit). Không review file lô A (`fe-admin/serve.mjs`, e2e configs, `fe-admin/test/serve-mjs-risk.test.ts`).

### Kết luận: PASS (kèm 1 điều kiện ràng buộc cho lô C)

### Tổng quan

Diff gọn, đúng D93.3, không lan ra ngoài. Mọi chỗ `mongosh <MONGO_URI>` trong runbook đổi sang URI không credential + `-u <user>`, và mongosh tự hỏi mật khẩu. Hai khối subshell (§0 cổng xác nhận, §3c seed dev) nhập secret bằng `read -rs`. Câu giải thích cơ chế (lệnh ghép được parse trước, `read` đọc bàn phím, biến chỉ sống trong subshell, `/proc/<pid>/environ`) đúng kỹ thuật. Các ngoại lệ "giữ nguyên" đều có lý do, đã kiểm lại.

Đã tự kiểm:
- `bash -n` cho khối §0 (runbook-ops:33-36) và khối §3c (:251-257): OK.
- Mô phỏng khối §0 với stdin `/dev/null` (EOF/Ctrl-D): `read` trả 1 nên chuỗi `&&` dừng, subshell exit 1 và không chạy lệnh sau. Shell ngoài không còn `MONGO_URI` (`unset`).
- Nhập rỗng (chỉ Enter): `read` trả 0 và `MONGO_URI=""` được export. Biến không rơi về `be/.env`:
  - `node --env-file-if-exists` không ghi đè biến đã có trong env, kể cả biến rỗng;
  - `validation.schema.ts:48` có `MONGO_URI: z.string().min(1)`, nên CLI exit 1 trước khi in đích.
  - Vậy cả EOF lẫn nhập rỗng đều fail closed.
- `ops/backup/mongo-{backup,restore}.sh`:
  - `--config="$MONGO_*_CONFIG"` (YAML 0600);
  - nhánh `--uri` từ chối `*@*`;
  - §4c đưa URI vào mongosh qua stdin `/dev/stdin`, không qua argv.
  - Nhất quán với runbook-ops §4a/§4b (dòng 346, 352).
- Grep 1 ra 0 dòng (exit 1). Grep 2 ra 4 dòng (xem mục Security invariants).
- Không có literal PEM/secret mới. Placeholder chỉ là `<user>`, `<hosts>`, `<DB>`, `<pw>` (dòng `<pw>` có từ trước).

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

- **Exposure (argv/history/ps):**
  - mongosh `-u <user>` không kèm `-p` thì mongosh prompt mật khẩu không vang. URI trong lệnh không có `user:pass@`, nên history/`ps` không chứa secret. Đúng cho runbook-ops:21 và runbook-deploy:68/79/113/524/640.
  - `read -rs` là builtin nên giá trị không lên argv của process nào. `export` chỉ đưa giá trị vào env của con (pnpm/node). `/proc/<pid>/environ` có mode 0400, chỉ owner/root đọc được: chấp nhận được, như D93.3.
- **Paste safety:** cả khối `( … )` được bash parse xong mới chạy, nên `read -rs` không ăn dòng dán. Cổng `yes` vốn đã dựa vào cơ chế này (DEBT-257). Khối §3c đặt `pnpm --filter be build` trên dòng riêng trước subshell: dòng đó chạy xong rồi bash mới đọc tiếp, không đổi hành vi so với trước.
- **Failure behavior:** EOF, Ctrl-D, Ctrl-C hay nhập rỗng đều exit 1 và không kết nối, không rơi về `be/.env` (đã kiểm ở trên). Đích sai thì đã có dry-run `target:` chặn. Vì `-s` không vang, URI nhập sai chỉ lộ ra ở dòng `target:`, và cổng dry-run vẫn bắt được.
- **2 lệch so với D93.3 do tác giả tự nêu: chấp nhận cả hai.**
  - Thêm `&&` sau `export MONGO_URI`: chặt hơn bản D93.3, vì `read` thất bại thì không chạy pnpm. Nếu theo đúng D93.3 (không có `&&` giữa export và pnpm), sau `read` lỗi pnpm vẫn chạy với `MONGO_URI` rỗng. Trường hợp đó vẫn fail closed nhờ zod `min(1)`, nhưng nên dừng sớm hơn.
  - runbook-deploy:640 (§15, đoạn văn "mongosh với URI production"): đúng tinh thần T3 ("mọi chỗ khác trong runbook-*.md"). Ghi chú nhỏ: D93.3 sót dòng này.
- **Grep 2 ra 4 dòng thay vì 3: chấp nhận.** `be/scripts/drills/backup-restore-drill.mjs:216` là ca âm AC3:
  - URI `drill:${hex(8)}@127.0.0.1` dùng password ngẫu nhiên theo lượt;
  - URI được truyền vào `mongo-backup.sh` qua **env** (`{ ...backupEnv, MONGO_URI: uri }`), không qua argv;
  - mục đích là chứng minh script từ chối URI có credential và không echo nó ra.
  - Không phải secret, không lên argv. Đây là lỗ của danh sách D93.3 chứ không phải vi phạm. Nên ghi dòng này vào danh sách "giữ nguyên" của D93.3 cho lần grep sau.
- **Mô tả trước điều chưa tồn tại (runbook-deploy §4 bước 0): CÓ.** Ở HEAD hiện tại:
  - `be/scripts/pentest/pentest.mjs:39` chỉ nhận `known = {--only, --dist, --serve-minutes}`. Lệnh mẫu mới `… pentest.mjs --evidence docs/agile/sso-idp/runs/<run>/evidence` sẽ **exit 1 kèm usage** nếu chạy hôm nay.
  - `.github/workflows/ci.yml` chưa có job `pentest`.
  - Chưa có check `AUTHN-ENUM-SHAPE-*`, cờ `--timing off` và artifact `pentest-evidence`.
  - Chấp nhận được vì đây là lô B của **cùng run**, orchestrator commit chung sau lô C. Lô C phải bảo đảm khớp (xem mục 🟡 B-1).

### 🟡 Nên sửa

- **B-1 (điều kiện cho lô C, không phải sửa ở lô B). Hợp đồng runbook-deploy:157 phải khớp với code lô C:**
  1. Cờ đúng chữ `--evidence <dir>` và `--timing off`. Đường dẫn `--evidence` tương đối (runbook truyền `docs/agile/...` từ gốc repo) được `resolve()` theo cwd.
  2. Tên job CI là `pentest`, artifact `pentest-evidence`.
  3. Khi `--timing off`, ID check đúng tiền tố `AUTHN-ENUM-SHAPE-*` và không ghi `AUTHN-ENUM-TIME-*`.
  4. Mặc định `--timing on`, để lệnh tay ở bước 0 vẫn là lượt đầy đủ có đo thời gian.

  Nếu lô C đổi tên hoặc bị hoãn thì phải sửa lại câu ở bước 0 trong cùng commit. Không commit runbook-deploy:157 khi chưa có lô C (lệnh mẫu hiện tại sẽ exit 1).

  Senior lô C: đối chiếu 4 điểm trên.
- **B-2. runbook-ops:33 (§0): lời gợi ý bị thu hẹp từ "vd. NODE_ENV/ADMIN_SEED_*" xuống "vd. NODE_ENV".** Lý do cần sửa: §0 dặn "Đổi `db:sync-indexes` thành `db:seed`/`db:seed-dev`", mà `db:seed` cần `ADMIN_SEED_PASSWORD`. Khối §0 không cho đường nhập secret thứ hai, nên người trực dễ quay lại thói quen `export ADMIN_SEED_PASSWORD='…'` inline. Đó đúng là lỗ DEBT-258 muốn đóng, chỉ chuyển sang biến khác.

  Cân nhắc thêm nửa câu: "secret khác (vd. `ADMIN_SEED_PASSWORD`) cũng `read -rs` như khối §3c".

  Một dòng, có thể sửa trong run 93. Nếu không sửa trước khi đóng run thì orchestrator mở DEBT. Theo yêu cầu của caller, reviewer không ghi `backlog.md`.

### 💭 Nit

- runbook-ops:42: phương án thay thế `MONGO_URI="$(cat <file 0600>)"` nên ghi rõ "file chỉ chứa URI, **không** phải `backup.yaml`/`restore.yaml`". Nếu `cat` file YAML, CLI nhận `uri: mongodb://…` và exit 1; vô hại nhưng gây rối giữa sự cố. Nếu muốn dùng lại file YAML thì có thể trỏ tới đúng dòng `sed` của §4c.
- backlog.md DEBT-258, ghi chú đóng: liệt kê "runbook-deploy 2a/2c/§12/§15" nhưng thiếu 2b (dòng 79 cũng đã đổi). Sửa cho truy vết đủ.
- runbook-ops:42: dòng dài hơn hẳn các dòng xung quanh (gộp câu "Đổi `db:sync-indexes`…" vào cuối). Nên xuống dòng cho dễ đọc.

### ✂️ Ponytail

- docs/agile/sso-idp/runbook-ops.md:L39-41: shrink: đoạn giải thích DEBT-258 dài 3 dòng nhắc lại cơ chế "parse xong rồi mới chạy" mà đoạn trên (dòng 30) đã nói cho cổng `yes`. Thay bằng "`read -rs`: không vang, không vào history/argv, cùng cơ chế cổng `yes`; biến chỉ sống trong subshell". Không bắt buộc.

net: -1 lines possible. Gần như đã gọn.

## Lô A — T1 DEBT-679 + T2 DEBT-681

Phạm vi: `git diff fe-admin/test/serve-mjs-risk.test.ts e2e/playwright.x3.config.ts e2e/playwright.config.ts e2e/README.md` và dòng DEBT-679/681 trong `backlog.md` (chưa commit). Không review file lô C (`be/scripts/pentest`, `ci.yml`).

### Kết luận: PASS (0 🔴, 2 🟡)

### Tổng quan

T2 gọn, đúng D93.2. T1 thêm 3 ca đúng D93.1 (a/b/c), assert đủ (exitCode null, không `ERR_INVALID_STATE`, `/healthz` 200), cleanup upstream có `closeAllConnections`. Kết luận "xanh ngay, không sửa `serve.mjs`" có căn cứ. Điểm yếu: đầu dò của test không bắt được đúng lớp lỗi run 92 (xem 🟡 A-1).

Đã tự kiểm:
- `pnpm -C fe-admin exec vitest run test/serve-mjs-risk.test.ts` ×3: 36/36 passed cả 3 lượt.
- srvx 0.11.22 `dist/adapters/node.mjs` `streamBody` (dòng 99-122): `reader.read().then(streamHandle, streamCancel)` ở mọi nhánh, `streamCancel` gọi `reader.cancel(error).catch(() => {})`, `nodeRes.write` bọc try/catch, `reader.closed.catch(streamCancel)`. Không có promise rejection nào không được xử lý trong `streamBody`. Cả hai nhánh `_sendNodeResponse` (`_toNodeResponse` và Response thường) có body `ReadableStream` đều đi qua `streamBody` ⇒ 3 ca fixture (Response thường, body web) đúng là đi đường `streamBody`, không phải `pipeBody`.
- Nguồn stream app thật: react-dom 19.3.0 bản node export cả `renderToReadableStream` ⇒ TanStack `renderRouterToStream` đi nhánh web native (không `Readable.toWeb`); `grep toWeb dist/server` 0 kết quả. BFF (`src/server/admin-api/client.ts`) đọc JSON, không passthrough body upstream; `security-headers.ts:95`/`unavailable.ts:25` bọc lại `res.body` web bằng `new Response` (như ca `/proxy`).
- Mutation matrix (script scratchpad, fixture dưới `fe-admin/node_modules/.cache`, đã xoá), 5 request mỗi ô, chờ 600 ms:

  | serve.mjs | route | client | kết quả |
  |---|---|---|---|
  | hỏng kiểu run 92 (`new Response(found.body, …)`) | `/assets/big.js` 512 KB | curl | **exit 1, ERR_INVALID_STATE** |
  | hỏng kiểu run 92 | `/assets/big.js` | đầu dò `abortAfterFirstByte` của test | sống, không lỗi |
  | hiện tại | `/assets/big.js` | curl | sống |
  | hiện tại | app `Readable.toWeb(createReadStream)` 512 KB | curl | sống |
  | hiện tại | app `Readable.toWeb(...)` | đầu dò | sống |
  | hiện tại | app `ReadableStream` web 600 KB | curl | sống |

  ⇒ (1) Lỗi run 92 là ở body asset bọc lại + client đóng ngay sau byte cuối (curl), không phải ở `streamBody`; đường app sống sót kể cả với nguồn `Readable.toWeb` ⇒ đóng DEBT-679 có căn cứ. (2) Đầu dò "huỷ sau byte đầu" của 3 ca mới KHÔNG phát hiện được lỗi run 92 (ô 2 xanh) — đúng như comment run 92 trong chính file test ("the raw clients here are too slow to hit it").
- T2: `be/package.json` `start:e2e` = `ts-node test/e2e/e2e-main.ts` (cwd `be`) ⇒ lệnh mới `cd be && node node_modules/ts-node/dist/bin.js test/e2e/e2e-main.ts` tương đương (cùng cwd ⇒ cùng `tsconfig`, ts-node 10.9.2 pin, `bin.js` tồn tại), giống hệt `playwright.config.ts:57`. `be/src`, `be/test/e2e` không đọc `npm_*`/`NODE_PATH`. Log `x3.log`: 4 dòng `pw:webserver Terminated the WebServer` (07:47:49.637 → 07:47:50.706Z, mỗi cặp Terminating/Terminated liền nhau, không treo), `42 passed (9.5m)`.

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

- **Availability (DoS BFF):** client huỷ giữa body, upstream reset giữa body (`controller.error` ⇒ `streamCancel(err)` ⇒ `nodeRes.destroy(err)`), passthrough `fetch()` bị huỷ (srvx cancel reader ⇒ undici huỷ fetch ⇒ upstream `res.on("close")` dọn timer): process sống, request kế tiếp 200. Không thêm `process.on('uncaughtException')` ⇒ không có rủi ro nuốt lỗi khác; D93.1 không yêu cầu test âm trong trường hợp này.
- **Exposure:** test không in env; fixture không thêm secret. `FIXTURE_UPSTREAM` chỉ là URL loopback.
- **T2:** server không còn env shim pnpm; Playwright vẫn truyền `process.env` + `webServer.env` (xem 💭).

### 🟡 Nên sửa

- **A-1. `fe-admin/test/serve-mjs-risk.test.ts:243-280` — đầu dò không bắt được lớp lỗi đã biết.** D93.1/T1 ghi "client (curl, như `serve-mjs-risk.test.ts`)" nhưng 3 ca dùng socket thô huỷ sau byte đầu; lệch này không được ghi trong log. Vì sao quan trọng: mutation ở trên cho thấy cùng đầu dò này vẫn xanh với `serve.mjs` hỏng kiểu run 92; lỗi chỉ lộ khi client đóng ngay sau byte cuối (curl). Nếu sau này `serve.mjs` thêm middleware cho response app (nén, bọc header kiểu chuyển node stream ⇒ web), 3 ca hiện tại có thể không đỏ.
  Đề xuất (rẻ, 1 ca): thêm route app trả `ReadableStream` web hữu hạn, nhanh (~600 KB, không `setTimeout`) và ca `execFileP("curl", ["-sS", "-o", devNull, "-w", "%{http_code}", url])` ×3 ⇒ 200, rồi cùng 3 assert. Đã thử tay: hiện tại xanh. Giữ 3 ca huỷ giữa body (đúng tình huống DoS mid-body). Sửa trong run 93 nếu kịp; không thì mở DEBT.
- **A-2. `e2e/README.md:94-97` — "the env comes only from `webServer.env`" sai.** Playwright khởi động webServer với `process.env` của runner cộng `webServer.env` (tls-proxy không có `env` mà vẫn chạy). Đề xuất: "they inherit the runner env plus `webServer.env`, minus the pnpm shim's `NODE_PATH`/`npm_*`". Một dòng docs.

### 💭 Nit

- `serve-mjs-risk.test.ts:275` `setTimeout(600)` cố định: lỗi chỉ có thể làm test xanh giả (crash muộn hơn 600 ms), không làm flaky đỏ; `/healthz` sau đó là lưới thứ hai. Chấp nhận. Có thể đổi sang chờ `server.exited` race 600 ms để đỡ chờ, không bắt buộc.
- `serve-mjs-risk.test.ts:136` `return clearInterval(timer), res.end();` — toán tử phẩy khó đọc; tách 2 câu.
- Ca `/proxy` mô phỏng passthrough mà BFF hiện không có (admin-api đọc JSON). Giữ được (tech-lead yêu cầu, rẻ), nhưng comment nên nói "phòng khi thêm passthrough", tránh hiểu BFF đang stream body upstream.
- Ghi chú đóng DEBT-679 trong backlog nên nhắc bằng chứng mutation (đường app sống cả với nguồn `Readable.toWeb` + curl) thay vì chỉ "streamBody có `.catch`" — lỗi run 92 không nằm trong `streamBody`.

### ✂️ Ponytail

- fe-admin/test/serve-mjs-risk.test.ts:L47-58: shrink: `/slow-stream` và `/error-stream` chung một nhánh với cờ `pathname` — đã gọn, giữ.
- fe-admin/test/serve-mjs-risk.test.ts:L243-263: shrink: `abortAfterFirstByte` gần trùng `raw()`; có thể thêm tham số `stopAfterBody` cho `raw` thay vì hàm mới (~-12 dòng). Không bắt buộc.

net: -12 lines possible.

## Lô C + D — T4 DEBT-650 (job CI `pentest`, `--timing`/`--evidence`) + T5 DEBT-674/676/677

**Phạm vi:** `git diff be/scripts/pentest/pentest.mjs be/scripts/pentest/checks.mjs .github/workflows/ci.yml .github/workflows/codeql.yml be/src/modules/oauth/logout/logout.service.ts be/scripts/drills/lib.mjs .gitignore be/test/drills-lock.spec.ts` + dòng DEBT-674/676/677 trong `backlog.md` (chưa commit).

- Không review file lô A.
- Harness KHÔNG chạy (DEBT-664).

### Kết luận: PASS (0 🔴, 1 🟡)

### Tổng quan

Diff nhỏ, đúng D93.4–D93.8, không lan ra ngoài phạm vi.

- Cờ mới đi qua parser theo cặp sẵn có.
- Nhánh `--timing off` dùng lại đúng vòng lặp và `shapeOf` của lượt đo, nên không có thêm logic so sánh thứ hai cần tin.
- Job `pentest` sao chép đúng hạ tầng của `e2e`.
- DEBT-677 là di chuyển thuần.
- DEBT-676 có spec cô lập HOME.

Đã tự kiểm:

- `node --check` cho `pentest.mjs`, `checks.mjs`, `drills/lib.mjs`: OK.
- Parse `ci.yml` và `codeql.yml` bằng js-yaml 4.3.2 (đã cài sẵn): OK.
  - `jobs.pentest.services` giống hệt `jobs.e2e.services`:
    - redis + mailpit, cùng digest;
    - cổng 6379/1025/8025.
  - Bước "Start Mongo replica set (rs0)" giống hệt bước của `e2e`:
    - cùng digest, `-p 27017:27017`;
    - có `rs.initiate`;
    - chờ PRIMARY 60 s.
  - Các cổng khớp hằng của harness:
    - Mongo `127.0.0.1:27017` (`MONGO_HOST`);
    - Redis `127.0.0.1:6379`;
    - SMTP `smtp://127.0.0.1:1025`;
    - Mailpit API `127.0.0.1:8025`.
  - Timeout và artifact:
    - job 15', step harness 10';
    - upload `if: always()`, `retention-days: 14`, `if-no-files-found: warn`;
    - cùng SHA pin `upload-artifact` v7.0.2.
  - Phân quyền và trigger:
    - không có `needs`, `env` hay secret;
    - job không khai báo `permissions`, nên kế thừa `contents: read` ở top-level;
    - trigger: push + PR vào `develop`/`main`.
  - `codeql.yml`: `with.config` parse ra `{ paths-ignore: [7 mẫu] }`, đúng D93.7. `queries: security-extended` vẫn nằm ở input. Config không có `queries` nên hai chỗ không xung đột.
- `pnpm exec jest test/drills-lock.spec.ts`: 1/1 passed. Khoá thật `~/.vg-drill.lock` (`C:\Users\ADMIN`) không tồn tại cả trước lẫn sau lượt chạy.
- `logout.service.ts`: mọi dòng `-` có đúng một dòng `+` giống hệt (`uniq -c` trên `diff -U0`), nên đây là di chuyển thuần.
- `git ls-files`: ngoài 4 thư mục test, mọi file test JS/TS đều có đuôi `.spec.ts` hoặc `.test.ts(x)`. Không có `.test.mjs` hay `.spec.tsx` lọt lưới. Spec colocated rải trong `be/src/modules/*` bị loại theo chủ ý D93.7.
- Không chạy được dry-run với tham số sai (`--timing bogus`…) vì auto-mode classifier chặn lệnh.
  - Theo code: parser chạy trước `createRequire`, trước mọi kết nối và trước `acquireLock`, nên chỉ in usage rồi exit 1.
  - Dev đã ghi kết quả 8 tổ hợp trong log.

### Đối chiếu B-1 (runbook-deploy §4 bước 0, dòng 157): khớp cả 4 điểm

1. `--evidence <dir>` được `resolve()` theo cwd, `--timing off` đúng chữ.
   - Lệnh mẫu chạy từ gốc repo với `--evidence docs/agile/sso-idp/runs/<run>/evidence` ghi vào đúng chỗ.
   - Giá trị rỗng hoặc thiếu ⇒ in usage, exit 1.
2. Tên job là `pentest`, tên artifact là `pentest-evidence`.
3. Khi `off`, chỉ ghi `AUTHN-ENUM-SHAPE-<case>` (có `continue` trước nhánh TIME), không ghi `AUTHN-ENUM-TIME-*`.
4. Mặc định `opt('--timing') ?? 'on'` là lượt đầy đủ. `mutate.mjs` không truyền `--timing` nên vẫn chạy lượt có đo.

⇒ Dòng 157 commit được cùng lô C.

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

- **Enumeration (ASVS 6.3.8): SHAPE đúng ngữ nghĩa.**
  - `shapeOf` gồm status, sha256(body) và sha256(header). Header bỏ qua: `date`, `x-request-id`, `set-cookie`, `content-length`, `keep-alive`, `connection`.
  - `same` đòi mỗi phía chỉ có **1** hình dạng duy nhất qua 5 cặp, và hai phía bằng nhau. Khác ở bất kỳ cặp nào cũng làm `must` fail, nên kiểm nội dung chặt ngang lượt đo.
  - Bỏ `set-cookie` và `content-length` là từ run 90, không phải lô này. Hash body đã phủ `content-length`.
  - Mỗi cặp dùng email khác nhau (`existing[i]`, absent ngẫu nhiên), thứ tự xen kẽ đảo theo `i`.
  - Index 0..5 không đụng `enumEmails[239]` và `[220..229]` mà các check sau dùng.
- **1 cặp khởi động bị loại: không che lỗi thật.**
  - Oracle tồn tại tài khoản phải lặp lại được với từng email. Mỗi cặp dùng email mới, nên oracle loại này lộ ra ở cả 5 cặp đo.
  - Thứ duy nhất bị che là bất thường chỉ xảy ra ở request **đầu tiên** của mỗi case (cold path). Attacker không chọn được vị trí đó, nên nó không phải oracle.
  - Cùng kỷ luật với lượt đo (W=20 cũng loại shape). Muốn chặt hơn: xem 💭.
- **Exit code:**
  - `evidence.ok = !error && clean && must.fail === 0`;
  - `exitCode = expired ? 2 : ok ? 0 : 1`.
  - Tier `should` không tham gia. Vì vậy `SHOULD-PERF-ARGON` lật trên runner 2 vCPU không làm đỏ job (DEBT-658).
- **Exposure (evidence):**
  - `writeEvidence(…, secrets, EVIDENCE)` gọi `assertClean` cho cả json lẫn log **trước** `mkdirSync`/`writeFileSync`, với mọi `dir`.
  - `--evidence` chỉ đổi đích ghi, không bỏ qua bộ lọc.
  - Lọc thất bại ⇒ không ghi file, exit 1, artifact rỗng (chỉ warn).
  - Artifact không chứa log BE thô.
- **CI trust boundary:**
  - không secret, quyền `contents: read`;
  - PR từ fork chạy như các job khác;
  - harness chỉ bind 127.0.0.1 trên runner tạm;
  - snapshot `devBefore`/`e2eBefore` so các DB không tồn tại với nhau (rỗng = rỗng), nên không fail giả.
- **Khoá DEBT-676:**
  - `homedir()` lấy `HOME` trên POSIX, `USERPROFILE` trên Windows (libuv). Spec đặt cả hai, nên không chạm khoá thật trên cả hai nền (đã kiểm trên Windows).
  - `openSync(…, 'wx', 0o600)` = O_CREAT|O_EXCL: từ chối cả file lẫn symlink đặt sẵn.
  - Thư mục home không world-writable.
  - Hai OS user khác nhau vẫn còn lớp `assertNamespace`.
  - Comment ghi đủ: không chạy dưới sudo, không chạy trên host production.

### 🟡 Nên sửa

- **C-1. `.github/workflows/ci.yml`, step "Run pentest harness": `timeout-minutes: 10` nhỏ hơn budget nội bộ `budget(20 * 60_000)` (`pentest.mjs:235`).**
  - **Vì sao:**
    - Khi harness treo trong CI (Mailpit/Mongo kẹt), Actions huỷ step ở phút 10.
    - Đường exit 2 (budget ⇒ chạy `finally` ⇒ ghi evidence) không bao giờ tới.
    - Kết quả: không có evidence, artifact rỗng ("No files were found", chỉ warn).
  - **Hệ quả:** comment của job nói quá ở hai câu:
    - "2 time budget": không xảy ra trong CI;
    - "Also on failure/cancel: the evidence says which check failed": khi cancel/timeout thì không có evidence.
  - **Mức độ:** lượt `off` ước ~1,5 phút nên hiếm gặp. Nhưng lúc treo lại chính là lúc cần chẩn đoán.
  - **Đề xuất (orchestrator chọn):**
    - rẻ nhất: sửa 2 câu comment cho đúng, ví dụ "step timeout cancels without evidence; the job log has the progress lines";
    - hoặc cho harness nhận budget qua env/cờ (ví dụ `PENTEST_BUDGET_MIN=8`) để CI đi đường exit 2 có evidence. Phương án này vượt D93.4 (YAGNI).
  - Không sửa trong run 93 thì mở DEBT.

### 💭 Nit

- `checks.mjs:641-647`: nếu muốn SHAPE nghiêm hơn lượt đo, khi `!timing` có thể đưa shape của cặp khởi động vào `shapes`.
  - Shape là tất định nên response đầu không có lý do để khác; nếu khác thật thì đó là tín hiệu đáng xem.
  - Không bắt buộc: lệch hiện tại nhất quán với lượt đo, và log đã nêu.
- Log tiến trình (`makeLog` ⇒ `console.log`) không qua `assertClean`.
  - Dòng `FAIL … actual …` có thể in giá trị theo lượt lên log job công khai (repo public).
  - Rủi ro thực ≈ 0: secret sinh theo lượt, BE bind 127.0.0.1 trên runner tạm, đã huỷ sau job.
  - Ghi để biết: bộ lọc D90.17 bảo vệ artifact, không bảo vệ stdout.
- `drills-lock.spec.ts`: assert `inTmpRoot: false` luôn đúng, vì home giả là thư mục con của `tmpdir()`. Assert thật là `dir: home`. Có thể bỏ để khỏi gây hiểu nhầm.
- `pentest.mjs`: `timing` là chuỗi `'on'|'off'`, nhưng trong `ctx` là boolean; `checks.mjs` dùng `ctx.timing !== false`. Có thể viết gọn thành `ctx.timing`, vì ctx luôn được gán.

### ✂️ Ponytail

- be/scripts/pentest/checks.mjs:L623: shrink: `ctx.timing !== false` ⇒ `ctx.timing` (pentest.mjs luôn gán boolean).
- be/test/drills-lock.spec.ts:L22: delete: field `inTmpRoot` + assert `inTmpRoot: false` (luôn đúng; `dir: home` đã đủ).

net: -1 lines possible. Gần như đã gọn.
