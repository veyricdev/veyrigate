# Tech Lead Review — 2026-10-23
## Kết luận: PASS (có fold)

Đối chiếu code `c8216f3`. Ràng buộc chi tiết nằm ở `tasks.md` mục "Fold tech-lead (2026-10-23)" và được ưu tiên hơn text gốc.

## Kiến trúc đề xuất (nếu cần điều chỉnh)
- Giữ monolith BE + BFF fe-admin. Không thêm endpoint BE; Task 0 chỉ bổ sung schema response OpenAPI cho `GET /admin/keys` và `POST /admin/keys/rotate`.
- FE: server fn riêng `features/admin-api/signing-keys.ts`, schema strip ở server. Xác nhận 2 bước làm bằng prop `confirmText?` của `ConfirmAction`, không tạo dialog mới.
- Sửa nhỏ bắt buộc: `server/auth/instance.ts` thêm `cooldownDuration: 0` cho JWKS remote của fe-admin. Nếu không sửa, ID token có `kid` mới đến trong 30s sau lần tải JWKS sẽ bị từ chối, dẫn tới callback hỏng hoặc refresh huỷ phiên.

## Điểm mạnh
- BE đã hoàn chỉnh. Có mutex rotate (DEBT-145) và audit success/failure. View là allowlist, không lộ key material. Step-up 5 phút, chỉ super_admin.
- Khuôn FE A6.1–A6.4 dùng lại được: `call` tự refresh khi 401 rồi gửi lại an toàn, mutation lỗi không chắc thì gắn `uncertain`, cùng với `ConfirmAction`, `useActionNotice` và `useInvalidateOn`.
- E2E chạy tuần tự (`workers: 1`) và dùng thư mục key riêng `e2e/.keys`.

## Vấn đề (bắt buộc sửa — đã fold, không cần quay lại analyst)
- [x] Task 2 ghi trạng thái "active/next/retired…", nhưng thực tế chỉ có `active` | `retiring` (F2).
- [x] Snapshot OpenAPI thiếu response schema của keys ⇒ Task 0 [BE] (F0).
- [x] Cảnh báo khẩn cấp trong Task 3 có câu "mọi token đang lưu hành bị vô hiệu/đăng xuất…", không đúng sự thật. Emergency KHÔNG thu hồi phiên IdP hay refresh token. Đã thay bằng đúng 5 hậu quả có trong code (Q-49.1).
- [x] JWKS cooldown của fe-admin làm E2E flaky và có thể đăng xuất admin ngay sau khi xoay khẩn cấp (F2, kiểm chứng bằng mutation ở F4).
- [x] `E2E_REUSE=1` có thể xoay key của BE dev (`be/keys`) ⇒ skip (F4).
- [x] Tên file `keys.ts` đã dùng cho query key factory ⇒ đặt `signing-keys.ts`.

## Trả lời
- **Q-49.1**: dùng chung một endpoint, chọn chế độ bằng body `mode`.
  - Thường: key cũ còn verify được trong `ACCESS_TOKEN_TTL`.
  - Khẩn cấp: gỡ mọi key cũ (cả active lẫn retiring). AT và ID token cũ bị IdP từ chối ngay. RP còn cache JWKS có thể vẫn chấp nhận token cũ. Phiên IdP và refresh token KHÔNG bị thu hồi. `id_token_hint` cũ mất redirect sau logout. Không rollback được.
- **Q-49.2**: thao tác không idempotent.
  - Xoay thường hai lần thì vô hại: key cũ không bị đẩy ra sớm, chỉ có thêm một key retiring.
  - Xoay khẩn cấp hai lần thì token cấp giữa hai lần bị vô hiệu, lấy lại được bằng refresh.
  - FE không gửi lại. Khi kết quả uncertain, FE so `kid` active trước và sau.
- **Q-49.3**: xoay thường không ảnh hưởng BE verifier hay fe-sso-test. Rủi ro thật nằm ở cooldown JWKS của fe-admin (đã sửa bằng F2). Không chạy xoay khẩn cấp trong E2E. Skip khi `E2E_REUSE=1`.

## Đề xuất (không bắt buộc)
- DEBT-349: fe-admin cache JWKS (`cacheMaxAge` 10 phút), nên sau khi xoay khẩn cấp vẫn tin key đã gỡ thêm tối đa 10 phút. Rủi ro thấp vì ID token chỉ đến qua back-channel.
- DEBT-350: audit `SIGNING_KEY_ROTATED` chỉ gắn tenant của super_admin thực hiện, nên admin tenant khác không thấy sự kiện xoay key toàn nền tảng.
