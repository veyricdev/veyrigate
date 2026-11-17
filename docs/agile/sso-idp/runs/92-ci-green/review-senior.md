# Senior Review — 2026-11-17 (run 92 `92-ci-green`)

## Lô C (T7 CodeQL, D92.9) — chưa commit, working tree

### Kết luận: PASS (không còn 🔴; 2 🟡 vào backlog DEBT-676/677)

### Tổng quan

Bản sửa nhỏ, đúng chỗ, mỗi sửa trên trust boundary có test âm khớp bảng "Cổng security" của tech-lead. Điểm tốt:
- #9: tìm ra nguyên nhân thật (`ValidationPipe transform` ép `@Query('state') string` lặp thành `"a,b"` trước controller), không chỉ vá triệu chứng ở service. Int RED → GREEN.
- #1: test tương đương giữ nguyên bản regex cũ làm oracle (`legacy`), chạy cùng bảng ca → chứng minh "cùng tập chấp nhận" bằng máy chứ không bằng lời.
- #2: test chạy chính file tĩnh trong `node:vm`, gồm `' JaVaScRiPt:'`, `vbscript:`, URL không parse được.
- Triage có bằng chứng thật cho các FP quan trọng (kiểm lại bên dưới).

Đã chạy (reviewer):
- Unit: `jest bearer.spec logout-redirect-script.spec client.service.spec resource.service.spec logout.service.spec test/drills-lock.spec` ⇒ 6 suite, 59/59 PASS.
- Int (qua `vg:int-lock`): `jest --config jest.int.config.js --runInBand test/run92-codeql.int-spec.ts` ⇒ 14/14 PASS (14,3 s).

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

| Sửa | Kiểm | Kết quả |
|---|---|---|
| #1 `bearerToken` | So từng nhánh với `/^Bearer[ ]+(.+)$/i`. `.` không khớp `\n\r  ` ⇒ bản mới loại đúng 4 ký tự đó. `"Bearer "` ⇒ `undefined` (cũ: `.+` cần ≥ 1 ký tự). `"Bearer  "` ⇒ `""` (cũ: backtrack trả `" "` rồi trim). Tab sau `Bearer` ⇒ `undefined`. Header lặp ⇒ `undefined` (giữ). | Tương đương; tuyến tính. |
| #9 GET `/logout` `@Query()` thô | Metatype interface ⇒ `Object` ⇒ global `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` bỏ qua, đúng như `/authorize` (`AuthorizeParams`) và federation callback. Trước đây 4 `@Query('x') string` không có decorator class-validator nào ⇒ không mất validation/whitelist nào. Tham số khác trên GET (vd. `ui_locales`) trước đây cũng không đọc. `stringLogoutParams` chạy ở `renderLogoutConfirm` (chặn phản chiếu vào form) và ở `resolvePostLogoutRedirect` (cả 3 caller: GET confirm, POST no-`_csrf`, POST có `_csrf`). Object kiểu `state[a]=b` (nếu parser sinh) cũng bị bỏ. | Không đổi hợp đồng: một `state` vẫn được phản chiếu/gắn (int "control"); lặp ⇒ vắng, không 5xx, không `a,b`. |
| #7 `findByClientId` | `typeof !== 'string'` ⇒ `null` trước `findOne` (fail-closed = client lạ ⇒ `invalid_client`). 12 caller hưởng chung, gồm `/authorize` đọc `@Query()` thô (`client_id` lặp = mảng). | Đúng. Xem 💭 về độ phủ int. |
| #8 `createUnique` | Guard trước `exists`; text lỗi cố định, không phản chiếu. DTO `@IsString` vẫn chặn trước ở HTTP ⇒ đây là phòng thủ chiều sâu; int admin `{ $ne: null }` ⇒ 400. | Đúng. |
| #2 `logout-redirect.js` | `new URL(target, location.href)`, chỉ `http:`/`https:`, điều hướng `url.href` (đã chuẩn hoá). Kiểm exact-match phía server không đổi. | Đúng. |
| #31/#32 `LogoutCsrfGuard` | Guard: không có key `_csrf` ⇒ qua; có nhưng không phải string ⇒ 400; HMAC sai ⇒ 403. Controller: `body?._csrf === undefined` ⇒ chỉ render xác nhận. Hai điều kiện nhất quán (JSON không tạo được `undefined`). Int mới: POST có cookie phiên, không `_csrf` ⇒ 200, phiên sống; form vừa render mới huỷ. | FP có bằng chứng. |
| #27 `sha256` | `codegraph_callers sha256` (44 caller) + grep `src`: token CSPRNG (session id, refresh, auth code, verify/reset token, fed state/link, binding cookie, device token), định danh không bí mật (email, userId, IP, `clientId|ip`) cho khoá Redis/rate-limit, và `pwdFp = sha256(user.passwordHash)` (đầu vào là chuỗi PHC Argon2id, không phải mật khẩu). `metrics.http.ts` dùng hàm `sha256` cục bộ khác (so token metrics, không phải lưu mật khẩu). | FP đúng. |
| #37 recovery code | `randomBytes(10)` = 80 bit, `newRecoverySalt` 16 B/user, `MFA_TICKET_MAX_FAILS=5`, `MFA_USER_LIMIT=10`/900 s. | FP đúng. |
| #13 federation | `query.error` chỉ xét SAU `states.consume` (single-use) + so `sha256(binding)` hằng thời gian + `iss`; nhánh lỗi trả `denied`, không phiên. Test trích dẫn tồn tại (`federation.int-spec.ts` L900, L2550). | FP đúng. |
| #14/#15/#16/#28/#29 authorize | Tên test trích dẫn tồn tại (`authorize.int-spec.ts` L184/190/196; `request_not_supported`/`request_uri_not_supported` trong `run85-oidc-p0`, `run85-tester`); #16 có int mới (thiếu/rỗng/ngắn/sai alphabet ⇒ `invalid_request`, không code; control cấp code). Giá trị người dùng chỉ chọn nhánh lỗi. | FP đúng. |
| #36 lock | `openSync(…, 'wx', 0o600)`: O_EXCL từ chối file/symlink có sẵn; ra khỏi tmpdir dùng chung. Không còn tham chiếu `%TMP%/vg-drill.lock` trong runbook/plan (chỉ nhắc tên `vg-drill.lock`). `pentest.mjs`, `rotate-drill.mjs`, `backup-restore-drill.mjs` đều đi qua `acquireLock` ⇒ vẫn chung khoá. | Đúng cho CodeQL; xem 🟡 #1 về phạm vi khoá. |
| #38–40 walker | `readdirSync({withFileTypes})` + `Dirent.isDirectory()`. Khác biệt duy nhất: Dirent không theo symlink (stat có theo). `be/src`, `be/dist` không có symlink; tác giả chứng minh cùng sha256 trước/sau. | Đúng. |

