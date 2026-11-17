# Run 92 `92-ci-green` — CI GitHub xanh + triage CodeQL (M8, lane BE/FE/ops)

**Nguồn:** orchestrator đọc GitHub trên Chrome của người dùng, 2026-11-17.

**Hiện trạng:**
- CI `develop` **đỏ hoặc bị huỷ từ run 86**: các lượt #34 → #40 huỷ/fail sau 6 giờ. Lượt #42 trên `7b3fa83` đang chạy.
- Điều kiện go-live (4) "Dependabot/CodeQL/gitleaks sau push" hiện **KHÔNG đạt**.
- Dependabot: 1 cảnh báo (`deepmerge`, advisory đã bị rút) — orchestrator đã dismiss.
- Secret scanning của GitHub: 0 cảnh báo.
- CodeQL: 40 cảnh báo đang mở.

## Ràng buộc cứng (truyền nguyên cho mọi agent)
- **Hạ tầng:**
  - KHÔNG `compose up`.
  - KHÔNG tạo hoặc restart container, trừ Vault thử theo quy ước đã có.
  - Chỉ dùng `veyrigate-mongo` / `veyrigate-redis` / `veyrigate-mailpit-1`, tách bằng tên DB / db index riêng.
  - KHÔNG FLUSHALL, KHÔNG drop DB không phải của mình.
  - KHÔNG đụng `sso-idp` / `sso-idp-e2e`, ngoài phần setup của E2E.
- **File cấm đụng:**
  - KHÔNG đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.
  - KHÔNG đọc, KHÔNG đụng `be/.env` và `be/keys`.
- **Secret:** KHÔNG in secret hoặc literal PEM header vào docs/log.
- **Process và gói:**
  - KHÔNG Stop-Process / taskkill process không phải mình tạo.
  - KHÔNG download, KHÔNG `npx` gói chưa cài.
- **Git:**
  - KHÔNG commit, KHÔNG push (orchestrator làm).
  - KHÔNG viết lại lịch sử git (rewrite là quyết định của người dùng).
- **Scratch:** chỉ trong scratchpad riêng của agent.

## Bằng chứng CI #40 (`c7c54c2`, run 43828067920)

### secrets
gitleaks v8.21.2 quét toàn bộ lịch sử, có `--redact`: 11 leak, exit 1.

| # | File:dòng | Rule | Commit |
|---|---|---|---|
| 1 | `be/scripts/pentest/checks.mjs:1004` (đã sửa ở `4dc5639` nhưng vẫn còn trong lịch sử) | private-key | `8dfa821` |
| 2 | `e2e/tests/totp.spec.ts:35` | generic-api-key | `eba5260` |
| 3 | `be/test/run82-tester.int-spec.ts:417` | stripe-access-token | `adf130a` |
| 4 | `be/test/seed-e2e-admin.int-spec.ts:210` | generic-api-key | `ceeb3d6` |
| 5 | `fe-admin/test/admin-secrets.test.ts:10` | generic-api-key | `15cba2d` |
| 6 | `fe-admin/test/secrets-fn.test.ts:7` | generic-api-key | `15cba2d` |
| 7 | `fe-admin/test/client-secrets.test.tsx:33` | generic-api-key | `15cba2d` |
| 8 | `fe-admin/test/client-secrets-risk.test.tsx:33` | generic-api-key | `15cba2d` |
| 9 | `docs/agile/sso-idp/runs/02-R3-R5/test-report.md:119` | private-key | `cc93b7e` |
| 10 | `docs/agile/sso-idp/test-report.md:119` | private-key | `4c2104a` |
| 11 | `.agents/plugins/superpowers/tests/brainstorm-server/ws-protocol.test.js:53` | generic-api-key | `83f5ba3` |

Fingerprint có dạng `<commit full sha>:<file>:<rule>:<line>`.

