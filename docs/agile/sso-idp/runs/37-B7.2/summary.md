# Summary — run 37 B7.2 + DEBT-215 (M7) — ✅ PASS 4/4 task

- **Phạm vi**: T1 `prom-client@15.1.3`, `GET /metrics` chỉ khi đặt `METRICS_TOKEN` (≥32, Bearer so timing-safe, 401 body rỗng, no-store), histogram `sso_http_request_duration_seconds{method,route,status_class}` (route template / `__unmatched`). T2 `sso_audit_events_total{action,result}` (sau khi ghi audit thành công), `sso_signing_key_rotations_total{mode,result}`, `sso_token_endpoint_errors_total{endpoint,error}`, khởi tạo series 0. T3 `ops/prometheus/alerts.yml` (4 rule), `alerts.test.yml`, `ops/grafana/dashboard.json`, `ops/README.md`, test đối chiếu metric/label với registry thật. T4 DEBT-215: refresh bị từ chối sau rotate ⇒ gỡ `replacedBy` sau khi revoke thành công ⇒ replay không báo reuse giả.
- **Verify**: BE unit 351/351, int 1012/1012, FE 240/240, E2E 16/16; mutation RED (dev + 6 tester). promtool chưa chạy (DEBT-219).
- **Commit**: `9a37dbf`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1, tester=1 (1 lần ngắt do lỗi mạng, resume) — không REJECT.
- **Debt**: đóng DEBT-215/222; mở DEBT-218–221, 223, 224 (prom-client deprecated → `@prometheus-io/client` ở B7.3/B7.4).
- **Người dùng**: muốn bật `/metrics` ở dev thì thêm `METRICS_TOKEN` (≥32 ký tự) vào `be/.env`.