Exposure: không bản sửa nào phản chiếu input vào response/log; text lỗi cố định. Failure: không phụ thuộc ngoài mới.

### 🟡 Nên sửa

- [ ] **🟡 #1 Phạm vi khoá drill hẹp lại, comment sai** — `be/scripts/drills/lib.mjs:594-599`.
  Comment vẫn ghi "One drill at a time on this host", nhưng `LOCK_FILE = join(BE_DIR, '.vg-drill.lock')` giờ là khoá **theo checkout**. Hai checkout/worktree trên cùng host (repo này dùng worktree thường xuyên) có thể chạy drill + pentest đồng thời trên cùng Redis db 7. Cả hai đều `FLUSHDB` db 7 khi dọn (`cleanupNamespace`).
  Vì sao không phải 🔴: `assertNamespace` còn chặn tiếp (cổng đang dùng, DB drill đã có, Redis db 7 không rỗng), chỉ hở cửa sổ TOCTOU khi hai lượt khởi động gần như cùng lúc. Trên Windows, `%TMP%` vốn đã theo user, nên khoá cũ cũng chưa thật sự "host-wide".
  Trả lời câu hỏi tác giả về vị trí lock: cân nhắc `join(homedir(), '.vg-drill.lock')`. Thư mục home không ghi được bởi user khác, nên vẫn đóng #36. Nó cũng giữ ngữ nghĩa cũ (một user ⇒ một khoá cho mọi checkout), khớp D90.3 "khoá chung". Cách này còn bỏ được dòng `.gitignore`.
  Nếu giữ `be/`: sửa comment thành "one drill at a time per checkout; `assertNamespace` guards across checkouts".
