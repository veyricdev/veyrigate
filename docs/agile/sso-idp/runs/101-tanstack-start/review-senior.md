# Senior Review — 2026-11-27

## Kết luận: PASS

## Tổng quan

Migrate gọn, đúng D101.1–D101.12, không lan ra ngoài phạm vi. Điểm tốt:
- Hai chỗ ghi header duy nhất (`viewer.ts:13`, `instance.ts:28,45-46`) chuyển sang helper Start; `src` không còn `getResponseHeaders`/`inputValidator`. Các `headers.append("set-cookie")` còn lại (`bff.ts`, `errors.ts`) là `Headers` cục bộ của `Response` tự dựng ở server route ⇒ không bị ảnh hưởng.
- Đọc dist `start-server-core@1.169.45`: `appendResponseHeader("set-cookie")` dedupe theo name+domain+path (JSDoc `instance.ts` mô tả đúng); `runInStartRequest` chỉ 400 khi `%` + `decodeURI` ném, không sửa URL; `createStartHandler.js:327-329` vẫn 308 qua `getNormalizedURL(requestUrl)` ⇒ stand-in trong `protocol-relative-risk.test.ts` khớp 1:1 (`startRejects` + `getNormalizedURL(new URL(...))` thật của router-core), tripwire phiên bản cập nhật, corpus giữ nguyên.
- Khoá runtime thật có sức bắt: E2E (a) SSR 307 + đúng 1 Set-Cookie xoá `fea_sid` (Max-Age=0/HttpOnly/SameSite/Path=/) + no-store; (b) RPC `/_serverFn` GET xoá cookie và về login; `pragma: no-cache` ở secrets là tín hiệu riêng của `setNoStore` (grep: `pragma` chỉ có ở `instance.ts:46`, `withSecurityHeaders` không đặt). Mutation của dev ⇒ 3 đỏ đúng chỗ.
- DEBT-715: giữ bí mật bare `e378`/`63bf`, thêm 4 dạng có `:`, chỉ khử UUID/ObjectId + tripwire đếm đúng `2×CORPUS.length` `<uuid>` và 0 `<oid>` ⇒ regex không thể nuốt dữ liệu thật mà không đỏ.

Tự kiểm lại: `pnpm install --frozen-lockfile` OK (supply-chain policy pass); `fe-admin` typecheck 0 lỗi; unit fe-admin **1669/1669** (69 file); `protocol-relative-risk` 8/8. Lockfile diff: chỉ importer `fe-admin` + đúng bộ D101.1 (thêm `srvx@1.0.8` 10-27, `unplugin@3.7.0` 10-28, `fetchdts@0.2.0` 08-31, `diff@9.0.0` 04-13; Start 1.169.5 / router-plugin 1.169.0 / start-plugin-core 1.171.56 = 11-08) ⇒ mọi gói ≥ 19 ngày; không `minimumReleaseAgeExclude`.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **Identity/session**: cookie phiên chết bị xoá trên cả SSR document và RPC `/_serverFn` (E2E a/b, runtime Start thật, không mock). Set-Cookie trùng tên `fea_sid` (getViewer + adminCall cùng request) dedupe ⇒ 1 header, giá trị như nhau ⇒ không mất xoá phiên.
- **Exposure/cache**: `setNoStore` ⇒ `cache-control: no-store` + `pragma: no-cache` qua `setResponseHeader` trên answer issue/rotate secret (E2E). `withSecurityHeaders` vẫn là lớp no-store dự phòng.
- **CSRF server fn**: `start.ts` không đổi; tech-lead đối chiếu `createCsrfMiddleware` chỉ refactor sync/async; image smoke 403 cross-site `/_serverFn` thuộc gate tester (D101.7).
- **Boundary `//`**: logic guard `server.ts` không đổi; comment cập nhật đúng pipeline 1.169; test đối chiếu router-core thật + srvx host thật, 0 redirect trên toàn corpus.
- **Supply chain**: không gói < 14 ngày, không exclude; bỏ override seroval giữ 1.6.12 (mọi GHSA vá ≤ 1.6.11); Dependabot cooldown 14 ngày giữ ⇒ 1.169.6/7 tự hoãn.

## 🟡 Nên sửa
(không có)

## 💭 Nit
- `e2e/tests/fe-admin-risk.spec.ts` (test b, predicate `waitForResponse`) — bắt mọi GET `/_serverFn/*` đầu tiên, không riêng getViewer. Hiện đúng (mutation bỏ append ở `viewer.ts` ⇒ đỏ), nhưng nếu sau này route Users có loader GET khác chạy trước thì test vẫn xanh nhờ `adminCall` xoá cookie, mất phân biệt. Cân nhắc lọc theo function id trong URL nếu ổn định.
- `fe-admin/test/viewer-fn.test.ts` / `admin-fn.test.ts` — bỏ assert "giữ Set-Cookie khác tên" (DEBT-287) vì giờ là ngữ nghĩa của Start; chỉ còn assert `append` chứ không `set`. Chấp nhận (JSDoc ghi rõ), không cần test thêm khi fe-admin chưa phát cookie khác trong cùng request.
- `fe-admin/src/server/admin-api/instance.ts:21` — dòng JSDoc dài hơn các dòng xung quanh; xuống dòng cho đồng bộ.

## ✂️ Ponytail
Lean already. Ship.
