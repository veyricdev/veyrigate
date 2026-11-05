# Test Report — 2026-11-05 (run 65, tester)

## Kết quả: PASS — BE PASS (kèm DEBT-478, sentinel env), FE PASS

Kiểm độc lập trên diff chưa commit (bỏ `.vscode/mcp.json`, `.mcp.json`). Không sửa code sản phẩm. Mọi mutation: backup ngay trước, sau restore so `git diff` toàn repo với bản chụp trước khi bắt đầu (`cmp` = giống hệt) + `sha256sum -c` 15 file của diff; file production (`token.controller.ts`, `bff.ts`) `git diff --quiet` = HEAD.

Lượt chạy bị gián đoạn một lần (máy khởi động lại 2026-11-03→05). Orchestrator đã `git checkout` `fe-admin/src/server/auth/bff.ts` (mutation FE đang dở) và xoá `vg-b73-vault`. Khi tiếp tục: diff toàn repo vẫn = bản chụp ban đầu, `bff.ts` = HEAD, `vg-int-*` = đúng 4 DB cũ (lượt bị gián đoạn không để lại DB). Bằng chứng trước gián đoạn (log ở scratchpad) được giữ; phần mất bằng chứng (mutation viewer FE, regression) chạy lại.

## Lệnh đã chạy + output thực tế

### Case 1 — DEBT-475 (Vault/Sentinel thật, không `--forceExit`)
Hạ tầng: `vg-b73-vault` bằng đúng lệnh START của `be/test/vault-preflight.mjs` (token `openssl rand -hex 16`, không in; đọc lại qua `docker inspect` vào biến, không in); `bash be/scripts/sentinel-test-env.sh up`. Thời gian "summary → thoát" đo bằng timestamp mỗi dòng output.

| Lượt | Kết quả | Time jest | Tổng | Summary → thoát |
|---|---|---|---|---|
| `pnpm -C be test:vault` #1 | 5 suite / 31 passed, rc 0 | 56,6 s | 58,4 s | 0,1 s |
| `pnpm -C be test:vault` #2 | 5 / 31 passed, rc 0 | 47,2 s | 48,8 s | 0,1 s |
| `pnpm -C be test:sentinel` #1 | 2/2 passed, rc 0 | 20,3 s | 22,8 s | 0,7 s |
| `test:sentinel` #2 (không `up` lại) | 1 failed / 2, rc 1 | 25,0 s | 28,6 s | 1,2 s |
| `test:sentinel` #3 (không `up` lại) | 1 failed / 2, rc 1 | 9,0 s | 12,5 s | 1,5 s |
| `test:sentinel` #4, #5 (mỗi lượt `up` mới) | 1 failed / 2, rc 1 | 24,5 s | 28,0 s | 1,0 / 1,1 s |
| `test:sentinel --forceExit` (như HEAD, `up` mới) | 1 failed / 2, rc 1 | 25,2 s | — | — |

