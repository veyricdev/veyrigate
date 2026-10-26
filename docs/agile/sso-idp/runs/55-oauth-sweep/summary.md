# Summary — run 55 sweep debt bảo mật OAuth (M7, lane BE) — ✅ PASS 4/4 task

- **Phạm vi**: T4 DEBT-410 `listKeys` lỗi mạng/timeout/5xx/429 ⇒ 503 (`rotate` giữ 500 + audit `rotate_failed`). T2 DEBT-177 `isAccessTokenLive(…, adminAud)`: AT `aud=admin` của client không còn admin-capable ⇒ không live ở `/introspect`/`/userinfo`/demo/`AdminTokenGuard`; AT aud thường không bị chặn. T3 DEBT-216 refresh `recheck(userId, result.resource)` kiểm resource với client đọc lại ⇒ `invalid_grant` + revoke family + audit `resource_not_allowed`, không reuse giả. T1 DEBT-123/130 consent context gắn `sessionRef`; `decideConsent`: consume → kiểm client/redirect_uri mọi nhánh → kind → session (trước deny) → deny → …; `resume` reauthAfter kiểm client/URI; lỗi ⇒ trang 400 không lộ `state`.
- **Giữ nguyên run 54** (ký trước commit; peek/consume/rotate/Lua không đổi; test run 54 không đổi kỳ vọng). DEBT-409 tách ra (X6, không phải lỗ hổng).
- **Verify**: be unit 587, int 1306 (18 dev + 21 tester: transplant approve/deny/song song/sau logout, step-up URI bị xoá, client hạ cấp, race rotate), vault 31, fe-admin 1416, fe-sso-test 269, E2E 35/35, audit high 0; mutation 12 + 10 RED; Vault tạm đã dọn; không kill process.
- **Commit**: `c3ed4f0`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-123/130/177/216/410; mở 413 💭 (login context chưa gắn trình duyệt), 414 🟢 (test cũ có assert điều kiện lỗi thời), 415 💭 (refresh sau khi bỏ resource không revoke family — cần quyết định chủ đích).
