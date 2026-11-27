# Summary — DEBT-694 + DEBT-715 (M8, deps/FE) — ✅ PASS 3/3
- Phạm vi: T1 fe-admin `@tanstack/react-start` 1.168.61 → 1.169.5 + `@tanstack/react-router` 1.170.42 → 1.170.46 (1.169.6/7 < 14 ngày); T2 gỡ ignore TanStack trong `dependabot.yml`, bỏ override seroval; T3 flake `run71-tester` (DEBT-715).
- Commit: `1e6c6f2` (code, CI #82 9/9 xanh), docs close riêng.
- Breaking đã xử lý: `inputValidator` → `validator` (25 chỗ); `getResponseHeaders()` giờ read-only ⇒ Set-Cookie xoá/refresh phiên qua `appendResponseHeader`, `no-store`/`pragma` qua `setResponseHeader` (viewer.ts, admin-api/instance.ts); h3 bị gỡ ⇒ viết lại `protocol-relative-risk.test.ts` theo pipeline 1.169 (8 case, không skip); guard `//` giữ nguyên.
- Khoá runtime thật: 2 E2E mới (SSR 307 + xoá `fea_sid`, RPC `/_serverFn` xoá `fea_sid`) + assert `pragma: no-cache` ở secrets; mutation bỏ helper ⇒ đỏ.
- DEBT-715: so khớp bí mật trên body đã khử UUID/ObjectId + tripwire đếm; 20/20 lần xanh, mutation mask Teredo ⇒ đỏ.
- Gate: frozen lockfile + audit sạch, typecheck ×4, lint, be 1361, fe-admin 1669, fe-sso-test 269, image smoke 18/18, int 2526, E2E 55, X3 42, pentest on/off must 269/269, mutations 7/7. CSRF `/_serverFn` cross-site 403 kiểm thêm trên runtime 1.169.5.
- Lệch nhỏ: D101.7 ghi image smoke có check `/_serverFn` 403 nhưng `docker-smoke.sh` không có — được phủ bởi `csrf-wiring.test.ts` + kiểm tay của tester; không mở DEBT.
- Đóng: DEBT-694, DEBT-267, DEBT-228, DEBT-715. Mở: DEBT-717 💭 (srvx 0.11 vs 1.0), DEBT-718 💭 (override prettier của router-generator).
- ⚠ Deploy: build lại image fe-admin; không đổi env/RP. Dependabot sẽ mở PR TanStack khi bản mới đủ 14 ngày.