- [ ] **🟡 #2 JSDoc của `LogoutService` bị tách khỏi class** — `be/src/modules/oauth/logout/logout.service.ts:28-46`.
  `stringLogoutParams` được chèn giữa khối doc "RP-initiated + front-channel logout helpers…" và `@Injectable() class LogoutService`. Hệ quả: khối doc đó giờ mồ côi (TS/IDE gắn doc gần nhất cho hàm), và hover trên `LogoutService` mất mô tả invariant "fails closed… GET and POST agree".
  Cách sửa: chuyển `stringLogoutParams` (kèm doc của nó) lên trên khối doc class (−0 dòng).

### 💭 Nit

- `test/run92-codeql.int-spec.ts` "#7 operator-shaped client_id at /token": cả hai ca trả 4xx sau ~3 ms và **không tới** `findByClientId`.
  - Ca urlencoded: `resolveClientAuth` nhận `Map<string,string>`, nên `client_id[$ne]` chỉ là một key khác, `client_id` vắng ⇒ `invalid_client`.
  - Ca JSON: bị từ chối trước bước xác thực client.
  Test vẫn có ích làm regression guard, còn guard mới đã được unit phủ. Đường thật sự đưa mảng tới `findByClientId` là `/authorize?client_id=a&client_id=b` (`@Query()` thô). Cân nhắc thêm một ca ở đó ⇒ trang lỗi client lạ, không redirect.
- `ui.controller.ts` `interface LogoutQuery`: kiểu khai `string` nhưng thực tế là `string | string[]`. Khai đúng `string | string[]` sẽ để TS ép đi qua `stringLogoutParams`.
- `lib.mjs acquireLock` `catch {}` (có từ trước): mọi lỗi, kể cả `EACCES`/`EROFS`, đều báo "another drill holds…". Cân nhắc chỉ đổi thông điệp khi `e.code === 'EEXIST'`, còn lại rethrow.
- `test/drills-lock.spec.ts` lấy khoá thật trong `be/`, nên sẽ fail nếu operator đang chạy drill trong cùng checkout lúc chạy unit. Chấp nhận được; nếu theo 🟡 #1 (homedir) thì nên cho `LOCK_FILE` đọc override qua env để test dùng thư mục tạm riêng.
- `bearer.ts`: `raw.slice(0, 7).toLowerCase() === 'bearer '` dễ đọc hơn regex `/^bearer $/i`, cùng chi phí.

### Ghi nhận cho tech-lead / orchestrator (không phải lỗi code)

- **#35 lệch D92.9:** đồng ý "won't fix". Evidence drill được commit có chủ đích theo D87.11, đã qua `assertClean`, đường dẫn cố định, và không phải file tạm/bí mật. Tiêu chí "thư mục 0700" của D92.9 nhắm vào file tạm chứa bí mật (#34/#36). Đề nghị tech-lead ghi một dòng quyết định (D92.x) để khớp bảng triage với chính sách, không cần đổi thiết kế drill.
- **#21/#33/#34 won't fix, 17 "used in tests":** lý do khớp D92.9; vị trí đều nằm trong `be/test/`, `e2e/`, `fe-admin/test/`, `fe-admin/scripts/`.

### ✂️ Ponytail

- be/src/modules/oauth/logout/logout.service.ts:L36: shrink: hàm `str` nội bộ + 4 dòng gán là đủ gọn; giữ.
- be/src/modules/ui/ui.controller.ts:L256 + logout.service.ts:L73: `stringLogoutParams` chạy hai lần trên đường GET (controller rồi service). Giữ cả hai: controller chặn phản chiếu vào form, service là ranh giới cho mọi caller. Không cắt.

Lean already. Ship.

---

## Lô A (T2–T6 + cờ gitleaks D92.8, D92.2–D92.7, D92.11) — chưa commit, working tree

### Kết luận: PASS (0 🔴; 1 🟡 vào backlog DEBT-679)

### Tổng quan

Diff nhỏ, mỗi thay đổi bám một D92.x, không che lỗi (không `continue-on-error`, không skip theo `CI`, không nới check smoke). Điểm tốt:
- T3: tìm đúng nguyên nhân gốc (process chết sau check 5, không phải check 6), có test RED/GREEN bằng chính client của smoke (curl), sửa 3 dòng bằng cách bỏ lớp bọc thay vì thêm bắt lỗi toàn cục.
- T5: đo trước khi sửa, có số heap trước/sau và bằng chứng worker được tái tạo.
- T2: check 9 nay assert log KHÔNG nêu `MFA_ENCRYPTION_KEYS`, nên chứng minh được lỗi đến từ đúng biến dự định.

