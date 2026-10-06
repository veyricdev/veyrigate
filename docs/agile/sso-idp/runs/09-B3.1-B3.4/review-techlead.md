# Tech Lead Review — 2026-10-06
## Kết luận: PASS (có điều kiện C1–C6 — backend-dev bắt buộc tuân, senior-reviewer kiểm)

Phạm vi đúng plan §B3 (B3.1–B3.4), spec §7/§9.3/§9.7. Phụ thuộc B2.1 đã xong (`Client`/`ClientCredential`/`Resource`
schema đã có sẵn trong `be/src/modules/clients`, `resources`, đăng ký trong `database/mongo/models.ts`) —
không có DEBT chặn trong phạm vi. Không cần quay lại analyst.

## Kiến trúc đề xuất
Giữ modular monolith hiện tại (NestJS + Mongoose + Redis). `ClientsModule`/`ResourcesModule` chỉ chứa
schema + service + validator thuần (không controller HTTP — CRUD admin là B6.3, không làm ở run này).
CORS (B3.4) nên đặt ở `main.ts` dạng hook `onRequest`/`preHandler` có điều kiện theo route, **không** dùng
plugin CORS toàn cục một allowlist tĩnh vì allowlist phải tra theo `client_id`/origin động từ DB.

## Điểm mạnh
- Schema `Client`/`ClientCredential`/`Resource` đã tồn tại đúng field trong spec §9.3/§10 (`allowedCorsOrigins`,
  `allowedResources`, `secretHash`+`version`), chỉ cần bổ sung `postLogoutRedirectUris[]` (D4) — khớp khả thi kỹ thuật.
- Có sẵn `TenantScopedRepository`, `crypto.util.ts` (`sha256`, `constantTimeEqual`, `hashPassword/verifyPassword`),
  `RateLimitGuard`, `AuditService` — tái dùng được, không cần viết lại.
- Task atomic, đúng thứ tự phụ thuộc (B3.1 → B3.2/B3.3/B3.4), chỉ [BE], đúng vì chưa có HTTP endpoint nào lộ ra FE.

## Điều kiện bắt buộc (dev tuân, senior/tester kiểm)
- [ ] **C1 — `redirect_uri`/`postLogoutRedirectUris` validator theo môi trường**: validator phải đọc
  `NODE_ENV` (hoặc cờ cấu hình riêng, không hard-code) để quyết định cho phép `http://localhost`; production
  **luôn** reject scheme khác `https`. Test: `NODE_ENV=production` + `http://localhost` → bị từ chối; cấm wildcard
  subdomain (`*.example.com`), cấm fragment, cấm thêm query khi so khớp (exact string match tuyệt đối, không chuẩn
  hoá slash cuối).
- [ ] **C2 — Grace period rotation secret chưa chốt (spec §17 còn mở)**: thêm biến env mới (ví dụ
  `CLIENT_SECRET_GRACE_TTL`, giây) theo đúng pattern đã dùng cho `SESSION_IDLE_TTL`/`SESSION_ABSOLUTE_TTL`
  (`validation.schema.ts`, `positiveInt`, có default tạm + validate dương); ghi rõ giá trị tạm chốt trong
  `log.md`/`summary.md` để câu hỏi mở trong spec §17 được theo dõi, không tự ý coi là đã chốt vĩnh viễn.
- [ ] **C3 — Mapping `resource` (URI) ↔ `allowedResources` (resourceId)**: spec §7 ghi `allowedResources[]` lưu
  `resourceId`, còn param `resource` ở `/authorize`/`/token` là absolute URI = `Resource.identifier`. Validator
  B3.2 phải: tra `Resource` theo `identifier` → lấy `resourceId` → kiểm `resourceId` đó có trong
  `Client.allowedResources[]` — **không** so sánh trực tiếp URI với mảng `allowedResources`. Test: resource URI hợp
  lệ nhưng `resourceId` không nằm trong `allowedResources` của client → reject.
- [ ] **C4 — Client auth (B3.3) không rò timing/tồn tại client**: khi `client_id` không tồn tại, vẫn phải chạy đủ
  một lượt verify giả (tương tự cách argon2 giả dùng cho enumeration ở run 06) trước khi trả `invalid_client`,
  tránh timing oracle lộ "client có tồn tại hay không". Khi có nhiều `ClientCredential` còn hiệu lực (overlap theo
  C2), thử khớp lần lượt theo version, không dừng sớm gây khác biệt thời gian rõ rệt giữa các nhánh.
- [ ] **C5 — CORS (B3.4) phải xác định đúng "client nào" cho từng endpoint, không dùng CORS global tĩnh**:
  - `/token`: client_id có trong body (`client_secret_post`/`none`) hoặc Basic auth — dùng để tra
    `allowedCorsOrigins` của đúng client đó cho response thật.
  - `/userinfo`: không có `client_id` ở query/body — phải lấy từ claim `client_id` trong access token **sau khi**
    verify Bearer; nghĩa là header CORS cho response thật phải được set **sau** bước xác thực token, không phải ở
    middleware global chạy trước handler.
  - `/jwks.json`, discovery: không có client context nào cả (public metadata, không kèm token/client_id) — ghi rõ
    trong code/comment rằng 2 endpoint này dùng **hợp của mọi `allowedCorsOrigins` đã đăng ký** làm allowlist (giống
    bước preflight), không thể áp "đúng client" theo nghĩa đen như D8 vì không có client để xác định.
  - Preflight (`OPTIONS`) luôn không có client context → cho phép nếu origin ∈ hợp mọi `allowedCorsOrigins`.
  - Set `Vary: Origin`; **không** kết hợp `Access-Control-Allow-Credentials: true` với origin reflect tràn lan nếu
    endpoint không cần cookie (các endpoint này dùng Bearer, không dùng cookie session — nên để `credentials: false`).
  - Cần thêm dependency CORS (ví dụ `@fastify/cors`) hoặc hook thủ công — plan/tasks chưa liệt kê, bổ sung vào
    `be/package.json`.
- [ ] **C6 — `ClientCredential.secretHash`**: dùng lại `hashPassword`/`verifyPassword` (Argon2id, `crypto.util.ts`)
  cho nhất quán, không tự implement thuật toán mới; vì so sánh qua `argon2Verify` (không phải so chuỗi trực tiếp),
  tiêu chí "so sánh constant-time" ở tasks.md coi như thoả mãn qua hash verify — ghi rõ trong code/test để senior
  không hiểu nhầm là thiếu `constantTimeEqual`.

## Đề xuất (không bắt buộc)
- Rate limit cho sai client_secret liên tiếp ở `/token` (chống brute-force confidential client) — thuộc B4.4, ghi
  chú lại khi làm B4.4, không cần xử lý ở run này.
- Argon2id cho client secret có chi phí CPU cao hơn so sánh HMAC/SHA-256+pepper khi QPS `/token` lớn (refresh xoay
  vòng) — MVP chấp nhận được, cân nhắc đổi nếu có số liệu benchmark thật sau này.
- Xem xét đặt tên hàm `hashPassword`/`verifyPassword` chung hơn (ví dụ `hashSecret`) nếu dùng cho cả client secret,
  tránh gây hiểu nhầm là chỉ dành cho password user — không bắt buộc đổi ở run này.
