# Test Report — run 23-bugfix — 2026-10-14 (tester)

## Kết quả: **PASS** (BE unit 198/198, BE int 482/482, E2E 1/1; typecheck/lint 0; grep log E2E sạch)

Preflight CodeGraph v1.6.2 (index up-to-date, `sync` no-op). Đọc code qua CodeGraph + đọc file.
Terminal = Git Bash. KHÔNG `compose up`, KHÔNG FLUSH/drop, KHÔNG dừng container.
Container dùng sẵn (đang chạy): `vg-test-mongo@27117`, `vg-test-redis@6479`, `aegate-mongo@27017`
(DB `sso-idp-e2e`), `aegate-redis@6379` (`/2`), `veyrigate-mailpit-1`.

Không sửa code sản phẩm. Các test hiện có đã phủ đủ acceptance (chi tiết bảng dưới); không cần bổ
sung test — logic đúng, không trả lại dev.

---

## Lệnh đã chạy + output thực tế

### 1. BE typecheck — exit 0
```
$ pnpm -C be typecheck   ($ tsc --noEmit)   → exit 0 (không lỗi)
```

### 2. BE lint — exit 0
```
$ pnpm -C be lint        ($ eslint src test) → exit 0 (không lỗi)
```

### 3. E2E typecheck — exit 0
```
$ pnpm -C e2e typecheck  ($ tsc --noEmit)   → exit 0 (không lỗi)
```

### 4. BE unit `pnpm -C be test` — exit 0 (KHÔNG chạy globalSetup)
```
Test Suites: 18 passed, 18 total
Tests:       198 passed, 198 total
Ran all test suites.
```
Không có dòng preflight / "not reachable" / "docker start" trong output ⇒ xác nhận `jest.config.js`
dùng regex `.spec.ts$`, `pnpm test` KHÔNG gắn `--globalSetup` (acceptance T4: unit không chạy preflight).

### 5. BE int `pnpm -C be test:int` — exit 0
```
Test Suites: 23 passed, 23 total
Tests:       482 passed, 482 total
Ran all test suites.
```

### 6. Preflight fail-fast + `--forceExit` không che fail (T4) — exit 1 trong 1.67s
```
$ time env TEST_MONGO_URI=mongodb://localhost:1/x pnpm -C be test:int -- test/health.int-spec.ts
real  0m1.673s      EXITCODE=1
stderr: Error: Jest: Got error running globalSetup - .../be/test/int-preflight.mjs,
        reason: Integration test dependencies not reachable: vg-test-mongo (localhost:1).
```
Port đóng (`localhost:1`) qua `TEST_MONGO_URI` ⇒ probe fail < 10s, message nêu tên container; `--forceExit`
vẫn trả **exit 1** (không biến fail thành pass). KHÔNG dừng/đụng container thật (chỉ đổi URI probe).

### 7. E2E thật `DEBUG=pw:webserver pnpm -C e2e e2e` — exit 0
```
  1 passed (27.9s)
```
Log đầy đủ (stdout+stderr BE/FE webServer) ghi về `/tmp/vgqa/e2e.log` — **210 dòng** (104 dòng
`pw:webserver` của Playwright health-poll + 103 dòng `[WebServer]` gồm build/seed/pino JSON).
BE chạy `NODE_ENV=test` ⇒ pino JSON; `stdout/stderr:"pipe"` ⇒ toàn bộ log BE lọt vào output.

---

## Grep log E2E (210 dòng đã quét) — tất cả phải 0, trừ `request completed`

| Mẫu | Số dòng khớp | Kỳ vọng |
|---|---|---|
| `code=` | **0** | 0 |
| `state=` | **0** | 0 |
| `id_token_hint=` | **0** | 0 |
| `login_hint=` | **0** | 0 |
| `idp_session=` | **0** | 0 |
| `set-cookie` | **0** | 0 |
| `authorization` | **0** | 0 |
| password E2E (`DEV_SEED_PASSWORD`, grep -F) | **0** | 0 |
| raw JWT `eyJ` (access/id/refresh token value) | **0** | 0 |
| `access_token` (giá trị) | **0** | 0 |
| `request completed` | **9** (mỗi dòng có `req.id`: 9/9) | > 0, có `req.id` |

