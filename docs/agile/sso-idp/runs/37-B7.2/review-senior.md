# Senior Review — 2026-10-20 (run 37, B7.2 observability + DEBT-215)

## Kết luận: PASS

Không có 🔴. Có 2 mục 🟡 không chặn, ghi vào backlog là DEBT-223 và DEBT-224.

## Tổng quan

Diff gọn, bám sát fold M0–M9. Những điểm làm tốt:
- `/metrics` fail-closed: không đặt token thì không đăng ký route (404). Khi có token, so SHA-256 bằng `timingSafeEqual` nên hai vế luôn dài bằng nhau, không lộ độ dài. Chỉ nhận header `Bearer`, token qua query bị 401. Mọi 401 đều có body rỗng, có `Cache-Control: no-store`. Lỗi registry trả 500 với body rỗng.
- Label hữu hạn. `route` lấy template (`routeOptions.url`) hoặc `__unmatched`, method lạ thành `OTHER`, status chỉ theo lớp. `observeAuditEvent`/`observeTokenError` bỏ qua giá trị ngoài tập cho trước (đã có test chống series mới). Int-spec kiểm cả phần lộ dữ liệu: email, clientId, IP, userId, RT, familyId, tenant đều không xuất hiện.
- Metrics không làm hỏng luồng chính. Cả hai lời gọi đều bọc try/catch và log. Counter audit chỉ tăng **sau** `auditModel.create`, có test chứng minh audit lỗi thì counter +0 và counter throw thì grant vẫn 200.
- Mọi series hữu hạn được khởi tạo bằng 0 (M4), nên `increase()` thấy sự kiện đầu tiên. Int-spec chứng minh 0 → 1 bằng sự kiện thật (reuse, rotation khẩn cấp).
- `ops-rules.spec.ts` đối chiếu tên metric, label và giá trị label trong rule/dashboard/promtool-test với output thật của registry. Đây là lưới tốt trong lúc chưa có promtool.
- DEBT-215 được xử lý đúng chỗ, có test cả hai chiều (unlink khi revoke OK, giữ link khi revoke lỗi).

Đã chạy (foreground):
- `pnpm -C be typecheck`: sạch. `eslint` trên các file đổi: sạch.
- `pnpm -C be test`: 351/351.
- `pnpm -C be test:int` cho `metrics`, `token-code-recheck`, `refresh-token`: 113/113.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| `/metrics` khi tắt | Không đăng ký route, 404 cả khi có bearer (int-spec `without METRICS_TOKEN`). |
| Auth `/metrics` | Thiếu header, sai token cùng độ dài, token trong query, scheme Basic, bearer có thêm giá trị: tất cả 401, body rỗng. So sánh digest SHA-256 timing-safe. Token ≥ 32 ký tự được ép ở `envSchema`, chuỗi rỗng thành `undefined`. Brute-force token ngẫu nhiên 32+ ký tự không khả thi nên việc thiếu rate limit không phải vấn đề. |
| Lộ dữ liệu | Không có label định danh. Annotation alert không template label (spec có assert). Thông báo lỗi 500 không đưa chi tiết vào body. |
| Cardinality | `route` lấy template hoặc `__unmatched`. Path lạ và ObjectId không vào output (int-spec). CORS preflight được hook `onRequest` trả lời trước route nên rơi vào `__unmatched`, không làm loãng `route="/token"`. |
| Failure behavior | Lỗi metrics không đổi response. Audit lỗi thì không đếm và request vẫn fail-closed như cũ. Hạn chế đã biết: alert reuse im khi Mongo chết đúng lúc đó (DEBT-218); lúc ấy alert 5xx là lưới an toàn. |
| Nhãn lỗi `/token` | Khớp với response thật: 429 thành `temporarily_unavailable`, `TokenError.code` giữ nguyên, còn lại `server_error` (cùng nhánh 500). `FormParseError` đã được đổi thành `TokenError('invalid_request')` trước khi tới `renderError`. |
| DEBT-215: reuse thật vẫn báo | `classifyMiss` = `revokedAt && replacedBy`. Unlink chỉ chạm đúng doc `rotatedFromId` mà chính request này vừa swap (single-winner). Một replay song song **trước** unlink vẫn bị phân loại reuse và revoke family. Reuse ở các doc/family khác không bị ảnh hưởng. |
| DEBT-215: revoke lỗi | Không unlink. Replay sau đó vẫn quét successor còn sống qua reuse (test mới `re-check DB error AND revokeFamily throws`). |
| DEBT-215: tính tương đương của lệch fold | Lọc `replacedBy: {$ne:null}` thay vì `replacedBy: successorId` là tương đương. Doc cũ đã `revokedAt` nên không đường nào khác ghi lại `replacedBy`, và giá trị duy nhất có thể có là successor của chính request này. Chấp nhận. |
| `reply.elapsedTime` (lệch fold) | API chuẩn của Fastify 5 trong `onResponse`, đơn vị ms nên chia 1000. Chấp nhận. |
| Alert semantics | `increase(...[5m]) > 0` trên series khởi tạo 0: đúng. Mọi rule bọc `sum(...)` nên đúng khi chạy nhiều instance. Thứ tự ưu tiên PromQL của `a / b > 0.25 and c > 0.1` là `(a/b > 0.25) and (c > 0.1)`, cả hai vế không có label nên `and` khớp. |