### quality
- 9 file vitest của fe-admin fail với lỗi `vg-test-redis is not reachable at redis://localhost:6479/0` (`fe-admin/test/support/redis.ts:22`).
- Các file fail gồm `bff-risk`, `bff-a5`, `admin-secrets`, `admin-api`, `admin-api-risk`, …
- Nguyên nhân: job quality không có Redis service.

### int
- Job thoát với exit 134 sau khoảng 6 phút: `FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory`.
- Trước đó đã FAIL các file `run87-admin-recover`, `run88-bootstrap`, `run71-tester`, `db-cli-dry-run`.
- Nhóm test này có tên "built … CLI" ⇒ nghi job int thiếu bước `pnpm -C be build` / chưa có `dist`.

### be-image
- Smoke `be/scripts/docker-smoke.sh`: BE không boot được vì `MFA_ENCRYPTION_KEYS is required` (bắt buộc từ run 89).
- Kết quả: `FAIL check 2: health status 'unhealthy'`.

### fe-admin-image
- Smoke `fe-admin/scripts/docker-smoke.sh`: check 1–5 ok.
- Check 6 lỗi `curl: (56) Recv failure: Connection reset by peer`.

### e2e
- Job không có `timeout-minutes` ⇒ bị huỷ sau 6 giờ.
- Cuối log lặp lại `POST /login` 302 → `GET /login/mfa` 200.
- Nghi: bộ cấp mã TOTP chờ vô hạn, hoặc vòng thử lại MFA trên CI.

### Job xanh
promtool, sbom.

## Task

### T1 [ops] gitleaks xanh (mở DEBT mới)
1. Xác minh TỪNG phát hiện là giá trị giả / fixture.
   - Đọc file ở commit tương ứng bằng `git show <commit>:<file>`.
   - KHÔNG in giá trị ra log/report; chỉ ghi kết luận "fixture/giả" kèm lý do.
2. Riêng #9 và #10 (khối PEM trong test-report cũ): xác định khoá đó có phải khoá ký dev/prod đang hoặc đã từng dùng không.
   - KHÔNG đọc `be/keys`.
   - Kết luận từ ngữ cảnh doc/commit, hoặc so `kid`/thumbprint với JWKS dev nếu cần.
   - Nếu là khoá thật đã dùng ⇒ DỪNG và báo orchestrator: cần rotate, và người dùng quyết định có rewrite lịch sử hay không.
3. Nếu là giá trị giả ⇒ thêm vào `.gitleaksignore` theo fingerprint.
   - Mỗi dòng kèm comment lý do.
   - Không nới rule toàn cục.
4. Chạy gitleaks cục bộ nếu đã có sẵn binary hoặc image local. Nếu không có thì không tải về, và ghi rõ là không chạy được.

### T2 [ops/BE] be-image smoke
`docker-smoke.sh` tự sinh `MFA_ENCRYPTION_KEYS` tạm thời, giống cách script đang làm với các secret test khác. Không hardcode khoá trong repo.

### T3 [ops/FE] fe-admin-image smoke, check 6
Tìm nguyên nhân bị reset kết nối (đọc script + Dockerfile + server), rồi sửa.

### T4 [ops] quality
- fe-admin test cần Redis ⇒ thêm service Redis 7 vào job quality, đúng cổng/URL mà `test/support/redis.ts` dùng (6479, db 0).
- Giữ nguyên hành vi khi chạy local.

### T5 [ops/BE] int
- Thêm bước build trước int nếu các CLI test cần `dist`.
- Xử lý OOM, theo một trong các hướng:
  - `NODE_OPTIONS=--max-old-space-size=…` với giá trị hợp lý cho runner 7 GB;
  - `workerIdleMemoryLimit`;
  - `--logHeapUsage` để tìm suite gây rò bộ nhớ.
- Int local phải giữ xanh (2444).

### T6 [ops/test] e2e
- Thêm `timeout-minutes` cho mọi job chưa có; e2e ≤ 60.
- Tìm vì sao MFA lặp vòng trên CI (bộ cấp mã TOTP, đồng hồ, hoặc thiếu ENV trên CI) và sửa để test fail nhanh thay vì treo.

