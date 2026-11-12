# Test Report — 2026-11-12 (run 86 T6, tester)

## Kết quả: PASS (mọi gate xanh; xem bảng)

Code: `develop` `e39b7b5` + working tree run 86 (T1–T5, DEBT-605/606/607 + 2 nit). Hạ tầng: lượt đầu trên `vg-test-*`/`aegate-*` (2026-11-11); người dùng xoá Docker giữa chừng, các gate chạy lại trên `veyrigate-mongo` (27017 + 27117, rs0) / `veyrigate-redis` (6379 + 6479) / `veyrigate-mailpit-1` (2026-11-12). Không `compose up`, không FLUSH, không đụng DB `sso-idp`.

| Gate | Lệnh | Kết quả | Ngưỡng |
|---|---|---|---|
| be lint + typecheck | `pnpm -C be lint`, `pnpm -C be typecheck` | sạch (2 lượt: cũ + mới) | — |
| be unit | `pnpm -C be test` | **47 suites, 979/979** (2 lượt) | ≥ 931 |
| be int FULL | `pnpm -C be test:int` | **76 suites, 2246/2246**, 892 s (hạ tầng mới); lượt cũ 2246/2246, 950 s | ≥ 2143 |
| `vg-int-*` DB | `listDatabases` trước/sau | **0 → 0** (cả hai lượt) | không tăng |
| vault spec | orchestrator, container Vault tạm (người dùng cho phép) | **5 suites, 32/32** (ghi lại, tester không chạy lại) | ≥ 31 |
| fe-admin | `pnpm -C fe-admin typecheck/lint/test` | sạch; **68 files, 1626/1626** | ≥ 1613 |
| e2e typecheck | `pnpm -C e2e typecheck` | sạch | — |
| E2E | `pnpm -C e2e e2e` | **42/42** (8.8 m, DB `sso-idp-e2e` mới) | ≥ 40 |
| X3 | `pnpm -C e2e e2e:x3` | **42/42** (10.0 m; chromium/firefox/webkit) | 42 |

## Lệnh đã chạy + output thực tế

- `pnpm -C be test` ⇒ `Test Suites: 47 passed, 47 total` / `Tests: 979 passed, 979 total` (976 dev + 2 retry dev + 1 tester Vault unit).
- `pnpm -C be test:int run86-tester` (riêng) ⇒ `Tests: 85 passed, 85 total`, 26 s. Mutation (khôi phục, `sha256sum -c` OK): bỏ `^`/`$` của regex trong `token-fragment.js` ⇒ F1 `5 failed` (mutation (g) của T1).
- `pnpm -C be test:int` (hạ tầng mới) ⇒ `Test Suites: 76 passed, 76 total` / `Tests: 2246 passed, 2246 total` / `Time: 891.973 s` / exit 0. `listDatabases` trước và sau: `[ 'admin', 'config', 'local' ]`.
- `pnpm -C fe-admin test` ⇒ `Test Files 68 passed (68)` / `Tests 1626 passed (1626)`.
- `pnpm -C e2e e2e`:
  - lượt 1 (hạ tầng cũ) ⇒ `1 failed, 41 passed`: `fe-admin-keys.spec.ts:106` tìm hàng của tab cũ khi hộp `alertdialog` (modal) còn mở; snapshot lỗi chỉ có dialog, bảng bị ẩn khỏi accessibility tree ⇒ lỗi thứ tự trong spec, không phải sản phẩm. Tester dời assert ra sau "Cancel" (vẫn chứng minh re-read sau 409: tab mở trước rotate, không reload). Chạy riêng ⇒ `1 passed`.
  - lượt 2 ⇒ `1 failed, 41 passed`: `fe-admin-users.spec.ts:88` `an active family within 20 pages`. User E2E có 493 family (20/trang ⇒ 25 trang) do DB E2E giữ dữ liệu giữa các lần chạy. Spec này không đổi ở run 86. Tester nâng giới hạn lên 100 trang (chỉ sửa test) ⇒ DEBT-608.
  - lượt 3 bị ngắt (phiên kết thúc khi Docker bị xoá, exit 4, không có kết quả).
  - lượt trên hạ tầng mới ⇒ `42 passed (8.8m)`, exit 0. Trong đó có `token-fragment.spec.ts` (3 ca), `fe-admin-keys.spec.ts`, `fe-admin-users.spec.ts`, `password-change.spec.ts`.
