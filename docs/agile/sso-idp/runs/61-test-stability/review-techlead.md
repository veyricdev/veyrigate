# Tech Lead Review — 2026-10-28

## Kết luận: PASS

Một run, 5 task. Chi tiết thực thi nằm ở mục "Fold tech-lead (2026-10-28)" cuối `tasks.md` (ƯU TIÊN hơn text phía trên). Đánh số giữ của orchestrator: Task 1 DEBT-448, Task 2 DEBT-450, Task 3 DEBT-432; thêm Task 4 DEBT-206, Task 5 DEBT-096.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc sản phẩm; chỉ hạ tầng test. Không chia sẻ một app giữa các file test (Jest ESM tạo module registry riêng mỗi file; muốn chia sẻ phải dựng app ở process riêng và gọi qua HTTP — quá lớn, loại). Sửa ở chỗ gây dây chuyền + một hằng số ngân sách boot đo được.

## Điểm mạnh

- Mục tiêu đúng: không nới assertion, không retry, không nâng timeout toàn cục.
- Các debt cùng một vùng (int infra) gom một run, có thứ tự phụ thuộc rõ.

## Vấn đề (đã fold, không cần analyst sửa)

- [x] tasks.md chưa có nguyên nhân gốc. Đã xác minh:
  - **DEBT-448**: số đo của tech-lead (máy rảnh, 28 lõi): boot full-app ~15,8–16,4 s khi cache ấm, 30,9 s với `--no-cache`. Gốc làm lỗi lan ra là **app mồ côi**: `beforeAll` hết giờ thì `full` chưa được gán, nên `afterAll` (`if (full) await full.close()`) bỏ qua, trong khi `bootFullApp` vẫn chạy tiếp ở nền, giữ kết nối Mongo/Redis, không drop DB, không xoá keyDir, chạy song song với các suite sau trong cùng process `--runInBand`, và `--forceExit` che đi. `bootFullApp` ném lỗi giữa chừng cũng không tự dọn. Cả hai sự cố run 59/60 xảy ra ở lượt full **ngoài ý muốn**, vì đối số vị trí của `test:int` không lọc (DEBT-452).
  - **DEBT-450**: `raw` có khoảng 180 ký tự base64url ngẫu nhiên, nên xác suất chứa `eyJ` khoảng 1/1 400 mỗi lượt. Không thể bỏ hẳn `eyJ` vì nó còn bắt trường hợp "base64 của JSON" (`{"` mã hoá ra `eyJ`). Bản thay thế phải giữ ý nghĩa đó: giải mã từng đoạn base64url và có mutation M2.
  - **DEBT-432**: `Lab.tsx` chỉ `setSteps` sau khi cả 3 lượt `/token` tuần tự xong, nên `step-1` với timeout 5 s thực chất phải chờ cả chuỗi. Sửa bằng cách chờ có điều kiện vào `lab-replay-steps`.
  - **DEBT-206**: heartbeat bỏ qua kết quả 0. Fold yêu cầu mất lock thì `test:int` phải exit ≠ 0, không chỉ warn.
  - **DEBT-096**: không cùng gốc với DEBT-448 nhưng bị nó khuếch đại (app mồ côi). Làm sau Task 1, có điều kiện thoát rõ: gỡ `--forceExit` chỉ khi 3 lượt tự thoát; không đạt thì giữ lại và ghi bằng chứng.
- [x] Thiếu cách chứng minh ổn định. Đã thêm: tải CPU giả lập (worker_threads, không chạm Docker) đủ làm chậm ≥ 2×; chạy lặp N lần (7 suite × 3 dưới tải; full int 2 lượt rảnh + 1 lượt dưới tải; session-store 50 lượt + 10 000 mẫu; E2E `--repeat-each=10` cả lúc rảnh lẫn dưới tải); mutation cho từng task.
- [x] Ràng buộc timeout: chỉ một hằng số `FULL_APP_BOOT_TIMEOUT_MS` cho hook boot, giá trị suy từ số đo; timeout thân test chỉ nâng từng test khi có số đo kèm chú thích.

## Security gate (trust boundary)

Không chạm trust boundary của sản phẩm. Phần liên quan bảo mật là **độ mạnh của assertion**. Task 2 làm assertion chặt hơn (theo token cụ thể, base64/base64url, giải mã đoạn, cấu trúc khoá) và có 3 mutation. Int/E2E không đổi assert bảo mật nào. Task 4: một lượt mất lock độc quyền thì fail-closed (exit ≠ 0) thay vì im lặng; chỉ chạm key `vg:int-lock`, có so sánh giá trị.

## Đề xuất (không bắt buộc)

- DEBT-452: sửa hoặc ghi rõ cách lọc `test:int` (`--testPathPatterns`) để không vô tình chạy full khi máy đang tải.
- DEBT-453: các assert `not.toContain('eyJ')` trên log/body ở `run54-tester`/`debt388-sign-before-commit` hiện chưa flaky (body/log xác định), nhưng sẽ dễ flaky nếu sau này log thêm id base64url ngẫu nhiên. Khi chạm lại thì chuyển sang so token cụ thể.
- Sau run này, áp cùng mẫu `closeFullApp` cho `.vault-spec.ts` (DEBT-412) khi có Vault để chạy.
