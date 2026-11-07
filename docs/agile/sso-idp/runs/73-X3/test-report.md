# Test Report — 2026-11-07 (run 73 X3 + DEBT-008)

## Kết quả: PASS

X3 39/39 (3 trình duyệt) · ma trận JSON khớp spec §9.6: 39/39 ô · probe tay (a)(b)(c) đạt · be unit 675/675 · int 1467/1467 (56 suite, `vg-int-*` 4 → 4) · typecheck/lint be sạch, typecheck e2e sạch · mutation 1 điểm RED (unit 1 + int 2) · E2E mặc định 37/37 sau X3.

## Lệnh đã chạy + output thực tế

Trước mọi lần chạy E2E/probe: `netstat -ano | grep LISTENING` cho :4000/:5173/:3000/:4100/:5273/:5274/:8443 không có dòng nào (không có `pnpm dev` của người dùng). Sau lần cuối cũng trống. `docker ps`: `vg-test-mongo`, `vg-test-redis`, `aegate-mongo`, `aegate-redis`, `veyrigate-mailpit-1` đều Up; không start/compose gì thêm.

1. **Case 1 — `pnpm -C e2e e2e:x3`** (1 lượt): `39 passed (9.0m)`, EXIT=0. Bản sao JSON (chỉ tên cookie, không giá trị): `C:\Users\ADMIN\AppData\Local\Temp\claude\ff7ffefc063065c2\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\x3-matrix.json`. Phiên bản: chromium 156.0.8078.4, firefox 157.0, webkit 27.2, ngày 2026-11-07. Mỗi project có 13 ô, tất cả `passed`.

   **So từng ô với bảng spec §9.6** (JSON outcome | tên cookie gửi tới IdP | storedSameSite):

   | Ca / topology | Chromium | Firefox | WebKit | Spec |
   |---|---|---|---|---|
   | 1 same | claims, Lax | claims, Lax | claims, **None** | ✅ khớp (WebKit lưu None) |
   | 1 cross | claims, Lax | claims, Lax | claims, None | ✅ |
   | 2 same | claims, session gửi | như Chromium | như Chromium | ✅ |
   | 2 cross | claims, session gửi | như Chromium | như Chromium | ✅ (Lax top-level GET) |
   | 3 same/cross | logged-out | logged-out | logged-out | ✅ |
   | 4 same | 403, session gửi | 403, gửi | 403, gửi | ✅ |
   | 4 cross | 403, **không cookie** | 403, **không cookie** | 403, session **gửi** | ✅ |
   | 5 same | bearer 200, session gửi | như Chromium | như Chromium | ✅ |
   | 5 cross | bearer 200, **không cookie** | bearer 200, **không cookie** | bearer 200, **gửi** | ✅ |
   | 6 sibling | rejected/ignored (`__Host-idp_csrf,__Host-idp_session,idp_session`) | như Chromium | như Chromium | ✅ |
   | 7 same | code | code | code | ✅ |
   | 7 cross | login_required | login_required | **code** | ✅ |

   Không ô nào lệch. Ghi chú: ở ca 5 JSON ghi `bearer 200`. Hai lần 200 cho `/userinfo` + `/demo/me` là assert trong test, nên ô `200/200` của spec đúng vì test xanh.

