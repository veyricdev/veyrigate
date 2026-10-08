# Summary — B4.1 (M3 walking skeleton) — ✅ PASS 4/4 cổng

- **Phạm vi**: `/authorize` endpoint + `AuthorizeRequestContext` (Redis, single-use, TTL 10'). Validate client_id/redirect_uri (exact match, INV-3), response_type=code, PKCE S256 (reject plain), scope lọc theo client, resource map identifier→resourceId, state/nonce echo, prompt none/login/consent khung, max_age. Dừng ở "ready"/redirect tới login — chưa phát code (B4.3/B4.4).
- **Code**: `be/src/modules/oauth/authorize/` (service, controller, context service, errors); wire `OauthModule`→`AppModule`. Open-redirect boundary: lỗi Phase 1 (chưa trusted) → trang lỗi HTML (không redirect); Phase 2 → redirect OAuth error (error/description/state/iss RFC 9207).
- **Bug đã sửa trong run**:
  - Blocker #1 (senior REJECT #1): resume sau login không `consume()` context → 400. Fix: `AuthorizeService.resume(request_id)` + controller đọc `request_id` + 5 test HTTP-level.
  - Blocker #2 (senior REJECT #2, DEBT-024): resume Phase-2-fail → `buildErrorRedirect` đọc `params` HTTP (thiếu redirect_uri) → 500. Fix (Cách B): `AuthorizeRedirectError` mang `redirectUri`/`state` (gắn ở Phase 2), controller redirect từ error, không đọc `params`.
  - Test-infra: 5 int-spec treo vô hạn khi DB test down → thêm `retryAttempts:5`/`serverSelectionTimeoutMS:5000` (fail ~2s).
- **Verify (độc lập, chạy thật)**: typecheck/lint PASS; unit 67/67; int 166/166 (authorize 27/27). Tester bổ sung 2 test HTTP-level (AC8 response_type!=code, AC9 prompt=none) + assertion error_description. Tổng 233/233.
- **Vòng lặp**: tech-lead=1, dev=3, senior=3, tester=1.
- **Debt để lại**: DEBT-022 (gộp type Fastify req/reply → B4.2+). DEBT-015/019/020 xác nhận không áp dụng ở B4.1 (redirect GET, chưa wire CORS).