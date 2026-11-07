# Senior Review — 2026-11-07

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Run gọn, bám sát fold tech-lead. BE: tên cookie suy ra từ đúng một cờ `SESSION_COOKIE_SECURE` qua một hàm thuần `hostCookieName`, không có env mới, `Domain` không bao giờ được đặt. Cắt cứng được áp ở mọi chỗ đọc cookie IdP: `SessionCookie.read` (dùng chung cho UI, authorize, federation, logout), `CsrfGuard`, `formCsrfIdentity`, rate-limit `deviceId`, xoá cookie session hết hạn (`ui.controller.ts:468`). Grep `be/src` không còn chỗ nào đọc `idp_session`/`idp_csrf` thô. Test âm có thật (legacy bị bỏ qua kể cả khi cùng có tên `__Host-`; CSRF token đúng nhưng nằm dưới tên cũ ⇒ 403; logout qua tên cũ ⇒ 403, session còn sống), và log ghi mutation test 4 kiểu đều RED.

X3 dùng Node built-ins, proxy chỉ bind `127.0.0.1`, cert sinh vào `.x3-tls/` (đã kiểm `git check-ignore`), `trace`/video/screenshot tắt, JSON chỉ chứa tên cookie. Ca 5 có positive control same-site cho công cụ đo `/__x3_echo`, nên kết quả "không gửi" cross-site không phải xanh giả. WebKit-Windows chỉ được ghi nhận, không assert, và điều này được nói thẳng trong docs.

Verify lại trong lượt review: unit `session.cookie.spec` + `csrf.service.spec` + `seed-e2e-admin.spec` 39/39; int `run73-host-cookie` + `seed-e2e-admin` + `tenant-context` 28/28 (`docker start vg-test-mongo vg-test-redis`); `pnpm -C e2e typecheck` sạch. Không chạy lại X3/E2E: không có gì đáng ngờ.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Identity (session)**: khi Secure chỉ đọc `__Host-idp_session`. `idp_session=<sid hợp lệ>` ⇒ ẩn danh, không 5xx, session Redis không bị xoá (int + E2E ca 6). Khi non-Secure chỉ đọc `idp_session` (unit). Không có đường fallback nào (grep `be/src`).
- **Login-CSRF / tossing**: `__Host-idp_csrf` được mint host-only, `Path=/`, Secure. `idp_csrf` cũ bị bỏ qua và một identity mới được mint. Guard từ chối token hợp lệ khi nó nằm dưới tên cũ và cả khi nằm dưới `idp_session` (unit + int). Trên trình duyệt thật, `__Host-…; Domain=` bị cả 3 engine từ chối (E2E ca 6).
- **Logout / replay**: logout qua tên cũ ⇒ 403, session còn sống. Logout qua `__Host-` ⇒ revoke + clear đúng tên và thuộc tính. Replay cookie cũ ⇒ ẩn danh (int + E2E ca 3).
- **Federation**: `idp_fed`/`idp_link` (`Path=/auth/`) nằm ngoài phạm vi theo fold, đã ghi DEBT-505. Federation đọc session qua `SessionCookie.read` nên tự hưởng cắt cứng.
- **Failure behavior**: không đổi (Redis/Mongo vẫn đi đường cũ). Tên cookie là hằng số lúc khởi tạo.
- **An toàn dữ liệu seed**: `x3BeEnv()` = `{...beEnv(), PORT, ISSUER, SESSION_COOKIE_SECURE, E2E_X3}`, nên `MONGO_URI` vẫn là `E2E_MONGO_URI` (`sso-idp-e2e`) và `REDIS_URL` là `/2`; mọi bước của chuỗi webServer (`db:sync-indexes`, `seed:e2e-admin` qua `execSync` kế thừa env, `db:seed-dev`) đều chạy trên DB E2E. Env tiến trình thắng `--env-file-if-exists=.env`, nên `be/.env` không lấn được. `seedE2eAdmin` vẫn có guard `NODE_ENV=test` + tên DB trước mọi lần ghi. `x3-*` chỉ được ghi khi `E2E_X3 === '1'` (int: tắt ⇒ 0 client). Đây là client public, không có credential, redirect https được validate. Không có client nào mở ở prod: chỉ nằm trong `be/test/e2e`, và `assert-dist-clean` vẫn nằm trong chuỗi.
- **Exposure**: `/__x3_echo` chỉ có trong `e2e/x3/tls-proxy.mjs` (không có trong BE), chỉ trả tên cookie, và CORS chỉ cho 2 origin X3. Giá trị sid của nạn nhân (ca 6) chỉ dùng trong tiến trình test, không ghi ra JSON hay annotation.
- **Boundary**: proxy trả 421 cho `Host` lạ, chỉ nghe loopback. Cert tự ký hạn 2 ngày, không cài vào kho tin cậy nào.

## 🟡 Nên sửa

- [ ] `e2e/x3/cookie-matrix.spec.ts:39-48` — ma trận mất dữ liệu đúng lúc cần nó nhất.
  Vì sao: `cells` là biến cấp module và `afterAll` ghi đè `all[project] = {…, cells}`. Khi một test fail, Playwright khởi động lại worker. Worker mới bắt đầu với `cells = []`, rồi `afterAll` của nó ghi đè các ô mà worker trước đã ghi. Kết quả: khi suite đỏ, `x3-matrix.json` chỉ còn phần sau lỗi. Lúc xanh thì không có vấn đề.
  Đề xuất: nối thêm vào mảng đã có (`all[p] = { …, cells: [...(all[p]?.cells ?? []), ...cells] }`), hoặc ghi từng ô trong `afterEach`.
- [ ] `docs/agile/sso-idp/spec.md` §9.6 ghi "Nguồn: `e2e/test-results/x3-matrix.json`", nhưng file đó không còn: lần chạy `pnpm -C e2e e2e` sau đó đã dọn `test-results/`.
  Vì sao: nguồn được dẫn không thể kiểm lại nếu không chạy lại suite mất khoảng 9 phút.
  Đề xuất: ghi "tạo lại bằng `pnpm -C e2e e2e:x3`" ngay cạnh, hoặc lưu bản JSON (chỉ có tên cookie) vào `runs/73-X3/`.
- [ ] ✂️ ponytail: `e2e/x3/tls-proxy.mjs:86-100` + `:9` — xem mục Ponytail.

## 💭 Nit

- `e2e/x3/cookie-matrix.spec.ts:152` có hai dòng trống liên tiếp.
- `ui.controller.ts` giữ `this.secure` riêng trong khi `SessionCookie` đã expose `secure`. Đây là hai nguồn của cùng một cờ (cùng config, nên vô hại). Có thể dùng `this.sessionCookie.secure`.

## ✂️ Ponytail

- e2e/x3/tls-proxy.mjs:L86: yagni: bỏ handler `upgrade` (tunnel WebSocket cho Vite HMR) và `import { connect }` ở L9. Fold đã cho phép "chấp nhận lỗi HMR console", và suite không cần HMR.
net: -16 lines possible.