Đã chạy (reviewer):
- `npx vitest run test/serve-mjs-risk.test.ts` (fe-admin) ⇒ 33/33 PASS.
- `npx playwright test tests/totp.spec.ts` (e2e) ⇒ 5/5 PASS. Playwright dựng webServer theo config (1,2 phút), không chạy E2E full.
- `bash -n` cả hai `docker-smoke.sh` ⇒ ok. Không chạy smoke (D92.7).

### 🔴 Blocker

Không có.

### Kiểm từng điểm

**Workflow `ci.yml`**
- `quality`: service redis cùng digest với `int`, `6479:6379`, cùng `--health-cmd`, không `TEST_REDIS_URL`. Khớp mặc định `fe-admin/test/support/redis.ts:7`. Root `pnpm test` chạy `--workspace-concurrency=1`, và fe-admin chỉ DEL key của chính nó, nên không giẫm dữ liệu be. ✓
- `e2e`: mailpit cùng digest với `int`, `1025`/`8025`, health `/mailpit readyz` giống hệt `int` (đã chạy xanh ở đó). ✓
- Timeout: quality 30, int 45 (kèm comment chỉnh lại sau CI xanh), e2e 60. Các job khác giữ nguyên. ✓ D92.2.
- `Build BE` nằm trước `Integration tests`. `NODE_OPTIONS=--max-old-space-size=3072` chỉ ở step int (≤ 4096), không lan sang Vault/Sentinel. Worker jest kế thừa env, nên mỗi worker cũng bị chặn ở 3 GB, cao hơn ngưỡng tái tạo 1 GB. ✓ D92.3.
- Upload report `if: ${{ !success() }}`: chạy cả khi fail, huỷ hoặc timeout (biểu thức có hàm trạng thái nên được đánh giá khi job bị huỷ). ✓
- `secrets`: `--gitleaks-ignore-path /repo` là cờ hợp lệ của v8.21.2. Không đổi version, pin hay mount. Comment đã cập nhật. ✓ D92.8.

**T2 `be/scripts/docker-smoke.sh`**
- Khoá sinh mỗi lượt: `k1:` + 32 byte CSPRNG base64. Khớp `KID=/^[a-z0-9-]{1,16}$/` và `BASE64` của `mfa-crypto.ts`, không phải khoá `.env.example` (validator từ chối khoá đó). Có `mask` trước `export`.
- `node` có sẵn trên `ubuntu-latest`, và `secret()` vốn đã dùng nó.
- `-e MFA_ENCRYPTION_KEYS` nằm trong `ENV_ARGS`, nên tự áp cho smoke-ok, -noenv, -local và CLI check 12/13. ✓
- Check 9: container noenv chỉ thiếu `CSRF_SECRET`. Assert mới `log names MFA_ENCRYPTION_KEYS ⇒ fail` chốt đúng biến. ✓
- Canary check 11/12/13 dùng `${MFA_ENCRYPTION_KEYS#k1:}` (phần bí mật) với `grep -F --`/`-e`, nên ký tự `+/=` không gây lỗi regex. ✓

**T3 `fe-admin/serve.mjs`**: đọc srvx 0.11.22.
- `serveStatic` trả `FastResponse(nodeReadStream, {headers})`.
- `NodeResponse.headers` cache `#headers`, và `_toNodeResponse()` dùng chính `#headers`, nên `found.headers.set(...)` được gửi đi.
- Body là node stream ⇒ `pipeBody` (pipe trực tiếp), không còn qua `streamBody`/web stream.
- Mất header? Không:
  - Asset trước đây cũng chỉ có header srvx + nosniff + cache-control, không có CSP. CSP của 404 đến từ app qua `next()`, không đổi.
  - Content-Type, Content-Length, Content-Encoding/Vary giữ nguyên.
- 404 (`/assets/khong-ton-tai.js`) ⇒ `statics` trả undefined ⇒ `next()` ⇒ app, kèm CSP. Test kiểm `x-from: app`. ✓
- HEAD: Node bỏ body của HEAD. Hành vi này như trước, đã có test "HEAD => 200, same headers, no body". ✓
- Range: srvx không hỗ trợ (luôn 200 toàn bộ), trước và sau như nhau, không có rủi ro mới.
- Smoke check 8b: `{{.State.Running}} {{.State.Health.Status}}` = `true healthy`. Dockerfile có `HEALTHCHECK`, và `Running` bắt được process chết ngay cả khi health còn trễ chu kỳ 30 s. Nếu container biến mất, command substitution trả rỗng ⇒ fail 8b, không lọt qua `set -e`. ✓