- **Tự thoát**: 8/8 lượt (vault + sentinel) thoát ≤ 1,5 s sau tổng kết, không treo.
- **Sentinel đỏ không do run 65**: ca failover `written=false` (`failover: 14 attempts, write after ~15,5 s`). Cùng lỗi khi chạy y như HEAD (`--forceExit`). Spec sentinel không dùng `full-app.ts`/`redis.module.ts` mới (chỉ `buildRedisOptions`). Gốc quan sát từ log container: sau `docker stop` master, replica `vg-b73c-redis-b` lặp `Connecting to MASTER vg-b73c-redis-a` → `Unable to connect to MASTER` mỗi ~3,3 s (phân giải tên của container đã dừng chặn main thread), lâu hơn `down-after-milliseconds 1000` ⇒ Sentinel: `+sdown slave vg-b73c-redis-b` → `-failover-abort-no-good-slave`. Script chỉ ghim `--add-host` cho container sentinel, không cho replica. ⇒ **DEBT-478** (🟡 test-infra). Ca thứ 2 ("no Sentinel reachable") xanh mọi lượt.
- **V7 `--detectOpenHandles`**: `pnpm -C be test:vault vault-transit -t "full app with an exportable key" --detectOpenHandles` ⇒ 1 passed / 13 skipped, rc 0, không có cảnh báo open handle, thoát 0,1 s sau summary; `vg-int-*` +0.
- **Mutation** (bỏ khối `if (!started.ctx) { … }` trong catch `bootFullApp`, `be/test/full-app.ts`): cùng lệnh V7 bọc `timeout 120` ⇒ test 1 passed (Time 17,1 s) rồi **treo**, rc **124**, 100,3 s sau summary. Đồng thời sót 1 DB `vg-int-vault-v7-1793701050556` (do chính lượt này tạo, đã drop đúng tên ⇒ `dropped`). Restore: sha256 `2844c20c…` = trước mutate, `git diff` file = trước mutate.
- Dọn: `sentinel-test-env.sh down` (không còn `vg-b73c-*`); `vg-b73-vault` bị xoá bởi orchestrator sau khi máy khởi động lại (đúng tên).

### Case 2 — DEBT-203 (`TEST_MONGO_URI=mongodb://localhost:27117/vg-int-t65-<ts>?directConnection=true`)
Mỗi spec một `<ts>`; poll `listDatabases` liên tục trong lúc chạy.

| Spec (`test:int "<spec>[.]"`) | Kết quả | DB thấy trong lúc chạy | Sót sau |
|---|---|---|---|
| `admin-target-risk` | 8/8 | `…-t65-<ts>` + `…-t65-<ts>-seed` | 0 |
| `b74-tester` (×2) | 66/66 ×2 | 3 DB riêng: `-tester38-<ts2>`, `-tester58abort-<ts2>`, `-tester58t-<ts2>` (không app nào dùng thẳng DB override) | 0 |
| `indexes` | 19/19 | `…-t65-<ts>` + `…-consent-migration` | 0 |
| `security-headers` (×2) | 114/114 ×2 | `…-t65-<ts>-headers-<ts2>` | 0 |

- Guard: override `…/t65-guard-<ts>` và `…/sso-idp` ⇒ rc 1, `TEST_MONGO_URI must name a throwaway "vg-int-*" DB (got "t65-guard-…" / "sso-idp")`; không DB nào được tạo.
- `withDbSuffix` (node, cùng regex): URI có/không `?query`, nhiều host, `mongodb+srv`, suffix chứa `$&` ⇒ hậu tố đúng chỗ, `$` không bị diễn giải.

### Case 3 — DEBT-453 (mutation rò token thật)
BE: một mutation tạm `be/src/modules/oauth/token/token.controller.ts`, chọn nhánh bằng env `MUT65` (log ở nhánh drop của consume; `hint: <access token ký gần nhất>` trong body 400; access token vào `reason` audit `TOKEN_ISSUED success`; `hint` trong body 503).

| MUT65 | run54-tester | debt388-sign-before-commit | b73-tester T5 (vault) |
|---|---|---|---|
| log | RED 3 (`afterEach` :322 → `expectNoIssued`) | RED 1 (`afterEach` :318) | — |
| body | RED 9 (`expectInvalidGrant` :239 → `expectNoIssued` ×9) | RED 8 (:235 ×8) | — |
| audit | RED (`afterAll` :336 → `expectNoIssued`, "Test suite failed to run") | xanh (spec không có kiểm audit — đúng fold) | — |
| 503 | RED 2 (`toEqual(OUTAGE)` :232 bắt trước) | RED 3 (:228) | — |
| 503 + `toEqual`→`toMatchObject` tạm | RED 2 (`noToken` :349 → `expectNoIssued`) | RED 1 (:471 → `expectNoIssued`) | RED 1 (`expectOutage` :404 → `expectNoIssued`) |

