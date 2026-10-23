# Summary — run 49 A6.5 (M5, lane ADMIN) — ✅ PASS 5/5 task

- **Phạm vi**: T0 [BE] `AdminKeyViewDto`/`KeyListViewDto`/`RotateKeyResultViewDto` + OpenAPI/snapshot, test chứng minh không lọt key material. T1 [FE] DEBT-346/347/348 (`/audit` Details có tên phân biệt, metadata tách namespace). T2 [FE] `signing-keys.ts` (list GET, rotate POST `{mode}` strict), zod strip; `server/auth/instance.ts` `cooldownDuration: 0` (JWKS tải lại ngay khi gặp kid mới — trước đó admin vừa rotate khẩn cấp có thể bị đăng xuất, E2E flaky). T3 [FE] `/keys`: bảng active/retiring, rotate thường (xác nhận + step-up), khẩn cấp (gõ `EMERGENCY` khớp chính xác, cảnh báo 5 ý đúng sự thật §6.4), uncertain không gửi lại, chỉ super_admin. T4 [E2E] rotate thường ⇒ K2 active/K1 retiring + JWKS; context B đăng nhập lại ngay; khẩn cấp chỉ mở/Cancel; skip khi `E2E_REUSE`.
- **Verify**: fe-admin 1206/1206, be 416 + int 1221, fe-sso-test 269, E2E 33/33 (×2 dev, ×1 tester), audit high 0, `gen:api` không diff; mutation RED; `be/keys` sha256/mtime không đổi; grep secret 0.
- **Commit**: `7ea8902`.
- **Vòng lặp**: tech-lead=1, BE dev=1, FE dev=2 (T1, T2–4), senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-346/347/348; mở 349, 350, 351 (BE webServer timeout lần đầu), 352 (ponytail), 353–355 (💭; 355 flaky root test). Sửa byte NUL trong backlog (DEBT-329).
- **Run 50**: A6.6 Dashboard (+ DEBT-352).