**T5 jest `maxWorkers:1 + workerIdleMemoryLimit:'1GB'` thay `--runInBand`**
- Đã đọc `@jest/core` 30.0.5 `shouldRunInBand`: có `workerIdleMemoryLimit` ⇒ không in band, ngay cả với 1 worker. Claim trong log đúng.
- Tuần tự: `maxWorkers:1` ⇒ một file tại một thời điểm, như trước.
- `globalSetup`/`globalTeardown` chạy trong process cha, cùng `globalThis.__VG_INT_LOCK__`, nên lock được giữ và nhả đúng.
- Heartbeat gia hạn lock nay chạy ở process cha rảnh, ổn định hơn so với khi in band (event loop bận test).
- Worker được fork với `execArgv` của cha (`--experimental-vm-modules`) và env của cha, nên biến môi trường do preflight đặt vẫn tới worker.
- Khác biệt ngữ nghĩa duy nhất: mutation `process.env`/global do một file test để lại không còn rò sang file sau khi worker đã tái tạo. Đây là cải thiện cô lập, int đã chạy 2457/2458 (1 fail thuộc lô C lúc đó).
- Ghi chú: thêm `--runInBand` hoặc `--detectOpenHandles` vào lệnh tay sẽ quay về in band (không tái tạo). Local ổn, CI dùng script nên không bị.

**T6 cầu chì E2E**
- `maxFailures: 5` + `globalTimeout: 45'` chỉ khi `CI` (spread có điều kiện). Local giữ liệt kê mọi fail. 45' < 60' của job, còn chỗ cho install/browser.
- `MAX_WAIT_MS = 61 s` không gây fail giả cục bộ:
  - Allocator chỉ đi tới `next = last+1` hoặc `c+2` sau `markStale` (vì `markStale` đặt `max(last, c+1)`), nên một lần chờ tối đa khoảng 31 s.
  - 403 s/341 s ghi ở log là tổng của nhiều lần chờ ≤ 31 s, không phải một lần.
  - Ngưỡng chỉ bị vượt khi bước bị đốt nhanh hơn đồng hồ (hồi quy logic hoặc đồng hồ lùi). Đúng mục đích "fail nhanh thay vì ngủ".
- Mailpit bị thiếu giải thích được 5 fail, nhưng không giải thích 6 h. DEBT-678 đã mở kèm bằng chứng, hợp lệ theo D92.1.

### Security invariants / trust boundaries đã kiểm
- **Exposure (secret trong log CI)**: khoá MFA sinh mỗi lượt, mask, canary ở check 11/12/13; check 9 không in giá trị. 8b khi fail in 20 dòng log app, mỗi dòng tối đa 400 ký tự. Các check trước đã assert log app không chứa secret, và `OIDC_CLIENT_SECRET` đã được mask.
- **Availability (fe-admin BFF)**: client đóng socket sớm không còn giết process ở đường asset (test curl ×3 + 8b).
- **Supply chain**: service mới dùng lại image đã pin digest, không thêm action, không đổi pin gitleaks.
- **Static file boundary**: `serve.mjs` vẫn chỉ GET/HEAD, `/assets/` và `dist/client`. Bộ test traversal 33/33 không đổi.

### 🟡 Nên sửa
- **DEBT-679** — `fe-admin/serve.mjs` (lớp lỗi, không phải dòng mới):
  - Bản sửa đóng crash `ERR_INVALID_STATE` cho asset tĩnh. Response của app (SSR/Start, BFF proxy) vẫn có thể có body là web `ReadableStream` và đi qua `streamBody` của srvx.
  - Chưa có test chứng minh client huỷ giữa chừng một response app dài không làm chết process.
  - Vì sao: nếu cùng race xảy ra ở đó, bất kỳ ai cũng có thể làm sập BFF (DoS, orchestrator phải restart). Đây là đúng rủi ro của run này, chỉ ở một đường khác.
  - Đề xuất: thêm ca vào `serve-mjs-risk.test.ts`, với fixture app trả `ReadableStream` lớn hoặc chậm, client huỷ socket sau byte đầu, rồi assert `exitCode === null` và log không có `ERR_INVALID_STATE`. Nếu RED, sửa gốc theo cùng hướng (không dùng `uncaughtException` toàn cục).

