# ops — Prometheus / Grafana mẫu (B7.2)

Cấu hình mẫu cho observability của `be` (SSO IdP). Repo này **không** dựng Prometheus/Grafana; các file dưới đây để đội vận hành nạp vào hạ tầng của mình.

| File | Nội dung |
|---|---|
| `prometheus/alerts.yml` | Alert rules (group `sso-idp`) |
| `prometheus/alerts.test.yml` | Unit test cho rules, định dạng `promtool test rules` |
| `grafana/dashboard.json` | Dashboard mẫu, import vào Grafana và chọn datasource Prometheus |

## Bật `/metrics`

- Đặt `METRICS_TOKEN` trong env của `be`: ít nhất 32 ký tự ngẫu nhiên, sinh bằng `openssl rand -hex 32`. Để trống thì route `/metrics` không tồn tại (404).
- Endpoint chỉ nhận header `Authorization: Bearer <METRICS_TOKEN>`. Token qua query string bị từ chối (401), vì URL có thể bị ghi log.
- **Không** publish `/metrics` qua ingress/reverse proxy public. Chặn path này ở proxy và chỉ cho Prometheus scrape qua mạng nội bộ.

Scrape config:

```yaml
scrape_configs:
  - job_name: sso-idp
    metrics_path: /metrics
    scheme: http            # https nếu scrape qua TLS
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/sso-idp-metrics-token   # chứa METRICS_TOKEN
    static_configs:
      - targets: ['sso-idp:4000']
```

`METRICS_TOKEN` hiện là một giá trị tĩnh: đổi token cần cập nhật `be` và Prometheus cùng lúc (DEBT-220).

## Metric

Mọi label đều có tập giá trị hữu hạn. Không có label userId/sub, email, clientId, tenantId, IP, familyId, kid, reason, scope, resource hay path thô.

| Metric | Loại | Labels |
|---|---|---|
| `sso_audit_events_total` | Counter | `action` (AuditAction), `result` (success/failure) |
| `sso_signing_key_rotations_total` | Counter | `mode` (normal/emergency), `result` |
| `sso_token_endpoint_errors_total` | Counter | `endpoint` (token/revoke), `error` (mã lỗi OAuth) |
| `sso_http_request_duration_seconds` | Histogram | `method`, `route` (template, hoặc `__unmatched`), `status_class` (1xx…5xx) |
| `process_*`, `nodejs_*` | mặc định prom-client | — |

Mọi tổ hợp label hữu hạn của các counter được khởi tạo bằng 0 lúc khởi động. Nhờ vậy `increase()` thấy được ngay sự kiện đầu tiên.

Counter audit chỉ tăng **sau khi** audit đã ghi thành công. Nếu Mongo lỗi, sự kiện không lên metric (DEBT-218); khi đó alert 5xx là lưới an toàn.

### Ánh xạ yêu cầu (plan B7.2, spec #16 / §10) → metric

| Yêu cầu | Biểu thức |
|---|---|
| Số token phát hành | `sso_audit_events_total{action="TOKEN_ISSUED"}` (code grant), `{action="TOKEN_REFRESHED"}` (refresh), theo `result` |
| Lỗi `/token` | `sso_token_endpoint_errors_total{endpoint="token"}` theo `error` |
| Latency `/token` | `sso_http_request_duration_seconds{route="/token"}` |
| Reuse detected | `sso_audit_events_total{action="TOKEN_REUSE_DETECTED",result="failure"}` |
| Key rotation khẩn cấp | `sso_signing_key_rotations_total{mode="emergency"}` |
| Login thất bại / khoá | `sso_audit_events_total{action="AUTH_LOGIN_FAILED"}` / `{action="AUTH_ACCOUNT_LOCKED"}` |
| Thao tác admin nhạy cảm | `sso_audit_events_total{action=~"ADMIN_.*\|CLIENT_SECRET_.*\|REDIRECT_URI_CHANGED"}` |

## Alert

| Alert | Mức | Điều kiện |
|---|---|---|
| `SsoTokenReuseDetected` | critical | có reuse trong 5 phút |
| `SsoEmergencyKeyRotation` | critical | có rotation `emergency` thành công trong 5 phút |
| `SsoTokenErrorRatioHigh` | warning | lỗi `/token` > 25% trong 10 phút, khi traffic `/token` > 0.1 req/s |
| `SsoHttp5xxRatioHigh` | critical | 5xx > 5% trong 5 phút |

## Kiểm tra

- Trong repo, `pnpm -C be test` chạy `be/src/common/metrics/ops-rules.spec.ts`. Test này parse hai file YAML, kiểm cấu trúc rule, rồi đối chiếu mọi metric và cặp label dùng trong rule/dashboard với output thật của registry. `be/test/metrics.int-spec.ts` chứng minh series của alert reuse và emergency đi từ 0 lên 1 khi có sự kiện thật.
- Có `promtool` thì chạy thêm (tuỳ chọn, chưa đưa vào CI — DEBT-219):

```sh
promtool check rules ops/prometheus/alerts.yml
promtool test rules ops/prometheus/alerts.test.yml
```
