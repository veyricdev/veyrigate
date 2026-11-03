# Tech Lead Review — 2026-11-03

## Kết luận: PASS (kèm fold bắt buộc trong `tasks.md` § "Fold tech-lead")

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Chỉ đụng test infra BE, không đổi code sản phẩm.
- Thêm `be/test/int-hooks.ts`, chỉ import `mongoose`. File này chứa `INT_SETUP_TIMEOUT_MS`, `settled(setup)` và `dropIntDb(uri)` (từ chối tên không bắt đầu bằng `vg-int-`). `full-app.ts` dùng lại các hàm này và xoá `FULL_APP_BOOT_TIMEOUT_MS`, `closeFullApp` và hàm riêng `dropDatabase`.
- Mọi hook dùng một mẫu: `beforeAll(() => (setup = boot()), T)` / `afterAll: await settled(setup); await full?.close()`. Có 28 cặp hook trong 25 file (13 cặp ở 11 file full-app, 15 cặp ở 14 file nhẹ).
- DEBT-454: mỗi file `client-auth-rate-limit`, `authorize`, `demo` có một `afterAll` cấp file gọi `dropIntDb(MONGO_URI)`.
- DEBT-452/456: sửa script, không chỉ sửa tài liệu. Thêm `be/jest.int.config.js` để `test:int` chỉ còn `--config … --runInBand`.

## Điểm mạnh

- Phạm vi gọn, chỉ trong test infra, và nguồn debt rõ ràng. Có ràng buộc không nới timeout/assertion và không dùng `retries`.
- Dọn 610 DB cũ được tách thành việc của người dùng (cần duyệt), đúng chính sách không xoá dữ liệu.

## Vấn đề (đã xử lý bằng fold, không REJECT)

- [x] Gốc DEBT-454 ghi trong backlog chưa đúng. Không có thao tác ghi nào sau `dropDatabase` trong cùng một `describe`. Lỗi thật: `describe` thứ 2 cấp file dùng lại `MONGO_URI` (clrl :484, authorize :462, demo :333), dựng app với autoIndex và ghi vào DB, và không bao giờ drop. Vì vậy chuyển drop cũ sang chỗ khác không đủ, cần drop cấp file.
- [x] Gốc DEBT-452 là jest/yargs, không phải pnpm. `--testRegex` có `type: 'array'` và là cờ cuối của script, nên nó nuốt đối số vị trí (`--listTests`: 66 file, đúng ra 2). Dạng `--testRegex=` cũng bị. Thêm `--` còn tệ hơn: 1408 file. Đổi thứ tự cờ thì dễ vỡ lại, nên chọn dùng file config.
- [x] Plan gốc thiếu số đếm và AC đo được. Fold bổ sung: 28 hook, grep = 0, `--listTests` 2/53, `--showConfig` cho scalar, DB/keyDir +0, mutation M1–M3 có đối chứng RED.
- [x] M1 phải chứng minh được thứ tự `close-start ≥ seed-done`, không chỉ đếm DB. Lý do: với mẫu cũ, cửa sổ mồ côi hẹp nên đếm DB có thể không tái hiện được.

## Bảo mật / độ tin cậy

- Không chạm trust boundary của sản phẩm. Rủi ro chính là xoá nhầm dữ liệu. Có 3 lớp chặn:
  - `dropIntDb` từ chối tên ngoài `vg-int-`.
  - Script dọn chỉ chạy trên cổng 27117, dry-run mặc định, từ chối khi `vg:int-lock` đang bị giữ, và chỉ xoá DB có tên khớp regex timestamp cũ hơn 1 h.
  - Agent không được chạy `--yes`.
- Failure semantics: `settled` không bao giờ ném nhưng luôn log lý do. Nhờ vậy `afterAll` vẫn dọn được và lỗi của boot muộn không bị nuốt.

## Đề xuất (không bắt buộc) → backlog

- DEBT-470: `test:vault`/`test:sentinel` có cùng lỗi cờ mảng `--testRegex`/`--testTimeout`. Áp dụng file config tương tự khi chạm lại.
- DEBT-471: các spec nhẹ drop DB vô điều kiện, kể cả khi `TEST_MONGO_URI` trỏ tới một DB do người dùng chỉ định. `full-app` thì bỏ qua trường hợp này. Nên thống nhất: bỏ qua khi có `TEST_MONGO_URI`, hoặc dùng `dropIntDb` có guard tên.
