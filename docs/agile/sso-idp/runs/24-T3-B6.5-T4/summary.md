# Summary — run 24 T3 + B6.5 + T4 (M3) — ✅ PASS 5/5 task

- **Phạm vi**: T0 [BE] sửa so khớp `allowedResources` (resourceId) ↔ `aud`/`RefreshToken.resource` (URI) ở liveness, refresh (pre-check + rotate), introspect — fail-closed, giữ anti-oracle DEBT-040. T1 [BE] `GET /demo/me` (`DemoModule` qua `ConditionalModule`, chỉ `NODE_ENV` development|test, pin `aud` INV-8, CORS preflight) + seed resource `other`. T2 [FE] route `/login /profile /tokens /api-test /logout /error` + guard, `returnTo` validate khi ghi/đọc, không lộ token thô. T3 [FE] `/api-test` 3 nút (A `/demo/me`, B sai-aud INV-8 qua authorize `other` + khôi phục `prompt=none`, C `/userinfo`). T4 [BE] DEBT-100 — consent `other` 500.
- **Bug đã sửa**: tech-lead phát hiện refresh/userinfo/introspect hỏng với client đúng spec do so URI↔resourceId (fixture int-test che lỗi). DEBT-100: DB dev còn index unique cũ `userId_1_clientId_1` trên `consents` ⇒ E11000 ⇒ 500; fix ops `pnpm -C be db:sync-indexes` + int-test repro.
- **Verify**: BE unit 211/211, int 507/507, FE vitest 187/187; typecheck/lint/build sạch; mutation RED→khôi phục byte-identical ở từng call-site + FE probe.
- **Commit**: chưa commit.
- **Vòng lặp**: analyst=2, tech-lead=2 (REJECT → PASS), BE dev=2 (T0+T1, T4), FE dev=2 (T2, T3), senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-100; mở DEBT-098/099 (tech-lead), DEBT-101…106 (senior; **101/102 [FE] nên sửa trước E2E run 25**). DEBT-054 vẫn mở.
- **Run 25**: E2E (T4) + T5; chạy `db:sync-indexes` trên DB dev/E2E trước E2E nút B.
