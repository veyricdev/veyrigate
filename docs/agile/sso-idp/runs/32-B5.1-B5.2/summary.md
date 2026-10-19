# Summary — run 32 B5.1 + B5.2 (M6) — ✅ PASS 4/4 task

- **Phạm vi**: T1 provider tĩnh Google/GitHub (hằng https qua DI `FEDERATION_PROVIDERS`, env optional theo cặp, fetch helper timeout 5s + `redirect:'error'`; Google verify ID token jose + JWKS cứng; GitHub email primary+verified). T3 `FederatedIdentity` index `{userId}` + `lastLoginAt`. T2 broker `/auth/{provider}/start|callback`: state Redis single-use (consume trước) + cookie `idp_fed` chống login CSRF, chống mix-up/iss, provisioning `DEFAULT_TENANT_ID`, email trùng local ⇒ dừng an toàn, lock ⇒ từ chối, race compensation, `sessions.establish` rồi 302 `/authorize?request_id`; re-auth (Google `max_age=0` + `auth_time`, GitHub từ chối); `amr` session→code→ID token (đóng DEBT-030). T4 nút social trong `login.eta`.
- **Verify**: BE unit 303/303, int 780/780, FE 240/240, E2E 12/12; mutation RED (binding, provider, consume order, compensation, lock, redirect, atomic consume). Không gọi provider thật.
- **Commit**: `4c36371`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-030; mở DEBT-182–191. **DEBT-189 (`max_age` không có `prompt=login` bị session Google cũ vượt qua, `auth_time` sai) bắt buộc đóng run 33.**
- **Người dùng cần làm**: xoá trắng 4 biến `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` trong `be/.env` (placeholder `your-*` giờ bật provider với credential rác).