### T7 [BE/sec] Triage 40 cảnh báo CodeQL
- Danh sách cảnh báo nằm trong `codeql-alerts.md`.
- Mỗi cảnh báo được kết luận một trong hai:
  - **sửa**: true positive ⇒ sửa code + thêm test;
  - **dismiss**: kèm lý do kỹ thuật ≤ 280 ký tự và loại `false positive` / `used in tests` / `won't fix`.
- Ghi kết quả thành bảng trong `runs/92-ci-green/codeql-triage.md`. Orchestrator sẽ dismiss trên GitHub.
- Ưu tiên xử lý trước:

| Cảnh báo | Vị trí |
|---|---|
| #9 critical, type confusion | `logout.service.ts:118` |
| #7/#8 NoSQL injection | `client.service.ts:233`, `resource.service.ts:56` |
| #1 ReDoS | `bearer.ts:20` |
| #2 DOM XSS | `logout-redirect.js:11` |
| #27/#37 hash yếu | `crypto.util.ts:41`, `recovery-codes.ts:43` |
| CSRF / authorize "user-controlled bypass" | #13–16, #28, #29, #31, #32 |

## Thứ tự lô
1. **A:** T2, T3, T4, T5, T6 (CI workflow + script).
2. **B:** T1 gitleaks.
3. **C:** T7 CodeQL.
4. **D:** gate local — be unit, int FULL, fe-admin, E2E ×1, và X3 nếu đụng FE.
5. Orchestrator push, rồi theo dõi CI trên GitHub. CI đỏ ⇒ retry lô tương ứng.

## Quyết định D92.x (tech-lead fold, 2026-11-17)

Tiêu chí chung: "dùng được ở production". Áp cho mọi lô:
- KHÔNG che lỗi: không `continue-on-error`, không `test.skip` theo `CI`, không nới check smoke, không allowlist theo path/thư mục.
- Mỗi sửa phải có bằng chứng: lệnh + output ghi vào `log.md`.

**D92.1 — Chia lô / agent**

| Lô | Agent | Phạm vi |
|---|---|---|
| A | backend-dev | T2, T3, T4, T5, T6 + **mọi** sửa `.github/workflows/ci.yml` (kể cả cờ gitleaks của D92.8) |
| B | backend-dev | Chỉ T1: `.gitleaksignore`, sau khi A xong. Không đụng `ci.yml`. |
| C | backend-dev | T7, chạy **song song được với A** |
| D | tester | Gate |

- T3: nếu nguyên nhân nằm trong `fe-admin/src/**` (không phải `serve.mjs`/script) ⇒ chuyển phần sửa đó cho frontend-dev trong lô A.
- Lô C có file rời với A (`be/src/**`, `be/scripts/drills|pentest/**`, `codeql-triage.md`). Lô C KHÔNG đụng `ci.yml`/`codeql.yml`.
- Các lượt int của A và C tự tuần tự nhờ `vg:int-lock`. Gặp lock thì chờ, KHÔNG xoá key.
- Không task nào phải dời sang run sau. Chỉ mở DEBT khi gặp một trong ba tình huống:
  - T5 tìm ra rò bộ nhớ mà chưa sửa gốc được;
  - T6 không tìm ra nguyên nhân MFA lặp;
  - một cảnh báo T7 cần đổi thiết kế. Khi đó DỪNG, báo orchestrator, tách run.

**D92.2 — Timeout job**

| Job | `timeout-minutes` |
|---|---|
| `quality` | 30 (mới) |
| `e2e` | 60 (mới) |
| `int` | 45 (từ 30); sau CI xanh đầu tiên chỉnh thành ⌈1,5 × thời lượng đo được⌉ và ghi số đo vào log |

Các job còn lại giữ nguyên (đã có).

**D92.3 — T5 int**

