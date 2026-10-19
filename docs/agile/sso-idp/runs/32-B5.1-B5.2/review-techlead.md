# Tech Lead Review — 2026-10-19 — run 32 (B5.1 + B5.2 federation)

## Kết luận: PASS (có điều kiện: fold F1–F16 trong `tasks.md` là BẮT BUỘC, ưu tiên hơn text cũ)

Không có blocker không sửa được bằng fold. Các lỗi thiết kế trong `tasks.md` gốc (tự consume context ở callback, mở CSP cho provider, env bắt buộc, thiếu `amr`, reauth bị vô hiệu hoá bởi SSO của provider) đã được chỉnh trực tiếp ở mục "Fold tech-lead".

## Đối chiếu code thật (a299314)

- `FederatedIdentity` đã có (B2.2): schema `identity/schemas/federated-identity.schema.ts` có unique `(provider, providerId)`; `FederatedIdentityService.findByProvider` / `link` (Duplicate → `DuplicateError`). **Thiếu**: index `userId`, cập nhật `lastLoginAt`. Task 3 thu nhỏ.
- `FederationModule` là stub rỗng, CHƯA được import ở `app.module`.
- Env `GOOGLE_*`/`GITHUB_*` hiện `z.string().min(1)` (bắt buộc) và `.env.example` chứa placeholder `your-google-client-id` ⇒ nếu giữ "có env = bật" thì bản copy `.env.example` sẽ BẬT provider với credential rác. Phải đổi sang optional + placeholder rỗng.
- Luồng login local: `GET /login?returnTo=/authorize?request_id=X` → `POST /login` → `sessions.establish(oldId, userId, DEFAULT_TENANT_ID)` → 302 `returnTo` → `AuthorizeService.resume` (consume atomic, kiểm `kind==='login'`, `reauthAfter` so với `session.authTime`, consent, code, echo `state`). ⇒ Callback federation **không được tự consume context**; chỉ establish session rồi 302 tới `/authorize?request_id=X` — tái dùng nguyên vẹn resume đã được kiểm chứng (reauth, consent, state echo, admin-capable).
- `token.service.ts`: `amr: ['pwd']` hằng (DEBT-030 ghi rõ "B5 must carry amr"). Login federation mà ID token nói `pwd` là sai claim ⇒ đưa vào run này.
- Logger: `serializeRequest` cắt query, `serializeResponse` cắt query của `location` ⇒ `code`/`state` provider ở callback và URL redirect sang provider không vào access log. Rủi ro còn lại là log lỗi/response body của `fetch`.
- `buildCsp`: `form-action` chỉ áp cho submit form. Nút social là `<a href="/auth/{p}/start?...">` (điều hướng top-level same-origin rồi 302) ⇒ **không cần nới CSP**; nới `form-action` cho host provider là mở rộng bề mặt vô ích ⇒ bỏ.
- Không có code dùng Mongo transaction ⇒ provisioning dùng thứ tự + bù trừ, không transaction.

## Trả lời câu hỏi

