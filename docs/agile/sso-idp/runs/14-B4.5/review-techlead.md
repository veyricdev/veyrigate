# Tech Lead Review — 2026-10-10 (run 14 — B4.5 refresh grant + rotation + reuse + `/revoke`)

## Kết luận: PASS (có fold)

Phạm vi, ranh giới B4.4↔B4.5 và 5 task [BE] bám đúng spec §9.5/§10, INV-10/11/12. Khi đối chiếu code thật (`token.service.ts`, `token.controller.ts`, `token.errors.ts`, `refresh-token.schema.ts`, `client-authentication.service.ts`), tôi thấy một số chỗ **lệch code** và **thiếu abuse case**. Không chỗ nào làm hỏng kiến trúc, nên tôi **fold trực tiếp** vào `tasks.md` (đánh dấu *(tech-lead fold)*) như run 13, không trả về analyst.

## Quyết định: `/revoke` theo thiết bị → HOÃN (chốt, không cần người dùng)
- MVP: `/revoke` (RFC 7009) nhận refresh token → **revoke cả family**. Bỏ tham số tuỳ biến `revoke_scope`.
- Lý do: mỗi lần `authorization_code` tạo 1 family mới, nên 1 family ≈ 1 lần đăng nhập/1 client/1 thiết bị. Revoke family đã đáp ứng phần lớn nhu cầu. Revoke đúng 1 token là vô nghĩa khi có rotation. `deviceId` gửi qua kênh server-to-server do client tự khai, không tin được. "Đăng xuất thiết bị" là thao tác của user/admin (B4.7/B6.3), không phải của client.
- Ghi **DEBT-031** (cách làm: IdP tự sinh deviceId gắn session → code → RefreshToken).

## Kiến trúc đề xuất
Giữ modular monolith, không thêm module/service mới ngoài `RefreshTokenService` (hoặc method trong `TokenService`, dev chọn). Không dùng Lua/Redis và không dùng transaction Mongo. Một lệnh `findOneAndUpdate` là đủ cho atomic (spec §9.5). DEBT-025 không phát sinh.

## Điểm mạnh
- Rotation dùng `findOneAndUpdate` theo `tokenHash`, kèm `expiresAt` absolute (không sliding). Đúng Q6.
- Có tách nhánh "token rác" (không revoke) khỏi nhánh reuse. Có concurrent test, có chống enumeration (`invalid_grant` đồng nhất; `/revoke` luôn 200).
- Exposure budget và chống IDOR cross-client đã nêu sẵn.

## Vấn đề (đã fold vào tasks.md, dev bắt buộc làm)
- [x] **Phụ thuộc vòng** Task 1↔2 → thứ tự mới: **2 → 1 → 3 → 4 → 5**.
- [x] **`replacedBy` là `ObjectId`** trong schema, plan cũ ghi hash vào đó. Sửa: sinh trước `_id` cho hậu duệ.
- [x] **Confused-deputy / DoS chéo client**: nhánh reuse cũ revoke family dựa trên doc tìm được mà không kiểm `clientId`. Client B nộp token đã dùng của A sẽ làm A bị logout. Sửa: `rotate(value, client)` bind `clientId` trong filter atomic; khi phân loại sau `null`, khác client → không đổi state.
- [x] **Báo động reuse giả**: token đã `/revoke` (không có `replacedBy`) mà bị dùng lại thì không phải reuse. Chỉ coi là reuse khi `revokedAt` **và** `replacedBy` đều có. Token hết hạn → invalid, không revoke.
- [x] **INV-14 (spec dòng 565)**: refresh phải ngừng khi resource bị gỡ khỏi `client.allowedResources`. Thêm vào filter.
- [x] **Mã lỗi**: client thiếu grant → `unauthorized_client` (RFC 6749 §5.2, khớp B4.4), không dùng `unsupported_grant_type`. `invalid_scope` chưa có trong `TokenErrorCode` → thêm.
- [x] **Dispatch** trong `handle()`: hiện chặn `grant_type` trước client auth → phải refactor nhưng giữ hành vi B4.4.
- [x] **Kiểm scope trước khi rotate** (đọc trước, không ghi). Nếu sai scope mà làm tiêu mất refresh hợp lệ thì vi phạm cùng tinh thần INV-13.
- [x] **Claim token từ refresh**: không `nonce`, không `auth_time` (doc không lưu). Step-up B6.2 fail-closed. `signIdToken` cần nới chữ ký.
- [x] **Failure semantics** khi không có transaction: revoke cũ rồi insert/ký/audit lỗi → 500 → retry = reuse → login lại. Chấp nhận (strict), ghi vào test matrix + DEBT-032.
- [x] `/revoke`: dùng chung parse/auth với `/token` (không copy). Bỏ qua `token_type_hint`. JWT → no-op. Bind `clientId` ở cả 2 câu lệnh. Audit chỉ ghi khi `modifiedCount>0`. DB lỗi → 500 (ngoại lệ có chủ đích so với "luôn 200").
- [x] Audit metadata không ghi `tokenHash`.

## Đề xuất (không bắt buộc) → backlog
- DEBT-032: transaction/idempotent cho rotation (B7).
- DEBT-033: discovery `revocation_endpoint` + `grant_types_supported` có `refresh_token` (B4.6).
- DEBT-029 (đã có): rate-limit nên áp cả `/revoke`.

## Chuyển tiếp
PASS → **backend-dev** (5 task [BE], thứ tự 2→1→3→4→5).
