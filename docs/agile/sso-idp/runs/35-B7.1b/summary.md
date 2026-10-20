# Summary — run 35 B7.1b (M7) — ✅ PASS 4/4 task (T4 → run 36, DEBT-207)

- **Phạm vi**: T1 tham số OAuth lặp ở `/authorize`: `client_id`/`redirect_uri`/`request_id` ⇒ trang lỗi 400 trước khi tra client; tham số khác ⇒ 302 `invalid_request` + `iss`, không echo `state` khi lặp; `scope`/`prompt` lặp hết 500. T2 `assertMember` (user active ở `client.tenantId`) trong `handle` (trước consent, `prompt=none`, resume) và `decideConsent` ⇒ `access_denied`, audit `not_member`; không tự cấp membership. T3 `recheckCodeGrant` sau insert family: client enabled, `redirect_uri` còn đăng ký, user không khoá, còn member, consent còn phủ ⇒ revoke + `invalid_grant` đồng nhất. T5 ma trận 75/77 có.
- **Verify**: BE unit 317/317, int 935/935, FE 240/240, E2E 16/16; mutation RED (13 + 3 của tester).
- **Commit**: `29c1a45`.
- **Vòng lặp**: analyst=1, tech-lead=1, BE dev=1, senior=1, tester=1 — không REJECT.
- **Debt**: đóng DEBT-128/144/204/205/212, đóng một phần 116/141/156; mở DEBT-207 (refresh + login re-check → run 36), 208 (admin API thêm member), 209, 210, 211, 213.
- **Lưu ý người dùng (Q35.2)**: client ở tenant khác `default-tenant` chỉ dùng được khi membership được tạo bằng seed/DB (chưa có admin API — DEBT-208).
