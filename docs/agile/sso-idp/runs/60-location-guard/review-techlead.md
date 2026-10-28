# Tech Lead Review — 2026-10-28 (run 60, phòng thủ cuối redirect + dọn sau run 59)

## Kết luận: PASS

Plan gốc (2 task) đúng vấn đề nhưng chỉ có tiêu đề; thiết kế, cổng security, test âm/đối chứng và mutation đã fold vào `tasks.md` mục "Fold tech-lead (2026-10-28)". T1 → **frontend-dev**, T2 → **backend-dev**, độc lập, song song được.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. DEBT-446 là 1 kiểm tra thuần (không I/O) trong `withSecurityHeaders`, lớp ngoài cùng mọi response của server entry, độc lập cách h3/srvx/router-core parse path. Chọn kiểm `Location` thay vì từ chối `Host` ≠ host `APP_URL`: cách sau chặn nhầm sau reverse proxy và healthcheck Docker, cách trước chỉ nhìn đầu ra.

## Xác minh (preflight codegraph 1.6.2, sync Done, HEAD 876b786)

**DEBT-446, mọi redirect fe-admin phát ra hiện nay**:
- `fe-admin/src/server/auth/bff.ts` `login` 302 ⇒ `authorization_endpoint`; `logout` 303 ⇒ `end_session_endpoint` hoặc `/`; `handleCallback` 302 ⇒ `sanitizeReturnTo` (`oidc/return-to.ts`: chỉ path tương đối, từ chối `//`, `\`, control, `%2F`/`%5C` trong path, `/auth/*`, origin ≠ APP_URL). Step-up đi chung `login` (`stepup=1`), cùng đích.
- `fe-admin/src/server/oidc/discovery.ts`: `issuer` phải bằng cấu hình VÀ mọi endpoint phải cùng origin issuer (fail-closed) ⇒ origin hợp lệ của redirect ra IdP đúng bằng origin `OIDC_ISSUER`; không có URL IdP nội bộ nào khác lọt vào `Location`.
- `__root.tsx` `beforeLoad` ⇒ `redirect({ href: "/auth/login?returnTo=…" })`; `@tanstack/start-server-core@1.169.39` `handleRedirectResponse` + `router-core@1.171.34` `resolveRedirect` (`router.js:556`) giữ href tương đối, chỉ giữ URL tuyệt đối khi `pathname` bắt đầu `//`. Nguồn tuyệt đối theo `Host` duy nhất: `createStartHandler.js:284` `Response.redirect(url, 308)`.
- Probe build thật run 59 (test-report L2-1): 12 150 lần 307, mọi `Location` là path tương đối ⇒ quy tắc mới không chặn nhầm traffic hiện có.
- `serve.mjs` `assets` (srvx `serveStatic`) nằm ngoài `withSecurityHeaders`; srvx 0.11.22 `static.mjs` không có redirect ⇒ không cần bọc, ghi tripwire DEBT-449.
- `security-headers.test.ts` (d) hiện gọi `withSecurityHeaders` không `site` với `Location` tuyệt đối ⇒ phải sửa test (đã ghi trong fold), hành vi mới là fail-closed.

**DEBT-447**: `routerPathname` không có `%` ⇒ `replaceAll` + `decodeURI` là identity, setter `pathname` với giá trị đã chuẩn hoá là idempotent, không ném ⇒ bỏ `if` an toàn; corpus decode run 59 là lưới.

**DEBT-444**: đúng như senior run 59; Fastify `reply.headers(obj)` chép từng key ⇒ spread thừa. Giữ guard runtime `statusCode` (kiểu Fastify không phải bằng chứng runtime).

**DEBT-445**: jose 5.10.0 `createRemoteJWKSet` có `jwks()` (`jwks/remote.js:139`), `createLocalJWKSet` cũng có (`local.js`) nhưng kiểu khai báo của local không có ⇒ khai báo optional trên `GoogleProvider.jwks`. JWKS rỗng không do token gây ra (Google điều khiển) ⇒ phân loại 502 không tạo oracle, vẫn fail-closed. Chi phí ~3 dòng + 1 test ⇒ làm luôn thay vì để 💭 mãi.

## Điểm mạnh

- Phạm vi nhỏ, đúng các debt run 59 để lại; không chạm authn/session/cookie.
- Lớp mới không phụ thuộc phiên bản thư viện: chặn cả lớp lỗi "URL tuyệt đối dựng từ Host", không chỉ đường 308 đã biết.
- T1/T2 tách lane rõ, không phụ thuộc nhau.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm thiếu của plan gốc (tiêu chí origin, hành vi khi chặn, test âm/mutation, cổng security) đã được bổ sung trực tiếp trong fold; dev làm theo fold:
- [x] Tiêu chí: so `origin` chuẩn hoá, xử lý protocol-relative/backslash/tab/userinfo/scheme `null`; cấm `startsWith`/regex.
- [x] Khi chặn: 404 `Not Found`, bỏ mọi header gốc (kể cả `Set-Cookie`), huỷ body, giữ header A7; log 1 dòng cố định + status, không URL/Host.
- [x] Fail-closed khi thiếu cấu hình origin; không flag tắt.
- [x] Test đối chứng cho mọi redirect hợp lệ đã liệt kê + E2E 36 làm đối chứng tích hợp; mutation M1–M8 (T1), 3 mutation (T2).

## Đề xuất (không bắt buộc)

- DEBT-449 💭 (backlog): tripwire `serve.mjs` `assets` nằm ngoài lớp `Location`; khi nâng srvx kiểm lại `serveStatic` không phát redirect.
- Không thêm smoke Docker cho lớp mới (không có đường nào trên image thật tạo được `Location` lạ khi guard `//` còn); unit + entry + router-core thật là đủ.
