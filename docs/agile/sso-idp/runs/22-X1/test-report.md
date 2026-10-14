# Test Report — 2026-10-14 (run 22-X1, tester)

## Kết quả: **PASS**

- BE unit **191/191** (18 suite) · BE int **482/482** (23 suite) · FE (fe-sso-test) **83/83** · E2E `pnpm -C e2e e2e` **1 passed (37.3s)** + E2E nhánh consent **1 passed (28.7s)** trên DB tạm mới.
- Tester bổ sung **+4 int-test** (478→482) và siết **2 test có sẵn** để đóng **DEBT-086/087/088**.
- Mọi thao tác read-only trên DB dùng chung; **KHÔNG FLUSH/drop, KHÔNG dừng/xoá container, KHÔNG `compose up`**. Không sửa `be/src` (mutation đã khôi phục byte-identical). Không sửa config sản phẩm E2E.

---

## Lệnh đã chạy + output thực tế

### Preflight
- `codegraph --version` → `1.6.2`; `codegraph status` → Files 206, Nodes 3301; `codegraph sync` → `Already up to date`.

### BE
```
pnpm -C be typecheck   → tsc --noEmit, exit 0 (sạch)
pnpm -C be lint        → eslint src test, exit 0 (sạch)
pnpm -C be test        → Test Suites: 18 passed, 18 total | Tests: 191 passed, 191 total
pnpm -C be test:int    → Test Suites: 23 passed, 23 total | Tests: 482 passed, 482 total (93.2s)
```
Hạ tầng int: `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` — cả hai `Up`.

### FE (fe-sso-test)
```
pnpm -C fe-sso-test typecheck → tsc -b --noEmit, exit 0
pnpm -C fe-sso-test lint      → eslint ., exit 0
pnpm -C fe-sso-test test      → Test Files 12 passed (12) | Tests 83 passed (83)
pnpm -C fe-sso-test build     → ✓ built in 520ms (vite)
```

### E2E — bắt buộc (shared `aegate-mongo`/`aegate-redis`/`veyrigate-mailpit-1`, KHÔNG flush)
```
pnpm -C e2e e2e  → 1 passed (37.3s)
```
- DB `sso-idp-e2e` (Mongo) + Redis `/2`. Console KHÔNG có "violates form-action". Nhánh đi: **KHÔNG consent** (DB đã có 1 consent của dev user + `fe-sso-test` từ lần chạy trước → spec bỏ qua màn consent, đúng thiết kế `if (consentForm.isVisible())`).
- Leak-scan stdout: `dev-password` **0**, `access_token` **0**, `idp_session=` **0** → không lộ secret/token/cookie trong log.

### E2E — nhánh consent trên DB TẠM MỚI (không flush/drop)
- Trước khi chạy: probe read-only → `sso-idp-e2e` có `consents.count=1` (dev user đã consent) ⇒ không thể ép nhánh consent trên DB này mà không drop; `REDIS /3,/4,/5 DBSIZE=0` (trống).
- Cách chạy KHÔNG sửa config sản phẩm: `e2e/config/env.ts` hardcode `E2E_MONGO_URI`/`E2E_REDIS_URL` (không có fallback `process.env`) ⇒ **không override được bằng env**. Dùng **config Playwright tạm, chỉ của tester** (`e2e/tmp-consent.config.ts`, đã xoá sau khi chạy) spread `beEnv()`/`feEnv()` của sản phẩm và chỉ đổi `MONGO_URI`→DB mới + `REDIS_URL`→`/3` (đã kiểm DBSIZE=0). Không FLUSH/drop ở đâu (DB tên mới vốn rỗng).
```
CONSENT_E2E_MONGO_URI=mongodb://localhost:27017/sso-idp-e2e-consent-20261014125425?directConnection=true
CONSENT_E2E_REDIS_URL=redis://localhost:6379/3
playwright test --config=tmp-consent.config.ts  → 1 passed (28.7s)
```
- **Bằng chứng nhánh consent thực sự chạy**: probe DB tạm sau run → `consents.count=1`, `CONSENTS: [{clientId:"fe-sso-test", userId:"6acf1926…"}]`. `seed-dev.ts` **không** seed consent (grep 0 hit) ⇒ consent này chỉ có thể do màn `/authorize/consent` → "Allow" trong E2E ghi ra ⇒ nhánh consent (hiển thị + approve + 302 `/callback`) đã thực thi. Redis `/3` DBSIZE 0→6.
- **DB tạm để lại, KHÔNG drop**: `sso-idp-e2e-consent-20261014125425` (Mongo `aegate-mongo`), keys ở Redis `/3`.