- `pnpm -C e2e e2e:x3` ⇒ `42 passed (10.0m)`, exit 0; ô 4 `4 POST from RP to IdP without _csrf — <topology>` xanh ở chromium/firefox/webkit.

## Test FAIL

Không còn test đỏ. Hai test E2E đỏ ở trên là lỗi của chính test (thứ tự assert dưới modal; giới hạn trang phụ thuộc lượng dữ liệu tích luỹ), tester đã sửa trong test, không đụng code sản phẩm.

## Spec tester mới

`be/test/run86-tester.int-spec.ts` (85 ca, app thật):
- **F1**: chạy đúng bytes của `/assets/token-fragment.js` trong `node:vm` với DOM giả.
  - `#token=<43>` ⇒ `.value` đúng, label `hidden`, `replaceState(null,'','/reset')` (bỏ cả query).
  - 11 fragment xấu ⇒ không điền, vẫn bỏ fragment: `&x=1`, 42/44 ký tự, `%41…`, `\n`, `%0A`, `+/`, payload HTML, ZWSP, rỗng, token lặp.
  - 4 fragment không liên quan ⇒ không đụng history: không có, `#section`, `#TOKEN=`, `#x=1&token=`.
  - Thiếu field ⇒ không ném lỗi.
- **F2**: 6 trang không có script inline, không `on*=`, `script-src` không có `unsafe-inline`, `Referrer-Policy: no-referrer`. Token không phản chiếu từ query (kể cả `%23`, lặp, `token[]`) hay Referer, ở body lẫn header. POST `/reset` và `/verify-email` sai không echo token.
- **F3**: ZWSP, ZWNJ, word-joiner, homoglyph Cyrillic, khoảng trắng giữa, đổi hoa/thường ⇒ 4xx và **token không bị tiêu**; mã sạch sau đó dùng được đúng một lần. NBSP, U+3000, BOM, tab+CRLF bị `trim` ⇒ nhận.
- **L1**: `_csrf` lặp dạng urlencoded ⇒ 400. JSON `_csrf` số/null/object/boolean ⇒ 400. JSON không có `_csrf` ⇒ 200 xác nhận. Mảng JSON, chuỗi JSON, `text/plain` ⇒ không 5xx, không logout. HMAC của phiên khác ⇒ 403. Ở mọi ca, phiên vẫn sống (đã kiểm qua `SessionService.get`).
- **L2**: `id_token_hint` thật. URI đã đăng ký được phản chiếu và là đích 302. 8 biến thể suýt-khớp (dấu `/`, query, `#`, hậu tố host, userinfo, http, `javascript:`, `%2D`) ⇒ không phản chiếu, CSP chỉ `self`; POST có `_csrf` ⇒ `/login?loggedOut=1` và phiên kết thúc.
- **Secure app**: trang xác nhận đặt `__Host-idp_csrf` (Secure, `Path=/`, HttpOnly, không Domain).
  - Cookie tossing: `idp_csrf=X` hoặc `idp_session=S` không có tiền tố `__Host-` + HMAC tương ứng ⇒ 403.
  - Đối chứng: `__Host-idp_csrf` ⇒ 302.
- **K1**: `KEY_PREPUBLISH_SEC=86400` đi qua factory thật. Sau rotate thường, 200 chữ ký từ provider và 5 cặp AT/ID token từ `/token` thật đều mang kid cũ; JWKS có cả hai kid. Chuỗi rotate → 409 → emergency (JWKS 1 kid) → normal (pending) → 409.
- **Secure app** `KEY_PREPUBLISH_SEC=""` ⇒ 3600.
- **K2**: `86401`, `' 5'`, `1e3`, `-1` ⇒ app thật không boot. Ở mức `validateEnv`, `0`/`86400`/`''`/`00`/`0086400` được nhận; 11 giá trị bị từ chối, gồm `5 `, `+5`, `-0`, `0x10`, `5.0`, chữ số Ả Rập, chữ số full-width và `86400\n`.
- **K3/K4**: 100 chữ ký song song ở `activatesAt − 1 ms` dùng kid cũ, ở `activatesAt` dùng kid mới. `[normal, normal, emergency, normal]` ⇒ `[ok, 409, ok, ok]`, PEM đúng hai kid. `[emergency, normal, emergency]` ⇒ 1 kid, 1 PEM. `keys.json` cũ có `status` trái thứ tự ⇒ suy theo thứ tự, đọc không ghi file, rotate kế tiếp không ghi `status`, giữ PEM của key đang ký và xoá PEM của key retiring. Một phần tử cũ ghi `retiring` với `retireAt` đã qua ⇒ vẫn active, `init` không tạo key.

