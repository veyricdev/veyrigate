# Tech Lead Review — 2026-09-29 (B1.6–B1.10)

## Kết luận: **PASS**

Phạm vi khớp plan §5.B1 (B1.6–B1.10), không lấn B2+ (không service identity/session, không endpoint admin rotate). Phụ thuộc hợp lệ: B1.4/B1.2 đã xong ở run 03. Giả định A1–A6 hợp lý, không chạm câu hỏi mở §12 (Q6 chỉ ảnh hưởng giá trị TTL — đọc từ config, không hardcode).

## Kiến trúc đề xuất (dev làm theo)
- **Thứ tự**: B1.6 → B1.7 → B1.10 → B1.8 → B1.9 (B1.9 cần Audit để ghi `SIGNING_KEY_ROTATED`).
- **B1.6**: một file registry (`database/mongo/models.ts`) liệt kê `{name, schema}`; `MongooseModule.forFeature` và script sync dùng chung registry. Script sync chạy **mongoose thuần** (không boot Nest/Redis) với `MONGO_URI` đã qua `validateEnv`. `autoIndex: nodeEnv !== 'production'` trong `mongo.module.ts`.
- **B1.7**: không thêm EventEmitter; `AuditService.onAlert(listener)` + log `warn` có `alert:true`. `record()` await insert và **ném lỗi** nếu ghi thất bại (INV-25: thao tác nhạy cảm không được âm thầm mất audit). Listener lỗi không được làm hỏng `record()`.
- **B1.8**: dùng custom service (1 Lua `INCR`+`PEXPIRE` atomic qua `lua-loader` sẵn có) thay vì `@nestjs/throttler` — throttler không hỗ trợ tự nhiên nhiều chiều/1 request và thêm dependency. Đây là lệch nhẹ khỏi spec §6.3 (nêu tên thư viện), mục tiêu §6.3 vẫn đạt → chấp nhận, ghi vào summary.
- **B1.9**: trạng thái key (kid, status active/retired, retireAt) lưu cạnh file PEM trong `KEY_LOCAL_DIR` (dev-only). Private key KHÔNG vào Mongo (INV-19). `TokenVerifier` cố định `algorithms: ['RS256']` (chống alg-confusion).
- **B1.10**: `nodemailer` là dependency plan §1.5 đã liệt kê. Đặt `connectionTimeout/greetingTimeout/socketTimeout`.

## Điểm mạnh
- Nghiệm thu đo được cho cả 5 task (index thật, E11000, compile-fail + runtime strip, 429 khi đổi IP, verify trước/sau 2 kiểu rotation, email thật qua API Mailpit).
- Giả định ghi rõ, không mở rộng tính năng.

## Vấn đề (bắt buộc sửa nếu REJECT)
Không có.

## Đề xuất (không bắt buộc / rủi ro cần theo dõi)
- Rate-limit khi Redis down: client dùng chung `maxRetriesPerRequest: null` → lệnh có thể treo thay vì lỗi nhanh (cùng lớp bug `/ready` run 03). Không thuộc B1.8 nghiệm thu; thuộc fallback §6.2 ở B7.3 → **DEBT-005**.
- Trạng thái key đọc từ file mỗi instance → không đồng bộ đa instance; chấp nhận vì LocalKeyProvider chỉ dev; KeyProvider thật ở B7.3.