---

## Test FAIL (nếu có)
- Không có. 0 FAIL.

---

## Test bổ sung của tester + kiểm chứng RED (mutation)

Mỗi test được chứng minh **bắt được bug** bằng cách tạm mutate `be/src` rồi khôi phục byte-identical (không commit).

| DEBT | Test mới/siết | File | Mutation để kiểm RED | Kết quả |
|---|---|---|---|---|
| **DEBT-086** | `peek does NOT reset a shrunken TTL back to the context TTL` — `pexpire(key,5000)` trước peek, assert `pttl<=5000` | `be/test/authorize.int-spec.ts` | `peek` = `getex(key,'PX',600000)` | **RED** `Received: 599999` vs `<= 5000` (test cũ INV-084-3 vẫn GREEN — chính là lỗ hổng senior nêu). Khôi phục → GREEN |
| **DEBT-087** | siết test Redis-fail: spy mọi sink `Logger.prototype`, assert không chứa `request_id`/`returnTo`/`/authorize`; warn phải được gọi | `be/test/ui.int-spec.ts` | warn log `...request_id=${requestId}...` | **RED** `Received: "...request_id=secret-id..."`. Khôi phục → GREEN |
| **DEBT-088** | `buildCsp()` == header helmet live (đo từ `GET /register`); `GET /` (302) + trang lỗi 403 + frontchannel giữ `form-action 'self'` | `be/test/ui.int-spec.ts` | `object-src 'none'`→`'self'` trong `buildCsp` BASE_DIRECTIVES | **RED** map directive lệch (`object-src 'self'` vs live `'none'`). Khôi phục → GREEN |

Verbose xác nhận GREEN cuối cùng:
```
authorize.int-spec: √ peek does NOT reset a shrunken TTL back to the context TTL (DEBT-086)
ui.int-spec:        √ GET /login fails closed ... without logging request_id
                    √ buildCsp() with no args is byte-identical to the global helmet header (DEBT-088)
                    √ GET / keeps form-action self on its response (DEBT-088)
                    √ HTML error page keeps form-action self (DEBT-088)
                    √ renders the front-channel page ... (nay assert form-action 'self')
```

---

## Coverage acceptance criteria

### T6 / DEBT-084 (fold tech-lead — 10 acceptance đo được)
- [x] AC1 CSP theo route (`form-action == 'self' <origin>`, directive khác == `/register`, không path/query) — `ui.int-spec.ts` "GET /login with a valid request_id resume…"
- [x] AC2 negative returnTo (no returnTo, `/`, request_id thừa `redirect_uri`, `/authorize/consent`, raw `redirect_uri`) ⇒ `'self'` — `ui.int-spec.ts` it.each 5 case
- [x] AC3 `peek` không consume & không gia hạn TTL; resume 1 lần OK, lần 2 expired — `authorize.int-spec.ts` "peek does NOT consume…" **+ DEBT-086 (reset-TTL)**
- [x] AC4 Redis lỗi khi peek ⇒ 200, `'self'`, **log không chứa request_id** — `ui.int-spec.ts` (siết, **DEBT-087**)
- [x] AC5 consent ⇒ `form-action 'self' <origin>`; approve/deny 302 như cũ — `ui.int-spec.ts` + `authorize.int-spec.ts` consent xanh
- [x] AC6 `/logout` hint hợp lệ+URI đăng ký ⇒ thêm origin; sai ⇒ `'self'` — `ui.int-spec.ts` 2 test logout
- [x] AC7 redirect URI legacy header-splitting (`;`/space/scheme lạ) ⇒ không thêm origin, không tách directive — `ui.int-spec.ts` it.each 3 case
- [x] AC8 hồi quy `/register`,`/forgot`,`/reset`,`/verify-email`,**`/`**,**trang lỗi**,**frontchannel** giữ CSP; **`buildCsp()`==global** — `ui.int-spec.ts` (bổ sung **DEBT-088**)
- [x] AC9 E2E X1 xanh, không "violates form-action" — `pnpm -C e2e e2e` 1 passed, grep "violates" = 0
- [x] AC10 typecheck+lint+unit+int xanh, không giảm test — 191 unit + 482 int (tăng từ 478)

