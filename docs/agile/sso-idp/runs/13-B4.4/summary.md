# Summary — B4.4 (M3 `/token` authorization_code) — ✅ PASS 4/4 cổng

- **Quyết định**: **Q6** chốt (user ủy quyền, hướng production): access 900s, refresh 30d absolute, ID token = access TTL, session idle 8h / absolute 30d, secret grace 7d — đọc từ env sẵn có.
- **Phạm vi**: `POST /token` (`TokenController`): parse form riêng (tham số lặp → `invalid_request`), client auth basic/post/none (>1 method bị từ chối), client auth trước consume, kiểm grant `authorization_code`; `TokenService`: access token (`aud`=resource bind, `jti`, `scope`, `client_id`, `auth_time` cho admin), ID token chỉ khi `openid` (`nonce`, `auth_time`, `amr`/`acr`), refresh token theo D7 (hash-only, family mới). `Client.grantTypes[]` (+ chuẩn hoá client cũ).
- **Security**: INV-13 — Lua `consume` bind thêm PKCE challenge (lệch không xoá code); concurrent cùng code → đúng 1 lần 200; `no-store` cả trên lỗi; fail-closed 500 khi Redis/Mongo/signer/audit lỗi, không rò token/secret; Basic header decode lỗi → 401 `invalid_client`.
- **Bug đã sửa (senior REJECT 1)**: thiếu int test fail-closed; `%ZZ` trong Basic gây 500.
- **Verify**: typecheck/lint PASS; unit 80/80; int 230/230 → **310/310**.
- **Commit**: (xem STATUS).
- **Vòng lặp**: analyst=1, tech-lead=1, dev=2, senior=2 (REJECT→PASS), tester=1.
- **Debt**: mở DEBT-029 (rate-limit `/token` → B7), DEBT-030 (amr/acr hằng → B5); DEBT-019/020/026/027 dời sang B4.6.