## 🟡 Nên sửa (không chặn)

🟡 **[ops] `SsoHttp5xxRatioHigh` thiếu ngưỡng traffic tối thiểu, mà lại là critical** (DEBT-223)
`ops/prometheus/alerts.yml` (rule `SsoHttp5xxRatioHigh`): tỉ lệ 5xx không có điều kiện traffic như `SsoTokenErrorRatioHigh`.
Vì sao: IdP lúc thấp điểm chủ yếu chỉ có scrape `/metrics` (khoảng 0.067 req/s mỗi instance) và health probe. Chỉ vài 5xx trong 5 phút đã vượt 5%, mà range `[5m]` lại giữ tỉ lệ cao đúng 5 phút, sát với `for: 5m`, nên dễ page critical giả. Ngược lại, traffic của scrape/health còn làm loãng mẫu số.
Đề xuất: thêm `and sum(rate(sso_http_request_duration_seconds_count[5m])) > 0.1` (cùng mẫu với rule `/token`) và cân nhắc loại `route="/metrics"` khỏi cả tử lẫn mẫu. Thêm một case promtool cho traffic thấp, và `ops-rules.spec` tự kiểm được nhờ đã đối chiếu matcher.

🟡 **[BE] DEBT-221: điều kiện chuyển sang `@prometheus-io/client` đã đạt** (DEBT-224)
`be/package.json`: `prom-client@15.1.3` deprecated, npm trỏ sang `@prometheus-io/client`. Tra registry hôm nay: `latest` = `0.16.1` (phát hành 2026-08-27, khoảng 8 tuần), `engines.node ^22 || ^24 || >=26` (be chạy 22.22.3), deps `@opentelemetry/api` và `tdigest` (cùng bộ với prom-client 15).
Đánh giá: **giữ prom-client trong run này** là hợp lý. Deprecated không có nghĩa là có lỗ hổng, hiện chưa có CVE, và đổi package nằm ngoài phạm vi review (không được cài). Tuy vậy, mốc "bản ổn định ≥ 2 tuần" ghi trong DEBT-221 đã thỏa. Package còn ở 0.x (dù là bản kế thừa) và chưa được kiểm API ở repo này, nên chưa đổi ngay.
Đề xuất: lên lịch một bước nhỏ ở B7.3/B7.4: cài exact `@prometheus-io/client@0.16.1`, đổi import trong 3 file `be/src/common/metrics/*` cùng `import type { Counter }` ở `test/metrics.int-spec.ts`, rồi chạy `metrics.spec`, `ops-rules.spec`, `metrics.int-spec`. Content-type `version=0.0.4` đang có assert sẽ bắt mọi thay đổi định dạng exposition. Nếu API lệch nhiều thì giữ prom-client và theo dõi CVE.

## 💭 Nit

- 💭 `SsoTokenReuseDetected` mất tín hiệu ở một kịch bản hẹp: sau một lần refresh bị từ chối (family đã chết, đã unlink), kẻ tấn công replay token cũ thì chỉ nhận invalid_grant, không có alert. Không có bypass vì family đã chết. Đây là đánh đổi chủ ý của DEBT-215, chỉ ghi nhận, không cần debt.
- 💭 Nhánh `metrics.http.ts` (onResponse) có thể được gọi nhiều lần trong cùng process (mỗi app test một lần). Cờ `defaultMetricsStarted` đã chặn default metrics trùng; hook latency gắn theo từng instance Fastify nên không đếm đôi. OK, chỉ ghi chú.

## ✂️ Ponytail

- be/src/common/metrics/metrics.ts:L79: yagni: guard `if (!isOneOf(TOKEN_ENDPOINTS, endpoint)) return;` thừa vì tham số đã có kiểu `TokenEndpoint` và chỉ 2 call site với literal. Xóa dòng.
- be/src/modules/oauth/token/token.controller.ts:L459: shrink: try/catch quanh `observeTokenError` (label đã lọc, `inc` không throw trong thực tế). Có thể bỏ, nhưng M-fold yêu cầu "không bao giờ throw vào response" nên giữ cũng được. Không bắt buộc.
- be/src/common/metrics/ops-rules.spec.ts: không cắt. Mini-parser PromQL (~40 dòng) đang thay promtool (Q-37.3). Khi DEBT-219 đưa promtool vào CI thì thu gọn còn phần đối chiếu tên metric/label.

net: -1 lines possible (thêm tối đa -4 nếu bỏ try/catch). Lean already. Ship.