### 💭 Nit
- `be/scripts/docker-smoke.sh:71`: `mask` nhận cả chuỗi `k1:<b64>`. GitHub chỉ che đúng chuỗi đã đăng ký, nên nếu chỉ phần base64 xuất hiện trong log thì không bị che. Cân nhắc thêm `mask "${MFA_ENCRYPTION_KEYS#k1:}"`. Rủi ro thấp: check 11 đã chứng minh app không log khoá.
- `e2e/tests/totp.spec.ts:58`: `expect(MAX_WAIT_MS).toBe(61_000)` trùng với regex `(> 61 s)` ngay trên.
- `fe-admin/test/serve-mjs-risk.test.ts`: phụ thuộc `curl` trên PATH (đã ghi rõ trong comment). Chấp nhận được vì smoke dùng curl.

### ✂️ Ponytail
- e2e/tests/totp.spec.ts:L58: delete: `expect(MAX_WAIT_MS).toBe(61_000)`. Regex của `rejects.toThrow` đã chốt 61 s.

net: -1 lines possible.

## Lô B (T1 gitleaks, D92.8 + D92.15) — `.gitleaksignore` mới, chưa commit

### Kết luận: PASS cho nội dung lô B, kèm 1 🔴 chéo ở file của lô A (phải sửa trước lô D/commit)

### Tổng quan

11 fingerprint đúng định dạng, đúng dòng, lý do đúng sự thật, không lộ giá trị. Bản này hẹp nhất có thể: không allowlist path, không thêm regex vào `.gitleaks.toml` (file này không đổi). Việc DỪNG ở #3 đúng quy trình: backend-dev không tự quyết, báo lên và orchestrator chốt bằng D92.15.

Đã kiểm (reviewer, giá trị luôn bị che, không in ra):
- Định dạng: 11 dòng không phải comment, mỗi dòng `<sha 40 ký tự>:<file>:<rule>:<line>`. `git rev-parse` của từng sha trả lại đúng sha đó. Commit trùng với bảng CI #40 trong `tasks.md`. File ASCII, LF, không CRLF.
- Trỏ đúng dòng: file có trong commit, và dòng nằm trong hunk mà chính commit đó thêm vào (`git show -U0`). Ở chế độ `git`, gitleaks quét patch, nên fingerprint này khớp.
- #1/#9/#10 `private-key`: file chỉ có marker BEGIN và không có END (#1 ở dòng 1004/1024, #9/#10 ở dòng 119/123). Không có dòng base64 ≥ 60 ký tự. Không nhắc `be/keys`. Rule `private-key` của v8.21.2 khớp được, vì đoạn từ BEGIN tới chuỗi `KEY-----` kế tiếp dài trên 64 ký tự. Đoạn đó là code/câu văn, không có thân khoá ⇒ không cần rotate. Điều kiện DỪNG của D92.8 không xảy ra.
- #2: giá trị bằng đúng base32 của seed RFC 6238 `12345678901234567890` (so sánh bằng máy). #11: giá trị bằng đúng base64 của `the sample nonce` (RFC 6455 §4.2.2).
- #4: ca âm "email trùng admin seed ⇒ throw trước khi ghi" (có snapshot trước/sau). #5–#8: `const SECRET` có nhãn canary, chứa chuỗi tuần tự, fetch/API bị mock. Lý do ghi trong file khớp với nguồn.
- Không lộ: grep `BEGIN|PRIVATE KEY|sk_live|rk_live` trên `.gitleaksignore` ⇒ 0. Comment chỉ nêu bản chất, không nêu giá trị.
- CI: `--gitleaks-ignore-path /repo` (lô A). Ở v8, cờ này nhận thư mục và tự nối thêm `.gitleaksignore`. Comment (`#`) và dòng trống bị bỏ qua. Không có binary gitleaks local ⇒ cổng thật là job `secrets`.

### Đánh giá D92.15 (#3 `stripe-access-token`, `be/test/run82-tester.int-spec.ts:417` @`adf130a`): đồng ý