1. Thêm bước `pnpm -C be build` trước `test:int`. Các spec CLI kiểm chính artefact `dist` sẽ được ship. KHÔNG thêm `pretest:int` cho local.
2. Đo trước khi sửa. Chạy một lượt cục bộ có `--logHeapUsage`, ghi vào log:
   - heap đầu / giữa / cuối;
   - 5 file làm heap tăng mạnh nhất.
3. Thứ tự xử lý:
   - (a) Suite rò (app/connection/timer không đóng) ⇒ sửa trong test.
   - (b) Nếu vẫn tăng đơn điệu: thay `--runInBand` bằng `maxWorkers: 1` + `workerIdleMemoryLimit` (≈ `'1GB'`) trong `jest.int.config.js`. Vẫn tuần tự, áp cả local. Chỉ giữ khi:
     - log heap chứng minh worker được tái tạo;
     - globalSetup/lock vẫn đúng;
     - int FULL cục bộ xanh (≥ 2444).
   - (c) `NODE_OPTIONS=--max-old-space-size=3072` chỉ ở step int trên CI, làm lưới an toàn. Không bao giờ > 4096: runner 7 GB còn chạy chung Mongo, Redis, Mailpit, Vault, Sentinel.
4. Không shard int sang nhiều job ở run này.

**D92.4 — T4 quality**

- Thêm service `redis` vào job `quality`:
  - cùng image pin digest như job int;
  - `ports: 6479:6379`;
  - cùng `--health-cmd`.
- KHÔNG đặt `TEST_REDIS_URL`: mặc định của `fe-admin/test/support/redis.ts` đã khớp.
- Không mock Redis. Local không đổi.

**D92.5 — T6 e2e**

1. Thêm service `mailpit` vào job `e2e`:
   - cùng image pin digest như job int;
   - `1025:1025`, `8025:8025`;
   - health `/mailpit readyz`.

   Đây là lỗ hổng plan: 4 spec cần thư.
2. Trong `playwright.config.ts`, chỉ khi `CI`:
   - `maxFailures: 5`;
   - `globalTimeout: 45 * 60_000`.
3. Upload report với `if: ${{ !success() }}` (gồm cả khi bị huỷ).
4. Bộ cấp mã (`e2e/tests/support/totp.ts`, `nextCode`): nếu phải chờ > 61 s (2 chu kỳ) thì `throw` lỗi rõ ràng, không ngủ. Thêm unit test cho chặn trên này vào `totp.spec.ts`.
5. Nguyên nhân gốc vòng `POST /login` → `GET /login/mfa`:
   - Tái hiện với env giống CI: `CI=true`, DB E2E dựng mới, Mailpit có/không.
   - Ghi bằng chứng (request/response, log BE không chứa mã/secret) vào `log.md`.
   - Không tìm ra ⇒ mở DEBT kèm bằng chứng. Cầu chì ở bước 2–4 vẫn phải vào.

**D92.6 — T2 be-image**

- `docker-smoke.sh` sinh `MFA_ENCRYPTION_KEYS="k1:$(node … randomBytes(32).toString('base64'))"` cho mỗi lượt chạy, rồi `mask`.
- Truyền bằng `-e MFA_ENCRYPTION_KEYS` cho:
  - `vg-be-smoke-ok`, `-noenv`, `-local`;
  - các lượt CLI ở check 12/13.
- Không dùng khoá trong `.env.example`/`e2e/config/env.ts`.
- Thêm giá trị này vào danh sách canary của check 11 (log không chứa nó).
- Check 9 phải vẫn fail vì đúng biến dự định ban đầu: assert tên biến trong log, không dừng ở "exit ≠ 0".

**D92.7 — Kiểm chứng cục bộ dưới ràng buộc "không tạo container"**

- `docker-smoke.sh` (BE và fe-admin) **không** chạy cục bộ. Kiểm cục bộ bằng:
  - `bash -n`;
  - tái hiện ngoài container (D92.11).
