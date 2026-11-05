# Tech Lead Review — 2026-11-03

## Kết luận: PASS

Fold bắt buộc ở `tasks.md` § Fold tech-lead (gốc đã xác minh bằng chạy thật, quyết định, điểm sửa, cách chứng minh, nhãn).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Hạ tầng test: dọn kết nối của boot full-app hỏng nằm ở một chỗ (`bootFullApp`), không rải vào từng spec; hậu tố DB dùng một helper (`withDbSuffix` trong `int-hooks.ts`) cho 3 chỗ suy DB; kiểm lộ token dùng một helper (`be/test/issued-tokens.ts`). Code sản phẩm chỉ có một refactor thuần (`createRedisClient`) để test giữ được tay cầm client Redis.

## Điểm mạnh

- Phạm vi nhỏ, đúng lane test-infra, không nới timeout/assert, không `retries`.
- DEBT-475 chạy được Vault/Sentinel thật: sentinel đã sạch (chỉ gỡ cờ); vault treo do đúng một ca (V7 vault-transit) và gốc nằm ở `full-app.ts`, không phải ở provider Vault. Bằng chứng: probe handle (13 socket Mongo + 1 Redis) và chạy riêng V7 so với V8.
- DEBT-203 tái hiện được: tệ hơn backlog ghi (cả "một spec" cũng đỏ với `admin-target-risk`, và `b74-tester` hỏng theo lý thuyết vì nhiều app lồng nhau).

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có (PASS). Các điểm task để ngỏ đã chốt trong fold:
- [x] DEBT-475: làm (không hoãn); sửa gốc ở `bootFullApp` catch khi `compile()` ném (Mongo `mongoose.connections` mới + client Redis ghi qua override `REDIS_CLIENT`), rồi gỡ `--forceExit` ở cả hai script.
- [x] DEBT-203: không làm helper cho 37 spec; sửa 3 chỗ (full-app mỗi app một DB, `admin-target-risk:334`, `indexes:147` qua `withDbSuffix`) rồi đóng chấp nhận "override chỉ cho MỘT file spec"; câu ở `ci.yml` cập nhật; guard run 64 giữ nguyên.
- [x] DEBT-453: 11 dòng trong 4 file đã liệt kê; ghi nhận JWT ở `provider.signJwt` (gán thuộc tính, không `jest.spyOn`, để `restoreAllMocks` không gỡ), so mọi dạng (rõ, chữ ký, base64, base64url), giữ kiểm tên khoá, thêm kiểm không-rỗng; FE: `fake-idp.issued`.
- [x] Security: trust boundary = dữ liệu test của lượt chạy. Invariant: không drop DB ngoài `vg-int-*`; kiểm lộ token không yếu đi. Test âm: mutation lộ token ở log/body/audit/trang lỗi/viewer ⇒ RED; override tên không `vg-int-*` vẫn bị từ chối.

## Đề xuất (không bắt buộc)

- DEBT-477 (mới): cùng mẫu `eyJ` ở 8 file khác (BE + `fe-admin/test/log-canary.test.ts`), dùng lại helper của run này khi chạm.
- Ghi nhận cho orchestrator: lúc review chỉ còn 4 DB `vg-int-*` trên `vg-test-mongo` (run 64 ghi 610 orphan). Tech-lead không chạy `drop-int-orphans.mjs`; mốc "+0 DB" của run này lấy số đếm lúc bắt đầu chạy.
