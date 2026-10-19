# Tech Lead Review — 2026-10-19 — run 33 (DEBT-189 + B5.3 + X4)

## Kết luận: PASS (có điều kiện: fold F1–F22 trong `tasks.md` là BẮT BUỘC, ưu tiên hơn text cũ)

Không có blocker. `tasks.md` gốc để ngỏ đúng các quyết định cần tech-lead (Q-33.1–33.3) và thiếu abuse cases/failure semantics cho linking; tất cả đã được chốt trực tiếp trong mục "Fold tech-lead". Phạm vi cuối: T1, T2, T4' (thu nhỏ), T3; DEBT-182 hoãn sang B7.3.

## Đối chiếu code thật (4c36371)

- `authorize.service.ts` `maxAgeExceeded` trả `false` khi `session === null` ⇒ `max_age` không sinh `reauthAfter` khi chưa có session (DEBT-189 xác nhận). `resume` đã kiểm `session.authTime < ctx.reauthAfter`, nên chỉ cần tổng quát hoá cách tính `reauthAfter` (F1), không cần field mới.
- `federation.client.ts`: Google chỉ gửi `max_age=0` khi `reauth`; `reauthSince = record.createdAt` (thời điểm start). `SessionService.create` luôn đặt `authTime = now`, nên ID token `auth_time` là thời điểm callback chứ không phải thời điểm xác thực ở provider (F3).
- `federation.service.ts` `resolveUser`: nhánh email trùng ⇒ `email_conflict` 409, chưa có link. Thứ tự "thiếu email verified ⇒ `email_unverified` trước `findByEmail`" đã đúng (không dò được tài khoản bằng email chưa verify), phải giữ (F5).
- `AuthenticationService.login` đã đủ thuộc tính cần cho bước chứng minh sở hữu: lỗi generic, `DUMMY_HASH` cho user không password, chặn `emailVerifiedAt` rỗng, đếm sai và lock, kiểm lock atomic (DEBT-154). Bước link tái dùng nguyên hàm này (F8), không viết bộ kiểm mật khẩu thứ hai.
- `FederatedIdentity` unique `(provider, providerId)`, `link()` map `DuplicateError`; `AuditAction.ACCOUNT_LINKED` đã có.
- Module: `UiModule → FederationModule`; vì vậy FederationModule không được import UiModule. Nó khai `CsrfService`/`CsrfGuard` dạng provider như OauthModule (F8).
- `main.ts` không export phần cấu hình app; int-test tự dựng lại plugin. E2E cần tách `configureApp` để entry E2E dùng đúng cấu hình production (F17). `tsconfig.build.json` loại `test/` ⇒ entry đặt ở `be/test/e2e/` không vào `dist/`. `@nestjs/testing`, `jose`, `ts-node` đều đã là devDependency ⇒ không thêm dependency.
- DEBT-084: `GET /login` nới `form-action` tới origin RP vì Chromium áp CSP của trang chứa form lên cả chuỗi 302. Trang link cũng POST rồi 302 → `/authorize` → RP, nên cần đúng cơ chế đó (F7). Nếu thiếu, E2E sẽ hỏng trên Chromium.

## Trả lời câu hỏi

- **Q-33.1 (E2E boot, DEBT-184)**: tách `src/bootstrap.ts#configureApp` khỏi `main.ts`. Entry `be/test/e2e/e2e-main.ts` (ngoài `src/`, không vào `dist/`) chạy bằng `ts-node`: khởi mock Google `node:http` trên `127.0.0.1:0` trong cùng tiến trình (JWKS cục bộ), `Test.createTestingModule({imports:[AppModule]}).overrideProvider(FEDERATION_PROVIDERS)`, `configureApp`, listen; từ chối chạy khi `NODE_ENV=production`. URL mock chỉ có trong file test, nên INV-23 được giữ. Có guard `assert-dist-clean.mjs` (marker `__E2E_MOCK_PROVIDER__`). **Người làm: backend-dev** (phần lớn là BE). Tester chạy và nghiệm thu.
- **Q-33.2 (lock / chỉ-federated / DEBT-186)**: không có nhánh riêng. Mọi user có email trùng đều qua cùng trang link và bước `auth.login`. User bị lock, user chỉ-federated và user local chưa verify đều nhận cùng lỗi generic, không được link và không lộ trạng thái. DEBT-186 chốt **cho phép** đặt mật khẩu qua `/forgot` (cùng mức tin cậy với reset local, đã audit và revoke). Đây là đường chính thức để user chỉ-federated liên kết thêm provider; chỉ cần thêm 1 int pin.
- **Q-33.3 (phạm vi)**: giữ T1, T2, T3. Task 4 thu nhỏ còn DEBT-190(a) + DEBT-191 (nhỏ, cùng module). **Hoãn DEBT-182**: nhận diện "user mồ côi" bằng heuristic là không an toàn, cách đúng là transaction ở B7.3.

