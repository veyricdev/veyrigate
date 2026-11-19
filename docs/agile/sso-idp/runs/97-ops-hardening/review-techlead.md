# Tech Lead Review — 2026-11-19

## Kết luận: PASS

Năm task đúng vấn đề, nhỏ, không cần analyst. Có điều chỉnh, ghi ở `tasks.md` mục "Quyết định D97.x" (D97.1–D97.26). Khi mô tả task khác D97.x, dev làm theo D97.x.

## Kiến trúc đề xuất (điều chỉnh)

**T3 DEBT-218, counter trước ghi audit**
- Sửa một chỗ: `AuditService.record` đếm trước `create` (D97.2).
- Counter mới `sso_audit_write_failures_total{action}` + alert `SsoAuditWriteFailed` (critical).
- INV-25 giữ nguyên: ghi audit lỗi vẫn 5xx.

**T2 DEBT-126, admin bị từ chối**
- Metric `sso_admin_auth_denied_total{reason}` (4 giá trị wire) ở `AdminAuthErrorFilter`.
- Audit `ADMIN_ACCESS_DENIED` chỉ khi token đã verify chữ ký (D97.8).
- Chặn DoS ghi Mongo hai lớp (D97.9):
  - dedupe Redis 15' theo sub+reason;
  - trần toàn cục 60 document/phút.
- Audit lỗi không đổi 401/403 thành 5xx.
- `step_up_required` chỉ metric, vì đó là luồng UX bình thường.

**T1 DEBT-072, trần toàn cục client auth**
- Bucket *thất bại* toàn cục theo client, refund khi thành công.
- Chặn DoS ngược: IP đã xác thực thành công cho client trong 7 ngày được miễn bucket toàn cục (D97.13).
- client_id không tồn tại gom vào một bucket `{unknown}`, nên không có key Redis theo input của kẻ tấn công.
- Ngưỡng 100 / 300 mỗi `RATE_LIMIT_WINDOW`.
- Thêm 2 script Lua nhỏ.
- Metric `sso_client_auth_rate_limited_total{scope}` + alert.

**T5 DEBT-618, alert `ADMIN_RECOVERED`**
- Đổi hướng: poll 60 s một aggregate `$max(timestamp)` trên index `{action:1}` có sẵn, thay vì change stream (D97.18).
- Gauge timestamp + alert `time() - max(gauge) < 1800`. Không trạng thái, an toàn khi restart và nhiều replica.
- Không thêm index, không cần replica set trong test.

**T4 DEBT-280, Redis fe-admin**
- Đổi hướng production: khuyến nghị Redis riêng (fe-admin không hỗ trợ Sentinel, DEBT-701).
- Code: production bắt buộc `rediss://` + username ACL khác `default`. Boot fail, chỉ in tên biến.
- Kiểm ACL bằng `ACL DRYRUN` trong runbook. Không dựng Redis trong CI smoke (DEBT-702).
- Smoke image thêm một check: env `redis://` ⇒ exit 1.

## Điểm mạnh
- Task đã nêu đúng hai rủi ro production chính: DoS ngược khi khoá theo client_id, và audit thành vector ghi Mongo. Cả hai đều có biện pháp đo được.
- Hạ tầng có sẵn đủ để làm gọn:
  - script reserve/refund atomic;
  - mẫu metric module-level;
  - `client-auth-rate-limit.int-spec` đã có `TRUST_PROXY` + XFF;
  - index `{action:1}` trên audit;
  - job CI promtool.
- Ràng buộc hạ tầng, secret, thứ tự E2E → harness, SMTP 220 giữ đúng các run trước.

## Vấn đề (bắt buộc sửa nếu REJECT)
- [x] Không có. Các điều chỉnh ở trên là quyết định fold, không phải lý do REJECT.

## Security design (cổng)
- **Tài sản / actor / trust boundary**:
  - T1: CPU Argon2 và tính sẵn sàng của RP hợp lệ, trước kẻ tấn công xoay IP;
  - T2: Mongo audit và tín hiệu dò quyền, trước người có hoặc không có token;
  - T4: key phiên IdP trong Redis, trước credential của BFF.
- **Abuse cases đã xét**:
  - DoS ngược T1 ⇒ miễn trừ nguồn đã thành công, rủi ro còn lại DEBT-704;
  - enumeration T1 ⇒ Argon2 vẫn luôn chạy, bucket unknown chung, response không đổi;
  - flood audit T2 ⇒ dedupe + trần;
  - stale/revoked token T2 ⇒ audit `not_live`.
- **Failure semantics**:
  - Redis lỗi ở trần T1 ⇒ 503 (fail-closed, như hiện tại);
  - Redis/Mongo lỗi khi audit T2 ⇒ vẫn 401/403 (request đã bị từ chối);
  - Mongo lỗi khi audit T3 ⇒ 5xx + counter;
  - poll T5 lỗi ⇒ gauge giữ, log warn.
- **Exposure**:
  - không label id; log chỉ `clientId` đã đăng ký, ≤ 1 dòng/cửa sổ;
  - audit không có token, route là template;
  - env lỗi fe-admin không in URL.
- **Test âm**: int (a)–(e) ở D97.11 và D97.17, test env-matrix ở D97.22.

## Đề xuất (không bắt buộc)
- DEBT-701: Sentinel cho fe-admin.
- DEBT-702: ACL Redis tự động ở CI.
- DEBT-703: TLS Redis cho IdP ở production.
- DEBT-704: allow-list IP egress theo client.
- Không sửa `backlog.md` lúc này. Orchestrator gộp khi đóng run.