2. **Case 2 — probe tay ngoài suite** (Playwright tạm trong `C:\Users\ADMIN\AppData\Local\Temp\claude\ff7ffefc063065c2\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\probe73\`, config kế thừa `playwright.x3.config.ts`, cùng stack X3; không để lại gì trong repo). Lệnh `pnpm -C e2e exec playwright test -c <scratchpad>/probe73/probe.config.ts` cho `5 passed, 1 failed (1.3m)`:
   - **(a) cookie tên cũ** (đăng nhập ở IdP, lấy sid hợp lệ, cho vào context mới): đặt `__Host-idp_session=<sid>` thì `GET /` ở lại `/` (đã đăng nhập, positive control). Đặt `idp_session=<sid>` (Secure, host IdP) thì `GET /` chuyển về `/login` và form hiện ra, tức là vô danh. Đạt trên Chromium (bắt buộc), Firefox và WebKit.
   - **(b) sibling `app.alpha.localhost` đặt `__Host-idp_session` có `Domain=alpha.localhost`**, cả qua `document.cookie` lẫn header `Set-Cookie` HTTP (route fulfill): số cookie `__Host-` được lưu là **0** trên cả 3 trình duyệt. Cookie đối chứng `probe_ctrl; Domain=alpha.localhost` thì được lưu (domain `.alpha.localhost`), nghĩa là cơ chế tossing thật sự chạy và việc từ chối là do prefix `__Host-`.
   - **(c) Set-Cookie của BE** (chỉ ghi tên và thuộc tính): `GET /login -> __Host-idp_csrf; Path=/; HttpOnly; Secure; SameSite=Lax` và `POST /login -> __Host-idp_session; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`. **Không có `Domain`**, không phát ra tên cũ `idp_session`/`idp_csrf`. Đạt trên Chromium và Firefox. Ca fail duy nhất là WebKit ở (c): `-> __Host-idp_session` không xuất hiện trong `headersArray()` của response 302 `POST /login`. Đây là giới hạn của harness: Playwright WebKit không trả `Set-Cookie` của response redirect. Bằng chứng: trong cùng test, cookie vẫn được lưu và positive control vẫn đăng nhập được. Set-Cookie WebKit thấy được (`__Host-idp_csrf`) cũng không có `Domain`. Đây không phải lỗi sản phẩm, vì BE gửi cùng một header cho mọi trình duyệt và Chromium/Firefox đã kiểm được.
3. **Case 3 — BE**:
   - `pnpm -C be test` cho `Test Suites: 40 passed`, `Tests: 675 passed, 675 total`.
   - `pnpm -C be test:int` cho `Test Suites: 56 passed`, `Tests: 1467 passed, 1467 total`. Số DB `vg-int-*` trên `vg-test-mongo` là 4 trước và 4 sau (+0).
   - `pnpm -C be typecheck` và `pnpm -C be lint` EXIT 0. `pnpm -C e2e typecheck` EXIT 0.
   - **Mutation**: đổi `SessionCookie.read` thành `req.cookies?.[this.name] || req.cookies?.[SESSION_COOKIE] || undefined` (đọc fallback tên cũ). Kết quả RED: unit `session.cookie` `1 failed, 6 passed`, int `run73-host-cookie[.]` `2 failed, 3 passed`. Backup ngay trước khi mutate được lưu vào scratchpad `mut73/`. Sau restore, md5 file `d357d2ce…` bằng trước, md5 `git diff` `179127253dae…` bằng trước, unit `7 passed`.
4. **Case 4 — regression `pnpm -C e2e e2e`** (chạy SAU X3 và probe, không song song): `37 passed (4.2m)`, EXIT=0.
5. **Case 5 — DEBT-510**: sau case 4, `e2e/test-results/` rỗng, nên nguồn mà spec §9.6 dẫn đã biến mất (xác nhận DEBT-510). Đề xuất cho orchestrator quyết:
   - **Phương án A (khuyên dùng)**: lưu bản JSON (chỉ tên cookie/outcome, không secret) vào `runs/73-X3/x3-matrix.json`. Bản của lượt tester này nằm sẵn ở scratchpad `x3-matrix.json`, ngày 2026-11-07, 3×13 ô `passed`. Đổi câu nguồn trong spec §9.6 thành: "Nguồn: `runs/73-X3/x3-matrix.json` (bản lưu 2026-11-07); tạo lại bằng `pnpm -C e2e e2e:x3`, file ra tạm ở `e2e/test-results/x3-matrix.json`, bị xoá ở lần chạy Playwright kế tiếp".
   - **Phương án B (tối thiểu)**: chỉ sửa câu nguồn thành "tạo bởi `pnpm -C e2e e2e:x3` (2026-11-07; 3 lượt độc lập dev×2 + tester×1 cho kết quả trùng nhau)".
   - Tester không sửa spec/runs ngoài report này.

## Test FAIL (nếu có)

- Không có test sản phẩm nào FAIL. Ca probe tạm `[webkit] a+c` fail do giới hạn harness, đã giải thích ở case 2(c). Không phải lỗi code và không mở debt.

## Coverage acceptance criteria

- [x] F1 Task 1 (DEBT-008): khi Secure dùng `__Host-idp_session`/`__Host-idp_csrf`, có `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, không `Domain` (case 2c + unit + int). Cắt cứng: tên cũ thành vô danh (case 2a, X3 ca 6, int `run73-host-cookie`). Mutation fallback cho RED (case 3).
- [x] F2 Task 2: suite X3 xanh trên 3 project, 7 ca × 2 topology, ca 7 chỉ ghi annotation (case 1). E2E mặc định vẫn 37 (case 4). Typecheck e2e sạch.
- [x] F3 Task 3: bảng spec §9.6 khớp số đo độc lập của tester ở mọi ô (case 1). Quyết định `SameSite=Lax` được số đo ủng hộ: ca 2 cross-site SSO chạy, ca 4/5 cross-site không mang cookie trên Chromium/Firefox.

## Coverage security invariants / risk matrix

- [x] Identity/Credential: cookie session hợp lệ dưới tên cũ (legacy, coi như replayed) thành vô danh (2a). Replay cookie sau logout thành ẩn danh (X3 ca 3).
- [x] Authorization/actor khác: subdomain anh em tossing `__Host-` có `Domain` bị từ chối qua cả JS và HTTP (2b, X3 ca 6). `idp_session` của user khác bị tossed vào thì bị bỏ qua (X3 ca 6).
- [x] Request chain: login (Set-Cookie) rồi request kế tiếp với cookie jar (2a positive/negative). Logout (clear) rồi `/authorize` (X3 ca 3).
- [x] Cross-site CSRF: POST `/logout` không `_csrf` cho 403, session sống. Cross-site không mang cookie trên Chromium/Firefox (X3 ca 4, 5). WebKit-Win không áp SameSite (DEBT-506, đã biết).
- [x] Exposure: JSON/annotation/log probe chỉ chứa tên cookie. Report không in giá trị cookie/token/secret.
- [x] Dependency/State: không đổi semantics Redis/Mongo. Int full xanh.
- Debt mới: không có. DEBT-509/510/511 (senior) vẫn mở. DEBT-510 có đề xuất ở case 5.
