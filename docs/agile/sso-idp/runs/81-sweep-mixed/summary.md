# Summary — run 81 sweep 🟡 hỗn hợp (M7, lane BE + FE + E2E) — ✅ PASS 4/4 task

- **Phạm vi**: T1 DEBT-413 — cookie binding `idp_authz`/`__Host-idp_authz` (HttpOnly, Lax, Path=/, Max-Age 600, chỉ set khi `login_required`, không xoay); context `login` lưu `bindingHash`=sha256, Lua `authzCtxConsumeLogin` so trước khi xoá; thiếu/sai binding ⇒ 400 "Request expired", giữ context nạn nhân; Redis down ⇒ 503; runbook-deploy §11 thêm 1 dòng. T2 DEBT-532 — `validateResourceFormat` 2 câu cố định. T3 DEBT-323 — PATCH resource `{scopes, expectedScopes?}`, điều kiện trong filter `findOneAndUpdate` nguyên tử, lệch ⇒ 409 `conflict` câu cố định, không ghi/không audit; fe-admin luôn gửi `expectedScopes` (đọc draft lúc lưu, lấy lần lưu thành công gần nhất), 409 ⇒ đọc lại + "Currently saved". T4 DEBT-527 — E2E audit tránh giây 00.
- **Verify**: be 806, int FULL 1677/1677 (`vg-int-*` 4→4), fe-admin 1589, E2E 38, X3 42. Tester +46 ca int (`run81-tester`): binding chéo tenant/chéo trình duyệt, 15 giá trị cookie lạ ⇒ 400 không 500, 3 tab dùng chung, replay, Secure bỏ qua `idp_authz` trần, không lộ binding trong log/audit; 18 `expectedScopes` xấu ⇒ 400, 7 kiểu lệch ⇒ 409 không lộ scopes, 12 PATCH song song ⇒ đúng 1 thắng; 17 đột biến đều làm đỏ.
- **Lệch fold**: X3 ca 1 ô WebKit cross-site chỉ ghi lại (Playwright WebKit-Windows báo header Cookie rỗng, kể cả `__Host-idp_session`; BE là oracle) — senior chấp nhận, DEBT-535/536 🟡.
- **Commit**: `6ccf410`.
- **Vòng lặp**: tech-lead=1, BE dev=1, FE dev=1 (+1 E2E/X3), senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-323/413/527/532; mở DEBT-533/534 (tech-lead), 535 (FE), 536 (senior), 537/538 (tester).
- **⚠ Deploy**: login đang dở lúc deploy (≤ 10 phút) gặp "Request expired" ⇒ bắt đầu lại từ RP.