FE: mutation tạm `fe-admin/src/server/auth/bff.ts` (env `MUT65`). Không mutation: bff 76/76.

| MUT65 | Chỗ lộ | Kết quả |
|---|---|---|
| at / sig / rt64 / idb64u | trang lỗi `abort()`: access token rõ / chữ ký id_token / base64 refresh token / base64url id_token | RED 14 / 13 / 14 / 14, tất cả qua `expectRejected` :61 → `expectNoIssued` :51 |
| vat / vid64u / vrt64u | viewer thêm field: access token rõ / base64url id_token / base64url refresh token | RED 1 (`toEqual` :140); với `toEqual`→`toMatchObject` tạm ⇒ RED 1 tại :142 → `expectNoIssued` :51 |

Restore: `token.controller.ts` và `bff.ts` `git diff --quiet` = HEAD, sha256 OK; 3 spec BE + `bff.test.ts` `git diff` = trước mutate; diff toàn repo = bản chụp ban đầu.

### Case 4 — Regression
- `pnpm -C be test:int` (không override): 53 suite, **1420/1420** passed, rc 0 (Time 556,5 s); `vg-int-*` trước/sau = 4 → 4 (+0, đúng 4 DB cũ)
- `pnpm -C be test`: 39 suite, **630/630** passed (Time 50,4 s)
- `pnpm -C fe-admin test`: 66 file, **1533/1533** passed.
- `tsc --noEmit` be 0 lỗi, fe-admin 0 lỗi; `pnpm -C be lint` rc 0, `pnpm -C fe-admin lint` rc 0.

## Test FAIL (nếu có)
- `redis-sentinel.sentinel-spec.ts` "stop the master …" — kỳ vọng ghi được lên master mới ≤ 15 s; thực tế không failover (5/6 lượt). Không do run 65 (cùng lỗi với `--forceExit` như HEAD). Gốc: replica bị chặn khi phân giải tên master đã dừng ⇒ Sentinel coi replica down ⇒ `no-good-slave`. → DEBT-478, không chặn run (không phải invariant bảo mật; phần AC của DEBT-475 là "tự thoát, không che handle" đã chứng minh).

## Coverage acceptance criteria
- [x] T1 (DEBT-475) — vault 31/31 ×2 tự thoát; sentinel tự thoát 6/6 nhưng xanh 1/6 (DEBT-478, có đối chứng HEAD); V7 `--detectOpenHandles` 0 handle; mutation ⇒ treo rc 124 + sót DB; restore khớp.
- [x] T2 (DEBT-203) — Case 2: 4 spec xanh với override, mỗi app full-app một DB, DB phụ riêng, 0 DB sót; guard từ chối tên không `vg-int-*`; int full không override (Case 4).
- [x] T3 (DEBT-453) — Case 3: mỗi sink (log, body 400, audit, body 503, trang lỗi FE, viewer FE) và mỗi dạng (rõ, chữ ký, base64, base64url) ⇒ RED qua `expectNoIssued`; restore = HEAD.

## Coverage security invariants / risk matrix
- [x] Exposure (log/response/audit/503/trang lỗi/viewer) × dạng mã hoá — Case 3.
- [x] Dependency: Vault cắt (T5), compile ném trong boot (V7) ⇒ dọn kết nối, không treo/không sót DB — Case 1.
- [x] Không drop DB ngoài `vg-int-*`: guard với `sso-idp` và tên lạ — Case 2; hậu tố chỉ nối sau tên `vg-int-*`.
- [x] Chống pass rỗng: `issued.length > 0` có mặt (BE 3 spec, FE happy path) — mutation đều RED nên `issued` không rỗng.
- DB: chỉ drop 1 DB do lượt này tạo (`vg-int-vault-v7-1793701050556`); 4 DB `vg-int-vault-v7-*` cũ giữ nguyên.