### T1–T5 (đã PASS senior; tester xác nhận lại qua suite)
- [x] T1 `db:seed-dev` user dev verify sẵn, idempotent, không log mật khẩu — `seed-dev.int-spec.ts` xanh (trong 482)
- [x] T2 trang claims + DEBT-078/079/080 (fe-sso-test) — FE 83/83
- [x] T3 package `e2e/` + Playwright webServer chain — E2E khởi động BE:4000/FE:5173, `/ready` gate OK
- [x] T4 kịch bản login→/authorize→/token→claims, token không lộ — E2E 1 passed; DOM/URL/storage sạch; `claim-sub==sub` (24-hex)
- [x] T5 CI job `e2e` (DEBT-004) — ngoài phạm vi chạy local; YAML đã được senior/FE xác nhận (không chạy CI ở đây)

## Coverage security invariants / risk matrix (DEBT-084)
- [x] INV-084-1 origin chỉ từ URI đã exact-match (`peek()`/consent outcome/`resolvePostLogoutRedirect`), không bao giờ input thô — AC1/AC6/AC7
- [x] INV-084-2 mọi directive khác == global (đo byte-identical với helmet live) — **DEBT-088** (AC8)
- [x] INV-084-3 `peek` = GET thuần, không DEL/không reset TTL — AC3 **+ DEBT-086** (bắt reset-TTL)
- [x] Risk — Input: `returnTo`/`redirect_uri` encoded/injection payload (`;`, space, scheme lạ) ⇒ fail-closed `'self'`, header không tách — AC2/AC7
- [x] Risk — Dependency: Redis timeout/unavailable khi peek ⇒ fail-closed 200+`'self'`, không retry, log không rò request_id — AC4 (**DEBT-087**)
- [x] Risk — State: resume single-use (consume 1 lần, lần 2 expired) không bị peek phá; TTL không trượt — AC3+DEBT-086
- [x] Risk — Authorization/cross-ctx: link `/login?returnTo=…request_id=<ctx attacker>` chỉ thêm origin URI đã đăng ký — AC1 + abuse analysis (senior)
- [x] Exposure: `/login`,consent,`/logout` `Cache-Control: no-store`; header chỉ origin (không path/query) — AC1/AC6; E2E stdout không lộ password/token/cookie

## DEBT đã đóng (tester, chỉ cần test)
- **DEBT-086** ✅ — test bắt reset-TTL của `peek` (verified RED).
- **DEBT-087** ✅ — test Redis-fail assert log không chứa `request_id`/`returnTo` (verified RED).
- **DEBT-088** ✅ — `buildCsp()`==helmet live + `/`/trang lỗi/frontchannel giữ `form-action 'self'` (verified RED).

## Còn mở (ngoài phạm vi test-only / cần sửa code|config sản phẩm → KHÔNG đóng)
- DEBT-089 (access log pino lộ `code`/`state`/`request_id` trong `location` — cần sửa logger sản phẩm).
- DEBT-090 (`e2e/.env` không nạp — cần sửa config E2E sản phẩm).
- DEBT-091 (keyset E2E dùng chung dev — cần sửa config E2E sản phẩm).
- DEBT-092 (ponytail −28 dòng).
- DEBT-081/082/083/085 (hoãn theo mốc tương ứng).

## Ghi chú
- DB tạm để lại (không drop): `sso-idp-e2e-consent-20261014125425`; Redis `/3` còn keys từ run consent. DB dùng chung `sso-idp-e2e` thêm 2 key ở Redis `/2` (20→22) — namespace riêng, không flush.
- Artefact tạm của tester (`e2e/tmp-consent.config.ts`, `e2e/tmp-probe.cjs`) đã xoá sau khi chạy.
