# Summary — introspect-hardening (DEBT-037/040/041/043/045/046) — ✅ PASS 4/4 task

- **Phạm vi**: `/introspect` kiểm quyền caller TRƯỚC liveness (đóng kênh timing, chứng minh bằng spy) + test cô lập nhánh `aud` (DEBT-040/041). Access token mang `sid` = `sessionRef` (cả nhánh code và refresh qua `RotationResult.sessionRef`); tombstone Redis `sess_end:{ref}` TTL accessTTL+60s ghi ở `revokeRef` + Lua revokeAll; `/introspect` + `/userinfo` phản ánh logout/thu hồi phiên tức thời, Redis lỗi → 500 (DEBT-037). `/token` authorization_code kiểm `EXISTS sess:{ref}` sau consume → code mint trước logout không đổi được (DEBT-043). Lint phủ `test/` + nit (DEBT-045/046). spec §8/§9.8/§11/§14/§15 cập nhật.
- **Quyết định**: Q-A `sid=sessionRef` (định danh, không phải quyền; không trả trong body introspect). Q-B chỉ phiên bị chấm dứt chủ động mới làm AT chết ngay; phiên tự hết hạn idle/absolute không giết AT (giữ `offline_access`). Q-C token không `sid` giữ hành vi cũ. DEBT-044 hoãn.
- **Senior**: PASS lượt 1, 5 mutation đều bị test bắt.
- **Verify**: typecheck/lint (src+test) PASS; unit 127/127; int 379/379 → **506/506**.
- **Commit**: `70842e0`.
- **Vòng lặp**: analyst=1, tech-lead=1, dev=1, senior=1 (PASS), tester=1.
- **Debt**: mở DEBT-047..054 — **DEBT-050 ưu tiên cao** (reset mật khẩu không thu hồi refresh family, có từ trước), 051 (race `/token` exists↔insert), 052 (ngữ nghĩa tombstone khi phiên rotate/hết absolute), 053 (spec dòng trùng), 054 (flake open-handle int suite).