Mẫu `res.headers` trong 9 dòng `request completed` (chỉ allow-list `location` đã cắt query/fragment):
```
"headers":{}                                             (GET /ready, /login, /token, /jwks.json …)
"headers":{"location":"/login"}                          (GET /authorize 302 — KHÔNG có ?... )
"headers":{"location":"/authorize"}                      (POST /login 302)
"headers":{"location":"http://localhost:5173/callback"}  (GET /authorize 302 — code/state ĐÃ bị cắt)
```
`req-7 GET /authorize → 302` chỉ log `http://localhost:5173/callback` (query `?code=…&state=…` bị
`serializeResponse` cắt). Không dòng nào có `set-cookie`/token.

---

## Keyset isolation (T3) + git-ignore (T2/T3)

- `be/keys/keys.json` sha256 **TRƯỚC** E2E: `02830f97fabf45acc884ae4c2ff8e996366bbf0d89a1f69c6d1553353d7e4721`
- `be/keys/keys.json` sha256 **SAU** E2E: `02830f97…d7e4721` ⇒ **KHÔNG đổi** ✅
- `git status --porcelain be/keys` sau E2E: **trống** (keyset dev không bị ghi/prune) ✅
- `e2e/.keys/keys.json` tồn tại (E2E dùng keyset riêng, LocalKeyProvider tự tạo) ✅
- `git check-ignore -v e2e/.env` → `e2e/.gitignore:6:.env` ✅
- `git check-ignore -v e2e/.keys/keys.json` → `e2e/.gitignore:8:.keys/` ✅
- `git ls-files`: **0** file `.pem`, **0** `keys.json`, **0** `be/keys/`, **0** `e2e/.keys/` được track ✅
- `e2e/.env` có `DEV_SEED_PASSWORD` non-empty (grep `^DEV_SEED_PASSWORD=.+` ⇒ match) ✅

---

## Coverage acceptance criteria

### Task 1 (DEBT-089) — không log authz `code`/`state` qua `res.headers.location`
- [x] Unit `serializeResponse` absolute cắt query+fragment (`…/cb?code=C&state=S#x` ⇒ `…/cb`) —
  `logger.module.spec.ts` "scrubs query + fragment off an absolute redirect location"
- [x] Unit relative (`/login?returnTo=…` ⇒ `/login`) — "scrubs query off a relative redirect location"
- [x] Unit fail-closed (khuyết / non-string ⇒ bỏ key `location`) — "drops the location key when absent or not a string"
- [x] Unit allow-list (input có `set-cookie`/`x-request-id` ⇒ không ra output) — "never surfaces set-cookie / x-request-id"
- [x] Unit `serializeRequest` giữ path, bỏ `id_token_hint`/`login_hint`/`code_challenge`/`token` — 3 case `request log serializer`
- [x] Unit `req.id` có mặt (correlatable) — "surfaces the genReqId request id"
- [x] Wiring `pinoHttp(buildPinoHttpOptions('test'), memStream)` 302 với `SECRET_*` ⇒ log không chứa
  `SECRET_`, có `https://rp.example/cb` + 302, `req.id`=`REQ-CORRELATE-1`, `res.headers` keys=`['location']`
  — "scrubs secrets yet keeps the request id for the completed 302 log line"
- [x] E2E thật: grep log 302 flow ⇒ `code=`/`state=` = 0 (xem bảng grep, case 6)
- [x] Không hồi quy: `pnpm -C be test` 198/198 xanh

### Task 2 (DEBT-090) — E2E nạp `e2e/.env`, fail-fast nếu thiếu password
- [x] (A) `config/env.ts` `loadEnvFile(e2e/.env)` path tuyệt đối, `existsSync`, không try — xác nhận code
- [x] Thiếu/rỗng `DEV_SEED_PASSWORD` ⇒ `throw` nêu tên biến (không default) — xác nhận code
- [x] `e2e/.env` có password ⇒ E2E pass (login dùng đúng giá trị; flow 1/1 xanh) — case 7
- [x] `git check-ignore e2e/.env` ⇒ `e2e/.gitignore` — xác nhận
- [x] `pnpm -C e2e typecheck` xanh — case 3
- [x] README/`.env.example` nhắc thiếu password ⇒ fail — xác nhận nội dung

