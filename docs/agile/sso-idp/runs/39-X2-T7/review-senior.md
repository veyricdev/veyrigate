# Senior Review — 2026-10-20 (run 39, Task 0–3)

## Kết luận: PASS

Không có 🔴. Ba 🟡 không chặn, ghi vào `backlog.md` thành DEBT-246 đến DEBT-248. Chuyển **tester** làm Task 4 (truy vết X5) và nghiệm thu.

Đã tự chạy lại: `pnpm -C be test` 382/382 (có `seed-e2e-admin.spec.ts` 16/16), `pnpm -C be typecheck` sạch, `pnpm -C fe-sso-test test` 269/269, `e2e` `tsc --noEmit` sạch. Không chạy E2E, int, compose hay gitleaks (theo phạm vi được giao).

## Tổng quan

Code bám sát fold. Không có thay đổi nào trong `be/src/` hay `fe-sso-test/src/`, toàn bộ là hạ tầng test.
- **Seed E2E** (`be/test/e2e/seed-e2e-admin.ts`): guard thuần chạy TRƯỚC khi kết nối, so tên DB chính xác bằng regex neo vào phần path của URI. Các trường hợp tiền tố/hậu tố, DB chỉ nằm trong query, escape hỏng hoặc URI không phải `mongodb` đều bị từ chối, và thông báo lỗi không echo URI hay credential (có unit test riêng cho việc này). `NODE_ENV` được kiểm hai lần, lần hai ngay trước khi ghi. Secret ngẫu nhiên của `seedBootstrap` bị bỏ, không in ra. Seed idempotent và không ghi gì khi DB đã hội tụ. Nằm ngoài `dist` nhờ `tsconfig.build` exclude `test`, có thêm marker. Int-spec bao phủ revoke → version kế tiếp, reset khoá admin, và đầu ra không chứa secret/password.
- **E2E**: chờ bằng predicate (URL, locator, `waitForResponse`), không có sleep. Cổng động + `--strictPort` nên bận cổng là fail ngay. Vite được spawn trực tiếp bằng `node` và dừng bằng `taskkill /T /F`. Mọi assert về token chỉ so status/boolean.
- **FE unit**: có vector RFC 7636 Phụ lục B (pin cả S256 lẫn base64url), mỗi nhánh reject của callback đều kiểm `fetch` không được gọi, và có 3 mutation thực sự làm test RED. Đây là test có giá trị.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Seed không thể chạy nhầm DB dev/prod**: `assertE2eSeedTarget` được gọi trước `validateEnv` và trước `createConnection`. Không tìm được URI hợp lệ nào lách qua: password chứa `/` chưa encode làm parse sai tên DB nên bị từ chối (fail closed); `?authSource` không đổi DB đích; mongoose không nhận `dbName` từ query. Đường `seedE2eAdmin` gọi trực tiếp cũng tự chặn `NODE_ENV≠test` trước khi ghi (đã có int test).
- **Không lọt vào production**: `tsconfig.build.json` exclude `test`, `assert-dist-clean` có marker `seed-e2e-admin`, script `seed:e2e-admin` chỉ được gọi từ `webServer` của Playwright.
- **Không in secret**: seed chỉ log `clientId`, version và email. `seedBootstrap` chỉ in secret trong `main()` của CLI `seed.ts`, nhánh này không được gọi ở đây. Lỗi trong `main` chỉ in `err.message`, mà thông báo của guard không chứa URI.
- **Placeholder trong repo**: `E2E_FE_ADMIN_SECRET` chỉ có hiệu lực trên `sso-idp-e2e` (nhờ guard). Allowlist gitleaks là đúng một chuỗi literal (không có metachar, không nới rule). Fold yêu cầu allowlist theo path, còn ở đây là theo giá trị chính xác, cùng quy ước với các dòng đã có. Hai cách hẹp ngang nhau, chấp nhận.
- **Admin token qua flow thật**: PKCE S256, kiểm `state` và `iss` round-trip, `client_secret_basic` gửi từ Node qua `request.newContext()` riêng (không nằm trong trace của browser). Không mint token, không ghi datastore.
- **Logout local là invariant thật**: A và B có cookie jar riêng nên `sid` riêng. Nếu local bị cài đặt nhầm thành `revokeAllForUser` thì AT của B trả 401 và B phải qua `/login`, nên test sẽ bắt được. Global kiểm cả AT (401) lẫn RT (`invalid_grant`) và phiên IdP của A. Có một điểm yếu ở cách kiểm sự tồn tại của RT, xem 🟡 DEBT-246.
- **Step-up**: token lấy từ refresh grant bị chặn 403 `step_up_required` kèm `max_age:0`, và số client của redirect không đổi (side effect = 0). Re-auth trong cùng context vẫn hiện form login, qua đó chứng minh `prompt=login` có tác dụng. Tiền đề "token không có `auth_time`" mới được suy ra chứ chưa được pin, xem 🟡 DEBT-248.
- **Consent**: Deny dẫn tới `access_denied` với 0 `POST /token` và lần sau hỏi lại. Allow dẫn tới `aud` = clientId mới và lần sau không có `/authorize` 200. Listener được gắn trước khi điều hướng nên không bị tautology.
- **redirect_uris đổi**: `/authorize` trả 400 trên port IdP và 0 request tới `/callback`. Kiểm được cả hai phía.
- **Exposure**: `expectNoSecretsExposed` và `captureTokenSecrets` (`unreadable 0`), không log URL hay token. Phần trace CI đã có DEBT-243.