`be/src/modules/keys/vault-transit-key-provider.spec.ts`, ca "tester run 86: two pending versions …": race D86.10, hai version pending.
- Version active là bản mới nhất đã tới `activatesAt`, các version sau vẫn pending; JWKS đủ 3 kid; rotate thường ⇒ 409 ở cả hai mốc.
- `retireAt` của từng version cũ = `activatesAt` của version kế + TTL + cache (INV-K3).

## Coverage acceptance criteria

- [x] T1 AC1–AC8: `run86-token-fragment.int-spec.ts` (dev), E2E `token-fragment.spec.ts` (3/3), `password-change.spec.ts`; tester F1–F3; mutation (g) đỏ.
- [x] T2 AC1–AC11: `keys.spec.ts`, `run86-key-prepublish.int-spec.ts`, vault-spec V15 (orchestrator 32/32), `validation.schema.spec.ts`; tester K1–K4 + Vault hai pending.
- [x] T3 AC1–AC9: fe-admin 1626; E2E `fe-admin-keys.spec.ts` xanh (cửa sổ pre-publish 20 s, `e2e/.keys` giữ giữa các lần chạy).
- [x] T4 AC1–AC8: `ui.int-spec.ts` (dev); tester L1/L2/secure; X3 ô 4.
- [x] T5 AC1–AC4: `csp.spec.ts`, `security-headers.int-spec.ts`, `login-throttle.service.spec.ts`.
- [x] DEBT-605 (không `pattern`/`maxlength`: int AC3 run86-token-fragment), DEBT-606 (fe-admin fake timers), DEBT-607 (unit Vault) đều xanh.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | ẩn danh, phiên hợp lệ, phiên khác | L1 "HMAC of ANOTHER live session", secure app |
| Credential | `_csrf` thiếu/rỗng/sai/mảng/sai kiểu; token mã sai, dạng unicode, phát lại | L1, F3, dev AC4/AC5 |
| Authorization | hint của client, URI suýt-khớp | L2 |
| Input | fragment xấu, query/Referer có token, body JSON/text, biên env | F1, F2, L1, K2 |
| State | token chưa tiêu sau mã sai; pending → active → retiring; legacy `keys.json` | F3, K1, K3, K4 |
| Concurrency | rotate xen kẽ normal/emergency; 100 chữ ký song song ở biên | K3 |
| Request chain | xác nhận cross-site ⇒ cookie ẩn danh ⇒ POST cùng site (dev AC5); cookie tossing ở chế độ secure | secure app |
| Exposure | token không có trong body/header/URL/history; JWKS không có thành phần private | F1, F2, E2E keys |

INV-K1–K4 có test (xem `security-matrix.md` mục "Run 86"). Không có bằng chứng thiếu nào cho một invariant có thể dẫn tới bypass, replay hay lộ secret.

## Checklist / security-matrix

- `release-checklist.md`: C-14.2.1, B-L2d, C-3.4c ❌ ⇒ ✅; B-10.1.1 ⚠ ⇒ ✅. Bảng tổng đếm lại bằng script: 201 dòng, 146/29/7/19. **P0 ❌ = 0.** Script kiểm bằng chứng: 280/280 tên test khớp đúng 1 dòng.
- `security-matrix.md`: SE4, CK3 đổi sang tên test mới (tên cũ đã bị đổi ở run 86); thêm mục "Run 86".
  - 45 bằng chứng cũ dạng không grep được ⇒ DEBT-609. Không mục nào trong số đó thuộc run 86.
- Script kiểm: `scratchpad/t86/check-evidence.mjs` (`node check-evidence.mjs <repo> <md…>`: mỗi `` `đường-dẫn › tên` `` phải có trên đúng 1 dòng).

## Debt mới

- DEBT-608 (🟡 E2E): dữ liệu E2E tích luỹ làm `fe-admin-users` phải lật quá 20 trang.
- DEBT-609 (💭 Docs): 45 bằng chứng cũ trong `security-matrix.md`.

