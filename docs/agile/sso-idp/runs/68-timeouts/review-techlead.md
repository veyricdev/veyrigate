# Tech Lead Review — 2026-11-06

## Kết luận: PASS

Plan (= `tasks.md` + § Fold tech-lead) đủ để triển khai. Số đo, quyết định từng điểm, file/điểm sửa, cách chứng minh và nhãn ở § Fold của `tasks.md` (bắt buộc).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Chỉ cấu hình test (timeout webServer BE E2E, 3 timeout test int) + README E2E; không chạm code production.

## Điểm mạnh

- Đo trước khi quyết: webServer BE rảnh 68,5 s, dưới tải 28 luồng 104,1 / 104,3 s (2 lượt) so với limit 120 s (biên 1,15×) — tái hiện đúng gốc DEBT-464. Bước trội: `nest build` ~34–38 s, `start:e2e` (ts-node) ~41 s, `seed:e2e-admin` ~20 s.
- DEBT-455 đo lại cả hook (instrument scratch) lẫn test: 6/9 điểm đã ≥ 2× ⇒ đóng chấp nhận có số đo; chỉ 3 điểm < 2× được nâng (DEBT-161 1,8×, M3→M4 1,8×, `seed-risk` 10 vòng 1,9×).
- Không `retries`, không nới assertion, không giảm vòng/request.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Đã fold (dev phải làm đúng):
- [x] Chọn nâng `timeout` BE 120 → 320 s (≥ 3 × 104,3 s) thay vì `globalSetup` (chỉ dời thời gian) hay bỏ bước (mỗi bước có lý do: INV-23, seed của suite).
- [x] `TS_NODE_TRANSPILE_ONLY` (−7 s/bước ts-node) hoãn sang DEBT-480 vì chưa chứng minh Nest DI/decorator metadata khi transpile-only.
- [x] 3 timeout int theo ≥ 3× max dưới tải: 45 000 / 100 000 / 1 050 000; cập nhật comment `DEBT-448` bằng số đo run 68.
- [x] README E2E § What it runs đang lỗi thời ⇒ sửa cùng run.

## Security design gate

Không chạm trust boundary production. Tính chất bảo mật E2E (INV-23 `assert-dist-clean`, DB/redis E2E cách ly, không đọc `be/.env`) giữ nguyên — không bỏ bước nào của chuỗi webServer.

## Đề xuất (không bắt buộc)

- DEBT-480: thử `TS_NODE_TRANSPILE_ONLY=true` cho webServer BE E2E, rồi hạ timeout theo số đo mới.
- DEBT-481: đo tách drop vs seed mỗi vòng `seed-risk`, giảm chi phí dọn nếu drop trội.