## 🟡 Nên sửa

🟡 **[E2E] Kiểm sự tồn tại của token có thể pass rỗng** (DEBT-246)
`e2e/tests/logout.spec.ts:32-33` dùng `String(body.refresh_token)`. Nếu `/token` không trả RT thì giá trị thành chuỗi `"undefined"` (dài 9), và assert `"tokens issued"` vẫn pass.
Vì sao: assertion mạnh nhất của test global (RT của A trả `invalid_grant`) khi đó sẽ pass bất kể logout có thu hồi refresh family hay không, vì `"undefined"` lúc nào cũng là `invalid_grant`. Hiện tại fe-sso-test có xin `offline_access` nên RT có mặt, nhưng một thay đổi về scope sau này sẽ âm thầm biến test thành tautology. `support/admin.ts:113-114` có cùng mẫu (ở đó `adminRefresh` có kiểm 200 nên ít rủi ro hơn).
Đề xuất: `expect(typeof body.refresh_token === "string" && body.refresh_token.length > 0, "refresh token issued").toBe(true)`, tương tự cho AT. Cách này vẫn là boolean nên không echo token.

🟡 **[E2E] Browser vẫn mang `code` tới `localhost:3000`** (DEBT-247)
`e2e/tests/support/admin.ts:50-58` đọc `code` từ `Location` của 302 (cách làm hợp lệ), nhưng browser vẫn đi theo redirect tới `http://localhost:3000/auth/callback?code=…`.
Vì sao: helper đang ngầm giả định không có gì lắng nghe ở :3000. Máy dev thường có app khác chạy ở cổng này. Khi đó code đi tới một tiến trình không liên quan, và nếu sau này fe-admin thật chạy ở :3000 (A4) thì nó có thể đổi code trước, làm test flaky. Về bảo mật thì rủi ro thấp (client confidential, có PKCE), chủ yếu là vấn đề tất định.
Đề xuất: giữ cách đọc `Location`, thêm `await context.route("http://localhost:3000/**", (r) => r.abort())` trước `page.goto`. Request khi đó không rời browser, và nhánh lỗi điều hướng vẫn được `step` nuốt như hiện nay.

🟡 **[test] Tiền đề step-up chưa được pin** (DEBT-248)
`e2e/tests/admin-client.spec.ts:61-66`: test đi từ "token qua refresh grant" tới "không có `auth_time`" bằng suy luận từ code của BE.
Vì sao: nếu BE sau này giữ lại `auth_time` khi refresh (một quyết định hợp lệ theo OIDC), 403 có thể vẫn xảy ra vì lý do khác, hoặc test đổi nghĩa mà không ai thấy. Phần trọng tâm "step-up thật sự từ token không có `auth_time`" nên được kiểm trực tiếp.
Đề xuất: decode payload JWT (base64url, không verify) và assert boolean `!("auth_time" in refreshedPayload)` và `"auth_time" in freshPayload`. Chỉ cần thêm khoảng 3 dòng và không echo token.

## 💭 Nit

- `e2e/tests/support/rp-server.ts:77-79`: trên POSIX chỉ gửi `SIGTERM` và chờ 10 s, không leo thang sang `SIGKILL`. Nếu Vite treo thì tiến trình còn sót trên CI. Cân nhắc `child.kill("SIGKILL")` sau timeout.
- `e2e/tests/logout.spec.ts:72-75`: mảng `idpLogin: string[]` chỉ để đếm, dùng `let n = 0` là đủ.
- `fe-sso-test/test/returnTo.test.ts`, `returnToStore.test.ts`: thiếu dòng trống giữa hai `describe`.
- `.gitleaks.toml:20`: allowlist theo giá trị chứ không theo path như fold viết. Chấp nhận, nhưng nên ghi rõ trong log rằng quy ước của repo là exact-value.

## ✂️ Ponytail

- be/test/e2e/seed-e2e-admin.ts:L87-89: shrink: `connection.models.ClientCredential ?? connection.model(...)` — `connection.model(name)` đã trả model đã đăng ký (và cả hai nhánh đều throw nếu chưa đăng ký). Thay bằng `connection.model<ClientCredential>('ClientCredential')`.
- be/test/e2e/seed-e2e-admin.ts:L114: shrink: tương tự, `connection.model('User')`.
- be/test/e2e/seed-e2e-admin.ts:L35: yagni: `export` của `E2E_DB_NAME` không ai import. Đổi thành `const`.
- e2e/tests/logout.spec.ts:L72: shrink: mảng chỉ dùng để đếm. Thay bằng biến đếm.
net: -4 lines possible.