- Phần sau tiền tố dài 13 ký tự `[A-Za-z0-9]` và có chuỗi `MARK`. Khoá Stripe thật dài 24 hoặc khoảng 99 ký tự.
- Ngữ cảnh: `const SECRET` trong describe "T2 DEBT-533: hostile client config values never echo". Hằng này đi cùng `JWTISH`/`KB2` cũng mang `MARK`, và được nhúng vào userinfo/fragment/query của redirect URI để assert không bị phản chiếu ⇒ đây là canary theo thiết kế.
- `be/src` và `be/package.json` không có `stripe`. `git log -S sk_live_ --all` chỉ ra `adf130a` (lần thêm duy nhất). Doc run 82 chỉ nhắc tiền tố (độ dài phần sau = 0, không khớp rule).
- D92.8 đặt tiền tố `sk_live_` làm điều kiện DỪNG để buộc người có thẩm quyền chốt, không phải để cấm vĩnh viễn. Orchestrator đã chốt có bằng chứng ⇒ thêm fingerprint là hợp lệ.

### 🔴 Blocker (chéo lô A, không thuộc `.gitleaksignore`)

- [ ] **Bảo mật/CI: hit gitleaks mới sắp vào lịch sử**
  `e2e/tests/totp.spec.ts:46` — ca mới của lô A (T6) có `const secret = "<base32 32 ký tự>"`. Giá trị là fixture giả: base32 của bảng chữ cái `a…t`.
  Vì sao: dòng này cùng dạng với #2 (`secret = "…"`, 32 ký tự). Mà #2 có entropy 3,58 đã bị rule `generic-api-key` (ngưỡng 3,5) bắt; dòng mới có entropy 4,35. Khi orchestrator commit, gitleaks sẽ có hit mới với fingerprint mới ⇒ job `secrets` đỏ lại, T1 không đạt "CI xanh". D92.8 cấm thêm ignore cho trường hợp này.
  Đề xuất (theo D92.8): dựng giá trị lúc chạy, ví dụ `const secret = base32Encode(Buffer.from("abcdefghijklmnopqrst"))` nếu helper có sẵn. Hoặc dùng lại hằng của ca allocator (dòng 35, đã có fingerprint) bằng cách tách nó thành biến dùng chung **mà không sửa dòng 35**. Sau đó chạy lại `playwright test tests/totp.spec.ts`.
  Ngoài ra: quét xấp xỉ (BEGIN PRIVATE KEY, `(sk|rk)_*_`, keyword + literal ≥ 16 ký tự, entropy) trên `c7c54c2..HEAD` và working tree run 92 không thấy ứng viên nào khác vượt 3,5. Hai literal trong `ui.int-spec.ts:502` và `access-token-liveness.spec.ts` có entropy 3,46/3,33 ⇒ không phải hit.

### Security invariants / trust boundaries đã kiểm

- Exposure: `.gitleaksignore` và log/review không chứa giá trị hay literal PEM header. Lý do của từng mục đã được kiểm bằng so sánh máy hoặc đọc có che giá trị, không dựa vào lời dev.
- Fail closed: fingerprint gắn với commit lịch sử bất biến. Mọi hit mới (dòng khác, commit khác) vẫn làm CI đỏ. `.gitleaks.toml` không nới rule nào ⇒ không làm mù leak thật về sau.
- Khoá ký: #1/#9/#10 không chứa thân khoá ⇒ không có khoá dev/E2E/prod bị lộ, không cần rotate.

### 🟡 Nên sửa

- `.gitleaksignore:4-5` — comment đầu file vẫn nói "#3 … deliberately NOT listed here: held …", nhưng #3 đã được thêm ở cuối file (D92.15). Comment mâu thuẫn với nội dung sẽ làm người sau nghi #3 bị thêm lén. Đề xuất: đổi thành "#3 added after orchestrator decision D92.15", và chuyển mục #3 về đúng thứ tự giữa #2 và #4. → DEBT-680 nếu không sửa trong run.

### 💭 Nit

- Canary ở #3 vẫn còn trong cây (`run82-tester.int-spec.ts`). Nếu dòng đó bị sửa, theo D92.8 phải dựng giá trị lúc chạy (`'sk_' + 'live_' + …`). Nên làm luôn khi có dịp chạm file, để không phụ thuộc vào fingerprint.

### ✂️ Ponytail

Lean already. Ship. (Một file 33 dòng, mỗi mục là 1 comment + 1 fingerprint, đúng mức tối thiểu D92.8 yêu cầu.)
