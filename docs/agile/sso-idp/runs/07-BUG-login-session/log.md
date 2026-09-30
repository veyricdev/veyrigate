# Log — run 07 (BUG-login-session)

## [2026-09-30] orchestrator — mở run 07
- Đã làm: ghi nhận thiết kế bounded đã duyệt; tạo task bugfix guest route/session.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE
- Bàn giao: tech-lead — review task và tiêu chí nghiệm thu.

## [2026-09-30] tech-lead
- Đã làm: CodeGraph sync; review `tasks.md` với spec §9.6, plan B2.5, code session/UI và test hiện tại.
- File đổi: `review-techlead.md`, `log.md`, `STATUS.md`.
- Kết quả: REJECT — thiếu fail-closed khi Redis lỗi, ma trận session/redirect-loop và acceptance test đo được.
- Bàn giao: analyst — sửa các checklist bắt buộc trong `review-techlead.md`, rồi gửi review lại.

## [2026-09-30] analyst
- Đã làm: làm rõ absent/live/stale/error semantics; bổ sung ma trận 9 tổ hợp, cookie-clear, redirect-loop và gate RED/GREEN/Redis thật.
- File đổi: `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: DONE — giữ phạm vi ba GET route; không sửa spec/plan/source hoặc các route ngoài phạm vi.
- Bàn giao: tech-lead — review lại acceptance và thiết kế bounded của run 07.

## [2026-09-30] tech-lead
- Đã làm: CodeGraph sync; đối chiếu task sửa với spec §9.6, plan B2.5, UI/session code và test hiện tại.
- File đổi: `review-techlead.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — đủ fail-closed, ma trận 9 case, clear-cookie, chống loop và gate RED/GREEN.
- Bàn giao: backend-dev — triển khai tuần tự Task 1–5, giữ đúng phạm vi ba GET route.

## [2026-09-30 11:27] backend-dev
- Đã làm: TDD ma trận session cho 3 GET; fail-closed/clear-cookie/no-loop; kiểm Redis thật.
- File đổi: `ui.controller.ts`, `ui.int-spec.ts`, `ui-auth.int-spec.ts`, `tasks.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — RED 11 fail/25 pass đúng hành vi thiếu; GREEN focused 36/36, unit 48/48, int 89/89.
- Bàn giao: senior-reviewer — review fix bounded; xác nhận không đổi verify/reset/forgot/consent/logout.

## [2026-09-30] senior-reviewer
- Đã làm: CodeGraph sync; review ma trận session, fail-closed, cookie clear, redirect loop, regression và RED/GREEN evidence.
- File đổi: `review-senior.md`, `log.md`, `STATUS.md`.
- Kết quả: REJECT — stale `/login`/`/register` ký CSRF bằng session cookie vừa clear, khiến form kế tiếp submit 403.
- Bàn giao: backend-dev — sửa identity cho stale guest form và thêm GET-stale → POST integration regression.

## [2026-09-30 11:36] backend-dev
- Đã làm: thêm GET stale → áp dụng clear-cookie → POST regression cho login/register; xóa stale identity khỏi request sau clear.
- File đổi: `ui.controller.ts`, `ui.int-spec.ts`, `ui-auth.int-spec.ts`, `log.md`, `STATUS.md`.
- Kết quả: PASS — RED 2 fail/36 pass (403); GREEN 38/38; lint/typecheck/build PASS; unit 48/48; integration 91/91; diff-check PASS.
- Bàn giao: senior-reviewer — review blocker CSRF stale form; xác nhận live/absent/error, clear options và no-revoke giữ nguyên.

## [2026-09-30 11:40] senior-reviewer
- Đã làm: CodeGraph sync; re-review stale CSRF, ma trận session, fail-closed, no-revoke, redirect loop và regression.
- File đổi: `review-senior.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — focused 38/38; UI+Redis 41/41; unit 48/48; integration 91/91; lint/typecheck/build PASS.
- Bàn giao: tester — xác minh run 07 theo acceptance trong `tasks.md`.

## [2026-09-30 11:48] tester
- Đã làm: CodeGraph sync; xác minh ma trận/session-error/cookie/no-loop/stale-CSRF; thêm regression test-only cho 5 route ngoài phạm vi.
- File đổi: `be/test/ui.int-spec.ts`, `test-report.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — lint/typecheck/build; unit 48/48; integration 96/96; xem `test-report.md` case 1–8.
- Bàn giao: orchestrator — đóng run 07.

## [2026-09-30] orchestrator — đóng run 07
- Đã làm: xác nhận senior PASS và tester PASS; viết summary, cập nhật tiến độ.
- File đổi: `summary.md`, `log.md`, `STATUS.md`.
- Kết quả: PASS — 48 unit + 96 integration.
- Bàn giao: run 08 — B3.1–B3.4.