### Task 3 (DEBT-091) — keyset E2E riêng, git-ignored
- [x] `KEY_LOCAL_DIR = resolve(e2e, ".keys")` tuyệt đối (không đụng `be/keys`) — xác nhận code
- [x] `.keys/` trong `e2e/.gitignore`; `git check-ignore` trả path — xác nhận
- [x] Sau E2E: `e2e/.keys/keys.json` tồn tại, `be/keys/keys.json` hash KHÔNG đổi, `be/keys` git clean — xác nhận
- [x] E2E vẫn pass (`/ready` + login) — case 7

### Task 4 (DEBT-070/054) — preflight int-test fail-fast
- [x] `test:int` có `--globalSetup ./test/int-preflight.mjs`; `pnpm test` (unit) KHÔNG chạy — case 4
- [x] Container down (probe port đóng) ⇒ fail < 10s (1.67s) với message chứa tên container + `docker start` — case 6
- [x] Container up ⇒ int-test 482/482 xanh — case 5
- [x] `--forceExit` không biến fail thành pass (preflight fail ⇒ exit 1) — case 6
- [ ] DEBT-054 (open handles / gỡ `--forceExit`): **ngoài phạm vi run 23** (giữ mở theo fold T4 + senior 🟡3/DEBT-096)

---

## Coverage security invariants / risk matrix

| Invariant / chiều rủi ro | Kết quả | Bằng chứng |
|---|---|---|
| INV-20: authz `code`/`state` KHÔNG vào bất kỳ sink log | ✅ PASS | grep E2E `code=`/`state=` = 0; unit+wiring serializer |
| `set-cookie` / `idp_session` KHÔNG vào access log | ✅ PASS | grep = 0; allow-list `res.headers` chỉ `location` |
| `authorization` header KHÔNG vào log | ✅ PASS | grep = 0; `REDACT_PATHS` + wiring test |
| `id_token_hint`/`login_hint` KHÔNG vào log | ✅ PASS | grep = 0; `serializeRequest` cắt query |
| token (access/refresh/id) value KHÔNG vào log | ✅ PASS | grep `eyJ`/`access_token` = 0 |
| request-id có mặt mọi dòng HTTP log (correlatable) | ✅ PASS | 9/9 `request completed` có `req.id` |
| Exposure — password dev KHÔNG vào log/report/trace | ✅ PASS | grep -F password = 0 |
| Dependency (Input→State): probe fail-closed, lỗi hạ tầng không bị che | ✅ PASS | preflight ⇒ exit 1 message rõ, không treo |
| Credential (absent): thiếu `DEV_SEED_PASSWORD` fail-closed | ✅ PASS | `throw` trong env.ts (không default đoán được) |
| Secret-at-rest: private key `.pem`/keyset KHÔNG commit, dev≠E2E keyset | ✅ PASS | 0 file key track; hash `be/keys` không đổi; `e2e/.keys` ignored |
| `--forceExit` không che fail (state: fail→pass) | ✅ PASS | test/preflight RED ⇒ exit 1 |

Lưu ý quan sát (không chặn, đã có backlog): `req.id` trong access log là id pino-http (từ header
`x-request-id`), khác Fastify `request.id` dùng ở audit controller — senior đã mở **DEBT-095** (2 nguồn
id + `x-request-id` không validate). Ngoài phạm vi run 23, không ảnh hưởng INV-20 (không giả được bản
ghi audit). Không FAIL.

---

## Test FAIL
Không có.

## DEBT mới (tester)
Không phát sinh. Giữ nguyên DEBT-095/096/097 (senior) + DEBT-054 (gắn fold T4).

## DEBT đã đóng (run 23)
| DEBT | Nội dung | Bằng chứng đóng |
|---|---|---|
| DEBT-089 | Log lộ authorization `code`/`state` qua `res.headers.location` | serializer allow-list; grep E2E `code=`/`state=`=0; unit+wiring |
| DEBT-090 | `.env` E2E không nạp + fallback password im lặng | `loadEnvFile` + `throw` khi thiếu; E2E pass; `git check-ignore` OK |
| DEBT-091 | Keyset dev bị E2E ghi đè | `KEY_LOCAL_DIR=e2e/.keys` tuyệt đối; hash `be/keys` không đổi |
| DEBT-070 | int-test treo ~10' khi container test chưa chạy | globalSetup preflight fail < 10s, message nêu container |

(DEBT-054 giữ mở — ngoài phạm vi T4.)
n