- Cổng thật là job CI `be-image`/`fe-admin-image`. Đỏ ⇒ retry lô A. Orchestrator có thể xin người dùng ngoại lệ.
- gitleaks: dùng binary local nếu có. Nếu không, chỉ được chạy image `zricethezav/gitleaks` **đã có sẵn local, đúng digest** của CI, vì T1 cho phép tường minh. Bắt buộc:
  - `docker run --rm --network none -v <repo>:/repo:ro`;
  - không pull.
- Không có cả binary lẫn image ⇒ ghi "không chạy được", cổng là job CI `secrets`.

**D92.8 — T1 gitleaks**

- Dùng `.gitleaksignore` theo **fingerprint** (`<sha>:<file>:<rule>:<line>`), một dòng cho mỗi phát hiện. Dòng ngay trên là comment `# #n <rule> <file>: <vì sao là fixture/giả>, xác minh run 92`, không chứa giá trị.
- KHÔNG allowlist path, KHÔNG thêm regex vào `.gitleaks.toml`. Lý do:
  - path allowlist làm mù cả leak thật sau này trong file đó;
  - fingerprint gắn với commit lịch sử, bất biến, hẹp nhất.
- Lô A thêm `--gitleaks-ignore-path /repo` tường minh vào step `secrets` (không dựa vào cwd của image) và sửa comment `ci.yml` nhắc tới `.gitleaksignore`. Pre-commit hook đọc file ở root, không đổi.
- Điều kiện DỪNG (báo orchestrator, không ghi ignore):
  - #1/#9/#10: khối PEM là khoá từng dùng ở dev/E2E/prod, tức `kid`/thumbprint trùng JWKS từng công bố, hoặc doc/commit nói lấy từ `be/keys`;
  - #3: giá trị có tiền tố `sk_live_`/`rk_live_`;
  - bất kỳ giá trị nào không chứng minh được là giả.
- Khoá dev thật cũng tính là lộ: phải rotate. Rewrite lịch sử do người dùng quyết định.
- Fixture còn trong cây hiện tại (`totp.spec.ts`, test fe-admin): không bắt buộc sửa nguồn. Nếu sau này dòng bị sửa và gitleaks báo lại ⇒ đổi fixture sang giá trị dựng lúc chạy, không thêm ignore mới.

**D92.9 — T7, chính sách triage CodeQL**

- **Sửa** mọi true positive hoặc phòng thủ chiều sâu rẻ trên trust boundary trong `be/src`: **#9, #7, #8, #1, #2**. Mỗi sửa có test âm theo `review-techlead.md` mục "Cổng security".
  - #9: `state` không phải string ⇒ coi như vắng.
  - #7/#8: kiểm `typeof … === 'string'` trước khi tới filter Mongo. `findByClientId` ⇒ `null`.
  - #1: parse không dùng regex, cùng tập chấp nhận.
  - #2: chỉ điều hướng `http:`/`https:`.
- **Dismiss "false positive" chỉ khi đã có bằng chứng**, và lý do ghi tên test/caller:
  - **#27** `sha256` (crypto.util): kiểm mọi caller qua CodeGraph `codegraph_callers`. Đầu vào phải toàn là giá trị CSPRNG ≥ 128 bit.
    - Có đầu vào entropy thấp mà là bí mật ⇒ SỬA (HMAC với khoá server, hoặc Argon2).
    - Email/định danh không bí mật ⇒ vẫn FP, ghi rõ.
  - **#37** recovery code: 80 bit CSPRNG + salt riêng mỗi user + giới hạn lượt thử ⇒ FP.
  - **#13–16, #28, #29**: kiểm tra hợp lệ giao thức (state/binding, `request`, `response_mode`, PKCE), không phải quyết định phân quyền ⇒ FP. Trích int test hiện có.
  - **#31/#32** `LogoutCsrfGuard`: thiếu `_csrf` thì sang trang xác nhận (run 86). Phải có int test chứng minh `POST /logout` có cookie phiên hợp lệ nhưng không có `_csrf` ⇒ phiên **không** bị huỷ.
    - Chưa có test ⇒ thêm rồi mới dismiss.
    - Test cho thấy phiên bị huỷ ⇒ SỬA, và đây là quyết định thiết kế ⇒ DỪNG báo tech-lead.
