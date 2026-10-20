# Log — run 37 — B7.2 observability (+ DEBT-215)

## orchestrator — 2026-10-20
- Tiếp M7. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B7 (B7.2), spec dòng 501 (#16 observability), §10 (alert actions) + DEBT-215 (reuse giả làm nhiễu alert). Cổng → tech-lead.

## tech-lead — 2026-10-20
- Preflight CodeGraph (1.6.2, sync). Đối chiếu `a80855b`: `AuditService.record`/`ALERT_ACTIONS`, `KeyRotationService.rotate` (`metadata.mode`), `TokenController.renderError/handleRefreshGrant`, `RefreshTokenService.rotate/recheckAfterRotate/classifyMiss/revokeFamily`, `configureApp`, `registerCorsPreflight`, logger serializer, `envSchema`. Int-spec dựng module bằng tay, không gọi `configureApp`. Node 22.22.3, fastify 5.12.5, không có promtool.
- **PASS** (`review-techlead.md`), fold M0–M9 vào `tasks.md`.
  - Q-37.1: bearer `METRICS_TOKEN` (unset ⇒ không có route), so sánh timing-safe, chỉ nhận header.
  - Q-37.2: gắn ở `AuditService.record` + `renderError` + hook `onResponse`; registry singleton, không DI.
  - Q-37.3: devDep `yaml@2.9.1` + Jest đối chiếu rule với `/metrics` + int 0→1; `alerts.test.yml` để sẵn cho promtool, không chạy.
  - Dependency: `prom-client@15.1.3` exact.
- Bắt buộc:
  - Khởi tạo series về 0; thiếu bước này thì `increase()` không bắn ở sự kiện đầu.
  - DEBT-215: chỉ mark `replacedBy:null` sau khi revoke family thành công, để giữ test DEBT-067.
  - Cắt counter/histogram trùng.
- Mở DEBT-218…220. Cổng → backend-dev.

## backend-dev — 2026-10-20
- Security (`/metrics`): tài sản = số liệu nghiệp vụ; actor hợp lệ = Prometheus giữ `METRICS_TOKEN`. Unset ⇒ không có route (404). Chỉ nhận header Bearer, so sánh `timingSafeEqual(sha256)`; query/Basic/sai ⇒ 401 body rỗng. Label hữu hạn (route template/`__unmatched`). `observe*` lỗi ⇒ nuốt + log. Counter chỉ tăng sau khi audit ghi xong.
- T1: `prom-client@15.1.3`, `yaml@2.9.1` (exact). `common/metrics/{metrics,metrics.http}.ts`; `registerMetrics` gọi trong `configureApp` + int; env `METRICS_TOKEN` (rỗng ⇒ undefined, ≥32), `.env.example`. Fastify 5 dùng `reply.elapsedTime`.
- T2: `observeAuditEvent` trong `AuditService.record`, `observeTokenError` ở đầu `renderError` (`endpoint` token/revoke). Khởi tạo series 0 (M4). `TokenErrorCode` nay suy ra từ `TOKEN_ERROR_CODES`.
- T3: `ops/prometheus/{alerts,alerts.test}.yml`, `ops/grafana/dashboard.json` (6 panel), `ops/README.md`, `ops-rules.spec.ts` (đối chiếu metric/label với registry + annotation trong promtool test). promtool KHÔNG chạy.
- T4 (DEBT-215): thêm `rotatedFromId`; unlink `replacedBy:null` chỉ sau khi revoke OK (lọc `replacedBy:{$ne:null}` thay vì so `successorId`: tương đương vì swap single-winner). Lật pin, thêm assert vào `expectRefreshRefused`, thêm case recheck lỗi + revoke lỗi ⇒ replay vẫn quét successor.
- Mutation (cp + sha256, đã khôi phục, khớp hash) đều RED: bỏ kiểm token, `request.url`, bỏ/đảo `observeAuditEvent`, bỏ try/catch, bỏ `observeTokenError`, đổi tên metric/label trong yml/json, bỏ init 0, bỏ unlink (2 nhánh), unlink trước revoke, unlink khi revoke lỗi.
- Verify: typecheck + lint sạch; BE unit 351/351, int 986/986 (39 suite); FE 240; E2E 16/16. Mở DEBT-221 (prom-client deprecated), DEBT-222 (`OTHER` chưa test); đóng DEBT-215. `be/.env` thật không đổi: muốn bật `/metrics` thì người dùng tự thêm `METRICS_TOKEN`. Cổng → senior-reviewer.

## senior-reviewer — 2026-10-20
- Preflight CodeGraph (sync). Review diff từ `a6658d5` (be/ + ops/), bỏ qua .github/.vscode/.mcp/.claude.
- Chạy: typecheck + eslint (file đổi) sạch; unit 351/351; int `metrics` + `token-code-recheck` + `refresh-token` 113/113.
- **PASS** (`review-senior.md`), không 🔴. Chấp nhận 2 lệch fold (`reply.elapsedTime`; `replacedBy:{$ne:null}` tương đương vì swap single-winner, doc cũ đã revoked).
- Invariant đã kiểm: `/metrics` 404 khi tắt, bearer timing-safe (digest SHA-256), không label định danh/cardinality cao (template/`__unmatched`; preflight rơi `__unmatched`), lỗi metrics nuốt an toàn, không đếm khi audit lỗi, nhãn lỗi `/token` khớp response, alert `increase` trên series 0 + `sum`, DEBT-215 không che reuse thật và giữ quét successor khi revoke lỗi.
- Mở DEBT-223 (alert 5xx thiếu ngưỡng traffic) và DEBT-224 (mốc chuyển `@prometheus-io/client` 0.16.1 đã đạt; giữ prom-client run này, đổi ở B7.3/B7.4). Ponytail: -1 dòng (guard endpoint thừa). Cổng → tester.

## tester — 2026-10-20
- Preflight CodeGraph (sync). Lượt đầu bị ngắt (ENOTFOUND) trước khi ghi báo cáo. Lượt này kiểm lại 4 file sản phẩm từng bị mutation: `sha256sum -c` OK (khôi phục bằng cp, không dùng git checkout).
- Thêm 26 test int:
  - `metrics.int-spec` (21):
    - credential: độ dài khác, malformed, scheme khác hoa thường ⇒ 200, header lặp qua inject và qua socket thật
    - `OTHER` (đóng DEBT-222)
    - route admin thật có id ⇒ template
    - cardinality 2 lô ⇒ 0 series mới
    - mọi AuditAction × result ⇒ đúng +1 chỉ ở series của nó
    - xoay khoá normal
  - `token-code-recheck` (5): DEBT-215 chạy song song (replay sau 500/400 ⇒ 0 reuse; reuse thật ⇒ vẫn revoke; concurrent first-use; race trước unlink).
- Mutation A/B/C/D/E/G: tất cả RED, khôi phục với sha256 khớp.
- Chạy thật: typecheck + lint sạch; unit 351/351; int FULL 1012/1012 (39 suite); FE 240/240; E2E 16/16.
- **PASS** (`test-report.md`). Đóng DEBT-222, không có 🟡 mới. Cổng → orchestrator đóng run.

## orchestrator — 2026-10-20 (đóng run)
- Mọi cổng PASS. Commit `9a37dbf`.
