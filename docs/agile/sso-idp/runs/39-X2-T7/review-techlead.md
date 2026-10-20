# Tech Lead Review — 2026-10-20 (run 39, X2 + T7 + X5)

## Kết luận: PASS (có fold, xem `tasks.md` mục "Fold tech-lead")

Không có blocker phải trả analyst. Các điểm chưa khả thi trong text gốc đã được chỉnh thẳng vào `tasks.md`.

## Kiến trúc đề xuất

- **Không đụng `be/src/` và `fe-sso-test/src/`.** Mọi phần mới là test infra: `be/test/e2e/seed-e2e-admin.ts` (ngoài `dist`, có marker trong `assert-dist-clean.mjs`), helper Playwright `e2e/tests/support/admin.ts` và `rp-server.ts`, 2 spec mới `logout.spec.ts`, `admin-client.spec.ts`.
- **Admin token (Q-39.1)**: đi qua flow OAuth thật của `fe-admin` (authorization_code + PKCE + `client_secret_basic`). Redirect `localhost:3000` bị `context.route` chặn để lấy `code`. Secret biết trước chỉ tồn tại trên DB `sso-idp-e2e`: seed E2E chỉ chạy khi `NODE_ENV=test` và tên DB đúng `sso-idp-e2e` (kiểm trước khi kết nối). Không backdoor, không mint JWT, không ghi Redis.
- **client_id runtime (Q-39.2)**: spawn Vite thứ hai của fe-sso-test trên :5174 với `VITE_OIDC_CLIENT_ID` = id server vừa sinh. App giữ nguyên, chế độ mặc định :5173 không đổi.
- **Step-up tất định**: token từ refresh grant không có `auth_time`, nên `StepUpGuard` luôn trả 403 `step_up_required`. Re-auth bằng `prompt=login&max_age=0`. Không phải chờ 5 phút, không phải chỉnh đồng hồ.
- **Không tách run**: sau fold, X2 còn 2 spec, một seed nhỏ và unit FE. Refresh rotation và reuse-detect đã có ở `lab.spec.ts`, consent dời sang flow client mới. Kích thước còn lại khoảng M.

## Đối chiếu code (khả thi)

- `POST /admin/clients`: `clientId` do server sinh. Vì vậy client_id phải nạp lúc runtime và không thể dùng client cố định cho `fe-sso-test`.
- `POST` và `PATCH /admin/clients` có `@RequireRecentAuth(5)`. Disable là PATCH `{disabled:true}` gửi riêng, cũng cần step-up.
- `seed.ts`: `fe-admin` là confidential, secret chỉ cấp khi không còn credential active và CLI in secret ra stdout. Nếu chạy `db:seed` trong webServer, secret sẽ lộ ra log; từ lần chạy thứ 2 trên DB không drop thì không còn secret. Vì vậy cần seed E2E với secret biết trước.
- Admin tạo client có `allowHttpLocalhost` khi `NODE_ENV !== production`, và E2E dùng `test` nên được.
- Logout: `POST /logout` dùng `revokeForSession` cho phạm vi local, `?scope=all` dùng `revokeAllForUser` cho cả session lẫn refresh family. Tombstone `sid` làm AT cũ trả 401 ở `/userinfo`. UI đã có nút "Sign out everywhere".
- Deny consent: `access_denied`, không ghi consent và không cấp code. FE hiện `error-code` qua `ErrorPage`.
- fe-sso-test không có nút refresh. Rotation và reuse đã được `lab refresh replay` phủ.

## Điểm mạnh

- Bám đúng plan X2/T7/X5. Hạ tầng E2E (webServer, `env.ts` kín, `captureTokenSecrets`, `expectNoSecretsExposed`, mock Google) đã đủ để mở rộng.
- Các ràng buộc vận hành (không drop/FLUSH, DB/Redis riêng cho E2E) được nêu rõ.

## Vấn đề (đã fold, không chặn)

- [x] Q-39.1 chưa chốt; phương án "secret in 1 lần" không chạy lặp được trên DB không drop và làm lộ secret ở stdout. Đã chốt Task 0 (seed E2E có guard) cùng flow OAuth thật.
- [x] Q-39.2: client_id do server sinh nên cần FE runtime. Đã chốt spawn Vite :5174, không sửa app.
- [x] Consent ở Task 1 không tất định vì user dev đã consent `fe-sso-test` từ trước. Đã dời sang client mới (Task 2c). Sửa luôn kỳ vọng: sau Deny phải **hỏi lại**; chỉ sau Allow mới không hỏi lại.
- [x] "Nút refresh nếu có" không tồn tại. Không thêm UI; rotation/reuse truy vết về `lab.spec.ts`.
- [x] Step-up chưa có cách tạo `auth_time` cũ. Dùng token từ refresh grant.
- [x] "Xanh 2 lần" chưa đủ để phát hiện flaky. Thêm `--repeat-each=3` cho 2 spec mới, giữ `retries:0`, cấm sleep cố định.
- [x] Task 3 nói chung chung ("bổ sung chỗ thiếu"). Đã liệt kê case cụ thể và 3 mutation tay.
- [x] Phân công: Task 0 backend-dev, Task 1–3 frontend-dev, Task 4 tester.

## Cổng security design (test infra chạm credential admin)

- **Tài sản / boundary**: credential `fe-admin` và super_admin trên DB E2E. Boundary là "không bao giờ chạy trên DB dev/prod": guard `NODE_ENV=test` cộng tên DB `sso-idp-e2e`, kiểm trước khi kết nối, kèm acceptance âm.
- **Invariant**: seed idempotent (secret khớp thì không ghi). Credential cũ bị revoke trước khi chèn version mới. Mật khẩu và khoá của admin được đặt lại chỉ trên DB E2E.
- **Abuse**: placeholder secret commit trong repo chỉ dùng được trên DB E2E local hoặc CI tạm. Code chạy seed không nằm trong `dist` (INV-23 marker).
- **Failure**: Mongo lỗi thì seed exit ≠0, webServer fail và suite fail (fail-closed). Lỗi khi disable ở `afterAll` là best-effort, chỉ log `clientId` và status.
- **Exposure**: seed không in secret. Test không echo token/code/secret, assert dạng boolean hoặc status. `expectNoSecretsExposed` chỉ áp trên origin FE.

## Đề xuất (không bắt buộc), đã đưa vào backlog

- DEBT-240: dọn client E2E bị disable tích luỹ (mỗi lần chạy thêm 1 client cùng consent/family) trên `sso-idp-e2e`.
- DEBT-241: fe-sso-test chưa có nút "Refresh now" ở `/tokens` để test tay rotation.
- DEBT-242: khi có fe-admin UI (A4), chuyển admin login E2E sang UI thật, bỏ `route` chặn `localhost:3000`.
- DEBT-243: trace CI `retain-on-failure` ghi network của flow admin (Basic auth placeholder, token CI tạm). Cân nhắc tắt trace cho `admin-client.spec.ts`.