- **Script vận hành chạy trên host production** (`be/scripts/drills/**`, theo runbook) được coi như code production:
  - **#36** temp file không an toàn ⇒ SỬA: `mkdtemp` 0700, file mở bằng `wx` / mode 0600.
  - **#33–35** ⇒ xem luồng dữ liệu. Nếu đó là mục đích của drill và file nằm trong thư mục 0700 ⇒ dismiss "won't fix" kèm lý do.
- **Pentest harness** (#38–40): SỬA nếu ≤ ~10 dòng (`mkdtemp`/`wx`), nếu không thì "won't fix" (công cụ operator, không chạy trên host production).
- **#21** `fetch-openapi.mjs`: "won't fix" nếu URL cố định/local (kiểm không nhận URL từ người dùng).
- **Test** (#3–6, #10–12, #17–20, #22–26, #30): dismiss "used in tests" sau khi xác nhận file chỉ thuộc test, không được `src` import.
- **Đầu ra:**
  - `codeql-triage.md` với cột: `# | rule | vị trí | kết luận (sửa/dismiss) | loại dismiss | lý do (EN, ≤ 280 ký tự) | bằng chứng (test/caller/dòng)`;
  - vị trí xác định theo nội dung cảnh báo, không chỉ theo số dòng (số dòng có thể lệch sau sửa).
- Không đổi `codeql.yml` (`paths-ignore`/`query-filters`) ở run này (DEBT-674).

**D92.10 — Gate lô D (tester)**

- be unit.
- int FULL: ≥ 2444 + test mới, có `pnpm -C be build` trước.
- fe-admin test + build (Redis local :6479).
- `pnpm -r typecheck` + lint.
- E2E ×1: vì đổi `playwright.config.ts`, `totp.ts`, `logout-redirect.js`.
- X3 chỉ khi T3 đụng `fe-admin/src/**`.
- Pentest harness không bắt buộc. Nếu chạy thì restart Mailpit trước/sau theo DEBT-664.
- Sau khi push, PASS cuối của run chỉ khi:
  - CI #N trên commit run 92 có **mọi** job xanh (quality, int, e2e, secrets, promtool, fe-admin-image, be-image, sbom);
  - CodeQL không còn cảnh báo mở: các cảnh báo đã sửa tự đóng sau quét lại, phần còn lại orchestrator dismiss theo bảng.
- Go-live (4) vẫn cần người dùng xác nhận.

**D92.11 — T3 fe-admin-image check 6**

1. Tìm nguyên nhân gốc trước, tái hiện ngoài container:
   - `pnpm -C fe-admin build`;
   - `node fe-admin/serve.mjs` với cùng env giả của script, `PORT` trống (vd. 3399), `NODE_ENV=production`;
   - `curl /assets/khong-ton-tai.js`.
2. Sửa phải giữ hợp đồng check 6: 404 kèm CSP.
3. Nếu nguyên nhân là process chết, thêm vào smoke một assert: container vẫn `running`/`healthy` sau check 6–8.
4. Không nới hay xoá check.
5. Dừng process mình tạo sau khi tái hiện.

**D92.12 — Không làm ở run này**

- Rewrite lịch sử git.
- Thêm GitHub secret.
- Bật branch protection (DEBT-227, người dùng làm trên GitHub).
- Đổi version gitleaks hay action pin.

**D92.13 — Báo cáo**

- Mỗi lô ghi vào `log.md`:
  - lệnh;
  - số test;
  - số đo heap/thời lượng (T5);
  - bằng chứng nguyên nhân (T3/T6).
- Không in giá trị secret, PEM header hay mã TOTP.

**D92.14 — DEBT mở bởi tech-lead:** DEBT-673 (`.agents/` vendored bị track), DEBT-674 (bộ lọc CodeQL cho test), DEBT-675 (smoke image chỉ kiểm được trên CI).