## Rủi ro linking đã rà

| Rủi ro | Xử lý (fold) |
|---|---|
| Auto-link / takeover qua email (INV-22) | Link chỉ sau `auth.login` thành công bằng mật khẩu của chính tài khoản đích; email lấy từ pending phía server, không phải input (F6, F8) |
| Email provider chưa verified | Không vào nhánh link, không tạo user, không dò `findByEmail` (F5, F14k) |
| Pre-account-hijack (kẻ tấn công đăng ký sẵn email nạn nhân, chưa verify) | `auth.login` chặn `emailVerifiedAt` rỗng ⇒ không bao giờ link được (F9, F14e) |
| Pending-link CSRF / fixation | Token trong cookie HttpOnly `idp_link` (SameSite=Lax, Path=/auth/), bind `sha256(idp_fed)` (constant-time), CsrfGuard trên POST (F6–F8, F14g/h) |
| Replay / race pending | Consume atomic GET+DEL TRƯỚC mọi kiểm tra; sai mật khẩu cũng tiêu pending; 2 POST song song ⇒ đúng 1 thắng (F8, F14f/m) |
| Link nhầm user | So `established.session.userId === pending.userId`; email đổi giữa chừng ⇒ không link; `DuplicateError` ⇒ không link (F8, F14j) |
| Brute-force mật khẩu qua trang link | Rate-limit `login` theo email + bộ đếm lock của `auth.login`; mỗi lần thử cần một vòng provider mới (F8) |
| Enumeration | Chỉ người đã chứng minh email verified mới biết "có tài khoản"; trang/lỗi giống hệt nhau cho 4 loại tài khoản đích (F11) |
| Re-auth / step-up | Session tạo bằng mật khẩu ⇒ `authTime=now` thoả `reauthAfter`; leg Google kiểm `auth_time` theo `reauthAfter` thật; GitHub bị từ chối khi có `max_age`/`prompt=login` (F1–F3, F14l) |
| Exposure | Không log token/cookie/email/providerId; audit `ACCOUNT_LINKED` chỉ có `{provider}`; E2E assert stdout không có `code=`/`state=`/`id_token` (F12, F22) |
| Failure semantics | Redis lỗi khi tạo/consume pending ⇒ 500 qua HtmlExceptionFilter (fail-closed, không link); context hết hạn ⇒ resume báo lỗi first-party như hiện tại; provider body > 64 KB / JWKS lỗi mạng ⇒ 502 (F16) |

## Điểm mạnh

- Nền run 32 đúng hướng: state single-use + binding `idp_fed`, callback không tự consume context mà resume qua `/authorize?request_id`. Nhờ vậy link chỉ cần chèn một bước giữa callback và resume.
- Seam `FEDERATION_PROVIDERS` cho phép E2E dùng mock mà không mở cấu hình URL runtime.

## Vấn đề (đã fold, bắt buộc làm theo)

- [ ] F1–F4: `reauthAfter` tổng quát (cả khi không session), `max_age` Google tính từ `reauthAfter`, `auth_time` session lấy từ provider (có kẹp).
- [ ] F5–F14: thiết kế pending link + trang/POST `/auth/link` + 13 case int âm/dương.
- [ ] F15–F16: `allSettled` giữ lỗi gốc; trần body 64 KB; JWKS lỗi mạng ⇒ 502.
- [ ] F17–F22: `configureApp`, entry E2E ngoài `src/`, mock trong tiến trình, guard `dist`, 4 kịch bản Playwright idempotent.

## Đề xuất (không bắt buộc → backlog)

- DEBT-192: `authTime=now` cho session GitHub/Google-không-`auth_time` (giới hạn đã biết).
- DEBT-193: một user có thể mang nhiều FI cùng provider; E2E tích luỹ FI trong `sso-idp-e2e`.
- DEBT-194: E2E chạy entry test thay `dist/main.js`; phần `main.ts` còn lại (trustProxy/listen) không được E2E phủ.
