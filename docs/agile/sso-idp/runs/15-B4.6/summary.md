# Summary — B4.6 (M4 discovery + `/userinfo` + `/introspect`) — ✅ PASS 4/4 task

- **Phạm vi**: Discovery `/.well-known/openid-configuration` khớp endpoint thật (URL suy từ issuer, giữ path), RS256, S256, `offline_access`, `refresh_token`, `revocation_endpoint`/`introspection_endpoint`, `client_secret_post`; chưa quảng bá `end_session_endpoint` (DEBT-038 → B4.7). `GET /userinfo` (Bearer từ header, `verifyAccessToken` RS256+iss+`typ: at+jwt`, claim theo scope whitelist, CORS per-client không Allow-Credentials). `POST /introspect` RFC 7662 (chỉ confidential client, chống IDOR/confused-deputy, phân nhánh theo shape, `{active:false}` đồng dạng, fail-closed 500).
- **Quyết định**: OPEN-1 — access token chỉ hết hiệu lực theo `exp` + liveness (client/aud/user còn tồn tại); revoke tức thời qua `sid` → DEBT-037. OPEN-2 — `/userinfo` nhận access token mọi resource; access token đổi header `typ: at+jwt` chống nhầm ID token. DEBT-026/027 dời sang run consent-hardening.
- **Bug đã sửa (senior REJECT 1)**: `/introspect` thiếu kiểm liveness cho access token (doc/spec nói có) → tách `isAccessTokenLive` dùng chung; thiếu test `at+jwt` từ `/token` thật + `verifyAccessToken`.
- **Dọn nợ**: đóng DEBT-019 (gỡ `@fastify/cors`, hook CORS tự viết), 020 (index `allowedCorsOrigins`), 033, 035 (test race tất định), 036.
- **Verify**: typecheck/lint PASS; unit 94/94; int 311/311 → **405/405**.
- **Commit**: `d513348`.
- **Vòng lặp**: analyst=1, tech-lead=1, dev=2, senior=2 (REJECT→PASS), tester=1.
- **Debt**: mở DEBT-037..042 (037/038/040/041 → B4.7; 039 → B7.1; 042 → B7).