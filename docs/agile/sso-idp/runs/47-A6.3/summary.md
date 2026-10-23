# Summary — run 47 A6.3 (M5, lane ADMIN) — ✅ PASS 6/6 task (roles → 47b)

- **Phạm vi**: T0 [BE] 6 view DTO + `ApiOkResponse/ApiNoContentResponse` cho 10 operation users, seed user E2E riêng `e2e-user@example.com` (idempotent, không vai trò admin, guard `sso-idp-e2e`). T1 [FE] DEBT-326/328: helper chung `components/feedback/`, `pathIdSchema`. T2 [FE] server fns users (`listUsers` POST — email không vào URL/log/returnTo), zod allowlist. T3–T4 [FE] `/users`, `/users/$userId`: lock display (9999 = admin khoá, ISO), lock/unlock, revoke family/consent/global có xác nhận; gate: ẩn tự lock, tenant_admin vs target admin, `not_found` ẩn ghi; tự revoke ⇒ cảnh báo + `signInAgain()`; uncertain không tự gửi lại. T5 [E2E] lock ⇒ refresh bị từ chối + đăng nhập chặn ⇒ unlock ⇒ revoke family/global ⇒ refresh bị từ chối.
- **Tách phạm vi**: roles PATCH (escalation, DEBT-149/142) ⇒ run 47b (DEBT-335); federated identities/danh sách session BE chưa có (DEBT-334).
- **Verify**: fe-admin 1019/1019, be 414 + int 1210, fe-sso-test 269, E2E 31/31 (×2 dev, ×2 tester), audit high 0, `gen:api` không diff, check:bundle 0; mutation 14 + 3 RED; grep secret/email 0.
- **Commit**: (điền sau).
- **Vòng lặp**: tech-lead=1, BE dev=1, FE dev=2 (T1, T2–5), senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-326/328; mở DEBT-334–337 (tech-lead), 338 (families E2E tích luỹ), **339 🟡** (family uncertain mất thông điệp), **340 🟡** (cleanup E2E token hết hạn), 341 (ponytail).
- **Run 48**: A6.3b roles (cần analyst chốt DEBT-149/142) hoặc A6.4 Audit.
