# Log — run 08 (BUG-logout-action)

## [2026-09-30] orchestrator — mở run 08
- Đã làm: tạo task bounded cho action logout; giữ GET chỉ xác nhận và POST+CSRF mới revoke.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE
- Bàn giao: tech-lead — review acceptance và security invariants.

## [2026-09-30] tech-lead
- Đã làm: review task với code/controller/template/test và guardrails logout, CSRF, escaping, CSP.
- File đổi: `review-techlead.md`, `log.md`, `STATUS.md`.
- Kết quả: REJECT — thiếu acceptance âm/đo được cho shared defaults, encoding, CSP và ma trận logout.
- Bàn giao: analyst — cập nhật `tasks.md` theo các mục bắt buộc trong review.

## [2026-09-30] analyst
- Đã làm: cụ thể hóa 5 task đo được cho home/shared outcomes, escaping/CSP và ma trận logout GET/POST.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE — đã xử lý toàn bộ mục bắt buộc trong tech-lead REJECT, không đổi spec/plan/source.
- Bàn giao: tech-lead — review lại run 08.

## [2026-09-30] analyst — vòng 1 hoàn thiện
- Đã làm: map từng acceptance tới case/lệnh cụ thể; giới hạn shared outcomes và redirect probes, tránh tích Descartes.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE — đủ home action, shared default, escaping/constants, CSP và logout trust boundary.
- Bàn giao: tech-lead — review lại `tasks.md`; không đổi spec/plan/source.

## [2026-09-30] tech-lead — review lại vòng 1
- Đã làm: xác minh code hiện tại và blocker cũ; shared default, Eta escaping, CSP, RED/GREEN đã đạt.
- File đổi: `review-techlead.md`, `log.md`, `STATUS.md`.
- Kết quả: REJECT — thiếu replay cross-identity, partial failure DB/Redis/audit và retry đo được.
- Bàn giao: analyst — bổ sung acceptance tối thiểu theo review; không sửa implementation.

## [2026-09-30] analyst — vòng 2
- Đã làm: thêm CSRF replay A→B; chốt failure injection get/revoke/audit và retry tuần tự đo được; bỏ DOM parser/concurrency claim.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE — acceptance bám thứ tự hiện có `get → revoke → audit → clear → redirect`; không đổi spec/plan/source.
- Bàn giao: tech-lead — review lại run 08.

## [2026-09-30] tech-lead — review vòng 2
- Đã làm: xác minh toàn blocker, replay A→B, failure get/revoke/audit, retry, no-DOM-dependency và bounded scope với code hiện tại.
- File đổi: `review-techlead.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — acceptance cụ thể, khả thi và security-first; không còn blocker triển khai.
- Bàn giao: backend-dev — triển khai Tasks 1–5 theo TDD, không mở rộng scope.

## [2026-09-30] backend-dev
- Đã làm: TDD action Sign out/default login; khóa Eta escaping/CSP và logout GET/POST, replay, failure, retry.
- Threat/invariant: session A/B + DOM; GET read-only, CSRF fail trước lookup/mutation, POST `get→revoke→audit→clear→redirect`; lỗi fail-closed, không lộ secret.
- File đổi: `ui.controller.ts`, `message.eta`, `ui.int-spec.ts`, `tasks.md`, `test-report.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — lint/typecheck/build; unit 48/48; integration 110/110; diff-check sạch.
- Bàn giao: senior-reviewer — review bounded diff run 08; giữ nguyên thay đổi chưa commit run 06/07.

## [2026-09-30] senior-reviewer
- Đã làm: review tasks/diff và trust boundaries; kiểm home/defaults, escaping/CSP, GET/CSRF replay, failure order, retry và redirect.
- File đổi: `review-senior.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — không có blocker/🟡; UI 57/57, UI-auth 3/3, unit 48/48, lint/typecheck/diff-check đều đạt.
- Bàn giao: tester — kiểm độc lập run 08.

## [2026-09-30] tester
- Đã làm: CodeGraph sync; kiểm độc lập toàn AC và risk matrix logout, CSP/escaping, CSRF replay, partial failure, retry, redirect/exposure.
- File đổi: `test-report.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — focused 15/15, unit 48/48, integration 110/110; lint/typecheck/build/diff-check exit 0; xem test-report.
- Bàn giao: orchestrator — đóng run 08.

## [2026-09-30] orchestrator — đóng run 08
- Đã làm: xác nhận senior/tester PASS; viết summary và cập nhật tiến độ.
- File đổi: `summary.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — 48 unit + 110 integration.
- Bàn giao: run 09 — B3.1–B3.4.