- **Q-32.1 (mock giữ INV-23)**: Định nghĩa provider là hằng trong code, cung cấp qua DI token `FEDERATION_PROVIDERS` (factory production trả hằng; enabled theo env id/secret). Int-test dùng `Test.createTestingModule(...).overrideProvider(FEDERATION_PROVIDERS)` trỏ tới mock `node:http` trên `127.0.0.1:<port ngẫu nhiên>` (ký ID token bằng `jose` + JWKS cục bộ). **Không** provider `mock` trong code production, **không** env/DB/query nào chứa URL provider, không nhánh `NODE_ENV`. Không thêm dependency (`oauth2-mock-server` của D12 không cần; GitHub không phải OIDC). E2E X4 (run 33) cần cách boot app với registry mock mà không mở cấu hình runtime → DEBT-184.
- **Q-32.2 (Google)**: Verify **ID token** từ token endpoint bằng `jose` `jwtVerify` + `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')` (cứng; `timeoutDuration`, cache mặc định): `iss ∈ {https://accounts.google.com, accounts.google.com}`, `aud === GOOGLE_CLIENT_ID`, `exp` (clockTolerance ≤ 60s), `nonce === state.nonce`, `email_verified === true` (cho nhánh tạo user), `sub` làm `providerId`. Không gọi userinfo (thêm 1 hop, mất binding nonce).
- **Q-32.3 (tenant/trạng thái)**: Giống `register`: `UserTenant(userId, DEFAULT_TENANT_ID)`, session `tenantId = DEFAULT_TENANT_ID` (mọi session hiện tại đều vậy; không lấy `client.tenantId` từ context — không tin dữ liệu ngoài phiên, và hành vi tenant phải đồng nhất local/federated). User mới: `email` = email đã verify của provider (normalize), `emailVerifiedAt = now`, không `passwordHash`, `profile: {}` (không lưu thêm PII provider).
- **Q-32.4 (phạm vi)**: Vừa 1 run **sau khi** cắt: bỏ CSP provider, Task 3 thu nhỏ (index `userId` + `lastLoginAt`), callback tái dùng resume. Thêm DEBT-030 (`amr`) vì bắt buộc cho tính đúng của token. Không tách thêm; GitHub reauth và E2E sang backlog/run 33.

## Rủi ro đã rà (chi tiết ở fold)

| Rủi ro | Xử lý |
|---|---|
| Login CSRF ở leg provider (kẻ tấn công gửi URL callback chứa `code`+`state` của mình) | Cookie binding `idp_fed` (CSPRNG, HttpOnly, SameSite=Lax, Secure theo config, Path=/auth/, Max-Age 600) — tái dùng nếu đã có; state lưu `sha256(cookie)`; callback so sánh constant-time; thiếu/sai ⇒ lỗi first-party (F5) |
| Mix-up giữa provider | State lưu `provider`; callback route provider phải khớp; Google kiểm `iss` ID token và tham số `iss` (RFC 9207) nếu có; redirect_uri riêng mỗi provider (F5, F2) |
| Open redirect | Đích sau callback dựng server-side `'/authorize?request_id=' + encodeURIComponent(state.requestId)`; mọi lỗi ⇒ trang first-party, không bao giờ redirect RP ở leg này (F6) |
| SSRF | Endpoint hằng; `redirect_uri` tính từ `ISSUER` (không Host header); `fetch` `redirect:'error'`, timeout; grep-test không có đường URL từ input (F1, F2) |
| Lộ token/secret provider | Không log body/response/err.message của provider; lỗi map về mã cố định; audit chỉ `provider`; test spy logger + audit (F9) |
| Session fixation | `sessions.establish(oldCookie, …)` như login local (F6) |
| Race tạo user/FI | Thứ tự + bù trừ có kiểm thử song song (F7) |
| Reauth bị SSO provider vô hiệu hoá | Google `max_age=0` + kiểm `auth_time`; GitHub từ chối context có `reauthAfter` (F8) |
| Khoá tài khoản bị bỏ qua | Callback từ chối user `lockedUntil > now` (admin lock/brute-force) (F7) |

## Vấn đề (đã fold — dev bắt buộc làm theo)
- [x] F1–F16 trong `tasks.md` mục "Fold tech-lead".

## Đề xuất (không bắt buộc) → backlog
- DEBT-182: user mồ côi nếu tiến trình chết giữa tạo User và FI.
- DEBT-183: GitHub không đáp ứng reauth (`prompt=login`/`max_age`).
- DEBT-184: X4 E2E cần mock provider cho app đã boot mà không mở cấu hình URL runtime.
- DEBT-185: ID token từ refresh grant bỏ `amr` (không bịa).
- DEBT-186: user chỉ-federated có thể tự đặt mật khẩu qua `/forgot` — chốt chính sách ở B5.3.
