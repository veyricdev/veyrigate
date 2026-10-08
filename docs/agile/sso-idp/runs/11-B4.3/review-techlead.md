# Tech Lead Review — 2026-10-08

## Kết luận: PASS

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không cần đổi kiến trúc. Modular monolith hiện tại phù hợp quy mô. Đề xuất vị trí cụ thể (tasks.md không nêu rõ, dev tự quyết theo điều kiện C1):

- Module/service mới `be/src/modules/oauth/code/authorization-code.service.ts` (+ `.spec.ts` unit, và `be/test/authorization-code.int-spec.ts` integration trên Redis thật — đúng pattern `sessions.int-spec.ts`/`authorize.int-spec.ts` đã có).
- Tái dùng `RedisService` + `loadLuaScripts` (B1.4) và `generateToken`/`sha256` (B1.5) — đúng pattern đã dùng ở `SessionService` và `AuthorizeRequestContextService`. Không viết lại CSPRNG/Lua loader riêng.
- Đăng ký `AuthorizationCodeService` vào `providers` của `OauthModule` (`oauth.module.ts`), export nếu B4.4 (run sau) cần inject — không tạo module con riêng rồi import chéo phức tạp, module `oauth` hiện tại đủ nhỏ để chứa chung authorize/consent/token/code.

## Điểm mạnh

- Phạm vi task cắt đúng lát: chỉ store + Lua primitive, không đụng `/authorize` (B4.2 chờ Q1) và không đụng `/token` (B4.4 chờ Q4) — khớp plan §B4, tránh làm việc tốn công rồi phải sửa lại khi Q1/Q4 chốt.
- Script Lua consume-with-binding bám đúng mẫu spec §9.5: chỉ `DEL` khi `clientId` + `redirectUri` khớp, sai → trả null không xoá — đúng INV-13 (chống premature consumption/DoS).
- Nhận định "DEBT-013 ngoài phạm vi, Lua 1 key nên Cluster-safe" đúng — khác `sessionRevokeAll`/`establish` (2 key khác slot, đã bị flag DEBT-013), ở đây toàn bộ thao tác gói trong 1 key nên không có rủi ro CROSSSLOT.
- Payload liệt kê đúng field spec §9.1 bước 3 / §10 (`clientId, redirectUri, codeChallenge, resource, scope, nonce, userId`), không bịa field ngoài spec; cho phép thêm `authTime` có điều kiện ("nếu có sẵn") hợp lý vì B4.4 cần `auth_time` cho access token resource admin (D3/plan B4.4) mà không bắt tạo cơ chế mới để lấy nó.
- Yêu cầu lưu theo hash của code (không phải plaintext key) nhất quán pattern đã có (`SessionService` dùng `sha256(id)` làm ref, `RefreshToken`/`PasswordResetToken` theo spec §9.5/§10 cũng tra cứu bằng hash).
- Có kế hoạch test thật trên Redis (không mock), đúng yêu cầu plan §12 "race condition dễ lọt nhất — bắt buộc test song song thật".

## Vấn đề (bắt buộc sửa nếu REJECT)

(không có — PASS)

## Điều kiện (C1..Cn) — dev phải tuân thủ khi triển khai

- **C1 — Khoá Redis theo hash, không theo plaintext `code`.** Key `authz_code:{sha256(code)}` (tái dùng `sha256` từ `crypto.util.ts`), không phải `authz_code:{code}`. `code` trả cho client là CSPRNG gốc; Lua script nhận `KEYS[1]` là key đã hash sẵn từ phía service (giống `authzCtxConsume` nhận `ctxKey(requestId)` đã build sẵn) — **không** hash trong Lua.
- **C2 — Lua script là command riêng**, không trùng tên với `authzCtxConsume`/`sessionRevokeAll` (ví dụ `consumeAuthCode`), đăng ký qua `loadLuaScripts(redis.client, [...])` trong constructor service mới, đúng pattern B1.4.
- **C3 — Giữ `numberOfKeys: 1`** (đúng DEBT-013 — Cluster-safe); `clientId`/`redirectUri` truyền qua `ARGV[1]`/`ARGV[2]` như mẫu spec §9.5; tuyệt đối không thêm KEYS thứ 2 (ví dụ index phụ) trong task này.
- **C4 — Set ban đầu dùng `SET key val PX 60000 NX`** (mẫu đã có ở `AuthorizeRequestContextService.create`), không dùng `SETEX` + check riêng, để tránh TOCTOU khi tạo (id trùng do CSPRNG — xác suất cực thấp nhưng giữ nhất quán pattern, throw khi `ok !== 'OK'`).
- **C5 — Test tối thiểu bắt buộc** (integration, Redis thật, `be/test/authorization-code.int-spec.ts`):
  - sai `clientId` hoặc sai `redirectUri` → trả null, key vẫn còn (`EXISTS` = 1) → consume đúng ngay sau đó vẫn thành công (chứng minh INV-13 đầy đủ, không chỉ test "sai thì null" đơn lẻ).
  - 2 consume đồng thời (`Promise.all`, cùng identity đúng) → đúng 1 trả data, 1 trả null.
  - TTL thật ở biên 60s qua clock injectable hoặc `pttl` thật trên Redis — không fake toàn bộ bằng mock timer vì Lua chạy trên Redis thật.
  - consume lần 2 (sau khi đã bị xoá bởi lần 1 hợp lệ) → trả null.
- **C6 — Không log giá trị `code` plaintext ở bất kỳ đâu** (create/consume/error path); nếu cần log debug chỉ log hash hoặc độ dài — đúng INV-20.
- **C7 — Không thêm field ngoài danh sách đã chốt** (`clientId, redirectUri, codeChallenge, resource, scope, nonce, userId` + `authTime` optional nếu lấy sẵn từ session, không đổi contract nơi khác). Field khác cần cho B4.4 → ghi `backlog.md`, không tự thêm ở B4.3.

## Đề xuất (không bắt buộc)

- Đặt tên type `AuthorizationCode`/`AuthorizationCodeData` nhất quán naming với `AuthorizeRequestContext`, JSDoc ghi rõ "B4.3, spec §9.5" + invariant liên quan, giống các service khác đã làm.
- Có thể truy cập Redis trực tiếp trong integration test để assert tồn tại/không tồn tại key (như `sessions.int-spec.ts` đang làm) — không cần thêm method debug riêng trong service.
